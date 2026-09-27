/**
 * T-2026-0927-0013：真实 startRun + StageRunner + ArchiveStore 回归。
 * vendor、PG、媒体登记用边界替身；档案写盘与重试/终态/商品摘要走实际代码。
 */
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

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
  query: vi.fn(),
}));

vi.mock("@workloom/db", () => ({ getAppPool: () => ({ connect: async () => ({ query: doubles.query, release: vi.fn() }) }), getGatewayPool: () => ({}) }));
vi.mock("@workloom/base/model-router", () => ({
  GatewayEventSink: class {}, poolFromEnv: () => new Map(),
}));
vi.mock("@workloom/base/workdata", () => ({ gatewayAppend: vi.fn(), gatewayAppendOnClient: vi.fn() }));
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
  WorkloomLLMEngine: { fromEnv: () => ({ attachRouter: vi.fn() }) },
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
  vi.stubEnv("ARCHIVE_ENABLED", "1");
  vi.stubEnv("MEDIA_INGEST_ENABLED", "1");
  vi.stubEnv("HR_PORTRAIT_ENABLED", "0");
  vi.stubEnv("VM_PRODUCER_RETRY", "1");
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
const rejected = () => ({
  success: false,
  confirmations: { theme: { approved: false, reason: "producer-rejected(G2_THEME)：需求冲突" } },
  stages: { creativeTheme: { title: "需要重做" } },
});

async function runToTerminal(isMarketing = true) {
  const projectId = `VID-result-${++projectSequence}`;
  if (!isMarketing) doubles.meta.mockResolvedValue({ kind: "narrative", title: "叙事结果", createdAt: "2026-09-27T00:00:00Z" });
  const runId = worker.startRun(scope, { projectId, intent: "测试预生产结果", isMarketing });
  await vi.waitFor(() => expect(worker.getRun(runId, scope.workspaceId)?.finishedAt).not.toBeNull(), { timeout: 3_000, interval: 10 });
  const entry = worker.getRun(runId, scope.workspaceId)!;
  return { projectId, runId, entry };
}

async function archiveOutput(projectId: string, attempt: number) {
  const file = path.join(doubles.workDir, "archive", scope.workspaceId, projectId, "stages", "preproduction", `attempt-${attempt}.output.json`);
  return JSON.parse(await readFile(file, "utf8")) as Record<string, unknown>;
}

describe("预生产原始结果与诚实终态", () => {
  it("启用档案时，监制打回仍触发有限重试，成功结果保留 stages.dataMining 驱动商品投影", async () => {
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

  it("监制连续打回到上限后 status=failed，保留具体拒绝原因", async () => {
    doubles.runPreproduction.mockResolvedValue(rejected());
    const { entry } = await runToTerminal();
    expect(doubles.runPreproduction).toHaveBeenCalledTimes(2);
    expect(entry.status).toBe("failed");
    expect(entry.error).toContain("producer-rejected(G2_THEME)：需求冲突");
    expect(entry.resultSummary).toMatchObject({ success: false, producerAttempts: 2, stages: ["creativeTheme"] });
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
  it("定妆照只完成计划却缺实际图片时host G5打回，不能被vendor success:true掩盖", async () => {
    doubles.runPreproduction.mockImplementation(async () => ({ ...success(), stages: { ...success().stages,
      portraitStudio: { status: "completed", completedPortraits: 0, pendingPortraits: 4, characters: 1, products: 0 },
      scriptEngine: { report: { characters_count: 1 } } } }));
    const { entry } = await runToTerminal(false);
    expect(entry.status).toBe("failed"); expect(entry.error).toContain("producer-rejected");
    expect(doubles.review.mock.calls.some(([options]) => options.context.gate === "G5_PORTRAIT" && options.deterministic.some((check: { pass: boolean }) => !check.pass))).toBe(true);
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
