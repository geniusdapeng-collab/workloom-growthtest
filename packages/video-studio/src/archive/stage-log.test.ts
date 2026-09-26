/**
 * archive/stage-log.test.ts —— 一次性环节记账单元测试（T-2026-0926-0002）
 * 覆盖：done 路径（attempt + 产物 sha）、skipped 不新开 attempt、台账不可用时不抛错（旁路不阻断）。
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ArchiveStore } from "./store.js";
import type { StageLedgerWriter, StageStatus } from "./stage-runner.js";
import { logStageOutcome } from "./stage-log.js";

class FakeLedger implements StageLedgerWriter {
  claims = 0;
  finished: Array<{ stageId: string; attempt: number; status: StageStatus; outputRef: string | null }> = [];

  async claimRun(row: { stageId: string; inputRefTemplate: string }): Promise<{ attempt: number; inputRef: string }> {
    this.claims += 1;
    return { attempt: this.claims, inputRef: row.inputRefTemplate.replace("{attempt}", String(this.claims)) };
  }

  async finishRun(row: { stageId: string; attempt: number; status: StageStatus; outputRef: string | null }): Promise<void> {
    this.finished.push({ stageId: row.stageId, attempt: row.attempt, status: row.status, outputRef: row.outputRef });
  }

  async nextAttempt(): Promise<number> {
    return this.claims + 1;
  }
}

let workDir = "";
let store: ArchiveStore;

beforeEach(async () => {
  workDir = await mkdtemp(path.join(tmpdir(), "archive-stage-log-"));
  store = new ArchiveStore(workDir, "ws-test", "VID-003");
  await store.ensure();
});

afterEach(async () => {
  await rm(workDir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe("logStageOutcome", () => {
  it("done：认领 attempt + 产物先落盘 + 台账 done + manifest 账本 + 事件", async () => {
    const ledger = new FakeLedger();
    const result = await logStageOutcome(store, ledger, {
      stageId: "renderPoll",
      status: "done",
      input: { jobId: "RJ-1" },
      output: { jobId: "RJ-1", assetId: "VA-1", actualCny: 1.23 },
      cost: { cashCny: 1.23 },
    });

    expect(result.attempt).toBe(1);
    expect(result.outputRef).toBe("stages/renderPoll/attempt-1.output.json");
    expect(result.outputSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(ledger.finished).toEqual([
      { stageId: "renderPoll", attempt: 1, status: "done", outputRef: "stages/renderPoll/attempt-1.output.json" },
    ]);
    const output = await store.readJson<{ jobId: string }>("stages/renderPoll/attempt-1.output.json");
    expect(output?.jobId).toBe("RJ-1");
    const manifest = await store.readManifest();
    expect(manifest?.ledger.renderPoll?.status).toBe("done");
    expect((await store.readEvents()).map((e) => e.kind)).toEqual(["stage.done"]);
  });

  it("skipped（幂等命中）：不新开 attempt，只留事件", async () => {
    const ledger = new FakeLedger();
    const result = await logStageOutcome(store, ledger, {
      stageId: "renderSubmit",
      status: "skipped",
      skipReason: "idempotency-key 命中既有 job",
      output: { jobId: "RJ-OLD", deduped: true },
    });

    expect(result.attempt).toBeNull();
    expect(ledger.claims).toBe(0);
    expect(ledger.finished).toHaveLength(0);
    const events = await store.readEvents();
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ kind: "stage.skipped", stageId: "renderSubmit", jobId: "RJ-OLD" });
  });

  it("failed：记错误分类与摘要（截断 500 字）", async () => {
    const ledger = new FakeLedger();
    const result = await logStageOutcome(store, ledger, {
      stageId: "renderPoll",
      status: "failed",
      output: { jobId: "RJ-2", provider: "seedance" },
      errorClass: "PROVIDER_TIMEOUT",
      errorMsg: "x".repeat(900),
    });
    expect(result.attempt).toBe(1);
    expect(ledger.finished[0]?.status).toBe("failed");
    const manifest = await store.readManifest();
    expect(manifest?.ledger.renderPoll?.status).toBe("failed");
  });

  it("台账不可用：不抛错，档案仍落盘（旁路不阻断）", async () => {
    const broken: StageLedgerWriter = {
      claimRun: async () => {
        throw new Error("connect ECONNREFUSED");
      },
      finishRun: async () => {
        throw new Error("connect ECONNREFUSED");
      },
      nextAttempt: async () => 1,
    };
    const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const result = await logStageOutcome(store, broken, {
      stageId: "renderPoll",
      status: "done",
      output: { jobId: "RJ-3" },
    });
    expect(result.error).toContain("ECONNREFUSED");
    expect(errors.mock.calls.length).toBeGreaterThan(0);
    expect(await store.readJson("stages/renderPoll/attempt-1.output.json")).toEqual({ jobId: "RJ-3" });
  });
});
