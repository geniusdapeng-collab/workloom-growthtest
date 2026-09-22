/**
 * video/gen/providers.ts —— 生成供应商适配器（T-2026-0921-0002）
 *
 * 与基座 `GenProvider` 接口同构（healthy / submit → taskId / poll → 状态+产物），
 * 因此可直接注入既有 `routeGenSubmit` 降级链与 render-poller，不需要改动基座。
 *
 * 中立参数（req.params）约定：{ providerModel, durationSec, aspectRatio, resolution,
 * generateAudio, firstFrameUrl, referenceImageUrls, seed, negativePrompt, extra }
 * 各 provider 只取自己支持的位，翻译成自家字段名（Ark: ratio/duration/generate_audio；Higgsfield:
 * aspect_ratio/duration/generate_audio/image_url）。
 */
import {
  JimengProvider, KlingProvider,
  type GenKind, type GenProvider, type GenRequest, type GenTaskStatus,
} from "@workloom/base/model-router";
import { ProviderError, type ProviderErrorKind } from "./types.js";

interface NeutralParams {
  providerModel?: string;
  durationSec?: number;
  aspectRatio?: string;
  resolution?: string;
  generateAudio?: boolean;
  firstFrameUrl?: string;
  referenceImageUrls?: string[];
  referenceVideoUrls?: string[];
  referenceAudioUrls?: string[];
  seed?: number;
  negativePrompt?: string;
  watermark?: boolean;
  cameraFixed?: boolean;
  returnLastFrame?: boolean;
  serviceTier?: string;
  priority?: number;
  executionExpiresAfter?: number;
  frames?: number;
  outputFormat?: string;
  callbackUrl?: string;
  extra?: Record<string, unknown>;
}

function neutral(req: GenRequest): NeutralParams {
  return (req.params ?? {}) as NeutralParams;
}

function requireModel(req: GenRequest, fallback?: string): string {
  const m = neutral(req).providerModel ?? fallback;
  if (!m) throw new ProviderError("BAD_REQUEST", "缺少 providerModel（模型目录未解析出供应商模型 id）");
  return m;
}

/** HTTP 失败 → 统一分类（401/并发满/模型不可用/可重试/其他） */
function classify(status: number, body: string): ProviderError {
  const text = body.slice(0, 300);
  if (status === 401 || status === 403) return new ProviderError("AUTH", `鉴权失败：HTTP ${status} ${text}`, status);
  if (status === 400 && /concurrent/i.test(body)) return new ProviderError("CONCURRENCY", `供应商并发已满：${text}`, status);
  if (status === 404 || status === 423 || status === 503) return new ProviderError("MODEL_UNAVAILABLE", `模型不可用：HTTP ${status} ${text}`, status);
  if (status === 429) return new ProviderError("RETRYABLE", `限流：HTTP 429 ${text}`, status);
  if (status >= 500) return new ProviderError("RETRYABLE", `供应商故障：HTTP ${status} ${text}`, status);
  if (status === 400 || status === 422) return new ProviderError("BAD_REQUEST", `参数被拒：HTTP ${status} ${text}`, status);
  return new ProviderError("PROVIDER_FAILED", `供应商失败：HTTP ${status} ${text}`, status);
}

async function postJson(url: string, headers: Record<string, string>, body: unknown): Promise<unknown> {
  const res = await fetch(url, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });
  const text = await res.text();
  if (!res.ok) throw classify(res.status, text);
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new ProviderError("PROVIDER_FAILED", `响应不是 JSON：${text.slice(0, 200)}`);
  }
}

async function getJson(url: string, headers: Record<string, string>): Promise<{ ok: boolean; status: number; body: unknown; text: string }> {
  const res = await fetch(url, { method: "GET", headers });
  const text = await res.text();
  let body: unknown = null;
  try { body = JSON.parse(text) as unknown; } catch { body = null; }
  return { ok: res.ok, status: res.status, body, text };
}

/* ================= 火山方舟 · Seedance（视频，任务制异步） ================= */

export class ArkVideoProvider implements GenProvider {
  readonly providerId = "seedance";
  readonly kind: GenKind = "video";
  constructor(private readonly cfg: { apiKey: string; baseUrl?: string }) {}
  private base(): string {
    return (this.cfg.baseUrl ?? "https://ark.cn-beijing.volces.com/api/v3").replace(/\/$/, "");
  }
  async healthy(): Promise<boolean> { return Boolean(this.cfg.apiKey); }
  async submit(req: GenRequest): Promise<{ taskId: string }> {
    const p = neutral(req);
    const content: Array<Record<string, unknown>> = [{ type: "text", text: req.prompt }];
    /**
     * Ark 的 `content` 里**每张图都必须带 role**：真机 2026-09-22 实测，
     * 参考图不带 role 时直接 400 `role must be specified for image contents`
     * （渲染提交整批失败）。首帧用 first_frame，参考图用 reference_image。
     */
    const first = p.firstFrameUrl?.trim();
    if (first) content.push({ type: "image_url", image_url: { url: first }, role: "first_frame" });
    for (const url of p.referenceImageUrls ?? []) {
      if (url?.trim()) content.push({ type: "image_url", image_url: { url }, role: "reference_image" });
    }
    // 视频/音频参考（官方 SDK 支持 video_url / audio_url 内容类型；role 由调用方语义给出）
    for (const url of p.referenceVideoUrls ?? []) {
      if (url?.trim()) content.push({ type: "video_url", video_url: { url }, role: "reference_video" });
    }
    for (const url of p.referenceAudioUrls ?? []) {
      if (url?.trim()) content.push({ type: "audio_url", audio_url: { url }, role: "reference_audio" });
    }
    const payload: Record<string, unknown> = {
      model: requireModel(req),
      content,
      ...(p.durationSec ? { duration: Math.round(p.durationSec) } : {}),
      ...(p.frames ? { frames: Math.round(p.frames) } : {}),
      ...(p.aspectRatio ? { ratio: p.aspectRatio } : {}),
      ...(p.resolution ? { resolution: p.resolution } : {}),
      ...(p.generateAudio === undefined ? {} : { generate_audio: p.generateAudio }),
      ...(p.seed === undefined ? {} : { seed: p.seed }),
      /**
       * 官方 SDK（volcengine-python-sdk@5.0.50，2026-09-17）确认的新参数：
       * watermark / camera_fixed / return_last_frame / service_tier / priority /
       * execution_expires_after / output_format / callback_url。
       * watermark 默认 false（产品成片不应带平台水印）。
       */
      watermark: p.watermark ?? false,
      ...(p.cameraFixed === undefined ? {} : { camera_fixed: p.cameraFixed }),
      ...(p.returnLastFrame === undefined ? {} : { return_last_frame: p.returnLastFrame }),
      ...(p.serviceTier ? { service_tier: p.serviceTier } : {}),
      ...(p.priority === undefined ? {} : { priority: p.priority }),
      ...(p.executionExpiresAfter === undefined ? {} : { execution_expires_after: p.executionExpiresAfter }),
      ...(p.outputFormat ? { output_format: p.outputFormat } : {}),
      ...(p.callbackUrl ? { callback_url: p.callbackUrl } : {}),
      ...(p.extra ?? {}),
    };
    const data = await postJson(`${this.base()}/contents/generations/tasks`, { authorization: `Bearer ${this.cfg.apiKey}` }, payload) as { id?: string };
    if (!data?.id) throw new ProviderError("PROVIDER_FAILED", "Seedance 未返回 task_id");
    return { taskId: data.id };
  }
  async poll(taskId: string): Promise<{ status: GenTaskStatus; uri?: string; actualUnits?: number; error?: string }> {
    const r = await getJson(`${this.base()}/contents/generations/tasks/${taskId}`, { authorization: `Bearer ${this.cfg.apiKey}` });
    if (!r.ok) return { status: "failed", error: `Seedance 查询失败：HTTP ${r.status} ${r.text.slice(0, 120)}` };
    const d = r.body as { status?: string; content?: { video_url?: string }; error?: { message?: string }; usage?: { completion_tokens?: number } };
    if (d.status === "succeeded") return { status: "succeeded", uri: d.content?.video_url };
    if (d.status === "failed" || d.status === "cancelled" || d.status === "canceled") {
      return { status: "failed", error: d.error?.message ?? `生成失败（${d.status}）` };
    }
    return { status: d.status === "running" || d.status === "processing" ? "running" : "submitted" };
  }
}

/* ================= 火山方舟 · Seedream（图像；同步返回，taskId 内嵌结果 URL） ================= */

export class ArkImageProvider implements GenProvider {
  readonly providerId = "seedream";
  readonly kind: GenKind = "image";
  constructor(private readonly cfg: { apiKey: string; baseUrl?: string }) {}
  private base(): string {
    return (this.cfg.baseUrl ?? "https://ark.cn-beijing.volces.com/api/v3").replace(/\/$/, "");
  }
  async healthy(): Promise<boolean> { return Boolean(this.cfg.apiKey); }
  async submit(req: GenRequest): Promise<{ taskId: string }> {
    const p = neutral(req);
    const payload: Record<string, unknown> = {
      model: requireModel(req),
      prompt: req.prompt,
      response_format: "url",
      ...(p.resolution ? { size: p.resolution } : {}),
      ...(p.seed === undefined ? {} : { seed: p.seed }),
      ...(p.extra ?? {}),
    };
    const data = await postJson(`${this.base()}/images/generations`, { authorization: `Bearer ${this.cfg.apiKey}` }, payload) as { data?: Array<{ url?: string }> };
    const url = data?.data?.[0]?.url;
    if (!url) throw new ProviderError("PROVIDER_FAILED", "Seedream 未返回图像 URL");
    // 同步接口 → 用 taskId 内嵌结果（poll 直接解出，不轮询）
    return { taskId: `sync-url-${Buffer.from(url, "utf8").toString("base64url")}` };
  }
  async poll(taskId: string): Promise<{ status: GenTaskStatus; uri?: string; error?: string }> {
    if (!taskId.startsWith("sync-url-")) return { status: "failed", error: `未知的图像任务号：${taskId.slice(0, 24)}` };
    const url = Buffer.from(taskId.slice("sync-url-".length), "base64url").toString("utf8");
    return { status: "succeeded", uri: url };
  }
}

/* ================= Higgsfield 官方 API（异步任务 + 官方报价接口） ================= */

export class HiggsfieldProvider implements GenProvider {
  readonly providerId = "higgsfield";
  readonly kind: GenKind;
  constructor(
    private readonly cfg: { keyId: string; keySecret: string; baseUrl?: string; webhookUrl?: string; kind?: GenKind },
  ) {
    this.kind = cfg.kind ?? "video";
  }
  private base(): string {
    return (this.cfg.baseUrl ?? "https://api.higgsfield.ai").replace(/\/$/, "");
  }
  private auth(): Record<string, string> {
    return { authorization: `Key ${this.cfg.keyId}:${this.cfg.keySecret}` };
  }
  async healthy(): Promise<boolean> { return Boolean(this.cfg.keyId && this.cfg.keySecret); }

  /** 中立参数 → Higgsfield 请求体（端点 schema：prompt/resolution/duration/aspect_ratio/generate_audio/image_url） */
  private body(req: GenRequest): Record<string, unknown> {
    const p = neutral(req);
    return {
      prompt: req.prompt,
      ...(p.durationSec ? { duration: Math.round(p.durationSec) } : {}),
      ...(p.resolution ? { resolution: p.resolution } : {}),
      ...(p.aspectRatio ? { aspect_ratio: p.aspectRatio } : {}),
      ...(p.generateAudio === undefined ? {} : { generate_audio: p.generateAudio }),
      ...(p.firstFrameUrl ? { image_url: p.firstFrameUrl } : {}),
      ...(p.referenceImageUrls?.length ? { reference_images: p.referenceImageUrls } : {}),
      ...(p.seed === undefined ? {} : { seed: p.seed }),
      ...(p.extra ?? {}),
    };
  }

  async submit(req: GenRequest): Promise<{ taskId: string }> {
    const endpoint = requireModel(req);
    const qs = this.cfg.webhookUrl ? `?hf_webhook=${encodeURIComponent(this.cfg.webhookUrl)}` : "";
    const data = await postJson(`${this.base()}/${endpoint}${qs}`, this.auth(), this.body(req)) as {
      request_id?: string; id?: string;
    };
    const taskId = data?.request_id ?? data?.id;
    if (!taskId) throw new ProviderError("PROVIDER_FAILED", "Higgsfield 未返回 request_id");
    return { taskId };
  }

  async poll(taskId: string): Promise<{ status: GenTaskStatus; uri?: string; error?: string }> {
    const r = await getJson(`${this.base()}/requests/${taskId}/status`, this.auth());
    if (!r.ok) return { status: "failed", error: `Higgsfield 查询失败：HTTP ${r.status} ${r.text.slice(0, 120)}` };
    const d = r.body as {
      status?: string; error?: unknown;
      video?: { url?: string }; images?: Array<{ url?: string }>; payload?: { video?: { url?: string } };
    };
    const uri = d.video?.url ?? d.images?.[0]?.url ?? d.payload?.video?.url;
    if (d.status === "completed") return { status: "succeeded", uri };
    if (d.status === "failed" || d.status === "nsfw" || d.status === "canceled") {
      return { status: "failed", error: d.status === "nsfw" ? "内容审核未通过（nsfw，不计费）" : String(d.error ?? d.status) };
    }
    return { status: d.status === "in_progress" ? "running" : "submitted" };
  }

  /** 官方报价：POST /estimate/<endpoint> → { credits, usd } */
  async estimate(endpoint: string, params: Record<string, unknown>): Promise<{ usd: number | null; credits: number | null }> {
    const data = await postJson(`${this.base()}/estimate/${endpoint}`, this.auth(), params) as { usd?: string | number; credits?: string | number };
    const usd = data?.usd === undefined ? null : Number(data.usd);
    const credits = data?.credits === undefined ? null : Number(data.credits);
    return { usd: Number.isFinite(usd as number) ? (usd as number) : null, credits: Number.isFinite(credits as number) ? (credits as number) : null };
  }
}

/* ================= MuAPI 聚合器（默认关闭；x-api-key；沙箱 key 返回 mock） ================= */

export class MuapiProvider implements GenProvider {
  readonly providerId = "muapi";
  readonly kind: GenKind;
  constructor(private readonly cfg: { apiKey: string; baseUrl?: string; kind?: GenKind }) {
    this.kind = cfg.kind ?? "video";
  }
  private base(): string {
    return (this.cfg.baseUrl ?? "https://api.muapi.ai").replace(/\/$/, "");
  }
  async healthy(): Promise<boolean> { return Boolean(this.cfg.apiKey); }
  async submit(req: GenRequest): Promise<{ taskId: string }> {
    const p = neutral(req);
    const data = await postJson(`${this.base()}/api/v1/${requireModel(req)}`, { "x-api-key": this.cfg.apiKey }, {
      prompt: req.prompt,
      ...(p.durationSec ? { duration: Math.round(p.durationSec) } : {}),
      ...(p.aspectRatio ? { aspect_ratio: p.aspectRatio } : {}),
      ...(p.resolution ? { resolution: p.resolution } : {}),
      ...(p.firstFrameUrl ? { image_url: p.firstFrameUrl } : {}),
      ...(p.extra ?? {}),
    }) as { request_id?: string; id?: string };
    const taskId = data?.request_id ?? data?.id;
    if (!taskId) throw new ProviderError("PROVIDER_FAILED", "MuAPI 未返回 request_id");
    return { taskId };
  }
  async poll(taskId: string): Promise<{ status: GenTaskStatus; uri?: string; error?: string }> {
    const r = await getJson(`${this.base()}/api/v1/predictions/${taskId}/result`, { "x-api-key": this.cfg.apiKey });
    if (!r.ok) return { status: "failed", error: `MuAPI 查询失败：HTTP ${r.status}` };
    const d = r.body as { status?: string; url?: string; outputs?: string[]; error?: string };
    const uri = d.url ?? d.outputs?.[0];
    const st = (d.status ?? "").toLowerCase();
    if (["completed", "succeeded", "success"].includes(st)) return { status: "succeeded", uri };
    if (["failed", "error"].includes(st)) return { status: "failed", error: d.error ?? "生成失败" };
    return { status: "running" };
  }
}

/* ================= 装配：env 驱动 + fail-closed（缺密钥=缺位，不 mock 冒充） ================= */

export interface GenPoolOptions {
  env?: NodeJS.ProcessEnv;
  /** 允许注入 fetch 实现（测试用；默认全局 fetch） */
  fetchImpl?: typeof fetch;
}

export function buildVideoGenPool(opts: GenPoolOptions = {}): Map<string, GenProvider> {
  const env = opts.env ?? process.env;
  const pool = new Map<string, GenProvider>();
  const arkKey = env.VOLCENGINE_ARK_API_KEY?.trim();
  if (arkKey) {
    pool.set("seedance", new ArkVideoProvider({ apiKey: arkKey, baseUrl: env.SEEDANCE_ENDPOINT?.trim() || undefined }));
    pool.set("seedream", new ArkImageProvider({ apiKey: arkKey, baseUrl: env.SEEDREAM_ENDPOINT?.trim() || env.SEEDANCE_ENDPOINT?.trim() || undefined }));
  }
  const hfId = env.HF_API_KEY_ID?.trim();
  const hfSecret = env.HF_API_KEY_SECRET?.trim();
  if (hfId && hfSecret) {
    pool.set("higgsfield", new HiggsfieldProvider({
      keyId: hfId, keySecret: hfSecret,
      baseUrl: env.HF_BASE_URL?.trim() || undefined,
      webhookUrl: env.HF_WEBHOOK_URL?.trim() || undefined,
    }));
  }
  const muapiKey = env.MUAPI_API_KEY?.trim();
  if (muapiKey) pool.set("muapi", new MuapiProvider({ apiKey: muapiKey, baseUrl: env.MUAPI_BASE_URL?.trim() || undefined }));
  // 国内备援（基座适配器复用；env 配置即启用，未配置则缺位——由降级链跳过）
  const klingKey = env.KLING_API_KEY?.trim();
  if (klingKey) {
    pool.set("kling", new KlingProvider({
      apiKey: klingKey,
      baseUrl: env.KLING_ENDPOINT?.trim() || undefined,
      model: env.KLING_MODEL?.trim() || undefined,
    }));
  }
  const jimengKey = env.JIMENG_API_KEY?.trim();
  if (jimengKey) {
    pool.set("jimeng", new JimengProvider({
      apiKey: jimengKey,
      baseUrl: env.JIMENG_ENDPOINT?.trim() || undefined,
      model: env.JIMENG_MODEL?.trim() || undefined,
    }));
  }
  return pool;
}

/** 供 poller 使用：把供应商 id 解析成适配器（单例池，避免每轮重建） */
let singletonPool: { key: string; pool: Map<string, GenProvider> } | null = null;
export function videoGenPool(): Map<string, GenProvider> {
  const env = process.env;
  const key = [env.VOLCENGINE_ARK_API_KEY, env.HF_API_KEY_ID, env.HF_API_KEY_SECRET, env.MUAPI_API_KEY].join("|");
  if (!singletonPool || singletonPool.key !== key) singletonPool = { key, pool: buildVideoGenPool() };
  return singletonPool.pool;
}
