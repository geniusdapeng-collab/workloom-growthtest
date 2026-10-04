import { test } from 'node:test';
import assert from 'node:assert/strict';
import { request } from 'node:http';
import { mkdtempSync, writeFileSync, chmodSync, rmSync, mkdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { resolveRepoRoot } from '../src/paths.mjs';
import { startGateway } from '../src/server.mjs';

const root = resolveRepoRoot();
function raw(instance, path, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = request(`${instance.url}${path}`, { headers }, res => {
      let body = ''; res.on('data', value => { body += value; });
      res.on('end', () => resolve({ status: res.statusCode, body }));
    }); req.on('error', reject); req.setTimeout(1000, () => req.destroy(new Error('request timed out'))); req.end();
  });
}
test('网关强制回环绑定；外部地址和无效端口在监听前拒绝', async () => {
  let instance;
  try { instance = await startGateway({ repoRoot: root, host: '0.0.0.0', port: 0 }); } catch (error) { assert.match(error.message, /loopback|回环/); }
  if (instance) { await instance.close(); assert.fail('外部绑定未拒绝'); }
  await assert.rejects(startGateway({ repoRoot: root, host: '127.0.0.1', port: -1 }), /port|端口/);
});
test('跨源与 DNS rebinding 拒绝；本地同源读取正常', async t => {
  const instance = await startGateway({ port: 0, repoRoot: root }); t.after(() => instance.close());
  assert.equal((await raw(instance, '/health', { Origin: 'https://example.com' })).status, 403);
  assert.equal((await raw(instance, '/health', { Host: 'attacker.example' })).status, 403);
  assert.equal((await raw(instance, '/health', { Origin: instance.url })).status, 200);
  assert.equal((await fetch(`${instance.url}/health`, { method: 'POST' })).status, 405);
});
test('错误编码与编码路径穿越被拒绝且服务保持可用', async t => {
  const instance = await startGateway({ port: 0, repoRoot: root }); t.after(() => instance.close());
  assert.equal((await raw(instance, '/stage/%ZZ')).status, 400);
  const escaped = await raw(instance, '/stage/%2e%2e%2fpackage.json');
  assert.ok([403, 404].includes(escaped.status));
  assert.equal((await raw(instance, '/health')).status, 200);
});
test('启动器拒绝过旧 Node、失效的显式 repo 和仅剩目录的 gateway', t => {
  const temp = mkdtempSync(join(tmpdir(), 'gateway-launch-')); t.after(() => rmSync(temp, { recursive: true, force: true }));
  const oldNode = join(temp, 'old-node'); writeFileSync(oldNode, '#!/bin/sh\nprintf 22\n'); chmodSync(oldNode, 0o755);
  const node = spawnSync('sh', ['-c', '. "$1"; resolve_workloom_node', 'sh', join(root, 'plugins/workloom-workbench/scripts/resolve-node.sh')], {
    encoding: 'utf8', env: { ...process.env, HOME: temp, WORKLOOM_NODE: oldNode },
  }); assert.notEqual(node.status, 0);
  const repo = spawnSync('sh', ['-c', '. "$1"; resolve_workloom_repo_root "$2"', 'sh', join(root, 'plugins/workloom-workbench/scripts/resolve-repo.sh'), join(root, 'plugins/workloom-workbench')], {
    encoding: 'utf8', env: { ...process.env, HOME: temp, WORKLOOM_REPO_ROOT: temp },
  }); assert.notEqual(repo.status, 0);
});

test('安装启动器能处理含空格和引号的仓库路径，且只把路径作为一个参数', t => {
  const temp = mkdtempSync(join(tmpdir(), 'gateway-install-')); t.after(() => rmSync(temp, { recursive: true, force: true }));
  const repo = join(temp, "repo root's directory"); const plugin = join(temp, 'plugin');
  mkdirSync(join(repo, 'tools/codex-gateway/bin'), { recursive: true }); mkdirSync(join(repo, 'plugins/workloom-workbench/scripts'), { recursive: true }); mkdirSync(join(plugin, 'scripts'), { recursive: true });
  writeFileSync(join(repo, 'product.manifest.json'), '{}'); writeFileSync(join(repo, 'tools/codex-gateway/bin/mcp.mjs'), '');
  writeFileSync(join(repo, 'plugins/workloom-workbench/scripts/start-mcp.sh'), '#!/bin/sh\nprintf callback-ok\n');
  for (const name of ['install-launcher.sh', 'resolve-repo.sh']) writeFileSync(join(plugin, 'scripts', name), readFileSync(join(root, 'plugins/workloom-workbench/scripts', name)));
  const install = spawnSync('sh', [join(plugin, 'scripts/install-launcher.sh')], { encoding: 'utf8', env: { ...process.env, HOME: temp, WORKLOOM_REPO_ROOT: repo } });
  assert.equal(install.status, 0, install.stderr);
  const launch = spawnSync('sh', [join(temp, '.local/bin/workloom-workbench-mcp')], { encoding: 'utf8' });
  assert.equal(launch.status, 0, launch.stderr); assert.equal(launch.stdout, 'callback-ok');
});
