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
/**
 * EBU R128 响度实测。
 *
 * `maxSeconds`（可选）：只测前 N 秒。曲库打标面对的是几百上千首 3-5 分钟的长曲，
 * 逐首全解码会慢到不可用；前 3 分钟对整曲响度有代表性，且窗口会写进返回值（`windowNote`），
 * 不做"测了一段却声称整曲"的含糊表述。
 */
export async function measureLoudness(input, { bins = resolveBinaries(), targetLufs = -14, truePeak = -1.0, maxSeconds = null, startSec = null } = {}) {
  const args = ["-hide_banner", "-nostats", "-v", "info"];
  if (startSec) args.push("-ss", String(startSec));
  if (maxSeconds) args.push("-t", String(maxSeconds));
  args.push(
    "-i", input,
    /**
     * 只处理音轨：素材包里的 MP3 常带内嵌封面图（实测有 4 首的 PNG 封面已损坏，
     * 不隔离视频流会让 ffmpeg 在收尾阶段直接 "Conversion failed!"，整首曲子的响度就测不出来）。
     */
    "-vn", "-sn", "-dn", "-map", "0:a:0",
    "-af", `loudnorm=I=${targetLufs}:TP=${truePeak}:LRA=11:print_format=json`,
    "-f", "null", "-",
  );
  const { stderr } = await runBin(bins.ffmpeg, args, { label: "ffmpeg(loudnorm-measure)", timeoutMs: 600_000 });
  const json = parseLoudnormJson(stderr);
  if (!json) throw new MeasureError("loudnorm 未返回测量 JSON（无法核验响度）", "engine_failed", true);
  return {
    integratedLufs: num(json.input_i),
    truePeakDbtp: num(json.input_tp),
    lra: num(json.input_lra),
    thresholdLufs: num(json.input_thresh),
    targetOffset: num(json.target_offset),
    fromSec: startSec ?? 0,
    windowSec: maxSeconds ?? null,
    windowNote: maxSeconds
      ? `${startSec ? `从 ${startSec}s 起 ` : ""}只测 ${maxSeconds}s（代表段）`
      : "整曲实测",
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
  args.push("-i", input, "-vn", "-sn", "-dn", "-map", "0:a:0", "-af", "aspectralstats=measure=centroid+flatness:win_size=2048,ametadata=print", "-f", "null", "-");
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
    "-vn", "-sn", "-dn", "-map", "0:a:0",
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

/* ============================ 能量包络（结构识别的事实源） ============================ */

/**
 * 把音轨解码成低采样率单声道 PCM，用于在 JS 里算能量包络。
 *
 * 为什么不用滤镜输出：`astats` / `ebur128` 的逐帧日志语义随版本变化（实测 reset 行为不稳定），
 * 而"解码成 PCM 自己算"是一遍 ffmpeg + 纯 JS，确定、可复现、可单测，也不依赖具体滤镜实现。
 *
 * @returns {Promise<{pcm:Float32Array, sampleRate:number, durationSec:number}>}
 */
export async function decodePcm({ input, sampleRate = 8000, maxSeconds = 600, startSec = 0, bins = resolveBinaries() }) {
  const args = ["-hide_banner", "-v", "error"];
  if (startSec > 0) args.push("-ss", String(startSec));
  if (maxSeconds) args.push("-t", String(maxSeconds));
  args.push("-i", input, "-vn", "-ac", "1", "-ar", String(sampleRate), "-f", "s16le", "-");
  const { stdout } = await runBin(bins.ffmpeg, args, { label: "ffmpeg(decode-pcm)", timeoutMs: 600_000 });
  const frames = Math.floor(stdout.length / 2);
  const pcm = new Float32Array(frames);
  for (let index = 0; index < frames; index += 1) {
    pcm[index] = stdout.readInt16LE(index * 2) / 32768;
  }
  return { pcm, sampleRate, durationSec: frames / sampleRate };
}

/**
 * 能量包络：按窗口算 RMS（dBFS），并给出峰值/均值/分位。
 * @param {{pcm:Float32Array, sampleRate:number, windowSec?:number}} input
 */
export function energyEnvelope({ pcm, sampleRate, windowSec = 0.25 }) {
  const windowSize = Math.max(1, Math.round(windowSec * sampleRate));
  const windows = Math.max(1, Math.floor(pcm.length / windowSize));
  const db = [];
  const rms = [];
  for (let index = 0; index < windows; index += 1) {
    let sum = 0;
    const start = index * windowSize;
    for (let offset = 0; offset < windowSize; offset += 1) {
      const sample = pcm[start + offset] ?? 0;
      sum += sample * sample;
    }
    const value = Math.sqrt(sum / windowSize);
    rms.push(value);
    db.push(20 * Math.log10(Math.max(value, 1e-6)));
  }
  const sorted = [...db].sort((a, b) => a - b);
  const quantile = (q) => sorted[Math.min(sorted.length - 1, Math.max(0, Math.round((sorted.length - 1) * q)))] ?? null;
  const rd = (value) => (Number.isFinite(value) ? Math.round(value * 100) / 100 : null);
  return {
    windowSec,
    windows: db.length,
    durationSec: Math.round(db.length * windowSec * 1000) / 1000,
    db: db.map(rd),
    rms,
    peakDb: sorted.length ? rd(sorted[sorted.length - 1]) : null,
    avgDb: sorted.length ? rd(sorted.reduce((a, b) => a + b, 0) / sorted.length) : null,
    quantiles: {
      p10: rd(quantile(0.1)), p25: rd(quantile(0.25)), p50: rd(quantile(0.5)),
      p75: rd(quantile(0.75)), p90: rd(quantile(0.9)),
    },
  };
}

/** 起音强度（正向能量跃变）：结构分段与 BPM 估计共用。 */
export function onsetStrength(db) {
  const out = [];
  for (let index = 0; index < db.length; index += 1) {
    const previous = db[index - 1] ?? db[index];
    out.push(Math.max(0, db[index] - previous));
  }
  return out.map((value) => Math.round(value * 100) / 100);
}

/**
 * 由起音包络估计 BPM（自相关）：在 [60/maxBpm, 60/minBpm] 的滞后范围内找最强周期性。
 * 拿不到稳定周期（例：持续铺底 pad）时返回 confidence=low 与 null，绝不硬编一个 BPM。
 */
export function estimateBpmFromOnsets(onsets, { windowSec = 0.25, minBpm = 50, maxBpm = 190 } = {}) {
  if (!Array.isArray(onsets) || onsets.length < 8) return { bpm: null, confidence: "low", reason: "包络太短" };
  const mean = onsets.reduce((a, b) => a + b, 0) / onsets.length;
  const centered = onsets.map((value) => value - mean);
  // 浮点残差防线：恒定包络（持续铺底）算出来的 centered 是 1e-17 量级的噪声，
  // 不加这道判断会"估"出一个 240BPM 之类的假拍速（实测踩过）。
  const maxAbsCentered = centered.reduce((max, value) => Math.max(max, Math.abs(value)), 0);
  if (maxAbsCentered < 1e-9) {
    return { bpm: null, confidence: "low", reason: "包络无起伏（持续铺底/无起音）" };
  }
  const minLag = Math.max(1, Math.round(60 / maxBpm / windowSec));
  const maxLag = Math.min(centered.length - 2, Math.round(60 / minBpm / windowSec));
  if (maxLag <= minLag) return { bpm: null, confidence: "low", reason: "窗口粒度不足以分辨拍速" };
  let bestLag = null;
  let bestScore = 0;
  let energy = 0;
  for (let lag = minLag; lag <= maxLag; lag += 1) {
    let sum = 0;
    for (let index = lag; index < centered.length; index += 1) sum += centered[index] * centered[index - lag];
    const score = sum / (centered.length - lag);
    energy += Math.abs(score);
    if (score > bestScore) { bestScore = score; bestLag = lag; }
  }
  if (bestLag === null || energy === 0) return { bpm: null, confidence: "low", reason: "无稳定周期性" };
  const bpmOf = (lag) => Math.round((60 / (lag * windowSec)) * 10) / 10;
  const peakCoverage = Math.round((bestScore / (energy / (maxLag - minLag + 1))) * 100) / 100;
  return {
    bpm: bpmOf(bestLag),
    confidence: peakCoverage >= 3 ? "high" : peakCoverage >= 1.6 ? "medium" : "low",
    autocorrPeak: peakCoverage,
    candidates: [bestLag, Math.round(bestLag / 2), bestLag * 2]
      .filter((lag) => lag >= minLag && lag <= maxLag)
      .map(bpmOf),
    lagWindows: bestLag,
  };
}

/** 分位数（结构分段的阈值来源）。 */
function percentile(values, q) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.round((sorted.length - 1) * q)))];
}

/**
 * 结构分段（**规则式，不是深度学习**——这一点必须如实陈述）。
 *
 * 做法：能量包络按分位数切 低/中/高 三档 → 合并成连续段 → 依据位置 + 能量档 + 走向 + 起音密度贴标签：
 * - 开头低能段 = intro；结尾低能段 = outro；高能段 = drop
 * - 高能段前面持续上行的那段 = build；高能段之后的低能段 = breakdown；其余中能段 = verse
 * - 全曲能量平坦（动态 < 6dB）= 单段 flat（此时"高潮"不存在，选段退化为"代表性片段"）
 */
export function classifySegments({ envelope, onsets = null, minSegmentSec = 3 }) {
  const db = envelope?.db ?? [];
  const windowSec = envelope?.windowSec ?? 0.25;
  if (!db.length) return { segments: [], method: "rule-based-percentile", note: "无包络数据" };
  /**
   * 先平滑再分档：真实曲子里每个小节都有强弱起伏（1–2 窗的瞬时凹点），
   * 不平滑会把一个副歌切成几十段"高-低-高"（实测：150s 曲目出 120+ 段，段标签全乱）。
   * 平滑窗取 2.5s（乐句级），随后再对标签做多数滤波（窗宽 = minSegmentSec）去掉残留抖动。
   */
  const smoothWindows = Math.max(1, Math.round(2.5 / windowSec));
  const smoothed = db.map((_, index) => {
    const from = Math.max(0, index - Math.floor(smoothWindows / 2));
    const to = Math.min(db.length, from + smoothWindows);
    const slice = db.slice(from, to);
    return slice.reduce((a, b) => a + b, 0) / slice.length;
  });
  const p25 = percentile(smoothed, 0.25);
  const p75 = percentile(smoothed, 0.75);
  const dynamics = (percentile(smoothed, 0.95) ?? 0) - (percentile(smoothed, 0.05) ?? 0);
  const p10 = percentile(smoothed, 0.1);
  const p90 = percentile(smoothed, 0.9);
  const span = Math.max(1e-6, (p90 ?? 0) - (p10 ?? 0));
  const rd = (value) => (Number.isFinite(value) ? Math.round(value * 100) / 100 : null);
  const densityOf = (slice) => (slice.length ? rd(slice.reduce((a, b) => a + b, 0) / slice.length) : null);

  if (dynamics < 6) {
    return {
      segments: [{
        id: "seg-1",
        type: "flat",
        level: "mid",
        startSec: 0,
        endSec: envelope.durationSec,
        durationSec: envelope.durationSec,
        avgDb: envelope.avgDb,
        peakDb: envelope.peakDb,
        riseDb: 0,
        onsetDensity: onsets ? densityOf(onsets) : null,
      }],
      method: "rule-based-percentile",
      dynamicsDb: rd(dynamics),
      thresholds: {
        p25: rd(p25),
        p75: rd(p75),
        levelBands: { lowBelow: rd(p10 + span * 0.35), highAbove: rd(p10 + span * 0.7) },
      },
      note: "全曲能量平坦（动态 <6dB）：没有明显高潮段，选段按「代表性片段」处理",
    };
  }

  /**
   * 分档用**相对动态范围**而不是固定分位数：真实歌曲里"副歌占一半时长"很常见，
   * 固定 p75 会把整段副歌切成"只有最响的 25% 算高能"，导致高潮段被标成 verse（实测踩过）。
   * 口径：(db - p10) / (p90 - p10) → <0.35 低能 / ≥0.7 高能 / 其余中能。
   */
  const rawLevel = smoothed.map((value) => {
    const normalized = ((value - p10) / span);
    if (normalized < 0.35) return "low";
    if (normalized >= 0.7) return "high";
    return "mid";
  });
  // 标签多数滤波：窗宽 = minSegmentSec，去掉"高-低-高"里的瞬时夹层
  const filterHalf = Math.max(1, Math.round(minSegmentSec / windowSec / 2));
  const level = rawLevel.map((_, index) => {
    const from = Math.max(0, index - filterHalf);
    const to = Math.min(rawLevel.length, index + filterHalf + 1);
    const counts = { low: 0, mid: 0, high: 0 };
    for (let cursor = from; cursor < to; cursor += 1) counts[rawLevel[cursor]] += 1;
    return Object.entries(counts).sort((a, b) => b[1] - a[1])[0][0];
  });
  const raw = [];
  for (let index = 0; index < level.length; index += 1) {
    const last = raw[raw.length - 1];
    if (last && last.level === level[index]) last.endWindow = index;
    else raw.push({ level: level[index], startWindow: index, endWindow: index });
  }
  const minWindows = Math.max(1, Math.round(minSegmentSec / windowSec));
  const merged = [];
  for (const segment of raw) {
    const last = merged[merged.length - 1];
    const length = segment.endWindow - segment.startWindow + 1;
    if (last && (length < minWindows || segment.level === "mid")) {
      last.endWindow = segment.endWindow;
      // 并段后按"占多数的档位"重算该段档位：否则整段会继承第一段的档位（实测把副歌标成 verse）
      const counts = { low: 0, mid: 0, high: 0 };
      for (let cursor = last.startWindow; cursor <= last.endWindow; cursor += 1) counts[level[cursor]] += 1;
      last.level = Object.entries(counts).sort((a, b) => b[1] - a[1])[0][0];
    } else {
      merged.push({ ...segment });
    }
  }

  const segments = merged.map((segment, index) => {
    const slice = db.slice(segment.startWindow, segment.endWindow + 1);
    const startSec = Math.round(segment.startWindow * windowSec * 1000) / 1000;
    const endSec = Math.round((segment.endWindow + 1) * windowSec * 1000) / 1000;
    const onsetSlice = onsets ? onsets.slice(segment.startWindow, segment.endWindow + 1) : [];
    return {
      id: `seg-${index + 1}`,
      level: segment.level,
      startSec,
      endSec,
      durationSec: Math.round((endSec - startSec) * 1000) / 1000,
      avgDb: rd(slice.reduce((a, b) => a + b, 0) / slice.length),
      peakDb: rd(Math.max(...slice)),
      riseDb: slice.length > 2 ? rd(slice[slice.length - 1] - slice[0]) : 0,
      onsetDensity: densityOf(onsetSlice),
    };
  });

  for (let index = 0; index < segments.length; index += 1) {
    const segment = segments[index];
    const previous = segments[index - 1];
    const next = segments[index + 1];
    if (segment.level === "high") segment.type = "drop";
    else if (segment.level === "low") {
      if (!previous) segment.type = "intro";
      else if (!next) segment.type = "outro";
      else if (previous.type === "drop") segment.type = "breakdown";
      else segment.type = "verse";
    } else {
      segment.type = next && next.level === "high" && segment.riseDb > 1.5 ? "build" : "verse";
    }
  }

  // 收尾修正：末段若仍是高能段，把最后 15% 拆成 outro，保证有自然收束点
  const last = segments[segments.length - 1];
  if (last && last.type === "drop" && last.durationSec > minSegmentSec * 2) {
    const outroStart = Math.round((last.endSec - Math.max(2, last.durationSec * 0.15)) * 1000) / 1000;
    const outroSlice = db.slice(Math.max(0, Math.round(outroStart / windowSec)));
    const outroOnsetSlice = onsets ? onsets.slice(Math.max(0, Math.round(outroStart / windowSec))) : [];
    segments.push({
      id: `seg-${segments.length + 1}`,
      type: "outro",
      level: "mid",
      startSec: outroStart,
      endSec: last.endSec,
      durationSec: Math.round((last.endSec - outroStart) * 1000) / 1000,
      avgDb: outroSlice.length ? rd(outroSlice.reduce((a, b) => a + b, 0) / outroSlice.length) : null,
      peakDb: outroSlice.length ? rd(Math.max(...outroSlice)) : null,
      riseDb: last.riseDb,
      onsetDensity: outroOnsetSlice.length
        ? rd(outroOnsetSlice.reduce((a, b) => a + b, 0) / outroOnsetSlice.length)
        : null,
    });
    last.endSec = outroStart;
    last.durationSec = Math.round((outroStart - last.startSec) * 1000) / 1000;
  }
  return {
    segments,
    method: "rule-based-percentile",
    dynamicsDb: rd(dynamics),
    thresholds: {
      p25: rd(p25),
      p75: rd(p75),
      levelBands: { lowBelow: rd(p10 + span * 0.35), highAbove: rd(p10 + span * 0.7) },
    },
    note: null,
  };
}

/**
 * 段落打分与节拍吸附：给每段算"当高潮用 / 当铺垫用"的分，并把边界吸到节拍网格上
 * （边界落在拍点，裁切就不会切在乐句中间）。
 */
export function scoreSegments({ segments, bpm = null, prefer = "climax", durationSec = null }) {
  const beatSec = Number.isFinite(bpm) && bpm > 0 ? 60 / bpm : null;
  const snap = (time) => {
    const value = beatSec ? Math.round(time / beatSec) * beatSec : time;
    const clamped = Number.isFinite(durationSec) ? Math.min(Math.max(0, value), durationSec) : Math.max(0, value);
    return Math.round(clamped * 1000) / 1000;
  };
  const rd = (value) => (Number.isFinite(value) ? Math.round(value * 1000) / 1000 : null);
  // 用**段平均能量**作主依据（峰值受单帧瞬态影响大，实测会把带切点的安静段误判成高潮），
  // 峰值只作为小幅加成；起音密度给"有推动力"的段加分。
  const maxAvg = Math.max(...segments.map((segment) => segment.avgDb ?? -60));
  const candidates = segments.map((segment) => {
    const energyScore = Math.max(0, Math.min(1, ((segment.avgDb ?? -60) - (maxAvg - 12)) / 12));
    const peakScore = Math.max(0, Math.min(1, ((segment.peakDb ?? -60) - (maxAvg - 6)) / 6));
    const lengthScore = Math.min(1, (segment.durationSec ?? 0) / 12);
    const onsetScore = Math.min(1, (segment.onsetDensity ?? 0) / 3);
    const calmScore = Math.max(0, 1 - energyScore);
    const score = prefer === "climax"
      ? energyScore * 0.6 + lengthScore * 0.2 + onsetScore * 0.15 + peakScore * 0.05
      : calmScore * 0.5 + lengthScore * 0.3 + (1 - onsetScore) * 0.2;
    const startSec = snap(segment.startSec);
    const endSec = snap(segment.endSec);
    return {
      id: segment.id,
      type: segment.type,
      startSec,
      endSec,
      durationSec: Math.round((endSec - startSec) * 1000) / 1000,
      avgDb: segment.avgDb,
      peakDb: segment.peakDb,
      onsetDensity: segment.onsetDensity,
      score: rd(score),
    };
  });
  candidates.sort((a, b) => b.score - a.score);
  return { prefer, beatSec: beatSec ? Math.round(beatSec * 1000) / 1000 : null, candidates };
}

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
