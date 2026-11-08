import { describe, expect, it } from "vitest";
import {
  derivePromptFindings,
  normalizePromptFinding,
  promptFindingKey,
  promptFindingToGateFinding,
} from "./prompt-finding.js";
import {
  buildPromptRepairPlan,
  promptRepairFeedback,
  promptRepairMadeProgress,
  promptRowCheckpoint,
  validatePromptRepairContext,
} from "./prompt-repair-plan.js";

const rows = [
  { shotId: "S1", prompt: "一", fields: { action: "建立环境" }, duration: 5 },
  { shotId: "S2", prompt: "二", fields: { action: "拿起器物" }, duration: 5 },
  { shotId: "S3", prompt: "三", fields: { action: "放稳器物" }, duration: 5 },
];

describe("structured prompt findings", () => {
  it("normalizes a model finding without changing the 25-field shot contract", () => {
    const finding = normalizePromptFinding({
      code: "REQUIRED_ACTION_OMITTED",
      severity: "blocking",
      shotId: "S2",
      fieldPath: "fields.action",
      expected: "拿起器物",
      actual: "只有环境",
      issue: "必需动作被省略",
      suggestion: "按原合同补回动作",
      evidenceRefs: ["user-contract"],
      repairClass: "semantic",
    })!;
    expect(finding).toMatchObject({
      shotId: "S2",
      fieldPath: "fields.action",
      repairClass: "semantic",
      severity: "blocking",
    });
    expect(promptFindingToGateFinding(finding)).toMatchObject({
      targetType: "field",
      targetId: "S2",
      repairClass: "semantic",
      blocking: true,
    });
  });

  it("derives shot and field from legacy natural-language issues", () => {
    const [finding] = derivePromptFindings(["S4 的运镜与动作不连续"], ["补真实动机"]);
    expect(finding).toMatchObject({
      shotId: "S4",
      fieldPath: "fields.camera_movement",
      suggestion: "补真实动机",
      repairClass: "semantic",
    });
  });
});

describe("prompt repair plans", () => {
  const finding = normalizePromptFinding({
    code: "REQUIRED_ACTION_OMITTED",
    severity: "blocking",
    shotId: "S2",
    fieldPath: "fields.action",
    issue: "S2 缺少拿起动作",
    suggestion: "只修 S2",
    repairClass: "semantic",
  })!;

  it("targets only the shot named by blocking findings", () => {
    const result = buildPromptRepairPlan({
      projectId: "VID-1", revision: 2, round: 1, rows, findings: [finding], maxRepairRounds: 2, maxTextCalls: 8,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.plan.targets).toEqual([{
      shotId: "S2",
      fields: ["fields.action"],
      currentRowSha256: expect.stringMatching(/^[a-f0-9]{64}$/u),
      neighborShotIds: ["S1", "S3"],
    }]);
    expect(result.context.targetAll).toBe(false);
    expect(JSON.parse(promptRepairFeedback(result.plan))).toMatchObject({
      planHash: result.plan.planHash,
      repairClass: "semantic",
      repairClasses: ["semantic"],
      targets: [{ shotId: "S2" }],
      budget: { maxTextCallsPerShot: 8 },
    });
  });

  it("keeps all mixed repair-class instructions and the per-shot hard cap", () => {
    const evidence = normalizePromptFinding({
      code: "UNSUPPORTED_PRICE", severity: "blocking", shotId: "S2", issue: "价格无来源", repairClass: "evidence",
    })!;
    const semantic = normalizePromptFinding({
      code: "ACTION_ORDER", severity: "blocking", shotId: "S2", issue: "动作顺序错误", repairClass: "semantic",
    })!;
    const result = buildPromptRepairPlan({
      projectId: "VID-1", revision: 2, round: 1, rows, findings: [evidence, semantic],
      maxTextCalls: 6, maxTextCallsPerShot: 3,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const feedback = JSON.parse(promptRepairFeedback(result.plan)) as { instruction: string; repairClasses: string[] };
    expect(feedback.repairClasses).toEqual(expect.arrayContaining(["evidence", "semantic"]));
    expect(feedback.instruction).toContain("不得自行补来源");
    expect(feedback.instruction).toContain("动作顺序");
    expect(result.plan.budget).toEqual({ maxRepairRounds: 2, maxTextCalls: 6, maxTextCallsPerShot: 3 });
  });

  it("preserves the exact 25 field keys and field order through repair planning", () => {
    const fields = Object.fromEntries(Array.from({ length: 25 }, (_, index) => [`field_${index + 1}`, `value-${index + 1}`]));
    const input = [{ shotId: "S1", prompt: "完整提示词", duration: 6, fields }];
    const result = buildPromptRepairPlan({
      projectId: "VID-25", revision: 1, round: 1, rows: input,
      findings: [{ ...finding, shotId: "S1", fieldPath: "fields.field_2" }],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(Object.keys(result.context.rows[0]!.fields)).toEqual(Object.keys(fields));
    expect(result.context.rows[0]!.fields).toEqual(fields);
    expect(JSON.parse(promptRepairFeedback(result.plan))).not.toHaveProperty("fields");
  });

  it("treats a package finding as a package repair and refuses human-only work", () => {
    const packageFinding = normalizePromptFinding({
      code: "PACKAGE_CONTINUITY", severity: "blocking", issue: "跨镜故事顺序不成立", repairClass: "semantic",
    })!;
    const all = buildPromptRepairPlan({ projectId: "VID-1", revision: 2, round: 1, rows, findings: [packageFinding] });
    expect(all.ok && all.context.targetAll).toBe(true);
    expect(all.ok && all.plan.targets.map(row => row.shotId)).toEqual(["S1", "S2", "S3"]);

    const human = normalizePromptFinding({
      code: "AUTHORIZATION_MISSING", severity: "blocking", shotId: "S2", issue: "授权缺失", repairClass: "human_input",
    })!;
    expect(buildPromptRepairPlan({ projectId: "VID-1", revision: 2, round: 1, rows, findings: [human] }))
      .toMatchObject({ ok: false, code: "PROMPT_REPAIR_BLOCKED" });
  });

  it("fails closed for unknown shot ids and detects unchanged findings/rows", () => {
    const unbound = { ...finding, shotId: "S9" };
    expect(buildPromptRepairPlan({ projectId: "VID-1", revision: 2, round: 1, rows, findings: [unbound] }))
      .toMatchObject({ ok: false, code: "PROMPT_FINDING_UNBOUND" });

    expect(promptRepairMadeProgress({
      priorFindingKeys: [promptFindingKey(finding)],
      nextFindingKeys: [promptFindingKey(finding)],
      priorRows: rows,
      nextRows: structuredClone(rows),
      targetShotIds: ["S2"],
    })).toBe(false);
    const changed = structuredClone(rows);
    changed[1]!.fields.action = "拿起器物并停稳";
    expect(promptRepairMadeProgress({
      priorFindingKeys: [promptFindingKey(finding)],
      nextFindingKeys: [promptFindingKey(finding)],
      priorRows: rows,
      nextRows: changed,
      targetShotIds: ["S2"],
    })).toBe(true);
  });

  it("binds every row checkpoint to the project and source revision", () => {
    expect(promptRowCheckpoint(rows[1]!, {
      projectId: "VID-1",
      revision: 7,
      policyVersion: "native/v1",
      dependencyShotIds: ["S1", "S3"],
      now: "2026-11-08T00:00:00.000Z",
    })).toMatchObject({
      projectId: "VID-1",
      revision: 7,
      shotId: "S2",
      dependencyShotIds: ["S1", "S3"],
      status: "passed",
      lastVerifiedAt: "2026-11-08T00:00:00.000Z",
    });
  });

  it("fails closed when the repair plan, row bytes, or target hash is tampered", () => {
    const result = buildPromptRepairPlan({
      projectId: "VID-1", revision: 2, round: 1, rows, findings: [finding],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(validatePromptRepairContext(result.context)).toEqual(result.context);

    const changedRow = structuredClone(result.context);
    changedRow.rows[1]!.fields.action = "绕过计划的改写";
    expect(validatePromptRepairContext(changedRow)).toBeNull();

    const changedTarget = structuredClone(result.context);
    changedTarget.plan.targets[0]!.currentRowSha256 = "f".repeat(64);
    expect(validatePromptRepairContext(changedTarget)).toBeNull();
  });
});
