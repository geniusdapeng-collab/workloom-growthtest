/**
 * ai-video × 配乐工位 bridge 内核（core.mjs）
 *
 * 定位：把「成片配乐」做成可审计的确定性工具层——工位本地执行，零云端依赖
 * （node 内置模块 + 工位本地 ffmpeg/ffprobe + 仓内自算作曲内核 synth.mjs）。
 *
 * 纪律（与 color-bridge / visual-bridge 同构）：
 * - 原片只读：任何写入都落到新文件，覆盖原片直接拒绝（overwrite_source_forbidden）；
 * - 路径监狱：只允许访问白名单根目录内的路径（WORKLOOM_BGM_ALLOWED_ROOTS）；
 * - 无回执=未核实：产物必须给出 sha256 + 响度/人声余量/配乐可闻度的实测复检；
 * - 不伪造：失败一律抛带稳定 code 的 BgmError，由上层决定重试或转人工；
 * - 不粗暴：默认不动原声（保留人声与现场声），BGM 只在人声让位的基础上铺底。
 *
 * 配乐知识来自公开的混音常识与 EBU R128 口径（人声频段 200–4000Hz、对白-音乐余量 ≥6dB、
 * ducking 8–14dB、母版 -14 LUFS / -1 dBTP），参数集为本仓自有取值。
 */

import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  MeasureError, binaryVersion, detectCuts, detectVoiceBandSegments, measureLoudness,
  probeMedia, renderWaveformCompare, resolveBinaries, round, runBin, segmentMeanVolumeDb,
  segmentSpectralStats, sha256File, tempDir,
} from "./measure.mjs";
import { composeToWav, planComposition } from "./synth.mjs";

/** 工位对外错误类型（与 measure 内核同源，统一 code 语义）。 */
export const BgmError = MeasureError;

/* ============================ 工具面 ============================ */

/** 本连接器提供的工具面；不在表内的工具直接拒绝（与 color-bridge 同款白名单纪律）。 */
export const BGM_TOOLS = [
  "bgmread.health",
  "bgmread.probe",
  "bgmread.analyze",
  "bgmread.recipes",
  "bgmread.library",
  "bgmwrite.compose",
  "bgmwrite.mix",
  "bgmwrite.separate",
  "bgmwrite.best",
];

const TOOL_SET = new Set(BGM_TOOLS);

export function isBgmTool(name) {
  return TOOL_SET.has(name);
}

/* ============================ 路径监狱 ============================ */

function isInside(child, parent) {
  const rel = path.relative(parent, child);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

function realpathDeepest(target) {
  let probe = target;
  while (!fs.existsSync(probe)) {
    const parent = path.dirname(probe);
    if (parent === probe) break;
    probe = parent;
  }
  const real = fs.realpathSync(probe);
  return path.join(real, path.relative(probe, target));
}

/** 允许根目录：环境变量优先，缺省只放行进程工作目录与系统临时目录。 */
export function allowedRoots(env = process.env) {
  const raw = (env.WORKLOOM_BGM_ALLOWED_ROOTS ?? "").trim();
  const list = raw ? raw.split(":").map((entry) => entry.trim()).filter(Boolean) : [process.cwd(), os.tmpdir()];
  return list.map((entry) => {
    const abs = path.resolve(entry);
    return fs.existsSync(abs) ? fs.realpathSync(abs) : abs;
  });
}

/** 路径白名单校验（软链逃逸同样拦：对真实路径做前缀判定）。 */
export function assertPathAllowed(target, roots = allowedRoots(), label = "path") {
  if (typeof target !== "string" || target.trim() === "") {
    throw new BgmError(`${label} 为空`, "bad_request");
  }
  const abs = path.resolve(target);
  const normalized = realpathDeepest(abs);
  const normalizedRoots = roots.map((root) => {
    const resolved = path.resolve(String(root));
    return fs.existsSync(resolved) ? fs.realpathSync(resolved) : resolved;
  });
  if (!normalizedRoots.some((root) => isInside(normalized, root))) {
    throw new BgmError(`${label} 越出允许目录（路径监狱）：${abs}`, "path_not_allowed");
  }
  return normalized;
}

/* ============================ 配方库 ============================ */

const RECIPE_FILE = path.resolve(
  path.dirname(new URL(import.meta.url).pathname),
  "../../library/bgm-recipes/recipes.json",
);

let recipeCache = null;

/** 读配方库（带缓存；文件缺失=显式失败，不静默返回空）。 */
export function loadRecipes(file = RECIPE_FILE) {
  if (recipeCache && recipeCache.file === file) return recipeCache.doc;
  if (!fs.existsSync(file)) {
    throw new BgmError(`配乐配方库缺失：${file}（随 bundles/ai-video/library/bgm-recipes 分发）`, "bad_request");
  }
  let doc;
  try {
    doc = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (error) {
    throw new BgmError(`配乐配方库解析失败：${error instanceof Error ? error.message : String(error)}`, "bad_request");
  }
  if (!Array.isArray(doc?.recipes) || doc.recipes.length === 0) {
    throw new BgmError("配乐配方库为空", "bad_request");
  }
  recipeCache = { file, doc };
  return doc;
}

/**
 * 按题材/情绪/平台检索配方；`list=true` 返回速查表，否则返回首选配方 + 备选。
 */
export function findRecipes(query = {}) {
  const doc = loadRecipes();
  const norm = (value) => String(value ?? "").trim().toLowerCase();
  const genre = norm(query.genre);
  const mood = norm(query.mood);
  const platform = norm(query.platform);
  const keyword = norm(query.keyword);

  const matched = doc.recipes.filter((recipe) => {
    if (query.recipeId && recipe.id !== query.recipeId) return false;
    if (genre && !norm(recipe.genre).includes(genre) && !genre.includes(norm(recipe.genre))) return false;
    if (mood && !norm(recipe.mood).includes(mood) && !mood.includes(norm(recipe.mood))) return false;
    if (platform && !(recipe.platforms ?? []).some((entry) => norm(entry) === platform || norm(entry) === "all")) return false;
    if (keyword) {
      const haystack = norm([recipe.id, recipe.genre, recipe.scene, recipe.mood, ...(recipe.avoid ?? [])].join(" "));
      if (!haystack.includes(keyword)) return false;
    }
    return true;
  });
  if (query.recipeId && matched.length === 0) {
    throw new BgmError(`配方不存在：${query.recipeId}（可用：${doc.recipes.map((r) => r.id).join(", ")}）`, "not_found");
  }

  if (query.list) {
    return {
      total: doc.recipes.length,
      principle: doc.principle,
      targets: doc.targets,
      duckingDefaults: doc.duckingDefaults,
      items: matched.map((recipe) => ({
        id: recipe.id,
        genre: recipe.genre,
        scene: recipe.scene,
        mood: recipe.mood,
        key: recipe.key,
        mode: recipe.mode,
        bpm: recipe.bpm,
        chords: recipe.chords,
        instrumentation: recipe.instrumentation,
        musicLevelDb: recipe.musicLevelDb,
        duckingDb: recipe.duckingDb,
        platforms: recipe.platforms ?? [],
      })),
    };
  }
  const selected = matched[0] ?? null;
  return {
    total: doc.recipes.length,
    matched: matched.length,
    targets: doc.targets,
    duckingDefaults: doc.duckingDefaults,
    recipe: selected,
    alternatives: matched.slice(1, 4).map((recipe) => recipe.id),
  };
}

/* ============================ 无版权曲库（外部曲目） ============================ */

/**
 * 曲库目录（可选）：`WORKLOOM_BGM_LIBRARY_DIR` 指向一个带 tracks.json 的目录，
 * 默认取仓内 `library/bgm-library`（仓库只带接入规范与示例，不携带第三方音频资产）。
 */
export function libraryDir(env = process.env) {
  const override = (env.WORKLOOM_BGM_LIBRARY_DIR ?? "").trim();
  if (override) return path.resolve(override);
  return path.resolve(path.dirname(new URL(import.meta.url).pathname), "../../library/bgm-library");
}

/** 许可白名单：只能商用 → true；非商用/禁止演绎 → false；未知 → null（未知一律按"不可商用"处理）。 */
export const LICENSE_TABLE = {
  "cc0-1.0": { commercial: true, attributionRequired: false, label: "CC0 1.0（公有领域）" },
  "cc-by-4.0": { commercial: true, attributionRequired: true, label: "CC BY 4.0（署名）" },
  "cc-by-sa-4.0": { commercial: true, attributionRequired: true, shareAlike: true, label: "CC BY-SA 4.0（署名·相同方式共享）" },
  "cc-by-nc-4.0": { commercial: false, attributionRequired: true, label: "CC BY-NC 4.0（禁止商用）" },
  "cc-by-nd-4.0": { commercial: false, attributionRequired: true, label: "CC BY-ND 4.0（禁止演绎）" },
  "cc-by-nc-nd-4.0": { commercial: false, attributionRequired: true, label: "CC BY-NC-ND 4.0（禁商用·禁演绎）" },
  "royalty-free": { commercial: true, attributionRequired: false, label: "免版税（Royalty-Free）" },
  "workloom-self-generated": { commercial: true, attributionRequired: false, label: "本仓自算合成（无第三方权利）" },
};

export function licenseInfo(license) {
  const key = String(license ?? "").trim().toLowerCase();
  const entry = LICENSE_TABLE[key];
  if (!entry) return { key: key || "unknown", commercial: null, attributionRequired: null, label: `未知许可（${key || "未标注"}）`, known: false };
  return { key, known: true, ...entry };
}

function loadLibraryTracks(env = process.env) {
  const dir = libraryDir(env);
  const file = path.join(dir, "tracks.json");
  if (!fs.existsSync(file)) {
    return { dir, file, tracks: [], present: false, note: "曲库未接入（缺 tracks.json）；可用 bgmwrite.compose 走自算作曲" };
  }
  let doc;
  try {
    doc = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (error) {
    throw new BgmError(`曲库索引解析失败：${error instanceof Error ? error.message : String(error)}`, "bad_request");
  }
  const tracks = Array.isArray(doc?.tracks) ? doc.tracks : [];
  return { dir, file, tracks, present: true, note: null };
}

/** TASL 署名（Title / Author / Source / License）——CC 系许可的合规署名格式。 */
export function buildAttribution(track) {
  const info = licenseInfo(track.license);
  const title = track.title ?? track.id ?? "(未命名)";
  const author = track.artist ?? track.author ?? "(未标注作者)";
  const source = track.source ?? track.url ?? "(未标注来源)";
  return {
    title,
    author,
    source,
    license: info.label,
    licenseKey: info.key,
    text: `"${title}" — ${author} · ${source} · ${info.label}`,
    required: info.attributionRequired === true,
  };
}

function assertLicenseUsable(track, { commercialUse = true, licenseReviewed = true } = {}) {
  const info = licenseInfo(track.license);
  if (!licenseReviewed) {
    throw new BgmError(
      `曲目「${track.id}」的许可尚未核验（license_reviewed=false）：先核验许可再入片（围栏 G-BGM1）`,
      "license_blocked",
    );
  }
  if (commercialUse && info.commercial !== true) {
    throw new BgmError(
      `曲目「${track.id}」许可为 ${info.label}，不可用于商用交付（围栏 G-BGM5）；请换 CC0 / CC BY / 免版税曲目`,
      "license_blocked",
    );
  }
  return info;
}

/**
 * 曲库检索：按情绪/流派/BPM/时长过滤，返回许可与署名信息。
 * 只做检索与合规判定，不下载、不搬运（音源由客户/工位本地提供）。
 */
export function findTracks(query = {}, env = process.env) {
  const library = loadLibraryTracks(env);
  const norm = (value) => String(value ?? "").trim().toLowerCase();
  const mood = norm(query.mood);
  const genre = norm(query.genre);
  const minDuration = Number(query.minDurationSec ?? 0);
  const commercialUse = query.commercialUse !== false;
  const bpmMin = Number(query.bpmMin ?? 0);
  const bpmMax = Number(query.bpmMax ?? 400);

  const items = library.tracks
    .filter((track) => {
      if (query.trackId && track.id !== query.trackId) return false;
      if (mood && !norm(track.mood).includes(mood)) return false;
      if (genre && !norm(track.genre).includes(genre)) return false;
      if (Number.isFinite(minDuration) && minDuration > 0 && Number(track.durationSec ?? 0) < minDuration) return false;
      const bpm = Number(track.bpm ?? 0);
      if (bpm && (bpm < bpmMin || bpm > bpmMax)) return false;
      const info = licenseInfo(track.license);
      if (commercialUse && info.commercial !== true) return false;
      return true;
    })
    .map((track) => {
      const info = licenseInfo(track.license);
      const absolute = track.path ? path.resolve(library.dir, track.path) : null;
      return {
        id: track.id,
        title: track.title ?? null,
        artist: track.artist ?? null,
        genre: track.genre ?? null,
        mood: track.mood ?? null,
        bpm: Number(track.bpm ?? 0) || null,
        durationSec: Number(track.durationSec ?? 0) || null,
        path: absolute,
        fileExists: absolute ? fs.existsSync(absolute) : false,
        license: track.license ?? null,
        licenseLabel: info.label,
        commercialOk: info.commercial === true,
        attribution: buildAttribution(track),
      };
    });

  let selected = null;
  if (query.trackId) {
    if (items.length === 0) {
      const raw = library.tracks.find((track) => track.id === query.trackId);
      if (raw) assertLicenseUsable(raw, { commercialUse, licenseReviewed: query.licenseReviewed !== false });
      throw new BgmError(`曲库中未找到可用曲目：${query.trackId}`, "not_found");
    }
    selected = items[0];
    assertLicenseUsable(
      { ...library.tracks.find((track) => track.id === query.trackId), id: selected.id, license: selected.license },
      { commercialUse, licenseReviewed: query.licenseReviewed !== false },
    );
  }

  return {
    libraryDir: library.dir,
    libraryPresent: library.present,
    note: library.note,
    total: library.tracks.length,
    matched: items.length,
    commercialUse,
    track: selected,
    items: items.slice(0, 20),
    licenseTable: LICENSE_TABLE,
  };
}

/** 写署名文件（有署名义务的曲目必须随交付物留档）。 */
async function writeAttributionFile(track, outputPath) {
  const attribution = buildAttribution(track);
  const lines = [
    "# BGM 署名（TASL）",
    "",
    "本片使用以下音乐素材，按许可要求署名：",
    "",
    `- 标题（Title）：${attribution.title}`,
    `- 作者（Author）：${attribution.author}`,
    `- 来源（Source）：${attribution.source}`,
    `- 许可（License）：${attribution.license}`,
    "",
    `> ${attribution.text}`,
    "",
  ];
  await fsp.mkdir(path.dirname(outputPath), { recursive: true });
  await fsp.writeFile(outputPath, `${lines.join("\n")}\n`, "utf8");
  return { path: outputPath, sha256: await sha256File(outputPath), text: attribution.text };
}

/* ============================ 音轨诊断 ============================ */

const VOICE_BAND = { highpass: 200, lowpass: 4000 };

function average(list) {
  const values = list.filter((value) => Number.isFinite(value));
  if (!values.length) return null;
  return values.reduce((a, b) => a + b, 0) / values.length;
}

/**
 * 成片音轨诊断：响度 → 人声频段活动 → 剪辑点 → 静音窗口基线 → 频谱画像 → 处置建议。
 *
 * 诚实边界：这里的人声判定是**频段能量活动**，不是语音识别；它能支撑"要不要让位、让多少"，
 * 不能支撑"这句话说了什么"。需要真正分轨时走 `bgmwrite.separate`。
 */
export async function analyze({ input, noiseDb = -38, bins = resolveBinaries(), maxWindows = 6 }) {
  const probe = await probeMedia(input, { bins });
  const loudness = await measureLoudness(input, { bins });
  const voice = await detectVoiceBandSegments({ input, duration: probe.duration, noiseDb, bins });
  const cuts = await detectCuts({ input, bins });

  const voiceWindows = voice.segments
    .filter((segment) => segment.duration >= 0.6)
    .sort((a, b) => b.duration - a.duration)
    .slice(0, maxWindows);
  const quietWindows = voice.silences
    .filter((segment) => segment.duration >= 0.4 && segment.start >= 0.2 && segment.end <= probe.duration - 0.2)
    .sort((a, b) => b.duration - a.duration)
    .slice(0, maxWindows);

  const voiceBandLevels = [];
  for (const window of voiceWindows) {
    const measured = await segmentMeanVolumeDb({
      input, start: window.start, duration: Math.min(window.duration, 2), band: VOICE_BAND, bins,
    });
    voiceBandLevels.push(measured.meanDb);
  }
  const roomToneLevels = [];
  for (const window of quietWindows) {
    const measured = await segmentMeanVolumeDb({
      input, start: window.start, duration: Math.min(window.duration, 2), band: null, bins,
    });
    roomToneLevels.push(measured.meanDb);
  }

  const longestVoice = voiceWindows[0] ?? null;
  const longestQuiet = quietWindows[0] ?? null;
  const voiceSpectrum = longestVoice
    ? await segmentSpectralStats({ input, start: longestVoice.start, duration: Math.min(longestVoice.duration, 3), bins })
    : null;
  const quietSpectrum = longestQuiet
    ? await segmentSpectralStats({ input, start: longestQuiet.start, duration: Math.min(longestQuiet.duration, 3), bins })
    : null;

  const voiceBandMeanDb = round(average(voiceBandLevels), 2);
  const roomToneDb = round(average(roomToneLevels), 2);
  const minAudibleMusicDb = Number.isFinite(roomToneDb) ? round(roomToneDb + 6, 2) : null;

  // 已配乐嫌疑：人声频段几乎全程有能量 + 谱心偏低且谱平坦度低（连续音乐/连续人声的共同特征）
  const musicLike = voiceSpectrum?.flatness !== null && voiceSpectrum?.flatness !== undefined && voiceSpectrum.flatness < 0.02;
  const suspectedBed = voice.activeRatio >= 0.9 && musicLike === true;
  const existingBed = {
    suspected: suspectedBed,
    confidence: suspectedBed ? "low" : "none",
    reasons: [
      `人声频段活动占比 ${(voice.activeRatio * 100).toFixed(1)}%（连续无静音 → 可能已有连续音乐或连续人声）`,
      voiceSpectrum ? `活跃段谱心 ${voiceSpectrum.centroidHz}Hz / 谱平坦度 ${voiceSpectrum.flatness}` : "活跃段频谱不可测",
    ],
    note: "低频度判定：只提示「可能已有配乐」，是否停手由 bgmwrite.best 的择优结论给出",
  };

  const recommendation = {
    policy: voice.activeRatio >= 0.5 ? "keep-dialogue" : "keep-all",
    needsSeparation: voice.activeRatio >= 0.35,
    musicLevelDbCeiling: minAudibleMusicDb,
    duckingDb: voice.activeRatio >= 0.5 ? 12 : 10,
    reason: voice.activeRatio >= 0.5
      ? "人声频段活动占片长一半以上：默认保留原声、BGM 让位（keep-dialogue）"
      : "以现场声为主：原声全保留、BGM 低音量铺底（keep-all）",
  };

  const issues = [];
  if (Number.isFinite(loudness.integratedLufs) && loudness.integratedLufs > -10) {
    issues.push({ kind: "already_loud", severity: "info", detail: `原片整体响度 ${loudness.integratedLufs} LUFS，已接近流媒体上限，配乐后需靠 loudnorm 统一` });
  }
  if (Number.isFinite(loudness.truePeakDbtp) && loudness.truePeakDbtp > -1) {
    issues.push({ kind: "true_peak_hot", severity: "warn", detail: `真峰值 ${loudness.truePeakDbtp} dBTP 已过 -1dBTP 红线，配乐会进一步抬升` });
  }
  if (voice.segments.length === 0) {
    issues.push({ kind: "no_voice_activity", severity: "info", detail: "未检测到人声频段活动（可能是纯音乐/纯环境声素材）" });
  }
  if (cuts.cuts.length === 0) {
    issues.push({ kind: "no_cuts", severity: "info", detail: "未检测到明显剪辑点（单镜到底或纯音频），卡点退回节拍网格" });
  }

  return {
    input,
    probe,
    loudness,
    voice,
    cuts,
    levels: {
      voiceBandMeanDb,
      roomToneDb,
      minAudibleMusicDb,
      voiceWindows,
      quietWindows,
    },
    spectral: { voice: voiceSpectrum, quiet: quietSpectrum },
    existingBed,
    recommendation,
    issues,
    targets: findRecipes({ list: true }).targets,
    method: {
      loudness: "EBU R128（loudnorm 测量通道）",
      voice: "200–4000Hz 带通 + silencedetect 频段活动检测（非语音识别）",
      cuts: "scene 分值检测（卡点对齐的事实源）",
      levels: "volumedetect 的按帧 RMS 平均（dBFS）",
    },
  };
}

/* ============================ 卡点对齐 ============================ */

/** 到最近整拍的距离（秒）。 */
function beatDistance(time, offset, beatSec) {
  const relative = (time - offset) % beatSec;
  const wrapped = relative < 0 ? relative + beatSec : relative;
  return Math.min(wrapped, beatSec - wrapped);
}

/**
 * 按剪辑点反推 BPM（"按剪辑节奏定配乐速度"）。
 *
 * 做法：把相邻剪辑点的间距换算成"若干整拍"，反推 BPM；只在与配方 BPM 相对差 ≤25% 时采用
 * （否则说明剪辑节奏与题材配方冲突，沿用配方 BPM 并如实说明）。
 */
export function deriveTempoFromCuts({ cuts = [], baseBpm, toleranceRatio = 0.25 }) {
  const base = Number(baseBpm);
  const beatSec = 60 / base;
  const times = cuts.map((cut) => Number(cut.at)).filter((value) => Number.isFinite(value)).sort((a, b) => a - b);
  const intervals = [];
  for (let index = 1; index < times.length; index += 1) {
    const interval = times[index] - times[index - 1];
    if (interval > 0.25) intervals.push(interval);
  }
  const candidates = [];
  for (const interval of intervals) {
    const beats = Math.max(2, Math.min(16, Math.round(interval / beatSec)));
    const bpm = (60 * beats) / interval;
    if (bpm >= 40 && bpm <= 200) candidates.push({ bpm, interval, beats });
  }
  if (!candidates.length) {
    return { bpm: base, source: "recipe", note: "无剪辑点或间距无法反推 BPM，沿用配方 BPM" };
  }
  candidates.sort((a, b) => Math.abs(a.bpm - base) - Math.abs(b.bpm - base));
  const best = candidates[0];
  const adopted = Math.abs(best.bpm - base) / base <= toleranceRatio;
  const derived = Math.round(best.bpm * 10) / 10;
  return {
    bpm: adopted ? derived : base,
    source: adopted ? "cut-driven" : "recipe",
    candidateBpm: derived,
    intervalSec: round(best.interval, 3),
    beats: best.beats,
    note: adopted
      ? `按剪辑点间距 ${round(best.interval, 2)}s ≈ ${best.beats} 拍反推 BPM ${derived}（配方基准 ${base}）`
      : `剪辑点间距反推 BPM ${derived} 与配方 ${base} 差异 >${Math.round(toleranceRatio * 100)}%，沿用配方 BPM`,
  };
}

/**
 * 节拍网格对齐：在 [0, 一拍) 内搜索偏移量，让尽量多的剪辑点落在拍点上。
 *
 * 口径：卡点 = 剪辑点落在整拍上（对齐误差 = 剪辑点到最近拍点的时间差）；
 * 平均误差 ≤60ms 记 aligned、≤120ms 记 loose、其余按未对齐如实上报。
 * 无剪辑点时退回"节拍网格无参考点"（offset=0），不做任何假装对齐的表述。
 *
 * @returns {{bpm:number, beatSec:number, offsetSec:number, cuts:Array, meanAbsErrorMs:number|null, maxAbsErrorMs:number|null, verdict:string, method:string}}
 */
export function alignBeatGrid({ bpm, cuts = [], stepMs = 5, maxCuts = 60, weighted = true }) {
  const beatSec = 60 / Number(bpm);
  if (!Number.isFinite(beatSec) || beatSec <= 0) throw new BgmError(`BPM 非法：${bpm}`, "bad_request");
  const usable = cuts.filter((cut) => Number.isFinite(cut.at)).slice(0, maxCuts);
  if (!usable.length) {
    return {
      bpm: Number(bpm),
      beatSec: round(beatSec, 4),
      offsetSec: 0,
      cuts: [],
      meanAbsErrorMs: null,
      maxAbsErrorMs: null,
      verdict: "no_cuts",
      method: "beat-grid（无剪辑点可对齐，按 0 偏移铺满）",
    };
  }

  const weightOf = (cut) => (weighted ? Math.max(0.05, Number(cut.score ?? 1)) : 1);
  const totalWeight = usable.reduce((sum, cut) => sum + weightOf(cut), 0);
  let best = { offset: 0, mean: Number.POSITIVE_INFINITY, max: Number.POSITIVE_INFINITY };
  const steps = Math.max(1, Math.floor((beatSec * 1000) / stepMs));
  for (let index = 0; index < steps; index += 1) {
    const offset = (index * stepMs) / 1000;
    const errors = usable.map((cut) => beatDistance(cut.at, offset, beatSec) * 1000);
    const mean = errors.reduce((sum, error, errorIndex) => sum + error * weightOf(usable[errorIndex]), 0) / totalWeight;
    const max = Math.max(...errors);
    if (mean < best.mean - 1e-9 || (Math.abs(mean - best.mean) < 1e-9 && max < best.max)) {
      best = { offset, mean, max };
    }
  }

  const aligned = usable.map((cut) => ({
    at: cut.at,
    score: cut.score ?? null,
    errorMs: Math.round(beatDistance(cut.at, best.offset, beatSec) * 1000 * 10) / 10,
  }));
  const meanAbsErrorMs = Math.round(best.mean * 10) / 10;
  const maxAbsErrorMs = Math.round(best.max * 10) / 10;
  const toleranceMs = 80;
  const alignedCount = aligned.filter((cut) => cut.errorMs <= toleranceMs).length;
  const alignedRatio = Math.round((alignedCount / aligned.length) * 100) / 100;
  return {
    bpm: Number(bpm),
    beatSec: round(beatSec, 4),
    offsetSec: round(best.offset, 4),
    cuts: aligned,
    meanAbsErrorMs,
    maxAbsErrorMs,
    alignedCount,
    alignedRatio,
    toleranceMs,
    weighted,
    candidateCount: cuts.length,
    verdict: alignedCount === aligned.length ? "aligned" : alignedRatio >= 0.6 ? "partial" : "unaligned",
    method: "beat-grid（在 [0,一拍) 内搜索使剪辑点加权落拍误差最小的偏移；±80ms 记落拍）",
  };
}

/**
 * 侧链压缩参数：把"目标让位深度(dB)"换算成 sidechaincompress 的阈值。
 * 压缩衰减 ≈ (侧链电平 - 阈值) × (1 - 1/ratio)，因此阈值 = 人声电平 - 深度 / (1 - 1/ratio)。
 */
export function deriveDuckParams({ speechLevelDb, duckingDb, ratio = 8 }) {
  const depth = Math.max(0, Number(duckingDb) || 0);
  const ratioSafe = Math.max(2, Number(ratio) || 8);
  if (!Number.isFinite(speechLevelDb)) {
    return { threshold: 0.05, ratio: ratioSafe, duckingDb: depth, source: "fallback-default" };
  }
  const reductionPerDb = 1 - 1 / ratioSafe;
  const thresholdDb = speechLevelDb - depth / reductionPerDb;
  const clampedDb = Math.max(-60, Math.min(-6, thresholdDb));
  return {
    threshold: round(10 ** (clampedDb / 20), 5),
    thresholdDb: round(clampedDb, 2),
    ratio: ratioSafe,
    duckingDb: depth,
    speechLevelDb,
    source: "measured-voice-level",
  };
}

/* ============================ 分层与混音 ============================ */

export const AUDIO_POLICIES = ["keep-dialogue", "keep-all", "replace-bed", "music-only"];

/**
 * 人声/伴奏分离的**近似**实现（ffmpeg 中心声道法）：
 * 立体声的中置分量（L+R）承载人声/对白，两侧分量（L-R）承载伴奏与环境。
 * 这是"轻量、可离线、零模型"的近似，不等于 Demucs 级别的深度学习分离；
 * 质量等级会在产物里如实标注。（深度学习引擎见 bgmwrite.separate 的引擎链）
 */
export function centerSeparationChain() {
  return {
    vocals: "pan=mono|c0=0.5*c0+0.5*c1",
    instrumental: "pan=mono|c0=0.5*c0-0.5*c1",
  };
}

async function renderStem({ input, output, chain, durationSec, bins, label }) {
  await fsp.mkdir(path.dirname(output), { recursive: true });
  await runBin(bins.ffmpeg, [
    "-hide_banner", "-v", "error", "-y",
    "-i", input,
    "-t", String(durationSec),
    "-af", chain,
    "-c:a", "pcm_s16le", "-ar", "48000", "-ac", "2",
    output,
  ], { label, timeoutMs: 900_000 });
  return output;
}

/** 用 loudnorm 两遍法把音频标准化到播出响度（此处不做动态压缩，只做整体增益与真峰值限制）。 */
async function normalizeLoudness({ input, output, targetLufs, truePeak, bins }) {
  const measured = await measureLoudness(input, { bins, targetLufs, truePeak });
  const measuredI = Number.isFinite(measured.integratedLufs) ? measured.integratedLufs : targetLufs;
  const measuredTp = Number.isFinite(measured.truePeakDbtp) ? measured.truePeakDbtp : truePeak;
  const measuredLra = Number.isFinite(measured.lra) ? measured.lra : 11;
  const measuredThresh = Number.isFinite(measured.thresholdLufs) ? measured.thresholdLufs : targetLufs - 10;
  const offset = Number.isFinite(measured.targetOffset) ? measured.targetOffset : 0;
  await runBin(bins.ffmpeg, [
    "-hide_banner", "-v", "error", "-y",
    "-i", input,
    "-af",
    `loudnorm=I=${targetLufs}:TP=${truePeak}:LRA=11:linear=true:`
    + `measured_I=${measuredI}:measured_TP=${measuredTp}:measured_LRA=${measuredLra}:`
    + `measured_thresh=${measuredThresh}:offset=${offset}:print_format=summary`,
    "-c:a", "pcm_s16le", "-ar", "48000", "-ac", "2",
    output,
  ], { label: "ffmpeg(loudnorm-apply)", timeoutMs: 900_000 });
  return { path: output, measuredBefore: measured, sha256: await sha256File(output) };
}

/**
 * 配乐出片（本连接器的主流程）：
 *
 *   原片音轨（只读） ─┬─ 侧链键（200–4000Hz）
 *                     └─ 声音床（原声 / 仅人声 / 静音，按 policy）
 *    BGM（自算或曲库曲目）→ 音量/淡入淡出/卡点偏移 → sidechaincompress 让位 → 与声音床合流
 *      → loudnorm 两遍法（-14 LUFS / -1 dBTP）→ 与视频轨合流（视频轨 copy，不重编码画面）
 *      → 复检：响度 / 让位深度 / 人声余量 / 配乐可闻度 / 卡点误差（无回执不算完成）
 *
 * @returns {Promise<object>} 产物 + 指标 + 证据（不含任何客户原始数据的上行）
 */
export async function mix({
  input, output, bgmPath = null, policy = "keep-dialogue", bgmBpm = null,
  musicLevelDb = null, duckingDb = null, targetLufs = -14, truePeak = -1.0,
  fadeInSec = 1.2, fadeOutSec = 1.6, align = true, allowDiscardOriginal = false,
  evidenceDir = null, bins = resolveBinaries(), workDir = null, keepWork = false,
  licenseReviewed = true, commercialUse = true,
}) {
  if (!AUDIO_POLICIES.includes(policy)) {
    throw new BgmError(`未知分层策略：${policy}（可用：${AUDIO_POLICIES.join(", ")}）`, "bad_request");
  }
  if (!bgmPath) throw new BgmError("缺少 bgm_path（先 compose 或指定曲库曲目）", "bad_request");
  if (!fs.existsSync(bgmPath)) throw new BgmError(`BGM 不存在：${bgmPath}`, "not_found");
  if (policy === "music-only" && allowDiscardOriginal !== true) {
    throw new BgmError(
      "music-only 会丢弃原声（含人声）；必须显式声明 allow_discard_original=true，且围栏 G-BGM3 会在有人声时阻断",
      "bad_request",
    );
  }

  const probe = await probeMedia(input, { bins });
  const duration = probe.duration;
  if (!(duration > 0)) throw new BgmError("输入时长为 0，无法配乐", "bad_media");
  const bgmProbe = await probeMedia(bgmPath, { bins });
  // music_level_db 的口径是「BGM 在成片里的实际平均电平（dBFS）」，不是 volume 滤镜的增益：
  // 所以先量 BGM 自身的平均电平，再反推需要施加的增益。这样配方里的 -22dB 就是"BGM 约 -22dBFS"。
  const bgmSelfLevel = await segmentMeanVolumeDb({ input: bgmPath, duration: Math.min(bgmProbe.duration, 10), bins });
  const bgmMeanDb = Number.isFinite(bgmSelfLevel.meanDb) ? bgmSelfLevel.meanDb : -18;
  if (path.resolve(output) === path.resolve(input)) {
    throw new BgmError("禁止覆盖原片（原片只读）", "overwrite_source_forbidden");
  }
  await fsp.mkdir(path.dirname(output), { recursive: true });

  const work = workDir ?? (await tempDir("bgm-mix-"));
  await fsp.mkdir(work, { recursive: true });
  const voice = await detectVoiceBandSegments({ input, duration, bins });
  const cuts = align ? (await detectCuts({ input, bins })).cuts : [];
  const grid = align
    ? alignBeatGrid({ bpm: Number(bgmBpm ?? 100), cuts })
    : { bpm: Number(bgmBpm ?? 100), offsetSec: 0, cuts: [], meanAbsErrorMs: null, verdict: "disabled", method: "disabled" };
  const offset = align ? grid.offsetSec : 0;

  const roomTone = await (async () => {
    const windows = voice.silences
      .filter((segment) => segment.duration >= 0.4 && segment.start >= 0.2)
      .sort((a, b) => b.duration - a.duration)
      .slice(0, 4);
    const levels = [];
    for (const window of windows) {
      const measured = await segmentMeanVolumeDb({ input, start: window.start, duration: Math.min(window.duration, 2), bins });
      levels.push(measured.meanDb);
    }
    return round(average(levels), 2);
  })();

  const speechLevel = await (async () => {
    const windows = voice.segments
      .filter((segment) => segment.duration >= 0.6)
      .sort((a, b) => b.duration - a.duration)
      .slice(0, 4);
    const levels = [];
    for (const window of windows) {
      const measured = await segmentMeanVolumeDb({
        input, start: window.start, duration: Math.min(window.duration, 2), band: VOICE_BAND, bins,
      });
      levels.push(measured.meanDb);
    }
    return round(average(levels), 2);
  })();

  const suggestedMusicLevel = Number.isFinite(roomTone) ? Math.max(-30, Math.min(-16, roomTone + 10)) : -24;
  const effectivePolicyLevel = policy === "keep-all" ? (musicLevelDb ?? suggestedMusicLevel) - 3
    : policy === "replace-bed" ? (musicLevelDb ?? suggestedMusicLevel) + 2
      : (musicLevelDb ?? suggestedMusicLevel);
  const effectiveDucking = policy === "keep-all" ? (duckingDb ?? 8) * 0.6 : (duckingDb ?? 12);
  const duck = deriveDuckParams({ speechLevelDb: speechLevel, duckingDb: effectiveDucking });

  // ① 声音床：原声 / 仅人声（中心声道近似分离）/ 静音
  const bedPath = path.join(work, "bed.wav");
  let bedSource = input;
  let sidechainSource = input;
  let separation = null;
  if (policy === "replace-bed") {
    const chains = centerSeparationChain();
    if (probe.audio.channels < 2) {
      throw new BgmError("replace-bed 需要立体声素材做中心声道分离（当前为单声道）：请改用 keep-dialogue 或先跑深度学习分离", "separation_unavailable");
    }
    await renderStem({ input, output: bedPath, chain: chains.vocals, durationSec: duration, bins, label: "ffmpeg(vocals-stem)" });
    bedSource = bedPath;
    sidechainSource = bedPath;
    separation = { engine: "ffmpeg-center", quality: "approximate", vocals: bedPath, note: "中心声道近似分离（非 Demucs 级）" };
  } else if (policy === "music-only") {
    await runBin(bins.ffmpeg, [
      "-hide_banner", "-v", "error", "-y",
      "-f", "lavfi", "-i", "anullsrc=r=48000:cl=stereo",
      "-t", String(duration), "-c:a", "pcm_s16le", bedPath,
    ], { label: "ffmpeg(silence-bed)", timeoutMs: 120_000 });
    bedSource = bedPath;
    sidechainSource = null;
  }

  // ② BGM 链：循环铺满 → 卡点偏移 → 音量 → 淡入淡出 → 让位压缩
  const duckedPath = path.join(work, "ducked-music.wav");
  const musicGainDb = round(effectivePolicyLevel - bgmMeanDb, 2);
  const musicChain = [
    "aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=stereo",
    offset > 0 ? `adelay=${Math.round(offset * 1000)}|${Math.round(offset * 1000)}` : "anull",
    `volume=${musicGainDb}dB`,
    `afade=t=in:st=${round(offset, 3)}:d=${round(fadeInSec, 2)}`,
    `afade=t=out:st=${round(Math.max(0, duration - fadeOutSec), 3)}:d=${round(fadeOutSec, 2)}`,
    "apad",
  ].join(",");
  const musicArgs = [
    "-hide_banner", "-v", "error", "-y",
    "-i", input,
    "-stream_loop", "-1", "-i", bgmPath,
  ];
  const musicParts = [`[1:a]${musicChain},atrim=0:${round(duration, 3)},asetpts=N/SR/TB[music]`];
  if (sidechainSource) {
    const keyInput = sidechainSource === input ? "[0:a]" : "[2:a]";
    if (sidechainSource !== input) musicArgs.push("-i", sidechainSource);
    musicParts.push(`${keyInput}highpass=f=${VOICE_BAND.highpass},lowpass=f=${VOICE_BAND.lowpass},volume=1[sc]`);
    musicParts.push(
      `[music][sc]sidechaincompress=threshold=${duck.threshold}:ratio=${duck.ratio}:attack=20:release=400:`
      + "makeup=1:level_sc=1:link=maximum[out]",
    );
  } else {
    musicParts.push("[music]anull[out]");
  }
  await runBin(bins.ffmpeg, [
    ...musicArgs, "-filter_complex", musicParts.join(";"),
    "-map", "[out]", "-c:a", "pcm_s16le", "-ar", "48000", "-ac", "2", duckedPath,
  ], { label: "ffmpeg(ducked-music)", timeoutMs: 900_000 });
  const duckedProbe = await probeMedia(duckedPath, { bins });

  // ③ 合流（BGM + 声音床）
  const premasterPath = path.join(work, "premaster.wav");
  await runBin(bins.ffmpeg, [
    "-hide_banner", "-v", "error", "-y",
    "-i", bedSource, "-i", duckedPath,
    "-filter_complex", "[0:a][1:a]amix=inputs=2:duration=first:dropout_transition=0:normalize=0[out]",
    "-map", "[out]", "-c:a", "pcm_s16le", "-ar", "48000", "-ac", "2", premasterPath,
  ], { label: "ffmpeg(mix-down)", timeoutMs: 900_000 });

  // ④ 母版响度（两遍法 loudnorm：-14 LUFS / -1 dBTP）
  const normalized = await normalizeLoudness({
    input: premasterPath, output: path.join(work, "master.wav"), targetLufs, truePeak, bins,
  });

  // ⑤ 与视频合流（画面不重编码）
  if (probe.video) {
    await runBin(bins.ffmpeg, [
      "-hide_banner", "-v", "error", "-y",
      "-i", input, "-i", normalized.path,
      "-map", "0:v:0", "-map", "1:a:0",
      "-c:v", "copy", "-c:a", "aac", "-b:a", "192k",
      "-movflags", "+faststart", "-shortest", output,
    ], { label: "ffmpeg(mux)", timeoutMs: 900_000 });
  } else {
    await fsp.copyFile(normalized.path, output);
  }

  const outputProbe = await probeMedia(output, { bins });
  const loudnessAfter = await measureLoudness(output, { bins, targetLufs, truePeak });

  const windows = {
    voice: voice.segments.filter((segment) => segment.duration >= 0.6).sort((a, b) => b.duration - a.duration).slice(0, 6),
    quiet: voice.silences.filter((segment) => segment.duration >= 0.4 && segment.start >= 0.2).sort((a, b) => b.duration - a.duration).slice(0, 6),
  };
  // 全程无绝对静音（连续口播/连续现场声）时，用「相对安静窗口」兜底测配乐可闻度：
  // 把 silencedetect 的阈值抬高 12dB 再找一次——它找到的不是静音，而是"这段片子相对最安静的地方"，
  // 这个来源会写进回执（quietWindowSource），避免把相对安静当成绝对静音来陈述。
  let quietWindowSource = "absolute-silence";
  if (windows.quiet.length === 0) {
    const relative = await detectVoiceBandSegments({
      input, duration, noiseDb: Math.min(-6, voice.noiseDb + 12), minSilenceSec: 0.35, minSegmentSec: 0.2, bins,
    });
    windows.quiet = relative.silences
      .filter((segment) => segment.duration >= 0.35 && segment.start >= 0.2)
      .sort((a, b) => b.duration - a.duration)
      .slice(0, 6);
    quietWindowSource = windows.quiet.length ? "relative-quiet(noise+12dB)" : "none";
  }
  const levelOf = async (file, list, band = null) => {
    const levels = [];
    for (const window of list) {
      const measured = await segmentMeanVolumeDb({ input: file, start: window.start, duration: Math.min(window.duration, 2), band, bins });
      levels.push(measured.meanDb);
    }
    return round(average(levels), 2);
  };
  const duckedInVoice = await levelOf(duckedPath, windows.voice);
  const duckedInQuiet = await levelOf(duckedPath, windows.quiet);
  const finalInQuiet = await levelOf(output, windows.quiet);
  const finalInVoiceBand = await levelOf(output, windows.voice, VOICE_BAND);
  const sourceInQuiet = await levelOf(input, windows.quiet);

  const duckingDepthDb = Number.isFinite(duckedInVoice) && Number.isFinite(duckedInQuiet)
    ? round(duckedInVoice - duckedInQuiet, 2)
    : null;
  const speechToMusicMarginDb = Number.isFinite(finalInVoiceBand) && Number.isFinite(duckedInVoice)
    ? round(finalInVoiceBand - duckedInVoice, 2)
    : null;
  const musicPresenceDb = Number.isFinite(finalInQuiet) && Number.isFinite(sourceInQuiet)
    ? round(finalInQuiet - sourceInQuiet, 2)
    : Number.isFinite(duckedInQuiet) && Number.isFinite(roomTone) ? round(duckedInQuiet - roomTone, 2) : null;

  const targets = findRecipes({ list: true }).targets;
  const checks = {
    loudness_ok: Number.isFinite(loudnessAfter.integratedLufs) && Math.abs(loudnessAfter.integratedLufs - targetLufs) <= 1.5,
    true_peak_ok: !Number.isFinite(loudnessAfter.truePeakDbtp) || loudnessAfter.truePeakDbtp <= truePeak + 0.2,
    music_audible: Number.isFinite(musicPresenceDb) ? musicPresenceDb >= targets.musicPresenceDb : false,
    dialogue_preserved: Number.isFinite(speechToMusicMarginDb) ? speechToMusicMarginDb >= 3 : true,
    ducking_applied: policy === "music-only" ? true : (Number.isFinite(duckingDepthDb) ? duckingDepthDb <= -4 : true),
  };
  const warnings = [];
  if (Number.isFinite(speechToMusicMarginDb) && speechToMusicMarginDb < targets.dialogueToMusicMarginDb) {
    warnings.push(`人声-音乐余量 ${speechToMusicMarginDb}dB 低于目标 ${targets.dialogueToMusicMarginDb}dB：建议下调 music_level_db 或加深 ducking`);
  }
  if (Number.isFinite(finalInQuiet) && Number.isFinite(speechLevel) && finalInQuiet - speechLevel > 3) {
    warnings.push(
      `无对白窗口的 BGM 电平 ${finalInQuiet}dB 比人声（${speechLevel}dB）还高 ${round(finalInQuiet - speechLevel, 1)}dB：`
      + "现场感会被削弱，建议下调 music_level_db",
    );
  }
  if (Number.isFinite(duckingDepthDb) && duckingDepthDb > -6 && policy !== "music-only") {
    warnings.push(`让位深度仅 ${duckingDepthDb}dB：人声出现时 BGM 压得不够，检查侧链与阈值`);
  }
  if (grid.verdict === "unaligned") {
    warnings.push(`卡点平均误差 ${grid.meanAbsErrorMs}ms（>120ms）：BPM 与剪辑节奏不匹配，建议换配方或改 BPM`);
  }

  // 失败关闭：配了像没配（不可闻）或人声被压住（<3dB 余量）→ 删除产物、如实报失败
  if (!checks.music_audible || !checks.dialogue_preserved) {
    await fsp.rm(output, { force: true }).catch(() => {});
    throw new BgmError(
      `配乐复检未通过（${!checks.music_audible ? `配乐可闻度 ${musicPresenceDb}dB < ${targets.musicPresenceDb}dB` : ""}`
      + `${!checks.dialogue_preserved ? `人声-音乐余量 ${speechToMusicMarginDb}dB < 3dB` : ""}）：已删除产物，不得作为成片交付`,
      "verify_failed",
    );
  }

  // ⑥ 证据：前后波形对比（可选再加频谱图）
  let evidence = null;
  if (evidenceDir) {
    await fsp.mkdir(evidenceDir, { recursive: true });
    const waveform = await renderWaveformCompare({
      before: input, after: output, output: path.join(evidenceDir, "waveform-before-after.png"), bins,
    });
    evidence = { waveform };
  }

  const report = {
    input,
    output,
    policy,
    bgm: {
      path: bgmPath,
      sha256: await sha256File(bgmPath),
      durationSeconds: bgmProbe.duration,
      looped: bgmProbe.duration < duration,
      bpm: grid.bpm,
      selfMeanDb: bgmMeanDb,
      appliedGainDb: musicGainDb,
    },
    separation,
    mix: {
      musicLevelDb: round(effectivePolicyLevel, 2),
      duckingDbTarget: round(effectiveDucking, 2),
      duckParams: duck,
      fadeInSec, fadeOutSec,
      targetLufs, truePeak,
      method: policy === "music-only" ? "music-only（原声按指令丢弃）" : "sidechaincompress 让位混音",
    },
    alignment: grid,
    levels: {
      speechLevelDb: speechLevel,
      roomToneDb: roomTone,
      duckedInVoiceDb: duckedInVoice,
      duckedInQuietDb: duckedInQuiet,
      finalInVoiceBandDb: finalInVoiceBand,
      sourceInQuietDb: sourceInQuiet,
      finalInQuietDb: finalInQuiet,
      duckingDepthDb,
      speechToMusicMarginDb,
      musicPresenceDb,
      programLevelDb: speechLevel,
    },
    loudness: {
      before: {
        integratedLufs: round(normalized.measuredBefore?.integratedLufs, 2),
        truePeakDbtp: round(normalized.measuredBefore?.truePeakDbtp, 2),
      },
      after: { integratedLufs: round(loudnessAfter.integratedLufs, 2), truePeakDbtp: round(loudnessAfter.truePeakDbtp, 2), lra: round(loudnessAfter.lra, 2) },
    },
    output: {
      path: output,
      durationSeconds: outputProbe.duration,
      sizeBytes: outputProbe.sizeBytes,
      audio: outputProbe.audio,
      hash: await sha256File(output),
    },
    checks,
    warnings,
    voiceActivity: {
      activeRatio: voice.activeRatio,
      segments: voice.segments.length,
      method: voice.method,
      quietWindowSource,
      quietWindowsUsed: windows.quiet.length,
    },
    evidence,
    license: { reviewed: licenseReviewed, commercialUse },
    workDir: keepWork ? work : null,
  };
  if (!keepWork) await fsp.rm(work, { recursive: true, force: true }).catch(() => {});
  return report;
}

/* ============================ 人声分离 ============================ */

/** 探测深度学习分离引擎（可选外部安装，不随仓分发）：WORKLOOM_BGM_DEMUCS 指定可执行文件。 */
export async function detectSeparationEngines(env = process.env) {
  const configured = (env.WORKLOOM_BGM_DEMUCS ?? "").trim();
  const candidates = configured ? [configured] : ["demucs", "audio-separator"];
  const available = [];
  for (const candidate of candidates) {
    const version = await binaryVersion(candidate, { timeoutMs: 20_000 });
    if (version) available.push({ command: candidate, version });
  }
  return { available, preferDeep: available.length > 0 };
}

/**
 * 人声分离（两档引擎，结果如实标注质量等级）：
 *
 * 1. `demucs` / `audio-separator`（若工位已安装，深度学习模型，质量 high）——不随仓分发；
 * 2. `ffmpeg` 中心声道近似（零依赖，质量 approximate）——立体声中置分量做人声、侧分量做伴奏。
 *
 * 为什么默认走近似：分离是"手段"不是"目的"，多数片子只需要让位（ducking）而不需要分轨；
 * 一旦真需要分轨（替换环境声、只留人声），再上深度学习引擎，且必须把质量等级写进交付证据。
 */
export async function separate({ input, outDir, engine = "auto", bins = resolveBinaries(), env = process.env }) {
  const probe = await probeMedia(input, { bins });
  const duration = probe.duration;
  await fsp.mkdir(outDir, { recursive: true });
  const vocalsPath = path.join(outDir, "vocals.wav");
  const instrumentalPath = path.join(outDir, "instrumental.wav");
  const attempts = [];

  const engines = await detectSeparationEngines(env);
  const wantsDeep = engine === "demucs" || engine === "auto";
  if (wantsDeep && engines.preferDeep) {
    const command = engines.available[0].command;
    const sourceWav = path.join(outDir, "_source.wav");
    try {
      await renderStem({ input, output: sourceWav, chain: "anull", durationSec: duration, bins, label: "ffmpeg(separate-prep)" });
      const args = command.endsWith("demucs") || command.includes("demucs")
        ? ["--two-stems=vocals", "-n", "htdemucs", "-o", outDir, sourceWav]
        : ["--output_dir", outDir, "--model", "htdemucs", sourceWav];
      const { stderr } = await runBin(command, args, { label: `separate(${command})`, timeoutMs: 1_800_000 });
      const stemDir = path.join(outDir, "htdemucs", path.basename(sourceWav, ".wav"));
      const deepVocals = path.join(stemDir, "vocals.wav");
      const deepInstrumental = path.join(stemDir, "no_vocals.wav");
      if (fs.existsSync(deepVocals) && fs.existsSync(deepInstrumental)) {
        await fsp.copyFile(deepVocals, vocalsPath);
        await fsp.copyFile(deepInstrumental, instrumentalPath);
        await fsp.rm(sourceWav, { force: true }).catch(() => {});
        return {
          input,
          engine: `deep:${command}`,
          quality: "high",
          qualityNote: "深度学习两轨分离（vocals / no_vocals）；仍建议抽听验收",
          vocals: { path: vocalsPath, sha256: await sha256File(vocalsPath) },
          instrumental: { path: instrumentalPath, sha256: await sha256File(instrumentalPath) },
          attempts,
          logTail: stderr.split("\n").filter(Boolean).slice(-3),
        };
      }
      attempts.push({ engine: command, status: "output_missing", detail: "未找到 htdemucs 输出目录" });
    } catch (error) {
      attempts.push({ engine: command, status: "failed", detail: error instanceof Error ? error.message : String(error) });
    }
  } else if (engine === "demucs") {
    throw new BgmError(
      "工位未安装 demucs/audio-separator（深度学习分离引擎不随仓分发）；请安装后设置 WORKLOOM_BGM_DEMUCS，或改 engine=ffmpeg",
      "separation_unavailable",
    );
  }

  if (probe.audio.channels < 2) {
    throw new BgmError(
      "中心声道近似分离需要立体声素材（当前为单声道）：单声道素材无法用 ffmpeg 近似分轨，请安装 demucs 后重试",
      "separation_unavailable",
    );
  }
  const chains = centerSeparationChain();
  await renderStem({ input, output: vocalsPath, chain: chains.vocals, durationSec: duration, bins, label: "ffmpeg(vocals)" });
  await renderStem({ input, output: instrumentalPath, chain: chains.instrumental, durationSec: duration, bins, label: "ffmpeg(instrumental)" });
  attempts.push({ engine: "ffmpeg-center", status: "used" });
  return {
    input,
    engine: "ffmpeg-center",
    quality: "approximate",
    qualityNote: "中心声道近似分离：中置人声提取 / 侧声道伴奏，非深度学习分离；只适合「让人声更清楚」这类用途，不适合母带级分轨",
    vocals: { path: vocalsPath, sha256: await sha256File(vocalsPath) },
    instrumental: { path: instrumentalPath, sha256: await sha256File(instrumentalPath) },
    attempts,
    stereo: true,
  };
}

/* ============================ 择优配乐（允许"不配"） ============================ */

/**
 * 择优配乐：先算后做，允许结论是"这片子不需要配乐"。
 *
 * 与调色 `colorwrite.best` 同构的 do-no-harm 纪律：候选池（配方 × 让位深度）先用解析式预估打分
 * （人声余量 / 配乐可闻度 / 让位是否过度），只有确有把握的赢家才真正出片，出片后再用**实测**复检；
 * 预估分不达标或素材疑似已有配乐 → 判定"无需配乐"，不产出任何文件。
 */
export async function best({
  input, output = null, genre = null, mood = null, recipeIds = null, policy = "keep-dialogue",
  minScore = 92, evidenceDir = null, bins = resolveBinaries(), seed = 0, targetLufs = -14, truePeak = -1.0,
  bpmStrategy = "cut-driven",
}) {
  const probe = await probeMedia(input, { bins });
  const duration = probe.duration;
  const voice = await detectVoiceBandSegments({ input, duration, bins });
  const detected = probe.video ? await detectCuts({ input, bins }) : { cuts: [], strong: [], method: "no-video" };
  const roomWindows = voice.silences
    .filter((segment) => segment.duration >= 0.4 && segment.start >= 0.2)
    .sort((a, b) => b.duration - a.duration)
    .slice(0, 4);
  const voiceWindows = voice.segments
    .filter((segment) => segment.duration >= 0.6)
    .sort((a, b) => b.duration - a.duration)
    .slice(0, 4);
  const levelOf = async (list, band = null) => {
    const levels = [];
    for (const window of list) {
      const measured = await segmentMeanVolumeDb({ input, start: window.start, duration: Math.min(window.duration, 2), band, bins });
      levels.push(measured.meanDb);
    }
    return round(average(levels), 2);
  };
  const speechLevel = await levelOf(voiceWindows, VOICE_BAND);
  const roomTone = await levelOf(roomWindows);
  const spectrum = voiceWindows[0]
    ? await segmentSpectralStats({ input, start: voiceWindows[0].start, duration: Math.min(voiceWindows[0].duration, 3), bins })
    : null;
  const suspectedBed = voice.activeRatio >= 0.9 && spectrum?.flatness !== null && spectrum?.flatness !== undefined && spectrum.flatness < 0.02;
  if (suspectedBed) {
    return {
      verdict: "no_bgm_needed",
      reason: `素材疑似已有连续配乐（人声频段活动占比 ${(voice.activeRatio * 100).toFixed(1)}%、谱平坦度 ${spectrum?.flatness}）：按「不劣化优先」判定无需配乐，未产出新文件`,
      source: { speechLevelDb: speechLevel, roomToneDb: roomTone, activeRatio: voice.activeRatio },
      candidates: [],
      sha256: await sha256File(input),
    };
  }

  const catalog = findRecipes({ list: true }).items;
  let pool = catalog;
  if (Array.isArray(recipeIds) && recipeIds.length) pool = catalog.filter((recipe) => recipeIds.includes(recipe.id));
  else if (genre || mood) {
    const filtered = catalog.filter((recipe) => {
      const genreHit = genre ? recipe.genre.includes(String(genre)) : false;
      const moodHit = mood ? recipe.mood.includes(String(mood)) : false;
      return genreHit || moodHit;
    });
    if (filtered.length) pool = filtered;
  }
  pool = pool.slice(0, 3);
  if (!pool.length) throw new BgmError("没有可用配方（recipe_ids/genre/mood 过滤后为空）", "not_found");

  const candidates = [];
  for (const recipe of pool) {
    const tempo = bpmStrategy === "cut-driven" && detected.cuts.length
      ? deriveTempoFromCuts({ cuts: detected.cuts, baseBpm: recipe.bpm })
      : { bpm: recipe.bpm, source: "recipe", note: null };
    const alignment = alignBeatGrid({ bpm: tempo.bpm, cuts: detected.cuts });
    for (const duckDepth of [recipe.duckingDb - 2, recipe.duckingDb, recipe.duckingDb + 2]) {
      const depth = Math.max(6, Math.min(18, duckDepth));
      const musicLevel = Math.max(-30, Math.min(-16, recipe.musicLevelDb));
      const margin = Number.isFinite(speechLevel) ? round(speechLevel - (musicLevel + depth), 2) : null;
      const presence = Number.isFinite(roomTone) ? round(musicLevel - roomTone, 2) : null;
      let score = 100;
      const reasons = [];
      if (margin !== null && margin < 6) {
        const penalty = (6 - margin) * 5;
        score -= penalty;
        reasons.push(`人声余量预估 ${margin}dB（目标 ≥6dB）：-${round(penalty, 1)}`);
      }
      if (presence !== null && presence < 3) {
        const penalty = (3 - presence) * 6;
        score -= penalty;
        reasons.push(`配乐可闻度预估 ${presence}dB（目标 ≥3dB）：-${round(penalty, 1)}`);
      }
      if (musicLevel > -16) {
        const penalty = (musicLevel + 16) * 4;
        score -= penalty;
        reasons.push(`配乐电平 ${musicLevel}dB 偏高：-${round(penalty, 1)}`);
      }
      if (depth > 14) {
        const penalty = (depth - 14) * 2;
        score -= penalty;
        reasons.push(`让位深度 ${depth}dB 过大（易抽气）：-${round(penalty, 1)}`);
      }
      if (Number.isFinite(alignment.meanAbsErrorMs) && alignment.meanAbsErrorMs > 40) {
        const penalty = alignment.meanAbsErrorMs * 0.15;
        score -= penalty;
        reasons.push(`卡点预估误差 ${alignment.meanAbsErrorMs}ms：-${round(penalty, 1)}`);
      }
      candidates.push({
        id: `${recipe.id}@duck${depth}`,
        recipeId: recipe.id,
        label: `${recipe.genre} · ${recipe.mood}（${tempo.bpm}BPM / 让位 ${depth}dB）`,
        musicLevelDb: musicLevel,
        duckingDb: depth,
        bpm: tempo.bpm,
        tempo,
        score: round(score, 2),
        predicted: {
          speechToMusicMarginDb: margin,
          musicPresenceDb: presence,
          alignmentMeanAbsErrorMs: alignment.meanAbsErrorMs,
          alignmentVerdict: alignment.verdict,
        },
        reasons,
      });
    }
  }
  candidates.sort((a, b) => b.score - a.score);
  const winner = candidates[0];
  if (!winner || winner.score < minScore) {
    return {
      verdict: "no_bgm_needed",
      reason: `最佳候选「${winner?.label ?? "无"}」预估分 ${winner?.score ?? 0}（阈值 ${minScore}）：没有安全的配乐窗口（人声太满 / 环境底噪太高 / 配乐会不可闻），按「不劣化优先」判定无需配乐`,
      source: { speechLevelDb: speechLevel, roomToneDb: roomTone, activeRatio: voice.activeRatio },
      candidates,
      sha256: await sha256File(input),
    };
  }
  if (!output) throw new BgmError("已有更优候选，但未提供 output_path（择优配乐需要输出路径）", "bad_request");

  const recipe = loadRecipes().recipes.find((item) => item.id === winner.recipeId);
  const work = await tempDir("bgm-best-");
  const bgmPath = path.join(work, "bgm.wav");
  const composed = await composeToWav({ recipe, durationSec: duration, output: bgmPath, seed, bpmOverride: winner.bpm });
  const mixed = await mix({
    input,
    output,
    bgmPath,
    policy,
    bgmBpm: winner.bpm,
    musicLevelDb: winner.musicLevelDb,
    duckingDb: winner.duckingDb,
    targetLufs,
    truePeak,
    evidenceDir,
    bins,
  });
  await fsp.rm(work, { recursive: true, force: true }).catch(() => {});
  return {
    verdict: "scored",
    winner: winner.id,
    winnerLabel: winner.label,
    score: winner.score,
    minScore,
    recipe: { id: recipe.id, genre: recipe.genre, mood: recipe.mood, key: recipe.key, mode: recipe.mode, bpm: recipe.bpm, chords: recipe.chords },
    tempo: winner.tempo,
    composed,
    source: { speechLevelDb: speechLevel, roomToneDb: roomTone, activeRatio: voice.activeRatio },
    cuts: { candidates: detected.cuts.length, strong: (detected.strong ?? []).length, threshold: detected.strongThreshold ?? null },
    candidates,
    report: mixed,
    sha256: mixed.output.hash,
  };
}

/* ============================ 自算作曲入口 ============================ */

/**
 * 按配方合成一条 BGM（时长可对齐片子），或按 duration_seconds 独立生成。
 * 产物属于「本仓自算合成」：无第三方权利、无署名义务、可商用于客户交付。
 */
export async function compose({
  input = null, output, recipeId = null, genre = null, mood = null, durationSeconds = null,
  seed = 0, bpmOverride = null, bpmStrategy = "recipe", bins = resolveBinaries(),
}) {
  let duration = Number(durationSeconds);
  let probe = null;
  if ((!Number.isFinite(duration) || duration <= 0) && input) {
    probe = await probeMedia(input, { bins });
    duration = probe.duration;
  }
  if (!Number.isFinite(duration) || duration <= 0) {
    throw new BgmError("缺少时长：要么给 input_path（取片子时长），要么给 duration_seconds", "bad_request");
  }
  const found = findRecipes({ recipeId, genre, mood });
  if (!found.recipe) {
    throw new BgmError(`没有匹配的配乐配方（genre=${genre ?? "-"} mood=${mood ?? "-"}）；先跑 bgmread.recipes 看清单`, "not_found");
  }
  let tempo = { bpm: Number(bpmOverride ?? found.recipe.bpm), source: bpmOverride ? "explicit" : "recipe", note: null };
  if (bpmOverride === null && bpmStrategy === "cut-driven" && input) {
    if (!probe) probe = await probeMedia(input, { bins });
    if (probe.video) {
      const detected = await detectCuts({ input, bins });
      tempo = deriveTempoFromCuts({ cuts: detected.cuts, baseBpm: found.recipe.bpm });
    } else {
      tempo = { bpm: found.recipe.bpm, source: "recipe", note: "输入无视频轨，无法按剪辑点定速" };
    }
  }
  const composed = await composeToWav({
    recipe: found.recipe, durationSec: duration, output, seed: Number(seed) || 0,
    bpmOverride: tempo.bpm,
  });
  return {
    ...composed,
    tempo,
    recipe: {
      id: found.recipe.id,
      genre: found.recipe.genre,
      scene: found.recipe.scene,
      mood: found.recipe.mood,
      key: found.recipe.key,
      mode: found.recipe.mode,
      bpm: composed.plan.bpm,
      chords: found.recipe.chords,
      instrumentation: found.recipe.instrumentation,
      avoid: found.recipe.avoid ?? [],
      notes: found.recipe.notes ?? null,
    },
    license: { license: "workloom-self-generated", label: licenseInfo("workloom-self-generated").label, commercialOk: true, attributionRequired: false },
    alternatives: found.alternatives,
  };
}

/* ============================ 作业留痕 ============================ */

export async function jobAppend(dir, record) {
  await fsp.mkdir(dir, { recursive: true });
  const file = path.join(dir, "jobs.jsonl");
  await fsp.appendFile(file, `${JSON.stringify({ at: new Date().toISOString(), ...record })}\n`, "utf8");
  return file;
}

export function jobsDir(env = process.env) {
  return env.WORKLOOM_BGM_JOBS_DIR || path.join(os.homedir(), ".workloom-bgm", "jobs");
}

/* ============================ 工具分发 ============================ */

export async function callTool(name, params = {}, { bins = resolveBinaries(), env = process.env } = {}) {
  if (!isBgmTool(name)) {
    throw new BgmError(`配乐工位不提供工具 ${name}`, "not_provided");
  }
  const roots = allowedRoots(env);
  const text = (value, label) => {
    if (typeof value !== "string" || !value.trim()) throw new BgmError(`${label} 缺失`, "bad_request");
    return value;
  };
  const optionalNumber = (value) => (value === undefined || value === null || value === "" ? null : Number(value));

  switch (name) {
    case "bgmread.health": {
      const ffmpeg = await binaryVersion(bins.ffmpeg);
      const ffprobe = await binaryVersion(bins.ffprobe);
      const engines = await detectSeparationEngines(env);
      const library = loadLibraryTracks(env);
      return {
        result: {
          ok: Boolean(ffmpeg && ffprobe),
          ffmpeg,
          ffprobe,
          tools: BGM_TOOLS,
          policies: AUDIO_POLICIES,
          synth: "builtin-wav（自算作曲，零第三方音源）",
          separationEngines: engines,
          library: { dir: library.dir, present: library.present, tracks: library.tracks.length, note: library.note },
          recipes: loadRecipes().recipes.length,
          allowedRoots: roots,
        },
        receipt: { synced: Boolean(ffmpeg && ffprobe) },
      };
    }

    case "bgmread.probe": {
      const input = assertPathAllowed(text(params.input_path, "input_path"), roots, "input_path");
      if (!fs.existsSync(input)) throw new BgmError(`文件不存在：${input}`, "not_found");
      const probe = await probeMedia(input, { bins });
      return { result: { path: input, ...probe }, receipt: { synced: true, sha256: await sha256File(input) } };
    }

    case "bgmread.analyze": {
      const input = assertPathAllowed(text(params.input_path, "input_path"), roots, "input_path");
      const report = await analyze({
        input,
        noiseDb: optionalNumber(params.noise_db) ?? -38,
        bins,
      });
      return { result: report, receipt: { synced: true, sha256: await sha256File(input) } };
    }

    case "bgmread.recipes": {
      const result = findRecipes({
        recipeId: params.recipe_id ?? null,
        genre: params.genre ?? null,
        mood: params.mood ?? null,
        platform: params.platform ?? null,
        keyword: params.keyword ?? null,
        list: params.list === true,
      });
      return {
        result,
        receipt: { synced: true, snapshot_uri: `bgm://recipes/${params.recipe_id ?? "list"}`, verified_at: new Date().toISOString() },
      };
    }

    case "bgmread.library": {
      const result = findTracks({
        trackId: params.track_id ?? null,
        mood: params.mood ?? null,
        genre: params.genre ?? null,
        minDurationSec: optionalNumber(params.min_duration_sec),
        bpmMin: optionalNumber(params.bpm_min),
        bpmMax: optionalNumber(params.bpm_max),
        commercialUse: params.commercial_use !== false,
        licenseReviewed: params.license_reviewed !== false,
      }, env);
      let attributionFile = null;
      if (params.attribution_out && result.track) {
        const target = assertPathAllowed(String(params.attribution_out), roots, "attribution_out");
        const raw = loadLibraryTracks(env).tracks.find((track) => track.id === result.track.id) ?? result.track;
        attributionFile = await writeAttributionFile(raw, target);
      }
      return {
        result: { ...result, attributionFile },
        receipt: { synced: true, snapshot_uri: `bgm://library/${params.track_id ?? "search"}`, verified_at: new Date().toISOString() },
      };
    }

    case "bgmwrite.compose": {
      const output = assertPathAllowed(text(params.output_path, "output_path"), roots, "output_path");
      const input = params.input_path ? assertPathAllowed(String(params.input_path), roots, "input_path") : null;
      const composed = await compose({
        input,
        output,
        recipeId: params.recipe_id ?? null,
        genre: params.genre ?? null,
        mood: params.mood ?? null,
        durationSeconds: optionalNumber(params.duration_seconds),
        seed: optionalNumber(params.seed) ?? 0,
        bpmOverride: optionalNumber(params.bpm),
        bpmStrategy: params.bpm_strategy === "cut-driven" ? "cut-driven" : "recipe",
        bins,
      });
      return {
        result: composed,
        receipt: {
          synced: true,
          snapshot_uri: `bgm://compose/${path.basename(composed.output)}?sha256=${composed.sha256}`,
          sha256: composed.sha256,
          verified_at: new Date().toISOString(),
        },
      };
    }

    case "bgmwrite.mix": {
      const input = assertPathAllowed(text(params.input_path, "input_path"), roots, "input_path");
      const output = assertPathAllowed(text(params.output_path, "output_path"), roots, "output_path");
      if (params.overwrite_source === true || output === input) {
        throw new BgmError("禁止覆盖原片", "overwrite_source_forbidden");
      }
      const bgmPath = assertPathAllowed(text(params.bgm_path, "bgm_path"), roots, "bgm_path");
      const evidenceDir = params.evidence_dir ? assertPathAllowed(String(params.evidence_dir), roots, "evidence_dir") : null;
      if (params.skip_verify === true || params.verify === false) {
        throw new BgmError("配乐调用必须带复检（响度/人声余量/配乐可闻度）；关闭校验的调用禁止执行（围栏 G-BGM3）", "bad_request");
      }
      const trackLicense = params.track_license ? String(params.track_license) : null;
      if (trackLicense) {
        assertLicenseUsable(
          { id: params.track_id ?? path.basename(bgmPath), license: trackLicense },
          { commercialUse: params.commercial_use !== false, licenseReviewed: params.license_reviewed !== false },
        );
      }
      const report = await mix({
        input,
        output,
        bgmPath,
        policy: params.policy ?? "keep-dialogue",
        bgmBpm: optionalNumber(params.bgm_bpm),
        musicLevelDb: optionalNumber(params.music_level_db),
        duckingDb: optionalNumber(params.ducking_db),
        targetLufs: optionalNumber(params.target_lufs) ?? -14,
        truePeak: optionalNumber(params.true_peak_dbtp) ?? -1.0,
        fadeInSec: optionalNumber(params.fade_in_sec) ?? 1.2,
        fadeOutSec: optionalNumber(params.fade_out_sec) ?? 1.6,
        align: params.align !== false,
        allowDiscardOriginal: params.allow_discard_original === true,
        evidenceDir,
        bins,
        keepWork: params.keep_work === true,
        licenseReviewed: params.license_reviewed !== false,
        commercialUse: params.commercial_use !== false,
      });
      let attributionFile = null;
      if (params.attribution_out) {
        const target = assertPathAllowed(String(params.attribution_out), roots, "attribution_out");
        attributionFile = await writeAttributionFile(
          {
            id: params.track_id ?? path.basename(bgmPath),
            title: params.track_title ?? params.track_id ?? path.basename(bgmPath),
            artist: params.track_artist ?? null,
            source: params.track_source ?? null,
            license: trackLicense ?? "workloom-self-generated",
          },
          target,
        );
      }
      return {
        // 顶层暴露 output_path / sha256：与 color-bridge 同口径，便于事件账本按
        // `result->>'sha256'` 直接核验产物（嵌套结构仍完整保留在 result.report 里）。
        result: {
          ...report,
          output_path: report.output.path,
          sha256: report.output.hash,
          attributionFile,
        },
        receipt: {
          synced: true,
          snapshot_uri: `bgm://mix/${path.basename(report.output.path)}?sha256=${report.output.hash}`,
          sha256: report.output.hash,
          verified_at: new Date().toISOString(),
        },
      };
    }

    case "bgmwrite.separate": {
      const input = assertPathAllowed(text(params.input_path, "input_path"), roots, "input_path");
      const outDir = assertPathAllowed(text(params.out_dir, "out_dir"), roots, "out_dir");
      const result = await separate({ input, outDir, engine: params.engine ?? "auto", bins, env });
      return {
        result,
        receipt: { synced: true, sha256: result.vocals.sha256, verified_at: new Date().toISOString() },
      };
    }

    case "bgmwrite.best": {
      const input = assertPathAllowed(text(params.input_path, "input_path"), roots, "input_path");
      const output = params.output_path ? assertPathAllowed(String(params.output_path), roots, "output_path") : null;
      if (output && output === input) throw new BgmError("禁止覆盖原片", "overwrite_source_forbidden");
      const evidenceDir = params.evidence_dir ? assertPathAllowed(String(params.evidence_dir), roots, "evidence_dir") : null;
      const outcome = await best({
        input,
        output,
        genre: params.genre ?? null,
        mood: params.mood ?? null,
        recipeIds: Array.isArray(params.recipe_ids) ? params.recipe_ids.map(String) : null,
        policy: params.policy ?? "keep-dialogue",
        minScore: optionalNumber(params.min_score) ?? 92,
        evidenceDir,
        bins,
        seed: optionalNumber(params.seed) ?? 0,
        bpmStrategy: params.bpm_strategy === "recipe" ? "recipe" : "cut-driven",
      });
      return {
        result: outcome,
        receipt: {
          synced: true,
          snapshot_uri: outcome.verdict === "scored"
            ? `bgm://best/${path.basename(outcome.report.output.path)}?sha256=${outcome.sha256}`
            : `bgm://best/no-change?sha256=${outcome.sha256}`,
          sha256: outcome.sha256,
          verified_at: new Date().toISOString(),
        },
      };
    }

    default:
      throw new BgmError(`未实现的工具：${name}`, "not_provided");
  }
}

/* ============================ 稳定序列化 ============================ */

export const STABLE_JSON = (value) => JSON.stringify(sortValue(value));

function sortValue(value) {
  if (Array.isArray(value)) return value.map(sortValue);
  if (value && typeof value === "object") {
    return Object.keys(value).sort().reduce((acc, key) => {
      acc[key] = sortValue(value[key]);
      return acc;
    }, {});
  }
  return value;
}

export function hashKey(text) {
  let hash = 0xcbf29ce484222325n;
  const prime = 0x100000001b3n;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= BigInt(text.charCodeAt(index));
    hash = (hash * prime) & 0xffffffffffffffffn;
  }
  return hash.toString(16).padStart(16, "0");
}
