import { createServer, type Server } from "node:http";
import { gzipSync } from "node:zlib";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { fetchMarketingSource, publicSourceAddress, requestSource, sourceDocument, sourceUrl, SOURCE_MAX_BYTES, SOURCE_MAX_TEXT_CHARS, type SourceTransport } from "./marketing-source-fetcher.js";
let server: Server, origin: string;
beforeAll(async () => {
  server = createServer((req, res) => {
    if (req.url === "/redirect") { res.writeHead(302, { location: "/page" }); res.end(); return; }
    if (req.url === "/private") { res.writeHead(302, { location: "http://127.0.0.1/secret" }); res.end(); return; }
    if (req.url === "/loop") { res.writeHead(302, { location: "/loop" }); res.end(); return; }
    if (req.url === "/slow") return;
    if (req.url === "/denied") { res.writeHead(403); res.end("denied"); return; }
    if (req.url === "/large") { res.writeHead(200, { "content-type": "text/plain", "content-length": SOURCE_MAX_BYTES + 1 }); res.end(); return; }
    if (req.url === "/broken") { res.writeHead(200, { "content-type": "text/plain", "content-length": 500 }); res.write("partial"); setImmediate(() => res.destroy()); return; }
    if (req.url === "/gzip") { res.writeHead(200, { "content-type": "text/plain; charset=utf-8", "content-encoding": "gzip" }); res.end(gzipSync("完整中文正文")); return; }
    if (req.url === "/binary") { res.writeHead(200, { "content-type": "image/png" }); res.end("image"); return; }
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end('<html><script>伪造事实</script><style>隐藏内容</style><p>星野 F3 &amp; 风量 9 档</p><img src="/hero.jpg"><p>完整尾部 &#x4e2d;文</p></html>');
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});
afterAll(async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); });
const resolver = async () => [{ address: "93.184.216.34", family: 4 }];
const transport: SourceTransport = async (url, _address, signal) => requestSource(new URL(url.pathname, origin), { address: "127.0.0.1", family: 4 }, signal);
function fetchPage(route: string, options: Parameters<typeof fetchMarketingSource>[1] = {}) { return fetchMarketingSource(`https://source.example.com${route}`, { resolver, transport, ...options }); }
describe("来源公网地址与真实HTTP读取", () => {
  it.each(["0.0.0.0", "10.1.1.1", "127.0.0.1", "172.16.4.5", "192.168.1.1", "100.64.0.1", "169.254.169.254", "192.0.2.1", "198.51.100.1", "203.0.113.8", "224.0.0.1", "::1", "::ffff:8.8.8.8", "fc00::1", "fe80::1", "2001:db8::1", "2001:0000::1", "2002:0808:0808::1"])("非公网%s禁止", value => expect(publicSourceAddress(value)).toBe(false));
  it.each(["8.8.8.8", "192.2.1.1", "93.184.216.34", "2001:4860:4860::8888", "2606:4700:4700::1111"])("公网%s可用", value => expect(publicSourceAddress(value)).toBe(true));
  it.each(["file:///etc/passwd", "https://user:pass@source.example.com/", "https://source.example.com:8080/", "http://source.example.com:443/", "http://localhost/", "https://host.local/", "https://127.1/", "http://[::1]/"])("URL%s在请求前拒绝", value => expect(() => sourceUrl(value)).toThrow(/SOURCE_URL/));
  it("真实HTTP保留完整中文正文、实体、图片候选、重定向和双摘要", async () => {
    const result = await fetchPage("/redirect");
    expect(result.snapshot).toMatchObject({ finalUrl: "https://source.example.com/page", redirectChain: ["https://source.example.com/redirect"], text: "星野 F3 & 风量 9 档\n完整尾部 中文", assetUrls: ["https://source.example.com/hero.jpg"] });
    expect(result.snapshot.rawSha256).toMatch(/^[a-f0-9]{64}$/); expect(result.snapshot.textSha256).not.toBe(result.snapshot.rawSha256);
    expect(result.rawBytes.toString()).toContain("伪造事实"); expect(result.snapshot.text).not.toContain("伪造事实");
  });
  it("低层传输确实使用传入DNS地址，hostname不需解析也保持Host", async () => {
    const local = new URL(origin); local.hostname = "nonexistent-host.example.com";
    const result = await requestSource(local, { address: "127.0.0.1", family: 4 }, AbortSignal.timeout(1000)); expect(result.status).toBe(200);
  });
  it.each([["/private", "SOURCE_URL_PRIVATE"], ["/loop", "SOURCE_REDIRECT_INVALID"], ["/denied", "SOURCE_HTTP_FAILED"], ["/large", "SOURCE_TOO_LARGE"], ["/binary", "SOURCE_TYPE_UNSUPPORTED"], ["/broken", "SOURCE_ABORTED"]])("%s失败关闭", async (route, error) => { await expect(fetchPage(route!)).rejects.toThrow(error); });
  it("解压后保存实际字节，并拒绝压缩炸弹", async () => {
    expect((await fetchPage("/gzip")).snapshot.text).toBe("完整中文正文");
    await expect(fetchPage("/", { transport: async () => ({ status: 200, headers: { "content-type": "text/plain", "content-encoding": "gzip" }, body: gzipSync("x".repeat(SOURCE_MAX_BYTES + 1)) }) })).rejects.toThrow();
  });
  it("任一DNS答复为私网即拒绝，不挑选看似可用的首条", async () => {
    const blocked = vi.fn(transport);
    await expect(fetchPage("/", { resolver: async () => [...await resolver(), { address: "127.0.0.1", family: 4 }], transport: blocked })).rejects.toThrow("SOURCE_URL_PRIVATE");
    expect(blocked).not.toHaveBeenCalled();
  });
  it.each(["dns", "transport", "socket"])("%s超时都终止，不无限等待", async kind => {
    await expect(fetchPage(kind === "socket" ? "/slow" : "/", { timeoutMs: 30,
      ...(kind === "dns" ? { resolver: () => new Promise(() => {}) } : kind === "transport" ? { transport: () => new Promise(() => {}) } : {}) })).rejects.toThrow(/abort|timeout/i);
  });
  it("拒绝空文/验证码/长文，不把裁剪当完整原文", () => {
    for (const value of ["", "请完成安全验证", "x".repeat(SOURCE_MAX_TEXT_CHARS + 1)]) expect(() => sourceDocument(value, "text/plain", "https://source.example.com/")).toThrow();
    expect(sourceDocument('<img src="http://127.0.0.1/x">有效正文', "text/html", "https://source.example.com/").assetUrls).toEqual([]);
  });
});
