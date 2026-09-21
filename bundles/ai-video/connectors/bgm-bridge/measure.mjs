/**
 * ai-video × 配乐工位 · 音频度量内核（measure.mjs）
 *
 * 定位：把"配乐这件事到底改了什么、有没有压住人声、响度对不对"变成可计算的数字。
 * 只用 node 内置模块 + 工位本地 ffmpeg/ffprobe，零第三方依赖、零云端调用。
 *
 * 度量口径（全部来自 ffmpeg 的公开滤镜语义，参数为本仓自有取值）：
 * - 响度：EBU R128（loudnorm 测量通道 → integrated LUFS / true peak dBTP / LRA）
 * - 电平：volumedetect 的 mean_volume（按帧 RMS 平均，dBFS）
 * - 频谱：aspectralstats 的 centroid（谱心 Hz）与 flatness（谱平坦度）
 * - 人声频段活动：silencedetect（默认 -38dB / 0.35s）在 200–4000Hz 带通上求"非静音段"
 * - 剪辑点：scene 检测（scene_score 阈值）→ 卡点对齐的事实源
 *
 * 纪律：
 * - 只读输入：本文件不写任何素材文件（除调用方显式指定的证据图目录）；
 * - 不伪造：解析不到就是解析不到，抛带稳定 code 的 MeasureError，由上层决定重试或转人工。
 */

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";

/* ============================ 错误与常量 ============================ */

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
  "bad_track",
  "bad_recipe",
  "license_blocked",
  "separation_unavailable",
  "verify_failed",
  "idempotency_conflict",
  "not_configured",
]);

export class MeasureError extends Error {
  /**
   * @param {string} message
   * @param {string} code
   * @param {boolean} [retryable]
   */
  constructor(message, code, retryable = NEVER_RETRY_CODES.has(code) ? false : RETRYABLE_CODES.has(code)) {
    super(message);
    this.name = "MeasureError";
    this.code = code;
    this.retryable = retryable;
  }
}

/* ============================ 二进制解析 ============================ */

/**
 * ffmpeg/ffprobe 解析顺序：显式环境变量 → 仓内工位工具链 → PATH。
 * 配乐工位与调色工位共用 ffmpeg 静态构建（kit 受控下载），但目录独立、可分别 pin。
 */
export function resolveBinaries(env = process.env) {
  const here = path.dirname(new URL(import.meta.url).pathname);
  const bundled = path.resolve(here, "../../../../.workloom-tools/bgm");
  const pick = (explicit, name) => {
    if (explicit && fs.existsSync(explicit)) return explicit;
    const local = path.join(bundled, name);
    if (fs.existsSync(local)) return local;
    return name; // 交给 PATH 解析；找不到时由 runBin 抛 ffmpeg_not_installed
  };
  return {
    ffmpeg: pick(env.WORKLOOM_BGM_FFMPEG_PATH ?? env.FFMPEG_PATH, "ffmpeg"),
    ffprobe: pick(env.WORKLOOM_BGM_FFPROBE_PATH ?? env.FFPROBE_PATH, "ffprobe"),
  };
}

/* ============================ 进程执行 ============================ */

/**
 * 运行外部二进制并同时拿到 stdout / stderr（度量解析依赖 stderr 里的滤镜报告）。
 * @returns {Promise<{stdout: Buffer, stderr: string}>}
 */
export async function runBin(bin, args, { timeoutMs = 300_000, label = "ffmpeg" } = {}) {
  return await new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(bin, args, { stdio: ["ignore", "pipe", "pipe"] });
    } catch (error) {
      reject(new MeasureError(`${label} 无法启动：${error instanceof Error ? error.message : String(error)}`, "ffmpeg_not_installed"));
      return;
    }
    const stdout = [];
    const stderr = [];
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill("SIGKILL");
      reject(new MeasureError(`${label} 执行超时（${timeoutMs}ms）`, "timeout", true));
    }, timeoutMs);

    child.stdout.on("data", (chunk) => stdout.push(chunk));
    child.stderr.on("data", (chunk) => stderr.push(chunk));
    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const message = error instanceof Error ? error.message : String(error);
      reject(new MeasureError(`${label} 启动失败：${message}`, /ENOENT/.test(message) ? "ffmpeg_not_installed" : "engine_failed"));
    });
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const err = Buffer.concat(stderr).toString("utf8");
      if (code === 0) {
        resolve({ stdout: Buffer.concat(stdout), stderr: err });
        return;
      }
      reject(new MeasureError(
        `${label} 退出码 ${code}：${err.split("\n").filter(Boolean).slice(-3).join(" | ")}`,
        "ffmpeg_failed",
        true,
      ));
    });
  });
}

/** 二进制可用性探针（不抛异常，供 health 使用）。 */
export async function binaryVersion(bin, { timeoutMs = 20_000 } = {}) {
  try {
    const { stdout } = await runBin(bin, ["-hide_banner", "-version"], { timeoutMs, label: path.basename(bin) });
    return stdout.toString("utf8").split("\n")[0] ?? null;
  } catch {
    return null;
  }
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
    throw new MeasureError("ffprobe 返回无法解析的 JSON", "bad_media");
  }
  const streams = Array.isArray(parsed.streams) ? parsed.streams : [];
  const video = streams.find((s) => s.codec_type === "video") ?? null;
  const audio = streams.find((s) => s.codec_type === "audio") ?? null;
  if (!audio) throw new MeasureError("输入不含音频轨（配乐工位只处理带音轨的成片）", "bad_media");

  const parseRate = (value) => {
    if (typeof value !== "string" || !value.includes("/")) return null;
    const [a, b] = value.split("/").map(Number);
    return b ? Math.round((a / b) * 1000) / 1000 : null;
  };

  return {
    duration: Number(parsed.format?.duration ?? audio.duration ?? 0),
    sizeBytes: Number(parsed.format?.size ?? 0),
    formatName: parsed.format?.format_name ?? null,
    video: video
      ? {
        codec: video.codec_name ?? null,
        width: Number(video.width ?? 0),
        height: Number(video.height ?? 0),
        fps: parseRate(video.r_frame_rate),
      }
      : null,
    audio: {
      codec: audio.codec_name ?? null,
      channels: Number(audio.channels ?? 0),
      channelLayout: audio.channel_layout ?? null,
      sampleRate: Number(audio.sample_rate ?? 0),
      bitRate: audio.bit_rate ? Number(audio.bit_rate) : null,
    },
  };
}

/* ============================ 响度（EBU R128） ============================ */

/**
 * 从 ffmpeg stderr 里取 loudnorm 的测量 JSON。
 * 以 "input_i" 为锚点向前找块起点、向后做花括号配对，避免被日志里的其它大括号干扰。
 */
export function parseLoudnormJson(stderr) {
  const keyIndex = String(stderr).indexOf('"input_i"');
  if (keyIndex < 0) return null;
  const start = String(stderr).lastIndexOf("{", keyIndex);
  if (start < 0) return null;
  let depth = 0;
  for (let index = start; index < stderr.length; index += 1) {
    const char = stderr[index];
    if (char === "{") depth += 1;
    else if (char === "}") {
      depth -= 1;
      if (depth === 0) {
        try {
          return JSON.parse(stderr.slice(start, index + 1));
        } catch {
          return null;
        }
      }
    }
  }
  return null;
}

function num(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * EBU R128 测量（不改变音频）：integrated LUFS / true peak / LRA / 阈值。
 * @returns {Promise<{integratedLufs:number|null,truePeakDbtp:number|null,lra:number|null,thresholdLufs:number|null,targetOffset:number|null,raw:object|null}>}
 */
export async function measureLoudness(input, { bins = resolveBinaries(), targetLufs = -14, truePeak = -1.0 } = {}) {
  const { stderr } = await runBin(bins.ffmpeg, [
    "-hide_banner", "-nostats", "-v", "info",
    "-i", input,
    "-af", `loudnorm=I=${targetLufs}:TP=${truePeak}:LRA=11:print_format=json`,
    "-f", "null", "-",
  ], { label: "ffmpeg(loudnorm-measure)", timeoutMs: 600_000 });
  const json = parseLoudnormJson(stderr);
  if (!json) throw new MeasureError("loudnorm 未返回测量 JSON（无法核验响度）", "engine_failed", true);
  return {
    integratedLufs: num(json.input_i),
    truePeakDbtp: num(json.input_tp),
    lra: num(json.input_lra),
    thresholdLufs: num(json.input_thresh),
    targetOffset: num(json.target_offset),
    raw: json,
  };
}

/* ============================ 分段电平 ============================ */

/** 解析 volumedetect 报告的 mean/max（dBFS）。 */
export function parseVolumeDetect(stderr) {
  const mean = /mean_volume:\s*(-?\d+(?:\.\d+)?)\s*dB/.exec(stderr);
  const max = /max_volume:\s*(-?\d+(?:\.\d+)?)\s*dB/.exec(stderr);
  return {
    meanDb: mean ? Number(mean[1]) : null,
    maxDb: max ? Number(max[1]) : null,
  };
}

/**
 * 片段平均电平（dBFS）：可叠带通（人声/音乐频段各测一次）。
 * @param {{input:string,start?:number,duration?:number,band?:{highpass?:number,lowpass?:number}|null,bins?:object}} params
 */
export async function segmentMeanVolumeDb({ input, start = 0, duration = null, band = null, bins = resolveBinaries() }) {
  const chain = [];
  if (band?.highpass) chain.push(`highpass=f=${Number(band.highpass)}`);
  if (band?.lowpass) chain.push(`lowpass=f=${Number(band.lowpass)}`);
  chain.push("volumedetect");
  const args = ["-hide_banner", "-nostats", "-v", "info"];
  if (start > 0) args.push("-ss", String(start));
  if (duration !== null) args.push("-t", String(duration));
  args.push("-i", input, "-af", chain.join(","), "-f", "null", "-");
  const { stderr } = await runBin(bins.ffmpeg, args, { label: "ffmpeg(volumedetect)", timeoutMs: 300_000 });
  return { ...parseVolumeDetect(stderr), start, duration, band };
}

/* ============================ 频谱统计 ============================ */

/** 解析 aspectralstats 打印的逐帧 centroid / flatness。 */
export function parseSpectralStats(stderr) {
  const centroids = [];
  const flatnesses = [];
  for (const line of stderr.split("\n")) {
    const centroid = /lavfi\.aspectralstats\.\d+\.centroid=(-?\d+(?:\.\d+)?)/.exec(line);
    if (centroid) centroids.push(Number(centroid[1]));
    const flatness = /lavfi\.aspectralstats\.\d+\.flatness=(-?\d+(?:\.\d+)?)/.exec(line);
    if (flatness) flatnesses.push(Number(flatness[1]));
  }
  const avg = (list) => (list.length ? list.reduce((a, b) => a + b, 0) / list.length : null);
  return {
    frames: centroids.length,
    centroidHz: avg(centroids) === null ? null : Math.round(avg(centroids)),
    flatness: avg(flatnesses) === null ? null : Math.round(avg(flatnesses) * 100000) / 100000,
  };
}

/**
 * 片段的频谱画像（谱心 Hz / 谱平坦度）：人声≈低平坦度+中频集中，音乐≈更宽的谱心分布。
 * 判读只作为"像人声 / 像音乐"的辅助证据，不单独下结论（见 bgm-audio-layering 技能）。
 */
export async function segmentSpectralStats({ input, start = 0, duration = null, bins = resolveBinaries() }) {
  const args = ["-hide_banner", "-nostats", "-v", "info"];
  if (start > 0) args.push("-ss", String(start));
  if (duration !== null) args.push("-t", String(duration));
  args.push("-i", input, "-af", "aspectralstats=measure=centroid+flatness:win_size=2048,ametadata=print", "-f", "null", "-");
  const { stderr } = await runBin(bins.ffmpeg, args, { label: "ffmpeg(aspectralstats)", timeoutMs: 300_000 });
  return parseSpectralStats(stderr);
}

/* ============================ 人声频段活动段 ============================ */

/** 解析 silencedetect 的 silence_start / silence_end 序列。 */
export function parseSilenceDetect(stderr) {
  const starts = [];
  const ends = [];
  for (const line of stderr.split("\n")) {
    const start = /silence_start:\s*(-?\d+(?:\.\d+)?)/.exec(line);
    if (start) starts.push(Number(start[1]));
    const end = /silence_end:\s*(-?\d+(?:\.\d+)?)/.exec(line);
    if (end) ends.push(Number(end[1]));
  }
  return { starts, ends };
}

/**
 * 人声频段活动段（200–4000Hz 带通 + silencedetect）。
 *
 * 诚实口径：这是**频段能量活动检测**，不是语音识别。它能回答"这一段有没有人声/语音量级的能量"，
 * 不能回答"说了什么"；需要更精细的人声/伴奏分离时走 `bgmwrite.separate`。
 */
export async function detectVoiceBandSegments({
  input, duration = null, noiseDb = -38, minSilenceSec = 0.35, minSegmentSec = 0.25, bins = resolveBinaries(),
}) {
  const args = ["-hide_banner", "-nostats", "-v", "info", "-i", input];
  if (duration) args.push("-t", String(duration));
  args.push(
    "-af", `highpass=f=200,lowpass=f=4000,silencedetect=noise=${noiseDb}dB:d=${minSilenceSec}`,
    "-f", "null", "-",
  );
  const { stderr } = await runBin(bins.ffmpeg, args, { label: "ffmpeg(silencedetect)", timeoutMs: 300_000 });
  const { starts, ends } = parseSilenceDetect(stderr);

  const total = duration ?? (await probeMedia(input, { bins })).duration;
  // 非静音段 = 时间轴减去静音段（含首尾边界处理）
  const silences = [];
  for (let index = 0; index < starts.length; index += 1) {
    const from = starts[index];
    const to = ends[index] ?? total;
    if (to > from) silences.push([from, to]);
  }
  const active = [];
  let cursor = 0;
  for (const [from, to] of silences) {
    if (from > cursor) active.push([cursor, Math.min(from, total)]);
    cursor = Math.max(cursor, to);
  }
  if (cursor < total) active.push([cursor, total]);

  const segments = active
    .map(([from, to]) => ({ start: Math.round(from * 1000) / 1000, end: Math.round(to * 1000) / 1000 }))
    .map((segment) => ({ ...segment, duration: Math.round((segment.end - segment.start) * 1000) / 1000 }))
    .filter((segment) => segment.duration >= minSegmentSec);
  const activeSec = segments.reduce((sum, segment) => sum + segment.duration, 0);

  return {
    noiseDb,
    minSilenceSec,
    totalSec: Math.round(total * 1000) / 1000,
    activeSec: Math.round(activeSec * 1000) / 1000,
    activeRatio: total > 0 ? Math.round((activeSec / total) * 1000) / 1000 : 0,
    segments,
    silences: silences.map(([from, to]) => ({
      start: Math.round(from * 1000) / 1000,
      end: Math.round(to * 1000) / 1000,
      duration: Math.round((to - from) * 1000) / 1000,
    })),
    method: "band-activity",
    note: "频段能量活动检测（200–4000Hz），不是语音识别；只回答'有没有人声量级能量'",
  };
}

/* ============================ 剪辑点（卡点事实源） ============================ */

/** 解析 scene 检测打印的 pts_time / scene_score。 */
export function parseSceneScores(stderr) {
  const cuts = [];
  let currentTime = null;
  for (const line of stderr.split("\n")) {
    const time = /pts_time:(-?\d+(?:\.\d+)?)/.exec(line);
    if (time) currentTime = Number(time[1]);
    const score = /lavfi\.scene_score=(-?\d+(?:\.\d+)?)/.exec(line);
    if (score && currentTime !== null) cuts.push({ at: currentTime, score: Number(score[1]) });
  }
  return cuts;
}

/**
 * 默认阈值梯度：先按"硬切"口径取，取不到再逐级放宽（数值本仓自有，非通用常量）。
 * 低档位（0.02–0.05）是给"同色切/柔切"用的：它们必然带来更多候选，所以最终采用的阈值、
 * 候选数与分值都会写进回执，人工可据此判断这次"卡点"到底靠不靠谱。
 */
export const CUT_THRESHOLDS = [0.35, 0.22, 0.14, 0.08, 0.05, 0.03, 0.02];

/**
 * 剪辑点检测：一次扫描（阈值 0.08）+ 自适应分级筛选。
 *
 * 为什么要分级：真实素材的切点分值差异极大（跳切/同色切 → 0.1 量级，硬切 → 0.4+）。
 * 只认高档阈值会漏掉真实切点，只认低档阈值会把运动误判成切点。做法是取到"最高档里有结果"的那一档，
 * 并把最终采用的阈值与分值写进回执——宁可如实说"未检测到明显剪辑点"，也不假装对齐。
 */
export async function detectCuts({ input, thresholds = CUT_THRESHOLDS, bins = resolveBinaries(), maxCuts = 200, minGapSec = 0.4 }) {
  const probe = await probeMedia(input, { bins });
  if (!probe.video) return { cuts: [], threshold: null, method: "scene-score", note: "输入无视频轨，退回节拍网格对齐" };
  const floor = Math.min(...thresholds);
  const { stderr } = await runBin(bins.ffmpeg, [
    "-hide_banner", "-nostats", "-v", "info",
    "-i", input,
    "-filter_complex", `[0:v]select='gt(scene,${floor})',metadata=print[out]`,
    "-map", "[out]", "-an", "-f", "null", "-",
  ], { label: "ffmpeg(scene-detect)", timeoutMs: 600_000 });

  const raw = parseSceneScores(stderr)
    .filter((cut) => cut.at > 0.15 && cut.at < probe.duration - 0.15)
    .sort((a, b) => a.at - b.at);
  // 同一处切点常连续命中多帧：按 minGap 归并，保留分值最高的一帧
  const merged = [];
  for (const cut of raw) {
    const last = merged[merged.length - 1];
    if (last && cut.at - last.at < minGapSec) {
      if (cut.score > last.score) merged[merged.length - 1] = cut;
    } else {
      merged.push(cut);
    }
  }

  const picked = thresholds.find((threshold) => merged.some((cut) => cut.score >= threshold)) ?? null;
  const strong = (picked === null ? [] : merged.filter((cut) => cut.score >= picked))
    .slice(0, maxCuts)
    .map((cut) => ({ at: Math.round(cut.at * 1000) / 1000, score: Math.round(cut.score * 1000) / 1000 }));
  // 卡点对齐用**全部候选**（含低分候选，按分值加权）；strong 只用于对外陈述"哪些是硬切"。
  const cuts = merged.slice(0, maxCuts)
    .map((cut) => ({ at: Math.round(cut.at * 1000) / 1000, score: Math.round(cut.score * 1000) / 1000 }));
  return {
    cuts,
    strong,
    threshold: floor,
    strongThreshold: picked,
    candidates: merged.length,
    method: "scene-score（一次扫描 0.02 下限 + 同处多帧归并；strong 为自适应硬切档）",
    duration: probe.duration,
    note: cuts.length ? null : "未检测到明显剪辑点（可能是单镜到底），退回节拍网格",
  };
}

/* ============================ 证据图 ============================ */

/**
 * 前后波形对比图（上=原片音轨，下=配乐后音轨）：配乐交付证据包的一部分。
 */
export async function renderWaveformCompare({ before, after, output, bins = resolveBinaries(), width = 1000, height = 240 }) {
  await fsp.mkdir(path.dirname(output), { recursive: true });
  await runBin(bins.ffmpeg, [
    "-hide_banner", "-v", "error", "-y",
    "-i", before,
    "-i", after,
    "-filter_complex",
    `[0:a]showwavespic=s=${width}x${height}:colors=0x8899aa[top];`
    + `[1:a]showwavespic=s=${width}x${height}:colors=0x2f7d5b[bottom];`
    + "[top][bottom]vstack=inputs=2[out]",
    "-map", "[out]", "-frames:v", "1", output,
  ], { label: "ffmpeg(waveform)", timeoutMs: 300_000 });
  return { path: output, sha256: await sha256File(output) };
}

/** 响度/频段证据：把某一片段渲染成频谱图（人声遮挡排查用）。 */
export async function renderSpectrumPic({ input, output, start = 0, duration = 6, bins = resolveBinaries(), width = 1000, height = 400 }) {
  await fsp.mkdir(path.dirname(output), { recursive: true });
  await runBin(bins.ffmpeg, [
    "-hide_banner", "-v", "error", "-y",
    "-ss", String(start), "-t", String(duration), "-i", input,
    "-lavfi", `showspectrumpic=s=${width}x${height}:legend=1`,
    "-frames:v", "1", output,
  ], { label: "ffmpeg(spectrum)", timeoutMs: 300_000 });
  return { path: output, sha256: await sha256File(output) };
}

/* ============================ 工具 ============================ */

export async function sha256File(file) {
  return await new Promise((resolve, reject) => {
    const hash = createHash("sha256");
    const stream = fs.createReadStream(file);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("error", (error) => reject(new MeasureError(`读取失败：${error.message}`, "not_found")));
    stream.on("end", () => resolve(hash.digest("hex")));
  });
}

/** 临时工作目录（工位本地，随进程退出清理由调用方负责）。 */
export async function tempDir(prefix = "bgm-") {
  return await fsp.mkdtemp(path.join(os.tmpdir(), prefix));
}

export function round(value, digits = 2) {
  if (!Number.isFinite(value)) return null;
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}
