/**
 * Typed decision questions implemented on WorkLoom text.primary.
 *
 * The former TypeSafe/Vercel evaluation channels are retired here. They were
 * separate review models and violated the generation/review same-model rule.
 * This adapter converts the typed question set into a strict JSON task for
 * `deepseek-flash`, then applies the existing deterministic answer validator.
 */
import {
  DEEPSEEK_FLASH_MODEL_ID,
  DEEPSEEK_FLASH_CONTEXT_TOKENS,
  DEEPSEEK_FLASH_MAX_OUTPUT_TOKENS,
  ModelProviderError,
  OpenAiCompatibleProvider,
  canonicalDeepSeekModel,
} from "@workloom/base/model-router";
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
  /** Kept as a report key for compatibility; only deepseek is accepted. */
  provider?: JevProvider;
  baseUrl?: string;
  model?: string;
  timeoutMs?: number;
  /** 429 retries stay on the same model and mode. */
  maxAttempts?: number;
  fetchImpl?: typeof fetch;
}

export const DEFAULT_BASE_URL = "https://api.deepseek.com";
export const DEFAULT_MODEL = DEEPSEEK_FLASH_MODEL_ID;

/** Legacy exports used by mock tooling and report serializers. */
export const TYPESAFE_BASE_URL = DEFAULT_BASE_URL;
export const TYPESAFE_MODEL = DEEPSEEK_FLASH_MODEL_ID;
export const GATEWAY_BASE_URL = DEFAULT_BASE_URL;
export const GATEWAY_MODEL = DEEPSEEK_FLASH_MODEL_ID;
export const GATEWAY_PROTOCOL_VERSION = "retired";
export const EVALUATION_SPEC_VERSION = "workloom.model-policy/v1";

const RETRY_STATUS = new Set([429, 500, 502, 503, 529]);

export function defaultBaseUrl(_provider: JevProvider = "deepseek"): string {
  return DEFAULT_BASE_URL;
}

export function defaultModel(_provider: JevProvider = "deepseek"): string {
  return DEEPSEEK_FLASH_MODEL_ID;
}

function questionInstruction(questions: JevQuestionSet): string {
  const examples: Record<string, unknown> = {};
  for (const [id, question] of Object.entries(questions)) {
    if (question.type === "boolean") {
      examples[id] = {
        type: "boolean",
        probability: 0.5,
        confidence: 0.5,
      };
    } else if (question.type === "choice") {
      examples[id] = {
        type: "choice",
        choice: Object.keys(question.criteria)[0],
        probabilities: Object.fromEntries(
          Object.keys(question.criteria).map((key) => [key, 1 / Object.keys(question.criteria).length]),
        ),
        confidence: 0.5,
      };
    } else {
      const count = question.criteria.length;
      examples[id] = {
        type: "score",
        score: 0,
        probabilities: Object.fromEntries(
          Array.from({ length: count }, (_, index) => [String(index), 1 / count]),
        ),
        confidence: 0.5,
      };
    }
  }
  return JSON.stringify(examples, null, 2);
}

function buildPrompt(request: JevRequest): string {
  return [
    "You are WorkLoom's typed decision reviewer. Evaluate the state against every question.",
    "Use evidence in the state only. Do not invent facts. Probabilities must be finite 0..1 values and each probability map must sum to 1.",
    "Return one strict JSON object only. Top-level key `answers` maps question id to the required answer object.",
    "Boolean answers require `probability`; choice answers require `choice` and `probabilities`; score answers require `score` and `probabilities`.",
    "Every answer must include a self-reported `confidence` in 0..1.",
    "",
    `WORKLOOM_JEV_REQUEST=${JSON.stringify(request)}`,
    "",
    "State (complete JSON):",
    JSON.stringify(request.state),
    "",
    "Questions (complete JSON):",
    JSON.stringify(request.questions, null, 2),
    "",
    "Required answer shape example:",
    JSON.stringify({ answers: JSON.parse(questionInstruction(request.questions)) }, null, 2),
  ].join("\n");
}

export class JevClient {
  private readonly provider: JevProvider = "deepseek";
  private readonly baseUrl: string;
  private readonly model: string;
  private readonly providerClient: OpenAiCompatibleProvider;
  private readonly timeoutMs: number;
  private readonly maxAttempts: number;

  constructor(options: JevClientOptions = {}) {
    if (options.provider && options.provider !== "deepseek") {
      throw new JevError("bad_request", `未知 JEV_PROVIDER：${options.provider}（只接受 deepseek）`);
    }
    this.baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
    this.model = canonicalDeepSeekModel(options.model);
    this.timeoutMs = options.timeoutMs ?? 600_000;
    this.maxAttempts = Math.max(1, options.maxAttempts ?? 2);
    if (!options.apiKey && !this.baseUrl.includes("127.0.0.1") && !this.baseUrl.includes("localhost")) {
      throw new JevError("missing_key", "缺少 DEEPSEEK_API_KEY / LLM_API_KEY");
    }
    this.providerClient = new OpenAiCompatibleProvider(this.model, {
      baseUrl: this.baseUrl,
      apiKey: options.apiKey,
      fetchImpl: options.fetchImpl,
    });
  }

  get modelId(): string {
    return this.model;
  }

  get providerId(): JevProvider {
    return this.provider;
  }

  get providerLabel(): string {
    return "DeepSeek text.primary";
  }

  get host(): string {
    try {
      return new URL(this.baseUrl).host;
    } catch {
      return this.baseUrl;
    }
  }

  async evaluate(request: JevRequest, signal?: AbortSignal): Promise<JevCallResult> {
    const started = Date.now();
    try {
      const result = await this.providerClient.chat(
        [{ role: "user", content: buildPrompt(request) }],
        {
          scene: "video.jev.evaluate",
          timeoutMs: this.timeoutMs,
          signal,
          retries: Math.max(0, this.maxAttempts - 1),
        },
      );
      let parsed: unknown;
      try {
        parsed = JSON.parse(result.text.trim());
      } catch {
        throw new JevError("invalid_response", "决策模型返回非 JSON 响应");
      }
      return parseAnswers(
        {
          model: result.modelId,
          answers: (parsed as Record<string, unknown>)?.answers,
          usage: {
            prompt_tokens: result.promptTokens,
            completion_tokens: result.completionTokens,
            total_tokens: result.promptTokens + result.completionTokens,
          },
        },
        request.questions,
        result.modelId,
        Date.now() - started,
      );
    } catch (error) {
      if (error instanceof JevError) throw error;
      if (error instanceof JevResponseError) {
        throw new JevError("invalid_response", `回答非法：${error.message}`);
      }
      if (error instanceof ModelProviderError) {
        const code: JevErrorCode = error.kind === "cancelled" || error.kind === "timeout"
          ? "timeout"
          : error.kind === "http"
            ? error.options.status === 429
              ? "rate_limited"
              : error.options.status === 401 || error.options.status === 403
                ? "auth"
                : "server"
            : error.kind === "network" || error.kind === "unknown"
              ? "network"
              : "invalid_response";
        throw new JevError(code, error.message, {
          status: error.options.status,
          retryable: error.retryable,
        });
      }
      throw new JevError("network", `决策模型不可用：${error instanceof Error ? error.message : String(error)}`, {
        retryable: false,
      });
    }
  }
}

export function resolveProvider(env: NodeJS.ProcessEnv = process.env): JevProvider {
  const explicit = env.JEV_PROVIDER?.trim().toLowerCase();
  if (explicit && explicit !== "deepseek") {
    throw new Error(`未知 JEV_PROVIDER：${explicit}（只接受 deepseek）`);
  }
  return "deepseek";
}

export function apiKeyFromEnv(env: NodeJS.ProcessEnv, _provider: JevProvider = "deepseek"): string | undefined {
  return env.DEEPSEEK_API_KEY?.trim() || env.LLM_API_KEY?.trim() || undefined;
}

export function clientFromEnv(
  env: NodeJS.ProcessEnv = process.env,
  overrides: Partial<JevClientOptions> = {},
): JevClient {
  return new JevClient({
    provider: resolveProvider(env),
    apiKey: apiKeyFromEnv(env),
    baseUrl: env.LLM_BASE_URL ?? env.DEEPSEEK_BASE_URL ?? DEFAULT_BASE_URL,
    model: env.LLM_MODEL ?? env.DEEPSEEK_MODEL ?? DEFAULT_MODEL,
    timeoutMs: env.JEV_TIMEOUT_MS ? Number(env.JEV_TIMEOUT_MS) : undefined,
    ...overrides,
  });
}

export const JEV_CONTEXT_FACTS = Object.freeze({
  model: DEEPSEEK_FLASH_MODEL_ID,
  contextTokens: DEEPSEEK_FLASH_CONTEXT_TOKENS,
  maxOutputTokens: DEEPSEEK_FLASH_MAX_OUTPUT_TOKENS,
});
