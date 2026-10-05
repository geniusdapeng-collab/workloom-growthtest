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
