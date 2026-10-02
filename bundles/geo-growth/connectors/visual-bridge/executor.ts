/**
 * geo-growth × 视觉工位 bridge 连接器 v0.2（生产加固）。
 *
 * 结构兼容 `packages/runtime/src/tools.ts` 的 ToolExecutor seam（不直接 import，
 * 避免行业包反向依赖运行时内部；部署时把返回值注入宿主的 toolExecutor 即可）。
 *
 * v0.2 变更：
 * - 多端点故障转移（多台 Mac 工位 / 反代后多实例）；
 * - 租户作用域：自动注入 `tenant_id`，由 bridge 按 token 校验，跨租户调用会被拒；
 * - 幂等：自动按键（tool+params 哈希）注入 `idempotency_key`，失败重试/端点切换不重复出图；
 * - 软失败：桥不可达/超时/引擎错误 → 返回 `receipt.synced=false` 的结构化结果，
 *   由 runQuest 按「未核实」处理（避免异常冒泡把线程留在 running）；
 * - 纪律：不回显 token，不把客户素材写进日志。
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

export interface VisualBridgeOptions {
  /** 一个或多个工位端点，如 http://10.0.0.12:9773 或 ["http://a:9773","http://b:9773"] */
  baseUrl: string | string[];
  /** 工位 token（受控秘密存储或工位本机文件），按租户发放 */
  token: string;
  /** 注入到每次调用的 tenant_id；bridge 会校验 token 与 tenant 一致 */
  tenantId?: string;
  timeoutMs?: number;
  /** 默认 true：任何桥/网络/引擎错误都转成「未核实」回执而不是抛异常 */
  softFailures?: boolean;
  /** 默认 true：自动注入幂等键（相同 tool+params 在 TTL 内命中缓存） */
  autoIdempotency?: boolean;
  /** 幂等键前缀，建议含环境名，如 "prod-visual" */
  idempotencyPrefix?: string;
  fetchImpl?: typeof fetch;
  /** 仅供测试/日志用，不参与请求 */
  onRetry?: (endpoint: string, error: VisualBridgeError) => void;
}

export class VisualBridgeError extends Error {
  readonly code: string;
  readonly retryable: boolean;

  constructor(message: string, code: string, retryable = false) {
    super(message);
    this.name = "VisualBridgeError";
    this.code = code;
    this.retryable = retryable;
  }
}

/** 视觉工位声明的工具面；不在表内的工具直接拒绝。 */
export const VISUAL_BRIDGE_TOOLS = [
  "visualread.health",
  "visualread.stats",
  "visualread.assets",
  "visualread.inspect",
  "visualread.verify",
  "visualread.snapshot",
  "visualread.critique",
  "visualwrite.compose",
  "visualwrite.render",
  "visualwrite.text",
  "visualwrite.fetch_stock",
  "visualwrite.generate",
] as const;

const TOOL_SET: ReadonlySet<string> = new Set(VISUAL_BRIDGE_TOOLS);

const RETRYABLE_CODES = new Set(["network_error", "timeout", "engine_missing", "bridge_error", "engine_failed", "bad_response"]);
const NEVER_RETRY_CODES = new Set([
  "quota_exceeded", "disk_quota_exceeded", "path_not_allowed", "tenant_mismatch",
  "idempotency_conflict", "bad_request", "not_found", "bad_image", "compositor_not_installed",
  "screen_recording_permission_required", "not_provided",
  "vision_not_configured", "vision_key_missing", "vision_bad_response", "vision_http_error",
  "stock_host_not_allowed", "stock_url_invalid", "stock_too_large",
  "image_gen_not_configured", "image_gen_key_missing", "image_gen_empty",
]);

export function isVisualBridgeTool(name: string): boolean {
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

export function createVisualBridgeExecutor(options: VisualBridgeOptions): ToolExecutor {
  const fetchImpl = options.fetchImpl ?? fetch;
  const endpoints = (Array.isArray(options.baseUrl) ? options.baseUrl : [options.baseUrl])
    .map((endpoint) => endpoint.replace(/\/+$/, ""))
    .filter(Boolean);
  if (endpoints.length === 0) throw new VisualBridgeError("视觉工位未配置端点", "not_configured", false);
  const timeoutMs = options.timeoutMs ?? 300_000;
  const softFailures = options.softFailures !== false;
  const autoIdempotency = options.autoIdempotency !== false;
  const idempotencyPrefix = options.idempotencyPrefix ?? "visual";
  let cursor = 0;

  async function callEndpoint(endpoint: string, name: string, params: Record<string, unknown>,
                              idempotencyKey: string | undefined): Promise<ToolResult> {
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
        throw new VisualBridgeError("视觉工位返回非 JSON 响应", "bad_response", true);
      }
      const body = payload as {
        ok?: boolean;
        error?: unknown;
        message?: unknown;
        result?: unknown;
        receipt?: { synced?: unknown; snapshot_uri?: unknown; verified_at?: unknown; sha256?: unknown };
      };
      if (!response.ok || body.ok !== true) {
        const message = typeof body.message === "string" ? body.message : `视觉工位 HTTP ${response.status}`;
        const code = typeof body.error === "string" ? body.error : "bridge_error";
        const retryable = response.status >= 500 && !NEVER_RETRY_CODES.has(code);
        throw new VisualBridgeError(message, code, retryable);
      }
      const receipt = body.receipt ?? {};
      return {
        result: (body.result ?? {}) as Record<string, unknown>,
        receipt: {
          synced: receipt.synced === true,
          ...(typeof receipt.snapshot_uri === "string" ? { snapshot_uri: receipt.snapshot_uri } : {}),
          ...(typeof receipt.verified_at === "string" ? { verified_at: receipt.verified_at } : {}),
          ...(typeof receipt.sha256 === "string" ? { sha256: receipt.sha256 } : {}),
        },
      };
    } catch (error) {
      if (error instanceof VisualBridgeError) throw error;
      if (error instanceof Error && error.name === "AbortError") {
        throw new VisualBridgeError("视觉工位请求超时", "timeout", true);
      }
      throw new VisualBridgeError(error instanceof Error ? error.message : String(error), "network_error", true);
    } finally {
      clearTimeout(timer);
    }
  }

  return async (name, params) => {
    if (!TOOL_SET.has(name)) {
      if (softFailures) {
        return {
          result: { error: "not_provided", message: `视觉工位不提供工具 ${name}` },
          receipt: { synced: false },
        };
      }
      throw new VisualBridgeError(`视觉工位不提供工具 ${name}`, "not_provided", false);
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
        const bridgeError = error instanceof VisualBridgeError
          ? error
          : new VisualBridgeError(String(error), "network_error", true);
        attempts.push({ endpoint, code: bridgeError.code, message: bridgeError.message });
        options.onRetry?.(endpoint, bridgeError);
        if (!bridgeError.retryable) break;
      }
    }
    const last = attempts[attempts.length - 1];
    if (!softFailures) {
      throw new VisualBridgeError(last?.message ?? "视觉工位不可用", last?.code ?? "bridge_error", true);
    }
    return {
      result: {
        error: last?.code ?? "unavailable",
        message: last?.message ?? "视觉工位不可用",
        attempts,
        idempotency_key: idempotencyKey,
      },
      receipt: { synced: false },
    };
  };
}

export { RETRYABLE_CODES, NEVER_RETRY_CODES };
