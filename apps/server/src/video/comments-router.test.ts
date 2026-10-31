import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { TrpcContext } from "../trpc/context.js";

const d = vi.hoisted(() => ({
  query: vi.fn(),
  processComment: vi.fn(),
}));

vi.mock("@workloom/db", () => {
  const client = { query: d.query, release: vi.fn() };
  const pool = { connect: async () => client, query: d.query };
  return { getAppPool: () => pool, getGatewayPool: () => pool };
});

vi.mock("../service/access-authority.js", async (original) => ({
  ...await original<Record<string, unknown>>(),
  currentMemberAuthority: async (identity: unknown) => ({ identity, permissions: {} }),
  memberAccessGrants: () => ({ actionPermissions: ["workspace.write"] }),
}));

vi.mock("@workloom/base/social-listening", async (original) => ({
  ...await original<Record<string, unknown>>(),
  processComment: d.processComment,
}));

let caller: ReturnType<typeof import("./router.js")["videoRouter"]["createCaller"]>;

beforeAll(async () => {
  vi.stubEnv("ARCHIVE_AUTO_RESUME", "0");
  vi.stubEnv("LLM_PROVIDER", "mock");
  const { videoRouter } = await import("./router.js");
  const identity = {
    tenantId: "tenant-comments",
    workspaceId: "workspace-comments",
    memberNo: "MEM-C",
    plan: "pro",
    role: "owner",
  } as NonNullable<TrpcContext["identity"]>;
  caller = videoRouter.createCaller({
    identity,
    session: identity,
    partnerIdentity: null,
    headers: new Headers(),
  });
});

beforeEach(() => {
  vi.clearAllMocks();
  d.query.mockResolvedValue({ rows: [], rowCount: 0 });
  d.processComment.mockResolvedValue({
    commentId: "cm-1",
    intent: "praise",
    classifySource: "rules",
    decision: { level: "auto", alert: false, reason: "系统审批" },
    qualityRouteLevel: "auto",
    autoApproved: false,
    replyId: "cm-1-reply-1",
  });
});

describe("video.comments 生产入口", () => {
  it("process 复用 social-listening 并显式传入 AI 视频自动审批作用域", async () => {
    d.query.mockImplementation(async (sql: string) => {
      if (sql.includes("FROM profiles")) return { rows: [{ forbidden: ["敏感词"] }], rowCount: 1 };
      return { rows: [], rowCount: 0 };
    });
    const result = await caller.comments.process({ commentId: "cm-1" });
    expect(result.commentId).toBe("cm-1");
    expect(d.processComment).toHaveBeenCalledWith(
      expect.anything(), expect.anything(),
      { tenantId: "tenant-comments", workspaceId: "workspace-comments" },
      "cm-1",
      expect.objectContaining({ sensitiveWords: ["敏感词"], autoApproveReview: true }),
    );
  });

  it("manual 人工草稿保留在待处理队列", async () => {
    await caller.comments.pending({ limit: 20 });
    const commentsQuery = d.query.mock.calls.find(([sql]) => String(sql).includes("FROM comments"))!;
    expect(String(commentsQuery[0])).toContain("status IN ('new','pending_review','manual')");
  });
});
