import { createHash } from "node:crypto";
import {
  PROMPT_FINDING_SCHEMA,
  promptFindingIsBlocking,
  promptFindingKey,
  type PromptFinding,
  type PromptRepairClass,
} from "./prompt-finding.js";
import {
  buildPromptConstraintSet,
  buildPromptStoryPlan,
  derivePromptShotPlan,
  type PromptConstraintSet,
  type PromptShotPlan,
  type PromptStoryPlan,
} from "./prompt-shot-plan.js";

export const PROMPT_REPAIR_PLAN_SCHEMA = "workloom.prompt-repair-plan/v1" as const;
export const PROMPT_REPAIR_CONTEXT_SCHEMA = "workloom.prompt-repair-context/v1" as const;
export const PROMPT_ROW_CHECKPOINT_SCHEMA = "workloom.prompt-row-checkpoint/v1" as const;

export interface PromptRepairRow {
  shotId: string;
  prompt: string;
  fields: Record<string, unknown>;
  duration?: number;
  [key: string]: unknown;
}

export interface PromptRowCheckpoint {
  schemaVersion: typeof PROMPT_ROW_CHECKPOINT_SCHEMA;
  projectId: string;
  revision: number;
  shotId: string;
  sourcePlanSha256: string;
  promptRowSha256: string;
  policyVersion: string;
  dependencyShotIds: string[];
  status: "passed" | "rejected" | "unverified";
  lastVerifiedAt: string;
}

export interface PromptRepairTarget {
  shotId: string;
  fields: string[];
  currentRowSha256: string;
  neighborShotIds: string[];
}

export interface PromptRepairPlan {
  schemaVersion: typeof PROMPT_REPAIR_PLAN_SCHEMA;
  projectId: string;
  revision: number;
  round: number;
  sourcePromptSetSha256: string;
  constraintSet: PromptConstraintSet;
  storyPlan: PromptStoryPlan;
  findings: PromptFinding[];
  shotPlans: PromptShotPlan[];
  targets: PromptRepairTarget[];
  blocked: Array<{ findingId: string; reason: string }>;
  budget: {
    maxRepairRounds: number;
    maxTextCalls: number;
    maxTextCallsPerShot: number;
  };
  planHash: string;
}

export interface PromptRepairContext {
  schemaVersion: typeof PROMPT_REPAIR_CONTEXT_SCHEMA;
  plan: PromptRepairPlan;
  rows: PromptRepairRow[];
  targetShotIds: string[];
  targetAll: boolean;
}

export type PromptRepairBuildResult =
  | { ok: true; plan: PromptRepairPlan; context: PromptRepairContext }
  | { ok: false; code: "PROMPT_REPAIR_NOT_REQUIRED" | "PROMPT_REPAIR_BLOCKED" | "PROMPT_FINDING_UNBOUND"; reason: string; plan: null };

function canonical(value: unknown): string {
  return JSON.stringify(value, (_key, item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) return item;
    return Object.fromEntries(Object.keys(item as Record<string, unknown>).sort()
      .map(key => [key, (item as Record<string, unknown>)[key]]));
  });
}

export function promptRepairHash(value: unknown): string {
  return createHash("sha256").update(canonical(value)).digest("hex");
}

function record(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

export function normalizePromptRepairRows(rows: readonly unknown[]): PromptRepairRow[] {
  const seen = new Set<string>();
  return rows.map((value, index) => {
    if (!record(value)) throw new Error(`PROMPT_REPAIR_ROWS_INVALID: 第 ${index + 1} 个镜头不是对象`);
    const shotId = String(value.shotId ?? value.shot_id ?? "").trim();
    if (!shotId || seen.has(shotId)) throw new Error(`PROMPT_REPAIR_ROWS_INVALID: 镜头 ID 缺失或重复：${shotId || index + 1}`);
    const prompt = typeof value.prompt === "string" ? value.prompt : "";
    if (!prompt.trim()) throw new Error(`PROMPT_REPAIR_ROWS_INVALID: ${shotId} 缺少提示词正文`);
    if (!record(value.fields)) throw new Error(`PROMPT_REPAIR_ROWS_INVALID: ${shotId} 缺少 25 字段对象`);
    seen.add(shotId);
    return {
      ...structuredClone(value),
      shotId,
      prompt,
      fields: structuredClone(value.fields),
      ...(Number.isFinite(Number(value.duration)) ? { duration: Number(value.duration) } : {}),
    };
  });
}

function targetClass(classes: ReadonlySet<PromptRepairClass>): PromptRepairClass {
  const order: PromptRepairClass[] = ["human_input", "replan", "evidence", "semantic", "deterministic", "schema"];
  return order.find(value => classes.has(value)) ?? "semantic";
}

export function buildPromptRepairPlan(input: {
  projectId: string;
  revision: number;
  round: number;
  rows: readonly unknown[];
  findings: readonly PromptFinding[];
  policyVersion?: string;
  maxRepairRounds?: number;
  maxTextCalls?: number;
  maxTextCallsPerShot?: number;
  rawIntent?: string;
  metadata?: Record<string, unknown>;
  targetSeconds?: number;
  now?: string;
}): PromptRepairBuildResult {
  const rows = normalizePromptRepairRows(input.rows);
  const ids = rows.map(row => row.shotId);
  const idSet = new Set(ids);
  const blocking = input.findings.filter(promptFindingIsBlocking);
  if (blocking.length === 0) {
    return { ok: false, code: "PROMPT_REPAIR_NOT_REQUIRED", reason: "没有阻塞 finding", plan: null };
  }
  for (const finding of blocking) {
    if (finding.shotId && !idSet.has(finding.shotId)) {
      return {
        ok: false,
        code: "PROMPT_FINDING_UNBOUND",
        reason: `${finding.code} 指向不存在的镜头 ${finding.shotId}`,
        plan: null,
      };
    }
  }
  const human = blocking.filter(finding => finding.repairClass === "human_input");
  if (human.length > 0) {
    return { ok: false, code: "PROMPT_REPAIR_BLOCKED", reason: human.map(item => item.issue).join("；"), plan: null };
  }
  const targetAll = blocking.some(finding => finding.shotId === null);
  const targetIds = targetAll ? ids : [...new Set(blocking.map(finding => finding.shotId).filter((id): id is string => Boolean(id)))];
  const targets = targetIds.map(shotId => {
    const index = ids.indexOf(shotId);
    const row = rows[index]!;
    const relevant = blocking.filter(finding => finding.shotId === null || finding.shotId === shotId);
    return {
      shotId,
      fields: [...new Set(relevant.map(finding => finding.fieldPath).filter((field): field is string => Boolean(field)))],
      currentRowSha256: promptRepairHash(row),
      neighborShotIds: [ids[index - 1], ids[index + 1]].filter((id): id is string => Boolean(id)),
    };
  });
  const shotPlans = targetIds.map(shotId => {
    const row = rows[ids.indexOf(shotId)]!;
    return derivePromptShotPlan(input.projectId, input.revision, row,
      blocking.filter(finding => finding.shotId === null || finding.shotId === shotId)
        .flatMap(finding => finding.evidenceRefs));
  });
  const payload = {
    schemaVersion: PROMPT_REPAIR_PLAN_SCHEMA,
    projectId: input.projectId,
    revision: input.revision,
    round: input.round,
    sourcePromptSetSha256: promptRepairHash(rows),
    constraintSet: buildPromptConstraintSet({
      projectId: input.projectId,
      revision: input.revision,
      rawIntent: input.rawIntent ?? "",
      metadata: input.metadata,
      targetSeconds: input.targetSeconds,
    }),
    storyPlan: buildPromptStoryPlan({
      projectId: input.projectId,
      revision: input.revision,
      rows,
    }),
    findings: structuredClone(blocking),
    shotPlans,
    targets,
    blocked: [],
    budget: {
      maxRepairRounds: Math.max(1, Math.min(5, input.maxRepairRounds ?? 2)),
      maxTextCalls: Math.max(1, Math.min(200, input.maxTextCalls ?? 32)),
      maxTextCallsPerShot: Math.max(1, Math.min(32, input.maxTextCallsPerShot ?? 8)),
    },
  };
  const plan: PromptRepairPlan = { ...payload, planHash: promptRepairHash(payload) };
  return {
    ok: true,
    plan,
    context: {
      schemaVersion: PROMPT_REPAIR_CONTEXT_SCHEMA,
      plan,
      rows,
      targetShotIds: targetIds,
      targetAll,
    },
  };
}

export function promptRepairFeedback(plan: PromptRepairPlan): string {
  const classSet = new Set(plan.findings.map(item => item.repairClass));
  const classes = targetClass(classSet);
  const classInstructions: Partial<Record<PromptRepairClass, string>> = {
    deterministic: "确定性问题必须按原始合同修正字段、长度、占位符或时间轴，不得只改说明文字。",
    semantic: "语义问题只修改目标镜头的实际创作字段，完整保留冻结需求、动作顺序和相邻镜头上下文。",
    evidence: "证据类问题只能删除未支持主张或改回已核实值，不得自行补来源、补参数或扩大已审事实。",
    replan: "镜头目标不可执行时生成新的镜头计划 revision；不得把拆分或重排伪装成普通文字改写。",
    human_input: "需要授权、预算或产品决策，禁止自动修改。",
    schema: "结构问题必须回到既有 25 字段合同，不得新增、删除、重命名或重排标准字段。",
  };
  return canonical({
    schemaVersion: "workloom.prompt-repair-feedback/v1",
    instruction: [
      "只修复 targets 中的镜头。",
      ...[...classSet].map(item => classInstructions[item]).filter(Boolean),
      "未命中的已通过镜头与历史事实保持不变；不得把诊断、证据索引或内部标签写入最终提示词。",
      "同一 finding 连续两轮无进展时必须停止，不得扩大镜头范围。",
    ].join(""),
    planHash: plan.planHash,
    repairClass: classes,
    repairClasses: [...classSet],
    findings: plan.findings,
    targets: plan.targets,
    budget: plan.budget,
  });
}

export function promptRowCheckpoint(
  row: PromptRepairRow,
  options: {
    projectId: string;
    revision: number;
    policyVersion: string;
    dependencyShotIds?: string[];
    status?: PromptRowCheckpoint["status"];
    now?: string;
  },
): PromptRowCheckpoint {
  return {
    schemaVersion: PROMPT_ROW_CHECKPOINT_SCHEMA,
    projectId: options.projectId,
    revision: options.revision,
    shotId: row.shotId,
    sourcePlanSha256: promptRepairHash(stripGeneratedPromptFields(row)),
    promptRowSha256: promptRepairHash(row),
    policyVersion: options.policyVersion,
    dependencyShotIds: [...new Set(options.dependencyShotIds ?? [])],
    status: options.status ?? "passed",
    lastVerifiedAt: options.now ?? new Date().toISOString(),
  };
}

function stripGeneratedPromptFields(row: PromptRepairRow): Record<string, unknown> {
  const copy = structuredClone(row) as Record<string, unknown>;
  for (const key of ["prompt", "fields", "degraded", "degradeReason", "semanticRefinement", "_workloomFusion"]) {
    delete copy[key];
  }
  return copy;
}

export function promptRepairFindingKeys(findings: readonly PromptFinding[]): string[] {
  return [...new Set(findings.filter(promptFindingIsBlocking).map(promptFindingKey))].sort();
}

export function promptRepairMadeProgress(input: {
  priorFindingKeys: readonly string[];
  nextFindingKeys: readonly string[];
  priorRows: readonly PromptRepairRow[];
  nextRows: readonly PromptRepairRow[];
  targetShotIds: readonly string[];
}): boolean {
  const before = new Set(input.priorFindingKeys);
  const after = new Set(input.nextFindingKeys);
  if ([...before].some(key => !after.has(key))) return true;
  const prior = new Map(input.priorRows.map(row => [row.shotId, promptRepairHash(row)]));
  const next = new Map(input.nextRows.map(row => [row.shotId, promptRepairHash(row)]));
  return input.targetShotIds.some(shotId => prior.get(shotId) !== next.get(shotId));
}

export function validatePromptRepairContext(value: unknown): PromptRepairContext | null {
  if (!record(value) || value.schemaVersion !== PROMPT_REPAIR_CONTEXT_SCHEMA || !record(value.plan)
    || !Array.isArray(value.rows) || !Array.isArray(value.targetShotIds)) {
    return null;
  }
  const plan = value.plan;
  if (plan.schemaVersion !== PROMPT_REPAIR_PLAN_SCHEMA
    || !Array.isArray(plan.targets)
    || !Array.isArray(plan.findings)
    || !record(plan.budget)) {
    return null;
  }
  const rows = normalizePromptRepairRows(value.rows);
  const ids = new Set(rows.map(row => row.shotId));
  if (!value.targetShotIds.every(id => typeof id === "string" && ids.has(id))) return null;
  const findings = plan.findings;
  if (!Array.isArray(findings)
    || !findings.every(item => record(item) && item.schemaVersion === PROMPT_FINDING_SCHEMA)) {
    return null;
  }
  if (plan.sourcePromptSetSha256 !== promptRepairHash(rows)) return null;
  const rowById = new Map(rows.map(row => [row.shotId, row]));
  const targetIds = new Set(value.targetShotIds);
  const targets = plan.targets as unknown[];
  if (!targets.every(target => {
    if (!record(target) || typeof target.shotId !== "string" || !ids.has(target.shotId)) return false;
    const row = rowById.get(target.shotId);
    return Boolean(row) && target.currentRowSha256 === promptRepairHash(row);
  })) {
    return null;
  }
  if ([...targetIds].some(id => !targets.some(target => record(target) && target.shotId === id))) return null;
  const { planHash, ...planBody } = plan;
  if (typeof planHash !== "string" || planHash !== promptRepairHash(planBody)) return null;
  return structuredClone(value) as unknown as PromptRepairContext;
}
