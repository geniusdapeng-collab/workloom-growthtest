/**
 * 分流策略单测：阈值、派生置信度禁用自动、场景硬规则、shadow 恒真。
 */
import { describe, expect, it } from "vitest";
import { gateDecision } from "./gating.js";
import type { SceneDecision } from "./types.js";

function decision(partial: Partial<SceneDecision> = {}): SceneDecision {
  return {
    decision: "inquiry",
    decisionZh: "咨询问询",
    confidence: 0.95,
    confidenceDerived: false,
    details: {},
    ...partial,
  };
}

describe("gateDecision", () => {
  it("评论初筛：高置信且非派生 → auto（影子档）", () => {
    const gate = gateDecision("comment-classify", decision());
    expect(gate.route).toBe("auto");
    expect(gate.shadow).toBe(true);
  });

  it("派生置信度永不允许自动", () => {
    const gate = gateDecision("comment-classify", decision({ confidenceDerived: true, confidence: 0.99 }));
    expect(gate.route).toBe("review");
    expect(gate.reasons.join(" ")).toContain("派生");
  });

  it("评论初筛命中 needs_human → 直接转人工", () => {
    const gate = gateDecision("comment-classify", decision({ details: { needs_human: 0.95 } }));
    expect(gate.route).toBe("human");
  });

  it("线索分级：autoAt=0.93，0.9 落人审队列", () => {
    expect(gateDecision("lead-qualify", decision({ confidence: 0.95 })).route).toBe("auto");
    expect(gateDecision("lead-qualify", decision({ confidence: 0.9 })).route).toBe("review");
    expect(gateDecision("lead-qualify", decision({ confidence: 0.5 })).route).toBe("human");
  });

  it("线索分级：档位贴边界（ambiguous=1）即使置信度很高也进人审队列", () => {
    const gate = gateDecision(
      "lead-qualify",
      decision({ confidence: 0.99, details: { ambiguous: 1, level_gap: 0.01 } }),
    );
    expect(gate.route).toBe("review");
    expect(gate.reasons.join(" ")).toContain("贴边界");
  });

  it("事实预检：非 pass 结论必须人工，pass 也只能到人审队列", () => {
    expect(gateDecision("fact-precheck", decision({ decision: "risk" })).route).toBe("human");
    expect(gateDecision("fact-precheck", decision({ decision: "unsupported" })).route).toBe("human");
    expect(gateDecision("fact-precheck", decision({ decision: "pass", confidence: 0.99 })).route).toBe("review");
  });

  it("任何场景都不授予写权限（shadow 恒真）", () => {
    for (const scene of ["comment-classify", "lead-qualify", "fact-precheck"] as const) {
      expect(gateDecision(scene, decision()).shadow).toBe(true);
    }
  });
});
