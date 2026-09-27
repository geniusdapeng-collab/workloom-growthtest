/**
 * prompt-language —— 提示词语言与引用归一（2026-09-24 真机交付链）。
 *
 * 两个**系统性**问题（监制逐条读正文时发现，6 镜全部命中）：
 *   ① 分镜卡【语言约束】写明"全部字段必须使用中文输出，禁止出现英文单词/短语"，
 *      而 vendor 组装器会给负面约束加一段英文默认词（`no text, no watermark, no blurry, no extra limbs…`），
 *      **提示词自违约束**——监制按"自相矛盾"打回；
 *   ② 角色图引用被写了两遍（`image://characters/WIFE-01/portrait.png` ×2），监制按"重复引用"打回。
 *
 * 处理口径（不猜、不删信息）：
 *   · 英文负面词**映射成中文等价**（语义不减），映射表是白名单，未命中的英文原样保留；
 *   · 同一 `image://` 路径只保留一次（顺序不变）；
 *   · 归一后剩余的长度 ≥3 的拉丁词会作为报告返回（供审计观察，不静默忽略）。
 */

/** vendor 默认负面词 → 中文等价（白名单；只处理能一一对应的，不做机器翻译） */
const NEGATIVE_GLOSS: Array<{ pattern: RegExp; zh: string }> = [
  { pattern: /\bno\s+text\b/gi, zh: "无文字" },
  { pattern: /\bno\s+watermark\b/gi, zh: "无水印" },
  { pattern: /\bno\s+signage\b/gi, zh: "无标牌" },
  { pattern: /\bno\s+blurry\b/gi, zh: "无模糊" },
  { pattern: /\bno\s+extra\s+limbs?\b/gi, zh: "无多余肢体" },
  { pattern: /\bno\s+extra\s+fingers?\b/gi, zh: "无多余手指" },
  { pattern: /\bdeformed\b/gi, zh: "无畸形" },
  { pattern: /\bdistorted\b/gi, zh: "无扭曲" },
  { pattern: /\blow\s+quality\b/gi, zh: "低质量" },
  { pattern: /\bhigh\s+quality\b/gi, zh: "高质量" },
  { pattern: /\bbest\s+quality\b/gi, zh: "最佳画质" }
];

export interface PromptLanguageReport {
  prompt: string;
  /** 被替换成中文的英文片段数 */
  replacements: number;
  /** 归一后仍存在的拉丁词（去重；用于审计，不是错误） */
  remainingLatin: string[];
  /** 被去重的重复角色图引用数 */
  dedupedRefs: number;
}

/** 归一重复项：清理 `A、无文字、无文字` 这类替换后的重复（同一行内相邻重复只留一个） */
function collapseDuplicates(text: string): string {
  return text
    .replace(/(无文字[、,，]?\s*){2,}/g, "无文字、")
    .replace(/(无水印[、,，]?\s*){2,}/g, "无水印、")
    .replace(/(无标牌[、,，]?\s*){2,}/g, "无标牌、")
    .replace(/([、,，])\s*\1+/g, "$1")
    .replace(/[、,，]\s*。/g, "。");
}

/**
 * 【负面约束】条目归一（2026-09-28 T1 真机监制打回）：
 *   ① 组装器默认负面词（`no text / no watermark / no signage`）经中文化后与卡片自带负面词
 *      **重复拼接**——监制判「负面约束重复即不合格」；
 *   ② 卡片里以裸词写的禁用项（`水印`、`脸漂`）缺否定前缀，等于把禁用词写成了目标词；
 *   ③ 并列项用「和」连接（`脸漂和塑料道具`）会被读成一条。
 *
 * 处理口径：只对**已能识别为缺陷名词**的条目补「无」前缀，英文机器校验标记（`no …`）原样保留，
 * 其余条目不做机器翻译也不臆造否定语义。
 */
const NEGATION_LEAD = /^(?:无|不|非|免|勿|避免|禁止|杜绝|严禁)/;
const MACHINE_MARKER = /^no\b/i;
/** 已知画面缺陷名词：只对这些词补否定前缀，避免把品牌名/正向描述改成"无…" */
const DEFECT_NOUN = /(文字|字幕|标语|台标|水印|标牌|脸漂|脸部漂移|五官漂移|塑料道具|塑料皮肤|畸形|多余|粘连|模糊|伪影|变形|扭曲|低分辨率|像素化|噪点|卡通|动漫|插画|渲染感|磨皮|美颜|蜡像|人偶|重复脸|无面孔|重影|抖动|闪烁|穿模|悬空)/;
/** 画质形容词不是缺陷名词（`低质量` 已是负面表述，不能再补前缀） */
const QUALITY_ADJECTIVE = /^(?:低|高)(?:质量|画质)$/;

export function normalizeNegativeConstraintItems(body: string): { body: string; prefixed: number; deduped: number } {
  const trailing = /。\s*$/.test(body) ? "。" : "";
  const core = body.replace(/。\s*$/, "");
  const raw = core.split(/[、,，;；]/).map((item) => item.trim()).filter(Boolean);
  const expanded: string[] = [];
  for (const item of raw) {
    /** 「脸漂和塑料道具」这类并列裸词：两侧都是已知缺陷名词时才拆开，避免拆散正常短语 */
    if (item.includes("和") && !NEGATION_LEAD.test(item)) {
      const parts = item.split("和").map((part) => part.trim()).filter(Boolean);
      if (parts.length > 1 && parts.every((part) => DEFECT_NOUN.test(part))) expanded.push(...parts);
      else expanded.push(item);
    } else {
      expanded.push(item);
    }
  }
  const seen = new Set<string>();
  const out: string[] = [];
  let prefixed = 0;
  let deduped = 0;
  for (let item of expanded) {
    if (!MACHINE_MARKER.test(item) && !NEGATION_LEAD.test(item) && !QUALITY_ADJECTIVE.test(item) && DEFECT_NOUN.test(item)) {
      item = `无${item}`;
      prefixed += 1;
    }
    if (seen.has(item)) {
      deduped += 1;
      continue;
    }
    seen.add(item);
    out.push(item);
  }
  return { body: `${out.join("、")}${trailing}`, prefixed, deduped };
}

export function dedupeImageRefs(prompt: string): { prompt: string; removed: number } {
  const seen = new Set<string>();
  let removed = 0;
  const out = prompt.replace(/image:\/\/[^\s,，、。]+/g, (match) => {
    if (seen.has(match)) {
      removed += 1;
      return "\u0000"; // 占位，稍后连分隔符一起清理
    }
    seen.add(match);
    return match;
  });
  return {
    prompt: out.replace(/[、,，]?\s*\u0000\s*[、,，]?/g, (m) => (m.includes("、") ? "、" : "")).replace(/、{2,}/g, "、"),
    removed
  };
}

/** 按卡片【语言约束】把提示词归一：英文负面词 → 中文等价，重复角色图引用去重 */
export function normalizePromptLanguage(prompt: string): PromptLanguageReport {
  let replacements = 0;
  let text = prompt;
  for (const { pattern, zh } of NEGATIVE_GLOSS) {
    text = text.replace(pattern, () => {
      replacements += 1;
      return zh;
    });
  }
  /** 【负面约束】整行归一：中文化后再去重、补否定前缀（顺序不能反，见函数注释） */
  text = text.replace(/^(\s*\d{1,2}\.\s*【负面约束】)([^\n]*)$/m, (_line, head: string, body: string) =>
    `${head}${normalizeNegativeConstraintItems(body).body}`);
  text = collapseDuplicates(text);
  const deduped = dedupeImageRefs(text);
  /**
   * 剩余拉丁词：排除**格式/路径类**合法记号（画幅、帧率、编码、时间码、image:// 路径、字段号）。
   * 管线强制追加的英文机器校验标记（`no background music, no cartoon …`）同样排除——
   * 它们是【语言约束】明文豁免项，不属"正文残留英文"。
   * 只报告，不改写——审计据此判断"还有哪些英文"，而不是机器翻译不认识的东西。
   */
  const masked = deduped.prompt
    .replace(/\bno\s+[a-z0-9][a-z0-9 -]*(?:\s*[,，、]\s*\bno\s+[a-z0-9][a-z0-9 -]*)*/gi, " ")
    .replace(/\bBGM\b/gi, " ")
    .replace(/image:\/\/[^\s,，、。]+/g, " ")
    .replace(/\bT\d{2}:\d{2}(?:-\d{2}:\d{2})?\b/g, " ")
    .replace(/\b\d+x\d+\b/g, " ")
    .replace(/\b\d+fps\b/gi, " ")
    .replace(/\b(?:MP4|MOV|H264|HEVC|AAC|ISO|JPG|PNG)\b/g, " ")
    .replace(/\b3D\b/g, " ");
  const remainingLatin = [...new Set((masked.match(/[A-Za-z]{3,}/g) ?? []))].sort();
  return { prompt: deduped.prompt, replacements, remainingLatin, dedupedRefs: deduped.removed };
}

/** 秒数格式化：保持 vendor 的 `NNs` 风格，必要时保留一位小数（`00s`/`04.5s`） */
function formatSeconds(value: number): string {
  const rounded = Math.round(value * 10) / 10;
  const text = Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(1);
  const [int, frac] = text.split(".");
  return frac ? `${int!.padStart(2, "0")}.${frac}` : int!.padStart(2, "0");
}

/**
 * 【台词】时间窗归一到**真实镜头时长**（2026-09-28 T1 真机监制打回）。
 *
 * vendor `_renderDialogueBlocks` 用 `Math.round(duration)` 取整算窗：4.5s 的镜头被写成 `[00s-05s]`，
 * 监制按"台词窗超出本镜时长、与 4.5s 网格冲突"打回，生成端也可能照 5s 拉长口播。
 * 这里只在该窗口确实超出时重排：按台词块数把 [0, duration] 均匀切分（与 vendor 语义一致，但用真实小数时长）。
 */
export function normalizeDialogueWindow(
  prompt: string,
  durationSec: number
): { prompt: string; clamped: number; from: string[] } {
  if (!Number.isFinite(durationSec) || durationSec <= 0) return { prompt, clamped: 0, from: [] };
  /**
   * 台词块可能跨多行（多个台词块时 vendor 用 `\n` 拼接），因此按行取到下一个字段名为止，
   * 不能只正则匹配单行——否则第 2 段以后的窗口改不到（单测实测）。
   */
  const lines = prompt.split("\n");
  const start = lines.findIndex((line) => /^\s*\d{1,2}\.\s*【台词】/.test(line));
  if (start < 0) return { prompt, clamped: 0, from: [] };
  let end = start + 1;
  while (end < lines.length && !/^\s*\d{1,2}\.\s*【/.test(lines[end]!)) end += 1;
  const block = lines.slice(start, end).join("\n");
  const windows = [...block.matchAll(/\[(\d+(?:\.\d+)?)s-(\d+(?:\.\d+)?)s\]/g)];
  if (windows.length === 0) return { prompt, clamped: 0, from: [] };
  const from = windows.map((item) => item[0]);
  const clamped = windows.filter((item) => Number(item[2]) > durationSec + 1e-9).length;
  if (clamped === 0) return { prompt, clamped: 0, from: [] };
  let index = 0;
  const replaced = block.replace(/\[(\d+(?:\.\d+)?)s-(\d+(?:\.\d+)?)s\]/g, () => {
    const cursor = index++;
    const start = (cursor * durationSec) / windows.length;
    const end = ((cursor + 1) * durationSec) / windows.length;
    return `[${formatSeconds(start)}s-${formatSeconds(end)}s]`;
  });
  const out = [...lines.slice(0, start), ...replaced.split("\n"), ...lines.slice(end)];
  return { prompt: out.join("\n"), clamped, from };
}

/**
 * 时间轴字段补全（2026-09-24 真机，6 镜全部命中）。
 *
 * vendor 的提示词组装器会把【时间轴】截断到**前两段**：实测卡里写
 * "T00:00-02 …；T00:02-03.5 …；T00:03.5-05 …"，进提示词只剩前两段——
 * **末尾 1.5 秒的节拍在提示词里根本不存在**，模型只能自己猜收尾，
 * 这正是"结尾动作没做完 / 表情断掉"类打回的常见来源。
 *
 * 运行时自证：拿卡片原文比提示词里的那一行，缺了就用卡片原文原位补回（只改这一行）。
 */
export function restoreTimelineField(prompt: string, timeline: unknown): { prompt: string; restored: boolean; segments: number } {
  const list = Array.isArray(timeline)
    ? timeline.map((v) => String(v).trim()).filter(Boolean)
    : String(timeline ?? "").split(/[；\n]/).map((v) => v.trim()).filter(Boolean);
  if (list.length <= 1) return { prompt, restored: false, segments: list.length };
  const line = /^19\.【时间轴】.*$/m;
  const matched = prompt.match(line);
  if (!matched) return { prompt, restored: false, segments: list.length };
  const current = matched[0].replace(/^19\.【时间轴】/, "").trim().replace(/[；;]\s*$/, "");
  const tail = list[list.length - 1]!.replace(/[；;]\s*$/, "");
  if (current.includes(tail)) return { prompt, restored: false, segments: list.length };
  return { prompt: prompt.replace(line, `19.【时间轴】${list.join("；")}`), restored: true, segments: list.length };
}

export interface CardFieldSpec {
  /** 提示词里的字段标签（不含【】） */
  label: string;
  /** 同义标签（如【灯光设计】/【灯光/照明】），按顺序取第一个存在的行 */
  aliases?: string[];
  /** 镜头卡字段值 */
  value: unknown;
}

export interface CardFieldRestore {
  label: string;
  /** 回写后净增字符数 */
  added: number;
  /** 被替换掉的组装器文本（截断前） */
  replaced: string;
}

/**
 * 多字段分段并集（2026-09-28 T1 真机）：vendor 会把【场景】按约 170 字截断，
 * 丢掉尾部「时段 上午10:20」等信息；而镜头卡里场景、场景描述可能各带一份片型策略前缀。
 * 这里按「；」分段做并集（保序去重），既不重复策略前綴，也不丢任何一段原始信息。
 */
export function mergeUniqueSegments(values: unknown[]): string {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of values) {
    if (typeof value !== "string") continue;
    for (const segment of value.split(/[；;]/)) {
      const item = segment.trim();
      if (!item || seen.has(item)) continue;
      seen.add(item);
      out.push(item);
    }
  }
  return out.join("；");
}

/** 比较用归一：忽略空白与句末标点，避免"全角/半角/句号有无"造成假失配 */
function comparableText(text: string): string {
  return text.replace(/\s+/g, "").replace(/[。；;，,、]+$/g, "");
}

/**
 * 镜头卡字段**契约回写**（2026-09-28 T1 真机监制打回）。
 *
 * 真机现象：vendor `field-content-refiner` 会把卡片 `bright_constraint`（含"窗侧高光不过曝 / 头顶中庭净空
 * 不被低板压顶"这类可拍约束）重写成 40 字以内的通用句；`pacing`/`depth_of_field`/`makeup`/`color_palette`
 * 等字段的末句也会被截掉。监制逐条比对合同后判"明亮约束被弱化、口径被删"，属实质降级。
 *
 * 回写口径（只收紧、不臆造）：
 *   · 只在**卡片文本明显长于提示词那一行**时回写——扩展类字段（场景圣经展开、材质工艺补充）行更长，天然不触发；
 *   · 只替换该字段行本身，不动其它行；
 *   · 回写内容**逐字取卡片原文**，不做改写；实际回写项写入报告供审计。
 */
export function restoreCardFieldText(
  prompt: string,
  fields: CardFieldSpec[]
): { prompt: string; restored: CardFieldRestore[] } {
  let text = prompt;
  const restored: CardFieldRestore[] = [];
  for (const field of fields) {
    const value = typeof field.value === "string" ? field.value.trim() : "";
    if (value.length < 8) continue;
    const labels = [field.label, ...(field.aliases ?? [])];
    for (const label of labels) {
      const regex = new RegExp(`^(\\s*\\d{1,2}\\.\\s*【${label.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&")}】)([^\\n]*)$`, "m");
      const matched = text.match(regex);
      if (!matched) continue;
      const body = matched[2] ?? "";
      const cardText = comparableText(value);
      const lineText = comparableText(body);
      /** 只回写"卡片被截断/被改写"的行：卡片更短说明提示词是扩展文本（场景圣经、材质工艺），不动 */
      if (cardText.length <= lineText.length) break;
      text = text.replace(regex, `${matched[1]}${value}`);
      restored.push({ label, added: value.length - body.length, replaced: body });
      break;
    }
  }
  return { prompt: text, restored };
}
