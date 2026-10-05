import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildFilmRenderLedger, isAcceptedFilmTaskId } from './film-render-ledger.mjs';

test('only accepted task IDs count, once across retries, resume and cached observations', () => {
  const history = [
    {stage: 'shot', shotId: 'S-01', invoked: true, ok: false, evidence: {taskId: 'cgt-1', error: 'download failed'}},
    {stage: 'shot', shotId: 'S-01', invoked: true, ok: false, evidence: {taskId: 'cgt-1', resumed: true}},
    {stage: 'shot', shotId: 'S-01', invoked: false, cached: true, ok: true, evidence: {taskId: 'cgt-1'}},
    {stage: 'material-gen', shotId: 'S-02', invoked: true, ok: false, evidence: {taskId: 'cgt-2'}, verdict: {hardFailures: ['motion failed']}},
    {stage: 'material-gen', shotId: 'S-02', invoked: true, ok: false, evidence: {taskId: 'cgt-2'}},
    {stage: 'shot', shotId: 'S-03', invoked: true, ok: false, evidence: {error: 'AccountOverdueError'}},
    {stage: 'shot', shotId: 'S-03', invoked: true, ok: false, evidence: {error: 'CANARY_ABORT: stop'}},
    {stage: 'shot', shotId: 'S-04', invoked: true, ok: true},
    {stage: 'shot', shotId: 'S-04', invoked: true, ok: false, evidence: {taskId: '../fake'}},
  ];
  const original = JSON.stringify(history);
  const ledger = buildFilmRenderLedger(history, {projectId: 'VID-X', generatedAt: '2026-10-05T00:00:00Z'});
  assert.deepEqual(ledger.totals, {renderAttempts: 2, rendersRejected: 1, platformRejections: 1, canaryAborts: 1, postStageRetries: 0});
  assert.deepEqual(ledger.acceptedTaskIds, ['cgt-1', 'cgt-2']);
  assert.equal(ledger.unacceptedRenderRecords, 2);
  assert.equal(ledger.projectId, 'VID-X');
  assert.equal(ledger.generatedAt, '2026-10-05T00:00:00Z');
  assert.equal(JSON.stringify(history), original);
});

test('cached-only acceptance remains recorded and contradictory shot assignment is exposed', () => {
  const ledger = buildFilmRenderLedger([
    {stage: 'shot', shotId: 'S-01', cached: true, ok: true, evidence: {taskId: 'cgt-cached'}},
    {stage: 'shot', shotId: 'S-02', invoked: true, ok: true, evidence: {taskId: 'cgt-cached'}},
  ]);
  assert.equal(ledger.totals.renderAttempts, 1);
  assert.equal(ledger.shots[0].attempts, 1);
  assert.equal(ledger.warnings.length, 1);
});

test('post-stage failures are counted without turning skipped, cached or unknown statuses into retries', () => {
  const ledger = buildFilmRenderLedger([
    {stage: 'bgm', invoked: true, ok: false, evidence: {error: 'mix failed'}},
    {stage: 'bgm', invoked: true, ok: false, cached: true},
    {stage: 'cover', invoked: false, ok: false},
    {stage: 'deliver', invoked: true, ok: null},
    {stage: 'cover', invoked: true, ok: false, note: 'missing frame'},
    {stage: 'unknown', invoked: true, ok: false, evidence: {taskId: 'cgt-ignore'}},
  ]);
  assert.equal(ledger.totals.postStageRetries, 2);
  assert.equal(ledger.totals.renderAttempts, 0);
  assert.deepEqual(ledger.postStages.map(row => row.stage), ['bgm', 'cover']);
});

test('malformed histories and invalid task IDs fail closed', () => {
  for (const value of [null, {}, [null], ['bad'], [[]]]) assert.throws(() => buildFilmRenderLedger(value), /RENDER_LEDGER_HISTORY_INVALID/);
  for (const id of [null, '', 'a/b', 'a b', '\nabc', 'a'.repeat(129)]) assert.equal(isAcceptedFilmTaskId(id), false);
  assert.equal(isAcceptedFilmTaskId('cgt-20261005_abc'), true);
  assert.equal(buildFilmRenderLedger([]).totals.renderAttempts, 0);
});
