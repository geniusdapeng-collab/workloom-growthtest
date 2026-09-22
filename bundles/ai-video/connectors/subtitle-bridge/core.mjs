/**
 * ai-video × 字幕工位 bridge 内核（core.mjs）
 *
 * 定位：把「标题/字幕怎么落地」做成可审计的确定性工具层——工位本地执行，零云端依赖
 * （node 内置模块 + 工位本地 ffmpeg/ffprobe + 工位字体目录，字体档案在仓内）。
 *
 * 纪律（与 color-bridge / bgm-bridge 同构）：
 * - 原片只读：任何写入都落到新文件，覆盖原片直接拒绝（overwrite_source_forbidden）；
 * - 路径监狱：只允许访问白名单根目录内的路径（WORKLOOM_SUBTITLE_ALLOWED_ROOTS）；
 * - 无回执=未核实：产物必须给出 sha256 + 版式复检（实测字号/行宽/安全区/对比度/时间轴回读）；
 * - 不伪造：字体缺失、滤镜缺失、量不出来一律抛带稳定 code 的 SubtitleError，不猜、不兜底；
 * - 不做修改型字体处理：不子集化、不改度量（OFL 修改后再发布需改名，本能力直接使用原始字体）。
 *
 * 选型知识来自 font-library v1.1（随包 font_db.json 的五维打标 + 字号/版式策略 + 账号调性），
 * 版式与安全区的工程取值见 library/font-catalog/font_db.json#layout_policy.occlusion_zones。
 */

import { createHash } from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  MeasureError, binaryVersion, detectRenderCapabilities, escapeFilterPath, extractFrame,
  measureInkExtent, parseFontSelections, pickVideoEncoder, probeMedia, regionStats, resolveBinaries,
  round, runBin, sha256File, tempDir,
} from "./measure.mjs";

/** 工位对外错误类型（与 measure 内核同源，统一 code 语义）。 */
export const SubtitleError = MeasureError;

/* ============================ 工具面 ============================ */

/** 本连接器提供的工具面；不在表内的工具直接拒绝（与 color/bgm-bridge 同款白名单纪律）。 */
export const SUBTITLE_TOOLS = [
  "subtitleread.health",
  "subtitleread.probe",
  "subtitleread.analyze",
  "subtitleread.fonts",
  "subtitleread.recipes",
  "subtitlewrite.plan",
  "subtitlewrite.burn",
  "subtitlewrite.title",
  "subtitlewrite.best",
];

const TOOL_SET = new Set(SUBTITLE_TOOLS);

export function isSubtitleTool(name) {
  return TOOL_SET.has(name);
}

export const FONT_SCENES = ["标题", "字幕", "弹幕", "贴纸"];

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
  const raw = (env.WORKLOOM_SUBTITLE_ALLOWED_ROOTS ?? "").trim();
  const list = raw ? raw.split(":").map((entry) => entry.trim()).filter(Boolean) : [process.cwd(), os.tmpdir()];
  return list.map((entry) => {
    const abs = path.resolve(entry);
    return fs.existsSync(abs) ? fs.realpathSync(abs) : abs;
  });
}

/** 路径白名单校验（软链逃逸同样拦：对真实路径做前缀判定）。 */
export function assertPathAllowed(target, roots = allowedRoots(), label = "path") {
  if (typeof target !== "string" || target.trim() === "") {
    throw new SubtitleError(`${label} 为空`, "bad_request");
  }
  const abs = path.resolve(target);
  const normalized = realpathDeepest(abs);
  const normalizedRoots = roots.map((root) => {
    const resolved = path.resolve(String(root));
    return fs.existsSync(resolved) ? fs.realpathSync(resolved) : resolved;
  });
  if (!normalizedRoots.some((root) => isInside(normalized, root))) {
    throw new SubtitleError(`${label} 越出允许目录（路径监狱）：${abs}`, "path_not_allowed");
  }
  return normalized;
}

/* ============================ 字体档案与工位字体目录 ============================ */

export const CATALOG_FILE = path.resolve(
  path.dirname(new URL(import.meta.url).pathname),
  "../../library/font-catalog/font_db.json",
);

export const RECIPE_FILE = path.resolve(
  path.dirname(new URL(import.meta.url).pathname),
  "../../library/typography-recipes/recipes.json",
);

let catalogCache = null;
let recipeCache = null;

/** 读字体档案库（缺文件=显式失败，不静默返回空）。 */
export function loadFontCatalog(file = CATALOG_FILE) {
  if (catalogCache && catalogCache.file === file) return catalogCache.doc;
  if (!fs.existsSync(file)) throw new SubtitleError(`字体档案库不存在：${file}`, "not_configured", false);
  const doc = JSON.parse(fs.readFileSync(file, "utf8"));
  if (doc?.schemaVersion !== "workloom.font-catalog/v1" || !Array.isArray(doc.fonts)) {
    throw new SubtitleError(`字体档案库格式不合法：${file}`, "bad_font", false);
  }
  catalogCache = { file, doc };
  return doc;
}

/** 读版式配方库（与 bgm/color 配方库同构：题材×场景 → 字体族倾向/字号倍率/描边/底衬/禁忌）。 */
export function loadRecipes(file = RECIPE_FILE) {
  if (recipeCache && recipeCache.file === file) return recipeCache.doc;
  if (!fs.existsSync(file)) throw new SubtitleError(`版式配方库不存在：${file}`, "not_configured", false);
  const doc = JSON.parse(fs.readFileSync(file, "utf8"));
  if (doc?.schemaVersion !== "workloom.typography-recipes/v1" || !Array.isArray(doc.recipes)) {
    throw new SubtitleError(`版式配方库格式不合法：${file}`, "bad_recipe", false);
  }
  recipeCache = { file, doc };
  return doc;
}

/** 工位字体目录：环境变量优先，缺省 ~/.workloom-subtitle/fonts。 */
export function fontsRoot(env = process.env) {
  const raw = (env.WORKLOOM_SUBTITLE_FONTS_DIR ?? "").trim();
  return raw ? path.resolve(raw) : path.join(os.homedir(), ".workloom-subtitle", "fonts");
}

/**
 * 扫描工位已安装字体：逐款核对档案里的 `file` 是否在位（可选校验 sha256）。
 * verifySha=true 时逐文件哈希（29 款 ≈128MB，健康探针默认不校验，交付前体检才校验）。
 */
export function scanFonts({ catalog = loadFontCatalog(), root = fontsRoot(), verifySha = false } = {}) {
  const entries = catalog.fonts.map((font) => {
    const absolute = path.join(root, font.file);
    const present = fs.existsSync(absolute);
    const record = {
      id: font.id,
      name: font.字体名称,
      file: font.file,
      absolutePath: absolute,
      present,
      bytes: present ? fs.statSync(absolute).size : null,
      expectedBytes: font.bytes ?? null,
      sha256: verifySha && present ? sha256FileSync(absolute) : null,
      sha256Matches: null,
      license: font.license,
    };
    if (verifySha && present) record.sha256Matches = record.sha256 === font.sha256;
    return record;
  });
  return {
    root,
    total: entries.length,
    installed: entries.filter((entry) => entry.present).length,
    verified: verifySha ? entries.filter((entry) => entry.sha256Matches === true).length : null,
    missing: entries.filter((entry) => !entry.present).map((entry) => entry.file),
    entries,
  };
}

function sha256FileSync(file) {
  // 逐文件哈希：仅供 scanFonts 的显式体检路径（交付前核验字体是否被替换过）
  return createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

/**
 * 渲染用字体目录：libass 的 fontsdir **不递归**子目录（cn/ en/ 会被当成不可读文件跳过），
 * 若直接把工位字体根目录交给 ffmpeg，字体找不到时会静默回落系统字体——那等于假交付。
 * 因此渲染前在临时目录建一个扁平目录：硬链接优先，退化到软链，最后才复制。
 */
export function prepareFlatFontsDir({ fontsDir = fontsRoot(), catalog = loadFontCatalog(), workDir }) {
  const dir = workDir ?? fs.mkdtempSync(path.join(os.tmpdir(), "workloom-subtitle-fonts-"));
  const flat = path.join(dir, "fonts-flat");
  fs.mkdirSync(flat, { recursive: true });
  const linked = [];
  const missing = [];
  for (const font of catalog.fonts) {
    const source = path.join(fontsDir, font.file);
    if (!fs.existsSync(source)) { missing.push(font.file); continue; }
    const target = path.join(flat, path.basename(font.file));
    if (fs.existsSync(target)) { linked.push(target); continue; }
    try {
      fs.linkSync(source, target);
    } catch {
      try {
        fs.symlinkSync(source, target);
      } catch {
        fs.copyFileSync(source, target);
      }
    }
    linked.push(target);
  }
  return { flat, linked: linked.length, missing };
}

/* ============================ 许可 ============================ */

/**
 * 许可表：商用白名单 + 义务。缺省（未登记）按不合规处理（fail-closed），与围栏 G-SUB5 同口径。
 */
export const FONT_LICENSE_TABLE = {
  "ofl-1.1": {
    known: true,
    commercial: true,
    label: "SIL OFL 1.1",
    modificationRequiresRename: true,
    resaleFontFilesForbidden: true,
    attributionRequired: false,
    note: "可商用与嵌入；禁止单独转售字体文件；修改后再发布必须改名并标注来源。",
  },
  "apache-2.0": {
    known: true,
    commercial: true,
    label: "Apache-2.0",
    modificationRequiresRename: false,
    resaleFontFilesForbidden: false,
    attributionRequired: true,
    note: "保留版权声明与许可文本即可；需在分发物中附 NOTICE。",
  },
  "vendor-free-commercial": {
    known: true,
    commercial: true,
    label: "厂商免费商用授权",
    modificationRequiresRename: true,
    resaleFontFilesForbidden: true,
    attributionRequired: false,
    requiresProofUrl: true,
    note: "阿里妈妈/普惠体一类厂商免费商用授权：登记时必须附许可证明链接，闭源分发前复核条款。",
  },
};

export function licenseInfo(license) {
  const key = String(license ?? "").trim().toLowerCase();
  const entry = FONT_LICENSE_TABLE[key];
  if (!entry) {
    return {
      license: key || null,
      known: false,
      commercial: null,
      label: "未登记许可",
      note: "未登记许可按不合规处理（fail-closed）：不得进入商用交付（G-SUB5）。",
    };
  }
  return { license: key, ...entry };
}

/* ============================ 选型规则引擎（font-library v1.1 口径） ============================ */

export const WEIGHTS = {
  type_match: 30,      // 作品类型命中
  tempo_match: 20,     // BGM 节奏命中
  weight_fit: 20,      // 粗细与场景适配
  art_fit: 15,         // 艺术气息与调性适配
  keyword_hit: 15,     // 气质关键词命中
};

/** 各场景对「字体粗细程度(0.5~5)」的期望区间与理想值。 */
export const SCENE_WEIGHT_PREF = {
  字幕: { range: [0.5, 3.0], ideal: 1.5, maxArt: null },
  标题: { range: [3.0, 5.0], ideal: 4.5, maxArt: null },
  弹幕: { range: [2.0, 4.0], ideal: 3.0, maxArt: 4 },
  贴纸: { range: [2.0, 5.0], ideal: 3.5, maxArt: null },
};

/** 内容调性 → 期望艺术气息区间（与附件口径一致）。 */
export const MOOD_ART_PREF = {
  庄重: [1, 3], 商务: [1, 3], 新闻: [1, 3], 知识: [1, 3],
  科技: [2, 4], 产品: [2, 4], 宣传: [2, 5],
  生活: [3, 5], 旅行: [3, 5], vlog: [3, 5], 美食: [3, 5],
  活泼: [4, 5], 可爱: [4, 5], 综艺: [4, 5], 二次元: [4, 5],
  文艺: [4, 5], 国风: [3, 5], 书法: [4, 5],
};

const clamp = (value, lo = 0, hi = 1) => Math.max(lo, Math.min(hi, value));

/**
 * 单款字体打分：未通过「场景 + 语言」硬过滤返回 (-1, 原因)。
 * 与附件 font_selector.py 的 score_font 同口径（权重、区间、理想值一致），并额外标注许可。
 */
export function scoreFont(font, brief, scene) {
  const reasons = [];
  if (!Array.isArray(font.场景) || !font.场景.includes(scene)) return { score: -1, reasons: [`不支持场景「${scene}」`] };
  const lang = brief?.语言 ?? "zh";
  if (!Array.isArray(font.语言) || !font.语言.includes(lang)) return { score: -1, reasons: [`不支持语言「${lang}」`] };
  const license = licenseInfo(font.license);
  if (license.commercial !== true) return { score: -1, reasons: [`许可不可商用（${font.license ?? "未登记"}）`] };

  let score = 0;
  const types = font.适合作品类型 ?? [];
  const workType = brief?.作品类型 ?? "";
  if (types.includes("全部类型") || types.includes(workType)) {
    score += WEIGHTS.type_match;
    reasons.push("作品类型匹配");
  } else if (types.some((item) => item.includes(workType) || workType.includes(item))) {
    score += WEIGHTS.type_match * 0.6;
    reasons.push("作品类型部分匹配");
  }

  const tempo = brief?.BGM节奏 ?? "中";
  const tempos = font.适配BGM节奏 ?? [];
  if (tempos.includes("全部类型") || tempos.includes(tempo)) {
    score += WEIGHTS.tempo_match;
    reasons.push(`节奏「${tempo}」适配`);
  }

  const pref = SCENE_WEIGHT_PREF[scene] ?? SCENE_WEIGHT_PREF.字幕;
  const weight = Number(font.字体粗细程度 ?? 3);
  const [lo, hi] = pref.range;
  if (weight >= lo && weight <= hi) {
    const dist = Math.abs(weight - pref.ideal) / Math.max(hi - lo, 0.5);
    const points = WEIGHTS.weight_fit * (1 - 0.6 * dist);
    score += points;
    reasons.push(`粗细度 ${weight} 与场景「${scene}」适配度 ${Math.round(points)}/${WEIGHTS.weight_fit}`);
  } else {
    const over = Math.min(Math.abs(weight - lo), Math.abs(weight - hi));
    const points = WEIGHTS.weight_fit * clamp(1 - over / 2, 0, 0.4);
    score += points;
    reasons.push(`粗细度 ${weight} 偏离场景区间（${lo}~${hi}）`);
  }

  const art = Number(font.艺术气息 ?? 3);
  const mood = `${brief?.内容调性 ?? ""}${brief?.账号调性 ?? ""}`;
  let artRange = null;
  const persona = brief?.账号调性配置 ?? {};
  if (Array.isArray(persona.艺术气息区间) && persona.艺术气息区间.length === 2) artRange = persona.艺术气息区间;
  if (!artRange) {
    for (const [key, range] of Object.entries(MOOD_ART_PREF)) {
      if (mood.includes(key) || workType.includes(key)) { artRange = range; break; }
    }
  }
  if (!artRange) artRange = [2, 5];
  if (art >= artRange[0] && art <= artRange[1]) {
    score += WEIGHTS.art_fit;
    reasons.push(`艺术气息 ${art} 符合调性「${mood || "通用"}」`);
  } else {
    score += WEIGHTS.art_fit * 0.3;
    reasons.push(`艺术气息 ${art} 偏离调性区间 ${artRange[0]}~${artRange[1]}`);
  }

  const keywords = Array.isArray(brief?.气质关键词) ? [...brief.气质关键词] : [];
  const styleWords = [...(font.气质关键词 ?? []), font.风格标签].filter(Boolean);
  const genPrompt = brief?.视频生成提示词 ?? "";
  if (genPrompt) {
    const hits = styleWords.filter((word) => word && genPrompt.includes(word));
    if (hits.length) {
      keywords.push(...hits);
      reasons.push(`上游提示词命中: ${hits.join("/")}`);
    }
  }
  if (keywords.length) {
    const hits = keywords.filter((keyword) => styleWords.some((word) => keyword.includes(word) || word.includes(keyword)));
    if (hits.length) {
      score += WEIGHTS.keyword_hit * Math.min(hits.length / keywords.length, 1);
      reasons.push(`气质命中: ${[...new Set(hits)].join("/")}`);
    }
  }
  return { score: round(score, 1), reasons };
}

/** 平台版式：缺省回落「默认」（与附件 get_layout 同口径）。 */
export function layoutFor(platform, catalog = loadFontCatalog()) {
  const policies = catalog.layout_policy ?? {};
  return {
    key: platform && policies[platform] ? platform : "默认",
    layout: policies[platform] ?? policies["默认"] ?? {},
    policies,
  };
}

/** 字号建议：短边 × 场景基准比 × 粗细修正 × 平台倍率；描边与安全边距同表推导。 */
export function recommendSize({ scene, resolution, font, catalog = loadFontCatalog(), platform = "默认" }) {
  const short = Math.min(resolution[0], resolution[1]);
  const policy = catalog.size_policy ?? {};
  const ratio = (policy.base_ratio ?? { 标题: 0.11, 字幕: 0.048, 弹幕: 0.04, 贴纸: 0.07 })[scene] ?? 0.048;
  const weight = Number(font.字体粗细程度 ?? 3);
  const adjust = 1 + (2.5 - weight) * 0.04;
  const { layout } = layoutFor(platform, catalog);
  const sceneLayout = layout[scene] ?? {};
  const multiplier = Number(sceneLayout.字号倍率 ?? 1);
  const size = Math.round(short * ratio * adjust * multiplier);
  return {
    sizePx: size,
    outlinePx: Math.max(1, Math.round(size * Number(policy.outline_ratio ?? 0.06))),
    safeMarginPx: Math.round(short * Number(policy.safe_margin_ratio ?? 0.05)),
    basis: `短边${short}×${ratio}(场景基准)×${round(adjust, 2)}(粗细修正)×${multiplier}(平台倍率)`,
    platform,
    layout: { ...sceneLayout },
  };
}

/**
 * 选型：账号调性「锁定字体」优先于打分（品牌视觉锤），其余按分数排序取 Top-N。
 * fontsDir 给定时标注每款是否已在工位安装（未安装的不进入可执行方案，但如实列出原因）。
 */
export function selectFonts({
  brief = {}, scene = "字幕", top = 3, catalog = loadFontCatalog(), fontsDir = null, resolution: resolutionOverride = null,
}) {
  if (!FONT_SCENES.includes(scene)) throw new SubtitleError(`未知场景「${scene}」`, "bad_request");
  // 字号必须按**实际素材短边**算：简报里的分辨率可能缺省或与交付素材不一致
  // （实测教训：简报写 1080×1920、素材却是 720×1280 时，按简报算出的字号会超出可读区间上限）。
  const resolution = Array.isArray(resolutionOverride) && resolutionOverride.length === 2
    ? resolutionOverride.map(Number)
    : Array.isArray(brief.分辨率) && brief.分辨率.length === 2
      ? brief.分辨率.map(Number)
      : [1080, 1920];
  const platform = brief.平台 ?? "默认";
  const installed = fontsDir ? new Set(scanFonts({ catalog, root: fontsDir }).entries.filter((e) => e.present).map((e) => e.id)) : null;
  const pinned = brief?.账号调性配置?.锁定字体?.[scene] ?? null;
  const results = [];

  if (pinned) {
    const hit = catalog.fonts.find((font) => font.字体名称 === pinned || font.id === pinned);
    if (hit && hit.场景.includes(scene)) {
      results.push({
        id: hit.id,
        name: hit.字体名称,
        fontFamily: hit.font_family,
        fontFullname: hit.font_fullname,
        file: hit.file,
        sha256: hit.sha256,
        license: hit.license,
        score: 999,
        pinned: true,
        installed: installed ? installed.has(hit.id) : null,
        reasons: [`账号调性锁定字体（${platform}）`],
        size: recommendSize({ scene, resolution, font: hit, catalog, platform }),
      });
    }
  }

  for (const font of catalog.fonts) {
    if (pinned && (font.字体名称 === pinned || font.id === pinned)) continue;
    const { score, reasons } = scoreFont(font, brief, scene);
    if (score < 0) continue;
    results.push({
      id: font.id,
      name: font.字体名称,
      fontFamily: font.font_family,
      fontFullname: font.font_fullname,
      file: font.file,
      sha256: font.sha256,
      license: font.license,
      score,
      pinned: false,
      installed: installed ? installed.has(font.id) : null,
      reasons,
      size: recommendSize({ scene, resolution, font, catalog, platform }),
    });
  }
  results.sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
  return {
    scene,
    platform,
    resolution,
    pinned: Boolean(pinned),
    top: results.slice(0, top),
    considered: results.length,
    note: results.length ? null : "该场景/语言下没有可商用候选：请检查档案许可白名单与场景过滤",
  };
}

/** 版式配方检索：题材×场景×平台。 */
export function findRecipes(query = {}, doc = loadRecipes()) {
  const { recipeId = null, genre = null, platform = null, keyword = null, list = false } = query;
  if (list) {
    return {
      total: doc.recipes.length,
      principle: doc.principle,
      targets: doc.targets,
      items: doc.recipes.map((recipe) => ({
        id: recipe.id, genre: recipe.genre, mood: recipe.mood,
        subtitleFont: recipe.subtitleFont, titleFont: recipe.titleFont,
        artMax: recipe.artMax, outlineRatio: recipe.outlineRatio, platforms: recipe.platforms,
      })),
    };
  }
  const matched = doc.recipes.filter((recipe) => {
    if (recipeId && recipe.id !== recipeId) return false;
    if (genre && !`${recipe.genre}${recipe.scene}`.includes(genre)) return false;
    if (platform && !recipe.platforms.includes(platform)) return false;
    if (keyword && !`${recipe.genre}${recipe.scene}${recipe.mood}${recipe.notes}`.includes(keyword)) return false;
    return true;
  });
  const recipe = matched[0] ?? null;
  return {
    total: doc.recipes.length,
    matched: matched.length,
    principle: doc.principle,
    targets: doc.targets,
    recipe,
    items: matched.map((item) => item.id),
    note: recipe ? null : "没有匹配的版式配方：请放宽 genre/platform，或按 targets 走通用安全口径",
  };
}

/* ============================ SRT / ASS ============================ */

const SRT_TIME = /(\d+):(\d+):(\d+)[,.](\d+)/;

export function srtToAssTime(value) {
  const match = SRT_TIME.exec(String(value));
  if (!match) throw new SubtitleError(`SRT 时间格式无法解析：${value}`, "bad_srt", false);
  const [, h, m, s, frac] = match;
  const cs = frac.length === 3 ? Math.floor(Number(frac) / 10) : Number(frac);
  return `${Number(h)}:${String(Number(m)).padStart(2, "0")}:${String(Number(s)).padStart(2, "0")}.${String(cs).padStart(2, "0")}`;
}

export function assistToSeconds(value) {
  const match = /^(\d+):(\d{2}):(\d{2})\.(\d{1,2})$/.exec(String(value));
  if (!match) throw new SubtitleError(`ASS 时间格式无法解析：${value}`, "bad_srt", false);
  const cs = match[4].length === 1 ? Number(match[4]) * 10 : Number(match[4]);
  return Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3]) + cs / 100;
}

export function srtSecondsToAss(seconds) {
  const safe = Math.max(0, Number(seconds) || 0);
  const h = Math.floor(safe / 3600);
  const m = Math.floor((safe % 3600) / 60);
  const s = safe % 60;
  return `${h}:${String(m).padStart(2, "0")}:${s.toFixed(2).padStart(5, "0")}`;
}

/**
 * 解析 SRT：支持 BOM、逗号/点号毫秒、多行文本（行内折行转 ASS 的 \\N）。
 * 非法块显式失败（时间轴是交付契约，不许静默丢条）。
 */
export function parseSrt(text) {
  const content = String(text).replace(/^\uFEFF/, "");
  const blocks = content.split(/\r?\n\s*\r?\n/).map((block) => block.trim()).filter(Boolean);
  const cues = [];
  for (const block of blocks) {
    const lines = block.split(/\r?\n/).filter((line) => line.trim() !== "");
    if (lines.length < 2) continue;
    const timeIndex = lines[0].includes("-->") ? 0 : 1;
    const timeLine = lines[timeIndex];
    if (!timeLine || !timeLine.includes("-->")) {
      throw new SubtitleError(`SRT 块缺少时间轴：${block.slice(0, 60)}`, "bad_srt", false);
    }
    const [startRaw, endRaw] = timeLine.split("-->").map((item) => item.trim());
    const start = srtToAssTime(startRaw);
    const end = srtToAssTime(endRaw);
    const body = lines.slice(timeIndex + 1).join("\\N");
    if (!body.trim()) throw new SubtitleError(`SRT 块缺少文本：${block.slice(0, 60)}`, "bad_srt", false);
    if (assistToSeconds(end) <= assistToSeconds(start)) {
      throw new SubtitleError(`SRT 时间轴非法（结束不晚于开始）：${timeLine}`, "bad_srt", false);
    }
    cues.push({ start, end, text: body });
  }
  if (!cues.length) throw new SubtitleError("SRT 没有可用字幕条", "bad_srt", false);
  return cues;
}

export const ASS_HEADER_FORMAT = "Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text";
export const ASS_STYLE_FORMAT = [
  "Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour,",
  "Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow,",
  "Alignment, MarginL, MarginR, MarginV, Encoding",
].join(" ");

/** ASS 颜色：&HAABBGGRR（本能力只用不透明色，避免透明度语义被误用）。 */
export function assColour(hex) {
  const clean = String(hex).replace("#", "").toUpperCase();
  if (!/^[0-9A-F]{6}$/.test(clean)) throw new SubtitleError(`颜色格式非法：${hex}`, "bad_style", false);
  return `&H00${clean.slice(4, 6)}${clean.slice(2, 4)}${clean.slice(0, 2)}`;
}

export function styleLine(name, style) {
  return [
    `Style: ${name}`,
    style.fontName,
    String(Math.round(style.fontSize)),
    style.primaryColour,
    style.secondaryColour ?? "&H000000FF",
    style.outlineColour,
    style.backColour ?? "&H64000000",
    style.bold ? "1" : "0",
    "0", "0", "0",
    "100", "100",
    String(style.spacing ?? 0),
    "0",
    String(style.borderStyle ?? 1),
    String(style.outline),
    String(style.shadow ?? 1),
    String(style.alignment),
    String(style.marginL ?? 40),
    String(style.marginR ?? 40),
    String(style.marginV ?? 60),
    "1",
  ].join(",");
}

/** 拼 ASS 文档（PlayRes 与实际分辨率一致 + ScaledBorderAndShadow 保证跨分辨率缩放一致）。 */
export function buildAssDocument({ resolution, styles, events }) {
  const [width, height] = resolution;
  const head = [
    "[Script Info]",
    "ScriptType: v4.00+",
    `PlayResX: ${width}`,
    `PlayResY: ${height}`,
    "ScaledBorderAndShadow: yes",
    "WrapStyle: 0",
    "YCbCr Matrix: TV.709",
    "",
    "[V4+ Styles]",
    ASS_STYLE_FORMAT,
    ...styles.map((entry) => styleLine(entry.name, entry.style)),
    "",
    "[Events]",
    ASS_HEADER_FORMAT,
  ];
  const body = events.map((event) => `Dialogue: ${[
    String(event.layer ?? 0),
    event.start,
    event.end,
    event.style,
    event.name ?? "",
    "0", "0", "0",
    event.effect ?? "",
    event.text,
  ].join(",")}`);
  return `${[...head, ...body].join("\n")}\n`;
}

/** 回读 ASS 事件（时间轴复检用：写出去的 ASS 必须能读回来且与源一致）。 */
export function parseAssEvents(assText) {
  const events = [];
  for (const line of String(assText).split("\n")) {
    if (!line.startsWith("Dialogue:")) continue;
    const parts = line.slice("Dialogue:".length).split(",");
    if (parts.length < 10) continue;
    events.push({
      layer: Number(parts[0]),
      start: parts[1],
      end: parts[2],
      style: parts[3],
      text: parts.slice(9).join(",").trim(),
    });
  }
  return events;
}

/* ============================ 版式决策与校验 ============================ */

/** 遮挡区判定：归一化矩形是否与平台 UI 遮挡带相交（字幕压 UI 是硬红线 → G-SUB3）。 */
export function overlapsOcclusion(rect, zones) {
  return (zones ?? []).filter((zone) => {
    const horizontal = rect.x < zone.x + zone.w && zone.x < rect.x + rect.w;
    const vertical = rect.y < zone.y + zone.h && zone.y < rect.y + rect.h;
    return horizontal && vertical;
  });
}

/** 行宽校验：中文按字数、英文按字符数上限（超出即需要拆行或缩字号）。 */
export function checkLineWidth(text, targets) {
  const plain = String(text).replace(/\\N/g, "");
  const han = (plain.match(/\p{Script=Han}/gu) ?? []).length;
  const latin = plain.replace(/\p{Script=Han}/gu, "").replace(/\s/g, "").length;
  return {
    charsHan: han,
    charsLatin: latin,
    maxLineCharsZh: targets.maxLineCharsZh,
    maxLineCharsEn: targets.maxLineCharsEn,
    ok: han <= targets.maxLineCharsZh && latin <= targets.maxLineCharsEn,
    note: han > targets.maxLineCharsZh
      ? `中文 ${han} 字超出单行上限 ${targets.maxLineCharsZh} 字：拆两行或降字号`
      : latin > targets.maxLineCharsEn
        ? `英文 ${latin} 字符超出单行上限 ${targets.maxLineCharsEn}：拆两行`
        : "行宽在口径内",
  };
}

/** 字号体检：落在场景区间内（字幕过小读不清、标题过大压画面）。 */
export function checkFontSize({ scene, sizePx, resolution, targets }) {
  const short = Math.min(resolution[0], resolution[1]);
  const ratio = round(sizePx / short, 4);
  const isSubtitle = scene === "字幕" || scene === "弹幕";
  const min = isSubtitle ? targets.subtitleMinPxRatio : targets.titleMinPxRatio;
  const max = isSubtitle ? targets.subtitleMaxPxRatio : targets.titleMaxPxRatio;
  return {
    scene,
    sizePx,
    shortSide: short,
    ratio,
    minRatio: min,
    maxRatio: max,
    ok: ratio >= min && ratio <= max,
    note: ratio < min
      ? `字号占短边 ${(ratio * 100).toFixed(1)}% 低于下限 ${(min * 100).toFixed(1)}%：需放大`
      : ratio > max
        ? `字号占短边 ${(ratio * 100).toFixed(1)}% 超过上限 ${(max * 100).toFixed(1)}%：需收敛`
        : "字号在口径内",
  };
}

/**
 * 文字配色决策：由实测背景亮度与细节密度决定（不是拍脑袋）。
 * - 亮背景（YAVG/255 ≥ 0.62）→ 深墨字 + 浅描边；
 * - 暗背景（≤ 0.30）→ 浅字 + 深描边；
 * - 细节密集（edgeDensity ≥ 0.28）→ 加半透明底衬（BorderStyle=3）。
 */
export function decideTextStyle({ scene, band, size, targets }) {
  const bgUnit = band?.lumaAvgUnit ?? null;
  const edgeUnit = band?.edgeDensityUnit ?? null;
  const light = bgUnit !== null && bgUnit >= 0.62;
  const dark = bgUnit !== null && bgUnit <= 0.30;
  const busy = edgeUnit !== null && edgeUnit >= 0.28;
  const primaryColour = light ? assColour("#16181D") : assColour("#FFFFFF");
  const outlineColour = light ? assColour("#FFFFFF") : assColour("#000000");
  const inkLuma = light ? 26 : 235;
  const contrast = bgUnit === null ? null : round(Math.abs(bgUnit - inkLuma / 255), 4);
  const minContrast = targets?.minTextBackgroundContrast ?? 0.32;
  // 中间调背景（≈0.6）是最危险的：纯描边对比刚好卡在合格线下，肉眼觉得"还能看"。
  // 因此对比不足时**自动升级为底衬**（50% 黑），并按底衬后的等效背景重算对比。
  const escalated = !busy && contrast !== null && contrast < minContrast;
  const backdrop = busy || escalated;
  const effectiveBgUnit = backdrop && bgUnit !== null ? round(bgUnit * 0.5, 4) : bgUnit;
  const effectiveContrast = effectiveBgUnit === null ? null : round(Math.abs(effectiveBgUnit - inkLuma / 255), 4);
  const baseOutline = Math.max(1, Math.round(size * 0.06));
  const outline = busy ? Math.max(baseOutline + 1, Math.round(size * 0.08)) : baseOutline;
  return {
    primaryColour,
    outlineColour,
    backColour: backdrop ? "&H80000000" : "&H64000000",
    borderStyle: backdrop ? 3 : 1,
    outline,
    shadow: backdrop ? 0 : 1,
    busy,
    escalated,
    contrast,
    effectiveContrast,
    contrastOk: effectiveContrast === null ? null : effectiveContrast >= minContrast,
    decision: [
      bgUnit === null ? "未测到背景亮度（按默认白字黑边）" : `背景亮度 ${(bgUnit * 100).toFixed(1)}%`,
      edgeUnit === null ? "未测到细节密度" : `细节密度 ${(edgeUnit * 100).toFixed(1)}%`,
      busy ? "细节密集 → 加半透明底衬"
        : escalated ? `对比 ${contrast} 低于 ${minContrast} → 自动升级底衬（等效对比 ${effectiveContrast}）`
          : "对比达标 → 纯描边",
    ].join("；"),
  };
}

/* ============================ 素材与画面诊断 ============================ */

/** 默认抽帧时刻：15% / 45% / 75%（避开片头片尾的空镜与黑场偏差）。 */
export function sampleTimes(duration, ratios = [0.15, 0.45, 0.75]) {
  if (!Number.isFinite(duration) || duration <= 0) return [0];
  return ratios.map((ratio) => round(Math.max(0, Math.min(duration - 0.05, duration * ratio)), 2));
}

/** 各场景在画面中的关注带（归一化矩形）：标题带 / 字幕带 / 底部 UI 带。 */
export function textBands({ resolution, layout }) {
  const [width, height] = resolution;
  const titleLayout = layout?.标题 ?? {};
  const subLayout = layout?.字幕 ?? {};
  const titleTop = Number(titleLayout.top_margin_ratio ?? 0.08);
  const subBottom = Number(subLayout.bottom_margin_ratio ?? 0.05);
  return {
    titleBand: {
      x: 0, y: Math.max(0, titleTop - 0.02), w: 1, h: 0.16,
      px: { x: 0, y: Math.round(height * Math.max(0, titleTop - 0.02)), w: width, h: Math.round(height * 0.16) },
    },
    subtitleBand: {
      x: 0, y: Math.max(0, 1 - subBottom - 0.10), w: 1, h: 0.14,
      px: {
        x: 0,
        y: Math.round(height * Math.max(0, 1 - subBottom - 0.10)),
        w: width,
        h: Math.round(height * 0.14),
      },
    },
  };
}

/**
 * 画面可读性诊断：抽帧 → 量化文字带背景（亮度/细节密度）→ 给出文字配色、上抬与底衬建议，
 * 并检查字幕带是否落在平台遮挡区。所有数值取自真实抽帧，不做推断。
 */
export async function analyzeVideo({
  input,
  platform = "默认",
  catalog = loadFontCatalog(),
  bins = resolveBinaries(),
  evidenceDir = null,
  times = null,
  maxFrames = 3,
}) {
  const probe = await probeMedia(input, { bins });
  const { key, layout } = layoutFor(platform, catalog);
  const resolution = [probe.width, probe.height];
  const bands = textBands({ resolution, layout });
  const stamps = (times && times.length ? times : sampleTimes(probe.duration)).slice(0, maxFrames);
  const dir = evidenceDir ?? (await tempDir("workloom-subtitle-analyze-"));
  await fsp.mkdir(dir, { recursive: true });
  const frames = [];
  for (const at of stamps) {
    const file = path.join(dir, `frame-${String(at).replace(".", "_")}.png`);
    await extractFrame({ input, at, output: file, bins });
    const [whole, subtitleBand, titleBand] = await Promise.all([
      regionStats({ input: file, bins }),
      regionStats({ input: file, bins, region: bands.subtitleBand.px }),
      regionStats({ input: file, bins, region: bands.titleBand.px }),
    ]);
    frames.push({ at, file, whole, subtitleBand, titleBand });
  }
  const worstSubtitleBand = frames.reduce((worst, frame) => {
    if (!worst) return frame;
    const current = frame.subtitleBand?.edgeDensityUnit ?? -1;
    const best = worst.subtitleBand?.edgeDensityUnit ?? -1;
    return current > best ? frame : worst;
  }, null);
  const meanSubtitleLuma = frames.length
    ? round(frames.reduce((sum, frame) => sum + (frame.subtitleBand?.lumaAvg ?? 0), 0) / frames.length, 2)
    : null;
  const meanSubtitleLumaUnit = meanSubtitleLuma === null ? null : round(meanSubtitleLuma / 255, 4);
  const zones = layout.occlusion_zones ?? [];
  const subtitleZoneHits = overlapsOcclusion(bands.subtitleBand, zones);
  const titleZoneHits = overlapsOcclusion(bands.titleBand, zones);
  return {
    input,
    platform: key,
    orientation: probe.orientation,
    resolution,
    shortSide: probe.shortSide,
    duration: probe.duration,
    fps: probe.fps,
    hasAudio: probe.hasAudio,
    frames,
    summary: {
      meanSubtitleBandLuma: meanSubtitleLuma,
      meanSubtitleBandLumaUnit: meanSubtitleLumaUnit,
      worstFrameAt: worstSubtitleBand?.at ?? null,
      worstSubtitleEdgeDensityUnit: worstSubtitleBand?.subtitleBand?.edgeDensityUnit ?? null,
      titleBandLumaUnit: frames[0]?.titleBand?.lumaAvgUnit ?? null,
      occlusionZones: zones,
      subtitleBandHitsOcclusion: subtitleZoneHits.map((zone) => zone.id),
      titleBandHitsOcclusion: titleZoneHits.map((zone) => zone.id),
    },
    recommendation: {
      subtitleFontPx: null, // 由 plan/burn 依据选定字体与场景给出（此处不预设字体）
      bandFacts: "字幕带背景越亮/越碎，越需要描边与底衬；遮挡区命中必须在版式里上抬或换边",
      subtitleNeedsLift: subtitleZoneHits.length > 0,
      titleNeedsLift: titleZoneHits.length > 0,
    },
    evidenceDir: dir,
  };
}

/* ============================ 方案（plan） ============================ */

function resolveBrief(params = {}) {
  if (params.brief && typeof params.brief === "object") return params.brief;
  if (params.brief_path) {
    const file = path.resolve(String(params.brief_path));
    if (!fs.existsSync(file)) throw new SubtitleError(`简报文件不存在：${file}`, "not_found", false);
    return JSON.parse(fs.readFileSync(file, "utf8"));
  }
  return {};
}

function resolveCues(params = {}) {
  if (params.srt_text) return parseSrt(String(params.srt_text));
  if (params.srt_path) {
    const file = path.resolve(String(params.srt_path));
    if (!fs.existsSync(file)) throw new SubtitleError(`SRT 文件不存在：${file}`, "not_found", false);
    return parseSrt(fs.readFileSync(file, "utf8"));
  }
  return [];
}

/**
 * 生成字幕方案：字体选型 → 字号/描边/边距 → 平台版式 → ASS 样式与事件 → 版式体检。
 * 只读原片、只写方案产物（ASS + plan.json + 预览帧），**不动成片**。
 */
export async function plan({
  input = null,
  resolution = null,
  duration = null,
  brief = {},
  platform = null,
  titleText = "",
  titleDurationSec = 3,
  cues = [],
  scenes = ["标题", "字幕"],
  catalog = loadFontCatalog(),
  fontsDir = null,
  bins = resolveBinaries(),
  outputDir = null,
  evidenceDir = null,
  analyze = true,
}) {
  fontsDir = fontsDir ?? fontsRoot();
  const probe = input ? await probeMedia(input, { bins }) : null;
  const resolvedPlatform = platform ?? brief.平台 ?? "默认";
  const { key: platformKey, layout } = layoutFor(resolvedPlatform, catalog);
  const targetResolution = resolution ?? (probe ? [probe.width, probe.height] : brief.分辨率 ?? [1080, 1920]);
  const targets = loadRecipes().targets;
  const fonts = scanFonts({ catalog, root: fontsDir });
  const installedIds = new Set(fonts.entries.filter((entry) => entry.present).map((entry) => entry.id));

  const diagnosis = analyze && input ? await analyzeVideo({
    input, platform: resolvedPlatform, catalog, bins, evidenceDir,
  }) : null;

  const selection = {};
  for (const scene of scenes) {
    const picked = selectFonts({ brief, scene, top: 3, catalog, fontsDir, resolution: targetResolution });
    const executable = picked.top.filter((item) => item.installed !== false);
    selection[scene] = {
      ...picked,
      chosen: executable[0] ?? null,
      installedMissing: picked.top.filter((item) => item.installed === false).map((item) => item.file),
      note: executable.length ? null : `候选字体未安装到工位字体目录：${fonts.root}`,
    };
    if (!selection[scene].chosen) {
      throw new SubtitleError(
        `场景「${scene}」没有可用字体（档案候选 ${picked.top.length} 款，工位已装 ${installedIds.size}/${fonts.total} 款）：`
        + `请先运行 kit/install-fonts.sh 安装字体`,
        "font_not_found",
        false,
      );
    }
  }

  const subPick = selection.字幕?.chosen ?? null;
  const titlePick = selection.标题?.chosen ?? null;
  if (!subPick && !titlePick) {
    throw new SubtitleError("方案需要至少一个场景（标题/字幕）的可用字体", "bad_request", false);
  }
  const subBandStats = diagnosis
    ? {
      lumaAvgUnit: diagnosis.summary.meanSubtitleBandLumaUnit,
      edgeDensityUnit: diagnosis.summary.worstSubtitleEdgeDensityUnit,
    }
    : { lumaAvgUnit: null, edgeDensityUnit: null };
  const titleBandStats = diagnosis ? { lumaAvgUnit: diagnosis.summary.titleBandLumaUnit, edgeDensityUnit: null } : { lumaAvgUnit: null, edgeDensityUnit: null };

  const subStyleDecision = subPick
    ? decideTextStyle({ scene: "字幕", band: subBandStats, size: subPick.size.sizePx, targets })
    : null;
  const titleStyleDecision = titlePick
    ? decideTextStyle({ scene: "标题", band: titleBandStats, size: titlePick.size.sizePx, targets })
    : null;

  const subLayout = layout.字幕 ?? {};
  const titleLayout = layout.标题 ?? {};
  const subMarginV = Math.round(targetResolution[1] * Number(subLayout.bottom_margin_ratio ?? 0.05));
  const titleMarginV = Math.round(targetResolution[1] * Number(titleLayout.top_margin_ratio ?? 0.08));

  const styles = [];
  if (subPick) {
    styles.push({
      name: "Sub",
      style: {
        fontName: subPick.fontFullname,
        fontSize: subPick.size.sizePx,
        primaryColour: subStyleDecision.primaryColour,
        outlineColour: subStyleDecision.outlineColour,
        backColour: subStyleDecision.backColour,
        bold: false,
        spacing: 0,
        borderStyle: subStyleDecision.borderStyle,
        outline: subStyleDecision.outline,
        shadow: subStyleDecision.shadow,
        alignment: Number(subLayout.alignment ?? 2),
        marginL: Math.round(targetResolution[0] * 0.05),
        marginR: Math.round(targetResolution[0] * 0.05),
        marginV: subMarginV,
      },
    });
  }
  if (titlePick) {
    styles.push({
      name: "Title",
      style: {
        fontName: titlePick.fontFullname,
        fontSize: titlePick.size.sizePx,
        primaryColour: titleStyleDecision.primaryColour,
        outlineColour: titleStyleDecision.outlineColour,
        backColour: titleStyleDecision.backColour,
        bold: true,
        spacing: 1,
        borderStyle: titleStyleDecision.borderStyle,
        outline: titleStyleDecision.outline,
        shadow: titleStyleDecision.shadow,
        alignment: Number(titleLayout.alignment ?? 8),
        marginL: Math.round(targetResolution[0] * 0.05),
        marginR: Math.round(targetResolution[0] * 0.05),
        marginV: titleMarginV,
      },
    });
  }

  const events = [];
  if (titleText && titlePick) {
    events.push({
      layer: 1,
      start: srtSecondsToAss(0),
      end: srtSecondsToAss(Number(titleDurationSec) || 3),
      style: "Title",
      name: titlePick.id,
      text: String(titleText),
    });
  }
  for (const cue of cues) {
    if (!subPick) throw new SubtitleError("提供了字幕条但没有可用的字幕字体", "font_not_found", false);
    events.push({ layer: 0, start: cue.start, end: cue.end, style: "Sub", name: subPick.id, text: cue.text });
  }

  const assText = buildAssDocument({ resolution: targetResolution, styles, events });
  const dir = outputDir ?? (await tempDir("workloom-subtitle-plan-"));
  await fsp.mkdir(dir, { recursive: true });
  const assPath = path.join(dir, "subtitle-plan.ass");
  await fsp.writeFile(assPath, assText, "utf8");

  const checks = [];
  if (cues.length) {
    const widths = cues.map((cue) => checkLineWidth(cue.text, targets));
    const worst = widths.find((item) => !item.ok) ?? widths[0];
    checks.push({ kind: "line_width", ok: widths.every((item) => item.ok), detail: worst });
    checks.push({
      kind: "cue_count",
      ok: true,
      detail: { cues: cues.length, first: cues[0].start, last: cues[cues.length - 1].end },
    });
  }
  if (subPick) {
    checks.push({ kind: "subtitle_size", ...checkFontSize({ scene: "字幕", sizePx: subPick.size.sizePx, resolution: targetResolution, targets }) });
  }
  if (titleText && titlePick) {
    checks.push({ kind: "title_size", ...checkFontSize({ scene: "标题", sizePx: titlePick.size.sizePx, resolution: targetResolution, targets }) });
    checks.push({ kind: "title_line_width", ...checkLineWidth(titleText, targets) });
  }
  if (subStyleDecision) {
    checks.push({
      kind: "contrast",
      ok: subStyleDecision.contrastOk !== false,
      detail: { contrast: subStyleDecision.contrast, decision: subStyleDecision.decision },
    });
  }
  /**
   * 文字实测占位：把首条字幕（或标题）单独渲染成黑底一帧，用 cropdetect 量外接框。
   * 这是"实测"而不是"按字号推断"——超宽/越界在这里就会被发现。
   */
  let inkExtent = null;
  let inkZoneHits = [];
  let flatFonts = null;
  const sampleText = cues[0]?.text ?? (titleText || "");
  if (sampleText) {
    const sampleStyle = cues[0]
      ? styles.find((entry) => entry.name === "Sub")
      : styles.find((entry) => entry.name === "Title");
    if (!sampleStyle) throw new SubtitleError("方案缺少可测样式（Sub/Title）", "bad_style", false);
    const sampleDoc = buildAssDocument({
      resolution: targetResolution,
      styles: [sampleStyle],
      events: [{
        layer: 0,
        start: srtSecondsToAss(0),
        end: srtSecondsToAss(1),
        style: sampleStyle.name,
        name: "measure",
        text: sampleText,
      }],
    });
    const samplePath = path.join(dir, "measure-sample.ass");
    await fsp.writeFile(samplePath, sampleDoc, "utf8");
    flatFonts = prepareFlatFontsDir({ fontsDir, catalog, workDir: dir });
    inkExtent = await measureInkExtent({ assPath: samplePath, fontsDir: flatFonts.flat, resolution: targetResolution, bins });
    const leftGap = inkExtent.detected ? inkExtent.inkX / targetResolution[0] : null;
    const rightGap = inkExtent.detected ? (targetResolution[0] - (inkExtent.inkX + inkExtent.inkWidth)) / targetResolution[0] : null;
    checks.push({
      kind: "ink_extent",
      ok: inkExtent.detected
        ? leftGap >= targets.safeAreaMarginRatio * 0.5 && rightGap >= targets.safeAreaMarginRatio * 0.5
        : false,
      detail: { ...inkExtent, leftGap: leftGap === null ? null : round(leftGap, 4), rightGap: rightGap === null ? null : round(rightGap, 4) },
    });
    checks.push({
      kind: "font_resolution",
      ok: inkExtent.fontResolvedFromFontsDir === true,
      detail: {
        basis: "libass fontselect 日志：确认字确实从工位字体目录取到（避免静默回落系统字体）",
        fromFontsDir: inkExtent.fontResolvedFromFontsDir,
        fallbackFamilies: inkExtent.fontFallbackFamilies,
        selections: inkExtent.fontSelections,
        flatFontsDir: flatFonts.flat,
        fontsLinked: flatFonts.linked,
        fontsMissing: flatFonts.missing,
      },
    });
    if (diagnosis) {
      const zones = diagnosis.summary.occlusionZones ?? [];
      const inkRect = inkExtent.detected
        ? {
          x: round(inkExtent.inkX / targetResolution[0], 4),
          y: round(inkExtent.inkY / targetResolution[1], 4),
          w: round(inkExtent.inkWidth / targetResolution[0], 4),
          h: round(inkExtent.inkHeight / targetResolution[1], 4),
        }
        : null;
      inkZoneHits = inkRect ? overlapsOcclusion(inkRect, zones) : [];
      checks.push({
        kind: "safe_area",
        ok: inkRect !== null && inkZoneHits.length === 0,
        detail: {
          platform: platformKey,
          basis: "实测墨迹外接框（cropdetect）× 平台遮挡区求交",
          inkRect,
          hits: inkZoneHits.map((zone) => zone.id),
          zones,
          advisoryBandHits: diagnosis.summary.subtitleBandHitsOcclusion,
        },
      });
    }
  }

  const planDoc = {
    schemaVersion: "workloom.subtitle-plan/v1",
    createdAt: new Date().toISOString(),
    input,
    resolution: targetResolution,
    platform: platformKey,
    brief,
    diagnosis: diagnosis
      ? { summary: diagnosis.summary, evidenceDir: diagnosis.evidenceDir, frames: diagnosis.frames.map((frame) => ({ at: frame.at, file: frame.file })) }
      : null,
    selection,
    styles: styles.map((entry) => ({ name: entry.name, ...entry.style })),
    events: events.length,
    cues: cues.length,
    assPath,
    assSha256: await sha256File(assPath),
    checks,
    fonts: { root: fonts.root, installed: fonts.installed, total: fonts.total },
  };
  const planPath = path.join(dir, "subtitle-plan.json");
  await fsp.writeFile(planPath, `${JSON.stringify(planDoc, null, 2)}\n`, "utf8");
  return { plan: planDoc, planPath, assPath, assText, checks, styles, events, cues, fonts, diagnosis, targets };
}

/** 版式体检汇总：全部 checks 通过才算达标（交付硬口径）。 */
export function checksPass(checks) {
  return (checks ?? []).every((check) => check.ok !== false);
}

export function checkSummary(checks) {
  return (checks ?? []).map((check) => ({
    kind: check.kind,
    ok: check.ok !== false,
    detail: check.detail ?? check.note ?? null,
  }));
}

export function jobsDir(env = process.env) {
  return env.WORKLOOM_SUBTITLE_JOBS_DIR || path.join(os.homedir(), ".workloom-subtitle", "jobs");
}

export async function jobAppend(dir, record) {
  await fsp.mkdir(dir, { recursive: true });
  const file = path.join(dir, "jobs.jsonl");
  await fsp.appendFile(file, `${JSON.stringify({ at: new Date().toISOString(), ...record })}\n`, "utf8");
  return file;
}

export const FONT_SOURCE = {
  catalog: CATALOG_FILE,
  recipes: RECIPE_FILE,
};

/* ============================ 烧录与复检 ============================ */

/**
 * 字幕/标题烧录：方案（plan）→ ffmpeg libass 烧录 → 复检（时间轴回读 / 字幕可现度 / 安全区 / 哈希）。
 * mode: subtitle（只需 SRT）| title（只需标题）| both。
 *
 * 复检硬线（不达标即失败并删除产物，do-no-harm）：
 * - 时间轴回读：写出的 ASS 事件与源 SRT 逐条一致（条数 + 起止时间）；
 * - 字幕可现度：字幕带在"加字前后"的边缘能量/亮度必须有可测增量（配了跟没配一样 → 拒绝交付）；
 * - 版式体检：字号 / 行宽 / 安全区 / 对比度全部通过。
 */
export async function renderWithSubtitles({
  mode = "subtitle",
  input,
  output,
  cues = [],
  titleText = "",
  titleDurationSec = 3,
  brief = {},
  platform = null,
  fontsDir = null,
  evidenceDir = null,
  bins = resolveBinaries(),
  catalog = loadFontCatalog(),
  styleOverrides = {},
  skipVerify = false,
  presenceMinDelta = 0.004,
}) {
  fontsDir = fontsDir ?? fontsRoot();
  if (typeof input !== "string" || !input.trim()) throw new SubtitleError("input_path 缺失", "bad_request");
  if (typeof output !== "string" || !output.trim()) throw new SubtitleError("output_path 缺失", "bad_request");
  if (path.resolve(input) === path.resolve(output)) {
    throw new SubtitleError("禁止覆盖原片（输出路径等于输入路径）", "overwrite_source_forbidden", false);
  }
  if (skipVerify) {
    throw new SubtitleError("字幕交付必须带版式复检（关闭校验的调用禁止执行，围栏 G-SUB3）", "bad_request", false);
  }
  if (mode === "subtitle" && cues.length === 0) throw new SubtitleError("字幕烧录需要 SRT 字幕条", "bad_request", false);
  if (mode === "title" && !titleText) throw new SubtitleError("标题烧录需要 title_text", "bad_request", false);

  const started = Date.now();
  const scenes = mode === "title" ? ["标题"] : mode === "subtitle" ? ["字幕"] : ["标题", "字幕"];
  const planOutcome = await plan({
    input,
    brief,
    platform,
    titleText: mode === "subtitle" ? "" : titleText,
    titleDurationSec,
    cues: mode === "title" ? [] : cues,
    scenes,
    catalog,
    fontsDir,
    bins,
    evidenceDir,
  });
  let { styles } = planOutcome;
  if (styleOverrides && Object.keys(styleOverrides).length) {
    styles = styles.map((entry) => {
      const override = styleOverrides[entry.name];
      return override ? { name: entry.name, style: { ...entry.style, ...override } } : entry;
    });
    const assText = buildAssDocument({ resolution: planOutcome.plan.resolution, styles, events: planOutcome.events });
    await fsp.writeFile(planOutcome.assPath, assText, "utf8");
    planOutcome.assText = assText;
  }

  const encoder = await pickVideoEncoder({ bins });
  const probe = await probeMedia(input, { bins });
  // 渲染用扁平字体目录：libass 不递归 cn/ en/ 子目录，直接给根目录会静默回落系统字体
  const renderWorkDir = await tempDir("workloom-subtitle-render-");
  const flatFonts = prepareFlatFontsDir({ fontsDir, catalog, workDir: renderWorkDir });
  if (flatFonts.missing.length) {
    throw new SubtitleError(
      `工位字体缺失 ${flatFonts.missing.length} 款（如 ${flatFonts.missing[0]}）：请先运行 kit/install-fonts.sh`,
      "font_not_found",
      false,
    );
  }
  const filter = `ass=${escapeFilterPath(planOutcome.assPath)}:fontsdir=${escapeFilterPath(flatFonts.flat)},format=yuv420p`;
  const args = ["-hide_banner", "-v", "info", "-y", "-i", input, "-map", "0:v:0"];
  if (probe.hasAudio) args.push("-map", "0:a:0", "-c:a", "copy");
  args.push("-vf", filter, ...encoder.args, "-movflags", "+faststart", output);
  const burnLog = (await runBin(bins.ffmpeg, args, { label: "ffmpeg" })).stderr;
  if (!fs.existsSync(output)) throw new SubtitleError(`烧录未产出文件：${output}`, "ffmpeg_failed", true);
  const fontResolution = parseFontSelections(burnLog, flatFonts.flat);

  const outputProbe = await probeMedia(output, { bins });
  const outputHash = await sha256File(output);
  const assEvents = parseAssEvents(planOutcome.assText);
  const subEvents = assEvents.filter((event) => event.style === "Sub");
  const titleEvents = assEvents.filter((event) => event.style === "Title");

  // ① 时间轴回读：写出的 ASS 必须与源字幕逐条一致
  const timelineOk = mode === "title"
    ? titleEvents.length === (titleText ? 1 : 0)
    : subEvents.length === cues.length
      && subEvents.every((event, index) => event.start === cues[index].start && event.end === cues[index].end);

  // ② 字幕可现度：字幕带在加字前后必须有可测增量（抽帧实测，不做推断）
  const { layout } = layoutFor(platform ?? brief.平台 ?? "默认", catalog);
  const resolution = [outputProbe.width, outputProbe.height];
  const bands = textBands({ resolution, layout });
  const sampleCue = mode === "title" ? null : cues[Math.min(1, cues.length - 1)];
  const sampleAt = mode === "title"
    ? round(Math.min(1.2, Number(titleDurationSec) / 2), 2)
    : round((assistToSeconds(sampleCue.start) + Math.min(0.6, (assistToSeconds(sampleCue.end) - assistToSeconds(sampleCue.start)) / 2)), 2);
  const band = mode === "title" ? bands.titleBand.px : bands.subtitleBand.px;
  const workDir = await tempDir("workloom-subtitle-verify-");
  const beforeFrame = path.join(workDir, "before.png");
  const afterFrame = path.join(workDir, "after.png");
  await extractFrame({ input, at: sampleAt, output: beforeFrame, bins });
  await extractFrame({ input: output, at: sampleAt, output: afterFrame, bins });
  const [beforeStats, afterStats] = await Promise.all([
    regionStats({ input: beforeFrame, bins, region: band }),
    regionStats({ input: afterFrame, bins, region: band }),
  ]);
  const edgeDelta = round((afterStats.edgeDensityUnit ?? 0) - (beforeStats.edgeDensityUnit ?? 0), 4);
  const lumaDelta = round((afterStats.lumaAvgUnit ?? 0) - (beforeStats.lumaAvgUnit ?? 0), 4);
  const presenceDelta = round(Math.max(edgeDelta, Math.abs(lumaDelta)), 4);
  const presenceOk = presenceDelta >= presenceMinDelta;

  const checks = checkSummary(planOutcome.checks);
  const layoutOk = checks.every((check) => check.ok);
  const evidence = [];
  const dir = evidenceDir ?? workDir;
  await fsp.mkdir(dir, { recursive: true });
  const stamps = mode === "title"
    ? [0.6, Math.min(2.5, Number(titleDurationSec))]
    : [...new Set([cues[0], cues[Math.floor(cues.length / 2)], cues[cues.length - 1]].filter(Boolean).map((cue) => (
      round((assistToSeconds(cue.start) + assistToSeconds(cue.end)) / 2, 2)
    )))];
  for (const at of stamps) {
    // 证据帧按「产物名」打前缀：同一批次里 burn 与 best 各自出片时证据不互相覆盖，
    // 每张证据都能对回它证明的那支成片（traceability 不能靠文件名撞运气）。
    const label = path.basename(output, path.extname(output)).replace(/[^\w.-]/g, "_");
    const file = path.join(dir, `evidence-${label}-${String(at).replace(".", "_")}.png`);
    await extractFrame({ input: output, at, output: file, bins });
    evidence.push({ at, file, sha256: await sha256File(file) });
  }

  const report = {
    schemaVersion: "workloom.subtitle-report/v1",
    mode,
    input,
    output: { path: output, hash: outputHash, bytes: fs.statSync(output).size },
    encoder: encoder.name,
    elapsedMs: Date.now() - started,
    duration: { input: probe.duration, output: outputProbe.duration },
    resolution,
    platform: planOutcome.plan.platform,
    firstCue: mode === "title"
      ? { start: srtSecondsToAss(0), end: srtSecondsToAss(Number(titleDurationSec) || 3), text: titleText }
      : cues[0],
    styles: styles.map((entry) => ({ name: entry.name, ...entry.style })),
    fonts: Object.fromEntries(Object.entries(planOutcome.plan.selection).map(([scene, entry]) => [scene, {
      id: entry.chosen?.id ?? null,
      name: entry.chosen?.name ?? null,
      file: entry.chosen?.file ?? null,
      license: entry.chosen?.license ?? null,
      sha256: entry.chosen?.sha256 ?? null,
      score: entry.chosen?.score ?? null,
      reasons: entry.chosen?.reasons ?? [],
    }])),
    layoutChecks: checks,
    timeline: {
      ok: timelineOk,
      cues: subEvents.length,
      titleEvents: titleEvents.length,
      sourceCues: cues.length,
      first: subEvents[0] ?? null,
      last: subEvents[subEvents.length - 1] ?? null,
    },
    presence: {
      at: sampleAt,
      edgeDelta,
      lumaDelta,
      delta: presenceDelta,
      threshold: presenceMinDelta,
      ok: presenceOk,
      before: beforeStats,
      after: afterStats,
    },
    fontResolution: {
      basis: "libass fontselect 日志（真实渲染调用）",
      fontsDir: flatFonts.flat,
      fontsLinked: flatFonts.linked,
      allFromFontsDir: fontResolution.allFromFontsDir,
      fallbackFamilies: fontResolution.fallbackFamilies,
      selections: fontResolution.selections,
    },
    evidence,
    assPath: planOutcome.assPath,
    planPath: planOutcome.planPath,
    diagnosis: planOutcome.diagnosis
      ? { summary: planOutcome.diagnosis.summary, evidenceDir: planOutcome.diagnosis.evidenceDir }
      : null,
  };
  report.checks = {
    timeline_ok: timelineOk,
    presence_ok: presenceOk,
    layout_ok: layoutOk,
    font_resolved_from_fonts_dir: fontResolution.allFromFontsDir !== false,
    resolution_preserved: outputProbe.width === probe.width && outputProbe.height === probe.height,
    audio_preserved: outputProbe.hasAudio === probe.hasAudio,
    evidence_frames: evidence.length > 0,
  };

  if (!Object.values(report.checks).every(Boolean)) {
    const failed = Object.entries(report.checks).filter(([, ok]) => !ok).map(([key]) => key);
    if (typeof fsp.rm === "function") await fsp.rm(output, { force: true });
    else fs.unlinkSync(output);
    throw new SubtitleError(
      `字幕复检未通过（${failed.join("/")}）：产物已删除，不进入入库/发布队列`,
      "verify_failed",
      false,
    );
  }
  return report;
}

/** 标题/花字轨（title_text 必填；可选同时烧字幕）。 */
export async function renderTitle(options) {
  return renderWithSubtitles({ ...options, mode: options.cues?.length ? "both" : "title" });
}

/* ============================ 择优出片 ============================ */

/**
 * 择优：候选（字体 × 描边策略）各渲染一帧 → 实测打分（选型分 + 可读性）→ 赢家出正式成片。
 * 允许结论是「无需加字幕」（显式已有硬字幕 / 没有字幕内容）——不产出文件，do no harm。
 */
export async function best({
  input,
  output = null,
  cues = [],
  titleText = "",
  brief = {},
  platform = null,
  fontsDir = null,
  evidenceDir = null,
  bins = resolveBinaries(),
  catalog = loadCatalog(),
  minScore = 80,
  hasBurnedInSubtitles = false,
  candidates = 3,
}) {
  fontsDir = fontsDir ?? fontsRoot();
  if (path.resolve(input) === path.resolve(output ?? input)) {
    throw new SubtitleError("禁止覆盖原片（输出路径等于输入路径）", "overwrite_source_forbidden", false);
  }
  if (hasBurnedInSubtitles) {
    return {
      verdict: "no_change_needed",
      reason: "素材已带硬字幕：再烧一层会造成重影与双字幕，需先拿到无字幕母版（do no harm）",
      input,
    };
  }
  if (cues.length === 0 && !titleText) {
    return { verdict: "no_change_needed", reason: "没有字幕内容与标题文本：无字幕需求时不产出文件", input };
  }
  const probe = await probeMedia(input, { bins });
  const platformKey = platform ?? brief.平台 ?? "默认";
  const { layout, key } = layoutFor(platformKey, catalog);
  const resolution = [probe.width, probe.height];
  const bands = textBands({ resolution, layout });
  const targets = loadRecipes().targets;
  const sampleCue = cues.length ? cues[Math.min(1, cues.length - 1)] : null;
  const sampleAt = sampleCue
    ? round((assistToSeconds(sampleCue.start) + assistToSeconds(sampleCue.end)) / 2, 2)
    : round(Math.min(1.2, Number(brief.标题时长 ?? 2) / 2 || 1.2), 2);
  const sampleText = sampleCue?.text ?? titleText;
  const band = sampleCue ? bands.subtitleBand.px : bands.titleBand.px;
  const scene = sampleCue ? "字幕" : "标题";

  const picks = selectFonts({
    brief: { ...brief, 平台: platformKey }, scene, top: candidates, catalog, fontsDir, resolution,
  }).top
    .filter((item) => item.installed !== false);
  if (!picks.length) {
    throw new SubtitleError(`择优失败：场景「${scene}」没有可用字体（请先安装字体）`, "font_not_found", false);
  }
  const workDir = await tempDir("workloom-subtitle-best-");
  const flatFonts = prepareFlatFontsDir({ fontsDir, catalog, workDir });
  const scoring = [];
  for (const pick of picks) {
    const decision = decideTextStyle({ scene, band: { lumaAvgUnit: null, edgeDensityUnit: null }, size: pick.size.sizePx, targets });
    for (const variant of [{ id: "outline", borderStyle: 1, outline: pick.size.outlinePx }, { id: "backdrop", borderStyle: 3, outline: pick.size.outlinePx }]) {
      const style = {
        fontName: pick.fontFullname,
        fontSize: pick.size.sizePx,
        primaryColour: decision.primaryColour,
        outlineColour: decision.outlineColour,
        backColour: variant.id === "backdrop" ? "&H80000000" : "&H64000000",
        bold: scene === "标题",
        spacing: 0,
        borderStyle: variant.borderStyle,
        outline: variant.outline,
        shadow: variant.borderStyle === 3 ? 0 : 1,
        alignment: scene === "标题" ? Number(layout.标题?.alignment ?? 8) : Number(layout.字幕?.alignment ?? 2),
        marginL: Math.round(resolution[0] * 0.05),
        marginR: Math.round(resolution[0] * 0.05),
        marginV: scene === "标题"
          ? Math.round(resolution[1] * Number(layout.标题?.top_margin_ratio ?? 0.08))
          : Math.round(resolution[1] * Number(layout.字幕?.bottom_margin_ratio ?? 0.05)),
      };
      const assText = buildAssDocument({
        resolution,
        styles: [{ name: "Sub", style }],
        events: [{ layer: 0, start: srtSecondsToAss(0), end: srtSecondsToAss(1), style: "Sub", name: pick.id, text: sampleText }],
      });
      const assPath = path.join(workDir, `candidate-${pick.id}-${variant.id}.ass`);
      await fsp.writeFile(assPath, assText, "utf8");
      const frame = path.join(workDir, `candidate-${pick.id}-${variant.id}.png`);
      await runBin(bins.ffmpeg, [
        "-hide_banner", "-v", "error", "-y", "-ss", String(sampleAt), "-i", input,
        "-vf", `ass=${escapeFilterPath(assPath)}:fontsdir=${escapeFilterPath(flatFonts.flat)}`,
        "-frames:v", "1", frame,
      ], { label: "ffmpeg" });
      const stats = await regionStats({ input: frame, bins, region: band });
      const inkLuma = decision.primaryColour === assColour("#FFFFFF") ? 235 : 26;
      const contrast = stats.lumaAvgUnit === null ? 0 : round(Math.abs(stats.lumaAvgUnit - inkLuma / 255), 4);
      const busyPenalty = stats.edgeDensityUnit === null ? 0 : round(Math.min(stats.edgeDensityUnit, 0.5) * 40, 2);
      const ruleScore = pick.score >= 999 ? 100 : pick.score;             // 锁定字体按满分计入
      const composite = round(Math.max(0, 0.6 * Math.min(ruleScore, 100) + 0.4 * (contrast * 100) - busyPenalty * (variant.id === "outline" ? 1 : 0.4)), 2);
      scoring.push({
        fontId: pick.id,
        fontName: pick.name,
        variant: variant.id,
        ruleScore: pick.score,
        contrast,
        edgeDensityUnit: stats.edgeDensityUnit,
        lumaAvgUnit: stats.lumaAvgUnit,
        composite,
        frame,
        style,
      });
    }
  }
  scoring.sort((a, b) => b.composite - a.composite);
  const winner = scoring[0];

  if (winner.composite < minScore && !output) {
    return {
      verdict: "no_change_needed",
      reason: `全部候选得分低于阈值 ${minScore}（最佳 ${winner.composite}：${winner.fontName}/${winner.variant}），不做低质交付`,
      candidates: scoring,
      evidenceDir: workDir,
    };
  }
  const report = await renderWithSubtitles({
    mode: cues.length && titleText ? "both" : cues.length ? "subtitle" : "title",
    input,
    output,
    cues,
    titleText,
    brief: { ...brief, 平台: platformKey },
    platform: platformKey,
    fontsDir,
    evidenceDir,
    bins,
    catalog,
    styleOverrides: { [cues.length ? "Sub" : "Title"]: winner.style },
  });
  return {
    verdict: "scored",
    minScore,
    winner: { fontId: winner.fontId, fontName: winner.fontName, variant: winner.variant, score: winner.composite },
    candidates: scoring.map((item) => ({ ...item, frame: item.frame })),
    report,
    output: { path: report.output.path, sha256: report.output.hash },
    sha256: report.output.hash,
    platform: key,
  };
}

function loadCatalog() {
  // 显式包一层，避免默认参数在导入期就触发磁盘读取（测试可预置档案）
  return loadFontCatalog();
}

/* ============================ 健康探针 ============================ */

export async function health({ catalog = loadFontCatalog(), bins = resolveBinaries(), env = process.env } = {}) {
  const ffmpeg = await binaryVersion(bins.ffmpeg);
  const ffprobe = await binaryVersion(bins.ffprobe);
  let capabilities = null;
  let capabilityError = null;
  try {
    capabilities = await detectRenderCapabilities({ bins });
  } catch (error) {
    capabilityError = error instanceof Error ? error.message : String(error);
  }
  const fonts = scanFonts({ catalog, root: fontsRoot(env) });
  let encoder = null;
  try {
    encoder = (await pickVideoEncoder({ bins })).name;
  } catch {
    encoder = null;
  }
  const recipes = loadRecipes();
  return {
    ok: Boolean(ffmpeg && ffprobe && capabilities?.ass),
    ffmpeg,
    ffprobe,
    renderCapabilities: capabilities,
    renderCapabilityError: capabilityError,
    videoEncoder: encoder,
    tools: SUBTITLE_TOOLS,
    fonts: {
      root: fonts.root,
      catalog: path.basename(CATALOG_FILE),
      catalogVersion: catalog.version,
      total: fonts.total,
      installed: fonts.installed,
      missing: fonts.missing,
    },
    recipes: recipes.recipes.length,
    platforms: Object.entries(catalog.layout_policy ?? {})
      .filter(([key, value]) => !key.startsWith("_") && value && typeof value === "object" && "画幅" in value)
      .map(([key]) => key),
    scenes: FONT_SCENES,
    licenseWhitelist: catalog.licensePolicy?.commercialWhitelist ?? [],
    allowedRoots: allowedRoots(env),
  };
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

/* ============================ 工具分发 ============================ */

export async function callTool(name, params = {}, { bins = resolveBinaries(), env = process.env } = {}) {
  if (!isSubtitleTool(name)) {
    throw new SubtitleError(`字幕工位不提供工具 ${name}`, "not_provided");
  }
  const roots = allowedRoots(env);
  const text = (value, label) => {
    if (typeof value !== "string" || !value.trim()) throw new SubtitleError(`${label} 缺失`, "bad_request");
    return value;
  };
  const optionalNumber = (value) => (value === undefined || value === null || value === "" ? null : Number(value));
  const optionalPath = (value, label) => (value ? assertPathAllowed(String(value), roots, label) : null);
  const catalog = loadFontCatalog();
  const fontRoot = fontsRoot(env);

  switch (name) {
    case "subtitleread.health":
      return {
        result: await health({ catalog, bins, env }),
        receipt: { synced: true, verified_at: new Date().toISOString() },
      };

    case "subtitleread.probe": {
      const input = assertPathAllowed(text(params.input_path, "input_path"), roots, "input_path");
      const probe = await probeMedia(input, { bins });
      return { result: probe, receipt: { synced: true, sha256: await sha256File(input), verified_at: new Date().toISOString() } };
    }

    case "subtitleread.analyze": {
      const input = assertPathAllowed(text(params.input_path, "input_path"), roots, "input_path");
      const evidenceDir = optionalPath(params.evidence_dir, "evidence_dir");
      const report = await analyzeVideo({
        input,
        platform: params.platform ?? "默认",
        catalog,
        bins,
        evidenceDir,
        times: Array.isArray(params.times) ? params.times.map(Number).filter(Number.isFinite) : null,
        maxFrames: optionalNumber(params.max_frames) ?? 3,
      });
      return { result: report, receipt: { synced: true, sha256: await sha256File(input), verified_at: new Date().toISOString() } };
    }

    case "subtitleread.fonts": {
      const brief = resolveBrief(params);
      const scene = params.scene ?? "字幕";
      const selection = selectFonts({
        brief,
        scene,
        top: optionalNumber(params.top) ?? 3,
        catalog,
        fontsDir: params.fonts_dir ? assertPathAllowed(String(params.fonts_dir), roots, "fonts_dir") : fontRoot,
        resolution: Array.isArray(params.resolution) && params.resolution.length === 2 ? params.resolution.map(Number) : null,
      });
      return {
        result: {
          ...selection,
          weights: WEIGHTS,
          scenePreferences: SCENE_WEIGHT_PREF,
          moodPreferences: MOOD_ART_PREF,
          catalog: { version: catalog.version, fonts: catalog.fonts.length, licenseWhitelist: catalog.licensePolicy?.commercialWhitelist ?? [] },
        },
        receipt: {
          synced: true,
          snapshot_uri: `subtitle://fonts/${scene}/${selection.top[0]?.id ?? "none"}`,
          verified_at: new Date().toISOString(),
        },
      };
    }

    case "subtitleread.recipes": {
      const result = findRecipes({
        recipeId: params.recipe_id ?? null,
        genre: params.genre ?? null,
        platform: params.platform ?? null,
        keyword: params.keyword ?? null,
        list: params.list === true || (!params.recipe_id && !params.genre && !params.platform && !params.keyword),
      });
      return {
        result,
        receipt: {
          synced: true,
          snapshot_uri: `subtitle://recipes/${params.recipe_id ?? "list"}`,
          verified_at: new Date().toISOString(),
        },
      };
    }

    case "subtitlewrite.plan": {
      const input = params.input_path ? assertPathAllowed(String(params.input_path), roots, "input_path") : null;
      const outputDir = params.output_dir
        ? assertPathAllowed(String(params.output_dir), roots, "output_dir")
        : await tempDir("workloom-subtitle-plan-");
      const evidenceDir = optionalPath(params.evidence_dir, "evidence_dir");
      const cues = resolveCues(params);
      const resolution = Array.isArray(params.resolution) && params.resolution.length === 2
        ? params.resolution.map(Number)
        : null;
      const outcome = await plan({
        input,
        resolution,
        duration: optionalNumber(params.duration_seconds),
        brief: resolveBrief(params),
        platform: params.platform ?? null,
        titleText: params.title_text ?? "",
        titleDurationSec: optionalNumber(params.title_duration_sec) ?? 3,
        cues,
        scenes: Array.isArray(params.scenes) && params.scenes.length ? params.scenes.map(String) : ["标题", "字幕"],
        catalog,
        fontsDir: params.fonts_dir ? assertPathAllowed(String(params.fonts_dir), roots, "fonts_dir") : fontRoot,
        bins,
        outputDir,
        evidenceDir,
      });
      return {
        result: {
          plan: outcome.plan,
          planPath: outcome.planPath,
          assPath: outcome.assPath,
          checks: checkSummary(outcome.checks),
          ass: outcome.assText,
        },
        receipt: {
          synced: true,
          snapshot_uri: `subtitle://plan/${path.basename(outcome.assPath)}?sha256=${outcome.plan.assSha256}`,
          sha256: outcome.plan.assSha256,
          verified_at: new Date().toISOString(),
        },
      };
    }

    case "subtitlewrite.burn": {
      const input = assertPathAllowed(text(params.input_path, "input_path"), roots, "input_path");
      const output = assertPathAllowed(text(params.output_path, "output_path"), roots, "output_path");
      if (params.skip_verify === true || params.verify === false) {
        throw new SubtitleError("字幕交付必须带版式复检（G-SUB3）", "bad_request", false);
      }
      const report = await renderWithSubtitles({
        mode: params.title_text ? "both" : "subtitle",
        input,
        output,
        cues: resolveCues(params),
        titleText: params.title_text ?? "",
        titleDurationSec: optionalNumber(params.title_duration_sec) ?? 3,
        brief: resolveBrief(params),
        platform: params.platform ?? null,
        fontsDir: params.fonts_dir ? assertPathAllowed(String(params.fonts_dir), roots, "fonts_dir") : fontRoot,
        evidenceDir: optionalPath(params.evidence_dir, "evidence_dir"),
        bins,
        catalog,
        styleOverrides: params.style_overrides ?? {},
      });
      return {
        result: {
          ...report,
          output_path: report.output.path,
          sha256: report.output.hash,
        },
        receipt: {
          synced: true,
          snapshot_uri: `subtitle://burn/${path.basename(report.output.path)}?sha256=${report.output.hash}`,
          sha256: report.output.hash,
          verified_at: new Date().toISOString(),
        },
      };
    }

    case "subtitlewrite.title": {
      const input = assertPathAllowed(text(params.input_path, "input_path"), roots, "input_path");
      const output = assertPathAllowed(text(params.output_path, "output_path"), roots, "output_path");
      if (params.skip_verify === true || params.verify === false) {
        throw new SubtitleError("标题交付必须带版式复检（G-SUB3）", "bad_request", false);
      }
      const report = await renderTitle({
        input,
        output,
        cues: resolveCues(params),
        titleText: text(params.title_text, "title_text"),
        titleDurationSec: optionalNumber(params.title_duration_sec) ?? 3,
        brief: resolveBrief(params),
        platform: params.platform ?? null,
        fontsDir: params.fonts_dir ? assertPathAllowed(String(params.fonts_dir), roots, "fonts_dir") : fontRoot,
        evidenceDir: optionalPath(params.evidence_dir, "evidence_dir"),
        bins,
        catalog,
        styleOverrides: params.style_overrides ?? {},
      });
      return {
        result: { ...report, output_path: report.output.path, sha256: report.output.hash },
        receipt: {
          synced: true,
          snapshot_uri: `subtitle://title/${path.basename(report.output.path)}?sha256=${report.output.hash}`,
          sha256: report.output.hash,
          verified_at: new Date().toISOString(),
        },
      };
    }

    case "subtitlewrite.best": {
      const input = assertPathAllowed(text(params.input_path, "input_path"), roots, "input_path");
      const output = params.output_path ? assertPathAllowed(String(params.output_path), roots, "output_path") : null;
      if (output && path.resolve(output) === path.resolve(input)) {
        throw new SubtitleError("禁止覆盖原片", "overwrite_source_forbidden", false);
      }
      const outcome = await best({
        input,
        output,
        cues: resolveCues(params),
        titleText: params.title_text ?? "",
        brief: resolveBrief(params),
        platform: params.platform ?? null,
        fontsDir: params.fonts_dir ? assertPathAllowed(String(params.fonts_dir), roots, "fonts_dir") : fontRoot,
        evidenceDir: optionalPath(params.evidence_dir, "evidence_dir"),
        bins,
        catalog,
        minScore: optionalNumber(params.min_score) ?? 80,
        hasBurnedInSubtitles: params.has_burned_in_subtitles === true,
        candidates: optionalNumber(params.candidates) ?? 3,
      });
      const hash = outcome.verdict === "scored" ? outcome.sha256 : null;
      return {
        result: outcome,
        receipt: {
          synced: true,
          snapshot_uri: outcome.verdict === "scored"
            ? `subtitle://best/${path.basename(outcome.output.path)}?sha256=${hash}`
            : "subtitle://best/no-change",
          ...(hash ? { sha256: hash } : {}),
          verified_at: new Date().toISOString(),
        },
      };
    }

    default:
      throw new SubtitleError(`未实现的工具：${name}`, "not_provided");
  }
}
