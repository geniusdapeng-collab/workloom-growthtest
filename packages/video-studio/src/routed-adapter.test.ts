/**
 * v3.0 vendor 引擎收口测试：WorkloomLLMEngine 注入 router 后——
 * 全部调用经 routeSmart（preproduction 场景 + 真实计量留痕 + fastModel 强制 L1 + 失败可重试语义）
 */
import { createRequire } from "node:module";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MockProvider, type ChatMessage, type ChatOptions, type ModelProvider } from "@workloom/base/model-router";
import { WorkloomLLMEngine } from "./llm-adapter.js";

afterEach(() => vi.restoreAllMocks());

function memSink() {
  const traces: any[] = [];
  const degrades: any[] = [];
  return {
    traces,
    degrades,
    sink: {
      recordModelTrace: async (t: unknown) => { traces.push(t); },
      recordDegradation: async (d: unknown) => { degrades.push(d); },
      recordCircuitBreak: async () => undefined,
    },
  };
}

const engine = (sink: any, providers?: Map<string, MockProvider>) =>
  new WorkloomLLMEngine({
    baseUrl: "http://unused.local/v1",
    apiKey: "sk-test",
    model: "deepseek-flash",
    fastModel: "deepseek-flash",
    router: {
      providers: providers ?? new Map([
        ["deepseek-flash", new MockProvider("deepseek-flash")],
      ]),
      sink,
      scene: "video.preproduction.plan",
    },
  });

describe("vendor 引擎收口 routeSmart（preproduction 场景）", () => {
  it("reason() 经路由应答并写 model.call 计量（场景留痕）", async () => {
    const { sink, traces } = memSink();
    const r = await engine(sink).reason("写一条 15 秒种草短视频大纲");
    expect(r.success).toBe(true);
    expect(r.content).toContain("mock:");
    expect(traces.length).toBe(1);
    expect(traces[0]).toMatchObject({ scene: "video.preproduction.plan", bill_to: "tenant" });
  });

  it("fast and main calls both resolve to the same canonical model", async () => {
    const { sink, traces } = memSink();
    const e = engine(sink);
    await e.reason("主力调用");
    await e.reason("快速调用", { model: "deepseek-flash" });
    expect(traces.map((trace) => trace.model_id)).toEqual(["deepseek-flash", "deepseek-flash"]);
  });

  it("主模型故障只做同模型失败关闭，不切换其他厂商", async () => {
    const { sink, degrades } = memSink();
    const providers = new Map([
      ["deepseek-flash", new MockProvider("deepseek-flash", { failFirst: 99 })],
    ]);
    const r = await engine(sink, providers).reason("x");
    expect(r.success).toBe(false);
    expect(degrades.length).toBe(1);
    expect(degrades[0]).toMatchObject({ from: "deepseek-flash", to: null });
  });

  it("全链不可用 → success:false + retryable（vendor 熔断纪律接管，不静默）", async () => {
    const { sink } = memSink();
    const providers = new Map([
      ["deepseek-flash", new MockProvider("deepseek-flash", { failFirst: 99 })],
    ]);
    const r = await engine(sink, providers).reason("x");
    expect(r.success).toBe(false);
    expect(r.retryable).toBe(false);
  });

  it("reasonStructured 的 JSON 提取在路由路径上保持兼容", async () => {
    const { sink } = memSink();
    // Mock 应答非 JSON → extractJson 抛错 → success:false retryable（与旧路径同语义）
    const r = await engine(sink).reasonStructured("x", {});
    expect(r.success).toBe(false);
    expect(r.retryable).toBe(false);
  });
});

const STRUCTURE_MARKER = "【目标JSON结构示例】\n";

function structuredEngine(reply: string | ((messages: ChatMessage[]) => string)) {
  const requests: Array<{ messages: ChatMessage[]; options: ChatOptions }> = [];
  const { sink, traces } = memSink();
  const provider: ModelProvider = {
    modelId: "deepseek-flash",
    healthy: async () => true,
    chat: async (messages, options = {}) => {
      requests.push({ messages, options });
      const text = typeof reply === "function" ? reply(messages) : reply;
      return {
        text,
        promptTokens: 73,
        completionTokens: 29,
        modelId: "deepseek-flash",
        finishReason: "stop",
        reasoningTokens: 0,
        requestHash: "a".repeat(64),
        responseHash: "b".repeat(64),
        responseId: "fixture",
        scene: options.scene ?? "generic",
        mode: "enabled",
        effort: "high",
        outputCeiling: 393216,
        inputTokenEstimate: 73,
        imageCount: 0,
        policyVersion: "2026-10-30.1",
        registryVersion: "2026-10-30.1",
        attempts: [],
      };
    },
  };
  const adapter = new WorkloomLLMEngine({
    baseUrl: "http://unused.local/v1", apiKey: "test-only", model: "deepseek-flash",
    router: { providers: new Map([[provider.modelId, provider]]), sink, scene: "video.preproduction.plan" },
  });
  return { adapter, requests, traces };
}

function messageText(message: ChatMessage): string {
  return typeof message.content === "string"
    ? message.content
    : message.content.map((part) => part.type === "text" ? part.text : "").join("");
}

function schemaFromMessages(messages: ChatMessage[]) {
  const text = messageText(messages.at(-1)!);
  const marker = text.lastIndexOf(STRUCTURE_MARKER);
  expect(marker).toBeGreaterThanOrEqual(0);
  return JSON.parse(text.slice(marker + STRUCTURE_MARKER.length));
}

describe("结构化调用保留调用方真实输出合同", () => {
  it("路由请求携带原提示及完整嵌套模板，且不改写 schema 或返回数据", async () => {
    const schema = Object.freeze({
      required: Object.freeze(["shots"]),
      shots: Object.freeze([Object.freeze({
        shotId: "SC-05", fields: Object.freeze({ scene: "", dialogue: "", timeline: { beats: [] } }),
      })]),
    });
    const payload = { shots: [{ shotId: "SC-05", fields: { scene: "本次真实返回", dialogue: "" } }] };
    const raw = JSON.stringify(payload);
    const { adapter, requests, traces } = structuredEngine(raw);
    const result = await adapter.reasonStructured("原提示：保留\n每一行与标点。", schema);
    expect(requests).toHaveLength(1);
    expect(messageText(requests[0]!.messages.at(-1)!)).toMatch(/^原提示：保留\n每一行与标点。\n/);
    expect(schemaFromMessages(requests[0]!.messages)).toEqual(schema);
    expect(requests[0]!.options.responseFormat).toEqual({ type: "json_object" });
    expect(result).toMatchObject({ success: true, content: raw, data: payload });
    expect(result.data).toEqual(payload);
    expect(traces).toHaveLength(1);
  });

  it("保持调用方采样、预算、system prompt、thinking 与取消信号，不增加调用", async () => {
    const { adapter, requests } = structuredEngine('{"ok":true}');
    const controller = new AbortController();
    await adapter.reasonStructured("原文", { ok: true }, {
      systemPrompt: "调用方 system", temperature: 0.37, topP: 0.83, maxTokens: 12288,
      thinking: { type: "disabled" }, signal: controller.signal,
    });
    expect(requests).toHaveLength(1);
    expect(requests[0]!.messages[0]).toEqual({ role: "system", content: "调用方 system" });
    expect(requests[0]!.options).toMatchObject({
      topP: 0.83, thinking: { type: "enabled", effort: "high" }, responseFormat: { type: "json_object" },
    });
    expect(requests[0]!.options.maxTokens).toBeUndefined();
    expect(requests[0]!.options.temperature).toBeUndefined();
    expect(requests[0]!.options.signal?.aborted).toBe(false);
    controller.abort();
    expect(requests[0]!.options.signal?.aborted).toBe(true);
  });

  it("直连路径传递相同完整结构及实际 model，保留原始 content/usage", async () => {
    const calls: Array<Record<string, any>> = [];
    const raw = '{"shots":[{"shotId":"镜-02","fields":{"scene":"光线"}}]}';
    vi.spyOn(globalThis, "fetch").mockImplementation(async (_url, init) => {
      calls.push(JSON.parse(String(init?.body)));
      return new Response(JSON.stringify({
        id: "fixture",
        model: "deepseek-flash",
        choices: [{ finish_reason: "stop", message: { content: raw } }],
        usage: {
          prompt_tokens: 7,
          completion_tokens: 5,
          total_tokens: 12,
          completion_tokens_details: { reasoning_tokens: 0 },
        },
      }), { status: 200 });
    });
    const adapter = new WorkloomLLMEngine({ baseUrl: "http://unused.local/v1", apiKey: "test-only", model: "deepseek-flash" });
    const schema = { shots: [{ shotId: "镜-02", fields: { scene: "", quote: '空值与"引号"\n换行' } }] };
    const result = await adapter.reasonStructured("原始需求", schema, { maxTokens: 4096, temperature: 0.4 });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ model: "deepseek-flash", thinking: { type: "enabled" },
      reasoning_effort: "high", response_format: { type: "json_object" } });
    expect(schemaFromMessages(calls[0]!.messages)).toEqual(schema);
    expect(result).toMatchObject({ success: true, content: raw,
      usage: { promptTokens: 7, completionTokens: 5 } });
  });

  it("未提供结构的旧调用仍保持原接口兼容，不补造字段", async () => {
    const { adapter, requests } = structuredEngine('{"unchanged":true}');
    const result = await adapter.reasonStructured("旧调用", undefined);
    expect(result.data).toEqual({ unchanged: true });
    expect(requests).toHaveLength(1);
    expect(messageText(requests[0]!.messages.at(-1)!)).toMatch(/^旧调用\n/);
  });

  it("不可序列化的结构明确失败且不提交模型请求", async () => {
    const { adapter, requests } = structuredEngine('{"unused":true}');
    const schema: Record<string, unknown> = {};
    schema.self = schema;
    const result = await adapter.reasonStructured("原文", schema);
    expect(result).toMatchObject({ success: false, retryable: false });
    expect(result.error).toContain("结构化输出结构不可序列化");
    expect(requests).toHaveLength(0);
  });

  it("JSON 解析失败沿用失败结果，既不填字段也不额外重试", async () => {
    const { adapter, requests } = structuredEngine("不是 JSON");
    const result = await adapter.reasonStructured("原文", { shots: [] });
    expect(result).toMatchObject({ success: false, retryable: false });
    expect(result.data).toBeUndefined();
    expect(result.error).toContain("JSON 解析失败");
    expect(requests).toHaveLength(1);
  });

  it("HTTP 失败保持原错误与可重试标记，不产生替代响应", async () => {
    const fetch = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("rate limited", { status: 429 }));
    const adapter = new WorkloomLLMEngine({ baseUrl: "http://unused.local/v1", apiKey: "test-only", model: "deepseek-flash" });
    const result = await adapter.reasonStructured("原文", { shots: [] });
    expect(result.success).toBe(false);
    expect(result.error).toContain("HTTP 429");
    expect(result.retryable).toBe(false);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("返回镜号或字段不符时保留实际响应，交由原消费者判定", async () => {
    const payload = { shots: [{ shotId: "SC01", fields: {} }] };
    const { adapter, requests } = structuredEngine(JSON.stringify(payload));
    const result = await adapter.reasonStructured("原文", { shots: [{ shotId: "SC-05", fields: { scene: "" } }] });
    expect(result.data).toEqual(payload);
    expect(requests).toHaveLength(1);
  });
});

const vendorRequire = createRequire(import.meta.url);
const { PromptFusionAgent } = vendorRequire("../../../vendor/supermickey/hyperreality-system/engines/production-engine/agents/prompt-fusion-agent.js");
const FUSION_FIELD_NAMES = [
  "director_instruction", "constraint", "baseline", "scene", "lighting", "composition", "color_palette",
  "depth_of_field", "camera_movement", "character", "costume", "makeup", "action", "props", "portraits",
  "dialogue", "timeline", "mood", "pacing", "transition", "audio", "negative", "bright_constraint",
  "character_constraint", "consistency",
];

function fusionFields() {
  return Object.fromEntries(FUSION_FIELD_NAMES.map(name => [name,
    `离线结构接口用例的${name}字段。稳定构图与自然光线，人物保持原地，完整保留空间关系。`.repeat(16),
  ]));
}

async function fuseThroughAdapter(reply: string | ((messages: ChatMessage[]) => string)) {
  const capture = structuredEngine(reply);
  const agent = new PromptFusionAgent({ semanticRefinement: false, llmMaxRetries: 1, llmTimeout: 300000 });
  agent._llmEngine = capture.adapter;
  agent._llmEngineLoaded = true;
  const shot = { shotId: "SC-05", sceneType: "dialogue", duration: 6, scene: "安静庭院中的完整人物中景", characters: ["offline-character"] };
  const result = await agent._fuseSingleShot(shot, "9:16", [{ id: "offline-character", name: "离线测试人物" }], { scenes: [shot] }, 300000);
  return { ...capture, result };
}

describe("真实 PromptFusion 消费宿主结构化接口", () => {
  it("实际 SC-05 与全部 25 个字段模板抵达 provider，一次真实消费返回非降级结果", async () => {
    const { requests, result } = await fuseThroughAdapter(messages => {
      const schema = schemaFromMessages(messages);
      expect(schema.required).toEqual(["shots"]);
      expect(schema.requiredArrays).toEqual(["shots"]);
      expect(schema.rejectEmptyArray).toBe(true);
      expect(schema.shots).toHaveLength(1);
      expect(schema.shots[0].shotId).toBe("SC-05");
      expect(Object.keys(schema.shots[0].fields)).toEqual(FUSION_FIELD_NAMES);
      expect(Object.values(schema.shots[0].fields).every(value => value === "")).toBe(true);
      return JSON.stringify({ shots: [{ shotId: "SC-05", fields: fusionFields() }] });
    });
    expect(requests).toHaveLength(1);
    expect(result.shotId).toBe("SC-05");
    expect(result.degraded).toBe(false);
    expect(result.degradeReason).toBeNull();
    expect(result.fields.scene).toContain("离线结构接口用例");
    expect(requests[0]!.options.maxTokens).toBeUndefined();
  });

  it.each([
    ["模板示例镜号", "SC01"],
    ["缺失镜号", undefined],
  ])("%s 的非空模型结果仍降级，不改写镜号过关", async (_label, returnedId) => {
    const fields = fusionFields();
    const payload = { shots: [{ ...(returnedId === undefined ? {} : { shotId: returnedId }), fields }] };
    const { result, requests } = await fuseThroughAdapter(JSON.stringify(payload));
    expect(requests).toHaveLength(1);
    expect(result.degraded).toBe(true);
    expect(result.shotId).toBe("SC-05");
    expect(result.fields?.scene).not.toContain("离线结构接口用例");
  });
});
