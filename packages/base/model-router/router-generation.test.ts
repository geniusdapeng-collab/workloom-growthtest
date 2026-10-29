import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  circuitSnapshot,
  resetCircuit,
  routeSmart,
  type EventSink,
  type SmartTask,
} from "./router.js";
import { DEFAULT_MODEL_POLICY } from "./policy.js";
import {
  ModelProviderError,
  type ChatOptions,
  type ChatResult,
  type ModelProvider,
} from "./providers.js";
import {
  DEEPSEEK_FLASH_MAX_OUTPUT_TOKENS,
  TEXT_PRIMARY_POLICY_VERSION,
  TEXT_PRIMARY_REGISTRY_VERSION,
} from "./token-budget.js";

beforeEach(() => resetCircuit());
afterEach(() => resetCircuit());

const now = new Date("2026-10-24T12:00:00+08:00");

function result(text = "metered answer", modelId = "deepseek-flash"): ChatResult {
  return {
    text,
    promptTokens: 1_500,
    completionTokens: 500,
    modelId,
    finishReason: "stop",
    reasoningTokens: 0,
    requestHash: "a".repeat(64),
    responseHash: "b".repeat(64),
    responseId: "response-1",
    scene: "options-test",
    mode: "disabled",
    outputCeiling: DEEPSEEK_FLASH_MAX_OUTPUT_TOKENS,
    inputTokenEstimate: 1_500,
    imageCount: 0,
    policyVersion: TEXT_PRIMARY_POLICY_VERSION,
    registryVersion: TEXT_PRIMARY_REGISTRY_VERSION,
    attempts: [],
  };
}

function fixture(fail = 0) {
  const calls: Array<{ model: string; options?: ChatOptions }> = [];
  const traces: unknown[] = [];
  const degrades: unknown[] = [];
  const breaks: unknown[] = [];
  const provider: ModelProvider = {
    modelId: "deepseek-flash",
    healthy: async () => true,
    chat: async (_messages, options) => {
      calls.push({ model: provider.modelId, options });
      if (calls.length <= fail) {
        throw new ModelProviderError(`failure-${calls.length}`, "network", {
          retryable: false,
        });
      }
      return result();
    },
  };
  const providers = new Map<string, ModelProvider>([["deepseek-flash", provider]]);
  const sink: EventSink = {
    recordModelTrace: async (trace) => { traces.push(trace); },
    recordDegradation: async (event) => { degrades.push(event); },
    recordCircuitBreak: async (event) => { breaks.push(event); },
  };
  const task: SmartTask = {
    action: "options-test",
    scene: "quest-plan",
    forceTier: "L2",
    messages: [{ role: "user", content: "text" }],
    generation: {
      temperature: 0,
      topP: 0.8,
      maxTokens: 8_192,
      responseFormat: { type: "json_object" },
      thinking: { type: "disabled" },
    },
  };
  return { calls, traces, degrades, breaks, providers, sink, task };
}

describe("routeSmart canonical text dispatch", () => {
  it("calls the single canonical provider and carries scene controls", async () => {
    const f = fixture();
    f.task.timeoutMs = 180_000;
    const routed = await routeSmart(f.task, f.providers, f.sink, {}, now);
    expect(routed).toMatchObject({
      kind: "answered",
      modelTrace: { model_id: "deepseek-flash", credits: 2, tier: "L2" },
    });
    expect(f.calls).toHaveLength(1);
    expect(f.calls[0]?.options).toMatchObject({
      scene: "quest-plan",
      timeoutMs: 180_000,
      thinking: { type: "enabled", effort: "high" },
      reasoningEffort: "high",
      responseFormat: { type: "json_object" },
    });
    expect(f.calls[0]?.options?.maxTokens).toBeUndefined();
    expect(f.traces[0]).toMatchObject({
      scene: "quest-plan",
      bill_to: "tenant",
      credits: 2,
      model_id: "deepseek-flash",
    });
    expect(circuitSnapshot("quest-plan")).toBeUndefined();
  });

  it("does not call the provider after an existing budget limit", async () => {
    const f = fixture();
    f.task.creditsUsedSoFar = 500;
    expect(await routeSmart(f.task, f.providers, f.sink, {}, now))
      .toMatchObject({ kind: "circuit_broken" });
    expect(f.calls).toHaveLength(0);
    expect(f.traces).toHaveLength(0);
    expect(f.breaks).toEqual([{ action: "options-test", creditsUsed: 500, limit: 500 }]);
  });

  it("retains already paid output and measured credits when this call crosses budget", async () => {
    const f = fixture();
    f.task.creditsUsedSoFar = 499;
    expect(await routeSmart(f.task, f.providers, f.sink, {}, now)).toMatchObject({
      kind: "circuit_broken",
      text: "metered answer",
      budgetExceeded: true,
      modelTrace: { credits: 2 },
    });
    expect(f.breaks).toEqual([{ action: "options-test", creditsUsed: 501, limit: 500 }]);
  });

  it("fails closed without cross-model fallback", async () => {
    const f = fixture(1);
    expect((await routeSmart(f.task, f.providers, f.sink)).kind).toBe("unavailable");
    expect(f.calls).toHaveLength(1);
    expect(f.degrades).toEqual([{
      from: "deepseek-flash",
      to: null,
      reason: "failure-1",
      action: "options-test",
    }]);
    expect(f.traces).toHaveLength(0);
  });

  it("opens the scene circuit after three failures and skips the fourth call", async () => {
    const f = fixture(3);
    for (let index = 0; index < 3; index += 1) {
      expect((await routeSmart(f.task, f.providers, f.sink)).kind).toBe("unavailable");
    }
    expect(f.calls).toHaveLength(3);
    expect(f.degrades).toHaveLength(3);
    expect((await routeSmart(f.task, f.providers, f.sink)).degraded)
      .toEqual([{ from: "quest-plan", to: null, reason: "circuit-open" }]);
    expect(f.calls).toHaveLength(3);
  });

  it("retains memory reuse as a zero-call, zero-credit path", async () => {
    const f = fixture();
    f.task.memoryLookup = async () => ({
      reusable: true,
      answer: "cached",
      memoryId: "memory",
    });
    expect(await routeSmart(f.task, f.providers, f.sink, {}, now)).toMatchObject({
      kind: "reused",
      text: "cached",
      reusedMemoryId: "memory",
    });
    expect(f.calls).toHaveLength(0);
    expect(f.traces[0]).toMatchObject({ credits: 0, reused: true, bill_to: "tenant" });
  });

  it("retains platform cost attribution from bundle policy", async () => {
    const f = fixture();
    const policy = {
      ...DEFAULT_MODEL_POLICY,
      scenes: {
        ...DEFAULT_MODEL_POLICY.scenes,
        "quest-plan": { tier: "L2" as const, billTo: "platform" as const },
      },
    };
    expect(await routeSmart(f.task, f.providers, f.sink, { policy }, now))
      .toMatchObject({ billTo: "platform" });
    expect(f.traces[0]).toMatchObject({
      bill_to: "platform",
      scene: "quest-plan",
      credits: 2,
    });
  });

  it("stops an already-aborted request before provider dispatch", async () => {
    const f = fixture();
    f.task.signal = AbortSignal.abort();
    expect(await routeSmart(f.task, f.providers, f.sink)).toMatchObject({
      kind: "unavailable",
      degraded: [{ reason: "模型调用已取消（调用方 abort）" }],
    });
    expect(f.calls).toHaveLength(0);
    expect(f.traces).toHaveLength(0);
    expect(f.breaks).toHaveLength(0);
  });

  it("fails closed when a caller supplies a non-canonical model pin", async () => {
    const f = fixture();
    f.task.forceModel = "kimi-k3";
    await expect(routeSmart(f.task, f.providers, f.sink)).rejects.toThrow("MODEL_ID_NOT_ALLOWED");
    expect(f.calls).toHaveLength(0);
  });
});
