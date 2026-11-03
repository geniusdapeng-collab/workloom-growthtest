#!/usr/bin/env tsx
/** Continue a formal Studio run through qualified generation and unchanged native post. */
import { createHash, randomUUID } from "node:crypto";
import { createWriteStream } from "node:fs";
import { link, lstat, mkdir, open, readFile, realpath, rename, rm } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { getCoverSpec } from "../../packages/video-studio/src/cover-platforms.js";
import { ProductionClient, renderServiceProject } from "../../packages/video-studio/src/production-client.js";
import {
  readVideoJob, requestVideoProcedure, validateFormalVideoSource, verifyVideoJobBinding, verifyVideoSession,
} from "../workloom-video.mjs";
import {
  captureOriginalRenderManifest, freezeOriginalSubmission, issueServiceOriginal, preflightStandardPostAssets, runStandardPost, standardPostFileHash, validateStandardPostSettings,
  type ServiceOriginalProof,
} from "./film-standard-post.mts";

const identifier = (value: unknown): value is string => typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value) && !value.includes("..");
const digest = (value: unknown): value is string => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
const encode = (value: unknown) => JSON.stringify(value);
const fail = (code: string, detail: string): never => { throw new Error(`${code}: ${detail}`); };
const missing = (error: unknown) => (error as NodeJS.ErrnoException)?.code === "ENOENT";

type Job = Awaited<ReturnType<typeof readVideoJob>>;
type Session = Awaited<ReturnType<typeof verifyVideoSession>>;
type RenderedOriginal = ServiceOriginalProof & { url: string };

function originalProof(value: unknown, shot: { shotId: string; durationSec: number; promptSha256: string }): RenderedOriginal | null {
  if (value === null) return null;
  const row = value as RenderedOriginal;
  if (!row || row.shotId !== shot.shotId || row.durationSec !== shot.durationSec || row.promptSha256 !== shot.promptSha256
    || ![row.qualificationId, row.jobId, row.assetId].every(identifier)
    || typeof row.taskId !== "string" || !row.taskId || row.taskId.length > 256 || /[\r\n\0]/u.test(row.taskId)
    || ![row.requestHash, row.payloadHash, row.sha256].every(digest)
    || !Number.isSafeInteger(row.bytes) || row.bytes < 1 || row.bytes > 300 * 1024 * 1024 || typeof row.url !== "string") {
    fail("ORIGINAL_UNVERIFIED", "服务的入库回执与正式镜头不一致");
  }
  return { shotId: row.shotId, durationSec: row.durationSec, promptSha256: row.promptSha256,
    qualificationId: row.qualificationId, requestHash: row.requestHash, payloadHash: row.payloadHash, jobId: row.jobId,
    taskId: row.taskId, assetId: row.assetId, sha256: row.sha256, bytes: row.bytes, url: row.url };
}

async function existingOriginal(path: string, proof: ServiceOriginalProof) {
  try {
    const stat = await lstat(path);
    if (!stat.isFile() || stat.size !== proof.bytes || await realpath(path) !== path || await standardPostFileHash(path) !== proof.sha256) {
      fail("ORIGINAL_BYTES_CHANGED", "本地原片与服务摘要不一致");
    }
    return true;
  } catch (error) {
    if (!missing(error)) throw error;
    return false;
  }
}

export async function downloadStudioOriginal(session: Session, original: RenderedOriginal, path: string) {
  if (await existingOriginal(path, original)) return;
  const url = new URL(original.url, session.origin);
  const expectedPrefix = `/media/video/${encodeURIComponent(session.binding.workspaceId)}/${original.sha256}`;
  if (!original.url.startsWith("/media/video/") || url.origin !== session.origin
    || ![".mp4", ".webm"].some(ext => url.pathname === expectedPrefix + ext)
    || !/^\?token=\d+\.[A-Za-z0-9_-]+$/u.test(url.search) || url.hash) {
    fail("ORIGINAL_URL_UNVERIFIED", "仅可从同一工作区的签名媒体仓下载");
  }
  const response = await session.fetcher(url, { method: "GET", redirect: "error", signal: AbortSignal.timeout(300_000) });
  if (!response.ok || !response.body) return fail("ORIGINAL_DOWNLOAD_FAILED", `媒体仓 HTTP ${response.status}`);
  const temp = `${path}.${randomUUID()}.part`;
  const sha = createHash("sha256");
  let bytes = 0;
  const meter = new Transform({ transform(chunk: Buffer, _encoding, callback) {
    bytes += chunk.length;
    if (bytes > original.bytes) return callback(new Error("ORIGINAL_BYTES_CHANGED: 原片超过入库字节数"));
    sha.update(chunk); callback(null, chunk);
  } });
  try {
    await pipeline(Readable.fromWeb(response.body as never), meter, createWriteStream(temp, { flags: "wx", mode: 0o600 }));
    if (bytes !== original.bytes || sha.digest("hex") !== original.sha256) fail("ORIGINAL_BYTES_CHANGED", "原片摘要不匹配");
    try { await link(temp, path); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST" || !await existingOriginal(path, original)) throw error; }
  } finally { await rm(temp, { force: true }); }
}

async function writeJournal(path: string, value: unknown, exclusive = false) {
  const temporary = exclusive ? path : `${path}.${randomUUID()}.tmp`;
  const handle = await open(temporary, "wx", 0o600);
  try {
    try { await handle.writeFile(encode(value) + "\n"); await handle.sync(); }
    finally { await handle.close(); }
    if (!exclusive) await rename(temporary, path);
    if (process.platform !== "win32") {
      const parent = await open(dirname(path), "r");
      try { await parent.sync(); } finally { await parent.close(); }
    }
  } finally { if (!exclusive) await rm(temporary, { force: true }); }
}

export async function deliverStudioVideo(options: {
  jobFile: string; workDir: string; model: string; maxEstimatedCny?: number; pollExisting?: boolean; postSettings: string; out: string;
}) {
  const requestedJob = resolve(options.jobFile);
  const jobFile = await realpath(requestedJob);
  if (jobFile !== requestedJob) fail("JOB_FILE_INVALID", "请使用同一工作单的规范路径");
  const job: Job = await readVideoJob(jobFile);
  if (job.phase !== "preproduction_submitted" || !identifier(job.projectId)) fail("FORMAL_JOB_REQUIRED", "工作单缺少正式运行");
  const session = await verifyVideoSession();
  verifyVideoJobBinding(job, session);
  const readSource = () => requestVideoProcedure(session, "video.production.shots", { projectId: job.projectId });
  const source = await readSource();
  const plan = validateFormalVideoSource(source, job);
  if (plan.shots.length > 100 || plan.shots.some(shot => !identifier(shot.shotId))) fail("SHOT_SCOPE_INVALID", "正式镜号或数量不支持");
  const readOriginals = async () => {
    const reply = await requestVideoProcedure(session, "video.production.originals", { projectId: job.projectId, modelId: options.model });
    if (reply?.modelId !== options.model || encode(validateFormalVideoSource(reply, job)) !== encode(plan)
      || !Array.isArray(reply.originals) || reply.originals.length !== plan.shots.length) {
      return fail("SOURCE_CHANGED", "当前入库证据不属于已核对的运行");
    }
    return plan.shots.map((shot, index) => originalProof(reply.originals[index], shot));
  };

  const output = resolve(options.out);
  try { await lstat(output); fail("OUTPUT_EXISTS", "标准后期需要新的输出目录"); }
  catch (error) { if (!missing(error)) throw error; }
  const settings = await realpath(resolve(options.postSettings));
  const settingsStat = await lstat(settings);
  if (!settingsStat.isFile() || settingsStat.size > 2 * 1024 * 1024) fail("POST_SETTINGS_INVALID", "后期设置应为不超过 2 MiB 的普通文件");
  const settingsBytes = await readFile(settings);
  const settingsSha256 = createHash("sha256").update(settingsBytes).digest("hex");
  const settingsDocument = JSON.parse(settingsBytes.toString("utf8"));
  if (settingsDocument?.schemaVersion !== "workloom.standard-post-settings/v1") fail("POST_SETTINGS_REQUIRED", "请使用已登记的标准后期设置");
  await mkdir(resolve(options.workDir), { recursive: true, mode: 0o700 });
  const productionRoot = await realpath(resolve(options.workDir));
  const clips = join(productionRoot, "clips", job.projectId);
  await mkdir(clips, { recursive: true, mode: 0o700 });
  if (await realpath(clips) !== clips) fail("WORK_DIR_INVALID", "原片目录经过符号链接");
  try { await lstat(output); fail("OUTPUT_EXISTS", "输出目录不能是生产工作目录或其父目录"); }
  catch (error) { if (!missing(error)) throw error; }
  const duration = plan.shots.reduce((sum, shot) => sum + shot.durationSec, 0);
  const platform = getCoverSpec(settingsDocument.cover?.platform);
  const document = { projectId: job.projectId, durationSeconds: job.durationSec ?? duration,
    aspect: platform.ratio, resolution: `${Math.min(platform.canvas.width, platform.canvas.height)}p`,
    studioSource: { ...job.binding, requestSha256: job.requestSha256, runId: job.runId, pipeline: job.pipeline, modelId: options.model,
      stageRunId: plan.stageRunId, attempt: plan.attempt, promptsSha256: plan.promptsSha256 },
    shots: plan.shots.map(shot => ({ shotId: shot.shotId, duration: shot.durationSec, promptSha256: shot.promptSha256 })),
  };
  await freezeOriginalSubmission({ productionRoot, projectId: job.projectId, bytes: Buffer.from(encode(document)) });

  let originals = await readOriginals();
  if (options.pollExisting && options.maxEstimatedCny !== undefined) fail("RENDER_MODE_CONFLICT", "恢复轮询与首次付费生成必须分别执行");
  if (options.pollExisting && originals.some(value => value === null)) {
    if (!session.access.actionPermissions.includes("workspace.write")) fail("WRITE_PERMISSION_REQUIRED", "当前成员缺少工作区写权限");
    await requestVideoProcedure(session, "video.render.poll", { projectId: job.projectId, limit: 100 }, { mutation: true });
    originals = await readOriginals();
  }
  const journal = join(dirname(jobFile), `${basename(jobFile)}.render-start.json`);
  if (originals.some(value => value === null)) {
    if (options.maxEstimatedCny === undefined) fail("ORIGINALS_PENDING", "还缺少正式原片。继续既有任务须回读其供应商状态；首轮生成须给出已授权金额上限。");
    if (source.referenceMode !== "text-only") {
      fail("REFERENCE_BINDING_REQUIRED", "当前项目需要人物或商品参考；先由同一正式工位核实并绑定对应素材，再续跑原片。");
    }
    const postSettings = validateStandardPostSettings(settingsDocument, {
      durationSec: duration,
      timeline: plan.shots,
      originals: [],
    });
    await preflightStandardPostAssets(postSettings);
    if (originals.some(Boolean)) fail("PARTIAL_ORIGINALS", "已有部分正式原片；核对原任务，禁止批量重复提交");
    if (!session.access.actionPermissions.includes("workspace.write")) fail("WRITE_PERMISSION_REQUIRED", "当前成员缺少工作区写权限");
    if (!Number.isFinite(options.maxEstimatedCny) || options.maxEstimatedCny <= 0) fail("BUDGET_REQUIRED", "供应商金额上限必须大于零");
    try {
      await writeJournal(journal, { schemaVersion: "workloom.studio-render-start/v1", projectId: job.projectId, runId: job.runId,
        modelId: options.model, stageRunId: plan.stageRunId, promptsSha256: plan.promptsSha256, maxEstimatedCny: options.maxEstimatedCny }, true);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") fail("RENDER_ALREADY_ATTEMPTED", "已有生成启动回执；只查询或补记账，禁止重发");
      throw error;
    }
    const client = new ProductionClient({ api: session.origin, token: session.token, fetchImpl: session.fetcher });
    const result = await renderServiceProject({ client, projectId: job.projectId, modelId: options.model,
      expectedSource: { sourceStageRunId: plan.stageRunId, sourceAttempt: plan.attempt, promptsSha256: plan.promptsSha256 },
      maxEstimatedCny: options.maxEstimatedCny, params: { aspectRatio: platform.ratio },
      onProgress: summary => writeJournal(`${journal}.status.json`, summary),
    });
    if (result.status !== "done") fail("RENDER_UNVERIFIED", "请按已记录的任务 ID 核对回执，禁止再次提交");
    originals = await readOriginals();
  }
  for (const original of originals) {
    if (!original) return fail("ORIGINALS_PENDING", "供应商状态与原片入库回执未同时就绪");
    const artifactPath = join(clips, `${original.shotId}.raw.mp4`);
    await downloadStudioOriginal(session, original, artifactPath);
    const { url: _url, ...proof } = original;
    await issueServiceOriginal({ productionRoot, projectId: job.projectId, artifactPath, proof });
  }
  const manifest = await captureOriginalRenderManifest({ productionRoot, projectId: job.projectId });
  if (await standardPostFileHash(settings) !== settingsSha256) fail("POST_SETTINGS_CHANGED", "后期设置在生成期间发生变化");
  const delivery = await runStandardPost(manifest, settings, output, { readServiceOriginals: async () => (await readOriginals()).map(original => {
    if (!original) return fail("ORIGINALS_PENDING", "当前归档缺少先前签发的原片");
    const { url: _url, ...proof } = original;
    return proof;
  }) });
  return { phase: "delivery_verified", projectId: job.projectId, runId: job.runId, pipeline: job.pipeline,
    sourceStageRunId: plan.stageRunId, modelId: options.model, output, delivery };
}

async function main() {
  const args = parseArgs({ options: { "job-file": { type: "string" }, "work-dir": { type: "string" },
    model: { type: "string" }, "max-estimated-cny": { type: "string" }, "poll-existing": { type: "boolean" }, "post-settings": { type: "string" }, out: { type: "string" } } }).values;
  if (!args["job-file"] || !args["work-dir"] || !args.model || !args["post-settings"] || !args.out) {
    return fail("USAGE", "deliver-studio-video --job-file FILE --work-dir DIR --model CATALOG_ID --post-settings FILE --out NEW_DIR [--max-estimated-cny APPROVED_CNY | --poll-existing]");
  }
  return deliverStudioVideo({ jobFile: args["job-file"], workDir: args["work-dir"], model: args.model,
    maxEstimatedCny: args["max-estimated-cny"] === undefined ? undefined : Number(args["max-estimated-cny"]),
    pollExisting: args["poll-existing"], postSettings: args["post-settings"], out: args.out });
}

if (process.argv[1] && pathToFileURL(await realpath(process.argv[1])).href === import.meta.url) {
  try { console.log(JSON.stringify(await main(), null, 2)); }
  catch (error) {
    const message = (error instanceof Error ? error.message : String(error))
      .split(process.env.WORKLOOM_ACCESS_TOKEN || "\0").join("[redacted]")
      .replace(/([?&]token=)[^\s&]+/giu, "$1[redacted]");
    console.error(message);
    process.exitCode = 6;
  }
}
