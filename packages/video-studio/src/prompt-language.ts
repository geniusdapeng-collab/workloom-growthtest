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
  text = collapseDuplicates(text);
  const deduped = dedupeImageRefs(text);
  /**
   * 剩余拉丁词：排除**格式/路径类**合法记号（画幅、帧率、编码、时间码、image:// 路径、字段号）。
   * 只报告，不改写——审计据此判断"还有哪些英文"，而不是机器翻译不认识的东西。
   */
  const masked = deduped.prompt
    .replace(/image:\/\/[^\s,，、。]+/g, " ")
    .replace(/\bT\d{2}:\d{2}(?:-\d{2}:\d{2})?\b/g, " ")
    .replace(/\b\d+x\d+\b/g, " ")
    .replace(/\b\d+fps\b/gi, " ")
    .replace(/\b(?:MP4|MOV|H264|HEVC|AAC|ISO|JPG|PNG)\b/g, " ")
    .replace(/\b3D\b/g, " ");
  const remainingLatin = [...new Set((masked.match(/[A-Za-z]{3,}/g) ?? []))].sort();
  return { prompt: deduped.prompt, replacements, remainingLatin, dedupedRefs: deduped.removed };
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
