/**
 * 视频生成接缝单测（T-2026-0921-0002）
 * 覆盖：目录加载与可用性 / 报价与上限闸 / 供应商载荷与状态映射 / 媒体签名与穿越防护 /
 *      入库 sha256 / dry-run 发布驱动与测试放行开关。
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { listModels, getModel, providerConfigured, findFallbackModels, defaultVideoModelId } from "./catalog.js";
import { estimateCost, checkCostCaps, costCaps, usdCnyRate } from "./cost.js";
import { ArkImageProvider, ArkVideoProvider, HiggsfieldProvider, MuapiProvider, buildVideoGenPool, videoGenPool } from "./providers.js";
import { serviceTierRejectionReason } from "./params.js";
import { signMediaPath, verifyMediaToken, resolveMediaPath, downloadToMediaStore } from "./ingest.js";
import type { ProviderError } from "./types.js";
import { createDryRunDriver, buildPublishAdapters, fenceOverrideEnabled } from "./publish.js";

const ARK_ONLY_ENV = { VOLCENGINE_ARK_API_KEY: "test-key" } as NodeJS.ProcessEnv;
const NO_KEYS_ENV = {} as NodeJS.ProcessEnv;

afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.WORKLOOM_MEDIA_DIR;
});

describe("媒体模型目录", () => {
  it("schema 合法且包含 wired / catalog-only 两类条目", () => {
    const all = listModels({ onlyAvailable: false, env: NO_KEYS_ENV });
    expect(all.length).toBeGreaterThan(10);
    expect(all.some((m) => m.availability === "wired")).toBe(true);
    expect(all.some((m) => m.availability === "catalog-only")).toBe(true);
    expect(new Set(all.map((m) => m.id)).size).toBe(all.length);
  });

  it("可用性跟随密钥：无密钥不列出；配置方舟密钥后列出 Seedance 且不被未接入条目污染", () => {
    expect(listModels({ kind: "video", env: NO_KEYS_ENV })).toHaveLength(0);
    const withArk = listModels({ kind: "video", env: ARK_ONLY_ENV });
    expect(withArk.map((m) => m.id)).toContain("doubao-seedance-2-5");
    expect(withArk.every((m) => m.availability === "wired")).toBe(true);
    expect(withArk.every((m) => m.provider === "seedance")).toBe(true);
  });

  it("供应商模型 id 可被环境变量覆盖（SEEDANCE_MODEL 优先）", () => {
    const env = { VOLCENGINE_ARK_API_KEY: "k", SEEDANCE_MODEL: "ep-custom-123" } as NodeJS.ProcessEnv;
    const list = listModels({ kind: "video", env });
    expect(list.every((m) => m.effectiveProviderModel === "ep-custom-123")).toBe(true);
  });

  it("默认模型取最低成本档；显式配置优先", () => {
    expect(defaultVideoModelId(ARK_ONLY_ENV)).toBe("doubao-seedance-2-0");
    expect(defaultVideoModelId({ ...ARK_ONLY_ENV, WORKLOOM_VIDEO_DEFAULT_MODEL: "doubao-seedance-2-5" } as NodeJS.ProcessEnv))
      .toBe("doubao-seedance-2-5");
  });

  it("未配置任何密钥时默认模型抛错（fail-closed，不静默 mock）", () => {
    expect(() => defaultVideoModelId(NO_KEYS_ENV)).toThrow(/没有可用的视频生成模型/);
  });

  it("降级链只取同 kind、不同供应商、档位不高于主模型", () => {
    const env = {
      VOLCENGINE_ARK_API_KEY: "k", HF_API_KEY_ID: "id", HF_API_KEY_SECRET: "sec",
    } as NodeJS.ProcessEnv;
    const primary = getModel("doubao-seedance-2-5")!;
    const fallbacks = findFallbackModels(primary, 2, env);
    expect(fallbacks.length).toBeGreaterThan(0);
    expect(fallbacks.every((f) => f.provider !== primary.provider)).toBe(true);
    expect(fallbacks.every((f) => f.kind === "video")).toBe(true);
  });

  it("密钥就绪判定要求全部必需变量", () => {
    expect(providerConfigured("higgsfield", { HF_API_KEY_ID: "a" } as NodeJS.ProcessEnv)).toBe(false);
    expect(providerConfigured("higgsfield", { HF_API_KEY_ID: "a", HF_API_KEY_SECRET: "b" } as NodeJS.ProcessEnv)).toBe(true);
  });
});

describe("报价与成本上限闸", () => {
  it("已核价模型按 秒数 × 单价 × 汇率 计算", () => {
    const model = getModel("hf-seedance-2-0-t2v")!;
    const est = estimateCost(model, { seconds: 10 });
    expect(est.usd).toBeCloseTo(0.985, 4);
    expect(est.cny).toBeCloseTo(0.985 * usdCnyRate(), 2);
    expect(est.promo).toBe(true);
  });

  it("未核价模型返回 null 并给出说明（不臆造价格）", () => {
    const model = getModel("doubao-seedance-2-5")!;
    const est = estimateCost(model, { seconds: 5 });
    expect(est.usd).toBeNull();
    expect(est.cny).toBeNull();
    expect(est.note).toMatch(/控制台|账单/);
  });

  it("上限闸：未设上限放行；超月上限拒绝并给出原因", () => {
    expect(checkCostCaps({ spentDayCny: 0, spentMonthCny: 999, estCny: 100, caps: { dailyCapCny: null, monthlyCapCny: null } }).allowed).toBe(true);
    const denied = checkCostCaps({
      spentDayCny: 10, spentMonthCny: 90, estCny: 20,
      caps: { dailyCapCny: null, monthlyCapCny: 100 },
    });
    expect(denied.allowed).toBe(false);
    expect(denied.reason).toMatch(/超过上限/);
  });

  it("上限闸：未核价时按 0 计放行，但必须给出可能低估的警示", () => {
    const checked = checkCostCaps({
      spentDayCny: 0, spentMonthCny: 100, estCny: null,
      caps: { dailyCapCny: null, monthlyCapCny: 100 },
    });
    expect(checked.allowed).toBe(true);
    expect(checked.warning).toMatch(/未核价/);
  });

  it("costCaps 只接受正数（0/空 = 不设上限）", () => {
    expect(costCaps({ VIDEO_DAILY_CAP_CNY: "0", VIDEO_MONTHLY_CAP_CNY: "" } as NodeJS.ProcessEnv))
      .toEqual({ dailyCapCny: null, monthlyCapCny: null });
    expect(costCaps({ VIDEO_DAILY_CAP_CNY: "50" } as NodeJS.ProcessEnv).dailyCapCny).toBe(50);
  });
});

describe("供应商适配器", () => {
  it("Ark Seedance：中立参数翻译为 ratio/duration/generate_audio，首帧进 content", async () => {
    const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url: String(url), body: JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown> });
      return new Response(JSON.stringify({ id: "cgt-test-1" }), { status: 200, headers: { "content-type": "application/json" } });
    }));
    const provider = new ArkVideoProvider({ apiKey: "k" });
    const { taskId } = await provider.submit({
      prompt: "测试提示词",
      estimatedUnits: 5,
      params: { providerModel: "doubao-seedance-2-5-260628", durationSec: 5, aspectRatio: "9:16", resolution: "720p", generateAudio: true, firstFrameUrl: "https://cdn.example.com/a.jpg" },
    });
    expect(taskId).toBe("cgt-test-1");
    const body = calls[0]!.body;
    expect(body.model).toBe("doubao-seedance-2-5-260628");
    expect(body.duration).toBe(5);
    expect(body.ratio).toBe("9:16");
    expect(body.resolution).toBe("720p");
    expect(body.generate_audio).toBe(true);
    expect(JSON.stringify(body.content)).toContain("https://cdn.example.com/a.jpg");
    // 首帧必须带 role：Ark 对无 role 的 image content 直接 400（真机 2026-09-22）
    const firstFrame = (body.content as Array<Record<string, unknown>>)[1]!;
    expect(firstFrame.role).toBe("first_frame");
  });

  it("Ark Seedance：参考图带 role=reference_image（否则 400 role must be specified）", async () => {
    const calls: Array<{ body: Record<string, unknown> }> = [];
    vi.stubGlobal("fetch", vi.fn(async (_url: string, init?: RequestInit) => {
      calls.push({ body: JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown> });
      return new Response(JSON.stringify({ id: "cgt-test-ref" }), { status: 200, headers: { "content-type": "application/json" } });
    }));
    const provider = new ArkVideoProvider({ apiKey: "k" });
    await provider.submit({
      prompt: "南园宾馆园林夜景",
      estimatedUnits: 5,
      params: {
        providerModel: "doubao-seedance-2-5-260628",
        durationSec: 5,
        aspectRatio: "9:16",
        referenceImageUrls: ["data:image/jpeg;base64,AAAA", "data:image/jpeg;base64,BBBB"],
      },
    });
    const content = calls[0]!.body.content as Array<Record<string, unknown>>;
    const images = content.filter((c) => c.type === "image_url");
    expect(images).toHaveLength(2);
    for (const image of images) expect(image.role).toBe("reference_image");
  });

  /**
   * 真人肖像官方通道：已授权真人素材以 `asset://<asset ID>` 传入参考图/首帧，
   * provider 必须原样透传（不要改写、不要当成本地路径）。
   */
  it("Ark Seedance：asset:// 授权真人素材原样透传（参考图与首帧）", async () => {
    const calls: Array<{ body: Record<string, unknown> }> = [];
    vi.stubGlobal("fetch", vi.fn(async (_url: string, init?: RequestInit) => {
      calls.push({ body: JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown> });
      return new Response(JSON.stringify({ id: "cgt-asset" }), { status: 200, headers: { "content-type": "application/json" } });
    }));
    const provider = new ArkVideoProvider({ apiKey: "k" });
    await provider.submit({
      prompt: "授权真人素材出镜口播",
      estimatedUnits: 5,
      params: {
        providerModel: "doubao-seedance-2-5-260628",
        durationSec: 5,
        aspectRatio: "9:16",
        referenceImageUrls: ["asset://asset-20260923120000-ab12c"],
      },
    });
    const content = calls[0]!.body.content as Array<Record<string, unknown>>;
    const image = content.find((c) => c.type === "image_url") as { image_url?: { url?: string }; role?: string };
    expect(image?.image_url?.url).toBe("asset://asset-20260923120000-ab12c");
    expect(image?.role).toBe("reference_image");
  });

  /** 官方 SDK（5.0.50）新增/既有未用参数：watermark 默认关闭、seed/service_tier/return_last_frame 透传 */
  it("Ark Seedance：watermark 默认 false，新参数（seed/service_tier/return_last_frame/camera_fixed）透传", async () => {
    const calls: Array<{ body: Record<string, unknown> }> = [];
    vi.stubGlobal("fetch", vi.fn(async (_url: string, init?: RequestInit) => {
      calls.push({ body: JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown> });
      return new Response(JSON.stringify({ id: "cgt-params" }), { status: 200, headers: { "content-type": "application/json" } });
    }));
    const provider = new ArkVideoProvider({ apiKey: "k" });
    await provider.submit({
      prompt: "南园夜景口播",
      estimatedUnits: 10,
      params: {
        providerModel: "doubao-seedance-2-5-260628",
        durationSec: 10,
        aspectRatio: "9:16",
        seed: 12345,
        serviceTier: "flex",
        returnLastFrame: true,
        cameraFixed: true,
        generateAudio: true
      }
    });
    const body = calls[0]!.body;
    expect(body.watermark).toBe(false);
    expect(body.seed).toBe(12345);
    expect(body.service_tier).toBe("flex");
    expect(body.return_last_frame).toBe(true);
    expect(body.camera_fixed).toBe(true);
  });

  /**
   * 真机 2026-09-23：Ark 对 `service_tier: flex` 直接 400
   * （`the specified service_tier flex does not support content generation`）。
   * 供应商适配器仍按中立参数透传（保持通用），由平台侧前置拒绝，避免烧一次必然失败的提交。
   */
  describe("生成参数闸（service_tier）", () => {
    it("flex 被前置拒绝（大小写不敏感），default/未传放行", () => {
      expect(serviceTierRejectionReason("flex")).toMatch(/flex 不支持视频生成/);
      expect(serviceTierRejectionReason("FLEX")).toMatch(/flex 不支持视频生成/);
      expect(serviceTierRejectionReason(" Flex ")).toMatch(/flex 不支持视频生成/);
      expect(serviceTierRejectionReason("default")).toBeNull();
      expect(serviceTierRejectionReason("")).toBeNull();
      expect(serviceTierRejectionReason(undefined)).toBeNull();
      expect(serviceTierRejectionReason(null)).toBeNull();
    });
  });

  /**
   * 真人隐私闸（真机 2026-09-23）：seedance 对"可能包含真人"的输入图一律 400
   * （`InputImageSensitiveContentDetected.PrivacyInformation`）。平台政策类失败必须**明确报错**，
   * 且不得被当成可切换供应商的错误（否则会静默换档重试）。
   */
  it("Ark Seedance：真人图像被隐私闸拒绝时归为 MODERATION，并给出可行动指引", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
      error: {
        code: "InputImageSensitiveContentDetected.PrivacyInformation",
        message: "The request failed because the input image 'content[1]' may contain real person.",
      },
    }), { status: 400, headers: { "content-type": "application/json" } })));
    const provider = new ArkVideoProvider({ apiKey: "k" });
    await expect(provider.submit({
      prompt: "真人出镜口播镜头",
      estimatedUnits: 5,
      params: {
        providerModel: "doubao-seedance-2-5-260628",
        durationSec: 5,
        aspectRatio: "9:16",
        referenceImageUrls: ["data:image/jpeg;base64,AAAA"],
      },
    })).rejects.toMatchObject({
      name: "ProviderError",
      kind: "MODERATION",
      status: 400,
    });
    const message = await provider.submit({
      prompt: "真人出镜口播镜头",
      estimatedUnits: 5,
      params: {
        providerModel: "doubao-seedance-2-5-260628",
        durationSec: 5,
        referenceImageUrls: ["data:image/jpeg;base64,AAAA"],
      },
    }).catch((err: ProviderError) => err.message);
    expect(String(message)).toMatch(/含肖像|授权通道/);
    expect(String(message)).toMatch(/真人/);
  });

  it("Ark Seedance：视频/音频参考以 video_url / audio_url content 提交（含 role）", async () => {
    const calls: Array<{ body: Record<string, unknown> }> = [];
    vi.stubGlobal("fetch", vi.fn(async (_url: string, init?: RequestInit) => {
      calls.push({ body: JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown> });
      return new Response(JSON.stringify({ id: "cgt-ref" }), { status: 200, headers: { "content-type": "application/json" } });
    }));
    const provider = new ArkVideoProvider({ apiKey: "k" });
    await provider.submit({
      prompt: "以参考视频的运动风格生成园林镜头",
      estimatedUnits: 5,
      params: {
        providerModel: "doubao-seedance-2-5-260628",
        durationSec: 5,
        referenceVideoUrls: ["https://cdn.example.com/ref.mp4"],
        referenceAudioUrls: ["https://cdn.example.com/voice.mp3"]
      }
    });
    const content = calls[0]!.body.content as Array<Record<string, unknown>>;
    expect(content.some((c) => c.type === "video_url" && c.role === "reference_video")).toBe(true);
    expect(content.some((c) => c.type === "audio_url" && c.role === "reference_audio")).toBe(true);
  });

  it("Ark Seedance：poll 映射 succeeded/failed/running", async () => {
    const provider = new ArkVideoProvider({ apiKey: "k" });
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ status: "succeeded", content: { video_url: "https://cdn.example.com/v.mp4" } }), { status: 200 })));
    await expect(provider.poll("t1")).resolves.toEqual({ status: "succeeded", uri: "https://cdn.example.com/v.mp4" });
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ status: "failed", error: { message: "内容审核未通过" } }), { status: 200 })));
    await expect(provider.poll("t1")).resolves.toMatchObject({ status: "failed", error: "内容审核未通过" });
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ status: "running" }), { status: 200 })));
    await expect(provider.poll("t1")).resolves.toEqual({ status: "running" });
  });

  it("Higgsfield：鉴权头为 Key id:secret，端点按 endpointId 拼接，completed 取 video.url", async () => {
    const seen: Array<{ url: string; headers: Record<string, string> }> = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
      seen.push({ url: String(url), headers: (init?.headers ?? {}) as Record<string, string> });
      if (String(url).includes("/requests/")) {
        return new Response(JSON.stringify({ status: "completed", video: { url: "https://cdn.hf/v.mp4" } }), { status: 200 });
      }
      return new Response(JSON.stringify({ status: "queued", request_id: "req-1" }), { status: 200 });
    }));
    const provider = new HiggsfieldProvider({ keyId: "kid", keySecret: "sec" });
    const { taskId } = await provider.submit({
      prompt: "p", estimatedUnits: 5,
      params: { providerModel: "bytedance/seedance-2.0/text-to-video", durationSec: 5, aspectRatio: "16:9", generateAudio: false },
    });
    expect(taskId).toBe("req-1");
    expect(seen[0]!.url).toContain("bytedance/seedance-2.0/text-to-video");
    expect(seen[0]!.headers.authorization).toBe("Key kid:sec");
    await expect(provider.poll("req-1")).resolves.toEqual({ status: "succeeded", uri: "https://cdn.hf/v.mp4" });
  });

  it("Higgsfield：nsfw 终态按合规拒绝语义返回", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ status: "nsfw" }), { status: 200 })));
    const provider = new HiggsfieldProvider({ keyId: "k", keySecret: "s" });
    const r = await provider.poll("req-2");
    expect(r.status).toBe("failed");
    expect(r.error).toMatch(/审核/);
  });

  it("供应商池按密钥装配（缺密钥=缺位，不 mock 冒充）", () => {
    expect(buildVideoGenPool({ env: NO_KEYS_ENV }).size).toBe(0);
    const pool = buildVideoGenPool({ env: { VOLCENGINE_ARK_API_KEY: "k", HF_API_KEY_ID: "i", HF_API_KEY_SECRET: "s" } as NodeJS.ProcessEnv });
    expect([...pool.keys()].sort()).toEqual(["higgsfield", "seedance", "seedream"]);
  });
});

describe("成片入库与媒体通道", () => {
  it("下载后落盘并给出 sha256（内容一致）", async () => {
    const dir = mkdtempSync(join(tmpdir(), "wl-media-"));
    process.env.WORKLOOM_MEDIA_DIR = dir;
    vi.stubGlobal("fetch", vi.fn(async () => new Response(new Uint8Array([1, 2, 3, 4, 5]), { status: 200, headers: { "content-type": "video/mp4" } })));
    const media = await downloadToMediaStore("https://cdn.example.com/v.mp4", { workspaceId: "ws-test" });
    expect(media.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(media.bytes).toBe(5);
    expect(media.relPath).toBe(`video/ws-test/${media.sha256}.mp4`);
    rmSync(dir, { recursive: true, force: true });
  });

  it("超过大小上限直接拒收（防磁盘写爆）", async () => {
    const dir = mkdtempSync(join(tmpdir(), "wl-media-"));
    process.env.WORKLOOM_MEDIA_DIR = dir;
    vi.stubGlobal("fetch", vi.fn(async () => new Response(new Uint8Array(2048), { status: 200 })));
    await expect(downloadToMediaStore("https://cdn.example.com/big.mp4", { workspaceId: "ws", maxBytes: 1024 })).rejects.toThrow(/超过大小上限/);
    rmSync(dir, { recursive: true, force: true });
  });

  it("签名 URL 可验证、可过期、被篡改即拒", () => {
    process.env.MEDIA_SIGNING_SECRET = "unit-test-secret";
    const token = signMediaPath("video/ws/a.mp4", 60, 1_000_000);
    expect(verifyMediaToken("video/ws/a.mp4", token, 1_030_000).ok).toBe(true);
    expect(verifyMediaToken("video/ws/other.mp4", token, 1_030_000).ok).toBe(false);
    expect(verifyMediaToken("video/ws/a.mp4", token, 1_061_000).ok).toBe(false);
    expect(verifyMediaToken("video/ws/a.mp4", `${token}x`, 1_030_000).ok).toBe(false);
  });

  it("媒体路径越界被拒（目录穿越防护）", () => {
    process.env.WORKLOOM_MEDIA_DIR = "/tmp/wl-media-guard";
    expect(() => resolveMediaPath("../../etc/passwd")).toThrow(/越界|ENOENT|path/i);
  });
});

describe("发布链", () => {
  it("dry-run 驱动不触网且记录调用痕迹", async () => {
    const { driver, calls } = createDryRunDriver();
    await driver.goto("https://creator.douyin.com/");
    expect(await driver.isLoggedIn("https://creator.douyin.com/", "div")).toBe(true);
    await driver.uploadFile("input", "/tmp/v.mp4");
    expect(calls).toContain("goto:https://creator.douyin.com/");
    expect(calls.some((c) => c.startsWith("upload:"))).toBe(true);
  });

  it("六平台适配器齐全（含 tiktok/shipinhao 占位）", () => {
    const adapters = buildPublishAdapters();
    expect(Object.keys(adapters).sort()).toEqual(["bilibili", "douyin", "shipinhao", "tiktok", "xiaohongshu", "youtube"]);
  });

  it("测试放行开关：仅非 production 生效（生产忽略）", () => {
    expect(fenceOverrideEnabled({ PUBLISH_TEST_FENCE_OVERRIDE: "1" } as NodeJS.ProcessEnv)).toBe(true);
    expect(fenceOverrideEnabled({ PUBLISH_TEST_FENCE_OVERRIDE: "1", NODE_ENV: "production" } as NodeJS.ProcessEnv)).toBe(false);
    expect(fenceOverrideEnabled({} as NodeJS.ProcessEnv)).toBe(false);
  });
});


describe("供应商拒绝与未知接受结果", () => {
  it.each([
    [401, "AUTH", "not-accepted", true], [400, "BAD_REQUEST", "not-accepted", false],
    [404, "MODEL_UNAVAILABLE", "not-accepted", true], [429, "RETRYABLE", "not-accepted", true],
    [500, "RETRYABLE", "unknown", false], [503, "RETRYABLE", "unknown", false],
    [408, "PROVIDER_FAILED", "unknown", false],
  ])("HTTP %s 分类不将未知提交当成可安全重发", async (status, kind, acceptance, fallbackAllowed) => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("rejected", { status: Number(status) })));
    await expect(new ArkVideoProvider({ apiKey: "test-only" }).submit({ prompt: "glass", estimatedUnits: 5, params: { providerModel: "test-model" } }))
      .rejects.toMatchObject({ kind, acceptance, fallbackAllowed });
  });
  it.each([
    new ArkVideoProvider({ apiKey: "test-only" }), new ArkImageProvider({ apiKey: "test-only" }),
    new HiggsfieldProvider({ keyId: "test-only", keySecret: "test-only" }), new MuapiProvider({ apiKey: "test-only" }),
  ])("成功 HTTP 无 taskId/URL 仍需对账：%s", async (provider) => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status: 200 })));
    await expect(provider.submit({ prompt: "glass", estimatedUnits: 5, params: { providerModel: "test-model" } }))
      .rejects.toMatchObject({ acceptance: "unknown", fallbackAllowed: false });
  });
  it("成功 HTTP 非 JSON 的响应同样不允许 fallback", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("gateway response lost", { status: 200 })));
    await expect(new ArkVideoProvider({ apiKey: "test-only" }).submit({ prompt: "glass", estimatedUnits: 5, params: { providerModel: "test-model" } }))
      .rejects.toMatchObject({ acceptance: "unknown", fallbackAllowed: false });
  });
  it("连接池缓存覆盖 endpoint/供应商模型配置，并接受调用者指定 env", async () => {
    const seen: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string) => { seen.push(String(url)); return new Response('{"id":"test-task"}', { status: 200 }); }));
    const first = videoGenPool({ VOLCENGINE_ARK_API_KEY: "test-only", SEEDANCE_ENDPOINT: "https://first.example.test" });
    await first.get("seedance")!.submit({ prompt: "glass", estimatedUnits: 5, params: { providerModel: "test-model" } });
    const second = videoGenPool({ VOLCENGINE_ARK_API_KEY: "test-only", SEEDANCE_ENDPOINT: "https://second.example.test" });
    await second.get("seedance")!.submit({ prompt: "glass", estimatedUnits: 5, params: { providerModel: "test-model" } });
    expect(seen).toEqual(["https://first.example.test/contents/generations/tasks", "https://second.example.test/contents/generations/tasks"]);
    expect(first).not.toBe(second);
  });
});
