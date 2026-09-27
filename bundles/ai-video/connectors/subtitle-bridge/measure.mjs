/**
 * ai-video × 字幕工位 · 媒体与画面测量内核（measure.mjs）
 *
 * 定位：只做「读」与「量」——探测素材、抽帧、量化画面可读性、量文字的实测占位。
 * 纪律：
 * - 只用 node 内置模块 + 工位本地 ffmpeg/ffprobe，不依赖仓库外代码；
 * - 失败一律抛带稳定 code 的 MeasureError，不静默兜底、不伪造测量值；
 * - 量不出来的东西（缺流、无滤镜）如实报 null 并说明原因。
 */

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";

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
  "bad_font",
  "font_not_found",
  "bad_style",
  "bad_srt",
  "verify_failed",
  "not_configured",
]);

export class MeasureError extends Error {
  constructor(message, code = "engine_failed", retryable = RETRYABLE_CODES.has(code)) {
    super(message);
    this.name = "MeasureError";
    this.code = code;
    this.retryable = retryable;
  }
}

/** 引擎路径：环境变量优先（工位 kit 安装到 ~/.workloom-subtitle/bin 后由脚本注入）。 */
export function resolveBinaries(env = process.env) {
  return {
    ffmpeg: env.WORKLOOM_SUBTITLE_FFMPEG_PATH || "ffmpeg",
    ffprobe: env.WORKLOOM_SUBTITLE_FFPROBE_PATH || "ffprobe",
  };
}

/** 跑一个子进程并收集输出；超时/非零退出都转成稳定错误码。 */
export function runBin(bin, args, { timeoutMs = 300_000, label = "ffmpeg" } = {}) {
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(bin, args, { stdio: ["ignore", "pipe", "pipe"] });
    } catch (error) {
      reject(new MeasureError(`${label} 无法启动：${error.message}`, "ffmpeg_not_installed", false));
      return;
    }
    const stdout = [];
    const stderr = [];
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill("SIGKILL");
      reject(new MeasureError(`${label} 超时（${timeoutMs}ms）`, "timeout", true));
    }, timeoutMs);
    child.stdout?.on("data", (chunk) => stdout.push(chunk));
    child.stderr?.on("data", (chunk) => stderr.push(chunk));
    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const missing = error.code === "ENOENT";
      reject(new MeasureError(
        missing ? `${label} 未安装或不在 PATH：${bin}` : `${label} 启动失败：${error.message}`,
        missing ? "ffmpeg_not_installed" : "engine_failed",
        !missing,
      ));
    });
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const out = Buffer.concat(stdout).toString("utf8");
      const err = Buffer.concat(stderr).toString("utf8");
      if (code === 0) resolve({ stdout: out, stderr: err });
      else {
        const tail = err.trim().split("\n").slice(-6).join(" | ").slice(0, 600);
        reject(new MeasureError(`${label} 退出码 ${code}：${tail}`, "ffmpeg_failed", true));
      }
    });
  });
}

export async function binaryVersion(bin, { timeoutMs = 20_000 } = {}) {
  try {
    const { stdout, stderr } = await runBin(bin, ["-version"], { timeoutMs, label: path.basename(bin) });
    return (stdout || stderr).split("\n")[0]?.trim() ?? "";
  } catch {
    return null;
  }
}

export async function sha256File(file) {
  const digest = createHash("sha256");
  const handle = await fsp.open(file, "r");
  try {
    const buffer = Buffer.allocUnsafe(1 << 20);
    for (;;) {
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
      if (bytesRead <= 0) break;
      digest.update(buffer.subarray(0, bytesRead));
    }
  } finally {
    await handle.close();
  }
  return digest.digest("hex");
}

export async function tempDir(prefix = "workloom-subtitle-") {
  return fsp.mkdtemp(path.join(os.tmpdir(), prefix));
}

export function round(value, digits = 2) {
  if (!Number.isFinite(value)) return value;
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

/** 帧率字符串（如 "30000/1001"）转小数。 */
export function parseFps(value) {
  if (typeof value !== "string" || !value.includes("/")) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  const [num, den] = value.split("/").map(Number);
  if (!Number.isFinite(num) || !Number.isFinite(den) || den === 0) return null;
  return num / den;
}

/** 素材规格：分辨率 / 时长 / 帧率 / 音轨 / 编码（决定字号基准与版式）。 */
export async function probeMedia(input, { bins = resolveBinaries() } = {}) {
  if (!fs.existsSync(input)) throw new MeasureError(`文件不存在：${input}`, "not_found", false);
  const { stdout } = await runBin(bins.ffprobe, [
    "-v", "error", "-print_format", "json",
    "-show_format", "-show_streams", input,
  ], { label: "ffprobe" });
  let doc;
  try {
    doc = JSON.parse(stdout);
  } catch (error) {
    throw new MeasureError(`ffprobe 输出无法解析：${error.message}`, "bad_media", false);
  }
  const streams = Array.isArray(doc.streams) ? doc.streams : [];
  const video = streams.find((stream) => stream.codec_type === "video") ?? null;
  const audio = streams.find((stream) => stream.codec_type === "audio") ?? null;
  if (!video) throw new MeasureError("素材没有视频轨", "bad_media", false);
  const width = Number(video.width);
  const height = Number(video.height);
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
    throw new MeasureError("视频轨缺少可用的分辨率", "bad_media", false);
  }
  const durationRaw = Number(doc.format?.duration ?? video.duration);
  const fps = parseFps(video.avg_frame_rate) ?? parseFps(video.r_frame_rate);
  const framesRaw = Number(video.nb_frames);
  const videoDurationRaw = Number(video.duration);
  const videoDuration = Number.isFinite(videoDurationRaw) && videoDurationRaw > 0
    ? videoDurationRaw
    : (Number.isInteger(framesRaw) && framesRaw > 0 && fps > 0 ? framesRaw / fps : null);
  return {
    path: input,
    duration: Number.isFinite(durationRaw) ? round(durationRaw, 3) : null,
    videoDuration: videoDuration === null ? null : round(videoDuration, 6),
    width,
    height,
    shortSide: Math.min(width, height),
    orientation: height >= width ? "portrait" : "landscape",
    fps: fps === null ? null : round(fps, 3),
    videoCodec: video.codec_name ?? null,
    pixFmt: video.pix_fmt ?? null,
    hasAudio: Boolean(audio),
    audioCodec: audio?.codec_name ?? null,
    audioChannels: audio?.channels ?? null,
    audioSampleRate: audio?.sample_rate ? Number(audio.sample_rate) : null,
    container: doc.format?.format_name ?? null,
    bitRate: doc.format?.bit_rate ? Number(doc.format.bit_rate) : null,
  };
}

/** 编码器探测：优先 libx264（生产完整 ffmpeg），退化到 libopenh264 / mpeg4，并如实回报。 */
export async function pickVideoEncoder({ bins = resolveBinaries() } = {}) {
  const { stdout } = await runBin(bins.ffmpeg, ["-hide_banner", "-encoders"], { label: "ffmpeg" });
  const candidates = [
    { name: "libx264", args: ["-c:v", "libx264", "-preset", "fast", "-crf", "20"] },
    { name: "libopenh264", args: ["-c:v", "libopenh264", "-b:v", "4M"] },
    { name: "mpeg4", args: ["-c:v", "mpeg4", "-q:v", "3"] },
  ];
  for (const candidate of candidates) {
    if (new RegExp(`\\s${candidate.name}\\s`).test(stdout)) return candidate;
  }
  throw new MeasureError("未找到可用的视频编码器（libx264/libopenh264/mpeg4）", "ffmpeg_not_installed", false);
}

/** 字幕渲染滤镜探测：ass / subtitles 是否可用（libass 是否编进 ffmpeg）。 */
export async function detectRenderCapabilities({ bins = resolveBinaries() } = {}) {
  const { stdout } = await runBin(bins.ffmpeg, ["-hide_banner", "-filters"], { label: "ffmpeg" });
  const has = (name) => new RegExp(`\\s${name}\\s`).test(stdout);
  return { ass: has("ass"), subtitles: has("subtitles"), drawtext: has("drawtext") };
}

/** 抽帧（PNG）：给"画面可读性诊断"与"交付证据帧"用。 */
export async function extractFrame({ input, at, output, bins = resolveBinaries(), scale = null }) {
  const args = ["-hide_banner", "-v", "error", "-y", "-ss", String(at), "-i", input, "-frames:v", "1"];
  if (scale) args.push("-vf", `scale=${scale}`);
  args.push(output);
  await runBin(bins.ffmpeg, args, { label: "ffmpeg" });
  if (!fs.existsSync(output)) throw new MeasureError(`抽帧失败：${output}`, "ffmpeg_failed", true);
  return output;
}

const STATS_RE = /lavfi\.signalstats\.([A-Z]+)=([0-9.]+)/g;

function parseSignalStats(text) {
  const out = {};
  for (const match of text.matchAll(STATS_RE)) out[match[1]] = Number(match[2]);
  return out;
}

/** 画面区域量化：亮度（YAVG/YMIN/YMAX）+ 细节密度（边缘图 YAVG），支持裁剪到安全区/文字带。 */
export async function regionStats({ input, bins = resolveBinaries(), region = null }) {
  const crop = region && region.w > 0 && region.h > 0
    ? `crop=${Math.round(region.w)}:${Math.round(region.h)}:${Math.round(region.x)}:${Math.round(region.y)}`
    : null;
  const lumaFilter = [crop, "signalstats", "metadata=print"].filter(Boolean).join(",");
  const edgeFilter = [crop, "edgedetect=low=0.05:high=0.15", "signalstats", "metadata=print"].filter(Boolean).join(",");
  const base = parseSignalStats((await runBin(bins.ffmpeg, [
    "-hide_banner", "-v", "info", "-i", input, "-vf", lumaFilter, "-frames:v", "1", "-f", "null", "-",
  ], { label: "ffmpeg" })).stderr);
  const edge = parseSignalStats((await runBin(bins.ffmpeg, [
    "-hide_banner", "-v", "info", "-i", input, "-vf", edgeFilter, "-frames:v", "1", "-f", "null", "-",
  ], { label: "ffmpeg" })).stderr);
  const toUnit = (value) => (Number.isFinite(value) ? round(value / 255, 4) : null);
  return {
    lumaAvg: Number.isFinite(base.YAVG) ? round(base.YAVG, 2) : null,
    lumaMin: Number.isFinite(base.YMIN) ? round(base.YMIN, 2) : null,
    lumaMax: Number.isFinite(base.YMAX) ? round(base.YMAX, 2) : null,
    lumaAvgUnit: toUnit(base.YAVG),
    lumaSpreadUnit: Number.isFinite(base.YMAX) && Number.isFinite(base.YMIN)
      ? round((base.YMAX - base.YMIN) / 255, 4)
      : null,
    edgeDensityUnit: toUnit(edge.YAVG),
    region: region ?? null,
  };
}

const BBOX_RE = /Parsed_bbox_\d+[^\n]*?crop=(\d+):(\d+):(\d+):(\d+)/g;
const FONTSELECT_RE = /fontselect: \(([^,]+),[^)]*\) -> ([^,]+), (-?\d+), ([^\n]+)/g;

/**
 * 从 ffmpeg 日志里解析 libass 的字体解析结果（确认没有静默回落系统字体）。
 *
 * libass 的两种解析形态（实测 ffmpeg 6.0 / libass 0.17）：
 * - 从 `fontsdir` 加载成功：`-> LXGWWenKai-Regular, 0, LXGWWenKai-Regular`（只报字体名，无路径）；
 * - 回落到系统字体：`-> /System/Library/Fonts/Helvetica.ttc, -1, Helvetica`（带绝对路径）。
 * 因此「无路径分隔符」= 来自工位字体目录；「有绝对路径」= 回落到系统字体（判失败）。
 */
export function parseFontSelections(log, fontsDir = null) {
  const selections = [];
  for (const match of String(log).matchAll(FONTSELECT_RE)) {
    const resolved = match[2].trim();
    const fromFontsDir = fontsDir
      ? !resolved.includes("/") || resolved.startsWith(fontsDir)
      : null;
    selections.push({
      family: match[1].trim(),
      path: resolved,
      index: Number(match[3]),
      resolvedName: match[4].trim(),
      fromFontsDir,
    });
  }
  const fallbackFamilies = selections.filter((entry) => entry.fromFontsDir === false).map((entry) => entry.family);
  return {
    selections,
    fallbackFamilies,
    allFromFontsDir: selections.length ? fallbackFamilies.length === 0 : null,
  };
}

/**
 * 文字实测占位 + 字体解析核验：
 * 把 ASS 渲染成黑底白字的一帧，用 ffmpeg 的 bbox 滤镜量出文字墨迹外接框；
 * 同时解析 libass 的 fontselect 日志——确认 ffmpeg **真的从工位字体目录取到了字**，
 * 而不是静默回落到系统字体（回落会让"选了霞鹜文楷、实际渲染苹方"这种假交付得逞）。
 */
export async function measureInkExtent({ assPath, fontsDir, resolution, bins = resolveBinaries(), minVal = 40 }) {
  const [width, height] = Array.isArray(resolution)
    ? resolution.map(Number)
    : [Number(resolution?.width), Number(resolution?.height)];
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
    throw new MeasureError(`分辨率非法：${JSON.stringify(resolution)}`, "bad_request", false);
  }
  const filter = `ass=${escapeFilterPath(assPath)}${fontsDir ? `:fontsdir=${escapeFilterPath(fontsDir)}` : ""}`;
  const { stderr } = await runBin(bins.ffmpeg, [
    "-hide_banner", "-v", "info",
    "-f", "lavfi", "-i", `color=c=black:s=${width}x${height}:d=1:r=1`,
    "-vf", `${filter},bbox=min_val=${minVal}`,
    "-frames:v", "1", "-f", "null", "-",
  ], { label: "ffmpeg" });
  let last = null;
  for (const match of stderr.matchAll(BBOX_RE)) {
    last = { w: Number(match[1]), h: Number(match[2]), x: Number(match[3]), y: Number(match[4]) };
  }
  const { selections, fallbackFamilies: fellBack, allFromFontsDir } = parseFontSelections(stderr, fontsDir);
  if (!last || last.w <= 0 || last.h <= 0) {
    return {
      detected: false,
      note: "bbox 未检出文字墨迹（该帧可能没有可见文字，或字体缺字）",
      width,
      height,
      fontSelections: selections,
      fontFallbackFamilies: fellBack,
      fontResolvedFromFontsDir: allFromFontsDir,
    };
  }
  return {
    detected: true,
    inkWidth: last.w,
    inkHeight: last.h,
    inkX: last.x,
    inkY: last.y,
    widthRatio: round(last.w / width, 4),
    heightRatio: round(last.h / height, 4),
    topRatio: round(last.y / height, 4),
    bottomRatio: round((last.y + last.h) / height, 4),
    fontSelections: selections,
    fontFallbackFamilies: fellBack,
    fontResolvedFromFontsDir: allFromFontsDir,
  };
}

/** ffmpeg 滤镜参数里的路径转义（单引号/冒号/反斜杠/逗号）。 */
export function escapeFilterPath(value) {
  return `'${String(value).replaceAll("\\", "\\\\").replaceAll("'", "\\'").replaceAll(":", "\\:").replaceAll(",", "\\,")}'`;
}
