/**
 * 获客用增 C 端前台适配器单测：意图分流、工单归口、目录与空态契约。
 * 约束：适配器只能输出中文业务词；不得读取客户明细（免绑定）。
 */
import { describe, expect, it } from "vitest";
import { geoGrowthBizAdapter } from "./service-front-adapter.js";

const CTX = { workspaceId: "ws-geo", cUserId: "cu-geo", memberId: null };

describe("geo-growth 服务前台适配器", () => {
  it("身份与词表：adapterId 明确、同义词归行业所有", () => {
    expect(geoGrowthBizAdapter.id).toBe("geo-growth.service-front-v1");
    expect(geoGrowthBizAdapter.kbLexicon?.synonyms).toContainEqual(["增长", "获客"]);
    expect(geoGrowthBizAdapter.identity).toBeUndefined();
  });

  it("意图分流：合作/方案/报价走目录，进度/跟进走跟进查询，其余不冒领", () => {
    expect(geoGrowthBizAdapter.classify("你们怎么合作？有报价吗")).toMatchObject({ tool: "query_catalog" });
    expect(geoGrowthBizAdapter.classify("我提交的需求进度到哪一步了")).toMatchObject({ tool: "query_order" });
    expect(geoGrowthBizAdapter.classify("今天天气怎么样")).toBeNull();
  });

  it("工单归口：投诉归客户成功组，合作咨询归增长顾问组", () => {
    expect(geoGrowthBizAdapter.ticketKind?.("我要投诉服务态度")).toBe("complaint");
    expect(geoGrowthBizAdapter.ticketKind?.("想咨询一下 GEO 合作")).toBe("consult");
    expect(geoGrowthBizAdapter.ticketKind?.("随便看看")).toBeNull();
    expect(geoGrowthBizAdapter.departmentForTicket?.("complaint")).toBe("客户成功组");
    expect(geoGrowthBizAdapter.departmentForTicket?.("consult")).toBe("增长顾问组");
  });

  it("目录：只输出中文业务投影，≥4 项获客增长服务", async () => {
    const catalog = await geoGrowthBizAdapter.queryCatalog(CTX);
    expect(catalog.cardTitle).toBe("获客增长服务");
    expect(catalog.items.length).toBeGreaterThanOrEqual(4);
    for (const item of catalog.items) {
      expect(item.title).toMatch(/\p{Script=Han}/u);
      expect(item.summary ?? "").toMatch(/\p{Script=Han}/u);
      for (const field of item.details) {
        expect(field.label).toMatch(/\p{Script=Han}/u);
        expect(field.value).not.toMatch(/bundle_id|preset_key|workspace_id|SELECT|INSERT/i);
      }
    }
  });

  it("免绑定空态：跟进查询与身份查询都返回明确指引，不读取客户明细", async () => {
    const order = await geoGrowthBizAdapter.queryOrder(CTX);
    expect(order.orders).toEqual([]);
    expect(order.demo).toBe(false);
    expect(order.hint).toContain("工单");
    const member = await geoGrowthBizAdapter.queryMember(CTX);
    expect(member.member).toBeNull();
    expect(member.bindRequired).toBe(false);
    expect(member.hint).toContain("免身份绑定");
  });
});
