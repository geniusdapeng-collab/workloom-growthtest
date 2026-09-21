#!/usr/bin/env tsx
/**
 * 配乐工位运行时端到端（真实 PG + 真实围栏 + 真实 bridge + 真实 ffmpeg）：
 *
 *   runQuest(注入 createBgmBridgeExecutor)
 *     → 每步围栏判定（G-BGM0/1/2/3/4/5）
 *     → HTTP 调 Mac 配乐 bridge → ffmpeg 作曲/混音出片
 *     → 回执写入 biz_events（无回执=未核实）
 *
 * 场景：
 *   clean           —— 常规配乐：G-BGM0 auto 直通，产出成片，回执 sha256 与磁盘文件一致
 *   review          —— 曲库首次入片（许可未核验）：G-BGM1 review，线程 pending_review，产生审批行
 *   blocked         —— 覆盖原片：G-BGM2 block，线程 paused，不执行工具
 *   blocked-license —— NC 曲目用于商用：G-BGM5 block，线程 paused
 *   outage          —— 工位不可达：软失败，步骤标未核实，线程 failed（不伪造回执）
 *
 * 运行（在 WorkLoom-growth 仓库内，需 DATABASE_URL / DATABASE_GATEWAY_URL，且工作区 ws-video 已 seed）：
 *   set -a; source .env; set +a
 *   node_modules/.bin/tsx bundles/ai-video/connectors/bgm-bridge/runtime-smoke.mts
 */

import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { runQuest } from "@workloom/runtime";
import { createBgmBridgeExecutor } from "./executor.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const WORK_DIR = process.env.BGM_SMOKE_DIR ?? join(tmpdir(), `bgm-smoke-${Date.now().toString(36)}`);
const PORT = Number(process.env.BGM_SMOKE_PORT ?? 9785);
const BASE_URL = `http://127.0.0.1:${PORT}`;
const TOKEN = randomBytes(16).toString("hex");
const TENANT_ID = "ws-video";
const SCOPE = { tenantId: "tenant-demo", workspaceId: "ws-video" };
const PRESET_KEY = "bgm-composer";

const SOURCE = join(WORK_DIR, "smoke-source.mp4");
const BGM = join(WORK_DIR, "smoke-bgm.wav");
const MIXED = join(WORK_DIR, "smoke-mixed.mp4");
const REVIEW_OUT = join(WORK_DIR, "smoke-review.mp4");
const LICENSE_OUT = join(WORK_DIR, "smoke-license.mp4");
const OVERWRITE_OUT = join(WORK_DIR, "smoke-blocked.mp4");

const FFMPEG = process.env.WORKLOOM_BGM_FFMPEG_PATH ?? process.env.FFMPEG_PATH ?? "ffmpeg";
const FFPROBE = process.env.WORKLOOM_BGM_FFPROBE_PATH ?? process.env.FFPROBE_PATH ?? "ffprobe";

async function waitForHealth(url: string, timeoutMs = 15_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${url}/health`);
      if (res.ok) return true;
    } catch { /* 未起 */ }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  return false;
}

/** 造一条 18 秒、四段硬切、带"人声频段活动 + 环境底噪"的成片（不依赖 TTS）。 */
function makeSourceClip(): void {
  const shots = [
    { color: "0x0f3b2e", label: "S01" },
    { color: "0xe8dcc8", label: "S02" },
    { color: "0x15525a", label: "S03" },
    { color: "0xd9762a", label: "S04" },
  ];
  const shotFiles: string[] = [];
  shots.forEach((shot, index) => {
    const file = join(WORK_DIR, `shot-${index + 1}.mp4`);
    execFileSync(FFMPEG, [
      "-hide_banner", "-v", "error", "-y",
      "-f", "lavfi", "-i", `color=c=${shot.color}:size=320x180:rate=15:duration=4.5`,
      "-c:v", "libx264", "-preset", "ultrafast", "-crf", "24", "-pix_fmt", "yuv420p", file,
    ]);
    shotFiles.push(file);
  });
  const listFile = join(WORK_DIR, "shots.txt");
  writeFileSync(listFile, shotFiles.map((file) => `file '${file}'`).join("\n"));
  const silent = join(WORK_DIR, "video-only.mp4");
  execFileSync(FFMPEG, [
    "-hide_banner", "-v", "error", "-y",
    "-f", "concat", "-safe", "0", "-i", listFile, "-c", "copy", silent,
  ]);
  // 音轨：三段"人声量级"的带通脉冲 + 全程环境底噪（对白段与静音段交替，供让位/复检使用）
  execFileSync(FFMPEG, [
    "-hide_banner", "-v", "error", "-y",
    "-f", "lavfi", "-i", "anoisesrc=duration=18:color=pink:amplitude=0.02:seed=11",
    "-f", "lavfi", "-i", "anoisesrc=duration=18:color=brown:amplitude=0.6:seed=5",
    "-filter_complex",
    "[1:a]highpass=f=250,lowpass=f=3800,"
    + "volume='if(between(t,0.5,4.5)+between(t,9.5,13.5)+between(t,14.5,17.5),0.28,0.0008)':eval=frame[dlg];"
    + "[0:a]lowpass=f=4500,volume=-18dB[amb];"
    + "[dlg][amb]amix=inputs=2:duration=longest:normalize=0[mix];"
    + "[mix]loudnorm=I=-18:TP=-2:LRA=11[aout]",
    "-map", "[aout]", "-t", "18", "-c:a", "pcm_s16le", "-ar", "48000", "-ac", "2", join(WORK_DIR, "audio.wav"),
  ]);
  execFileSync(FFMPEG, [
    "-hide_banner", "-v", "error", "-y",
    "-i", silent, "-i", join(WORK_DIR, "audio.wav"),
    "-map", "0:v:0", "-map", "1:a:0",
    "-c:v", "copy", "-c:a", "aac", "-b:a", "192k", "-movflags", "+faststart", "-shortest", SOURCE,
  ]);
}

const steps = {
  clean: () => [
    {
      stepId: "s1", action: "bgmread.analyze", objectType: "final_video", tool: "bgmread.analyze",
      params: { input_path: SOURCE },
      context: { tenant_daily_bgm: 0 },
      label: "诊断成片音轨（人声活动/底噪/剪辑点）",
    },
    {
      stepId: "s2", action: "bgmwrite.compose", objectType: "bgm_track", tool: "bgmwrite.compose",
      params: { input_path: SOURCE, output_path: BGM, recipe_id: "food", bpm_strategy: "cut-driven", seed: 2026 },
      context: { tenant_daily_bgm: 0 },
      label: "自算作曲出 BGM（按剪辑点定速）",
    },
    {
      stepId: "s3", action: "bgmwrite.mix", objectType: "bgm_report", tool: "bgmwrite.mix",
      params: {
        input_path: SOURCE, output_path: MIXED, bgm_path: BGM, policy: "keep-dialogue",
        music_level_db: -22, ducking_db: 12, track_license: "workloom-self-generated", commercial_use: true,
        evidence_dir: join(WORK_DIR, "evidence"),
      },
      context: { tenant_daily_bgm: 0 },
      label: "配乐出片（G-BGM0 直通）",
    },
  ],
  review: () => [
    {
      stepId: "s1", action: "bgmwrite.mix", objectType: "bgm_report", tool: "bgmwrite.mix",
      params: {
        input_path: SOURCE, output_path: REVIEW_OUT, bgm_path: BGM, policy: "keep-dialogue",
        track_license: "cc-by-4.0", commercial_use: true, license_reviewed: false,
      },
      context: { tenant_daily_bgm: 0 },
      label: "曲库首次入片（应被 G-BGM1 挂起）",
    },
  ],
  blocked: () => [
    {
      stepId: "s1", action: "bgmwrite.mix", objectType: "final_video", tool: "bgmwrite.mix",
      params: {
        input_path: SOURCE, output_path: SOURCE, bgm_path: BGM, overwrite_source: true,
        track_license: "workloom-self-generated", commercial_use: true,
      },
      context: { tenant_daily_bgm: 0 },
      label: "覆盖原片的配乐（应被 G-BGM2 阻断）",
    },
  ],
  "blocked-license": () => [
    {
      stepId: "s1", action: "bgmwrite.mix", objectType: "bgm_track", tool: "bgmwrite.mix",
      params: {
        input_path: SOURCE, output_path: LICENSE_OUT, bgm_path: BGM, policy: "keep-dialogue",
        track_license: "cc-by-nc-4.0", commercial_use: true,
      },
      context: { tenant_daily_bgm: 0 },
      label: "NC 许可曲目用于商用交付（应被 G-BGM5 阻断）",
    },
  ],
  outage: () => [
    {
      stepId: "s1", action: "bgmread.analyze", objectType: "final_video", tool: "bgmread.analyze",
      params: { input_path: SOURCE },
      context: { tenant_daily_bgm: 0 },
      label: "工位不可达时的诊断（应标未核实）",
    },
  ],
} as const;

const goals: Record<keyof typeof steps, string> = {
  clean: "对成片做一次完整配乐并出证据",
  review: "曲库首次入片时配乐（演练人审）",
  blocked: "配乐时直接覆盖原片（演练红线）",
  "blocked-license": "用 NC 许可曲目做商用配乐（演练版权红线）",
  outage: "工位不可达时配乐（演练软失败）",
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
      WORKLOOM_BGM_BRIDGE_PORT: String(PORT),
      WORKLOOM_BGM_BRIDGE_TOKEN: TOKEN,
      WORKLOOM_BGM_BRIDGE_TENANT: TENANT_ID,
      WORKLOOM_BGM_ALLOWED_ROOTS: WORK_DIR,
      WORKLOOM_BGM_JOBS_DIR: join(WORK_DIR, "jobs"),
      ...(process.env.WORKLOOM_BGM_FFMPEG_PATH ? {} : {}),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  bridge.stdout?.on("data", (chunk) => process.stderr.write(`[bridge] ${chunk}`));
  bridge.stderr?.on("data", (chunk) => process.stderr.write(`[bridge:err] ${chunk}`));

  const app = new pg.Pool({ connectionString });
  const gateway = new pg.Pool({ connectionString: gatewayString });
  const results: Array<Record<string, unknown>> = [];

  try {
    if (!(await waitForHealth(BASE_URL))) throw new Error("配乐 bridge 未在 15s 内就绪");

    const agent = await app.query<{ id: string }>(
      `SELECT id FROM agents WHERE workspace_id=$1 AND preset_key=$2`,
      [SCOPE.workspaceId, PRESET_KEY],
    );
    const agentId = agent.rows[0]?.id;
    if (!agentId) throw new Error(`未找到 ${PRESET_KEY} 岗位，请先运行 pnpm db:seed:video`);

    const fenceCount = await app.query<{ c: string }>(
      `SELECT count(*)::text AS c FROM fence_rules WHERE workspace_id=$1 AND rule_id LIKE 'G-BGM%' AND status='active'`,
      [SCOPE.workspaceId],
    );
    const bgmFenceRules = Number(fenceCount.rows[0]?.c ?? 0);
    if (bgmFenceRules < 6) throw new Error(`配乐围栏未装载（期望 6 条 G-BGM*，实际 ${bgmFenceRules}），请先跑 pnpm db:seed:video`);

    const executor = createBgmBridgeExecutor({
      baseUrl: BASE_URL,
      token: TOKEN,
      tenantId: TENANT_ID,
      timeoutMs: 900_000,
      idempotencyPrefix: "runtime-smoke",
    });
    const outageExecutor = createBgmBridgeExecutor({
      baseUrl: "http://127.0.0.1:9",
      token: TOKEN,
      tenantId: TENANT_ID,
      timeoutMs: 1_500,
      idempotencyPrefix: "runtime-smoke-outage",
    });

    for (const name of Object.keys(steps) as Array<keyof typeof steps>) {
      const threadId = `thr-bgm-${name}-${Date.now().toString(36)}`;
      await app.query(
        `INSERT INTO threads (id, tenant_id, workspace_id, title, mode, status, progress_done, progress_total,
                              created_by, agent_id, created_at, updated_at)
         VALUES ($1,$2,$3,$4,'quest','queued',0,$5,'MEM-V03',$6, now(), now())`,
        [threadId, SCOPE.tenantId, SCOPE.workspaceId, `配乐工位运行时段到端（${name}）`, steps[name]().length, agentId],
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

  const find = (name: string) => results.find((record) => record.name === name) as
    | {
      outcome: { status: string; blockedBy?: string; pendingApprovalId?: string; unverified?: string[] };
      events: Array<{
        action: string;
        receipt: { synced?: boolean; sha256?: string; snapshot_uri?: string } | null;
        rule_impact: Array<{ rule_id: string; result: string }> | null;
        resultSha256?: string | null;
      }>;
    }
    | undefined;

  const clean = find("clean");
  const mixedHash = existsSync(MIXED) ? createHash("sha256").update(readFileSync(MIXED)).digest("hex") : null;
  const bgmHash = existsSync(BGM) ? createHash("sha256").update(readFileSync(BGM)).digest("hex") : null;
  const mixEvent = clean?.events.find((event) => event.action === "bgmwrite.mix");
  const receiptHash = mixEvent?.receipt?.sha256 ?? null;
  const receiptUri = mixEvent?.receipt?.snapshot_uri ?? null;
  const eventResultHash = mixEvent?.resultSha256 ?? null;
  const review = find("review");
  const blocked = find("blocked");
  const blockedLicense = find("blocked-license");
  const outage = find("outage");

  const checks = {
    clean_completed: clean?.outcome.status === "completed",
    clean_file_hash_matches_receipt: Boolean(
      mixedHash
      && (mixedHash === eventResultHash || mixedHash === receiptHash)
      && (receiptUri ?? "").includes(mixedHash),
    ),
    bgm_track_produced: Boolean(bgmHash),
    review_pending: review?.outcome.status === "pending_review" && Boolean(review?.outcome.pendingApprovalId),
    blocked_by_overwrite_rule: blocked?.outcome.status === "paused" && (blocked?.outcome.blockedBy ?? "").includes("覆盖原片"),
    blocked_by_license_rule: blockedLicense?.outcome.status === "paused" && (blockedLicense?.outcome.blockedBy ?? "").includes("版权"),
    outage_unverified: outage?.outcome.status === "failed" && (outage?.outcome.unverified?.length ?? 0) >= 1,
  };

  console.log(JSON.stringify({
    ok: Object.values(checks).every(Boolean),
    checks,
    workspace: SCOPE.workspaceId,
    preset: PRESET_KEY,
    bgm_fence_rules: "G-BGM0..G-BGM5（6 条，active）",
    artifacts: {
      source: SOURCE,
      bgm: BGM,
      bgmSha256: bgmHash,
      mixed: MIXED,
      mixedSha256: mixedHash,
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
