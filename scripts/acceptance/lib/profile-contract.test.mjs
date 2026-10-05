import test from 'node:test';
import assert from 'node:assert/strict';
import { validateProfileContract } from './profile-contract.mjs';

const normal = { id: 'INDUSTRY-NORMAL', title: '行业证据摘要', input: '当前行业事实有哪些未核实？', scenario: 'normal', criticality: 'P0', thread_asserts: [{ field: 'preset_key', equals: 'analyst' }], event_asserts: [{ action: 'ask.answer', field: 'decision.after.text', minLength: 10 }], receipt: { require: true, source: 'thread-events' } };
const suite = { role: 'analyst', agentPreset: 'analyst', trials: 5, tasks: [normal, { id: 'INDUSTRY-FAILURE', scenario: 'failure', title: '标题超长拒绝', input: '边界验证', invalidInput: 'title-too-long', expect: { status: 400, code: 'BAD_REQUEST', noThreadCreated: true } }, { id: 'INDUSTRY-PERMISSION', scenario: 'permission', title: '无身份拒绝', input: '权限验证', auth: 'none', expect: { status: 401, code: 'UNAUTHORIZED', noThreadCreated: true } }] };
const manifest = { repository: 'workloom-ai/example', defaultBundle: 'industry', demoWorkspaceSlug: 'example-demo', demoMemberNo: 'MEM-001' };
const profile = { schemaVersion: 'workloom.acceptance-profile/v2', repo: manifest.repository, productName: '行业系统', primaryBundle: 'industry', identity: { workspaceSlug: 'example-demo', human: 'MEM-001' }, dataMode: 'simulated', startup: { command: 'pnpm preview:all', ports: { pc: 3000, bMobile: 3001, cMobile: 3002, server: 8787 } }, environment: { kind: 'local-preview', allowWrites: false, target: {} }, surfaces: { pcRoutes: ['/'], bMobileRoutes: ['/'], cRoutes: ['#chat'] }, journeys: [{ id: 'EXP-01', persona: 'owner', title: '事实摘要', script: 'builtin:first-value' }], ux: { personas: [{ id: 'owner', jtbd: ['看到事实与待决项'], criticality: 'P0' }], journeys: [{ id: 'U-01', persona: 'owner', title: '事实摘要', stage: 'daily' }], tasks: [{ id: 'U2-T01', persona: 'owner', criticality: 'P0', budgetMs: 30000, paths: ['normal', 'error', 'permission'] }] }, outcome: { fixtureMarker: 'suite.rdas.example', residualDisclosure: '保留带标记的验收线程与事件，不纳入业务指标。', roles: [{ role: 'analyst', agentPreset: 'analyst', al: 'AL3', deliverableUnit: '事实摘要', minSubstance: '事实、出处、未核实项与待人工核查项' }], taskSuites: ['acceptance/outcomes/industry.yaml'] }, autonomy: { fixtureFilters: ['suite.rdas.'] }, live: { enabled: true, models: [], tasks: [{ id: 'PROD-01', kind: 'product', title: '行业事实链', input: 'suite.rdas.example：当前事实有哪些未核实？', presetKey: 'analyst', fixtureMarker: 'suite.rdas.example', residualDisclosure: '保留验收线程。', requireModel: true, state_asserts: [{ event: { action: 'ask.answer', field: 'decision.after.text', minLength: 10 } }] }] } };
const options = { manifest, bundleExists: true, presetKeys: new Set(['analyst']), suiteEntries: [{ path: 'acceptance/outcomes/industry.yaml', suite }], instanceSlug: 'example' };
const changed = (section, value) => ({ ...profile, [section]: value });
const errorsOf = (value, opts = options) => validateProfileContract(value, opts).errors.join(' ');

test('G14: raw, industry-bound profile and all declared outcome scenarios are structurally valid', () => {
  const result = validateProfileContract(profile, options);
  assert.deepEqual(result.errors, []); assert.equal(result.businessVerified, false); assert.equal(result.suiteCount, 1); assert.equal(result.taskCount, 3);
});
test('G14: defaults cannot conceal absent schema, surfaces, journeys or explicit environment', () => {
  for (const key of ['schemaVersion', 'surfaces', 'journeys', 'environment', 'ux', 'outcome']) { const missing = { ...profile }; delete missing[key]; assert.ok(errorsOf(missing).length, key); }
});
test('G14: repository, bundle, local workspace and human identity must match this product manifest', () => {
  for (const value of [changed('repo', 'workloom-ai/other'), changed('primaryBundle', 'other'), changed('identity', { workspaceSlug: 'other', human: 'MEM-001' }), changed('identity', { workspaceSlug: 'example-demo', human: 'MEM-other' })]) assert.match(errorsOf(value), /manifest/);
  assert.match(errorsOf(profile, { ...options, bundleExists: false }), /Bundle/);
});
test('G14: isolated instance declares its frozen source repository and cannot silently claim another instance', () => {
  const isolated = { ...profile, repositoryInstance: 'workloom-ai/isolate', isolation: { sourceProductRepository: manifest.repository, isolated: true } };
  assert.deepEqual(validateProfileContract(isolated, { ...options, instanceSlug: 'isolate' }).errors, []);
  assert.match(errorsOf(isolated), /repositoryInstance/); assert.match(errorsOf({ ...isolated, isolation: { sourceProductRepository: 'other', isolated: true } }, { ...options, instanceSlug: 'isolate' }), /isolation/);
});
test('G14 CI instance: trusted complete repository identity takes precedence over a legacy unit-test slug', () => {
  const isolated = { ...profile, repositoryInstance: 'reviewed-org/subgroup/isolate', isolation: { sourceProductRepository: manifest.repository, isolated: true } };
  const actual = { ...options, instanceRepository: isolated.repositoryInstance, instanceSlug: 'unrelated-directory' };
  const result = validateProfileContract(isolated, actual);
  assert.deepEqual(result.errors, []); assert.equal(result.businessVerified, false);
  assert.match(errorsOf(isolated, { ...actual, instanceRepository: 'other-org/subgroup/isolate' }), /repositoryInstance/);
  assert.match(errorsOf(isolated, { ...actual, instanceRepository: '' }), /repositoryInstance/);
  assert.match(errorsOf({ ...isolated, isolation: { sourceProductRepository: 'other-product', isolated: true } }, actual), /isolation/);
});
const adopted = { ...profile, repositoryInstance: manifest.repository, isolation: { isolated: true, sourceProductRepository: 'workloom-ai/Frozen-Source', sourceProductCommit: 'a6dc89a87e95eab86e202199335aecbf7fc4925b', adoptedProductRepository: manifest.repository, preserveSourceLineage: true } };
const adoptedOptions = { ...options, instanceRepository: manifest.repository };
test('G14 adopted identity: this isolated product keeps its frozen source and explicitly adopts its actual repository', () => {
  const result = validateProfileContract(adopted, adoptedOptions);
  assert.deepEqual(result.errors, []); assert.equal(result.businessVerified, false);
  assert.equal(adopted.isolation.sourceProductRepository, 'workloom-ai/Frozen-Source');
});
for (const [name, change] of [
  ['missing adoption', (p) => { delete p.isolation.adoptedProductRepository; }],
  ['wrong adoption', (p) => { p.isolation.adoptedProductRepository = 'workloom-ai/other'; }],
  ['missing source pin', (p) => { delete p.isolation.sourceProductCommit; }],
  ['abbreviated pin', (p) => { p.isolation.sourceProductCommit = 'a6dc89a'; }],
  ['non-hex pin', (p) => { p.isolation.sourceProductCommit = 'x'.repeat(40); }],
  ['zero pin', (p) => { p.isolation.sourceProductCommit = '0'.repeat(40); }],
  ['missing source', (p) => { delete p.isolation.sourceProductRepository; }],
  ['source URL', (p) => { p.isolation.sourceProductRepository = 'https://cnb.cool/workloom-ai/Frozen-Source'; }],
  ['source traversal', (p) => { p.isolation.sourceProductRepository = 'workloom-ai/../Frozen-Source'; }],
  ['rewritten source', (p) => { p.isolation.sourceProductRepository = manifest.repository; }],
  ['adoption removed and source rewritten', (p) => { delete p.isolation.adoptedProductRepository; p.isolation.sourceProductRepository = manifest.repository; }],
  ['missing preservation', (p) => { delete p.isolation.preserveSourceLineage; }],
  ['false preservation', (p) => { p.isolation.preserveSourceLineage = false; }],
  ['missing isolation', (p) => { delete p.isolation; }],
  ['disabled isolation', (p) => { p.isolation.isolated = false; }],
  ['missing instance', (p) => { delete p.repositoryInstance; }],
]) test(`G14 adopted identity: ${name} cannot silently erase frozen lineage or bypass instance binding`, () => {
  const value = structuredClone(adopted); change(value);
  assert.match(errorsOf(value, adoptedOptions), /isolation|repositoryInstance/);
});
test('G14 adopted identity: another actual origin, group or absent identity cannot be accepted', () => {
  for (const instanceRepository of ['workloom-ai/other', 'other-org/example', '', null]) {
    assert.match(errorsOf(adopted, { ...adoptedOptions, instanceRepository, instanceSlug: null }), /repositoryInstance|adoptedProductRepository/);
  }
});
test('G14: invalid ports, credentialed targets and undeclared production write residuals are rejected', () => {
  assert.match(errorsOf(changed('startup', { command: 'pnpm preview:all', ports: { pc: 0, bMobile: 3001, cMobile: 3002, server: 8787 } })), /ports/);
  const credentialed = new URL('https://example.test'); credentialed.username = 'user'; credentialed.password = ['mock', 'private'].join('-');
  assert.match(errorsOf(changed('environment', { kind: 'deployed', allowWrites: false, target: { apiUrl: credentialed.href } })), /target/);
  assert.match(errorsOf({ ...profile, outcome: { ...profile.outcome, fixtureMarker: '' }, environment: { ...profile.environment, allowWrites: true } }), /fixtureMarker/);
});
test('G14: absent role preset, empty substance and broken persona references fail configuration', () => {
  assert.match(errorsOf(changed('outcome', { ...profile.outcome, roles: [{ role: 'analyst', agentPreset: 'missing', al: 'AL3', deliverableUnit: '摘要', minSubstance: '' }] })), /preset|Substance/);
  assert.match(errorsOf(changed('journeys', [{ id: 'EXP-01', persona: 'unknown', title: '摘要', script: 'builtin:first-value' }])), /persona/);
});
test('G14: task suite declarations cannot be empty, escaping paths, missing files or silently unlisted files', () => {
  for (const taskSuites of [[], ['../industry.yaml'], ['acceptance/outcomes/missing.yaml']]) assert.match(errorsOf(changed('outcome', { ...profile.outcome, taskSuites })), /taskSuites|套件/);
  assert.match(errorsOf(profile, { ...options, suiteEntries: [...options.suiteEntries, { path: 'acceptance/outcomes/extra.yaml', suite }] }), /未声明/);
});
test('G14: empty and incomplete suites cannot pass profile validation', () => {
  for (const tasks of [[], [normal]]) assert.match(errorsOf(profile, { ...options, suiteEntries: [{ path: 'acceptance/outcomes/industry.yaml', suite: { ...suite, tasks } }] }), /tasks|failure|permission/);
});
test('G14: industry normal task must include P0 trials, own preset and actual result event', () => {
  for (const task of [{ ...normal, trials: 1 }, { ...normal, criticality: 'P1' }, { ...normal, event_asserts: [], thread_asserts: [] }]) assert.match(errorsOf(profile, { ...options, suiteEntries: [{ path: 'acceptance/outcomes/industry.yaml', suite: { ...suite, tasks: [task, ...suite.tasks.slice(1)] } }] }), /P0|结果断言/);
});
test('G14: live product contract cannot pass with only health HTTP or without model/fixture declaration', () => {
  const product = profile.live.tasks[0];
  for (const task of [{ ...product, state_asserts: [{ http: { url: '/health', status: 200 } }] }, { ...product, requireModel: false }, { ...product, fixtureMarker: 'absent-marker' }, { ...product, presetKey: 'missing' }]) assert.match(errorsOf(changed('live', { ...profile.live, tasks: [task] })), /live/);
});
test('G14: thresholds may tighten but cannot silently loosen or become nonnumeric', () => {
  assert.deepEqual(validateProfileContract(changed('thresholds', { firstValueMs: 10000 }), options).errors, []);
  for (const thresholds of [{ firstValueMs: 30000 }, { taskSuccessP0: 0.8 }, { minContrastRatio: 3 }, { traceClicks: '2' }]) assert.match(errorsOf(changed('thresholds', thresholds)), /thresholds/);
});
