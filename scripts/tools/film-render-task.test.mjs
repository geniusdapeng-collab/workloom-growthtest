import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, writeFileSync, rmSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { readResumeTasks, runFilmRenderTask } from './film-render-task.mjs';
import { productionStatus } from '../../bundles/geo-growth/capabilities/video.mjs';

const expected = { model: 'test-model', duration: 5, resolution: '1080p', ratio: '9:16' };
const result = (extra = {}) => ({ id: 'cgt-existing', status: 'succeeded', ...expected,
  content: { video_url: 'https://provider.test/video', last_frame_url: 'https://provider.test/frame' }, ...extra });
const response = (value, status = 200) => new Response(JSON.stringify(value), { status });
function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'film-render-test-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return { dir, options: { baseUrl: 'https://provider.test/api', apiKey: 'mock-test-only-key',
    body: { ...expected, content: [{ text: 'private-reference' }] }, expected,
    journalFile: join(dir, 'task.json'), sleep: async () => {} } };
}

test('explicit resume uses GET only and validates provider metadata', async (t) => {
  const { options } = fixture(t), methods = [];
  const value = await runFilmRenderTask({ ...options, resumeTaskId: 'cgt-existing', fetchImpl: async (_url, init) => {
    methods.push(init.method ?? 'GET'); return response(result());
  } });
  assert.equal(value.resumed, true); assert.deepEqual(methods, ['GET']);
  const saved = readFileSync(options.journalFile, 'utf8');
  assert(!saved.includes(options.apiKey) && !saved.includes('provider.test/video') && !saved.includes('private-reference'));
});

test('acceptance is persisted before first poll and automatic continuation sends no POST', async (t) => {
  const { options } = fixture(t), methods = [];
  const fetchImpl = async (_url, init) => {
    methods.push(init.method ?? 'GET');
    if (init.method === 'POST') return response({ id: 'cgt-existing' });
    assert.equal(JSON.parse(readFileSync(options.journalFile, 'utf8')).taskId, 'cgt-existing');
    return response(result());
  };
  assert.equal((await runFilmRenderTask({ ...options, fetchImpl })).resumed, false);
  assert.equal((await runFilmRenderTask({ ...options, fetchImpl })).resumed, true);
  assert.deepEqual(methods, ['POST', 'GET', 'GET']);
});

test('a denied beforeSubmit gate causes zero I/O and creates no unknown-outcome journal', async (t) => {
  const { options } = fixture(t); let calls = 0;
  await assert.rejects(runFilmRenderTask({ ...options,
    beforeSubmit: () => { throw new Error('CHARACTER_CANARY_BLOCKED'); },
    fetchImpl: async (_url, init) => { calls++; return response(init.method === 'POST' ? { id: 'cgt-existing' } : result()); },
  }), /CHARACTER_CANARY_BLOCKED/);
  assert.equal(calls, 0); assert.equal(existsSync(options.journalFile), false);
});

test('an accepted task resumes without a new-submit gate; its local input binding remains verifiable', async (t) => {
  const { options } = fixture(t); let gates = 0;
  const fetchImpl = async (_url, init) => response(init.method === 'POST' ? { id: 'cgt-existing' } : result());
  const first = await runFilmRenderTask({ ...options, beforeSubmit: () => { gates++; }, fetchImpl });
  assert.equal(first.requestInputVerified, true);
  const resumed = await runFilmRenderTask({ ...options, beforeSubmit: () => { throw new Error('must not guard GET'); }, fetchImpl });
  assert.equal(resumed.requestInputVerified, true); assert.equal(gates, 1);
});

test('explicit provider recovery retrieves bytes without claiming that its new prompt was submitted', async (t) => {
  const { options } = fixture(t);
  const resumed = await runFilmRenderTask({ ...options, resumeTaskId: 'cgt-existing',
    beforeSubmit: () => { throw new Error('must not guard GET'); }, fetchImpl: async (_url, init) => {
      assert.notEqual(init.method, 'POST'); return response(result());
    } });
  assert.equal(resumed.requestInputVerified, false);
  const again = await runFilmRenderTask({ ...options, fetchImpl: async () => response(result()) });
  assert.equal(again.requestInputVerified, false);
});

test('four failed GETs preserve the task and recovery cannot pay twice', async (t) => {
  const { options } = fixture(t), methods = [];
  await assert.rejects(runFilmRenderTask({ ...options, fetchImpl: async (_url, init) => {
    methods.push(init.method ?? 'GET');
    if (init.method === 'POST') return response({ id: 'cgt-existing' });
    throw new TypeError('fetch failed');
  } }), /POLL_NETWORK_FAILED/);
  await runFilmRenderTask({ ...options, fetchImpl: async (_url, init) => {
    methods.push(init.method ?? 'GET'); return response(result());
  } });
  assert.equal(methods.filter((method) => method === 'POST').length, 1);
  assert.equal(methods.filter((method) => method === 'GET').length, 5);
});

test('unknown POST outcome blocks subsequent submissions until provider ID is supplied', async (t) => {
  const { options } = fixture(t); let calls = 0;
  const fetchImpl = async () => { calls++; throw new TypeError('connection reset after POST'); };
  await assert.rejects(runFilmRenderTask({ ...options, fetchImpl }), /connection reset/);
  await assert.rejects(runFilmRenderTask({ ...options, fetchImpl }), /OUTCOME_UNKNOWN/);
  assert.equal(calls, 1);
  await runFilmRenderTask({ ...options, resumeTaskId: 'cgt-existing', fetchImpl: async (_url, init) => {
    assert.equal(init.method, undefined); return response(result());
  } });
});

test('two concurrent processes cannot submit the same shot twice', async (t) => {
  const { options } = fixture(t); let posts = 0;
  const fetchImpl = async (_url, init) => {
    if (init.method === 'POST') { posts++; await Promise.resolve(); return response({ id: 'cgt-existing' }); }
    return response(result());
  };
  const values = await Promise.allSettled([runFilmRenderTask({ ...options, fetchImpl }), runFilmRenderTask({ ...options, fetchImpl })]);
  assert.equal(posts, 1); assert.equal(values.filter((value) => value.status === 'fulfilled').length, 1);
});

test('resume rejects each mismatched or missing provider specification without POST', async (t) => {
  for (const key of ['model', 'duration', 'resolution', 'ratio', 'id']) {
    const { options } = fixture(t);
    await assert.rejects(runFilmRenderTask({ ...options, resumeTaskId: 'cgt-existing', fetchImpl: async (_url, init) => {
      assert.notEqual(init.method, 'POST'); return response(result({ [key]: undefined }));
    } }), /MISMATCH/);
  }
});

test('failed, cancelled, expired and malformed success cannot be approved', async (t) => {
  for (const status of ['failed', 'cancelled', 'expired', 'invented-status', 'succeeded']) {
    const { options } = fixture(t);
    await assert.rejects(runFilmRenderTask({ ...options, resumeTaskId: 'cgt-existing', fetchImpl: async () =>
      response(result({ status, content: {} })) }), /RENDER_TASK/);
  }
});

test('poll HTTP permissions fail closed while transient HTTP can recover', async (t) => {
  const { options } = fixture(t); let calls = 0;
  await runFilmRenderTask({ ...options, resumeTaskId: 'cgt-existing', fetchImpl: async () =>
    ++calls === 1 ? response({}, 503) : response(result()) });
  await assert.rejects(runFilmRenderTask({ ...options, fetchImpl: async () => response({}, 403) }), /HTTP_403/);
});

test('pending timeout keeps accepted task for later recovery', async (t) => {
  const { options } = fixture(t); let time = 0;
  await assert.rejects(runFilmRenderTask({ ...options, resumeTaskId: 'cgt-existing', timeoutMs: 1,
    now: () => time, sleep: async () => { time += 10; }, fetchImpl: async () => response(result({ status: 'running' })) }), /POLL_TIMEOUT/);
  assert.equal(JSON.parse(readFileSync(options.journalFile, 'utf8')).taskId, 'cgt-existing');
});

test('changed request and conflicting task map cannot reuse or create a task', async (t) => {
  const { options } = fixture(t);
  await runFilmRenderTask({ ...options, resumeTaskId: 'cgt-existing', fetchImpl: async () => response(result()) });
  const fetchImpl = async () => assert.fail('no network request permitted');
  await assert.rejects(runFilmRenderTask({ ...options, body: {}, fetchImpl }), /REQUEST_CHANGED/);
  await assert.rejects(runFilmRenderTask({ ...options, resumeTaskId: 'cgt-other', fetchImpl }), /JOURNAL_CONFLICT/);
});

test('unwritable journal fails before paid POST', async (t) => {
  const { options } = fixture(t); mkdirSync(options.journalFile);
  await assert.rejects(runFilmRenderTask({ ...options, fetchImpl: async () => assert.fail('must not POST') }));
});

test('mapping validates empty, duplicate, unknown, traversal and malformed input', (t) => {
  const { dir } = fixture(t), file = join(dir, 'map.json');
  assert.deepEqual(readResumeTasks('', ['GT-01']), {});
  writeFileSync(file, JSON.stringify({ 'GT-01': 'cgt-existing' }));
  assert.deepEqual(readResumeTasks(file, ['GT-01']), { 'GT-01': 'cgt-existing' });
  for (const value of [[], null, { 'GT-99': 'cgt-existing' }, { 'GT-01': '' }, { 'GT-01': '../private' },
    { 'GT-01': 'cgt-existing', 'GT-02': 'cgt-existing' }]) {
    writeFileSync(file, JSON.stringify(value)); assert.throws(() => readResumeTasks(file, ['GT-01', 'GT-02']), /MAP_INVALID/);
  }
  writeFileSync(file, '{'); assert.throws(() => readResumeTasks(file, ['GT-01']), SyntaxError);
});

test('Codex production status does not count cached or resumed verification as paid submission', (t) => {
  const { dir } = fixture(t), previous = process.env.WORKLOOM_VIDEO_ARTIFACT_ROOT;
  process.env.WORKLOOM_VIDEO_ARTIFACT_ROOT = dir;
  t.after(() => { if (previous === undefined) delete process.env.WORKLOOM_VIDEO_ARTIFACT_ROOT; else process.env.WORKLOOM_VIDEO_ARTIFACT_ROOT = previous; });
  const logs = join(dir, 'work/logs/VID-TEST'); mkdirSync(logs, { recursive: true });
  const rows = [
    { stage: 'shot', invoked: true, ok: false, evidence: { taskId: 'cgt-existing' } },
    { stage: 'shot', invoked: true, ok: true, cached: true },
    { stage: 'material-gen', invoked: true, ok: true, evidence: { resumed: true } },
    { stage: 'shot', invoked: true, ok: false, evidence: { error: 'AccountOverdue' } },
    { stage: 'shot', invoked: true, ok: false, evidence: { error: 'CANARY_ABORT: stop' } }
  ];
  writeFileSync(join(logs, 'stages.jsonl'), rows.map((row) => JSON.stringify(row)).join('\n') + '\n');
  assert.deepEqual(productionStatus({ projectId: 'VID-TEST', workDir: 'work' }).renderLedger,
    { renderAttempts: 1, rendersRejected: 1, platformRejections: 1, canaryAborts: 1 });
});
