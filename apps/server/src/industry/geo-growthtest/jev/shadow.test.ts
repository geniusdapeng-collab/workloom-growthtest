/**
 * 影子执行器端到端单测（真 HTTP，但网关是本地模拟：127.0.0.1，无外呼、无 key）。
 *
 * 验证：数据集 → 请求 → 回答 → 分流 → 报告 的完整链路；成本熔断；失败如实记账。
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { JevClient } from "./client.js";
import { startMockServer, type MockServer } from "./mock-gateway.js";
import { SCENES, commentClassifyScene, factPrecheckScene } from "./scenes.js";
import { runShadow } from "./shadow.js";
import type { ShadowRow } from "./types.js";

let server: MockServer;
let client: JevClient;

beforeAll(async () => {
  server = await startMockServer();
  // 走默认通道（typesafe）+ 默认模型别名（jev-latest）→ 模拟通道按真实语义回报版本化 id
  client = new JevClient({ apiKey: "mock", baseUrl: server.url });
});

afterAll(async () => {
  await server.close();
});

const ROWS: ShadowRow[] = [
  { id: "r1", text: "想问一下你们房间多少钱一晚", expected: "inquiry" },
  { id: "r2", text: "我想预订下周六的房间，两个人住", expected: "booking_intent" },
  { id: "r3", text: "房间太差了，我要投诉并要求赔偿", expected: "complaint" },
  { id: "r4", text: "加微信领取优惠券群返现", expected: "spam" },
  { id: "r5", text: "今天的天气真不错", expected: "smalltalk" },
];

describe("runShadow（本地模拟网关）", () => {
  it("整条链路可跑通：5 行全部成功且与期望一致", async () => {
    const { outcomes, report } = await runShadow({ rows: ROWS, scene: commentClassifyScene, client, concurrency: 2 });
    expect(report.total).toBe(5);
    expect(report.failed).toBe(0);
    expect(report.accuracy).toBe(1);
    expect(report.baseUrlHost).toMatch(/^127\.0\.0\.1:\d+$/);
    expect(report.costUsd).toBeGreaterThan(0);
    // 响应自报的版本化 id 会被收进报告（与请求用的别名分开记，别名漂移可观测）
    expect(report.responseModels).toEqual(["jev-1.13.0"]);
    expect(outcomes.every((row) => row.decisionZh.length > 0)).toBe(true);
  });

  it("投诉行会命中 needs_human → 人工；其余行按阈值分流", async () => {
    const { outcomes } = await runShadow({ rows: ROWS, scene: commentClassifyScene, client });
    const complaint = outcomes.find((row) => row.id === "r3");
    expect(complaint?.route).toBe("human");
    const booking = outcomes.find((row) => row.id === "r2");
    expect(booking?.route).toBe("auto");
  });

  it("成本熔断：maxCostUsd=0 时全部记为预算超限且不调用网关", async () => {
    const { outcomes, report } = await runShadow({ rows: ROWS, scene: commentClassifyScene, client, maxCostUsd: 0 });
    expect(report.failed).toBe(5);
    expect(outcomes.every((row) => row.error?.includes("成本预算超限"))).toBe(true);
  });

  it("缺 officialClaims 的 fact-precheck 行失败但不中断其它行", async () => {
    const rows: ShadowRow[] = [
      { id: "f1", text: "本店提供机场专车接送服务" },
      {
        id: "f2",
        text: "本店支持入住前 24 小时免费取消",
        expected: "pass",
        officialClaims: ["本店提供免费取消，入住前 24 小时可退"],
      },
    ];
    const { outcomes, report } = await runShadow({ rows, scene: factPrecheckScene, client });
    expect(report.failed).toBe(1);
    expect(outcomes.find((row) => row.id === "f1")?.error).toContain("officialClaims");
    expect(outcomes.find((row) => row.id === "f2")?.decision).toBe("pass");
  });

  it("场景表完整（三个试点场景都在）", () => {
    expect(Object.keys(SCENES).sort()).toEqual(["comment-classify", "fact-precheck", "lead-qualify"]);
  });
});
