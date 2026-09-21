#!/usr/bin/env node
/**
 * 调色工位 bridge 服务（常驻，默认只监听 127.0.0.1）。
 *
 *   POST /action   { tool, params }          → { ok, result, receipt } | { ok:false, error, message }
 *   GET  /health                             → 工位与引擎健康
 *
 * 安全：Bearer token（WORKLOOM_COLOR_BRIDGE_TOKEN 必填，缺省拒绝一切调用）；
 *       租户绑定（WORKLOOM_COLOR_BRIDGE_TENANT 设置后校验 params.tenant_id）；
 *       幂等（相同 tool+params 在 TTL 内命中缓存）；路径监狱与事实留痕在 core 内。
 */

import http from "node:http";
import process from "node:process";

import { COLOR_TOOLS, ColorError, STABLE_JSON, callTool, hashKey, jobAppend, jobsDir, resolveBinaries } from "./core.mjs";

const PORT = Number(process.env.WORKLOOM_COLOR_BRIDGE_PORT ?? 9774);
const HOST = process.env.WORKLOOM_COLOR_BRIDGE_HOST ?? "127.0.0.1";
const TOKEN = (process.env.WORKLOOM_COLOR_BRIDGE_TOKEN ?? "").trim();
const TENANT = (process.env.WORKLOOM_COLOR_BRIDGE_TENANT ?? "").trim();
const IDEMPOTENCY_TTL_MS = Number(process.env.WORKLOOM_COLOR_IDEMPOTENCY_TTL_MS ?? 10 * 60 * 1000);
const MAX_BODY_BYTES = 1024 * 1024;

const cache = new Map();
let seq = 0;

function json(res, status, payload) {
  const body = Buffer.from(`${JSON.stringify(payload)}\n`, "utf8");
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "content-length": body.length });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new ColorError("请求体过大", "bad_request"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", (error) => reject(new ColorError(`读取请求失败：${error.message}`, "network_error", true)));
  });
}

function gcCache(now) {
  for (const [key, entry] of cache) {
    if (now - entry.at > IDEMPOTENCY_TTL_MS) cache.delete(key);
  }
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);

  if (req.method === "GET" && url.pathname === "/health") {
    const bins = resolveBinaries();
    let ffmpeg = null;
    try {
      ffmpeg = (await callTool("colorread.health", {}, { bins })).result.ffmpeg;
    } catch { /* health 不因引擎缺失而 500 */ }
    json(res, 200, {
      ok: true,
      service: "workloom-color-bridge",
      version: "1.0.0",
      tools: COLOR_TOOLS,
      ffmpeg,
      tokenRequired: true,
      tenantBound: TENANT || null,
      queue: 0,
      cache: cache.size,
    });
    return;
  }

  if (req.method !== "POST" || url.pathname !== "/action") {
    json(res, 404, { ok: false, error: "not_found", message: "未知路径" });
    return;
  }

  if (!TOKEN) {
    json(res, 503, { ok: false, error: "not_configured", message: "WORKLOOM_COLOR_BRIDGE_TOKEN 未配置，拒绝一切调用" });
    return;
  }
  const auth = req.headers.authorization ?? "";
  if (auth !== `Bearer ${TOKEN}`) {
    json(res, 401, { ok: false, error: "tenant_mismatch", message: "凭据无效" });
    return;
  }

  let body;
  try {
    body = JSON.parse(await readBody(req));
  } catch (error) {
    const code = error instanceof ColorError ? error.code : "bad_request";
    json(res, 400, { ok: false, error: code, message: error instanceof Error ? error.message : String(error) });
    return;
  }

  const tool = typeof body?.tool === "string" ? body.tool : "";
  const params = (body?.params && typeof body.params === "object") ? body.params : {};
  if (!tool) {
    json(res, 400, { ok: false, error: "bad_request", message: "缺少 tool" });
    return;
  }

  if (TENANT && params.tenant_id !== TENANT) {
    json(res, 403, { ok: false, error: "tenant_mismatch", message: "租户凭据不符（跨租户调用被拒）" });
    return;
  }

  const idempotencyKey = typeof params.idempotency_key === "string" && params.idempotency_key
    ? params.idempotency_key
    : `color-${hashKey(`${tool}|${STABLE_JSON(params)}`)}`;

  const now = Date.now();
  gcCache(now);
  const hit = cache.get(idempotencyKey);
  if (hit) {
    json(res, 200, { ...hit.payload, idempotent_replay: true });
    return;
  }

  const jobId = `colorjob-${now.toString(36)}-${(seq += 1).toString(36)}`;
  const started = Date.now();
  try {
    const outcome = await callTool(tool, params);
    const payload = {
      ok: true,
      job_id: jobId,
      tool,
      result: outcome.result,
      receipt: {
        ...outcome.receipt,
        verified_at: outcome.receipt?.verified_at ?? new Date().toISOString(),
      },
      elapsed_ms: Date.now() - started,
    };
    cache.set(idempotencyKey, { at: now, payload });
    await jobAppend(jobsDir(), { jobId, tool, ok: true, elapsedMs: payload.elapsed_ms, sha256: payload.receipt.sha256 ?? null, tenant: params.tenant_id ?? null });
    json(res, 200, payload);
  } catch (error) {
    const code = error instanceof ColorError ? error.code : "engine_failed";
    const retryable = error instanceof ColorError ? error.retryable : true;
    const message = error instanceof Error ? error.message : String(error);
    await jobAppend(jobsDir(), { jobId, tool, ok: false, code, message, tenant: params.tenant_id ?? null });
    json(res, code === "tenant_mismatch" ? 403 : 200, { ok: false, job_id: jobId, tool, error: code, message, retryable });
  }
});

server.listen(PORT, HOST, () => {
  process.stdout.write(`[color-bridge] listening on http://${HOST}:${PORT} tools=${COLOR_TOOLS.length} tenant=${TENANT || "(unbound)"}\n`);
});
