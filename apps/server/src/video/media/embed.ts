/**
 * media/embed.ts —— 媒资向量：查询嵌入 / 语义近邻 / 存量回填（T-2026-0926-0010）
 *
 * 口径（规格书 §7.4）：
 *  - 复用 workdata 的 Embedder seam（MockEmbedder 确定性伪向量 / OpenAiEmbedder OpenAI 兼容）；
 *  - **Mock 必须显式标注**（系统不变量 5：mock 与真实分明）：返回值带 `mock` 位，检索诊断一并回显；
 *  - `MEDIA_SEMANTIC_ENABLED=0`（缺省）时不启用语义层，检索行为与 P1（tsv→trgm）完全一致；
 *  - 回填幂等可重跑：只处理 `embedding IS NULL` 的行，批量 50/轮。
 */
import { MockEmbedder, OpenAiEmbedder, type Embedder } from "@workloom/base/workdata";
import { scopedQuery, type AppPool, type Scope } from "../gen/db.js";

export interface EmbedderChoice {
  embedder: Embedder;
  mock: boolean;
  model: string;
  reason: string;
}

/** 语义检索开关（缺省关：降级行为与 P1 一致） */
export function semanticEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return (env.MEDIA_SEMANTIC_ENABLED ?? "0") === "1";
}

/**
 * Embedder 选择：有 OpenAI 兼容 baseUrl + key 时走真实语义；否则 Mock（并在返回值标注）。
 * 不做"假装有语义"的静默降级——调用方拿到 mock=true 必须如实展示。
 */
export function embedderFromEnv(env: NodeJS.ProcessEnv = process.env): EmbedderChoice {
  const baseUrl = (env.MEDIA_EMBEDDING_BASE_URL ?? env.LLM_BASE_URL ?? "").trim().replace(/\/$/, "");
  const apiKey = (env.MEDIA_EMBEDDING_API_KEY ?? env.LLM_API_KEY ?? "").trim();
  // 深审：原来把 LLM_MODEL（通常是 chat 模型）当 embedding 模型用 → /embeddings 必 400；
  // embedding 必须独立配置，缺省用业界通用的小模型名。
  const model = (env.MEDIA_EMBEDDING_MODEL ?? "text-embedding-3-small").trim();
  if (baseUrl && apiKey && !baseUrl.includes("mock")) {
    return { embedder: new OpenAiEmbedder({ baseUrl, apiKey, model }), mock: false, model, reason: "OpenAI 兼容 embeddings 通道" };
  }
  return { embedder: new MockEmbedder(), mock: true, model: "mock-embedder", reason: "缺 baseUrl/apiKey → 确定性伪向量（无语义，仅串联链路）" };
}

function vectorLiteral(vec: number[]): string {
  return `[${vec.map((x) => (Number.isFinite(x) ? Number(x.toFixed(8)) : 0)).join(",")}]`;
}

/** 语义近邻：向量距离排序取 id 集（回表由调用方做，保持越权返回空的口径） */
export async function semanticSearchIds(
  app: AppPool,
  scope: Scope,
  query: string,
  opts: { limit?: number; env?: NodeJS.ProcessEnv } = {},
): Promise<string[]> {
  const limit = Math.min(Math.max(opts.limit ?? 30, 1), 100);
  const { embedder } = embedderFromEnv(opts.env);
  const vec = await embedder.embed(query);
  const rows = await scopedQuery<{ id: string }>(app, scope,
    `SELECT id FROM video_assets
      WHERE workspace_id = $1 AND embedding IS NOT NULL AND status <> 'archived'
      ORDER BY embedding <=> $2::vector LIMIT $3`,
    [scope.workspaceId, vectorLiteral(vec), limit]);
  return rows.map((r) => r.id);
}

export interface BackfillResult {
  scanned: number;
  embedded: number;
  skipped: number;
  failed: number;
  mock: boolean;
  model: string;
  errors: string[];
}

/** 素材向量文本口径：title + prompt + tags（与 user 检索时的自然语言同空间） */
export function embeddingTextOf(row: { title: string | null; prompt: string | null; tags: unknown }): string {
  const tags = Array.isArray(row.tags) ? row.tags.map((t) => String(t)) : [];
  return [row.title ?? "", row.prompt ?? "", tags.join("、")].filter((s) => s.trim().length > 0).join("\n");
}

/**
 * 存量回填（幂等可重跑）：扫 `embedding IS NULL AND (title|prompt|tags 非空)`，
 * 批量嵌入并回填。单行失败只记错误继续（失败行保持 NULL，下轮重试）。
 */
export async function backfillEmbeddings(
  app: AppPool,
  scope: Scope,
  opts: { batch?: number; max?: number; env?: NodeJS.ProcessEnv } = {},
): Promise<BackfillResult> {
  const batch = Math.min(Math.max(opts.batch ?? 50, 1), 200);
  const max = Math.max(opts.max ?? batch, 1);
  const choice = embedderFromEnv(opts.env);
  const result: BackfillResult = {
    scanned: 0, embedded: 0, skipped: 0, failed: 0,
    mock: choice.mock, model: choice.model, errors: [],
  };
  while (result.scanned < max) {
    const rows = await scopedQuery<{ id: string; title: string | null; prompt: string | null; tags: unknown }>(
      app, scope,
      `SELECT id, title, prompt, tags FROM video_assets
        WHERE workspace_id = $1 AND embedding IS NULL
          AND (COALESCE(title, '') <> '' OR COALESCE(prompt, '') <> '' OR tags <> '[]'::jsonb)
        ORDER BY created_at ASC LIMIT $2`,
      [scope.workspaceId, batch]);
    if (rows.length === 0) break;
    for (const row of rows) {
      result.scanned += 1;
      const text = embeddingTextOf(row);
      if (!text.trim()) { result.skipped += 1; continue; }
      try {
        const vec = await choice.embedder.embed(text);
        // 回填不推进 updated_at（`app.skip_media_touch` 事务级豁免），否则每次回填都会制造"全库变更"
        const client = await app.connect();
        try {
          await client.query("BEGIN");
          await client.query("SELECT set_config('app.workspace_id', $1, true)", [scope.workspaceId]);
          await client.query("SELECT set_config('app.tenant_id', $1, true)", [scope.tenantId]);
          await client.query("SELECT set_config('app.skip_media_touch', '1', true)");
          await client.query(`UPDATE video_assets SET embedding = $3::vector WHERE workspace_id = $1 AND id = $2`,
            [scope.workspaceId, row.id, vectorLiteral(vec)]);
          await client.query("COMMIT");
        } catch (innerErr) {
          await client.query("ROLLBACK").catch(() => undefined);
          throw innerErr;
        } finally {
          client.release();
        }
        result.embedded += 1;
      } catch (err) {
        result.failed += 1;
        result.errors.push(`${row.id}：${err instanceof Error ? err.message : String(err)}`);
      }
    }
    if (rows.length < batch) break;
  }
  return result;
}
