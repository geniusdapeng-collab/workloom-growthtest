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

import { randomUUID } from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  MeasureError, binaryVersion, classifySegments, decodePcm, detectCuts, detectVoiceBandSegments,
  energyEnvelope, estimateBpmFromOnsets, measureLoudness, onsetStrength, probeMedia,
  renderWaveformCompare, resolveBinaries, round, runBin, scoreSegments, segmentMeanVolumeDb,
  segmentSpectralStats, sha256File, tempDir,
} from "./measure.mjs";
import { composeToWav, planComposition } from "./synth.mjs";
import { verifyAudioStemBundle, snapshotAudioStemArtifact } from "./audio-stems.mjs";
import { createAudioStemReceiptVerifier } from "./audio-stems-trust.mjs";
import { analyzePromptBrief, energyCurveFor, scoreTrackAgainstBrief } from "./brief.mjs";
import { cacheDir as onlineCacheDir, fetchCandidate, listSources, searchOnline } from "./sources.mjs";
import { defaultScanRoots, discoverLibraries, packLibrary, rebindLibrary, tagLibrary, writeLibrary } from "./tag.mjs";

/** 工位对外错误类型（与 measure 内核同源，统一 code 语义）。 */
export const BgmError = MeasureError;

/* ============================ 工具面 ============================ */

/** 本连接器提供的工具面；不在表内的工具直接拒绝（与 color-bridge 同款白名单纪律）。 */
export const BGM_TOOLS = [
  "bgmread.health",
  "bgmread.probe",
  "bgmread.analyze",
  "bgmread.structure",
  "bgmread.brief",
  "bgmread.recipes",
  "bgmread.library",
  "bgmwrite.compose",
  "bgmwrite.fetch",
  "bgmwrite.mix",
  "bgmwrite.separate",
  "bgmwrite.best",
  "bgmwrite.tag",
  "bgmwrite.library",
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
 * 平台差异参数（T-15）：配方可在同层声明 `platformOverrides = { douyin: { musicLevelDb?, duckingDb?, lufsTarget? } }`。
 * 仅当调用上下文显式给出目标平台且配方声明了该平台覆盖时才生效（覆盖值参与打分/混音参数推导）；
 * 无平台上下文或未声明覆盖时返回配方基准值——行为与既有口径完全一致。
 */
export function applyPlatformOverrides(recipe, platform = null) {
  const result = {
    musicLevelDb: recipe?.musicLevelDb ?? null,
    duckingDb: recipe?.duckingDb ?? null,
    lufsTarget: null,
    override: null,
  };
  const key = String(platform ?? "").trim().toLowerCase();
  if (!recipe || !key) return result;
  const overrides = recipe.platformOverrides?.[key];
  if (!overrides || typeof overrides !== "object") return result;
  const applied = {};
  for (const field of ["musicLevelDb", "duckingDb", "lufsTarget"]) {
    if (Number.isFinite(overrides[field])) {
      applied[field] = overrides[field];
      result[field] = overrides[field];
    }
  }
  if (Object.keys(applied).length) result.override = { platform: key, ...applied };
  return result;
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
        platformOverrides: recipe.platformOverrides ?? null,
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

/**
 * 本地曲库根目录（可多个，按优先级）：
 * 1. `WORKLOOM_BGM_LIBRARY_DIR`（客户自建曲库，最高优先）
 * 2. `bundles/ai-video/library/bgm-library-curated`（**随仓库分发的 12 首精选**，每风格 1 首）
 * 3. `WORKLOOM_BGM_HOME/library`（默认 `~/.workloom-bgm/library`，工位本地 50–70 首全量曲库）
 *
 * 三个目录都用同一份 `tracks.json` 契约；同 id 时前面的优先（客户可以覆盖仓库版本）。
 */
export function libraryRoots(env = process.env) {
  const here = path.dirname(new URL(import.meta.url).pathname);
  const custom = (env.WORKLOOM_BGM_LIBRARY_DIR ?? "").trim();
  const workbenchHome = (env.WORKLOOM_BGM_HOME ?? "").trim() || path.join(os.homedir(), ".workloom-bgm");
  const candidates = [
    custom ? { dir: path.resolve(custom), kind: "local-custom", label: "客户自建曲库" } : null,
    { dir: path.resolve(here, "../../library/bgm-library-curated"), kind: "local-curated", label: "随仓兜底曲库（50 首选段）" },
    { dir: path.join(workbenchHome, "library"), kind: "local-workbench", label: "工位本地曲库" },
  ].filter(Boolean);
  const seen = new Set(candidates.map((entry) => entry.dir));
  const roots = [...candidates];
  /**
   * 自动发现（"用户单独下载了素材文件夹，系统自己认出来"）：
   * 在 Downloads / Documents / Desktop / 外接盘（可用 WORKLOOM_BGM_SCAN_ROOTS 覆盖）里找带 `tracks.json`
   * 的目录并抽样核验；`WORKLOOM_BGM_DISCOVER=0` 可关掉（极简部署或磁盘挂载慢时用）。
   * 发现到的库排在显式配置之后（显式配置永远优先），同 id 由 `loadAllLocalTracks` 先到先得。
   */
  if ((env.WORKLOOM_BGM_DISCOVER ?? "1") !== "0") {
    try {
      for (const found of discoverLibraries({ scanRoots: defaultScanRoots(env) })) {
        if (seen.has(found.dir) || !found.usable) continue;
        seen.add(found.dir);
        roots.push({
          dir: found.dir,
          kind: "local-discovered",
          label: `自动发现的曲库（${found.libraryName}）`,
          discovered: { tracks: found.tracks, sample: found.sample, needsRebind: found.needsRebind },
        });
      }
    } catch {
      /* 自动发现失败不阻塞配乐：显式配置的三个根照常工作 */
    }
  }
  const deduped = [];
  const pushed = new Set();
  for (const entry of roots) {
    if (pushed.has(entry.dir)) continue;
    pushed.add(entry.dir);
    deduped.push(entry);
  }
  return deduped;
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

/** 合并读取全部本地曲库根（客户曲库 / 随仓精选 / 工位本地），同 id 先到先得。 */
export function loadAllLocalTracks(env = process.env) {
  const roots = libraryRoots(env);
  const byId = new Map();
  const sources = [];
  for (const root of roots) {
    const file = path.join(root.dir, "tracks.json");
    if (!fs.existsSync(file)) {
      sources.push({ ...root, present: false, tracks: 0 });
      continue;
    }
    let doc;
    try {
      doc = JSON.parse(fs.readFileSync(file, "utf8"));
    } catch (error) {
      throw new BgmError(`曲库索引解析失败（${file}）：${error instanceof Error ? error.message : String(error)}`, "bad_request");
    }
    const tracks = Array.isArray(doc?.tracks) ? doc.tracks : [];
    let added = 0;
    for (const track of tracks) {
      if (!track?.id || byId.has(track.id)) continue;
      byId.set(track.id, {
        ...track,
        libraryRoot: root.dir,
        libraryKind: root.kind,
        localPath: track.file ? path.resolve(root.dir, track.file) : null,
        origin: root.kind === "local-curated" ? "library-curated" : "library-local",
      });
      added += 1;
    }
    sources.push({ ...root, present: true, file, tracks: added });
  }
  return { tracks: [...byId.values()], sources, total: byId.size };
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
  /**
   * 多曲库根合并（2026-09-24 修复）：
   * 早先这里用 `loadLibraryTracks()`——**只读** `library/bgm-library` 单目录；
   * 而随仓兜底曲库在 `library/bgm-library-curated`、工位曲库在 `~/.workloom-bgm/library`，
   * 于是 `bgm-cli library` 恒报「曲库未接入（缺 tracks.json）」：库里 1000+ 首曲子，
   * 选曲入口却看不见，只能退回自算作曲（真机 VID-PJL01 配乐被迫走旧通路）。
   * 与 `resolveTrackForBrief` 对齐，改用 `loadAllLocalTracks()`（客户库 → 随仓 → 工位）。
   */
  const library = loadAllLocalTracks(env);
  const presentSources = library.sources.filter((source) => source.present);
  const libraryPresent = presentSources.length > 0;
  const libraryNote = libraryPresent ? null : "曲库未接入（缺 tracks.json）；可用 bgmwrite.compose 走自算作曲";
  /** 曲目所在根目录（用于把 tracks.json 里的相对 path 还原成绝对路径） */
  const rootOf = (kind) => library.sources.find((source) => source.kind === kind)?.dir ?? library.dir;
  const norm = (value) => String(value ?? "").trim().toLowerCase();
  const mood = norm(query.mood);
  const genre = norm(query.genre);
  const minDuration = Number(query.minDurationSec ?? 0);
  const commercialUse = query.commercialUse !== false;
  const bpmMin = Number(query.bpmMin ?? 0);
  const bpmMax = Number(query.bpmMax ?? 400);
  /**
   * 返回条数上限（2026-09-26 真机修复）：
   * 早先**硬编码** `items.slice(0, 20)`，而切片发生在任何排序**之前**——
   * 于是"1034 首的曲库"在选曲侧只能看到库里前 20 首（真机：选曲永远只在 20 首里挑，
   * 好曲子进不了候选池）。现在上限可配：`query.limit`（默认 20，保持既有调用行为），
   * 调用方要全量候选池时传 `limit: 2000`（选曲/回填/审计用）。
   */
  const limitRaw = Number(query.limit ?? 20);
  const limit = Number.isFinite(limitRaw) && limitRaw > 0 ? Math.min(5000, Math.floor(limitRaw)) : 20;

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
      const absolute = track.localPath ?? (track.path ? path.resolve(rootOf(track.libraryKind), track.path) : null);
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
    libraryDir: presentSources.map((source) => source.dir).join(" + "),
    libraryPresent,
    note: libraryNote,
    total: library.tracks.length,
    matched: items.length,
    commercialUse,
    track: selected,
    limit,
    items: items.slice(0, limit),
    licenseTable: LICENSE_TABLE,
    sources: library.sources,
  };
}

/** 写署名文件（有署名义务的曲目必须随交付物留档）。 */
/**
 * 曲目三级解析：**在线源（优先）→ 本地曲库（兜底）→ 自算作曲（最后兜底）**。
 *
 * 每一级都要过"许可可商用"闸；任何一级成功都要把"用了哪一级、为什么降级、候选打分"写进回执。
 * 这是本仓对"实时在线取曲 + 离线可用"的实现口径：在线不可用不等于失败，但**必须如实说明降级**。
 */
export async function resolveTrackForBrief({
  brief = null, recipe = null, policy = "online-first", durationSec = null,
  env = process.env, fetchImpl = fetch, destDir = null, limit = 8, catalog = null,
}) {
  const attempts = [];
  const recipes = loadRecipes().recipes;
  const wanted = String(policy ?? "online-first");

  if (wanted === "online-first" || wanted === "online-only") {
    try {
      const { candidates, attempts: searchAttempts, configuredSources } = await searchOnline({
        brief, recipe, limit, env, fetchImpl, catalog,
      });
      attempts.push(...searchAttempts.map((entry) => ({ ...entry, layer: "online" })));
      if (!candidates.length) {
        attempts.push({ layer: "online", source: "-", status: "no_candidates", message: configuredSources.length ? "已配置的在线源没有返回可下载曲目" : "没有任何在线源被配置" });
      } else {
        const scored = candidates
          .map((candidate) => {
            const info = licenseInfo(candidate.license);
            const match = scoreTrackAgainstBrief({ track: candidate, brief: brief ?? { recipeId: recipe?.id ?? null, genreTags: [], energyLevel: "medium", bpmScale: 1, instrumentation: { avoid: [] }, durationSec }, recipeCatalog: recipes });
            return { candidate, info, match };
          })
          .sort((a, b) => b.match.score - a.match.score);
        // T-05：题材 veto 出局的候选不得进入商用候选池（与本地库同一纪律，不再只靠分数排序）。
        const compliant = scored.filter((entry) => entry.info.commercial === true && entry.match.verdict !== "rejected");
        const vetoed = scored.filter((entry) => entry.match.verdict === "rejected" && entry.info.commercial === true);
        if (vetoed.length) {
          attempts.push({
            layer: "online", source: vetoed[0].candidate.source, status: "genre_vetoed",
            message: `题材未命中且策略 veto：出局 ${vetoed.length} 首（如 ${vetoed[0].candidate.id}：${vetoed[0].match.reasons.find((reason) => reason.includes("题材未命中")) ?? "题材不符"}）`,
          });
        }
        const rejected = scored.filter((entry) => entry.info.commercial !== true);
        if (rejected.length) {
          attempts.push({
            layer: "online", source: rejected[0].candidate.source, status: "license_rejected",
            message: `拒收 ${rejected.length} 首非可商用/许可不明曲目（如 ${rejected[0].candidate.id}：${rejected[0].info.label}）`,
          });
        }
        if (compliant.length) {
          const winner = compliant[0];
          try {
            const fetched = await fetchCandidate({
              candidate: winner.candidate,
              destDir: destDir ?? onlineCacheDir(env),
              env, fetchImpl,
            });
            attempts.push({
              layer: "online", source: winner.candidate.source, status: "used",
              message: `命中「${winner.candidate.title ?? winner.candidate.id}」（匹配分 ${winner.match.score}，许可 ${winner.info.label}${fetched.cached ? "，命中本地缓存" : "，已下载"}）`,
            });
            return {
              layer: "online",
              track: {
                ...fetched,
                bpm: fetched.bpm ?? null,
                durationSec: fetched.durationSec ?? null,
                match: winner.match,
                licenseLabel: winner.info.label,
                licenseReviewed: true,
              },
              attempts,
              degraded: false,
            };
          } catch (error) {
            attempts.push({
              layer: "online", source: winner.candidate.source,
              status: error instanceof BgmError ? error.code : "download_failed",
              message: error instanceof Error ? error.message.slice(0, 200) : String(error),
            });
          }
        } else {
          attempts.push({ layer: "online", source: "-", status: "no_compliant_match", message: "在线候选里没有许可可商用的匹配（NC/ND/未知一律拒收）" });
        }
      }
    } catch (error) {
      attempts.push({
        layer: "online", source: "-",
        status: error instanceof BgmError ? error.code : "error",
        message: error instanceof Error ? error.message.slice(0, 200) : String(error),
      });
    }
    if (wanted === "online-only") {
      return { layer: null, track: null, attempts, degraded: false, failed: true, reason: "online-only 模式下在线取源失败" };
    }
  }

  // ② 本地曲库兜底（客户曲库 → 随仓精选 12 首 → 工位本地 50–70 首）
  const local = loadAllLocalTracks(env);
  const scoredLocal = local.tracks
    .map((track) => {
      const info = licenseInfo(track.license);
      const match = scoreTrackAgainstBrief({
        track,
        brief: brief ?? { recipeId: recipe?.id ?? null, genreTags: [], energyLevel: "medium", bpmScale: 1, instrumentation: { avoid: [] }, durationSec },
        recipeCatalog: recipes,
      });
      return { track, info, match };
    })
    .filter((entry) => entry.info.commercial === true && entry.match.verdict !== "rejected")
    .sort((a, b) => b.match.score - a.match.score);
  if (scoredLocal.length) {
    const winner = scoredLocal[0];
    attempts.push({
      layer: "local", source: winner.track.libraryKind, status: "used",
      message: `本地兜底命中「${winner.track.title ?? winner.track.id}」（匹配分 ${winner.match.score}，来源：${winner.track.libraryKind}${winner.info.attributionRequired ? "，需署名" : ""}）`,
    });
    return {
      layer: "local",
      track: {
        ...winner.track,
        licenseLabel: winner.info.label,
        match: winner.match,
        licenseReviewed: true,
      },
      attempts,
      degraded: true,
    };
  }
  attempts.push({ layer: "local", source: "-", status: "no_match", message: `本地曲库无可用匹配（候选 ${local.total} 首：${local.sources.map((entry) => `${entry.label}=${entry.tracks}`).join(" / ")}）` });

  // ③ 自算作曲兜底（永远可用、零权利风险）
  attempts.push({ layer: "compose", source: "builtin-synth", status: "will_compose", message: "在线与本地曲库都不可用 → 回退自算作曲（按配方 + 片长生成）" });
  return { layer: null, track: null, attempts, degraded: true, fallbackToCompose: true };
}

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

/* ============================ 音乐结构识别与选段 ============================ */

/** 本仓提供的选段模式。 */
export const SECTION_MODES = ["full", "auto", "climax", "calm"];

/**
 * 曲目结构分析：能量包络 → 分段（intro/verse/build/drop/breakdown/outro/flat）→ BPM → 段落候选。
 *
 * 诚实边界：这是**规则式（分位数 + 走向 + 起音密度）分段**，不是深度学习结构识别，也不是乐谱级
 * 的"主歌/副歌"标注；它能稳定回答"哪一段最响、最密、最适合当高潮"这类选段问题。
 */
export async function analyzeStructure({ input, windowSec = 0.25, minSegmentSec = 3, maxSeconds = 600, bins = resolveBinaries() }) {
  const probe = await probeMedia(input, { bins });
  const { pcm, sampleRate } = await decodePcm({ input, maxSeconds, bins });
  const envelope = energyEnvelope({ pcm, sampleRate, windowSec });
  const onsets = onsetStrength(envelope.db);
  const tempo = estimateBpmFromOnsets(onsets, { windowSec });
  const structure = classifySegments({ envelope, onsets, minSegmentSec });
  // 边界吸附只在拍速可信（medium/high）时启用：低置信度的 BPM 会把边界带到没有意义的位置
  const snapBpm = tempo.confidence === "low" ? null : tempo.bpm;
  const climax = scoreSegments({ segments: structure.segments, bpm: snapBpm, prefer: "climax", durationSec: envelope.durationSec });
  const calm = scoreSegments({ segments: structure.segments, bpm: snapBpm, prefer: "calm", durationSec: envelope.durationSec });
  return {
    input,
    durationSec: envelope.durationSec,
    analyzedSec: envelope.durationSec,
    truncated: probe.duration > envelope.durationSec + windowSec,
    probeDurationSec: probe.duration,
    sampleRate,
    windowSec,
    tempo,
    envelope: {
      windows: envelope.windows,
      avgDb: envelope.avgDb,
      peakDb: envelope.peakDb,
      quantiles: envelope.quantiles,
      db: envelope.db,
    },
    structure: {
      method: structure.method,
      dynamicsDb: structure.dynamicsDb,
      thresholds: structure.thresholds,
      note: structure.note,
      segments: structure.segments,
    },
    climax,
    calm,
    method: {
      envelope: "解码为 8kHz 单声道 PCM 后在 JS 内按窗口算 RMS（一遍 ffmpeg + 纯 JS）",
      segmentation: "规则式：能量分位数（p25/p75）三档 + 段内走向 + 起音密度",
      tempo: "起音包络自相关（拿不到稳定周期就如实返回 null）",
    },
  };
}

/**
 * 选出要用的音乐片段。
 *
 * `auto` 的决策顺序：
 * 1. 片子里有明确能量峰值区（例如结尾的情绪高点）→ 取曲子的高潮段，并把**高潮段的峰值对齐到片子的峰值时刻**；
 * 2. 片子能量平坦（没有高点）→ 取曲子里能量最集中的一段（代表性片段），从片子开头铺；
 * 3. 曲子本身平坦（flat）→ 从曲头取足够长的一段（等价于"没有高潮可挑"），并把理由写进回执。
 * 4. 段落选出来"太长"（超过曲子一半或超过片长）→ 退化为**在段落内滑窗**：以能量最高窗为中心取一段，
 *    避免"选了个 30s 的段去配 15s 的片子"这种等于没选的结论。
 */
export function chooseSection({ structure, filmArc = null, mode = "auto", filmDurationSec = null, minSectionSec = 6 }) {
  if (!SECTION_MODES.includes(mode) && mode !== "full") {
    throw new BgmError(`未知选段模式：${mode}（可用：${SECTION_MODES.join(", ")}）`, "bad_request");
  }
  const trackDuration = structure?.durationSec ?? 0;
  if (!(trackDuration > 0)) throw new BgmError("结构分析结果缺少时长", "bad_request");

  const pick = (candidates, typeWanted) => {
    const target = typeWanted ? candidates.find((item) => item.type === typeWanted) : null;
    return target ?? candidates[0] ?? null;
  };

  /** 段落内的滑窗取段：以覆盖窗口内能量均值最高的位置为中心，长度取 min(片长, 曲子 40%)。 */
  const slideWindowWithin = (segment, reason) => {
    const wanted = Math.max(
      Math.min(minSectionSec, trackDuration),
      Math.min(filmDurationSec ?? 30, trackDuration * 0.4),
    );
    const windows = structure.envelope.db ?? [];
    const windowSec = structure.windowSec;
    const fromIndex = Math.max(0, Math.round(segment.startSec / windowSec));
    const toIndex = Math.min(windows.length, Math.round(segment.endSec / windowSec));
    const spanWindows = Math.max(1, Math.round(wanted / windowSec));
    let bestStart = fromIndex;
    let bestValue = -Infinity;
    for (let start = fromIndex; start + spanWindows <= Math.max(toIndex, fromIndex + spanWindows); start += 1) {
      const slice = windows.slice(start, Math.min(start + spanWindows, windows.length));
      if (slice.length < spanWindows) break;
      const value = slice.reduce((a, b) => a + b, 0) / slice.length;
      if (value > bestValue) { bestValue = value; bestStart = start; }
    }
    const startSec = round(bestStart * windowSec, 3);
    const endSec = round(Math.min(trackDuration, startSec + wanted), 3);
    return {
      id: `${segment.id}-win`,
      type: segment.type,
      startSec,
      endSec,
      durationSec: round(endSec - startSec, 3),
      avgDb: round(bestValue, 2),
      peakDb: segment.peakDb,
      onsetDensity: segment.onsetDensity,
      score: segment.score,
      windowed: true,
      reason,
    };
  };

  if (mode === "full") {
    return { mode, chosen: null, reason: "整曲模式：循环铺满，不做选段", alignFilmPeak: false, source: { trackDurationSec: trackDuration } };
  }
  if (mode === "climax") {
    const chosen = pick(structure.climax.candidates, "drop");
    return {
      mode,
      chosen,
      reason: `指定高潮段：选 ${chosen.type}（平均 ${chosen.avgDb}dB / 峰值 ${chosen.peakDb}dB / 起点 ${chosen.startSec}s）`,
      alignFilmPeak: true,
      source: { trackDurationSec: trackDuration },
    };
  }
  if (mode === "calm") {
    const chosen = pick(structure.calm.candidates, "intro") ?? pick(structure.calm.candidates, "verse");
    return {
      mode,
      chosen,
      reason: `指定铺垫段：选 ${chosen.type}（平均 ${chosen.avgDb}dB）`,
      alignFilmPeak: false,
      source: { trackDurationSec: trackDuration },
    };
  }

  // auto
  const flatTrack = structure.structure.segments.length === 1 && structure.structure.segments[0].type === "flat";
  const filmPeakSec = Number.isFinite(filmArc?.peakTimeSec) ? filmArc.peakTimeSec : null;
  const filmDynamics = Number.isFinite(filmArc?.dynamicsDb) ? filmArc.dynamicsDb : null;
  const filmHasPeak = filmPeakSec !== null && filmArc?.climaxBasis && filmArc.climaxBasis !== "none";

  if (flatTrack) {
    const chosen = {
      id: "head",
      type: "flat",
      startSec: 0,
      endSec: Math.min(trackDuration, Math.max(minSectionSec, filmDurationSec ?? 30)),
      durationSec: Math.min(trackDuration, Math.max(minSectionSec, filmDurationSec ?? 30)),
      avgDb: structure.envelope.avgDb,
      peakDb: structure.envelope.peakDb,
      onsetDensity: null,
      score: null,
    };
    return {
      mode,
      chosen,
      reason: "曲子能量平坦（无高潮可言）：从曲头取足够长的一段，按整段铺",
      alignFilmPeak: false,
      source: { trackDurationSec: trackDuration, filmPeakSec, filmDynamicsDb: filmDynamics },
    };
  }

  if (filmHasPeak) {
    const picked = pick(structure.climax.candidates, "drop");
    const tooLong = picked.durationSec > Math.max(trackDuration * 0.5, (filmDurationSec ?? 30) * 1.2);
    const chosen = tooLong
      ? slideWindowWithin(picked, `高潮段本身长 ${picked.durationSec}s，超过片子所需：在段内以能量最高处为中心取 ${Math.round(Math.min(filmDurationSec ?? 30, trackDuration * 0.4))}s`)
      : picked;
    return {
      mode,
      chosen,
      reason: chosen.windowed
        ? `片子有明确高点（${filmPeakSec}s）→ ${chosen.reason}，并把窗口峰值对齐到 ${filmPeakSec}s`
        : `片子有明确高点（${filmPeakSec}s，动态 ${filmDynamics}dB）→ 取曲子高潮段（${chosen.type}，平均 ${chosen.avgDb}dB）并把峰值对齐到 ${filmPeakSec}s`,
      alignFilmPeak: true,
      source: { trackDurationSec: trackDuration, filmPeakSec, filmDynamicsDb: filmDynamics },
    };
  }

  const picked = pick(structure.climax.candidates, "drop");
  const tooLong = picked.durationSec > Math.max(trackDuration * 0.5, (filmDurationSec ?? 30) * 1.2);
  const chosen = tooLong
    ? slideWindowWithin(picked, `段落长 ${picked.durationSec}s，超过片子所需：在段内以能量最高处为中心取一段`)
    : picked;
  return {
    mode,
    chosen,
    reason: `片子未识别到可用的高潮点（对白占比 ${Number.isFinite(filmArc?.climaxDetails?.audio?.speechRatio) ? Math.round(filmArc.climaxDetails.audio.speechRatio * 100) + "%" : "n/a"}／无非对白能量峰／无剪辑成簇）→ 取曲子最有代表性的一段（${chosen.type}，平均 ${chosen.avgDb}dB），从片子开头铺，不做峰值对齐`,
    alignFilmPeak: false,
    source: { trackDurationSec: trackDuration, filmPeakSec, filmDynamicsDb: filmDynamics },
  };
}

/** 影片侧的能量弧线（选段对齐的依据）：与音乐同一套包络算法，口径一致。 */
export async function filmEnergyArc({ input, windowSec = 0.25, maxSeconds = 600, bins = resolveBinaries() }) {
  const { pcm, sampleRate } = await decodePcm({ input, maxSeconds, bins });
  const envelope = energyEnvelope({ pcm, sampleRate, windowSec });
  const db = envelope.db;
  const smoothWindow = Math.max(1, Math.round(1.25 / windowSec));
  let peakIndex = 0;
  let peakValue = -Infinity;
  for (let index = 0; index < db.length; index += 1) {
    const from = Math.max(0, index - Math.floor(smoothWindow / 2));
    const to = Math.min(db.length, from + smoothWindow);
    const slice = db.slice(from, to);
    if (!slice.length) continue;
    const value = slice.reduce((a, b) => a + b, 0) / slice.length;
    if (value > peakValue) { peakValue = value; peakIndex = index; }
  }
  const p95 = envelope.quantiles.p90 ?? envelope.peakDb ?? 0;
  const p05 = envelope.quantiles.p10 ?? envelope.avgDb ?? 0;
  return {
    input,
    windowSec,
    durationSec: envelope.durationSec,
    avgDb: envelope.avgDb,
    peakDb: envelope.peakDb,
    dynamicsDb: Math.round(((p95 ?? 0) - (p05 ?? 0)) * 100) / 100,
    peakTimeSec: Math.round(peakIndex * windowSec * 1000) / 1000,
    peakWindowDb: Math.round(peakValue * 100) / 100,
    db,
  };
}

/**
 * 片子的"高潮时刻"该取哪里——口播片不能拿台词最响处当高潮（那会把音乐高潮对到人声上）。
 *
 * 三级依据，**每级都要"确有峰"才采用**，找不到就如实返回 `basis: "none"`（宁可不做峰值对齐，
 * 也不把音乐高潮对到片头第一秒这种人眼一看就不对的位置）：
 * 1. `cut-density`：±2s 窗口内剪辑点成簇（≥2 个）处——画面节奏的高点；
 * 2. `non-dialogue-energy`：非对白窗口里的能量峰，且要比非对白窗口中位数高 ≥3dB——空镜/动作段的高点；
 * 3. `audio-energy`：整体音频能量峰，且该片对白占比 <35%（对白稀少的片子才把它当高潮）。
 */
export function filmClimaxTime({ arc, cuts = [], voice = null, durationSec = null }) {
  const windowSec = arc?.windowSec ?? 0.25;
  const duration = durationSec ?? arc?.durationSec ?? 0;
  const radiusWindows = Math.max(1, Math.round(2 / windowSec));
  const details = {};

  if (Array.isArray(cuts) && cuts.length >= 2) {
    let bestTime = null;
    let bestCount = 0;
    for (const cut of cuts) {
      const count = cuts.filter((other) => Math.abs(other.at - cut.at) <= 2).length;
      if (count > bestCount || (count === bestCount && bestTime !== null && cut.at > bestTime)) {
        bestCount = count;
        bestTime = cut.at;
      }
    }
    details.cutDensity = { timeSec: bestTime, cutsInWindow: bestCount, radiusSec: 2 };
    if (bestTime !== null && bestCount >= 2) {
      return { timeSec: Math.round(bestTime * 1000) / 1000, basis: "cut-density", details };
    }
  }

  const silences = Array.isArray(voice?.silences) ? voice.silences : [];
  // 「安静窗口」= 整窗都落在静音段内部、且离人声边界至少 0.75s（否则会把台词起音算成"安静段的能量峰"，
  // 实测就是这个坑：0.25s 那格跨在对白起音上，被当成高潮点）。
  const marginSec = 0.75;
  const isQuietWindow = (time) => silences.some((segment) => (
    time >= segment.start + marginSec && time + windowSec <= segment.end - marginSec
  ));
  const db = arc?.db ?? [];
  const quietWindows = [];
  for (let index = 0; index < db.length; index += 1) {
    const time = index * windowSec;
    if (time > duration - 1) break;
    if (!isQuietWindow(time)) continue;
    const from = Math.max(0, index - radiusWindows);
    const to = Math.min(db.length, index + radiusWindows + 1);
    const slice = db.slice(from, to).filter((_, offset) => isQuietWindow((from + offset) * windowSec));
    if (!slice.length) continue;
    const value = slice.reduce((a, b) => a + b, 0) / slice.length;
    quietWindows.push({ time, value });
  }
  if (quietWindows.length) {
    const sorted = [...quietWindows].map((entry) => entry.value).sort((a, b) => a - b);
    const median = sorted[Math.floor(sorted.length / 2)] ?? -60;
    const best = quietWindows.reduce((a, b) => (b.value > a.value ? b : a));
    details.nonDialogue = {
      timeSec: Math.round(best.time * 1000) / 1000,
      avgDb: Math.round(best.value * 100) / 100,
      medianDb: Math.round(median * 100) / 100,
      aboveMedianDb: Math.round((best.value - median) * 100) / 100,
      quietSeconds: Math.round(silences.reduce((sum, segment) => sum + segment.duration, 0) * 100) / 100,
    };
    if (best.value - median >= 3) {
      return { timeSec: Math.round(best.time * 1000) / 1000, basis: "non-dialogue-energy", details };
    }
  }

  const speechRatio = Number.isFinite(voice?.activeRatio) ? voice.activeRatio : null;
  details.audio = { peakTimeSec: arc?.peakTimeSec ?? null, speechRatio, dynamicsDb: arc?.dynamicsDb ?? null };
  if ((arc?.dynamicsDb ?? 0) >= 6 && speechRatio !== null && speechRatio < 0.35) {
    return { timeSec: arc.peakTimeSec, basis: "audio-energy", details };
  }
  return {
    timeSec: null,
    basis: "none",
    reason: "片子未识别到明确高潮点（无剪辑成簇、非对白段无能量峰、对白占比高）→ 不做峰值对齐",
    details,
  };
}

/** 把选中的片段裁成独立文件（后续按现有链路循环铺满；边界加 120ms 微淡避免爆音）。 */
export async function renderSection({ input, output, startSec, endSec, bins = resolveBinaries(), fadeSec = 0.12 }) {
  const length = Math.max(0.5, endSec - startSec);
  const fade = Math.min(fadeSec, length / 4);
  await fsp.mkdir(path.dirname(output), { recursive: true });
  await runBin(bins.ffmpeg, [
    "-hide_banner", "-v", "error", "-y",
    "-ss", String(startSec), "-t", String(length), "-i", input,
    "-af", `afade=t=in:st=0:d=${round(fade, 3)},afade=t=out:st=${round(Math.max(0, length - fade), 3)}:d=${round(fade, 3)}`,
    "-c:a", "pcm_s16le", "-ar", "48000", "-ac", "2", output,
  ], { label: "ffmpeg(section)", timeoutMs: 600_000 });
  return { path: output, startSec: round(startSec, 3), endSec: round(endSec, 3), durationSec: round(length, 3), sha256: await sha256File(output) };
}

/** 选段证据图：上=曲目波形（红框=选中片段），下=影片波形（红框=能量高点）。 */
export async function renderSectionEvidence({ music, film, section, filmPeakSec = null, output, bins = resolveBinaries(), width = 1000, height = 200 }) {
  await fsp.mkdir(path.dirname(output), { recursive: true });
  const musicDuration = Math.max(0.001, music.durationSec);
  const x = Math.max(0, Math.round((section.startSec / musicDuration) * width));
  const w = Math.max(2, Math.round(((section.endSec - section.startSec) / musicDuration) * width));
  const parts = [
    `[0:a]showwavespic=s=${width}x${height}:colors=0x2f7d5b[top]`,
    `[top]drawbox=x=${x}:y=0:w=${w}:h=${height}:color=red@0.85:t=6[t1]`,
  ];
  const map = ["[t1]"];
  if (film) {
    const filmDuration = Math.max(0.001, film.durationSec);
    parts.push(`[1:a]showwavespic=s=${width}x${height}:colors=0x8899aa[bottom]`);
    if (Number.isFinite(filmPeakSec)) {
      const px = Math.max(0, Math.round((filmPeakSec / filmDuration) * width));
      parts.push(`[bottom]drawbox=x=${Math.max(0, px - 8)}:y=0:w=16:h=${height}:color=red@0.85:t=fill[b1]`);
      map.push("[b1]");
    } else {
      map.push("[bottom]");
    }
    parts.push(`${map.join("")}vstack=inputs=2[out]`);
  } else {
    parts.push("[t1]null[out]");
  }
  const args = ["-hide_banner", "-v", "error", "-y", "-i", music.input ?? music.path];
  if (film) args.push("-i", film.input);
  args.push("-filter_complex", parts.join(";"), "-map", "[out]", "-frames:v", "1", output);
  await runBin(bins.ffmpeg, args, { label: "ffmpeg(section-evidence)", timeoutMs: 300_000 });
  return { path: output, sha256: await sha256File(output) };
}

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
  /**
   * 【2026-09-26 真机修复】候选**按票数聚类**，不再只挑"离基准最近的一个"。
   *
   * 事故（VID-GR01）：基准 BPM 取到默认 100（调用方没传 `--bgm-bpm`），
   * 相邻剪辑点间距被逐个取整到整拍 → 5.00s 反推 96、4.82s 反推 99.6、4.50s 反推 106.7，
   * "离 100 最近"的 99.6 被选中；可 99.6BPM 的网格（0.6024s/拍）**根本对不上自己的剪辑点**，
   * 于是工位自判 `unaligned`（7/17 命中、平均 122ms），监制据此连续打回配乐环节。
   *
   * 现在改为：把 ±2BPM 内的候选并成一个簇，**取支持剪辑点最多的簇**（票数相同再比离基准的距离）。
   * 这样个别被转场/抖动偏移的间隔不会再把整体 BPM 带偏；基准 BPM 只作平票裁决与容差门槛。
   */
  const clusters = [];
  for (const candidate of candidates) {
    const cluster = clusters.find((entry) => Math.abs(entry.bpm - candidate.bpm) <= 2);
    if (cluster) {
      cluster.votes += 1;
      cluster.bpm = (cluster.bpm * (cluster.votes - 1) + candidate.bpm) / cluster.votes;
      if (Math.abs(candidate.bpm - base) < Math.abs(cluster.representative - base)) {
        cluster.representative = candidate.bpm;
        cluster.interval = candidate.interval;
        cluster.beats = candidate.beats;
      }
    } else {
      clusters.push({ bpm: candidate.bpm, representative: candidate.bpm, votes: 1, interval: candidate.interval, beats: candidate.beats });
    }
  }
  clusters.sort((a, b) => (b.votes - a.votes) || (Math.abs(a.representative - base) - Math.abs(b.representative - base)));
  const winner = clusters[0];
  const best = { bpm: winner.bpm, interval: winner.interval, beats: winner.beats, votes: winner.votes, total: candidates.length };
  const adopted = Math.abs(best.bpm - base) / base <= toleranceRatio;
  const derived = Math.round(best.bpm * 10) / 10;
  return {
    bpm: adopted ? derived : base,
    source: adopted ? "cut-driven" : "recipe",
    candidateBpm: derived,
    intervalSec: round(best.interval, 3),
    beats: best.beats,
    votes: best.votes,
    voteTotal: best.total,
    note: adopted
      ? `按剪辑点间距 ${round(best.interval, 2)}s ≈ ${best.beats} 拍反推 BPM ${derived}`
        + `（${best.votes}/${best.total} 个间隔同簇，配方基准 ${base}）`
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
/**
 * 峰值对齐的**预卷相位**（2026-09-24 真机修复）。
 *
 * 缺陷背景：`--section auto` 的"高潮对齐"早先是把**整条音乐床延后** `desiredStartSec` 秒
 * （`adelay=25.733s`），于是 30s 片子里前 25.7s 完全没有音乐——真机产品所有者反馈
 * "我听不到你新合成的 BGM"，实测 `ducked-music.wav` 前 25s 为数字静音（-120dBFS）。
 *
 * 正确做法是**相位预卷**：把选段按相位旋转后再循环铺满，
 * 使段内峰值仍落在片子高点，同时从 0s 起就有音乐。
 *
 * @param {{sectionDurationSec:number, anchorOffsetSec:number, filmPeakSec:number}} p
 * @returns {number} 旋转相位（秒，0 ≤ phase < sectionDurationSec）
 */
export function prerollPhaseSec({ sectionDurationSec, anchorOffsetSec, filmPeakSec }) {
  const L = Number(sectionDurationSec);
  const anchor = Number(anchorOffsetSec) || 0;
  const peak = Number(filmPeakSec) || 0;
  if (!Number.isFinite(L) || L <= 0) return 0;
  return round((((anchor - peak) % L) + L) % L, 4);
}

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

/** A shared linear gain preserves actual stem ratios; no hidden dynamic normalization. */
async function normalizeLoudness({ input, output, targetLufs, truePeak, bins }) {
  const measured = await measureLoudness(input, { bins, targetLufs, truePeak });
  if (!Number.isFinite(measured.integratedLufs) || !Number.isFinite(measured.truePeakDbtp)) {
    throw new BgmError("节目混合响度或真峰值不可测", "verify_failed", false);
  }
  const wantedGainDb = targetLufs - measured.integratedLufs;
  const gainDb = Math.min(wantedGainDb, truePeak - 0.5 - measured.truePeakDbtp);
  await applyMasterGain({ input, output, gainDb, bins });
  return { path: output, measuredBefore: measured, gainDb, wantedGainDb,
    method: "shared-linear-gain", limiterApplied: false, truePeakHeadroomDb: 0.5,
    sha256: await sha256File(output) };
}
async function applyMasterGain({ input, output, gainDb, bins }) {
  await runBin(bins.ffmpeg, ["-hide_banner", "-v", "error", "-n", "-i", input,
    "-af", `volume=${gainDb}dB`, "-c:a", "pcm_f32le", "-ar", "48000", "-ac", "2", output],
  { label: "ffmpeg(shared-master-gain)", timeoutMs: 900_000 });
}

/** Validate current host-signed sources; request parameters cannot replace the verifier. */
export async function verifyIndependentAudio(audioStems, { env = process.env, bins = resolveBinaries() } = {}) {
  if (!audioStems || typeof audioStems !== "object" || Array.isArray(audioStems)) {
    throw new BgmError("重混必须提供独立来源 audio_stems；混合原声和分离猜测不具备来源资格", "audio_stems_source_unverified", false);
  }
  if (env.WORKLOOM_BGM_BRIDGE_TENANT && audioStems.scope?.tenantId !== env.WORKLOOM_BGM_BRIDGE_TENANT) {
    throw new BgmError("独立音轨租户与服务绑定不符", "tenant_mismatch", false);
  }
  return verifyAudioStemBundle({ dir: audioStems.dir,
    expectedManifestSha256: audioStems.manifestSha256, expectedRecipeSha256: audioStems.recipeSha256,
    scope: audioStems.scope, verifySource: createAudioStemReceiptVerifier({ env }),
    allowedRoots: allowedRoots(env), bins });
}

/** Frozen source bundle first; snapshot every consumed byte into an exclusive evidence directory. */
export async function mix(options = {}) {
  const { audioStems, env = process.env, bins = resolveBinaries() } = options;
  for (const [key, min, max] of [["musicLevelDb", -80, 0], ["duckingDb", 0, 40], ["targetLufs", -36, -5],
    ["truePeak", -12, 0], ["fadeInSec", 0, 120], ["fadeOutSec", 0, 120], ["bgmBpm", 20, 300], ["bpmOverride", 20, 300]]) {
    if (options[key] != null && (!Number.isFinite(options[key]) || options[key] < min || options[key] > max)) {
      throw new BgmError(`${key} 必须是 ${min} 至 ${max} 的有限数值`, "bad_request", false);
    }
  }
  const stems = await verifyIndependentAudio(audioStems, { env, bins });
  const roots = allowedRoots(env);
  const output = assertPathAllowed(options.output, roots, "output");
  const source = assertPathAllowed(options.input, roots, "input");
  const music = assertPathAllowed(options.bgmPath, roots, "bgmPath");
  if (output === source || output === music) throw new BgmError("禁止覆盖媒体源", "overwrite_source_forbidden", false);
  if (fs.existsSync(output)) throw new BgmError("混音输出已存在，不能覆盖", "idempotency_conflict", false);
  if (!["keep-dialogue", "keep-all", "replace-bed", "music-only"].includes(options.policy ?? "keep-dialogue")) {
    throw new BgmError("未知分层策略", "bad_request", false);
  }
  if (options.policy === "music-only" && (options.allowDiscardOriginal !== true || stems.roles.dialogue.status !== "not_applicable")) {
    throw new BgmError("music-only 需要显式丢弃许可且对白必须有权威不适用回执", "audio_stems_source_unverified", false);
  }
  await fsp.mkdir(path.dirname(output), { recursive: true });
  const work = await fsp.mkdtemp(path.join(path.dirname(output), `.mix-${randomUUID()}-`));
  const copy = async (file, sha256, name) => (await snapshotAudioStemArtifact({ file, sha256,
    output: path.join(work, name), allowedRoots: roots })).path;
  try {
    const input = await copy(source, await sha256File(source), "picture.mp4");
    const bgmPath = await copy(music, await sha256File(music), "new-music");
    const programPath = await copy(stems.program.path, stems.program.sha256, "program.wav");
    const dialoguePath = await copy(stems.roles.dialogue.path, stems.roles.dialogue.sha256, "dialogue.wav");
    const probe = await probeMedia(input, { bins });
    if (Math.abs(probe.duration - stems.program.durationSec) > 0.04) {
      throw new BgmError("独立节目轨与画面时间线相差超过 40ms", "audio_stems_alignment_failed", false);
    }
    const candidate = path.join(work, probe.video ? "candidate.mp4" : "candidate.wav");
    const report = await mixVerified({ ...options, input, bgmPath, output: candidate, bins,
      programPath, dialoguePath, dialogueStatus: stems.roles.dialogue.status, workDir: work, keepWork: true });
    // Expiry can change during a long render. Revalidate before publishing.
    await verifyIndependentAudio(audioStems, { env, bins });
    report.output.path = output;
    report.input = source;
    report.bgm.path = music;
    report.independentAudio = { ...audioStems, sourceAuthority: "passed", embeddedAudioUsed: false,
      programSha256: stems.program.sha256, dialogueSha256: stems.roles.dialogue.sha256,
      dialogueStatus: stems.roles.dialogue.status, retainedMusicExcluded: true };
    report.workDir = work;
    await fsp.writeFile(path.join(work, "mix-report.json"), `${JSON.stringify(report, null, 2)}\n`, { flag: "wx", mode: 0o600 });
    await fsp.link(candidate, output);
    return report;
  } catch (error) {
    await fsp.writeFile(path.join(work, "failed.json"), `${JSON.stringify({ status: "failed", code: error.code ?? "engine_failed", message: error.message })}\n`, { flag: "wx", mode: 0o600 });
    throw error;
  }
}

/**
 * 配乐出片（本连接器的主流程）：
 *
 *   经签章的独立对白 ── 侧链键（200–4000Hz）
 *   独立节目轨 ──────── 声音床（对白 + 环境 + 拟音，不含旧配乐）
 *    BGM（自算或曲库曲目）→ 音量/淡入淡出/卡点偏移 → sidechaincompress 让位 → 与声音床合流
 *      → 同一可追溯线性主增益（受真峰值余量约束）→ 与视频轨合流（视频轨 copy）
 *      → 复检：响度 / 让位深度 / 人声余量 / 配乐可闻度 / 卡点误差（无回执不算完成）
 *
 * @returns {Promise<object>} 产物 + 指标 + 证据（不含任何客户原始数据的上行）
 */
/**
 * 配乐可闻度结论文案（纯函数，便于单测；2026-09-24 真机复核后拆出）：
 *
 * 「测不到」与「测得偏低」是两种不同结论——
 *   · 测得偏低：报**实测差值** vs 目标（可据此调电平）；
 *   · 测不到：全程连续现场声/连续口播时，既无绝对静音、也找不到相对安静窗口，
 *     `musicPresenceDb` 只能是 `null`。这时按「未核实」拒绝出片（fail-closed 不变），
 *     但绝不能写成 `nulldB < 阈值`——那是没发生过的比较，会把人误导成电平问题反复调电平。
 */
export function explainMusicAudibility({
  musicPresenceDb = null, targetDb = 3, quietWindowSource = "unknown", measured = false,
} = {}) {
  if (measured) return `配乐可闻度 ${musicPresenceDb}dB < ${targetDb}dB`;
  const why = quietWindowSource === "none"
    ? "全片既无绝对静音窗口、也找不到相对安静窗口（连续现场声/连续口播）"
    : `安静窗口不可用（quietWindowSource=${quietWindowSource}）`;
  return `配乐可闻度无法测量（${why}）→ 按「未核实」拒绝出片；`
    + "可改用带人声间隙的素材、或指定 section 片段复用后在有人声间隙处复检再重试本变体";
}

const MIX_CHECK_NAMES = ["loudness_ok", "true_peak_ok", "music_audible", "dialogue_preserved", "ducking_applied"];

/** 真正的让位深度只能由同一人声窗口内的无侧链对照与有侧链结果求得。 */
export function measuredDuckingDepthDb(controlInVoice, duckedInVoice) {
  return Number.isFinite(controlInVoice) && Number.isFinite(duckedInVoice)
    ? round(duckedInVoice - controlInVoice, 2)
    : null;
}

/** 交付复检：需要实测的值缺失时按未核实处理，不把 null 当作达标。 */
export function evaluateMixChecks({
  loudnessAfter, targetLufs, truePeak, musicPresenceDb, musicPresenceTargetDb,
  speechToMusicMarginDb, duckingDepthDb, policy, dialogueStatus = "ready",
}) {
  return {
    loudness_ok: Number.isFinite(loudnessAfter.integratedLufs)
      && Math.abs(loudnessAfter.integratedLufs - targetLufs) <= 1.5,
    true_peak_ok: Number.isFinite(loudnessAfter.truePeakDbtp)
      && loudnessAfter.truePeakDbtp <= truePeak + 0.2,
    music_audible: Number.isFinite(musicPresenceDb) && musicPresenceDb >= musicPresenceTargetDb,
    dialogue_preserved: dialogueStatus === "not_applicable"
      || (Number.isFinite(speechToMusicMarginDb) && speechToMusicMarginDb >= 3),
    ducking_applied: dialogueStatus === "not_applicable"
      || (Number.isFinite(duckingDepthDb) && duckingDepthDb <= -4),
  };
}

/** 任一复检失败都不得返回成功回执；删除产物后由调用方重混或转人工。 */
export async function enforceMixChecks({ checks, output, details = [], retryable = false }) {
  const failed = MIX_CHECK_NAMES.filter((name) => checks?.[name] !== true);
  if (failed.length === 0) return;
  const detail = details.length ? `；${details.join("；")}` : "";
  try {
    await fsp.rm(output, { force: true });
  } catch (error) {
    const failure = new BgmError(
      `配乐复检未通过（${failed.join("、")}${detail}）：删除产物失败：${error instanceof Error ? error.message : String(error)}；不得作为成片交付`,
      "verify_failed", false,
    );
    failure.failedChecks = failed;
    throw failure;
  }
  const failure = new BgmError(`配乐复检未通过（${failed.join("、")}${detail}）：已删除产物，不得作为成片交付`, "verify_failed", retryable);
  failure.failedChecks = failed;
  throw failure;
}

async function mixVerified({
  input, output, bgmPath = null, policy = "keep-dialogue", bgmBpm = null,
  musicLevelDb = null, duckingDb = null, targetLufs = -14, truePeak = -1.0,
  fadeInSec = 1.2, fadeOutSec = 1.6, align = true, allowDiscardOriginal = false,
  evidenceDir = null, bins = resolveBinaries(), workDir = null, keepWork = false,
  licenseReviewed = true, commercialUse = true,
  section = "full", sectionStartSec = null, sectionEndSec = null, filmClimaxOverrideSec = null,
  /** 显式剪辑网格（秒）：由成片方给出真实剪辑点，优先于从音轨起音"猜"剪辑点（2026-09-25 真机） */
  cutTimes = null, bpmOverride = null, bpmStrategy = "recipe",
  programPath, dialoguePath, dialogueStatus,
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
  let bgmMeanDb = Number.isFinite(bgmSelfLevel.meanDb) ? bgmSelfLevel.meanDb : -18;
  if (path.resolve(output) === path.resolve(input)) {
    throw new BgmError("禁止覆盖原片（原片只读）", "overwrite_source_forbidden");
  }
  await fsp.mkdir(path.dirname(output), { recursive: true });

  const work = workDir ?? (await tempDir("bgm-mix-"));
  await fsp.mkdir(work, { recursive: true });
  const voice = dialogueStatus === "not_applicable"
    ? { noiseDb: -38, activeRatio: 0, segments: [], silences: [{ start: 0, end: duration, duration }], method: "authorized-no-dialogue" }
    : await detectVoiceBandSegments({ input: dialoguePath, duration, bins });
  /**
   * 剪辑点来源（2026-09-25 真机）：`cutTimes` 有值就用它（成片方最清楚自己的剪辑网格——
   * 例如每镜 5s 硬切），否则退回 `detectCuts()` 从音轨起音反推。
   * 起因：快剪片里"音频起音"会把台词音节当成剪辑点（36 个 0.5s 级起音），
   * 于是 BPM 反推全部落空、退回 100BPM 默认值，卡点指标对任何片子都报同一组数字、永远判未对齐。
   */
  const explicitCuts = Array.isArray(cutTimes) && cutTimes.length > 0
    ? cutTimes.map((at) => ({ at: Number(at), score: 1 })).filter((cut) => Number.isFinite(cut.at))
    : null;
  const cuts = explicitCuts ?? (align ? (await detectCuts({ input, bins })).cuts : []);
  /** BPM：显式 > 剪辑驱动（按真实剪辑网格反推）> 传入值/默认 100 */
  const baseBpm = Number(bgmBpm ?? 100);
  const tempoChoice = (() => {
    if (bpmOverride != null) return { bpm: Number(bpmOverride), source: "explicit" };
    if (bpmStrategy === "cut-driven" && cuts.length > 1) {
      const derived = deriveTempoFromCuts({ cuts, baseBpm });
      return { bpm: derived.bpm, source: derived.source, note: derived.note ?? null };
    }
    return { bpm: baseBpm, source: "recipe" };
  })();
  const grid = align
    ? alignBeatGrid({ bpm: tempoChoice.bpm, cuts })
    : { bpm: tempoChoice.bpm, offsetSec: 0, cuts: [], meanAbsErrorMs: null, verdict: "disabled", method: "disabled" };

  /**
   * 选段：`section=auto|climax|calm|full` 或显式 `section_start_sec/section_end_sec`。
   * 选段后整条链路不变——只是把"整曲无限循环"换成"选中片段无限循环"，并按片子能量高点做落点对齐。
   */
  let sectionPlan = null;
  let structure = null;
  let filmArc = null;
  let playPath = bgmPath;
  let sectionTrimHeadSec = 0;
  let sectionPlaceOffsetSec = null;
  let sectionArtifact = null;
  const explicitSection = Number.isFinite(sectionStartSec) && Number.isFinite(sectionEndSec);
  if (explicitSection || section !== "full") {
    structure = await analyzeStructure({ input: bgmPath, bins });
    filmArc = await filmEnergyArc({ input: programPath, bins });
    // 片子的"高潮"按三级依据定：剪辑密度 → 非对白能量 → 音频能量（口播片不会被台词峰值带跑）
    const climax = filmClimaxTime({
      arc: filmArc,
      cuts: align ? cuts : (await detectCuts({ input, bins })).cuts,
      voice,
      durationSec: duration,
    });
    // 提示词给的高潮线索：当音频/剪辑都判不出高潮点时（basis=none）才采信，来源写进回执（basis=prompt-brief）
    if (climax.timeSec === null && Number.isFinite(filmClimaxOverrideSec)) {
      climax.timeSec = Math.max(0, Math.min(duration - 0.5, Number(filmClimaxOverrideSec)));
      climax.basis = "prompt-brief";
      climax.reason = `片子音频/剪辑未识别到高潮点，采用提示词线索：高潮约在 ${Math.round(climax.timeSec)}s`;
    }
    filmArc.climaxTimeSec = climax.timeSec;
    filmArc.climaxBasis = climax.basis;
    filmArc.climaxDetails = climax.details;
    filmArc.audioPeakTimeSec = filmArc.peakTimeSec;
    filmArc.peakTimeSec = climax.timeSec;
    if (explicitSection) {
      if (!(sectionEndSec > sectionStartSec)) throw new BgmError("section_end_sec 必须大于 section_start_sec", "bad_request");
      if (sectionStartSec < 0 || sectionEndSec > structure.durationSec + 0.5) {
        throw new BgmError(`显式片段越界：${sectionStartSec}-${sectionEndSec}s，曲目时长 ${structure.durationSec}s`, "bad_request");
      }
      sectionPlan = {
        mode: "explicit",
        chosen: {
          id: "explicit",
          type: "explicit",
          startSec: round(sectionStartSec, 3),
          endSec: round(sectionEndSec, 3),
          durationSec: round(sectionEndSec - sectionStartSec, 3),
          avgDb: null,
          peakDb: null,
          onsetDensity: null,
          score: null,
        },
        reason: "调用方显式指定片段",
        alignFilmPeak: false,
        source: { trackDurationSec: structure.durationSec },
      };
    } else {
      sectionPlan = chooseSection({
        structure,
        filmArc,
        mode: section,
        filmDurationSec: duration,
        minSectionSec: Math.min(8, Math.max(4, duration / 3)),
      });
    }
    const chosen = sectionPlan.chosen;
    if (chosen && chosen.durationSec > 0.5) {
      // 片段内的"锚点" = 能量最高窗（对齐片子高点用）
      const from = Math.max(0, Math.round(chosen.startSec / structure.windowSec));
      const to = Math.min(structure.envelope.db.length, Math.round(chosen.endSec / structure.windowSec));
      let anchorIndex = from;
      let anchorValue = -Infinity;
      for (let index = from; index < to; index += 1) {
        if (structure.envelope.db[index] > anchorValue) { anchorValue = structure.envelope.db[index]; anchorIndex = index; }
      }
      const anchorOffsetSec = round(anchorIndex * structure.windowSec - chosen.startSec, 3);
      if (sectionPlan.alignFilmPeak && Number.isFinite(filmArc?.peakTimeSec)) {
        const desiredStartSec = filmArc.peakTimeSec - anchorOffsetSec;
        if (desiredStartSec >= 0) {
          sectionPlaceOffsetSec = round(Math.min(desiredStartSec, Math.max(0, duration - 1)), 3);
        } else {
          sectionTrimHeadSec = round(Math.min(-desiredStartSec, chosen.durationSec - 1), 3);
          sectionPlaceOffsetSec = 0;
        }
        sectionPlan.filmPeakAlign = {
          filmPeakSec: filmArc.peakTimeSec,
          basis: filmArc.climaxBasis ?? null,
          musicAnchorOffsetSec: anchorOffsetSec,
          placedAtSec: round(sectionPlaceOffsetSec + sectionTrimHeadSec, 3),
          note: sectionTrimHeadSec > 0
            ? `片子高点早于片段峰值，向前裁掉 ${sectionTrimHeadSec}s 片头以对齐`
            : `片段整体延后 ${sectionPlaceOffsetSec}s 起播，使峰值落在片子高点`,
        };
      }
      if (!sectionPlan.alignFilmPeak) {
        sectionPlan.filmPeakAlign = filmArc?.climaxBasis === "none" || !filmArc?.climaxBasis
          ? { skipped: true, reason: filmArc?.climaxDetails?.reason ?? "片子未识别到明确高潮点，音乐不做峰值对齐" }
          : { skipped: true, reason: "选段模式不要求峰值对齐（如整段/铺垫模式）" };
      }
      sectionArtifact = await renderSection({
        input: bgmPath,
        output: path.join(work, "section.wav"),
        startSec: chosen.startSec + sectionTrimHeadSec,
        endSec: chosen.endSec,
        bins,
      });
      playPath = sectionArtifact.path;
      // 片段自己的平均电平与整曲可能差很多：用它反推增益，保证"配乐电平"口径仍然成立
      const sectionLevel = await segmentMeanVolumeDb({ input: playPath, duration: Math.min(sectionArtifact.durationSec, 10), bins });
      if (Number.isFinite(sectionLevel.meanDb)) bgmMeanDb = sectionLevel.meanDb;
      sectionPlan.played = {
        startSec: round(chosen.startSec + sectionTrimHeadSec, 3),
        endSec: chosen.endSec,
        durationSec: sectionArtifact.durationSec,
        loops: sectionArtifact.durationSec > 0 ? Math.ceil(duration / sectionArtifact.durationSec) : 0,
        sha256: sectionArtifact.sha256,
      };
      /**
       * 预卷（2026-09-24 真机修复）：需要"整段延后"才能对齐峰值时，改为**旋转选段 + 从 0s 铺满**。
       * 否则前 `sectionPlaceOffsetSec` 秒是静音（真机 25.7s / 30s 无音乐）。
       */
      if (sectionPlaceOffsetSec !== null && sectionPlaceOffsetSec > 0.05 && Number.isFinite(filmArc?.peakTimeSec)) {
        const L = sectionArtifact.durationSec;
        const phase = prerollPhaseSec({ sectionDurationSec: L, anchorOffsetSec, filmPeakSec: filmArc.peakTimeSec });
        const rotatedPath = path.join(work, "section-prerolled.wav");
        await runBin(bins.ffmpeg, [
          "-hide_banner", "-v", "error", "-y",
          "-i", sectionArtifact.path,
          "-filter_complex",
          `[0:a]atrim=start=${phase},asetpts=N/SR/TB[head];[0:a]atrim=end=${phase},asetpts=N/SR/TB[tail];`
          + "[head][tail]concat=n=2:v=0:a=1[out]",
          "-map", "[out]", "-c:a", "pcm_f32le", "-ar", "48000", "-ac", "2", rotatedPath,
        ], { label: "ffmpeg(section-preroll)", timeoutMs: 300_000 });
        playPath = rotatedPath;
        sectionPlaceOffsetSec = 0;
        sectionPlan.preroll = {
          applied: true,
          phaseSec: phase,
          sectionDurationSec: L,
          reason: `选段按相位旋转 ${phase}s 后再循环铺满：峰值仍落在片子高点 ${round(filmArc.peakTimeSec, 3)}s，且从 0s 起全程有音乐`,
          previousBug: "早先把整条音乐床延后，导致前段静音（2026-09-24 真机：30s 片子里 25.7s 无音乐）",
        };
        if (sectionPlan.filmPeakAlign) {
          /**
           * 落点（新语义）：旋转后峰值首次出现在 `(anchor − phase) mod L`，之后每 L 秒重现一次；
           * 取能覆盖到片子高点的那个整圈，得到**实际落点**，供复检与测试断言。
           */
          const firstPeak = ((anchorOffsetSec - phase) % L + L) % L;
          const loopsToPeak = Math.floor((filmArc.peakTimeSec - firstPeak) / L);
          const landed = round(firstPeak + loopsToPeak * L, 3);
          sectionPlan.filmPeakAlign.note = `选段相位预卷 ${phase}s 后循环铺底：峰值对齐到片子高点 ${round(filmArc.peakTimeSec, 3)}s（全程有音乐）`;
          sectionPlan.filmPeakAlign.placedAtSec = round(phase, 3);
          sectionPlan.filmPeakAlign.peakLandedAtSec = landed;
          sectionPlan.filmPeakAlign.mode = "preroll-loop";
        }
      }
    } else {
      sectionPlan = { ...sectionPlan, chosen: null, note: "选段结果不足 0.5s，回退整曲循环" };
    }
  }

  const offset = sectionPlaceOffsetSec !== null
    ? sectionPlaceOffsetSec
    : (align ? grid.offsetSec : 0);

  /**
   * 铺底长度收敛（2026-09-24 真机修复）：
   *
   * 旧实现把音乐输入写成 `-stream_loop -1`（无限），靠 `atrim` + 输出 `-t` 收口。实测（ffmpeg 6.0 / macOS）
   * 这条组合会**永不退出**：`-stream_loop -1` 的 demuxer 一直在喂帧，滤镜图与 muxer 等不到输入结束，
   * 输出文件已经写完（实测 5MB / 0% CPU）进程却挂着 5–14 分钟，`apad` / `-t` 都救不回来；
   * 同一条命令去掉 `-stream_loop -1` 立刻正常退出 —— 根因是 loop 输入，不是 sidechaincompress。
   *
   * 现在改为：**先在有限输入上把选段循环拼到"够长"**（写 `bed-music.wav`），再走原有让位混音链。
   * 有限输入 = 可预期退出；音乐只是被"过采样"到片长 + 淡出余量，听感与循环铺底一致。
   */
  const bedTargetSec = round(duration + Math.max(fadeInSec, fadeOutSec) + 0.5, 3);
  const playProbe = await probeMedia(playPath, { bins });
  if (playProbe.duration && playProbe.duration < bedTargetSec) {
    const loops = Math.max(2, Math.ceil(bedTargetSec / playProbe.duration));
    const listFile = path.join(work, "bed-music.txt");
    await fsp.writeFile(
      listFile,
      Array.from({ length: loops }, () => `file '${playPath.replaceAll("'", "'\\''")}'`).join("\n"),
      "utf8",
    );
    const bedMusic = path.join(work, "bed-music.wav");
    await runBin(bins.ffmpeg, [
      "-hide_banner", "-v", "error", "-y",
      "-f", "concat", "-safe", "0", "-i", listFile,
      "-c:a", "pcm_f32le", "-ar", "48000", "-ac", "2", bedMusic,
    ], { label: "ffmpeg(bed-music)", timeoutMs: 600_000 });
    playPath = bedMusic;
    if (sectionPlan?.played) {
      sectionPlan.played.loops = loops;
      sectionPlan.played.bedPath = bedMusic;
      sectionPlan.played.bedNote = `选段 ${round(playProbe.duration, 2)}s × ${loops} 拼到 ${bedTargetSec}s（有限输入，规避 -stream_loop 不退出）`;
    }
  }

  const roomTone = await (async () => {
    const windows = voice.silences
      .filter((segment) => segment.duration >= 0.4 && segment.start >= 0.2)
      .sort((a, b) => b.duration - a.duration)
      .slice(0, 4);
    const levels = [];
    for (const window of windows) {
      const measured = await segmentMeanVolumeDb({ input: programPath, start: window.start, duration: Math.min(window.duration, 2), bins });
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
        input: dialoguePath, start: window.start, duration: Math.min(window.duration, 2), band: VOICE_BAND, bins,
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

  // Every policy consumes verified independent sources; center separation is never clean evidence.
  const bedPath = path.join(work, "bed.wav");
  let bedSource = policy === "replace-bed" ? dialoguePath : programPath;
  const sidechainSource = dialogueStatus === "not_applicable" || policy === "music-only" ? null : dialoguePath;
  const separation = null;
  if (policy === "music-only") {
    await runBin(bins.ffmpeg, ["-hide_banner", "-v", "error", "-n", "-f", "lavfi", "-i", "anullsrc=r=48000:cl=stereo",
      "-t", String(duration), "-c:a", "pcm_f32le", bedPath], { label: "ffmpeg(silence-bed)", timeoutMs: 120_000 });
    bedSource = bedPath;
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
    /**
     * 音乐输入**必须有限**（2026-09-24 真机修复）：不再用 `-stream_loop -1`（它会永远不退出，
     * 详见上面"铺底长度收敛"的注释）。需要比选段更长时已在前面拼好 `bed-music.wav`。
     */
    "-i", playPath,
  ];
  const musicParts = [`[1:a]${musicChain},atrim=0:${round(duration, 3)},asetpts=N/SR/TB[music]`];
  if (sidechainSource) {
    const keyInput = sidechainSource === input ? "[0:a]" : "[2:a]";
    if (sidechainSource !== input) musicArgs.push("-i", sidechainSource);
    /**
     * 侧链补静音：转场后成片时长常带小数（如 xfade 的 26.333s），音乐与侧链的帧边界不完全对齐时，
     * 补齐静音可以避免 `sidechaincompress` 在末尾等一个不会再来的侧链帧；输出再用 `-t` 收口。
     */
    musicParts.push(`${keyInput}highpass=f=${VOICE_BAND.highpass},lowpass=f=${VOICE_BAND.lowpass},volume=1,apad[sc]`);
    musicParts.push(
      `[music][sc]sidechaincompress=threshold=${duck.threshold}:ratio=${duck.ratio}:attack=20:release=400:`
      + "makeup=1:level_sc=1:link=maximum[out]",
    );
  } else {
    musicParts.push("[music]anull[out]");
  }
  await runBin(bins.ffmpeg, [
    ...musicArgs, "-filter_complex", musicParts.join(";"),
    "-map", "[out]", "-c:a", "pcm_f32le", "-ar", "48000", "-ac", "2",
    /**
     * 输出时长上界（2026-09-24 真机修复）：音乐输入是 `-stream_loop -1`（无限），只靠
     * `atrim` 收口时，若侧链（原片音轨）在末帧略早于音乐结束，`sidechaincompress` 会等一个
     * 永不到来的侧链帧 → ffmpeg 卡死（实测：0% CPU，直到 900s 超时；26.33s 的片子也不例外）。
     * 显式 `-t` 给输出一个确定终点，语义不变（音乐仍按 atrim 对齐片长），只是不再可能挂住。
     */
    "-t", String(round(duration, 3)), duckedPath,
  ], { label: "ffmpeg(ducked-music)", timeoutMs: 900_000 });
  const duckedProbe = await probeMedia(duckedPath, { bins });
  /**
   * 让位深度的**正确测法**（2026-09-25 真机）：用同一条音乐链再渲一版"**不挂侧链**"的对照，
   * 在同一组人声窗里比较 `对照 − 让位后` —— 这才是"侧链压了多少 dB"。
   * 旧口径（让位后的人声窗 − 安静窗）测的其实是**曲子自身的能量起伏**：
   * 实测同一段片子换曲子/改 `--ducking`（8→40dB），旧口径只在 2.3–7.8dB 之间漂移，
   * 监制据此反复打回"让位不足"，而真实侧链深度根本没被量到。
   */
  let controlPath = null;
  if (sidechainSource) {
    controlPath = path.join(work, "control-music.wav");
    await runBin(bins.ffmpeg, [
      "-hide_banner", "-v", "error", "-y",
      "-i", input, "-i", playPath,
      "-filter_complex", `[1:a]${musicChain},atrim=0:${round(duration, 3)},asetpts=N/SR/TB[ctl]`,
      "-map", "[ctl]", "-c:a", "pcm_f32le", "-ar", "48000", "-ac", "2",
      "-t", String(round(duration, 3)), controlPath,
    ], { label: "ffmpeg(control-music)", timeoutMs: 600_000 });
  }

  // ③ 合流（BGM + 声音床）
  const premasterPath = path.join(work, "premaster.wav");
  await runBin(bins.ffmpeg, [
    "-hide_banner", "-v", "error", "-y",
    "-i", bedSource, "-i", duckedPath,
    "-filter_complex", "[0:a][1:a]amix=inputs=2:duration=first:dropout_transition=0:normalize=0[out]",
    "-map", "[out]", "-c:a", "pcm_f32le", "-ar", "48000", "-ac", "2", premasterPath,
  ], { label: "ffmpeg(mix-down)", timeoutMs: 900_000 });

  // ④ 母版响度（两遍法 loudnorm：-14 LUFS / -1 dBTP）
  let normalized = await normalizeLoudness({
    input: premasterPath, output: path.join(work, "master.wav"), targetLufs, truePeak, bins,
  });

  // Retain the independent tracks after exactly the same master gain for meaningful comparison.
  const finalDialoguePath = path.join(work, "dialogue-final.wav");
  const finalMusicPath = path.join(work, "music-final.wav");
  const finalProgramPath = path.join(work, "program-final.wav");
  await applyMasterGain({ input: dialoguePath, output: finalDialoguePath, gainDb: normalized.gainDb, bins });
  await applyMasterGain({ input: duckedPath, output: finalMusicPath, gainDb: normalized.gainDb, bins });
  await applyMasterGain({ input: bedSource, output: finalProgramPath, gainDb: normalized.gainDb, bins });
  const masterTrimDb = 0;

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

  const quietCandidates = (segments, minimum) => segments
    .map((segment) => { const start = Math.max(0.2, segment.start), end = Math.min(duration - 0.2, segment.end);
      return { ...segment, start, end, duration: end - start }; })
    .filter((segment) => segment.duration >= minimum).sort((a, b) => b.duration - a.duration).slice(0, 6);
  const windows = {
    voice: voice.segments.filter((segment) => segment.duration >= 0.6).sort((a, b) => b.duration - a.duration).slice(0, 6),
    quiet: quietCandidates(voice.silences, 0.4),
  };
  // 全程无绝对静音（连续口播/连续现场声）时，用「相对安静窗口」兜底测配乐可闻度：
  // 把 silencedetect 的阈值抬高 12dB 再找一次——它找到的不是静音，而是"这段片子相对最安静的地方"，
  // 这个来源会写进回执（quietWindowSource），避免把相对安静当成绝对静音来陈述。
  let quietWindowSource = "absolute-silence";
  if (windows.quiet.length === 0) {
    const relative = await detectVoiceBandSegments({
      input: dialoguePath, duration, noiseDb: Math.min(-6, voice.noiseDb + 12), minSilenceSec: 0.35, minSegmentSec: 0.2, bins,
    });
    windows.quiet = quietCandidates(relative.silences, 0.35);
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
  const controlInVoice = controlPath ? await levelOf(controlPath, windows.voice) : null;
  const finalInQuiet = await levelOf(output, windows.quiet);
  const finalInVoiceBand = await levelOf(finalDialoguePath, windows.voice, VOICE_BAND);
  const finalMusicInVoice = await levelOf(finalMusicPath, windows.voice);
  const sourceInQuiet = await levelOf(finalProgramPath, windows.quiet);
  const finalMusicInQuiet = await levelOf(finalMusicPath, windows.quiet);

  /** 旧口径（对照用，保留字段以免下游断链）：让位后的"人声窗 − 安静窗"，受曲子动态影响 */
  const duckingContrastDb = Number.isFinite(duckedInVoice) && Number.isFinite(duckedInQuiet)
    ? round(duckedInVoice - duckedInQuiet, 2)
    : null;
  /**
   * 新口径（权威）：同窗口下"让位后 − 不挂侧链的对照"，按本模块既有约定取**负值**
   * （`ducking_applied` 判 `<= -4`、预警判 `> -6`；负得越多＝压得越深）。
   */
  // 无侧链对照测不到时，旧对比值仍留作调试，不能代替权威让位深度参与交付判定。
  const duckingDepthDb = measuredDuckingDepthDb(controlInVoice, duckedInVoice);
  /** 对照口径（旧指标）也一并暴露，便于回归比较"曲子动态"与"真实侧链深度"两条曲线 */
  const levelsDebug = { controlInVoiceDb: controlInVoice, duckingContrastDb };
  const speechToMusicMarginDb = Number.isFinite(finalInVoiceBand) && Number.isFinite(finalMusicInVoice)
    ? round(finalInVoiceBand - finalMusicInVoice, 2)
    : null;
  const musicPresenceDb = Number.isFinite(finalMusicInQuiet) && Number.isFinite(sourceInQuiet)
    ? round(finalMusicInQuiet - sourceInQuiet, 2) : null;
  const presenceMeasured = Number.isFinite(musicPresenceDb);
  const presenceBasis = presenceMeasured ? "independent-post-gain-tracks" : "none";

  const targets = findRecipes({ list: true }).targets;
  const checks = evaluateMixChecks({
    loudnessAfter, targetLufs, truePeak, musicPresenceDb,
    musicPresenceTargetDb: targets.musicPresenceDb,
    speechToMusicMarginDb, duckingDepthDb, policy, dialogueStatus,
  });
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

  // 失败关闭：响度、真峰值、可闻度、人声余量、让位任一未核实或未达标，都不能生成成功回执。
  const failedDetails = [];
  if (!checks.loudness_ok) failedDetails.push(Number.isFinite(loudnessAfter.integratedLufs)
    ? `成片响度 ${loudnessAfter.integratedLufs} LUFS，目标 ${targetLufs}±1.5 LUFS`
    : "成片响度无法测量");
  if (!checks.true_peak_ok) failedDetails.push(Number.isFinite(loudnessAfter.truePeakDbtp)
    ? `成片真峰值 ${loudnessAfter.truePeakDbtp} dBTP，须 ≤${truePeak + 0.2} dBTP`
    : "成片真峰值无法测量");
  if (!checks.music_audible) failedDetails.push(explainMusicAudibility({
    musicPresenceDb, targetDb: targets.musicPresenceDb, quietWindowSource, measured: presenceMeasured,
  }));
  if (!checks.dialogue_preserved) failedDetails.push(`人声-音乐余量 ${speechToMusicMarginDb}dB < 3dB`);
  if (!checks.ducking_applied) failedDetails.push(Number.isFinite(duckingDepthDb)
    ? `让位深度仅 ${duckingDepthDb}dB，须 ≤-4dB`
    : "让位深度无法测量");
  await enforceMixChecks({
    checks, output, details: failedDetails,
    // 可闻度测不到时调电平重试仍测不到，保留既有不可重试语义。
    retryable: presenceMeasured,
  });

  // ⑥ 证据：前后波形对比（可选再加频谱图）
  let evidence = null;
  if (evidenceDir) {
    await fsp.mkdir(evidenceDir, { recursive: true });
    const waveform = await renderWaveformCompare({
      before: programPath, after: output, output: path.join(evidenceDir, "waveform-before-after.png"), bins,
    });
    evidence = { waveform };
    if (sectionPlan?.chosen) {
      const structureShot = await renderSectionEvidence({
        music: { input: bgmPath, durationSec: structure?.durationSec ?? bgmProbe.duration },
        film: { input: programPath, durationSec: duration },
        section: { startSec: sectionPlan.played?.startSec ?? sectionPlan.chosen.startSec, endSec: sectionPlan.chosen.endSec },
        filmPeakSec: filmArc?.peakTimeSec ?? null,
        output: path.join(evidenceDir, "section-picked.png"),
        bins,
      });
      evidence.sectionPicked = structureShot;
    }
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
      playedPath: playPath,
      playedSha256: sectionArtifact?.sha256 ?? await sha256File(bgmPath),
    },
    section: sectionPlan
      ? {
        mode: sectionPlan.mode,
        chosen: sectionPlan.chosen,
        played: sectionPlan.played ?? null,
        reason: sectionPlan.reason ?? sectionPlan.note ?? null,
        filmPeakAlign: sectionPlan.filmPeakAlign ?? null,
        track: structure
          ? {
            durationSec: structure.durationSec,
            bpm: structure.tempo.bpm,
            bpmConfidence: structure.tempo.confidence,
            dynamicsDb: structure.structure.dynamicsDb,
            segments: structure.structure.segments.map((segment) => ({
              type: segment.type, startSec: segment.startSec, endSec: segment.endSec,
              avgDb: segment.avgDb, peakDb: segment.peakDb,
            })),
            method: structure.method,
          }
          : null,
        filmArc: filmArc
          ? {
            peakTimeSec: filmArc.peakTimeSec,
            peakBasis: filmArc.climaxBasis ?? null,
            peakDetails: filmArc.climaxDetails ?? null,
            audioPeakTimeSec: filmArc.audioPeakTimeSec ?? null,
            dynamicsDb: filmArc.dynamicsDb,
            avgDb: filmArc.avgDb,
          }
          : null,
      }
      : { mode: "full", chosen: null, reason: "整曲循环（未启用选段）" },
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
      ...levelsDebug,
      speechToMusicMarginDb,
      musicPresenceDb,
      programLevelDb: speechLevel,
      comparisonBasis: "independent dialogue/music/program after identical linear master gain",
      finalMusicInVoiceDb: finalMusicInVoice, finalMusicInQuietDb: finalMusicInQuiet,
    },
      loudness: {
        before: {
          integratedLufs: round(normalized.measuredBefore?.integratedLufs, 2),
          truePeakDbtp: round(normalized.measuredBefore?.truePeakDbtp, 2),
        },
        after: { integratedLufs: round(loudnessAfter.integratedLufs, 2), truePeakDbtp: round(loudnessAfter.truePeakDbtp, 2), lra: round(loudnessAfter.lra, 2) },
        masterTrimDb,
        normalization: { method: normalized.method, gainDb: normalized.gainDb,
          wantedGainDb: normalized.wantedGainDb, limiterApplied: false, truePeakHeadroomDb: normalized.truePeakHeadroomDb },
      },
    output: {
      path: output,
      durationSeconds: outputProbe.duration,
      sizeBytes: outputProbe.sizeBytes,
      audio: outputProbe.audio,
      hash: await sha256File(output),
    },
    checks,
    applicability: { dialogue_preserved: dialogueStatus, ducking_applied: dialogueStatus },
    retainedTracks: await Promise.all([
      ["dialogue", finalDialoguePath], ["music", finalMusicPath], ["program", finalProgramPath],
      ["ducked-music", duckedPath], ["control-music", controlPath],
    ].filter(([, file]) => file).map(async ([role, file]) => ({ role, path: file, sha256: await sha256File(file) }))),
    warnings,
    voiceActivity: {
      activeRatio: voice.activeRatio,
      segments: voice.segments.length,
      method: voice.method,
      quietWindowSource,
      quietWindowsUsed: windows.quiet.length,
      presenceBasis,
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
  promptText = null, sourcePolicy = "compose-only", destDir = null, env = process.env, fetchImpl = fetch,
  catalog = null, platform = null, genreMismatchPolicy = null, audioStems = null,
}) {
  const independent = await verifyIndependentAudio(audioStems, { env, bins });
  const probe = await probeMedia(input, { bins });
  const duration = probe.duration;

  /**
   * 提示词驱动（2026-09-23 新增）：把"提交渲染的原始提示词"当输入源 →
   * ① 解析成配乐简报（题材/情绪/BPM/禁忌/能量弧线/高潮落点）；
   * ② 三级取曲：在线源优先 → 本地曲库兜底 → 自算作曲最后兜底；
   * ③ 用简报调配方电平与分层策略，并让提示词的高潮线索参与选段对齐。
   */
  const briefBundle = promptText
    ? analyzePromptBrief({
      promptText, platform: platform ?? null, durationSec: duration,
      genreMismatchPolicy: genreMismatchPolicy ?? null,
    })
    : null;
  const brief = briefBundle?.brief ?? null;
  const energyCurve = brief ? energyCurveFor({ brief, durationSec: duration }) : null;
  if (brief?.noMusic) {
    return {
      verdict: "no_bgm_needed",
      reason: "提示词明确要求不加配乐（no music）→ 按 do-no-harm 判定，不产出文件",
      brief,
      energyCurve,
      source: { speechLevelDb: null, roomToneDb: null, activeRatio: null },
      candidates: [],
      sha256: await sha256File(input),
    };
  }
  const briefGenre = brief?.recipeId
    ? (findRecipes({ recipeId: brief.recipeId }).recipe?.genre ?? null)
    : null;
  const effectiveGenre = genre ?? briefGenre;
  const effectiveMood = mood ?? (brief?.mood?.length ? null : null);

  /** 取曲：仅有提示词或显式要求时走"在线优先/本地兜底"，否则保持原有自算作曲择优路径。 */
  let trackResolution = null;
  const wantsLibrary = Boolean(brief) || sourcePolicy !== "compose-only";
  if (wantsLibrary) {
    const recipeForSearch = brief?.recipeId ? findRecipes({ recipeId: brief.recipeId }).recipe : null;
    trackResolution = await resolveTrackForBrief({
      brief, recipe: recipeForSearch, policy: sourcePolicy, durationSec: duration,
      env, fetchImpl, destDir, catalog,
    });
  }
  const voice = await detectVoiceBandSegments({ input: independent.roles.dialogue.path, duration, bins });
  const detected = probe.video ? await detectCuts({ input, bins }) : { cuts: [], strong: [], method: "no-video" };
  const roomWindows = voice.silences
    .filter((segment) => segment.duration >= 0.4 && segment.start >= 0.2)
    .sort((a, b) => b.duration - a.duration)
    .slice(0, 4);
  const voiceWindows = voice.segments
    .filter((segment) => segment.duration >= 0.6)
    .sort((a, b) => b.duration - a.duration)
    .slice(0, 4);
  const levelOf = async (list, band = null, file = independent.program.path) => {
    const levels = [];
    for (const window of list) {
      const measured = await segmentMeanVolumeDb({ input: file, start: window.start, duration: Math.min(window.duration, 2), band, bins });
      levels.push(measured.meanDb);
    }
    return round(average(levels), 2);
  };
  const speechLevel = await levelOf(voiceWindows, VOICE_BAND, independent.roles.dialogue.path);
  const roomTone = await levelOf(roomWindows);
  const recipeCatalog = findRecipes({ list: true }).items;
  let pool = recipeCatalog;
  if (Array.isArray(recipeIds) && recipeIds.length) pool = recipeCatalog.filter((recipe) => recipeIds.includes(recipe.id));
  else if (effectiveGenre || mood || (brief?.recipeId)) {
    const filtered = recipeCatalog.filter((recipe) => {
      if (brief?.recipeId && recipe.id === brief.recipeId) return true;
      const genreHit = effectiveGenre ? recipe.genre.includes(String(effectiveGenre)) : false;
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
    // 平台差异参数（T-15）：上下文带目标平台且配方声明覆盖时，用覆盖值参与打分/混音参数推导。
    const platformFx = applyPlatformOverrides(recipe, platform ?? brief?.platform ?? null);
    for (const duckDepth of [platformFx.duckingDb - 2, platformFx.duckingDb, platformFx.duckingDb + 2]) {
      const depth = Math.max(6, Math.min(18, duckDepth));
      const musicLevel = Math.max(-30, Math.min(-16, platformFx.musicLevelDb));
      // 人声出现时 BGM 被压低 depth dB → 该窗口音乐电平 = musicLevel - depth，
      // 因此余量 = 人声电平 − (音乐电平 − 让位深度)。此前写成 (musicLevel + depth)，
      // 会把"音乐被压低"算成"音乐更响"，导致 best 误判"无需配乐"（2026-09-23 演示实测）。
      const margin = Number.isFinite(speechLevel) ? round(speechLevel - (musicLevel - depth), 2) : null;
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
        platformOverride: platformFx.override,
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
  const winnerFx = applyPlatformOverrides(recipe, platform ?? brief?.platform ?? null);
  const effectiveTargetLufs = Number.isFinite(winnerFx.lufsTarget) ? winnerFx.lufsTarget : targetLufs;
  const work = await tempDir("bgm-best-");
  const levelWithBrief = Math.max(-30, Math.min(-16, winner.musicLevelDb + (brief?.musicLevelDeltaDb ?? 0)));
  const climaxOverride = Number.isFinite(brief?.climax?.atSec) ? brief.climax.atSec : null;

  // 取曲三级链的落地：在线/本地命中就直接用那首；否则回退自算作曲
  let bgmPath;
  let composed = null;
  let trackInfo = null;
  let sectionMode = "full";
  if (trackResolution?.track?.localPath) {
    bgmPath = trackResolution.track.localPath;
    trackInfo = {
      layer: trackResolution.layer,
      id: trackResolution.track.id,
      title: trackResolution.track.title ?? null,
      artist: trackResolution.track.artist ?? null,
      source: trackResolution.track.source ?? null,
      pageUrl: trackResolution.track.pageUrl ?? null,
      license: trackResolution.track.license,
      licenseLabel: trackResolution.track.licenseLabel ?? licenseInfo(trackResolution.track.license).label,
      sha256: trackResolution.track.sha256 ?? null,
      cached: trackResolution.track.cached ?? false,
      match: trackResolution.track.match ?? null,
    };
    sectionMode = "auto";
  } else {
    if (trackResolution?.failed) {
      throw new BgmError(`在线取源失败且未允许回退：${trackResolution.reason}`, "not_found");
    }
    bgmPath = path.join(work, "bgm.wav");
    composed = await composeToWav({ recipe, durationSec: duration, output: bgmPath, seed, bpmOverride: winner.bpm });
  }
  const mixed = await mix({
    audioStems, env,
    input,
    output,
    bgmPath,
    policy,
    bgmBpm: winner.bpm,
    musicLevelDb: levelWithBrief,
    duckingDb: winner.duckingDb,
    targetLufs: effectiveTargetLufs,
    truePeak,
    evidenceDir,
    bins,
    section: sectionMode,
    filmClimaxOverrideSec: climaxOverride,
  });
  await fsp.rm(work, { recursive: true, force: true }).catch(() => {});
  return {
    verdict: "scored",
    winner: winner.id,
    winnerLabel: winner.label,
    score: winner.score,
    minScore,
    recipe: { id: recipe.id, genre: recipe.genre, mood: recipe.mood, key: recipe.key, mode: recipe.mode, bpm: recipe.bpm, chords: recipe.chords, platformOverride: winnerFx.override },
    brief,
    energyCurve,
    track: trackInfo,
    sourceResolution: trackResolution
      ? { requested: sourcePolicy, layer: trackResolution.layer, degraded: Boolean(trackResolution.degraded), attempts: trackResolution.attempts }
      : { requested: "compose-only", layer: "compose", degraded: false, attempts: [] },
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
  /**
   * 注意用宽松判等（2026-09-25 真机）：CLI 未传 `--bpm` 时可能是 `undefined` 而不是 `null`，
   * 早先严格 `=== null` 会让 `cut-driven` 分支**静默不生效**——tempo 永远取配方默认 100BPM，
   * 于是"卡点"对任何片子/任何曲子都报同一组数字（14/36、116.2ms），快剪片永远对不齐。
   */
  if (bpmOverride == null && bpmStrategy === "cut-driven" && input) {
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
          sectionModes: SECTION_MODES,
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

    case "bgmread.structure": {
      const input = assertPathAllowed(text(params.input_path, "input_path"), roots, "input_path");
      const result = await analyzeStructure({
        input,
        windowSec: optionalNumber(params.window_sec) ?? 0.25,
        minSegmentSec: optionalNumber(params.min_segment_sec) ?? 3,
        maxSeconds: optionalNumber(params.max_seconds) ?? 600,
        bins,
      });
      return {
        result,
        receipt: { synced: true, sha256: await sha256File(input), verified_at: new Date().toISOString() },
      };
    }

    case "bgmread.brief": {
      // 提示词 → 配乐简报（题材/情绪/BPM 倍率/禁忌/能量弧线/高潮落点/分层策略）
      const promptText = text(params.prompt_text, "prompt_text");
      const { brief, matched } = analyzePromptBrief({
        promptText,
        platform: params.platform ?? null,
        durationSec: optionalNumber(params.duration_sec),
        recipeHint: params.recipe_hint ?? null,
        genreMismatchPolicy: params.genre_mismatch_policy ? String(params.genre_mismatch_policy) : null,
      });
      const energyCurve = energyCurveFor({ brief, durationSec: optionalNumber(params.duration_sec) });
      const matchedRecipe = brief.recipeId ? findRecipes({ recipeId: brief.recipeId }).recipe : null;
      // 平台差异参数（T-15）：brief 带目标平台且配方声明覆盖时，建议参数用覆盖值。
      const platformFx = matchedRecipe ? applyPlatformOverrides(matchedRecipe, brief.platform) : null;
      return {
        result: {
          brief,
          energyCurve,
          matched,
          suggestedRecipe: matchedRecipe
            ? {
              id: matchedRecipe.id, genre: matchedRecipe.genre, mood: matchedRecipe.mood,
              bpm: matchedRecipe.bpm, key: matchedRecipe.key, mode: matchedRecipe.mode,
              musicLevelDb: platformFx.musicLevelDb,
              recommendedLevelDb: Math.max(-30, Math.min(-16, platformFx.musicLevelDb + brief.musicLevelDeltaDb)),
              duckingDb: platformFx.duckingDb,
              platformOverride: platformFx.override,
            }
            : null,
          sourcePolicyHint: "online-first（在线曲源优先，失败回退本地曲库，再兜底自算作曲）",
        },
        receipt: { synced: true, snapshot_uri: `bgm://brief/${brief.recipeId ?? "unknown"}`, verified_at: new Date().toISOString() },
      };
    }

    case "bgmwrite.fetch": {
      // 在线取源（可单独调用）：按简报或题材去已配置的在线源检索 → 许可闸 → 下载缓存
      const promptText = params.prompt_text ? String(params.prompt_text) : null;
      const durationSec = optionalNumber(params.duration_sec);
      const brief = promptText
        ? analyzePromptBrief({
          promptText, durationSec,
          genreMismatchPolicy: params.genre_mismatch_policy ? String(params.genre_mismatch_policy) : null,
        }).brief
        : null;
      const recipe = params.recipe_id
        ? findRecipes({ recipeId: String(params.recipe_id) }).recipe
        : (brief?.recipeId ? findRecipes({ recipeId: brief.recipeId }).recipe : null);
      const destDir = params.dest_dir ? assertPathAllowed(String(params.dest_dir), roots, "dest_dir") : onlineCacheDir(env);
      const resolution = await resolveTrackForBrief({
        brief, recipe, policy: params.source_policy ?? "online-first",
        durationSec, env, destDir, limit: optionalNumber(params.limit) ?? 8,
        catalog: typeof params.catalog === "string" ? params.catalog : null,
      });
      return {
        result: {
          ...resolution,
          brief,
          sources: listSources(env),
          cacheDir: destDir,
        },
        receipt: {
          synced: Boolean(resolution.track),
          ...(resolution.track?.sha256 ? { sha256: resolution.track.sha256 } : {}),
          snapshot_uri: resolution.track ? `bgm://fetch/${resolution.track.id}` : undefined,
          verified_at: new Date().toISOString(),
        },
      };
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
        audioStems: params.audio_stems ?? null, env,
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
        section: typeof params.section === "string" ? params.section : "full",
        sectionStartSec: optionalNumber(params.section_start_sec),
        sectionEndSec: optionalNumber(params.section_end_sec),
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

    /**
     * 曲库打标（写工具）：把一批本地音乐实测打标成可检索曲库索引。
     *
     * 围栏 G-BGM8 的实现在这里落地（两道硬闸）：
     * ① **许可必须先声明**：`license` 必填且必须落在可商用白名单里（NC/ND/未知一律拒），
     *    来源不明的音频不许写进曲库；
     * ② **不许覆盖既有曲库**：目标目录已有 `tracks.json` 时必须显式 `allow_overwrite=true`，
     *    否则一票否决——避免一次误调用把客户积累的曲库索引冲掉。
     * 低置信标签不阻断，但会写进索引（`confidence.style=low`）并随回执上报，供人审复核。
     */
    case "bgmwrite.tag": {
      const inputDir = assertPathAllowed(text(params.input_dir, "input_dir"), roots, "input_dir");
      const outDir = assertPathAllowed(text(params.out_dir, "out_dir"), roots, "out_dir");
      const license = String(params.license ?? "").trim();
      if (!license) {
        throw new BgmError(
          "曲库打标必须先声明许可（license）：来源不明的音频不许写进曲库（围栏 G-BGM8）",
          "license_blocked",
        );
      }
      const info = licenseInfo(license);
      if (info.commercial !== true) {
        throw new BgmError(
          `许可「${info.label}」不可商用 → 不允许进曲库（围栏 G-BGM5 / G-BGM8）；可选：${Object.entries(LICENSE_TABLE)
            .filter(([, entry]) => entry.commercial === true).map(([key]) => key).join(" / ")}`,
          "license_blocked",
        );
      }
      if (!fs.existsSync(inputDir) || !fs.statSync(inputDir).isDirectory()) {
        throw new BgmError(`素材目录不存在或不是目录：${inputDir}`, "bad_request");
      }
      const indexPath = path.join(outDir, "tracks.json");
      if (fs.existsSync(indexPath) && params.allow_overwrite !== true) {
        throw new BgmError(
          `目标曲库已有索引 ${indexPath}：覆盖既有曲库须显式 allow_overwrite=true（围栏 G-BGM8）`,
          "overwrite_existing_forbidden",
        );
      }
      const tagged = await tagLibrary({
        root: inputDir,
        license: info.key,
        licenseNote: params.license_note
          ? String(params.license_note)
          : `许可 ${info.label}（调用方 ${params.license_source ? String(params.license_source) : "未标注来源"} 声明）`,
        licenseSource: params.license_source ? String(params.license_source) : null,
        recursive: params.recursive !== false,
        maxSeconds: optionalNumber(params.max_seconds) ?? 180,
        concurrency: optionalNumber(params.concurrency) ?? 4,
      });
      const written = writeLibrary({
        outDir,
        result: tagged,
        libraryName: params.library_name ? String(params.library_name) : null,
        provider: params.provider ? String(params.provider) : "local-tagged",
        fileMode: params.file_mode === "relative" ? "relative" : "absolute",
      });
      const lowConfidence = tagged.tracks
        .filter((track) => track.confidence?.style === "low")
        .map((track) => ({ id: track.id, file: track.file, style: track.style, styleConfidence: track.confidence?.style, bpmConfidence: track.bpmConfidence }));
      return {
        result: {
          outDir: written.outDir,
          files: written.files,
          counts: tagged.counts,
          license: { key: info.key, label: info.label, attributionRequired: info.attributionRequired === true },
          filters: tagged.filters,
          rejected: tagged.rejected.slice(0, 50),
          rejectedTotal: tagged.rejected.length,
          errors: tagged.errors,
          lowConfidence: lowConfidence.slice(0, 20),
          lowConfidenceTotal: lowConfidence.length,
          sample: tagged.tracks.slice(0, 5).map((track) => ({
            id: track.id, style: track.style, bpm: track.bpm, bpmBucket: track.bpmBucket,
            energyBucket: track.energyBucket, tags: track.tags,
          })),
        },
        receipt: {
          synced: true,
          snapshot_uri: `bgm://library/${path.basename(outDir)}?tracks=${tagged.tracks.length}`,
          verified_at: new Date().toISOString(),
          ...(tagged.tracks[0]?.sha256 ? { sha256: tagged.tracks[0].sha256 } : {}),
        },
      };
    }

    /**
     * 曲库维护（写工具）：`rebind` 搬迁后重绑路径，`pack` 把索引进素材目录（相对路径，随文件夹走）。
     *
     * 产品口径：用户单独下载素材文件夹后，两条路都能"接上"——
     * ① 文件夹里带着 `tracks.json`（`pack` 出来的相对路径索引）→ 自动发现直接可用；
     * ② 只有绝对路径索引而素材被挪走 → `rebind` 按文件名/大小（可选 sha256）重新绑定。
     * 覆盖既有索引同样受围栏 G-BGM8 约束（必须显式 allow_overwrite=true）。
     */
    case "bgmwrite.library": {
      const action = text(params.action, "action");
      const libraryDir = assertPathAllowed(text(params.library_dir, "library_dir"), roots, "library_dir");
      if (action === "rebind") {
        const newRoot = assertPathAllowed(text(params.new_root, "new_root"), roots, "new_root");
        if (params.allow_overwrite !== true) {
          throw new BgmError(
            "重新绑定会改写曲库索引（tracks.json）：须显式 allow_overwrite=true（围栏 G-BGM8）",
            "overwrite_existing_forbidden",
          );
        }
        const report = await rebindLibrary({
          indexDir: libraryDir,
          newRoot,
          verify: params.verify === "sha256" ? "sha256" : "size",
          dryRun: params.dry_run === true,
        });
        return {
          result: {
            action, indexDir: libraryDir, oldRoot: report.oldBase, newRoot: report.newRoot,
            verify: report.verify, dryRun: params.dry_run === true,
            matched: report.matched, missing: report.missing, ambiguous: report.ambiguous,
            samples: report.details.slice(0, 10),
          },
          receipt: {
            synced: report.missing === 0,
            snapshot_uri: `bgm://library/rebind?matched=${report.matched}&missing=${report.missing}`,
            verified_at: new Date().toISOString(),
          },
        };
      }
      if (action === "pack") {
        const destDir = params.dest_dir ? assertPathAllowed(String(params.dest_dir), roots, "dest_dir") : null;
        const packed = packLibrary({
          indexDir: libraryDir,
          destDir,
          overwrite: params.allow_overwrite === true,
        });
        return {
          result: { action, ...packed },
          receipt: {
            synced: true,
            snapshot_uri: `bgm://library/pack?tracks=${packed.tracks}`,
            verified_at: new Date().toISOString(),
          },
        };
      }
      if (action === "inspect" || action === "discover") {
        return {
          result: {
            action,
            discovered: discoverLibraries({ scanRoots: defaultScanRoots(env) }),
            roots: libraryRoots(env).map((root) => ({ dir: root.dir, kind: root.kind, label: root.label })),
          },
          receipt: { synced: true, verified_at: new Date().toISOString() },
        };
      }
      throw new BgmError(`未知曲库动作：${action}（支持 rebind / pack / inspect）`, "bad_request");
    }

    case "bgmwrite.best": {
      const input = assertPathAllowed(text(params.input_path, "input_path"), roots, "input_path");
      const output = params.output_path ? assertPathAllowed(String(params.output_path), roots, "output_path") : null;
      if (output && output === input) throw new BgmError("禁止覆盖原片", "overwrite_source_forbidden");
      const evidenceDir = params.evidence_dir ? assertPathAllowed(String(params.evidence_dir), roots, "evidence_dir") : null;
      const outcome = await best({
        audioStems: params.audio_stems ?? null, env,
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
        promptText: params.prompt_text ? String(params.prompt_text) : null,
        sourcePolicy: typeof params.source_policy === "string" ? params.source_policy : "compose-only",
        catalog: typeof params.catalog === "string" ? params.catalog : null,
        destDir: params.dest_dir ? assertPathAllowed(String(params.dest_dir), roots, "dest_dir") : null,
        platform: params.platform ? String(params.platform) : null,
        genreMismatchPolicy: params.genre_mismatch_policy ? String(params.genre_mismatch_policy) : null,
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
