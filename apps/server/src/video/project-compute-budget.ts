/**
 * 项目级算力预算事实源。
 *
 * 所有 render.submit 入口必须向 G11 传入同一组数值；遗漏任一字段会被
 * fence-engine 判为求值异常并 fail-closed block。
 */
import type { getAppPool } from "@workloom/db";
import { scopedQuery, type Scope } from "./gen/db.js";

type AppPool = ReturnType<typeof getAppPool>;

/** 单项目非 mock 渲染的已消耗算力秒数；完成回执优先，缺实际值才用提交预估。 */
export async function projectComputeUsed(
  app: AppPool,
  scope: Scope,
  projectId: string,
): Promise<number> {
  const rows = await scopedQuery<{ used: string | null }>(
    app,
    scope,
    `SELECT COALESCE(SUM(COALESCE(actual_seconds, est_seconds, 0)), 0)::text AS used
       FROM render_jobs
      WHERE workspace_id=$1 AND project_id=$2 AND mock=false`,
    [scope.workspaceId, projectId],
  );
  const used = Number(rows[0]?.used ?? 0);
  return Number.isFinite(used) && used > 0 ? used : 0;
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
