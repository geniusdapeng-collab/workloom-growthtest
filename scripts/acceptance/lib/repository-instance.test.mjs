import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { repositoryInstanceOf } from './repository-instance.mjs';

const localEnv = () => ({ ...process.env, CNB: '', CNB_REPO_SLUG: '', CNB_REPO_SLUG_LOWERCASE: '' });
function fixture(t) {
  const parent = mkdtempSync(join(tmpdir(), 'rdas-instance-')); const root = join(parent, 'workspace');
  mkdirSync(root); t.after(() => rmSync(parent, { recursive: true, force: true }));
  execFileSync('git', ['init', '-q', root], { stdio: 'ignore' });
  return { parent, root };
}
function origin(f, url) { execFileSync('git', ['config', '--local', '--add', 'remote.origin.url', url], { cwd: f.root, stdio: 'ignore' }); }
function identify(f, env = localEnv()) { return repositoryInstanceOf(f.root, { env }); }
function safelyRejected(callback, forbidden = []) {
  assert.throws(callback, (error) => {
    assert.match(error.message, /repositoryInstance/);
    for (const value of forbidden) assert.equal(String(error.stack).includes(value), false, 'unsafe value must not be copied into diagnostics');
    return true;
  });
}

test('G14 repository identity: CNB read-only slug works without Git or an instance-shaped directory', () => {
  assert.deepEqual(repositoryInstanceOf('/path-that-does-not-exist', { env: { CNB: 'true', CNB_REPO_SLUG: 'Reviewed-Org/Subgroup/Isolated-Repo', CNB_REPO_SLUG_LOWERCASE: 'reviewed-org/subgroup/isolated-repo' } }), { repository: 'reviewed-org/subgroup/isolated-repo', source: 'cnb:CNB_REPO_SLUG' });
});
test('G14 repository identity: optional CNB lowercase field may be absent but may not contradict the full path', () => {
  const valid = { CNB: 'true', CNB_REPO_SLUG: 'workloom-ai/Isolated-Repo' };
  assert.equal(repositoryInstanceOf('/unused', { env: valid }).repository, 'workloom-ai/isolated-repo');
  for (const lower of ['other-org/isolated-repo', 'workloom-ai/Isolated-Repo', true]) safelyRejected(() => repositoryInstanceOf('/unused', { env: { ...valid, CNB_REPO_SLUG_LOWERCASE: lower } }));
});
for (const [name, slug] of [['missing', undefined], ['empty', ''], ['URL', 'https://cnb.cool/workloom-ai/isolated-repo'], ['single segment', 'isolated-repo'], ['traversal', 'workloom-ai/../isolated-repo'], ['encoded', 'workloom-ai/%69solated-repo'], ['whitespace', ' workloom-ai/isolated-repo'], ['fragment', 'workloom-ai/isolated-repo#opaque']]) {
  test(`G14 repository identity: ${name} CNB slug fails without origin fallback`, (t) => {
    const f = fixture(t); origin(f, 'https://cnb.cool/workloom-ai/isolated-repo');
    safelyRejected(() => identify(f, { ...localEnv(), CNB: 'true', CNB_REPO_SLUG: slug }));
  });
}
test('G14 repository identity: canonical local origin is read from the actual workspace repository', (t) => {
  const f = fixture(t); origin(f, 'https://cnb.cool/Reviewed-Org/Subgroup/Isolated-Repo.git');
  assert.deepEqual(identify(f), { repository: 'reviewed-org/subgroup/isolated-repo', source: 'git:remote.origin.url' });
});
test('G14 repository identity: canonical GitHub origin is read from the actual workspace repository', (t) => {
  const f = fixture(t); origin(f, 'https://github.com/Reviewed-Org/Isolated-Repo.git');
  assert.deepEqual(identify(f), { repository: 'reviewed-org/isolated-repo', source: 'git:remote.origin.url' });
});
test('G14 repository identity: an unmarked CNB variable cannot replace local Git identity', (t) => {
  const f = fixture(t); origin(f, 'https://cnb.cool/workloom-ai/isolated-repo');
  assert.equal(identify(f, { ...localEnv(), CNB: 'false', CNB_REPO_SLUG: 'other-org/isolated-repo' }).repository, 'workloom-ai/isolated-repo');
  safelyRejected(() => identify(f, { ...localEnv(), CNB: 'TRUE', CNB_REPO_SLUG: 'workloom-ai/isolated-repo' }));
});
test('G14 repository identity: a governance consumer resolves its enclosing Git repository', (t) => {
  const f = fixture(t); origin(f, 'https://cnb.cool/workloom-ai/isolated-repo'); mkdirSync(join(f.root, 'governance'));
  assert.equal(repositoryInstanceOf(join(f.root, 'governance'), { env: localEnv() }).repository, 'workloom-ai/isolated-repo');
  mkdirSync(join(f.root, 'unregistered-child')); safelyRejected(() => repositoryInstanceOf(join(f.root, 'unregistered-child'), { env: localEnv() }));
});
test('G14 repository identity: missing local origin stays unverified by any guessed source', (t) => {
  const f = fixture(t); safelyRejected(() => identify(f));
});
for (const [name, second] of [['equal', 'https://cnb.cool/workloom-ai/isolated-repo'], ['different', 'https://cnb.cool/another-org/isolated-repo']]) {
  test(`G14 repository identity: ${name} duplicate local origins are rejected`, (t) => {
    const f = fixture(t); origin(f, 'https://cnb.cool/workloom-ai/isolated-repo'); origin(f, second); safelyRejected(() => identify(f));
  });
}
const credentialed = new URL('https://cnb.cool/workloom-ai/isolated-repo'); credentialed.username = 'fixture-user'; credentialed.password = ['testonly', 'origin', 'opaque'].join('-');
for (const [name, url] of [
  ['userinfo', credentialed.href], ['query', 'https://cnb.cool/workloom-ai/isolated-repo?testonly=opaque'],
  ['fragment', 'https://cnb.cool/workloom-ai/isolated-repo#testonly-opaque'], ['different host', 'https://example.test/workloom-ai/isolated-repo'],
  ['github suffix', 'https://github.com.example.test/workloom-ai/isolated-repo'],
  ['host suffix', 'https://cnb.cool.example.test/workloom-ai/isolated-repo'], ['unsupported protocol', 'file:///workloom-ai/isolated-repo'],
  ['port', 'https://cnb.cool:8443/workloom-ai/isolated-repo'], ['dot segments', 'https://cnb.cool/workloom-ai/other/../isolated-repo'],
  ['encoded path', 'https://cnb.cool/workloom-ai/%69solated-repo'], ['duplicate separators', 'https://cnb.cool/workloom-ai//isolated-repo'],
]) test(`G14 repository identity: ${name} local origin is rejected with safe diagnostics`, (t) => {
  const f = fixture(t); origin(f, url); safelyRejected(() => identify(f), [url, credentialed.password]);
});
test('G14 repository identity: ambient Git directory, worktree and injected config cannot choose another repository', (t) => {
  const f = fixture(t); const other = fixture(t); origin(f, 'https://cnb.cool/workloom-ai/isolated-repo'); origin(other, 'https://cnb.cool/another-org/isolated-repo');
  const env = { ...localEnv(), GIT_DIR: join(other.root, '.git'), GIT_WORK_TREE: other.root, GIT_COMMON_DIR: join(other.root, '.git'), GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'remote.origin.url', GIT_CONFIG_VALUE_0: 'https://cnb.cool/another-org/isolated-repo' };
  assert.deepEqual(identify(f, env), { repository: 'workloom-ai/isolated-repo', source: 'git:remote.origin.url' });
});
test('G14 repository identity: Git timeout returns a generic bounded failure without copying stderr', (t) => {
  const f = fixture(t); const bin = join(f.parent, 'bin'); mkdirSync(bin);
  const path = join(bin, 'git'); writeFileSync(path, "#!/bin/sh\nprintf '%s\\n' 'testonly-origin-opaque' >&2\nexec /bin/sleep 5\n"); chmodSync(path, 0o700);
  safelyRejected(() => repositoryInstanceOf(f.root, { env: { ...localEnv(), PATH: bin }, timeoutMs: 50 }), ['testonly-origin-opaque']);
});
test('G14 repository identity: missing Git and invalid timeout do not create a guessed identity', (t) => {
  const f = fixture(t); safelyRejected(() => repositoryInstanceOf(f.root, { env: { ...localEnv(), PATH: '' } }));
  for (const timeoutMs of [0, 5001, NaN]) safelyRejected(() => repositoryInstanceOf(f.root, { env: localEnv(), timeoutMs }));
});
