/**
 * 影子评估指标（纯函数，可单测）
 *
 * 口径说明：
 *   - accuracy / macroF1 只统计带 expected 的行；
 *   - ECE（期望校准误差）按 10 桶：|平均置信度 − 实际准确率| 的样本加权和；
 *   - 成本按 Jev 现行价目：$0.042 / 1M 输入 token，输出免费（docs.typesafe.ai/models）；
 *   - 延迟为端到端（含网关网络），取 p50/p95/max。
 */
import type { JevProvider, RowOutcome, Route, ShadowReport } from "./types.js";

export const JEV_INPUT_USD_PER_TOKEN = 0.042 / 1_000_000;

export function accuracyOf(outcomes: readonly RowOutcome[]): number | null {
  const labeled = outcomes.filter((row) => row.correct !== undefined);
  if (labeled.length === 0) return null;
  const hits = labeled.filter((row) => row.correct === true).length;
  return hits / labeled.length;
}

/** 多分类 macro-F1：标签集合 = 期望与预测的并集（避免只出现在预测里的类被漏算） */
export function macroF1Of(outcomes: readonly RowOutcome[]): number | null {
  const labeled = outcomes.filter((row) => row.expected !== undefined);
  if (labeled.length === 0) return null;
  const labels = new Set<string>();
  for (const row of labeled) {
    if (row.expected) labels.add(row.expected);
    labels.add(row.decision);
  }
  const f1s: number[] = [];
  for (const label of labels) {
    let tp = 0;
    let fp = 0;
    let fn = 0;
    for (const row of labeled) {
      const predicted = row.decision === label;
      const actual = row.expected === label;
      if (predicted && actual) tp += 1;
      else if (predicted && !actual) fp += 1;
      else if (!predicted && actual) fn += 1;
    }
    const precision = tp + fp === 0 ? 0 : tp / (tp + fp);
    const recall = tp + fn === 0 ? 0 : tp / (tp + fn);
    const f1 = precision + recall === 0 ? 0 : (2 * precision * recall) / (precision + recall);
    f1s.push(f1);
  }
  return f1s.reduce((sum, value) => sum + value, 0) / f1s.length;
}

export interface EceBin {
  lo: number;
  hi: number;
  n: number;
  avgConfidence: number | null;
  accuracy: number | null;
}

export function eceBinsOf(outcomes: readonly RowOutcome[], binCount = 10): { ece: number | null; bins: EceBin[] } {
  const labeled = outcomes.filter((row) => row.correct !== undefined);
  const bins: EceBin[] = [];
  for (let index = 0; index < binCount; index += 1) {
    const lo = index / binCount;
    const hi = (index + 1) / binCount;
    bins.push({ lo, hi, n: 0, avgConfidence: null, accuracy: null });
  }
  if (labeled.length === 0) return { ece: null, bins };
  for (const row of labeled) {
    const confidence = Math.min(1, Math.max(0, row.confidence));
    const index = Math.min(binCount - 1, Math.floor(confidence * binCount));
    const bin = bins[index];
    if (!bin) continue;
    bin.n += 1;
    const confidenceSum = (bin.avgConfidence ?? 0) * (bin.n - 1) + confidence;
    const hitSum = (bin.accuracy ?? 0) * (bin.n - 1) + (row.correct ? 1 : 0);
    bin.avgConfidence = confidenceSum / bin.n;
    bin.accuracy = hitSum / bin.n;
  }
  let ece = 0;
  for (const bin of bins) {
    if (bin.n === 0 || bin.avgConfidence === null || bin.accuracy === null) continue;
    ece += (bin.n / labeled.length) * Math.abs(bin.avgConfidence - bin.accuracy);
  }
  return { ece, bins };
}

export function percentileOf(values: readonly number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[rank] ?? 0;
}

export function estimateCostUsd(inputTokens: number): number {
  return inputTokens * JEV_INPUT_USD_PER_TOKEN;
}

export interface ReportInput {
  scene: ShadowReport["scene"];
  sceneVersion: string;
  provider: JevProvider;
  model: string;
  /** 各次响应自报的模型 id（去重排序）；空数组=响应未带 model 字段 */
  responseModels: readonly string[];
  baseUrlHost: string;
  startedAt: string;
  durationMs: number;
  outcomes: readonly RowOutcome[];
}

export function buildReport(input: ReportInput): ShadowReport {
  const succeeded = input.outcomes.filter((row) => row.error === undefined);
  const failed = input.outcomes.length - succeeded.length;
  const labeled = succeeded.filter((row) => row.correct !== undefined);
  const routes: Record<Route, number> = { auto: 0, review: 0, human: 0 };
  for (const row of succeeded) routes[row.route] += 1;
  const inputTokens = succeeded.reduce((sum, row) => sum + row.inputTokens, 0);
  const outputTokens = succeeded.reduce((sum, row) => sum + row.outputTokens, 0);
  const latencies = succeeded.map((row) => row.latencyMs);
  const { ece, bins } = eceBinsOf(succeeded);
  const expectedSet = new Set(labeled.map((row) => row.expected as string));
  const predictedSet = new Set(labeled.map((row) => row.decision));
  const isChoiceLike = expectedSet.size > 2 || predictedSet.size > 2;

  return {
    scene: input.scene,
    sceneVersion: input.sceneVersion,
    provider: input.provider,
    model: input.model,
    responseModels: [...input.responseModels],
    baseUrlHost: input.baseUrlHost,
    startedAt: input.startedAt,
    durationMs: input.durationMs,
    total: input.outcomes.length,
    succeeded: succeeded.length,
    failed,
    labeled: labeled.length,
    accuracy: accuracyOf(succeeded),
    macroF1: isChoiceLike ? macroF1Of(succeeded) : null,
    ece,
    eceBins: bins,
    costUsd: estimateCostUsd(inputTokens),
    inputTokens,
    outputTokens,
    latency: {
      p50: percentileOf(latencies, 50),
      p95: percentileOf(latencies, 95),
      max: latencies.length === 0 ? 0 : Math.max(...latencies),
    },
    routes,
    autoRate: succeeded.length === 0 ? 0 : routes.auto / succeeded.length,
    humanReviewRate: succeeded.length === 0 ? 0 : (routes.review + routes.human) / succeeded.length,
    errors: input.outcomes
      .filter((row) => row.error !== undefined)
      .map((row) => ({ id: row.id, error: row.error as string })),
  };
}
