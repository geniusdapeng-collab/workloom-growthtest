/**
 * cine-kb-bridge · 摄影知识库连接器内核（2026-09-24）
 *
 * 解决的问题（产品所有者口径）：
 *   写镜头提示词时，关键细节（光圈/焦距/光位/影调/景别/运镜/材质…）目前靠模型自由发挥，
 *   同一个"江南水乡人像"可能被写成 35mm 深景深、也可能被写成 200mm 压缩——质感不稳定。
 *   我们希望 Agent 在落字段前**去摄影知识库走一圈**，按当前场景/时段/情绪/主体取出"最适合的那一组",
 *   把参数意图翻译成画面语言，塞进对应字段（depth_of_field / lighting / color_palette / composition …）。
 *
 * 知识库自带的关键纪律（`_INDEX.md` 检索总则 + 各篇"使用方式"）：
 *   **视频生成模型不认技术参数（F 值 / ISO / 快门数值），只认视觉效果描述。**
 *   因此本模块的产出物分两路：
 *     · `card`  —— 写进提示词的是**画面语言**（"浅景深、背景奶油般化开"），这是模型真正吃的输入；
 *     · `trace` —— 技术参数建议（"f/2.0–2.8 效果 / 85mm / 1/50s"）只留档给监制与人工复核，**不进提示词正文**。
 *
 * 知识库形态：`bundles/ai-video/library/cinematography-kb/*.md`（19 篇，九章式）。
 *   每篇第六章「意图 → 提示词关键词映射表」是核心调用区，格式统一为
 *     `| 创作意图 | 中文提示词写法 | 英文关键词 |`
 *   本模块按该格式解析；缺篇（索引引用了但目录里没有）会**显式报缺**，不静默降级。
 */

import fs from "node:fs";
import path from "node:path";
import { appendShotContributions, normalizeShotIntent, resolveShotIntent, restoreShotContributions, shotIntentHash, shotText, splitShotAssertions } from "./shot-intent.mjs";

export const CINE_KB_POLICY_VERSION = "workloom.cine-kb-policy/v2";

/* ================= 解析 ================= */

/** 章节编号（一…九）→ 语义名，用于把"第六章=调用区"等语义固定下来 */
const CHAPTER_NAMES = ["核心概念", "分类速查", "分场景实战", "视频特有规则", "常见误区", "映射表", "提示词模板", "决策树", "关联知识"];

/** 主题编号 → 领域（用于缺篇判定与联合检索建议） */
const TOPIC_DOMAIN = {
  OPTICS: "光学与相机语言",
  CINE: "光学与相机语言",
  LIGHT: "光线与色彩",
  COLOR: "光线与色彩",
  PHYS: "物理真实感",
  SCENE: "物理真实感",
  STYLE: "风格与叙事",
  NARR: "风格与叙事",
  HUMAN: "风格与叙事"
};

/** 25 字段卡里参与检索的文本字段（顺序即权重：越靠前越"决定画面"） */
const SIGNAL_FIELDS = [
  ["mood", 3],
  ["scene", 3],
  ["sceneDescription", 3],
  /** 人物信号主要落在 character / character_constraint 上（早先漏掉这两个字段，
   *  导致"有人物的镜头"被判成无主体，光圈顾问掉进风景/打卡档 —— 2026-09-24 真机修正） */
  ["character", 3],
  ["character_constraint", 2],
  ["action", 2],
  ["lighting", 2],
  ["color_palette", 2],
  ["composition", 2],
  ["camera_movement", 2],
  ["director_instruction", 2],
  ["costume", 1],
  ["makeup", 1],
  ["props", 1],
  ["baseline", 1],
  ["dialogue", 1]
];

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
  const joint = [];
  for (const line of markdown.split("\n")) {
    const m = line.match(/联合检索高频组合[^:：]*[:：]\s*(.+)/);
    if (m) joint.push(m[1].trim());
  }
  return { topics, jointSuggestions: joint };
}

/** 解析单篇：元数据 + 章节 + 第六章映射表（核心调用区） */
export function parseTopic(markdown, file) {
  const idMatch = markdown.match(/主题编号[：:]\s*([A-Z]+-\d{3})/);
  const versionMatch = markdown.match(/版本[：:]\s*(v[\d.]+)/);
  const usageMatch = markdown.match(/使用方式[：:]\s*([\s\S]*?)\n/);
  const title = (markdown.match(/^#\s+(.+)$/m)?.[1] ?? path.basename(file, ".md")).trim();
  const id = idMatch?.[1] ?? (path.basename(file).match(/^([A-Z]+-\d{3})/)?.[1] ?? path.basename(file, ".md"));

  /** 章节切分：`## 一、xxx` … */
  const chapters = [];
  const chapterRe = /^##\s+([一二三四五六七八九十]+)、(.+)$/gm;
  const marks = [];
  let m;
  while ((m = chapterRe.exec(markdown)) !== null) marks.push({ index: m.index, numeral: m[1], title: m[2].trim() });
  marks.forEach((mark, i) => {
    const end = i + 1 < marks.length ? marks[i + 1].index : markdown.length;
    chapters.push({ numeral: mark.numeral, title: mark.title, body: markdown.slice(mark.index, end) });
  });

  /**
   * 第六章（映射表）= 核心调用区；NARR-001 的列头是"中文意图/标准英文情绪词/配方缩写"，需兼容。
   *
   * 表头判定（2026-09-25 四轮审计修正）：改为**按 markdown 结构判定**——
   *   `| 表头 | … |` 的下一行一定是分隔线 `|---|---|`，这才是表头；而不是"第一个单元格恰好叫创作意图"。
   * 早先按单元格文本判表头，有两个后果：
   *   ① 表头不认识时 `tableKind` 保持 null，但末尾的 `entries.push(kind:"prompt")` 照样吸收 →
   *      CINE-002 §6.3「组合公式」表（单元格是 `ECU + 85mm + f/1.4 效果` 这类**参数配方**）
   *      整表进了条目池，连表头行本身都成了一条 intent="想要的效果" 的假条目；
   *      条目池会进 `trace.explored` 与 `cine-kb-cli search`，与"提示词不写 f 值"的总则直接冲突。
   *   ② 同一小节里第二张表若表头不规范，会**继承上一张表的 tableKind**（串表）。
   * 现在：结构识别表头 → 识别不了的表整表跳过（登记 unknownTables 留痕）；识别得了的按类型入库。
   */
  const mappingChapter = chapters.find((c) => c.numeral === "六") ?? chapters.find((c) => /映射表|调用区/.test(c.title));
  const entries = [];
  const reverseEntries = [];
  const unknownTables = [];
  if (mappingChapter) {
    const lines = mappingChapter.body.split("\n");
    const cellsOf = (line) => {
      const row = line.match(/^\|\s*([^|]+?)\s*\|\s*([^|]+?)\s*\|\s*([^|]+?)\s*\|\s*$/);
      return row ? [row[1], row[2], row[3]].map((c) => c.trim().replace(/\*\*/g, "")) : null;
    };
    let section = "";
    let tableKind = null;
    for (let i = 0; i < lines.length; i += 1) {
      const line = lines[i];
      const sec = line.match(/^###\s+(.+)$/);
      if (sec) { section = sec[1].trim(); tableKind = null; continue; }
      const cells = cellsOf(line);
      if (!cells) continue;
      const [c1, c2, c3] = cells;
      /** 表头 = 下一行是 markdown 分隔线的那一行 */
      if (/^\|\s*[-: ]+\|/.test(lines[i + 1] ?? "")) {
        if (/反推情绪/.test(c2)) tableKind = "reverse";
        else if (/配方缩写/.test(c3) || /配方/.test(c3)) tableKind = "recipe";
        else if (/中文提示词写法|提示词写法/.test(c2)) tableKind = "prompt";
        else tableKind = "other";
        continue;
      }
      if (/^-+$/.test(c1)) continue;
      if (tableKind === null) { unknownTables.push({ section, header: null, row: [c1, c2, c3] }); continue; }
      if (tableKind === "other") continue;
      if (tableKind === "reverse") { reverseEntries.push({ section, feature: c1, emotion: c2, confidence: c3 }); continue; }
      if (tableKind === "recipe") { entries.push({ section, kind: "recipe", intent: c1, zh: c2, en: c3 }); continue; }
      entries.push({ section, kind: "prompt", intent: c1, zh: c2, en: c3 });
    }
  }

  /** 快速速查表（第二章）行数，仅作健康度指标 */
  const quickRef = chapters.find((c) => c.numeral === "二");
  const quickRefRows = quickRef ? quickRef.body.split("\n").filter((l) => /^\|/.test(l) && !/^\|\s*-+/.test(l)).length - 1 : 0;

  return {
    id,
    title,
    file: path.basename(file),
    domain: TOPIC_DOMAIN[id.split("-")[0]] ?? "其他",
    version: versionMatch?.[1] ?? null,
    usage: usageMatch?.[1]?.replace(/^[>]\s*/, "").trim() ?? null,
    chapters: chapters.map((c) => ({
      numeral: c.numeral,
      title: c.title,
      semantic: CHAPTER_NAMES["一二三四五六七八九十".indexOf(c.numeral)] ?? c.title,
      rows: c.body.split("\n").filter((l) => /^\|/.test(l)).length,
      /** 保留章节原文：光圈/景深这类"按场景选档"的规则需要读表与决策树原文（不是映射表能表达的） */
      body: c.body
    })),
    entries,
    reverseEntries,
    unknownTables,
    quickRefRows,
    bytes: Buffer.byteLength(markdown, "utf8")
  };
}

/** 装载整库（含缺篇检测） */
export function loadKb(kbDir) {
  if (!fs.existsSync(kbDir)) throw new Error(`摄影知识库目录不存在：${kbDir}`);
  const files = fs.readdirSync(kbDir).filter((f) => f.endsWith(".md") && f !== "_INDEX.md").sort();
  const indexFile = path.join(kbDir, "_INDEX.md");
  const index = fs.existsSync(indexFile) ? parseIndex(fs.readFileSync(indexFile, "utf8")) : { topics: [], jointSuggestions: [] };
  const topics = files.map((f) => parseTopic(fs.readFileSync(path.join(kbDir, f), "utf8"), f));
  const presentIds = new Set(topics.map((t) => t.id));
  const missing = index.topics.filter((t) => !presentIds.has(t.id)).map((t) => ({ id: t.id, title: t.title, purpose: t.purpose }));
  const extra = topics.filter((t) => !index.topics.some((i) => i.id === t.id)).map((t) => t.id);
  const kb = {
    dir: kbDir,
    index,
    topics,
    missingTopics: missing,
    untrackedTopics: extra,
    entryCount: topics.reduce((sum, t) => sum + t.entries.length, 0),
    bytes: topics.reduce((sum, t) => sum + t.bytes, 0)
  };
  /** 光圈顾问（OPTICS-001）随库预解析，供 enrichShotCard 直接使用 */
  kb.aperture = parseApertureKnowledge(kb);
  return kb;
}

/* ================= 参数 → 画面语言（KB 纪律：提示词只写效果） ================= */

/**
 * 光圈顾问（OPTICS-001 权威口径）。
 *
 * 产品所有者的原始诉求就是这一条："光圈直接决定画面质感，Agent 应该去知识库走一圈，
 * 按当前场景选一个最合适的光圈，再把意图翻译成画面语言写进提示词。"
 *
 * 数据来源全部是 OPTICS-001 原文（不另造表）：
 *   §二 光圈档位全表       `| F 值 | 景深 | 典型用途 | 画面效果关键词 |`
 *   §三 分题材实战指南     `| 场景 | 推荐光圈 | 原因 |` + 3.2~3.6 的要点行
 *   §八 意图 → 光圈 → 提示词 决策流程
 *
 * 纪律（原文强调）：**提示词里不写 f 值**，只写视觉语言；f 值只进 trace 供监制复核。
 */
export function parseApertureKnowledge(kb) {
  const topic = kb.topics.find((t) => t.id === "OPTICS-001");
  if (!topic) return null;
  const chapter = (numeral) => topic.chapters.find((c) => c.numeral === numeral)?.body ?? "";
  const clean = (s) => String(s ?? "").replace(/\*\*/g, "").replace(/\s+/g, " ").trim();

  /** §二 档位表 */
  const stops = [];
  for (const line of chapter("二").split("\n")) {
    const row = line.match(/^\|\s*\*{0,2}(f\/[^|*]+?)\*{0,2}\s*\|\s*([^|]+?)\s*\|\s*([^|]+?)\s*\|\s*([^|]+?)\s*\|\s*$/);
    if (!row) continue;
    stops.push({ fRange: clean(row[1]), depth: clean(row[2]), uses: clean(row[3]), effectZh: clean(row[4]) });
  }

  /** §三 分题材：表格行 + 3.2~3.6 的要点行（`- 场景：**f/x–f/y**，原因`） */
  const scenarios = [];
  const body3 = chapter("三");
  for (const line of body3.split("\n")) {
    const table = line.match(/^\|\s*([^|]+?)\s*\|\s*(f\/[^|]+?)\s*\|\s*([^|]+?)\s*\|\s*$/);
    if (table && !/^-+$/.test(clean(table[1]))) {
      scenarios.push({ label: clean(table[1]), aperture: clean(table[2]), reason: clean(table[3]) });
      continue;
    }
    /**
     * 要点行解析（三轮审计放宽）：形如
     *   `- 打卡照：**f/5.6**，原因…`
     *   `- 星空银河：**用镜头最大光圈**（f/1.4–f/2.8），原因…`
     *   `- 微距景深天然极浅，**f/8–f/16** 起步才能…`
     * 早先要求 f 值紧跟标签，导致"星空""微距"两行没进场景表 → 兜底成 f/5.6 打卡档。
     */
    const bulletLine = line.match(/^-\s*(.+)$/);
    if (bulletLine) {
      const raw = clean(bulletLine[1]);
      const fMatch = raw.match(/f\/\s*\d+(?:\.\d+)?(?:\s*[–\-~]\s*f\/\s*\d+(?:\.\d+)?)?/);
      if (fMatch) {
        const label = clean(raw.split(/[：:（(]/)[0]).replace(/\*\*/g, "");
        const reason = clean(raw.slice(raw.indexOf(fMatch[0]) + fMatch[0].length)).replace(/^[，,、）)]+/, "").replace(/。$/, "");
        scenarios.push({ label, aperture: clean(fMatch[0]), reason });
      }
    }
  }

  /**
   * §八 决策树：`├─ "…" → 浅景深（f/1.4–f/2.8 效果）`
   *
   * 2026-09-25 四轮审计：原文里 6 个意图叶子只有 4 个能被旧正则捞出来——
   *   · `"夜晚/暗光手持" → 最大光圈效果（f/1.4–f/2.8）`：**"效果"在括号外**，旧式 `（f/… 效果）` 匹配不到；
   *   · `"运镜叙事/焦点转移" → 浅景深 + rack focus`：整个叶子没有 f 值（是方向型规则，不是档位型规则）。
   * 现在两种写法都认；方向型叶子（无 f 值）单独登记进 directionRules，不参与档位选择
   * （否则它会以 `aperture=null` 进候选，被选中后落回"人景皆清"这类不相关档位）。
   */
  const rules = [];
  const directionRules = [];
  for (const line of chapter("八").split("\n")) {
    const arrow = line.match(/["“](.+?)["”]\s*→\s*(.+)$/);
    if (!arrow) continue;
    const intent = clean(arrow[1]);
    const tail = arrow[2];
    const fMatch = tail.match(/[（(]\s*(f\/[^）)]+?)(?:\s*效果)?\s*[）)]/) ?? tail.match(/效果\s*[（(]\s*(f\/[^）)]+?)\s*[）)]/);
    if (fMatch) {
      const direction = clean(tail.split(/[（(]/)[0]).replace(/效果$/, "").trim();
      rules.push({ intent, direction: direction || clean(tail), aperture: clean(fMatch[1]) });
      continue;
    }
    directionRules.push({ intent, direction: clean(tail) });
  }
  return { topicId: topic.id, title: topic.title, version: topic.version, stops, scenarios, rules, directionRules };
}

/**
 * 档位效果词里的**禁用短句**（2026-09-25 四轮审计）。
 *
 * OPTICS-001 §二 把 f/1.2–f/1.4 档的效果词写成"奶油般虚化、梦幻光斑、**主体悬浮感**"；
 * 而 §三 的「夜景人像 f/1.4–f/1.8」与 §二 每一档都**零重叠**（只在下界擦边），
 * `apertureStopFor` 于是落回"第一个有交集的档位" = f/1.2–f/1.4 ——
 * 夜景人像镜头又一次拿到"主体悬浮感"。这正是 2026-09-24 真机监制打回过的翻车信号
 * （"夜景人物漂浮"，三轮审计的校准注释里写着"主体悬浮感是明确的翻车信号"，
 * 但当时的修法只覆盖了 f/1.4–f/2.8 那一个区间，夜景人像档漏在网外）。
 * 处置：该短句不得进入提示词正文；同句其余措辞仍取 KB 原文（不另写文案）。
 */
const APERTURE_EFFECT_BLOCKLIST = ["主体悬浮感", "主体漂浮感", "漂浮感"];

/** 剔除效果词里的禁用短句；未命中时原样返回 */
export function sanitizeApertureEffect(text) {
  const s = String(text ?? "");
  if (!APERTURE_EFFECT_BLOCKLIST.some((b) => s.includes(b))) return s;
  const cut = s.search(/[（(]/);
  const head = cut >= 0 ? s.slice(0, cut) : s;
  const tail = cut >= 0 ? s.slice(cut) : "";
  const clauses = head.split(/[、,，]/).map((c) => c.trim()).filter(Boolean);
  const kept = clauses.filter((c) => !APERTURE_EFFECT_BLOCKLIST.some((b) => c.includes(b)));
  if (kept.length === clauses.length) return s;
  const headOut = kept.join("、");
  if (headOut) return `${headOut}${tail}`;
  return tail.replace(/^[（(]\s*/, "").replace(/\s*[）)]$/, "");
}

/** f 区间解析：`f/1.4–f/2.0` / `f/16` → {min,max} */
export function parseApertureRange(text) {
  const nums = [...String(text).matchAll(/f\/(\d+(?:\.\d+)?)/g)].map((m) => Number(m[1]));
  if (nums.length === 0) return null;
  return { min: Math.min(...nums), max: Math.max(...nums) };
}

/**
 * 档位表命中：给定光圈区间，取**覆盖最多**的那一档（用于把 f 值换成画面效果关键词）。
 *
 * 2026-09-24 真机三轮校准：早先取"第一个有交集的档位"，于是一个跨档的区间会被最小那一档代言——
 * 夜景收尾镜 f/1.4–f/2.8 命中了 f/1.2–f/1.4 档，画面语言变成"奶油般虚化、梦幻光斑、**主体悬浮感**"，
 * 监制据此打回（夜景人物"漂浮"是明确的翻车信号）。改为按区间重叠长度取档：
 * f/1.4–f/2.8 与 f/1.8–f/2.0 重叠 0.2，胜过其余候选 → 得到"柔和虚化、主体突出、电影感"。
 * 完全无重叠（区间落在档位缝隙）时退回第一个有交集的档，保持旧行为不变。
 */
export function apertureStopFor(apertureKnowledge, range) {
  if (!apertureKnowledge || !range) return null;
  let best = null;
  let bestOverlap = 0;
  for (const stop of apertureKnowledge.stops) {
    const r = parseApertureRange(stop.fRange);
    if (!r) continue;
    const overlap = Math.min(range.max, r.max) - Math.max(range.min, r.min);
    if (overlap > bestOverlap) { best = stop; bestOverlap = overlap; }
  }
  if (best) return best;
  return apertureKnowledge.stops.find((stop) => {
    const r = parseApertureRange(stop.fRange);
    return r && range.min <= r.max && range.max >= r.min;
  }) ?? null;
}

/**
 * 场景匹配的**意图加词**（不是硬编码推荐值——推荐值一律来自 §三 表格与 §八 决策树）：
 * 每个意图给一组"该意图在卡片里可能出现的关键词"，命中越多，对应场景行的权重越高。
 */
const APERTURE_INTENT_HINTS = [
  { id: "night-portrait", pattern: /夜景|夜晚|暗光|烛光|霓虹|夜色|灯光下/, prefer: ["夜景人像", "手持夜景", "星空"] },
  /** 特写档 vs 环境人像档要分开判：中景/中近景（人物+场景同框）该走 f/2.8–f/4，不是 f/1.4–f/2.0 */
  { id: "closeup-portrait", pattern: /特写|近景|close-?up|面部特写|情绪特写/i, prefer: ["单人特写"] },
  { id: "scene-portrait", pattern: /中景|中近景|半身|人像|写真|肖像|环境/, prefer: ["环境人像"] },
  { id: "person", pattern: /女主|男主角|角色|人物|她|他/, prefer: ["环境人像", "单人特写"] },
  { id: "pair", pattern: /双人|情侣|两人|一对/, prefer: ["双人"] },
  { id: "group", pattern: /多人|团队|集体|合影|全家|众人|一群人|十人/, prefer: ["多人合影", "团体"] },
  { id: "checkin", pattern: /打卡|旅拍|地标|景点|游记/, prefer: ["打卡"] },
  { id: "vlog", pattern: /vlog|手持|边走边拍|跟拍|走动/i, prefer: ["Vlog", "边走边拍", "手持"] },
  /** 注意：不要把"全景"当风光信号——它是景别术语（"全景转中景"的人像镜头会被误判成风光） */
  { id: "landscape", pattern: /风光|大场景|山脉|雪山|湖面|大海|山谷|草原|日出|日落|远景|天际线|戈壁|沙漠/, prefer: ["大场景风光", "风光"] },
  /** 注意：室内/房间不再算"街拍"信号——阴天室内茶室曾因此被判成 f/8 街拍档（2026-09-24 抽查）。室内有人物时走"环境人像"。 */
  /**
   * 建筑类信号补「幕墙/楼宇」（四轮审计：写字楼玻璃幕墙镜头此前落 f/5.6 打卡档）。
   * 五轮审计修偏好标签：§三 场景表里**没有"建筑""城市"这两行**（原 prefer 里两个标签永远匹配不到任何行，
   * 只有"街拍"有效）→ 改为实际存在的行标签。
   */
  { id: "architecture", pattern: /建筑|街巷|街道|城市天际线|高楼|幕墙|楼宇/, prefer: ["街拍"] },
  /** 星芒必须是**显式意图**：只是场景里有太阳/路灯不代表要拍星芒（海边人像曾被判成 f/16 星芒档）。 */
  { id: "starburst", pattern: /星芒|放射状光|sun star|starburst/, prefer: ["星芒", "车轨"] },
  { id: "food", pattern: /美食|食物|糖粥|点心|餐|蒸汽|菜品/, prefer: ["美食", "单品特写"] },
  { id: "product", pattern: /产品|商品|包装|摆盘|全貌/, prefer: ["产品全貌", "单品特写"] },
  { id: "macro", pattern: /微距|细节特写|纹理特写/, prefer: ["微距"] }
];

/**
 * 按镜头卡推荐光圈档（返回 f 建议 + 画面语言 + 依据）。
 * @returns {{aperture:string, direction:"shallow"|"deep"|"moderate", effectZh:string, effectEn:string, reason:string, scenarioLabel:string|null, source:string}}
 */
export function recommendAperture(kb, card) {
  const intent = normalizeShotIntent(card);
  card = { ...(intent.source.fields ?? {}), ...intent.source };
  const knowledge = kb.aperture ?? parseApertureKnowledge(kb);
  if (!knowledge) return null;
  /**
   * 与 detectContext / injectionContext 同口径：先剥否定语境（三轮审计）。
   * 旧的 shotSignals 原始文本里带着"避免…""其他…"，"其他"里的"他"直接把空镜判成有人物。
   */
  const text = stripNegatedContext(norm(shotSignals(card).text));
  const context = detectContext(card);
  // An explicit depth instruction outranks all inferred scenario recommendations.
  if (intent.scene.depthMode !== "unknown") {
    const direction = intent.scene.depthMode;
    const row = knowledge.scenarios.find((item) => {
      const range = parseApertureRange(item.aperture);
      return range && (direction === "deep" ? range.min >= 8 : direction === "shallow" ? range.max <= 2.8 : range.min >= 2.8 && range.max <= 5.6);
    });
    if (!row) return null;
    return { aperture: row.aperture, direction, effectZh: shotText(card.depth_of_field), effectEn: "", reason: "保留源卡显式景深", scenarioLabel: row.label, matchedBy: "explicit-depth", handAdjust: null, intents: [], source: "源镜头 depth_of_field；OPTICS-001 场景表" };
  }
  /** 命中的人像/人群意图（用于"有没有明确主体"的判断，以及多人口径） */
  const hitIntents = APERTURE_INTENT_HINTS.filter((hint) => hint.pattern.test(text));
  /**
   * 主体判定（三轮审计修正）：老代码写的是 `single-portrait`——**这个 id 在 HINTS 里根本不存在**，
   * 真正表示人物的 `person` / `closeup-portrait` / `scene-portrait` 反而没算进去，
   * 于是"只有角色名、没有'人物/她/他'字面"的卡片全被判成空镜。
   */
  const hasPerson = intent.subject.hasPerson;
  const isGroup = hitIntents.some((h) => h.id === "group");

  /** ① 场景表打分：意图加词命中 → 对应场景行加分；再用 2-gram 重合度补分 */
  const rowScore = (row) => {
    let score = 0;
    for (const hint of hitIntents) {
      if (hint.prefer.some((p) => row.label.includes(p))) score += 3;
    }
    const a = bigrams(`${row.label} ${row.reason}`);
    const b = bigrams(text);
    for (const g of a) if (b.has(g)) score += 1;
    /** 多人口径优先：明确写"多人/团队/合影"时压低"双人"行的权重，避免十人合影掉进双人档 */
    if (isGroup && /双人/.test(row.label) && !/多人/.test(row.label)) score -= 4;
    /**
     * 夜景人像优先（KB §3.5：手持夜景"能开多大开多大"）：
     * 夜间 + 有人物时，人像档应压过风光档——否则"灯笼下走两步"会被判成风光 f/8。
     */
    const isNight = context.timeOfDay.includes("night") || intent.scene.lightSources.includes("candle");
    /** 夜景 + 有人物时，KB §3.5 明确"能开多大开多大"——人像档要压过环境/风光档 */
    if (isNight && hasPerson && /夜景人像|手持夜景/.test(row.label)) score += 8;
    /** 无人物夜景不给人像档（三轮审计：夜晚车轨被塞"夜景人像 + 奶油虚化"） */
    if (isNight && !hasPerson && /夜景人像|手持夜景/.test(row.label)) score -= 6;
    /**
     * 无主体时不该选"人像类"档（三轮审计：空镜夜景巷子靠 2-gram 噪声被选成「环境人像 f/2.8–f/4」，
     * 画面里根本没有人物，档位的语义就对不上）。人像行留给真的有人物的镜头。
     */
    if (!hasPerson && /人像|单人特写|双人|多人合影|合影/.test(row.label)) score -= 100;
    if (isNight && hasPerson && /大场景风光|风光/.test(row.label)) score -= 3;
    /**
     * 景别消歧（KB §3.1）：中景/中近景的人像镜头要"人清楚、场景可辨"，
     * 应走「环境人像 f/2.8–f/4」，而不是「单人特写 f/1.4–f/2.0」；
     * 只有当镜头明确是特写/近景时，才回落到特写档。
     */
    const wantsEnvironment = /中景|中近景|环境|街|巷|桥|河道|水面|石阶|街巷/.test(text);
    const wantsCloseup = /特写|近景|close-?up/i.test(text) && !/中近景/.test(text);
    if (wantsEnvironment && !wantsCloseup && /环境人像/.test(row.label)) score += 4;
    if (wantsCloseup && /单人特写/.test(row.label)) score += 4;
    if (wantsEnvironment && !wantsCloseup && /单人特写/.test(row.label)) score -= 2;
    return score;
  };
  const rankedRows = [...knowledge.scenarios]
    .map((row) => ({ row, score: rowScore(row) }))
    .sort((x, y) => y.score - x.score);

  let picked = rankedRows[0] && rankedRows[0].score >= 2 ? rankedRows[0].row : null;
  let pickedBy = picked ? "scene-table" : null;

  /** ② 场景表不够明确 → §八 决策树（同样按 2-gram 打分） */
  if (!picked) {
    const scoredRules = knowledge.rules
      .map((rule) => {
        const a = bigrams(rule.intent);
        const b = bigrams(text);
        let score = 0;
        for (const g of a) if (b.has(g)) score += 1;
        return { rule, score };
      })
      .sort((x, y) => y.score - x.score);
    if (scoredRules[0] && scoredRules[0].score >= 2) {
      picked = { label: scoredRules[0].rule.intent, aperture: scoredRules[0].rule.aperture, reason: scoredRules[0].rule.direction };
      pickedBy = "decision-tree";
    }
  }

  /** ③ 兜底：有明确人物主体 → "环境人像"（人清楚、场景可辨）；否则给"打卡"安全档 */
  if (!picked) {
    /**
     * 兜底不再一律"打卡 f/5.6"（三轮审计：产品/婚礼/儿童/体育/航拍/棚拍全被塞成打卡档）。
     * 先按主体类型在 KB §三 里挑对应行，再退回打卡。
     */
    const subjectPreference = [
      /**
       * 产品（三轮审计）：单品（香水、瓶身、杯）走 §3.4「单品特写 f/2.0–2.8，聚光灯式聚焦」——
       * 该行原文点名"香水、咖啡杯"；只有明确要"全貌/包装/摆盘"时才用「产品全貌 f/8–f/11」。
       */
      {
        test: /产品|商品|包装|摆盘|静物|香水|瓶身/,
        prefer: /全貌|整箱|整套|包装盒|陈列|摆盘全景/.test(text) ? ["产品全貌", "单品特写"] : ["单品特写", "产品全貌"]
      },
      { test: /婚礼|新人|婚宴|情侣|双人|两人/, prefer: ["双人", "小合影"] },
      { test: /儿童|孩子|亲子|生日会|家庭/, prefer: ["多人合影", "团体"] },
      /**
       * 体育（三轮审计）：KB 无体育专档，取 §3.3「边走边拍的 Vlog f/4–f/5.6」——
       * 该行的理由是"给对焦系统留容错，防止人物出景深"，正是快速移动主体的同一诉求；
       * 原先映射到「车轨/大场景风光 f/8–f/11」会把运动主体写成全程清晰的全景打卡。
       */
      { test: /体育|运动|竞技|跑道|球场|赛道/, prefer: ["边走边拍", "环境人像"] },
      { test: /航拍|俯瞰|梯田|云海|山川|草原/, prefer: ["大场景风光", "风光"] },
      { test: /棚拍|影棚|纯色背景|灰背景|白背景/, prefer: hasPerson ? ["单人特写", "环境人像"] : ["产品全貌", "单品特写"] },
      /** 场所类主体：有人在 → 环境人像（人清楚、场景可辨）；纯空间 → 街拍叙事（超焦距、整条走廊清晰） */
      { test: /门店|店内|商场|展厅|铺面/, prefer: hasPerson ? ["环境人像", "打卡"] : ["街拍", "打卡"] },
      { test: /办公室|工位|会议室/, prefer: hasPerson ? ["环境人像", "打卡"] : ["街拍", "打卡"] },
      { test: /医院|走廊|大堂|候车厅|长廊/, prefer: hasPerson ? ["环境人像", "打卡"] : ["街拍", "大场景风光"] },
      { test: /美食|食物|菜|汤|点心|餐/, prefer: ["美食蒸汽", "单品特写"] },
      { test: /微距|昆虫|露珠/, prefer: ["微距"] },
      { test: /星空|银河|星轨/, prefer: ["星空", "手持夜景"] },
      /**
       * 纯风光兜底（四轮审计）：海雾/海岸/山脊这类"没有 '风光/大场景' 字面"的自然大景此前落 f/5.6「打卡照」，
       * 而打卡行的语义是"人景皆清"——画面里根本没有"人"。只在**确认无人物**时启用，避免"湖边人像"被推去风光档。
       */
      {
        test: /海面|海岸|海边|湖面|湖泊|山脊|山谷|山顶|云海|梯田|溪流|瀑布|草原|沙丘|荒原/,
        when: (_text, hasPerson) => !hasPerson,
        prefer: ["大场景风光", "风光"]
      }
    ].find((rule) => rule.test.test(text) && (!rule.when || rule.when(text, hasPerson)));
    /**
     * 偏好表按**书写优先级**取行（不是 KB 文件顺序）：
     * 例如「棚拍」偏好 `单人特写 > 环境人像`，KB 里两行都在，必须取前者。
     */
    const preferred = subjectPreference
      ? subjectPreference.prefer
          .map((p) => knowledge.scenarios.find((s) => s.label.includes(p)))
          .find(Boolean) ?? null
      : null;
    picked = preferred
      ?? (hasPerson ? knowledge.scenarios.find((s) => /环境人像/.test(s.label)) : null)
      ?? knowledge.scenarios.find((s) => /打卡/.test(s.label))
      ?? knowledge.scenarios[0]
      ?? { label: null, aperture: "f/5.6", reason: "通用安全档" };
    /**
     * 溯源标签细化（四轮审计）：早先"有人物→环境人像"与"无主体→打卡"都记成 `fallback-default`，
     * 审计时无法从 trace 区分"走了哪条兜底"。现在三分：subject-fallback（主体偏好表）/ person-fallback
     * （有人物但偏好表未覆盖）/ fallback-default（无主体安全档）。
     */
    pickedBy = preferred ? "subject-fallback" : hasPerson ? "person-fallback" : "fallback-default";
  }

  const range = parseApertureRange(picked.aperture);
  const stop = apertureStopFor(knowledge, range);
  const direction = range && range.max <= 2.8 ? "shallow" : range && range.min >= 8 ? "deep" : "moderate";
  /**
   * 手部/道具纠偏（2026-09-24 badcase：SC-02 连续 4 次因"手部指节粘连/手指畸变/左手消失"被打回）：
   * 手在画面里承担动作叙事时，光圈不宜开到最大——浅景深会把手部细节交给模糊，模型更容易糊成一团。
   * 依据 OPTICS-001 §3.1（单人特写 f/1.4–2.0 的代价是"景深极浅"）与 §3.4（产品单品 f/2.0–2.8 才保细节）。
   */
  const handAction = /指|挥|搭|捧|端|舀|勺|摸|握|递|摆手|手势/.test(text);
  let finalAperture = picked.aperture;
  let finalReason = picked.reason;
  let handAdjust = null;
  /**
   * 只对**白天/室内**的手部叙事镜生效：夜景按 KB §3.5「能开多大开多大」优先保进光量，
   * 此时收光圈会逼高 ISO；宁可让手部略软，也不要夜景噪点炸掉整镜（2026-09-24 修正）。
   */
  const isNightScene = context.timeOfDay.includes("night") || intent.scene.lightSources.includes("candle");
  /** 专项意图需要一个"注入决策上下文"（含 星空/车轨/微距 等信号） */
  const ctx = injectionContext(card);
  /** 专项意图优先（三轮审计）：星空=最大光圈求进光；车轨/长曝=小光圈；微距=小光圈保景深 */
  const special = ctx?.starfield ? knowledge.scenarios.find((s) => /星空|银河/.test(s.label))
    : ctx?.lightTrail ? knowledge.scenarios.find((s) => /车轨|长曝/.test(s.label))
    : ctx?.macro ? knowledge.scenarios.find((s) => /微距/.test(s.label)) : null;
  if (special) {
    const specRange = parseApertureRange(special.aperture);
    const specStop = apertureStopFor(knowledge, specRange);
    /**
     * 画面语言口径（三轮审计）：§二 档位表把 f/1.4–f/2.8 的效果词写成"奶油般虚化、梦幻光斑、主体悬浮感"，
     * 那是**人像浅景深**的语言；而 §3.5 对星空银河的原话是"此时求的是进光量而非景深"。
     * 照抄档位表会让模型去画一片背景光斑而不是星点，所以"进光量优先"的行一律用行内理由当画面语言。
     */
    const lightPriority = /星空|银河/.test(special.label);
    return {
      aperture: special.aperture,
      direction: specRange && specRange.max <= 2.8 ? "shallow" : specRange && specRange.min >= 8 ? "deep" : "moderate",
    effectZh: sanitizeApertureEffect(lightPriority
        ? `${special.reason || "以进光量为先"}（${special.label}）`
        : specStop ? `${specStop.effectZh}（${specStop.depth}景深）` : special.reason),
      effectEn: "",
      reason: `${special.reason}（专项意图：${ctx?.starfield ? "星空" : ctx?.lightTrail ? "车轨/长曝" : "微距"}）`,
      scenarioLabel: special.label,
      matchedBy: "special-intent",
      handAdjust: null,
      intents: hitIntents.map((h) => h.id),
      source: `OPTICS-001 §三/§八${knowledge.version ? `（${knowledge.version}）` : ""}`
    };
  }
  if (handAction && !isNightScene && range && range.max <= 2.0) {
    const corrected = knowledge.scenarios.find((s) => /环境人像/.test(s.label));
    if (corrected) {
      finalAperture = corrected.aperture;
      finalReason = `${corrected.reason}（含手部动作，收小光圈保手部与道具细节）`;
      handAdjust = { from: picked.aperture, to: corrected.aperture, why: "手部/道具在画面内承担动作，浅景深易糊手" };
    }
  }
  const finalRange = parseApertureRange(finalAperture);
  const finalStop = apertureStopFor(knowledge, finalRange);
  const finalDirection = finalRange && finalRange.max <= 2.8 ? "shallow" : finalRange && finalRange.min >= 8 ? "deep" : "moderate";
  /** 英文关键词：取 §六 对应方向的条目（浅/深景深方向各取首条） */
  const apertureTopic = kb.topics.find((t) => t.id === "OPTICS-001");
  const entriesByDirection = {
    shallow: apertureTopic?.entries.find((e) => /浅景深/.test(e.section)) ?? null,
    deep: apertureTopic?.entries.find((e) => /深景深/.test(e.section)) ?? null,
    /** 中景深要"人景皆清"那句，不能抓"全画面清晰"（那是深景深口径）——2026-09-24 修正 */
    moderate: apertureTopic?.entries.find((e) => /人景皆清/.test(e.intent)) ?? null
  };
  const entry = entriesByDirection[finalDirection] ?? null;
  return {
    aperture: finalAperture,
    direction: finalDirection,
    effectZh: sanitizeApertureEffect(finalStop ? `${finalStop.effectZh}（${finalStop.depth}景深）` : (entry?.zh ?? "")).replace(!hasPerson ? /人景皆清|人物与环境|人物/g : /$^/, (text) => text === "人景皆清" ? "主体与环境清晰" : text.replace("人物", "主体")),
    effectEn: entry?.en ?? "",
    reason: finalReason,
    scenarioLabel: picked.label,
    matchedBy: pickedBy,
    handAdjust,
    intents: hitIntents.map((h) => h.id),
    source: `OPTICS-001 §三/§八${knowledge.version ? `（${knowledge.version}）` : ""}`
  };
}

/**
 * 曝光三角参数 → 画面语言。
 *
 * 关键说明：**光圈篇（OPTICS-001）当前未随库分发**（索引第 12 行引用、目录里没有）。
 * 因此本表的 f 值 → 效果映射取自库内可核验的三处：
 *   · NARR-001 各情绪配方里的"光圈景深：f/1.2–1.8 效果（极浅景深/圆形光斑）"等表述；
 *   · OPTICS-002 §1.4「虚化强度 = 大光圈 + 长焦距 + 近摄距 + 远背景」；
 *   · STYLE-001 §6.1「浅景深（f/1.4–f/2.8 效果）」。
 * 载入 OPTICS-001 后可用 `registerApertureTable()` 覆盖为原篇口径。
 */
let APERTURE_EFFECTS = [
  { max: 1.4, zh: "极浅景深，焦点锐利、背景完全化开，夜间灯光呈圆形光斑", en: "extremely shallow depth of field, razor-thin focus plane, creamy bokeh, round light balls at night" },
  { max: 2.0, zh: "很浅景深，主体从背景中浮出，背景奶油般柔和", en: "very shallow depth of field, subject pops from background, creamy soft background" },
  { max: 2.8, zh: "浅景深，背景柔和虚化但仍可辨认环境", en: "shallow depth of field, softly blurred but readable background" },
  { max: 4.0, zh: "中浅景深，人物清晰、环境柔化", en: "medium-shallow depth of field, subject sharp with softened surroundings" },
  { max: 5.6, zh: "中景深，人物与环境都可辨，层次自然", en: "medium depth of field, subject and environment both legible" },
  { max: 8.0, zh: "中深景深，环境信息完整交待", en: "medium-deep depth of field, environment clearly rendered" },
  { max: 11, zh: "深景深，前景到中景全清晰", en: "deep depth of field, foreground to midground all sharp" },
  { max: Infinity, zh: "超深景深，前景到地平线全清晰", en: "extreme deep focus, foreground to horizon all sharp" }
];

export function registerApertureTable(rows) {
  APERTURE_EFFECTS = rows;
}

export function apertureToEffect(aperture) {
  const value = Number(String(aperture).replace(/^f\/?/i, ""));
  if (!Number.isFinite(value)) return null;
  const row = APERTURE_EFFECTS.find((r) => value <= r.max);
  return row ? { aperture: `f/${value} 效果`, zh: row.zh, en: row.en } : null;
}

/** 快门（180° 规则）→ 动态呈现：见 OPTICS-003（视频里快门由帧率锁定，靠 ND 补曝光） */
export function shutterToEffect(fps, style = "normal") {
  const base = fps && fps > 0 ? Math.round(fps * 2) : 50;
  const map = {
    normal: { zh: "自然运动模糊，动作符合人眼观感", en: "natural motion blur, true-to-eye movement" },
    freeze: { zh: "凝固瞬间，几乎没有运动模糊，动作定格感强", en: "frozen moment, minimal motion blur, crisp action" },
    trail: { zh: "明显拖影与光轨，时间被拉长", en: "visible motion blur trails and light streaks, stretched time" },
    step: { zh: "抽帧顿感，动作一跳一跳，复古胶片节奏", en: "step-printed staccato motion, vintage frame-skipping feel" }
  };
  const picked = map[style] ?? map.normal;
  return { shutter: `1/${base}s（180° 规则，${fps}fps）`, ...picked };
}

/** ISO → 画质氛围：见 OPTICS-004 */
export function isoToEffect(iso) {
  const value = Number(iso);
  if (!Number.isFinite(value)) return null;
  if (value <= 200) return { iso: `ISO ${value}`, zh: "画面干净通透，细节丰富无噪点", en: "clean and crisp, rich detail, no visible noise" };
  if (value <= 800) return { iso: `ISO ${value}`, zh: "细颗粒质感，整体仍干净", en: "fine grain texture, still clean overall" };
  if (value <= 3200) return { iso: `ISO ${value}`, zh: "可见胶片颗粒感，纪实氛围", en: "visible film grain, documentary mood" };
  return { iso: `ISO ${value}`, zh: "明显噪点与颗粒，粗粝纪实/夜视氛围", en: "heavy grain and noise, gritty documentary or night-vision mood" };
}

/* ================= 检索 ================= */

const norm = (v) => String(v ?? "").trim().toLowerCase();

/**
 * 否定语境剥离（判断"这个镜头要不要 X"之前先做）。
 *
 * 两类否定在中文里结构不同，早先共用一条"剥 18 个字"的规则：
 *   · 谓词否定（避免/不要/禁止 + 从句）——剥掉整个从句，如"避免日落时段的金色调"；
 *   · 限定词否定（无/不含/非 + **定语** + 的 + 中心词）——只该剥掉定语，
 *     如"**无光污染**的星空银河"里，"星空银河"是要拍的主体。
 * 三轮审计真机：旧规则把"无光污染的星空银河"整段吃掉 → 星空专项光圈规则根本没触发。
 * 因此限定词否定改为"遇到'的/地'即停"，谓词否定维持 18 字。
 */
function stripNegatedContext(raw) { return splitShotAssertions(raw).positive; }

/** 时段/天气/主体识别（用于"矛盾闸"：日景镜头不能被塞夜景配方） */
const CONTEXT_LEXICON = {
  timeOfDay: [
    { key: "morning", pattern: /清晨|早上|上午|晨光|日出/ },
    { key: "noon", pattern: /正午|中午|晌午/ },
    { key: "afternoon", pattern: /下午|午后/ },
    { key: "dusk", pattern: /黄昏|日落|晚霞|傍晚|夕阳|黄金时刻|magic hour/ },
    { key: "night", pattern: /夜景|夜晚|入夜|晚上|霓虹|烛光|灯光下|night/ },
    { key: "blueHour", pattern: /蓝调|蓝调时刻|blue hour/ }
  ],
  weather: [
    { key: "rain", pattern: /雨|雨天|暴雨|细雨|雨后/ },
    { key: "snow", pattern: /雪|下雪|飘雪/ },
    { key: "fog", pattern: /雾|薄雾|晨雾|水汽/ },
    { key: "overcast", pattern: /阴天|多云|散射|漫射|柔光|无硬阴影|overcast/ },
    { key: "clear", pattern: /晴|通透|澄澈|蓝天/ }
  ],
  subject: [
    { key: "person", pattern: /人|人物|女主|主角|角色|她|他|脸部|面部|肖像/ },
    { key: "food", pattern: /食物|美食|菜|糖粥|点心|餐/ },
    { key: "architecture", pattern: /建筑|室内|房间|院|街|巷|桥|空间/ },
    { key: "water", pattern: /水|河|湖|雨|浪|倒影/ }
  ]
};

/**
 * 命名主体信号（2026-09-24 三轮审计）：
 * 镜头卡写 `character: "陈卓"` 时画面里**确实有人**，但词面上下文只认"人/人物/她/他/人像"这些词，
 * 于是这类镜头被判成"空镜"——光圈兜底因此掉进 f/5.6「打卡照」（正午人像/蓝调人像/雪天人像全中）。
 * 这里把**角色字段非空且未被否定**本身当作主体信号；`无 / 空镜 / 不需要 / 不出镜` 仍判空镜。
 */

/**
 * 两套上下文共用的取词字段表（2026-09-25 五轮审计）。
 *
 * 早先 `detectContext()` 与 `injectionContext()` 各写一份字段清单：detectContext 看得到 `timeline`，
 * injectionContext 看得到 `makeup / baseline / pacing`，于是**同一张卡在"光圈决策"与"注入决策"里看到的世界不同**——
 * 只把时段写进 `timeline` 的卡片，光圈侧判夜间、注入侧判日景（运行时复现）。
 * 现在共用一张表：先取词 → 剥否定 → 两边各自解读，口径不会再漂移。
 */
const CONTEXT_FIELDS = [
  "scene", "sceneDescription", "lighting", "mood", "timeline", "director_instruction", "color_palette",
  "action", "composition", "camera_movement", "character", "character_constraint", "characters",
  "costume", "props", "makeup", "baseline", "pacing"
];

function contextText(card) { return normalizeShotIntent(card).scene.positiveText; }

export function detectContext(card) {
  const intent = normalizeShotIntent(card);
  const text = intent.scene.positiveText;
  const pick = (list) => list.filter((x) => x.pattern.test(text)).map((x) => x.key);
  const subject = pick(CONTEXT_LEXICON.subject).filter((name) => name !== "person");
  if (intent.subject.hasPerson) subject.push("person");
  return { timeOfDay: intent.scene.timeOfDay, weather: pick(CONTEXT_LEXICON.weather), subject };
}

/**
 * 风格冲突词：卡片里没有对应的风格语境时，这些条目一律不许注入。
 * 例：传统水乡夜景被注入"赛博朋克都市夜景，密集霓虹与全息广告"（2026-09-24 真机）。
 */
const STYLE_CONFLICT_MARKERS = [
  { marker: /赛博|霓虹|全息|未来|科幻|cyberpunk|neon|hologram/i, need: /赛博|霓虹|未来|科幻|cyberpunk|neon|futuristic/i, label: "赛博/未来" },
  { marker: /战争|战场|废墟|炮火/, need: /战争|战场|废墟|炮火/, label: "战争" },
  { marker: /雪|下雪|飘雪/, need: /雪/, label: "雪景" },
  { marker: /沙漠|戈壁/, need: /沙漠|戈壁/, label: "沙漠" },
  { marker: /海底|水下/, need: /海底|水下/, label: "水下" }
  ,
  /** 天空类现象需要"露天/天空"语境：室内食肆镜头不该被注入"落日剪影"（2026-09-24 真机） */
  { marker: /落日|夕阳|日出|星空|银河|极光|云层|丁达尔/, need: /天空|露天|户外|室外|日出|日落|落日|夕阳|星空|山|海|河|湖|街|桥|院|园|巷/, label: "户外天空" }
];

function styleConflict(entry, cardText) {
  const text = `${entry.intent} ${entry.zh} ${entry.en}`;
  for (const rule of STYLE_CONFLICT_MARKERS) {
    if (rule.marker.test(text) && !rule.need.test(cardText)) return rule.label;
  }
  return null;
}

/** 条目文本里的时段/天气标记（与卡片上下文冲突时扣分） */
const ENTRY_TIME_MARKERS = [
  { key: "dusk", pattern: /黄金时刻|日落|落日|夕阳|夕照|余晖|晚霞|暖金/ },
  { key: "night", pattern: /夜景|霓虹|烛光|夜晚|深夜/ },
  { key: "blueHour", pattern: /蓝调|blue hour/ },
  { key: "morning", pattern: /清晨|日出|晨光/ }
];
const ENTRY_WEATHER_MARKERS = [
  { key: "rain", pattern: /雨/ },
  { key: "snow", pattern: /雪/ },
  { key: "fog", pattern: /雾/ }
];

/** 冲突惩罚：日光镜头不配黄金时刻/夜景配方；无雨不配雨天配方（反之亦然） */
function contradictionPenalty(entry, context) {
  const text = `${entry.intent} ${entry.zh} ${entry.en}`;
  let penalty = 0;
  const reasons = [];
  for (const marker of ENTRY_TIME_MARKERS) {
    if (!marker.pattern.test(text)) continue;
    /**
     * 五轮审计：原列表里混进了 `"overcast"`——它是 **weather** 的键，永远不可能出现在 `timeOfDay` 里，
     * 属死条件（`every()` 只会因此更宽松而永远不成立）。移除后语义不变、可读性恢复。
     */
    const daytimeOnly = context.timeOfDay.length > 0 && context.timeOfDay.every((t) => ["morning", "noon", "afternoon"].includes(t));
    if ((marker.key === "dusk" || marker.key === "night" || marker.key === "blueHour") && daytimeOnly && !context.timeOfDay.includes(marker.key)) {
      penalty += 12;
      reasons.push(`${marker.key}≠日景`);
    }
  }
  for (const marker of ENTRY_WEATHER_MARKERS) {
    if (!marker.pattern.test(text)) continue;
    if (context.weather.length > 0 && !context.weather.includes(marker.key)) {
      penalty += 8;
      reasons.push(`${marker.key}≠当前天气`);
    }
  }
  return { penalty, reasons };
}

/** 从 25 字段卡里抽取检索信号（带权重），并保留原文用于打分 */
export function shotSignals(card) {
  const source = normalizeShotIntent(card).source;
  card = { ...(source.fields ?? {}), ...source };
  const parts = [];
  for (const [field, weight] of SIGNAL_FIELDS) {
    const raw = card?.[field];
    const text = Array.isArray(raw)
      ? raw.map((x) => (typeof x === "string" ? x : JSON.stringify(x))).join(" ")
      : typeof raw === "string" ? raw : raw ? JSON.stringify(raw) : "";
    if (norm(text)) parts.push({ field, weight, text: norm(text) });
  }
  return { text: parts.map((p) => p.text).join(" "), parts };
}

/** 主题打分：索引关键词命中（用于"要不要查这篇"，条目级打分决定"取哪一句"） */
export function scoreTopic(topic, signals, indexEntry) {
  const keywords = [...(indexEntry?.keywords ?? []), topic.title.replace(/（.*?）/g, "")];
  let score = 0;
  const hits = [];
  for (const part of signals.parts) {
    for (const kw of keywords) {
      const k = norm(kw);
      if (k.length >= 2 && part.text.includes(k)) {
        score += part.weight * 2;
        hits.push({ kind: "keyword", value: kw, field: part.field });
      }
    }
  }
  return { topicId: topic.id, title: topic.title, score, hits };
}

/** 中文 2-gram，用于"条目文本 vs 镜头卡原文"的粗粒度重合度（无需分词依赖） */
function bigrams(text) {
  const clean = norm(text).replace(/[^\u4e00-\u9fa5a-z0-9]+/g, "");
  const out = new Set();
  for (let i = 0; i + 2 <= clean.length; i += 1) out.add(clean.slice(i, i + 2));
  return out;
}

/**
 * 条目级打分（决定"这一篇里取哪一句"）：
 *   + 意图原文命中卡片（强信号，×6）
 *   + 条目中文/英文与卡片原文的 2-gram 重合（弱信号，最多 +6）
 *   + 命中该篇索引关键词（×1）
 *   + NARR-001 情绪配方命中（配方层，额外 +4，并作为扩展检索的驱动词）
 *   − 时段/天气矛盾（黄金时刻/夜景/雨雪与卡片上下文冲突）
 */
export function scoreEntry(entry, topic, cardText, context, indexKeywords = []) {
  const entryText = `${entry.intent} ${entry.zh} ${entry.en}`;
  const intent = norm(entry.intent);
  let score = 0;
  const reasons = [];
  if (intent.length >= 2 && cardText.includes(intent)) { score += 6; reasons.push("意图命中"); }
  const a = bigrams(entryText);
  const b = bigrams(cardText);
  let overlap = 0;
  for (const g of a) if (b.has(g)) overlap += 1;
  const overlapScore = Math.min(6, overlap);
  if (overlapScore > 0) { score += overlapScore; reasons.push(`重合+${overlapScore}`); }
  const kwHit = indexKeywords.filter((k) => k.length >= 2 && entryText.includes(k)).length;
  if (kwHit > 0) { score += Math.min(3, kwHit); reasons.push(`关键词+${kwHit}`); }
  if (topic.id === "NARR-001" && score > 0) { score += 4; reasons.push("情绪配方层"); }
  const { penalty, reasons: conflicts } = contradictionPenalty(entry, context);
  if (penalty > 0) { score -= penalty; reasons.push(`冲突-${penalty}(${conflicts.join("/")})`); }
  /**
   * 硬冲突（2026-09-24 真机）：日景镜头被注入"逆光日落剪影"——只扣分不够，
   * 因为该条在其它维度（光影/构图）重合度高，扣完仍可能进前 6。
   * 判据：时段类冲突罚分 ≥12 直接判为**不可注入**。
   */
  const hardTimeConflict = conflicts.some((c) => /dusk|night|blueHour|≠日景/.test(c)) && penalty >= 12;
  const styleIssue = styleConflict(entry, cardText);
  if (styleIssue) { score -= 10; reasons.push(`风格冲突(${styleIssue})`); }
  return { score, reasons, hardConflict: hardTimeConflict || Boolean(styleIssue), styleIssue };
}

/**
 * 为一张镜头卡挑出要注入的知识条目。
 * @returns {{ ranked: Array, picks: Array<{topicId,intent,zh,en,section}>, missingTopics: Array }}
 */
export function selectEntries(kb, card, options = {}) {
  const intent = resolveShotIntent(card, options.intent);
  card = { ...(intent.source.fields ?? {}), ...intent.source };
  const maxEntries = options.maxEntries ?? 6;
  /** 注入阈值提到 4：2-gram 偶然重合（1–2 分）不足以证明"这条知识适用于这个镜头" */
  const minScore = options.minScore ?? 4;
  const explicit = options.topics ?? null; // 允许监制指定主题（如 ["NARR-001","LIGHT-003"]）
  const signals = shotSignals(card);
  /**
   * 条目打分必须用**剥离否定语境后**的文本（2026-09-25 五轮审计）：
   * 见下方 scoreEntry 调用处的说明。
   */
  const scoredText = stripNegatedContext(signals.text);
  const context = detectContext(card);
  const indexById = new Map(kb.index.topics.map((t) => [t.id, t]));

  /** ① 主题层：命中索引关键词的主题（决定检索范围） */
  const topicScores = kb.topics
    .map((topic) => ({ topic, score: scoreTopic(topic, signals, indexById.get(topic.id)).score, hits: scoreTopic(topic, signals, indexById.get(topic.id)).hits }))
    .filter((r) => (explicit ? explicit.includes(r.topic.id) : r.score > 0 || r.topic.id === "NARR-001"))
    .sort((a, b) => b.score - a.score || a.topic.id.localeCompare(b.topic.id));

  /** ② 条目层：在命中主题里逐个条目打分，全局排序取前 N（"一剑封喉"=取最合适的少数几句） */
  const scored = [];
  /** NARR-001 只做**派发**不直注（KB 总则：先取情绪配方，再按配方回查细节） */
  let recipeDispatch = null;
  for (const { topic, score } of topicScores) {
    const indexKeywords = indexById.get(topic.id)?.keywords ?? [];
    for (const entry of topic.entries) {
      /**
       * 早先把**原始文本**（含"避免…""不要…"）交给 scoreEntry，于是否定指令反而满足了
       * `styleConflict()` 的白名单条件——卡里写"避免赛博朋克全息广告"，条目池照样把
       * STYLE-001#赛博朋克 以 10.8 分送进候选（运行时复现）。改用 scoredText 后，
       * 意图命中、2-gram 重合、风格冲突三项判定都只看**未被否定**的内容。
       */
      const { score: entryScore, reasons, hardConflict } = scoreEntry(entry, topic, scoredText, context, indexKeywords);
      if (hardConflict) continue; // 时段/光照矛盾的知识一律不许进提示词
      if (entryScore <= 0) continue;
      /**
       * NARR-001 一律不直注（配方是"整条片子的配方"，塞进单个字段会自相矛盾）。
       * 只有**情绪被镜头卡明确写到**时才登记为派发线索，用于指导其它主题检索。
       */
      if (topic.id === "NARR-001") {
        /** 情绪派发同样只看未被否定的表述（"不要孤独感"不该派发孤独配方） */
        const moodText = stripNegatedContext(norm(`${card?.mood ?? ""} ${card?.director_instruction ?? ""} ${card?.genre ?? ""}`));
        if (!recipeDispatch && moodText.includes(norm(entry.intent))) {
          recipeDispatch = { intent: entry.intent, emotion: entry.zh, recipe: entry.en, score: entryScore, basis: "mood-explicit-match" };
        }
        continue;
      }
      scored.push({
        topicId: topic.id, topicTitle: topic.title, section: entry.section, intent: entry.intent,
        zh: entry.zh, en: entry.en, score: entryScore + score * 0.2, entryScore, reasons
      });
    }
  }
  scored.sort((a, b) => b.score - a.score || a.topicId.localeCompare(b.topicId));

  /** ③ 去重 + 配额：同一字段最多 2 条，且同一条不重复注入多个字段 */
  const picks = [];
  const perTopic = new Map();
  for (const item of scored) {
    if (picks.length >= maxEntries) break;
    if (item.entryScore < minScore) continue;
    const used = perTopic.get(item.topicId) ?? 0;
    if (used >= 2) continue;
    if (picks.some((p) => p.zh === item.zh)) continue;
    picks.push(item);
    perTopic.set(item.topicId, used + 1);
  }
  return {
    ranked: topicScores.map((r) => ({ topicId: r.topic.id, title: r.topic.title, score: r.score, hits: r.hits.length })),
    picks,
    context,
    recipeDispatch,
    signals: signals.text.slice(0, 400),
    missingTopics: kb.missingTopics
  };
}

/* ================= 字段注入 ================= */

/**
 * （已删除）`TOPIC_TARGET_FIELDS` 主题→字段映射表。
 * 2026-09-25 五轮审计确认：该表**除定义外没有任何引用**（字段落点早已由 `INJECTION_RULES[].field` 决定），
 * 留着只会让人以为"字段映射在另一处维护"。落点口径以 `INJECTION_RULES` 为唯一事实源。
 */
/** 一条知识 → 注入句式（中文写法为主，附英文关键词给国际模型） */
/**
 * 行 → 提示词短语。
 *
 * `englishGloss` 默认 **false**（2026-09-24 真机二次校准）：分镜卡的【语言约束】写明
 * "全部字段必须使用中文输出，禁止出现英文单词/短语"，而知识库行的英文括注（如
 * "（bright afternoon sunlight, directional sunlight, clean daylight）"）会被监制判为
 * **自违约束**并打回。默认只下发中文短语；英文关键词仍完整保留在 trace（picks 的 zh/en）里，
 * 供需要英文提示词的模型/场景显式开启（`enrichShotCard(..., { englishGloss: true })`）。
 */
function phraseFor(pick, englishGloss = false) {
  const zh = pick.zh.replace(/[。；;]\s*$/, "");
  return englishGloss && pick.en ? `${zh}（${pick.en}）` : zh;
}

/**
 * KB 行里的**占位符**必须在进提示词之前落成具体元素。
 *
 * 知识库里有模板行，例如 CINE-001「固定机位观察」原文是
 * 「固定机位，镜头完全静止，画面内**［元素］**自行运动」——占位符直接下发，
 * 模型会把它当字面文本（真机监制打回："[元素] 未实例化"）。
 * 这里按卡片已有元素填：灯笼 / 水面与倒影 / 摇橹船 / 往来行人 / 人物与光影；
 * 一个都推不出来时用"画面内元素"兜底（去掉方括号，避免字面占位符进入提示词）。
 */
function resolvePlaceholders(phrase, ctx) {
  if (!/\[[^\]\n]{1,12}\]/.test(phrase)) return { phrase, changed: false };
  const candidates = [];
  if (/灯笼/.test(ctx.text)) candidates.push("灯笼");
  if (/水面|河|湖|倒影|波纹/.test(ctx.text)) candidates.push("水面与倒影");
  if (/船|乌篷|摇橹/.test(ctx.text)) candidates.push("摇橹船");
  if (/行人|游客|人群/.test(ctx.text)) candidates.push("往来行人");
  if (/花瓣|柳絮|落叶/.test(ctx.text)) candidates.push("飘落的花叶");
  if (candidates.length === 0) candidates.push("画面内元素");
  let index = 0;
  const filled = phrase.replace(/\[[^\]\n]{1,12}\]/g, () => candidates[Math.min(index++, candidates.length - 1)]);
  return { phrase: filled, changed: filled !== phrase };
}

/* ================= 意图 → 知识行（确定性注入表） ================= */

/**
 * 为什么不用相似度做**自动注入**（2026-09-24 真机教训）：
 * 中文 2-gram 重合会被"画面/光线/人物/镜头"这类高频词带偏——日景口播镜头被注入"逆光日落剪影"、
 * 中景镜头被注入"大远景，人物渺小"、平静清晨被注入"运动人像，动态模糊"。
 * 这类错误一旦进提示词，出来的画面就是"参数对、气质错"。
 *
 * 因此自动注入改为**确定性映射**：先用上下文/词面判断"这个镜头有没有这个意图"，
 * 有才去知识库里取**指定那一行**（措辞仍取 KB 原文，不另写文案），没有就不加。
 * 自由检索能力保留在 `selectEntries()` / `cine-kb-cli search`，供 Agent 主动提问用。
 */
/**
 * 卡片是否**明写了日光来源**（窗光/正午/阴天散射/黄金时刻/雪地反光）。
 * 用于让"室内"兜底规则给显式光源让路（四轮审计，见 indoor-warm-mix 注释）。
 */
function hasExplicitDaylight(c) {
  return Boolean(c.windowLight || c.noon || c.overcast || c.goldenHour || c.snow || c.blueHour);
}

const INJECTION_RULES = [
  /* ---------- 光线 ---------- */
  /** 蓝调时刻必须最先判（2026-09-24 三轮审计：放在夜景规则后面会被"电影感夜景"抢位） */
  /** 蓝调时刻：日落后天光偏蓝，与"夜晚霓虹/灯笼"是两种光（原来会掉到 night-film 或干脆不注入） */
  { field: "lighting", id: "blue-hour", when: (c) => c.blueHour, topic: "LIGHT-002", row: "蓝调时刻" },

  /**
   * 显式人工光意图优先于通用夜景（四轮审计）：
   * 「舞台追光 / 烟花夜空 / 车轨长曝」在 LIGHT-003 §六 都有**点名的行**，
   * 但早先没有任何规则引用它们——舞台镜头零注入、烟花镜头只在光圈侧兜底、
   * 车轨镜头拿到泛化的「电影感夜景」，最贴切的那条知识反而没进提示词。
   */
  { field: "lighting", id: "stage-light", when: (c) => c.stageLight, topic: "LIGHT-003", row: "舞台追光" },
  { field: "lighting", id: "fireworks", when: (c) => c.fireworks && c.night, topic: "LIGHT-003", row: "烟花夜空" },
  { field: "lighting", id: "car-trails", when: (c) => c.lightTrail, topic: "LIGHT-003", row: "车轨长曝" },

  /** 灯笼夜景优先用"电影感夜景"，只有画面强调光斑时才用"城市光斑虚化"（避免给收尾镜注入"孤独空旷街角"的调性） */
  { field: "lighting", id: "night-bokeh-first", when: (c) => c.night && c.lantern && c.bokeh && !c.neon, topic: "LIGHT-003", row: "城市光斑虚化" },
  { field: "lighting", id: "night-lantern", when: (c) => c.night && c.lantern && !c.neon, topic: "LIGHT-003", row: "电影感夜景" },
  { field: "lighting", id: "night-neon", when: (c) => c.night && c.neon, topic: "LIGHT-003", row: "霓虹街头" },
  { field: "lighting", id: "night-bokeh", when: (c) => c.night && (c.bokeh || c.person), topic: "LIGHT-003", row: "城市光斑虚化" },
  { field: "lighting", id: "night-film", when: (c) => c.night && !c.neon && !c.lantern, topic: "LIGHT-003", row: "电影感夜景" },
  /**
   * 室内兜底**必须给卡片已明写的光源让路**（2026-09-25 四轮审计）：
   * 早先只要命中"室内/店内"就注入「钨丝灯室内」或「混合色温（室内暖+窗外冷）」，
   * 于是三条真机口径全部走样：
   *   · 「室内，窗边柔光」的老年肖像 → 被写成"暖黄钨丝灯下的温馨室内"（卡片明写窗光）；
   *   · 「阴天的茶室，木格窗外是青瓦白墙」→ 被写成钨丝灯，阴天散射光反而没进去；
   *   · 「正午的室内，强光从窗户斜射」→ 被写成"窗外蓝调天光"（正午不可能是蓝调）。
   * 因此室内兜底加排除条件：窗光 / 正午 / 阴天散射 / 黄金时刻 / 雪景 任一显式成立时，让位给后面的专用规则。
   */
  { field: "lighting", id: "indoor-warm-mix", when: (c) => c.interior && c.mixedLight, topic: "LIGHT-002", row: "混合色温（室内暖+窗外冷）" },
  { field: "lighting", id: "indoor-tungsten", when: (c) => c.interior && c.tungsten, topic: "LIGHT-003", row: "钨丝灯室内" },
  /**
   * 雪景光：阴天散射 + 雪面反光（先于阴天软光判定，避免雪天被当成普通阴天）。
   * 五轮审计收口：只在**正在下雪**时用「落雪安静」——该行原文写的是"雪花缓缓飘落"，
   * 用在"雪后 / 屋顶积雪"的镜头上自相矛盾。雪后静景目前 KB 无对应行（已登记缺口 G18），
   * 由卡片自述承担（与"上午光"同一处置口径）。
   */
  { field: "lighting", id: "snow-light", when: (c) => c.snowNow, topic: "SCENE-001", row: "落雪安静" },
  /**
   * 雨天时序（五轮审计）：雨后走 SCENE-001 §6.2「雨后初晴」（"雨停后阳光刺破云层，湿街反射金色天光"）——
   * 这是 KB 里唯一正对"雨停之后"的行；夜景雨后不适用（该行描述的是阳光），阴天雨后也排除（否则与阴天冲突）。
   */
  { field: "lighting", id: "after-rain", when: (c) => c.rain && !c.rainNow && c.rainCleared && !c.night && !c.overcast, topic: "SCENE-001", row: "雨后初晴" },
  /** 正午硬光：烈日顶光，与"上午/下午斜光"不同（三轮审计：正午被误判成午后） */
  { field: "lighting", id: "noon-hard", when: (c) => c.noon && !c.overcast, topic: "LIGHT-002", row: "正午硬光（纪实/压迫）" },
  { field: "lighting", id: "overcast-soft", when: (c) => c.overcast && !c.snow, topic: "LIGHT-001", row: "阴天软光" },
  /** 斜光只在明确写了上午/下午时生效（避免"正午/白天"被当成斜光） */
  /**
   * 斜光行**只给下午**（2026-09-24 真机二次校准）：LIGHT-002 这一行的措辞是
   * "明亮的**午后**阳光，方向明确的斜射光"，早先只要卡片出现"上午/清晨"也会注入，
   * 于是"上午十点散射日光"的镜头里同时出现"午后阳光"——灯光时段自相矛盾（监制据此打回）。
   * 上午/清晨镜头的光由卡片自身措辞承担；KB 缺一行"上午光"已登记为缺口。
   */
  { field: "lighting", id: "day-afternoon", when: (c) => c.day && !c.overcast && !c.interior && !c.windowLight && !c.noon && !c.blueHour && /下午|午后|afternoon/.test(c.text), topic: "LIGHT-002", row: "上午/下午日常斜光" },
  /**
   * 逆光三兄弟的优先级（2026-09-24 三轮审计）：
   * 「有意剪影 / 轮廓光」比「黄金时刻」更具体——原来是黄金时刻先命中（日落语境必然同时命中），
   * 于是明确写着"人物呈剪影"的镜头被注入"低角度暖金色阳光、长影子"，剪影诉求被吃掉。
   * 顺序：剪影 > 轮廓光 > 黄金时刻；黄金时刻再补一条 `!silhouette` 兜底。
   */
  { field: "lighting", id: "silhouette", when: (c) => c.silhouette, topic: "LIGHT-001", row: "逆光剪影" },
  { field: "lighting", id: "rim-light", when: (c) => c.rimLight && !c.silhouette, topic: "LIGHT-001", row: "金色轮廓光" },
  { field: "lighting", id: "golden-hour", when: (c) => c.goldenHour && !c.silhouette && !c.rimLight, topic: "LIGHT-002", row: "黄金时刻通用" },
  { field: "lighting", id: "window-light", when: (c) => c.windowLight, topic: "LIGHT-001", row: "柔美窗光" },
  { field: "lighting", id: "fog-light", when: (c) => c.fog, topic: "LIGHT-001", row: "朦胧逆光雾感" },
  { field: "lighting", id: "candle", when: (c) => c.candle, topic: "LIGHT-001", row: "烛光 / 火光" },

  /* ---------- 构图 / 机位 ---------- */
  /**
   * 七条 `id:"framing"` 规则已删除（2026-09-25 五轮审计 · 死规则清理）。
   *
   * 它们写的是 `when: (c) => c.framing === "中景"` 这类条件，而循环里又有一条
   * `if (rule.id === "framing" && ctx.framingKnown) continue;`——`c.framing` 非空蕴含 `framingKnown`，
   * 于是**这七条永远不可能命中**（运行时复现：`景别：中景 / 近景 / 特写 / 大特写` 四种卡片，composition 注入均为"无"）。
   * 即便去掉守卫也不会更有价值：卡片自己已经写了景别，再注入一行"中景，腰部以上"只是重复；
   * CINE-002 的景别行改为**只经自由检索**可达（`cine-kb-cli search`），已在 round5 报告登记。
   */
  /**
   * 回头类动作**必须真在走动**才用「故事感回头」（五轮审计）：
   * 该行中文写法是"行走中回头看向镜头"，断言了"行走"这个动作。
   * 复现：`{action:"回眸一笑，身体不动", camera_movement:"固定机位"}` 被注入"行走中回头看向镜头"——
   * 与卡片的"静止"直接冲突（与 playbook §一 事故 5 同源，只是触发词不同）。
   * 静止回眸目前 KB 无对应行（已登记缺口 G19），由卡片自述承担。
   */
  { field: "composition", id: "look-back", when: (c) => c.person && c.lookBack && c.walking && c.lookAtCamera, topic: "HUMAN-001", row: "故事感回头" },
  { field: "composition", id: "eyelevel", when: (c) => c.person && c.eyeLevel && !c.framingKnown, topic: "HUMAN-001", row: "平等真实" },

  /* ---------- 运镜 ---------- */
  { field: "camera_movement", id: "follow-side", when: (c) => c.person && c.walking && c.follow, topic: "CINE-001", row: "侧面平行跟拍" },
  /** 人物站着讲话、镜头横移跟随手势 → "水平摇镜环顾"，而不是"跟随行走"（2026-09-24 真机） */
  { field: "camera_movement", id: "pan-with", when: (c) => !c.walking && c.panWith, topic: "CINE-001", row: "水平摇镜环顾" },
  { field: "camera_movement", id: "dolly-in", when: (c) => c.pushIn && !c.walking, topic: "CINE-001", row: "缓慢推近人物特写" },
  { field: "camera_movement", id: "handheld", when: (c) => c.handheld, topic: "CINE-001", row: "手持纪实感" },
  { field: "camera_movement", id: "orbit", when: (c) => c.orbit, topic: "CINE-001", row: "环绕展示（高光）" },
  { field: "camera_movement", id: "aerial", when: (c) => c.aerial, topic: "CINE-001", row: "无人机上帝视角" },
  { field: "camera_movement", id: "static", when: (c) => c.staticCamera && c.person, topic: "CINE-001", row: "固定机位观察" },

  /* ---------- 色调 / 影调 ---------- */
  { field: "color_palette", id: "desaturated-film", when: (c) => c.jiangnan || c.lowSat, topic: "COLOR-001", row: "电影感去饱和" },
  { field: "color_palette", id: "soft-elegant", when: (c) => c.highEnd, topic: "COLOR-001", row: "高级灰 / 高级感" },
  { field: "color_palette", id: "japanese-fresh", when: (c) => c.fresh, topic: "COLOR-001", row: "日系清新" },
  { field: "color_palette", id: "night-shadow-detail", when: (c) => c.night, topic: "COLOR-002", row: "暗部有层次" },
  { field: "color_palette", id: "high-key", when: (c) => c.brightAiry, topic: "COLOR-002", row: "高调、轻盈通透" },
  { field: "color_palette", id: "low-key", when: (c) => c.moody, topic: "COLOR-002", row: "低调、深沉" },

  /* ---------- 材质 / 道具（真实感的最后 10%） ---------- */
  /** 落雪（props）：同样只在**正在下雪**时注入（五轮审计，与 lighting 同口径） */
  { field: "props", id: "snow-fall", when: (c) => c.snowNow, topic: "SCENE-001", row: "落雪安静" },
  /** 倒影只在"平静水面"语境命中（三轮审计：水下镜头/冰面/产品白背景曾被误注入镜面倒影） */
  { field: "props", id: "reflection", when: (c) => c.mirrorWater && !c.rain, topic: "PHYS-001", row: "镜面倒影" },
  /**
   * 玻璃幕墙/玻璃面反射（四轮审计）：PHYS-002 §六 有「玻璃反射」行，但没有任何规则引用它，
   * 于是"玻璃幕墙映出街景与云层"这类镜头零知识注入（指标池里也没有对应信号词）。
   */
  { field: "props", id: "glass-reflection", when: (c) => c.glassWall, topic: "PHYS-002", row: "玻璃反射" },
  { field: "props", id: "water-ripple", when: (c) => c.water && c.watercraft && !c.snow, topic: "PHYS-001", row: "湖面微澜" },
  /** 细雨只在**正在下**时注入（五轮审计：雨后不再注入"雨丝如雾"） */
  { field: "props", id: "drizzle", when: (c) => c.rainNow && !c.heavyRain, topic: "PHYS-001", row: "毛毛细雨" },
  /** 暴雨：此前没有任何规则引用「暴雨倾盆」行（五轮审计补上） */
  { field: "props", id: "downpour", when: (c) => c.rainNow && c.heavyRain, topic: "PHYS-001", row: "暴雨倾盆" },
  /**
   * 蒸汽行（2026-09-24 真机三轮校准）：PHYS-001 §2.8「蒸汽」的**提示词写法示例是咖啡专用**
   * （"热气从咖啡杯口袅袅升起 … steam rising from a cup of coffee"），
   * 早先只要有"食物+蒸汽"就注入它 → 糖粥/汤面场景的提示词里出现"咖啡杯"（真机监制据此打回）。
   * 现在只在场景真是咖啡语境时注入；中餐/汤食的蒸汽由镜头卡自己的 props/action 描述承担
   * （KB 缺口：缺一行中餐蒸汽，已在三轮审计文档登记）。
   */
  { field: "props", id: "steam-coffee", when: (c) => c.food && c.steam && /咖啡|拿铁|咖啡杯|espresso|latte/i.test(c.text), topic: "PHYS-001", row: "咖啡热气" },
  /**
   * 丝绸光泽归**服装材质**而不是道具（真机监制打回："丝绸表面光泽随动作流动"被当成道具串场）。
   * 旗袍/缎面属于人物造型的一部分，写进 costume 才不会被读成画面里的独立物体。
   */
  { field: "costume", id: "silk", when: (c) => c.silk, topic: "PHYS-002", row: "丝绸光泽流动" },
  /**
   * 食物质感行只在**真的有酱/汁/炖/烤**时注入（真机 2026-09-24 三轮校准）：
   * 早先只要命中"食物"就注入"酱汁油亮挂壁" → 桂花糖粥/海棠糕的镜头里出现"酱汁"，
   * 监制按"字段模板串场"打回。
   */
  { field: "props", id: "food-texture", when: (c) => c.food && /酱|汁|炖|卤|烤|油亮|挂壁|油光/.test(c.text), topic: "PHYS-002", row: "油亮酱汁" },
  { field: "makeup", id: "skin-texture", when: (c) => c.person && c.faceVisible && (c.closeup || c.personSkin), topic: "PHYS-002", row: "真实皮肤（通用）" },
  /**
   * 烛火特写要求画面里**真有火焰**（烛光/蜡烛/篝火/火锅），灯笼不算（真机 2026-09-24 校准）：
   * 白天支巷挂红灯笼的镜头被注入"烛火小而稳定…暖光晕开"，监制按道具串场打回。
   * 灯笼场景的光效由 LIGHT-003 的电影感夜景/光斑虚化承担。
   */
  { field: "props", id: "candle-glow", when: (c) => c.candle, topic: "PHYS-001", row: "烛光特写" },

  /* ---------- 画质基线 ---------- */
  { field: "baseline", id: "clean-commercial", when: (c) => c.cleanLook && !c.filmGrain, topic: "OPTICS-004", row: "商业级干净画面" },
  { field: "baseline", id: "film-grain", when: (c) => c.filmGrain, topic: "OPTICS-004", row: "电影胶片颗粒" },
  { field: "baseline", id: "night-grain", when: (c) => c.night && c.handheld, topic: "OPTICS-004", row: "手持夜景颗粒" }
];

/** 从镜头卡抽取"注入决策上下文"（纯词面判断，可解释、可测试） */
export function injectionContext(card) {
  /** 与 detectContext 同口径：同一张字段表 + **先剥否定语境**（"避免日落时段的金色调"不能被读成"要日落"） */
  const intent = normalizeShotIntent(card);
  const text = intent.scene.positiveText;
  const has = (re) => re.test(text);
  const framingHit = ["大远景", "远景", "全景", "中近景", "中景", "近景", "特写"].find((f) => text.includes(f));
  return {
    text, intent,
    /**
     * 夜间信号只认"真的在夜里"：灯笼/烛光是**点光源**，白天巷口挂灯笼不等于夜景
     * （2026-09-24 真机：白天巷子被注入"暖橙钠灯光池"）。
     */
    /**
     * 夜间信号（四轮审计补 `夜空|跨年夜|午夜|凌晨`）：
     * "跨年夜的城市上空，烟花绽放"早先因为只写"跨年"没有"夜晚/夜色"字面 → 判成日景，
     * 既没进夜景规则也没进烟花规则（零知识注入 + 落 f/5.6 打卡档）。
     */
    night: intent.scene.timeOfDay.includes("night"),
    /** 蓝调时刻是"暮色"而非深夜：单独识别，灯光规则要按蓝调走（2026-09-24 三轮审计） */
    blueHour: intent.scene.timeOfDay.includes("blueHour"),
    /**
     * 白天信号（三轮审计补 "明亮/自然光/光线充足"）：
     * "服装店内景…明亮"早先因为没有"白天/日光"字面被判成"夜间室内" → 注入"暖黄钨丝灯、2800K 温馨居家"。
     * 夜景规则排在本条之前，所以"夜晚的明亮灯市"仍走夜景，不会被误判成白天。
     */
    day: intent.scene.timeOfDay.some((time) => ["morning", "noon", "afternoon", "day"].includes(time)),
    interior: has(/室内|铺内|店内|房间|屋内|屋里|茶馆|食肆|大堂/),
    overcast: has(/阴天|多云|散射光|漫射光|无硬阴影/),
    goldenHour: intent.scene.timeOfDay.includes("dusk") && has(/黄金时刻|magic hour|落日|日落|夕阳/),
    /** 正午硬光：需要与"午后斜光"区分（前者硬、后者斜） */
    noon: has(/正午|中午|晌午|烈日|顶光/),
    neon: has(/霓虹|neon/),
    lantern: has(/灯笼|烛光|暖灯|吊灯|串灯/),
    candle: intent.scene.lightSources.includes("candle"),
    tungsten: intent.scene.lightSources.includes("tungsten"),
    mixedLight: intent.scene.timeOfDay.includes("blueHour") && intent.scene.temperatures.includes("warm") && /室内|屋内/.test(text),
    rimLight: has(/轮廓光|rim light|发丝光/),
    silhouette: has(/剪影|silhouette/),
    windowLight: intent.scene.lightSources.includes("window"),
    fog: has(/雾|水汽|薄雾/),
    rain: has(/雨/),
    rainCleared: has(/初晴|阳光刺破|雨过天晴|雨后.*阳光/),
    heavyRain: has(/暴雨|大雨|倾盆/),
    /**
     * 天气时序（2026-09-25 五轮审计）：早先 `rain` 把"雨后"与"正在下雨"当同一件事，
     * 于是"**雨后**的古镇石板路，积水倒映着白墙黛瓦"被注入"细密雨丝如雾般飘落"（雨已经停了，画面不成立）；
     * 雪后同理被注入"雪花缓缓飘落"。现在拆出"是否正在下"：
     *   · rainNow —— 提到雨且未落到"雨后 / 雨停 / 雨过 / 初晴 / 已停"；
     *   · snowNow —— 必须有"正在下"的字面（下雪 / 雪中 / 飘雪 / 雪花 / 飞雪 / 大雪 / 暴雪 / 雪夜 / 雪粒），
     *     且不能是"雪后 / 雪停 / 残雪 / 融雪"这类已停的表述。
     *     注意：**"积雪"不算停雪证据**——"大雪纷飞…屋顶积雪"是同时成立的（下着雪且已积起来），
     *     所以只把"雪后/雪停/残雪/融雪"作为排除项。
     */
    rainNow: has(/雨/) && !has(/雨后|雨停|雨过|初晴|已停|停了/),
    snowNow: has(/下雪|雪中|飘雪|雪花|飞雪|大雪|暴雪|雪夜|雪粒/) && !has(/雪后|雪停|残雪|融雪/),
    water: has(/水|河|湖|江|倒影/),
    /** 镜面倒影必须是"平静水面"语境；水下/冰面/雪地不算（三轮审计：水下镜头被注入镜面倒影） */
    mirrorWater: has(/倒影|镜面|如镜|平静水面|无风水面|静水/) && !has(/水下|海底|冰|雪/),
    watercraft: has(/船|摇橹|乌篷|橹/),
    /** 舞台/演出语境（四轮审计）：LIGHT-003 §六 有点名的「舞台追光」行 */
    stageLight: intent.scene.lightSources.includes("stage"),
    /** 烟花（四轮审计）：LIGHT-003 §六 有点名的「烟花夜空」行 */
    fireworks: has(/烟花|焰火/),
    /** 玻璃幕墙/玻璃面（四轮审计）：PHYS-002 §六 有点名的「玻璃反射」行 */
    glassWall: has(/幕墙|玻璃墙|玻璃幕墙|玻璃面|玻璃反射/),
    steam: has(/蒸汽|热气|雾气升腾|冒烟|热气腾/),
    /** 食物信号补「汤/砂锅/菜」等（四轮审计：砂锅汤镜头此前连 food 都不成立，food 相关规则整条不评估） */
    food: has(/糖粥|海棠糕|点心|茶食|美食|食物|餐|糕点|小吃|汤|砂锅|菜|饭|面|羹/),
    /** 专项意图（三轮审计新增）：星空/车轨/微距/雪景——这些场景的档位与常规人像/打卡完全不同 */
    starfield: has(/星空|银河|星河|星轨/),
    lightTrail: has(/车轨|车流|光轨|拖影长曝/),
    macro: has(/微距|超近距|昆虫特写|露珠特写/),
    snow: has(/雪/),
    silk: has(/旗袍|缎面|丝绸|绸/),
    person: intent.subject.hasPerson,
    faceVisible: intent.subject.faceVisible,
    closeup: has(/特写|close-?up|面部|脸/i),
    personSkin: has(/皮肤|肤质|毛孔|裸妆/),
    walking: intent.performance.walking,
    follow: intent.camera.modes.includes("tracking"),
    panWith: intent.camera.modes.includes("pan"),
    pushIn: intent.camera.modes.includes("push"),
    handheld: intent.camera.modes.includes("handheld"),
    orbit: intent.camera.modes.includes("orbit"),
    aerial: intent.camera.modes.includes("aerial"),
    staticCamera: intent.camera.modes.includes("static"),
    eyeLevel: has(/平视|eye[- ]level/),
    /**
     * 回头类动作只认**回眸/回头/回望**（2026-09-24 三轮校准）：
     * "转头"大量出现在造型描述里（"发丝随转头轻摆"），早先据此注入"行走中回头看向镜头"，
     * 与卡片写明的"全程正脸、不转身"直接冲突（真机监制据此打回）。
     */
    lookBack: /回眸|回头|回望/.test(intent.performance.action),
    lookAtCamera: /看向镜头|看镜头|望向镜头/.test(intent.performance.action),
    framing: framingHit ?? null,
    framingKnown: Boolean(framingHit),
    jiangnan: has(/江南|水乡|月白|黛青|白墙|青石/),
    lowSat: has(/低饱和|desaturated|低饱和度高明度/),
    highEnd: has(/高级感|高级灰|克制|质感/),
    fresh: has(/日系|清新|空气感/),
    brightAiry: has(/高调|明亮通透|轻盈/),
    moody: has(/低调|暗黑|压抑|悬疑/),
    cleanLook: has(/干净|通透|商业|无噪点/),
    filmGrain: has(/胶片|颗粒|film grain|35mm/),
    bokeh: has(/光斑|bokeh|虚化/),
    rainOrWater: has(/雨|水/)
  };
}

/** 在指定主题里按行名取知识（措辞取 KB 原文） */
function pickRow(kb, topicId, rowLabel) {
  const topic = kb.topics.find((t) => t.id === topicId);
  if (!topic) return null;
  const normLabel = (s) => norm(s).replace(/[\s/／、，,]/g, "");
  const wanted = normLabel(rowLabel);
  const entry = topic.entries.find((e) => normLabel(e.intent) === wanted)
    ?? topic.entries.find((e) => normLabel(e.intent).includes(wanted) || wanted.includes(normLabel(e.intent)));
  if (!entry) return null;
  return { topicId, topicTitle: topic.title, section: entry.section, intent: entry.intent, zh: entry.zh, en: entry.en, kind: entry.kind };
}

const MAX_FIELD_CHARS = 320;

/**
 * 用知识库增强一张镜头卡。
 *
 * @returns {{ card: object, trace: object }}
 *   card  —— 注入后的卡片（字段值为**画面语言**；原值保留在后面，用"；"拼接）
 *   trace —— 审计留痕：命中的主题/条目、技术参数建议（**不进提示词**）、缺篇清单
 */
/** Project a KB example onto explicit source constraints, recording every adaptation. */
function compatibleRow(row, rule, ctx) {
  const intent = ctx.intent;
  let zh = row.zh;
  if (rule.field === "lighting") {
    // A named source outranks broad time/weather examples. In particular, night does not
    // authorize adding city lamps to a candlelit room, nor does noon replace a side window.
    const specific = ctx.candle ? "candle" : ctx.tungsten ? "indoor-tungsten" : ctx.windowLight ? "window-light" : null;
    if (specific && ![specific, "indoor-warm-mix"].includes(rule.id)) return null;
    if (rule.id === "fog-light" && !intent.scene.lightDirections.includes("back")) return null;
    if (["night-bokeh-first", "night-bokeh"].includes(rule.id) && (!ctx.bokeh || intent.scene.depthMode === "deep")) return null;
    if (["night-film", "night-lantern"].includes(rule.id) && !/青橙/.test(intent.scene.positiveText)) zh = zh.replace("，青橙色调", "");
    if (rule.id === "blue-hour" && !/城市|街道|市区|楼宇/.test(intent.scene.positiveText)) zh = "蓝调时刻，环境天光偏蓝";
  }
  if (rule.field === "camera_movement") {
    if (intent.camera.hardStatic && rule.id !== "static") return null;
    if (intent.camera.modes.includes("static") && rule.id !== "static") return null;
    if (rule.id === "static" && /晃动|微动|呼吸/.test(intent.camera.positiveText)) return null;
    if (rule.id === "dolly-in" && (!intent.subject.faceVisible || intent.subject.shotScale !== "close")) zh = zh.replace("至人物面部", "");
    if (rule.id === "pan-with") {
      const camera = intent.camera.positiveText;
      if (/右.*左/.test(camera)) zh = zh.replace("从左向右", "从右向左");
      else if (!/左.*右/.test(camera)) zh = zh.replace("从左向右", "");
      if (!/全景/.test(shotText(intent.source.composition))) zh = zh.replace(/，扫过全景/, "");
    }
    if (rule.id === "follow-side" && !/侧面|横移|平行/.test(intent.camera.positiveText)) zh = zh.replace("横移", "");
    if (rule.id === "aerial" && !/向前|前飞|前进/.test(intent.camera.positiveText)) zh = zh.replace(/，缓缓向前飞行/, "");
    // Static describes the camera, not a permission to make all scene elements move.
    if (rule.id === "static") zh = zh.replace(/，画面内.*$/, "");
    if (intent.camera.pace === "fast") zh = zh.replace(/缓慢|缓缓/g, "快速");
    else if (intent.camera.pace === "unspecified") zh = zh.replace(/缓慢|缓缓/g, "");
  }
  if (rule.id === "window-light") {
    const direction = intent.scene.lightDirections.includes("right") ? "右侧" : intent.scene.lightDirections.includes("left") ? "左侧" : "";
    zh = zh.replace("左侧大窗", `${direction}窗户`);
    if (!intent.scene.lightSources.includes("daylight")) zh = zh.replace("自然光", "光线");
    const sourceLighting = shotText(intent.source.lighting ?? intent.source.fields?.lighting);
    if (/硬光|直射|强光|锐利阴影/.test(splitShotAssertions(sourceLighting + "；" + intent.scene.text).positive)) {
      zh = zh.replace("柔和的", "").replace(/，面部.*$/, "");
    }
    if (!intent.subject.faceVisible || /照在桌面|照亮桌面|只照物体/.test(sourceLighting + intent.scene.text)) zh = zh.replace(/，面部.*$/, "");
  }
  if (rule.id === "rim-light") {
    if (!ctx.goldenHour) zh = "主体边缘呈现轮廓光";
    else if (!intent.subject.faceVisible) zh = "夕阳从主体身后照来，主体边缘被轮廓光勾勒";
  }
  if (rule.id === "silhouette") {
    if (!ctx.goldenHour || !intent.subject.hasPerson) zh = "主体呈深色剪影，轮廓分明";
    else if (!/背对/.test(intent.scene.positiveText)) zh = zh.replace("人物背对落日", "人物在落日逆光中");
  }
  if (rule.id === "overcast-soft") zh = "阴天柔和漫射光，无硬阴影";
  if (rule.id === "candle" && !intent.subject.faceVisible) zh = zh.split("，")[0];
  if (!intent.subject.hasPerson && /人物|人像|面部|皮肤|肤感|发丝|全身/.test(zh)) return null;
  if (!intent.subject.faceVisible && /面部|皮肤|肤感|发丝/.test(zh)) return null;
  const temp = intent.scene.temperatures;
  if (temp.includes("neutral") && /青橙|青绿|暖黄|冷蓝|冷白|金色|橙色/.test(zh)) return null;
  if (temp.includes("warm") && !temp.includes("cool") && /青橙|青绿|冷白|冷蓝|蓝调/.test(zh)) return null;
  if (temp.includes("cool") && !temp.includes("warm") && /暖色|暖黄|金色|橙色/.test(zh)) return null;
  const negative = intent.scene.negativeConstraints.join("；");
  if (/蓝调|冷白|冷色/.test(negative) && /蓝调|冷白|冷色/.test(zh)) return null;
  if (/暖黄|暖色|金色/.test(negative) && /暖黄|暖色|金色/.test(zh)) return null;
  return { ...row, zh, en: zh === row.zh ? row.en : "", ...(zh !== row.zh ? { adaptation: { originalZh: row.zh, adaptedZh: zh, basis: "source-subject-camera-light-constraints" } } : {}) };
}

export function enrichShotCard(kb, card, options = {}) {
  let intent;
  try { intent = resolveShotIntent(card, options.intent); } catch (error) {
    return { card: card && typeof card === "object" && !Array.isArray(card) ? { ...card } : card,
      trace: { schemaVersion: "workloom.cine-kb-trace/v1", policyVersion: CINE_KB_POLICY_VERSION, status: "unverified", errorCode: error.code ?? "SHOT_INTENT_INVALID", error: error.message, sourceHash: null, intentHash: null, applied: [], picks: [], ranked: [], explored: [], apertureAdvisor: null, suggestedParams: {}, recipeDispatch: null, missingTopics: kb?.missingTopics ?? [] } };
  }
  try {
    if (!Array.isArray(kb?.topics) || !kb.topics.length) throw new Error("CINE_KB_EMPTY: 知识库没有可用主题");
    const source = { ...(intent.source.fields ?? {}), ...intent.source };
    const ctx = injectionContext(source);
    const maxInjections = options.maxInjections ?? 5;
    if (!Number.isInteger(maxInjections) || maxInjections < 0 || maxInjections > 50) throw new Error("CINE_KB_OPTIONS_INVALID: 注入上限必须为 0–50 的整数");
    const kbHash = shotIntentHash({ topics: kb.topics.map((topic) => ({ id: topic.id, version: topic.version ?? null, entries: topic.entries, chapters: topic.chapters })), aperture: kb.aperture ?? null });
    const pickedRows = [];
    const rejected = [];
    const usedFields = new Set();
    for (const rule of INJECTION_RULES) {
      if (pickedRows.length >= maxInjections) break;
      if (usedFields.has(rule.field) || !rule.when(ctx)) continue;
      const original = pickRow(kb, rule.topic, rule.row);
      if (!original) { rejected.push({ ruleId: rule.id, reason: "knowledge-row-missing" }); continue; }
      const row = compatibleRow(original, rule, ctx);
      if (!row) { rejected.push({ ruleId: rule.id, reason: "source-intent-incompatible" }); continue; }
      if (pickedRows.some((item) => item.row.topicId === row.topicId && item.row.intent === row.intent)) continue;
      pickedRows.push({ rule, row }); usedFields.add(rule.field);
    }
    const byField = new Map();
    const aperture = options.aperture ? null : recommendAperture(kb, source);
    // Existing depth is authoritative; the advisor still records its compatible recommendation.
    if (aperture && !shotText(source.depth_of_field).trim() && ctx.text.trim() && intent.subject.kind !== "unknown") {
      const phrase = aperture.effectZh + (options.englishGloss && aperture.effectEn ? `（${aperture.effectEn}）` : "");
      if (phrase.trim()) byField.set("depth_of_field", { phrase, topics: ["OPTICS-001"], aperture: aperture.aperture, matchedBy: aperture.matchedBy, advisor: true });
    }
    for (const { rule, row } of pickedRows) {
      const resolved = resolvePlaceholders(phraseFor(row, Boolean(options.englishGloss)), ctx);
      byField.set(rule.field, { phrase: resolved.phrase, topics: [row.topicId], ...(row.adaptation ? { adaptation: row.adaptation } : {}), ...(resolved.changed ? { placeholderResolved: true } : {}) });
    }
    const result = appendShotContributions(card, { owner: "cine-kb", policyVersion: `${CINE_KB_POLICY_VERSION}:${kbHash}`, sourceHash: intent.sourceHash },
      [...byField].map(([field, entry]) => ({ field, text: entry.phrase, maxFieldChars: MAX_FIELD_CHARS })));
    const applied = result.applied.map((entry) => { const { phrase, ...meta } = byField.get(entry.field); return { ...entry, ...meta }; });
    const freeSearch = selectEntries(kb, source, { maxEntries: 5 });
    const status = applied.some((entry) => entry.dropped) || rejected.some((entry) => entry.reason === "knowledge-row-missing") ? "unverified"
      : applied.some((entry) => entry.writtenChars > 0) ? "passed" : intent.subject.kind === "unknown" ? "unverified" : "not_applicable";
    const reused = shotIntentHash(result.card) === shotIntentHash(card) && applied.some((entry) => entry.writtenChars > 0);
    return { card: result.card, trace: {
      schemaVersion: "workloom.cine-kb-trace/v1", policyVersion: CINE_KB_POLICY_VERSION, status,
      sourceHash: intent.sourceHash, intentHash: shotIntentHash(intent), outputHash: shotIntentHash(result.card), kbHash,
      at: new Date().toISOString(), kbDir: kb.dir, reused, signals: ctx.text.slice(0, 400),
      ranked: pickedRows.map(({ rule, row }) => ({ topicId: row.topicId, title: row.topicTitle, ruleId: rule.id, field: rule.field })),
      picks: pickedRows.map(({ rule, row }) => ({ ...row, ruleId: rule.id, field: rule.field })), rejected,
      explored: freeSearch.picks.map((entry) => ({ topicId: entry.topicId, intent: entry.intent, zh: entry.zh })), recipeDispatch: freeSearch.recipeDispatch ?? null,
      applied, actualWrittenFields: applied.filter((entry) => entry.writtenChars > 0).map((entry) => entry.field),
      suggestedParams: {
        ...(aperture ? { aperture: { recommendedRange: aperture.aperture, direction: aperture.direction, scenario: aperture.scenarioLabel, reason: aperture.reason, matchedBy: aperture.matchedBy, source: aperture.source, promptPhrase: applied.find((entry) => entry.field === "depth_of_field")?.written ?? "" } } : {}),
        ...(options.aperture ? { aperture: apertureToEffect(options.aperture) } : {}),
        ...(options.fps ? { shutter: shutterToEffect(options.fps, options.shutterStyle) } : {}),
        ...(options.iso ? { iso: isoToEffect(options.iso) } : {}),
      }, apertureAdvisor: aperture, missingTopics: kb.missingTopics,
      note: "文本规则与写入凭据，不代表视频视觉效果通过；参数建议仅供复核，正文只写画面语言。",
    } };
  } catch (error) {
    return { card: { ...card }, trace: { schemaVersion: "workloom.cine-kb-trace/v1", policyVersion: CINE_KB_POLICY_VERSION, status: "unverified", errorCode: error.code ?? "CINE_KB_ENRICHMENT_FAILED", error: error.message, sourceHash: intent.sourceHash, intentHash: shotIntentHash(intent), applied: [], picks: [], ranked: [], explored: [], apertureAdvisor: null, suggestedParams: {}, recipeDispatch: null, missingTopics: kb?.missingTopics ?? [] } };
  }
}

/** 健康度：给 Agent / 监制看的"库是否可用、缺什么" */
export function kbStatus(kb) {
  return {
    ok: kb.topics.length > 0 && kb.entryCount > 0,
    dir: kb.dir,
    topics: kb.topics.length,
    entries: kb.entryCount,
    bytes: kb.bytes,
    domains: [...new Set(kb.topics.map((t) => t.domain))],
    missingTopics: kb.missingTopics,
    untrackedTopics: kb.untrackedTopics,
    topicsWithEmptyMappings: kb.topics.filter((t) => t.entries.length === 0).map((t) => t.id)
  };
}
