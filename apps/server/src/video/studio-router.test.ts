/** 实际tRPC/输入schema与权限守卫；视频供应商、数据库和派单函数用显式边界替身。 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TrpcContext } from "../trpc/context.js";

const d = vi.hoisted(() => ({ query: vi.fn(), start: vi.fn(), existing: vi.fn(), route: vi.fn(), writable: true }));
vi.mock("@workloom/db", () => ({ getAppPool: () => ({ connect: async () => ({ query: d.query, release: vi.fn() }) }), getGatewayPool: () => ({}) }));
vi.mock("../service/access-authority.js", async original => ({ ...await original<Record<string, unknown>>(),
  currentMemberAuthority: async (identity: unknown) => ({ identity, permissions: {} }),
  memberAccessGrants: () => ({ actionPermissions: d.writable ? ["workspace.write"] : [] }),
}));
vi.mock("./studio-worker.js", async original => ({ ...await original<Record<string, unknown>>(), startRun: d.existing, startVideoProjectRun: d.start }));
vi.mock("../service/llm.js", async original => ({ ...await original<Record<string, unknown>>(), routedLlmCall: () => undefined }));
vi.mock("@hyperreality/video-studio", async original => ({ ...await original<Record<string, unknown>>(), routeVideoPipeline: d.route }));
import { videoRouter } from "./router.js";

const identity = { tenantId: "tenant-studio-router", workspaceId: "ws-studio-router", memberNo: "MEM-T", plan: "pro", role: "owner" } as NonNullable<TrpcContext["identity"]>;
const context: TrpcContext = { identity, session: identity, partnerIdentity: null, headers: new Headers() };
const caller = () => videoRouter.createCaller(context);

beforeEach(() => {
  vi.clearAllMocks(); d.writable = true; vi.stubEnv("ARCHIVE_AUTO_RESUME", "0");
  d.query.mockResolvedValue({ rows: [{ kind: "narrative" }], rowCount: 1 });
  d.route.mockResolvedValue({ route: "narrative", signals: [], via: "rules" });
  d.start.mockResolvedValue({ projectId: "VID-test", runId: "RUN-test" });
  d.existing.mockReturnValue("RUN-existing");
});
afterEach(() => vi.unstubAllEnvs());

describe("普通视频入口的内部素材字段边界", () => {
  it.each([undefined, "VID-existing"])("projectId=%s的任意内部metadata字段在路由/查项目之前拒绝", async projectId => {
    await expect(caller().studio.start({ projectId, intent: "山间风景片", route: "narrative",
      metadata: { directorIdentityImages: ["/synthetic/private.png"] },
    })).rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect(d.route).not.toHaveBeenCalled(); expect(d.query).not.toHaveBeenCalled();
    expect(d.start).not.toHaveBeenCalled(); expect(d.existing).not.toHaveBeenCalled();
  });

  it.each([[], null, false, { path: "/synthetic/private.png" }].map(value => [value]))("保留字段值为%j也不允许", async value => {
    await expect(caller().studio.start({ intent: "山间风景片", metadata: { directorIdentityImages: value } }))
      .rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect(d.route).not.toHaveBeenCalled(); expect(d.start).not.toHaveBeenCalled();
  });

  it.each([undefined, {}, { brief: { audience: "游客 中文 空格 & 特殊符号" }, customLabel: "客户自己的标记" }])(
    "普通metadata=%j保持可用并仅传登录身份scope", async metadata => {
      await expect(caller().studio.start({ intent: "山间风景片", metadata, route: "narrative" }))
        .resolves.toMatchObject({ kind: "routed", projectId: "VID-test", runId: "RUN-test" });
      expect(d.start).toHaveBeenCalledWith({ tenantId: identity.tenantId, workspaceId: identity.workspaceId },
        expect.objectContaining({ customerMetadata: metadata ?? null, by: { id: identity.memberNo, type: "human" } }));
    },
  );

  it("匿名和只读身份不因合法metadata取得写权限", async () => {
    await expect(videoRouter.createCaller({ ...context, identity: null, session: null }).studio.start({ intent: "山间风景片" }))
      .rejects.toMatchObject({ code: "UNAUTHORIZED" });
    d.writable = false;
    await expect(caller().studio.start({ intent: "山间风景片" })).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(d.route).not.toHaveBeenCalled(); expect(d.start).not.toHaveBeenCalled();
  });
});

describe("标准制片目标时长", () => {
  const intent = "制作 18 秒的雨后山间民宿短片，保留开门后的完整动作。";

  it.each([undefined, "VID-existing"])("原生入口 projectId=%s 使用指定目标秒数并保留原话", async projectId => {
    await expect(caller().studio.start({ projectId, intent, durationSec: 18 }))
      .resolves.toMatchObject({ kind: "routed", pipeline: "narrative" });
    expect(projectId ? d.existing : d.start).toHaveBeenCalledWith(
      { tenantId: identity.tenantId, workspaceId: identity.workspaceId },
      expect.objectContaining({ rawIntent: intent, intent: expect.stringContaining("[需求口径] 时长：18秒") }),
    );
  });

  it("不指定时长的现有调用继续使用 30 秒目标", async () => {
    await caller().studio.start({ intent: "山间民宿短片" });
    expect(d.start.mock.calls[0]?.[1].intent).toContain("[需求口径] 时长：30秒");
  });

  it("营销自动分流保留指定目标和可核实商品身份", async () => {
    d.route.mockResolvedValueOnce({ route: "marketing", product: { name: "测试品牌咖啡" }, signals: [], via: "rules" });
    const rawIntent = "制作 42 秒的测试品牌咖啡营销片。";
    await expect(caller().studio.start({ intent: rawIntent, durationSec: 42 }))
      .resolves.toMatchObject({ kind: "routed", pipeline: "marketing", product: "测试品牌咖啡" });
    expect(d.start.mock.calls[0]?.[1]).toMatchObject({ rawIntent, isMarketing: true,
      intent: expect.stringContaining("[需求口径] 时长：42秒") });
  });

  it.each([0, 12.5, 301])("无效时长 %s 在分流或立项前拒绝", async durationSec => {
    await expect(caller().studio.start({ intent, durationSec })).rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect(d.route).not.toHaveBeenCalled();
    expect(d.start).not.toHaveBeenCalled();
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

  const publicCases = [undefined, "VID-existing"].flatMap(projectId =>
    localReferenceCases.map(item => ({ ...item, projectId })),
  );
  it.each(publicCases)("projectId=$projectId:$label在路由/SQL/派单前拒绝", async ({ projectId, metadata }) => {
    await expect(caller().studio.start({ projectId, intent: "山间风景片", route: "narrative", metadata }))
      .rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect(d.route).not.toHaveBeenCalled(); expect(d.query).not.toHaveBeenCalled();
    expect(d.start).not.toHaveBeenCalled(); expect(d.existing).not.toHaveBeenCalled();
  });

  it.each(safeMetadataCases)("%s普通商品metadata保持路由并保留客户来源", async (_label, metadata) => {
    await expect(caller().studio.start({ intent: "山间风景片", metadata, route: "narrative" }))
      .resolves.toMatchObject({ kind: "routed", projectId: "VID-test", runId: "RUN-test" });
    expect(d.start).toHaveBeenCalledWith({ tenantId: identity.tenantId, workspaceId: identity.workspaceId },
      expect.objectContaining({ customerMetadata: metadata, by: { id: identity.memberNo, type: "human" } }));
  });
});

describe("正式一句话生产入口", () => {
  it.each([["叙事短片", "narrative"], ["宣传测试商品", "marketing"]] as const)("由系统分流 %s 至 %s，原话与时长随同一正式项目入档", async (intent, route) => {
    const raw = `制作 20 秒${intent}，用于抖音`;
    d.route.mockResolvedValue({ route, signals: [], via: "rules" });
    const result = await caller().studio.start({ officialIntent: true, intent: raw,
      ...(route === "marketing" ? { product: { name: "测试商品" } } : {}) });
    expect(result).toMatchObject({ kind: "routed", runId: "RUN-test", projectId: "VID-test", pipeline: route, durationSec: 20 });
    expect(d.route).toHaveBeenCalledWith(expect.objectContaining({ text: raw, explicit: undefined }), expect.any(Object));
    expect(d.start).toHaveBeenCalledWith(expect.objectContaining({ workspaceId: identity.workspaceId }), expect.objectContaining({
      rawIntent: raw, intent: expect.stringContaining("时长：20秒"), isMarketing: route === "marketing", creativeMode: "manual",
    }));
  });

  it.each([{ projectId: "VID-sibling" }, { metadata: {} }, { route: "marketing" }, { durationSec: 301 },
    { product: { name: "测试商品", referenceManifest: {} } }])("拒绝额外生产输入 %j", async extra => {
    await expect(caller().studio.start({ officialIntent: true, intent: "做视频", ...extra })).rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect(d.route).not.toHaveBeenCalled(); expect(d.start).not.toHaveBeenCalled();
  });

  it("运行时启用直发渲染时先拒绝正式工作单", async () => {
    vi.stubEnv("HR_DEFER_RENDER", "0");
    await expect(caller().studio.start({ officialIntent: true, intent: "做视频" }))
      .rejects.toMatchObject({ code: "PRECONDITION_FAILED", message: expect.stringContaining("OFFICIAL_RENDER_DEFER_REQUIRED") });
    expect(d.route).not.toHaveBeenCalled(); expect(d.start).not.toHaveBeenCalled();
  });

  it("解释片分流和缺少产品时均不立项", async () => {
    d.route.mockResolvedValueOnce({ route: "explainer", signals: [], via: "rules" })
      .mockResolvedValueOnce({ route: "clarify", clarify: { question: "商品是什么", missing: ["product"] }, signals: [], via: "rules" });
    await expect(caller().studio.start({ officialIntent: true, intent: "做解说片" })).resolves.toMatchObject({ kind: "unsupported", pipeline: "explainer" });
    await expect(caller().studio.start({ officialIntent: true, intent: "推广这个商品" })).resolves.toMatchObject({ kind: "clarify", missing: ["product"] });
    expect(d.start).not.toHaveBeenCalled();
  });
});
