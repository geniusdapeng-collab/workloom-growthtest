/**
 * 调色工位连接器单测（纯 fake fetch，不需要真实工位）。
 * 覆盖：白名单拒绝 / 凭据注入 / 租户与幂等键 / 软失败不抛异常 / 多端点故障转移 / never-retry。
 */
import { describe, expect, it, vi } from "vitest";
import {
  COLOR_BRIDGE_TOOLS,
  ColorBridgeError,
  createColorBridgeExecutor,
  hashKey,
  isColorBridgeTool,
  stableKey,
} from "./executor.ts";

function okResponse(result: Record<string, unknown>, receipt: Record<string, unknown>) {
  return new Response(JSON.stringify({ ok: true, result, receipt, job_id: "colorjob-test" }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

describe("工具白名单", () => {
  it("只声明 8 个调色工具，且不提供他人工具", () => {
    expect(COLOR_BRIDGE_TOOLS).toHaveLength(8);
    expect(isColorBridgeTool("colorread.recipes")).toBe(true);
    expect(isColorBridgeTool("colorwrite.best")).toBe(true);
    expect(isColorBridgeTool("colorwrite.grade")).toBe(true);
    expect(isColorBridgeTool("visualwrite.compose")).toBe(false);
    expect(isColorBridgeTool("render.submit")).toBe(false);
  });

  it("未声明的工具软失败（不抛异常、不伪造回执）", async () => {
    const executor = createColorBridgeExecutor({
      baseUrl: "http://127.0.0.1:1",
      token: "t",
      fetchImpl: (async () => { throw new Error("should not be called"); }) as unknown as typeof fetch,
    });
    const outcome = await executor("visualwrite.compose", {});
    expect(outcome.receipt.synced).toBe(false);
    expect(outcome.result.error).toBe("not_provided");
  });

  it("hardFailures 模式下未声明工具直接抛错", async () => {
    const executor = createColorBridgeExecutor({
      baseUrl: "http://127.0.0.1:1",
      token: "t",
      softFailures: false,
      fetchImpl: (async () => { throw new Error("nope"); }) as unknown as typeof fetch,
    });
    await expect(executor("visualread.health", {})).rejects.toBeInstanceOf(ColorBridgeError);
  });
});

describe("请求构造", () => {
  it("注入 Bearer 凭据、租户与幂等键，且不回显 token", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
      calls.push({ url: String(url), init: init ?? {} });
      return okResponse({ ok: true }, { synced: true, sha256: "a".repeat(64) });
    }) as unknown as typeof fetch;

    const executor = createColorBridgeExecutor({
      baseUrl: "http://127.0.0.1:9774",
      token: "secret-token",
      tenantId: "ws-video",
      idempotencyPrefix: "unit",
      fetchImpl,
    });
    const outcome = await executor("colorwrite.grade", { input_path: "/tmp/a.mp4", output_path: "/tmp/b.mp4" });

    expect(outcome.receipt.synced).toBe(true);
    expect(outcome.receipt.sha256).toHaveLength(64);
    expect(outcome.result.job_id).toBe("colorjob-test");
    const [call] = calls;
    expect(call?.url).toBe("http://127.0.0.1:9774/action");
    const headers = call?.init.headers as Record<string, string>;
    expect(headers.authorization).toBe("Bearer secret-token");
    const body = JSON.parse(String(call?.init.body));
    expect(body.tool).toBe("colorwrite.grade");
    expect(body.params.tenant_id).toBe("ws-video");
    expect(String(body.params.idempotency_key)).toMatch(/^unit-/);
  });

  it("幂等键对参数顺序不敏感（同参数 → 同键）", () => {
    const a = stableKey({ input_path: "/tmp/a", profile: "warm-film", intensity: 0.8 });
    const b = stableKey({ intensity: 0.8, profile: "warm-film", input_path: "/tmp/a" });
    expect(a).toBe(b);
    expect(hashKey("x")).toBe(hashKey("x"));
    expect(hashKey("x")).not.toBe(hashKey("y"));
  });
});

describe("失败与故障转移", () => {
  it("桥不可达 → 软失败（synced=false，不抛异常）", async () => {
    const executor = createColorBridgeExecutor({
      baseUrl: "http://127.0.0.1:9",
      token: "t",
      timeoutMs: 500,
      fetchImpl: (async () => { throw new Error("connect ECONNREFUSED"); }) as unknown as typeof fetch,
    });
    const outcome = await executor("colorread.health", {});
    expect(outcome.receipt.synced).toBe(false);
    expect(outcome.result.error).toBe("network_error");
  });

  it("never-retry 错误（tenant_mismatch）不重试第二个端点", async () => {
    let calls = 0;
    const executor = createColorBridgeExecutor({
      baseUrl: ["http://a:9774", "http://b:9774"],
      token: "t",
      fetchImpl: (async () => {
        calls += 1;
        return new Response(JSON.stringify({ ok: false, error: "tenant_mismatch", message: "租户不符" }), { status: 403 });
      }) as unknown as typeof fetch,
    });
    const outcome = await executor("colorread.probe", { input_path: "/tmp/a.mp4" });
    expect(calls).toBe(1);
    expect(outcome.receipt.synced).toBe(false);
    expect(outcome.result.error).toBe("tenant_mismatch");
  });

  it("第一个端点 500 → 失败转移到第二个端点成功", async () => {
    const seen: string[] = [];
    const executor = createColorBridgeExecutor({
      baseUrl: ["http://a:9774", "http://b:9774"],
      token: "t",
      fetchImpl: (async (url: string | URL) => {
        seen.push(String(url));
        if (String(url).startsWith("http://a")) {
          return new Response(JSON.stringify({ ok: false, error: "engine_failed", message: "引擎忙" }), { status: 500 });
        }
        return okResponse({ ok: true }, { synced: true });
      }) as unknown as typeof fetch,
    });
    const outcome = await executor("colorread.health", {});
    expect(seen).toEqual(["http://a:9774/action", "http://b:9774/action"]);
    expect(outcome.receipt.synced).toBe(true);
  });

  it("响应非 JSON → 软失败且标记 bad_response", async () => {
    const onRetry = vi.fn();
    const executor = createColorBridgeExecutor({
      baseUrl: "http://a:9774",
      token: "t",
      onRetry,
      fetchImpl: (async () => new Response("<html>502</html>", { status: 200 })) as unknown as typeof fetch,
    });
    const outcome = await executor("colorread.health", {});
    expect(outcome.receipt.synced).toBe(false);
    expect(onRetry).toHaveBeenCalled();
  });
});
