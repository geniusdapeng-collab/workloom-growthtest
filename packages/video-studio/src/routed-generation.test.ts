import { createServer, type Server } from "node:http";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WorkloomLLMEngine, installVendorEngineBridge } from "./llm-adapter.js";

const repoRoot = fileURLToPath(new URL("../../../", import.meta.url));
let server: Server;
let origin: string;
let bodies: Array<Record<string, unknown>>;
let reply = '{"ok":true}';
let status = 200;
let delayMs = 0;

beforeEach(async () => {
  bodies = [];
  reply = '{"ok":true}';
  status = 200;
  delayMs = 0;
  server = createServer(async (request, response) => {
    if (request.url === "/models") {
      response.writeHead(200);
      response.end("{}");
      return;
    }
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    bodies.push(JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>);
    if (delayMs) await new Promise((resolve) => setTimeout(resolve, delayMs));
    if (status !== 200) {
      response.writeHead(status, { "content-type": "application/json" });
      response.end('{"error":{"message":"fixture failure"}}');
      return;
    }
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({
      id: "fixture-response",
      model: "deepseek-flash",
      choices: [{ finish_reason: "stop", message: { content: reply } }],
      usage: {
        prompt_tokens: 100,
        completion_tokens: 30,
        total_tokens: 130,
        completion_tokens_details: { reasoning_tokens: 10 },
      },
    }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});

afterEach(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  vi.restoreAllMocks();
});

function engine(scene = "video.preproduction.plan", timeoutMs = 180_000): WorkloomLLMEngine {
  return new WorkloomLLMEngine({
    baseUrl: origin,
    apiKey: "local-test-only",
    model: "deepseek-flash",
    scene,
    timeoutMs,
    maxTokens: 1_024,
  });
}

describe("video adapter canonical dispatch", () => {
  it("uses the canonical model, scene thinking, JSON mode and full legal output window", async () => {
    const result = await engine().reason("Return JSON", {
      forceJson: true,
      maxTokens: 1_234,
      temperature: 0,
      topP: 0.8,
    });
    expect(result).toMatchObject({
      success: true,
      data: { ok: true },
      usage: { promptTokens: 100, completionTokens: 30 },
    });
    expect(bodies).toHaveLength(1);
    expect(bodies[0]).toMatchObject({
      model: "deepseek-flash",
      thinking: { type: "enabled" },
      reasoning_effort: "high",
      response_format: { type: "json_object" },
      top_p: 0.95,
    });
    expect(bodies[0]!.max_tokens).toBeGreaterThan(300_000);
    expect(bodies[0]).not.toHaveProperty("temperature");
  });

  it("deterministic scene uses explicit disabled thinking", async () => {
    await engine("video.deterministic").reason("classify", {
      forceJson: true,
      temperature: 0,
    });
    expect(bodies[0]).toMatchObject({
      thinking: { type: "disabled" },
      temperature: 0,
      response_format: { type: "json_object" },
    });
    expect(bodies[0]).not.toHaveProperty("reasoning_effort");
  });

  it("malformed structured output fails closed without a repair request", async () => {
    reply = "not json";
    const result = await engine().reasonStructured("x", { ok: true });
    expect(result).toMatchObject({ success: false, retryable: false });
    expect(result.error).toContain("JSON 解析失败");
    expect(bodies).toHaveLength(1);
  });

  it("provider HTTP errors stay explicit and are not silently retried", async () => {
    status = 500;
    const result = await engine().reason("x");
    expect(result).toMatchObject({ success: false, retryable: false });
    expect(result.error).toContain("HTTP 500");
    expect(bodies).toHaveLength(1);
  });

  it("caller timeout reaches the HTTP request and fails closed", async () => {
    delayMs = 100;
    const result = await engine("video.preproduction.plan", 20).reason("x");
    expect(result.success).toBe(false);
    expect(result.error).toContain("超时");
  });

  it("caller abort cancels the request", async () => {
    delayMs = 100;
    const controller = new AbortController();
    const pending = engine().reason("x", { signal: controller.signal });
    setTimeout(() => controller.abort(), 20);
    const result = await pending;
    expect(result.success).toBe(false);
    expect(result.error).toContain("取消");
  });

  it("vendor bridge delegates reason/chat/structured to the same adapter and model", async () => {
    const adapter = engine();
    const restore = installVendorEngineBridge(adapter);
    try {
      const vendorRequire = createRequire(`${repoRoot}/package.json`);
      const { LLMEngine } = vendorRequire(`${repoRoot}/vendor/supermickey/systems/llm-reasoning-engine.js`);
      const native = new LLMEngine({ model: "kimi-k3" });
      await native.reason("vendor reason");
      await native.chat("system", "vendor chat", 0.2);
      await native.reasonStructured("vendor structured", { ok: true });
    } finally {
      restore();
    }
    expect(bodies).toHaveLength(3);
    expect(bodies.every((body) => body.model === "deepseek-flash")).toBe(true);
  });
});
