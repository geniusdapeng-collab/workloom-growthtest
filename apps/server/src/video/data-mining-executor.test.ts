import { describe, expect, it } from "vitest";
import {
  createDataMiningExecutor,
  filterUnknownUrls,
  normalizeUrl,
  validateStagePayload,
  type SearchHit,
} from "./data-mining-executor.js";

/**
 * T-2026-0925-0002：情报执行器「反虚构」硬闸。
 *
 * 这组用例守的是营销片最容易翻车的地方——**模型编造来源**：
 * 检索命中 A 站，模型却回填 B 站的漂亮链接（看起来很权威），一旦放行，
 * 下游创意/PRD 就会把幻觉当事实用。执行器必须在代码层剔除，而不是靠提示词自律。
 */
describe("商品情报执行器", () => {
  const hits: SearchHit[] = [
    { title: "星野官网 F3", url: "https://www.xingye.com/f3", snippet: "9 档风量，静音 22dB" },
    { title: "京东旗舰店", url: "https://mall.jd.com/f3.html", snippet: "到手价 399 元" },
    { title: "知乎测评", url: "https://www.zhihu.com/p/123", snippet: "实测噪音表现一般" },
  ];
  const fakeSearch = async (): Promise<SearchHit[]> => hits;

  it("URL 白名单：非检索命中的链接一律剔除", () => {
    const allowed = new Set(hits.map((h) => normalizeUrl(h.url)));
    const { value, report } = filterUnknownUrls(
      {
        official_selling_points: [
          { point: "静音", source_url: "https://www.xingye.com/f3" },
          { point: "省电", source_url: "https://fake-official.example.com/x" },
        ],
      },
      allowed,
    );
    const points = (value as { official_selling_points: Array<{ point: string }> }).official_selling_points;
    expect(points).toHaveLength(1);
    expect(points[0]!.point).toBe("静音");
    expect(report.dropped).toBe(1);
  });

  it("URL 归一化：fragment 与尾斜杠不影响白名单比对", () => {
    expect(normalizeUrl("https://Mall.JD.com/f3.html/#reviews")).toBe("https://mall.jd.com/f3.html");
    expect(normalizeUrl("https://www.xingye.com/f3/")).toBe(normalizeUrl("https://www.xingye.com/f3"));
  });

  it("回填形状校验：A1 缺 identity/name、A2 空数组、A3 缺 competitors 一律判失败", () => {
    expect(validateStagePayload("A1", { images: [] }).ok).toBe(false);
    expect(validateStagePayload("A1", { identity: { name: "星野空气循环扇" }, images: [] }).ok).toBe(true);
    expect(validateStagePayload("A2", { reviews: [] }).ok).toBe(false);
    expect(validateStagePayload("A2", { reviews: [{ text: "好用", url: "https://x" }] }).ok).toBe(true);
    expect(validateStagePayload("A3", { adjacent_notes: [] }).ok).toBe(false);
    expect(validateStagePayload("A3", { competitors: [] }).ok).toBe(true);
  });

  it("happy path：检索 → 模型回填 → 白名单清洗 → 通过", async () => {
    const logs: string[] = [];
    const executor = createDataMiningExecutor({
      search: fakeSearch,
      log: (line) => logs.push(line),
      llm: {
        reason: async () => ({
          success: true,
          data: {
            identity: {
              name: "星野空气循环扇",
              brand: "星野",
              category: "小家电",
              specs: {},
              prices: [{ amount: 399, currency: "CNY", source_url: "https://mall.jd.com/f3.html" }],
              official_selling_points: [{ point: "静音", source_url: "https://www.xingye.com/f3" }],
            },
            images: [{ url: "https://www.xingye.com/f3", source: "官网", page_url: "https://www.xingye.com/f3", angle: "正面" }],
          },
        }),
      },
    });
    const out = await executor("A1", { queries: [{ q: "星野空气循环扇 官网" }] });
    expect(out).not.toBeNull();
    expect((out!.identity as { name: string }).name).toBe("星野空气循环扇");
    expect(logs.join("\n")).toContain("检索完成");
    expect(logs.join("\n")).toContain("回填就绪");
  });

  it("检索零结果 → 缺站返 null（不返回空壳冒充采集成功）", async () => {
    const executor = createDataMiningExecutor({
      search: async () => [],
      llm: { reason: async () => ({ success: true, data: {} }) },
    });
    expect(await executor("A2", { queries: [{ q: "x" }] })).toBeNull();
  });

  it("模型全部引用幻觉链接 → 清洗后校验不通过 → 缺站返 null", async () => {
    const logs: string[] = [];
    const executor = createDataMiningExecutor({
      search: fakeSearch,
      log: (line) => logs.push(line),
      llm: {
        reason: async () => ({
          success: true,
          data: {
            reviews: [{ text: "很好用", source: "官网", url: "https://made-up.example.com/1" }],
          },
        }),
      },
    });
    expect(await executor("A2", { queries: [{ q: "星野 评价" }] })).toBeNull();
    expect(logs.join("\n")).toContain("缺站");
  });

  it("模型失败/超时 → 缺站返 null（不抛错打断主流程）", async () => {
    const executor = createDataMiningExecutor({
      search: fakeSearch,
      llm: { reason: async () => ({ success: false, error: "HTTP 500" }) },
    });
    expect(await executor("A3", { queries: [{ q: "竞品" }] })).toBeNull();
  });

  it("缺查询矩阵 → 直接缺站（不空跑模型）", async () => {
    let called = false;
    const executor = createDataMiningExecutor({
      search: fakeSearch,
      llm: { reason: async () => { called = true; return { success: true, data: {} }; } },
    });
    expect(await executor("A1", {})).toBeNull();
    expect(called).toBe(false);
  });
});
