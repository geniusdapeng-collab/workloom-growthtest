/**
 * 视频生成真机验收（T-2026-0921-0002）
 *
 * 真实消耗供应商额度：提交 → 轮询 → 成片入库 → 发布入队/执行（dry-run），全程走生产 API。
 * 用法（仓库根）：
 *   ./node_modules/.bin/tsx scripts/acceptance/video-gen-realtest.mts \
 *     [--model doubao-seedance-2-5] [--seconds 5] [--script prodtest-coffee-3in1] [--base http://127.0.0.1:8787]
 *
 * 纪律：脚本只做"驱动 + 断言 + 打印"；所有写入都经服务端 API（围栏/账本/事件不受影响）。
 */
import { parseArgs } from "node:util";

const { values } = parseArgs({
  options: {
    model: { type: "string", default: "doubao-seedance-2-5" },
    seconds: { type: "string", default: "5" },
    script: { type: "string", default: "prodtest-coffee-3in1" },
    base: { type: "string", default: "http://127.0.0.1:8787" },
    workspace: { type: "string", default: "geo-growth" },
    member: { type: "string", default: "MEM-G01" },
    "max-wait-min": { type: "string", default: "12" },
    "poll-sec": { type: "string", default: "20" },
    /** 复用既有任务（跳过生成，只跑发布链；用于不重复烧额度的回归） */
    job: { type: "string", default: "" },
    publish: { type: "boolean", default: true },
  },
});

const BASE = values.base!;
const MODEL = values.model!;
const SECONDS = Number(values.seconds);
const SCRIPT_KEY = values.script!;
const MAX_WAIT_MS = Number(values["max-wait-min"]) * 60_000;
const POLL_MS = Number(values["poll-sec"]) * 1000;
const DO_PUBLISH = values.publish !== false;

let token = "";

async function call(path: string, input: unknown, kind: "query" | "mutation") {
  const url = kind === "query"
    ? `${BASE}/trpc/${path}?input=${encodeURIComponent(JSON.stringify(input))}`
    : `${BASE}/trpc/${path}`;
  const res = await fetch(url, {
    method: kind === "query" ? "GET" : "POST",
    headers: {
      "content-type": "application/json",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    ...(kind === "query" ? {} : { body: JSON.stringify(input) }),
  });
  const text = await res.text();
  let body: unknown;
  try { body = JSON.parse(text); } catch { throw new Error(`${path} 返回非 JSON：${text.slice(0, 200)}`); }
  const err = (body as { error?: { message?: string } }).error;
  if (err) throw new Error(`${path} 失败：${err.message}`);
  const data = (body as { result?: { data?: unknown } }).result?.data;
  if (data && typeof data === "object" && "json" in (data as Record<string, unknown>)) {
    return (data as Record<string, unknown>).json;
  }
  return data;
}

const q = <T,>(path: string, input: unknown) => call(path, input, "query") as Promise<T>;
const m = <T,>(path: string, input: unknown) => call(path, input, "mutation") as Promise<T>;

function log(step: string, detail = "") {
  console.log(`[${new Date().toISOString().slice(11, 19)}] ${step}${detail ? ` · ${detail}` : ""}`);
}

async function main() {
  log("① 演示身份登录", `${values.workspace}/${values.member}`);
  const login = await m<{ token: string }>("auth.loginAs", { workspaceSlug: values.workspace, memberNo: values.member });
  token = login.token;

  if (values.job) {
    log("①b 复用既有任务模式", `job=${values.job}（跳过生成，仅验证发布链）`);
    const jobs = await q<Array<Record<string, unknown>>>("video.gen.jobs", { limit: 50 });
    const existing = jobs.find((j) => j.id === values.job);
    if (!existing) throw new Error(`任务 ${values.job} 不存在`);
    if (existing.status !== "done" || existing.playUrlKind !== "library") {
      throw new Error(`任务 ${values.job} 尚未完成入库（status=${String(existing.status)}，playUrlKind=${String(existing.playUrlKind)}）`);
    }
    await runPublishLeg(existing);
    return;
  }

  const catalog = await q<{ models: Array<{ id: string; name: string; tier: string; provider: string }> }>(
    "video.gen.catalog", { kind: "video" },
  );
  log("② 模型目录", `可用 ${catalog.models.length} 个：${catalog.models.map((x) => x.id).join(", ")}`);
  const model = catalog.models.find((x) => x.id === MODEL);
  if (!model) throw new Error(`模型 ${MODEL} 不在可用清单中（先检查供应商密钥/目录）`);

  const md = [
    `【真机验收 ${new Date().toISOString().slice(0, 10)}】产品：星芒保温杯（哑光黑，银色旋盖）。`,
    `镜头：暖光木桌台面，保温杯居中缓慢旋转 15 度，杯口升起一缕热气，背景虚化的窗光缓慢移动；`,
    `整体电影感、浅景深、无文字水印；时长 ${SECONDS} 秒，竖版 9:16。`,
  ].join("");
  const version = await m<{ id: string; version: number; script_key: string }>("video.cms.saveScriptVersion", {
    scriptKey: SCRIPT_KEY,
    md,
    diffSummary: `真机验收 T-2026-0921-0002（${MODEL} / ${SECONDS}s）`,
    charCheck: { charCount: md.length, withinSpec: true },
  });
  log("③ 渲染脚本落库", `${version.script_key} v${version.version}（${version.id}）`);

  /**
   * G8 审批：当前实现里"未命中规则"的写动作按 default_level=review 处理，
   * 因此渲染提交前需要一次显式审批（版本即审批对象）。这条审批由发起人本人确认，
   * 与"素材制作不设人审"的产品口径存在偏差——属既有实现，本次不改判定器，只在验收脚本里照实走一遍。
   */
  await m("video.cms.approveScript", { scriptKey: version.script_key, version: version.version });
  log("③b G8 审批", `${version.script_key} v${version.version} → approved`);

  const idem = `realtest:T-2026-0921-0002:${Date.now()}`;
  const submitted = await m<{
    jobId: string; taskId: string; mock: boolean; provider: string; providerModel: string;
    durationSec: number; clamped: boolean; estUsd: number | null; estCny: number | null; deduped: boolean;
  }>("video.render.submit", {
    scriptId: version.id,
    modelId: MODEL,
    mode: "manual",
    durationSec: SECONDS,
    aspectRatio: "9:16",
    resolution: "720p",
    generateAudio: true,
    idempotencyKey: idem,
  });
  log("④ 提交成功", `job=${submitted.jobId} task=${submitted.taskId} provider=${submitted.provider} mock=${submitted.mock} ${submitted.durationSec}s${submitted.clamped ? "（夹紧）" : ""}`);
  if (submitted.mock) throw new Error("提交落到 mock（未消耗真实额度）——真机验收要求真实供应商，请检查密钥");

  const started = Date.now();
  let job: Record<string, unknown> | null = null;
  while (Date.now() - started < MAX_WAIT_MS) {
    const poll = await m<{ checked: number; done: number; failed: number; running: number; ingested: number; details: Array<{ jobId: string; status: string; error?: string; ingestError?: string }> }>(
      "video.render.poll", { limit: 10 },
    );
    const jobs = await q<Array<Record<string, unknown>>>("video.gen.jobs", { limit: 10 });
    job = jobs.find((j) => j.id === submitted.jobId) ?? null;
    const status = String(job?.status ?? "unknown");
    const mine = poll.details.find((d) => d.jobId === submitted.jobId);
    log("⑤ 轮询", `status=${status} poll(checked=${poll.checked},done=${poll.done},ingested=${poll.ingested})${mine?.error ? ` err=${mine.error}` : ""}${mine?.ingestError ? ` ingest=${mine.ingestError}` : ""}`);
    if (status === "done" || status === "failed") break;
    await new Promise((r) => setTimeout(r, POLL_MS));
  }
  if (!job) throw new Error("任务在队列中消失（数据异常）");
  if (job.status === "failed") throw new Error(`渲染失败：${String(job.result_url ?? "")} ${String(job.error ?? "")}`);
  if (job.status !== "done") throw new Error(`等待超时（${MAX_WAIT_MS / 60000} 分钟）仍为 ${String(job.status)}`);

  const elapsed = Math.round((Date.now() - started) / 1000);
  log("⑥ 成片完成", `耗时 ${elapsed}s · 供应商链接=${String(job.playUrlKind)} · asset=${String(job.asset_id ?? "未入库")}`);
  if (job.playUrlKind !== "library") throw new Error(`成片未入库（playUrlKind=${String(job.playUrlKind)}）——供应商仅保留 7 天，属验收失败`);

  const media = await q<{ url: string; expiresInSec: number }>("video.gen.mediaUrl", { jobId: submitted.jobId });
  const head = await fetch(`${BASE}${media.url}`, { method: "GET" });
  const ctype = head.headers.get("content-type") ?? "";
  const buf = new Uint8Array(await head.arrayBuffer());
  log("⑦ 媒体通道", `HTTP ${head.status} · ${ctype} · ${(buf.byteLength / 1024 / 1024).toFixed(2)}MB`);
  if (head.status !== 200 || !ctype.startsWith("video/")) throw new Error("签名媒体通道校验失败（应为 200 + video/*）");

  if (DO_PUBLISH) await runPublishLeg(job);

  console.log("\n===== 真机验收通过 =====");
  console.log(JSON.stringify({
    jobId: submitted.jobId, taskId: submitted.taskId, provider: submitted.provider, model: submitted.providerModel,
    seconds: submitted.durationSec, elapsedSec: elapsed, assetId: job.asset_id, playUrlKind: job.playUrlKind,
    estCny: submitted.estCny, actualCny: job.actual_cny, mock: submitted.mock,
  }, null, 2));
}

/** 发布链：入队（G9 预检）→ 执行（dry-run）→ 回执校验（synced 必须为 false） */
async function runPublishLeg(job: Record<string, unknown>) {
  const created = await m<{ taskId: string; level: string }>("video.publish.createTask", {
    platform: "douyin",
    accountId: "acc-realtest-01",
    assetId: String(job.asset_id ?? ""),
    videoPath: String(job.local_path ?? ""),
    caption: "WorkLoom 真机验收成片（dry-run 发布，未真实上传）",
    tags: ["WorkLoom", "真机验收"],
  });
  log("⑧ 发布任务入队", `${created.taskId} · G9 预检=${created.level}`);
  const run = await m<{ kind: string; driver: string; overrideUsed: boolean; receipt?: { synced?: boolean } }>(
    "video.publish.run", { taskId: created.taskId },
  );
  log("⑨ 发布执行", `kind=${run.kind} driver=${run.driver} 测试放行=${run.overrideUsed} 回执synced=${String(run.receipt?.synced ?? false)}`);
  if (!["executed", "held_fence"].includes(run.kind)) throw new Error(`发布执行异常：${run.kind}`);
  if (run.driver !== "dry-run" || run.receipt?.synced === true) {
    throw new Error("dry-run 回执不得标记为真实同步（演示与真实必须分明）");
  }
  console.log("\n===== 发布链（dry-run）验收通过 =====");
  console.log(JSON.stringify({ taskId: created.taskId, fenceLevel: created.level, kind: run.kind, driver: run.driver, overrideUsed: run.overrideUsed }, null, 2));
}

main().catch((err) => {
  console.error("\n===== 真机验收失败 =====");
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
