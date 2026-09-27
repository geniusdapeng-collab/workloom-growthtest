/**
 * video/archive-host.ts —— 制片档案的宿主适配层（T-2026-0926-0001）
 *
 * 为什么单独一个文件：`packages/video-studio` 不依赖 `@workloom/db`（包边界纪律），
 * 台账写入器必须由宿主实现并注入；同时把**项目级执行者租约**收在这里，
 * 让「同一项目同一时刻只有一个执行者」这条不变量在 P0 就成立（规格书 §11 风险表要求）。
 *
 * 三件事：
 *   ① makeLedgerWriter(scope)    —— production_stage_runs 的原子认领 / 终结写 / 心跳（事务内 set_config RLS 口径）
 *   ② acquireProjectLease(scope, id)    —— 项目级 advisory **会话**锁（持有到 run 结束；进程被 kill 由连接断开自动释放）
 *   ③ readProjectMeta(scope, id) —— 交接包需要的项目元数据（thread_id / kind / title）
 */
import type pg from "pg";
import path from "node:path";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { getAppPool } from "@workloom/db";
import {
  ArchiveStore,
  type StageLedgerWriter,
  type StageStatus,
} from "@hyperreality/video-studio";

interface Scope {
  tenantId: string;
  workspaceId: string;
}

const here = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(here, "../../../..");

/**
 * 工作目录（服务器 / 巡检工具 / 恢复 CLI **必须同一口径**，否则档案与台账指向两个地方）。
 *
 * 口径：`HR_WORK_DIR` 绝对路径直接用；相对路径按**仓库根**解析（`.env.example` 写 `.vm-work`
 * 即 `<repo>/.vm-work`）。历史版本按进程 cwd（`pnpm -C apps/server start` → `<repo>/apps/server/`）
 * 解析相对路径，因此保留一条兼容回落：仓库根下没有、而 `<repo>/apps/server/` 下有同名字录时用旧的，
 * 避免升级后既有项目档案/checkpoint 变孤儿（真机巡检时踩到过：工具算出的路径与服务器写入的不是同一个）。
 */
export function archiveWorkDir(env: NodeJS.ProcessEnv = process.env): string {
  const raw = env.HR_WORK_DIR?.trim() || ".vm-work";
  if (path.isAbsolute(raw)) return raw;
  const fromRepoRoot = path.resolve(REPO_ROOT, raw);
  const fromServerCwd = path.resolve(REPO_ROOT, "apps/server", raw);
  /** "看得出是工作目录"的判据：有 archive/ 或 checkpoints/ 子目录（只看目录存在会被 findings/ 之类的旁产误判） */
  const looksLikeWorkDir = (dir: string): boolean =>
    existsSync(path.join(dir, "archive")) || existsSync(path.join(dir, "checkpoints"));
  if (!looksLikeWorkDir(fromRepoRoot) && looksLikeWorkDir(fromServerCwd)) return fromServerCwd;
  return fromRepoRoot;
}

/** 档案开关（`ARCHIVE_ENABLED=0` 时全旁路；测试可直接传 null） */
export function archiveEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return (env.ARCHIVE_ENABLED ?? "1") !== "0";
}

/**
 * 事务内 RLS 上下文 + 回调（口径与 studio-worker/render-poller 一致：
 * `set_config(..., true)` 只在显式事务内有效，autocommit 下语句结束即失效）。
 */
async function withScopedTx<T>(
  scope: Scope,
  fn: (client: pg.PoolClient) => Promise<T>,
): Promise<T> {
  const client = await getAppPool().connect();
  let discard = false;
  try {
    await client.query("BEGIN");
    await client.query("SELECT set_config('app.workspace_id', $1, true)", [scope.workspaceId]);
    await client.query("SELECT set_config('app.tenant_id', $1, true)", [scope.tenantId]);
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (err) {
    try {
      await client.query("ROLLBACK");
    } catch (rollbackError) {
      discard = true;
      throw new AggregateError([err, rollbackError], "archive-transaction-rollback-failed");
    }
    throw err;
  } finally {
    client.release(discard);
  }
}

/** 只读（scopedQuery 同口径；此处不引 router.ts 以免与它形成循环依赖） */
export async function scopedRows<T extends pg.QueryResultRow>(
  scope: Scope,
  sql: string,
  params: unknown[],
): Promise<T[]> {
  return withScopedTx(scope, async (client) => {
    const r = await client.query<T>(sql, params);
    return r.rows;
  });
}

/**
 * 环节台账写入器（实现 `StageLedgerWriter`）。
 *
 * 关键修复（对规格书 §6.1 的修正，已在任务卡留痕）：
 *   - **原子认领 attempt**：在同一事务内先取 `pg_advisory_xact_lock(hashtext(project:stage))`，
 *     再用 `COALESCE(MAX(attempt),0)+1` 计算并在一条 INSERT...SELECT 里落库，
 *     消除「读 next_attempt → 再 insert」之间的 TOCTOU（并发重复启动会复用同一 attempt 并静默丢账）。
 *   - **终结写带 attempt 谓词**：只按 `status='running'` 定位会把同 stage 的两个 attempt 行写串
 *     （历史 attempt 行的 output_ref 被后一次覆盖），因此 WHERE 必须带 `attempt=$n`。
 */
export function makeLedgerWriter(scope: Scope): StageLedgerWriter {
  return {
    claimRun: (row) =>
      withScopedTx(scope, async (client) => {
        // 每 (project, stage) 串行化：同 stage 的 attempt 递增不会互相踩
        await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [
          JSON.stringify(["archive-stage", scope.tenantId, scope.workspaceId, row.projectId, row.stageId]),
        ]);
        const r = await client.query<{ attempt: number; input_ref: string }>(
          `INSERT INTO production_stage_runs
             (id, workspace_id, project_id, stage_id, attempt, input_ref, run_id, last_heartbeat_at)
           SELECT $1, $2, $3, $4, COALESCE(MAX(r.attempt),0)+1,
                  replace($5, '{attempt}', (COALESCE(MAX(r.attempt),0)+1)::text), $6, now()
             FROM video_projects p
             LEFT JOIN production_stage_runs r
               ON r.workspace_id=p.workspace_id AND r.project_id=p.id AND r.stage_id=$4
            WHERE p.workspace_id=$2 AND p.id=$3
            GROUP BY p.id
           RETURNING attempt, input_ref`,
          [row.id, scope.workspaceId, row.projectId, row.stageId, row.inputRefTemplate, row.runId],
        );
        const inserted = r.rows[0];
        if (!inserted) throw new Error(`台账认领失败：${row.projectId}/${row.stageId} 未返回行`);
        return { attempt: Number(inserted.attempt), inputRef: inserted.input_ref };
      }),

    finishRun: (row) =>
      withScopedTx(scope, async (client) => {
        if (row.status === "running") throw new Error("STAGE_FINISH_INVALID: 终结回执不得为 running");
        const params = [
          scope.workspaceId, row.projectId, row.stageId, row.status,
          row.outputRef, row.outputSha256, row.errorClass, row.errorMsg,
          row.durationMs, JSON.stringify(row.cost ?? {}), row.attempt,
        ];
        const updated = await client.query(
          `UPDATE production_stage_runs
              SET status=$4, output_ref=$5, output_sha256=$6, error_class=$7, error_msg=$8,
                  duration_ms=$9, cost=$10::jsonb, finished_at=now()
            WHERE workspace_id=$1 AND project_id=$2 AND stage_id=$3 AND attempt=$11 AND status='running'
            RETURNING id`,
          params,
        );
        if (updated.rowCount === 1) return;
        // 完成写的确认丢失后可重送同一回执；不同终态/摘要或不存在的 attempt 不能假装成功。
        const existing = await client.query(
          `SELECT id FROM production_stage_runs
            WHERE workspace_id=$1 AND project_id=$2 AND stage_id=$3 AND attempt=$11
              AND status=$4 AND output_ref IS NOT DISTINCT FROM $5
              AND output_sha256 IS NOT DISTINCT FROM $6 AND error_class IS NOT DISTINCT FROM $7
              AND error_msg IS NOT DISTINCT FROM $8 AND duration_ms IS NOT DISTINCT FROM $9
              AND cost=$10::jsonb`,
          params,
        );
        if (existing.rowCount !== 1) {
          throw new Error(`STAGE_RECEIPT_CONFLICT: ${row.projectId}/${row.stageId}/${row.attempt} 未找到匹配的终结回执`);
        }
      }),

    heartbeatRun: (row) =>
      withScopedTx(scope, async (client) => {
        await client.query(
          `UPDATE production_stage_runs SET last_heartbeat_at=now()
            WHERE workspace_id=$1 AND project_id=$2 AND stage_id=$3 AND attempt=$4 AND status='running'`,
          [scope.workspaceId, row.projectId, row.stageId, row.attempt],
        );
      }),

    nextAttempt: (projectId, stageId) =>
      withScopedTx(scope, async (client) => {
        const r = await client.query<{ n: number }>(
          `SELECT COALESCE(MAX(attempt),0)+1 AS n FROM production_stage_runs
            WHERE workspace_id=$1 AND project_id=$2 AND stage_id=$3`,
          [scope.workspaceId, projectId, stageId],
        );
        return Number(r.rows[0]?.n ?? 1);
      }),
  };
}

/** 项目级执行者租约：同一项目同一时刻只允许一个执行者（跨进程也成立）。 */
export interface ProjectLease {
  projectId: string;
  release(): Promise<void>;
}

/** 同一编码供执行者、恢复与启动扫描使用，字段分隔无歧义并包含租户/工作区。 */
export function projectRunLockKey(scope: Scope, projectId: string): string {
  if (![scope.tenantId, scope.workspaceId, projectId].every((value) => typeof value === "string" && value.trim())) {
    throw new Error("PROJECT_LEASE_SCOPE_INVALID");
  }
  return JSON.stringify(["archive-run", scope.tenantId, scope.workspaceId, projectId]);
}

/**
 * 抢项目租约：`pg_try_advisory_lock`（会话级，必须持有独立连接）。
 * 返回 null = 已有执行者持有（调用方按"不重复烧额度"处理，不抛错）。
 * 进程被 kill -9 时连接断开，锁由 PG 自动释放——这正是重启后能续跑的原因。
 */
export async function acquireProjectLease(scope: Scope, projectId: string): Promise<ProjectLease | null> {
  const key = projectRunLockKey(scope, projectId);
  const client = await getAppPool().connect();
  try {
    const r = await client.query<{ ok: boolean }>(
      "SELECT pg_try_advisory_lock(hashtext($1)) AS ok",
      [key],
    );
    if (r.rows[0]?.ok === false) {
      client.release();
      return null;
    }
    if (r.rows[0]?.ok !== true) throw new Error("PROJECT_LEASE_RECEIPT_INVALID");
  } catch (err) {
    // 查询可能已经取得锁、但客户端未收到确认；关闭连接才保证未知锁不会回到池里。
    client.release(true);
    throw err;
  }
  let released = false;
  return {
    projectId,
    async release(): Promise<void> {
      if (released) return;
      released = true;
      let discard = false;
      try {
        const result = await client.query<{ ok: boolean }>("SELECT pg_advisory_unlock(hashtext($1)) AS ok", [key]);
        if (result.rows[0]?.ok !== true) throw new Error("PROJECT_LEASE_UNLOCK_UNVERIFIED");
      } catch (err) {
        discard = true;
        throw err;
      } finally {
        client.release(discard);
      }
    },
  };
}

export interface ProjectMeta {
  projectId: string;
  title: string | null;
  kind: "marketing" | "narrative";
  threadId: string | null;
  /** 项目建档时间（身份指纹：换库/重置种子后同名 VID 会拿到不同的 createdAt） */
  createdAt: string | null;
}

/** 读项目元数据（交接包/恢复编排共用；越权返回 null） */
export async function readProjectMeta(scope: Scope, projectId: string): Promise<ProjectMeta | null> {
  const rows = await scopedRows<{
    title: string | null; kind: string | null; thread_id: string | null; created_at: string | null;
  }>(
    scope,
    `SELECT title, kind, thread_id, created_at FROM video_projects WHERE id=$1 AND workspace_id=$2`,
    [projectId, scope.workspaceId],
  );
  const row = rows[0];
  if (!row) return null;
  return {
    projectId,
    title: row.title,
    kind: row.kind === "marketing" ? "marketing" : "narrative",
    threadId: row.thread_id,
    /** 归一成 ISO（pg 返回的是 Date.toString() 口径；身份指纹要可比较） */
    createdAt: row.created_at
      ? (() => {
          const parsed = new Date(row.created_at);
          return Number.isNaN(parsed.getTime()) ? String(row.created_at) : parsed.toISOString();
        })()
      : null,
  };
}

/** 把项目下所有 running 台账置 interrupted（诚实状态：进程已死，状态不能撒谎） */
export async function markProjectInterrupted(scope: Scope, projectId: string): Promise<number> {
  const rows = await withScopedTx(scope, async (client) => {
    const r = await client.query(
      `UPDATE production_stage_runs SET status='interrupted', finished_at=now()
        WHERE workspace_id=$1 AND project_id=$2 AND status='running' RETURNING id`,
      [scope.workspaceId, projectId],
    );
    return r.rowCount ?? 0;
  });
  return rows;
}

export type { StageStatus };

/**
 * 轮询/提交这类"一次性环节"用的档案句柄（旁路；`null` = 关闭或初始化失败）。
 * 只做构造，不做 IO——调用方在写盘点里自己 try/catch（写盘失败不得阻断主流程）。
 */
export function makeStageArchive(
  scope: Scope,
  projectId: string,
  pipelineKind: "marketing" | "narrative" = "narrative",
): { store: ArchiveStore; ledger: StageLedgerWriter } | null {
  if (!archiveEnabled()) return null;
  try {
    const store = new ArchiveStore(archiveWorkDir(), scope.workspaceId, projectId, pipelineKind);
    return { store, ledger: makeLedgerWriter(scope) };
  } catch (err) {
    console.error(`[archive] 环节档案句柄构造失败（旁路关闭）: ${(err as Error).message}`);
    return null;
  }
}
