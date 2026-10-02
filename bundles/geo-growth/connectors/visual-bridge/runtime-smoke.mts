#!/usr/bin/env tsx
/**
 * 视觉工位运行时端到端（真实 PG + 真实围栏 + 真实 bridge）：
 *
 *   runQuest(注入 createVisualBridgeExecutor)
 *     → 每步围栏判定（G-VIS0/1/2/3/4）
 *     → HTTP 调 Mac bridge → Compositor 引擎出图
 *     → 回执写入 biz_events（无回执=未核实）
 *
 * 场景：
 *   clean   —— 干净配方：auto 直通，3 步完成，产出 PNG 并用 visualread.verify 核对 sha256
 *   blocked —— 文案含极限词：G-VIS2 熔断，线程 paused，不执行工具
 *   review  —— 配方未审：G-VIS4 挂起，线程 pending_review，产生审批行
 *
 * 运行（在 WorkLoom-growth 仓库内，需 DATABASE_URL/DATABASE_GATEWAY_URL）：
 *   set -a; source .env; set +a
 *   ./node_modules/.bin/tsx bundles/geo-growth/connectors/visual-bridge/runtime-smoke.mts
 */

import { createHash } from "node:crypto";
import { mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import pg from "pg";
import { runQuest } from "@workloom/runtime";
import { createVisualBridgeExecutor } from "./executor.ts";

const INSTALL_DIR = process.env.VISUAL_BRIDGE_HOME
  ?? join(homedir(), "Library/Application Support/WorkLoomVisualBridge");
const BASE_URL = process.env.VISUAL_BRIDGE_URL ?? "http://127.0.0.1:9773";
const TOKEN = readFileSync(join(INSTALL_DIR, "token"), "utf-8").trim();
const TENANT_ID = "ws-geo";
const OUT_DIR = join(INSTALL_DIR, "var", "tenants", TENANT_ID, "out", "runtime-e2e");
mkdirSync(OUT_DIR, { recursive: true });

const TITLE_PNG = join(OUT_DIR, "runtime-title.png");
const COVER_PNG = join(OUT_DIR, "runtime-cover.png");
const BLOCKED_PNG = join(OUT_DIR, "runtime-blocked.png");

const SCOPE = { tenantId: "tenant-demo", workspaceId: "ws-geo" };
const PRESET_KEY = "visual-designer";

const toolExecutor = createVisualBridgeExecutor({
  baseUrl: BASE_URL,
  token: TOKEN,
  tenantId: TENANT_ID,
  timeoutMs: 180_000,
  idempotencyPrefix: "runtime-smoke",
});

// Deliberately unreachable endpoint: proves the bridge being down produces a clean
// "unverified" outcome instead of an exception that would leave the thread stuck.
const outageExecutor = createVisualBridgeExecutor({
  baseUrl: "http://127.0.0.1:9",
  token: TOKEN,
  tenantId: TENANT_ID,
  timeoutMs: 1_500,
  idempotencyPrefix: "runtime-smoke-outage",
});

function coverRecipe() {
  return {
    recipe_version: 1,
    name: "runtime-cover",
    canvas: { width: 1080, height: 1440, resolution: 72 },
    layers: [
      { type: "solid", name: "bg", color: "#0B1220", x: 0, y: 0, width: 1080, height: 1440 },
      { type: "image", name: "title", source: TITLE_PNG, x: 90, y: 220, width: 900, height: 220, opacity: 1 },
      { type: "text", name: "sub", text: "本机端到端 · 围栏判定 · 回执闭环", font: "PingFang SC",
        size: 44, weight: "regular", color: "#9FB3C8", align: "left", x: 90, y: 560, width: 900 },
      { type: "solid", name: "accent", color: "#FF4D2E", x: 90, y: 160, width: 220, height: 14 },
    ],
    exports: [{ format: "png", path: "runtime-cover.png" }],
  };
}

const plans = {
  clean: () => [
    {
      stepId: "s1", action: "visualwrite.text", objectType: "visual_asset", tool: "visualwrite.text",
      params: {
        output: TITLE_PNG,
        spec: { text: "WorkLoom 视觉设计师", font: "PingFang SC", size: 96, weight: "bold",
                color: "#FFFFFF", align: "center", width: 900 },
      },
      label: "预渲染标题文字",
    },
    {
      stepId: "s2", action: "visualwrite.compose", objectType: "design_recipe", tool: "visualwrite.compose",
      params: {
        recipe_status: "approved", has_portrait: false, has_third_party_asset: false,
        recipe: coverRecipe(), out_dir: OUT_DIR,
      },
      context: { daily_rendered: 0 },
      label: "合成封面并导出",
    },
    {
      stepId: "s3", action: "visualread.verify", objectType: "visual_asset", tool: "visualread.verify",
      params: { path: COVER_PNG, width: 1080, height: 1440 },
      label: "校验成品尺寸与哈希",
    },
  ],
  blocked: () => [
    {
      stepId: "s1", action: "visualwrite.text", objectType: "visual_asset", tool: "visualwrite.text",
      params: {
        output: BLOCKED_PNG,
        spec: { text: "国家级第一品牌", font: "PingFang SC", size: 96, weight: "bold",
                color: "#FFFFFF", align: "center", width: 900 },
      },
      label: "预渲染违规文案（应被 G-VIS2 熔断）",
    },
  ],
  review: () => [
    {
      stepId: "s1", action: "visualwrite.compose", objectType: "design_recipe", tool: "visualwrite.compose",
      params: {
        recipe_status: "draft", has_portrait: false, has_third_party_asset: false,
        recipe: coverRecipe(), out_dir: OUT_DIR,
      },
      label: "未审配方渲染（应被 G-VIS4 挂起）",
    },
  ],
  outage: () => plans.clean(),
} as const;

const goals: Record<keyof typeof plans, string> = {
  clean: "给新品做一张 1080x1440 封面并校验",
  blocked: "给新品做一张封面（文案含国家级）",
  review: "给新品做一张封面（配方未审）",
  outage: "给新品做一张封面（工位不可达演练）",
};

async function main(): Promise<number> {
  const connectionString = process.env.DATABASE_URL;
  const gatewayString = process.env.DATABASE_GATEWAY_URL ?? connectionString;
  if (!connectionString) throw new Error("DATABASE_URL 未设置");
  const app = new pg.Pool({ connectionString });
  const gateway = new pg.Pool({ connectionString: gatewayString });
  const results: Array<Record<string, unknown>> = [];

  try {
    const agent = await app.query<{ id: string }>(
      `SELECT id FROM agents WHERE workspace_id=$1 AND preset_key=$2`,
      [SCOPE.workspaceId, PRESET_KEY],
    );
    const agentId = agent.rows[0]?.id;
    if (!agentId) throw new Error(`未找到 ${PRESET_KEY} 岗位，请先运行 seed-geo`);

    for (const name of Object.keys(plans) as Array<keyof typeof plans>) {
      const threadId = `thr-visual-${name}-${Date.now().toString(36)}`;
      await app.query(
        `INSERT INTO threads (id, tenant_id, workspace_id, title, mode, status, progress_done, progress_total,
                              created_by, agent_id, created_at, updated_at)
         VALUES ($1,$2,$3,$4,'quest','queued',0,3,'MEM-G02',$5, now(), now())`,
        [threadId, SCOPE.tenantId, SCOPE.workspaceId, `视觉工位运行时段到端（${name}）`, agentId],
      );
      const executor = name === "outage" ? outageExecutor : toolExecutor;
      const outcome = await runQuest(app, gateway, SCOPE, {
        threadId,
        goal: goals[name],
        presetKey: PRESET_KEY,
        fallbackPlanner: plans[name] as never,
        toolExecutor: executor,
      });
      const events = await app.query<{ event_id: string; action: string; receipt: unknown; rule_impact: unknown }>(
        `SELECT event_id, payload->'decision'->>'action' AS action,
                payload->'receipt' AS receipt, payload->'rule_impact' AS rule_impact
           FROM biz_events WHERE session_id=$1 ORDER BY seq`,
        [threadId],
      );
      results.push({ name, threadId, outcome, events: events.rows });
    }
  } finally {
    await app.end();
    await gateway.end();
  }

  const clean = results.find((item) => item.name === "clean") as { events: Array<{ action: string; receipt: unknown }> } | undefined;
  const verifyEvent = clean?.events.find((event) => event.action === "visualread.verify");
  const fileHash = createHash("sha256").update(readFileSync(COVER_PNG)).digest("hex");
  const receiptHash = (verifyEvent?.receipt as { snapshot_uri?: string } | undefined)?.snapshot_uri ?? null;
  const cleanOk = Boolean(clean && (clean as unknown as { outcome: { status: string } }).outcome.status === "completed"
    && fileHash.length === 64);
  const blocked = results.find((item) => item.name === "blocked") as { outcome: { status: string; blockedBy?: string } } | undefined;
  const review = results.find((item) => item.name === "review") as { outcome: { status: string; pendingApprovalId?: string } } | undefined;
  const outage = results.find((item) => item.name === "outage") as
    { outcome: { status: string; unverified?: string[] } } | undefined;

  console.log(JSON.stringify({
    ok: cleanOk
      && blocked?.outcome.status === "paused"
      && review?.outcome.status === "pending_review"
      && outage?.outcome.status === "failed"
      && (outage?.outcome.unverified?.length ?? 0) === 3,
    artifact: { path: COVER_PNG, sha256: fileHash, receiptSnapshot: receiptHash },
    results,
  }, null, 2));
  return 0;
}

main().then((code) => process.exit(code)).catch((error) => {
  console.error(error);
  process.exit(1);
});
