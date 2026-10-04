import test from 'node:test';
import assert from 'node:assert/strict';
import { assertQuestExecution } from './release-gate-quest.ts';

const completed = { kind: 'routed', mode: 'quest', threadId: 'TH-fixture', status: 'completed', stepsTotal: 3, stepsDone: 3 };
const thread = { id: 'TH-fixture', status: 'completed' };

test('完成三个步骤且线程事实一致时通过', () => {
  assert.match(assertQuestExecution(completed, thread), /已执行 3 步/);
});
test('已实际执行一步的运行态通过', () => {
  assert.match(assertQuestExecution({ ...completed, status: 'running', stepsDone: 1 }, { ...thread, status: 'running' }), /running/);
});
test('已有执行进度及审批回执的 pending_review 通过', () => {
  assert.match(assertQuestExecution({ ...completed, status: 'pending_review', stepsDone: 1, pendingApprovalId: 'AP-fixture' }, { ...thread, status: 'pending_review' }), /pending_review/);
});
test('实际发现的 failed / 0 步不得被创建和拆解结果放行', () => {
  assert.throws(() => assertQuestExecution({ ...completed, status: 'failed', stepsDone: 0, error: '步骤 s1 无回执，未核实' }, { ...thread, status: 'failed' }), /没有有效执行进度/);
});
test('failed / cancelled / queued 即使伪报进度也拒绝', () => {
  for (const status of ['failed', 'cancelled', 'queued']) assert.throws(() => assertQuestExecution({ ...completed, status }, { ...thread, status }), /任务状态/);
});
test('无有效步数、超总数及非整数拒绝', () => {
  for (const stepsDone of [undefined, 0, -1, 4, 1.5, NaN]) assert.throws(() => assertQuestExecution({ ...completed, stepsDone }, thread), /有效执行进度/);
});
test('未按多步骤 quest 路由或没有线程拒绝', () => {
  for (const patch of [{ mode: 'ask' }, { kind: 'rejected' }, { threadId: '' }, { stepsTotal: 1 }, { stepsTotal: 2.5 }]) {
    assert.throws(() => assertQuestExecution({ ...completed, ...patch }, thread), /QUEST 未通过/);
  }
  assert.throws(() => assertQuestExecution(completed, null), /线程回读失败/);
});
test('线程 ID 或回读状态不一致拒绝', () => {
  assert.throws(() => assertQuestExecution(completed, { ...thread, id: 'TH-other' }), /线程回读失败/);
  assert.throws(() => assertQuestExecution(completed, { ...thread, status: 'failed' }), /状态不一致/);
});
test('完成状态却少步骤、或存在未核实动作拒绝', () => {
  assert.throws(() => assertQuestExecution({ ...completed, stepsDone: 2 }, thread), /步数不一致/);
  assert.throws(() => assertQuestExecution({ ...completed, unverified: ['s1'] }, thread), /未核实步骤/);
});
test('pending_review 必须有非空审批回执', () => {
  for (const pendingApprovalId of [undefined, '', ' ']) {
    assert.throws(() => assertQuestExecution({ ...completed, status: 'pending_review', stepsDone: 1, pendingApprovalId }, { ...thread, status: 'pending_review' }), /没有审批回执/);
  }
});
