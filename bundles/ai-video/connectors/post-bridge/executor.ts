/**
 * ai-video × 后期交付与返修工位 bridge 连接器 v1.0
 *
 * 结构兼容 `packages/runtime/src/tools.ts` 的 ToolExecutor seam（不直接 import 运行时内部，
 * 避免行业包反向依赖；部署时把返回值注入宿主的 toolExecutor 即可）。
 *
 * 与 subtitle / color / bgm 三个 bridge 同款纪律：
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

export interface PostBridgeOptions {
  /** 一个或多个后期工位端点，如 http://127.0.0.1:9777 或 ["http://a:9777","http://b:9777"] */
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
  onRetry?: (endpoint: string, error: PostBridgeError) => void;
}

export class PostBridgeError extends Error {
  readonly code: string;
  readonly retryable: boolean;

  constructor(message: string, code: string, retryable = false) {
    super(message);
    this.name = "PostBridgeError";
    this.code = code;
    this.retryable = retryable;
  }
}

/**
 * 后期交付与返修工位声明的工具面；不在表内的工具直接拒绝。
 * 读：health（工位体检）/ plan（交付计划）/ impact（变更影响分析）
 * 写：package（出交付包）/ reedit（本地重合成）/ triage（反馈分诊）
 */
export const POST_BRIDGE_TOOLS = [
  "postread.health",
  "postread.plan",
  "postread.impact",
  "postwrite.package",
  "postwrite.reedit",
  "postwrite.triage",
] as const;

const TOOL_SET: ReadonlySet<string> = new Set(POST_BRIDGE_TOOLS);

export const RETRYABLE_CODES = new Set([
  "network_error", "timeout", "ffmpeg_failed", "decode_failed", "engine_failed", "bad_response",
]);

export const NEVER_RETRY_CODES = new Set([
  "quota_exceeded", "disk_quota_exceeded", "path_not_allowed", "tenant_mismatch",
  "idempotency_conflict", "bad_request", "not_found", "not_provided",
  "ffmpeg_not_installed", "bad_media", "bad_font", "font_not_found", "bad_style", "bad_srt",
  "bad_recipe", "bad_lut", "license_blocked", "overwrite_source_forbidden", "not_configured",
  "verify_failed", "version_exists",
  "revision_conflict", "revision_busy", "revision_io_failed",
]);

export function isPostBridgeTool(name: string): boolean {
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

export function createPostBridgeExecutor(options: PostBridgeOptions): ToolExecutor {
  const fetchImpl = options.fetchImpl ?? fetch;
  const endpoints = (Array.isArray(options.baseUrl) ? options.baseUrl : [options.baseUrl])
    .map((endpoint) => endpoint.replace(/\/+$/, ""))
    .filter(Boolean);
  if (endpoints.length === 0) throw new PostBridgeError("后期工位未配置端点", "not_configured", false);
  // 一次交付要跑「归一化 → 多轮拼接 → 调色 → 混音 → 封面 → 软字幕轨」，比单字幕渲染更慢。
  const timeoutMs = options.timeoutMs ?? 3_600_000;
  const softFailures = options.softFailures !== false;
  const autoIdempotency = options.autoIdempotency !== false;
  const idempotencyPrefix = options.idempotencyPrefix ?? "post";
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
        throw new PostBridgeError("后期工位返回非 JSON 响应", "bad_response", true);
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
        const message = typeof body.message === "string" ? body.message : `后期工位 HTTP ${response.status}`;
        const code = typeof body.error === "string" ? body.error : "bridge_error";
        const retryable = typeof body.retryable === "boolean"
          ? body.retryable && !NEVER_RETRY_CODES.has(code)
          : response.status >= 500 && !NEVER_RETRY_CODES.has(code);
        throw new PostBridgeError(message, code, retryable);
      }
      const receipt = body.receipt ?? {};
      if (!body.result || typeof body.result !== "object" || Array.isArray(body.result)) {
        throw new PostBridgeError("后期工位成功响应缺少有效 result 对象", "bad_response", true);
      }
      return {
        result: {
          ...body.result,
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
      if (error instanceof PostBridgeError) throw error;
      if (error instanceof Error && error.name === "AbortError") {
        throw new PostBridgeError("后期工位请求超时", "timeout", true);
      }
      throw new PostBridgeError(error instanceof Error ? error.message : String(error), "network_error", true);
    } finally {
      clearTimeout(timer);
    }
  }

  return async (name, params) => {
    if (!TOOL_SET.has(name)) {
      if (softFailures) {
        return {
          result: { error: "not_provided", message: `后期工位不提供工具 ${name}` },
          receipt: { synced: false },
        };
      }
      throw new PostBridgeError(`后期工位不提供工具 ${name}`, "not_provided", false);
    }

    const idempotencyKey = autoIdempotency
      ? `${idempotencyPrefix}-${hashKey(`${name}|${stableKey(params)}`)}`
      : undefined;

    const attempts: Array<{ endpoint: string; code: string; message: string; retryable: boolean }> = [];
    for (let index = 0; index < endpoints.length; index += 1) {
      const endpoint = endpoints[(cursor + index) % endpoints.length]!;
      try {
        const outcome = await callEndpoint(endpoint, name, params, idempotencyKey);
        cursor = (cursor + index + 1) % endpoints.length;
        return outcome;
      } catch (error) {
        const bridgeError = error instanceof PostBridgeError
          ? error
          : new PostBridgeError(String(error), "network_error", true);
        attempts.push({ endpoint, code: bridgeError.code, message: bridgeError.message, retryable: bridgeError.retryable });
        options.onRetry?.(endpoint, bridgeError);
        if (!bridgeError.retryable) break;
      }
    }
    const last = attempts[attempts.length - 1];
    if (!softFailures) {
      throw new PostBridgeError(last?.message ?? "后期工位不可用", last?.code ?? "bridge_error", last?.retryable ?? true);
    }
    return {
      result: {
        error: last?.code ?? "unavailable",
        message: last?.message ?? "后期工位不可用",
        attempts,
        idempotency_key: idempotencyKey,
      },
      receipt: { synced: false },
    };
  };
}
