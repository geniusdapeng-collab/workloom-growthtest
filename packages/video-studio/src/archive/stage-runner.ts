/**
 * archive/stage-runner.ts —— 环节执行器：统一 5 写盘点（start/heartbeat/output/done/failed）。
 *
 * 写盘点纪律：**产物先落盘，状态后翻转**（output 文件写成功才把台账翻成 done）。
 * PG 台账与文件档案双写：文件是本体（大产物），PG 是索引（监控/查询面），
 * 以 `projectId + stageId + attempt` 关联。
 *
 * attempt 归属（对规格书 §5.2 的修复，任务卡 T-2026-0926-0001 留痕）：
 *   `nextAttempt`（读）+ `insertRun`（写）分离在两个事务里 = TOCTOU：并发重复启动会用同一个
 *   attempt，`ON CONFLICT DO NOTHING` 又静默吞掉第二次写入，等于"账面上只有一次执行"。
 *   这里改为**唯一一次原子认领** `claimRun()`：宿主在「同一事务 + 每(project,stage) advisory
 *   xact 锁」内计算 attempt 并 INSERT，返回本行实际落库的 attempt 与 input_ref。
 *   终结写 `finishRun` 一律带 attempt 谓词——只按 `status='running'` 定位会把同 stage 的
 *   两次 attempt 写串（历史 attempt 行的 output_ref 被后一次覆盖）。
 */
import { randomUUID } from "node:crypto";
import type { ArchiveStore } from "./store.js";
import { updateContextBundle } from "./context-bundle.js";

export type StageStatus = "running" | "done" | "failed" | "skipped" | "interrupted";

/** 技术主键（与 @workloom/shared#newId 同格式 `SR-xxxxxxxx`；本包不引 shared，避免 lockfile 抖动） */
export function newStageRunId(): string {
  return `SR-${randomUUID().replace(/-/g, "").slice(0, 8)}`;
}

/**
 * PG 台账写入器（由宿主注入，避免本包依赖 @workloom/db；签名对齐 scopedQuery 口径）。
 * 宿主实现见 `apps/server/src/video/archive-host.ts`。
 */
export interface StageLedgerWriter {
  /**
   * 原子认领一次 attempt：返回实际落库的 `{ attempt, inputRef }`。
   * `inputRefTemplate` 里的 `{attempt}` 由实现替换后写入 input_ref 列。
   */
  claimRun(row: {
    id: string;
    projectId: string;
    stageId: string;
    inputRefTemplate: string;
    runId: string | null;
  }): Promise<{ attempt: number; inputRef: string }>;
  /** 终结写：必须带 attempt 谓词 + `status='running'` 守卫（幂等；已终态行不再改写） */
  finishRun(row: {
    projectId: string;
    stageId: string;
    attempt: number;
    status: StageStatus;
    outputRef: string | null;
    outputSha256: string | null;
    errorClass: string | null;
    errorMsg: string | null;
    durationMs: number;
    cost?: Record<string, unknown>;
  }): Promise<void>;
  /** 心跳（长环节：渲染轮询/批量出图）；实现可节流，失败不得影响主流程 */
  heartbeatRun?(row: { projectId: string; stageId: string; attempt: number; note?: string | null }): Promise<void>;
  /** 下一个 attempt（只读，供人读/CLI 显示；认领必须用 claimRun） */
  nextAttempt(projectId: string, stageId: string): Promise<number>;
}

export interface StageContext {
  stageId: string;
  attempt: number;
  log(level: "info" | "warn" | "error", msg: string, data?: Record<string, unknown>): Promise<void>;
  heartbeat(data?: Record<string, unknown>): Promise<void>;
  /**
   * 落一份**附属产物**到档案（例如预生产结束后的 25/30 字段提示词包）。
   * 返回 `{ sha256, bytes, truncated }`；`truncated=true` 表示超出体积预算、已按策略裁剪
   * （默认丢弃 `fields` 明细只留 prompt 与字段名，绝不静默丢整包）。
   */
  writeArtifact(
    relPath: string,
    data: unknown,
    opts?: { maxBytes?: number; shrink?: (data: unknown) => unknown },
  ): Promise<{ sha256: string; bytes: number; truncated: boolean } | null>;
}

/**
 * 错误分类（枚举 v1）：监控聚类与 findings 归因共用同一口径。
 * 枚举：`NETWORK / LLM_* / PROVIDER_* / SESSION / GATE_REJECTED / BUG`。
 * 修复（对规格书 §5.2）：补上 SESSION 分支（原枚举声明了但不可达）；`rate limit` 归 `LLM_RATE_LIMIT`
 * 而不是 `LLM_TIMEOUT`（限流不是超时，混在一起会让监控聚类误判根因）。
 */
export function classifyError(err: unknown): string {
  const msg = err instanceof Error ? `${err.name} ${err.message}` : String(err);
  if (/ECONNRESET|ETIMEDOUT|ECONNREFUSED|EAI_AGAIN|ENOTFOUND|fetch failed|socket hang up|network error/i.test(msg)) return "NETWORK";
  if (/rate.?limit|429|too many requests|quota exceeded|insufficient_quota/i.test(msg)) return "LLM_RATE_LIMIT";
  if (/LLM[^\n]{0,40}(timeout|超时)|(timeout|超时)[^\n]{0,40}LLM|模型路由不可用/i.test(msg)) return "LLM_TIMEOUT";
  if (/JSON\.parse|Unexpected token|不是合法 ?JSON|invalid json|提取有效JSON|JSON ?解析失败|未找到 ?JSON/i.test(msg)) return "LLM_PARSE";
  // 管线自检闸（PromptDeliveryGuard/PipelineGuard 等）拒绝产物：是"门拦下"而不是"代码崩了"，
  // 归 BUG 会把已知的降级路径升级成 P0 代码缺陷（真机 VID-1004 复盘）。
  if (/PipelineGuard|管线检查未通过|PromptDeliveryGuard|交付闸/i.test(msg)) return "GATE_REJECTED";
  if (/producer_rejected|rejected|打回/i.test(msg)) return "GATE_REJECTED";
  if (/PROVIDER_FAILED|MODEL_UNAVAILABLE|model unavailable/i.test(msg)) return "PROVIDER_FAILED";
  if (/PROVIDER_TIMEOUT|provider[^ ]*timeout/i.test(msg)) return "PROVIDER_TIMEOUT";
  if (/PROVIDER_REJECTED|InputImageSensitiveContentDetected|content.?policy|sensitive/i.test(msg)) return "PROVIDER_REJECTED";
  if (/SESSION|token expired|unauthorized|401|登录态|会话过期/i.test(msg)) return "SESSION";
  return "BUG"; // 无法归类 = 疑似代码缺陷，监控器升级 P0
}

/**
 * 渲染供应商错误分类（T-2026-0926-0002 渲染段使用）：
 * 与 `classifyError` 同族，但把 provider 侧的三态拆开，避免"供应商拒绝"被当成代码 bug。
 */
export function classifyProviderError(err: unknown): string {
  const msg = typeof err === "string" ? err : err instanceof Error ? `${err.name} ${err.message}` : String(err ?? "");
  if (/timeout|timed out|超时/i.test(msg)) return "PROVIDER_TIMEOUT";
  if (/reject|sensitive|privacy|policy|内容审核|审核不通过/i.test(msg)) return "PROVIDER_REJECTED";
  return classifyError(msg);
}

export interface StageRunnerHooks {
  /** 环节开始（宿主可写结构化日志/事件，失败不影响主流程） */
  onStart?(stageId: string, attempt: number, ts: string): void;
  /** 环节终态（done/failed） */
  onFinish?(stageId: string, attempt: number, status: "done" | "failed"): void;
}

/**
 * 环节自评结论（可选）：业务上"跑完了但没成功"（例如 vendor 返回 `success:false`、
 * AI 监制打回、产物被门拦下）必须如实进台账，否则监控器会把失败聚类到 BUG 或看不见。
 * 语义上是阶段内失败：产物照落（产物先落盘），但台账与交接包记 failed。
 */
export interface StageOutcome {
  status: "done" | "failed" | "skipped";
  errorClass?: string | null;
  errorMsg?: string | null;
}

export class StageRunner {
  /** 当前正在执行的环节上下文（宿主可据此把 vendor 进度事件转成 heartbeat） */
  private activeCtx: StageContext | null = null;

  constructor(
    private readonly store: ArchiveStore,
    private readonly ledger: StageLedgerWriter,
    private readonly runId: string | null,
    private readonly hooks: StageRunnerHooks = {},
  ) {}

  /** 当前环节上下文（无环节在跑时返回 null）——用于把外部进度事件写进档案心跳 */
  currentContext(): StageContext | null {
    return this.activeCtx;
  }

  /** 执行一个环节并完整落盘。fn 抛错时：失败现场固化后原样上抛（不吞错、不改主流程语义）。 */
  async run(
    stageId: string,
    input: Record<string, unknown>,
    fn: (ctx: StageContext) => Promise<{
      output: Record<string, unknown>;
      cost?: Record<string, unknown>;
      outcome?: StageOutcome;
    }>,
  ): Promise<Record<string, unknown>> {
    const startedAt = Date.now();
    const dir = `stages/${stageId}`;
    const safe = async (op: () => Promise<unknown>): Promise<void> => {
      try {
        await op();
      } catch (err) {
        console.error(`[archive] 写盘失败(${stageId}): ${(err as Error).message}`);
      }
    };

    /* 写盘点 ① start：原子认领 attempt → 输入快照 → 事件 → manifest 账本 */
    const { attempt, inputRef } = await this.ledger.claimRun({
      id: newStageRunId(),
      projectId: this.store.projectId,
      stageId,
      inputRefTemplate: `${dir}/attempt-{attempt}.input.json`,
      runId: this.runId,
    });
    if (!Number.isSafeInteger(attempt) || attempt < 1 || inputRef !== `${dir}/attempt-${attempt}.input.json`) {
      throw new Error(`STAGE_CLAIM_INVALID: ${stageId} 未返回有效认领回执，拒绝执行`);
    }

    let lastHeartbeatAt = 0;
    const ctx: StageContext = {
      stageId,
      attempt,
      log: async (level, msg, data) =>
        safe(() => this.store.appendJsonl(`logs/${stageId}.jsonl`, { stageId, attempt, level, msg, ...(data ?? {}) })),
      /* 写盘点 ② heartbeat：长环节进度线索（渲染轮询/批量出图用）；PG 侧写节流到 5s 一次 */
      heartbeat: async (data) => {
        await safe(() => this.store.appendJsonl("events.jsonl", { kind: "stage.heartbeat", stageId, attempt, ...(data ?? {}) }));
        const now = Date.now();
        if (this.ledger.heartbeatRun && now - lastHeartbeatAt >= 5_000) {
          lastHeartbeatAt = now;
          await safe(() => this.ledger.heartbeatRun!({ projectId: this.store.projectId, stageId, attempt }));
        }
      },
      /* 附属产物：默认 4MB 预算；超限先按调用方给的 shrink() 裁剪一次，仍超则只留指针与摘要 */
      writeArtifact: async (relPath, data, opts) => {
        const maxBytes = opts?.maxBytes ?? 4 * 1024 * 1024;
        const sizeOf = (value: unknown): number => {
          try {
            return Buffer.byteLength(JSON.stringify(value), "utf8");
          } catch {
            return Number.POSITIVE_INFINITY;
          }
        };
        let payload = data;
        let truncated = false;
        if (sizeOf(payload) > maxBytes && opts?.shrink) {
          payload = opts.shrink(payload);
          truncated = true;
        }
        if (sizeOf(payload) > maxBytes) {
          payload = {
            truncated: true,
            note: `附属产物超过 ${Math.round(maxBytes / 1024)}KB 预算，已只留摘要（原大小 ${sizeOf(data)} 字节）`,
            summary: (() => {
              try {
                return JSON.parse(JSON.stringify(data).slice(0, 4_000)) as unknown;
              } catch {
                return null;
              }
            })(),
          };
          truncated = true;
        }
        let result: { sha256: string; bytes: number; truncated: boolean } | null = null;
        await safe(async () => {
          const written = await this.store.writeJsonAtomic(relPath, payload);
          result = { sha256: written.sha256, bytes: sizeOf(payload), truncated };
        });
        return result;
      },
    };
    let outputReceipt: { outputRef: string; sha256: string } | null = null;
    let executionCompleted = false;
    try {
      // 输入是执行前置证据：写失败不得开始模型/外部动作，更不能退回 attempt=1 覆盖历史。
      await this.store.writeJsonAtomic(inputRef, {
        stageId, attempt, input, startedAt: new Date().toISOString(),
      });
      await safe(() => this.store.appendJsonl("events.jsonl", { kind: "stage.start", stageId, attempt, runId: this.runId }));
      await safe(() => this.store.updateLedger(stageId, { attempt, status: "running", finishedAt: null }));
      await safe(async () => this.hooks.onStart?.(stageId, attempt, new Date().toISOString()));
      this.activeCtx = ctx;
      const { output, cost, outcome } = await fn(ctx);
      executionCompleted = true;
      /* 写盘点 ③ output-ready：产物先落盘 */
      const outputRef = `${dir}/attempt-${attempt}.output.json`;
      const { sha256 } = await this.store.writeJsonAtomic(outputRef, output);
      outputReceipt = { outputRef, sha256 };
      const finalStatus: StageStatus = outcome?.status ?? "done";
      /* 写盘点 ④ done/failed-outcome：状态后翻转（产物已在盘上，状态永远不撒谎） */
      await this.ledger.finishRun({
        projectId: this.store.projectId,
        stageId,
        attempt,
        status: finalStatus,
        outputRef,
        outputSha256: sha256,
        errorClass: outcome?.errorClass ?? null,
        errorMsg: outcome?.errorMsg ?? null,
        durationMs: Date.now() - startedAt,
        cost,
      });
      await safe(() =>
        this.store.appendJsonl("events.jsonl", {
          kind: finalStatus === "done" ? "stage.done" : `stage.${finalStatus}`,
          stageId,
          attempt,
          durationMs: Date.now() - startedAt,
          ...(finalStatus === "done" ? {} : { errorClass: outcome?.errorClass ?? "BUG", errorMsg: outcome?.errorMsg ?? null }),
        }),
      );
      await safe(() => this.store.updateLedger(stageId, { attempt, status: finalStatus, finishedAt: new Date().toISOString() }));
      await safe(() =>
        updateContextBundle(this.store, {
          lastStage: stageId,
          ...(finalStatus === "done"
            ? {}
            : { failedStage: stageId, errorClass: outcome?.errorClass ?? "BUG", errorMsg: outcome?.errorMsg ?? null }),
        }),
      );
      await safe(async () => this.hooks.onFinish?.(stageId, attempt, finalStatus === "done" ? "done" : "failed"));
      return output;
    } catch (err) {
      /* 写盘点 ⑤ failed：失败现场固化（分类 + 摘要进台账；堆栈只进 meta 文件） */
      // 执行已返回后，输出或完成回执写失败都可能伴随已发生的外部动作；必须先对账。
      const status: StageStatus = executionCompleted ? "interrupted" : "failed";
      const errorClass = executionCompleted ? "RECEIPT_UNVERIFIED" : classifyError(err);
      const errorMsg = err instanceof Error ? err.message.slice(0, 500) : String(err).slice(0, 500);
      await safe(() =>
        this.store.writeJsonAtomic(`${dir}/attempt-${attempt}.meta.json`, {
          errorClass,
          stack: err instanceof Error ? err.stack : null,
          failedAt: new Date().toISOString(),
        }),
      );
      await safe(() =>
        this.ledger.finishRun({
          projectId: this.store.projectId,
          stageId,
          attempt,
          status,
          outputRef: outputReceipt?.outputRef ?? null,
          outputSha256: outputReceipt?.sha256 ?? null,
          errorClass,
          errorMsg,
          durationMs: Date.now() - startedAt,
        }),
      );
      await safe(() => this.store.appendJsonl("events.jsonl", { kind: `stage.${status}`, stageId, attempt, errorClass, errorMsg }));
      await safe(() => this.store.updateLedger(stageId, { attempt, status, finishedAt: new Date().toISOString() }));
      await safe(() => updateContextBundle(this.store, { lastStage: stageId, failedStage: stageId, errorClass, errorMsg }));
      await safe(async () => this.hooks.onFinish?.(stageId, attempt, "failed"));
      throw err; // 原样上抛：不改变 vendor/宿主既有错误语义
    } finally {
      this.activeCtx = null;
    }
  }
}
