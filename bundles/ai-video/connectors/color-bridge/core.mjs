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

/* ---------- 直方图残差（T-24）：补均值判据漏检的"分布不匹配" ---------- */

/** 直方图 bin 数（64：8-bit 每 4 级一桶，形状分辨率与统计噪声的折中）。 */
export const HIST_BINS = 64;

/** 三通道加权：亮度分布决定观感台阶，权重最高；色度平面 4:2:0 抽样少、信噪比低，各 0.2。 */
export const HIST_WEIGHTS = { Y: 0.6, U: 0.2, V: 0.2 };

/**
 * 直方图残差告警阈值（三通道加权对称卡方，取值 [0,1]）。
 * 合成素材标定（mpeg4 320×240 实测）：同片不同帧 ≈0；±10 级曝光差 ≈0.055；
 * 同均值异分布（灰平渐变 vs 双峰高对比）≈0.53。取 0.12：正常匹配档 2× 余量之下、
 * 分布不匹配档 4× 之上（注意匹配在校正后复检，正常素材校正后残差远低于 0.055）。
 */
export const HIST_RESIDUAL_THRESHOLD = 0.12;

/**
 * yuv420p 原始平面 → 三通道 64 bin 归一化直方图（纯函数，便于标定与单测）。
 * @param {Buffer} buf 一帧 yuv420p 原始数据（Y 平面 + U/V 各 1/4）
 * @param {number} width 帧宽（高度由长度反推）
 */
export function histogramFromYuv(buf, width) {
  if (!Number.isInteger(width) || width <= 0) throw new ColorError("直方图帧宽非法", "bad_request");
  if (buf.length % 3 !== 0) throw new ColorError("yuv420p 帧长度非法（应为 1.5×像素数）", "bad_media");
  const pixels = (buf.length / 3) * 2;
  const height = pixels / width;
  if (!Number.isInteger(height) || height <= 0 || height % 2 !== 0) {
    throw new ColorError("yuv420p 帧长度与宽度不符", "bad_media");
  }
  const yLen = width * height;
  const cLen = yLen / 4;
  const binsOf = (start, len) => {
    const hist = new Float64Array(HIST_BINS);
    for (let i = start; i < start + len; i += 1) hist[buf[i] >> 2] += 1;
    for (let b = 0; b < HIST_BINS; b += 1) hist[b] /= len;
    return Array.from(hist);
  };
  return { Y: binsOf(0, yLen), U: binsOf(yLen, cLen), V: binsOf(yLen + cLen, cLen) };
}

/**
 * 单帧三通道直方图：缩到固定宽度后读 yuv420p 原始平面——与 regionAverageRgb 同款
 * "缩图 + 读像素"口径，避免 RGB 中转引入色度转换误差（与 frameStats 的 YUV 原生纪律一致）。
 */
export async function yuvHistogram({ input, at = 0, width = 160, bins = resolveBinaries() }) {
  const { stdout } = await runBin(bins.ffmpeg, [
    "-hide_banner", "-v", "error",
    "-ss", String(at), "-i", input,
    "-frames:v", "1",
    "-vf", `scale=${width}:-2`,
    "-f", "rawvideo", "-pix_fmt", "yuv420p", "-",
  ], { label: "ffmpeg(yuv-hist)", timeoutMs: 60_000 });
  return histogramFromYuv(stdout, width);
}

/**
 * 对称卡方距离（取值 [0,1]，0 = 分布全同）。
 * 选卡方而非 EMD：EMD 对"分布整体平移"给近距离，恰恰会放过对比度差异这类镜间跳变主犯；
 * 卡方逐 bin 比较形状，O(bins)、确定、无需迭代，正是要抓的"均值相同但分布不同"。
 */
export function histChiSquare(p, q) {
  let sum = 0;
  for (let i = 0; i < p.length; i += 1) {
    const m = (p[i] ?? 0) + (q[i] ?? 0);
    if (m > 0) sum += (((p[i] ?? 0) - (q[i] ?? 0)) ** 2) / m;
  }
  return sum / 2;
}

/** 多帧直方图逐 bin 求均值（与 summarize 的"多帧代表整镜"口径一致）。 */
function averageHistograms(hists) {
  const out = {};
  for (const plane of ["Y", "U", "V"]) {
    const acc = new Float64Array(HIST_BINS);
    for (const h of hists) for (let b = 0; b < HIST_BINS; b += 1) acc[b] += h[plane][b];
    out[plane] = Array.from(acc, (v) => v / hists.length);
  }
  return out;
}

/** 三通道加权直方图残差：{ chi2: {Y,U,V}, weighted }。 */
export function histResidual(targetHist, referenceHist) {
  const chi2 = {
    Y: histChiSquare(targetHist.Y, referenceHist.Y),
    U: histChiSquare(targetHist.U, referenceHist.U),
    V: histChiSquare(targetHist.V, referenceHist.V),
  };
  const weighted = HIST_WEIGHTS.Y * chi2.Y + HIST_WEIGHTS.U * chi2.U + HIST_WEIGHTS.V * chi2.V;
  return { chi2, weighted };
}

/* ---------- 噪点代理（T-24）：T-03 未落地前的 signalstats 差分口径 ---------- */

/**
 * 噪点命中阈值：差分帧 YAVG ≥ 该值判"有可见颗粒噪点"。
 * 合成素材标定：平滑/低细节素材 ≈0.1–1；编码后的干净 testsrc2（高细节）≈3.7–3.9；
 * alls=20 颗粒噪 ≈6.4；alls=40 ≈10.4。取 5：高细节干净素材留 1.3× 下限余量，
 * 中强度噪点留 1.3× 上限余量（宁可漏降，不可误降出涂抹感）。
 */
export const NOISE_DIFF_YAVG_HIT = 5;

/**
 * 噪点代理指标：原帧与 gblur 帧做差分，gblur 抹平颗粒噪但保留大块结构，
 * 差分帧的 YAVG ≈ 噪点强度。返回 null 表示取样失败（调用方按未命中处理）。
 */
export async function estimateNoise({ input, at = 0, bins = resolveBinaries() }) {
  const tmp = path.join(os.tmpdir(), `color-noise-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.txt`);
  const filters = "split=2[__nz_a][__nz_b];[__nz_a]gblur=sigma=2[__nz_blur];"
    + `[__nz_blur][__nz_b]blend=all_mode=difference,signalstats,metadata=print:file=${tmp.replace(/:/g, "\\:")}`;
  try {
    await runBin(bins.ffmpeg, [
      "-hide_banner", "-v", "error",
      "-ss", String(at), "-i", input,
      "-frames:v", "1",
      "-filter_complex", filters,
      "-f", "null", "-",
    ], { label: "ffmpeg(noise-probe)", timeoutMs: 60_000 });
    const text = await fsp.readFile(tmp, "utf8").catch(() => "");
    const yavg = parseSignalStats(text).YAVG;
    return Number.isFinite(yavg) ? yavg : null;
  } finally {
    await fsp.rm(tmp, { force: true }).catch(() => {});
  }
}

/**
 * RGB 判读路径的统一输入色域口径（T-04 配套纪律）。
 *
 * 为什么必须固定：交付链是 Rec.709，T-04 起输出显式打 bt709 三标签。若判读时不固定输入解释，
 * ffmpeg 会按每个文件自己的标签做 YUV→RGB 转换（未打标的源按 SD/601 猜），于是"同一份像素、
 * 只差一个标签"也会被算成画面差异——本仓实测均值差 7.61/255，足以把"没调"误判成"调了"。
 * 所有产 RGB 的判读路径统一按 bt709 解释输入，与交付口径一致。
 */
const RGB_INPUT_COLOR_ARGS = ["-colorspace", "bt709", "-color_primaries", "bt709", "-color_trc", "bt709"];

/** 区域平均 RGB（把区域缩放到 1×1 取像素），用于白平衡/肤色取证。 */
export async function regionAverageRgb({ input, at = 0, patch, bins = resolveBinaries() }) {
  const filters = [patchToCrop(patch), "scale=1:1:flags=area", "format=rgb24"].filter(Boolean).join(",");
  const { stdout } = await runBin(bins.ffmpeg, [
    "-hide_banner", "-v", "error",
    "-ss", String(at),
    ...RGB_INPUT_COLOR_ARGS,
    "-i", input,
    "-frames:v", "1",
    "-vf", filters,
    "-f", "rawvideo", "-pix_fmt", "rgb24", "-",
  ], { label: "ffmpeg(rgb-probe)", timeoutMs: 60_000 });
  if (stdout.length < 3) throw new ColorError("区域取样失败", "decode_failed", true);
  const [r, g, b] = [stdout[0], stdout[1], stdout[2]];
  return { r, g, b, luma: Math.round(0.2126 * r + 0.7152 * g + 0.0722 * b) };
}

/* ---------- 肤色自动检测（T-01）：不再依赖调用方手传 skinPatch 坐标 ---------- */

/**
 * BT.601 8-bit 肤色带（ITU 肤色线在 YCbCr 平面上的经验区间，以 (128,128) 为中心）：
 * Cb 77–127 / Cr 133–173 是"人眼认作肤色"的色度范围，等价于标准 HSV 色相 20–40°
 * （TARGET.skinHue，口径见 standardHueFromUv）。
 * 另加亮度带与最小色度——避免把中性灰（U≈V≈128 的白墙）和死黑区域算成肤色。
 */
export const SKIN_BAND = { cb: [77, 127], cr: [133, 173], luma: [40, 240], minChroma: 12 };

/**
 * 标准 HSV 色相（0–360°）——肤色判据用的口径（由 U/V 按 BT.601 反推 RGB 差量）。
 *
 * 为什么不用 signalstats 的 HUEAVG：ffmpeg 的 HUEAVG 是**复合色度相位角**
 * `(180/π)·atan2(U−128, V−128)+180`（FFmpeg 源码 `libavfilter/vf_signalstats.c`），
 * 与"肤色落在 HSV 20–40°"所依据的标准色相不是同一把尺子。本仓实测对照（2026-09-27）：
 * 纯绿帧 HUEAVG=38°、纯红 161°、真实肤色帧（U=97,V=160）135°；换算成标准 HSV 色相后
 * 分别为 108° / 12.8°(高饱和橙红) / 12.8°——即**直接用 HUEAVG 判 20–40° 会把绿/青判成
 * "健康肤色"、把真肤色判成"异常"**（本次集成按失败案例 FC-COL-007 修复）。
 *
 * 实拍肤色在标准 HSV 下落在 21–34°（浅肤 22.9°、小麦 25.3°、深肤 28.0°），与既有判据一致。
 * 中性灰（无色度）返回 null——"没有色相"不等于"肤色健康"。
 */
export function standardHueFromUv(u, v) {
  if (!Number.isFinite(u) || !Number.isFinite(v)) return null;
  // BT.601 YCbCr → RGB 差量（色相与亮度无关，只需差量）
  const cb = u - 128;
  const cr = v - 128;
  const r = 1.402 * cr;
  const g = -0.344136 * cb - 0.714136 * cr;
  const b = 1.772 * cb;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const range = max - min;
  if (range <= 1e-6) return null;
  let hue;
  if (max === r) hue = 60 * (((g - b) / range) % 6);
  else if (max === g) hue = 60 * (((b - r) / range) + 2);
  else hue = 60 * (((r - g) / range) + 4);
  return Math.round(((hue + 360) % 360) * 10) / 10;
}

/** 分区网格 8×8：够定位"脸/手臂在哪一格"，又不至于把单格压到几十像素没有代表性。 */
export const SKIN_GRID = 8;

/** 自动检测接受阈值：候选区面积占比 ≥1.5% 才当"画面里真有肤色区"，否则判未命中。 */
export const SKIN_MIN_AREA_SHARE = 0.015;

/**
 * yuv420p 原始帧 → 网格级 (Y,U,V) 均值。
 * 色度平面是 1/2 分辨率，按"格子在色度平面上的投影"求均值，避免色度错位到邻格。
 */
export function skinGridStats(buf, width, grid = SKIN_GRID) {
  if (!Number.isInteger(width) || width <= 0) throw new ColorError("肤色分区帧宽非法", "bad_request");
  if (buf.length % 3 !== 0) throw new ColorError("yuv420p 帧长度非法（应为 1.5×像素数）", "bad_media");
  const pixels = (buf.length / 3) * 2;
  const height = pixels / width;
  if (!Number.isInteger(height) || height <= 0 || height % 2 !== 0) {
    throw new ColorError("yuv420p 帧长度与宽度不符", "bad_media");
  }
  const yLen = width * height;
  const cLen = yLen / 4;
  const cw = width / 2;
  const ch = height / 2;
  const cellW = Math.max(1, Math.floor(width / grid));
  const cellH = Math.max(1, Math.floor(height / grid));
  const cells = [];
  for (let gy = 0; gy < grid; gy += 1) {
    for (let gx = 0; gx < grid; gx += 1) {
      const x0 = gx * cellW;
      const y0 = gy * cellH;
      const x1 = gx === grid - 1 ? width : x0 + cellW;
      const y1 = gy === grid - 1 ? height : y0 + cellH;
      let ySum = 0;
      let yCount = 0;
      for (let y = y0; y < y1; y += 1) {
        for (let x = x0; x < x1; x += 1) { ySum += buf[y * width + x]; yCount += 1; }
      }
      const cx0 = Math.floor(x0 / 2);
      const cx1 = Math.min(cw, Math.ceil(x1 / 2));
      const cy0 = Math.floor(y0 / 2);
      const cy1 = Math.min(ch, Math.ceil(y1 / 2));
      let uSum = 0;
      let vSum = 0;
      let cCount = 0;
      for (let y = cy0; y < cy1; y += 1) {
        for (let x = cx0; x < cx1; x += 1) {
          uSum += buf[yLen + y * cw + x];
          vSum += buf[yLen + cLen + y * cw + x];
          cCount += 1;
        }
      }
      cells.push({
        gx, gy, x0, y0, x1, y1,
        pixels: yCount,
        y: yCount ? ySum / yCount : null,
        u: cCount ? uSum / cCount : null,
        v: cCount ? vSum / cCount : null,
      });
    }
  }
  return { width, height, cellW, cellH, grid, cells };
}

/** 单格是否落在肤色带内（含中性灰/死黑排除）。 */
export function isSkinCell(cell, band = SKIN_BAND) {
  if (!cell || !Number.isFinite(cell.y) || !Number.isFinite(cell.u) || !Number.isFinite(cell.v)) return false;
  if (cell.y < band.luma[0] || cell.y > band.luma[1]) return false;
  if (cell.u < band.cb[0] || cell.u > band.cb[1]) return false;
  if (cell.v < band.cr[0] || cell.v > band.cr[1]) return false;
  return Math.abs(cell.u - 128) + Math.abs(cell.v - 128) >= band.minChroma;
}

/**
 * 最大四连通肤色区（网格级连通域）——"取最大连通候选区作为自动 skinPatch"。
 * 返回网格矩形 + 面积占比；没有候选格时返回 null。
 */
export function largestSkinRegion(gridStats, band = SKIN_BAND) {
  const { grid, cells, width, height } = gridStats;
  const flags = cells.map((cell) => isSkinCell(cell, band));
  const seen = new Array(cells.length).fill(false);
  let best = null;
  for (let index = 0; index < cells.length; index += 1) {
    if (!flags[index] || seen[index]) continue;
    const queue = [index];
    seen[index] = true;
    const members = [];
    while (queue.length) {
      const current = queue.pop();
      members.push(current);
      const gx = current % grid;
      const gy = Math.floor(current / grid);
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const nx = gx + dx;
        const ny = gy + dy;
        if (nx < 0 || ny < 0 || nx >= grid || ny >= grid) continue;
        const next = ny * grid + nx;
        if (flags[next] && !seen[next]) { seen[next] = true; queue.push(next); }
      }
    }
    const areaPixels = members.reduce((sum, i) => sum + cells[i].pixels, 0);
    if (!best || areaPixels > best.areaPixels) best = { members, areaPixels };
  }
  if (!best) return null;
  const gxs = best.members.map((i) => cells[i].gx);
  const gys = best.members.map((i) => cells[i].gy);
  const gx0 = Math.min(...gxs);
  const gx1 = Math.max(...gxs);
  const gy0 = Math.min(...gys);
  const gy1 = Math.max(...gys);
  const box = {
    x0: gx0 * gridStats.cellW,
    y0: gy0 * gridStats.cellH,
    x1: gx1 === grid - 1 ? width : (gx1 + 1) * gridStats.cellW,
    y1: gy1 === grid - 1 ? height : (gy1 + 1) * gridStats.cellH,
  };
  return {
    cells: best.members.length,
    areaPixels: best.areaPixels,
    areaShare: Math.round((best.areaPixels / (width * height)) * 10000) / 10000,
    box,
  };
}

/**
 * 自动肤色区检测（T-01）：抽样帧缩到固定宽度 → 网格 (Y,U,V) → 肤色带筛格 → 最大连通区
 * → 换算回原始像素坐标的 patch。找不到候选时返回 null（调用方按"未命中"如实上报）。
 */
export async function detectSkinRegion({ input, at = 0, width = 120, grid = SKIN_GRID, probe = null, bins = resolveBinaries() }) {
  const { stdout } = await runBin(bins.ffmpeg, [
    "-hide_banner", "-v", "error",
    "-ss", String(at),
    "-i", input,
    "-frames:v", "1",
    "-vf", `scale=${width}:-2`,
    "-f", "rawvideo", "-pix_fmt", "yuv420p", "-",
  ], { label: "ffmpeg(skin-scan)", timeoutMs: 60_000 });
  let gridStats;
  try {
    gridStats = skinGridStats(stdout, width, grid);
  } catch {
    return null;
  }
  const region = largestSkinRegion(gridStats);
  if (!region || region.areaShare < SKIN_MIN_AREA_SHARE) {
    return { detected: false, areaShare: region?.areaShare ?? 0, grid };
  }
  const source = probe?.video ?? null;
  const scaleX = source?.width ? source.width / gridStats.width : 1;
  const scaleY = source?.height ? source.height / gridStats.height : 1;
  const patch = {
    x: Math.max(0, Math.round(region.box.x0 * scaleX)),
    y: Math.max(0, Math.round(region.box.y0 * scaleY)),
    w: Math.max(2, Math.round((region.box.x1 - region.box.x0) * scaleX)),
    h: Math.max(2, Math.round((region.box.y1 - region.box.y0) * scaleY)),
  };
  if (source?.width) patch.w = Math.min(patch.w, source.width - patch.x);
  if (source?.height) patch.h = Math.min(patch.h, source.height - patch.y);
  return {
    detected: true,
    patch,
    areaShare: region.areaShare,
    cells: region.cells,
    sampleWidth: gridStats.width,
    sampleHeight: gridStats.height,
    grid,
    measuredAt: round2(at),
    source: "auto-skin-band",
  };
}

/* ---------- 不可修复缺陷检测（T-03）：把"诚实上报"从散文变成可执行检测 ---------- */

/**
 * blurdetect 阈值（`lavfi.blur`，越高越糊）。合成素材实测标定（320×240 与 1920×1080 量级一致）：
 * 干净 testsrc2 ≈4.5；gblur sigma1.5 ≈7.8 / sigma3 ≈12.3 / sigma6 ≈18.5 / sigma8 ≈21–23。
 * 取 8 / 15 两档：8 以下清晰，8–15 轻微失焦（告警），15 以上明显失焦（不可修复档）。
 * 注意：浅景深/柔焦是创作意图，所以"不可修复"仍标 needsHumanReview，不自动删产物。
 */
export const BLUR_THRESHOLDS = { slight: 8, heavy: 15 };

/**
 * 噪点阈值（estimateNoise 的差分 YAVG）：干净平滑素材 <1、高细节干净素材 ≈3.7、
 * alls=20 颗粒 ≈6.4、alls=25 ≈11.9。5 判"有可见颗粒"（与 T-24 denoise 触发线一致），
 * 9 判"明显噪点"（不可修复档：高感噪点色块）。
 */
export const NOISE_THRESHOLDS = { slight: NOISE_DIFF_YAVG_HIT, heavy: 9 };

/**
 * 色带/压缩伪影阈值：8-bit 平滑渐变被压成台阶后，直方图出现"空洞"，且画面呈"平台 + 跳变"结构。
 * 只用直方图空洞会误伤双色图形/纯色块（它们同样"级数稀疏"），所以判据是三条同时成立：
 *   ① 直方图空洞比 ≥0.25（色调跨度 ≥24 级）；② 平均梯度 ≤3（排除细节/噪点）；
 *   ③ 行剖面出现 ≥3 个"平台电平"（连续 ≥4 px 同值）且平台间跳变方向基本一致（单调爬升 ≥80%）。
 * 合成素材实测（1 帧，缩到 160 宽）：干净渐变 holeRatio 0.000、平台 <3 → 不判；
 * 8 级阶梯渐变 0.493、平台 8 且单调 → 判；纯色 span=1、高细节/噪点梯度 >3 → 不判。
 */
export const BANDING_THRESHOLDS = {
  holeRatio: 0.25, minSpan: 24, maxGradient: 3,
  minPlateauShare: 0.6, minPlateauLevels: 3, minMonotoneShare: 0.8, minRun: 4,
};

/** 行剖面平台电平（连续同值且长度 ≥minRun 的段，取该段电平）——色带判据的结构证据。 */
export function plateauLevelsOf(row, minRun = 4) {
  const levels = [];
  let current = row[0];
  let run = 1;
  for (let x = 1; x < row.length; x += 1) {
    if (row[x] === current) { run += 1; continue; }
    if (run >= minRun) levels.push(current);
    current = row[x];
    run = 1;
  }
  if (run >= minRun) levels.push(current);
  return levels;
}

/** 高光/暗部裁切"不可修复"档：占比超过 5% 时信息已不可恢复（1% 是 analyze 的既有告警线）。 */
export const CLIP_UNFIXABLE_RATIO = 0.05;

/**
 * 单帧模糊度（blurdetect → lavfi.blur）。返回 null 表示测不到（滤镜缺失/解码失败），
 * 调用方按"未核实"处理，不得当成"通过"。
 */
export async function detectBlurLevel({ input, at = 0, bins = resolveBinaries() }) {
  const tmp = path.join(os.tmpdir(), `color-blur-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.txt`);
  try {
    await runBin(bins.ffmpeg, [
      "-hide_banner", "-v", "error",
      "-ss", String(at), "-i", input,
      "-frames:v", "1",
      "-vf", `blurdetect=block_pct=80,metadata=print:file=${tmp.replace(/:/g, "\\:")}`,
      "-f", "null", "-",
    ], { label: "ffmpeg(blur-probe)", timeoutMs: 60_000 });
    const text = await fsp.readFile(tmp, "utf8").catch(() => "");
    const values = [...text.matchAll(/lavfi\.blur=(-?[0-9.]+)/g)].map((m) => Number(m[1]));
    const valid = values.filter((v) => Number.isFinite(v));
    return valid.length ? valid.reduce((a, b) => a + b, 0) / valid.length : null;
  } catch {
    return null;
  } finally {
    await fsp.rm(tmp, { force: true }).catch(() => {});
  }
}

/**
 * 色带/压缩伪影检测（纯函数部分）：yuv420p 原始帧 → 音调直方图空洞 + 梯度。
 * 纯函数便于单测与阈值标定（不需要 ffmpeg）。
 */
export function bandingFromYuv(buf, width, thresholds = BANDING_THRESHOLDS) {
  if (!Number.isInteger(width) || width <= 0) throw new ColorError("色带检测帧宽非法", "bad_request");
  if (buf.length % 3 !== 0) throw new ColorError("yuv420p 帧长度非法（应为 1.5×像素数）", "bad_media");
  const pixels = (buf.length / 3) * 2;
  const height = pixels / width;
  if (!Number.isInteger(height) || height <= 0) throw new ColorError("yuv420p 帧长度与宽度不符", "bad_media");
  const hist = new Array(256).fill(0);
  let gradientSum = 0;
  let gradientCount = 0;
  let flatPairs = 0;
  for (let y = 0; y < height; y += 1) {
    const row = y * width;
    for (let x = 0; x < width; x += 1) hist[buf[row + x]] += 1;
    for (let x = 1; x < width; x += 1) {
      const delta = Math.abs(buf[row + x] - buf[row + x - 1]);
      gradientSum += delta;
      if (delta === 0) flatPairs += 1;
      gradientCount += 1;
    }
  }
  const occupiedBins = [];
  for (let value = 0; value < 256; value += 1) if (hist[value] > 0) occupiedBins.push(value);
  const span = occupiedBins.length ? occupiedBins[occupiedBins.length - 1] - occupiedBins[0] + 1 : 0;
  const occupied = occupiedBins.length;
  const holeRatio = span > 0 ? Math.round((1 - occupied / span) * 10000) / 10000 : 0;
  const meanGradient = gradientCount ? Math.round((gradientSum / gradientCount) * 100) / 100 : 0;
  const plateauShare = gradientCount ? Math.round((flatPairs / gradientCount) * 10000) / 10000 : 1;

  // 结构证据（最多抽 5 行）：平台电平数 + 平台间跳变的单调性
  let plateauLevels = 0;
  let monotoneTotal = 0;
  let monotoneSame = 0;
  const rowStep = Math.max(1, Math.floor(height / 5));
  for (let y = 0; y < height; y += rowStep) {
    const levels = plateauLevelsOf(buf.subarray(y * width, y * width + width), thresholds.minRun);
    plateauLevels = Math.max(plateauLevels, levels.length);
    let positive = 0;
    let negative = 0;
    for (let index = 1; index < levels.length; index += 1) {
      const delta = levels[index] - levels[index - 1];
      if (delta > 0) positive += 1;
      else if (delta < 0) negative += 1;
    }
    monotoneTotal += positive + negative;
    monotoneSame += Math.max(positive, negative);
  }
  const monotoneShare = monotoneTotal ? Math.round((monotoneSame / monotoneTotal) * 10000) / 10000 : 0;
  const banded = holeRatio >= thresholds.holeRatio && span >= thresholds.minSpan
    && meanGradient <= thresholds.maxGradient
    && plateauShare >= thresholds.minPlateauShare
    && plateauLevels >= thresholds.minPlateauLevels
    && monotoneShare >= thresholds.minMonotoneShare;
  return { holeRatio, span, occupied, meanGradient, plateauShare, plateauLevels, monotoneShare, banded };
}

/** 单帧色带检测（解码 → 缩宽 → 纯函数判读）。 */
export async function detectBanding({ input, at = 0, width = 160, bins = resolveBinaries() }) {
  const { stdout } = await runBin(bins.ffmpeg, [
    "-hide_banner", "-v", "error",
    "-ss", String(at), "-i", input,
    "-frames:v", "1",
    "-vf", `scale=${width}:-2`,
    "-f", "rawvideo", "-pix_fmt", "yuv420p", "-",
  ], { label: "ffmpeg(banding-probe)", timeoutMs: 60_000 });
  const height = (stdout.length / 3) * 2 / width;
  if (!Number.isFinite(height) || height <= 0) throw new ColorError("色带检测取样失败", "decode_failed", true);
  return bandingFromYuv(stdout, width);
}

/**
 * 不可修复缺陷汇总（T-03）：模糊 / 噪点 / 色带三类逐帧实测，取最坏值作为整镜结论。
 * 返回的 defects 每条都可执行复核（检测器名 + 实测值 + 阈值 + 处置），供 color_report 与
 * 交付证据包引用；裁切类缺陷由 analyze 的 crush/blow 占比另行汇总（见 analyze）。
 */
export async function detectDefects({ input, at = [0], maxFrames = 4, bins = resolveBinaries() }) {
  const frames = at.slice(0, Math.max(1, maxFrames));
  const blur = [];
  const noise = [];
  const banding = [];
  for (const t of frames) {
    const [blurValue, noiseValue, bandingValue] = await Promise.all([
      detectBlurLevel({ input, at: t, bins }),
      estimateNoise({ input, at: t, bins }),
      detectBanding({ input, at: t, bins }).catch(() => null),
    ]);
    if (Number.isFinite(blurValue)) blur.push({ at: t, value: blurValue });
    if (Number.isFinite(noiseValue)) noise.push({ at: t, value: noiseValue });
    if (bandingValue) banding.push({ at: t, ...bandingValue });
  }
  const worst = (list) => (list.length ? list.reduce((a, b) => (b.value > a.value ? b : a)) : null);
  const worstBlur = worst(blur);
  const worstNoise = worst(noise);
  const bandedFrame = banding.find((entry) => entry.banded) ?? null;
  const defects = [];
  const checks = {
    blur: { samples: blur, worst: worstBlur ? { at: worstBlur.at, value: Math.round(worstBlur.value * 100) / 100 } : null, thresholds: BLUR_THRESHOLDS },
    noise: { samples: noise, worst: worstNoise ? { at: worstNoise.at, value: Math.round(worstNoise.value * 100) / 100 } : null, thresholds: NOISE_THRESHOLDS },
    banding: { samples: banding, hit: bandedFrame ? { at: bandedFrame.at, holeRatio: bandedFrame.holeRatio, span: bandedFrame.span, occupied: bandedFrame.occupied, meanGradient: bandedFrame.meanGradient } : null, thresholds: BANDING_THRESHOLDS },
  };
  if (worstBlur && worstBlur.value >= BLUR_THRESHOLDS.heavy) {
    defects.push({
      kind: "blur", severity: "warn", fixable: false, needsHumanReview: true,
      at: worstBlur.at, measured: Math.round(worstBlur.value * 100) / 100, threshold: BLUR_THRESHOLDS.heavy,
      detector: "ffmpeg blurdetect（lavfi.blur，block_pct=80）",
      detail: `焦点/运动模糊：blur=${worstBlur.value.toFixed(1)} ≥ ${BLUR_THRESHOLDS.heavy}（清晰档 <${BLUR_THRESHOLDS.slight}）`,
      action: "调色不可修复：如实标注并退回上游复核（浅景深/柔焦属创作意图时由人工确认放行）",
    });
  } else if (worstBlur && worstBlur.value >= BLUR_THRESHOLDS.slight) {
    defects.push({
      kind: "blur", severity: "info", fixable: false, needsHumanReview: true,
      at: worstBlur.at, measured: Math.round(worstBlur.value * 100) / 100, threshold: BLUR_THRESHOLDS.slight,
      detector: "ffmpeg blurdetect（lavfi.blur，block_pct=80）",
      detail: `轻微失焦/柔化：blur=${worstBlur.value.toFixed(1)}（${BLUR_THRESHOLDS.slight}–${BLUR_THRESHOLDS.heavy} 告警档）`,
      action: "如实上报并连播复核；确认是创作意图（浅景深/柔焦）再交付",
    });
  }
  if (worstNoise && worstNoise.value >= NOISE_THRESHOLDS.heavy) {
    defects.push({
      kind: "noise", severity: "warn", fixable: false, needsHumanReview: true,
      at: worstNoise.at, measured: Math.round(worstNoise.value * 100) / 100, threshold: NOISE_THRESHOLDS.heavy,
      detector: "signalstats 差分（原帧 vs gblur，YAVG）",
      detail: `明显噪点：差分 YAVG=${worstNoise.value.toFixed(1)} ≥ ${NOISE_THRESHOLDS.heavy}（干净平滑 <1）`,
      action: "调色不可修复：不实质降噪（会涂抹细节）；如实标注退回上游或由人工确认",
    });
  } else if (worstNoise && worstNoise.value >= NOISE_THRESHOLDS.slight) {
    defects.push({
      kind: "noise", severity: "info", fixable: true, needsHumanReview: false,
      at: worstNoise.at, measured: Math.round(worstNoise.value * 100) / 100, threshold: NOISE_THRESHOLDS.slight,
      detector: "signalstats 差分（原帧 vs gblur，YAVG）",
      detail: `可见颗粒噪点：差分 YAVG=${worstNoise.value.toFixed(1)} ≥ ${NOISE_THRESHOLDS.slight}`,
      action: "可用 conservative 降噪（colorwrite.grade 的 denoise，luma_spatial ≤2.0），或如实标注保留颗粒质感",
    });
  }
  if (bandedFrame) {
    defects.push({
      kind: "banding", severity: "warn", fixable: false, needsHumanReview: true,
      at: bandedFrame.at, measured: bandedFrame.holeRatio, threshold: BANDING_THRESHOLDS.holeRatio,
      detector: "音调直方图空洞比（160 宽 Y 通道，holeRatio）",
      detail: `色带/压缩伪影：holeRatio=${bandedFrame.holeRatio}（占用 ${bandedFrame.occupied}/${bandedFrame.span} 级，梯度 ${bandedFrame.meanGradient}）`,
      action: "调色不可修复：如实标注退回上游（重拍/重转码），不得用风格化掩盖",
    });
  }
  return {
    checks,
    defects,
    unfixable: defects.filter((defect) => defect.fixable === false && defect.severity !== "info"),
    note: frames.length ? null : "无抽样帧，缺陷检测未执行",
  };
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
 * 平台微调：当 query.platform 命中配方 overrides.platformOverrides[平台] 时，
 * 把该平台微调合并进生效 targets（优先级高于配方级 overrides）；
 * 无 platformOverrides 或未指定平台时行为与旧版完全一致。
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
    // platformOverrides 是 overrides 内部的平台微调嵌套键，不进 targets 基础合并；
    // 仅当调用上下文带目标平台且命中时，叠加到 targets 之上（优先级最高）。
    const { platformOverrides = null, ...recipeOverrides } = r.overrides ?? {};
    let targets = { ...doc.targets, ...recipeOverrides };
    let platformOverrideApplied = null;
    if (platform && platformOverrides && typeof platformOverrides === "object") {
      const hitKey = Object.keys(platformOverrides).find((key) => {
        const nk = norm(key);
        return nk === platform || nk.includes(platform) || platform.includes(nk);
      });
      if (hitKey && platformOverrides[hitKey] && typeof platformOverrides[hitKey] === "object") {
        targets = { ...targets, ...platformOverrides[hitKey] };
        platformOverrideApplied = hitKey;
      }
    }
    return {
      id: r.id,
      genre: r.genre,
      scene: r.scene,
      mood: r.mood,
      profile: r.profile,
      lut: lutAbs,
      lutExists: lutAbs ? fs.existsSync(lutAbs) : false,
      intensity: r.intensity,
      targets,
      platformOverrideApplied,
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

/**
 * 多帧指标聚合。T-02：可传 `weights`（场景段时长）按时长加权——
 * 30s 的主场景与 2s 的过场不该等权平均；不传权重时退化为等权（历史口径）。
 */
export function summarize(stats, weights = null) {
  const fields = ["YMIN", "YLOW", "YAVG", "YHIGH", "YMAX", "UAVG", "VAVG", "SATAVG", "SATMAX", "HUEAVG"];
  const usable = Array.isArray(weights) && stats.length > 0 && weights.length === stats.length
    && weights.every((weight) => Number.isFinite(weight) && weight > 0)
    ? weights
    : null;
  const out = {};
  for (const field of fields) {
    const pairs = stats
      .map((entry, index) => [entry[field], usable ? usable[index] : 1])
      .filter(([value]) => Number.isFinite(value));
    if (!pairs.length) {
      out[field] = null;
      continue;
    }
    const totalWeight = pairs.reduce((sum, [, weight]) => sum + weight, 0);
    out[field] = pairs.reduce((sum, [value, weight]) => sum + value * weight, 0) / totalWeight;
  }
  return out;
}

/* ---------- 场景切分自适应抽样（T-02）：固定 4 帧对多切点素材代表性不足 ---------- */

const round2 = (value) => Math.round(value * 100) / 100;

/** 切点阈值（ffmpeg scene 分数 0–1）：0.3 是"硬切"保守档，避免把快速运动/闪灯误判成换镜。 */
export const SCENE_CUT_THRESHOLD = 0.3;

/** 场景抽样上限：每帧一次 ffmpeg 进程，取帧越多越慢（6 帧 ≈ 原 4 帧成本的 1.5 倍）。 */
export const SCENE_MAX_SAMPLES = 6;

/** 场景数 ≤ 该值时退回均匀抽样：单镜/少切点素材用场景权重没有收益，保持历史行为可回归。 */
export const UNIFORM_SCENE_LIMIT = 4;

/**
 * 切点检测：`select='gt(scene,threshold)',showinfo` 把每段首帧的 pts_time 打到 stderr。
 * 失败（滤镜缺失/解码错误/超时）不抛错——调用方退回均匀抽样并在报告里如实标注。
 */
export async function detectSceneCuts({ input, threshold = SCENE_CUT_THRESHOLD, bins = resolveBinaries() }) {
  const { stderr } = await runBin(bins.ffmpeg, [
    "-hide_banner", "-v", "info",
    "-i", input,
    "-vf", `select='gt(scene,${threshold})',showinfo`,
    "-an", "-f", "null", "-",
  ], { label: "ffmpeg(scene-detect)", timeoutMs: 600_000 });
  const cuts = [];
  for (const line of stderr.split("\n")) {
    const match = /pts_time:(-?[0-9.]+)/.exec(line);
    if (match) cuts.push(Number(match[1]));
  }
  return [...new Set(cuts.filter((t) => Number.isFinite(t) && t > 0.02))].sort((a, b) => a - b);
}

/** 切点 + 时长 → 场景段列表（丢弃 <0.05s 的噪声段）。 */
export function sceneSegments({ cuts = [], duration = null }) {
  const end = Number.isFinite(duration) && duration > 0 ? duration : null;
  const points = [0, ...cuts.filter((t) => (end === null ? true : t < end - 0.05))];
  const segments = [];
  for (let index = 0; index < points.length; index += 1) {
    const start = points[index];
    const stop = index + 1 < points.length ? points[index + 1] : end;
    if (stop === null || stop - start <= 0.05) continue;
    segments.push({ start: round2(start), end: round2(stop), durationSec: round2(stop - start) });
  }
  return segments;
}

/**
 * 段代表帧：取每段中段（中点比首帧更能代表"这一段长什么样"，也避开转场瞬间的混合帧）。
 * 段数超过上限时把时间轴等分，每窗口取最长段——既保时间覆盖，又优先大场景。
 * 返回值带 `weights`（段时长），供 best 的候选打分按时长加权聚合。
 */
export function sceneSampleTimes({ segments, maxSamples = SCENE_MAX_SAMPLES }) {
  if (!segments.length) return { times: [], weights: [], picked: [] };
  let picked;
  if (segments.length <= maxSamples) {
    picked = [...segments];
  } else {
    const total = segments[segments.length - 1].end;
    picked = [];
    for (let index = 0; index < maxSamples; index += 1) {
      const lo = (total * index) / maxSamples;
      const hi = (total * (index + 1)) / maxSamples;
      const mid = (segment) => segment.start + segment.durationSec / 2;
      const inWindow = segments.filter((segment) => mid(segment) >= lo && mid(segment) < hi);
      const pool = inWindow.length ? inWindow : segments;
      const longest = pool.reduce((a, b) => (b.durationSec > a.durationSec ? b : a));
      if (!picked.includes(longest)) picked.push(longest);
    }
    picked.sort((a, b) => a.start - b.start);
  }
  return {
    times: picked.map((segment) => round2(segment.start + segment.durationSec / 2)),
    weights: picked.map((segment) => segment.durationSec),
    picked,
  };
}

/**
 * 抽样计划（analyze / grade / best 的默认帧来源）：
 *   sampling="scene"（默认）：先切场景；场景数 ≤4 时退回均匀抽样（与历史行为逐位一致）；
 *   sampling="uniform"：始终四帧均匀（历史口径；对照与回滚用）。
 * 显式 `at` 始终优先，不走本函数。
 */
export async function planSampling({
  input, duration = null, sampling = "scene", threshold = SCENE_CUT_THRESHOLD,
  maxSamples = SCENE_MAX_SAMPLES, uniformSamples = 4, bins = resolveBinaries(),
}) {
  const uniform = (extra = {}) => ({
    times: defaultTimestamps(duration).slice(0, Math.max(1, uniformSamples)),
    weights: null, mode: "uniform", sceneCount: null, cuts: [], threshold: null, segments: [], note: null,
    ...extra,
  });
  if (sampling !== "scene") return uniform();
  let cuts;
  try {
    cuts = await detectSceneCuts({ input, threshold, bins });
  } catch (error) {
    const detail = error instanceof Error ? error.message.slice(0, 120) : String(error);
    return uniform({ note: `场景切分不可用（${detail}），已退回均匀抽样` });
  }
  const segments = sceneSegments({ cuts, duration });
  if (segments.length <= UNIFORM_SCENE_LIMIT) {
    return uniform({
      cuts, sceneCount: segments.length,
      note: segments.length ? null : "未检出切点（单镜到底），退回均匀抽样",
    });
  }
  const { times, weights, picked } = sceneSampleTimes({ segments, maxSamples });
  return {
    times, weights, mode: "scene", sceneCount: segments.length,
    cuts, threshold, segments: picked, note: null,
  };
}

/**
 * 成片色彩诊断：抽样 → 指标 → 问题清单（含修复建议）+ 缺陷检测（T-03）。
 * 抽样默认走场景切分（T-02）：多切点素材按场景取代表帧，单镜/少切点退回均匀四帧。
 * @returns {Promise<object>}
 */
export async function analyze({
  input, at = null, patch = null, skinPatch = null, neutralPatch = null,
  sampling = "scene", sceneThreshold = SCENE_CUT_THRESHOLD, maxSamples = SCENE_MAX_SAMPLES,
  defects = true, bins = resolveBinaries(),
}) {
  const probe = await probeMedia(input, { bins });
  const plan = Array.isArray(at) && at.length
    ? { times: at, weights: null, mode: "explicit", sceneCount: null, cuts: [], threshold: null, segments: [], note: null }
    : await planSampling({ input, duration: probe.duration, sampling, threshold: sceneThreshold, maxSamples, bins });
  const times = plan.times.length ? plan.times : [0];
  const frameCount = Math.max(1, probe.video.width * probe.video.height);

  const perFrame = [];
  for (const t of times) {
    const stats = await frameStats({ input, at: t, patch, bins });
    perFrame.push({ at: t, ...stats });
  }
  const summary = summarize(perFrame, plan.weights);

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

  // 肤色取证（T-01）：调用方显式 skinPatch > 自动检测 > 未执行（如实标注，不静默跳过）。
  let skin = null;
  let skinDetection = null;
  // 肤色判据口径（FC-COL-007 修复）：hue 取标准 HSV 色相（由 UAVG/VAVG 推算），
  // 不再拿 signalstats 的 HUEAVG（复合色度相位角）去套 HSV 的 20–40° 带；HUEAVG 保留在证据里可追溯。
  const verdictOf = (stats) => {
    const hue = standardHueFromUv(stats.UAVG, stats.VAVG);
    const sat = stats.SATAVG;
    return {
      healthy: Number.isFinite(hue) && hue >= TARGET.skinHue[0] && hue <= TARGET.skinHue[1] && (!Number.isFinite(sat) || sat <= 60),
      hue,
      hueFfmpeg: Number.isFinite(stats.HUEAVG) ? Math.round(stats.HUEAVG * 10) / 10 : null,
      saturation: Number.isFinite(sat) ? Math.round(sat * 10) / 10 : null,
      uv: {
        u: Number.isFinite(stats.UAVG) ? Math.round(stats.UAVG * 10) / 10 : null,
        v: Number.isFinite(stats.VAVG) ? Math.round(stats.VAVG * 10) / 10 : null,
      },
    };
  };
  if (skinPatch) {
    const stats = await frameStats({ input, at: times[0], patch: skinPatch, bins });
    const verdict = verdictOf(stats);
    skin = { ...verdict, source: "explicit-patch", patch: skinPatch, confidence: "high", areaShare: null };
    if (!verdict.healthy) {
      issues.push({
        kind: "skin_tone",
        severity: "warn",
        detail: `肤色取样 HSV hue=${verdict.hue ?? "n/a"}°（目标 ${TARGET.skinHue[0]}–${TARGET.skinHue[1]}°，U/V=${verdict.uv.u}/${verdict.uv.v}）`,
        suggestion: "先修白平衡再动饱和；肤色优先于风格化",
      });
    }
  } else {
    const auto = await detectSkinRegion({ input, at: times[0], probe, bins }).catch(() => null);
    if (auto?.detected) {
      const stats = await frameStats({ input, at: times[0], patch: auto.patch, bins });
      const verdict = verdictOf(stats);
      const hueMargin = Number.isFinite(verdict.hue)
        ? Math.min(verdict.hue - TARGET.skinHue[0], TARGET.skinHue[1] - verdict.hue)
        : -99;
      // 自动区先按"测出的 hue 是否落在肤色带"验收；不在带内说明命中的是木质/沙色等近似色，判未命中。
      if (verdict.healthy || (Number.isFinite(verdict.hue) && verdict.hue >= TARGET.skinHue[0] && verdict.hue <= TARGET.skinHue[1])) {
        const confidence = auto.areaShare >= 0.04 && hueMargin >= 2 ? "high" : "medium";
        skin = { ...verdict, source: "auto-skin-band", auto: true, patch: auto.patch, confidence, areaShare: auto.areaShare };
        skinDetection = { ...auto, ...verdict, confidence };
        if (!verdict.healthy) {
          issues.push({
            kind: "skin_tone",
            severity: confidence === "high" ? "warn" : "info",
            detail: `肤色自动检测区 HSV hue=${verdict.hue ?? "n/a"}°（目标 ${TARGET.skinHue[0]}–${TARGET.skinHue[1]}°，置信度 ${confidence}，区域 ${auto.patch.w}×${auto.patch.h}@${auto.patch.x},${auto.patch.y}）`,
            suggestion: confidence === "high"
              ? "先修白平衡再动饱和；肤色优先于风格化"
              : "自动区置信度有限：请人工确认区域是否确为肤色，再决定是否修正",
          });
        }
      } else {
        skinDetection = { ...auto, ...verdict, confidence: "rejected", reason: `自动区 HSV hue=${verdict.hue ?? "n/a"}° 不在 ${TARGET.skinHue[0]}–${TARGET.skinHue[1]}° 肤色带内` };
        skin = { ...verdict, source: "auto-skin-band", auto: false, detected: false, patch: auto.patch };
        issues.push({
          kind: "skin_check_skipped",
          severity: "info",
          detail: `自动肤色候选区不在肤色带内（HSV hue=${verdict.hue ?? "n/a"}°），肤色判据未采信`,
          suggestion: "有人物镜头请显式传 skin_patch；无人物的空镜/风景可忽略本条",
        });
      }
    } else {
      skin = { hue: null, saturation: null, healthy: null, auto: false, detected: false, source: "auto-skin-band" };
      skinDetection = auto ?? { detected: false, areaShare: 0 };
      issues.push({
        kind: "skin_check_skipped",
        severity: "info",
        detail: `未提供 skin_patch，自动肤色检测未命中候选区（面积占比 <${(SKIN_MIN_AREA_SHARE * 100).toFixed(1)}%）：肤色判据未执行`,
        suggestion: "有人物镜头请显式传 skin_patch；无人物的空镜/风景可忽略本条",
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

  // 缺陷检测（T-03）：失焦/明显噪点/色带/大比例裁切逐条上报——"不可修复"必须出现在报告里，
  // 不许静默跳过（诚实上报条款的可执行版本）。检测失败按"未核实"标注，不当作通过。
  let defectReport = null;
  if (defects) {
    defectReport = await detectDefects({ input, at: times, bins }).catch((error) => ({
      checks: null,
      defects: [],
      unfixable: [],
      note: `缺陷检测未执行：${error instanceof Error ? error.message.slice(0, 120) : String(error)}`,
    }));
    if (crushRatio >= CLIP_UNFIXABLE_RATIO || blowRatio >= CLIP_UNFIXABLE_RATIO) {
      defectReport.defects.push({
        kind: "clipping", severity: "warn", fixable: false, needsHumanReview: true, at: times[0],
        measured: Math.round(Math.max(crushRatio, blowRatio) * 10000) / 10000, threshold: CLIP_UNFIXABLE_RATIO,
        detector: "signalstats YLOW/YHIGH 占比（analyze 既有口径）",
        detail: `高光/暗部信息丢失：暗部压死 ${(crushRatio * 100).toFixed(1)}%、高光裁切 ${(blowRatio * 100).toFixed(1)}%（不可修复档 ≥${(CLIP_UNFIXABLE_RATIO * 100).toFixed(0)}%）`,
        action: "调色不可修复：如实标注并退回上游；不得用风格化掩盖",
      });
    }
    defectReport.unfixable = defectReport.defects.filter((defect) => defect.fixable === false && defect.severity !== "info");
    for (const defect of defectReport.defects) {
      issues.push({ kind: `defect_${defect.kind}`, severity: defect.severity, detail: defect.detail, suggestion: defect.action });
    }
  }

  return {
    input,
    probe,
    timestamps: times,
    sampling: {
      mode: plan.mode, sceneCount: plan.sceneCount, threshold: plan.threshold,
      cuts: plan.cuts, segments: plan.segments, weights: plan.weights, note: plan.note,
    },
    perFrame,
    summary,
    whiteBalance,
    skin,
    skinDetection,
    defects: defectReport,
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

/* ---------- conversion 级：log 素材转换 LUT 链（恒 100%，置于校正与创意之前） ----------
 *
 * 分工纪律（T-21）：曲线归曲线、色域归色域——
 *   slog3-to-rec709.cube       只做 S-Log3→BT.709 的 OETF 曲线；
 *   sgamut3cine-to-rec709.cube 只做 S-Gamut3.Cine→BT.709 的色域矩阵（线性光域 3×3，
 *                              LUT 输入/输出为 BT.709 码值域，专为串接在前者之后设计）。
 * 链式复合后等效于：S-Log3 解码 → 线性 → 色域矩阵 → BT.709 编码。
 */
export const CONVERSION_LUTS = {
  slog3Oetf: "slog3-to-rec709.cube",
  sgamut3cineGamut: "sgamut3cine-to-rec709.cube",
};

/**
 * 解析素材传递函数/色域（调用方参数优先，其次码流元数据）。
 * ffprobe 对 S-Log3 / S-Gamut3.Cine 均无标准标签，实践中主要靠调用方显式传入；
 * 元数据仅在明确写出 slog3 / sgamut3cine 字样时采信，不猜。
 */
export function resolveSourceColor({ probe = null, sourceTransfer = null, sourceGamut = null } = {}) {
  const norm = (v) => {
    const s = String(v ?? "").trim().toLowerCase();
    return s || null;
  };
  const transferTag = norm(probe?.video?.colorTransfer) ?? "";
  const primariesTag = norm(probe?.video?.colorPrimaries) ?? "";
  return {
    transfer: norm(sourceTransfer) ?? (/s-?log3/.test(transferTag) ? "slog3" : null),
    gamut: norm(sourceGamut) ?? (/s-?gamut3\.?cine/.test(primariesTag) ? "sgamut3cine" : null),
  };
}

/**
 * conversion 级 LUT 链决策：
 *   S-Log3 + S-Gamut3.Cine → [OETF 曲线 LUT, 色域矩阵 LUT]（顺序不可换）；
 *   S-Log3 + 色域不确定   → 仅 OETF 曲线 LUT（保持现状），note 注明缺口；
 *   其他                  → 空链（由调用方按既有 lut_path 流程处理）。
 */
export function resolveConversionLuts(sourceColor) {
  if (sourceColor?.transfer !== "slog3") return { luts: [], note: null };
  const luts = [path.join(LUT_DIR, CONVERSION_LUTS.slog3Oetf)];
  if (sourceColor.gamut === "sgamut3cine") {
    luts.push(path.join(LUT_DIR, CONVERSION_LUTS.sgamut3cineGamut));
    return { luts, note: null };
  }
  return {
    luts,
    note: "S-Log3 素材但色域未确认为 S-Gamut3.Cine（元数据/参数均未指示）：仅做 OETF 曲线转换，"
      + "高饱和区域（霓虹/车漆/彩妆）可能有饱和/色相偏差；确认色域后以 source_gamut=sgamut3cine 启用色域矩阵",
  };
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
 * @param {{profile?:string, lutPath?:string, corrections?:object, intensity?:number, conversionLuts?:string[], denoise?:{lumaSpatial?:number}|null}} spec
 *
 * 顺序：conversion LUT（恒 100%，最前） → 可选降噪（恒 100%） → 校正（恒 100%） → 创作 look（按 intensity 混合）。
 */
export function buildChain(spec = {}) {
  const { profile = null, lutPath = null, corrections = {}, intensity = 1, conversionLuts = [], denoise = null } = spec;
  if (!Number.isFinite(intensity) || intensity <= 0 || intensity > 1) {
    throw new ColorError(`intensity 必须落在 (0,1]，收到 ${intensity}`, "bad_request");
  }
  if (profile && !PROFILES[profile]) {
    throw new ColorError(`未知 profile：${profile}（可用：${Object.keys(PROFILES).join(", ")}）`, "bad_profile");
  }

  // 两段式：校正（白平衡/曝光/裁切）恒为 100% 生效；只有"创作 look"（profile/LUT）按 intensity 混合。
  // 理由：把校正也一起按 0.8 稀释，会让"欠曝修一半"，画面几乎看不出变化（早期 bug）。
  // conversion LUT 同属"还原"而非 look：恒 100%、不参与 intensity 混合、置于最前。
  const conversionParts = conversionLuts.map((p) => `lut3d='${escapeFilterPath(p)}'`);
  // 可选降噪（T-24）：仅当调用方显式开启且噪点检测命中时由上层传入 spec.denoise；
  // 位置在 conversion 之后、校正之前（先还原色彩空间，再降噪，再校正）。
  // luma_spatial 保守强度，硬上限 2.0：镜间一致性场景宁可欠降也不可降出涂抹感。
  const denoiseParts = denoise
    ? [`hqdn3d=luma_spatial=${Math.min(2, Number(denoise.lumaSpatial ?? 1.5))}`]
    : [];
  const correctionParts = buildCorrections(corrections ?? {});
  const lookParts = [];
  if (profile) lookParts.push(PROFILES[profile]);
  if (lutPath) lookParts.push(`lut3d='${escapeFilterPath(lutPath)}'`);
  if (conversionParts.length === 0 && denoiseParts.length === 0 && correctionParts.length === 0 && lookParts.length === 0) {
    throw new ColorError("未指定任何 profile / lut / corrections", "bad_request");
  }

  const conversionChain = conversionParts.join(",");
  const denoiseChain = denoiseParts.join(",");
  const correctionChain = correctionParts.join(",");
  const lookChain = lookParts.join(",");
  const head = [conversionChain, denoiseChain, correctionChain].filter(Boolean).join(",");
  if (!lookChain) return head;  // 转换/降噪/校正，无创作
  if (intensity >= 1) return [head, lookChain].filter(Boolean).join(",");
  const headPrefix = head ? `${head},` : "";
  // 强度混合：`blend` 的 all_opacity 权重作用在**第一个输入**上（ffmpeg 语义，已实测校准）。
  // 因此把「已调色」放前面、opacity=intensity，才是"按 intensity 叠加 look"。
  // 反着写（原片在前 + opacity=intensity）会让 look 恒接近满档——2026-09-21 的"强度参数失效"事故根因。
  return `${headPrefix}split=2[__orig][__tograde];[__tograde]${lookChain}[__graded];[__graded][__orig]blend=all_mode=normal:all_opacity=${intensity}`;
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
  sourceTransfer = null, sourceGamut = null, denoise = false,
  sampling = "scene", sceneThreshold = SCENE_CUT_THRESHOLD, maxSamples = SCENE_MAX_SAMPLES,
  defects = true, onUnfixable = "report", quality = "hd",
}) {
  if (!["hd", "uhd"].includes(quality)) throw new ColorError(`未知清晰度档位：${quality}`, "bad_request");
  const probe = await probeMedia(input, { bins });
  await assertOutputWritable(output, input, probe.sizeBytes);
  if (lutPath && !fs.existsSync(lutPath)) throw new ColorError(`LUT 不存在：${lutPath}`, "bad_lut");
  if (lutPath && !/\.cube$/i.test(lutPath)) throw new ColorError(`LUT 必须是 .cube：${lutPath}`, "bad_lut");

  // conversion 级：S-Log3（+S-Gamut3.Cine）素材自动挂转换 LUT 链（恒 100%，最前）。
  // 色域无法确认时保持仅 OETF 转换的现状，并在报告 conversion.note / verifyWarnings 注明。
  const sourceColor = resolveSourceColor({ probe, sourceTransfer, sourceGamut });
  const conversion = resolveConversionLuts(sourceColor);
  for (const lut of conversion.luts) {
    if (!fs.existsSync(lut)) {
      throw new ColorError(`转换 LUT 缺失：${lut}（跑 bundles/ai-video/library/luts/generate-luts.mjs 重建）`, "bad_lut");
    }
  }

  // 校验帧（T-02）：默认按场景切分取每场中段代表帧；单镜/少切点退回均匀四帧（历史口径）。
  // 显式 verifyAt 优先（调用方点名帧时不做场景推断）。
  const samplingPlan = Array.isArray(verifyAt) && verifyAt.length
    ? { times: verifyAt, weights: null, mode: "explicit", sceneCount: null, cuts: [], threshold: null, segments: [], note: null }
    : await planSampling({ input, duration: probe.duration, sampling, threshold: sceneThreshold, maxSamples, bins });
  const at = samplingPlan.times.length ? samplingPlan.times : [0];

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

  // 可选降噪（T-24）：默认关闭。显式开启时先跑噪点代理检测（signalstats 差分口径），
  // 命中才在校正前插入 hqdn3d（luma_spatial 保守 ≤2.0）；动作与参数随 chain 字段留痕。
  let denoiseSpec = null;
  let denoiseNote = null;
  if (denoise) {
    const samples = [];
    for (const t of at.slice(0, 2)) samples.push(await estimateNoise({ input, at: t, bins }));
    const valid = samples.filter((v) => Number.isFinite(v));
    const noiseYavg = valid.length ? valid.reduce((a, b) => a + b, 0) / valid.length : null;
    if (Number.isFinite(noiseYavg) && noiseYavg >= NOISE_DIFF_YAVG_HIT) {
      denoiseSpec = { lumaSpatial: 1.5 };
    } else {
      denoiseNote = `denoise 已请求但噪点代理差分 YAVG=${Number.isFinite(noiseYavg) ? noiseYavg.toFixed(2) : "n/a"}`
        + ` 未达命中阈值 ${NOISE_DIFF_YAVG_HIT}，未插入降噪`;
    }
  }

  const chain = buildChain({ profile, lutPath, corrections: effectiveCorrections, intensity, conversionLuts: conversion.luts, denoise: denoiseSpec });

  const before = [];
  for (const t of at) before.push({ at: t, ...(await frameStats({ input, at: t, bins })) });

  const args = [
    "-hide_banner", "-v", "error", "-y",
    "-i", input,
    "-vf", chain,
    "-c:v", "libx264", "-preset", "medium", "-crf", quality === "uhd" ? "16" : "20",
    ...(quality === "uhd" ? ["-threads", "2", "-filter_threads", "1"] : []), "-pix_fmt", "yuv420p",
    // 交付元数据（T-04）：显式打 Rec.709 三标签，避免下游平台按容器默认值误判色域。
    "-color_primaries", "bt709", "-color_trc", "bt709", "-colorspace", "bt709",
  ];
  if (probe.audio) args.push("-c:a", "aac", "-b:a", "192k");
  args.push("-movflags", "+faststart", output);

  await runBin(bins.ffmpeg, args, { label: "ffmpeg(grade)", timeoutMs: 900_000 });

  if (!fs.existsSync(output)) throw new ColorError("ffmpeg 未产出文件", "ffmpeg_failed", true);
  const outProbe = await probeMedia(output, { bins });
  // 回读校验（T-04）：ffprobe 必须能读到 bt709 三标签；读不到按"未核实"标注（不静默当通过），
  // 读到了但不是 bt709 属交付契约破坏 → 删产物并 fail-closed。
  const outputColor = {
    primaries: outProbe.video.colorPrimaries ?? null,
    transfer: outProbe.video.colorTransfer ?? null,
    space: outProbe.video.colorSpace ?? null,
  };
  const normalizeTag = (value) => String(value ?? "").trim().toLowerCase();
  const tagKeys = [["primaries", "color_primaries"], ["transfer", "color_trc"], ["space", "colorspace"]];
  const missingTags = tagKeys.filter(([key]) => normalizeTag(outputColor[key]) === "");
  const wrongTags = tagKeys.filter(([key]) => normalizeTag(outputColor[key]) !== "" && normalizeTag(outputColor[key]) !== "bt709");
  if (wrongTags.length) {
    await fsp.rm(output, { force: true });
    throw new ColorError(
      `输出色彩元数据标签不符：${wrongTags.map(([key, label]) => `${label}=${outputColor[key]}`).join(" ")}（应为 bt709）`,
      "verify_failed",
    );
  }
  const colorTagWarning = missingTags.length
    ? `输出色彩标签未核实：ffprobe 未返回 ${missingTags.map(([, label]) => label).join("/")}（已按 bt709 写入，请用带该字段的 ffprobe 复核）`
    : null;
  outputColor.verified = missingTags.length === 0;
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

  // 缺陷检测（T-03）：默认 report（进证据 + verifyWarnings，绝不静默）；交付线要硬闸时传 onUnfixable="block"，
  // 命中不可修复缺陷即删产物并 fail-closed（不得产出「调过了」的坏镜头）。
  let defectReport = null;
  if (defects) {
    defectReport = await detectDefects({ input, at, bins }).catch((error) => ({
      checks: null, defects: [], unfixable: [],
      note: `缺陷检测未执行：${error instanceof Error ? error.message.slice(0, 120) : String(error)}`,
    }));
    defectReport.unfixable = defectReport.defects.filter((defect) => defect.fixable === false && defect.severity !== "info");
    if (onUnfixable === "block" && defectReport.unfixable.length) {
      await fsp.rm(output, { force: true });
      throw new ColorError(
        `素材存在不可修复缺陷（${defectReport.unfixable.map((defect) => `${defect.kind}:${defect.detail}`).join("；")}）：`
        + "按交付纪律拒绝出片并退回上游（如属创作意图请改用 onUnfixable=report 并写明理由）",
        "verify_failed",
      );
    }
  }

  return {
    input,
    output,
    chain,
    profile,
    lut: lutPath,
    intensity,
    quality,
    auto: autoUsed,
    conversion: {
      transfer: sourceColor.transfer,
      gamut: sourceColor.gamut,
      luts: conversion.luts.map((p) => path.basename(p)),
      note: conversion.note,
    },
    durationSeconds: outProbe.duration,
    sizeBytes: outProbe.sizeBytes,
    before: beforeSummary,
    after: afterSummary,
    delta,
    sampling: {
      mode: samplingPlan.mode, sceneCount: samplingPlan.sceneCount, threshold: samplingPlan.threshold,
      cuts: samplingPlan.cuts, segments: samplingPlan.segments, weights: samplingPlan.weights, note: samplingPlan.note,
    },
    outputColor,
    defects: defectReport,
    visibility,
    sha256: await sha256File(output),
    verifyWarnings: [
      ...(denoiseNote ? [denoiseNote] : []),
      ...(conversion.note ? [conversion.note] : []),
      ...(colorTagWarning ? [colorTagWarning] : []),
      ...(defectReport?.note ? [defectReport.note] : []),
      ...((defectReport?.defects ?? []).map((defect) => `${defect.fixable === false ? "不可修复" : "提示"}：${defect.detail} → ${defect.action}`)),
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
 * 残差判据两层：均值（ΔYAVG/UAVG/VAVG，既有硬线口径）+ 直方图形状（T-24，补均值陷阱）。
 * histogramCheck：warn（默认，超限写入 residual.histogram.warning 上报）
 *               | fail（超限判该镜失败 ok=false）| off（关闭直方图判据）。
 */
export async function match({
  reference, targets, outDir, profile = null, intensity = 1, bins = resolveBinaries(),
  at = null, histogramCheck = "warn", denoise = false,
}) {
  if (!["off", "warn", "fail"].includes(histogramCheck)) {
    throw new ColorError(`histogramCheck 只能是 off/warn/fail，收到 ${histogramCheck}`, "bad_request");
  }
  if (!Array.isArray(targets) || targets.length === 0) throw new ColorError("targets 为空", "bad_request");
  if (!fs.existsSync(reference)) throw new ColorError(`参考镜不存在：${reference}`, "not_found");
  await fsp.mkdir(outDir, { recursive: true });

  const refProbe = await probeMedia(reference, { bins });
  const refTimes = Array.isArray(at) && at.length ? at : defaultTimestamps(refProbe.duration).slice(0, 2);
  const refFrames = [];
  for (const t of refTimes) refFrames.push(await frameStats({ input: reference, at: t, bins }));
  const referenceSummary = summarize(refFrames);

  // 参考镜直方图基线（与均值基线同样的抽样帧口径）
  let refHistogram = null;
  if (histogramCheck !== "off") {
    const hists = [];
    for (const t of refTimes) hists.push(await yuvHistogram({ input: reference, at: t, bins }));
    refHistogram = averageHistograms(hists);
  }

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
    const graded = await grade({ input: target, output: outPath, profile, corrections, intensity, verifyAt: targetTimes, bins, denoise });
    const residual = {
      YAVG: Number.isFinite(graded.after.YAVG) ? Math.round((graded.after.YAVG - referenceSummary.YAVG) * 100) / 100 : null,
      UAVG: Number.isFinite(graded.after.UAVG) ? Math.round((graded.after.UAVG - referenceSummary.UAVG) * 100) / 100 : null,
      VAVG: Number.isFinite(graded.after.VAVG) ? Math.round((graded.after.VAVG - referenceSummary.VAVG) * 100) / 100 : null,
    };

    // 直方图形状残差（T-24）：均值达标但分布不匹配时兜底告警/判负，写入既有 residual 字段
    let histOver = false;
    if (refHistogram) {
      const afterHists = [];
      for (const t of targetTimes) afterHists.push(await yuvHistogram({ input: outPath, at: t, bins }));
      const { chi2, weighted } = histResidual(averageHistograms(afterHists), refHistogram);
      const round = (v) => Math.round(v * 1000) / 1000;
      histOver = weighted > HIST_RESIDUAL_THRESHOLD;
      residual.histogram = {
        chi2Y: round(chi2.Y),
        chi2U: round(chi2.U),
        chi2V: round(chi2.V),
        weighted: round(weighted),
        threshold: HIST_RESIDUAL_THRESHOLD,
        over: histOver,
        warning: histOver
          ? `直方图残差 ${round(weighted)} > 阈值 ${HIST_RESIDUAL_THRESHOLD}：均值达标但分布不匹配（均值陷阱），`
            + "先按参考镜三准则复查参考镜，再人工连播复核"
          : null,
      };
    }

    if (histOver && histogramCheck === "fail") {
      results.push({
        target,
        ok: false,
        error: "histogram_residual",
        output: graded.output,
        corrections,
        residual,
        sha256: graded.sha256,
      });
      continue;
    }
    results.push({
      target,
      ok: true,
      output: graded.output,
      corrections,
      reference: referenceSummary,
      before: graded.before,
      after: graded.after,
      residual,
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
      "-ss", String(at), ...RGB_INPUT_COLOR_ARGS, "-i", input,
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
    "-ss", String(at), ...RGB_INPUT_COLOR_ARGS, "-i", before,
    "-ss", String(at), ...RGB_INPUT_COLOR_ARGS, "-i", after,
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
    "-ss", String(at), ...RGB_INPUT_COLOR_ARGS, "-i", input,
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

function averageMetrics(samples, weights = null) {
  const keys = Object.keys(samples[0]);
  const usable = Array.isArray(weights) && weights.length === samples.length
    && weights.every((weight) => Number.isFinite(weight) && weight > 0)
    ? weights
    : null;
  const totalWeight = usable ? usable.reduce((a, b) => a + b, 0) : null;
  const avg = {};
  for (const k of keys) {
    avg[k] = usable
      ? Math.round((samples.reduce((s, x, index) => s + x[k] * usable[index], 0) / totalWeight) * 100) / 100
      : Math.round((samples.reduce((s, x) => s + x[k], 0) / samples.length) * 100) / 100;
  }
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
  minImprovement = 2, width = 480, bins = resolveBinaries(), maxSamples = SCENE_MAX_SAMPLES,
  recipe = null, genre = null, platform = null,
  sampling = "scene", sceneThreshold = SCENE_CUT_THRESHOLD, defects = true, onUnfixable = "report",
}) {
  const probe = await probeMedia(input, { bins });
  // 抽样（T-02）：显式 sampleAt 优先；否则按场景切分取每场中段，场景权重用于候选打分聚合。
  const samplingPlan = Array.isArray(sampleAt) && sampleAt.length
    ? { times: sampleAt.slice(0, maxSamples), weights: null, mode: "explicit", sceneCount: null, cuts: [], threshold: null, segments: [], note: null }
    : await planSampling({ input, duration: probe.duration, sampling, threshold: sceneThreshold, maxSamples, bins });
  const at = samplingPlan.times.length ? samplingPlan.times : [0];

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
    const autoApplied = autoCorrections(summarize(statsFrames, samplingPlan.weights));

    // 配方驱动候选：给出题材/配方时，以该配方的 look 与强度为中心生成候选（± 一档），
    // 并额外提供「配方 LUT」候选——这就是"不同片子/场景自动出方案"的落点：
    // 题材决定方向，择优决定力度，画质分决定动不动。
    let recipeUsed = null;
    const recipePool = [];
    if (recipe || genre || platform) {
      const found = findRecipes({ recipeId: recipe, genre, platform, list: false });
      recipeUsed = found.recipe ?? null;
      if (recipeUsed) {
        const base = Number(recipeUsed.intensity) || 0.7;
        for (const raw of [base - 0.2, base, base + 0.2]) {
          const intensity = Math.round(Math.min(1, Math.max(0.3, raw)) * 100) / 100;
          recipePool.push({
            id: `recipe:${recipeUsed.id}@${intensity}`,
            label: `${recipeUsed.genre}·${recipeUsed.id} 强度 ${intensity}`,
            spec: { profile: recipeUsed.profile, intensity },
          });
        }
        if (recipeUsed.lut && recipeUsed.lutExists) {
          recipePool.push({
            id: `recipe-lut:${recipeUsed.id}`,
            label: `${recipeUsed.genre}·${recipeUsed.id}（LUT）`,
            spec: { lutPath: recipeUsed.lut, intensity: 1 },
          });
        }
      }
    }

    const pool = [
      { id: "identity", label: "原片不动（不调色）", spec: null },
      ...(Object.keys(autoApplied).length
        ? [{ id: "auto-correct", label: "仅自动校正（白平衡/曝光/裁切）", spec: { corrections: autoApplied, intensity: 1 } }]
        : []),
      ...recipePool,
      ...(Array.isArray(candidates) && candidates.length ? candidates : defaultCandidates()),
    ];
    // 去重：同 id 只保留第一个（identity > auto-correct > 配方候选 > 通用候选）
    const seen = new Set();
    const deduped = pool.filter((entry) => (seen.has(entry.id) ? false : (seen.add(entry.id), true)));

    const evaluated = [];
    for (const candidate of deduped) {
      const chain = candidate.spec ? buildChain(candidate.spec) : "null";
      // 同一候选的抽样帧并行评估（4 帧并发），候选之间串行——总耗时从分钟级降到十几秒。
      const perFrame = await Promise.all(
        frames.map((still) => qualityWithChain({ framePath: still, chain, width, bins })),
      );
      evaluated.push({ id: candidate.id, label: candidate.label, spec: candidate.spec, chain, quality: averageMetrics(perFrame, samplingPlan.weights) });
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
        recipe: recipeUsed?.id ?? null,
        recipeContext: recipeUsed ? { genre: recipeUsed.genre, scene: recipeUsed.scene, mood: recipeUsed.mood, avoid: recipeUsed.avoid } : null,
        sampledAt: at,
        sampling: {
          mode: samplingPlan.mode, sceneCount: samplingPlan.sceneCount, threshold: samplingPlan.threshold,
          cuts: samplingPlan.cuts, segments: samplingPlan.segments, weights: samplingPlan.weights, note: samplingPlan.note,
        },
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
      defects,
      onUnfixable,
    });
    const outQuality = (await qualityOfFile({ input: output, at, width, bins })).avg;
    return {
      verdict: "graded",
      winner: winner.id,
      winnerLabel: winner.label,
      recipe: recipeUsed?.id ?? null,
      recipeContext: recipeUsed ? { genre: recipeUsed.genre, scene: recipeUsed.scene, mood: recipeUsed.mood, avoid: recipeUsed.avoid } : null,
      improvement,
      minImprovement,
      source: baseline.quality,
      after: outQuality,
      finalScore: scoreQuality(outQuality, baseline.quality),
      chain: graded.chain,
      outputColor: graded.outputColor,
      defects: graded.defects,
      visibility: graded.visibility,
      delta: graded.delta,
      sha256: graded.sha256,
      sampledAt: at,
      sampling: {
        mode: samplingPlan.mode, sceneCount: samplingPlan.sceneCount, threshold: samplingPlan.threshold,
        cuts: samplingPlan.cuts, segments: samplingPlan.segments, weights: samplingPlan.weights, note: samplingPlan.note,
      },
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
        sampling: params.sampling ? String(params.sampling) : "scene",
        sceneThreshold: params.scene_threshold === undefined ? SCENE_CUT_THRESHOLD : Number(params.scene_threshold),
        defects: params.defects !== false,
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
        denoise: params.denoise === true,
        sourceTransfer: params.source_transfer ?? null,
        sourceGamut: params.source_gamut ?? null,
        sampling: params.sampling ? String(params.sampling) : "scene",
        sceneThreshold: params.scene_threshold === undefined ? SCENE_CUT_THRESHOLD : Number(params.scene_threshold),
        defects: params.defects !== false,
        onUnfixable: params.on_unfixable === "block" ? "block" : "report",
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
        recipe: params.recipe_id ?? null,
        genre: params.genre ?? null,
        platform: params.platform ?? null,
        sampling: params.sampling ? String(params.sampling) : "scene",
        sceneThreshold: params.scene_threshold === undefined ? SCENE_CUT_THRESHOLD : Number(params.scene_threshold),
        defects: params.defects !== false,
        onUnfixable: params.on_unfixable === "block" ? "block" : "report",
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
        histogramCheck: params.histogram_check ?? "warn",
        denoise: params.denoise === true,
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
