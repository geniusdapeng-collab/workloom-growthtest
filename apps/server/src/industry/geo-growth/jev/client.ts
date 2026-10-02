/**
 * Jev 客户端（两条通道，同一套解析/重试/密钥安全纪律）
 *
 * 通道 2（默认，官方直连 · TypeSafe API v1）：
 *   POST {base}/v1/systemone      Authorization: Bearer <TYPESAFE_API_KEY>
 *   请求体 {state, model, questions}；官方问题原语只有 noul / choice / score，
 *   因此本模块内部的 `boolean` 问题在出站前映射为 `noul`（见 toTypeSafeQuestions）；
 *   响应 {model, answers, usage:{input_tokens, output_tokens}}（docs.typesafe.ai/api）。
 *
 * 通道 1（备选，Vercel AI Gateway · evaluation 协议 v4）：
 *   POST {base}/v4/ai/evaluation-model + 三个协议头（ai-gateway-protocol-version 等）。
 *
 * 为什么不用基座 model-router：model-router 的提供方契约是 OpenAI 兼容 chat（messages → text），
 * 而 Jev 是 evaluation 协议（state + typed questions → typed answers，官方文档明确不支持
 * OpenAI 兼容端点）。把它硬塞进 chat 契约会破坏"出站必备脱敏"的既有语义，因此本试点先在行业侧
 * 独立实现；若验证通过，再按协议 §10.2 走提案任务卡把 DecisionProvider 演进到基座。
 *
 * 可靠性纪律（对齐 jev-ultrafast 的传输层）：
 *   - 只读调用：evaluation 不产生副作用，因此 429/529/503 与网络/超时可安全重试；
 *   - 退避：指数退避 + 抖动，尊重 retry-after 头；
 *   - 超时：AbortController 硬超时（默认 20s）；
 *   - 密钥：只从参数/环境读取，绝不进入日志与错误消息（错误消息里只出现状态码与主机名）。
 */
import { JevResponseError, parseAnswers } from "./protocol.js";
import type { JevCallResult, JevProvider, JevQuestionSet, JevRequest } from "./types.js";

export type JevErrorCode =
  | "missing_key"
  | "auth"
  | "bad_request"
  | "rate_limited"
  | "overloaded"
  | "server"
  | "timeout"
  | "network"
  | "invalid_response";

export class JevError extends Error {
  constructor(
    readonly code: JevErrorCode,
    message: string,
    readonly options: { status?: number; retryable?: boolean } = {},
  ) {
    super(message);
    this.name = "JevError";
  }

  get retryable(): boolean {
    return this.options.retryable ?? false;
  }
}

export interface JevClientOptions {
  apiKey?: string;
  /** 接入通道；默认 typesafe（官方直连） */
  provider?: JevProvider;
  /** 通道根地址；默认按 provider 取 https://api.typesafe.ai 或 https://ai-gateway.vercel.sh */
  baseUrl?: string;
  /** 模型 id；默认按 provider 取 jev-latest（直连）或 typesafe-ai/jev（网关） */
  model?: string;
  /** 单次请求硬超时（毫秒） */
  timeoutMs?: number;
  /** 最大尝试次数（含首次） */
  maxAttempts?: number;
  /** 注入点：测试用假 fetch；默认全局 fetch */
  fetchImpl?: typeof fetch;
  /** 注入点：测试用假睡眠；默认真实等待 */
  sleepImpl?: (ms: number) => Promise<void>;
  /** 注入点：测试用假时钟；默认 Date.now */
  nowImpl?: () => number;
}

/** 通道 2：TypeSafe 官方直连 */
export const TYPESAFE_BASE_URL = "https://api.typesafe.ai";
export const TYPESAFE_MODEL = "jev-latest";
export const TYPESAFE_PATH = "/v1/systemone";

/** 通道 1：Vercel AI Gateway */
export const GATEWAY_BASE_URL = "https://ai-gateway.vercel.sh";
export const GATEWAY_MODEL = "typesafe-ai/jev";
export const GATEWAY_PATH = "/v4/ai/evaluation-model";

/** 兼容既有调用点：默认通道（官方直连）的根地址与模型 id */
export const DEFAULT_BASE_URL = TYPESAFE_BASE_URL;
export const DEFAULT_MODEL = TYPESAFE_MODEL;

export const GATEWAY_PROTOCOL_VERSION = "0.0.1";
export const EVALUATION_SPEC_VERSION = "4";

const RETRY_STATUS = new Set([429, 500, 502, 503, 529]);

export function defaultBaseUrl(provider: JevProvider): string {
  return provider === "typesafe" ? TYPESAFE_BASE_URL : GATEWAY_BASE_URL;
}

export function defaultModel(provider: JevProvider): string {
  return provider === "typesafe" ? TYPESAFE_MODEL : GATEWAY_MODEL;
}

/**
 * 本模块内部问题类型 → TypeSafe 官方原语名（出站映射，仅通道 2 需要）：
 *   boolean → noul（官方只有 noul/choice/score；字段仍是 instructions + criteria{true,false}）
 *   choice / score 原样透传。
 * 出站前的这层映射是**纯函数**，便于单测断言"发出去的到底是什么"。
 */
export function toTypeSafeQuestions(questions: JevQuestionSet): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [id, question] of Object.entries(questions)) {
    if (question.type === "boolean") {
      const criteria = question.criteria;
      const mapped: Record<string, unknown> = {
        type: "noul",
        instructions: question.instructions,
      };
      if (criteria && (criteria.true !== undefined || criteria.false !== undefined)) {
        mapped["criteria"] = {
          ...(criteria.true !== undefined ? { true: criteria.true } : {}),
          ...(criteria.false !== undefined ? { false: criteria.false } : {}),
        };
      }
      out[id] = mapped;
      continue;
    }
    if (question.type === "choice") {
      out[id] = {
        type: "choice",
        instructions: question.instructions,
        criteria: question.criteria,
      };
      continue;
    }
    out[id] = {
      type: "score",
      instructions: question.instructions,
      criteria: question.criteria,
    };
  }
  return out;
}

function backoffMs(attempt: number, retryAfterHeader: string | null): number {
  const retryAfterSeconds = retryAfterHeader === null ? Number.NaN : Number(retryAfterHeader);
  if (Number.isFinite(retryAfterSeconds) && retryAfterSeconds >= 0) {
    return Math.min(retryAfterSeconds * 1000, 15_000);
  }
  const base = Math.min(500 * 2 ** (attempt - 1), 8_000);
  return base + Math.floor(Math.random() * 250);
}

export class JevClient {
  private readonly apiKey: string | undefined;
  private readonly provider: JevProvider;
  private readonly baseUrl: string;
  private readonly model: string;
  private readonly timeoutMs: number;
  private readonly maxAttempts: number;
  private readonly fetchImpl: typeof fetch;
  private readonly sleepImpl: (ms: number) => Promise<void>;
  private readonly nowImpl: () => number;

  constructor(options: JevClientOptions = {}) {
    this.apiKey = options.apiKey?.trim() || undefined;
    this.provider = options.provider ?? "typesafe";
    this.baseUrl = (options.baseUrl ?? defaultBaseUrl(this.provider)).replace(/\/+$/, "");
    this.model = options.model ?? defaultModel(this.provider);
    this.timeoutMs = options.timeoutMs ?? 20_000;
    this.maxAttempts = Math.max(1, options.maxAttempts ?? 3);
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.sleepImpl = options.sleepImpl ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.nowImpl = options.nowImpl ?? (() => Date.now());
  }

  get modelId(): string {
    return this.model;
  }

  get providerId(): JevProvider {
    return this.provider;
  }

  /** 人读的通道名（日志/错误消息用；不含任何密钥） */
  get providerLabel(): string {
    return this.provider === "typesafe" ? "TypeSafe 官方 API" : "Vercel AI Gateway";
  }

  get host(): string {
    try {
      return new URL(this.baseUrl).host;
    } catch {
      return this.baseUrl;
    }
  }

  /**
   * 按通道组装请求三件套。通道差异**只在这里**体现：
   *   - 直连：`/v1/systemone` + Bearer；请求体带 `model`，问题用官方原语名（boolean→noul）；
   *   - 网关：`/v4/ai/evaluation-model` + 三个协议头；请求体不带 model，问题沿用 v4 类型名。
   */
  private buildRequest(request: JevRequest): {
    url: string;
    headers: Record<string, string>;
    body: string;
  } {
    if (this.provider === "typesafe") {
      return {
        url: `${this.baseUrl}${TYPESAFE_PATH}`,
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${this.apiKey ?? ""}`,
        },
        body: JSON.stringify({
          state: request.state,
          model: this.model,
          questions: toTypeSafeQuestions(request.questions),
        }),
      };
    }
    return {
      url: `${this.baseUrl}${GATEWAY_PATH}`,
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${this.apiKey ?? ""}`,
        "ai-gateway-protocol-version": GATEWAY_PROTOCOL_VERSION,
        "ai-evaluation-model-specification-version": EVALUATION_SPEC_VERSION,
        "ai-model-id": this.model,
      },
      body: JSON.stringify({ state: request.state, questions: request.questions }),
    };
  }

  /** 单次评估：state + 若干类型化问题 → 类型化回答（失败抛 JevError） */
  async evaluate(request: JevRequest, signal?: AbortSignal): Promise<JevCallResult> {
    if (!this.apiKey) {
      // 免 key 网关（如本地 mock）允许空 key；真实网关必须显式给出，避免"以为在调真模型"
      if (!this.baseUrl.includes("127.0.0.1") && !this.baseUrl.includes("localhost")) {
        throw new JevError(
          "missing_key",
          `缺少 ${this.provider === "typesafe" ? "TYPESAFE_API_KEY" : "AI_GATEWAY_API_KEY"}（真实通道必须提供；--mock 走本地模拟）`,
        );
      }
    }
    const { url, headers, body } = this.buildRequest(request);
    let lastError: JevError | undefined;

    for (let attempt = 1; attempt <= this.maxAttempts; attempt += 1) {
      const started = this.nowImpl();
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.timeoutMs);
      const onOuterAbort = () => controller.abort();
      signal?.addEventListener("abort", onOuterAbort, { once: true });
      try {
        const response = await this.fetchImpl(url, {
          method: "POST",
          headers,
          body,
          signal: controller.signal,
        });
        const text = await response.text();
        if (!response.ok) {
          const error = this.errorForStatus(response.status, response.headers.get("retry-after"));
          if (error.retryable && attempt < this.maxAttempts) {
            lastError = error;
            await this.sleepImpl(backoffMs(attempt, response.headers.get("retry-after")));
            continue;
          }
          throw error;
        }
        let parsed: unknown;
        try {
          parsed = JSON.parse(text);
        } catch {
          throw new JevError("invalid_response", "网关返回非 JSON 响应");
        }
        return parseAnswers(parsed, request.questions, this.model, this.nowImpl() - started);
      } catch (error) {
        const normalized = this.normalizeError(error);
        if (normalized.code === "invalid_response") throw normalized;
        if (normalized.retryable && attempt < this.maxAttempts) {
          lastError = normalized;
          await this.sleepImpl(backoffMs(attempt, null));
          continue;
        }
        throw normalized;
      } finally {
        clearTimeout(timer);
        signal?.removeEventListener("abort", onOuterAbort);
      }
    }
    throw lastError ?? new JevError("network", "网关不可用且无可返回结果");
  }

  private errorForStatus(status: number, retryAfter: string | null): JevError {
    if (status === 401 || status === 403) {
      return new JevError("auth", `${this.providerLabel} 鉴权失败（HTTP ${status}，host=${this.host}）`);
    }
    if (status === 429) {
      return new JevError("rate_limited", `${this.providerLabel} 限流（HTTP 429，retry-after=${retryAfter ?? "无"}）`, {
        status,
        retryable: true,
      });
    }
    if (status === 529) {
      return new JevError("overloaded", `${this.providerLabel} 过载（HTTP 529）`, { status, retryable: true });
    }
    if (RETRY_STATUS.has(status)) {
      return new JevError("server", `${this.providerLabel} 错误（HTTP ${status}）`, { status, retryable: true });
    }
    if (status === 400 || status === 422) {
      return new JevError("bad_request", `请求被拒（HTTP ${status}；检查 ${this.provider === "typesafe" ? "model/问题结构" : "协议头/问题结构"}）`, {
        status,
      });
    }
    return new JevError("server", `${this.providerLabel} 返回 HTTP ${status}`, { status });
  }

  private normalizeError(error: unknown): JevError {
    if (error instanceof JevError) return error;
    if (error instanceof JevResponseError) {
      return new JevError("invalid_response", `回答非法：${error.message}`);
    }
    if (error instanceof Error && (error.name === "AbortError" || error.name === "TimeoutError")) {
      return new JevError("timeout", `${this.providerLabel} 超时（>${this.timeoutMs}ms）`, { retryable: true });
    }
    const message = error instanceof Error ? error.message : String(error);
    return new JevError("network", `${this.providerLabel} 连接失败：${message}`, { retryable: true });
  }
}

/**
 * 通道判定（显式优先，其次按键推断，最后默认官方直连）：
 *   ① `JEV_PROVIDER=typesafe|vercel-gateway`（也接受 direct/gateway 简写）；
 *   ② 存在 `TYPESAFE_API_KEY` → 直连；存在 `AI_GATEWAY_API_KEY`/`VERCEL_AI_GATEWAY_KEY` → 网关；
 *   ③ 都没有 → 直连（真实调用会因缺 key 明确报错，而不是悄悄换通道）。
 */
export function resolveProvider(env: NodeJS.ProcessEnv = process.env): JevProvider {
  const explicit = env["JEV_PROVIDER"]?.trim().toLowerCase();
  if (explicit) {
    if (explicit === "typesafe" || explicit === "typesafe-direct" || explicit === "direct") return "typesafe";
    if (explicit === "vercel-gateway" || explicit === "vercel" || explicit === "gateway") return "vercel-gateway";
    throw new Error(`未知 JEV_PROVIDER：${explicit}（可选 typesafe | vercel-gateway）`);
  }
  if (env["TYPESAFE_API_KEY"]?.trim()) return "typesafe";
  if (env["AI_GATEWAY_API_KEY"]?.trim() || env["VERCEL_AI_GATEWAY_KEY"]?.trim()) return "vercel-gateway";
  return "typesafe";
}

/** 当前通道对应的密钥（只读环境，不落任何文件） */
export function apiKeyFromEnv(env: NodeJS.ProcessEnv, provider: JevProvider): string | undefined {
  return provider === "typesafe"
    ? env["TYPESAFE_API_KEY"]?.trim() || undefined
    : (env["AI_GATEWAY_API_KEY"] ?? env["VERCEL_AI_GATEWAY_KEY"])?.trim() || undefined;
}

/** 从环境构造（key 缺失时留空，由调用方决定 mock 还是报错） */
export function clientFromEnv(
  env: NodeJS.ProcessEnv = process.env,
  overrides: Partial<JevClientOptions> = {},
): JevClient {
  const provider = overrides.provider ?? resolveProvider(env);
  return new JevClient({
    provider,
    apiKey: apiKeyFromEnv(env, provider),
    baseUrl: env["JEV_BASE_URL"] ?? defaultBaseUrl(provider),
    model: env["JEV_MODEL"] ?? defaultModel(provider),
    timeoutMs: env["JEV_TIMEOUT_MS"] ? Number(env["JEV_TIMEOUT_MS"]) : undefined,
    ...overrides,
  });
}
