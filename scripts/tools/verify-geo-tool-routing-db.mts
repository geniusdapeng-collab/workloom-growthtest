#!/usr/bin/env node
/**
 * MC-006：真实 runtime / 部署路由 / 网关 / RLS / append-only PG 断言。
 * 使用已迁移的专用测试库，要求 DATABASE_APP_URL / DATABASE_GATEWAY_URL。
 * 只创建唯一命名的测试租户、工作区、档案、线程与事件；不使用 owner，不删除或修改事件。
 * 无 LLM 调用、无桥网络请求、无付费模型/图像/视频请求。
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pg from "pg";
import { gatewayAppend, eventHash, GENESIS_HASH } from "@workloom/base/workdata";
import { runQuest, stepFingerprint, executeDeclaredTool, toolResultVerified, type QuestStep, type ToolExecutor, type ToolResult, type ToolExecutionEvidence } from "@workloom/runtime";
import type { BusinessEvent } from "@workloom/shared";
import { loadDeploymentToolExecutor, resetToolExecutorCache } from "../../apps/server/src/runtime/tool-executor.js";

for (const key of ["DATABASE_APP_URL", "DATABASE_GATEWAY_URL"]) {
  if (!process.env[key]) throw new Error(`真实 PG 断言缺少 ${key}；不能跳过后宣称通过`);
}
const app = new pg.Pool({ connectionString: process.env.DATABASE_APP_URL, connectionTimeoutMillis: 5000, statement_timeout: 15000 });
const gateway = new pg.Pool({ connectionString: process.env.DATABASE_GATEWAY_URL, connectionTimeoutMillis: 5000, statement_timeout: 15000 });
app.on("error", (error) => console.error("[MC-006] app 空闲连接异常：", error.message));
gateway.on("error", (error) => console.error("[MC-006] gateway 空闲连接异常：", error.message));
const runId = randomUUID();
type Scope = { tenantId: string; workspaceId: string };
type StoredEvent = { payload: BusinessEvent; prev_hash: string; hash: string };
const checks: Array<{ id: string; result: "passed"; evidence: Record<string, unknown> }> = [];
const presetKey = "mc006-read-fixture";
const params = { text: "测试 / ✓ \" \\n", contact: "mc006-fixture@example.invalid", empty: null, values: [false, 0, ""] };
const step: QuestStep = { stepId: "s1", action: "metrics.read", objectType: "metrics", tool: "metrics.read", params, label: "读取 metrics 夹具" };
const healthyStep: QuestStep = { stepId: "s1", action: "fixture.other.read", objectType: "metrics", tool: "fixture.other.read", params: {}, label: "读取健康桥本地夹具" };
const oldBridgeEnv = {
  list: process.env.WORKLOOM_TOOL_EXECUTOR_MODULES,
  legacy: process.env.WORKLOOM_TOOL_EXECUTOR_MODULE,
  token: process.env.WORKLOOM_BRIDGE_TOKEN,
};
let fixtureDir: string | undefined;

async function inScope<T>(pool: pg.Pool, scope: Scope, work: (client: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT set_config('app.tenant_id', $1, true), set_config('app.workspace_id', $2, true)", [scope.tenantId, scope.workspaceId]);
    const result = await work(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    try { await client.query("ROLLBACK"); }
    catch (rollbackError) { console.error("[MC-006] 回滚失败：", rollbackError instanceof Error ? rollbackError.message : String(rollbackError)); }
    throw error;
  } finally { client.release(); }
}

async function fixtureScope(kind: string, dataMode: "simulated" | "real", tenantId?: string): Promise<Scope> {
  const scope = { tenantId: tenantId ?? `tenant-mc006-${runId}-${kind}`, workspaceId: `ws-mc006-${runId}-${kind}` };
  await inScope(app, scope, async (client) => {
    await client.query("INSERT INTO tenants (id, name, plan) VALUES ($1,'MC-006 测试租户','pro') ON CONFLICT (id) DO NOTHING", [scope.tenantId]);
    await client.query("INSERT INTO workspaces (id, tenant_id, name, slug, industry, stage) VALUES ($1,$2,'MC-006 回执测试',$1,'fixture','stable')", [scope.workspaceId, scope.tenantId]);
    await client.query("INSERT INTO profiles (workspace_id, tenant_id, industry, archive) VALUES ($1,$2,'fixture',$3::jsonb)", [scope.workspaceId, scope.tenantId, JSON.stringify({ dataMode, source: "mc006-assertion-fixture" })]);
    await client.query("INSERT INTO agents (id, workspace_id, preset_key, name, version, kind, readonly, status, meta) VALUES ($1,$2,$3,'MC-006 只读测试','v1','fixture',true,'ready',$4::jsonb)", [
      `agent-mc006-${runId}-${kind}`, scope.workspaceId, presetKey,
      JSON.stringify({ high_risk: false, tools: [step, healthyStep].map((declared) => ({ name: declared.tool, access: "read", desc: declared.label })) }),
    ]);
  });
  return scope;
}

async function newThread(scope: Scope, label: string): Promise<string> {
  const threadId = `T-MC006-${randomUUID()}`;
  await inScope(app, scope, (client) => client.query("INSERT INTO threads (id, tenant_id, workspace_id, title, mode, status, created_by) VALUES ($1,$2,$3,$4,'quest','queued','MC006-fixture')", [threadId, scope.tenantId, scope.workspaceId, label]));
  return threadId;
}

async function threadEvents(scope: Scope, threadId: string): Promise<StoredEvent[]> {
  return inScope(gateway, scope, async (client) => (await client.query<StoredEvent>("SELECT payload, prev_hash, hash FROM biz_events WHERE session_id=$1 ORDER BY seq", [threadId])).rows);
}

function input(threadId: string, toolExecutor?: ToolExecutor, steps: QuestStep[] = [step]) {
  return { threadId, goal: "MC006 metrics read", presetKey, fallbackPlanner: () => steps, ...(toolExecutor ? { toolExecutor } : {}) };
}

function storedResult(event: StoredEvent): ToolResult {
  const decision = event.payload.decision;
  return {
    result: (decision.after as { result: Record<string, unknown> }).result,
    receipt: { ...event.payload.receipt, synced: event.payload.receipt?.synced === true },
    execution: decision.tool_execution as ToolExecutionEvidence,
  };
}

function executionEvents(events: StoredEvent[], stepIds: string[] = ["s1"]): StoredEvent[] {
  assert.equal(events.length, stepIds.length * 2, "每次实际执行必须保留开始事件和最终回执");
  assert.deepEqual(events.map((event) => [event.payload.decision.kind, event.payload.decision.step_id]),
    stepIds.flatMap((id) => [["execution_started", id], ["execute", id]]));
  const finals: StoredEvent[] = [];
  for (let index = 0; index < events.length; index += 2) {
    const started = events[index]!, final = events[index + 1]!;
    assert.equal(started.payload.receipt?.synced, false, "开始事件不是完成回执");
    for (const field of ["action", "tool", "step_id", "fingerprint"] as const) {
      assert.equal(started.payload.decision[field], final.payload.decision[field], `开始和最终事件的 ${field} 必须一致`);
    }
    assert.deepEqual(started.payload.decision.params, final.payload.decision.params);
    assert.equal(started.payload.context.tenant_id, final.payload.context.tenant_id);
    assert.equal(started.payload.context.workspace_id, final.payload.context.workspace_id);
    finals.push(final);
  }
  return finals;
}

async function appendFixture(scope: Scope, threadId: string, out: ToolResult): Promise<void> {
  await gatewayAppend(gateway, { ...scope, actor: { id: "system", type: "system" }, sessionId: threadId }, {
    who: { id: "system", type: "system" },
    context: { tenant_id: scope.tenantId, workspace_id: scope.workspaceId, time: new Date().toISOString(), channel: "inapp" },
    object: { type: "metrics" },
    decision: { kind: "execute", action: step.action, tool: step.tool, effect: "read", step_id: step.stepId, params, fingerprint: stepFingerprint(step), after: { result: out.result }, tool_execution: out.execution },
    receipt: out.receipt, rule_impact: [],
  });
}

function pass(id: string, evidence: Record<string, unknown>): void {
  checks.push({ id, result: "passed", evidence });
  console.log(JSON.stringify(checks.at(-1)));
}

async function bridge(spec: string, scope: Scope): Promise<ToolExecutor> {
  delete process.env.WORKLOOM_TOOL_EXECUTOR_MODULE;
  process.env.WORKLOOM_TOOL_EXECUTOR_MODULES = spec;
  process.env.WORKLOOM_BRIDGE_TOKEN = "mc006-fixture-not-a-real-token";
  resetToolExecutorCache();
  const executor = await loadDeploymentToolExecutor(scope);
  assert.ok(executor, "已配置桥不能返回 undefined 并绕过失败范围");
  return executor;
}

try {
  fixtureDir = await mkdtemp(join(tmpdir(), "wl-mc006-routing-"));
  const partialFile = join(fixtureDir, "partial.mjs");
  const brokenFile = join(fixtureDir, "broken.mjs");
  const healthyFile = join(fixtureDir, "healthy.mjs");
  await writeFile(partialFile, `export const TOOL_PATTERNS=["fixture.other.*"]; export function createToolExecutor(){return async()=>{throw new Error("未覆盖工具不应调用桥");};}\n`);
  await writeFile(brokenFile, `export const TOOL_PATTERNS=["metrics.read"]; export function createToolExecutor(){return async()=>{throw new Error("MC006 covered bridge failure");};}\n`);
  await writeFile(healthyFile, `export const TOOL_PATTERNS=["fixture.other.*"]; export function createToolExecutor(){return async(name)=>({result:{state:"fixture-ok",tool:name},receipt:{synced:true,mode:"real"}});}\n`);
  const scopeA = await fixtureScope("sim-a", "simulated");
  const scopeB = await fixtureScope("sim-b", "simulated");
  const scopeC = await fixtureScope("real-c", "real");
  const scopeD = await fixtureScope("sim-d", "simulated", scopeA.tenantId);
  const executorA = await bridge(partialFile, scopeA);
  const executorB = await loadDeploymentToolExecutor(scopeB);
  const executorD = await loadDeploymentToolExecutor(scopeD);
  assert.equal(executorA.supportsTool?.(step.tool), false);
  const [threadA, threadB, threadD] = await Promise.all([newThread(scopeA, "partial bridge / 特殊字符"), newThread(scopeB, "parallel tenant"), newThread(scopeD, "parallel workspace")]);
  const results = await Promise.all([
    runQuest(app, gateway, scopeA, input(threadA, executorA)),
    runQuest(app, gateway, scopeB, input(threadB, executorB)),
    runQuest(app, gateway, scopeD, input(threadD, executorD)),
  ]);
  for (const result of results) assert.deepEqual({ status: result.status, done: result.stepsDone, unverified: result.unverified }, { status: "completed", done: 1, unverified: [] });
  const [eventsA, eventsB, eventsD] = await Promise.all([threadEvents(scopeA, threadA), threadEvents(scopeB, threadB), threadEvents(scopeD, threadD)]);
  for (const [scope, threadId, events] of [[scopeA, threadA, eventsA], [scopeB, threadB, eventsB], [scopeD, threadD, eventsD]] as const) {
    const final = executionEvents(events)[0]!;
    const out = storedResult(final);
    assert.equal(out.receipt.mode, "simulated");
    assert.equal(toolResultVerified(out, { ...scope, threadId, stepId: "s1", fingerprint: stepFingerprint(step) }, step.tool, params), true);
    assert.notEqual((final.payload.decision.params as { contact: string }).contact, params.contact, "网关必须脱敏事件参数，replay 应核对持久计划原始摘要");
  }
  pass("partial-bridge-simulation-and-parallel-isolation", { threads: [threadA, threadB, threadD], modes: ["simulated", "simulated", "simulated"], boundEvents: 3, startedEvents: 3, totalEvents: 6 });

  let completedReplayCalls = 0;
  const completedReplayExecutor: ToolExecutor = async () => {
    completedReplayCalls += 1;
    throw new Error("completed replay must not execute a tool");
  };
  const replay = await runQuest(app, gateway, scopeA, {
    ...input(threadA, completedReplayExecutor),
    fallbackPlanner: () => { throw new Error("completed replay must not replan"); },
  });
  assert.equal(replay.status, "completed");
  assert.equal(replay.stepsDone, 1);
  assert.equal(replay.stepsTotal, 1);
  assert.equal(completedReplayCalls, 0);
  const replayEvents = await threadEvents(scopeA, threadA);
  executionEvents(replayEvents);
  assert.deepEqual(replayEvents, eventsA, "已核实 replay 不得增加或改变原事件");
  pass("replay-is-idempotent-after-pii-masking", { threadId: threadA, stepsDone: replay.stepsDone, eventCount: 2, finalReceipts: 1 });
  assert.equal((await threadEvents(scopeB, threadA)).length, 0);
  assert.equal((await threadEvents(scopeD, threadA)).length, 0);
  pass("rls-other-tenant-and-workspace-cannot-read-receipt", { otherTenantRows: 0, otherWorkspaceRows: 0 });

  const crossThread = await newThread(scopeB, "wrong tenant binding in immutable ledger");
  await appendFixture(scopeB, crossThread, storedResult(executionEvents(eventsA)[0]!));
  let replayCalls = 0;
  const shouldNotExecute: ToolExecutor = async () => { replayCalls += 1; return { result: {}, receipt: { synced: true, mode: "real" } }; };
  const crossReplay = await runQuest(app, gateway, scopeB, input(crossThread, shouldNotExecute));
  assert.equal(crossReplay.status, "failed");
  assert.deepEqual(crossReplay.unverified, ["s1"]);
  assert.equal(replayCalls, 0);
  assert.equal((await threadEvents(scopeB, crossThread)).length, 1);
  pass("cross-tenant-binding-rejected-on-replay-without-reissue", { threadId: crossThread, status: crossReplay.status, executorCalls: 0 });

  const tamperedThread = await newThread(scopeA, "tampered result in immutable ledger");
  const tampered = await executeDeclaredTool(step.tool, params, { allowedTools: [step.tool], simulated: true, context: { ...scopeA, threadId: tamperedThread, stepId: "s1", fingerprint: stepFingerprint(step) } });
  tampered.result = { ...tampered.result, state: "tampered" };
  await appendFixture(scopeA, tamperedThread, tampered);
  const tamperedReplay = await runQuest(app, gateway, scopeA, input(tamperedThread, shouldNotExecute));
  assert.equal(tamperedReplay.status, "failed");
  assert.deepEqual(tamperedReplay.unverified, ["s1"]);
  assert.equal(replayCalls, 0);
  assert.equal((await threadEvents(scopeA, tamperedThread)).length, 1);
  pass("tampered-result-rejected-on-replay-without-reissue", { threadId: tamperedThread, status: tamperedReplay.status, executorCalls: 0 });

  const realThread = await newThread(scopeC, "uncovered real profile remains real");
  const realExecutor = await loadDeploymentToolExecutor(scopeC);
  const realResult = await runQuest(app, gateway, scopeC, input(realThread, realExecutor));
  assert.deepEqual({ status: realResult.status, done: realResult.stepsDone, unverified: realResult.unverified }, { status: "failed", done: 0, unverified: ["s1"] });
  assert.deepEqual(executionEvents(await threadEvents(scopeC, realThread))[0]!.payload.receipt, { synced: false, mode: "real" });
  pass("real-uncovered-tool-stays-connector-required", { threadId: realThread, status: realResult.status, mode: "real", synced: false });

  const coveredExecutor = await bridge(brokenFile, scopeA);
  const coveredThread = await newThread(scopeA, "covered bridge runtime failure");
  const covered = await runQuest(app, gateway, scopeA, input(coveredThread, coveredExecutor));
  assert.equal(covered.status, "failed");
  assert.equal(covered.stepsDone, 0);
  assert.match(covered.error ?? "", /MC006 covered bridge failure/);
  assert.equal(executionEvents(await threadEvents(scopeA, coveredThread))[0]!.payload.decision.outcome, "error");
  pass("covered-runtime-failure-does-not-simulate", { threadId: coveredThread, status: covered.status, stepsDone: 0 });

  const loadFailureExecutor = await bridge(`${join(fixtureDir, "missing.mjs")}::createToolExecutor::metrics.read`, scopeA);
  assert.equal(loadFailureExecutor.supportsTool?.(step.tool), true);
  const loadFailureThread = await newThread(scopeA, "covered bridge load failure");
  const loadFailure = await runQuest(app, gateway, scopeA, input(loadFailureThread, loadFailureExecutor));
  assert.deepEqual({ status: loadFailure.status, done: loadFailure.stepsDone, unverified: loadFailure.unverified }, { status: "failed", done: 0, unverified: ["s1"] });
  assert.equal((executionEvents(await threadEvents(scopeA, loadFailureThread))[0]!.payload.decision.after as { result: { reason: string } }).result.reason, "connector-load-failed");
  pass("covered-load-failure-does-not-simulate", { threadId: loadFailureThread, status: loadFailure.status, mode: "real", synced: false });

  const malformedExecutor = await bridge("::createToolExecutor::metrics.read", scopeA);
  const malformedThread = await newThread(scopeA, "malformed configured bridge");
  const malformed = await runQuest(app, gateway, scopeA, input(malformedThread, malformedExecutor));
  assert.deepEqual({ status: malformed.status, done: malformed.stepsDone, unverified: malformed.unverified }, { status: "failed", done: 0, unverified: ["s1"] });
  assert.equal(executionEvents(await threadEvents(scopeA, malformedThread))[0]!.payload.receipt?.mode, "real");
  pass("malformed-configuration-does-not-become-unconfigured-simulation", { threadId: malformedThread, status: malformed.status, mode: "real", synced: false });

  for (const [caseId, malformedSpec, unknownRange] of [
    ["mixed-known-malformed-keeps-failed-range-and-healthy-route", "::createToolExecutor::metrics.read", false],
    ["mixed-unknown-malformed-keeps-failed-range-and-healthy-route", "::createToolExecutor", true],
  ] as const) {
    const orderEvidence: Record<string, unknown>[] = [];
    for (const failedLast of [false, true]) {
      const mixedExecutor = await bridge((failedLast ? [healthyFile, malformedSpec] : [malformedSpec, healthyFile]).join(","), scopeA);
      const mixedThread = await newThread(scopeA, `${caseId} / failed-last=${failedLast}`);
      const mixed = await runQuest(app, gateway, scopeA, input(mixedThread, mixedExecutor));
      const mixedEvents = await threadEvents(scopeA, mixedThread);
      const mixedFinal = executionEvents(mixedEvents)[0]!;
      console.log(JSON.stringify({ caseId, failedLast, threadId: mixedThread, actual: { status: mixed.status, done: mixed.stepsDone, unverified: mixed.unverified, mode: mixedFinal.payload.receipt?.mode }, phase: "before-assertion" }));
      assert.deepEqual({ status: mixed.status, done: mixed.stepsDone, unverified: mixed.unverified }, { status: "failed", done: 0, unverified: ["s1"] });
      assert.equal(mixedExecutor.supportsTool?.(step.tool), true);
      assert.equal(mixedExecutor.supportsTool?.("unrelated.read"), unknownRange);
      assert.deepEqual(mixedFinal.payload.receipt, { synced: false, mode: "real" });
      assert.equal((mixedFinal.payload.decision.after as { result: { reason: string } }).result.reason, "connector-load-failed");
      assert.equal(mixedFinal.payload.decision.tool_execution, undefined, "失败装配不能签发本地模拟绑定");

      const healthyThread = await newThread(scopeA, `${caseId} / independent healthy bridge`);
      const healthy = await runQuest(app, gateway, scopeA, input(healthyThread, mixedExecutor, [healthyStep]));
      assert.deepEqual({ status: healthy.status, done: healthy.stepsDone, unverified: healthy.unverified }, { status: "completed", done: 1, unverified: [] });
      const healthyEvents = await threadEvents(scopeA, healthyThread);
      const healthyFinal = executionEvents(healthyEvents)[0]!;
      assert.deepEqual(healthyFinal.payload.receipt, { synced: true, mode: "real" });
      assert.equal((healthyFinal.payload.decision.after as { result: { state: string } }).result.state, "fixture-ok");
      orderEvidence.push({ failedLast, failedThread: mixedThread, failedMode: "real", stepsDone: 0, healthyThread, healthyStepsDone: 1, localFixtureOnly: true });
    }
    pass(caseId, { unknownFailedRange: unknownRange, orders: orderEvidence, externalBridgeRequests: 0 });
  }

  const maxExecutor = await bridge(partialFile, scopeA);
  const maxThread = await newThread(scopeA, "six empty parameter read steps");
  const maxSteps = Array.from({ length: 6 }, (_, index) => ({ ...step, stepId: `s${index + 1}`, params: {}, label: `metrics ${index + 1}` }));
  const maximum = await runQuest(app, gateway, scopeA, input(maxThread, maxExecutor, maxSteps));
  assert.deepEqual({ status: maximum.status, done: maximum.stepsDone }, { status: "completed", done: 6 });
  const maxStepIds = ["s1", "s2", "s3", "s4", "s5", "s6"];
  const maxEvents = await threadEvents(scopeA, maxThread);
  assert.deepEqual(executionEvents(maxEvents, maxStepIds).map((event) => (event.payload.decision.tool_execution as { step_id: string }).step_id), maxStepIds);
  pass("maximum-six-steps-and-empty-parameters-bound-individually", { threadId: maxThread, stepsDone: 6, bindings: 6, startedEvents: 6, totalEvents: 12 });

  await inScope(app, scopeA, (client) => client.query("UPDATE profiles SET archive=jsonb_set(archive,'{dataMode}','\"real\"'::jsonb) WHERE workspace_id=$1", [scopeA.workspaceId]));
  // Terminal tasks keep their final status. Verify the real-mode receipt guard
  // on a distinct queued replay fixture whose signed simulated receipt binds
  // to that exact scope/thread/step; append-only historical events stay intact.
  const completedAfterSwitch = await runQuest(app, gateway, scopeA, input(threadA, shouldNotExecute));
  assert.equal(completedAfterSwitch.status, "completed");
  assert.deepEqual(await threadEvents(scopeA, threadA), eventsA, "已完成终态不能因档案切换回退或重发");
  const switchedThread = await newThread(scopeA, "simulated receipt resumed under real profile");
  const simulatedBeforeSwitch = await executeDeclaredTool(step.tool, params, { allowedTools: [step.tool], simulated: true,
    context: { ...scopeA, threadId: switchedThread, stepId: "s1", fingerprint: stepFingerprint(step) } });
  await appendFixture(scopeA, switchedThread, simulatedBeforeSwitch);
  const switchedEvents = await threadEvents(scopeA, switchedThread);
  const switched = await runQuest(app, gateway, scopeA, input(switchedThread, shouldNotExecute));
  assert.deepEqual({ status: switched.status, done: switched.stepsDone, unverified: switched.unverified }, { status: "failed", done: 0, unverified: ["s1"] });
  assert.equal(replayCalls, 0);
  assert.deepEqual(await threadEvents(scopeA, switchedThread), switchedEvents, "模式切换后的拒绝不得增加或改变旧模拟回执");
  pass("simulated-receipt-cannot-complete-real-profile-after-switch", { threadId: switchedThread,
    completedHistoricalThread: threadA, historicalStatus: completedAfterSwitch.status, status: switched.status, executorCalls: 0 });

  for (const scope of [scopeA, scopeB, scopeC, scopeD]) {
    const events = await inScope(gateway, scope, async (client) => (await client.query<StoredEvent>("SELECT payload, prev_hash, hash FROM biz_events ORDER BY seq")).rows);
    let previous = GENESIS_HASH;
    for (const event of events) {
      assert.equal(event.prev_hash, previous);
      assert.equal(event.hash, eventHash(previous, event.payload));
      previous = event.hash;
    }
  }
  pass("all-fixture-event-chains-remain-consistent", { workspaces: 4, deletedEvents: 0, mutatedEvents: 0 });
  console.log(JSON.stringify({ actor: "MC006-db-assertions", runId, status: "passed", checks: checks.length, fixturePolicy: "app/gateway roles, unique new scopes, no event deletion or mutation", paidModelImageVideoApiCalls: 0 }, null, 2));
} catch (error) {
  console.error(JSON.stringify({ actor: "MC006-db-assertions", runId, status: "failed", completedChecks: checks.length, error: error instanceof Error ? error.message : String(error), paidModelImageVideoApiCalls: 0 }));
  process.exitCode = 1;
} finally {
  if (oldBridgeEnv.list === undefined) delete process.env.WORKLOOM_TOOL_EXECUTOR_MODULES;
  else process.env.WORKLOOM_TOOL_EXECUTOR_MODULES = oldBridgeEnv.list;
  if (oldBridgeEnv.legacy === undefined) delete process.env.WORKLOOM_TOOL_EXECUTOR_MODULE;
  else process.env.WORKLOOM_TOOL_EXECUTOR_MODULE = oldBridgeEnv.legacy;
  if (oldBridgeEnv.token === undefined) delete process.env.WORKLOOM_BRIDGE_TOKEN;
  else process.env.WORKLOOM_BRIDGE_TOKEN = oldBridgeEnv.token;
  resetToolExecutorCache();
  await Promise.all([app.end(), gateway.end()]);
  if (fixtureDir) await rm(fixtureDir, { recursive: true, force: true });
}
