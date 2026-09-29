/**
 * video/film-worker.ts —— 固定影片工位的服务侧编排（T-2026-0927-0039）。
 *
 * 职责边界（任务卡 §本批范围）：
 *   · 服务读取并**冻结原稿**（内容寻址写入项目档案），按登记摘要启动固定工位子进程；
 *   · 子进程不持供应商/签发密钥（环境剥离 + 启动自检），所有外呼经受限父通道；
 *   · 每一次组件调用先留账（先预占、后外呼），产物落盘由服务写在工作目录并回摘要；
 *   · 评审（gate.review）由服务用**冻结作者合同**执行，工位不能自报通过；
 *   · 作业终态只由服务写：结果文件摘要 + 真实子进程退出码。
 *
 * 非同 UID 沙箱：本批只保证"密钥不进子进程 + 作用域/步骤受限 + 台账先留账"，
 * 不声称操作系统级隔离；工位仍是本机同 UID 进程，这一点在 README/任务卡如实记录。
 */
import { createHash, randomUUID } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { constants } from "node:fs";
import { mkdir, open, readFile, realpath, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { getAppPool, getGatewayPool } from "@workloom/db";
import {
  FILM_CHANNEL_METHOD_COMPONENT,
  FILM_CHANNEL_METHODS,
  decodeFilmChannelFrame,
  encodeFilmChannelFrame,
  filmCanonicalJson,
  filmRequestHash,
  resolveEraProfile,
  reviewFilmStage,
  type FilmChannelFrame,
  type FilmChannelMethod,
  type FilmChannelRequestFrame,
  type FilmWorkerJobContext,
  type FilmContractSource,
} from "@hyperreality/video-studio";
import { routedLlmCall } from "../service/llm.js";
import { acquireProjectLease, archiveWorkDir, type ProjectLease } from "./archive-host.js";
import { FilmLedger, filmWorkerId, type FilmComponentKind, type FilmJobRow, type FilmWorkerRow } from "./film-ledger.js";
import { canonicalRenderJson, compileProviderRequest, providerEndpointOptions, renderSha256 } from "./gen/compiled-request.js";
import type { Scope } from "./gen/db.js";
import { ArkImageProvider, ArkVideoProvider } from "./gen/providers.js";
import { SubmissionError } from "./gen/submission-ledger.js";

const here = path.dirname(fileURLToPath(import.meta.url));
/** 仓库根（apps/server/src/video → 上溯四级）。 */
const REPO_ROOT = path.resolve(here, "../../../..");
/** 已登记的固定工位与语音工位路径（服务侧固定，工位不得选择任意代码）。 */
export const FILM_WORKER_ENTRY = "scripts/tools/full-chain-film.mts";
const VOICE_CLI = path.join(REPO_ROOT, "bundles/ai-video/connectors/voice-bridge/cli.mjs");

/** 子进程绝不能继承的密钥/环境（登录环境里可能有；一律剥离，缺失即为安全默认）。 */
const FORBIDDEN_CHILD_ENV = Object.freeze([
  "VOLCENGINE_ARK_API_KEY", "ARK_API_KEY", "SEEDANCE_ENDPOINT", "SEEDREAM_ENDPOINT",
  "LLM_API_KEY", "LLM_BASE_URL", "LLM_MODEL", "LLM_FAST_MODEL",
  "WORKLOOM_RENDER_SIGNING_SECRET", "WORKLOOM_RENDER_SIGNING_KEY_ID",
  "AUDIO_STEMS_SIGNING_SECRET", "AUDIO_STEMS_SIGNING_KEY_ID",
  "HF_KEY_ID", "HF_KEY_SECRET", "MUAPI_API_KEY",
  "DATABASE_URL", "POSTGRES_URL", "APP_DB_PASSWORD", "GATEWAY_DB_PASSWORD", "PII_SALT",
  "HUMAN_CONFIRMATION_SECRET",
]);

const DEFAULT_BUDGET_CNY = Number(process.env.FILM_DEFAULT_BUDGET_CNY ?? 100);
const LLM_RESERVE_CNY = Number(process.env.FILM_LLM_RESERVE_CNY ?? 0.05);
const IMAGE_RESERVE_CNY = Number(process.env.FILM_IMAGE_RESERVE_CNY ?? 0.3);
const VIDEO_RESERVE_CNY_PER_SECOND = Number(process.env.FILM_VIDEO_RESERVE_CNY_PER_SECOND ?? 0.5);
const VIDEO_POLL_INTERVAL_MS = Number(process.env.FILM_VIDEO_POLL_MS ?? 10_000);
const VIDEO_POLL_DEADLINE_MS = Number(process.env.FILM_VIDEO_DEADLINE_MS ?? 19 * 60_000);
const MEDIA_FETCH_LIMIT_BYTES = Number(process.env.FILM_MEDIA_FETCH_LIMIT_BYTES ?? 512 * 1024 * 1024);
const ANCHOR_LIMIT_BYTES = Number(process.env.FILM_ANCHOR_LIMIT_BYTES ?? 12 * 1024 * 1024);
const JOB_DEADLINE_MS = Number(process.env.FILM_JOB_DEADLINE_MS ?? 3 * 60 * 60_000);

export interface FilmJobStartReceipt {
  jobId: string; projectId: string; attempt: number; runId: string; status: "running";
  inputSha256: string; workerEntrySha256: string; stages: string[]; startedAt: string; budgetCny: number;
}

export interface StartFilmJobInput {
  scope: Scope;
  actor: string;
  projectId: string;
  workerName?: string;
  document: unknown;
  stages: string[];
  options?: Record<string, unknown>;
  maxBudgetCny?: number;
  env?: NodeJS.ProcessEnv;
}

function fail(code: string, message: string): never {
  throw new SubmissionError(code, message);
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail("REQUEST_INVALID", "请求必须是 JSON 对象");
  return value as Record<string, unknown>;
}

function text(value: unknown, message: string, max = 200_000): string {
  if (typeof value !== "string" || !value.trim() || value.length > max) fail("REQUEST_INVALID", message);
  return value;
}

function sha256Bytes(bytes: Buffer | string): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/** 拒绝绝对路径、`..` 与空片段；解析后再做 realpath 包含检查。 */
function safeRef(ref: string): string {
  if (typeof ref !== "string" || !ref.trim() || ref.length > 1_000 || path.isAbsolute(ref) || ref.startsWith("/")) {
    fail("PATH_INVALID", "引用必须是作业内相对路径");
  }
  const parts = ref.split(/[\\/]/);
  if (parts.some((part) => part === ".." || part === "." || part === "")) fail("PATH_INVALID", "引用包含非法路径片段");
  if (/[\0]/.test(ref)) fail("PATH_INVALID", "引用包含控制字符");
  return parts.join("/");
}

function within(root: string, target: string): boolean {
  return target === root || target.startsWith(`${root}${path.sep}`);
}

async function resolveWithin(root: string, ref: string): Promise<string> {
  const resolved = path.resolve(root, safeRef(ref));
  if (!within(root, resolved)) fail("PATH_INVALID", "引用越出作业目录");
  return resolved;
}

async function readJobBytes(ctx: RunContext, ref: string, limit = ANCHOR_LIMIT_BYTES): Promise<Buffer> {
  const file = await resolveWithin(ctx.workDir, ref);
  const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW).catch(() => {
    fail("ARTIFACT_MISSING", `作业内文件不存在或不可读：${ref}`);
  });
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.size === 0) fail("ARTIFACT_INVALID", `作业内文件为空或不是普通文件：${ref}`);
    if (info.size > limit) fail("ARTIFACT_TOO_LARGE", `作业内文件超过读取上限：${ref}`);
    return await handle.readFile();
  } finally {
    await handle.close();
  }
}

async function writeJobBytes(ctx: RunContext, ref: string, bytes: Buffer | string): Promise<{ ref: string; sha256: string; bytes: number }> {
  const file = await resolveWithin(ctx.workDir, ref);
  await mkdir(path.dirname(file), { recursive: true });
  const parentReal = await realpath(path.dirname(file));
  if (!within(ctx.workDir, parentReal)) fail("PATH_INVALID", "写入路径越出作业目录");
  const payload = typeof bytes === "string" ? Buffer.from(bytes, "utf8") : bytes;
  await writeFile(file, payload, { mode: 0o644 });
  return { ref: safeRef(ref), sha256: sha256Bytes(payload), bytes: payload.byteLength };
}

function dataUrlFor(file: string, bytes: Buffer): string {
  const lower = file.toLowerCase();
  const mime = lower.endsWith(".png") ? "png" : lower.endsWith(".webp") ? "webp" : "jpeg";
  return `data:image/${mime};base64,${bytes.toString("base64")}`;
}

interface RunContext {
  scope: Scope;
  env: NodeJS.ProcessEnv;
  job: FilmJobRow;
  worker: FilmWorkerRow;
  ledger: FilmLedger;
  workDir: string;
  archiveRoot: string;
  frozen: Record<string, unknown>;
  shots: Map<string, Record<string, unknown>>;
  contractSource: FilmContractSource;
  /** 本作业由服务签发的供应商产物 URL（media.fetch 只允许取这些）。 */
  issuedUrls: Map<string, { stepKey: string; shotId: string | null }>;
  ownerToken: string;
  log: (line: string) => void;
  send: (frame: FilmChannelFrame) => void;
}

/* ================= 路径与冻结输入 ================= */

function projectArchiveRoot(scope: Scope, projectId: string, env: NodeJS.ProcessEnv): string {
  const base = archiveWorkDir(env);
  return path.join(base, "archive", scope.workspaceId, projectId);
}

async function freezeSource(input: {
  scope: Scope; projectId: string; document: unknown; env: NodeJS.ProcessEnv;
}): Promise<{ ref: string; sha256: string; root: string; document: Record<string, unknown> }> {
  const root = projectArchiveRoot(input.scope, input.projectId, input.env);
  await mkdir(root, { recursive: true });
  const canonical = canonicalRenderJson(input.document);
  if (Buffer.byteLength(canonical, "utf8") > 4 * 1024 * 1024) fail("SOURCE_TOO_LARGE", "原稿超过 4MB 冻结上限");
  const digest = sha256Bytes(canonical);
  const rel = `stages/film/inputs/${digest}.json`;
  const file = path.join(root, rel);
  await mkdir(path.dirname(file), { recursive: true });
  try {
    await writeFile(file, canonical, { encoding: "utf8", flag: "wx", mode: 0o600 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    const existing = await readFile(file, "utf8");
    if (sha256Bytes(existing) !== digest) fail("SOURCE_FREEZE_CONFLICT", "同摘要输入文件内容不一致，拒绝复用");
  }
  return { ref: rel, sha256: digest, root, document: record(JSON.parse(canonical)) };
}

/** 当前 active 工位登记；代码摘要必须与磁盘字节一致（改代码 → 必须重新登记）。 */
async function requireActiveWorker(ledger: FilmLedger, workerName: string, entryPath: string): Promise<FilmWorkerRow> {
  const worker = await ledger.activeWorker(workerName);
  if (!worker) fail("FILM_WORKER_NOT_REGISTERED", `工位 ${workerName} 未登记，拒绝启动`);
  if (worker.entry_path !== entryPath) fail("FILM_WORKER_PATH_MISMATCH", "登记工位路径与固定入口不一致");
  const file = path.resolve(REPO_ROOT, worker.entry_path);
  if (!within(REPO_ROOT, file)) fail("FILM_WORKER_PATH_MISMATCH", "工位入口越出仓库根");
  const info = await stat(file).catch(() => null);
  if (!info?.isFile()) fail("FILM_WORKER_NOT_FOUND", `工位入口文件不存在：${worker.entry_path}`);
  const digest = sha256Bytes(await readFile(file));
  if (digest !== worker.entry_sha256) fail("FILM_WORKER_DIGEST_MISMATCH", "工位代码摘要与登记不一致，必须先登记新修订");
  return worker;
}

/** 首次使用（或代码更新后）登记工位：入口固定在本仓 scripts/tools。 */
export async function registerFilmWorker(input: {
  scope: Scope; actor: string; workerName?: string; workerVersion?: string; entryPath?: string; capabilities?: FilmComponentKind[];
}): Promise<FilmWorkerRow> {
  const ledger = new FilmLedger(getAppPool(), input.scope);
  const entryPath = input.entryPath ?? FILM_WORKER_ENTRY;
  if (entryPath !== FILM_WORKER_ENTRY) fail("FILM_WORKER_PATH_MISMATCH", "只允许登记本仓固定影片工位入口");
  const file = path.resolve(REPO_ROOT, entryPath);
  const digest = sha256Bytes(await readFile(file));
  return ledger.registerWorker({
    workerName: input.workerName ?? "full-chain-film",
    workerVersion: input.workerVersion ?? "2026-09-28.v1",
    entryPath,
    entrySha256: digest,
    capabilities: input.capabilities ?? [...FILM_CHANNEL_METHODS].map((method) => FILM_CHANNEL_METHOD_COMPONENT[method]!)
      .filter((component): component is FilmComponentKind => component !== undefined),
    actor: input.actor,
  });
}

/* ================= 启动作业 ================= */

export async function startFilmJob(input: StartFilmJobInput): Promise<FilmJobStartReceipt> {
  const env = { ...(input.env ?? process.env) };
  const workerName = input.workerName ?? "full-chain-film";
  const ledger = new FilmLedger(getAppPool(), input.scope);
  if (!Array.isArray(input.stages) || input.stages.length === 0 || !input.stages.every((stage) => typeof stage === "string" && stage.trim())) {
    fail("REQUEST_INVALID", "stages 必须是非空字符串数组");
  }
  if (input.stages.length > 64) fail("REQUEST_INVALID", "stages 数量超限");
  const projectRows = await (async () => {
    const client = await getAppPool().connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT set_config('app.workspace_id', $1, true)", [input.scope.workspaceId]);
      await client.query("SELECT set_config('app.tenant_id', $1, true)", [input.scope.tenantId]);
      const rows = await client.query<{ id: string; kind: string }>(
        `SELECT p.id, p.kind FROM video_projects p JOIN workspaces w ON w.id = p.workspace_id
          WHERE p.workspace_id=$1 AND p.id=$2 AND w.tenant_id=$3`,
        [input.scope.workspaceId, input.projectId, input.scope.tenantId],
      );
      await client.query("COMMIT");
      return rows.rows;
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  })();
  const project = projectRows[0];
  if (!project) fail("PROJECT_NOT_FOUND", "项目不存在或不属于当前作用域");
  if (!["narrative", "marketing"].includes(project.kind)) fail("PIPELINE_UNAVAILABLE", "固定影片工位只服务叙事/营销两类项目");

  const frozen = await freezeSource({ scope: input.scope, projectId: input.projectId, document: input.document, env });
  const shots = Array.isArray(frozen.document.shots) ? frozen.document.shots : [];
  if (!shots.length) fail("SHOT_REGISTRY_REQUIRED", "原稿必须登记 shots[]");
  let worker: FilmWorkerRow;
  try {
    worker = await requireActiveWorker(ledger, workerName, FILM_WORKER_ENTRY);
  } catch (error) {
    // 未登记（或代码已更新）时按固定入口自动登记一次：路径不接受调用方指定，等价于显式登记。
    if (error instanceof SubmissionError && (error.code === "FILM_WORKER_NOT_REGISTERED" || error.code === "FILM_WORKER_DIGEST_MISMATCH")) {
      await registerFilmWorker({ scope: input.scope, actor: input.actor, workerName });
      worker = await requireActiveWorker(ledger, workerName, FILM_WORKER_ENTRY);
    } else {
      throw error;
    }
  }
  const budget = input.maxBudgetCny ?? DEFAULT_BUDGET_CNY;
  if (!Number.isFinite(budget) || budget <= 0) fail("REQUEST_INVALID", "作业预算必须为正数");

  const lease = await acquireProjectLease(input.scope, input.projectId);
  if (!lease) fail("FILM_PROJECT_BUSY", "该项目正在预生产、审核或另一个固定工位作业中，拒绝并发执行");
  let job: FilmJobRow;
  try {
    job = await ledger.claimJob({
      projectId: input.projectId,
      workerId: worker.id,
      runId: `film-run-${randomUUID()}`,
      stages: [...input.stages],
      options: { ...(input.options ?? {}) },
      budgetCny: budget,
      inputRef: frozen.ref,
      inputSha256: frozen.sha256,
      workerEntrySha256: worker.entry_sha256,
      actor: input.actor,
    });
  } catch (error) {
    await lease.release().catch(() => undefined);
    throw error;
  }
  // 作业在后台运行；`startFilmJob` 只在工位子进程成功拉起后返回回执（否则内部已写失败终态）。
  void runFilmJob({ scope: input.scope, env, ledger, job, worker, frozen: frozen.document, archiveRoot: frozen.root, lease })
    .catch(async (error) => {
      console.error(`[film-worker ${job.id}] 运行编排异常：${error instanceof Error ? error.message : String(error)}`);
      await lease.release().catch(() => undefined);
      await ledger.finishJob(job.id, {
        status: "failed",
        errorClass: "WORKER_ORCHESTRATION_FAILED",
        errorMsg: error instanceof Error ? error.message.slice(0, 500) : String(error).slice(0, 500),
      }).catch(() => undefined);
    });
  return {
    jobId: job.id, projectId: job.project_id, attempt: Number(job.attempt), runId: job.run_id, status: "running",
    inputSha256: job.input_sha256, workerEntrySha256: job.worker_entry_sha256,
    stages: job.stages, startedAt: new Date(job.started_at).toISOString(), budgetCny: budget,
  };
}

/* ================= 工位运行与通道 ================= */

async function runFilmJob(args: {
  scope: Scope; env: NodeJS.ProcessEnv; ledger: FilmLedger; job: FilmJobRow; worker: FilmWorkerRow;
  frozen: Record<string, unknown>; archiveRoot: string; lease: ProjectLease;
}): Promise<void> {
  const { scope, env, ledger, job, worker } = args;
  const workDir = path.join(args.archiveRoot, "stages", "film", `attempt-${job.attempt}`);
  await mkdir(workDir, { recursive: true });
  const workReal = await realpath(workDir);
  const context: FilmWorkerJobContext = {
    jobId: job.id,
    tenantId: scope.tenantId,
    workspaceId: scope.workspaceId,
    projectId: job.project_id,
    attempt: Number(job.attempt),
    runId: job.run_id,
    workerName: worker.worker_name,
    workerVersion: worker.worker_version,
    stages: job.stages.map(String),
    options: record(job.options ?? {}),
    inputRef: job.input_ref,
    inputSha256: job.input_sha256,
    workDir: workReal,
    archiveRoot: await realpath(args.archiveRoot),
    allowedMethods: (Array.isArray(worker.capabilities) ? worker.capabilities : []).filter((method): method is FilmChannelMethod =>
      (FILM_CHANNEL_METHODS as readonly string[]).includes(method)),
    budgetCny: Number(job.budget_cny ?? 0),
    deadlineAt: new Date(Date.now() + JOB_DEADLINE_MS).toISOString(),
  };
  const shots = new Map<string, Record<string, unknown>>();
  for (const raw of Array.isArray(args.frozen.shots) ? args.frozen.shots : []) {
    const shot = record(raw);
    const shotId = text(shot.shotId, "原稿镜号缺失", 128);
    if (shots.has(shotId)) fail("SHOT_REGISTRY_INVALID", `原稿镜号重复：${shotId}`);
    shots.set(shotId, shot);
  }
  const era = args.frozen.eraProfile ?? (record(args.frozen.sceneBible ?? {}).eraProfile);
  const contractSource: FilmContractSource = {
    projectId: job.project_id,
    shots: [...shots.values()],
    eraProfile: resolveEraProfile(era ?? { storyDate: new Date().toISOString() }),
    ...(args.frozen.sceneBible && typeof args.frozen.sceneBible === "object" ? { sceneBible: args.frozen.sceneBible as FilmContractSource["sceneBible"] } : {}),
  };
  const childEnv: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(env)) {
    if (FORBIDDEN_CHILD_ENV.includes(key)) continue;
    childEnv[key] = value;
  }
  childEnv.FILM_JOB_ID = job.id;
  childEnv.FILM_JOB_CONTEXT = JSON.stringify(context);
  childEnv.FILM_FORBIDDEN_SECRETS = FORBIDDEN_CHILD_ENV.join(",");
  childEnv.FILM_WORKER_MODE = "worker";

  const child = spawn(process.execPath, [path.join(REPO_ROOT, worker.entry_path), "--worker"], {
    cwd: REPO_ROOT,
    env: childEnv,
    stdio: ["ignore", "pipe", "pipe", "ipc"],
  });
  const ctx: RunContext = {
    scope, env, job, worker, ledger, workDir: workReal, archiveRoot: context.archiveRoot,
    frozen: args.frozen, shots, contractSource,
    issuedUrls: new Map(), ownerToken: `film-owner-${randomUUID()}`,
    log: (line) => console.log(`[film-worker ${job.id}] ${line}`),
    send: (frame) => {
      try {
        child.send(encodeFilmChannelFrame(frame));
      } catch (error) {
        console.error(`[film-worker ${job.id}] 通道回帧失败：${error instanceof Error ? error.message : String(error)}`);
      }
    },
  };
  const logFile = path.join(workReal, "worker.log");
  const appendLog = (stream: "stdout" | "stderr") => (chunk: Buffer) => {
    const text = chunk.toString("utf8");
    for (const line of text.split("\n")) if (line.trim()) console.log(`[film-worker ${job.id}/${stream}] ${line}`);
    void writeFile(logFile, text, { flag: "a" }).catch(() => undefined);
  };
  child.stdout?.on("data", appendLog("stdout"));
  child.stderr?.on("data", appendLog("stderr"));
  const pending = new Set<Promise<void>>();
  child.on("message", (raw) => {
    const task = handleChildFrame(ctx, raw).catch((error) => {
      ctx.log(`通道处理异常：${error instanceof Error ? error.message : String(error)}`);
    }).finally(() => pending.delete(task));
    pending.add(task);
  });
  const exit = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
    child.on("exit", (code, signal) => resolve({ code, signal }));
    child.on("error", (error) => {
      ctx.log(`工位进程启动失败：${error.message}`);
      resolve({ code: -1, signal: null });
    });
  });
  await Promise.allSettled([...pending]);
  try {
    const resultFile = path.join(workReal, "film-result.json");
    const resultBytes = await readFile(resultFile).catch(() => null);
    if (exit.code === 0 && resultBytes) {
      const resultSha256 = sha256Bytes(resultBytes);
      await ledger.finishJob(job.id, { status: "finished", resultRef: `stages/film/attempt-${job.attempt}/film-result.json`, resultSha256 });
    } else if (exit.code === 0) {
      await ledger.finishJob(job.id, { status: "failed", errorClass: "RESULT_MISSING", errorMsg: "工位退出码为 0 但未写 film-result.json，按失败处理" });
    } else {
      await ledger.finishJob(job.id, {
        status: "failed",
        errorClass: exit.signal ? "WORKER_SIGNALED" : "WORKER_EXIT_NONZERO",
        errorMsg: `工位退出码 ${exit.code ?? "-"}${exit.signal ? `（信号 ${exit.signal}）` : ""}`,
      });
    }
  } finally {
    await args.lease.release().catch((error) => console.error(`[film-worker ${job.id}] 项目租约释放失败：${error instanceof Error ? error.message : String(error)}`));
  }
}

async function handleChildFrame(ctx: RunContext, raw: unknown): Promise<void> {
  const frame = decodeFilmChannelFrame(raw);
  if (frame.kind === "film.event") {
    ctx.log(`工位事件 ${frame.event}`);
    return;
  }
  if (frame.kind !== "film.request") {
    ctx.log("工位发来了非法帧类型，忽略");
    return;
  }
  const respond = (result: unknown): void => ctx.send({ kind: "film.response", id: frame.id, ok: true, result });
  const respondError = (error: unknown): void => {
    const code = error instanceof SubmissionError ? error.code.split(":")[0]! : "FILM_CHANNEL_FAILED";
    const message = error instanceof Error ? error.message.slice(0, 600) : String(error).slice(0, 600);
    ctx.send({ kind: "film.response", id: frame.id, ok: false, error: { code, message } });
  };
  try {
    const result = await handleChannelRequest(ctx, frame);
    respond(result);
  } catch (error) {
    respondError(error);
  }
}

async function handleChannelRequest(ctx: RunContext, frame: FilmChannelRequestFrame): Promise<unknown> {
  if (!(FILM_CHANNEL_METHODS as readonly string[]).includes(frame.method)) fail("METHOD_NOT_ALLOWED", `未知通道方法 ${String(frame.method)}`);
  if (!ctx.worker.capabilities.includes(frame.method)) fail("METHOD_NOT_ALLOWED", `工位未登记能力 ${frame.method}`);
  const expectedComponent = FILM_CHANNEL_METHOD_COMPONENT[frame.method];
  if (frame.component !== expectedComponent) fail("FRAME_INVALID", "组件分类与方法不匹配");
  const stage = String(frame.stepKey).split(":")[0]!;
  if (!ctx.job.stages.includes(stage)) fail("STEP_OUT_OF_SCOPE", `步骤 ${frame.stepKey} 不在本次作业冻结阶段内`);
  if (frame.shotId !== null && !ctx.shots.has(frame.shotId)) fail("SHOT_NOT_FOUND", `镜号 ${frame.shotId} 不在冻结原稿内`);
  const actualHash = filmRequestHash({ method: frame.method, stepKey: frame.stepKey, shotId: frame.shotId, params: frame.params });
  if (actualHash !== frame.requestHash) fail("FRAME_INVALID", "请求哈希与参数不一致");
  const payloadHash = renderSha256(filmCanonicalJson(frame.params));
  const ledger = ctx.ledger;
  const reserved = ledger.reserveComponent({
    jobId: ctx.job.id, component: expectedComponent, stepKey: frame.stepKey, shotId: frame.shotId,
    idempotencyKey: frame.idempotencyKey, requestHash: frame.requestHash, payloadHash,
    reservedCny: reserveFor(frame),
  }).then(async ({ row, deduped }) => {
    if (deduped) {
      if (row.state === "accepted") fail("IDEMPOTENT_REPLAY", "同一请求已接受；工位不得重放已完成的外部调用");
      if (row.state === "dispatched" || row.state === "unknown") {
        fail("RECONCILIATION_REQUIRED", "同一请求状态未核实（dispatched/unknown），必须对账，禁止自动重发");
      }
    }
    const claimed = await ledger.claimComponent(row.id, ctx.ownerToken);
    if (!claimed) fail("COMPONENT_CLAIM_FAILED", "组件请求已被其它执行者认领");
    return claimed;
  });
  const component = await reserved;
  try {
    return await dispatchComponent(ctx, frame, component.id);
  } catch (error) {
    const failureClass = error instanceof SubmissionError ? error.code.split(":")[0]! : "UNEXPECTED";
    await ledger.recordComponentFailure(component.id, ctx.ownerToken, {
      state: error instanceof SubmissionError && /UNKNOWN|TIMEOUT/.test(error.code) ? "unknown" : "failed",
      failureClass,
      evidence: { message: error instanceof Error ? error.message.slice(0, 400) : String(error).slice(0, 400) },
    }).catch(() => undefined);
    throw error;
  }
}

function reserveFor(frame: FilmChannelRequestFrame): number {
  if (frame.method === "image.generate") return IMAGE_RESERVE_CNY;
  if (frame.method === "video.generate") {
    const params = record(frame.params);
    const seconds = Number(params.seconds ?? 5);
    return Math.max(0.5, seconds * VIDEO_RESERVE_CNY_PER_SECOND);
  }
  if (frame.method === "llm.chat" || frame.method === "gate.review") return LLM_RESERVE_CNY;
  return 0;
}

async function dispatchComponent(ctx: RunContext, frame: FilmChannelRequestFrame, componentId: string): Promise<unknown> {
  switch (frame.method) {
    case "llm.chat": return runLlm(ctx, frame, componentId);
    case "image.generate": return runImage(ctx, frame, componentId);
    case "media.fetch": return runMediaFetch(ctx, frame, componentId);
    case "video.generate": return runVideo(ctx, frame, componentId);
    case "gate.review": return runGateReview(ctx, frame, componentId);
    case "voice.dub": return runVoiceDub(ctx, frame, componentId);
    case "voice.verify": return runVoiceVerify(ctx, frame, componentId);
    default: return fail("METHOD_NOT_ALLOWED", `通道方法未实现：${String(frame.method)}`);
  }
}

/* ================= 组件实现 ================= */

async function runLlm(ctx: RunContext, frame: FilmChannelRequestFrame, componentId: string): Promise<unknown> {
  const params = record(frame.params);
  const prompt = text(params.prompt, "llm.chat 需要非空 prompt", 100_000);
  const system = params.system === undefined ? "" : text(params.system, "llm.chat 的 system 非法", 20_000);
  const scene = typeof params.scene === "string" && params.scene.trim() ? params.scene.trim().slice(0, 80) : "video-film";
  const call = routedLlmCall({ gateway: getGatewayPool(), scope: ctx.scope, scene });
  if (!call) fail("LLM_UNAVAILABLE", "服务未配置可用的 LLM 路由（LLM_PROVIDER=mock 或装配失败），拒绝以兜底文本冒充生成结果");
  const content = await call(system ? `${system}\n\n${prompt}` : prompt);
  await ctx.ledger.recordDispatch(componentId, ctx.ownerToken, "model-router", scene);
  const evidence = {
    artifactSha256: sha256Bytes(content),
    scene,
    contentChars: content.length,
    estimate: true,
  };
  await ctx.ledger.recordComponentAccepted(componentId, ctx.ownerToken, {
    provider: "model-router", providerModel: scene, actualCny: null, evidence,
  });
  return { content, scene, artifactSha256: evidence.artifactSha256 };
}

function providerKey(env: NodeJS.ProcessEnv, kind: "image" | "video"): { apiKey: string; model: string } {
  const apiKey = (env.VOLCENGINE_ARK_API_KEY ?? env.ARK_API_KEY ?? "").trim();
  const model = kind === "image"
    ? (env.SEEDREAM_MODEL ?? env.ARK_IMAGE_MODEL ?? "doubao-seedream-5-0-pro-260628").trim()
    : (env.SEEDANCE_MODEL ?? env.ARK_VIDEO_MODEL ?? "doubao-seedance-2-5-260628").trim();
  if (!apiKey) fail("PROVIDER_UNCONFIGURED", "服务未配置火山方舟密钥，拒绝在工位侧直连供应商");
  if (!model) fail("PROVIDER_UNCONFIGURED", "服务未配置生成模型标识");
  return { apiKey, model };
}

async function fetchToFile(ctx: RunContext, url: string, ref: string): Promise<{ ref: string; sha256: string; bytes: number }> {
  const target = new URL(url);
  if (target.protocol !== "https:") fail("URL_INVALID", "只允许 https 供应商产物地址");
  const response = await fetch(url, { signal: AbortSignal.timeout(300_000), redirect: "error" }).catch((error) => {
    fail("MEDIA_FETCH_UNKNOWN", `拉取供应商产物结果未知：${error instanceof Error ? error.message.slice(0, 200) : String(error).slice(0, 200)}`);
  });
  if (!response.ok) fail("MEDIA_FETCH_FAILED", `拉取供应商产物失败：HTTP ${response.status}`);
  const declared = Number(response.headers.get("content-length") ?? 0);
  if (Number.isFinite(declared) && declared > MEDIA_FETCH_LIMIT_BYTES) fail("MEDIA_TOO_LARGE", "供应商产物超过下载上限");
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.byteLength === 0) fail("MEDIA_FETCH_FAILED", "供应商产物为空");
  if (bytes.byteLength > MEDIA_FETCH_LIMIT_BYTES) fail("MEDIA_TOO_LARGE", "供应商产物超过下载上限");
  return writeJobBytes(ctx, ref, bytes);
}

function requireIssuedUrl(ctx: RunContext, url: string, frame: FilmChannelRequestFrame): void {
  if (!ctx.issuedUrls.has(url)) fail("URL_NOT_ISSUED", `该地址不是本作业服务签发的供应商产物：${frame.stepKey}`);
}

async function anchorsToDataUrls(ctx: RunContext, refs: unknown): Promise<string[]> {
  if (refs === undefined) return [];
  if (!Array.isArray(refs) || refs.length > 4) fail("REQUEST_INVALID", "anchors 最多 4 个作业内引用");
  const out: string[] = [];
  for (const ref of refs) {
    const pathRef = text(ref, "anchors 必须是作业内相对路径", 1_000);
    const bytes = await readJobBytes(ctx, pathRef);
    out.push(dataUrlFor(pathRef, bytes));
  }
  return out;
}

async function runImage(ctx: RunContext, frame: FilmChannelRequestFrame, componentId: string): Promise<unknown> {
  const params = record(frame.params);
  const prompt = text(params.prompt, "image.generate 需要非空 prompt", 20_000);
  const size = text(params.size, "image.generate 需要 size", 32);
  if (!/^\d{3,5}x\d{3,5}$/.test(size)) fail("REQUEST_INVALID", "size 形如 2048x1152");
  const targetRef = text(params.targetRef, "image.generate 需要 targetRef", 1_000);
  await resolveWithin(ctx.workDir, targetRef);
  const anchors = await anchorsToDataUrls(ctx, params.anchors);
  const seed = params.seed === undefined ? undefined : Number(params.seed);
  if (seed !== undefined && !Number.isFinite(seed)) fail("REQUEST_INVALID", "seed 必须是有限数");
  const { apiKey, model } = providerKey(ctx.env, "image");
  const endpoint = providerEndpointOptions("seedream", ctx.env);
  const genRequest = {
    prompt,
    estimatedUnits: 1,
    refId: frame.shotId ?? frame.stepKey,
    params: {
      providerModel: model,
      resolution: size,
      ...(seed === undefined ? {} : { seed }),
      ...(anchors.length ? { extra: { image: anchors.length === 1 ? anchors[0] : anchors } } : {}),
    },
  };
  const compiled = compileProviderRequest("seedream", genRequest, endpoint);
  const provider = new ArkImageProvider({ apiKey, baseUrl: endpoint.baseUrl });
  const started = Date.now();
  await ctx.ledger.recordDispatch(componentId, ctx.ownerToken, "seedream", model);
  const submitted = await provider.submit(genRequest);
  const polled = await provider.poll(submitted.taskId);
  if (polled.status !== "succeeded" || !polled.uri) fail("PROVIDER_FAILED", `出图未成功：${polled.error ?? polled.status}`);
  const written = await fetchToFile(ctx, polled.uri, targetRef);
  ctx.issuedUrls.set(polled.uri, { stepKey: frame.stepKey, shotId: frame.shotId });
  const evidence = {
    artifactSha256: written.sha256,
    artifactRef: written.ref,
    artifactBytes: written.bytes,
    hostedUrlSha256: sha256Bytes(polled.uri),
    providerTaskId: submitted.taskId,
    providerRequestHash: compiled.payloadHash,
    durationMs: Date.now() - started,
  };
  await ctx.ledger.recordComponentAccepted(componentId, ctx.ownerToken, {
    provider: "seedream", providerModel: model, actualCny: null, evidence,
  });
  ctx.log(`出图完成 ${frame.shotId ?? frame.stepKey} → ${written.ref}（${written.bytes}B）`);
  return { ...written, hostedUrl: polled.uri, provider: "seedream", providerModel: model };
}

async function runMediaFetch(ctx: RunContext, frame: FilmChannelRequestFrame, componentId: string): Promise<unknown> {
  const params = record(frame.params);
  const targetRef = text(params.targetRef, "media.fetch 需要 targetRef", 1_000);
  await resolveWithin(ctx.workDir, targetRef);
  let written: { ref: string; sha256: string; bytes: number };
  if (params.url !== undefined) {
    const url = text(params.url, "media.fetch 的 url 非法", 8_192);
    requireIssuedUrl(ctx, url, frame);
    written = await fetchToFile(ctx, url, targetRef);
  } else if (params.ref !== undefined) {
    const sourceRef = text(params.ref, "media.fetch 的 ref 非法", 1_000);
    const bytes = await readJobBytes(ctx, sourceRef);
    written = await writeJobBytes(ctx, targetRef, bytes);
  } else {
    return fail("REQUEST_INVALID", "media.fetch 需要 url 或 ref");
  }
  await ctx.ledger.recordDispatch(componentId, ctx.ownerToken, "local", "media-fetch");
  await ctx.ledger.recordComponentAccepted(componentId, ctx.ownerToken, {
    provider: "local", providerModel: "media-fetch", actualCny: 0,
    evidence: { artifactSha256: written.sha256, artifactRef: written.ref, artifactBytes: written.bytes },
  });
  return written;
}

async function runVideo(ctx: RunContext, frame: FilmChannelRequestFrame, componentId: string): Promise<unknown> {
  const params = record(frame.params);
  const prompt = text(params.prompt, "video.generate 需要非空 prompt", 30_000);
  const seconds = Number(params.seconds);
  if (!Number.isInteger(seconds) || seconds <= 0 || seconds > 30) fail("REQUEST_INVALID", "video.generate 的 seconds 必须是 1–30 的整数");
  const generateAudio = params.generateAudio === undefined ? true : Boolean(params.generateAudio);
  const targetRef = text(params.targetRef, "video.generate 需要 targetRef", 1_000);
  await resolveWithin(ctx.workDir, targetRef);
  const firstFrame = params.firstFrame === undefined ? undefined : record(params.firstFrame);
  let firstFrameUrl: string | undefined;
  if (firstFrame?.hostedUrl !== undefined) {
    const url = text(firstFrame.hostedUrl, "firstFrame.hostedUrl 非法", 8_192);
    requireIssuedUrl(ctx, url, frame);
    firstFrameUrl = url;
  } else if (firstFrame?.ref !== undefined) {
    const ref = text(firstFrame.ref, "firstFrame.ref 非法", 1_000);
    firstFrameUrl = dataUrlFor(ref, await readJobBytes(ctx, ref));
  }
  const refs = await anchorsToDataUrls(ctx, params.refs);
  const seed = params.seed === undefined ? undefined : Number(params.seed);
  if (seed !== undefined && !Number.isFinite(seed)) fail("REQUEST_INVALID", "seed 必须是有限数");
  const { apiKey, model } = providerKey(ctx.env, "video");
  const endpoint = providerEndpointOptions("seedance", ctx.env);
  const genRequest = {
    prompt,
    estimatedUnits: seconds,
    refId: frame.shotId ?? frame.stepKey,
    params: {
      providerModel: model,
      durationSec: seconds,
      generateAudio,
      returnLastFrame: true,
      ...(firstFrameUrl ? { firstFrameUrl } : {}),
      ...(refs.length ? { referenceImageUrls: refs.slice(0, 3).filter((ref) => ref !== firstFrameUrl) } : {}),
      ...(seed === undefined ? {} : { seed }),
    },
  };
  const compiled = compileProviderRequest("seedance", genRequest, endpoint);
  const provider = new ArkVideoProvider({ apiKey, baseUrl: endpoint.baseUrl });
  const started = Date.now();
  await ctx.ledger.recordDispatch(componentId, ctx.ownerToken, "seedance", model);
  const submitted = await provider.submit(genRequest);
  const deadline = Date.now() + VIDEO_POLL_DEADLINE_MS;
  let last: Awaited<ReturnType<ArkVideoProvider["poll"]>> = { status: "submitted" };
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, VIDEO_POLL_INTERVAL_MS));
    last = await provider.poll(submitted.taskId);
    if (last.status === "succeeded" || last.status === "failed") break;
  }
  if (last.status !== "succeeded" || !last.uri) {
    fail(last.status === "failed" ? "PROVIDER_FAILED" : "PROVIDER_TIMEOUT_UNKNOWN", `出片未成功：${last.error ?? last.status}`);
  }
  const written = await fetchToFile(ctx, last.uri, targetRef);
  ctx.issuedUrls.set(last.uri, { stepKey: frame.stepKey, shotId: frame.shotId });
  const evidence: Record<string, unknown> = {
    artifactSha256: written.sha256,
    artifactRef: written.ref,
    artifactBytes: written.bytes,
    providerTaskId: submitted.taskId,
    providerRequestHash: compiled.payloadHash,
    durationMs: Date.now() - started,
    seconds,
    generateAudio,
  };
  ctx.log(`出片完成 ${frame.shotId ?? frame.stepKey} → ${written.ref}（${written.bytes}B，${seconds}s）`);
  await ctx.ledger.recordComponentAccepted(componentId, ctx.ownerToken, {
    provider: "seedance", providerModel: model, actualCny: null, evidence,
  });
  return { ...written, taskId: submitted.taskId, provider: "seedance", providerModel: model };
}

interface ProducerVerdictLike {
  approved: boolean;
  status: string;
  reason?: string;
  issues?: string[];
}

async function runGateReview(ctx: RunContext, frame: FilmChannelRequestFrame, componentId: string): Promise<unknown> {
  const params = record(frame.params);
  const stage = text(params.stage, "gate.review 需要 stage", 64);
  const artifacts = Array.isArray(params.artifacts) ? params.artifacts : [];
  if (!artifacts.length) fail("REQUEST_INVALID", "gate.review 需要 artifacts");
  const resolvedArtifacts = [];
  for (const raw of artifacts.slice(0, 24)) {
    const artifact = record(raw);
    const ref = text(artifact.ref, "gate.review 的 artifact.ref 非法", 1_000);
    const kind = text(artifact.kind, "gate.review 的 artifact.kind 非法", 16);
    if (!["image", "video", "audio", "text", "json"].includes(kind)) fail("REQUEST_INVALID", "artifact.kind 非法");
    const file = await resolveWithin(ctx.workDir, ref);
    const info = await stat(file).catch(() => null);
    if (!info?.isFile() || info.size === 0) fail("ARTIFACT_MISSING", `评审产物不存在或为空：${ref}`);
    resolvedArtifacts.push({
      path: file,
      kind: kind as "image" | "video" | "audio" | "text" | "json",
      bytes: info.size,
      ...(typeof artifact.note === "string" ? { note: artifact.note.slice(0, 500) } : {}),
    });
  }
  const deterministic = (Array.isArray(params.deterministic) ? params.deterministic : []).slice(0, 40).map((raw) => {
    const check = record(raw);
    return {
      id: text(check.id, "deterministic.id 非法", 120),
      pass: Boolean(check.pass),
      hard: check.hard === undefined ? true : Boolean(check.hard),
      detail: typeof check.detail === "string" ? check.detail.slice(0, 800) : "",
    };
  });
  const requiredCheckIds = Array.isArray(params.requiredCheckIds)
    ? params.requiredCheckIds.slice(0, 40).map((id) => text(id, "requiredCheckIds 非法", 120))
    : undefined;
  const rubric = Array.isArray(params.rubric) ? params.rubric.slice(0, 24).map((line) => text(line, "rubric 非法", 800)) : undefined;
  const minScore = params.minScore === undefined ? undefined : Number(params.minScore);
  if (minScore !== undefined && (!Number.isFinite(minScore) || minScore < 0 || minScore > 100)) fail("REQUEST_INVALID", "minScore 非法");
  const context = params.context === undefined ? {} : record(params.context);
  await ctx.ledger.recordDispatch(componentId, ctx.ownerToken, "workloom.producer-gate", stage);
  const verdict = await reviewFilmStage(ctx.contractSource, {
    stage: stage as Parameters<typeof reviewFilmStage>[1]["stage"],
    projectId: ctx.job.project_id,
    artifacts: resolvedArtifacts,
    deterministic,
    ...(requiredCheckIds ? { requiredCheckIds } : {}),
    ...(minScore === undefined ? {} : { minScore }),
    ...(rubric ? { rubric } : {}),
    context: { ...context, filmJobId: ctx.job.id, attempt: Number(ctx.job.attempt), stepKey: frame.stepKey },
    env: ctx.env,
  });
  const verdictLike = verdict as unknown as ProducerVerdictLike;
  await ctx.ledger.recordComponentAccepted(componentId, ctx.ownerToken, {
    provider: "workloom.producer-gate",
    providerModel: String((verdict as { model?: unknown }).model ?? stage),
    actualCny: null,
    evidence: {
      artifactSha256: sha256Bytes(canonicalRenderJson({ stage, approved: verdict.approved, status: verdict.status,
        contractHash: (verdict as { contractHash?: unknown }).contractHash ?? null })),
      approved: verdict.approved,
      status: verdict.status,
      contractHash: (verdict as { contractHash?: unknown }).contractHash ?? null,
      score: (verdict as { score?: unknown }).score ?? null,
    },
  });
  return verdict;
}

async function voiceCli(ctx: RunContext, args: string[], timeoutMs: number): Promise<{ ok: boolean; out: string }> {
  const { execFile } = await import("node:child_process");
  return new Promise((resolve) => {
    execFile(process.execPath, [VOICE_CLI, ...args], {
      cwd: REPO_ROOT,
      timeout: timeoutMs,
      maxBuffer: 8 * 1024 * 1024,
      env: ctx.env,
    }, (error, stdout, stderr) => {
      const out = `${stdout ?? ""}${error ? `\n${stderr ?? ""}` : ""}`.trim();
      resolve({ ok: !error, out });
    });
  });
}

async function runVoiceVerify(ctx: RunContext, frame: FilmChannelRequestFrame, componentId: string): Promise<unknown> {
  const params = record(frame.params);
  const inputRef = text(params.inputRef, "voice.verify 需要 inputRef", 1_000);
  const expectText = text(params.expectText, "voice.verify 需要 expectText", 20_000);
  const file = await resolveWithin(ctx.workDir, inputRef);
  const info = await stat(file).catch(() => null);
  if (!info?.isFile() || info.size === 0) fail("ARTIFACT_MISSING", "待核验媒体不存在");
  await ctx.ledger.recordDispatch(componentId, ctx.ownerToken, "voice-bridge", "verify");
  const result = await voiceCli(ctx, ["verify", "--in", file, "--expect-text", expectText, "--min-match", "0", "--no-strict"], 300_000);
  if (!result.ok) {
    fail("VOICE_VERIFY_FAILED", `配音工位调用失败：${result.out.slice(-200)}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(result.out);
  } catch {
    fail("VOICE_VERIFY_UNVERIFIED", "配音工位输出不是 JSON，按未核实处理");
  }
  const checked = (parsed as { result?: { checked?: unknown } }).result?.checked ?? null;
  const evidence = {
    artifactSha256: sha256Bytes(canonicalRenderJson({ checked })),
    checked,
  };
  await ctx.ledger.recordComponentAccepted(componentId, ctx.ownerToken, {
    provider: "voice-bridge", providerModel: "verify", actualCny: 0, evidence,
  });
  return { checked };
}

async function runVoiceDub(ctx: RunContext, frame: FilmChannelRequestFrame, componentId: string): Promise<unknown> {
  const params = record(frame.params);
  const inputRef = text(params.inputRef, "voice.dub 需要 inputRef", 1_000);
  const outputRef = text(params.outputRef, "voice.dub 需要 outputRef", 1_000);
  const profile = text(params.profile, "voice.dub 需要 profile", 120);
  const text_ = text(params.text, "voice.dub 需要 text", 20_000);
  const policy = params.policy === undefined ? "keep-dialogue" : text(params.policy, "voice.dub 的 policy 非法", 40);
  if (!["keep-dialogue", "replace-bed", "keep-all"].includes(policy)) fail("REQUEST_INVALID", "voice.dub 的 policy 非法");
  const lufs = params.lufs === undefined ? -16 : Number(params.lufs);
  if (!Number.isFinite(lufs)) fail("REQUEST_INVALID", "voice.dub 的 lufs 非法");
  const input = await resolveWithin(ctx.workDir, inputRef);
  const output = await resolveWithin(ctx.workDir, outputRef);
  await mkdir(path.dirname(output), { recursive: true });
  const inputInfo = await stat(input).catch(() => null);
  if (!inputInfo?.isFile() || inputInfo.size === 0) fail("ARTIFACT_MISSING", "待配音媒体不存在");
  await ctx.ledger.recordDispatch(componentId, ctx.ownerToken, "voice-bridge", "dub");
  const result = await voiceCli(ctx, ["dub", "--in", input, "--out", output, "--profile", profile,
    "--text", text_, "--policy", policy, "--lufs", String(lufs)], 600_000);
  if (!result.ok) fail("VOICE_DUB_FAILED", `配音工位调用失败：${result.out.slice(-200)}`);
  const produced = await stat(output).catch(() => null);
  if (!produced?.isFile() || produced.size === 0) fail("VOICE_DUB_UNVERIFIED", "配音工位未产出文件，按未核实处理");
  const bytes = await readFile(output);
  const evidence = { artifactSha256: sha256Bytes(bytes), artifactRef: safeRef(outputRef), artifactBytes: bytes.byteLength };
  await ctx.ledger.recordComponentAccepted(componentId, ctx.ownerToken, {
    provider: "voice-bridge", providerModel: "dub", actualCny: 0, evidence,
  });
  return { ref: safeRef(outputRef), sha256: evidence.artifactSha256, bytes: bytes.byteLength };
}
