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
 *   ③ 收口：淡入淡出 + 标题/字幕烧字（可选）→ 母版；再用调色工位 bridge 出调色版（可选）
 *
 * 用法：
 *   pnpm exec tsx scripts/tools/compose-film.mts \
 *     --clips a.mp4,b.mp4,... --out outputs/nanyuan-master-30s.mp4 \
 *     [--width 1080 --height 1920 --fps 30] [--fade 0.5] \
 *     [--title "苏州南园宾馆"] [--subtitle "唯一可以入住的苏州园林"] \
 *     [--grade-profile real-estate --grade-intensity 0.55 --graded-out outputs/nanyuan-graded-30s.mp4] \
 *     [--keep-temp] [--json]
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";

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
const title = arg("--title");
const subtitle = arg("--subtitle");
const gradeProfile = arg("--grade-profile");
const gradeLut = arg("--grade-lut");
const gradeIntensity = arg("--grade-intensity", "0.55");
const gradedOut = arg("--graded-out");

mkdirSync(dirname(out), { recursive: true });
const temp = mkdtempSync(join(tmpdir(), "wl-compose-"));
console.log(`拼接 ${clips.length} 个镜头 → ${width}x${height} @${fps}fps（临时目录 ${temp}）`);

/* ---------- ① 归一化 ---------- */
const normalized: string[] = [];
clips.forEach((clip, index) => {
  const target = join(temp, `norm-${String(index).padStart(2, "0")}.mp4`);
  run(FFMPEG, [
    "-y", "-i", clip,
    "-vf", `scale=${width}:${height}:force_original_aspect_ratio=decrease,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2:color=black,setsar=1,fps=${fps}`,
    "-c:v", "libx264", "-preset", "medium", "-crf", "18", "-pix_fmt", "yuv420p",
    "-c:a", "aac", "-b:a", "192k", "-ar", "48000", "-ac", "2",
    "-movflags", "+faststart", target,
  ]);
  normalized.push(target);
  console.log(`  ① 归一化 ${basename(clip)} → ${probeDuration(target).toFixed(2)}s`);
});

/* ---------- ② 拼接 ---------- */
const listFile = join(temp, "concat.txt");
writeFileSync(listFile, normalized.map((file) => `file '${file}'`).join("\n"), "utf8");
const raw = join(temp, "raw.mp4");
run(FFMPEG, ["-y", "-f", "concat", "-safe", "0", "-i", listFile, "-c", "copy", "-movflags", "+faststart", raw]);
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
run(FFMPEG, [
  "-y", "-i", raw,
  ...(filters.length > 0 ? ["-vf", filters.join(",")] : []),
  "-c:v", "libx264", "-preset", "medium", "-crf", "18", "-pix_fmt", "yuv420p",
  "-c:a", "aac", "-b:a", "192k", "-movflags", "+faststart", out,
]);
const outDuration = probeDuration(out);
console.log(`  ③ 母版 → ${out}（${outDuration.toFixed(2)}s）`);

/* ---------- ④ 调色（调色工位 bridge，可选） ---------- */
let gradedPath: string | null = null;
if (gradeProfile) {
  const target = abs(gradedOut || out.replace(/\.mp4$/i, "-graded.mp4"));
  const cli = resolve(REPO_ROOT, "bundles/ai-video/connectors/color-bridge/cli.mjs");
  const args = [
    cli, "grade", "--in", out, "--out", target,
    "--profile", gradeProfile, "--intensity", gradeIntensity, "--auto",
    ...(gradeLut ? ["--lut", abs(gradeLut)] : []),
    "--json",
  ];
  console.log(`  ④ 调色：${gradeProfile} @${gradeIntensity} → ${target}`);
  /**
   * 调色工位有"路径监狱"（core.mjs assertPathAllowed）：只放行 WORKLOOM_COLOR_ALLOWED_ROOTS
   * 内的路径（缺省进程工作目录 + 系统临时目录）。成片若落在别处必须显式放行，
   * 否则 grade 直接 path_not_allowed（真机 2026-09-21 实测）。
   */
  const roots = [dirname(out), dirname(target), REPO_ROOT, tmpdir()].join(":");
  const result = run(process.execPath, args, { ...process.env, WORKLOOM_COLOR_ALLOWED_ROOTS: roots });
  gradedPath = target;
  console.log(`     ${result.trim().slice(0, 400)}`);
}

if (!flag("--keep-temp")) rmSync(temp, { recursive: true, force: true });

const summary = {
  clips: clips.length,
  width, height, fps,
  master: out,
  masterSeconds: Number(outDuration.toFixed(3)),
  graded: gradedPath,
};
if (flag("--json")) console.log(`COMPOSE ${JSON.stringify(summary)}`);
else console.log(`成片：${out}（${outDuration.toFixed(2)}s${gradedPath ? `；调色版 ${gradedPath}` : ""}）`);
