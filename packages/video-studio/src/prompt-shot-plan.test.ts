import { describe, expect, it } from "vitest";
import {
  STANDARD_PROMPT_FIELD_KEYS,
  assertStandardPromptFields,
  buildPromptConstraintSet,
  buildPromptStoryPlan,
  compilePromptArtifact,
  derivePromptShotPlan,
} from "./prompt-shot-plan.js";

describe("shot plan and prompt artifact contracts", () => {
  it("builds immutable constraint and story plans while retaining the 25-field rows", () => {
    const fields = Object.fromEntries(STANDARD_PROMPT_FIELD_KEYS.map(key => [key, key]));
    const row = { shotId: "S1", prompt: "完整提示词", duration: 6, fields };
    const constraints = buildPromptConstraintSet({
      projectId: "VID-1", revision: 1, rawIntent: "雨后空镜", targetSeconds: 10,
      metadata: { platform: "douyin", aspectRatio: "9:16" },
    });
    expect(constraints.constraints.map(item => item.constraintId)).toEqual([
      "raw-intent", "target-seconds", "platform", "aspect-ratio",
    ]);
    const story = buildPromptStoryPlan({ projectId: "VID-1", revision: 1, rows: [row] });
    expect(story.orderedShotIds).toEqual(["S1"]);
    expect(story.hash).toMatch(/^[a-f0-9]{64}$/u);
    expect(Object.keys(row.fields)).toEqual([...STANDARD_PROMPT_FIELD_KEYS]);
  });

  it("derives a shot plan without changing any of the 25 native field keys or values", () => {
    const fields = Object.fromEntries(STANDARD_PROMPT_FIELD_KEYS.map((key, index) => [
      key,
      key === "action" ? "拿起器物、转动、放稳" : key === "character" ? "陈卓"
        : key === "props" ? "木桌、陶杯" : `字段${index + 1}`,
    ]));
    const row = { shotId: "S2", prompt: "完整提示词", duration: 6, fields,
      products: ["星野 F3"], props: ["木桌", "陶杯"] };
    const plan = derivePromptShotPlan("VID-1", 3, row, ["rawIntent"]);
    expect(Object.keys(plan.nativeFields)).toEqual([...STANDARD_PROMPT_FIELD_KEYS]);
    expect(plan.nativeFields.action).toBe("拿起器物、转动、放稳");
    expect(plan.visibleAction).toBe("拿起器物、转动、放稳");
    expect(plan.participants).toEqual(["陈卓"]);
    expect(plan.products).toEqual(["星野 F3"]);
    expect(plan.props).toEqual(["木桌", "陶杯"]);
    expect(plan.hash).toMatch(/^[a-f0-9]{64}$/u);

    const artifact = compilePromptArtifact(plan, row);
    expect(artifact.fields).toEqual(fields);
    expect(artifact.fieldKeys).toEqual(Object.keys(fields));
    expect(artifact.prompt).toBe(row.prompt);
    expect(artifact.shotPlanHash).toBe(plan.hash);
  });

  it("fails closed if a producer adds a nonstandard field to the native 25-field contract", () => {
    expect(() => assertStandardPromptFields(Object.fromEntries(STANDARD_PROMPT_FIELD_KEYS.map(key => [key, key])))).not.toThrow();
    expect(() => assertStandardPromptFields({ action: "ok", unexpected: true })).toThrow("PROMPT_STANDARD_FIELDS_CHANGED");
  });
});
