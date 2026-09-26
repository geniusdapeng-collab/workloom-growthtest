/**
 * media/columns.ts —— 0039 媒资列补写（title/tags/prompt/pipeline_kind/duration/宽高/缩略图/source_type）
 *
 * 为什么要单独一层：`register()` 属基座包（改签名要走 L2→L1→L0 提案），而 0039 的媒资列必须落库。
 * 因此走"基座不动、产品层扩展"的最小侵入路径——register 之后由本模块补写。
 *
 * 与 register 的事务关系（规格书 §10 风险条款）：两者**不是**同一事务。代价是理论上存在
 * "素材行已落库、媒资列未写"的窗口。本模块的处置是：失败重试一次再抛错，并让补写具备
 * 可巡检特征（`title IS NULL AND meta->>'title' IS NOT NULL` 即需修复），巡检口径见
 * `scripts/tools/media-backfill-kind.mts --check-columns`。
 *
 * 本文件只依赖 pg 类型，不 import ingest/mediaRoot，避免与 ingest.ts 形成循环依赖。
 */
import type pg from "pg";

export interface Scope { tenantId: string; workspaceId: string }
export type AppPool = pg.Pool;

export interface MediaColumnPatch {
  title?: string | null;
  tags?: string[];
  prompt?: string | null;
  /** 片型（0042 扩展 explainer：口播解说片，白板/动效引擎共用同一片型） */
  pipelineKind?: "narrative" | "marketing" | "explainer" | null;
  durationSeconds?: number | null;
  width?: number | null;
  height?: number | null;
  thumbPath?: string | null;
  sourceType?: "generated" | "uploaded" | "imported" | "recut";
  /** 画幅（`meta.aspectRatio`，复用匹配判据用；不进独立列） */
  aspectRatio?: string | null;
}

/**
 * `fillOnlyEmpty=true`（sha256 命中既有行时）只填空列，不覆盖用户已经改名/打标的成果。
 */
export async function applyMediaColumns(
  app: AppPool,
  scope: Scope,
  assetId: string,
  patch: MediaColumnPatch,
  opts: { fillOnlyEmpty?: boolean } = {},
): Promise<void> {
  const sets: string[] = [];
  const params: unknown[] = [scope.workspaceId, assetId];
  const push = (column: string, value: unknown, emptyGuard?: string) => {
    params.push(value);
    const placeholder = `$${params.length}`;
    sets.push(opts.fillOnlyEmpty && emptyGuard
      ? `${column} = COALESCE(${emptyGuard}, ${placeholder})`
      : `${column} = ${placeholder}`);
  };
  if (patch.title !== undefined) push("title", patch.title, "NULLIF(title, '')");
  if (patch.tags !== undefined) {
    params.push(JSON.stringify(patch.tags));
    sets.push(opts.fillOnlyEmpty
      ? `tags = CASE WHEN tags IS NULL OR tags = '[]'::jsonb THEN $${params.length}::jsonb ELSE tags END`
      : `tags = $${params.length}::jsonb`);
  }
  if (patch.prompt !== undefined) push("prompt", patch.prompt, "NULLIF(prompt, '')");
  if (patch.pipelineKind !== undefined) push("pipeline_kind", patch.pipelineKind, "pipeline_kind");
  if (patch.durationSeconds !== undefined) push("duration_seconds", patch.durationSeconds, "duration_seconds");
  if (patch.width !== undefined) push("width", patch.width, "width");
  if (patch.height !== undefined) push("height", patch.height, "height");
  if (patch.thumbPath !== undefined) push("thumb_path", patch.thumbPath, "thumb_path");
  if (patch.sourceType !== undefined) push("source_type", patch.sourceType, "source_type");
  if (patch.aspectRatio !== undefined) {
    params.push(JSON.stringify({ aspectRatio: patch.aspectRatio }));
    sets.push(opts.fillOnlyEmpty
      ? `meta = $${params.length}::jsonb || meta`
      : `meta = meta || $${params.length}::jsonb`);
  }
  if (sets.length === 0) return;

  const sql = `UPDATE video_assets SET ${sets.join(", ")} WHERE workspace_id = $1 AND id = $2`;
  let lastError: unknown = null;
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    const client = await app.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT set_config('app.workspace_id', $1, true)", [scope.workspaceId]);
      await client.query("SELECT set_config('app.tenant_id', $1, true)", [scope.tenantId]);
      const res = await client.query(sql, params);
      if ((res.rowCount ?? 0) === 0) throw new Error(`媒资列补写失败：素材 ${assetId} 不在当前工作区`);
      await client.query("COMMIT");
      return;
    } catch (err) {
      lastError = err;
      await client.query("ROLLBACK").catch(() => undefined);
      if (attempt === 1) {
        console.warn(`[media] 媒资列补写失败，重试一次 asset=${assetId}：${err instanceof Error ? err.message : String(err)}`);
        continue;
      }
    } finally {
      client.release();
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}
