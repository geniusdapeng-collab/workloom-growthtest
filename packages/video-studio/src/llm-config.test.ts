import { describe, expect, it } from "vitest";
import {
  DEEPSEEK_FLASH_CONTEXT_TOKENS,
  DEEPSEEK_FLASH_INPUT_TOKEN_BUDGET,
  DEEPSEEK_FLASH_MAX_OUTPUT_TOKENS,
  DEEPSEEK_FLASH_MODEL,
  DEEPSEEK_VIDEO_JSON_OUTPUT_TOKENS,
  estimateDeepSeekTokens,
  resolveOpenAiCompatibleBaseUrl,
  resolveVideoApiKey,
  resolveVideoModel,
} from "./llm-config.js";

describe("video model configuration", () => {
  it("uses the canonical official model and a million-token context", () => {
    expect(DEEPSEEK_FLASH_MODEL).toBe("deepseek-flash");
    expect(DEEPSEEK_FLASH_CONTEXT_TOKENS).toBe(1_048_576);
    expect(DEEPSEEK_FLASH_MAX_OUTPUT_TOKENS).toBe(393_216);
    expect(DEEPSEEK_FLASH_INPUT_TOKEN_BUDGET).toBe(655_360);
    expect(DEEPSEEK_VIDEO_JSON_OUTPUT_TOKENS).toBe(393_216);
    expect(resolveVideoModel({ LLM_BASE_URL: "https://api.deepseek.com" })).toBe("deepseek-flash");
    expect(resolveVideoModel({ DEEPSEEK_MODEL: "deepseek-flash" })).toBe("deepseek-flash");
  });

  it("uses DeepSeek's documented token ratios instead of treating characters as tokens", () => {
    expect(estimateDeepSeekTokens("你好")).toBe(2);
    expect(estimateDeepSeekTokens("abcd")).toBe(2);
    expect(estimateDeepSeekTokens("{")).toBe(1);
  });

  it("prefers the OpenAI-compatible endpoint over the Anthropic endpoint", () => {
    expect(resolveOpenAiCompatibleBaseUrl({
      LLM_BASE_URL: "https://api.deepseek.com",
      DEEPSEEK_BASE_URL: "https://api.deepseek.com/anthropic",
    })).toBe("https://api.deepseek.com");
    expect(resolveOpenAiCompatibleBaseUrl({ DEEPSEEK_BASE_URL: "https://api.deepseek.com/anthropic" }))
      .toBe("https://api.deepseek.com");
  });

  it("uses the DeepSeek credential when the generic LLM key is absent", () => {
    expect(resolveVideoApiKey({ DEEPSEEK_API_KEY: "deepseek-key" })).toBe("deepseek-key");
    expect(resolveVideoApiKey({ LLM_API_KEY: "generic-key", DEEPSEEK_API_KEY: "deepseek-key" }))
      .toBe("generic-key");
  });

  it("rejects legacy model pins; thinking is owned by scene policy", () => {
    expect(() => resolveVideoModel({ LLM_MODEL: "custom-model" })).toThrow("MODEL_ID_NOT_ALLOWED");
    expect(() => resolveVideoModel({ DEEPSEEK_MODEL: "deepseek-v4-flash" })).toThrow("MODEL_ID_NOT_ALLOWED");
  });
});
