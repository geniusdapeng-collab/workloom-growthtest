/**
 * T-2026-0927-0013：真实 startRun + StageRunner + ArchiveStore 回归。
 * vendor、PG、媒体登记用边界替身；档案写盘与重试/终态/商品摘要走实际代码。
 */
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { createHash, randomBytes } from "node:crypto";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { gatewayAppend, gatewayAppendOnClient } from "@workloom/base/workdata";
import { applyScenePolicy, auditScenePolicy, loadScenePolicies, type ScenePolicyShot } from "@hyperreality/video-studio";
import { verifyScenePolicyProductionSource } from "./scene-policy-render-gate.js";

const doubles = vi.hoisted(() => ({
  workDir: "",
  runPreproduction: vi.fn(),
  ingest: vi.fn(),
  project: vi.fn(),
  finish: vi.fn(),
  release: vi.fn(),
  uninstall: vi.fn(),
  nextAttempt: 0,
  lease: vi.fn(),
  meta: vi.fn(),
  detach: vi.fn(),
  review: vi.fn(),
  prepare: vi.fn(),
  restoreMarketing: vi.fn(),
  finalize: vi.fn(),
  verifyMarketingFacts: vi.fn(),
  dataMiningExecutor: vi.fn(),
  studioConfigs: [] as Array<Record<string, any>>,
  emitGates: true,
  connect: vi.fn(),
  query: vi.fn(),
  releaseDb: vi.fn(),
  checkpointEvents: [] as Array<Record<string, any>>,
}));

vi.mock("@workloom/db", () => ({ getAppPool: () => ({ connect: doubles.connect }), getGatewayPool: () => ({}) }));
vi.mock("@workloom/base/model-router", async (importOriginal) => ({
  ...await importOriginal<typeof import("@workloom/base/model-router")>(),
  GatewayEventSink: class {}, poolFromEnv: () => new Map(),
}));
/**
 * GR-02（2026-09-29 第二次修复）：号源改为共享的 `insertWithReadableId`（纯 nextval + SAVEPOINT 换号）。
 * 这里按真实契约实现 stub：取号 SQL 仍走 mock 的 `video_projects_max_vid_no()`（返回 9000），
 * 于是项目号 = VID-9000（**不再 +1**；旧实现在调用点 +1 得到 VID-9001）。
 */
vi.mock("@workloom/base/workdata", async () => {
  const { makeReadableId } = await import("@workloom/shared");
  return {
    gatewayAppend: vi.fn(),
    gatewayAppendOnClient: vi.fn(),
    VIDEO_PROJECT_ID_SOURCE: { prefix: "VID", nextNumberSql: "public.video_projects_max_vid_no()", label: "视频项目号 VID-*" },
    insertWithReadableId: async (
      client: { query: (sql: string, params?: unknown[]) => Promise<{ rows: Array<{ n: string | number }> }> },
      source: { prefix: string; nextNumberSql: string },
      insert: (id: string) => Promise<unknown>,
    ) => {
      const r = await client.query(`SELECT ${source.nextNumberSql} AS n`);
      const id = makeReadableId(source.prefix, Number(r.rows[0]!.n));
      return { id, value: await insert(id) };
    },
  };
});
vi.mock("../service/llm.js", () => ({ modelPolicyFor: () => undefined }));
vi.mock("./marketing-authority.js", async importOriginal => ({
  ...await importOriginal<typeof import("./marketing-authority.js")>(),
  prepareMarketingFacts: doubles.prepare, restoreMarketingFacts: doubles.restoreMarketing,
  finalizeMarketingFacts: doubles.finalize, verifyMarketingFacts: doubles.verifyMarketingFacts,
}));
vi.mock("./data-mining-executor.js", async importOriginal => ({
  ...await importOriginal<typeof import("./data-mining-executor.js")>(),
  createDataMiningExecutor: doubles.dataMiningExecutor,
}));
vi.mock("./media/library.js", () => ({ ingestPortraitsFromIndex: doubles.ingest }));
vi.mock("./media/products.js", () => ({ upsertProductProfileFromDossier: doubles.project }));
vi.mock("./archive-host.js", () => ({
  archiveWorkDir: () => doubles.workDir,
  acquireProjectLease: doubles.lease,
  readProjectMeta: doubles.meta,
  scopedRows: async (_scope: unknown, sql: string, params: unknown[] = []) => {
    if (sql.includes("video.studio.checkpoint.saved")) {
      const [workspaceId, tenantId, projectId, kind, runId] = params;
      return doubles.checkpointEvents.filter(event => event.workspaceId === workspaceId && event.tenantId === tenantId
        && event.projectId === projectId && event.kind === kind && event.runId === runId).slice().reverse();
    }
    return (await doubles.query(sql, params)).rows;
  },
  makeLedgerWriter: () => ({
    claimRun: async (row: { inputRefTemplate: string }) => {
      const attempt = ++doubles.nextAttempt;
      return { attempt, inputRef: row.inputRefTemplate.replace("{attempt}", String(attempt)) };
    },
    finishRun: doubles.finish,
    heartbeatRun: async () => undefined,
    nextAttempt: async () => doubles.nextAttempt + 1,
  }),
}));
vi.mock("@hyperreality/video-studio", async (importOriginal) => ({
  ...await importOriginal<typeof import("@hyperreality/video-studio")>(),
  VideoStudio: class {
    constructor(private readonly config: { onApproval: (input: Record<string, unknown>) => Promise<unknown> }) { doubles.studioConfigs.push(config); }
    async runPreproduction(...args: unknown[]) {
      const result = await doubles.runPreproduction(...args);
      if (result.success && doubles.emitGates) for (const gate of ["G2_THEME", "G3_INSIGHT", "G4_PRD", "G6_PROMPT", "G7_FINAL"]) {
        await this.config.onApproval({ gate, vendorType: "test-gate", runId: "vendor-run", title: "完整确认单", contentMd: "具体场景、角色、动作与镜头交付标准。".repeat(20) });
      }
      return result;
    }
  },
  reviewStage: doubles.review,
  WorkloomLLMEngine: { fromEnv: () => ({ model: "test-author", hasUnknownOutcome: () => false,
    attachRouter: vi.fn(), attachConfiguredRouter: vi.fn() }) },
  withVendorEngineBridge: (_engine: unknown, run: () => Promise<unknown>) => run(),
  withVendorPortraitBindingBridge: async (_options: unknown, run: () => Promise<unknown>) => {
    try { return await run(); } finally { doubles.uninstall(); }
  },
  attachStructuredLog: () => doubles.detach,
}));

let worker: typeof import("./studio-worker.js");
const scope = { tenantId: "tenant-test", workspaceId: "ws-test" };
let projectSequence = 0;

beforeAll(async () => {
  doubles.workDir = await realpath(await mkdtemp(path.join(tmpdir(), "studio-result-")));
  worker = await import("./studio-worker.js");
});

afterAll(async () => { await rm(doubles.workDir, { recursive: true, force: true }); });
afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); });

beforeEach(() => {
  vi.clearAllMocks();
  const eventReceipt = { eventId: "EVT-studio-test", seq: 1n, hash: "a".repeat(64), deduped: false, piiHits: 0 };
  doubles.checkpointEvents.length = 0;
  vi.mocked(gatewayAppend).mockReset().mockImplementation(async (_pool, identity, event) => {
    if (event.decision.action === "video.studio.checkpoint.saved") {
      const after = event.decision.after;
      if (!after || typeof after !== "object" || Array.isArray(after)) throw new Error("断点事件夹具要求对象型after");
      doubles.checkpointEvents.push({ ...after, tenantId: identity.tenantId,
        workspaceId: identity.workspaceId, projectId: event.object.id });
    }
    return eventReceipt;
  });
  vi.mocked(gatewayAppendOnClient).mockReset().mockResolvedValue(eventReceipt);
  doubles.nextAttempt = 0;
  doubles.studioConfigs.length = 0;
  doubles.prepare.mockReset().mockImplementation(async ({ scope, root, stageId = "preproduction" }) => ({
    root, stageId, bundle: { scope, rawSha256: "a".repeat(64), productQuery: { name: "本次商品" } }, raw: { A1: {}, A2: {}, A3: {} },
    prefix: `stages/${stageId}/attempt-${scope.attempt}.marketing`,
    storeRoot: path.join(root, `stages/${stageId}/attempt-${scope.attempt}.marketing-dossier`),
    g1Content: JSON.stringify({ facts: { schemaVersion: "workloom.marketing-facts/v1", stages: [1, 2, 3], sources: [1], optionalValue: null }, scope }),
  }));
  doubles.restoreMarketing.mockReset().mockImplementation(async (prepared, { scope, stageId }) => ({
    ...structuredClone(prepared), prefix: `stages/${stageId}/attempt-${scope.attempt}.marketing`,
    storeRoot: path.join(prepared.root, `stages/${stageId}/attempt-${scope.attempt}.marketing-dossier`),
    bundle: { ...structuredClone(prepared.bundle), scope, sourceScope: prepared.bundle.sourceScope ?? prepared.bundle.scope, outputReviews: [] },
  }));
  doubles.finalize.mockReset().mockResolvedValue({ ref: "stages/preproduction/attempt-1.marketing-facts.json", sha256: "b".repeat(64) });
  doubles.verifyMarketingFacts.mockReset().mockResolvedValue(undefined);
  doubles.dataMiningExecutor.mockReset();
  doubles.emitGates = true;
  doubles.query.mockReset().mockResolvedValue({ rows: [], rowCount: 1 });
  doubles.review.mockReset().mockImplementation(async (options) => {
    const failed = options.deterministic.some((check: { hard?: boolean; pass: boolean }) => check.hard && !check.pass);
    return { stage: options.stage, status: failed ? "failed" : "passed", approved: !failed, score: failed ? 0 : 95,
      via: "llm", model: "test-judge", degraded: false, issues: [], suggestions: [], hardFailures: [], rerun: failed,
      reason: failed ? "真实证据缺失" : "完整审阅通过", ms: 1, evidence: await Promise.all(options.artifacts.map(async (artifact: { path: string; kind: string }) => ({
        path: artifact.path, sha256: createHash("sha256").update(await readFile(artifact.path)).digest("hex"), scope: artifact.kind === "image" ? "image" : "complete-text",
      }))) };
  });
  doubles.runPreproduction.mockReset();
  doubles.finish.mockResolvedValue(undefined);
  doubles.release.mockReset().mockResolvedValue(undefined);
  doubles.uninstall.mockReset();
  doubles.detach.mockReset();
  doubles.lease.mockReset().mockResolvedValue({ release: doubles.release });
  doubles.meta.mockReset().mockResolvedValue({ kind: "marketing", title: "结果完整性", threadId: "T1", createdAt: "2026-09-27T00:00:00Z" });
  doubles.ingest.mockResolvedValue({ scanned: 0, ingested: 0, deduped: 0, skipped: 0, errors: [] });
  doubles.project.mockResolvedValue({ profile: { productName: "商品", dossierSha256: "a".repeat(64) }, changed: true, heroIngested: false });
  doubles.connect.mockReset().mockResolvedValue({ query: doubles.query, release: doubles.releaseDb });
  doubles.query.mockReset().mockImplementation(async (sql: string) => ({
    rows: sql.includes("video_projects_max_vid_no") ? [{ n: 9000 }] : [], rowCount: 1,
  }));
  doubles.releaseDb.mockReset();
  vi.stubEnv("ARCHIVE_ENABLED", "1");
  vi.stubEnv("MEDIA_INGEST_ENABLED", "1");
  vi.stubEnv("HR_PORTRAIT_ENABLED", "0");
});

const success = () => ({
  success: true,
  confirmations: { theme: { approved: true, reason: "producer-approved" } },
  stages: {
    portraitStudio: { status: "skipped", reason: "no-characters-or-products" },
    scriptEngine: { report: { characters_count: 0 } },
    dataMining: { status: "completed", product_id: "product-a", data: { ok: true, reused: false, dossier: { provenance: [{ id: "source-a" }], gaps: [] } } },
    productionEngine: { shots: [{ shotId: "SC-1", prompt: "01.【场景】窗边桌面", fields: { scene: "窗边桌面" } }] },
  },
});
const commercialSuccess = () => {
  const policy = loadScenePolicies(path.resolve(import.meta.dirname, "../../../../bundles/ai-video/library/scene-policies"))
    .find((item) => item.id === "commercial-person")!;
  const specs: Array<[string[], string, string?]> = [
    [["wide", "moving"], "大场面全景，人物站在大厅中央", "缓推镜展示空间纵深"],
    [["wide"], "广角全景，人物站在空间视觉主导位"],
    [["medium", "moving"], "半身中景，人物与实体材质同框", "轨道移镜围绕访谈位"],
    [["medium"], "腰部以上中景，人物与实体墙屏同框"],
    [["medium"], "膝上中景，人物站在会客厅首层"],
    [["person-close", "moving"], "面部近景特写，神态沉稳", "轻推镜到人物双眼"],
    [["person-close"], "胸部以上人物特写，说明手势清晰"],
    [["person-close"], "面部近景，人物直视镜头"],
    [["environment-detail"], "实体羊毛经纬纹样特写与材质工艺微距"],
    [["environment-detail"], "胡桃木与大理石材质特写，人物不入镜"],
  ];
  const shots: ScenePolicyShot[] = specs.map(([tags, composition, camera], index) => {
    const shot: ScenePolicyShot = {
      shotId: `SC-${index + 1}`, duration: 4.5, policyTags: tags,
      scene: "明亮的别墅式企业会客厅首层正式访谈位",
      composition, camera_movement: camera ?? "固定访谈机位",
      costume: "合体商务正装，衣料挺括整洁",
      speechMode: tags.includes("environment-detail") ? "voice-over" : "on-camera",
      speechScene: "interview",
      dialogue: [{ speaker: "主讲人", text: "欢迎了解方案。" }],
      action: [
        "正面直视镜头，以坚定眼神和从容停掌开始口播",
        "镜头从45°侧前方看她自然微笑",
        "侧面轮廓可辨，她用一个小手势说明重点",
        "背影气场后转身，留下沉思瞬间",
      ][index] ?? "自然讲述并保持专业气质",
      ...(index === 8 ? { props: "实体羊毛交织纹样与材质工艺" } : {}),
    };
    return applyScenePolicy({ ...shot, prompt: `${shot.scene}；${shot.composition}` }, policy);
  });
  expect(auditScenePolicy({ title: "正式商务短片", shots }, policy).passed).toBe(true);
  return { ...success(), stages: { ...success().stages, productionEngine: { shots } } };
};
const rejected = () => ({
  success: false,
  confirmations: { theme: { approved: false, reason: "producer-rejected(G2_THEME)：需求冲突" } },
  stages: { creativeTheme: { title: "需要重做" } },
});

async function runToTerminal(isMarketing = true) {
  const projectId = `VID-result-${++projectSequence}`;
  if (!isMarketing) useNarrativeProject();
  const runId = worker.startRun(scope, { projectId, intent: "测试预生产结果", isMarketing });
  await vi.waitFor(() => expect(worker.getRun(runId, scope.workspaceId)?.finishedAt).not.toBeNull(), { timeout: 3_000, interval: 10 });
  const entry = worker.getRun(runId, scope.workspaceId)!;
  return { projectId, runId, entry };
}

/**
 * 上游新增 PIPELINE_KIND_MISMATCH 校验：预生产管线必须与服务项目 kind 一致。
 * 本文件默认 meta 是 marketing，叙事用例必须先声明叙事项目，否则 run 会在建档前失败。
 */
function useNarrativeProject() {
  doubles.meta.mockResolvedValue({ kind: "narrative", title: "叙事结果", threadId: "T1", createdAt: "2026-09-27T00:00:00Z" });
}

async function archiveOutput(projectId: string, attempt: number) {
  const file = path.join(doubles.workDir, "archive", scope.workspaceId, projectId, "stages", "preproduction", `attempt-${attempt}.output.json`);
  return JSON.parse(await readFile(file, "utf8")) as Record<string, unknown>;
}

describe("预生产原始结果与诚实终态", () => {
  it("并发预生产只归档当前运行日志，结束顺序不影响另一个工作区", async () => {
    useNarrativeProject();
    const scopeB = { tenantId: "tenant-logs-b", workspaceId: "ws-logs-b" };
    const projectA = `VID-log-a-${++projectSequence}`;
    const projectB = `VID-log-b-${++projectSequence}`;
    function signal() {
      let resolve!: () => void;
      const promise = new Promise<void>((done) => { resolve = done; });
      return { promise, resolve };
    }
    const a = signal();
    const b = signal();
    const aReady = signal();
    const bReady = signal();
    doubles.runPreproduction
      .mockImplementationOnce(async () => {
        console.log("run-a-private-before"); aReady.resolve();
        await a.promise; console.warn("run-a-private-after"); return rejected();
      })
      .mockImplementationOnce(async () => {
        console.log("run-b-private-before"); bReady.resolve();
        await b.promise; console.error("run-b-private-after"); return rejected();
      });
    const originals = [console.log, console.warn, console.error];
    const runA = worker.startRun(scope, { projectId: projectA, intent: "山间日出" });
    let runB: string | undefined;
    try {
      await aReady.promise;
      runB = worker.startRun(scopeB, { projectId: projectB, intent: "海边日落" });
      await bReady.promise;
      console.log("unscoped-server-log");
      a.resolve();
      await vi.waitFor(() => expect(worker.getRun(runA, scope.workspaceId)?.finishedAt).toBeTruthy());
    } finally {
      a.resolve();
      b.resolve();
      if (runB) await vi.waitFor(() => expect(worker.getRun(runB!, scopeB.workspaceId)?.finishedAt).toBeTruthy());
    }
    const [logA, logB] = await Promise.all([projectA, projectB].map((id) =>
      readFile(path.join(doubles.workDir, "logs", `${id}.log`), "utf8")));
    expect(logA).toContain("run-a-private-before");
    expect(logA).toContain("run-a-private-after");
    expect(logA).not.toMatch(/run-b-private|unscoped-server-log/);
    expect(logB).toContain("run-b-private-before");
    expect(logB).toContain("run-b-private-after");
    expect(logB).not.toMatch(/run-a-private|unscoped-server-log/);
    expect([console.log, console.warn, console.error]).toEqual(originals);
  });

  it("执行前输入快照保留原始需求与metadata供恢复，不能只保存加工正文", async () => {
    useNarrativeProject(); doubles.runPreproduction.mockResolvedValue(success());
    const projectId = `VID-resume-source-${++projectSequence}`;
    const intent = `山间风景。${"保留紫色花与自然光。".repeat(35)}`;
    const metadata = { aspectRatio: "16:9", noMusic: true, brief: { audience: "游客" } };
    const runId = worker.startRun(scope, { projectId, intent, rawIntent: "用户原话", metadata });
    await vi.waitFor(() => expect(worker.getRun(runId, scope.workspaceId)?.finishedAt).not.toBeNull(), { timeout: 3_000, interval: 10 });
    const file = path.join(doubles.workDir, "archive", scope.workspaceId, projectId, "stages/preproduction/attempt-1.input.json");
    const saved = JSON.parse(await readFile(file, "utf8"));
    expect(saved.input.resumeInput).toMatchObject({ schemaVersion: "workloom.studio-resume-input/v1", ...scope, projectId,
      intent, rawIntent: "用户原话", metadata, isMarketing: false, requiresDelegation: false });
  });

  it("建项目之前拦截显式未知片型，未触及数据库和供应商", async () => {
    await expect(worker.startVideoProjectRun(scope, {
      intent: "给陈卓拍一条正式商务短片",
      metadata: { scenePolicy: { id: "not-installed" } },
      by: { id: "MEM-1", type: "human" },
    })).rejects.toThrow(/未知片型/);
    await expect(worker.startVideoProjectRun(scope, {
      intent: "做一条母婴亲子短片",
      by: { id: "MEM-1", type: "human" },
    })).rejects.toThrow(/没有可核实的已安装片型知识条目/);
    expect(doubles.connect).not.toHaveBeenCalled();
    expect(doubles.runPreproduction).not.toHaveBeenCalled();
  });

  it("分流器加工出的 brief 不充当客户原始选型证据", async () => {
    doubles.runPreproduction.mockResolvedValue(success());
    const started = await worker.startVideoProjectRun(scope, {
      rawIntent: "拍一条山间日出风景片",
      intent: "拍一条山间日出风景片\n[需求口径] 时长：30秒",
      customerMetadata: null,
      metadata: { brief: { product: "企业负责人" }, pipelineRoute: { kind: "marketing" } },
      isMarketing: true,
      creativeMode: "manual",
      by: { id: "MEM-1", type: "human" },
    });
    await vi.waitFor(() => expect(worker.getRun(started.runId, scope.workspaceId)?.finishedAt).not.toBeNull(), { timeout: 3_000, interval: 10 });
    expect(doubles.runPreproduction.mock.calls[0]?.[0].metadata).toMatchObject({
      brief: { product: "企业负责人" }, scenePolicySelection: { id: null },
    });
  });

  it("原始需求选出的 T1 进入建档事件、routeMeta、供应商入参与分镜/提示词包", async () => {
    doubles.runPreproduction.mockResolvedValue(commercialSuccess());
    useNarrativeProject();
    const started = await worker.startVideoProjectRun(scope, {
      rawIntent: "给企业负责人拍正式商务短片，陈卓出镜口播",
      intent: "给企业负责人拍短片\n[需求口径] 时长：30秒",
      metadata: { brief: { audience: "企业负责人" } },
      isMarketing: false,
      creativeMode: "manual",
      by: { id: "MEM-1", type: "human" },
    });
    await vi.waitFor(() => expect(worker.getRun(started.runId, scope.workspaceId)?.finishedAt).not.toBeNull(), { timeout: 3_000, interval: 10 });
    expect(worker.getRun(started.runId, scope.workspaceId)?.status).toBe("finished");
    const creation = vi.mocked(gatewayAppendOnClient).mock.calls.find(([, , event]) => event.decision.action === "video.project.create");
    expect(creation?.[2].decision.after).toMatchObject({ scenePolicy: { id: "commercial-person", evidence: expect.any(Array) } });
    const selectionEvent = vi.mocked(gatewayAppend).mock.calls.find(([, , event]) => event.decision.action === "video.scene_policy.selected");
    expect(selectionEvent?.[2].decision.after).toMatchObject({ id: "commercial-person", runId: started.runId });
    const runInput = doubles.runPreproduction.mock.calls[0]?.[0];
    expect(runInput.intent).toContain("[片型制作规范 commercial-person@");
    expect(runInput.metadata.scenePolicy).toMatchObject({ id: "commercial-person" });
    const dir = path.join(doubles.workDir, "archive", scope.workspaceId, started.projectId);
    const manifest = JSON.parse(await readFile(path.join(dir, "manifest.json"), "utf8"));
    const prompts = JSON.parse(await readFile(path.join(dir, "stages/preproduction/attempt-1.prompts.json"), "utf8"));
    const shotlist = JSON.parse(await readFile(path.join(dir, "stages/preproduction/attempt-1.shotlist.json"), "utf8"));
    expect(manifest.routeMeta.scenePolicy).toMatchObject({ id: "commercial-person" });
    expect(prompts.scenePolicy).toMatchObject({ id: "commercial-person" });
    expect(shotlist).toMatchObject({ scenePolicy: { id: "commercial-person" }, draft: true });
    expect(shotlist.shots).toHaveLength(10);
    const reportBytes = await readFile(path.join(dir, "stages/preproduction/attempt-1.scene-policy-report.json"));
    const shotlistBytes = await readFile(path.join(dir, "stages/preproduction/attempt-1.shotlist.json"));
    const report = JSON.parse(reportBytes.toString("utf8"));
    expect(report).toMatchObject({ passed: true, totalSeconds: 45 });
    const output = await archiveOutput(started.projectId, 1);
    expect(createHash("sha256").update(reportBytes).digest("hex")).toBe(output.scenePolicyReportSha256);
    expect(createHash("sha256").update(shotlistBytes).digest("hex")).toBe(output.shotlistSha256);
    const policy = loadScenePolicies(path.resolve(import.meta.dirname, "../../../../bundles/ai-video/library/scene-policies"))
      .find((item) => item.id === "commercial-person")!;
    expect(verifyScenePolicyProductionSource({
      decision: manifest.routeMeta.scenePolicy, policy,
      projectId: started.projectId, attempt: 1, shotId: "SC-1", output, prompts, report, shotlist,
    })).toMatchObject({ policyId: "commercial-person", shotId: "SC-1", attempt: 1 });
  });

  it("供应商返回不合规镜头表时报告落档并在渲染前打回", async () => {
    doubles.runPreproduction.mockResolvedValue(success());
    useNarrativeProject();
    const started = await worker.startVideoProjectRun(scope, {
      rawIntent: "给企业负责人拍正式商务短片，陈卓出镜口播",
      intent: "给企业负责人拍短片",
      creativeMode: "manual",
      by: { id: "MEM-1", type: "human" },
    });
    await vi.waitFor(() => expect(worker.getRun(started.runId, scope.workspaceId)?.finishedAt).not.toBeNull(), { timeout: 3_000, interval: 10 });
    expect(worker.getRun(started.runId, scope.workspaceId)?.status).toBe("failed");
    const dir = path.join(doubles.workDir, "archive", scope.workspaceId, started.projectId);
    const report = JSON.parse(await readFile(path.join(dir, "stages/preproduction/attempt-1.scene-policy-report.json"), "utf8"));
    expect(report.passed).toBe(false);
    expect(report.defects.some((item: { rule: string }) => item.rule === "ratio-min")).toBe(true);
  });

  it("既有项目补跑重新选型并留下 routeMeta 变更事件", async () => {
    doubles.runPreproduction.mockResolvedValue(success());
    useNarrativeProject();
    const projectId = `VID-route-${++projectSequence}`;
    const first = worker.startRun(scope, { projectId, intent: "山间风景片" });
    await vi.waitFor(() => expect(worker.getRun(first, scope.workspaceId)?.finishedAt).not.toBeNull(), { timeout: 3_000, interval: 10 });
    const second = worker.startRun(scope, {
      projectId, intent: "给企业负责人拍正式商务短片", rawIntent: "给企业负责人拍正式商务短片",
    });
    await vi.waitFor(() => expect(worker.getRun(second, scope.workspaceId)?.finishedAt).not.toBeNull(), { timeout: 3_000, interval: 10 });
    const dir = path.join(doubles.workDir, "archive", scope.workspaceId, projectId);
    const manifest = JSON.parse(await readFile(path.join(dir, "manifest.json"), "utf8"));
    const events = (await readFile(path.join(dir, "events.jsonl"), "utf8")).trim().split("\n").map((line) => JSON.parse(line));
    expect(manifest.routeMeta.scenePolicy.id).toBe("commercial-person");
    expect(events).toContainEqual(expect.objectContaining({
      kind: "scene-policy.route-changed",
      previous: expect.objectContaining({ id: null }),
      current: expect.objectContaining({ id: "commercial-person" }),
    }));
    expect(doubles.runPreproduction).toHaveBeenCalledTimes(2);
  });

  it("显式 VM_PRODUCER_RETRY=1 时才恢复有限重试；成功结果保留 stages.dataMining 驱动商品投影", async () => {
    vi.stubEnv("VM_PRODUCER_RETRY", "1");
    doubles.runPreproduction.mockResolvedValueOnce(rejected()).mockResolvedValueOnce(success());
    const { entry, projectId, runId } = await runToTerminal();
    expect(doubles.runPreproduction).toHaveBeenCalledTimes(2);
    expect(entry).toMatchObject({ status: "finished", error: null, resultSummary: {
      success: true, stages: ["portraitStudio", "scriptEngine", "dataMining", "productionEngine"], producerAttempts: 2,
      dataMining: { productId: "product-a", ok: true, evidenceCount: 1, gaps: 0 },
    } });
    expect(doubles.project).toHaveBeenCalledWith(expect.anything(), expect.anything(), scope, expect.objectContaining({ productId: "product-a" }));
    expect(doubles.finish.mock.calls.map(([row]) => row.status)).toEqual(["failed", "done"]);
    expect((await archiveOutput(projectId, 1)).success).toBe(false);
    expect((await archiveOutput(projectId, 2)).stages).toEqual(["portraitStudio", "scriptEngine", "dataMining", "productionEngine"]);
    const dossierRef = `archive/${scope.workspaceId}/${projectId}/stages/preproduction/attempt-2.marketing-dossier`;
    expect((await archiveOutput(projectId, 2)).dossier).toMatchObject({ root: dossierRef });
    const projectRoot = path.join(doubles.workDir, "archive", scope.workspaceId, projectId);
    const prompts = JSON.parse(await readFile(path.join(projectRoot, "stages/preproduction/attempt-2.prompts.json"), "utf8"));
    expect(prompts.dossier.root).toBe(dossierRef);
    expect(await readFile(path.join(projectRoot, "context-bundle.json"), "utf8")).toContain(dossierRef);
    expect(doubles.project.mock.calls[0]?.[3].dossierRoot).toBe(path.join(projectRoot, "stages/preproduction/attempt-2.marketing-dossier"));
    expect(worker.getRun(runId, "another-workspace")).toBeNull();
    expect(doubles.release).toHaveBeenCalledTimes(1);
    expect(doubles.uninstall).toHaveBeenCalledTimes(2);
  });

  it("默认：监制打回即停，不自动重跑（不再把 AI 打回变成重复烧钱）", async () => {
    doubles.runPreproduction.mockResolvedValue(rejected());
    const { entry } = await runToTerminal();
    expect(doubles.runPreproduction).toHaveBeenCalledTimes(1);
    expect(entry.status).toBe("failed");
    expect(entry.error).toContain("producer-rejected(G2_THEME)：需求冲突");
    expect(entry.resultSummary).toMatchObject({ success: false, producerAttempts: 1, stages: ["creativeTheme"] });
    expect(worker.summarizeWorkspaceRuns(scope.workspaceId).failedRecent).toBeGreaterThan(0);
  });

  it("业务软失败不得显示 finished", async () => {
    doubles.runPreproduction.mockResolvedValue({ success: false, errors: [{ stage: "insight", message: "来源不足" }], stages: {} });
    const { entry } = await runToTerminal();
    expect(entry).toMatchObject({ status: "failed", error: "来源不足", resultSummary: { success: false, producerAttempts: 1 } });
    expect(doubles.runPreproduction).toHaveBeenCalledTimes(1);
    expect(doubles.finish).toHaveBeenCalledTimes(1);
  });

  it("vendor 抛错保留原始错误，仍释放资源并写失败档案", async () => {
    doubles.runPreproduction.mockRejectedValue(new Error("模型请求失败"));
    const { entry } = await runToTerminal();
    expect(entry).toMatchObject({ status: "failed", error: "模型请求失败", resultSummary: null });
    expect(doubles.finish).toHaveBeenCalledWith(expect.objectContaining({ status: "failed", errorMsg: "模型请求失败" }));
    expect(doubles.release).toHaveBeenCalledTimes(1);
    expect(doubles.uninstall).toHaveBeenCalledTimes(1);
  });

  it("旧项目直接补跑不能绕过未知模型结果，拒绝发生在新attempt和供应商之前", async () => {
    useNarrativeProject();
    const projectId = `VID-unknown-direct-${++projectSequence}`;
    doubles.runPreproduction.mockRejectedValueOnce(new Error("VIDEO_MODEL_OUTCOME_UNKNOWN: 原请求最终回执丢失"));
    const firstRunId = worker.startRun(scope, { projectId, intent: "同一冻结需求" });
    await vi.waitFor(() => expect(worker.getRun(firstRunId, scope.workspaceId)?.finishedAt).not.toBeNull());
    const outcome = doubles.checkpointEvents.filter(event => event.kind === "OUTCOME").at(-1)!;
    const saved = JSON.parse(await readFile(path.join(doubles.workDir, "archive", scope.workspaceId, projectId, outcome.ref), "utf8"));
    expect(saved.payload.state).toBe("unknown");
    doubles.query.mockImplementation(async (sql: string) => ({ rows: sql.includes("SELECT attempt, input_ref")
      ? [{ run_id: firstRunId, attempt: 1, status: "failed", error_class: "MODEL_UNKNOWN",
        input_ref: "stages/preproduction/attempt-1.input.json" }] : [], rowCount: 1 }));
    doubles.runPreproduction.mockResolvedValue(success());
    const secondRunId = worker.startRun(scope, { projectId, intent: "同一冻结需求" });
    await vi.waitFor(() => expect(worker.getRun(secondRunId, scope.workspaceId)?.finishedAt).not.toBeNull());
    expect(worker.getRun(secondRunId, scope.workspaceId)).toMatchObject({ status: "failed",
      error: expect.stringContaining("STUDIO_RESUME_REQUIRED") });
    expect(doubles.nextAttempt).toBe(1);
    expect(doubles.runPreproduction).toHaveBeenCalledTimes(1);
  });

  it("已核实的失败只能携带同项目原run与attempt接续，正常续跑仍完成", async () => {
    useNarrativeProject();
    const projectId = `VID-known-resume-${++projectSequence}`;
    doubles.runPreproduction.mockResolvedValueOnce(rejected()).mockResolvedValueOnce(success());
    const firstRunId = worker.startRun(scope, { projectId, intent: "同一冻结需求" });
    await vi.waitFor(() => expect(worker.getRun(firstRunId, scope.workspaceId)?.finishedAt).not.toBeNull());
    const outcome = doubles.checkpointEvents.filter(event => event.kind === "OUTCOME").at(-1)!;
    const saved = JSON.parse(await readFile(path.join(doubles.workDir, "archive", scope.workspaceId, projectId, outcome.ref), "utf8"));
    expect(saved.payload.state).toBe("known");
    doubles.query.mockImplementation(async (sql: string) => ({ rows: sql.includes("SELECT attempt, input_ref")
      ? [{ run_id: firstRunId, attempt: 1, status: "failed", error_class: "GATE_REJECTED",
        input_ref: "stages/preproduction/attempt-1.input.json" }] : [], rowCount: 1 }));
    const nextRunId = worker.startRun(scope, { projectId, intent: "同一冻结需求",
      resumePrior: { runId: firstRunId, attempt: 1, stageId: "preproduction" } });
    await vi.waitFor(() => expect(worker.getRun(nextRunId, scope.workspaceId)?.finishedAt).not.toBeNull());
    expect(worker.getRun(nextRunId, scope.workspaceId)).toMatchObject({ status: "finished", error: null });
    expect(doubles.nextAttempt).toBe(2);
    expect(doubles.runPreproduction).toHaveBeenCalledTimes(2);
  });

  it("作者完成但断点事件未落账时，proper prior恢复也必须先对账而不能再次执行作者", async () => {
    useNarrativeProject();
    const projectId = `VID-checkpoint-unverified-${++projectSequence}`;
    const { createStudioCheckpointRunner } = await import("@hyperreality/video-studio");
    const append = vi.mocked(gatewayAppend).getMockImplementation()!;
    let eventFailure = true, authorCalls = 0;
    vi.mocked(gatewayAppend).mockImplementation(async (pool, identity, event) => {
      if (event.decision.action === "video.studio.checkpoint.saved"
        && (event.decision.after as { kind?: string }).kind === "ENGINE_SCRIPT" && eventFailure) {
        eventFailure = false;
        throw new Error("作者已完成后的断点事件写入短暂失败");
      }
      return append(pool, identity, event);
    });
    doubles.runPreproduction.mockImplementation(async () => {
      const config = doubles.studioConfigs.at(-1)!;
      const runner = createStudioCheckpointRunner(config.checkpoints, "同一冻结工位种子");
      return runner.run("SCRIPT", "同一完整输入", async () => { authorCalls++; return success(); });
    });
    const firstRunId = worker.startRun(scope, { projectId, intent: "同一冻结需求" });
    await vi.waitFor(() => expect(worker.getRun(firstRunId, scope.workspaceId)?.finishedAt).not.toBeNull());
    expect(worker.getRun(firstRunId, scope.workspaceId)?.error).toContain("STUDIO_CHECKPOINT_WRITE_UNVERIFIED");
    const outcome = doubles.checkpointEvents.filter(event => event.kind === "OUTCOME").at(-1)!;
    const saved = JSON.parse(await readFile(path.join(doubles.workDir, "archive", scope.workspaceId, projectId, outcome.ref), "utf8"));
    expect(saved.payload.state).toBe("receipt_unverified");
    doubles.query.mockImplementation(async (sql: string) => ({ rows: sql.includes("SELECT attempt, input_ref")
      ? [{ run_id: firstRunId, attempt: 1, status: "failed", error_class: "BUG",
        input_ref: "stages/preproduction/attempt-1.input.json" }] : [], rowCount: 1 }));
    const nextRunId = worker.startRun(scope, { projectId, intent: "同一冻结需求",
      resumePrior: { runId: firstRunId, attempt: 1, stageId: "preproduction" } });
    await vi.waitFor(() => expect(worker.getRun(nextRunId, scope.workspaceId)?.finishedAt).not.toBeNull());
    expect(worker.getRun(nextRunId, scope.workspaceId)).toMatchObject({ status: "failed",
      error: expect.stringContaining("PROMPT_REVIEW_PRIOR_CHANGED") });
    expect(authorCalls).toBe(1);
    expect(doubles.runPreproduction).toHaveBeenCalledTimes(1);
    expect(doubles.nextAttempt).toBe(1);
  });

  it("归档输出写入失败时，不因已取得 rawResult 而伪称成功", async () => {
    const { ArchiveStore } = await import("@hyperreality/video-studio");
    const original = ArchiveStore.prototype.writeJsonAtomic;
    vi.spyOn(ArchiveStore.prototype, "writeJsonAtomic").mockImplementation(function (this: InstanceType<typeof ArchiveStore>, relPath, data) {
      if (relPath.endsWith(".output.json")) return Promise.reject(new Error("档案磁盘写入失败"));
      return original.call(this, relPath, data);
    });
    doubles.runPreproduction.mockResolvedValue(success());
    const { entry } = await runToTerminal();
    expect(entry).toMatchObject({ status: "failed", error: "档案磁盘写入失败", resultSummary: null });
    expect(doubles.project).not.toHaveBeenCalled();
    expect(doubles.release).toHaveBeenCalledTimes(1);
    expect(doubles.uninstall).toHaveBeenCalledTimes(1);
  });

  it("禁止关闭生产档案，拒绝发生在供应商与租约调用之前", () => {
    vi.stubEnv("ARCHIVE_ENABLED", "0");
    expect(() => worker.startRun(scope, { projectId: "VID-off", intent: "x" })).toThrow("ARCHIVE_ENABLED=0");
    expect(doubles.runPreproduction).not.toHaveBeenCalled();
    expect(doubles.lease).not.toHaveBeenCalled();
  });

  it.each(["busy", "error"])("租约 %s 不会安装供应商绑定桥或无锁执行", async (failure) => {
    if (failure === "busy") doubles.lease.mockResolvedValue(null);
    else doubles.lease.mockRejectedValue(new Error("lease network failed"));
    const { entry } = await runToTerminal();
    expect(entry.status).toBe("failed");
    expect(doubles.runPreproduction).not.toHaveBeenCalled();
    expect(doubles.meta).not.toHaveBeenCalled();
    expect(doubles.finish).not.toHaveBeenCalled();
    expect(doubles.uninstall).not.toHaveBeenCalled();
    expect(doubles.release).not.toHaveBeenCalled();
  });

  it.each(["missing", "error", "archive"])("项目/档案初始化 %s 时不执行并释放租约", async (failure) => {
    if (failure === "missing") doubles.meta.mockResolvedValue(null);
    else if (failure === "error") doubles.meta.mockRejectedValue(new Error("project metadata failed"));
    else {
      const { ArchiveStore } = await import("@hyperreality/video-studio");
      vi.spyOn(ArchiveStore.prototype, "ensure").mockRejectedValue(new Error("archive failed"));
    }
    const { entry, projectId } = await runToTerminal();
    expect(entry.status).toBe("failed");
    expect(doubles.runPreproduction).not.toHaveBeenCalled();
    expect(doubles.release).toHaveBeenCalledTimes(1);
    expect(doubles.uninstall).not.toHaveBeenCalled();
    if (failure !== "archive") {
      await expect(readFile(path.join(doubles.workDir, "archive", scope.workspaceId, projectId, "context-bundle.json"))).rejects.toMatchObject({ code: "ENOENT" });
    }
  });

  it("完成回执未核实不投影商品也不自动重试", async () => {
    doubles.runPreproduction.mockResolvedValue(success());
    doubles.finish.mockRejectedValueOnce(new Error("receipt unverified"));
    const { entry } = await runToTerminal();
    expect(entry).toMatchObject({ status: "failed", error: "receipt unverified", resultSummary: null });
    expect(doubles.runPreproduction).toHaveBeenCalledTimes(1);
    expect(doubles.project).not.toHaveBeenCalled();
    expect(doubles.release).toHaveBeenCalledTimes(1);
  });

  it("绑定桥先随 vendor 退出，后续日志和解锁失败仍记录终态", async () => {
    doubles.runPreproduction.mockResolvedValue(success());
    doubles.detach.mockImplementation(() => { throw new Error("detach failed"); });
    doubles.release.mockRejectedValue(new Error("unlock failed"));
    const { entry } = await runToTerminal();
    expect(entry.status).toBe("failed");
    expect(entry.error).toContain("detach failed");
    expect(entry.error).toContain("unlock failed");
    expect(doubles.release).toHaveBeenCalledTimes(1);
    expect(doubles.uninstall).toHaveBeenCalledTimes(1);
  });

  it("失败原因兼容已有 failures 与 errorMessage，空消息回退且限制长度", () => {
    expect(worker.terminalFailureMessageOf({ errorMessage: "备用错误字段" })).toBe("备用错误字段");
    expect(worker.terminalFailureMessageOf({ failures: [{ message: "已有失败列表" }] })).toBe("已有失败列表");
    expect(worker.terminalFailureMessageOf({ error: " ", errors: [{ error: "底层错误" }] })).toBe("底层错误");
    expect(worker.terminalFailureMessageOf({}, "运行器异常")).toBe("运行器异常");
    expect(worker.terminalFailureMessageOf({ error: "x".repeat(600) })).toHaveLength(500);
    expect(worker.terminalFailureMessageOf({})).toBe("vendor 返回 success:false");
  });
  it("叙事成功档案保留本次六门证据；G5没有人物时明确不适用，G7使用prompt", async () => {
    doubles.runPreproduction.mockResolvedValue(success());
    const { entry, projectId } = await runToTerminal(false);
    expect(entry.status).toBe("finished");
    const output = await archiveOutput(projectId, 1);
    expect(output.productionEvidence).toMatchObject({ schemaVersion: "workloom.preproduction-authority/v1", issuer: "workloom.studio-worker",
      tenantId: scope.tenantId, workspaceId: scope.workspaceId, projectId, attempt: 1, pipelineKind: "narrative" });
    const proofs = (output.productionEvidence as { gates: Array<Record<string, unknown>> }).gates;
    expect(proofs).toHaveLength(6);
    expect(proofs.find(item => item.gate === "G5_PORTRAIT")).toMatchObject({ status: "not_applicable", basis: "no-characters-or-products" });
    expect(doubles.review.mock.calls.at(-1)?.[0]).toMatchObject({ stage: "prompt", context: { gate: "G7_FINAL" } });
    expect(proofs.find(item => item.gate === "G7_FINAL")?.evidence).toEqual(expect.arrayContaining([expect.objectContaining({ sha256: expect.stringMatching(/^[a-f0-9]{64}$/) })]));
  });
  it("只有vendor自报成功但没有本次服务门回执，叙事档案不得done", async () => {
    doubles.emitGates = false; doubles.runPreproduction.mockImplementation(async () => success());
    const { entry } = await runToTerminal(false);
    expect(entry.status).toBe("failed"); expect(entry.error).toContain("缺少服务监制裁决");
    expect(doubles.finish.mock.calls.every(([row]) => row.status === "failed")).toBe(true);
  });
  it("定妆照只完成计划却缺实际图片时，G5 事实核验先行失败关闭（不占用人类时间、不调 AI 评审）", async () => {
    doubles.runPreproduction.mockImplementation(async () => ({ ...success(), stages: { ...success().stages,
      portraitStudio: { status: "completed", completedPortraits: 0, pendingPortraits: 4, characters: 1, products: 0 },
      scriptEngine: { report: { characters_count: 1 } } } }));
    const { entry } = await runToTerminal(false);
    expect(entry.status).toBe("failed");
    expect(entry.error).toMatch(/portrait-evidence-failed|定妆照未完整生成/);
    /** T-2026-1001-0007：G5 不再走 AI 监制自动裁决，也不自动重出 */
    expect(doubles.review.mock.calls.some(([options]) => options.context.gate === "G5_PORTRAIT")).toBe(false);
  });

  it("G5 真实四角度图片通过事实核验后由系统自动批准，不创建人类审批行", async () => {
    useNarrativeProject();
    const projectId = `VID-g5-auto-${++projectSequence}`;
    const portraitRoot = path.join(doubles.workDir, "workspaces", scope.workspaceId, "characters", projectId);
    await mkdir(portraitRoot, { recursive: true });
    const files: Record<string, string> = {};
    for (const angle of ["front", "threeQuarter", "closeup", "side"]) {
      const file = path.join(portraitRoot, `${angle}.png`);
      await writeFile(file, Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 1, 2, 3]));
      files[angle] = file;
    }
    await writeFile(path.join(portraitRoot, "portrait-index.json"), JSON.stringify({
      schemaVersion: "workloom.portrait-index/v1",
      projectId,
      characters: { chen: { kind: "character", id: "chen", files } },
      products: {},
    }));
    doubles.runPreproduction.mockResolvedValue({
      ...success(),
      stages: {
        ...success().stages,
        portraitStudio: { status: "completed", characters: 1, products: 0, completedPortraits: 4, pendingPortraits: 0 },
        scriptEngine: { report: { characters_count: 1 } },
      },
    });
    const runId = worker.startRun(scope, { projectId, intent: "山间日出的完整叙事短片" });
    await vi.waitFor(() => expect(worker.getRun(runId, scope.workspaceId)?.finishedAt).not.toBeNull(), { timeout: 3_000, interval: 10 });
    expect(worker.getRun(runId, scope.workspaceId)?.error).toBeNull();
    expect(worker.getRun(runId, scope.workspaceId)?.status).toBe("finished");
    expect(doubles.query.mock.calls.some(([sql]) => String(sql).includes("INSERT INTO approvals"))).toBe(false);
    const output = await archiveOutput(projectId, 1);
    const proofs = (output.productionEvidence as { gates: Array<Record<string, unknown>> }).gates;
    expect(proofs.find(item => item.gate === "G5_PORTRAIT")).toMatchObject({
      approved: true,
      status: "passed",
      via: "system-auto-approval",
      policyVersion: "workloom.video-auto-approval/v1",
      approvalId: null,
    });
  });

});

describe("正式 G6 提示词工作单", () => {
  it.each(["marketing", "narrative"] as const)("%s 只签发 G6 实审字节，恢复绑定且不进入媒体链", async (kind) => {
    vi.stubEnv("WORKLOOM_RENDER_SIGNING_SECRET", randomBytes(32).toString("hex"));
    vi.stubEnv("HR_DEFER_RENDER", "0");
    vi.stubEnv("HR_PORTRAIT_ENABLED", "1");
    vi.stubEnv("VOLCENGINE_ARK_API_KEY", "synthetic-unit-test-key");
    vi.stubEnv("ARK_IMAGE_MODEL", "synthetic-unit-test-model");
    if (kind === "narrative") useNarrativeProject();
    const { readStudioPromptReview } = await import("./prompt-review-authority.js");
    const { restoreStudioResumeInput } = await import("./studio-resume-input.js");
    const { getAppPool } = await import("@workloom/db");
    const projectId = `VID-prompt-only-${++projectSequence}`;
    const rawIntent = "制作三十秒短片，保留冲线后摘盔的动作顺序，无对白";
    const prompt = `01.【场景】${"封闭赛道，安全停稳后摘下头盔。".repeat(20)}`;
    const report = `# 提示词审核报告\n| SC-1 | 28s | 330 |\n### SC-1(内容·25字段)\n\n\`\`\`markdown\n${prompt}\n\`\`\`\n`;
    let runId = "";
    doubles.emitGates = false;
    doubles.finalize.mockResolvedValue({ ref: "stages/prompt_review/attempt-1.marketing-facts.json", sha256: "b".repeat(64) });
    doubles.query.mockImplementation(async (sql: string, params: unknown[] = []) => {
      if (!sql.includes("r.stage_id='prompt_review'") || params[0] !== scope.tenantId || params[1] !== scope.workspaceId || params[2] !== projectId) {
        return { rows: [], rowCount: 0 };
      }
      const finished = doubles.finish.mock.calls.at(-1)?.[0];
      return { rows: [{ id: "SR-prompt-only", run_id: runId, attempt: 1, kind,
        status: finished?.status ?? "running", output_ref: finished?.outputRef ?? null,
        output_sha256: finished?.outputSha256 ?? null }], rowCount: 1 };
    });
    doubles.runPreproduction.mockImplementation(async () => {
      const config = doubles.studioConfigs.at(-1)!;
      expect(config).toMatchObject({ deferRender: true, portraits: { enabled: false } });
      const approval = (gate: string, contentMd: string, vendorType = "test-gate") =>
        config.onApproval({ gate, vendorType, runId: "vendor-run", title: "完整确认单", contentMd });
      for (const gate of ["G2_THEME", "G3_INSIGHT", "G4_PRD"]) {
        expect(await approval(gate, "完整原生前期说明。".repeat(20))).toMatchObject({ approved: true });
      }
      expect(await approval("G5_PORTRAIT", "已有角色和商品的参考需求", "portrait-generation"))
        .toMatchObject({ approved: false, reason: "PROMPT_REVIEW_PORTRAIT_DEFERRED" });
      config.onPromptReview([{ shotId: "SC-1", duration: 28, prompt, fields: { action: "停稳后摘盔" } }]);
      expect(await approval("G6_PROMPT", report, "prompt")).toMatchObject({ approved: true });
      const stopped = await approval("G7_FINAL", "本轮不申请整体预生产", "preproduction");
      expect(stopped).toMatchObject({ approved: false, reason: "PROMPT_REVIEW_SCOPE_REACHED" });
      return { success: false, stages: { preproductionReview: { status: "rejected", reason: stopped.reason },
        productionEngine: { shots: [{ shotId: "SC-1", prompt: "不能导出的旧版提示词" }] } } };
    });
    runId = worker.startRun(scope, { projectId, rawIntent, intent: rawIntent + "\n系统格式要求", isMarketing: kind === "marketing",
      purpose: "prompt-review", durationSec: 30 });
    await vi.waitFor(() => expect(worker.getRun(runId, scope.workspaceId)?.finishedAt).not.toBeNull(), { timeout: 3_000, interval: 10 });
    expect(worker.getRun(runId, scope.workspaceId)).toMatchObject({ status: "finished", error: null,
      resultSummary: { purpose: "prompt-review", state: "prompt_review_ready", renderAuthorized: false, plannedSeconds: 28 } });
    expect(doubles.finish).toHaveBeenCalledWith(expect.objectContaining({ stageId: "prompt_review", status: "done" }));
    expect(doubles.review.mock.calls.filter(([config]) => config.context.gate === "G6_PROMPT")[0]?.[0].context)
      .toMatchObject({ request: rawIntent, targetSeconds: 30 });
    expect(doubles.review.mock.calls.some(([config]) => ["G5_PORTRAIT", "G7_FINAL"].includes(config.context.gate))).toBe(false);
    expect(doubles.ingest).not.toHaveBeenCalled();
    expect(doubles.project).not.toHaveBeenCalled();
    const root = path.join(doubles.workDir, "archive", scope.workspaceId, projectId);
    await expect(readFile(path.join(root, "stages/preproduction/attempt-1.prompts.json"))).rejects.toMatchObject({ code: "ENOENT" });
    const stored = JSON.parse(await readFile(path.join(root, "stages/prompt_review/attempt-1.input.json"), "utf8")).input.resumeInput;
    const project = { projectId, createdAt: "2026-09-27T00:00:00Z", kind };
    expect(restoreStudioResumeInput(stored, scope, project)).toMatchObject({ ok: true, input: { purpose: "prompt-review", durationSec: 30, rawIntent } });
    expect(restoreStudioResumeInput(stored, scope, project, "不同的需求")).toMatchObject({ ok: false });
    const read = { app: getAppPool(), scope, projectId, runId, workDir: doubles.workDir };
    const receipt = await readStudioPromptReview(read);
    expect(receipt).toMatchObject({ stageRunId: "SR-prompt-only", pipeline: kind, targetSeconds: 30,
      plannedSeconds: 28, renderAuthorized: false, deferredGates: ["G5_PORTRAIT", "G7_FINAL"],
      reviewReport: report, shots: [{ shotId: "SC-1", durationSec: 28, prompt }] });
    expect(receipt.reviewReportSha256).toBe(createHash("sha256").update(report).digest("hex"));
    if (kind === "marketing") {
      expect(doubles.prepare).toHaveBeenCalledWith(expect.objectContaining({ stageId: "prompt_review" }));
      expect(doubles.finalize).toHaveBeenCalledWith(expect.anything(), receipt.shots, process.env,
        expect.objectContaining({ load: expect.any(Function), save: expect.any(Function) }));
      expect(doubles.verifyMarketingFacts).toHaveBeenCalledWith(expect.objectContaining({ stageId: "prompt_review",
        intentSha256: receipt.intentSha256, shots: receipt.shots }));
    }
    await expect(readStudioPromptReview({ ...read, runId: "RUN-stale" })).rejects.toMatchObject({ code: "PROMPT_REVIEW_NOT_READY" });
    await expect(readStudioPromptReview({ ...read, scope: { ...scope, workspaceId: "ws-other" } })).rejects.toMatchObject({ code: "PROMPT_REVIEW_NOT_READY" });
    await writeFile(path.join(root, "stages/prompt_review/attempt-1.prompt-review.json"), JSON.stringify({ ...receipt, targetSeconds: 31 }));
    await expect(readStudioPromptReview(read)).rejects.toMatchObject({ code: "PROMPT_REVIEW_UNVERIFIED" });
  });

  it("取得项目租约后再次发现原提示词执行已变化时不认领新尝试", async () => {
    useNarrativeProject();
    vi.stubEnv("WORKLOOM_RENDER_SIGNING_SECRET", randomBytes(32).toString("hex"));
    doubles.query.mockImplementation(async (sql: string) => ({ rows: sql.includes("SELECT attempt, input_ref")
      ? [{ run_id: "RUN-successor", attempt: 2, status: "done", error_class: null }] : [], rowCount: 1 }));
    const runId = worker.startRun(scope, { projectId: "VID-stale-prompt-resume", intent: "电影", purpose: "prompt-review",
      durationSec: 30, promptReviewPrior: { runId: "RUN-prior", attempt: 1 } });
    await vi.waitFor(() => expect(worker.getRun(runId, scope.workspaceId)?.finishedAt).not.toBeNull());
    expect(worker.getRun(runId, scope.workspaceId)).toMatchObject({ status: "failed", error: expect.stringContaining("PROMPT_REVIEW_PRIOR_CHANGED") });
    expect(doubles.lease).toHaveBeenCalledOnce();
    expect(doubles.release).toHaveBeenCalledOnce();
    expect(doubles.nextAttempt).toBe(0);
    expect(doubles.runPreproduction).not.toHaveBeenCalled();
  });

  it("没有独立签发密钥时在租约和供应商之前拒绝", () => {
    vi.stubEnv("WORKLOOM_RENDER_SIGNING_SECRET", "");
    expect(() => worker.startRun(scope, { projectId: "VID-no-prompt-signing", intent: "电影", purpose: "prompt-review", durationSec: 30 }))
      .toThrow(/PROMPT_REVIEW_SIGNING_UNAVAILABLE/);
    expect(doubles.lease).not.toHaveBeenCalled();
    expect(doubles.runPreproduction).not.toHaveBeenCalled();
  });
});

describe("默认导演委托与立项事务", () => {
  function storeGrant(verifyActor = "MEM-1") {
    let delegation: Record<string, unknown> | undefined;
    doubles.query.mockImplementation(async (sql: string, values: unknown[] = []) => {
      if (sql.includes("INSERT INTO video_creative_delegations")) delegation = values[6] as Record<string, unknown>;
      if (sql.includes("SELECT d.payload")) return { rows: delegation ? [{ payload: delegation, actor: verifyActor,
        run_id: delegation.runId, grant_event_id: delegation.grantEventId }] : [], rowCount: delegation ? 1 : 0 };
      return { rows: sql.includes("video_projects_max_vid_no") ? [{ n: 9000 }] : [], rowCount: 1 };
    });
    return () => delegation;
  }

  it("省略模式时真实创建并核验委托，同一run归档默认四版且无需专业确认", async () => {
    useNarrativeProject(); const stored = storeGrant(); doubles.runPreproduction.mockResolvedValue(success());
    const started = await worker.startVideoProjectRun(scope, {
      intent: "拍一条山间日出的风景片", by: { id: "MEM-1", type: "human" },
    });
    await vi.waitFor(() => expect(worker.getRun(started.runId, scope.workspaceId)?.finishedAt).not.toBeNull(), { timeout: 3_000, interval: 10 });
    const entry = worker.getRun(started.runId, scope.workspaceId)!;
    expect(entry).toMatchObject({ status: "finished", resultSummary: { creativeMode: "director_auto", confirmationSteps: 0,
      deliveryTargetPlan: { expectedOutputs: 4, regular: expect.any(Array), surprise: { kind: "surprise" } } } });
    expect(stored()).toMatchObject({ ...scope, projectId: started.projectId, runId: started.runId,
      grantedBy: "MEM-1", grantEventId: "EVT-studio-test", maxBudgetCny: 0 });
    const output = await archiveOutput(started.projectId, 1);
    expect(output.productionEvidence).toMatchObject({ runId: started.runId, creativeDelegation: stored(),
      directorProfile: { confirmationSteps: 0 }, deliveryTargetPlan: { expectedOutputs: 4 } });
    expect(doubles.query.mock.calls.some(([sql]) => sql.includes("INSERT INTO approvals"))).toBe(false);
  });

  it("数据库委托事件的主体不一致时在供应商之前关闭，不能相信请求里的有效摘要", async () => {
    useNarrativeProject(); storeGrant("MEM-other"); doubles.runPreproduction.mockResolvedValue(success());
    const started = await worker.startVideoProjectRun(scope, {
      intent: "拍一条山间日出的风景片", by: { id: "MEM-1", type: "human" },
    });
    await vi.waitFor(() => expect(worker.getRun(started.runId, scope.workspaceId)?.finishedAt).not.toBeNull(), { timeout: 3_000, interval: 10 });
    expect(worker.getRun(started.runId, scope.workspaceId)).toMatchObject({ status: "failed", error: expect.stringContaining("DELEGATION_INVALID") });
    expect(doubles.runPreproduction).not.toHaveBeenCalled();
  });

  it.each([[], null, false, { path: "/synthetic/anchor.png" }, ["/synthetic/anchor.png"]].map(value => [value]))(
    "客户metadata中的directorIdentityImages=%j在立项和供应商之前拒绝", async value => {
      useNarrativeProject(); doubles.runPreproduction.mockResolvedValue(success());
      let error: unknown;
      let started: Awaited<ReturnType<typeof worker.startVideoProjectRun>> | undefined;
      try {
        started = await worker.startVideoProjectRun(scope, {
          intent: "拍一条山间日出的风景片", creativeMode: "manual",
          metadata: { directorIdentityImages: value }, by: { id: "MEM-1", type: "human" },
        });
      } catch (caught) { error = caught; }
      // 修复前入口会启动真实工作器；先等自有边界替身运行终结，避免失败用例留下后台任务。
      if (started) await vi.waitFor(() => expect(worker.getRun(started!.runId, scope.workspaceId)?.finishedAt).not.toBeNull(), { timeout: 3_000, interval: 10 });
      expect(error).toMatchObject({ code: "METADATA_RESERVED" });
      expect(doubles.connect).not.toHaveBeenCalled();
      expect(doubles.lease).not.toHaveBeenCalled();
      expect(doubles.runPreproduction).not.toHaveBeenCalled();
    },
  );

  it("补跑的客户metadata不能把本机绝对路径送进定妆供应商配置", async () => {
    useNarrativeProject(); doubles.runPreproduction.mockResolvedValue(success());
    vi.stubEnv("HR_PORTRAIT_ENABLED", "1");
    vi.stubEnv("VOLCENGINE_ARK_API_KEY", "synthetic-unit-test-key");
    vi.stubEnv("ARK_API_KEY", "synthetic-unit-test-key");
    vi.stubEnv("ARK_IMAGE_MODEL", "synthetic-unit-test-model");
    const anchor = path.join(doubles.workDir, "不应读取的 合成图片.png");
    let error: unknown; let runId: string | undefined;
    try {
      runId = worker.startRun(scope, { projectId: `VID-boundary-${++projectSequence}`, intent: "山间风景片",
        metadata: { directorIdentityImages: [anchor] } });
    } catch (caught) { error = caught; }
    if (runId) await vi.waitFor(() => expect(worker.getRun(runId!, scope.workspaceId)?.finishedAt).not.toBeNull(), { timeout: 3_000, interval: 10 });
    expect(doubles.studioConfigs.some(config => config.portraits?.characterAnchorImages?.includes(anchor))).toBe(false);
    expect(error).toMatchObject({ code: "METADATA_RESERVED" });
    expect(doubles.lease).not.toHaveBeenCalled();
    expect(doubles.runPreproduction).not.toHaveBeenCalled();
  });

  it("未提供真实导演委托不能使用内部图片参数", async () => {
    useNarrativeProject(); doubles.runPreproduction.mockResolvedValue(success());
    let error: unknown; let runId: string | undefined;
    try {
      runId = worker.startRun(scope, { projectId: `VID-no-grant-${++projectSequence}`, intent: "山间风景片",
        directorIdentityImages: [path.join(doubles.workDir, "内部图片.png")] } as Parameters<typeof worker.startRun>[1]);
    } catch (caught) { error = caught; }
    if (runId) await vi.waitFor(() => expect(worker.getRun(runId!, scope.workspaceId)?.finishedAt).not.toBeNull(), { timeout: 3_000, interval: 10 });
    expect(error).toMatchObject({ code: "DELEGATION_REQUIRED" });
    expect(doubles.lease).not.toHaveBeenCalled();
    expect(doubles.runPreproduction).not.toHaveBeenCalled();
  });

  it("本仓受控委托核验后使用已解析图片；绝对路径不混入客户metadata", async () => {
    useNarrativeProject(); storeGrant(); doubles.runPreproduction.mockResolvedValue(success());
    vi.stubEnv("HR_PORTRAIT_ENABLED", "1");
    vi.stubEnv("VOLCENGINE_ARK_API_KEY", "synthetic-unit-test-key");
    vi.stubEnv("ARK_API_KEY", "synthetic-unit-test-key");
    vi.stubEnv("ARK_IMAGE_MODEL", "synthetic-unit-test-model");
    vi.stubEnv("HR_PORTRAIT_ANCHORS", "");
    const projectId = `VID-scoped-anchor-${++projectSequence}`;
    const runId = `RUN-scoped-anchor-${projectSequence}`;
    const anchor = path.join(doubles.workDir, "已登记的 合成图片.png");
    const { createDirectorGrantOnClient } = await import("./director-store.js");
    const delegation = await createDirectorGrantOnClient({ query: doubles.query } as never,
      { ...scope, projectId, runId }, { id: "MEM-1", type: "human" }, { identityAssetRefs: ["VA-synthetic"] });
    worker.startRun(scope, { projectId, allocatedRunId: runId, intent: "山间风景片",
      creativeDelegation: delegation, directorIdentityImages: [anchor], metadata: { brief: { audience: "山间游客" } },
    } as Parameters<typeof worker.startRun>[1]);
    await vi.waitFor(() => expect(worker.getRun(runId, scope.workspaceId)?.finishedAt).not.toBeNull(), { timeout: 3_000, interval: 10 });
    expect(worker.getRun(runId, scope.workspaceId)?.status).toBe("finished");
    expect(doubles.studioConfigs[0]?.portraits?.characterAnchorImages).toEqual([anchor]);
    expect(doubles.runPreproduction.mock.calls[0]?.[0].metadata).not.toHaveProperty("directorIdentityImages");
    expect(JSON.stringify(doubles.runPreproduction.mock.calls[0]?.[0].metadata)).not.toContain(anchor);
  });

  it.each([false, true])("委托写入失败时回滚；回滚再次失败=%s时销毁连接并保留两个错误", async rollbackFails => {
    doubles.query.mockImplementation(async (sql: string) => {
      if (sql.includes("INSERT INTO video_creative_delegations")) throw new Error("grant insert failed");
      if (sql === "ROLLBACK" && rollbackFails) throw new Error("grant rollback failed");
      return { rows: sql.includes("video_projects_max_vid_no") ? [{ n: 9000 }] : [], rowCount: 1 };
    });
    const pending = worker.startVideoProjectRun(scope, { intent: "拍一条山间日出的风景片", by: { id: "MEM-1", type: "human" } });
    if (rollbackFails) await expect(pending).rejects.toMatchObject({ name: "AggregateError",
      errors: [expect.objectContaining({ message: "grant insert failed" }), expect.objectContaining({ message: "grant rollback failed" })] });
    else await expect(pending).rejects.toThrow("grant insert failed");
    expect(doubles.query.mock.calls.at(-1)?.[0]).toBe("ROLLBACK");
    expect(doubles.releaseDb).toHaveBeenLastCalledWith(rollbackFails);
    expect(doubles.runPreproduction).not.toHaveBeenCalled();
  });
});

 describe("宿主营销G1必须先于vendor", () => {
  it("当前attempt事实G1通过后才调用vendor，最终完整镜头审核写回事实引用", async () => {
    doubles.runPreproduction.mockImplementation(async () => {
      expect(doubles.prepare).toHaveBeenCalledTimes(1);
      expect(doubles.review.mock.calls.some(([options]) => options.context.gate === "G1_DOSSIER")).toBe(true);
      return success();
    });
    const { entry, projectId } = await runToTerminal(); expect(entry.status).toBe("finished");
    expect(doubles.prepare).toHaveBeenCalledWith(expect.objectContaining({ scope: expect.objectContaining({ ...scope, projectId, attempt: 1 }) }));
    expect(doubles.finalize).toHaveBeenCalledWith(expect.anything(), [{ shotId: "SC-1", prompt: "01.【场景】窗边桌面", fields: { scene: "窗边桌面" } }], process.env,
      expect.objectContaining({ load: expect.any(Function), save: expect.any(Function) }));
    expect(await archiveOutput(projectId, 1)).toMatchObject({ marketingFactsRef: "stages/preproduction/attempt-1.marketing-facts.json", marketingFactsSha256: "b".repeat(64) });
    expect(doubles.studioConfigs[0]?.dataMining.verifiedRaw.projectId).toBe(projectId);
  });
  it.each(["source", "g1", "unverified-proof", "unbound-proof"])("%s未核实不执行vendor或终态事实审核", async kind => {
    if (kind === "source") doubles.prepare.mockRejectedValue(new Error("MARKETING_A1_UNVERIFIED"));
    if (kind === "g1") doubles.review.mockResolvedValue({ status: "failed", approved: false, via: "llm", degraded: false, reason: "不支持主张", score: 0 });
    if (kind === "unverified-proof") doubles.review.mockResolvedValue({ status: "unverified", approved: true, via: "fallback", degraded: true, reason: "来源不可用", score: 95, issues: [], suggestions: [], evidence: [] });
    if (kind === "unbound-proof") doubles.review.mockResolvedValue({ status: "passed", approved: true, via: "llm", model: "judge", degraded: false, reason: "通过", score: 95, issues: [], suggestions: [], evidence: [{ sha256: "0".repeat(64), scope: "complete-text" }] });
    const { entry } = await runToTerminal(); expect(entry.status).toBe("failed");
    expect(doubles.runPreproduction).not.toHaveBeenCalled(); expect(doubles.finalize).not.toHaveBeenCalled();
  });
  it.each([
    ["unverified", "fallback", true, "派发后超时，结果未知", 1, "producer-unavailable"],
    ["failed", "deterministic", false, "确定性证据缺失", 1, "producer-unavailable"],
    ["failed", "llm", false, "完整评审拒绝主张", 2, "producer-rejected"],
  ])("显式允许重跑时，G1 %s/%s 保留真实裁决并只重跑已知的评审打回", async (status, via, degraded, reason, attempts, expected) => {
    vi.stubEnv("VM_PRODUCER_RETRY", "1");
    doubles.review.mockResolvedValue({ status, approved: false, via, degraded, reason, score: 0,
      model: "test-judge", issues: [], suggestions: [], evidence: [] });
    const { entry } = await runToTerminal();
    expect(entry).toMatchObject({ status: "failed", resultSummary: { producerAttempts: attempts } });
    expect(entry.error).toContain(`${expected}(G1_DOSSIER`);
    expect(entry.error).toContain(reason);
    expect(doubles.prepare).toHaveBeenCalledTimes(attempts);
    expect(doubles.review).toHaveBeenCalledTimes(attempts);
    expect(doubles.runPreproduction).not.toHaveBeenCalled();
  });
  it("最终事实审核失败时不写done、不投影商品，保留失败原因", async () => {
    doubles.runPreproduction.mockResolvedValue(success()); doubles.finalize.mockRejectedValue(new Error("MARKETING_PROMPT_FACTS_REJECTED"));
    const { entry } = await runToTerminal(); expect(entry.status).toBe("failed"); expect(entry.error).toContain("MARKETING_PROMPT_FACTS_REJECTED");
    expect(doubles.project).not.toHaveBeenCalled(); expect(doubles.finish.mock.calls.every(([row]) => row.status === "failed")).toBe(true);
  });
});


describe("公共产品参考图路径边界", () => {
  const referenceShapes: Array<[string, unknown]> = [
    ["absolute-string", "/synthetic/workspace-b/private 中文 & 图片.png"],
    ["traversal-string", "../../workspace-b/private.png"],
    ["windows-string", "C:\\synthetic\\workspace-b\\private.png"],
    ["file-url-string", "file:///synthetic/workspace-b/private.png"],
    ["http-string-in-local-channel", "https://synthetic.invalid/private.png"],
    ["localPath-object", { localPath: "/synthetic/workspace-b/link-to-private.png" }],
    ["path-object", { path: "var/media/private.png" }],
    ["non-http-url-object", { url: "file:///synthetic/workspace-b/private.png" }],
    ["http-object-with-localPath", { url: "https://synthetic.invalid/public.png", localPath: "/synthetic/workspace-b/private.png" }],
  ];
  const localReferenceCases = ["referenceManifest", "reference_manifest"].flatMap(manifestKey =>
    ["reference_images", "referenceImages"].flatMap(imagesKey => referenceShapes.map(([shape, value]) => ({
      label: `${manifestKey}.${imagesKey}:${shape}`,
      metadata: { products: [{ name: "测试商品", [manifestKey]: { [imagesKey]: [value] } }] },
    }))),
  );
  const safeMetadataCases: Array<[string, Record<string, unknown>]> = [
    ["product-description", { products: [{ name: "客房用品", description: "纯文字 中文 空格 & 标签", assetId: "VA-registered" }] }],
    ["empty-images", { products: [{ referenceManifest: { reference_images: [] } }] }],
    ["empty-descriptors", { products: [{ reference_manifest: { referenceImages: ["", "  ", null, {}, { localPath: " " }] } }] }],
    ["http-object", { products: [{ referenceManifest: { reference_images: [{ url: "https://synthetic.invalid/product.png" }] } }] }],
    ["https-object-aliases", { products: [{ reference_manifest: { referenceImages: [{ url: "HTTPs://synthetic.invalid/product.png" }] } }] }],
    ["unrelated-customer-path", { brief: { desiredScene: "山间小路", path: "客户描述里的路径名称" } }],
  ];

  const workerCases = (["new-metadata", "new-customerMetadata", "retry"] as const)
    .flatMap(mode => localReferenceCases.map(item => ({ ...item, mode })));
  it.each(workerCases)("$mode:$label在SQL/租约/供应商前拒绝", async ({ mode, label, metadata }) => {
    useNarrativeProject(); doubles.runPreproduction.mockResolvedValue(success());
    let error: unknown; let runId: string | undefined;
    try {
      if (mode === "retry") {
        runId = worker.startRun(scope, { projectId: `VID-product-boundary-${++projectSequence}`,
          intent: "山间风景片", metadata });
      } else {
        const started = await worker.startVideoProjectRun(scope, {
          intent: "山间风景片", creativeMode: "manual", by: { id: "MEM-1", type: "human" },
          ...(mode === "new-metadata" ? { metadata } : { customerMetadata: metadata }),
        });
        runId = started.runId;
      }
    } catch (caught) { error = caught; }
    // 修复前等待实际工作器结束，失败用例也不留下后台任务。
    if (runId) await vi.waitFor(() => expect(worker.getRun(runId!, scope.workspaceId)?.finishedAt).not.toBeNull(), { timeout: 3_000, interval: 10 });
    expect(error, label).toMatchObject({ code: "METADATA_RESERVED" });
    expect(String((error as Error).message), label).not.toContain("/synthetic/workspace-b");
    expect(doubles.connect, label).not.toHaveBeenCalled();
    expect(doubles.lease, label).not.toHaveBeenCalled();
    expect(doubles.runPreproduction, label).not.toHaveBeenCalled();
    expect(doubles.studioConfigs, label).toHaveLength(0);
  });

  it.each(safeMetadataCases)("%s普通商品metadata保持可启动且不产生本机参考图", async (_label, metadata) => {
    useNarrativeProject(); doubles.runPreproduction.mockResolvedValue(success());
    vi.stubEnv("HR_PORTRAIT_ENABLED", "1");
    vi.stubEnv("VOLCENGINE_ARK_API_KEY", "synthetic-unit-test-key");
    vi.stubEnv("ARK_API_KEY", "synthetic-unit-test-key");
    vi.stubEnv("ARK_IMAGE_MODEL", "synthetic-unit-test-model");
    const started = await worker.startVideoProjectRun(scope, { intent: "山间风景片", creativeMode: "manual",
      metadata, customerMetadata: metadata, by: { id: "MEM-1", type: "human" } });
    await vi.waitFor(() => expect(worker.getRun(started.runId, scope.workspaceId)?.finishedAt).not.toBeNull(), { timeout: 3_000, interval: 10 });
    expect(worker.getRun(started.runId, scope.workspaceId)?.status).toBe("finished");
    expect(doubles.runPreproduction).toHaveBeenCalledTimes(1);
    expect(doubles.studioConfigs[0]?.portraits?.referenceImages).toEqual([]);
    expect(doubles.runPreproduction.mock.calls[0]?.[0].metadata.products).toEqual(metadata.products);
  });
});

/**
 * The actual host admission, StageRunner, ArchiveStore, checkpoint repository and gate callbacks run.
 * PostgreSQL, native author work-stations, source HTTP and reviewer transport use explicit fixtures.
 * Source preparation/restoration/final fact verification and their immutable file checks run unchanged.
 */
describe("正式宿主按最终事实诊断返工，并保留后续基础设施恢复", () => {
  async function fixture(mode: "semantic" | "infra" | "unknown") {
    const authority = await vi.importActual<typeof import("./marketing-authority.js")>("./marketing-authority.js");
    const mining = await vi.importActual<typeof import("./data-mining-executor.js")>("./data-mining-executor.js");
    const { createStudioCheckpointRunner } = await import("@hyperreality/video-studio");
    const { canonicalRenderJson, renderSha256 } = await import("./gen/compiled-request.js");
    const projectId = `VID-independent-fact-continuity-${++projectSequence}`;
    doubles.meta.mockResolvedValue({ projectId, kind: "marketing", title: "事实返工接续", threadId: "T1", createdAt: "2026-09-27T00:00:00Z" });
    const intent = "介绍星野 R 风扇，仅表达有完整来源支持的风量9档。";
    const sourceUrl = "https://source.example.com/independent-r";
    const sourceText = "星野 R 风扇，风量9档。未提供其他档位或性能承诺。";
    const source = { sourceId: "SRC-independent-host", requestedUrl: sourceUrl, finalUrl: sourceUrl,
      redirectChain: [], fetchedAt: new Date().toISOString(), contentType: "text/plain", bytes: Buffer.byteLength(sourceText),
      text: sourceText, textSha256: renderSha256(sourceText), rawSha256: renderSha256(sourceText), assetUrls: [] };
    doubles.emitGates = false;
    doubles.dataMiningExecutor.mockImplementation(mining.createDataMiningExecutor);
    doubles.prepare.mockImplementation(input => authority.prepareMarketingFacts({ ...input,
      llm: { reason: async (prompt: string) => {
        const stage = /当前阶段：(A[123])/u.exec(prompt)?.[1];
        return { success: true, data: stage === "A1" ? {
          payload: { identity: { name: "星野 R", specs: { 风量: "9档" }, prices: [], official_selling_points: [] }, images: [] },
          citations: [{ pointer: "/identity/name", sourceId: source.sourceId, quote: "星野 R" },
            { pointer: "/identity/specs/风量", sourceId: source.sourceId, quote: "风量9档" }],
        } : { payload: stage === "A2" ? { reviews: [] } : { competitors: [] }, citations: [],
          noEvidenceReason: "当前正文没有用户评价或竞品证据，禁止补充事实" } };
      } }, dependencies: {
        search: async () => [{ title: "星野 R 规格来源", url: sourceUrl, snippet: "候选，不能作为事实" }],
        fetchSource: async () => ({ snapshot: source, rawBytes: Buffer.from(sourceText) }),
      },
    }));
    doubles.restoreMarketing.mockImplementation(authority.restoreMarketingFacts);
    doubles.finalize.mockImplementation(authority.finalizeMarketingFacts);
    doubles.verifyMarketingFacts.mockImplementation(authority.verifyMarketingFacts);
    const defaultReview = doubles.review.getMockImplementation()!;
    const completeReasons = new Map<string, string>();
    let factCalls = 0;
    doubles.review.mockImplementation(async options => {
      const verdict = await defaultReview(options);
      if (options.context?.purpose !== "marketing-final-fact-review") return verdict;
      factCalls++;
      const body = JSON.parse(await readFile(options.artifacts[0].path, "utf8"));
      if (mode === "unknown" && factCalls === 1) return { ...verdict, approved: false, status: "unverified",
        score: 0, unknownOutcome: true, reason: "供应商已受理但最终回执未知" };
      if (mode === "infra" && factCalls === 1) return { ...verdict, approved: false, status: "unverified",
        via: "fallback", degraded: true, score: 0, reason: "审核基础设施不可用，未作内容裁决" };
      if (/999档|888档/u.test(body.shot.prompt)) {
        const reason = `${body.shot.shotId}原始完整诊断：${"只能采用已核实的风量9档，不能把广告愿望写成事实。".repeat(40)}诊断专用尾部：保留其他已通过动作。`;
        completeReasons.set(body.shot.shotId, reason);
        return { ...verdict, approved: false, status: "failed", score: 20, reason,
          issues: [`${body.shot.shotId}当前完整prompt和fields含未支持档位`],
          suggestions: ["作者依据同一来源修复完整镜头，不能重复评审原坏字节"] };
      }
      return verdict;
    });
    const authors = { G2_THEME: 0, G3_INSIGHT: 0, G3_PROFILE: 0, G4_PRD: 0,
      SCRIPT: 0, PRODUCTION: 0, OPENING_TITLE: 0 };
    const feedbacks: Array<string | null> = [], promptHashes: string[] = [], gateHashes: string[] = [];
    doubles.runPreproduction.mockImplementation(async () => {
      const config = doubles.studioConfigs.at(-1)!;
      feedbacks.push(config.productionRepairFeedback ?? null);
      const runner = createStudioCheckpointRunner(config.checkpoints, { projectId, intent });
      const author = (stage: keyof typeof authors) => async () => { authors[stage]++; return { stage, source: "同一已核实的原始输入" }; };
      const approve = async (gate: string, contentMd: string) => {
        expect(await config.onApproval({ gate, vendorType: "native-boundary-fixture", runId: "native-fixture",
          title: "完整工位确认单", contentMd })).toMatchObject({ approved: true });
      };
      await runner.run("G2_THEME", "同一完整主题输入", author("G2_THEME"));
      await approve("G2_THEME", "完整主题与来源合同。".repeat(30));
      await runner.run("G3_INSIGHT", "同一完整洞察输入", author("G3_INSIGHT"));
      await runner.run("G3_PROFILE", "同一完整档案输入", author("G3_PROFILE"));
      await approve("G3_INSIGHT", "完整洞察与来源合同。".repeat(30));
      await runner.run("G4_PRD", "同一完整PRD输入", author("G4_PRD"));
      await approve("G4_PRD", "完整PRD与来源合同。".repeat(30));
      const script = await runner.run("SCRIPT", "同一完整脚本输入", author("SCRIPT"));
      // This is the native author boundary: the actual public config feedback participates only
      // in the PRODUCTION request, matching the native wrapper contract tested separately.
      const production = await runner.run("PRODUCTION", { script, feedback: config.productionRepairFeedback ?? null }, async () => {
        const generation = ++authors.PRODUCTION;
        const first = mode === "semantic" && generation === 1 ? 999 : 9;
        const second = mode === "semantic" && generation <= 2 ? 888 : 9;
        return { shots: [first, second].map((value, index) => ({ shotId: `SC-${index + 1}`,
          prompt: `01.【商品】星野 R 风扇风量${value}档。`, fields: { 风量: `${value}档`, action: "展示产品" } })) };
      });
      const final = await runner.run("OPENING_TITLE", production, async () => { authors.OPENING_TITLE++; return production; });
      const contentMd = `# 当前完整原生 G6\n${canonicalRenderJson(final.shots)}\n${"镜头遵守当前完整来源与创作合同。".repeat(20)}`;
      promptHashes.push(renderSha256(canonicalRenderJson(final.shots)));
      gateHashes.push(renderSha256(contentMd));
      await approve("G6_PROMPT", contentMd);
      await approve("G7_FINAL", `# 当前整体交付\n${canonicalRenderJson(final.shots)}\n${"完整交付合同。".repeat(30)}`);
      return { ...success(), stages: { ...success().stages, productionEngine: final } };
    });
    const runs: string[] = [];
    async function run() {
      const prior = runs.at(-1);
      const priorAttempt = runs.length;
      doubles.query.mockImplementation(async (sql: string) => ({ rows: prior && sql.includes("SELECT attempt, input_ref")
        ? [{ run_id: prior, attempt: priorAttempt, status: "failed", error_class: "BUG",
          input_ref: `stages/preproduction/attempt-${priorAttempt}.input.json` }] : [], rowCount: 1 }));
      const runId = worker.startRun(scope, { projectId, intent, rawIntent: intent, isMarketing: true,
        metadata: { brief: { product: "星野 R" } },
        ...(prior ? { resumePrior: { runId: prior, attempt: priorAttempt, stageId: "preproduction" as const } } : {}) });
      runs.push(runId);
      await vi.waitFor(() => expect(worker.getRun(runId, scope.workspaceId)?.finishedAt).not.toBeNull(), { timeout: 5_000, interval: 10 });
      return worker.getRun(runId, scope.workspaceId)!;
    }
    return { run, projectId, authors, feedbacks, promptHashes, gateHashes, completeReasons,
      factCalls: () => factCalls, gateCalls: (gate: string) => doubles.review.mock.calls.filter(([options]) => options.context?.gate === gate).length };
  }

  it("两次最终事实拒绝只返工生产，完整诊断跨四次宿主运行稳定，后续落盘失败不再生成好作者", async () => {
    const scenario = await fixture("semantic");
    const { ArchiveStore } = await import("@hyperreality/video-studio");
    const write = ArchiveStore.prototype.writeJsonAtomic;
    let injected = false;
    vi.spyOn(ArchiveStore.prototype, "writeJsonAtomic").mockImplementation(function (this: InstanceType<typeof ArchiveStore>, ref, data) {
      if (!injected && ref === "stages/preproduction/attempt-3.output.json") {
        injected = true;
        return Promise.reject(new Error("independent late output disk failure"));
      }
      return write.call(this, ref, data);
    });
    expect(await scenario.run()).toMatchObject({ status: "failed", error: expect.stringContaining("MARKETING_PROMPT_FACTS_REJECTED") });
    expect(await scenario.run()).toMatchObject({ status: "failed", error: expect.stringContaining("MARKETING_PROMPT_FACTS_REJECTED") });
    expect(await scenario.run()).toMatchObject({ status: "failed", error: "independent late output disk failure" });
    expect(await scenario.run()).toMatchObject({ status: "finished", error: null });
    expect(scenario.authors).toEqual({ G2_THEME: 1, G3_INSIGHT: 1, G3_PROFILE: 1, G4_PRD: 1,
      SCRIPT: 1, PRODUCTION: 3, OPENING_TITLE: 3 });
    expect(doubles.prepare).toHaveBeenCalledTimes(1);
    expect(doubles.restoreMarketing).toHaveBeenCalledTimes(3);
    expect(scenario.feedbacks[0]).toBeNull();
    expect(scenario.feedbacks[1]).toContain(scenario.completeReasons.get("SC-1"));
    expect(scenario.feedbacks[2]).toContain(scenario.completeReasons.get("SC-1"));
    expect(scenario.feedbacks[2]).toContain(scenario.completeReasons.get("SC-2"));
    expect(scenario.feedbacks[3]).toBe(scenario.feedbacks[2]);
    expect(new Set(scenario.promptHashes.slice(0, 3)).size).toBe(3);
    expect(scenario.promptHashes[3]).toBe(scenario.promptHashes[2]);
    expect(new Set(scenario.gateHashes.slice(0, 3)).size).toBe(3);
    expect(scenario.gateHashes[3]).toBe(scenario.gateHashes[2]);
    for (const gate of ["G1_DOSSIER", "G2_THEME", "G3_INSIGHT", "G4_PRD"]) expect(scenario.gateCalls(gate)).toBe(1);
    expect(scenario.gateCalls("G6_PROMPT")).toBe(3);
    expect(scenario.factCalls()).toBe(4);
    expect(injected).toBe(true);
    expect(doubles.nextAttempt).toBe(4);
    expect(doubles.checkpointEvents.filter(event => event.kind === "PRODUCTION_REJECTION" && event.attempt === 4)).toHaveLength(2);
    expect((await archiveOutput(scenario.projectId, 4)).marketingFactsRef).toContain("attempt-4.marketing-facts.json");
  });

  it("最终审核基础设施未作语义裁决时恢复原生产与G6，只重试事实审核", async () => {
    const scenario = await fixture("infra");
    expect(await scenario.run()).toMatchObject({ status: "failed", error: expect.stringContaining("MARKETING_PROMPT_FACTS_REJECTED") });
    expect(await scenario.run()).toMatchObject({ status: "finished", error: null });
    expect(scenario.authors.PRODUCTION).toBe(1);
    expect(scenario.authors.OPENING_TITLE).toBe(1);
    expect(scenario.promptHashes[1]).toBe(scenario.promptHashes[0]);
    expect(scenario.feedbacks).toEqual([null, null]);
    expect(scenario.gateCalls("G6_PROMPT")).toBe(1);
    expect(scenario.factCalls()).toBe(3);
    expect(doubles.checkpointEvents.some(event => event.kind === "PRODUCTION_REJECTION")).toBe(false);
  });

  it("最终事实供应商结果未知时proper prior接续也不认领新attempt或调用作者", async () => {
    const scenario = await fixture("unknown");
    expect(await scenario.run()).toMatchObject({ status: "failed", error: expect.stringContaining("VIDEO_MODEL_OUTCOME_UNKNOWN") });
    expect(await scenario.run()).toMatchObject({ status: "failed", error: expect.stringContaining("PROMPT_REVIEW_PRIOR_CHANGED") });
    expect(doubles.nextAttempt).toBe(1);
    expect(doubles.runPreproduction).toHaveBeenCalledTimes(1);
    expect(scenario.authors.PRODUCTION).toBe(1);
    expect(scenario.factCalls()).toBe(1);
    expect(doubles.checkpointEvents.some(event => event.kind === "PRODUCTION_REJECTION")).toBe(false);
  });
});
