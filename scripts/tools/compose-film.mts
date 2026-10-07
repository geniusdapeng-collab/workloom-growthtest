#!/usr/bin/env tsx
/**
 * 成片拼接工具（2026-09-21）——逐镜产物 → 一条竖版母版（可选标题/字幕 + 调色）。
 *
 * 为什么需要：Ark Seedance 单条上限 15s（媒体目录 limits），30 秒短片必须由多镜拼接；
 * 逐镜产物的编码参数（分辨率/帧率/音轨）各自不同，直接 concat 会花屏/丢音。
 *
 * 三段式（每段都可单独复跑）：
 *   ① 归一化：逐镜 → 统一 WxH / fps / yuv420p / AAC 48k 立体声（临时目录）
 *   ② 拼接：concat demuxer -c copy（归一化后参数一致，可无损拼接）
 *   ③ 收口：淡入淡出 + 标题/字幕烧字（可选）→ 母版
 *   ④ 调色：走调色工位**择优**（color-bridge `best`：候选生成 + 画质打分 + 不劣化优先），
 *      可用 `--recipe <题材配方 id>` 把题材配方作为候选之一；判定"无需调色"时不产出调色版
 *
 * 用法：
 *   pnpm exec tsx scripts/tools/compose-film.mts \
 *     --clips a.mp4,b.mp4,... --out outputs/nanyuan-master-30s.mp4 \
 *     [--width 1080 --height 1920 --fps 30] [--fade 0.5] \
 *     [--title "苏州南园宾馆"] [--subtitle "唯一可以入住的苏州园林"] \
 *     --recipe real-estate [--min-improvement 2] [--graded-out outputs/nanyuan-graded-30s.mp4] \
 *     [--keep-temp] [--json]
 */
import { execFileSync } from "node:child_process";
import { createReadStream, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
function sourceMedia(file: string): { hasAudio: boolean; duration: number } {
  const metadata = JSON.parse(run(FFPROBE, ["-v", "error", "-show_streams", "-show_format", "-of", "json", file])) as {
    streams?: Array<{ codec_type?: string; duration?: string }>; format?: { duration?: string };
  };
  const video = metadata.streams?.find(stream => stream.codec_type === "video");
  const duration = Number(video?.duration ?? metadata.format?.duration);
  if (!video || !Number.isFinite(duration) || duration <= 0) throw new Error(`COMPOSE_SOURCE_UNREADABLE: ${file}`);
  return { hasAudio: metadata.streams?.some(stream => stream.codec_type === "audio") === true, duration };
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
 *   best（默认）= 走 color-bridge 的「择优」：候选生成 + 画质打分 + 允许不调（不劣化优先）；
 *   grade       = 旧口径（固定 profile/LUT/intensity），仅兼容历史调用；
 *   none        = 不调色。
 * 事故背景：旧实现固定 `clean-bright@0.55 + auto`，绕过了择优闸门；按产品自己的画质分，
 * 该结果对母版是**劣化**（score 91.99：饱和×0.79、细节×0.92、亮度漂移 +39.6）。
 */
const colorMode = arg("--color", "best");
const recipeId = arg("--recipe");
const minImprovement = Number(arg("--min-improvement", "2"));
const gradeProfile = arg("--grade-profile");
const gradeLut = arg("--grade-lut");
const gradeIntensity = arg("--grade-intensity", "0.55");
const gradedOut = arg("--graded-out");

mkdirSync(dirname(out), { recursive: true });
const temp = mkdtempSync(join(tmpdir(), "wl-compose-"));
console.log(`拼接 ${clips.length} 个镜头 → ${width}x${height} @${fps}fps（临时目录 ${temp}）`);

/* ---------- ① 归一化 ---------- */
const normalized: string[] = [];
const shotFrames: number[] = [];
clips.forEach((clip, index) => {
  const target = join(temp, `norm-${String(index).padStart(2, "0")}.mp4`);
  /**
   * 每段音轨必须与画面**等长**（2026-09-26 真机事故修复）：
   * aac 编码器 priming + 帧对齐会让音轨流比画面短十几毫秒，逐段累计后
   * 拼接出来的音轨时间轴会整体提前（真机：5 镜时第 3 镜就偏 -145ms）。
   * 因此归一化时用 `apad` 把声音补到画面时长（补的是静音，≤20ms，听不出来），
   * 下游无论走 concat 滤镜还是 demuxer，时间轴都不会再漂。
   */
  const metadata = sourceMedia(clip);
  const inFrames = Math.max(1, Math.round((requestedDurations[index] ?? metadata.duration) * fps));
  const targetDuration = inFrames / fps;
  shotFrames.push(inFrames);
  run(FFMPEG, [
    "-y", "-i", clip,
    ...(!metadata.hasAudio ? ["-f", "lavfi", "-i", "anullsrc=channel_layout=stereo:sample_rate=48000"] : []),
    "-map", "0:v:0", "-map", metadata.hasAudio ? "0:a:0" : "1:a:0",
    "-vf", `scale=${width}:${height}:force_original_aspect_ratio=decrease,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2:color=black,setsar=1,fps=${fps},tpad=stop_mode=clone:stop_duration=${targetDuration}`,
    "-af", "apad",
    "-t", targetDuration.toFixed(6),
    "-c:v", "libx264", "-preset", "medium", "-crf", "18", "-pix_fmt", "yuv420p",
    "-c:a", "aac", "-b:a", "192k", "-ar", "48000", "-ac", "2",
    "-movflags", "+faststart", target,
  ]);
  const streamDurations = run(FFPROBE, [
    "-v", "error", "-show_entries", "stream=codec_type,duration", "-of", "csv=p=0", target,
  ]).trim().split("\n").map((line) => line.split(","));
  const targetVideo = Number(streamDurations.find((row) => row[0] === "video")?.[1] ?? 0);
  const targetAudio = Number(streamDurations.find((row) => row[0] === "audio")?.[1] ?? 0);
  const avDelta = Math.abs(targetVideo - targetAudio);
  normalized.push(target);
  console.log(`  ① 归一化 ${basename(clip)} → ${targetVideo.toFixed(2)}s（音轨 ${targetAudio.toFixed(2)}s，Δ${(avDelta * 1000).toFixed(0)}ms）`);
  if (avDelta > 0.01) {
    console.log(`       ⚠ 该段音画长度差 ${(avDelta * 1000).toFixed(0)}ms > 10ms，拼接前请确认（对齐自检会再实测一次）`);
  }
});

/* ---------- ② 拼接 ---------- */
const raw = join(temp, "raw.mp4");
/**
 * 每段**按画面时长**把音轨切/补到精确长度（2026-09-26 真机事故修复的关键一步）：
 * aac 把音频按 1024 样点（48k 下 21.33ms）成帧，末帧向上取整，
 * 于是每段音轨比画面**长** 0–21ms；不透支这个差，逐段累计就是 33ms/6 镜的漂移。
 * 不变量：每段音轨时长 === 该段画面时长（D = 帧数 / fps）。
 */
const shotSeconds = shotFrames.map((frames) => frames / fps);
/**
 * concat demuxer 缺省用 MP4 容器时长移动下一镜的 PTS。AAC 帧尾可能令容器比
 * 视频轨多出数毫秒，即使只拷视频也会在镜头接缝留下非整帧间隔。每镜用同一份
 * 帧数/fps 时长覆盖容器时长；下方音轨切补和音画实测也必须共用 shotSeconds。
 */
const listFile = join(temp, "concat.txt");
writeFileSync(listFile, normalized.map((file, index) =>
  `file '${file}'\nduration ${shotSeconds[index]!.toFixed(6)}`).join("\n"), "utf8");
const audioExact = normalized.map((_, index) =>
  `[${index}:a]atrim=end=${shotSeconds[index]!.toFixed(6)},asetpts=N/SR/TB,`
  + `apad=whole_dur=${shotSeconds[index]!.toFixed(6)}[aex${index}]`);
if (transition && transitionDuration > 0) {
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
  /**
   * 硬切拼接的**音画对齐纪律**（2026-09-26 真机事故修复）：
   * 逐段 mp4 里 aac 音轨普遍比画面短几毫秒（编码器 priming + 帧对齐），
   * `-f concat -c copy` 会让 demuxer **按各自流的时长**分别累计偏移 →
   * 声音相对画面逐镜漂移（真机实测 15 镜尾镜 +125ms，听感="上一镜的音效串到下一镜"）。
   * 现在：画面仍无损直拷（帧级不重编码），声音改走 **concat 滤镜**（样点级顺序拼接、
   * 不足处按画面时长补静音），再与画面合流。代价只有一次音频重编码。
   */
  const videoOnly = join(temp, "video-only.mp4");
  run(FFMPEG, ["-y", "-f", "concat", "-safe", "0", "-i", listFile, "-c:v", "copy", "-an", videoOnly]);
  const voiceWav = join(temp, "voice.wav");
  const audioInputs = normalized.flatMap((file) => ["-i", file]);
  const audioConcat = `${normalized.map((_, index) => `[aex${index}]`).join("")}concat=n=${normalized.length}:v=0:a=1[aout]`;
  run(FFMPEG, [
    "-y", ...audioInputs,
    "-filter_complex", [...audioExact, audioConcat].join(";"),
    "-map", "[aout]", "-c:a", "pcm_s16le", "-ar", "48000", "-ac", "2", voiceWav,
  ]);
  run(FFMPEG, [
    "-y", "-i", videoOnly, "-i", voiceWav,
    "-map", "0:v:0", "-map", "1:a:0",
    "-c:v", "copy", "-c:a", "aac", "-b:a", "192k", "-ar", "48000", "-ac", "2",
    "-shortest", "-movflags", "+faststart", raw,
  ]);
}
const rawDuration = probeDuration(raw);
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
    "-c:v", "libx264", "-preset", "medium", "-crf", "18", "-pix_fmt", "yuv420p",
    "-c:a", "aac", "-b:a", "192k", "-movflags", "+faststart", out,
  ]);
}
const outDuration = probeDuration(out);
console.log(`  ③ 母版 → ${out}（${outDuration.toFixed(2)}s）`);

/* ---------- ③-1 处理回执（无渲后品质审核） ---------- */
for (const binding of inputBindings) if (await sha256File(binding.path) !== binding.sha256)
  throw new Error(`COMPOSE_SOURCE_CHANGED: ${binding.path}`);
const avReportPath = join(dirname(out), `${basename(out).replace(/\.mp4$/i, "")}.av-sync.json`);
writeFileSync(avReportPath, `${JSON.stringify({
  schemaVersion: "workloom.composition-process/v1", generatedAt: new Date().toISOString(),
  output: out, outputSha256: await sha256File(out), inputBindings,
  target: { width, height, fps, shotFrames, durationSec: shotSeconds.reduce((a, b) => a + b, 0) },
  audioSource: "existing source audio; silent sources receive a silent processing stream",
  sourceFilesUnchanged: true, audioAlignmentMeasured: false,
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
  clips: clips.length,
  width, height, fps,
  master: out,
  masterSeconds: Number(outDuration.toFixed(3)),
  graded: gradedPath,
  color: colorReport ? { mode: colorMode, verdict: colorReport.verdict ?? "grade", winner: colorReport.winner ?? gradeProfile ?? null } : null
};
if (flag("--json")) console.log(`COMPOSE ${JSON.stringify(summary)}`);
else console.log(`成片：${out}（${outDuration.toFixed(2)}s${gradedPath ? `；调色版 ${gradedPath}` : ""}）`);
