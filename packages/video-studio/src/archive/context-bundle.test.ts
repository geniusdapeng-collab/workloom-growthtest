/**
 * archive/context-bundle.test.ts —— 交接包单元测试（T-2026-0926-0005：真机审计发现的重复/过期条目修复）
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ArchiveStore } from "./store.js";
import { readContextBundle, updateContextBundle } from "./context-bundle.js";

let workDir = "";
let store: ArchiveStore;

beforeEach(async () => {
  workDir = await mkdtemp(path.join(tmpdir(), "archive-bundle-"));
  store = new ArchiveStore(workDir, "ws-test", "VID-004", "marketing");
  await store.ensure({ kind: "marketing", title: "交接包用例", createdAt: "2026-09-26T13:00:00.000Z" });
});

afterEach(async () => {
  await rm(workDir, { recursive: true, force: true });
});

describe("updateContextBundle", () => {
  it("decision 历史累加，openQuestions 同环节失败时替换旧条目（不堆同义句）", async () => {
    await updateContextBundle(store, { lastStage: "preproduction", decisions: ["门 G1：放行"] });
    await updateContextBundle(store, {
      failedStage: "preproduction", errorClass: "GATE_REJECTED", errorMsg: "PipelineGuard: 7 错误",
    });
    await updateContextBundle(store, {
      failedStage: "preproduction", errorClass: "GATE_REJECTED", errorMsg: "PipelineGuard: 6 错误（重跑）",
    });

    const bundle = await readContextBundle(store);
    expect(bundle?.decisions).toContain("门 G1：放行");
    const questions = bundle?.openQuestions ?? [];
    expect(questions).toHaveLength(1); // 只有最新一轮的失败条目
    expect(questions[0]).toContain("6 错误（重跑）");
  });

  it("nextSteps 有值时整体替换（过期建议不与新建议并存）", async () => {
    await updateContextBundle(store, { lastStage: "preproduction", nextSteps: ["旧的下一步：继续 renderPoll"] });
    await updateContextBundle(store, { lastStage: "renderPoll", nextSteps: ["新的下一步：提交渲染前先修服装锚定"] });

    const bundle = await readContextBundle(store);
    const steps = bundle?.nextSteps ?? [];
    expect(steps.some((s) => s.includes("提交渲染前先修服装锚定"))).toBe(true);
    expect(steps.some((s) => s.includes("旧的下一步"))).toBe(false);
  });

  it("失败环节没有新 nextSteps 时按断点推导（调 studio.resume）", async () => {
    await updateContextBundle(store, { failedStage: "preproduction", errorClass: "GATE_REJECTED", errorMsg: "x" });
    const bundle = await readContextBundle(store);
    expect((bundle?.nextSteps ?? []).join(" ")).toContain("video.studio.resume");
  });
});
