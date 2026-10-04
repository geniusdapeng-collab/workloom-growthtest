import test from 'node:test';
import assert from 'node:assert/strict';
import { copyFileSync, existsSync, mkdtempSync, readFileSync, writeFileSync, mkdirSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { capabilityStatus } from './capability-status.mjs';
import { recordEvidenceRun } from './delivery/evidence.mjs';

function fixture(t, patch = {}, role = 'acceptance') {
  const root = mkdtempSync(join(tmpdir(), 'capability-proof-')); t.after(() => rmSync(root, { recursive: true, force: true }));
  const git = args => execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  git(['init', '-q']); git(['config', 'user.email', 'fixture@example.test']); git(['config', 'user.name', 'Fixture']);
  writeFileSync(join(root, 'source.txt'), 'source\n');
  writeFileSync(join(root, '.gitignore'), 'evidence/\nruns/\nevidence-index.json\n');
  git(['add', 'source.txt', '.gitignore']); git(['commit', '-qm', 'source']);
  const commit = git(['rev-parse', 'HEAD']); mkdirSync(join(root, 'evidence'));
  const value = { capabilityId: 'test:cap', commit, exitCode: 0, callable: true, verified: true, verifiedBy: 'independent', fixedBy: 'repair', environment: 'local-preview', completedAt: new Date().toISOString(), ...patch };
  const startedAt = new Date().toISOString();
  const execution = spawnSync(process.execPath, ['-e', 'process.stdout.write(process.argv[1]);process.exit(Number(process.argv[2]))', JSON.stringify(value), String(value.exitCode)], { encoding: 'utf8' });
  writeFileSync(join(root, 'evidence/result.json'), execution.stdout);
  const run = recordEvidenceRun({ repoRoot: root, artifactRoot: root, runId: 'cap-result', command: 'capability fixture subprocess', actor: 'independent', role, exitCode: execution.status, startedAt, outputPaths: ['evidence/result.json'], subject: { capabilityId: 'test:cap' } });
  return { root, id: 'test:cap', discoverable: true, currentCommit: commit, attestation: { evidence: run.artifacts[0], run: run.runRef } };
}
test('源文件可发现不等于可调用或已验证', () => {
  const out = capabilityStatus({ discoverable: true });
  assert.equal(out.discoverable, true); assert.equal(out.callable, 'unverified'); assert.equal(out.verified, 'unverified');
});
test('真实子进程成功且提交/散列/独立角色一致才能升级', t => {
  const options = fixture(t);
  assert.equal(capabilityStatus(options).verified, true);
  for (const change of [
    { currentCommit: 'b'.repeat(40) },
    { attestation: { ...options.attestation, run: null } },
    { attestation: { ...options.attestation, evidence: { ...options.attestation.evidence, sha256: '0'.repeat(64) } } },
    { attestation: { ...options.attestation, evidence: { ...options.attestation.evidence, path: '../escape.json' } } },
  ]) assert.equal(capabilityStatus({ ...options, ...change }).verified, 'unverified');
});
for (const [name, patch, role] of [
  ['failed', { exitCode: 1 }], ['stale', { completedAt: '2000-01-01T00:00:00Z' }],
  ['future', { completedAt: '2099-01-01T00:00:00Z' }], ['wrong-id', { capabilityId: 'other' }],
  ['uncallable', { callable: false }], ['self-verify', { fixedBy: 'independent' }], ['repair-role', {}, 'repair'],
]) test(`${name} 不能升级为已验证能力`, t => { assert.equal(capabilityStatus(fixture(t, patch, role)).verified, 'unverified'); });
test('符号链接证据拒绝，即便内容与散列相同', t => {
  const options = fixture(t); symlinkSync('result.json', join(options.root, 'evidence/link.json'));
  options.attestation.evidence.path = 'evidence/link.json';
  assert.equal(capabilityStatus(options).verified, 'unverified');
});
test('手写成功 JSON、缺证据与未发现入口不能升级', t => {
  const options = fixture(t); delete options.attestation.run;
  assert.equal(capabilityStatus(options).callable, 'unverified');
  assert.equal(capabilityStatus({ discoverable: false, attestation: { verified: true } }).verified, 'unverified');
});

// Exercise this repository's specialized generator, including product declarations.
// These are synthetic metadata/proof fixtures and do not attest a live capability.
function generatorFixture(t, { apps = ['web', 'webb', 'webc'], missingAppManifests = [], git = false } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'isolated-capability-consumer-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const write = (path, value) => {
    mkdirSync(join(root, path, '..'), { recursive: true });
    writeFileSync(join(root, path), typeof value === 'string' ? value : JSON.stringify(value));
  };
  for (const directory of ['scripts', 'docs/demo', 'skills/official', 'packages/base', 'packages/runtime/src']) mkdirSync(join(root, directory), { recursive: true });
  write('package.json', { name: '@fixture/isolated', engines: { node: '>=24.0.0' }, packageManager: 'fixture-only', scripts: {} });
  write('product.manifest.json', { productId: 'fixture-isolated', defaultBundle: 'primary', repository: 'fixture/isolated', displayName: 'Fixture only' });
  write('README.md', '# Fixture-only document\n\n---\n');
  write('.cnb.yml', '# Fixture-only metadata; no jobs\n');
  write('scripts/bootstrap.sh', '# Fixture-only metadata; never executed\n');
  write('mock/README.md', 'Fixture-only metadata\n');
  for (const app of apps) {
    write(`apps/${app}/src/App.tsx`, '// Fixture-only metadata\n');
    if (!missingAppManifests.includes(app)) write(`apps/${app}/package.json`, { name: '@fixture/' + app });
  }
  for (const [name, presets] of [['primary', ['alpha', 'beta']], ['secondary', ['alpha']]]) {
    write(`bundles/${name}/bundle.json`, { version: '1.0.0', workloom: { status: 'candidate', provides: { presets: presets.map((_, index) => `presets/${index}.yml`), skills: [], pipelines: [] } } });
    for (let index = 0; index < presets.length; index += 1) write(`bundles/${name}/presets/${index}.yml`, `preset_key: ${presets[index]}\n`);
  }
  const sourceRoot = join(import.meta.dirname, '..');
  for (const path of ['scripts/generate-capabilities.mjs', 'scripts/capability-status.mjs', 'scripts/delivery/evidence.mjs']) {
    assert.ok(existsSync(join(sourceRoot, path)), `Actual generator closure is missing: ${path}`);
    mkdirSync(join(root, path, '..'), { recursive: true });
    copyFileSync(join(sourceRoot, path), join(root, path));
  }
  const gitRun = args => execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  let commit = null;
  if (git) {
    write('.gitignore', 'acceptance/\nruns/\nevidence-index.json\ndocs/capabilities.auto.md\ndocs/capabilities.auto.json\nREADME.md\n');
    gitRun(['init', '-q']); gitRun(['config', 'user.email', 'fixture@example.test']); gitRun(['config', 'user.name', 'Fixture']);
    gitRun(['add', '-A']); gitRun(['commit', '-qm', 'synthetic generator source']);
    commit = gitRun(['rev-parse', 'HEAD']);
  }
  const env = { ...process.env }; delete env.NODE_TEST_CONTEXT; delete env.NODE_OPTIONS;
  return { root, write, gitRun, commit, proofCount: 0, env };
}

function runGenerator(value, args = []) {
  return spawnSync(process.execPath, ['scripts/generate-capabilities.mjs', ...args], { cwd: value.root, env: value.env, encoding: 'utf8', timeout: 20000 });
}

function generated(value) {
  const result = runGenerator(value);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return {
    json: JSON.parse(readFileSync(join(value.root, 'docs/capabilities.auto.json'), 'utf8')),
    md: readFileSync(join(value.root, 'docs/capabilities.auto.md'), 'utf8'),
  };
}

const appId = 'cap:' + createHash('sha256').update('三端应用入口/PC 工作台').digest('hex').slice(0, 16);
const pcAvailability = value => value.json.groups.find(group => group.title === '三端应用入口').items.find(entry => entry.id === appId).availability;

function writeCapabilityProof(value, patch = {}, role = 'acceptance') {
  const index = ++value.proofCount;
  const body = { capabilityId: appId, commit: value.commit, exitCode: 0, callable: true, verified: true, verifiedBy: 'independent-consumer', fixedBy: 'repair-consumer', environment: 'local-preview', completedAt: new Date().toISOString(), ...patch };
  const args = ['-e', 'process.stdout.write(process.argv[1]);process.exit(Number(process.argv[2]))', JSON.stringify(body), String(body.exitCode)];
  const startedAt = new Date().toISOString();
  const execution = spawnSync(process.execPath, args, { env: value.env, encoding: 'utf8' });
  assert.equal(execution.status, body.exitCode);
  const outputPath = `acceptance/result-${index}.json`;
  value.write(outputPath, execution.stdout);
  const run = recordEvidenceRun({ repoRoot: value.root, artifactRoot: value.root, runId: `generator-result-${index}`, command: 'synthetic capability-result subprocess', exec: { file: process.execPath, args }, actor: 'independent-consumer', role, exitCode: execution.status, startedAt, outputPaths: [outputPath], subject: { capabilityId: appId } });
  const attestation = { id: appId, evidence: run.artifacts[0], run: run.runRef };
  value.write('acceptance/capability-status.json', { entries: [attestation] });
  return attestation;
}

test('本仓生成器消费：schema2、稳定能力标识与声明统计保留，缺运行证据默认未验证', t => {
  const value = generatorFixture(t);
  const first = generated(value);
  assert.equal(first.json.schema, 'workloom.capabilities/v2');
  assert.equal(first.json.productId, 'fixture-isolated');
  assert.equal(first.json.repository, 'fixture/isolated');
  assert.deepEqual(first.json.declarationTotals, { presets: 3, skills: 0, pipelines: 0, uniquePresetKeys: 2 });
  assert.deepEqual(first.json.bundleDeclarations.map(bundle => bundle.sourcePath), ['bundles/primary/bundle.json', 'bundles/secondary/bundle.json']);
  const items = first.json.groups.flatMap(group => group.items);
  assert.equal(new Set(items.map(entry => entry.id)).size, items.length);
  for (const entry of items) {
    assert.match(entry.id, /^cap:[0-9a-f]{16}$/u);
    assert.equal(entry.availability.discoverable, true);
    assert.equal(entry.availability.callable, 'unverified');
    assert.equal(entry.availability.verified, 'unverified');
  }
  const paths = ['README.md', 'docs/capabilities.auto.md', 'docs/capabilities.auto.json'];
  const before = paths.map(path => readFileSync(join(value.root, path)));
  assert.equal(runGenerator(value, ['--check']).status, 0);
  assert.deepEqual(paths.map(path => readFileSync(join(value.root, path))), before);
  const changed = { ...first.json, inventedRuntimeClaim: true };
  value.write('docs/capabilities.auto.json', changed);
  const stale = paths.map(path => readFileSync(join(value.root, path)));
  assert.equal(runGenerator(value, ['--check']).status, 1);
  assert.deepEqual(paths.map(path => readFileSync(join(value.root, path))), stale);
});

test('本仓生成器消费：没有应用manifest的源码片段不列为应用或导览地址', t => {
  const value = generatorFixture(t, { missingAppManifests: ['webb', 'webc'] });
  const output = generated(value);
  const group = output.json.groups.find(row => row.title === '三端应用入口');
  assert.deepEqual(group.items.map(entry => entry.name), ['PC 工作台']);
  assert.deepEqual(group.sourcePaths, ['product.manifest.json', 'apps/web/package.json', 'apps/web/src/App.tsx']);
  assert.doesNotMatch(output.md, /员工移动工作台|客户 H5 服务前台|localhost:3001|localhost:3002/u);
});

test('本仓生成器消费：应用目录缺失时仍生成有效目录，不保留虚构来源与演示地址', t => {
  for (const apps of [['web'], []]) {
    const output = generated(generatorFixture(t, { apps }));
    const group = output.json.groups.find(row => row.title === '三端应用入口');
    if (apps.length) assert.deepEqual(group.items.map(entry => entry.name), ['PC 工作台']);
    else assert.equal(group, undefined);
    assert.doesNotMatch(output.md, apps.length ? /localhost:3001|localhost:3002/u : /localhost:300[012]/u);
  }
});

test('本仓生成器消费：手写成功结果与外仓提交不能升级可调用或已验证状态', t => {
  const value = generatorFixture(t, { git: true });
  const body = { capabilityId: appId, commit: value.commit, exitCode: 0, callable: true, verified: true, environment: 'local-preview', completedAt: new Date().toISOString() };
  value.write('acceptance/handwritten.json', body);
  const proof = { path: 'acceptance/handwritten.json', commit: value.commit, sha256: createHash('sha256').update(readFileSync(join(value.root, 'acceptance/handwritten.json'))).digest('hex') };
  value.write('acceptance/capability-status.json', { entries: [{ id: appId, evidence: proof }] });
  assert.equal(pcAvailability(generated(value)).callable, 'unverified');
  const attestation = writeCapabilityProof(value);
  value.write('acceptance/capability-status.json', { entries: [{ ...attestation, evidence: { ...attestation.evidence, commit: 'b'.repeat(40) } }] });
  assert.equal(pcAvailability(generated(value)).verified, 'unverified');
});

test('本仓生成器消费：同提交子进程与独立验收角色可升级，过期、失败与自验继续未验证', t => {
  const value = generatorFixture(t, { git: true });
  writeCapabilityProof(value);
  assert.deepEqual({ callable: pcAvailability(generated(value)).callable, verified: pcAvailability(generated(value)).verified }, { callable: true, verified: true });
  for (const [patch, role] of [
    [{ completedAt: '2000-01-01T00:00:00Z' }, 'acceptance'],
    [{ exitCode: 1 }, 'acceptance'],
    [{ fixedBy: 'independent-consumer' }, 'acceptance'],
    [{}, 'repair'],
  ]) {
    writeCapabilityProof(value, patch, role);
    assert.equal(pcAvailability(generated(value)).verified, 'unverified');
  }
});

test('本仓生成器消费：行业声明与已发现应用来源仍严格校验，失败不覆盖既有派生产物', t => {
  const value = generatorFixture(t);
  generated(value);
  const paths = ['README.md', 'docs/capabilities.auto.md', 'docs/capabilities.auto.json'];
  const before = paths.map(path => readFileSync(join(value.root, path)));
  rmSync(join(value.root, 'bundles/primary/presets/0.yml'));
  const invalidBundle = runGenerator(value);
  assert.equal(invalidBundle.status, 1);
  assert.match(invalidBundle.stderr, /ENOENT|Bundle 声明/u);
  assert.deepEqual(paths.map(path => readFileSync(join(value.root, path))), before);
  value.write('bundles/primary/presets/0.yml', 'preset_key: alpha\n');
  rmSync(join(value.root, 'apps/web/src/App.tsx'));
  const invalidApp = runGenerator(value);
  assert.equal(invalidApp.status, 1);
  assert.match(invalidApp.stderr, /能力导览来源不存在：apps\/web\/src\/App\.tsx/u);
  assert.deepEqual(paths.map(path => readFileSync(join(value.root, path))), before);
});
