/**
 * DeepSeek token units shared by routing and video text generation.
 * Official facts: 1,048,576 context tokens; 393,216 max output tokens.
 */
export const DEEPSEEK_FLASH_MODEL_ID = "deepseek-flash" as const;
export const DEEPSEEK_FLASH_CONTEXT_TOKENS = 1_048_576 as const;
export const DEEPSEEK_FLASH_MAX_OUTPUT_TOKENS = 393_216 as const;
export const DEFAULT_JSON_OUTPUT_TOKENS = 16_384 as const;
export const LONG_CONTEXT_TOKENS = 32_000 as const;

export function isDeepSeekFlashModel(model: string | null | undefined): boolean {
  return model === DEEPSEEK_FLASH_MODEL_ID || model === "deepseek-v4-flash";
}

export function estimateDeepSeekTokens(text: string): number {
  let cjk = 0, textChars = 0, symbols = 0;
  for (const char of text) {
    if (/\p{Script=Han}|\p{Script=Hiragana}|\p{Script=Katakana}|\p{Script=Hangul}/u.test(char)) cjk += 1;
    else if (/[\p{L}\p{N}\s]/u.test(char)) textChars += 1;
    else symbols += 1;
  }
  return Math.ceil(cjk * 0.6 + textChars * 0.3 + symbols);
}

export function deepSeekInputTokenBudget(maxOutputTokens: number = DEFAULT_JSON_OUTPUT_TOKENS): number {
  if (!Number.isInteger(maxOutputTokens) || maxOutputTokens < 0 || maxOutputTokens > DEEPSEEK_FLASH_MAX_OUTPUT_TOKENS) {
    throw new Error("DEEPSEEK_OUTPUT_BUDGET_INVALID");
  }
  return DEEPSEEK_FLASH_CONTEXT_TOKENS - maxOutputTokens;
}
