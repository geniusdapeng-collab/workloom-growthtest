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
  "subtitlewrite.danmaku",
  "subtitlewrite.sticker",
  "subtitlewrite.karaoke",
  "subtitlewrite.sidecar",
  "subtitlewrite.softmux",
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

/**
 * 字体目录：**仓库随包字体优先**（font-library v1.1 全量入库，`library/fonts/`），
 * `WORKLOOM_SUBTITLE_FONTS_DIR` 可指向客户自备/工位外置字体目录覆盖之（同名文件按 sha256 校验）。
 */
export function fontsRoot(env = process.env) {
  const raw = (env.WORKLOOM_SUBTITLE_FONTS_DIR ?? "").trim();
  if (raw) return path.resolve(raw);
  const bundled = path.resolve(path.dirname(new URL(import.meta.url).pathname), "../../library/fonts");
  if (fs.existsSync(bundled)) return bundled;
  return path.join(os.homedir(), ".workloom-subtitle", "fonts");
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

/**
 * 字幕标点政策（2026-09-25 产品所有者口径）：
 * **正规字幕不带标点符号**——标点是给朗读用的语音停顿记号，落在屏上是阅读噪声
 * （小红书/抖音的头部账号基本都不打标点）。这里把"去标点"做成**入站口的一次性规范化**：
 * 任何形态（sidecar 旁挂 / burn 烧录 / softmux 软轨 / karaoke）都从 `parseSrt` 拿 cues，
 * 因此在这一处去掉，全链路（含导出 srt/vtt/ass）自动一致，不会出现"画面干净、文件带标点"。
 *
 * 三条细则（避免"一刀切"造成新事故）：
 *   ① 数字里的分隔符不动：`3.5 字/秒`、`9:16`、`2026-09-25`、`1300年` 都保持原样（两侧是数字时跳过）；
 *   ② 纯西文字幕不强制去标点（英文句子的句读是阅读标准），只有含中日韩文字的字幕才走"全去"口径；
 *   ③ 去标点后为空的行（例如整行只有"……"）退回原文本——宁可留一个标点，也不许出现空字幕条。
 */
export const SUBTITLE_CJK_PUNCTUATION = "，。、；：！？…—～·「」『』《》〈〉【】〔〕（）［］｛｝“”‘’";
export const SUBTITLE_LATIN_PUNCTUATION = ".,!?;:\"'()[]{}<>~";
/** 数字之间出现时**不视为标点**的字符（小数、时间、日期、比例、区间） */
const NUMERIC_INFIX = new Set([".", ":", "-", "/", "、", "，"]);
const cjkCharRe = /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/;

/** 判断文本是否以中日韩文字为主（决定要不要走"全去标点"口径） */
export function isCjkText(text) {
  return cjkCharRe.test(String(text ?? ""));
}

/**
 * 去标点。`mode`：auto（默认，含中日韩文字才去）/ strip（强制去）/ keep（原样保留）。
 * 逐字符处理而不是一次性 replace：只有这样才能保住数字内的分隔符（细则①）。
 */
export function stripSubtitlePunctuation(text, { mode = "auto" } = {}) {
  const raw = String(text ?? "");
  if (!raw.trim() || mode === "keep") return raw;
  if (mode === "auto" && !isCjkText(raw)) return raw;
  const drop = new Set([...SUBTITLE_CJK_PUNCTUATION, ...SUBTITLE_LATIN_PUNCTUATION]);
  const lines = raw.split("\\N").map((line) => {
    const chars = [...line];
    const kept = [];
    for (let index = 0; index < chars.length; index += 1) {
      const char = chars[index];
      if (!drop.has(char)) {
        kept.push(char);
        continue;
      }
      const prev = chars[index - 1] ?? "";
      const next = chars[index + 1] ?? "";
      if (NUMERIC_INFIX.has(char) && /\d/.test(prev) && /\d/.test(next)) {
        kept.push(char);
        continue;
      }
      /** 省略号/破折号这类连续标点一并吃掉，避免留半个「…」或「—」 */
      while (index + 1 < chars.length && chars[index + 1] === char) index += 1;
    }
    return kept.join("").replace(/[ \t]{2,}/g, " ").trim();
  });
  const stripped = lines.join("\\N").trim();
  /** 细则③：整行只剩标点时不许产出空字幕 */
  return stripped.replace(/\\N/g, "").length > 0 ? stripped : raw;
}

/**
 * 找出文本里仍然残留的字幕标点（体检/门禁用：返回命中的字符列表，空数组=干净）。
 * 与 `stripSubtitlePunctuation` 同一套字符表与数字豁免，避免"清的规则"和"查的规则"两套。
 */
export function findSubtitlePunctuation(text) {
  const raw = String(text ?? "");
  if (!isCjkText(raw)) return [];
  const drop = new Set([...SUBTITLE_CJK_PUNCTUATION, ...SUBTITLE_LATIN_PUNCTUATION]);
  const hits = [];
  for (const line of raw.split(/\r?\n/)) {
    const chars = [...line];
    for (let index = 0; index < chars.length; index += 1) {
      const char = chars[index];
      if (!drop.has(char)) continue;
      const prev = chars[index - 1] ?? "";
      const next = chars[index + 1] ?? "";
      if (NUMERIC_INFIX.has(char) && /\d/.test(prev) && /\d/.test(next)) continue;
      hits.push(char);
    }
  }
  return hits;
}

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
  /**
   * 标点规范化（2026-09-25 产品所有者口径）：字幕不带标点。
   * 放在**解析入口**而不是各出口，保证旁挂 srt/vtt/ass、烧录、软字幕轨四条路完全一致。
   * 折行已在写入 SRT 前按标点做过（`buildSrt` 的 wrapCue），所以这里去掉标点不会破坏断行。
   */
  const punctuationMode = process.env.WORKLOOM_SUBTITLE_PUNCTUATION ?? "auto";
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
    const body = stripSubtitlePunctuation(lines.slice(timeIndex + 1).join("\\N"), { mode: punctuationMode });
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
  /**
   * 多行 cue 必须**逐行**体检（2026-09-27 真机修复）：
   * 管线按标点把长句折成两行（full-chain-film#buildSrt），这里原来把整条 cue
   * （含换行）当一行量，24 字的两行字幕被判「中文 24 字超出单行上限 18 字」，
   * 烧录产物被删、母版终审 score=0。口径本就写的是"单行上限"，因此取最长行判定。
   */
  const lines = String(text).split(/\r?\n|\\N/).filter((line) => line.trim() !== "");
  const metrics = lines.map((line) => {
    const plain = line.replace(/\\N/g, "");
    return {
      han: (plain.match(/\p{Script=Han}/gu) ?? []).length,
      latin: plain.replace(/\p{Script=Han}/gu, "").replace(/\s/g, "").length,
    };
  });
  const han = Math.max(0, ...metrics.map((item) => item.han));
  const latin = Math.max(0, ...metrics.map((item) => item.latin));
  return {
    charsHan: han,
    charsLatin: latin,
    lines: lines.length,
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
  secondaryCues = [],
  secondaryLabel = "EN",
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
    events.push({
      layer: 0, start: cue.start, end: cue.end, style: "Sub", name: subPick.id,
      /** 出口兜底（2026-09-25）：程序化直接传 cues 的调用（不经 SRT）同样按"字幕不带标点"交付 */
      text: stripSubtitlePunctuation(cue.text),
    });
  }
  // 双语：第二语言单独一条样式（字号小 12%、整体下移一行），语义上仍属同一条字幕
  if (secondaryCues.length && subPick) {
    const subStyleEntry = styles.find((entry) => entry.name === "Sub");
    if (subStyleEntry) {
      const secondarySize = Math.max(18, Math.round(subStyleEntry.style.fontSize * 0.88));
      styles.push({
        name: "Sub2",
        style: {
          ...subStyleEntry.style,
          fontSize: secondarySize,
          outline: Math.max(1, Math.round(secondarySize * 0.06)),
          marginV: Math.max(0, Math.round(subStyleEntry.style.marginV - subStyleEntry.style.fontSize * 1.35)),
        },
      });
      for (const cue of secondaryCues) {
        events.push({
          layer: 0, start: cue.start, end: cue.end, style: "Sub2",
          name: `${subPick.id}-${secondaryLabel}`, text: stripSubtitlePunctuation(cue.text),
        });
      }
    }
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
/**
 * ASS → 成片编码（新渲染器共用）：扁平字体目录 → ffmpeg libass → 回读输出规格与 fontselect。
 * 关键纪律：字体必须命中仓内/工位字体目录，静默回落系统字体一律判失败。
 */
async function encodeWithAss({ input, output, assPath, fontsDir, catalog, bins, extraFilter = ",format=yuv420p" }) {
  const encoder = await pickVideoEncoder({ bins });
  const probe = await probeMedia(input, { bins });
  const renderWorkDir = await tempDir("workloom-subtitle-render-");
  const flatFonts = prepareFlatFontsDir({ fontsDir, catalog, workDir: renderWorkDir });
  if (flatFonts.missing.length) {
    throw new SubtitleError(
      `字体缺失 ${flatFonts.missing.length} 款（如 ${flatFonts.missing[0]}）：请补齐 library/fonts 或指定 WORKLOOM_SUBTITLE_FONTS_DIR`,
      "font_not_found",
      false,
    );
  }
  const filter = `ass=${escapeFilterPath(assPath)}:fontsdir=${escapeFilterPath(flatFonts.flat)}${extraFilter}`;
  const args = ["-hide_banner", "-v", "info", "-y", "-i", input, "-map", "0:v:0"];
  if (probe.hasAudio) args.push("-map", "0:a:0", "-c:a", "copy");
  args.push("-vf", filter, ...encoder.args, "-movflags", "+faststart", output);
  const log = (await runBin(bins.ffmpeg, args, { label: "ffmpeg" })).stderr;
  if (!fs.existsSync(output)) throw new SubtitleError(`渲染未产出文件：${output}`, "ffmpeg_failed", true);
  const outputProbe = await probeMedia(output, { bins });
  const hash = await sha256File(output);
  const fontResolution = parseFontSelections(log, flatFonts.flat);
  return { encoder, probe, outputProbe, hash, fontResolution, flatFonts };
}

export async function renderWithSubtitles({
  mode = "subtitle",
  input,
  output,
  cues = [],
  titleText = "",
  titleDurationSec = 3,
  secondaryCues = [],
  secondaryLabel = "EN",
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
    secondaryCues: mode === "title" ? [] : secondaryCues,
    secondaryLabel,
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
  /**
   * 抽帧时刻**必须夹在成片时长内**（2026-09-25 南昌片真机）：
   * 字幕时间轴来自分镜时长，可能比成片（扣掉逐刀转场后）长一点点，
   * 末条字幕的中点就会落到片尾之后 → `extractFrame` 失败 → 整条烧录被判失败（其实画面完全正常）。
   * 这里按输出时长做防御性夹取（并留 0.1s 余量），不让"证据帧采样越界"毁掉一次成功的烧录。
   */
  const safeDuration = Number(outputProbe.duration ?? 0);
  for (const rawAt of stamps) {
    const at = safeDuration > 0.3 ? round(Math.min(Number(rawAt), safeDuration - 0.1), 2) : Number(rawAt);
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
    /**
     * 标点口径（2026-09-25）：烧录/软轨用的 cues 必须已经去过标点。
     * 这里对**写进画面的 ASS 事件文本**再查一遍（而不是只查入参），
     * 因为"入参干净、事件脏"只有在这一层能看到。
     */
    punctuation_ok: subEvents.every((event) => findSubtitlePunctuation(String(event.text ?? "")).length === 0),
    font_resolved_from_fonts_dir: fontResolution.allFromFontsDir !== false,
    resolution_preserved: outputProbe.width === probe.width && outputProbe.height === probe.height,
    audio_preserved: outputProbe.hasAudio === probe.hasAudio,
    evidence_frames: evidence.length > 0,
  };

  if (!Object.values(report.checks).every(Boolean)) {
    const failed = Object.entries(report.checks).filter(([, ok]) => !ok).map(([key]) => key);
    /**
     * 诊断信息要能定位到"哪一项版式检查失败、实测值多少"（2026-09-25 真机）：
     * 早先只报 `layout_ok` 一个词，产物还当场删了——排查只能靠猜。
     * 现在把失败项对应的 layoutChecks 明细拼进错误消息（保留 checks 前缀，不改变对外语义）。
     */
    const failedDetails = report.layoutChecks
      .filter((check) => !check.ok)
      .map((check) => `${check.kind}：${JSON.stringify(check.detail ?? check.note ?? null)}`)
      .join("；");
    if (typeof fsp.rm === "function") await fsp.rm(output, { force: true });
    else fs.unlinkSync(output);
    throw new SubtitleError(
      `字幕复检未通过（${failed.join("/")}）${failedDetails ? `：${failedDetails}` : ""}：产物已删除，不进入入库/发布队列`,
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

/* ============================ 弹幕 / 贴纸 / 卡拉OK（v1.1 二期） ============================ */

export const DANMAKU_MODES = ["scroll", "top", "bottom"];

export const DANMAKU_COLOURS = ["#FFFFFF", "#FFF200", "#00E5FF", "#7CFF6B", "#FF9AD5", "#FFB020"];

/** ASS 文本转义：大括号必须转义，换行转硬换行（否则会被 libass 当作 override 标签吃掉）。 */
export function escapeAssText(text) {
  return String(text).replace(/[{}]/g, (match) => `\\${match}`).replace(/\r?\n/g, "\\N");
}

/**
 * 弹幕输入解析：数组或 JSONL/JSON 字符串。
 * 每条：{ at(秒) , text , mode?: scroll|top|bottom , colour? , sizeScale? }
 */
export function parseDanmaku(input) {
  let list = [];
  if (typeof input === "string" && input.trim()) {
    const text = input.trim();
    list = text.startsWith("[")
      ? JSON.parse(text)
      : text.split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
  } else if (Array.isArray(input)) {
    list = input;
  }
  if (!list.length) throw new SubtitleError("弹幕列表为空", "bad_request", false);
  return list.map((raw, index) => {
    const at = Number(raw.at ?? raw.time ?? 0);
    const text = String(raw.text ?? raw.content ?? "").trim();
    if (!Number.isFinite(at) || at < 0) throw new SubtitleError(`弹幕 #${index + 1} 的 at 非法：${raw.at}`, "bad_style", false);
    if (!text) throw new SubtitleError(`弹幕 #${index + 1} 文本为空`, "bad_style", false);
    const mode = DANMAKU_MODES.includes(raw.mode) ? raw.mode : "scroll";
    const colour = typeof raw.colour === "string" && /^#[0-9A-Fa-f]{6}$/.test(raw.colour) ? raw.colour : null;
    const sizeScale = Number(raw.sizeScale ?? 1);
    return { at, text, mode, colour, sizeScale: Number.isFinite(sizeScale) && sizeScale > 0 ? sizeScale : 1 };
  }).sort((a, b) => a.at - b.at);
}

/** 弹幕密度体检：滑动窗口内并发条数（刷屏/霸屏的量化口径）。 */
export function checkDanmakuDensity(items, { windowSec = 1, maxConcurrent = 8 } = {}) {
  const sorted = [...items].sort((a, b) => a.at - b.at);
  let peak = 0;
  let peakAt = null;
  for (let index = 0; index < sorted.length; index += 1) {
    const windowStart = sorted[index].at;
    let count = 0;
    for (let cursor = index; cursor < sorted.length; cursor += 1) {
      if (sorted[cursor].at - windowStart > windowSec) break;
      count += 1;
    }
    if (count > peak) {
      peak = count;
      peakAt = windowStart;
    }
  }
  return {
    total: sorted.length,
    windowSec,
    maxConcurrent,
    peakConcurrent: peak,
    peakAt,
    ok: peak <= maxConcurrent,
    note: peak > maxConcurrent
      ? `${windowSec}s 窗口内并发 ${peak} 条（上限 ${maxConcurrent}）：需抽稀或降速`
      : "弹幕密度在口径内",
  };
}

/** 弹幕密度裁剪：按窗口保留上限内的条目，如实报告裁掉多少（不静默丢）。 */
export function trimDanmaku(items, { windowSec = 1, maxConcurrent = 8 } = {}) {
  const sorted = [...items].sort((a, b) => a.at - b.at);
  const kept = [];
  const dropped = [];
  for (const item of sorted) {
    const recent = kept.filter((entry) => item.at - entry.at <= windowSec);
    if (recent.length >= maxConcurrent) dropped.push(item);
    else kept.push(item);
  }
  return { kept, dropped, trimmed: dropped.length };
}

/**
 * 弹幕轨道分配：滚动弹幕占顶部 1/4 区域的固定轨道（round-robin），
 * 顶部/底部固定各占自己的行位；返回每条的时间与位移参数（确定性、可复算）。
 */
export function planDanmakuTracks(items, {
  resolution, layout = {}, size = 40, lanes = 8, topRows = 2, bottomRows = 2, holdSec = 4, scrollSec = 7,
}) {
  const [width, height] = resolution;
  const topBandRatio = Number(layout.弹幕?.top_band_ratio ?? 0.25);
  const marginTop = Math.round(height * 0.04);
  const laneGap = Math.max(12, Math.round((height * topBandRatio - marginTop) / Math.max(lanes, 1)));
  const bottomBase = Math.round(height * (1 - Number(layout.字幕?.bottom_margin_ratio ?? 0.05) - 0.08));
  let scrollCursor = 0;
  let topCursor = 0;
  let bottomCursor = 0;
  return items.map((item) => {
    const textWidth = Math.max(size, Array.from(item.text).length * size);
    if (item.mode === "top") {
      const row = topCursor % topRows;
      topCursor += 1;
      return { ...item, y: marginTop + row * Math.round(laneGap * 1.15), durationSec: holdSec, enterX: null, exitX: null };
    }
    if (item.mode === "bottom") {
      const row = bottomCursor % bottomRows;
      bottomCursor += 1;
      return { ...item, y: bottomBase - row * Math.round(laneGap * 1.15), durationSec: holdSec, enterX: null, exitX: null };
    }
    const lane = scrollCursor % lanes;
    scrollCursor += 1;
    return {
      ...item,
      y: marginTop + lane * laneGap,
      durationSec: scrollSec + textWidth / (width * 1.4),
      enterX: width,
      exitX: -textWidth,
    };
  });
}

/** 逐字时间轴规范化：显式 [{text,start,end}] / [{text,duration}] → 均分兜底（如实标注口径）。 */
export function parseTimedWords(payload, { text, start, end, mode = "even" }) {
  const cueStart = assistToSeconds(start);
  const cueEnd = assistToSeconds(end);
  const cueDuration = cueEnd - cueStart;
  if (Array.isArray(payload) && payload.length) {
    let cursor = cueStart;
    const words = payload.map((raw, index) => {
      const word = String(raw.text ?? raw.w ?? "").trim();
      if (!word) throw new SubtitleError(`逐字时间轴 #${index + 1} 文本为空`, "bad_style", false);
      const wordStart = Number.isFinite(Number(raw.start)) ? Number(raw.start) : cursor;
      const wordEnd = Number.isFinite(Number(raw.end))
        ? Number(raw.end)
        : wordStart + (Number.isFinite(Number(raw.duration)) ? Number(raw.duration) : 0);
      if (!(wordEnd > wordStart)) throw new SubtitleError(`逐字时间轴 #${index + 1} 时长非法`, "bad_style", false);
      cursor = wordEnd;
      return { text: word, start: wordStart, end: wordEnd };
    });
    const sum = round(words.reduce((acc, word) => acc + (word.end - word.start), 0), 3);
    return { words, basis: "explicit", cueDuration: round(cueDuration, 3), sum, sumErrorSec: round(sum - cueDuration, 3) };
  }
  if (mode !== "even") throw new SubtitleError("缺少逐字时间轴时只能用 timing_mode=even", "bad_request", false);
  const plain = String(text ?? "").replace(/\\N/g, "");
  const units = /\p{Script=Han}/u.test(plain)
    ? Array.from(plain.replace(/\s+/g, ""))
    : plain.split(/\s+/).filter(Boolean);
  if (!units.length) throw new SubtitleError("均分逐字时间轴需要非空文本", "bad_style", false);
  const step = cueDuration / units.length;
  const words = units.map((unit, index) => ({
    text: unit,
    start: round(cueStart + index * step, 3),
    end: round(cueStart + (index + 1) * step, 3),
  }));
  return { words, basis: "even-split（按字数均分，非真实发音对齐）", cueDuration: round(cueDuration, 3), sum: round(cueDuration, 3), sumErrorSec: 0 };
}

/** 卡拉OK 文本：\kf 扫过 / \k 跳变（厘秒）。 */
export function karaokeAssText(words, { mode = "kf" } = {}) {
  const tag = mode === "kf" ? "kf" : "k";
  return words.map((word) => {
    const centis = Math.max(1, Math.round((word.end - word.start) * 100));
    return `{\\${tag}${centis}}${escapeAssText(word.text)}`;
  }).join("");
}

/** 贴纸/花字风格预设（撞色 / 奶油 / 国风 / 科技 / 促销）。 */
export const STICKER_PRESETS = {
  撞色: { primaryColour: "#FFF200", outlineColour: "#FF2D55", backColour: "&H80000000", borderStyle: 1, rotation: -4 },
  奶油: { primaryColour: "#6B4A2B", outlineColour: "#FFF3DC", backColour: "&H59FFF3DC", borderStyle: 3, rotation: 2 },
  国风: { primaryColour: "#FFF7E6", outlineColour: "#8B1E1E", backColour: "&H808B1E1E", borderStyle: 1, rotation: 0 },
  科技: { primaryColour: "#E8FBFF", outlineColour: "#0072FF", backColour: "&H990072FF", borderStyle: 3, rotation: 0 },
  促销: { primaryColour: "#FFFFFF", outlineColour: "#E61E25", backColour: "&H80E61E25", borderStyle: 1, rotation: 0 },
};

export function stickerStylePreset(name) {
  const preset = STICKER_PRESETS[name] ?? STICKER_PRESETS.撞色;
  return { name: STICKER_PRESETS[name] ? name : "撞色", ...preset };
}

/** 贴纸事件文本：200ms 弹入（缩放 40%→100%）+ 预设旋转，符合附件「弹入/淡入 200ms」。 */
export function stickerAssText(sticker, { preset }) {
  const popIn = `{\\fscx40\\fscy40\\frz${preset.rotation}\\t(0,200,\\fscx100\\fscy100)}`;
  return `${popIn}${escapeAssText(sticker.text)}`;
}

/** 可现度实测（加字前后同一文字带的边缘能量/亮度增量；不足即视为没交付）。 */
async function measureBandPresence({ input, output, at, band, bins }) {
  const workDir = await tempDir("workloom-subtitle-presence-");
  const beforeFrame = path.join(workDir, "before.png");
  const afterFrame = path.join(workDir, "after.png");
  await extractFrame({ input, at, output: beforeFrame, bins });
  await extractFrame({ input: output, at, output: afterFrame, bins });
  const [before, after] = await Promise.all([
    regionStats({ input: beforeFrame, bins, region: band }),
    regionStats({ input: afterFrame, bins, region: band }),
  ]);
  const edgeDelta = round((after.edgeDensityUnit ?? 0) - (before.edgeDensityUnit ?? 0), 4);
  const lumaDelta = round((after.lumaAvgUnit ?? 0) - (before.lumaAvgUnit ?? 0), 4);
  return { at, edgeDelta, lumaDelta, delta: round(Math.max(edgeDelta, Math.abs(lumaDelta)), 4), before, after };
}

function assertRenderable({ input, output, skipVerify }) {
  if (typeof input !== "string" || !input.trim()) throw new SubtitleError("input_path 缺失", "bad_request");
  if (typeof output !== "string" || !output.trim()) throw new SubtitleError("output_path 缺失", "bad_request");
  if (path.resolve(input) === path.resolve(output)) {
    throw new SubtitleError("禁止覆盖原片（输出路径等于输入路径）", "overwrite_source_forbidden", false);
  }
  if (skipVerify) {
    throw new SubtitleError("交付必须带复检（关闭校验的调用禁止执行，围栏 G-SUB3）", "bad_request", false);
  }
}

async function removeOnFailure(output) {
  if (typeof fsp.rm === "function") await fsp.rm(output, { force: true });
  else if (fs.existsSync(output)) fs.unlinkSync(output);
}

/**
 * 弹幕轨渲染：滚动（顶部 1/4 轨道）+ 顶部/底部固定。
 * 口径：单条 ≤ 20 字（超出即拒绝），密度按滑动窗口裁剪到上限并如实报告裁掉条目，
 * 透明度默认 0.85，渲染后复检（密度/条数/字体解析/可现度/分辨率/音轨/证据帧）。
 */
export async function renderDanmaku({
  input,
  output,
  items = [],
  platform = null,
  brief = {},
  fontsDir = null,
  evidenceDir = null,
  bins = resolveBinaries(),
  catalog = loadFontCatalog(),
  opacity = 0.85,
  maxChars = 20,
  maxConcurrent = 8,
  windowSec = 1,
  lanes = 8,
  skipVerify = false,
}) {
  fontsDir = fontsDir ?? fontsRoot();
  assertRenderable({ input, output, skipVerify });
  const parsed = parseDanmaku(items);
  const tooLong = parsed.filter((item) => Array.from(item.text).length > maxChars);
  if (tooLong.length) {
    throw new SubtitleError(
      `${tooLong.length} 条弹幕超过单条 ${maxChars} 字上限（示例：${tooLong[0].text.slice(0, 12)}…）：请改写或拆条`,
      "bad_style",
      false,
    );
  }
  const trimming = trimDanmaku(parsed, { windowSec, maxConcurrent });
  const densityBefore = checkDanmakuDensity(parsed, { windowSec, maxConcurrent });
  const probe = await probeMedia(input, { bins });
  const platformKey = platform ?? brief.平台 ?? "默认";
  const { key: layoutKey, layout } = layoutFor(platformKey, catalog);
  const resolution = [probe.width, probe.height];
  const selection = selectFonts({ brief, scene: "弹幕", top: 1, catalog, fontsDir, resolution });
  const pick = selection.top.find((item) => item.installed !== false) ?? selection.top[0];
  if (!pick) throw new SubtitleError("弹幕场景没有可用字体", "font_not_found", false);
  const size = pick.size.sizePx;
  const targets = loadRecipes().targets;
  const layoutBands = textBands({ resolution, layout });
  // 选型/配色用「顶部 1/4 区域」整带（滚动轨道与顶部固定行都在这里）
  const danmakuAreaPx = {
    x: 0,
    y: 0,
    w: resolution[0],
    h: Math.max(24, Math.round(resolution[1] * Number(layout.弹幕?.top_band_ratio ?? 0.25))),
  };
  const bandStats = await regionStats({ input, bins, region: danmakuAreaPx });
  const decision = decideTextStyle({ scene: "弹幕", band: bandStats, size, targets });
  const alphaValue = Math.round((1 - Math.min(Math.max(opacity, 0.1), 1)) * 255).toString(16).padStart(2, "0").toUpperCase();
  const tracks = planDanmakuTracks(trimming.kept, { resolution, layout, size, lanes });
  const baseStyle = {
    fontName: pick.fontFullname,
    fontSize: size,
    primaryColour: decision.primaryColour,
    outlineColour: decision.outlineColour,
    backColour: decision.backColour,
    bold: false,
    spacing: 0,
    borderStyle: 1,
    outline: Math.max(1, Math.round(size * 0.05)),
    shadow: decision.shadow,
    marginL: 0,
    marginR: 0,
    marginV: 0,
  };
  const styles = [
    { name: "Danmaku", style: { ...baseStyle, alignment: 7 } },
    { name: "DanmakuTop", style: { ...baseStyle, alignment: 8 } },
    { name: "DanmakuBottom", style: { ...baseStyle, alignment: 2 } },
  ];
  const events = tracks.map((item) => {
    const colour = item.colour ? assColour(item.colour) : baseStyle.primaryColour;
    const fontSize = Math.max(16, Math.round(size * item.sizeScale));
    const styleName = item.mode === "top" ? "DanmakuTop" : item.mode === "bottom" ? "DanmakuBottom" : "Danmaku";
    const overrides = item.enterX === null
      ? `{\\alpha&H${alphaValue}&\\c${colour}\\fs${fontSize}\\pos(${Math.round(resolution[0] / 2)},${item.y})}`
      : `{\\alpha&H${alphaValue}&\\c${colour}\\fs${fontSize}\\move(${item.enterX},${item.y},${item.exitX},${item.y},0,${Math.round(item.durationSec * 1000)})}`;
    return {
      layer: 0,
      start: srtSecondsToAss(item.at),
      end: srtSecondsToAss(item.at + item.durationSec),
      style: styleName,
      name: pick.id,
      text: `${overrides}${escapeAssText(item.text)}`,
    };
  });
  const dir = evidenceDir ?? (await tempDir("workloom-subtitle-danmaku-"));
  await fsp.mkdir(dir, { recursive: true });
  const assPath = path.join(dir, "danmaku-plan.ass");
  const assText = buildAssDocument({ resolution, styles, events });
  await fsp.writeFile(assPath, assText, "utf8");
  const encoded = await encodeWithAss({ input, output, assPath, fontsDir, catalog, bins });
  // 抽样优先取滚动弹幕的「屏幕中段时刻」（位移中点最可靠），没有滚动条就取固定条
  const sample = tracks.find((item) => item.mode === "scroll") ?? tracks[0];
  const sampleAt = sample.mode === "scroll"
    ? round(sample.at + sample.durationSec / 2, 2)
    : round(sample.at + Math.min(1, sample.durationSec / 2), 2);
  /**
   * 可现度实测带 = **被抽样那条弹幕自己的轨道条带**（不是整块顶部 1/4）。
   * 实测教训：整带面积大，墨迹占比被稀释——稀疏弹幕（1~2 条）Δ≈0.0017、7 条时 Δ≈0.0038，
   * 都会贴着 0.004 阈值抖动，出现"明明渲染了却判失败"。收紧到该条的轨道条带后 Δ≈0.014，
   * 判的是"这条弹幕出现没有"，与阈值口径一致。
   */
  const danmakuBandPx = {
    x: 0,
    y: Math.max(0, sample.y - Math.round(size * 0.4)),
    w: resolution[0],
    h: Math.round(size * 1.6),
  };
  const presence = await measureBandPresence({
    input, output, at: sampleAt, band: danmakuBandPx, bins,
  });
  const evidence = [];
  for (const at of [...new Set(tracks.slice(0, 3).map((item) => round(item.at + 0.6, 2)))]) {
    const file = path.join(dir, `evidence-danmaku-${String(at).replace(".", "_")}.png`);
    await extractFrame({ input: output, at, output: file, bins });
    evidence.push({ at, file, sha256: await sha256File(file) });
  }
  const backRead = parseAssEvents(assText).filter((event) => event.style.startsWith("Danmaku"));
  const checks = {
    event_count_ok: backRead.length === tracks.length,
    density_within_cap: densityBefore.ok,
    font_resolved_from_fonts_dir: encoded.fontResolution.allFromFontsDir !== false,
    presence_ok: presence.delta >= 0.004,
    resolution_preserved: encoded.outputProbe.width === probe.width && encoded.outputProbe.height === probe.height,
    audio_preserved: encoded.outputProbe.hasAudio === probe.hasAudio,
    evidence_frames: evidence.length > 0,
  };
  const report = {
    schemaVersion: "workloom.subtitle-report/v1",
    mode: "danmaku",
    input,
    output: { path: output, hash: encoded.hash, bytes: fs.statSync(output).size },
    encoder: encoded.encoder.name,
    platform: layoutKey,
    resolution,
    font: { id: pick.id, name: pick.字体名称 ?? pick.name, file: pick.file, license: pick.license, sha256: pick.sha256 },
    opacity,
    maxChars,
    density: {
      ...densityBefore,
      kept: trimming.kept.length,
      trimmed: trimming.trimmed,
      trimmedItems: trimming.dropped.map((item) => item.text),
    },
    tracks: tracks.map((item) => ({ text: item.text, mode: item.mode, at: item.at, y: item.y, durationSec: round(item.durationSec, 2) })),
    style: baseStyle,
    textStyleDecision: decision,
    presence,
    evidence,
    assPath,
    fontResolution: { allFromFontsDir: encoded.fontResolution.allFromFontsDir, fallbackFamilies: encoded.fontResolution.fallbackFamilies },
    checks,
  };
  if (!Object.values(checks).every(Boolean)) {
    const failed = Object.entries(checks).filter(([, ok]) => !ok).map(([name]) => name);
    await removeOnFailure(output);
    throw new SubtitleError(`弹幕复检未通过（${failed.join("/")}）：产物已删除`, "verify_failed", false);
  }
  return report;
}

/**
 * 贴纸/花字渲染：200ms 弹入 + 停留 1.5~3s（附件口径，越界即拒绝）。
 * 位置必须在安全区内、与平台遮挡区零相交；渲染后复检可现度/字体解析/分辨率/音轨/证据帧。
 */
export async function renderSticker({
  input,
  output,
  stickers = [],
  platform = null,
  brief = {},
  fontsDir = null,
  evidenceDir = null,
  bins = resolveBinaries(),
  catalog = loadFontCatalog(),
  skipVerify = false,
}) {
  fontsDir = fontsDir ?? fontsRoot();
  assertRenderable({ input, output, skipVerify });
  if (!Array.isArray(stickers) || !stickers.length) throw new SubtitleError("贴纸列表为空", "bad_request", false);
  const targets = loadRecipes().targets;
  const probe = await probeMedia(input, { bins });
  const platformKey = platform ?? brief.平台 ?? "默认";
  const { key: layoutKey, layout } = layoutFor(platformKey, catalog);
  const resolution = [probe.width, probe.height];
  const short = probe.shortSide;
  const selection = selectFonts({ brief, scene: "贴纸", top: 1, catalog, fontsDir, resolution });
  const pick = selection.top.find((item) => item.installed !== false) ?? selection.top[0];
  if (!pick) throw new SubtitleError("贴纸场景没有可用字体", "font_not_found", false);
  const zones = layout.occlusion_zones ?? [];
  const styles = [];
  const placements = [];
  const events = [];
  stickers.forEach((raw, index) => {
    const preset = stickerStylePreset(raw.preset ?? raw.style ?? "撞色");
    const text = String(raw.text ?? "").trim();
    if (!text) throw new SubtitleError(`贴纸 #${index + 1} 文本为空`, "bad_style", false);
    const start = Number(raw.start ?? 0);
    const end = Number(raw.end ?? start + 2);
    const hold = round(end - start, 2);
    if (!(hold > 0)) throw new SubtitleError(`贴纸 #${index + 1} 时间轴非法`, "bad_style", false);
    if (hold < 1.5 || hold > 3) {
      throw new SubtitleError(
        `贴纸 #${index + 1} 停留 ${hold}s 超出附件口径 1.5~3s：请调整时间或改用字幕轨`,
        "bad_style",
        false,
      );
    }
    const scale = Number(raw.scale ?? 1);
    const size = Math.max(16, Math.round(short * 0.07 * (Number.isFinite(scale) && scale > 0 ? scale : 1)));
    const styleName = `Sticker${index + 1}`;
    styles.push({
      name: styleName,
      style: {
        fontName: pick.fontFullname,
        fontSize: size,
        primaryColour: assColour(preset.primaryColour),
        outlineColour: assColour(preset.outlineColour),
        backColour: preset.backColour,
        bold: true,
        spacing: 1,
        borderStyle: preset.borderStyle,
        outline: Math.max(2, Math.round(size * 0.08)),
        shadow: preset.borderStyle === 3 ? 0 : 1,
        alignment: 5,
        marginL: 0,
        marginR: 0,
        marginV: 0,
      },
    });
    const cx = Math.round(resolution[0] * Number(raw.x ?? 0.5));
    const cy = Math.round(resolution[1] * Number(raw.y ?? 0.3));
    const estWidth = Array.from(text).length * size;
    const estHeight = Math.round(size * 1.3);
    const rect = {
      x: round((cx - estWidth / 2) / resolution[0], 4),
      y: round((cy - estHeight / 2) / resolution[1], 4),
      w: round(estWidth / resolution[0], 4),
      h: round(estHeight / resolution[1], 4),
    };
    const hits = overlapsOcclusion(rect, zones);
    if (hits.length) {
      throw new SubtitleError(
        `贴纸 #${index + 1} 落在平台遮挡区（${hits.map((zone) => zone.id).join("、")}）：请挪位或改用标题轨`,
        "bad_style",
        false,
      );
    }
    const margin = targets.safeAreaMarginRatio * 0.5;
    if (rect.x < margin || rect.y < margin || rect.x + rect.w > 1 - margin || rect.y + rect.h > 1 - margin) {
      throw new SubtitleError(`贴纸 #${index + 1} 越出安全区：请把 x/y 收到 5% 边距内`, "bad_style", false);
    }
    placements.push({ text, preset: preset.name, start, end, holdSec: hold, rect, centre: { x: cx, y: cy } });
    events.push({
      layer: 2,
      start: srtSecondsToAss(start),
      end: srtSecondsToAss(end),
      style: styleName,
      name: `${pick.id}-sticker`,
      text: `{\\pos(${cx},${cy})}${stickerAssText({ text }, { preset })}`,
    });
  });
  const dir = evidenceDir ?? (await tempDir("workloom-subtitle-sticker-"));
  await fsp.mkdir(dir, { recursive: true });
  const assPath = path.join(dir, "sticker-plan.ass");
  const assText = buildAssDocument({ resolution, styles, events });
  await fsp.writeFile(assPath, assText, "utf8");
  const encoded = await encodeWithAss({ input, output, assPath, fontsDir, catalog, bins });
  const sample = placements[0];
  const presence = await measureBandPresence({
    input,
    output,
    at: round(sample.start + Math.min(0.8, sample.holdSec / 2), 2),
    band: {
      x: Math.max(0, Math.round(sample.rect.x * resolution[0])),
      y: Math.max(0, Math.round(sample.rect.y * resolution[1])),
      w: Math.max(8, Math.round(sample.rect.w * resolution[0])),
      h: Math.max(8, Math.round(sample.rect.h * resolution[1])),
    },
    bins,
  });
  const evidence = [];
  for (const at of [...new Set(placements.map((item) => round(item.start + Math.min(0.8, item.holdSec / 2), 2)))].slice(0, 3)) {
    const file = path.join(dir, `evidence-sticker-${String(at).replace(".", "_")}.png`);
    await extractFrame({ input: output, at, output: file, bins });
    evidence.push({ at, file, sha256: await sha256File(file) });
  }
  const checks = {
    per_sticker_hold_ok: placements.every((item) => item.holdSec >= 1.5 && item.holdSec <= 3),
    font_resolved_from_fonts_dir: encoded.fontResolution.allFromFontsDir !== false,
    presence_ok: presence.delta >= 0.004,
    resolution_preserved: encoded.outputProbe.width === probe.width && encoded.outputProbe.height === probe.height,
    audio_preserved: encoded.outputProbe.hasAudio === probe.hasAudio,
    evidence_frames: evidence.length > 0,
  };
  const report = {
    schemaVersion: "workloom.subtitle-report/v1",
    mode: "sticker",
    input,
    output: { path: output, hash: encoded.hash, bytes: fs.statSync(output).size },
    encoder: encoded.encoder.name,
    platform: layoutKey,
    resolution,
    font: { id: pick.id, name: pick.字体名称 ?? pick.name, file: pick.file, license: pick.license },
    entranceMs: 200,
    placements,
    presence,
    evidence,
    assPath,
    fontResolution: { allFromFontsDir: encoded.fontResolution.allFromFontsDir, fallbackFamilies: encoded.fontResolution.fallbackFamilies },
    checks,
  };
  if (!Object.values(checks).every(Boolean)) {
    const failed = Object.entries(checks).filter(([, ok]) => !ok).map(([name]) => name);
    await removeOnFailure(output);
    throw new SubtitleError(`贴纸复检未通过（${failed.join("/")}）：产物已删除`, "verify_failed", false);
  }
  return report;
}

/**
 * 卡拉OK 字幕：\kf 逐字扫过（可选双语第二行）。
 * 逐字时间轴优先用显式传入；缺省按字数均分，并在报告里如实标注「非真实发音对齐」。
 */
export async function renderKaraoke({
  input,
  output,
  cues = [],
  timings = null,
  timingMode = "even",
  secondaryCues = [],
  secondaryLabel = "EN",
  platform = null,
  brief = {},
  fontsDir = null,
  evidenceDir = null,
  bins = resolveBinaries(),
  catalog = loadFontCatalog(),
  highlightColour = "#FFE066",
  skipVerify = false,
}) {
  fontsDir = fontsDir ?? fontsRoot();
  assertRenderable({ input, output, skipVerify });
  if (!cues.length) throw new SubtitleError("卡拉OK 需要 SRT 字幕条", "bad_request", false);
  const probe = await probeMedia(input, { bins });
  const platformKey = platform ?? brief.平台 ?? "默认";
  const { key: layoutKey, layout } = layoutFor(platformKey, catalog);
  const resolution = [probe.width, probe.height];
  const selection = selectFonts({ brief, scene: "字幕", top: 1, catalog, fontsDir, resolution });
  const pick = selection.top.find((item) => item.installed !== false) ?? selection.top[0];
  if (!pick) throw new SubtitleError("字幕场景没有可用字体", "font_not_found", false);
  const size = pick.size.sizePx;
  const subLayout = layout.字幕 ?? {};
  const marginV = Math.round(resolution[1] * Number(subLayout.bottom_margin_ratio ?? 0.05));
  const styles = [{
    name: "Kara",
    style: {
      fontName: pick.fontFullname,
      fontSize: size,
      primaryColour: assColour("#FFFFFF"),
      secondaryColour: assColour(highlightColour),
      outlineColour: assColour("#000000"),
      backColour: "&H64000000",
      bold: false,
      spacing: 0,
      borderStyle: 1,
      outline: Math.max(1, Math.round(size * 0.06)),
      shadow: 1,
      alignment: Number(subLayout.alignment ?? 2),
      marginL: Math.round(resolution[0] * 0.05),
      marginR: Math.round(resolution[0] * 0.05),
      marginV,
    },
  }];
  const timingRows = [];
  const events = cues.map((cue, index) => {
    const payload = Array.isArray(timings) ? timings[index] : (timings?.[index] ?? null);
    const parsed = parseTimedWords(payload, { text: cue.text, start: cue.start, end: cue.end, mode: timingMode });
    timingRows.push({
      cue: index + 1, basis: parsed.basis, cueDuration: parsed.cueDuration, sum: parsed.sum, sumErrorSec: parsed.sumErrorSec,
    });
    return {
      layer: 0,
      start: cue.start,
      end: cue.end,
      style: "Kara",
      name: pick.id,
      text: karaokeAssText(parsed.words, { mode: "kf" }),
    };
  });
  if (secondaryCues.length) {
    const secondarySize = Math.max(16, Math.round(size * 0.85));
    styles.push({
      name: "Kara2",
      style: {
        ...styles[0].style,
        fontSize: secondarySize,
        outline: Math.max(1, Math.round(secondarySize * 0.06)),
        marginV: Math.max(0, Math.round(marginV - size * 1.35)),
      },
    });
    for (const cue of secondaryCues) {
      events.push({
        layer: 0, start: cue.start, end: cue.end, style: "Kara2",
        name: `${pick.id}-${secondaryLabel}`, text: escapeAssText(cue.text),
      });
    }
  }
  const dir = evidenceDir ?? (await tempDir("workloom-subtitle-karaoke-"));
  await fsp.mkdir(dir, { recursive: true });
  const assPath = path.join(dir, "karaoke-plan.ass");
  const assText = buildAssDocument({ resolution, styles, events });
  await fsp.writeFile(assPath, assText, "utf8");
  const encoded = await encodeWithAss({ input, output, assPath, fontsDir, catalog, bins });
  const bands = textBands({ resolution, layout });
  const firstCue = cues[0];
  const presence = await measureBandPresence({
    input,
    output,
    at: round(Math.max(0, assistToSeconds(firstCue.end) - 0.4), 2),
    band: bands.subtitleBand.px,
    bins,
  });
  const evidence = [];
  for (const cue of cues.slice(0, 3)) {
    const at = round((assistToSeconds(cue.start) + assistToSeconds(cue.end)) / 2, 2);
    const file = path.join(dir, `evidence-karaoke-${String(at).replace(".", "_")}.png`);
    await extractFrame({ input: output, at, output: file, bins });
    evidence.push({ at, file, sha256: await sha256File(file) });
  }
  const checks = {
    timing_sum_ok: timingRows.every((row) => Math.abs(row.sumErrorSec) <= 0.05),
    karaoke_tags_present: events
      .filter((event) => event.style === "Kara")
      .every((event) => /\\kf?\d+/.test(event.text)),
    font_resolved_from_fonts_dir: encoded.fontResolution.allFromFontsDir !== false,
    presence_ok: presence.delta >= 0.004,
    resolution_preserved: encoded.outputProbe.width === probe.width && encoded.outputProbe.height === probe.height,
    audio_preserved: encoded.outputProbe.hasAudio === probe.hasAudio,
    evidence_frames: evidence.length > 0,
  };
  const report = {
    schemaVersion: "workloom.subtitle-report/v1",
    mode: "karaoke",
    input,
    output: { path: output, hash: encoded.hash, bytes: fs.statSync(output).size },
    encoder: encoded.encoder.name,
    platform: layoutKey,
    resolution,
    font: { id: pick.id, name: pick.字体名称 ?? pick.name, file: pick.file, license: pick.license },
    highlightColour,
    timingMode,
    timing: timingRows,
    bilingual: secondaryCues.length > 0,
    presence,
    evidence,
    assPath,
    fontResolution: { allFromFontsDir: encoded.fontResolution.allFromFontsDir, fallbackFamilies: encoded.fontResolution.fallbackFamilies },
    checks,
  };
  if (!Object.values(checks).every((ok) => ok)) {
    const failed = Object.entries(checks).filter(([, ok]) => !ok).map(([name]) => name);
    await removeOnFailure(output);
    throw new SubtitleError(`卡拉OK复检未通过（${failed.join("/")}）：产物已删除`, "verify_failed", false);
  }
  return report;
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

/* ============== 旁挂字幕交付（只出文件，不动画面）与软字幕轨 ============== */

/**
 * 为什么单独有这一段（2026-09-24 产品所有者口径）：
 * 成片交付有两种用法——**有些片子要带字幕、有些不要**，而"要不要"是后期/发布时的选择，不是生产时的死决定。
 * 因此母版一律**不烧字**：先出旁挂字幕文件（srt/ass/vtt + 清单），后期想用再选：
 *   ① 直接用旁挂文件（交给剪辑软件/平台上传口）；
 *   ② `softmux` 把字幕作为**可开关的字幕轨**嵌进容器（视频/音频轨逐帧 copy，画面零改动）；
 *   ③ 明确要硬字幕时才走 `burn`（另存名字，母版不动）。
 * 三条路的文字层同源（同一份 ASS 生成器），所以"软/硬/旁挂"三种形态的字幕版式一致，不会各说各话。
 */

const SRT_TIME_RE = /^(\d{1,2}):(\d{2}):(\d{2})[,.](\d{1,3})$/;

/** 秒 → SRT 时间戳（HH:MM:SS,mmm）。 */
export function srtTimestamp(seconds) {
  const total = Math.max(0, Number(seconds) || 0);
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const secs = Math.floor(total % 60);
  const millis = Math.round((total - Math.floor(total)) * 1000);
  const pad = (value, size = 2) => String(value).padStart(size, "0");
  // 毫秒四舍五入到 1000 时要进位，否则会出现 00:00:05,1000 这种非法时间戳
  const carry = millis >= 1000 ? 1 : 0;
  const normalised = carry
    ? { hours: hours + (secs + 1 >= 60 && minutes + 1 >= 60 ? 1 : 0), minutes: (minutes + (secs + 1 >= 60 ? 1 : 0)) % 60, secs: (secs + 1) % 60, millis: 0 }
    : { hours, minutes, secs, millis };
  return `${pad(normalised.hours)}:${pad(normalised.minutes)}:${pad(normalised.secs)},${pad(normalised.millis, 3)}`;
}

/** 旁挂 SRT 文本（保留 cue 顺序，一条不留、一条不多）。 */
export function cuesToSrt(cues = []) {
  const blocks = cues.map((cue, index) => {
    const start = assistToSeconds(cue.start);
    const end = assistToSeconds(cue.end);
    /** 出口兜底（2026-09-25 标点口径）：写文件前再去一次标点，避免"内存干净、文件带标点" */
    const text = stripSubtitlePunctuation(String(cue.text ?? "").trim());
    if (!text) throw new SubtitleError(`第 ${index + 1} 条字幕为空文本`, "bad_srt", false);
    if (!(end > start)) throw new SubtitleError(`第 ${index + 1} 条字幕时间轴非法（${cue.start} → ${cue.end}）`, "bad_srt", false);
    return `${index + 1}\n${srtTimestamp(start)} --> ${srtTimestamp(end)}\n${text}`;
  });
  return `${blocks.join("\n\n")}\n`;
}

function vttTimestamp(seconds) {
  return srtTimestamp(seconds).replace(",", ".");
}

/** WebVTT（平台后台上传口/网页播放器用；双语时同一条内先主后备，与烧录叠放顺序一致）。 */
export function cuesToVtt(cues = [], { secondaryCues = [], label = "" } = {}) {
  const head = ["WEBVTT", ...(label ? [`NOTE ${label}`] : [])].join("\n");
  const blocks = cues.map((cue, index) => {
    const start = assistToSeconds(cue.start);
    const end = assistToSeconds(cue.end);
    const secondary = secondaryCues[index] ? stripSubtitlePunctuation(String(secondaryCues[index].text ?? "").trim()) : "";
    const lines = [stripSubtitlePunctuation(String(cue.text ?? "").trim()), ...(secondary ? [secondary] : [])].filter(Boolean);
    return `${index + 1}\n${vttTimestamp(start)} --> ${vttTimestamp(end)}\n${lines.join("\n")}`;
  });
  return `${head}\n\n${blocks.join("\n\n")}\n`;
}

/** 轨道签名（视频/音频轨"有没有被改"的判据）：流参数 + 采样帧哈希。 */
export async function streamSignature(input, { bins = resolveBinaries(), kind = "video", at = [0.1, null, 0.9] } = {}) {
  const { stdout } = await runBin(bins.ffprobe, [
    "-v", "error", "-print_format", "json", "-show_streams", "-show_format", input,
  ], { label: "ffprobe" });
  const doc = JSON.parse(stdout);
  const stream = (doc.streams ?? []).find((item) => item.codec_type === kind) ?? null;
  if (!stream) return { present: false, signature: null, frames: [] };
  const duration = Number(doc.format?.duration ?? stream.duration);
  const signature = [
    kind, stream.codec_name, stream.profile ?? "-", stream.width ?? "-", stream.height ?? "-",
    stream.pix_fmt ?? "-", stream.avg_frame_rate ?? "-", stream.sample_rate ?? "-",
    stream.channels ?? "-", stream.nb_frames ?? "-",
  ].join("|");
  const frames = [];
  if (kind === "video") {
    const times = at.map((value) => (value === null ? Math.max(0, (Number.isFinite(duration) ? duration : 1) / 2) : value));
    for (const time of times) {
      const { stdout: hashOut } = await runBin(bins.ffmpeg, [
        "-v", "error", "-ss", String(round(time, 3)), "-i", input,
        "-frames:v", "1", "-f", "hash", "-hash", "md5", "-",
      ], { label: "ffmpeg" });
      frames.push({ at: round(time, 3), hash: hashOut.trim().replace(/^MD5=/, "") });
    }
  }
  return {
    present: true,
    signature,
    duration: Number.isFinite(duration) ? round(duration, 3) : null,
    frames,
  };
}

function signaturesEqual(a, b) {
  if (a?.present !== b?.present) return false;
  if (!a?.present) return true;
  if (a.signature !== b.signature) return false;
  if (a.frames.length !== b.frames.length) return false;
  return a.frames.every((frame, index) => frame.hash === b.frames[index]?.hash);
}

/** 源母版指纹（大小 + mtime）：证明"出字幕文件这一步没有动过母版"。 */
async function fileStatFingerprint(file) {
  const stat = await fsp.stat(file);
  return { sizeBytes: stat.size, mtimeMs: Math.round(stat.mtimeMs), sha256: await sha256File(file) };
}

/**
 * 旁挂字幕交付：出 SRT / ASS / VTT / 双语 + `subtitle-manifest.json`，**不产出视频**。
 * 版式沿用与烧录同源的 plan（同一 ASS 生成器 + 同一字体选型 + 同一版式体检），因此
 * "先旁挂、后想烧"或"先旁挂、后走软轨"三种形态的字幕观感一致。
 */
export async function exportSidecars({
  input = null,
  outputDir,
  name = null,
  cues = [],
  cuesEn = [],
  platform = null,
  brief = {},
  titleText = "",
  fontsDir = null,
  catalog = loadFontCatalog(),
  bins = resolveBinaries(),
  evidenceDir = null,
  analyze = true,
}) {
  if (!Array.isArray(cues) || cues.length === 0) {
    throw new SubtitleError("旁挂字幕交付需要至少一条字幕（SRT/VTT 都不为空）", "bad_srt", false);
  }
  if (typeof outputDir !== "string" || !outputDir.trim()) {
    throw new SubtitleError("output_dir 缺失（旁挂字幕要落到交付目录）", "bad_request", false);
  }
  const outDir = path.resolve(outputDir);
  await fsp.mkdir(outDir, { recursive: true });
  const baseName = (name && String(name).trim()) || "film";

  const beforeFingerprint = input ? await fileStatFingerprint(input) : null;
  const outcome = await plan({
    input,
    brief,
    platform,
    titleText,
    cues,
    scenes: ["标题", "字幕"],
    catalog,
    fontsDir: fontsDir ?? fontsRoot(),
    bins,
    outputDir: outDir,
    evidenceDir,
    analyze,
  });

  const resolvedPlatform = platform ?? brief.平台 ?? "默认";
  const { layout } = layoutFor(resolvedPlatform, catalog);
  const files = [];
  const writeFile = async (suffix, content, meta) => {
    const target = path.join(outDir, `${baseName}${suffix}`);
    await fsp.writeFile(target, content, "utf8");
    const sha256 = await sha256File(target);
    const record = {
      path: target,
      sha256,
      bytes: Buffer.byteLength(content, "utf8"),
      ...meta,
    };
    files.push(record);
    return record;
  };

  const zhSrt = await writeFile(".zh.srt", cuesToSrt(cues), { role: "subtitle", lang: "chi", format: "srt", primary: true });
  const assText = await fsp.readFile(outcome.assPath, "utf8");
  const zhAss = await writeFile(".zh.ass", assText, {
    role: "subtitle", lang: "chi", format: "ass", primary: true,
    styled: true, note: "与烧录/软轨同源（同一 ASS 生成器 + 同一字体选型）",
  });
  let enSrt = null;
  if (Array.isArray(cuesEn) && cuesEn.length) {
    enSrt = await writeFile(".en.srt", cuesToSrt(cuesEn), { role: "subtitle", lang: "eng", format: "srt", secondary: true });
  }
  const vtt = await writeFile(".vtt", cuesToVtt(cues, {
    secondaryCues: Array.isArray(cuesEn) ? cuesEn : [],
    label: `WorkLoom ${baseName} · ${resolvedPlatform}${outcome.plan.resolution ? ` · ${outcome.plan.resolution.join("x")}` : ""}`,
  }), {
    role: "subtitle", lang: Array.isArray(cuesEn) && cuesEn.length ? "chi+eng" : "chi", format: "vtt",
    note: "平台后台上传口/网页播放器；双语时同条先主后备",
  });

  // 时间轴回读：写出的 ASS 事件必须与源字幕逐条一致（旁挂也一样要能对回时间轴）
  const assEvents = parseAssEvents(assText).filter((event) => event.style === "Sub");
  const timelineOk = assEvents.length === cues.length
    && assEvents.every((event, index) => event.start === cues[index].start && event.end === cues[index].end);
  const srtRoundTrip = parseSrt(await fsp.readFile(zhSrt.path, "utf8"));
  const srtOk = srtRoundTrip.length === cues.length
    && srtRoundTrip.every((cue, index) => cue.text === String(cues[index].text).trim());
  const secondaryOk = !enSrt || parseSrt(await fsp.readFile(enSrt.path, "utf8")).length === cuesEn.length;
  /**
   * 标点体检（2026-09-25 口径）：交付的字幕文件里不得残留标点。
   * 判定看**落盘文件**而不是内存里的 cues——"清的是内存、发的是脏文件"正是这类事故的典型形态。
   */
  const zhSrtText = await fsp.readFile(zhSrt.path, "utf8");
  const punctuationHits = zhSrtText.split(/\r?\n/)
    .filter((line) => line.includes("-->") === false && !/^\d+$/.test(line.trim()) && line.trim() !== "")
    .flatMap((line) => findSubtitlePunctuation(line));
  const punctuationOk = punctuationHits.length === 0;
  const afterFingerprint = input ? await fileStatFingerprint(input) : null;
  const sourceUntouched = !input
    ? null
    : beforeFingerprint.sha256 === afterFingerprint.sha256
      && beforeFingerprint.sizeBytes === afterFingerprint.sizeBytes
      && beforeFingerprint.mtimeMs === afterFingerprint.mtimeMs;
  if (sourceUntouched === false) {
    throw new SubtitleError("旁挂字幕交付过程改动了母版（母版必须只读）", "overwrite_source_forbidden", false);
  }

  const checks = [
    ...outcome.checks,
    { kind: "timeline_readback", ok: timelineOk, detail: { cues: cues.length, events: assEvents.length } },
    { kind: "srt_round_trip", ok: srtOk, detail: { cues: cues.length, parsed: srtRoundTrip.length } },
    { kind: "secondary_language", ok: secondaryOk, detail: { cuesEn: cuesEn.length } },
    {
      kind: "no_punctuation",
      ok: punctuationOk,
      detail: {
        hits: punctuationHits.length,
        sample: punctuationHits.slice(0, 8),
        policy: "字幕不带标点（数字内的 . : - / 保留；纯西文字幕不强制）",
      },
    },
    { kind: "source_untouched", ok: sourceUntouched !== false, detail: { hashed: Boolean(input) } },
  ];

  const manifest = {
    schemaVersion: "workloom.subtitle-sidecar/v1",
    generatedAt: new Date().toISOString(),
    name: baseName,
    platform: outcome.plan.platform,
    resolution: outcome.plan.resolution,
    burnedIn: false,
    note: "母版不含字幕；字幕以旁挂文件交付，可后置决定『不用 / 软轨内嵌 / 硬烧』",
    source: input
      ? { path: input, sha256: beforeFingerprint.sha256, sizeBytes: beforeFingerprint.sizeBytes, untouched: sourceUntouched }
      : null,
    layout: {
      subtitleBand: textBands({ resolution: outcome.plan.resolution, layout }).subtitleBand.px,
      occlusionZones: layout.occlusion_zones ?? [],
    },
    styles: outcome.styles.map((entry) => ({ name: entry.name, ...entry.style })),
    timeline: {
      cues: cues.length,
      secondaryCues: Array.isArray(cuesEn) ? cuesEn.length : 0,
      first: cues[0] ? { start: cues[0].start, end: cues[0].end } : null,
      last: cues.at(-1) ? { start: cues.at(-1).start, end: cues.at(-1).end } : null,
      readback: { ass: timelineOk, srt: srtOk, secondary: secondaryOk },
    },
    files: files.map((file) => ({ ...file, path: path.basename(file.path) })),
    checks: checkSummary(checks),
  };
  const manifestPath = path.join(outDir, `${baseName}.subtitle-manifest.json`);
  await fsp.writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");

  return {
    name: baseName,
    outputDir: outDir,
    files,
    manifest,
    manifestPath,
    planPath: outcome.planPath,
    assText,
    cues,
    cuesEn,
    checks,
    passed: checkSummary(checks).every((check) => check.ok !== false),
  };
}

/**
 * 软字幕轨内嵌：把旁挂字幕嵌成容器里的**可开关字幕轨**（默认轨/语言标签齐备）。
 * 纪律：视频轨与音频轨一律 `-c copy`，字幕是"加一条轨"，不是"改画面"——
 * 交付前逐帧哈希比对（0.1s / 中间 / 0.9 处）证明母版画面零改动；对不上即失败并删除产物。
 */
export async function softMux({
  input,
  output,
  subtitles = [],
  bins = resolveBinaries(),
  verify = true,
}) {
  if (typeof input !== "string" || !input.trim()) throw new SubtitleError("input_path 缺失", "bad_request", false);
  if (typeof output !== "string" || !output.trim()) throw new SubtitleError("output_path 缺失", "bad_request", false);
  if (path.resolve(input) === path.resolve(output)) {
    throw new SubtitleError("禁止覆盖原片（输出路径等于输入路径）", "overwrite_source_forbidden", false);
  }
  const tracks = (Array.isArray(subtitles) ? subtitles : []).map((entry, index) => {
    const file = typeof entry === "string" ? entry : entry?.path;
    if (typeof file !== "string" || !file.trim()) throw new SubtitleError(`第 ${index + 1} 条软字幕轨缺少 path`, "bad_request", false);
    if (!fs.existsSync(file)) throw new SubtitleError(`软字幕文件不存在：${file}`, "not_found", false);
    const ext = path.extname(file).toLowerCase();
    if (![".srt", ".ass", ".ssa", ".vtt"].includes(ext)) {
      throw new SubtitleError(`软字幕文件格式不支持：${ext || "(无扩展名)"}（支持 .srt/.ass/.ssa/.vtt）`, "bad_srt", false);
    }
    const lang = String(entry?.lang ?? (index === 0 ? "chi" : "eng"));
    return {
      path: file,
      ext,
      lang,
      title: String(entry?.title ?? (lang === "chi" ? "中文" : "English")),
      default: entry?.default ?? index === 0,
    };
  });
  if (tracks.length === 0) throw new SubtitleError("软字幕轨至少需要一条字幕文件", "bad_request", false);
  if (verify === false) {
    throw new SubtitleError("软字幕交付必须带画面零改动复检（关闭校验的调用禁止执行，围栏 G-SUB3）", "bad_request", false);
  }

  const container = path.extname(output).toLowerCase();
  if (![".mp4", ".mkv", ".mov"].includes(container)) {
    throw new SubtitleError(`软字幕输出容器不支持：${container || "(无扩展名)"}（支持 .mp4/.mkv/.mov）`, "bad_request", false);
  }
  const subtitleCodec = container === ".mov" ? "mov_text" : container === ".mp4" ? "mov_text" : null;
  const probe = await probeMedia(input, { bins });
  await fsp.mkdir(path.dirname(path.resolve(output)), { recursive: true });

  const beforeVideo = await streamSignature(input, { bins, kind: "video" });
  const beforeAudio = await streamSignature(input, { bins, kind: "audio" });

  const args = ["-hide_banner", "-v", "error", "-y", "-i", input];
  for (const track of tracks) args.push("-i", track.path);
  args.push("-map", "0");
  tracks.forEach((_, index) => args.push("-map", `${index + 1}:0`));
  args.push("-c:v", "copy");
  if (probe.hasAudio) args.push("-c:a", "copy");
  if (subtitleCodec) args.push("-c:s", subtitleCodec);
  else args.push("-c:s", "copy");
  tracks.forEach((track, index) => {
    args.push(`-metadata:s:s:${index}`, `language=${track.lang}`);
    args.push(`-metadata:s:s:${index}`, `title=${track.title}`);
  });
  if (container === ".mp4") args.push("-movflags", "+faststart");
  args.push(output);
  await runBin(bins.ffmpeg, args, { label: "ffmpeg(softmux)", timeoutMs: 600_000 });
  if (!fs.existsSync(output)) throw new SubtitleError(`软字幕内嵌未产出文件：${output}`, "ffmpeg_failed", true);

  const afterVideo = await streamSignature(output, { bins, kind: "video", at: beforeVideo.frames.map((frame) => frame.at) });
  const afterAudio = await streamSignature(output, { bins, kind: "audio" });
  const outputProbe = await probeMedia(output, { bins });
  const outputStreams = JSON.parse((await runBin(bins.ffprobe, [
    "-v", "error", "-print_format", "json", "-show_streams", output,
  ], { label: "ffprobe" })).stdout);
  const outputSubtitleStreams = (outputStreams.streams ?? [])
    .filter((stream) => stream.codec_type === "subtitle")
    .map((stream) => ({
      codec: stream.codec_name ?? null,
      lang: stream.tags?.language ?? null,
      title: stream.tags?.title ?? null,
      index: stream.index,
    }));

  const videoUnchanged = signaturesEqual(beforeVideo, afterVideo);
  const audioUnchanged = signaturesEqual(beforeAudio, afterAudio);
  const durationOk = Math.abs((outputProbe.duration ?? 0) - (probe.duration ?? 0)) <= 0.15;
  const tracksOk = outputSubtitleStreams.length === tracks.length;
  const checks = [
    { kind: "video_unchanged", ok: videoUnchanged, detail: { before: beforeVideo, after: afterVideo } },
    { kind: "audio_unchanged", ok: audioUnchanged, detail: { before: beforeAudio, after: afterAudio } },
    { kind: "duration_kept", ok: durationOk, detail: { source: probe.duration, output: outputProbe.duration } },
    { kind: "subtitle_tracks", ok: tracksOk, detail: { expected: tracks.length, actual: outputSubtitleStreams.length, streams: outputSubtitleStreams } },
  ];
  const failed = checks.filter((check) => check.ok !== true);
  if (failed.length) {
    await fsp.rm(output, { force: true });
    throw new SubtitleError(
      `软字幕内嵌复检失败（${failed.map((check) => check.kind).join("、")}）：已删除产物，母版未受影响`,
      "verify_failed",
      false,
    );
  }

  return {
    input,
    output,
    container,
    subtitleCodec: subtitleCodec ?? "copy",
    tracks: tracks.map((track, index) => ({ ...track, index: outputSubtitleStreams[index]?.index ?? null, lang: outputSubtitleStreams[index]?.lang ?? track.lang })),
    probe: outputProbe,
    sha256: await sha256File(output),
    defaultTrack: tracks.findIndex((track) => track.default) ?? 0,
    checks,
  };
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
        secondaryCues: resolveCues({ srt_path: params.srt_path_en ?? undefined, srt_text: params.srt_text_en ?? undefined }),
        secondaryLabel: String(params.secondary_label ?? "EN"),
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

    case "subtitlewrite.danmaku": {
      const input = assertPathAllowed(text(params.input_path, "input_path"), roots, "input_path");
      const output = assertPathAllowed(text(params.output_path, "output_path"), roots, "output_path");
      const items = Array.isArray(params.items) ? params.items : params.danmaku_path
        ? JSON.parse(fs.readFileSync(assertPathAllowed(String(params.danmaku_path), roots, "danmaku_path"), "utf8"))
        : [];
      const report = await renderDanmaku({
        input,
        output,
        items,
        platform: params.platform ?? null,
        brief: resolveBrief(params),
        fontsDir: params.fonts_dir ? assertPathAllowed(String(params.fonts_dir), roots, "fonts_dir") : fontRoot,
        evidenceDir: optionalPath(params.evidence_dir, "evidence_dir"),
        bins,
        catalog,
        opacity: optionalNumber(params.opacity) ?? 0.85,
        maxChars: optionalNumber(params.max_chars) ?? 20,
        maxConcurrent: optionalNumber(params.max_concurrent) ?? 8,
        windowSec: optionalNumber(params.window_sec) ?? 1,
        lanes: optionalNumber(params.lanes) ?? 8,
        skipVerify: params.skip_verify === true || params.verify === false,
      });
      return {
        result: { ...report, output_path: report.output.path, sha256: report.output.hash },
        receipt: {
          synced: true,
          snapshot_uri: `subtitle://danmaku/${path.basename(report.output.path)}?sha256=${report.output.hash}`,
          sha256: report.output.hash,
          verified_at: new Date().toISOString(),
        },
      };
    }

    case "subtitlewrite.sticker": {
      const input = assertPathAllowed(text(params.input_path, "input_path"), roots, "input_path");
      const output = assertPathAllowed(text(params.output_path, "output_path"), roots, "output_path");
      const report = await renderSticker({
        input,
        output,
        stickers: Array.isArray(params.stickers) ? params.stickers : [],
        platform: params.platform ?? null,
        brief: resolveBrief(params),
        fontsDir: params.fonts_dir ? assertPathAllowed(String(params.fonts_dir), roots, "fonts_dir") : fontRoot,
        evidenceDir: optionalPath(params.evidence_dir, "evidence_dir"),
        bins,
        catalog,
        skipVerify: params.skip_verify === true || params.verify === false,
      });
      return {
        result: { ...report, output_path: report.output.path, sha256: report.output.hash },
        receipt: {
          synced: true,
          snapshot_uri: `subtitle://sticker/${path.basename(report.output.path)}?sha256=${report.output.hash}`,
          sha256: report.output.hash,
          verified_at: new Date().toISOString(),
        },
      };
    }

    case "subtitlewrite.karaoke": {
      const input = assertPathAllowed(text(params.input_path, "input_path"), roots, "input_path");
      const output = assertPathAllowed(text(params.output_path, "output_path"), roots, "output_path");
      const report = await renderKaraoke({
        input,
        output,
        cues: resolveCues(params),
        timings: Array.isArray(params.timings) ? params.timings : null,
        timingMode: params.timing_mode === "explicit" ? "explicit" : "even",
        secondaryCues: resolveCues({ srt_path: params.srt_path_en ?? undefined, srt_text: params.srt_text_en ?? undefined }),
        secondaryLabel: String(params.secondary_label ?? "EN"),
        platform: params.platform ?? null,
        brief: resolveBrief(params),
        fontsDir: params.fonts_dir ? assertPathAllowed(String(params.fonts_dir), roots, "fonts_dir") : fontRoot,
        evidenceDir: optionalPath(params.evidence_dir, "evidence_dir"),
        bins,
        catalog,
        highlightColour: typeof params.highlight_colour === "string" ? params.highlight_colour : "#FFE066",
        skipVerify: params.skip_verify === true || params.verify === false,
      });
      return {
        result: { ...report, output_path: report.output.path, sha256: report.output.hash },
        receipt: {
          synced: true,
          snapshot_uri: `subtitle://karaoke/${path.basename(report.output.path)}?sha256=${report.output.hash}`,
          sha256: report.output.hash,
          verified_at: new Date().toISOString(),
        },
      };
    }

    case "subtitlewrite.sidecar": {
      const input = params.input_path ? assertPathAllowed(String(params.input_path), roots, "input_path") : null;
      const outputDir = assertPathAllowed(text(params.output_dir, "output_dir"), roots, "output_dir");
      const cues = resolveCues(params);
      const cuesEn = resolveCues({ srt_path: params.srt_path_en ?? undefined, srt_text: params.srt_text_en ?? undefined });
      const outcome = await exportSidecars({
        input,
        outputDir,
        name: typeof params.name === "string" ? params.name : null,
        cues,
        cuesEn,
        platform: params.platform ?? null,
        brief: resolveBrief(params),
        titleText: params.title_text ?? "",
        fontsDir: params.fonts_dir ? assertPathAllowed(String(params.fonts_dir), roots, "fonts_dir") : fontRoot,
        evidenceDir: optionalPath(params.evidence_dir, "evidence_dir"),
        bins,
        catalog,
        analyze: params.analyze !== false,
      });
      const primary = outcome.files.find((file) => file.format === "ass") ?? outcome.files[0];
      return {
        result: {
          name: outcome.name,
          output_dir: outcome.outputDir,
          files: outcome.files,
          manifest: outcome.manifest,
          manifest_path: outcome.manifestPath,
          plan_path: outcome.planPath,
          cues: outcome.cues.length,
          cues_secondary: outcome.cuesEn.length,
          checks: checkSummary(outcome.checks),
          passed: outcome.passed,
          burned_in: false,
        },
        receipt: {
          synced: true,
          snapshot_uri: `subtitle://sidecar/${path.basename(primary.path)}?sha256=${primary.sha256}`,
          sha256: primary.sha256,
          verified_at: new Date().toISOString(),
        },
      };
    }

    case "subtitlewrite.softmux": {
      const input = assertPathAllowed(text(params.input_path, "input_path"), roots, "input_path");
      const output = assertPathAllowed(text(params.output_path, "output_path"), roots, "output_path");
      if (params.verify === false || params.skip_verify === true) {
        throw new SubtitleError("软字幕交付必须带画面零改动复检（G-SUB3）", "bad_request", false);
      }
      const tracks = Array.isArray(params.subtitles)
        ? params.subtitles.map((entry) => {
          if (typeof entry === "string") return { path: assertPathAllowed(entry, roots, "subtitles[]") };
          const file = assertPathAllowed(text(entry?.path, "subtitles[].path"), roots, "subtitles[].path");
          return { ...entry, path: file };
        })
        : [];
      const report = await softMux({ input, output, subtitles: tracks, bins });
      return {
        result: {
          ...report,
          output_path: report.output,
          video_unchanged: true,
          note: "字幕是可开关的字幕轨；画面与声音轨逐帧 copy，母版零改动",
        },
        receipt: {
          synced: true,
          snapshot_uri: `subtitle://softmux/${path.basename(report.output)}?sha256=${report.sha256}`,
          sha256: report.sha256,
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
