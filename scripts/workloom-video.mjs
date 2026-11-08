#!/usr/bin/env node
/** Authenticated natural-language entry into the official video service. */
import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { link, open, readFile, realpath, rename, rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { COVER_PLATFORM_IDS } from "../packages/video-studio/src/cover-platforms.ts";
import { FINAL_PROMPT_MAX_CHARACTERS, VIDEO_INTENT_MAX_CHARACTERS, unicodeLength } from "../packages/video-studio/src/unicode-text.mjs";
import { CapabilityError, sanitizeErrorMessage } from "./agent-capabilities.mjs";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const REPOSITORY = "geniusdapeng-collab/workloom-growthtest";
const JOB_SCHEMA = "workloom.official-video-job/v1";
const RESULT_SCHEMA = "workloom.official-video-cli/v1";
const PROMPT_REVIEW = "prompt-review";
const MAX_FILE_BYTES = 64 * 1024;
// 12000 supplementary characters can occupy 144000 bytes when JSON uses surrogate escapes.
const MAX_INPUT_BYTES = 256 * 1024;
const PIPELINES = new Set(["marketing", "narrative"]);
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/u;
const SHA256 = /^[a-f0-9]{64}$/u;
const COMMIT = /^[a-f0-9]{40}$/u;
const PLATFORM = /^[a-z][a-z0-9-]{0,39}$/u;
const BINDING_FIELDS = ["repository", "commit", "productId", "origin", "instance", "tenantId", "workspaceId", "memberId", "memberNo"];
const record = value => value !== null && typeof value === "object" && !Array.isArray(value);
const hash = value => createHash("sha256").update(value).digest("hex");
const validDuration = value => Number.isSafeInteger(value) && value >= 1 && value <= 300;
const canonicalPlatform = value => typeof value === "string" && PLATFORM.test(value) && COVER_PLATFORM_IDS.includes(value);
const fail = (code, message, exitCode = 2) => { throw new CapabilityError(code, message, exitCode); };

export function validateVideoIntent(input) {
  if (!record(input) || Object.keys(input).some(key => !["intent", "durationSec", "platform", "product", "purpose"].includes(key))
    || typeof input.intent !== "string" || !input.intent.trim() || unicodeLength(input.intent) > VIDEO_INTENT_MAX_CHARACTERS) {
    fail("INVALID_INPUT", "start 需要非空 intent（最多 12000 个 Unicode 字符），只接受额外的 durationSec、platform、product、purpose");
  }
  if (input.purpose !== undefined && input.purpose !== PROMPT_REVIEW) fail("INVALID_INPUT", "purpose 仅支持 prompt-review");
  if (input.durationSec !== undefined && !validDuration(input.durationSec)) {
    fail("INVALID_INPUT", "durationSec 须为 1 到 300 的整数");
  }
  if (input.platform !== undefined && (typeof input.platform !== "string" || !input.platform.trim() || input.platform.trim().length > 40)) {
    fail("INVALID_INPUT", "platform 须为不超过 40 字符的明确平台");
  }
  const product = input.product;
  if (product !== undefined && (!record(product) || typeof product.name !== "string" || !product.name.trim()
    || /[\u0000-\u001f<>\\/]|\.\./u.test(product.name.trim())
    || Object.entries(product).some(([key, value]) => !["name", "brand", "model", "category"].includes(key)
      || typeof value !== "string" || !value.trim() || value.trim().length > (key === "name" ? 160 : 100)))) {
    fail("INVALID_INPUT", "product 只接受已明确的 name、brand、model、category，name 为必填");
  }
  return { intent: input.intent, ...(input.durationSec === undefined ? {} : { durationSec: input.durationSec }),
    ...(input.platform === undefined ? {} : { platform: input.platform.trim() }),
    ...(product === undefined ? {} : { product: Object.fromEntries(Object.entries(product).map(([key, value]) => [key, value.trim()])) }),
    ...(input.purpose === undefined ? {} : { purpose: input.purpose }),
    officialIntent: true };
}

export async function inspectVideoCheckout(root = ROOT) {
  const manifest = JSON.parse(await readFile(join(root, "product.manifest.json"), "utf8"));
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^GIT_/iu.test(key)));
  const git = args => execFileSync("git", ["--no-optional-locks", "-C", root, ...args], { env, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  let commit, remote, dirty;
  try {
    commit = git(["rev-parse", "--verify", "HEAD"]);
    git(["cat-file", "-e", "HEAD:scripts/workloom-video.mjs"]);
    remote = git(["config", "--get", "remote.origin.url"]);
    dirty = git(["status", "--porcelain", "--untracked-files=no"]);
  } catch { fail("CHECKOUT_INVALID", "无法核实 GitHub 检出与准确提交", 4); }
  const repo = /^(?:https:\/\/github\.com\/|git@github\.com:|ssh:\/\/git@github\.com\/)([^?#\s]+)$/iu.exec(remote);
  const repository = (repo?.[1] ?? "").replace(/\.git$/iu, "").toLowerCase();
  if (repository !== REPOSITORY || manifest.repository !== REPOSITORY || !ID.test(manifest.productId ?? "")
    || !COMMIT.test(commit) || dirty) fail("CHECKOUT_INVALID", "需要来自官方 GitHub 且受版本控制文件干净的 GrowthTest 检出", 4);
  return { repository, commit, productId: manifest.productId };
}

async function fetchJson(fetcher, url, init, timeoutMs = 30_000) {
  let response, body;
  try {
    response = await fetcher(url, { ...init, redirect: "error", signal: AbortSignal.timeout(timeoutMs) });
    body = await response.json();
  } catch { fail("SERVICE_UNAVAILABLE", "服务请求或回执读取失败", 7); }
  if (!response.ok || body?.error) {
    const fault = body?.error?.json ?? body?.error;
    const code = typeof fault?.data?.code === "string" && /^[A-Z_]+$/u.test(fault.data.code) ? fault.data.code : "REMOTE_ERROR";
    fail(code, typeof fault?.message === "string" ? fault.message.slice(0, 600) : `服务 HTTP ${response.status}`,
      response.status === 401 ? 3 : response.status === 403 ? 4 : 7);
  }
  return body;
}

export async function requestVideoProcedure(session, procedure, input, { mutation = false, timeoutMs = 30_000 } = {}) {
  if (procedure !== "access.me" && !/^video(?:\.[a-z][a-zA-Z0-9]*){2,}$/u.test(procedure)) {
    fail("PROCEDURE_INVALID", "只允许当前实例的视频服务过程");
  }
  const url = new URL("/trpc/" + procedure, session.origin);
  if (!mutation && input !== undefined) url.searchParams.set("input", JSON.stringify(input));
  const body = await fetchJson(session.fetcher, url, {
    method: mutation ? "POST" : "GET",
    headers: { authorization: "Bearer " + session.token, ...(mutation ? { "content-type": "application/json" } : {}) },
    ...(mutation ? { body: JSON.stringify(input) } : {}),
  }, timeoutMs);
  if (!record(body?.result) || !Object.hasOwn(body.result, "data")) fail("REMOTE_INVALID", "服务没有提供可核对的 result.data", 7);
  return body.result.data;
}

export async function verifyVideoSession({ env = process.env, fetcher = fetch, checkout = inspectVideoCheckout } = {}) {
  const repo = await checkout();
  const suppliedBase = env.WORKLOOM_BASE_URL;
  let base;
  try { base = new URL(suppliedBase); } catch { fail("ORIGIN_INVALID", "WORKLOOM_BASE_URL 须指向当前授权服务的 origin"); }
  const loopback = base.hostname === "127.0.0.1" || base.hostname === "localhost" || base.hostname === "[::1]";
  if (!(base.protocol === "https:" || base.protocol === "http:" && loopback) || base.origin !== suppliedBase
    || base.username || base.password) fail("ORIGIN_INVALID", "仅接受授权 HTTPS 或本机回环 HTTP origin");
  const instance = env.WORKLOOM_DESKTOP_INSTANCE_ID;
  const token = env.WORKLOOM_ACCESS_TOKEN;
  if (!ID.test(instance ?? "") || typeof token !== "string" || !token || token.length > 16_384 || /\s/u.test(token)) {
    fail("MEMBER_SESSION_REQUIRED", "当前会话需要已授权服务的实例标识与成员令牌", 3);
  }
  const health = await fetchJson(fetcher, new URL("/health", base), { method: "GET" });
  if (health?.ok !== true || health.productId !== repo.productId || health.desktopInstanceId !== instance) {
    fail("RUNTIME_IDENTITY_MISMATCH", "健康回执的产品或实例与选定服务不符", 4);
  }
  if (health.sourceCommit !== repo.commit) {
    fail("RUNTIME_SOURCE_MISMATCH", "当前服务的启动提交与这个正式检出不一致或未核验", 4);
  }
  const session = { origin: base.origin, token, fetcher };
  const access = await requestVideoProcedure(session, "access.me");
  const { tenantId, workspaceId } = access?.scope ?? {};
  const { kind, id: memberId, memberNo } = access?.subject ?? {};
  if (access?.schemaVersion !== "workloom.client-access/v1" || access?.authority?.source !== "server" || kind !== "member"
    || ![tenantId, workspaceId, memberId, memberNo].every(id => ID.test(id ?? "")) || memberNo === "GUEST"
    || (env.WORKLOOM_SOURCE_TENANT_ID && env.WORKLOOM_SOURCE_TENANT_ID !== tenantId)
    || (env.WORKLOOM_SOURCE_WORKSPACE_ID && env.WORKLOOM_SOURCE_WORKSPACE_ID !== workspaceId)
    || (env.WORKLOOM_DESKTOP_MEMBER && env.WORKLOOM_DESKTOP_MEMBER !== memberNo)
    || !Array.isArray(access.navigationPermissions) || !access.navigationPermissions.includes("ai-video.assets.read")) {
    fail("ACCESS_SCOPE_MISMATCH", "服务未回读同一已授权视频成员与工作区", 4);
  }
  return { ...session, access, binding: { ...repo, origin: base.origin, instance, tenantId, workspaceId, memberId, memberNo } };
}

async function syncParent(path) {
  if (process.platform === "win32") return;
  const directory = await open(dirname(path), "r");
  try { await directory.sync(); } finally { await directory.close(); }
}

async function writeExclusive(path, value) {
  const file = await open(path, "wx", 0o600);
  try {
    await file.writeFile(JSON.stringify(value) + "\n", "utf8");
    await file.sync();
  } finally { await file.close(); }
}

async function replaceJob(path, value) {
  const temporary = join(dirname(path), `.workloom-video-${randomUUID()}.tmp`);
  try {
    await writeExclusive(temporary, value);
    await rename(temporary, path);
    await syncParent(path);
  } finally { await rm(temporary, { force: true }); }
}

export async function readVideoJob(path) {
  let raw;
  try {
    const file = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    try {
      const stat = await file.stat();
      if (!stat.isFile() || stat.nlink !== 1 || stat.size > MAX_FILE_BYTES
        || (process.getuid && stat.uid !== process.getuid()) || (process.platform !== "win32" && (stat.mode & 0o077))) throw new Error();
      raw = JSON.parse(await file.readFile("utf8"));
    } finally { await file.close(); }
  } catch { fail("JOB_FILE_INVALID", "工作单必须是当前用户私有且可读的正常 JSON 文件", 4); }
  const binding = raw?.binding;
  if (raw?.schemaVersion !== JOB_SCHEMA || !SHA256.test(raw.requestSha256 ?? "") || !record(binding)
    || Object.keys(binding).some(key => !BINDING_FIELDS.includes(key))
    || binding.repository !== REPOSITORY || !COMMIT.test(binding.commit ?? "") || typeof binding.origin !== "string"
    || ![binding.productId, binding.instance, binding.tenantId, binding.workspaceId, binding.memberId, binding.memberNo].every(id => ID.test(id ?? ""))
    || !["start_unknown", "preproduction_submitted", "clarify", "unsupported", "resume_refused"].includes(raw.phase)
    || (raw.purpose !== undefined && (raw.purpose !== PROMPT_REVIEW || raw.phase === "preproduction_submitted" && !validDuration(raw.durationSec)))
    || (raw.durationSec !== undefined && !validDuration(raw.durationSec))
    || (raw.platform !== undefined && !canonicalPlatform(raw.platform))
    || (raw.resumedFrom !== undefined && (raw.purpose !== PROMPT_REVIEW || !record(raw.resumedFrom)
      || !COMMIT.test(raw.resumedFrom.commit ?? "") || !ID.test(raw.resumedFrom.runId ?? "")
      || !ID.test(raw.projectId ?? "") || !PIPELINES.has(raw.pipeline)))
    || (raw.phase === "preproduction_submitted" && (!ID.test(raw.runId ?? "") || !ID.test(raw.projectId ?? "") || !PIPELINES.has(raw.pipeline)))) {
    fail("JOB_FILE_INVALID", "工作单结构或来源不符合正式视频入口", 4);
  }
  return raw;
}

export function verifyVideoJobBinding(job, session) {
  if (Object.keys(session.binding).some(key => job.binding[key] !== session.binding[key])) {
    fail("JOB_SCOPE_MISMATCH", "当前仓库提交、服务实例或成员作用域与原工作单不同", 4);
  }
}

const receipt = (job, phase = job.phase, detail = {}) => ({
  schemaVersion: RESULT_SCHEMA, phase, mediaReady: false, ...job.binding, requestSha256: job.requestSha256,
  ...(job.runId ? { runId: job.runId, projectId: job.projectId, pipeline: job.pipeline } : {}),
  ...(job.durationSec === undefined ? {} : { durationSec: job.durationSec }),
  ...(job.purpose === undefined ? {} : { purpose: job.purpose, renderAuthorized: false }),
  ...(job.resumedFrom === undefined ? {} : { resumedFrom: job.resumedFrom, projectId: job.projectId, pipeline: job.pipeline }),
  ...(job.platform === undefined ? {} : { platform: job.platform }), ...detail,
});

export async function startVideo(input, jobFile, deps = {}) {
  const wire = validateVideoIntent(input);
  const path = resolve(jobFile);
  const session = await verifyVideoSession(deps);
  if (!Array.isArray(session.access.actionPermissions) || !session.access.actionPermissions.includes("workspace.write")) {
    fail("WRITE_PERMISSION_REQUIRED", "当前成员未获工作区写权限", 4);
  }
  const job = { schemaVersion: JOB_SCHEMA, createdAt: new Date().toISOString(), binding: session.binding,
    requestSha256: hash(JSON.stringify(wire)), phase: "start_unknown",
    ...(wire.purpose === undefined ? {} : { purpose: wire.purpose }),
    ...(wire.durationSec === undefined ? {} : { durationSec: wire.durationSec }) };
  try {
    await writeExclusive(path, job);
    await syncParent(path);
  } catch (error) {
    if (error?.code === "EEXIST") fail("JOB_ALREADY_EXISTS", "工作单已存在，请用 status 回读，禁止重复启动", 4);
    fail("JOB_WRITE_FAILED", "无法持久化工作单，尚未提交项目", 7);
  }
  let result;
  try {
    result = await requestVideoProcedure(session, "video.studio.start", wire, { mutation: true, timeoutMs: 180_000 });
  } catch (error) {
    const message = sanitizeErrorMessage(error, deps.env ?? process.env);
    return receipt(job, "start_unknown", { error: message, next: "保留工作单；核对服务记录，禁止重新提交" });
  }
  if (result?.kind === "clarify") {
    job.phase = "clarify";
    job.question = typeof result.question === "string" ? result.question.slice(0, 600) : null;
    job.missing = Array.isArray(result.missing) ? result.missing.filter(item => item === "route" || item === "product") : [];
  } else if (result?.kind === "unsupported" && result.pipeline === "explainer") {
    job.phase = "unsupported";
    job.handoff = "video.explainer";
  } else if (result?.kind === "routed" && ID.test(result.runId ?? "") && ID.test(result.projectId ?? "") && PIPELINES.has(result.pipeline)) {
    if (result.purpose !== wire.purpose || wire.purpose === PROMPT_REVIEW && !validDuration(result.durationSec)
      || result.durationSec !== undefined && (!validDuration(result.durationSec)
        || wire.durationSec !== undefined && result.durationSec !== wire.durationSec)) {
      return receipt(job, "start_unknown", { error: "服务回执用途或时长与原工作单不符；核对同一运行，禁止重新提交",
        runId: result.runId, projectId: result.projectId, pipeline: result.pipeline });
    }
    if (result.platform !== undefined && (!canonicalPlatform(result.platform)
      || (canonicalPlatform(wire.platform) && result.platform !== wire.platform))) {
      return receipt(job, "start_unknown", { error: "服务回执平台与原工作单不符；核对同一运行，禁止重新提交",
        runId: result.runId, projectId: result.projectId, pipeline: result.pipeline });
    }
    Object.assign(job, { phase: "preproduction_submitted", runId: result.runId, projectId: result.projectId, pipeline: result.pipeline });
    if (result.durationSec !== undefined) job.durationSec = result.durationSec;
    if (result.platform !== undefined) job.platform = result.platform;
  } else {
    return receipt(job, "start_unknown", { error: "服务回执无法绑定正式项目和运行", next: "保留工作单；核对服务记录，禁止重新提交" });
  }
  try { await replaceJob(path, job); }
  catch {
    return receipt(job, "start_unknown", { error: "收到服务回执但未能持久化更新；请记录返回 ID，禁止重新提交" });
  }
  return receipt(job, job.phase, { ...(job.phase === "clarify" ? { question: job.question, missing: job.missing } : {}),
    ...(job.phase === "unsupported" ? { handoff: job.handoff } : {}) });
}

export function validateFormalVideoSource(source, job) {
  const ids = new Set();
  if (source?.projectId !== job.projectId || source?.runId !== job.runId || source?.pipeline !== job.pipeline
    || !ID.test(source?.sourceStageRunId ?? "") || !Number.isSafeInteger(source?.sourceAttempt) || source.sourceAttempt < 1
    || !SHA256.test(source?.promptsSha256 ?? "") || !Array.isArray(source?.shots) || !source.shots.length) {
    fail("SOURCE_UNVERIFIED", "正式分镜来源与原项目、运行或管线不符", 7);
  }
  const shots = source.shots.map(shot => {
    if (!ID.test(shot?.shotId ?? "") || ids.has(shot.shotId) || !Number.isSafeInteger(shot.durationSec) || shot.durationSec < 1
      || typeof shot.prompt !== "string" || !shot.prompt.trim() || unicodeLength(shot.prompt) > FINAL_PROMPT_MAX_CHARACTERS
      || !record(shot.fields) || hash(shot.prompt) !== shot.promptSha256) {
      fail("SOURCE_UNVERIFIED", "正式分镜缺少唯一镜号、完整内容或一致摘要", 7);
    }
    ids.add(shot.shotId);
    return { shotId: shot.shotId, durationSec: shot.durationSec, promptSha256: shot.promptSha256 };
  });
  return { stageRunId: source.sourceStageRunId, attempt: source.sourceAttempt, promptsSha256: source.promptsSha256, shots };
}

async function readPromptReview(session, job) {
  const source = await requestVideoProcedure(session, "video.production.promptReview", { projectId: job.projectId, runId: job.runId });
  if (source?.schemaVersion !== "workloom.studio-prompt-review/v1" || source.state !== "prompt_review_ready"
    || source.issuer !== "workloom.studio-worker" || source.purpose !== PROMPT_REVIEW
    || source.tenantId !== job.binding.tenantId || source.workspaceId !== job.binding.workspaceId
    || source.projectId !== job.projectId || source.runId !== job.runId || source.pipeline !== job.pipeline
    || source.targetSeconds !== job.durationSec || source.renderAuthorized !== false
    || !ID.test(source.stageRunId ?? "") || !Number.isSafeInteger(source.attempt) || source.attempt < 1
    || typeof source.reviewReport !== "string" || !source.reviewReport.trim() || hash(source.reviewReport) !== source.reviewReportSha256
    || !Array.isArray(source.shots) || source.shots.length < 1 || source.shots.length > 100
    || !source.shots.every(shot => ID.test(shot?.shotId ?? "") && validDuration(shot.durationSec)
      && typeof shot.prompt === "string" && shot.prompt.trim() && unicodeLength(shot.prompt) <= FINAL_PROMPT_MAX_CHARACTERS
      && hash(shot.prompt) === shot.promptSha256)
    || new Set(source.shots.map(shot => shot.shotId)).size !== source.shots.length
    || source.plannedSeconds !== source.shots.reduce((total, shot) => total + shot.durationSec, 0)) {
    fail("PROMPT_REVIEW_UNVERIFIED", "提示词评审回执的作用域、作业或正文摘要不符", 7);
  }
  const canonicalShots = JSON.stringify(source.shots, (_key, value) => record(value)
    ? Object.fromEntries(Object.keys(value).sort().map(key => [key, value[key]]))
    : value);
  if (hash(canonicalShots) !== source.promptsSha256) fail("PROMPT_REVIEW_UNVERIFIED", "逐镜提示词包摘要不符", 7);
  return source;
}

function promptReviewSummary(source) {
  return { stageRunId: source.stageRunId, attempt: source.attempt, plannedSeconds: source.plannedSeconds,
    shotCount: source.shots.length, reviewReportSha256: source.reviewReportSha256, promptsSha256: source.promptsSha256 };
}

export async function statusVideo(jobFile, deps = {}) {
  const job = await readVideoJob(resolve(jobFile));
  const session = await verifyVideoSession(deps);
  verifyVideoJobBinding(job, session);
  if (job.phase === "start_unknown") return receipt(job, "start_unknown", { next: "保留工作单；核对服务记录，禁止重新提交" });
  if (job.phase === "resume_refused") return receipt(job, job.phase, { error: job.error });
  if (job.phase === "clarify") return receipt(job, "clarify", { question: job.question, missing: job.missing });
  if (job.phase === "unsupported") return receipt(job, "unsupported", { handoff: job.handoff });
  let run;
  try { run = await requestVideoProcedure(session, "video.studio.status", { runId: job.runId }); }
  catch (error) {
    if (error.code !== "NOT_FOUND") throw error;
    run = null;
  }
  const promptRepair = run?.resultSummary && record(run.resultSummary.promptRepair)
    ? run.resultSummary.promptRepair
    : null;
  if (run !== null) {
    if (run?.runId !== job.runId || run?.projectId !== job.projectId) {
      return receipt(job, "status_unavailable", { error: "当前服务未返回与原工作单一致的运行；保留同一项目核对" });
    }
    if (run.status === "running") return receipt(job, "preproduction_running", promptRepair ? { promptRepair } : {});
    if (run.status === "awaiting_approval") return receipt(job, "awaiting_approval", { gate: run.currentGate ?? null, pendingApprovalId: run.pendingApprovalId ?? null });
    if (run.status === "failed") return receipt(job, "preproduction_failed", {
      error: sanitizeErrorMessage(run.error ?? "预生产失败", deps.env ?? process.env),
      ...(promptRepair ? { promptRepair } : {}),
    });
    if (run.status !== "finished" || (job.purpose !== PROMPT_REVIEW && run.resultSummary?.success !== true)) {
      return receipt(job, "status_unavailable", { error: "运行终态没有预生产成功证明" });
    }
  }
  try {
    if (job.purpose === PROMPT_REVIEW) {
      const source = await readPromptReview(session, job);
      return receipt(job, "prompt_review_ready", { source: promptReviewSummary(source), ...(promptRepair ? { promptRepair } : {}) });
    }
    // The live run registry is process-local. Only the exact current archived
    // source can recover readiness when the previous worker is no longer listed.
    const source = await requestVideoProcedure(session, "video.production.shots", { projectId: job.projectId });
    return receipt(job, "preproduction_ready", {
      source: validateFormalVideoSource(source, job),
      ...(promptRepair ? { promptRepair } : {}),
    });
  } catch (error) {
    return receipt(job, "status_unavailable", { error: sanitizeErrorMessage(error, deps.env ?? process.env) });
  }
}

async function resumePromptReview(jobFile, out, deps) {
  const original = await readVideoJob(resolve(jobFile));
  if (original.purpose !== PROMPT_REVIEW || original.phase !== "preproduction_submitted") {
    fail("PROMPT_REVIEW_JOB_REQUIRED", "只可恢复原提示词评审工作单", 4);
  }
  const session = await verifyVideoSession(deps);
  if (Object.keys(session.binding).some(key => key !== "commit" && original.binding[key] !== session.binding[key])) {
    fail("JOB_SCOPE_MISMATCH", "续跑须使用原服务实例、工作区与成员", 4);
  }
  if (!session.access.actionPermissions?.includes("workspace.write")) fail("WRITE_PERMISSION_REQUIRED", "当前成员未获工作区写权限", 4);
  const { runId, ...job } = { ...original, createdAt: new Date().toISOString(), binding: session.binding, phase: "start_unknown",
    resumedFrom: { commit: original.binding.commit, runId: original.runId } };
  const path = resolve(out);
  try {
    await writeExclusive(path, job);
    await syncParent(path);
  } catch (error) {
    if (error?.code === "EEXIST") fail("JOB_ALREADY_EXISTS", "续跑工作单已存在，请用 status 回读，禁止重复提交", 4);
    fail("JOB_WRITE_FAILED", "无法持久化续跑工作单，尚未提交", 7);
  }
  let result;
  try {
    result = await requestVideoProcedure(session, "video.studio.resume", {
      projectId: job.projectId, fromStage: "prompt_review", expectedRunId: runId,
    }, { mutation: true, timeoutMs: 180_000 });
  } catch (error) {
    return receipt(job, "start_unknown", { error: sanitizeErrorMessage(error, deps.env ?? process.env),
      next: "保留续跑工作单；核对原项目台账，禁止重复提交" });
  }
  if (result?.kind === "resumed" && result.stage === "prompt_review" && result.projectId === job.projectId
    && result.priorRunId === runId && ID.test(result.runId ?? "") && result.runId !== runId) {
    job.phase = "preproduction_submitted";
    job.runId = result.runId;
  } else if (["noaction", "busy", "awaiting_approval"].includes(result?.kind)) {
    job.phase = "resume_refused";
    job.error = sanitizeErrorMessage(result.message ?? "续跑未启动", deps.env ?? process.env);
  } else {
    return receipt(job, "start_unknown", { error: "续跑回执无法绑定原项目与原运行；禁止重复提交" });
  }
  try { await replaceJob(path, job); }
  catch { return receipt(job, "start_unknown", { error: "收到续跑回执但未能保存；核对原项目台账，禁止重复提交" }); }
  return receipt(job, job.phase, job.error ? { error: job.error } : {});
}

async function exportPromptReview(jobFile, out, deps) {
  const job = await readVideoJob(resolve(jobFile));
  const session = await verifyVideoSession(deps);
  verifyVideoJobBinding(job, session);
  if (job.purpose !== PROMPT_REVIEW || job.phase !== "preproduction_submitted") {
    fail("PROMPT_REVIEW_JOB_REQUIRED", "只可导出原提示词评审工作单", 4);
  }
  const source = await readPromptReview(session, job);
  const destination = resolve(out);
  const temporary = join(dirname(destination), `.workloom-prompt-review-${randomUUID()}.tmp`);
  try {
    await writeExclusive(temporary, source);
    await link(temporary, destination);
    await syncParent(destination);
  } catch (error) {
    if (error?.code === "EEXIST") fail("PROMPT_REVIEW_EXISTS", "导出文件已存在", 4);
    fail("PROMPT_REVIEW_WRITE_FAILED", "无法写入提示词评审回执", 7);
  } finally { await rm(temporary, { force: true }); }
  return receipt(job, "prompt_review_ready", { source: promptReviewSummary(source), out: destination });
}

async function readInputFile(path) {
  const chunks = [];
  let length = 0;
  try {
    const file = path === "-" ? null : await open(path, constants.O_RDONLY | (constants.O_NONBLOCK ?? 0));
    if (file) {
      let valid = false;
      try {
        const info = await file.stat();
        valid = info.isFile() && info.size <= MAX_INPUT_BYTES;
      } finally { if (!valid) await file.close(); }
      if (!valid) fail("INVALID_INPUT", "输入须为不超过 256 KiB 的普通文件");
    }
    const stream = file ? file.createReadStream() : process.stdin;
    for await (const chunk of stream) {
      length += chunk.length;
      if (length > MAX_INPUT_BYTES) fail("INVALID_INPUT", "输入超过 256 KiB");
      chunks.push(chunk);
    }
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks)));
  } catch (error) {
    if (error instanceof CapabilityError) throw error;
    fail("INVALID_INPUT", "输入须为有效 UTF-8 JSON");
  }
}

const usage = "node scripts/workloom-video.mjs start --input-file <JSON文件|-> --job-file <工作单>\n"
  + "node scripts/workloom-video.mjs status --job-file <工作单>\n"
  + "node scripts/workloom-video.mjs resume-prompts --job-file <原工作单> --out <续跑工作单>\n"
  + "node scripts/workloom-video.mjs prompts --job-file <工作单> --out <新JSON文件>";
export async function runVideoCli(argv, deps = {}) {
  const [command, ...args] = argv;
  const flags = new Map();
  for (let i = 0; i < args.length; i += 2) {
    const flag = args[i];
    const value = args[i + 1];
    if (!["--input-file", "--job-file", "--out"].includes(flag) || flags.has(flag) || !value || value.startsWith("--")) fail("USAGE", usage);
    flags.set(flag, value);
  }
  const jobFile = flags.get("--job-file");
  const inputFile = flags.get("--input-file");
  const out = flags.get("--out");
  if (command === "start" && jobFile && inputFile && !out) return startVideo(await readInputFile(inputFile), jobFile, deps);
  if (command === "status" && jobFile && !inputFile && !out) return statusVideo(jobFile, deps);
  if (command === "resume-prompts" && jobFile && !inputFile && out) return resumePromptReview(jobFile, out, deps);
  if (command === "prompts" && jobFile && !inputFile && out) return exportPromptReview(jobFile, out, deps);
  fail("USAGE", usage);
}

if (process.argv[1] && await realpath(process.argv[1]).catch(() => null) === fileURLToPath(import.meta.url)) {
  if (process.argv.length === 3 && process.argv[2] === "--help") console.log(usage);
  else {
    try {
      const result = await runVideoCli(process.argv.slice(2));
      console.log(JSON.stringify(result));
      if (["start_unknown", "preproduction_failed", "status_unavailable", "unsupported", "clarify", "resume_refused"].includes(result.phase)) process.exitCode = 7;
    } catch (error) {
      console.error(JSON.stringify({ error: { code: error.code ?? "VIDEO_ENTRY_FAILED", message: sanitizeErrorMessage(error) } }));
      process.exitCode = error.exitCode ?? 7;
    }
  }
}
