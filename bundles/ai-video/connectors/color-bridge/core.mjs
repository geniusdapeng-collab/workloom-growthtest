/**
 * ai-video × 调色工位 bridge 内核（core.mjs）
 *
 * 定位：把「成片调色」这件事做成可审计的确定性工具层，工位本地执行，零外部依赖
 * （只用 node 内置模块 + 工位本地 ffmpeg/ffprobe）。
 *
 * 纪律（与 geo-growth/connectors/visual-bridge 同构）：
 * - 原片只读：任何写入都落到新文件，覆盖原片直接拒绝（overwrite_source_forbidden）；
 * - 路径监狱：只允许访问白名单根目录内的路径（WORKLOOM_COLOR_ALLOWED_ROOTS）；
 * - 无回执=未核实：产物必须能给出 sha256 与指标复检结果；
 * - 不伪造：失败一律抛带稳定 code 的 ColorError，由上层决定重试或转人工。
 *
 * 调色知识来自公开的 ffmpeg 滤镜语义与行业通行做法（先校正后创作、LUT 最后套、
 * 强度默认不满档、肤色单独复检），参数集为本仓自有取值。
 */

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";

/* ============================ 常量与错误 ============================ */

/** 本连接器提供的工具面；不在表内的工具直接拒绝（与 visual-bridge 同款白名单纪律）。 */
export const COLOR_TOOLS = [
  "colorread.health",
  "colorread.probe",
  "colorread.analyze",
  "colorread.scope",
  "colorread.recipes",
  "colorwrite.grade",
  "colorwrite.best",
  "colorwrite.match",
];

const TOOL_SET = new Set(COLOR_TOOLS);

export const RETRYABLE_CODES = new Set([
  "network_error",
  "timeout",
  "ffmpeg_failed",
  "decode_failed",
  "engine_failed",
  "bad_response",
]);

export const NEVER_RETRY_CODES = new Set([
  "bad_request",
  "not_found",
  "not_provided",
  "path_not_allowed",
  "tenant_mismatch",
  "overwrite_source_forbidden",
  "disk_quota_exceeded",
  "ffmpeg_not_installed",
  "bad_media",
  "bad_lut",
  "bad_profile",
  "bad_patch",
  "idempotency_conflict",
  "not_configured",
]);

export class ColorError extends Error {
  /**
   * @param {string} message
   * @param {string} code
   * @param {boolean} [retryable]
   */
  constructor(message, code, retryable = NEVER_RETRY_CODES.has(code) ? false : RETRYABLE_CODES.has(code)) {
    super(message);
    this.name = "ColorError";
    this.code = code;
    this.retryable = retryable;
  }
}

export function isColorTool(name) {
  return TOOL_SET.has(name);
}

/* ============================ 二进制解析 ============================ */

/** ffmpeg/ffprobe 解析顺序：显式环境变量 → 仓内工位工具链 → PATH。 */
export function resolveBinaries(env = process.env) {
  const here = path.dirname(new URL(import.meta.url).pathname);
  const bundled = path.resolve(here, "../../../../.workloom-tools/color");
  const pick = (explicit, name) => {
    if (explicit && fs.existsSync(explicit)) return explicit;
    const local = path.join(bundled, name);
    if (fs.existsSync(local)) return local;
    return name; // 交给 PATH 解析；找不到时由 runBin 抛 ffmpeg_not_installed
  };
  return {
    ffmpeg: pick(env.FFMPEG_PATH, "ffmpeg"),
    ffprobe: pick(env.FFPROBE_PATH, "ffprobe"),
  };
}

/* ============================ 路径监狱 ============================ */

function isInside(child, parent) {
  const rel = path.relative(parent, child);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

function realpathDeepest(target) {
  let probe = target;
  while (!fs.existsSync(probe)) {
    const parent = path.dirname(probe);
    if (parent === probe) break;
    probe = parent;
  }
  const real = fs.realpathSync(probe);
  return path.join(real, path.relative(probe, target));
}

/** 允许根目录：环境变量优先，缺省只放行进程工作目录与系统临时目录。 */
export function allowedRoots(env = process.env) {
  const raw = (env.WORKLOOM_COLOR_ALLOWED_ROOTS ?? "").trim();
  const list = raw ? raw.split(":").map((s) => s.trim()).filter(Boolean) : [process.cwd(), os.tmpdir()];
  return list.map((entry) => {
    const abs = path.resolve(entry);
    return fs.existsSync(abs) ? fs.realpathSync(abs) : abs;
  });
}

/**
 * 路径白名单校验（软链逃逸也拦：对真实路径做前缀判定）。
 * @returns {string} 规范化后的绝对路径
 */
export function assertPathAllowed(target, roots = allowedRoots(), label = "path") {
  if (typeof target !== "string" || target.trim() === "") {
    throw new ColorError(`${label} 为空`, "bad_request");
  }
  const abs = path.resolve(target);
  const normalized = realpathDeepest(abs);
  // 宿主根目录同样做真实路径归一：macOS 上 /tmp、/var 都是软链（→ /private/...），
  // 否则合法的白名单会被误判为越界。
  const normalizedRoots = roots.map((root) => {
    const resolved = path.resolve(String(root));
    return fs.existsSync(resolved) ? fs.realpathSync(resolved) : resolved;
  });
  if (!normalizedRoots.some((root) => isInside(normalized, root))) {
    throw new ColorError(`${label} 越出允许目录（路径监狱）：${abs}`, "path_not_allowed");
  }
  return normalized;
}

/* ============================ 进程执行 ============================ */

async function runBin(bin, args, { timeoutMs = 300_000, label = "ffmpeg" } = {}) {
  return await new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(bin, args, { stdio: ["ignore", "pipe", "pipe"] });
    } catch (error) {
      reject(new ColorError(`${label} 无法启动：${error instanceof Error ? error.message : String(error)}`, "ffmpeg_not_installed"));
      return;
    }
    const stdout = [];
    const stderr = [];
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill("SIGKILL");
      reject(new ColorError(`${label} 执行超时（${timeoutMs}ms）`, "timeout", true));
    }, timeoutMs);

    child.stdout.on("data", (chunk) => stdout.push(chunk));
    child.stderr.on("data", (chunk) => stderr.push(chunk));
    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const message = error instanceof Error ? error.message : String(error);
      const missing = /ENOENT/.test(message);
      reject(new ColorError(`${label} 启动失败：${message}`, missing ? "ffmpeg_not_installed" : "engine_failed"));
    });
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const out = Buffer.concat(stdout);
      const err = Buffer.concat(stderr).toString("utf8");
      if (code === 0) {
        resolve({ stdout: out, stderr: err });
        return;
      }
      reject(new ColorError(`${label} 退出码 ${code}：${err.split("\n").filter(Boolean).slice(-3).join(" | ")}`, "ffmpeg_failed", true));
    });
  });
}

/* ============================ 媒体探测 ============================ */

export async function probeMedia(input, { bins = resolveBinaries() } = {}) {
  const { stdout } = await runBin(bins.ffprobe, [
    "-v", "error",
    "-print_format", "json",
    "-show_format", "-show_streams",
    input,
  ], { label: "ffprobe", timeoutMs: 60_000 });

  let parsed;
  try {
    parsed = JSON.parse(stdout.toString("utf8"));
  } catch {
    throw new ColorError("ffprobe 返回无法解析的 JSON", "bad_media");
  }
  const streams = Array.isArray(parsed.streams) ? parsed.streams : [];
  const video = streams.find((s) => s.codec_type === "video") ?? null;
  const audio = streams.find((s) => s.codec_type === "audio") ?? null;
  if (!video) throw new ColorError("输入不含视频轨", "bad_media");

  const parseRate = (value) => {
    if (typeof value !== "string" || !value.includes("/")) return null;
    const [a, b] = value.split("/").map(Number);
    return b ? Math.round((a / b) * 1000) / 1000 : null;
  };

  return {
    duration: Number(parsed.format?.duration ?? video.duration ?? 0),
    sizeBytes: Number(parsed.format?.size ?? 0),
    formatName: parsed.format?.format_name ?? null,
    video: {
      codec: video.codec_name ?? null,
      width: Number(video.width ?? 0),
      height: Number(video.height ?? 0),
      fps: parseRate(video.r_frame_rate),
      pixelFormat: video.pix_fmt ?? null,
      bitDepth: video.bits_per_raw_sample ? Number(video.bits_per_raw_sample) : null,
      colorSpace: video.color_space ?? null,
      colorPrimaries: video.color_primaries ?? null,
      colorTransfer: video.color_transfer ?? null,
      colorRange: video.color_range ?? null,
    },
    audio: audio ? { codec: audio.codec_name ?? null, channels: Number(audio.channels ?? 0) } : null,
  };
}

/* ============================ 帧级统计 ============================ */

function parseSignalStats(text) {
  const out = {};
  for (const line of text.split("\n")) {
    const match = /^lavfi\.signalstats\.([A-Z]+)=(-?\d+(?:\.\d+)?)$/.exec(line.trim());
    if (match) out[match[1]] = Number(match[2]);
  }
  return out;
}

function patchToCrop(patch) {
  if (!patch) return null;
  const { x, y, w, h } = patch;
  for (const [key, value] of Object.entries({ x, y, w, h })) {
    if (!Number.isFinite(value) || value < 0) throw new ColorError(`crop 参数 ${key} 非法`, "bad_patch");
  }
  if (w < 1 || h < 1) throw new ColorError("crop 宽高必须 ≥1", "bad_patch");
  return `crop=${Math.round(w)}:${Math.round(h)}:${Math.round(x)}:${Math.round(y)}`;
}

/**
 * 单帧信号统计（YUV 原生管线，不做 PNG 中转，避免色度转换误差）。
 * @param {{input:string, at:number, crop?:string, bins?:object}} params
 */
export async function frameStats({ input, at = 0, patch = null, bins = resolveBinaries() }) {
  const tmp = path.join(os.tmpdir(), `color-stats-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.txt`);
  const filters = [patchToCrop(patch), "signalstats", `metadata=print:file=${tmp.replace(/:/g, "\\:")}`].filter(Boolean).join(",");
  try {
    await runBin(bins.ffmpeg, [
      "-hide_banner", "-v", "error",
      "-ss", String(at),
      "-i", input,
      "-frames:v", "1",
      "-vf", filters,
      "-f", "null", "-",
    ], { label: "ffmpeg(signalstats)", timeoutMs: 120_000 });
    const text = await fsp.readFile(tmp, "utf8").catch(() => "");
    return parseSignalStats(text);
  } finally {
    await fsp.rm(tmp, { force: true }).catch(() => {});
  }
}

/** 区域平均 RGB（把区域缩放到 1×1 取像素），用于白平衡/肤色取证。 */
export async function regionAverageRgb({ input, at = 0, patch, bins = resolveBinaries() }) {
  const filters = [patchToCrop(patch), "scale=1:1:flags=area", "format=rgb24"].filter(Boolean).join(",");
  const { stdout } = await runBin(bins.ffmpeg, [
    "-hide_banner", "-v", "error",
    "-ss", String(at),
    "-i", input,
    "-frames:v", "1",
    "-vf", filters,
    "-f", "rawvideo", "-pix_fmt", "rgb24", "-",
  ], { label: "ffmpeg(rgb-probe)", timeoutMs: 60_000 });
  if (stdout.length < 3) throw new ColorError("区域取样失败", "decode_failed", true);
  const [r, g, b] = [stdout[0], stdout[1], stdout[2]];
  return { r, g, b, luma: Math.round(0.2126 * r + 0.7152 * g + 0.0722 * b) };
}

/* ============================ 诊断 ============================ */

/* ---------- 题材×场景调色配方库（调色师的专业知识底座） ---------- */

const RECIPE_FILE = path.resolve(
  path.dirname(new URL(import.meta.url).pathname),
  "../../library/color-recipes/recipes.json",
);
const LUT_DIR = path.resolve(path.dirname(new URL(import.meta.url).pathname), "../../library/luts");

let recipeCache = null;

/** 读配方库（带缓存；文件缺失=显式失败，不静默返回空）。 */
export function loadRecipes(file = RECIPE_FILE) {
  if (recipeCache && recipeCache.file === file) return recipeCache.doc;
  if (!fs.existsSync(file)) {
    throw new ColorError(`调色配方库缺失：${file}（随 bundles/ai-video/library/color-recipes 分发）`, "bad_request");
  }
  let doc;
  try {
    doc = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (error) {
    throw new ColorError(`调色配方库解析失败：${error instanceof Error ? error.message : String(error)}`, "bad_request");
  }
  if (!Array.isArray(doc?.recipes) || doc.recipes.length === 0) {
    throw new ColorError("调色配方库为空", "bad_request");
  }
  recipeCache = { file, doc };
  return doc;
}

/**
 * 按题材/场景/平台检索配方，并把 profile/LUT/强度解析成可直接执行的形式。
 * @param {{recipeId?:string, genre?:string, platform?:string, keyword?:string, list?:boolean}} query
 */
export function findRecipes(query = {}) {
  const doc = loadRecipes();
  const norm = (v) => String(v ?? "").trim().toLowerCase();
  const genre = norm(query.genre);
  const platform = norm(query.platform);
  const keyword = norm(query.keyword);

  const matched = doc.recipes.filter((r) => {
    if (query.recipeId && r.id !== query.recipeId) return false;
    if (genre && !norm(r.genre).includes(genre) && !genre.includes(norm(r.genre))) return false;
    if (platform && !(r.platforms ?? []).some((p) => norm(p) === platform || norm(p).includes(platform))) return false;
    if (keyword) {
      const haystack = norm([r.id, r.genre, r.scene, r.mood, ...(r.avoid ?? [])].join(" "));
      if (!haystack.includes(keyword)) return false;
    }
    return true;
  });
  if (query.recipeId && matched.length === 0) {
    throw new ColorError(`配方不存在：${query.recipeId}（可用：${doc.recipes.map((r) => r.id).join(", ")}）`, "not_found");
  }

  const resolve = (r) => {
    const lutRel = r.lut ?? null;
    const lutAbs = lutRel ? path.join(LUT_DIR, lutRel) : null;
    return {
      id: r.id,
      genre: r.genre,
      scene: r.scene,
      mood: r.mood,
      profile: r.profile,
      lut: lutAbs,
      lutExists: lutAbs ? fs.existsSync(lutAbs) : false,
      intensity: r.intensity,
      targets: { ...doc.targets, ...(r.overrides ?? {}) },
      platforms: r.platforms ?? [],
      avoid: r.avoid ?? [],
      notes: r.notes ?? null,
    };
  };

  if (query.list) {
    return {
      total: doc.recipes.length,
      principle: doc.principle,
      items: matched.map((r) => ({ id: r.id, genre: r.genre, scene: r.scene, mood: r.mood, profile: r.profile, lut: r.lut, intensity: r.intensity, platforms: r.platforms ?? [] })),
    };
  }
  const selected = matched[0];
  return { total: doc.recipes.length, matched: matched.length, recipe: selected ? resolve(selected) : null, alternatives: matched.slice(1, 4).map((r) => r.id) };
}

const TARGET = {
  yMin: [0, 16],
  yAvg: [80, 140],
  yMax: [235, 255],
  uvAvg: [122, 134],
  satAvg: [40, 80],
  skinHue: [20, 40],
};

function defaultTimestamps(duration) {
  if (!Number.isFinite(duration) || duration <= 0) return [0];
  const marks = [duration * 0.1, duration * 0.35, duration * 0.6, duration * 0.85];
  return [...new Set(marks.map((t) => Math.max(0, Math.round(t * 100) / 100)))];
}

export function summarize(stats) {
  const fields = ["YMIN", "YLOW", "YAVG", "YHIGH", "YMAX", "UAVG", "VAVG", "SATAVG", "SATMAX", "HUEAVG"];
  const out = {};
  for (const field of fields) {
    const values = stats.map((s) => s[field]).filter((v) => Number.isFinite(v));
    out[field] = values.length ? values.reduce((a, b) => a + b, 0) / values.length : null;
  }
  return out;
}

/**
 * 成片色彩诊断：抽帧 → 指标 → 问题清单（含修复建议）。
 * @returns {Promise<object>}
 */
export async function analyze({ input, at = null, patch = null, skinPatch = null, neutralPatch = null, bins = resolveBinaries() }) {
  const probe = await probeMedia(input, { bins });
  const times = Array.isArray(at) && at.length ? at : defaultTimestamps(probe.duration);
  const frameCount = Math.max(1, probe.video.width * probe.video.height);

  const perFrame = [];
  for (const t of times) {
    const stats = await frameStats({ input, at: t, patch, bins });
    perFrame.push({ at: t, ...stats });
  }
  const summary = summarize(perFrame);

  const issues = [];
  const yAvg = summary.YAVG;
  if (Number.isFinite(yAvg)) {
    if (yAvg < TARGET.yAvg[0]) {
      issues.push({
        kind: "underexposed",
        severity: "warn",
        detail: `平均亮度 ${yAvg.toFixed(1)} 低于目标下限 ${TARGET.yAvg[0]}`,
        suggestion: `提高曝光（eq=brightness≈${(((TARGET.yAvg[0] + TARGET.yAvg[1]) / 2 - yAvg) / 255).toFixed(3)}）或提 gamma`,
      });
    } else if (yAvg > TARGET.yAvg[1]) {
      issues.push({
        kind: "overexposed",
        severity: "warn",
        detail: `平均亮度 ${yAvg.toFixed(1)} 高于目标上限 ${TARGET.yAvg[1]}`,
        suggestion: `降低曝光（eq=brightness≈${(((TARGET.yAvg[0] + TARGET.yAvg[1]) / 2 - yAvg) / 255).toFixed(3)}）`,
      });
    }
  }

  const crushRatio = Number.isFinite(summary.YLOW) ? summary.YLOW / frameCount : 0;
  const blowRatio = Number.isFinite(summary.YHIGH) ? summary.YHIGH / frameCount : 0;
  if (crushRatio > 0.01) {
    issues.push({
      kind: "shadow_crush",
      severity: "warn",
      detail: `暗部压死像素占比约 ${(crushRatio * 100).toFixed(1)}%`,
      suggestion: "提黑位（curves 抬底）或降低对比",
    });
  }
  if (blowRatio > 0.01) {
    issues.push({
      kind: "highlight_clip",
      severity: "warn",
      detail: `高光裁切像素占比约 ${(blowRatio * 100).toFixed(1)}%`,
      suggestion: "压高光（curves 收顶）或降低曝光",
    });
  }

  const uDelta = Number.isFinite(summary.UAVG) ? summary.UAVG - 128 : 0;
  const vDelta = Number.isFinite(summary.VAVG) ? summary.VAVG - 128 : 0;
  if (Math.abs(uDelta) > 6 || Math.abs(vDelta) > 6) {
    const direction = [];
    if (uDelta > 6) direction.push("偏蓝");
    if (uDelta < -6) direction.push("偏黄");
    if (vDelta > 6) direction.push("偏红");
    if (vDelta < -6) direction.push("偏绿");
    issues.push({
      kind: "color_cast",
      severity: "warn",
      detail: `中性色度偏移 U${uDelta >= 0 ? "+" : ""}${uDelta.toFixed(1)} / V${vDelta >= 0 ? "+" : ""}${vDelta.toFixed(1)}（${direction.join("、")}）`,
      suggestion: "先做白平衡：colorbalance 按 U/V 偏移反向微调，或提供 neutral 灰区精确校正",
    });
  }

  const satAvg = summary.SATAVG;
  if (Number.isFinite(satAvg)) {
    if (satAvg < TARGET.satAvg[0]) {
      issues.push({ kind: "low_saturation", severity: "info", detail: `平均饱和 ${satAvg.toFixed(1)} 偏低`, suggestion: "eq=saturation 上调（≤1.2）" });
    } else if (satAvg > TARGET.satAvg[1]) {
      issues.push({ kind: "high_saturation", severity: "info", detail: `平均饱和 ${satAvg.toFixed(1)} 偏高`, suggestion: "eq=saturation 下调，注意肤色" });
    }
  }

  let whiteBalance = null;
  if (neutralPatch) {
    const sample = await regionAverageRgb({ input, at: times[0], patch: neutralPatch, bins });
    const target = (sample.r + sample.g + sample.b) / 3;
    whiteBalance = {
      sample,
      gains: { r: target / sample.r, g: target / sample.g, b: target / sample.b },
      confidence: "high",
      source: "neutral-patch",
    };
  } else {
    const gray = await regionAverageRgb({ input, at: times[0], bins });
    const target = (gray.r + gray.g + gray.b) / 3;
    whiteBalance = {
      sample: gray,
      gains: { r: target / gray.r, g: target / gray.g, b: target / gray.b },
      confidence: "low",
      source: "gray-world",
      note: "未提供 neutral 灰区，按灰世界估计，强彩光场景不可靠",
    };
  }
  if (whiteBalance && whiteBalance.confidence === "high") {
    const spread = Math.max(...Object.values(whiteBalance.gains)) - Math.min(...Object.values(whiteBalance.gains));
    if (spread > 0.06) {
      issues.push({
        kind: "white_balance",
        severity: "warn",
        detail: `灰区 R/G/B 增益离散 ${spread.toFixed(3)}，白平衡未中性`,
        suggestion: "按 gains 反推 colortemperature / colorbalance 校正",
      });
    }
  }

  let skin = null;
  if (skinPatch) {
    const stats = await frameStats({ input, at: times[0], patch: skinPatch, bins });
    const hue = stats.HUEAVG;
    const sat = stats.SATAVG;
    const healthy = Number.isFinite(hue) && hue >= TARGET.skinHue[0] && hue <= TARGET.skinHue[1] && (!Number.isFinite(sat) || sat <= 60);
    skin = { hue: Number.isFinite(hue) ? hue : null, saturation: Number.isFinite(sat) ? sat : null, healthy };
    if (!healthy) {
      issues.push({
        kind: "skin_tone",
        severity: "warn",
        detail: `肤色取样 hue=${Number.isFinite(hue) ? hue.toFixed(1) : "n/a"}°（目标 ${TARGET.skinHue[0]}–${TARGET.skinHue[1]}°）`,
        suggestion: "先修白平衡再动饱和；肤色优先于风格化",
      });
    }
  }

  const transfer = probe.video.colorTransfer;
  const isLogish = transfer === "arib-std-b67" || transfer === "smpte2084"
    || (Number.isFinite(summary.YMAX) && Number.isFinite(summary.YMIN) && summary.YMAX - summary.YMIN < 120);
  if (isLogish) {
    issues.push({
      kind: "log_or_flat",
      severity: "warn",
      detail: `疑似 log/HLG/PQ 素材（color_transfer=${transfer ?? "unspecified"}，动态范围偏平）`,
      suggestion: "先套转换 LUT（本仓 slog3-to-rec709）再校正，禁止直接叠加创意 LUT",
    });
  }

  return {
    input,
    probe,
    timestamps: times,
    perFrame,
    summary,
    whiteBalance,
    skin,
    issues,
    targets: TARGET,
  };
}

/* ============================ 滤镜链 ============================ */

/**
 * 内置 look（本仓自有参数；强度由 intensity 混合控制，默认不满档）。
 * 顺序纪律：normalize → colortemperature → colorbalance → curves → eq → lut3d（最后）。
 */
export const PROFILES = {
  // 强度口径：这里的参数是"满档"（intensity=1.0）的画面语言，量级对齐行业通行 look；
  // 早期版本参数过弱（Δ≈1.5% 像素差）导致"调了跟没调一样"，已按可见性校验重标定。
  natural: "eq=contrast=1.03:saturation=1.04",
  "clean-bright":
    "curves=all='0/0.03 0.25/0.29 0.5/0.55 0.75/0.80 1/1',"
    + "eq=contrast=1.03:saturation=1.14:brightness=0.02:gamma=1.05",
  "warm-film":
    "colorbalance=rs=0.11:gs=0.03:bs=-0.10:rm=0.06:gm=0.01:bm=-0.06:rh=0.09:gh=0.02:bh=-0.08,"
    + "curves=all='0/0.045 0.25/0.27 0.5/0.53 0.75/0.78 1/0.97',"
    + "eq=contrast=1.07:saturation=1.08:gamma=1.03",
  "cool-technical":
    "colorbalance=rs=-0.07:gs=-0.02:bs=0.13:rm=-0.04:gm=0:bm=0.08:rh=-0.03:gh=0.01:bh=0.07,"
    + "eq=contrast=1.09:saturation=0.93:gamma=0.98",
  "teal-orange":
    "colorbalance=rs=-0.17:gs=-0.05:bs=0.22:rm=0:gm=-0.02:bm=0.04:rh=0.17:gh=0.02:bh=-0.18,"
    + "curves=r='0/0 0.25/0.22 0.5/0.56 0.75/0.81 1/1':b='0/0.07 0.25/0.28 0.5/0.45 0.75/0.69 1/0.88',"
    + "eq=contrast=1.15:saturation=1.02:gamma=0.97",
  "moody-dark":
    "curves=all='0/0.025 0.2/0.14 0.5/0.44 0.85/0.82 1/0.95',"
    + "colorbalance=rs=-0.06:gs=-0.02:bs=0.11:rm=-0.02:gm=-0.01:bm=0.04:rh=0:gh=-0.02:bh=0.06,"
    + "eq=contrast=1.17:saturation=0.76:brightness=-0.035:gamma=0.93",
  "high-contrast-social":
    "curves=all='0/0 0.18/0.10 0.5/0.51 0.82/0.89 1/1',"
    + "eq=contrast=1.22:saturation=1.18:gamma=0.96",
  "vintage-fade":
    "curves=all='0/0.075 0.25/0.25 0.75/0.76 1/0.92':r='0/0.06 0.5/0.52 1/0.96':b='0/0.09 0.5/0.44 1/0.87',"
    + "colorbalance=rs=0.05:gs=0.02:bs=-0.04:rh=0.05:gh=0.03:bh=-0.03,"
    + "eq=contrast=0.97:saturation=0.84:gamma=1.04",
};

function escapeFilterPath(p) {
  return String(p).replace(/\\/g, "/").replace(/:/g, "\\:").replace(/'/g, "\\'");
}

function buildCorrections({ normalize, colorTemperature, colorBalance, curves, eq }) {
  const parts = [];
  if (normalize) parts.push("normalize=blackpt=black:whitept=white:smoothing=0");
  if (colorTemperature) parts.push(`colortemperature=temperature=${Number(colorTemperature)}`);
  if (colorBalance) {
    const cb = Object.entries(colorBalance)
      .filter(([, value]) => Number.isFinite(value) && value !== 0)
      .map(([key, value]) => `${key}=${Number(value)}`)
      .join(":");
    if (cb) parts.push(`colorbalance=${cb}`);
  }
  if (curves) {
    const curve = Object.entries(curves).map(([key, value]) => `${key}='${value}'`).join(":");
    parts.push(`curves=${curve}`);
  }
  if (eq) {
    const eqArgs = Object.entries(eq)
      .filter(([, value]) => Number.isFinite(value))
      .map(([key, value]) => `${key}=${Number(value)}`)
      .join(":");
    if (eqArgs) parts.push(`eq=${eqArgs}`);
  }
  return parts;
}

/**
 * 组装滤镜链。
 * @param {{profile?:string, lutPath?:string, corrections?:object, intensity?:number}} spec
 */
export function buildChain(spec = {}) {
  const { profile = null, lutPath = null, corrections = {}, intensity = 1 } = spec;
  if (!Number.isFinite(intensity) || intensity <= 0 || intensity > 1) {
    throw new ColorError(`intensity 必须落在 (0,1]，收到 ${intensity}`, "bad_request");
  }
  if (profile && !PROFILES[profile]) {
    throw new ColorError(`未知 profile：${profile}（可用：${Object.keys(PROFILES).join(", ")}）`, "bad_profile");
  }

  // 两段式：校正（白平衡/曝光/裁切）恒为 100% 生效；只有"创作 look"（profile/LUT）按 intensity 混合。
  // 理由：把校正也一起按 0.8 稀释，会让"欠曝修一半"，画面几乎看不出变化（早期 bug）。
  const correctionParts = buildCorrections(corrections ?? {});
  const lookParts = [];
  if (profile) lookParts.push(PROFILES[profile]);
  if (lutPath) lookParts.push(`lut3d='${escapeFilterPath(lutPath)}'`);
  if (correctionParts.length === 0 && lookParts.length === 0) {
    throw new ColorError("未指定任何 profile / lut / corrections", "bad_request");
  }

  const correctionChain = correctionParts.join(",");
  const lookChain = lookParts.join(",");
  if (!lookChain) return correctionChain;                       // 只做校正
  if (intensity >= 1) return [correctionChain, lookChain].filter(Boolean).join(",");
  const head = correctionChain ? `${correctionChain},` : "";
  // 强度混合：`blend` 的 all_opacity 权重作用在**第一个输入**上（ffmpeg 语义，已实测校准）。
  // 因此把「已调色」放前面、opacity=intensity，才是"按 intensity 叠加 look"。
  // 反着写（原片在前 + opacity=intensity）会让 look 恒接近满档——2026-09-21 的"强度参数失效"事故根因。
  return `${head}split=2[__orig][__tograde];[__tograde]${lookChain}[__graded];[__graded][__orig]blend=all_mode=normal:all_opacity=${intensity}`;
}

/* ============================ 调色 / 匹配 ============================ */

async function assertOutputWritable(outputPath, inputPath, inputSize) {
  if (path.resolve(outputPath) === path.resolve(inputPath)) {
    throw new ColorError("禁止覆盖原片（原片只读）", "overwrite_source_forbidden");
  }
  const dir = path.dirname(outputPath);
  await fsp.mkdir(dir, { recursive: true });
  try {
    const stat = await fsp.statfs(dir);
    const free = stat.bavail * stat.bsize;
    const need = Math.max(200 * 1024 * 1024, (inputSize || 0) * 3);
    if (free < need) {
      throw new ColorError(`磁盘余量不足：可用 ${(free / 1024 / 1024).toFixed(0)}MB < 需要 ${(need / 1024 / 1024).toFixed(0)}MB`, "disk_quota_exceeded");
    }
  } catch (error) {
    if (error instanceof ColorError) throw error;
    throw new ColorError(`输出目录不可写：${error instanceof Error ? error.message : String(error)}`, "bad_request");
  }
  return dir;
}

export async function sha256File(file) {
  return await new Promise((resolve, reject) => {
    const hash = createHash("sha256");
    const stream = fs.createReadStream(file);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("error", (error) => reject(new ColorError(`读取失败：${error.message}`, "not_found")));
    stream.on("end", () => resolve(hash.digest("hex")));
  });
}

/**
 * 应用调色并出片；返回产物信息、实测指标与前后差值（不带指标的回执不算回执）。
 */
export async function grade({
  input, output, profile = null, lutPath = null, corrections = {}, intensity = 0.8,
  verifyAt = null, bins = resolveBinaries(), auto = false,
}) {
  const probe = await probeMedia(input, { bins });
  await assertOutputWritable(output, input, probe.sizeBytes);
  if (lutPath && !fs.existsSync(lutPath)) throw new ColorError(`LUT 不存在：${lutPath}`, "bad_lut");
  if (lutPath && !/\.cube$/i.test(lutPath)) throw new ColorError(`LUT 必须是 .cube：${lutPath}`, "bad_lut");

  // 校验帧：默认 4 帧（首段/前中/后中/尾段），避免用 1–2 帧代表整片（多切点素材会失真）。
  const at = Array.isArray(verifyAt) && verifyAt.length ? verifyAt : defaultTimestamps(probe.duration);

  let effectiveCorrections = corrections ?? {};
  let autoUsed = null;
  if (auto) {
    const frames = [];
    for (const t of at) frames.push(await frameStats({ input, at: t, bins }));
    autoUsed = autoCorrections(summarize(frames));
    // 显式传入的 corrections 覆盖自动结果（人/岗位永远可以压在自动之上）
    effectiveCorrections = {
      ...autoUsed,
      ...effectiveCorrections,
      eq: { ...(autoUsed.eq ?? {}), ...(effectiveCorrections.eq ?? {}) },
      colorBalance: { ...(autoUsed.colorBalance ?? {}), ...(effectiveCorrections.colorBalance ?? {}) },
    };
    if (!Object.keys(effectiveCorrections.eq ?? {}).length) delete effectiveCorrections.eq;
    if (!Object.keys(effectiveCorrections.colorBalance ?? {}).length) delete effectiveCorrections.colorBalance;
  }

  const chain = buildChain({ profile, lutPath, corrections: effectiveCorrections, intensity });

  const before = [];
  for (const t of at) before.push({ at: t, ...(await frameStats({ input, at: t, bins })) });

  const args = [
    "-hide_banner", "-v", "error", "-y",
    "-i", input,
    "-vf", chain,
    "-c:v", "libx264", "-preset", "medium", "-crf", "20", "-pix_fmt", "yuv420p",
  ];
  if (probe.audio) args.push("-c:a", "aac", "-b:a", "192k");
  args.push("-movflags", "+faststart", output);

  await runBin(bins.ffmpeg, args, { label: "ffmpeg(grade)", timeoutMs: 900_000 });

  if (!fs.existsSync(output)) throw new ColorError("ffmpeg 未产出文件", "ffmpeg_failed", true);
  const outProbe = await probeMedia(output, { bins });
  const after = [];
  for (const t of at) after.push({ at: t, ...(await frameStats({ input: output, at: t, bins })) });

  const beforeSummary = summarize(before);
  const afterSummary = summarize(after);
  const delta = {};
  for (const key of ["YAVG", "UAVG", "VAVG", "SATAVG"]) {
    if (Number.isFinite(beforeSummary[key]) && Number.isFinite(afterSummary[key])) {
      delta[key] = Math.round((afterSummary[key] - beforeSummary[key]) * 100) / 100;
    }
  }

  // 可见性校验（fail-closed）：调用方要了创作 look（profile/LUT），画面却几乎没变 → 拒绝交付。
  // 这条是"调了跟没调一样"事故的直接防线：宁可报失败，也不产出看不出差别的"成片"。
  const visibility = await frameDifference({ before: input, after: output, at, bins });
  const lookRequested = Boolean(profile || lutPath);
  if (lookRequested && visibility.verdict === "negligible") {
    await fsp.rm(output, { force: true });
    throw new ColorError(
      `调色未产生可见变化（平均像素差 ${visibility.meanAbsDiff}/255 < ${visibility.thresholds.subtle}）：`
      + "look 参数过弱或滤镜未生效，拒绝作为成片交付（可显式提高参数后重试）",
      "verify_failed",
    );
  }

  return {
    input,
    output,
    chain,
    profile,
    lut: lutPath,
    intensity,
    auto: autoUsed,
    durationSeconds: outProbe.duration,
    sizeBytes: outProbe.sizeBytes,
    before: beforeSummary,
    after: afterSummary,
    delta,
    visibility,
    sha256: await sha256File(output),
    verifyWarnings: [
      ...collectVerifyWarnings(afterSummary),
      ...(visibility.verdict === "subtle" ? [`调色幅度偏弱（平均像素差 ${visibility.meanAbsDiff}/255）：如需明显观感请提高 intensity 或换更强的 look`] : []),
    ],
  };
}

/**
 * 自动校正：由诊断指标反推「先校正后创作」那一步的参数（曝光/饱和/偏色）。
 * 纪律：幅度保守（一次只改一点），只做校正不做风格；风格交给 profile / LUT。
 */
export function autoCorrections(summary) {
  const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
  const round = (value) => Math.round(value * 1000) / 1000;
  const eq = {};
  const Y = summary.YAVG;
  if (Number.isFinite(Y)) {
    const mid = (TARGET.yAvg[0] + TARGET.yAvg[1]) / 2;
    if (Y < TARGET.yAvg[0]) {
      eq.gamma = clamp(1 + (TARGET.yAvg[0] - Y) / 200, 1, 1.35);
      eq.brightness = clamp(((mid - Y) / 255) * 0.6, 0, 0.12);
    } else if (Y > TARGET.yAvg[1]) {
      eq.gamma = clamp(1 - (Y - TARGET.yAvg[1]) / 300, 0.75, 1);
      eq.brightness = clamp(((mid - Y) / 255) * 0.6, -0.12, 0);
    }
  }
  const S = summary.SATAVG;
  if (Number.isFinite(S)) {
    if (S < TARGET.satAvg[0]) eq.saturation = clamp(1 + (TARGET.satAvg[0] - S) / 80, 1, 1.25);
    else if (S > TARGET.satAvg[1]) eq.saturation = clamp(1 - (S - TARGET.satAvg[1]) / 200, 0.8, 1);
  }
  const colorBalance = {};
  if (Number.isFinite(summary.UAVG) && Math.abs(summary.UAVG - 128) > 6) {
    const shift = clamp(-(summary.UAVG - 128) / 400, -0.06, 0.06);
    colorBalance.bm = round(shift);
    colorBalance.bh = round(shift);
  }
  if (Number.isFinite(summary.VAVG) && Math.abs(summary.VAVG - 128) > 6) {
    const shift = clamp(-(summary.VAVG - 128) / 400, -0.06, 0.06);
    colorBalance.rm = round(shift);
    colorBalance.rh = round(shift);
  }
  const corrections = {};
  if (Object.keys(eq).length) corrections.eq = Object.fromEntries(Object.entries(eq).map(([k, v]) => [k, round(v)]));
  if (Object.keys(colorBalance).length) corrections.colorBalance = colorBalance;
  return corrections;
}

export function collectVerifyWarnings(summary) {
  const warnings = [];
  if (Number.isFinite(summary.YAVG) && (summary.YAVG < TARGET.yAvg[0] || summary.YAVG > TARGET.yAvg[1])) {
    warnings.push(`YAVG=${summary.YAVG.toFixed(1)} 越出目标区间 ${TARGET.yAvg.join("–")}`);
  }
  if (Number.isFinite(summary.SATAVG) && summary.SATAVG > TARGET.satAvg[1] + 10) {
    warnings.push(`SATAVG=${summary.SATAVG.toFixed(1)} 明显高于目标上限 ${TARGET.satAvg[1]}`);
  }
  return warnings;
}

function deriveMatchCorrections(reference, target) {
  const eq = {};
  if (Number.isFinite(reference.YAVG) && Number.isFinite(target.YAVG)) {
    eq.brightness = Math.max(-0.12, Math.min(0.12, (reference.YAVG - target.YAVG) / 255));
  }
  if (Number.isFinite(reference.SATAVG) && Number.isFinite(target.SATAVG) && target.SATAVG > 1) {
    eq.saturation = Math.max(0.7, Math.min(1.4, reference.SATAVG / target.SATAVG));
  }
  const colorBalance = {};
  if (Number.isFinite(reference.UAVG) && Number.isFinite(target.UAVG)) {
    const shift = Math.max(-0.08, Math.min(0.08, (reference.UAVG - target.UAVG) / 100));
    if (shift) { colorBalance.bm = shift; colorBalance.bh = shift; }
  }
  if (Number.isFinite(reference.VAVG) && Number.isFinite(target.VAVG)) {
    const shift = Math.max(-0.08, Math.min(0.08, (reference.VAVG - target.VAVG) / 100));
    if (shift) { colorBalance.rm = shift; colorBalance.rh = shift; }
  }
  const corrections = {};
  if (Object.keys(eq).length) corrections.eq = eq;
  if (Object.keys(colorBalance).length) corrections.colorBalance = colorBalance;
  return corrections;
}

/**
 * 多镜匹配：以参考镜为准，为每个目标镜派生校正并复检残差。
 */
export async function match({ reference, targets, outDir, profile = null, intensity = 1, bins = resolveBinaries(), at = null }) {
  if (!Array.isArray(targets) || targets.length === 0) throw new ColorError("targets 为空", "bad_request");
  if (!fs.existsSync(reference)) throw new ColorError(`参考镜不存在：${reference}`, "not_found");
  await fsp.mkdir(outDir, { recursive: true });

  const refProbe = await probeMedia(reference, { bins });
  const refTimes = Array.isArray(at) && at.length ? at : defaultTimestamps(refProbe.duration).slice(0, 2);
  const refFrames = [];
  for (const t of refTimes) refFrames.push(await frameStats({ input: reference, at: t, bins }));
  const referenceSummary = summarize(refFrames);

  const results = [];
  for (const target of targets) {
    if (!fs.existsSync(target)) {
      results.push({ target, ok: false, error: "not_found" });
      continue;
    }
    const targetProbe = await probeMedia(target, { bins });
    const targetTimes = Array.isArray(at) && at.length ? at : defaultTimestamps(targetProbe.duration).slice(0, 2);
    const targetFrames = [];
    for (const t of targetTimes) targetFrames.push(await frameStats({ input: target, at: t, bins }));
    const targetSummary = summarize(targetFrames);

    const corrections = deriveMatchCorrections(referenceSummary, targetSummary);
    const outPath = path.join(outDir, `${path.basename(target, path.extname(target))}-matched${path.extname(target) || ".mp4"}`);
    const graded = await grade({ input: target, output: outPath, profile, corrections, intensity, verifyAt: targetTimes, bins });
    results.push({
      target,
      ok: true,
      output: graded.output,
      corrections,
      reference: referenceSummary,
      before: graded.before,
      after: graded.after,
      residual: {
        YAVG: Number.isFinite(graded.after.YAVG) ? Math.round((graded.after.YAVG - referenceSummary.YAVG) * 100) / 100 : null,
        UAVG: Number.isFinite(graded.after.UAVG) ? Math.round((graded.after.UAVG - referenceSummary.UAVG) * 100) / 100 : null,
        VAVG: Number.isFinite(graded.after.VAVG) ? Math.round((graded.after.VAVG - referenceSummary.VAVG) * 100) / 100 : null,
      },
      sha256: graded.sha256,
    });
  }

  return { reference, referenceSummary, results };
}

/* ============================ scope / 对比帧 ============================ */

export const SCOPE_KINDS = ["waveform", "vectorscope", "histogram"];

const SCOPE_FILTERS = {
  waveform: "waveform=filter=lowpass:scale=ire:graticule=green:flags=numbers+dots,format=rgb24",
  vectorscope: "vectorscope=mode=color:graticule=green:flags=white,format=rgb24",
  histogram: "histogram=display_mode=stack,format=rgb24",
};

export async function renderScopes({ input, at = 0, kinds = SCOPE_KINDS, outDir, bins = resolveBinaries() }) {
  await fsp.mkdir(outDir, { recursive: true });
  const outputs = [];
  for (const kind of kinds) {
    const filter = SCOPE_FILTERS[kind];
    if (!filter) throw new ColorError(`未知 scope 类型：${kind}`, "bad_request");
    // 文件名不用 "@"：事件账本会对形似邮箱的字符串做 PII 脱敏，会把证据路径打码。
    const out = path.join(outDir, `${path.basename(input, path.extname(input))}-${kind}-t${at}s.png`);
    await runBin(bins.ffmpeg, [
      "-hide_banner", "-v", "error", "-y",
      "-ss", String(at), "-i", input,
      "-frames:v", "1", "-vf", filter,
      "-update", "1", out,
    ], { label: `ffmpeg(scope:${kind})`, timeoutMs: 120_000 });
    outputs.push({ kind, path: out, sha256: await sha256File(out) });
  }
  return outputs;
}

export async function compareFrames({ before, after, at = 0, output, bins = resolveBinaries() }) {
  await fsp.mkdir(path.dirname(output), { recursive: true });
  await runBin(bins.ffmpeg, [
    "-hide_banner", "-v", "error", "-y",
    "-ss", String(at), "-i", before,
    "-ss", String(at), "-i", after,
    "-filter_complex",
    "[0:v]setpts=PTS-STARTPTS,scale=854:-2[l];[1:v]setpts=PTS-STARTPTS,scale=854:-2[r];[l][r]hstack=inputs=2[v]",
    "-map", "[v]", "-frames:v", "1", output,
  ], { label: "ffmpeg(compare)", timeoutMs: 120_000 });
  return { path: output, sha256: await sha256File(output) };
}

/* ============================ 可见性度量 ============================ */

/* ---------- 画质度量与择优（"最佳效果"要用可计算的分数说话） ---------- */

/**
 * 单帧画质指标（单次遍历，纯 JS）：
 *   rmsContrast 对比度（亮度标准差）｜ tonalRange 影调跨度（P95-P5）｜ satMean 平均饱和
 *   oversatPct 过饱和像素占比 ｜ colorfulness 色彩浓度（Hasler-Süsstrunk）
 *   sharpness 细节能量（拉普拉斯方差）｜ shadow/highlightClipPct 裁切占比（信息损失）
 */
export function frameQuality(buf, width = 0, height = 0) {
  const n = Math.floor(buf.length / 3);
  if (n === 0) throw new ColorError("空帧无法评估画质", "bad_media");
  const gray = new Float64Array(n);
  let sY = 0; let sY2 = 0; let sSat = 0; let over = 0; let dark = 0; let bright = 0;
  let sRg = 0; let sRg2 = 0; let sYb = 0; let sYb2 = 0;
  for (let i = 0, p = 0; p < n; i += 3, p += 1) {
    const r = buf[i]; const g = buf[i + 1]; const b = buf[i + 2];
    const y = 0.2126 * r + 0.7152 * g + 0.0722 * b;
    gray[p] = y; sY += y; sY2 += y * y;
    const mx = r > g ? (r > b ? r : b) : (g > b ? g : b);
    const mn = r < g ? (r < b ? r : b) : (g < b ? g : b);
    const sat = mx === 0 ? 0 : (mx - mn) / mx;
    sSat += sat;
    if (sat > 0.92 && mx > 60) over += 1;
    if (y <= 4) dark += 1;
    if (y >= 251) bright += 1;
    const rg = r - g; const yb = 0.5 * (r + g) - b;
    sRg += rg; sRg2 += rg * rg; sYb += yb; sYb2 += yb * yb;
  }
  const meanY = sY / n;
  const rmsContrast = Math.sqrt(Math.max(sY2 / n - meanY * meanY, 0));
  const sorted = Float64Array.from(gray).sort();
  const tonalRange = sorted[Math.floor(n * 0.95)] - sorted[Math.floor(n * 0.05)];
  const stat = (s, s2) => { const m = s / n; return [m, Math.sqrt(Math.max(s2 / n - m * m, 0))]; };
  const [muRg, sdRg] = stat(sRg, sRg2);
  const [muYb, sdYb] = stat(sYb, sYb2);
  const colorfulness = Math.sqrt(sdRg ** 2 + sdYb ** 2) + 0.3 * Math.sqrt(muRg ** 2 + muYb ** 2);

  // 细节能量：3×3 拉普拉斯响应方差（越锐利越高）
  let sharpSum = 0; let sharpSum2 = 0; let count = 0;
  if (width > 2 && height > 2 && width * height === n) {
    for (let y = 1; y < height - 1; y += 1) {
      for (let x = 1; x < width - 1; x += 1) {
        const idx = y * width + x;
        const lap = gray[idx - width] + gray[idx + width] + gray[idx - 1] + gray[idx + 1] - 4 * gray[idx];
        sharpSum += lap; sharpSum2 += lap * lap; count += 1;
      }
    }
  }
  const sharpness = count > 0
    ? Math.sqrt(Math.max(sharpSum2 / count - (sharpSum / count) ** 2, 0))
    : 0;

  return {
    yavg: Math.round(meanY * 100) / 100,
    rmsContrast: Math.round(rmsContrast * 100) / 100,
    tonalRange: Math.round(tonalRange * 100) / 100,
    satMean: Math.round((sSat / n) * 1000) / 1000,
    oversatPct: Math.round((over / n) * 10000) / 100,
    colorfulness: Math.round(colorfulness * 100) / 100,
    sharpness: Math.round(sharpness * 100) / 100,
    shadowClipPct: Math.round((dark / n) * 10000) / 100,
    highlightClipPct: Math.round((bright / n) * 10000) / 100,
  };
}

/**
 * 画质打分（基准 100 = 原片）。**不是"更艳就更高"**，而是"不许变差、允许小幅变好"：
 * - 对比度/清晰度下降：重罚（用户投诉的正是"变灰、变糊"）
 * - 过饱和/掉饱和：双向罚（饱和度不是越高越好）
 * - 裁切增加：重罚（信息丢了就找不回来）
 * - 亮度漂移 + "原片本来就在健康区间却被拉出去"：罚
 * - 对比/细节小幅提升：有限奖励（上限 +13）
 */
/** 画质健康区间（显示参考素材的校准经验值，可按素材类型覆盖）。 */
export const QUALITY_BANDS = {
  rmsContrast: [22, 45],   // 对比度：低于下限发灰，高于上限发硬
  satMean: [0.22, 0.48],   // 平均饱和：低于下限发灰，高于上限发艳
};

const bandDistance = (value, [lo, hi]) => (value < lo ? lo - value : value > hi ? value - hi : 0);
/** 朝健康区间移动 → 有限奖励；偏离 → 按权重扣分（同样封顶，避免异常素材把分数拉到无意义区间）。 */
const bandEffect = (diff, weight, maxReward, maxPenalty) => (diff <= 0
  ? Math.min(maxReward, -diff * weight)
  : -Math.min(maxPenalty, diff * weight));

export function scoreQuality(cand, src, bands = QUALITY_BANDS) {
  const safe = (a, b) => (b > 0.01 ? a / b : 1);
  const contrastRatio = safe(cand.rmsContrast, src.rmsContrast);
  const detailRatio = safe(cand.sharpness, src.sharpness);
  const satRatio = safe(cand.satMean, src.satMean);
  const clipDelta = (cand.shadowClipPct + cand.highlightClipPct) - (src.shadowClipPct + src.highlightClipPct);
  const overDelta = cand.oversatPct - src.oversatPct;

  const srcHealthyExposure = src.yavg >= 80 && src.yavg <= 140;
  const srcComfortableExposure = src.yavg >= 90 && src.yavg <= 125;
  const lumaDrift = cand.yavg - src.yavg;
  const brokeExposure = srcHealthyExposure
    && (cand.yavg < 72 || cand.yavg > 150 || (srcComfortableExposure && Math.abs(lumaDrift) > 25));

  let score = 100;
  // 对比度/饱和：朝健康区间移动加分（封顶），偏离按权重扣分。
  // 关键区别：**不再把"饱和相对原片升高"一律当劣化**——对本来就偏灰的素材，拉回健康区间是改善。
  score += bandEffect(
    bandDistance(cand.rmsContrast, bands.rmsContrast) - bandDistance(src.rmsContrast, bands.rmsContrast),
    45, 8, 15,
  );
  score += bandEffect(
    bandDistance(cand.satMean, bands.satMean) - bandDistance(src.satMean, bands.satMean),
    60, 6, 12,
  );
  score -= 25 * Math.max(0, 1 - detailRatio);          // 清晰度只能不掉
  score -= 12 * Math.max(0, satRatio - 1.35);          // 极端过饱和再加罚
  score -= 2.5 * Math.max(0, clipDelta);               // 裁切增加：信息损失
  score -= 0.6 * Math.max(0, overDelta);
  score -= 0.15 * Math.abs(lumaDrift);                 // 亮度漂移
  if (brokeExposure) score -= 10;                      // 原片曝光健康却被拉出区间
  score += Math.min(5, 12 * Math.max(0, detailRatio - 1));

  return {
    score: Math.round(score * 100) / 100,
    reasons: {
      contrastRatio: Math.round(contrastRatio * 1000) / 1000,
      detailRatio: Math.round(detailRatio * 1000) / 1000,
      satRatio: Math.round(satRatio * 1000) / 1000,
      clipDeltaPct: Math.round(clipDelta * 100) / 100,
      oversatDeltaPct: Math.round(overDelta * 100) / 100,
      lumaDrift: Math.round((cand.yavg - src.yavg) * 100) / 100,
      brokeHealthyExposure: brokeExposure,
    },
  };
}

/** 抽样帧的画质（多帧取均值；帧太大时按宽度缩放，跨素材可比）。 */
export async function qualityOfFile({ input, at = [0], width = 480, bins = resolveBinaries() }) {
  const samples = [];
  for (const t of at) {
    const buf = await rawFrame(input, t, bins, width);
    const height = Math.round((buf.length / 3) / width);
    samples.push(frameQuality(buf, width, height));
  }
  const keys = Object.keys(samples[0]);
  const avg = {};
  for (const k of keys) avg[k] = Math.round((samples.reduce((s, x) => s + x[k], 0) / samples.length) * 100) / 100;
  return { samples, avg };
}

/** 作用在单张静态帧上的滤镜链评估（look dev：先在静帧上比效果，再整片渲染一次）。 */
async function qualityWithChain({ framePath, chain, width, bins }) {
  const { stdout } = await runBin(bins.ffmpeg, [
    "-hide_banner", "-v", "error", "-y",
    "-i", framePath,
    "-vf", `${chain},scale=${width}:-2,format=rgb24`,
    "-frames:v", "1",
    "-f", "rawvideo", "-pix_fmt", "rgb24", "-",
  ], { label: "ffmpeg(chain-eval)", timeoutMs: 60_000 });
  const height = Math.round((stdout.length / 3) / width);
  return frameQuality(stdout, width, height);
}


async function rawFrame(input, at, bins, width = 640) {
  // 统一缩到固定宽度再比较：与分辨率/编码无关，只回答"画面变了吗、变得好不好"。
  const { stdout } = await runBin(bins.ffmpeg, [
    "-hide_banner", "-v", "error",
    "-ss", String(at), "-i", input,
    "-frames:v", "1",
    "-vf", `scale=${width}:-2,format=rgb24`,
    "-f", "rawvideo", "-pix_fmt", "rgb24", "-",
  ], { label: "ffmpeg(rgb-frame)", timeoutMs: 60_000 });
  return stdout;
}

/**
 * 默认候选池：原片不动 / 仅自动校正 / 各内置 look × [0.5, 0.8] 强度。
 * 数量刻意收敛（~18 个），只在抽样静帧上评估——先比效果，再整片渲染一次。
 */
export function defaultCandidates({ profiles = null, intensities = [0.5, 0.8] } = {}) {
  const list = [];
  for (const name of profiles ?? Object.keys(PROFILES)) {
    for (const intensity of intensities) {
      list.push({ id: `${name}@${intensity}`, label: `${name} 强度 ${intensity}`, spec: { profile: name, intensity } });
    }
  }
  return list;
}

function averageMetrics(samples) {
  const keys = Object.keys(samples[0]);
  const avg = {};
  for (const k of keys) avg[k] = Math.round((samples.reduce((s, x) => s + x[k], 0) / samples.length) * 100) / 100;
  return avg;
}

/**
 * 择优调色（"最佳效果"的实现路径）：候选择优 + 客观打分 + 允许「不动」。
 *
 *   1. 抽 N 张静帧（look dev，不整片渲染）；
 *   2. 候选池（原片不动 / 仅校正 / look×强度）在静帧上逐一评估；
 *   3. scoreQuality 打分（基准 100 = 原片）；
 *   4. **最高分没过阈值 → 判定"无需调色"，不产出任何文件**（do no harm）；
 *   5. 确有更优候选时，才整片渲染一次，并对成片复测画质。
 */
export async function best({
  input, output = null, sampleAt = null, candidates = null,
  minImprovement = 2, width = 480, bins = resolveBinaries(), maxSamples = 4,
}) {
  const probe = await probeMedia(input, { bins });
  const at = Array.isArray(sampleAt) && sampleAt.length
    ? sampleAt
    : defaultTimestamps(probe.duration).slice(0, maxSamples);

  const frameDir = await fsp.mkdtemp(path.join(os.tmpdir(), "color-best-"));
  try {
    const frames = [];
    for (let i = 0; i < at.length; i += 1) {
      const still = path.join(frameDir, `f${i}.png`);
      await runBin(bins.ffmpeg, [
        "-hide_banner", "-v", "error", "-y", "-ss", String(at[i]), "-i", input, "-frames:v", "1", still,
      ], { label: "ffmpeg(still)", timeoutMs: 60_000 });
      frames.push(still);
    }

    // 「仅校正」候选：由量化诊断推导（只在确有欠曝/偏色/低饱和时才有非空参数）
    const statsFrames = [];
    for (const t of at) statsFrames.push(await frameStats({ input, at: t, bins }));
    const autoApplied = autoCorrections(summarize(statsFrames));

    const pool = [
      { id: "identity", label: "原片不动（不调色）", spec: null },
      ...(Object.keys(autoApplied).length
        ? [{ id: "auto-correct", label: "仅自动校正（白平衡/曝光/裁切）", spec: { corrections: autoApplied, intensity: 1 } }]
        : []),
      ...(Array.isArray(candidates) && candidates.length ? candidates : defaultCandidates()),
    ];

    const evaluated = [];
    for (const candidate of pool) {
      const chain = candidate.spec ? buildChain(candidate.spec) : "null";
      // 同一候选的抽样帧并行评估（4 帧并发），候选之间串行——总耗时从分钟级降到十几秒。
      const perFrame = await Promise.all(
        frames.map((still) => qualityWithChain({ framePath: still, chain, width, bins })),
      );
      evaluated.push({ id: candidate.id, label: candidate.label, spec: candidate.spec, chain, quality: averageMetrics(perFrame) });
    }

    const baseline = evaluated[0];
    for (const item of evaluated) {
      item.scoring = item.id === "identity"
        ? { score: 100, reasons: { contrastRatio: 1, detailRatio: 1, satRatio: 1, clipDeltaPct: 0, oversatDeltaPct: 0, lumaDrift: 0, brokeHealthyExposure: false } }
        : scoreQuality(item.quality, baseline.quality);
    }
    const winner = evaluated.reduce((a, b) => (b.scoring.score > a.scoring.score ? b : a));
    const improvement = Math.round((winner.scoring.score - 100) * 100) / 100;
    const table = evaluated.map((e) => ({ id: e.id, label: e.label, score: e.scoring.score, reasons: e.scoring.reasons, quality: e.quality }));

    if (winner.id === "identity" || improvement < minImprovement) {
      return {
        verdict: "no_change_needed",
        winner: winner.id,
        improvement,
        minImprovement,
        reason: `最佳候选「${winner.label}」仅比原片高 ${improvement} 分（阈值 ${minImprovement}）：按「不劣化优先」纪律判定无需调色，未产出新文件`,
        source: baseline.quality,
        sampledAt: at,
        candidates: table,
        sha256: await sha256File(input),
      };
    }

    if (!output) throw new ColorError("已有更优候选，但未提供 output_path（择优调色需要输出路径）", "bad_request");
    const graded = await grade({
      input,
      output,
      profile: winner.spec?.profile ?? null,
      lutPath: winner.spec?.lutPath ?? null,
      corrections: winner.spec?.corrections ?? {},
      intensity: winner.spec?.intensity ?? 1,
      verifyAt: at,
      bins,
    });
    const outQuality = (await qualityOfFile({ input: output, at, width, bins })).avg;
    return {
      verdict: "graded",
      winner: winner.id,
      winnerLabel: winner.label,
      improvement,
      minImprovement,
      source: baseline.quality,
      after: outQuality,
      finalScore: scoreQuality(outQuality, baseline.quality),
      chain: graded.chain,
      visibility: graded.visibility,
      delta: graded.delta,
      sha256: graded.sha256,
      sampledAt: at,
      candidates: table,
      output: graded.output,
    };
  } finally {
    await fsp.rm(frameDir, { recursive: true, force: true }).catch(() => {});
  }
}

/**
 * 逐帧像素差（可见性度量）。回答"这次调色到底改了多少画面"：
 *   verdict: visible（平均差 ≥4/255，肉眼可辨）/ subtle（2–4）/ negligible（<2，等于没调）
 */
export async function frameDifference({ before, after, at = [0], bins = resolveBinaries() }) {
  const frames = [];
  for (const t of at) {
    const a = await rawFrame(before, t, bins);
    const b = await rawFrame(after, t, bins);
    const n = Math.min(a.length, b.length);
    if (!n) continue;
    let sum = 0;
    let max = 0;
    let over = 0;
    for (let i = 0; i < n; i += 1) {
      const d = Math.abs(a[i] - b[i]);
      sum += d;
      if (d > max) max = d;
      if (d > 5) over += 1;
    }
    frames.push({
      at: t,
      meanAbsDiff: Math.round((sum / n) * 100) / 100,
      maxDiff: max,
      pctOver5: Math.round((over / n) * 10000) / 100,
    });
  }
  const mean = frames.length ? frames.reduce((acc, f) => acc + f.meanAbsDiff, 0) / frames.length : 0;
  const meanAbsDiff = Math.round(mean * 100) / 100;
  return {
    frames,
    meanAbsDiff,
    verdict: meanAbsDiff >= 4 ? "visible" : meanAbsDiff >= 2 ? "subtle" : "negligible",
    thresholds: { visible: 4, subtle: 2 },
  };
}

/* ============================ 作业留痕 ============================ */

export async function jobAppend(dir, record) {
  await fsp.mkdir(dir, { recursive: true });
  const file = path.join(dir, "jobs.jsonl");
  await fsp.appendFile(file, `${JSON.stringify({ at: new Date().toISOString(), ...record })}\n`, "utf8");
  return file;
}

export function jobsDir(env = process.env) {
  return env.WORKLOOM_COLOR_JOBS_DIR || path.join(os.homedir(), ".workloom-color", "jobs");
}

/* ============================ 工具分发 ============================ */

export async function callTool(name, params = {}, { bins = resolveBinaries(), env = process.env } = {}) {
  if (!isColorTool(name)) {
    throw new ColorError(`调色工位不提供工具 ${name}`, "not_provided");
  }
  const roots = allowedRoots(env);
  const text = (value, label) => {
    if (typeof value !== "string" || !value.trim()) throw new ColorError(`${label} 缺失`, "bad_request");
    return value;
  };

  switch (name) {
    case "colorread.health": {
      let ffmpegVersion = null;
      try {
        const { stdout } = await runBin(bins.ffmpeg, ["-hide_banner", "-version"], { label: "ffmpeg", timeoutMs: 20_000 });
        ffmpegVersion = stdout.toString("utf8").split("\n")[0] ?? null;
      } catch (error) {
        if (error instanceof ColorError && error.code === "ffmpeg_not_installed") {
          return { result: { ok: false, ffmpeg: null, allowedRoots: roots }, receipt: { synced: false } };
        }
        throw error;
      }
      return { result: { ok: true, ffmpeg: ffmpegVersion, profiles: Object.keys(PROFILES), scopes: SCOPE_KINDS, allowedRoots: roots }, receipt: { synced: true } };
    }

    case "colorread.probe": {
      const input = assertPathAllowed(text(params.input_path, "input_path"), roots, "input_path");
      if (!fs.existsSync(input)) throw new ColorError(`文件不存在：${input}`, "not_found");
      const probe = await probeMedia(input, { bins });
      return { result: { path: input, ...probe }, receipt: { synced: true, sha256: await sha256File(input) } };
    }

    case "colorread.analyze": {
      const input = assertPathAllowed(text(params.input_path, "input_path"), roots, "input_path");
      const report = await analyze({
        input,
        at: Array.isArray(params.at_seconds) ? params.at_seconds.map(Number) : null,
        neutralPatch: params.neutral_patch ?? null,
        skinPatch: params.skin_patch ?? null,
        bins,
      });
      return { result: report, receipt: { synced: true, sha256: await sha256File(input) } };
    }

    case "colorread.recipes": {
      // 配方库随 Bundle 分发，不涉及租户素材，故不受路径监狱约束（只读仓内资产）。
      const result = findRecipes({
        recipeId: params.recipe_id ?? null,
        genre: params.genre ?? null,
        platform: params.platform ?? null,
        keyword: params.keyword ?? null,
        list: params.list === true,
      });
      return {
        result,
        receipt: { synced: true, snapshot_uri: `color://recipes/${params.recipe_id ?? "list"}`, verified_at: new Date().toISOString() },
      };
    }

    case "colorread.scope": {
      const input = assertPathAllowed(text(params.input_path, "input_path"), roots, "input_path");
      const outDir = assertPathAllowed(text(params.out_dir, "out_dir"), roots, "out_dir");
      const outputs = await renderScopes({
        input,
        at: Number(params.at_seconds ?? 0),
        kinds: Array.isArray(params.kinds) && params.kinds.length ? params.kinds : SCOPE_KINDS,
        outDir,
        bins,
      });
      return { result: { input, outputs }, receipt: { synced: true, sha256: outputs[0]?.sha256 } };
    }

    case "colorwrite.grade": {
      const input = assertPathAllowed(text(params.input_path, "input_path"), roots, "input_path");
      const output = assertPathAllowed(text(params.output_path, "output_path"), roots, "output_path");
      if (params.overwrite_source === true) throw new ColorError("禁止覆盖原片", "overwrite_source_forbidden");
      const lut = params.lut_path ? assertPathAllowed(String(params.lut_path), roots, "lut_path") : null;
      const graded = await grade({
        input,
        output,
        profile: params.profile ?? null,
        lutPath: lut,
        corrections: params.corrections ?? {},
        intensity: params.intensity === undefined ? 0.8 : Number(params.intensity),
        auto: params.auto === true,
        bins,
      });
      return {
        result: graded,
        receipt: {
          synced: true,
          // 运行时 ToolReceipt 只持久化 synced/snapshot_uri/verified_at 三字段，
          // 因此把产物哈希带进 snapshot_uri，保证事件账本里可核验（sha256 字段仍留给直接调用方）。
          snapshot_uri: `color://grade/${path.basename(graded.output)}?sha256=${graded.sha256}`,
          sha256: graded.sha256,
          verified_at: new Date().toISOString(),
        },
      };
    }

    case "colorwrite.best": {
      // 择优调色：先比效果再渲染；判"无需调色"时不写任何文件（do no harm）。
      const input = assertPathAllowed(text(params.input_path, "input_path"), roots, "input_path");
      const output = params.output_path
        ? assertPathAllowed(String(params.output_path), roots, "output_path")
        : null;
      if (params.overwrite_source === true || (output && output === input)) {
        throw new ColorError("禁止覆盖原片", "overwrite_source_forbidden");
      }
      const outcome = await best({
        input,
        output,
        sampleAt: Array.isArray(params.sample_at) ? params.sample_at.map(Number) : null,
        minImprovement: params.min_improvement === undefined ? 2 : Number(params.min_improvement),
        bins,
      });
      return {
        result: outcome,
        receipt: {
          synced: true,
          snapshot_uri: outcome.verdict === "graded"
            ? `color://best/${path.basename(outcome.output)}?sha256=${outcome.sha256}`
            : `color://best/no-change?sha256=${outcome.sha256}`,
          sha256: outcome.sha256,
          verified_at: new Date().toISOString(),
        },
      };
    }

    case "colorwrite.match": {
      const reference = assertPathAllowed(text(params.reference_path, "reference_path"), roots, "reference_path");
      const targets = Array.isArray(params.targets) ? params.targets.map((t) => assertPathAllowed(String(t), roots, "targets")) : [];
      const outDir = assertPathAllowed(text(params.out_dir, "out_dir"), roots, "out_dir");
      const matched = await match({
        reference,
        targets,
        outDir,
        profile: params.profile ?? null,
        intensity: params.intensity === undefined ? 1 : Number(params.intensity),
        bins,
      });
      return { result: matched, receipt: { synced: true, sha256: matched.results.find((r) => r.sha256)?.sha256 ?? null } };
    }

    default:
      throw new ColorError(`未实现的工具：${name}`, "not_provided");
  }
}

export const STABLE_JSON = (value) => JSON.stringify(sortValue(value));

function sortValue(value) {
  if (Array.isArray(value)) return value.map(sortValue);
  if (value && typeof value === "object") {
    return Object.keys(value).sort().reduce((acc, key) => {
      acc[key] = sortValue(value[key]);
      return acc;
    }, {});
  }
  return value;
}

export function hashKey(text) {
  let hash = 0xcbf29ce484222325n;
  const prime = 0x100000001b3n;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= BigInt(text.charCodeAt(i));
    hash = (hash * prime) & 0xffffffffffffffffn;
  }
  return hash.toString(16).padStart(16, "0");
}
