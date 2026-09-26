/**
 * media/upload.ts —— 用户上传（凭证 → 流式落盘 → 登记）与配额闸（T-2026-0926-0007）
 *
 * 三步制（规格书 §3.5）：
 *   ① `uploadTicket`（tRPC，写权限）→ 配额闸 + 10 分钟 HMAC 凭证；
 *   ② `POST /media/upload?token=…`（Hono 原生流式，见 apps/server/src/index.ts）→ 边写边算 sha256；
 *   ③ `registerUpload`（tRPC，写权限）→ 复核 relPath 属于本 workspace + 实算 sha256 一致 → register()。
 *
 * 实现期修复（评审 R3）：规格书的凭证载荷只有 `exp.nonce.hmac`，但上传路由要用
 * `verdict.filename` 推扩展名 —— 令牌里根本没有 filename，原样落地即坏。本实现把
 * `workspaceId|nonce|exp|filename|maxBytes` 全部纳入签名载荷，校验侧不再依赖任何未签字段。
 *
 * 配额口径（D7）：`WORKLOOM_MEDIA_QUOTA_GB`（缺省 20GB）只挡**上传**；
 * 生产素材（已付费产物）不受此闸限制，避免把自动入库误伤成"付费内容写不进去"。
 */
import { createHmac, timingSafeEqual } from "node:crypto";
import { existsSync, statSync } from "node:fs";
import { extname, join } from "node:path";
import { TRPCError } from "@trpc/server";
import { newId } from "@workloom/shared";
import { mediaRoot, mediaSigningSecret } from "../gen/ingest.js";
import type { AppPool, Scope } from "../gen/db.js";
import { mediaUsageBytes } from "./library.js";
import { registerStoredMedia, sha256File, type RegisterLocalAssetResult } from "./register-local.js";
import type pg from "pg";

export const UPLOAD_TICKET_TTL_SEC = 600;

export function uploadMaxBytes(env: NodeJS.ProcessEnv = process.env): number {
  const mb = Number(env.MEDIA_UPLOAD_MAX_MB ?? 300);
  return (Number.isFinite(mb) && mb > 0 ? mb : 300) * 1024 * 1024;
}

export function mediaQuotaBytes(env: NodeJS.ProcessEnv = process.env): number {
  const gb = Number(env.WORKLOOM_MEDIA_QUOTA_GB ?? 20);
  return (Number.isFinite(gb) && gb > 0 ? gb : 20) * 1024 ** 3;
}

/** 扩展名白名单化（只取 `[a-z0-9]{1,8}`，防路径注入与奇怪后缀） */
export function safeExtOf(filename: string): string {
  const ext = extname(filename || "").toLowerCase().replace(/[^a-z0-9.]/g, "");
  return /^\.[a-z0-9]{1,8}$/.test(ext) ? ext : "";
}

interface TicketPayload {
  workspaceId: string;
  nonce: string;
  exp: number;
  filename: string;
  maxBytes: number;
}

function ticketSignature(input: TicketPayload): string {
  const body = `${input.workspaceId}|${input.nonce}|${input.exp}|${input.filename}|${input.maxBytes}`;
  return createHmac("sha256", mediaSigningSecret()).update(body).digest("base64url");
}

/**
 * 签上传凭证。令牌形如 `<exp>.<base64url(payload)>.<hmac>`，
 * payload = {workspaceId, nonce, exp, filename, maxBytes} —— 全部字段都在签名覆盖内。
 *
 * 为什么不照抄规格书的 `exp.nonce.hmac`：那样 filename/maxBytes 不在令牌里，
 * 上传路由拿不到扩展名与上限（评审 R3）。把载荷整体编码进令牌，校验侧就不再依赖任何未签字段。
 */
export function signUploadTicket(
  input: { workspaceId: string; filename: string; maxBytes: number },
  opts: { ttlSec?: number; now?: number } = {},
): { token: string; expiresAt: string; nonce: string } {
  const exp = Math.floor((opts.now ?? Date.now()) / 1000) + Math.max(60, opts.ttlSec ?? UPLOAD_TICKET_TTL_SEC);
  const nonce = newId("UP");
  const payload: TicketPayload = { workspaceId: input.workspaceId, nonce, exp, filename: input.filename, maxBytes: input.maxBytes };
  const encoded = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
  return {
    token: `${exp}.${encoded}.${ticketSignature(payload)}`,
    expiresAt: new Date(exp * 1000).toISOString(),
    nonce,
  };
}

/**
 * 校验上传凭证：解码载荷 → 校验 exp → 逐字节比对 HMAC。
 * 返回的 filename / workspaceId / maxBytes 全部来自**已验签**载荷。
 */
export function verifyUploadTicket(
  token: string,
  opts: { now?: number } = {},
): { ok: true; workspaceId: string; nonce: string; filename: string; maxBytes: number; exp: number }
  | { ok: false; reason: string } {
  const m = /^(\d+)\.([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]+)$/.exec(token ?? "");
  if (!m) return { ok: false, reason: "UPLOAD_TICKET_MALFORMED" };
  const exp = Number(m[1]);
  if (!Number.isFinite(exp) || exp * 1000 < (opts.now ?? Date.now())) {
    return { ok: false, reason: "UPLOAD_TICKET_EXPIRED" };
  }
  let payload: TicketPayload;
  try {
    payload = JSON.parse(Buffer.from(m[2]!, "base64url").toString("utf8")) as TicketPayload;
  } catch {
    return { ok: false, reason: "UPLOAD_TICKET_MALFORMED" };
  }
  if (payload.exp !== exp || !payload.workspaceId || !payload.nonce || !payload.filename) {
    return { ok: false, reason: "UPLOAD_TICKET_MALFORMED" };
  }
  const expect = Buffer.from(ticketSignature(payload));
  const actual = Buffer.from(m[3]!);
  if (expect.length !== actual.length || !timingSafeEqual(expect, actual)) {
    return { ok: false, reason: "UPLOAD_TICKET_BAD_SIGNATURE" };
  }
  return {
    ok: true,
    workspaceId: payload.workspaceId,
    nonce: payload.nonce,
    filename: payload.filename,
    maxBytes: payload.maxBytes,
    exp: payload.exp,
  };
}

/** 上传件在媒体仓的相对路径（`upload/<ws>/<sha256><ext>`） */
export function uploadRelPath(workspaceId: string, sha256: string, filename: string): string {
  return join("upload", workspaceId, `${sha256}${safeExtOf(filename)}`).split("\\").join("/");
}

export interface UploadQuotaVerdict {
  ok: boolean;
  usedBytes: number;
  quotaBytes: number;
  reason?: string;
}

export async function checkUploadQuota(
  app: AppPool,
  scope: Scope,
  incomingBytes: number,
  env: NodeJS.ProcessEnv = process.env,
): Promise<UploadQuotaVerdict> {
  const usedBytes = await mediaUsageBytes(app, scope);
  const quotaBytes = mediaQuotaBytes(env);
  if (usedBytes + incomingBytes > quotaBytes) {
    return {
      ok: false,
      usedBytes,
      quotaBytes,
      reason: `媒资配额不足（已用 ${(usedBytes / 1024 ** 3).toFixed(1)}GB / 上限 ${(quotaBytes / 1024 ** 3).toFixed(0)}GB；本次上传 ${(incomingBytes / 1024 ** 2).toFixed(1)}MB）`,
    };
  }
  return { ok: true, usedBytes, quotaBytes };
}

export interface RegisterUploadInput {
  sha256: string;
  relPath: string;
  kind: "upload_video" | "upload_image" | "upload_audio" | "reference_image" | "product_image";
  title?: string | null;
  tags?: string[];
  productName?: string | null;
}

/**
 * 登记上传件：复核「路径属于本 workspace」+「实算 sha256 与声明一致」后才入媒资库。
 * 两道复核缺一不可：路径复核防跨租户写入，sha256 复核防"声明一套、落盘另一套"。
 */
export async function registerUploadedAsset(
  app: AppPool,
  gateway: pg.Pool,
  scope: Scope,
  input: RegisterUploadInput,
  by: string,
): Promise<RegisterLocalAssetResult & { workspaceId: string }> {
  const prefix = `upload/${scope.workspaceId}/`;
  if (!input.relPath.startsWith(prefix)) {
    throw new TRPCError({ code: "FORBIDDEN", message: "上传路径不属于当前工作区（拒绝登记）" });
  }
  const abs = join(mediaRoot(), input.relPath);
  if (!existsSync(abs)) {
    throw new TRPCError({ code: "NOT_FOUND", message: `上传文件不在媒体仓：${input.relPath}（先完成 POST /media/upload）` });
  }
  const actual = await sha256File(abs);
  if (actual !== input.sha256) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: `文件指纹不一致（声明 ${input.sha256.slice(0, 12)}… / 实算 ${actual.slice(0, 12)}…），拒绝登记`,
    });
  }
  const result = await registerStoredMedia(app, gateway, scope, {
    relPath: input.relPath,
    absPath: abs,
    sha256: actual,
    bytes: statSync(abs).size,
    kind: input.kind,
    title: input.title ?? null,
    tags: input.tags ?? [],
    sourceType: "uploaded",
    licenseRisk: "unknown",
    provenance: {
      source: "upload",
      uploadedBy: by,
      ...(input.productName ? { productName: input.productName } : {}),
    },
    by,
  });
  return { ...result, workspaceId: scope.workspaceId };
}
