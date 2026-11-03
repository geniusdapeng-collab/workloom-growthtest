import { createServer, type Server } from "node:http";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { gzipSync } from "node:zlib";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { fetchDossierHeroImage } from "./products.js";
import { createSourceTransport, fetchPublicResource, PUBLIC_RESOURCE_MAX_BYTES, SOURCE_MAX_BYTES, type SourceTransport } from "../marketing-source-fetcher.js";

const nativeFetch = globalThis.fetch;
let server: Server, origin: string, privateHits = 0, publicHits = 0;
const limit = 64 * 1024;
const roots: string[] = [];
beforeAll(async () => {
  server = createServer((request, response) => {
    if (request.url === "/public-redirect") { publicHits++; response.writeHead(302, { location: `${origin}/private` }); response.end(); return; }
    if (request.url === "/hop-1") { response.writeHead(302, { location: "https://second-public.example.com/hop-2" }); response.end(); return; }
    if (request.url === "/hop-2") { response.writeHead(302, { location: "https://dns-private.example.com/private" }); response.end(); return; }
    if (request.url === "/switch") { response.writeHead(302, { location: "/binary" }); response.end(); return; }
    if (request.url === "/loop") { response.writeHead(302, { location: "/loop" }); response.end(); return; }
    if (request.url === "/missing-location") { response.writeHead(302); response.end(); return; }
    if (request.url === "/denied") { response.writeHead(403); response.end(); return; }
    if (request.url === "/empty") { response.writeHead(200); response.end(); return; }
    if (request.url === "/slow") return;
    if (request.url === "/large-header") { response.writeHead(200, { "content-type": "image/png", "content-length": limit + 1 }); response.end(); return; }
    if (request.url === "/large-stream") { response.writeHead(200, { "content-type": "image/png" }); response.end(Buffer.alloc(limit * 2)); return; }
    if (request.url === "/gzip-bomb") { response.writeHead(200, { "content-type": "image/png", "content-encoding": "gzip" }); response.end(gzipSync(Buffer.alloc(limit * 2))); return; }
    if (request.url === "/large-binary") { response.writeHead(200, { "content-type": "application/octet-stream" }); response.end(Buffer.alloc(SOURCE_MAX_BYTES + 17, 7)); return; }
    if (request.url === "/broken") { response.writeHead(200, { "content-type": "image/png", "content-length": 500 }); response.write("partial"); setImmediate(() => response.destroy()); return; }
    if (request.url === "/private") privateHits++;
    response.writeHead(200, { "content-type": "image/png" });
    response.end(Buffer.from("controlled-private-image-bytes"));
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});
afterAll(async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); });
afterEach(async () => {
  vi.unstubAllGlobals();
  privateHits = 0;
  publicHits = 0;
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
async function target() {
  const root = await mkdtemp(path.join(tmpdir(), "wl-hero-source-")); roots.push(root);
  return path.join(root, "hero.png");
}
function publicOptions(maxBytes = PUBLIC_RESOURCE_MAX_BYTES) {
  const transport = createSourceTransport(maxBytes);
  return { resolver: async (_hostname: string) => [{ address: "93.184.216.34", family: 4 }],
    transport: ((url, _address, signal) => transport(new URL(url.pathname, origin), { address: "127.0.0.1", family: 4 }, signal)) as SourceTransport };
}

describe("商品档案主图下载不能穿透来源网络边界", () => {
  it("公开图片入口跳向本机时不请求私网目标，也不把私网字节存成商品图", async () => {
    const publicUrl = "https://public-image.example.com/hero.png";
    // 只将首个公开来源传输映射到隔离HTTP服务；重定向由原生fetch实际执行。
    vi.stubGlobal("fetch", async (input: string | URL | Request, init?: RequestInit) =>
      nativeFetch(String(input) === publicUrl ? `${origin}/public-redirect` : input, init));
    const file = await target();
    const downloaded = await fetchDossierHeroImage(publicUrl, file, PUBLIC_RESOURCE_MAX_BYTES, {
      ...publicOptions(), transport: async (url, address, signal) => publicOptions().transport(new URL("/public-redirect", url), address, signal),
    });
    expect(privateHits).toBe(0);
    expect(publicHits).toBe(1);
    expect(downloaded).toBe(false);
    await expect(readFile(file)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("manifest中的直接本机URL在出站前拒绝", async () => {
    const file = await target();
    const downloaded = await fetchDossierHeroImage(`${origin}/private`, file);
    expect(privateHits).toBe(0);
    expect(downloaded).toBe(false);
    await expect(readFile(file)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("每个重定向目标都重新核对DNS，第二个公开域名再跳向私网也不出站", async () => {
    const options = publicOptions();
    const visited: string[] = [], resolved: string[] = [];
    const file = await target();
    const downloaded = await fetchDossierHeroImage("https://first-public.example.com/hop-1", file, PUBLIC_RESOURCE_MAX_BYTES, {
      resolver: async hostname => { resolved.push(hostname); return [{ address: hostname === "dns-private.example.com" ? "127.0.0.1" : "93.184.216.34", family: 4 }]; },
      transport: async (url, address, signal) => { visited.push(url.href); return options.transport(url, address, signal); },
    });
    expect(downloaded).toBe(false);
    expect(resolved).toEqual(["first-public.example.com", "second-public.example.com", "dns-private.example.com"]);
    expect(visited).toEqual(["https://first-public.example.com/hop-1", "https://second-public.example.com/hop-2"]);
    expect(privateHits).toBe(0);
  });

  it("同域跳转期间DNS变成私网时不能复用首跳的公网判断", async () => {
    const options = publicOptions(); let lookups = 0;
    const transport = vi.fn(options.transport);
    expect(await fetchDossierHeroImage("https://image.example.com/switch", await target(), PUBLIC_RESOURCE_MAX_BYTES, {
      resolver: async () => [{ address: ++lookups === 1 ? "93.184.216.34" : "192.168.1.1", family: 4 }], transport,
    })).toBe(false);
    expect(transport).toHaveBeenCalledTimes(1);
    expect(lookups).toBe(2);
  });

  it.each(["127.0.0.1", "10.1.2.3", "169.254.169.254", "::1", "::ffff:127.0.0.1", "fd00::1", "fe80::1"])("DNS含%s时即使另一答案公网也禁止传输", async address => {
    const transport = vi.fn<SourceTransport>();
    expect(await fetchDossierHeroImage("https://image.example.com/hero.png", await target(), PUBLIC_RESOURCE_MAX_BYTES, {
      resolver: async () => [{ address: "93.184.216.34", family: 4 }, { address, family: address.includes(":") ? 6 : 4 }], transport,
    })).toBe(false);
    expect(transport).not.toHaveBeenCalled();
  });

  it.each(["http://[::1]/hero.png", "http://[::ffff:127.0.0.1]/hero.png", "http://[fd00::1]/hero.png"])("IPv6字面目标%s出站前拒绝", async url => {
    const transport = vi.fn<SourceTransport>();
    expect(await fetchDossierHeroImage(url, await target(), PUBLIC_RESOURCE_MAX_BYTES, { transport })).toBe(false);
    expect(transport).not.toHaveBeenCalled();
  });

  it.each(["large-header", "large-stream", "gzip-bomb", "denied", "empty", "broken", "loop", "missing-location"])("%s拒绝且不落盘部分字节", async route => {
    const file = await target();
    expect(await fetchDossierHeroImage(`https://image.example.com/${route}`, file, limit, publicOptions(limit))).toBe(false);
    await expect(readFile(file)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it.each(["dns", "transport", "socket"])("%s超时实际停止等待且不落盘", async kind => {
    const file = await target();
    expect(await fetchDossierHeroImage("https://image.example.com/slow", file, limit, { ...publicOptions(limit), timeoutMs: 30,
      ...(kind === "dns" ? { resolver: () => new Promise(() => {}) } : kind === "transport" ? { transport: () => new Promise(() => {}) } : {}),
    })).toBe(false);
    await expect(readFile(file)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("正常公开二进制仍保留主图15MB上限，超过正文2MB的图片可完整下载", async () => {
    const file = await target();
    expect(await fetchDossierHeroImage("https://image.example.com/large-binary", file, PUBLIC_RESOURCE_MAX_BYTES, publicOptions())).toBe(true);
    const bytes = await readFile(file);
    expect(bytes.length).toBe(SOURCE_MAX_BYTES + 17);
    expect(bytes.equals(Buffer.alloc(SOURCE_MAX_BYTES + 17, 7))).toBe(true);
  });

  it("固定已核验的IPv6地址传给低层，不再次解析；正文解析规则不用于二进制", async () => {
    const addresses: unknown[] = [];
    const result = await fetchPublicResource("https://image.example.com/binary", { maxBytes: limit,
      resolver: async () => [{ address: "2606:4700:4700::1111", family: 6 }],
      transport: async (_url, address) => { addresses.push(address); return { status: 200, headers: { "content-type": "application/octet-stream" }, body: Buffer.from([0, 255, 1]) }; },
    });
    expect(addresses).toEqual([{ address: "2606:4700:4700::1111", family: 6 }]);
    expect(result.body).toEqual(Buffer.from([0, 255, 1]));
  });

  it.each([0, -1, NaN, Infinity, PUBLIC_RESOURCE_MAX_BYTES + 1])("非法上限%s在出站前拒绝", async maxBytes => {
    const transport = vi.fn<SourceTransport>();
    expect(await fetchDossierHeroImage("https://image.example.com/binary", await target(), maxBytes, { transport })).toBe(false);
    expect(transport).not.toHaveBeenCalled();
  });
});
