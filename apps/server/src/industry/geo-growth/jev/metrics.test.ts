/**
 * 指标单测：准确率 / macro-F1 / ECE / 分位数 / 成本 / 报告聚合。
 */
import { describe, expect, it } from "vitest";
import { accuracyOf, buildReport, eceBinsOf, estimateCostUsd, macroF1Of, percentileOf } from "./metrics.js";
import type { RowOutcome } from "./types.js";

function row(partial: Partial<RowOutcome> = {}): RowOutcome {
  return {
    id: "r1",
    scene: "comment-classify",
    decision: "inquiry",
    decisionZh: "咨询问询",
    confidence: 0.9,
    confidenceDerived: false,
    route: "auto",
    reasons: [],
    latencyMs: 100,
    inputTokens: 1000,
    outputTokens: 0,
    details: {},
    ...partial,
  };
}

describe("指标口径", () => {
  it("accuracy 只统计带标签的行；无标签返回 null", () => {
    expect(accuracyOf([row({ correct: true }), row({ correct: false }), row()])).toBeCloseTo(0.5);
    expect(accuracyOf([row(), row()])).toBeNull();
  });

  it("macro-F1：全对为 1，全错为 0", () => {
    const perfect = [row({ expected: "inquiry", decision: "inquiry" }), row({ expected: "spam", decision: "spam" })];
    expect(macroF1Of(perfect)).toBeCloseTo(1);
    const wrong = [row({ expected: "inquiry", decision: "spam" }), row({ expected: "spam", decision: "inquiry" })];
    expect(macroF1Of(wrong)).toBeCloseTo(0);
  });

  it("ECE：置信度 0.9、实际 50% → 0.4", () => {
    const { ece } = eceBinsOf([row({ confidence: 0.9, correct: true }), row({ confidence: 0.9, correct: false })]);
    expect(ece).toBeCloseTo(0.4, 6);
  });

  it("分位数按最近秩口径", () => {
    expect(percentileOf([40, 10, 30, 20], 50)).toBe(20);
    expect(percentileOf([40, 10, 30, 20], 95)).toBe(40);
    expect(percentileOf([], 50)).toBe(0);
  });

  it("成本按 $0.042/1M 输入 token、输出免费", () => {
    expect(estimateCostUsd(1_000_000)).toBeCloseTo(0.042, 10);
    expect(estimateCostUsd(1_000)).toBeCloseTo(0.000042, 10);
  });

  it("报告聚合：路由分布、成本、延迟、失败清单", () => {
    const outcomes = [
      row({ id: "a", correct: true, route: "auto", latencyMs: 100, inputTokens: 500 }),
      row({ id: "b", correct: false, route: "review", latencyMs: 300, inputTokens: 500 }),
      row({ id: "c", route: "human", latencyMs: 200, inputTokens: 500 }),
      row({ id: "d", error: "[rate_limited] 429", route: "human", latencyMs: 0, inputTokens: 0 }),
    ];
    const report = buildReport({
      scene: "comment-classify",
      sceneVersion: "1.0.0",
      provider: "typesafe",
      model: "typesafe-ai/jev",
      responseModels: ["jev-1.13.0"],
      baseUrlHost: "127.0.0.1",
      startedAt: "2026-09-19T00:00:00.000Z",
      durationMs: 1000,
      outcomes,
    });
    expect(report.total).toBe(4);
    expect(report.succeeded).toBe(3);
    expect(report.failed).toBe(1);
    expect(report.routes).toEqual({ auto: 1, review: 1, human: 1 });
    expect(report.autoRate).toBeCloseTo(1 / 3);
    expect(report.costUsd).toBeCloseTo(1500 * (0.042 / 1_000_000), 10);
    expect(report.latency.p95).toBe(300);
    expect(report.errors).toEqual([{ id: "d", error: "[rate_limited] 429" }]);
    expect(report.provider).toBe("typesafe");
    expect(report.responseModels).toEqual(["jev-1.13.0"]);
  });
});
