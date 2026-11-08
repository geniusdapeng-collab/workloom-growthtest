import {
  buildPromptRepairPlan,
  compilePromptArtifact,
  derivePromptFindings,
  normalizePromptRepairRows,
  promptFindingIsBlocking,
  promptRepairFeedback,
  promptRepairFindingKeys,
  promptRepairMadeProgress,
  promptRowCheckpoint,
  type PromptFinding,
  type PromptArtifact,
  type PromptRepairContext,
  type PromptRepairPlan,
  type PromptRepairRow,
} from "@hyperreality/video-studio";

export interface PromptRepairRound {
  plan: PromptRepairPlan;
  context: PromptRepairContext;
  feedback: string;
  rowCheckpoints: ReturnType<typeof promptRowCheckpoint>[];
  targetShotIds: string[];
  artifacts: PromptArtifact[];
}

export type PreparePromptRepairResult =
  | { ok: true; round: PromptRepairRound }
  | {
      ok: false;
      code:
        | "PROMPT_REPAIR_DISABLED"
        | "PROMPT_REPAIR_NOT_REQUIRED"
        | "PROMPT_REPAIR_BLOCKED"
        | "PROMPT_FINDING_UNBOUND"
        | "PROMPT_REPAIR_ROWS_UNAVAILABLE";
      reason: string;
    };

export class PromptTextCallBudget {
  private readonly calls: Array<{ sequence: number; stage: string; at: string }> = [];
  private exhausted = false;

  constructor(readonly maxTextCalls: number) {
    if (!Number.isSafeInteger(maxTextCalls) || maxTextCalls < 1 || maxTextCalls > 200) {
      throw new Error("PROMPT_REPAIR_BUDGET_INVALID: 文字调用上限必须是 1–200 的整数");
    }
  }

  reserve(stage: string): void {
    if (this.calls.length >= this.maxTextCalls) {
      this.exhausted = true;
      const error = new Error(`PROMPT_REPAIR_BUDGET_EXHAUSTED: 已达到 ${this.maxTextCalls} 次文字调用上限`);
      Object.assign(error, { code: "PROMPT_REPAIR_BUDGET_EXHAUSTED" });
      throw error;
    }
    this.calls.push({
      sequence: this.calls.length + 1,
      stage: stage.trim().slice(0, 80) || "unknown",
      at: new Date().toISOString(),
    });
  }

  snapshot(): {
    maxTextCalls: number;
    usedTextCalls: number;
    remainingTextCalls: number;
    exhausted: boolean;
    calls: Array<{ sequence: number; stage: string; at: string }>;
  } {
    return {
      maxTextCalls: this.maxTextCalls,
      usedTextCalls: this.calls.length,
      remainingTextCalls: Math.max(0, this.maxTextCalls - this.calls.length),
      exhausted: this.exhausted,
      calls: structuredClone(this.calls),
    };
  }
}

export function isPromptRepairBudgetExhausted(error: unknown): boolean {
  return error instanceof Error
    && (error as Error & { code?: unknown }).code === "PROMPT_REPAIR_BUDGET_EXHAUSTED"
    && error.message.startsWith("PROMPT_REPAIR_BUDGET_EXHAUSTED");
}

export function promptRowsFromVendorResult(result: unknown): PromptRepairRow[] {
  if (!result || typeof result !== "object" || Array.isArray(result)) return [];
  const stages = (result as { stages?: unknown }).stages;
  if (!stages || typeof stages !== "object" || Array.isArray(stages)) return [];
  const production = (stages as Record<string, unknown>).productionEngine;
  if (!production || typeof production !== "object" || Array.isArray(production)) return [];
  const rows = (production as Record<string, unknown>).shots;
  if (!Array.isArray(rows)) return [];
  try {
    return normalizePromptRepairRows(rows);
  } catch {
    // Historical/synthetic reports may contain prompt-only snapshots. They are
    // not eligible for row repair, but they must not turn a successful run into
    // a failure merely because snapshotting was attempted.
    return [];
  }
}

export function promptRepairFindings(input: {
  findings?: readonly PromptFinding[];
  issues?: readonly unknown[];
  suggestions?: readonly unknown[];
  reason?: unknown;
}): PromptFinding[] {
  const supplied = (input.findings ?? []).filter(promptFindingIsBlocking);
  return supplied.length > 0
    ? supplied
    : derivePromptFindings(input.issues ?? [], input.suggestions ?? [], input.reason).filter(promptFindingIsBlocking);
}

export function preparePromptRepairRound(input: {
  projectId: string;
  revision: number;
  round: number;
  enabled: boolean;
  rows: readonly PromptRepairRow[];
  findings: readonly PromptFinding[];
  policyVersion: string;
  maxRepairRounds?: number;
  maxTextCalls?: number;
  maxTextCallsPerShot?: number;
  rawIntent?: string;
  metadata?: Record<string, unknown>;
  targetSeconds?: number;
  now?: string;
}): PreparePromptRepairResult {
  if (!input.enabled) {
    return { ok: false, code: "PROMPT_REPAIR_DISABLED", reason: "PROMPT_REPAIR_ENABLED=0" };
  }
  if (!input.rows.length) {
    return { ok: false, code: "PROMPT_REPAIR_ROWS_UNAVAILABLE", reason: "没有可用于局部修复的原生镜头行" };
  }
  const built = buildPromptRepairPlan({
    projectId: input.projectId,
    revision: input.revision,
    round: input.round,
    rows: input.rows,
    findings: input.findings,
    maxRepairRounds: input.maxRepairRounds,
    maxTextCalls: input.maxTextCalls,
    maxTextCallsPerShot: input.maxTextCallsPerShot,
    rawIntent: input.rawIntent,
    metadata: input.metadata,
    targetSeconds: input.targetSeconds,
    now: input.now,
  });
  if (!built.ok) return built;
  const targetSet = new Set(built.context.targetShotIds);
  const targetRows = built.context.rows.filter(row => targetSet.has(row.shotId));
  const rowCheckpoints = built.context.rows
    .filter(row => targetSet.has(row.shotId))
    .map((row, index, targets) => promptRowCheckpoint(row, {
      projectId: input.projectId,
      revision: input.revision,
      policyVersion: input.policyVersion,
      dependencyShotIds: [targets[index - 1]?.shotId, targets[index + 1]?.shotId]
        .filter((id): id is string => Boolean(id)),
      status: "rejected",
      now: input.now,
    }));
  const artifacts = built.plan.shotPlans.map(plan => {
    const row = targetRows.find(item => item.shotId === plan.shotId);
    if (!row) throw new Error(`PROMPT_SHOT_PLAN_UNBOUND: ${plan.shotId}`);
    return compilePromptArtifact(plan, row);
  });
  return {
    ok: true,
    round: {
      plan: built.plan,
      context: built.context,
      feedback: promptRepairFeedback(built.plan),
      rowCheckpoints,
      targetShotIds: built.context.targetShotIds,
      artifacts,
    },
  };
}
export function promptRepairProgressAfterRound(input: {
  priorPlan: PromptRepairPlan;
  priorRows: readonly PromptRepairRow[];
  nextFindings: readonly PromptFinding[];
  nextRows: readonly PromptRepairRow[];
}): { progress: boolean; priorFindingKeys: string[]; nextFindingKeys: string[] } {
  const priorFindingKeys = promptRepairFindingKeys(input.priorPlan.findings);
  const nextFindingKeys = promptRepairFindingKeys(input.nextFindings);
  return {
    priorFindingKeys,
    nextFindingKeys,
    progress: promptRepairMadeProgress({
      priorFindingKeys,
      nextFindingKeys,
      priorRows: input.priorRows,
      nextRows: input.nextRows,
      targetShotIds: input.priorPlan.targets.map(target => target.shotId),
    }),
  };
}
