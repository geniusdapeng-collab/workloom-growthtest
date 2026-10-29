import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { invokeCapability, loadCatalog, mcpTools } from './agent-capabilities.mjs';
import { readVideoWorkbenchGuide, readVideoWorkbenchGuideFromRoot, VIDEO_WORKBENCH_GUIDE_VERSION } from '../bundles/geo-growth/capabilities/workbench-guide.mjs';

const root = resolve(import.meta.dirname, '..');
const ref = 'docs/ai-video-workbench-guide.md';
const id = 'growth.video.workbench.guide';
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const bytes = readFileSync(join(root, ref));

function fixture(t) {
  const base = mkdtempSync(join(tmpdir(), "video guide 中文 空格 ' "));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const repository = join(base, 'repository');
  mkdirSync(join(repository, 'docs'), { recursive: true });
  cpSync(join(root, 'product.manifest.json'), join(repository, 'product.manifest.json'));
  writeFileSync(join(repository, ref), bytes);
  return { base, repository, guide: join(repository, ref) };
}

test('fixed guide returns actual full UTF-8 bytes, identity and SHA without a network call', async () => {
  const direct = readVideoWorkbenchGuide({});
  assert.equal(direct.repository, 'geniusdapeng-collab/workloom-growthtest');
  assert.equal(direct.guideVersion, VIDEO_WORKBENCH_GUIDE_VERSION);
  assert.equal(direct.path, ref); assert.equal(direct.markdown, bytes.toString('utf8'));
  assert.equal(direct.sha256, digest(bytes)); assert.equal(direct.bytes, bytes.length);
  const catalog = await loadCatalog(root);
  const descriptor = catalog.entries.get(id);
  assert.equal(descriptor.operation, 'read'); assert.equal(descriptor.risk, 'low');
  const tool = mcpTools(catalog).find(item => item.name === 'workloom_growth_video_workbench_guide');
  assert.equal(tool.annotations.readOnlyHint, true); assert.equal(tool.annotations.openWorldHint, false);
  const result = await invokeCapability(catalog, id, {}, { fetcher: () => assert.fail('guide must never fetch') });
  assert.equal(result.status, 'succeeded'); assert.equal(result.dataMode, 'unverified');
  assert.deepEqual(result.result, direct); assert.equal(result.receipt, undefined);
  // Existing transport normalizes null to empty input; this read-only compatibility
  // does not admit path overrides and differs from directly calling the function.
  assert.deepEqual((await invokeCapability(catalog, id, null)).result, direct);
});

test('guide rejects all caller paths, overrides and non-object inputs', async () => {
  const catalog = await loadCatalog(root);
  for (const input of [{ path: '../outside' }, { root: root }, { projectId: 'other' }, [], 'text', 1]) {
    assert.throws(() => readVideoWorkbenchGuide(input), error => error.code === 'INVALID_INPUT');
    await assert.rejects(invokeCapability(catalog, id, input), error => error.code === 'INVALID_INPUT');
  }
  assert.throws(() => readVideoWorkbenchGuide(null), error => error.code === 'INVALID_INPUT');
});

for (const [name, mutate, code] of [
  ['missing guide', f => rmSync(f.guide), 'VIDEO_GUIDE_UNAVAILABLE'],
  ['empty guide', f => writeFileSync(f.guide, ''), 'VIDEO_GUIDE_UNAVAILABLE'],
  ['oversized guide', f => writeFileSync(f.guide, Buffer.alloc(256 * 1024 + 1)), 'VIDEO_GUIDE_UNAVAILABLE'],
  ['directory as guide', f => { rmSync(f.guide); mkdirSync(f.guide); }, 'VIDEO_GUIDE_UNAVAILABLE'],
  ['stale guide version', f => writeFileSync(f.guide, bytes.toString().replace(VIDEO_WORKBENCH_GUIDE_VERSION, 'old-version')), 'VIDEO_GUIDE_UNAVAILABLE'],
  ['wrong guide identity', f => writeFileSync(f.guide, `guideVersion: ${VIDEO_WORKBENCH_GUIDE_VERSION}\nwrong repository\n`), 'VIDEO_GUIDE_UNAVAILABLE'],
  ['invalid UTF-8 guide', f => writeFileSync(f.guide, Buffer.concat([bytes, Buffer.from([0xff])])), 'VIDEO_GUIDE_UNAVAILABLE'],
  ['missing manifest', f => rmSync(join(f.repository, 'product.manifest.json')), 'VIDEO_GUIDE_UNAVAILABLE'],
  ['invalid manifest', f => writeFileSync(join(f.repository, 'product.manifest.json'), '{'), 'VIDEO_GUIDE_UNAVAILABLE'],
  ['wrong product repository', f => writeFileSync(join(f.repository, 'product.manifest.json'), JSON.stringify({ repository: 'workloom-ai/WorkLoom-growth', productId: 'workloom-ai-growth' })), 'VIDEO_GUIDE_REPOSITORY_MISMATCH'],
]) {
  test(`guide fails closed for ${name}`, t => {
    const f = fixture(t); mutate(f);
    assert.throws(() => readVideoWorkbenchGuideFromRoot(f.repository), error => error.code === code);
  });
}

test('guide file and escaped parent symlinks cannot expose external bytes', t => {
  const f = fixture(t); const outside = join(f.base, 'outside'); mkdirSync(outside);
  writeFileSync(join(outside, 'guide.md'), bytes);
  rmSync(f.guide); symlinkSync(join(outside, 'guide.md'), f.guide);
  assert.throws(() => readVideoWorkbenchGuideFromRoot(f.repository), error => error.code === 'VIDEO_GUIDE_UNAVAILABLE');
  rmSync(join(f.repository, 'docs'), { recursive: true });
  writeFileSync(join(outside, 'ai-video-workbench-guide.md'), bytes);
  symlinkSync(outside, join(f.repository, 'docs'), 'junction');
  assert.throws(() => readVideoWorkbenchGuideFromRoot(f.repository), error => error.code === 'VIDEO_GUIDE_UNAVAILABLE');
});

test('CLI list/describe/invoke work from another cwd without credentials and preserve full guide bytes', () => {
  const executable = join(root, 'scripts/workloom-agent.mjs');
  const run = args => JSON.parse(execFileSync(process.execPath, [executable, ...args], { cwd: tmpdir(), encoding: 'utf8', timeout: 10000,
    env: { PATH: dirname(process.execPath), WORKLOOM_DEV_AUTO_LOGIN: '0' } }));
  assert.ok(run(['list']).capabilities.some(item => item.id === id));
  assert.equal(run(['describe', id]).transport.export, 'readVideoWorkbenchGuide');
  const result = run(['invoke', id]);
  assert.equal(result.result.markdown, bytes.toString('utf8')); assert.equal(result.result.sha256, digest(bytes));
});

test('real generic MCP discovers and reads guide; invalid extra fields fail with structured errors', () => {
  const requests = [
    { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'guide-test', version: '1' } } },
    { jsonrpc: '2.0', method: 'notifications/initialized' },
    { jsonrpc: '2.0', id: 2, method: 'tools/list' },
    { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'workloom_growth_video_workbench_guide', arguments: {} } },
    { jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'workloom_growth_video_workbench_guide', arguments: { path: '../outside' } } },
  ];
  const result = spawnSync(process.execPath, [join(root, 'scripts/workloom-agent-mcp.mjs')], {
    cwd: tmpdir(), encoding: 'utf8', timeout: 10000, maxBuffer: 2 * 1024 * 1024,
    env: { PATH: dirname(process.execPath), WORKLOOM_DEV_AUTO_LOGIN: '0' }, input: requests.map(item => JSON.stringify(item)).join('\n') + '\n',
  });
  assert.equal(result.status, 0, result.stderr);
  const replies = new Map(result.stdout.trim().split('\n').map(line => { const item = JSON.parse(line); return [item.id, item]; }));
  assert.ok(replies.get(2).result.tools.some(tool => tool.name === 'workloom_growth_video_workbench_guide'));
  const guide = JSON.parse(replies.get(3).result.content[0].text);
  assert.equal(guide.result.markdown, bytes.toString('utf8')); assert.equal(guide.result.sha256, digest(bytes));
  assert.equal(replies.get(4).result.isError, true);
  assert.equal(JSON.parse(replies.get(4).result.content[0].text).error.code, 'INVALID_INPUT');
});
