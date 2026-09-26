/**
 * gate-ledger-bridge —— 平台侧（apps/server）按 **step_key** 落门账本（2026-09-25）。
 *
 * 背景：CLI 运行时（`scripts/tools/full-chain-film.mts`）已经按 `g5/g6/g7/g8` 记账，
 * 但平台侧（vendor 引擎回调 `onApproval`）只写"门动作事件"，paylaod 里没有 step_key——
 * 于是同一支片子在两条执行路径下的门记录形状不一致，平台无法与管线 yml 的 step_key 对齐。
 *
 * 本模块把平台门**映射成同一套门事件**（复用 `packages/video-studio/src/gate-ledger.ts` 的 `buildGateEvent`），
 * 供 `studio-worker` 在写事件时把 `stepKey` / `gate` / 判据一并落账。
 * 纪律：未知门返回 `null`（不猜、不静默映射），调用方按"没有 step_key"如实记录。
 */
import { buildGateEvent, type GateEvent, type PipelineGateStepKey } from "@hyperreality/video-studio";
import type { GateKey } from "@hyperreality/video-studio";

/** 平台门 → 管线 step_key（只有能一一对应的才映射；G8 渲染提交在平台属高风险人审，暂不映射） */
export const SERVER_GATE_STEP_KEY: Partial<Record<GateKey, PipelineGateStepKey>> = {
  /**
   * 【T-2026-0926-0117】营销片前置门补齐：vendor 的 dossier/theme/requirement/prd 确认单
   * 在营销片链路里就是 G1–G4，此前只映射了 G5/G6/G7 → 营销片这四个门在门账本里没有记录。
   * 现在按 marketing-film.yml 的 step_key 原样对齐（不改管线拓扑、不改门级别）。
   */
  G1_DOSSIER: "g1-dossier-confirm",
  G2_THEME: "g2-theme-confirm",
  G3_INSIGHT: "g3-insight-confirm",
  G4_PRD: "g4-prd-confirm",
  G5_PORTRAIT: "g5-portrait-confirm",
  G6_PROMPT: "g6-prompt-confirm",
  G7_FINAL: "g7-preproduction"
};

/**
 * 不映射的门（如实登记，避免"看起来都对齐了"的错觉）：
 *   · `g8-render-submit`：平台侧属高风险人审，平台只报门处置结果，与 CLI 的分项提交判据不同构；
 *   · `material-generate`（G-MAT1，2026-09-25 素材用途门）：**平台侧暂无对应 vendor 门**——
 *     素材镜的"用途声明 + 生成溯源 + 非静态直出"三条判据只在 CLI 管线（`full-chain-film.mts`）里可执行，
 *     平台管线要走这条路必须先补 vendor 门类型；在那之前**不猜映射**（宁可缺，不要假对齐）。
 */
export const UNMAPPED_PIPELINE_GATES: PipelineGateStepKey[] = ["g8-render-submit", "material-generate"];

export interface ServerGateVerdictLike {
  approved?: boolean;
  score?: number | null;
  via?: string;
  degraded?: boolean;
  reason?: string;
  issues?: string[];
  suggestions?: string[];
  model?: string | null;
}

export interface ServerGateRecord {
  stepKey: PipelineGateStepKey;
  gate: GateEvent["gate"];
  event: GateEvent;
}

/**
 * 组装平台门事件（纯函数，便于单测）。
 *
 * 判据口径：平台侧拿到的是 vendor 的"门内容 + 监制裁决"，没有 CLI 那样的分项确定性检查，
 * 因此 checks 只放一条**代理判据**（裁决来源 + 分数），其余证据放 evidence，
 * 不用"看起来像检查"的假条目凑数。
 */
export function buildServerGateRecord(input: {
  gate: GateKey;
  vendorType: string;
  projectId: string;
  runId: string;
  approved: boolean;
  verdict?: ServerGateVerdictLike | null;
  producerMode?: string;
  at?: string;
}): ServerGateRecord | null {
  const stepKey = SERVER_GATE_STEP_KEY[input.gate];
  if (!stepKey) return null;
  const verdict = input.verdict ?? null;
  const event = buildGateEvent({
    stepKey,
    projectId: input.projectId,
    sourceStage: "apps/server:onApproval",
    shotIds: [],
    checks: [{
      id: "producer-verdict",
      pass: input.approved,
      hard: true,
      detail: verdict
        ? `平台监制裁决：${input.approved ? "放行" : "打回"}（via=${verdict.via ?? "?"}，score=${verdict.score ?? "?"}）`
        : `平台门处置：producerMode=${input.producerMode ?? "review"}（${input.approved ? "放行" : "打回"}）`
    }],
    softApproved: verdict ? input.approved : null,
    via: (verdict?.via === "llm" ? "llm" : verdict?.via === "fallback" ? "fallback" : "deterministic"),
    score: typeof verdict?.score === "number" ? verdict.score : null,
    degraded: Boolean(verdict?.degraded),
    reason: verdict?.reason ?? (input.approved ? "平台门放行" : "平台门打回"),
    evidence: {
      platformGate: input.gate,
      vendorType: input.vendorType,
      runId: input.runId,
      producerMode: input.producerMode ?? "review",
      model: verdict?.model ?? null,
      issues: verdict?.issues?.slice(0, 5) ?? [],
      suggestions: verdict?.suggestions?.slice(0, 5) ?? []
    },
    at: input.at
  });
  return { stepKey, gate: event.gate, event };
}

/**
 * 把门账本字段并进门事件的 payload（不改动原有字段：平台既有消费者不受影响）。
 * 返回新对象，便于单测断言"原对象未被就地修改"。
 */
export function withGateLedger<T extends Record<string, unknown>>(payload: T, record: ServerGateRecord | null): T & { stepKey?: string; gateEvent?: GateEvent } {
  if (!record) return { ...payload };
  return { ...payload, stepKey: record.stepKey, gateEvent: record.event };
}
