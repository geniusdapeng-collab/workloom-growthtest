/**
 * Canonical text-model pool.
 *
 * The historical tier names remain for billing/analytics compatibility, but
 * every tier resolves to `text.primary` -> `deepseek-flash`. There is no
 * cross-vendor or cross-tier text fallback.
 */
import {
  DEEPSEEK_FLASH_MODEL_ID,
  canonicalDeepSeekModel,
} from "./token-budget.js";
import { OpenAiCompatibleProvider, MockProvider, type ModelProvider } from "./providers.js";
import type { Tier3 } from "./policy.js";

export interface ModelSpec {
  id: typeof DEEPSEEK_FLASH_MODEL_ID;
  tier: Tier3;
  vendor: "deepseek";
  longContext: true;
  baseUrlEnv: "DEEPSEEK_BASE_URL";
}

export const MODEL_CATALOG: readonly ModelSpec[] = Object.freeze([
  Object.freeze({
    id: DEEPSEEK_FLASH_MODEL_ID,
    tier: "L1",
    vendor: "deepseek",
    longContext: true,
    baseUrlEnv: "DEEPSEEK_BASE_URL",
  }),
]);

export function catalogByTier(tier: Tier3): ModelSpec[] {
  return tier === "L1" ? [...MODEL_CATALOG] : [];
}

/** Billing tiers no longer select a different model. */
export function chainFor(
  _tier: Tier3,
  _opts: { longContext?: boolean; allowCrossTier?: boolean } = {},
): string[] {
  return [DEEPSEEK_FLASH_MODEL_ID];
}

function normalizedDeepSeekBaseUrl(env: NodeJS.ProcessEnv): string {
  const raw = env.LLM_BASE_URL ?? env.DEEPSEEK_BASE_URL ?? "https://api.deepseek.com";
  return raw.trim().replace(/\/+$/, "").replace(/\/anthropic$/i, "");
}

export function poolFromEnv(
  opts: { mockOpts?: Record<string, { failFirst?: number; down?: boolean }> } = {},
): Map<string, ModelProvider> {
  const declared = (process.env.LLM_PROVIDER ?? "mock").trim().toLowerCase();
  if (!["mock", "deepseek"].includes(declared)) {
    throw new Error(`LLM_PROVIDER=${declared} 不在 text.primary registry 中`);
  }
  const requested = canonicalDeepSeekModel(
    process.env.LLM_FORCE_MODEL ?? process.env.LLM_MODEL ?? process.env.DEEPSEEK_MODEL,
  );
  const pool = new Map<string, ModelProvider>();
  if (declared === "mock") {
    pool.set(requested, new MockProvider(requested, opts.mockOpts?.[requested]));
    return pool;
  }
  const apiKey = process.env.LLM_API_KEY || process.env.DEEPSEEK_API_KEY;
  if (!apiKey) throw new Error("DEEPSEEK_API_KEY_MISSING");
  pool.set(requested, new OpenAiCompatibleProvider(requested, {
    baseUrl: normalizedDeepSeekBaseUrl(process.env),
    apiKey,
  }));
  return pool;
}
