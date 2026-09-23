/**
 * 配乐工位连接器单测（纯 fake fetch，不需要真实工位）。
 * 覆盖：白名单拒绝 / 凭据注入 / 租户与幂等键 / 软失败不抛异常 / 多端点故障转移 / never-retry。
 */
import { describe, expect, it } from "vitest";
import {
  BGM_BRIDGE_TOOLS,
  BgmBridgeError,
  createBgmBridgeExecutor,
  hashKey,
  isBgmBridgeTool,
  stableKey,
} from "./executor.ts";

function okResponse(result: Record<string, unknown>, receipt: Record<string, unknown>) {
  return new Response(JSON.stringify({ ok: true, result, receipt, job_id: "bgmjob-test" }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

function errResponse(error: string, message: string, retryable = false) {
  return new Response(JSON.stringify({ ok: false, error, message, retryable }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

describe("工具白名单", () => {
  it("只声明 12 个配乐工具（含结构识别与在线取源），且不提供他人工具", () => {
    expect(BGM_BRIDGE_TOOLS).toHaveLength(12);
    expect(isBgmBridgeTool("bgmread.brief")).toBe(true);
    expect(isBgmBridgeTool("bgmwrite.fetch")).toBe(true);
    expect(isBgmBridgeTool("bgmread.structure")).toBe(true);
    expect(isBgmBridgeTool("bgmread.recipes")).toBe(true);
    expect(isBgmBridgeTool("bgmread.structure")).toBe(true);
    expect(isBgmBridgeTool("bgmwrite.compose")).toBe(true);
    expect(isBgmBridgeTool("bgmwrite.mix")).toBe(true);
    expect(isBgmBridgeTool("bgmwrite.best")).toBe(true);
    expect(isBgmBridgeTool("colorwrite.grade")).toBe(false);
    expect(isBgmBridgeTool("render.submit")).toBe(false);
  });

  it("未声明的工具软失败（不抛异常、不伪造回执）", async () => {
    const executor = createBgmBridgeExecutor({
      baseUrl: "http://127.0.0.1:1",
      token: "t",
      fetchImpl: (async () => { throw new Error("should not be called"); }) as unknown as typeof fetch,
    });
    const outcome = await executor("colorwrite.grade", {});
    expect(outcome.receipt.synced).toBe(false);
    expect(outcome.result.error).toBe("not_provided");
  });

  it("hardFailures 模式下未声明工具直接抛错", async () => {
    const executor = createBgmBridgeExecutor({
      baseUrl: "http://127.0.0.1:1",
      token: "t",
      softFailures: false,
      fetchImpl: (async () => { throw new Error("nope"); }) as unknown as typeof fetch,
    });
    await expect(executor("bgmread.nope", {})).rejects.toBeInstanceOf(BgmBridgeError);
  });
});

describe("请求构造与凭据", () => {
  it("注入 Bearer token、tenant_id 与幂等键，并原样带回 sha256 回执", async () => {
    const calls: Array<{ url: string; body: Record<string, unknown>; auth: string | null }> = [];
    const executor = createBgmBridgeExecutor({
      baseUrl: "http://bridge.local:9775/",
      token: "secret-token",
      tenantId: "ws-video",
      idempotencyPrefix: "test",
      fetchImpl: (async (url: string, init: RequestInit) => {
        calls.push({
          url: String(url),
          body: JSON.parse(String(init.body)),
          auth: (init.headers as Record<string, string>).authorization ?? null,
        });
        return okResponse({ output: "/x/mixed.mp4" }, { synced: true, sha256: "a".repeat(64), snapshot_uri: "bgm://mix/x" });
      }) as unknown as typeof fetch,
    });
    const outcome = await executor("bgmwrite.mix", { input_path: "/in.mp4", output_path: "/out.mp4" });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe("http://bridge.local:9775/action");
    expect(calls[0]!.auth).toBe("Bearer secret-token");
    const params = calls[0]!.body.params as Record<string, unknown>;
    expect(params.tenant_id).toBe("ws-video");
    expect(String(params.idempotency_key)).toMatch(/^test-[0-9a-f]{16}$/);
    expect(outcome.receipt.synced).toBe(true);
    expect(outcome.receipt.sha256).toBe("a".repeat(64));
    expect(outcome.result.job_id).toBe("bgmjob-test");
  });

  it("相同工具 + 相同参数 → 相同幂等键；不同参数 → 不同键", () => {
    const keyA = hashKey(`bgmwrite.mix|${stableKey({ a: 1, b: [1, 2] })}`);
    const keyB = hashKey(`bgmwrite.mix|${stableKey({ b: [1, 2], a: 1 })}`);
    const keyC = hashKey(`bgmwrite.mix|${stableKey({ a: 1, b: [2, 1] })}`);
    expect(keyA).toBe(keyB);
    expect(keyA).not.toBe(keyC);
  });
});

describe("软失败与错误语义", () => {
  it("工位不可达 → synced=false 且带 attempts（不伪造成功）", async () => {
    const executor = createBgmBridgeExecutor({
      baseUrl: "http://127.0.0.1:1",
      token: "t",
      fetchImpl: (async () => { throw new Error("connect ECONNREFUSED"); }) as unknown as typeof fetch,
    });
    const outcome = await executor("bgmread.analyze", { input_path: "/in.mp4" });
    expect(outcome.receipt.synced).toBe(false);
    expect(outcome.result.error).toBe("network_error");
    expect(Array.isArray(outcome.result.attempts)).toBe(true);
  });

  it("不可重试错误（版权不合规 / 路径越界）只打一次，不重试其它端点", async () => {
    let calls = 0;
    const executor = createBgmBridgeExecutor({
      baseUrl: ["http://a:1", "http://b:1"],
      token: "t",
      fetchImpl: (async () => {
        calls += 1;
        return errResponse("license_blocked", "NC 许可不可商用");
      }) as unknown as typeof fetch,
    });
    const outcome = await executor("bgmwrite.mix", { input_path: "/in.mp4" });
    expect(calls).toBe(1);
    expect(outcome.receipt.synced).toBe(false);
    expect(outcome.result.error).toBe("license_blocked");
  });

  it("可重试错误（引擎失败）会切到第二个端点并成功", async () => {
    const seen: string[] = [];
    const executor = createBgmBridgeExecutor({
      baseUrl: ["http://a:1", "http://b:1"],
      token: "t",
      fetchImpl: (async (url: string) => {
        seen.push(String(url));
        if (String(url).includes("http://a:1")) return errResponse("ffmpeg_failed", "编码中断", true);
        return okResponse({ ok: true }, { synced: true, sha256: "b".repeat(64) });
      }) as unknown as typeof fetch,
    });
    const outcome = await executor("bgmwrite.compose", { output_path: "/tmp/bgm.wav", duration_seconds: 5 });
    expect(seen).toEqual(["http://a:1/action", "http://b:1/action"]);
    expect(outcome.receipt.synced).toBe(true);
  });

  it("HTTP 5xx 视为可重试，HTTP 4xx 不重试", async () => {
    let calls = 0;
    const serverError = createBgmBridgeExecutor({
      baseUrl: ["http://a:1", "http://b:1"],
      token: "t",
      fetchImpl: (async () => {
        calls += 1;
        return new Response("boom", { status: 500 });
      }) as unknown as typeof fetch,
    });
    const outcome = await serverError("bgmread.health", {});
    expect(calls).toBe(2);
    expect(outcome.receipt.synced).toBe(false);
  });

  it("非 JSON 响应 → bad_response，仍以软失败收口", async () => {
    const executor = createBgmBridgeExecutor({
      baseUrl: "http://a:1",
      token: "t",
      fetchImpl: (async () => new Response("<html>proxy</html>", { status: 200 })) as unknown as typeof fetch,
    });
    const outcome = await executor("bgmread.probe", { input_path: "/in.mp4" });
    expect(outcome.receipt.synced).toBe(false);
    expect(outcome.result.error).toBe("bad_response");
  });
});

describe("端点轮转", () => {
  it("成功后游标前进，下一次优先用另一个端点（负载均摊）", async () => {
    const seen: string[] = [];
    const executor = createBgmBridgeExecutor({
      baseUrl: ["http://a:1", "http://b:1"],
      token: "t",
      fetchImpl: (async (url: string) => {
        seen.push(String(url));
        return okResponse({ ok: true }, { synced: true });
      }) as unknown as typeof fetch,
    });
    await executor("bgmread.health", {});
    await executor("bgmread.health", {});
    await executor("bgmread.health", {});
    expect(seen).toEqual(["http://a:1/action", "http://b:1/action", "http://a:1/action"]);
  });
});
