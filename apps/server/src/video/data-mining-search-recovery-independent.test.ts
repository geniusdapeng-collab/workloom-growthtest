/** Independent MC-013 cases: HTTP 200 can still contain a failed/unrecognized search envelope. */
import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createWebSearch } from "./data-mining-executor.js";

const roots: string[] = [];
afterEach(() => { vi.unstubAllGlobals(); roots.splice(0).forEach(root => rmSync(root, { recursive: true, force: true })); });
const modes = ["html-shell", "invalid-rss", "invalid-api-rows"] as const;
describe.each(modes)("%s does not become a 12-hour success-empty cache", mode => {
  it.each([false, true])("the next healthy response is requested after restart=%s", async restart => {
    const root = mkdtempSync(join(tmpdir(), "independent-search-recovery-")); roots.push(root);
    const responses = mode === "html-shell"
      ? [new Response('<html><head><title>Service maintenance</title></head><body><div id="app"></div><script src="renderer.js"></script></body></html>'),
        new Response('<html><body><h3><a href="https://example.test/f3">星野 F3 风扇官方参数</a></h3><p>风量9档</p></body></html>')]
      : mode === "invalid-rss"
        ? [new Response('<html><body>Temporarily unavailable</body></html>'), new Response('<rss><channel><item><title>星野 F3 风扇官方参数</title><link>https://example.test/f3</link><description>风量9档</description></item></channel></rss>')]
        : [Response.json({ results: [null, { unexpected: "invalid result schema" }] }), Response.json({ results: [{ title: "星野 F3 风扇官方参数", url: "https://example.test/f3", snippet: "风量9档" }] })];
    const fetch = vi.fn().mockResolvedValueOnce(responses[0]).mockResolvedValueOnce(responses[1]); vi.stubGlobal("fetch", fetch);
    const options = { providers: [mode === "html-shell" ? "so360" : mode === "invalid-rss" ? "bing" : "api"] as Array<"so360" | "bing" | "api">,
      paceMs: 0, cacheFile: join(root, "cache.json"), api: { provider: "generic" as const, apiUrl: "https://search.example.test/query", apiKey: "test-only-search" } };
    const search = createWebSearch(options);
    expect(await search("星野 F3", 5)).toEqual([]);
    expect(await (restart ? createWebSearch(options) : search)("星野 F3", 5)).toMatchObject([{ url: "https://example.test/f3" }]);
    expect(fetch).toHaveBeenCalledTimes(2);
  });
});
