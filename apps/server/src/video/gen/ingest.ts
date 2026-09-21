/**
 * video/gen/ingest.ts —— 成片入库（T-2026-0921-0002）
 *
 * 为什么必须做：供应商产物只保证保留 7 天（Higgsfield 官方口径），只存 URL = 资产会丢。
 * 流程：下载 → sha256 → 落自有媒体库（WORKLOOM_MEDIA_DIR，默认 <repo>/var/media）→
 *      asset-cms.register(kind=final_cut)（sha256 幂等去重）→ 返回 assetId 用于 render_jobs 回链。
 * 播放：签名 URL（HMAC + 过期时间），`/media/*` 路由校验后才吐文件——不做无鉴权裸目录。
 */
import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, normalize, resolve, sep } from "node:path";
import type { getAppPool, getGatewayPool } from "@workloom/db";
import { register } from "@workloom/base/asset-cms";
import type { Scope } from "./db.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, "../../../../..");

export function mediaRoot(env: NodeJS.ProcessEnv = process.env): string {
  return env.WORKLOOM_MEDIA_DIR?.trim() || join(REPO_ROOT, "var/media");
}

export interface DownloadedMedia {
  relPath: string;
  absPath: string;
  sha256: string;
  bytes: number;
  contentType: string | null;
}

const DEFAULT_MAX_BYTES = 300 * 1024 * 1024; // 300MB：短视频上限；超限拒收，避免磁盘被写爆

/** 下载供应商产物到媒体库（流式落盘 + 边写边算 sha256；超限中止并删除半成品） */
export async function downloadToMediaStore(
  uri: string,
  opts: { workspaceId: string; maxBytes?: number; fetchImpl?: typeof fetch } = { workspaceId: "unknown" },
): Promise<DownloadedMedia> {
  if (!/^https?:\/\//i.test(uri)) throw new Error(`只支持 http(s) 产物地址：${uri.slice(0, 80)}`);
  const fetchImpl = opts.fetchImpl ?? fetch;
  const maxBytes = opts.maxBytes ?? DEFAULT_MAX_BYTES;
  const res = await fetchImpl(uri);
  if (!res.ok) throw new Error(`成片下载失败：HTTP ${res.status}`);
  const contentType = res.headers.get("content-type");
  const ext = contentType?.includes("webm") ? "webm" : contentType?.includes("png") ? "png"
    : contentType?.includes("jpeg") || contentType?.includes("jpg") ? "jpg" : "mp4";
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.byteLength > maxBytes) throw new Error(`成片超过大小上限（${buf.byteLength} > ${maxBytes} 字节），已拒收`);
  const sha256 = createHash("sha256").update(buf).digest("hex");
  const relPath = join("video", opts.workspaceId, `${sha256}.${ext}`);
  const absPath = join(mediaRoot(), relPath);
  mkdirSync(dirname(absPath), { recursive: true });
  writeFileSync(absPath, buf);
  return { relPath: relPath.split(sep).join("/"), absPath, sha256, bytes: buf.byteLength, contentType };
}

/* ================= 成片注册（asset-cms） ================= */

export interface RegisterFinalCutInput {
  assetId: string;
  projectId?: string | null;
  sha256: string;
  /** 供应商原始 URL（保留为归因与回查线索；本地副本为准） */
  sourceUrl: string;
  localRelPath: string;
  provider: string;
  providerModel: string;
  jobId: string;
  scriptId: string;
  seconds?: number | null;
  by: string;
}

export async function registerFinalCut(
  app: ReturnType<typeof getAppPool>,
  gateway: ReturnType<typeof getGatewayPool>,
  scope: Scope,
  input: RegisterFinalCutInput,
): Promise<{ assetId: string; deduped: boolean }> {
  const r = await register(app, gateway, scope, {
    id: input.assetId,
    projectId: input.projectId ?? undefined,
    kind: "final_cut",
    sourceUrl: input.sourceUrl,
    provenance: {
      source: "generated",
      provider: input.provider,
      providerModel: input.providerModel,
      jobId: input.jobId,
      scriptId: input.scriptId,
      localPath: input.localRelPath,
      ingestedAt: new Date().toISOString(),
    },
    licenseRisk: "none",
    sha256: input.sha256,
    meta: { durationSeconds: input.seconds ?? null, localPath: input.localRelPath, jobId: input.jobId },
    status: "draft",
    by: input.by,
  });
  return { assetId: r.asset.id, deduped: r.deduped };
}

/* ================= 签名媒体 URL（HMAC + 过期；播放/下载均走校验） ================= */

function secret(): string {
  const s = process.env.MEDIA_SIGNING_SECRET?.trim() || process.env.JWT_SECRET?.trim();
  if (!s) throw new Error("缺少 MEDIA_SIGNING_SECRET / JWT_SECRET：拒绝签发无签名媒体 URL（fail-closed）");
  return s;
}

export function signMediaPath(relPath: string, ttlSec = 3600, now = Date.now()): string {
  const exp = Math.floor(now / 1000) + Math.max(30, Math.floor(ttlSec));
  const sig = createHmac("sha256", secret()).update(`${relPath}|${exp}`).digest("base64url");
  return `${exp}.${sig}`;
}

export function verifyMediaToken(relPath: string, token: string, now = Date.now()): { ok: boolean; reason?: string } {
  const m = /^(\d+)\.([A-Za-z0-9_-]+)$/.exec(token ?? "");
  if (!m) return { ok: false, reason: "token 格式非法" };
  const exp = Number(m[1]);
  if (!Number.isFinite(exp) || exp * 1000 < now) return { ok: false, reason: "token 已过期" };
  const expect = createHmac("sha256", secret()).update(`${relPath}|${exp}`).digest("base64url");
  const a = Buffer.from(expect);
  const b = Buffer.from(m[2]!);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return { ok: false, reason: "token 签名不匹配" };
  return { ok: true };
}

/** 解析并防目录穿越：只允许媒体根内的相对路径 */
export function resolveMediaPath(relPath: string): string {
  const root = resolve(mediaRoot());
  const abs = resolve(root, normalize(relPath).replace(/^([/\\])+/, ""));
  if (!abs.startsWith(root + sep)) throw new Error(`媒体路径越界：${relPath}`);
  return abs;
}

export function mediaUrl(relPath: string, ttlSec = 3600): string {
  const token = signMediaPath(relPath, ttlSec);
  return `/media/${relPath.split("/").map(encodeURIComponent).join("/")}?token=${token}`;
}
