/**
 * archive/stage-runner.test.ts —— 环节执行器单元测试（T-2026-0926-0001）
 * 覆盖：5 写盘点 / attempt 原子认领口径 / 失败现场固化 / 原样上抛 / 错误分类 / 关键回执失败关闭。
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

  it("认领失败不执行，也不回退 attempt=1 覆盖历史档案", async () => {
    const ledger = new FakeLedger();
    const boom = new Error("connect ECONNREFUSED 127.0.0.1:5432");
    vi.spyOn(ledger, "claimRun").mockRejectedValue(boom);
    const fn = vi.fn(async () => ({ output: { ok: true } }));
    const runner = new StageRunner(store, ledger, "RUN-4");
    await expect(runner.run("preproduction", {}, fn)).rejects.toBe(boom);
    expect(fn).not.toHaveBeenCalled();
    expect(ledger.finished).toHaveLength(0);
    expect(await store.readJson("stages/preproduction/attempt-1.input.json")).toBeNull();
    expect(runner.currentContext()).toBeNull();
  });

  it.each([
    { attempt: 0, inputRef: "stages/preproduction/attempt-0.input.json" },
    { attempt: 1.5, inputRef: "stages/preproduction/attempt-1.5.input.json" },
    { attempt: 1, inputRef: "stages/preproduction/attempt-2.input.json" },
  ])("非法认领回执拒绝执行：%j", async (claim) => {
    const ledger = new FakeLedger();
    vi.spyOn(ledger, "claimRun").mockResolvedValue(claim);
    const fn = vi.fn(async () => ({ output: {} }));
    await expect(new StageRunner(store, ledger, null).run("preproduction", {}, fn)).rejects.toThrow("STAGE_CLAIM_INVALID");
    expect(fn).not.toHaveBeenCalled();
  });

  it.each(["input", "output"])("%s 写盘失败不会产生成功回执", async (point) => {
    const ledger = new FakeLedger();
    const write = store.writeJsonAtomic.bind(store);
    vi.spyOn(store, "writeJsonAtomic").mockImplementation((rel, value) => {
      if (rel.endsWith(`.${point}.json`)) throw new Error(`${point}-disk-full`);
      return write(rel, value);
    });
    const fn = vi.fn(async () => ({ output: { ok: true } }));
    const runner = new StageRunner(store, ledger, null);
    await expect(runner.run("preproduction", {}, fn)).rejects.toThrow(`${point}-disk-full`);
    expect(fn).toHaveBeenCalledTimes(point === "input" ? 0 : 1);
    expect(ledger.finished).toEqual([expect.objectContaining({ status: point === "input" ? "failed" : "interrupted", outputRef: null, errorClass: point === "input" ? "BUG" : "RECEIPT_UNVERIFIED" })]);
    expect(runner.currentContext()).toBeNull();
  });

  it("完成回执确认失败保留产物并报告待核实，不能返回成功或再次执行", async () => {
    const ledger = new FakeLedger();
    const boom = new Error("commit acknowledgement lost");
    const finish = vi.spyOn(ledger, "finishRun").mockRejectedValueOnce(boom);
    const fn = vi.fn(async () => ({ output: { ok: true } }));
    const runner = new StageRunner(store, ledger, null);
    await expect(runner.run("preproduction", {}, fn)).rejects.toBe(boom);
    expect(fn).toHaveBeenCalledTimes(1);
    expect(finish.mock.calls[1]?.[0]).toMatchObject({
      status: "interrupted", errorClass: "RECEIPT_UNVERIFIED",
      outputRef: "stages/preproduction/attempt-1.output.json", outputSha256: expect.stringMatching(/^[0-9a-f]{64}$/),
    });
    expect((await store.readManifest())?.ledger.preproduction?.status).toBe("interrupted");
    expect(runner.currentContext()).toBeNull();
  });

  it("日志与观察钩子报错不伪造业务失败，也不阻止关键回执", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.spyOn(store, "appendJsonl").mockRejectedValue(new Error("log unavailable"));
    const ledger = new FakeLedger();
    const runner = new StageRunner(store, ledger, null, {
      onStart: () => { throw new Error("observer-start"); },
      onFinish: () => { throw new Error("observer-finish"); },
    });
    await expect(runner.run("preproduction", {}, async () => ({ output: { ok: true } }))).resolves.toEqual({ ok: true });
    expect(ledger.finished[0]?.status).toBe("done");
    expect(runner.currentContext()).toBeNull();
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

  it("ctx.writeArtifact：提示词包等附属产物落档案并返回摘要（D3 修复）", async () => {
    const ledger = new FakeLedger();
    const runner = new StageRunner(store, ledger, "RUN-6");
    const pack = {
      stageId: "preproduction",
      attempt: 1,
      shotCount: 2,
      shots: [
        { shotId: "SC-1", prompt: "【导演指令】…", promptCharCount: 1200, fields: { scene: "办公室" } },
        { shotId: "SC-2", prompt: "【导演指令】…", promptCharCount: 1100, fields: { scene: "地铁" } },
      ],
    };

    const output = await runner.run("preproduction", { intent: "x" }, async (ctx) => {
      const written = await ctx.writeArtifact(`stages/preproduction/attempt-${ctx.attempt}.prompts.json`, pack);
      return { output: { success: true, promptsSha256: written?.sha256 ?? null } };
    });

    expect(String(output.promptsSha256)).toMatch(/^[0-9a-f]{64}$/);
    const saved = await store.readJson<{ shotCount: number; shots: Array<{ shotId: string }> }>(
      "stages/preproduction/attempt-1.prompts.json",
    );
    expect(saved?.shotCount).toBe(2);
    expect(saved?.shots.map((s) => s.shotId)).toEqual(["SC-1", "SC-2"]);
  });

  it("ctx.writeArtifact：超预算时按 shrink 裁剪并标记 truncated，不丢整包", async () => {
    const ledger = new FakeLedger();
    const runner = new StageRunner(store, ledger, "RUN-7");
    // fields 明细是体积主因（真实提示词包里 fields 远大于 prompt 之外的结构体）
    const big = { shots: [{ shotId: "SC-1", prompt: "x".repeat(100), fields: { blob: "y".repeat(2_000) } }] };

    await runner.run("preproduction", { intent: "x" }, async (ctx) => {
      const written = await ctx.writeArtifact("stages/preproduction/attempt-1.prompts.json", big, {
        maxBytes: 800,
        shrink: (data) => ({
          ...(data as Record<string, unknown>),
          fieldsTrimmed: true,
          shots: (data as { shots: Array<Record<string, unknown>> }).shots.map((s) => ({ ...s, fields: null })),
        }),
      });
      expect(written?.truncated).toBe(true);
      return { output: { ok: true } };
    });

    const saved = await store.readJson<{ fieldsTrimmed?: boolean; shots: Array<{ fields: unknown; prompt: string }> }>(
      "stages/preproduction/attempt-1.prompts.json",
    );
    expect(saved?.fieldsTrimmed).toBe(true);
    expect(saved?.shots[0]?.fields).toBeNull();
    expect(saved?.shots[0]?.prompt).toHaveLength(100); // 提示词全文保留，只裁明细
  });

  it("ctx.writeArtifact：shrink 后仍超预算 → 只留摘要（truncated 标记明确）", async () => {
    const ledger = new FakeLedger();
    const runner = new StageRunner(store, ledger, "RUN-8");
    await runner.run("preproduction", { intent: "x" }, async (ctx) => {
      const written = await ctx.writeArtifact("stages/preproduction/attempt-1.prompts.json", { shots: [{ prompt: "z".repeat(2_000) }] }, {
        maxBytes: 300,
        shrink: (data) => data, // 没有可用裁剪手段
      });
      expect(written?.truncated).toBe(true);
      return { output: { ok: true } };
    });
    const saved = await store.readJson<{ truncated?: boolean; note?: string }>(
      "stages/preproduction/attempt-1.prompts.json",
    );
    expect(saved?.truncated).toBe(true);
    expect(saved?.note ?? "").toContain("预算");
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
