#!/usr/bin/env node
/**
 * subtitle-cli —— 字幕工位命令行（字幕师数字员工的"手"）。
 *
 * 用法：
 *   subtitle-cli health
 *   subtitle-cli probe      --in clip.mp4
 *   subtitle-cli analyze    --in clip.mp4 [--platform 抖音/快手] [--evidence-dir dir] [--times 1,3,5]
 *   subtitle-cli fonts      --scene 字幕 [--brief brief.json] [--平台 抖音/快手] [--top 3]
 *   subtitle-cli recipes    [--list] [--genre 旅拍] [--id outdoor-travel] [--platform B站]
 *   subtitle-cli plan       --in clip.mp4 [--srt subs.srt] [--title "川西之行"] [--platform 抖音/快手]
 *                           [--brief brief.json] [--out-dir dir] [--evidence-dir dir]
 *   subtitle-cli burn       --in clip.mp4 --out out.mp4 --srt subs.srt [--title "…"] [--platform …]
 *                           [--brief brief.json] [--evidence-dir dir]
 *   subtitle-cli title      --in clip.mp4 --out out.mp4 --title "川西之行 · WEST SICHUAN" [--srt subs.srt]
 *   subtitle-cli danmaku    --in clip.mp4 --out out.mp4 --items danmaku.json [--opacity 0.85]
 *   subtitle-cli sticker    --in clip.mp4 --out out.mp4 --items stickers.json
 *   subtitle-cli karaoke    --in clip.mp4 --out out.mp4 --srt subs.srt [--srt-en subs.en.srt] [--timings words.json]
 *   subtitle-cli sidecar    --out-dir dir [--in master.mp4] --srt subs.srt [--srt-en subs.en.srt] [--name film]
 *                           [--platform 抖音/快手] [--brief brief.json] [--evidence-dir dir]
 *   subtitle-cli softmux    --in master.mp4 --out master-softsub.mp4 --srt subs.srt [--srt-en subs.en.srt]
 *                           [--lang chi] [--lang-en eng]        # 字幕轨可开关，画面零改动
 *   subtitle-cli best       --in clip.mp4 --out out.mp4 --srt subs.srt [--title "…"] [--min-score 80]
 *
 * 退出码：0 成功；2 用法错误；3 工具错误（code 见 SubtitleError）。
 * 任何写入都落到新文件；覆盖原片一律拒绝；字体目录默认 ~/.workloom-subtitle/fonts。
 */

import fs from "node:fs";
import process from "node:process";

import {
  SubtitleError, best, callTool, exportSidecars, findRecipes, health, parseSrt, plan, renderDanmaku,
  renderKaraoke, renderSticker, renderTitle, renderWithSubtitles, selectFonts, softMux,
} from "./core.mjs";

function parseArgs(argv) {
  const positional = [];
  const flags = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token.startsWith("--")) {
      const key = token.slice(2);
      const next = argv[index + 1];
      if (next === undefined || next.startsWith("--")) flags[key] = true;
      else { flags[key] = next; index += 1; }
    } else {
      positional.push(token);
    }
  }
  return { positional, flags };
}

function number(value, fallback = null) {
  if (value === undefined || value === true) return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function readBrief(flags) {
  if (typeof flags.brief === "string") return JSON.parse(fs.readFileSync(flags.brief, "utf8"));
  const brief = {};
  if (typeof flags["作品类型"] === "string") brief.作品类型 = flags["作品类型"];
  if (typeof flags["内容调性"] === "string") brief.内容调性 = flags["内容调性"];
  if (typeof flags["账号调性"] === "string") brief.账号调性 = flags["账号调性"];
  if (typeof flags["气质关键词"] === "string") brief.气质关键词 = String(flags["气质关键词"]).split(",");
  if (typeof flags["语言"] === "string") brief.语言 = flags["语言"];
  if (typeof flags["BGM节奏"] === "string") brief["BGM节奏"] = flags["BGM节奏"];
  if (typeof flags["平台"] === "string") brief.平台 = flags["平台"];
  if (typeof flags["video-prompt"] === "string") brief.视频生成提示词 = flags["video-prompt"];
  if (typeof flags.platform === "string") brief.平台 = flags.platform;
  return brief;
}

async function main() {
  const [command, ...rest] = process.argv.slice(2);
  const { flags } = parseArgs(rest);
  const line = (text = "") => process.stdout.write(`${text}\n`);

  switch (command) {
    case "health": {
      const result = await health();
      line(JSON.stringify(result, null, 2));
      return 0;
    }
    case "probe": {
      const { result } = await callTool("subtitleread.probe", { input_path: flags.in });
      line(JSON.stringify(result, null, 2));
      return 0;
    }
    case "analyze": {
      const { result } = await callTool("subtitleread.analyze", {
        input_path: flags.in,
        platform: typeof flags.platform === "string" ? flags.platform : undefined,
        evidence_dir: typeof flags["evidence-dir"] === "string" ? flags["evidence-dir"] : undefined,
        times: typeof flags.times === "string" ? flags.times.split(",").map(Number) : undefined,
      });
      line(`素材：${result.input}（${result.resolution.join("x")} · ${result.duration}s · ${result.orientation}）`);
      line(`平台版式：${result.platform}`);
      line(`字幕带平均亮度 ${(result.summary.meanSubtitleBandLumaUnit * 100).toFixed(1)}% · 最碎帧细节密度 ${(result.summary.worstSubtitleEdgeDensityUnit * 100).toFixed(1)}%（t=${result.summary.worstFrameAt}s）`);
      line(`字幕带命中遮挡区：${result.summary.subtitleBandHitsOcclusion.join("、") || "无"}`);
      line(`标题带命中遮挡区：${result.summary.titleBandHitsOcclusion.join("、") || "无"}`);
      for (const frame of result.frames) {
        line(`  帧 t=${frame.at}s：整帧亮度 ${frame.whole.lumaAvg} · 字幕带 ${frame.subtitleBand.lumaAvg}/{${frame.subtitleBand.edgeDensityUnit}} · 标题带 ${frame.titleBand.lumaAvg}`);
      }
      if (result.recommendation.subtitleNeedsLift) line("⚠ 字幕带压在平台 UI 遮挡区：版式需上抬或换边（G-SUB3 硬线）");
      line(`证据目录：${result.evidenceDir}`);
      return 0;
    }
    case "fonts": {
      const brief = readBrief(flags);
      const selection = selectFonts({
        brief,
        scene: typeof flags.scene === "string" ? flags.scene : "字幕",
        top: number(flags.top, 3),
      });
      line(`场景 ${selection.scene} · 平台 ${selection.platform} · 候选 ${selection.considered} 款${selection.pinned ? "（账号锁定字体优先）" : ""}`);
      for (const item of selection.top) {
        line(`  ${String(item.score).padStart(5)}  ${item.name}（${item.fontFamily} · ${item.license}${item.installed === false ? " · 未安装" : ""}）`);
        line(`         ${item.reasons.join("；")}`);
        line(`         字号 ${item.size.sizePx}px / 描边 ${item.size.outlinePx}px（${item.size.basis}）`);
      }
      if (selection.note) line(`说明：${selection.note}`);
      return 0;
    }
    case "recipes": {
      const result = findRecipes({
        recipeId: typeof flags.id === "string" ? flags.id : null,
        genre: typeof flags.genre === "string" ? flags.genre : null,
        platform: typeof flags.platform === "string" ? flags.platform : null,
        list: flags.list === true || (!flags.id && !flags.genre && !flags.platform),
      });
      if (result.items && result.recipe === undefined) {
        line(`版式配方库：${result.total} 条`);
        line(`原则：${result.principle}`);
        for (const item of result.items) {
          line(`  ${item.id.padEnd(18)} ${item.genre} · ${item.mood} · 标题 ${item.titleFont.slice(0, 2).join("/")} · 字幕 ${item.subtitleFont.slice(0, 2).join("/")}`);
        }
        return 0;
      }
      if (!result.recipe) {
        line("没有匹配的配方");
        return 0;
      }
      const recipe = result.recipe;
      line(`${recipe.id} — ${recipe.genre} / ${recipe.scene} / ${recipe.mood}`);
      line(`  字幕字体倾向：${recipe.subtitleFont.join(" / ")}`);
      line(`  标题字体倾向：${recipe.titleFont.join(" / ")}`);
      line(`  艺术气息上限 ${recipe.artMax} · 描边比 ${recipe.outlineRatio} · 底衬 ${recipe.backdrop} · 平台 ${recipe.platforms.join("、")}`);
      line(`  禁忌：${recipe.avoid.join("、")}`);
      if (recipe.notes) line(`  备注：${recipe.notes}`);
      return 0;
    }
    case "plan": {
      const outcome = await plan({
        input: typeof flags.in === "string" ? flags.in : null,
        brief: readBrief(flags),
        platform: typeof flags.platform === "string" ? flags.platform : null,
        titleText: typeof flags.title === "string" ? flags.title : "",
        cues: flags.srt ? (await import("./core.mjs")).parseSrt(fs.readFileSync(flags.srt, "utf8")) : [],
        outputDir: typeof flags["out-dir"] === "string" ? flags["out-dir"] : null,
        evidenceDir: typeof flags["evidence-dir"] === "string" ? flags["evidence-dir"] : null,
      });
      line(`方案：${outcome.planPath}`);
      line(`平台版式：${outcome.plan.platform} · 分辨率 ${outcome.plan.resolution.join("x")} · 事件 ${outcome.plan.events} 条`);
      for (const [scene, entry] of Object.entries(outcome.plan.selection)) {
        line(`  ${scene}：${entry.chosen.name}（${entry.chosen.score} 分 · 字号 ${entry.chosen.size.sizePx}px）`);
      }
      for (const check of outcome.checks) {
        line(`  ${check.ok ? "✓" : "✗"} ${check.kind}${check.ok ? "" : ` — ${JSON.stringify(check.detail ?? check.note)}`}`);
      }
      return 0;
    }
    case "burn": {
      const report = await renderWithSubtitles({
        mode: flags.title ? "both" : "subtitle",
        input: flags.in,
        output: flags.out,
        cues: (await import("./core.mjs")).parseSrt(fs.readFileSync(flags.srt, "utf8")),
        titleText: typeof flags.title === "string" ? flags.title : "",
        brief: readBrief(flags),
        platform: typeof flags.platform === "string" ? flags.platform : null,
        evidenceDir: typeof flags["evidence-dir"] === "string" ? flags["evidence-dir"] : null,
      });
      line(`已烧录：${report.output.path}（${report.encoder}）`);
      line(`  字幕字体 ${report.fonts.字幕?.name ?? "-"} · 标题字体 ${report.fonts.标题?.name ?? "-"}`);
      line(`  时间轴回读 ${report.timeline.cues}/${report.timeline.sourceCues} 条（${report.timeline.ok ? "一致" : "不一致"}）`);
      line(`  字幕可现度 Δ${report.presence.delta}（阈值 ${report.presence.threshold}，t=${report.presence.at}s）`);
      line(`  标点体检 ${report.checks.punctuation_ok ? "ok" : "fail"}（口径：字幕不带标点；数字内的 . : - / 保留）`);
      line(`  版式体检：${report.layoutChecks.map((check) => `${check.kind}=${check.ok ? "ok" : "fail"}`).join(" ")}`);
      line(`  sha256 ${report.output.hash}`);
      return 0;
    }
    case "title": {
      const report = await renderTitle({
        input: flags.in,
        output: flags.out,
        titleText: flags.title,
        cues: flags.srt ? (await import("./core.mjs")).parseSrt(fs.readFileSync(flags.srt, "utf8")) : [],
        brief: readBrief(flags),
        platform: typeof flags.platform === "string" ? flags.platform : null,
        evidenceDir: typeof flags["evidence-dir"] === "string" ? flags["evidence-dir"] : null,
      });
      line(`已渲染标题：${report.output.path}`);
      line(`  标题字体 ${report.fonts.标题?.name ?? "-"} · 事件 ${report.timeline.titleEvents} 条`);
      line(`  sha256 ${report.output.hash}`);
      return 0;
    }
    case "danmaku": {
      const report = await renderDanmaku({
        input: flags.in,
        output: flags.out,
        items: flags.items ? JSON.parse(fs.readFileSync(flags.items, "utf8")) : (flags["items-json"] ? JSON.parse(flags["items-json"]) : []),
        platform: typeof flags.platform === "string" ? flags.platform : null,
        brief: readBrief(flags),
        evidenceDir: typeof flags["evidence-dir"] === "string" ? flags["evidence-dir"] : null,
        opacity: number(flags.opacity, 0.85),
        maxChars: number(flags["max-chars"], 20),
        maxConcurrent: number(flags["max-concurrent"], 8),
      });
      line(`已渲染弹幕：${report.output.path}`);
      line(`  条数 ${report.density.kept}/${report.density.total}（窗口 ${report.density.windowSec}s 并发峰值 ${report.density.peakConcurrent}/${report.density.maxConcurrent}${report.density.trimmed ? `，抽稀 ${report.density.trimmed}` : ""}）`);
      line(`  字体 ${report.font.name} · 字号 ${report.style.fontSize}px · 透明度 ${report.opacity}`);
      line(`  复检：${Object.entries(report.checks).map(([k, v]) => `${k}=${v ? "ok" : "fail"}`).join(" ")}`);
      line(`  sha256 ${report.output.hash}`);
      return 0;
    }
    case "sticker": {
      const report = await renderSticker({
        input: flags.in,
        output: flags.out,
        stickers: flags.items ? JSON.parse(fs.readFileSync(flags.items, "utf8")) : (flags["items-json"] ? JSON.parse(flags["items-json"]) : []),
        platform: typeof flags.platform === "string" ? flags.platform : null,
        brief: readBrief(flags),
        evidenceDir: typeof flags["evidence-dir"] === "string" ? flags["evidence-dir"] : null,
      });
      line(`已渲染贴纸：${report.output.path}`);
      for (const item of report.placements) {
        line(`  「${item.text}」 ${item.preset} · ${item.start}s~${item.end}s（停留 ${item.holdSec}s）· 中心 ${item.centre.x},${item.centre.y}`);
      }
      line(`  复检：${Object.entries(report.checks).map(([k, v]) => `${k}=${v ? "ok" : "fail"}`).join(" ")}`);
      line(`  sha256 ${report.output.hash}`);
      return 0;
    }
    case "karaoke": {
      const cues = (await import("./core.mjs")).parseSrt(fs.readFileSync(flags.srt, "utf8"));
      const secondary = flags["srt-en"] ? (await import("./core.mjs")).parseSrt(fs.readFileSync(flags["srt-en"], "utf8")) : [];
      const timings = flags.timings ? JSON.parse(fs.readFileSync(flags.timings, "utf8")) : null;
      const report = await renderKaraoke({
        input: flags.in,
        output: flags.out,
        cues,
        timings,
        timingMode: typeof flags["timing-mode"] === "string" ? flags["timing-mode"] : "even",
        secondaryCues: secondary,
        platform: typeof flags.platform === "string" ? flags.platform : null,
        brief: readBrief(flags),
        evidenceDir: typeof flags["evidence-dir"] === "string" ? flags["evidence-dir"] : null,
        highlightColour: typeof flags["highlight"] === "string" ? flags["highlight"] : "#FFE066",
      });
      line(`已渲染卡拉OK：${report.output.path}`);
      for (const row of report.timing) {
        line(`  cue#${row.cue} 口径 ${row.basis} · 字幕时长 ${row.cueDuration}s · 逐字合计 ${row.sum}s（误差 ${row.sumErrorSec}s）`);
      }
      line(`  复检：${Object.entries(report.checks).map(([k, v]) => `${k}=${v ? "ok" : "fail"}`).join(" ")}`);
      line(`  sha256 ${report.output.hash}`);
      return 0;
    }
    case "sidecar": {
      // 旁挂字幕交付：只出字幕文件（srt/ass/vtt + 清单），**不烧进画面**——带字幕/不带字幕留给后期决定。
      const cues = flags.srt ? parseSrt(fs.readFileSync(flags.srt, "utf8")) : [];
      const cuesEn = flags["srt-en"] ? parseSrt(fs.readFileSync(flags["srt-en"], "utf8")) : [];
      const outcome = await exportSidecars({
        input: typeof flags.in === "string" ? flags.in : null,
        outputDir: typeof flags["out-dir"] === "string" ? flags["out-dir"] : ".",
        name: typeof flags.name === "string" ? flags.name : null,
        cues,
        cuesEn,
        titleText: typeof flags.title === "string" ? flags.title : "",
        platform: typeof flags.platform === "string" ? flags.platform : null,
        brief: readBrief(flags),
        evidenceDir: typeof flags["evidence-dir"] === "string" ? flags["evidence-dir"] : null,
        analyze: flags["no-analyze"] !== true,
      });
      line(`旁挂字幕交付：${outcome.outputDir}`);
      for (const file of outcome.files) {
        line(`  ${file.path.split("/").pop()} · ${file.role}/${file.lang}/${file.format} · ${file.bytes}B · sha256 ${file.sha256.slice(0, 12)}`);
      }
      line(`  时间轴回读 ${outcome.manifest.timeline.readback.ass ? "ok" : "fail"} · 条数 ${outcome.manifest.timeline.cues} · 母版未被改动 ${outcome.manifest.source ? (outcome.manifest.source.untouched ? "ok" : "fail") : "n/a"}`);
      /**
       * 标点体检必须打在**串口输出**里：管线（full-chain-film.mts）按 stdout 判读交付口径，
       * 只写进 manifest 会让"字幕带标点"这类返工项在日志里看不见。
       */
      const punctuationCheck = outcome.checks.find((check) => check.kind === "no_punctuation");
      line(`  标点体检 ${punctuationCheck?.ok === false ? "fail" : "ok"}（残留 ${punctuationCheck?.detail?.hits ?? 0} 处；口径：字幕不带标点，数字内的 . : - / 保留）`);
      line(`  清单：${outcome.manifestPath}`);
      line(`  结论：母版不含字幕（burnedIn=false）；要用软轨走 softmux，要硬字幕走 burn`);
      return outcome.passed ? 0 : 3;
    }
    case "softmux": {
      const tracks = [];
      if (flags.srt) tracks.push({ path: flags.srt, lang: typeof flags.lang === "string" ? flags.lang : "chi", title: "中文", default: true });
      if (flags["srt-en"]) tracks.push({ path: flags["srt-en"], lang: typeof flags["lang-en"] === "string" ? flags["lang-en"] : "eng", title: "English", default: tracks.length === 0 });
      const report = await softMux({ input: flags.in, output: flags.out, subtitles: tracks });
      line(`软字幕轨：${report.output}`);
      line(`  字幕轨 ${report.tracks.map((track) => `${track.lang}/${track.title}${track.default ? "(默认)" : ""}`).join("、")} · 编码 ${report.subtitleCodec}`);
      line(`  复检：${report.checks.map((check) => `${check.kind}=${check.ok ? "ok" : "fail"}`).join(" ")}`);
      line(`  sha256 ${report.sha256}`);
      return 0;
    }
    case "best": {
      const outcome = await best({
        input: flags.in,
        output: typeof flags.out === "string" ? flags.out : null,
        cues: flags.srt ? (await import("./core.mjs")).parseSrt(fs.readFileSync(flags.srt, "utf8")) : [],
        titleText: typeof flags.title === "string" ? flags.title : "",
        brief: readBrief(flags),
        platform: typeof flags.platform === "string" ? flags.platform : null,
        minScore: number(flags["min-score"], 80),
        evidenceDir: typeof flags["evidence-dir"] === "string" ? flags["evidence-dir"] : null,
        hasBurnedInSubtitles: flags["has-burned-in-subtitles"] === true,
      });
      if (outcome.verdict === "no_change_needed") {
        line(`结论：无需加字幕/无需改动 —— ${outcome.reason}`);
        return 0;
      }
      line("结论：已出片（择优）");
      line(`  赢家 ${outcome.winner.fontName} / ${outcome.winner.variant} · 得分 ${outcome.winner.score}（阈值 ${outcome.minScore}）`);
      line(`  成片 ${outcome.output.path} · sha256 ${outcome.sha256}`);
      return 0;
    }
    default:
      process.stderr.write(
        "用法：subtitle-cli <health|probe|analyze|fonts|recipes|plan|burn|title|danmaku|sticker|karaoke|sidecar|softmux|best> [--flags]\n"
        + "参见 bundles/ai-video/connectors/subtitle-bridge/README.md\n",
      );
      return 2;
  }
}

main()
  .then((code) => process.exit(code))
  .catch((error) => {
    const code = error instanceof SubtitleError ? error.code : "engine_failed";
    process.stderr.write(`${code}: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(3);
  });
