/**
 * video/gen/db.ts —— 生成接缝的 RLS 作用域查询助手
 *
 * 与 `apps/server/src/video/router.ts#scopedQuery` 同口径（事务内 set_config + RLS），
 * 独立成模块以避免 router ↔ gen 的循环依赖。
 */
import type { getAppPool } from "@workloom/db";

export interface Scope { tenantId: string; workspaceId: string }
export type AppPool = ReturnType<typeof getAppPool>;
export type QueryRow = { [column: string]: unknown };

export async function scopedQuery<T extends QueryRow>(
  app: AppPool,
  scope: Scope,
  sql: string,
  params: unknown[],
): Promise<T[]> {
  const client = await app.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT set_config('app.workspace_id', $1, true)", [scope.workspaceId]);
    await client.query("SELECT set_config('app.tenant_id', $1, true)", [scope.tenantId]);
    const r = await client.query<T>(sql, params);
    await client.query("COMMIT");
    return r.rows;
  } catch (err) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}
