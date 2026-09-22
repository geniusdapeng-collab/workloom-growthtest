#!/usr/bin/env node
/**
 * 配乐工位 · 真机演示与产物导出（不依赖数据库）
 *
 * 用途：给出一条"可反复复现"的端到端证据链——自己造一条带对白与环境声的原片，
 * 用配乐工位把它做成配乐成片，并把中间产物（BGM、人声/伴奏、波形对比、报告）全部落盘。
 *
 *   node bundles/ai-video/connectors/bgm-bridge/demo-artifacts.mjs --out /path/to/outputs [--recipe food] [--voice Tingting]
 *
 * 产物：
 *   original.mp4              原始成片（对白 + 环境声，人工造的演示素材）
 *   bgm-track.wav             自算作曲产出的 BGM（零第三方权利）
 *   bgm-mixed.mp4             配乐后成片（保留人声 + BGM 让位 + -14 LUFS 母版）
 *   vocals.wav / instrumental.wav   人声分离演示（中心声道近似，质量如实标注）
 *   waveform-before-after.png 前后波形对比（交付证据）
 *   bgm-report.json           诊断/作曲/混音/复检的完整报告
 *   README.md                 这组产物是什么、怎么复现
 */

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import { analyze, analyzeStructure, compose, findRecipes, mix, separate } from "./core.mjs";
import { binaryVersion, probeMedia, resolveBinaries } from "./measure.mjs";

const FONT = "/System/Library/Fonts/Supplemental/Arial Unicode.ttf";
const FALLBACK_FONTS = ["/Library/Fonts/Arial Unicode.ttf", "/System/Library/Fonts/Hiragino Sans GB.ttc"];

const SHOTS = [
  { start: 0, duration: 7, color: "0x0f3b2e", label: "S01 门店空镜 · 对白 1", ink: "white" },
  { start: 7, duration: 7, color: "0xe8dcc8", label: "S02 产品特写 · 对白 2", ink: "0x2a2318" },
  { start: 14, duration: 6, color: "0x15525a", label: "S03 冲泡过程 · 只有现场声", ink: "white" },
  { start: 20, duration: 6, color: "0xd9762a", label: "S04 结尾口播 · 对白 3", ink: "0x26160a" },
];

const LINES = [
  { shot: 0, at: 0.4, text: "今天我们上新一款轻乳茶，用的是当天现泡的茶底。" },
  { shot: 1, at: 7.4, text: "茶汤只取前段，奶香压得住，甜度我们做到了三分糖。" },
  { shot: 2, at: 20.4, text: "现在到店，第二杯半价，活动到这个周日。" },
];

function arg(name, fallback = null) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : fallback;
}

function pickFont() {
  if (fs.existsSync(FONT)) return FONT;
  const found = FALLBACK_FONTS.find((candidate) => fs.existsSync(candidate));
  if (!found) throw new Error("找不到可用的中文字体（Arial Unicode / Hiragino Sans GB）");
  return found;
}

function run(bin, args, label) {
  process.stderr.write(`  · ${label}\n`);
  execFileSync(bin, args, { stdio: ["ignore", "ignore", "pipe"] });
}

function buildSpeechTrack({ voice, outFile, workDir }) {
  const files = [];
  for (const [index, line] of LINES.entries()) {
    const raw = path.join(workDir, `line-${index + 1}.aiff`);
    run("/usr/bin/say", ["-v", voice, "-o", raw, line.text], `语音合成 · 对白 ${index + 1}`);
    files.push({ ...line, raw });
  }
  return files;
}

/**
 * 造源片：四段硬切画面 + 对白 + 环境声（房间底噪 + 低频嗡声）。
 * 硬切是刻意的：它给"卡点对齐"提供真实剪辑点。
 */
function buildSourceVideo({ outFile, workDir, voice, bins }) {
  const font = pickFont();
  const shotFiles = SHOTS.map((shot, index) => {
    const file = path.join(workDir, `shot-${index + 1}.mp4`);
    run(bins.ffmpeg, [
      "-hide_banner", "-v", "error", "-y",
      "-f", "lavfi", "-i", `color=c=${shot.color}:size=640x360:rate=25:duration=${shot.duration}`,
      "-vf", `drawtext=fontfile='${font}':text='${shot.label}':fontcolor=${shot.ink}@0.92:fontsize=26:x=40:y=300,`
        + `drawtext=fontfile='${font}':text='WorkLoom BGM 工位演示':fontcolor=${shot.ink}@0.55:fontsize=18:x=40:y=48`,
      "-c:v", "libx264", "-preset", "veryfast", "-crf", "22", "-pix_fmt", "yuv420p", file,
    ], `造画面 · ${shot.label}`);
    return file;
  });

  const concatList = path.join(workDir, "shots.txt");
  fs.writeFileSync(concatList, shotFiles.map((file) => `file '${file}'`).join("\n"));
  const silent = path.join(workDir, "video-only.mp4");
  run(bins.ffmpeg, [
    "-hide_banner", "-v", "error", "-y",
    "-f", "concat", "-safe", "0", "-i", concatList,
    "-c", "copy", silent,
  ], "拼接画面（4 段硬切）");

  const lines = buildSpeechTrack({ voice, outFile: outFile, workDir });

  // 对白轨：把每句 say 的输出延迟到对应镜头起点，再与环境声合流
  const inputs = [];
  const filters = [];
  const total = SHOTS.reduce((sum, shot) => sum + shot.duration, 0);
  const ambience = "anoisesrc=duration=" + total + ":color=pink:amplitude=0.035:seed=7,lowpass=f=4500,volume=-6dB[amb]";
  filters.push(ambience);
  filters.push(`sine=frequency=60:duration=${total},volume=-42dB[hum]`);
  lines.forEach((line, index) => {
    inputs.push("-i", line.raw);
    const delayMs = Math.round(line.at * 1000);
    filters.push(`[${index}:a]aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=stereo,`
      + `adelay=${delayMs}|${delayMs},volume=1.0[dlg${index}]`);
  });
  const mixInputs = ["[amb]", "[hum]", ...lines.map((_, index) => `[dlg${index}]`)].join("");
  filters.push(`${mixInputs}amix=inputs=${2 + lines.length}:duration=longest:dropout_transition=0:normalize=0[mix]`);
  filters.push(`[mix]loudnorm=I=-18:TP=-2:LRA=11:print_format=summary[aout]`);

  const audioFile = path.join(workDir, "source-audio.wav");
  run(bins.ffmpeg, [
    "-hide_banner", "-v", "error", "-y",
    ...inputs,
    "-filter_complex", filters.join(";"),
    "-map", "[aout]", "-t", String(total),
    "-c:a", "pcm_s16le", "-ar", "48000", "-ac", "2", audioFile,
  ], "造音轨（对白 + 环境声，-18 LUFS 原始母版）");

  run(bins.ffmpeg, [
    "-hide_banner", "-v", "error", "-y",
    "-i", silent, "-i", audioFile,
    "-map", "0:v:0", "-map", "1:a:0",
    "-c:v", "copy", "-c:a", "aac", "-b:a", "192k",
    "-movflags", "+faststart", "-shortest", outFile,
  ], "合流为原始成片");

  return { totalDuration: total, lines };
}

async function main() {
  const outDir = path.resolve(arg("--out", "outputs/bgm-demo"));
  const recipeId = arg("--recipe", "food");
  const voice = arg("--voice", "Tingting");
  const seed = Number(arg("--seed", "2026"));
  const bins = resolveBinaries();

  if (!(await binaryVersion(bins.ffmpeg))) throw new Error(`ffmpeg 不可用：${bins.ffmpeg}`);
  fs.mkdirSync(outDir, { recursive: true });
  const workDir = path.join(outDir, ".work");
  fs.mkdirSync(workDir, { recursive: true });

  console.log(`配乐工位真机演示 → ${outDir}`);
  const original = path.join(outDir, "original.mp4");
  const built = buildSourceVideo({ outFile: original, workDir, voice, bins });

  const sourceProbe = await probeMedia(original, { bins });
  console.log(`  原始成片：${sourceProbe.duration.toFixed(2)}s（对白 ${built.lines.length} 句 + 环境声）`);

  const diagnosis = await analyze({ input: original, bins });
  console.log(`  音轨诊断：${diagnosis.loudness.integratedLufs} LUFS / 人声频段活动 ${(diagnosis.voice.activeRatio * 100).toFixed(1)}% / 剪辑点 ${diagnosis.cuts.cuts.length} 个`);

  const recipe = findRecipes({ recipeId: recipeId }).recipe;
  if (!recipe) throw new Error(`配方不存在：${recipeId}`);

  const bgmPath = path.join(outDir, "bgm-track.wav");
  const bgm = await compose({ input: original, output: bgmPath, recipeId, seed, bpmStrategy: "cut-driven", bins });
  console.log(`  自算 BGM：${recipe.genre} / ${bgm.plan.key} ${bgm.plan.mode} ${bgm.plan.bpm}BPM（${bgm.tempo.source}）/ ${bgm.durationSeconds}s / ${bgm.sha256.slice(0, 12)}`);

  const mixedPath = path.join(outDir, "bgm-mixed.mp4");
  const mixed = await mix({
    input: original,
    output: mixedPath,
    bgmPath,
    policy: "keep-dialogue",
    bgmBpm: bgm.plan.bpm,
    musicLevelDb: recipe.musicLevelDb,
    duckingDb: recipe.duckingDb,
    evidenceDir: outDir,
    bins,
  });
  console.log(`  配乐成片：${mixed.loudness.after.integratedLufs} LUFS / ${mixed.loudness.after.truePeakDbtp} dBTP / 让位 ${mixed.levels.duckingDepthDb}dB / 人声余量 ${mixed.levels.speechToMusicMarginDb}dB / 配乐可闻度 ${mixed.levels.musicPresenceDb}dB`);

  const separated = await separate({ input: original, outDir, engine: "auto", bins });
  console.log(`  人声分离：${separated.engine}（${separated.quality}）→ vocals.wav / instrumental.wav`);

  /**
   * 选段演示：造一条 150 秒的"库曲"（主歌/副歌结构），让工位**只截最合适的高潮段**配到 26 秒的片子上。
   * 为什么要单独演示：自算作曲是"按片长写"，而外部曲库曲目是"整首 2–3 分钟"——那才是选段要解决的问题。
   */
  const longTrack = path.join(outDir, "bgm-library-track-long.wav");
  const longRaw = path.join(workDir, "library-track-raw.wav");
  const composedLong = await compose({ durationSeconds: 150, output: longRaw, recipeId, seed: seed + 1, bins });
  // 给这条"库曲"加上真实歌曲式的段落力度（主歌弱/副歌强/桥段弱/末段副歌强），供结构识别去发现
  run(bins.ffmpeg, [
    "-hide_banner", "-v", "error", "-y",
    "-i", composedLong.output,
    // 注意：这里**不能**用单遍 loudnorm——它会做动态归一化，把段落力度压平（实测动态从 ~20dB 掉到 9dB，
    // 结构识别就再也分不出副歌）。改成"手动力度 + 固定增益"，保留真实歌曲的动态。
    "-af", "volume='if(between(t\\,0\\,14),0.35,"
      + "if(between(t\\,14\\,48),0.95,"
      + "if(between(t\\,48\\,66),0.30,"
      + "if(between(t\\,66\\,118),1.0,"
      + "if(between(t\\,118\\,134),0.32,0.22))))"
      + ")':eval=frame,volume=7dB",
    "-c:a", "pcm_s16le", "-ar", "48000", "-ac", "2", longTrack,
  ], "造选段演示用库曲（150s，含主歌/副歌/桥段结构）");
  const longStructure = await analyzeStructure({ input: longTrack, bins });
  const sectionedPath = path.join(outDir, "bgm-mixed-sectioned.mp4");
  const sectioned = await mix({
    input: original,
    output: sectionedPath,
    bgmPath: longTrack,
    policy: "keep-dialogue",
    bgmBpm: longStructure.tempo.bpm ?? recipe.bpm,
    musicLevelDb: recipe.musicLevelDb,
    duckingDb: recipe.duckingDb,
    section: "auto",
    evidenceDir: outDir,
    bins,
  });
  console.log(`  选段演示：库曲 ${longStructure.durationSec}s（分段 ${longStructure.structure.segments.map((item) => item.type).join("/")}）→ 选中 ${sectioned.section?.chosen?.type} ${sectioned.section?.played?.startSec ?? "?"}s→${sectioned.section?.chosen?.endSec}s`);

  const report = {
    generatedAt: new Date().toISOString(),
    generator: "bundles/ai-video/connectors/bgm-bridge/demo-artifacts.mjs",
    source: { path: original, probe: sourceProbe, dialogueLines: built.lines.map((line) => ({ at: line.at, text: line.text })) },
    diagnosis,
    recipe: { id: recipe.id, genre: recipe.genre, scene: recipe.scene, mood: recipe.mood, avoid: recipe.avoid },
    composedBgm: bgm,
    mixReport: mixed,
    sectionDemo: {
      libraryTrack: { path: longTrack, durationSec: longStructure.durationSec },
      structure: {
        method: longStructure.structure.method,
        dynamicsDb: longStructure.structure.dynamicsDb,
        bpm: longStructure.tempo.bpm,
        bpmConfidence: longStructure.tempo.confidence,
        segments: longStructure.structure.segments,
        climaxCandidates: longStructure.climax.candidates.slice(0, 3),
      },
      selection: sectioned.section,
      mixReport: sectioned,
    },
    separation: separated,
    deliverables: {
      original: path.basename(original),
      bgmTrack: path.basename(bgmPath),
      bgmMixed: path.basename(mixedPath),
      libraryTrack: path.basename(longTrack),
      bgmMixedSectioned: path.basename(sectionedPath),
      sectionPicked: "section-picked.png",
      vocals: path.basename(separated.vocals.path),
      instrumental: path.basename(separated.instrumental.path),
      waveform: "waveform-before-after.png",
    },
  };
  fs.writeFileSync(path.join(outDir, "bgm-report.json"), `${JSON.stringify(report, null, 2)}\n`);

  const readme = [
    "# BGM 配乐工位 · 真机演示产物",
    "",
    `生成时间：${report.generatedAt}`,
    "生成方式：`node bundles/ai-video/connectors/bgm-bridge/demo-artifacts.mjs --out <dir>`",
    "",
    "| 文件 | 说明 |",
    "|---|---|",
    "| `original.mp4` | 原始成片：4 段硬切画面 + 3 句对白 + 环境声（-18 LUFS 原始母版） |",
    "| `bgm-track.wav` | 自算作曲的 BGM（零第三方音源，无署名义务，可商用） |",
    "| `bgm-mixed.mp4` | 配乐后成片：原声保留、BGM 人声让位、母版 -14 LUFS / -1 dBTP |",
    "| `bgm-library-track-long.wav` | 选段演示用「库曲」：150s、含主歌/副歌/桥段力度结构 |",
    "| `bgm-mixed-sectioned.mp4` | **自动选段**版成片：工位只截库曲的高潮段，并把峰值对齐片子的高潮时刻（26s 片子 ← 150s 库曲） |",
    "| `section-picked.png` | 选段证据：上=库曲波形（红框=选中片段），下=片子波形（红框=对齐到的高潮时刻） |",
    "| `vocals.wav` / `instrumental.wav` | 人声分离演示（中心声道近似，质量等级见报告） |",
    "| `waveform-before-after.png` | 前后波形对比（上=原片音轨，下=配乐后音轨） |",
    "| `bgm-report.json` | 诊断 / 作曲 / 混音 / 复检的完整数据 |",
    "",
    "## 关键指标（实测）",
    "",
    `- 配乐后响度：${mixed.loudness.after.integratedLufs} LUFS（真峰值 ${mixed.loudness.after.truePeakDbtp} dBTP）`,
    `- 人声让位深度：${mixed.levels.duckingDepthDb} dB（人声出现时 BGM 自动下压）`,
    `- 人声-音乐余量：${mixed.levels.speechToMusicMarginDb} dB（目标 ≥ 6 dB）`,
    `- 配乐可闻度（静音段相对原片提升）：${mixed.levels.musicPresenceDb} dB（目标 ≥ 3 dB）`,
    `- 卡点对齐：${mixed.alignment.verdict}（平均误差 ${mixed.alignment.meanAbsErrorMs} ms，BPM ${mixed.alignment.bpm}）`,
    "",
    "## 选段（自动截取最合适的部分）",
    "",
    `- 库曲结构识别：${report.sectionDemo.structure.method}，动态 ${report.sectionDemo.structure.dynamicsDb}dB，分段 ${report.sectionDemo.structure.segments.map((item) => item.type).join(" / ")}`,
    `- 选段模式：${report.sectionDemo.selection?.mode} → 片段 ${report.sectionDemo.selection?.played?.startSec}s–${report.sectionDemo.selection?.played?.endSec}s（${report.sectionDemo.selection?.played?.durationSec}s，循环 ${report.sectionDemo.selection?.played?.loops} 次铺满）`,
    `- 决策理由：${report.sectionDemo.selection?.reason}`,
    `- 峰值对齐：${report.sectionDemo.selection?.filmPeakAlign?.note ?? report.sectionDemo.selection?.filmPeakAlign?.reason ?? "（未启用）"}`,
    "",
    "## 复现",
    "",
    "```bash",
    "# 需要工位本地 ffmpeg/ffprobe（或设置 WORKLOOM_BGM_FFMPEG_PATH）",
    "node bundles/ai-video/connectors/bgm-bridge/demo-artifacts.mjs --out /tmp/bgm-demo --recipe food",
    "```",
    "",
    "> 演示素材由脚本自造（`/usr/bin/say` + ffmpeg 合成），不含任何客户素材或第三方版权音频。",
    "",
  ].join("\n");
  fs.writeFileSync(path.join(outDir, "README.md"), readme);

  fs.rmSync(workDir, { recursive: true, force: true });
  console.log(`完成：original.mp4 / bgm-mixed.mp4 / bgm-track.wav / vocals.wav / instrumental.wav / waveform-before-after.png / bgm-report.json`);
  return 0;
}

main()
  .then((code) => process.exit(code))
  .catch((error) => {
    console.error(error instanceof Error ? error.stack ?? error.message : String(error));
    process.exit(1);
  });
