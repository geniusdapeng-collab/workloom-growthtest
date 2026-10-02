#!/usr/bin/env tsx
/**
 * 视觉工位生产入口（growth 实验车道过渡方案，T-2026-0919-0010）。
 *
 * 在基座 ToolExecutor seam 落地前，本脚本就是 growth 的生产入口：
 * 直接调用 `runQuest` 并注入视觉工位执行器，不修改 `apps/server/src/**` 等基座文件。
 * 基座提案见 proposals/workloom-im/0001-deployment-tool-executor-seam.md（暂缓实施）。
 *
 * 用法：
 *   set -a; source .env; set +a
 *   ./node_modules/.bin/tsx scripts/visual-quest-runner.mts \
 *     --workspace ws-geo --goal "给新品做一张封面" --plan cover \
 *     [--out-dir <租户输出目录>] [--report report.json] [--json]
 *
 * 夜班批处理：
 *   ./node_modules/.bin/tsx scripts/visual-quest-runner.mts --batch jobs.json --report nightly.json
 *   jobs.json = {"jobs":[{"workspace":"ws-geo","goal":"...","plan":"cover","out_dir":"..."}]}
 *
 * 约定：
 * - 执行器由 server-adapter 构建（WORKLOOM_VISUAL_BRIDGE_* 环境变量）；
 * - 未配置桥 → 直接报错退出（不伪造成功）；
 * - 任务失败/未核实 → 退出码 1（供 cron/夜班告警），配置错误 → 退出码 2。
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import pg from "pg";
import { runQuest } from "@workloom/runtime";
import { createToolExecutorForScope } from "../bundles/geo-growth/connectors/visual-bridge/server-adapter.mts";

type PlanName = "cover";

interface JobSpec {
  workspace: string;
  tenant?: string;
  preset?: string;
  goal: string;
  plan?: PlanName;
  plan_file?: string;
  out_dir?: string;
  thread_id?: string;
  write_archive?: boolean;
}

interface RunnerOptions {
  job: JobSpec;
  report?: string;
}

function arg(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function coverPlan(outDir: string) {
  const title = join(outDir, "cover-title.png");
  const cover = join(outDir, "cover.png");
  const recipe = {
    recipe_version: 1,
    name: "cover",
    canvas: { width: 1080, height: 1440, resolution: 72 },
    layers: [
      { type: "solid", name: "bg", color: "#0B1220", x: 0, y: 0, width: 1080, height: 1440 },
      { type: "solid", name: "accent", color: "#FF4D2E", x: 90, y: 150, width: 220, height: 14 },
      { type: "image", name: "title", source: title, x: 90, y: 210, width: 900, height: 230, opacity: 1 },
      { type: "text", name: "sub", text: "growth 视觉工位 · 生产批次", font: "PingFang SC",
        size: 44, weight: "regular", color: "#9FB3C8", align: "left", x: 90, y: 520, width: 900 },
    ],
    exports: [{ format: "png", path: "cover.png" }],
  };
  return [
    {
      stepId: "s1", action: "visualwrite.text", objectType: "visual_asset", tool: "visualwrite.text",
      params: {
        output: title,
        spec: { text: "WorkLoom 视觉设计师", font: "PingFang SC", size: 96, weight: "bold",
                color: "#FFFFFF", align: "center", width: 900 },
      },
      label: "预渲染标题文字",
    },
    {
      stepId: "s2", action: "visualwrite.compose", objectType: "design_recipe", tool: "visualwrite.compose",
      params: {
        recipe_status: "approved", has_portrait: false, has_third_party_asset: false,
        recipe, out_dir: outDir,
      },
      context: { daily_rendered: 0 },
      label: "合成封面并导出",
    },
    {
      stepId: "s3", action: "visualread.verify", objectType: "visual_asset", tool: "visualread.verify",
      params: { path: cover, width: 1080, height: 1440 },
      label: "校验成品尺寸与哈希",
    },
  ];
}

function loadPlan(job: JobSpec): unknown[] {
  if (job.plan_file) {
    return JSON.parse(readFileSync(job.plan_file, "utf-8")) as unknown[];
  }
  const bridgeRoot = process.env.WORKLOOM_VISUAL_BRIDGE_OUT_DIR;
  const outDir = job.out_dir ?? (bridgeRoot ? join(bridgeRoot, "quest-runner") : undefined);
  if (!outDir) {
    throw new Error("缺少输出目录：设置 WORKLOOM_VISUAL_BRIDGE_OUT_DIR 或传 --out-dir");
  }
  mkdirSync(outDir, { recursive: true });
  switch (job.plan ?? "cover") {
    case "cover":
      return coverPlan(outDir);
    default:
      throw new Error(`未知 plan：${job.plan}（可用：cover，或使用 --plan-file）`);
  }
}

async function runJob(app: pg.Pool, gateway: pg.Pool, job: JobSpec, preset: string): Promise<Record<string, unknown>> {
  const workspaceId = job.workspace;
  const tenantId = job.tenant ?? "tenant-demo";
  const agent = await app.query<{ id: string }>(
    `SELECT id FROM agents WHERE workspace_id=$1 AND preset_key=$2`,
    [workspaceId, preset],
  );
  const agentId = agent.rows[0]?.id;
  if (!agentId) throw new Error(`未找到岗位 ${preset}（workspace=${workspaceId}），请先运行对应 seed`);

  const toolExecutor = createToolExecutorForScope({ tenantId, workspaceId });
  if (!toolExecutor) {
    throw new Error("视觉工位未配置：需要 WORKLOOM_VISUAL_BRIDGE_URL(S) 与 TOKEN(_FILE)");
  }
  const plan = loadPlan(job);
  const threadId = job.thread_id ?? `thr-visual-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  await app.query(
    `INSERT INTO threads (id, tenant_id, workspace_id, title, mode, status, progress_done, progress_total,
                          created_by, agent_id, created_at, updated_at)
     VALUES ($1,$2,$3,$4,'quest','queued',0,$5,'visual-runner',$6, now(), now())`,
    [threadId, tenantId, workspaceId, `视觉工位任务：${job.goal}`.slice(0, 120), plan.length, agentId],
  );
  const outcome = await runQuest(app, gateway, { tenantId, workspaceId }, {
    threadId,
    goal: job.goal,
    presetKey: preset,
    fallbackPlanner: (() => plan) as never,
    toolExecutor,
  });
  const events = await app.query<{
    action: string;
    receipt: unknown;
    result_sha256: string | null;
    output_sha256: string | null;
    rule_impact: unknown;
  }>(
    `SELECT payload->'decision'->>'action' AS action,
            payload->'receipt' AS receipt,
            payload->'decision'->'after'->'result'->>'sha256' AS result_sha256,
            payload->'decision'->'after'->'result'->'outputs'->0->>'sha256' AS output_sha256,
            payload->'rule_impact' AS rule_impact
       FROM biz_events WHERE session_id=$1 ORDER BY seq`,
    [threadId],
  );
  const receipts = events.rows
    .filter((row) => row.receipt)
    .map((row) => {
      const receipt = row.receipt as Record<string, unknown>;
      // v1 ReceiptSchema is frozen (no sha256); the hash lives in decision.after.result.
      const hash = row.result_sha256 ?? row.output_sha256;
      return { action: row.action, ...receipt, ...(typeof hash === "string" && hash ? { sha256: hash } : {}) };
    });
  const artifacts = receipts
    .map((receipt) => (typeof receipt.snapshot_uri === "string" ? receipt.snapshot_uri : undefined))
    .filter((value): value is string => Boolean(value));
  let archived = false;
  if (job.write_archive && artifacts.length > 0) {
    await writeArchive(app, { tenantId, workspaceId }, threadId, artifacts, receipts);
    archived = true;
  }
  return { workspace: workspaceId, tenant: tenantId, preset, threadId, ...outcome, receipts, artifacts, archived };
}

/**
 * 把成品写入一客一档 content_assets.visual_assets（幂等：asset_uri + thread_id 去重）。
 * 这是「交付即建档」的最小闭环：发行侧可以从档案里直接取素材与回执。
 */
async function writeArchive(app: pg.Pool, scope: { tenantId: string; workspaceId: string },
                            threadId: string, artifacts: string[],
                            receipts: Array<Record<string, unknown>>): Promise<void> {
  const client = await app.connect();
  try {
    await client.query("BEGIN");
    const row = await client.query<{ archive: Record<string, unknown> | null }>(
      `SELECT archive FROM profiles WHERE workspace_id=$1 AND tenant_id=$2 FOR UPDATE`,
      [scope.workspaceId, scope.tenantId],
    );
    if ((row.rowCount ?? 0) === 0) throw new Error(`profile not found: ${scope.workspaceId}`);
    const archive = row.rows[0]!.archive ?? {};
    const content = (archive.content_assets && typeof archive.content_assets === "object"
      ? archive.content_assets as Record<string, unknown> : {});
    const list = Array.isArray(content.visual_assets) ? [...content.visual_assets] : [];
    const createdAt = new Date().toISOString();
    for (const artifact of artifacts) {
      const exists = list.some((item) => {
        const entry = item as { asset_uri?: unknown; thread_id?: unknown };
        return entry?.asset_uri === artifact && entry?.thread_id === threadId;
      });
      if (exists) continue;
      const receipt = receipts.find((item) => item.snapshot_uri === artifact);
      list.push({
        asset_uri: artifact,
        sha256: typeof receipt?.sha256 === "string" ? receipt.sha256 : null,
        thread_id: threadId,
        source: "visual-workstation",
        created_at: createdAt,
      });
    }
    content.visual_assets = list;
    archive.content_assets = content;
    await client.query(
      `UPDATE profiles SET archive=$3::jsonb, updated_at=now() WHERE workspace_id=$1 AND tenant_id=$2`,
      [scope.workspaceId, scope.tenantId, JSON.stringify(archive)],
    );
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

async function main(): Promise<number> {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    console.error("DATABASE_URL 未设置（先 set -a; source .env; set +a）");
    return 2;
  }
  const gatewayString = process.env.DATABASE_GATEWAY_URL ?? connectionString;
  const preset = arg("--preset") ?? "visual-designer";
  const batchFile = arg("--batch");
  const reportPath = arg("--report");
  const json = process.argv.includes("--json");

  let jobs: JobSpec[];
  if (batchFile) {
    const parsed = JSON.parse(readFileSync(batchFile, "utf-8")) as { jobs?: JobSpec[] };
    jobs = parsed.jobs ?? [];
    if (jobs.length === 0) {
      console.error("batch 文件没有 jobs");
      return 2;
    }
  } else {
    const workspace = arg("--workspace");
    const goal = arg("--goal");
    if (!workspace || !goal) {
      console.error("用法：--workspace <ws> --goal <目标> [--plan cover] [--out-dir <dir>] | --batch jobs.json");
      return 2;
    }
    jobs = [{
      workspace,
      tenant: arg("--tenant"),
      goal,
      plan: (arg("--plan") as PlanName | undefined) ?? "cover",
      plan_file: arg("--plan-file"),
      out_dir: arg("--out-dir"),
      thread_id: arg("--thread"),
      write_archive: process.argv.includes("--write-archive"),
    }];
  }

  const app = new pg.Pool({ connectionString });
  const gateway = new pg.Pool({ connectionString: gatewayString });
  const results: Array<Record<string, unknown>> = [];
  let hadFailure = false;
  try {
    for (const job of jobs) {
      try {
        const result = await runJob(app, gateway, { ...job, preset: job.preset ?? preset }, job.preset ?? preset);
        results.push(result);
        if (result.status === "failed") hadFailure = true;
      } catch (error) {
        hadFailure = true;
        results.push({ workspace: job.workspace, goal: job.goal, error: error instanceof Error ? error.message : String(error) });
      }
    }
  } finally {
    await app.end();
    await gateway.end();
  }

  const summary = {
    ok: !hadFailure,
    ran_at: new Date().toISOString(),
    total: results.length,
    completed: results.filter((item) => item.status === "completed").length,
    failed: results.filter((item) => item.status === "failed" || item.error).length,
    results,
  };
  const serialized = JSON.stringify(summary, null, 2);
  if (reportPath) {
    mkdirSync(dirname(resolve(reportPath)), { recursive: true });
    writeFileSync(resolve(reportPath), serialized + "\n");
  }
  if (json || !reportPath) console.log(serialized);
  else console.log(`报告已写入 ${resolve(reportPath)}（completed=${summary.completed} failed=${summary.failed}）`);
  return summary.ok ? 0 : 1;
}

main().then((code) => process.exit(code)).catch((error) => {
  console.error(error);
  process.exit(2);
});
