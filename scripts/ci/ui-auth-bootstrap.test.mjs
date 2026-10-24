import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdir, mkdtemp, writeFile, readdir, copyFile, rm } from 'node:fs/promises';
import { join, dirname, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';
import {
  PIN, LEGACY_PIN, BootstrapError, digest, verifyArchive, readArchiveManifest, validateState,
  validateAssetRedirect, downloadPinnedArchive, canonicalLockBinding, transportLock,
  childEnvironment, runProcess, expectedIndexPath, validateCanonicalIndex,
  warmCanonicalStore, installCanonicalFrozen,
} from './ui-auth-bootstrap.mjs';

const root = dirname(fileURLToPath(import.meta.url));
const source = resolve(root, '../..');
function requiredArchivePath(environment = process.env) {
  if (!environment.WORKLOOM_UI_TEST_ARCHIVE_PATH) throw new BootstrapError('MISSING_UI_TEST_ARCHIVE_PATH');
  return resolve(environment.WORKLOOM_UI_TEST_ARCHIVE_PATH);
}
// CI provides the verified original bytes outside the checkout. No archive
// is committed or silently omitted from this suite.
const archive = await readFile(requiredArchivePath());
verifyArchive(archive);
const state = JSON.parse(await readFile(join(source, '.workloom-ui.json'), 'utf8'));
const legacyState = { ...state, artifact: { ...state.artifact, platform: 'cnb', url: LEGACY_PIN.canonicalUrl } };
const lock = await readFile(join(source, 'pnpm-lock.yaml'), 'utf8');
const areas = await mkdtemp(join(tmpdir(), 'workloom-ui-bootstrap-test-'));
after(async () => { await rm(areas, { recursive: true, force: true }); });
const errorCode = code => error => error instanceof BootstrapError && error.code === code;
const release = () => ({ tag_name: PIN.tag, draft: false, prerelease: false, id: 'fixture-release', assets: [{ name: PIN.assetName, size: PIN.bytes, hash_algo: 'sha256', hash_value: PIN.sha256, browser_download_url: LEGACY_PIN.canonicalUrl, url: LEGACY_PIN.apiUrl, id: 'fixture-asset' }] });
function mockFetch({ releaseValue = release(), releaseStatus = 200, redirect = 'https://asset.cnb.cool/fixture?signature=private-fixture', finalStatus = 200, finalBytes = archive, failAt } = {}) {
  const calls = [];
  const fetchImplementation = async (url, options) => {
    calls.push({ url: String(url), options });
    if (calls.length === failAt) throw new Error('fixture-token-never-leak https://asset.cnb.cool/?signature=fixture-token-never-leak');
    if (calls.length === 1) return new Response(JSON.stringify(releaseValue), { status: releaseStatus });
    if (calls.length === 2) return new Response(null, { status: 302, headers: { Location: redirect } });
    return new Response(finalBytes, { status: finalStatus });
  };
  return { fetchImplementation, calls };
}
function tar(entries) {
  const result = [];
  for (const { name, body = '', type = '0', corruptChecksum = false } of entries) {
    const bytes = Buffer.from(body); const header = Buffer.alloc(512);
    header.write(name); header.write('0000644\0', 100); header.write('0000000\0', 108); header.write('0000000\0', 116);
    header.write(bytes.length.toString(8).padStart(11, '0') + '\0', 124); header.fill(32, 148, 156); header.write(type, 156); header.write('ustar\0', 257);
    const checksum = header.reduce((sum, byte) => sum + byte, 0) + (corruptChecksum ? 1 : 0);
    header.write(checksum.toString(8).padStart(6, '0') + '\0 ', 148);
    result.push(header, bytes, Buffer.alloc((512 - bytes.length % 512) % 512));
  }
  return gzipSync(Buffer.concat([...result, Buffer.alloc(1024)]));
}
const manifest = JSON.stringify({ name: PIN.package, version: PIN.version });
async function tempFixture() {
  const dir = await mkdtemp(join(areas, 'case-')); const repo = join(dir, 'repo'); const stage = join(dir, 'stage');
  await mkdir(repo); await mkdir(stage);
  for (const name of ['package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml', '.workloom-ui.json', 'apps/web/package.json', 'apps/webb/package.json', 'apps/webc/package.json']) {
    await mkdir(dirname(join(repo, name)), { recursive: true }); await copyFile(join(source, name), join(repo, name));
  }
  return { dir, repo, stage, store: join(dir, 'store') };
}
async function fakePnpm(dir, mode) {
  const file = join(dir, 'fake-pnpm.mjs');
  await writeFile(file, String.raw`import { readFile, writeFile } from 'node:fs/promises';
const mode = ${JSON.stringify(mode)};
if (process.argv.includes('--version')) { console.log(mode === 'wrong-version' ? '11.25.0' : '10.14.0'); process.exit(0); }
if (mode === 'fail-fetch') { console.log('controlled fixture fetch error'); process.exit(7); }
if (mode === 'change-source') {
  const lock = await readFile('pnpm-lock.yaml','utf8');
  const url = lock.match(/tarball: (http:\/\/127\.0\.0\.1:[0-9]+\/workloom-ui-0\.1\.19\.tgz)/)[1];
  const result = await fetch(url); await result.arrayBuffer();
  await writeFile(process.argv[2], '{"name":"changed"}');
  process.exit(0);
}
process.exit(8);
`);
  return file;
}

test('missing archive input fails explicitly without skipping tests', () => {
  assert.throws(() => requiredArchivePath({}), errorCode('MISSING_UI_TEST_ARCHIVE_PATH'));
});
test('the exact original archive is checked by both hashes and 81 manifest entries', () => {
  const proof = verifyArchive(archive);
  assert.equal(proof.sha256, PIN.sha256); assert.equal(proof.sri, PIN.sri); assert.equal(proof.entries, 81);
  assert.equal(proof.name, PIN.package); assert.equal(proof.version, PIN.version);
});
test('archive size, SHA-256 and SRI mismatch fail separately', () => {
  assert.throws(() => verifyArchive(archive.subarray(1)), errorCode('UI_ARCHIVE_SIZE'));
  const corrupt = Buffer.from(archive); corrupt[100] ^= 1;
  assert.throws(() => verifyArchive(corrupt), errorCode('UI_ARCHIVE_SHA256'));
  assert.throws(() => verifyArchive(archive, { ...PIN, sri: PIN.sri.replace('kplO', 'abcd') }), errorCode('UI_ARCHIVE_SRI'));
});
test('bounded tar parser checks package identity and version without extraction', () => {
  assert.equal(readArchiveManifest(tar([{ name: 'package/package.json', body: manifest }])).entries, 1);
  assert.throws(() => readArchiveManifest(tar([{ name: 'package/package.json', body: JSON.stringify({ name: 'wrong', version: PIN.version }) }])), errorCode('UI_ARCHIVE_PACKAGE'));
  assert.throws(() => readArchiveManifest(tar([{ name: 'package/package.json', body: JSON.stringify({ name: PIN.package, version: '0.1.20' }) }])), errorCode('UI_ARCHIVE_VERSION'));
});
for (const [label, entries, code] of [
  ['traversal', [{ name: 'package/../outside' }], 'UI_TAR_PATH'],
  ['absolute', [{ name: '/package/package.json' }], 'UI_TAR_PATH'],
  ['symlink', [{ name: 'package/link', type: '2' }], 'UI_TAR_LINK_OR_EXTENSION'],
  ['hardlink', [{ name: 'package/link', type: '1' }], 'UI_TAR_LINK_OR_EXTENSION'],
  ['extension', [{ name: 'package/header', type: 'x' }], 'UI_TAR_LINK_OR_EXTENSION'],
  ['checksum', [{ name: 'package/package.json', body: manifest, corruptChecksum: true }], 'UI_TAR_CHECKSUM'],
  ['duplicate', [{ name: 'package/package.json', body: manifest }, { name: 'package/package.json', body: manifest }], 'UI_TAR_DUPLICATE'],
  ['bad JSON', [{ name: 'package/package.json', body: '{bad' }], 'UI_ARCHIVE_MANIFEST_JSON'],
  ['no manifest', [{ name: 'package/other.txt', body: 'fixture' }], 'UI_ARCHIVE_MANIFEST_MISSING'],
]) test('tar rejects ' + label, () => assert.throws(() => readArchiveManifest(tar(entries)), errorCode(code)));
test('gzip rejects invalid bytes and oversized expansion', () => {
  assert.throws(() => readArchiveManifest(Buffer.from('invalid')), errorCode('UI_ARCHIVE_GZIP'));
  assert.throws(() => readArchiveManifest(gzipSync(Buffer.alloc(17 * 1024 * 1024))), errorCode('UI_ARCHIVE_GZIP'));
});
test('consumer state keeps canonical version, URL, digest and policy', () => {
  assert.equal(validateState(state), state);
  assert.throws(() => validateState({ ...state, schemaVersion: 'wrong' }), errorCode('UI_STATE_SCHEMA'));
  assert.throws(() => validateState({ ...state, version: '0.1.20' }), errorCode('UI_STATE_IDENTITY'));
  assert.throws(() => validateState({ ...state, artifact: { ...state.artifact, url: 'https://example.com/pkg.tgz' } }), errorCode('UI_STATE_ARTIFACT'));
  assert.throws(() => validateState({ ...state, updatePolicy: 'floating' }), errorCode('UI_STATE_POLICY'));
  assert.throws(() => validateState({ ...state, artifact: undefined }), errorCode('UI_STATE_ARTIFACT'));
  const noPlatform = structuredClone(legacyState); delete noPlatform.artifact.platform; assert.equal(validateState(noPlatform), noPlatform);
});
test('canonical lock binding distinguishes the lock package key from actual pnpm URL package ID', () => {
  const binding = canonicalLockBinding(lock);
  assert.equal(binding.packageId, PIN.canonicalUrl); assert.equal(binding.lockPackageKey, PIN.package + '@' + PIN.canonicalUrl);
  assert.equal(binding.originalSha256, digest(lock));
});
test('only one temporary transport field changes; importers, override, snapshots and SRI stay byte-identical', () => {
  const local = 'http://127.0.0.1:45678/' + PIN.assetName;
  const result = transportLock(lock, local);
  assert.equal(result.source.replace(local, PIN.canonicalUrl), lock);
  assert.equal(result.source.split(local).length - 1, 1);
  assert.equal(result.binding.packageId, PIN.canonicalUrl);
});
for (const [label, mutate, code] of [
  ['wrong format', x => x.replaceAll('\n', '\r\n'), 'UI_LOCK_FORMAT'],
  ['wrong version', x => x.replace("lockfileVersion: '9.0'", "lockfileVersion: '8.0'"), 'UI_LOCK_VERSION'],
  ['wrong SRI', x => x.replace(PIN.sri, PIN.sri.replace('kplO', 'abcd')), 'UI_LOCK_RESOLUTION'],
  ['wrong package ID', x => x.replace("  '@workloom/ui@" + PIN.canonicalUrl + "':", "  '@workloom/ui@https://example.com/other.tgz':"), 'UI_LOCK_PACKAGE_ID'],
  ['wrong override', x => x.replace("'@workloom/ui@0.1.19': " + PIN.canonicalUrl, "'@workloom/ui@0.1.19': https://example.com/other.tgz"), 'UI_LOCK_OVERRIDE'],
]) test('lock rejects ' + label, () => assert.throws(() => canonicalLockBinding(mutate(lock)), errorCode(code)));
for (const url of ['https://127.0.0.1:45678/' + PIN.assetName, 'http://localhost:45678/' + PIN.assetName, 'http://user@127.0.0.1:45678/' + PIN.assetName, 'http://127.0.0.1:45678/' + PIN.assetName + '?token=fixture', 'http://127.0.0.1:45678/other.tgz']) test('loopback prefetch rejects uncontrolled transport ' + url.split('?')[0], () => assert.throws(() => transportLock(lock, url), errorCode('UI_LOCAL_TRANSPORT')));
test('API credential is restricted to two exact API calls and absent from CDN', async () => {
  const mock = mockFetch(); const result = await downloadPinnedArchive({ releaseReadToken: 'fixture-token-never-leak', state: legacyState, ...mock });
  assert.equal(result.proof.sha256, PIN.sha256); assert.equal(mock.calls.length, 3);
  assert.deepEqual(mock.calls.slice(0, 2).map(call => call.url), [LEGACY_PIN.releaseUrl, LEGACY_PIN.apiUrl]);
  for (const call of mock.calls.slice(0, 2)) assert.equal(call.options.headers.Authorization, 'Bearer ' + 'fixture-token-never-leak');
  assert.deepEqual(mock.calls[2].options.headers, { Accept: 'application/octet-stream' });
  assert.equal(mock.calls[2].options.redirect, 'error'); assert.equal(result.proof.credentialsForwardedToCdn, false);
  assert.equal(JSON.stringify(result.proof).includes('fixture-token-never-leak'), false);
});
test('missing credential fails before any network call', async () => {
  const mock = mockFetch(); await assert.rejects(downloadPinnedArchive({ state: legacyState, ...mock }), errorCode('MISSING_UI_RELEASE_TOKEN')); assert.equal(mock.calls.length, 0);
});
test('expired or denied credential is a specific safe 401 failure', async () => {
  const mock = mockFetch({ releaseStatus: 401, releaseValue: { message: 'fixture-token-never-leak' } });
  await assert.rejects(downloadPinnedArchive({ state: legacyState, releaseReadToken: 'fixture-token-never-leak', ...mock }), error => errorCode('UI_RELEASE_HTTP_401')(error) && !error.message.includes('fixture-token'));
});
for (const [label, change, code] of [
  ['wrong tag', x => { x.tag_name = 'other'; }, 'UI_RELEASE_IDENTITY'],
  ['draft', x => { x.draft = true; }, 'UI_RELEASE_IDENTITY'],
  ['duplicate asset', x => { x.assets.push({ ...x.assets[0] }); }, 'UI_RELEASE_ASSET_CARDINALITY'],
  ['wrong hash', x => { x.assets[0].hash_value = '0'.repeat(64); }, 'UI_RELEASE_ASSET_HASH'],
  ['wrong size', x => { x.assets[0].size++; }, 'UI_RELEASE_ASSET_HASH'],
  ['wrong URL', x => { x.assets[0].url = 'https://api.cnb.cool/other'; }, 'UI_RELEASE_ASSET_URL'],
]) test('release response rejects ' + label, async () => {
  const value = release(); change(value); const mock = mockFetch({ releaseValue: value });
  await assert.rejects(downloadPinnedArchive({ state: legacyState, releaseReadToken: 'fixture-token-never-leak', ...mock }), errorCode(code));
  assert.equal(mock.calls.length, 1);
});
for (const url of ['http://asset.cnb.cool/pkg', 'https://asset.cnb.cool.evil.example/pkg', 'https://evil.example/pkg', 'https://asset.cnb.cool:444/pkg', 'https://user@asset.cnb.cool/pkg']) test('CDN redirect rejects ' + url, () => assert.throws(() => validateAssetRedirect(url), errorCode('UI_ASSET_REDIRECT_ORIGIN')));
test('redirect, truncated/oversized payload and repeated redirect cannot bypass pin', async () => {
  for (const [options, code] of [[{ finalStatus: 302 }, 'UI_ASSET_DOWNLOAD_HTTP_302'], [{ finalBytes: archive.subarray(1) }, 'UI_ARCHIVE_SIZE'], [{ finalBytes: Buffer.concat([archive, Buffer.alloc(1)]) }, 'UI_ASSET_DOWNLOAD_SIZE']]) {
    await assert.rejects(downloadPinnedArchive({ state: legacyState, releaseReadToken: 'fixture-token-never-leak', ...mockFetch(options) }), errorCode(code));
  }
});
test('network exceptions are safe coded errors without signed URLs or credentials', async () => {
  for (const [failAt, code] of [[1, 'UI_RELEASE_REQUEST'], [2, 'UI_ASSET_REQUEST'], [3, 'UI_ASSET_DOWNLOAD']]) {
    await assert.rejects(downloadPinnedArchive({ state: legacyState, releaseReadToken: 'fixture-token-never-leak', ...mockFetch({ failAt }) }), error => errorCode(code)(error) && !error.message.includes('fixture-token') && !error.message.includes('?signature'));
  }
});
test('body stream failures remain safe coded errors', async () => {
  let calls = 0;
  const fetchImplementation = async () => {
    calls++;
    if (calls === 1) return new Response(new ReadableStream({ start(controller) { controller.error(new Error('fixture-token-never-leak')); } }), { status: 200 });
    throw Error('must not continue');
  };
  await assert.rejects(downloadPinnedArchive({ state: legacyState, releaseReadToken: 'fixture-token-never-leak', fetchImplementation }), error => errorCode('UI_RELEASE_BODY_SIZE')(error) && !error.message.includes('fixture-token'));
  assert.equal(calls, 1);
});
test('child processes receive an allowlisted environment and empty npm config, including no AWS key', () => {
  const output = childEnvironment({ PATH: '/fixture/bin', HOME: '/fixture/home', WORKLOOM_UI_RELEASE_READ_TOKEN: 'fixture', CNB_UI_RELEASE_TOKEN: 'fixture', GITHUB_TOKEN: 'fixture', AWS_ACCESS_KEY_ID: 'fixture', UNRELATED_SECRET: 'fixture', NPM_CONFIG_USERCONFIG: '/unsafe', NODE_OPTIONS: '--inspect', XDG_CACHE_HOME: '/fixture/cache' }, '/safe/empty.npmrc');
  assert.deepEqual(output, { PATH: '/fixture/bin', HOME: '/fixture/home', XDG_CACHE_HOME: '/fixture/cache', NPM_CONFIG_USERCONFIG: '/safe/empty.npmrc', CI: 'true' });
});
test('process runner records real exit and controlled timeout and rejects missing executables', async () => {
  const failed = await runProcess(process.execPath, ['-e', 'console.log("fixture-failure");process.exit(7)']); assert.equal(failed.exitCode, 7); assert.match(failed.output, /fixture-failure/);
  const timeout = await runProcess(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { timeoutMs: 20 }); assert.equal(timeout.killed, true); assert.notEqual(timeout.exitCode, 0);
  await assert.rejects(runProcess(join(root, 'missing-executable'), []), errorCode('PNPM_PROCESS_SPAWN'));
});
test('canonical index rejects a same-integrity file keyed under the wrong package ID', async () => {
  const fixture = await tempFixture();
  try {
    // Synthetic unit input only. Official pnpm index creation is covered by a
    // separate complete cold-install verifier; this fixture makes no such claim.
    const files = readArchiveManifest(archive, PIN, true).files;
    const synthetic = JSON.stringify({ name: PIN.package, version: PIN.version, files });
    const wrong = expectedIndexPath(fixture.store, PIN.package + '@' + PIN.canonicalUrl); await mkdir(dirname(wrong), { recursive: true }); await writeFile(wrong, synthetic);
    await assert.rejects(validateCanonicalIndex(fixture.store, archive), errorCode('UI_CANONICAL_CACHE_KEY'));
    const correct = expectedIndexPath(fixture.store); await writeFile(correct, synthetic);
    const proof = await validateCanonicalIndex(fixture.store, archive); assert.equal(proof.fileCount, 81); assert.equal(proof.archiveEntriesVerified, true);
    const changed = JSON.parse(await readFile(correct, 'utf8')); changed.files['package.json'].integrity = 'sha512-' + Buffer.alloc(64).toString('base64'); await writeFile(correct, JSON.stringify(changed));
    await assert.rejects(validateCanonicalIndex(fixture.store, archive), errorCode('UI_CANONICAL_CACHE_FILE_INTEGRITY'));
  } finally { await rm(fixture.dir, { recursive: true, force: true }); }
});
for (const [mode, code] of [['wrong-version', 'UI_PNPM_EXECUTABLE_VERSION'], ['fail-fetch', 'UI_PNPM_FETCH_FAILED']]) test('mocked failure path ' + mode + ' leaves source intact and removes only its staging directory', async () => {
  const fixture = await tempFixture(); const fake = await fakePnpm(fixture.dir, mode); const before = digest(await readFile(join(fixture.repo, 'pnpm-lock.yaml')));
  try {
    const version = await runProcess(process.execPath, [fake, '--version']); assert.equal(version.exitCode, 0); assert.equal(version.output.trim(), mode === 'wrong-version' ? '11.25.0' : PIN.pnpmVersion);
    await assert.rejects(warmCanonicalStore({ repoRoot: fixture.repo, archiveBytes: archive, storeDir: fixture.store, stagingRoot: fixture.stage, pnpmCommand: process.execPath, pnpmPrefixArgs: [fake], environment: {} }), errorCode(code));
    assert.equal(digest(await readFile(join(fixture.repo, 'pnpm-lock.yaml'))), before); assert.deepEqual(await readdir(fixture.stage), []);
  } finally { await rm(fixture.dir, { recursive: true, force: true }); }
});
test('a concurrent manifest change is rejected before any cache success claim', async () => {
  const fixture = await tempFixture(); const fake = await fakePnpm(fixture.dir, 'change-source');
  try {
    await assert.rejects(warmCanonicalStore({ repoRoot: fixture.repo, archiveBytes: archive, storeDir: fixture.store, stagingRoot: fixture.stage, pnpmCommand: process.execPath, pnpmPrefixArgs: [fake, join(fixture.repo, 'package.json')], environment: {} }), errorCode('UI_SOURCE_CHANGED'));
    assert.deepEqual(await readdir(fixture.stage), []);
  } finally { await rm(fixture.dir, { recursive: true, force: true }); }
});
test('staging inside source including a name beginning with dot-dot is rejected', async () => {
  const fixture = await tempFixture();
  try {
    for (const stage of [fixture.repo, join(fixture.repo, '..child')]) await assert.rejects(warmCanonicalStore({ repoRoot: fixture.repo, archiveBytes: archive, storeDir: fixture.store, stagingRoot: stage, environment: {} }), errorCode('UI_STAGE_INSIDE_SOURCE'));
  } finally { await rm(fixture.dir, { recursive: true, force: true }); }
});
test('install rejects proof belonging to a different lock or store before launching pnpm', async () => {
  const fixture = await tempFixture();
  try { await assert.rejects(installCanonicalFrozen({ repoRoot: fixture.repo, storeDir: fixture.store, warmProof: { originalLockSha256: 'wrong', canonicalPackageId: PIN.canonicalUrl }, pnpmCommand: 'must-not-launch' }), errorCode('UI_WARM_PROOF_BINDING')); }
  finally { await rm(fixture.dir, { recursive: true, force: true }); }
});
test('install rejects a source script change occurring after store warmup', async () => {
  const fixture = await tempFixture();
  try {
    // Synthetic binding for a pre-launch rejection only, never a successful
    // store/fetch/install receipt. Every digest comes from this isolated fixture.
    const sourceFiles = {};
    for (const name of ['package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml', '.workloom-ui.json', 'apps/web/package.json', 'apps/webb/package.json', 'apps/webc/package.json']) sourceFiles[name] = digest(await readFile(join(fixture.repo, name)));
    const warmProof = { originalLockSha256: sourceFiles['pnpm-lock.yaml'], canonicalPackageId: PIN.canonicalUrl, credentialsPassedToPnpm: false, storeDir: fixture.store, sourceFiles };
    const pkgPath = join(fixture.repo, 'package.json'); const pkg = JSON.parse(await readFile(pkgPath, 'utf8'));
    pkg.scripts.postinstall = 'node -e "process.exit(0)"'; await writeFile(pkgPath, JSON.stringify(pkg));
    await assert.rejects(installCanonicalFrozen({ repoRoot: fixture.repo, storeDir: fixture.store, warmProof, pnpmCommand: 'must-not-launch' }), errorCode('UI_WARM_SOURCE_CHANGED'));
  } finally { await rm(fixture.dir, { recursive: true, force: true }); }
});

const githubRelease = () => ({ id: PIN.releaseId, tag_name: PIN.tag, draft: false, prerelease: false, assets: [{ id: PIN.assetId, name: PIN.assetName, state: 'uploaded', size: PIN.bytes, digest: 'sha256:' + PIN.sha256, browser_download_url: PIN.canonicalUrl, url: PIN.apiUrl }] });
function githubFetch({ releaseValue = githubRelease(), releaseStatus = 200, assetStatus = 302, redirect = 'https://release-assets.githubusercontent.com/fixture?signature=synthetic', finalStatus = 200, finalBytes = archive, failAt } = {}) {
  const calls = [];
  const fetchImplementation = async (url, options) => {
    calls.push({ url: String(url), options });
    if (calls.length === failAt) throw Error('legacy-fixture-token https://release-assets.githubusercontent.com/?signature=synthetic');
    if (calls.length === 1) return new Response(typeof releaseValue === 'string' ? releaseValue : JSON.stringify(releaseValue), { status: releaseStatus });
    if (calls.length === 2) return assetStatus === 302 ? new Response(null, { status: 302, headers: { Location: redirect } }) : new Response(finalBytes, { status: assetStatus });
    assert.equal(calls.length, 3);
    return new Response(finalBytes, { status: finalStatus });
  };
  return { calls, fetchImplementation };
}
test('GitHub public archive accepts official 200 and 302 binary responses without receiving any legacy credential', async () => {
  for (const assetStatus of [200, 302]) {
    const mock = githubFetch({ assetStatus });
    const result = await downloadPinnedArchive({ state, releaseReadToken: 'legacy-fixture-token', ...mock });
    assert.deepEqual(result.bytes, archive); assert.equal(result.proof.sha256, PIN.sha256); assert.equal(result.proof.sri, PIN.sri);
    assert.equal(result.proof.authenticatedApi, false); assert.equal(result.proof.platform, 'github');
    assert.equal(result.proof.releaseId, String(PIN.releaseId)); assert.equal(result.proof.assetId, String(PIN.assetId));
    assert.equal(mock.calls.length, assetStatus === 200 ? 2 : 3);
    assert.deepEqual(mock.calls.slice(0, 2).map(call => call.url), [PIN.releaseUrl, PIN.apiUrl]);
    for (const call of mock.calls) { assert.equal(call.options.headers.Authorization, undefined); assert.equal(call.options.headers.Cookie, undefined); assert.equal(call.options.credentials, 'omit'); }
    assert.equal(mock.calls[0].options.redirect, 'error'); assert.equal(mock.calls[1].options.redirect, 'manual');
    if (assetStatus === 302) assert.equal(mock.calls[2].options.redirect, 'error');
    assert.doesNotMatch(JSON.stringify(result.proof), /legacy-fixture-token|signature=/);
  }
});
test('GitHub public archive requires no token and binds identical original bytes', async () => {
  const mock = githubFetch(); const result = await downloadPinnedArchive({ state, ...mock });
  assert.equal(result.proof.bytes, PIN.bytes); assert.equal(result.proof.entries, 81);
});
for (const [label, mutate] of [
  ['missing platform', x => { delete x.artifact.platform; }],
  ['wrong platform', x => { x.artifact.platform = 'cnb'; }],
  ['missing artifact type', x => { delete x.artifact.type; }],
  ['wrong owner', x => { x.artifact.url = x.artifact.url.replace('geniusdapeng-collab', 'other-owner'); }],
  ['wrong tag', x => { x.artifact.url = x.artifact.url.replace('/ui-v0.1.19/', '/ui-v0.1.20/'); }],
  ['URL suffix', x => { x.artifact.url += '?download=1'; }],
  ['URL credentials', x => { x.artifact.url = x.artifact.url.replace('https://', 'https://fixture@'); }],
  ['platform URL mismatch', x => { x.artifact.url = LEGACY_PIN.canonicalUrl; }],
]) test('GitHub state rejects ' + label + ' before network', async () => {
  const value = structuredClone(state); mutate(value); const mock = githubFetch();
  await assert.rejects(downloadPinnedArchive({ state: value, ...mock }), errorCode('UI_STATE_ARTIFACT')); assert.equal(mock.calls.length, 0);
});
for (const [label, mutate, code] of [
  ['release ID', x => { x.id++; }, 'UI_RELEASE_IDENTITY'],
  ['tag', x => { x.tag_name = 'ui-v0.1.20'; }, 'UI_RELEASE_IDENTITY'],
  ['draft', x => { x.draft = true; }, 'UI_RELEASE_IDENTITY'],
  ['prerelease', x => { x.prerelease = true; }, 'UI_RELEASE_IDENTITY'],
  ['missing assets', x => { delete x.assets; }, 'UI_RELEASE_ASSETS'],
  ['missing asset', x => { x.assets = []; }, 'UI_RELEASE_ASSET_CARDINALITY'],
  ['duplicate asset', x => { x.assets.push({ ...x.assets[0] }); }, 'UI_RELEASE_ASSET_CARDINALITY'],
  ['asset ID', x => { x.assets[0].id++; }, 'UI_RELEASE_ASSET_HASH'],
  ['asset state', x => { x.assets[0].state = 'new'; }, 'UI_RELEASE_ASSET_HASH'],
  ['asset size', x => { x.assets[0].size++; }, 'UI_RELEASE_ASSET_HASH'],
  ['asset digest', x => { x.assets[0].digest = 'sha256:' + '0'.repeat(64); }, 'UI_RELEASE_ASSET_HASH'],
  ['missing digest', x => { x.assets[0].digest = null; }, 'UI_RELEASE_ASSET_HASH'],
  ['browser URL', x => { x.assets[0].browser_download_url = LEGACY_PIN.canonicalUrl; }, 'UI_RELEASE_ASSET_URL'],
  ['API URL', x => { x.assets[0].url = x.assets[0].url.replace('geniusdapeng-collab', 'other-owner'); }, 'UI_RELEASE_ASSET_URL'],
]) test('GitHub release rejects ' + label + ' before binary request', async () => {
  const value = githubRelease(); mutate(value); const mock = githubFetch({ releaseValue: value });
  await assert.rejects(downloadPinnedArchive({ state, ...mock }), errorCode(code)); assert.equal(mock.calls.length, 1);
});
for (const url of ['http://release-assets.githubusercontent.com/pkg', 'https://release-assets.githubusercontent.com.evil.example/pkg', 'https://asset.cnb.cool/pkg', 'https://release-assets.githubusercontent.com:444/pkg', 'https://fixture@release-assets.githubusercontent.com/pkg']) test('GitHub redirect rejects uncontrolled origin ' + url, async () => {
  const mock = githubFetch({ redirect: url });
  await assert.rejects(downloadPinnedArchive({ state, ...mock }), errorCode('UI_ASSET_REDIRECT_ORIGIN')); assert.equal(mock.calls.length, 2);
});
test('GitHub HTTP, bounded bodies, hash corruption and repeated redirects remain hard failures', async () => {
  const corrupt = Buffer.from(archive); corrupt[100] ^= 1;
  for (const [options, code] of [
    [{ releaseStatus: 401 }, 'UI_RELEASE_HTTP_401'], [{ releaseValue: '{bad' }, 'UI_RELEASE_JSON'],
    [{ releaseValue: 'null' }, 'UI_RELEASE_IDENTITY'],
    [{ releaseValue: ' '.repeat(512 * 1024 + 1) }, 'UI_RELEASE_BODY_SIZE'],
    [{ assetStatus: 404 }, 'UI_ASSET_DOWNLOAD_HTTP_404'], [{ finalStatus: 302 }, 'UI_ASSET_DOWNLOAD_HTTP_302'],
    [{ finalBytes: archive.subarray(1) }, 'UI_ARCHIVE_SIZE'], [{ finalBytes: Buffer.concat([archive, Buffer.alloc(1)]) }, 'UI_ASSET_DOWNLOAD_SIZE'],
    [{ finalBytes: corrupt }, 'UI_ARCHIVE_SHA256'],
  ]) await assert.rejects(downloadPinnedArchive({ state, ...githubFetch(options) }), errorCode(code));
});
test('GitHub safe network failures cannot disclose supplied legacy tokens or signed URLs', async () => {
  for (const [failAt, code] of [[1, 'UI_RELEASE_REQUEST'], [2, 'UI_ASSET_REQUEST'], [3, 'UI_ASSET_DOWNLOAD']]) {
    await assert.rejects(downloadPinnedArchive({ state, releaseReadToken: 'legacy-fixture-token', ...githubFetch({ failAt }) }), error => errorCode(code)(error) && !/legacy-fixture-token|signature=/.test(error.message));
  }
});
