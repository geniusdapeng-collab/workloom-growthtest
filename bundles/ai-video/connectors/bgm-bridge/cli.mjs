#!/usr/bin/env node
/**
 * bgm-cli —— 配乐工位命令行（BGM 配乐师数字员工的"手"）。
 *
 * 用法：
 *   bgm-cli health
 *   bgm-cli probe     --in clip.mp4
 *   bgm-cli analyze   --in clip.mp4 [--noise -38]
 *   bgm-cli recipes   [--list] [--genre 美食] [--mood 诱人温暖] [--id food]
 *   bgm-cli library   [--mood 温暖] [--track t1] [--commercial] [--attribution-out CREDITS.md]
 *   bgm-cli compose   --out bgm.wav (--in clip.mp4 | --duration 30) [--id food] [--genre 美食]
 *                     [--seed 2026] [--bpm 96] [--bpm-strategy cut-driven]
 *   bgm-cli mix       --in clip.mp4 --out scored.mp4 --bgm bgm.wav [--policy keep-dialogue]
 *                     [--music-level -22] [--ducking 12] [--lufs -14] [--evidence-dir dir]
 *                     [--track-license cc-by-4.0] [--attribution-out CREDITS.md]
 *   bgm-cli separate  --in clip.mp4 --out-dir dir [--engine auto|demucs|ffmpeg]
 *   bgm-cli best      --in clip.mp4 --out scored.mp4 [--genre 美食] [--mood 诱人温暖]
 *                     [--policy keep-dialogue] [--min-score 92] [--evidence-dir dir]
 *
 * 退出码：0 成功；2 用法错误；3 工具错误（code 见 BgmError）。
 * 任何写入都落到新文件；覆盖原片一律拒绝。
 */

import process from "node:process";

import { BgmError, analyze, analyzeStructure, best, callTool, compose, findRecipes, findTracks, mix, separate } from "./core.mjs";

function parseArgs(argv) {
  const positional = [];
  const flags = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token.startsWith("--")) {
      const key = token.slice(2);
      const next = argv[index + 1];
      if (next === undefined || next.startsWith("--")) {
        flags[key] = true;
      } else {
        flags[key] = next;
        index += 1;
      }
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

function fmt(value, digits = 2) {
  return Number.isFinite(value) ? Number(value).toFixed(digits) : "n/a";
}

async function main() {
  const [command, ...rest] = process.argv.slice(2);
  const { flags } = parseArgs(rest);
  const line = (text = "") => process.stdout.write(`${text}\n`);

  switch (command) {
    case "health": {
      const { result } = await callTool("bgmread.health", {});
      line(JSON.stringify(result, null, 2));
      return 0;
    }
    case "probe": {
      const { result } = await callTool("bgmread.probe", { input_path: flags.in });
      line(JSON.stringify(result, null, 2));
      return 0;
    }
    case "analyze": {
      const report = await analyze({ input: flags.in, noiseDb: number(flags.noise, -38) });
      line(`素材：${report.input}`);
      line(`时长 ${fmt(report.probe.duration)}s · 响度 ${fmt(report.loudness.integratedLufs)} LUFS · 真峰值 ${fmt(report.loudness.truePeakDbtp)} dBTP · LRA ${fmt(report.loudness.lra)}`);
      line(`人声频段活动：${(report.voice.activeRatio * 100).toFixed(1)}%（${report.voice.segments.length} 段，方法=${report.voice.method}）`);
      line(`人声电平 ${fmt(report.levels.voiceBandMeanDb)}dB · 环境底噪 ${fmt(report.levels.roomToneDb)}dB · BGM 可闻下限 ${fmt(report.levels.minAudibleMusicDb)}dB`);
      line(`剪辑点：${report.cuts.cuts.length} 个候选（硬切 ${report.cuts.strong?.length ?? 0} 个，阈值 ${report.cuts.strongThreshold ?? "-"}）`);
      line(`建议：policy=${report.recommendation.policy} · ducking=${report.recommendation.duckingDb}dB · 需要分离=${report.recommendation.needsSeparation ? "是" : "否"}`);
      if (report.existingBed.suspected) line(`⚠ 疑似已有配乐：${report.existingBed.reasons.join("；")}`);
      if (report.issues.length) {
        line("问题：");
        for (const issue of report.issues) line(`  [${issue.severity}] ${issue.kind} — ${issue.detail}`);
      }
      return 0;
    }
    case "structure": {
      const result = await analyzeStructure({
        input: flags.in,
        windowSec: number(flags.window, 0.25),
        minSegmentSec: number(flags["min-segment"], 3),
      });
      line(`曲目：${result.input} · ${result.durationSec}s${result.truncated ? "（超长，已按前 10 分钟分析）" : ""}`);
      line(`能量：均值 ${result.envelope.avgDb}dB · 峰值 ${result.envelope.peakDb}dB · 动态 ${result.structure.dynamicsDb}dB`);
      line(`拍速：${result.tempo.bpm ?? "未能估计"}（置信度 ${result.tempo.confidence}${result.tempo.reason ? ` · ${result.tempo.reason}` : ""}）`);
      line(`分段（${result.structure.method}）：`);
      for (const segment of result.structure.segments) {
        line(`  ${String(segment.type).padEnd(10)} ${String(segment.startSec).padStart(7)}s → ${String(segment.endSec).padStart(7)}s  平均 ${segment.avgDb}dB  峰值 ${segment.peakDb}dB  起音 ${segment.onsetDensity ?? "n/a"}`);
      }
      line("高潮候选：");
      for (const candidate of result.climax.candidates.slice(0, 3)) {
        line(`  ${candidate.id} ${candidate.type} ${candidate.startSec}s→${candidate.endSec}s 分 ${candidate.score}`);
      }
      if (result.structure.note) line(`说明：${result.structure.note}`);
      return 0;
    }
    case "recipes": {
      const result = findRecipes({
        recipeId: typeof flags.id === "string" ? flags.id : null,
        genre: typeof flags.genre === "string" ? flags.genre : null,
        mood: typeof flags.mood === "string" ? flags.mood : null,
        list: flags.list === true || (!flags.id && !flags.genre && !flags.mood),
      });
      if (result.items) {
        line(`配乐配方库：${result.total} 条`);
        line(`原则：${result.principle}`);
        for (const item of result.items) {
          line(`  ${item.id.padEnd(16)} ${item.genre} · ${item.mood} · ${item.key} ${item.mode} ${item.bpm}BPM · 电平 ${item.musicLevelDb}dB · 让位 ${item.duckingDb}dB`);
        }
      } else {
        const recipe = result.recipe;
        if (!recipe) {
          line("没有匹配的配方");
          return 0;
        }
        line(`${recipe.id} — ${recipe.genre} / ${recipe.scene} / ${recipe.mood}`);
        line(`  调性：${recipe.key} ${recipe.mode} · ${recipe.bpm}BPM · 和弦 ${recipe.chords.join("-")}`);
        line(`  配器：${recipe.instrumentation.join(" / ")}`);
        line(`  混音：BGM ${recipe.musicLevelDb}dB · 让位 ${recipe.duckingDb}dB`);
        line(`  禁忌：${(recipe.avoid ?? []).join("、") || "无"}`);
        if (recipe.notes) line(`  备注：${recipe.notes}`);
        if (result.alternatives.length) line(`  备选：${result.alternatives.join(", ")}`);
      }
      return 0;
    }
    case "library": {
      const result = findTracks({
        trackId: typeof flags.track === "string" ? flags.track : null,
        mood: typeof flags.mood === "string" ? flags.mood : null,
        genre: typeof flags.genre === "string" ? flags.genre : null,
        commercialUse: flags["commercial-only"] === true || flags.commercial === true,
      });
      line(`曲库目录：${result.libraryDir}（${result.libraryPresent ? `${result.total} 首` : "未接入"}）`);
      if (result.note) line(`说明：${result.note}`);
      for (const item of result.items) {
        line(`  ${item.id} · ${item.title ?? "-"} · ${item.mood ?? "-"} · ${item.bpm ?? "-"}BPM · ${item.licenseLabel} · 商用 ${item.commercialOk ? "可" : "不可"}`);
      }
      if (result.track?.attribution?.required) line(`署名（TASL）：${result.track.attribution.text}`);
      return 0;
    }
    case "compose": {
      const result = await compose({
        input: typeof flags.in === "string" ? flags.in : null,
        output: flags.out,
        recipeId: typeof flags.id === "string" ? flags.id : null,
        genre: typeof flags.genre === "string" ? flags.genre : null,
        mood: typeof flags.mood === "string" ? flags.mood : null,
        durationSeconds: number(flags.duration),
        seed: number(flags.seed, 0),
        bpmOverride: number(flags.bpm),
        bpmStrategy: flags["bpm-strategy"] === "cut-driven" ? "cut-driven" : "recipe",
      });
      line(`已生成 BGM：${result.output}`);
      line(`  配方 ${result.recipe.id} · ${result.plan.key} ${result.plan.mode} · ${result.plan.bpm}BPM（${result.tempo.source}）· ${result.plan.bars} 小节 · ${result.durationSeconds}s`);
      line(`  峰值 ${fmt(result.peakDbfs)}dBFS · RMS ${fmt(result.rmsDbfs)}dBFS · sha256 ${result.sha256}`);
      if (result.tempo.note) line(`  定速依据：${result.tempo.note}`);
      return 0;
    }
    case "mix": {
      const result = await mix({
        input: flags.in,
        output: flags.out,
        bgmPath: flags.bgm,
        policy: typeof flags.policy === "string" ? flags.policy : "keep-dialogue",
        bgmBpm: number(flags["bgm-bpm"]),
        /**
         * BPM 策略必须透传（2026-09-25 真机）：CLI 声明了 `--bpm-strategy cut-driven` 与 `--bpm`，
         * 但 mix 分支没把它们传进 core → tempo 永远取配方默认值（100BPM），
         * 于是"卡点"对任何曲子都报同一组数字（14/36、116.2ms），快剪片永远对齐不了。
         */
        bpmOverride: number(flags.bpm),
        bpmStrategy: flags["bpm-strategy"] === "cut-driven" ? "cut-driven" : "recipe",
        /** 显式剪辑网格：`--cut-times 5,10,15,20,25`（成片方给出真实剪辑点，优先于音轨起音反推） */
        cutTimes: typeof flags["cut-times"] === "string"
          ? String(flags["cut-times"]).split(",").map((value) => Number(value.trim())).filter((value) => Number.isFinite(value))
          : null,
        musicLevelDb: number(flags["music-level"]),
        duckingDb: number(flags.ducking),
        targetLufs: number(flags.lufs, -14),
        truePeak: number(flags["true-peak"], -1.0),
        evidenceDir: typeof flags["evidence-dir"] === "string" ? flags["evidence-dir"] : null,
        licenseReviewed: flags["license-unverified"] !== true,
        commercialUse: flags["non-commercial"] !== true,
        section: typeof flags.section === "string" ? flags.section : "full",
        sectionStartSec: number(flags["section-start"]),
        sectionEndSec: number(flags["section-end"]),
      });
      line(`已配乐：${result.output.path}`);
      line(`  策略 ${result.policy} · BGM ${result.mix.musicLevelDb}dB · 让位 ${result.levels.duckingDepthDb}dB · 人声余量 ${result.levels.speechToMusicMarginDb}dB · 配乐可闻度 ${result.levels.musicPresenceDb}dB`);
      line(`  响度 ${result.loudness.after.integratedLufs} LUFS / 真峰值 ${result.loudness.after.truePeakDbtp} dBTP（目标 ${result.mix.targetLufs} / ${result.mix.truePeak}）`);
      line(`  卡点：${result.alignment.verdict}（${result.alignment.alignedCount}/${result.alignment.cuts.length} 落在 ±${result.alignment.toleranceMs}ms 内，平均 ${result.alignment.meanAbsErrorMs}ms，BPM ${result.alignment.bpm}）`);
      if (result.section?.chosen) {
        line(`  选段：${result.section.mode} → ${result.section.chosen.type} ${result.section.played?.startSec ?? result.section.chosen.startSec}s→${result.section.chosen.endSec}s`);
        line(`        理由：${result.section.reason}`);
        if (result.section.filmPeakAlign?.note) line(`        对齐：${result.section.filmPeakAlign.note}`);
        else if (result.section.filmPeakAlign?.skipped) line(`        对齐：跳过（${result.section.filmPeakAlign.reason}）`);
      }
      line(`  sha256 ${result.output.hash}`);
      for (const warning of result.warnings) line(`  ⚠ ${warning}`);
      return 0;
    }
    case "separate": {
      const result = await separate({
        input: flags.in,
        outDir: flags["out-dir"],
        engine: typeof flags.engine === "string" ? flags.engine : "auto",
      });
      line(`已分离：${result.engine}（质量 ${result.quality}）`);
      line(`  人声：${result.vocals.path} · ${result.vocals.sha256}`);
      line(`  伴奏：${result.instrumental.path} · ${result.instrumental.sha256}`);
      line(`  说明：${result.qualityNote}`);
      for (const attempt of result.attempts) line(`  引擎尝试：${attempt.engine} → ${attempt.status}${attempt.detail ? `（${attempt.detail}）` : ""}`);
      return 0;
    }
    case "best": {
      const result = await best({
        input: flags.in,
        output: flags.out,
        genre: typeof flags.genre === "string" ? flags.genre : null,
        mood: typeof flags.mood === "string" ? flags.mood : null,
        policy: typeof flags.policy === "string" ? flags.policy : "keep-dialogue",
        minScore: number(flags["min-score"], 92),
        evidenceDir: typeof flags["evidence-dir"] === "string" ? flags["evidence-dir"] : null,
        seed: number(flags.seed, 0),
      });
      if (result.verdict === "no_bgm_needed") {
        line(`结论：无需配乐 —— ${result.reason}`);
        return 0;
      }
      line(`结论：已配乐（择优）`);
      line(`  赢家 ${result.winnerLabel} · 预估分 ${result.score}（阈值 ${result.minScore}）`);
      line(`  成片 ${result.report.output.path} · 响度 ${result.report.loudness.after.integratedLufs} LUFS · 让位 ${result.report.levels.duckingDepthDb}dB · 人声余量 ${result.report.levels.speechToMusicMarginDb}dB`);
      line(`  sha256 ${result.sha256}`);
      return 0;
    }
    default:
      process.stderr.write(
        "用法：bgm-cli <health|probe|analyze|recipes|library|compose|mix|separate|best> [--flags]\n"
        + "参见 bundles/ai-video/connectors/bgm-bridge/README.md\n",
      );
      return 2;
  }
}

main()
  .then((code) => process.exit(code))
  .catch((error) => {
    const code = error instanceof BgmError ? error.code : "engine_failed";
    process.stderr.write(`${code}: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(3);
  });
