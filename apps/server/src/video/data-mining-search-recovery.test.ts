import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createWebSearch, loadSearchCache, searchCacheKey, type SearchProvider } from "./data-mining-executor.js";

const nativeFetch = globalThis.fetch;
const directories: string[] = [];
const query = "星野 F3 参数";
const expectedHit = { title: "星野 F3 公开规格", url: "https://source.example.com/f3", snippet: "星野 F3 风量 9 档" };
async function cacheFile() {
  const directory = await mkdtemp(path.join(tmpdir(), "wl-search-recovery-")); directories.push(directory);
  return path.join(directory, "search.json");
}
afterEach(async () => {
  vi.unstubAllGlobals();
  for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true });
});
function success(provider: SearchProvider): Response {
  if (provider === "api") return new Response(JSON.stringify({ results: [expectedHit] }));
  if (provider === "bing") return new Response(`<rss><item><title>${expectedHit.title}</title><link>${expectedHit.url}</link><description>${expectedHit.snippet}</description></item></rss>`);
  return new Response(`<h3><a href="${expectedHit.url}">${expectedHit.title}</a></h3>${expectedHit.snippet}`);
}

describe("营销检索短暂失败后的真实恢复", () => {
  it.each([
    { provider: "api" as const, failure: "500", restart: false },
    { provider: "api" as const, failure: "network", restart: false },
    { provider: "api" as const, failure: "bad-json", restart: true },
    { provider: "api" as const, failure: "error-envelope", restart: true },
    { provider: "bing" as const, failure: "500", restart: false },
    { provider: "bing" as const, failure: "500", restart: true },
    { provider: "so360" as const, failure: "500", restart: true },
  ])("$provider $failure重试不复用失败空缓存，重建实例=$restart", async ({ provider, failure, restart }) => {
    const file = await cacheFile();
    let calls = 0;
    const fetchImpl = vi.fn(async () => {
      calls++;
      if (calls > 1) return success(provider);
      if (failure === "network") throw new TypeError("controlled network failure");
      if (failure === "bad-json") return new Response("{broken-json");
      if (failure === "error-envelope") return new Response(JSON.stringify({ error: "temporary upstream failure" }));
      return new Response("temporary failure", { status: 500 });
    });
    vi.stubGlobal("fetch", fetchImpl);
    const options = { providers: [provider], cacheFile: file, paceMs: 0,
      api: { provider: "generic" as const, apiKey: "test-only", apiUrl: "https://search.example.com/search", fetchImpl: fetchImpl as typeof fetch } };
    const search = createWebSearch(options);
    expect(await search(query, 2)).toEqual([]);
    expect(loadSearchCache(file).entries[searchCacheKey(provider, query)]).toBeUndefined();
    expect(await (restart ? createWebSearch(options) : search)(query, 2)).toEqual([expectedHit]);
    expect(calls).toBe(2);
  });

  it("真实HTTP超时不会写入12小时空缓存，服务恢复后同查询确实再次出站", async () => {
    const file = await cacheFile();
    let calls = 0;
    const server = createServer((_request, response) => {
      calls++;
      if (calls === 1) return; // 原生fetch必须通过AbortSignal实际中断。
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ results: [expectedHit] }));
    });
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    try {
      const address = server.address() as { port: number };
      const search = createWebSearch({ providers: ["api"], cacheFile: file, paceMs: 0,
        api: { provider: "generic", apiKey: "test-only", apiUrl: `http://127.0.0.1:${address.port}/search`, timeoutMs: 100, fetchImpl: nativeFetch } });
      expect(await search(query, 2)).toEqual([]);
      expect(calls).toBe(1);
      expect(await search(query, 2)).toEqual([expectedHit]);
      expect(calls).toBe(2);
    } finally {
      server.closeAllConnections();
      await new Promise<void>(resolve => server.close(() => resolve()));
    }
  });

  it("正常零结果仍缓存；429仍在同实例冷却且不持久化成零结果", async () => {
    const file = await cacheFile();
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ results: [] })));
    const options = { providers: ["api" as const], cacheFile: file, paceMs: 0,
      api: { provider: "generic" as const, apiKey: "test-only", apiUrl: "https://search.example.com/search", fetchImpl: fetchImpl as typeof fetch } };
    expect(await createWebSearch(options)(query, 2)).toEqual([]);
    expect(await createWebSearch(options)(query, 2)).toEqual([]);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(loadSearchCache(file).entries[searchCacheKey("api", query)]?.hits).toEqual([]);
    const blockedFile = await cacheFile();
    const blockedFetch = vi.fn(async () => new Response("limited", { status: 429 }));
    const search = createWebSearch({ ...options, cacheFile: blockedFile, api: { ...options.api, fetchImpl: blockedFetch as typeof fetch } });
    expect(await search(query, 2)).toEqual([]);
    expect(await search(query, 2)).toEqual([]);
    expect(blockedFetch).toHaveBeenCalledTimes(1);
    expect(loadSearchCache(blockedFile).entries[searchCacheKey("api", query)]).toBeUndefined();
  });
});
