import path from "node:path";
import { constants } from "node:fs";
import { open, realpath } from "node:fs/promises";
import {
  derivePromptFindings,
  normalizePromptFinding,
  type PromptFinding,
} from "@hyperreality/video-studio";
import { canonicalRenderJson, renderSha256 } from "./gen/compiled-request.js";

export const NATIVE_CAMERA_FAILURE_PREFIX = "STUDIO_CHECKPOINT_INVALID: PRODUCTION 未完成有效原生产物；运镜诊断：";

interface NativeCameraIssue {
  rule: string;
  shots: string[];
  message: string;
  rewrite_hint: string;
}

interface NativeCameraDiagnosis {
  kind?: undefined;
  originRunId: string;
  attempt: number;
  stageId: "preproduction" | "prompt_review";
  metaRef: string;
  metaSha256: string;
  failedAt: string;
  message: string;
  issues: NativeCameraIssue[];
}

interface NativeG6ReviewEvent {
  eventId: string;
  tenantId: string;
  workspaceId: string;
  objectId: string;
  action: "prompt.confirm";
  createdAt: string;
  after: Record<string, unknown>;
}

interface NativeG6Diagnosis {
  kind: "g6-prompt-rejection";
  originRunId: string;
  attempt: number;
  stageId: "preproduction" | "prompt_review";
  originStartedAt: string;
  originFinishedAt: string;
  failedAt: string;
  message: string;
  issues: string[];
  suggestions: string[];
  findings: PromptFinding[];
  reviewEventId: string;
  reviewEventSha256: string;
  reviewEvent: NativeG6ReviewEvent;
  evidenceMode: "legacy-event" | "complete-producer-verdict";
}

type NativeProductionDiagnosis = NativeCameraDiagnosis | NativeG6Diagnosis;

interface G6ReviewContext {
  tenantId: string;
  workspaceId: string;
  projectId: string;
  model: string;
  gateWorkDir: string;
  readEvents(prior: KnownNativeProductionPrior): Promise<unknown[]>;
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
const strings = (value: unknown): value is string[] => Array.isArray(value)
  && value.every(item => typeof item === "string" && Boolean(item.trim()));

/** A negative event is author evidence only; it can never become an approved gate. */
async function g6Diagnosis(value: unknown, prior: KnownNativeProductionPrior, context: G6ReviewContext): Promise<NativeG6Diagnosis | null> {
  if (![context.tenantId, context.workspaceId, context.projectId].every(claim) || typeof context.model !== "string" || !context.model.trim()
    || typeof context.gateWorkDir !== "string" || !path.isAbsolute(context.gateWorkDir)
    || !timestamp(prior.startedAt) || !timestamp(prior.finishedAt)
    || Date.parse(prior.startedAt) > Date.parse(prior.finishedAt)) invalid("G6 原运行作用域或时间无效");
  if (!record(value) || !claim(value.eventId) || value.tenantId !== context.tenantId || value.workspaceId !== context.workspaceId
    || value.objectId !== `${context.projectId}:g6_prompt` || value.action !== "prompt.confirm" || !record(value.after)) {
    invalid("G6 原裁决事件作用域不一致");
  }
  const at = value.createdAt instanceof Date && Number.isFinite(value.createdAt.getTime()) ? value.createdAt.toISOString() : value.createdAt;
  if (!timestamp(at) || Date.parse(at) < Date.parse(prior.startedAt) || Date.parse(at) > Date.parse(prior.finishedAt)) {
    invalid("G6 原裁决事件不在原运行时间内");
  }
  const after = value.after;
  if (after.gate !== "G6_PROMPT" || after.runId !== prior.runId || typeof after.approved !== "boolean") invalid("G6 原裁决运行或门不一致");
  if (Object.hasOwn(after, "unknownOutcome") && typeof after.unknownOutcome !== "boolean"
    || record(after.producerVerdict) && Object.hasOwn(after.producerVerdict, "unknownOutcome")
      && typeof after.producerVerdict.unknownOutcome !== "boolean") invalid("G6 原模型结果状态字段无效");
  if (after.unknownOutcome === true || record(after.producerVerdict) && after.producerVerdict.unknownOutcome === true) {
    invalid("G6 原模型结果未知，与已结算标记不一致");
  }
  // A successful G6 followed by FACT failure, or a settled unavailable review,
  // does not ask the author to change already produced creative content.
  if (after.approved) return null;
  if (!["llm", "fallback", "deterministic"].includes(String(after.via)) || typeof after.degraded !== "boolean") {
    invalid("G6 原裁决来源无效");
  }
  if (after.via !== "llm" || after.degraded) return null;
  if (after.producerMode !== "review" || after.model !== context.model || !Number.isFinite(after.score)
    || Number(after.score) < 0 || Number(after.score) > 100 || after.status !== undefined && after.status !== "failed"
    || typeof after.reason !== "string" || !after.reason.trim() || !strings(after.issues) || !strings(after.suggestions)) {
    invalid("G6 原模型拒绝裁决字段无效");
  }
  let issues = after.issues;
  let suggestions = after.suggestions;
  let findings: PromptFinding[] = [];
  let evidenceMode: NativeG6Diagnosis["evidenceMode"] = "legacy-event";
  if (after.producerVerdict !== undefined) {
    const verdict = after.producerVerdict;
    if (!record(verdict) || verdict.stage !== "prompt" || verdict.status !== "failed" || verdict.approved !== false
      || verdict.via !== "llm" || verdict.degraded !== false || verdict.model !== context.model
      || verdict.reason !== after.reason || verdict.score !== after.score || !strings(verdict.issues) || !strings(verdict.suggestions)
      || canonicalRenderJson(verdict.issues.slice(0, 5)) !== canonicalRenderJson(after.issues)
      || canonicalRenderJson(verdict.suggestions.slice(0, 5)) !== canonicalRenderJson(after.suggestions)
      || !Array.isArray(verdict.evidence) || verdict.evidence.length === 0
      || !Array.isArray(verdict.receipts) || verdict.receipts.length === 0) invalid("G6 完整原裁决与原事件不一致");
    const expectedFile = path.resolve(context.gateWorkDir, "gates", context.projectId,
      `${prior.stageId === "prompt_review" ? "prompt-review" : "attempt"}-${prior.attempt}`, "G6_PROMPT.md");
    for (const item of verdict.evidence) {
      if (!record(item) || item.path !== expectedFile || item.scope !== "complete-text" || !hash(item.sha256)) {
        invalid("G6 完整正文证据未绑定原项目和尝试");
      }
      try {
        if (await realpath(expectedFile) !== expectedFile) invalid("G6 原正文经过符号链接");
        const handle = await open(expectedFile, constants.O_RDONLY | constants.O_NOFOLLOW);
        try {
          const stat = await handle.stat();
          if (!stat.isFile() || stat.size < 1 || stat.size > 32 * 1024 * 1024
            || renderSha256(await handle.readFile()) !== item.sha256) invalid("G6 完整正文摘要已变化");
        } finally { await handle.close(); }
      } catch (error) { invalid(`G6 原正文读取失败：${error instanceof Error ? error.message : String(error)}`); }
    }
    for (const receipt of verdict.receipts) {
      if (!record(receipt) || receipt.modelId !== context.model
        || receipt.requestHash !== undefined && !hash(receipt.requestHash)
        || receipt.responseHash !== undefined && !hash(receipt.responseHash)
        || receipt.responseId !== undefined && (typeof receipt.responseId !== "string" || !receipt.responseId.trim())
        || [receipt.inputTokens, receipt.outputTokens].some(number => number !== undefined
          && (!Number.isSafeInteger(number) || Number(number) < 0))) invalid("G6 原模型回执字段无效");
    }
    issues = verdict.issues;
    suggestions = verdict.suggestions;
    if (verdict.findings !== undefined) {
      if (!Array.isArray(verdict.findings)) invalid("G6 完整原裁决 findings 无效");
      const normalized = verdict.findings.map((item, index) => normalizePromptFinding(item, index));
      if (normalized.some(item => !item)
        || canonicalRenderJson(normalized) !== canonicalRenderJson(verdict.findings)) invalid("G6 完整原裁决 findings 无法无损归一");
      findings = normalized as PromptFinding[];
    }
    evidenceMode = "complete-producer-verdict";
  }
  if (findings.length === 0) findings = derivePromptFindings(issues, suggestions, after.reason);
  const reviewEvent: NativeG6ReviewEvent = { eventId: value.eventId, tenantId: context.tenantId,
    workspaceId: context.workspaceId, objectId: value.objectId, action: "prompt.confirm", createdAt: at,
    after: structuredClone(after) };
  return { kind: "g6-prompt-rejection", originRunId: prior.runId, attempt: prior.attempt, stageId: prior.stageId,
    originStartedAt: prior.startedAt, originFinishedAt: prior.finishedAt, failedAt: at,
    message: after.reason, issues: [...issues], suggestions: [...suggestions], findings, reviewEventId: reviewEvent.eventId,
    reviewEventSha256: renderSha256(canonicalRenderJson(reviewEvent)), reviewEvent, evidenceMode };
}

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

async function checkedEvidence(value: unknown, g6Review?: G6ReviewContext): Promise<NativeProductionRepairEvidence | null> {
  if (value == null) return null;
  if (!record(value) || value.schemaVersion !== "workloom.native-production-repair-evidence/v1"
    || !Array.isArray(value.diagnoses) || value.diagnoses.length === 0) invalid("继承的原生反馈格式无效");
  const seen = new Set<string>();
  for (const item of value.diagnoses) {
    if (record(item) && item.kind !== undefined && item.kind !== "g6-prompt-rejection") invalid("继承的原生反馈类型无效");
    if (record(item) && item.kind === "g6-prompt-rejection") {
      if (!g6Review || !claim(item.originRunId) || !Number.isSafeInteger(item.attempt) || Number(item.attempt) < 1
        || !["preproduction", "prompt_review"].includes(String(item.stageId))) invalid("继承的G6反馈身份无效");
      const diagnosis = await g6Diagnosis(item.reviewEvent, { runId: item.originRunId, attempt: Number(item.attempt),
        stageId: item.stageId as KnownNativeProductionPrior["stageId"], status: "failed",
        startedAt: String(item.originStartedAt), finishedAt: String(item.originFinishedAt) }, g6Review);
      if (!diagnosis) invalid("继承的G6完整诊断无法重建");
      const { findings: diagnosisFindings, ...diagnosisBase } = diagnosis;
      const { findings: inheritedFindings, ...inheritedBase } = item;
      if (canonicalRenderJson(diagnosisBase) !== canonicalRenderJson(inheritedBase)
        || inheritedFindings !== undefined && canonicalRenderJson(diagnosisFindings) !== canonicalRenderJson(inheritedFindings)) {
        invalid("继承的G6完整诊断不一致");
      }
      if (seen.has(item.originRunId)) invalid("继承的原生反馈含重复运行");
      seen.add(item.originRunId);
      continue;
    }
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
  g6Review?: G6ReviewContext;
}): Promise<NativeProductionRepairEvidence | null> {
  // A changed frozen input/model does not load the previous OUTCOME. Do not
  // import that task's failures merely because the project ID is the same.
  if (!record(input.priorOutcome) || input.priorOutcome.state !== "known") return null;
  const inherited = await checkedEvidence(input.inherited, input.g6Review);
  const prior = input.prior;
  if (prior?.status === "failed" && input.g6Review) {
    if (!claim(prior.runId) || !Number.isSafeInteger(prior.attempt) || prior.attempt < 1
      || !["preproduction", "prompt_review"].includes(prior.stageId)
      || !timestamp(prior.startedAt) || !timestamp(prior.finishedAt)) invalid("G6 原运行身份或时间无效");
    let events: unknown[];
    try { events = await input.g6Review.readEvents(prior); }
    catch (error) { invalid(`原G6事件读取失败：${error instanceof Error ? error.message : String(error)}`); }
    if (!Array.isArray(events!) || events!.length > 1) invalid("原G6裁决事件缺失明确的唯一身份");
    if (events!.length === 0 && /^producer-rejected\(G6_PROMPT(?:\s*·|\))/u.test(prior.errorMessage ?? "")) {
      invalid("原G6拒绝事件缺失，不能重复审查同一坏稿");
    }
    if (events!.length === 1) {
      const diagnosis = await g6Diagnosis(events![0], prior, input.g6Review);
      if (diagnosis) {
        const diagnoses = inherited?.diagnoses ?? [];
        const existing = diagnoses.find(item => item.originRunId === diagnosis.originRunId);
        if (existing && canonicalRenderJson(existing) !== canonicalRenderJson(diagnosis)) invalid("同一原G6拒绝的诊断已变化");
        if (!existing) diagnoses.push(diagnosis);
        return { schemaVersion: "workloom.native-production-repair-evidence/v1", diagnoses };
      }
    }
  }
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
  const diagnosis: NativeCameraDiagnosis = { originRunId: prior.runId, attempt: prior.attempt, stageId: prior.stageId,
    metaRef, metaSha256: renderSha256(bytes!), failedAt: meta.failedAt, message, issues: cameraIssues(message) };
  const diagnoses = inherited?.diagnoses ?? [];
  const existing = diagnoses.find(item => item.originRunId === diagnosis.originRunId);
  if (existing) {
    if (canonicalRenderJson(existing) !== canonicalRenderJson(diagnosis)) invalid("同一原失败的诊断字节已变化");
  } else diagnoses.push(diagnosis);
  return { schemaVersion: "workloom.native-production-repair-evidence/v1", diagnoses };
}
