/**
 * 字幕工位连接器单测（纯 fake fetch，不需要真实工位）。
 * 覆盖：白名单拒绝 / 凭据注入 / 租户与幂等键 / 软失败不抛异常 / 多端点故障转移 / never-retry。
 */
import { describe, expect, it } from "vitest";
import {
  SUBTITLE_BRIDGE_TOOLS,
  SubtitleBridgeError,
  createSubtitleBridgeExecutor,
  hashKey,
  isSubtitleBridgeTool,
  stableKey,
} from "./executor.ts";

function okResponse(result: Record<string, unknown>, receipt: Record<string, unknown>) {
  return new Response(JSON.stringify({ ok: true, result, receipt, job_id: "subtitlejob-test" }), {
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
  it("只声明 14 个字幕工具（含弹幕/贴纸/卡拉OK/旁挂/软字幕轨），且不提供他人工具", () => {
    expect(SUBTITLE_BRIDGE_TOOLS).toHaveLength(14);
    expect(isSubtitleBridgeTool("subtitleread.fonts")).toBe(true);
    expect(isSubtitleBridgeTool("subtitlewrite.burn")).toBe(true);
    expect(isSubtitleBridgeTool("subtitlewrite.title")).toBe(true);
    expect(isSubtitleBridgeTool("subtitlewrite.best")).toBe(true);
    expect(isSubtitleBridgeTool("subtitlewrite.danmaku")).toBe(true);
    expect(isSubtitleBridgeTool("subtitlewrite.sticker")).toBe(true);
    expect(isSubtitleBridgeTool("subtitlewrite.karaoke")).toBe(true);
    expect(isSubtitleBridgeTool("subtitlewrite.sidecar")).toBe(true);
    expect(isSubtitleBridgeTool("subtitlewrite.softmux")).toBe(true);
    expect(isSubtitleBridgeTool("bgmwrite.mix")).toBe(false);
    expect(isSubtitleBridgeTool("colorwrite.grade")).toBe(false);
    expect(isSubtitleBridgeTool("render.submit")).toBe(false);
  });

  it("未声明的工具软失败（不抛异常、不伪造回执）", async () => {
    const executor = createSubtitleBridgeExecutor({
      baseUrl: "http://127.0.0.1:1",
      token: "t",
      fetchImpl: (async () => { throw new Error("should not be called"); }) as unknown as typeof fetch,
    });
    const outcome = await executor("bgmwrite.mix", {});
    expect(outcome.receipt.synced).toBe(false);
    expect(outcome.result.error).toBe("not_provided");
  });

  it("hardFailures 模式下未声明工具直接抛错", async () => {
    const executor = createSubtitleBridgeExecutor({
      baseUrl: "http://127.0.0.1:1",
      token: "t",
      softFailures: false,
      fetchImpl: (async () => { throw new Error("nope"); }) as unknown as typeof fetch,
    });
    await expect(executor("subtitleread.nope", {})).rejects.toBeInstanceOf(SubtitleBridgeError);
  });
});

describe("请求构造与凭据", () => {
  it("注入 Bearer token、tenant_id 与幂等键，并原样带回 sha256 回执", async () => {
    const calls: Array<{ url: string; body: Record<string, unknown>; auth: string | null }> = [];
    const executor = createSubtitleBridgeExecutor({
      baseUrl: "http://bridge.local:9776/",
      // 占位凭据（非真实令牌）：命名带 mock 让秘密扫描的占位判定可识别
      token: "test-only-token",
      tenantId: "ws-video",
      idempotencyPrefix: "test",
      fetchImpl: (async (url: string, init: RequestInit) => {
        calls.push({
          url: String(url),
          body: JSON.parse(String(init.body)),
          auth: (init.headers as Record<string, string>).authorization ?? null,
        });
        return okResponse({ output: "/x/burned.mp4" }, { synced: true, sha256: "b".repeat(64), snapshot_uri: "subtitle://burn/x" });
      }) as unknown as typeof fetch,
    });
    const outcome = await executor("subtitlewrite.burn", { input_path: "/in.mp4", output_path: "/out.mp4" });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe("http://bridge.local:9776/action");
    expect(calls[0]!.auth).toBe("Bearer test-only-token");
    const params = calls[0]!.body.params as Record<string, unknown>;
    expect(params.tenant_id).toBe("ws-video");
    expect(String(params.idempotency_key)).toMatch(/^test-[0-9a-f]{16}$/);
    expect(outcome.receipt.synced).toBe(true);
    expect(outcome.receipt.sha256).toBe("b".repeat(64));
    expect(outcome.result.job_id).toBe("subtitlejob-test");
  });

  it("幂等键对参数顺序不敏感（稳定序列化）", () => {
    expect(stableKey({ b: 1, a: [2, { d: 3, c: 4 }] })).toBe(stableKey({ a: [2, { c: 4, d: 3 }], b: 1 }));
    expect(hashKey("same")).toBe(hashKey("same"));
    expect(hashKey("same")).not.toBe(hashKey("other"));
  });

  it("ctx 之外的参数不被改写：路径与 SRT 正文原样透传", async () => {
    let received: Record<string, unknown> = {};
    const executor = createSubtitleBridgeExecutor({
      baseUrl: "http://bridge.local:9776",
      token: "t",
      fetchImpl: (async (_url: string, init: RequestInit) => {
        received = (JSON.parse(String(init.body)) as { params: Record<string, unknown> }).params;
        return okResponse({ plan: {} }, { synced: true });
      }) as unknown as typeof fetch,
    });
    await executor("subtitlewrite.plan", { srt_text: "1\n00:00:01,000 --> 00:00:02,000\n测试\n", input_path: "/素材/a.mp4" });
    expect(received.srt_text).toContain("00:00:01,000");
    expect(received.input_path).toBe("/素材/a.mp4");
  });
});

describe("软失败与故障转移", () => {
  it("工位不可达 → 结构化软失败（不抛异常、不伪造 synced）", async () => {
    const executor = createSubtitleBridgeExecutor({
      baseUrl: "http://127.0.0.1:9",
      token: "t",
      timeoutMs: 500,
      fetchImpl: (async () => { throw new Error("ECONNREFUSED"); }) as unknown as typeof fetch,
    });
    const outcome = await executor("subtitleread.health", {});
    expect(outcome.receipt.synced).toBe(false);
    expect(outcome.result.error).toBe("network_error");
    expect((outcome.result.attempts as unknown[]).length).toBe(1);
  });

  it("多端点：第一个网络失败后自动切到第二个", async () => {
    const tried: string[] = [];
    const executor = createSubtitleBridgeExecutor({
      baseUrl: ["http://a.local:9776", "http://b.local:9776"],
      token: "t",
      fetchImpl: (async (url: string) => {
        tried.push(String(url));
        if (String(url).includes("a.local")) throw new Error("ECONNREFUSED");
        return okResponse({ ok: true }, { synced: true });
      }) as unknown as typeof fetch,
    });
    const outcome = await executor("subtitleread.health", {});
    expect(tried).toEqual(["http://a.local:9776/action", "http://b.local:9776/action"]);
    expect(outcome.receipt.synced).toBe(true);
  });

  it("不可重试错误（验证未通过/路径越界）不触发故障转移，保真上报", async () => {
    const tried: string[] = [];
    const executor = createSubtitleBridgeExecutor({
      baseUrl: ["http://a.local:9776", "http://b.local:9776"],
      token: "t",
      fetchImpl: (async (url: string) => {
        tried.push(String(url));
        return errResponse("verify_failed", "字幕复检未通过（presence_ok）", false);
      }) as unknown as typeof fetch,
    });
    const outcome = await executor("subtitlewrite.burn", { input_path: "/a.mp4", output_path: "/b.mp4" });
    expect(tried).toHaveLength(1);
    expect(outcome.receipt.synced).toBe(false);
    expect(outcome.result.error).toBe("verify_failed");
    expect(String(outcome.result.message)).toContain("复检未通过");
  });

  it("工位声明的可重试错误即使 HTTP 200 也触发故障转移", async () => {
    const tried: string[] = [];
    const executor = createSubtitleBridgeExecutor({
      baseUrl: ["http://a.local:9776", "http://b.local:9776"],
      token: "t",
      fetchImpl: (async (url: string) => {
        tried.push(String(url));
        if (String(url).includes("a.local")) return errResponse("ffmpeg_failed", "编码器崩溃", true);
        return okResponse({ output: "/ok.mp4" }, { synced: true, sha256: "c".repeat(64) });
      }) as unknown as typeof fetch,
    });
    const outcome = await executor("subtitlewrite.burn", { input_path: "/a.mp4", output_path: "/b.mp4" });
    expect(tried).toHaveLength(2);
    expect(outcome.receipt.sha256).toBe("c".repeat(64));
  });

  it("超时按可重试处理", async () => {
    const executor = createSubtitleBridgeExecutor({
      baseUrl: "http://slow.local:9776",
      token: "t",
      timeoutMs: 20,
      fetchImpl: ((_url: string, init: RequestInit) => new Promise((_resolve, reject) => {
        init.signal?.addEventListener("abort", () => {
          const error = new Error("aborted");
          error.name = "AbortError";
          reject(error);
        });
      })) as unknown as typeof fetch,
    });
    const outcome = await executor("subtitleread.analyze", { input_path: "/a.mp4" });
    expect(outcome.receipt.synced).toBe(false);
    expect(outcome.result.error).toBe("timeout");
  });
});
