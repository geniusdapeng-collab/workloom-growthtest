import { createServer, type Server } from "node:http";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { OpenAiCompatibleProvider, type ChatOptions } from "./providers.js";

let server: Server;
let origin: string;
let bodies: Array<Record<string, unknown>>;
let mode: "ok" | "error" | "hang" | "hang-body";
beforeAll(async () => {
  server = createServer(async (req, res) => {
    if (req.url === "/models") { res.writeHead(200); res.end("{}"); return; }
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    bodies.push(JSON.parse(Buffer.concat(chunks).toString("utf8")));
    if (mode === "hang") return;
    if (mode === "hang-body") { res.writeHead(200, { "content-type": "application/json" }); res.flushHeaders(); res.write("{"); return; }
    if (mode === "error") { res.writeHead(400); res.end("unsupported"); return; }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({
      id: "provider-response",
      model: "deepseek-flash",
      choices: [{ finish_reason: "stop", message: { content: "provider answer" } }],
      usage: {
        prompt_tokens: 20,
        completion_tokens: 5,
        total_tokens: 25,
        completion_tokens_details: { reasoning_tokens: 0 },
      },
    }));
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});
afterAll(async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); });
beforeEach(() => { mode = "ok"; bodies = []; });
afterEach(() => { vi.restoreAllMocks(); });
const provider = () => new OpenAiCompatibleProvider("deepseek-flash", { baseUrl: origin });
const messages = [{ role: "user" as const, content: "联系 13812345678 查询" }];

describe("OpenAI-compatible generation controls at the HTTP boundary", () => {
  it("serializes the allowlist, preserves zero, masks PII and returns real usage", async () => {
    const result = await provider().chat(messages, {
      scene: "video.deterministic",
      temperature: 0, topP: 0, maxTokens: 8192, responseFormat: { type: "json_object" }, thinking: { type: "disabled" },
      model: "injected", apiKey: "test-only", credits: 0,
    } as ChatOptions);
    expect(bodies).toHaveLength(1);
    expect(bodies[0]).toMatchObject({ model: "deepseek-flash", messages: [{ role: "user", content: expect.stringMatching(/\[PII:PHONE:/) }],
      temperature: 0, top_p: 0, response_format: { type: "json_object" }, thinking: { type: "disabled" } });
    expect(bodies[0]!.max_tokens).toBeGreaterThan(8_192);
    expect(JSON.stringify(bodies)).not.toContain("13812345678");
    expect(result).toMatchObject({ text: "provider answer", promptTokens: 20, completionTokens: 5,
      modelId: "deepseek-flash", finishReason: "stop" });
  });
  it("standalone provider uses scene-policy thinking and full output window", async () => {
    await provider().chat([{ role: "user", content: "hello" }]);
    expect(bodies[0]).toMatchObject({
      model: "deepseek-flash",
      messages: [{ role: "user", content: "hello" }],
      thinking: { type: "enabled" },
      reasoning_effort: "high",
    });
    expect(bodies[0]!.max_tokens).toBeGreaterThan(300_000);
  });
  it("honors a resolved scene format override", async () => {
    await provider().chat(messages, {
      scene: "video.deterministic",
      responseFormat: { type: "text" },
      thinking: { type: "disabled" },
    });
    expect(bodies[0]).not.toHaveProperty("response_format");
    expect(bodies[0]).toMatchObject({ thinking: { type: "disabled" } });
  });
  it("retains HTTP errors instead of reporting an answer", async () => {
    mode = "error";
    await expect(provider().chat(messages)).rejects.toThrow("模型调用失败：HTTP 400");
  });
  it.each(["hang", "hang-body"] as const)("timeout aborts %s including response-body consumption", async nextMode => {
    mode = nextMode;
    await expect(provider().chat(messages, { timeoutMs: 30 })).rejects.toThrow("模型调用超时");
  });
  it.each(["hang", "hang-body"] as const)("caller abort cancels %s", async nextMode => {
    mode = nextMode;
    const controller = new AbortController();
    const promise = provider().chat(messages, { signal: controller.signal, timeoutMs: 10_000 });
    const rejection = expect(promise).rejects.toThrow("模型调用已取消（调用方 abort）");
    setTimeout(() => controller.abort(), 30);
    await rejection;
  });
  it("does not dispatch an already aborted request", async () => {
    const controller = new AbortController(); controller.abort();
    await expect(provider().chat(messages, { signal: controller.signal })).rejects.toThrow("调用方 abort");
    expect(bodies).toHaveLength(0);
  });
  it("passes a caller's 180s timeout to the actual provider without waiting 180s", async () => {
    const original = AbortSignal.timeout.bind(AbortSignal);
    const timeout = vi.spyOn(AbortSignal, "timeout").mockImplementation(ms => original(Math.min(ms, 1000)));
    await provider().chat(messages, { timeoutMs: 180_000 });
    expect(timeout).toHaveBeenCalledWith(180_000);
  });
});
