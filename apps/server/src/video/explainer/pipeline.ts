/**
 * explainer/pipeline.ts —— 口播解说片全链路编排（服务端与 CLI 共用同一份实现）· T-2026-0926-0008
 *
 * 环节链（spec §7.3）：
 *   scriptIntake → voiceProduce → voiceTrim? → align → semantics → shotbook →
 *   assemble → preflight → render → machineGates → deliver
 *
 * 为什么服务端与 CLI 共用：**同一份代码在两边跑**，才不会出现"演示能过、生产跑偏"。
 * 差异只在装配面（LLM 来源 / 档案句柄 / 媒资库句柄），由 input 注入。
 */
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { LlmCall } from "./semantics.js";
import { alignTimestamps, verifyTimingParity } from "./asr-aligner.js";
import { deliverFilm, type DeliverResult } from "./deliver.js";
import { buildCardRegistry, type CardRegistry } from "./card-registry.js";
import { engineDirOf, jobsDirOf } from "./engine.js";
import { buildProject, templateDirOf, type BuildProjectResult } from "./project-builder.js";
import { runMachineGates } from "./qa-gates.js";
import { RemotionProvider, probeRenderedSize, readJobState } from "./remotion-provider.js";
import { annotateSemantics } from "./semantics.js";
import { generateShotbook, validateShotbook } from "./shotbook.js";
import { shotbookFromPlan, type ShotPlan } from "./shotbook.js";
import { prepareVoice, probeDurationSec, textFingerprint } from "./voice-prep.js";
import {
  assertSpokenNumbers, explainerOutputSize, ExplainerScriptSchema, SemanticsFileSchema, type ExplainerQuality, type ExplainerScript,
  type ExplainerShotbook, type QaReport, type SemanticsFile, type TimestampsFile,
} from "./types.js";

export type ExplainerStageId =
  | "scriptIntake" | "voiceProduce" | "voiceTrim" | "align" | "semantics" | "shotbook"
  | "assemble" | "preflight" | "render" | "machineGates" | "deliver";

export interface StageEvent {
  stageId: ExplainerStageId;
  status: "running" | "done" | "failed" | "skipped";
  output?: Record<string, unknown>;
  errorClass?: string | null;
  errorMsg?: string | null;
  cost?: Record<string, unknown>;
}

export type StageHook = (event: StageEvent) => Promise<void> | void;

export interface ExplainerRunInput {
  /** 任务 id（= 工程目录名；渲染 provider 的 task_id 也用它） */
  taskId: string;
  /* ---------- 数据层输入 ---------- */
  script: ExplainerScript;
  /** 已有分镜（返修/复跑时给）；缺省由 shotbook 生成器产出 */
  shotbook?: ExplainerShotbook;
  /** 导演手写计划（句号分组；时间由 timestamps 换算）——与 shotbook 二选一 */
  shotbookPlan?: ShotPlan;
  semantics?: SemanticsFile;
  /** 已有配音（上传/返修）；缺省按 voice.source 生成 */
  audioPath?: string;
  voice?: {
    source: "tts" | "upload";
    profile?: string;
    uploadPath?: string;
    confirmed?: boolean;
  };
  /* ---------- 装配面 ---------- */
  aspect?: "9:16" | "16:9";
  quality?: ExplainerQuality;
  brand?: { product: string; tone: string; accent?: string; base?: string; ink?: string };
  hostAssets?: Record<string, string>;
  assets?: Array<{ from: string; to: string }>;
  baselineHost?: string | null;
  llm?: LlmCall;
  allowRuleShotbook?: boolean;
  engineDir?: string;
  templateDir?: string;
  jobDir?: string;
  env?: NodeJS.ProcessEnv;
  onLog?: (line: string) => void;
  onStage?: StageHook;
  /** 渲染范围（返修：changed:<shotId>）；首渲 full */
  renderScope?: string;
  /**
   * 断点续跑：`"render"` = 已有 `out/v1.mp4` 时跳过渲染，直接跑机器闸与交付。
   * 场景：渲染已完成但后续步骤（闸/交付）中断，或渲染进程被外部杀掉——
   * 段缓存与成片都在盘上，重渲一次要十几分钟，没必要（talkcraft 断点纪律的同构落地）。
   */
  resumeFrom?: "render";
  /** 只渲染不交付（首镜先做先确认 / 单镜返修预览） */
  stopAfterRender?: boolean;
  /** 只做到装配段（服务端 submit 用：渲染由 submitGenJob + render-poller 接管） */
  stopAfterAssemble?: boolean;
}

export interface ExplainerRunOutput {
  taskId: string;
  jobDir: string;
  shotbook: ExplainerShotbook;
  timestamps: TimestampsFile;
  semantics: SemanticsFile;
  build: BuildProjectResult;
  renderVideoPath: string;
  qa: QaReport;
  delivery: DeliverResult | null;
  cards: CardRegistry;
  voice: { source: string; sha256: string; durationSec: number | null };
}

export async function runExplainerPipeline(input: ExplainerRunInput): Promise<ExplainerRunOutput> {
  const env = input.env ?? process.env;
  const log = input.onLog ?? (() => undefined);
  const engineDir = input.engineDir ?? engineDirOf(env);
  const templateDir = input.templateDir ?? templateDirOf();
  const quality = input.quality ?? "hd";
  const aspect = input.aspect ?? "9:16";
  const script = ExplainerScriptSchema.parse(input.script);
  for (const sentence of script.sentences) assertSpokenNumbers(sentence.text);
  const jobDir = input.jobDir ?? join(jobsDirOf(env), input.taskId);
  mkdirSync(jobDir, { recursive: true });
  const stage = async (event: StageEvent): Promise<void> => {
    log(`[stage] ${event.stageId} ${event.status}${event.errorMsg ? `：${event.errorMsg}` : ""}`);
    await input.onStage?.(event);
  };

  /* ---------- ① 口播稿入档 ---------- */
  await stage({ stageId: "scriptIntake", status: "running" });
  const scriptPath = join(jobDir, "script.json");
  writeFileSync(scriptPath, JSON.stringify(script, null, 1));
  writeFileSync(join(jobDir, "script.txt"), `${script.sentences.map((s) => s.text).join("\n")}\n`, "utf8");
  const scriptSha = textFingerprint(script.sentences.map((s) => s.text).join(""));
  await stage({ stageId: "scriptIntake", status: "done", output: { sentences: script.sentences.length, sha256: scriptSha } });

  /* ---------- ② 配音 ---------- */
  let audioPath = input.audioPath ?? null;
  let voiceRef: { source: string; sha256: string; durationSec: number | null; profile: string | null; trimReportPath: string | null } =
    { source: "external", sha256: "", durationSec: null, profile: null, trimReportPath: null };
  if (audioPath && existsSync(audioPath)) {
    const duration = await probeDurationSec(audioPath, env);
    voiceRef = { source: "external", sha256: textFingerprint(`${audioPath}:${duration ?? 0}`), durationSec: duration, profile: null, trimReportPath: null };
  } else {
    const voice = input.voice ?? { source: "tts" as const };
    await stage({ stageId: "voiceProduce", status: "running", output: { source: voice.source } });
    const prepared = await prepareVoice({
      text: script.sentences.map((s) => s.text).join("\n"),
      jobDir,
      source: voice.source,
      profile: voice.profile,
      uploadPath: voice.uploadPath,
      confirmed: voice.confirmed,
      env,
      onLog: log,
    });
    audioPath = prepared.audioPath;
    voiceRef = {
      source: prepared.source, sha256: prepared.sha256, durationSec: prepared.durationSec,
      profile: prepared.profile, trimReportPath: prepared.trimReportPath,
    };
    await stage({
      stageId: "voiceProduce", status: "done",
      output: { source: prepared.source, profile: prepared.profile, seconds: prepared.durationSec, sha256: prepared.sha256, lufs: prepared.lufs },
    });
    if (prepared.source === "upload") {
      await stage({
        stageId: "voiceTrim", status: "done",
        output: { report: prepared.trimReportPath, trimmed: prepared.trimmed },
      });
    } else {
      await stage({ stageId: "voiceTrim", status: "skipped", output: { reason: "TTS 产物无口水词与重说，预剪只会压气口（spec §6.3）" } });
    }
  }
  if (!audioPath) throw new Error("没有可用配音（voice.source 既非 tts 也无 uploadPath）");

  /* ---------- ③ 字级时间戳 ---------- */
  await stage({ stageId: "align", status: "running" });
  const align = await alignTimestamps({ script, audioPath, jobDir, env, onLog: log });
  await stage({
    stageId: "align", status: "done",
    output: {
      backend: align.backend, precision: align.precision, seconds: align.total,
      lowMatch: align.lowMatch, sentences: align.timestamps.sentences.length,
    },
  });
  if (align.lowMatch.length > 0) {
    log(`[align] ${align.lowMatch.length} 句 match<0.90（需人工听核）：${align.lowMatch.join("、")}`);
  }

  /* ---------- ④ 语义标注 ---------- */
  await stage({ stageId: "semantics", status: "running" });
  const semanticsResult = input.semantics
    ? { semantics: SemanticsFileSchema.parse(input.semantics), via: "provided" as const, reason: null }
    : await annotateSemantics({ script, timestamps: align.timestamps, llm: input.llm, onLog: log });
  writeFileSync(join(jobDir, "semantics.json"), JSON.stringify(semanticsResult.semantics, null, 1));
  await stage({ stageId: "semantics", status: "done", output: { via: semanticsResult.via, reason: semanticsResult.reason } });

  /* ---------- ⑤ 卡注册表 + SHOTBOOK ---------- */
  const whitelistPath = join(templateDir, "cards.whitelist.json");
  const whitelist = existsSync(whitelistPath)
    ? (JSON.parse(readFileSync(whitelistPath, "utf8")) as { slugs: string[] }).slugs
    : [];
  const registry = buildCardRegistry(engineDir, { whitelist });
  await stage({ stageId: "shotbook", status: "running" });
  let shotbook: ExplainerShotbook;
  let shotbookVia: string;
  let shotbookFailures: string[] = [];
  if (input.shotbook) {
    shotbook = input.shotbook;
    shotbookVia = "provided";
  } else if (input.shotbookPlan) {
    shotbook = shotbookFromPlan(input.shotbookPlan, script, align.timestamps, {
      product: input.brand?.product ?? "WorkLoom",
      tone: input.brand?.tone,
      palette: input.brand
        ? { base: input.brand.base ?? "#0B1020", accent: input.brand.accent ?? "#7A5AF8", ink: input.brand.ink ?? "#F5F7FF" }
        : undefined,
    });
    shotbookVia = "plan";
  } else {
    const generated = await generateShotbook({
      script, timestamps: align.timestamps, semantics: semanticsResult.semantics, registry,
      engineDir, llm: input.llm, aspect: input.aspect ?? "9:16", brand: input.brand,
      fallback: input.allowRuleShotbook ? "rule" : "error",
      maxSeconds: Number(env.TALKCRAFT_MAX_SECONDS ?? 600),
      onLog: log,
    });
    shotbook = generated.shotbook;
    shotbookVia = generated.via;
    shotbookFailures = generated.failures;
  }
  const check = validateShotbook({
    shotbook, script, timestamps: align.timestamps, registry, engineDir,
    publicDir: null, maxSeconds: Number(env.TALKCRAFT_MAX_SECONDS ?? 600),
  });
  if (!check.ok) throw new Error(`SHOTBOOK 校验失败：${check.errors.map((e) => `${e.shotId ?? "-"}:${e.message}`).join("；").slice(0, 700)}`);
  writeFileSync(join(jobDir, "shotbook.json"), JSON.stringify(shotbook, null, 1));
  writeFileSync(join(jobDir, "SHOTBOOK.md"), renderShotbookMarkdown(shotbook, align.timestamps));
  await stage({
    stageId: "shotbook", status: "done",
    output: { via: shotbookVia, shots: shotbook.shots.length, cards: [...new Set(shotbook.shots.map((s) => s.card))], warnings: check.warnings.length, failures: shotbookFailures.slice(-1) },
  });

  /* ---------- ⑥ 工程装配 ---------- */
  await stage({ stageId: "assemble", status: "running" });
  const build = buildProject({
    jobDir, engineDir, templateDir, script, timestamps: align.timestamps, semantics: semanticsResult.semantics,
    shotbook, audioPath, aspect, quality, hostAssets: input.hostAssets,
    assets: input.assets, onLog: log,
  });
  await stage({
    stageId: "assemble", status: "done",
    output: { scenes: build.scenes, cards: build.cards, hostSrc: Object.values(build.hostSrcByShot).filter(Boolean).length, sfx: build.sfxFiles.length, quality, ...explainerOutputSize(aspect, quality) },
  });

  /* ---------- ⑦ 素材体检（preflight --media-only） ---------- */
  await stage({ stageId: "preflight", status: "running" });
  /**
   * preflight 的 `--host` 只给**唇形同步级人物素材**（真实拍摄/生成的说话人视频）：
   * 引擎会断言"人物素材时长 == 配音时长（±1 帧）"——本引擎的人物窗用的是**定妆照驱动的循环底板**
   * （12s 极缓推近，模板里 `<Loop>` 复用），时长天然不匹配，套用该断言等于把"底板"误判成"说话人"。
   * 因此：只有调用方显式给了 baselineHost（真人物素材）才传 `--host`；底板的存在与来源由
   * `sources.md` 素材台账 + 机器闸 `motion_check --anchors` 承担。
   */
  const hostFromProject = Object.values(build.hostSrcByShot).find((rel): rel is string => Boolean(rel));
  if (hostFromProject && !input.baselineHost) {
    log(`[preflight] 人物为底板（${hostFromProject}，非唇形同步素材）→ 不传 --host（引擎该断言仅适用说话人素材）`);
  }
  const baselineHost = input.baselineHost ?? null;
  const preflight = await runPreflight({ jobDir, engineDir, env, baselineHost, onLog: log });
  await stage({
    stageId: "preflight", status: preflight.ok ? "done" : "failed",
    output: { summary: preflight.summary },
    errorClass: preflight.ok ? null : "PREFLIGHT_FAILED",
    errorMsg: preflight.ok ? null : preflight.summary,
  });
  if (!preflight.ok) throw new Error(`素材体检未过：${preflight.summary}`);

  if (input.stopAfterAssemble) {
    // 服务端路径：准备段到此为止，渲染交给 submitGenJob + render-poller（不另起第二条渲染/轮询实现）
    return {
      taskId: input.taskId,
      jobDir,
      shotbook,
      timestamps: align.timestamps,
      semantics: semanticsResult.semantics,
      build,
      renderVideoPath: "",
      qa: { jobId: jobDir, totalFrames: null, gates: [], pass: false },
      delivery: null,
      cards: registry,
      voice: { source: voiceRef.source, sha256: voiceRef.sha256, durationSec: voiceRef.durationSec },
    };
  }

  /* ---------- ⑧ 渲染（真实 provider 路径） ---------- */
  await stage({ stageId: "render", status: "running", output: { scope: input.renderScope ?? "full" } });
  const provider = new RemotionProvider({ env });
  const audioSeconds = align.total;
  const renderedPath = join(jobDir, "out", "v1.mp4");
  let canResume = false;
  if (input.resumeFrom === "render" && existsSync(renderedPath)) {
    const expected = explainerOutputSize(aspect, quality);
    try {
      const actual = await probeRenderedSize(renderedPath, env);
      canResume = actual.width === expected.width && actual.height === expected.height;
      if (!canResume) log(`[render] 已有成片尺寸 ${actual.width}×${actual.height} 与 ${expected.width}×${expected.height} 不符 → 重新渲染`);
    } catch (err) {
      log(`[render] 已有成片尺寸无法核验（${err instanceof Error ? err.message : String(err)}）→ 重新渲染`);
    }
  }
  const polled = canResume
    ? { status: "succeeded" as const, uri: renderedPath, error: undefined as string | undefined }
    : await (async () => {
        const submitted = await provider.submit({
          prompt: script.sentences.map((s) => s.text).join(""),
          estimatedUnits: Math.round(audioSeconds),
          refId: input.taskId,
          params: { jobDir, audioSeconds, scope: input.renderScope ?? "full", providerModel: "remotion-4.0.519" },
        });
        return await pollUntilDone(provider, submitted.taskId, jobDir, {
          log,
          timeoutMs: Number(env.TALKCRAFT_RENDER_TIMEOUT_MS ?? 3_600_000),
        });
      })();
  if (canResume) log(`[render] 断点续跑：复用已在盘的成片 ${renderedPath}（跳过渲染）`);
  if (polled.status !== "succeeded" || !polled.uri) {
    await stage({ stageId: "render", status: "failed", errorClass: "RENDER_FAILED", errorMsg: polled.error ?? "渲染失败" });
    throw new Error(`渲染失败：${polled.error ?? "未知原因"}`);
  }
  await stage({ stageId: "render", status: "done", output: { video: polled.uri, frames: null, resumed: canResume } });

  /* ---------- ⑨ 机器闸六条 ---------- */
  await stage({ stageId: "machineGates", status: "running" });
  const { report } = await runMachineGates({
    jobDir, cards: build.cards, cueCount: build.sfxFiles.length > 0 ? countCues(build) : 0,
    baseline: input.baselineHost ?? null, engineDir, env, onLog: log,
    aspect,
    quality,
    shots: JSON.parse(readFileSync(build.shotsPath, "utf8")) as Array<{ id: string; start: number; end: number }>,
  });
  await stage({
    stageId: "machineGates", status: report.pass ? "done" : "failed",
    output: { gates: report.gates.map((g) => ({ gate: g.gate, status: g.status, summary: g.summary })) },
    errorClass: report.pass ? null : "QA_GATE_FAILED",
    errorMsg: report.pass ? null : report.gates.filter((g) => g.status === "fail").map((g) => `${g.gate}:${g.summary}`).join("；").slice(0, 400),
  });
  if (!report.pass) {
    throw new Error(`机器闸未过（P0 级禁止交付）：${report.gates.filter((g) => g.status === "fail").map((g) => g.gate).join("、")}`);
  }

  /* ---------- ⑩ 交付（两遍 loudnorm） ---------- */
  let delivery: DeliverResult | null = null;
  if (!input.stopAfterRender) {
    await stage({ stageId: "deliver", status: "running" });
    delivery = await deliverFilm({ jobDir, env, onLog: log });
    await stage({
      stageId: "deliver", status: "done",
      output: { path: delivery.deliveryPath, sha256: delivery.sha256, bytes: delivery.bytes, loudnorm: delivery.measurement },
    });
  } else {
    await stage({ stageId: "deliver", status: "skipped", output: { reason: "stopAfterRender（首镜确认/返修预览）" } });
  }

  return {
    taskId: input.taskId,
    jobDir,
    shotbook,
    timestamps: align.timestamps,
    semantics: semanticsResult.semantics,
    build,
    renderVideoPath: polled.uri,
    qa: report,
    delivery,
    cards: registry,
    voice: { source: voiceRef.source, sha256: voiceRef.sha256, durationSec: voiceRef.durationSec },
  };
}

async function pollUntilDone(
  provider: RemotionProvider,
  taskId: string,
  jobDir: string,
  opts: { log: (line: string) => void; timeoutMs: number },
): Promise<{ status: string; uri?: string; error?: string }> {
  const started = Date.now();
  let lastLog = "";
  let missingStatePolls = 0;
  for (;;) {
    const state = readJobState(jobDir);
    if (state?.logTail && state.logTail !== lastLog) {
      lastLog = state.logTail;
      const lastLine = lastLog.split("\n").filter(Boolean).slice(-1)[0];
      if (lastLine) opts.log(`[render] ${lastLine.slice(0, 200)}`);
    }
    const result = await provider.poll(taskId);
    if (result.status === "succeeded" || result.status === "failed") return result;
    /**
     * 快速失败：状态文件一直找不到 = taskId 与任务目录不匹配（装配错误），
     * 不能让它伪装成"仍在渲染"干等到 60 分钟超时（真机事故：渲染 10 分钟就完了，CLI 等了 1 小时）。
     */
    if (result.error?.includes("状态文件尚未落盘")) {
      missingStatePolls += 1;
      if (missingStatePolls > 15) {
        return { status: "failed", error: `${result.error}（连续 ${missingStatePolls} 次）——taskId 与任务目录不匹配，检查 provider 的 jobDir 指针` };
      }
    } else {
      missingStatePolls = 0;
    }
    if (Date.now() - started > opts.timeoutMs) return { status: "failed", error: `渲染超时（${Math.round(opts.timeoutMs / 60000)}min）` };
    await new Promise((r) => setTimeout(r, 2000));
  }
}

function countCues(build: BuildProjectResult): number {
  const raw = readFileSync(build.cuesPath, "utf8");
  return (JSON.parse(raw) as unknown[]).length;
}

/** 素材体检：引擎 preflight.py --media-only（有 host 素材才给 --host） */
export async function runPreflight(input: {
  jobDir: string;
  engineDir: string;
  env: NodeJS.ProcessEnv;
  baselineHost: string | null;
  onLog?: (line: string) => void;
}): Promise<{ ok: boolean; summary: string }> {
  const { resolvePython } = await import("./asr-aligner.js");
  const args = [
    join(input.engineDir, "scripts/preflight.py"),
    "--project", input.jobDir,
    "--media-only",
    "--fps", "30",
    "--voice", join(input.jobDir, "audio", "full.wav"),
  ];
  if (input.baselineHost && existsSync(input.baselineHost)) args.push("--host", input.baselineHost);
  const r = await new Promise<{ code: number; stdout: string; stderr: string }>((resolve, reject) => {
    const child = spawn(resolvePython(input.env), args, { cwd: input.jobDir, env: input.env, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => { child.kill("SIGKILL"); reject(new Error("preflight 超时")); }, 300_000);
    child.stdout.on("data", (d) => { stdout += String(d); });
    child.stderr.on("data", (d) => { stderr += String(d); });
    child.on("error", (e) => { clearTimeout(timer); reject(e); });
    child.on("exit", (code) => { clearTimeout(timer); resolve({ code: code ?? -1, stdout, stderr }); });
  });
  const text = `${r.stdout}\n${r.stderr}`;
  for (const line of text.split("\n")) if (line.trim()) input.onLog?.(line.trim());
  const failLine = text.split("\n").find((l) => l.includes("FAIL")) ?? "";
  return { ok: r.code === 0, summary: r.code === 0 ? "素材体检通过（preflight --media-only）" : (failLine || `preflight 退出码 ${r.code}`).slice(0, 300) };
}

/** markdown 版 SHOTBOOK（进档案供人读；结构化版本才是机器事实源） */
export function renderShotbookMarkdown(shotbook: ExplainerShotbook, timestamps: TimestampsFile): string {
  const lines: string[] = [];
  lines.push("# SHOTBOOK（口播解说片 · 层矩阵结构化分镜的可读版）", "");
  lines.push("## §0 全局系统（G0 风格档）", "");
  lines.push(`- 领域：${shotbook.style.domain}`);
  lines.push(`- 语气：${shotbook.style.tone}`);
  lines.push(`- 配色：base ${shotbook.style.palette.base} / accent ${shotbook.style.palette.accent} / ink ${shotbook.style.palette.ink}`);
  lines.push(`- 字体：${shotbook.style.font}`);
  lines.push(`- 能量档：${shotbook.style.energy}`);
  lines.push("");
  lines.push("### 版式节奏表", "");
  lines.push("| 镜 | 人物形态·方位 | 素材容器 | 主卡 |");
  lines.push("|---|---|---|---|");
  for (const row of shotbook.rhythmTable) lines.push(`| ${row.shotId} | ${row.hostForm} | ${row.container} | ${row.card} |`);
  lines.push("");
  lines.push("## §1 逐镜头层矩阵", "");
  for (const shot of shotbook.shots) {
    lines.push(`### ${shot.id} · ${shot.card} · ${shot.start.toFixed(2)}–${shot.end.toFixed(2)}s`, "");
    lines.push(`- 口播：${shot.text}`);
    lines.push(`- 素材：${shot.material.kind}${shot.material.ref ? `（${shot.material.ref}）` : ""}`);
    lines.push(`- 内容补丁：consts=${Object.keys(shot.content).join(",") || "无"} · replaces=${shot.replace.length}`);
    lines.push(`- 蒙皮：${Object.entries(shot.skin).map(([k, v]) => `${k}=${v}`).join(" ") || "按 G0 风格档统一改皮"}`);
    if (shot.sfx.length) lines.push(`- 音效：${shot.sfx.map((c) => `${c.name}@${c.t.toFixed(2)}s(vol ${c.vol})`).join("、")}`);
    if (shot.notes) lines.push(`- 备注：${shot.notes}`);
    lines.push("");
  }
  lines.push("## 未完成 / 未采集清单", "");
  lines.push("- 无（分镜覆盖全部口播稿；素材清单见各镜「素材」行）");
  lines.push("");
  lines.push(`> 配音总长 ${timestamps.total.toFixed(2)}s · ${timestamps.sentences.length} 句 · ${shotbook.shots.length} 镜`);
  return lines.join("\n");
}
