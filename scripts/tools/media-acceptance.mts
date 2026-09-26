#!/usr/bin/env tsx
/**
 * media-acceptance.mts —— 媒资库真机验收（T-2026-0926-0007…0010 · 规格书 §11 验收总表 1–7）
 *
 * 这个脚本不是"再跑一遍单测"，而是**起真进程 + 真 HTTP + 真文件**的端到端验收：
 *   ① 生产入库：注入一个真实 HTTP 产物地址 → `pollRenderJobs`（真下载/真 sha256）→ 断言 clip
 *      带提示词/管线/时长入库（用真 ffmpeg 生成夹具片；无 ffmpeg 则该步显式标 SKIP）；
 *   ② 起服务端真进程（tsx apps/server/src/index.ts）→ 真 JWT 登录 → 真 tRPC 调用；
 *   ③ 上传全链路：uploadTicket → POST /media/upload（流式 + 真 sha256）→ registerUpload → 签名 URL 可下载；
 *   ④ 三层检索：结构化过滤 + 中文全文（tsv→trgm）+（可选）语义层诊断字段；
 *   ⑤ 本地重剪：合集排序 → recut 作业轮询 → 新 final_cut 自动入库（source_type=recut）；
 *   ⑥ 成片历史 / 商品档案 / 复用匹配；
 *   ⑦ 云端同步通道：设备登记 → 带签名 pull 200 / 篡改签名 403（无签名 403）。
 *
 * 前置：本机 PG 已迁移+种子（`pnpm db:migrate && pnpm db:seed:video`），`.env` 可读。
 * 用法：
 *   pnpm exec tsx --env-file=.env scripts/tools/media-acceptance.mts [--workspace-slug ai-video] [--member MEM-V01] [--json]
 * 退出码：0=全部通过（含 SKIP）；1=有 FAIL。
 */
import { spawn, type ChildProcess } from "node:child_process";
import { execFileSync } from "node:child_process";
import { createServer, type Server } from "node:http";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import pg from "pg";

/* ================= 环境与参数 ================= */

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
if (!process.env.DATABASE_URL) {
  console.error("缺少 DATABASE_URL（用 `pnpm exec tsx --env-file=.env …` 或在 .env 里配置）");
  process.exit(2);
}

const REPO_ROOT = resolve(import.meta.dirname ?? process.cwd(), "../..");
const SERVER_PORT = Number(arg("--port", "8899"));
const BASE = `http://127.0.0.1:${SERVER_PORT}`;
const WORKSPACE_SLUG = arg("--workspace-slug", "video-studio");
const MEMBER_NO = arg("--member", "MEM-V01");
const AS_JSON = flag("--json");
const TMP = mkdtempSync(join(tmpdir(), "media-acceptance-"));

type StepStatus = "PASS" | "FAIL" | "SKIP";
interface StepResult { id: string; title: string; status: StepStatus; detail: string }
const results: StepResult[] = [];
function record(id: string, title: string, status: StepStatus, detail: string): void {
  results.push({ id, title, status, detail });
  const icon = status === "PASS" ? "✓" : status === "FAIL" ? "✗" : "•";
  console.log(`${icon} [${id}] ${title} —— ${detail}`);
}

const owner = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const app = new pg.Pool({ connectionString: process.env.DATABASE_APP_URL ?? process.env.DATABASE_URL });
const gateway = new pg.Pool({ connectionString: process.env.DATABASE_GATEWAY_URL ?? process.env.DATABASE_URL });

const sleep = (ms: number) => new Promise((resolvePromise) => setTimeout(resolvePromise, ms));

async function waitFor(check: () => Promise<boolean>, timeoutMs: number, everyMs = 500): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return true;
    await sleep(everyMs);
  }
  return false;
}

function ffmpeg(file: string, args: string[]): void {
  execFileSync(file, args, { stdio: "ignore" });
}

/* ================= ① 生产入库（真 HTTP 产物 → pollRenderJobs） ================= */

let fixtureServer: Server | null = null;
let serverChild: ChildProcess | null = null;

async function stepProductionIngest(): Promise<void> {
  const has = (() => {
    try {
      execFileSync("ffmpeg", ["-version"], { stdio: "ignore" });
      return true;
    } catch {
      return false;
    }
  })();
  if (!has) {
    record("1", "生产入库（单镜 clip）", "SKIP", "本机没有 ffmpeg，无法生成夹具视频；该步在 CI 由 db-gate 覆盖结构断言");
    return;
  }
  const clipPath = join(TMP, "provider-clip.mp4");
  ffmpeg("ffmpeg", [
    "-hide_banner", "-loglevel", "error", "-y",
    "-f", "lavfi", "-i", "color=c=teal:s=320x240:d=1:r=15",
    "-c:v", "libx264", "-pix_fmt", "yuv420p", clipPath,
  ]);
  /**
   * 夹具要**每次唯一**：媒体仓按 sha256 幂等，若两次验收产出同一份字节，第二次会命中去重行，
   * 断言就会跑去看"上一次那条素材"。在 moov 之后追加随机尾字节即可（播放器/ffprobe 均容忍）。
   */
  const body = Buffer.concat([readFileSync(clipPath), randomBytes(20)]);
  fixtureServer = createServer((req, res) => {
    if (req.url?.startsWith("/clip")) {
      res.writeHead(200, { "content-type": "video/mp4", "content-length": String(body.byteLength) });
      res.end(body);
      return;
    }
    res.writeHead(404).end();
  });
  await new Promise<void>((done) => fixtureServer!.listen(0, "127.0.0.1", () => done()));
  const address = fixtureServer.address();
  const port = typeof address === "object" && address ? address.port : 0;

  const ws = await owner.query<{ id: string; tenant_id: string }>(
    `SELECT id, tenant_id FROM workspaces WHERE slug = $1`, [WORKSPACE_SLUG]);
  const wsRow = ws.rows[0];
  if (!wsRow) throw new Error(`工作区 slug=${WORKSPACE_SLUG} 不存在（先跑 pnpm db:seed:video）`);
  const scope = { tenantId: wsRow.tenant_id, workspaceId: wsRow.id };
  const projectId = `VID-ACC-${Date.now().toString(36).toUpperCase().slice(-6)}`;
  await owner.query(
    `INSERT INTO video_projects (id, workspace_id, title, kind, created_by) VALUES ($1,$2,'媒资验收片','marketing','MEM-ACC')`,
    [projectId, wsRow.id]);
  const scriptId = `${projectId}-S01-v1`;
  await owner.query(
    `INSERT INTO render_scripts (id, workspace_id, project_id, shot_id, script_key, version, status, md, fields, created_by)
     VALUES ($1,$2,$3,'S01',$4,1,'submitted',$5,'{}'::jsonb,'MEM-ACC')`,
    [scriptId, wsRow.id, projectId, `${projectId}-S01`,
     "镜头：主持人在实验室里讲解折叠电煮锅的加热结构，近景，手持，冷调"],
  );
  const jobId = `${projectId}-J01`;
  await owner.query(
    `INSERT INTO render_jobs (id, workspace_id, project_id, script_id, script_version, task_id, status, provider, provider_model, est_seconds)
     VALUES ($1,$2,$3,$4,1,$5,'submitted','seedance','doubao-seedance-2-5-260628',5)`,
    [jobId, wsRow.id, projectId, scriptId, `${jobId}-task`],
  );
  /**
   * 冻结演示队列：种子数据里可能还留着 submitted 的演示任务，用真 poll 遍历时它们会一起被处理
   * （mock 产物地址会把它们推进 done）——为让验收断言只盯本次夹具，先显式把它们推进终态。
   */
  await owner.query(
    `UPDATE render_jobs SET status = 'done'
      WHERE workspace_id = $1 AND status IN ('submitted','rendering') AND id <> $2`,
    [wsRow.id, jobId]);

  const { pollRenderJobs } = await import("../../apps/server/src/video/render-poller.js");
  const stubProvider = {
    providerId: "seedance",
    kind: "video" as const,
    healthy: async () => true,
    submit: async () => ({ taskId: `${jobId}-task` }),
    poll: async () => ({ status: "succeeded" as const, uri: `http://127.0.0.1:${port}/clip.mp4`, actualUnits: 5 }),
  };
  const report = await pollRenderJobs(app, gateway, scope, {
    pool: new Map([["seedance", stubProvider as never]]),
    ingest: true,
    archive: null,
  });
  const row = await owner.query(
    `SELECT id, kind, title, prompt, pipeline_kind, duration_seconds, source_type, meta->>'localPath' AS local_path, sha256
       FROM video_assets WHERE workspace_id = $1 AND project_id = $2`,
    [wsRow.id, projectId]);
  const asset = row.rows[0];
  const problems: string[] = [];
  if (!asset) problems.push("没有产出素材行");
  else {
    if (asset.kind !== "clip") problems.push(`kind=${asset.kind}（期望 clip）`);
    if (!asset.prompt?.includes("实验室")) problems.push("prompt 未冗余自 render_scripts.md");
    if (asset.pipeline_kind !== "marketing") problems.push(`pipeline_kind=${asset.pipeline_kind}（期望 marketing）`);
    if (!asset.local_path || !existsSync(join(process.env.WORKLOOM_MEDIA_DIR ?? join(REPO_ROOT, "var/media"), asset.local_path))) {
      problems.push("媒体仓里没有落盘文件");
    }
    if (!asset.sha256) problems.push("sha256 缺失");
  }
  if (report.ingested < 1) problems.push(`轮询报告 ingested=${report.ingested}`);
  record("1", "生产入库（单镜 clip）", problems.length === 0 ? "PASS" : "FAIL",
    problems.length === 0
      ? `job ${jobId} → clip ${asset?.id}（kind/prompt/pipeline/文件/sha256 全对）`
      : problems.join("；"));
}

/* ================= ② 起真服务端 + 登录 ================= */

async function startServer(): Promise<boolean> {
  const child = spawn(
    process.execPath,
    [join(REPO_ROOT, "node_modules", "tsx", "dist", "cli.mjs"), join(REPO_ROOT, "apps/server/src/index.ts")],
    {
      cwd: REPO_ROOT,
      env: { ...process.env, SERVER_PORT: String(SERVER_PORT), SERVER_HOST: "127.0.0.1", NODE_ENV: "development" },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  serverChild = child;
  child.stdout?.on("data", (chunk: Buffer) => {
    const line = chunk.toString("utf8").trim();
    if (line) console.log(`    [server] ${line.slice(0, 200)}`);
  });
  child.stderr?.on("data", (chunk: Buffer) => {
    const line = chunk.toString("utf8").trim();
    if (line && !line.includes("ExperimentalWarning")) console.log(`    [server!] ${line.slice(0, 200)}`);
  });
  return waitFor(async () => {
    try {
      const res = await fetch(`${BASE}/health`);
      return res.ok;
    } catch {
      return false;
    }
  }, 60_000);
}

/**
 * 极简 tRPC v11 HTTP 客户端（**只依赖 fetch**，不引 @trpc/client —— 该依赖属 apps/web，
 * 根 scripts/ 解析不到）。线上格式（本仓 fetch adapter 实测）：
 *   查询：GET  /trpc/<path>?batch=1&input=<urlencode({"0":<input>})> → [{result:{data}}]
 *   变更：POST /trpc/<path>?batch=1  body={"0":<input>}          → [{result:{data}}]
 */
type AnyClient = { query: (path: string, input?: unknown) => Promise<unknown>; mutate: (path: string, input?: unknown) => Promise<unknown> };

async function trpcRaw(kind: "query" | "mutation", procedure: string, input: unknown, token?: string): Promise<unknown> {
  const headers: Record<string, string> = {};
  if (token) headers.authorization = `Bearer ${token}`;
  let res: Response;
  if (kind === "query") {
    const url = `${BASE}/trpc/${procedure}?batch=1&input=${encodeURIComponent(JSON.stringify({ 0: input ?? undefined }))}`;
    res = await fetch(url, { headers });
  } else {
    res = await fetch(`${BASE}/trpc/${procedure}?batch=1`, {
      method: "POST",
      headers: { ...headers, "content-type": "application/json" },
      body: JSON.stringify({ 0: input ?? undefined }),
    });
  }
  const text = await res.text();
  let parsed: unknown;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    throw new Error(`tRPC ${procedure} 响应不是 JSON（HTTP ${res.status}）：${text.slice(0, 200)}`);
  }
  const first = Array.isArray(parsed) ? parsed[0] : parsed;
  const error = (first as { error?: { message?: string; data?: { httpStatus?: number } } })?.error;
  if (error) throw new Error(`tRPC ${procedure} 失败（HTTP ${error.data?.httpStatus ?? res.status}）：${error.message ?? "未知错误"}`);
  return (first as { result?: { data?: unknown } })?.result?.data;
}

function client(token?: string): AnyClient {
  return {
    query: (path, input) => trpcRaw("query", path, input, token),
    mutate: (path, input) => trpcRaw("mutation", path, input, token),
  };
}

async function main(): Promise<void> {
  await stepProductionIngest();

  const up = await startServer();
  if (!up) {
    record("2", "起真服务端 + 登录", "FAIL", `服务端未在 60s 内就绪（端口 ${SERVER_PORT}）`);
    return;
  }
  const anon = client();
  const login = await anon.mutate("auth.loginAs", { workspaceSlug: WORKSPACE_SLUG, memberNo: MEMBER_NO }) as { token: string };
  if (!login?.token) {
    record("2", "起真服务端 + 登录", "FAIL", "登录未返回 token");
    return;
  }
  const trpc = client(login.token);
  const wsRowForScope = (await owner.query<{ id: string; tenant_id: string }>(
    `SELECT id, tenant_id FROM workspaces WHERE slug = $1`, [WORKSPACE_SLUG])).rows[0]!;
  const access = await trpc.query("access.me", {
    tenantId: wsRowForScope.tenant_id, workspaceId: wsRowForScope.id,
  }) as { scope?: { workspaceId?: string }; navigationPermissions?: string[] };
  const navOk = (access.navigationPermissions ?? []).includes("ai-video.media.read");
  record("2", "起真服务端 + 登录", navOk ? "PASS" : "FAIL",
    `工作区 ${access.scope?.workspaceId ?? "?"}；navigationPermissions 含 ai-video.media.read=${navOk}`
    + (navOk ? "" : "（bundle 未含新媒体槽位：重装 bundle：pnpm db:seed / db:seed:video）"));

  /* ③ 上传全链路 */
  try {
    const uploadBytes = Buffer.from("acceptance-upload-payload-".repeat(64));
    const ticket = await trpc.mutate("video.media.uploadTicket", {
      filename: "acceptance.mp4", bytes: uploadBytes.byteLength, kind: "upload_video",
    }) as { uploadUrl: string; maxBytes: number };
    const uploadRes = await fetch(`${BASE}${ticket.uploadUrl}`, {
      method: "POST",
      headers: { "content-type": "application/octet-stream" },
      body: uploadBytes,
    });
    const uploaded = await uploadRes.json() as { sha256?: string; relPath?: string; error?: string };
    if (!uploadRes.ok || !uploaded.sha256 || !uploaded.relPath) {
      record("3", "上传全链路", "FAIL", `POST /media/upload → ${uploadRes.status} ${uploaded.error ?? ""}`);
      return;
    }
    const registered = await trpc.mutate("video.media.registerUpload", {
      sha256: uploaded.sha256, relPath: uploaded.relPath, kind: "upload_video",
      title: "验收上传件", tags: ["验收"],
    }) as { assetId: string };
    const detail = await trpc.query("video.media.get", { id: registered.assetId }) as {
      url: string | null; tags: string[]; sourceType: string; hasLocalFile: boolean;
    };
    const mediaRes = detail.url ? await fetch(`${BASE}${detail.url}`) : null;
    const downloaded = mediaRes ? Buffer.from(await mediaRes.arrayBuffer()) : Buffer.alloc(0);
    const ok = Boolean(
      mediaRes?.ok
      && downloaded.equals(uploadBytes)
      && detail.sourceType === "uploaded"
      && detail.tags.includes("验收")
      && detail.hasLocalFile,
    );
    record("3", "上传全链路", ok ? "PASS" : "FAIL",
      ok
        ? `uploadTicket → 流式落盘（sha256 ${uploaded.sha256.slice(0, 12)}…）→ registerUpload → 签名 URL 回读一致（${downloaded.byteLength}B）`
        : `签名 URL 回读失败（status=${mediaRes?.status} 字节=${downloaded.byteLength}）`);

    // 越权：换工作区的 relPath 必须被拒
    let forbidden = false;
    try {
      await trpc.mutate("video.media.registerUpload", {
        sha256: uploaded.sha256, relPath: `upload/ws-other/${uploaded.sha256}.mp4`, kind: "upload_video",
      });
    } catch {
      forbidden = true;
    }
    if (!forbidden) record("3b", "上传越权复核", "FAIL", "跨工作区 relPath 未被拒绝");
    else record("3b", "上传越权复核", "PASS", "跨工作区 relPath 被拒（FORBIDDEN）");
  } catch (err) {
    record("3", "上传全链路", "FAIL", err instanceof Error ? err.message : String(err));
  }

  /* ④ 三层检索 */
  try {
    const listed = await trpc.query("video.media.list", { limit: 50 }) as { items: Array<{ id: string; kind: string }>; searchTrace?: { layer: string } };
    const byQuery = await trpc.query("video.media.list", { query: "实验室", limit: 20 }) as { items: Array<{ id: string }>; searchTrace?: { layer: string } };
    const byKind = await trpc.query("video.media.list", { kind: ["clip"], limit: 20 }) as { items: Array<{ kind: string }> };
    const tags = await trpc.query("video.media.tagGroups", {}) as { groups: Array<{ tags: Array<{ name: string }> }> };
    const ok = listed.items.length > 0
      && byQuery.items.length > 0
      && byKind.items.every((item) => item.kind === "clip")
      && tags.groups.some((group) => group.tags.some((tag) => tag.name === "验收"));
    record("4", "三层检索", ok ? "PASS" : "FAIL",
      `列表 ${listed.items.length} 条 · 中文查询「实验室」命中 ${byQuery.items.length} 条（层级 ${byQuery.searchTrace?.layer ?? "?"}）`
      + ` · kind 过滤纯度高=${byKind.items.every((i) => i.kind === "clip")} · 标签云含「验收」=${tags.groups.some((g) => g.tags.some((t) => t.name === "验收"))}`);
  } catch (err) {
    record("4", "三层检索", "FAIL", err instanceof Error ? err.message : String(err));
  }

  /* ⑤ 本地重剪 */
  try {
    const clips = await trpc.query("video.media.list", { kind: ["clip"], limit: 10 }) as { items: Array<{ id: string; hasLocalFile: boolean; durationSeconds: number | null }> };
    const usable = clips.items.filter((item) => item.hasLocalFile);
    if (usable.length < 2) {
      record("5", "本地重剪", "SKIP", `可用本地片段不足 2 段（${usable.length}）；跑一部 mock 片或补上传后再验`);
    } else {
      const collection = await trpc.mutate("video.media.collections.create", { title: `验收片单 ${Date.now()}`, purpose: "recut" }) as { id: string };
      for (const item of usable.slice(0, 3)) {
        await trpc.mutate("video.media.collections.addItem", { collectionId: collection.id, assetId: item.id });
      }
      const reordered = [...usable.slice(0, 3)].reverse().map((item) => item.id);
      await trpc.mutate("video.media.collections.reorder", { collectionId: collection.id, orderedAssetIds: reordered });
      const started = await trpc.mutate("video.media.recut", { collectionId: collection.id, title: `验收成片 ${Date.now()}` }) as { jobId: string; segments: number };
      const done = await waitFor(async () => {
        const job = await trpc.query("video.media.recutJob", { jobId: started.jobId }) as { status: string };
        return job.status !== "running";
      }, 180_000, 1500);
      const job = await trpc.query("video.media.recutJob", { jobId: started.jobId }) as { status: string; producedAssetId: string | null; error: string | null };
      const produced = job.producedAssetId
        ? await trpc.query("video.media.get", { id: job.producedAssetId }) as { sourceType: string; kind: string }
        : null;
      const films = await trpc.query("video.media.films", { limit: 20 }) as { items: Array<{ id: string }> };
      const ok = done && job.status === "done" && produced?.sourceType === "recut" && produced?.kind === "final_cut"
        && films.items.some((film) => film.id === job.producedAssetId);
      record("5", "本地重剪", ok ? "PASS" : "FAIL",
        ok
          ? `${started.segments} 段 → 作业 ${started.jobId} 完成 → 新成片 ${job.producedAssetId}（source_type=recut，已进成片历史）`
          : `作业状态=${job.status} 错误=${job.error ?? "—"} 产出=${job.producedAssetId ?? "—"}`);
    }
  } catch (err) {
    record("5", "本地重剪", "FAIL", err instanceof Error ? err.message : String(err));
  }

  /* ⑥ 成片历史 / 商品档案 / 复用匹配 */
  try {
    const films = await trpc.query("video.media.films", { limit: 20 }) as { items: unknown[] };
    const products = await trpc.query("video.media.products.list", {}) as { items: unknown[] };
    const refresh = await trpc.mutate("video.media.products.refresh", {}) as { scanned: number };
    const reuse = await trpc.query("video.media.findReusable", { prompt: "主持人在实验室里讲解折叠电煮锅的加热结构", limit: 5 }) as { items: unknown[]; count: number };
    record("6", "成片历史 / 商品档案 / 复用匹配", "PASS",
      `成片 ${films.items.length} 支 · 商品档案 ${products.items.length} 份（重扫 ${refresh.scanned}）· 复用命中 ${reuse.count} 条`);
  } catch (err) {
    record("6", "成片历史 / 商品档案 / 复用匹配", "FAIL", err instanceof Error ? err.message : String(err));
  }

  /* ⑦ 云端同步通道 */
  try {
    const probe = await fetch(`${BASE}/sync/media/pull?limit=1`);
    if (probe.status === 404) {
      record("7", "云端同步通道（设备签名）", "SKIP",
        "本实例未挂载设备通道（WORKLOOM_CLOUD_SYNC=0）；云端形态置 1 后重跑本步即可验签");
      return;
    }
    const enrolled = await trpc.mutate("video.media.sync.enroll", { label: `验收设备 ${Date.now()}` }) as { deviceId: string; deviceKey: string };
    const { deviceSignature, bodyHash } = await import("../../apps/server/src/video/media/sync.js");
    const path = "/sync/media/pull?limit=5";
    const timestamp = String(Date.now());
    const signature = deviceSignature({ method: "GET", path, timestamp, bodySha256: bodyHash("") }, enrolled.deviceKey);
    const headers = { "x-workloom-device": enrolled.deviceId, "x-workloom-timestamp": timestamp, "x-workloom-signature": signature };
    const pull = await fetch(`${BASE}${path}`, { headers });
    const pullBody = await pull.json() as { assets?: unknown[]; error?: string };
    const tampered = await fetch(`${BASE}${path}`, { headers: { ...headers, "x-workloom-signature": "tampered" } });
    const anonymous = await fetch(`${BASE}${path}`);
    const ok = pull.ok && Array.isArray(pullBody.assets) && tampered.status === 403 && anonymous.status === 403;
    record("7", "云端同步通道（设备签名）", ok ? "PASS" : "FAIL",
      ok
        ? `签名 pull 200（assets ${pullBody.assets?.length ?? 0}）· 篡改签名 ${tampered.status} · 无签名 ${anonymous.status}`
        : `pull=${pull.status}（${pullBody.error ?? ""}）篡改=${tampered.status} 匿名=${anonymous.status}`);
  } catch (err) {
    record("7", "云端同步通道（设备签名）", "FAIL", err instanceof Error ? err.message : String(err));
  }
}

try {
  await main();
} catch (err) {
  record("0", "验收脚本自身异常", "FAIL", err instanceof Error ? err.stack?.slice(0, 600) ?? String(err) : String(err));
} finally {
  serverChild?.kill("SIGTERM");
  fixtureServer?.close();
  await sleep(300);
  const failed = results.filter((r) => r.status === "FAIL");
  console.log("");
  console.log(`验收汇总：PASS ${results.filter((r) => r.status === "PASS").length} / SKIP ${results.filter((r) => r.status === "SKIP").length} / FAIL ${failed.length}`);
  if (AS_JSON) console.log(JSON.stringify({ workspace: WORKSPACE_SLUG, member: MEMBER_NO, results }, null, 2));
  await owner.end().catch(() => undefined);
  await app.end().catch(() => undefined);
  await gateway.end().catch(() => undefined);
  rmSync(TMP, { recursive: true, force: true });
  process.exitCode = failed.length > 0 ? 1 : 0;
}
