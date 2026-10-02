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
import { ProviderError } from "./types.js";
import { compileProviderRequest, type CompiledProviderRequest } from "./compiled-request.js";
import { WhiteboardProvider } from "../whiteboard/provider.js";
import { whiteboardEngineReady } from "../whiteboard/engine.js";
import { RemotionProvider } from "../explainer/remotion-provider.js";

/** HTTP 失败 → 统一分类（401/并发满/模型不可用/可重试/其他） */
function classify(status: number, body: string): ProviderError {
  const text = body.slice(0, 300);
  if (status === 401 || status === 403) return new ProviderError("AUTH", `鉴权失败：HTTP ${status} ${text}`, status);
  /**
   * 真人隐私闸（真机 2026-09-23 实测）：seedance 对"可能包含真人"的输入图一律 400，
   * `reference_image` 与 `first_frame` 都被拦（真人照片、以及用真人照片生成的定妆照同样被拦；
   * 纯合成人脸可以通过）。这条是**平台政策**，不能靠重试或换供应商绕，必须显式告知并走官方通道。
   */
  if (status === 400 && /InputImageSensitiveContentDetected|may contain real person/i.test(body)) {
    return new ProviderError(
      "MODERATION",
      "平台隐私检测拒绝真人图像输入（InputImageSensitiveContentDetected.PrivacyInformation）：seedance 不接受"
      + "真人照片，reference_image / first_frame 均被拦。请走方舟「含肖像视频」官方授权通道，或改用非真人素材"
      + `（例如 Seedream 生成的合成人物）。原始响应：${text}`,
      status
    );
  }
  if (status === 400 && /concurrent/i.test(body)) return new ProviderError("CONCURRENCY", `供应商并发已满：${text}`, status);
  if (status === 404 || status === 423) return new ProviderError("MODEL_UNAVAILABLE", `模型不可用：HTTP ${status} ${text}`, status, "not-accepted");
  if (status === 429) return new ProviderError("RETRYABLE", `限流：HTTP 429 ${text}`, status, "not-accepted");
  if (status >= 500) return new ProviderError("RETRYABLE", `供应商故障：HTTP ${status} ${text}`, status);
  if (status === 400 || status === 422) return new ProviderError("BAD_REQUEST", `参数被拒：HTTP ${status} ${text}`, status);
  return new ProviderError("PROVIDER_FAILED", `供应商失败：HTTP ${status} ${text}`, status);
}

/** C-06 修复：供应商出站调用统一 60s 超时（此前无超时，网关挂起即永久 await） */
const FETCH_TIMEOUT_MS = Number(process.env.VIDEO_PROVIDER_FETCH_TIMEOUT_MS ?? 60_000);

async function postJson(url: string, headers: Record<string, string>, body: unknown): Promise<unknown> {
  const res = await fetch(url, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body), signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) }); // C-06：出站调用必须有限时，不得永久 await
  const text = await res.text();
  if (!res.ok) throw classify(res.status, text);
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new ProviderError("PROVIDER_FAILED", `响应不是 JSON：${text.slice(0, 200)}`);
  }
}

/** 直接发送编译后的 JSON，不在审核后再映射、追加或覆盖字段。 */
async function postCompiled(compiled: CompiledProviderRequest, headers: Record<string, string>): Promise<unknown> {
  const res = await fetch(compiled.endpoint, { method: compiled.method, headers: { "content-type": "application/json", ...headers }, body: compiled.bodyJson, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) }); // C-06
  const text = await res.text();
  if (!res.ok) throw classify(res.status, text);
  try { return JSON.parse(text) as unknown; }
  catch { throw new ProviderError("PROVIDER_FAILED", "供应商响应不是有效 JSON"); }
}

async function getJson(url: string, headers: Record<string, string>): Promise<{ ok: boolean; status: number; body: unknown; text: string }> {
  const res = await fetch(url, { method: "GET", headers, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) }); // C-06
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
    const compiled = compileProviderRequest(this.providerId, req, this.cfg);
    const data = await postCompiled(compiled, { authorization: `Bearer ${this.cfg.apiKey}` }) as { id?: string };
    if (typeof data?.id !== "string" || !data.id.trim()) throw new ProviderError("PROVIDER_FAILED", "Seedance 未返回 task_id");
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
    const compiled = compileProviderRequest(this.providerId, req, this.cfg);
    const data = await postCompiled(compiled, { authorization: `Bearer ${this.cfg.apiKey}` }) as { data?: Array<{ url?: string }> };
    const url = data?.data?.[0]?.url;
    if (typeof url !== "string" || !url.trim()) throw new ProviderError("PROVIDER_FAILED", "Seedream 未返回图像 URL");
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

  async submit(req: GenRequest): Promise<{ taskId: string }> {
    const compiled = compileProviderRequest(this.providerId, req, this.cfg);
    const data = await postCompiled(compiled, this.auth()) as { request_id?: string; id?: string };
    const taskId = data?.request_id ?? data?.id;
    if (typeof taskId !== "string" || !taskId.trim()) throw new ProviderError("PROVIDER_FAILED", "Higgsfield 未返回 request_id");
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
    const compiled = compileProviderRequest(this.providerId, req, this.cfg);
    const data = await postCompiled(compiled, { "x-api-key": this.cfg.apiKey }) as { request_id?: string; id?: string };
    const taskId = data?.request_id ?? data?.id;
    if (typeof taskId !== "string" || !taskId.trim()) throw new ProviderError("PROVIDER_FAILED", "MuAPI 未返回 request_id");
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
  /**
   * 本地白板渲染器（T-2026-0926-0020）：**零 API 依赖**，开关 + venv 就绪即可用。
   * 与上面几家不同，它的"配置"不是密钥而是 `WHITEBOARD_ENABLED=1` + venv 解释器存在，
   * 因此单独判定（`whiteboardEngineReady`）；否则 `WHITEBOARD_ENABLED=0` 会因为
   * "环境变量非空"被通用口径误判为已配置。
   */
  if (whiteboardEngineReady(env)) pool.set("whiteboard-local", new WhiteboardProvider(env));
  /**
   * 本机口播解说渲染（talkcraft 引擎，T-2026-0926-0008）：**只认开关**，不认密钥。
   * 真实就绪度由 provider.healthy() 复检（引擎安装完整 + 运行时冒烟 + 许可闸），
   * 因此"目录 wired 但引擎没装"会以 unhealthy 明确拒绝，不会静默 mock。
   */
  if ((env.TALKCRAFT_ENABLED ?? "0").trim() === "1") {
    pool.set("remotion-local", new RemotionProvider({ env }));
  }
  return pool;
}

/** 供 poller 使用：把供应商 id 解析成适配器（单例池，避免每轮重建） */
let singletonPool: { key: string; pool: Map<string, GenProvider> } | null = null;
export function videoGenPool(env: NodeJS.ProcessEnv = process.env): Map<string, GenProvider> {
  /**
   * 单例缓存键必须包含**所有影响装配的输入**：白板引擎由"开关 + venv 是否存在"驱动，
   * 只按密钥拼键会出现"装了 venv，但池子仍是旧的（没有 whiteboard-local）"的假不可用。
   * 同理，talkcraft 引擎由 `TALKCRAFT_ENABLED` 驱动（运行中开闸必须立即生效，不等进程重启）。
   */
  const key = [
    env.VOLCENGINE_ARK_API_KEY, env.HF_API_KEY_ID, env.HF_API_KEY_SECRET, env.MUAPI_API_KEY,
    env.KLING_API_KEY, env.JIMENG_API_KEY,
    env.SEEDANCE_ENDPOINT, env.SEEDREAM_ENDPOINT, env.HF_BASE_URL, env.HF_WEBHOOK_URL,
    env.MUAPI_BASE_URL, env.KLING_ENDPOINT, env.KLING_MODEL, env.JIMENG_ENDPOINT, env.JIMENG_MODEL,
    env.WHITEBOARD_ENABLED, env.WHITEBOARD_ENGINE_DIR, env.WHITEBOARD_PYTHON,
    env.TALKCRAFT_ENABLED, env.TALKCRAFT_ENGINE_DIR,
  ].join("|");
  if (!singletonPool || singletonPool.key !== key) singletonPool = { key, pool: buildVideoGenPool({ env }) };
  return singletonPool.pool;
}
