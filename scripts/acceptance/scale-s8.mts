#!/usr/bin/env node
/**
 * acceptance:scale-s8 · S8「300 账号矩阵」压力验收（《GROWTH 深度产品方案》§8）
 *
 * 压测对象：L2 裁决队列（账号矩阵的服务压力集中在审批队列与决策节拍）。
 * 流程：开户 → 放开本夹具报价带 → 造 300 条待审（带内价格动作）→ 连跑 CEO 队列节拍至排空
 *      → 记录每拍耗时 p50/p95、裁决量、上浮量 → 清理夹具。
 * 判定：300 条在 ≤20 拍内排空（每拍上限 20），且无异常。
 *
 * 运行：pnpm acceptance:scale-s8 [--accounts 300] [--max-beats 20] [--json]
 */
import pg from "pg";
import { provisionShadowWorkspace, loadCharter, saveCharter, runQueueBeat } from "@workloom/base/captain";

const arg = (n: string, f: string) => {
  const i = process.argv.indexOf(n);
  return i >= 0 ? process.argv[i + 1]! : f;
};
const JSON_OUT = process.argv.includes("--json");
const COUNT = Number(arg("--accounts", "300"));
const MAX_BEATS = Number(arg("--max-beats", "20"));
const DATABASE_URL = process.env.DATABASE_URL ?? "postgres://postgres:workloom@localhost:5432/workloom";

const app = new pg.Pool({ connectionString: DATABASE_URL, max: 6 });
const suffix = Date.now().toString(36);
const tenantId = `tn-s8-${suffix}`;
const workspaceId = `ws-s8-${suffix}`;
const scope = { tenantId, workspaceId };

async function inTx<T>(fn: (c: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await app.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT set_config('app.workspace_id', $1, true)", [workspaceId]);
    await client.query("SELECT set_config('app.tenant_id', $1, true)", [tenantId]);
    const out = await fn(client);
    await client.query("COMMIT");
    return out;
  } catch (e) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw e;
  } finally {
    client.release();
  }
}

function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[idx]!;
}

try {
  await provisionShadowWorkspace(app, {
    tenantId, workspaceId, workspaceName: `S8 压测 · ${COUNT} 账号`,
    slug: workspaceId, primaryBundle: "geo-growth", by: "acceptance:scale-s8",
  });
  await inTx(async (c) => {
    const charter = await loadCharter(app, scope);
    charter.autonomy.ranges.price_quote_band = { label: "压测报价带", lower: 0.9, upper: 1.1, anchor: 1 };
    await saveCharter(c, scope, charter);
  });
  const values: string[] = [];
  const params: unknown[] = [];
  for (let i = 0; i < COUNT; i += 1) {
    const b = params.length;
    values.push(`($${b + 1},$${b + 2},$${b + 3},$${b + 4},'inapp','pending',$${b + 5},'l2_captain')`);
    params.push(
      `apr-s8-${suffix}-${i}`, tenantId, workspaceId, `E-s8-${suffix}-${i}`,
      JSON.stringify({ action: "price.adjust", params: { price: 480 }, base_price: 458, title: `账号 #${i} 周末价带内调整` }),
    );
  }
  const tInsert = Date.now();
  await app.query(
    `INSERT INTO approvals (approval_id, tenant_id, workspace_id, event_id, channel, status, snapshot, tier)
     VALUES ${values.join(",")}`,
    params,
  );
  const insertMs = Date.now() - tInsert;

  let decided = 0, escalated = 0, beats = 0;
  const beatMs: number[] = [];
  for (; beats < MAX_BEATS; beats += 1) {
    const t = Date.now();
    const r = await runQueueBeat(app, scope);
    beatMs.push(Date.now() - t);
    decided += r.decided;
    escalated += r.escalated;
    if (decided + escalated >= COUNT) { beats += 1; break; }
  }
  const summary = {
    workspaceId, accounts: COUNT, insertMs, beats, decided, escalated,
    beatMs: { p50: percentile(beatMs, 50), p95: percentile(beatMs, 95), max: Math.max(...beatMs) },
    drained: decided + escalated >= COUNT,
  };
  if (JSON_OUT) console.log(JSON.stringify(summary, null, 2));
  else {
    console.log(`S8 压测（${COUNT} 条待审 / 模拟 ${COUNT} 账号矩阵）`);
    console.log(`- 造数：${insertMs}ms（批量 INSERT）`);
    console.log(`- 排空：${beats} 拍 · 裁决 ${decided} · 上浮 ${escalated}`);
    console.log(`- 每拍耗时：p50 ${summary.beatMs.p50}ms / p95 ${summary.beatMs.p95}ms / max ${summary.beatMs.max}ms`);
    console.log(summary.drained ? "✓ 队列在门限内排空" : "✗ 队列未排空（超出门限）");
  }
  await app.query(`DELETE FROM approvals WHERE workspace_id=$1`, [workspaceId]).catch(() => undefined);
  await app.query(`DELETE FROM agents WHERE workspace_id=$1`, [workspaceId]).catch(() => undefined);
  await app.query(`DELETE FROM fence_rules WHERE workspace_id=$1`, [workspaceId]).catch(() => undefined);
  await app.query(`DELETE FROM profiles WHERE workspace_id=$1`, [workspaceId]).catch(() => undefined);
  await app.query(`DELETE FROM workspaces WHERE id=$1`, [workspaceId]).catch(() => undefined);
  await app.query(`DELETE FROM tenants WHERE id=$1`, [tenantId]).catch(() => undefined);
  await app.end().catch(() => undefined);
  process.exit(summary.drained ? 0 : 1);
} catch (error) {
  console.error(`S8 压测失败：${(error as Error)?.stack ?? error}`);
  await app.end().catch(() => undefined);
  process.exit(1);
}
