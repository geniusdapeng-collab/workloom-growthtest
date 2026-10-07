/**
 * CNB 平台 API 封装（无外部依赖，Node 24 自带 fetch）。
 * 供 fleet-scan.mjs / provision-protocol.mjs / task.mjs 共用。
 * 令牌来源：环境变量 CNB_TOKEN（CI 内自动注入；本地使用个人令牌）。
 */

export const API_BASE = "https://api.cnb.cool";
export const WEB_BASE = "https://cnb.cool";

export function redactCredentials(value, token = process.env.CNB_TOKEN) {
  let text = String(value);
  const secrets = new Set(Object.entries(process.env).filter(([key, value]) => /TOKEN|SECRET|PASSWORD|API_KEY|PRIVATE_KEY/i.test(key) && value && value.length >= 4).map(([, value]) => value));
  if (token) { secrets.add(token); secrets.add(Buffer.from(`cnb:${token}`).toString('base64')); }
  for (const secret of secrets) text = text.split(secret).join('[REDACTED]');
  return text;
}

export function gitAuthenticationEnvironment(token, source = process.env) {
  if (!token) throw new Error('缺少 CNB_TOKEN');
  const env = { ...source, GIT_TERMINAL_PROMPT: '0' };
  const count = Number(env.GIT_CONFIG_COUNT ?? 0);
  if (!Number.isSafeInteger(count) || count < 0) throw new Error('无效 GIT_CONFIG_COUNT');
  env.GIT_CONFIG_COUNT = String(count + 2);
  env[`GIT_CONFIG_KEY_${count}`] = 'credential.helper'; env[`GIT_CONFIG_VALUE_${count}`] = '';
  env[`GIT_CONFIG_KEY_${count + 1}`] = 'http.https://cnb.cool/.extraHeader';
  env[`GIT_CONFIG_VALUE_${count + 1}`] = `Authorization: Basic ${Buffer.from(`cnb:${token}`).toString('base64')}`;
  return env;
}

export class CnbError extends Error {
  constructor(status, body, url, token) {
    super(redactCredentials(`CNB ${status} ${url} :: ${String(body).slice(0, 200)}`, token));
    this.status = status;
    this.body = redactCredentials(body, token);
    this.url = url;
  }
}

export function requireToken() {
  const token = process.env.CNB_TOKEN;
  if (!token) throw new Error("缺少 CNB_TOKEN（CI 流水线内自动注入；本地请用个人令牌导出到环境变量）");
  return token;
}

const RETRYABLE_STATUS = new Set([429, 500, 502, 503, 504]);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * 只读调用默认在总预算内重试 4 次；429 采用有限长退避，其他暂时故障保留指数退避。
 * 更长的 Retry-After 不提前压短；写入只尝试一次，由调用方按身份回读。
 * 退避数值是本仓恢复策略，不代表已核实的 CNB 限额。
 */
export async function api(slug, path, options = {}, runtime = {}) {
  const { method = "GET", body, token = requireToken(), accept = "application/json", baseDelayMs = 700 } = options;
  const readOnly = method === 'GET';
  const retries = readOnly ? (options.retries ?? 4) : 0;
  const retryBudgetMs = readOnly ? (options.retryBudgetMs ?? 240000) : 30000;
  if (!Number.isSafeInteger(retries) || retries < 0 || retries > 8 || !Number.isFinite(baseDelayMs) || baseDelayMs < 0 || baseDelayMs > 30000 || !Number.isFinite(retryBudgetMs) || retryBudgetMs <= 0 || retryBudgetMs > 240000) throw new Error('Invalid CNB retry bounds');
  const url = path.startsWith("http") ? path : `${API_BASE}/${slug}${path}`;
  if (new URL(url).origin !== API_BASE) throw new Error('CNB API 不允许把凭据发送到其他来源');
  const headers = { Authorization: `Bearer ${token}`, Accept: accept };
  if (body !== undefined) headers["Content-Type"] = "application/json";
  const serializedBody = body === undefined ? undefined : JSON.stringify(body);
  const now = runtime.now ?? (() => performance.now());
  const wallNow = runtime.wallNow ?? Date.now;
  const pause = runtime.sleep ?? sleep;
  const request = runtime.fetch ?? globalThis.fetch;
  if ([now, wallNow, pause, request].some(value => typeof value !== 'function')) throw new Error('Invalid CNB transport runtime');
  const deadline = now() + retryBudgetMs;
  const remaining = () => deadline - now();
  let lastError = null;
  const budgetError = () => {
    const error = new Error(redactCredentials(`CNB request retry budget exhausted ${url}${lastError ? ': ' + lastError.message : ''}`, token));
    if (lastError?.status) error.status = lastError.status;
    return error;
  };
  const bounded = async (operation, timeoutMs, controller) => {
    let timer;
    try {
      return await Promise.race([Promise.resolve().then(operation), new Promise((_, reject) => {
        timer = setTimeout(() => { controller?.abort(); reject(new Error('CNB request/wait timed out')); }, Math.max(1, Math.ceil(timeoutMs)));
      })]);
    } finally { clearTimeout(timer); controller?.abort(); }
  };
  const waitForRetry = async delay => {
    delay = Math.ceil(delay);
    if (!Number.isFinite(delay) || delay < 0 || delay >= remaining()) throw budgetError();
    const started = now();
    do {
      const before = now();
      const wait = Math.max(0, Math.ceil(delay - (before - started)));
      if (remaining() <= 0) throw budgetError();
      try { await bounded(() => pause(wait), remaining()); }
      catch (error) { throw new Error(redactCredentials(`CNB retry wait failed ${url}: ${error.message}`, token)); }
      if (wait > 0 && now() <= before) throw new Error('CNB retry wait made no monotonic progress');
    } while (now() - started < delay);
    if (remaining() <= 0) throw budgetError();
  };
  const retryAfterDelay = value => {
    if (typeof value !== 'string' || !value.trim()) return 0;
    const raw = value.trim();
    if (/^\d+(?:\.\d+)?$/.test(raw)) return Number(raw) * 1000;
    const date = Date.parse(raw);
    return Number.isFinite(date) ? Math.max(0, date - wallNow()) : 0;
  };
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    if (remaining() <= 0) throw budgetError();
    let response, text;
    const controller = new AbortController();
    try {
      ({ response, text } = await bounded(async () => {
        const current = await request(url, { method, headers, body: serializedBody, signal: controller.signal, redirect: 'error' });
        return { response: current, text: await current.text() };
      }, Math.min(30000, remaining()), controller));
    } catch (error) {
      lastError = new Error(redactCredentials(`CNB transport failed ${url}: ${error.message}`, token));
      if (!readOnly || attempt === retries) throw lastError;
      await waitForRetry(Math.min(baseDelayMs * 2 ** attempt, 30000));
      continue;
    }
    if (remaining() <= 0) throw budgetError();
    if (response.ok) {
      if (!text) return null;
      try { return JSON.parse(text); } catch { return text; }
    }
    lastError = new CnbError(response.status, text, url, token);
    if (!readOnly || !RETRYABLE_STATUS.has(response.status) || attempt === retries) throw lastError;
    const fallback = response.status === 429
      ? [5000, 15000, 45000, 60000][Math.min(attempt, 3)]
      : Math.min(baseDelayMs * 2 ** attempt + Math.floor(Math.random() * 250), 30000);
    // A server's longer Retry-After is never clamped to an earlier retry.
    await waitForRetry(Math.max(fallback, retryAfterDelay(response.headers.get('retry-after'))));
  }
  throw lastError;
}

/** Strict read: only HTTP 404 means absent; permission/transport failures stay errors. */
export async function rawFile(slug, ref, path, options = {}) {
  const token = options.token ?? requireToken();
  const url = `${API_BASE}/${slug}/-/git/raw/${ref}/${path}`;
  let response;
  try {
    response = await fetch(url, {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(30000), redirect: 'error',
    });
  } catch (error) { throw new Error(redactCredentials(`CNB raw transport failed: ${error.message}`, token)); }
  if (response.status === 404) return null;
  const text = await response.text();
  if (!response.ok) throw new CnbError(response.status, text, url, token);
  return text;
}

export function listRepos(groupSlug, options = {}) {
  return api(groupSlug, "/-/repos?page_size=100", options).then((data) =>
    Array.isArray(data) ? data : (data?.data ?? data?.repos ?? []));
}

export function listLabels(slug, options = {}) {
  return api(slug, "/-/labels?page_size=100", options).then((data) =>
    Array.isArray(data) ? data : (data?.data ?? []));
}

export function createLabel(slug, label, options = {}) {
  return api(slug, "/-/labels", { method: "POST", body: label, ...options });
}

export function deleteLabel(slug, name, options = {}) {
  return api(slug, `/-/labels/${encodeURIComponent(name)}`, { method: "DELETE", ...options });
}

export function listBranchProtections(slug, options = {}) {
  return api(slug, "/-/settings/branch-protections", options).then((data) =>
    Array.isArray(data) ? data : (data?.data ?? []));
}

export function createBranchProtection(slug, payload, options = {}) {
  return api(slug, "/-/settings/branch-protections", { method: "POST", body: payload, ...options });
}

/** CNB 分支保护在字段缺失时返回笼统 400，必须给全字段 */
export function branchProtectionPayload({ rule = "main", requireReview = true } = {}) {
  return {
    rule,
    allow_creation: true,
    allow_deletions: false,
    allow_force_pushes: false,
    allow_master_creation: true,
    allow_master_deletions: false,
    allow_master_force_pushes: false,
    allow_master_manual_merge: true,
    allow_master_pushes: false,
    allow_pushes: false,
    forbid_approve_pull_created_by_own_npc: true,
    required_approved_review_count: 1,
    required_approved_review_ratio: 100,
    required_commit_signatures: false,
    required_linear_history: false,
    required_master_approve: false,
    required_must_auto_merge: false,
    required_must_push_via_pull_request: true,
    required_pull_request_reviews: Boolean(requireReview),
    required_status_checks: true,
  };
}

/** 规则存在不等于保护有效；只接受可回读的实际强约束。 */
export function validateBranchProtection(rule, { requireReview = true, forbidManualOverride = false } = {}) {
  const expected = {
    allow_deletions: false, allow_force_pushes: false, allow_pushes: false,
    allow_master_deletions: false, allow_master_force_pushes: false, allow_master_pushes: false,
    required_must_push_via_pull_request: true, required_status_checks: true,
  };
  if (requireReview) {
    expected.required_pull_request_reviews = true;
    expected.forbid_approve_pull_created_by_own_npc = true;
  }
  if (forbidManualOverride) expected.allow_master_manual_merge = false;
  const errors = Object.entries(expected).filter(([name, value]) => rule?.[name] !== value).map(([name, value]) => `${name} 必须为 ${value}`);
  if (rule?.rule !== 'main') errors.push('分支保护目标必须为 main');
  if (requireReview && !(Number.isSafeInteger(rule?.required_approved_review_count) && rule.required_approved_review_count >= 1)) errors.push("required_approved_review_count 必须至少为1");
  return errors;
}

export function createIssue(slug, { title, body, labels = [] }, options = {}) {
  return api(slug, "/-/issues", { method: "POST", body: { title, body, labels }, ...options });
}

export function createIssueComment(slug, number, body, options = {}) {
  return api(slug, `/-/issues/${number}/comments`, { method: "POST", body: { body }, ...options });
}

export function closeIssue(slug, number, options = {}) {
  return api(slug, `/-/issues/${number}`, {
    method: "PATCH",
    body: { state: "closed", state_reason: "completed" },
    ...options,
  });
}

export function listIssues(slug, { state = "open" } = {}, options = {}) {
  // CNB 的 state 只接受 open|closed（传 all 会 400），all 由两次查询合并实现。
  if (state === "all") {
    return Promise.all([
      listIssues(slug, { state: "open" }, options),
      listIssues(slug, { state: "closed" }, options),
    ]).then((pages) => pages.flat());
  }
  if (state !== "open" && state !== "closed") {
    throw new Error(`listIssues 不支持 state=${state}（CNB 只接受 open|closed）`);
  }
  return api(slug, `/-/issues?page_size=100&state=${state}`, options).then((data) =>
    Array.isArray(data) ? data : (data?.data ?? []));
}

export function createPull(slug, { title, head, base = "main", body }, options = {}) {
  return api(slug, "/-/pulls", { method: "POST", body: { title, head, base, body }, ...options });
}

export function listPulls(slug, { state = "open", baseRef } = {}, options = {}) {
  const query = new URLSearchParams({ page_size: "100", state });
  if (baseRef) query.set("base_ref", baseRef);
  return api(slug, `/-/pulls?${query.toString()}`, options).then((data) =>
    Array.isArray(data) ? data : (data?.data ?? []));
}

export function getPull(slug, number, options = {}) {
  return api(slug, `/-/pulls/${number}`, options);
}

export function getPullFiles(slug, number, options = {}) {
  return api(slug, `/-/pulls/${number}/files`, options).then((data) =>
    (Array.isArray(data) ? data : (data?.data ?? [])).map((file) => ({
      filename: file.filename ?? file.new_path ?? file.path,
      status: file.status,
    })));
}

export function getPullCommitStatuses(slug, number, options = {}) {
  return api(slug, `/-/pulls/${number}/commit-statuses`, options);
}

/**
 * 合并合并请求。CNB 未暴露 auto-merge 开关，自动合并由调用方在
 * “全部门禁 success 且 mergeable_state=mergeable” 后调用本函数完成。
 */
export function mergePull(slug, number, { mergeStyle = "squash", commitTitle, commitMessage, force } = {}, options = {}) {
  if (!commitTitle) throw new Error("mergePull 需要 commitTitle（CNB 合并接口要求显式提交标题）");
  if (force === true) throw new Error('禁止强制合并；必须满足平台评审与状态检查');
  const body = { merge_style: mergeStyle };
  body.commit_title = commitTitle;
  if (commitMessage) body.commit_message = commitMessage;
  if (force !== undefined) body.force = Boolean(force);
  return api(slug, `/-/pulls/${number}/merge`, { method: "PUT", body, ...options });
}

export function addPullLabels(slug, number, labels, options = {}) {
  return api(slug, `/-/pulls/${number}/labels`, { method: "POST", body: { labels }, ...options });
}

/**
 * 比较 `base...head` 的提交差异（返回**完整路径**）。
 * 注意：`GET /pulls/{n}/files` 的 `filename` 字段会丢目录（实测把
 * `docs/DEVELOPMENT-PROTOCOL.md` 报成 `DEVELOPMENT-PROTOCOL.md`），
 * 因此“改动文件白名单”判定必须用本接口，PR 文件接口只作兜底展示。
 */
export function compareCommits(slug, baseHead, options = {}) {
  return api(slug, `/-/git/compare/${encodeURIComponent(baseHead)}`, options).then((data) => ({
    totalCommits: data?.total_commits ?? 0,
    headSha: data?.head_commit?.sha ?? null,
    files: (data?.files ?? []).map((file) => ({ path: file.path ?? file.name, status: file.status })),
  }));
}

export function getBranch(slug, branch, options = {}) {
  return api(slug, `/-/git/branches/${branch}`, options);
}
