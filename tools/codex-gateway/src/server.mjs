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
import { existsSync, readFileSync, statSync } from "node:fs";
import { extname, join, normalize, resolve } from "node:path";
import { gatewayFile, resolveRepoRoot } from "./paths.mjs";
import { generateCatalog, findCapability, searchCapabilities } from "./catalog.mjs";
import { DEFAULT_STAGE_PORT, buildSnapshot, demoEvent, snapshotEvent } from "./snapshot.mjs";
import { createRunService } from "./runs.mjs";

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

function readJsonBody(request, limitBytes = 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    request.on("data", (chunk) => {
      size += chunk.length;
      if (size > limitBytes) {
        reject(new Error("请求体超过 1MB 限制"));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on("end", () => {
      if (!chunks.length) return resolve({});
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      } catch (error) {
        reject(new Error(`JSON 解析失败：${error instanceof Error ? error.message : String(error)}`));
      }
    });
    request.on("error", reject);
  });
}

function safeJoin(root, candidate) {
  const target = resolve(join(root, normalize(candidate).replace(/^(\.\.(\/|\\|$))+/, "")));
  return target.startsWith(resolve(root)) ? target : null;
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

export function createGateway({ repoRoot = resolveRepoRoot(), catalog = generateCatalog({ repoRoot }), runService = null } = {}) {
  const service = runService ?? createRunService({ repoRoot, catalog });
  const store = service.store;
  const snapshot = () => buildSnapshot({ repoRoot, catalog, store });

  return createServer((request, response) => {
    const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "127.0.0.1"}`);
    const pathname = decodeURIComponent(url.pathname);

    if (request.method === "OPTIONS") {
      response.writeHead(204, corsHeaders(request));
      response.end();
      return;
    }
    const method = request.method ?? "GET";

    // ---------- 写路径（P1：Run / Approval；所有裁决在 runService 内 fail-closed） ----------
    if (method === "POST" && pathname === "/runs") {
      readJsonBody(request)
        .then((body) => service.startRun(body))
        .then((result) => sendJson(request, response, 200, result))
        .catch((error) => sendJson(request, response, 400, { error: error.code ?? "RUN_START_FAILED", message: error.message }));
      return;
    }
    if (method === "POST" && pathname.startsWith("/runs/") && pathname.endsWith("/cancel")) {
      const runId = pathname.slice("/runs/".length, -"/cancel".length);
      readJsonBody(request)
        .then((body) => service.cancelRun({ runId, ...body }))
        .then((result) => sendJson(request, response, 200, result))
        .catch((error) => sendJson(request, response, 400, { error: error.code ?? "RUN_CANCEL_FAILED", message: error.message }));
      return;
    }
    if (method === "POST" && pathname.startsWith("/approvals/") && pathname.endsWith("/decide")) {
      const approvalId = pathname.slice("/approvals/".length, -"/decide".length);
      readJsonBody(request)
        .then((body) => service.decideApproval({ approvalId, ...body }))
        .then((result) => sendJson(request, response, 200, result))
        .catch((error) => sendJson(request, response, 400, { error: error.code ?? "APPROVAL_DECIDE_FAILED", message: error.message }));
      return;
    }

    if (method !== "GET") {
      sendJson(request, response, 405, { error: "METHOD_NOT_ALLOWED" });
      return;
    }

    if (pathname === "/health") {
      sendJson(request, response, 200, {
        ok: true,
        service: "workloom-codex-gateway",
        version: "0.1.0",
        mode: "governed",
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

    if (pathname === "/runs") {
      sendJson(request, response, 200, { runs: service.listRuns() });
      return;
    }
    if (pathname.startsWith("/runs/") && pathname.endsWith("/tail")) {
      const runId = pathname.slice("/runs/".length, -"/tail".length);
      sendJson(request, response, 200, { runId, events: service.tailRun(runId, Number(url.searchParams.get("limit") ?? 50)) });
      return;
    }
    if (pathname.startsWith("/runs/")) {
      const runId = pathname.slice("/runs/".length);
      const run = service.getRun(runId);
      if (!run) {
        sendJson(request, response, 404, { error: "RUN_NOT_FOUND", runId });
        return;
      }
      sendJson(request, response, 200, run);
      return;
    }
    if (pathname === "/approvals") {
      sendJson(request, response, 200, { approvals: service.listApprovals({ status: url.searchParams.get("status") ?? undefined }) });
      return;
    }
    if (pathname === "/ledger/verify") {
      sendJson(request, response, 200, service.verifyLedger());
      return;
    }
    if (pathname === "/ledger") {
      sendJson(request, response, 200, { events: store.listLedger({ since: url.searchParams.get("since") ?? undefined }) });
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

      const eventNameOf = (event) => {
        const action = String(event?.decision?.action ?? "");
        if (action.startsWith("approval.")) return action;
        if (action === "run.completed") return "run.completed";
        if (action === "run.blocked") return "run.blocked";
        if (action === "run.cancelled") return "run.cancelled";
        if (action.startsWith("run.step")) return "run.progress";
        if (action === "run.started") return "run.started";
        return "stage.event";
      };
      let lastEventId = url.searchParams.get("since") ?? store.lastEventId ?? null;
      const tailTimer = setInterval(() => {
        const pending = store.listLedger({ since: lastEventId ?? undefined });
        for (const event of pending) {
          send({ event: eventNameOf(event), data: { ...event, dataMode: "simulated" } });
          lastEventId = event.event_id;
        }
      }, 1000);

      const demo = url.searchParams.get("demo") === "1";
      let index = 0;
      let demoTimer = null;
      if (demo && !store.listLedger().length) {
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
        clearInterval(tailTimer);
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
  });
}

export function startGateway({ port = Number(process.env.WORKLOOM_GATEWAY_PORT ?? DEFAULT_STAGE_PORT), host = process.env.WORKLOOM_GATEWAY_HOST ?? "127.0.0.1", repoRoot = resolveRepoRoot(), runService = null } = {}) {
  const catalog = generateCatalog({ repoRoot });
  const service = runService ?? createRunService({ repoRoot, catalog });
  const server = createGateway({ repoRoot, catalog, runService: service });
  return new Promise((resolvePromise, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      const address = server.address();
      const actualPort = typeof address === "object" && address ? address.port : port;
      resolvePromise({
        server,
        catalog,
        runService: service,
        url: `http://${host}:${actualPort}`,
        stageUrl: `http://${host}:${actualPort}/stage`,
        close: () => new Promise((resolveClose) => server.close(() => resolveClose())),
      });
    });
  });
}
