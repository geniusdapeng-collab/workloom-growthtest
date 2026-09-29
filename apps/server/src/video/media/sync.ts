/**
 * media/sync.ts —— 云端同步（T-2026-0926-0009）
 *
 * 架构（决策 D4：集中存储，不做 P2P）：
 *   电脑 A/B（Electron，DEPLOY_MODE=desktop，本地 PG + 本地媒体仓）
 *        ⇄ 元数据 push/pull（sha256 键 / updated_at 增量游标 / 可变字段 last-write-wins）
 *        ⇄ 文件按需拉取（lazy fetch，落本地同路径并校验 sha256）
 *   云端中心（DEPLOY_MODE=cloud，云端 PG + 云端媒体仓）
 *
 * 设备认证（规格书 §7.2）：设备密钥由**服务端主密钥确定性派生** `HMAC(master, deviceId)`，
 * 库里只存设备身份与状态，不存密钥明文（校验侧现算现比）；请求签名覆盖
 * `method|path|timestamp|bodySha256`，时间戳偏移 > 5 分钟即拒（防重放）。
 *
 * 冲突口径：同一行两边都改过 → 比较 updated_at，新的赢；落败的一方收到冲突清单，
 * 本地置 `sync_state='conflict'` 并保留自己的元数据（人工合并；不静默覆盖用户输入）。
 */
import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { existsSync, mkdirSync, renameSync, writeFileSync } from "node:fs";
import { chmodSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type pg from "pg";
import { newId } from "@workloom/shared";
import { mediaRoot, mediaUrl } from "../gen/ingest.js";
import { scopedQuery, type AppPool, type Scope } from "../gen/db.js";
import { sha256File } from "./register-local.js";
import { resolveInside } from "./paths.js";

export const SYNC_TABLES = ["assets", "collections", "items", "products"] as const;
export type SyncTable = (typeof SYNC_TABLES)[number];

export const DEVICE_CLOCK_SKEW_MS = 5 * 60 * 1000;

export function syncEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return (env.WORKLOOM_CLOUD_SYNC ?? "0") === "1";
}

function masterSecret(env: NodeJS.ProcessEnv = process.env): string {
  const secret = env.MEDIA_SYNC_MASTER_SECRET?.trim()
    || env.MEDIA_SIGNING_SECRET?.trim()
    || env.JWT_SECRET?.trim();
  if (!secret) throw new Error("缺少 MEDIA_SYNC_MASTER_SECRET / MEDIA_SIGNING_SECRET / JWT_SECRET（拒绝在无密钥下启用同步）");
  return secret;
}

/** 设备密钥 = HMAC(master, deviceId)。服务端不落库、客户端落 600 权限文件。 */
export function deviceKeyFor(deviceId: string, env: NodeJS.ProcessEnv = process.env): string {
  return createHmac("sha256", masterSecret(env)).update(`device:${deviceId}`).digest("base64url");
}

export function deviceSignature(input: {
  method: string; path: string; timestamp: string; bodySha256: string;
}, deviceKey: string): string {
  const body = `${input.method.toUpperCase()}|${input.path}|${input.timestamp}|${input.bodySha256}`;
  return createHmac("sha256", deviceKey).update(body).digest("base64url");
}

export function bodyHash(body: string): string {
  return createHash("sha256").update(body ?? "", "utf8").digest("hex");
}

/* ================= 云端侧：设备登记与请求校验 ================= */

export interface EnrollResult {
  deviceId: string;
  deviceKey: string;
  workspaceId: string;
  label: string;
}

/** 云端控制台签发设备（一次性展示 deviceKey；库内只存身份与状态） */
export async function enrollDevice(
  app: AppPool, scope: Scope,
  input: { label: string; by: string; env?: NodeJS.ProcessEnv; ttlDays?: number },
): Promise<EnrollResult> {
  const label = input.label.trim();
  if (!label) throw new Error("设备名不能为空");
  const id = newId("SD");
  const ttlDays = Number(input.env?.MEDIA_SYNC_DEVICE_TTL_DAYS ?? input.ttlDays ?? 90);
  const days = Number.isFinite(ttlDays) && ttlDays > 0 ? Math.floor(ttlDays) : 90;
  await scopedQuery(app, scope,
    `INSERT INTO media_sync_devices (id, workspace_id, label, created_by, expires_at)
     VALUES ($1,$2,$3,$4, now() + ($5 || ' days')::interval)`,
    [id, scope.workspaceId, label, input.by, String(days)]);
  return {
    deviceId: id,
    deviceKey: deviceKeyFor(id, input.env ?? process.env),
    workspaceId: scope.workspaceId,
    label,
  };
}

export async function listDevices(app: AppPool, scope: Scope): Promise<Array<{
  id: string; label: string; status: string; lastSeenAt: string | null; createdAt: string; expiresAt: string; expired: boolean;
}>> {
  const rows = await scopedQuery<{ id: string; label: string; status: string; last_seen_at: string | null; created_at: string; expires_at: string; expired: boolean }>(
    app, scope,
    `SELECT id, label, status, last_seen_at, created_at, expires_at, (expires_at <= now()) AS expired
       FROM media_sync_devices WHERE workspace_id = $1 ORDER BY created_at DESC`, [scope.workspaceId]);
  return rows.map((r) => ({
    id: r.id, label: r.label, status: r.status, lastSeenAt: r.last_seen_at,
    createdAt: isoOf(r.created_at), expiresAt: isoOf(r.expires_at), expired: r.expired === true,
  }));
}

export async function revokeDevice(app: AppPool, scope: Scope, deviceId: string): Promise<{ revoked: boolean }> {
  const rows = await scopedQuery<{ id: string }>(app, scope,
    `UPDATE media_sync_devices SET status = 'revoked'
      WHERE workspace_id = $1 AND id = $2 RETURNING id`,
    [scope.workspaceId, deviceId]);
  return { revoked: rows.length > 0 };
}

export interface DeviceAuthInput {
  deviceId: string;
  timestamp: string;
  signature: string;
  method: string;
  path: string;
  body: string;
  now?: number;
  env?: NodeJS.ProcessEnv;
}

export interface DeviceAuthResult {
  ok: boolean;
  code?: string;
  scope?: Scope;
  deviceLabel?: string;
}

/** 校验设备签名（状态 + 时间戳偏移 + 常量时间比对），并顺手刷新 last_seen_at */
export async function verifyDeviceRequest(owner: AppPool, input: DeviceAuthInput): Promise<DeviceAuthResult> {
  const now = input.now ?? Date.now();
  const ts = Number(input.timestamp);
  if (!Number.isFinite(ts)) return { ok: false, code: "DEVICE_TIMESTAMP_INVALID" };
  if (Math.abs(now - ts) > DEVICE_CLOCK_SKEW_MS) return { ok: false, code: "DEVICE_TIMESTAMP_SKEW" };
  /**
   * 校验发生在"还不知道是哪个 workspace"的时刻，因此这里用 owner 连接直查（表 owner 天然绕过 RLS），
   * 且只按设备主键命中一行、只取校验所需字段——不把设备表暴露成跨租户列表。
   */
  const ownerRows = await owner.query<{ id: string; workspace_id: string; tenant_id: string; label: string; status: string; expired: boolean }>(
    `SELECT d.id, d.workspace_id, w.tenant_id, d.label, d.status, (d.expires_at <= now()) AS expired
       FROM media_sync_devices d JOIN workspaces w ON w.id = d.workspace_id
      WHERE d.id = $1`,
    [input.deviceId]);
  const rows = ownerRows.rows;
  const device = rows[0];
  if (!device) return { ok: false, code: "DEVICE_UNKNOWN" };
  if (device.status !== "active") return { ok: false, code: "DEVICE_REVOKED" };
  if ((device as { expired?: boolean }).expired) return { ok: false, code: "DEVICE_EXPIRED" };
  const expect = Buffer.from(deviceSignature({
    method: input.method, path: input.path, timestamp: input.timestamp, bodySha256: bodyHash(input.body),
  }, deviceKeyFor(device.id, input.env)));
  const actual = Buffer.from(input.signature ?? "");
  if (expect.length !== actual.length || !timingSafeEqual(expect, actual)) {
    return { ok: false, code: "DEVICE_BAD_SIGNATURE" };
  }
  await scopedQuery(owner, { tenantId: device.tenant_id, workspaceId: device.workspace_id },
    `UPDATE media_sync_devices SET last_seen_at = now() WHERE id = $1`, [device.id]);
  return {
    ok: true,
    scope: { tenantId: device.tenant_id, workspaceId: device.workspace_id },
    deviceLabel: device.label,
  };
}

/* ================= 台账 ================= */

export async function logSync(
  app: AppPool, scope: Scope,
  input: { assetId: string; direction: "push" | "pull"; payloadKind: "metadata" | "file"; bytes?: number; peer: string; status: "done" | "failed"; error?: string | null },
): Promise<void> {
  await scopedQuery(app, scope,
    `INSERT INTO media_sync_log (workspace_id, asset_id, direction, payload_kind, bytes, peer, status, error)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
    [scope.workspaceId, input.assetId, input.direction, input.payloadKind,
     Math.max(0, Math.round(input.bytes ?? 0)), input.peer, input.status, input.error ?? null]);
}

export async function listSyncLog(app: AppPool, scope: Scope, limit = 100, beforeId?: string): Promise<{
  entries: Array<{
    id: string; assetId: string; direction: string; payloadKind: string; bytes: number;
    peer: string; status: string; error: string | null; createdAt: string;
  }>;
  nextCursor: string | null;
}> {
  const rows = await scopedQuery<{
    id: string; asset_id: string; direction: string; payload_kind: string; bytes: string;
    peer: string; status: string; error: string | null; created_at: string;
  }>(app, scope,
    `SELECT id, asset_id, direction, payload_kind, bytes, peer, status, error, created_at
       FROM media_sync_log
      WHERE workspace_id = $1 AND ($2::bigint IS NULL OR id < $2::bigint)
      ORDER BY id DESC LIMIT $3`,
    [scope.workspaceId, beforeId ? Number(beforeId) : null, Math.min(Math.max(limit, 1), 500)]);
  const entries = rows.map((r) => ({
    id: r.id, assetId: r.asset_id, direction: r.direction, payloadKind: r.payload_kind,
    bytes: Number(r.bytes), peer: r.peer, status: r.status, error: r.error, createdAt: r.created_at,
  }));
  const cap = Math.min(Math.max(limit, 1), 500);
  return { entries, nextCursor: rows.length === cap ? rows.at(-1)!.id : null };
}

/* ================= 元数据：增量拉取（云端侧） ================= */

export type SyncAssetRow = {
  id: string;
  project_id: string | null;
  chain_id: string;
  kind: string;
  version: number;
  parent_id: string | null;
  source_url: string;
  provenance: Record<string, unknown>;
  license_risk: string;
  hero_image_id: string | null;
  sha256: string;
  meta: Record<string, unknown>;
  status: string;
  created_by: string;
  /** 运行时是 JS Date（pg 解析 TIMESTAMPTZ）；进出统一经 isoOf() 归一 */
  created_at: string | Date;
  updated_at: string | Date;
  title: string | null;
  tags: unknown;
  prompt: string | null;
  pipeline_kind: string | null;
  duration_seconds: string | null;
  width: number | null;
  height: number | null;
  thumb_path: string | null;
  source_type: string;
  sync_state: string;
};

export interface SyncPullPayload {
  since: string | null;
  cursor: string;
  hasMore: boolean;
  assets: SyncAssetRow[];
  collections: Array<Record<string, unknown>>;
  items: Array<Record<string, unknown>>;
  products: Array<Record<string, unknown>>;
  /** 云端为本批素材签发的新鲜播放/拉取地址（文件按需拉取用） */
  urls: Record<string, { url: string; expiresInSec: number }>;
}

/**
 * 增量拉取：四表按 updated_at > since 取行（每表独立上限，保证"有变更就一定翻得到页"）。
 * 返回 cursor = 本批最大 updated_at；hasMore 表示是否还有更晚的变更。
 */
export async function changesSince(
  app: AppPool, scope: Scope,
  input: { since?: string | Date | null; limit?: number } = {},
): Promise<SyncPullPayload> {
  const limit = Math.min(Math.max(input.limit ?? 500, 1), 1000);
  const start = decodeCursor(input.since);
  const assets = await scopedQuery<SyncAssetRow>(app, scope,
    `SELECT id, project_id, chain_id, kind, version, parent_id, source_url, provenance, license_risk,
            hero_image_id, sha256, meta, status, created_by, created_at, updated_at, title, tags, prompt,
            pipeline_kind, duration_seconds, width, height, thumb_path, source_type, sync_state,
            updated_at::text AS cursor_at
       FROM video_assets
      WHERE workspace_id = $1 AND (updated_at, id) > ($2::timestamptz, $3::text)
      ORDER BY updated_at ASC, id ASC LIMIT $4`,
    [scope.workspaceId, start.a[0], start.a[1], limit]);
  const collections = await scopedQuery<Record<string, unknown>>(app, scope,
    `SELECT id, title, purpose, meta, status, created_by, created_at, updated_at, updated_at::text AS cursor_at
       FROM media_collections
      WHERE workspace_id = $1 AND (updated_at, id) > ($2::timestamptz, $3::text)
      ORDER BY updated_at ASC, id ASC LIMIT $4`,
    [scope.workspaceId, start.c[0], start.c[1], limit]);
  const items = await scopedQuery<Record<string, unknown>>(app, scope,
    `SELECT collection_id, asset_id, seq, note, added_by, added_at, updated_at, updated_at::text AS cursor_at
       FROM media_collection_items
      WHERE workspace_id = $1 AND (updated_at, collection_id, asset_id) > ($2::timestamptz, $3::text, $4::text)
      ORDER BY updated_at ASC, collection_id ASC, asset_id ASC LIMIT $5`,
    [scope.workspaceId, start.i[0], start.i[1], start.i[2], limit]);
  const products = await scopedQuery<Record<string, unknown>>(app, scope,
    `SELECT id, product_name, dossier_product_id, dossier_path, dossier_sha256, summary, hero_asset_id, status,
            created_at, updated_at, updated_at::text AS cursor_at
       FROM media_product_profiles
      WHERE workspace_id = $1 AND (updated_at, id) > ($2::timestamptz, $3::text)
      ORDER BY updated_at ASC, id ASC LIMIT $4`,
    [scope.workspaceId, start.p[0], start.p[1], limit]);
  const urls: SyncPullPayload["urls"] = {};
  for (const asset of assets) {
    const localPath = (asset.meta as { localPath?: string } | null)?.localPath;
    if (localPath && asset.sync_state !== "conflict") {
      urls[asset.id] = { url: mediaUrl(localPath, 3600), expiresInSec: 3600 };
    }
  }
  /**
   * 游标推进 = 每表各自的 (updated_at, id) 末条；本表本页无行则保留原元组。
   * 为什么不用"全局 max(updated_at)"（T-2026-0926-0012 深审实证）：触发器把 updated_at
   * 写成**事务时间**，同一事务写入的多行时间戳完全相同；当同刻行数 > limit 时，
   * 全局游标 + 严格大于会让拉取原地打转（page2 == page1、hasMore 恒 true、行永远同步不过去）。
   */
  const next = {
    v: 2 as const,
    a: advance(start.a, assets.at(-1), (row) => [cursorStamp(row), String(row.id)]),
    c: advance(start.c, collections.at(-1), (row) => [cursorStamp(row), String(row.id)]),
    i: advance(start.i, items.at(-1), (row) => [cursorStamp(row), String(row.collection_id), String(row.asset_id)]),
    p: advance(start.p, products.at(-1), (row) => [cursorStamp(row), String(row.id)]),
  };
  const hasMore = [assets, collections, items, products].some((rows) => rows.length === limit);
  return {
    since: input.since ? (typeof input.since === "string" ? input.since : isoOf(input.since)) : null,
    cursor: encodeCursor(next), hasMore, assets, collections, items, products, urls,
  };
}

/* ================= 同步游标（opaque v2） ================= */

type Tuple = [string, ...string[]];
export interface SyncCursor {
  v: 2;
  a: Tuple;
  c: Tuple;
  i: Tuple;
  p: Tuple;
}

/** 起点元组固定 3 段：2 段比较（assets/collections/products）与 3 段比较（items）都能直接用 */
const EPOCH: Tuple = ["1970-01-01T00:00:00.000Z", "", ""];

function advance<T>(prev: Tuple, row: T | undefined, pick: (row: T) => Tuple): Tuple {
  return row ? pick(row) : prev;
}

/**
 * 游标里的时间戳必须用 **SQL 原文**（`updated_at::text`，微秒精度 + 带时区偏移），
 * 不能走 JS Date：pg 解析 timestamptz 只到毫秒，回写成 ISO 会截断微秒，
 * 于是 `(updated_at, id) > (被截断的 ts, id)` 永远包含同秒的行 → 分页原地打转
 * （T-2026-0926-0012 实测：`…935123` 被截成 `…935Z`）。
 */
function cursorStamp(row: unknown): string {
  const value = (row as { cursor_at?: unknown } | null)?.cursor_at;
  if (typeof value === "string" && value) return value;
  return isoOf((row as { updated_at?: unknown } | null)?.updated_at);
}

export function encodeCursor(cursor: SyncCursor): string {
  return Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url");
}

/**
 * 解析游标：既接受 v2 opaque 游标，也接受**上一版的全局 ISO 字符串**（设备文件里存的旧值），
 * 后者退化为"四表都用该时间戳 + 空 id"——语义等价于旧行为，不会把自己锁死。
 */
export function decodeCursor(value?: string | Date | null): SyncCursor {
  if (!value) return { v: 2, a: EPOCH, c: EPOCH, i: EPOCH, p: EPOCH };
  if (value instanceof Date) {
    const iso = value.toISOString();
    return { v: 2, a: [iso, ""], c: [iso, ""], i: [iso, "", ""], p: [iso, ""] };
  }
  const text = String(value);
  try {
    const parsed = JSON.parse(Buffer.from(text, "base64url").toString("utf8")) as Partial<SyncCursor>;
    if (parsed && parsed.v === 2) {
      return {
        v: 2,
        a: Array.isArray(parsed.a) && parsed.a.length > 0 ? (parsed.a as Tuple) : EPOCH,
        c: Array.isArray(parsed.c) && parsed.c.length > 0 ? (parsed.c as Tuple) : EPOCH,
        i: Array.isArray(parsed.i) && parsed.i.length > 0 ? (parsed.i as Tuple) : EPOCH,
        p: Array.isArray(parsed.p) && parsed.p.length > 0 ? (parsed.p as Tuple) : EPOCH,
      };
    }
  } catch { /* 非 v2：按旧 ISO 游标处理 */ }
  const iso = isoOf(text);
  return { v: 2, a: [iso, ""], c: [iso, ""], i: [iso, "", ""], p: [iso, ""] };
}

/* ================= 元数据：推送（云端侧 LWW 合并） ================= */

export interface SyncPushPayload {
  assets?: SyncAssetRow[];
  collections?: Array<Record<string, unknown>>;
  items?: Array<Record<string, unknown>>;
  products?: Array<Record<string, unknown>>;
}

export interface SyncConflict {
  table: SyncTable;
  id: string;
  localUpdatedAt: string | null;
  serverUpdatedAt: string;
  reason: string;
}

export interface SyncPushResult {
  applied: Record<SyncTable, number>;
  conflicts: SyncConflict[];
  /** 逐行隔离后的失败行（错误原文，便于对账与重试） */
  failed: Array<{ table: SyncTable; id: string; error: string }>;
}

/** TIMESTAMPTZ → ISO（Date/字符串都能吃；不可解析时原样返回，交给上层报错） */
export function isoOf(value: unknown): string {
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "string") {
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? value : parsed.toISOString();
  }
  return "";
}

function newerThan(a: unknown, b: unknown): boolean {
  const ta = Date.parse(isoOf(a));
  const tb = Date.parse(isoOf(b));
  if (!Number.isFinite(ta) || !Number.isFinite(tb)) return true;
  return ta > tb;
}

/**
 * LWW 合并：逐行比较 updated_at，服务端更新则拒绝并回报冲突（不静默覆盖）。
 * 每次真实写入都记 media_sync_log（payload_kind='metadata'），台账可审计。
 */
/**
 * 逐行独立事务：任一行失败只回滚该行（T-2026-0926-0013 深审修正——原实现每行各自
 * scopedQuery 但没有错误隔离，同批出现重复 sha256 会让整个 push 500，且已写入的行留在库里）。
 */
async function rowTx<T>(app: AppPool, scope: Scope, fn: (client: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await app.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT set_config('app.workspace_id', $1, true)", [scope.workspaceId]);
    await client.query("SELECT set_config('app.tenant_id', $1, true)", [scope.tenantId]);
    const out = await fn(client);
    await client.query("COMMIT");
    return out;
  } catch (err) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}

/**
 * 推送合并（云端侧）：LWW + **逐行隔离** + **真实回执**。
 *
 * 深审实证（T-2026-0926-0013）：
 *  - 同批出现同 sha256 不同 id 的行 → 唯一索引 `video_assets_workspace_id_sha256_key` 抛出，
 *    整个 push 500，且失败前已提交的行不回滚（无逐行隔离/无整体事务）；
 *  - `applied` 原先无条件 +1：`ON CONFLICT … WHERE updated_at < EXCLUDED.updated_at` 被抑制时
 *    其实一行没写，回执却报"已应用"。
 * 现在：每行一个事务 + rowCount 回执；sha256 撞既有素材降级为冲突清单（不静默合并、不炸批）；
 * 失败行进 `failed[]` 并写 failed 台账，成功的行进 `applied` 并写 done 台账。
 */
export async function applyPush(
  app: AppPool, scope: Scope, payload: SyncPushPayload, peer: string,
): Promise<SyncPushResult> {
  const result: SyncPushResult = { applied: { assets: 0, collections: 0, items: 0, products: 0 }, conflicts: [], failed: [] };

  const recordFailure = async (table: SyncTable, id: string, error: string) => {
    result.failed.push({ table, id, error });
    await logSync(app, scope, { assetId: id, direction: "pull", payloadKind: "metadata", peer, status: "failed", error });
  };

  for (const asset of payload.assets ?? []) {
    try {
      const nearby = await scopedQuery<{ id: string; updated_at: string }>(app, scope,
        `SELECT id, updated_at FROM video_assets WHERE workspace_id = $1 AND (id = $2 OR sha256 = $3)`,
        [scope.workspaceId, asset.id, asset.sha256]);
      const byId = nearby.find((row) => row.id === asset.id) ?? null;
      const bySha = nearby.find((row) => row.id !== asset.id) ?? null;
      if (bySha) {
        result.conflicts.push({
          table: "assets", id: asset.id, localUpdatedAt: isoOf(asset.updated_at), serverUpdatedAt: isoOf(bySha.updated_at),
          reason: `同内容已存在于素材 ${bySha.id}（sha256 幂等键命中）：不静默合并，请人工确认后再推`,
        });
        continue;
      }
      if (byId && !newerThan(asset.updated_at, byId.updated_at)) {
        result.conflicts.push({ table: "assets", id: asset.id, localUpdatedAt: isoOf(asset.updated_at), serverUpdatedAt: isoOf(byId.updated_at), reason: "服务端更新更晚" });
        continue;
      }
      const written = await rowTx(app, scope, async (client) => {
        const res = await client.query(
          `INSERT INTO video_assets
             (id, workspace_id, project_id, chain_id, kind, version, parent_id, source_url, provenance,
              license_risk, hero_image_id, sha256, meta, status, created_by, created_at, updated_at,
              title, tags, prompt, pipeline_kind, duration_seconds, width, height, thumb_path, source_type, sync_state)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10,$11,$12,$13::jsonb,$14,$15,$16::timestamptz,$17::timestamptz,
                   $18,$19::jsonb,$20,$21,$22,$23,$24,$25,$26,$27)
           ON CONFLICT (id) DO UPDATE SET
             project_id = EXCLUDED.project_id, version = EXCLUDED.version, source_url = EXCLUDED.source_url,
             provenance = EXCLUDED.provenance, license_risk = EXCLUDED.license_risk,
             hero_image_id = EXCLUDED.hero_image_id, meta = EXCLUDED.meta, status = EXCLUDED.status,
             title = EXCLUDED.title, tags = EXCLUDED.tags, prompt = EXCLUDED.prompt,
             pipeline_kind = EXCLUDED.pipeline_kind, duration_seconds = EXCLUDED.duration_seconds,
             width = EXCLUDED.width, height = EXCLUDED.height, thumb_path = EXCLUDED.thumb_path,
             source_type = EXCLUDED.source_type, sync_state = EXCLUDED.sync_state
           WHERE video_assets.updated_at < EXCLUDED.updated_at`,
          [asset.id, scope.workspaceId, asset.project_id, asset.chain_id, asset.kind, asset.version, asset.parent_id,
           asset.source_url, JSON.stringify(asset.provenance ?? {}), asset.license_risk, asset.hero_image_id, asset.sha256,
           JSON.stringify(asset.meta ?? {}), asset.status, asset.created_by,
           isoOf(asset.created_at) || new Date().toISOString(),
           isoOf(asset.updated_at) || new Date().toISOString(), asset.title ?? null, JSON.stringify(asset.tags ?? []),
           asset.prompt ?? null, asset.pipeline_kind ?? null, asset.duration_seconds ?? null, asset.width ?? null,
           asset.height ?? null, asset.thumb_path ?? null, asset.source_type ?? "generated",
           asset.sync_state ?? "cloud_only"]);
        return res.rowCount ?? 0;
      });
      if (written === 0) {
        result.conflicts.push({ table: "assets", id: asset.id, localUpdatedAt: isoOf(asset.updated_at), serverUpdatedAt: "", reason: "并发写入：比对后服务端又被更新，本次未落库" });
        continue;
      }
      result.applied.assets += written;
      await logSync(app, scope, { assetId: asset.id, direction: "pull", payloadKind: "metadata", bytes: JSON.stringify(asset).length, peer, status: "done" });
    } catch (err) {
      await recordFailure("assets", asset.id, err instanceof Error ? err.message : String(err));
    }
  }

  for (const collection of payload.collections ?? []) {
    const id = String(collection.id ?? "");
    if (!id) continue;
    try {
      const existing = await scopedQuery<{ updated_at: string }>(app, scope,
        `SELECT updated_at FROM media_collections WHERE workspace_id = $1 AND id = $2`, [scope.workspaceId, id]);
      const serverUpdatedAt = existing[0]?.updated_at ?? null;
      if (serverUpdatedAt && !newerThan(collection.updated_at, serverUpdatedAt)) {
        result.conflicts.push({ table: "collections", id, localUpdatedAt: isoOf(collection.updated_at), serverUpdatedAt: isoOf(serverUpdatedAt), reason: "服务端更新更晚" });
        continue;
      }
      const written = await rowTx(app, scope, async (client) => (await client.query(
        `INSERT INTO media_collections (id, workspace_id, title, purpose, meta, status, created_by, created_at, updated_at)
         VALUES ($1,$2,$3,$4,$5::jsonb,$6,$7,$8::timestamptz,$9::timestamptz)
         ON CONFLICT (id) DO UPDATE SET title = EXCLUDED.title, purpose = EXCLUDED.purpose,
           meta = EXCLUDED.meta, status = EXCLUDED.status
         WHERE media_collections.updated_at < EXCLUDED.updated_at`,
        [id, scope.workspaceId, String(collection.title ?? "未命名合集"), String(collection.purpose ?? "recut"),
         JSON.stringify(collection.meta ?? {}), String(collection.status ?? "open"),
         String(collection.created_by ?? peer), isoOf(collection.created_at) || new Date().toISOString(),
         isoOf(collection.updated_at) || new Date().toISOString()])).rowCount ?? 0);
      if (written === 0) {
        result.conflicts.push({ table: "collections", id, localUpdatedAt: isoOf(collection.updated_at), serverUpdatedAt: isoOf(serverUpdatedAt), reason: "并发写入：比对后服务端又被更新" });
        continue;
      }
      result.applied.collections += written;
      await logSync(app, scope, { assetId: id, direction: "pull", payloadKind: "metadata", bytes: JSON.stringify(collection).length, peer, status: "done" });
    } catch (err) {
      await recordFailure("collections", id, err instanceof Error ? err.message : String(err));
    }
  }

  for (const item of payload.items ?? []) {
    const collectionId = String(item.collection_id ?? "");
    const assetId = String(item.asset_id ?? "");
    const itemKey = `${collectionId}/${assetId}`;
    if (!collectionId || !assetId) continue;
    try {
      const existing = await scopedQuery<{ updated_at: string }>(app, scope,
        `SELECT updated_at FROM media_collection_items
          WHERE workspace_id = $1 AND collection_id = $2 AND asset_id = $3`,
        [scope.workspaceId, collectionId, assetId]);
      const serverUpdatedAt = existing[0]?.updated_at ?? null;
      if (serverUpdatedAt && !newerThan(item.updated_at, serverUpdatedAt)) {
        result.conflicts.push({ table: "items", id: itemKey, localUpdatedAt: isoOf(item.updated_at), serverUpdatedAt: isoOf(serverUpdatedAt), reason: "合集条目顺序冲突（seq 以服务端为准，人工确认）" });
        continue;
      }
      const assetExists = await scopedQuery<{ id: string }>(app, scope,
        `SELECT id FROM video_assets WHERE workspace_id = $1 AND id = $2`, [scope.workspaceId, assetId]);
      if (assetExists.length === 0) {
        result.conflicts.push({ table: "items", id: itemKey, localUpdatedAt: isoOf(item.updated_at), serverUpdatedAt: isoOf(serverUpdatedAt), reason: "素材行未同步到位（先推 assets 再推 items）" });
        continue;
      }
      const written = await rowTx(app, scope, async (client) => (await client.query(
        `INSERT INTO media_collection_items (collection_id, workspace_id, asset_id, seq, note, added_by, added_at, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7::timestamptz,$8::timestamptz)
         ON CONFLICT (collection_id, asset_id) DO UPDATE SET seq = EXCLUDED.seq, note = EXCLUDED.note
         WHERE media_collection_items.updated_at < EXCLUDED.updated_at`,
        [collectionId, scope.workspaceId, assetId, Number(item.seq ?? 0), item.note ?? null,
         String(item.added_by ?? peer), isoOf(item.added_at) || new Date().toISOString(),
         isoOf(item.updated_at) || new Date().toISOString()])).rowCount ?? 0);
      if (written === 0) {
        result.conflicts.push({ table: "items", id: itemKey, localUpdatedAt: isoOf(item.updated_at), serverUpdatedAt: isoOf(serverUpdatedAt), reason: "并发写入：比对后服务端又被更新" });
        continue;
      }
      result.applied.items += written;
      await logSync(app, scope, { assetId, direction: "pull", payloadKind: "metadata", bytes: JSON.stringify(item).length, peer, status: "done" });
    } catch (err) {
      await recordFailure("items", itemKey, err instanceof Error ? err.message : String(err));
    }
  }

  for (const product of payload.products ?? []) {
    const id = String(product.id ?? "");
    if (!id) continue;
    try {
      const existing = await scopedQuery<{ updated_at: string }>(app, scope,
        `SELECT updated_at FROM media_product_profiles WHERE workspace_id = $1 AND id = $2`, [scope.workspaceId, id]);
      const serverUpdatedAt = existing[0]?.updated_at ?? null;
      if (serverUpdatedAt && !newerThan(product.updated_at, serverUpdatedAt)) {
        result.conflicts.push({ table: "products", id, localUpdatedAt: isoOf(product.updated_at), serverUpdatedAt: isoOf(serverUpdatedAt), reason: "服务端更新更晚" });
        continue;
      }
      const written = await rowTx(app, scope, async (client) => (await client.query(
        `INSERT INTO media_product_profiles
           (id, workspace_id, product_name, dossier_product_id, dossier_path, dossier_sha256, summary, hero_asset_id, status, created_at, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9,$10::timestamptz,$11::timestamptz)
         ON CONFLICT (id) DO UPDATE SET product_name = EXCLUDED.product_name,
           dossier_product_id = COALESCE(EXCLUDED.dossier_product_id, media_product_profiles.dossier_product_id),
           dossier_path = EXCLUDED.dossier_path,
           dossier_sha256 = EXCLUDED.dossier_sha256, summary = EXCLUDED.summary,
           hero_asset_id = EXCLUDED.hero_asset_id, status = EXCLUDED.status
         WHERE media_product_profiles.updated_at < EXCLUDED.updated_at`,
        [id, scope.workspaceId, String(product.product_name ?? "未命名商品"),
         product.dossier_product_id ? String(product.dossier_product_id) : null,
         String(product.dossier_path ?? ""), String(product.dossier_sha256 ?? ""), JSON.stringify(product.summary ?? {}),
         product.hero_asset_id ?? null, String(product.status ?? "active"),
         isoOf(product.created_at) || new Date().toISOString(),
         isoOf(product.updated_at) || new Date().toISOString()])).rowCount ?? 0);
      if (written === 0) {
        result.conflicts.push({ table: "products", id, localUpdatedAt: isoOf(product.updated_at), serverUpdatedAt: isoOf(serverUpdatedAt), reason: "并发写入：比对后服务端又被更新" });
        continue;
      }
      result.applied.products += written;
      await logSync(app, scope, { assetId: id, direction: "pull", payloadKind: "metadata", bytes: JSON.stringify(product).length, peer, status: "done" });
    } catch (err) {
      await recordFailure("products", id, err instanceof Error ? err.message : String(err));
    }
  }

  return result;
}

/* ================= 文件按需拉取（desktop 侧） ================= */

export interface EnsureFileResult {
  ok: boolean;
  localPath?: string;
  bytes?: number;
  error?: string;
  alreadyPresent?: boolean;
}

/**
 * 素材文件按需拉取：本地媒体仓没有 → 用云端签发的同源地址取回 → **校验 sha256** 才认账。
 * 校验失败即删除半成品并记 failed 台账（不留"看起来有文件"的假象）。
 */
export async function ensureAssetFile(
  app: AppPool, scope: Scope,
  input: {
    assetId: string;
    cloudBaseUrl: string;
    remoteUrl: string;
    peer?: string;
    env?: NodeJS.ProcessEnv;
    fetchImpl?: typeof fetch;
  },
): Promise<EnsureFileResult> {
  const rows = await scopedQuery<{ id: string; sha256: string; local_path: string | null; sync_state: string }>(
    app, scope,
    `SELECT id, sha256, meta->>'localPath' AS local_path, sync_state FROM video_assets
      WHERE workspace_id = $1 AND id = $2`,
    [scope.workspaceId, input.assetId]);
  const asset = rows[0];
  if (!asset) return { ok: false, error: `素材 ${input.assetId} 不在本工作区` };
  if (!asset.local_path) return { ok: false, error: "该素材没有 localPath（不是本地媒体仓产物）" };

  const abs = resolveInside(mediaRoot(input.env), asset.local_path, "拉取路径");
  if (existsSync(abs) && (await sha256File(abs)) === asset.sha256) {
    await scopedQuery(app, scope,
      `UPDATE video_assets SET sync_state = 'synced' WHERE workspace_id = $1 AND id = $2`,
      [scope.workspaceId, input.assetId]);
    return { ok: true, localPath: asset.local_path, alreadyPresent: true };
  }

  const fetchImpl = input.fetchImpl ?? fetch;
  const base = input.cloudBaseUrl.replace(/\/$/, "");
  const url = /^https?:\/\//.test(input.remoteUrl) ? input.remoteUrl : `${base}${input.remoteUrl}`;
  const tmp = join(mediaRoot(input.env), ".sync-tmp", `${input.assetId}-${Date.now()}.part`);
  mkdirSync(dirname(tmp), { recursive: true });
  try {
    const res = await fetchImpl(url);
    if (!res.ok) throw new Error(`文件拉取失败：HTTP ${res.status}`);
    const buf = Buffer.from(await res.arrayBuffer());
    writeFileSync(tmp, buf);
    const actual = await sha256File(tmp);
    if (actual !== asset.sha256) {
      const { rmSync } = await import("node:fs");
      rmSync(tmp, { force: true });
      await logSync(app, scope, {
        assetId: input.assetId, direction: "pull", payloadKind: "file", bytes: buf.byteLength,
        peer: input.peer ?? "cloud", status: "failed", error: `sha256 不一致（期望 ${asset.sha256.slice(0, 12)}… 实算 ${actual.slice(0, 12)}…）`,
      });
      return { ok: false, error: "sha256 校验失败（已丢弃下载文件）" };
    }
    mkdirSync(dirname(abs), { recursive: true });
    renameSync(tmp, abs);
    await scopedQuery(app, scope,
      `UPDATE video_assets SET sync_state = 'synced', meta = meta || $3::jsonb
        WHERE workspace_id = $1 AND id = $2`,
      [scope.workspaceId, input.assetId, JSON.stringify({ fetchedAt: new Date().toISOString() })]);
    await logSync(app, scope, {
      assetId: input.assetId, direction: "pull", payloadKind: "file", bytes: buf.byteLength,
      peer: input.peer ?? "cloud", status: "done",
    });
    return { ok: true, localPath: asset.local_path, bytes: buf.byteLength };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await logSync(app, scope, {
      assetId: input.assetId, direction: "pull", payloadKind: "file", bytes: 0,
      peer: input.peer ?? "cloud", status: "failed", error: message,
    });
    return { ok: false, error: message };
  }
}

/* ================= 转储工具：把 sync 行投影成可读摘要（对账与验收用） ================= */

export interface ReconcileReport {
  since: string | null;
  counts: Record<SyncTable, number>;
  cursor: string;
  shaMismatch: Array<{ id: string; localSha: string; remoteSha: string }>;
  missingLocalFiles: string[];
}

/**
 * 对账（夜班巡检口径）：比较本地与云端 `(id, sha256, updated_at)` 集合。
 * 调用方传入"云端拉回的同一批行"，本函数只做集合比较——不猜、不修，把漂移如实列出。
 */
export async function reconcile(
  app: AppPool, scope: Scope,
  remote: SyncPullPayload,
): Promise<ReconcileReport> {
  const local = await scopedQuery<{ id: string; sha256: string; local_path: string | null }>(app, scope,
    `SELECT id, sha256, meta->>'localPath' AS local_path FROM video_assets WHERE workspace_id = $1`,
    [scope.workspaceId]);
  const localById = new Map(local.map((row) => [row.id, row]));
  const shaMismatch: ReconcileReport["shaMismatch"] = [];
  const missingLocalFiles: string[] = [];
  for (const asset of remote.assets) {
    const mine = localById.get(asset.id);
    if (!mine) continue;
    if (mine.sha256 !== asset.sha256) {
      shaMismatch.push({ id: asset.id, localSha: mine.sha256, remoteSha: asset.sha256 });
    } else if (mine.local_path && !existsSync(join(mediaRoot(), mine.local_path))) {
      missingLocalFiles.push(asset.id);
    }
  }
  return {
    since: remote.since,
    cursor: remote.cursor,
    counts: {
      assets: remote.assets.length,
      collections: remote.collections.length,
      items: remote.items.length,
      products: remote.products.length,
    },
    shaMismatch,
    missingLocalFiles,
  };
}
