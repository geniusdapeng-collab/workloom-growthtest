/**
 * Isolated Growthtest text-reasoning policy.
 * Image and video providers are intentionally outside this module.
 */
import {
  DEEPSEEK_FLASH_CONTEXT_TOKENS,
  DEEPSEEK_FLASH_MAX_OUTPUT_TOKENS,
  DEEPSEEK_FLASH_MODEL_ID,
  DEFAULT_JSON_OUTPUT_TOKENS,
  deepSeekInputTokenBudget,
  estimateDeepSeekTokens,
} from "@workloom/base/model-router";

export { DEEPSEEK_FLASH_CONTEXT_TOKENS, DEEPSEEK_FLASH_MAX_OUTPUT_TOKENS, estimateDeepSeekTokens };
export const DEEPSEEK_FLASH_MODEL = DEEPSEEK_FLASH_MODEL_ID;
export const DEEPSEEK_VIDEO_JSON_OUTPUT_TOKENS = DEFAULT_JSON_OUTPUT_TOKENS;
export const DEEPSEEK_FLASH_INPUT_TOKEN_BUDGET = deepSeekInputTokenBudget(DEEPSEEK_VIDEO_JSON_OUTPUT_TOKENS);

type Env = Record<string, string | undefined>;
const clean = (value: string | undefined): string => value?.trim() ?? "";

function isDeepSeekEndpoint(value: string): boolean {
  try { return new URL(value).hostname === "api.deepseek.com"; }
  catch { return false; }
}

export function resolveVideoModel(env: Env = process.env): string {
  const configured = clean(env.LLM_FORCE_MODEL) || clean(env.LLM_MODEL) || clean(env.DEEPSEEK_MODEL);
  if (configured) return configured === "deepseek-v4-flash" ? DEEPSEEK_FLASH_MODEL : configured;
  const endpoint = clean(env.LLM_BASE_URL) || clean(env.DEEPSEEK_BASE_URL);
  return isDeepSeekEndpoint(endpoint) || clean(env.DEEPSEEK_API_KEY) ? DEEPSEEK_FLASH_MODEL : "";
}

export function resolveOpenAiCompatibleBaseUrl(env: Env = process.env): string {
  const base = clean(env.LLM_BASE_URL) || clean(env.DEEPSEEK_BASE_URL);
  return base.replace(/\/+$/, "").replace(/\/anthropic$/i, "");
}

export function resolveVideoApiKey(env: Env = process.env): string {
  return clean(env.LLM_API_KEY) || clean(env.DEEPSEEK_API_KEY);
}

export function resolveVideoNonThinking(model: string, env: Env = process.env): boolean {
  const flag = clean(env.LLM_NON_THINKING).toLowerCase();
  if (["0", "false", "off", "no"].includes(flag)) return false;
  if (["1", "true", "on", "yes"].includes(flag)) return true;
  return model === DEEPSEEK_FLASH_MODEL || model === "deepseek-v4-flash";
}
