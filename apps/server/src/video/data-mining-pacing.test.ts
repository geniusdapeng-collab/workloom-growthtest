import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createWebSearch, type SearchProvider } from "./data-mining-executor.js";

beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(10_000); });
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

describe("营销来源并发检索的逐引擎限速", () => {
  function engine(providers: SearchProvider[] = ["bing"]) {
    const calls: Array<{ at: number; host: string }> = [];
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request) => {
      const url = new URL(String(input));
      calls.push({ at: Date.now(), host: url.hostname });
      return new Response(url.hostname === "www.bing.com"
        ? '<rss><item><title>星野 F3</title><link>https://source.example.com/f3</link><description>星野 F3</description></item></rss>'
        : '<h3><a href="https://source.example.com/f3">星野 F3 公开规格</a></h3>星野 F3');
    }));
    return { calls, search: createWebSearch({ providers, paceMs: 50 }) };
  }

  it("四个同时到达的查询按实际请求开始时刻间隔，避免等待后成批触发", async () => {
    const { calls, search } = engine();
    const pending = Promise.all(Array.from({ length: 4 }, (_, index) => search(`星野 F3 ${index}`, 1)));
    await vi.runAllTimersAsync();
    expect(await pending).toHaveLength(4);
    expect(calls.map(call => call.at)).toEqual([10_000, 10_050, 10_100, 10_150]);
  });

  it("不同引擎各自排队，彼此不增加全局等待", async () => {
    const { calls, search } = engine(["so360", "bing"]);
    // 每个引擎只产生一个不同 URL，要求两条命中使查询进入 Bing。
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request) => {
      const url = new URL(String(input)); calls.push({ at: Date.now(), host: url.hostname });
      return new Response(url.hostname === "www.bing.com"
        ? '<rss><item><title>星野 F3</title><link>https://source.example.com/b</link><description>星野 F3</description></item></rss>'
        : '<h3><a href="https://source.example.com/a">星野 F3 公开规格</a></h3>星野 F3');
    }));
    const pending = Promise.all([search("星野 F3 first", 2), search("星野 F3 second", 2)]);
    await vi.runAllTimersAsync(); await pending;
    expect(calls.filter(call => call.host === "www.so.com").map(call => call.at)).toEqual([10_000, 10_050]);
    expect(calls.filter(call => call.host === "www.bing.com").map(call => call.at)).toEqual([10_000, 10_050]);
  });

  it("闲置超过间隔后新查询立即开始，已经缓存的结果不占网络槽位", async () => {
    const { calls, search } = engine();
    await search("星野 F3 first", 1);
    await vi.advanceTimersByTimeAsync(500);
    await search("星野 F3 second", 1);
    await search("星野 F3 first", 1);
    expect(calls.map(call => call.at)).toEqual([10_000, 10_500]);
  });

  it("首个请求返回限流后，等待槽位的同引擎查询不再发出网络请求", async () => {
    const { calls, search } = engine();
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request) => {
      calls.push({ at: Date.now(), host: new URL(String(input)).hostname });
      return new Response("rate limited", { status: 429 });
    }));
    const pending = Promise.all(Array.from({ length: 4 }, (_, index) => search(`星野 F3 ${index}`, 1)));
    await vi.runAllTimersAsync();
    expect(await pending).toEqual([[], [], [], []]);
    expect(calls).toHaveLength(1);
  });
});
