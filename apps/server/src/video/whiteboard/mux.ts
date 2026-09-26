/**
 * video/whiteboard/mux.ts —— 白板成片混流（T-2026-0926-0020）
 *
 * 为什么必须有这一环（规格书 §2.3 只写了一句"两遍 loudnorm"，实测不足）：
 * 上游渲染器 `render_stream_whiteboard.py` 用 `cv2.VideoWriter(mp4v)` 写视频、再转 H.264，
 * **全程不写音轨**；`merge_scenes.py` 也只是视频轨拼接。因此"白板引擎的产物"是**无声片**，
 * 配音必须由接入方自己混进来，否则交付的就是一条没声音的片子。
 *
 * 本模块做三件事：
 *   ① 两遍 loudnorm（先测量、再按测量值归一化）——与仓内 `full-chain-film.mts` 的
 *      「响度是交付项」口径一致，默认目标 I=-16 LUFS（`WHITEBOARD_VOICE_LUFS` 可覆盖）；
 *   ② 视频轨 `-c:v copy`（不重编码：白板片是逐帧生成的，重编码只会白掉画质）；
 *   ③ 音频 `apad` 补到画面长度 + `-shortest`：配音短于画面时补静音，长于画面时以画面为准
 *      （正常情况下两者由 narration.ts 的时间轴铺满保证一致，这里是兜底）。
 */
import { execFile } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { WhiteboardEngineError, whiteboardEnv } from "./engine.js";

const execFileAsync = promisify(execFile);

export interface LoudnormMeasurement {
  input_i: string;
  input_tp: string;
  input_lra: string;
  input_thresh: string;
  target_offset: string;
  normalizedI: number | null;
}

async function ffmpeg(args: string[], timeoutMs: number, ffmpegBin: string): Promise<{ stdout: string; stderr: string }> {
  try {
    const { stdout, stderr } = await execFileAsync(ffmpegBin, args, {
      timeout: timeoutMs, maxBuffer: 32 * 1024 * 1024, killSignal: "SIGKILL",
    });
    return { stdout, stderr };
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string; message?: string; killed?: boolean };
    if (e.killed) throw new WhiteboardEngineError(`ffmpeg 超时被终止：${args.slice(0, 6).join(" ")}`);
    throw new WhiteboardEngineError(
      `ffmpeg 失败：${args.slice(0, 6).join(" ")}`,
      `${e.stderr ?? e.stdout ?? e.message ?? ""}`.trim().slice(-1200),
    );
  }
}

/** 第一遍：只测量，不改音频（`-f null` 不出文件） */
export async function measureLoudness(
  audioPath: string,
  opts: { env?: NodeJS.ProcessEnv; targetLufs?: number } = {},
): Promise<LoudnormMeasurement> {
  const cfg = whiteboardEnv(opts.env);
  const target = opts.targetLufs ?? Number(opts.env?.WHITEBOARD_VOICE_LUFS ?? "-16");
  const run = await ffmpeg([
    "-hide_banner", "-nostats", "-i", audioPath,
    "-af", `loudnorm=I=${target}:TP=-1.5:LRA=11:print_format=json`,
    "-f", "null", "-",
  ], 10 * 60_000, cfg.ffmpeg);
  // loudnorm 的 JSON 打在 stderr，形如 { "input_i" : "-23.13", ... }
  const match = /\{[\s\S]*"input_i"[\s\S]*\}/.exec(run.stderr);
  if (!match) {
    throw new WhiteboardEngineError(
      "响度测量失败：ffmpeg 没有输出 loudnorm 读数",
      run.stderr.trim().slice(-600),
    );
  }
  const raw = JSON.parse(match[0]) as Record<string, string>;
  const value = Number(raw.input_i);
  return {
    input_i: raw.input_i ?? "",
    input_tp: raw.input_tp ?? "",
    input_lra: raw.input_lra ?? "",
    input_thresh: raw.input_thresh ?? "",
    target_offset: raw.target_offset ?? "",
    normalizedI: Number.isFinite(value) ? value : null,
  };
}

export interface MuxOptions {
  /** 无声白板片（上游渲染器产物） */
  silentVideo: string;
  /** 配音整轨（narration.ts 产物） */
  narrationWav: string;
  output: string;
  /** 可选 SRT 软字幕轨（不烧字：母版保持干净，字幕作为可开关轨道） */
  srtPath?: string;
  targetLufs?: number;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
}

export interface MuxResult {
  output: string;
  videoSeconds: number;
  audioSeconds: number;
  loudnessBefore: number | null;
  loudnessAfter: number | null;
  /** 视频与音频时长差（秒）；绝对值 > 0.2s 视为异常，调用方需显式对待 */
  avDriftSec: number;
}

/** 两遍 loudnorm + 混流；输出 H.264 + AAC 交付母版（视频轨 copy，不重编码） */
export async function muxWhiteboardFilm(opts: MuxOptions): Promise<MuxResult> {
  const env = opts.env ?? process.env;
  const cfg = whiteboardEnv(env);
  const target = opts.targetLufs ?? Number(env.WHITEBOARD_VOICE_LUFS ?? "-16");
  for (const f of [opts.silentVideo, opts.narrationWav]) {
    if (!existsSync(f)) throw new WhiteboardEngineError(`混流输入缺失：${f}`);
  }
  mkdirSync(dirname(opts.output), { recursive: true });

  // ① 第一遍：测量
  const before = await measureLoudness(opts.narrationWav, { env, targetLufs: target });
  // ② 第二遍：按测量值归一化（linear=true 在读数可信时走线性增益，避免动态压缩改变音色）
  const normalized = join(dirname(opts.output), "narration.norm.wav");
  await ffmpeg([
    "-y", "-v", "error", "-i", opts.narrationWav,
    "-af", `loudnorm=I=${target}:TP=-1.5:LRA=11:linear=true:`
      + `measured_I=${before.input_i}:measured_TP=${before.input_tp}:`
      + `measured_LRA=${before.input_lra}:measured_thresh=${before.input_thresh}:`
      + `offset=${before.target_offset}:print_format=summary`,
    "-ar", "48000", "-ac", "2", "-c:a", "pcm_s16le", normalized,
  ], 10 * 60_000, cfg.ffmpeg);
  const after = await measureLoudness(normalized, { env, targetLufs: target }).catch(() => null);

  // ③ 混流：视频 copy + 音频 apad 到画面长度（防止尾帧无声）+ 可选软字幕轨
  const args = [
    "-y", "-v", "error",
    "-i", opts.silentVideo,
    "-i", normalized,
    ...(opts.srtPath ? ["-i", opts.srtPath] : []),
    "-filter_complex", "[1:a]apad[a]",
    "-map", "0:v:0", "-map", "[a]",
    ...(opts.srtPath ? ["-map", "2:0", "-c:s", "mov_text", "-metadata:s:s:0", "language=chi"] : []),
    "-c:v", "copy", "-c:a", "aac", "-b:a", "192k", "-ar", "48000", "-ac", "2",
    "-shortest", "-movflags", "+faststart",
    opts.output,
  ];
  await ffmpeg(args, opts.timeoutMs ?? 15 * 60_000, cfg.ffmpeg);
  if (!existsSync(opts.output)) throw new WhiteboardEngineError(`混流未产出文件：${opts.output}`);

  const videoSeconds = await probeSeconds(opts.silentVideo, cfg.ffprobe);
  const audioSeconds = await probeSeconds(normalized, cfg.ffprobe);
  return {
    output: opts.output,
    videoSeconds,
    audioSeconds,
    loudnessBefore: before.normalizedI,
    loudnessAfter: after?.normalizedI ?? null,
    avDriftSec: Math.round((videoSeconds - audioSeconds) * 1000) / 1000,
  };
}

/** 时长探测（交付对账面：音画不同长要在报告里显式暴露，不能"看着差不多"） */
export async function probeSeconds(file: string, ffprobe = "ffprobe"): Promise<number> {
  try {
    const { stdout } = await execFileAsync(ffprobe, [
      "-v", "error", "-show_entries", "format=duration", "-of", "default=nw=1:nk=1", file,
    ], { timeout: 60_000 });
    const value = Number(stdout.trim());
    return Number.isFinite(value) ? value : 0;
  } catch {
    return 0;
  }
}

/** 探测音轨是否存在（混流前的白板片应当**没有**音轨——这条也是自检项） */
export async function hasAudioStream(file: string, ffprobe = "ffprobe"): Promise<boolean> {
  try {
    const { stdout } = await execFileAsync(ffprobe, [
      "-v", "error", "-select_streams", "a", "-show_entries", "stream=index",
      "-of", "csv=p=0", file,
    ], { timeout: 60_000 });
    return stdout.trim().length > 0;
  } catch {
    return false;
  }
}
