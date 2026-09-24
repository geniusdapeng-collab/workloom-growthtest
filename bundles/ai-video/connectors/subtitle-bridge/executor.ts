/**
 * ai-video × 字幕工位 bridge 连接器 v1.0
 *
 * 结构兼容 `packages/runtime/src/tools.ts` 的 ToolExecutor seam（不直接 import 运行时内部，
 * 避免行业包反向依赖；部署时把返回值注入宿主的 toolExecutor 即可）。
 *
 * 与 color-bridge / bgm-bridge 同款纪律：
 * - 工具白名单：不在表内的工具直接拒绝（或软失败），不猜测、不透传；
 * - 多端点故障转移 + 租户注入 + 幂等键（tool+params 哈希，重试/切端点不重复出片）；
 * - 软失败：桥不可达/超时/引擎错误 → `receipt.synced=false` 的结构化结果，由 runQuest
 *   按「未核实」处理，不抛异常把线程留在 running；
 * - 不回显 token，不把客户素材路径写进日志（路径只在请求体与回执里）。
 */

export interface ToolReceipt {
  synced: boolean;
  snapshot_uri?: string;
  verified_at?: string;
  sha256?: string;
}

export interface ToolResult {
  result: Record<string, unknown>;
  receipt: ToolReceipt;
}

export type ToolExecutor = (name: string, params: Record<string, unknown>) => Promise<ToolResult>;

export interface SubtitleBridgeOptions {
  /** 一个或多个字幕工位端点，如 http://127.0.0.1:9776 或 ["http://a:9776","http://b:9776"] */
  baseUrl: string | string[];
  /** 工位 token（受控秘密存储或工位本机文件），按租户发放 */
  token: string;
  /** 注入到每次调用的 tenant_id；bridge 会校验 token 与 tenant 一致 */
  tenantId?: string;
  timeoutMs?: number;
  /** 默认 true：任何桥/网络/引擎错误都转成「未核实」回执而不是抛异常 */
  softFailures?: boolean;
  /** 默认 true：自动注入幂等键（相同 tool+params 在 TTL 内命中工位缓存） */
  autoIdempotency?: boolean;
  idempotencyPrefix?: string;
  fetchImpl?: typeof fetch;
  onRetry?: (endpoint: string, error: SubtitleBridgeError) => void;
}

export class SubtitleBridgeError extends Error {
  readonly code: string;
  readonly retryable: boolean;

  constructor(message: string, code: string, retryable = false) {
    super(message);
    this.name = "SubtitleBridgeError";
    this.code = code;
    this.retryable = retryable;
  }
}

/** 字幕工位声明的工具面；不在表内的工具直接拒绝。 */
export const SUBTITLE_BRIDGE_TOOLS = [
  "subtitleread.health",
  "subtitleread.probe",
  "subtitleread.analyze",
  "subtitleread.fonts",
  "subtitleread.recipes",
  "subtitlewrite.plan",
  "subtitlewrite.burn",
  "subtitlewrite.title",
  "subtitlewrite.danmaku",
  "subtitlewrite.sticker",
  "subtitlewrite.karaoke",
  "subtitlewrite.sidecar",
  "subtitlewrite.softmux",
  "subtitlewrite.best",
] as const;

const TOOL_SET: ReadonlySet<string> = new Set(SUBTITLE_BRIDGE_TOOLS);

export const RETRYABLE_CODES = new Set([
  "network_error", "timeout", "ffmpeg_failed", "decode_failed", "engine_failed", "bad_response",
]);

export const NEVER_RETRY_CODES = new Set([
  "quota_exceeded", "disk_quota_exceeded", "path_not_allowed", "tenant_mismatch",
  "idempotency_conflict", "bad_request", "not_found", "not_provided",
  "ffmpeg_not_installed", "bad_media", "bad_font", "font_not_found", "bad_style", "bad_srt",
  "bad_recipe", "license_blocked", "overwrite_source_forbidden", "not_configured", "verify_failed",
]);

export function isSubtitleBridgeTool(name: string): boolean {
  return TOOL_SET.has(name);
}

/** 稳定序列化（参数键排序）用于幂等键与请求哈希。 */
export function stableKey(value: unknown): string {
  return JSON.stringify(sortValue(value));
}

function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortValue);
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return Object.keys(record).sort().reduce((acc, key) => {
      acc[key] = sortValue(record[key]);
      return acc;
    }, {} as Record<string, unknown>);
  }
  return value;
}

/** 轻量 64-bit 哈希（FNV-1a），只用于幂等键，不用于安全。 */
export function hashKey(text: string): string {
  let hash = 0xcbf29ce484222325n;
  const prime = 0x100000001b3n;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= BigInt(text.charCodeAt(index));
    hash = (hash * prime) & 0xffffffffffffffffn;
  }
  return hash.toString(16).padStart(16, "0");
}

export function createSubtitleBridgeExecutor(options: SubtitleBridgeOptions): ToolExecutor {
  const fetchImpl = options.fetchImpl ?? fetch;
  const endpoints = (Array.isArray(options.baseUrl) ? options.baseUrl : [options.baseUrl])
    .map((endpoint) => endpoint.replace(/\/+$/, ""))
    .filter(Boolean);
  if (endpoints.length === 0) throw new SubtitleBridgeError("字幕工位未配置端点", "not_configured", false);
  const timeoutMs = options.timeoutMs ?? 900_000; // 字幕含抽帧诊断 + 多遍 ffmpeg 烧录，默认给 15 分钟
  const softFailures = options.softFailures !== false;
  const autoIdempotency = options.autoIdempotency !== false;
  const idempotencyPrefix = options.idempotencyPrefix ?? "subtitle";
  let cursor = 0;

  async function callEndpoint(
    endpoint: string,
    name: string,
    params: Record<string, unknown>,
    idempotencyKey: string | undefined,
  ): Promise<ToolResult> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetchImpl(`${endpoint}/action`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${options.token}`,
        },
        body: JSON.stringify({
          tool: name,
          params: {
            ...params,
            ...(options.tenantId ? { tenant_id: options.tenantId } : {}),
            ...(idempotencyKey ? { idempotency_key: idempotencyKey } : {}),
          },
        }),
        signal: controller.signal,
      });
      const text = await response.text();
      let payload: unknown;
      try {
        payload = JSON.parse(text);
      } catch {
        throw new SubtitleBridgeError("字幕工位返回非 JSON 响应", "bad_response", true);
      }
      const body = payload as {
        ok?: boolean;
        error?: unknown;
        message?: unknown;
        retryable?: unknown;
        result?: unknown;
        receipt?: { synced?: unknown; snapshot_uri?: unknown; verified_at?: unknown; sha256?: unknown };
        job_id?: unknown;
      };
      if (!response.ok || body.ok !== true) {
        const message = typeof body.message === "string" ? body.message : `字幕工位 HTTP ${response.status}`;
        const code = typeof body.error === "string" ? body.error : "bridge_error";
        // 工位会在错误体里显式声明 retryable（见 server.mjs）；以它为准，缺省才退回 HTTP 状态启发式。
        // 工具级可重试错误（ffmpeg_failed / timeout）走 HTTP 200 + ok:false，只看状态码会误判成不可重试。
        const retryable = typeof body.retryable === "boolean"
          ? body.retryable && !NEVER_RETRY_CODES.has(code)
          : response.status >= 500 && !NEVER_RETRY_CODES.has(code);
        throw new SubtitleBridgeError(message, code, retryable);
      }
      const receipt = body.receipt ?? {};
      return {
        result: {
          ...(body.result ?? {}),
          ...(typeof body.job_id === "string" ? { job_id: body.job_id } : {}),
        } as Record<string, unknown>,
        receipt: {
          synced: receipt.synced === true,
          ...(typeof receipt.snapshot_uri === "string" ? { snapshot_uri: receipt.snapshot_uri } : {}),
          ...(typeof receipt.verified_at === "string" ? { verified_at: receipt.verified_at } : {}),
          ...(typeof receipt.sha256 === "string" ? { sha256: receipt.sha256 } : {}),
        },
      };
    } catch (error) {
      if (error instanceof SubtitleBridgeError) throw error;
      if (error instanceof Error && error.name === "AbortError") {
        throw new SubtitleBridgeError("字幕工位请求超时", "timeout", true);
      }
      throw new SubtitleBridgeError(error instanceof Error ? error.message : String(error), "network_error", true);
    } finally {
      clearTimeout(timer);
    }
  }

  return async (name, params) => {
    if (!TOOL_SET.has(name)) {
      if (softFailures) {
        return {
          result: { error: "not_provided", message: `字幕工位不提供工具 ${name}` },
          receipt: { synced: false },
        };
      }
      throw new SubtitleBridgeError(`字幕工位不提供工具 ${name}`, "not_provided", false);
    }

    const idempotencyKey = autoIdempotency
      ? `${idempotencyPrefix}-${hashKey(`${name}|${stableKey(params)}`)}`
      : undefined;

    const attempts: Array<{ endpoint: string; code: string; message: string }> = [];
    for (let index = 0; index < endpoints.length; index += 1) {
      const endpoint = endpoints[(cursor + index) % endpoints.length]!;
      try {
        const outcome = await callEndpoint(endpoint, name, params, idempotencyKey);
        cursor = (cursor + index + 1) % endpoints.length;
        return outcome;
      } catch (error) {
        const bridgeError = error instanceof SubtitleBridgeError
          ? error
          : new SubtitleBridgeError(String(error), "network_error", true);
        attempts.push({ endpoint, code: bridgeError.code, message: bridgeError.message });
        options.onRetry?.(endpoint, bridgeError);
        if (!bridgeError.retryable) break;
      }
    }
    const last = attempts[attempts.length - 1];
    if (!softFailures) {
      throw new SubtitleBridgeError(last?.message ?? "字幕工位不可用", last?.code ?? "bridge_error", true);
    }
    return {
      result: {
        error: last?.code ?? "unavailable",
        message: last?.message ?? "字幕工位不可用",
        attempts,
        idempotency_key: idempotencyKey,
      },
      receipt: { synced: false },
    };
  };
}
