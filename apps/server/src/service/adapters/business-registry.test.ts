import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { loadBundleUiProjection, type BundleUiProjection } from "@workloom/base/bundles";
import {
  bindBusinessAdapter,
  registeredBusinessAdapterIds,
} from "./business-registry.js";

describe("服务前台行业适配器契约", () => {
  const hotelProjection = loadBundleUiProjection("hotel");
  const projectionAs = (
    bundleId: string,
    serviceFront: BundleUiProjection["ui"]["serviceFront"],
  ): BundleUiProjection => ({
    ...hotelProjection,
    primaryBundleId: bundleId,
    bundleId,
    sources: hotelProjection.sources?.map((source) => ({
      ...source,
      bundleId,
      role: "primary",
      parentBundleId: null,
    })),
    ui: { ...hotelProjection.ui, serviceFront },
  });

  it("酒店仅由已封装活动 Bundle 的 adapterId 显式启用", () => {
    const result = bindBusinessAdapter({
      workspaceBundleId: "hotel",
      activeInstalls: [{ id: "bi-hotel", bundleId: "hotel" }],
    });
    expect(result).toMatchObject({
      state: "ready",
      bundleId: "hotel",
      installId: "bi-hotel",
      adapter: { id: "hotel.service-front-v1" },
    });
    expect(result.adapter?.kbLexicon?.synonyms).toContainEqual(["会员", "会员卡"]);
  });

  it("未声明行业适配器的包（ai-video）绝不回退酒店", () => {
    const result = bindBusinessAdapter({
      workspaceBundleId: "ai-video",
      activeInstalls: [{ id: "bi-video", bundleId: "ai-video" }],
    }, () => projectionAs("ai-video", {
      ...hotelProjection.ui.serviceFront,
      adapterId: undefined,
    }));
    expect(result.state).toBe("adapter-not-declared");
    expect(result.adapter).toBeNull();
  });

  it("无活动装配、指针冲突、投影篡改和未知适配器均失败关闭", () => {
    expect(bindBusinessAdapter({ workspaceBundleId: "ai-video", activeInstalls: [] }).adapter).toBeNull();

    const mismatch = bindBusinessAdapter({
      workspaceBundleId: "ai-video",
      activeInstalls: [{ id: "bi-hotel", bundleId: "hotel" }],
    });
    expect(mismatch).toMatchObject({ state: "bundle-mismatch", adapter: null });

    const invalid = bindBusinessAdapter({
      workspaceBundleId: "hotel",
      activeInstalls: [{ id: "bi-hotel", bundleId: "hotel" }],
    }, () => { throw new Error("摘要不一致"); });
    expect(invalid).toMatchObject({ state: "projection-invalid", adapter: null });

    const unknownProjection = projectionAs("unknown", {
      ...hotelProjection.ui.serviceFront,
      adapterId: "unknown.service-front-v1",
    });
    const unknown = bindBusinessAdapter({
      workspaceBundleId: "unknown",
      activeInstalls: [{ id: "bi-unknown", bundleId: "unknown" }],
    }, () => unknownProjection);
    expect(unknown).toMatchObject({ state: "adapter-unknown", adapter: null });
  });

  it("受控注册表只登记已审核的行业前台（获客用增 + 酒店试点），不含通用默认适配器", () => {
    expect(registeredBusinessAdapterIds()).toEqual(["geo-growth.service-front-v1", "hotel.service-front-v1"]);
  });

  it("跨 Bundle 伪造 adapterId 一律失败关闭（geo-growth 不得选择酒店实现）", () => {
    // 安全不变量：受控目录按 bundleId 授权适配器。geo-growth 只能选择自己的
    // geo-growth.service-front-v1；即使投影里写了 hotel.service-front-v1 也判 adapter-untrusted，
    // 从而不会读到酒店订单/会员。
    const result = bindBusinessAdapter({
      workspaceBundleId: "geo-growth",
      activeInstalls: [{ id: "bi-geo", bundleId: "geo-growth" }],
    }, () => projectionAs("geo-growth", {
      ...hotelProjection.ui.serviceFront,
      adapterId: "hotel.service-front-v1",
    }));
    expect(result).toMatchObject({ state: "adapter-untrusted", adapter: null, bundleId: "geo-growth" });
  });

  it("获客用增（geo-growth）由自己的 adapterId 显式启用产品前台", () => {
    const result = bindBusinessAdapter({
      workspaceBundleId: "geo-growth",
      activeInstalls: [{ id: "bi-geo", bundleId: "geo-growth" }],
    }, () => projectionAs("geo-growth", {
      ...hotelProjection.ui.serviceFront,
      adapterId: "geo-growth.service-front-v1",
    }));
    expect(result).toMatchObject({
      state: "ready",
      bundleId: "geo-growth",
      installId: "bi-geo",
      adapter: { id: "geo-growth.service-front-v1" },
    });
    expect(result.adapter?.kbLexicon?.synonyms).toContainEqual(["增长", "获客"]);
  });

  it("基座网关、通用对话和启动引导不再含酒店数据访问或酒店展示语义", () => {
    const gateway = readFileSync(new URL("../gateway.ts", import.meta.url), "utf8");
    const dialog = readFileSync(new URL("../dialog.ts", import.meta.url), "utf8");
    const store = readFileSync(new URL("../store.ts", import.meta.url), "utf8");
    const ticket = readFileSync(new URL("../ticket.ts", import.meta.url), "utf8");
    const forbidden = /biz-hotel|hotelBizAdapter|demo_orders|demo_members|云栖酒店|房型价格|客房部|前厅部/;
    expect(gateway).not.toMatch(forbidden);
    expect(dialog).not.toMatch(forbidden);
    expect(store).not.toMatch(forbidden);
    expect(ticket).not.toMatch(forbidden);
  });

  it("通用注册表不直接导入任何具体行业实现", () => {
    const registry = readFileSync(new URL("./business-registry.ts", import.meta.url), "utf8");
    expect(registry).not.toMatch(/service-front-adapter|hotelBizAdapter|industry\/hotel/);
    expect(registry).toContain("business-adapter-catalog");
  });
});
