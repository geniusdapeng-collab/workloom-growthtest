import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { resetCircuit } from "@workloom/base/model-router";
import { installVendorEngineBridge, WorkloomLLMEngine } from "./llm-adapter.js";
import { installVendorPhase3FusionBridge } from "./vendor-compat.js";
import { videoRuntimeRoot } from "./runtime-root.js";

type Row = Record<string, unknown>;
const root = videoRuntimeRoot(import.meta.url);
const require = createRequire(import.meta.url);
const { BaseAgent } = require(resolve(root,
  "vendor/supermickey/hyperreality-system/engines/production-engine/agents/base-agent.js"));
const { Phase3PromptFusion } = require(resolve(root,
  "vendor/supermickey/hyperreality-system/engines/production-engine/phases/phase-3-prompt-fusion.js"));
const contract = `保持完整源合同：${"先检查扣带，再把工具放回工作台；不得改写动作顺序。".repeat(80)}`;
const schema = { required: ["answer"] };
const completion = (id: string, content: string, measured = true) => Response.json({
  id, model: "deepseek-flash", choices: [{ finish_reason: "stop", message: { content } }],
  ...(measured ? { usage: { prompt_tokens: 120, completion_tokens: 25, total_tokens: 145 } } : {}),
});

async function runFusion(respond: (attempt: number) => Response | Promise<Response>, marketing = false) {
  const wire: Array<{ model: string; messages: Array<{ content: string }> }> = [];
  const timeouts: number[] = [];
  const fetchImpl = vi.fn<typeof fetch>(async (_input, init) => {
    wire.push(JSON.parse(String(init?.body)));
    return respond(wire.length);
  });
  const engine = new WorkloomLLMEngine({ baseUrl: "https://phase3-fixture.example.invalid/v1",
    apiKey: randomUUID(), model: "deepseek-flash", fetchImpl });
  const restoreEngine = installVendorEngineBridge(engine);
  const restorePhase = installVendorPhase3FusionBridge();
  const agent = new BaseAgent({ name: "PromptFusionAgent", llmTimeout: 5_000, llmMaxRetries: 1 });
  // The skill selector is outside this test's author boundary. The production
  // call below uses the actual BaseAgent, adapter, provider and failure return.
  agent._callLLM = function (this: unknown, prompt: unknown, target: Row, fallback: unknown, options: unknown) {
    if (Array.isArray(target.required) && target.required.includes("picks")) {
      return Promise.resolve({ result: { picks: [] }, degraded: false });
    }
    return BaseAgent.prototype._callLLM.call(this, prompt, target, fallback, options);
  };
  agent._callWithTimeout = function (this: unknown, promise: unknown, ms: number, label: string) {
    timeouts.push(ms);
    return BaseAgent.prototype._callWithTimeout.call(this, promise, ms, label);
  };
  agent.process = async function (this: { _callLLM: (...args: unknown[]) => Promise<Row>; _currentShotIdx?: number }, shots: Row[]) {
    if (marketing) this._currentShotIdx = 0;
    const authored = await this._callLLM(contract, schema, () => { throw new Error("LLM fallback"); },
      { critical: true, maxRetries: 1, timeoutMs: 5_000 });
    if (authored.degraded || (authored.result as Row)?.answer !== "完整原生作者结果") {
      throw new Error("fixture author unavailable");
    }
    // The marketing case observes the real author request and settled retry;
    // it deliberately stops before unrelated final field/production admission.
    if (marketing) throw new Error("MARKETING_JSON_CONTEXT_AUTHOR_BOUNDARY");
    return { shots: shots.map(shot => ({ ...shot,
      prompt: "01.【场景】湖面薄雾缓慢散开，固定机位连续记录水面涟漪与远山倒影。", degraded: false })),
      degraded: false, stats: { failed: 0 } };
  };
  const phase = new Phase3PromptFusion({ agents: { promptFusion: agent }, cloneShots: structuredClone,
    mergeShots: (_base: Row[], updated: Row[]) => updated, logFn: () => {}, saveCheckpoint: async () => {} });
  const state = { shots: [{ shotId: "S1", scene: "清晨湖面薄雾与远山倒影。", duration: 5, characters: [] }],
    adaptedBlueprint: { config: { aspectRatio: "9:16", target_duration: 5 },
      ...(marketing ? { _workloomMarketingFieldWriterPolicy: "native-marketing-field-authority/v2" } : {}),
      character_system: { characters: [] }, meta: { _metadata: { dialogueRequirement: "无人物、无对白。",
        ...(marketing ? { _prd: { _workloomMarketingPrompt: { actions: [], overlay: [], endCard: [] } } } : {}) } } },
    result: { stages: {}, llmStats: {} } };
  try {
    const result = await phase.execute(state).then((value: Row) => ({ value }), (error: unknown) => ({ error }));
    return { result, wire, timeouts, unknown: engine.hasUnknownOutcome() };
  } finally { restorePhase(); restoreEngine(); }
}

afterEach(() => { vi.useRealTimers(); resetCircuit(); });

it("corrects the actual BaseAgent degraded parse result once with a distinct same-model author", async () => {
  const { result, wire, timeouts, unknown } = await runFusion(attempt => completion(`phase3-${attempt}`,
    attempt === 1 ? "没有形成 JSON 对象" : JSON.stringify({ answer: "完整原生作者结果" })));
  expect(result).toHaveProperty("value.success", true);
  expect(wire.map(row => row.model)).toEqual(["deepseek-flash", "deepseek-flash"]);
  expect(wire.every(row => JSON.stringify(row.messages).includes(contract))).toBe(true);
  expect(JSON.stringify(wire[1]?.messages)).toContain("严格只输出一个完整合法 JSON 对象");
  expect(timeouts).toEqual([5_000, 5_000]);
  expect(unknown).toBe(false);
});

it("keeps exactly one identical marketing continuity context on the original request and same-model JSON correction", async () => {
  const { result, wire, timeouts, unknown } = await runFusion(attempt => completion(`marketing-context-${attempt}`,
    attempt === 1 ? "没有形成 JSON 对象" : JSON.stringify({ answer: "完整原生作者结果" })), true);
  expect(String((result as { error?: unknown }).error)).toContain("MARKETING_JSON_CONTEXT_AUTHOR_BOUNDARY");
  const marker = "【本轮跨镜作者上下文】\n";
  const texts = wire.map(row => row.messages.map(message => message.content).join("\n"));
  const contexts = texts.map(text => {
    expect(text.split(marker)).toHaveLength(2);
    expect(text).toContain(contract);
    const start = text.indexOf(marker) + marker.length;
    const end = text.indexOf("\n【跨镜执行边界】", start);
    expect(end).toBeGreaterThan(start);
    return JSON.parse(text.slice(start, end)) as Row;
  });
  expect(contexts).toHaveLength(2);
  expect(contexts[1]).toEqual(contexts[0]);
  expect(contexts[0]).toMatchObject({ targetShotId: "S1", mode: "serial", authoredDrafts: [] });
  expect(texts[1]).toContain("严格只输出一个完整合法 JSON 对象");
  expect(wire.map(row => row.model)).toEqual(["deepseek-flash", "deepseek-flash"]);
  expect(timeouts).toEqual([5_000, 5_000]);
  expect(unknown).toBe(false);
});

it.each(["missing-usage", "http", "unknown-first", "unknown-second", "invalid-again", "same-response"])(
  "%s cannot create another unverified author correction", async mode => {
    const { result, wire } = await runFusion(attempt => {
      if (mode === "unknown-first" || (mode === "unknown-second" && attempt === 2)) throw new TypeError("fixture connection interrupted");
      if (mode === "http") return Response.json({ error: { message: "JSON 解析失败: synthetic HTTP rejection" } }, { status: 403 });
      const content = mode === "same-response" && attempt === 2 ? JSON.stringify({ answer: "完整原生作者结果" }) : "未返回完整 JSON";
      return completion(mode === "same-response" ? "unchanged-response" : `failure-${attempt}`, content, mode !== "missing-usage");
    });
    expect(result).toHaveProperty("error");
    expect(wire).toHaveLength(["unknown-second", "invalid-again", "same-response"].includes(mode) ? 2 : 1);
  },
);

it("gives the settled correction a separate real BaseAgent timer", async () => {
  vi.useFakeTimers();
  let firstStarted!: () => void;
  let secondStarted!: () => void;
  const firstRequest = new Promise<void>(resolveStarted => { firstStarted = resolveStarted; });
  const secondRequest = new Promise<void>(resolveStarted => { secondStarted = resolveStarted; });
  const running = runFusion(async attempt => {
    (attempt === 1 ? firstStarted : secondStarted)();
    await new Promise(resolveDelay => setTimeout(resolveDelay, 4_000));
    return completion(`separate-${attempt}`, attempt === 1 ? "无 JSON" : JSON.stringify({ answer: "完整原生作者结果" }));
  });
  // Each request finishes within5s, while the pair takes8s. A correction nested
  // inside the first BaseAgent timer would fail before its second response.
  await firstRequest;
  await vi.advanceTimersByTimeAsync(4_001);
  await secondRequest;
  await vi.advanceTimersByTimeAsync(4_001);
  const { result, wire, timeouts, unknown } = await running;
  expect(result).toHaveProperty("value.success", true);
  expect(wire).toHaveLength(2);
  expect(timeouts).toEqual([5_000, 5_000]);
  expect(unknown).toBe(false);
});
