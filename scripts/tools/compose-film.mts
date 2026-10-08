#!/usr/bin/env tsx
/**
 * 成片拼接工具（2026-09-21）——逐镜产物 → 一条竖版母版（可选标题/字幕 + 调色）。
 *
 * 为什么需要：Ark Seedance 单条上限 15s（媒体目录 limits），30 秒短片必须由多镜拼接；
 * 逐镜产物的编码参数（分辨率/帧率/音轨）各自不同，直接 concat 会花屏/丢音。
 *
 * 三段式（每段都可单独复跑）：
 *   ① 完整源归一化：只转换实际不同的画幅/帧率，保留完整区间及可用原声
 *   ② 拼接：兼容视频包直接拷贝；不同编码参数用完整帧无损编码拼接
 *   ③ 收口：淡入淡出 + 标题/字幕烧字（可选）→ 母版
 *   ④ 调色：执行显式固定配方，默认不调色；成功素材不做渲后品质投票。
 *
 * 用法：
 *   pnpm exec tsx scripts/tools/compose-film.mts \
 *     --clips a.mp4,b.mp4,... --out outputs/nanyuan-master-30s.mp4 \
 *     [--width 1080 --height 1920 --fps 30] [--fade 0.5] \
 *     [--title "苏州南园宾馆"] [--subtitle "唯一可以入住的苏州园林"] \
 *     [--color grade --grade-profile natural --grade-intensity 0.55] [--graded-out outputs/nanyuan-graded-30s.mp4] \
 *     [--keep-temp] [--json]
 */
import { execFileSync } from "node:child_process";
import { createReadStream, existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  buildCutAudioStep,
} from "../../packages/video-studio/src/av-sync.js";

const REPO_ROOT = resolve(import.meta.dirname ?? process.cwd(), "../..");
const FFMPEG = process.env.WL_FFMPEG ?? "ffmpeg";
const FFPROBE = process.env.WL_FFPROBE ?? "ffprobe";
const FONT_FILE = process.env.WL_FONT_FILE ?? "/System/Library/Fonts/STHeiti Medium.ttc";

function arg(name: string, fallback = ""): string {
  const i = process.argv.indexOf(name);
  return i >= 0 ? (process.argv[i + 1] ?? fallback) : fallback;
}
const flag = (name: string) => process.argv.includes(name);
const abs = (p: string) => (isAbsolute(p) ? p : resolve(REPO_ROOT, p));

function run(bin: string, args: string[], env?: NodeJS.ProcessEnv): string {
  try {
    return execFileSync(bin, args, {
      encoding: "utf8",
      maxBuffer: 16 * 1024 * 1024,
      stdio: ["ignore", "pipe", "pipe"],
      ...(env ? { env } : {}),
    });
  } catch (err) {
    const e = err as { stderr?: string; message?: string };
    throw new Error(`${bin} 失败：${(e.stderr ?? e.message ?? "").toString().slice(-800)}`);
  }
}

async function sha256File(file: string): Promise<string> {
  const digest = createHash("sha256");
  for await (const chunk of createReadStream(file)) digest.update(chunk);
  return digest.digest("hex");
}

export function probeDuration(file: string): number {
  const out = run(FFPROBE, ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", file]).trim();
  return Number(out) || 0;
}

const clipsArg = arg("--clips");
if (!clipsArg) throw new Error("需要 --clips a.mp4,b.mp4（按成片顺序）");
const clips = clipsArg.split(",").map((c) => abs(c.trim())).filter(Boolean);
for (const clip of clips) {
  if (!existsSync(clip)) throw new Error(`镜头产物不存在：${clip}`);
}
const out = abs(arg("--out", "outputs/film-master.mp4"));
const width = Number(arg("--width", "1080"));
const height = Number(arg("--height", "1920"));
const fps = Number(arg("--fps", "30"));
const fade = Number(arg("--fade", "0.5"));
if (![width, height].every(n => Number.isSafeInteger(n) && n > 0 && n <= 16384 && n % 2 === 0)
  || !Number.isFinite(fps) || fps <= 0 || fps > 240) throw new Error("COMPOSE_EXPORT_SETTINGS_INVALID");
const requestedDurations = arg("--durations").split(",").filter(Boolean).map(Number);
if (requestedDurations.length && (requestedDurations.length !== clips.length
  || requestedDurations.some(n => !Number.isFinite(n) || n <= 0 || n > 7200))) throw new Error("COMPOSE_DURATIONS_INVALID");
const inputBindings = await Promise.all(clips.map(async path => ({ path, sha256: await sha256File(path) })));
interface SourceMedia {
  hasAudio: boolean; duration: number; videoFrames: number; fps: number; width: number; height: number;
  audioCodec: string | null; audioSampleRate: number; audioChannels: number; audioDurationSec: number;
}
const localMediaInput = (): string[] => ["-protocol_whitelist", "file,pipe", "-format_whitelist", "mov,matroska,avi,mpegts,wav,mp3,aac,flac,ogg,aiff"];
function sourceMedia(file: string): SourceMedia {
  const metadata = JSON.parse(run(FFPROBE, ["-v", "error", ...localMediaInput(), "-count_frames", "-show_streams", "-show_format", "-of", "json", file])) as {
    streams?: Array<{ codec_type?: string; codec_name?: string; duration?: string; nb_read_frames?: string;
      avg_frame_rate?: string; width?: number; height?: number; sample_rate?: string; channels?: number }>; format?: { duration?: string };
  };
  const videos = metadata.streams?.filter(stream => stream.codec_type === "video") ?? [], video = videos[0];
  const audio = metadata.streams?.find(stream => stream.codec_type === "audio");
  const [numerator, denominator] = String(video?.avg_frame_rate ?? "").split("/").map(Number);
  const sourceFps = Number(numerator) / Number(denominator), frames = Number(video?.nb_read_frames);
  const duration = Number(video?.duration ?? metadata.format?.duration);
  if (videos.length !== 1 || !video || !Number.isFinite(sourceFps) || sourceFps <= 0 || !Number.isSafeInteger(frames) || frames <= 0
    || !Number.isSafeInteger(video.width) || !Number.isSafeInteger(video.height) || !Number.isFinite(duration) || duration <= 0
    || Math.abs(duration - frames / sourceFps) > 1e-6) throw new Error(`COMPOSE_SOURCE_UNREADABLE: ${file}`);
  return { hasAudio: Boolean(audio), duration: frames / sourceFps, videoFrames: frames, fps: sourceFps, width: video.width!, height: video.height!,
    audioCodec: audio?.codec_name ?? null, audioSampleRate: audio ? Number(audio.sample_rate) : 0,
    audioChannels: audio ? Number(audio.channels) : 0, audioDurationSec: audio ? Number(audio.duration ?? metadata.format?.duration) : 0 };
}
function picturePacketSignature(file: string): string {
  const metadata = JSON.parse(run(FFPROBE, ["-v", "error", ...localMediaInput(), "-select_streams", "v:0", "-show_streams", "-show_data", "-of", "json", file])) as {
    streams?: Array<Record<string, unknown>>;
  };
  const video = metadata.streams?.[0];
  if (!video || typeof video.codec_name !== "string" || typeof video.time_base !== "string" || typeof video.extradata !== "string")
    throw new Error(`COMPOSE_PACKET_PARAMETERS_UNAVAILABLE: ${file}`);
  // FFmpeg's concat demuxer requires matching codec/time-base parameters. Equal
  // fps and canvas alone do not make H.264 SPS/PPS and frame reordering compatible.
  return JSON.stringify([video.codec_name, video.codec_tag_string, video.profile, video.level, video.time_base,
    video.pix_fmt, video.sample_aspect_ratio, video.field_order, video.has_b_frames, video.extradata]);
}
/**
 * 逐刀转场（2026-09-25 新增）：
 * 早先本工具只做 `concat`（纯硬切）+ 首尾淡入淡出，`--fade` 并不作用在刀口上——
 * 于是"硬切 0.12s + 甩镜"这类口径在成片里根本没发生（真机复核实锤）。
 * 现在：`--transition <xfade 名>` + `--transition-duration <秒>` 时，用 xfade/acrossfade
 * **在每一刀**做转场（`hblur` ≈ 甩镜拖影、`smoothleft` ≈ 横向擦除，按片子的剪辑风格选）；
 * 不传则维持纯硬切（默认行为不变）。
 */
const transition = arg("--transition");
const transitionDuration = Number(arg("--transition-duration", "0"));
/**
 * 只在指定刀口做转场（`--transition-at 2,3,4,5` = 第 2/3/4/5 个入点做转场，其余硬切）。
 * 为什么要能挑刀口：xfade 每做一刀就吃掉 transitionDuration 的总时长。
 * 六镜各 5s 的片子若满刀做 0.18s 转场，总长会从 30.1s 掉到 29.2s（真机实测打回），
 * 而"人物口播 → 地标"这类刀口本来就该硬切——只在快剪段做甩镜转场，时长与节奏都更稳。
 */
const transitionAt = arg("--transition-at")
  .split(",")
  .map((value) => Number(value.trim()))
  .filter((value) => Number.isFinite(value) && value > 0);
/**
 * 时长补偿（2026-09-25）：逐刀转场会按刀数吃掉总时长（6 镜 @0.18s × 4 刀 = 0.72s）。
 * 传 `--retime-to <秒>` 时，整片按 `目标/实际` 做一次**统一微调**（视频 setpts + 音频同倍率 atempo），
 * 把总长对齐到目标（2% 量级的微调肉眼不可辨），而不是靠截断/冻结帧——后者会在片尾留静帧。
 */
const retimeTo = Number(arg("--retime-to", "0"));
const title = arg("--title");
const subtitle = arg("--subtitle");
/**
 * 调色模式（2026-09-22 修正）：
 *   none（默认）= 不调色；grade 和历史 best 标签均执行显式固定配方。
 * 成功源片不再经过候选画质打分或择优投票；实际处理失败仍然报错。
 */
const colorMode = arg("--color", "none");
const gradeProfile = arg("--grade-profile", "natural");
const gradeLut = arg("--grade-lut");
const gradeIntensity = arg("--grade-intensity", "0.55");
const gradedOut = arg("--graded-out");
const nativeClock = flag("--native-clock");
if (nativeClock && (fade !== 0 || transition || transitionDuration !== 0 || retimeTo !== 0 || title || subtitle || colorMode !== "none"))
  throw new Error("STANDARD_NATIVE_COMPOSE_OPTIONS_INVALID: native clock composition only concatenates complete original shots");

mkdirSync(dirname(out), { recursive: true });
const inputCanonicalPaths = clips.map(file => realpathSync(file));
const outputCanonicalParentPath = join(realpathSync(dirname(out)), basename(out));
if (inputCanonicalPaths.includes(outputCanonicalParentPath)
  || existsSync(out) && inputCanonicalPaths.includes(realpathSync(out))) throw new Error("COMPOSE_SOURCE_OVERWRITE_FORBIDDEN");
const temp = mkdtempSync(join(tmpdir(), "wl-compose-"));
console.log(`拼接 ${clips.length} 个完整镜头 → ${width}x${height} @${fps}fps（临时目录 ${temp}）`);

/* ---------- ① 仅归一化画幅/帧率；不拿名义秒数裁片或补尾帧 ---------- */
const normalized: string[] = [];
const pictureSources: string[] = [];
const pictureSignatures: string[] = [];
const shotFrames: number[] = [];
const sourceBindings: Array<{ path: string; sha256: string; source: SourceMedia; normalized: SourceMedia & { path: string }; normalizationPerformed: boolean }> = [];
clips.forEach((clip, index) => {
  const metadata = sourceMedia(clip);
  const normalizePicture = metadata.width !== width || metadata.height !== height || Math.abs(metadata.fps - fps) > 1e-8;
  let target = clip;
  if (normalizePicture) {
    target = join(temp, `norm-${String(index).padStart(2, "0")}.mp4`);
    run(FFMPEG, ["-v", "error", "-xerror", "-nostdin", "-y", ...localMediaInput(), "-i", clip,
      "-map", "0:v:0", "-map", "0:a:0?",
      "-vf", `scale=${width}:${height}:force_original_aspect_ratio=decrease,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2:color=black,setsar=1,fps=${fps}:start_time=0:round=up:eof_action=pass`,
      "-c:v", "libx264", "-preset", "medium", "-crf", "18", "-pix_fmt", "yuv420p", "-c:a", "copy", "-movflags", "+faststart", target]);
  }
  const actual = normalizePicture ? sourceMedia(target) : metadata;
  if (actual.width !== width || actual.height !== height || Math.abs(actual.fps - fps) > 1e-8)
    throw new Error(`COMPOSE_NORMALIZATION_FAILED: ${basename(clip)}`);
  // Read actual output frames. This is evidence of the encoding result, never a
  // prediction dressed as a measured clock or a quality score on the original.
  normalized.push(target); shotFrames.push(actual.videoFrames);
  const picture = join(temp, `picture-${String(index).padStart(2, "0")}.mp4`);
  // Strip audio before the concat demuxer establishes its first packet origin.
  // Otherwise AAC's negative priming packet shifts the copied picture start and
  // changes MP4's average frame clock even when every source picture frame exists.
  run(FFMPEG, ["-v", "error", "-xerror", "-nostdin", "-y", "-i", target, "-map", "0:v:0", "-an",
    "-c:v", "copy", "-avoid_negative_ts", "disabled", picture]);
  const pictureClock = sourceMedia(picture);
  if (pictureClock.videoFrames !== actual.videoFrames || Math.abs(pictureClock.fps - fps) > 1e-8)
    throw new Error(`COMPOSE_PACKET_CLOCK_CHANGED: ${basename(clip)}`);
  pictureSources.push(picture);
  pictureSignatures.push(picturePacketSignature(picture));
  sourceBindings.push({ path: clip, sha256: inputBindings[index]!.sha256, source: metadata,
    normalized: { path: target, ...actual }, normalizationPerformed: normalizePicture });
  console.log(`  ① 完整源 ${basename(clip)} ${metadata.videoFrames}帧/${metadata.fps}fps → 实际 ${actual.videoFrames}帧/${fps}fps；名义秒数不裁片，原声不补齐`);
});

/* ---------- ② 拼接 ---------- */
const raw = join(temp, "raw.mp4");
const shotSeconds = shotFrames.map((frames) => frames / fps);
/**
 * concat demuxer 缺省用 MP4 容器时长移动下一镜的 PTS。AAC 帧尾可能令容器比
 * 视频轨多出数毫秒，即使只拷视频也会在镜头接缝留下非整帧间隔。每镜用同一份
 * 帧数/fps 时长覆盖容器时长；原声另按实际镜头开始时刻放置，不裁切或补齐。
 */
const listFile = join(temp, "concat.txt");
writeFileSync(listFile, pictureSources.map((file, index) =>
  `file '${file.replace(/'/g, "'\\''")}'\nduration ${shotSeconds[index]!.toFixed(9)}`).join("\n"), "utf8");
const audioExact = normalized.map((_, index) => `[${index}:a]aresample=48000,asetpts=PTS-STARTPTS[aex${index}]`);
let pictureConcatenation = "explicit-transition";
if (transition && transitionDuration > 0) {
  if (sourceBindings.some(source => !source.normalized.hasAudio)) throw new Error("COMPOSE_TRANSITION_AUDIO_UNAVAILABLE: explicit AV transition requires actual audio inputs");
  /**
   * xfade 链：每刀的 offset = 到该刀为止的累计时长 − 已消耗的转场重叠。
   * 视频用 xfade（`transition` 指定名），音频用 acrossfade 同步收口；
   * 归一化阶段已统一分辨率/帧率/采样率，因此这里不会出现参数不匹配。
   */
  const durations = shotSeconds;
  const inputs: string[] = [];
  normalized.forEach((file) => inputs.push("-i", file));
  /** concat 的输出 timebase 与裸 MP4 输入不同；统一到 AVTB 后可继续接 xfade。 */
  const videoExact = normalized.map((_, index) => `[${index}:v]settb=AVTB,setpts=PTS-STARTPTS[vex${index}]`);
  let videoLabel = "[vex0]";
  let audioLabel = "[aex0]";
  let offset = 0;
  const steps: string[] = [];
  for (let index = 1; index < normalized.length; index += 1) {
    // --transition-at is the entering shot's 1-based number, not the zero-based input index.
    const useTransition = transitionAt.length === 0 || transitionAt.includes(index + 1);
    /** 硬切走 concat；0 秒 xfade 会在混合刀口上提前切走上一镜。 */
    const overlap = useTransition ? transitionDuration : 0;
    offset += durations[index - 1]! - overlap;
    const vOut = `[v${index}]`;
    const aOut = `[a${index}]`;
    steps.push(useTransition
      ? `${videoLabel}[vex${index}]xfade=transition=${transition}:duration=${overlap}:offset=${Math.max(0, offset).toFixed(3)}${vOut}`
      : `${videoLabel}[vex${index}]concat=n=2:v=1:a=0${vOut}`);
    /**
     * 硬切口**不能**用 `acrossfade=d=0.01` 凑数（2026-09-27 真机事故）：
     * acrossfade 每做一刀就吃掉 10ms 音频，而视频侧 `xfade duration=0` 一点不损，
     * 于是声音相对画面**逐刀提前**（本片 18 镜 14 刀硬切 → 尾镜实测 -132.9ms、
     * 整条音轨比画面短 294ms），被 compose 的音画对齐硬闸判红。
     * 现在：硬切口走 `concat`（样点级顺序拼接、长度守恒），只有真转场才 acrossfade。
     */
    steps.push(buildCutAudioStep({
      prevLabel: audioLabel,
      nextLabel: `[aex${index}]`,
      outLabel: aOut,
      overlapSec: overlap,
    }));
    videoLabel = vOut;
    audioLabel = aOut;
  }
  run(FFMPEG, ["-y", ...inputs,
    "-filter_complex", [...audioExact, ...videoExact, ...steps].join(";"),
    "-map", videoLabel, "-map", audioLabel,
    "-c:v", "libx264", "-preset", "medium", "-crf", "18", "-pix_fmt", "yuv420p",
    "-c:a", "aac", "-b:a", "192k", "-ar", "48000", "-ac", "2",
    "-movflags", "+faststart", raw]);
  const usedCuts = transitionAt.length === 0 ? normalized.length - 1
    : transitionAt.filter((i) => i >= 2 && i <= normalized.length).length;
  console.log(`  ② 逐刀转场：${transition} @${transitionDuration}s × ${usedCuts} 刀（其余硬切）`);
} else {
  const videoOnly = join(temp, "video-only.mp4");
  const copyCompatible = pictureSignatures.every(signature => signature === pictureSignatures[0]);
  if (copyCompatible) {
    pictureConcatenation = "compatible-picture-packet-copy";
    run(FFMPEG, ["-v", "error", "-xerror", "-nostdin", "-y", "-f", "concat", "-safe", "0", "-i", listFile,
      "-map", "0:v:0", "-c:v", "copy", "-an", "-avoid_negative_ts", "disabled", videoOnly]);
  } else {
    pictureConcatenation = "complete-picture-lossless-encoding";
    const inputs = pictureSources.flatMap(file => ["-i", file]);
    const preparedVideo = pictureSources.map((_, index) => `[${index}:v]settb=AVTB,setpts=PTS-STARTPTS[v${index}]`);
    const concat = `${pictureSources.map((_, index) => `[v${index}]`).join("")}concat=n=${pictureSources.length}:v=1:a=0[vout]`;
    run(FFMPEG, ["-v", "error", "-xerror", "-nostdin", "-y", ...inputs, "-filter_complex", [...preparedVideo, concat].join(";"),
      "-map", "[vout]", "-an", "-c:v", "libx264", "-preset", "medium", "-crf", "0", "-r", String(fps),
      "-avoid_negative_ts", "disabled", videoOnly]);
  }
  const pictureClock = sourceMedia(videoOnly);
  if (pictureClock.videoFrames !== shotFrames.reduce((sum, frames) => sum + frames, 0)
    || Math.abs(pictureClock.fps - fps) > 1e-8) throw new Error("COMPOSE_COMPLETE_PICTURE_CLOCK_CHANGED");
  const audioSources = sourceBindings.map((source, index) => ({ source, index })).filter(row => row.source.normalized.hasAudio);
  if (!audioSources.length) run(FFMPEG, ["-v", "error", "-y", "-i", videoOnly, "-c", "copy", raw]);
  else if (normalized.length === 1) {
    // A single source's audio packets need no concatenation. Preserve AAC
    // priming/packet payload and keep its source timestamps without shifting video.
    run(FFMPEG, ["-v", "error", "-xerror", "-nostdin", "-y", "-copyts", "-i", videoOnly, "-i", normalized[0]!,
      "-map", "0:v:0", "-map", "1:a:0", "-c", "copy", "-avoid_negative_ts", "disabled", "-movflags", "+faststart", raw]);
  } else {
    const voice = join(temp, "available-audio.m4a"), audioInputs = audioSources.flatMap(row => ["-i", normalized[row.index]!]);
    const placed = audioSources.map(({ index }, inputIndex) => {
      const startSec = shotSeconds.slice(0, index).reduce((sum, seconds) => sum + seconds, 0);
      return `[${inputIndex}:a]aresample=48000,asetpts=PTS-STARTPTS,adelay=${Math.round(startSec * 48000)}S:all=1[placed${inputIndex}]`;
    });
    // Whole available audio is placed at each measured shot start. No track is
    // extended to picture EOF; short/absent source audio is an observed fact.
    // Encoding once avoids overlapping AAC packet DTS at concatenation boundaries.
    const mix = `${audioSources.map((_, index) => `[placed${index}]`).join("")}amix=inputs=${audioSources.length}:duration=longest:normalize=0[aout]`;
    run(FFMPEG, ["-v", "error", "-xerror", "-nostdin", "-y", ...audioInputs, "-filter_complex", [...placed, mix].join(";"),
      "-map", "[aout]", "-c:a", "aac", "-b:a", "192k", "-ar", "48000", "-ac", "2", voice]);
    run(FFMPEG, ["-v", "error", "-xerror", "-nostdin", "-y", "-copyts", "-i", videoOnly, "-i", voice,
      "-map", "0:v:0", "-map", "1:a:0", "-c", "copy", "-avoid_negative_ts", "disabled", "-movflags", "+faststart", raw]);
  }
}
const rawDuration = sourceMedia(raw).duration;
console.log(`  ② 拼接完成 → ${rawDuration.toFixed(2)}s`);

/* ---------- ③ 收口（淡入淡出 + 标题/字幕烧字） ---------- */
const filters: string[] = [];
if (fade > 0) {
  filters.push(`fade=t=in:st=0:d=${fade}`, `fade=t=out:st=${Math.max(0, rawDuration - fade).toFixed(2)}:d=${fade}`);
}
const fontOpts = existsSync(FONT_FILE) ? `fontfile='${FONT_FILE}':` : "";
if (title) {
  const titleFile = join(temp, "title.txt");
  writeFileSync(titleFile, title, "utf8");
  filters.push(
    `drawtext=${fontOpts}textfile='${titleFile}':fontcolor=white:fontsize=${Math.round(width * 0.062)}:`
    + `x=(w-text_w)/2:y=h*0.09:box=1:boxcolor=black@0.35:boxborderw=${Math.round(width * 0.018)}:`
    + `enable='between(t,${fade},${Math.min(rawDuration, fade + 4).toFixed(2)})'`
  );
}
if (subtitle) {
  const subFile = join(temp, "subtitle.txt");
  writeFileSync(subFile, subtitle, "utf8");
  filters.push(
    `drawtext=${fontOpts}textfile='${subFile}':fontcolor=white:fontsize=${Math.round(width * 0.036)}:`
    + `x=(w-text_w)/2:y=h*0.86:box=1:boxcolor=black@0.35:boxborderw=${Math.round(width * 0.012)}:`
    + `enable='between(t,${fade},${Math.min(rawDuration, fade + 4).toFixed(2)})'`
  );
}
const retimeFactor = retimeTo > 0 && rawDuration > 0 ? Number((retimeTo / rawDuration).toFixed(6)) : 1;
if (Math.abs(retimeFactor - 1) > 0.0005) {
  /** atempo 单实例限制 0.5–2.0：把倍率拆成链（微调场景通常只有一段） */
  const tempo = 1 / retimeFactor;
  const chain: string[] = [];
  let remaining = tempo;
  while (remaining > 2) { chain.push("atempo=2"); remaining /= 2; }
  while (remaining < 0.5) { chain.push("atempo=0.5"); remaining /= 0.5; }
  chain.push(`atempo=${remaining.toFixed(6)}`);
  const videoFilters = [...filters, `setpts=PTS*${retimeFactor.toFixed(6)}`];
  run(FFMPEG, [
    "-y", "-i", raw,
    "-vf", videoFilters.join(","),
    "-af", chain.join(","),
    "-c:v", "libx264", "-preset", "medium", "-crf", "18", "-pix_fmt", "yuv420p",
    "-c:a", "aac", "-b:a", "192k", "-movflags", "+faststart", out,
  ]);
  console.log(`  ③ 时长补偿：${rawDuration.toFixed(2)}s → 目标 ${retimeTo}s（整片 ×${retimeFactor.toFixed(4)}）`);
} else {
  run(FFMPEG, [
    "-y", "-i", raw,
    ...(filters.length > 0 ? ["-vf", filters.join(",")] : []),
    ...(nativeClock ? ["-c:v", "copy", "-c:a", "copy"]
      : ["-c:v", "libx264", "-preset", "medium", "-crf", "18", "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "192k"]),
    "-avoid_negative_ts", "disabled", "-movflags", "+faststart", out,
  ]);
}
const outDuration = sourceMedia(out).duration;
console.log(`  ③ 母版 → ${out}（${outDuration.toFixed(2)}s）`);

/* ---------- ③-1 处理回执（无渲后品质审核） ---------- */
for (const binding of inputBindings) if (await sha256File(binding.path) !== binding.sha256)
  throw new Error(`COMPOSE_SOURCE_CHANGED: ${binding.path}`);
const avReportPath = join(dirname(out), `${basename(out).replace(/\.mp4$/i, "")}.av-sync.json`);
const outputMedia = sourceMedia(out);
if (nativeClock && (outputMedia.videoFrames !== shotFrames.reduce((sum, frames) => sum + frames, 0)
  || Math.abs(outputMedia.fps - fps) > 1e-8 || outputMedia.width !== width || outputMedia.height !== height))
  throw new Error("COMPOSE_COMPLETE_EXPORT_CLOCK_CHANGED");
if (sourceBindings.some(source => source.normalized.hasAudio) && !outputMedia.hasAudio)
  throw new Error("COMPOSE_AVAILABLE_SOURCE_AUDIO_LOST");
writeFileSync(avReportPath, `${JSON.stringify({
  schemaVersion: "workloom.composition-process/v1", generatedAt: new Date().toISOString(),
  output: out, outputSha256: await sha256File(out), inputBindings, sources: sourceBindings,
  target: { width, height, fps, shotFrames, durationSec: shotSeconds.reduce((a, b) => a + b, 0) },
  outputMedia, nativeClock, retimeFactor, pictureConcatenation,
  audioSource: "Available same-file original audio; no audio duration is extended to fit the picture clock.",
  sourceFilesUnchanged: true, qualityReviewPerformed: false, audioAlignmentMeasured: false,
  note: "No quality, speech, lipsync or correlation acceptance review was performed. Actual processing errors remain fatal."
}, null, 2)}\n`, "utf8");
console.log(`  ③-1 处理回执：${avReportPath}（未执行音画品质审核）`);

/* ---------- ④ 调色：执行配方，不复检已渲染画面 ---------- */
let gradedPath: string | null = null;
let colorReport: Record<string, unknown> | null = null;
if (colorMode !== "none") {
  const cli = resolve(REPO_ROOT, "bundles/ai-video/connectors/color-bridge/cli.mjs");
  const target = abs(gradedOut || out.replace(/\.mp4$/i, "-graded.mp4"));
  const roots = [dirname(out), dirname(target), REPO_ROOT, tmpdir()].join(":");
  const colorEnv = { ...process.env, WORKLOOM_COLOR_ALLOWED_ROOTS: roots };
  const result = run(process.execPath, [cli, "grade", "--in", out, "--out", target,
    "--profile", gradeProfile, "--intensity", gradeIntensity, "--no-verify", "--no-defects",
    ...(gradeLut ? ["--lut", abs(gradeLut)] : []), "--json"], colorEnv);
  gradedPath = target;
  colorReport = JSON.parse(result.trim()) as Record<string, unknown>;
  const reportPath = join(dirname(out), `${basename(out).replace(/\.mp4$/i, "")}-color-report.json`);
  writeFileSync(reportPath, `${JSON.stringify({ mode: "grade", report: colorReport, qualityReviewPerformed: false }, null, 2)}\n`, "utf8");
}

if (!flag("--keep-temp")) rmSync(temp, { recursive: true, force: true });

const summary = {
  clips: clips.length, nativeClock, outputMedia,
  width, height, fps,
  master: out,
  masterSeconds: Number(outDuration.toFixed(3)),
  graded: gradedPath,
  color: colorReport ? { mode: "grade", verdict: colorReport.verdict ?? "grade", winner: colorReport.winner ?? gradeProfile ?? null } : null
};
if (flag("--json")) console.log(`COMPOSE ${JSON.stringify(summary)}`);
else console.log(`成片：${out}（${outDuration.toFixed(2)}s${gradedPath ? `；调色版 ${gradedPath}` : ""}）`);
