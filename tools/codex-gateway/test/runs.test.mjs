import { test } from "node:test";
import assert from "node:assert/strict";
import { appendFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveRepoRoot } from "../src/paths.mjs";
import { generateCatalog } from "../src/catalog.mjs";
import { createStore } from "../src/store.mjs";
import { createFakePolicy } from "../src/policy-client.mjs";
import { createRunService } from "../src/runs.mjs";

const repoRoot = resolveRepoRoot();
const catalog = generateCatalog({ repoRoot });

function makeService(verdicts = {}, { approvalTtlMs } = {}) {
  const dataDir = mkdtempSync(join(tmpdir(), "workloom-gw-"));
  const store = createStore({ dataDir });
  const policy = createFakePolicy(verdicts);
  const service = createRunService({ repoRoot, catalog, store, policy, approvalTtlMs });
  return { service, store, dataDir };
}

test("review 流程：挂起 → 批准 → 模拟执行 → 回执 → 账本验链", async () => {
  const { service, store } = makeService();
  const started = await service.startRun({ capabilityId: "pipeline:dual-content-factory", action: "publish.execute", objectType: "publish_task", context: { account_daily_published: 0 } });
  assert.equal(started.run.state, "waiting_approval");
  assert.ok(started.approval, "应生成审批卡");
  assert.equal(store.listApprovals({ status: "pending" }).length, 1);

  const decided = await service.decideApproval({ approvalId: started.approval.approvalId, gesture: { type: "approve" } });
  assert.equal(decided.approval.status, "approved");
  assert.equal(decided.run.state, "completed");
  assert.equal(decided.run.receipt.synced, true);
  assert.match(decided.run.receipt.snapshot_uri, /^workloom-sim:\/\//);
  assert.equal(decided.run.dataMode, "simulated");

  const ledger = store.listLedger();
  const actions = ledger.map((event) => event.decision.action);
  assert.ok(actions.includes("run.started"));
  assert.ok(actions.includes("approval.asked"));
  assert.ok(actions.includes("approval.decided"));
  assert.ok(actions.includes("run.completed"));
  assert.equal(store.verifyLedger().ok, true);
});

test("驳回流程：无原因拒绝；有原因则 Run 取消", async () => {
  const { service, store } = makeService();
  const started = await service.startRun({ capabilityId: "pipeline:visibility-watch" });
  await assert.rejects(() => service.decideApproval({ approvalId: started.approval.approvalId, gesture: { type: "reject" } }), /EMPTY_REASON/);
  const decided = await service.decideApproval({ approvalId: started.approval.approvalId, gesture: { type: "reject", reasonEnum: "risk", reasonText: "风险过高" } });
  assert.equal(decided.approval.status, "rejected");
  assert.equal(decided.run.state, "cancelled");
  assert.equal(store.verifyLedger().ok, true);
});

test("手势兼容：字符串 approve 归一化为对象后可用", async () => {
  const { service } = makeService();
  const started = await service.startRun({ capabilityId: "pipeline:ops-rhythm" });
  const decided = await service.decideApproval({ approvalId: started.approval.approvalId, gesture: "approve" });
  assert.equal(decided.approval.status, "approved");
  assert.equal(decided.run.state, "completed");
});

test("block 流程：直接熔断，不生成审批、不执行", async () => {
  const { service, store } = makeService({ "content:content.submit": { level: "block", impacts: [{ rule_id: "G-GEO2", version: "v1", result: "blocked" }], triggeredBy: ["事实红线一票否决"], evalErrors: [] } });
  const result = await service.startRun({ capabilityId: "pipeline:dual-content-factory", action: "content.submit", objectType: "content", context: { fact_check_passed: false } });
  assert.equal(result.run.state, "blocked");
  assert.equal(result.approval, null);
  assert.equal(store.listApprovals().length, 0);
  assert.ok(store.listLedger().some((event) => event.decision.action === "run.blocked"));
});

test("auto 流程：无审批直接执行并给回执", async () => {
  const { service } = makeService({ "script:draft": { level: "auto", impacts: [{ rule_id: "G-C01", version: "v1", result: "pass" }], triggeredBy: [], evalErrors: [] } });
  const result = await service.startRun({ capabilityId: "employee:scriptwriter", action: "draft", objectType: "script", params: {} });
  assert.equal(result.run.state, "completed");
  assert.equal(result.run.receipt.synced, true);
});

test("幂等键：重复 startRun 返回同一 Run", async () => {
  const { service } = makeService();
  const first = await service.startRun({ capabilityId: "pipeline:ops-rhythm", idempotencyKey: "idem-1" });
  const second = await service.startRun({ capabilityId: "pipeline:ops-rhythm", idempotencyKey: "idem-1" });
  assert.equal(first.run.runId, second.run.runId);
  assert.equal(second.deduped, true);
});

test("审批过期 fail-closed", async () => {
  const { service } = makeService({}, { approvalTtlMs: -1000 });
  const started = await service.startRun({ capabilityId: "pipeline:intel-fusion" });
  await assert.rejects(
    () => service.decideApproval({ approvalId: started.approval.approvalId, gesture: { type: "approve" } }),
    (error) => error?.code === "APPROVAL_EXPIRED",
  );
});

test("账本篡改可被发现", async () => {
  const { service, store, dataDir } = makeService();
  await service.startRun({ capabilityId: "pipeline:ops-rhythm" });
  assert.equal(store.verifyLedger().ok, true);
  appendFileSync(join(dataDir, "ledger.jsonl"), `${JSON.stringify({ event_id: "E-999", who: { type: "system", id: "tamper" }, context: { tenant_id: "x", workspace_id: "x", time: new Date().toISOString() }, object: { type: "x" }, decision: { action: "tamper" }, rule_impact: [], hash: "bad" })}\n`);
  const reloaded = createStore({ dataDir });
  assert.equal(reloaded.verifyLedger().ok, false);
});

test("账本跨进程重载后仍可验链（undefined 字段不得进入哈希）", async () => {
  const { service, dataDir } = makeService();
  const started = await service.startRun({ capabilityId: "pipeline:ops-rhythm" });
  await service.decideApproval({ approvalId: started.approval.approvalId, gesture: { type: "approve" } });
  const reloaded = createStore({ dataDir });
  const verified = reloaded.verifyLedger();
  assert.equal(verified.ok, true, `brokenAt=${verified.brokenAt ?? "-"}`);
  assert.ok(verified.total >= 4);
});

test("多进程可见性：第二个 store 实例能读到第一个实例写入的 Run/审批/账本", async () => {
  const { service, dataDir } = makeService();
  const started = await service.startRun({ capabilityId: "pipeline:dual-content-factory" });
  const reader = createStore({ dataDir });
  assert.ok(reader.getRun(started.run.runId), "reader 应看到新 Run");
  assert.ok(reader.getApproval(started.approval.approvalId), "reader 应看到新审批");
  assert.ok(reader.listLedger().length >= 2, "reader 应看到账本事件");

  await service.decideApproval({ approvalId: started.approval.approvalId, gesture: { type: "approve" } });
  assert.equal(reader.getApproval(started.approval.approvalId).status, "approved", "reader 应看到审批更新");
  assert.equal(reader.getRun(started.run.runId).state, "completed", "reader 应看到 Run 更新");
  assert.equal(reader.verifyLedger().ok, true);
});
