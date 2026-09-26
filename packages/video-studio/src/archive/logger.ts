/**
 * archive/logger.ts —— 结构化环节日志通道（T-2026-0926-0003 接线，文件在 T-0001 就位）
 *
 * 定位：**并行**通道，不替换 `studio-worker.ts#teeRunLogs` 的文本 tee
 *       （`scripts/tools/pipeline-audit.mts` 依赖原文逐行核对环节标记）。
 *
 * 行格式（规格书 §5.3）：
 *   `{ ts, stage, attempt, level, msg, shotId?, provider?, errorClass?, data? }`
 * 固定字段 = 可检索维度；`data` 保其余上下文，天然带 correlation id（stage+attempt）。
 * 落盘：`<archiveRoot>/logs/<stageId>.jsonl`，append-only。
 */
import type { ArchiveStore } from "./store.js";

export type StageLogLevel = "info" | "warn" | "error";

export interface StructuredLogLine {
  ts: string;
  stage: string;
  attempt: number;
  level: StageLogLevel;
  msg: string;
  shotId?: string;
  provider?: string;
  errorClass?: string;
  data?: Record<string, unknown>;
}

export interface StageLogChannel {
  log(level: StageLogLevel, msg: string, data?: Record<string, unknown>): Promise<void>;
  info(msg: string, data?: Record<string, unknown>): Promise<void>;
  warn(msg: string, data?: Record<string, unknown>): Promise<void>;
  error(msg: string, data?: Record<string, unknown>): Promise<void>;
}

/** 抽出进固定列的可检索维度；其余原样进 data（不丢字段） */
function splitFields(data?: Record<string, unknown>): Pick<StructuredLogLine, "shotId" | "provider" | "errorClass" | "data"> {
  if (!data) return {};
  const { shotId, shot_id, provider, errorClass, error_class, ...rest } = data;
  const out: Pick<StructuredLogLine, "shotId" | "provider" | "errorClass" | "data"> = {};
  const shot = (shotId ?? shot_id) as unknown;
  const klass = (errorClass ?? error_class) as unknown;
  if (typeof shot === "string" && shot) out.shotId = shot;
  if (typeof provider === "string" && provider) out.provider = provider;
  if (typeof klass === "string" && klass) out.errorClass = klass;
  if (Object.keys(rest).length > 0) out.data = rest;
  return out;
}

/** 写一行结构化日志；返回 Promise 供调用方 await（失败由调用方兜底，不吞异常） */
export async function writeStructuredLog(
  store: ArchiveStore,
  line: Omit<StructuredLogLine, "ts">,
): Promise<void> {
  const record: StructuredLogLine = { ts: new Date().toISOString(), ...line };
  await store.appendJsonl(`logs/${line.stage}.jsonl`, record);
}

/** 环节日志通道（StageRunner 内部已有一条；需要独立写日志时用这个） */
export function createStageLogChannel(store: ArchiveStore, stageId: string, attempt: number): StageLogChannel {
  const emit = async (level: StageLogLevel, msg: string, data?: Record<string, unknown>) => {
    try {
      await writeStructuredLog(store, { stage: stageId, attempt, level, msg, ...splitFields(data) });
    } catch (err) {
      // 结构化日志是旁路：失败只记 stderr，不影响主流程
      console.error(`[archive] 结构化日志写盘失败(${stageId}): ${(err as Error).message}`);
    }
  };
  return {
    log: emit,
    info: (msg, data) => emit("info", msg, data),
    warn: (msg, data) => emit("warn", msg, data),
    error: (msg, data) => emit("error", msg, data),
  };
}

export interface AttachStructuredLogOptions {
  /** 当前环节（StageRunner 写入时更新；缺省 stage='pipeline'） */
  currentStage?: () => string | null;
  /** 当前 attempt（缺省 0 = 未知） */
  currentAttempt?: () => number;
  /** 截断长度（防单行超大；默认 4000 字符） */
  maxMsgChars?: number;
}

/**
 * 把 console 输出镜像成结构化 JSONL（与文本 tee 并行）。
 * 返回 detach()，在 run 结束时调用（与 `restoreRunLogs()` 同位置）。
 */
export function attachStructuredLog(store: ArchiveStore, opts: AttachStructuredLogOptions = {}): () => void {
  const methods: StageLogLevel[] = ["info", "warn", "error"];
  const consoleMethodOf: Record<StageLogLevel, "log" | "warn" | "error"> = {
    info: "log",
    warn: "warn",
    error: "error",
  };
  const originals = methods.map((level) => console[consoleMethodOf[level]]);
  const max = opts.maxMsgChars ?? 4_000;

  const stringify = (args: unknown[]): string => {
    const line = args
      .map((a) => {
        if (typeof a === "string") return a;
        if (a instanceof Error) return `${a.name}: ${a.message}`;
        try {
          return JSON.stringify(a);
        } catch {
          return String(a);
        }
      })
      .join(" ");
    return line.length > max ? `${line.slice(0, max)}…(+${line.length - max})` : line;
  };

  methods.forEach((level, index) => {
    const key = consoleMethodOf[level];
    (console as unknown as Record<string, unknown>)[key] = (...args: unknown[]) => {
      try {
        const stage = opts.currentStage?.() ?? "pipeline";
        const attempt = opts.currentAttempt?.() ?? 0;
        void writeStructuredLog(store, { stage, attempt, level, msg: stringify(args) }).catch((err) => {
          console.error(`[archive] 结构化日志写盘失败(${stage}): ${(err as Error).message}`);
        });
      } catch (err) {
        console.error(`[archive] 结构化日志镜像失败: ${(err as Error).message}`);
      }
      (originals[index] as (...a: unknown[]) => void).apply(console, args);
    };
  });

  return () => {
    methods.forEach((level, index) => {
      (console as unknown as Record<string, unknown>)[consoleMethodOf[level]] = originals[index];
    });
  };
}
