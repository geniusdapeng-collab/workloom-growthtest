/**
 * T-2026-0927-0013：执行真实 runQuest 循环；替换 PG、装配与网关边界，不触真实外部工具。
 * 覆盖无回执停线、跨次重入、历史门事件、最新回执、作用域与历史查询失败。
 */
import type pg from "pg";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ToolResult } from "./tools.js";

const doubles = vi.hoisted(() => ({
  assemblePreset: vi.fn(),
  append: vi.fn(),
  authorize: vi.fn(),
}));

vi.mock("./assembly.js", () => ({ assemblePreset: doubles.assemblePreset }));
vi.mock("@workloom/base/fence-engine", () => ({
  judge: () => ({ level: "auto", impacts: [], triggeredBy: [], evalErrors: [] }),
  judgeViews: () => ({ level: "auto", impacts: [], triggeredBy: [], evalErrors: [] }),
}));
vi.mock("@workloom/base/workdata", () => ({
  gatewayAppend: doubles.append,
  gatewayAppendOnClient: doubles.append,
  authorizeToolExecution: doubles.authorize,
  registerWriteActions: vi.fn(),
}));
vi.mock("@workloom/base/captain", () => ({ loadCharter: vi.fn(), routeTier: vi.fn() }));
vi.mock("@workloom/base/evolve", () => ({
  loadActivePreferences: async () => [],
  buildPreferenceBlock: () => "",
  preferenceMemoryRefs: () => [],
  recordPreferenceUsageInTx: async () => undefined,
}));

import { runQuest } from "./loop.js";
import type { QuestStep } from "./loop.js";

const scope = { tenantId: "tenant-a", workspaceId: "ws-a" };
/**
 * GR-07 起：**确定性兜底计划**（planQuest）产出的写步骤带 params_incomplete，一律强制人工裁决。
 * 本文件的用例聚焦"回执/重入"语义，因此显式注入带完整参数的计划器，让步骤按自动档走执行路径。
 */
const explicitPlanner = (): QuestStep[] => [
  { stepId: "s1", action: "task.submit", objectType: "task", tool: "task.submit", params: {}, label: "提交" },
  { stepId: "s2", action: "task.confirm", objectType: "task", tool: "task.confirm", params: {}, label: "核验" },
];
const input = { threadId: "thread-a", goal: "提交并核验", presetKey: "operator", fallbackPlanner: explicitPlanner };
type StoredEvent = {
  payload: Record<string, unknown>;
  tenantId: string;
  workspaceId: string;
  threadId: string;
};
let events: StoredEvent[];
let queries: Array<{ sql: string; params: unknown[] }>;
let historyFailure: Error | undefined;
let lockAvailable: boolean;
let threadStatus: string;
let pool: pg.Pool;

function remember(receipt: unknown, basis?: string[], overrides: Partial<StoredEvent> = {}): void {
  events.push({
    ...scope, threadId: input.threadId,
    payload: { decision: { action: "task.submit", step_id: "s1", basis }, ...(receipt === undefined ? {} : { receipt }) },
    ...overrides,
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  events = [];
  queries = [];
  historyFailure = undefined;
  lockAvailable = true;
  threadStatus = "paused";
  doubles.assemblePreset.mockResolvedValue({
    agentId: "agent-a", presetKey: "operator", version: "v1", highRisk: false, fenceBindings: [], prompt: null,
    essentials: { archive: { dataMode: "real" }, stage: "production", goal: input.goal },
    tools: [
      { name: "task.submit", access: "write", desc: "提交" },
      { name: "task.confirm", access: "write", desc: "核验后继动作" },
    ],
  });
  doubles.append.mockImplementation(async (_client, ctx, payload) => {
    events.push({ payload, tenantId: ctx.tenantId, workspaceId: ctx.workspaceId, threadId: ctx.sessionId });
    return { eventId: `E-${events.length}` };
  });
  doubles.authorize.mockImplementation(async (client, ctx, payload) => {
    const result = await doubles.append(client, ctx, payload);
    return { startedEventId: result.eventId };
  });
  pool = {
    connect: async () => ({
      release: vi.fn(),
      query: async (sql: string, params: unknown[] = []) => {
        queries.push({ sql, params });
        if (sql.includes("pg_try_advisory_lock")) return { rows: [{ locked: lockAvailable }] };
        if (sql.includes("pg_advisory_unlock")) return { rows: [{ pg_advisory_unlock: true }] };
        if (sql.includes("SELECT status, progress_done")) return { rows: [{ status: threadStatus, progress_done: threadStatus === "completed" ? 2 : 0, progress_total: 2 }] };
        if (sql.includes("SELECT status FROM threads")) return { rows: [{ status: "running" }] };
        if (sql.includes("SELECT payload FROM biz_events")) {
          if (historyFailure) throw historyFailure;
          expect(sql).toContain("ORDER BY seq");
          return { rows: events.filter((e) => e.tenantId === params[0] && e.workspaceId === params[1] && e.threadId === params[2]) };
        }
        if (/^(BEGIN|COMMIT|ROLLBACK)$/.test(sql) || sql.includes("set_config(") || sql.includes("UPDATE threads")) return { rows: [] };
        // GR-01 计划持久化：首次运行没有持久化计划（返回空行 → 走规划并写回）
        if (sql.includes("SELECT plan, plan_version FROM threads")) return { rows: [] };
        // N-14 挂起去重 + review 分支写审批：旧用例关注回执行语义，这里补最小桩
        if (sql.includes("INSERT INTO approvals")) return { rows: [] };
        if (sql.includes("FROM fence_rules") || sql.includes("FROM approvals")) return { rows: [] };
        throw new Error(`测试未定义的 SQL：${sql}`);
      },
    }),
  } as unknown as pg.Pool;
});

const verifiedResult = (): ToolResult => ({ result: { accepted: true }, receipt: { synced: true } });
const completedUpdates = () => queries.filter(({ sql, params }) => sql.includes("UPDATE threads") && params.includes("completed"));
const executedEvents = () => events.filter(({ payload }) => (payload.decision as { kind?: string }).kind === "execute");

describe("Quest 未核实回执不转完成，也不自动重发", () => {
  it.each([false, undefined])("当次回执 synced=%s：停在第一步；再次进入仍 failed 且没有重复执行", async (synced) => {
    const execute = vi.fn(async (): Promise<ToolResult> => ({ result: { accepted: "unknown" }, receipt: { synced } as ToolResult["receipt"] }));
    const first = await runQuest(pool, pool, scope, { ...input, toolExecutor: execute });
    expect(first).toMatchObject({ status: "failed", stepsDone: 0, stepsTotal: 2, unverified: ["s1"] });
    expect(execute).toHaveBeenCalledTimes(1);
    expect(execute).toHaveBeenCalledWith("task.submit", {});
    // GR-15 起回执带 mode（real/simulated），断言语义位而不是整对象相等
    expect(executedEvents()[0]?.payload.receipt).toMatchObject({ synced: false });
    const replay = await runQuest(pool, pool, scope, { ...input, toolExecutor: execute });
    expect(replay).toEqual(first);
    expect(execute).toHaveBeenCalledTimes(1);
    expect(events).toHaveLength(2);
    expect(completedUpdates()).toHaveLength(0);
  });

  it("适配器漏掉整个 receipt 时仍记录未核实，不执行后继动作", async () => {
    const execute = vi.fn(async () => ({ result: {} }) as ToolResult);
    const result = await runQuest(pool, pool, scope, { ...input, toolExecutor: execute });
    expect(result).toMatchObject({ status: "failed", stepsDone: 0, unverified: ["s1"] });
    // GR-15 起回执带 mode（real/simulated），断言语义位而不是整对象相等
    expect(executedEvents()[0]?.payload.receipt).toMatchObject({ synced: false });
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it.each([undefined, {}, { synced: false }, { synced: "true" }])("历史执行回执 %j 不可作为完成或重发授权", async (receipt) => {
    remember(receipt);
    const execute = vi.fn(async () => verifiedResult());
    const result = await runQuest(pool, pool, scope, { ...input, toolExecutor: execute });
    expect(result).toMatchObject({ status: "failed", stepsDone: 0, unverified: ["s1"] });
    expect(execute).not.toHaveBeenCalled();
    expect(completedUpdates()).toHaveLength(0);
  });

  it("真实已核实步骤可完成；重复进入跳过工具且不追加执行事件", async () => {
    const execute = vi.fn(async () => verifiedResult());
    const first = await runQuest(pool, pool, scope, { ...input, toolExecutor: execute });
    expect(first).toMatchObject({ status: "completed", stepsDone: 2, unverified: [] });
    const replay = await runQuest(pool, pool, scope, { ...input, toolExecutor: execute });
    expect(replay).toEqual(first);
    expect(execute).toHaveBeenCalledTimes(2);
    expect(events).toHaveLength(4);
  });

  it("熔断/待审事件没有执行回执，不会被误判为已执行但未核实", async () => {
    remember(undefined, ["熔断：R1"]);
    remember(undefined, ["越围栏挂起：R1"]);
    const execute = vi.fn(async () => verifiedResult());
    const result = await runQuest(pool, pool, scope, { ...input, toolExecutor: execute });
    expect(result).toMatchObject({ status: "completed", stepsDone: 2 });
    expect(execute).toHaveBeenCalledTimes(2);
  });

  it("按账本顺序读取最新回执：后来的未核实不能被旧成功覆盖", async () => {
    remember({ synced: true });
    remember({ synced: false });
    const execute = vi.fn(async () => verifiedResult());
    const result = await runQuest(pool, pool, scope, { ...input, toolExecutor: execute });
    expect(result).toMatchObject({ status: "failed", stepsDone: 0, unverified: ["s1"] });
    expect(execute).not.toHaveBeenCalled();
  });

  it("账本后来出现已核实执行回执时，按最新状态继续后继步骤", async () => {
    remember({ synced: false });
    remember({ synced: true });
    const execute = vi.fn(async () => verifiedResult());
    const result = await runQuest(pool, pool, scope, { ...input, toolExecutor: execute });
    expect(result).toMatchObject({ status: "completed", stepsDone: 2, unverified: [] });
    expect(execute).toHaveBeenCalledExactlyOnceWith("task.confirm", {});
  });

  it("别的租户、工作区、线程的未核实事件不能污染当前重入", async () => {
    remember({ synced: false }, undefined, { tenantId: "tenant-b" });
    remember({ synced: false }, undefined, { workspaceId: "ws-b" });
    remember({ synced: false }, undefined, { threadId: "thread-b" });
    const execute = vi.fn(async () => verifiedResult());
    const result = await runQuest(pool, pool, scope, { ...input, toolExecutor: execute });
    expect(result).toMatchObject({ status: "completed", stepsDone: 2 });
    expect(queries.find(({ sql }) => sql.includes("SELECT payload FROM biz_events"))?.params)
      .toEqual([scope.tenantId, scope.workspaceId, input.threadId]);
  });

  it("历史读取失败原样上抛，不能以空历史继续执行", async () => {
    historyFailure = new Error("ledger unavailable");
    const execute = vi.fn(async () => verifiedResult());
    await expect(runQuest(pool, pool, scope, { ...input, toolExecutor: execute })).rejects.toBe(historyFailure);
    expect(execute).not.toHaveBeenCalled();
    expect(events).toHaveLength(0);
  });

  it("授权失败时不触工具、不写执行开始事件，并释放线程锁", async () => {
    const denied = new Error("permission denied before action");
    doubles.authorize.mockRejectedValueOnce(denied);
    const execute = vi.fn(async () => verifiedResult());
    await expect(runQuest(pool, pool, scope, { ...input, toolExecutor: execute })).rejects.toBe(denied);
    expect(execute).not.toHaveBeenCalled();
    expect(events).toHaveLength(0);
    expect(queries.some(({ sql }) => sql.includes("pg_advisory_unlock"))).toBe(true);
  });

  it("已经取得执行权但未落最终回执的写操作，重入不得重发", async () => {
    events.push({ ...scope, threadId: input.threadId, payload: {
      decision: { kind: "execution_started", action: "task.submit", step_id: "s1", tool: "task.submit", effect: "write", params: {} },
      receipt: { synced: false },
    } });
    const execute = vi.fn(async () => verifiedResult());
    const result = await runQuest(pool, pool, scope, { ...input, toolExecutor: execute });
    expect(result).toMatchObject({ status: "failed", unverified: ["s1"] });
    expect(execute).not.toHaveBeenCalled();
  });

  it("写工具抛错可能已有副作用，记录未知并禁止自动重试", async () => {
    const execute = vi.fn(async () => { throw new Error("connection closed after submission"); });
    const first = await runQuest(pool, pool, scope, { ...input, toolExecutor: execute });
    expect(first.status).toBe("failed");
    expect(executedEvents()[0]?.payload.receipt).toMatchObject({ synced: false });
    expect(executedEvents()[0]?.payload.decision).toMatchObject({ kind: "execute", effect: "write", outcome: "error" });
    const replay = await runQuest(pool, pool, scope, { ...input, toolExecutor: execute });
    expect(replay).toMatchObject({ status: "failed", unverified: ["s1"] });
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it("明确标为只读的执行异常允许重试，并且不会重试已经成功的后继步骤", async () => {
    doubles.assemblePreset.mockResolvedValue({
      agentId: "agent-a", presetKey: "operator", version: "v1", highRisk: false, fenceBindings: [], prompt: null,
      essentials: { archive: { dataMode: "real" }, stage: "production", goal: input.goal },
      tools: [{ name: "task.submit", access: "read", desc: "读取" }, { name: "task.confirm", access: "read", desc: "核验" }],
    });
    const execute = vi.fn().mockRejectedValueOnce(new Error("read unavailable")).mockResolvedValue(verifiedResult());
    expect((await runQuest(pool, pool, scope, { ...input, toolExecutor: execute })).status).toBe("failed");
    expect((await runQuest(pool, pool, scope, { ...input, toolExecutor: execute })).status).toBe("completed");
    expect(execute).toHaveBeenCalledTimes(3);
  });

  it("他方持锁时不规划、不消费审批、不触工具", async () => {
    lockAvailable = false;
    const execute = vi.fn(async () => verifiedResult());
    expect((await runQuest(pool, pool, scope, { ...input, toolExecutor: execute })).status).toBe("running");
    expect(doubles.assemblePreset).not.toHaveBeenCalled();
    expect(doubles.authorize).not.toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalled();
    expect(queries.some(({ sql }) => sql.includes("pg_advisory_unlock"))).toBe(false);
  });

  it.each(["cancelled", "completed"])("%s 终态重入不复活、不执行", async (status) => {
    threadStatus = status;
    const execute = vi.fn(async () => verifiedResult());
    expect((await runQuest(pool, pool, scope, { ...input, toolExecutor: execute })).status).toBe(status);
    expect(execute).not.toHaveBeenCalled();
    expect(queries.filter(({ sql }) => sql.includes("UPDATE threads"))).toHaveLength(0);
  });
});

describe("GR-07：确定性兜底计划必须人工裁决（不被自动执行，也不被算术规则假熔断）", () => {
  it("无规划器（planQuest 兜底）→ 第一步挂起 pending_review 而不是执行", async () => {
    const execute = vi.fn(async () => verifiedResult());
    const result = await runQuest(pool, pool, scope, { threadId: "thread-a", goal: "提交并核验", presetKey: "operator", toolExecutor: execute });
    expect(result.status).toBe("pending_review");
    expect(execute).not.toHaveBeenCalled();
    expect(result.pendingApprovalId).toBeTruthy();
  });
});
