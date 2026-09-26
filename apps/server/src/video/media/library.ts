/**
 * media/library.ts —— 媒资库检索与详情（T-2026-0926-0007）
 *
 * 三层检索一体（规格书 §4，实现期按中文语料校准）：
 *   ① 语义（MEDIA_SEMANTIC_ENABLED=1 且 embedding 已回填）→ 向量近邻 id 集回表；
 *   ② 全文（search_tsv @@ plainto_tsquery('simple', q)）→ 拉丁文/分词命中主路；
 *   ③ trgm/子串兜底（title/prompt/tags ILIKE 子串 + similarity 阈值）→ **中文实际主路**
 *      （`simple` 分词对中文整句几乎零命中，实测只有子串/trigram 靠得住）。
 *
 * 纪律：全部查询事务内 set_config（编码铁律）；越权返回空（L7.1）；
 *      写操作（改名/打标/归档）与五元事件同一事务同一 COMMIT（D16）。
 */
import type pg from "pg";
import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { gatewayAppendOnClient } from "@workloom/base/workdata";
import { newId } from "@workloom/shared";
import { mediaRoot, mediaUrl } from "../gen/ingest.js";
import { scopedQuery, type AppPool, type Scope } from "../gen/db.js";
import { archiveWorkDir } from "../archive-host.js";
import { registerLocalAsset } from "./register-local.js";
import { embedderFromEnv, semanticSearchIds, semanticEnabled } from "./embed.js";

export type MediaAssetRow = {
  id: string;
  kind: string;
  title: string | null;
  tags: unknown;
  prompt: string | null;
  pipeline_kind: string | null;
  source_type: string;
  duration_seconds: string | null;
  width: number | null;
  height: number | null;
  thumb_path: string | null;
  status: string;
  sync_state: string;
  project_id: string | null;
  version: number;
  chain_id: string;
  created_at: string;
  updated_at: string;
  local_path: string | null;
  bytes: string | null;
  similarity?: number | null;
};

export interface MediaAssetView {
  id: string;
  kind: string;
  title: string | null;
  tags: string[];
  prompt: string | null;
  pipelineKind: string | null;
  sourceType: string;
  durationSeconds: number | null;
  width: number | null;
  height: number | null;
  status: string;
  syncState: string;
  projectId: string | null;
  version: number;
  chainId: string;
  createdAt: string;
  updatedAt: string;
  bytes: number | null;
  localPath: string | null;
  /** 媒体仓里文件当前是否在本机（Electron 单机/云端同步的"文件持有声明"） */
  hasLocalFile: boolean;
  url: string | null;
  thumbUrl: string | null;
  similarity: number | null;
}

export interface ListAssetsInput {
  kind?: string[];
  pipelineKind?: "narrative" | "marketing";
  sourceType?: "generated" | "uploaded" | "imported" | "recut";
  tags?: string[];
  collectionId?: string;
  projectId?: string;
  status?: "active" | "archived" | "all";
  query?: string;
  cursor?: string;
  limit?: number;
  /** 检索模式诊断（响应里回填实际走的那一层，供验收与排障） */
  withSearchTrace?: boolean;
}

export interface ListAssetsResult {
  items: MediaAssetView[];
  nextCursor: string | null;
  searchTrace?: { layer: "semantic" | "tsv" | "trgm" | "none"; semanticEnabled: boolean; mock: boolean };
}

/** LIKE 模式的通配符转义（用户输入的 % / _ / \ 不该被当通配符） */
function likePattern(q: string): string {
  return `%${q.replace(/([\\%_])/g, "\\$1")}%`;
}

function toNumber(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

export function toAssetView(row: MediaAssetRow, opts: { thumbExists?: (rel: string) => boolean } = {}): MediaAssetView {
  const tags = Array.isArray(row.tags) ? row.tags.map((t) => String(t)) : [];
  const exists = opts.thumbExists ?? ((rel: string) => existsSync(join(mediaRoot(), rel)));
  return {
    id: row.id,
    kind: row.kind,
    title: row.title,
    tags,
    prompt: row.prompt,
    pipelineKind: row.pipeline_kind,
    sourceType: row.source_type,
    durationSeconds: toNumber(row.duration_seconds),
    width: row.width,
    height: row.height,
    status: row.status,
    syncState: row.sync_state,
    projectId: row.project_id,
    version: row.version,
    chainId: row.chain_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    bytes: toNumber(row.bytes),
    localPath: row.local_path,
    hasLocalFile: Boolean(row.local_path) && exists(row.local_path!),
    url: row.local_path ? mediaUrl(row.local_path) : null,
    thumbUrl: row.thumb_path && exists(row.thumb_path) ? mediaUrl(row.thumb_path) : null,
    similarity: row.similarity === undefined ? null : toNumber(row.similarity),
  };
}

/** 列表列投影（list / 语义回表 / trgm 兜底三处共用，避免"三套 SELECT 三个口径"） */
const ASSET_COLUMNS = `a.id, a.kind, a.title, a.tags, a.prompt, a.pipeline_kind, a.source_type,
        a.duration_seconds, a.width, a.height, a.thumb_path, a.status, a.sync_state,
        a.project_id, a.version, a.chain_id, a.created_at, a.updated_at,
        a.meta->>'localPath' AS local_path, a.meta->>'bytes' AS bytes`;

interface WhereBuilder {
  clauses: string[];
  params: unknown[];
  add(value: unknown): string;
}

function whereBuilder(scope: Scope, input: ListAssetsInput): WhereBuilder {
  const params: unknown[] = [scope.workspaceId];
  const clauses: string[] = ["a.workspace_id = $1"];
  const add = (value: unknown): string => {
    params.push(value);
    return `$${params.length}`;
  };
  if (input.status !== "all") {
    clauses.push(input.status === "archived" ? `a.status = 'archived'` : `a.status <> 'archived'`);
  }
  if (input.kind?.length) clauses.push(`a.kind = ANY(${add(input.kind)}::text[])`);
  if (input.pipelineKind) clauses.push(`a.pipeline_kind = ${add(input.pipelineKind)}`);
  if (input.sourceType) clauses.push(`a.source_type = ${add(input.sourceType)}`);
  if (input.tags?.length) clauses.push(`a.tags @> ${add(JSON.stringify(input.tags))}::jsonb`);
  if (input.projectId) clauses.push(`a.project_id = ${add(input.projectId)}`);
  if (input.collectionId) {
    const p = add(input.collectionId);
    clauses.push(`a.id IN (SELECT asset_id FROM media_collection_items
                            WHERE workspace_id = $1 AND collection_id = ${p})`);
  }
  if (input.cursor) {
    const [createdAt, id] = input.cursor.split("|");
    if (createdAt && id) {
      const p1 = add(createdAt);
      const p2 = add(id);
      clauses.push(`(a.created_at, a.id) < (${p1}::timestamptz, ${p2}::text)`);
    }
  }
  return { clauses, params, add };
}

export async function listAssets(app: AppPool, scope: Scope, input: ListAssetsInput): Promise<ListAssetsResult> {
  const limit = Math.min(Math.max(input.limit ?? 60, 1), 200);
  const query = input.query?.trim();
  const semanticOn = Boolean(query) && semanticEnabled();
  const trace: ListAssetsResult["searchTrace"] = {
    layer: query ? (semanticOn ? "semantic" : "tsv") : "none",
    semanticEnabled: semanticOn,
    mock: embedderFromEnv().mock,
  };

  if (query && semanticOn) {
    const ids = await semanticSearchIds(app, scope, query, { limit: 30 });
    if (ids.length > 0) {
      const w = whereBuilder(scope, input);
      w.clauses.push(`a.id = ANY(${w.add(ids)}::text[])`);
      const p = w.add(limit);
      const rows = await scopedQuery<MediaAssetRow>(app, scope,
        `SELECT ${ASSET_COLUMNS} FROM video_assets a WHERE ${w.clauses.join(" AND ")}
          ORDER BY a.created_at DESC, a.id DESC LIMIT ${p}`, w.params);
      if (rows.length > 0) return finishList(rows, limit, { ...trace, layer: "semantic" });
      trace.layer = "tsv";
    }
  }

  if (query) {
    const w = whereBuilder(scope, input);
    const q = w.add(query);
    w.clauses.push(`a.search_tsv @@ plainto_tsquery('simple', ${q})`);
    const p = w.add(limit);
    const tsvRows = await scopedQuery<MediaAssetRow>(app, scope,
      `SELECT ${ASSET_COLUMNS} FROM video_assets a WHERE ${w.clauses.join(" AND ")}
        ORDER BY a.created_at DESC, a.id DESC LIMIT ${p}`, w.params);
    if (tsvRows.length > 0) return finishList(tsvRows, limit, { ...trace, layer: "tsv" });

    // ③ trgm / 子串兜底：中文的实际主路（tsv 零命中才走到这里）
    const wt = whereBuilder(scope, input);
    const qt = wt.add(query);
    const pattern = wt.add(likePattern(query));
    const threshold = wt.add(0.2);
    wt.clauses.push(`(
        a.title ILIKE ${pattern} ESCAPE '\\'
        OR a.prompt ILIKE ${pattern} ESCAPE '\\'
        OR a.tags::text ILIKE ${pattern} ESCAPE '\\'
        OR similarity(COALESCE(a.title, ''), ${qt}) > ${threshold}
        OR similarity(COALESCE(a.prompt, ''), ${qt}) > ${threshold}
      )`);
    const pt = wt.add(limit);
    const trgmRows = await scopedQuery<MediaAssetRow>(app, scope,
      `SELECT ${ASSET_COLUMNS},
              GREATEST(similarity(COALESCE(a.title, ''), ${qt}), similarity(COALESCE(a.prompt, ''), ${qt})) AS similarity
         FROM video_assets a WHERE ${wt.clauses.join(" AND ")}
        ORDER BY similarity DESC, a.created_at DESC, a.id DESC LIMIT ${pt}`, wt.params);
    return finishList(trgmRows, limit, { ...trace, layer: "trgm" });
  }

  const w = whereBuilder(scope, input);
  const p = w.add(limit);
  const plainRows = await scopedQuery<MediaAssetRow>(app, scope,
    `SELECT ${ASSET_COLUMNS} FROM video_assets a WHERE ${w.clauses.join(" AND ")}
      ORDER BY a.created_at DESC, a.id DESC LIMIT ${p}`, w.params);
  return finishList(plainRows, limit, trace);
}

function finishList(rows: MediaAssetRow[], limit: number, trace: ListAssetsResult["searchTrace"]): ListAssetsResult {
  const items = rows.map((row) => toAssetView(row));
  const last = rows.at(-1);
  return {
    items,
    nextCursor: rows.length === limit && last ? `${last.created_at}|${last.id}` : null,
    searchTrace: trace,
  };
}

/* ================= 详情 / 元信息 / 归档 ================= */

export interface MediaAssetDetail extends MediaAssetView {
  provenance: Record<string, unknown>;
  meta: Record<string, unknown>;
  licenseRisk: string;
  heroImageId: string | null;
  versions: Array<{ id: string; version: number; status: string; createdAt: string; sha256: string }>;
  project: { id: string; title: string; kind: string; status: string } | null;
  archive: { dir: string; exists: boolean } | null;
}

export async function getAsset(app: AppPool, scope: Scope, assetId: string): Promise<MediaAssetDetail | null> {
  const rows = await scopedQuery<MediaAssetRow & {
    provenance: Record<string, unknown>; meta: Record<string, unknown>;
    license_risk: string; hero_image_id: string | null;
  }>(app, scope,
    `SELECT ${ASSET_COLUMNS}, a.provenance, a.meta, a.license_risk, a.hero_image_id, a.project_id
       FROM video_assets a WHERE a.workspace_id = $1 AND a.id = $2`,
    [scope.workspaceId, assetId]);
  const row = rows[0];
  if (!row) return null;

  const versions = await scopedQuery<{ id: string; version: number; status: string; created_at: string; sha256: string }>(
    app, scope,
    `SELECT id, version, status, created_at, sha256 FROM video_assets
      WHERE workspace_id = $1 AND chain_id = $2 ORDER BY version ASC`,
    [scope.workspaceId, row.chain_id]);

  const project = row.project_id
    ? (await scopedQuery<{ id: string; title: string; kind: string; status: string }>(
        app, scope,
        `SELECT id, title, kind, status FROM video_projects WHERE workspace_id = $1 AND id = $2`,
        [scope.workspaceId, row.project_id]))[0] ?? null
    : null;

  const archiveDir = row.project_id
    ? join(resolve(archiveWorkDir()), "archive", scope.workspaceId, row.project_id)
    : null;

  return {
    ...toAssetView(row),
    provenance: row.provenance ?? {},
    meta: row.meta ?? {},
    licenseRisk: row.license_risk,
    heroImageId: row.hero_image_id,
    versions: versions.map((v) => ({
      id: v.id, version: v.version, status: v.status, createdAt: v.created_at, sha256: v.sha256,
    })),
    project,
    archive: archiveDir ? { dir: archiveDir, exists: existsSync(archiveDir) } : null,
  };
}

/** 事务内事件留痕（D16：与业务行同一 COMMIT） */
async function emitInTx(
  client: pg.PoolClient,
  scope: Scope,
  by: string,
  objectId: string,
  decision: Record<string, unknown>,
): Promise<string> {
  const r = await gatewayAppendOnClient(client, {
    tenantId: scope.tenantId, workspaceId: scope.workspaceId,
    actor: { id: by, type: "system" },
  }, {
    who: { type: "system", id: by },
    context: { tenant_id: scope.tenantId, workspace_id: scope.workspaceId, time: new Date().toISOString(), channel: "inapp" },
    object: { type: "asset", id: objectId },
    decision: decision as never,
    rule_impact: [],
  });
  return r.eventId;
}

export interface UpdateAssetMetaInput {
  assetId: string;
  title?: string | null;
  tags?: string[];
  prompt?: string | null;
  by: string;
}

export async function updateAssetMeta(app: AppPool, scope: Scope, input: UpdateAssetMetaInput): Promise<MediaAssetView> {
  const sets: string[] = [];
  const params: unknown[] = [scope.workspaceId, input.assetId];
  if (input.title !== undefined) { params.push(input.title); sets.push(`title = $${params.length}`); }
  if (input.tags !== undefined) { params.push(JSON.stringify(input.tags)); sets.push(`tags = $${params.length}::jsonb`); }
  if (input.prompt !== undefined) { params.push(input.prompt); sets.push(`prompt = $${params.length}`); }
  if (sets.length === 0) throw new Error("没有要更新的字段（title / tags / prompt 至少给一个）");

  const client = await app.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT set_config('app.workspace_id', $1, true)", [scope.workspaceId]);
    await client.query("SELECT set_config('app.tenant_id', $1, true)", [scope.tenantId]);
    const res = await client.query<MediaAssetRow>(
      `UPDATE video_assets SET ${sets.join(", ")} WHERE workspace_id = $1 AND id = $2
        RETURNING ${ASSET_COLUMNS.replace(/a\./g, "")}`,
      params,
    );
    const row = res.rows[0];
    if (!row) throw new Error(`素材 ${input.assetId} 不在当前工作区`);
    await emitInTx(client, scope, input.by, input.assetId, {
      action: "asset.update_meta",
      after: {
        assetId: input.assetId,
        ...(input.title !== undefined ? { title: input.title } : {}),
        ...(input.tags !== undefined ? { tags: input.tags } : {}),
      },
      basis: ["媒资库元信息编辑（标题/标签/提示词）；sha256 与文件本体不动"],
    });
    await client.query("COMMIT");
    return toAssetView(row);
  } catch (err) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}

/** 软删：status='archived'（媒体文件保留，可回收磁盘时另走清理作业） */
export async function archiveAsset(app: AppPool, scope: Scope, input: { assetId: string; by: string }): Promise<void> {
  const client = await app.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT set_config('app.workspace_id', $1, true)", [scope.workspaceId]);
    await client.query("SELECT set_config('app.tenant_id', $1, true)", [scope.tenantId]);
    const res = await client.query(
      `UPDATE video_assets SET status = 'archived' WHERE workspace_id = $1 AND id = $2`,
      [scope.workspaceId, input.assetId],
    );
    if ((res.rowCount ?? 0) === 0) throw new Error(`素材 ${input.assetId} 不在当前工作区`);
    await emitInTx(client, scope, input.by, input.assetId, {
      action: "asset.archive",
      after: { assetId: input.assetId, status: "archived" },
      basis: ["媒资库软删（归档）：行保留、媒体文件保留，列表默认不再展示"],
    });
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}

/* ================= 标签 / 成片历史 / 配额 ================= */

export interface TagGroup { group: string; tags: Array<{ name: string; usage: number }> }

export async function tagGroups(app: AppPool, scope: Scope): Promise<TagGroup[]> {
  const rows = await scopedQuery<{ group_name: string; name: string }>(
    app, scope,
    `SELECT group_name, name FROM media_tags WHERE workspace_id = $1 ORDER BY group_name ASC, name ASC`,
    [scope.workspaceId]);
  const counts = await scopedQuery<{ tag: string; usage: string }>(
    app, scope,
    `SELECT tag, COUNT(*)::text AS usage
       FROM video_assets a, jsonb_array_elements_text(a.tags) AS tag
      WHERE a.workspace_id = $1 AND a.status <> 'archived'
      GROUP BY tag`,
    [scope.workspaceId]);
  const usage = new Map(counts.map((c) => [c.tag, Number(c.usage)]));
  const groups = new Map<string, Array<{ name: string; usage: number }>>();
  for (const row of rows) {
    const list = groups.get(row.group_name) ?? [];
    list.push({ name: row.name, usage: usage.get(row.name) ?? 0 });
    groups.set(row.group_name, list);
  }
  // 自由标签（JSONB 快用轨）也要可见：未受管但已被用过的标签进 default 组
  const managed = new Set(rows.map((r) => r.name));
  const free = [...usage.keys()].filter((tag) => !managed.has(tag)).sort();
  if (free.length > 0) {
    const list = groups.get("default") ?? [];
    for (const tag of free) list.push({ name: tag, usage: usage.get(tag) ?? 0 });
    groups.set("default", list);
  }
  return [...groups.entries()].map(([group, tags]) => ({ group, tags }));
}

export async function createTag(
  app: AppPool, scope: Scope,
  input: { name: string; group?: string; by: string },
): Promise<{ id: string; name: string; group: string }> {
  const id = newId("MT");
  const group = input.group?.trim() || "default";
  const rows = await scopedQuery<{ id: string; name: string; group_name: string }>(
    app, scope,
    `INSERT INTO media_tags (id, workspace_id, name, group_name, created_by)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (workspace_id, group_name, name) DO UPDATE SET name = EXCLUDED.name
     RETURNING id, name, group_name`,
    [id, scope.workspaceId, input.name.trim(), group, input.by]);
  const row = rows[0]!;
  return { id: row.id, name: row.name, group: row.group_name };
}

export interface FilmRow {
  id: string;
  title: string | null;
  projectId: string | null;
  projectTitle: string | null;
  pipelineKind: string | null;
  durationSeconds: number | null;
  createdAt: string;
  status: string;
  sourceType: string;
  url: string | null;
  thumbUrl: string | null;
  publishTasks: { total: number; published: number; failed: number };
}

export async function listFilms(
  app: AppPool, scope: Scope,
  input: { cursor?: string; limit?: number; projectId?: string } = {},
): Promise<{ items: FilmRow[]; nextCursor: string | null }> {
  const limit = Math.min(Math.max(input.limit ?? 40, 1), 200);
  const params: unknown[] = [scope.workspaceId];
  const clauses = ["a.workspace_id = $1", "a.kind = 'final_cut'", "a.status <> 'archived'"];
  if (input.projectId) {
    params.push(input.projectId);
    clauses.push(`a.project_id = $${params.length}`);
  }
  if (input.cursor) {
    const [createdAt, id] = input.cursor.split("|");
    if (createdAt && id) {
      params.push(createdAt); const p1 = `$${params.length}`;
      params.push(id); const p2 = `$${params.length}`;
      clauses.push(`(a.created_at, a.id) < (${p1}::timestamptz, ${p2}::text)`);
    }
  }
  params.push(limit);
  const rows = await scopedQuery<MediaAssetRow & {
    project_title: string | null; publish_total: string; publish_done: string; publish_failed: string;
  }>(app, scope,
    `SELECT ${ASSET_COLUMNS}, p.title AS project_title,
            (SELECT COUNT(*)::text FROM publish_tasks t
              WHERE t.workspace_id = a.workspace_id AND t.asset_id = a.id) AS publish_total,
            (SELECT COUNT(*)::text FROM publish_tasks t
              WHERE t.workspace_id = a.workspace_id AND t.asset_id = a.id AND t.status = 'succeeded') AS publish_done,
            (SELECT COUNT(*)::text FROM publish_tasks t
              WHERE t.workspace_id = a.workspace_id AND t.asset_id = a.id AND t.status = 'failed') AS publish_failed
       FROM video_assets a
       LEFT JOIN video_projects p ON p.id = a.project_id AND p.workspace_id = a.workspace_id
      WHERE ${clauses.join(" AND ")}
      ORDER BY a.created_at DESC, a.id DESC LIMIT $${params.length}`, params);
  const items: FilmRow[] = rows.map((row) => {
    const view = toAssetView(row);
    return {
      id: view.id,
      title: view.title,
      projectId: view.projectId,
      projectTitle: row.project_title,
      pipelineKind: view.pipelineKind,
      durationSeconds: view.durationSeconds,
      createdAt: view.createdAt,
      status: view.status,
      sourceType: view.sourceType,
      url: view.url,
      thumbUrl: view.thumbUrl,
      publishTasks: {
        total: Number(row.publish_total ?? 0),
        published: Number(row.publish_done ?? 0),
        failed: Number(row.publish_failed ?? 0),
      },
    };
  });
  const last = rows.at(-1);
  return { items, nextCursor: rows.length === limit && last ? `${last.created_at}|${last.id}` : null };
}

/** workspace 媒体仓占用（配额闸数据源）：Σ meta.bytes（未登记字节的存量行按 0 计，另行磁盘巡检） */
export async function mediaUsageBytes(app: AppPool, scope: Scope): Promise<number> {
  const rows = await scopedQuery<{ used: string }>(app, scope,
    `SELECT COALESCE(SUM(COALESCE((meta->>'bytes')::bigint, 0)), 0)::text AS used
       FROM video_assets WHERE workspace_id = $1 AND status <> 'archived'`,
    [scope.workspaceId]);
  return Number(rows[0]?.used ?? 0);
}

/* ================= 定妆照批量入库（studio-worker 收尾调用） ================= */

export interface PortraitIndexFileLike {
  characters?: Record<string, { kind?: string; id?: string; name?: string; dir?: string; files?: Record<string, string> }>;
  products?: Record<string, { kind?: string; id?: string; name?: string; dir?: string; files?: Record<string, string> }>;
}

export interface IngestPortraitsResult {
  scanned: number;
  ingested: number;
  deduped: number;
  skipped: number;
  errors: string[];
}

/**
 * 读 `portrait-index.json`（schema workloom.portrait-index/v1）逐张登记定妆照/商品图。
 * 单张失败不推翻整批（失败原因全部带回，调用方记日志）；文件不存在视为"该角度没出图"，计数跳过。
 */
export async function ingestPortraitsFromIndex(
  app: AppPool,
  gateway: pg.Pool,
  scope: Scope,
  input: { projectId: string; pipelineKind: "narrative" | "marketing"; indexPath: string; by: string },
): Promise<IngestPortraitsResult> {
  const result: IngestPortraitsResult = { scanned: 0, ingested: 0, deduped: 0, skipped: 0, errors: [] };
  if (!existsSync(input.indexPath)) return result;
  let index: PortraitIndexFileLike;
  try {
    index = JSON.parse(readFileSync(input.indexPath, "utf8")) as PortraitIndexFileLike;
  } catch (err) {
    result.errors.push(`portrait-index.json 解析失败：${err instanceof Error ? err.message : String(err)}`);
    return result;
  }
  const buckets: Array<{ kind: "portrait" | "product_image"; entries: NonNullable<PortraitIndexFileLike["characters"]> }> = [
    { kind: "portrait", entries: index.characters ?? {} },
    { kind: "product_image", entries: index.products ?? {} },
  ];
  for (const bucket of buckets) {
    for (const [key, entry] of Object.entries(bucket.entries)) {
      for (const [angle, file] of Object.entries(entry.files ?? {})) {
        const abs = isAbsolute(file) ? file : resolve(archiveWorkDir(), file);
        result.scanned += 1;
        if (!existsSync(abs)) { result.skipped += 1; continue; }
        try {
          const reg = await registerLocalAsset(app, gateway, scope, {
            absPath: abs,
            kind: bucket.kind,
            title: `${entry.name ?? key} · ${angle}`,
            tags: [entry.id ?? key, input.projectId, bucket.kind === "portrait" ? "定妆照" : "商品图"],
            prompt: entry.name ?? key,
            projectId: input.projectId,
            pipelineKind: input.pipelineKind,
            sourceType: "generated",
            provenance: { source: "portrait-runtime", angle, characterKey: key },
            by: input.by,
          });
          if (reg.deduped) result.deduped += 1; else result.ingested += 1;
        } catch (err) {
          result.errors.push(`${key}/${angle}：${err instanceof Error ? err.message : String(err)}`);
        }
      }
    }
  }
  return result;
}
