/**
 * apps/server 最小入口（A6）：Hono + tRPC v11（fetch adapter）+ 健康检查
 * 端口：SERVER_PORT（默认 8787，见 .env.example）
 * 纪律：中间件栈（鉴权/租户解析/版本能力 403/错误规约）在阶段二 B5 挂载；
 *      本卡只保证「起得来、握得上、查得到 DB」。
 */
import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { fetchRequestHandler } from "@trpc/server/adapters/fetch";
import { Hono } from "hono";
import type { Context } from "hono";
import { cors } from "hono/cors";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { createWriteStream, existsSync, mkdirSync, renameSync, rmSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, extname, join } from "node:path";
import { appRouter } from "./trpc/router.js";
import { createContext } from "./trpc/context.js";
import { serviceGateway } from "./service/gateway.js";
import { getOwnerPool, getAppPool, getGatewayPool } from "@workloom/db";
import { bundlesRoot } from "@workloom/base/bundles";
import { registerFeedbackEnumsFromDisk } from "@workloom/base/evolve";
import { startSkillDistAutoSync, buildManifest, receiveReflux, type RefluxPayload } from "@workloom/base/skill-ops";
import { resolveMediaPath, verifyMediaToken } from "./video/gen/ingest.js";
import { mediaRoot } from "./video/gen/ingest.js";
import { safeExtOf, uploadMaxBytes, uploadRelPath, verifyUploadTicket } from "./video/media/upload.js";
import { changesSince, applyPush, syncEnabled, verifyDeviceRequest } from "./video/media/sync.js";
import { scopedQuery } from "./video/gen/db.js";
import { mediaUrl } from "./video/gen/ingest.js";
import { startThreadScheduler } from "./runtime/scheduler.js";
import { gatewayAppend } from "@workloom/base/workdata";
import { registerBundleAskFacts } from "./runtime/ask-facts-loader.js";
import { registerAskKbSearch } from "@workloom/runtime";
import { searchKB } from "./service/kb.js";

import { readVoiceFile, synthesizeVoice, voiceStationConfig } from "./voice/station.js";
const app = new Hono();

app.use(
  "*",
  cors({
    // 桌面自包含/生产：仅本机回环来源（web 从 127.0.0.1:5173 跨端口调 8787 属跨域，
    // 必须显式放行回环）；开发期放宽任意来源直连（D-SEC1 交付审计实证：反射 * + 0.0.0.0 = 局域网裸奔）
    origin: (origin) => {
      if (process.env.NODE_ENV === "production") {
        return origin && /^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(origin) ? origin : null;
      }
      return origin ?? "*";
    },
    credentials: true,
  }),
);

/** 裸健康检查（不进 tRPC，供 start.sh/编排探活） */
app.get("/health", (c) => c.json({ ok: true, service: "workloom-im-server" }));

/**
 * 本机克隆音色（小织/织伴的默认音色）[VOICE-DEFAULT]
 *  - GET /api/voice/status → 工位是否就绪（客户端据此决定是否走克隆音色，不探测就不猜）
 *  - GET /api/voice/speech?text=…&profile=… → 返回 wav；工位不可达/未配置一律 503，
 *    客户端按契约回落到系统女声并锁定同一音色（宁可换声线，也不让播报消失）。
 * 声纹只在本机工位：服务端只传 profile 名与文本，不搬运参考音频。
 */
const voiceConfig = voiceStationConfig();
app.get("/api/voice/status", (c) =>
  c.json({
    enabled: voiceConfig.enabled,
    configured: Boolean(voiceConfig.token),
    profile: voiceConfig.profile,
    bridge: voiceConfig.bridgeUrl,
  }));

app.get("/api/voice/speech", async (c) => {
  const text = c.req.query("text") ?? "";
  const profile = c.req.query("profile") || voiceConfig.profile;
  const result = await synthesizeVoice(text, { config: voiceConfig, profile });
  if (!result.ok) {
    return c.json({ error: result.error, message: result.message, profile: result.profile }, 503);
  }
  const audio = await readVoiceFile(result.file);
  return new Response(audio, {
    status: 200,
    headers: {
      "content-type": "audio/wav",
      "cache-control": "no-store",
      "x-voice-profile": result.profile,
      "x-voice-cached": result.cached ? "1" : "0",
    },
  });
});

/** tRPC v11 over HTTP（fetch adapter；httpBatchLink 由客户端侧决定） */
app.all("/trpc/*", async (c) => {
  const res = await fetchRequestHandler({
    endpoint: "/trpc",
    req: c.req.raw,
    router: appRouter,
    createContext: () => createContext(c.req.raw),
    /**
     * GR-12（2026-09-28 压测）：tRPC 默认把错误交回客户端就完事——实测 12 路并发派遣
     * 打出 10 个 500，服务端日志 0 条记录（客户报障时无从查起）。
     * 这里统一落日志（path/code/消息摘要 + 请求指纹前 8 位，不记 PII），
     * 5xx（INTERNAL_SERVER_ERROR）额外经安全网关写系统域事件（append-only 可审计）。
     * onError 内任何失败都必须吞掉：错误处理路径再抛错会把正常响应也带崩。
     */
    onError: ({ path, error, type, ctx }) => {
      const ref = createHash("sha256")
        .update(`${path ?? "-"}|${error.code}|${error.message}`)
        .digest("hex")
        .slice(0, 8);
      console.error(`[trpc] ${type ?? "unknown"} ${path ?? "-"} → ${error.code}: ${error.message}（ref=${ref}）`);
      if (error.code !== "INTERNAL_SERVER_ERROR") return;
      const identity = ctx?.identity;
      if (!identity) return;
      void gatewayAppend(getGatewayPool(), {
        tenantId: identity.tenantId,
        workspaceId: identity.workspaceId,
        actor: { id: "system", type: "system" },
      }, {
        who: { type: "system", id: "system" },
        context: {
          tenant_id: identity.tenantId, workspace_id: identity.workspaceId,
          time: new Date().toISOString(), channel: "server",
        },
        object: { type: "server_request", id: ref },
        decision: {
          action: "system.error",
          after: { path: path ?? null, code: error.code, ref, message: error.message.slice(0, 200) },
          basis: ["服务端 5xx 统一留痕（GR-12）：错误可见、可审计、可复现"],
        },
        rule_impact: [],
      }).catch((err: unknown) => {
        console.error("[trpc] 5xx 事件留痕失败（不二次抛出）", err instanceof Error ? err.message : String(err));
      });
    },
  });
  return res;
});

const port = Number(process.env.SERVER_PORT ?? 8787);

/** C 端公开网关（AI 服务前台；独立于员工 tRPC，c-token 鉴权 + 限流） */
app.route("/c", serviceGateway);

/**
 * 成片媒体库通道（T-2026-0921-0002）：HMAC 签名 + 过期时间，防目录穿越。
 * 为什么不做裸静态目录：成片是客户资产，必须带鉴权（签名即鉴权，短 TTL，不落 cookie）。
 */
const MEDIA_MIME: Record<string, string> = {
  ".mp4": "video/mp4", ".webm": "video/webm", ".mov": "video/quicktime",
  ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp",
};
app.get("/media/*", async (c) => {
  const raw = c.req.path.replace(/^\/media\//, "");
  let relPath: string;
  try {
    relPath = decodeURIComponent(raw);
  } catch {
    return c.json({ error: "MEDIA_PATH_INVALID" }, 400);
  }
  const verdict = verifyMediaToken(relPath, c.req.query("token") ?? "");
  if (!verdict.ok) return c.json({ error: "MEDIA_TOKEN_INVALID", reason: verdict.reason }, 403);
  let abs: string;
  try {
    abs = resolveMediaPath(relPath);
  } catch {
    return c.json({ error: "MEDIA_PATH_INVALID" }, 400);
  }
  if (!existsSync(abs)) return c.json({ error: "MEDIA_NOT_FOUND" }, 404);
  const buf = await readFile(abs);
  return new Response(buf, {
    headers: {
      "content-type": MEDIA_MIME[extname(abs).toLowerCase()] ?? "application/octet-stream",
      "cache-control": "private, max-age=300",
    },
  });
});

/**
 * 上传流水（T-2026-0926-0007 规格书 §3.5 第②步）：Hono 原生流式，不经 tRPC。
 * 鉴权靠 `uploadTicket` 签发的 10 分钟 HMAC 凭证（载荷含 workspaceId/filename/maxBytes 且全字段进签名）；
 * 边写边算 sha256，超限即中止并删半成品。落盘位置 `upload/<ws>/<sha256><ext>`，与入库口径一致。
 */
app.post("/media/upload", async (c) => {
  const verdict = verifyUploadTicket(c.req.query("token") ?? "");
  if (!verdict.ok) return c.json({ error: verdict.reason }, 403);
  const maxBytes = Math.min(verdict.maxBytes, uploadMaxBytes());
  const tmpDir = join(mediaRoot(), ".upload-tmp");
  mkdirSync(tmpDir, { recursive: true });
  const tmp = join(tmpDir, `${verdict.nonce}.part`);
  const hash = createHash("sha256");
  const stream = createWriteStream(tmp);
  let bytes = 0;
  try {
    for await (const chunk of c.req.raw.body as unknown as AsyncIterable<Uint8Array>) {
      bytes += chunk.byteLength;
      if (bytes > maxBytes) {
        stream.destroy();
        rmSync(tmp, { force: true });
        return c.json({ error: "UPLOAD_TOO_LARGE", maxBytes }, 413);
      }
      hash.update(chunk);
      if (!stream.write(Buffer.from(chunk))) await once(stream, "drain");
    }
    await new Promise<void>((resolve) => stream.end(() => resolve()));
  } catch (err) {
    stream.destroy();
    rmSync(tmp, { force: true });
    return c.json({ error: "UPLOAD_FAILED", message: err instanceof Error ? err.message : String(err) }, 500);
  }
  if (bytes === 0) {
    rmSync(tmp, { force: true });
    return c.json({ error: "UPLOAD_EMPTY" }, 400);
  }
  const sha256 = hash.digest("hex");
  const relPath = uploadRelPath(verdict.workspaceId, sha256, `${verdict.nonce}${safeExtOf(verdict.filename)}`);
  const abs = join(mediaRoot(), relPath);
  mkdirSync(dirname(abs), { recursive: true });
  renameSync(tmp, abs);
  return c.json({ sha256, relPath, bytes, filename: verdict.filename, expiresAt: new Date(verdict.exp * 1000).toISOString() });
});

/**
 * 云端同步通道（T-2026-0926-0009）：设备级 HMAC 鉴权（`x-workloom-device/timestamp/signature`）。
 * 只在 `WORKLOOM_CLOUD_SYNC=1` 时挂载——未开启部署形态下这些路径根本不存在（不暴露半开的同步面）。
 */
if (syncEnabled()) {
  const bodyOf = async (c: Context): Promise<string> => {
    try {
      return await c.req.text();
    } catch {
      return "";
    }
  };
  const auth = async (c: Context, body: string, method: string, path: string) => {
    return verifyDeviceRequest(getOwnerPool(), {
      deviceId: c.req.header("x-workloom-device") ?? "",
      timestamp: c.req.header("x-workloom-timestamp") ?? "",
      signature: c.req.header("x-workloom-signature") ?? "",
      method,
      path,
      body,
    });
  };
  /**
   * 签名覆盖 **路径 + 查询串**（`c.req.path` 不含 query）：否则同一路径的签名
   * 可被换成 `since=`/`limit=` 复用，等于把"这一请求"降级成"这一端点"。
   */
  const signedPathOf = (c: Context): string => {
    const url = new URL(c.req.url);
    return `${url.pathname}${url.search}`;
  };

  app.get("/sync/media/pull", async (c) => {
    const verdict = await auth(c, "", "GET", signedPathOf(c));
    if (!verdict.ok || !verdict.scope) return c.json({ error: verdict.code ?? "DEVICE_UNAUTHORIZED" }, 403);
    const since = c.req.query("since") ?? null;
    const limit = Number(c.req.query("limit") ?? 500);
    const payload = await changesSince(getAppPool(), verdict.scope, {
      since, limit: Number.isFinite(limit) ? limit : 500,
    });
    return c.json({ ...payload, device: verdict.deviceLabel ?? null });
  });

  app.post("/sync/media/push", async (c) => {
    const declared = Number(c.req.header("content-length") ?? 0);
    const maxBytes = Number(process.env.MEDIA_SYNC_PUSH_MAX_MB ?? 8) * 1024 * 1024;
    if (Number.isFinite(declared) && declared > maxBytes) {
      return c.json({ error: "SYNC_PUSH_TOO_LARGE", maxBytes }, 413);
    }
    const body = await bodyOf(c);
    if (body.length > maxBytes) return c.json({ error: "SYNC_PUSH_TOO_LARGE", maxBytes }, 413);
    const verdict = await auth(c, body, "POST", signedPathOf(c));
    if (!verdict.ok || !verdict.scope) return c.json({ error: verdict.code ?? "DEVICE_UNAUTHORIZED" }, 403);
    let payload: unknown;
    try {
      payload = JSON.parse(body || "{}");
    } catch {
      return c.json({ error: "SYNC_BODY_INVALID_JSON" }, 400);
    }
    const result = await applyPush(getAppPool(), verdict.scope, payload as never, verdict.deviceLabel ?? "device");
    return c.json(result);
  });

  app.get("/sync/media/url", async (c) => {
    const verdict = await auth(c, "", "GET", signedPathOf(c));
    if (!verdict.ok || !verdict.scope) return c.json({ error: verdict.code ?? "DEVICE_UNAUTHORIZED" }, 403);
    const assetId = c.req.query("assetId") ?? "";
    if (!assetId) return c.json({ error: "ASSET_ID_REQUIRED" }, 400);
    const rows = await scopedQuery<{ local_path: string | null }>(getAppPool(), verdict.scope,
      `SELECT meta->>'localPath' AS local_path FROM video_assets WHERE workspace_id = $1 AND id = $2`,
      [verdict.scope.workspaceId, assetId]);
    const localPath = rows[0]?.local_path ?? null;
    if (!localPath) return c.json({ error: "ASSET_FILE_NOT_ON_CLOUD" }, 404);
    return c.json({ url: mediaUrl(localPath, 3600), expiresInSec: 3600 });
  });
  console.log("云端媒资同步通道已挂载：GET /sync/media/pull · POST /sync/media/push · GET /sync/media/url");
}

/** 官方运营台 HTTP 端点（仅 SKILL_OPS_MODE=official 部署挂载）：
 *  GET  /skill-dist/manifest.json —— 客户端拉取通道（分发包逐一官方签名，客户端 staging① 验签）
 *  POST /skill-ops/reflux        —— 客户回流接收（HMAC 验签，正文即客户预览的「所发」） */
if (process.env.SKILL_OPS_MODE === "official") {
  app.get("/skill-dist/manifest.json", async (c) => {
    const key = process.env.SKILL_DIST_SIGNING_KEY ?? "";
    if (!key) return c.json({ error: "SIGNING_KEY_NOT_CONFIGURED" }, 503);
    const manifest = await buildManifest(getAppPool(), { signingKey: key });
    return c.json(manifest);
  });
  app.post("/skill-ops/reflux", async (c) => {
    const key = process.env.SKILL_DIST_SIGNING_KEY ?? "";
    if (!key) return c.json({ error: "SIGNING_KEY_NOT_CONFIGURED" }, 503);
    const signature = c.req.header("x-reflux-signature") ?? "";
    const payload = (await c.req.json()) as RefluxPayload;
    try {
      // 官方实例以第一个工作区作为事件留痕 scope（运营台部署自带管理区）
      const ws = await getAppPool().query<{ id: string; tenant_id: string }>(`SELECT id, tenant_id FROM workspaces ORDER BY created_at LIMIT 1`);
      const w = ws.rows[0];
      if (!w) return c.json({ error: "OPS_WORKSPACE_MISSING" }, 503);
      const r = await receiveReflux(getAppPool(), getGatewayPool(), { tenantId: w.tenant_id, workspaceId: w.id }, {
        payload, signature, signingKey: key,
      });
      return c.json(r);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return c.json({ error: msg }, 403);
    }
  });
  console.log("官方运营台端点已挂载：GET /skill-dist/manifest.json · POST /skill-ops/reflux");
}

/** apps/webc 静态托管（C 端小程序/H5 演示壳；dist 不存在则跳过不报错） */
const webcDist = join(dirname(fileURLToPath(import.meta.url)), "../../webc/dist");
if (existsSync(webcDist)) {
  app.use("/app/c/*", serveStatic({ root: webcDist, rewriteRequestPath: (p) => p.replace(/^\/app\/c/, "") || "/" }));
  app.get("/app/c", (c) => c.redirect("/app/c/"));
  console.log(`apps/webc 静态托管已挂载：/app/c → ${webcDist}`);
}

// 桌面自包含默认仅本机回环（D-SEC1 交付审计实证：@hono/node-server 缺省绑 0.0.0.0，
// 客户机上等于对局域网开放 API）；官方服务端部署用 SERVER_HOST=0.0.0.0 显式放开
const host = process.env.SERVER_HOST ?? "127.0.0.1";
serve({ fetch: app.fetch, port, hostname: host }, (info) => {
  console.log(`WorkLoom IM 底座 server 已启动：http://${host}:${info.port}（tRPC: /trpc/*，C 端网关: /c/*）`);
  /**
   * GR-16：本机调度器——没有它，`queued` 线程（agent 模式、任务页派活、非"立即执行"的 quest）
   * 永远不会被执行。启动时顺带把崩溃遗留的 running 线程转 paused（可续跑）。
   */
  startThreadScheduler();
  /**
   * A-05 修复：启动恢复补扫——「步骤审批已 approved 但线程停 pending_review」的僵尸线程。
   * 此前审批通过的自动续跑是 setTimeout fire-and-forget，进程在回调执行前重启即永丢
   * （调度器只扫 queued，不接 pending_review）。启动时统一补续跑，失败只记日志不阻塞启动。
   */
  void (async () => {
    try {
      const { resumeApprovedPendingThreads } = await import("./runtime/scheduler.js");
      const n = await resumeApprovedPendingThreads();
      if (n > 0) console.log(`[scheduler] 启动恢复：补续跑 ${n} 条「审批已通过但线程挂起」的僵尸线程`);
    } catch (err) {
      console.error("[scheduler] 启动恢复补扫失败（不阻塞启动）", err instanceof Error ? err.message : String(err));
    }
  })();
  /**
   * GR-19：装载各行业 ask 事实面（geo-growth 等）——不装的话，右侧对话框问领域问题只会得到
   * 底座通用事实（实测"问什么都是没有相关记录"）。失败不阻塞启动（回落通用事实面）。
   */
  void registerBundleAskFacts()
    .then((industries) => {
      if (industries.length > 0) console.log(`行业 ask 事实面已装载：${industries.join("、")}`);
    })
    .catch((err) => console.error("[ask-facts] 装载失败（不阻塞启动）", err instanceof Error ? err.message : String(err)));
  /**
   * X-04（第四轮实测）：把客户知识库检索接进 ask 事实面——此前知识库管道只建到"检索"为止，
   * 客户上传的券后折扣/暗号/政策一个字都进不了答案。检索失败由 gatherFacts 吞掉并回落（不劣化）。
   */
  registerAskKbSearch(async (scope, question, limit) => {
    const hits = await searchKB({ workspaceId: scope.workspaceId, query: question, limit });
    return hits.map((hit) => ({
      content: hit.content,
      ...(hit.heading ? { heading: hit.heading } : {}),
      ...(hit.documentTitle ? { documentTitle: hit.documentTitle } : {}),
      documentId: hit.documentId,
    }));
  });
});

// 技能保鲜环 · 夜班窗口自动同步（机制即自动，客户零操作）：
// 每 60s 评估——夜班窗口（22:00→08:30 Asia/Shanghai）内且距上次自动同步 ≥20h 才执行；
// 未配置 SKILL_DIST_REGISTRY_URL / SKILL_DIST_SIGNING_KEY = 整体禁用（不降级跳过验签）；
// 事件归因 system:night-shift（谁干的在事件库一眼可辨）；客户可经 skillOps.setPolicy 关闭（治理主权）。
if (process.env.SKILL_DIST_REGISTRY_URL && process.env.SKILL_DIST_SIGNING_KEY) {
  startSkillDistAutoSync(getAppPool(), getGatewayPool(), {
    registryUrl: process.env.SKILL_DIST_REGISTRY_URL,
    signingKey: process.env.SKILL_DIST_SIGNING_KEY,
    instanceOf: async (scope) => {
      const client = await getAppPool().connect();
      try {
        await client.query("BEGIN");
        await client.query("SELECT set_config('app.workspace_id', $1, true)", [scope.workspaceId]);
        const r = await client.query<{ industry: string | null }>(`SELECT industry FROM workspaces WHERE id=$1`, [scope.workspaceId]);
        await client.query("COMMIT");
        return {
          bundles: r.rows[0]?.industry ? [r.rows[0].industry] : [],
          edition: process.env.SKILL_DIST_EDITION ?? "community",
        };
      } catch (err) {
        await client.query("ROLLBACK").catch(() => undefined);
        throw err;
      } finally { client.release(); }
    },
    onResult: (r) => {
      console.log(`[skill-dist-autosync] ${r.workspaceId} 夜班同步完成：装载 ${r.result?.loaded.length ?? 0} / 待审批 ${r.result?.pending.length ?? 0} / 拦截 ${r.result?.rejected.length ?? 0}`);
    },
  });
  console.log("技能保鲜环夜班自动同步已挂载（60s 评估节拍；窗口 22:00→08:30 Asia/Shanghai）");
}

// D24 自我进化飞轮 M1：启动时为全部已激活行业的工作区装载反馈枚举表（Bundle 第⑧槽）。
// 失败不阻断启动（枚举表缺失 = 该行业未提供第⑧槽，decide 校验自动放行，向后兼容）。
registerFeedbackEnumsFromDisk(getOwnerPool(), bundlesRoot())
  .then((registered) => {
    if (registered.length > 0) {
      console.log(`反馈枚举表已装载：${registered.map((r) => `${r.industry}→${r.workspaceId}（${r.count} 条）`).join("、")}`);
    }
  })
  .catch((err) => {
    console.warn(`反馈枚举表装载失败（不阻断启动，decide 校验按未装配放行）：${err instanceof Error ? err.message : err}`);
  });
