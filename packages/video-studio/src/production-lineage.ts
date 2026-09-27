/**
 * 当前产物的本地血缘检查。这里核对来源、最新裁决及实际字节；它不是供应商回执或服务端签章。
 * 手写 JSON 不能因此获得正式交付资格，可信发布入口还须检查自己的生产记录。
 */
import { createHash } from "node:crypto";
import { readFileSync, realpathSync, statSync } from "node:fs";
import { resolve } from "node:path";

export const LINEAGE_VERSION = "workloom.production-lineage/v1" as const;
export type LineageStatus = "passed" | "failed" | "unverified" | "not_applicable";
export interface ArtifactFingerprint { path: string; realpath: string; sha256: string; bytes: number }
export interface LineageInputSnapshot { artifacts: ArtifactFingerprint[]; errors: string[] }
export interface LineageScope { projectId: string; sourceHash: string }
export interface LineageReceipt extends LineageScope {
  schemaVersion: typeof LINEAGE_VERSION;
  runId: string;
  stage: string;
  shotId: string | null;
  recipeHash: string;
  status: LineageStatus;
  inputs: ArtifactFingerprint[];
  outputs: ArtifactFingerprint[];
  notApplicableReason: string | null;
  errors: string[];
}
export interface LineageRecord {
  stage: string;
  shotId?: string | null;
  lineage?: LineageReceipt;
  ok?: boolean;
  degraded?: boolean;
  verdict?: { approved?: boolean; degraded?: boolean } | null;
}

/** 排序后的结构哈希；无效数值和非 JSON 值必须显式处理，不能静默丢弃。 */
export function productionHash(value: unknown): string {
  const seen = new Set<object>();
  const normalize = (part: unknown): unknown => {
    if (part === null || typeof part === "string" || typeof part === "boolean") return part;
    if (typeof part === "number" && Number.isFinite(part)) return part;
    if (typeof part !== "object" || part === null) throw new Error("LINEAGE_INVALID_HASH_INPUT");
    if (seen.has(part)) throw new Error("LINEAGE_CYCLIC_HASH_INPUT");
    seen.add(part);
    const result = Array.isArray(part) ? part.map(normalize)
      : Object.fromEntries(Object.keys(part).sort().map((key) => [key, normalize((part as Record<string, unknown>)[key])]));
    seen.delete(part);
    return result;
  };
  return createHash("sha256").update(JSON.stringify(normalize(value))).digest("hex");
}

export function fingerprintArtifact(file: string): ArtifactFingerprint {
  const path = resolve(file);
  const realpath = realpathSync(path);
  const before = statSync(realpath);
  if (!before.isFile() || before.size === 0) throw new Error(`LINEAGE_EMPTY_OR_NON_FILE: ${path}`);
  const data = readFileSync(realpath);
  const after = statSync(realpath);
  if (before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ino !== after.ino || data.length !== after.size) {
    throw new Error(`LINEAGE_INPUT_CHANGED_DURING_READ: ${path}`);
  }
  if (realpathSync(path) !== realpath) throw new Error(`LINEAGE_LINK_CHANGED_DURING_READ: ${path}`);
  return { path, realpath, sha256: createHash("sha256").update(data).digest("hex"), bytes: data.length };
}

function validHash(value: unknown): value is string { return typeof value === "string" && /^[a-f0-9]{64}$/.test(value); }
function sameArtifact(before: ArtifactFingerprint): boolean {
  if (!before || typeof before.path !== "string" || typeof before.realpath !== "string" || !validHash(before.sha256)) return false;
  try {
    const now = fingerprintArtifact(before.path);
    return now.realpath === before.realpath && now.sha256 === before.sha256 && now.bytes === before.bytes;
  } catch { return false; }
}

/** 在工位调用之前保存输入；保存失败也留痕，不能在工位结束后倒填为本次使用的输入。 */
export function captureLineageInputs(files: string[]): LineageInputSnapshot {
  const errors: string[] = [];
  const artifacts = [...new Set(files.map((file) => resolve(file)))].flatMap((file) => {
    try { return [fingerprintArtifact(file)]; }
    catch (error) { errors.push(error instanceof Error ? error.message : String(error)); return []; }
  });
  return { artifacts, errors };
}

export function createLineageReceipt(input: LineageScope & {
  runId: string; stage: string; shotId?: string | null; recipe: unknown;
  status: LineageStatus; inputs: string[]; outputs: string[]; notApplicableReason?: string;
  inputSnapshot?: LineageInputSnapshot;
  reviewedArtifacts?: Array<{ path: string; sha256: string }>;
}): LineageReceipt {
  if (!input.projectId.trim() || !input.runId.trim() || !input.stage.trim() || !validHash(input.sourceHash)) {
    throw new Error("LINEAGE_INVALID_SCOPE");
  }
  const errors: string[] = [];
  const capture = (files: string[]): ArtifactFingerprint[] => [...new Set(files.map((file) => resolve(file)))].flatMap((file) => {
    try { return [fingerprintArtifact(file)]; }
    catch (error) { errors.push(error instanceof Error ? error.message : String(error)); return []; }
  });
  const inputs = input.inputSnapshot ? input.inputSnapshot.artifacts : capture(input.inputs);
  const outputs = capture(input.outputs);
  if (input.inputSnapshot) {
    errors.push(...input.inputSnapshot.errors);
    const expectedPaths = [...new Set(input.inputs.map((file) => resolve(file)))].sort();
    if (JSON.stringify(inputs.map((entry) => entry.path).sort()) !== JSON.stringify(expectedPaths)) errors.push("LINEAGE_INPUT_SNAPSHOT_INCOMPLETE");
    for (const entry of inputs) if (!sameArtifact(entry)) errors.push(`LINEAGE_INPUT_CHANGED_DURING_STAGE: ${entry.path}`);
  }
  for (const reviewed of input.reviewedArtifacts ?? []) {
    try {
      if (!validHash(reviewed.sha256) || fingerprintArtifact(reviewed.path).sha256 !== reviewed.sha256) {
        errors.push(`LINEAGE_REVIEWED_ARTIFACT_CHANGED: ${reviewed.path}`);
      }
    } catch (error) { errors.push(error instanceof Error ? error.message : String(error)); }
  }
  if (input.status === "not_applicable" && !input.notApplicableReason?.trim()) errors.push("LINEAGE_APPLICABILITY_REASON_REQUIRED");
  return {
    schemaVersion: LINEAGE_VERSION, projectId: input.projectId, sourceHash: input.sourceHash,
    runId: input.runId, stage: input.stage, shotId: input.shotId ?? null, recipeHash: productionHash(input.recipe),
    status: errors.length && input.status !== "failed" ? "unverified" : input.status,
    inputs, outputs, notApplicableReason: input.notApplicableReason?.trim() || null, errors,
  };
}

export function verifyLineageReceipt(receipt: LineageReceipt | undefined, scope: LineageScope, recipe: unknown): { ok: boolean; detail: string } {
  if (!receipt || receipt.schemaVersion !== LINEAGE_VERSION) return { ok: false, detail: "没有当前版本的产物血缘记录" };
  if (receipt.projectId !== scope.projectId || receipt.sourceHash !== scope.sourceHash || receipt.recipeHash !== productionHash(recipe)) {
    return { ok: false, detail: "项目、源输入或阶段配方与本次不一致" };
  }
  if (!Array.isArray(receipt.errors) || receipt.errors.length || !Array.isArray(receipt.inputs) || !Array.isArray(receipt.outputs)) {
    return { ok: false, detail: "产物血缘记录不完整" };
  }
  if (receipt.status !== "passed" && !(receipt.status === "not_applicable" && receipt.notApplicableReason)) {
    return { ok: false, detail: `最新裁决不是已通过：${receipt.status}` };
  }
  const changed = [...receipt.inputs, ...receipt.outputs].filter((entry) => !sameArtifact(entry));
  return changed.length ? { ok: false, detail: `输入或输出已改变/缺失：${changed.map((entry) => entry.path).join("、")}` }
    : { ok: true, detail: receipt.status === "not_applicable" ? `明确不适用：${receipt.notApplicableReason}` : "当前输入、输出哈希与最新裁决一致" };
}

/** 先取该项目该阶段/镜头的最后一条，再检查内容；不能先筛成功而漏掉后来的拒绝。 */
export function latestLineageRecord<T extends LineageRecord>(records: readonly T[], projectId: string, stage: string, shotId: string | null): T | undefined {
  return records.filter((row) => row.stage === stage && (row.shotId ?? null) === shotId
    && (row.lineage?.projectId === projectId || !row.lineage)).at(-1);
}

export function stageLineageApproved(input: {
  records: readonly LineageRecord[]; projectId: string; stage: string; shotIds?: Array<string | null>;
  sourceHash: (shotId: string | null) => string; recipe: unknown;
}): { ok: boolean; detail: string } {
  const ids = input.shotIds ?? [null];
  if (ids.length === 0 || new Set(ids).size !== ids.length) return { ok: false, detail: "阶段检查没有范围或镜头编号重复" };
  const results = ids.map((shotId) => {
    const row = latestLineageRecord(input.records, input.projectId, input.stage, shotId);
    if (!row || row.ok !== true || row.degraded || row.verdict?.approved === false || row.verdict?.degraded) {
      return { ok: false, detail: `${shotId ?? input.stage}：缺记录、最新打回或降级` };
    }
    if (row.lineage?.stage !== input.stage || row.lineage.shotId !== shotId) return { ok: false, detail: "回执的阶段或镜号不匹配" };
    const result = verifyLineageReceipt(row.lineage, { projectId: input.projectId, sourceHash: input.sourceHash(shotId) }, input.recipe);
    return { ok: result.ok, detail: `${shotId ?? input.stage}：${result.detail}` };
  });
  return { ok: results.every((result) => result.ok), detail: results.map((result) => result.detail).join("；") };
}

/** 文件选择必须对应最近一次成功产物，且记录了正在使用的直接输入；mtime 不参与决策。 */
export function reusableLineageArtifact(input: {
  records: readonly LineageRecord[]; scope: LineageScope; stage: string; shotId?: string | null;
  recipe: unknown; candidate: string; upstream?: string;
}): boolean {
  const row = latestLineageRecord(input.records, input.scope.projectId, input.stage, input.shotId ?? null);
  if (!row?.lineage || row.ok !== true || row.degraded || row.verdict?.approved === false || row.verdict?.degraded) return false;
  if (row.lineage.stage !== input.stage || row.lineage.shotId !== (input.shotId ?? null)) return false;
  if (!verifyLineageReceipt(row.lineage, input.scope, input.recipe).ok) return false;
  if (!row.lineage.outputs.some((entry) => entry.path === resolve(input.candidate))) return false;
  const upstream = input.upstream;
  return !upstream || row.lineage.inputs.some((entry) => entry.path === resolve(upstream));
}

/** 禁止 --only 被带入项目合成或交付；否则修一镜可能把整片缩成一镜。 */
export function assertSelectedShotStageScope(stages: Iterable<string>, only: readonly string[]): void {
  if (!only.length) return;
  const projectStages = new Set(["compose", "color", "subtitle", "danmaku", "bgm", "sfx", "cover", "mux", "master", "deliver", "revise"]);
  const invalid = [...stages].filter((stage) => projectStages.has(stage));
  if (invalid.length) throw new Error(`SELECTED_SHOTS_POST_SCOPE: --only 只能用于逐镜步骤；项目后期请单独运行：${invalid.join(",")}`);
}
