import { describe, expect, it } from "vitest";
import { assessPortraitDecision, selectPortraitDecisionRecord } from "./portrait-decision.js";

describe("定妆照决策口径：人类验收是唯一放行/否决来源", () => {
  it("同一版本的明确人类否决不能被后来的机器记录或另一版本的放行覆盖", () => {
    const rejected = { stepKey: "g5-portrait-confirm", projectId: "portrait:actor:v2", via: "owner-acceptance", approved: false, evidence: { basis: "human-review" } };
    const records = [rejected, { stepKey: "g5-portrait-confirm", projectId: "portrait:actor:v2", via: "llm", approved: true },
      { stepKey: "g5-portrait-confirm", projectId: "portrait:actor:v3", via: "human", approved: true }];
    expect(selectPortraitDecisionRecord(records, "portrait:actor:v2")).toBe(rejected);
    expect(selectPortraitDecisionRecord(records, "portrait:other:v2")).toBeNull();
    expect(assessPortraitDecision(selectPortraitDecisionRecord(records, "portrait:actor:v2")).blocking).toBe(true);
  });
  it("后续同版本的明确人类放行可替代否决；机器意见始终只是留证", () => {
    const scope = { stepKey: "g5-portrait-confirm", projectId: "portrait:actor:v2" };
    const accepted = { ...scope, via: "human", approved: true };
    const records = [{ ...scope, via: "human", approved: false, evidence: { basis: "human-review" } }, accepted,
      { ...scope, via: "llm", approved: false }];
    expect(selectPortraitDecisionRecord(records, scope.projectId)).toBe(accepted);
    expect(assessPortraitDecision(selectPortraitDecisionRecord(records, scope.projectId)).blocking).toBe(false);
  });
  it("无记录：不构成放行依据，也不阻断（机器不代替人类签字）", () => {
    const decision = assessPortraitDecision(null);
    expect(decision).toMatchObject({ kind: "none", decisive: false, blocking: false });
    expect(decision.detail).toContain("不构成放行依据");
  });

  it("机器监制记录（含判不合格）只留证，永不阻断", () => {
    const rejected = assessPortraitDecision({ via: "llm", approved: false, score: 86, sourceStage: "portrait-review" });
    expect(rejected).toMatchObject({ kind: "machine", decisive: false, blocking: false });
    expect(rejected.detail).toContain("不参与放行");
    const approved = assessPortraitDecision({ via: "llm", approved: true, score: 92 });
    expect(approved).toMatchObject({ kind: "machine", decisive: false, blocking: false });
  });

  it("人类验收放行：决定性记录、不阻断", () => {
    const decision = assessPortraitDecision({
      via: "owner-acceptance",
      sourceStage: "owner-acceptance",
      approved: true,
      score: null,
      evidence: { basis: "human-review" },
    });
    expect(decision).toMatchObject({ kind: "human", decisive: true, blocking: false });
    expect(decision.detail).toContain("人类验收放行");
  });

  it("人类明确否决（带 human-review 依据）：决定性阻断", () => {
    const decision = assessPortraitDecision({
      via: "owner-acceptance",
      approved: false,
      evidence: { basis: "human-review" },
    });
    expect(decision).toMatchObject({ kind: "human", decisive: true, blocking: true });
    expect(decision.detail).toContain("明确否决");
  });

  it("旧版被机器判据带成 approved=false 的 owner-acceptance 记录按机器留证处理，不再误阻断", () => {
    const decision = assessPortraitDecision({ via: "owner-acceptance", approved: false, score: 12 });
    expect(decision).toMatchObject({ kind: "machine", decisive: false, blocking: false });
    expect(decision.detail).toContain("请用 portrait-agent accept 重新记录人类验收");
  });
});
