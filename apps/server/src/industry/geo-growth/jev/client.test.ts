/**
 * 客户端单测：两条通道的请求形状 + 重试/退避/超时/鉴权/密钥安全（全部用假 fetch，不发外呼）。
 */
import { describe, expect, it } from "vitest";
import {
  GATEWAY_PATH,
  JevClient,
  JevError,
  TYPESAFE_PATH,
  apiKeyFromEnv,
  clientFromEnv,
  resolveProvider,
  toTypeSafeQuestions,
} from "./client.js";
import { createMockFetch } from "./mock-gateway.js";
import type { JevRequest } from "./types.js";

const REQUEST: JevRequest = {
  state: { comment: "想问一下你们房间多少钱一晚" },
  questions: {
    intent: {
      type: "choice",
      instructions: "Choose one",
      criteria: { inquiry: "asks", complaint: "unhappy", booking_intent: "books", smalltalk: "chat", spam: "ads" },
    },
  },
};

const noSleep = async (): Promise<void> => undefined;

describe("JevClient", () => {
  it("通道 2（默认，官方直连）：回答解析走本地模拟通道", async () => {
    const { fetchImpl } = createMockFetch();
    const client = new JevClient({ apiKey: "test-key", baseUrl: "https://example.test", fetchImpl });
    const result = await client.evaluate(REQUEST);
    expect(result.byId["intent"]?.choice).toBe("inquiry");
    expect(result.inputTokens).toBeGreaterThan(0);
    // 官方直连回答里是解析后的版本化 id（请求发的是别名 jev-latest）
    expect(result.model).toBe("jev-1.13.0");
    expect(client.providerId).toBe("typesafe");
  });

  it("通道 2 请求形状：/v1/systemone + Bearer + 请求体带 model，boolean 映射为官方原语 noul", async () => {
    let seenUrl = "";
    let seenHeaders: Record<string, string> = {};
    let seenBody: Record<string, unknown> = {};
    const fetchImpl = (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
      seenUrl = String(input);
      seenHeaders = {};
      for (const [key, value] of Object.entries(init?.headers ?? {})) seenHeaders[key.toLowerCase()] = String(value);
      seenBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return new Response(
        JSON.stringify({
          model: "jev-1.13.0",
          answers: {
            urgent: { type: "noul", noul: 0.93 },
          },
          usage: { input_tokens: 300, output_tokens: 24 },
        }),
        { status: 200 },
      );
    }) as typeof fetch;
    const client = new JevClient({ apiKey: "ts-key", baseUrl: "https://api.typesafe.ai", fetchImpl });
    await client.evaluate({
      state: { comment: "hi" },
      questions: {
        urgent: { type: "boolean", instructions: "Is it urgent?", criteria: { true: "yes", false: "no" } },
      },
    });
    expect(seenUrl).toBe(`https://api.typesafe.ai${TYPESAFE_PATH}`);
    expect(seenHeaders["authorization"]).toBe("Bearer ts-key");
    expect(seenHeaders["content-type"]).toBe("application/json");
    expect(seenHeaders["ai-gateway-protocol-version"]).toBeUndefined();
    expect(seenBody["model"]).toBe("jev-latest");
    const questions = seenBody["questions"] as Record<string, Record<string, unknown>>;
    expect(questions["urgent"]?.["type"]).toBe("noul");
    expect(questions["urgent"]?.["criteria"]).toEqual({ true: "yes", false: "no" });
  });

  it("toTypeSafeQuestions：boolean→noul，choice/score 原样透传", () => {
    const mapped = toTypeSafeQuestions({
      flag: { type: "boolean", instructions: "q" },
      pick: { type: "choice", instructions: "c", criteria: { a: "x", b: "y" } },
      rate: { type: "score", instructions: "s", criteria: ["low", "high"] },
    });
    expect(mapped["flag"]).toEqual({ type: "noul", instructions: "q" });
    expect(mapped["pick"]).toEqual({ type: "choice", instructions: "c", criteria: { a: "x", b: "y" } });
    expect(mapped["rate"]).toEqual({ type: "score", instructions: "s", criteria: ["low", "high"] });
  });

  it("通道 1（网关）：协议头按 evaluation v4 发送，请求体不带 model", async () => {
    let seenUrl = "";
    const seen: Record<string, string> = {};
    let seenBody: Record<string, unknown> = {};
    const fetchImpl = (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
      seenUrl = String(input);
      for (const [key, value] of Object.entries(init?.headers ?? {})) seen[key.toLowerCase()] = String(value);
      seenBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return new Response(JSON.stringify({ model: "typesafe-ai/jev", answers: { intent: { type: "choice", choice: "inquiry", probabilities: { inquiry: 1, complaint: 0, booking_intent: 0, smalltalk: 0, spam: 0 } } }, usage: {} }), { status: 200 });
    }) as typeof fetch;
    const client = new JevClient({
      apiKey: "test-key",
      provider: "vercel-gateway",
      baseUrl: "https://example.test",
      fetchImpl,
    });
    await client.evaluate(REQUEST);
    expect(seenUrl).toBe(`https://example.test${GATEWAY_PATH}`);
    expect(seen["ai-gateway-protocol-version"]).toBe("0.0.1");
    expect(seen["ai-evaluation-model-specification-version"]).toBe("4");
    expect(seen["ai-model-id"]).toBe("typesafe-ai/jev");
    expect(seenBody["model"]).toBeUndefined();
  });

  it("429 后重试直至成功", async () => {
    const { fetchImpl, calls } = createMockFetch({ failFirstRequests: 2, failStatuses: [429] });
    const client = new JevClient({
      apiKey: "k",
      baseUrl: "https://example.test",
      fetchImpl,
      maxAttempts: 3,
      sleepImpl: noSleep,
    });
    const result = await client.evaluate(REQUEST);
    expect(result.byId["intent"]?.choice).toBe("inquiry");
    expect(calls()).toBe(3);
  });

  it("持续 429 时抛出 rate_limited（可重试语义）", async () => {
    const { fetchImpl } = createMockFetch({ failFirstRequests: 99, failStatuses: [429] });
    const client = new JevClient({
      apiKey: "k",
      baseUrl: "https://example.test",
      fetchImpl,
      maxAttempts: 2,
      sleepImpl: noSleep,
    });
    await expect(client.evaluate(REQUEST)).rejects.toMatchObject({ code: "rate_limited", retryable: true });
  });

  it("529 过载同样按可重试处理", async () => {
    const { fetchImpl } = createMockFetch({ failFirstRequests: 1, failStatuses: [529] });
    const client = new JevClient({ apiKey: "k", baseUrl: "https://example.test", fetchImpl, maxAttempts: 2, sleepImpl: noSleep });
    const result = await client.evaluate(REQUEST);
    expect(result.byId["intent"]?.choice).toBe("inquiry");
  });

  it("401 立即失败且标记鉴权错误（不重试）", async () => {
    let calls = 0;
    const fetchImpl = (async () => {
      calls += 1;
      return new Response(JSON.stringify({ error: { message: "unauthorized" } }), { status: 401 });
    }) as typeof fetch;
    const client = new JevClient({ apiKey: "k", baseUrl: "https://example.test", fetchImpl, maxAttempts: 3, sleepImpl: noSleep });
    await expect(client.evaluate(REQUEST)).rejects.toMatchObject({ code: "auth", retryable: false });
    expect(calls).toBe(1);
  });

  it("超时（Abort）归类为 timeout", async () => {
    const hangingFetch = ((_input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => {
          const error = new Error("aborted");
          error.name = "AbortError";
          reject(error);
        });
      })) as typeof fetch;
    const client = new JevClient({
      apiKey: "k",
      baseUrl: "https://example.test",
      fetchImpl: hangingFetch,
      timeoutMs: 20,
      maxAttempts: 1,
      sleepImpl: noSleep,
    });
    await expect(client.evaluate(REQUEST)).rejects.toMatchObject({ code: "timeout", retryable: true });
  });

  it("非 JSON 响应归类为 invalid_response", async () => {
    const fetchImpl = (async () => new Response("<html>oops</html>", { status: 200 })) as typeof fetch;
    const client = new JevClient({ apiKey: "k", baseUrl: "https://example.test", fetchImpl });
    await expect(client.evaluate(REQUEST)).rejects.toMatchObject({ code: "invalid_response" });
  });

  it("缺少 key 且非本地地址时直接报 missing_key（不发请求）", async () => {
    let calls = 0;
    const fetchImpl = (async () => {
      calls += 1;
      return new Response("{}", { status: 200 });
    }) as typeof fetch;
    const client = new JevClient({ baseUrl: "https://ai-gateway.vercel.sh", fetchImpl });
    await expect(client.evaluate(REQUEST)).rejects.toMatchObject({ code: "missing_key" });
    expect(calls).toBe(0);
  });

  it("错误信息里不出现 API key", async () => {
    const fetchImpl = (async () => {
      throw new Error("socket hang up");
    }) as typeof fetch;
    const client = new JevClient({
      apiKey: "sk-super-secret-value",
      baseUrl: "https://example.test",
      fetchImpl,
      maxAttempts: 1,
      sleepImpl: noSleep,
    });
    try {
      await client.evaluate(REQUEST);
      throw new Error("should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(JevError);
      expect(String((error as Error).message)).not.toContain("sk-super-secret-value");
    }
  });

  it("422（问题结构非法）归类为 bad_request 且不重试", async () => {
    let calls = 0;
    const fetchImpl = (async () => {
      calls += 1;
      return new Response(JSON.stringify({ error: { message: "criteria is required" } }), { status: 422 });
    }) as typeof fetch;
    const client = new JevClient({ apiKey: "k", baseUrl: "https://api.typesafe.ai", fetchImpl, maxAttempts: 3, sleepImpl: noSleep });
    await expect(client.evaluate(REQUEST)).rejects.toMatchObject({ code: "bad_request", retryable: false });
    expect(calls).toBe(1);
  });
});

describe("通道判定（环境变量）", () => {
  it("显式 JEV_PROVIDER 优先，并接受简写", () => {
    expect(resolveProvider({ JEV_PROVIDER: "vercel-gateway", TYPESAFE_API_KEY: "ts" })).toBe("vercel-gateway");
    expect(resolveProvider({ JEV_PROVIDER: "direct" })).toBe("typesafe");
    expect(resolveProvider({ JEV_PROVIDER: "gateway" })).toBe("vercel-gateway");
  });

  it("按键推断：TYPESAFE_API_KEY → 直连；AI_GATEWAY_API_KEY → 网关；都没有 → 直连", () => {
    expect(resolveProvider({ TYPESAFE_API_KEY: "ts" })).toBe("typesafe");
    expect(resolveProvider({ AI_GATEWAY_API_KEY: "gw" })).toBe("vercel-gateway");
    expect(resolveProvider({ VERCEL_AI_GATEWAY_KEY: "gw" })).toBe("vercel-gateway");
    expect(resolveProvider({})).toBe("typesafe");
  });

  it("非法 JEV_PROVIDER 直接报错（不静默回退）", () => {
    expect(() => resolveProvider({ JEV_PROVIDER: "openai" })).toThrow(/未知 JEV_PROVIDER/);
  });

  it("各通道只读各自的密钥，默认地址/模型随通道切换", () => {
    const env = { TYPESAFE_API_KEY: "ts-key", AI_GATEWAY_API_KEY: "gw-key" };
    expect(apiKeyFromEnv(env, "typesafe")).toBe("ts-key");
    expect(apiKeyFromEnv(env, "vercel-gateway")).toBe("gw-key");
    const direct = clientFromEnv({ TYPESAFE_API_KEY: "ts-key" });
    expect(direct.providerId).toBe("typesafe");
    expect(direct.host).toBe("api.typesafe.ai");
    expect(direct.modelId).toBe("jev-latest");
    const gateway = clientFromEnv({ AI_GATEWAY_API_KEY: "gw-key" });
    expect(gateway.providerId).toBe("vercel-gateway");
    expect(gateway.host).toBe("ai-gateway.vercel.sh");
    expect(gateway.modelId).toBe("typesafe-ai/jev");
  });

  it("JEV_BASE_URL / JEV_MODEL 覆盖通道默认值（自建代理场景）", () => {
    const client = clientFromEnv({
      TYPESAFE_API_KEY: "ts-key",
      JEV_BASE_URL: "http://127.0.0.1:8787",
      JEV_MODEL: "jev-1.13.0",
    });
    expect(client.host).toBe("127.0.0.1:8787");
    expect(client.modelId).toBe("jev-1.13.0");
  });
});
