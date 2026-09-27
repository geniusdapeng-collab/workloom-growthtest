/**
 * media/register-local.ts —— 本地文件入库共享助手（T-2026-0926-0007）
 *
 * 定妆照/封面/底板/上传件/重剪成片共用：流式 sha256 → 拷入媒体仓 → asset-cms.register。
 * 纪律：
 *  - 一切入库走 `register()`（sha256 幂等 + 版本链 + D16 同事务事件），本助手是唯一
 *    「本地文件 → 媒资库」入口，禁止第二条入库路径（规格书 §1.2-3）；
 *  - 大文件不整读进内存：sha256 与拷贝都用流（规格书原稿用 readFileSync，300MB 上限下会翻倍占内存，
 *    实现期改为流式）；
 *  - 0039 新列（title/tags/prompt/pipeline_kind/duration/宽高/缩略图）由 `applyMediaColumns` 补写：
 *    `register()` 属基座包（改动要走 L2→L1→L0 提案），本模块走"基座不动、产品层扩展"的最小侵入路径；
 *    补写与 register 不同事务，故失败重试一次再报错，并留下可巡检特征（title 空而 meta.title 在场）。
 */
import { createHash, randomUUID } from "node:crypto";
import { constants, createReadStream, existsSync, lstatSync, mkdirSync, realpathSync, statSync } from "node:fs";
import { copyFile, rename, rm } from "node:fs/promises";
import { dirname, extname, join } from "node:path";
import { pipeline } from "node:stream/promises";
import type pg from "pg";
import { register, type AssetKind, type LicenseRisk } from "@workloom/base/asset-cms";
import { newId } from "@workloom/shared";
import { mediaRoot } from "../gen/ingest.js";
import type { AppPool, Scope } from "../gen/db.js";
import { extractThumbnail, probeMedia } from "./ffmpeg.js";
import { applyMediaColumns, type MediaColumnPatch } from "./columns.js";
import { safeDeliveryPath } from "../delivery-trust.js";
import { safeSegment } from "./paths.js";

export { applyMediaColumns };
export type { MediaColumnPatch };

export interface RegisterLocalAssetInput extends MediaColumnPatch {
  /** 源文件绝对路径（定妆照/封面/上传暂存件/重剪产物） */
  absPath: string;
  /** Expected identity from a verified producer receipt; compared before and after copying. */
  expectedSha256?: string;
  expectedRealPath?: string;
  kind: AssetKind;
  projectId?: string | null;
  provenance?: Record<string, unknown>;
  meta?: Record<string, unknown>;
  by: string;
  /** 授权风险：上传件缺省 unknown（用户来源不可判），生产件缺省 none */
  licenseRisk?: LicenseRisk;
  /** 抽首帧缩略图（视频类缺省 true；失败只记日志不阻断） */
  thumbnail?: boolean;
  /** 探测时长/宽高（视频/音频类缺省 true；ffprobe 不可用则留空，不编数字） */
  probe?: boolean;
  status?: string;
}

export interface RegisterLocalAssetResult {
  assetId: string;
  relPath: string;
  sha256: string;
  bytes: number;
  deduped: boolean;
  thumbPath: string | null;
}

/** 媒体仓子目录（按素材大类归档；上传件统一进 upload/，与生成件分仓） */
const SUBDIR: Record<string, string> = {
  portrait: "image", cover: "image", shot_plate: "image",
  product_image: "image", reference_image: "image",
  /** 用户上传件统一进 upload/（与生成件分仓，便于配额与合规巡检单列） */
  upload_audio: "upload", upload_image: "upload", upload_video: "upload",
  final_cut: "video", clip: "video",
};

const VIDEO_KINDS = new Set<AssetKind>(["clip", "final_cut", "shot_plate", "upload_video"]);
const IMAGE_KINDS = new Set<AssetKind>(["portrait", "cover", "product_image", "reference_image", "upload_image"]);
const AUDIO_KINDS = new Set<AssetKind>(["upload_audio"]);

/** 无扩展名时的兜底扩展（决定 /media/* 的 content-type，不能一律 .bin） */
function fallbackExt(kind: AssetKind): string {
  if (IMAGE_KINDS.has(kind)) return ".png";
  if (AUDIO_KINDS.has(kind)) return ".mp3";
  return ".mp4";
}

/** 流式 sha256（大文件不整读进内存） */
export async function sha256File(absPath: string): Promise<string> {
  const hash = createHash("sha256");
  await pipeline(createReadStream(absPath), hash);
  return hash.digest("hex");
}

export function mediaSubdirOf(kind: AssetKind): string {
  return SUBDIR[kind] ?? "video";
}

/** 媒体仓相对路径口径：<大类>/<workspaceId>/<sha256><ext>（签名校验按第二段取 workspaceId） */
export function mediaRelPathFor(kind: AssetKind, workspaceId: string, sha256: string, sourcePath: string): string {
  safeSegment(workspaceId, "workspaceId");
  const ext = extname(sourcePath).toLowerCase() || fallbackExt(kind);
  return join(mediaSubdirOf(kind), workspaceId, `${sha256}${ext}`).split("\\").join("/");
}

export async function registerLocalAsset(
  app: AppPool,
  gateway: pg.Pool,
  scope: Scope,
  input: RegisterLocalAssetInput,
): Promise<RegisterLocalAssetResult> {
  if (!existsSync(input.absPath)) throw new Error(`入库源文件不存在：${input.absPath}`);
  const before = statSync(input.absPath);
  if (!before.isFile() || before.size <= 0) throw new Error("入库源文件必须为非空文件");
  const assertSourceIdentity = () => {
    if (input.expectedRealPath && (lstatSync(input.absPath).isSymbolicLink() || realpathSync(input.absPath) !== input.expectedRealPath)) {
      throw new Error("入库源文件 realpath 与封签不一致");
    }
    const after = statSync(input.absPath);
    if (after.dev !== before.dev || after.ino !== before.ino || after.size !== before.size
      || after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs) throw new Error("入库源文件在拷贝期间变化");
  };
  assertSourceIdentity();
  const bytes = before.size;
  const sha256 = await sha256File(input.absPath);
  if (input.expectedSha256 !== undefined && (!/^[a-f0-9]{64}$/.test(input.expectedSha256) || sha256 !== input.expectedSha256)) {
    throw new Error("入库源文件指纹与封签不一致");
  }
  assertSourceIdentity();
  const relPath = mediaRelPathFor(input.kind, scope.workspaceId, sha256, input.absPath);
  const root = mediaRoot();
  mkdirSync(root, { recursive: true });
  const absTarget = safeDeliveryPath(root, relPath, true);
  mkdirSync(dirname(absTarget), { recursive: true });
  // Existing content-addressed files are verified by bytes, never by size alone.
  const alreadyValid = existsSync(absTarget) && statSync(absTarget).isFile()
    && statSync(absTarget).size === bytes && await sha256File(absTarget) === sha256;
  if (!alreadyValid) {
    const temp = `${absTarget}.copy-${randomUUID()}`;
    try {
      await copyFile(input.absPath, temp, constants.COPYFILE_EXCL);
      if (statSync(temp).size !== bytes || await sha256File(temp) !== sha256) throw new Error("媒体拷贝后指纹不一致，拒绝登记");
      assertSourceIdentity();
      safeDeliveryPath(root, relPath, true);
      await rename(temp, absTarget);
    } finally {
      await rm(temp, { force: true });
    }
  }
  assertSourceIdentity();
  safeDeliveryPath(root, relPath);
  if (await sha256File(absTarget) !== sha256) throw new Error("媒体仓文件指纹不一致，拒绝登记");
  return registerStoredMedia(app, gateway, scope, {
    ...input,
    relPath,
    sha256,
    bytes,
    absPath: absTarget,
  });
}

export interface RegisterStoredMediaInput extends MediaColumnPatch {
  /** Present for a receipt-bound local copy. */
  expectedSha256?: string;
  /** 已在媒体仓内的相对路径（上传路由落盘后 / 本地拷贝完成后） */
  relPath: string;
  sha256: string;
  bytes?: number;
  /** 媒体仓内的绝对路径（抽帧/探测用；缺省由 relPath 推导） */
  absPath?: string;
  kind: AssetKind;
  projectId?: string | null;
  provenance?: Record<string, unknown>;
  meta?: Record<string, unknown>;
  by: string;
  licenseRisk?: LicenseRisk;
  thumbnail?: boolean;
  probe?: boolean;
  status?: string;
}

/**
 * 登记「已在媒体仓内」的文件（上传件/重剪产物）：不重复拷贝，只做 register + 列补写。
 * 上传件走这条路径（`upload.ts` 落盘后调用），保证与生成件共用同一入库口径。
 */
export async function registerStoredMedia(
  app: AppPool,
  gateway: pg.Pool,
  scope: Scope,
  input: RegisterStoredMediaInput,
): Promise<RegisterLocalAssetResult> {
  const absPath = input.absPath ?? join(mediaRoot(), input.relPath);
  const isVideo = VIDEO_KINDS.has(input.kind);
  const isAudio = AUDIO_KINDS.has(input.kind);
  const isImage = IMAGE_KINDS.has(input.kind);
  const wantProbe = input.probe ?? (isVideo || isAudio);
  const wantThumb = input.thumbnail ?? isVideo;

  const probed = wantProbe && existsSync(absPath)
    ? await probeMedia(absPath)
    : { durationSeconds: null, width: null, height: null };
  let thumbPath: string | null = input.thumbPath ?? null;
  if (wantThumb && !thumbPath && existsSync(absPath)) {
    const thumbRel = join(mediaSubdirOf(input.kind), scope.workspaceId, "thumbs", `${input.sha256}.jpg`).split("\\").join("/");
    const thumb = await extractThumbnail(absPath, join(mediaRoot(), thumbRel));
    thumbPath = thumb.ok ? thumbRel : null;
    if (!thumb.ok) console.warn(`[media] 抽帧失败（缩略图留空，不影响入库）：${thumb.error}`);
  }

  const durationSeconds = input.durationSeconds ?? probed.durationSeconds;
  const width = input.width ?? probed.width;
  const height = input.height ?? probed.height;
  const sourceType = input.sourceType ?? (input.kind.startsWith("upload_") ? "uploaded" : "generated");

  const r = await register(app, gateway, scope, {
    id: newId("VA"),
    projectId: input.projectId ?? undefined,
    kind: input.kind,
    sourceUrl: `local://${input.relPath}`,
    provenance: {
      source: sourceType,
      localPath: input.relPath,
      ingestedAt: new Date().toISOString(),
      ...(input.provenance ?? {}),
    },
    licenseRisk: input.licenseRisk ?? (sourceType === "uploaded" ? "unknown" : "none"),
    sha256: input.sha256,
    meta: {
      localPath: input.relPath,
      bytes: input.bytes ?? null,
      title: input.title ?? null,
      tags: input.tags ?? [],
      prompt: input.prompt ?? null,
      pipelineKind: input.pipelineKind ?? null,
      durationSeconds,
      width,
      height,
      thumbPath,
      ...(input.meta ?? {}),
    },
    status: input.status ?? "registered",
    by: input.by,
  });

  if (r.deduped && input.expectedSha256 !== undefined
    && (r.asset.project_id !== (input.projectId ?? null) || r.asset.source_type !== "generated")) {
    throw new Error("同内容媒资已属于其他项目或来源，不允许通过交付补录改写归属");
  }

  await applyMediaColumns(app, scope, r.asset.id, {
    title: input.title ?? undefined,
    tags: input.tags,
    prompt: input.prompt ?? undefined,
    pipelineKind: input.pipelineKind ?? undefined,
    durationSeconds,
    width,
    height,
    thumbPath,
    sourceType,
    aspectRatio: input.aspectRatio ?? undefined,
  }, { fillOnlyEmpty: r.deduped });

  return {
    assetId: r.asset.id,
    relPath: input.relPath,
    sha256: input.sha256,
    bytes: input.bytes ?? 0,
    deduped: r.deduped,
    thumbPath,
  };
}
