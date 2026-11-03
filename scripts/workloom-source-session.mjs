#!/usr/bin/env node
/** Bridge an authorized, isolated source server to the existing WorkLoom CLIs. */
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { constants, createReadStream } from "node:fs";
import { lstat, mkdir, open, readFile, realpath, stat } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const entries = Object.freeze({
  agent: ["scripts/workloom-agent.mjs"],
  director: ["scripts/workloom-director.mjs"],
  render: ["node_modules/tsx/dist/cli.mjs", "scripts/tools/render-project.mts"],
});
const agentOverrides = ["--root", "--base-url", "--bundle"];
const inheritedNames = [
  "PATH", "HOME", "USERPROFILE", "TMPDIR", "TEMP", "TMP", "LANG", "LC_ALL",
  "TZ", "SYSTEMROOT", "SystemRoot", "WINDIR", "COMSPEC", "ComSpec", "PATHEXT",
];
const studioReads = Object.freeze({
  status: ["video.studio.status", "runId"],
  archive: ["video.studio.archive", "projectId"],
  shots: ["video.production.shots", "projectId"],
});
const studioStartSchema = "workloom.growthtest-studio-start/v1";
const usage = "node scripts/workloom-source-session.mjs <agent|director|render> -- <CLI args>\n"
  + "node scripts/workloom-source-session.mjs studio -- start --work-root <作业目录> --input-file <JSON或->\n"
  + "node scripts/workloom-source-session.mjs studio -- <status RUN-ID|archive PROJECT-ID|shots PROJECT-ID>";
const isObject = value => value !== null && typeof value === "object" && !Array.isArray(value);
const isId = value => typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/u.test(value);
const isHash = value => typeof value === "string" && /^[a-f0-9]{64}$/u.test(value);
const sha256Json = value => createHash("sha256").update(JSON.stringify(value)).digest("hex");

class SourceSessionError extends Error {
  constructor(code, message, exitCode = 2) {
    super(message);
    this.code = code;
    this.exitCode = exitCode;
  }
}

function invalid(code, message, exitCode) {
  throw new SourceSessionError(code, message, exitCode);
}

function origin(value) {
  let url;
  try { url = new URL(value); }
  catch { invalid("ORIGIN_INVALID", "WORKLOOM_BASE_URL 必须显式设置为本机 HTTP 回环 origin"); }
  if (url.protocol !== "http:" || url.hostname !== "127.0.0.1" || url.origin !== value) {
    invalid("ORIGIN_INVALID", "仅接受 http://127.0.0.1[:端口]，地址不能含路径、凭据或查询参数");
  }
  return url.origin;
}

function requiredId(env, name) {
  const value = env[name];
  if (!isId(value)) {
    invalid("CONFIG_INVALID", `${name} 必须是非空的实例或作用域标识`);
  }
  return value;
}

async function sourceFile(repo, name) {
  const file = await realpath(resolve(repo, name)).catch(() => null);
  const rel = file && relative(repo, file);
  if (!rel || rel === ".." || rel.startsWith(".." + sep) || isAbsolute(rel)
    || !(await stat(file)).isFile()) {
    invalid("SOURCE_ENTRY_INVALID", `当前检出缺少受控入口 ${name}，请核对仓库和依赖`);
  }
  return file;
}

async function request(fetcher, base, path, init = {}, timeoutMs = 5_000) {
  let response;
  let body;
  try {
    response = await fetcher(base + path, { ...init, redirect: "error", signal: AbortSignal.timeout(timeoutMs) });
    if (!response.ok) invalid("SOURCE_HTTP_ERROR", `${path} HTTP ${response.status}`, response.status === 401 || response.status === 403 ? 3 : 7);
    body = await response.json();
  } catch (error) {
    if (error instanceof SourceSessionError) throw error;
    invalid("SOURCE_UNAVAILABLE", `无法读取本机服务 ${path}`, 7);
  }
  if (!body || typeof body !== "object" || body.error) invalid("SOURCE_RESPONSE_INVALID", `${path} 未返回有效回执`, 7);
  if (path === "/health") return body;
  const data = body.result?.data;
  const result = data?.json ?? data;
  if (!result || typeof result !== "object") invalid("SOURCE_RESPONSE_INVALID", `${path} 缺少结果回执`, 7);
  return result;
}

async function studioInput(args, input) {
  const [command, value, third, fileFlag, file] = args;
  if (command !== "start") {
    if (args.length !== 2 || !Object.hasOwn(studioReads, command) || !isId(value)) invalid("USAGE", usage);
    return { command, id: value };
  }
  if (args.length !== 5 || value !== "--work-root" || !third?.trim() || fileFlag !== "--input-file" || !file) invalid("USAGE", usage);
  let body;
  try {
    const chunks = [];
    let size = 0;
    for await (const chunk of file === "-" ? input : createReadStream(file)) {
      const bytes = Buffer.from(chunk);
      size += bytes.length;
      if (size > 1024 * 1024) invalid("STUDIO_INPUT_INVALID", "输入超过 1 MiB");
      chunks.push(bytes);
    }
    body = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks)));
  } catch (error) {
    if (error instanceof SourceSessionError) throw error;
    invalid("STUDIO_INPUT_INVALID", "无法读取合法的制片请求 JSON");
  }
  if (!isObject(body) || Object.keys(body).some(key => !["intent", "durationSec", "metadata", "route"].includes(key))
    || typeof body.intent !== "string" || !body.intent.trim() || body.intent.length > 2000
    || (body.durationSec !== undefined && (!Number.isInteger(body.durationSec) || body.durationSec < 1 || body.durationSec > 300))
    || (body.metadata !== undefined && !isObject(body.metadata))
    || (body.route !== undefined && !["auto", "marketing", "narrative"].includes(body.route))) {
    invalid("STUDIO_INPUT_INVALID", "输入只接受原话 intent、1–300 秒的整数目标 durationSec、已知 metadata 和已确认 route");
  }
  return { command, workRoot: resolve(third), body: {
    intent: body.intent,
    ...(body.durationSec === undefined ? {} : { durationSec: body.durationSec }),
    ...(body.metadata === undefined ? {} : { metadata: body.metadata }),
    route: body.route ?? "auto",
  } };
}

function validStudioStart(result) {
  if (result?.kind === "clarify") {
    return typeof result.question === "string" && Boolean(result.question.trim())
      && Array.isArray(result.missing) && result.missing.every(isId);
  }
  return result?.kind === "routed" && isId(result.projectId)
    && (["narrative", "marketing"].includes(result.pipeline) && isId(result.runId)
      || result.pipeline === "explainer" && result.runId === null && isId(result.shotbookId));
}

function unknownStudioStart() {
  invalid("STUDIO_START_OUTCOME_UNKNOWN", "启动结果未核实。保留本作业目录，先在同一实例核对项目与档案", 7);
}

async function writeStudioStartRecord(file, record) {
  const handle = await open(file, "wx", 0o600);
  try {
    await handle.writeFile(JSON.stringify(record) + "\n");
    await handle.sync();
  } finally {
    await handle.close();
  }
  if (process.platform !== "win32") {
    const directory = await open(dirname(file), "r");
    try { await directory.sync(); } finally { await directory.close(); }
  }
}

async function readStudioStartRecord(file) {
  if (!(await lstat(file)).isFile()) unknownStudioStart();
  const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.size < 1 || info.size > 1024 * 1024 || (process.platform !== "win32" && (info.mode & 0o077))) {
      unknownStudioStart();
    }
    return JSON.parse(await handle.readFile("utf8"));
  } finally {
    await handle.close();
  }
}

async function startStudio({ body, workRoot }, fetcher, base, token, scope) {
  let root;
  try {
    await mkdir(workRoot, { recursive: true, mode: 0o700 });
    if (!(await lstat(workRoot)).isDirectory()) invalid("STUDIO_WORK_ROOT_INVALID", "作业目录须为普通本地目录");
    root = await realpath(workRoot);
  } catch {
    invalid("STUDIO_WORK_ROOT_INVALID", "无法创建或核对作业目录");
  }
  const requestSha256 = sha256Json({ base, scope, body });
  const reservation = resolve(root, "studio-start.request.json");
  const receipt = resolve(root, "studio-start.receipt.json");
  const binding = { schemaVersion: studioStartSchema, requestSha256 };
  try {
    await writeStudioStartRecord(reservation, { ...binding, origin: base, ...scope });
  } catch (error) {
    if (error?.code !== "EEXIST") invalid("STUDIO_WORK_ROOT_INVALID", "无法保存启动预占，未发送制片请求", 7);
    const savedRequest = await readStudioStartRecord(reservation).catch(unknownStudioStart);
    if (savedRequest?.schemaVersion !== studioStartSchema || !isHash(savedRequest.requestSha256)) unknownStudioStart();
    if (savedRequest.requestSha256 !== requestSha256) {
      invalid("STUDIO_WORK_ROOT_CONFLICT", "该作业目录已绑定另一份请求或实例，先核对原回执", 7);
    }
    const saved = await readStudioStartRecord(receipt).catch(unknownStudioStart);
    if (saved?.schemaVersion !== studioStartSchema || saved.requestSha256 !== requestSha256
      || !validStudioStart(saved.result) || saved.resultSha256 !== sha256Json(saved.result)) unknownStudioStart();
    return { result: saved.result, requestSha256, reused: true };
  }

  // An orphaned result still proves prior activity, even if the reservation was removed.
  const orphaned = await lstat(receipt).catch(error => {
    if (error?.code === "ENOENT") return null;
    unknownStudioStart();
  });
  if (orphaned) unknownStudioStart();

  let result;
  try {
    result = await request(fetcher, base, "/trpc/video.studio.start", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer " + token },
      body: JSON.stringify(body),
    }, 60_000);
  } catch (error) {
    if (error instanceof SourceSessionError && error.exitCode === 3) throw error;
    unknownStudioStart();
  }
  if (!validStudioStart(result)) unknownStudioStart();
  await writeStudioStartRecord(receipt, { ...binding, result, resultSha256: sha256Json(result) }).catch(unknownStudioStart);
  return { result, requestSha256, reused: false };
}

async function readStudio({ command, id }, fetcher, base, token) {
  const [route, key] = studioReads[command];
  const query = encodeURIComponent(JSON.stringify({ [key]: id }));
  const result = await request(fetcher, base, `/trpc/${route}?input=${query}`, {
    method: "GET",
    headers: { authorization: "Bearer " + token },
  });
  if (result[key] !== id
    || (command === "status" && (!isId(result.projectId) || !["running", "awaiting_approval", "finished", "failed"].includes(result.status)))
    || (command === "archive" && (typeof result.archiveExists !== "boolean" || !Array.isArray(result.stages)))
    || (command === "shots" && (!isId(result.sourceStageRunId) || !Number.isInteger(result.sourceAttempt) || result.sourceAttempt <= 0
      || !isHash(result.promptsSha256) || !Array.isArray(result.shots) || result.shots.length === 0
      || !result.shots.every(shot => isId(shot?.shotId) && Number.isInteger(shot.durationSec) && shot.durationSec > 0
        && isHash(shot.promptSha256))))) {
    invalid("STUDIO_READBACK_INVALID", "服务回执与请求的运行或项目不一致", 7);
  }
  return result;
}

export async function runSourceSession(argv, { env = process.env, fetcher = fetch, spawnImpl = spawn, input = process.stdin,
  output = line => process.stdout.write(line + "\n") } = {}) {
  const [name, separator, ...args] = argv;
  if ((name !== "studio" && !Object.hasOwn(entries, name)) || separator !== "--" || args.length === 0) invalid("USAGE", usage);
  if (name === "agent" && args.some(arg => agentOverrides.some(flag => arg === flag || arg.startsWith(flag + "=")))) {
    invalid("AGENT_OVERRIDE_FORBIDDEN", "source-session 固定当前产品、仓库和服务地址");
  }
  const studio = name === "studio" ? await studioInput(args, input) : null;
  const base = origin(env.WORKLOOM_BASE_URL);
  const instanceId = requiredId(env, "WORKLOOM_DESKTOP_INSTANCE_ID");
  const tenantId = requiredId(env, "WORKLOOM_SOURCE_TENANT_ID");
  const workspaceId = requiredId(env, "WORKLOOM_SOURCE_WORKSPACE_ID");
  const memberNo = requiredId(env, "WORKLOOM_DESKTOP_MEMBER");
  const key = env.WORKLOOM_DESKTOP_LOGIN_KEY;
  if (typeof key !== "string" || !/^[a-f0-9]{64}$/u.test(key)) {
    invalid("BOOTSTRAP_KEY_INVALID", "WORKLOOM_DESKTOP_LOGIN_KEY 必须由本次本机服务启动进程提供", 3);
  }
  const repo = await realpath(root);
  const manifest = JSON.parse(await readFile(await sourceFile(repo, "product.manifest.json"), "utf8"));
  if (studio && manifest.repository !== "geniusdapeng-collab/workloom-growthtest") {
    invalid("RUNTIME_IDENTITY_MISMATCH", "本机视频入口只接受 Growthtest 检出", 4);
  }
  const argvPrefix = studio ? [] : await Promise.all(entries[name].map(path => sourceFile(repo, path)));
  const health = await request(fetcher, base, "/health");
  if (health.ok !== true || !manifest.productId || health.productId !== manifest.productId || health.desktopInstanceId !== instanceId) {
    invalid("RUNTIME_IDENTITY_MISMATCH", "本机服务产品或实例与本次检出不符", 4);
  }
  const { token, identity } = await request(fetcher, base, "/trpc/auth.desktopLogin", {
    method: "POST",
    headers: { "content-type": "application/json", "x-workloom-desktop-key": key },
    body: "{}",
  });
  if (identity?.tenantId !== tenantId || identity?.workspaceId !== workspaceId || identity?.memberNo !== memberNo
    || typeof identity.memberId !== "string" || !identity.memberId || memberNo === "GUEST") {
    invalid("LOGIN_SCOPE_MISMATCH", "签发的成员或作用域与本次运行配置不符", 4);
  }
  if (typeof token !== "string" || token.length > 16_384 || !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/u.test(token)) {
    invalid("MEMBER_TOKEN_INVALID", "本机服务未签发合法格式的成员令牌", 3);
  }
  const access = await request(fetcher, base, "/trpc/access.me", {
    headers: { authorization: "Bearer " + token },
  });
  if (access.schemaVersion !== "workloom.client-access/v1" || access.authority?.source !== "server"
    || access.scope?.tenantId !== tenantId || access.scope?.workspaceId !== workspaceId
    || access.subject?.kind !== "member" || access.subject?.memberNo !== memberNo || access.subject?.id !== identity.memberId) {
    invalid("ACCESS_SCOPE_MISMATCH", "服务端权限回读未绑定到同一成员和工作区", 4);
  }
  if (studio) {
    const response = studio.command === "start"
      ? await startStudio(studio, fetcher, base, token, { instanceId, tenantId, workspaceId, memberNo, memberId: identity.memberId })
      : { result: await readStudio(studio, fetcher, base, token) };
    output(JSON.stringify({ schemaVersion: "workloom.growthtest-studio-cli/v1", command: studio.command, deliveryComplete: false, ...response }));
    return 0;
  }
  const childEnv = Object.fromEntries(inheritedNames.filter(name => env[name] !== undefined).map(name => [name, env[name]]));
  Object.assign(childEnv, {
    WORKLOOM_BASE_URL: base,
    WORKLOOM_API: base,
    WORKLOOM_DEV_AUTO_LOGIN: "0",
    [name === "render" ? "WORKLOOM_TOKEN" : "WORKLOOM_ACCESS_TOKEN"]: token,
  });
  return new Promise((resolve, reject) => {
    const child = spawnImpl(process.execPath, [...argvPrefix, ...args], { cwd: repo, env: childEnv, stdio: "inherit" });
    child.once("error", () => reject(new SourceSessionError("CLI_START_FAILED", "当前检出的正式 CLI 无法启动", 7)));
    child.once("exit", code => resolve(code ?? 1));
  });
}

if (resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) {
  const argv = process.argv.slice(2);
  if (argv.length === 1 && argv[0] === "--help") console.log(usage);
  else {
    try { process.exitCode = await runSourceSession(argv); }
    catch (error) {
      const safe = error instanceof SourceSessionError
        ? error
        : new SourceSessionError("SOURCE_SESSION_FAILED", "无法启动本机源码会话", 7);
      process.stderr.write(JSON.stringify({ error: { code: safe.code, message: safe.message } }) + "\n");
      process.exitCode = safe.exitCode;
    }
  }
}
