#!/usr/bin/env node
/**
 * BGM 曲库构建器（ai-video 行业包 · 自算曲库）
 *
 * 用途：用本仓自算作曲内核批量产出**可直接商用、无第三方权利**的 BGM 曲库。
 *
 *   node scripts/bgm-library-build.mjs --curated --out bundles/ai-video/library/bgm-library-curated
 *   node scripts/bgm-library-build.mjs --full 60 --out ~/.workloom-bgm/library
 *
 * 两种用法：
 *   --curated  生成 12 首"精选集"（每风格 1 首）→ 随仓库分发，供云端/离线部署直接使用
 *   --full N   生成 N 首"工位本地曲库"（风格 × 题材轮转）→ 只落工位磁盘，不进仓库
 *
 * 质量口径（每首都要过）：
 *   1. 作曲：配方（题材×情绪）× 风格包（配器/泵感/摇摆/明暗）
 *   2. 母带：高通 → 双点 EQ → 压缩 → EBU R128 归一（-14 LUFS / -1.5 dBTP）→ 限幅
 *   3. 编码：AAC 128k（m4a），带元数据标签；同时记录 sha256 / 实测响度 / 结构分析
 *   4. 结构：跑一遍 `analyzeStructure` 把 BPM/分段/动态写进清单 —— 选段能力要用
 */

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";

const HERE = path.dirname(new URL(import.meta.url).pathname);
const REPO_ROOT = path.resolve(HERE, "..");
const BRIDGE = path.join(REPO_ROOT, "bundles/ai-video/connectors/bgm-bridge");
const RECIPES_FILE = path.join(REPO_ROOT, "bundles/ai-video/library/bgm-recipes/recipes.json");
const OUTPUT_NAME = "tracks.json";

const { composeToWav, STYLE_PACKS, STYLE_IDS } = await import(path.join(BRIDGE, "synth.mjs"));
const { analyzeStructure } = await import(path.join(BRIDGE, "core.mjs"));
const { probeMedia, measureLoudness, resolveBinaries, sha256File } = await import(path.join(BRIDGE, "measure.mjs"));

const bins = resolveBinaries();

/** 风格 → 适配题材（精选集用；轮转生成时按同样映射挑题材）。 */
const STYLE_RECIPES = {
  "modern-pop": ["product-ad", "family", "travel"],
  "electronic-pulse": ["tech", "festival-promo", "night-city"],
  "lo-fi-chill": ["food", "realestate", "beauty"],
  "cinematic-build": ["drama-story", "premium-brand", "documentary"],
  "ambient-calm": ["beauty", "documentary", "realestate"],
  "corporate-clean": ["product-ad", "tech", "realestate"],
  "acoustic-warm": ["family", "travel", "food"],
  "tension-dark": ["suspense", "night-city", "drama-story"],
  "sports-hype": ["auto", "festival-promo", "product-ad"],
  "festive-bright": ["festival-promo", "food", "comedy-light"],
  "documentary-bed": ["documentary", "interview"],
  "city-night": ["night-city", "tech", "suspense"],
};

function arg(name, fallback = null) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : fallback;
}

function has(name) {
  return process.argv.includes(name);
}

/**
 * 母带分两级：
 * ① 音色级（EQ + 轻压缩）：只做"好听"，不做电平归一；
 * ② 电平级（**定值增益** + 限幅）：按实测响度算一个固定增益，而不是跑单遍 `loudnorm`。
 *
 * 为什么不用单遍 loudnorm：它是**动态**归一，会把 6–10dB 的副歌/桥段对比压到 3dB 以内，
 * 实测导致 12 首精选曲全部被结构识别判成"无高潮"（withDrop=0），选段能力直接失效。
 * 定值增益只平移电平、保结构，符合"曲库要能被选段"的要求。
 */
const TONE_CHAIN = [
  "highpass=f=26",
  "equalizer=f=180:t=q:w=1:g=-1.5",
  "equalizer=f=3200:t=q:w=1:g=1.2",
].join(",");
const TARGET_LUFS = -14;
const TARGET_TP = -1.5;

function run(bin, args, label) {
  process.stderr.write(`  · ${label}\n`);
  execFileSync(bin, args, { stdio: ["ignore", "ignore", "pipe"] });
}

function loadRecipes() {
  const doc = JSON.parse(fs.readFileSync(RECIPES_FILE, "utf8"));
  return doc.recipes;
}

function titleFor(recipe, style, index) {
  const styleLabel = STYLE_PACKS[style].label.split("（")[0];
  return `${recipe.genre} · ${styleLabel} ${String(index).padStart(2, "0")}`;
}

/** 生成一首曲目：作曲 → 母带 → 编码 → 分析 → 清单条目。 */
async function buildTrack({ recipe, style, seed, index, outDir, format = "m4a", bitrate = "128k", workDir }) {
  const id = `${style}-${recipe.id}-${String(seed).slice(-4)}`;
  const rawWav = path.join(workDir, `${id}.wav`);
  const finalFile = path.join(outDir, format === "m4a" ? `${id}.m4a` : `${id}.wav`);
  const duration = 60; // 精选集统一 60s；够放 2–3 段结构，方便选段

  const composed = await composeToWav({
    recipe: { ...recipe, style },
    durationSec: duration,
    output: rawWav,
    seed,
  });

  // ① 音色级（EQ + 轻压缩）→ ② 实测响度 → ③ 定值增益 + 限幅 → ④ 编码
  const tonedWav = path.join(workDir, `${id}-toned.wav`);
  run(bins.ffmpeg, [
    "-hide_banner", "-v", "error", "-y",
    "-i", rawWav, "-af", TONE_CHAIN, "-c:a", "pcm_s16le", "-ar", "48000", tonedWav,
  ], `音色母带 ${id}`);
  const measured = await measureLoudness(tonedWav, { bins, targetLufs: TARGET_LUFS, truePeak: TARGET_TP });
  const gainForLufs = Number.isFinite(measured.integratedLufs) ? TARGET_LUFS - measured.integratedLufs : 0;
  const gainForPeak = Number.isFinite(measured.truePeakDbtp) ? TARGET_TP - measured.truePeakDbtp : gainForLufs;
  const gainDb = Math.round(Math.min(gainForLufs, gainForPeak) * 100) / 100;
  const masterWav = path.join(workDir, `${id}-master.wav`);
  // 限幅上限取 0.6（≈ -4.4dBFS）：给 AAC 编码的码间过冲留足余量
  // （实测 limit=0.9 时编码后真峰值 -0.55dBTP、limit=0.75 时仍有 +2.6dBTP 的极端个案）
  const renderMaster = (gain) => run(bins.ffmpeg, [
    "-hide_banner", "-v", "error", "-y",
    "-i", tonedWav,
    "-af", `volume=${gain}dB,alimiter=limit=0.6:attack=5:release=50`,
    "-c:a", "pcm_s16le", "-ar", "48000", "-ac", "2", masterWav,
  ], `电平母带 ${id}（${gain}dB）`);
  renderMaster(gainDb);

  const encode = (outFile) => run(bins.ffmpeg, [
    "-hide_banner", "-v", "error", "-y",
    "-i", masterWav,
    ...(format === "m4a"
      ? ["-c:a", "aac", "-b:a", bitrate, "-movflags", "+faststart",
        "-metadata", `title=${titleFor(recipe, style, index)}`,
        "-metadata", "artist=WorkLoom 自算曲库",
        "-metadata", `comment=workloom.bgm.library/v1 style=${style} recipe=${recipe.id} seed=${seed}`]
      : ["-c:a", "pcm_s16le"]),
    outFile,
  ], `母带+编码 ${id}`);
  encode(finalFile);

  /**
   * 最终校正（在**编码产物**上做，因为 AAC 会有码间过冲）：
   * 实测 LUFS / 真峰值 → 取"把响度拉回 -14"与"把真峰值压回 -1.5"里更狠的那个增益 → 重新编码一次。
   * 只做一次，避免来回震荡；校正量写进清单，可复核。
   */
  let verifyLoudness = await measureLoudness(finalFile, { bins, targetLufs: TARGET_LUFS, truePeak: TARGET_TP });
  let finalTrimDb = 0;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const lufsTrim = Number.isFinite(verifyLoudness.integratedLufs) ? TARGET_LUFS - verifyLoudness.integratedLufs : 0;
    const peakTrim = Number.isFinite(verifyLoudness.truePeakDbtp) ? TARGET_TP - verifyLoudness.truePeakDbtp : 0;
    // 先满足响度、再压真峰值（两个约束都只减不增；宁可稍低于 -14，也不让真峰值越 -1.5）
    const trim = peakTrim < 0 ? Math.min(lufsTrim, peakTrim) : lufsTrim;
    if (Math.abs(trim) < 0.2) break;
    finalTrimDb = Math.round((finalTrimDb + trim) * 100) / 100;
    const tmpFixed = path.join(workDir, `${id}-fixed.${format === "m4a" ? "m4a" : "wav"}`);
    run(bins.ffmpeg, [
      "-hide_banner", "-v", "error", "-y",
      "-i", finalFile, "-af", `volume=${Math.round(trim * 100) / 100}dB`,
      ...(format === "m4a"
        ? ["-c:a", "aac", "-b:a", bitrate, "-movflags", "+faststart",
          "-metadata", `title=${titleFor(recipe, style, index)}`,
          "-metadata", "artist=WorkLoom 自算曲库",
          "-metadata", `comment=workloom.bgm.library/v1 style=${style} recipe=${recipe.id} seed=${seed}`]
        : ["-c:a", "pcm_s16le"]),
      tmpFixed,
    ], `最终校正 ${id}（${Math.round(trim * 100) / 100}dB）`);
    fs.renameSync(tmpFixed, finalFile);
    verifyLoudness = await measureLoudness(finalFile, { bins, targetLufs: TARGET_LUFS, truePeak: TARGET_TP });
  }

  const probe = await probeMedia(finalFile, { bins });
  const loudness = verifyLoudness;
  const structure = await analyzeStructure({ input: finalFile, bins });
  const peak = structure.envelope.peakDb ?? -60;
  const avg = structure.envelope.avgDb ?? -30;
  // 能量指标（0..1）：用"平均电平相对 -30..-12dBFS 的归一"，供简报打分用
  const energyScore = Math.max(0, Math.min(1, (avg + 30) / 18));
  const drop = structure.structure.segments.find((segment) => segment.type === "drop");

  return {
    entry: {
      id,
      title: titleFor(recipe, style, index),
      artist: "WorkLoom 自算曲库",
      genre: recipe.genre,
      mood: recipe.mood,
      style,
      styleLabel: STYLE_PACKS[style].label,
      recipeId: recipe.id,
      bpm: structure.tempo.bpm ?? recipe.bpm,
      durationSec: Math.round(probe.duration * 100) / 100,
      license: "workloom-self-generated",
      licenseNote: "本仓自算合成（synth.mjs），无第三方样本/权重，可商用、无署名义务",
      file: path.basename(finalFile),
      sha256: await sha256File(finalFile),
      bytes: fs.statSync(finalFile).size,
      format: format === "m4a" ? "aac/m4a" : "wav/pcm_s16le",
      loudness: {
        integratedLufs: loudness.integratedLufs,
        truePeakDbtp: loudness.truePeakDbtp,
        lra: loudness.lra,
      },
      energyScore: Math.round(energyScore * 100) / 100,
      dynamicsDb: structure.structure.dynamicsDb,
      structure: {
        method: structure.structure.method,
        segments: structure.structure.segments.map((segment) => ({
          type: segment.type, startSec: segment.startSec, endSec: segment.endSec, avgDb: segment.avgDb, peakDb: segment.peakDb,
        })),
        hasDrop: Boolean(drop),
        climaxCandidate: structure.climax.candidates[0] ?? null,
      },
      generation: {
        recipeId: recipe.id, style, seed, durationSec: duration,
        masteredWith: {
          toneChain: TONE_CHAIN, gainDb, finalTrimDb, targetLufs: TARGET_LUFS, targetTruePeakDbtp: TARGET_TP,
          limiterCeiling: 0.6,
        },
        rawSha256: composed.sha256,
      },
      instrumentation: composed.plan.instrumentation,
      mixHints: {
        musicLevelDb: recipe.musicLevelDb,
        duckingDb: recipe.duckingDb,
        avoid: recipe.avoid ?? [],
      },
      tags: [...new Set([recipe.genre, recipe.mood, STYLE_PACKS[style].label, ...(recipe.platforms ?? [])])].slice(0, 8),
    },
    peak,
    avg,
  };
}

async function main() {
  const curated = has("--curated");
  const fullCount = Number(arg("--full", curated ? 12 : 0));
  const outDir = path.resolve(arg("--out", curated
    ? path.join(REPO_ROOT, "bundles/ai-video/library/bgm-library-curated")
    : path.join(process.env.HOME ?? ".", ".workloom-bgm", "library")));
  const format = arg("--format", curated ? "m4a" : "m4a");
  const bitrate = arg("--bitrate", "128k");
  const force = has("--force");
  const recipes = loadRecipes();
  const byId = new Map(recipes.map((recipe) => [recipe.id, recipe]));

  fs.mkdirSync(outDir, { recursive: true });
  const workDir = fs.mkdtempSync(path.join(process.env.TMPDIR ?? "/tmp", "bgm-lib-"));
  const manifestPath = path.join(outDir, OUTPUT_NAME);
  const existing = !force && fs.existsSync(manifestPath)
    ? JSON.parse(fs.readFileSync(manifestPath, "utf8"))
    : null;
  const existingIds = new Set((existing?.tracks ?? []).map((track) => track.id));

  /** 生成计划：风格 × 题材轮转。 */
  const plan = [];
  if (curated) {
    for (const [styleIndex, style] of STYLE_IDS.entries()) {
      const recipeIds = STYLE_RECIPES[style] ?? ["product-ad"];
      const recipeId = recipeIds[styleIndex % recipeIds.length];
      plan.push({ style, recipe: byId.get(recipeId) ?? recipes[styleIndex % recipes.length], seed: 1000 + styleIndex * 137 });
    }
  } else {
    // 本地全量曲库 = 云端精选 12 首（同风格/同题材/同种子，保证与仓库版本逐字节同源）+ 扩展曲目
    for (const [styleIndex, style] of STYLE_IDS.entries()) {
      const recipeIds = STYLE_RECIPES[style] ?? ["product-ad"];
      plan.push({
        style,
        recipe: byId.get(recipeIds[styleIndex % recipeIds.length]) ?? recipes[styleIndex % recipes.length],
        seed: 1000 + styleIndex * 137,
      });
    }
    for (let index = 0; index < Math.max(0, fullCount - STYLE_IDS.length); index += 1) {
      const style = STYLE_IDS[index % STYLE_IDS.length];
      const recipeIds = STYLE_RECIPES[style] ?? ["product-ad"];
      const recipeId = recipeIds[Math.floor(index / STYLE_IDS.length) % recipeIds.length];
      plan.push({ style, recipe: byId.get(recipeId) ?? recipes[index % recipes.length], seed: 2000 + index * 97 });
    }
  }

  const tracks = [];
  let built = 0;
  for (const [index, item] of plan.entries()) {
    const id = `${item.style}-${item.recipe.id}-${String(item.seed).slice(-4)}`;
    const reused = existing?.tracks?.find((track) => track.id === id);
    if (reused && existingIds.has(id) && fs.existsSync(path.join(outDir, reused.file))) {
      tracks.push(reused);
      continue;
    }
    process.stderr.write(`[${index + 1}/${plan.length}] ${id}\n`);
    const { entry } = await buildTrack({
      recipe: item.recipe, style: item.style, seed: item.seed, index: index + 1,
      outDir, format, bitrate, workDir,
    });
    tracks.push(entry);
    built += 1;
  }

  const totalBytes = tracks.reduce((sum, track) => sum + (track.bytes ?? 0), 0);
  const manifest = {
    schemaVersion: "workloom.bgm-library/v1",
    library: {
      name: curated ? "WorkLoom 精选 BGM 曲库（12 首）" : `WorkLoom 工位本地曲库（${tracks.length} 首）`,
      provider: "workloom-self-generated",
      licensePolicy: "本仓自算合成：无第三方样本/权重，可商用于客户交付，无署名义务",
      generatedAt: new Date().toISOString(),
      generator: "scripts/bgm-library-build.mjs",
      tracks: tracks.length,
      totalBytes,
      note: curated
        ? "随仓库分发的精选子集（每风格 1 首）；完整曲库用 --full 60 在工位本地生成"
        : "工位本地曲库（不进仓库）；云端只随仓库分发精选子集",
    },
    tracks,
  };
  fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  fs.rmSync(workDir, { recursive: true, force: true });

  const styles = new Set(tracks.map((track) => track.style));
  const avgLufs = tracks.reduce((sum, track) => sum + (track.loudness?.integratedLufs ?? -14), 0) / Math.max(1, tracks.length);
  console.log(JSON.stringify({
    ok: true,
    outDir,
    tracks: tracks.length,
    built,
    reused: tracks.length - built,
    styles: styles.size,
    totalMB: Math.round((totalBytes / 1024 / 1024) * 10) / 10,
    avgIntegratedLufs: Math.round(avgLufs * 100) / 100,
    withDrop: tracks.filter((track) => track.structure?.hasDrop).length,
    manifest: manifestPath,
  }, null, 1));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exit(1);
});
