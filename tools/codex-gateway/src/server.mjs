/**
 * Codex 网关 HTTP/SSE 服务（P0，只读）。
 *
 * 路由：
 *   GET /health
 *   GET /catalog                  → 全量能力目录（?summary=1 只返回统计）
 *   GET /catalog/:id              → 单个能力
 *   GET /stage/snapshot           → TeamProjection（dataMode=mock）
 *   GET /stage/stream?demo=1      → SSE（快照 + 心跳 + 可选模拟事件）
 *   GET /stage /stage/*           → 自包含数字人工作台静态页
 *
 * 安全：默认只绑定 127.0.0.1；CORS 只允许 localhost/127.0.0.1 来源；
 * 不写任何业务数据，不接触数据库与密钥。
 */
import { createServer } from "node:http";
import { existsSync, readFileSync, statSync, lstatSync, realpathSync } from "node:fs";
import { extname, join, resolve, sep } from "node:path";
import { gatewayFile, resolveRepoRoot } from "./paths.mjs";
import { generateCatalog, findCapability, searchCapabilities } from "./catalog.mjs";
import { DEFAULT_STAGE_PORT, buildSnapshot, demoEvent, snapshotEvent } from "./snapshot.mjs";

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
};

function corsHeaders(request) {
  const origin = request.headers.origin;
  if (!origin) return {};
  try {
    const url = new URL(origin);
    const local = url.hostname === "127.0.0.1" || url.hostname === "localhost";
    if (!local) return {};
    return {
      "access-control-allow-origin": origin,
      "access-control-allow-methods": "GET, OPTIONS",
      "access-control-allow-headers": "content-type",
      vary: "origin",
    };
  } catch {
    return {};
  }
}

function sendJson(request, response, status, payload) {
  const body = JSON.stringify(payload, null, 2);
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    ...corsHeaders(request),
  });
  response.end(body);
}

function sendText(request, response, status, text, contentType = "text/plain; charset=utf-8") {
  response.writeHead(status, { "content-type": contentType, "cache-control": "no-store", ...corsHeaders(request) });
  response.end(text);
}

function safeJoin(root, candidate) {
  if (!['index.html', 'app.js', 'styles.css'].includes(candidate)) return null;
  const target = resolve(root, candidate);
  const base = `${realpathSync(root)}${sep}`;
  if (!existsSync(target) || lstatSync(target).isSymbolicLink()) return null;
  return realpathSync(target).startsWith(base) ? target : null;
}

function isLoopback(value) { return ['localhost', '127.0.0.1', '[::1]', '::1'].includes(value); }

function allowedRequest(request) {
  try {
    const host = new URL(`http://${request.headers.host ?? '127.0.0.1'}`);
    if (!isLoopback(host.hostname) || host.username || host.password) return false;
    if (request.headers.origin) {
      const origin = new URL(request.headers.origin);
      if (!['http:', 'https:'].includes(origin.protocol) || !isLoopback(origin.hostname) || origin.username || origin.password) return false;
    }
    return true;
  } catch { return false; }
}

function serveStageFile(request, response, pathname) {
  const stageRoot = gatewayFile("stage");
  const rel = pathname === "/stage" || pathname === "/stage/" ? "index.html" : pathname.replace(/^\/stage\//, "");
  const target = safeJoin(stageRoot, rel);
  if (!target || !existsSync(target) || !statSync(target).isFile()) {
    sendJson(request, response, 404, { error: "NOT_FOUND", path: pathname });
    return;
  }
  response.writeHead(200, {
    "content-type": MIME[extname(target)] ?? "application/octet-stream",
    "cache-control": "no-store",
    ...corsHeaders(request),
  });
  response.end(readFileSync(target));
}

export function createGateway({ repoRoot = resolveRepoRoot(), catalog = generateCatalog({ repoRoot }) } = {}) {
  const snapshot = () => buildSnapshot({ repoRoot, catalog });

  return createServer((request, response) => {
    if (!allowedRequest(request)) { sendJson(request, response, 403, { error: 'LOCAL_ACCESS_ONLY' }); return; }
    let url, pathname;
    try {
      url = new URL(request.url ?? '/', 'http://127.0.0.1');
      pathname = decodeURIComponent(url.pathname);
    } catch { sendJson(request, response, 400, { error: 'INVALID_URL' }); return; }

    try {

    if (request.method === "OPTIONS") {
      response.writeHead(204, corsHeaders(request));
      response.end();
      return;
    }
    if (request.method !== "GET") {
      sendJson(request, response, 405, { error: "METHOD_NOT_ALLOWED" });
      return;
    }
    if (pathname === '/stage') {
      response.writeHead(302, { location: '/stage/', 'cache-control': 'no-store' }); response.end(); return;
    }

    if (pathname === "/health") {
      sendJson(request, response, 200, {
        ok: true,
        service: "workloom-codex-gateway",
        version: "0.1.3",
        mode: "read-only",
        repo: catalog.repo,
        counts: catalog.summary,
        warnings: catalog.warnings.length,
        dataMode: "mock",
      });
      return;
    }

    if (pathname === "/catalog") {
      if (url.searchParams.get("summary") === "1") {
        sendJson(request, response, 200, { schemaVersion: catalog.schemaVersion, generatedAt: catalog.generatedAt, repo: catalog.repo, summary: catalog.summary, warnings: catalog.warnings });
        return;
      }
      const query = url.searchParams.get("q") ?? "";
      const domain = url.searchParams.get("domain") ?? "";
      const kind = url.searchParams.get("kind") ?? "";
      const limit = Number(url.searchParams.get("limit") ?? 200);
      if (query || domain || kind) {
        sendJson(request, response, 200, { ...catalog.summary, capabilities: searchCapabilities(catalog, { query, domain, kind, limit }) });
        return;
      }
      sendJson(request, response, 200, catalog);
      return;
    }

    if (pathname.startsWith("/catalog/")) {
      const id = pathname.slice("/catalog/".length);
      const capability = findCapability(catalog, id);
      if (!capability) {
        sendJson(request, response, 404, { error: "CAPABILITY_NOT_FOUND", id, hint: "可用 /catalog?q=关键词 搜索" });
        return;
      }
      sendJson(request, response, 200, capability);
      return;
    }

    if (pathname === "/stage/snapshot") {
      sendJson(request, response, 200, snapshot());
      return;
    }

    if (pathname === "/stage/stream") {
      response.writeHead(200, {
        "content-type": "text/event-stream; charset=utf-8",
        "cache-control": "no-cache, no-transform",
        connection: "keep-alive",
        "x-accel-buffering": "no",
        ...corsHeaders(request),
      });
      response.write("retry: 3000\n\n");

      const send = ({ event, data }) => {
        response.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
      };

      const current = snapshot();
      send(snapshotEvent(current));

      const demo = url.searchParams.get("demo") === "1";
      let index = 0;
      let demoTimer = null;
      if (demo) {
        demoTimer = setInterval(() => {
          send(demoEvent(current, index));
          index += 1;
          if (index > 40) {
            clearInterval(demoTimer);
            demoTimer = null;
          }
        }, 1500);
      }
      const heartbeat = setInterval(() => response.write(`: ping ${Date.now()}\n\n`), 15000);
      const cleanup = () => {
        clearInterval(heartbeat);
        if (demoTimer) clearInterval(demoTimer);
      };
      request.on("close", cleanup);
      response.on("close", cleanup);
      return;
    }

    if (pathname === "/stage" || pathname.startsWith("/stage/")) {
      serveStageFile(request, response, pathname);
      return;
    }

    sendJson(request, response, 404, { error: "NOT_FOUND", path: pathname });
    } catch {
      if (!response.headersSent) sendJson(request, response, 500, { error: 'READ_FAILED' });
      else response.destroy();
    }
  });
}

export function startGateway({ port = Number(process.env.WORKLOOM_GATEWAY_PORT ?? DEFAULT_STAGE_PORT), host = process.env.WORKLOOM_GATEWAY_HOST ?? "127.0.0.1", repoRoot = resolveRepoRoot() } = {}) {
  if (!isLoopback(host)) return Promise.reject(new Error('HTTP gateway requires loopback 回环绑定'));
  if (!Number.isInteger(port) || port < 0 || port > 65535) return Promise.reject(new Error('invalid port 端口'));
  const catalog = generateCatalog({ repoRoot });
  const server = createGateway({ repoRoot, catalog });
  return new Promise((resolvePromise, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      const address = server.address();
      const actualPort = typeof address === "object" && address ? address.port : port;
      const urlHost = host === '::1' ? '[::1]' : host;
      resolvePromise({
        server,
        catalog,
        url: `http://${urlHost}:${actualPort}`,
        stageUrl: `http://${urlHost}:${actualPort}/stage/`,
        close: () => new Promise((resolveClose) => server.close(() => resolveClose())),
      });
    });
  });
}
