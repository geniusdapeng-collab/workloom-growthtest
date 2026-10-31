/** Actual isolated repository identity. No directory/profile fallback and no network access. */
import { execFileSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { join } from 'node:path';

const invalidIdentity = () => new Error('repositoryInstance 的实际仓库身份缺失、冲突或无效；不得从目录、profile 或同步元数据推定');
function canonicalRepository(value) {
  if (typeof value !== 'string' || value !== value.trim() || !/^[A-Za-z0-9][A-Za-z0-9._-]*(?:\/[A-Za-z0-9][A-Za-z0-9._-]*)+$/.test(value)) throw invalidIdentity();
  return value.toLowerCase();
}
function repositoryFromOrigin(value) {
  // Validate the original bytes before URL parsing could normalize dot segments or userinfo.
  const match = typeof value === 'string' && /^https:\/\/(?:github\.com|cnb\.cool)\/([A-Za-z0-9][A-Za-z0-9._-]*(?:\/[A-Za-z0-9][A-Za-z0-9._-]*)+)\/?$/i.exec(value);
  if (!match) throw invalidIdentity();
  const path = match[1].endsWith('.git') ? match[1].slice(0, -4) : match[1];
  return canonicalRepository(path);
}
function gitEnvironment(env) {
  // Git location/config injection must not redirect this read to another checkout.
  const cleaned = Object.fromEntries(Object.entries(env).filter(([key]) => !/^GIT_/i.test(key)));
  return { ...cleaned, GIT_TERMINAL_PROMPT: '0', GIT_CONFIG_NOSYSTEM: '1' };
}

export function repositoryInstanceOf(repoRoot, { env = process.env, timeoutMs = 5000 } = {}) {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 5000) throw invalidIdentity();
  if (env.CNB && !['true', 'false'].includes(env.CNB)) throw invalidIdentity();
  if (env.CNB === 'true') {
    const repository = canonicalRepository(env.CNB_REPO_SLUG);
    if (env.CNB_REPO_SLUG_LOWERCASE !== undefined && env.CNB_REPO_SLUG_LOWERCASE !== ''
        && env.CNB_REPO_SLUG_LOWERCASE !== repository) throw invalidIdentity();
    // CNB documents this marker and slug as platform-injected, read-only variables.
    return { repository, source: 'cnb:CNB_REPO_SLUG' };
  }
  let topLevel; let origins;
  try {
    const options = { cwd: repoRoot, env: gitEnvironment(env), encoding: 'utf8', timeout: timeoutMs, maxBuffer: 64 * 1024, stdio: ['ignore', 'pipe', 'pipe'] };
    topLevel = realpathSync(execFileSync('git', ['rev-parse', '--show-toplevel'], options).trim());
    const actualRoot = realpathSync(repoRoot);
    // The governance consumer belongs to its enclosing repository, not to its directory name.
    if (actualRoot !== topLevel && actualRoot !== join(topLevel, 'governance')) throw invalidIdentity();
    const raw = execFileSync('git', ['config', '--local', '--no-includes', '--null', '--get-all', 'remote.origin.url'], options);
    if (!raw.endsWith('\0')) throw invalidIdentity();
    origins = raw.slice(0, -1).split('\0');
  } catch {
    // Do not copy Git's stderr, arguments or exception message: they may contain raw URLs.
    throw new Error('repositoryInstance 的本仓 Git 身份不可读取（缺失、超时或无效）；未采用任何推定身份');
  }
  if (origins.length !== 1) throw invalidIdentity();
  return { repository: repositoryFromOrigin(origins[0]), source: 'git:remote.origin.url' };
}
