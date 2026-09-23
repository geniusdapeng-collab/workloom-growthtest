#!/usr/bin/env node
/**
 * 配乐工位演示：**提示词驱动取曲**（在线优先 → 本地曲库兜底）
 *
 *   node bundles/ai-video/connectors/bgm-bridge/demo-prompt-library.mjs --out <目录> [--film 成片.mp4]
 *
 * 产出：
 *   original.mp4                  原始成片（用户提供或脚本自造）
 *   bgm-mixed-online.mp4          走**在线曲源**（本机起一个 mock 音乐站，真实 HTTP + 真实许可闸）配乐后的成片
 *   bgm-mixed-library.mp4         在线不可用时**回退本地精选曲库**配乐后的成片
 *   bgm-brief.json                提示词 → 配乐简报（题材/情绪/禁忌/高潮落点/能量弧线）
 *   bgm-online-report.json        在线取曲全过程（检索 → 许可闸 → 下载 → 选段 → 混音 → 复检）
 *   bgm-library-report.json       本地兜底全过程（含降级原因）
 *   section-picked-online.png     选段证据（曲目波形 + 选中片段；片子波形 + 高潮点）
 *   README.md                     说明与复现命令
 */

import { createServer } from "node:http";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";

import { best } from "./core.mjs";
import { analyzePromptBrief } from "./brief.mjs";
import { probeMedia, resolveBinaries } from "./measure.mjs";

const bins = resolveBinaries();
const HERE = path.dirname(new URL(import.meta.url).pathname);

function arg(name, fallback = null) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : fallback;
}

const PROMPT = arg("--prompt", "美食探店：轻乳茶上新，茶香与奶香的特写，温柔治愈，保留现场声，结尾给优惠信息");

function makeDemoFilm(outFile, workDir) {
  const shots = [
    { color: "0x123a2f", label: "S01 门店空镜", ink: "white" },
    { color: "0xe8dcc8", label: "S02 茶汤特写", ink: "0x2a2318" },
    { color: "0x15525a", label: "S03 出品过程", ink: "white" },
    { color: "0xd9762a", label: "S04 优惠信息", ink: "0x26160a" },
  ];
  const files = shots.map((shot, index) => {
    const file = path.join(workDir, `shot-${index + 1}.mp4`);
    execFileSync(bins.ffmpeg, [
      "-hide_banner", "-v", "error", "-y",
      "-f", "lavfi", "-i", `color=c=${shot.color}:size=640x360:rate=25:duration=6`,
      "-vf", `drawtext=fontfile='/System/Library/Fonts/Supplemental/Arial Unicode.ttf':text='${shot.label}':`
        + `fontcolor=${shot.ink}@0.9:fontsize=26:x=40:y=300`,
      "-c:v", "libx264", "-preset", "veryfast", "-crf", "23", "-pix_fmt", "yuv420p", file,
    ]);
    return file;
  });
  const list = path.join(workDir, "shots.txt");
  fs.writeFileSync(list, files.map((file) => `file '${file}'`).join("\n"));
  const silent = path.join(workDir, "video-only.mp4");
  execFileSync(bins.ffmpeg, ["-hide_banner", "-v", "error", "-y", "-f", "concat", "-safe", "0", "-i", list, "-c", "copy", silent]);

  // 音轨：三段口播（say）+ 全程环境底噪
  const lines = [
    { at: 0.4, text: "这杯轻乳茶，用的是当天现泡的茶底。" },
    { at: 6.4, text: "茶汤只取前段，奶香压得住，三分糖刚刚好。" },
    { at: 18.4, text: "现在到店第二杯半价，活动到这个周日。" },
  ];
  const inputs = [];
  const filters = ["anoisesrc=duration=24:color=pink:amplitude=0.02:seed=11,lowpass=f=4500,volume=-16dB[amb]"];
  lines.forEach((line, index) => {
    const raw = path.join(workDir, `line-${index + 1}.aiff`);
    execFileSync("/usr/bin/say", ["-v", "Tingting", "-o", raw, line.text]);
    inputs.push("-i", raw);
    filters.push(`[${index}:a]aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=stereo,adelay=${Math.round(line.at * 1000)}|${Math.round(line.at * 1000)},volume=1.0[dlg${index}]`);
  });
  filters.push(`[amb]${lines.map((_, index) => `[dlg${index}]`).join("")}amix=inputs=${lines.length + 1}:duration=longest:dropout_transition=0:normalize=0[mix]`);
  filters.push("[mix]loudnorm=I=-18:TP=-2:LRA=11[aout]");
  const audio = path.join(workDir, "film-audio.wav");
  execFileSync(bins.ffmpeg, [
    "-hide_banner", "-v", "error", "-y", ...inputs,
    "-filter_complex", filters.join(";"), "-map", "[aout]", "-t", "24",
    "-c:a", "pcm_s16le", "-ar", "48000", "-ac", "2", audio,
  ]);
  execFileSync(bins.ffmpeg, [
    "-hide_banner", "-v", "error", "-y", "-i", silent, "-i", audio,
    "-map", "0:v:0", "-map", "1:a:0", "-c:v", "copy", "-c:a", "aac", "-b:a", "192k",
    "-movflags", "+faststart", "-shortest", outFile,
  ]);
}

/** 起一个本地 mock 音乐站：返回一首 CC0 曲目 + 一首 NC 曲目（用来演示"许可闸"）。 */
async function startMockMusicServer(libraryDir) {
  const curated = JSON.parse(fs.readFileSync(path.join(libraryDir, "tracks.json"), "utf8"));
  const pick = curated.tracks.find((track) => track.style === "lo-fi-chill") ?? curated.tracks[0];
  const audioPath = path.join(libraryDir, pick.file);
  const audio = fs.readFileSync(audioPath);
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    if (url.pathname === "/index") {
      const body = JSON.stringify({
        tracks: [
          {
            id: `mock-online-${pick.id}`, title: `在线源候选 · ${pick.title}`, artist: "Mock Music API",
            license: "cc0-1.0", url: "/audio/ok.m4a",
            durationSec: pick.durationSec, bpm: pick.bpm, genre: pick.genre, mood: pick.mood,
            tags: [...(pick.tags ?? []), "mock-online"], energy: pick.energyScore,
          },
          {
            id: "mock-online-nc", title: "在线源候选 · NC 曲目（应被拒收）", artist: "Mock Music API",
            license: "cc-by-nc-4.0", url: "/audio/nc.m4a",
            durationSec: 180, bpm: 92, genre: "夜景 / 都市", mood: "戏剧现代", energy: 0.8,
          },
        ],
      });
      res.writeHead(200, { "content-type": "application/json", "content-length": Buffer.byteLength(body) });
      res.end(body);
      return;
    }
    if (url.pathname === "/audio/ok.m4a" || url.pathname === "/audio/nc.m4a") {
      res.writeHead(200, { "content-type": "audio/mp4", "content-length": audio.length });
      res.end(audio);
      return;
    }
    res.writeHead(404).end();
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  return { server, port: server.address().port, trackId: `mock-online-${pick.id}` };
}

async function main() {
  const outDir = path.resolve(arg("--out", "outputs/bgm-demo-lib"));
  const libraryDir = path.resolve(HERE, "../../library/bgm-library-curated");
  const workDir = fs.mkdtempSync(path.join(process.env.TMPDIR ?? "/tmp", "bgm-demo-"));
  fs.mkdirSync(outDir, { recursive: true });
  const cacheDir = path.join(outDir, ".cache");

  const film = arg("--film", null);
  const original = path.join(outDir, "original.mp4");
  if (film) {
    fs.copyFileSync(path.resolve(film), original);
  } else {
    makeDemoFilm(original, workDir);
  }
  const probe = await probeMedia(original, { bins });
  console.log(`成片：${probe.duration.toFixed(1)}s`);

  const { brief, matched } = analyzePromptBrief({ promptText: PROMPT, durationSec: probe.duration });
  fs.writeFileSync(path.join(outDir, "bgm-brief.json"), `${JSON.stringify({ prompt: PROMPT, brief, matched }, null, 2)}\n`);
  console.log(`配乐简报：题材=${brief.recipeId} 能量=${brief.energyLevel} 禁忌=${brief.instrumentation.avoid.join("/") || "-"} 高潮=${brief.climax.position}${brief.climax.atSec ? `@${brief.climax.atSec}s` : ""}`);

  // ① 在线优先：起 mock 音乐站 → 走真实 HTTP 检索/许可闸/下载
  const mock = await startMockMusicServer(libraryDir);
  let onlineReport = null;
  try {
    onlineReport = await best({
      input: original,
      output: path.join(outDir, "bgm-mixed-online.mp4"),
      promptText: PROMPT,
      sourcePolicy: "online-first",
      destDir: cacheDir,
      evidenceDir: outDir,
      policy: brief.audioPolicy === "keep-all" ? "keep-all" : "keep-dialogue",
      env: { ...process.env, WORKLOOM_BGM_ONLINE_ENDPOINT: `http://127.0.0.1:${mock.port}/index` },
      bins,
    });
    fs.writeFileSync(path.join(outDir, "bgm-online-report.json"), `${JSON.stringify(onlineReport, null, 2)}\n`);
    console.log(`在线取曲：layer=${onlineReport.sourceResolution?.layer} 曲目=${onlineReport.track?.title ?? "-"} 选段=${onlineReport.report?.section?.chosen?.type ?? "-"} ${onlineReport.report?.section?.played?.startSec ?? ""}s→${onlineReport.report?.section?.chosen?.endSec ?? ""}s`);
  } finally {
    await new Promise((resolve) => mock.server.close(() => resolve()));
  }

  // ② 本地兜底：不给任何在线源（模拟未配置/断网）
  const libraryReport = await best({
    input: original,
    output: path.join(outDir, "bgm-mixed-library.mp4"),
    promptText: PROMPT,
    sourcePolicy: "online-first",
    destDir: path.join(cacheDir, "offline"),
    evidenceDir: outDir,
    policy: brief.audioPolicy === "keep-all" ? "keep-all" : "keep-dialogue",
    env: { ...process.env, WORKLOOM_BGM_ONLINE_ENDPOINT: "", JAMENDO_CLIENT_ID: "", FREESOUND_API_TOKEN: "", MUBERT_CUSTOMER_ID: "", MUBERT_ACCESS_TOKEN: "" },
    bins,
  });
  fs.writeFileSync(path.join(outDir, "bgm-library-report.json"), `${JSON.stringify(libraryReport, null, 2)}\n`);
  console.log(`本地兜底：layer=${libraryReport.sourceResolution?.layer} 曲目=${libraryReport.track?.title ?? "-"} 降级=${libraryReport.sourceResolution?.degraded}`);

  const readme = [
    "# BGM 配乐工位演示 · 提示词驱动 + 在线优先/本地兜底",
    "",
    `提示词（模拟"提交渲染的原始提示词"）：\n\n> ${PROMPT}`,
    "",
    "| 文件 | 说明 |",
    "|---|---|",
    "| `original.mp4` | 原始成片（口播 + 环境声） |",
    "| `bgm-mixed-online.mp4` | **在线曲源**版：脚本起本地 mock 音乐站，走真实 HTTP 检索 → 许可闸（NC 曲目被拒收）→ 下载 → 选段 → 混音 |",
    "| `bgm-mixed-library.mp4` | **本地曲库兜底**版：不给任何在线源，工位回退随仓精选曲库 |",
    "| `bgm-brief.json` | 提示词 → 配乐简报（题材/情绪/禁忌/高潮落点/能量弧线） |",
    "| `bgm-online-report.json` / `bgm-library-report.json` | 两条链路的完整回执（取曲 attempts / 选段理由 / 响度 / 让位 / 复检） |",
    "| `section-picked-*.png` | 选段证据（曲目波形红框=选中片段；片子波形红框=高潮点） |",
    "",
    "复现：",
    "",
    "```bash",
    "node bundles/ai-video/connectors/bgm-bridge/demo-prompt-library.mjs --out /tmp/bgm-demo-lib",
    "```",
    "",
    "> 在线链路用本地 mock 音乐站代替真实 provider——真实 provider（Jamendo / Freesound / Mubert / 客户自建索引）只要配好凭据就是同一条代码路径。",
    "> 曲库曲目全部为本仓自算合成（`workloom-self-generated`），不含任何第三方音频。",
    "",
  ].join("\n");
  fs.writeFileSync(path.join(outDir, "README.md"), readme);
  fs.rmSync(workDir, { recursive: true, force: true });
  console.log(`完成：${outDir}`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exit(1);
});
