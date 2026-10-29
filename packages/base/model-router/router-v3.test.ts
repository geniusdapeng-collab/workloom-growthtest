import { describe, expect, it } from "vitest";
import {
  DEFAULT_MODEL_POLICY,
  parseModelPolicy,
  resolveTier,
} from "./policy.js";
import {
  MODEL_CATALOG,
  catalogByTier,
  chainFor,
  poolFromEnv,
} from "./pool.js";
import { resolveTextScenePolicy } from "./deepseek-policy.js";
import {
  MockProvider,
  type ChatResult,
  type ModelProvider,
} from "./providers.js";
import { routeSmart, type EventSink, type SmartTask } from "./router.js";
import { computeCredits } from "./credits.js";
import {
  DEEPSEEK_FLASH_MAX_OUTPUT_TOKENS,
  TEXT_PRIMARY_POLICY_VERSION,
  TEXT_PRIMARY_REGISTRY_VERSION,
} from "./token-budget.js";

function chatResult(text: string, modelId = "deepseek-flash"): ChatResult {
  return {
    text,
    promptTokens: 100,
    completionTokens: 30,
    modelId,
    finishReason: "stop",
    reasoningTokens: 0,
    requestHash: "a".repeat(64),
    responseHash: "b".repeat(64),
    responseId: "response-1",
    scene: "generic",
    mode: "enabled",
    effort: "high",
    outputCeiling: DEEPSEEK_FLASH_MAX_OUTPUT_TOKENS,
    inputTokenEstimate: 100,
    imageCount: 0,
    policyVersion: TEXT_PRIMARY_POLICY_VERSION,
    registryVersion: TEXT_PRIMARY_REGISTRY_VERSION,
    attempts: [],
  };
}

function sink(): EventSink & { traces: unknown[]; degrades: unknown[] } {
  const traces: unknown[] = [];
  const degrades: unknown[] = [];
  return {
    traces,
    degrades,
    recordModelTrace: async (trace) => { traces.push(trace); },
    recordDegradation: async (event) => { degrades.push(event); },
    recordCircuitBreak: async () => undefined,
  };
}

describe("canonical text model catalog", () => {
  it("contains one model and every billing tier resolves to it", () => {
    expect(MODEL_CATALOG).toHaveLength(1);
    expect(MODEL_CATALOG[0]).toMatchObject({
      id: "deepseek-flash",
      vendor: "deepseek",
      longContext: true,
    });
    expect(catalogByTier("L2")).toEqual([]);
    expect(chainFor("L1")).toEqual(["deepseek-flash"]);
    expect(chainFor("L2", { allowCrossTier: false })).toEqual(["deepseek-flash"]);
    expect(chainFor("L3")).toEqual(["deepseek-flash"]);
  });

  it("mock pool also contains only the canonical model", () => {
    const previous = process.env.LLM_PROVIDER;
    process.env.LLM_PROVIDER = "mock";
    try {
      const pool = poolFromEnv();
      expect([...pool.keys()]).toEqual(["deepseek-flash"]);
      expect(pool.get("deepseek-flash")).toBeInstanceOf(MockProvider);
    } finally {
      if (previous === undefined) delete process.env.LLM_PROVIDER;
      else process.env.LLM_PROVIDER = previous;
    }
  });

  it.each(["moonshot", "zhipu", "openai"])(
    "rejects legacy provider %s",
    (provider) => {
      const previous = process.env.LLM_PROVIDER;
      process.env.LLM_PROVIDER = provider;
      try {
        expect(() => poolFromEnv()).toThrow("text.primary registry");
      } finally {
        if (previous === undefined) delete process.env.LLM_PROVIDER;
        else process.env.LLM_PROVIDER = previous;
      }
    },
  );

  it("rejects any non-canonical model pin", () => {
    const previousProvider = process.env.LLM_PROVIDER;
    const previousForce = process.env.LLM_FORCE_MODEL;
    process.env.LLM_PROVIDER = "mock";
    process.env.LLM_FORCE_MODEL = "glm-5.3";
    try {
      expect(() => poolFromEnv()).toThrow("MODEL_ID_NOT_ALLOWED");
    } finally {
      if (previousProvider === undefined) delete process.env.LLM_PROVIDER;
      else process.env.LLM_PROVIDER = previousProvider;
      if (previousForce === undefined) delete process.env.LLM_FORCE_MODEL;
      else process.env.LLM_FORCE_MODEL = previousForce;
    }
  });
});

describe("scene policy", () => {
  it("keeps generation and review explicit and on the same canonical model", () => {
    const generation = resolveTextScenePolicy("video.preproduction.plan");
    const producer = resolveTextScenePolicy("video.quality.producer-review");
    const plausibility = resolveTextScenePolicy("video.quality.plausibility-review");
    const finalReview = resolveTextScenePolicy("video.quality.final-review");
    expect(generation).toMatchObject({
      modelId: "deepseek-flash",
      thinking: { type: "enabled", effort: "high" },
      responseFormat: "json_object",
    });
    expect(producer.generationReviewGroup).toBe(generation.generationReviewGroup);
    expect(plausibility.generationReviewGroup).toBe(generation.generationReviewGroup);
    expect(finalReview.thinking).toEqual({ type: "enabled", effort: "max" });
  });

  it("uses non-thinking for deterministic scenes", () => {
    expect(resolveTextScenePolicy("intent-classify").thinking).toEqual({ type: "disabled" });
    expect(resolveTextScenePolicy("video.schema.repair").thinking).toEqual({ type: "disabled" });
  });

  it("bundle policy can override thinking without changing the model", () => {
    const parsed = parseModelPolicy(`
scenes:
  producer-review:
    tier: L3
    type: reasoning_review
    thinking: { type: enabled, effort: max }
    responseFormat: json_object
    generationReviewGroup: video.preproduction
    sameModelAs: video.preproduction.plan
`);
    expect(parsed.issues).toEqual([]);
    const policy = resolveTextScenePolicy("producer-review", parsed.policy?.scenes["producer-review"]);
    expect(policy.modelId).toBe("deepseek-flash");
    expect(policy.thinking).toEqual({ type: "enabled", effort: "max" });
  });
});

describe("billing tiers keep analytics but do not select models", () => {
  it("plan mapping still resolves for billing", () => {
    expect(resolveTier(DEFAULT_MODEL_POLICY, "quest-plan", "lite")).toBe("L1");
    expect(resolveTier(DEFAULT_MODEL_POLICY, "quest-plan", "standard")).toBe("L2");
    expect(resolveTier(DEFAULT_MODEL_POLICY, "quest-plan", "smart")).toBe("L3");
  });

  it("credits remain a deterministic projection", () => {
    expect(computeCredits({
      tier: "L2",
      promptTokens: 2_000,
      completionTokens: 1_000,
      window: "peak",
    })).toBe(3);
  });

  it("every plan calls the same provider", async () => {
    const calls: string[] = [];
    const provider: ModelProvider = {
      modelId: "deepseek-flash",
      healthy: async () => true,
      chat: async (_messages, opts) => {
        calls.push(opts?.scene ?? "");
        return chatResult("same answer");
      },
    };
    const providers = new Map([["deepseek-flash", provider]]);
    const eventSink = sink();
    for (const plan of ["lite", "standard", "smart"] as const) {
      const task: SmartTask = {
        action: "quest-plan",
        scene: "quest-plan",
        plan,
        messages: [{ role: "user", content: "plan" }],
      };
      expect((await routeSmart(task, providers, eventSink)).kind).toBe("answered");
    }
    expect(calls).toEqual(["quest-plan", "quest-plan", "quest-plan"]);
    expect(eventSink.traces.every((trace) =>
      (trace as { model_id?: string }).model_id === "deepseek-flash")).toBe(true);
  });
});
