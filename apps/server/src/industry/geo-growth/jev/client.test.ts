import { describe, expect, it } from "vitest";
import {
  JevClient,
  JevError,
  apiKeyFromEnv,
  clientFromEnv,
  defaultBaseUrl,
  defaultModel,
  resolveProvider,
} from "./client.js";
import { createMockFetch } from "./mock-gateway.js";
import type { JevRequest } from "./types.js";

const request: JevRequest = {
  state: {
    comment: "我想订一间房",
    official_claims: ["支持在线预订"],
  },
  questions: {
    intent: {
      type: "choice",
      instructions: "Classify the customer intent.",
      criteria: {
        inquiry: "A general question",
        booking_intent: "A clear booking intent",
        complaint: "A complaint",
        smalltalk: "Small talk",
        spam: "Spam",
      },
    },
    intent_strength: {
      type: "score",
      instructions: "Score booking intent strength.",
      criteria: ["none", "weak", "strong"],
    },
    unsupported_claim: {
      type: "boolean",
      instructions: "Does the draft add an unsupported claim?",
    },
  },
};

function client(fetchImpl: typeof fetch = createMockFetch().fetchImpl): JevClient {
  return new JevClient({
    apiKey: "test-only",
    baseUrl: "https://api.deepseek.com",
    fetchImpl,
  });
}

describe("JevClient on text.primary", () => {
  it("uses the canonical model and parses typed answers", async () => {
    const resolved = client();
    expect(resolved.providerId).toBe("deepseek");
    expect(resolved.modelId).toBe("deepseek-flash");
    const result = await resolved.evaluate(request);
    expect(result.model).toBe("deepseek-flash");
    expect(result.byId.intent).toMatchObject({
      type: "choice",
      choice: "booking_intent",
    });
    expect(result.byId.intent_strength).toMatchObject({ type: "score" });
    expect(result.byId.unsupported_claim).toMatchObject({ type: "boolean" });
    expect(result.inputTokens).toBeGreaterThan(0);
    expect(result.outputTokens).toBeGreaterThan(0);
  });

  it("retries only the same canonical model on 429", async () => {
    const mock = createMockFetch({ failFirstRequests: 1, failStatuses: [429] });
    const result = await client(mock.fetchImpl).evaluate(request);
    expect(result.model).toBe("deepseek-flash");
    expect(mock.calls()).toBe(2);
  });

  it("does not retry a 500 response whose execution is unknown", async () => {
    const mock = createMockFetch({ failFirstRequests: 1, failStatuses: [500] });
    await expect(client(mock.fetchImpl).evaluate(request)).rejects.toMatchObject({
      code: "server",
      retryable: false,
    });
    expect(mock.calls()).toBe(1);
  });

  it("rejects a returned model identity different from deepseek-flash", async () => {
    const fetchImpl = (async () => new Response(JSON.stringify({
      id: "wrong",
      model: "kimi-k3",
      choices: [{ finish_reason: "stop", message: { content: '{"answers":{}}' } }],
      usage: {
        prompt_tokens: 1,
        completion_tokens: 1,
        total_tokens: 2,
        completion_tokens_details: { reasoning_tokens: 0 },
      },
    }), { status: 200 })) as typeof fetch;
    await expect(client(fetchImpl).evaluate(request)).rejects.toMatchObject({
      code: "invalid_response",
    });
  });

  it("fails closed on malformed JSON and invalid answer shapes", async () => {
    const malformed = (async () => new Response(JSON.stringify({
      id: "fixture",
      model: "deepseek-flash",
      choices: [{ finish_reason: "stop", message: { content: "not json" } }],
      usage: {
        prompt_tokens: 1,
        completion_tokens: 1,
        total_tokens: 2,
        completion_tokens_details: { reasoning_tokens: 0 },
      },
    }), { status: 200 })) as typeof fetch;
    await expect(client(malformed).evaluate(request)).rejects.toMatchObject({
      code: "invalid_response",
    });
  });

  it("rejects retired providers and noncanonical model pins", () => {
    expect(() => new JevClient({
      apiKey: "test-only",
      provider: "typesafe" as never,
    })).toThrow(JevError);
    expect(() => new JevClient({
      apiKey: "test-only",
      model: "jev-latest",
    })).toThrow("MODEL_ID_NOT_ALLOWED");
  });
});

describe("environment resolution", () => {
  it("accepts only deepseek and resolves DeepSeek credentials", () => {
    expect(resolveProvider({ JEV_PROVIDER: "deepseek" })).toBe("deepseek");
    expect(() => resolveProvider({ JEV_PROVIDER: "vercel-gateway" })).toThrow(/只接受 deepseek/);
    expect(apiKeyFromEnv({ DEEPSEEK_API_KEY: "ds" })).toBe("ds");
    expect(apiKeyFromEnv({ LLM_API_KEY: "llm" })).toBe("llm");
    expect(defaultBaseUrl()).toBe("https://api.deepseek.com");
    expect(defaultModel()).toBe("deepseek-flash");
  });

  it("builds a canonical client from LLM_* variables", () => {
    const built = clientFromEnv({
      LLM_BASE_URL: "https://api.deepseek.com",
      LLM_API_KEY: "test-only",
      LLM_MODEL: "deepseek-flash",
      JEV_TIMEOUT_MS: "600000",
    });
    expect(built.modelId).toBe("deepseek-flash");
    expect(built.providerId).toBe("deepseek");
    expect(built.host).toBe("api.deepseek.com");
  });
});
