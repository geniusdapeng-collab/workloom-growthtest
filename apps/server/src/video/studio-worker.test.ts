/**
 * T-2026-0927-0013：真实 startRun + StageRunner + ArchiveStore 回归。
 * vendor、PG、媒体登记用边界替身；档案写盘与重试/终态/商品摘要走实际代码。
 */
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createHash } from "node:crypto";
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
  finalize: vi.fn(),
  studioConfigs: [] as Array<Record<string, any>>,
  emitGates: true,
  connect: vi.fn(),
  query: vi.fn(),
  releaseDb: vi.fn(),
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
vi.mock("./marketing-authority.js", () => ({ prepareMarketingFacts: doubles.prepare, finalizeMarketingFacts: doubles.finalize }));
vi.mock("./data-mining-executor.js", () => ({ createDataMiningExecutor: vi.fn() }));
vi.mock("./media/library.js", () => ({ ingestPortraitsFromIndex: doubles.ingest }));
vi.mock("./media/products.js", () => ({ upsertProductProfileFromDossier: doubles.project }));
vi.mock("./archive-host.js", () => ({
  archiveWorkDir: () => doubles.workDir,
  acquireProjectLease: doubles.lease,
  readProjectMeta: doubles.meta,
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
  WorkloomLLMEngine: { fromEnv: () => ({ attachRouter: vi.fn(), attachConfiguredRouter: vi.fn() }) },
  installVendorEngineBridge: vi.fn(),
  installVendorRenderCompatBridge: vi.fn(),
  installVendorPortraitBindingBridge: () => doubles.uninstall,
  attachStructuredLog: () => doubles.detach,
}));

let worker: typeof import("./studio-worker.js");
const scope = { tenantId: "tenant-test", workspaceId: "ws-test" };
let projectSequence = 0;

beforeAll(async () => {
  doubles.workDir = await mkdtemp(path.join(tmpdir(), "studio-result-"));
  worker = await import("./studio-worker.js");
});

afterAll(async () => { await rm(doubles.workDir, { recursive: true, force: true }); });
afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); });

beforeEach(() => {
  vi.clearAllMocks();
  const eventReceipt = { eventId: "EVT-studio-test", seq: 1n, hash: "a".repeat(64), deduped: false, piiHits: 0 };
  vi.mocked(gatewayAppend).mockReset().mockResolvedValue(eventReceipt);
  vi.mocked(gatewayAppendOnClient).mockReset().mockResolvedValue(eventReceipt);
  doubles.nextAttempt = 0;
  doubles.studioConfigs.length = 0;
  doubles.prepare.mockReset().mockImplementation(async ({ scope, root }) => ({
    bundle: { rawSha256: "a".repeat(64), productQuery: { name: "本次商品" } }, raw: { A1: {}, A2: {}, A3: {} },
    prefix: `stages/preproduction/attempt-${scope.attempt}.marketing`,
    storeRoot: path.join(root, `stages/preproduction/attempt-${scope.attempt}.marketing-dossier`),
    g1Content: JSON.stringify({ facts: { schemaVersion: "workloom.marketing-facts/v1", stages: [1, 2, 3], sources: [1], optionalValue: null }, scope }),
  }));
  doubles.finalize.mockReset().mockResolvedValue({ ref: "stages/preproduction/attempt-1.marketing-facts.json", sha256: "b".repeat(64) });
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
    expect(doubles.uninstall).toHaveBeenCalledTimes(1);
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

  it.each(["busy", "error"])("租约 %s 不会无锁执行，并清理已安装的桥", async (failure) => {
    if (failure === "busy") doubles.lease.mockResolvedValue(null);
    else doubles.lease.mockRejectedValue(new Error("lease network failed"));
    const { entry } = await runToTerminal();
    expect(entry.status).toBe("failed");
    expect(doubles.runPreproduction).not.toHaveBeenCalled();
    expect(doubles.meta).not.toHaveBeenCalled();
    expect(doubles.finish).not.toHaveBeenCalled();
    expect(doubles.uninstall).toHaveBeenCalledTimes(1);
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
    expect(doubles.uninstall).toHaveBeenCalledTimes(1);
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

  it("解锁和日志清理抛错仍清理绑定桥并写终态", async () => {
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
    expect(doubles.finalize).toHaveBeenCalledWith(expect.anything(), [{ shotId: "SC-1", prompt: "01.【场景】窗边桌面", fields: { scene: "窗边桌面" } }]);
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
