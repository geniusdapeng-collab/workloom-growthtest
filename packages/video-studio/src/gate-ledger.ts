/**
 * gate-ledger —— 管线**门（gate）的运行时记账**（2026-09-24，T-2026-0924-0001 第二次收口）
 *
 * 背景：`bundles/ai-video/pipelines/narrative-film.yml` 声明了 `g5-portrait-confirm` /
 * `g6-prompt-confirm` / `g7-preproduction` / `g8-render-submit` 四个**按 step_key 记账**的确认门，
 * 但全仓只有审计脚本引用过这些 key——运行时不落任何事件，于是"门有没有被按名调用"在日志里查不到，
 * 平台侧（apps/server 管线执行器）迟迟无法对齐 CLI 实际发生的决策。
 *
 * 本模块把"门事件"变成**一等公民记录**：与阶段记录写在同一个 `stages.jsonl` 里
 * （`stage: "gate"` + `stepKey` + `gate` + 裁决 + 证据），任何审计器/平台执行器都能按 step_key 检索。
 *
 * 纪律：
 *   · step_key 只认白名单里的四个（拼错即抛错，避免"看起来记了门、其实 key 是野的"）；
 *   · 门事件必须带 `sourceStage`（这个门由哪个环节的产物触发）与 `checks`（判据），不允许只写一句结论；
 *   · 硬闸失败即不通过——门不通过时调用方必须停止或显式记录"带瑕疵放行"。
 */
import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

export const PIPELINE_GATE_STEP_KEYS = [
  "g5-portrait-confirm",
  "g6-prompt-confirm",
  "g7-preproduction",
  "g8-render-submit",
  /** 多风格交付包：变体雷同一票否决（narrative-film.yml `deliver` 步） */
  "deliver",
  /** 返修闭环：层增量重合成 + 复用 sha256 证据（narrative-film.yml `revise` 步） */
  "revise"
] as const;

export type PipelineGateStepKey = (typeof PIPELINE_GATE_STEP_KEYS)[number];
export type PipelineGateId = "G5" | "G6" | "G7" | "G8" | "G-DLV1" | "G-DLV4";

/** step_key → 门的编号（与 narrative-film.yml 的 `gate:` 字段一致） */
const GATE_BY_STEP_KEY: Record<PipelineGateStepKey, PipelineGateId> = {
  "g5-portrait-confirm": "G5",
  "g6-prompt-confirm": "G6",
  "g7-preproduction": "G7",
  "g8-render-submit": "G8",
  /** deliver 步的 gate 字段在 yml 里就是 `G-DLV1`（变体雷同否决） */
  deliver: "G-DLV1",
  /** revise 步按 G-DLV4（层增量重合成 + 复用证据）记账 */
  revise: "G-DLV4"
};

export interface GateCheck {
  id: string;
  pass: boolean;
  detail: string;
  hard?: boolean;
}

export interface GateEvent {
  at: string;
  stage: "gate";
  /** 管线 step_key（白名单内） */
  stepKey: PipelineGateStepKey;
  gate: PipelineGateId;
  projectId: string;
  /** 放行判定（= 硬闸全过 且 软裁决通过/无软裁决） */
  ok: boolean;
  approved: boolean;
  via: "deterministic" | "llm" | "fallback";
  score: number | null;
  /** 触发该门的环节（portrait / prompt-review / keyframe / shot） */
  sourceStage: string | null;
  shotIds: string[];
  checks: GateCheck[];
  reason: string;
  degraded: boolean;
  evidence?: Record<string, unknown>;
}

export function gateForStepKey(stepKey: string): PipelineGateId {
  if (!isPipelineGateStepKey(stepKey)) {
    throw new Error(`未知的门 step_key：${stepKey}（只认 ${PIPELINE_GATE_STEP_KEYS.join(" / ")}）`);
  }
  return GATE_BY_STEP_KEY[stepKey];
}

export function isPipelineGateStepKey(value: string): value is PipelineGateStepKey {
  return (PIPELINE_GATE_STEP_KEYS as readonly string[]).includes(value);
}

/**
 * 组装门事件（纯函数，便于单测）。
 * 硬闸（checks 里 hard=true）有一条不过 → ok/approved 强制 false，理由里写明是哪几条。
 */
export function buildGateEvent(input: {
  stepKey: PipelineGateStepKey;
  projectId: string;
  checks: GateCheck[];
  sourceStage?: string | null;
  shotIds?: string[];
  /** 软裁决（LLM/上游环节）的结论；缺省表示本门只做确定性判定 */
  softApproved?: boolean | null;
  via?: GateEvent["via"];
  score?: number | null;
  reason?: string;
  degraded?: boolean;
  evidence?: Record<string, unknown>;
  at?: string;
}): GateEvent {
  const hardFailures = input.checks.filter((c) => c.hard && !c.pass);
  const softFailures = input.checks.filter((c) => !c.hard && !c.pass);
  const softApproved = input.softApproved ?? null;
  const approved = hardFailures.length === 0 && softApproved !== false;
  const reason = input.reason
    ?? (hardFailures.length > 0
      ? `硬闸未通过（${hardFailures.map((c) => c.id).join("、")}）：${hardFailures.map((c) => c.detail).join("；")}`
      : softApproved === false
        ? `上游软裁决未通过：${softFailures.map((c) => c.detail).join("；") || "见 evidence"}`
        : `门通过（${input.checks.length} 项判据，硬闸 ${input.checks.filter((c) => c.hard).length} 条）`);
  return {
    at: input.at ?? new Date().toISOString(),
    stage: "gate",
    stepKey: input.stepKey,
    gate: gateForStepKey(input.stepKey),
    projectId: input.projectId,
    ok: approved,
    approved,
    via: input.via ?? (softApproved === null ? "deterministic" : "llm"),
    score: typeof input.score === "number" ? input.score : null,
    sourceStage: input.sourceStage ?? null,
    shotIds: input.shotIds ?? [],
    checks: input.checks,
    reason,
    degraded: Boolean(input.degraded),
    ...(input.evidence ? { evidence: input.evidence } : {})
  };
}

/** 追加到阶段日志（与阶段记录同一文件，审计器按 `stage === "gate"` 过滤） */
export function appendGateEvent(logPath: string, event: GateEvent): void {
  mkdirSync(dirname(logPath), { recursive: true });
  appendFileSync(logPath, `${JSON.stringify(event)}\n`, "utf8");
}

/** 从 stages.jsonl 的行里挑出门事件（平台/审计器共用；非门记录原样忽略） */
export function readGateEvents(lines: Array<Record<string, unknown>>): GateEvent[] {
  return lines.filter((line) => line.stage === "gate" && typeof line.stepKey === "string" && isPipelineGateStepKey(line.stepKey)) as unknown as GateEvent[];
}

/** 门账本摘要：按 step_key 给出最后一次裁决（审计报告用） */
export function summarizeGates(events: GateEvent[]): Array<{
  stepKey: PipelineGateStepKey; gate: PipelineGateId; approved: boolean; at: string; via: string; reason: string; shotIds: string[];
}> {
  const latest = new Map<PipelineGateStepKey, GateEvent>();
  for (const event of events) latest.set(event.stepKey, event);
  return PIPELINE_GATE_STEP_KEYS
    .filter((key) => latest.has(key))
    .map((key) => {
      const e = latest.get(key)!;
      return { stepKey: key, gate: e.gate, approved: e.approved, at: e.at, via: e.via, reason: e.reason, shotIds: e.shotIds };
    });
}
