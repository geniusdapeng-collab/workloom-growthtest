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
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

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
if (transition && transitionDuration > 0) {
  /**
   * xfade 链：每刀的 offset = 到该刀为止的累计时长 − 已消耗的转场重叠。
   * 视频用 xfade（`transition` 指定名），音频用 acrossfade 同步收口；
   * 归一化阶段已统一分辨率/帧率/采样率，因此这里不会出现参数不匹配。
   */
  const durations = normalized.map((file) => probeDuration(file));
  const inputs: string[] = [];
  normalized.forEach((file) => inputs.push("-i", file));
  let videoLabel = "[0:v]";
  let audioLabel = "[0:a]";
  let offset = 0;
  const steps: string[] = [];
  for (let index = 1; index < normalized.length; index += 1) {
    const useTransition = transitionAt.length === 0 || transitionAt.includes(index);
    /** 不做转场的刀口用 0 秒 xfade 等价于硬切，但仍走同一条 filter 链（参数一致、便于复算） */
    const overlap = useTransition ? transitionDuration : 0;
    offset += durations[index - 1]! - overlap;
    const vOut = `[v${index}]`;
    const aOut = `[a${index}]`;
    steps.push(`${videoLabel}[${index}:v]xfade=transition=${useTransition ? transition : "fade"}:duration=${overlap}:offset=${Math.max(0, offset).toFixed(3)}${vOut}`);
    steps.push(`${audioLabel}[${index}:a]acrossfade=d=${Math.max(0.01, overlap)}:c1=tri:c2=tri${aOut}`);
    videoLabel = vOut;
    audioLabel = aOut;
  }
  run(FFMPEG, ["-y", ...inputs,
    "-filter_complex", steps.join(";"),
    "-map", videoLabel, "-map", audioLabel,
    "-c:v", "libx264", "-preset", "medium", "-crf", "18", "-pix_fmt", "yuv420p",
    "-c:a", "aac", "-b:a", "192k", "-ar", "48000", "-ac", "2",
    "-movflags", "+faststart", raw]);
  const usedCuts = transitionAt.length === 0 ? normalized.length - 1 : transitionAt.filter((i) => i < normalized.length).length;
  console.log(`  ② 逐刀转场：${transition} @${transitionDuration}s × ${usedCuts} 刀（其余硬切）`);
} else {
  run(FFMPEG, ["-y", "-f", "concat", "-safe", "0", "-i", listFile, "-c", "copy", "-movflags", "+faststart", raw]);
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

/* ---------- ④ 调色：择优（不劣化优先） ---------- */
let gradedPath: string | null = null;
let colorReport: Record<string, unknown> | null = null;
if (colorMode !== "none") {
  const cli = resolve(REPO_ROOT, "bundles/ai-video/connectors/color-bridge/cli.mjs");
  const coreUrl = pathToFileURL(resolve(REPO_ROOT, "bundles/ai-video/connectors/color-bridge/core.mjs")).href;
  const target = abs(gradedOut || out.replace(/\.mp4$/i, "-graded.mp4"));
  /**
   * 调色工位有"路径监狱"（core.mjs assertPathAllowed）：只放行 WORKLOOM_COLOR_ALLOWED_ROOTS
   * 内的路径（缺省进程工作目录 + 系统临时目录）。成片若落在别处必须显式放行，
   * 否则 grade 直接 path_not_allowed（真机 2026-09-21 实测）。
   */
  const roots = [dirname(out), dirname(target), REPO_ROOT, tmpdir()].join(":");
  const colorEnv = { ...process.env, WORKLOOM_COLOR_ALLOWED_ROOTS: roots };

  /** 题材配方 → 候选（bundles/ai-video/library/color-recipes/recipes.json 为唯一真源） */
  function recipeCandidates(): Array<Record<string, unknown>> {
    if (!recipeId) return [];
    const recipesPath = resolve(REPO_ROOT, "bundles/ai-video/library/color-recipes/recipes.json");
    const doc = JSON.parse(readFileSync(recipesPath, "utf8")) as {
      recipes: Array<{ id: string; genre: string; profile: string; lut?: string | null; intensity: number }>;
    };
    const recipe = doc.recipes.find((r) => r.id === recipeId || r.genre === recipeId);
    if (!recipe) throw new Error(`题材配方不存在：${recipeId}（见 ${recipesPath.replace(REPO_ROOT + "/", "")}）`);
    const lutPath = recipe.lut ? resolve(REPO_ROOT, "bundles/ai-video/library/luts", recipe.lut) : null;
    const base = { profile: recipe.profile, lutPath, corrections: {} };
    return [
      { id: `${recipe.id}@${recipe.intensity}`, label: `${recipe.genre} 配方`, spec: { ...base, intensity: recipe.intensity } },
      { id: `${recipe.profile}@0.4`, label: `${recipe.profile} 强度 0.4`, spec: { profile: recipe.profile, lutPath, corrections: {}, intensity: 0.4 } },
      { id: `${recipe.profile}@0.7`, label: `${recipe.profile} 强度 0.7`, spec: { profile: recipe.profile, lutPath, corrections: {}, intensity: 0.7 } }
    ];
  }

  if (colorMode === "grade") {
    console.log(`  ④ 调色（旧口径 grade）：${gradeProfile} @${gradeIntensity} → ${target}`);
    const result = run(process.execPath, [
      cli, "grade", "--in", out, "--out", target,
      "--profile", gradeProfile, "--intensity", gradeIntensity, "--auto",
      ...(gradeLut ? ["--lut", abs(gradeLut)] : []), "--json"
    ], colorEnv);
    gradedPath = target;
    colorReport = JSON.parse(result.trim()) as Record<string, unknown>;
  } else {
    const core = await import(coreUrl) as {
      best(input: Record<string, unknown>): Promise<Record<string, unknown>>;
      resolveBinaries(): unknown;
    };
    const candidates = recipeCandidates();
    console.log(
      `  ④ 调色（择优 best）：${candidates.length ? `题材配方候选 ${candidates.length} 个 + 内置候选` : "内置候选（identity/auto-correct/8 profiles × 2 强度）"}`
      + `，阈值 +${minImprovement} 分`
    );
    const verdict = await core.best({
      input: out,
      output: target,
      minImprovement,
      bins: core.resolveBinaries(),
      ...(candidates.length ? { candidates } : {})
    });
    colorReport = verdict;
    const table = (verdict.candidates as Array<Record<string, unknown>> | undefined) ?? [];
    for (const candidate of [...table].sort((a, b) => Number(b.score) - Number(a.score)).slice(0, 6)) {
      const reasons = (candidate.reasons ?? {}) as Record<string, unknown>;
      console.log(
        `     ${String(Number(candidate.score).toFixed(2)).padStart(7)}  ${String(candidate.id).padEnd(22)}`
        + ` 对比度×${reasons.contrastRatio} 饱和×${reasons.satRatio} 裁切${reasons.clipDeltaPct}% 亮度${reasons.lumaDrift}`
      );
    }
    if (verdict.verdict === "graded") {
      gradedPath = target;
      const visibility = (verdict.visibility ?? {}) as Record<string, unknown>;
      console.log(
        `     判定：调色（winner=${String(verdict.winner)}，较母版 +${String(verdict.improvement)} 分，`
        + `可见性 ${String(visibility.meanAbsDiff ?? "?")}/255 ${String(visibility.verdict ?? "")}）`
      );
    } else {
      console.log(`     判定：无需调色（不劣化优先）——${String(verdict.reason ?? "")}`);
      console.log("     母版即为交付版本，未产出调色文件");
    }
  }

  const reportPath = join(dirname(out), `${basename(out).replace(/\.mp4$/i, "")}-color-report.json`);
  writeFileSync(reportPath, `${JSON.stringify({ mode: colorMode, recipe: recipeId ?? null, report: colorReport }, null, 2)}\n`, "utf8");
  console.log(`     调色报告：${reportPath}`);
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
