/**
 * Video-pipeline model policy.
 *
 * `deepseek-flash` is the only accepted model identity. Dated and legacy
 * aliases fail closed so routing, evidence budgets and traces cannot drift.
 */
import {
  canonicalDeepSeekModel,
  DEEPSEEK_FLASH_CONTEXT_TOKENS,
  DEEPSEEK_FLASH_MAX_OUTPUT_TOKENS,
  DEEPSEEK_FLASH_MODEL_ID,
  deepSeekInputTokenBudget,
  estimateDeepSeekTokens,
} from "@workloom/base/model-router";

export {
  DEEPSEEK_FLASH_CONTEXT_TOKENS,
  DEEPSEEK_FLASH_MAX_OUTPUT_TOKENS,
  estimateDeepSeekTokens,
};
export const DEEPSEEK_FLASH_MODEL = DEEPSEEK_FLASH_MODEL_ID;
/** @deprecated The dispatcher uses the complete legal remaining window. */
export const DEEPSEEK_VIDEO_JSON_OUTPUT_TOKENS = DEEPSEEK_FLASH_MAX_OUTPUT_TOKENS;
export const DEEPSEEK_FLASH_INPUT_TOKEN_BUDGET = deepSeekInputTokenBudget(DEEPSEEK_VIDEO_JSON_OUTPUT_TOKENS);

type Env = Record<string, string | undefined>;

function clean(value: string | undefined): string {
  return value?.trim() ?? "";
}

function isDeepSeekEndpoint(value: string): boolean {
  try {
    return new URL(value).hostname === "api.deepseek.com";
  } catch {
    return false;
  }
}

/** Canonical model used by every video-pipeline call. Explicit pins win. */
export function resolveVideoModel(env: Env = process.env): string {
  const configured = clean(env.LLM_FORCE_MODEL)
    || clean(env.LLM_MODEL)
    || clean(env.DEEPSEEK_MODEL);
  if (configured) return canonicalDeepSeekModel(configured);
  const endpoint = clean(env.LLM_BASE_URL) || clean(env.DEEPSEEK_BASE_URL);
  return isDeepSeekEndpoint(endpoint) || clean(env.DEEPSEEK_API_KEY)
    ? DEEPSEEK_FLASH_MODEL
    : "";
}

/**
 * OpenAI-compatible endpoint for chat completions.
 * `DEEPSEEK_BASE_URL` may point at `/anthropic` in deployed secrets; that path
 * cannot serve `/chat/completions`, so normalize it without hiding the config.
 */
export function resolveOpenAiCompatibleBaseUrl(env: Env = process.env): string {
  const base = clean(env.LLM_BASE_URL) || clean(env.DEEPSEEK_BASE_URL);
  return base.replace(/\/+$/, "").replace(/\/anthropic$/i, "");
}

export function resolveVideoApiKey(env: Env = process.env): string {
  return clean(env.LLM_API_KEY) || clean(env.DEEPSEEK_API_KEY);
}
