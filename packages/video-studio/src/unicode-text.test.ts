import { describe, expect, it } from "vitest";
import { FINAL_PROMPT_MAX_CHARACTERS, VIDEO_INTENT_MAX_CHARACTERS, unicodeLength, unicodeSlice } from "./unicode-text.mjs";

describe("video Unicode character limits", () => {
  it("counts BMP Han, supplementary Han, Latin, punctuation and line breaks as code points", () => {
    expect(unicodeLength("汉𠮷A，\n")).toBe(5);
    expect(unicodeLength("")).toBe(0);
    expect(unicodeLength("𠮷".repeat(VIDEO_INTENT_MAX_CHARACTERS))).toBe(12_000);
    expect(unicodeLength("𠮷".repeat(FINAL_PROMPT_MAX_CHARACTERS))).toBe(3_000);
  });

  it("slices by Unicode characters without leaving half a supplementary Han character", () => {
    expect(unicodeSlice("甲𠮷乙𠮷丙", 1, 4)).toBe("𠮷乙𠮷");
    expect(unicodeSlice("甲𠮷乙𠮷丙", 0, -1)).toBe("甲𠮷乙𠮷");
    expect(unicodeSlice("𠮷", 1)).toBe("");
  });
});
