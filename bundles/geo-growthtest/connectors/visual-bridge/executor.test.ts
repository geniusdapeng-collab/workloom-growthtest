import { describe, expect, it, vi } from "vitest";
import {
  createVisualBridgeExecutor,
  isVisualBridgeTool,
  VisualBridgeError,
  VISUAL_BRIDGE_TOOLS,
} from "./executor";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function bodyOf(init: RequestInit): Record<string, unknown> {
  const parsed = JSON.parse(String(init.body)) as { tool: string; params: Record<string, unknown> };
  return parsed.params;
}

describe("visual bridge executor v0.2", () => {
  it("声明工具面；未知工具在软失败模式下回未核实", async () => {
    expect(VISUAL_BRIDGE_TOOLS).toContain("visualwrite.compose");
    expect(isVisualBridgeTool("browser.goto")).toBe(false);
    const fetchImpl = vi.fn();
    const executor = createVisualBridgeExecutor({ baseUrl: "http://127.0.0.1:9773", token: "t", fetchImpl });
    const outcome = await executor("browser.goto", {});
    expect(outcome.receipt.synced).toBe(false);
    expect(outcome.result.error).toBe("not_provided");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("严格模式下未知工具抛错", async () => {
    const executor = createVisualBridgeExecutor({
      baseUrl: "http://127.0.0.1:9773", token: "t", softFailures: false, fetchImpl: vi.fn(),
    });
    await expect(executor("browser.goto", {})).rejects.toMatchObject({ code: "not_provided" });
  });

  it("成功调用：Bearer + tenant_id + 自动幂等键 + 回执透传", async () => {
    const fetchImpl = vi.fn(async (url: string, init: RequestInit) => {
      expect(url).toBe("http://127.0.0.1:9773/action");
      expect((init.headers as Record<string, string>).authorization).toBe("Bearer secret");
      const params = bodyOf(init);
      expect(params.tenant_id).toBe("ws-geo");
      expect(String(params.idempotency_key)).toMatch(/^prod-visual-[0-9a-f]{16}$/);
      expect(params.recipe).toEqual({ name: "r" });
      return jsonResponse({
        ok: true,
        result: { project: "/tmp/a.comp" },
        receipt: { synced: true, snapshot_uri: "file:///tmp/a.png", sha256: "abc", verified_at: "2026-09-19T00:00:00Z" },
      });
    });
    const executor = createVisualBridgeExecutor({
      baseUrl: "http://127.0.0.1:9773/", token: "secret", tenantId: "ws-geo",
      idempotencyPrefix: "prod-visual", fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    const outcome = await executor("visualwrite.compose", { recipe: { name: "r" } });
    expect(outcome.result.project).toBe("/tmp/a.comp");
    expect(outcome.receipt).toMatchObject({ synced: true, sha256: "abc" });
  });

  it("相同 tool+params 生成相同幂等键，参数变化则键变化", async () => {
    const keys: string[] = [];
    const fetchImpl = vi.fn(async (_url: string, init: RequestInit) => {
      keys.push(String(bodyOf(init).idempotency_key));
      return jsonResponse({ ok: true, result: {}, receipt: { synced: true } });
    });
    const executor = createVisualBridgeExecutor({
      baseUrl: "http://127.0.0.1:9773", token: "t", tenantId: "ws-geo",
      idempotencyPrefix: "p", fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    await executor("visualwrite.render", { project: "/a.comp", output: "/a.png" });
    await executor("visualwrite.render", { output: "/a.png", project: "/a.comp" });
    await executor("visualwrite.render", { project: "/a.comp", output: "/b.png" });
    expect(keys[0]).toBe(keys[1]);
    expect(keys[0]).not.toBe(keys[2]);
  });

  it("所有端点不可用 → 软失败回执（不抛异常），附尝试记录", async () => {
    const fetchImpl = vi.fn(async () => { throw new Error("connect ECONNREFUSED"); });
    const executor = createVisualBridgeExecutor({
      baseUrl: ["http://a:9773", "http://b:9773"], token: "t",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    const outcome = await executor("visualwrite.compose", { recipe: {} });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(outcome.receipt.synced).toBe(false);
    expect(outcome.result.error).toBe("network_error");
    expect((outcome.result.attempts as unknown[]).length).toBe(2);
  });

  it("多端点故障转移：第一个网络失败，第二个成功", async () => {
    const fetchImpl = vi.fn(async (url: string) => {
      if (url.startsWith("http://a")) throw new Error("ECONNREFUSED");
      return jsonResponse({ ok: true, result: { via: url }, receipt: { synced: true } });
    });
    const executor = createVisualBridgeExecutor({
      baseUrl: ["http://a:9773", "http://b:9773"], token: "t",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    const outcome = await executor("visualwrite.compose", { recipe: {} });
    expect(outcome.receipt.synced).toBe(true);
    expect(outcome.result.via).toBe("http://b:9773/action");
  });

  it("业务性错误（配额超限）不重试、不换端点，软失败保留错误码", async () => {
    const fetchImpl = vi.fn(async (url: string) =>
      url.startsWith("http://a")
        ? jsonResponse({ ok: false, error: "quota_exceeded", message: "quota 3/3" }, 400)
        : jsonResponse({ ok: true, result: {}, receipt: { synced: true } }));
    const executor = createVisualBridgeExecutor({
      baseUrl: ["http://a:9773", "http://b:9773"], token: "t",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    const outcome = await executor("visualwrite.text", { output: "x.png" });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(outcome.receipt.synced).toBe(false);
    expect(outcome.result.error).toBe("quota_exceeded");
  });

  it("严格模式下业务错误抛出具名错误", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ ok: false, error: "engine_failed", message: "render failed" }, 400));
    const executor = createVisualBridgeExecutor({
      baseUrl: "http://127.0.0.1:9773", token: "t", softFailures: false,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    await expect(executor("visualwrite.render", {})).rejects.toMatchObject({ code: "engine_failed" });
  });

  it("缺回执按未核实返回，不伪造 synced", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ ok: true, result: { note: "no receipt" } }));
    const executor = createVisualBridgeExecutor({
      baseUrl: "http://127.0.0.1:9773", token: "t", fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    const outcome = await executor("visualread.inspect", { project: "/tmp/a.comp" });
    expect(outcome.receipt).toEqual({ synced: false });
  });

  it("超时映射为 timeout 并进入软失败", async () => {
    const fetchImpl = vi.fn((_url: string, init: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init.signal?.addEventListener("abort", () => {
        const error = new Error("aborted");
        error.name = "AbortError";
        reject(error);
      });
    }));
    const executor = createVisualBridgeExecutor({
      baseUrl: "http://127.0.0.1:9773", token: "t", timeoutMs: 5,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    const outcome = await executor("visualread.health", {});
    expect(outcome.receipt.synced).toBe(false);
    expect(outcome.result.error).toBe("timeout");
    expect(VisualBridgeError).toBeDefined();
  });
});
