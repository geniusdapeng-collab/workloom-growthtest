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
 *                     --audio-stems pinned-audio-reference.json
 *                     [--music-level -22] [--ducking 12] [--lufs -14] [--evidence-dir dir]
 *                     [--track-license cc-by-4.0] [--attribution-out CREDITS.md]
 *   bgm-cli separate  --in clip.mp4 --out-dir dir [--engine auto|demucs|ffmpeg]
 *   bgm-cli fetch     --prompt "国风古筝，中国古典" [--catalog chinese-classical]
 *                     [--duration 30] [--recipe food] [--source-policy online-first]
 *                     [--limit 8] [--dest-dir dir]
 *   bgm-cli tag       --in ~/Music/曲库包 --out ~/.workloom-bgm/library --license royalty-free
 *                     [--license-note "..."] [--license-source "..."] [--concurrency 6]
 *                     [--max-seconds 180] [--no-recursive] [--allow-overwrite]
 *   bgm-cli library   --scan                                   # 自动发现本机可用曲库（Downloads/Documents/Desktop/外接盘）
 *   bgm-cli library   --rebind ~/Documents/新位置 --library ~/.workloom-bgm/library --allow-overwrite [--verify sha256]
 *   bgm-cli library   --pack --library ~/.workloom-bgm/library [--out ~/Downloads/1200可商用纯音乐]
 *   bgm-cli best      --in clip.mp4 --out scored.mp4 [--genre 美食] [--mood 诱人温暖]
 *                     [--policy keep-dialogue] [--min-score 92] [--evidence-dir dir]
 *                     [--prompt "..."] [--source-policy online-first] [--catalog cinematic-score]
 *
 * 目录预设（catalog）：western-pop（欧美流行风格）/ chinese-classical（中国古典·国风）/
 *   cinematic-score（影视配乐）。它只改"检索条件"，不放宽许可闸——NC/ND/未知一律拒收。
 *
 * 退出码：0 成功；2 用法错误；3 工具错误（code 见 BgmError）。
 * 任何写入都落到新文件；覆盖原片一律拒绝。
 */

import process from "node:process";
import fs from "node:fs";

import { BgmError, analyze, analyzeStructure, best, callTool, compose, findRecipes, findTracks, mix, separate } from "./core.mjs";
import { CATALOGS } from "./sources.mjs";

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

/** 目录预设取值：未知名字 fail-closed（打错字不许静默降级成"随便找一首"）。 */
function catalogFlag(value) {
  if (value === undefined || value === true) return null;
  const name = String(value);
  if (!CATALOGS[name]) {
    throw new BgmError(`未知目录预设：${name}（可选 ${Object.keys(CATALOGS).join(" / ")}）`, "catalog_unknown");
  }
  return name;
}

function audioStemsFlag(value) {
  if (typeof value !== "string" || !value) throw new BgmError("--audio-stems 需要工程固定的签章分轨引用 JSON", "audio_stems_source_unverified", false);
  try { return JSON.parse(fs.readFileSync(value, "utf8")); }
  catch (error) { throw new BgmError(`音轨引用无法读取：${error.message}`, "bad_request", false); }
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
        audioStems: audioStemsFlag(flags["audio-stems"]),
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
    case "fetch": {
      // 在线取源（可单独调用）：提示词 → 简报 → 在线优先 → 本地兜底 → 自算作曲，逐级留痕
      const catalog = catalogFlag(flags.catalog);
      const { result } = await callTool("bgmwrite.fetch", {
        prompt_text: typeof flags.prompt === "string" ? flags.prompt : null,
        duration_sec: number(flags.duration, null),
        recipe_id: typeof flags.recipe === "string" ? flags.recipe : null,
        source_policy: typeof flags["source-policy"] === "string" ? flags["source-policy"] : "online-first",
        catalog,
        limit: number(flags.limit, null),
        dest_dir: typeof flags["dest-dir"] === "string" ? flags["dest-dir"] : null,
      });
      line(`取源分层：${result.layer}${result.degraded ? "（已降级，原因见下）" : ""}`);
      if (result.brief) {
        line(`  简报：题材 ${result.brief.recipeId ?? "n/a"} · 情绪 ${(result.brief.mood ?? []).join("/") || "n/a"} · 能量 ${result.brief.energyLevel ?? "n/a"}`);
      }
      if (catalog) line(`  目录预设：${catalog} —— ${CATALOGS[catalog].label}`);
      if (result.track) {
        line(`  曲目：${result.track.title ?? result.track.id} · ${result.track.license} · 来源 ${result.track.source ?? result.track.libraryKind ?? "n/a"}${result.track.cached ? "（命中缓存）" : ""}`);
        line(`  时长 ${fmt(result.track.durationSec, 1)}s · BPM ${result.track.bpm ?? "n/a"} · sha256 ${result.track.sha256 ?? "n/a"}`);
        line(`  落盘：${result.track.localPath ?? "n/a"}`);
        if (result.track.attributionText) line(`  署名义务：${result.track.attributionText}`);
      } else {
        line("  未取到外部曲目：在线无合规候选且本地曲库无匹配 → 交给工位按降级链自算作曲兜底。");
      }
      for (const attempt of result.attempts ?? []) {
        line(`  尝试 [${attempt.layer}]${attempt.source ? ` ${attempt.source}` : ""} → ${attempt.status}${attempt.message ? `（${attempt.message}）` : ""}`);
      }
      line(`  缓存目录：${result.cacheDir}`);
      const configured = (result.sources ?? []).filter((entry) => entry.configured).map((entry) => entry.name);
      line(`  在线源：${configured.length ? configured.join(" / ") : "未配置（凭据缺失时如实报告，不假装搜过）"}`);
      return 0;
    }
    case "tag": {
      // 曲库打标：素材目录 → 实测打标 → 曲库索引（许可必须先声明，围栏 G-BGM8）
      const { result } = await callTool("bgmwrite.tag", {
        input_dir: flags.in,
        out_dir: flags.out,
        license: typeof flags.license === "string" ? flags.license : null,
        license_note: typeof flags["license-note"] === "string" ? flags["license-note"] : null,
        license_source: typeof flags["license-source"] === "string" ? flags["license-source"] : null,
        library_name: typeof flags["library-name"] === "string" ? flags["library-name"] : null,
        concurrency: number(flags.concurrency, 4),
        max_seconds: number(flags["max-seconds"], 180),
        recursive: flags["no-recursive"] !== true,
        allow_overwrite: flags["allow-overwrite"] === true,
      });
      line(`打标完成：扫描 ${result.counts.scanned} 首 → 入册 ${result.counts.tagged} 首 · 剔除 ${result.counts.rejected} 首 · 失败 ${result.counts.failed} 首`);
      line(`  曲库目录：${result.outDir}`);
      line(`  索引文件：${result.files.join(" / ")}`);
      line(`  许可：${result.license.key}（${result.license.label}${result.license.attributionRequired ? " · 需署名" : " · 无署名义务"}）`);
      line(`  风格分布：${Object.entries(result.counts.byStyle).map(([style, count]) => `${style}×${count}`).join(" · ")}`);
      line(`  能量分布（包内三分位）：low×${result.counts.byEnergyBucket.low} · mid×${result.counts.byEnergyBucket.mid} · high×${result.counts.byEnergyBucket.high}`);
      if (result.rejectedTotal) {
        line(`  被剔除（前 ${Math.min(5, result.rejectedTotal)} 条，完整清单见 tag-report.json）：`);
        for (const item of result.rejected.slice(0, 5)) line(`    · ${item.file} —— ${item.reasons.join("；")}`);
      }
      if (result.lowConfidenceTotal) {
        line(`  ⚠ 低置信标签 ${result.lowConfidenceTotal} 首（风格判定把握不足，建议人耳复核；清单见 tag-report.json）：`);
        for (const item of result.lowConfidence.slice(0, 5)) line(`    · ${item.file}（style=${item.style}, bpm=${item.bpmConfidence}）`);
      }
      if (result.errors.length) {
        for (const item of result.errors.slice(0, 5)) line(`  ✗ 失败：${item.file} —— ${item.error}`);
      }
      return 0;
    }
    case "library": {
      // 曲库维护：搬迁重绑 / 打进素材目录随文件夹走 / 自动发现
      const libraryDir = typeof flags.library === "string"
        ? flags.library
        : (process.env.WORKLOOM_BGM_HOME ? `${process.env.WORKLOOM_BGM_HOME}/library` : `${process.env.HOME}/.workloom-bgm/library`);
      if (flags.scan === true) {
        const { result } = await callTool("bgmwrite.library", { action: "inspect", library_dir: libraryDir });
        line("自动发现的本机曲库：");
        if (!result.discovered.length) line("  （没找到带 tracks.json 的目录）");
        for (const item of result.discovered) {
          line(`  · ${item.dir}`);
          line(`    ${item.libraryName} · ${item.tracks} 首 · ${item.fileMode} 路径 · ${item.note}`);
        }
        line("当前加载顺序：");
        for (const root of result.roots) line(`  ${root.kind.padEnd(16)} ${root.dir}`);
        return 0;
      }
      if (typeof flags.rebind === "string") {
        const { result } = await callTool("bgmwrite.library", {
          action: "rebind",
          library_dir: libraryDir,
          new_root: flags.rebind,
          verify: flags.verify === "sha256" ? "sha256" : "size",
          allow_overwrite: flags["allow-overwrite"] === true,
          dry_run: flags["dry-run"] === true,
        });
        line(`${result.dryRun ? "试算" : "已重新绑定"}：命中 ${result.matched} · 找不到 ${result.missing} · 歧义 ${result.ambiguous}（核验方式 ${result.verify}）`);
        line(`  旧目录：${result.oldRoot}`);
        line(`  新目录：${result.newRoot}`);
        for (const item of result.samples) line(`  · [${item.status}] ${item.id} → ${item.newPath ?? item.oldPath}`);
        return 0;
      }
      if (flags.pack === true) {
        const { result } = await callTool("bgmwrite.library", {
          action: "pack",
          library_dir: libraryDir,
          ...(typeof flags.out === "string" ? { dest_dir: flags.out } : {}),
          allow_overwrite: flags["allow-overwrite"] === true,
        });
        line(`已把索引打进素材目录：${result.destDir}（${result.tracks} 首，路径模式=${result.fileMode}）`);
        line(`  写入文件：${result.files.join(" / ")}`);
        line("  这个文件夹从此可以整体拷走/压缩分发：解压到任意位置都能被自动发现（相对路径索引）");
        return 0;
      }
      line("用法：bgm-cli library --scan | --rebind <新素材目录> --allow-overwrite [--verify sha256] | --pack [--out <素材目录>]");
      return 2;
    }
    case "best": {
      const result = await best({
        audioStems: audioStemsFlag(flags["audio-stems"]),
        input: flags.in,
        output: flags.out,
        genre: typeof flags.genre === "string" ? flags.genre : null,
        mood: typeof flags.mood === "string" ? flags.mood : null,
        policy: typeof flags.policy === "string" ? flags.policy : "keep-dialogue",
        minScore: number(flags["min-score"], 92),
        evidenceDir: typeof flags["evidence-dir"] === "string" ? flags["evidence-dir"] : null,
        seed: number(flags.seed, 0),
        promptText: typeof flags.prompt === "string" ? flags.prompt : null,
        sourcePolicy: typeof flags["source-policy"] === "string" ? flags["source-policy"] : "compose-only",
        catalog: catalogFlag(flags.catalog),
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
        "用法：bgm-cli <health|probe|analyze|recipes|library|compose|mix|separate|fetch|tag|best> [--flags]\n"
        + "       bgm-cli library --scan | --rebind <新目录> --allow-overwrite | --pack [--out <目录>]\n"
        + "参见 bundles/ai-video/connectors/bgm-bridge/README.md\n",
      );
      return 2;
  }
}

main()
  .then((code) => { process.exitCode = code; })
  .catch((error) => {
    const code = typeof error?.code === "string" ? error.code : "engine_failed";
    process.stderr.write(`${code}: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 3;
  });
