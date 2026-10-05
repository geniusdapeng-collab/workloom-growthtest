#!/usr/bin/env node
/**
 * 本仓并发门禁：普通文件重叠提醒，明确 MODULE_EXCLUSIVE 在 PR 先到先得。
 * 完整身份、Git 范围、API 分页和稳定路径是事实硬约束，warn 不能软化。
 * 用法：node scripts/ci/verify-lock-conflict.mjs [--base ref] [--repo slug] [--strict]
 * 官方 CNB 字段：https://docs.cnb.cool/zh/build/build-in-env.html
 */
import { execFileSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  findFileOverlaps, findModuleConflicts, parseNameStatusZ,
  requireRepositoryPath, resolveLockPolicies,
} from "./protocol-rules.mjs";

const API = "https://api.cnb.cool";
const FULL_SHA = /^[0-9a-f]{40}$/;
const ZERO_SHA = "0".repeat(40);
const HERE = dirname(fileURLToPath(import.meta.url));
const PREMERGE_EVENTS = new Set([
  "pull_request", "pull_request.update", "pull_request.approved",
  "pull_request.changes_requested", "pull_request.mergeable", "pull_request.comment",
]);
const FILE_STATUSES = new Map([
  ["add", "added"], ["modify", "modified"], ["delete", "deleted"],
  ["rename", "renamed"], ["copy", "copied"],
]);

function fail(code, message) {
  const error = new Error(`${code}: ${message}`);
  error.code = code;
  throw error;
}

function fullSha(value, label) {
  const sha = typeof value === "string" ? value.trim().toLowerCase() : "";
  if (!FULL_SHA.test(sha) || sha === ZERO_SHA) fail("IDENTITY_UNVERIFIED", `${label} 必须为非零完整 SHA`);
  return sha;
}

export function repositorySlug(value) {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-][A-Za-z0-9_.-]*(?:\/[A-Za-z0-9_-][A-Za-z0-9_.-]*)+$/.test(value)
    || value.split("/").some((part) => part === "." || part === "..")) {
    fail("IDENTITY_UNVERIFIED", "仓库 Slug 缺失或无效");
  }
  return value;
}

function iid(value) {
  const text = typeof value === "number" && Number.isSafeInteger(value) ? String(value) : value;
  if (typeof text !== "string" || !/^[1-9]\d{0,19}$/.test(text)) fail("IDENTITY_UNVERIFIED", "缺少实际 PR 仓库 IID");
  return text;
}

function branch(value) {
  if (typeof value !== "string" || !value || /[\0\r\n]/.test(value)) fail("IDENTITY_UNVERIFIED", "分支名称缺失或无效");
  return value.replace(/^refs\/heads\//, "");
}

function git(args, { cwd, raw = false } = {}) {
  try {
    const output = execFileSync("git", args, {
      cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 15_000, maxBuffer: 32 * 1024 * 1024,
    });
    return raw ? output : output.trim();
  } catch {
    fail("GIT_SCOPE_UNVERIFIED", "不能读取已选择的 Git 对象或范围");
  }
}

function commitRef(ref, cwd) {
  if (typeof ref !== "string" || !/^[a-z0-9][a-z0-9_./~^@{}-]*$/i.test(ref)) fail("GIT_SCOPE_UNVERIFIED", "提交引用无效");
  return fullSha(git(["rev-parse", "--verify", `${ref}^{commit}`], { cwd }), "Git commit");
}

function completeHistory(cwd) {
  if (git(["rev-parse", "--is-shallow-repository"], { cwd }) !== "false") fail("GIT_SCOPE_UNVERIFIED", "浅历史不能证明完整变更范围");
}

/** 相同目标仓、相同实际 IID 才是自身；其 source 绑定另行完整核对。 */
export function isSelfPull({ number, repo, selfNumber, selfRepo }) {
  return typeof repo === "string" && repo === selfRepo
    && /^[1-9]\d{0,19}$/.test(String(number ?? ""))
    && String(number) === String(selfNumber ?? "");
}

export function resolveLockContext(argv = [], env = {}) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index];
    if (["--strict", "--self-test"].includes(key)) {
      if (Object.hasOwn(options, key)) fail("OPTIONS_INVALID", "参数重复");
      options[key] = true;
      continue;
    }
    if (!["--base", "--repo", "--pr"].includes(key) || !argv[index + 1] || argv[index + 1].startsWith("--")) fail("OPTIONS_INVALID", "参数必须是已知选项及其完整值");
    if (Object.hasOwn(options, key)) fail("OPTIONS_INVALID", "参数重复");
    options[key] = argv[++index];
  }
  const event = env.CNB_EVENT?.trim() || null;
  const isPr = event?.startsWith("pull_request") || env.CNB_PULL_REQUEST === "true"
    || env.CNB_PULL_REQUEST_LIKE === "true" || Boolean(env.CNB_PULL_REQUEST_SHA || env.CNB_PULL_REQUEST_TARGET_SHA);
  const isCI = env.CNB === "true" || env.CI === "true" || Boolean(event);
  const repo = options["--repo"] ?? env.CNB_REPO_SLUG;
  if (options["--repo"] && env.CNB_REPO_SLUG && options["--repo"] !== env.CNB_REPO_SLUG) fail("IDENTITY_UNVERIFIED", "显式仓库与 CNB 仓库不一致");
  const context = {
    event, isPr: Boolean(isPr), isCI, repoSlug: repo ? repositorySlug(repo) : null,
    base: options["--base"], strict: Boolean(options["--strict"]), selfTest: Boolean(options["--self-test"]),
    policies: resolveLockPolicies({ event, envMode: env.LOCK_OVERLAP_MODE, strict: Boolean(options["--strict"]) }),
  };
  if (isPr) {
    if (!PREMERGE_EVENTS.has(event)) fail("IDENTITY_UNVERIFIED", "不是可核对预合并内容的 PR 事件");
    context.iid = iid(env.CNB_PULL_REQUEST_IID);
    if (options["--pr"] && iid(options["--pr"]) !== context.iid) fail("IDENTITY_UNVERIFIED", "显式 IID 与当前 PR 不符");
    context.sourceSha = fullSha(env.CNB_PULL_REQUEST_SHA, "PR source");
    context.targetSha = fullSha(env.CNB_PULL_REQUEST_TARGET_SHA, "PR target");
    context.sourceRepo = repositorySlug(env.CNB_PULL_REQUEST_SLUG);
    context.sourceBranch = branch(env.CNB_PULL_REQUEST_BRANCH);
    context.targetBranch = branch(env.CNB_BRANCH);
    if (!context.repoSlug) fail("IDENTITY_UNVERIFIED", "缺少目标仓库");
    if (context.base) fail("GIT_SCOPE_UNVERIFIED", "PR 变更范围不能被 --base 覆盖");
  } else if (options["--pr"]) fail("IDENTITY_UNVERIFIED", "--pr 需要实际官方 PR 上下文");
  if (env.CNB_API_ENDPOINT) {
    let endpoint;
    try { endpoint = new URL(env.CNB_API_ENDPOINT); }
    catch { fail("IDENTITY_UNVERIFIED", "API endpoint 无效"); }
    if (endpoint.origin !== API || endpoint.pathname !== "/" || endpoint.search || endpoint.hash || endpoint.username || endpoint.password) fail("IDENTITY_UNVERIFIED", "API endpoint 不受信任");
  }
  return context;
}

export function changedFiles({ context = {}, env = {}, cwd = process.cwd() } = {}) {
  const head = commitRef("HEAD", cwd);
  if (context.isPr) {
    const declared = resolveLockContext([], env);
    if (!declared.isPr || ["iid", "repoSlug", "sourceSha", "targetSha", "sourceRepo", "sourceBranch", "targetBranch", "event"]
      .some((key) => context[key] !== declared[key])) fail("IDENTITY_UNVERIFIED", "PR 变更上下文与提供的官方字段不一致");
    completeHistory(cwd);
    const checkerEnv = Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith("CNB_")));
    for (const [name, value] of Object.entries(env)) if (value !== undefined) checkerEnv[name] = value;
    delete checkerEnv.CNB_TOKEN;
    // 复用实际生产 checker 的 source/target/canonical 双亲和树契约。
    try {
      execFileSync(process.execPath, [join(HERE, "verify-commit-msg.mjs")], {
        cwd, env: checkerEnv, encoding: "utf8", timeout: 30_000,
        stdio: ["ignore", "pipe", "pipe"], maxBuffer: 16 * 1024 * 1024,
      });
    } catch { fail("GIT_SCOPE_UNVERIFIED", "实际 PR source/target/checkout 提交契约未通过"); }
    const range = `${context.targetSha}...${context.sourceSha}`;
    return { files: parseNameStatusZ(git(["diff", "--name-status", "-z", "-M", "-C", range, "--"], { cwd, raw: true })), range, head };
  }
  if (context.event === "push") {
    for (const name of ["CNB_COMMIT", "CNB_BRANCH_SHA"]) {
      if (env[name] !== undefined && fullSha(env[name], name) !== head) fail("GIT_SCOPE_UNVERIFIED", "push 身份与工作区不符");
    }
    const before = env.CNB_BEFORE_SHA?.trim();
    if (before && before !== ZERO_SHA) {
      completeHistory(cwd);
      const previous = commitRef(fullSha(before, "push before"), cwd);
      const range = `${previous}..${head}`;
      return { files: parseNameStatusZ(git(["diff", "--name-status", "-z", "-M", "-C", previous, head, "--"], { cwd, raw: true })), range, head };
    }
    const parents = git(["show", "-s", "--format=%P", head], { cwd }).split(" ").filter(Boolean);
    const args = parents.length ? ["diff", "--name-status", "-z", "-M", "-C", parents[0], head, "--"]
      : ["diff-tree", "--root", "--no-commit-id", "--name-status", "-z", "-r", head, "--"];
    return { files: parseNameStatusZ(git(args, { cwd, raw: true })), range: head, head };
  }
  let base;
  if (context.base !== undefined) base = commitRef(context.base, cwd);
  else {
    for (const ref of ["origin/main", "main", "HEAD~1"]) {
      try { base = commitRef(ref, cwd); break; }
      catch (error) {
        if (error.code !== "GIT_SCOPE_UNVERIFIED") throw error;
        // 仅隐式不存在的 ref 可试下一条；选中后不因合法 empty 或 diff 失败回退。
      }
    }
  }
  if (base) {
    completeHistory(cwd);
    const range = `${base}...${head}`;
    return { files: parseNameStatusZ(git(["diff", "--name-status", "-z", "-M", "-C", range, "--"], { cwd, raw: true })), range, head };
  }
  return { files: parseNameStatusZ(git(["diff-tree", "--root", "--no-commit-id", "--name-status", "-z", "-r", head, "--"], { cwd, raw: true })), range: head, head };
}

export class LockApiClient {
  constructor({ repoSlug, token, fetchImpl = globalThis.fetch, timeoutMs = 10_000, budgetMs = 60_000,
    pageSize = 10, maxPages = 100, now = Date.now } = {}) {
    this.repoSlug = repositorySlug(repoSlug);
    if (typeof token !== "string" || !token.trim() || typeof fetchImpl !== "function") fail("API_INCOMPLETE", "缺少 API 令牌或网络实现");
    for (const [name, value] of Object.entries({ timeoutMs, budgetMs, pageSize, maxPages })) {
      if (!Number.isSafeInteger(value) || value <= 0) fail("API_INCOMPLETE", `${name} 必须为正整数`);
    }
    this.token = token; this.fetchImpl = fetchImpl; this.timeoutMs = timeoutMs;
    this.deadline = now() + budgetMs; this.now = now; this.pageSize = pageSize; this.maxPages = maxPages;
  }

  async api(path, { repoSlug = this.repoSlug } = {}) {
    const boundRepo = repositorySlug(repoSlug);
    const remaining = this.deadline - this.now();
    if (remaining <= 0) fail("API_INCOMPLETE", "API 采集总时间已超限");
    const controller = new AbortController();
    let timer;
    try {
      return await Promise.race([
        (async () => {
          const response = await this.fetchImpl(`${API}/${boundRepo}/-/${path}`, {
            headers: { Authorization: `Bearer ${this.token}`, Accept: "application/vnd.cnb.api+json" },
            redirect: "error", signal: controller.signal,
          });
          if (response.status !== 200) fail("API_INCOMPLETE", `CNB GET 返回 HTTP ${response.status}`);
          const text = await response.text();
          if (!text || text.length > 16 * 1024 * 1024) fail("API_INCOMPLETE", "API JSON 为空或超过大小边界");
          try { return JSON.parse(text); } catch { fail("API_INCOMPLETE", "API 返回无效 JSON"); }
        })(),
        new Promise((_, reject) => {
          timer = setTimeout(() => {
            controller.abort();
            const error = new Error("API_INCOMPLETE: API 请求超时"); error.code = "API_INCOMPLETE"; reject(error);
          }, Math.min(this.timeoutMs, remaining));
        }),
      ]);
    } catch (error) {
      if (error.code === "API_INCOMPLETE") throw error;
      fail("API_INCOMPLETE", "API 网络读取失败");
    } finally { clearTimeout(timer); }
  }
}

function normalizePull(pull, repoSlug, { requireRepos = true } = {}) {
  if (!pull || typeof pull !== "object" || Array.isArray(pull) || pull.state !== "open") fail("STALE_PULL", "PR 记录不完整或已关闭");
  const targetRepo = pull.base?.repo?.path; const sourceRepo = pull.head?.repo?.path;
  if (requireRepos && (!targetRepo || !sourceRepo)) fail("IDENTITY_UNVERIFIED", "PR 详情缺少完整 source/target 仓库");
  if ((targetRepo && repositorySlug(targetRepo) !== repoSlug)
    || (pull.repo?.path && repositorySlug(pull.repo.path) !== repoSlug)) fail("IDENTITY_UNVERIFIED", "PR 目标仓库不符");
  return {
    number: iid(pull.number), repo: repoSlug,
    sourceSha: fullSha(pull.head?.sha, "PR head"), targetSha: fullSha(pull.base?.sha, "PR base"),
    sourceBranch: branch(pull.head?.ref), targetBranch: branch(pull.base?.ref),
    sourceRepo: sourceRepo ? repositorySlug(sourceRepo) : null, title: typeof pull.title === "string" ? pull.title : "",
  };
}

function samePull(left, right, { listed = false } = {}) {
  return ["number", "repo", "sourceSha", "targetSha", "sourceBranch", "targetBranch"].every((key) => left[key] === right[key])
    && ((listed && !left.sourceRepo) || left.sourceRepo === right.sourceRepo);
}

export function fullPathOf(entry, { repoSlug, headSha } = {}) {
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) fail("PATH_UNVERIFIED", "文件记录无效");
  const explicit = entry.path === undefined ? null : requireRepositoryPath(entry.path);
  const urls = [entry.raw_url, entry.blob_url].filter((value) => value !== undefined && value !== null && value !== "");
  if (!explicit && !urls.length) fail("PATH_UNVERIFIED", "filename 基名不能证明完整路径");
  const paths = urls.map((value) => {
    if (typeof value !== "string") fail("PATH_UNVERIFIED", "文件 URL 无效");
    let url;
    try { url = new URL(value); } catch { fail("PATH_UNVERIFIED", "文件 URL 无效"); }
    if (url.origin !== "https://cnb.cool" || url.username || url.password || url.search || url.hash) fail("PATH_UNVERIFIED", "文件 URL 来源不受信任");
    const repo = repositorySlug(repoSlug); const sha = fullSha(headSha, "文件 head");
    const prefixes = [`/${repo}/-/git/raw/${sha}/`, `/${repo}/-/blob/${sha}/`];
    const prefix = prefixes.find((candidate) => url.pathname.startsWith(candidate));
    if (!prefix) fail("PATH_UNVERIFIED", "文件 URL 未绑定仓库和完整 source SHA");
    let decoded;
    try { decoded = decodeURIComponent(url.pathname.slice(prefix.length)); } catch { fail("PATH_UNVERIFIED", "文件 URL 编码无效"); }
    return requireRepositoryPath(decoded);
  });
  const selected = explicit ?? paths[0];
  if (paths.some((path) => path !== selected)) fail("PATH_UNVERIFIED", "文件 path 与 URL 的路径互相矛盾");
  return selected;
}

export function pathsFromCompare(compare, { baseSha, headSha } = {}) {
  if (!compare || Array.isArray(compare) || typeof compare !== "object" || compare.base_commit?.sha !== baseSha
    || compare.head_commit?.sha !== headSha || !FULL_SHA.test(compare.merge_base_commit?.sha ?? "") || compare.merge_base_commit.sha === ZERO_SHA
    || !Number.isSafeInteger(compare.total_commits) || compare.total_commits < 0 || !Array.isArray(compare.files)
    || (compare.total_commits === 0 && compare.files.length !== 0)
    || compare.truncated === true || compare.too_large === true) fail("PATH_UNVERIFIED", "compare 缺少完整 base/head/merge-base 或完整文件列表");
  const records = compare.files.map((file) => {
    // OpenAPI documents long forms; current server responses also use these five short forms.
    const status = file && (FILE_STATUSES.get(file.status) ?? file.status);
    if (!["added", "modified", "deleted", "renamed", "copied"].includes(status)) fail("PATH_UNVERIFIED", "compare 文件状态无效");
    const path = requireRepositoryPath(file.path);
    const previous = ["renamed", "copied"].includes(status) ? requireRepositoryPath(file.previous_filename) : null;
    return { path, previous, status };
  });
  if (new Set(records.map((file) => file.path)).size !== records.length) fail("PATH_UNVERIFIED", "compare 文件列表重复");
  return { paths: [...new Set(records.flatMap((file) => [file.path, ...(file.previous ? [file.previous] : [])]))].sort(), records };
}

async function listPulls(client) {
  const pulls = []; const seen = new Set();
  for (let page = 1; page <= client.maxPages; page += 1) {
    const rows = await client.api(`pulls?state=open&page=${page}&page_size=${client.pageSize}&order_by=created_at`);
    if (!Array.isArray(rows) || rows.length > client.pageSize) fail("API_INCOMPLETE", "open PR 分页必须为合法完整数组");
    for (const row of rows) {
      const pull = normalizePull(row, client.repoSlug, { requireRepos: false });
      if (seen.has(pull.number)) fail("STALE_PULL", "分页重复 IID，不能证明完整稳定集合");
      seen.add(pull.number); pulls.push(pull);
    }
    if (rows.length < client.pageSize) return { pulls, pages: page };
  }
  fail("PAGINATION_LIMIT", "open PR 页数超过上界，不能以部分列表放行");
}

function assertOwnPull(pull, context) {
  if (!isSelfPull({ number: pull.number, repo: pull.repo, selfNumber: context.iid, selfRepo: context.repoSlug })
    || pull.sourceSha !== context.sourceSha || pull.targetSha !== context.targetSha || pull.sourceRepo !== context.sourceRepo
    || pull.sourceBranch !== context.sourceBranch || pull.targetBranch !== context.targetBranch) fail("STALE_PULL", "当前 PR 详情与实际官方 source/target/IID 身份不符");
}

export async function collectBoundPulls(client, context = {}) {
  const first = await listPulls(client); const result = []; let own = null;
  for (const listed of first.pulls) {
    const before = normalizePull(await client.api(`pulls/${listed.number}`), client.repoSlug);
    if (!samePull(listed, before, { listed: true })) fail("STALE_PULL", "列表与 PR 详情身份已变化");
    if (context.isPr && before.number === context.iid) { assertOwnPull(before, context); own = before; }
    else {
      if (before.sourceRepo !== client.repoSlug) {
        const sourceCommit = await client.api(`git/commits/${before.sourceSha}`, { repoSlug: before.sourceRepo });
        if (!sourceCommit || sourceCommit.sha !== before.sourceSha || !Array.isArray(sourceCommit.parents)) {
          fail("PATH_UNVERIFIED", "fork source 仓库没有返回实际完整 head commit，不能使用目标仓的未知对象");
        }
      }
      const files = await client.api(`pulls/${before.number}/files`);
      if (!Array.isArray(files)) fail("API_INCOMPLETE", "PR 文件接口必须为非分页数组");
      const compare = await client.api(`git/compare/${before.targetSha}...${before.sourceSha}`);
      const { paths, records } = pathsFromCompare(compare, { baseSha: before.targetSha, headSha: before.sourceSha });
      if (files.length !== records.length) fail("PATH_UNVERIFIED", "PR 文件列表与 bound compare 不完整或不一致");
      const expected = records.map((record) => `${record.status}:${record.path.split("/").at(-1)}`).sort();
      const actual = files.map((file) => {
        if (!file || !FILE_STATUSES.has(file.status) || typeof file.filename !== "string" || !file.filename) fail("PATH_UNVERIFIED", "PR 文件元数据无效");
        requireRepositoryPath(file.filename);
        if (file.filename.includes("/") && !records.some((record) => record.path === file.filename && record.status === FILE_STATUSES.get(file.status))) {
          fail("PATH_UNVERIFIED", "PR 文件声明的完整 filename 与 compare 矛盾");
        }
        if (file.path !== undefined || [file.raw_url, file.blob_url].some((value) => value !== undefined && value !== null && value !== "")) {
          const path = fullPathOf(file, { repoSlug: before.sourceRepo, headSha: before.sourceSha });
          if (!records.some((record) => record.path === path && record.status === FILE_STATUSES.get(file.status))) fail("PATH_UNVERIFIED", "PR 文件路径未由实际 compare 证明");
        }
        return `${FILE_STATUSES.get(file.status)}:${file.filename.split("/").at(-1)}`;
      }).sort();
      if (JSON.stringify(actual) !== JSON.stringify(expected)) fail("PATH_UNVERIFIED", "PR 文件状态或路径与 compare 不符");
      result.push({ ...before, paths });
    }
    const after = normalizePull(await client.api(`pulls/${before.number}`), client.repoSlug);
    if (!samePull(before, after)) fail("STALE_PULL", "PR 在文件采集期间移动或关闭");
  }
  if (context.isPr && !own) fail("STALE_PULL", "当前实际 PR 不在完整 open 集合中，不能以详情 fallback 放行");
  const second = await listPulls(client);
  const fingerprint = (rows) => JSON.stringify(rows.map(({ title, ...row }) => row).sort((a, b) => BigInt(a.number) < BigInt(b.number) ? -1 : 1));
  if (fingerprint(first.pulls) !== fingerprint(second.pulls)) fail("STALE_PULL", "open PR 集合在本次采集期间变化");
  return { prs: result, selfNumber: own?.number ?? null, complete: true, pages: first.pages + second.pages, observedPulls: first.pulls.length };
}

export function compareConflicts(mine, others, context) {
  const conflicts = [];
  for (const other of others) {
    const later = context.iid ? BigInt(other.number) < BigInt(context.iid) : true;
    const modules = findModuleConflicts(mine, other.paths); const paths = findFileOverlaps(mine, other.paths);
    if (modules.length) conflicts.push({ kind: "modules", otherIID: other.number, modules, blocking: context.policies.modules === "fail" && later, later });
    if (paths.length) conflicts.push({ kind: "ordinary", otherIID: other.number, paths, blocking: context.policies.ordinary === "fail" && later, later });
  }
  return conflicts;
}

export async function runLockGate({ argv = [], env = process.env, cwd = process.cwd(), fetchImpl = globalThis.fetch, apiOptions = {} } = {}) {
  const context = resolveLockContext(argv, env); const scope = changedFiles({ context, env, cwd });
  if (!context.repoSlug || !env.CNB_TOKEN?.trim()) {
    if (context.isCI || context.isPr || context.strict) fail("API_INCOMPLETE", "缺少 CNB 仓库或令牌，不能证明并发状态");
    return { schema: "workloom.lock-conflict/v2", event: "local", decision: "local-skip", verified: false, complete: false,
      reason: "本地缺少 CNB 上下文", range: scope.range, files: scope.files };
  }
  const client = new LockApiClient({ ...apiOptions, repoSlug: context.repoSlug, token: env.CNB_TOKEN, fetchImpl });
  const collection = await collectBoundPulls(client, context); const conflicts = compareConflicts(scope.files, collection.prs, context);
  return { schema: "workloom.lock-conflict/v2", event: context.event ?? "local", decision: conflicts.some((row) => row.blocking) ? "blocked" : "pass",
    verified: true, complete: collection.complete, pages: collection.pages, observedPulls: collection.observedPulls,
    sourceSha: context.sourceSha ?? scope.head, targetSha: context.targetSha ?? null, selfIID: collection.selfNumber,
    repoSlug: context.repoSlug, range: scope.range, files: scope.files, policies: context.policies, conflicts };
}

function selfTest() {
  const policies = resolveLockPolicies({ event: "pull_request", envMode: "warn" });
  if (policies.ordinary !== "warn" || policies.modules !== "fail" || policies.api !== "fail"
    || isSelfPull({ number: "1", repo: "a/b", selfNumber: "2", selfRepo: "a/b" })
    || !isSelfPull({ number: "1", repo: "a/b", selfNumber: "1", selfRepo: "a/b" })
    || parseNameStatusZ("R100\0sync/old\0new path\0D\0gone\0").length !== 3
    || findModuleConflicts(["sync/a"], ["sync/b"]).join() !== "sync/") fail("SELF_TEST_FAILED", "并发契约自检失败");
  console.log("✓ 并发契约自检通过（身份 / 普通提醒 / 模块硬互斥 / 删除与rename）");
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    if (process.argv.includes("--self-test")) selfTest();
    else {
      const report = await runLockGate({ argv: process.argv.slice(2) }); console.log(JSON.stringify(report));
      if (report.decision === "blocked") process.exitCode = 1;
    }
  } catch (error) {
    console.error(`拒绝：${error.code ?? "LOCK_UNVERIFIED"}: ${error.code ? error.message.split(": ").slice(1).join(": ") : "并发状态无法核实"}`);
    process.exitCode = 1;
  }
}
