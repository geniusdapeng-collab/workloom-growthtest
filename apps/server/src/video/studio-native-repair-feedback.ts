import path from "node:path";
import { constants } from "node:fs";
import { open, realpath } from "node:fs/promises";
import { canonicalRenderJson, renderSha256 } from "./gen/compiled-request.js";

export const NATIVE_CAMERA_FAILURE_PREFIX = "STUDIO_CHECKPOINT_INVALID: PRODUCTION 未完成有效原生产物；运镜诊断：";

interface NativeCameraIssue {
  rule: string;
  shots: string[];
  message: string;
  rewrite_hint: string;
}

interface NativeProductionDiagnosis {
  originRunId: string;
  attempt: number;
  stageId: "preproduction" | "prompt_review";
  metaRef: string;
  metaSha256: string;
  failedAt: string;
  message: string;
  issues: NativeCameraIssue[];
}

export interface NativeProductionRepairEvidence {
  schemaVersion: "workloom.native-production-repair-evidence/v1";
  diagnoses: NativeProductionDiagnosis[];
}

export interface KnownNativeProductionPrior {
  runId: string;
  attempt: number;
  stageId: "preproduction" | "prompt_review";
  status: string;
  errorClass?: string | null;
  errorMessage?: string | null;
  startedAt?: string | null;
  finishedAt?: string | null;
}

function invalid(message: string): never {
  throw new Error(`STUDIO_NATIVE_REPAIR_FEEDBACK_UNVERIFIED: ${message}`);
}

const record = (value: unknown): value is Record<string, unknown> => Boolean(value && typeof value === "object" && !Array.isArray(value));
const hash = (value: unknown): value is string => typeof value === "string" && /^[a-f0-9]{64}$/u.test(value);
const claim = (value: unknown): value is string => typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/u.test(value);
const timestamp = (value: unknown): value is string => typeof value === "string" && Number.isFinite(Date.parse(value));

/** Parse complete JSON objects without splitting punctuation inside a diagnosis. */
function cameraIssues(message: string): NativeCameraIssue[] {
  if (!message.startsWith(NATIVE_CAMERA_FAILURE_PREFIX)) invalid("原生失败类型不匹配");
  const text = message.slice(NATIVE_CAMERA_FAILURE_PREFIX.length);
  const objects: unknown[] = [];
  let start = -1;
  let depth = 0;
  let quoted = false;
  let escaped = false;
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index]!;
    if (start < 0) {
      if (/^[\s；;]$/u.test(character)) continue;
      if (character !== "{") invalid("运镜诊断包含非结构化片段");
      start = index;
    }
    if (quoted) {
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === '"') quoted = false;
    } else if (character === '"') quoted = true;
    else if (character === "{") depth += 1;
    else if (character === "}") {
      depth -= 1;
      if (depth === 0) {
        try { objects.push(JSON.parse(text.slice(start, index + 1))); }
        catch { invalid("运镜诊断 JSON 无效"); }
        start = -1;
      }
    }
  }
  if (start >= 0 || quoted || depth !== 0 || objects.length === 0) invalid("运镜诊断被截断或为空");
  return objects.map(value => {
    if (!record(value) || typeof value.rule !== "string" || !/^R[1-5]_[a-z_]+$/u.test(value.rule)
      || !Array.isArray(value.shots) || value.shots.length === 0 || !value.shots.every(claim)
      || typeof value.message !== "string" || !value.message.trim()
      || typeof value.rewrite_hint !== "string" || !value.rewrite_hint.trim()) invalid("运镜诊断字段无效");
    return { rule: value.rule, shots: value.shots as string[], message: value.message, rewrite_hint: value.rewrite_hint };
  });
}

function checkedEvidence(value: unknown): NativeProductionRepairEvidence | null {
  if (value == null) return null;
  if (!record(value) || value.schemaVersion !== "workloom.native-production-repair-evidence/v1"
    || !Array.isArray(value.diagnoses) || value.diagnoses.length === 0) invalid("继承的原生反馈格式无效");
  const seen = new Set<string>();
  for (const item of value.diagnoses) {
    if (!record(item) || !claim(item.originRunId) || !Number.isSafeInteger(item.attempt) || Number(item.attempt) < 1
      || !["preproduction", "prompt_review"].includes(String(item.stageId)) || !hash(item.metaSha256)
      || item.metaRef !== `stages/${item.stageId}/attempt-${item.attempt}.meta.json` || !timestamp(item.failedAt)
      || typeof item.message !== "string" || !Array.isArray(item.issues)) invalid("继承的原生反馈身份无效");
    if (seen.has(item.originRunId)) invalid("继承的原生反馈含重复运行");
    seen.add(item.originRunId);
    if (canonicalRenderJson(cameraIssues(item.message)) !== canonicalRenderJson(item.issues)) invalid("继承的完整诊断不一致");
  }
  return structuredClone(value) as unknown as NativeProductionRepairEvidence;
}

/**
 * The caller supplies OUTCOME only through the existing same-task checkpoint
 * store and a prior stage already verified under the project lease. Feedback is
 * author input, never a gate verdict or permission to submit rendering.
 */
export async function loadNativeProductionRepairEvidence(input: {
  archiveRoot: string;
  prior?: KnownNativeProductionPrior;
  priorOutcome: unknown;
  inherited: unknown;
}): Promise<NativeProductionRepairEvidence | null> {
  // A changed frozen input/model does not load the previous OUTCOME. Do not
  // import that task's failures merely because the project ID is the same.
  if (!record(input.priorOutcome) || input.priorOutcome.state !== "known") return null;
  const inherited = checkedEvidence(input.inherited);
  const prior = input.prior;
  if (!prior || prior.status !== "failed" || !prior.errorMessage?.startsWith(NATIVE_CAMERA_FAILURE_PREFIX)) return inherited;
  if (!claim(prior.runId) || !Number.isSafeInteger(prior.attempt) || prior.attempt < 1
    || !["preproduction", "prompt_review"].includes(prior.stageId)) invalid("原运行身份无效");
  const metaRef = `stages/${prior.stageId}/attempt-${prior.attempt}.meta.json`;
  const root = path.resolve(input.archiveRoot);
  const file = path.resolve(root, metaRef);
  let bytes: Buffer;
  try {
    if (await realpath(file) !== file || !file.startsWith(root + path.sep)) invalid("原失败档案路径无效");
    const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const stat = await handle.stat();
      if (!stat.isFile() || stat.size < 1 || stat.size > 32 * 1024 * 1024) invalid("原失败档案大小或类型无效");
      bytes = await handle.readFile();
    } finally { await handle.close(); }
  } catch (error) {
    invalid(`原失败档案读取失败：${error instanceof Error ? error.message : String(error)}`);
  }
  let meta: unknown;
  try { meta = JSON.parse(bytes!.toString("utf8")); }
  catch { invalid("原失败档案 JSON 无效"); }
  if (!record(meta) || typeof meta.stack !== "string" || !timestamp(meta.failedAt)) invalid("原失败档案缺完整堆栈或时间");
  if (prior.errorClass && meta.errorClass !== prior.errorClass) invalid("失败档案分类与原台账不一致");
  const header = meta.stack.split(/\n\s+at\b/u, 1)[0]!;
  const location = header.indexOf(NATIVE_CAMERA_FAILURE_PREFIX);
  if (location < 0 || !["", "Error: ", "StudioCheckpointError: "].includes(header.slice(0, location))) invalid("原失败堆栈类型无效");
  const message = header.slice(location);
  // StageRunner stores the complete stack in this existing meta artifact but
  // only the first500 UTF-16 units in the database error column.
  if (message.slice(0, 500) !== prior.errorMessage) invalid("完整失败与原台账摘要不一致");
  if (prior.startedAt && (!timestamp(prior.startedAt) || Date.parse(meta.failedAt) < Date.parse(prior.startedAt))) invalid("失败档案早于原运行");
  if (prior.finishedAt && (!timestamp(prior.finishedAt) || Date.parse(meta.failedAt) > Date.parse(prior.finishedAt))) invalid("失败档案晚于原运行");
  const diagnosis: NativeProductionDiagnosis = { originRunId: prior.runId, attempt: prior.attempt, stageId: prior.stageId,
    metaRef, metaSha256: renderSha256(bytes!), failedAt: meta.failedAt, message, issues: cameraIssues(message) };
  const diagnoses = inherited?.diagnoses ?? [];
  const existing = diagnoses.find(item => item.originRunId === diagnosis.originRunId);
  if (existing) {
    if (canonicalRenderJson(existing) !== canonicalRenderJson(diagnosis)) invalid("同一原失败的诊断字节已变化");
  } else diagnoses.push(diagnosis);
  return { schemaVersion: "workloom.native-production-repair-evidence/v1", diagnoses };
}
