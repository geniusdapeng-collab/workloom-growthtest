import { describe, expect, it } from "vitest";
import {
  ROUTE_RECORD_SCHEMA,
  RoutePreflightError,
  detectProductAnchor,
  resolveRoutePreflight,
  type RoutePreflightErrorCode
} from "./route-preflight.js";

function codeOf(fn: () => unknown): RoutePreflightErrorCode | null {
  try {
    fn();
    return null;
  } catch (error) {
    return error instanceof RoutePreflightError ? error.code : null;
  }
}

describe("detectProductAnchor —— 只认显式声明，不猜商品", () => {
  it("brief.product 字符串 / 对象", () => {
    expect(detectProductAnchor({ brief: { product: "酒店自助入住机" } })).toBe("酒店自助入住机");
    expect(detectProductAnchor({ brief: { product: { name: "示例品牌 AI 智慧前台", brand: "示例品牌" } } })).toBe("示例品牌 AI 智慧前台");
  });
  it("brief.products[] / shotlist.products[]", () => {
    expect(detectProductAnchor({ brief: { products: [{ name: "自助入住机" }] } })).toBe("自助入住机");
    expect(detectProductAnchor({ shotlist: { products: ["自助入住机"] } })).toBe("自助入住机");
  });
  it("镜头卡 productRef（字符串 / 对象）", () => {
    expect(detectProductAnchor({ shotlist: { shots: [{ shotId: "FP-01" }, { shotId: "FP-02", productRef: "fp-checkin" }] } })).toBe("fp-checkin");
    expect(detectProductAnchor({ shotlist: { shots: [{ productRef: { id: "fp-checkin", name: "自助入住机" } }] } })).toBe("自助入住机");
  });
  it("没有任何显式声明时返回 null（绝不从文案猜）", () => {
    expect(detectProductAnchor({ brief: { goal: "卖爆自助入住机" }, shotlist: { title: "自助入住机真香" } })).toBeNull();
  });
});

describe("resolveRoutePreflight —— 出片入口的 fail-closed 分流闸", () => {
  it("既没有 --route 也没有 --route-kind：ROUTE_REQUIRED", () => {
    expect(codeOf(() => resolveRoutePreflight({ productAnchor: null }))).toBe("ROUTE_REQUIRED");
  });

  it("显式 --route-kind narrative：放行，来源=explicit，不要求商品锚点", () => {
    const result = resolveRoutePreflight({ routeKind: "narrative", productAnchor: null });
    expect(result.kind).toBe("narrative");
    expect(result.source).toBe("explicit");
    expect(result.notes.join(" ")).toContain("显式声明");
  });

  it("route 记录（marketing + 商品锚点）：放行并带着锚点", () => {
    const result = resolveRoutePreflight({
      routeRecord: {
        schemaVersion: ROUTE_RECORD_SCHEMA,
        decision: { route: "marketing", confidence: 0.92, via: "rule", product: { name: "自助入住机" } }
      },
      productAnchor: "自助入住机"
    });
    expect(result.kind).toBe("marketing");
    expect(result.source).toBe("route-file");
    expect(result.productAnchor).toBe("自助入住机");
    expect(result.notes.join(" ")).toContain("route 记录");
  });

  it("营销片缺商品锚点：MARKETING_PRODUCT_ANCHOR_MISSING", () => {
    expect(codeOf(() => resolveRoutePreflight({ routeKind: "marketing", productAnchor: null })))
      .toBe("MARKETING_PRODUCT_ANCHOR_MISSING");
  });

  it("分流结论是 clarify：ROUTE_CLARIFY（先问用户，不替用户花钱）", () => {
    const code = codeOf(() => resolveRoutePreflight({
      routeRecord: {
        schemaVersion: ROUTE_RECORD_SCHEMA,
        decision: { route: "clarify", clarify: { question: "这条片子是卖货还是讲品牌故事？" } }
      },
      productAnchor: null
    }));
    expect(code).toBe("ROUTE_CLARIFY");
  });

  it("schema 不匹配 / 路由值非法：ROUTE_FILE_INVALID", () => {
    expect(codeOf(() => resolveRoutePreflight({ routeRecord: { schemaVersion: "v0", decision: { route: "marketing" } }, productAnchor: "x" })))
      .toBe("ROUTE_FILE_INVALID");
    expect(codeOf(() => resolveRoutePreflight({ routeRecord: { schemaVersion: ROUTE_RECORD_SCHEMA, decision: {} }, productAnchor: "x" })))
      .toBe("ROUTE_FILE_INVALID");
  });

  it("口播解说片走错执行器：ROUTE_KIND_UNSUPPORTED 并指向 explainer:run", () => {
    expect(codeOf(() => resolveRoutePreflight({ routeKind: "explainer", productAnchor: null })))
      .toBe("ROUTE_KIND_UNSUPPORTED");
    expect(codeOf(() => resolveRoutePreflight({
      routeRecord: { schemaVersion: ROUTE_RECORD_SCHEMA, decision: { route: "explainer" } },
      productAnchor: null
    }))).toBe("ROUTE_KIND_UNSUPPORTED");
  });
});
