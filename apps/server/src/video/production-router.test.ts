/** 实际 tRPC caller：schema/身份/参数传递与门禁使用真实路由，权限事实和业务边界显式替身。 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TrpcContext } from "../trpc/context.js";
const d = vi.hoisted(() => ({ query: vi.fn(), qualify: vi.fn(), shots: vi.fn(), load: vi.fn(), submit: vi.fn(),
  judge: vi.fn(), budget: vi.fn(), cap: vi.fn(), writable: true }));
vi.mock("@workloom/db", () => ({ getAppPool: () => ({ connect: async () => ({ query: d.query, release: vi.fn() }) }), getGatewayPool: () => ({}) }));
vi.mock("../service/access-authority.js", async original => ({ ...await original<Record<string, unknown>>(),
  currentMemberAuthority: async (identity: unknown) => ({ identity, permissions: {} }),
  memberAccessGrants: () => ({ actionPermissions: d.writable ? ["workspace.write"] : [] }),
}));
vi.mock("./production-authority.js", () => ({ qualifyProductionShot: d.qualify, listProductionShots: d.shots, loadQualifiedRenderInput: d.load }));
vi.mock("./gen/submit.js", () => ({ submitGenJob: d.submit }));
vi.mock("./archive-host.js", async original => ({ ...await original<Record<string, unknown>>(), makeStageArchive: () => null }));
vi.mock("@workloom/base/fence-engine", async original => ({ ...await original<Record<string, unknown>>(), judge: d.judge }));
vi.mock("@workloom/base/model-router", async original => ({ ...await original<Record<string, unknown>>(), checkRenderBudget: d.budget }));
vi.mock("./gen/cost.js", async original => ({ ...await original<Record<string, unknown>>(), checkCostCaps: d.cap, renderSpendCny: async () => ({ day: 0, month: 0 }) }));
import { videoRouter } from "./router.js";
import { SubmissionError } from "./gen/submission-ledger.js";
const identity = { tenantId: "tenant-router", workspaceId: "ws-router", memberNo: "MEM-T", plan: "pro", role: "owner" } as NonNullable<TrpcContext["identity"]>;
const context: TrpcContext = { identity, session: identity, partnerIdentity: null, headers: new Headers() };
const caller = () => videoRouter.createCaller(context);
const canonical = () => ({ script: { id: "RS-CANONICAL", project_id: "P1", shot_id: "S1", script_key: "qualified:PQ-1", version: 1,
  status: "draft", md: "服务端完整镜头正文", fields: { durationSec: 5 } }, modelId: "doubao-seedance-2-5", mode: "manual", params: { durationSec: 5, aspectRatio: "16:9", extra: { cfg_scale: 2 } },
  requestHash: "a".repeat(64), qualificationId: "PQ-1", compiled: {}, reconciliationOnly: false });
beforeEach(() => {
  vi.clearAllMocks(); d.writable = true; vi.stubEnv("ARCHIVE_AUTO_RESUME", "0");
  d.query.mockResolvedValue({ rows: [], rowCount: 0 });
  d.qualify.mockResolvedValue({ qualificationId: "PQ-1", qualificationToken: "test-token", scriptId: "RS-CANONICAL", promptSha256: "a".repeat(64) });
  d.shots.mockResolvedValue({ projectId: "P1", shots: [{ shotId: "S1", durationSec: 5, prompt: "服务端完整镜头正文" }] });
  d.load.mockResolvedValue(canonical());
  d.judge.mockReturnValue({ level: "auto", impacts: [], triggeredBy: [] });
  d.budget.mockReturnValue({ allowed: true, overageSeconds: 0 }); d.cap.mockReturnValue({ allowed: true });
  d.submit.mockResolvedValue({ jobId: "RJ-1", taskId: "remote-1", mock: false, provider: "seedance", providerModel: "m", estUsd: 1, estCny: 7, deduped: false });
});
afterEach(() => vi.unstubAllEnvs());

describe("生产入口正常可达且不能覆盖已审核请求", () => {
  it("真实根路由挂载shots/qualify，scope只来自登录身份；随后只给token完成提交", async () => {
    expect((await caller().production.shots({ projectId: "P1" })).shots).toHaveLength(1);
    const qualification = await caller().production.qualifyShot({ projectId: "P1", shotId: "S1", modelId: "doubao-seedance-2-5", params: { aspectRatio: "16:9" } });
    expect(d.qualify).toHaveBeenCalledWith(expect.objectContaining({ scope: { tenantId: identity.tenantId, workspaceId: identity.workspaceId }, actor: "MEM-T", projectId: "P1", shotId: "S1" }));
    const result = await caller().render.submit({ qualificationToken: qualification.qualificationToken });
    expect(result).toMatchObject({ mock: false, durationSec: 5, clamped: false });
    expect(d.submit).toHaveBeenCalledWith(expect.objectContaining({ script: canonical().script, params: canonical().params,
      qualificationToken: "test-token", modelId: "doubao-seedance-2-5", mode: "manual", durationProvenance: { source: "script-fields", planSeconds: 5, requestedSeconds: 5, mismatchSeconds: 0, strict: true } }));
  });
  it("没有token的旧CMS approved直提在查脚本/供应商之前拒绝", async () => {
    await expect(caller().render.submit({ scriptId: "RS-handmade", mode: "auto" })).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
    expect(d.load).not.toHaveBeenCalled(); expect(d.query).not.toHaveBeenCalled(); expect(d.submit).not.toHaveBeenCalled();
  });
  it.each([{ scriptId: "other" }, { modelId: "other" }, { mode: "auto" as const }, { durationSec: 120 },
    { estimatedSeconds: 30 }, { firstFrameUrl: "https://new.example.test/changed.png" }, { generateAudio: true }])("客户端覆盖 %j 失败关闭", async patch => {
    await expect(caller().render.submit({ qualificationToken: "test-token", ...patch })).rejects.toThrow("QUALIFICATION_REQUEST_MISMATCH");
    expect(d.submit).not.toHaveBeenCalled();
  });
  it("未知字段不静默丢弃；服务签发不接受正文、路径、评分或scope自述", async () => {
    await expect(caller().render.submit({ qualificationToken: "test-token", prompt: "forged" } as never)).rejects.toMatchObject({ code: "BAD_REQUEST" });
    await expect(caller().production.qualifyShot({ projectId: "P1", shotId: "S1", modelId: "m", passed: true, md: "forged" } as never)).rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect(d.qualify).not.toHaveBeenCalled(); expect(d.submit).not.toHaveBeenCalled();
  });
  it("旧字段相等时仍原样提交全部canonical参数，包括UI未列出的extra", async () => {
    await caller().render.submit({ qualificationToken: "test-token", scriptId: "RS-CANONICAL", mode: "manual", durationSec: 5, aspectRatio: "16:9" });
    expect(d.submit.mock.calls[0]![0].params).toEqual(canonical().params);
  });
  it("内容资格不代替成本围栏；auto模式不能绕开服务禁用的自动审批", async () => {
    vi.stubEnv("WORKLOOM_RENDER_AUTO", "0"); d.load.mockResolvedValue({ ...canonical(), mode: "auto" });
    d.judge.mockReturnValue({ level: "review", impacts: [], triggeredBy: ["G8"] });
    await expect(caller().render.submit({ qualificationToken: "test-token" })).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
    expect(d.judge.mock.calls[0]![0].context.render_auto).toBe(false); expect(d.submit).not.toHaveBeenCalled();
  });
  it.each(["block", "budget", "cost"])("%s 不允许新外部动作", async kind => {
    if (kind === "block") d.judge.mockReturnValue({ level: "block", impacts: [], triggeredBy: ["G8"] });
    if (kind === "budget") d.budget.mockReturnValue({ allowed: false, reason: "配额不足" });
    if (kind === "cost") d.cap.mockReturnValue({ allowed: false, reason: "成本上限" });
    await expect(caller().render.submit({ qualificationToken: "test-token" })).rejects.toThrow(); expect(d.submit).not.toHaveBeenCalled();
  });
  it("已接受任务的补账不会再次消耗配额，也不因新成本上限阻断", async () => {
    d.load.mockResolvedValue({ ...canonical(), reconciliationOnly: true });
    d.judge.mockReturnValue({ level: "block", impacts: [], triggeredBy: ["G8"] });
    d.budget.mockReturnValue({ allowed: false, reason: "配额不足" }); d.cap.mockReturnValue({ allowed: false, reason: "成本上限" });
    await expect(caller().render.submit({ qualificationToken: "test-token" })).resolves.toMatchObject({ jobId: "RJ-1" });
  });
  it("资格拒绝返回可操作的前置条件错误；未登录和只读身份不能签发/提交", async () => {
    d.qualify.mockRejectedValue(new SubmissionError("PREPRODUCTION_REQUIRED", "先完成预生产"));
    await expect(caller().production.qualifyShot({ projectId: "P1", shotId: "S1", modelId: "m" })).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
    await expect(videoRouter.createCaller({ ...context, identity: null, session: null }).production.shots({ projectId: "P1" })).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    d.writable = false;
    await expect(caller().production.qualifyShot({ projectId: "P1", shotId: "S1", modelId: "m" })).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(caller().render.submit({ qualificationToken: "test-token" })).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(d.submit).not.toHaveBeenCalled();
  });
});
