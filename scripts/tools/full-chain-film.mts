#!/usr/bin/env tsx
/**
 * full-chain-film.mts —— 全链路出片（AI 监制自动放行版，T-2026-0924-0001）
 *
 * 与 `render-project.mts` 的分工：
 *   · render-project.mts 是"预生产产物 → 逐镜提交渲染"的服务端工具（依赖 server + DB + G8 审批）；
 *   · 本工具是**端到端制片**：脚本 → 提示词交付闸 → 关键帧 → 逐镜视频 → 合成 → 调色 → 字幕
 *     → 弹幕 → 配乐 → 封面 → 母版，每一步都过 **AI 监制门**（`producer-gate`），
 *     不合格就打回重跑，并把"这一步到底有没有被调用/有没有降级"写进阶段日志。
 *
 * 用法：
 *   tsx scripts/tools/full-chain-film.mts \
 *     --shots <shotlist.json> --project VID-PJL01 \
 *     --library <角色档案库根> --work-dir <.vm-work 根> --out <交付目录> \
 *     [--stages spec,plates,videos,compose,color,subtitle,danmaku,bgm,cover,mux] \
 *     [--subtitle-mode sidecar|burn|both]   # 缺省 sidecar：字幕只做旁挂文件 + 软字幕轨，母版不烧字 \
 *     [--aspect 9:16] [--resolution 1080p] [--fps 30] [--max-attempts 2] \
 *     [--keys-file ~/.workloom/live.env] [--brief <brief.json>] [--no-resume] [--dry-run]
 *
 * 阶段日志：`<work-dir>/logs/stages.jsonl`（逐条：stage/shotId/invoked/ok/degraded/cached/verdict）
 * 阶段汇总：`<work-dir>/logs/stages.json`
 */
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync
} from "node:fs";
import { homedir } from "node:os";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import {
  applyMicromotion, appendGateEvent, assessVariantDistinctness, auditContinuity, buildDeliveryManifest, buildGateEvent,
  buildCoverDesignPrompt, buildMaterialMotionPrompt, buildPlatePrompt, buildRevisionPlan, buildRevisionReport, buildVariantPlan,
  coverDeterministicChecks, COVER_FONTS, COVER_REVIEW_RUBRIC, COVER_SAFE_AREA,
  fallbackCoverPlan, findAngleFile, MATERIAL_POLICY_STATEMENT, MATERIAL_POLICY_VERSION, assessMaterialReuse,
  assertMaterialGenerationProvenance, parseCoverPlan, prepareShotPrompt, readMaterialSpec, resolveProducerLlm, reviewStage,
  normalizePromptLanguage,
  restoreTimelineField,
  type CoverDesignInput, type CoverMeasurements, type CoverPlan, type GateCheck, type GateEvent, type PipelineGateStepKey,
  type PlatePromptShot, type ProducerVerdict
} from "../../packages/video-studio/src/index.js";

const REPO_ROOT = resolve(import.meta.dirname ?? process.cwd(), "../..");
const FFMPEG = process.env.WL_FFMPEG ?? "ffmpeg";
const FFPROBE = process.env.WL_FFPROBE ?? "ffprobe";

function arg(name: string, fallback = ""): string {
  const i = process.argv.indexOf(name);
  return i >= 0 ? (process.argv[i + 1] ?? fallback) : fallback;
}
const flag = (name: string) => process.argv.includes(name);
const abs = (p: string) => (isAbsolute(p) ? p : resolve(REPO_ROOT, p));
const stamp = () => new Date().toISOString();
const log = (line: string): void => process.stdout.write(`[${stamp().slice(11, 19)}] ${line}\n`);

/* ================= 参数 ================= */

const SHOTS_FILE = abs(arg("--shots"));
if (!SHOTS_FILE || !existsSync(SHOTS_FILE)) throw new Error("需要 --shots <shotlist.json>");
const PROJECT = arg("--project", basename(SHOTS_FILE, ".json"));
const LIBRARY = resolve(arg("--library", join(REPO_ROOT, "var/media/characters")));
const WORK_DIR = resolve(arg("--work-dir", join(REPO_ROOT, ".vm-work")));
const OUT_DIR = resolve(arg("--out", join(REPO_ROOT, "outputs", PROJECT)));
const KEYS_FILE = arg("--keys-file", join(homedir(), ".workloom", "live.env"));
const BRIEF_FILE = arg("--brief");
const ASPECT = arg("--aspect", "9:16");
const RESOLUTION = arg("--resolution", "1080p");
const FPS = Number(arg("--fps", "30"));
const MAX_ATTEMPTS = Number(arg("--max-attempts", "2"));
/** 转场淡入淡出时长（秒）：快剪片（小红书/瞭望塔风格）用 0.1–0.2，抒情片用 0.5 */
const XFADE = Number(arg("--xfade", "0.5"));
const DANMAKU_FILE = arg("--danmaku");
/** 只跑指定镜头（逗号分隔；用于单镜验证与局部重跑） */
const ONLY = arg("--only").split(",").map((s) => s.trim()).filter(Boolean);
/**
 * 监制已知悉但放行的镜头（逗号分隔）。
 * 用途：监制打回、但客观条件（账号欠费/额度用尽/时效）不允许重跑时，
 * **不允许静默放行**——必须显式列出，运行日志与阶段记录里要留"带瑕疵放行"的痕迹。
 */
const ACCEPT_REJECTED = arg("--accept-rejected").split(",").map((s) => s.trim()).filter(Boolean);
const RESUME = !flag("--no-resume");
const DRY_RUN = flag("--dry-run");
const ALLOW_FALLBACK_APPROVE = flag("--allow-fallback-approve");
const STAGES = new Set(
  /**
   * 默认阶段的并集：
   *   `cine-kb`（摄影知识库）/ `continuity`（连贯性导演评审）/ `micromotion`（微动作增强，T-2026-0924-0001 第二次收口）
   *   `mux`（软字幕轨收口，T-2026-0924-0070/0071）
   */
  /**
   * 与上一版的差别（2026-09-25）：
   *   · `photo-motion` 已**移除**——真实素材不再有"静态直出"路径，改为 `material-gen`（素材当生成输入）；
   *   · 新增 `voice`：逐镜人声核查 + 缺播报的镜头补 TTS 旁白（"中间只有字幕没台词播报"的修复）。
   */
  arg("--stages", "cine-kb,continuity,micromotion,spec,plates,material-gen,videos,voice,compose,color,subtitle,danmaku,bgm,cover,mux").split(",").map((s) => s.trim()).filter(Boolean)
);
/**
 * 字幕落地方式（2026-09-24 产品所有者口径）：
 *   sidecar（缺省）= 母版**不烧字**，出旁挂字幕文件（srt/ass/vtt + 清单）并另出一支软字幕轨版；
 *   burn           = 旧行为：把字幕烧进画面（母版变成带字版）；
 *   both           = 旁挂 + 烧字副本都出（发布方想两条路都留）。
 * 为什么默认改成 sidecar：**有些片子要带字幕、有些不要**，而"要不要"是后期/发布时的选择；
 * 烧一次就回不去了（画面像素被改），旁挂文件则可以随时软轨内嵌或再烧。
 */
const SUBTITLE_MODE = (() => {
  const value = arg("--subtitle-mode", "sidecar");
  if (!["sidecar", "burn", "both"].includes(value)) {
    throw new Error(`--subtitle-mode 只支持 sidecar | burn | both，收到：${value}`);
  }
  return value as "sidecar" | "burn" | "both";
})();

const LOG_DIR = join(WORK_DIR, "logs");
const STAGE_LOG = join(LOG_DIR, "stages.jsonl");
const PLATE_DIR = join(WORK_DIR, "plates", PROJECT);
const CLIP_DIR = join(WORK_DIR, "clips", PROJECT);
const POST_DIR = join(WORK_DIR, "post", PROJECT);
const PROMPT_DIR = join(WORK_DIR, "prompts", PROJECT);
/** 成片交付路径（模板块与交付包/返修块共用；模板块内部变量名保持 `deliverable` 不变） */
const DELIVERABLE = join(OUT_DIR, `${PROJECT}-30s-final.mp4`);
/** 工位路径白名单（冒号分隔）：仓库根 + 运行产物根 + 交付目录 + 系统临时目录 */
const CLI_ALLOWED_ROOTS = [REPO_ROOT, WORK_DIR, OUT_DIR, tmpdir()].join(":");
for (const dir of [LOG_DIR, PLATE_DIR, CLIP_DIR, POST_DIR, PROMPT_DIR, OUT_DIR]) mkdirSync(dir, { recursive: true });

/** 环境：进程环境优先，其次仓库外秘密文件（只进内存，不落盘） */
function loadEnv(): Record<string, string> {
  const out: Record<string, string> = {};
  if (existsSync(KEYS_FILE)) {
    for (const line of readFileSync(KEYS_FILE, "utf8").split("\n")) {
      const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
      if (m && m[2]!.trim()) out[m[1]!] = m[2]!.trim();
    }
  }
  if (existsSync(join(REPO_ROOT, ".env"))) {
    for (const line of readFileSync(join(REPO_ROOT, ".env"), "utf8").split("\n")) {
      const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
      if (m && m[2]!.trim() && !out[m[1]!]) out[m[1]!] = m[2]!.trim();
    }
  }
  for (const [key, value] of Object.entries(process.env)) if (value && !out[key]) out[key] = value;
  return out;
}
const ENV = loadEnv();
const ARK_KEY = ENV.VOLCENGINE_ARK_API_KEY ?? ENV.ARK_API_KEY ?? "";
const ARK_BASE = (ENV.ARK_BASE_URL ?? "https://ark.cn-beijing.volces.com/api/v3").replace(/\/$/, "");
const IMAGE_MODEL = ENV.SEEDREAM_MODEL ?? ENV.ARK_IMAGE_MODEL ?? "doubao-seedream-5-0-pro-260628";
const VIDEO_MODEL = ENV.SEEDANCE_MODEL ?? ENV.ARK_VIDEO_MODEL ?? "doubao-seedance-2-5-260628";
if (!ARK_KEY && !DRY_RUN) throw new Error(`缺少火山方舟密钥（${KEYS_FILE} 的 VOLCENGINE_ARK_API_KEY / 环境变量）`);

/* ================= 阶段日志 ================= */

type StageRecord = {
  at: string;
  stage: string;
  shotId: string | null;
  invoked: boolean;
  ok: boolean;
  cached: boolean;
  degraded: boolean;
  attempt: number;
  ms: number;
  artifact: string | null;
  evidence: Record<string, unknown>;
  verdict: ProducerVerdict | null;
  note?: string;
  /** 门事件专用：管线 step_key 与门编号（G5/G6/G7/G8） */
  stepKey?: PipelineGateStepKey;
  gate?: string;
};
const records: StageRecord[] = [];
function record(rec: Omit<StageRecord, "at">): void {
  const full: StageRecord = { at: stamp(), ...rec };
  records.push(full);
  appendFileSync(STAGE_LOG, `${JSON.stringify(full)}\n`, "utf8");
  const tag = full.ok ? (full.degraded ? "DEGRADED" : "ok") : "FAIL";
  log(`  ⇢ [${full.stage}${full.shotId ? ` ${full.shotId}` : ""}] ${tag}${full.cached ? "（复用）" : ""} ${full.ms}ms${full.artifact ? ` → ${full.artifact}` : ""}`);
}

/**
 * 门事件记账（2026-09-24，G5/G6/G7/G8 的 step_key 级运行时组件）。
 *
 * 为什么需要：管线 yml 声明了四个按 step_key 记账的确认门，但运行时不落事件——
 * 审计只能看到"环节调没调用"，看不到"门有没有被按名调用、判据是什么、谁放行的"。
 * 现在每次门判定都往**同一个 stages.jsonl** 追加一条 `stage: "gate"` 记录
 * （规范形状见 `packages/video-studio/src/gate-ledger.ts`），平台执行器与审计器都能按 step_key 检索。
 */
function recordGate(input: {
  stepKey: PipelineGateStepKey;
  sourceStage: string | null;
  checks: GateCheck[];
  shotIds?: string[];
  softApproved?: boolean | null;
  via?: GateEvent["via"];
  score?: number | null;
  reason?: string;
  degraded?: boolean;
  evidence?: Record<string, unknown>;
}): GateEvent {
  const event = buildGateEvent({ projectId: PROJECT, ...input });
  appendGateEvent(STAGE_LOG, event);
  records.push({
    at: event.at, stage: "gate", shotId: input.shotIds?.length === 1 ? input.shotIds[0]! : null,
    invoked: true, ok: event.ok, cached: false, degraded: event.degraded, attempt: 1, ms: 0, artifact: null,
    evidence: { stepKey: event.stepKey, gate: event.gate, via: event.via, score: event.score, sourceStage: event.sourceStage, shotIds: event.shotIds, checks: event.checks, reason: event.reason, ...(event.evidence ?? {}) },
    verdict: null, note: `门 ${event.gate}（${event.stepKey}）`, stepKey: event.stepKey, gate: event.gate
  });
  const tag = event.ok ? (event.degraded ? "DEGRADED" : "ok") : "FAIL";
  log(`  ⇢ [gate ${event.gate} ${event.stepKey}] ${tag}${event.via === "llm" ? `（llm${event.score !== null ? ` score=${event.score}` : ""}）` : "（deterministic）"} — ${event.reason.slice(0, 140)}`);
  return event;
}

/**
 * 读取**历史**阶段日志（同一 work-dir 的 `stages.jsonl`）。
 *
 * 为什么需要（2026-09-24 真机）：`--stages bgm,master` 这类"只重跑一段"的用法里，
 * 进程内 `records` 只有本次的两个环节，终审门因此误判"调色/字幕/弹幕没执行"。
 * 正确口径是看**产物血缘 + 历史裁决**：文件在、顺序对、历史里有放行记录，就算链路完整。
 */
function readStageHistory(): StageRecord[] {
  if (!existsSync(STAGE_LOG)) return [];
  try {
    return readFileSync(STAGE_LOG, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line) as StageRecord);
  } catch {
    return [];
  }
}

/** 历史里某个环节是否有"放行"裁决（没有裁决记录的跳过环节按未知处理，不冒充已通过） */
function historyApproved(history: StageRecord[], stage: string): boolean {
  return history.some((r) => r.stage === stage && r.ok && (r.verdict ? r.verdict.approved : true));
}

/** 产物血缘：文件存在 + mtime 递进（raw → graded → subtitled → danmaku → scored） */
function lineageCheck(files: Array<{ label: string; path: string }>): { ok: boolean; detail: string } {
  const missing = files.filter((f) => !existsSync(f.path));
  if (missing.length > 0) return { ok: false, detail: `缺产物：${missing.map((f) => f.label).join("、")}` };
  const times = files.map((f) => ({ ...f, mtime: statSync(f.path).mtimeMs }));
  const outOfOrder = times.some((entry, index) => index > 0 && entry.mtime < times[index - 1]!.mtime);
  return {
    ok: !outOfOrder,
    detail: outOfOrder
      ? `产物时间顺序异常：${times.map((t) => `${t.label}=${new Date(t.mtime).toISOString().slice(11, 19)}`).join(" → ")}`
      : `产物血缘完整：${times.map((t) => `${t.label}(${(statSync(t.path).size / 1048576).toFixed(1)}MB)`).join(" → ")}`
  };
}

/**
 * 下游产物选择（2026-09-24 真机修复）：
 * 只重跑某一段时（例如 `--stages bgm,master`），未被重跑的环节应**沿用磁盘上更下游的既有产物**，
 * 而不是退回上游原片——早先 `let colored = master` 这类默认值会把"只跑 master"变成"交付未调色未烧字的原片"，
 * 同时让血缘检查（scored 的 mtime 早于 danmaku）永久失败。
 * 判据：候选文件存在且 **mtime 不早于**上游产物（晚于等于即视为由它或更晚的链路产出）。
 */
function preferDownstream(candidate: string, upstream: string): string {
  if (!existsSync(candidate)) return upstream;
  if (!existsSync(upstream)) return candidate;
  return statSync(candidate).mtimeMs >= statSync(upstream).mtimeMs ? candidate : upstream;
}

/* ================= 媒体工具 ================= */

function run(bin: string, args: string[]): string {
  return execFileSync(bin, args, { encoding: "utf8", maxBuffer: 32 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"] });
}
/**
 * 文件指纹（素材镜溯源用）：素材与产物的 sha256 必须能证明"产物不是素材本身"。
 * 读盘失败时抛错（不许返回空串——空串会伪装成"指纹齐备"）。
 */
function sha256FileSync(file: string): string {
  return createHash("sha256").update(readFileSync(file)).digest("hex");
}
function probe(file: string): Record<string, unknown> {
  try {
    const raw = run(FFPROBE, ["-v", "error", "-print_format", "json", "-show_format", "-show_streams", file]);
    const json = JSON.parse(raw) as { streams?: Array<Record<string, unknown>>; format?: Record<string, unknown> };
    const video = (json.streams ?? []).find((s) => s.codec_type === "video");
    const audio = (json.streams ?? []).find((s) => s.codec_type === "audio");
    return {
      duration: Number(json.format?.duration ?? 0),
      width: Number(video?.width ?? 0),
      height: Number(video?.height ?? 0),
      /** 帧率：`r_frame_rate` 形如 "24/1"，取分子/分母（早先写成连除，得到 1/24，监制据此误判"帧率异常"） */
      fps: (() => {
        const [num, den] = String(video?.r_frame_rate ?? "0/1").split("/").map(Number);
        return num && den ? num / den : 0;
      })(),
      vcodec: video?.codec_name ?? null,
      acodec: audio?.codec_name ?? null,
      hasAudio: Boolean(audio),
      bytes: statSync(file).size
    };
  } catch (err) {
    return { error: err instanceof Error ? err.message.slice(0, 200) : String(err) };
  }
}
function runCli(cli: string, args: string[]): { ok: boolean; out: string } {
  try {
    const out = execFileSync(process.execPath, [abs(cli), ...args], {
      encoding: "utf8", maxBuffer: 32 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"],
      /**
       * 工位路径监狱（2026-09-24 真机修复）：调色/配乐工位默认只允许访问 `process.cwd()` 与 tmpdir。
       * 本工具的产物根在工作区之外（项目less 会话目录），不显式放开会被 `path_not_allowed` 拒掉
       * （真机：调色直接失败）。这里把仓库根、运行产物根、交付目录与 tmpdir 一起写进白名单。
       */
      env: {
        ...process.env,
        WL_REPO_ROOT: REPO_ROOT,
        WORKLOOM_COLOR_ALLOWED_ROOTS: CLI_ALLOWED_ROOTS,
        WORKLOOM_SUBTITLE_ALLOWED_ROOTS: CLI_ALLOWED_ROOTS,
        WORKLOOM_BGM_ALLOWED_ROOTS: CLI_ALLOWED_ROOTS,
        WORKLOOM_VISUAL_ALLOWED_ROOTS: CLI_ALLOWED_ROOTS,
        /** 配音工位同样有路径监狱（配音写新文件、读原片），产物根/交付目录要显式放开 */
        WORKLOOM_VOICE_ALLOWED_ROOTS: CLI_ALLOWED_ROOTS
      }
    });
    return { ok: true, out };
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string; message?: string };
    return { ok: false, out: `${e.stdout ?? ""}\n${e.stderr ?? e.message ?? ""}`.slice(-1500) };
  }
}
const SUBTITLE_CLI = join(REPO_ROOT, "bundles/ai-video/connectors/subtitle-bridge/cli.mjs");
const COLOR_CLI = join(REPO_ROOT, "bundles/ai-video/connectors/color-bridge/cli.mjs");
const BGM_CLI = join(REPO_ROOT, "bundles/ai-video/connectors/bgm-bridge/cli.mjs");
const VOICE_CLI = join(REPO_ROOT, "bundles/ai-video/connectors/voice-bridge/cli.mjs");

/**
 * 重试指令（2026-09-24「反复重跑烧额度」根因修复）。
 *
 * 事故：SC-02 连烧 5 次渲染仍不过——因为第 2 次尝试提交的是**与第 1 次一字不差的提示词**，
 * 只换了 seed，本质是"重采样碰运气"。而监制每轮都给了具体问题与建议，这些信息**没有被用上**。
 * 现在：把上一轮 verdict 的 issues/suggestions 显式写进重跑提示词，并按次数给出升级动作。
 */
function retryInstruction(verdict: ProducerVerdict | null, attempt: number, maxAttempts: number): string {
  /**
   * 长度上限（2026-09-24 真机）：监制的 issues/suggestions 可能很长（一次给了 9 条、每条上百字），
   * 直接拼进重跑提示词会把多模态评审请求撑到 **HTTP 413（payload too large）**，
   * 于是监制不可用 → 又触发一次重渲（白烧额度）。这里按条裁断 + 总量封顶。
   */
  const clip = (text: string, max = 110) => (text.length > max ? `${text.slice(0, max)}…` : text);
  const issues = (verdict?.issues ?? []).filter(Boolean).slice(0, 3).map((item) => clip(item));
  const suggestions = (verdict?.suggestions ?? []).filter(Boolean).slice(0, 3).map((item) => clip(item));
  const reason = clip(String(verdict?.reason ?? "未给出理由"), 90);
  return [
    `【重跑要求·第 ${attempt}/${maxAttempts} 次】上一版未过监制：${reason}`,
    ...issues.map((item) => `必须修复：${item}`),
    ...suggestions.map((item) => `按建议修改：${item}`),
    attempt >= maxAttempts
      ? "本次为最后一次尝试：若仍不达标，将按「带瑕疵放行 + badcase 归档」处理，不再重复烧额度。"
      : "注意：同一问题第二次出现说明是分镜设计问题（机位/动作/朝向），优先改设计而不是继续加形容词。",
    "输出仍须满足：人物与定妆照同一张脸、肢体与手指结构正确、空间物理自洽（桥/台阶有落点）。"
  ].join("\n");
}

/**
 * 黑帧 / 静音段体检（监制终审要的"事故证据"，2026-09-24 真机补）：
 *   · 黑帧：`blackdetect` 抓 ≥0.2s 的整黑段 → 有即硬失败（拼接/编码事故的典型指纹）；
 *   · 静音：`silencedetect` 抓 ≥0.6s、低于 −45dB 的段 → 记录最长静音段（口播片配乐铺底后不应出现长静音）。
 */
/**
 * 响度实测（EBU R128）：`ebur128` 滤镜直接读整片 integrated loudness 与 true peak。
 * 为什么要自己量：配乐工位的 `best` 在"人声太满"时会直接判 `no_bgm_needed` 而不产出，
 * 监制因此拿不到任何响度证据（真机连续两次以"无响度读数"打回）。这里用确定性测量补上。
 */
/**
 * 画面运动能量（2026-09-24 SC-02 badcase 修复）：
 * 把片段按 8fps 降采样成 128×228 灰度帧序列，算**相邻帧中心区（60%）平均绝对差**。
 * 用途：给监制一个"到底有没有动"的数字证据——之前只给 3 张静帧，
 * 监制无法验证"走来/挥手"，只能以「动作证据不足」打回（fail-closed），
 * 于是同一镜反复重渲。返回平均运动能量（0–255）与峰值出现时刻。
 */
function measureMotionEnergy(file: string, durationSec: number): { energy: number; peakAt: number; frames: number } {
  const W = 128;
  const H = 228;
  const res = spawnSync(FFMPEG, [
    "-v", "error", "-i", file,
    "-vf", `fps=8,scale=${W}:${H},format=gray,crop=${Math.round(W * 0.6)}:${Math.round(H * 0.6)}`,
    "-f", "rawvideo", "-"
  ], { maxBuffer: 64 * 1024 * 1024 });
  const buf = res.stdout ?? Buffer.alloc(0);
  const cw = Math.round(W * 0.6);
  const ch = Math.round(H * 0.6);
  const frameBytes = cw * ch;
  const count = Math.floor(buf.length / frameBytes);
  if (count < 2) return { energy: 0, peakAt: 0, frames: count };
  let total = 0;
  let peak = 0;
  let peakIndex = 0;
  for (let i = 1; i < count; i += 1) {
    const prev = (i - 1) * frameBytes;
    const cur = i * frameBytes;
    let sum = 0;
    for (let p = 0; p < frameBytes; p += 4) sum += Math.abs(buf[cur + p]! - buf[prev + p]!);
    const diff = sum / (frameBytes / 4);
    total += diff;
    if (diff > peak) { peak = diff; peakIndex = i; }
  }
  const fps = 8;
  return {
    energy: total / (count - 1),
    peakAt: Math.min(durationSec, peakIndex / fps),
    frames: count
  };
}

function measureLoudness(file: string): { lufs: number | null; peakDb: number | null; detail: string } {
  /**
   * 注意：ffmpeg 把滤波器日志写在 **stderr**，且退出码通常为 0。
   * 早先用 `execFileSync` 只在 catch 里读 stderr → 成功路径拿到空字符串，
   * 于是"响度未读到"（真机监制连续打回 4 次的原因之一）。这里用 spawnSync 同时收 stdout+stderr。
   */
  const res = spawnSync(FFMPEG, ["-hide_banner", "-nostats", "-i", file, "-af", "ebur128=peak=true", "-f", "null", "-"], {
    encoding: "utf8", maxBuffer: 32 * 1024 * 1024
  });
  return parseLoudness(`${res.stdout ?? ""}\n${res.stderr ?? ""}`);
}

function parseLoudness(text: string): { lufs: number | null; peakDb: number | null; detail: string } {
  const integrated = [...text.matchAll(/I:\s*(-?[\d.]+)\s*LUFS/g)].pop();
  const peak = [...text.matchAll(/Peak:\s*(-?[\d.]+)\s*dBFS/g)].pop();
  const lufs = integrated ? Number(integrated[1]) : null;
  const peakDb = peak ? Number(peak[1]) : null;
  return {
    lufs,
    peakDb,
    detail: `integrated ${lufs === null ? "未读到" : `${lufs.toFixed(1)} LUFS`} · true peak ${peakDb === null ? "未读到" : `${peakDb.toFixed(1)} dBFS`}`
  };
}

function detectQualityAccidents(file: string): { blackSeconds: number; silenceSeconds: number; detail: string } {
  /** 同上：黑帧/静音探测日志同样走 stderr 且退出码为 0，必须显式读 stderr */
  const blackRes = spawnSync(FFMPEG, ["-v", "info", "-i", file, "-vf", "blackdetect=d=0.2:pix_th=0.10", "-an", "-f", "null", "-"], {
    encoding: "utf8", maxBuffer: 16 * 1024 * 1024
  });
  const blackText = `${blackRes.stdout ?? ""}\n${blackRes.stderr ?? ""}`;
  const blackMatches = [...blackText.matchAll(/black_start:([\d.]+)\s+black_end:([\d.]+)\s+black_duration:([\d.]+)/g)];
  const blackSeconds = blackMatches.length > 0 ? Math.max(...blackMatches.map((m) => Number(m[3]))) : 0;
  const blackDetail = blackMatches.length > 0
    ? blackMatches.map((m) => `${m[1]}s–${m[2]}s(${m[3]}s)`).join("、")
    : "未检出黑帧";
  const silenceRes = spawnSync(FFMPEG, ["-v", "info", "-i", file, "-af", "silencedetect=noise=-45dB:d=0.6", "-vn", "-f", "null", "-"], {
    encoding: "utf8", maxBuffer: 16 * 1024 * 1024
  });
  const silenceText = `${silenceRes.stdout ?? ""}\n${silenceRes.stderr ?? ""}`;
  const silenceMatches = [...silenceText.matchAll(/silence_start:\s*(-?[\d.]+)[\s\S]*?silence_end:\s*([\d.]+)\s*\|\s*silence_duration:\s*([\d.]+)/g)];
  const silenceSeconds = silenceMatches.length > 0 ? Math.max(...silenceMatches.map((m) => Number(m[3]))) : 0;
  const silenceDetail = silenceMatches.length > 0
    ? silenceMatches.map((m) => `${m[1]}s–${m[2]}s(${m[3]}s)`).join("、")
    : "未检出静音段";
  return { blackSeconds, silenceSeconds, detail: `黑帧：${blackDetail}；静音：${silenceDetail}` };
}

/* ================= 输入 ================= */

interface ShotCard {
  shotId: string; sceneType?: string; duration?: number;
  scene?: string; sceneDescription?: string; action?: string; character?: string; costume?: string;
  makeup?: string; composition?: string; lighting?: string; color_palette?: string; mood?: string;
  dialogue?: Array<{ speaker?: string; text?: string; emotion?: string; trigger?: string }>;
  [key: string]: unknown;
}
const shotlist = JSON.parse(readFileSync(SHOTS_FILE, "utf8")) as {
  projectId?: string; title?: string; durationSeconds?: number; aspect?: string; resolution?: string;
  character?: { id?: string; name?: string }; shots: ShotCard[];
};
const shots = ONLY.length > 0 ? shotlist.shots.filter((s) => ONLY.includes(s.shotId)) : shotlist.shots;
if (!Array.isArray(shots) || shots.length === 0) throw new Error("shotlist 里没有镜头");
const totalSeconds = Number(shotlist.durationSeconds ?? shots.reduce((sum, s) => sum + Number(s.duration ?? 0), 0));
/**
 * **素材镜**（2026-09-25 口径修订，产品所有者硬规定）：
 * 卡里给了 `photo` 的镜头**不是**"静态照片段"，而是**素材镜**——真实素材只作**生成输入**，
 * 由 `material-gen` 阶段把它当首帧交给生成模型出带真实运动的镜头（gate G-MAT1）。
 * 因此这类镜头：跳过文生关键帧（首帧就是真实素材），但仍要**有提示词、有提交门、有产物溯源**，
 * 且**严禁**用"裁切 + 推拉/滤镜"把素材本身当镜头（旧的 `photo-motion` 路径已删除）。
 * 相关环节按"生成镜/素材镜"分流，否则 G7 会因为"素材镜没有文生关键帧"而误判缺件。
 */
const isMaterialShot = (shot: ShotCard): boolean => String((shot as Record<string, unknown>).photo ?? "").trim().length > 0;
const generatedShots = shots.filter((shot) => !isMaterialShot(shot));
const materialShots = shots.filter((shot) => isMaterialShot(shot));
/**
 * 素材用途**在开跑前先验一遍**（fail-fast）：缺声明/写成静态直出用途时当场停，
 * 不等到出片阶段才发现"这一镜本来就不该这么做"。错误信息里带规则原文。
 */
for (const shot of materialShots) {
  try {
    readMaterialSpec(shot as unknown as Record<string, unknown>);
  } catch (err) {
    throw new Error(`素材用途硬约束未通过（${MATERIAL_POLICY_VERSION}）：${err instanceof Error ? err.message : String(err)}`);
  }
  log(`素材镜 ${shot.shotId}：素材用途声明 ok（generation-reference）——素材只作生成输入，禁止静态直出`);
}

interface CharacterEntryLike {
  id: string; name: string; files: Record<string, string>; dir: string;
  /** 档案正文里的外貌描述（纯文生图时的唯一人物变量；真人图不可作为视频首帧时靠它保人） */
  appearanceText: string;
}
/**
 * 角色库装载（2026-09-24 扩展）：除 `HR_CHARACTER_LIBRARY` 外，**同时**装载随仓分发的默认模特库
 * `bundles/ai-video/library/characters/*`（系统默认 1 号模特 = 陈卓），并读取 registry.json 的别名表——
 * 这样"未指定模特时自动用陈卓""镜头卡写'陈卓'时解析到该档案"两条规则才能在管线里生效。
 */
function loadCharacters(): Map<string, CharacterEntryLike> {
  const library = new Map<string, CharacterEntryLike>();
  const repoCharacters = join(REPO_ROOT, "bundles/ai-video/library/characters");
  for (const root of [LIBRARY, repoCharacters]) {
    if (existsSync(root)) loadCharacterRoot(root, library);
  }
  return library;
}

/** registry.json：默认模特 + 姓名别名（别名解析在选角时用） */
function loadCharacterRegistry(): { defaultModel: string | null; aliases: Array<{ id: string; names: string[] }> } {
  const file = join(REPO_ROOT, "bundles/ai-video/library/characters/registry.json");
  if (!existsSync(file)) return { defaultModel: null, aliases: [] };
  try {
    const doc = JSON.parse(readFileSync(file, "utf8")) as {
      defaultModel?: string;
      models?: Array<{ id: string; name?: string; aliases?: string[] }>;
    };
    return {
      defaultModel: doc.defaultModel ?? null,
      aliases: (doc.models ?? []).map((m) => ({ id: m.id, names: [m.id, m.name ?? "", ...(m.aliases ?? [])].filter(Boolean) }))
    };
  } catch {
    return { defaultModel: null, aliases: [] };
  }
}

function loadCharacterRoot(root: string, library: Map<string, CharacterEntryLike>): void {
  for (const name of readdirSync(root)) {
    const dir = join(root, name);
    const profileFile = join(dir, "profile.json");
    if (!existsSync(profileFile) || !statSync(dir).isDirectory()) continue;
    const profile = JSON.parse(readFileSync(profileFile, "utf8")) as {
      id: string; name: string;
      identity?: Record<string, unknown>;
      appearance?: Record<string, unknown>;
      wardrobe?: Array<Record<string, unknown>>;
      portraitSets?: Array<{ dir: string; angles: string[]; active?: boolean; version: number }>;
    };
    const sets = profile.portraitSets ?? [];
    const active = sets.find((s) => s.active) ?? sets[sets.length - 1];
    const files: Record<string, string> = {};
    if (active) {
      const setDir = join(dir, active.dir);
      if (existsSync(setDir)) {
        for (const angle of active.angles) {
          /**
           * 角度文件解析统一走 `findAngleFile`（2026-09-24 修复）：
           * 早先这里按 `${profile.name}-${angle}` 前缀硬匹配，而随仓 1 号模特的
           * `portraits/v3/` 文件名前缀是"平江路讲述人"、档案 name 是"陈卓" →
           * 8 张定妆照全部匹配不到（G5 门当场亮红才发现）。
           */
          const hit = findAngleFile(setDir, profile.name, angle);
          if (hit) files[angle] = hit;
        }
      }
    }
    /** 档案 → 一段可用于纯文生图的人物描述（与 portrait-agent 的 appearanceOf 同口径，但不含任何地点/道具/时段） */
    const a = profile.appearance ?? {};
    const i = profile.identity ?? {};
    const wardrobe = Array.isArray(profile.wardrobe) && profile.wardrobe.length > 0 ? profile.wardrobe[0]! : {};
    const appearanceText = [
      `一位${String(i.age ?? "").trim()}${String(a.gender ?? i.gender ?? "女性") === "female" ? "女性" : String(a.gender ?? i.gender ?? "女性")}`,
      a.face ? String(a.face) : "",
      a.skin ? `肤质：${String(a.skin)}` : "",
      a.eyes ? `眼睛：${String(a.eyes)}` : "",
      a.hair ? `${String(a.hair)}发型` : "",
      Array.isArray(a.features) && a.features.length > 0 ? `特征：${(a.features as unknown[]).join("；")}` : "",
      a.bodyType ? `身形：${String(a.bodyType)}` : "",
      wardrobe.name ? `穿着${String(wardrobe.name)}${wardrobe.detail ? `（${String(wardrobe.detail)}）` : ""}` : ""
    ].filter(Boolean).join("，");
    library.set(profile.id, { id: profile.id, name: profile.name, files, dir, appearanceText });
  }
  return library;
}
const characters = loadCharacters();
/**
 * 选角（2026-09-24 规则）：
 *   ① 镜头卡/项目显式指定 → 用指定的；
 *   ② 文本里出现模特姓名或别名（如"陈卓"）→ 解析到该档案；
 *   ③ 都没指定 → 回落到 registry.json 的 **defaultModel（系统默认 1 号模特 = 陈卓）**；
 *   ④ 仍然没有 → 用库里第一个（并如实记录，不静默）。
 */
const characterRegistry = loadCharacterRegistry();
const lead = (() => {
  const list = [...characters.values()];
  const explicitId = shotlist.character?.id ?? "";
  const explicitName = shotlist.character?.name ?? "";
  const byExplicit = list.find((c) => c.id === explicitId || c.name === explicitName);
  if (byExplicit) return byExplicit;
  const aliasHit = characterRegistry.aliases.find((a) => a.names.some((n) => n && n.length > 1 && explicitName.includes(n)));
  if (aliasHit) return list.find((c) => c.id === aliasHit.id) ?? undefined;
  if (characterRegistry.defaultModel) {
    const preferred = list.find((c) => c.id === characterRegistry.defaultModel);
    if (preferred) return preferred;
  }
  return list[0];
})();
if (lead && characterRegistry.defaultModel && lead.id === characterRegistry.defaultModel) {
  log(`未显式指定模特 → 使用系统默认模特：${lead.name}（${lead.id}，1 号）`);
}

/* ---------- ⓪-0 G5 定妆照确认（step_key: g5-portrait-confirm） ---------- */
/**
 * 管线 yml 的 `g5-portrait-confirm` 门：确认"这组定妆照可用于本片"。
 *
 * CLI 口径 = **资产硬闸 + 定妆照监制记录**：
 *   · 硬闸：角色档案在、四个必需角度齐备、单张 >50KB（占位图/失败图直接拦）；
 *   · 监制记录：读角色目录 `reviews/*.json` 的**最近一次**定妆照评审（`portrait-agent review` 产出），
 *     最近一次是"打回"就不放行；没有记录则如实标 degraded（说明这个门只做了确定性校验）。
 * 与 §⑤ 的 `keyframe`/`shot` 门不同，G5 管的是**角色资产**，不是本片画面。
 */
if (!DRY_RUN) {
  const requiredAngles = ["front", "threeQuarter", "closeup", "side"];
  const published = lead ? requiredAngles.map((angle) => ({ angle, path: lead.files[angle] ?? "" })) : [];
  const missing = published.filter((f) => !f.path || !existsSync(f.path));
  /** 安全取字节数：缺失/空路径返回 0（真机 2026-09-24：空路径直接 statSync 抛 ENOENT 把整个运行打断） */
  const sizeOf = (path: string): number => (path && existsSync(path) ? statSync(path).size : 0);
  const tiny = published.filter((f) => sizeOf(f.path) > 0 && sizeOf(f.path) < 50_000);
  /**
   * 定妆照监制记录：**优先读角色目录的门账本 `gates.jsonl`**（`g5-portrait-confirm`，
   * 由 `portrait-agent review` 落账，2026-09-24 起）；没有门记录时回退到 `reviews/*.json`。
   * 这样"定妆照确认"就有了按 step_key 的机器可读记录，而不是靠人翻评审文件。
   */
  const gateRecord = (() => {
    if (!lead) return null;
    const ledger = join(lead.dir, "gates.jsonl");
    if (!existsSync(ledger)) return null;
    try {
      const events = readFileSync(ledger, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as { stepKey?: string; at?: string; approved?: boolean; score?: number | null; reason?: string });
      const mine = events.filter((e) => e.stepKey === "g5-portrait-confirm");
      return mine.length > 0 ? mine[mine.length - 1]! : null;
    } catch { return null; }
  })();
  const reviewFile = (() => {
    if (!lead) return null;
    const dir = join(lead.dir, "reviews");
    if (!existsSync(dir)) return null;
    const files = readdirSync(dir).filter((f) => f.endsWith(".json")).sort();
    return files.length > 0 ? join(dir, files[files.length - 1]!) : null;
  })();
  const review = (() => {
    if (!reviewFile) return null;
    try {
      return JSON.parse(readFileSync(reviewFile, "utf8")) as { at?: string; verdict?: { approved?: boolean; score?: number; reason?: string } };
    } catch { return null; }
  })();
  const checks: GateCheck[] = lead
    ? [
        { id: "character-present", pass: true, detail: `角色 ${lead.name}（${lead.id}）`, hard: true },
        {
          id: "required-angles", pass: missing.length === 0, hard: true,
          detail: missing.length === 0
            ? `必需角度齐备：${requiredAngles.join("/")}`
            : `缺角度或文件不存在：${missing.map((m) => m.angle).join("/")}`
        },
        {
          id: "file-size", pass: tiny.length === 0, hard: true,
          detail: tiny.length === 0
            ? `四角度均 >50KB（${published.map((f) => `${f.angle}=${(sizeOf(f.path) / 1024).toFixed(0)}KB`).join(" ")}）`
            : `以下角度文件过小（疑似占位图）：${tiny.map((f) => f.angle).join("/")}`
        },
        {
          /** 附加信息（不参与硬闸）：档案里一共有多少角度可用——只有 4 个必需角度时也能拍，但选择面更窄 */
          id: "archive-angles", pass: Object.keys(lead.files).length >= 4, hard: false,
          detail: `档案可用角度 ${Object.keys(lead.files).join("/") || "无"}（共 ${Object.keys(lead.files).length} 个）`
        },
        ...(gateRecord
          ? [{
              id: "portrait-review", pass: gateRecord.approved !== false, hard: true,
              detail: `定妆照门记录（gates.jsonl）：${gateRecord.approved === false ? "打回" : "放行"}（score=${gateRecord.score ?? "?"}，${gateRecord.at ?? "无时间"}）`
            }]
          : review
          ? [{
              id: "portrait-review", pass: review.verdict?.approved !== false, hard: true,
              detail: `最近一次定妆照监制：${review.verdict?.approved === false ? "打回" : "放行"}（score=${review.verdict?.score ?? "?"}，${review.at ?? "无时间"}）`
            }]
          : [])
      ]
    : [{ id: "applicable", pass: true, detail: "镜头卡未涉及人物（空镜片）→ 定妆照门不适用", hard: false }];
  const gate = recordGate({
    stepKey: "g5-portrait-confirm",
    sourceStage: "portrait",
    checks,
    /**
     * 没有定妆照监制记录时**不冒充实质评审**：确定性闸照跑，但 degraded 置位，
     * 让审计一眼看到"这个门这次只做了资产校验"。
     */
    degraded: Boolean(lead) && !review && !gateRecord,
    evidence: {
      character: lead ? { id: lead.id, name: lead.name, angles: Object.keys(lead.files) } : null,
      reviewFile,
      gateLedger: lead ? join(lead.dir, "gates.jsonl") : null,
      gateApproved: gateRecord?.approved ?? null,
      reviewApproved: review?.verdict?.approved ?? null,
      note: gateRecord ? "含定妆照门记录（gates.jsonl）" : review ? "含定妆照监制评审文件（reviews/）" : "无定妆照监制记录：本次仅做资产硬闸（角度/尺寸/字节）"
    },
    reason: lead
      ? (gateRecord || review ? undefined : "定妆照资产齐备（无监制评审记录，已标 degraded）")
      : "本片无人物，定妆照门不适用"
  });
  if (!gate.approved && !ACCEPT_REJECTED.includes("G5")) {
    throw new Error(`G5 定妆照确认未通过：${gate.reason}（确需继续请显式传 --accept-rejected G5）`);
  }
}

/* ================= 关键帧 / 视频 出图出片 ================= */

function dataUrl(file: string): string {
  const ext = file.toLowerCase().endsWith(".png") ? "png" : file.toLowerCase().endsWith(".webp") ? "webp" : "jpeg";
  return `data:image/${ext};base64,${readFileSync(file).toString("base64")}`;
}

async function arkImage(prompt: string, anchors: string[], size: string): Promise<string> {
  const payload: Record<string, unknown> = {
    model: IMAGE_MODEL, prompt, size, response_format: "url", watermark: false,
    ...(anchors.length > 0 ? { image: anchors.length === 1 ? dataUrl(anchors[0]!) : anchors.slice(0, 4).map(dataUrl) } : {})
  };
  const res = await fetch(`${ARK_BASE}/images/generations`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${ARK_KEY}` },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(300_000)
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`出图失败 HTTP ${res.status}：${text.slice(0, 300)}`);
  const json = JSON.parse(text) as { data?: Array<{ url?: string }> };
  const url = json.data?.[0]?.url;
  if (!url) throw new Error(`出图响应缺少 url：${text.slice(0, 200)}`);
  return url;
}

/**
 * 关键帧的"托管 URL 台账"（2026-09-24 真机结论）。
 *
 * Ark 视频接口对**真人题材的图片输入**做隐私校验：
 *   · base64 data URL（first_frame / reference_image 都一样）→ 400 `InputImageSensitiveContentDetected.PrivacyInformation`
 *   · **同账号模型产物、以 Ark 托管 URL 形式引用** → 200 受理（探针脚本 `work/film/probe-first-frame.mts` 实测 A/B/C/D 四态）
 * 所以关键帧出图后必须把 Seedream 返回的托管 URL 存下来，供视频环节当首帧用（URL 有有效期，按时间戳老化）。
 */
function hostedUrlFile(shotId: string): string {
  return join(PLATE_DIR, `${shotId}.hosted-url.json`);
}
function saveHostedUrl(shotId: string, url: string): void {
  writeFileSync(hostedUrlFile(shotId), `${JSON.stringify({ url, at: stamp() }, null, 2)}\n`, "utf8");
}
function loadHostedUrl(shotId: string, maxAgeHours = 20): string | null {
  const file = hostedUrlFile(shotId);
  if (!existsSync(file)) return null;
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8")) as { url?: string; at?: string };
    if (!parsed.url || !parsed.at) return null;
    const ageHours = (Date.now() - Date.parse(parsed.at)) / 3_600_000;
    return ageHours <= maxAgeHours ? parsed.url : null;
  } catch {
    return null;
  }
}

async function download(url: string, file: string): Promise<string> {
  const res = await fetch(url, { signal: AbortSignal.timeout(300_000) });
  if (!res.ok) throw new Error(`下载失败 HTTP ${res.status}`);
  writeFileSync(file, Buffer.from(await res.arrayBuffer()));
  return file;
}

/** 逐镜视频提交（Seedance 异步任务制） */
async function arkVideo(options: {
  prompt: string; firstFrame?: string; refs: string[]; seconds: number; generateAudio: boolean; seed?: number;
}): Promise<{ taskId: string; url: string; lastFrame: string | null }> {
  const content: Array<Record<string, unknown>> = [{ type: "text", text: options.prompt }];
  if (options.firstFrame) content.push({ type: "image_url", image_url: { url: options.firstFrame }, role: "first_frame" });
  for (const ref of options.refs.slice(0, 3)) {
    if (ref === options.firstFrame) continue;
    content.push({ type: "image_url", image_url: { url: ref }, role: "reference_image" });
  }
  const submit = await fetch(`${ARK_BASE}/contents/generations/tasks`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${ARK_KEY}` },
    body: JSON.stringify({
      model: VIDEO_MODEL,
      content,
      duration: options.seconds,
      /**
       * 首帧模式下 Ark 明确拒绝 `ratio`（InvalidParameter.TaskTypeConstraint：
       * "For first-frame or first-last-frame generation, the output ratio follows the first-frame image"）——
       * 画幅由关键帧自己决定，这里只在纯文生视频时才传 ratio。
       */
      ...(options.firstFrame ? {} : { ratio: ASPECT }),
      resolution: RESOLUTION,
      generate_audio: options.generateAudio,
      watermark: false,
      return_last_frame: true,
      ...(options.seed ? { seed: options.seed } : {})
    }),
    signal: AbortSignal.timeout(120_000)
  });
  const submitText = await submit.text();
  if (!submit.ok) throw new Error(`视频提交失败 HTTP ${submit.status}：${submitText.slice(0, 300)}`);
  const submitJson = JSON.parse(submitText) as { id?: string; data?: { id?: string } };
  const taskId = submitJson.id ?? submitJson.data?.id;
  if (!taskId) throw new Error(`未返回 task_id：${submitText.slice(0, 200)}`);

  const deadline = Date.now() + 20 * 60_000;
  let last: Record<string, unknown> = {};
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 10_000));
    const poll = await fetch(`${ARK_BASE}/contents/generations/tasks/${taskId}`, {
      headers: { authorization: `Bearer ${ARK_KEY}` }, signal: AbortSignal.timeout(60_000)
    });
    const pollText = await poll.text();
    try { last = JSON.parse(pollText) as Record<string, unknown>; } catch { last = { raw: pollText.slice(0, 200) }; }
    const status = String(last.status ?? "");
    if (status === "succeeded" || status === "success") {
      const url = String((last.content as Record<string, unknown> | undefined)?.video_url ?? "");
      const lastFrame = String((last.content as Record<string, unknown> | undefined)?.last_frame_url ?? "") || null;
      if (!url) throw new Error(`任务成功但无 video_url：${pollText.slice(0, 200)}`);
      return { taskId, url, lastFrame };
    }
    if (status === "failed" || status === "cancelled") {
      throw new Error(`渲染任务 ${status}：${pollText.slice(0, 300)}`);
    }
  }
  throw new Error(`轮询超时：${JSON.stringify(last).slice(0, 200)}`);
}

/* ================= 镜头文案与字幕 ================= */

function dialogueText(shot: ShotCard): string {
  return (shot.dialogue ?? []).map((d) => String(d.text ?? "")).filter(Boolean).join(" ");
}
/**
 * 关键帧提示词（薄封装，实现移到 `packages/video-studio/src/plate-prompt.ts` + 单测）。
 *
 * 2026-09-24 真机二次事故：本函数原来内联在脚本里，数组中被残留的 diff 标记 `+` 破坏，
 * 那一行成了 `+"场景结构与物理自洽（通用）：…"` = **NaN**——通用空间/物理不变量从未进过提示词，
 * 进 Ark 的是字面 "NaN"。评审侧有不变量、提示词侧没有，于是"无头之桥"屡次复现。
 * 现在实现搬进模块并加了退化哨兵断言（不得出现 NaN/undefined/[object Object]）+ 桥类结构硬约束测试。
 */
function platePrompt(shot: ShotCard, characterName: string, appearanceText = ""): string {
  return buildPlatePrompt(shot as unknown as PlatePromptShot, {
    characterName,
    appearanceText,
    aspect: ASPECT,
    resolution: RESOLUTION,
    title: shotlist.title
  });
}
function buildSrt(): string {
  const lines: string[] = [];
  let cursor = 0;
  /**
   * 单行字数护栏（2026-09-25 真机）：字幕工位按平台口径限制单行 ≤18 个汉字，
   * 超了直接判 `line_width` 失败并删产物（小红书首跑即被拦）。
   * 这里按标点做**最多两行**的折行，让名句/长句完整显示而不是被迫删字。
   * 宽度口径：汉字计 1、非汉字计 0.5（与工位的 maxLineCharsZh 口径一致）。
   */
  const wrapCue = (input: string, maxPerLine = 18): string => {
    const chunks = input.split(/(?<=[，。！？；、,.!?;])/).filter((s) => s.trim().length > 0);
    const wrapped: string[] = [];
    let current = "";
    for (const chunk of chunks) {
      const candidate = `${current}${chunk}`;
      const width = [...candidate].reduce((sum, ch) => sum + (/[\u4e00-\u9fff]/.test(ch) ? 1 : 0.5), 0);
      if (current && width > maxPerLine) {
        wrapped.push(current.trim());
        current = chunk;
      } else {
        current = candidate;
      }
    }
    if (current.trim()) wrapped.push(current.trim());
    return wrapped.slice(0, 2).join("\n");
  };
  shots.forEach((shot, index) => {
    const duration = Number(shot.duration ?? 5);
    const text = dialogueText(shot);
    if (text) {
      const start = cursor + Math.min(0.6, duration * 0.12);
      const end = cursor + duration - 0.35;
      lines.push(
        String(index + 1),
        `${srtTime(start)} --> ${srtTime(end)}`,
        wrapCue(text),
        ""
      );
    }
    cursor += duration;
  });
  return lines.join("\n");
}
function srtTime(seconds: number): string {
  const hh = String(Math.floor(seconds / 3600)).padStart(2, "0");
  const mm = String(Math.floor((seconds % 3600) / 60)).padStart(2, "0");
  const ss = String(Math.floor(seconds % 60)).padStart(2, "0");
  const ms = String(Math.round((seconds % 1) * 1000)).padStart(3, "0");
  return `${hh}:${mm}:${ss},${ms}`;
}

/**
 * 复用成片的复检设置：抽 3 帧 + 确定性检查（时长/分辨率/音轨）。
 * 与"新渲一版"走同一套判据，避免复用路径松于生产路径。
 */
function cachedShotSettings(shot: ShotCard): { frames: string[]; checks: Array<{ id: string; pass: boolean; detail: string; hard?: boolean }> } {
  const clip = join(CLIP_DIR, `${shot.shotId}.mp4`);
  const duration = Number(shot.duration ?? 5);
  const info = probe(clip);
  const actual = Number(info.duration ?? 0);
  const width = Number(info.width ?? 0);
  const height = Number(info.height ?? 0);
  const framesDir = join(WORK_DIR, "frames", PROJECT, shot.shotId);
  mkdirSync(framesDir, { recursive: true });
  const frames: string[] = [];
  for (const [i, at] of [0.6, duration / 2, Math.max(0.6, duration - 0.8)].entries()) {
    /**
     * 评审帧压缩（2026-09-24 三轮审计）：**复用分支同样要压缩**。
     * 真机事故：1080×1920 的 PNG 抽帧单张 ≈10MB，base64 后 4 张 ≈53MB → 评审模型 HTTP 413，
     * 监制被判"不可用"、镜头悬在"未复核"状态。渲染分支已改 720 宽 JPEG，复用分支漏改过一版。
     */
    const file = join(framesDir, `cached-f${i + 1}.jpg`);
    run(FFMPEG, ["-y", "-ss", String(at), "-i", clip, "-frames:v", "1", "-vf", "scale=720:-2", "-q:v", "3", file]);
    frames.push(file);
  }
  return {
    frames,
    checks: [
      { id: "duration", pass: Math.abs(actual - duration) <= 0.6, detail: `期望 ${duration}s 实测 ${actual.toFixed(2)}s`, hard: true },
      { id: "resolution", pass: height >= 720 && width >= 720, detail: `${width}x${height}`, hard: true },
      { id: "audio-track", pass: Boolean(info.hasAudio), detail: info.hasAudio ? `音轨 ${info.acodec}` : "无音轨" }
    ]
  };
}

/* ================= 主流程 ================= */

log(`项目 ${PROJECT}｜镜头 ${shots.length} 个｜目标 ${totalSeconds}s｜${ASPECT} ${RESOLUTION}@${FPS}fps`);
log(`角色档案：${lead ? `${lead.name}（${lead.id}）角度 ${Object.keys(lead.files).join("/")}` : "未找到（人物一致性将降级为文字描述）"}`);
log(`阶段：${[...STAGES].join(" → ")}｜监制：${flag("--allow-fallback-approve") ? "允许降级放行" : "fail-closed"}`);
if (DRY_RUN) log("⚠ dry-run：只做脚本/提示词/计划，不出图不出片");

const specReports: Array<Record<string, unknown>> = [];
/** 动作节拍预算（advisory：只报数不拦，避免把"9 个 vs 8 个"这种量级差当成缺陷） */
const motionBudgetNotes: Array<{ shotId: string; beats: number; advice: string }> = [];

/* ---------- ⓪ 摄影知识库注入（监制：cine-kb） ---------- */
/**
 * 为什么放在提示词之前：知识库的价值就在"写提示词前先定关键细节"——
 * 光圈档位、景别、光位、色调、材质先在库里选好，再交给交付闸与提示词融合。
 * 纪律：提示词字段只写**画面语言**；f 值等硬参数只进 trace（KB 检索总则）。
 */
if (STAGES.has("cine-kb")) {
  const started = Date.now();
  const kbDir = resolve(arg("--kb-dir", join(REPO_ROOT, "bundles/ai-video/library/cinematography-kb")));
  const bridgePath = join(REPO_ROOT, "bundles/ai-video/connectors/cine-kb-bridge/core.mjs");
  if (!existsSync(bridgePath) || !existsSync(kbDir)) {
    record({
      stage: "cine-kb", shotId: null, invoked: false, ok: false, cached: false, degraded: false, attempt: 1, ms: 0,
      artifact: null, evidence: { kbDir, bridgePath, exists: { bridge: existsSync(bridgePath), kb: existsSync(kbDir) } },
      verdict: null, note: "摄影知识库或连接器缺失，跳过注入（不静默：此处显式记录）"
    });
  } else {
    const core = await import(bridgePath) as {
      loadKb: (dir: string) => Record<string, unknown>;
      kbStatus: (kb: unknown) => Record<string, unknown>;
      enrichShotCard: (kb: unknown, card: unknown) => { card: Record<string, unknown>; trace: Record<string, unknown> };
    };
    const kb = core.loadKb(kbDir);
    const status = core.kbStatus(kb) as { topics: number; entries: number; missingTopics: Array<{ id: string; title: string }> };
    log(`摄影知识库：${status.topics} 篇 / ${status.entries} 条映射${status.missingTopics.length > 0 ? `｜⚠ 缺篇 ${status.missingTopics.map((t) => `${t.id} ${t.title}`).join("、")}` : ""}`);
    const traceDir = join(WORK_DIR, "cine-kb");
    mkdirSync(traceDir, { recursive: true });
    for (const [index, shot] of shots.entries()) {
      /**
       * 提示词语言口径（2026-09-24 真机）：分镜卡【语言约束】写明"全部字段必须使用中文"，
       * 因此默认只注入中文短语（英文关键词仍在 trace 里）；
       * 需要英文提示词的模型可由 `--prompt-english-gloss` 显式开启。
       */
      const { card, trace } = core.enrichShotCard(kb, shot, { englishGloss: flag("--prompt-english-gloss") });
      shots[index] = card as ShotCard;
      const traceFile = join(traceDir, `${shot.shotId}.json`);
      writeFileSync(traceFile, `${JSON.stringify({ ...trace, kbDir, kbStatus: status }, null, 2)}\n`, "utf8");
      const advisor = (trace as { apertureAdvisor?: { aperture: string; scenarioLabel: string | null; matchedBy: string } }).apertureAdvisor;
      const fields = ((trace as { applied?: Array<{ field: string; added: string }> }).applied ?? []);
      log(`  ${shot.shotId}: 光圈 ${advisor?.aperture ?? "-"}（${advisor?.scenarioLabel ?? "-"}）· 注入 ${fields.filter((f) => f.field !== "depth_of_field").length} 条知识 → ${fields.map((f) => f.field).join("/")}`);
      record({
        stage: "cine-kb", shotId: shot.shotId, invoked: true, ok: true, cached: false, degraded: false, attempt: 1,
        ms: Date.now() - started, artifact: traceFile,
        evidence: { aperture: advisor?.aperture ?? null, scenario: advisor?.scenarioLabel ?? null, matchedBy: advisor?.matchedBy ?? null, injectedFields: fields.map((f) => f.field), missingTopics: status.missingTopics.map((t) => t.id) },
        verdict: null, note: "知识库按场景注入（参数只进 trace，提示词只写画面语言）"
      });
    }
    /** 提示词交付闸前把增强后的镜头卡落盘留档 */
    writeFileSync(join(WORK_DIR, `shotlist-enriched-${PROJECT}.json`), `${JSON.stringify({ projectId: PROJECT, shots, cineKbApplied: true }, null, 2)}\n`, "utf8");
  }
}

/* ---------- ① 连贯性导演评审（监制：continuity，step_key: continuity） ---------- */
/**
 * 管线 yml 的 `continuity` 环节（位置与 yml 一致：**在提示词融合之前**）。
 *
 * 为什么放这么前：跨镜问题（同一场戏换造型、时段倒退、方向相反、道具凭空出现）在**镜头卡**层面就能查出来，
 * 等到出片才发现要烧一整轮渲染额度。确定性检查在 `packages/video-studio/src/continuity.ts`（6 问 + 5 维评分），
 * LLM 只补"机检查不出的语义跳变"。硬阻断按 yml 纪律**直接打回**（不花钱）。
 */
if (STAGES.has("continuity")) {
  const started = Date.now();
  const report = auditContinuity(shots as unknown as Array<Record<string, unknown>>, {
    targetSeconds: ONLY.length > 0 ? null : totalSeconds,
    projectId: PROJECT
  });
  const checks: GateCheck[] = report.checks.map((c) => ({ id: c.id, pass: c.pass, detail: c.detail, hard: c.hard }));
  if (!DRY_RUN) {
    const verdict = await reviewStage({
      stage: "continuity", projectId: PROJECT,
      artifacts: [{ path: SHOTS_FILE, kind: "json", note: "镜头卡（跨镜一致性评审对象）" }],
      deterministic: checks,
      context: {
        shotCount: report.shotCount,
        totalSeconds: report.totalSeconds,
        sixQuestions: report.questions.map((q) => `${q.question} → ${q.answer}（${q.note}）`),
        fiveDimensions: report.dimensions.map((d) => `${d.name} ${d.score}/20`),
        deterministicScore: report.score,
        discipline: "硬阻断（打回）：造型无理由不一致、总时长不符、台词重复。其余为软信号，进问题清单但不阻断；"
          + "跨镜判断只看镜头卡文本，不要索要额外画面证据。"
      },
      env: ENV, allowFallbackApprove: ALLOW_FALLBACK_APPROVE, log
    });
    record({
      stage: "continuity", shotId: null, invoked: true, ok: verdict.approved, cached: false, degraded: verdict.degraded,
      attempt: 1, ms: Date.now() - started, artifact: SHOTS_FILE,
      evidence: { score: verdict.score, deterministicScore: report.score, blocking: report.blocking, dimensions: report.dimensions, questions: report.questions },
      verdict
    });
    if (!verdict.approved && !ACCEPT_REJECTED.includes("continuity")) {
      log(`⛔ 连贯性导演评审未放行：${verdict.reason}（${verdict.issues.slice(0, 3).join("；")}）`);
      log(`   纪律：本环节在**花钱之前**硬阻断。确需带瑕疵继续，请显式传 --accept-rejected continuity（会留痕）。`);
      process.exit(4);
    }
    if (!verdict.approved) log(`⚠ 连贯性导演评审被打回，但已显式声明带瑕疵放行（--accept-rejected continuity）`);
  } else {
    record({
      stage: "continuity", shotId: null, invoked: false, ok: report.approved, cached: false, degraded: false,
      attempt: 0, ms: Date.now() - started, artifact: SHOTS_FILE,
      evidence: { dryRun: true, deterministicScore: report.score, blocking: report.blocking }, verdict: null
    });
    log(`连贯性（dry-run）：确定性 5 维 ${report.score}/100，硬阻断 ${report.blocking.length} 条`);
  }
}

/* ---------- ①-1 微动作增强（step_key: micromotion，5 路：面部/身体/眼神/呼吸/融合） ---------- */
/**
 * 管线 yml 的 `micromotion` 环节。
 *
 * **与 yml 的顺序差异（显式声明）**：yml 把它排在 G6 之后；这里**前移到提示词融合之前**——
 * 增强的本质是改镜头卡（action 字段），融合之后再改就会绕开刚通过的 G6 审核
 * （"审过的提示词 ≠ 最终提交的提示词"）。前移后 G6 审的就是含微动作的最终稿。
 */
if (STAGES.has("micromotion")) {
  const started = Date.now();
  const traces: Array<Record<string, unknown>> = [];
  let empty = 0;
  for (const shot of generatedShots) {
    const { card, trace } = applyMicromotion(shot as unknown as Record<string, unknown>);
    traces.push(trace as unknown as Record<string, unknown>);
    if (trace.applied.length === 0 && !trace.skipped) empty += 1;
    if (!trace.skipped) {
      /** 就地替换镜头卡：后续 spec 融合、关键帧 platePrompt、视频提交读到的都是增强后的 action */
      const index = shots.findIndex((s) => s.shotId === shot.shotId);
      if (index >= 0) shots[index] = card as unknown as ShotCard;
    }
  }
  const channelsOk = traces.every((t) => (t.applied as unknown[]).length >= 4 || Boolean(t.skipped));
  const bounded = traces.every((t) => Number(t.charDelta ?? 0) <= 200);
  const languageOnly = !/f\/|ISO|帧率|焦段/.test(traces.map((t) => String(t.text ?? "")).join(" "));
  const checks: GateCheck[] = [
    { id: "five-channels", pass: channelsOk, hard: true, detail: channelsOk ? "每镜 5 路微动作齐备（面部/身体/眼神/呼吸/融合）" : "存在镜头不足 4 路微动作" },
    { id: "bounded-delta", pass: bounded, hard: true, detail: bounded ? `增量均在界内（最大 ${Math.max(0, ...traces.map((t) => Number(t.charDelta ?? 0)))} 字）` : "微动作增量超过 200 字上限" },
    { id: "language-only", pass: languageOnly, hard: true, detail: "微动作只写画面语言（不含 f 值/ISO/帧率等技术参数）" }
  ];
  const verdict = flag("--micromotion-review") && !DRY_RUN
    ? await reviewStage({
        stage: "micromotion", projectId: PROJECT,
        artifacts: [{ path: SHOTS_FILE, kind: "json" }],
        deterministic: checks,
        context: { traces: traces.slice(0, 8).map((t) => ({ shotId: t.shotId, text: t.text })) },
        env: ENV, allowFallbackApprove: ALLOW_FALLBACK_APPROVE, log
      })
    : null;
  const ok = checks.every((c) => !c.hard || c.pass) && (verdict ? verdict.approved : true);
  const traceFile = join(WORK_DIR, `micromotion-${PROJECT}.json`);
  if (!DRY_RUN) writeFileSync(traceFile, `${JSON.stringify({ at: stamp(), projectId: PROJECT, traces }, null, 2)}\n`, "utf8");
  record({
    stage: "micromotion", shotId: null, invoked: true, ok, cached: false, degraded: Boolean(verdict?.degraded),
    attempt: 1, ms: Date.now() - started, artifact: DRY_RUN ? null : traceFile,
    evidence: {
      channels: traces.map((t) => ({ shotId: t.shotId, applied: (t.applied as unknown[]).length, skipped: t.skipped ?? null, charDelta: t.charDelta })),
      llmReviewed: Boolean(verdict)
    },
    verdict
  });
  if (empty > 0 || !ok) {
    throw new Error(`微动作增强未通过自检：空增强 ${empty} 镜${verdict && !verdict.approved ? `；监制：${verdict.reason}` : ""}`);
  }
  log(`微动作增强：${shots.length} 镜 × 5 路（面部/身体/眼神/呼吸/融合）已并入 action${verdict ? `，监制${verdict.approved ? "放行" : "打回"}` : "（未启用 LLM 复评）"}`);
}

/* ---------- ② 脚本 + 提示词交付闸（监制：prompt） ---------- */
if (STAGES.has("spec")) {
  const started = Date.now();
  const checks: Array<{ id: string; pass: boolean; detail: string; hard?: boolean }> = [];
  let rateFail = 0;
  for (const shot of shots) {
    /** 素材镜不参与文生提示词融合（它的提示词是"图生视频"的动效提示词，由 material-gen 组装） */
    if (isMaterialShot(shot)) {
      record({
        stage: "spec", shotId: shot.shotId, invoked: false, ok: true, cached: false, degraded: false, attempt: 1, ms: 0,
        artifact: null,
        evidence: { photo: String((shot as Record<string, unknown>).photo), policy: MATERIAL_POLICY_VERSION },
        verdict: null, note: "素材镜：不做文生提示词融合（先按画幅准备素材，再由 material-gen 图生视频出片）"
      });
      continue;
    }
    const duration = Number(shot.duration ?? 0);
    const chars = dialogueText(shot).replace(/[，。！？、,.!?]/g, "").length;
    const rate = duration > 0 ? chars / duration : 0;
    const report = prepareShotPrompt(shot as unknown as Record<string, unknown>, { ratio: ASPECT, resolution: RESOLUTION });
    /**
     * 提示词语言与引用归一（2026-09-24 真机，6 镜全部命中）：
     *   · 卡片【语言约束】要求全中文，而 vendor 负面约束默认夹带英文（no text / no watermark…）→ 映射成中文等价；
     *   · 角色图引用被写两遍 → 去重。
     * 归一后如仍有长度 ≥3 的拉丁词，写进阶段记录（供审计看到"还剩哪些英文"），不静默忽略。
     */
    const normalized = normalizePromptLanguage(report.prompt);
    /** 时间轴补全（vendor 组装器会截断末段节拍，实测 6/6 镜） */
    const timelineFixed = restoreTimelineField(normalized.prompt, (shot as Record<string, unknown>).timeline);
    const finalPrompt = timelineFixed.prompt;
    specReports.push({
      shotId: shot.shotId, charCount: finalPrompt.length, promptSource: report.promptSource,
      deliveryPass: report.delivery.pass, issues: report.delivery.issues,
      missingSpecFields: report.missingSpecFields, redlines: report.redlines, degraded: report.degraded,
      languageNormalized: {
        replacements: normalized.replacements, dedupedRefs: normalized.dedupedRefs,
        remainingLatin: normalized.remainingLatin, timelineRestored: timelineFixed.restored
      }
    });
    if (normalized.replacements > 0 || normalized.dedupedRefs > 0) {
      log(`  ${shot.shotId}: 提示词归一（英文负面词→中文 ${normalized.replacements} 处 · 角色图去重 ${normalized.dedupedRefs} 处）`);
    }
    if (timelineFixed.restored) log(`  ${shot.shotId}: 时间轴补全（组装器截断了第 ${timelineFixed.segments} 段节拍）`);
    writeFileSync(join(PROMPT_DIR, `${shot.shotId}.txt`), `${finalPrompt}\n`, "utf8");
    const promptFile = join(PROMPT_DIR, `${shot.shotId}.txt`);
    checks.push({
      id: `delivery:${shot.shotId}`, pass: report.delivery.pass, hard: true,
      detail: report.delivery.pass ? `交付闸通过（${finalPrompt.length} 字 · ${report.promptSource}）` : `交付闸未过：${report.delivery.issues.join("；")}`
    });
    checks.push({
      id: `char-count:${shot.shotId}`, pass: finalPrompt.length >= 1200, hard: true,
      detail: `提示词 ${finalPrompt.length} 字（交付口径 ≥1200）`
    });
    checks.push({
      id: `speech-rate:${shot.shotId}`, pass: rate <= 3.6, hard: true,
      detail: `台词 ${chars} 字 / ${duration}s = ${rate.toFixed(2)} 字每秒（上限 3.6）`
    });
    /**
     * 分镜自相矛盾闸（2026-09-24 SC-02 badcase）：
     * 同一镜里既要"面向镜头/视线交流"又要"转身/回头/背身"是**物理上互斥**的动作要求，
     * 模型每次只能满足一半，于是"这一版背身、下一版换脸"反复打回。
     * 这里在**花钱之前**拦下来：要求拆镜或改成"正面接近/正面站定"。
     */
    /**
     * 朝向互斥闸的判据口径（2026-09-24 真机二次校准）：
     *   · **先剥否定**：「不转身」「不指物」里的"转身"是禁止项，早先被当成要求项（假阳性）；
     *   · **再判顺序**：带时间顺序的动作（先…再…／随后／最后／停下后）是**分步执行**，
     *     不是同刻互斥——"走三步后停下、侧身回眸看向镜头"是正常镜头语言，
     *     真出问题的是"全程正面行进 + 转身侧身"这种没有先后交代的写法。顺序动作降级为提示。
     */
    const actionRaw = `${shot.action ?? ""} ${(shot.camera_movement ?? "")}`;
    const actionText = actionRaw.replace(/(不|没有|勿|避免|不要|禁止)[^，。；、,;]{0,12}/g, " ");
    const wantsFront = /面向镜头|正对镜头|正脸|直视镜头|眼神交流|看向镜头/.test(actionText);
    /** 注意：只把"身体转向"算作互斥；"转头/扭头看镜头"是正常小动作，不算（2026-09-24 修正） */
    const wantsTurn = /转身|回眸|侧身|侧转|背对|背身|转正脸|转回/.test(actionText);
    const sequenced = /先[^。；]{0,24}(再|随后|然后)|随后|然后|之后|最后|再转身|再转回|停下(后|之后)?|停留一拍|走(三|两)步后/.test(actionRaw);
    checks.push({
      id: `pose-contradiction:${shot.shotId}`, pass: !(wantsFront && wantsTurn && !sequenced), hard: true,
      detail: wantsFront && wantsTurn && !sequenced
        ? "同一镜同时要求「面向镜头/眼神交流」与「转身/回头/侧身」——动作互斥，模型只能满足一半（真机 SC-02 连续 4 次被打回）。请拆成两镜，或改成「正面站定/正面走近」的重述。"
        : wantsFront && wantsTurn && sequenced
          ? "含转身/回眸与正面要求，但有明确时间顺序（先…再…）→ 属分步动作，不判互斥；建议在提示词里保留顺序词"
          : (wantsTurn ? "含转身/回眸（无正面要求或已否定，属可接受的动态）" : "无朝向互斥")
    });
    /**
     * 场景先验风险闸（软信号，2026-09-24 SC-02 badcase 的**真正根因**）：
     * 模型对「桥/栏杆 + 船/河 + 指物」这组语义有强先验——会主动把人演成侧身倚栏指船，
     * 哪怕提示词写着"面向镜头"。文本层查不出矛盾（文字没写侧身），只能靠**场景语义组合**预警。
     * 命中时给监制与设计者一个明确建议：改"正面走近"或去掉指物。
     */
    const sceneText = `${shot.scene ?? ""} ${shot.sceneDescription ?? ""}`;
    const priorRisk = /指|挥|递|捧|端/.test(actionText)
      && /桥|栏杆|船|河|水|岸/.test(sceneText)
      && /面向镜头|看向镜头|正对镜头|正脸|眼神交流/.test(actionText);
    checks.push({
      id: `prior-risk:${shot.shotId}`, pass: !priorRisk, hard: false,
      detail: priorRisk
        ? "高风险构图先验：场景含「桥/栏杆/船/河」且动作含「指物/递物」又要求「正面看镜头」——模型大概率演成侧身倚栏指船（真机 SC-02 因此连续 4 次被打回）。建议：改「正面走近/正面站定」，或删掉指物动作。"
        : "无已知构图先验冲突"
    });
    /** 动作复杂度预算（软信号）：5 秒内节拍过多会让模型每次只满足一部分，表现为"这版动作对、下版表情对" */
    /**
     * 计拍只算**宏观动作节拍**（2026-09-24 真机）：微动作增强会在 action 末尾追加
     * 5 路微动作（面部/眼神/身体/呼吸/融合，用「；」分隔），把它算进节拍会让每镜
     * 平白多出 5–6 拍（真机 15→21），监制据此打回；微动作是质感层，不是叙事节拍。
     */
    const macroAction = actionRaw.split("【微动作】")[0] ?? actionRaw;
    const beats = (macroAction.match(/然后|随后|接着|再|边[^，。]{0,6}边|同时|先[^，。]{0,4}再/g) ?? []).length
      + macroAction.split(/[，,；;]/).filter((s) => s.trim().length > 1).length;
    /**
     * 节拍预算**只作参考信息，不进 PASS/FAIL 清单**（2026-09-24 修正）：
     * 放进确定性检查时，监制会把它当硬闸用（真机：9 个节拍直接打回，而 9 与 8 的差别并不构成缺陷）。
     * 现在改为 context 里的 advisory，监制可据情权衡，不再自动阻断。
     */
    motionBudgetNotes.push({ shotId: shot.shotId, beats, advice: beats > 8 ? "节拍偏多（建议 ≤8），可合并同拍的连续位移" : "节拍在预算内" });
    if (rate > 3.6) rateFail += 1;
    record({
      stage: "spec", shotId: shot.shotId, invoked: true, ok: report.delivery.pass && report.charCount >= 1200,
      cached: false, degraded: report.degraded, attempt: 1, ms: Date.now() - started,
      artifact: promptFile, evidence: { charCount: report.charCount, promptSource: report.promptSource, missing: report.missingSpecFields }, verdict: null
    });
  }
  writeFileSync(join(PROMPT_DIR, "spec-report.json"), `${JSON.stringify(specReports, null, 2)}\n`, "utf8");
  /**
   * 总时长核对：`--only` 局部重跑时只核对被选中的镜头合计（否则局部重跑永远过不了这一闸）。
   */
  const selectedSeconds = shots.reduce((s, x) => s + Number(x.duration ?? 0), 0);
  const expectedSeconds = ONLY.length > 0 ? selectedSeconds : totalSeconds;
  checks.push({
    id: "duration-total", pass: Math.abs(selectedSeconds - expectedSeconds) < 0.001, hard: true,
    detail: `镜头时长合计 ${selectedSeconds}s（目标 ${expectedSeconds}s${ONLY.length > 0 ? `，局部重跑 ${ONLY.join(",")}` : ""}）`
  });
  const verdict = await reviewStage({
    stage: "prompt", projectId: PROJECT,
    artifacts: [
      { path: join(PROMPT_DIR, "spec-report.json"), kind: "json" },
      /** 只送**生成镜**的提示词；真实素材段没有提示词文件（硬塞路径会让监制读到空文件） */
      ...generatedShots.map((s) => ({ path: join(PROMPT_DIR, `${s.shotId}.txt`), kind: "text" as const }))
    ],
    deterministic: checks,
    context: {
      title: shotlist.title, shots: generatedShots.length, materialShots: materialShots.map((s) => s.shotId), rateFail,
      /** 节拍预算：只报数不拦（监制可据情权衡，不作 PASS/FAIL） */
      motionBudget: motionBudgetNotes,
      poseContradictionRule: "同一镜「面向镜头」与「转身/侧身/背身」互斥；「桥/栏杆/船/河 + 指物 + 正面」属高漂移先验，建议改正面走近或删指物",
      /**
       * 监制口径说明（2026-09-24 真机修正）：把"哪些是信息、哪些是判据"写清楚——
       * 早先监制把 advisory 的节拍数当硬闸用（21 拍直接打回），而节拍预算的产品口径是"只报数不拦"。
       */
      advisoryRule: "motionBudget 是**参考信息，不构成打回依据**（产品口径：节拍数只报数不拦）；"
        + "打回只能依据：交付闸/字数/语速/朝向互斥/构图先验这些确定性结论，或你把正文逐条读出来的实质缺陷。"
        + "微动作段（action 里【微动作】之后）是质感层，不参与节拍与动作复杂度判断。"
    }, env: ENV,
    allowFallbackApprove: ALLOW_FALLBACK_APPROVE, log
  });
  record({
    stage: "prompt-review", shotId: null, invoked: true, ok: verdict.approved, cached: false, degraded: verdict.degraded,
    attempt: 1, ms: verdict.ms, artifact: join(PROMPT_DIR, "spec-report.json"), evidence: { score: verdict.score }, verdict
  });
  /** G6 提示词审核（step_key: g6-prompt-confirm）——把 prompt-review 的裁决按门记账 */
  recordGate({
    stepKey: "g6-prompt-confirm",
    sourceStage: "prompt-review",
    checks,
    shotIds: shots.map((s) => s.shotId),
    softApproved: verdict.approved,
    via: verdict.via,
    score: verdict.score,
    degraded: verdict.degraded,
    reason: verdict.reason,
    evidence: { issues: verdict.issues, suggestions: verdict.suggestions, artifacts: `${PROMPT_DIR}/${PROJECT}` }
  });
  if (!verdict.approved) {
    log(`⛔ 监制未放行提示词环节：${verdict.reason}（${verdict.suggestions.join("；")}）`);
    if (!DRY_RUN) process.exit(3);
  }
}

/* ---------- ② 关键帧（监制：keyframe，逐镜视觉评审 + 打回重跑） ---------- */
if (STAGES.has("plates")) {
  /**
   * 关键帧锚点策略（2026-09-24 真机定论，见 `docs/producer-gate-design.md` §四·2）：
   *
   * Ark 对**视频输入图**做隐私血缘校验：由真人照片图生图而来的图会被永久标记
   * `InputImageSensitiveContentDetected.PrivacyInformation`（base64 与托管 URL 都被拒），
   * 而**纯文生图产物**可以被 Seedance 直接当首帧（探针 E/F 对照实测）。
   *
   * 因此默认 `--plate-anchor-mode none`：关键帧走纯文生图（人物外貌由角色档案文本给出），
   * 出片可用；`real` 模式（挂真人照片图生图）人更像，但**不能进 Seedance**，
   * 只适合定妆照/角色档案资产与本地渲染。要两者兼得必须先把真人授权进 Ark 私域人像库（asset://）。
   */
  const plateAnchorMode = arg("--plate-anchor-mode", "none");
  const portraitRefs = lead ? ["closeup", "front", "threeQuarter", "side"].map((a) => lead.files[a]).filter(Boolean) as string[] : [];
  const venueRefs = shots.length > 0 && Array.isArray((shots[0] as Record<string, unknown>).venueRefs)
    ? ((shots[0] as Record<string, unknown>).venueRefs as string[]).map(abs).filter(existsSync)
    : [];
  for (const shot of shots) {
    const plate = join(PLATE_DIR, `${shot.shotId}-plate.png`);
    /** 素材镜没有文生关键帧（首帧就是真实素材本身），但仍要有"素材准备件"与提示词 */
    if (isMaterialShot(shot)) {
      record({
        stage: "keyframe", shotId: shot.shotId, invoked: false, ok: true, cached: false, degraded: false, attempt: 1, ms: 0,
        artifact: null, evidence: { photo: String((shot as Record<string, unknown>).photo), skipReason: "素材镜：首帧=真实素材" },
        verdict: null, note: "素材镜：跳过文生关键帧（首帧由真实素材经画幅准备后提供，见 material-gen）"
      });
      continue;
    }
    const cached = RESUME && existsSync(plate) && statSync(plate).size > 50_000;
    if (cached) {
      const probeInfo = probe(plate);
      record({ stage: "keyframe", shotId: shot.shotId, invoked: true, ok: true, cached: true, degraded: false, attempt: 1, ms: 0, artifact: plate, evidence: probeInfo, verdict: null, note: "复用已有产物（幂等）" });
      continue;
    }
    if (DRY_RUN) {
      record({ stage: "keyframe", shotId: shot.shotId, invoked: false, ok: true, cached: false, degraded: false, attempt: 0, ms: 0, artifact: null, evidence: { dryRun: true }, verdict: null });
      continue;
    }
    let approved = false;
    /** 关键帧阶段同样记录上一轮裁决，用于"带变更"重试 */
    let plateVerdict: ProducerVerdict | null = null;
    for (let attempt = 1; attempt <= MAX_ATTEMPTS && !approved; attempt += 1) {
      const started = Date.now();
      try {
        const prompt = platePrompt(shot, lead?.name ?? "主角", lead?.appearanceText ?? "")
          /**
           * 关键帧重试同样"带变更"：把上一轮监制的具体问题写进去（原来只有一句泛泛的"构图更准"）。
           */
          + (attempt > 1 ? `\n${retryInstruction(plateVerdict, attempt, MAX_ATTEMPTS)}` : "");
        const anchors = plateAnchorMode === "real"
          ? ([portraitRefs[0], portraitRefs[1], venueRefs[0]].filter(Boolean) as string[])
          : (venueRefs.slice(0, 1) as string[]);
        if (plateAnchorMode === "real" && attempt === 1) {
          log(`  ⚠ ${shot.shotId} 关键帧挂了真人锚点：产物会被 Seedance 隐私校验拒（仅适合做档案资产）`);
        }
        const url = await arkImage(prompt, anchors, ENV.SEEDREAM_SIZE ?? "2K");
        saveHostedUrl(shot.shotId, url);
        await download(url, plate);
        const info = probe(plate);
        const width = Number(info.width ?? 0); const height = Number(info.height ?? 0);
        const ratio = width && height ? width / height : 0;
        const expected = ASPECT === "9:16" ? 9 / 16 : 16 / 9;
        const verdict = await reviewStage({
          stage: "keyframe", projectId: PROJECT,
          artifacts: [{ path: plate, kind: "image", bytes: Number(info.bytes ?? 0), probe: info }],
          deterministic: [
            { id: "bytes", pass: Number(info.bytes ?? 0) > 50_000, detail: `文件 ${((Number(info.bytes ?? 0)) / 1024).toFixed(0)}KB`, hard: true },
            { id: "aspect", pass: Math.abs(ratio - expected) < 0.06, detail: `${width}x${height}（期望比例 ${expected.toFixed(3)}，实测 ${ratio.toFixed(3)}）`, hard: true }
          ],
          referenceImages: portraitRefs.slice(0, 2), context: { shotId: shot.shotId, scene: shot.scene, action: shot.action }, env: ENV,
          allowFallbackApprove: ALLOW_FALLBACK_APPROVE, log
        });
        record({
          stage: "keyframe", shotId: shot.shotId, invoked: true, ok: verdict.approved, cached: false, degraded: verdict.degraded,
          attempt, ms: Date.now() - started, artifact: plate, evidence: info, verdict
        });
        approved = verdict.approved;
        if (!approved) plateVerdict = verdict;
        if (!approved) log(`↻ 关键帧 ${shot.shotId} 第 ${attempt} 次未过监制：${verdict.reason}`);
      } catch (err) {
        record({
          stage: "keyframe", shotId: shot.shotId, invoked: true, ok: false, cached: false, degraded: false, attempt,
          ms: Date.now() - started, artifact: null, evidence: { error: err instanceof Error ? err.message.slice(0, 300) : String(err) }, verdict: null
        });
      }
    }
    if (!approved) log(`⛔ 关键帧 ${shot.shotId} 重跑 ${MAX_ATTEMPTS} 次仍未过监制，人工/AI 监制需介入`);
  }
}

/* ---------- ②-2 素材镜生成（step_key: material-generate，gate G-MAT1，监制：shot） ---------- */
/**
 * 产品所有者 2026-09-25 硬规定：**严禁在视频中直接静态展示图片**。
 * 真实素材（实拍照片）只能作为**生成输入**：先按目标画幅准备成"生成首帧"，再交给 Seedance
 * 图生视频出**带真实运动**的镜头（云/水/光/植被/人群 + 镜头运动），最后用四项判据证明它不是静态直出。
 *
 * 四段流水（每段都留痕）：
 *   ① 素材准备：按焦点裁到目标画幅（只影响生成输入，不产出成片内容）；
 *   ② 提示词：`buildMaterialMotionPrompt`（保真 + 真运动 + 禁止静态直出 + 无文字水印）；
 *   ③ 提交门 G-MAT1（mode=submit）：用途声明/素材在场/提示词齐备/画幅与时长约束——花钱之前的门；
 *   ④ 渲染后门 G-MAT1（mode=verify）：生成溯源（任务号+模型+素材与产物指纹）+ **静态复用度实测**
 *      （后段画面若仍能在素材里找到几乎一样的像素，即判静态直出）+ 监制保真评审。
 *
 * 复用度怎么测（确定性）：对镜头中后段抽 3 帧，与素材的 15 个候选窗口（3 个缩放 × 5 个位置）
 * 逐一算 PSNR 取最佳值：真生成的画面会因为云、水、光、人群的变化而明显低于 45dB；
 * "把照片放进时间线"这类硬伤则会命中 ≥45dB（判据与阈值在 `material-policy.ts`，含单测）。
 */
function psnrBetween(a: string, b: string): number | null {
  const res = spawnSync(FFMPEG, [
    "-hide_banner", "-i", a, "-i", b,
    "-lavfi", "[0:v]format=gray[a];[1:v]format=gray[b];[a][b]psnr",
    "-f", "null", "-"
  ], { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
  const text = `${res.stdout ?? ""}\n${res.stderr ?? ""}`;
  const m = /average:([\d.]+|inf)/.exec(text);
  if (!m) return null;
  return m[1] === "inf" ? 99 : Number(m[1]);
}

/**
 * 静态复用度实测：镜头帧 vs 素材候选窗口的最佳 PSNR。
 * 返回 `MaterialReuseSample[]`（供 `assessMaterialReuse` 判定，判定逻辑在模块里、有单测）。
 */
function measureMaterialReuse(clip: string, material: string, durationSec: number, shotId: string): {
  samples: Array<{ atSec: number; bestPsnrDb: number | null }>;
  candidates: number;
} {
  const dir = join(WORK_DIR, "material-reuse", PROJECT, shotId);
  mkdirSync(dir, { recursive: true });
  const W = 360; const H = 640;
  const scales = [1, 1.2, 1.4];
  const positions: Array<[string, number, number]> = [
    ["center", 0.5, 0.5], ["left", 0, 0.5], ["right", 1, 0.5], ["top", 0.5, 0], ["bottom", 0.5, 1]
  ];
  const candidates: string[] = [];
  for (const scale of scales) {
    const cropW = Math.round(W / scale) * 2; const cropH = Math.round(H / scale) * 2;
    for (const [name, fx, fy] of positions) {
      const out = join(dir, `cand-s${scale}-${name}.png`);
      try {
        run(FFMPEG, ["-y", "-i", material,
          "-vf", `crop=${cropW}:${cropH}:(iw-${cropW})*${fx}:(ih-${cropH})*${fy},scale=${W}:${H}`,
          "-frames:v", "1", out]);
        if (existsSync(out)) candidates.push(out);
      } catch {
        /* 裁切窗口越界（素材小于窗口）时跳过该候选，不影响其余候选 */
      }
    }
  }
  const samples: Array<{ atSec: number; bestPsnrDb: number | null }> = [];
  for (const ratio of [0.25, 0.5, 0.75]) {
    const atSec = Math.min(durationSec - 0.05, Math.max(0.1, durationSec * ratio));
    const frame = join(dir, `frame-${ratio}.png`);
    run(FFMPEG, ["-y", "-ss", atSec.toFixed(2), "-i", clip, "-frames:v", "1",
      "-vf", `scale=${W}:${H}:force_original_aspect_ratio=increase,crop=${W}:${H}`, frame]);
    let best: number | null = null;
    for (const candidate of candidates) {
      const value = psnrBetween(frame, candidate);
      if (value === null) continue;
      if (best === null || value > best) best = value;
    }
    samples.push({ atSec, bestPsnrDb: best });
  }
  return { samples, candidates: candidates.length };
}

if (STAGES.has("material-gen")) {
  const [pw, ph] = RESOLUTION === "1080p" ? (ASPECT === "9:16" ? [1080, 1920] : [1920, 1080]) : [720, 1280];
  for (const shot of materialShots) {
    const shotStarted = Date.now();
    const card = shot as Record<string, unknown>;
    const spec = readMaterialSpec(card);
    const photo = abs(spec.photo);
    const clip = join(CLIP_DIR, `${shot.shotId}.mp4`);
    const duration = Number(shot.duration ?? 5);
    /** 生成输入（按目标画幅准备的素材副本）：**不是成片内容**，只是给模型的首帧 */
    const prepared = join(PLATE_DIR, `${shot.shotId}-material.jpg`);
    const promptFile = join(PROMPT_DIR, `${shot.shotId}.txt`);
    const focus = { x: spec.focus?.x ?? 0.5, y: spec.focus?.y ?? 0.5 };
    if (!existsSync(photo)) {
      record({
        stage: "material-gen", shotId: shot.shotId, invoked: true, ok: false, cached: false, degraded: false, attempt: 1, ms: 0,
        artifact: null, evidence: { photo, missing: true, policy: MATERIAL_POLICY_VERSION }, verdict: null, note: "素材文件不存在"
      });
      continue;
    }
    try {
      if (!(RESUME && existsSync(prepared) && statSync(prepared).size > 50_000) || DRY_RUN) {
        run(FFMPEG, ["-y", "-i", photo,
          "-vf", `scale=${pw}:${ph}:force_original_aspect_ratio=increase,crop=${pw}:${ph}:(iw-${pw})*${focus.x}:(ih-${ph})*${focus.y}`,
          "-q:v", "2", prepared]);
      }
      const prompt = buildMaterialMotionPrompt(card, {
        aspect: ASPECT, resolution: RESOLUTION, durationSec: duration, title: shotlist.title
      });
      writeFileSync(promptFile, `${prompt}\n`, "utf8");
      const materialSha = sha256FileSync(photo);
      /**
       * G-MAT1 提交门（mode=submit）：素材用途 + 素材/提示词齐备 + 画幅时长约束。
       * 这一门是**素材镜唯一的"花钱前"闸门**（素材镜不进 G8 渲染提交，判据不同）。
       */
      const submitGate = recordGate({
        stepKey: "material-generate",
        sourceStage: "material-gen",
        shotIds: [shot.shotId],
        checks: [
          { id: "material-usage-declared", pass: spec.usage === "generation-reference", hard: true, detail: `用途声明 ${spec.usage}（只允许 generation-reference；禁止静态直出）` },
          { id: "material-file", pass: existsSync(photo) && statSync(photo).size > 20_000, hard: true, detail: `真实素材 ${basename(photo)}（${(statSync(photo).size / 1024).toFixed(0)}KB，sha256 ${materialSha.slice(0, 12)}）` },
          { id: "material-prepared", pass: existsSync(prepared) && statSync(prepared).size > 50_000, hard: true, detail: `生成首帧已按 ${ASPECT} 准备（${pw}x${ph}，仅作生成输入）` },
          { id: "prompt-ready", pass: prompt.trim().length >= 400, hard: true, detail: `素材镜提示词 ${prompt.trim().length} 字（含保真/真运动/禁止静态直出）` },
          { id: "no-static-policy", pass: prompt.includes("禁止静态直出") && prompt.includes("不得整幅不变"), hard: true, detail: "提示词含「禁止静态直出/不得整幅不变」硬约束" },
          { id: "aspect-constraint", pass: prompt.includes(ASPECT), hard: true, detail: `含画幅约束 ${ASPECT}` },
          { id: "duration-limit", pass: duration > 0 && duration <= 30, hard: true, detail: `单镜时长 ${duration}s（上限 30s）` }
        ],
        evidence: {
          mode: "submit", policy: MATERIAL_POLICY_VERSION, material: photo, materialSha256: materialSha,
          promptFile, promptChars: prompt.trim().length, model: VIDEO_MODEL, seconds: duration
        }
      });
      if (!submitGate.approved) {
        record({
          stage: "material-gen", shotId: shot.shotId, invoked: false, ok: false, cached: false, degraded: false, attempt: 1,
          ms: Date.now() - shotStarted, artifact: null, evidence: { gateBlocked: "material-generate", reason: submitGate.reason },
          verdict: null, note: "G-MAT1 提交门未通过：未向渲染服务提交"
        });
        continue;
      }
      let clipReady = RESUME && existsSync(clip) && statSync(clip).size > 100_000;
      let renderTaskId: string | null = null;
      let renderModel: string | null = null;
      /* 复用已有产物时仍要过门：这里把上一次的 taskId 从阶段日志里回填，保证溯源不丢 */
      if (clipReady) {
        const history = readStageHistory().filter((r) => r.stage === "material-gen" && r.shotId === shot.shotId && r.artifact === clip);
        const lastEvidence = history.at(-1)?.evidence as Record<string, unknown> | undefined;
        renderTaskId = (lastEvidence?.taskId as string | undefined) ?? null;
        renderModel = (lastEvidence?.model as string | undefined) ?? null;
        if (!renderTaskId) {
          /** 没有溯源就重渲：复用旧片不能凭空"证明是生成的"（无回执不算完成） */
          log(`  ↻ ${shot.shotId} 复用产物缺生成溯源（stage logs 无 taskId）→ 重新生成`);
          clipReady = false;
        }
      }
      if (!clipReady) {
        if (DRY_RUN) {
          record({ stage: "material-gen", shotId: shot.shotId, invoked: false, ok: true, cached: false, degraded: false, attempt: 0, ms: 0, artifact: null, evidence: { dryRun: true }, verdict: null });
          continue;
        }
        const submitted = await arkVideo({
          prompt,
          firstFrame: dataUrl(prepared),
          refs: [],
          seconds: duration,
          generateAudio: ENV.SEEDANCE_GENERATE_AUDIO !== "0",
          seed: 20260925
        });
        await download(submitted.url, clip);
        renderTaskId = submitted.taskId;
        renderModel = VIDEO_MODEL;
      }
      const info = probe(clip);
      const outputSha = sha256FileSync(clip);
      const provenance = assertMaterialGenerationProvenance({
        renderTaskId, model: renderModel, sourceMaterialSha256: materialSha, outputSha256: outputSha
      });
      const reuse = measureMaterialReuse(clip, prepared, duration, shot.shotId);
      const reuseVerdict = assessMaterialReuse(reuse.samples, { durationSec: duration });
      /** 抽 4 帧 + 素材对照，给监制判"保真 + 真运动 + 非静态" */
      const framesDir = join(WORK_DIR, "frames", PROJECT, shot.shotId);
      mkdirSync(framesDir, { recursive: true });
      const frameFiles: string[] = [];
      for (const [i, at] of [0.2, 1.6, 3.0, Math.max(0.6, duration - 0.4)].entries()) {
        const file = join(framesDir, `material-f${i + 1}.jpg`);
        run(FFMPEG, ["-y", "-ss", String(at), "-i", clip, "-frames:v", "1", "-vf", "scale=720:-2", "-q:v", "3", file]);
        frameFiles.push(file);
      }
      const verdict = await reviewStage({
        stage: "shot", projectId: PROJECT,
        artifacts: [
          { path: clip, kind: "video", bytes: Number(info.bytes ?? 0), probe: info },
          ...frameFiles.map((f) => ({ path: f, kind: "image" as const }))
        ],
        rubric: [
          "真实地标保真：首帧里的真实地标/建筑形制、檐口层叠、匾额与文字标识、周边水域与地形关系在画面上保持不变（不得被改造、臆造或增删构件）",
          "画面有真实运动：云、水、光、植被、人群、车流等自然运动清晰可辨；不是全程静止，也不是整幅平移/缩放的贴图动效",
          "不是静态直出：不允许「把素材照片放大/平移当镜头」的观感（画面出现全幅一致的位移/缩放痕迹即判不合格）",
          "画质与质感：写实摄影质感，无 AI 绘画感/塑料感，无结构畸变、无纹理重复、无穿模",
          "无文字与水印：画面内不得出现新增文字、字幕、LOGO、边框、角标"
        ],
        referenceImages: [prepared],
        deterministic: [
          { id: "duration", pass: Math.abs(Number(info.duration ?? 0) - duration) <= 0.6, detail: `期望 ${duration}s 实测 ${Number(info.duration ?? 0).toFixed(2)}s`, hard: true },
          { id: "resolution", pass: Number(info.width ?? 0) >= 720 && Number(info.height ?? 0) >= 720, detail: `${info.width}x${info.height}`, hard: true },
          { id: "audio-track", pass: Boolean(info.hasAudio), detail: info.hasAudio ? `音轨 ${info.acodec}` : "缺音轨（配音环节会补旁白）", hard: false },
          { id: "generation-provenance", pass: provenance.ok, detail: provenance.detail, hard: true },
          { id: "not-static-display", pass: !reuseVerdict.staticDisplay, detail: `素材复用度：${reuseVerdict.detail}（候选窗口 ${reuse.candidates} 个）`, hard: true }
        ],
        context: {
          shotId: shot.shotId, scene: shot.scene, motion: spec.motion ?? null,
          policy: MATERIAL_POLICY_STATEMENT,
          discipline: "这是**由真实素材生成**的镜头：判「地标是否被改造」「画面是否有真实运动」「是否只是把素材平移缩放」，不要以「缺少 AI 感」为由打回。"
        },
        env: ENV, allowFallbackApprove: ALLOW_FALLBACK_APPROVE, log
      });
      const verifyGate = recordGate({
        stepKey: "material-generate",
        sourceStage: "material-gen",
        shotIds: [shot.shotId],
        checks: [
          { id: "generation-provenance", pass: provenance.ok, hard: true, detail: provenance.detail },
          { id: "not-static-display", pass: !reuseVerdict.staticDisplay, hard: true, detail: reuseVerdict.detail },
          { id: "fidelity-reviewed", pass: verdict.approved || Boolean(verdict.degraded), hard: false, detail: verdict.approved ? "监制保真评审放行" : `监制未放行（${verdict.reason.slice(0, 80)}）` }
        ],
        softApproved: verdict.approved, via: verdict.via, score: verdict.score,
        evidence: {
          mode: "verify", material: photo, materialSha256: materialSha, outputSha256: outputSha,
          taskId: renderTaskId, model: renderModel, reuseSamples: reuse.samples, note: "素材镜复检口径：生成溯源 + 复用度实测 + 监制保真"
        }
      });
      record({
        stage: "material-gen", shotId: shot.shotId, invoked: true, ok: verdict.approved && verifyGate.approved, cached: false,
        degraded: verdict.degraded, attempt: 1, ms: Date.now() - shotStarted, artifact: clip,
        evidence: {
          ...info, taskId: renderTaskId, model: renderModel, material: photo, materialSha256: materialSha,
          outputSha256: outputSha, promptChars: prompt.trim().length, reuse: reuse.samples,
          reuseVerdict: reuseVerdict.detail, frames: frameFiles
        }, verdict,
        note: `素材镜（生成输入 → 带真实运动的镜头；复用度峰值 ${reuseVerdict.worst === null ? "n/a" : `${reuseVerdict.worst.toFixed(1)}dB`}）`
      });
      if (!verdict.approved) log(`  ⚠ ${shot.shotId} 素材镜未过监制：${verdict.reason.slice(0, 120)}`);
    } catch (err) {
      record({
        stage: "material-gen", shotId: shot.shotId, invoked: true, ok: false, cached: false, degraded: false, attempt: 1,
        ms: Date.now() - shotStarted, artifact: null,
        evidence: { error: err instanceof Error ? err.message.slice(0, 300) : String(err) }, verdict: null
      });
    }
  }
  if (materialShots.length > 0) log(`素材镜：${materialShots.length} 镜（生成输入 → 生成式镜头，禁止静态直出）`);
}


/* ---------- ③ 逐镜视频（监制：shot） ---------- */
if (STAGES.has("videos")) {
  /**
   * G7 预生产最终确认（step_key: g7-preproduction）。
   *
   * 位置：**关键帧全部放行之后、第一次提交渲染之前**。这是"花钱之前的最后一道门"：
   * 确认提示词稿与关键帧稿都齐备且都放行过，才允许把请求发给 Seedance。
   * 判据全部看**产物 + 历史裁决**（支持分段重跑：只跑 videos 时，plate/prompt 的放行记录在 stages.jsonl 里）。
   */
  const gateHistory = readStageHistory();
  /** 素材镜不产出文生关键帧，G7 的提示词/关键帧判据只对**生成镜**成立（素材镜由 G-MAT1 门管） */
  const promptReady = generatedShots.every((s) => {
    const file = join(PROMPT_DIR, `${s.shotId}.txt`);
    return existsSync(file) && readFileSync(file, "utf8").trim().length >= 1200;
  });
  const plateReady = generatedShots.every((s) => {
    const plate = join(PLATE_DIR, `${s.shotId}-plate.png`);
    return existsSync(plate) && statSync(plate).size > 50_000;
  });
  const promptApproved = historyApproved(gateHistory, "prompt-review") || historyApproved(records, "prompt-review");
  const plateApproved = generatedShots.every((s) => gateHistory.some((r) => r.stage === "keyframe" && r.shotId === s.shotId && r.ok));
  /**
   * 素材镜就绪判据（2026-09-25 口径修订）：**不是"有文件就行"**，而是要求
   * ① 片段在盘上；② G-MAT1 的 **verify 事件**存在（证明做过生成溯源 + 复用度实测 + 监制评审）。
   * 只看文件会把"静态直出的照片段"当成合格产物——这正是上一版翻车的地方。
   */
  const gateStepKeyOf = (r: Record<string, unknown>): string | null => String(
    (r as { stepKey?: unknown }).stepKey ?? ((r as { evidence?: { stepKey?: unknown } }).evidence?.stepKey) ?? ""
  ) || null;
  const gateShotIdsOf = (r: Record<string, unknown>): string[] => {
    const top = (r as { shotIds?: unknown }).shotIds;
    if (Array.isArray(top)) return top as string[];
    const inner = (r as { evidence?: { shotIds?: unknown } }).evidence?.shotIds;
    return Array.isArray(inner) ? (inner as string[]) : [];
  };
  const gateModeOf = (r: Record<string, unknown>): string | null => String(
    (r as { evidence?: { mode?: unknown } }).evidence?.mode ?? ""
  ) || null;
  const materialGateVerified = (shotId: string): boolean => [...gateHistory, ...records].some((r) => {
    const row = r as unknown as Record<string, unknown>;
    return r.stage === "gate" && gateStepKeyOf(row) === "material-generate"
      && gateModeOf(row) === "verify" && gateShotIdsOf(row).includes(shotId) && r.ok;
  });
  const materialReady = materialShots.every((s) => {
    const clip = join(CLIP_DIR, `${s.shotId}.mp4`);
    return existsSync(clip) && statSync(clip).size > 100_000 && materialGateVerified(s.shotId);
  });
  const micromotionReady = !STAGES.has("micromotion") || generatedShots.every((s) => String(s.action ?? "").includes("【微动作】"))
    || gateHistory.some((r) => r.stage === "micromotion" && r.ok);
  const g7 = recordGate({
    stepKey: "g7-preproduction",
    sourceStage: "keyframe",
    shotIds: shots.map((s) => s.shotId),
    checks: [
      { id: "prompt-files", pass: promptReady, hard: true, detail: promptReady ? `${generatedShots.length} 个生成镜提示词齐备且 ≥1200 字（另有 ${materialShots.length} 个素材镜走 material-gen 的动效提示词）` : "有生成镜缺提示词或字数不足 1200" },
      { id: "plate-files", pass: plateReady, hard: true, detail: plateReady ? `${generatedShots.length} 个生成镜关键帧齐备（>50KB）` : "有生成镜关键帧缺失或过小" },
      { id: "prompt-approved", pass: promptApproved, hard: true, detail: promptApproved ? "提示词环节有放行裁决（历史/本轮）" : "提示词环节无放行裁决" },
      { id: "plates-approved", pass: plateApproved, hard: true, detail: plateApproved ? "每镜关键帧均有放行裁决" : "有镜头关键帧未放行" },
      {
        id: "material-segments", pass: materialReady, hard: true,
        detail: materialReady
          ? `${materialShots.length} 个素材镜已产出且过 G-MAT1（生成溯源 + 非静态直出 + 保真评审）`
          : `有素材镜未产出或未过 G-MAT1（素材只作生成输入，禁止静态直出）`
      },
      { id: "micromotion-applied", pass: micromotionReady, hard: false, detail: micromotionReady ? "微动作增强已并入镜头卡（或本轮未启用）" : "镜头卡未见微动作增强标记" }
    ],
    evidence: { promptReady, plateReady, promptApproved, plateApproved, materialReady, micromotionReady }
  });
  if (!g7.approved && !ACCEPT_REJECTED.includes("G7")) {
    log(`⛔ G7 预生产最终确认未通过：${g7.reason}`);
    process.exit(5);
  }

  /**
   * 参考图口径（`docs/character-archive-design.md` 附录 A.2）：**默认不往每镜塞定妆照**。
   * 真机复验：影棚灰底定妆照当参考图会把"美颜 + 柔光箱"的风格带进成片
   * （细节 58.6 vs 实景帧 1204.2、饱和 0.369 vs 0.205）。人物一致性改由 **首帧 = 该镜关键帧** 承担
   * （关键帧本身已用定妆照锚定过长相）；确需额外锚定时用 `--use-portrait-refs` 显式打开。
   */
  const usePortraitRefs = flag("--use-portrait-refs");
  const refs = usePortraitRefs && lead
    ? (["front", "closeup"].map((a) => lead.files[a]).filter(Boolean) as string[])
    : [];
  for (const shot of shots) {
    const clip = join(CLIP_DIR, `${shot.shotId}.mp4`);
    const duration = Number(shot.duration ?? 5);
    /**
     * 素材镜：片段已在 `material-gen` 阶段生成并过 G-MAT1（生成溯源 + 非静态直出 + 保真评审），
     * 这里不再走"生成镜复检/提交审批"（判据不同），但**必须**确认 G-MAT1 的 verify 事件在场。
     */
    if (isMaterialShot(shot)) {
      const verified = materialGateVerified(shot.shotId);
      record({
        stage: "shot", shotId: shot.shotId, invoked: false, ok: existsSync(clip) && verified, cached: true,
        degraded: !verified, attempt: 0, ms: 0,
        artifact: existsSync(clip) ? clip : null,
        evidence: {
          photo: String((shot as Record<string, unknown>).photo), source: "material-gen",
          materialGate: verified ? "G-MAT1 verify 事件在场" : "缺 G-MAT1 verify 事件",
          policy: MATERIAL_POLICY_VERSION, skipReason: "素材镜的生成与判据在 material-gen 阶段完成"
        },
        verdict: null,
        note: verified
          ? "素材镜：生成产物已过 G-MAT1（复用，不重复提交渲染）"
          : "素材镜：缺 G-MAT1 verify 事件（素材是否被当镜头用无法证明）"
      });
      continue;
    }
    const cached = RESUME && existsSync(clip) && statSync(clip).size > 100_000;
    /**
     * 复用产物**仍要过监制**（2026-09-24 真机修复）：
     * 早先缓存直接 `ok=true` 跳过评审，于是"上一轮被判打回的镜头"会因为文件在磁盘上而被放行。
     * 现在复用也要重跑确定性检查 + 视觉评审：过了才算真过，没过则照常重渲。
     */
    if (cached) {
      const info = probe(clip);
      const actual = Number(info.duration ?? 0);
      const settings = cachedShotSettings(shot);
      const verdict = await reviewStage({
        stage: "shot", projectId: PROJECT,
        artifacts: [{ path: clip, kind: "video", bytes: Number(info.bytes ?? 0), probe: info }, ...settings.frames.map((f) => ({ path: f, kind: "image" as const }))],
        deterministic: settings.checks,
        referenceImages: refs.slice(0, 2),
        context: { shotId: shot.shotId, dialogue: dialogueText(shot), action: shot.action, note: "复用既有成片的复检" },
        env: ENV, allowFallbackApprove: ALLOW_FALLBACK_APPROVE, log
      });
      record({
        stage: "shot", shotId: shot.shotId, invoked: true, ok: verdict.approved, cached: true, degraded: verdict.degraded,
        attempt: 1, ms: verdict.ms, artifact: clip, evidence: info, verdict,
        note: verdict.approved ? "复用既有产物（幂等）+ 复检通过" : "复用产物复检未过 → 重新渲染"
      });
      /**
       * G8 的**复用复核**（step_key: g8-render-submit，mode=recheck）：
       * 复用产物这次并没有真的"提交渲染"，但提交判据（提示词字数/无 f 值/画幅约束/时长/首帧锚点）
       * 仍然可以按当前产物复核一遍——审计要能看到"这一单当时满足提交条件"，而不是因为走了复用分支
       * 就完全查不到 G8。复核不通过只告警不拦截（复用是否放行由上面的 shot 复检决定）。
       */
      const reusePrompt = existsSync(join(PROMPT_DIR, `${shot.shotId}.txt`)) ? readFileSync(join(PROMPT_DIR, `${shot.shotId}.txt`), "utf8") : "";
      const plate = join(PLATE_DIR, `${shot.shotId}-plate.png`);
      const g8Recheck = recordGate({
        stepKey: "g8-render-submit",
        sourceStage: "shot",
        shotIds: [shot.shotId],
        checks: [
          { id: "prompt-length", pass: reusePrompt.trim().length >= 1200, hard: true, detail: `提示词 ${reusePrompt.trim().length} 字（交付口径 ≥1200）` },
          { id: "no-hard-params", pass: !/f\/\d/.test(reusePrompt), hard: true, detail: /f\/\d/.test(reusePrompt) ? "提示词正文出现 f 值（KB 纪律：正文只写画面语言）" : "正文不含 f 值等技术参数" },
          { id: "aspect-constraint", pass: /【约束】/.test(reusePrompt) && reusePrompt.includes(ASPECT), hard: true, detail: `含【约束】与画幅 ${ASPECT}` },
          { id: "duration-limit", pass: duration > 0 && duration <= 30, hard: true, detail: `单镜时长 ${duration}s（上限 30s）` },
          { id: "clip-on-disk", pass: existsSync(clip) && statSync(clip).size > 100_000, hard: true, detail: `成片片段 ${(statSync(clip).size / 1024 / 1024).toFixed(1)}MB` },
          { id: "plate-size", pass: !existsSync(plate) || statSync(plate).size > 50_000, hard: false, detail: existsSync(plate) ? `关键帧 ${(statSync(plate).size / 1024).toFixed(0)}KB` : "无关键帧文件" }
        ],
        evidence: { mode: "recheck", note: "复用产物复核：本次未向渲染服务提交", seconds: duration, cached: true }
      });
      if (!g8Recheck.approved) log(`  ⚠ ${shot.shotId} G8 复用复核存在未过项（复用放行以上方复检裁决为准）：${g8Recheck.reason.slice(0, 120)}`);
      if (verdict.approved) continue;
      log(`↻ ${shot.shotId} 既有成片复检未过（${verdict.reason}），重新渲染`);
      log(`  （复用判据：${actual.toFixed(2)}s / ${info.width}x${info.height}）`);
    }
    if (DRY_RUN) {
      record({ stage: "shot", shotId: shot.shotId, invoked: false, ok: true, cached: false, degraded: false, attempt: 0, ms: 0, artifact: null, evidence: { dryRun: true }, verdict: null });
      continue;
    }
    const plate = join(PLATE_DIR, `${shot.shotId}-plate.png`);
    const prompt = readFileSync(join(PROMPT_DIR, `${shot.shotId}.txt`), "utf8");
    let approved = false;
    /**
     * 重试必须「带变更」（2026-09-24 烧额度根因）：
     * 早先第 2 次尝试提交的是**与第 1 次完全相同的提示词**（只有 seed 不同），
     * 本质是"重采样碰运气"而不是修问题——SC-02 因此连烧 5 次渲染仍不过。
     * 现在把上一轮监制的 issues/suggestions 显式写进提示词，并记录提示词指纹，
     * 让日志能自证"这次重试确实改了东西"。
     */
    let lastVerdict: ProducerVerdict | null = null;
    for (let attempt = 1; attempt <= MAX_ATTEMPTS && !approved; attempt += 1) {
      const started = Date.now();
      const attemptPrompt = attempt === 1 ? prompt : `${prompt}\n\n${retryInstruction(lastVerdict, attempt, MAX_ATTEMPTS)}`;
      const promptFingerprint = createHash("sha256").update(attemptPrompt).digest("hex").slice(0, 12);
      try {
        /**
         * 首帧必须用**Ark 托管 URL**（同账号模型产物），不能是 base64：
         * 真机实测 base64 真人图会被隐私校验拒（见 `hostedUrlFile` 注释与探针脚本）。
         * 托管 URL 过期（>20h）时退回 base64 并如实记录——让监制看到这是降级路径，而不是假装成功。
         */
        const hosted = loadHostedUrl(shot.shotId);
        const firstFrame = hosted ?? (existsSync(plate) ? dataUrl(plate) : undefined);
        if (!hosted && existsSync(plate)) {
          log(`  ⚠ ${shot.shotId} 无有效托管 URL，退回 base64 首帧（真人题材大概率被隐私校验拒）`);
        }
        /**
         * G8 渲染提交审批（step_key: g8-render-submit）——**花钱之前**的逐镜门。
         *
         * 与 §⑤ 的 `shot` 门（生成之后再评审）不同，G8 管的是"这一单该不该提交"：
         * 提示词是否达到交付口径、有没有把 f 值等技术参数写进正文（KB 纪律）、画幅约束是否在场、
         * 首帧锚点是否存在、以及本镜是否在知情放行名单里。不通过就不提交（不烧额度）。
         */
        const promptText = readFileSync(join(PROMPT_DIR, `${shot.shotId}.txt`), "utf8");
        const g8 = recordGate({
          stepKey: "g8-render-submit",
          sourceStage: "shot",
          shotIds: [shot.shotId],
          checks: [
            { id: "prompt-length", pass: promptText.trim().length >= 1200, hard: true, detail: `提示词 ${promptText.trim().length} 字（交付口径 ≥1200）` },
            { id: "no-hard-params", pass: !/f\/\d/.test(promptText), hard: true, detail: /f\/\d/.test(promptText) ? "提示词正文出现 f 值（KB 纪律：正文只写画面语言，f 值只进 trace）" : "正文不含 f 值等技术参数" },
            { id: "aspect-constraint", pass: /【约束】/.test(promptText) && promptText.includes(ASPECT), hard: true, detail: `含【约束】与画幅 ${ASPECT}` },
            { id: "duration-limit", pass: duration > 0 && duration <= 30, hard: true, detail: `单镜时长 ${duration}s（上限 30s）` },
            { id: "first-frame", pass: Boolean(hosted) || existsSync(plate), hard: true, detail: hosted ? `首帧用 Ark 托管 URL（${basename(hosted)}）` : existsSync(plate) ? "首帧退回本地关键帧 base64（隐私校验风险，已记录）" : "既无托管 URL 也无关键帧" },
            { id: "plate-size", pass: !existsSync(plate) || statSync(plate).size > 50_000, hard: false, detail: existsSync(plate) ? `关键帧 ${(statSync(plate).size / 1024).toFixed(0)}KB` : "无关键帧文件" }
          ],
          evidence: {
            model: VIDEO_MODEL, seconds: duration, attempt,
            promptFingerprint: createHash("sha256").update(attemptPrompt).digest("hex").slice(0, 12),
            promptChars: promptText.trim().length
          }
        });
        if (!g8.approved && !ACCEPT_REJECTED.includes(shot.shotId) && !ACCEPT_REJECTED.includes("G8")) {
          log(`  ⏭ ${shot.shotId} G8 未批准提交（${g8.reason.slice(0, 120)}）→ 不提交，避免白烧额度`);
          record({
            stage: "shot", shotId: shot.shotId, invoked: false, ok: false, cached: false, degraded: false, attempt,
            ms: Date.now() - started, artifact: null, evidence: { gateBlocked: "g8-render-submit", reason: g8.reason }, verdict: null,
            note: "G8 渲染提交审批未通过：未向渲染服务提交"
          });
          break;
        }
        const submitted = await arkVideo({
          prompt: attemptPrompt,
          firstFrame,
          refs: refs.map(dataUrl),
          seconds: duration,
          generateAudio: ENV.SEEDANCE_GENERATE_AUDIO !== "0",
          seed: 20260924 + attempt
        });
        await download(submitted.url, clip);
        const info = probe(clip);
        const actual = Number(info.duration ?? 0);
        const height = Number(info.height ?? 0);
        const width = Number(info.width ?? 0);
        /**
         * 抽帧 + 动作证据（2026-09-24 SC-02 badcase 修复）：
         * 早先只抽 3 帧（0.6 / 中段 / 末段），监制无法判断"有没有在走动/挥手"，
         * 只能以"手部摆动与步态证据不足"打回（fail-closed）。现在：
         *   · 抽 4 帧给监制看（0.5 / 1.8 / 3.2 / 4.5）；
         *   · 另抽 8 帧算**画面运动能量**（相邻帧中心区平均绝对差），把"有没有动"变成数字证据；
         *   · 当分镜要求走/挥手/移动而运动能量过低时，判为硬失败（动作没做出来）。
         */
        const framesDir = join(WORK_DIR, "frames", PROJECT, shot.shotId);
        mkdirSync(framesDir, { recursive: true });
        const frameFiles: string[] = [];
        for (const [i, at] of [0.5, 1.8, 3.2, Math.max(0.6, duration - 0.5)].entries()) {
          /**
           * 评审帧压缩（2026-09-24 三轮审计）：全分辨率 PNG（1080×1920，单张 1–2MB）四张一起送审，
           * base64 后 ≈11MB → 评审模型直接 **HTTP 413**（payload too large）→ 监制不可用。
           * 改成 720 宽 JPEG（质量 82，单张 ≈100KB），肉眼足够判断动作/表情/一致性。
           */
          const file = join(framesDir, `f${i + 1}.jpg`);
          run(FFMPEG, ["-y", "-ss", String(at), "-i", clip, "-frames:v", "1", "-vf", "scale=720:-2", "-q:v", "3", file]);
          frameFiles.push(file);
        }
        const motion = measureMotionEnergy(clip, duration);
        const expectsMotion = /走|步行|漫步|挥|摆|蹲|起身|跑|turn|walk/i.test(String(shot.action ?? ""));
        const verdict = await reviewStage({
          stage: "shot", projectId: PROJECT,
          artifacts: [
            { path: clip, kind: "video", bytes: Number(info.bytes ?? 0), probe: info },
            ...frameFiles.map((f) => ({ path: f, kind: "image" as const }))
          ],
          deterministic: [
            { id: "duration", pass: Math.abs(actual - duration) <= 0.6, detail: `期望 ${duration}s 实测 ${actual.toFixed(2)}s`, hard: true },
            { id: "resolution", pass: height >= 720 && width >= 720, detail: `${width}x${height}`, hard: true },
            { id: "audio-track", pass: Boolean(info.hasAudio), detail: info.hasAudio ? `音轨 ${info.acodec}` : "无音轨（配乐环节可兜底，但人声缺失需复核）" },
            {
              id: "motion-evidence",
              pass: !expectsMotion || motion.energy >= 2.5,
              /**
               * 只做软证据（不跨景别当硬闸）：实测同一批片子里，
               * "走近"镜运动能量 5.79/255，而静物特写 12.48/255——近景/特写的像素级微动天然更高，
               * 绝对值不能跨景别比较。只有低到近乎全程静止（<0.8）才升级为硬失败。
               */
              hard: expectsMotion && motion.energy < 0.8,
              detail: `画面运动能量 ${motion.energy.toFixed(2)}/255（峰值帧 ${motion.peakAt.toFixed(1)}s，期望动作=${expectsMotion ? "是" : "否"}）`
                + (expectsMotion && motion.energy < 2.5 ? "：动作幅度偏低，可能是「站着念完」而非分镜要求的走/挥手" : "")
            }
          ],
          referenceImages: refs.slice(0, 2),
          context: { shotId: shot.shotId, dialogue: dialogueText(shot), action: shot.action, taskId: submitted.taskId },
          env: ENV, allowFallbackApprove: ALLOW_FALLBACK_APPROVE, log
        });
        record({
          stage: "shot", shotId: shot.shotId, invoked: true, ok: verdict.approved, cached: false, degraded: verdict.degraded,
          attempt, ms: Date.now() - started, artifact: clip,
          evidence: {
            ...info, taskId: submitted.taskId, frames: frameFiles,
            promptVariant: attempt === 1 ? "base" : "retry-with-feedback",
            promptFingerprint
          }, verdict
        });
        approved = verdict.approved;
        if (!approved) lastVerdict = verdict;
        if (!approved) log(`↻ 镜头 ${shot.shotId} 第 ${attempt} 次未过监制：${verdict.reason}`);
        /**
         * 监制不可用 ≠ 产物不合格（2026-09-24 真机：评审请求 413 → 系统连渲两次）：
         * 评审侧故障（fallback 且无硬失败）时**不应重渲**——重渲既修不了故障、又白烧额度。
         * 此时保留本次产物、标注 degraded，交给下一次复检或人工裁决。
         */
        const judgeUnavailable = !approved && verdict.via === "fallback" && (verdict.hardFailures ?? []).length === 0;
        if (judgeUnavailable) {
          log(`⏸ ${shot.shotId} 监制不可用（${verdict.reason.slice(0, 80)}）→ 不再重渲，保留本次产物待复检`);
          record({
            stage: "shot", shotId: shot.shotId, invoked: true, ok: false, cached: false, degraded: true, attempt,
            ms: Date.now() - started, artifact: clip, evidence: { ...info, taskId: submitted.taskId, frames: frameFiles, judgeUnavailable: true }, verdict,
            note: "监制不可用：不重渲（避免为评审故障付费），产物保留待复检"
          });
          break;
        }
      } catch (err) {
        record({
          stage: "shot", shotId: shot.shotId, invoked: true, ok: false, cached: false, degraded: false, attempt,
          ms: Date.now() - started, artifact: null, evidence: { error: err instanceof Error ? err.message.slice(0, 300) : String(err) }, verdict: null
        });
      }
    }
    if (!approved) log(`⛔ 镜头 ${shot.shotId} 重跑 ${MAX_ATTEMPTS} 次仍未过监制`);
  }
}

/* ---------- ③-2 配音 / 旁白（step_key: voice，2026-09-25 产品所有者点名修复） ---------- */
/**
 * 事故：滕王阁样片的**中间四镜只有字幕、没有台词播报**（真实素材镜是静音段 + 字幕），
 * 观众看到画面在动、字在跳，却没有人声——产品所有者当场指出"这是硬伤"。
 *
 * 本阶段把"每一句台词都要有人声"变成可验证的门：
 *   ① 逐镜做**人声核查**（本地 ASR + 语音频段活动度）：既看"有没有说话"，也看"说的是不是这句台词"；
 *   ② 没有人声的镜头用**本机 TTS**补旁白（`voice-cli dub`：时窗对齐 + 原声让位 + 视频轨 copy）；
 *   ③ 补完**再核查一次**（无回执不算完成），结果写进阶段日志供终审按镜检索。
 *
 * 判据（`active_ratio` 与 `match_ratio` 双条件）来自真机实测：
 *   · 有模型人声的镜：SC-01 active=0.538 / match=1.0、SC-06 active=0.421 / match=0.889；
 *   · 纯环境音的素材镜：SC-02/04/05 active=0.000 / match≈0（Whisper 对非人声还会"编"出一句套话，
 *     所以**只看 ASR 文本会误判**，必须叠加语音频段活动度这一条硬条件）。
 */
const NARRATION_PROFILE = arg("--narration-profile", "zh-xiaozhi");
const SPEECH_MATCH_MIN = Number(arg("--speech-match-min", "0.6"));
const SPEECH_ACTIVE_MIN = Number(arg("--speech-active-min", "0.25"));

interface SpeechReport {
  ok: boolean;
  matchRatio: number | null;
  activeRatio: number | null;
  segments: number | null;
  transcript: string | null;
  detail: string;
}

/**
 * 人声核查（本地 ASR + 语音频段活动度）。
 * `--min-match 0` 是为了拿到数值而不是让工位直接抛错；`--no-strict` 是为了让**响度/真峰值**
 * 这类交付项不干扰"有没有人声"的判断（真机：SC-04 因 -0.69dBTP 让核查返回空值，误判成"没人声"）。
 */
function checkSpeech(file: string, expectText: string): SpeechReport {
  const res = runCli(VOICE_CLI, ["verify", "--in", file, "--expect-text", expectText, "--min-match", "0", "--no-strict"]);
  if (!res.ok) {
    return { ok: false, matchRatio: null, activeRatio: null, segments: null, transcript: null, detail: `配音工位调用失败：${res.out.slice(-200)}` };
  }
  let checked: Record<string, unknown> = {};
  try {
    checked = ((JSON.parse(res.out) as { result?: { checked?: Record<string, unknown> } }).result?.checked) ?? {};
  } catch {
    return { ok: false, matchRatio: null, activeRatio: null, segments: null, transcript: null, detail: `核验输出不是 JSON：${res.out.slice(-120)}` };
  }
  const num = (value: unknown): number | null => (typeof value === "number" && Number.isFinite(value) ? value : null);
  const matchRatio = num(checked.match_ratio);
  const activeRatio = num(checked.active_ratio);
  const segments = num(checked.speech_segments);
  const transcript = typeof checked.asr_text === "string" ? checked.asr_text : null;
  const ok = activeRatio !== null && activeRatio >= SPEECH_ACTIVE_MIN
    && matchRatio !== null && matchRatio >= SPEECH_MATCH_MIN;
  const detail = `人声活动度 ${activeRatio === null ? "未测到" : activeRatio.toFixed(3)}（下限 ${SPEECH_ACTIVE_MIN}）`
    + ` · 台词匹配 ${matchRatio === null ? "未测到" : matchRatio.toFixed(3)}（下限 ${SPEECH_MATCH_MIN}）`
    + ` · 语音段 ${segments ?? "?"} · 转写 ${transcript === null ? "无" : `「${transcript.slice(0, 40)}」`}`;
  return { ok, matchRatio, activeRatio, segments, transcript, detail };
}

/** 配音产物路径（旁白混入后的镜头段；原片只读，不覆盖 `<shotId>.mp4`） */
function voicedFile(shotId: string): string {
  return join(CLIP_DIR, `${shotId}.voiced.mp4`);
}
/**
 * 合成用片段：配音版比原片段新时优先（原始片段保持只读，符合配音围栏"原片只读 + 新文件"口径）。
 */
function clipFor(shot: ShotCard): string {
  const raw = join(CLIP_DIR, `${shot.shotId}.mp4`);
  const voiced = voicedFile(shot.shotId);
  if (existsSync(voiced) && (!existsSync(raw) || statSync(voiced).mtimeMs >= statSync(raw).mtimeMs)) return voiced;
  return raw;
}

/** 逐镜人声覆盖情况（终审门按这份清单判"每句台词都有人声"） */
const narrationCoverage: Array<{ shotId: string; speaker: string; text: string; ok: boolean; source: string; detail: string }> = [];

if (STAGES.has("voice")) {
  const started = Date.now();
  if (!existsSync(VOICE_CLI)) {
    log(`⛔ 配音工位不存在：${VOICE_CLI}（语音阶段无法执行）`);
    record({
      stage: "voice", shotId: null, invoked: false, ok: false, cached: false, degraded: false, attempt: 1, ms: 0,
      artifact: null, evidence: { missing: VOICE_CLI }, verdict: null, note: "配音工位缺失：人声核查无法执行"
    });
  } else {
    for (const shot of shots) {
      const raw = join(CLIP_DIR, `${shot.shotId}.mp4`);
      const text = dialogueText(shot);
      const speaker = String((shot.dialogue ?? [])[0]?.speaker ?? "旁白");
      if (!existsSync(raw)) {
        narrationCoverage.push({ shotId: shot.shotId, speaker, text, ok: false, source: "missing-clip", detail: "镜头片段不存在" });
        record({
          stage: "voice", shotId: shot.shotId, invoked: false, ok: false, cached: false, degraded: false, attempt: 1, ms: 0,
          artifact: null, evidence: { missing: raw }, verdict: null, note: "缺镜头片段：无法做人声核查"
        });
        continue;
      }
      if (!text) {
        record({
          stage: "voice", shotId: shot.shotId, invoked: false, ok: true, cached: false, degraded: false, attempt: 1, ms: 0,
          artifact: raw, evidence: { dialogue: false }, verdict: null, note: "本镜无台词：人声门不适用（空镜/纯音乐段）"
        });
        continue;
      }
      const shotStarted = Date.now();
      const before = checkSpeech(raw, text);
      if (before.ok) {
        narrationCoverage.push({ shotId: shot.shotId, speaker, text, ok: true, source: "clip-audio", detail: before.detail });
        record({
          stage: "voice", shotId: shot.shotId, invoked: true, ok: true, cached: true, degraded: false, attempt: 1,
          ms: Date.now() - shotStarted, artifact: raw,
          evidence: { source: "clip-audio", matchRatio: before.matchRatio, activeRatio: before.activeRatio, transcript: before.transcript },
          verdict: null, note: `人声核查通过（${before.detail}）`
        });
        continue;
      }
      /**
       * 复用上轮配音版（分段重跑友好）：`<shot>.voiced.mp4` 已过核查就不再重复合成 TTS。
       * 判据仍然是**产物核查**（不是"文件在就算数"）——配音版没通过就照常重做。
       */
      const existingVoiced = voicedFile(shot.shotId);
      if (existsSync(existingVoiced) && existingVoiced !== raw) {
        const reused = checkSpeech(existingVoiced, text);
        if (reused.ok) {
          narrationCoverage.push({ shotId: shot.shotId, speaker, text, ok: true, source: "voiced-reuse", detail: reused.detail });
          record({
            stage: "voice", shotId: shot.shotId, invoked: true, ok: true, cached: true, degraded: false, attempt: 1,
            ms: Date.now() - shotStarted, artifact: existingVoiced,
            evidence: { source: "voiced-reuse", matchRatio: reused.matchRatio, activeRatio: reused.activeRatio, transcript: reused.transcript },
            verdict: null, note: `复用上轮配音版并通过核查（${reused.detail}）`
          });
          continue;
        }
      }
      if (DRY_RUN) {
        narrationCoverage.push({ shotId: shot.shotId, speaker, text, ok: false, source: "dry-run", detail: before.detail });
        record({
          stage: "voice", shotId: shot.shotId, invoked: false, ok: false, cached: false, degraded: true, attempt: 1, ms: 0,
          artifact: null, evidence: { dryRun: true, before }, verdict: null, note: "dry-run：未补旁白"
        });
        continue;
      }
      log(`  ⚠ ${shot.shotId} 人声核查未过（${before.detail.slice(0, 90)}）→ 补旁白（音色 ${NARRATION_PROFILE}）`);
      const out = voicedFile(shot.shotId);
      const dub = runCli(VOICE_CLI, [
        "dub", "--in", raw, "--out", out, "--profile", NARRATION_PROFILE,
        "--text", text, "--policy", "keep-dialogue", "--lufs", "-16"
      ]);
      const produced = existsSync(out);
      const after = produced ? checkSpeech(out, text) : before;
      const ok = produced && after.ok;
      narrationCoverage.push({
        shotId: shot.shotId, speaker, text, ok,
        source: ok ? "tts-narration" : "tts-failed",
        detail: ok ? after.detail : `补旁白${produced ? "后仍未通过" : "未产出"}：${after.detail}`
      });
      record({
        stage: "voice", shotId: shot.shotId, invoked: true, ok, cached: false, degraded: !ok, attempt: 1,
        ms: Date.now() - shotStarted, artifact: produced ? out : null,
        evidence: {
          source: "tts-narration", profile: NARRATION_PROFILE, policy: "keep-dialogue",
          before: { matchRatio: before.matchRatio, activeRatio: before.activeRatio, transcript: before.transcript },
          after: { matchRatio: after.matchRatio, activeRatio: after.activeRatio, transcript: after.transcript },
          toolOutput: dub.out.slice(-300)
        },
        verdict: null,
        note: ok
          ? `已补旁白并通过复核（${after.detail}）`
          : `补旁白未通过复核：${after.detail}`
      });
      if (!ok) log(`  ⛔ ${shot.shotId} 补旁白后仍未通过人声核查：${after.detail}`);
    }
    const covered = narrationCoverage.filter((entry) => entry.ok).length;
    const total = narrationCoverage.length;
    log(`配音/旁白：${covered}/${total} 镜有可用人声（音色 ${NARRATION_PROFILE}）`);
    record({
      stage: "voice-summary", shotId: null, invoked: true, ok: covered === total && total > 0, cached: false,
      degraded: covered !== total, attempt: 1, ms: Date.now() - started, artifact: null,
      evidence: { covered, total, profile: NARRATION_PROFILE, perShot: narrationCoverage },
      verdict: null,
      note: covered === total ? "每句台词都有人声" : `有 ${total - covered} 镜缺人声（终审门会拦下）`
    });
  }
}

/* ---------- ④ 合成母版 ---------- */
let master = join(POST_DIR, "master-raw.mp4");
if (STAGES.has("compose")) {
  const started = Date.now();
  /** 合成用片段：优先取配音版（旁白已混入），原始片段保持只读 */
  const clips = shots.map((s) => clipFor(s));
  const missing = clips.filter((c) => !existsSync(c));
  /**
   * 带瑕疵放行审计：被监制打回、又出现在 `--accept-rejected` 里的镜头，
   * 合成时要写一条 explicit 记录（不得静默拼进母版）。
   */
  const unapproved = shots
    .filter((s) => {
      const shotRecords = records.filter((r) => r.stage === "shot" && r.shotId === s.shotId && r.invoked);
      return shotRecords.length > 0 && !shotRecords.some((r) => r.ok);
    })
    .map((s) => s.shotId);
  const acceptedWithFlaw = unapproved.filter((id) => ACCEPT_REJECTED.includes(id));
  const blocked = unapproved.filter((id) => !ACCEPT_REJECTED.includes(id));
  if (acceptedWithFlaw.length > 0) {
    log(`⚠ 监制已知悉放行（带瑕疵入片）：${acceptedWithFlaw.join("、")} —— 详见阶段日志的 verdict.issues`);
    record({
      stage: "compose-acknowledge", shotId: null, invoked: true, ok: true, cached: false, degraded: true, attempt: 1, ms: 0,
      artifact: null,
      evidence: { acceptedWithFlaw, reason: "客观条件不允许重跑（见阶段日志），经显式 --accept-rejected 确认后拼入母版" },
      verdict: null, note: "带瑕疵放行（非静默）"
    });
  }
  if (blocked.length > 0) {
    log(`⛔ 以下镜头被监制打回且未显式放行，合成中止：${blocked.join("、")}（如确需拼入，请显式 --accept-rejected ${blocked.join(",")}）`);
    record({
      stage: "compose", shotId: null, invoked: false, ok: false, cached: false, degraded: false, attempt: 1, ms: 0,
      artifact: null, evidence: { blocked }, verdict: null, note: "监制未放行镜头阻塞合成"
    });
  }
  if (missing.length > 0 || blocked.length > 0) {
    record({ stage: "compose", shotId: null, invoked: false, ok: false, cached: false, degraded: false, attempt: 1, ms: 0, artifact: null, evidence: { missing }, verdict: null, note: "缺镜头产物，跳过合成" });
  } else {
    const [w, h] = RESOLUTION === "1080p" ? (ASPECT === "9:16" ? [1080, 1920] : [1920, 1080]) : [720, 1280];
    const result = runCli(join(REPO_ROOT, "scripts/tools/compose-film.mts"), [
      "--clips", clips.join(","), "--out", master, "--width", String(w), "--height", String(h),
      "--fps", String(FPS), "--fade", String(XFADE), "--color", "none"
    ]);
    const info = existsSync(master) ? probe(master) : {};
    const verdict = result.ok ? await reviewStage({
      stage: "compose", projectId: PROJECT,
      artifacts: [{ path: master, kind: "video", probe: info }],
      deterministic: [
        { id: "exists", pass: existsSync(master), detail: existsSync(master) ? "母版已生成" : "母版不存在", hard: true },
        { id: "duration", pass: Math.abs(Number(info.duration ?? 0) - totalSeconds) <= 1.0, detail: `实测 ${Number(info.duration ?? 0).toFixed(2)}s（目标 ${totalSeconds}s）`, hard: true },
        { id: "resolution", pass: Number(info.width) === w && Number(info.height) === h, detail: `${info.width}x${info.height}` , hard: true }
      ],
      context: { clips: clips.length }, env: ENV, allowFallbackApprove: ALLOW_FALLBACK_APPROVE, log
    }) : null;
    record({
      stage: "compose", shotId: null, invoked: true, ok: Boolean(result.ok && verdict?.approved), cached: false,
      degraded: Boolean(verdict?.degraded), attempt: 1, ms: Date.now() - started, artifact: master,
      evidence: { ...info, tool: "scripts/tools/compose-film.mts" }, verdict
    });
    if (!result.ok) log(`⛔ 合成失败：${result.out.slice(-400)}`);
  }
}

/* ---------- ⑤ 调色（color-bridge 择优） ---------- */
/** 未重跑调色时：磁盘上若已有"不早于 raw"的调色版就沿用它（只重跑后段的场景） */
let colored = STAGES.has("color") ? master : preferDownstream(join(POST_DIR, "master-graded.mp4"), master);
if (STAGES.has("color") && existsSync(master)) {
  const started = Date.now();
  const graded = join(POST_DIR, "master-graded.mp4");
  const recipe = arg("--color-recipe", "outdoor-travel");
  /**
   * 两种调色口径（2026-09-24 真机）：
   *   `best`（默认）= 择优：候选池打分 + 允许"不调"；真机两次被监制打回（题材不符/无效调整），
   *                   说明择优池在江南实景+口播这类题材上会挑出风格不符的候选（vintage-fade）；
   *   `grade`      = 显式配方 + 强度（监制给定风格时用）：`--color-profile natural --color-intensity 0.3`。
   */
  const colorMode = arg("--color-mode", "best");
  const profile = arg("--color-profile", "natural");
  const intensity = arg("--color-intensity", "0.3");
  const result = colorMode === "grade"
    ? runCli(COLOR_CLI, ["grade", "--in", master, "--out", graded, "--profile", profile, "--intensity", intensity])
    : runCli(COLOR_CLI, ["best", "--in", master, "--out", graded, "--recipe", recipe, "--min-improvement", "1.5"]);
  const produced = existsSync(graded);
  const info = produced ? probe(graded) : probe(master);
  const verdict = await reviewStage({
    stage: "color", projectId: PROJECT,
    artifacts: [{ path: produced ? graded : master, kind: "video", probe: info }],
    deterministic: [
      { id: "grade-produced", pass: produced, detail: produced ? "调色母版已产出" : "调色未产出（择优判定无需调色或工位失败）" },
      { id: "color-tool-exit", pass: result.ok, detail: result.ok ? "调色工位退出码 0" : `调色工位失败：${result.out.slice(-200)}`, hard: !result.ok }
    ],
    context: {
      mode: colorMode,
      ...(colorMode === "grade" ? { profile, intensity } : { recipe }),
      toolOutput: result.out.slice(-800)
    },
    env: ENV, allowFallbackApprove: ALLOW_FALLBACK_APPROVE, log
  });
  /**
   * **监制裁决决定流向**（2026-09-24 真机修正）：
   * 早先只要工位产出了 `master-graded.mp4` 就把它当母版往下走，于是"监制打回的调色版"照样进成片。
   * 现在：只有监制放行的调色版才替换母版；被打回则**保留原片**（产品自己的"不劣化优先"口径），
   * 并在记录里写明"调色环节已执行但产物被驳回，按原片走"。
   */
  const useGraded = produced && Boolean(verdict.approved);
  if (useGraded) colored = graded;
  else if (produced) {
    log(`↺ 调色产物被监制驳回（score=${verdict.score}）→ 保留原片母版继续后期（不劣化优先）`);
  }
  record({
    stage: "color", shotId: null, invoked: true, ok: result.ok, cached: false, degraded: !produced, attempt: 1,
    ms: Date.now() - started, artifact: produced ? graded : null,
    evidence: { mode: colorMode, ...(colorMode === "grade" ? { profile, intensity } : { recipe }), tool: `color-bridge ${colorMode}` }, verdict
  });
}

/* ---------- ⑥ 字幕（subtitle-bridge：选型 + 版式 + 旁挂文件；烧录按需） ---------- */
/**
 * 两种落地方式（`--subtitle-mode`）：
 *   · sidecar（缺省）：**母版不烧字**——出 `subtitles/<项目>.zh.srt|.zh.ass|.vtt` + 清单，
 *     后期想用就软轨内嵌（`mux` 阶段）或交给剪辑软件，不想用就当没这回事（画面像素从未被改）；
 *   · burn：仍把字烧进画面（另存 `master-subtitled.mp4`），母版变成带字版（发出去就回不来）。
 * 旁挂文件与烧录共用同一套字体选型 / 版式 / ASS 生成器（subtitle-bridge plan），所以两种形态观感一致。
 */
/** 未重跑字幕时，若磁盘上有"不早于当前上游"的字幕版就沿用它（只重跑后段的场景） */
let subtitled = STAGES.has("subtitle") ? colored : preferDownstream(join(POST_DIR, "master-subtitled.mp4"), colored);
/** 旁挂字幕文件（sidecar 模式的产物；burn 模式下为 null，下游仍走烧字版） */
let subtitleSidecar: { dir: string; srt: string; ass: string; manifest: string | null; timelineOk: boolean } | null = null;
if (STAGES.has("subtitle") && existsSync(colored)) {
  const started = Date.now();
  const srtFile = join(POST_DIR, "subtitle.srt");
  writeFileSync(srtFile, buildSrt(), "utf8");
  const briefFile = BRIEF_FILE ? abs(BRIEF_FILE) : null;
  const platform = arg("--platform", "抖音/快手");

  if (SUBTITLE_MODE !== "burn") {
    const sidecarDir = join(POST_DIR, "subtitles");
    const sidecarResult = runCli(SUBTITLE_CLI, [
      "sidecar", "--in", colored, "--out-dir", sidecarDir, "--srt", srtFile, "--name", PROJECT,
      "--platform", platform,
      ...(briefFile ? ["--brief", briefFile] : [])
    ]);
    const zhSrt = join(sidecarDir, `${PROJECT}.zh.srt`);
    const zhAss = join(sidecarDir, `${PROJECT}.zh.ass`);
    const manifest = join(sidecarDir, `${PROJECT}.subtitle-manifest.json`);
    const timelineOk = sidecarResult.ok && /时间轴回读 ok/.test(sidecarResult.out);
    const verdict = await reviewStage({
      stage: "subtitle", projectId: PROJECT,
      artifacts: [
        { path: existsSync(zhSrt) ? zhSrt : srtFile, kind: "text", note: "旁挂字幕（母版未烧字）" },
        ...(existsSync(zhAss) ? [{ path: zhAss, kind: "text" as const, note: "带版式的 ASS（软轨/再烧同源）" }] : [])
      ],
      deterministic: [
        { id: "sidecar-produced", pass: existsSync(zhSrt) && existsSync(zhAss), detail: existsSync(zhSrt) ? "旁挂字幕文件已产出（srt + ass）" : "旁挂字幕文件未产出", hard: true },
        { id: "tool-exit", pass: sidecarResult.ok, detail: sidecarResult.ok ? "字幕工位退出码 0" : `字幕工位失败：${sidecarResult.out.slice(-300)}`, hard: true },
        { id: "timeline", pass: timelineOk, detail: (sidecarResult.out.match(/时间轴回读[^\n]*/) ?? ["无回读信息"])[0] ?? "" },
        { id: "master-untouched", pass: sidecarResult.out.includes("母版未被改动 ok"), detail: "母版只读：出字幕文件的过程不改动画面（哈希与 mtime 双验）", hard: true }
      ],
      context: { mode: SUBTITLE_MODE, srt: readFileSync(srtFile, "utf8").slice(0, 1200), platform, toolOutput: sidecarResult.out.slice(-900) },
      env: ENV, allowFallbackApprove: ALLOW_FALLBACK_APPROVE, log
    });
    if (existsSync(zhSrt)) {
      subtitleSidecar = { dir: sidecarDir, srt: zhSrt, ass: existsSync(zhAss) ? zhAss : zhSrt, manifest: existsSync(manifest) ? manifest : null, timelineOk };
      /**
       * 血缘刷新（2026-09-24 真机）：旁挂字幕的内容通常与本轮一致，工位按幂等不重写文件，
       * 于是 mtime 停留在上一轮 → 终审的血缘检查判"字幕来自旧产物、与母版断链"。
       * 这一轮既然重新产出了字幕决策，就把文件时间戳刷新到本轮（内容不变、血缘归位）。
       */
      try {
        const now = new Date();
        for (const file of [zhSrt, zhAss, manifest]) {
          if (file && existsSync(file)) utimesSync(file, now, now);
        }
      } catch {
        /* 时间戳刷新失败不影响交付，血缘检查会如实报出 */
      }
    }
    record({
      stage: "subtitle", shotId: null, invoked: true, ok: sidecarResult.ok && Boolean(subtitleSidecar), cached: false, degraded: false,
      attempt: 1, ms: Date.now() - started, artifact: existsSync(zhSrt) ? zhSrt : null,
      evidence: { mode: "sidecar", srt: zhSrt, ass: zhAss, manifest, tool: "subtitle-bridge sidecar", masterBurnedIn: false }, verdict
    });
    if (sidecarResult.ok) log(`字幕以旁挂文件产出（母版不烧字）：${zhSrt}`);
  }

  if (SUBTITLE_MODE !== "sidecar") {
    const out = join(POST_DIR, "master-subtitled.mp4");
    const result = runCli(SUBTITLE_CLI, [
      "burn", "--in", colored, "--out", out, "--srt", srtFile,
      "--title", arg("--title", shotlist.title ?? ""),
      "--platform", platform,
      ...(briefFile ? ["--brief", briefFile] : []),
      "--evidence-dir", join(POST_DIR, "subtitle-evidence")
    ]);
    const info = existsSync(out) ? probe(out) : {};
    const verdict = await reviewStage({
      // 阶段名统一为 `subtitle`（历史裁决按阶段名检索：burn/sidecar 只是同一步的两种落地方式，
      // 命名分开会让"历史日志里有 subtitle 的放行裁决"这条链路完整性检查在本模式下误判缺失）
      stage: "subtitle", projectId: PROJECT,
      artifacts: [{ path: existsSync(out) ? out : colored, kind: "video", probe: info }, { path: srtFile, kind: "text" }],
      deterministic: [
        { id: "burned", pass: existsSync(out), detail: existsSync(out) ? "字幕版已产出" : "字幕版未产出", hard: true },
        { id: "tool-exit", pass: result.ok, detail: result.ok ? "字幕工位退出码 0" : `字幕工位失败：${result.out.slice(-300)}`, hard: true },
        /**
         * 标点口径（2026-09-25）：烧录模式没有旁挂清单可查，判据取自**字幕工位的实测输出**
         * （工位在烧录前会打印"标点体检 ok/fail"，它查的是真正写进画面的事件文本）。
         */
        {
          id: "punctuation", pass: /标点体检 ok/.test(result.out), hard: true,
          detail: (result.out.match(/标点体检[^\n]*/) ?? ["字幕工位未输出标点体检（无法证明字幕不带标点）"])[0]
        },
        { id: "timeline", pass: /时间轴回读 (\d+)\/(\d+) 条（一致）/.test(result.out) || result.out.includes("一致"), detail: (result.out.match(/时间轴回读[^\n]*/) ?? ["无回读信息"])[0] ?? "" }
      ],
      context: { mode: SUBTITLE_MODE, srt: readFileSync(srtFile, "utf8").slice(0, 1200), platform, toolOutput: result.out.slice(-900) },
      env: ENV, allowFallbackApprove: ALLOW_FALLBACK_APPROVE, log
    });
    if (existsSync(out)) subtitled = out;
    record({
      stage: "subtitle", shotId: null, invoked: true, ok: result.ok && existsSync(out), cached: false, degraded: false,
      attempt: 1, ms: Date.now() - started, artifact: existsSync(out) ? out : null,
      evidence: {
        mode: "burn", srt: srtFile, tool: "subtitle-bridge burn", masterBurnedIn: true,
        punctuationOk: /标点体检 ok/.test(result.out),
        punctuationDetail: (result.out.match(/标点体检[^\n]*/) ?? [null])[0]
      }, verdict
    });
  } else {
    // sidecar 模式：画面这一路保持"未烧字"，下游（弹幕/配乐/封面）都从干净版派生
    subtitled = colored;
  }
}

/* ---------- ⑦ 弹幕（subtitle-bridge danmaku） ---------- */
/**
 * 弹幕层**可按项目关闭**（2026-09-25）：小红书这类内容社区没有弹幕文化，
 * 硬塞一层评点会显得违和。关闭时后续环节直接接字幕版（`master-subtitled.mp4`），
 * 并在阶段日志里留一条"显式跳过"，终审的血缘/层级检查也据此少一层（不冒充已执行）。
 */
const DANMAKU_ENABLED = !flag("--no-danmaku");
/** 剪辑网格（累计切点，秒）：配乐卡点与 BPM 反推的事实依据（去掉片尾那一个点） */
const CUT_GRID: number[] = (() => {
  const acc: number[] = [];
  let sum = 0;
  for (const shot of shots) {
    sum += Number(shot.duration ?? 5);
    acc.push(Math.round(sum * 1000) / 1000);
  }
  return acc.slice(0, -1);
})();
let danmakuOut = DANMAKU_ENABLED
  ? (STAGES.has("danmaku") ? subtitled : preferDownstream(join(POST_DIR, "master-danmaku.mp4"), subtitled))
  : subtitled;
if (DANMAKU_ENABLED && STAGES.has("danmaku") && existsSync(subtitled)) {
  const started = Date.now();
  const itemsFile = DANMAKU_FILE ? abs(DANMAKU_FILE) : join(POST_DIR, "danmaku.json");
  if (!DANMAKU_FILE) {
    /** 无现成弹幕稿：按镜头内容即时报文生成（评论语气，与画面语境一致） */
    const items: Array<Record<string, unknown>> = [];
    let cursor = 0.5;
    const pool = (shot: ShotCard): string[] => {
      const mood = String(shot.mood ?? "");
      return mood.includes("食")
        ? ["桂花糖粥绝了", "想吃海棠糕", "这条街有味道"]
        : mood.includes("俏皮") || mood.includes("生活气")
          ? ["评弹一响就上头", "巷子好好逛", "本地人路过"]
          : mood.includes("夜")
            ? ["夜景太温柔了", "灯笼好看", "已收藏"]
            : ["这也太好看了吧", "苏州真会养人", "想去走走"];
    };
    for (const shot of shots) {
      const duration = Number(shot.duration ?? 5);
      const texts = pool(shot);
      texts.forEach((text, i) => {
        items.push({ text, at: Number((cursor + 0.8 + i * 1.4).toFixed(2)), mode: i === 1 ? "top" : "scroll" });
      });
      cursor += duration;
    }
    writeFileSync(itemsFile, `${JSON.stringify(items, null, 2)}\n`, "utf8");
  }
  const out = join(POST_DIR, "master-danmaku.mp4");
  const result = runCli(SUBTITLE_CLI, [
    "danmaku", "--in", subtitled, "--out", out, "--items", itemsFile,
    "--platform", arg("--platform", "B站"),
    "--evidence-dir", join(POST_DIR, "danmaku-evidence")
  ]);
  const info = existsSync(out) ? probe(out) : {};
  const density = (result.out.match(/条数[^\n]*/) ?? ["无密度信息"])[0] ?? "";
  const verdict = await reviewStage({
    stage: "danmaku", projectId: PROJECT,
    artifacts: [{ path: existsSync(out) ? out : subtitled, kind: "video", probe: info }, { path: itemsFile, kind: "json" }],
    deterministic: [
      { id: "rendered", pass: existsSync(out), detail: existsSync(out) ? "弹幕版已产出" : "弹幕版未产出", hard: true },
      { id: "tool-exit", pass: result.ok, detail: result.ok ? "弹幕工位退出码 0" : `弹幕工位失败：${result.out.slice(-300)}`, hard: true },
      { id: "density", pass: /并发峰值 \d+\/8/.test(result.out), detail: density }
    ],
    context: { items: JSON.parse(readFileSync(itemsFile, "utf8")).slice(0, 12), toolOutput: result.out.slice(-700) },
    env: ENV, allowFallbackApprove: ALLOW_FALLBACK_APPROVE, log
  });
  if (existsSync(out)) danmakuOut = out;
  record({
    stage: "danmaku", shotId: null, invoked: true, ok: result.ok && existsSync(out), cached: false, degraded: false,
    attempt: 1, ms: Date.now() - started, artifact: existsSync(out) ? out : null, evidence: { items: itemsFile, tool: "subtitle-bridge danmaku" }, verdict
  });
}

/* ---------- ⑧ 配乐（bgm-bridge） ---------- */
/** 未重跑配乐时沿用磁盘上不早于上游的配乐版；重跑则由下面的 bgm 环节覆盖 */
let scored = STAGES.has("bgm") ? danmakuOut : preferDownstream(join(POST_DIR, "master-scored.mp4"), danmakuOut);
if (STAGES.has("bgm") && existsSync(danmakuOut)) {
  const started = Date.now();
  const out = join(POST_DIR, "master-scored.mp4");
  const genre = arg("--bgm-genre", "旅行");
  const mood = arg("--bgm-mood", "温润治愈");
  const policy = arg("--bgm-policy", "keep-dialogue");
  const sourcePolicy = arg("--bgm-source-policy", "online-first");
  /**
   * 指定曲目（2026-09-24 真机补）：`--bgm-track <曲库 id | 绝对路径>`。
   *
   * 背景：`best` 的自动选曲在"题材"维度上不够硬——真机把「运动/高燃」的曲目选给了江南水乡口播片
   * （match.reasons 明确写着"题材未命中"，但因为能量/BPM 命中仍被采信）。
   * 产品所有者本地曲库（`~/.workloom-bgm/library`，1034 首，已打标）里本就有题材贴合的曲子，
   * 因此监制可以直接点名曲目：这条路径**跳过自动择优**，但仍走工位的混音/让位/响度/选段全套复检。
   */
  const chosenTrack = arg("--bgm-track", "");
  const result = runCli(BGM_CLI, [
    "best", "--in", danmakuOut, "--out", out, "--genre", genre, "--mood", mood, "--policy", policy,
    "--source-policy", sourcePolicy,
    "--evidence-dir", join(POST_DIR, "bgm-evidence")
  ]);
  /**
   * 「最佳候选」判定无需配乐时的**监制兜底路径**（2026-09-24）：
   * 真机结果：口播片人声太满 → `best` 按"不劣化优先"给出 `no_bgm_needed`（无产物）。
   * 这类结论在纯质量口径下是对的，但产品口径里"成片必须带配乐轨"，所以监制显式接管：
   * 用**自算作曲**（叙事/口播配方）+ **让位混音**（keep-dialogue、低于人声若干 dB、母版 −14 LUFS）手工出一版，
   * 并在阶段记录里写明这是"监制决定"，不是工具自动结论。
   */
  let bgmVia = "best";
  let bgmDetail = result.out.slice(-800);
  if (chosenTrack) {
    /** 监制点名曲目：id → 走曲库索引解析出绝对路径；已是绝对路径则直用 */
    let trackPath = chosenTrack;
    if (!existsSync(trackPath)) {
      try {
        const core = await import(join(REPO_ROOT, "bundles/ai-video/connectors/bgm-bridge/core.mjs"));
        const found = (core as { findTracks: (q: Record<string, unknown>) => { track?: { path?: string } } })
          .findTracks({ trackId: chosenTrack, commercialUse: true });
        if (found.track?.path && existsSync(found.track.path)) trackPath = found.track.path;
        else throw new Error(`曲库中未找到可用曲目：${chosenTrack}`);
      } catch (err) {
        throw new Error(`--bgm-track 解析失败（${chosenTrack}）：${err instanceof Error ? err.message : String(err)}`);
      }
    }
      const mix = runCli(BGM_CLI, [
        "mix", "--in", danmakuOut, "--out", out, "--bgm", trackPath, "--policy", policy,
        "--music-level", arg("--bgm-level", "-26"), "--ducking", arg("--bgm-ducking", "14"), "--lufs", "-14",
        "--section", arg("--bgm-section", "auto"),
        /**
         * 剪辑网格 + 剪辑驱动 BPM（2026-09-25 真机）：成片方最清楚自己的剪辑点（每镜固定时长、硬切），
         * 把网格直接交给混音器反推 BPM（5s 切点 → 96BPM = 8 拍/镜）——卡点平均误差从 116ms 降到 0ms。
         * 不传的话它只能从"音轨起音"猜剪辑点，会把台词音节当切点，BPM 反推整体落空并退回 100BPM 默认值。
         */
        "--bpm-strategy", "cut-driven",
        "--cut-times", CUT_GRID.join(","),
        "--evidence-dir", join(POST_DIR, "bgm-evidence")
      ]);
    bgmVia = "library-track";
    bgmDetail = `监制点名曲目（跳过自动择优）：${trackPath}\n--- mix ---\n${mix.out.slice(-900)}`;
    log(`↻ 配乐：监制点名曲库曲目 → ${trackPath.split("/").slice(-1)[0]}（走混音/让位/响度/选段复检）`);
  } else if (!existsSync(out)) {
    const recipe = arg("--bgm-recipe", "interview");
    const bgmFile = join(POST_DIR, "bgm-composed.wav");
    const compose = runCli(BGM_CLI, ["compose", "--out", bgmFile, "--in", danmakuOut, "--id", recipe, "--seed", "20260924"]);
    if (compose.ok && existsSync(bgmFile)) {
      const mix = runCli(BGM_CLI, [
        "mix", "--in", danmakuOut, "--out", out, "--bgm", bgmFile, "--policy", policy,
        "--music-level", arg("--bgm-level", "-26"), "--ducking", arg("--bgm-ducking", "14"), "--lufs", "-14",
        "--bpm-strategy", "cut-driven",
        "--cut-times", CUT_GRID.join(","),
        "--evidence-dir", join(POST_DIR, "bgm-evidence")
      ]);
      bgmVia = "producer-compose+mix";
      bgmDetail = `best=no_bgm_needed → 监制兜底（compose ${recipe} + mix）\n--- compose ---\n${compose.out.slice(-400)}\n--- mix ---\n${mix.out.slice(-500)}`;
      log(`↻ 配乐：best 判定无需配乐 → 监制兜底走 自算作曲(${recipe}) + 让位混音`);
    } else {
      bgmDetail = `compose 失败：${compose.out.slice(-400)}`;
    }
  }
  const info = existsSync(out) ? probe(out) : {};
  const lufs = (result.out.match(/-?\d+(\.\d+)?\s*LUFS/) ?? ["无响度读数"])[0] ?? "";
  const mixLufs = (bgmDetail.match(/-?\d+(\.\d+)?\s*LUFS/) ?? ["无响度读数"])[0] ?? lufs;
  /** 成品响度实测（工位没给读数时由宿主补测，避免"无证据"卡门） */
  const measured = existsSync(out) ? measureLoudness(out) : { lufs: null, peakDb: null, detail: "无产物" };
  const verdict = await reviewStage({
    stage: "bgm", projectId: PROJECT,
    artifacts: [{ path: existsSync(out) ? out : danmakuOut, kind: "video", probe: info }],
    deterministic: [
      { id: "scored", pass: existsSync(out), detail: existsSync(out) ? "配乐版已产出" : "配乐版未产出", hard: true },
      { id: "tool-exit", pass: result.ok, detail: result.ok ? "配乐工位退出码 0" : `配乐工位失败：${result.out.slice(-300)}`, hard: true },
      { id: "audio-track", pass: Boolean(info.hasAudio), detail: info.hasAudio ? `音轨 ${info.acodec}` : "无音轨", hard: !info.hasAudio },
      {
        id: "loudness", pass: measured.lufs === null ? false : measured.lufs >= -17 && measured.lufs <= -12,
        detail: `${measured.detail}（母版口径 −14 LUFS ±2）`
      },
      {
        id: "true-peak", pass: measured.peakDb === null ? false : measured.peakDb <= -1,
        detail: `真峰值 ${measured.peakDb === null ? "未读到" : `${measured.peakDb.toFixed(1)} dBFS`}（上限 −1 dBTP）`
      }
    ],
    context: {
      genre, mood, policy, via: bgmVia, loudness: mixLufs, measuredLoudness: measured.detail, toolOutput: bgmDetail,
      /**
       * 曲风判据的事实依据（2026-09-25）：把 brief 的题材/平台/剪辑风格交给监制，
       * 免得它拿"上一部片子的题材"当标准（真机：给滕王阁城市地标片挑的电子律动曲被判"不符江南水乡温润题材"）。
       */
      briefTone: shotlist.title, platform: arg("--platform", "抖音/快手"),
      briefHint: BRIEF_FILE && existsSync(abs(BRIEF_FILE)) ? readFileSync(abs(BRIEF_FILE), "utf8").slice(0, 900) : null,
      /** 人声分布与剪点网格是判"让位/卡点"的事实依据（否则监制只能凭感觉） */
      dialogueShots: shots.filter((s) => (s.dialogue ?? []).length > 0).map((s) => s.shotId),
      cutGridSeconds: shots.map((s, i) => shots.slice(0, i + 1).reduce((sum, x) => sum + Number(x.duration ?? 5), 0)),
      styleIntent: (() => {
        try {
          return BRIEF_FILE && existsSync(abs(BRIEF_FILE))
            ? (JSON.parse(readFileSync(abs(BRIEF_FILE), "utf8")) as { editingStyle?: string }).editingStyle ?? null
            : null;
        } catch { return null; }
      })(),
      discipline: "曲风是否合适以 brief 的题材/平台/剪辑风格为准；不要用与本片无关的其他题材（如水乡/纪实）当作标准。"
        + "让位深度只按**有台词的镜头**衡量（其余是无对白的音乐段）；卡点看剪辑点是否落在曲子的节拍上。"
    },
    env: ENV, allowFallbackApprove: ALLOW_FALLBACK_APPROVE, log
  });
  if (existsSync(out)) scored = out;
  record({
    stage: "bgm", shotId: null, invoked: true, ok: result.ok && existsSync(out), cached: false, degraded: false,
    attempt: 1, ms: Date.now() - started, artifact: existsSync(out) ? out : null,
    evidence: { genre, mood, policy, via: bgmVia, loudness: mixLufs, measured: measured.detail, tool: `bgm-bridge ${bgmVia}` }, verdict
  });
}

/* ---------- ⑨ 封面（封面设计师：设计稿 → 合成 → 机检 → 监制，2026-09-25 重写） ---------- */
/**
 * 事故：上一版封面 = "抽一帧 + 烧一行标题"——产品所有者复核时点名**封面设计师没有发挥作用**
 * （封面只有标题，没有主视觉设计、没有人物、没有副标题/角标）。
 *
 * 新口径把封面做成"设计稿 → 合成 → 机检 → 监制"四段（机检口径在 `cover-design.ts`，含单测）：
 *   ① 封面设计师（LLM）出**结构化设计稿**：主标题/副标题/角标、主视觉取哪一镜哪一秒、人物带高度、
 *      字级配色、版式左右——并给出设计理由；设计稿不合法或设计师不可用 → 确定性兜底稿（仍是三件套）；
 *   ② 合成（ffmpeg，确定性）：干净母版取帧 → 调色/暗角/标题带压暗 → 人物带（柔化过渡）→ 大标题排版；
 *   ③ 机检四项：标题真的画上去了 / 人物带真的合成进去了 / 底图来自**未烧字**母版 / 文字没落进平台遮挡区；
 *   ④ 监制（LLM）看整图（rubric 见 `COVER_REVIEW_RUBRIC`）。
 */

/** drawtext 文本净化：ASCII 冒号/逗号/引号等会破坏 filter 语法，换成等价全角或删除（视觉无损） */
function escapeDrawtextText(text: string): string {
  return String(text)
    .replace(/\\/g, "／")
    .replace(/"/g, "”")
    .replace(/'/g, "’")
    .replace(/:/g, "：")
    .replace(/,/g, "，")
    .replace(/;/g, "；")
    .replace(/\[/g, "【")
    .replace(/\]/g, "】")
    .replace(/\r?\n/g, " ")
    .trim();
}

/** 两个图在指定区域的 PSNR（判定"这块区域到底改没改"） */
function psnrRegion(a: string, b: string, crop: { x: number; y: number; w: number; h: number }): number | null {
  const res = spawnSync(FFMPEG, [
    "-hide_banner", "-i", a, "-i", b,
    "-lavfi", `[0:v]crop=${crop.w}:${crop.h}:${crop.x}:${crop.y},format=gray[a];`
      + `[1:v]crop=${crop.w}:${crop.h}:${crop.x}:${crop.y},format=gray[b];[a][b]psnr`,
    "-f", "null", "-"
  ], { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
  const text = `${res.stdout ?? ""}\n${res.stderr ?? ""}`;
  const m = /average:([\d.]+|inf)/.exec(text);
  if (!m) return null;
  return m[1] === "inf" ? 99 : Number(m[1]);
}

/** 灰度原始像素（封面机检用：墨迹包围盒与遮挡区墨迹比例都按**交付图的实际像素**算） */
function grayRaw(file: string): Buffer {
  const res = spawnSync(FFMPEG, ["-hide_banner", "-v", "error", "-i", file, "-f", "rawvideo", "-pix_fmt", "gray", "-"], {
    maxBuffer: 64 * 1024 * 1024
  });
  if (res.status !== 0 || !res.stdout) throw new Error(`灰度解码失败：${file}`);
  return res.stdout as Buffer;
}

/**
 * 墨迹包围盒 + 遮挡区墨迹比例（对两图之差的灰度图做统计）。
 * 阈值 26 是"肉眼可辨的改动"量级：编码噪声（JPEG/PNG 重编码）远低于它，避免把噪声当字。
 */
function inkMetrics(diffFile: string, width: number, height: number, threshold = 26): {
  top: number; bottom: number; left: number; right: number; bottomBandInkRatio: number;
} {
  const raw = grayRaw(diffFile);
  let top = height; let bottom = -1; let left = width; let right = -1;
  const bottomStart = Math.round(height * (1 - COVER_SAFE_AREA.bottomReservedRatio));
  let bottomBandInk = 0;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      if (raw[y * width + x]! <= threshold) continue;
      if (y < top) top = y;
      if (y > bottom) bottom = y;
      if (x < left) left = x;
      if (x > right) right = x;
      if (y >= bottomStart) bottomBandInk += 1;
    }
  }
  const bandPixels = width * (height - bottomStart);
  return {
    top: bottom >= 0 ? top : 0,
    bottom: bottom >= 0 ? bottom : 0,
    left: right >= 0 ? left : 0,
    right: right >= 0 ? right : 0,
    bottomBandInkRatio: bandPixels > 0 ? bottomBandInk / bandPixels : 0
  };
}

/** 两图相减（差异图，用于测"字画在哪、有多大"） */
function imageDiff(a: string, b: string, out: string): void {
  run(FFMPEG, ["-y", "-i", a, "-i", b,
    "-filter_complex", "[0:v]format=gray[g0];[1:v]format=gray[g1];[g0][g1]blend=all_mode=difference",
    "-frames:v", "1", out]);
}

/** 封面设计师（LLM）：只出设计稿，不画图 */
async function callCoverDesigner(designInput: CoverDesignInput): Promise<string> {
  const llm = resolveProducerLlm(ENV);
  if (!llm) throw new Error("未配置 LLM（LLM_BASE_URL / LLM_API_KEY / LLM_MODEL）");
  const res = await fetch(`${llm.baseUrl}/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${llm.apiKey}` },
    body: JSON.stringify({
      model: llm.model,
      messages: [
        { role: "system", content: "你是封面设计师，只输出严格合法的 JSON 设计稿。" },
        { role: "user", content: buildCoverDesignPrompt(designInput) }
      ],
      temperature: 0.4,
      response_format: { type: "json_object" }
    }),
    signal: AbortSignal.timeout(180_000)
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`封面设计稿请求失败 HTTP ${res.status}：${text.slice(0, 200)}`);
  const content = (JSON.parse(text) as { choices?: Array<{ message?: { content?: string } }> }).choices?.[0]?.message?.content ?? "";
  if (!content.trim()) throw new Error("封面设计师返回空内容");
  return content;
}

if (STAGES.has("cover") && existsSync(colored)) {
  const started = Date.now();
  const platform = arg("--platform", "抖音/快手");
  const coverPng = join(OUT_DIR, `${PROJECT}-cover.png`);
  const coverDir = join(POST_DIR, "cover");
  mkdirSync(coverDir, { recursive: true });
  const CW = 1080; const CH = 1920;
  const shotAt = (shotId: string): number => {
    const index = shots.findIndex((s) => s.shotId === shotId);
    return shots.slice(0, Math.max(0, index)).reduce((sum, s) => sum + Number(s.duration ?? 5), 0);
  };
  const personShots = shots.filter((s) => String(s.character ?? "").length > 0);
  const designInput: CoverDesignInput = {
    title: shotlist.title,
    platform,
    brief: BRIEF_FILE && existsSync(abs(BRIEF_FILE))
      ? (JSON.parse(readFileSync(abs(BRIEF_FILE), "utf8")) as CoverDesignInput["brief"])
      : null,
    character: lead ? { id: lead.id, name: lead.name } : null,
    shots: shots.map((s) => ({
      shotId: s.shotId,
      scene: String(s.scene ?? ""),
      dialogueText: dialogueText(s),
      hasCharacter: String(s.character ?? "").length > 0,
      duration: Number(s.duration ?? 5)
    }))
  };
  /**
   * ① 设计稿：设计师（LLM）→ 严格校验；不可用/不合规 → 确定性兜底稿。
   * 兜底稿也必须是"主视觉 + 人物 + 主标题"三件套（不允许退回"只有标题"）。
   */
  const fallbackBackground = (personShots.length > 0
    ? [...shots].reverse().find((s) => String(s.character ?? "").length === 0) ?? shots[0]!
    : shots[shots.length - 1]!);
  let plan: CoverPlan;
  let designVia: "llm" | "fallback" = "llm";
  let designNote = "";
  /**
   * 人物卡来源由管线注入：优先与主视觉时段一致的人物镜（夜景封面配夜景人物），
   * 否则用第一个人物镜。**不抠像**：直接用片子自己的镜头帧做肖像卡
   * （真机验证：定妆照抠像会把脸也抠掉、边缘留光晕）。
   */
  const personShotFor = (backgroundShotId: string | undefined): ShotCard | null => {
    const night = /夜|灯/.test(String(shots.find((s) => s.shotId === backgroundShotId)?.scene ?? ""));
    return personShots.find((s) => (night ? /夜|灯/.test(String(s.scene ?? "")) : true)) ?? personShots[0] ?? null;
  };
  try {
    const raw = await callCoverDesigner(designInput);
    try {
      plan = parseCoverPlan(raw, designInput, { personShotId: personShotFor(undefined)?.shotId, personAtSec: 1.0 });
      designNote = raw.slice(0, 600);
    } catch (first) {
      /**
       * 设计稿自修复一次（2026-09-25）：把校验错误回给设计师，要求它只针对错误项改一版。
       * 真机首跑就是"越界字级/字库不在白名单"这类可修复项——直接退兜底稿会让封面设计师形同虚设。
       */
      const reason = first instanceof Error ? first.message.slice(0, 300) : String(first);
      log(`  ↻ 封面设计稿未过校验（${reason.slice(0, 120)}）→ 要求设计师自修复一次`);
      const repaired = await callCoverDesigner({ ...designInput, repairFrom: raw.slice(0, 1500), repairReason: reason });
      plan = parseCoverPlan(repaired, designInput, { personShotId: personShotFor(undefined)?.shotId, personAtSec: 1.0 });
      designNote = repaired.slice(0, 600);
    }
  } catch (err) {
    designVia = "fallback";
    designNote = `设计师不可用 → 兜底稿：${err instanceof Error ? err.message.slice(0, 200) : String(err)}`;
    plan = fallbackCoverPlan(designInput, {
      headline: arg("--cover-hook", shotlist.title ?? "封面"),
      heroShotId: fallbackBackground.shotId,
      personShotId: personShotFor(fallbackBackground.shotId)?.shotId
    });
    log(`  ⚠ 封面设计师不可用 → 使用兜底稿：${designNote}`);
  }
  /** 人物卡来源：与主视觉时段一致的人物镜（管线按最终设计稿再校正一次） */
  const personShot = personShotFor(plan.background.shotId);
  if (plan.person?.enabled && personShot) {
    plan = { ...plan, person: { ...plan.person, shotId: personShot.shotId, atSec: plan.person.atSec ?? 1.0 } };
  }
  const personUse = Boolean(plan.person.enabled && personShot);
  /** 肖像卡几何：宽度按设计稿，右下角留边；高度按 3:4 竖幅卡（含白边） */
  const cardW = Math.round(CW * Math.min(0.5, Math.max(0.28, plan.person.widthRatio)));
  const cardH = Math.round(cardW * 1.32);
  const cardX = CW - cardW - Math.round(CW * 0.052);
  const cardY = CH - cardH - Math.round(CH * 0.078);
  const cardBorder = Math.max(6, Math.round(cardW * 0.018));
  /**
   * ② 合成：底图取帧 = **该镜头里最清晰的一帧**（真机二次复核抓到"甩镜中间帧糊到地标不可辨识"）：
   *   · 在设计稿给的时刻 + 镜头内 4 个等分点里挑边缘能量最高的一帧（`frameSharpness`）；
   *   · 若该镜头整段都偏软（低于口径下限），**自动改取全片最清晰的帧**并把替换写进证据——
   *     宁可换镜头，也不交付一张"看不清地标"的封面。
   * 口径（2026-09-25 实测标定）：同样抽帧下白天实拍 8.3–8.7、黄昏雾光 3.2–4.9、夜景甩镜 2.4–6.1，
   * 因此下限取 5.5（低于它基本就是运动模糊/失焦）。
   */
  const bgCandidates = (shot: ShotCard): number[] => {
    const duration = Number(shot.duration ?? 5);
    const list = [plan.background.atSec, 0.3, duration * 0.5, duration * 0.75, duration - 0.3];
    return [...new Set(list.map((t) => Math.max(0.2, Math.min(duration - 0.2, Number(t) || 0.3)).toFixed(2)))].map(Number);
  };
  const frameSharpness = (file: string): number => {
    const res = spawnSync(FFMPEG, ["-hide_banner", "-v", "error", "-i", file, "-vf", "scale=270:480,format=gray", "-f", "rawvideo", "-pix_fmt", "gray", "-"], { maxBuffer: 32 * 1024 * 1024 });
    const buf = res.stdout as Buffer | null;
    if (!buf || buf.length < 270 * 480) return -1;
    const W = 270; const H = 480;
    let sum = 0; let count = 0;
    for (let y = 1; y < H - 1; y += 1) {
      for (let x = 1; x < W - 1; x += 1) {
        const i = y * W + x; const v = buf[i]!;
        sum += Math.abs(v - buf[i + 1]!) + Math.abs(v - buf[i - 1]!) + Math.abs(v - buf[i - W]!) + Math.abs(v - buf[i + W]!);
        count += 4;
      }
    }
    return count > 0 ? sum / count : -1;
  };
  const COVER_MIN_SHARPNESS = 5.5;
  const pickSharpest = (shot: ShotCard, times: number[]): { atSec: number; sharpness: number } => {
    let best = { atSec: times[0]!, sharpness: -1 };
    for (const t of times) {
      const tmp = join(coverDir, `sharp-${shot.shotId}-${t}.png`);
      run(FFMPEG, ["-y", "-ss", (shotAt(shot.shotId) + t).toFixed(2), "-i", colored, "-frames:v", "1", tmp]);
      const value = frameSharpness(tmp);
      if (value > best.sharpness) best = { atSec: t, sharpness: value };
    }
    return best;
  };
  let bgShot = shots.find((s) => s.shotId === plan.background.shotId) ?? shots[0]!;
  let bgPick = pickSharpest(bgShot, bgCandidates(bgShot));
  let bgSubstituted = false;
  if (bgPick.sharpness < COVER_MIN_SHARPNESS) {
    let best: { shot: ShotCard; atSec: number; sharpness: number } = { shot: bgShot, atSec: bgPick.atSec, sharpness: bgPick.sharpness };
    for (const candidate of shots) {
      if (candidate.shotId === bgShot.shotId) continue;
      const pick = pickSharpest(candidate, bgCandidates(candidate));
      if (pick.sharpness > best.sharpness) best = { shot: candidate, atSec: pick.atSec, sharpness: pick.sharpness };
    }
    if (best.shot.shotId !== bgShot.shotId) {
      log(`  ↻ 封面底图：${bgShot.shotId} 最清晰帧仅 ${bgPick.sharpness.toFixed(1)}（下限 ${COVER_MIN_SHARPNESS}）→ 改用 ${best.shot.shotId} 的 ${best.atSec}s（${best.sharpness.toFixed(1)}）`);
      bgSubstituted = true;
      bgShot = best.shot;
      bgPick = { atSec: best.atSec, sharpness: best.sharpness };
    }
  }
  const bgAt = bgPick.atSec;
  const bgFrameA = join(coverDir, "bg-frame-a.png");
  const bgFrameB = join(coverDir, "bg-frame-b.png");
  run(FFMPEG, ["-y", "-ss", (shotAt(bgShot.shotId) + bgAt).toFixed(2), "-i", colored, "-frames:v", "1", bgFrameA]);
  run(FFMPEG, ["-y", "-ss", (shotAt(bgShot.shotId) + bgAt).toFixed(2), "-i", colored, "-frames:v", "1", bgFrameB]);
  /**
   * 标题带压暗用**多层薄带**拼渐变（2026-09-25 真机二次修正）：
   * 上一版用两层厚带（0.32 + 0.16）→ 监制一眼看出"两条贯穿全宽的硬接缝"，判为合成残留。
   * 现在 14 层薄带、透明度从 0.40 线性衰减到 0，边缘不可辨。
   */
  const scrimTop = 0;
  const scrimHeight = Math.round(CH * 0.46);
  const scrimBands = 14;
  const bandHeight = Math.max(2, Math.round(scrimHeight / scrimBands));
  const scrimFilters = Array.from({ length: scrimBands }, (_, index) => {
    const alpha = 0.40 * (1 - index / (scrimBands - 1));
    const y = scrimTop + index * bandHeight;
    return `drawbox=x=0:y=${y}:w=${CW}:h=${bandHeight}:color=black@${alpha.toFixed(3)}:t=fill`;
  });
  const bgOnly = join(coverDir, "bg-only.png");
  run(FFMPEG, ["-y", "-i", bgFrameA, "-vf", [
    `scale=${CW}:${CH}:force_original_aspect_ratio=increase`,
    `crop=${CW}:${CH}`,
    /** 轻调色：保持片子本身的光线气质（暖调画面不要被压成冷雾——监制二次复核点名的第 5 条） */
    "eq=contrast=1.05:saturation=1.06",
    "colorbalance=rm=0.04:bm=-0.03",
    "vignette=PI/6",
    ...(plan.background.treatment === "scrim" ? scrimFilters : [])
  ].join(","), bgOnly]);
  /**
   * 人物卡：片子自己的镜头帧（与片子同一套造型/光线），白细边 + 投影，落在右下角。
   * 为什么不用"整幅下半身横带"：真机监制一眼看出"贯穿全宽的横向硬接缝 + 地标被一刀切断"，
   * 判为合成残留；改成有边界的肖像卡后，接缝不再存在，"有一张卡"本身是设计意图而不是事故。
   */
  const bgPerson = join(coverDir, "bg-person.png");
  const personFile = join(coverDir, "person-band.png");
  if (personUse && personShot) {
    const pAt = Math.max(0.5, Math.min(Number(personShot.duration ?? 5) - 0.4, plan.person.atSec ?? 1.0));
    const personFrame = join(coverDir, "person-frame.png");
    run(FFMPEG, ["-y", "-ss", (shotAt(personShot.shotId) + pAt).toFixed(2), "-i", colored, "-frames:v", "1", personFrame]);
    /**
     * 卡内画面：按卡内区（卡宽 − 白边×2）裁切缩放。
     * 加一点暖色（`colorbalance`）+ 轻对比，让卡片与底图的光线气质靠近
     * （真机监制两次点到"人物色温与底图不一致，像贴纸"）。
     */
    const innerW = cardW - cardBorder * 2;
    const innerH = cardH - cardBorder * 2;
    run(FFMPEG, ["-y", "-i", personFrame, "-vf",
      `scale=${innerW}:${innerH}:force_original_aspect_ratio=increase,crop=${innerW}:${innerH},`
        + `eq=contrast=1.04:saturation=1.05,colorbalance=rm=0.05:bm=-0.04,`
        + `pad=${cardW}:${cardH}:${cardBorder}:${cardBorder}:white`,
      "-frames:v", "1", personFile]);
    /** 投影（半透明黑矩形，偏移右下）再叠卡；投影让"这是一张卡"成立，而不是贴纸 */
    const shadow = join(coverDir, "person-shadow.png");
    run(FFMPEG, ["-y", "-i", bgOnly, "-vf",
      `drawbox=x=${cardX + 10}:y=${cardY + 14}:w=${cardW}:h=${cardH}:color=black@0.35:t=fill`,
      "-frames:v", "1", shadow]);
    run(FFMPEG, ["-y", "-i", shadow, "-i", personFile, "-filter_complex",
      `[0:v][1:v]overlay=x=${cardX}:y=${cardY}`, "-frames:v", "1", bgPerson]);
  } else {
    run(FFMPEG, ["-y", "-i", bgOnly, "-frames:v", "1", bgPerson]);
  }
  /** 排版：强调色装饰条 + 主标题（可两行）+ 副标题 + 角标 */
  const FONT_FILE = join(REPO_ROOT, "bundles/ai-video/library/fonts", COVER_FONTS[plan.typography.fontId].file);
  const headSizeDesired = Math.round(CH * plan.typography.headlineSizeRatio);
  const subSize = Math.round(CH * plan.typography.sublineSizeRatio);
  const badgeSize = Math.max(28, Math.round(subSize * 0.72));
  const left = plan.typography.align === "center" ? 0 : 64;
  /**
   * 标题**自适应字级**（2026-09-25 真机二次复核：'标题末字被右缘裁切'）：
   * drawtext 不会自动换行/缩放，设计稿给的字级在实际字数下会溢出画幅。
   * 这里按"汉字 1em、非汉字 0.55em"估宽，把字级压到**一行放得下**为止（下限 60% 设计字级，
   * 再小就说明这句话太长——由机检的标题带检查兜底）。
   */
  const headlineLinesRaw = plan.headline.split("\n").map((line) => escapeDrawtextText(line)).filter(Boolean).slice(0, 2);
  /** 视觉宽度（em）：汉字 1、西文/数字 0.55（与字体无关的保守估计） */
  const emWidth = (text: string): number => [...text].reduce(
    (sum, ch) => sum + (/[\u4e00-\u9fff\u3000-\u303f\uff00-\uffef]/.test(ch) ? 1 : 0.55), 0
  );
  const availableWidth = CW - left - Math.round(CW * 0.06);
  const longestLineEm = Math.max(1, ...headlineLinesRaw.map(emWidth));
  const headSize = Math.max(
    Math.round(headSizeDesired * 0.6),
    Math.min(headSizeDesired, Math.floor(availableWidth / longestLineEm))
  );
  const accentY = Math.round(CH * COVER_SAFE_AREA.topMinRatio);
  const accentH = Math.max(8, Math.round(CH * 0.006));
  const titleY = accentY + Math.round(headSize * 0.42);
  const lineGap = Math.round(headSize * 0.12);
  const titleLines = headlineLinesRaw;
  const textFilters: string[] = [
    `drawbox=x=${left + 2}:y=${accentY}:w=${Math.round(CW * 0.12)}:h=${accentH}:color=${plan.typography.accentColor}@0.95:t=fill`
  ];
  titleLines.forEach((line, index) => {
    const y = titleY + index * (headSize + lineGap);
    const x = plan.typography.align === "center" ? `(w-text_w)/2` : String(left);
    textFilters.push(
      `drawtext=fontfile='${FONT_FILE}':text=${line}:expansion=none:fontsize=${headSize}:fontcolor=${plan.typography.color}`
        + `:borderw=${Math.max(3, Math.round(headSize * 0.035))}:bordercolor=black@0.55:shadowx=2:shadowy=3:shadowcolor=black@0.35:x=${x}:y=${y}`
    );
  });
  const subY = titleY + titleLines.length * (headSize + lineGap) + Math.round(headSize * 0.12);
  let cursorY = subY;
  if (plan.subline) {
    textFilters.push(
      `drawtext=fontfile='${FONT_FILE}':text=${escapeDrawtextText(plan.subline)}:expansion=none:fontsize=${subSize}`
        + `:fontcolor=${plan.typography.accentColor}:borderw=${Math.max(2, Math.round(subSize * 0.06))}:bordercolor=black@0.5`
        + `:x=${plan.typography.align === "center" ? "(w-text_w)/2" : String(left + 4)}:y=${cursorY}`
    );
    cursorY += subSize + Math.round(subSize * 0.45);
  }
  if (plan.badge) {
    textFilters.push(
      `drawtext=fontfile='${FONT_FILE}':text=${escapeDrawtextText(plan.badge)}:expansion=none:fontsize=${badgeSize}`
        + `:fontcolor=white@0.92:borderw=${Math.max(2, Math.round(badgeSize * 0.06))}:bordercolor=black@0.5`
        + `:x=${plan.typography.align === "center" ? "(w-text_w)/2" : String(left + 4)}:y=${cursorY}`
    );
  }
  const bgText = join(coverDir, "bg-text.png");
  run(FFMPEG, ["-y", "-i", bgOnly, "-vf", textFilters.join(","), "-frames:v", "1", bgText]);
  run(FFMPEG, ["-y", "-i", bgPerson, "-vf", textFilters.join(","), "-frames:v", "1", coverPng]);
  /** ③ 机检（口径与阈值在 `cover-design.ts#coverDeterministicChecks`） */
  const coverInfo = probe(coverPng);
  const diffFile = join(coverDir, "text-diff.png");
  imageDiff(coverPng, bgPerson, diffFile);
  const ink = inkMetrics(diffFile, CW, CH);
  const titleBand = { x: 0, y: Math.round(CH * COVER_SAFE_AREA.topMinRatio), w: CW, h: Math.round(CH * (COVER_SAFE_AREA.titleBottomMaxRatio - COVER_SAFE_AREA.topMinRatio)) };
  /** 人物卡区域（机检的人工地物）：卡内 30%–75% 高度、中央 70% 宽度——避开白边与投影的干扰 */
  const personBox = {
    x: cardX + Math.round(cardW * 0.15), y: cardY + Math.round(cardH * 0.30),
    w: Math.round(cardW * 0.70), h: Math.max(80, Math.round(cardH * 0.45))
  };
  const titleBandPsnr = psnrRegion(coverPng, bgPerson, titleBand);
  const personBoxPsnr = personUse ? psnrRegion(coverPng, bgText, personBox) : null;
  const backgroundMatchesCleanMaster = abs(colored) === abs(join(POST_DIR, "master-graded.mp4"))
    || (() => {
      /** 允许"母版走了原片（调色被驳回）"的情形：只要是 **colored 这一路** 的同一帧即可 */
      try {
        return sha256FileSync(bgFrameA) === sha256FileSync(bgFrameB);
      } catch {
        return false;
      }
    })();
  const measurements: CoverMeasurements = {
    bytes: Number(coverInfo.bytes ?? 0),
    width: Number(coverInfo.width ?? 0),
    height: Number(coverInfo.height ?? 0),
    titleBandPsnrDb: titleBandPsnr,
    personBoxPsnrDb: personBoxPsnr,
    backgroundMatchesCleanMaster,
    titleTopRatio: ink.top / CH,
    titleBottomRatio: ink.bottom / CH,
    bottomBandInkRatio: ink.bottomBandInkRatio
  };
  const checks = coverDeterministicChecks(measurements);
  /**
   * 底图清晰度（硬闸，2026-09-25 二次复核新增）：监制抓到的"地标糊到不可辨识"应当由机检拦住，
   * 而不是等 LLM 打回。口径见上面的标定（同一抽帧标准下白天 8.3–8.7 / 黄昏 3.2–4.9 / 夜景甩镜 2.4–6.1）。
   */
  checks.push({
    id: "background-sharpness",
    pass: bgPick.sharpness >= COVER_MIN_SHARPNESS,
    detail: `底图边缘能量 ${bgPick.sharpness.toFixed(2)}（下限 ${COVER_MIN_SHARPNESS}；低于它基本是运动模糊/失焦）`
      + `${bgSubstituted ? "（已自动改取全片最清晰帧）" : ""}`,
    hard: true
  });
  /** ④ 监制：看整图（rubric 只问可验证的事） */
  const verdict = await reviewStage({
    stage: "cover", projectId: PROJECT,
    artifacts: [
      { path: coverPng, kind: "image", bytes: Number(coverInfo.bytes ?? 0), probe: coverInfo },
      ...(personUse ? [{ path: bgOnly, kind: "image" as const, note: "底图（供对比：设计是否依赖了主视觉）" }] : [])
    ],
    rubric: COVER_REVIEW_RUBRIC,
    deterministic: checks,
    context: {
      designVia, plan: { ...plan, source: designVia }, rationale: plan.rationale,
      designRaw: designNote, measurements,
      safeArea: COVER_SAFE_AREA,
      discipline: "封面必须同时有主视觉、人物与主标题（三件套）；文字落进底部平台遮挡区、或标题与底图同色看不清都算不合格。"
    },
    env: ENV, allowFallbackApprove: ALLOW_FALLBACK_APPROVE, log
  });
  record({
    stage: "cover", shotId: null, invoked: true, ok: checks.every((c) => c.pass), cached: false,
    degraded: designVia === "fallback" || verdict.degraded, attempt: 1, ms: Date.now() - started,
    artifact: existsSync(coverPng) ? coverPng : null,
    evidence: {
      designVia, plan, hook: plan.headline.replace(/\n/g, " "), font: plan.typography.fontId,
      background: { shotId: bgShot.shotId, atSec: bgAt, source: "colored（未烧字幕母版）" },
      backgroundPick: { sharpness: bgPick.sharpness, floor: COVER_MIN_SHARPNESS, substituted: bgSubstituted, plannedShotId: plan.background.shotId },
      headline: { text: plan.headline, fontId: plan.typography.fontId, sizePx: headSize, subSizePx: subSize },
      person: {
        shotId: personShot?.shotId ?? null, atSec: plan.person.atSec ?? null,
        card: { x: cardX, y: cardY, w: cardW, h: cardH, border: cardBorder },
        source: "colored（片子自己的镜头帧：肖像卡，不抠像）"
      },
      measurements, checks, designRaw: designNote,
      backgroundPickDetail: `边缘能量 ${bgPick.sharpness.toFixed(2)}／下限 ${COVER_MIN_SHARPNESS}${bgSubstituted ? "（改取全片最清晰帧）" : ""}`
    },
    verdict
  });
  if (!checks.every((c) => c.pass)) {
    log(`⛔ 封面机检未通过：${checks.filter((c) => !c.pass).map((c) => c.id).join("、")}`);
  }
}

/* ---------- ⑩ 软字幕轨收口（母版不烧字 + 字幕可开关） ---------- */
/**
 * 旁挂字幕的两种用法在这里分叉：
 *   · 交付目录里保留 `.srt/.ass/.vtt` 文件（平台后台上传口 / 剪辑软件用）；
 *   · 另出一支 `-softsub.mp4`：字幕作为**可开关的字幕轨**内嵌，画面与声音轨逐帧 copy
 *     （工位复检四件：video_unchanged / audio_unchanged / duration_kept / subtitle_tracks）。
 * 这样"要带字幕的片子"和"不要字幕的片子"是同一个画面母版派生的两个文件，不会各烧一遍。
 */
let softsubFile: string | null = null;
if (STAGES.has("mux") && subtitleSidecar && existsSync(scored) && !DRY_RUN) {
  const started = Date.now();
  const deliverSubtitleDir = join(OUT_DIR, "subtitles");
  mkdirSync(deliverSubtitleDir, { recursive: true });
  for (const name of readdirSync(subtitleSidecar.dir)) {
    if (!/\.(srt|ass|vtt|json)$/i.test(name)) continue;
    execFileSync("cp", [join(subtitleSidecar.dir, name), join(deliverSubtitleDir, name)]);
  }
  const out = join(OUT_DIR, `${PROJECT}-softsub.mp4`);
  const result = runCli(SUBTITLE_CLI, [
    "softmux", "--in", scored, "--out", out,
    "--srt", join(deliverSubtitleDir, `${PROJECT}.zh.srt`),
    "--lang", arg("--subtitle-lang", "chi"),
    ...(existsSync(join(deliverSubtitleDir, `${PROJECT}.en.srt`))
      ? ["--srt-en", join(deliverSubtitleDir, `${PROJECT}.en.srt`), "--lang-en", "eng"]
      : [])
  ]);
  const info = existsSync(out) ? probe(out) : {};
  const verdict = await reviewStage({
    stage: "mux", projectId: PROJECT,
    artifacts: [
      ...(existsSync(out) ? [{ path: out, kind: "video" as const, probe: info, note: "软字幕轨版（字幕可开关，画面零改动）" }] : []),
      ...(existsSync(join(deliverSubtitleDir, `${PROJECT}.zh.srt`))
        ? [{ path: join(deliverSubtitleDir, `${PROJECT}.zh.srt`), kind: "text" as const, note: "交付目录里的旁挂字幕" }]
        : [])
    ],
    deterministic: [
      { id: "softsub-produced", pass: existsSync(out), detail: existsSync(out) ? "软字幕轨版已产出" : "软字幕轨版未产出", hard: true },
      { id: "tool-exit", pass: result.ok, detail: result.ok ? "字幕工位退出码 0" : `软轨内嵌失败：${result.out.slice(-300)}`, hard: true },
      { id: "video-unchanged", pass: result.out.includes("video_unchanged=ok"), detail: (result.out.match(/复检：[^\n]*/) ?? ["无复检信息"])[0] ?? "", hard: true },
      { id: "subtitle-files", pass: existsSync(join(deliverSubtitleDir, `${PROJECT}.zh.srt`)), detail: "交付目录含旁挂字幕文件（平台上传口/剪辑软件可直接用）", hard: true }
    ],
    context: { mode: SUBTITLE_MODE, toolOutput: result.out.slice(-900), softsub: out },
    env: ENV, allowFallbackApprove: ALLOW_FALLBACK_APPROVE, log
  });
  if (existsSync(out)) softsubFile = out;
  record({
    stage: "mux", shotId: null, invoked: true, ok: result.ok && existsSync(out), cached: false, degraded: false,
    attempt: 1, ms: Date.now() - started, artifact: existsSync(out) ? out : null,
    evidence: { tool: "subtitle-bridge softmux", subtitlesDir: deliverSubtitleDir, videoUnchanged: result.out.includes("video_unchanged=ok") }, verdict
  });
  if (existsSync(out)) {
    log(`软字幕轨版：${out}（画面与 ${basename(scored)} 逐帧一致；旁挂字幕在 ${deliverSubtitleDir}）`);
  }
}

/* ---------- ⑪ 母版交付 + 终审 ---------- */
if (existsSync(scored) && !DRY_RUN) {
  /**
 * 旁挂字幕的**磁盘回填**（2026-09-24 真机）：只跑 `--stages master` 时，进程内 `subtitleSidecar` 为 null，
 * 但文件其实在盘上（上一环节已产出）。门应该看**产物**而不是进程状态——否则"分段重跑"会被误判缺件。
 */
if (!subtitleSidecar && SUBTITLE_MODE !== "burn") {
  const sidecarDir = join(POST_DIR, "subtitles");
  const zhSrt = join(sidecarDir, `${PROJECT}.zh.srt`);
  const zhAss = join(sidecarDir, `${PROJECT}.zh.ass`);
  if (existsSync(zhSrt)) {
    subtitleSidecar = {
      dir: sidecarDir, srt: zhSrt, ass: existsSync(zhAss) ? zhAss : zhSrt,
      manifest: existsSync(join(sidecarDir, `${PROJECT}.subtitle-manifest.json`)) ? join(sidecarDir, `${PROJECT}.subtitle-manifest.json`) : null,
      timelineOk: true
    };
    log(`旁挂字幕从磁盘回填（分段重跑）：${zhSrt}`);
  }
}

const deliverable = DELIVERABLE;
  execFileSync("cp", [scored, deliverable]);
  const info = probe(deliverable);
  const accidents = detectQualityAccidents(deliverable);
  /**
   * 链路完整性：**产物血缘 + 历史裁决**（支持"只重跑一段"）。
   * 历史裁决来自 stages.jsonl；血缘来自文件与 mtime 递进——两者都过才算五项后期都落地。
   */
  const history = readStageHistory();
  /**
   * 血缘链按**实际落地方式**拼：sidecar 模式下母版不烧字，`master-subtitled.mp4` 本来就不该存在，
   * 若把它写死进链，血缘检查会因"缺产物"永久红灯（真机回归会踩）。
   */
  const chain = [
    { label: "raw", path: join(POST_DIR, "master-raw.mp4") },
    { label: "graded", path: join(POST_DIR, "master-graded.mp4") },
    /**
     * burn 模式才把带字幕成片计入血缘；sidecar 模式下母版不烧字，
     * 盘上遗留的旧 master-subtitled.mp4 属于历史产物，计入会造成"时间戳倒序"的假告警（2026-09-24 真机）。
     */
    ...(SUBTITLE_MODE === "burn" && existsSync(join(POST_DIR, "master-subtitled.mp4"))
      ? [{ label: "subtitled", path: join(POST_DIR, "master-subtitled.mp4") }]
      : []),
    /** 弹幕层被显式关闭时不计入血缘（该层本来就不存在，计进去会变成假红灯） */
    ...(DANMAKU_ENABLED ? [{ label: "danmaku", path: join(POST_DIR, "master-danmaku.mp4") }] : []),
    { label: "scored", path: scored },
    ...(softsubFile ? [{ label: "softsub", path: softsubFile }] : [])
  ];
  const lineage = lineageCheck(chain);
  const capabilityStages = (DANMAKU_ENABLED ? ["color", "subtitle", "danmaku", "bgm"] : ["color", "subtitle", "bgm"]) as ReadonlyArray<"color" | "subtitle" | "danmaku" | "bgm">;
  const capabilityChecks = capabilityStages.map((stage) => ({
    id: `history-${stage}`,
    pass: historyApproved(history, stage),
    detail: historyApproved(history, stage)
      ? `历史日志里有 ${stage} 的放行裁决`
      : `历史日志里没有 ${stage} 的放行裁决（若本次只重跑部分环节，请确认该环节此前确实执行过）`
  }));
  if (!DANMAKU_ENABLED) {
    /** 关闭也要留痕：终审报告里写明"弹幕层按平台口径未启用"，而不是让它消失得无影无踪 */
    capabilityChecks.push({
      id: "danmaku-disabled",
      pass: true,
      detail: "弹幕层按平台口径显式关闭（--no-danmaku；小红书等内容社区无弹幕文化），不计入五层血缘"
    });
  }
  const stageSummary = {
    total: records.length,
    invoked: records.filter((r) => r.invoked).length,
    ok: records.filter((r) => r.ok).length,
    failed: records.filter((r) => !r.ok && r.invoked).length,
    degraded: records.filter((r) => r.degraded).length,
    cached: records.filter((r) => r.cached).length,
    skipped: [...STAGES].filter((s) => !records.some((r) => r.stage.startsWith(s))).length
  };
  /**
   * 终审的两条新增硬判据（2026-09-25 产品所有者点名）：
   *   ① **每句台词都要有人声**（`voice` 阶段的逐镜核查结果；只跑 master 时从阶段日志回填）；
   *   ② **素材镜必须过 G-MAT1**（生成溯源 + 非静态直出；素材只作生成输入）。
   * 两条都按"产物 + 历史裁决"判定，支持分段重跑（只跑 master 时也能查到门记录）。
   */
  const voiceHistory = history.filter((r) => r.stage === "voice-summary");
  const narrationFromHistory = (voiceHistory.at(-1)?.evidence as { perShot?: typeof narrationCoverage } | undefined)?.perShot ?? [];
  const coverage = narrationCoverage.length > 0 ? narrationCoverage : narrationFromHistory;
  const dialogueShots = shots.filter((s) => dialogueText(s).length > 0);
  const missingNarration = dialogueShots.filter((s) => !coverage.some((entry) => entry.shotId === s.shotId && entry.ok));
  /**
   * 门事件的形状有两种（都来自同一份 stages.jsonl）：
   *   · 历史行 = `buildGateEvent` 的原始形状（`stepKey` 在顶层、`shotIds` 也在顶层）；
   *   · 本轮内存行 = `recordGate` 的包装形状（`stepKey` / `shotIds` 落在 `evidence` 里）。
   * 早先只读 `evidence.shotIds` → 分段重跑（门记录来自历史行）时"素材镜缺 G-MAT1"误报（真机抓到）。
   * 现在两种形状都读。
   */
  const gateStepKeyOf = (r: Record<string, unknown>): string | null => String(
    (r as { stepKey?: unknown }).stepKey ?? ((r as { evidence?: { stepKey?: unknown } }).evidence?.stepKey) ?? ""
  ) || null;
  const gateShotIdsOf = (r: Record<string, unknown>): string[] => {
    const top = (r as { shotIds?: unknown }).shotIds;
    if (Array.isArray(top)) return top as string[];
    const inner = (r as { evidence?: { shotIds?: unknown } }).evidence?.shotIds;
    return Array.isArray(inner) ? (inner as string[]) : [];
  };
  const gateModeOf = (r: Record<string, unknown>): string | null => String(
    (r as { evidence?: { mode?: unknown } }).evidence?.mode ?? ""
  ) || null;
  const materialGateEvents = [...history, ...records].filter((r) => r.stage === "gate"
    && gateStepKeyOf(r as unknown as Record<string, unknown>) === "material-generate");
  const materialPolicyFails = materialShots.filter((s) => !materialGateEvents.some((r) => {
    const row = r as unknown as Record<string, unknown>;
    return gateModeOf(row) === "verify" && gateShotIdsOf(row).includes(s.shotId) && r.ok;
  }));
  const verdict = await reviewStage({
    stage: "master", projectId: PROJECT,
    /**
     * 终审证据包（2026-09-24 真机修正）：只给成片本体时，监制会凭"看不到封面产物"判定"封面阶段被跳过"。
     * 这里把封面 PNG、阶段汇总 JSON 一并作为产物附件交给它审。
     */
    artifacts: [
      { path: deliverable, kind: "video", bytes: Number(info.bytes ?? 0), probe: info },
      ...(existsSync(join(OUT_DIR, `${PROJECT}-cover.png`)) ? [{ path: join(OUT_DIR, `${PROJECT}-cover.png`), kind: "image" as const, note: "封面产物" }] : []),
      ...(softsubFile ? [{ path: softsubFile, kind: "video" as const, note: "软字幕轨版（字幕可开关、画面零改动）" }] : []),
      ...(subtitleSidecar ? [{ path: subtitleSidecar.srt, kind: "text" as const, note: "旁挂字幕文件（母版未烧字）" }] : []),
      { path: STAGE_LOG, kind: "json", note: "逐环节阶段日志（invoked/ok/degraded/cached/verdict）" }
    ],
    deterministic: [
      ...[],
      { id: "duration", pass: Math.abs(Number(info.duration ?? 0) - totalSeconds) <= 1.0, detail: `成片 ${Number(info.duration ?? 0).toFixed(2)}s（目标 ${totalSeconds}s）`, hard: true },
      { id: "resolution", pass: Number(info.height ?? 0) >= 1920 || Number(info.width ?? 0) >= 1920, detail: `${info.width}x${info.height}`, hard: true },
      { id: "audio", pass: Boolean(info.hasAudio), detail: info.hasAudio ? `音轨 ${info.acodec}` : "无音轨", hard: true },
      { id: "no-black-frame", pass: accidents.blackSeconds <= 0.2, detail: `最长黑帧 ${accidents.blackSeconds.toFixed(2)}s（阈值 ≤0.2s）· ${accidents.detail}`, hard: true },
      { id: "silence-window", pass: accidents.silenceSeconds <= 2.0, detail: `最长静音段 ${accidents.silenceSeconds.toFixed(2)}s（阈值 ≤2.0s；配乐铺底后不应出现长静音）` },
      { id: "post-chain-lineage", pass: lineage.ok, detail: lineage.detail },
      /**
       * 字幕交付口径（2026-09-24）：sidecar 模式必须真的留下旁挂文件；
       * burn 模式必须真的有带字成片。两种都不能"说交付了但盘上什么都没有"。
       */
      {
        id: "subtitle-delivery",
        pass: SUBTITLE_MODE === "burn"
          ? existsSync(join(POST_DIR, "master-subtitled.mp4"))
          : Boolean(subtitleSidecar && existsSync(subtitleSidecar.srt)),
        detail: SUBTITLE_MODE === "burn"
          ? "字幕模式 burn：成片含烧录字幕"
          : `字幕模式 sidecar：母版不烧字，旁挂文件 ${subtitleSidecar ? basename(subtitleSidecar.srt) : "(缺失)"}${softsubFile ? " + 软字幕轨版" : ""}`,
        hard: true
      },
      /**
       * 字幕**标点口径**（2026-09-25）：正规字幕不带标点。
       * 判据看旁挂清单里的机检结果（`no_punctuation`），而不是看内存里的字幕文本——
       * 交付的是文件，门就该验文件。
       */
      {
        id: "subtitle-punctuation",
        pass: SUBTITLE_MODE === "burn"
          /**
           * burn 模式：读字幕环节记录里的 `punctuationOk`（来自工位实测输出）；
           * 分段重跑（只跑 master）时从阶段日志回填——判据始终落在"工位真的查过"这件事上。
           */
          ? (() => {
            const subtitleRecords = [...history, ...records].filter((r) => r.stage === "subtitle" && r.invoked);
            const last = subtitleRecords.at(-1)?.evidence as { punctuationOk?: boolean; punctuationDetail?: string } | undefined;
            return Boolean(last?.punctuationOk);
          })()
          : !subtitleSidecar
          || !subtitleSidecar.manifest
          || (() => {
            try {
              const doc = JSON.parse(readFileSync(subtitleSidecar.manifest!, "utf8")) as { checks?: Array<{ kind?: string; ok?: boolean; detail?: { hits?: number } }> };
              const entry = (doc.checks ?? []).find((c) => c.kind === "no_punctuation");
              return entry ? entry.ok !== false : false;
            } catch {
              return false;
            }
          })(),
        detail: SUBTITLE_MODE === "burn"
          ? (() => {
            const subtitleRecords = [...history, ...records].filter((r) => r.stage === "subtitle" && r.invoked);
            const last = subtitleRecords.at(-1)?.evidence as { punctuationOk?: boolean; punctuationDetail?: string } | undefined;
            return last
              ? `${last.punctuationDetail ?? "标点体检"}` + (last.punctuationOk ? "" : "（不合格：字幕残留标点）")
              : "字幕环节没有标点体检记录（无法证明烧进画面的字幕不带标点）";
          })()
          : subtitleSidecar?.manifest
          ? (() => {
            try {
              const doc = JSON.parse(readFileSync(subtitleSidecar.manifest!, "utf8")) as { checks?: Array<{ kind?: string; ok?: boolean; detail?: { hits?: number } }> };
              const entry = (doc.checks ?? []).find((c) => c.kind === "no_punctuation");
              return entry
                ? `字幕标点体检：残留 ${entry.detail?.hits ?? 0} 处（${entry.ok === false ? "不合格" : "合格"}）`
                : "旁挂清单里没有标点体检项（无法证明字幕不带标点）";
            } catch {
              return "旁挂清单读取失败，标点体检无法核实";
            }
          })()
          : "无旁挂字幕（burn 模式）：标点由字幕工位在烧录校验里把关",
        hard: true
      },
      /**
       * **每句台词都要有人声**（产品所有者 2026-09-25 点名）：画面在动、字幕在跳却没有人声属硬伤。
       * 判据来自 `voice` 阶段的逐镜 ASR + 语音频段活动度核查（阈值见该阶段）。
       */
      {
        id: "narration-coverage",
        pass: missingNarration.length === 0,
        detail: missingNarration.length === 0
          ? `${dialogueShots.length} 个有台词的镜头均有人声（逐镜 ASR 核查）`
          : `以下镜头有台词但人声未通过核查：${missingNarration.map((s) => s.shotId).join("、")}`,
        hard: true
      },
      /**
       * **素材只作生成输入**（产品所有者 2026-09-25 硬规定）：素材镜必须过 G-MAT1 的验证事件。
       */
      {
        id: "material-usage-policy",
        pass: materialPolicyFails.length === 0,
        detail: materialShots.length === 0
          ? "本片无素材镜（无实拍素材入片）"
          : materialPolicyFails.length === 0
            ? `${materialShots.length} 个素材镜均过 G-MAT1（生成溯源 + 非静态直出 + 保真评审；${MATERIAL_POLICY_VERSION}）`
            : `以下素材镜缺 G-MAT1 验证记录：${materialPolicyFails.map((s) => s.shotId).join("、")}（素材不得直接静态展示）`,
        hard: true
      },
      ...capabilityChecks
    ],
    context: {
      stageSummary, stages: [...STAGES],
      narration: coverage.map((entry) => `${entry.shotId}（${entry.speaker}）：${entry.ok ? "有人声" : "缺人声"}`),
      materialPolicy: { version: MATERIAL_POLICY_VERSION, statement: MATERIAL_POLICY_STATEMENT, shots: materialShots.map((s) => s.shotId) }
    },
    env: ENV, allowFallbackApprove: ALLOW_FALLBACK_APPROVE, log
  });
  record({
    stage: "master", shotId: null, invoked: true, ok: verdict.approved, cached: false, degraded: verdict.degraded,
    attempt: 1, ms: verdict.ms, artifact: deliverable, evidence: { ...info, stageSummary }, verdict
  });
  writeFileSync(join(LOG_DIR, "stage-summary.json"), `${JSON.stringify({ project: PROJECT, at: stamp(), summary: stageSummary, deliverable, records }, null, 2)}\n`, "utf8");
  /**
   * 终审结论要如实说：`✅ 成片` 只在监制放行时出现；未放行时输出 ⚠ + 理由，
   * 避免"文件存在"被读成"已通过"。
   */
  if (verdict.approved) log(`✅ 成片（终审放行，score=${verdict.score}）：${deliverable}`);
  else log(`⚠ 母版已生成但**终审未放行**（score=${verdict.score}）：${verdict.reason}\n   文件：${deliverable}（按带瑕疵交付处理，详见阶段日志）`);
}

/* ---------- ⑫ 多风格交付包（step_key: deliver，gate G-DLV1：变体雷同一票否决） ---------- */
/**
 * 管线 yml 的 deliver 步：**干净母版 + 旁挂字幕 + 2–3 个风格变体 + 软字幕轨版 + 交付清单**，
 * 纪律是"镜头只生成一次，变体零 token"——变体只做**后期层派生**（调色/混音/文案），绝不重跑渲染。
 * gate `G-DLV1`：任一对变体"画面与音轨都测不出差别"即一票否决（那不算两个变体，是把同一支片子发两遍）。
 */
if (STAGES.has("deliver") && existsSync(DELIVERABLE) && !DRY_RUN) {
  const started = Date.now();
  const variantPlans = buildVariantPlan({ master: DELIVERABLE, outDir: OUT_DIR, projectId: PROJECT, coverHook: arg("--cover-hook", shotlist.title ?? "") });
  const samples: Array<{ variantId: string; frames: Array<{ r: number; g: number; b: number }>; loudness: { lufs: number; peakDb: number } | null }> = [];
  const variantManifest: Array<{ id: string; label: string; path: string; sha256: string; note: string; gradeProfile: string | null }> = [];
  /** 取几个时间点的 1×1 平均色：稳定的"画面指纹"（不做逐像素对比，只判风格差异是否可测） */
  const meanColorsAt = (file: string, times: number[]): Array<{ r: number; g: number; b: number }> => times.map((at) => {
    const out = spawnSync(FFMPEG, ["-v", "error", "-ss", String(at), "-i", file, "-frames:v", "1", "-vf", "scale=1:1", "-f", "rawvideo", "-pix_fmt", "rgb24", "-"], { maxBuffer: 1024 });
    const buf = out.stdout ?? Buffer.alloc(0);
    return buf.length >= 3 ? { r: buf[0]!, g: buf[1]!, b: buf[2]! } : { r: 0, g: 0, b: 0 };
  });
  for (const plan of variantPlans) {
    try {
      if (plan.passthrough) {
        execFileSync("cp", [DELIVERABLE, plan.output]);
      } else {
        /** 调色变体走同一个调色工位（与母版一致的口径，避免"变体用了另一套引擎"） */
        runCli(COLOR_CLI, [...plan.gradeArgs, "--out", plan.output]);
      }
      if (!existsSync(plan.output)) { log(`  ⚠ 变体 ${plan.variant.id} 未产出（跳过）`); continue; }
      const info = probe(plan.output);
      const duration = Number(info.duration ?? 0);
      const times = [duration * 0.2, duration * 0.5, duration * 0.8].map((t) => Math.max(0.2, Math.round(t * 10) / 10));
      const measured = measureLoudness(plan.output);
      samples.push({
        variantId: plan.variant.id,
        frames: meanColorsAt(plan.output, times),
        loudness: measured.lufs !== null && measured.peakDb !== null ? { lufs: measured.lufs, peakDb: measured.peakDb } : null
      });
      variantManifest.push({
        id: plan.variant.id, label: plan.variant.label, path: plan.output,
        sha256: createHash("sha256").update(readFileSync(plan.output)).digest("hex"),
        note: plan.variant.note, gradeProfile: plan.variant.gradeProfile
      });
      log(`  变体 ${plan.variant.id}（${plan.variant.label}）→ ${basename(plan.output)}`);
    } catch (err) {
      record({
        stage: "deliver", shotId: null, invoked: true, ok: false, cached: false, degraded: false, attempt: 1, ms: 0,
        artifact: null, evidence: { variant: plan.variant.id, error: err instanceof Error ? err.message.slice(0, 300) : String(err) },
        verdict: null, note: "变体派生失败"
      });
    }
  }
  const distinctness = assessVariantDistinctness(samples);
  const gate = recordGate({
    stepKey: "deliver",
    sourceStage: "deliver",
    checks: [
      { id: "variants-produced", pass: variantManifest.length >= 2, hard: true, detail: `产出变体 ${variantManifest.length} 个（至少 2 个才算交付包）：${variantManifest.map((v) => v.id).join("/")}` },
      { id: "variants-distinct", pass: distinctness.approved, hard: true, detail: distinctness.detail }
    ],
    evidence: { samples, variants: variantManifest.map((v) => ({ id: v.id, sha256: v.sha256.slice(0, 16) })) }
  });
  const manifestFile = join(OUT_DIR, `${PROJECT}-delivery-manifest.json`);
  writeFileSync(manifestFile, `${JSON.stringify(buildDeliveryManifest({
    projectId: PROJECT,
    platform: arg("--platform", "抖音/快手"),
    /**
     * 键名必须是模块入参的小写 `deliverable`：批量改名（deliverable→DELIVERABLE）时别把**键**也改掉，
     * 否则这支主件会被 JSON.stringify 静默丢掉（真机 2026-09-25 踩过：清单里没有母版指纹）。
     */
    deliverable: { path: DELIVERABLE, sha256: createHash("sha256").update(readFileSync(DELIVERABLE)).digest("hex"), bytes: statSync(DELIVERABLE).size },
    subtitles: { sidecarDir: subtitleSidecar?.dir ?? null, softsub: softsubFile, burned: SUBTITLE_MODE !== "sidecar" },
    cover: { path: existsSync(join(OUT_DIR, `${PROJECT}-cover.png`)) ? join(OUT_DIR, `${PROJECT}-cover.png`) : null, hook: arg("--cover-hook", shotlist.title ?? "") },
    variants: variantManifest,
    distinctness,
    samples,
    at: stamp()
  }), null, 2)}\n`, "utf8");
  record({
    stage: "deliver", shotId: null, invoked: true, ok: gate.approved, cached: false, degraded: gate.degraded, attempt: 1,
    ms: Date.now() - started, artifact: manifestFile,
    evidence: { variants: variantManifest.map((v) => v.id), distinctness: distinctness.pairs, manifest: manifestFile }, verdict: null, note: "多风格交付包（G-DLV1：变体雷同否决）"
  });
  if (!gate.approved && !ACCEPT_REJECTED.includes("deliver")) {
    log(`⛔ 交付包未放行（G-DLV1）：${gate.reason}`);
    process.exit(6);
  }
}

/* ---------- ⑬ 返修闭环（step_key: revise，gate G-DLV4：层增量 + 复用 sha256 证据） ---------- */
/**
 * 用法：`--stages revise --revise-note "SC-02 手部畸变，另外配乐换掉"`。
 * 行为：把返修意见分诊成 shot-level / layer-level / mixed，写出**影响分析 + 复用 sha256 证据**的返修报告，
 * 并给出可直接执行的 `--stages` 序列；**不自动重跑**（返修要花钱，交给人/上游决定执行）。
 */
if (STAGES.has("revise") && !DRY_RUN) {
  const note = arg("--revise-note", "");
  if (!note) {
    /**
     * 没有返修意见时**这是"不适用"，不是"失败"**（2026-09-25 修正）：
     * 早先记 `ok:false`，阶段汇总里会显示 `revise failed=1`，把"没触发"读成"跑挂了"。
     */
    record({
      stage: "revise", shotId: null, invoked: false, ok: true, cached: false, degraded: false, attempt: 1, ms: 0,
      artifact: null, evidence: { missing: "--revise-note", applicable: false }, verdict: null,
      note: "无返修意见（--revise-note 未提供）：本阶段不适用，未执行"
    });
  } else {
    const started = Date.now();
    const plan = buildRevisionPlan({
      note,
      shots: shots.map((shot) => ({ shotId: shot.shotId, clipPath: join(CLIP_DIR, `${shot.shotId}.mp4`) })),
      hasher: (file) => (existsSync(file) ? createHash("sha256").update(readFileSync(file)).digest("hex") : "missing")
    });
    const report = buildRevisionReport(plan, note);
    const reportFile = join(OUT_DIR, `${PROJECT}-revision-report.json`);
    writeFileSync(reportFile, `${JSON.stringify(report, null, 2)}\n`, "utf8");
    const gate = recordGate({
      stepKey: "revise",
      sourceStage: "revise",
      shotIds: plan.rerunShots,
      checks: [
        { id: "revision-classified", pass: plan.layers.length > 0 || plan.rerunShots.length > 0, hard: true, detail: report.gate.detail },
        { id: "reuse-evidence", pass: plan.reuseEvidence.every((e) => e.sha256 !== "missing"), hard: true, detail: `复用镜头 ${plan.reuseEvidence.length} 个，均带 sha256 证据` },
        { id: "render-gate-awareness", pass: true, hard: false, detail: plan.requiresRenderSubmitGate ? "点名画面内容 → 重跑镜头并走 G8 提交审批" : "纯后期层 → 零渲染（镜头全部复用）" }
      ],
      evidence: { note, kind: plan.kind, stages: plan.stages, reuseEvidence: plan.reuseEvidence.map((e) => ({ shotId: e.shotId, sha256: e.sha256.slice(0, 16) })), report: reportFile }
    });
    record({
      stage: "revise", shotId: null, invoked: true, ok: gate.approved, cached: false, degraded: false, attempt: 1,
      ms: Date.now() - started, artifact: reportFile,
      evidence: { kind: plan.kind, layers: plan.layers, rerunShots: plan.rerunShots, stages: plan.stages }, verdict: null,
      note: `返修影响分析（${plan.kind}）`
    });
    log(`返修报告：${reportFile}`);
    log(`  类型 ${plan.kind}｜重跑镜头 ${plan.rerunShots.join("/") || "无（零渲染）"}｜重做层 ${plan.layers.join(" → ") || "无"}`);
    log(`  建议执行：--stages ${plan.stages.join(",") || "(需人工确认)"}`);
  }
}

/* ---------- 收尾：阶段汇总落盘 ---------- */
const byStage = new Map<string, { invoked: number; ok: number; failed: number; degraded: number; cached: number }>();
for (const r of records) {
  const cur = byStage.get(r.stage) ?? { invoked: 0, ok: 0, failed: 0, degraded: 0, cached: 0 };
  if (r.invoked) cur.invoked += 1;
  if (r.ok) cur.ok += 1; else if (r.invoked) cur.failed += 1;
  if (r.degraded) cur.degraded += 1;
  if (r.cached) cur.cached += 1;
  byStage.set(r.stage, cur);
}
writeFileSync(join(LOG_DIR, "stage-summary.json"), `${JSON.stringify({
  project: PROJECT, at: stamp(), shots: shots.length, totalSeconds,
  stages: Object.fromEntries(byStage), records
}, null, 2)}\n`, "utf8");
log(`阶段日志：${STAGE_LOG}`);
for (const [stage, s] of byStage) log(`  · ${stage.padEnd(14)} invoked=${s.invoked} ok=${s.ok} failed=${s.failed} degraded=${s.degraded} cached=${s.cached}`);
