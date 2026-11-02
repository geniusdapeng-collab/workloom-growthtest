/**
 * 项目级算力预算事实源。
 *
 * 所有 render.submit 入口必须向 G11 传入同一组数值；遗漏任一字段会被
 * fence-engine 判为求值异常并 fail-closed block。
 */
import type { getAppPool } from "@workloom/db";
import { scopedQuery, type Scope } from "./gen/db.js";
import { SubmissionError } from "./gen/submission-ledger.js";

type AppPool = ReturnType<typeof getAppPool>;

/** 单项目非 mock 渲染已用及在途算力；落账任务优先用实测，未落账接受按冻结计划占用且不双计。 */
export async function projectComputeUsed(
  app: AppPool,
  scope: Scope,
  projectId: string,
  excludeRequestHash?: string,
): Promise<number> {
  const rows = await scopedQuery<{ used: string | null; unverified: string | null }>(
    app,
    scope,
    `SELECT COALESCE(SUM(seconds), 0)::text AS used,
       COUNT(*) FILTER (WHERE seconds IS NULL)::text AS unverified FROM (
       SELECT COALESCE(actual_seconds, est_seconds, 0) AS seconds
       FROM render_jobs
       WHERE workspace_id=$1 AND project_id=$2 AND mock=false
       UNION ALL
       SELECT CASE WHEN (s.fields->>'durationSec')::numeric > 0
         THEN (s.fields->>'durationSec')::numeric ELSE NULL END AS seconds
       FROM generation_submissions g
       JOIN render_scripts s ON s.id=g.script_id AND s.workspace_id=g.workspace_id
         AND s.project_id=g.project_id AND s.version=g.script_version
       WHERE g.workspace_id=$1 AND g.project_id=$2 AND g.tenant_id=$3
         AND g.state IN ('submitting','unknown','accepted','finalized')
         AND ($4::text IS NULL OR g.request_hash<>$4)
         AND COALESCE(g.receipt->>'mock','false')<>'true'
         AND NOT EXISTS (SELECT 1 FROM render_jobs j WHERE j.id=g.job_id AND j.workspace_id=g.workspace_id)
     ) committed_and_pending`,
    [scope.workspaceId, projectId, scope.tenantId, excludeRequestHash ?? null],
  );
  if (Number(rows[0]?.unverified ?? 0) > 0) throw new SubmissionError("PROJECT_COMPUTE_BUDGET_UNVERIFIED", "在途渲染缺少可核实的冻结时长，核对已有任务前不能新增渲染");
  const used = Number(rows[0]?.used ?? 0);
  if (!Number.isFinite(used) || used < 0) throw new SubmissionError("PROJECT_COMPUTE_BUDGET_UNVERIFIED", "项目算力用量不可核实，拒绝新增渲染");
  return used;
}

/**
 * 在同一项目的既有资格租约连接上持有短期预算锁，覆盖核算到提交记账。
 * 网络期间不保持数据库事务；失败和未知接受占用保留在既有提交账本中。
 */
export async function withProjectComputeBudget<T>(input: {
  app: AppPool; scope: Scope; projectId: string; requestHash: string; durationSec: number;
  reconciliationOnly: boolean; env: NodeJS.ProcessEnv;
}, run: () => Promise<T>): Promise<T> {
  const cap = configuredProjectComputeCap(input.env);
  if (input.reconciliationOnly || cap === Number.MAX_SAFE_INTEGER) return run();
  if (!Number.isInteger(input.durationSec) || input.durationSec <= 0) {
    throw new SubmissionError("PROJECT_COMPUTE_BUDGET_UNVERIFIED", "缺少当前镜头的正式计划时长");
  }
  const client = await input.app.connect();
  const key = `video-compute-budget:${JSON.stringify([input.scope.tenantId, input.scope.workspaceId, input.projectId])}`;
  let acquired = false, discard = false;
  try {
    const locked = await client.query<{ ok: boolean }>("SELECT pg_try_advisory_lock(hashtext($1)) AS ok", [key]);
    if (locked.rows[0]?.ok !== true) throw new SubmissionError("SUBMISSION_IN_PROGRESS", "同项目有渲染正在核算和提交，请查询原任务后重试，未发送新的POST");
    acquired = true;
    const used = await projectComputeUsed(input.app, input.scope, input.projectId, input.requestHash);
    if (input.durationSec > cap - used) {
      throw new SubmissionError("PROJECT_COMPUTE_BUDGET_EXCEEDED", `已用和在途 ${used} 秒 + 本镜 ${input.durationSec} 秒超过项目上限 ${cap} 秒`);
    }
    return await run();
  } finally {
    try {
      if (acquired) {
        const unlocked = await client.query<{ ok: boolean }>("SELECT pg_advisory_unlock(hashtext($1)) AS ok", [key]);
        if (unlocked.rows[0]?.ok !== true) throw new Error("project compute budget unlock unverified");
      }
    } catch (error) { discard = true; throw error; }
    finally { client.release(discard); }
  }
}

/** 未配置或非法上限按不设上限处理，避免把空配置误判成零预算。 */
export function configuredProjectComputeCap(env: NodeJS.ProcessEnv = process.env): number {
  const value = Number(env.WORKLOOM_PROJECT_COMPUTE_CAP ?? 0);
  return Number.isFinite(value) && value > 0 ? value : Number.MAX_SAFE_INTEGER;
}

export async function projectComputeBudget(
  app: AppPool,
  scope: Scope,
  projectId: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<{ used: number; cap: number }> {
  return {
    used: await projectComputeUsed(app, scope, projectId),
    cap: configuredProjectComputeCap(env),
  };
}
