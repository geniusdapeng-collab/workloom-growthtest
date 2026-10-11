/**
 * dialogue-contract —— 台词合同判据（T-2026-1011-0001）
 *
 * 真机样本（`VID-ZXRRC-12` 张雪机车 820RR-RC 30s 品牌片，全英文口播）逐镜 ASR 实测：
 *   SC-01 卡片写 `Track only.`，成片念成 `Not street legal.`（时间轴里残留旧台词，提示词自相矛盾）；
 *   SC-03 增词（`Titanium. Race spec.`）；SC-04（无台词镜）凭空出现人声 `Hi!`；
 *   SC-06 用中文腔念 `820RR-RC`（whisper 直接判为 zh）。
 *
 * 六镜里四镜的"台词合同"被破坏，而现有链路：提示词自检只看字段齐备、渲后不做任何台词/语言复核。
 *
 * 本模块补三件事（全部为**事实性合同**，不涉及审美）：
 *   ① 引用式台词一致性：时间轴/导演意图/节奏里带句末标点的引号内容必须与 `dialogue` 原文一致；
 *   ② 语言锁定：影片声明语言与台词文本必须一致，并给出【台词语言】提示词条款；
 *   ③ 逐字与静默：台词镜必须"逐字念出"；无台词镜必须显式禁止人声词句。
 */

export const DIALOGUE_CONTRACT_VERSION = "workloom.dialogue-contract/v1" as const;

export interface DialogueShotLike {
  shotId?: unknown;
  dialogue?: unknown;
  dialogueFree?: unknown;
  action?: unknown;
  timeline?: unknown;
  director_instruction?: unknown;
  pacing?: unknown;
  mood?: unknown;
  [key: string]: unknown;
}

const text = (value: unknown): string => String(value ?? "");

/** 兼容三种既有形态：字符串、字符串数组、`{ text }` 对象数组。 */
export function dialogueLines(shot: DialogueShotLike): string[] {
  const value = shot.dialogue;
  if (typeof value === "string") return value.trim() ? [value.trim()] : [];
  if (!Array.isArray(value)) return [];
  return value
    .map((row) => (typeof row === "string" ? row : row && typeof row === "object" && !Array.isArray(row)
      ? text((row as Record<string, unknown>).text) : ""))
    .map((line) => line.trim())
    .filter(Boolean);
}

const stripPunct = (value: string): string =>
  value.replace(/[\s，。！？、,.!?；;：:“”"'「」『』（）()【】\[\]—-]/g, "").toLowerCase();

const CJK_RE = /[\u3400-\u9fff]/g;
const LATIN_RE = /[A-Za-z]/g;

export function cjkCount(value: string): number {
  return (value.match(CJK_RE) ?? []).length;
}
export function latinCount(value: string): number {
  return (value.match(LATIN_RE) ?? []).length;
}

/** 单句语言判定：CJK 为主 = zh；拉丁为主 = en；其余返回 null（不猜）。 */
export function inferLineLanguage(line: string): "zh" | "en" | null {
  const cjk = cjkCount(line);
  const latin = latinCount(line);
  if (cjk === 0 && latin === 0) return null;
  return cjk > latin ? "zh" : "en";
}

/** 镜头级语言推断（全部台词一致时给结论，混合语言不猜）。 */
export function inferShotSpeechLanguage(shot: DialogueShotLike): "zh" | "en" | null {
  const langs = dialogueLines(shot).map(inferLineLanguage).filter((value): value is "zh" | "en" => value !== null);
  if (!langs.length) return null;
  return langs.every((lang) => lang === langs[0]) ? langs[0]! : null;
}

const LANGUAGE_LABELS: Record<string, string> = {
  zh: "中文", en: "英文", ja: "日文", ko: "韩文", es: "西班牙文", fr: "法文", de: "德文", pt: "葡萄牙文", th: "泰文", vi: "越南文",
};
export const languageLabel = (language: string): string => LANGUAGE_LABELS[language] ?? language;

export interface DialogueContractFinding {
  id: string;
  level: "high" | "medium";
  detail: string;
  suggestion: string;
}

/** 引用式台词：带句末标点的引号内容视为"被当成台词念出来的句子"。 */
const QUOTED_SENTENCE_RE = /[“"「『]([^”"」』]{2,120})[”"」』]/g;
const SENTENCE_END_RE = /[。！？.!?]\s*$/;

export function quotedSpokenLines(shot: DialogueShotLike): Array<{ field: string; line: string }> {
  const out: Array<{ field: string; line: string }> = [];
  for (const field of ["timeline", "director_instruction", "pacing", "action", "mood"] as const) {
    const body = text(shot[field]);
    if (!body) continue;
    for (const match of body.matchAll(QUOTED_SENTENCE_RE)) {
      const line = (match[1] ?? "").trim();
      if (!line) continue;
      if (SENTENCE_END_RE.test(line)) out.push({ field, line });
    }
  }
  return out;
}

/**
 * 去掉"否定语境"再判"是否声明了说话"：
 * 「本镜无台词」「不出现人声」「禁止旁白」这类句子不能算"声明说话"（否则无台词镜会被自己误伤）。
 */
function positiveSpeechText(value: unknown): string {
  return String(value ?? "")
    .split(/[；。，、\n]/)
    .filter((segment) => segment.trim() && !/(不出现|不得|禁止|避免|严禁|没有|无台词|无人声|不说话|不出声)/.test(segment))
    .join("；");
}

/**
 * 台词合同判据（花钱前使用）。
 * · 引号台词与 `dialogue` 不一致 → 高风险（提示词自相矛盾，模型会任选其一）
 * · 台词语言与影片声明语言不一致 → 高风险
 * · 无台词镜却在动作/时间轴里"说/念/口播" → 高风险（自相矛盾）
 * · 有引号台词但没有登记 `dialogue` → 中风险（台词未入合同）
 */
export function dialogueContractFindings(shot: DialogueShotLike, options: { language?: string | null } = {}): DialogueContractFinding[] {
  const shotId = text(shot.shotId) || "?";
  const lines = dialogueLines(shot);
  const findings: DialogueContractFinding[] = [];
  const declared = lines.map(stripPunct).filter(Boolean);
  for (const quoted of quotedSpokenLines(shot)) {
    const normalized = stripPunct(quoted.line);
    if (!normalized) continue;
    /**
     * 严格一致：引号内容归一后必须**逐字等于** dialogue 原文。
     * （宽容匹配会放过"多念了半句"的缺陷——真机样本 SC-03 的 “Titanium. Race spec.” 就是这样漏过的：
     *  它包含声明台词，但模型会连 "Titanium." 一起念出来。）
     */
    const matchesDeclared = declared.some((line) => line === normalized);
    if (!lines.length) {
      findings.push({
        id: "dialogue-quoted-without-declaration",
        level: "medium",
        detail: `${shotId}：${quoted.field} 里引用了会念出来的句子「${quoted.line}」，但卡片没有登记 dialogue（台词未进合同，模型可自由发挥）`,
        suggestion: "把该句登记为 dialogue 原文（或删除引用；无台词镜请显式 dialogueFree=true 并去掉引号台词）",
      });
      continue;
    }
    if (!matchesDeclared) {
      findings.push({
        id: "dialogue-line-conflict",
        level: "high",
        detail: `${shotId}：${quoted.field} 引用的台词「${quoted.line}」与 dialogue 原文「${lines.join(" / ")}」不一致——同一镜出现两条台词，模型会任选其一（真机样本 SC-01 因此把 "Track only." 念成 "Not street legal."）`,
        suggestion: "全镜统一为 dialogue 原文：时间轴/导演意图/节奏里的引用句必须与 dialogue 逐字一致",
      });
    }
  }
  if (shot.dialogueFree === true) {
    const contradiction = /说(?:出|道|了)?|念(?:出|白)?|口播|台词|对白|旁白/.test(
      positiveSpeechText(text(shot.action) + "；" + text(shot.timeline) + "；" + text(shot.director_instruction)),
    );
    if (contradiction) {
      findings.push({
        id: "dialogue-free-contradiction",
        level: "high",
        detail: `${shotId}：标记为无台词镜（dialogueFree=true），但动作/时间轴里写了"说/念/口播"类描述——合同自相矛盾`,
        suggestion: "二者取一：要么删掉说话描述保持无台词，要么登记 dialogue 原文",
      });
    }
  } else if (!lines.length) {
    const claims = /说(?:出|道|了)?|念(?:出|白)?|口播|台词|对白|旁白/.test(
      positiveSpeechText(text(shot.action) + "；" + text(shot.timeline) + "；" + text(shot.director_instruction)),
    );
    if (claims) {
      findings.push({
        id: "dialogue-missing",
        level: "high",
        detail: `${shotId}：动作/时间轴声明了说话，但卡片没有 dialogue 原文（模型会自行编词，真机样本出现凭空人声）`,
        suggestion: "补 dialogue 原文，或改成无台词镜（dialogueFree=true）并删除说话描述",
      });
    }
  }
  const declaredLanguage = options.language ? String(options.language) : null;
  if (declaredLanguage && lines.length) {
    for (const line of lines) {
      const inferred = inferLineLanguage(line);
      if (inferred && inferred !== declaredLanguage) {
        findings.push({
          id: "dialogue-language-mismatch",
          level: "high",
          detail: `${shotId}：影片声明台词语言为${languageLabel(declaredLanguage)}，但台词「${line}」是${languageLabel(inferred)}文本`,
          suggestion: "统一影片语言与台词文本（跨语言版本请拆成独立项目，不要在一支片里混用）",
        });
        break;
      }
    }
  }
  return findings;
}

/** 影片级语言解析：显式声明优先，其次由台词文本推断（英文台词片不再被默认当中文片处理）。 */
export function resolveFilmSpeechLanguage(shotlist: Record<string, unknown>, shots: readonly DialogueShotLike[]): string {
  const declared = text(shotlist.speechLanguage ?? shotlist.language ?? shotlist.voiceLanguage).trim().toLowerCase();
  if (/^(zh|cn|chinese|中文|普通话)$/.test(declared)) return "zh";
  if (/^(en|eng|english|英文)$/.test(declared)) return "en";
  if (declared) return declared.slice(0, 8);
  const inferred = shots.map(inferShotSpeechLanguage).filter((value): value is "zh" | "en" => value !== null);
  if (inferred.length) {
    const zh = inferred.filter((value) => value === "zh").length;
    return zh * 2 >= inferred.length ? "zh" : "en";
  }
  return "zh";
}

/**
 * 提示词条款：语言锁定 + 逐字台词（禁止其他语言人声与改写）。
 * 长度纪律：提示词硬上限 3000 字，本条款必须 ≤40 字；`lines` 仅用于回执/审计。
 * （【逐字台词】合并进本条款：真机样本里"多念半句/换语种"是同一类违约。）
 */
export function speechLanguageClause(language: string, _lines: readonly string[] = []): string {
  const label = languageLabel(language);
  const others = language === "en" ? "中文" : language === "zh" ? "英文" : "其他语言";
  return `【台词语言】人声仅用${label}、逐字念出【台词】原文；禁止${others}与即兴人声。`;
}

/** 兼容保留：逐字要求已并入【台词语言】；此函数返回空串避免重复占位。 */
export function exactDialogueClause(_lines: readonly string[]): string {
  return "";
}

/** 提示词条款：无台词镜禁人声词句。 */
export function noSpeechClause(): string {
  return "【无台词】本镜不得出现台词/旁白/口播与可辨词句人声，只允许环境声与动作音效。";
}

/** 并入负面约束（英文，与 vendor negative 同语言；保持短句以守住提示词长度）。 */
export function speechNegativeTerms(language: string): string {
  if (language === "en") return "no improvised lines, no chinese speech";
  if (language === "zh") return "no improvised lines, no english speech";
  return "no improvised lines, no other-language speech";
}
