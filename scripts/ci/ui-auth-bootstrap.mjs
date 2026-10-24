#!/usr/bin/env node
import { createHash, timingSafeEqual } from 'node:crypto';
import { gunzipSync } from 'node:zlib';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, writeFile, lstat, rm, realpath } from 'node:fs/promises';
import { join, resolve, relative, isAbsolute, sep } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

export const PIN = Object.freeze({
  package: '@workloom/ui', version: '0.1.19', producer: 'workloom-ai/workloom-im',
  tag: 'ui-v0.1.19', assetName: 'workloom-ui-0.1.19.tgz', bytes: 90041,
  canonicalUrl: 'https://github.com/geniusdapeng-collab/workloom-im/releases/download/ui-v0.1.19/workloom-ui-0.1.19.tgz',
  apiUrl: 'https://api.github.com/repos/geniusdapeng-collab/workloom-im/releases/assets/670901023',
  releaseUrl: 'https://api.github.com/repos/geniusdapeng-collab/workloom-im/releases/tags/ui-v0.1.19',
  releaseId: 422438050, assetId: 670901023,
  sha256: '42bf2e483cbd2665fda74f0e64cff7266184db7844801b27b5078f0082a3b262',
  sri: 'sha512-kplOLAtovega6BLpBwtFM1DfBS3q4ZjLp9yA942o+v9QlbREm/VsYNK/Jz7f/9ytDWSFXCvmh10C3ZHrPHkcSA==',
  pnpmVersion: '10.14.0',
});

export const LEGACY_PIN = Object.freeze({
  ...PIN,
  canonicalUrl: 'https://cnb.cool/workloom-ai/workloom-im/-/releases/download/ui-v0.1.19/workloom-ui-0.1.19.tgz',
  apiUrl: 'https://api.cnb.cool/workloom-ai/workloom-im/-/releases/download/ui-v0.1.19/workloom-ui-0.1.19.tgz',
  releaseUrl: 'https://api.cnb.cool/workloom-ai/workloom-im/-/releases/tags/ui-v0.1.19',
});

export class BootstrapError extends Error {
  constructor(code, message = code) { super(message); this.name = 'BootstrapError'; this.code = code; }
}
function requireFact(condition, code, message) { if (!condition) throw new BootstrapError(code, message); }
export const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const sriOf = bytes => 'sha512-' + createHash('sha512').update(bytes).digest('base64');
function sameDigest(a, b) { const x = Buffer.from(a); const y = Buffer.from(b); return x.length === y.length && timingSafeEqual(x, y); }

export function validateState(state) {
  requireFact(state?.schemaVersion === 'workloom.ui-consumer-state/v1', 'UI_STATE_SCHEMA');
  requireFact(state.package === PIN.package && state.version === PIN.version && state.source === PIN.producer, 'UI_STATE_IDENTITY');
  const artifact = state.artifact;
  const github = artifact?.platform === 'github' && artifact.url === PIN.canonicalUrl;
  const legacy = (artifact?.platform === undefined || artifact.platform === 'cnb') && artifact?.url === LEGACY_PIN.canonicalUrl;
  requireFact(artifact?.type === 'github-release-tarball' && artifact.assetName === PIN.assetName && (github || legacy) && artifact.sha512 === PIN.sri, 'UI_STATE_ARTIFACT');
  requireFact(state.releaseChannel === 'stable' && state.updatePolicy === 'upgrade-pr-only', 'UI_STATE_POLICY');
  return state;
}

function tarString(buffer) { return buffer.toString('utf8').split('\0', 1)[0]; }
function tarOctal(buffer, field) {
  const text = tarString(buffer).trim();
  requireFact(text === '' || /^[0-7]+$/.test(text), 'UI_TAR_' + field);
  const value = text === '' ? 0 : Number.parseInt(text, 8);
  requireFact(Number.isSafeInteger(value) && value >= 0, 'UI_TAR_' + field);
  return value;
}
export function readArchiveManifest(bytes, expected = PIN, includeFiles = false) {
  let tar;
  try { tar = gunzipSync(bytes, { maxOutputLength: 16 * 1024 * 1024 }); }
  catch { throw new BootstrapError('UI_ARCHIVE_GZIP'); }
  const names = new Set(); const files = {}; let manifest; let ended = false; let entries = 0;
  for (let offset = 0; offset + 512 <= tar.length;) {
    const header = tar.subarray(offset, offset + 512);
    if (header.every(byte => byte === 0)) { ended = true; break; }
    const stored = tarOctal(header.subarray(148, 156), 'CHECKSUM');
    const calculated = header.reduce((total, byte, i) => total + (i >= 148 && i < 156 ? 32 : byte), 0);
    requireFact(stored === calculated, 'UI_TAR_CHECKSUM');
    const prefix = tarString(header.subarray(345, 500));
    const name = (prefix ? prefix + '/' : '') + tarString(header.subarray(0, 100));
    requireFact(name.startsWith('package/') && !name.includes('\\') && !name.split('/').includes('..') && !name.startsWith('/'), 'UI_TAR_PATH');
    requireFact(!names.has(name), 'UI_TAR_DUPLICATE'); names.add(name); entries++;
    const type = header[156];
    requireFact(type === 0 || type === 48 || type === 53, 'UI_TAR_LINK_OR_EXTENSION');
    const size = tarOctal(header.subarray(124, 136), 'SIZE');
    const end = offset + 512 + size;
    requireFact(end <= tar.length && size <= 8 * 1024 * 1024, 'UI_TAR_BOUNDS');
    requireFact(type !== 53 || size === 0, 'UI_TAR_DIRECTORY_SIZE');
    if (includeFiles && type !== 53) files[name.slice('package/'.length)] = { integrity: sriOf(tar.subarray(offset + 512, end)), size };
    if (name === 'package/package.json') {
      requireFact(type === 0 || type === 48, 'UI_TAR_MANIFEST_TYPE');
      try { manifest = JSON.parse(tar.subarray(offset + 512, end).toString('utf8')); }
      catch { throw new BootstrapError('UI_ARCHIVE_MANIFEST_JSON'); }
    }
    offset += 512 + Math.ceil(size / 512) * 512;
  }
  requireFact(ended && manifest, 'UI_ARCHIVE_MANIFEST_MISSING');
  requireFact(manifest.name === expected.package, 'UI_ARCHIVE_PACKAGE');
  requireFact(manifest.version === expected.version, 'UI_ARCHIVE_VERSION');
  return { name: manifest.name, version: manifest.version, entries, ...(includeFiles ? { files } : {}) };
}

export function verifyArchive(bytes, expected = PIN) {
  requireFact(Buffer.isBuffer(bytes) || bytes instanceof Uint8Array, 'UI_ARCHIVE_BYTES');
  const buffer = Buffer.from(bytes);
  requireFact(buffer.length === expected.bytes, 'UI_ARCHIVE_SIZE');
  const sha256 = digest(buffer); const sri = sriOf(buffer);
  requireFact(sameDigest(sha256, expected.sha256), 'UI_ARCHIVE_SHA256');
  requireFact(sameDigest(sri, expected.sri), 'UI_ARCHIVE_SRI');
  return { bytes: buffer.length, sha256, sri, ...readArchiveManifest(buffer, expected) };
}

async function boundedBody(response, maximum, code) {
  requireFact(response.body, code);
  const reader = response.body.getReader(); const chunks = []; let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read(); if (done) break;
      total += value.byteLength; requireFact(total <= maximum, code);
      chunks.push(Buffer.from(value));
    }
  } catch (error) {
    try { await reader.cancel(); } catch { error.bodyCancellationFailed = true; }
    if (error instanceof BootstrapError) throw error;
    throw new BootstrapError(code);
  } finally { reader.releaseLock(); }
  return Buffer.concat(chunks, total);
}
async function safeFetch(fetchImplementation, url, options, code) {
  try { return await fetchImplementation(url, options); }
  catch { throw new BootstrapError(code); }
}
export function validateAssetRedirect(location, platform = 'cnb') {
  let url;
  try { url = new URL(location); } catch { throw new BootstrapError('UI_ASSET_REDIRECT_URL'); }
  const host = platform === 'github' ? 'release-assets.githubusercontent.com' : platform === 'cnb' ? 'asset.cnb.cool' : '';
  requireFact(host && url.protocol === 'https:' && url.hostname === host && (!url.port || url.port === '443') && !url.username && !url.password, 'UI_ASSET_REDIRECT_ORIGIN');
  return url;
}

async function downloadPublicGithubArchive(fetchImplementation) {
  // Public mirror reads never receive the optional legacy CNB credential.
  const headers = { Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2026-03-10' };
  const releaseResponse = await safeFetch(fetchImplementation, PIN.releaseUrl, { method: 'GET', headers, credentials: 'omit', redirect: 'error', signal: AbortSignal.timeout(30000) }, 'UI_RELEASE_REQUEST');
  requireFact(releaseResponse.status === 200, 'UI_RELEASE_HTTP_' + releaseResponse.status);
  let release;
  try { release = JSON.parse((await boundedBody(releaseResponse, 512 * 1024, 'UI_RELEASE_BODY_SIZE')).toString('utf8')); }
  catch (error) { if (error instanceof BootstrapError) throw error; throw new BootstrapError('UI_RELEASE_JSON'); }
  requireFact(release?.id === PIN.releaseId && release.tag_name === PIN.tag && release.draft === false && release.prerelease === false, 'UI_RELEASE_IDENTITY');
  requireFact(Array.isArray(release.assets), 'UI_RELEASE_ASSETS');
  const assets = release.assets.filter(asset => asset?.name === PIN.assetName);
  requireFact(assets.length === 1, 'UI_RELEASE_ASSET_CARDINALITY');
  const asset = assets[0];
  requireFact(asset.id === PIN.assetId && asset.state === 'uploaded' && asset.size === PIN.bytes && asset.digest === 'sha256:' + PIN.sha256, 'UI_RELEASE_ASSET_HASH');
  requireFact(asset.browser_download_url === PIN.canonicalUrl && asset.url === PIN.apiUrl, 'UI_RELEASE_ASSET_URL');
  const options = { method: 'GET', headers: { Accept: 'application/octet-stream', 'X-GitHub-Api-Version': '2026-03-10' }, credentials: 'omit', redirect: 'manual', signal: AbortSignal.timeout(60000) };
  let response = await safeFetch(fetchImplementation, PIN.apiUrl, options, 'UI_ASSET_REQUEST');
  let assetOrigin = 'https://api.github.com';
  if (response.status === 302) {
    const url = validateAssetRedirect(response.headers.get('location'), 'github');
    // The signed CDN URL stays in memory. Neither API credentials nor cookies are forwarded.
    assetOrigin = url.origin;
    response = await safeFetch(fetchImplementation, url, { method: 'GET', headers: { Accept: 'application/octet-stream' }, credentials: 'omit', redirect: 'error', signal: AbortSignal.timeout(60000) }, 'UI_ASSET_DOWNLOAD');
  }
  requireFact(response.status === 200, 'UI_ASSET_DOWNLOAD_HTTP_' + response.status);
  const bytes = await boundedBody(response, PIN.bytes, 'UI_ASSET_DOWNLOAD_SIZE');
  const proof = verifyArchive(bytes);
  return { bytes, proof: { ...proof, platform: 'github', authenticatedApi: false, credentialsForwardedToCdn: false, apiOrigin: 'https://api.github.com', assetOrigin, releaseId: String(release.id), assetId: String(asset.id) } };
}

/** Only the explicit legacy CNB branch receives the credential. No child receives it. */
export async function downloadPinnedArchive({ releaseReadToken, state, fetchImplementation = fetch }) {
  validateState(state);
  if (state.artifact.platform === 'github') return downloadPublicGithubArchive(fetchImplementation);
  const pin = LEGACY_PIN;
  requireFact(typeof releaseReadToken === 'string' && releaseReadToken.length > 0 && releaseReadToken.length < 4096 && !/\s/.test(releaseReadToken), 'MISSING_UI_RELEASE_TOKEN');
  const headers = { Authorization: 'Bearer ' + releaseReadToken, Accept: 'application/vnd.cnb.api+json' };
  const releaseResponse = await safeFetch(fetchImplementation, pin.releaseUrl, { method: 'GET', headers, redirect: 'error', signal: AbortSignal.timeout(30000) }, 'UI_RELEASE_REQUEST');
  requireFact(releaseResponse.status === 200, 'UI_RELEASE_HTTP_' + releaseResponse.status);
  let release;
  try { release = JSON.parse((await boundedBody(releaseResponse, 512 * 1024, 'UI_RELEASE_BODY_SIZE')).toString('utf8')); }
  catch (error) { if (error instanceof BootstrapError) throw error; throw new BootstrapError('UI_RELEASE_JSON'); }
  requireFact(release.tag_name === PIN.tag && release.draft === false && release.prerelease === false, 'UI_RELEASE_IDENTITY');
  requireFact(Array.isArray(release.assets), 'UI_RELEASE_ASSETS');
  const assets = release.assets.filter(asset => asset?.name === PIN.assetName);
  requireFact(assets.length === 1, 'UI_RELEASE_ASSET_CARDINALITY');
  const asset = assets[0];
  requireFact(asset.size === PIN.bytes && asset.hash_algo === 'sha256' && sameDigest(String(asset.hash_value), PIN.sha256), 'UI_RELEASE_ASSET_HASH');
  requireFact(asset.browser_download_url === pin.canonicalUrl && asset.url === pin.apiUrl, 'UI_RELEASE_ASSET_URL');
  const response = await safeFetch(fetchImplementation, pin.apiUrl, { method: 'GET', headers, redirect: 'manual', signal: AbortSignal.timeout(30000) }, 'UI_ASSET_REQUEST');
  requireFact(response.status === 302, 'UI_ASSET_HTTP_' + response.status);
  const url = validateAssetRedirect(response.headers.get('location'));
  // The signed CDN URL stays only in memory; no Authorization or cookies are forwarded.
  const archiveResponse = await safeFetch(fetchImplementation, url, { method: 'GET', headers: { Accept: 'application/octet-stream' }, redirect: 'error', signal: AbortSignal.timeout(60000) }, 'UI_ASSET_DOWNLOAD');
  requireFact(archiveResponse.status === 200, 'UI_ASSET_DOWNLOAD_HTTP_' + archiveResponse.status);
  const bytes = await boundedBody(archiveResponse, PIN.bytes, 'UI_ASSET_DOWNLOAD_SIZE');
  const proof = verifyArchive(bytes);
  return { bytes, proof: { ...proof, authenticatedApi: true, credentialsForwardedToCdn: false, apiOrigin: 'https://api.cnb.cool', assetOrigin: 'https://asset.cnb.cool', releaseId: String(release.id), assetId: String(asset.id) } };
}

function scalar(value) {
  const text = value.trim();
  if (text.startsWith("'")) { requireFact(text.endsWith("'"), 'UI_LOCK_SCALAR'); return text.slice(1, -1).replaceAll("''", "'"); }
  if (text.startsWith('"')) { try { return JSON.parse(text); } catch { throw new BootstrapError('UI_LOCK_SCALAR'); } }
  return text;
}
function exactSection(lines, name) {
  const starts = lines.map((text, index) => ({ text, index })).filter(row => row.text === name + ':');
  requireFact(starts.length === 1, 'UI_LOCK_SECTION_' + name);
  let end = lines.length;
  for (let i = starts[0].index + 1; i < lines.length; i++) if (/^[^\s#][^:]*:/.test(lines[i])) { end = i; break; }
  return { start: starts[0].index + 1, end };
}
export function canonicalLockBinding(source) {
  requireFact(typeof source === 'string' && source.endsWith('\n') && !source.includes('\r') && !source.includes('\t'), 'UI_LOCK_FORMAT');
  const lines = source.split('\n'); requireFact(/^lockfileVersion:\s*['"]?9\.0['"]?$/.test(lines[0]), 'UI_LOCK_VERSION');
  const key = PIN.package + '@' + PIN.canonicalUrl;
  const section = exactSection(lines, 'packages');
  const entries = lines.map((text, index) => ({ text, index })).filter(row => row.index >= section.start && row.index < section.end && /^  \S/.test(row.text));
  const uiEntries = entries.filter(row => scalar(row.text.slice(2, -1)).startsWith(PIN.package + '@'));
  requireFact(uiEntries.length === 1 && scalar(uiEntries[0].text.slice(2, -1)) === key && uiEntries[0].text.endsWith(':'), 'UI_LOCK_PACKAGE_ID');
  const position = entries.findIndex(row => row.index === uiEntries[0].index);
  const blockEnd = entries[position + 1]?.index ?? section.end;
  const block = lines.slice(uiEntries[0].index + 1, blockEnd);
  const versions = block.filter(text => /^    version:/.test(text));
  requireFact(versions.length === 1 && scalar(versions[0].slice('    version:'.length)) === PIN.version, 'UI_LOCK_PACKAGE_VERSION');
  const resolutions = block.map((text, index) => ({ text, index })).filter(row => /^    resolution:/.test(row.text));
  requireFact(resolutions.length === 1, 'UI_LOCK_RESOLUTION_CARDINALITY');
  const resolution = resolutions[0];
  const expected = 'resolution: {integrity: ' + PIN.sri + ', tarball: ' + PIN.canonicalUrl + '}';
  requireFact(resolution.text.trim() === expected, 'UI_LOCK_RESOLUTION');
  const overrides = exactSection(lines, 'overrides');
  const overrideLines = lines.slice(overrides.start, overrides.end).filter(text => text.includes(PIN.package));
  requireFact(overrideLines.length === 1 && scalar(overrideLines[0].trim().slice(0, overrideLines[0].trim().indexOf(': '))) === PIN.package + '@' + PIN.version && scalar(overrideLines[0].slice(overrideLines[0].indexOf(': ') + 2)) === PIN.canonicalUrl, 'UI_LOCK_OVERRIDE');
  const importers = exactSection(lines, 'importers');
  const importerLines = lines.slice(importers.start, importers.end);
  for (const client of ['apps/web', 'apps/webb', 'apps/webc']) {
    const index = importerLines.findIndex(text => text === '  ' + client + ':'); requireFact(index >= 0, 'UI_LOCK_IMPORTER');
    let end = importerLines.length; for (let i = index + 1; i < importerLines.length; i++) if (/^  \S/.test(importerLines[i])) { end = i; break; }
    const clientLines = importerLines.slice(index + 1, end);
    const dependencyIndexes = clientLines.map((text, index) => ({ text, index })).filter(row => /^      \S/.test(row.text) && scalar(row.text.slice(6, -1)) === PIN.package);
    requireFact(dependencyIndexes.length === 1, 'UI_LOCK_IMPORTER_UI');
    const dependency = dependencyIndexes[0].index;
    requireFact(scalar(clientLines[dependency + 1].slice('        specifier:'.length)) === PIN.canonicalUrl, 'UI_LOCK_IMPORTER_SPECIFIER');
    const version = scalar(clientLines[dependency + 2].slice('        version:'.length));
    requireFact(version === PIN.canonicalUrl || version.startsWith(PIN.canonicalUrl + '('), 'UI_LOCK_IMPORTER_REFERENCE');
  }
  // For a non-semver tarball pnpm 10.14 uses the URL as pkg.id. The lock key
  // retains the package name; it must not be substituted for the CAFS pkg.id.
  return { lockPackageKey: key, packageId: PIN.canonicalUrl, integrity: PIN.sri, canonicalUrl: PIN.canonicalUrl, resolutionLine: uiEntries[0].index + 1 + resolution.index, originalSha256: digest(source) };
}
export function transportLock(source, transportUrl) {
  const binding = canonicalLockBinding(source); const url = new URL(transportUrl);
  requireFact(url.protocol === 'http:' && url.hostname === '127.0.0.1' && !url.username && !url.password && url.pathname === '/workloom-ui-0.1.19.tgz' && !url.search && !url.hash, 'UI_LOCAL_TRANSPORT');
  const lines = source.split('\n');
  lines[binding.resolutionLine] = lines[binding.resolutionLine].replace(PIN.canonicalUrl, url.href);
  const next = lines.join('\n');
  requireFact(next.replace(url.href, PIN.canonicalUrl) === source, 'UI_TRANSPORT_LOCK_UNEXPECTED_DELTA');
  return { source: next, binding, sha256: digest(next) };
}

export function childEnvironment(env = process.env, userConfigPath) {
  const next = {};
  const allowed = new Set(['PATH', 'HOME', 'USER', 'LOGNAME', 'SHELL', 'TMPDIR', 'TMP', 'TEMP', 'SystemRoot', 'COMSPEC', 'LANG', 'LC_ALL', 'LC_CTYPE', 'XDG_CACHE_HOME', 'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NO_PROXY', 'http_proxy', 'https_proxy', 'all_proxy', 'no_proxy']);
  for (const [key, value] of Object.entries(env)) {
    if (allowed.has(key)) next[key] = value;
  }
  if (userConfigPath) next.NPM_CONFIG_USERCONFIG = userConfigPath;
  next.CI = 'true';
  return next;
}
export function runProcess(command, argv, { cwd, env, timeoutMs = 300000 } = {}) {
  return new Promise((resolveResult, reject) => {
    const group = globalThis.process.platform !== 'win32';
    const child = spawn(command, argv, { cwd, env, detached: group, stdio: ['ignore', 'pipe', 'pipe'] });
    const chunks = []; let size = 0; let killed = false;
    let forceTimer;
    const signalChild = signal => { try { if (group && child.pid) globalThis.process.kill(-child.pid, signal); else child.kill(signal); } catch (error) { if (error.code !== 'ESRCH') reject(new BootstrapError('PNPM_PROCESS_STOP')); } };
    const stop = () => { if (killed) return; killed = true; signalChild('SIGTERM'); forceTimer = setTimeout(() => signalChild('SIGKILL'), 5000); };
    const timer = setTimeout(stop, timeoutMs);
    const collect = bytes => { size += bytes.length; if (size > 32 * 1024 * 1024) stop(); else chunks.push(bytes); };
    child.stdout.on('data', collect); child.stderr.on('data', collect);
    child.on('error', () => { clearTimeout(timer); clearTimeout(forceTimer); reject(new BootstrapError('PNPM_PROCESS_SPAWN')); });
    child.on('close', (exitCode, signal) => { clearTimeout(timer); clearTimeout(forceTimer); resolveResult({ command, argv, cwd, exitCode, signal, killed, output: Buffer.concat(chunks).toString('utf8') }); });
  });
}
async function ordinaryFile(path) { const stat = await lstat(path); requireFact(stat.isFile() && !stat.isSymbolicLink(), 'UI_SOURCE_FILE_TYPE'); return readFile(path); }
async function sourceSnapshot(repo) {
  const files = {};
  for (const rel of ['package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml', '.workloom-ui.json', 'apps/web/package.json', 'apps/webb/package.json', 'apps/webc/package.json']) files[rel] = await ordinaryFile(join(repo, rel));
  const pkg = JSON.parse(files['package.json']); validateState(JSON.parse(files['.workloom-ui.json']));
  requireFact(pkg.packageManager === 'pnpm@' + PIN.pnpmVersion, 'UI_PNPM_MANIFEST_VERSION');
  requireFact(pkg.pnpm?.overrides?.[PIN.package + '@' + PIN.version] === PIN.canonicalUrl, 'UI_MANIFEST_OVERRIDE');
  for (const rel of ['apps/web/package.json', 'apps/webb/package.json', 'apps/webc/package.json']) requireFact(JSON.parse(files[rel]).dependencies?.[PIN.package] === PIN.version, 'UI_CLIENT_VERSION');
  canonicalLockBinding(files['pnpm-lock.yaml'].toString());
  return files;
}
async function assertSnapshot(repo, files) {
  for (const [rel, bytes] of Object.entries(files)) requireFact(sameDigest(digest(await ordinaryFile(join(repo, rel))), digest(bytes)), 'UI_SOURCE_CHANGED', rel + ' changed during bootstrap');
}
export function expectedIndexPath(storeRoot, packageId = PIN.canonicalUrl, integrity = PIN.sri) {
  const hex = Buffer.from(integrity.slice('sha512-'.length), 'base64').toString('hex').slice(0, 64);
  return join(storeRoot, 'index', hex.slice(0, 2), hex.slice(2) + '-' + packageId.replace(/[\\/:*?"<>|]/g, '+') + '.json');
}
export async function validateCanonicalIndex(storeRoot, archiveBytes) {
  const path = expectedIndexPath(storeRoot); let bytes;
  try { bytes = await ordinaryFile(path); } catch { throw new BootstrapError('UI_CANONICAL_CACHE_KEY'); }
  let index;
  try { index = JSON.parse(bytes); } catch { throw new BootstrapError('UI_CANONICAL_CACHE_JSON'); }
  requireFact(index.name === PIN.package && index.version === PIN.version && index.files?.['package.json'], 'UI_CANONICAL_CACHE_IDENTITY');
  if (archiveBytes) {
    const archive = readArchiveManifest(archiveBytes, PIN, true);
    requireFact(Object.keys(index.files).length === Object.keys(archive.files).length, 'UI_CANONICAL_CACHE_FILE_COUNT');
    for (const [name, fact] of Object.entries(archive.files)) requireFact(index.files[name]?.integrity === fact.integrity && index.files[name]?.size === fact.size, 'UI_CANONICAL_CACHE_FILE_INTEGRITY');
  }
  return { path, sha256: digest(bytes), name: index.name, version: index.version, fileCount: Object.keys(index.files).length, manifestIntegrity: index.files['package.json'].integrity, archiveEntriesVerified: Boolean(archiveBytes) };
}

/** Verified bytes use a private loopback transport only while official pnpm fetch runs. */
export async function warmCanonicalStore({ repoRoot, archiveBytes, storeDir, pnpmCommand = 'pnpm', pnpmPrefixArgs = [], stagingRoot = tmpdir(), environment = process.env }) {
  const repo = await realpath(repoRoot); const files = await sourceSnapshot(repo); const archive = verifyArchive(archiveBytes);
  await mkdir(stagingRoot, { recursive: true });
  const staging = await realpath(stagingRoot); const stagingRel = relative(repo, staging);
  requireFact(stagingRel === '..' || stagingRel.startsWith('..' + sep) || isAbsolute(stagingRel), 'UI_STAGE_INSIDE_SOURCE');
  const stage = await mkdtemp(join(staging, '.workloom-ui-prefetch-'));
  const emptyConfig = join(stage, 'empty.npmrc'); await writeFile(emptyConfig, '', { flag: 'wx', mode: 0o600 });
  const env = childEnvironment(environment, emptyConfig); let server; let requests = 0;
  try {
    const version = await runProcess(pnpmCommand, [...pnpmPrefixArgs, '--version'], { cwd: stage, env, timeoutMs: 30000 });
    requireFact(version.exitCode === 0 && version.output.trim() === PIN.pnpmVersion, 'UI_PNPM_EXECUTABLE_VERSION');
    server = createServer((request, response) => {
      if (request.method !== 'GET' || request.url !== '/' + PIN.assetName || request.headers.authorization || !['127.0.0.1', '::ffff:127.0.0.1'].includes(request.socket.remoteAddress)) { response.writeHead(403); response.end(); return; }
      requests++; response.writeHead(200, { 'Content-Type': 'application/gzip', 'Content-Length': archiveBytes.length, 'Cache-Control': 'no-store' }); response.end(archiveBytes);
    });
    await new Promise((ready, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', ready); });
    const localUrl = 'http://127.0.0.1:' + server.address().port + '/' + PIN.assetName;
    const transport = transportLock(files['pnpm-lock.yaml'].toString(), localUrl);
    await writeFile(join(stage, 'pnpm-lock.yaml'), transport.source, { flag: 'wx', mode: 0o600 });
    await writeFile(join(stage, 'package.json'), files['package.json'], { flag: 'wx', mode: 0o600 });
    await writeFile(join(stage, 'pnpm-workspace.yaml'), files['pnpm-workspace.yaml'], { flag: 'wx', mode: 0o600 });
    const store = resolve(storeDir); await mkdir(store, { recursive: true });
    const fetched = await runProcess(pnpmCommand, [...pnpmPrefixArgs, 'fetch', '--ignore-scripts', '--frozen-lockfile', '--store-dir', store, '--reporter', 'append-only', '--network-concurrency', '16'], { cwd: stage, env, timeoutMs: 900000 });
    if (fetched.exitCode !== 0 || fetched.killed) { const error = new BootstrapError('UI_PNPM_FETCH_FAILED'); error.processResult = fetched; throw error; }
    requireFact(digest(await readFile(join(stage, 'pnpm-lock.yaml'))) === transport.sha256, 'UI_PREFETCH_LOCK_CHANGED');
    await assertSnapshot(repo, files);
    const storePath = await runProcess(pnpmCommand, [...pnpmPrefixArgs, 'store', 'path', '--store-dir', store], { cwd: stage, env, timeoutMs: 30000 });
    requireFact(storePath.exitCode === 0, 'UI_PNPM_STORE_PATH');
    const storeRoot = await realpath(storePath.output.trim());
    requireFact(!relative(store, storeRoot).startsWith('..') && !isAbsolute(relative(store, storeRoot)), 'UI_STORE_PATH_BOUNDARY');
    const index = await validateCanonicalIndex(storeRoot, archiveBytes);
    return { schemaVersion: 'workloom.ui-auth-bootstrap/v1', scope: 'dependency-transport', archive, pnpmVersion: PIN.pnpmVersion, canonicalPackageId: transport.binding.packageId,
      originalLockSha256: transport.binding.originalSha256, temporaryTransportLockSha256: transport.sha256, changedTemporaryFields: ['packages[@workloom/ui@canonical].resolution.tarball'],
      sourceFiles: Object.fromEntries(Object.entries(files).map(([name, bytes]) => [name, digest(bytes)])), storeDir: store, storeRoot, index, requests,
      sourceFilesUnchanged: true, storeIndexWrittenByPnpm: true, cacheEntryUsed: requests === 0, credentialsPassedToPnpm: false, fetch: fetched };
  } finally {
    if (server?.listening) await new Promise((done, reject) => server.close(error => error ? reject(error) : done()));
    await rm(stage, { recursive: true, force: true });
  }
}

export async function installCanonicalFrozen({ repoRoot, storeDir, warmProof, pnpmCommand = 'pnpm', pnpmPrefixArgs = [], stagingRoot = tmpdir(), environment = process.env }) {
  const repo = await realpath(repoRoot); const files = await sourceSnapshot(repo);
  requireFact(warmProof?.originalLockSha256 === digest(files['pnpm-lock.yaml']) && warmProof?.canonicalPackageId === PIN.canonicalUrl && warmProof?.credentialsPassedToPnpm === false && warmProof.storeDir === resolve(storeDir), 'UI_WARM_PROOF_BINDING');
  for (const [name, bytes] of Object.entries(files)) requireFact(warmProof.sourceFiles?.[name] === digest(bytes), 'UI_WARM_SOURCE_CHANGED');
  const index = await validateCanonicalIndex(warmProof.storeRoot);
  requireFact(index.sha256 === warmProof.index?.sha256, 'UI_WARM_INDEX_CHANGED');
  await mkdir(stagingRoot, { recursive: true }); const staging = await realpath(stagingRoot); const stagingRel = relative(repo, staging);
  requireFact(stagingRel === '..' || stagingRel.startsWith('..' + sep) || isAbsolute(stagingRel), 'UI_STAGE_INSIDE_SOURCE');
  const stage = await mkdtemp(join(staging, '.workloom-ui-install-')); const config = join(stage, 'empty.npmrc');
  try {
    await writeFile(config, '', { flag: 'wx', mode: 0o600 });
    const env = childEnvironment(environment, config);
    const version = await runProcess(pnpmCommand, [...pnpmPrefixArgs, '--version'], { cwd: stage, env, timeoutMs: 30000 });
    requireFact(version.exitCode === 0 && version.output.trim() === PIN.pnpmVersion, 'UI_PNPM_EXECUTABLE_VERSION');
    const storePath = await runProcess(pnpmCommand, [...pnpmPrefixArgs, 'store', 'path', '--store-dir', resolve(storeDir)], { cwd: stage, env, timeoutMs: 30000 });
    requireFact(storePath.exitCode === 0 && await realpath(storePath.output.trim()) === warmProof.storeRoot, 'UI_WARM_STORE_PATH_CHANGED');
    await assertSnapshot(repo, files);
    const install = await runProcess(pnpmCommand, [...pnpmPrefixArgs, 'install', '--offline', '--frozen-lockfile', '--store-dir', resolve(storeDir), '--reporter', 'append-only'], { cwd: repo, env, timeoutMs: 900000 });
    if (install.exitCode !== 0 || install.killed) { const error = new BootstrapError('UI_PNPM_FROZEN_INSTALL_FAILED'); error.processResult = install; throw error; }
    await assertSnapshot(repo, files);
    const installedClients = [];
    for (const client of ['apps/web', 'apps/webb', 'apps/webc']) {
      const installedBytes = await readFile(join(repo, client, 'node_modules/@workloom/ui/package.json'));
      const installed = JSON.parse(installedBytes.toString('utf8'));
      requireFact(installed.name === PIN.package && installed.version === PIN.version && sriOf(installedBytes) === index.manifestIntegrity, 'UI_INSTALLED_IDENTITY');
      installedClients.push({ client, name: installed.name, version: installed.version, manifestIntegrity: sriOf(installedBytes) });
    }
    return { ...warmProof, installedName: PIN.package, installedVersion: PIN.version, installedClients, frozenInstallPassed: true, originalLockUnchanged: true, dependencyScriptsExecutedWithoutCredential: true, install };
  } finally { await rm(stage, { recursive: true, force: true }); }
}

export async function bootstrapInstall(options) {
  const state = JSON.parse(await readFile(join(options.repoRoot, '.workloom-ui.json'), 'utf8'));
  const download = await downloadPinnedArchive({ releaseReadToken: options.releaseReadToken, state, fetchImplementation: options.fetchImplementation });
  const warm = await warmCanonicalStore({ ...options, archiveBytes: download.bytes });
  const result = await installCanonicalFrozen({ ...options, warmProof: warm });
  return { ...result, download: download.proof };
}

async function main() {
  const args = process.argv.slice(2); const allowed = new Set(['--repo', '--store-dir', '--staging-root', '--report']); const values = {};
  for (let i = 0; i < args.length; i += 2) { requireFact(allowed.has(args[i]) && args[i + 1] && !args[i + 1].startsWith('--'), 'UI_BOOTSTRAP_ARGUMENT'); requireFact(!values[args[i]], 'UI_BOOTSTRAP_DUPLICATE_ARGUMENT'); values[args[i]] = args[i + 1]; }
  requireFact(values['--store-dir'] && values['--report'], 'UI_BOOTSTRAP_REQUIRED_ARGUMENT');
  const result = await bootstrapInstall({ repoRoot: resolve(values['--repo'] ?? '.'), storeDir: resolve(values['--store-dir']), stagingRoot: values['--staging-root'] ? resolve(values['--staging-root']) : tmpdir(), releaseReadToken: process.env.WORKLOOM_UI_RELEASE_READ_TOKEN });
  await writeFile(resolve(values['--report']), JSON.stringify(result, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  process.stdout.write(JSON.stringify({ frozenInstallPassed: result.frozenInstallPassed, version: result.installedVersion, originalLockSha256: result.originalLockSha256, originalLockUnchanged: result.originalLockUnchanged }) + '\n');
}
if (resolve(process.argv[1] ?? '') === fileURLToPath(import.meta.url)) {
  main().catch(error => { process.stderr.write(JSON.stringify({ code: error instanceof BootstrapError ? error.code : 'UI_BOOTSTRAP_FAILED', message: error instanceof BootstrapError ? error.message : 'Bootstrap filesystem/runtime failed' }) + '\n'); process.exitCode = 1; });
}
