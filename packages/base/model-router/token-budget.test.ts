import { describe, expect, it } from "vitest";
import {
  DEEPSEEK_FLASH_CONTEXT_TOKENS,
  DEEPSEEK_FLASH_MAX_OUTPUT_TOKENS,
  deepSeekInputTokenBudget,
  estimateDeepSeekTokens,
} from "./token-budget.js";

describe("DeepSeek token budget", () => {
  it("keeps official context and output ceilings in one unit", () => {
    expect(DEEPSEEK_FLASH_CONTEXT_TOKENS).toBe(1_048_576);
    expect(DEEPSEEK_FLASH_MAX_OUTPUT_TOKENS).toBe(393_216);
    expect(deepSeekInputTokenBudget(16_384)).toBe(1_032_192);
    expect(deepSeekInputTokenBudget(393_216)).toBe(655_360);
  });
  it("uses documented text ratios and a conservative symbol estimate", () => {
    expect(estimateDeepSeekTokens("你好")).toBe(2);
    expect(estimateDeepSeekTokens("abcd")).toBe(2);
    expect(estimateDeepSeekTokens("{")).toBe(1);
    expect(estimateDeepSeekTokens("a\n中{}")).toBe(4);
  });
  it("rejects output budgets outside the official range", () => {
    expect(() => deepSeekInputTokenBudget(-1)).toThrow("DEEPSEEK_OUTPUT_BUDGET_INVALID");
    expect(() => deepSeekInputTokenBudget(393_217)).toThrow("DEEPSEEK_OUTPUT_BUDGET_INVALID");
    expect(() => deepSeekInputTokenBudget(1.5)).toThrow("DEEPSEEK_OUTPUT_BUDGET_INVALID");
  });
});
