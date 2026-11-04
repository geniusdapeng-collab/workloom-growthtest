import { describe, expect, it } from "vitest";
import { applyNarrativeFinalPromptContract } from "./vendor-compat.js";
import { FINAL_PROMPT_MAX_CHARACTERS, unicodeLength } from "./unicode-text.mjs";

describe("final prompt supplementary Han boundaries", () => {
  it("retains a prompt below 3000 Unicode characters even when UTF-16 code units exceed 3000", () => {
    const source = "𠮷".repeat(2600);
    const shot = applyNarrativeFinalPromptContract({ shotId: "S1", prompt: `01.【场景】${source}` }, {
      noDialogue: false, maxLength: FINAL_PROMPT_MAX_CHARACTERS,
    });
    const prompt = String(shot.prompt);
    expect(prompt).toContain(source);
    expect(prompt.length).toBeGreaterThan(FINAL_PROMPT_MAX_CHARACTERS);
    expect(unicodeLength(prompt)).toBeLessThanOrEqual(FINAL_PROMPT_MAX_CHARACTERS);
  });

  it("compacts an overflowing numbered field by Unicode characters without splitting a surrogate pair", () => {
    const shot = applyNarrativeFinalPromptContract({ shotId: "S1", prompt: `01.【场景】${"𠮷".repeat(3500)}` }, {
      noDialogue: false, maxLength: FINAL_PROMPT_MAX_CHARACTERS,
    });
    const prompt = String(shot.prompt);
    expect(unicodeLength(prompt)).toBeLessThanOrEqual(FINAL_PROMPT_MAX_CHARACTERS);
    expect(unicodeLength(prompt)).toBeGreaterThan(2500);
    expect(prompt).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u);
    expect(prompt).toContain("𠮷");
    expect(prompt).toContain("…");
  });
});
