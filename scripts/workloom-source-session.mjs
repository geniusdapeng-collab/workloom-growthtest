#!/usr/bin/env node
/** Bridge an authorized, isolated source server to the existing WorkLoom CLIs. */
import { spawn } from "node:child_process";
import { readFile, realpath, stat } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
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
const usage = "node scripts/workloom-source-session.mjs <agent|director|render> -- <CLI args>";

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
  if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/u.test(value)) {
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

async function request(fetcher, base, path, init = {}) {
  let response;
  let body;
  try {
    response = await fetcher(base + path, { ...init, redirect: "error", signal: AbortSignal.timeout(5_000) });
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

export async function runSourceSession(argv, { env = process.env, fetcher = fetch, spawnImpl = spawn } = {}) {
  const [name, separator, ...args] = argv;
  if (!Object.hasOwn(entries, name) || separator !== "--" || args.length === 0) invalid("USAGE", usage);
  if (name === "agent" && args.some(arg => agentOverrides.some(flag => arg === flag || arg.startsWith(flag + "=")))) {
    invalid("AGENT_OVERRIDE_FORBIDDEN", "source-session 固定当前产品、仓库和服务地址");
  }
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
  const argvPrefix = await Promise.all(entries[name].map(path => sourceFile(repo, path)));
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
