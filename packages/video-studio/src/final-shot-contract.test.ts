import { describe, expect, it } from "vitest";
import { assertRenderSubmissionEligible, inspectFinalShotContract } from "./final-shot-contract.js";

const shot = {
  shotId: "S1",
  duration: 6,
  prompt: "01.【场景】完整画面\n24.【负面约束】no text",
  dialogue: "",
};

describe("final shot contract", () => {
  it("accepts a complete, non-degraded shot set", () => {
    expect(inspectFinalShotContract([shot], { maxPromptLength: 3000, noDialogue: true })).toEqual({
      pass: true,
      issues: [],
    });
  });

  it("treats the normalized no-dialogue declaration as absence, not residual dialogue", () => {
    const normalized = {
      ...shot,
      prompt: "01.【场景】完整画面\n18.【台词】不适用：本片无台词、无旁白、无口播。",
      dialogueText: "",
      dialogueBlocks: [],
    };
    expect(inspectFinalShotContract([normalized], { maxPromptLength: 3000, noDialogue: true })).toEqual({
      pass: true,
      issues: [],
    });
    const residual = { ...normalized, prompt: "01.【场景】完整画面\n18.【台词】小满说：还在吗？" };
    expect(inspectFinalShotContract([residual], { maxPromptLength: 3000, noDialogue: true }).issues)
      .toContainEqual(expect.objectContaining({ code: "DIALOGUE_FORBIDDEN" }));
  });

  it.each([
    [[], "SHOTS_REQUIRED", { maxPromptLength: 3000 }],
    [[{ ...shot, prompt: " " }], "SHOT_PROMPT_REQUIRED", { maxPromptLength: 3000 }],
    [[{ ...shot, prompt: "[object Object] undefined" }], "SHOT_PLACEHOLDER", { maxPromptLength: 3000 }],
    [[{ ...shot, prompt: "角色undefined进入画面" }], "SHOT_PLACEHOLDER", { maxPromptLength: 3000 }],
    [[shot, { ...shot }], "SHOT_DUPLICATE", { maxPromptLength: 3000 }],
    [[shot], "PROMPT_TOO_LONG", { maxPromptLength: 5 }],
    [[{ ...shot, degraded: true }], "SHOT_DEGRADED", { maxPromptLength: 3000 }],
    [[{ ...shot, dialogue: "还在吗" }], "DIALOGUE_FORBIDDEN", { maxPromptLength: 3000, noDialogue: true }],
    [[{ ...shot, duration: 0 }], "DURATION_INVALID", { maxPromptLength: 3000 }],
  ] as const)("fails closed for %s", (shots, code, options) => {
    const result = inspectFinalShotContract(shots as unknown as Array<Record<string, unknown>>, options);
    expect(result.pass).toBe(false);
    expect(result.issues.map((issue) => issue.code)).toContain(code);
  });

  it("only eligible pending-G8 results may pass the render boundary", () => {
    expect(() => assertRenderSubmissionEligible({
      status: "eligible_pending_G8",
      providerSubmission: false,
      contractPass: true,
    })).not.toThrow();
    expect(() => assertRenderSubmissionEligible({
      status: "blocked",
      providerSubmission: true,
      contractPass: false,
    })).toThrow("RENDER_SUBMIT_BLOCKED");
  });
});
