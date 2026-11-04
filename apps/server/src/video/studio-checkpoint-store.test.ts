import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ArchiveStore, createStudioCheckpointRunner, type ProducerVerdict } from "@hyperreality/video-studio";
import { createStudioCheckpointStore, readStudioAttemptOutcome, type StudioAttemptIdentity, type StudioCheckpointRepository } from "./studio-checkpoint-store.js";
import { renderSha256 } from "./gen/compiled-request.js";

let workDir: string;
let archive: ArchiveStore;
let events: Array<Record<string, unknown>>;
let repository: StudioCheckpointRepository;
const identity: StudioAttemptIdentity = {
  tenantId: "tenant-a", workspaceId: "ws-a", projectId: "VID-continuity", projectCreatedAt: "2026-11-04T00:00:00.000Z",
  stageId: "prompt_review", runId: "RUN-first", attempt: 1, inputSha256: renderSha256("原始完整需求"), model: "deepseek-flash",
};
beforeEach(async () => {
  workDir = await realpath(await mkdtemp(path.join(tmpdir(), "studio-continuity-")));
  archive = new ArchiveStore(workDir, identity.workspaceId, identity.projectId);
  await archive.ensure();
  events = [];
  repository = {
    readPointers: async (kind, runId) => events.filter(event => event.kind === kind && event.runId === runId)
      .slice().reverse() as unknown as Awaited<ReturnType<StudioCheckpointRepository["readPointers"]>>,
    append: async (action, after) => { events.push({ action, ...after }); },
  };
});
afterEach(async () => { await rm(workDir, { recursive: true, force: true }); });

function store(runId = identity.runId, attempt = 1, priorRunId?: string, change: Partial<StudioAttemptIdentity> = {}) {
  return createStudioCheckpointStore({ identity: { ...identity, runId, attempt, ...change }, archive, repository,
    priorRunId, hasUnknownOutcome: () => false });
}
async function approved(content: string): Promise<ProducerVerdict> {
  const file = path.join(workDir, `approved-${renderSha256(content)}.md`);
  await writeFile(file, content);
  return { stage: "script", status: "passed", approved: true, via: "llm", model: identity.model, degraded: false,
    score: 92, hardFailures: [], issues: [], suggestions: [], rerun: false, reason: "与原需求一致", ms: 1,
    evidence: [{ scope: "complete-text", path: file, sha256: renderSha256(content) }] };
}

describe("正式工位断点复用与原审核绑定", () => {
  it("作者完成但断点事件写入失败时保存待对账状态，不把缺指针的产物当作可以重新付费", async () => {
    const append = repository.append;
    repository.append = async (action, after) => {
      if (after.kind === "ENGINE_SCRIPT") throw new Error("事件索引暂不可用");
      return append(action, after);
    };
    const current = store();
    await current.begin();
    const runner = createStudioCheckpointRunner(current.engine, "same seed");
    await expect(runner.run("SCRIPT", "同一输入", async () => ({ script: "实际已生成的完整工件" })))
      .rejects.toThrow("STUDIO_CHECKPOINT_WRITE_UNVERIFIED");
    await current.finishOutcome();
    expect(await readStudioAttemptOutcome({ scope: identity, projectId: identity.projectId,
      projectCreatedAt: identity.projectCreatedAt, stageId: identity.stageId, runId: identity.runId,
      attempt: identity.attempt, archive, repository })).toBe("receipt_unverified");
  });

  it("同一G3和G6审核分别绑定其多个付费工位的产物摘要", async () => {
    let calls = 0;
    const first = store();
    const current = createStudioCheckpointRunner(first.engine, "same input");
    for (const stage of ["G3_INSIGHT", "G3_PROFILE"] as const) {
      await current.run(stage, { stage }, async () => { calls++; return { stage, complete: true }; });
    }
    await first.saveGate("G3_INSIGHT", "完整G3正文", await approved("完整G3正文"), "E-g3");
    for (const stage of ["PRODUCTION", "OPENING_TITLE"] as const) {
      await current.run(stage, { stage }, async () => { calls++; return { stage, complete: true }; });
    }
    // Use a separate artifact because each native gate has its own immutable file.
    const g6 = await approved("完整G6正文");
    await first.saveGate("G6_PROMPT", "完整G6正文", g6, "E-g6");
    const resumed = createStudioCheckpointRunner(store("RUN-next", 2, identity.runId).engine, "same input");
    for (const stage of ["G3_INSIGHT", "G3_PROFILE", "PRODUCTION", "OPENING_TITLE"] as const) {
      expect(await resumed.run(stage, { stage }, async () => { calls++; return { regenerated: true }; }))
        .toEqual({ stage, complete: true });
    }
    expect(calls).toBe(4);
  });

  it("局部失败后复用已通过工位，跨两次接续仍保留原模型审核来源", async () => {
    let authorCalls = 0;
    const first = store();
    const run = createStudioCheckpointRunner(first.engine, { original: "不截短的原话" });
    await first.begin();
    expect(await run.run("G2_THEME", { input: "同一主题输入" }, async () => { authorCalls++; return { theme: "原主题" }; }))
      .toEqual({ theme: "原主题" });
    const verdict = await approved("已审核的完整主题正文");
    await first.saveGate("G2_THEME", "已审核的完整主题正文", verdict, "E-original");
    await first.finishOutcome();

    const second = store("RUN-second", 2, identity.runId);
    const resumed = createStudioCheckpointRunner(second.engine, { original: "不截短的原话" });
    expect(await resumed.run("G2_THEME", { input: "同一主题输入" }, async () => { authorCalls++; return { theme: "新主题" }; }))
      .toEqual({ theme: "原主题" });
    const gate = await second.loadGate("G2_THEME", "已审核的完整主题正文");
    expect(gate).toMatchObject({ originRunId: identity.runId, reviewEventId: "E-original", verdict: { score: 92 } });
    await second.saveGate("G2_THEME", "已审核的完整主题正文", gate!.verdict, gate!.reviewEventId, gate!.originRunId);
    await second.finishOutcome();

    const third = createStudioCheckpointRunner(store("RUN-third", 3, "RUN-second").engine, { original: "不截短的原话" });
    await third.run("G2_THEME", { input: "同一主题输入" }, async () => { authorCalls++; return {}; });
    expect(await store("RUN-third", 3, "RUN-second").loadGate("G2_THEME", "已审核的完整主题正文"))
      .toMatchObject({ originRunId: identity.runId, reviewEventId: "E-original" });
    expect(authorCalls).toBe(1);
    expect(events.filter(event => event.kind === "ENGINE_G2_THEME")).toHaveLength(3);
  });

  it("被打回的工位重新生成，未审核的工位不能因为有文件直接采纳", async () => {
    const first = createStudioCheckpointRunner(store().engine, "same seed");
    await first.run("G2_THEME", "input", async () => ({ theme: "失败主题" }));
    const next = createStudioCheckpointRunner(store("RUN-next", 2, identity.runId).engine, "same seed");
    expect(await next.run("G2_THEME", "input", async () => ({ theme: "重新修订" }))).toEqual({ theme: "重新修订" });
  });

  it("声明通过但供应商结果未知的矛盾裁决不能保存为可复用审批", async () => {
    const current = store();
    await current.begin();
    await current.saveGate("G2_THEME", "完整主题正文", { ...await approved("完整主题正文"), unknownOutcome: true }, "E-unresolved");
    await current.finishOutcome();
    expect(events.some(event => event.kind === "GATE_G2_THEME")).toBe(false);
    expect(await store("RUN-next", 2, identity.runId).loadGate("G2_THEME", "完整主题正文")).toBeNull();
    expect(await readStudioAttemptOutcome({ scope: identity, projectId: identity.projectId,
      projectCreatedAt: identity.projectCreatedAt, stageId: identity.stageId, runId: identity.runId,
      attempt: identity.attempt, archive, repository })).toBe("unknown");
  });

  it.each([
    { inputSha256: renderSha256("需求已经变更") },
    { projectCreatedAt: "2026-11-05T00:00:00.000Z" },
    { tenantId: "tenant-other" },
    { model: "different-model" },
  ])("需求、项目代次、租户或模型变化会使断点失效 %j", async change => {
    await store().saveValue("SCRIPT_INPUT", { approved: "old" });
    expect(await store("RUN-next", 2, identity.runId, change).loadValue("SCRIPT_INPUT")).toBeNull();
  });

  it("文件字节被改后停止，不调用作者补一个新文件掩盖证据漂移", async () => {
    await store().saveValue("SCRIPT_INPUT", { content: "原文" });
    const pointer = events[0]!;
    await writeFile(path.join(archive.root, String(pointer.ref)), "{\"tampered\":true}");
    await expect(store("RUN-next", 2, identity.runId).loadValue("SCRIPT_INPUT")).rejects.toThrow("断点字节与事件摘要不一致");
  });

  it("旧审核正文变化时拒绝沿用已通过的分数", async () => {
    const verdict = await approved("完整原正文");
    await store().saveGate("G2_THEME", "完整原正文", verdict, "E-original");
    const next = store("RUN-next", 2, identity.runId);
    expect(await next.loadGate("G2_THEME", "改动后的正文")).toBeNull();
    await writeFile(verdict.evidence![0]!.path, "被改过的证据");
    await expect(next.loadGate("G2_THEME", "完整原正文")).rejects.toThrow("原审核证据已变化");
  });

  it("已有请求未知时保留未知标记，完成时间不会把它改成已结算", async () => {
    const current = store();
    await current.begin();
    const outcome = () => readStudioAttemptOutcome({ scope: identity, projectId: identity.projectId,
      projectCreatedAt: identity.projectCreatedAt, stageId: identity.stageId, runId: identity.runId,
      attempt: identity.attempt, archive, repository });
    expect(await outcome()).toBe("dispatching");
    current.markUnknown();
    await current.finishOutcome();
    expect(await outcome()).toBe("unknown");
    const saved = await readFile(path.join(archive.root, String(events.at(-1)!.ref)), "utf8");
    expect(JSON.parse(saved).payload).toEqual({ state: "unknown" });
  });

  it("已核实的失败可保存已结算标记；旧项目没有标记时明确返回缺失", async () => {
    const current = store();
    await current.begin();
    await current.finishOutcome();
    const request = { scope: identity, projectId: identity.projectId, projectCreatedAt: identity.projectCreatedAt,
      stageId: identity.stageId, runId: identity.runId, attempt: 1, archive, repository };
    expect(await readStudioAttemptOutcome(request)).toBe("known");
    expect(await readStudioAttemptOutcome({ ...request, runId: "RUN-legacy" })).toBeNull();
  });
});
