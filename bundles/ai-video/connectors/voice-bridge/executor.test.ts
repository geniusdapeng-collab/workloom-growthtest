/**
 * 配音工位连接器单测（纯 fake fetch，不需要真实工位与模型）。
 * 覆盖：白名单拒绝 / 凭据与租户注入 / 幂等键 / 软失败不抛异常 / 多端点故障转移 /
 *      可重试与不可重试错误的分野（引擎抖动可重试、授权与核验失败绝不重试）。
 */
import { describe, expect, it } from "vitest";
import {
  VOICE_BRIDGE_TOOLS,
  VoiceBridgeError,
  createVoiceBridgeExecutor,
  hashKey,
  isVoiceBridgeTool,
  stableKey,
} from "./executor.ts";

function okResponse(result: Record<string, unknown>, receipt: Record<string, unknown>) {
  return new Response(JSON.stringify({ ok: true, result, receipt, job_id: "voicejob-test" }), {
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
  it("只声明 10 个配音工具，且不提供他人工具", () => {
    expect(VOICE_BRIDGE_TOOLS).toHaveLength(10);
    expect(isVoiceBridgeTool("voiceread.health")).toBe(true);
    expect(isVoiceBridgeTool("voicewrite.record")).toBe(true);
    expect(isVoiceBridgeTool("voicewrite.register")).toBe(true);
    expect(isVoiceBridgeTool("voicewrite.speak")).toBe(true);
    expect(isVoiceBridgeTool("voicewrite.dub")).toBe(true);
    expect(isVoiceBridgeTool("bgmwrite.mix")).toBe(false);
    expect(isVoiceBridgeTool("colorwrite.grade")).toBe(false);
    expect(isVoiceBridgeTool("render.submit")).toBe(false);
  });

  it("未声明的工具软失败（不抛异常、不伪造回执）", async () => {
    const executor = createVoiceBridgeExecutor({
      baseUrl: "http://127.0.0.1:1",
      token: "t",
      fetchImpl: (async () => { throw new Error("should not be called"); }) as unknown as typeof fetch,
    });
    const outcome = await executor("bgmwrite.mix", {});
    expect(outcome.receipt.synced).toBe(false);
    expect(outcome.result.error).toBe("not_provided");
  });

  it("hardFailures 模式下未声明工具直接抛错", async () => {
    const executor = createVoiceBridgeExecutor({
      baseUrl: "http://127.0.0.1:1",
      token: "t",
      softFailures: false,
      fetchImpl: (async () => { throw new Error("nope"); }) as unknown as typeof fetch,
    });
    await expect(executor("voiceread.nope", {})).rejects.toBeInstanceOf(VoiceBridgeError);
  });
});

describe("请求构造与凭据", () => {
  it("注入 Bearer token、tenant_id 与幂等键，并原样带回 sha256 回执", async () => {
    const calls: Array<{ url: string; body: Record<string, unknown>; auth: string | null }> = [];
    const executor = createVoiceBridgeExecutor({
      baseUrl: "http://bridge.local:9776/",
      token: "secret-token",
      tenantId: "ws-video",
      idempotencyPrefix: "voicetest",
      fetchImpl: (async (url: string, init: RequestInit) => {
        calls.push({
          url: String(url),
          body: JSON.parse(String(init.body)),
          auth: (init.headers as Record<string, string>).authorization ?? null,
        });
        return okResponse(
          { out: "/station/deliveries/xiaozhi.wav", duration_sec: 12.5 },
          { synced: true, sha256: "b".repeat(64), snapshot_uri: "voice://speak/x" },
        );
      }) as unknown as typeof fetch,
    });
    const outcome = await executor("voicewrite.speak", { text: "你好", profile: "zh-xiaozhi", out: "/station/deliveries/xiaozhi.wav" });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe("http://bridge.local:9776/action");
    expect(calls[0]!.auth).toBe("Bearer secret-token");
    const params = calls[0]!.body.params as Record<string, unknown>;
    expect(params.tenant_id).toBe("ws-video");
    expect(String(params.idempotency_key)).toMatch(/^voicetest-[0-9a-f]{16}$/);
    expect(outcome.receipt.synced).toBe(true);
    expect(outcome.receipt.sha256).toBe("b".repeat(64));
    expect(outcome.result.job_id).toBe("voicejob-test");
  });

  it("幂等键对参数键序不敏感、对参数变化敏感", () => {
    expect(stableKey({ a: 1, b: { c: 2, d: 3 } })).toBe(stableKey({ b: { d: 3, c: 2 }, a: 1 }));
    expect(hashKey("x")).toHaveLength(16);
    expect(hashKey("voiceread.health|{}")).not.toBe(hashKey("voicewrite.speak|{}"));
  });

  it("默认自动注入幂等键，关闭后不注入", async () => {
    const seen: Array<Record<string, unknown>> = [];
    const executor = createVoiceBridgeExecutor({
      baseUrl: "http://bridge.local:9776",
      token: "t",
      autoIdempotency: false,
      fetchImpl: (async (_url: string, init: RequestInit) => {
        seen.push(JSON.parse(String(init.body)).params);
        return okResponse({ ok: true }, { synced: true });
      }) as unknown as typeof fetch,
    });
    await executor("voiceread.health", {});
    expect(seen[0]!.idempotency_key).toBeUndefined();
  });
});

describe("错误语义与故障转移", () => {
  it("引擎抖动可重试（换端点），核验/授权类失败不可重试（不再试）", async () => {
    const hits: string[] = [];
    const flaky = createVoiceBridgeExecutor({
      baseUrl: ["http://a:9776", "http://b:9776"],
      token: "t",
      softFailures: false,
      fetchImpl: (async (url: string) => {
        hits.push(String(url));
        if (String(url).includes("//a:")) return errResponse("engine_busy", "模型正忙", true);
        return okResponse({ out: "/x.wav" }, { synced: true });
      }) as unknown as typeof fetch,
    });
    const outcome = await flaky("voicewrite.speak", { text: "hi" });
    expect(hits).toHaveLength(2);
    expect(outcome.receipt.synced).toBe(true);

    const refused: string[] = [];
    const guarded = createVoiceBridgeExecutor({
      baseUrl: ["http://a:9776", "http://b:9776"],
      token: "t",
      fetchImpl: (async (url: string) => {
        refused.push(String(url));
        return errResponse("verify_failed", "产物真峰值超标", false);
      }) as unknown as typeof fetch,
    });
    const refusedOutcome = await guarded("voicewrite.verify", { input: "/x.wav" });
    expect(refused).toHaveLength(1);
    expect(refusedOutcome.receipt.synced).toBe(false);
    expect(refusedOutcome.result.error).toBe("verify_failed");
  });

  it("桥不可达时软失败并保留 attempts 证据（不伪造完成）", async () => {
    const executor = createVoiceBridgeExecutor({
      baseUrl: ["http://a:9776", "http://b:9776"],
      token: "t",
      fetchImpl: (async () => { throw new Error("ECONNREFUSED"); }) as unknown as typeof fetch,
    });
    const outcome = await executor("voicewrite.register", { profile: "zh-1" });
    expect(outcome.receipt.synced).toBe(false);
    expect(outcome.result.error).toBe("network_error");
    expect((outcome.result.attempts as unknown[]).length).toBe(2);
  });

  it("非 JSON 响应按可重试的 bad_response 处理", async () => {
    const executor = createVoiceBridgeExecutor({
      baseUrl: "http://a:9776",
      token: "t",
      softFailures: false,
      fetchImpl: (async () => new Response("<html>502</html>", { status: 502 })) as unknown as typeof fetch,
    });
    await expect(executor("voiceread.health", {})).rejects.toMatchObject({ code: "bad_response" });
  });
});
