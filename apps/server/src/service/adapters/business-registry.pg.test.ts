/**
 * 活库契约：适配器选择经 serviceTx/RLS 读取活动装配。
 *
 * 断言两条安全不变量：
 *  ① 已装配 hotel 并声明 hotel.service-front-v1 的工作区 → ready，注入酒店适配器；
 *  ② 未声明行业适配器的 Bundle（ai-video）→ adapter-not-declared + 适配器为 null，
 *     且 C 端业务接口返回**明确空态**（available:false）而不是回退到酒店数据或 503。
 *
 * 夹具自足：本文件自行建/删一个 ai-video 工作区（CI 只 seed 酒店演示工作区），
 * 不依赖额外的环境变量，也不会静默跳过。
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Hono } from "hono";
import { getOwnerPool } from "@workloom/db";

process.env.DATABASE_URL ??= "postgres://postgres:workloom@localhost:5432/workloom";
process.env.DATABASE_APP_URL ??= "postgres://workloom_app:workloom_dev_app@localhost:5432/workloom";
process.env.DATABASE_GATEWAY_URL ??= "postgres://workloom_gateway:workloom_dev_gateway@localhost:5432/workloom";
process.env.SERVICE_C_DEMO_AUTH = "true";

const HOTEL_FIXTURE_WORKSPACE_ID = process.env.SERVICE_C_TEST_WORKSPACE_ID?.trim() || null;
/** 无行业适配器的夹具工作区（ai-video 包未声明 serviceFront.adapterId） */
const NO_ADAPTER_WORKSPACE_ID = "ws-contract-noadapter";
const RUN_DB = process.env.RUN_DB_TESTS === "1"
  && Boolean(process.env.DATABASE_APP_URL)
  && Boolean(HOTEL_FIXTURE_WORKSPACE_ID);

describe.runIf(RUN_DB)("活动 Bundle 服务前台适配器 PG 契约", () => {
  let app: Hono;
  let token = "";
  let resolveWorkspaceBusinessAdapter: typeof import("./business-registry.js").resolveWorkspaceBusinessAdapter;

  beforeAll(async () => {
    const owner = getOwnerPool();
    await owner.query(
      `INSERT INTO workspaces (id, tenant_id, name, slug, industry, bundle_id, is_example)
       SELECT $1, tenant_id, '服务前台契约夹具（无适配器）', $1, 'ai-video', 'ai-video', false
       FROM workspaces WHERE id=$2
       ON CONFLICT (id) DO UPDATE SET industry='ai-video', bundle_id='ai-video'`,
      [NO_ADAPTER_WORKSPACE_ID, HOTEL_FIXTURE_WORKSPACE_ID],
    );
    await owner.query(
      `INSERT INTO bundle_installs (id, workspace_id, bundle_id, assets, status)
       VALUES ($1,$2,'ai-video','{}'::jsonb,'active')
       ON CONFLICT (id) DO UPDATE SET status='active'`,
      [`bi-${NO_ADAPTER_WORKSPACE_ID}-ai-video`, NO_ADAPTER_WORKSPACE_ID],
    );

    ({ serviceGateway: app } = await import("../gateway.js"));
    ({ resolveWorkspaceBusinessAdapter } = await import("./business-registry.js"));
    const { issueCToken, cSecret } = await import("../channels.js");
    token = await issueCToken({
      workspaceId: NO_ADAPTER_WORKSPACE_ID,
      cUserId: "contract-no-industry-subject",
      channel: "h5",
      secret: cSecret(),
    });
  });

  afterAll(async () => {
    const owner = getOwnerPool();
    await owner.query(`DELETE FROM bundle_installs WHERE workspace_id=$1`, [NO_ADAPTER_WORKSPACE_ID]);
    await owner.query(`DELETE FROM c_users WHERE workspace_id=$1`, [NO_ADAPTER_WORKSPACE_ID]);
    await owner.query(`DELETE FROM workspaces WHERE id=$1`, [NO_ADAPTER_WORKSPACE_ID]);
  });

  it("同库活动装配经 RLS 分别选择 hotel；无适配器包不选择任何酒店实现", async () => {
    const hotel = await resolveWorkspaceBusinessAdapter(HOTEL_FIXTURE_WORKSPACE_ID!);
    const noAdapter = await resolveWorkspaceBusinessAdapter(NO_ADAPTER_WORKSPACE_ID);
    expect(hotel).toMatchObject({ state: "ready", adapter: { id: "hotel.service-front-v1" } });
    expect(noAdapter).toMatchObject({ state: "adapter-not-declared", adapter: null, bundleId: "ai-video" });
  });

  it("获客用增演示工作区（ws-geo）解析到产品自己的前台适配器", async () => {
    // 主题口径：获客用增是本仓产品主题；ws-geo 由 db:seed 链（seed.ts + seed-geo.ts）确定性产出，
    // 必须解析到 geo-growth.service-front-v1，而不是回退到酒店试点前台。
    const geo = await resolveWorkspaceBusinessAdapter("ws-geo");
    expect(geo).toMatchObject({
      state: "ready",
      bundleId: "geo-growth",
      adapter: { id: "geo-growth.service-front-v1" },
    });
  });

  it("无适配器工作区的公开订单与权益端点返回明确空态，绝不读同库酒店夹具", async () => {
    const headers = { Authorization: `Bearer ${token}` };
    const ordersResponse = await app.request("/orders", { headers });
    const memberResponse = await app.request("/member", { headers });
    expect(ordersResponse.status).toBe(200);
    expect(memberResponse.status).toBe(200);
    expect(await ordersResponse.json()).toMatchObject({ orders: [], demo: false, available: false });
    expect(await memberResponse.json()).toMatchObject({
      title: "权益信息不可用", benefits: [], demo: false, available: false,
    });
  });
});
