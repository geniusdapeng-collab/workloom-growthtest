#!/usr/bin/env node
/**
 * 字幕工位 · 真机演示与产物导出（不依赖数据库）
 *
 * 用途：给出一条"可反复复现"的端到端证据链——自己造一条竖屏素材（含深色/浅色/复杂三种底），
 * 走完 诊断 → 选型 → 方案 → 烧录 → 复检 → 择优，并把中间产物全部落盘。
 *
 *   node bundles/ai-video/connectors/subtitle-bridge/demo-artifacts.mjs --out /path/to/outputs [--platform 抖音/快手]
 *
 * 产物：
 *   source.mp4           自带三条硬切、三种底色的竖屏素材（人工造的演示素材）
 *   subtitle.srt         演示字幕（含长句与中英混排）
 *   brief.json           演示简报（生活vlog / 文艺 / 快节奏 / 抖音）
 *   subtitle-plan.json   方案：选型理由、字号/描边/边距、平台版式、版式体检
 *   subtitle-plan.ass    方案落地的 ASS 样式与事件（可直接给剪辑软件复用）
 *   burned.mp4           烧录成片（字幕 + 片头标题）
 *   best.mp4             择优出片（候选池打分后的赢家方案）
 *   evidence-*.png       交付证据帧（标题帧 / 首条字幕 / 末条字幕）
 *   analyze-*.png        画面可读性诊断抽帧
 *   report.json          全量报告（选型/体检/可现度/时间轴回读/哈希）
 *   README.md            这组产物是什么、怎么复现
 */

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import {
  analyzeVideo, best, findRecipes, health, plan, renderDanmaku, renderKaraoke, renderSticker,
  renderWithSubtitles, selectFonts,
} from "./core.mjs";
import { resolveBinaries } from "./measure.mjs";

const SHOTS = [
  { id: "S01", color: "0x0f3b2e", seconds: 6, note: "深色底（藏寨夜景）" },
  { id: "S02", color: "0xe8dcc8", seconds: 6, note: "浅色底（晨光草海）" },
  { id: "S03", pattern: true, seconds: 6, note: "复杂底（经幡细节）" },
  { id: "S04", color: "0x15525a", seconds: 6, note: "中灰底（雪山远景）" },
];

const LINES = [
  { at: 0.6, to: 3.4, text: "雪山倒映在草海的晨光里" },
  { at: 3.6, to: 6.2, text: "藏寨的炊烟 是川西写给天空的信" },
  { at: 6.6, to: 9.4, text: "风吹动经幡的这一刻 山谷里只有风声" },
  { at: 9.8, to: 12.6, text: "Snow peaks, grasslands, and Tibetan songs" },
  { at: 13.0, to: 18.0, text: "把这一路的清透，留给你" },
];

const BRIEF = {
  作品类型: "生活vlog",
  视频生成提示词: "川西高原航拍，雪山倒映在草海晨光中，藏寨炊烟袅袅，经幡随风舞动，文艺清新的旅行vlog质感，镜头节奏明快",
  内容调性: "旅行文艺",
  账号调性: "文艺旅行账号",
  账号调性配置: { 艺术气息区间: [3, 5] },
  BGM节奏: "快",
  语言: "zh",
  平台: "抖音/快手",
  分辨率: [1080, 1920],
  气质关键词: ["文艺", "清新"],
};

const TITLE_TEXT = "川西之行 · WEST SICHUAN";

/** 演示弹幕（含滚动/顶部固定/底部固定与彩色条，密度在 1s 窗口上限内）。 */
const DANMAKU = [
  { at: 0.8, text: "这也太好看了吧" },
  { at: 1.0, text: "川西永远的神" },
  { at: 1.2, text: "求路线", colour: "#FFF200" },
  { at: 2.0, text: "雪山绝了", mode: "top" },
  { at: 6.5, text: "已收藏" },
  { at: 9.0, text: "藏寨好美" },
  { at: 13.5, text: "背景音乐是什么", mode: "bottom" },
];

/** 演示贴纸/花字（停留 1.5~3s，落点避开平台遮挡区）。 */
const STICKERS = [
  { text: "川西必去", start: 1.0, end: 3.5, x: 0.5, y: 0.24, preset: "撞色" },
  { text: "收藏", start: 13.4, end: 15.8, x: 0.26, y: 0.62, preset: "奶油" },
];

/** 演示英文轨（双语字幕第二行；与中文 SRT 同时间轴）。 */
const EN_SRT = `1
00:00:00,600 --> 00:00:03,400
Snow peaks reflected in the morning light

2
00:00:03,600 --> 00:00:06,200
Tibetan smoke is a letter to the sky

3
00:00:06,600 --> 00:00:09,400
Only the wind in the valley

4
00:00:09,800 --> 00:00:12,600
Snow peaks, grasslands, and Tibetan songs

5
00:00:13,000 --> 00:00:18,000
Keep this clarity for you
`;

function arg(name, fallback = null) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : fallback;
}

function run(bin, args, label) {
  process.stderr.write(`  · ${label}\n`);
  execFileSync(bin, args, { stdio: ["ignore", "ignore", "pipe"] });
}

function srtTime(seconds) {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${s.toFixed(3).padStart(6, "0")}`;
}

/** 造一条 24 秒竖屏素材：四段硬切，含深色/浅色/复杂三种底，供"可读性决策"真实生效。 */
function buildSourceVideo({ outFile, workDir, bins }) {
  const shotFiles = [];
  SHOTS.forEach((shot, index) => {
    const file = path.join(workDir, `shot-${index + 1}.mp4`);
    const source = shot.pattern
      ? ["-f", "lavfi", "-i", `testsrc2=size=1080x1920:rate=25:duration=${shot.seconds}`]
      : ["-f", "lavfi", "-i", `color=c=${shot.color}:size=1080x1920:rate=25:duration=${shot.seconds}`];
    run(bins.ffmpeg, [
      "-hide_banner", "-v", "error", "-y",
      ...source,
      "-vf", "noise=alls=6:allf=t+u",
      "-c:v", "libx264", "-preset", "veryfast", "-crf", "24", "-pix_fmt", "yuv420p", file,
    ], `造画面 · ${shot.id} ${shot.note}`);
    shotFiles.push(file);
  });
  const listFile = path.join(workDir, "shots.txt");
  fs.writeFileSync(listFile, shotFiles.map((file) => `file '${file}'`).join("\n"));
  run(bins.ffmpeg, [
    "-hide_banner", "-v", "error", "-y",
    "-f", "concat", "-safe", "0", "-i", listFile,
    "-f", "lavfi", "-i", "anoisesrc=duration=24:color=pink:amplitude=0.02:seed=7",
    "-map", "0:v:0", "-map", "1:a:0", "-c:v", "copy", "-c:a", "aac", "-b:a", "128k",
    "-movflags", "+faststart", "-shortest", outFile,
  ], "拼接素材（4 段硬切 + 环境声）");
  return outFile;
}

function writeSrt(file) {
  const body = LINES.map((line, index) => [
    String(index + 1),
    `${srtTime(line.at)} --> ${srtTime(line.to)}`,
    line.text,
  ].join("\n")).join("\n\n");
  fs.writeFileSync(file, `${body}\n`, "utf8");
  return file;
}

async function main() {
  const outDir = arg("--out", path.join(process.cwd(), "subtitle-demo"));
  const platform = arg("--platform", "抖音/快手");
  const fontsDir = arg("--fonts-dir", process.env.WORKLOOM_SUBTITLE_FONTS_DIR ?? null);
  const bins = resolveBinaries();
  fs.mkdirSync(outDir, { recursive: true });
  const workDir = path.join(outDir, "work");
  fs.mkdirSync(workDir, { recursive: true });

  const source = path.join(outDir, "source.mp4");
  const srt = path.join(outDir, "subtitle.srt");
  const briefPath = path.join(outDir, "brief.json");
  const evidenceDir = path.join(outDir, "evidence");
  const analyzeDir = path.join(outDir, "analyze");
  fs.mkdirSync(evidenceDir, { recursive: true });
  fs.mkdirSync(analyzeDir, { recursive: true });

  process.stderr.write("① 工位健康\n");
  const healthReport = await health();
  if (!healthReport.ok) throw new Error(`工位不可用：${healthReport.renderCapabilityError ?? "缺少 ffmpeg/ass 滤镜"}`);
  process.stderr.write(`  · ffmpeg=${healthReport.ffmpeg} · 字体 ${healthReport.fonts.installed}/${healthReport.fonts.total} · 编码器 ${healthReport.videoEncoder}\n`);

  process.stderr.write("② 造素材与字幕\n");
  buildSourceVideo({ outFile: source, workDir, bins });
  writeSrt(srt);
  fs.writeFileSync(briefPath, `${JSON.stringify({ ...BRIEF, 平台: platform }, null, 2)}\n`, "utf8");

  const brief = { ...BRIEF, 平台: platform };
  process.stderr.write("③ 画面可读性诊断\n");
  const diagnosis = await analyzeVideo({ input: source, platform, evidenceDir: analyzeDir, bins });

  process.stderr.write("④ 选型与方案\n");
  const subtitlePicks = selectFonts({ brief, scene: "字幕", top: 3, fontsDir });
  const titlePicks = selectFonts({ brief, scene: "标题", top: 3, fontsDir });
  const planOutcome = await plan({
    input: source,
    brief,
    platform,
    titleText: TITLE_TEXT,
    cues: (await import("./core.mjs")).parseSrt(fs.readFileSync(srt, "utf8")),
    fontsDir,
    bins,
    outputDir: outDir,
    evidenceDir: analyzeDir,
  });

  process.stderr.write("⑤ 烧录成片（字幕 + 片头标题）\n");
  const burned = await renderWithSubtitles({
    mode: "both",
    input: source,
    output: path.join(outDir, "burned.mp4"),
    cues: (await import("./core.mjs")).parseSrt(fs.readFileSync(srt, "utf8")),
    titleText: TITLE_TEXT,
    brief,
    platform,
    fontsDir,
    evidenceDir,
    bins,
  });

process.stderr.write("⑥ 择优出片（候选池打分）\n");
  const bestOutcome = await best({
    input: source,
    output: path.join(outDir, "best.mp4"),
    cues: (await import("./core.mjs")).parseSrt(fs.readFileSync(srt, "utf8")),
    titleText: TITLE_TEXT,
    brief,
    platform,
    fontsDir,
    evidenceDir,
    bins,
  });

  process.stderr.write("⑦ 弹幕 / 贴纸 / 卡拉OK / 双语字幕\n");
  const cues = (await import("./core.mjs")).parseSrt(fs.readFileSync(srt, "utf8"));
  const danmakuReport = await renderDanmaku({
    input: source,
    output: path.join(outDir, "danmaku.mp4"),
    items: DANMAKU,
    brief,
    platform,
    evidenceDir,
    bins,
  });
  const stickerReport = await renderSticker({
    input: source,
    output: path.join(outDir, "sticker.mp4"),
    stickers: STICKERS,
    brief,
    platform,
    evidenceDir,
    bins,
  });
  const karaokeReport = await renderKaraoke({
    input: source,
    output: path.join(outDir, "karaoke.mp4"),
    cues: cues.slice(0, 3),
    brief,
    platform,
    evidenceDir,
    bins,
  });
  const bilingualReport = await renderWithSubtitles({
    mode: "subtitle",
    input: source,
    output: path.join(outDir, "bilingual.mp4"),
    cues,
    secondaryCues: (await import("./core.mjs")).parseSrt(EN_SRT),
    brief,
    platform,
    evidenceDir,
    bins,
  });

  const recipes = findRecipes({ genre: "旅拍" });
  const report = {
    schemaVersion: "workloom.subtitle-demo/v1",
    generatedAt: new Date().toISOString(),
    platform,
    brief,
    health: {
      ffmpeg: healthReport.ffmpeg,
      fontsInstalled: healthReport.fonts.installed,
      fontsTotal: healthReport.fonts.total,
      encoder: healthReport.videoEncoder,
    },
    diagnosis: { summary: diagnosis.summary, frames: diagnosis.frames.map((frame) => ({ at: frame.at, file: frame.file })) },
    selection: {
      字幕: subtitlePicks.top,
      标题: titlePicks.top,
    },
    recipe: recipes.recipe?.id ?? null,
    plan: {
      path: planOutcome.planPath,
      assPath: planOutcome.assPath,
      checks: planOutcome.checks,
      fonts: planOutcome.plan.selection,
    },
    burned: {
      path: burned.output.path,
      sha256: burned.output.hash,
      encoder: burned.encoder,
      timeline: burned.timeline,
      presence: burned.presence,
      checks: burned.checks,
      layoutChecks: burned.layoutChecks,   // kit/selftest.sh 的指标核验读这一段（版式体检逐项）
      evidence: burned.evidence,
    },
    best: bestOutcome.verdict === "scored"
      ? {
        verdict: bestOutcome.verdict,
        winner: bestOutcome.winner,
        output: bestOutcome.output,
        candidates: bestOutcome.candidates.map((item) => ({
          fontName: item.fontName, variant: item.variant, composite: item.composite,
          contrast: item.contrast, edgeDensityUnit: item.edgeDensityUnit,
        })),
      }
      : bestOutcome,
    danmaku: {
      path: danmakuReport.output.path,
      sha256: danmakuReport.output.hash,
      font: danmakuReport.font,
      density: danmakuReport.density,
      tracks: danmakuReport.tracks,
      presence: danmakuReport.presence,
      checks: danmakuReport.checks,
    },
    sticker: {
      path: stickerReport.output.path,
      sha256: stickerReport.output.hash,
      placements: stickerReport.placements,
      entranceMs: stickerReport.entranceMs,
      presence: stickerReport.presence,
      checks: stickerReport.checks,
    },
    karaoke: {
      path: karaokeReport.output.path,
      sha256: karaokeReport.output.hash,
      timing: karaokeReport.timing,
      highlightColour: karaokeReport.highlightColour,
      presence: karaokeReport.presence,
      checks: karaokeReport.checks,
    },
    bilingual: {
      path: bilingualReport.output.path,
      sha256: bilingualReport.output.hash,
      checks: bilingualReport.checks,
      presence: bilingualReport.presence.delta,
    },
  };
  fs.writeFileSync(path.join(outDir, "report.json"), `${JSON.stringify(report, null, 2)}\n`, "utf8");

  const readme = [
    "# 字幕工位演示产物（真机导出一组）",
    "",
    `生成时间：${report.generatedAt}｜平台：${platform}｜工位字体：${healthReport.fonts.installed}/${healthReport.fonts.total}`,
    "",
    "| 产物 | 说明 |",
    "|---|---|",
    "| `source.mp4` | 自造竖屏素材：4 段硬切 + 深色/浅色/复杂三种底 + 环境声 |",
    "| `subtitle.srt` | 演示字幕（含长句与中英混排） |",
    "| `brief.json` | 视频简报（生活vlog / 文艺旅行 / 快节奏 / 抖音） |",
    "| `subtitle-plan.json` / `.ass` | 选型与版式方案：字体、字号、描边、边距、版式体检 |",
    "| `burned.mp4` | 烧录成片（字幕 + 片头标题），带复检回执 |",
    "| `best.mp4` | 择优出片（字体×描边候选池打分后的赢家） |",
    "| `danmaku.mp4` | 弹幕轨（滚动 + 顶部/底部固定，密度熔断） |",
    "| `sticker.mp4` | 贴纸/花字（200ms 弹入 + 安全区校验） |",
    "| `karaoke.mp4` | 卡拉OK 逐字扫过（\\kf） |",
    "| `bilingual.mp4` | 双语字幕（中文主行 + 英文次行） |",
    "| `evidence-*.png` | 交付证据帧（标题帧 / 首条字幕 / 末条字幕） |",
    "| `analyze-*.png` | 画面可读性诊断抽帧 |",
    "| `report.json` | 全量指标：选型理由、版式体检、字幕可现度、时间轴回读、sha256 |",
    "",
    "## 复现",
    "",
    "```bash",
    "bash bundles/ai-video/connectors/subtitle-bridge/kit/install-fonts.sh --from-dir <字体包>/fonts",
    `node bundles/ai-video/connectors/subtitle-bridge/demo-artifacts.mjs --out ${outDir}`,
    "```",
    "",
    "## 关键指标",
    "",
    `- 字幕字体：${burned.fonts.字幕?.name ?? "-"}（${burned.fonts.字幕?.score ?? "-"} 分）；标题字体：${burned.fonts.标题?.name ?? "-"}（${burned.fonts.标题?.score ?? "-"} 分）`,
    `- 字幕字号：${burned.styles.find((style) => style.name === "Sub")?.fontSize ?? "-"}px；标题字号：${burned.styles.find((style) => style.name === "Title")?.fontSize ?? "-"}px`,
    `- 版式体检：${burned.layoutChecks.map((check) => `${check.kind}=${check.ok ? "ok" : "fail"}`).join(" ")}`,
    `- 字幕可现度：Δ${burned.presence.delta}（阈值 ${burned.presence.threshold}）`,
    `- 时间轴回读：${burned.timeline.cues}/${burned.timeline.sourceCues} 条一致`,
    `- 成片 sha256：\`${burned.output.hash}\``,
    "",
  ].join("\n");
  fs.writeFileSync(path.join(outDir, "README.md"), readme, "utf8");

  process.stdout.write(`${JSON.stringify({
    ok: true,
    outDir,
    platform,
    source,
    srt,
    burned: { path: burned.output.path, sha256: burned.output.hash },
    best: bestOutcome.verdict === "scored" ? { path: bestOutcome.output.path, winner: bestOutcome.winner } : bestOutcome,
    fonts: { 字幕: burned.fonts.字幕?.name, 标题: burned.fonts.标题?.name },
    checks: burned.checks,
    presence: { delta: burned.presence.delta, threshold: burned.presence.threshold },
    timeline: { cues: burned.timeline.cues, sourceCues: burned.timeline.sourceCues, ok: burned.timeline.ok },
  }, null, 2)}\n`);
  return 0;
}

main()
  .then((code) => process.exit(code))
  .catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
    process.exit(1);
  });
