import { describe, expect, it, vi } from "vitest";
import {
  createApiSearchRunner,
  createDataMiningExecutor,
  filterUnknownUrls,
  normalizeUrl,
  resolveApiSearchConfig,
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

  /* ---------- API 检索源（生产首选通道，T-2026-0925-0003） ---------- */

  it("Tavily 协议：POST body 带 api_key，results[].content 作摘要", async () => {
    let capturedBody = "";
    const runner = createApiSearchRunner({
      provider: "tavily",
      apiKey: "tvly-test",
      apiUrl: "https://api.tavily.com/search",
      fetchImpl: (async (_url: string, init: RequestInit) => {
        capturedBody = String(init.body ?? "");
        return {
          ok: true,
          status: 200,
          json: async () => ({ results: [
            { title: "米家空气净化器4 Lite 参数 - ZOL", url: "https://detail.zol.com.cn/air_purifier/1.shtml", content: "适用面积 26-45㎡，噪音≤60分贝" },
            { title: "开箱实测", url: "https://www.bilibili.com/video/BV1xx", content: "睡眠档 33dB" },
          ] }),
        } as unknown as Response;
      }) as unknown as typeof fetch,
    });
    expect(runner.enabled).toBe(true);
    const { hits, blocked } = await runner.search("米家空气净化器 4 Lite 参数", 5);
    expect(blocked).toBe(false);
    expect(hits).toHaveLength(2);
    expect(hits[0]!.snippet).toContain("26-45㎡");
    const body = JSON.parse(capturedBody) as Record<string, unknown>;
    expect(body.api_key).toBe("tvly-test");
    expect(body.search_depth).toBe("basic");
  });

  it("通用 JSON 网关：Bearer 鉴权 + data.items 兼容解析", async () => {
    let authHeader = "";
    const runner = createApiSearchRunner({
      provider: "generic",
      apiKey: "gw-key",
      apiUrl: "https://search.internal/api",
      fetchImpl: (async (_url: string, init: RequestInit) => {
        const headers = (init.headers ?? {}) as Record<string, string>;
        authHeader = headers.authorization ?? "";
        return {
          ok: true, status: 200,
          json: async () => ({ data: { items: [{ name: "测评", link: "https://x.test/a", description: "真实体验" }] } }),
        } as unknown as Response;
      }) as unknown as typeof fetch,
    });
    const { hits } = await runner.search("任何查询", 3);
    expect(authHeader).toBe("Bearer gw-key");
    expect(hits[0]).toMatchObject({ title: "测评", url: "https://x.test/a", snippet: "真实体验" });
  });

  it("API 限流（429/403）→ blocked=true 交给上层熔断，不当作零结果", async () => {
    const runner = createApiSearchRunner({
      provider: "tavily", apiKey: "k", apiUrl: "https://api.tavily.com/search",
      fetchImpl: (async () => ({ ok: false, status: 429, json: async () => ({}) }) as unknown as Response) as unknown as typeof fetch,
    });
    const r = await runner.search("q", 3);
    expect(r.blocked).toBe(true);
    expect(r.hits).toHaveLength(0);
  });

  it("未配置 key → 通道关闭（静默跳过，不影响其它引擎）", () => {
    const cfg = resolveApiSearchConfig({}, {} as NodeJS.ProcessEnv);
    expect(cfg).toBeNull();
    expect(createApiSearchRunner({ provider: "tavily", apiKey: "", apiUrl: "" }).enabled).toBe(false);
  });
});

 describe("正式来源collector接缝", () => {
  it("真实候选完整交给collector，不把snippet交给旧模型回填", async () => {
    const reason = vi.fn(), evidenceCollector = vi.fn(async () => ({ identity: { name: "已核实" } }));
    const executor = createDataMiningExecutor({ search: async () => [{ title: "x", url: "https://source.example.com/", snippet: "待核实" }], llm: { reason }, evidenceCollector });
    expect(await executor("A1", { queries: [{ q: "商品" }] })).toEqual({ identity: { name: "已核实" } });
    expect(evidenceCollector).toHaveBeenCalledWith("A1", expect.anything(), [expect.objectContaining({ snippet: "待核实" })]); expect(reason).not.toHaveBeenCalled();
  });
  it("缺查询/检索抛错仍交collector明确缺站；collector核验失败原样抛出", async () => {
    const evidenceCollector = vi.fn(async (_stage: unknown, _plan: unknown, _hits: unknown[]) => { throw new Error("MARKETING_A1_UNVERIFIED"); });
    const executor = createDataMiningExecutor({ search: async () => { throw new Error("search unavailable"); }, llm: { reason: vi.fn() }, evidenceCollector });
    await expect(executor("A1", {})).rejects.toThrow("MARKETING_A1_UNVERIFIED");
    await expect(executor("A1", { queries: [{ q: "商品" }] })).rejects.toThrow("MARKETING_A1_UNVERIFIED");
    expect(evidenceCollector.mock.calls.every(call => call[2]?.length === 0)).toBe(true);
  });
  it("一个真URL不掩护其他假URL，端口保留参与白名单", () => {
    const good = "https://source.example.com/item", allowed = new Set([normalizeUrl(good)]);
    expect(filterUnknownUrls({ name: "x", source_url: good, price_source_url: "https://fake.example.com/" }, allowed).value).toBeUndefined();
    expect(normalizeUrl("https://source.example.com:8443/item")).not.toBe(normalizeUrl(good));
  });
});
