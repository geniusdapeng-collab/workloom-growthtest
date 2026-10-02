import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { InquiryPreviewError, previewInquiry } from "./preview.mjs";

const manifest = JSON.parse(readFileSync(new URL("../agent-capabilities.json", import.meta.url), "utf8")) as {
  schemaVersion: string;
  bundleId: string;
  capabilities: Array<{
    id: string;
    description: string;
    operation: string;
    transport: { kind: string; method?: string; path?: string; module?: string; export?: string };
    inputSchema: { required?: string[] };
    dataMode: string;
    enabled?: boolean;
    disabledReason?: string;
  }>;
};

describe("geo-growth agent capability declaration", () => {
  it("exposes only the existing C gateway paths, while the unsafe execute path stays disabled", () => {
    expect(manifest.schemaVersion).toBe("workloom.agent-capabilities/v1");
    expect(manifest.bundleId).toBe("geo-growth");
    expect(manifest.capabilities.map((capability) => capability.id)).toEqual([
      "growth.service.ticket.list",
      "growth.service.inquiry.preview",
      "growth.service.inquiry.execute",
      "growth.service.ticket.receipt",
    ]);
    const [list, preview, execute, receipt] = manifest.capabilities;
    expect(list?.transport).toMatchObject({ kind: "c-service", method: "GET", path: "/c/tickets" });
    expect(preview?.transport).toMatchObject({
      kind: "local", module: "bundles/geo-growth/capabilities/preview.mjs", export: "previewInquiry",
    });
    expect(execute?.transport).toMatchObject({ kind: "c-service", method: "POST", path: "/c/tickets" });
    expect(execute?.inputSchema.required).toContain("idempotencyKey");
    expect(preview?.inputSchema.properties?.idempotencyKey).toMatchObject({ minLength: 8 });
    expect(execute?.inputSchema.properties?.idempotencyKey).toMatchObject({ minLength: 8 });
    expect(execute?.enabled).toBe(false);
    expect(execute?.disabledReason).toMatch(/幂等跨用户隔离/);
    expect(execute?.disabledReason).toMatch(/服务端活动 geo-growth 行业包绑定/);
    expect(receipt?.transport).toMatchObject({ kind: "c-service", method: "GET", path: "/c/tickets/{id}" });
    expect(list?.description).toMatch(/咨询以外的类型/);
    expect(receipt?.description).toMatch(/咨询以外的类型/);
    expect(manifest.capabilities.every((capability) => capability.dataMode === "simulated")).toBe(true);
  });
});

describe("previewInquiry", () => {
  it("normalizes the same kind/title/payload shape used by the C service form without writing", () => {
    const input = {
      kind: "consult",
      title: "  咨询 GEO + 视频合作  ",
      payload: { description: "预算待议，目标市场：上海", reference: "活动#1" },
    };
    expect(previewInquiry(input)).toMatchObject({
      previewOnly: true,
      request: { kind: "consult", title: "咨询 GEO + 视频合作", payload: input.payload },
      notificationDelivery: "simulated",
      serverChecksPending: expect.arrayContaining(["C 会话", "行业归口或通用兜底", "幂等归属"]),
    });
    expect(input.title).toBe("  咨询 GEO + 视频合作  ");
  });

  it("accepts the service_request kind and the gateway's exact 10 Ki character boundary", () => {
    expect(previewInquiry({ kind: "service_request", title: "联系人工顾问" }).request.payload).toEqual({});
    expect(previewInquiry({ kind: "consult", title: "边界", idempotencyKey: "12345678" }).request.idempotencyKey).toBe("12345678");
    const exact = "x".repeat(10 * 1024 - '{"text":""}'.length);
    expect(previewInquiry({ kind: "consult", title: "边界", payload: { text: exact } }).payloadJsonChars).toBe(10 * 1024);
    expect(() => previewInquiry({ kind: "consult", title: "越界", payload: { text: `${exact}x` } })).toThrow(InquiryPreviewError);
  });

  it.each([
    ["empty title", { kind: "consult", title: "  " }],
    ["long title", { kind: "consult", title: "长".repeat(121) }],
    ["wrong kind", { kind: "complaint", title: "问题" }],
    ["array payload", { kind: "consult", title: "问题", payload: [] }],
    ["empty key", { kind: "consult", title: "问题", idempotencyKey: "" }],
    ["short key", { kind: "consult", title: "问题", idempotencyKey: "short" }],
    ["unknown field", { kind: "consult", title: "问题", workspaceId: "other" }],
  ])("rejects %s before the server call", (_label, input) => {
    expect(() => previewInquiry(input)).toThrowError(InquiryPreviewError);
  });

  it("rejects values that cannot be serialized to the server's JSON payload", () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    expect(() => previewInquiry({ kind: "consult", title: "问题", payload: circular })).toThrow(/JSON/);
  });
});
