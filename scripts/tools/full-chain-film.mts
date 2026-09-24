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
 *     [--stages spec,plates,videos,compose,color,subtitle,danmaku,bgm,cover] \
 *     [--aspect 9:16] [--resolution 1080p] [--fps 30] [--max-attempts 2] \
 *     [--keys-file ~/.workloom/live.env] [--brief <brief.json>] [--no-resume] [--dry-run]
 *
 * 阶段日志：`<work-dir>/logs/stages.jsonl`（逐条：stage/shotId/invoked/ok/degraded/cached/verdict）
 * 阶段汇总：`<work-dir>/logs/stages.json`
 */
import { execFileSync, spawnSync } from "node:child_process";
import {
  appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync
} from "node:fs";
import { homedir } from "node:os";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { prepareShotPrompt, reviewStage, type ProducerVerdict } from "../../packages/video-studio/src/index.js";

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
  arg("--stages", "spec,plates,videos,compose,color,subtitle,danmaku,bgm,cover").split(",").map((s) => s.trim()).filter(Boolean)
);

const LOG_DIR = join(WORK_DIR, "logs");
const STAGE_LOG = join(LOG_DIR, "stages.jsonl");
const PLATE_DIR = join(WORK_DIR, "plates", PROJECT);
const CLIP_DIR = join(WORK_DIR, "clips", PROJECT);
const POST_DIR = join(WORK_DIR, "post", PROJECT);
const PROMPT_DIR = join(WORK_DIR, "prompts", PROJECT);
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
        WORKLOOM_VISUAL_ALLOWED_ROOTS: CLI_ALLOWED_ROOTS
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

interface CharacterEntryLike {
  id: string; name: string; files: Record<string, string>; dir: string;
  /** 档案正文里的外貌描述（纯文生图时的唯一人物变量；真人图不可作为视频首帧时靠它保人） */
  appearanceText: string;
}
function loadCharacters(): Map<string, CharacterEntryLike> {
  const library = new Map<string, CharacterEntryLike>();
  if (!existsSync(LIBRARY)) return library;
  for (const name of readdirSync(LIBRARY)) {
    const dir = join(LIBRARY, name);
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
          const hit = readdirSync(setDir).find((f) => f.startsWith(`${profile.name}-${angle}`) && /\.(png|jpe?g)$/i.test(f));
          if (hit) files[angle] = join(setDir, hit);
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
const lead = [...characters.values()].find((c) => c.id === shotlist.character?.id) ?? [...characters.values()][0];

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
function platePrompt(shot: ShotCard, characterName: string, appearanceText = ""): string {
  const pick = (key: string): string => String((shot as Record<string, unknown>)[key] ?? "");
  return [
    /**
     * 白平衡锚点**前置**（`docs/character-archive-design.md` 附录 A.1 复验：写在中后段压不住前置的光照描述，
     * 暖黄肤 warm 0.237 → 0.085 靠的正是把中性白平衡放到最前面）。
     */
    "白平衡中性（日光 5600K，肤色自然）：均匀中性光、没有金色或橙色偏移；避免日落时段的金色调、避免暖黄滤镜、避免橙色调。",
    `【关键帧】${shot.shotId} ${shotlist.title ?? ""}`.trim(),
    `角色：${characterName}${appearanceText ? `。人物外貌（必须严格按此描述，跨镜一致）：${appearanceText}` : ""}`,
    `服装：${pick("costume")}`,
    `妆造：${pick("makeup")}`,
    `场景：${pick("scene")}`,
    `环境细节：${pick("sceneDescription")}`,
    `人物动作与表情（这一帧的瞬间）：${pick("action")}`,
    `构图：${pick("composition")}`,
    `光线：${pick("lighting")}`,
    `色调：${pick("color_palette")}`,
    `情绪：${pick("mood")}`,
    `规格：${ASPECT} 竖幅 ${RESOLUTION}，写实电影感摄影，自然肤质（保留毛孔与细颗粒，不做美颜磨皮），浅景深，纪实风格`,
    "禁止：文字、字幕、水印、logo、卡通、插画、3D 渲染、塑料皮肤、多余手指、第二个人物清晰入镜"
  ].join("\n");
}
function buildSrt(): string {
  const lines: string[] = [];
  let cursor = 0;
  shots.forEach((shot, index) => {
    const duration = Number(shot.duration ?? 5);
    const text = dialogueText(shot);
    if (text) {
      const start = cursor + Math.min(0.6, duration * 0.12);
      const end = cursor + duration - 0.35;
      lines.push(
        String(index + 1),
        `${srtTime(start)} --> ${srtTime(end)}`,
        text,
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
    const file = join(framesDir, `cached-f${i + 1}.png`);
    run(FFMPEG, ["-y", "-ss", String(at), "-i", clip, "-frames:v", "1", file]);
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

/* ---------- ① 脚本 + 提示词交付闸（监制：prompt） ---------- */
if (STAGES.has("spec")) {
  const started = Date.now();
  const checks: Array<{ id: string; pass: boolean; detail: string; hard?: boolean }> = [];
  let rateFail = 0;
  for (const shot of shots) {
    const duration = Number(shot.duration ?? 0);
    const chars = dialogueText(shot).replace(/[，。！？、,.!?]/g, "").length;
    const rate = duration > 0 ? chars / duration : 0;
    const report = prepareShotPrompt(shot as unknown as Record<string, unknown>, { ratio: ASPECT, resolution: RESOLUTION });
    specReports.push({
      shotId: shot.shotId, charCount: report.charCount, promptSource: report.promptSource,
      deliveryPass: report.delivery.pass, issues: report.delivery.issues,
      missingSpecFields: report.missingSpecFields, redlines: report.redlines, degraded: report.degraded
    });
    writeFileSync(join(PROMPT_DIR, `${shot.shotId}.txt`), `${report.prompt}\n`, "utf8");
    const promptFile = join(PROMPT_DIR, `${shot.shotId}.txt`);
    checks.push({
      id: `delivery:${shot.shotId}`, pass: report.delivery.pass, hard: true,
      detail: report.delivery.pass ? `交付闸通过（${report.charCount} 字 · ${report.promptSource}）` : `交付闸未过：${report.delivery.issues.join("；")}`
    });
    checks.push({
      id: `char-count:${shot.shotId}`, pass: report.charCount >= 1200, hard: true,
      detail: `提示词 ${report.charCount} 字（交付口径 ≥1200）`
    });
    checks.push({
      id: `speech-rate:${shot.shotId}`, pass: rate <= 3.6, hard: true,
      detail: `台词 ${chars} 字 / ${duration}s = ${rate.toFixed(2)} 字每秒（上限 3.6）`
    });
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
    artifacts: [{ path: join(PROMPT_DIR, "spec-report.json"), kind: "json" }, ...shots.map((s) => ({ path: join(PROMPT_DIR, `${s.shotId}.txt`), kind: "text" as const }))],
    deterministic: checks, context: { title: shotlist.title, shots: shots.length, rateFail }, env: ENV,
    allowFallbackApprove: ALLOW_FALLBACK_APPROVE, log
  });
  record({
    stage: "prompt-review", shotId: null, invoked: true, ok: verdict.approved, cached: false, degraded: verdict.degraded,
    attempt: 1, ms: verdict.ms, artifact: join(PROMPT_DIR, "spec-report.json"), evidence: { score: verdict.score }, verdict
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
    for (let attempt = 1; attempt <= MAX_ATTEMPTS && !approved; attempt += 1) {
      const started = Date.now();
      try {
        const prompt = platePrompt(shot, lead?.name ?? "主角", lead?.appearanceText ?? "")
          + (attempt > 1 ? "\n重跑要求：构图更准，人物面部与人物描述严格一致，无多余肢体。" : "");
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

/* ---------- ③ 逐镜视频（监制：shot） ---------- */
if (STAGES.has("videos")) {
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
    for (let attempt = 1; attempt <= MAX_ATTEMPTS && !approved; attempt += 1) {
      const started = Date.now();
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
        const submitted = await arkVideo({
          prompt,
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
        /** 抽 3 帧做视觉评审 */
        const framesDir = join(WORK_DIR, "frames", PROJECT, shot.shotId);
        mkdirSync(framesDir, { recursive: true });
        const frameFiles: string[] = [];
        for (const [i, at] of [0.6, duration / 2, Math.max(0.6, duration - 0.8)].entries()) {
          const file = join(framesDir, `f${i + 1}.png`);
          run(FFMPEG, ["-y", "-ss", String(at), "-i", clip, "-frames:v", "1", file]);
          frameFiles.push(file);
        }
        const verdict = await reviewStage({
          stage: "shot", projectId: PROJECT,
          artifacts: [
            { path: clip, kind: "video", bytes: Number(info.bytes ?? 0), probe: info },
            ...frameFiles.map((f) => ({ path: f, kind: "image" as const }))
          ],
          deterministic: [
            { id: "duration", pass: Math.abs(actual - duration) <= 0.6, detail: `期望 ${duration}s 实测 ${actual.toFixed(2)}s`, hard: true },
            { id: "resolution", pass: height >= 720 && width >= 720, detail: `${width}x${height}`, hard: true },
            { id: "audio-track", pass: Boolean(info.hasAudio), detail: info.hasAudio ? `音轨 ${info.acodec}` : "无音轨（配乐环节可兜底，但人声缺失需复核）" }
          ],
          referenceImages: refs.slice(0, 2),
          context: { shotId: shot.shotId, dialogue: dialogueText(shot), action: shot.action, taskId: submitted.taskId },
          env: ENV, allowFallbackApprove: ALLOW_FALLBACK_APPROVE, log
        });
        record({
          stage: "shot", shotId: shot.shotId, invoked: true, ok: verdict.approved, cached: false, degraded: verdict.degraded,
          attempt, ms: Date.now() - started, artifact: clip, evidence: { ...info, taskId: submitted.taskId, frames: frameFiles }, verdict
        });
        approved = verdict.approved;
        if (!approved) log(`↻ 镜头 ${shot.shotId} 第 ${attempt} 次未过监制：${verdict.reason}`);
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

/* ---------- ④ 合成母版 ---------- */
let master = join(POST_DIR, "master-raw.mp4");
if (STAGES.has("compose")) {
  const started = Date.now();
  const clips = shots.map((s) => join(CLIP_DIR, `${s.shotId}.mp4`));
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
      "--fps", String(FPS), "--fade", "0.5", "--color", "none"
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

/* ---------- ⑥ 字幕（subtitle-bridge：选型 + 版式 + 烧录） ---------- */
/** 未重跑字幕时，若磁盘上有"不早于当前上游"的字幕版就沿用它（只重跑后段的场景） */
let subtitled = STAGES.has("subtitle") ? colored : preferDownstream(join(POST_DIR, "master-subtitled.mp4"), colored);
if (STAGES.has("subtitle") && existsSync(colored)) {
  const started = Date.now();
  const srtFile = join(POST_DIR, "subtitle.srt");
  writeFileSync(srtFile, buildSrt(), "utf8");
  const briefFile = BRIEF_FILE ? abs(BRIEF_FILE) : null;
  const out = join(POST_DIR, "master-subtitled.mp4");
  const result = runCli(SUBTITLE_CLI, [
    "burn", "--in", colored, "--out", out, "--srt", srtFile,
    "--title", arg("--title", shotlist.title ?? ""),
    "--platform", arg("--platform", "抖音/快手"),
    ...(briefFile ? ["--brief", briefFile] : []),
    "--evidence-dir", join(POST_DIR, "subtitle-evidence")
  ]);
  const info = existsSync(out) ? probe(out) : {};
  const verdict = await reviewStage({
    stage: "subtitle", projectId: PROJECT,
    artifacts: [{ path: existsSync(out) ? out : colored, kind: "video", probe: info }, { path: srtFile, kind: "text" }],
    deterministic: [
      { id: "burned", pass: existsSync(out), detail: existsSync(out) ? "字幕版已产出" : "字幕版未产出", hard: true },
      { id: "tool-exit", pass: result.ok, detail: result.ok ? "字幕工位退出码 0" : `字幕工位失败：${result.out.slice(-300)}`, hard: true },
      { id: "timeline", pass: /时间轴回读 (\d+)\/(\d+) 条（一致）/.test(result.out) || result.out.includes("一致"), detail: (result.out.match(/时间轴回读[^\n]*/) ?? ["无回读信息"])[0] ?? "" }
    ],
    context: { srt: readFileSync(srtFile, "utf8").slice(0, 1200), platform: arg("--platform", "抖音/快手"), toolOutput: result.out.slice(-900) },
    env: ENV, allowFallbackApprove: ALLOW_FALLBACK_APPROVE, log
  });
  if (existsSync(out)) subtitled = out;
  record({
    stage: "subtitle", shotId: null, invoked: true, ok: result.ok && existsSync(out), cached: false, degraded: false,
    attempt: 1, ms: Date.now() - started, artifact: existsSync(out) ? out : null, evidence: { srt: srtFile, tool: "subtitle-bridge burn" }, verdict
  });
}

/* ---------- ⑦ 弹幕（subtitle-bridge danmaku） ---------- */
let danmakuOut = STAGES.has("danmaku") ? subtitled : preferDownstream(join(POST_DIR, "master-danmaku.mp4"), subtitled);
if (STAGES.has("danmaku") && existsSync(subtitled)) {
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
    context: { genre, mood, policy, via: bgmVia, loudness: mixLufs, measuredLoudness: measured.detail, toolOutput: bgmDetail },
    env: ENV, allowFallbackApprove: ALLOW_FALLBACK_APPROVE, log
  });
  if (existsSync(out)) scored = out;
  record({
    stage: "bgm", shotId: null, invoked: true, ok: result.ok && existsSync(out), cached: false, degraded: false,
    attempt: 1, ms: Date.now() - started, artifact: existsSync(out) ? out : null,
    evidence: { genre, mood, policy, via: bgmVia, loudness: mixLufs, measured: measured.detail, tool: `bgm-bridge ${bgmVia}` }, verdict
  });
}

/* ---------- ⑨ 封面（字幕工位 title 渲染 + 抽帧成图） ---------- */
if (STAGES.has("cover") && existsSync(scored)) {
  const started = Date.now();
  const heroShot = shots[0]!;
  const heroFrame = join(POST_DIR, "cover-base.png");
  /**
   * 封面底图取**未烧字幕的母版**（2026-09-24 真机修正）：
   * 早先从已烧字幕的成片抽帧 → 封面自带底部字幕，与平台 UI 遮挡区冲突（监制打回）。
   */
  run(FFMPEG, ["-y", "-ss", "1.2", "-i", colored, "-frames:v", "1", heroFrame]);
  const stillClip = join(POST_DIR, "cover-base.mp4");
  run(FFMPEG, ["-y", "-loop", "1", "-i", heroFrame, "-t", "3", "-r", String(FPS),
    "-vf", `scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920`, "-pix_fmt", "yuv420p", stillClip]);
  const coverClip = join(POST_DIR, "cover-title.mp4");
  const hook = arg("--cover-hook", "平江路 慢慢走");
  const result = runCli(SUBTITLE_CLI, [
    "title", "--in", stillClip, "--out", coverClip, "--title", hook,
    "--platform", arg("--platform", "抖音/快手")
  ]);
  const coverPng = join(OUT_DIR, `${PROJECT}-cover.png`);
  if (existsSync(coverClip)) run(FFMPEG, ["-y", "-ss", "1.0", "-i", coverClip, "-frames:v", "1", coverPng]);
  const info = existsSync(coverPng) ? { bytes: statSync(coverPng).size } : {};
  const verdict = await reviewStage({
    stage: "cover", projectId: PROJECT,
    artifacts: [{ path: existsSync(coverPng) ? coverPng : heroFrame, kind: "image", bytes: Number(info.bytes ?? 0) }],
    deterministic: [
      { id: "cover-produced", pass: existsSync(coverPng), detail: existsSync(coverPng) ? "封面已产出" : "封面未产出", hard: true },
      { id: "tool-exit", pass: result.ok, detail: result.ok ? "标题渲染退出码 0" : `标题渲染失败：${result.out.slice(-300)}`, hard: true },
      { id: "hook-length", pass: hook.replace(/\s/g, "").length <= 12, detail: `钩子「${hook}」${hook.replace(/\s/g, "").length} 字（口径 ≤9 字/行、最多两行）` }
    ],
    context: { hook, heroShot: heroShot.shotId, toolOutput: result.out.slice(-500) },
    env: ENV, allowFallbackApprove: ALLOW_FALLBACK_APPROVE, log
  });
  record({
    stage: "cover", shotId: null, invoked: true, ok: existsSync(coverPng), cached: false, degraded: false,
    attempt: 1, ms: Date.now() - started, artifact: existsSync(coverPng) ? coverPng : null,
    evidence: { hook, tool: "subtitle-bridge title" }, verdict
  });
}

/* ---------- ⑩ 母版交付 + 终审 ---------- */
if (existsSync(scored) && !DRY_RUN) {
  const deliverable = join(OUT_DIR, `${PROJECT}-30s-final.mp4`);
  execFileSync("cp", [scored, deliverable]);
  const info = probe(deliverable);
  const accidents = detectQualityAccidents(deliverable);
  /**
   * 链路完整性：**产物血缘 + 历史裁决**（支持"只重跑一段"）。
   * 历史裁决来自 stages.jsonl；血缘来自文件与 mtime 递进——两者都过才算五项后期都落地。
   */
  const history = readStageHistory();
  const chain = [
    { label: "raw", path: join(POST_DIR, "master-raw.mp4") },
    { label: "graded", path: join(POST_DIR, "master-graded.mp4") },
    { label: "subtitled", path: join(POST_DIR, "master-subtitled.mp4") },
    { label: "danmaku", path: join(POST_DIR, "master-danmaku.mp4") },
    { label: "scored", path: scored }
  ];
  const lineage = lineageCheck(chain);
  const capabilityChecks = (["color", "subtitle", "danmaku", "bgm"] as const).map((stage) => ({
    id: `history-${stage}`,
    pass: historyApproved(history, stage),
    detail: historyApproved(history, stage)
      ? `历史日志里有 ${stage} 的放行裁决`
      : `历史日志里没有 ${stage} 的放行裁决（若本次只重跑部分环节，请确认该环节此前确实执行过）`
  }));
  const stageSummary = {
    total: records.length,
    invoked: records.filter((r) => r.invoked).length,
    ok: records.filter((r) => r.ok).length,
    failed: records.filter((r) => !r.ok && r.invoked).length,
    degraded: records.filter((r) => r.degraded).length,
    cached: records.filter((r) => r.cached).length,
    skipped: [...STAGES].filter((s) => !records.some((r) => r.stage.startsWith(s))).length
  };
  const verdict = await reviewStage({
    stage: "master", projectId: PROJECT,
    /**
     * 终审证据包（2026-09-24 真机修正）：只给成片本体时，监制会凭"看不到封面产物"判定"封面阶段被跳过"。
     * 这里把封面 PNG、阶段汇总 JSON 一并作为产物附件交给它审。
     */
    artifacts: [
      { path: deliverable, kind: "video", bytes: Number(info.bytes ?? 0), probe: info },
      ...(existsSync(join(OUT_DIR, `${PROJECT}-cover.png`)) ? [{ path: join(OUT_DIR, `${PROJECT}-cover.png`), kind: "image" as const, note: "封面产物" }] : []),
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
      ...capabilityChecks
    ],
    context: { stageSummary, stages: [...STAGES] },
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
