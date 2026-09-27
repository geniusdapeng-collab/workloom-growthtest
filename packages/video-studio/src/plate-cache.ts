/**
 * plate-cache.ts —— 关键帧缓存失效判据（T-2026-0926-0007 真机缺陷修复）
 *
 * 真机现象（VID-GR01，2026-09-26）：
 *   出镜服装从西装改回角色档案 w1（月白旗袍）后重跑关键帧，四镜被监制打回，
 *   但重跑时产物文件仍在盘上（>50KB）→ 命中"缓存复用"分支 → **直接记 ok 且不再送审**，
 *   旧图被当成合格产物洗白。同类缺陷此前已在 `shot` 阶段修过（"复用也要复检"），
 *   关键帧阶段漏了。
 *
 * 判据（全部满足才算缓存有效）：
 *   1. 文件在盘且不小于阈值；
 *   2. 出图指纹元文件在场，且 `promptSha256` 与当前提示词一致（卡片改过 → 必须重出）；
 *   3. 锚点模式一致（`none` / `real` 产物不可混用，真人锚点产物不能进 Seedance）；
 *   4. 本镜最近一次 keyframe 裁决为放行（被驳回过的图不得被复用洗白）。
 *
 * 任一不满足 → 判缓存失效，调用方必须重新出图并重新过监制。
 */

import { createHash } from "node:crypto";

export interface PlateCacheMeta {
  /** 源生图提示词 sha256（十六进制全量；实际重试提示词另记） */
  promptSha256?: string;
  /** 实际提交的提示词（可含监制返修要求），与未返修的源提示词分别留痕。 */
  submittedPromptSha256?: string;
  requestSha256?: string;
  artifactSha256?: string;
  /** 出图时的锚点模式：none = 纯文生图（可进 Seedance）；real = 挂真人锚点（仅档案资产） */
  anchorMode?: string;
  /** 出图模型 id（留痕；完整请求指纹包含模型） */
  model?: string;
  /** 出图时间（ISO） */
  at?: string;
}

export interface PlateCacheInput {
  /** 产物文件是否存在 */
  exists: boolean;
  /** 产物字节数 */
  sizeBytes: number;
  /** 最小体积阈值（默认 50KB，与关键帧硬闸一致） */
  minBytes?: number;
  /** 指纹元文件内容（缺失传 null） */
  meta: PlateCacheMeta | null;
  /** 当前提示词 sha256（提示词不存在传 null） */
  currentPromptSha256: string | null;
  /** 完整生图请求指纹；传入时旧元数据必须失效。 */
  currentRequestSha256?: string;
  /** 重新读取的关键帧字节指纹，防止已批准文件被替换。 */
  currentArtifactSha256?: string | null;
  /** 本次运行的锚点模式 */
  anchorMode: string;
  /** 本镜最近一次关键帧裁决是否放行 */
  lastApproved: boolean;
}

export interface PlateCacheDecision {
  valid: boolean;
  /** 失效原因（valid=true 时为 "命中"） */
  reason: string;
}

export const PLATE_CACHE_MIN_BYTES = 50_000;

export function plateRequestSha256(input: {
  prompt: string;
  model: string;
  anchorMode: string;
  size: string;
  referenceSha256: string[];
}): string {
  return createHash("sha256").update(JSON.stringify({
    schema: "workloom.plate-request/v1",
    prompt: input.prompt, model: input.model, anchorMode: input.anchorMode,
    size: input.size, references: input.referenceSha256
  })).digest("hex");
}

export function decidePlateCache(input: PlateCacheInput): PlateCacheDecision {
  const minBytes = input.minBytes ?? PLATE_CACHE_MIN_BYTES;
  if (!input.exists) return { valid: false, reason: "产物不存在" };
  if (!(input.sizeBytes > minBytes)) return { valid: false, reason: `产物过小（${input.sizeBytes}B ≤ ${minBytes}B）` };
  if (!input.currentPromptSha256) return { valid: false, reason: "当前提示词缺失（无法比对指纹）" };
  if (!input.meta) return { valid: false, reason: "缺指纹元文件（历史产物）" };
  if (!input.meta.promptSha256) return { valid: false, reason: "指纹元文件缺 promptSha256" };
  if (input.meta.promptSha256 !== input.currentPromptSha256) return { valid: false, reason: "提示词已变更" };
  if (input.meta.anchorMode !== input.anchorMode) {
    return { valid: false, reason: `锚点模式已变更（${input.meta.anchorMode ?? "缺"} → ${input.anchorMode}）` };
  }
  if (input.currentRequestSha256 !== undefined && input.meta.requestSha256 !== input.currentRequestSha256) {
    return { valid: false, reason: "生图请求已变更或缺少请求指纹" };
  }
  if (input.currentArtifactSha256 !== undefined && (!input.currentArtifactSha256 || input.meta.artifactSha256 !== input.currentArtifactSha256)) {
    return { valid: false, reason: "关键帧字节已变更或缺少产物指纹" };
  }
  if (!input.lastApproved) return { valid: false, reason: "上次裁决未放行" };
  return { valid: true, reason: "命中（指纹一致 + 历史放行）" };
}
