/**
 * film-worker-channel.ts —— 影片固定工位与父服务之间的受限通道（T-2026-0927-0039）。
 *
 * 设计口径（任务卡 §本批范围）：
 *   · 工位子进程**不持**供应商密钥与任何签发密钥；所有外呼（LLM/出图/出片/媒介/配音/评审）
 *     都必须经父服务通道，由服务先核对作业冻结输入与阶段范围、先在台账预占，再真正外呼。
 *   · 通道方法有固定白名单；工位不能借通道选择任意代码、环境或路径。
 *   · 请求/响应都是纯 JSON（IPC 序列化），每帧带序号与请求哈希，父服务据此落台账。
 *   · 失败一律以 `{ok:false,error:{code}}` 返回，工位按错误码分类处置，不得把失败吞成通过。
 *
 * 本模块只依赖 Node 内置能力，供 `packages/video-studio` 消费方（服务与脚本）共用：
 * 服务侧用 `filmRequestHash` 复核工位声明的请求身份，脚本侧用 `FilmWorkerChannel` 发起调用。
 */
import { createHash, randomUUID } from "node:crypto";

/** 通道组件分类（与 `film_component_requests.component` 的 CHECK 一致）。 */
export type FilmChannelComponent = "llm" | "image" | "video" | "media" | "voice" | "review";

/** 固定通道方法白名单：方法名 → 组件分类。父服务仍会按登记能力二次核对。 */
export const FILM_CHANNEL_METHOD_COMPONENT: Readonly<Record<string, FilmChannelComponent>> = Object.freeze({
  "llm.chat": "llm",
  "image.generate": "image",
  "media.fetch": "media",
  "video.generate": "video",
  "voice.dub": "voice",
  "voice.verify": "voice",
  "gate.review": "review",
});

export type FilmChannelMethod = keyof typeof FILM_CHANNEL_METHOD_COMPONENT;
export const FILM_CHANNEL_METHODS = Object.freeze(Object.keys(FILM_CHANNEL_METHOD_COMPONENT)) as readonly FilmChannelMethod[];

/** 逐方法缺省超时（毫秒）。出片是异步任务制，给足 20 分钟轮询窗口。 */
export const FILM_CHANNEL_TIMEOUT_MS: Readonly<Record<FilmChannelMethod, number>> = Object.freeze({
  "llm.chat": 180_000,
  "image.generate": 300_000,
  "media.fetch": 300_000,
  "video.generate": 1_200_000,
  "voice.dub": 600_000,
  "voice.verify": 300_000,
  "gate.review": 300_000,
});

/** 单帧大小上限：通道传的是引用与结构化参数，不搬运媒体字节。 */
export const FILM_CHANNEL_FRAME_LIMIT = 512 * 1024;

export interface FilmWorkerJobContext {
  jobId: string;
  tenantId: string;
  workspaceId: string;
  projectId: string;
  attempt: number;
  runId: string;
  workerName: string;
  workerVersion: string;
  /** 服务冻结的阶段清单（工位不得增删）。 */
  stages: string[];
  /** 服务冻结的选项（画幅/清晰度/平台/--only 等）。 */
  options: Record<string, unknown>;
  /** 服务冻结的原稿：工位作业目录内相对引用 + 摘要。 */
  inputRef: string;
  inputSha256: string;
  /** 工位唯一可写目录（服务在档案内创建并校验）。 */
  workDir: string;
  /** 项目档案根（只读引用解析基准；写操作只允许 workDir）。 */
  archiveRoot: string;
  /** 允许的组件方法（登记能力 ∩ 方法白名单，由服务裁剪后下发）。 */
  allowedMethods: FilmChannelMethod[];
  /** 作业总预算（人民币，服务冻结；工位不能改）。 */
  budgetCny: number;
  /** 作业截止（ISO 时间；超时服务会终止工位）。 */
  deadlineAt: string;
}

export interface FilmChannelRequestFrame {
  kind: "film.request";
  id: string;
  method: FilmChannelMethod;
  /** 组件分类，便于父服务在解析参数前先分流。 */
  component: FilmChannelComponent;
  /** 工位声明的步骤键（阶段或阶段:镜号），服务据此核对阶段范围。 */
  stepKey: string;
  /** 出图/出片/配音等逐镜调用必须带镜号；其余为 null。 */
  shotId: string | null;
  /** 幂等键（同一 job 内唯一；同键不同请求必须被服务拒绝）。 */
  idempotencyKey: string;
  /** 请求参数的 canonical JSON 哈希（服务复核，防止"先留账再改参"）。 */
  requestHash: string;
  params: unknown;
}

export interface FilmChannelResponseFrame {
  kind: "film.response";
  id: string;
  ok: boolean;
  /** ok=true 时的业务结果。 */
  result?: unknown;
  /** ok=false 时的错误分类。 */
  error?: { code: string; message: string; details?: unknown };
}

export interface FilmChannelEventFrame {
  kind: "film.event";
  event: string;
  detail?: unknown;
}

export type FilmChannelFrame = FilmChannelRequestFrame | FilmChannelResponseFrame | FilmChannelEventFrame;

export class FilmChannelError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly details?: unknown,
  ) {
    super(`${code}: ${message}`);
    this.name = "FilmChannelError";
  }
}

/** canonical JSON：对象键排序、数组保序；只接受可忠实表达的 JSON 数据。 */
export function filmCanonicalJson(value: unknown): string {
  const active = new Set<object>();
  const canonical = (item: unknown): unknown => {
    if (item === null || typeof item === "string" || typeof item === "boolean") return item;
    if (typeof item === "number" && Number.isFinite(item)) return item;
    if (item === undefined) throw new FilmChannelError("FRAME_INVALID", "通道数据不得包含 undefined");
    if (typeof item !== "object" || !item) throw new FilmChannelError("FRAME_INVALID", "通道数据只接受 JSON 值");
    if (active.has(item)) throw new FilmChannelError("FRAME_INVALID", "通道数据不得包含循环引用");
    active.add(item);
    try {
      if (Array.isArray(item)) return item.map((entry) => canonical(entry));
      const proto = Object.getPrototypeOf(item);
      if (proto !== Object.prototype && proto !== null) throw new FilmChannelError("FRAME_INVALID", "通道数据只接受普通对象");
      const out: Record<string, unknown> = Object.create(null);
      for (const key of Object.keys(item).sort()) {
        const entry = (item as Record<string, unknown>)[key];
        if (entry === undefined) continue;
        out[key] = canonical(entry);
      }
      return out;
    } finally {
      active.delete(item);
    }
  };
  return JSON.stringify(canonical(value));
}

/** 请求身份哈希：工位声明与服务复核使用同一算法。 */
export function filmRequestHash(input: { method: string; stepKey: string; shotId: string | null; params: unknown }): string {
  return createHash("sha256").update(filmCanonicalJson({
    method: input.method, stepKey: input.stepKey, shotId: input.shotId, params: input.params,
  })).digest("hex");
}

/** 帧编码：拒绝超限帧，避免把大对象塞进 IPC。 */
export function encodeFilmChannelFrame(frame: FilmChannelFrame): string {
  const text = JSON.stringify(frame);
  if (Buffer.byteLength(text, "utf8") > FILM_CHANNEL_FRAME_LIMIT) {
    throw new FilmChannelError("FRAME_TOO_LARGE", `通道帧超过 ${FILM_CHANNEL_FRAME_LIMIT} 字节上限`);
  }
  return text;
}

export function decodeFilmChannelFrame(raw: unknown): FilmChannelFrame {
  const text = typeof raw === "string" ? raw : Buffer.isBuffer(raw) ? raw.toString("utf8") : "";
  if (!text) throw new FilmChannelError("FRAME_INVALID", "通道帧不是字符串");
  if (Buffer.byteLength(text, "utf8") > FILM_CHANNEL_FRAME_LIMIT) throw new FilmChannelError("FRAME_TOO_LARGE", "通道帧超过大小上限");
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new FilmChannelError("FRAME_INVALID", "通道帧不是合法 JSON");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new FilmChannelError("FRAME_INVALID", "通道帧结构非法");
  const kind = (parsed as { kind?: unknown }).kind;
  if (kind !== "film.request" && kind !== "film.response" && kind !== "film.event") {
    throw new FilmChannelError("FRAME_INVALID", "未知的通道帧类型");
  }
  return parsed as FilmChannelFrame;
}

export interface FilmChannelTransport {
  /** 发送一帧到对端。 */
  send(raw: string): void;
  /** 订阅对端帧；返回取消订阅函数。 */
  subscribe(handler: (raw: unknown) => void): () => void;
}

/** Node 子进程 IPC 传输（工位侧默认实现）。 */
export function processIpcTransport(target: NodeJS.Process = process): FilmChannelTransport {
  return {
    send(raw: string): void {
      if (typeof target.send !== "function") throw new FilmChannelError("CHANNEL_UNAVAILABLE", "当前进程没有可用的父通道（必须以服务启动的固定工位方式运行）");
      target.send(raw);
    },
    subscribe(handler: (raw: unknown) => void): () => void {
      const listener = (message: unknown): void => handler(message);
      target.on("message", listener);
      return () => target.off("message", listener);
    },
  };
}

export interface FilmWorkerChannelOptions {
  transport: FilmChannelTransport;
  /** 覆盖逐方法缺省超时（毫秒）。 */
  timeoutMs?: Partial<Record<FilmChannelMethod, number>>;
  /** 收到父服务事件的回调（进度上报，不参与业务判定）。 */
  onEvent?: (event: string, detail?: unknown) => void;
  /** 时钟注入（测试用）。 */
  now?: () => number;
}

interface PendingCall {
  method: FilmChannelMethod;
  resolve: (value: unknown) => void;
  reject: (error: FilmChannelError) => void;
  timer: NodeJS.Timeout;
}

/**
 * 工位侧通道客户端：只允许白名单方法；每次调用都带幂等键与请求哈希。
 * 超时/断链会把 `unknown` 语义交给调用方（不得按超时自动重发）。
 */
export class FilmWorkerChannel {
  private readonly pending = new Map<string, PendingCall>();
  private readonly unsubscribe: () => void;
  private disposed: FilmChannelError | null = null;

  constructor(private readonly options: FilmWorkerChannelOptions) {
    this.unsubscribe = options.transport.subscribe((raw) => {
      let frame: FilmChannelFrame;
      try {
        frame = decodeFilmChannelFrame(raw);
      } catch (error) {
        this.dispose(error instanceof FilmChannelError ? error : new FilmChannelError("FRAME_INVALID", String(error)));
        return;
      }
      if (frame.kind === "film.response") {
        const call = this.pending.get(frame.id);
        if (!call) return;
        this.pending.delete(frame.id);
        clearTimeout(call.timer);
        if (frame.ok) call.resolve(frame.result);
        else call.reject(new FilmChannelError(frame.error?.code ?? "CHANNEL_ERROR", frame.error?.message ?? "父服务未给出错误说明", frame.error?.details));
        return;
      }
      if (frame.kind === "film.event") {
        this.options.onEvent?.(frame.event, frame.detail);
        return;
      }
      this.dispose(new FilmChannelError("FRAME_INVALID", "工位不应收到请求帧"));
    });
  }

  /** 发起一次受限调用；`stepKey`/`shotId` 会与服务冻结的阶段范围核对。 */
  async call(method: FilmChannelMethod, input: {
    stepKey: string;
    shotId?: string | null;
    params: unknown;
    idempotencyKey?: string;
    timeoutMs?: number;
  }): Promise<unknown> {
    const component = FILM_CHANNEL_METHOD_COMPONENT[method];
    if (!component) throw new FilmChannelError("METHOD_NOT_ALLOWED", `通道不接受方法 ${String(method)}`);
    if (this.disposed) throw this.disposed;
    if (!input.stepKey?.trim()) throw new FilmChannelError("FRAME_INVALID", "通道调用缺少步骤键");
    const id = randomUUID();
    const shotId = input.shotId ?? null;
    const frame: FilmChannelRequestFrame = {
      kind: "film.request",
      id,
      method,
      component,
      stepKey: input.stepKey,
      shotId,
      idempotencyKey: input.idempotencyKey?.trim() || `${method}:${input.stepKey}:${shotId ?? "-"}:${id}`,
      requestHash: filmRequestHash({ method, stepKey: input.stepKey, shotId, params: input.params }),
      params: input.params,
    };
    const timeoutMs = input.timeoutMs ?? this.options.timeoutMs?.[method] ?? FILM_CHANNEL_TIMEOUT_MS[method];
    const raw = encodeFilmChannelFrame(frame);
    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new FilmChannelError("CHANNEL_TIMEOUT", `通道调用 ${method} 超时（${timeoutMs}ms）；按未核实处理，不得自动重发`));
      }, timeoutMs);
      timer.unref?.();
      this.pending.set(id, { method, resolve, reject, timer });
      try {
        this.options.transport.send(raw);
      } catch (error) {
        this.pending.delete(id);
        clearTimeout(timer);
        reject(error instanceof FilmChannelError ? error : new FilmChannelError("CHANNEL_UNAVAILABLE", String(error)));
      }
    });
  }

  /** 上报进度事件（服务只记录，不参与判定）。 */
  notify(event: string, detail?: unknown): void {
    if (this.disposed) return;
    try {
      this.options.transport.send(encodeFilmChannelFrame({ kind: "film.event", event, detail }));
    } catch {
      /* 进度上报失败不影响业务；服务以作业终态为准 */
    }
  }

  /** 主动关闭：所有在途调用以 CHANNEL_CLOSED 结束。 */
  dispose(error?: FilmChannelError): void {
    if (this.disposed) return;
    this.disposed = error ?? new FilmChannelError("CHANNEL_CLOSED", "通道已关闭");
    this.unsubscribe();
    for (const [id, call] of this.pending) {
      clearTimeout(call.timer);
      call.reject(this.disposed);
      this.pending.delete(id);
    }
  }
}

/** 工位启动握手：服务通过环境变量下发作业上下文，工位在第一次调用前必须校验它。 */
export const FILM_WORKER_ENV = Object.freeze({
  jobId: "FILM_JOB_ID",
  context: "FILM_JOB_CONTEXT",
  /** 服务显式声明的密钥剥离清单（工位自检：发现任一存在即拒绝启动）。 */
  forbiddenSecrets: "FILM_FORBIDDEN_SECRETS",
});

const FORBIDDEN_SECRET_KEYS = [
  "VOLCENGINE_ARK_API_KEY",
  "ARK_API_KEY",
  "LLM_API_KEY",
  "LLM_BASE_URL",
  "WORKLOOM_RENDER_SIGNING_SECRET",
  "AUDIO_STEMS_SIGNING_SECRET",
];

/** 解析并校验服务下发的作业上下文；任一不符即抛错（工位不得自行拼装上下文）。 */
export function parseFilmWorkerJobContext(env: NodeJS.ProcessEnv = process.env): FilmWorkerJobContext {
  const raw = env[FILM_WORKER_ENV.context];
  if (!raw) throw new FilmChannelError("CONTEXT_MISSING", "缺少服务下发的作业上下文，拒绝在工位模式下启动");
  const forbidden = (env[FILM_WORKER_ENV.forbiddenSecrets] ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  const leaked = Array.from(new Set([...FORBIDDEN_SECRET_KEYS, ...forbidden]))
    .filter((key) => (env[key] ?? "").trim().length > 0);
  if (leaked.length > 0) throw new FilmChannelError("SECRET_LEAK", `工位环境不得携带供应商/签发密钥：${leaked.join(",")}`);
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new FilmChannelError("CONTEXT_INVALID", "作业上下文不是合法 JSON");
  }
  const ctx = parsed as Partial<FilmWorkerJobContext>;
  const text = (value: unknown): value is string => typeof value === "string" && value.trim().length > 0;
  if (!ctx || typeof ctx !== "object" || !text(ctx.jobId) || !text(ctx.tenantId) || !text(ctx.workspaceId)
    || !text(ctx.projectId) || !Number.isInteger(ctx.attempt) || (ctx.attempt ?? 0) <= 0 || !text(ctx.runId)
    || !text(ctx.workerName) || !text(ctx.workerVersion) || !Array.isArray(ctx.stages) || ctx.stages.length === 0
    || !ctx.stages.every((stage) => text(stage)) || !ctx.options || typeof ctx.options !== "object" || Array.isArray(ctx.options)
    || !text(ctx.inputRef) || !/^[a-f0-9]{64}$/.test(String(ctx.inputSha256 ?? "")) || !text(ctx.workDir)
    || !text(ctx.archiveRoot) || !Array.isArray(ctx.allowedMethods) || ctx.allowedMethods.length === 0
    || !ctx.allowedMethods.every((method) => FILM_CHANNEL_METHODS.includes(method as FilmChannelMethod))
    || typeof ctx.budgetCny !== "number" || !Number.isFinite(ctx.budgetCny) || ctx.budgetCny < 0
    || !Number.isFinite(Date.parse(String(ctx.deadlineAt ?? "")))) {
    throw new FilmChannelError("CONTEXT_INVALID", "作业上下文字段缺失或格式非法");
  }
  if (env[FILM_WORKER_ENV.jobId] && env[FILM_WORKER_ENV.jobId] !== ctx.jobId) {
    throw new FilmChannelError("CONTEXT_INVALID", "FILM_JOB_ID 与作业上下文不一致");
  }
  return ctx as FilmWorkerJobContext;
}
