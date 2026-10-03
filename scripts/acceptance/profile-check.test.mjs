import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync, execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdtempSync, mkdirSync, copyFileSync, readFileSync, writeFileSync, symlinkSync, rmSync, existsSync, renameSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const source = fileURLToPath(new URL('../..', import.meta.url));
const require = createRequire(process.env.WORKLOOM_TEST_DEPENDENCIES ?? import.meta.url);
const yamlRoot = dirname(require.resolve('yaml/package.json'));
function fixture(t, { directoryName = null } = {}) {
  const parent = mkdtempSync(join(tmpdir(), 'rdas-profile-'));
  const root = directoryName ? join(parent, directoryName) : parent;
  mkdirSync(root, { recursive: true });
  t.after(() => rmSync(parent, { recursive: true, force: true }));
  for (const path of ['scripts/acceptance/profile-check.mjs', 'scripts/acceptance/lib/profile-contract.mjs', 'scripts/acceptance/lib/repository-instance.mjs', 'scripts/acceptance/lib/outcome-contract.mjs', 'scripts/acceptance/lib/profile.mjs', 'scripts/acceptance/lib/target.mjs', 'scripts/acceptance/lib/live/budget.mjs', 'scripts/delivery/evidence.mjs']) {
    mkdirSync(dirname(join(root, path)), { recursive: true }); copyFileSync(join(source, path), join(root, path));
  }
  for (const path of ['acceptance/outcomes', 'bundles/industry/presets', 'node_modules']) mkdirSync(join(root, path), { recursive: true });
  symlinkSync(yamlRoot, join(root, 'node_modules/yaml'));
  writeFileSync(join(root, 'package.json'), JSON.stringify({ type: 'module' }));
  writeFileSync(join(root, '.gitignore'), 'node_modules/\noutputs/\n');
  writeFileSync(join(root, 'product.manifest.json'), JSON.stringify({ repository: 'workloom-ai/fixture', defaultBundle: 'industry', demoWorkspaceSlug: 'fixture', demoMemberNo: 'MEM-001' }));
  writeFileSync(join(root, 'bundles/industry/presets/analyst.yml'), 'preset_key: industry-analyst\nreadonly: true\n');
  const profile = { schemaVersion: 'workloom.acceptance-profile/v2', repo: 'workloom-ai/fixture', productName: '行业验收夹具', primaryBundle: 'industry', dataMode: 'simulated', identity: { workspaceSlug: 'fixture', human: 'MEM-001' }, startup: { command: 'pnpm preview:all', ports: { pc: 3000, bMobile: 3001, cMobile: 3002, server: 8787 } }, environment: { kind: 'local-preview', allowWrites: false, target: {} }, surfaces: { pcRoutes: ['/'], bMobileRoutes: ['/'], cRoutes: ['#chat'] }, journeys: [{ id: 'EXP-01', title: '事实摘要', persona: 'owner', script: 'builtin:first-value' }], ux: { personas: [{ id: 'owner', criticality: 'P0', jtbd: ['看到事实与待核实项'] }], journeys: [{ id: 'U-01', title: '事实摘要', persona: 'owner', stage: 'daily' }], tasks: [{ id: 'U2-T01', persona: 'owner', criticality: 'P0', budgetMs: 30000, paths: ['normal', 'error', 'permission'] }] }, outcome: { fixtureMarker: 'suite.rdas.fixture', residualDisclosure: '带标记的验收线程和事件保留，不纳入业务指标。', roles: [{ role: 'industry-analyst', agentPreset: 'industry-analyst', al: 'AL3', deliverableUnit: '事实摘要', minSubstance: '来源、缺失项、待核实项' }], taskSuites: ['acceptance/outcomes/industry.yaml'] }, autonomy: { fixtureFilters: ['suite.rdas.'] }, live: { enabled: true, models: [], tasks: [{ id: 'PROD-01', kind: 'product', input: 'suite.rdas.fixture：当前事实有哪些未核实？', presetKey: 'industry-analyst', requireModel: true, fixtureMarker: 'suite.rdas.fixture', residualDisclosure: '保留验收线程。', state_asserts: [{ event: { action: 'ask.answer', field: 'decision.after.text', minLength: 10 } }] }] } };
  writeFileSync(join(root, 'acceptance/profile.json'), JSON.stringify(profile));
  writeFileSync(join(root, 'acceptance/outcomes/industry.yaml'), `role: industry-analyst\nagentPreset: industry-analyst\ntrials: 5\ntasks:\n  - id: NORMAL\n    title: 行业事实摘要\n    input: 当前有哪些未核实的事实？\n    scenario: normal\n    criticality: P0\n    event_asserts:\n      - { action: ask.answer, field: decision.after.text, minLength: 10 }\n    receipt: { require: true, source: thread-events }\n  - id: FAILURE\n    title: 超长标题拒绝\n    input: 边界验证\n    scenario: failure\n    invalidInput: title-too-long\n    expect: { status: 400, code: BAD_REQUEST, noThreadCreated: true }\n  - id: PERMISSION\n    title: 无身份拒绝\n    input: 权限验证\n    scenario: permission\n    auth: none\n    expect: { status: 401, code: UNAUTHORIZED, noThreadCreated: true }\n`);
  for (const args of [['init', '-qb', 'main'], ['config', 'user.name', 'Fixture'], ['config', 'user.email', 'fixture@example.test'], ['add', '.'], ['commit', '-qm', 'profile source']]) execFileSync('git', args, { cwd: root, stdio: 'ignore' });
  return { root, profile };
}
function run(f, args = [], env = {}) {
  const result = spawnSync(process.execPath, ['scripts/acceptance/profile-check.mjs', ...args], { cwd: f.root, encoding: 'utf8', env: { ...process.env, ACCEPTANCE_ENV_KIND: '', ACCEPTANCE_ALLOW_PROD_WRITES: '', CNB: '', CNB_REPO_SLUG: '', CNB_REPO_SLUG_LOWERCASE: '', ...env } });
  const path = join(f.root, 'outputs/acceptance/profile/profile-validation.json');
  return { code: result.status, output: `${result.stdout}\n${result.stderr}`, report: existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : null };
}
function isolated(f, repository = 'workloom-ai/isolated-fixture') {
  f.profile.repositoryInstance = repository;
  f.profile.isolation = { isolated: true, sourceProductRepository: f.profile.repo };
  writeFileSync(join(f.root, 'acceptance/profile.json'), JSON.stringify(f.profile));
}
function origin(f, url) {
  execFileSync('git', ['config', '--local', '--add', 'remote.origin.url', url], { cwd: f.root, stdio: 'ignore' });
}
function configurationOnly(result) {
  assert.equal(result.report.businessVerified, false);
  assert.equal(result.report.status, result.code === 0 ? 'unverified' : 'fail');
  for (const key of ['modelCalls', 'networkCalls', 'databaseConnections']) assert.equal(result.report[key], 0, key);
}
test('G14: profile CLI binds structural evidence but never emits a business or checklist pass', (t) => {
  const f = fixture(t); const result = run(f);
  assert.equal(result.code, 0, result.output); assert.equal(result.report.configurationStatus, 'valid'); assert.equal(result.report.status, 'unverified');
  assert.equal(result.report.businessVerified, false); assert.equal(result.report.taskCount, 3); assert.match(result.report.revision.commit, /^[0-9a-f]{40}$/);
  assert.equal(existsSync(join(f.root, 'outputs/acceptance/items')), false);
});
test('G14: CLI rejects raw missing routes instead of accepting loader defaults', (t) => {
  const f = fixture(t); delete f.profile.surfaces; writeFileSync(join(f.root, 'acceptance/profile.json'), JSON.stringify(f.profile));
  const result = run(f); assert.equal(result.code, 1, result.output); assert.match(result.report.errors.join(' '), /surfaces/);
});
test('G14 isolated: CLI rejects absent raw environment rather than inheriting local defaults', (t) => {
  const f = fixture(t); delete f.profile.environment; writeFileSync(join(f.root, 'acceptance/profile.json'), JSON.stringify(f.profile));
  const result = run(f); assert.equal(result.code, 1, result.output); assert.match(result.report.errors.join(' '), /environment/);
  assert.equal(result.report.modelCalls, 0); assert.equal(result.report.networkCalls, 0); assert.equal(result.report.databaseConnections, 0);
});
test('G14 isolated: wrong instance identity and undeclared role preset cannot pass the real CLI', (t) => {
  for (const changed of [(profile) => { profile.repositoryInstance = 'workloom-ai/wrong-instance'; profile.isolation = { isolated: true, sourceProductRepository: profile.repo }; }, (profile) => { profile.outcome.roles[0].agentPreset = 'missing-preset'; }]) {
    const f = fixture(t); changed(f.profile); writeFileSync(join(f.root, 'acceptance/profile.json'), JSON.stringify(f.profile));
    const result = run(f); assert.equal(result.code, 1, result.output); assert.match(result.report.errors.join(' '), /repositoryInstance|preset/);
    assert.equal(result.report.businessVerified, false);
  }
});
test('G14 isolated P0: five P1 trials cannot conceal a single representative P0 trial in the actual suite', (t) => {
  const f = fixture(t); const path = join(f.root, 'acceptance/outcomes/industry.yaml');
  let text = readFileSync(path, 'utf8').replace('    criticality: P0\n', '    criticality: P0\n    trials: 1\n');
  text += '  - id: P1-FIVE\n    title: 普通摘要重复\n    input: 当前事实有哪些未核实？\n    scenario: normal\n    criticality: P1\n    trials: 5\n    event_asserts:\n      - { action: ask.answer, field: decision.after.text, minLength: 10 }\n    receipt: { require: true, source: thread-events }\n';
  writeFileSync(path, text); const result = run(f);
  assert.equal(result.code, 1, result.output); assert.match(result.report.errors.join(' '), /P0.*5.*trial/);
  assert.equal(result.report.taskCount, 4); assert.equal(result.report.businessVerified, false);
});
test('G07 G14: CLI, inherited environment and profile conflicts are rejected before using a target', (t) => {
  for (const [args, env] of [[['--env', 'client-runtime'], {}], [[], { ACCEPTANCE_ENV_KIND: 'client-runtime' }], [['--env', 'local-preview', '--env', 'deployed'], {}]]) {
    const f = fixture(t); const result = run(f, args, env); assert.equal(result.code, 1, result.output); assert.equal(result.report.businessVerified, false);
  }
});
test('G14: explicitly missing profile is unverified and cannot fall back to a present default', (t) => {
  const f = fixture(t); const result = run(f, ['--profile', 'acceptance/missing.json']);
  assert.equal(result.code, 2, result.output); assert.equal(result.report.configurationStatus, 'missing'); assert.equal(result.report.status, 'unverified');
});
test('G14: malformed industry suite and stale undeclared suite fail the actual profile consumer', (t) => {
  for (const name of ['industry.yaml', 'undeclared.yaml']) {
    const f = fixture(t); writeFileSync(join(f.root, 'acceptance/outcomes', name), 'role: industry-analyst\ntasks: []\n');
    const result = run(f); assert.equal(result.code, 1, result.output); assert.equal(result.report.configurationStatus, 'invalid');
  }
});
test('G14: invalid output boundary writes only the safe fallback diagnostic', (t) => {
  const f = fixture(t); const rejected = join(f.root, 'rejected'); const result = run(f, ['--out', rejected, '--evidence-root', rejected]);
  assert.equal(result.code, 1, result.output); assert.equal(existsSync(rejected), false); assert.equal(result.report.configurationStatus, 'invalid');
});
test('G14: root CLI resolves governance assets only when both product manifests agree', (t) => {
  const f = fixture(t); mkdirSync(join(f.root, 'governance'));
  copyFileSync(join(f.root, 'product.manifest.json'), join(f.root, 'governance/product.manifest.json'));
  renameSync(join(f.root, 'bundles'), join(f.root, 'governance/bundles'));
  mkdirSync(join(f.root, 'bundles/industry'), { recursive: true });
  writeFileSync(join(f.root, 'bundles/industry/README.md'), 'Root metadata mirror; application presets are in governance.\n');
  const valid = run(f); assert.equal(valid.code, 0, valid.output);
  writeFileSync(join(f.root, 'governance/product.manifest.json'), JSON.stringify({ repository: 'workloom-ai/other', defaultBundle: 'industry' }));
  const invalid = run(f); assert.equal(invalid.code, 1, invalid.output); assert.match(invalid.report.errors.join(' '), /manifest/);
});

test('G14 CI instance: canonical origin validates an isolated checkout actually named workspace', (t) => {
  const f = fixture(t, { directoryName: 'workspace' }); isolated(f);
  origin(f, 'https://cnb.cool/workloom-ai/isolated-fixture.git');
  const result = run(f);
  assert.equal(result.code, 0, result.output); assert.equal(result.report.configurationStatus, 'valid');
  assert.deepEqual(result.report.repositoryIdentity, { repository: f.profile.repositoryInstance, source: 'git:remote.origin.url' });
  assert.equal(result.report.suiteCount, 1); assert.equal(result.report.taskCount, 3); configurationOnly(result);
});
test('G14 CI instance: read-only CNB identity validates workspace without a local origin', (t) => {
  const f = fixture(t, { directoryName: 'workspace' }); isolated(f);
  const result = run(f, [], { CNB: 'true', CNB_REPO_SLUG: 'workloom-ai/Isolated-Fixture', CNB_REPO_SLUG_LOWERCASE: 'workloom-ai/isolated-fixture' });
  assert.equal(result.code, 0, result.output);
  assert.deepEqual(result.report.repositoryIdentity, { repository: f.profile.repositoryInstance, source: 'cnb:CNB_REPO_SLUG' }); configurationOnly(result);
});
test('G14 CI instance: complete group path is independent of the frozen source product prefix', (t) => {
  const f = fixture(t, { directoryName: 'workspace' }); isolated(f, 'reviewed-org/isolates/isolated-fixture');
  origin(f, 'https://cnb.cool/reviewed-org/isolates/isolated-fixture');
  const result = run(f); assert.equal(result.code, 0, result.output);
  assert.equal(result.report.repositoryIdentity.repository, f.profile.repositoryInstance);
  assert.equal(f.profile.repo, 'workloom-ai/fixture'); configurationOnly(result);
});
test('G14 CI instance: a matching directory name cannot overrule the wrong canonical origin', (t) => {
  const f = fixture(t, { directoryName: 'isolated-fixture' }); isolated(f);
  origin(f, 'https://cnb.cool/another-org/isolated-fixture');
  const result = run(f); assert.equal(result.code, 1, result.output); assert.match(result.report.errors.join(' '), /repositoryInstance/); configurationOnly(result);
});
test('G14 CI instance: missing origin cannot be supplied by directory, profile or rename metadata', (t) => {
  const f = fixture(t, { directoryName: 'isolated-fixture' }); isolated(f);
  writeFileSync(join(f.root, '.workloom-rename-policy.json'), JSON.stringify({ schema: 'workloom.rename-policy/v1', identity: { repository: f.profile.repositoryInstance } }));
  writeFileSync(join(f.root, '.workloom-base-sync.json'), JSON.stringify({ repository: f.profile.repositoryInstance }));
  const result = run(f); assert.equal(result.code, 1, result.output); assert.match(result.report.errors.join(' '), /repositoryInstance/); configurationOnly(result);
});
test('G14 CI instance: duplicate origin declarations are ambiguous even when equal', (t) => {
  const f = fixture(t, { directoryName: 'isolated-fixture' }); isolated(f);
  for (let i = 0; i < 2; i++) origin(f, 'https://cnb.cool/workloom-ai/isolated-fixture');
  const result = run(f); assert.equal(result.code, 1, result.output); assert.match(result.report.errors.join(' '), /repositoryInstance/); configurationOnly(result);
});
const credentialedOrigin = new URL('https://cnb.cool/workloom-ai/isolated-fixture');
credentialedOrigin.username = 'fixture-user'; credentialedOrigin.password = ['testonly', 'origin', 'opaque'].join('-');
for (const [name, url] of [
  ['userinfo', credentialedOrigin.href],
  ['query', 'https://cnb.cool/workloom-ai/isolated-fixture?testonly=opaque'],
  ['fragment', 'https://cnb.cool/workloom-ai/isolated-fixture#testonly-opaque'],
  ['non-CNB host', 'https://example.test/workloom-ai/isolated-fixture'],
]) test(`G14 CI instance: ${name} origin is rejected without exposing its raw value`, (t) => {
  const f = fixture(t, { directoryName: 'isolated-fixture' }); isolated(f); origin(f, url);
  const result = run(f); assert.equal(result.code, 1, result.output); assert.match(result.report.errors.join(' '), /repositoryInstance/);
  assert.equal(`${result.output}\n${JSON.stringify(result.report)}`.includes(url), false);
  assert.equal(`${result.output}\n${JSON.stringify(result.report)}`.includes(credentialedOrigin.password), false); configurationOnly(result);
});
for (const [name, env] of [
  ['missing slug', { CNB: 'true' }],
  ['malformed slug', { CNB: 'true', CNB_REPO_SLUG: 'https://cnb.cool/workloom-ai/isolated-fixture' }],
  ['conflicting lowercase', { CNB: 'true', CNB_REPO_SLUG: 'workloom-ai/isolated-fixture', CNB_REPO_SLUG_LOWERCASE: 'wrong-org/isolated-fixture' }],
  ['wrong canonical CNB instance', { CNB: 'true', CNB_REPO_SLUG: 'workloom-ai/another-fixture' }],
]) test(`G14 CI instance: ${name} cannot fall back to matching local directory or origin`, (t) => {
  const f = fixture(t, { directoryName: 'isolated-fixture' }); isolated(f); origin(f, 'https://cnb.cool/workloom-ai/isolated-fixture');
  const result = run(f, [], env); assert.equal(result.code, 1, result.output); assert.match(result.report.errors.join(' '), /repositoryInstance/); configurationOnly(result);
});
test('G14 CI instance: a profile without repositoryInstance preserves existing validation without identity metadata', (t) => {
  const f = fixture(t, { directoryName: 'workspace' }); const result = run(f, [], { CNB: 'true' });
  assert.equal(result.code, 0, result.output); assert.equal(Object.hasOwn(result.report, 'repositoryIdentity'), false); configurationOnly(result);
});
test('G14 CI instance: inherited Git relocation cannot change actual CLI repository or evidence commit', (t) => {
  const f = fixture(t, { directoryName: 'workspace' }); const other = fixture(t); isolated(f);
  origin(f, 'https://cnb.cool/workloom-ai/isolated-fixture'); origin(other, 'https://cnb.cool/another-org/isolated-fixture');
  writeFileSync(join(other.root, 'other-identity.txt'), 'Distinct foreign fixture identity.\n');
  for (const args of [['add', 'other-identity.txt'], ['commit', '-qm', 'distinct foreign fixture']]) execFileSync('git', args, { cwd: other.root, stdio: 'ignore' });
  const expectedCommit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: f.root, encoding: 'utf8' }).trim();
  const otherCommit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: other.root, encoding: 'utf8' }).trim(); assert.notEqual(expectedCommit, otherCommit);
  const result = run(f, [], { GIT_DIR: join(other.root, '.git'), GIT_WORK_TREE: other.root, GIT_COMMON_DIR: join(other.root, '.git'), GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'remote.origin.url', GIT_CONFIG_VALUE_0: 'https://cnb.cool/another-org/isolated-fixture' });
  assert.equal(result.code, 0, result.output); assert.equal(result.report.repositoryIdentity.repository, f.profile.repositoryInstance);
  assert.equal(result.report.revision.commit, expectedCommit); configurationOnly(result);
  const index = JSON.parse(readFileSync(join(f.root, 'outputs/acceptance/evidence-index.json'), 'utf8')); assert.equal(index.commit, expectedCommit);
  const record = JSON.parse(readFileSync(join(f.root, 'outputs/acceptance', index.runs[0].path), 'utf8')); assert.equal(record.commit, expectedCommit);
});
