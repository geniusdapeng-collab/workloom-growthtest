/**
 * cover-kb-bridge · 封面知识库连接器内核（2026-09-27）
 *
 * 解决的问题：封面链路此前只有 9:16 单一口径与"模型自由发挥"的行业 know-how——
 * 同一支片子在小红书应该出 3:4、在 B 站应该出 16:9，账号该锁字体色板，题材该决定版式与钩子，
 * 这些判据以前不在链路里。本模块让封面设计师（cover-designer）出稿前**去封面知识库走一圈**，
 * 按「平台 × 题材 × 账号类型」取确定性的知识条目，注入设计稿 prompt（≤3 条，带 trace）。
 *
 * 与全仓口径一致（仿 cine-kb-bridge）：
 *   · 知识库形态：`bundles/ai-video/library/cover-kb/*.md`（14 篇九章式 + `_INDEX.md`）；
 *   · **确定性检索 + 规则注入，无向量/RAG**；
 *   · 平台数字（画幅/安全区/标题带/字数上限）的最终口径是代码
 *     `packages/video-studio/src/cover-platforms.ts`——本模块从调用方接收该规格（`spec`），
 *     缺省时回退到 KB 篇目里的数值并标注 `source: "kb"`（**矛盾闸：代码规格优先**）；
 *   · 缺口不静默：缺篇/缺行/零命中都会如实报出（`health` / `fallback`）。
 */

import fs from "node:fs";
import path from "node:path";

/** 章节编号（一…九）→ 语义名（与全库九章式结构对齐） */
const CHAPTER_NAMES = [
  "核心概念", "分类速查", "分场景实战", "平台参数速查", "常见误区", "意图→设计映射表", "设计模板", "决策树", "关联知识"
];
const NUMERALS = ["一", "二", "三", "四", "五", "六", "七", "八", "九"];

/** 平台 ID → 平台篇编号（一期 8 平台） */
export const PLATFORM_KB_IDS = {
  douyin: "PLAT-001",
  kuaishou: "PLAT-002",
  xiaohongshu: "PLAT-003",
  "wechat-channels": "PLAT-004",
  bilibili: "PLAT-005",
  tiktok: "PLAT-006",
  youtube: "PLAT-006",
  "instagram-reels": "PLAT-006"
};

/** 账号类型归一（中文标签 / 英文 ID 都收） */
const ACCOUNT_TYPE_ALIASES = {
  "人设IP号": "ip", "人设ip号": "ip", "ip": "ip", "人设号": "ip",
  "品牌官号": "brand", "brand": "brand", "品牌号": "brand",
  "种草号": "seeding", "seeding": "seeding", "种草": "seeding",
  "知识号": "knowledge", "knowledge": "knowledge",
  "本地生活号": "local", "local": "local", "本地号": "local"
};

/** HOOK-001 的 7 个公式 ID（hook_bias 必须取自这里） */
export const HOOK_FORMULA_IDS = [
  "question", "conflict", "data-shock", "contrast", "value-preview", "curiosity-gap", "pattern-interrupt"
];

/** 账号类型 → 注入时的额外提示（ACCT-001 五类账号的一致性策略） */
const ACCOUNT_TYPE_NOTE = {
  ip: "人设IP号：固定人物+固定景别，person-led 为主",
  brand: "品牌官号：VI 色板优先、logo 角标位固定",
  seeding: "种草号：产品满幅货架感，subject-led",
  knowledge: "知识号：讲师 person-led 或图表 subject-led，账号级锁定一种",
  local: "本地生活号：门头/招牌菜/地标三选一作固定主体"
};

/* ================= 解析 ================= */

/** 解析索引页：主题表（编号/主题/一句话用途/触发关键词） */
export function parseIndex(markdown) {
  const topics = [];
  for (const line of markdown.split("\n")) {
    const m = line.match(/^\|\s*([A-Z]+-\d{3})\s*\|\s*([^|]+?)\s*\|\s*([^|]+?)\s*\|\s*([^|]+?)\s*\|\s*$/);
    if (!m) continue;
    topics.push({
      id: m[1].trim(),
      title: m[2].trim(),
      purpose: m[3].trim(),
      keywords: m[4].split(/[、,，/]/).map((s) => s.trim()).filter(Boolean)
    });
  }
  const callHints = [];
  let inHintBlock = false;
  for (const line of markdown.split("\n")) {
    if (/^##\s*Agent 调用建议/.test(line)) { inHintBlock = true; continue; }
    if (inHintBlock && /^##\s/.test(line)) inHintBlock = false;
    if (inHintBlock) {
      const m = line.match(/^\d+\.\s*(.+)$/);
      if (m) callHints.push(m[1].trim());
    }
  }
  return { topics, callHints };
}

/** markdown 表格行 → 单元格数组（跳过表头分隔行） */
function tableRows(body) {
  const rows = [];
  for (const line of body.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("|")) continue;
    if (/^\|\s*[-: ]+\|/.test(trimmed)) continue;
    const cells = trimmed.replace(/^\|/, "").replace(/\|$/, "").split("|").map((c) => c.trim().replace(/\*\*/g, ""));
    rows.push(cells);
  }
  return rows;
}

/** 解析单篇：元数据 + 章节 + 第四章参数速查 + 第五章误区 + 第六章映射表 */
export function parseTopic(markdown, file) {
  const id = path.basename(file).match(/^([A-Z]+-\d{3})/)?.[1] ?? path.basename(file, ".md");
  /** 标题去掉篇首的编号（`# PLAT-001 抖音封面规范` → `抖音封面规范`），避免索引里编号出现两次 */
  const rawTitle = (markdown.match(/^#\s+(.+)$/m)?.[1] ?? path.basename(file, ".md")).trim();
  const title = rawTitle.replace(new RegExp(`^${id}\\s*`), "").trim() || rawTitle;
  const version = markdown.match(/版本\s*(v[\d.]+)/)?.[1] ?? null;

  const marks = [];
  const chapterRe = /^##\s+([一二三四五六七八九十]+)[、.]\s*(.+)$/gm;
  let m;
  while ((m = chapterRe.exec(markdown)) !== null) marks.push({ index: m.index, numeral: m[1], title: m[2].trim() });
  const chapters = marks.map((mark, i) => {
    const end = i + 1 < marks.length ? marks[i + 1].index : markdown.length;
    const body = markdown.slice(mark.index, end);
    const semanticIndex = NUMERALS.indexOf(mark.numeral);
    return {
      numeral: mark.numeral,
      title: mark.title,
      semantic: semanticIndex >= 0 ? CHAPTER_NAMES[semanticIndex] : mark.title,
      rows: tableRows(body).length,
      body
    };
  });
  const chapterBy = (numeral) => chapters.find((c) => c.numeral === numeral) ?? null;

  /**
   * §四 参数速查：
   *   · 单平台篇 = `| 参数 | 口径 |` 两列表；
   *   · PLAT-006（海外三平台）= `| 参数 | TikTok | YouTube | Instagram Reels |` 矩阵表，
   *     必须按平台列取值，否则会把 TikTok 的数字当成 YouTube 的（health 交叉核对会误报）。
   */
  let params = [];
  let paramMatrix = null;
  const paramChapter = chapterBy("四");
  if (paramChapter) {
    const rows = tableRows(paramChapter.body);
    const header = rows[0] ?? [];
    if (header.length >= 4 && /TikTok|YouTube|Instagram/i.test(header.join(" "))) {
      paramMatrix = { header, rows: rows.slice(1) };
    } else {
      for (const cells of rows) {
        if (cells.length < 2) continue;
        if (/^参数$/.test(cells[0]) && /口径|平台/.test(cells[1])) continue;
        params.push({ key: cells[0], value: cells[1] });
      }
    }
  }

  /** §五 常见误区：`| 误区 | 后果 | 正确做法 |` */
  const pitfalls = [];
  const pitfallChapter = chapterBy("五");
  if (pitfallChapter) {
    for (const cells of tableRows(pitfallChapter.body)) {
      if (cells.length < 3) continue;
      if (cells[0] === "误区") continue;
      pitfalls.push({ mistake: cells[0], consequence: cells[1], correct: cells[2] });
    }
  }

  /**
   * §六 意图→设计映射表（核心调用区）：三列表（意图 / 设计动作 / 判据）。
   * PLAT-006 是**多平台对比表**（4 列：参数 | TikTok | YouTube | Instagram Reels），单独识别为 matrix。
   */
  const mapping = [];
  const matrix = [];
  const mappingChapter = chapterBy("六");
  if (mappingChapter) {
    const rows = tableRows(mappingChapter.body);
    const isMatrix = rows.length > 0 && rows[0].length >= 4 && /TikTok|YouTube|Instagram/i.test(rows[0].join(" "));
    for (const cells of rows) {
      if (cells.length >= 4 && isMatrix) { matrix.push(cells); continue; }
      if (cells.length < 3) continue;
      if (/用户意图|意图\/题材|意图|场景\/意图/.test(cells[0]) && /设计动作|动作/.test(cells[1])) continue;
      mapping.push({ intent: cells[0], action: cells[1], criteria: cells[2] });
    }
  }

  /** §八 决策树（原文保留：Agent 需要按分支走） */
  const decisionTree = chapterBy("八")?.body ?? "";

  return {
    id,
    title,
    file: path.basename(file),
    version,
    chapters: chapters.map((c) => ({ numeral: c.numeral, title: c.title, semantic: c.semantic, rows: c.rows })),
    params,
    paramMatrix,
    pitfalls,
    mapping,
    matrix,
    decisionTree,
    bytes: Buffer.byteLength(markdown, "utf8")
  };
}

/** 装载整库（含缺篇/空映射检测） */
export function loadKb(kbDir) {
  if (!fs.existsSync(kbDir)) throw new Error(`封面知识库目录不存在：${kbDir}`);
  const files = fs.readdirSync(kbDir).filter((f) => f.endsWith(".md") && f !== "_INDEX.md").sort();
  const indexFile = path.join(kbDir, "_INDEX.md");
  const index = fs.existsSync(indexFile)
    ? parseIndex(fs.readFileSync(indexFile, "utf8"))
    : { topics: [], callHints: [] };
  const topics = files.map((f) => parseTopic(fs.readFileSync(path.join(kbDir, f), "utf8"), f));
  const presentIds = new Set(topics.map((t) => t.id));
  const missing = index.topics.filter((t) => !presentIds.has(t.id)).map((t) => ({ id: t.id, title: t.title, purpose: t.purpose }));
  const untracked = topics.filter((t) => !index.topics.some((i) => i.id === t.id)).map((t) => t.id);
  const byId = Object.fromEntries(topics.map((t) => [t.id, t]));
  return {
    dir: kbDir,
    index,
    topics,
    byId,
    missingTopics: missing,
    untrackedTopics: untracked,
    bytes: topics.reduce((sum, t) => sum + t.bytes, 0)
  };
}

/** 库健康度（health 命令与链路自检共用） */
export function kbStatus(kb) {
  const withoutMapping = kb.topics.filter((t) => t.mapping.length === 0 && t.matrix.length === 0).map((t) => t.id);
  /** §四 允许是单平台两列表或 PLAT-006 的多平台矩阵表（参数行数按矩阵行计） */
  const withoutParams = kb.topics
    .filter((t) => t.params.length === 0 && !(t.paramMatrix && t.paramMatrix.rows.length > 0))
    .map((t) => t.id);
  const duplicateIds = kb.topics.map((t) => t.id).filter((id, i, all) => all.indexOf(id) !== i);
  return {
    ok: kb.missingTopics.length === 0 && kb.untrackedTopics.length === 0
      && withoutMapping.length === 0 && withoutParams.length === 0 && duplicateIds.length === 0,
    dir: kb.dir,
    topics: kb.topics.length,
    mappingRows: kb.topics.reduce((sum, t) => sum + t.mapping.length + t.matrix.length, 0),
    paramRows: kb.topics.reduce((sum, t) => sum + t.params.length, 0),
    bytes: kb.bytes,
    missingTopics: kb.missingTopics,
    untrackedTopics: kb.untrackedTopics,
    topicsWithEmptyMappings: withoutMapping,
    topicsWithEmptyParams: withoutParams,
    duplicateIds
  };
}

/* ================= 检索（确定性） ================= */

/** 中文 2-gram（无分词依赖的粗粒度重合度） */
function bigrams(text) {
  const clean = String(text ?? "").replace(/[\s|`*#>（）、，。？！：；「」【】…—–-]/g, "");
  const out = new Set();
  for (let i = 0; i + 1 < clean.length; i += 1) out.add(clean.slice(i, i + 2));
  return out;
}

function overlapScore(a, b) {
  if (a.size === 0 || b.size === 0) return 0;
  let hit = 0;
  for (const gram of a) if (b.has(gram)) hit += 1;
  return hit / Math.max(1, Math.min(a.size, b.size));
}

/**
 * 意图检索：命中"篇目 + 相关条目（参数行/映射行/误区行）"。
 * 排序权重：索引触发关键词 > 篇目标题 > 参数行 > 映射行 > 误区行。
 */
export function searchKb(kb, keyword, options = {}) {
  const query = String(keyword ?? "").trim();
  const top = Number.isFinite(options.top) ? Number(options.top) : 3;
  if (!query) return { query, hits: [] };
  const qGrams = bigrams(query);
  const scored = [];
  for (const topic of kb.topics) {
    const indexEntry = kb.index.topics.find((t) => t.id === topic.id);
    let score = 0;
    const reasons = [];
    if (indexEntry && indexEntry.keywords.some((k) => query.includes(k) || k.includes(query))) {
      score += 3; reasons.push("索引关键词");
    }
    if (topic.title.includes(query) || query.includes(topic.title)) { score += 3; reasons.push("篇目标题"); }
    score += overlapScore(qGrams, bigrams(topic.title)) * 2;
    const rows = [];
    const consider = (items, kind, textOf, weight) => {
      for (const item of items) {
        const text = textOf(item);
        const local = overlapScore(qGrams, bigrams(text));
        if (local >= 0.34 || text.includes(query)) {
          score += weight * (0.6 + local);
          rows.push({ kind, text: text.slice(0, 200) });
        }
      }
    };
    consider(topic.params, "param", (p) => `${p.key} ${p.value}`, 2);
    consider(topic.mapping, "mapping", (r) => `${r.intent} ${r.action} ${r.criteria}`, 1.6);
    consider(topic.pitfalls, "pitfall", (r) => `${r.mistake} ${r.correct}`, 1.2);
    if (score > 0) {
      scored.push({
        kbId: topic.id,
        title: topic.title,
        score: Number(score.toFixed(2)),
        reasons,
        entries: rows.slice(0, 4)
      });
    }
  }
  scored.sort((a, b) => b.score - a.score);
  return { query, hits: scored.slice(0, Math.max(1, top)) };
}

/** PLAT-006 矩阵表：平台 ID → 列名（列名取自 _INDEX/篇目标题） */
const MATRIX_COLUMN_NAMES = {
  tiktok: "TikTok",
  youtube: "YouTube",
  "instagram-reels": "Instagram Reels"
};

/** 从 §四 表里取该平台的参数行（矩阵表按列取值） */
function paramsForPlatform(topic, platformId) {
  if (!topic) return [];
  if (!topic.paramMatrix) return topic.params;
  const wanted = MATRIX_COLUMN_NAMES[String(platformId).trim()] ?? "";
  const column = topic.paramMatrix.header.findIndex((h) => wanted && h.toLowerCase().includes(wanted.toLowerCase()));
  if (column < 0) return [];
  return topic.paramMatrix.rows
    .filter((row) => row.length > column && row[0])
    .map((row) => ({ key: row[0], value: row[column] }));
}

/** 平台规范直取（PLAT-00x §四 全文参数 + §五 头号误区 + §六 前两条映射） */
export function platformProfile(kb, platformId) {
  const kbId = PLATFORM_KB_IDS[String(platformId ?? "").trim()];
  const topic = kbId ? kb.byId[kbId] : null;
  if (!topic) return null;
  return {
    platformId: String(platformId).trim(),
    kbId: topic.id,
    title: topic.title,
    params: paramsForPlatform(topic, platformId),
    topPitfall: topic.pitfalls[0] ?? null,
    mappingSamples: topic.mapping.slice(0, 2),
    matrix: topic.matrix
  };
}

/** 平台篇 §四 里的数字口径（供 health 与代码规格交叉核对） */
export function platformParamsFromKb(kb, platformId) {
  const profile = platformProfile(kb, platformId);
  if (!profile) return null;
  const read = (label) => {
    const row = profile.params.find((p) => p.key.includes(label));
    if (!row) return null;
    const percent = /(\d+(?:\.\d+)?)\s*%/.exec(row.value);
    const ratio = /(\d+)\s*[:：]\s*(\d+)/.exec(row.value);
    const size = /(\d{3,4})\s*×\s*(\d{3,4})/.exec(row.value);
    return {
      raw: row.value,
      percent: percent ? Number(percent[1]) : null,
      ratio: ratio ? `${Number(ratio[1])}:${Number(ratio[2])}` : null,
      size: size ? { width: Number(size[1]), height: Number(size[2]) } : null
    };
  };
  return {
    kbId: profile.kbId,
    ratio: read("画幅"),
    canvas: read("画布尺寸"),
    top: read("顶部安全区"),
    bottom: read("底部遮挡区"),
    titleBand: read("标题带")
  };
}

/**
 * 解析 `packages/video-studio/src/cover-platforms.ts` 的规格（health 的"代码事实"侧）。
 * 只做**文本抽取**（B 级机检），用于发现"KB 与代码漂移"，不参与运行时判据。
 */
export function parsePlatformSpecsFromTs(source) {
  const specs = {};
  const idRe = /id:\s*"([a-z][a-z0-9-]*)"/g;
  const marks = [];
  let m;
  while ((m = idRe.exec(source)) !== null) marks.push({ id: m[1], index: m.index });
  marks.forEach((mark, i) => {
    const block = source.slice(mark.index, i + 1 < marks.length ? marks[i + 1].index : source.length);
    const num = (re) => {
      const hit = re.exec(block);
      return hit ? Number(hit[1]) : null;
    };
    specs[mark.id] = {
      ratio: /ratio:\s*"(\d+:\d+)"/.exec(block)?.[1] ?? null,
      width: num(/canvas:\s*\{\s*width:\s*(\d+)/),
      height: num(/canvas:\s*\{\s*width:\s*\d+,\s*height:\s*(\d+)/),
      bottom: num(/bottomReservedRatio:\s*([\d.]+)/),
      top: num(/topMinRatio:\s*([\d.]+)/),
      titleTop: num(/titleBand:\s*\{\s*topRatio:\s*([\d.]+)/),
      titleBottom: num(/bottomMaxRatio:\s*([\d.]+)/),
      headlineMaxChars: num(/headlineMaxChars:\s*(\d+)/),
      language: /language:\s*"(zh|en)"/.exec(block)?.[1] ?? null
    };
  });
  return specs;
}

/** KB §四 ↔ 代码规格的漂移核对（返回逐平台差异清单） */
export function crossCheckPlatformSpecs(kb, tsSource) {
  const code = parsePlatformSpecsFromTs(tsSource);
  const rows = [];
  for (const platformId of Object.keys(PLATFORM_KB_IDS)) {
    const kbSpec = platformParamsFromKb(kb, platformId);
    const codeSpec = code[platformId];
    if (!kbSpec || !codeSpec) continue;
    const diffs = [];
    if (kbSpec.canvas?.size && (kbSpec.canvas.size.width !== codeSpec.width || kbSpec.canvas.size.height !== codeSpec.height)) {
      diffs.push(`画布 KB ${kbSpec.canvas.size.width}×${kbSpec.canvas.size.height} vs 代码 ${codeSpec.width}×${codeSpec.height}`);
    }
    if (kbSpec.bottom?.percent !== null && codeSpec.bottom !== null
      && Math.abs(kbSpec.bottom.percent / 100 - codeSpec.bottom) > 0.005) {
      diffs.push(`底部遮挡 KB ${kbSpec.bottom.percent}% vs 代码 ${(codeSpec.bottom * 100).toFixed(0)}%`);
    }
    if (kbSpec.top?.percent !== null && codeSpec.top !== null
      && Math.abs(kbSpec.top.percent / 100 - codeSpec.top) > 0.005) {
      diffs.push(`顶部安全区 KB ${kbSpec.top.percent}% vs 代码 ${(codeSpec.top * 100).toFixed(0)}%`);
    }
    rows.push({ platformId, kbId: kbSpec.kbId, diffs });
  }
  return rows;
}

/* ================= 题材 / 配方 ================= */

/** 列 THEME-001 参数速查里的题材（不含"知识科普（图表）"这类括注变体） */
export function listThemes(kb) {
  const theme = kb.byId["THEME-001"];
  if (!theme) return [];
  return theme.params
    .map((row) => row.key)
    .filter((key) => key && !/^(题材|标题字数硬口径|字高比口径)$/.test(key))
    .map((key) => key.replace(/（[^）]*）/g, "").trim())
    .filter((key, i, all) => key && all.indexOf(key) === i);
}

/** 题材 → THEME-001 行（含括注变体时优先取精确匹配） */
export function themeRow(kb, theme) {
  const topic = kb.byId["THEME-001"];
  if (!topic) return null;
  const wanted = String(theme ?? "").trim();
  if (!wanted) return null;
  const rows = topic.params;
  return rows.find((r) => r.key === wanted)
    ?? rows.find((r) => r.key.includes(wanted))
    ?? rows.find((r) => wanted.includes(r.key.replace(/（[^）]*）/g, "").trim()))
    ?? null;
}

/** 配色/字体映射（THEME-002 §三/§四） */
export function themePaletteRow(kb, theme) {
  const topic = kb.byId["THEME-002"];
  if (!topic) return null;
  const wanted = String(theme ?? "").trim();
  if (!wanted) return null;
  return topic.mapping.find((r) => r.intent.includes(wanted) || wanted.includes(r.intent.split("·")[0]))
    ?? null;
}

/** 钩子短名单（HOOK-001 §四，按账号偏好过滤） */
export function hookShortlist(kb, preferences = []) {
  const topic = kb.byId["HOOK-001"];
  if (!topic) return [];
  const wanted = (Array.isArray(preferences) ? preferences : []).map((p) => String(p).trim()).filter(Boolean);
  const rows = topic.params.filter((r) => HOOK_FORMULA_IDS.includes(r.key));
  const picked = wanted.length > 0 ? rows.filter((r) => wanted.includes(r.key)) : rows;
  return (picked.length > 0 ? picked : rows).map((r) => ({
    id: r.key,
    structure: r.value,
    budget: r.value.includes("词") ? "词" : "字"
  }));
}

/** 组合配方：平台参数 + 题材版式 + 钩子短名单 */
export function recipe(kb, { platform, theme, accountType } = {}) {
  const profile = platformProfile(kb, platform);
  const normalizedType = ACCOUNT_TYPE_ALIASES[String(accountType ?? "").trim()] ?? null;
  return {
    platform: profile,
    theme: themeRow(kb, theme),
    palette: themePaletteRow(kb, theme),
    hooks: hookShortlist(kb),
    accountType: normalizedType,
    accountNote: normalizedType ? ACCOUNT_TYPE_NOTE[normalizedType] : null,
    fallback: !profile
  };
}

/* ================= 注入载荷（≤3 条 + trace） ================= */

/** 从 §四 参数行拼"平台速查一句话"（数字以调用方给的代码规格为准） */
function platformHint(profile, spec) {
  const bits = [];
  if (spec) {
    bits.push(`${spec.ratio} 画幅 ${spec.canvas.width}×${spec.canvas.height}`);
    bits.push(`标题带 ${(spec.titleBand.topRatio * 100).toFixed(0)}%–${(spec.titleBand.bottomMaxRatio * 100).toFixed(0)}%`);
    bits.push(`底部遮挡 ${(spec.safeArea.bottomReservedRatio * 100).toFixed(0)}% 不放字`);
    if (spec.safeArea.rightRailRatio > 0) bits.push(`右侧栏 ${(spec.safeArea.rightRailRatio * 100).toFixed(0)}% 避让`);
    bits.push(spec.language === "en"
      ? `英文标题 ≤${spec.headlineMaxChars} 词`
      : `主标题 ≤${spec.headlineMaxChars} 字`);
  } else {
    for (const key of ["画幅", "画布尺寸", "标题带", "底部遮挡区"]) {
      const row = profile.params.find((p) => p.key.includes(key));
      if (row) bits.push(`${key}：${row.value}`);
    }
  }
  const tone = profile.params.find((p) => p.key.includes("文案调性"))?.value;
  if (tone) bits.push(`文案调性：${tone}`);
  if (!spec) bits.push("（数值取自 KB，链内以代码规格为准）");
  return `【封面知识库·${profile.kbId}§4】${profile.title}：${bits.join("；")}`;
}

/**
 * 注入载荷（**≤3 条**，确定性规则 + 自由检索两路）：
 *   ① 平台规范（必有，代码规格优先）；
 *   ② 题材映射（THEME-001 版式/构图/字级；有 theme 时）或钩子公式（无 theme 时）；
 *   ③ 账号视觉锤（ACCT-001，有 accountType/hookBias 时）或配色字体（THEME-002）。
 * 返回 { hints, trace, fallback, notes, conflicts }：
 *   · trace 每条带 kbId/section/reason，落 stages.jsonl（无 trace 视为未注入）；
 *   · conflicts 记录"KB 数字与代码规格不一致"的条目（以代码为准，冲突进提案池）。
 */
export function enrichCoverHints(kb, options = {}) {
  const platformId = String(options.platformId ?? options.platform ?? "").trim();
  const spec = options.spec ?? null;
  const theme = String(options.theme ?? "").trim();
  const accountType = ACCOUNT_TYPE_ALIASES[String(options.accountType ?? "").trim()] ?? null;
  const hookBias = (Array.isArray(options.hookBias) ? options.hookBias : []).filter((id) => HOOK_FORMULA_IDS.includes(id));
  const unknownHooks = (Array.isArray(options.hookBias) ? options.hookBias : []).filter((id) => id && !HOOK_FORMULA_IDS.includes(id));
  const maxHints = Number.isFinite(options.maxHints) ? Number(options.maxHints) : 3;

  const profile = platformProfile(kb, platformId);
  /** 条目与 trace **一一对应**（切到 ≤3 条时不会出现"有 hint 无 trace / 有 trace 无 hint"） */
  const entries = [];
  const notes = [];
  const conflicts = [];
  if (unknownHooks.length > 0) notes.push(`账号 hook_bias 未收录的公式 ID（已忽略）：${unknownHooks.join("、")}`);
  if (!profile) {
    return {
      hints: [], trace: [], fallback: true, platformId, source: "none",
      notes: [...notes, `平台 "${platformId}" 在 cover-kb 里没有对应篇目（允许无 KB 出稿，退化为现有行为）`],
      conflicts
    };
  }

  /** 矛盾闸：KB §四 与代码规格比对，冲突时以代码为准并把差异留痕 */
  if (spec) {
    const kbSpec = platformParamsFromKb(kb, platformId);
    const push = (label, kbValue, codeValue) => {
      if (kbValue === null || kbValue === undefined || kbValue === "" ) return;
      if (codeValue === null || codeValue === undefined || codeValue === "") return;
      if (String(kbValue) !== String(codeValue)) conflicts.push(`${profile.kbId} ${label}：KB=${kbValue}，代码=${codeValue}（以代码为准）`);
    };
    push("画幅", kbSpec?.ratio?.ratio, spec.ratio);
    const kbBottom = kbSpec?.bottom?.percent;
    const kbTop = kbSpec?.top?.percent;
    push("底部遮挡", typeof kbBottom === "number" ? `${kbBottom}%` : null,
      `${(spec.safeArea.bottomReservedRatio * 100).toFixed(0)}%`);
    push("顶部安全区", typeof kbTop === "number" ? `${kbTop}%` : null,
      `${(spec.safeArea.topMinRatio * 100).toFixed(0)}%`);
  }

  entries.push({
    hint: platformHint(profile, spec),
    trace: { kbId: profile.kbId, section: "§4", reason: `platform=${platformId}` }
  });

  if (theme) {
    const row = themeRow(kb, theme);
    if (row) {
      const palette = themePaletteRow(kb, theme);
      const paletteBit = palette ? `；配色字体：${palette.action}` : "";
      entries.push({
        hint: `【封面知识库·THEME-001】题材「${row.key}」→ 版式/构图/字级：${row.value}${paletteBit}`,
        trace: { kbId: "THEME-001", section: palette ? "§4+THEME-002§6" : "§4", reason: `theme=${theme}` }
      });
    } else {
      notes.push(`THEME-001 未收录题材「${theme}」——未注入题材映射（不硬凑近似条目）`);
    }
  } else {
    const hooks = hookShortlist(kb, hookBias);
    const picked = hooks.slice(0, 2).map((h) => `${h.id}（${h.structure}）`).join("、");
    if (picked) {
      entries.push({
        hint: `【封面知识库·HOOK-001】钩子短名单：${picked}——一张封面只用一个公式，剩余信息进副标题`,
        trace: { kbId: "HOOK-001", section: "§4", reason: hookBias.length > 0 ? `hook_bias=${hookBias.join("/")}` : "钩子未指定" }
      });
    }
  }

  if (accountType) {
    entries.push({
      hint: `【封面知识库·ACCT-001】${ACCOUNT_TYPE_NOTE[accountType]}；视觉锤四件套（字体/色板/版式/角标）锁定，偏离即告警`,
      trace: { kbId: "ACCT-001", section: "§4", reason: `accountType=${accountType}` }
    });
  }
  if (hookBias.length > 0 && !entries.some((e) => e.trace.kbId === "HOOK-001")) {
    entries.push({
      hint: `【封面知识库·HOOK-001】账号钩子偏好：${hookBias.join("、")}（从偏好内选一个公式）`,
      trace: { kbId: "HOOK-001", section: "§4", reason: `hook_bias=${hookBias.join("/")}` }
    });
  }

  const clipped = entries.slice(0, maxHints);
  if (entries.length > maxHints) notes.push(`注入条数 ${entries.length} 超上限 ${maxHints}，已截断（宁缺毋滥）`);
  return {
    hints: clipped.map((e) => e.hint),
    trace: clipped.map((e) => e.trace),
    fallback: false,
    platformId,
    source: spec ? "code" : "kb",
    notes,
    conflicts
  };
}

/** 从片名/目标/题材关键词启发式匹配 THEME-001 题材（`--theme` 缺省时用；命中不了返回 null） */
export function inferTheme(kb, text) {
  const haystack = String(text ?? "");
  if (!haystack.trim()) return null;
  const themes = listThemes(kb);
  const lexicon = {
    "知识科普": ["科普", "知识", "原理", "为什么", "讲解", "干货", "教程"],
    "美食": ["美食", "探店", "菜", "吃", "厨房", "味道", "火锅", "咖啡", "早餐"],
    "旅行风光": ["旅行", "风光", "景点", "地标", "城市", "古城", "山水", "打卡"],
    "剧情": ["剧情", "短剧", "故事", "反转", "情感"],
    "带货": ["带货", "种草", "产品", "促销", "折扣", "好物"],
    "Vlog": ["vlog", "日常", "记录", "生活"],
    "测评": ["测评", "评测", "对比", "避坑", "值不值"],
    "母婴": ["母婴", "宝宝", "亲子", "宠物", "萌宠"]
  };
  let best = null;
  for (const [theme, words] of Object.entries(lexicon)) {
    const matched = words.filter((w) => haystack.toLowerCase().includes(w.toLowerCase()));
    if (matched.length === 0) continue;
    const themeKey = themes.find((t) => t.startsWith(theme)) ?? theme;
    const score = matched.length;
    if (!best || score > best.score) best = { theme: themeKey, score, matched };
  }
  return best ? { theme: best.theme, matched: best.matched, themes } : null;
}

/** 账号档案归一（YAML 解析在调用方；这里只做语义归一与校验提示） */
export function normalizeAccountProfile(raw) {
  const notes = [];
  const profile = raw && typeof raw === "object" ? raw : {};
  const accountType = ACCOUNT_TYPE_ALIASES[String(profile.account_type ?? "").trim()] ?? null;
  if (profile.account_type && !accountType) notes.push(`account_type "${profile.account_type}" 不在五类账号谱内（已忽略）`);
  const hookBias = (Array.isArray(profile.hook_bias) ? profile.hook_bias : [])
    .map((id) => String(id).trim())
    .filter((id) => {
      if (!id) return false;
      if (HOOK_FORMULA_IDS.includes(id)) return true;
      notes.push(`hook_bias "${id}" 不是 HOOK-001 公式 ID（已忽略）`);
      return false;
    });
  const hammer = profile.visual_hammer && typeof profile.visual_hammer === "object" ? profile.visual_hammer : null;
  return {
    profile: {
      ...profile,
      account_type: accountType ?? profile.account_type ?? null,
      hook_bias: hookBias
    },
    accountType,
    hookBias,
    hammer,
    taboos: Array.isArray(profile.taboo) ? profile.taboo.map((t) => String(t)) : [],
    strict: profile.strict === true,
    notes
  };
}
