/**
 * 影子评估执行器：数据集（JSONL）→ Jev 决策 → 分流建议 → 报告
 *
 * 影子铁律（对应系统不变量「演示与真实分明」「无回执不算完成」）：
 *   - 本执行器**不写业务库、不发外发通道、不改任何事件**；只产出报告文件（显式 --out 目录）；
 *   - 每行数据独立评估，失败行如实记账（不重试到成功、不用兜底答案冒充结果）；
 *   - 成本熔断：估算成本超过 --max-cost-usd 即停止调度新行，剩余行记为预算超限。
 */
import { JevError, type JevClient } from "./client.js";
import { gateDecision } from "./gating.js";
import { buildReport, estimateCostUsd } from "./metrics.js";
import type { RowOutcome, Scene, ShadowReport, ShadowRow } from "./types.js";

export interface ShadowOptions {
  rows: readonly ShadowRow[];
  scene: Scene;
  client: Pick<JevClient, "evaluate" | "modelId" | "providerId" | "host">;
  concurrency?: number;
  maxCostUsd?: number;
  captureRaw?: boolean;
  onProgress?: (done: number, total: number, outcome: RowOutcome) => void;
}

export interface ShadowRunResult {
  outcomes: RowOutcome[];
  report: ShadowReport;
  raws: Record<string, unknown>;
}

function errorOutcome(row: ShadowRow, scene: Scene, message: string): RowOutcome {
  return {
    id: row.id,
    scene: scene.key,
    decision: "error",
    decisionZh: "执行失败",
    confidence: 0,
    confidenceDerived: true,
    route: "human",
    reasons: [message],
    latencyMs: 0,
    inputTokens: 0,
    outputTokens: 0,
    ...(row.expected !== undefined ? { expected: row.expected } : {}),
    details: {},
    error: message,
  };
}

export async function runShadow(options: ShadowOptions): Promise<ShadowRunResult> {
  const { rows, scene, client } = options;
  const concurrency = Math.max(1, options.concurrency ?? 4);
  const maxCostUsd = options.maxCostUsd ?? 1;
  const startedAt = new Date().toISOString();
  const startedMs = Date.now();
  const outcomes: RowOutcome[] = new Array<RowOutcome>(rows.length);
  const raws: Record<string, unknown> = {};
  const responseModels = new Set<string>();
  let cursor = 0;
  let inputTokens = 0;
  let done = 0;
  let budgetExceeded = false;

  const evaluateRow = async (row: ShadowRow): Promise<RowOutcome> => {
    let request;
    try {
      request = scene.build({ text: row.text, context: row.context, officialClaims: row.officialClaims });
    } catch (error) {
      return errorOutcome(row, scene, error instanceof Error ? error.message : String(error));
    }
    try {
      const result = await client.evaluate(request);
      inputTokens += result.inputTokens;
      if (result.model) responseModels.add(result.model);
      if (options.captureRaw) raws[row.id] = result.raw;
      const decision = scene.decide(result);
      const gate = gateDecision(scene.key, decision);
      return {
        id: row.id,
        scene: scene.key,
        decision: decision.decision,
        decisionZh: decision.decisionZh,
        confidence: decision.confidence,
        confidenceDerived: decision.confidenceDerived,
        route: gate.route,
        reasons: gate.reasons,
        latencyMs: result.latencyMs,
        inputTokens: result.inputTokens,
        outputTokens: result.outputTokens,
        ...(row.expected !== undefined
          ? { expected: row.expected, correct: row.expected === decision.decision }
          : {}),
        details: decision.details,
      };
    } catch (error) {
      const message =
        error instanceof JevError ? `[${error.code}] ${error.message}` : error instanceof Error ? error.message : String(error);
      return errorOutcome(row, scene, message);
    }
  };

  const worker = async (): Promise<void> => {
    for (;;) {
      const index = cursor;
      cursor += 1;
      if (index >= rows.length) return;
      const row = rows[index];
      if (!row) return;
      if (budgetExceeded || estimateCostUsd(inputTokens) >= maxCostUsd) {
        budgetExceeded = true;
        outcomes[index] = errorOutcome(row, scene, `成本预算超限（max_cost_usd=${maxCostUsd}）`);
      } else {
        outcomes[index] = await evaluateRow(row);
      }
      done += 1;
      options.onProgress?.(done, rows.length, outcomes[index] as RowOutcome);
    }
  };

  await Promise.all(Array.from({ length: Math.min(concurrency, rows.length) }, () => worker()));

  const finalOutcomes = outcomes.filter((row): row is RowOutcome => row !== undefined);
  const report = buildReport({
    scene: scene.key,
    sceneVersion: scene.version,
    provider: client.providerId,
    model: client.modelId,
    responseModels: [...responseModels].sort(),
    baseUrlHost: client.host,
    startedAt,
    durationMs: Date.now() - startedMs,
    outcomes: finalOutcomes,
  });
  return { outcomes: finalOutcomes, report, raws };
}
