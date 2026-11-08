import { describe, expect, it } from "vitest";
import {
  derivePromptFindings,
  normalizePromptFinding,
  promptFindingKey,
} from "@hyperreality/video-studio";
import {
  PromptTextCallBudget,
  isPromptRepairBudgetExhausted,
  preparePromptRepairRound,
  promptRepairFindings,
  promptRepairProgressAfterRound,
  promptRowsFromVendorResult,
} from "./prompt-repair-supervisor.js";

const rows = [
  { shotId: "S1", prompt: "S1", duration: 5, fields: { action: "建立环境" } },
  { shotId: "S2", prompt: "S2", duration: 5, fields: { action: "拿起器物" } },
  { shotId: "S3", prompt: "S3", duration: 5, fields: { action: "放稳" } },
];

describe("prompt repair supervisor", () => {
  it("extracts full native rows without changing fields", () => {
    expect(promptRowsFromVendorResult({
      stages: { productionEngine: { shots: rows } },
    })).toEqual(rows);
  });

  it("uses structured findings before legacy issue text", () => {
    const structured = normalizePromptFinding({
      code: "ACTION_MISSING",
      severity: "blocking",
      shotId: "S2",
      issue: "缺少动作",
      repairClass: "semantic",
    })!;
    expect(promptRepairFindings({ findings: [structured], issues: ["S9 运镜问题"] })).toEqual([structured]);
    expect(promptRepairFindings({ issues: ["S9 运镜问题"], suggestions: ["修复"] })[0])
      .toMatchObject({ shotId: "S9", suggestion: "修复" });
  });

  it("builds a bounded S2-only repair round and stops human-only work", () => {
    const finding = normalizePromptFinding({
      code: "ACTION_MISSING",
      severity: "blocking",
      shotId: "S2",
      fieldPath: "fields.action",
      issue: "缺少动作",
      repairClass: "semantic",
    })!;
    const prepared = preparePromptRepairRound({
      projectId: "VID-1", revision: 2, round: 1, enabled: true, rows,
      findings: [finding], policyVersion: "native-production/v1", maxRepairRounds: 2, maxTextCalls: 8,
    });
    expect(prepared.ok).toBe(true);
    if (!prepared.ok) return;
    expect(prepared.round.targetShotIds).toEqual(["S2"]);
    expect(prepared.round.context.rows).toEqual(rows);
    expect(prepared.round.artifacts).toEqual([
      expect.objectContaining({ shotId: "S2", prompt: "S2", fieldKeys: ["action"] }),
    ]);
    expect(prepared.round.rowCheckpoints).toEqual([
      expect.objectContaining({ shotId: "S2", status: "rejected", policyVersion: "native-production/v1" }),
    ]);

    const human = normalizePromptFinding({
      code: "AUTH_MISSING", severity: "blocking", shotId: "S2", issue: "缺授权", repairClass: "human_input",
    })!;
    expect(preparePromptRepairRound({
      projectId: "VID-1", revision: 2, round: 1, enabled: true, rows,
      findings: [human], policyVersion: "native-production/v1",
    })).toMatchObject({ ok: false, code: "PROMPT_REPAIR_BLOCKED" });
  });

  it("reports no progress when both findings and target row bytes are unchanged", () => {
    const finding = derivePromptFindings(["S2 缺少动作"])[0]!;
    const plan = {
      schemaVersion: "workloom.prompt-repair-plan/v1" as const,
      projectId: "VID-1",
      revision: 1,
      round: 1,
      sourcePromptSetSha256: "a".repeat(64),
      constraintSet: {
        schemaVersion: "workloom.video-constraints/v1" as const,
        projectId: "VID-1",
        revision: 1,
        constraints: [],
        hash: "d".repeat(64),
      },
      storyPlan: {
        schemaVersion: "workloom.video-story/v1" as const,
        projectId: "VID-1",
        revision: 1,
        title: null,
        orderedShotIds: ["S1", "S2", "S3"],
        hash: "e".repeat(64),
      },
      findings: [finding],
      shotPlans: [],
      targets: [{ shotId: "S2", fields: ["fields.action"], currentRowSha256: "b".repeat(64), neighborShotIds: ["S1", "S3"] }],
      blocked: [],
      budget: { maxRepairRounds: 2, maxTextCalls: 8, maxTextCallsPerShot: 4 },
      planHash: "c".repeat(64),
    };
    expect(promptRepairProgressAfterRound({
      priorPlan: plan,
      priorRows: rows,
      nextFindings: [finding],
      nextRows: structuredClone(rows),
    })).toMatchObject({
      progress: false,
      priorFindingKeys: [promptFindingKey(finding)],
      nextFindingKeys: [promptFindingKey(finding)],
    });
  });

  it("freezes the cumulative text-call budget before a provider dispatch", () => {
    const budget = new PromptTextCallBudget(2);
    budget.reserve("author");
    budget.reserve("preflight");
    let error: unknown;
    try { budget.reserve("post-repair-g6"); }
    catch (caught) { error = caught; }
    expect(isPromptRepairBudgetExhausted(error)).toBe(true);
    expect(budget.snapshot()).toMatchObject({
      maxTextCalls: 2,
      usedTextCalls: 2,
      remainingTextCalls: 0,
      exhausted: true,
    });
  });
});
