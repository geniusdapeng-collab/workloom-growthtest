#!/usr/bin/env tsx
/**
 * 字幕工位运行时端到端（真实 PG + 真实围栏 + 真实 bridge + 真实 ffmpeg + 真实字体）：
 *
 *   runQuest(注入 createSubtitleBridgeExecutor)
 *     → 每步围栏判定（G-SUB0/1/2/3/4/5）
 *     → HTTP 调本机 subtitle-bridge → ffmpeg/libass 诊断/烧录出片
 *     → 回执写入 biz_events（无回执=未核实）
 *
 * 场景：
 *   clean           —— 常规字幕+标题渲染：G-SUB0 auto 直通，产出成片，回执 sha256 与磁盘文件一致
 *   review          —— 品牌视觉锤变更（许可未核验）：G-SUB1 review，线程 pending_review，产生审批行
 *   blocked         —— 覆盖原片：G-SUB2 block，线程 paused，不执行工具
 *   blocked-license —— 非白名单字体许可：G-SUB5 block，线程 paused
 *   danmaku         —— 弹幕轨渲染：G-SUB0 直通，产出弹幕成片，复检全绿
 *   blocked-flood   —— 关闭弹幕刷屏熔断（allow_flood）：G-SUB6 block，线程 paused
 *   outage          —— 工位不可达：软失败，步骤标未核实，线程 failed（不伪造回执）
 *
 * 运行（在 WorkLoom-growthtest 仓库内，需 DATABASE_URL / DATABASE_GATEWAY_URL，且工作区 ws-video 已 seed）：
 *   set -a; source .env; set +a
 *   node_modules/.bin/tsx bundles/ai-video/connectors/subtitle-bridge/runtime-smoke.mts
 */

import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { runQuest } from "@workloom/runtime";
import { createSubtitleBridgeExecutor } from "./executor.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const WORK_DIR = process.env.SUBTITLE_SMOKE_DIR ?? join(tmpdir(), `subtitle-smoke-${Date.now().toString(36)}`);
const PORT = Number(process.env.SUBTITLE_SMOKE_PORT ?? 9786);
const BASE_URL = `http://127.0.0.1:${PORT}`;
const TOKEN = randomBytes(16).toString("hex");
const TENANT_ID = "ws-video";
const SCOPE = { tenantId: "tenant-demo", workspaceId: "ws-video" };
const PRESET_KEY = "subtitle-stylist";

const SOURCE = join(WORK_DIR, "smoke-source.mp4");
const SRT = join(WORK_DIR, "smoke-source.srt");
const BURNED = join(WORK_DIR, "smoke-burned.mp4");
const REVIEW_OUT = join(WORK_DIR, "smoke-review.mp4");
const LICENSE_OUT = join(WORK_DIR, "smoke-license.mp4");
const DANMAKU_OUT = join(WORK_DIR, "smoke-danmaku.mp4");
const FLOOD_OUT = join(WORK_DIR, "smoke-flood.mp4");

const FFMPEG = process.env.WORKLOOM_SUBTITLE_FFMPEG_PATH ?? process.env.FFMPEG_PATH ?? "ffmpeg";
const FFPROBE = process.env.WORKLOOM_SUBTITLE_FFPROBE_PATH ?? process.env.FFPROBE_PATH ?? "ffprobe";

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

/** 造一条 12 秒竖屏素材：浅底 / 深底 / 花底三段硬切 + 环境声。 */
function makeSourceClip(): void {
  const shots = [
    { color: "0xe8dcc8", seconds: 4, label: "浅底（晨光）" },
    { color: "0x0f3b2e", seconds: 4, label: "深底（夜景）" },
    { pattern: true, seconds: 4, label: "花底（经幡）" },
  ];
  const shotFiles: string[] = [];
  shots.forEach((shot, index) => {
    const file = join(WORK_DIR, `shot-${index + 1}.mp4`);
    const source = shot.pattern
      ? ["-f", "lavfi", "-i", `testsrc2=size=720x1280:rate=25:duration=${shot.seconds}`]
      : ["-f", "lavfi", "-i", `color=c=${shot.color}:size=720x1280:rate=25:duration=${shot.seconds}`];
    execFileSync(FFMPEG, [
      "-hide_banner", "-v", "error", "-y",
      ...source,
      "-c:v", "libx264", "-preset", "ultrafast", "-crf", "26", "-pix_fmt", "yuv420p", file,
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
  execFileSync(FFMPEG, [
    "-hide_banner", "-v", "error", "-y",
    "-f", "lavfi", "-i", "anoisesrc=duration=12:color=pink:amplitude=0.02:seed=11",
    "-i", silent,
    "-map", "1:v:0", "-map", "0:a:0",
    "-c:v", "copy", "-c:a", "aac", "-b:a", "128k", "-movflags", "+faststart", "-shortest", SOURCE,
  ]);
  writeFileSync(SRT, [
    "1",
    "00:00:00,600 --> 00:00:03,200",
    "雪山倒映在草海的晨光里",
    "",
    "2",
    "00:00:04,200 --> 00:00:07,000",
    "藏寨的炊烟 是川西写给天空的信",
    "",
    "3",
    "00:00:08,000 --> 00:00:11,400",
    "Snow peaks, grasslands, and Tibetan songs",
    "",
  ].join("\n"), "utf8");
}

const BRIEF = {
  作品类型: "生活vlog",
  内容调性: "旅行文艺",
  账号调性: "文艺旅行账号",
  BGM节奏: "快",
  语言: "zh",
  平台: "抖音/快手",
  气质关键词: ["文艺", "清新"],
};

const steps = {
  clean: () => [
    {
      stepId: "s1", action: "subtitleread.analyze", objectType: "final_video", tool: "subtitleread.analyze",
      params: { input_path: SOURCE, platform: "抖音/快手", evidence_dir: join(WORK_DIR, "analyze") },
      context: { tenant_daily_subtitle: 0 },
      label: "画面可读性诊断（文字带亮度/细节密度/遮挡区）",
    },
    {
      stepId: "s2", action: "subtitlewrite.burn", objectType: "subtitle_report", tool: "subtitlewrite.burn",
      params: {
        input_path: SOURCE, output_path: BURNED, srt_path: SRT, title_text: "川西之行 · WEST SICHUAN",
        brief: BRIEF, platform: "抖音/快手", evidence_dir: join(WORK_DIR, "evidence"),
        font_license: "ofl-1.1", commercial_use: true, license_reviewed: true,
      },
      context: { tenant_daily_subtitle: 0 },
      label: "字幕+标题烧录出片（G-SUB0 直通）",
    },
  ],
  review: () => [
    {
      stepId: "s1", action: "subtitlewrite.burn", objectType: "subtitle_track", tool: "subtitlewrite.burn",
      params: {
        input_path: SOURCE, output_path: REVIEW_OUT, srt_path: SRT, brief: BRIEF, platform: "抖音/快手",
        font_license: "ofl-1.1", commercial_use: true, license_reviewed: false, brand_font_change: true,
      },
      context: { tenant_daily_subtitle: 0 },
      label: "品牌视觉锤变更（应被 G-SUB1 挂起）",
    },
  ],
  blocked: () => [
    {
      stepId: "s1", action: "subtitlewrite.burn", objectType: "final_video", tool: "subtitlewrite.burn",
      params: {
        input_path: SOURCE, output_path: SOURCE, srt_path: SRT, overwrite_source: true,
        font_license: "ofl-1.1", commercial_use: true,
      },
      context: { tenant_daily_subtitle: 0 },
      label: "覆盖原片的字幕烧录（应被 G-SUB2 阻断）",
    },
  ],
  "blocked-license": () => [
    {
      stepId: "s1", action: "subtitlewrite.burn", objectType: "subtitle_track", tool: "subtitlewrite.burn",
      params: {
        input_path: SOURCE, output_path: LICENSE_OUT, srt_path: SRT, brief: BRIEF, platform: "抖音/快手",
        font_license: "unknown-vendor", commercial_use: true,
      },
      context: { tenant_daily_subtitle: 0 },
      label: "非白名单字体许可用于商用（应被 G-SUB5 阻断）",
    },
  ],
  danmaku: () => [
    {
      stepId: "s1", action: "subtitlewrite.danmaku", objectType: "subtitle_report", tool: "subtitlewrite.danmaku",
      params: {
        input_path: SOURCE, output_path: DANMAKU_OUT,
        items: [
          { at: 0.8, text: "这也太好看了吧" },
          { at: 1.2, text: "川西永远的神", colour: "#FFF200" },
          { at: 2.0, text: "雪山绝了", mode: "top" },
          { at: 6.5, text: "已收藏" },
        ],
        brief: BRIEF, platform: "抖音/快手", evidence_dir: join(WORK_DIR, "danmaku-evidence"),
        font_license: "ofl-1.1", commercial_use: true,
      },
      context: { tenant_daily_subtitle: 0 },
      label: "弹幕轨渲染（密度在口径内，G-SUB0 直通）",
    },
  ],
  "blocked-flood": () => [
    {
      stepId: "s1", action: "subtitlewrite.danmaku", objectType: "subtitle_report", tool: "subtitlewrite.danmaku",
      params: {
        input_path: SOURCE, output_path: FLOOD_OUT,
        items: [{ at: 1, text: "刷屏测试" }],
        brief: BRIEF, platform: "抖音/快手", allow_flood: true,
        font_license: "ofl-1.1", commercial_use: true,
      },
      context: { tenant_daily_subtitle: 0 },
      label: "关闭弹幕刷屏熔断（应被 G-SUB6 阻断）",
    },
  ],
  outage: () => [
    {
      stepId: "s1", action: "subtitleread.analyze", objectType: "final_video", tool: "subtitleread.analyze",
      params: { input_path: SOURCE, platform: "抖音/快手" },
      context: { tenant_daily_subtitle: 0 },
      label: "工位不可达时的诊断（应标未核实）",
    },
  ],
} as const;

const goals: Record<keyof typeof steps, string> = {
  clean: "对成片做一次完整字幕与标题制作并出证据",
  review: "品牌视觉锤变更时渲染字幕（演练人审）",
  blocked: "字幕烧录时直接覆盖原片（演练红线）",
  "blocked-license": "用非白名单许可字体做商用字幕（演练版权红线）",
  danmaku: "给成片做一层弹幕轨并出证据",
  "blocked-flood": "关闭弹幕密度熔断（演练刷屏红线）",
  outage: "工位不可达时做字幕（演练软失败）",
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
      WORKLOOM_SUBTITLE_BRIDGE_PORT: String(PORT),
      WORKLOOM_SUBTITLE_BRIDGE_TOKEN: TOKEN,
      WORKLOOM_SUBTITLE_BRIDGE_TENANT: TENANT_ID,
      WORKLOOM_SUBTITLE_ALLOWED_ROOTS: WORK_DIR,
      WORKLOOM_SUBTITLE_JOBS_DIR: join(WORK_DIR, "jobs"),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  bridge.stdout?.on("data", (chunk) => process.stderr.write(`[bridge] ${chunk}`));
  bridge.stderr?.on("data", (chunk) => process.stderr.write(`[bridge:err] ${chunk}`));

  const app = new pg.Pool({ connectionString });
  const gateway = new pg.Pool({ connectionString: gatewayString });
  const results: Array<Record<string, unknown>> = [];

  try {
    if (!(await waitForHealth(BASE_URL))) throw new Error("字幕 bridge 未在 15s 内就绪");
    // 健康探针走 HTTP，确认工位（含字体与 libass）真的可用；不可用就直接失败，不进入"看起来在跑"的假象
    const health = await fetch(`${BASE_URL}/health`).then((res) => res.json() as Promise<Record<string, unknown>>);
    if (!Array.isArray(health.tools) || (health.tools as string[]).length !== 12) {
      throw new Error(`字幕 bridge 工具面异常：${JSON.stringify(health.tools)}`);
    }

    const agent = await app.query<{ id: string }>(
      `SELECT id FROM agents WHERE workspace_id=$1 AND preset_key=$2`,
      [SCOPE.workspaceId, PRESET_KEY],
    );
    const agentId = agent.rows[0]?.id;
    if (!agentId) throw new Error(`未找到 ${PRESET_KEY} 岗位，请先运行 pnpm db:seed:video`);

    const fenceCount = await app.query<{ c: string }>(
      `SELECT count(*)::text AS c FROM fence_rules WHERE workspace_id=$1 AND rule_id LIKE 'G-SUB%' AND status='active'`,
      [SCOPE.workspaceId],
    );
    const subtitleFenceRules = Number(fenceCount.rows[0]?.c ?? 0);
    if (subtitleFenceRules < 6) {
      throw new Error(`标题字幕围栏未装载（期望 6 条 G-SUB*，实际 ${subtitleFenceRules}），请先跑 pnpm db:seed:video`);
    }

    const executor = createSubtitleBridgeExecutor({
      baseUrl: BASE_URL,
      token: TOKEN,
      tenantId: TENANT_ID,
      timeoutMs: 900_000,
      idempotencyPrefix: "runtime-smoke",
    });
    const outageExecutor = createSubtitleBridgeExecutor({
      baseUrl: "http://127.0.0.1:9",
      token: TOKEN,
      tenantId: TENANT_ID,
      timeoutMs: 1_500,
      idempotencyPrefix: "runtime-smoke-outage",
    });

    for (const name of Object.keys(steps) as Array<keyof typeof steps>) {
      const threadId = `thr-subtitle-${name}-${Date.now().toString(36)}`;
      await app.query(
        `INSERT INTO threads (id, tenant_id, workspace_id, title, mode, status, progress_done, progress_total,
                              created_by, agent_id, created_at, updated_at)
         VALUES ($1,$2,$3,$4,'quest','queued',0,$5,'MEM-V03',$6, now(), now())`,
        [threadId, SCOPE.tenantId, SCOPE.workspaceId, `字幕工位运行时段到端（${name}）`, steps[name]().length, agentId],
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
                payload->'decision'->'after'->'result'->>'sha256' AS "resultSha256",
                payload->'decision'->'after'->'result'->'checks' AS checks,
                payload->'decision'->'after'->'result'->'presence' AS presence,
                payload->'decision'->'after'->'result'->'fonts' AS fonts
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
        checks?: Record<string, boolean> | null;
        presence?: { delta?: number; threshold?: number; ok?: boolean } | null;
        fonts?: Record<string, { name?: string }> | null;
      }>;
    }
    | undefined;

  const clean = find("clean");
  const burnedHash = existsSync(BURNED) ? createHash("sha256").update(readFileSync(BURNED)).digest("hex") : null;
  const burnEvent = clean?.events.find((event) => event.action === "subtitlewrite.burn");
  const receiptHash = burnEvent?.receipt?.sha256 ?? null;
  const receiptUri = burnEvent?.receipt?.snapshot_uri ?? null;
  const eventResultHash = burnEvent?.resultSha256 ?? null;
  const probe = existsSync(BURNED)
    ? execFileSync(FFPROBE, ["-v", "error", "-select_streams", "v:0", "-show_entries", "stream=width,height", "-of", "csv=p=0", BURNED], { encoding: "utf8" }).trim()
    : "";
  const review = find("review");
  const blocked = find("blocked");
  const blockedLicense = find("blocked-license");
  const danmaku = find("danmaku");
  const blockedFlood = find("blocked-flood");
  const outage = find("outage");
  const danmakuHash = existsSync(DANMAKU_OUT) ? createHash("sha256").update(readFileSync(DANMAKU_OUT)).digest("hex") : null;
  const danmakuEvent = danmaku?.events.find((event) => event.action === "subtitlewrite.danmaku");

  const checks = {
    clean_completed: clean?.outcome.status === "completed",
    clean_file_hash_matches_receipt: Boolean(
      burnedHash
      && (burnedHash === eventResultHash || burnedHash === receiptHash)
      && (receiptUri ?? "").includes(burnedHash),
    ),
    burned_video_geometry_preserved: probe.startsWith("720,1280"),
    subtitle_report_all_checks_green: Boolean(
      burnEvent?.checks && Object.values(burnEvent.checks).every((value) => value === true),
    ),
    subtitle_presence_measured: Boolean(
      burnEvent?.presence && typeof burnEvent.presence.delta === "number"
      && (burnEvent.presence.delta ?? 0) >= (burnEvent.presence.threshold ?? 1),
    ),
    subtitle_font_resolved: Boolean(burnEvent?.fonts?.字幕?.name || burnEvent?.fonts?.Sub),
    review_pending: review?.outcome.status === "pending_review" && Boolean(review?.outcome.pendingApprovalId),
    blocked_by_overwrite_rule: blocked?.outcome.status === "paused" && (blocked?.outcome.blockedBy ?? "").includes("覆盖原片"),
    blocked_by_license_rule: blockedLicense?.outcome.status === "paused" && (blockedLicense?.outcome.blockedBy ?? "").includes("字体许可"),
    danmaku_completed: danmaku?.outcome.status === "completed" && Boolean(danmakuHash),
    danmaku_report_all_checks_green: Boolean(
      danmakuEvent?.checks && Object.values(danmakuEvent.checks).every((value) => value === true),
    ),
    blocked_by_flood_rule: blockedFlood?.outcome.status === "paused" && (blockedFlood?.outcome.blockedBy ?? "").includes("弹幕刷屏"),
    outage_unverified: outage?.outcome.status === "failed" && (outage?.outcome.unverified?.length ?? 0) >= 1,
  };

  console.log(JSON.stringify({
    ok: Object.values(checks).every(Boolean),
    checks,
    workspace: SCOPE.workspaceId,
    preset: PRESET_KEY,
    subtitle_fence_rules: "G-SUB0..G-SUB5（6 条，active）",
    artifacts: {
      source: SOURCE,
      srt: SRT,
      burned: BURNED,
      burnedSha256: burnedHash,
      burnedGeometry: probe,
      danmaku: DANMAKU_OUT,
      danmakuSha256: danmakuHash,
      receiptSha256: receiptHash,
      receiptUri,
      fonts: burnEvent?.fonts ?? null,
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
