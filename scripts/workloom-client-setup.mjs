#!/usr/bin/env node
/** Local, secret-free client binding. Production remains in the official video CLI. */
import { execFileSync, spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { access, lstat, open, readFile, realpath, rename, rm } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { inspectVideoCheckout, readVideoJob, verifyVideoSession } from './workloom-video.mjs';

export const PROFILE_SCHEMA = 'workloom.growthtest-client-profile/v1';
const SELF = fileURLToPath(import.meta.url);
const REPOSITORY = 'geniusdapeng-collab/workloom-growthtest';
const SERVER = 'workloom_growthtest_readonly';
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/u;
const SHA = /^[a-f0-9]{40}$/u;
const DIGEST = /^[a-f0-9]{64}$/u;
const SCOPE = ['instance', 'tenantId', 'workspaceId', 'memberId', 'memberNo'];
const INHERITED = ['PATH', 'HOME', 'USERPROFILE', 'TMPDIR', 'TEMP', 'TMP', 'LANG', 'LC_ALL', 'TZ', 'SYSTEMROOT', 'SystemRoot', 'WINDIR'];
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const fail = (code, message, exitCode = 2) => { throw Object.assign(new Error(message), { code, exitCode }); };
const safeText = (text, env = process.env) => {
  let result = String(text);
  for (const [key, value] of Object.entries(env)) {
    if (/TOKEN|SECRET|PASSWORD|LOGIN_KEY|API_KEY/iu.test(key) && typeof value === 'string' && value.length >= 8) result = result.split(value).join('[REDACTED]');
  }
  return result.replace(/Bearer\s+[^\s"']+/giu, 'Bearer [REDACTED]')
    .replace(/\b[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/gu, '[REDACTED]')
    .replace(/\b(?:sk-|gh[pousr]_)[A-Za-z0-9_-]{8,}\b/gu, '[REDACTED]');
};
function keys(value, allowed, code = 'PROFILE_INVALID') {
  if (!object(value) || Object.keys(value).some(key => !allowed.includes(key))) fail(code, '配置含未知字段；禁止在 profile 中保存凭据或 shell 命令');
}
function absolute(value) {
  return typeof value === 'string' && isAbsolute(value) && !/[\u0000-\u001f]/u.test(value);
}
function contained(root, target) {
  const rel = relative(root, target);
  return rel !== '' && rel !== '..' && !rel.startsWith('..' + sep) && !isAbsolute(rel);
}
export function validateProfile(value) {
  keys(value, ['schemaVersion', 'repositoryRoot', 'node', 'executorRoot', 'executorCommit', 'apiBase', 'scope', 'jobRoot', 'jobFile', 'launcher']);
  if (value.schemaVersion !== PROFILE_SCHEMA || !['repositoryRoot', 'node', 'executorRoot', 'jobRoot', 'jobFile'].every(key => absolute(value[key]))
    || !SHA.test(value.executorCommit ?? '')) fail('PROFILE_INVALID', '需要准确的绝对路径和完整 executorCommit');
  keys(value.scope, SCOPE);
  if (!SCOPE.every(key => ID.test(value.scope[key] ?? '')) || value.scope.memberNo === 'GUEST') fail('PROFILE_INVALID', '需要明确的实例、租户、工作区及成员身份');
  let url;
  try { url = new URL(value.apiBase); } catch { fail('PROFILE_INVALID', 'apiBase 须为无凭据的授权服务 origin'); }
  if (url.origin !== value.apiBase || url.username || url.password
    || !(url.protocol === 'https:' || url.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname))) {
    fail('PROFILE_INVALID', 'apiBase 只接受 HTTPS 或本机回环 HTTP origin，不含路径、查询和凭据');
  }
  if (!contained(resolve(value.jobRoot), resolve(value.jobFile))) fail('JOB_PATH_INVALID', 'jobFile 必须固定在 jobRoot 内');
  if (value.launcher !== undefined) {
    keys(value.launcher, ['script', 'sha256']);
    if (!absolute(value.launcher.script) || !/\.(?:mjs|cjs|js)$/u.test(value.launcher.script) || !DIGEST.test(value.launcher.sha256 ?? '')) {
      fail('LAUNCHER_INVALID', 'launcher 只接受已授权的本地 JavaScript 文件和 SHA-256，不接受 shell 字符串');
    }
  }
  if (safeText(JSON.stringify(value), {}) !== JSON.stringify(value)) fail('PROFILE_INVALID', 'profile 含疑似凭据，拒绝使用');
  return structuredClone(value);
}
async function privateFile(file, limit, code) {
  let handle;
  try {
    handle = await open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
    const info = await handle.stat();
    if (!info.isFile() || info.nlink !== 1 || info.size > limit || process.getuid && info.uid !== process.getuid()
      || process.platform !== 'win32' && (info.mode & 0o077)) throw new Error();
    return await handle.readFile('utf8');
  } catch { fail(code, '需要当前用户所有、仅当前用户可读写的普通文件'); }
  finally { if (handle) await handle.close(); }
}
export function defaultProfilePath(env = process.env) {
  return env.WORKLOOM_GROWTHTEST_PROFILE ?? join(homedir(), '.workloom', 'growthtest', 'client-profile.json');
}
export async function readProfile(file = defaultProfilePath()) {
  if (!absolute(file)) fail('PROFILE_INVALID', 'profile 路径必须是绝对路径');
  const text = await privateFile(file, 64 * 1024, 'PROFILE_UNAVAILABLE');
  let value;
  try { value = JSON.parse(text); } catch { fail('PROFILE_INVALID', 'profile 必须是有效 JSON'); }
  return validateProfile(value);
}
function environment(profile, env = process.env, includeToken = false) {
  const result = Object.fromEntries(INHERITED.filter(key => env[key] !== undefined).map(key => [key, env[key]]));
  Object.assign(result, {
    WORKLOOM_BASE_URL: profile.apiBase, WORKLOOM_API: profile.apiBase, WORKLOOM_DEV_AUTO_LOGIN: '0',
    WORKLOOM_DESKTOP_INSTANCE_ID: profile.scope.instance, WORKLOOM_SOURCE_TENANT_ID: profile.scope.tenantId,
    WORKLOOM_SOURCE_WORKSPACE_ID: profile.scope.workspaceId, WORKLOOM_DESKTOP_MEMBER: profile.scope.memberNo,
  });
  if (includeToken && env.WORKLOOM_ACCESS_TOKEN) result.WORKLOOM_ACCESS_TOKEN = env.WORKLOOM_ACCESS_TOKEN;
  return result;
}
async function fixedFile(root, ref) {
  const path = join(root, ref);
  const resolved = await realpath(path).catch(() => null);
  const info = await lstat(path).catch(() => null);
  if (!resolved || !contained(root, resolved) || !info?.isFile() || info.isSymbolicLink()) fail('ENTRY_UNAVAILABLE', '缺少仓库内的正式入口或依赖：' + ref, 4);
  return path;
}
async function jobPath(profile, target, { existing = false } = {}) {
  const path = isAbsolute(target) ? resolve(target) : resolve(profile.jobRoot, target);
  if (!contained(profile.jobRoot, path)) fail('JOB_PATH_INVALID', '工作单和输出必须位于固定 jobRoot 内', 4);
  const parent = await realpath(dirname(path)).catch(() => null);
  if (!parent || parent !== dirname(path) || !(parent === profile.jobRoot || contained(profile.jobRoot, parent))) {
    fail('JOB_PATH_INVALID', '作业路径不能经符号链接越界，父目录须已存在', 4);
  }
  const info = await lstat(path).catch(error => { if (error.code === 'ENOENT') return null; fail('JOB_PATH_INVALID', '无法读取作业路径', 4); });
  if (info && (!info.isFile() || info.isSymbolicLink()) || existing && !info) fail('JOB_PATH_INVALID', '需要正常的现有工作单', 4);
  return path;
}
export async function checkProfile(input) {
  const profile = validateProfile(input);
  for (const key of ['repositoryRoot', 'executorRoot', 'jobRoot']) {
    const actual = await realpath(profile[key]).catch(() => null);
    if (actual !== profile[key] || !(await lstat(actual)).isDirectory()) fail('PATH_INVALID', key + ' 须为已存在的规范绝对目录', 4);
  }
  const jobInfo = await lstat(profile.jobRoot);
  if (process.getuid && jobInfo.uid !== process.getuid() || process.platform !== 'win32' && (jobInfo.mode & 0o077)) fail('JOB_ROOT_NOT_PRIVATE', 'jobRoot 必须仅当前用户可访问', 4);
  let nodeVersion;
  try {
    await access(profile.node, constants.X_OK);
    nodeVersion = execFileSync(profile.node, ['--version'], { env: environment(profile), encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch { fail('NODE_UNAVAILABLE', '指定 Node 无法执行', 4); }
  if (!/^v(?:2[4-9]|[3-9]\d|\d{3,})\./u.test(nodeVersion)) fail('NODE_UNSUPPORTED', '正式入口需要 Node 24 或更新版本', 4);
  const checkout = await inspectVideoCheckout(profile.executorRoot);
  if (checkout.commit !== profile.executorCommit) fail('EXECUTOR_COMMIT_MISMATCH', '执行器 HEAD 与 profile 的原任务提交不一致', 4);
  // Client discovery may be prepared in a task checkout; execution still requires a clean pinned checkout.
  const manifest = JSON.parse(await readFile(await fixedFile(profile.repositoryRoot, 'product.manifest.json'), 'utf8'));
  if (manifest.repository !== REPOSITORY || manifest.productId !== checkout.productId) fail('REPOSITORY_MISMATCH', '客户端源码与执行器不是同一 GrowthTest 产品', 4);
  let clientCommit, remote;
  try {
    const git = args => execFileSync('git', ['--no-optional-locks', '-C', profile.repositoryRoot, ...args], { env: environment(profile), encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    clientCommit = git(['rev-parse', '--verify', 'HEAD']);
    remote = git(['config', '--get', 'remote.origin.url']);
  } catch { fail('REPOSITORY_MISMATCH', '客户端目录没有可核对的 GitHub 来源与 HEAD', 4); }
  if (!SHA.test(clientCommit) || !/^(?:https:\/\/github\.com\/|git@github\.com:|ssh:\/\/git@github\.com\/)geniusdapeng-collab\/workloom-growthtest(?:\.git)?$/iu.test(remote)) {
    fail('REPOSITORY_MISMATCH', '客户端目录不是准确的 GrowthTest GitHub 检出', 4);
  }
  for (const ref of ['scripts/workloom-client-setup.mjs', 'scripts/workloom-agent-mcp.mjs', 'docs/AGENT-CLIENTS.md', 'docs/video-native-agent-entry.md']) await fixedFile(profile.repositoryRoot, ref);
  await fixedFile(profile.executorRoot, 'scripts/workloom-video.mjs');
  await jobPath(profile, profile.jobFile);
  if (profile.launcher) {
    const actual = await realpath(profile.launcher.script).catch(() => null);
    const info = await lstat(profile.launcher.script).catch(() => null);
    if (actual !== profile.launcher.script || !info?.isFile() || process.getuid && info.uid !== process.getuid()
      || process.platform !== 'win32' && (info.mode & 0o022) || info.size > 1024 * 1024
      || digest(await readFile(actual)) !== profile.launcher.sha256) fail('LAUNCHER_UNTRUSTED', '已授权 launcher 的所有者、权限或摘要不符', 4);
  }
  return { schemaVersion: 'workloom.client-check/v1', localReady: true, connected: false, repository: REPOSITORY,
    repositoryRoot: profile.repositoryRoot, clientCommit, executorRoot: profile.executorRoot, executorCommit: checkout.commit,
    productId: checkout.productId, nodeVersion, apiBase: profile.apiBase, scope: profile.scope,
    jobRoot: profile.jobRoot, jobFile: profile.jobFile, authentication: profile.launcher ? 'authorized-launcher' : 'existing-environment' };
}
export async function buildPlan(profile, profileFile = defaultProfilePath()) {
  const check = await checkProfile(profile);
  return { ...check, schemaVersion: 'workloom.client-plan/v1', profileFile,
    commands: {
      check: [profile.node, join(profile.repositoryRoot, 'scripts/workloom-client-setup.mjs'), 'check', '--profile', profileFile],
      doctor: [profile.node, join(profile.repositoryRoot, 'scripts/workloom-client-setup.mjs'), 'doctor', '--profile', profileFile],
      status: [profile.node, join(profile.repositoryRoot, 'scripts/workloom-client-setup.mjs'), 'video', '--profile', profileFile, '--', 'status'],
    }, limitations: ['本地核验不证明真实连接；doctor 必须回读原工作单', 'MCP 为只读发现；制作写操作沿用正式 CLI', '不写凭据、不安装、不设置客户端 trust 或自动授权'] };
}
export function renderClientConfig(input, client, existing = '') {
  const profile = validateProfile(input);
  // Existing secrets stay in their original store. This tool never copies them to a new candidate.
  if (safeText(existing) !== existing || /(?:["']?[^\n=]*?(?:token|secret|password|authorization|cookie|headers|api[_-]?key)[^\n=]*?["']?\s*[:=])|(?:\[[^\n\]]*(?:headers|secret)[^\n\]]*\])/iu.test(existing)) {
    fail('CONFIG_CONTAINS_SECRET', '既有配置含凭据字段或值；拒绝复制和回显，请用客户端官方添加命令保留原配置', 4);
  }
  const entry = { command: profile.node, args: [join(profile.repositoryRoot, 'scripts/workloom-agent-mcp.mjs')], cwd: profile.repositoryRoot,
    env: { WORKLOOM_DEV_AUTO_LOGIN: '0', WORKLOOM_BASE_URL: profile.apiBase, WORKLOOM_PRODUCT_ROOT: profile.repositoryRoot } };
  if (client === 'codex') {
    // Preserve every byte of existing TOML. Conservatively reject any reference to our unique key,
    // including inline/quoted/dotted declarations rather than risk a duplicate table.
    if (existing.includes(SERVER)) fail('CONFIG_COLLISION', 'Codex 同名服务器已存在；先核对来源，禁止覆盖', 4);
    const quote = value => JSON.stringify(value);
    return existing + (existing && !existing.endsWith('\n') ? '\n' : '') + `\n[mcp_servers.${SERVER}]\ncommand = ${quote(entry.command)}\nargs = ${JSON.stringify(entry.args)}\ncwd = ${quote(entry.cwd)}\n\n[mcp_servers.${SERVER}.env]\n`
      + Object.entries(entry.env).map(([key, value]) => `${key} = ${quote(value)}\n`).join('');
  }
  if (client !== 'qoder-cli') fail('CLIENT_UNSUPPORTED', '仅生成已有官方字段依据的 codex 或 qoder-cli 配置');
  let settings;
  try { settings = existing.trim() ? JSON.parse(existing) : {}; } catch { fail('CONFIG_INVALID', 'Qoder 既有配置不是合法 JSON'); }
  if (!object(settings) || settings.mcpServers !== undefined && !object(settings.mcpServers)) fail('CONFIG_INVALID', 'Qoder mcpServers 须为对象');
  if (Object.hasOwn(settings.mcpServers ?? {}, SERVER)) fail('CONFIG_COLLISION', 'Qoder 同名服务器已存在；先核对来源，禁止覆盖', 4);
  return JSON.stringify({ ...settings, mcpServers: { ...settings.mcpServers, [SERVER]: { type: 'stdio', ...entry } } }, null, 2) + '\n';
}
async function writeConfig(out, text, existingFile, expected) {
  if (!absolute(out)) fail('CONFIG_PATH_INVALID', '--out 须为具体绝对路径');
  if (out !== existingFile) {
    const file = await open(out, 'wx', 0o600).catch(() => fail('CONFIG_WRITE_FAILED', '输出已存在或不可写；未覆盖配置', 4));
    try { await file.writeFile(text); await file.sync(); } finally { await file.close(); }
    return;
  }
  if (await privateFile(out, 1024 * 1024, 'CONFIG_UNAVAILABLE') !== expected) fail('CONFIG_CHANGED', '配置在生成期间变化，拒绝覆盖', 4);
  const temporary = join(dirname(out), '.workloom-client-' + randomUUID() + '.tmp');
  try {
    const file = await open(temporary, 'wx', 0o600);
    try { await file.writeFile(text); await file.sync(); } finally { await file.close(); }
    await rename(temporary, out);
  } finally { await rm(temporary, { force: true }); }
}
async function videoArguments(profile, argv) {
  const [command, ...args] = argv;
  if (!['start', 'status', 'prompts', 'resume-prompts'].includes(command)) fail('USAGE', 'video 仅支持 start/status/prompts/resume-prompts');
  const flags = new Map();
  for (let i = 0; i < args.length; i += 2) {
    if (!['--job-file', '--input-file', '--out'].includes(args[i]) || flags.has(args[i]) || !args[i + 1] || args[i + 1].startsWith('--')) fail('USAGE', '视频参数必须是正式 CLI 的独立 flag/value');
    flags.set(args[i], args[i + 1]);
  }
  const job = await jobPath(profile, flags.get('--job-file') ?? profile.jobFile, { existing: command !== 'start' });
  if (job !== profile.jobFile) fail('JOB_BINDING_MISMATCH', '本 profile 只接受固定 jobFile，不能换文件重发', 4);
  const input = flags.get('--input-file'), out = flags.get('--out');
  if (command === 'start' ? !input || out : command === 'status' ? input || out : input || !out) fail('USAGE', '输入/输出参数与正式命令不匹配');
  if (command === 'start' && await lstat(job).catch(error => { if (error.code === 'ENOENT') return null; fail('JOB_PATH_INVALID', '无法核对原工作单', 4); })) {
    fail('JOB_ALREADY_EXISTS', '原工作单已存在；只可先 status，对 start_unknown 禁止换文件重发', 4);
  }
  if (command !== 'start') {
    const saved = await readVideoJob(job);
    const binding = { ...profile.scope, repository: REPOSITORY, commit: profile.executorCommit, origin: profile.apiBase };
    if (Object.entries(binding).some(([key, value]) => saved.binding[key] !== value)) fail('JOB_SCOPE_MISMATCH', '工作单仍绑定原执行器与成员，禁止改写来源或强制兼容', 4);
  }
  const result = [command, '--job-file', job];
  if (input) result.push('--input-file', input === '-' ? '-' : resolve(input));
  if (out) {
    const target = await jobPath(profile, out);
    if (await lstat(target).catch(error => { if (error.code === 'ENOENT') return null; fail('JOB_PATH_INVALID', '无法核对输出路径', 4); })) fail('OUTPUT_EXISTS', '输出已存在；先核对回执，禁止覆盖或重复续跑', 4);
    result.push('--out', target);
  }
  return result;
}
function childJson(command, args, options) {
  return new Promise((resolveResult, reject) => {
    const child = spawn(command, args, { ...options, stdio: ['inherit', 'pipe', 'pipe'], shell: false });
    let stdout = '', stderr = '', oversized = false;
    const timer = setTimeout(() => { child.kill(); reject(Object.assign(new Error('命令超时；保留原工作单并查询原任务，禁止重发'), { code: 'CLI_OUTCOME_UNKNOWN', exitCode: 7 })); }, 240_000);
    const collect = channel => chunk => {
      if (channel === 'out') stdout += chunk; else stderr += chunk;
      if (Buffer.byteLength(stdout) + Buffer.byteLength(stderr) > 2 * 1024 * 1024) { oversized = true; child.kill(); }
    };
    child.stdout.on('data', collect('out')); child.stderr.on('data', collect('err'));
    child.once('error', () => { clearTimeout(timer); reject(Object.assign(new Error('受控 CLI 无法启动'), { code: 'CLI_START_FAILED', exitCode: 7 })); });
    child.once('close', code => {
      clearTimeout(timer);
      if (oversized) { reject(Object.assign(new Error('CLI 输出超出上限；保留工作单核对'), { code: 'CLI_OUTPUT_INVALID', exitCode: 7 })); return; }
      let value;
      try { value = JSON.parse(stdout.trim()); }
      catch {
        // Never echo arbitrary launcher output, environment, or raw authentication errors.
        let error; try { error = JSON.parse(stderr.trim()).error; } catch { error = null; }
        reject(Object.assign(new Error('受控 CLI 未返回可核对的 JSON 回执；保留原工作单'), {
          code: /^[A-Z_]+$/u.test(error?.code ?? '') ? error.code : 'CLI_OUTPUT_INVALID', exitCode: [2, 3, 4, 5, 7].includes(code) ? code : 7,
        })); return;
      }
      resolveResult({ exitCode: code ?? 7, value });
    });
  });
}
export async function executeBoundVideo(profile, argv, { env = process.env, fetcher = fetch } = {}) {
  await checkProfile(profile);
  const args = await videoArguments(profile, argv);
  const childEnv = environment(profile, env, true);
  const session = await verifyVideoSession({ env: childEnv, fetcher, checkout: () => inspectVideoCheckout(profile.executorRoot) });
  if (SCOPE.some(key => session.binding[key] !== profile.scope[key])) fail('ACCESS_SCOPE_MISMATCH', '真实成员与 profile 身份不一致', 4);
  const child = await childJson(profile.node, [join(profile.executorRoot, 'scripts/workloom-video.mjs'), ...args], { cwd: profile.executorRoot, env: childEnv });
  const result = child.value;
  if (result?.schemaVersion !== 'workloom.official-video-cli/v1' || Object.entries(session.binding).some(([key, value]) => result[key] !== value)) {
    fail('CLI_RECEIPT_MISMATCH', '正式 CLI 回执未绑定同一执行器、实例和成员', 7);
  }
  return { exitCode: child.exitCode, value: { schemaVersion: 'workloom.client-video/v1', connected: true, jobFile: profile.jobFile,
    ...(args[0] === 'resume-prompts' ? { continuationJobFile: args[args.indexOf('--out') + 1] } : {}),
    executorRoot: profile.executorRoot, executorCommit: profile.executorCommit, result } };
}
export async function runBoundVideo(profile, profileFile, argv) {
  await checkProfile(profile);
  await videoArguments(profile, argv);
  if (!profile.launcher) return executeBoundVideo(profile, argv);
  const child = await childJson(profile.node, [profile.launcher.script, profile.node, join(profile.repositoryRoot, 'scripts/workloom-client-setup.mjs'),
    'execute', '--profile', profileFile, '--', ...argv], { cwd: profile.repositoryRoot, env: environment(profile) });
  if (child.value?.schemaVersion !== 'workloom.client-video/v1' || child.value.connected !== true || child.value.executorCommit !== profile.executorCommit
    || child.value.jobFile !== profile.jobFile || child.value.executorRoot !== profile.executorRoot) fail('LAUNCHER_RECEIPT_INVALID', 'launcher 没有返回同一绑定的正式核验回执', 7);
  return child;
}
const usage = 'node scripts/workloom-client-setup.mjs plan|check|doctor [--profile /ABS/private-profile.json]\n'
  + 'node scripts/workloom-client-setup.mjs config --client codex|qoder-cli [--profile /ABS/profile.json] [--existing /ABS/config] [--out /ABS/config]\n'
  + 'node scripts/workloom-client-setup.mjs video [--profile /ABS/profile.json] -- start|status|prompts|resume-prompts [formal CLI flags]\n'
  + 'doctor only reads the fixed existing job; default profile: ~/.workloom/growthtest/client-profile.json';
export async function runClientSetup(argv) {
  const [command, ...rest] = argv;
  const separator = rest.indexOf('--');
  const options = separator < 0 ? rest : rest.slice(0, separator);
  const video = separator < 0 ? [] : rest.slice(separator + 1);
  const flags = new Map();
  for (let i = 0; i < options.length; i += 2) {
    if (!['--profile', '--client', '--existing', '--out', '--job-file'].includes(options[i]) || flags.has(options[i]) || !options[i + 1] || options[i + 1].startsWith('--')) fail('USAGE', usage);
    flags.set(options[i], options[i + 1]);
  }
  if (!['plan', 'check', 'config', 'video', 'execute', 'doctor'].includes(command)
    || command !== 'config' && ['--client', '--existing', '--out'].some(key => flags.has(key))
    || command !== 'doctor' && flags.has('--job-file') || !['video', 'execute'].includes(command) && separator >= 0) fail('USAGE', usage);
  const profileFile = flags.get('--profile') ?? defaultProfilePath();
  const profile = await readProfile(profileFile);
  if (command === 'plan') return { exitCode: 0, value: await buildPlan(profile, profileFile) };
  if (command === 'check') return { exitCode: 0, value: await checkProfile(profile) };
  if (command === 'config') {
    await checkProfile(profile);
    const existingFile = flags.get('--existing');
    if (existingFile && !absolute(existingFile)) fail('CONFIG_PATH_INVALID', '--existing 须为具体绝对路径');
    const existing = existingFile ? await privateFile(existingFile, 1024 * 1024, 'CONFIG_UNAVAILABLE') : '';
    const config = renderClientConfig(profile, flags.get('--client'), existing);
    if (flags.has('--out')) {
      await writeConfig(flags.get('--out'), config, existingFile, existing);
      return { exitCode: 0, value: { schemaVersion: 'workloom.client-config/v1', written: flags.get('--out'), sha256: digest(config), connected: false } };
    }
    if (existingFile) fail('CONFIG_OUTPUT_REQUIRED', '合并既有配置须显式指定 --out；stdout 不打印用户原配置', 4);
    return { exitCode: 0, text: config };
  }
  const args = command === 'doctor' ? ['status', ...(flags.has('--job-file') ? ['--job-file', flags.get('--job-file')] : [])] : video;
  const result = command === 'execute' ? await executeBoundVideo(profile, args) : await runBoundVideo(profile, profileFile, args);
  return command === 'doctor' ? { exitCode: 0, value: { ...result.value, schemaVersion: 'workloom.client-doctor/v1', jobStatusExitCode: result.exitCode } } : result;
}
if (process.argv[1] && await realpath(process.argv[1]).catch(() => null) === SELF) {
  if (process.argv[2] === '--help' && process.argv.length === 3) console.log(usage);
  else {
    try {
      const result = await runClientSetup(process.argv.slice(2));
      process.stdout.write(safeText(result.text ?? JSON.stringify(result.value) + '\n'));
      process.exitCode = result.exitCode;
    } catch (error) {
      const known = /^[A-Z_]+$/u.test(error.code ?? '');
      process.stderr.write(JSON.stringify({ error: { code: known ? error.code : 'CLIENT_SETUP_FAILED',
        message: known ? safeText(error.message).slice(0, 600) : '客户端接入核验失败，未发起新的生产请求' } }) + '\n');
      process.exitCode = error.exitCode ?? 7;
    }
  }
}
