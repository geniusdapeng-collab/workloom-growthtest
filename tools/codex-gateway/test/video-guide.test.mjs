import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createMcpHandler } from '../src/mcp.mjs';
import { generateCatalog } from '../src/catalog.mjs';
import { gatewayRoot, resolveRepoRoot } from '../src/paths.mjs';

const repoRoot = resolveRepoRoot();
const bytes = readFileSync(join(repoRoot, 'docs/ai-video-workbench-guide.md'));
const digest = createHash('sha256').update(bytes).digest('hex');

test('actual plugin MCP instructions, read-only tool and Markdown resource all expose the same canonical guide', async () => {
  const handler = createMcpHandler({ repoRoot });
  const call = (id, method, params) => handler.handle({ jsonrpc: '2.0', id, method, params });
  assert.match((await call(1, 'initialize', {})).result.instructions, /workloom_video_guide/u);
  const tool = (await call(2, 'tools/list')).result.tools.find(item => item.name === 'workloom_video_guide');
  assert.equal(tool.annotations.readOnlyHint, true); assert.equal(tool.inputSchema.additionalProperties, false);
  const response = await call(3, 'tools/call', { name: tool.name, arguments: {} });
  const guide = JSON.parse(response.result.content[0].text);
  assert.equal(guide.markdown, bytes.toString('utf8')); assert.equal(guide.sha256, digest);
  assert.equal(guide.repository, 'workloom-ai/workloom-growthtest');
  const resource = (await call(4, 'resources/list')).result.resources.find(item => item.uri === 'workloom://guides/video');
  assert.equal(resource.mimeType, 'text/markdown');
  const read = await call(5, 'resources/read', { uri: resource.uri });
  assert.equal(read.result.contents[0].text, guide.markdown); assert.equal(read.result.contents[0].mimeType, 'text/markdown');
  for (const input of [{ path: '../secret' }, [], 'text']) {
    assert.equal((await call(6, 'tools/call', { name: tool.name, arguments: input })).error.code, -32602);
  }
});

test('missing plugin guide returns a failure for both read paths, never a fallback body', async t => {
  const base = mkdtempSync(join(tmpdir(), 'plugin-guide-missing-'));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  mkdirSync(join(base, 'bundles'));
  cpSync(join(repoRoot, 'product.manifest.json'), join(base, 'product.manifest.json'));
  const handler = createMcpHandler({ repoRoot: base, catalog: generateCatalog({ repoRoot }) });
  const response = await handler.handle({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'workloom_video_guide', arguments: {} } });
  assert.equal(response.result.isError, true);
  assert.equal(JSON.parse(response.result.content[0].text).error, 'VIDEO_GUIDE_UNAVAILABLE');
  const resource = await handler.handle({ jsonrpc: '2.0', id: 2, method: 'resources/read', params: { uri: 'workloom://guides/video' } });
  assert.equal(resource.error.code, -32000); assert.equal(resource.error.data.code, 'VIDEO_GUIDE_UNAVAILABLE');
});

test('gateway video CLI and trusted SessionStart context resolve the canonical guide from another cwd', () => {
  const cli = join(gatewayRoot(), 'bin/cli.mjs');
  const env = { ...process.env, WORKLOOM_REPO_ROOT: repoRoot };
  const guide = JSON.parse(execFileSync(process.execPath, [cli, 'video', 'guide', '--json'], { cwd: tmpdir(), env, encoding: 'utf8', timeout: 10000 }));
  assert.equal(guide.sha256, digest); assert.equal(guide.markdown, bytes.toString('utf8'));
  const context = JSON.parse(execFileSync(process.execPath, [cli, 'context'], { cwd: tmpdir(), env, encoding: 'utf8', timeout: 10000 }));
  assert.match(context.additionalContext, /docs\/ai-video-workbench-guide\.md/u);
  assert.match(context.additionalContext, /workloom_video_guide/u);
  assert.throws(() => execFileSync(process.execPath, [cli, 'video', 'guide', '--path', '../outside'], { cwd: tmpdir(), env, stdio: 'pipe', timeout: 10000 }));
});
