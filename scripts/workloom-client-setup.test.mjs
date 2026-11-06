import assert from 'node:assert/strict';
import { execFile, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';
import { buildPlan, checkProfile, executeBoundVideo, PROFILE_SCHEMA, readProfile, renderClientConfig, validateProfile } from './workloom-client-setup.mjs';

const run = promisify(execFile);
const root = resolve(import.meta.dirname, '..');
const setup = join(root, 'scripts/workloom-client-setup.mjs');
const hash = value => createHash('sha256').update(value).digest('hex');
// Synthetic values exercise credential rejection without committing credential-shaped literals.
const token = ['fixture', 'member', 'session'].join('-');
const privateFixtureValue = ['fixture', 'private', 'value'].join('-');
const files = ['scripts/workloom-client-setup.mjs', 'scripts/workloom-video.mjs', 'scripts/agent-capabilities.mjs',
  'scripts/workloom-agent-mcp.mjs', 'packages/video-studio/src/cover-platforms.ts', 'packages/video-studio/src/unicode-text.mjs',
  'product.manifest.json', 'docs/AGENT-CLIENTS.md', 'docs/video-native-agent-entry.md'];

function fixture(t) {
  const base = realpathSync(mkdtempSync(join(tmpdir(), "growthtest client 中文 空格 ' \" $ ")));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const repo = join(base, 'repo');
  const jobs = join(base, 'jobs');
  mkdirSync(repo, { mode: 0o700 }); mkdirSync(jobs, { mode: 0o700 });
  for (const ref of files) { mkdirSync(dirname(join(repo, ref)), { recursive: true }); copyFileSync(join(root, ref), join(repo, ref)); }
  const git = args => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  git(['init', '-q']); git(['config', 'user.name', 'Client Fixture']); git(['config', 'user.email', 'client-fixture@example.invalid']);
  git(['remote', 'add', 'origin', 'https://github.com/geniusdapeng-collab/workloom-growthtest.git']);
  git(['add', '.']); git(['commit', '-qm', 'client fixture']);
  const profile = { schemaVersion: PROFILE_SCHEMA, repositoryRoot: repo, executorRoot: repo, executorCommit: git(['rev-parse', 'HEAD']),
    node: process.execPath, apiBase: 'http://127.0.0.1:1', scope: { instance: 'fixture-instance', tenantId: 'tenant-one',
      workspaceId: 'workspace-one', memberId: 'member-one', memberNo: 'MEM-G01' }, jobRoot: jobs, jobFile: join(jobs, 'original.json') };
  const profileFile = join(base, 'client-profile.json');
  const save = () => writeFileSync(profileFile, JSON.stringify(profile), { mode: 0o600 });
  save();
  return { base, repo, jobs, git, profile, profileFile, save };
}
async function server(t, f, { unknown = false, accessChange = {}, healthChange = {}, statusChange = {} } = {}) {
  const requests = [];
  const service = createServer(async (request, response) => {
    const chunks = []; for await (const chunk of request) chunks.push(chunk);
    requests.push({ url: request.url, method: request.method, body: Buffer.concat(chunks).toString() });
    let value;
    if (request.url === '/health') value = { ok: true, productId: 'workloom-ai-growth', desktopInstanceId: f.profile.scope.instance, sourceCommit: f.profile.executorCommit, ...healthChange };
    else {
      if (request.headers.authorization !== 'Bearer ' + token) { response.writeHead(401); response.end(JSON.stringify({ error: { message: 'denied' } })); return; }
      if (request.url === '/trpc/access.me') value = { schemaVersion: 'workloom.client-access/v1', authority: { source: 'server' },
        scope: { tenantId: f.profile.scope.tenantId, workspaceId: f.profile.scope.workspaceId }, subject: { kind: 'member', id: f.profile.scope.memberId, memberNo: f.profile.scope.memberNo },
        navigationPermissions: ['ai-video.assets.read'], actionPermissions: ['workspace.write'], ...accessChange };
      else if (request.url === '/trpc/video.studio.start') {
        if (unknown) { request.socket.destroy(); return; }
        value = { kind: 'routed', runId: 'RUN-1', projectId: 'VID-1', pipeline: 'marketing' };
      } else if (request.url.startsWith('/trpc/video.studio.status?')) value = { runId: 'RUN-1', projectId: 'VID-1', status: 'running', ...statusChange };
      else { response.writeHead(404); response.end('{}'); return; }
      value = { result: { data: value } };
    }
    response.writeHead(200, { 'content-type': 'application/json' }); response.end(JSON.stringify(value));
  });
  await new Promise(resolveListen => service.listen(0, '127.0.0.1', resolveListen));
  t.after(() => { service.closeAllConnections(); service.close(); });
  f.profile.apiBase = 'http://127.0.0.1:' + service.address().port; f.save();
  return requests;
}
function env() { return { ...process.env, WORKLOOM_ACCESS_TOKEN: token, WORKLOOM_DEV_AUTO_LOGIN: '0' }; }
function input(f) { const file = join(f.jobs, 'input.json'); writeFileSync(file, JSON.stringify({ intent: '用 GrowthTest 制作 30 秒咖啡产品视频，保持用户原话。', durationSec: 30 }), { mode: 0o600 }); return file; }
async function cli(f, args, extraEnv = {}) {
  try { const result = await run(process.execPath, [setup, ...args], { cwd: tmpdir(), env: { ...env(), ...extraEnv }, timeout: 20_000 }); return { ...result, code: 0 }; }
  catch (error) { return { stdout: error.stdout, stderr: error.stderr, code: error.code }; }
}

test('private profile and local plan bind exact checkout, Node, job and scope without a service call', async t => {
  const f = fixture(t);
  assert.deepEqual(await readProfile(f.profileFile), f.profile);
  const local = await checkProfile(f.profile);
  assert.equal(local.localReady, true); assert.equal(local.connected, false); assert.equal(local.clientCommit, f.profile.executorCommit);
  const plan = await buildPlan(f.profile, f.profileFile);
  assert.deepEqual(plan.commands.status.slice(-2), ['--', 'status']); assert.equal(plan.connected, false);
  const result = await cli(f, ['check', '--profile', f.profileFile], { WORKLOOM_ACCESS_TOKEN: '' });
  assert.equal(result.code, 0, result.stderr); assert.equal(JSON.parse(result.stdout).connected, false);
});

test('profile refuses unknown credential fields, guest, unsafe URL and shell launcher shape', () => {
  const minimal = { schemaVersion: PROFILE_SCHEMA, repositoryRoot: '/repo', executorRoot: '/repo', executorCommit: 'a'.repeat(40), node: '/node',
    apiBase: 'http://127.0.0.1:1', scope: { instance: 'i', tenantId: 't', workspaceId: 'w', memberId: 'm', memberNo: 'M1' }, jobRoot: '/jobs', jobFile: '/jobs/job.json' };
  for (const mutate of [p => { p.token = privateFixtureValue; }, p => { p.scope.memberNo = 'GUEST'; }, p => {
    const address = new URL('https://example.invalid'); address.username = 'fixture-user'; address.password = privateFixtureValue; p.apiBase = address.href;
  },
    p => { p.launcher = { command: 'sh -c run' }; }, p => { p.jobFile = '/other/job.json'; }, p => { p.node = 'node'; }]) {
    const p = structuredClone(minimal); mutate(p); assert.throws(() => validateProfile(p));
  }
});

test('missing profile, public permissions, malformed JSON and symlink profile fail closed', async t => {
  const f = fixture(t);
  await assert.rejects(readProfile(join(f.base, 'absent')), { code: 'PROFILE_UNAVAILABLE' });
  chmodSync(f.profileFile, 0o644); await assert.rejects(readProfile(f.profileFile), { code: 'PROFILE_UNAVAILABLE' }); chmodSync(f.profileFile, 0o600);
  writeFileSync(f.profileFile, '{'); await assert.rejects(readProfile(f.profileFile), { code: 'PROFILE_INVALID' }); f.save();
  const alias = join(f.base, 'alias'); symlinkSync(f.profileFile, alias); await assert.rejects(readProfile(alias), { code: 'PROFILE_UNAVAILABLE' });
});

test('wrong remote, changed executor, missing entry and public job root are rejected locally', async t => {
  const f = fixture(t);
  f.git(['remote', 'set-url', 'origin', 'https://github.com/other/workloom-growthtest']);
  await assert.rejects(checkProfile(f.profile), { code: 'CHECKOUT_INVALID' });
  f.git(['remote', 'set-url', 'origin', 'https://github.com/geniusdapeng-collab/workloom-growthtest']);
  await assert.rejects(checkProfile({ ...f.profile, executorCommit: 'b'.repeat(40) }), { code: 'EXECUTOR_COMMIT_MISMATCH' });
  chmodSync(f.jobs, 0o755); await assert.rejects(checkProfile(f.profile), { code: 'JOB_ROOT_NOT_PRIVATE' }); chmodSync(f.jobs, 0o700);
  rmSync(join(f.repo, 'scripts/workloom-agent-mcp.mjs')); f.git(['add', '-u']); f.git(['commit', '-qm', 'remove fixture entry']); f.profile.executorCommit = f.git(['rev-parse', 'HEAD']);
  await assert.rejects(checkProfile(f.profile), { code: 'ENTRY_UNAVAILABLE' });
});

test('Codex TOML preserves bytes and quotes paths; Qoder JSON preserves unrelated user configuration', t => {
  const f = fixture(t);
  const old = 'model = "existing-model"\n# keep this comment\n[mcp_servers.other]\ncommand = "node"\n';
  const toml = renderClientConfig(f.profile, 'codex', old);
  assert.ok(toml.startsWith(old));
  const stanza = toml.slice(toml.indexOf('[mcp_servers.workloom_growthtest_readonly]'));
  const argumentArray = JSON.parse(/^args = (.*)$/mu.exec(stanza)[1]);
  assert.deepEqual(argumentArray, [join(f.repo, 'scripts/workloom-agent-mcp.mjs')]);
  assert.equal(JSON.parse(/^cwd = (.*)$/mu.exec(stanza)[1]), f.repo);
  const qoder = JSON.parse(renderClientConfig(f.profile, 'qoder-cli', JSON.stringify({ ui: { theme: 'dark' }, mcpServers: { other: { command: '/node', args: [] } } })));
  assert.equal(qoder.ui.theme, 'dark'); assert.equal(qoder.mcpServers.other.command, '/node'); assert.equal(qoder.mcpServers.workloom_growthtest_readonly.cwd, f.repo);
  assert.equal(qoder.enableAllProjectMcpServers, undefined); assert.equal(qoder.mcpServers.workloom_growthtest_readonly.alwaysAllow, undefined);
});

test('config collisions, malformed existing settings and secret fields reject without disclosing values', t => {
  const f = fixture(t);
  for (const [client, existing, code] of [['codex', '[mcp_servers."workloom_growthtest_readonly"]\ncommand="node"', 'CONFIG_COLLISION'],
    ['qoder-cli', '{"mcpServers":{"workloom_growthtest_readonly":{}}}', 'CONFIG_COLLISION'], ['qoder-cli', '{', 'CONFIG_INVALID'],
    ['qoder-cli', '{"mcpServers":[]}', 'CONFIG_INVALID'], ['codex', 'api_key' + '=' + JSON.stringify(privateFixtureValue), 'CONFIG_CONTAINS_SECRET'],
    ['qoder-cli', JSON.stringify({ mcpServers: { other: { headers: { Authorization: privateFixtureValue } } } }), 'CONFIG_CONTAINS_SECRET']]) {
    assert.throws(() => renderClientConfig(f.profile, client, existing), error => error.code === code && !error.message.includes(privateFixtureValue));
  }
});

test('explicit config output is private, preserves configuration, and stdout contains only receipt/hash', async t => {
  const f = fixture(t); const config = join(f.base, 'settings.json');
  writeFileSync(config, '{"ui":{"theme":"dark"}}', { mode: 0o600 });
  const result = await cli(f, ['config', '--profile', f.profileFile, '--client', 'qoder-cli', '--existing', config, '--out', config]);
  assert.equal(result.code, 0, result.stderr);
  assert.equal(JSON.parse(readFileSync(config)).ui.theme, 'dark');
  assert.equal(JSON.parse(result.stdout).sha256, hash(readFileSync(config)));
  assert.ok(!result.stdout.includes('theme'));
  assert.equal(statSync(config).mode & 0o077, 0);
  const again = await cli(f, ['config', '--profile', f.profileFile, '--client', 'qoder-cli', '--existing', config, '--out', config]);
  assert.equal(again.code, 4); assert.match(again.stderr, /CONFIG_COLLISION/);
  const secret = join(f.base, 'secret.json'); writeFileSync(secret, JSON.stringify({ token: privateFixtureValue }), { mode: 0o600 });
  const denied = await cli(f, ['config', '--profile', f.profileFile, '--client', 'qoder-cli', '--existing', secret, '--out', join(f.base, 'candidate.json')]);
  assert.equal(denied.code, 4); assert.ok(!JSON.stringify(denied).includes(privateFixtureValue));
});

test('real loopback start preserves original intent; doctor reuses exact job and never POSTs again', async t => {
  const f = fixture(t); const requests = await server(t, f); const requestFile = input(f);
  const result = await executeBoundVideo(f.profile, ['start', '--input-file', requestFile], { env: env() });
  assert.equal(result.exitCode, 0); assert.equal(result.value.connected, true);
  assert.equal(result.value.result.projectId, 'VID-1');
  assert.equal(JSON.parse(requests.find(r => r.method === 'POST').body).intent, JSON.parse(readFileSync(requestFile)).intent);
  const doctor = await cli(f, ['doctor', '--profile', f.profileFile]);
  assert.equal(doctor.code, 0, doctor.stderr); assert.equal(JSON.parse(doctor.stdout).result.phase, 'preproduction_running');
  assert.equal(requests.filter(r => r.method === 'POST').length, 1);
  assert.equal(JSON.parse(readFileSync(f.profile.jobFile)).binding.commit, f.profile.executorCommit);
});

test('unknown start persists original reservation; retry and replacement job refuse without another POST', async t => {
  const f = fixture(t); const requests = await server(t, f, { unknown: true });
  const initial = await executeBoundVideo(f.profile, ['start', '--input-file', input(f)], { env: env() });
  assert.equal(initial.exitCode, 7); assert.equal(initial.value.result.phase, 'start_unknown');
  await assert.rejects(executeBoundVideo(f.profile, ['start', '--input-file', input(f)], { env: env() }), { code: 'JOB_ALREADY_EXISTS' });
  await assert.rejects(executeBoundVideo(f.profile, ['start', '--job-file', 'replacement.json', '--input-file', input(f)], { env: env() }), { code: 'JOB_BINDING_MISMATCH' });
  const status = await executeBoundVideo(f.profile, ['status'], { env: env() });
  assert.equal(status.value.result.phase, 'start_unknown'); assert.equal(requests.filter(r => r.method === 'POST').length, 1);
  const doctor = await cli(f, ['doctor', '--profile', f.profileFile]);
  assert.equal(doctor.code, 0, doctor.stderr); assert.equal(JSON.parse(doctor.stdout).connected, true);
  assert.equal(JSON.parse(doctor.stdout).jobStatusExitCode, 7); assert.equal(JSON.parse(doctor.stdout).result.phase, 'start_unknown');
});

test('doctor reports a connected failed business job separately while video status preserves exit 7', async t => {
  const f = fixture(t); const requests = await server(t, f, { statusChange: { status: 'failed', error: 'fixture business gate failed' } });
  await executeBoundVideo(f.profile, ['start', '--input-file', input(f)], { env: env() });
  const doctor = await cli(f, ['doctor', '--profile', f.profileFile]);
  const value = JSON.parse(doctor.stdout);
  assert.equal(doctor.code, 0, doctor.stderr); assert.equal(value.connected, true); assert.equal(value.jobStatusExitCode, 7);
  assert.equal(value.result.phase, 'preproduction_failed');
  const status = await cli(f, ['video', '--profile', f.profileFile, '--', 'status']);
  assert.equal(status.code, 7); assert.equal(JSON.parse(status.stdout).result.phase, 'preproduction_failed');
  assert.equal(requests.filter(r => r.method === 'POST').length, 1);
});

test('default environment profile, missing Node and explicit candidate collision have typed errors', async t => {
  const f = fixture(t);
  const local = await cli(f, ['check'], { WORKLOOM_GROWTHTEST_PROFILE: f.profileFile });
  assert.equal(local.code, 0, local.stderr);
  await assert.rejects(checkProfile({ ...f.profile, node: join(f.base, 'missing-node') }), { code: 'NODE_UNAVAILABLE' });
  const out = join(f.base, 'candidate.json'); writeFileSync(out, 'keep', { mode: 0o600 });
  const collision = await cli(f, ['config', '--profile', f.profileFile, '--client', 'qoder-cli', '--out', out]);
  assert.equal(collision.code, 4); assert.equal(readFileSync(out, 'utf8'), 'keep');
  const existing = join(f.base, 'existing.json'); writeFileSync(existing, '{"theme":"keep"}', { mode: 0o600 });
  const noOut = await cli(f, ['config', '--profile', f.profileFile, '--client', 'qoder-cli', '--existing', existing]);
  assert.equal(noOut.code, 4); assert.ok(!noOut.stdout.includes('theme'));
});

test('simultaneous starts retain the official CLI exclusive reservation and only one POST', async t => {
  const f = fixture(t); const requests = await server(t, f); const requestFile = input(f);
  const results = await Promise.allSettled([1, 2].map(() => executeBoundVideo(f.profile, ['start', '--input-file', requestFile], { env: env() })));
  assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
  assert.equal(requests.filter(r => r.method === 'POST').length, 1);
});

for (const [name, options, code] of [
  ['service source', { healthChange: { sourceCommit: 'f'.repeat(40) } }, 'RUNTIME_SOURCE_MISMATCH'],
  ['service instance', { healthChange: { desktopInstanceId: 'wrong-instance' } }, 'RUNTIME_IDENTITY_MISMATCH'],
  ['member identity', { accessChange: { subject: { kind: 'member', id: 'other-member', memberNo: 'MEM-G01' } } }, 'ACCESS_SCOPE_MISMATCH'],
  ['workspace', { accessChange: { scope: { tenantId: 'tenant-one', workspaceId: 'wrong-workspace' } } }, 'ACCESS_SCOPE_MISMATCH'],
  ['read permission', { accessChange: { navigationPermissions: [] } }, 'ACCESS_SCOPE_MISMATCH'],
  ['write permission', { accessChange: { actionPermissions: [] } }, 'WRITE_PERMISSION_REQUIRED'],
]) test(`real service rejects mismatched ${name} before any production POST`, async t => {
  const f = fixture(t); const requests = await server(t, f, options);
  await assert.rejects(executeBoundVideo(f.profile, ['start', '--input-file', input(f)], { env: env() }), { code });
  assert.equal(requests.filter(r => r.method === 'POST').length, 0);
});

test('missing member session, output escape and symlink directory refuse safely', async t => {
  const f = fixture(t); await server(t, f);
  await assert.rejects(executeBoundVideo(f.profile, ['start', '--input-file', input(f)], { env: {} }), { code: 'MEMBER_SESSION_REQUIRED' });
  await executeBoundVideo(f.profile, ['start', '--input-file', input(f)], { env: env() });
  await assert.rejects(executeBoundVideo(f.profile, ['prompts', '--out', '../escape.json'], { env: env() }), { code: 'JOB_PATH_INVALID' });
  symlinkSync(f.base, join(f.jobs, 'outside'), 'dir');
  await assert.rejects(executeBoundVideo(f.profile, ['prompts', '--out', 'outside/escape.json'], { env: env() }), { code: 'JOB_PATH_INVALID' });
  const saved = JSON.parse(readFileSync(f.profile.jobFile)); saved.binding.commit = 'f'.repeat(40); writeFileSync(f.profile.jobFile, JSON.stringify(saved));
  await assert.rejects(executeBoundVideo(f.profile, ['status'], { env: env() }), { code: 'JOB_SCOPE_MISMATCH' });
});

test('authorized pinned launcher supplies ephemeral member session; hash, writable permission and secret stdout fail', async t => {
  const f = fixture(t); await server(t, f); await executeBoundVideo(f.profile, ['start', '--input-file', input(f)], { env: env() });
  const launcher = join(f.base, 'with-member.mjs');
  const source = `import {spawn} from 'node:child_process';\nconst p=spawn(process.argv[2],process.argv.slice(3),{env:{...process.env,WORKLOOM_ACCESS_TOKEN:'${token}'},stdio:'inherit'});\np.on('exit',c=>process.exitCode=c??7);\np.on('error',()=>process.exitCode=7);\n`;
  writeFileSync(launcher, source, { mode: 0o600 }); f.profile.launcher = { script: launcher, sha256: hash(source) }; f.save();
  const result = await cli(f, ['doctor', '--profile', f.profileFile], { WORKLOOM_ACCESS_TOKEN: '' });
  assert.equal(result.code, 0, result.stderr); assert.equal(JSON.parse(result.stdout).connected, true);
  writeFileSync(launcher, source + '\n'); await assert.rejects(checkProfile(f.profile), { code: 'LAUNCHER_UNTRUSTED' });
  writeFileSync(launcher, source); chmodSync(launcher, 0o666); await assert.rejects(checkProfile(f.profile), { code: 'LAUNCHER_UNTRUSTED' });
  chmodSync(launcher, 0o600); const bad = "console.log('fixture-secret-output')"; writeFileSync(launcher, bad); f.profile.launcher.sha256 = hash(bad); f.save();
  const denied = await cli(f, ['doctor', '--profile', f.profileFile], { WORKLOOM_ACCESS_TOKEN: '' });
  assert.equal(denied.code, 7); assert.ok(!JSON.stringify(denied).includes('fixture-secret-output'));
});
