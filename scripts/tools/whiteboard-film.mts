#!/usr/bin/env tsx
/**
 * 手绘白板片出片工具（T-2026-0926-0020）
 *
 * 用途：把一份口播稿跑成一条**带配音、带字幕轨、入了媒资库**的手绘白板解说片，
 * 并把每一步的产物与读数落成一份证据 JSON（用于验收与排障）。
 *
 * 与 `render-project.mts` 的关系：那把镜头卡逐镜推给 Seedance；这把口播稿推给本地白板引擎。
 * 两者都走 tRPC（服务端是唯一写入口），都不直接改库。
 *
 * 用法：
 *   pnpm exec tsx --env-file=.env scripts/tools/whiteboard-film.mts \
 *     --script docs/examples/whiteboard-growth-sales-script.md \
 *     --title "WorkLoom 获客增长系统 · 销售解说" \
 *     --profile chen-zhuo-film --lineart seedream \
 *     --workspace-slug geo-growth --member-no MEM-G01 \
 *     --evidence var/whiteboard-jobs/evidence-sales.json
 *
 * 分步重跑（会话断了接着做，不重烧算力）：
 *   --only narrate,plan / --only lineart --scene 3 / --only annotate,preview / --only render,poll,deliver
 *   --film WF-xxx           # 复用既有片子（跳过 create）
 */
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";

const API = (process.env.WORKLOOM_API ?? "http://127.0.0.1:8787").replace(/\/$/, "");
const REPO_ROOT = resolve(import.meta.dirname ?? process.cwd(), "../..");
const started = Date.now();

function arg(name: string, fallback = ""): string {
  const i = process.argv.indexOf(name);
  return i >= 0 ? (process.argv[i + 1] ?? fallback) : fallback;
}
const flag = (name: string) => process.argv.includes(name);
const num = (name: string, fallback: number) => {
  const v = arg(name);
  return v ? Number(v) : fallback;
};

interface Evidence {
  task: string;
  startedAt: string;
  api: string;
  script: { path: string; chars: number; sentences: number };
  steps: Array<{ step: string; ms: number; ok: boolean; detail?: unknown }>;
  artifacts?: Record<string, unknown>;
  finishedAt?: string;
  totalMs?: number;
}

const evidence: Evidence = {
  task: "T-2026-0926-0020",
  startedAt: new Date(started).toISOString(),
  api: API,
  script: { path: "", chars: 0, sentences: 0 },
  steps: [],
};

async function call<T>(path: string, body: unknown, method: "POST" | "GET" = "POST"): Promise<T> {
  const url = method === "GET"
    ? `${API}/trpc/${path}?input=${encodeURIComponent(JSON.stringify(body ?? {}))}`
    : `${API}/trpc/${path}`;
  const res = await fetch(url, {
    method,
    headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
    ...(method === "POST" ? { body: JSON.stringify(body ?? {}) } : {}),
  });
  const text = await res.text();
  const json = text ? (JSON.parse(text) as { error?: { message?: string }; result?: { data?: T } }) : {};
  if (json.error) throw new Error(`${path}：${json.error.message}`);
  if (!res.ok) throw new Error(`${path}：HTTP ${res.status}`);
  return json.result?.data as T;
}

let token = process.env.WORKLOOM_TOKEN ?? "";

async function login(): Promise<void> {
  if (token) return;
  const workspaceSlug = arg("--workspace-slug", "geo-growth");
  const memberNo = arg("--member-no", "MEM-G01");
  const data = await call<{ token?: string }>("auth.loginAs", { workspaceSlug, memberNo });
  if (!data?.token) throw new Error(`auth.loginAs 未返回 token（workspaceSlug=${workspaceSlug} memberNo=${memberNo}）`);
  token = data.token;
}

async function step<T>(name: string, fn: () => Promise<T>): Promise<T> {
  const t0 = Date.now();
  try {
    const result = await fn();
    evidence.steps.push({ step: name, ms: Date.now() - t0, ok: true, detail: summarize(result) });
    console.log(`✓ ${name}（${((Date.now() - t0) / 1000).toFixed(1)}s）`);
    return result;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    evidence.steps.push({ step: name, ms: Date.now() - t0, ok: false, detail: message });
    console.error(`✗ ${name}：${message}`);
    throw err;
  }
}

/** 证据瘦身：只留关键读数，避免把整份标注/字幕灌进证据文件 */
function summarize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(summarize);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (k === "srt" || k === "annotation" || k === "script_md") continue;
      out[k] = summarize(v);
    }
    return out;
  }
  if (typeof value === "string" && value.length > 300) return `${value.slice(0, 300)}…`;
  return value;
}

async function main(): Promise<void> {
  await login();

  const only = arg("--only").split(",").map((s) => s.trim()).filter(Boolean);
  const wants = (name: string) => only.length === 0 || only.includes(name);

  const scriptPath = arg("--script");
  let filmId = arg("--film");
  let projectId = "";

  if (!filmId) {
    if (!scriptPath) throw new Error("缺少 --script（口播稿文件路径），或用 --film 复用既有片子");
    const script = readFileSync(resolve(scriptPath), "utf8");
    evidence.script = {
      path: resolve(scriptPath),
      chars: script.length,
      sentences: script.split(/[。！？!?；;]/).filter((s) => s.trim().length > 0).length,
    };
    const created = await step("create", () => call<{ filmId: string; projectId: string; modelId: string }>(
      "video.whiteboard.create",
      {
        title: arg("--title", "手绘白板解说片"),
        script,
        lineartMode: (arg("--lineart", process.env.WHITEBOARD_LINEART ?? "seedream") as "seedream" | "sketch" | "upload"),
        narrationProfile: arg("--profile", process.env.WHITEBOARD_NARRATION_PROFILE ?? undefined) || undefined,
        fps: num("--fps", Number(process.env.WHITEBOARD_FPS ?? 30)),
        capLongEdge: num("--cap-long-edge", Number(process.env.WHITEBOARD_CAP_LONG_EDGE ?? 1280)),
        voiceLufs: num("--lufs", Number(process.env.WHITEBOARD_VOICE_LUFS ?? -16)),
      },
    ));
    filmId = created.filmId;
    projectId = created.projectId;
    evidence.artifacts = { ...(evidence.artifacts ?? {}), filmId, projectId, modelId: created.modelId };
  } else {
    const status = await call<{ film: { project_id: string } }>("video.whiteboard.status", { filmId }, "GET");
    projectId = status.film.project_id;
    evidence.artifacts = { ...(evidence.artifacts ?? {}), filmId, projectId };
  }

  if (wants("narrate")) {
    /**
     * 配音是**长任务**（本机克隆音色单句 80–220s，30 句几十分钟）：
     * 服务端只投递任务并立刻返回，这里轮询进度——不能拿一个同步请求硬等，
     * 那会被 HTTP 层超时打断（真机实测 fetch failed，而服务端其实还在跑）。
     */
    const dispatched = await step("narrate:dispatch", () => call<Record<string, unknown>>(
      "video.whiteboard.narrate", { filmId, verify: !flag("--no-verify") },
    ));
    const deadline = Date.now() + num("--narrate-timeout-ms", 3 * 60 * 60_000);
    let lastDone = -1;
    for (;;) {
      if (Date.now() > deadline) throw new Error("配音超时：可加大 --narrate-timeout-ms 后重跑（已合成的句子会被复用）");
      const st = await call<{ status: string; done: number; total: number; note: string | null; error: string | null; srt: string; narrationPath: string | null; narrationUrl: string | null }>(
        "video.whiteboard.narrateStatus", { filmId }, "GET",
      );
      if (st.done !== lastDone) {
        console.log(`  配音进度 ${st.done}/${st.total}：${(st.note ?? "").slice(0, 28)}`);
        lastDone = st.done;
      }
      if (st.status === "failed") throw new Error(`配音失败：${st.error ?? "未知原因"}`);
      if (st.status === "narrated" || st.status === "planned" || st.status === "lineart" || st.status === "annotated") {
        evidence.artifacts = { ...(evidence.artifacts ?? {}), narration: {
          dispatched, totalMs: undefined, sentences: st.total,
          narrationPath: st.narrationPath, narrationUrl: st.narrationUrl, chars: st.srt.length,
        } };
        console.log(`✓ narrate（${st.total} 句）`);
        break;
      }
      await new Promise((r) => setTimeout(r, num("--narrate-interval-ms", 15000)));
    }
  }

  if (wants("plan")) {
    const plan = await step("plan", () => call<Record<string, unknown>>("video.whiteboard.plan", {
      filmId,
      targetSec: num("--target-sec", 30),
      minSec: num("--min-sec", 25),
      maxSec: num("--max-sec", 35),
    }));
    evidence.artifacts = { ...(evidence.artifacts ?? {}), plan };
    console.log(`  分幕 ${(plan as { scenes?: unknown[] }).scenes?.length ?? "?"} 幕，总时长 ${((plan as { totalMs?: number }).totalMs ?? 0) / 1000}s`);
  }

  if (wants("lineart")) {
    /**
     * **逐幕调用**，不是一次 onSubmit 全部。
     *
     * 为什么：方舟出图每张几十秒，11 幕串在一次请求里必然超过 HTTP 的头超时（真机实测 300s 上限，
     * 客户端拿到 `fetch failed`，而服务端其实还在出图）。逐幕调用把每次请求压到几十秒内，
     * 且天然可续跑（已出好的幕会被服务端跳过，不重烧出图费用）。
     */
    const sceneNo = arg("--scene");
    const targets = sceneNo
      ? [{ scene_no: Number(sceneNo) }]
      : (await call<{ scenes: Array<{ scene_no: number; lineart_path: string | null }> }>(
        "video.whiteboard.status", { filmId }, "GET",
      )).scenes;
    const linearts: unknown[] = [];
    for (const scene of targets) {
      linearts.push(await step(`lineart:${scene.scene_no}`, () => call<Record<string, unknown>>(
        "video.whiteboard.lineart",
        {
          filmId,
          sceneNo: scene.scene_no,
          ...(arg("--source") ? { sourcePath: arg("--source") } : {}),
          ...(flag("--force-lineart") ? { force: true } : {}),
        },
      )));
    }
    evidence.artifacts = { ...(evidence.artifacts ?? {}), lineart: linearts };
  }

  if (wants("annotate")) {
    const sceneNo = arg("--scene");
    const targets = sceneNo
      ? [{ scene_no: Number(sceneNo) }]
      : (await call<{ scenes: Array<{ scene_no: number }> }>("video.whiteboard.status", { filmId }, "GET")).scenes;
    const annotations: unknown[] = [];
    for (const scene of targets) {
      annotations.push(await step(`annotate:${scene.scene_no}`, () => call<Record<string, unknown>>(
        "video.whiteboard.annotate", { filmId, sceneNo: scene.scene_no, strict: flag("--strict") },
      )));
    }
    evidence.artifacts = { ...(evidence.artifacts ?? {}), annotate: annotations };
  }

  if (wants("preview")) {
    const status = await call<{ scenes: Array<{ scene_no: number }> }>("video.whiteboard.status", { filmId }, "GET");
    const previews: unknown[] = [];
    for (const scene of status.scenes) {
      previews.push(await step(`preview:${scene.scene_no}`, () => call<Record<string, unknown>>(
        "video.whiteboard.preview", { filmId, sceneNo: scene.scene_no },
      )));
    }
    evidence.artifacts = { ...(evidence.artifacts ?? {}), previews };
  }

  if (wants("render")) {
    const submit = await step("render", () => call<Record<string, unknown>>("video.whiteboard.render", {
      filmId, allowOverage: true,
    }));
    evidence.artifacts = { ...(evidence.artifacts ?? {}), submit };
    console.log(`  job ${(submit as { jobId?: string }).jobId} / task ${(submit as { taskId?: string }).taskId}`);
  }

  if (wants("poll")) {
    const deadline = Date.now() + num("--poll-timeout-ms", 60 * 60_000);
    let done = false;
    let idleRounds = 0;
    while (Date.now() < deadline) {
      const report = await call<{ checked: number; done: number; failed: number; running: number }>(
        "video.whiteboard.poll", { filmId, limit: 5 },
      );
      console.log(`  轮询：checked=${report.checked} done=${report.done} failed=${report.failed} running=${report.running}`);
      if (report.done > 0 || report.failed > 0) {
        evidence.artifacts = { ...(evidence.artifacts ?? {}), poll: report };
        done = true;
        if (report.failed > 0) throw new Error(`渲染失败（failed=${report.failed}）—— 看 video.whiteboard.status 的 error 字段`);
        break;
      }
      /**
       * 没有开放任务时不要空转：`checked=0` 连续两轮说明这一轮**根本没有在跑的任务**
       * （最常见的原因是幂等键命中了上一次失败的任务）。真机踩到：这里会静默轮询一小时。
       */
      if (report.checked === 0) {
        idleRounds += 1;
        if (idleRounds >= 2) {
          const st = await call<{ jobs: Array<{ id: string; status: string; task_id: string | null }> }>(
            "video.whiteboard.status", { filmId }, "GET",
          );
          const last = st.jobs[0];
          throw new Error(
            `没有在跑的渲染任务（poll 连续 2 轮 checked=0）。最近一条任务：`
            + `job=${last?.id ?? "无"} status=${last?.status ?? "无"} task=${last?.task_id ?? "无"}`
            + "——若状态是 failed，说明提交被幂等命中或渲染失败；改过标注后重跑会生成新的内容指纹",
          );
        }
      } else {
        idleRounds = 0;
      }
      await new Promise((r) => setTimeout(r, num("--poll-interval-ms", 5000)));
    }
    if (!done) throw new Error("渲染轮询超时：任务仍未回填（可加大 --poll-timeout-ms 后重跑）");
  }

  if (wants("deliver")) {
    const delivery = await step("deliver", () => call<Record<string, unknown>>("video.whiteboard.deliver", {
      filmId,
      withSubtitle: !flag("--no-subtitle"),
      ...(arg("--title") ? { title: arg("--title") } : {}),
    }));
    evidence.artifacts = { ...(evidence.artifacts ?? {}), delivery };
    console.log(`  成片：${(delivery as { url?: string }).url}`);
  }

  evidence.finishedAt = new Date().toISOString();
  evidence.totalMs = Date.now() - started;
  const evidencePath = resolve(arg("--evidence", `${REPO_ROOT}/var/whiteboard-jobs/evidence-${filmId}.json`));
  mkdirSync(dirname(evidencePath), { recursive: true });
  writeFileSync(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`, "utf8");
  console.log(`\n证据：${evidencePath}`);
  console.log(`总耗时：${(evidence.totalMs / 1000).toFixed(1)}s`);
}

main().catch((err) => {
  console.error(`\n[失败] ${err instanceof Error ? err.message : String(err)}`);
  const evidencePath = resolve(arg("--evidence", `${REPO_ROOT}/var/whiteboard-jobs/evidence-failed.json`));
  mkdirSync(dirname(evidencePath), { recursive: true });
  evidence.finishedAt = new Date().toISOString();
  evidence.totalMs = Date.now() - started;
  writeFileSync(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`, "utf8");
  console.error(`失败证据：${evidencePath}`);
  process.exit(1);
});
