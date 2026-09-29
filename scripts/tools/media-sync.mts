#!/usr/bin/env tsx
/**
 * media-sync.mts —— 媒资云端同步 CLI（T-2026-0926-0009 规格书 §7.2 的 desktop 侧）
 *
 * 子命令：
 *   enroll    写入设备凭证 `var/sync/device.json`（0600；deviceKey 只在登记响应里出现一次）
 *   push      本地 → 云端：推送 `sync_state IN ('local_only','conflict')` 或 updated_at 领先的行（四表）
 *   pull      云端 → 本地：按 updated_at 游标增量拉取，LWW 合并（复用服务端同一 `applyPush`）
 *   fetch     按需拉文件：`/sync/media/url` 取新鲜签名地址 → 落本地同路径 → **sha256 校验通过才认账**
 *   reconcile 对账：比较双边 sha256 集合，列出漂移与缺失文件（夜班巡检口径）
 *   status    设备与台账概览
 *
 * 用法（desktop 实例）：
 *   pnpm exec tsx --env-file=.env scripts/tools/media-sync.mts enroll \
 *     --url https://cloud.example.com --device SD-xxxx --key <deviceKey> --workspace ws-video
 *   pnpm exec tsx --env-file=.env scripts/tools/media-sync.mts pull && … push
 */
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import pg from "pg";
import {
  applyPush, bodyHash, changesSince, deviceSignature, ensureAssetFile, listSyncLog, reconcile,
  type SyncPullPayload,
} from "../../apps/server/src/video/media/sync.js";

function loadDotEnvIfNeeded(): void {
  if (process.env.DATABASE_URL) return;
  const file = resolve(import.meta.dirname ?? process.cwd(), "../../.env");
  if (!existsSync(file)) return;
  for (const line of readFileSync(file, "utf8").split("\n")) {
    const matched = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line.trim());
    if (!matched) continue;
    const [, key, raw] = matched;
    if (process.env[key!] !== undefined) continue;
    process.env[key!] = raw!.replace(/^"(.*)"$/, "$1");
  }
}

function arg(name: string, fallback = ""): string {
  const index = process.argv.indexOf(name);
  return index >= 0 ? (process.argv[index + 1] ?? fallback) : fallback;
}
const flag = (name: string) => process.argv.includes(name);

loadDotEnvIfNeeded();
const DATABASE_URL = process.env.DATABASE_URL ?? "";
if (!DATABASE_URL) {
  console.error("缺少 DATABASE_URL（用 `pnpm exec tsx --env-file=.env …` 或在 .env 里配置）");
  process.exit(2);
}
const REPO_ROOT = resolve(import.meta.dirname ?? process.cwd(), "../..");
const DEVICE_FILE = process.env.WORKLOOM_SYNC_DEVICE_FILE?.trim() || join(REPO_ROOT, "var/sync/device.json");

interface DeviceFile {
  deviceId: string;
  deviceKey: string;
  workspaceId: string;
  cloudUrl: string;
  lastPullCursor: string | null;
  lastPushCursor: string | null;
  updatedAt: string;
}

function readDevice(): DeviceFile | null {
  if (!existsSync(DEVICE_FILE)) return null;
  try {
    return JSON.parse(readFileSync(DEVICE_FILE, "utf8")) as DeviceFile;
  } catch {
    return null;
  }
}

function writeDevice(device: DeviceFile): void {
  mkdirSync(dirname(DEVICE_FILE), { recursive: true });
  writeFileSync(DEVICE_FILE, `${JSON.stringify(device, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  try { chmodSync(DEVICE_FILE, 0o600); } catch { /* Windows 等平台无 chmod 语义，忽略 */ }
}

const app = new pg.Pool({ connectionString: process.env.DATABASE_APP_URL ?? DATABASE_URL });
const owner = new pg.Pool({ connectionString: DATABASE_URL });

async function scopeOfWorkspace(workspaceId: string): Promise<{ tenantId: string; workspaceId: string }> {
  const rows = await owner.query<{ tenant_id: string }>(`SELECT tenant_id FROM workspaces WHERE id = $1`, [workspaceId]);
  const tenantId = rows.rows[0]?.tenant_id;
  if (!tenantId) throw new Error(`工作区 ${workspaceId} 不存在（先在该实例完成迁移与种子）`);
  return { tenantId, workspaceId };
}

async function signedFetch(
  device: DeviceFile, method: "GET" | "POST", pathWithQuery: string, body = "",
): Promise<unknown> {
  const timestamp = Date.now().toString();
  const signature = deviceSignature({
    method, path: pathWithQuery, timestamp, bodySha256: bodyHash(body),
  }, device.deviceKey);
  const res = await fetch(`${device.cloudUrl.replace(/\/$/, "")}${pathWithQuery}`, {
    method,
    headers: {
      "x-workloom-device": device.deviceId,
      "x-workloom-timestamp": timestamp,
      "x-workloom-signature": signature,
      ...(body ? { "content-type": "application/json" } : {}),
    },
    ...(body ? { body } : {}),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`云端返回 ${res.status}：${text.slice(0, 300)}`);
  return text ? JSON.parse(text) : null;
}

const command = process.argv[2] ?? "";
const device = readDevice();

try {
  if (command === "enroll") {
    const workspaceId = arg("--workspace") || device?.workspaceId || "";
    const cloudUrl = arg("--url") || device?.cloudUrl || "";
    const deviceId = arg("--device") || "";
    const deviceKey = arg("--key") || "";
    if (!workspaceId || !cloudUrl || !deviceId || !deviceKey) {
      throw new Error("enroll 需要 --url / --device / --key / --workspace（key 由云端 video.media.sync.enroll 一次性签发）");
    }
    writeDevice({
      deviceId, deviceKey, workspaceId, cloudUrl,
      lastPullCursor: device?.lastPullCursor ?? null,
      lastPushCursor: device?.lastPushCursor ?? null,
      updatedAt: new Date().toISOString(),
    });
    console.log(`设备凭证已写入 ${DEVICE_FILE}（权限 600）；再次确认云端可见该设备：media-sync status`);
  } else if (command === "status") {
    if (!device) {
      console.log(`未登记设备（${DEVICE_FILE} 不存在）：先跑 enroll`);
    } else {
      const scope = await scopeOfWorkspace(device.workspaceId);
      const { entries: log } = await listSyncLog(app, scope, 10);
      console.log(`设备：${device.deviceId} → ${device.cloudUrl}（工作区 ${device.workspaceId}）`);
      console.log(`游标：pull=${device.lastPullCursor ?? "—"} push=${device.lastPushCursor ?? "—"}`);
      console.log(`最近台账：${log.length} 条`);
      for (const row of log) console.log(`  ${row.createdAt} ${row.direction}/${row.payloadKind} ${row.status} ${row.assetId}${row.error ? ` · ${row.error}` : ""}`);
    }
  } else if (command === "push") {
    if (!device) throw new Error("未登记设备：先跑 enroll");
    const scope = await scopeOfWorkspace(device.workspaceId);
    const sinceIso = device.lastPushCursor ?? "1970-01-01T00:00:00.000Z";
    const local = await owner.query(
      `SELECT id, project_id, chain_id, kind, version, parent_id, source_url, provenance, license_risk,
              hero_image_id, sha256, meta, status, created_by, created_at, updated_at, title, tags, prompt,
              pipeline_kind, duration_seconds, width, height, thumb_path, source_type, sync_state
         FROM video_assets
        WHERE workspace_id = $1 AND (updated_at > $2::timestamptz OR sync_state IN ('local_only','conflict'))
        ORDER BY updated_at ASC LIMIT 500`,
      [device.workspaceId, sinceIso]);
    const collections = await owner.query(
      `SELECT id, title, purpose, meta, status, created_by, created_at, updated_at
         FROM media_collections WHERE workspace_id = $1 AND updated_at > $2::timestamptz
        ORDER BY updated_at ASC LIMIT 500`,
      [device.workspaceId, sinceIso]);
    const items = await owner.query(
      `SELECT collection_id, asset_id, seq, note, added_by, added_at, updated_at
         FROM media_collection_items WHERE workspace_id = $1 AND updated_at > $2::timestamptz
        ORDER BY updated_at ASC LIMIT 500`,
      [device.workspaceId, sinceIso]);
    const products = await owner.query(
      `SELECT id, product_name, dossier_path, dossier_sha256, summary, hero_asset_id, status, created_at, updated_at
         FROM media_product_profiles WHERE workspace_id = $1 AND updated_at > $2::timestamptz
        ORDER BY updated_at ASC LIMIT 500`,
      [device.workspaceId, sinceIso]);
    const payload = {
      assets: local.rows,
      collections: collections.rows,
      items: items.rows,
      products: products.rows,
    };
    const body = JSON.stringify(payload);
    const result = await signedFetch(device, "POST", "/sync/media/push", body) as {
      applied: Record<string, number>; conflicts: Array<{ table: string; id: string; reason: string }>;
    };
    const conflictsByTable = new Map<string, Set<string>>();
    for (const conflict of result.conflicts) {
      const set = conflictsByTable.get(conflict.table) ?? new Set<string>();
      set.add(conflict.id);
      conflictsByTable.set(conflict.table, set);
    }
    const assetConflicts = conflictsByTable.get("assets") ?? new Set<string>();
    for (const row of local.rows) {
      const nextState = assetConflicts.has(row.id) ? "conflict" : "synced";
      await owner.query(`UPDATE video_assets SET sync_state = $3 WHERE workspace_id = $1 AND id = $2`,
        [device.workspaceId, row.id, nextState]);
    }
    writeDevice({ ...device, lastPushCursor: new Date().toISOString(), updatedAt: new Date().toISOString() });
    console.log(`push 完成：assets ${result.applied.assets ?? 0} / collections ${result.applied.collections ?? 0} / items ${result.applied.items ?? 0} / products ${result.applied.products ?? 0}`);
    if (result.conflicts.length > 0) {
      console.log(`冲突 ${result.conflicts.length} 条（本地已置 conflict，保留双份元数据待人工合并）：`);
      for (const conflict of result.conflicts.slice(0, 10)) console.log(`  ${conflict.table} ${conflict.id}：${conflict.reason}`);
    }
  } else if (command === "pull") {
    if (!device) throw new Error("未登记设备：先跑 enroll");
    const scope = await scopeOfWorkspace(device.workspaceId);
    const since = arg("--since") || device.lastPullCursor || "";
    const limit = arg("--limit", "500");
    const query = `/sync/media/pull?limit=${encodeURIComponent(limit)}${since ? `&since=${encodeURIComponent(since)}` : ""}`;
    const payload = await signedFetch(device, "GET", query) as SyncPullPayload;
    /**
     * 拉回的行默认是"云端有、本地还没文件"：sync_state 统一降为 cloud_only，
     * 文件按需拉取成功（sha256 校验通过）后才会被置回 synced。
     */
    const normalized = {
      ...payload,
      assets: (payload.assets ?? []).map((asset) => ({ ...asset, sync_state: "cloud_only" })),
    };
    const applied = await applyPush(app, scope, normalized, "cloud");
    writeDevice({ ...device, lastPullCursor: payload.cursor, updatedAt: new Date().toISOString() });
    console.log(`pull 完成：assets ${applied.applied.assets} / collections ${applied.applied.collections} / items ${applied.applied.items} / products ${applied.applied.products}（游标 ${payload.cursor}${payload.hasMore ? "，还有更多变更" : ""}）`);
    if (applied.conflicts.length > 0) {
      console.log(`冲突 ${applied.conflicts.length} 条（本地更新更晚，未覆盖）：`);
      for (const conflict of applied.conflicts.slice(0, 10)) console.log(`  ${conflict.table} ${conflict.id}：${conflict.reason}`);
    }
  } else if (command === "fetch") {
    if (!device) throw new Error("未登记设备：先跑 enroll");
    const scope = await scopeOfWorkspace(device.workspaceId);
    const assetId = arg("--asset");
    if (!assetId) throw new Error("fetch 需要 --asset <assetId>");
    const signed = await signedFetch(device, "GET", `/sync/media/url?assetId=${encodeURIComponent(assetId)}`) as { url: string };
    const result = await ensureAssetFile(app, scope, {
      assetId, cloudBaseUrl: device.cloudUrl, remoteUrl: signed.url, peer: device.deviceId,
    });
    console.log(result.ok
      ? `文件就位：${result.localPath}${result.alreadyPresent ? "（本地已有且 sha256 一致）" : `（拉取 ${result.bytes} 字节，sha256 校验通过）`}`
      : `拉取失败：${result.error}`);
    if (!result.ok) process.exitCode = 1;
  } else if (command === "reconcile") {
    if (!device) throw new Error("未登记设备：先跑 enroll");
    const scope = await scopeOfWorkspace(device.workspaceId);
    const since = arg("--since") || "1970-01-01T00:00:00.000Z";
    const payload = await signedFetch(device, "GET", `/sync/media/pull?limit=1000&since=${encodeURIComponent(since)}`) as SyncPullPayload;
    const report = await reconcile(app, scope, payload);
    console.log(`对账：本地/云端资产 ${report.counts.assets} 条（collections ${report.counts.collections} / items ${report.counts.items} / products ${report.counts.products}）`);
    console.log(`sha256 漂移：${report.shaMismatch.length} 条${report.shaMismatch.length ? ` → ${report.shaMismatch.slice(0, 5).map((m) => m.id).join("、")}` : ""}`);
    console.log(`缺失本地文件：${report.missingLocalFiles.length} 条${report.missingLocalFiles.length ? ` → ${report.missingLocalFiles.slice(0, 5).join("、")}` : ""}`);
    if (report.shaMismatch.length > 0) process.exitCode = 2;
  } else if (command === "changes") {
    if (!device) throw new Error("未登记设备：先跑 enroll");
    const scope = await scopeOfWorkspace(device.workspaceId);
    const payload = await changesSince(app, scope, { since: arg("--since") || null, limit: Number(arg("--limit", "100")) || 100 });
    console.log(JSON.stringify({
      cursor: payload.cursor, hasMore: payload.hasMore,
      counts: {
        assets: payload.assets.length, collections: payload.collections.length,
        items: payload.items.length, products: payload.products.length,
      },
    }, null, 2));
  } else {
    console.log([
      "用法：media-sync.mts <enroll|status|push|pull|fetch|reconcile|changes> [选项]",
      "",
      "  enroll    --url <cloudUrl> --device <deviceId> --key <deviceKey> --workspace <wsId>",
      "  status",
      "  push      [--limit 500]",
      "  pull      [--since <iso>] [--limit 500]",
      "  fetch     --asset <assetId>",
      "  reconcile [--since <iso>]",
      "  changes   [--since <iso>] [--limit 100]",
      "",
      `设备凭证文件：${DEVICE_FILE}（可用 WORKLOOM_SYNC_DEVICE_FILE 覆盖）`,
    ].join("\n"));
    if (flag("--json")) console.log(JSON.stringify({ deviceFile: DEVICE_FILE, registered: Boolean(device) }));
  }
} catch (err) {
  console.error(`media-sync 失败：${err instanceof Error ? err.message : String(err)}`);
  process.exitCode = 1;
} finally {
  await app.end().catch(() => undefined);
  await owner.end().catch(() => undefined);
}
