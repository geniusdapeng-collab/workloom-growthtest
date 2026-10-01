import { describe, expect, it } from "vitest";
import { assessLikenessBatch } from "./likeness-policy.js";

describe("机器像不像结果的处置口径", () => {
  const ok = { angle: "front", ok: true, score: 91 };
  const bad = { angle: "side", ok: false, score: 15, reason: "疑似不一致" };

  it("全部通过：不阻断", () => {
    const decision = assessLikenessBatch([ok], {});
    expect(decision.blocking).toBe(false);
    expect(decision.failed).toHaveLength(0);
  });

  it("默认只留证：有失败角度也不阻断（决策交人类）", () => {
    const decision = assessLikenessBatch([ok, bad], {});
    expect(decision.blocking).toBe(false);
    expect(decision.failed).toHaveLength(1);
    expect(decision.summary).toContain("只留证、不阻断");
  });

  it("显式 --require-likeness 才整批拒绝", () => {
    const decision = assessLikenessBatch([ok, bad], { requireLikeness: true });
    expect(decision.blocking).toBe(true);
    expect(decision.summary).toContain("整批拒绝");
  });
});
