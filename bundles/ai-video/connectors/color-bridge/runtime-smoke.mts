#!/usr/bin/env tsx
/**
 * 调色工位运行时端到端（真实 PG + 真实围栏 + 真实 bridge + 真实 ffmpeg）：
 *
 *   runQuest(注入 createColorBridgeExecutor)
 *     → 每步围栏判定（G-COL0/1/2/3/4）
 *     → HTTP 调 Mac 调色 bridge → ffmpeg 出片
 *     → 回执写入 biz_events（无回执=未核实）
 *
 * 场景：
 *   clean   —— 干净调色：G-COL0 auto 直通，产出成片，回执 sha256 与磁盘文件一致
 *   blocked —— 覆盖原片：G-COL2 block，线程 paused，不执行工具
 *   review  —— 品牌 look 变更：G-COL1 review，线程 pending_review，产生审批行
 *   outage  —— 工位不可达：软失败，步骤全部标未核实，线程 failed（不伪造回执）
 *
 * 运行（在 WorkLoom-growth 仓库内，需 DATABASE_URL / DATABASE_GATEWAY_URL，且工作区 ws-video 已 seed）：
 *   set -a; source .env; set +a
 *   node_modules/.bin/tsx bundles/ai-video/connectors/color-bridge/runtime-smoke.mts
 */

import { spawn, execFileSync, type ChildProcess } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { runQuest } from "@workloom/runtime";
import { createColorBridgeExecutor } from "./executor.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, "../../../..");
const WORK_DIR = process.env.COLOR_SMOKE_DIR ?? join(tmpdir(), `color-smoke-${Date.now().toString(36)}`);
const PORT = Number(process.env.COLOR_SMOKE_PORT ?? 9784);
const BASE_URL = `http://127.0.0.1:${PORT}`;
const TOKEN = randomBytes(16).toString("hex");
const TENANT_ID = "ws-video";
const SCOPE = { tenantId: "tenant-demo", workspaceId: "ws-video" };
const PRESET_KEY = "colorist";

const FFMPEG = process.env.FFMPEG_PATH ?? join(process.env.HOME ?? "", ".workloom-color/bin/ffmpeg");
const SOURCE = join(WORK_DIR, "smoke-source.mp4");
const GRADED = join(WORK_DIR, "smoke-graded.mp4");
const REVIEW_OUT = join(WORK_DIR, "smoke-review.mp4");

async function waitForHealth(url: string, timeoutMs = 15_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${url}/health`);
      if (res.ok) return true;
    } catch { /* 未起 */ }
    await new Promise((r) => setTimeout(r, 250));
  }
  return false;
}

function makeSourceClip(): void {
  execFileSync(FFMPEG, [
    "-hide_banner", "-v", "error", "-y",
    "-f", "lavfi", "-i", "testsrc2=size=320x240:rate=15:duration=3",
    "-vf", "eq=brightness=-0.12:saturation=0.6",
    "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", SOURCE,
  ]);
}

const steps = {
  clean: () => [
    {
      stepId: "s1", action: "colorread.analyze", objectType: "final_video", tool: "colorread.analyze",
      params: { input_path: SOURCE, at_seconds: [1] },
      context: { tenant_daily_grades: 0 },
      label: "诊断成片色彩",
    },
    {
      stepId: "s2", action: "colorwrite.grade", objectType: "final_video", tool: "colorwrite.grade",
      params: { input_path: SOURCE, output_path: GRADED, profile: "teal-orange", intensity: 0.8, auto: true },
      context: { tenant_daily_grades: 0 },
      label: "调色出片（G-COL0 直通）",
    },
    {
      stepId: "s3", action: "colorread.scope", objectType: "color_report", tool: "colorread.scope",
      params: { input_path: GRADED, at_seconds: 1, out_dir: join(WORK_DIR, "scopes") },
      context: { tenant_daily_grades: 0 },
      label: "出 scope 与前后对比证据",
    },
  ],
  blocked: () => [
    {
      stepId: "s1", action: "colorwrite.grade", objectType: "final_video", tool: "colorwrite.grade",
      params: { input_path: SOURCE, output_path: SOURCE, overwrite_source: true, profile: "warm-film" },
      context: { tenant_daily_grades: 0 },
      label: "覆盖原片的调色（应被 G-COL2 阻断）",
    },
  ],
  review: () => [
    {
      stepId: "s1", action: "colorwrite.grade", objectType: "final_video", tool: "colorwrite.grade",
      params: { input_path: SOURCE, output_path: REVIEW_OUT, profile: "warm-film", look_change: true },
      context: { tenant_daily_grades: 0 },
      label: "品牌 look 变更（应被 G-COL1 挂起）",
    },
  ],
  outage: () => [
    {
      stepId: "s1", action: "colorread.analyze", objectType: "final_video", tool: "colorread.analyze",
      params: { input_path: SOURCE },
      context: { tenant_daily_grades: 0 },
      label: "工位不可达时的诊断（应标未核实）",
    },
  ],
} as const;

const goals: Record<keyof typeof steps, string> = {
  clean: "对成片母版做一次调色并出证据",
  blocked: "调色时直接覆盖原片（演练红线）",
  review: "变更品牌默认 look 后调色（演练人审）",
  outage: "工位不可达时调色（演练软失败）",
};

async function main(): Promise<number> {
  const connectionString = process.env.DATABASE_URL;
  const gatewayString = process.env.DATABASE_GATEWAY_URL ?? connectionString;
  if (!connectionString) throw new Error("DATABASE_URL 未设置");

  mkdirSync(WORK_DIR, { recursive: true });
  makeSourceClip();

  const bridge: ChildProcess = spawn(process.execPath, [join(HERE, "server.mjs")], {
    env: {
      ...process.env,
      WORKLOOM_COLOR_BRIDGE_PORT: String(PORT),
      WORKLOOM_COLOR_BRIDGE_TOKEN: TOKEN,
      WORKLOOM_COLOR_BRIDGE_TENANT: TENANT_ID,
      WORKLOOM_COLOR_ALLOWED_ROOTS: WORK_DIR,
      WORKLOOM_COLOR_JOBS_DIR: join(WORK_DIR, "jobs"),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  bridge.stdout?.on("data", (chunk) => process.stderr.write(`[bridge] ${chunk}`));
  bridge.stderr?.on("data", (chunk) => process.stderr.write(`[bridge:err] ${chunk}`));

  const app = new pg.Pool({ connectionString });
  const gateway = new pg.Pool({ connectionString: gatewayString });
  const results: Array<Record<string, unknown>> = [];

  try {
    if (!(await waitForHealth(BASE_URL))) throw new Error("调色 bridge 未在 15s 内就绪");

    const agent = await app.query<{ id: string }>(
      `SELECT id FROM agents WHERE workspace_id=$1 AND preset_key=$2`,
      [SCOPE.workspaceId, PRESET_KEY],
    );
    const agentId = agent.rows[0]?.id;
    if (!agentId) throw new Error(`未找到 ${PRESET_KEY} 岗位，请先运行 pnpm db:seed:video`);

    const fenceCount = await app.query<{ c: string }>(
      `SELECT count(*)::text AS c FROM fence_rules WHERE workspace_id=$1 AND rule_id LIKE 'G-COL%' AND status='active'`,
      [SCOPE.workspaceId],
    );
    const colorFenceRules = Number(fenceCount.rows[0]?.c ?? 0);
    if (colorFenceRules < 5) throw new Error(`调色围栏未装载（期望 5 条 G-COL*，实际 ${colorFenceRules}），请先跑 pnpm db:seed:video`);

    const executor = createColorBridgeExecutor({
      baseUrl: BASE_URL,
      token: TOKEN,
      tenantId: TENANT_ID,
      timeoutMs: 300_000,
      idempotencyPrefix: "runtime-smoke",
    });
    const outageExecutor = createColorBridgeExecutor({
      baseUrl: "http://127.0.0.1:9",
      token: TOKEN,
      tenantId: TENANT_ID,
      timeoutMs: 1_500,
      idempotencyPrefix: "runtime-smoke-outage",
    });

    for (const name of Object.keys(steps) as Array<keyof typeof steps>) {
      const threadId = `thr-color-${name}-${Date.now().toString(36)}`;
      await app.query(
        `INSERT INTO threads (id, tenant_id, workspace_id, title, mode, status, progress_done, progress_total,
                              created_by, agent_id, created_at, updated_at)
         VALUES ($1,$2,$3,$4,'quest','queued',0,$5,'MEM-V03',$6, now(), now())`,
        [threadId, SCOPE.tenantId, SCOPE.workspaceId, `调色工位运行时段到端（${name}）`, steps[name]().length, agentId],
      );
      const outcome = await runQuest(app, gateway, SCOPE, {
        threadId,
        goal: goals[name],
        presetKey: PRESET_KEY,
        fallbackPlanner: steps[name] as never,
        toolExecutor: name === "outage" ? outageExecutor : executor,
      });
      const events = await app.query(
        `SELECT event_id, payload->'decision'->>'action' AS action,
                payload->'receipt' AS receipt, payload->'rule_impact' AS rule_impact,
                payload->'decision'->'after'->'result'->>'sha256' AS "resultSha256"
           FROM biz_events WHERE session_id=$1 ORDER BY seq`,
        [threadId],
      );
      results.push({ name, threadId, outcome, events: events.rows });
    }
  } finally {
    await app.end().catch(() => {});
    await gateway.end().catch(() => {});
    bridge.kill("SIGTERM");
  }

  const find = (name: string) => results.find((r) => r.name === name) as
    | { outcome: { status: string; blockedBy?: string; pendingApprovalId?: string; unverified?: string[] }; events: Array<{ action: string; receipt: { synced?: boolean; sha256?: string; snapshot_uri?: string } | null; resultSha256?: string | null }> }
    | undefined;

  const clean = find("clean");
  const gradedHash = existsSync(GRADED) ? createHash("sha256").update(readFileSync(GRADED)).digest("hex") : null;
  const gradeEvent = clean?.events.find((e) => e.action === "colorwrite.grade");
  const receiptHash = gradeEvent?.receipt?.sha256 ?? null;
  const receiptUri = gradeEvent?.receipt?.snapshot_uri ?? null;
  const eventResultHash = gradeEvent?.resultSha256 ?? null;
  const blocked = find("blocked");
  const review = find("review");
  const outage = find("outage");

  const checks = {
    clean_completed: clean?.outcome.status === "completed",
    clean_file_hash_matches_receipt: Boolean(
      gradedHash
      && (gradedHash === eventResultHash || gradedHash === receiptHash)
      && (receiptUri ?? "").includes(gradedHash),
    ),
    blocked_by_overwrite_rule: blocked?.outcome.status === "paused" && (blocked?.outcome.blockedBy ?? "").includes("覆盖原片"),
    review_pending: review?.outcome.status === "pending_review" && Boolean(review?.outcome.pendingApprovalId),
    outage_unverified: outage?.outcome.status === "failed" && (outage?.outcome.unverified?.length ?? 0) >= 1,
  };

  console.log(JSON.stringify({
    ok: Object.values(checks).every(Boolean),
    checks,
    workspace: SCOPE.workspaceId,
    preset: PRESET_KEY,
    color_fence_rules: "G-COL0..G-COL4（5 条，active）",
    artifacts: {
      source: SOURCE,
      graded: GRADED,
      gradedSha256: gradedHash,
      receiptSha256: receiptHash,
      receiptUri,
    },
    results,
  }, null, 2));
  return Object.values(checks).every(Boolean) ? 0 : 1;
}

main()
  .then((code) => process.exit(code))
  .catch((error) => {
    console.error(error instanceof Error ? error.stack ?? error.message : String(error));
    process.exit(1);
  });
