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
import { execFile, spawn, type ChildProcess } from "node:child_process";
import { constants } from "node:fs";
import { mkdir, mkdtemp, open, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
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
  filmReviewContracts,
  buildProducerReviewContract,
  normalizeFilmJobRequest,
  assertFilmStageCoverage,
  resolveEraProfile,
  storyDateAt,
  reviewFilmStage,
  reviewStage as reviewCharacterVisualStage,
  resolveProducerLlm,
  buildRegisteredCharacterReleaseSource,
  buildCharacterIdentityReviewRequest,
  adaptCharacterVisualVerdict,
  assessCharacterGenerationInput,
  assessCharacterRelease,
  buildFilmVideoSubmissionReceipt,
  type RegisteredCharacterReleaseSource,
  type CharacterIdentityEvidence,
  type CharacterIdentityReviewRequest,
  type FilmVideoSubmissionReceipt,
  type FilmVideoReferenceInput,
  type FilmChannelFrame,
  type FilmChannelMethod,
  type FilmChannelRequestFrame,
  type FilmWorkerJobContext,
  type FilmContractSource,
  type ProducerGateOptions,
  type ProducerVerdict,
} from "@hyperreality/video-studio";
import { routedLlmCall } from "../service/llm.js";
import { acquireProjectLease, archiveWorkDir, type ProjectLease } from "./archive-host.js";
import { FilmLedger, filmWorkerId, type FilmComponentKind, type FilmJobRow, type FilmWorkerRow } from "./film-ledger.js";
import { canonicalRenderJson, compileProviderRequest, providerEndpointOptions, renderSha256 } from "./gen/compiled-request.js";
import type { Scope } from "./gen/db.js";
import { ArkImageProvider, ArkVideoProvider } from "./gen/providers.js";
import { SubmissionError } from "./gen/submission-ledger.js";
import { assertFilmAudioPreflight, resolveFilmAudioContract } from "../../../../scripts/tools/film-audio-policy.mjs";

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
  "WORKLOOM_AUDIO_STEM_SIGNING_SECRET", "WORKLOOM_AUDIO_STEM_SIGNING_KEY_ID",
  "HF_KEY_ID", "HF_KEY_SECRET", "MUAPI_API_KEY",
  "DATABASE_URL", "POSTGRES_URL", "APP_DB_PASSWORD", "GATEWAY_DB_PASSWORD", "PII_SALT",
  "HUMAN_CONFIRMATION_SECRET",
  "JWT_SECRET", "WORKLOOM_LOCAL_AUTH_TOKEN", "ENCRYPTION_KEY", "CNB_TOKEN",
]);
const CHILD_PUBLIC_ENV = new Set(["PATH", "HOME", "TMPDIR", "TEMP", "TMP", "LANG", "LC_ALL", "TZ", "SYSTEMROOT", "SystemRoot", "WINDIR", "USERPROFILE", "APPDATA", "LOCALAPPDATA", "WL_FFMPEG", "WL_FFPROBE", "FFMPEG_PATH", "FFPROBE_PATH", "WORKLOOM_COLOR_HOME", "WORKLOOM_BGM_HOME", "WORKLOOM_VOICE_HOME", "WORKLOOM_DANMAKU_HOME", "WORKLOOM_SUBTITLE_HOME", "SEEDREAM_MODEL", "ARK_IMAGE_MODEL", "SEEDANCE_MODEL", "ARK_VIDEO_MODEL", "SEEDANCE_GENERATE_AUDIO"]);
export function filmWorkerEnvironment(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return Object.fromEntries(Object.entries(env).filter(([key, value]) => CHILD_PUBLIC_ENV.has(key) && value !== undefined));
}
function workerAllows(worker: FilmWorkerRow, method: FilmChannelMethod): boolean {
  return worker.capabilities.includes(method) || worker.capabilities.includes(FILM_CHANNEL_METHOD_COMPONENT[method]!);
}

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
  let existing = resolved;
  for (;;) {
    try {
      if (!within(root, await realpath(existing))) fail("PATH_INVALID", "引用的真实路径越出作业目录");
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      if (existing === root) throw error;
      existing = path.dirname(existing);
    }
  }
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
  const handle = await open(file, constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | constants.O_NOFOLLOW, 0o644);
  try {
    if (!(await handle.stat()).isFile()) fail("ARTIFACT_INVALID", "写入目标不是普通文件");
    await handle.writeFile(payload);
  } finally { await handle.close(); }
  return { ref: safeRef(ref), sha256: sha256Bytes(payload), bytes: payload.byteLength };
}

function dataUrlFor(file: string, bytes: Buffer): string {
  const lower = file.toLowerCase();
  const mime = lower.endsWith(".png") ? "png" : lower.endsWith(".webp") ? "webp" : "jpeg";
  return `data:image/${mime};base64,${bytes.toString("base64")}`;
}

export interface RunContext {
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
  issuedUrls: Map<string, { stepKey: string; shotId: string | null; artifact: { ref: string; sha256: string; bytes: number } }>;
  /** Current accepted provider source and its local copied targets; never reconstructed from child JSON. */
  videoFiles: Map<string, FilmVideoSubmissionReceipt>;
  /** Current parent-written copy/normalization fingerprints; raw receipt always stays unchanged. */
  videoArtifacts?: Map<string, { ref: string; sha256: string; bytes: number }>;
  identityEvidence: Map<string, CharacterIdentityEvidence>;
  characterSource?: RegisteredCharacterReleaseSource;
  /** Service/operator roots, never accepted from the channel or StartFilmJobInput document. */
  registrationRoots?: { assetLibraryRoot: string; characterLibraryRoots: string[]; registryFile?: string };
  ownerToken: string;
  log: (line: string) => void;
  send: (frame: FilmChannelFrame) => void;
  signal: AbortSignal;
  deadlineAt: number;
}

function registeredCharactersFor(ctx: RunContext): RegisteredCharacterReleaseSource {
  const roots = ctx.registrationRoots ?? {
    assetLibraryRoot: path.join(REPO_ROOT, "bundles/ai-video/library/real-person-assets"),
    characterLibraryRoots: [path.join(REPO_ROOT, "var/media/characters"), path.join(REPO_ROOT, "bundles/ai-video/library/characters")],
    registryFile: path.join(REPO_ROOT, "bundles/ai-video/library/characters/registry.json"),
  };
  const current = buildRegisteredCharacterReleaseSource({ projectId: ctx.job.project_id,
    shots: [...ctx.shots.values()], character: ctx.frozen.character as Record<string, unknown> | undefined, ...roots });
  if (ctx.characterSource && current.contract.contractHash !== ctx.characterSource.contract.contractHash)
    fail("CHARACTER_REGISTRATION_CHANGED", "人物主档、授权、服饰或基准图在作业期间变化，须重新冻结核验");
  ctx.characterSource = current;
  return current;
}

/** Independent parent check: the child cannot authorize a new person request with its own boolean. */
async function requireCurrentVideoSource(ctx: RunContext, ref: string, shotId: string): Promise<FilmVideoSubmissionReceipt> {
  const receipt = ctx.videoFiles.get(ref);
  if (!receipt || receipt.shotId !== shotId || receipt.jobId !== ctx.job.id || receipt.inputSha256 !== ctx.job.input_sha256)
    fail("VIDEO_SOURCE_UNVERIFIED", "视频缺当前作业父服务受理回执");
  for (const currentRef of new Set([ref, receipt.artifact.ref])) {
    const bytes = await readJobBytes(ctx, currentRef, MEDIA_FETCH_LIMIT_BYTES);
    const expected = currentRef === receipt.artifact.ref ? receipt.artifact : ctx.videoArtifacts?.get(currentRef) ?? receipt.artifact;
    if (sha256Bytes(bytes) !== expected.sha256 || bytes.byteLength !== expected.bytes)
      fail("VIDEO_SOURCE_CHANGED", "当前视频或保留的供应商原视频字节发生变化");
  }
  return receipt;
}

async function validateCharacterVideoSubmission(ctx: RunContext, frame: FilmChannelRequestFrame): Promise<void> {
  const shot = ctx.shots.get(frame.shotId!);
  if (!shot?.assetRef) return;
  const source = registeredCharactersFor(ctx);
  if (source.contract.status !== "passed" || source.bindings.some(binding => !binding.identityAnchor)) fail("CHARACTER_RENDER_PREFLIGHT_BLOCKED", "人物授权、服饰和登记基准图必须完整");
  if (!resolveProducerLlm(ctx.env)) fail("CHARACTER_VISION_UNAVAILABLE", "父服务专用人物视觉评审未配置");
  const params = record(frame.params);
  if (params.firstFrame !== undefined) fail("CHARACTER_FIRST_FRAME_OVERRIDE", "登记真人素材模式不得混入另一首帧覆盖授权组");
  const generation = assessCharacterGenerationInput({ contract: source.contract, shotId: frame.shotId!,
    prompt: text(params.prompt, "人物提示词缺失", 30_000), referenceAssets: params.refs as string[] });
  if (generation.status !== "passed") fail("CHARACTER_GENERATION_INPUT_BLOCKED", generation.issues.map(issue => issue.detail).join("；"));
  const person = source.contract.shots.find(row => row.shotId === frame.shotId)!;
  const selected = String(ctx.job.options.only ?? "").split(",").filter(Boolean);
  const canary = source.contract.shots.find(row => row.characterId === person.characterId && (!selected.length || selected.includes(row.shotId)))!;
  if (canary.shotId === frame.shotId) return;
  const evidence = ctx.identityEvidence.get(canary.shotId);
  if (!evidence?.visualReview) fail("CHARACTER_CANARY_BLOCKED", "本人物首镜缺父服务专用身份与服饰回执");
  const clipRef = path.relative(ctx.workDir, evidence.visualReview.request.clip.path).split(path.sep).join("/");
  const receipt = await requireCurrentVideoSource(ctx, clipRef, canary.shotId);
  const artifacts = [{ shotId: canary.shotId, clip: evidence.visualReview.request.clip, promptSha256: receipt.promptSha256,
    referenceAssets: receipt.referenceInputs.filter(ref => ref.role === "reference-image").map(ref => ref.ref), evidence: [evidence] }];
  const assessment = assessCharacterRelease({ contract: source.contract, shots: artifacts, phase: "canary",
    canaryShotIds: [canary.shotId], canaryCharacterIds: [person.characterId] });
  if (!assessment.continuePaidRendering) fail("CHARACTER_CANARY_BLOCKED", "每个人物首镜的专用身份与服饰证据通过后才能继续该人物渲染");
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
  if (worker.capabilities.some(method => !FILM_CHANNEL_METHODS.includes(method as FilmChannelMethod))) {
    fail("FILM_WORKER_CAPABILITY_MISMATCH", "工位能力不是通道方法，必须重新登记");
  }
  return worker;
}

/** 首次使用（或代码更新后）登记工位：入口固定在本仓 scripts/tools。 */
export async function registerFilmWorker(input: {
  scope: Scope; actor: string; workerName?: string; workerVersion?: string; entryPath?: string; capabilities?: FilmChannelMethod[];
}): Promise<FilmWorkerRow> {
  const ledger = new FilmLedger(getAppPool(), input.scope);
  const entryPath = input.entryPath ?? FILM_WORKER_ENTRY;
  if (entryPath !== FILM_WORKER_ENTRY) fail("FILM_WORKER_PATH_MISMATCH", "只允许登记本仓固定影片工位入口");
  const file = path.resolve(REPO_ROOT, entryPath);
  const digest = sha256Bytes(await readFile(file));
  return ledger.registerWorker({
    workerName: input.workerName ?? "full-chain-film",
    workerVersion: input.workerVersion ?? "2026-10-02.v2",
    entryPath,
    entrySha256: digest,
    capabilities: input.capabilities ?? [...FILM_CHANNEL_METHODS],
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
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(input.projectId) || input.projectId.includes("..")) fail("PROJECT_ID_INVALID", "项目 ID 不能包含路径字符");
  let normalized: ReturnType<typeof normalizeFilmJobRequest>;
  try { normalized = normalizeFilmJobRequest(input.stages, input.options ?? {}); }
  catch (error) { fail("REQUEST_INVALID", error instanceof Error ? error.message : String(error)); }
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
  if (normalized.options["route-kind"] && normalized.options["route-kind"] !== project.kind) fail("ROUTE_KIND_CONFLICT", "工位分流必须与项目类型一致");
  normalized.options["route-kind"] = project.kind;

  const document = record(input.document);
  const era = document.eraProfile ?? record(document.sceneBible ?? {}).eraProfile;
  const frozen = await freezeSource({ scope: input.scope, projectId: input.projectId,
    document: { ...document, eraProfile: resolveEraProfile(era ?? { storyDate: storyDateAt(new Date()) }) }, env });
  const shots = Array.isArray(frozen.document.shots) ? frozen.document.shots : [];
  if (!shots.length) fail("SHOT_REGISTRY_REQUIRED", "原稿必须登记 shots[]");
  const selectedIds = String(normalized.options.only ?? "").split(",").filter(Boolean);
  const selectedShots = shots.map(raw => { const shot = record(raw); return { ...shot, shotId: text(shot.shotId, "原稿镜号缺失", 128) }; })
    .filter(shot => !selectedIds.length || selectedIds.includes(shot.shotId));
  if (selectedIds.some(id => !selectedShots.some(shot => shot.shotId === id))) fail("SHOT_REGISTRY_INVALID", "only含未登记镜号");
  try {
    assertFilmAudioPreflight({ shots: selectedShots, unifiedNarration: normalized.options["narration-unified"] === true,
      generateAudio: env.SEEDANCE_GENERATE_AUDIO !== "0" });
  } catch (error) {
    fail(typeof (error as { code?: unknown }).code === "string" ? (error as { code: string }).code : "AUDIO_SOURCE_INVALID",
      error instanceof Error ? error.message : "冻结音频合同无效");
  }
  let worker: FilmWorkerRow;
  try {
    worker = await requireActiveWorker(ledger, workerName, FILM_WORKER_ENTRY);
  } catch (error) {
    // 未登记（或代码已更新）时按固定入口自动登记一次：路径不接受调用方指定，等价于显式登记。
    if (error instanceof SubmissionError && ["FILM_WORKER_NOT_REGISTERED", "FILM_WORKER_DIGEST_MISMATCH", "FILM_WORKER_CAPABILITY_MISMATCH"].includes(error.code)) {
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
      stages: normalized.stages,
      options: normalized.options,
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
  // 作业已由服务认领，后台执行；最终结果必须通过 status 的真实进程与文件回执核对。
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
    allowedMethods: FILM_CHANNEL_METHODS.filter((method) => workerAllows(worker, method)),
    budgetCny: Number(job.budget_cny ?? 0),
    deadlineAt: new Date(Date.now() + JOB_DEADLINE_MS).toISOString(),
    characterVisionAvailable: Boolean(resolveProducerLlm(env)),
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
    eraProfile: resolveEraProfile(era),
    ...(args.frozen.sceneBible && typeof args.frozen.sceneBible === "object" ? { sceneBible: args.frozen.sceneBible as FilmContractSource["sceneBible"] } : {}),
  };
  const childEnv = filmWorkerEnvironment(env);
  childEnv.FILM_JOB_ID = job.id;
  childEnv.FILM_JOB_CONTEXT = JSON.stringify(context);
  childEnv.FILM_FORBIDDEN_SECRETS = FORBIDDEN_CHILD_ENV.join(",");
  childEnv.FILM_WORKER_MODE = "worker";

  const controller = new AbortController();
  const child = spawn(process.execPath, ["--import", "tsx", path.join(REPO_ROOT, worker.entry_path), "--worker"], {
    cwd: REPO_ROOT,
    env: childEnv,
    stdio: ["ignore", "pipe", "pipe", "ipc"],
  });
  const ctx: RunContext = {
    scope, env, job, worker, ledger, workDir: workReal, archiveRoot: context.archiveRoot,
    frozen: args.frozen, shots, contractSource,
    signal: controller.signal, deadlineAt: Date.parse(context.deadlineAt),
    issuedUrls: new Map(), videoFiles: new Map(), videoArtifacts: new Map(), identityEvidence: new Map(), ownerToken: `film-owner-${randomUUID()}`,
    log: (line) => console.log(`[film-worker ${job.id}] ${line}`),
    send: (frame) => {
      try {
        if (child.connected) child.send(encodeFilmChannelFrame(frame), (error) => {
          if (error) console.error(`[film-worker ${job.id}] 通道回帧失败：${error.message}`);
        });
      } catch (error) {
        console.error(`[film-worker ${job.id}] 通道回帧失败：${error instanceof Error ? error.message : String(error)}`);
      }
    },
  };
  let timedOut = false;
  let forceKill: NodeJS.Timeout | undefined;
  const deadlineTimer = setTimeout(() => {
    timedOut = true;
    controller.abort(new Error("JOB_DEADLINE_EXCEEDED"));
    child.kill("SIGTERM");
    forceKill = setTimeout(() => child.kill("SIGKILL"), 5_000);
    forceKill.unref();
  }, Math.max(1, ctx.deadlineAt - Date.now()));
  deadlineTimer.unref();
  const logFile = path.join(workReal, "worker.log");
  const appendLog = (stream: "stdout" | "stderr") => (chunk: Buffer) => {
    const text = chunk.toString("utf8");
    for (const line of text.split("\n")) if (line.trim()) console.log(`[film-worker ${job.id}/${stream}] ${line}`);
    void writeFile(logFile, text, { flag: "a" }).catch((error) => ctx.log(`工位日志写入失败：${error instanceof Error ? error.message : String(error)}`));
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
  clearTimeout(deadlineTimer);
  if (forceKill) clearTimeout(forceKill);
  controller.abort(new Error(timedOut ? "JOB_DEADLINE_EXCEEDED" : "WORKER_EXITED"));
  await Promise.allSettled([...pending]);
  try {
    const resultBytes = await readJobBytes(ctx, "film-result.json", 8 * 1024 * 1024).catch(() => null);
    if (timedOut) {
      await ledger.finishJob(job.id, { status: "failed", errorClass: "JOB_DEADLINE_EXCEEDED", errorMsg: "影片作业超过截止时间，已停止工位；已签发的供应商任务仍须对账" });
    } else if (exit.code === 0 && resultBytes) {
      try {
        const result = record(JSON.parse(resultBytes.toString("utf8")));
        if (result.schemaVersion !== "workloom.film-result/v1" || result.jobId !== job.id || result.projectId !== job.project_id
          || result.runId !== job.run_id || result.attempt !== Number(job.attempt) || result.inputSha256 !== job.input_sha256
          || result.complete !== true || JSON.stringify(result.stages) !== JSON.stringify(job.stages)
          || !Array.isArray(result.artifacts) || result.artifacts.length === 0) fail("RESULT_INVALID", "工位结果与本次冻结作业不一致");
        assertFilmStageCoverage(job.stages, record(job.options), args.frozen, result.records);
        for (const raw of result.artifacts) {
          const artifact = record(raw);
          const ref = text(artifact.ref, "结果缺产物引用", 1_000);
          const file = await resolveWithin(workReal, ref);
          if (!within(workReal, await realpath(file))) fail("RESULT_INVALID", "结果产物越出作业目录");
          const bytes = await readJobBytes(ctx, ref, MEDIA_FETCH_LIMIT_BYTES);
          if (sha256Bytes(bytes) !== artifact.sha256 || bytes.byteLength !== artifact.bytes) fail("RESULT_INVALID", "结果产物与回执摘要不一致");
        }
        const resultSha256 = sha256Bytes(resultBytes);
        await ledger.finishJob(job.id, { status: "finished", resultRef: `stages/film/attempt-${job.attempt}/film-result.json`, resultSha256 });
      } catch (error) {
        await ledger.finishJob(job.id, { status: "failed", errorClass: "RESULT_INVALID", errorMsg: error instanceof Error ? error.message.slice(0, 500) : String(error).slice(0, 500) });
      }
    } else if (exit.code === 0) {
      await ledger.finishJob(job.id, { status: "failed", errorClass: "RESULT_MISSING", errorMsg: "工位退出码为 0 但未写 film-result.json，按失败处理" });
    } else {
      await ledger.finishJob(job.id, {
        status: "failed",
        errorClass: timedOut ? "JOB_DEADLINE_EXCEEDED" : exit.signal ? "WORKER_SIGNALED" : "WORKER_EXIT_NONZERO",
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

export async function handleChannelRequest(ctx: RunContext, frame: FilmChannelRequestFrame): Promise<unknown> {
  if (!(FILM_CHANNEL_METHODS as readonly string[]).includes(frame.method)) fail("METHOD_NOT_ALLOWED", `未知通道方法 ${String(frame.method)}`);
  if (ctx.signal.aborted || Date.now() >= ctx.deadlineAt) fail("JOB_DEADLINE_EXCEEDED", "工位作业已关闭或超时");
  if (!workerAllows(ctx.worker, frame.method)) fail("METHOD_NOT_ALLOWED", `工位未登记能力 ${frame.method}`);
  const expectedComponent = FILM_CHANNEL_METHOD_COMPONENT[frame.method];
  if (frame.component !== expectedComponent) fail("FRAME_INVALID", "组件分类与方法不匹配");
  const selected = String(ctx.job.options.only ?? "").split(",").filter(Boolean);
  validateFilmChannelScope(frame, {
    stages: ctx.job.stages, projectId: ctx.job.project_id,
    shotIds: new Set([...ctx.shots.keys()].filter((id) => !selected.length || selected.includes(id))),
    frozen: ctx.frozen, options: ctx.job.options,
  });
  const actualHash = filmRequestHash({ method: frame.method, stepKey: frame.stepKey, shotId: frame.shotId, params: frame.params });
  if (actualHash !== frame.requestHash) fail("FRAME_INVALID", "请求哈希与参数不一致");
  if (frame.method === "video.generate") {
    await validateCharacterVideoSubmission(ctx, frame);
    await validateVideoReferences(ctx, frame);
  }
  if (frame.method === "media.fetch") await validateMediaFetchSource(ctx, frame);
  const identityReview = frame.method === "gate.review" && record(frame.params).identityReview !== undefined
    ? await prepareIdentityReview(ctx, frame) : undefined;
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
    return await abortable(ctx.signal, () => dispatchComponent(ctx, frame, component.id, identityReview));
  } catch (error) {
    const failureClass = error instanceof SubmissionError ? error.code.split(":")[0]! : "UNEXPECTED";
    await ledger.recordComponentFailure(component.id, ctx.ownerToken, {
      state: !(error instanceof SubmissionError) || /UNKNOWN|TIMEOUT|DEADLINE/.test(error.code) ? "unknown" : "failed",
      failureClass,
      evidence: { message: error instanceof Error ? error.message.slice(0, 400) : String(error).slice(0, 400) },
    }).catch(() => undefined);
    throw error;
  }
}

/** Validate the complete frozen step before reserving budget or dispatching a component. */
export function validateFilmChannelScope(frame: FilmChannelRequestFrame, scope: {
  stages: readonly string[]; projectId: string; shotIds: ReadonlySet<string>;
  frozen?: Record<string, unknown>; options?: Record<string, unknown>;
}): void {
  if (typeof frame.stepKey !== "string" || !frame.stepKey) fail("FRAME_INVALID", "通道调用缺少步骤键");
  const stage = frame.stepKey.split(":")[0]!;
  if (!scope.stages.includes(stage)) fail("STEP_OUT_OF_SCOPE", `步骤 ${frame.stepKey} 不在本次作业冻结阶段内`);
  if (frame.shotId !== null && (typeof frame.shotId !== "string" || !scope.shotIds.has(frame.shotId))) {
    fail("SHOT_NOT_FOUND", `镜号 ${String(frame.shotId)} 不在本次作业冻结镜头范围内`);
  }
  const expectedKey = frame.shotId === null ? stage : `${stage}:${frame.shotId}`;
  if (frame.stepKey !== expectedKey) fail("STEP_SHOT_MISMATCH", "步骤键与请求镜号不一致");
  const methodStages: Record<string, readonly string[]> = {
    "llm.chat": ["cover"], "image.generate": ["plates"],
    "video.generate": ["videos", "material-gen"], "media.fetch": ["plates", "videos", "material-gen"],
    "voice.dub": ["voice"], "voice.verify": ["voice"],
  };
  if (frame.method === "gate.review") {
    const params = record(frame.params);
    const reviewStage = text(params.stage, "gate.review 需要 stage", 64);
    const aliases: Record<string, readonly string[]> = { script: ["spec"], prompt: ["spec"], keyframe: ["plates"], shot: ["videos", "material-gen"] };
    if (!(aliases[reviewStage] ?? [reviewStage]).includes(stage)) fail("METHOD_STAGE_MISMATCH", "评审阶段与冻结步骤不一致");
    if (params.projectId !== scope.projectId) fail("REVIEW_SCOPE_INVALID", "评审项目必须与冻结作业一致");
    const context = params.context === undefined ? {} : record(params.context);
    if ((context.shotId ?? null) !== frame.shotId) fail("REVIEW_SCOPE_INVALID", "评审镜号必须与请求作用域一致");
    if (reviewStage === "shot" && context.sourceStage !== undefined && context.sourceStage !== stage) {
      fail("REVIEW_SCOPE_INVALID", "评审来源阶段必须与冻结步骤一致");
    }
  } else if (!methodStages[frame.method]?.includes(stage)) {
    fail("METHOD_STAGE_MISMATCH", `方法 ${frame.method} 不属于阶段 ${stage}`);
  }
  if (["image.generate", "video.generate", "voice.dub", "voice.verify"].includes(frame.method) && frame.shotId === null) {
    fail("SHOT_NOT_FOUND", "逐镜组件需要冻结镜号");
  }
  if (scope.frozen && ["video.generate", "voice.dub", "voice.verify"].includes(frame.method)) {
    const shot = (Array.isArray(scope.frozen.shots) ? scope.frozen.shots : []).map(record).find(row => row.shotId === frame.shotId);
    if (!shot) fail("SHOT_NOT_FOUND", "组件镜号不在冻结原稿");
    let audio: ReturnType<typeof resolveFilmAudioContract>;
    try { audio = resolveFilmAudioContract({ ...shot, shotId: frame.shotId! }); }
    catch (error) { fail("AUDIO_SOURCE_INVALID", error instanceof Error ? error.message : "冻结音频合同无效"); }
    const params = record(frame.params);
    if (frame.method === "voice.dub" && audio.mode === "native-dialogue") fail("AUDIO_NATIVE_SOURCE_REPLACED", "父服务拒绝后配替换出镜同源对白");
    if (frame.method.startsWith("voice.")) {
      if (audio.mode === "none") fail("AUDIO_NO_DIALOGUE", "无台词镜头不能调用配音或语音核验");
      const actual = frame.method === "voice.dub" ? params.text : params.expectText;
      if (typeof actual !== "string" || actual.trim().replace(/\s+/g, " ") !== audio.text.trim().replace(/\s+/g, " ")) fail("AUDIO_TEXT_MISMATCH", "语音请求台词与冻结原稿不一致");
    } else {
      if (typeof params.generateAudio !== "boolean") fail("REQUEST_INVALID", "生成音频标志必须显式为布尔值");
      if (audio.mode === "native-dialogue" && !params.generateAudio) fail("AUDIO_NATIVE_GENERATION_REQUIRED", "出镜对白必须生成原生音频");
      const aspect = scope.options?.aspect ?? scope.frozen.aspect ?? "9:16";
      const requestedResolution = scope.options?.resolution ?? scope.frozen.resolution ?? "1080p";
      const resolution = requestedResolution === "2160p" ? "1080p" : requestedResolution;
      if (params.aspect !== aspect || params.resolution !== resolution) fail("FORMAT_FROZEN_MISMATCH", "生成画幅/源分辨率与冻结作业不一致");
      const duration = Number(shot.duration ?? shot.durationSec ?? shot.durationSeconds);
      const expectedSeconds = Math.min(12, Math.max(4, Math.round(duration)));
      if (!Number.isFinite(duration) || duration <= 0 || params.seconds !== expectedSeconds) fail("DURATION_FROZEN_MISMATCH", "生成时长与冻结镜头不一致");
      if (!Array.isArray(params.refs) || params.refs.length > 3) fail("REFERENCE_LIMIT_EXCEEDED", "视频引用最多3张，禁止静默截断");
      if (params.refs.some(ref => typeof ref !== "string" || !ref) || new Set(params.refs).size !== params.refs.length) fail("REQUEST_INVALID", "视频引用为空、重复或格式非法");
      if (params.firstFrame !== undefined) {
        const first = record(params.firstFrame);
        const keys = Object.keys(first);
        if (keys.length !== 1 || !["ref", "hostedUrl"].includes(keys[0]!) || typeof first[keys[0]!] !== "string" || !String(first[keys[0]!]).trim())
          fail("REQUEST_INVALID", "firstFrame必须独占提供ref或hostedUrl");
      }
    }
  }
}
function abortable<T>(signal: AbortSignal, work: () => Promise<T>): Promise<T> {
  if (signal.aborted) return Promise.reject(new SubmissionError("JOB_DEADLINE_EXCEEDED", "作业已关闭；调用按未核实处理"));
  return new Promise((resolve, reject) => {
    const aborted = (): void => reject(new SubmissionError("JOB_DEADLINE_EXCEEDED", "作业已关闭；在途调用按未核实处理"));
    signal.addEventListener("abort", aborted, { once: true });
    work().then(resolve, reject).finally(() => signal.removeEventListener("abort", aborted));
  });
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

async function dispatchComponent(ctx: RunContext, frame: FilmChannelRequestFrame, componentId: string, identityReview?: PreparedIdentityReview): Promise<unknown> {
  switch (frame.method) {
    case "llm.chat": return runLlm(ctx, frame, componentId);
    case "image.generate": return runImage(ctx, frame, componentId);
    case "media.fetch": return runMediaFetch(ctx, frame, componentId);
    case "video.generate": return runVideo(ctx, frame, componentId);
    case "gate.review": return runGateReview(ctx, frame, componentId, identityReview);
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
  await ctx.ledger.recordDispatch(componentId, ctx.ownerToken, "model-router", scene);
  const content = await abortable(ctx.signal, () => call(system ? `${system}\n\n${prompt}` : prompt));
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
  const response = await fetch(url, { signal: AbortSignal.any([ctx.signal, AbortSignal.timeout(300_000)]), redirect: "error" }).catch((error) => {
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

async function validateVideoReferences(ctx: RunContext, frame: FilmChannelRequestFrame): Promise<void> {
  const params = record(frame.params);
  await resolveWithin(ctx.workDir, text(params.targetRef, "视频缺targetRef", 1_000));
  if (params.firstFrame !== undefined) {
    const first = record(params.firstFrame);
    let frameRef: string;
    if (first.hostedUrl !== undefined) {
      const url = text(first.hostedUrl, "首帧hostedUrl非法", 8_192);
      requireIssuedUrl(ctx, url, frame);
      const issued = ctx.issuedUrls.get(url)!;
      frameRef = issued.artifact.ref;
      const bytes = await readJobBytes(ctx, issued.artifact.ref);
      if (sha256Bytes(bytes) !== issued.artifact.sha256 || bytes.byteLength !== issued.artifact.bytes) fail("REFERENCE_CHANGED", "已签发首帧字节发生变化");
    } else { frameRef = text(first.ref, "首帧ref非法", 1_000); await readJobBytes(ctx, frameRef); }
    let dimensions: { width: number; height: number };
    try {
      const probe = JSON.parse(await reviewMediaTool(ctx, "ffprobe", ["-v", "error", "-show_entries", "stream=width,height", "-of", "json", await resolveWithin(ctx.workDir, frameRef)]));
      dimensions = { width: Number(probe.streams?.[0]?.width), height: Number(probe.streams?.[0]?.height) };
    } catch { fail("REFERENCE_UNVERIFIED", "父服务无法独立核验实际首帧尺寸"); }
    const [width, height] = String(params.aspect).split(":").map(Number);
    if (!(dimensions!.width > 0 && dimensions!.height > 0 && width! > 0 && height! > 0)
      || Math.abs(dimensions!.width / dimensions!.height - width! / height!) > 0.005)
      fail("REFERENCE_ASPECT_MISMATCH", "实际首帧画幅与冻结影片画幅不一致");
  }
  for (const raw of params.refs as string[]) {
    if (/^asset:\/\//.test(raw)) {
      const source = registeredCharactersFor(ctx);
      if (source.contract.status !== "passed" || !source.contract.shots.find(shot => shot.shotId === frame.shotId)?.referenceAssets.includes(raw))
        fail("ASSET_NOT_BOUND", "参考asset不属于冻结镜头的登记授权组");
    } else await readJobBytes(ctx, raw);
  }
}

async function validateMediaFetchSource(ctx: RunContext, frame: FilmChannelRequestFrame): Promise<void> {
  const params = record(frame.params);
  if ((params.url !== undefined) === (params.ref !== undefined)) fail("REQUEST_INVALID", "media.fetch必须独占提供url或ref");
  await resolveWithin(ctx.workDir, text(params.targetRef, "media.fetch缺targetRef", 1_000));
  const targetReceipt = ctx.videoFiles.get(String(params.targetRef));
  if (targetReceipt && params.targetRef === targetReceipt.artifact.ref) fail("MEDIA_PROVIDER_SOURCE_PROTECTED", "后期复制与变速不能覆盖保留的供应商原档");
  if (params.url !== undefined) {
    const url = text(params.url, "media.fetch url非法", 8_192);
    requireIssuedUrl(ctx, url, frame);
    const issued = ctx.issuedUrls.get(url)!;
    const receipt = ctx.videoFiles.get(issued.artifact.ref);
    if (receipt) await requireCurrentVideoSource(ctx, issued.artifact.ref, receipt.shotId);
    else {
      const bytes = await readJobBytes(ctx, issued.artifact.ref, MEDIA_FETCH_LIMIT_BYTES);
      if (sha256Bytes(bytes) !== issued.artifact.sha256 || bytes.byteLength !== issued.artifact.bytes) fail("MEDIA_SOURCE_CHANGED", "已受理供应商产物的本地原档字节发生变化");
    }
  }
  else {
    const ref = text(params.ref, "media.fetch ref非法", 1_000);
    const receipt = ctx.videoFiles.get(ref);
    if (receipt) await requireCurrentVideoSource(ctx, ref, receipt.shotId);
    else await readJobBytes(ctx, ref, MEDIA_FETCH_LIMIT_BYTES);
    if (params.normalizeToSeconds !== undefined) {
      const shot = ctx.shots.get(frame.shotId ?? "");
      const duration = Number(shot?.duration ?? shot?.durationSec ?? shot?.durationSeconds);
      if (!receipt || receipt.shotId !== frame.shotId || params.normalizeToSeconds !== duration || !Number.isFinite(duration) || duration <= 0
        || params.targetRef === receipt.artifact.ref) fail("MEDIA_NORMALIZATION_SCOPE_INVALID", "时长归一必须绑定冻结镜头、受理原片且保留供应商原档");
    }
  }
  if (params.normalizeToSeconds !== undefined && params.url !== undefined) fail("MEDIA_NORMALIZATION_SCOPE_INVALID", "时长归一仅接受本作业当前已核验的本地视频");
}

async function anchorsToDataUrls(ctx: RunContext, refs: unknown): Promise<string[]> {
  if (refs === undefined) return [];
  if (!Array.isArray(refs) || refs.length > 4) fail("REQUEST_INVALID", "anchors 最多 4 个作业内引用");
  const out: string[] = [];
  for (const ref of refs) {
    const pathRef = text(ref, "anchors 必须是作业内相对路径", 1_000);
    if (/^asset:\/\/[A-Za-z0-9._-]+$/.test(pathRef)) {
      const contains = (value: unknown): boolean => value === pathRef || Boolean(value && typeof value === "object" && Object.values(value).some(contains));
      if (!contains(ctx.frozen)) fail("ASSET_NOT_BOUND", "授权素材没有绑定冻结原稿");
      out.push(pathRef);
      continue;
    }
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
  ctx.issuedUrls.set(polled.uri, { stepKey: frame.stepKey, shotId: frame.shotId, artifact: written });
  ctx.log(`出图完成 ${frame.shotId ?? frame.stepKey} → ${written.ref}（${written.bytes}B）`);
  return { ...written, hostedUrl: polled.uri, provider: "seedream", providerModel: model };
}

async function runMediaFetch(ctx: RunContext, frame: FilmChannelRequestFrame, componentId: string): Promise<unknown> {
  const params = record(frame.params);
  if ((params.url !== undefined) === (params.ref !== undefined)) fail("REQUEST_INVALID", "media.fetch必须独占提供url或ref");
  const targetRef = text(params.targetRef, "media.fetch 需要 targetRef", 1_000);
  await resolveWithin(ctx.workDir, targetRef);
  await ctx.ledger.recordDispatch(componentId, ctx.ownerToken, "local", "media-fetch");
  let written: { ref: string; sha256: string; bytes: number };
  let sourceReceipt: FilmVideoSubmissionReceipt | undefined;
  let normalization: { factor: number; from: number; to: number } | undefined;
  if (params.url !== undefined) {
    const url = text(params.url, "media.fetch 的 url 非法", 8_192);
    requireIssuedUrl(ctx, url, frame);
    const issued = ctx.issuedUrls.get(url)!;
    written = await fetchToFile(ctx, url, targetRef);
    if (written.sha256 !== issued.artifact.sha256 || written.bytes !== issued.artifact.bytes)
      fail("MEDIA_SOURCE_CHANGED", "重新下载的供应商产物与本作业已受理字节不一致");
    sourceReceipt = ctx.videoFiles.get(issued.artifact.ref);
    if (sourceReceipt) {
      await requireCurrentVideoSource(ctx, issued.artifact.ref, sourceReceipt.shotId);
    }
  } else if (params.ref !== undefined) {
    const sourceRef = text(params.ref, "media.fetch 的 ref 非法", 1_000);
    sourceReceipt = ctx.videoFiles.get(sourceRef);
    if (sourceReceipt) await requireCurrentVideoSource(ctx, sourceRef, sourceReceipt.shotId);
    if (params.normalizeToSeconds !== undefined) {
      const targetSec = Number(params.normalizeToSeconds);
      const source = await resolveWithin(ctx.workDir, sourceRef);
      const temporaryRef = `${targetRef}.normalize-${randomUUID()}.mp4`;
      const temporary = await resolveWithin(ctx.workDir, temporaryRef);
      await mkdir(path.dirname(temporary), { recursive: true });
      try {
        const probe = JSON.parse(await reviewMediaTool(ctx, "ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "json", source]));
        const from = Number(probe.format?.duration);
        if (!Number.isFinite(from) || from <= 0) fail("MEDIA_NORMALIZATION_FAILED", "源视频时长无效");
        const factor = Number((targetSec / from).toFixed(6));
        const chain: string[] = [];
        let remaining = 1 / factor;
        while (remaining > 2) { chain.push("atempo=2"); remaining /= 2; }
        while (remaining < 0.5) { chain.push("atempo=0.5"); remaining /= 0.5; }
        chain.push(`atempo=${remaining.toFixed(6)}`);
        await reviewMediaTool(ctx, "ffmpeg", ["-v", "error", "-y", "-i", source, "-vf", `setpts=PTS*${factor.toFixed(6)}`,
          "-af", chain.join(","), "-t", targetSec.toFixed(3), "-c:v", "libx264", "-preset", "medium", "-crf", "18", "-pix_fmt", "yuv420p",
          "-c:a", "aac", "-b:a", "192k", "-ar", "48000", "-ac", "2", "-movflags", "+faststart", temporary], 120_000);
        await requireCurrentVideoSource(ctx, sourceRef, sourceReceipt!.shotId);
        written = await writeJobBytes(ctx, targetRef, await readJobBytes(ctx, temporaryRef, MEDIA_FETCH_LIMIT_BYTES));
        const result = JSON.parse(await reviewMediaTool(ctx, "ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "json", await resolveWithin(ctx.workDir, targetRef)]));
        const to = Number(result.format?.duration);
        if (!Number.isFinite(to) || Math.abs(to - targetSec) > 0.1) fail("MEDIA_NORMALIZATION_FAILED", "时长归一结果与冻结镜头不一致");
        normalization = { factor, from: Number(from.toFixed(3)), to: Number(to.toFixed(3)) };
      } finally { await rm(temporary, { force: true }).catch(error => ctx.log(`归一化临时文件清理失败：${String(error)}`)); }
    } else {
      const bytes = await readJobBytes(ctx, sourceRef, MEDIA_FETCH_LIMIT_BYTES);
      written = await writeJobBytes(ctx, targetRef, bytes);
    }
  } else {
    return fail("REQUEST_INVALID", "media.fetch 需要 url 或 ref");
  }
  await ctx.ledger.recordComponentAccepted(componentId, ctx.ownerToken, {
    provider: "local", providerModel: "media-fetch", actualCny: 0,
    evidence: { artifactSha256: written.sha256, artifactRef: written.ref, artifactBytes: written.bytes,
      ...(normalization ? { normalization, sourceReceipt } : {}) },
  });
  if (sourceReceipt) {
    ctx.videoFiles.set(written.ref, sourceReceipt);
    (ctx.videoArtifacts ??= new Map()).set(written.ref, written);
  }
  return { ...written, ...(normalization ? { normalization } : {}) };
}

async function runVideo(ctx: RunContext, frame: FilmChannelRequestFrame, componentId: string): Promise<unknown> {
  const params = record(frame.params);
  const prompt = text(params.prompt, "video.generate 需要非空 prompt", 30_000);
  const seconds = Number(params.seconds);
  if (!Number.isInteger(seconds) || seconds <= 0 || seconds > 30) fail("REQUEST_INVALID", "video.generate 的 seconds 必须是 1–30 的整数");
  if (typeof params.generateAudio !== "boolean") fail("REQUEST_INVALID", "video.generate必须显式提供布尔generateAudio");
  const generateAudio = params.generateAudio;
  const aspect = text(params.aspect, "video.generate需要画幅", 16);
  const resolution = text(params.resolution, "video.generate需要源分辨率", 16);
  const targetRef = text(params.targetRef, "video.generate 需要 targetRef", 1_000);
  await resolveWithin(ctx.workDir, targetRef);
  const firstFrame = params.firstFrame === undefined ? undefined : record(params.firstFrame);
  let firstFrameUrl: string | undefined;
  const referenceInputs: FilmVideoReferenceInput[] = [];
  if (firstFrame?.hostedUrl !== undefined) {
    const url = text(firstFrame.hostedUrl, "firstFrame.hostedUrl 非法", 8_192);
    requireIssuedUrl(ctx, url, frame);
    const issued = ctx.issuedUrls.get(url)!;
    const bytes = await readJobBytes(ctx, issued.artifact.ref);
    if (sha256Bytes(bytes) !== issued.artifact.sha256 || bytes.length !== issued.artifact.bytes) fail("REFERENCE_CHANGED", "已签发首帧字节发生变化");
    referenceInputs.push({ role: "first-frame", ref: issued.artifact.ref, sha256: issued.artifact.sha256, hashKind: "bytes", requestUriSha256: sha256Bytes(url) });
    firstFrameUrl = url;
  } else if (firstFrame?.ref !== undefined) {
    const ref = text(firstFrame.ref, "firstFrame.ref 非法", 1_000);
    const bytes = await readJobBytes(ctx, ref);
    referenceInputs.push({ role: "first-frame", ref, sha256: sha256Bytes(bytes), hashKind: "bytes" });
    firstFrameUrl = dataUrlFor(ref, bytes);
  }
  if (!Array.isArray(params.refs) || params.refs.length > 3) fail("REFERENCE_LIMIT_EXCEEDED", "视频引用最多3张，禁止静默截断");
  const refs: string[] = [];
  for (const rawRef of params.refs) {
    const ref = text(rawRef, "视频参考引用非法", 1_000);
    if (/^asset:\/\//.test(ref)) {
      const source = registeredCharactersFor(ctx);
      const registered = source.contract.shots.find(shot => shot.shotId === frame.shotId);
      if (source.contract.status !== "passed" || !registered?.referenceAssets.includes(ref)) fail("ASSET_NOT_BOUND", "参考asset不属于冻结镜头的登记授权组");
      refs.push(ref); referenceInputs.push({ role: "reference-image", ref, sha256: sha256Bytes(ref), hashKind: "asset-uri" });
    } else {
      const bytes = await readJobBytes(ctx, ref);
      refs.push(dataUrlFor(ref, bytes)); referenceInputs.push({ role: "reference-image", ref, sha256: sha256Bytes(bytes), hashKind: "bytes" });
    }
  }
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
      resolution,
      ...(firstFrameUrl ? {} : { aspectRatio: aspect }),
      ...(firstFrameUrl ? { firstFrameUrl } : {}),
      ...(refs.length ? { referenceImageUrls: refs } : {}),
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
    if (ctx.signal.aborted) fail("PROVIDER_TIMEOUT_UNKNOWN", "作业截止，供应商任务需要对账");
    await new Promise((resolve) => setTimeout(resolve, VIDEO_POLL_INTERVAL_MS));
    last = await provider.poll(submitted.taskId);
    if (last.status === "succeeded" || last.status === "failed") break;
  }
  if (last.status !== "succeeded" || !last.uri) {
    fail(last.status === "failed" ? "PROVIDER_FAILED" : "PROVIDER_TIMEOUT_UNKNOWN", `出片未成功：${last.error ?? last.status}`);
  }
  const written = await fetchToFile(ctx, last.uri, targetRef);
  const submissionReceipt = buildFilmVideoSubmissionReceipt({ jobId: ctx.job.id, projectId: ctx.job.project_id,
    inputSha256: ctx.job.input_sha256, shotId: frame.shotId!, stepKey: frame.stepKey, requestHash: frame.requestHash,
    providerRequestHash: compiled.payloadHash, taskId: submitted.taskId, artifact: written, promptSha256: sha256Bytes(prompt),
    referenceInputs, aspect, resolution, seconds, generateAudio });
  const evidence: Record<string, unknown> = {
    artifactSha256: written.sha256,
    artifactRef: written.ref,
    artifactBytes: written.bytes,
    providerTaskId: submitted.taskId,
    providerRequestHash: compiled.payloadHash,
    durationMs: Date.now() - started,
    seconds,
    generateAudio,
    submissionReceipt,
  };
  ctx.log(`出片完成 ${frame.shotId ?? frame.stepKey} → ${written.ref}（${written.bytes}B，${seconds}s）`);
  await ctx.ledger.recordComponentAccepted(componentId, ctx.ownerToken, {
    provider: "seedance", providerModel: model, actualCny: null, evidence,
  });
  ctx.issuedUrls.set(last.uri, { stepKey: frame.stepKey, shotId: frame.shotId, artifact: written });
  ctx.videoFiles.set(written.ref, submissionReceipt);
  (ctx.videoArtifacts ??= new Map()).set(written.ref, written);
  return { ...written, taskId: submitted.taskId, hostedUrl: last.uri, provider: "seedance", providerModel: model, submissionReceipt };
}

interface PreparedIdentityReview {
  request: CharacterIdentityReviewRequest;
  clipRef: string;
  contracts: ReturnType<typeof filmReviewContracts>;
}

async function reviewMediaTool(ctx: RunContext, kind: "ffmpeg" | "ffprobe", args: string[], timeout = 30_000): Promise<string> {
  const executable = kind === "ffmpeg" ? ctx.env.WL_FFMPEG ?? ctx.env.FFMPEG_PATH ?? "ffmpeg"
    : ctx.env.WL_FFPROBE ?? ctx.env.FFPROBE_PATH ?? "ffprobe";
  return new Promise((resolve, reject) => {
    execFile(executable, args, { timeout, maxBuffer: 2 * 1024 * 1024, env: ctx.env, signal: ctx.signal }, (error, stdout) => {
      if (error) reject(new SubmissionError("IDENTITY_MEDIA_UNVERIFIED", "父服务无法独立探测视频或重建实际评审帧"));
      else resolve(String(stdout));
    });
  });
}

/** Reconstruct from registered sources and actual current provider bytes before reserving model budget. */
async function prepareIdentityReview(ctx: RunContext, frame: FilmChannelRequestFrame): Promise<PreparedIdentityReview> {
  const params = record(frame.params);
  const identity = record(params.identityReview);
  const context = record(params.context);
  if (params.stage !== "shot" || !frame.shotId || identity.purpose !== "identity-and-explicit-wardrobe"
    || context.purpose !== "identity-and-explicit-wardrobe") fail("IDENTITY_REVIEW_SCOPE_INVALID", "专用人物评审用途或镜号非法");
  if (!resolveProducerLlm(ctx.env)) fail("CHARACTER_VISION_UNAVAILABLE", "专用人物视觉模型不可用");
  const source = registeredCharactersFor(ctx);
  if (source.contract.status !== "passed") fail("CHARACTER_RENDER_PREFLIGHT_BLOCKED", "当前登记人物合同无效");
  const clipRef = text(identity.clipRef, "专用评审缺视频引用", 1_000);
  const clipPath = await resolveWithin(ctx.workDir, clipRef);
  const receipt = await requireCurrentVideoSource(ctx, clipRef, frame.shotId);
  // The actual prompt lock was checked at submission; here the private receipt, not child prose, owns its digest.
  if (receipt.referenceInputs.filter(ref => ref.role === "reference-image").map(ref => ref.ref).join("\n")
    !== source.contract.shots.find(shot => shot.shotId === frame.shotId)?.referenceAssets.join("\n"))
    fail("IDENTITY_SOURCE_UNBOUND", "供应商受理引用没有绑定当前人物授权组");
  if (!Array.isArray(identity.frames) || identity.frames.length !== 2) fail("IDENTITY_FRAMES_INVALID", "专用人物评审需要两个父服务可重建的时间帧");
  let duration: number;
  try {
    const probe = JSON.parse(await reviewMediaTool(ctx, "ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "json", clipPath]));
    duration = Number(probe.format?.duration);
  } catch (error) {
    if (error instanceof SubmissionError) throw error;
    fail("IDENTITY_MEDIA_UNVERIFIED", "父服务视频时长探测结果无效");
  }
  if (!Number.isFinite(duration!) || duration! <= 0) fail("IDENTITY_MEDIA_UNVERIFIED", "父服务视频时长无效");
  const expectedTimes = [duration! * 0.2, duration! * 0.75];
  const dir = await mkdtemp(path.join(tmpdir(), "film-parent-identity-"));
  const frames: CharacterIdentityReviewRequest["frames"] = [];
  try {
    for (const [index, raw] of identity.frames.entries()) {
      const input = record(raw);
      const ref = text(input.ref, "专用评审帧引用非法", 1_000);
      if (input.atSec !== expectedTimes[index]) fail("IDENTITY_FRAMES_INVALID", "抽帧时间没有绑定当前视频独立时长");
      const currentBytes = await readJobBytes(ctx, ref);
      const output = path.join(dir, `sample-${index}.jpg`);
      await reviewMediaTool(ctx, "ffmpeg", ["-v", "error", "-y", "-ss", String(expectedTimes[index]), "-i", clipPath,
        "-frames:v", "1", "-vf", "scale=720:-2", output]);
      const rebuilt = await readFile(output);
      const sha256 = sha256Bytes(rebuilt);
      if (input.sha256 !== sha256 || sha256Bytes(currentBytes) !== sha256) fail("IDENTITY_FRAME_SOURCE_MISMATCH", "送审帧与父服务从当前视频独立重建的字节不一致");
      frames.push({ path: await resolveWithin(ctx.workDir, ref), sha256, atSec: expectedTimes[index]! });
    }
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(error => ctx.log(`父服务临时抽帧清理失败：${error instanceof Error ? error.message : String(error)}`));
  }
  const contracts = filmReviewContracts(ctx.contractSource, frame.shotId);
  const request = buildCharacterIdentityReviewRequest({ contract: source.contract, shotId: frame.shotId,
    clip: { path: clipPath, sha256: sha256Bytes(await readJobBytes(ctx, clipRef, MEDIA_FETCH_LIMIT_BYTES)) }, promptSha256: receipt.promptSha256, frames,
    producerContractHash: buildProducerReviewContract(contracts).contractHash });
  const referenceBytes = await readJobBytes(ctx, text(identity.referenceRef, "缺基准图作业内引用", 1_000));
  if (sha256Bytes(referenceBytes) !== request.referenceImage.sha256) fail("IDENTITY_REFERENCE_MISMATCH", "子进程基准图副本与父服务登记原图不同");
  if (identity.requestHash !== request.requestHash || filmCanonicalJson(identity.request) !== filmCanonicalJson(request))
    fail("IDENTITY_REQUEST_MISMATCH", "子进程人物请求与父服务登记源、当前视频及实际帧重建结果不一致");
  return { request, contracts, clipRef };
}

async function runIdentityReview(ctx: RunContext, componentId: string, prepared: PreparedIdentityReview): Promise<unknown> {
  const { request, contracts } = prepared;
  await ctx.ledger.recordDispatch(componentId, ctx.ownerToken, "workloom.producer-gate", "identity-and-explicit-wardrobe");
  const verdict = await reviewCharacterVisualStage({ stage: "shot", projectId: ctx.job.project_id, contracts,
    rubric: request.rubric, artifacts: [{ path: request.clip.path, kind: "video" }, ...request.frames.map(frame => ({ path: frame.path, kind: "image" as const }))],
    referenceImages: [request.referenceImage.path], deterministic: [{ id: "identity-source-current", pass: true, hard: true, detail: request.requestHash }],
    context: { ...request.context, shotId: request.shotId, identityRequestHash: request.requestHash, filmJobId: ctx.job.id },
    env: ctx.env, batchSize: 12, allowFallbackApprove: false, log: ctx.log });
  await requireCurrentVideoSource(ctx, prepared.clipRef, request.shotId);
  registeredCharactersFor(ctx);
  for (const input of [...request.frames, request.referenceImage]) {
    if (sha256Bytes(await readFile(input.path)) !== input.sha256) fail("IDENTITY_SOURCE_CHANGED", "专用视觉评审期间帧或登记基准发生变化");
  }
  const identityEvidence = adaptCharacterVisualVerdict({ request, verdict });
  await ctx.ledger.recordComponentAccepted(componentId, ctx.ownerToken, { provider: "workloom.producer-gate",
    providerModel: verdict.model ?? "identity-and-explicit-wardrobe", actualCny: null,
    evidence: { artifactSha256: sha256Bytes(filmCanonicalJson(identityEvidence)), identityEvidence,
      reviewPolicy: "dedicated-identity", originalOpinion: { approved: verdict.approved, status: verdict.status, reason: verdict.reason } } });
  ctx.identityEvidence.set(request.shotId, identityEvidence);
  return { identityEvidence };
}

async function runGateReview(ctx: RunContext, frame: FilmChannelRequestFrame, componentId: string, identityReview?: PreparedIdentityReview): Promise<unknown> {
  if (identityReview) return runIdentityReview(ctx, componentId, identityReview);
  const params = record(frame.params);
  const stage = text(params.stage, "gate.review 需要 stage", 64);
  const artifacts = Array.isArray(params.artifacts) ? params.artifacts : [];
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
      ...(artifact.probe && typeof artifact.probe === "object" ? { probe: record(artifact.probe) } : {}),
      ...(typeof artifact.note === "string" ? { note: artifact.note.slice(0, 500) } : {}),
    });
  }
  const deterministic = (Array.isArray(params.deterministic) ? params.deterministic : []).slice(0, 40).map((raw) => {
    const check = record(raw);
    return {
      id: text(check.id, "deterministic.id 非法", 120),
      pass: check.pass === true,
      ...(check.status === "failed" || check.status === "unverified" || check.status === "passed" || check.status === "not_applicable" ? { status: check.status } : {}),
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
  if ((context.shotId ?? null) !== frame.shotId) fail("REVIEW_SCOPE_INVALID", "评审镜号必须与请求作用域一致");
  const referenceImages = [];
  for (const ref of Array.isArray(params.referenceImages) ? params.referenceImages.slice(0, 4) : []) {
    const file = await resolveWithin(ctx.workDir, text(ref, "评审参考图引用非法", 1_000));
    if (!within(ctx.workDir, await realpath(file))) fail("PATH_INVALID", "评审参考图越出作业目录");
    referenceImages.push(file);
  }
  await ctx.ledger.recordDispatch(componentId, ctx.ownerToken, "workloom.producer-gate", stage);
  const options: Omit<ProducerGateOptions, "contracts"> = {
    stage: stage as Parameters<typeof reviewFilmStage>[1]["stage"],
    projectId: ctx.job.project_id,
    artifacts: resolvedArtifacts,
    deterministic: deterministic as ProducerGateOptions["deterministic"],
    referenceImages,
    ...(requiredCheckIds ? { requiredCheckIds } : {}),
    ...(minScore === undefined ? {} : { minScore }),
    ...(rubric ? { rubric } : {}),
    context: { ...context, filmJobId: ctx.job.id, attempt: Number(ctx.job.attempt), stepKey: frame.stepKey },
    env: ctx.env,
  };
  const policy = ctx.job.options["review-policy"] ?? "off";
  const verdict = await reviewFilmStage(ctx.contractSource, options, policy === "off" ? async (reviewOptions): Promise<ProducerVerdict> => {
    const contractHash = buildProducerReviewContract(filmReviewContracts(ctx.contractSource, frame.shotId ?? undefined)).contractHash;
    const hardFailures = reviewOptions.deterministic.filter((check) => check.hard && (check.pass !== true || check.status === "unverified" || check.status === "failed"))
      .map((check) => `${check.id}：${check.detail}`);
    const missing = (reviewOptions.requiredCheckIds ?? []).filter((id) => !reviewOptions.deterministic.some((check) => check.id === id && check.pass === true));
    hardFailures.push(...missing.map((id) => `${id}：缺少实测检查`));
    if (!resolvedArtifacts.length) hardFailures.push("缺少可读产物");
    return { stage: reviewOptions.stage, contractHash, approved: !hardFailures.length, status: hardFailures.length ? "failed" : "passed", score: hardFailures.length ? 0 : 100,
      hardFailures, issues: reviewOptions.deterministic.filter((check) => !check.pass).map((check) => check.detail), suggestions: [], rerun: Boolean(hardFailures.length),
      via: "deterministic", ms: 0, reason: hardFailures.length ? "事实性交付检查未通过" : "冻结合同与事实性交付检查通过；画面质量由客户验收", degraded: false };
  } : undefined);
  const effectiveVerdict = policy === "advisory" && verdict.hardFailures.length === 0 && verdict.contractHash
    ? { ...verdict, approved: true, status: "passed" as const, rerun: false, degraded: false, reason: `[advisory] ${verdict.reason}` } : verdict;
  await ctx.ledger.recordComponentAccepted(componentId, ctx.ownerToken, {
    provider: "workloom.producer-gate",
    providerModel: String((verdict as { model?: unknown }).model ?? stage),
    actualCny: null,
    evidence: {
      artifactSha256: sha256Bytes(canonicalRenderJson({ stage, approved: effectiveVerdict.approved, status: effectiveVerdict.status,
        contractHash: effectiveVerdict.contractHash ?? null })),
      approved: effectiveVerdict.approved,
      status: effectiveVerdict.status,
      contractHash: effectiveVerdict.contractHash ?? null,
      score: effectiveVerdict.score ?? null,
      reviewPolicy: policy,
      originalOpinion: { approved: verdict.approved, status: verdict.status, reason: verdict.reason },
    },
  });
  return effectiveVerdict;
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
