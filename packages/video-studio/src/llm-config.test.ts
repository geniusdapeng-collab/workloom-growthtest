import { describe, expect, it } from "vitest";
import {
  DEEPSEEK_FLASH_CONTEXT_TOKENS, DEEPSEEK_FLASH_INPUT_TOKEN_BUDGET, DEEPSEEK_FLASH_MAX_OUTPUT_TOKENS,
  DEEPSEEK_FLASH_MODEL, DEEPSEEK_VIDEO_JSON_OUTPUT_TOKENS, estimateDeepSeekTokens,
  resolveOpenAiCompatibleBaseUrl, resolveVideoApiKey, resolveVideoModel, resolveVideoNonThinking,
} from "./llm-config.js";

describe("isolated video text model configuration", () => {
  it("uses canonical Flash and the official one-million-token context", () => {
    expect(DEEPSEEK_FLASH_MODEL).toBe("deepseek-flash");
    expect(DEEPSEEK_FLASH_CONTEXT_TOKENS).toBe(1_048_576);
    expect(DEEPSEEK_FLASH_MAX_OUTPUT_TOKENS).toBe(393_216);
    expect(DEEPSEEK_VIDEO_JSON_OUTPUT_TOKENS).toBe(16_384);
    expect(DEEPSEEK_FLASH_INPUT_TOKEN_BUDGET).toBe(1_032_192);
    expect(resolveVideoModel({ LLM_BASE_URL: "https://api.deepseek.com" })).toBe("deepseek-flash");
    expect(resolveVideoModel({ DEEPSEEK_MODEL: "deepseek-v4-flash" })).toBe("deepseek-flash");
  });
  it("uses documented token ratios instead of character counts", () => {
    expect(estimateDeepSeekTokens("你好")).toBe(2);
    expect(estimateDeepSeekTokens("abcd")).toBe(2);
    expect(estimateDeepSeekTokens("{")).toBe(1);
  });
  it("uses the OpenAI-compatible endpoint and DeepSeek credential", () => {
    expect(resolveOpenAiCompatibleBaseUrl({
      LLM_BASE_URL: "https://api.deepseek.com",
      DEEPSEEK_BASE_URL: "https://api.deepseek.com/anthropic",
    })).toBe("https://api.deepseek.com");
    expect(resolveVideoApiKey({ DEEPSEEK_API_KEY: "deepseek-key" })).toBe("deepseek-key");
  });
  it("defaults Flash text calls to non-thinking with explicit rollback", () => {
    expect(resolveVideoNonThinking("deepseek-flash", {})).toBe(true);
    expect(resolveVideoNonThinking("deepseek-flash", { LLM_NON_THINKING: "0" })).toBe(false);
    expect(resolveVideoNonThinking("custom-model", {})).toBe(false);
    expect(resolveVideoNonThinking("custom-model", { LLM_NON_THINKING: "1" })).toBe(true);
  });
});
