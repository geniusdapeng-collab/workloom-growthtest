/**
 * media/collections.ts —— 合集/片单（本地重剪的组织单元，T-2026-0926-0008）
 *
 * 合集 = 有序素材清单（`seq` 即重剪镜头顺序）+ 用途/状态 + 产出回链（meta.producedAssetId）。
 * 纪律：
 *  - 一切写操作事务内 set_config（RLS 铁律），并写五元事件（collection.create/add_item/reorder/…）；
 *  - 排序用「整体重排 + 事务内单次 UPDATE」表达，避免部分失败留下过半的中间顺序；
 *  - 越权（非本 workspace 的合集/素材）一律返回空或 NOT_FOUND，不泄露存在性（L7.1）。
 */
import type pg from "pg";
import { gatewayAppendOnClient } from "@workloom/base/workdata";
import { newId } from "@workloom/shared";
import { scopedQuery, type AppPool, type Scope } from "../gen/db.js";

export type CollectionPurpose = "recut" | "favorite" | "campaign" | "archive";

export type CollectionRow = {
  id: string;
  title: string;
  purpose: CollectionPurpose;
  meta: Record<string, unknown>;
  status: "open" | "used" | "archived";
  created_by: string;
  created_at: string;
  updated_at: string;
  item_count: string;
};

export type CollectionItemRow = {
  asset_id: string;
  seq: number;
  note: string | null;
  added_by: string;
  added_at: string;
  kind: string;
  title: string | null;
  duration_seconds: string | null;
  local_path: string | null;
  status: string;
};

export interface CollectionView {
  id: string;
  title: string;
  purpose: CollectionPurpose;
  meta: Record<string, unknown>;
  status: string;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
  itemCount: number;
}

function toView(row: CollectionRow): CollectionView {
  return {
    id: row.id,
    title: row.title,
    purpose: row.purpose,
    meta: row.meta ?? {},
    status: row.status,
    createdBy: row.created_by,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    itemCount: Number(row.item_count ?? 0),
  };
}

export async function listCollections(
  app: AppPool, scope: Scope,
  input: { status?: "open" | "used" | "archived" | "all"; limit?: number } = {},
): Promise<CollectionView[]> {
  const limit = Math.min(Math.max(input.limit ?? 50, 1), 200);
  const params: unknown[] = [scope.workspaceId, limit];
  const clauses = ["c.workspace_id = $1"];
  if (input.status && input.status !== "all") {
    params.push(input.status);
    clauses.push(`c.status = $${params.length}`);
  }
  const rows = await scopedQuery<CollectionRow>(app, scope,
    `SELECT c.id, c.title, c.purpose, c.meta, c.status, c.created_by, c.created_at, c.updated_at,
            (SELECT COUNT(*)::text FROM media_collection_items i
              WHERE i.workspace_id = c.workspace_id AND i.collection_id = c.id) AS item_count
       FROM media_collections c
      WHERE ${clauses.join(" AND ")}
      ORDER BY c.updated_at DESC, c.id DESC LIMIT $2`,
    params);
  return rows.map(toView);
}

async function emitCollectionEvent(
  client: pg.PoolClient, scope: Scope, by: string, collectionId: string, decision: Record<string, unknown>,
): Promise<string> {
  const r = await gatewayAppendOnClient(client, {
    tenantId: scope.tenantId, workspaceId: scope.workspaceId,
    actor: { id: by, type: "system" },
  }, {
    who: { type: "system", id: by },
    context: { tenant_id: scope.tenantId, workspace_id: scope.workspaceId, time: new Date().toISOString(), channel: "inapp" },
    object: { type: "media_collection", id: collectionId },
    decision: decision as never,
    rule_impact: [],
  });
  return r.eventId;
}

export async function createCollection(
  app: AppPool, scope: Scope,
  input: { title: string; purpose?: CollectionPurpose; meta?: Record<string, unknown>; by: string },
): Promise<CollectionView> {
  const id = newId("MC");
  const client = await app.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT set_config('app.workspace_id', $1, true)", [scope.workspaceId]);
    await client.query("SELECT set_config('app.tenant_id', $1, true)", [scope.tenantId]);
    const ins = await client.query<CollectionRow>(
      `INSERT INTO media_collections (id, workspace_id, title, purpose, meta, created_by)
       VALUES ($1,$2,$3,$4,$5,$6)
       RETURNING *, '0'::text AS item_count`,
      [id, scope.workspaceId, input.title.trim(), input.purpose ?? "recut", JSON.stringify(input.meta ?? {}), input.by]);
    await emitCollectionEvent(client, scope, input.by, id, {
      action: "collection.create",
      after: { collectionId: id, title: input.title.trim(), purpose: input.purpose ?? "recut" },
      basis: ["媒资库合集创建（重剪片单的组织单元）"],
    });
    await client.query("COMMIT");
    return toView(ins.rows[0]!);
  } catch (err) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}

export async function getCollection(
  app: AppPool, scope: Scope, collectionId: string,
): Promise<{ collection: CollectionView; items: CollectionItemRow[] } | null> {
  const rows = await scopedQuery<CollectionRow>(app, scope,
    `SELECT c.id, c.title, c.purpose, c.meta, c.status, c.created_by, c.created_at, c.updated_at,
            (SELECT COUNT(*)::text FROM media_collection_items i
              WHERE i.workspace_id = c.workspace_id AND i.collection_id = c.id) AS item_count
       FROM media_collections c WHERE c.workspace_id = $1 AND c.id = $2`,
    [scope.workspaceId, collectionId]);
  const row = rows[0];
  if (!row) return null;
  const items = await scopedQuery<CollectionItemRow>(app, scope,
    `SELECT i.asset_id, i.seq, i.note, i.added_by, i.added_at,
            a.kind, a.title, a.duration_seconds, a.status, a.meta->>'localPath' AS local_path
       FROM media_collection_items i
       JOIN video_assets a ON a.workspace_id = i.workspace_id AND a.id = i.asset_id
      WHERE i.workspace_id = $1 AND i.collection_id = $2
      ORDER BY i.seq ASC`,
    [scope.workspaceId, collectionId]);
  return { collection: toView(row), items };
}

/** 追加素材：seq 取当前最大值 +1（事务内取，避免并发插入撞号） */
export async function addCollectionItem(
  app: AppPool, scope: Scope,
  input: { collectionId: string; assetId: string; note?: string | null; by: string },
): Promise<{ seq: number }> {
  const client = await app.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT set_config('app.workspace_id', $1, true)", [scope.workspaceId]);
    await client.query("SELECT set_config('app.tenant_id', $1, true)", [scope.tenantId]);
    const asset = await client.query(
      `SELECT id FROM video_assets WHERE workspace_id = $1 AND id = $2 AND status <> 'archived'`,
      [scope.workspaceId, input.assetId]);
    if (asset.rowCount === 0) throw new Error(`素材 ${input.assetId} 不在当前工作区或已归档`);
    const owned = await client.query(
      `SELECT id FROM media_collections WHERE workspace_id = $1 AND id = $2`,
      [scope.workspaceId, input.collectionId]);
    if (owned.rowCount === 0) throw new Error(`合集 ${input.collectionId} 不在当前工作区`);
    const next = await client.query<{ seq: string }>(
      `SELECT COALESCE(MAX(seq), 0) + 1 AS seq FROM media_collection_items
        WHERE workspace_id = $1 AND collection_id = $2`,
      [scope.workspaceId, input.collectionId]);
    const seq = Number(next.rows[0]?.seq ?? 1);
    await client.query(
      `INSERT INTO media_collection_items (collection_id, workspace_id, asset_id, seq, note, added_by)
       VALUES ($1,$2,$3,$4,$5,$6)
       ON CONFLICT (collection_id, asset_id) DO UPDATE SET seq = EXCLUDED.seq, note = EXCLUDED.note`,
      [input.collectionId, scope.workspaceId, input.assetId, seq, input.note ?? null, input.by]);
    await emitCollectionEvent(client, scope, input.by, input.collectionId, {
      action: "collection.add_item",
      after: { collectionId: input.collectionId, assetId: input.assetId, seq },
      basis: ["合集追加素材（片单顺序）"],
    });
    await client.query("COMMIT");
    return { seq };
  } catch (err) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}

export async function removeCollectionItem(
  app: AppPool, scope: Scope,
  input: { collectionId: string; assetId: string; by: string },
): Promise<{ removed: boolean }> {
  const client = await app.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT set_config('app.workspace_id', $1, true)", [scope.workspaceId]);
    await client.query("SELECT set_config('app.tenant_id', $1, true)", [scope.tenantId]);
    const del = await client.query(
      `DELETE FROM media_collection_items
        WHERE workspace_id = $1 AND collection_id = $2 AND asset_id = $3`,
      [scope.workspaceId, input.collectionId, input.assetId]);
    await emitCollectionEvent(client, scope, input.by, input.collectionId, {
      action: "collection.remove_item",
      after: { collectionId: input.collectionId, assetId: input.assetId, removed: (del.rowCount ?? 0) > 0 },
      basis: ["合集移除素材"],
    });
    await client.query("COMMIT");
    return { removed: (del.rowCount ?? 0) > 0 };
  } catch (err) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}

/**
 * 整体重排：`orderedAssetIds` 必须与合集现有条目**集合相等**（不多不少），
 * 否则拒绝——避免前端拿着部分列表重排导致静默丢条目。
 */
export async function reorderCollection(
  app: AppPool, scope: Scope,
  input: { collectionId: string; orderedAssetIds: string[]; by: string },
): Promise<{ items: number }> {
  const client = await app.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT set_config('app.workspace_id', $1, true)", [scope.workspaceId]);
    await client.query("SELECT set_config('app.tenant_id', $1, true)", [scope.tenantId]);
    const cur = await client.query<{ asset_id: string }>(
      `SELECT asset_id FROM media_collection_items
        WHERE workspace_id = $1 AND collection_id = $2`,
      [scope.workspaceId, input.collectionId]);
    if (cur.rowCount === 0) throw new Error(`合集 ${input.collectionId} 不存在或没有素材`);
    const have = new Set(cur.rows.map((r) => r.asset_id));
    const want = new Set(input.orderedAssetIds);
    if (have.size !== want.size || [...have].some((id) => !want.has(id))) {
      throw new Error("重排清单必须与合集现有素材完全一致（防止静默丢条目）");
    }
    for (const [index, assetId] of input.orderedAssetIds.entries()) {
      await client.query(
        `UPDATE media_collection_items SET seq = $4
          WHERE workspace_id = $1 AND collection_id = $2 AND asset_id = $3`,
        [scope.workspaceId, input.collectionId, assetId, index + 1]);
    }
    await emitCollectionEvent(client, scope, input.by, input.collectionId, {
      action: "collection.reorder",
      after: { collectionId: input.collectionId, order: input.orderedAssetIds },
      basis: ["合集重排（片单顺序即重剪镜头顺序）"],
    });
    await client.query("COMMIT");
    return { items: input.orderedAssetIds.length };
  } catch (err) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}

/** 重剪完成后置 used 并回写产出素材（meta.producedAssetId / producedAt） */
export async function markCollectionUsed(
  app: AppPool, scope: Scope,
  input: { collectionId: string; producedAssetId: string; by: string },
): Promise<void> {
  const client = await app.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT set_config('app.workspace_id', $1, true)", [scope.workspaceId]);
    await client.query("SELECT set_config('app.tenant_id', $1, true)", [scope.tenantId]);
    await client.query(
      `UPDATE media_collections
          SET status = 'used', meta = meta || $3::jsonb
        WHERE workspace_id = $1 AND id = $2`,
      [scope.workspaceId, input.collectionId,
       JSON.stringify({ producedAssetId: input.producedAssetId, producedAt: new Date().toISOString() })]);
    await emitCollectionEvent(client, scope, input.by, input.collectionId, {
      action: "collection.used",
      after: { collectionId: input.collectionId, producedAssetId: input.producedAssetId },
      basis: ["重剪作业产出新成片 → 合集置 used 并回写产出素材"],
    });
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}
