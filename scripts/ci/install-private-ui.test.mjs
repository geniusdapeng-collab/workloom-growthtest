import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir, mkdtemp, rm, realpath, stat, lstat, symlink, link, access } from 'node:fs/promises';
import { join, dirname, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import { parseArguments, externalOutput, installPrivateUi } from './install-private-ui.mjs';
import { PIN, BootstrapError, digest, verifyArchive } from './ui-auth-bootstrap.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const source = resolve(here, '../..');
const wrapperPath = join(here, 'install-private-ui.mjs');
const wrapperBytes = await readFile(wrapperPath);
const coreUrl = pathToFileURL(join(here, 'ui-auth-bootstrap.mjs')).href;
if (!process.env.WORKLOOM_UI_TEST_ARCHIVE_PATH) throw new BootstrapError('MISSING_UI_TEST_ARCHIVE_PATH');
const archive = await readFile(resolve(process.env.WORKLOOM_UI_TEST_ARCHIVE_PATH));
verifyArchive(archive);
const stateBytes = await readFile(join(source, '.workloom-ui.json'));
const areas = await mkdtemp(join(tmpdir(), 'workloom-private-ui-wrapper-test-'));
after(async () => { await rm(areas, { recursive: true, force: true }); });
const errorCode = code => error => error instanceof BootstrapError && error.code === code;
const absent = async path => assert.rejects(access(path), error => error.code === 'ENOENT');

async function fixture() {
  const dir = await realpath(await mkdtemp(join(areas, 'case-'))); const repo = join(dir, 'repo'); const outside = join(dir, 'outside');
  await mkdir(repo); await mkdir(outside); await writeFile(join(repo, '.workloom-ui.json'), stateBytes);
  const paths = { dir, repo, outside, archive: join(outside, 'original.tgz'), report: join(outside, 'report.json'), store: join(outside, 'store') };
  paths.args = ['--repo', repo, '--store-dir', paths.store, '--staging-root', outside, '--archive', paths.archive, '--report', paths.report];
  return paths;
}
function mockFetch({ denied = false } = {}) {
  const calls = [];
  const fetchImplementation = async (url, options) => {
    calls.push({ url: String(url), options });
    if (calls.length === 1) return new Response(JSON.stringify({ tag_name: PIN.tag, draft: false, prerelease: false, id: 'wrapper-fixture-release', assets: [{ name: PIN.assetName, size: PIN.bytes, hash_algo: 'sha256', hash_value: PIN.sha256, browser_download_url: PIN.canonicalUrl, url: PIN.apiUrl, id: 'wrapper-fixture-asset' }] }), { status: denied ? 401 : 200 });
    if (calls.length === 2) return new Response(null, { status: 302, headers: { Location: 'https://asset.cnb.cool/wrapper-fixture?signature=synthetic' } });
    assert.equal(calls.length, 3, 'an unexpected fourth network call is a failure');
    return new Response(archive, { status: 200 });
  };
  return { calls, fetchImplementation };
}

// The copied wrapper is byte-identical to production. Only its two pnpm-boundary
// functions are fixtures; PIN, BootstrapError and all download checks remain real.
// A successful boundary fixture is never a cold pnpm install receipt.
async function boundaryFixture() {
  const f = await fixture(); const modules = join(f.dir, 'modules'); await mkdir(modules);
  await writeFile(join(modules, 'install-private-ui.mjs'), wrapperBytes);
  assert.equal(digest(await readFile(join(modules, 'install-private-ui.mjs'))), digest(wrapperBytes));
  await writeFile(join(modules, 'ui-auth-bootstrap.mjs'), `
import { PIN, BootstrapError, downloadPinnedArchive, digest } from ${JSON.stringify(coreUrl)};
export { PIN, BootstrapError, downloadPinnedArchive };
export const control = { trace: [], failure: null };
export async function warmCanonicalStore(options) {
  control.trace.push({ phase: 'warm', repoRoot: options.repoRoot, storeDir: options.storeDir, stagingRoot: options.stagingRoot, archiveSha256: digest(options.archiveBytes) });
  if (control.failure === 'warm') throw new BootstrapError('WRAPPER_FIXTURE_WARM_FAILURE');
  return { scope: 'wrapper-boundary-fixture', originalLockSha256: 'fixture-lock', canonicalPackageId: PIN.canonicalUrl };
}
export async function installCanonicalFrozen(options) {
  control.trace.push({ phase: 'install', repoRoot: options.repoRoot, storeDir: options.storeDir, stagingRoot: options.stagingRoot, proofScope: options.warmProof.scope });
  if (control.failure === 'install') throw new BootstrapError('WRAPPER_FIXTURE_INSTALL_FAILURE');
  return { ...options.warmProof, installedVersion: PIN.version, installedClients: [{ client: 'web' }, { client: 'webb' }, { client: 'webc' }], frozenInstallPassed: true, originalLockUnchanged: true };
}
`);
  const module = await import(pathToFileURL(join(modules, 'install-private-ui.mjs')).href);
  const { control } = await import(pathToFileURL(join(modules, 'ui-auth-bootstrap.mjs')).href);
  return { ...f, module, control };
}
const syntheticEnvironment = { WORKLOOM_UI_RELEASE_READ_TOKEN: 'wrapper-fixture-token' };

test('argument parsing accepts required flags in any order and defaults the repo at execution', () => {
  assert.deepEqual(parseArguments(['--report', 'report', '--archive', 'archive', '--staging-root', 'stage', '--store-dir', 'store']), { '--report': 'report', '--archive': 'archive', '--staging-root': 'stage', '--store-dir': 'store' });
  assert.equal(parseArguments(['--repo', '.', '--store-dir', 'store', '--staging-root', 'stage', '--archive', 'archive', '--report', 'report'])['--repo'], '.');
});
for (const [label, args, code] of [
  ['empty', [], 'UI_INSTALL_REQUIRED_ARGUMENT'],
  ['missing archive', ['--store-dir', 's', '--staging-root', 't', '--report', 'r'], 'UI_INSTALL_REQUIRED_ARGUMENT'],
  ['unknown flag', ['--unsafe', 'value'], 'UI_INSTALL_ARGUMENT'],
  ['missing value', ['--repo'], 'UI_INSTALL_ARGUMENT'],
  ['empty value', ['--repo', ''], 'UI_INSTALL_ARGUMENT'],
  ['flag as value', ['--repo', '--store-dir'], 'UI_INSTALL_ARGUMENT'],
  ['duplicate', ['--repo', '.', '--repo', '.'], 'UI_INSTALL_DUPLICATE_ARGUMENT'],
]) test('argument parsing rejects ' + label, () => assert.throws(() => parseArguments(args), errorCode(code)));

test('external output accepts a sibling and resolves an external parent symlink', async () => {
  const f = await fixture(); const alias = join(f.dir, 'external-alias'); await symlink(f.outside, alias, 'dir');
  assert.equal(await externalOutput(f.repo, join(f.outside, 'out')), join(await realpath(f.outside), 'out'));
  assert.equal(await externalOutput(f.repo, join(alias, 'out')), join(await realpath(f.outside), 'out'));
});
test('external output rejects source, dot-dot-looking child, traversal back in and a parent symlink into source', async () => {
  const f = await fixture(); const child = join(f.repo, '..child'); await mkdir(child); const alias = join(f.outside, 'source-alias'); await symlink(f.repo, alias, 'dir');
  for (const path of [join(f.repo, 'out'), join(child, 'out'), join(f.outside, '..', 'repo', 'out'), join(alias, 'out')]) await assert.rejects(externalOutput(f.repo, path), errorCode('UI_OUTPUT_INSIDE_SOURCE'));
});
test('a missing external parent fails before network or file creation', async () => {
  const f = await fixture(); const mock = mockFetch(); const args = [...f.args]; args[args.indexOf('--report') + 1] = join(f.outside, 'missing-parent', 'out');
  await assert.rejects(installPrivateUi({ args, environment: syntheticEnvironment, ...mock }), error => error.code === 'ENOENT');
  assert.equal(mock.calls.length, 0); await absent(f.archive); await absent(f.report);
});
test('output collision including normalized aliases fails before network', async () => {
  const f = await fixture(); const mock = mockFetch(); const args = [...f.args]; args[args.indexOf('--report') + 1] = join(f.outside, '.', 'original.tgz');
  await assert.rejects(installPrivateUi({ args, environment: syntheticEnvironment, ...mock }), errorCode('UI_OUTPUT_COLLISION'));
  assert.equal(mock.calls.length, 0); await absent(f.archive);
});
test('real wrapper rejects missing credentials before network, archive and report', async () => {
  const f = await fixture(); const mock = mockFetch();
  await assert.rejects(installPrivateUi({ args: f.args, environment: {}, ...mock }), errorCode('MISSING_UI_RELEASE_TOKEN'));
  assert.equal(mock.calls.length, 0); await absent(f.archive); await absent(f.report);
});
test('real wrapper resolves a repo alias before enforcing source output boundaries', async () => {
  const f = await fixture(); const alias = join(f.outside, 'repo-alias'); await symlink(f.repo, alias, 'dir');
  const args = [...f.args]; args[args.indexOf('--repo') + 1] = alias; args[args.indexOf('--archive') + 1] = join(alias, 'output.tgz');
  const mock = mockFetch(); await assert.rejects(installPrivateUi({ args, environment: syntheticEnvironment, ...mock }), errorCode('UI_OUTPUT_INSIDE_SOURCE'));
  assert.equal(mock.calls.length, 0); await absent(join(f.repo, 'output.tgz')); await absent(f.report);
});
test('real CLI reports a safe explicit credential failure without creating outputs', async () => {
  const f = await fixture(); const result = spawnSync(process.execPath, [wrapperPath, ...f.args], { cwd: source, env: { PATH: process.env.PATH ?? '', HOME: f.outside }, encoding: 'utf8', timeout: 10000 });
  assert.equal(result.error, undefined); assert.equal(result.status, 1); assert.equal(result.stdout, '');
  assert.deepEqual(JSON.parse(result.stderr), { code: 'MISSING_UI_RELEASE_TOKEN', message: 'MISSING_UI_RELEASE_TOKEN' });
  await absent(f.archive); await absent(f.report);
});
test('invalid consumer identity and denied download leave no archive or report', async () => {
  for (const mode of ['state', 'denied']) {
    const f = await fixture(); const mock = mockFetch({ denied: mode === 'denied' });
    if (mode === 'state') { const state = JSON.parse(stateBytes); state.version = 'wrong'; await writeFile(join(f.repo, '.workloom-ui.json'), JSON.stringify(state)); }
    await assert.rejects(installPrivateUi({ args: f.args, environment: syntheticEnvironment, ...mock }), errorCode(mode === 'state' ? 'UI_STATE_IDENTITY' : 'UI_RELEASE_HTTP_401'));
    assert.equal(mock.calls.length, mode === 'state' ? 0 : 1); await absent(f.archive); await absent(f.report);
  }
});
test('wrapper boundary success keeps original bytes and private file modes and links the actual warm proof', async () => {
  const f = await boundaryFixture(); const mock = mockFetch();
  const result = await f.module.installPrivateUi({ args: f.args, environment: syntheticEnvironment, ...mock });
  assert.equal(result.scope, 'wrapper-boundary-fixture'); assert.deepEqual(await readFile(f.archive), archive);
  assert.equal((await stat(f.archive)).mode & 0o777, 0o600); assert.equal((await stat(f.report)).mode & 0o777, 0o600);
  assert.equal(result.originalArchive.sha256, PIN.sha256); assert.equal(result.originalArchive.publicArtifactUploaded, false);
  assert.deepEqual(JSON.parse(await readFile(f.report, 'utf8')), result);
  assert.deepEqual(f.control.trace, [
    { phase: 'warm', repoRoot: await realpath(f.repo), storeDir: f.store, stagingRoot: f.outside, archiveSha256: PIN.sha256 },
    { phase: 'install', repoRoot: await realpath(f.repo), storeDir: f.store, stagingRoot: f.outside, proofScope: 'wrapper-boundary-fixture' },
  ]);
  assert.equal(mock.calls.length, 3); assert.equal(JSON.stringify(result).includes('wrapper-fixture-token'), false); assert.equal(JSON.stringify(result).includes('?signature='), false);
  assert.deepEqual(mock.calls[2].options.headers, { Accept: 'application/octet-stream' });
});
for (const type of ['file', 'symlink', 'hardlink']) test('archive wx rejects an existing ' + type + ' and preserves its target', async () => {
  const f = await boundaryFixture(); const sentinel = join(f.repo, 'protected'); const protectedBytes = Buffer.from('existing source content'); await writeFile(sentinel, protectedBytes);
  if (type === 'file') await writeFile(f.archive, protectedBytes);
  else if (type === 'symlink') await symlink(sentinel, f.archive);
  else await link(sentinel, f.archive);
  await assert.rejects(f.module.installPrivateUi({ args: f.args, environment: syntheticEnvironment, ...mockFetch() }), error => error.code === 'EEXIST');
  assert.deepEqual(await readFile(sentinel), protectedBytes); assert.deepEqual(await readFile(f.archive), protectedBytes);
  if (type === 'symlink') assert.equal((await lstat(f.archive)).isSymbolicLink(), true);
  assert.deepEqual(f.control.trace, []); await absent(f.report);
});
for (const type of ['file', 'symlink']) test('report wx rejects an existing ' + type + ', preserves it and cleans only its own archive', async () => {
  const f = await boundaryFixture(); const sentinel = join(f.repo, 'protected'); const protectedBytes = Buffer.from('existing report target'); await writeFile(sentinel, protectedBytes);
  if (type === 'file') await writeFile(f.report, protectedBytes); else await symlink(sentinel, f.report);
  await assert.rejects(f.module.installPrivateUi({ args: f.args, environment: syntheticEnvironment, ...mockFetch() }), error => error.code === 'EEXIST');
  assert.deepEqual(await readFile(sentinel), protectedBytes); assert.deepEqual(await readFile(f.report), protectedBytes);
  if (type === 'symlink') assert.equal((await lstat(f.report)).isSymbolicLink(), true);
  assert.deepEqual(f.control.trace.map(row => row.phase), ['warm', 'install']); await absent(f.archive);
});
for (const phase of ['warm', 'install']) test('wrapper cleans the created archive after ' + phase + ' failure and preserves source', async () => {
  const f = await boundaryFixture(); f.control.failure = phase;
  await assert.rejects(f.module.installPrivateUi({ args: f.args, environment: syntheticEnvironment, ...mockFetch() }), errorCode('WRAPPER_FIXTURE_' + phase.toUpperCase() + '_FAILURE'));
  await absent(f.archive); await absent(f.report); assert.deepEqual(await readFile(join(f.repo, '.workloom-ui.json')), stateBytes);
  assert.deepEqual(f.control.trace.map(row => row.phase), phase === 'warm' ? ['warm'] : ['warm', 'install']);
});
test('concurrent attempts yield one archive owner and preserve the successful receipt', async () => {
  const f = await boundaryFixture(); const results = await Promise.allSettled([1, 2].map(() => f.module.installPrivateUi({ args: f.args, environment: syntheticEnvironment, ...mockFetch() })));
  assert.equal(results.filter(row => row.status === 'fulfilled').length, 1);
  const failure = results.find(row => row.status === 'rejected'); assert.equal(failure.reason.code, 'EEXIST');
  assert.deepEqual(await readFile(f.archive), archive); assert.equal(JSON.parse(await readFile(f.report, 'utf8')).scope, 'wrapper-boundary-fixture');
  assert.deepEqual(f.control.trace.map(row => row.phase), ['warm', 'install']);
});

function workflowSteps(text) { return text.split(/(?=^      - )/m).slice(1); }
for (const name of ['ci.yml', 'workloom-ui-contract.yml']) test(name + ' limits the credential to the installer and makes boundary tests mandatory', async () => {
  const text = await readFile(join(source, '.github/workflows', name), 'utf8'); const steps = workflowSteps(text);
  const installs = steps.filter(step => step.includes('install-private-ui.mjs')); assert.equal(installs.length, 1);
  const installer = installs[0]; assert.match(installer, /WORKLOOM_UI_RELEASE_READ_TOKEN: \$\{\{ secrets\.CNB_UI_RELEASE_TOKEN \}\}/);
  assert.doesNotMatch(installer, /continue-on-error|if:|GITHUB_ENV|GITHUB_OUTPUT|upload-artifact/);
  for (const flag of ['--repo', '--store-dir', '--staging-root', '--archive', '--report']) assert.ok(installer.includes(flag));
  assert.equal(text.split('secrets.CNB_UI_RELEASE_TOKEN').length - 1, 1);
  const others = text.replace(installer, ''); assert.doesNotMatch(others, /WORKLOOM_UI_RELEASE_READ_TOKEN|CNB_UI_RELEASE_TOKEN/);
  const next = steps[steps.indexOf(installer) + 1]; assert.match(next, /WORKLOOM_UI_TEST_ARCHIVE_PATH: \$\{\{ runner\.temp \}\}\/workloom-ui-original\.tgz/);
  assert.match(next, /node --test --test-concurrency=1 scripts\/ci\/ui-auth-bootstrap\.test\.mjs scripts\/ci\/install-private-ui\.test\.mjs/);
  assert.doesNotMatch(next, /secrets\.|continue-on-error|if:|--test-skip|\|\| true/);
  assert.doesNotMatch(text, /(?:^|\n)\s+continue-on-error: true/);
  const uploads = steps.filter(step => step.includes('actions/upload-artifact'));
  for (const step of uploads) assert.doesNotMatch(step, /workloom-ui-original|workloom-ui-bootstrap|RUNNER_TEMP|runner\.temp|\.tgz/);
});
test('ci-gate retains real PostgreSQL, DB test opt-in and its existing downstream gates', async () => {
  const text = await readFile(join(source, '.github/workflows/ci.yml'), 'utf8');
  for (const fragment of ['services:\n      postgres:', 'image: pgvector/pgvector:pg17', 'DATABASE_URL: postgres://', 'DATABASE_APP_URL: postgres://', 'DATABASE_GATEWAY_URL: postgres://', 'RUN_DB_TESTS: "1"', 'pnpm -r --if-present typecheck', 'pnpm db:migrate', 'pnpm db:seed', 'pnpm db:verify-chain', 'pnpm -C packages/shared test', 'pnpm -C packages/base test', 'pnpm -C packages/runtime test', 'pnpm suite', 'pnpm -C apps/web build', 'bash scripts/dsh-gate.sh']) assert.ok(text.includes(fragment), fragment);
  assert.equal(text.split('pnpm db:seed').length - 1, 2); assert.doesNotMatch(text, /RUN_DB_TESTS: ["']?0|pnpm install --no-frozen-lockfile/);
});
test('UI contract retains governance, all three builds and browser smoke gates', async () => {
  const text = await readFile(join(source, '.github/workflows/workloom-ui-contract.yml'), 'utf8');
  for (const fragment of ['WORKLOOM_DIR: .', 'verify-ui-consumer.mjs', '--require-governance-state', 'verify-client-foundation-consumer.mjs', 'verify-product-content.mjs', 'bundle-governance.mts', 'pnpm -C "$WORKLOOM_DIR" test', 'for CLIENT in web webb webc; do', 'pnpm -C "$WORKLOOM_DIR/apps/$CLIENT" typecheck', 'pnpm -C "$WORKLOOM_DIR/apps/$CLIENT" build', 'playwright install --with-deps chromium', 'test:consumer']) assert.ok(text.includes(fragment), fragment);
});
