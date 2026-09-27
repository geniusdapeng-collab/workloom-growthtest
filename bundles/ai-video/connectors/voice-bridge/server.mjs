#!/usr/bin/env node
/**
 * 配音工位 bridge 服务（常驻，默认只监听 127.0.0.1）。
 *
 *   POST /action   { tool, params }          → { ok, result, receipt } | { ok:false, error, message }
 *   GET  /health                             → 工位与引擎健康
 *   GET  /tools                              → 工具面清单
 *
 * 安全：Bearer token（WORKLOOM_VOICE_BRIDGE_TOKEN 必填，缺省拒绝一切调用）；
 *       租户绑定（WORKLOOM_VOICE_BRIDGE_TENANT 设置后校验 params.tenant_id）；
 *       幂等（相同 tool+params 在 TTL 内命中缓存）；路径监狱、声纹不出域与事实留痕都在 core 内。
 */

import http from "node:http";
import process from "node:process";

import { VOICE_TOOLS, VoiceError, STABLE_JSON, callTool, engineConfig, hashKey, health, jobAppend, jobsDir } from "./core.mjs";
import { resolveBinaries } from "../bgm-bridge/measure.mjs";

const PORT = Number(process.env.WORKLOOM_VOICE_BRIDGE_PORT ?? 9776);
const HOST = process.env.WORKLOOM_VOICE_BRIDGE_HOST ?? "127.0.0.1";
const TOKEN = (process.env.WORKLOOM_VOICE_BRIDGE_TOKEN ?? "").trim();
const TENANT = (process.env.WORKLOOM_VOICE_BRIDGE_TENANT ?? "").trim();
const IDEMPOTENCY_TTL_MS = Number(process.env.WORKLOOM_VOICE_IDEMPOTENCY_TTL_MS ?? 10 * 60 * 1000);
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
        reject(new VoiceError("请求体过大", "bad_request"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", (error) => reject(new VoiceError(`读取请求失败：${error.message}`, "network_error", true)));
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
    let info = null;
    try {
      info = await health({ bins: resolveBinaries() });
    } catch (error) {
      info = { engine: { reachable: false }, error: error instanceof Error ? error.message : String(error) };
    }
    json(res, 200, {
      ok: true,
      tokenRequired: true,
      tenantBound: TENANT || null,
      cache: cache.size,
      tools: VOICE_TOOLS,
      engine: info.engine,
      mic: info.mic,
      profiles: info.profiles,
      station: info.station,
      ffmpeg: info.ffmpeg,
    });
    return;
  }

  if (req.method === "GET" && url.pathname === "/tools") {
    json(res, 200, { ok: true, tools: VOICE_TOOLS, engine: engineConfig().kind });
    return;
  }

  if (req.method !== "POST" || url.pathname !== "/action") {
    json(res, 404, { ok: false, error: "not_found", message: "未知路径" });
    return;
  }

  if (!TOKEN) {
    json(res, 503, { ok: false, error: "not_configured", message: "WORKLOOM_VOICE_BRIDGE_TOKEN 未配置，拒绝一切调用" });
    return;
  }
  if ((req.headers.authorization ?? "") !== `Bearer ${TOKEN}`) {
    json(res, 401, { ok: false, error: "tenant_mismatch", message: "凭据无效" });
    return;
  }

  let body;
  try {
    body = JSON.parse(await readBody(req));
  } catch (error) {
    const code = error instanceof VoiceError ? error.code : "bad_request";
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
    : `voice-${hashKey(`${tool}|${STABLE_JSON(params)}`)}`;

  const now = Date.now();
  gcCache(now);
  // 核验必须读取当前文件与当前 ASR 状态：同路径可能已返修，引擎也可能从缺测恢复。
  // 合成/配音等产物动作仍保留原有幂等语义，只有只测量的 verify 不复用结果。
  const cacheable = tool !== "voicewrite.verify";
  const hit = cacheable ? cache.get(idempotencyKey) : undefined;
  if (hit) {
    json(res, 200, { ...hit.payload, idempotent_replay: true });
    return;
  }

  const jobId = `voicejob-${now.toString(36)}-${(seq += 1).toString(36)}`;
  const started = Date.now();
  try {
    const outcome = await callTool(tool, params);
    const payload = {
      ok: true,
      job_id: jobId,
      tool,
      result: outcome.result,
      receipt: { ...outcome.receipt, verified_at: outcome.receipt?.verified_at ?? new Date().toISOString() },
      elapsed_ms: Date.now() - started,
    };
    if (cacheable) cache.set(idempotencyKey, { at: now, payload });
    await jobAppend(jobsDir(), {
      jobId, tool, ok: true, elapsedMs: payload.elapsed_ms,
      sha256: payload.receipt.sha256 ?? null, tenant: params.tenant_id ?? null,
    });
    json(res, 200, payload);
  } catch (error) {
    const code = error instanceof VoiceError ? error.code : "engine_failed";
    const retryable = error instanceof VoiceError ? error.retryable : true;
    const message = error instanceof Error ? error.message : String(error);
    await jobAppend(jobsDir(), { jobId, tool, ok: false, code, message, tenant: params.tenant_id ?? null });
    // 工位错误一律 HTTP 200 + ok:false（与 bgm-bridge 同款）：工具级失败由宿主的软失败通道处理，
    // 只有鉴权/租户/协议错误才用非 200，避免把"引擎抖动"误判成"端点不可用"。
    json(res, code === "tenant_mismatch" ? 403 : code === "not_configured" ? 503 : 200, {
      ok: false, job_id: jobId, tool, error: code, message, retryable,
    });
  }
});

server.listen(PORT, HOST, () => {
  process.stdout.write(`[voice-bridge] listening on http://${HOST}:${PORT} tools=${VOICE_TOOLS.length} engine=${engineConfig().kind} tenant=${TENANT || "(unbound)"}\n`);
});
