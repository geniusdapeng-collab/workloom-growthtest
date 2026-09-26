/**
 * archive/stage-runner.test.ts —— 环节执行器单元测试（T-2026-0926-0001）
 * 覆盖：5 写盘点 / attempt 原子认领口径 / 失败现场固化 / 原样上抛 / 错误分类 / 台账不可用时的旁路降级。
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ArchiveStore } from "./store.js";
import { StageRunner, classifyError, classifyProviderError, newStageRunId, type StageLedgerWriter, type StageStatus } from "./stage-runner.js";

interface FinishedRow {
  stageId: string; attempt: number; status: StageStatus;
  outputRef: string | null; outputSha256: string | null;
  errorClass: string | null; errorMsg: string | null; durationMs: number;
  cost?: Record<string, unknown>;
}

class FakeLedger implements StageLedgerWriter {
  readonly claims: Array<{ stageId: string; attempt: number; inputRef: string }> = [];
  readonly finished: FinishedRow[] = [];
  readonly heartbeats: number[] = [];
  private attempts = new Map<string, number>();
  /** 模拟"另一个执行者已认领过 attempt"（并发场景） */
  constructor(private readonly attemptOffset = 0) {}

  async claimRun(row: { stageId: string; inputRefTemplate: string }): Promise<{ attempt: number; inputRef: string }> {
    const attempt = (this.attempts.get(row.stageId) ?? this.attemptOffset) + 1;
    this.attempts.set(row.stageId, attempt);
    const inputRef = row.inputRefTemplate.replace("{attempt}", String(attempt));
    this.claims.push({ stageId: row.stageId, attempt, inputRef });
    return { attempt, inputRef };
  }

  async finishRun(row: Omit<FinishedRow, "cost"> & { cost?: Record<string, unknown> }): Promise<void> {
    this.finished.push({ ...row });
  }

  async heartbeatRun(row: { attempt: number }): Promise<void> {
    this.heartbeats.push(row.attempt);
  }

  async nextAttempt(_projectId: string, stageId: string): Promise<number> {
    return (this.attempts.get(stageId) ?? this.attemptOffset) + 1;
  }
}

let workDir = "";
let store: ArchiveStore;

beforeEach(async () => {
  workDir = await mkdtemp(path.join(tmpdir(), "archive-runner-"));
  store = new ArchiveStore(workDir, "ws-test", "VID-002", "narrative");
  await store.ensure();
});

afterEach(async () => {
  await rm(workDir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe("StageRunner", () => {
  it("成功路径：input → output → done 台账 → manifest 账本 → 交接包", async () => {
    const ledger = new FakeLedger();
    const runner = new StageRunner(store, ledger, "RUN-1");

    const output = await runner.run("preproduction", { intent: "测试" }, async (ctx) => {
      await ctx.log("info", "环节开始", { shotId: "S1" });
      await ctx.heartbeat({ stages: ["a", "b"] });
      return { output: { success: true, stages: ["a", "b"] }, cost: { tokens: 12 } };
    });

    expect(output).toEqual({ success: true, stages: ["a", "b"] });
    expect(ledger.claims).toEqual([
      { stageId: "preproduction", attempt: 1, inputRef: "stages/preproduction/attempt-1.input.json" },
    ]);
    expect(ledger.finished).toHaveLength(1);
    const finished = ledger.finished[0]!;
    expect(finished.status).toBe("done");
    expect(finished.attempt).toBe(1); // 终结写必须带 attempt 谓词
    expect(finished.outputRef).toBe("stages/preproduction/attempt-1.output.json");
    expect(finished.outputSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(finished.cost).toEqual({ tokens: 12 });
    expect(ledger.heartbeats).toEqual([1]);

    const manifest = await store.readManifest();
    expect(manifest?.ledger.preproduction?.status).toBe("done");
    const input = await store.readJson<{ input: { intent: string } }>("stages/preproduction/attempt-1.input.json");
    expect(input?.input.intent).toBe("测试");
    const logs = await store.readText("logs/preproduction.jsonl");
    expect(logs).toContain('"msg":"环节开始"');
    const bundle = await store.readJson<{ progress: string }>("context-bundle.json");
    expect(bundle?.progress).toContain("预生产内部环节 2");
  });

  it("失败路径：固化 meta + failed 台账 + 原样上抛（不吞错）", async () => {
    const ledger = new FakeLedger();
    const runner = new StageRunner(store, ledger, "RUN-2");
    const boom = new Error("PROVIDER_FAILED model unavailable");

    await expect(
      runner.run("preproduction", { intent: "x" }, async () => {
        throw boom;
      }),
    ).rejects.toBe(boom);

    const finished = ledger.finished[0]!;
    expect(finished.status).toBe("failed");
    expect(finished.errorClass).toBe("PROVIDER_FAILED");
    expect(finished.errorMsg).toBe("PROVIDER_FAILED model unavailable");
    expect(finished.outputRef).toBeNull();
    const meta = await store.readJson<{ errorClass: string; stack: string }>("stages/preproduction/attempt-1.meta.json");
    expect(meta?.errorClass).toBe("PROVIDER_FAILED");
    expect(meta?.stack).toContain("stage-runner.test.ts");
    const manifest = await store.readManifest();
    expect(manifest?.ledger.preproduction?.status).toBe("failed");
    const events = await store.readEvents();
    expect(events.map((e) => e.kind)).toContain("stage.failed");
  });

  it("重跑开新 attempt：第 2 次尝试独立落盘，attempt-1 不被覆盖", async () => {
    const ledger = new FakeLedger();
    const runner = new StageRunner(store, ledger, "RUN-3");

    await runner.run("preproduction", { intent: "1" }, async () => ({ output: { ok: 1 } }));
    await runner.run("preproduction", { intent: "2" }, async () => ({ output: { ok: 2 } }));

    expect(ledger.claims.map((c) => c.attempt)).toEqual([1, 2]);
    const first = await store.readJson<{ input: { intent: string } }>("stages/preproduction/attempt-1.input.json");
    const second = await store.readJson<{ input: { intent: string } }>("stages/preproduction/attempt-2.input.json");
    expect(first?.input.intent).toBe("1");
    expect(second?.input.intent).toBe("2");
    expect((await store.listAttempts("preproduction")).map((row) => row.attempt)).toEqual([1, 2]);
  });

  it("台账不可用：档案仍落文件、主流程照常返回（旁路不阻断）", async () => {
    const broken: StageLedgerWriter = {
      claimRun: async () => {
        throw new Error("connect ECONNREFUSED 127.0.0.1:5432");
      },
      finishRun: async () => {
        throw new Error("still down");
      },
      nextAttempt: async () => 1,
    };
    const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);

    const runner = new StageRunner(store, broken, "RUN-4");
    await expect(runner.run("preproduction", { intent: "x" }, async () => ({ output: { ok: true } }))).resolves.toEqual({
      ok: true,
    });
    expect(errors.mock.calls.some((call) => String(call[0]).includes("台账认领失败"))).toBe(true);
    const input = await store.readJson<{ attempt: number }>("stages/preproduction/attempt-1.input.json");
    expect(input?.attempt).toBe(1);
  });

  it("环节自评 failed（跑完但业务未成功）：产物照落、台账记 failed + 分类", async () => {
    const ledger = new FakeLedger();
    const runner = new StageRunner(store, ledger, "RUN-5");

    const output = await runner.run("preproduction", { intent: "x" }, async () => ({
      output: { success: false, failureMessage: "producer-rejected(G2_THEME · score=0)" },
      outcome: { status: "failed" as const, errorClass: "GATE_REJECTED", errorMsg: "producer-rejected(G2_THEME)" },
    }));

    expect(output.success).toBe(false);
    const finished = ledger.finished[0]!;
    expect(finished.status).toBe("failed");
    expect(finished.errorClass).toBe("GATE_REJECTED");
    expect(finished.outputRef).toBe("stages/preproduction/attempt-1.output.json"); // 产物先落盘
    const manifest = await store.readManifest();
    expect(manifest?.ledger.preproduction?.status).toBe("failed");
    const bundle = await store.readJson<{ openQuestions: string[] }>("context-bundle.json");
    expect(bundle?.openQuestions.join(" ")).toContain("GATE_REJECTED");
  });
});

describe("错误分类（监控聚类与 findings 归因共用口径）", () => {
  it("覆盖六族枚举且 BUG 为兜底", () => {
    expect(classifyError(new Error("fetch failed"))).toBe("NETWORK");
    expect(classifyError(new Error("LLM timeout after 60s"))).toBe("LLM_TIMEOUT");
    expect(classifyError(new Error("rate limit exceeded (429)"))).toBe("LLM_RATE_LIMIT");
    expect(classifyError(new Error("Unexpected token < in JSON"))).toBe("LLM_PARSE");
    expect(classifyError(new Error("producer_rejected(G3 · score=0.4)"))).toBe("GATE_REJECTED");
    expect(classifyError(new Error("PipelineGuard: 渲染管线检查未通过: 6 错误"))).toBe("GATE_REJECTED");
    expect(classifyError(new Error("PROVIDER_FAILED model unavailable"))).toBe("PROVIDER_FAILED");
    expect(classifyError(new Error("PROVIDER_TIMEOUT after 300s"))).toBe("PROVIDER_TIMEOUT");
    expect(classifyError(new Error("InputImageSensitiveContentDetected.PrivacyInformation"))).toBe("PROVIDER_REJECTED");
    // 规格书枚举里声明了 SESSION 却无分支（不可达）——本卡修复
    expect(classifyError(new Error("token expired: 401 unauthorized"))).toBe("SESSION");
    expect(classifyError(new Error("undefined is not a function"))).toBe("BUG");
    expect(classifyProviderError("TIMEOUT")).toBe("PROVIDER_TIMEOUT");
    expect(classifyProviderError("内容审核不通过")).toBe("PROVIDER_REJECTED");
  });

  it("newStageRunId 与 @workloom/shared#newId 同格式（SR-xxxxxxxx）", () => {
    expect(newStageRunId()).toMatch(/^SR-[0-9a-f]{8}$/);
  });
});
