/**
 * Sole OpenAI-compatible text transport.
 *
 * Text calls use one canonical model (`deepseek-flash`). Media generation has
 * a separate registry and is intentionally not handled here.
 */
import { createHash } from "node:crypto";
import { maskDeep } from "../workdata/pii.js";
import {
  canonicalDeepSeekModel,
  planDeepSeekWindow,
  DEEPSEEK_FLASH_MODEL_ID,
  DEEPSEEK_FLASH_CONTEXT_TOKENS,
  DEEPSEEK_FLASH_MAX_OUTPUT_TOKENS,
  TEXT_PRIMARY_POLICY_VERSION,
  TEXT_PRIMARY_REGISTRY_VERSION,
  type BudgetMessage,
  type ModelContentPart,
  type ModelMessageContent,
} from "./token-budget.js";
import {
  resolveTextScenePolicy,
  type TextScenePolicy,
  type ThinkingEffort,
} from "./deepseek-policy.js";

export interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: ModelMessageContent;
}

export interface ChatUsageReceipt {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  reasoningTokens: number;
  promptCacheHitTokens: number | null;
  promptCacheMissTokens: number | null;
}

export interface ChatResult {
  text: string;
  promptTokens: number;
  completionTokens: number;
  modelId: string;
  finishReason: "stop";
  reasoningTokens: number;
  requestHash: string;
  responseHash: string;
  responseId: string | null;
  scene: string;
  mode: "enabled" | "disabled";
  effort?: ThinkingEffort;
  outputCeiling: number;
  inputTokenEstimate: number;
  imageCount: number;
  policyVersion: string;
  registryVersion: string;
  attempts: Array<{ attempt: number; code?: string; httpStatus?: number; unknown?: boolean; retryable?: boolean }>;
}

/** Generation controls only; model selection, credentials and accounting stay centralized. */
export interface ChatGenerationOptions {
  temperature?: number;
  topP?: number;
  /** @deprecated Ignored. Product output caps require an explicit product rule. */
  maxTokens?: number;
  responseFormat?: { type: string };
  thinking?: Record<string, unknown>;
  reasoningEffort?: ThinkingEffort;
  /** Validated product constraint; absence means the complete legal output window. */
  productOutputCap?: number;
  scene?: string;
}

export interface ChatOptions extends ChatGenerationOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
  retries?: number;
}

export type ModelProviderErrorKind =
  | "cancelled"
  | "timeout"
  | "network"
  | "http"
  | "protocol"
  | "empty"
  | "unknown";

export class ModelProviderError extends Error {
  constructor(
    message: string,
    readonly kind: ModelProviderErrorKind,
    readonly options: {
      retryable?: boolean;
      status?: number;
      unknown?: boolean;
      cause?: unknown;
      receipt?: Partial<ChatResult>;
    } = {},
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "ModelProviderError";
  }

  get retryable(): boolean {
    return this.options.retryable ?? false;
  }

  get unknown(): boolean {
    return this.options.unknown ?? false;
  }
}

export interface ModelProvider {
  readonly modelId: string;
  healthy(): Promise<boolean>;
  chat(messages: ChatMessage[], opts?: ChatOptions): Promise<ChatResult>;
}

export function mockCredits(modelId: string, result: ChatResult): number {
  const per1k = modelId.includes("flagship") ? 4 : 1;
  return Math.max(1, Math.ceil((result.promptTokens + result.completionTokens) / 1_000) * per1k);
}

function textFromContent(content: unknown): string {
  if (typeof content === "string") return content.trim();
  if (!Array.isArray(content)) return "";
  return content
    .map((part) => {
      if (!part || typeof part !== "object") return "";
      const record = part as Record<string, unknown>;
      if (record.type === "text" && typeof record.text === "string") return record.text;
      if (record.type === "output_text" && typeof record.text === "string") return record.text;
      return "";
    })
    .join("")
    .trim();
}

function sanitizeContent(content: ModelMessageContent): ModelMessageContent {
  if (typeof content === "string") return maskDeep(content).value;
  return content.map((part): ModelContentPart => {
    if (part.type === "text") return { ...part, text: maskDeep(part.text).value };
    return part;
  });
}

/**
 * Deterministic offline provider. It is allowed only when `LLM_PROVIDER=mock`
 * and is never used as a production fallback.
 */
export class MockProvider implements ModelProvider {
  private calls = 0;

  constructor(
    public readonly modelId: string = DEEPSEEK_FLASH_MODEL_ID,
    private readonly opts: { failFirst?: number; down?: boolean } = {},
  ) {}

  async healthy(): Promise<boolean> {
    return !this.opts.down;
  }

  async chat(messages: ChatMessage[], opts: ChatOptions = {}): Promise<ChatResult> {
    if (opts.signal?.aborted) throw new ModelProviderError("模型调用已取消", "cancelled");
    this.calls += 1;
    if (this.opts.failFirst && this.calls <= this.opts.failFirst) {
      throw new ModelProviderError(`mock 故障注入（第 ${this.calls} 次）`, "network", {
        retryable: true,
      });
    }
    const last = messages[messages.length - 1];
    const content = typeof last?.content === "string"
      ? last.content
      : Array.isArray(last?.content)
        ? last.content.map((part) => part.type === "text" ? part.text : "").join("")
        : "";
    const masked = maskDeep(content).value;
    const text = `[mock:${this.modelId}] ${masked.slice(0, 40)} → 确定性应答`;
    const requestHash = createHash("sha256").update(JSON.stringify(messages)).digest("hex");
    return {
      text,
      promptTokens: Math.max(1, content.length),
      completionTokens: Math.max(1, text.length),
      modelId: this.modelId,
      finishReason: "stop",
      reasoningTokens: 0,
      requestHash,
      responseHash: createHash("sha256").update(text).digest("hex"),
      responseId: null,
      scene: opts.scene ?? "generic",
      mode: opts.thinking?.type === "enabled" ? "enabled" : "disabled",
      effort: opts.reasoningEffort,
      outputCeiling: DEEPSEEK_FLASH_MAX_OUTPUT_TOKENS,
      inputTokenEstimate: content.length,
      imageCount: 0,
      policyVersion: TEXT_PRIMARY_POLICY_VERSION,
      registryVersion: TEXT_PRIMARY_REGISTRY_VERSION,
      attempts: [],
    };
  }
}

interface OpenAiResponse {
  id?: string;
  model?: string;
  choices?: Array<{
    finish_reason?: string;
    message?: {
      content?: unknown;
      reasoning_content?: string | null;
    };
  }>;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
    completion_tokens_details?: { reasoning_tokens?: number };
    prompt_cache_hit_tokens?: number;
    prompt_cache_miss_tokens?: number;
  };
}

function normalizeBaseUrl(value: string): string {
  return value.trim().replace(/\/+$/, "").replace(/\/anthropic$/i, "");
}

function safeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 0;
}

function policyForOptions(opts: ChatOptions): TextScenePolicy {
  const responseFormat = opts.responseFormat?.type;
  if (responseFormat !== undefined && responseFormat !== "json_object" && responseFormat !== "text") {
    throw new Error(`MODEL_RESPONSE_FORMAT_INVALID: ${responseFormat}`);
  }
  let thinking: TextScenePolicy["thinking"] | undefined;
  if (opts.thinking) {
    if (opts.thinking.type !== "enabled" && opts.thinking.type !== "disabled") {
      throw new Error(`MODEL_THINKING_POLICY_INVALID: ${String(opts.thinking.type)}`);
    }
    if (opts.thinking.type === "enabled") {
      const effort = opts.reasoningEffort ?? "high";
      if (!["low", "high", "max"].includes(effort)) {
        throw new Error(`MODEL_THINKING_POLICY_INVALID: ${effort}`);
      }
      thinking = { type: "enabled", effort };
    } else {
      thinking = { type: "disabled" };
    }
  }
  return resolveTextScenePolicy(opts.scene ?? "generic", {
    ...(responseFormat ? { responseFormat } : {}),
    ...(thinking ? { thinking } : {}),
  });
}

/**
 * Canonical DeepSeek transport. The complete serialized request is tokenized
 * before dispatch and the output ceiling is the maximum legal remainder.
 */
export class OpenAiCompatibleProvider implements ModelProvider {
  readonly modelId: typeof DEEPSEEK_FLASH_MODEL_ID;
  private readonly baseUrl: string;

  constructor(
    modelId: string,
    private readonly cfg: { baseUrl: string; apiKey?: string; fetchImpl?: typeof fetch },
  ) {
    this.modelId = canonicalDeepSeekModel(modelId);
    this.baseUrl = normalizeBaseUrl(cfg.baseUrl);
    if (!/^https?:\/\//i.test(this.baseUrl)) throw new Error("MODEL_ENDPOINT_INVALID");
  }

  private authHeaders(): Record<string, string> {
    return this.cfg.apiKey ? { authorization: `Bearer ${this.cfg.apiKey}` } : {};
  }

  private static async failureDetail(response: Response): Promise<string> {
    const raw = await response.text().catch(() => "");
    let detail = raw.trim();
    try {
      const value = JSON.parse(raw) as { error?: { message?: unknown; code?: unknown } };
      detail = [value.error?.code, value.error?.message]
        .filter(item => typeof item === "string" && item.trim())
        .join(": ");
    } catch {
      /* Non-JSON provider errors retain bounded text. */
    }
    return detail
      .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer <redacted>")
      .replace(/\bsk-[A-Za-z0-9_-]{8,}\b/g, "<redacted>")
      .slice(0, 500);
  }

  async healthy(): Promise<boolean> {
    const fetchImpl = this.cfg.fetchImpl ?? fetch;
    try {
      const response = await fetchImpl(`${this.baseUrl}/models`, {
        headers: this.authHeaders(),
        signal: AbortSignal.timeout(5_000),
      });
      return response.ok || response.status === 404;
    } catch {
      return false;
    }
  }

  async chat(messages: ChatMessage[], opts: ChatOptions = {}): Promise<ChatResult> {
    if (messages.length === 0) throw new ModelProviderError("模型任务至少需要一条消息", "protocol");
    const masked = messages.map((message) => ({
      ...message,
      content: sanitizeContent(message.content),
    }));
    const policy = policyForOptions(opts);
    const mode = policy.thinking.type;
    const effort = mode === "enabled" ? policy.thinking.effort ?? "high" : undefined;
    const responseFormat = policy.responseFormat === "json_object" ? { type: "json_object" } : undefined;
    const plan = await planDeepSeekWindow({
      messages: masked as BudgetMessage[],
      responseFormat,
      productOutputCap: opts.productOutputCap,
    });
    const thinkingEnabled = mode === "enabled";
    const topP = thinkingEnabled && opts.topP !== undefined
      ? Math.min(1, Math.max(0.95, opts.topP))
      : opts.topP;
    const requestBody: Record<string, unknown> = {
      model: this.modelId,
      messages: masked,
      max_tokens: plan.outputCeiling,
      response_format: responseFormat,
      thinking: thinkingEnabled
        ? { type: "enabled" }
        : { type: "disabled" },
      ...(thinkingEnabled
        ? {
            reasoning_effort: effort,
            ...(topP === undefined ? {} : { top_p: topP }),
          }
        : {
            temperature: opts.temperature ?? policy.temperature ?? 0.2,
            ...(topP === undefined ? {} : { top_p: topP }),
          }),
    };
    const body = JSON.stringify(requestBody);
    const requestHash = createHash("sha256").update(body).digest("hex");
    const timeoutMs = opts.timeoutMs && opts.timeoutMs > 0 ? opts.timeoutMs : 180_000;
    const maxRetries = Number.isSafeInteger(opts.retries) && Number(opts.retries) >= 0
      ? Number(opts.retries)
      : 0;
    const attempts: ChatResult["attempts"] = [];

    for (let attempt = 1; attempt <= maxRetries + 1; attempt += 1) {
      const timeoutSignal = AbortSignal.timeout(timeoutMs);
      const signal = opts.signal
        ? AbortSignal.any([opts.signal, timeoutSignal])
        : timeoutSignal;
      let response: Response;
      try {
        response = await (this.cfg.fetchImpl ?? fetch)(`${this.baseUrl}/chat/completions`, {
          method: "POST",
          redirect: "error",
          headers: { "content-type": "application/json", accept: "application/json", ...this.authHeaders() },
          body,
          signal,
        });
      } catch (error) {
        if (opts.signal?.aborted) {
          throw new ModelProviderError("模型调用已取消（调用方 abort）", "cancelled", {
            retryable: false,
            cause: error,
          });
        }
        if (timeoutSignal.aborted) {
          throw new ModelProviderError(`模型调用超时（>${Math.round(timeoutMs / 1000)}s）`, "timeout", {
            retryable: false,
            unknown: true,
            cause: error,
          });
        }
        throw new ModelProviderError("模型网络结果未知", "network", {
          retryable: false,
          unknown: true,
          cause: error,
        });
      }

      if (!response.ok) {
        const detail = await OpenAiCompatibleProvider.failureDetail(response);
        const retryable = response.status === 429;
        const error = new ModelProviderError(
          `模型调用失败：HTTP ${response.status}${detail ? `（${detail}）` : ""}`,
          "http",
          {
            status: response.status,
            retryable,
            unknown: response.status >= 500,
          },
        );
        attempts.push({
          attempt,
          code: error.kind,
          httpStatus: response.status,
          unknown: error.unknown,
          retryable,
        });
        if (retryable && attempt <= maxRetries) {
          await new Promise((resolve) => setTimeout(resolve, 250));
          continue;
        }
        Object.assign(error.options, { receipt: { attempts } });
        throw error;
      }

      let rawBody: string;
      try {
        rawBody = await response.text();
      } catch (error) {
        if (opts.signal?.aborted) {
          throw new ModelProviderError("模型调用已取消（调用方 abort）", "cancelled", {
            retryable: false,
            cause: error,
          });
        }
        if (timeoutSignal.aborted) {
          throw new ModelProviderError(`模型调用超时（>${Math.round(timeoutMs / 1000)}s）`, "timeout", {
            retryable: false,
            unknown: true,
            cause: error,
          });
        }
        throw new ModelProviderError("模型响应读取失败", "network", {
          retryable: false,
          unknown: true,
          cause: error,
        });
      }
      const responseHash = createHash("sha256").update(rawBody).digest("hex");
      let data: OpenAiResponse;
      try {
        data = JSON.parse(rawBody) as OpenAiResponse;
      } catch (error) {
        throw new ModelProviderError("模型响应不是合法 JSON", "protocol", {
          retryable: false,
          cause: error,
        });
      }
      if (data.model !== this.modelId) {
        throw new ModelProviderError(
          `模型响应身份 ${data.model ?? "<missing>"} 与请求 ${this.modelId} 不一致`,
          "protocol",
          { retryable: false },
        );
      }
      if (data.choices?.length !== 1) {
        throw new ModelProviderError("模型响应必须包含唯一 choice", "protocol", { retryable: false });
      }
      const choice = data.choices[0]!;
      if (choice.finish_reason !== "stop") {
        throw new ModelProviderError(
          `模型未完整结束：${choice.finish_reason ?? "missing"}`,
          "protocol",
          { retryable: false },
        );
      }
      if (!thinkingEnabled && String(choice.message?.reasoning_content ?? "").trim()) {
        throw new ModelProviderError("非思考场景返回了 reasoning_content", "protocol", {
          retryable: false,
          unknown: true,
        });
      }
      const text = textFromContent(choice.message?.content);
      if (!text) throw new ModelProviderError("模型返回 content 为空", "empty", { retryable: false });

      const promptTokens = data.usage?.prompt_tokens;
      const completionTokens = data.usage?.completion_tokens;
      const totalTokens = data.usage?.total_tokens;
      const reasoningTokens = data.usage?.completion_tokens_details?.reasoning_tokens;
      if (!safeInteger(promptTokens)
        || !safeInteger(completionTokens)
        || !safeInteger(totalTokens)
        || totalTokens !== promptTokens + completionTokens) {
        throw new ModelProviderError("模型 usage 缺失或无效", "protocol", { retryable: false });
      }
      if (reasoningTokens !== undefined
        && (!safeInteger(reasoningTokens) || reasoningTokens > completionTokens)) {
        throw new ModelProviderError("模型 reasoning_tokens 无效", "protocol", { retryable: false });
      }
      if (!thinkingEnabled && reasoningTokens !== undefined && reasoningTokens !== 0) {
        throw new ModelProviderError("非思考场景返回了 reasoning tokens", "protocol", {
          retryable: false,
          unknown: true,
        });
      }
      if (completionTokens > plan.outputCeiling || totalTokens > DEEPSEEK_FLASH_CONTEXT_TOKENS) {
        throw new ModelProviderError("模型 usage 超过本次预算", "protocol", {
          retryable: false,
          unknown: true,
        });
      }

      return {
        text,
        promptTokens,
        completionTokens,
        modelId: data.model,
        finishReason: "stop",
        reasoningTokens: reasoningTokens ?? 0,
        requestHash,
        responseHash,
        responseId: data.id ?? null,
        scene: opts.scene ?? "generic",
        mode,
        effort,
        outputCeiling: plan.outputCeiling,
        inputTokenEstimate: plan.inputTokens,
        imageCount: plan.imageCount,
        policyVersion: TEXT_PRIMARY_POLICY_VERSION,
        registryVersion: TEXT_PRIMARY_REGISTRY_VERSION,
        attempts,
      };
    }
    throw new ModelProviderError("模型调用重试耗尽", "http", { retryable: false, receipt: { attempts } });
  }
}

export function providerFromEnv(modelId: string = DEEPSEEK_FLASH_MODEL_ID): ModelProvider {
  const provider = (process.env.LLM_PROVIDER ?? "mock").trim().toLowerCase();
  if (provider === "mock") return new MockProvider(canonicalDeepSeekModel(modelId));
  if (provider !== "deepseek") {
    throw new Error(`LLM_PROVIDER=${provider} 不在 text.primary registry 中`);
  }
  const baseUrl = normalizeBaseUrl(
    process.env.LLM_BASE_URL
      ?? process.env.DEEPSEEK_BASE_URL
      ?? "https://api.deepseek.com",
  );
  const apiKey = process.env.LLM_API_KEY || process.env.DEEPSEEK_API_KEY;
  if (!apiKey) throw new Error("DEEPSEEK_API_KEY_MISSING");
  return new OpenAiCompatibleProvider(canonicalDeepSeekModel(modelId), {
    baseUrl,
    apiKey,
  });
}
