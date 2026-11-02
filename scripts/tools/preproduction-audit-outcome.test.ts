import { describe, expect, it } from "vitest";
import { finalizePreproductionAuditOutcome } from "./preproduction-audit-outcome.mjs";

const gates = ["G2_THEME", "G3_INSIGHT", "G4_PRD", "G5_PORTRAIT", "G6_PROMPT", "G7_FINAL"]
  .map((gate) => ({ gate, approved: true }));

const passingResult = () => ({
  success: false,
  stages: {
    pipelineGuard: { pass: true },
    renderingEngine: { skipped: true },
    requirementAlignment: { pass: true },
    productionEngine: {
      shots: [{ shotId: "S1" }, { shotId: "S2" }],
      prompts: [{ shotId: "S1" }, { shotId: "S2" }],
    },
    postProductionEngine: {
      success: false,
      stages: { quality: { issues: ["版本 standard: 视频文件不存在 (shot-S1.mp4)"] } },
    },
  },
});

describe("预生产审计 success 收口", () => {
  it("全部门禁、守卫、时长与对齐通过且渲染显式跳过时，只把预生产标为成功", () => {
    const output = passingResult();
    const result = finalizePreproductionAuditOutcome(output, gates, "narrative");
    expect(result).toMatchObject({ audited: true, reason: "preproduction-only-success" });
    expect(output.success).toBe(true);
    expect(output.preproductionAudit).toMatchObject({
      status: "passed",
      scope: "preproduction-only",
      renderSubmitted: false,
      deliveryStatus: "not_run",
      ignoredPostProductionFailure: true,
    });
    expect(output.deliveryStatus).toMatchObject({ status: "not_run", preproductionPassed: true });
  });

  it("真实门禁拒绝不能被后期跳过掩盖", () => {
    const output = passingResult();
    const rejected = gates.map((gate) => gate.gate === "G6_PROMPT" ? { ...gate, approved: false } : gate);
    const result = finalizePreproductionAuditOutcome(output, rejected, "narrative");
    expect(result.audited).toBe(false);
    expect(result.reason).toContain("missingApprovedGate:G6_PROMPT");
    expect(output.success).toBe(false);
  });

  it("渲染未跳过、守卫失败或镜头/提示词数量不一致都保持失败", () => {
    const variants = [
      { renderingEngine: { skipped: false } },
      { pipelineGuard: { pass: false } },
      { productionEngine: { shots: [{ shotId: "S1" }], prompts: [] } },
      { requirementAlignment: { pass: false } },
    ];
    for (const changes of variants) {
      const output = passingResult();
      Object.assign(output.stages, changes);
      const result = finalizePreproductionAuditOutcome(output, gates, "narrative");
      expect(result.audited).toBe(false);
      expect(output.success).toBe(false);
    }
  });

  it("营销路由仍要求 G1_DOSSIER", () => {
    const output = passingResult();
    const result = finalizePreproductionAuditOutcome(output, gates, "marketing");
    expect(result.audited).toBe(false);
    expect(result.reason).toContain("missingApprovedGate:G1_DOSSIER");
    expect(output.success).toBe(false);
  });
});
