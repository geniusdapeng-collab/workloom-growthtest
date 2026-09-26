/**
 * media/reuse.ts —— 素材复用匹配（findReusable，T-2026-0926-0010）
 *
 * 目标：拍新片时先问一句"这条提示词，库里有没有现成能用的镜头？"——命中即**免重渲**（不烧额度）。
 *
 * 判据（规格书 §7.3，按真实字段校准）：
 *  - 相似度：prompt/title 的 trgm 相似度（中文短串唯一可靠的口径，tsv 对中文无分词）；
 *  - 时长容差 ±1s、画幅一致（`meta.aspectRatio`，缺省不参与过滤）、未归档；
 *  - 只匹配 kind='clip'（成片/定妆照不是"镜头复用"的候选）。
 */
import { scopedQuery, type AppPool, type Scope } from "../gen/db.js";
import { mediaUrl } from "../gen/ingest.js";

export interface FindReusableInput {
  prompt: string;
  durationSec?: number | null;
  aspectRatio?: string | null;
  tags?: string[];
  projectId?: string | null;
  limit?: number;
  minSimilarity?: number;
}

export interface ReusableAsset {
  assetId: string;
  title: string | null;
  prompt: string | null;
  durationSeconds: number | null;
  width: number | null;
  height: number | null;
  similarity: number;
  localPath: string | null;
  url: string | null;
  projectId: string | null;
  createdAt: string;
}

export async function findReusable(
  app: AppPool,
  scope: Scope,
  input: FindReusableInput,
): Promise<ReusableAsset[]> {
  const limit = Math.min(Math.max(input.limit ?? 5, 1), 20);
  const minSimilarity = input.minSimilarity ?? 0.25;
  const prompt = input.prompt.trim();
  if (!prompt) return [];
  const params: unknown[] = [scope.workspaceId, prompt, minSimilarity, limit];
  const clauses = [
    "a.workspace_id = $1",
    "a.kind = 'clip'",
    "a.status <> 'archived'",
    "(COALESCE(a.prompt, '') <> '' OR COALESCE(a.title, '') <> '')",
    "GREATEST(similarity(COALESCE(a.prompt, ''), $2), similarity(COALESCE(a.title, ''), $2)) > $3",
  ];
  if (input.durationSec !== undefined && input.durationSec !== null) {
    params.push(input.durationSec);
    clauses.push(`(a.duration_seconds IS NULL OR abs(a.duration_seconds - $${params.length}) <= 1)`);
  }
  if (input.aspectRatio) {
    params.push(input.aspectRatio);
    clauses.push(`(a.meta->>'aspectRatio' = $${params.length} OR a.meta->>'aspectRatio' IS NULL)`);
  }
  if (input.tags?.length) {
    params.push(JSON.stringify(input.tags));
    clauses.push(`a.tags @> $${params.length}::jsonb`);
  }
  if (input.projectId) {
    params.push(input.projectId);
    clauses.push(`(a.project_id IS NULL OR a.project_id <> $${params.length})`);
  }
  const rows = await scopedQuery<{
    id: string; title: string | null; prompt: string | null; duration_seconds: string | null;
    width: number | null; height: number | null; similarity: number; local_path: string | null;
    project_id: string | null; created_at: string;
  }>(app, scope,
    `SELECT a.id, a.title, a.prompt, a.duration_seconds, a.width, a.height, a.project_id, a.created_at,
            a.meta->>'localPath' AS local_path,
            GREATEST(similarity(COALESCE(a.prompt, ''), $2), similarity(COALESCE(a.title, ''), $2)) AS similarity
       FROM video_assets a
      WHERE ${clauses.join(" AND ")}
      ORDER BY similarity DESC, a.created_at DESC
      LIMIT $4`,
    params);
  return rows.map((row) => ({
    assetId: row.id,
    title: row.title,
    prompt: row.prompt,
    durationSeconds: row.duration_seconds === null ? null : Number(row.duration_seconds),
    width: row.width,
    height: row.height,
    similarity: Math.round(Number(row.similarity) * 1000) / 1000,
    localPath: row.local_path,
    url: row.local_path ? mediaUrl(row.local_path) : null,
    projectId: row.project_id,
    createdAt: row.created_at,
  }));
}
