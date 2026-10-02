/**
 * 场景规则单测：**标签由代码定，不由模型定**。
 *
 * 重点覆盖 fact-precheck 的三段式规则（红线优先 + 边界不翻标签）——它是在 2026-09-21 首次真机考卷
 * 暴露 2/4 误判后按真实输出校准的，这里把当时观察到的四组真实概率固化成回归用例。
 * 数值来源：真实 Jev 1.13 回答（`data/jev-shadow/real-20260921/fact-precheck/outcomes.jsonl`）。
 */
import { describe, expect, it } from "vitest";
import { LEAD_TIE_MARGIN, PRE_RISK_THRESHOLD, factPrecheckDecision, leadLevelDecision } from "./scenes.js";

describe("factPrecheckDecision（真实考卷回归）", () => {
  it("f-01 前提成立、表态抛硬币（0.52）→ pass，不因 0.5x 翻成风险", () => {
    expect(factPrecheckDecision({ premiseSupported: 0.83, inventedSpecifics: 0.14, brandStanceRisk: 0.52 }).decision).toBe(
      "pass",
    );
  });

  it("f-02 编造具体信息（0.92）+ 表态（0.95）→ risk（红线优先）", () => {
    expect(factPrecheckDecision({ premiseSupported: 0.02, inventedSpecifics: 0.92, brandStanceRisk: 0.95 }).decision).toBe(
      "risk",
    );
  });

  it("f-03 前提完全在口径外（0.03）、表态高（0.86）→ unsupported（操作员要修的是口径外事实）", () => {
    expect(factPrecheckDecision({ premiseSupported: 0.03, inventedSpecifics: 0.16, brandStanceRisk: 0.86 }).decision).toBe(
      "unsupported",
    );
  });

  it("f-04 前提成立、表态低于阈值（0.45）→ pass", () => {
    expect(factPrecheckDecision({ premiseSupported: 0.8, inventedSpecifics: 0.18, brandStanceRisk: 0.45 }).decision).toBe(
      "pass",
    );
  });
});

describe("factPrecheckDecision（边界）", () => {
  it("阈值本身算命中：invented = 0.6 → risk", () => {
    expect(
      factPrecheckDecision({ premiseSupported: 0.9, inventedSpecifics: PRE_RISK_THRESHOLD, brandStanceRisk: 0 }).decision,
    ).toBe("risk");
  });

  it("前提支撑 0.5 视为成立（< 0.5 才判 unsupported）", () => {
    expect(factPrecheckDecision({ premiseSupported: 0.5, inventedSpecifics: 0.1, brandStanceRisk: 0.1 }).decision).toBe(
      "pass",
    );
  });

  it("前提不成立时，即使表态分高也优先报 unsupported（除非编造≥阈值）", () => {
    expect(factPrecheckDecision({ premiseSupported: 0.49, inventedSpecifics: 0.1, brandStanceRisk: 0.99 }).decision).toBe(
      "unsupported",
    );
    expect(factPrecheckDecision({ premiseSupported: 0.49, inventedSpecifics: 0.61, brandStanceRisk: 0.99 }).decision).toBe(
      "risk",
    );
  });

  it("前提成立 + 表态达阈值 → risk", () => {
    expect(factPrecheckDecision({ premiseSupported: 0.9, inventedSpecifics: 0.1, brandStanceRisk: 0.61 }).decision).toBe(
      "risk",
    );
  });
});

describe("leadLevelDecision（真实考卷回归：按分布取档，不用四舍五入 score）", () => {
  it.each([
    ["l-01 高意向", { "0": 0, "1": 0, "2": 1 }, 2, 1],
    ["l-02 中意向", { "0": 0, "1": 0.99, "2": 0.01 }, 1, 0.98],
    ["l-03 平票（0.5/0.5）取低档", { "0": 0.5, "1": 0.5, "2": 0 }, 0, 0],
    ["l-04 高意向", { "0": 0, "1": 0, "2": 1 }, 2, 1],
    ["l-05 中意向", { "0": 0.01, "1": 0.99, "2": 0 }, 1, 0.98],
    ["l-06 低意向", { "0": 0.87, "1": 0.13, "2": 0 }, 0, 0.74],
  ])("%s：档位 %i、最高/次高差 %.2f", (_label, probabilities, level, gap) => {
    const result = leadLevelDecision(probabilities as Record<string, number>, 3);
    expect(result.level).toBe(level);
    expect(result.gap).toBeCloseTo(gap, 2);
  });

  it("平票与贴边界都标记 ambiguous（真机实测 l-03 gap=0）", () => {
    expect(leadLevelDecision({ "0": 0.5, "1": 0.5, "2": 0 }, 3).ambiguous).toBe(true);
    expect(leadLevelDecision({ "0": 0, "1": 0.55, "2": 0.45 }, 3).ambiguous).toBe(true);
    expect(leadLevelDecision({ "0": 0, "1": 0.61, "2": 0.39 }, 3).ambiguous).toBe(false);
  });

  it("阈值边界：gap 恰等于 LEAD_TIE_MARGIN 仍算贴边界", () => {
    const probabilities = { "0": 0, "1": 0.5 + LEAD_TIE_MARGIN / 2, "2": 0.5 - LEAD_TIE_MARGIN / 2 };
    expect(leadLevelDecision(probabilities, 3).ambiguous).toBe(true);
  });

  it("缺概率表时保守兜底：低档 + ambiguous（不允许静默给高意向）", () => {
    const result = leadLevelDecision({}, 3);
    expect(result.level).toBe(0);
    expect(result.ambiguous).toBe(true);
  });
});
