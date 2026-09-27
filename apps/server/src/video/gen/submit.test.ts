import { beforeEach, describe, expect, it, vi } from "vitest";
import { safeParseBusinessEvent } from "@workloom/shared";
import { GenSubmissionError } from "@workloom/base/model-router";
import { ProviderError, type MediaModel, type VideoGenParams } from "./types.js";
import type { SubmissionReceipt, SubmissionRow } from "./submission-ledger.js";
import { submissionRequestHash } from "./submission-ledger.js";
import { submitGenJob, type SubmitGenJobInput } from "./submit.js";

const f = vi.hoisted(() => ({
  rows: new Map<string, SubmissionRow>(), pool: new Map(), events: [] as any[], jobs: [] as any[],
  failFinalize: false, failAccepted: false, failDispatch: false, failDegradation: false,
  dispatches: 0, healthy: vi.fn(), submit: vi.fn(), fallback: vi.fn(),
}));
/** 本文件隔离账本/供应商行为；正式签发和验签由 production-authority.test/pg.test 覆盖。 */
vi.mock("../production-authority.js", () => ({ authorizeRenderSubmission: async (input: SubmitGenJobInput) => {
  const { compileRenderRequest } = await import("./compiled-request.js");
  const { getModel } = await import("./catalog.js");
  const built = compileRenderRequest({ ...input, model: getModel(input.modelId)!, env: input.env ?? {} });
  return { compiled: built.compiled, requestHash: built.requestHash, reconciliationOnly: false, release: async () => undefined };
} }));
vi.mock("./providers.js", () => ({ videoGenPool: () => f.pool }));
vi.mock("@workloom/base/workdata", async (importOriginal) => ({
  ...await importOriginal<Record<string, unknown>>(),
  gatewayAppendOnClient: async (_client: unknown, _scope: unknown, event: any) => {
    const checked = safeParseBusinessEvent({ ...event, event_id: "E-1" });
    if (!checked.success) throw checked.error;
    const accepted = [...f.rows.values()].find(row => row.job_id === event.decision.after.jobId);
    expect(accepted?.state).toBe("accepted");
    if (f.failFinalize) throw new Error("trace database unavailable");
    f.events.push(event);
  },
}));
vi.mock("@workloom/base/model-router", async (importOriginal) => ({
  ...await importOriginal<Record<string, unknown>>(),
  GatewayEventSink: class {
    async recordDegradation() { if (f.failDegradation) throw new Error("degradation unavailable"); }
  },
}));
vi.mock("./submission-ledger.js", async (importOriginal) => {
  const real = await importOriginal<typeof import("./submission-ledger.js")>();
  return { ...real, SubmissionLedger: class {
    constructor(_app: unknown, private scope: { tenantId: string; workspaceId: string }) {}
    async reserve(input: any) {
      const mapKey = JSON.stringify([this.scope.tenantId, this.scope.workspaceId, input.key]);
      const old = f.rows.get(mapKey);
      if (old) {
        if (old.request_hash !== input.requestHash) throw new real.SubmissionError("IDEMPOTENCY_CONFLICT", "different request");
        return structuredClone(old);
      }
      const n = f.rows.size;
      const row = { id: `GS-${n}`, tenant_id: this.scope.tenantId, workspace_id: this.scope.workspaceId,
        project_id: input.projectId, script_id: input.scriptId, script_version: input.scriptVersion,
        idempotency_key: input.key, request_hash: input.requestHash, job_id: `RJ-${n}`, state: "reserved",
        owner_token: null, provider: null, provider_model: null, task_id: null, receipt: null,
        last_error: null, dispatch_count: 0 } satisfies SubmissionRow;
      f.rows.set(mapKey, row);
      return structuredClone(row);
    }
    row(id: string) { return [...f.rows.values()].find(row => row.id === id)!; }
    async read(id: string) { return structuredClone(this.row(id)); }
    async claim(row: SubmissionRow, owner: string) {
      const stored = this.row(row.id);
      if (stored.state !== "reserved") return null;
      stored.state = "submitting"; stored.owner_token = owner;
      return structuredClone(stored);
    }
    async recordDispatch(id: string, _owner: string, provider: string, model: string) {
      if (f.failDispatch) throw new Error("dispatch database unavailable");
      const row = this.row(id); row.provider = provider; row.provider_model = model;
      row.dispatch_count++; f.dispatches++;
    }
    async recordAccepted(id: string, _owner: string, receipt: SubmissionReceipt) {
      if (f.failAccepted) throw new Error("acceptance database unavailable");
      const row = this.row(id); row.state = "accepted"; row.task_id = receipt.taskId; row.receipt = structuredClone(receipt);
    }
    async recordFailure(id: string, _owner: string, state: "unknown" | "rejected", error: string) {
      Object.assign(this.row(id), { state, last_error: error });
    }
    async finalize(id: string, fn: Function) {
      const row = this.row(id);
      if (row.state === "finalized") return { receipt: row.receipt, deduped: true };
      const jobs = f.jobs.length, events = f.events.length;
      try {
        await fn({ query: async (sql: string, params: unknown[]) => {
          if (sql.includes("INSERT INTO render_jobs")) f.jobs.push(params);
          return { rowCount: 1 };
        } }, structuredClone(row), row.receipt);
        row.state = "finalized";
        return { receipt: row.receipt, deduped: false };
      } catch (error) { f.jobs.splice(jobs); f.events.splice(events); throw error; }
    }
  } };
});

function request(overrides: Partial<SubmitGenJobInput> = {}): SubmitGenJobInput {
  return { app: {} as any, gateway: {} as any, scope: { tenantId: "t", workspaceId: "w" }, actor: "MEM-T",
    script: { id: "RS1", project_id: "P1", shot_id: "S1", script_key: "script1", version: 1,
      status: "approved", md: "固定机位，蓝色玻璃窗", fields: { durationSec: 5 } },
    modelId: "doubao-seedance-2-5", params: { durationSec: 5, aspectRatio: "16:9" }, mode: "manual",
    fenceLevel: "auto", fenceImpacts: [],
    env: { VOLCENGINE_ARK_API_KEY: "test", HF_API_KEY_ID: "test", HF_API_KEY_SECRET: "test" }, ...overrides };
}
beforeEach(() => {
  f.rows.clear(); f.pool.clear(); f.events.length = 0; f.jobs.length = 0;
  f.failFinalize = f.failAccepted = f.failDispatch = f.failDegradation = false; f.dispatches = 0;
  f.healthy.mockReset().mockResolvedValue(true);
  f.submit.mockReset().mockImplementation(async () => { expect(f.dispatches).toBeGreaterThan(0); return { taskId: "provider-task" }; });
  f.fallback.mockReset().mockResolvedValue({ taskId: "fallback-task" });
  f.pool.set("seedance", { healthy: f.healthy, submit: f.submit });
  f.pool.set("higgsfield", { healthy: async () => true, submit: f.fallback });
});

describe("完整请求指纹", () => {
  it("对象键序稳定、数组保序，非法 JSON 数据不能获得指纹", () => {
    expect(submissionRequestHash({ b: 2, a: [1, 2] })).toBe(submissionRequestHash({ a: [1, 2], b: 2 }));
    expect(submissionRequestHash({ a: [1, 2] })).not.toBe(submissionRequestHash({ a: [2, 1] }));
    for (const value of [NaN, Infinity, BigInt(1), new Date(), () => null]) expect(() => submissionRequestHash(value)).toThrow("REQUEST_INVALID");
    const cyclic: any = {}; cyclic.self = cyclic;
    expect(() => submissionRequestHash(cyclic)).toThrow("REQUEST_INVALID");
  });
  it("__proto__ 是合法 JSON 键，不能被原型赋值吞掉造成指纹碰撞", () => {
    const withProto = JSON.parse('{"__proto__":{"a":1},"regular":2}');
    expect(submissionRequestHash(withProto)).not.toBe(submissionRequestHash({ regular: 2 }));
    expect(submissionRequestHash(withProto)).toBe(submissionRequestHash(JSON.parse('{"regular":2,"__proto__":{"a":1}}')));
  });
  it.each([
    { aspectRatio: "9:16" }, { resolution: "1080p" }, { generateAudio: false }, { seed: 42 },
    { firstFrameUrl: "https://example.test/first.png" }, { referenceImageUrls: ["asset://a"] },
    { referenceVideoUrls: ["https://example.test/a.mp4"] }, { referenceAudioUrls: ["https://example.test/a.wav"] },
    { cameraFixed: true }, { negativePrompt: "no text" }, { extra: { nested: { a: "changed" } } },
  ] satisfies VideoGenParams[])("默认键覆盖完整生成参数 %j", async (patch) => {
    const first = await submitGenJob(request());
    const second = await submitGenJob(request({ params: { ...request().params, ...patch } }));
    expect(second.idempotencyKey).not.toBe(first.idempotencyKey);
    expect(f.submit).toHaveBeenCalledTimes(2);
  });
  it("显式 key 换脚本正文/版本/字段/模型或参数均冲突，未再调用供应商", async () => {
    const input = request({ idempotencyKey: "custom" });
    await submitGenJob(input);
    for (const patch of [
      { script: { ...input.script, md: "另一镜" } }, { script: { ...input.script, version: 2 } },
      { script: { ...input.script, fields: { durationSec: 10 } } }, { params: { durationSec: 10 } },
      { env: { ...input.env, SEEDANCE_MODEL: "ep-other" } },
    ]) await expect(submitGenJob({ ...input, ...patch })).rejects.toThrow("IDEMPOTENCY_CONFLICT");
    expect(f.submit).toHaveBeenCalledTimes(1);
  });
  it("等待期间调用方修改 params 不改变已预占的生成载荷", async () => {
    const input = request();
    f.healthy.mockImplementationOnce(async () => { input.params.aspectRatio = "9:16"; return true; });
    await submitGenJob(input);
    expect(f.submit.mock.calls[0]?.[0].params.aspectRatio).toBe("16:9");
  });
});

describe("提交状态机与接受后原子记账", () => {
  it("重复相同请求只生成一次，计量与提交事件各一条，回执先于记账", async () => {
    const first = await submitGenJob(request());
    const repeated = await submitGenJob(request());
    expect(repeated).toMatchObject({ jobId: first.jobId, taskId: first.taskId, deduped: true });
    expect(f.submit).toHaveBeenCalledTimes(1); expect(f.jobs).toHaveLength(1);
    expect(f.events.map(event => event.decision.action)).toEqual(["model.call", "render.submit"]);
    expect(f.events[0].model_trace.tier).toBe("gen");
  });
  it("预占/认领并发时第二个请求返回待核实，不重复触发", async () => {
    let release!: () => void;
    const waiting = new Promise<void>(resolve => { release = resolve; });
    f.submit.mockImplementationOnce(async () => { await waiting; return { taskId: "slow" }; });
    const first = submitGenJob(request());
    await vi.waitFor(() => expect(f.submit).toHaveBeenCalledTimes(1));
    await expect(submitGenJob(request())).rejects.toThrow("SUBMISSION_UNVERIFIED");
    release(); await first; expect(f.fallback).not.toHaveBeenCalled();
  });
  it("CAS 后 dispatch 持久化失败不提交供应商", async () => {
    f.failDispatch = true;
    await expect(submitGenJob(request())).rejects.toThrow("dispatch database");
    expect(f.submit).not.toHaveBeenCalled();
  });
  it("供应商已接受后 trace 写失败保留 accepted，原 key 重试只补记账", async () => {
    f.failFinalize = true;
    await expect(submitGenJob(request())).rejects.toMatchObject({ code: "SUBMISSION_FINALIZATION_PENDING" });
    expect([...f.rows.values()][0]?.state).toBe("accepted");
    expect(f.jobs).toHaveLength(0); expect(f.events).toHaveLength(0);
    f.failFinalize = false;
    const result = await submitGenJob(request({ actor: "MEM-RETRY" }));
    expect(result.deduped).toBe(true); expect(f.submit).toHaveBeenCalledTimes(1); expect(f.fallback).not.toHaveBeenCalled();
    expect(f.events[1].who.id).toBe("MEM-T");
  });
  it("接受回执落库失败保留已知 taskId，不触发 fallback 或重发", async () => {
    f.failAccepted = true;
    await expect(submitGenJob(request())).rejects.toMatchObject({ code: "SUBMISSION_ACCEPTANCE_UNVERIFIED", details: { taskId: "provider-task" } });
    f.failAccepted = false;
    await expect(submitGenJob(request())).rejects.toThrow("SUBMISSION_UNVERIFIED");
    expect(f.submit).toHaveBeenCalledTimes(1); expect(f.fallback).not.toHaveBeenCalled();
  });
  it.each([new Error("timeout"), new ProviderError("RETRYABLE", "HTTP 503", 503), new GenSubmissionError("unknown", "unknown")])(
    "未知接受结果不 fallback，重复 key 仍拒绝：%s", async (error) => {
      f.submit.mockRejectedValue(error);
      await expect(submitGenJob(request())).rejects.toThrow("SUBMISSION_UNKNOWN");
      await expect(submitGenJob(request())).rejects.toThrow("SUBMISSION_UNVERIFIED");
      expect([...f.rows.values()][0]?.state).toBe("unknown");
      expect(f.submit).toHaveBeenCalledTimes(1); expect(f.fallback).not.toHaveBeenCalled();
    },
  );
  it.each(["", "  ", undefined, 123])("无效任务号 %j 为未知回执", async (taskId) => {
    f.submit.mockResolvedValue({ taskId });
    await expect(submitGenJob(request())).rejects.toThrow("SUBMISSION_UNKNOWN");
    expect(f.fallback).not.toHaveBeenCalled();
  });
  it("已审请求即使明确鉴权拒绝也不转未审备援", async () => {
    f.submit.mockRejectedValueOnce(new ProviderError("AUTH", "unauthorized", 401));
    await expect(submitGenJob(request())).rejects.toThrow("PROVIDERS_UNAVAILABLE");
    expect(f.submit).toHaveBeenCalledTimes(1); expect(f.fallback).not.toHaveBeenCalled();
    expect([...f.rows.values()][0]?.state).toBe("rejected");
  });
  it.each(["BAD_REQUEST", "MODERATION", "CONCURRENCY"] as const)("%s 不换供应商", async (kind) => {
    f.submit.mockRejectedValue(new ProviderError(kind, "rejected", 400));
    await expect(submitGenJob(request())).rejects.toMatchObject({ kind });
    expect([...f.rows.values()][0]?.state).toBe("rejected"); expect(f.fallback).not.toHaveBeenCalled();
  });
  it("降级留痕失败不触发下一家供应商", async () => {
    f.failDegradation = true; f.healthy.mockResolvedValue(false);
    await expect(submitGenJob(request())).rejects.toThrow("degradation unavailable");
    expect(f.submit).not.toHaveBeenCalled(); expect(f.fallback).not.toHaveBeenCalled();
  });
  it("正式远端资格缺供应商时明确失败，不转换为 mock 成功", async () => {
    f.pool.clear();
    await expect(submitGenJob(request())).rejects.toThrow("PROVIDERS_UNAVAILABLE");
    expect(f.jobs).toHaveLength(0); expect(f.events).toHaveLength(0);
  });
});


describe("提交事务故障的连接处理", () => {
  it("回滚失败销毁连接并保留原始与回滚两个异常", async () => {
    const { SubmissionLedger: RealLedger } = await vi.importActual<typeof import("./submission-ledger.js")>("./submission-ledger.js");
    const release = vi.fn();
    const ledger = new RealLedger({ connect: async () => ({
      query: async (sql: string) => {
        if (sql === "ROLLBACK") throw new Error("rollback unavailable");
        if (sql.includes("SELECT * FROM generation_submissions")) throw new Error("read unavailable");
        return { rows: [] };
      }, release,
    }) } as any, { tenantId: "t", workspaceId: "w" });
    await expect(ledger.read("GS1")).rejects.toMatchObject({
      message: "generation-submission-rollback-failed", errors: [expect.objectContaining({ message: "read unavailable" }), expect.objectContaining({ message: "rollback unavailable" })],
    });
    expect(release).toHaveBeenCalledWith(true);
  });
  it("查询失败且回滚成功时归还连接，不能伪造一个空成功", async () => {
    const { SubmissionLedger: RealLedger } = await vi.importActual<typeof import("./submission-ledger.js")>("./submission-ledger.js");
    const release = vi.fn();
    const ledger = new RealLedger({ connect: async () => ({
      query: async (sql: string) => {
        if (sql.includes("SELECT * FROM generation_submissions")) throw new Error("query unavailable");
        return { rows: [] };
      }, release,
    }) } as any, { tenantId: "t", workspaceId: "w" });
    await expect(ledger.read("GS1")).rejects.toThrow("query unavailable");
    expect(release).toHaveBeenCalledWith(false);
  });
});
