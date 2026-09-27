/**
 * pronunciation.ts —— 关键术语发音核查（真机事故：VID-GROWTH-SALES02「数字 CEO → 数字 CBO」）
 *
 * 事故复盘（2026-09-27）：
 *   成片人声来自**视频模型自带音频**（阶段日志 `stage=voice / source=clip-audio`）。模型把
 *   「数字 CEO 排产」读成「数字 CBO 排产」、「短视频种草」读成「短视频监口」，而现有人声门
 *   `speechAcceptance` 只看**整句 ASR 相似度**（下限 0.45）——两句分别拿到 0.96 / 0.85，
 *   全部放行。**单个术语读错会被整句相似度稀释**，闸门在这类缺陷上等于不存在。
 *
 * 两条修法（本模块 + 调用方）：
 *   ① 术语表：把"必须读对"的词登记为条目；每条含 ASR 的**已知同音偏差**（aliases），
 *      例如「询盘」被 whisper-large-v3 稳定转成「寻盘/寻单」、「落地页」→「落地夜」、
 *      「首响」→「首想」——这些是**听感正确、转写偏差**，必须接受，否则会误杀一片；
 *      而「种草 → 监口」「CEO → CBO」是**真的读错**，别名里绝不登记，必须失败。
 *   ② `termPronunciationCheck`：把"这句台词里出现的受保护术语"逐个拿去转写里核对，
 *      缺词即判失败（fail-closed）；调用方据此拒绝模型自带音频，改用**克隆音色 TTS 替换**
 *      该镜人声（`dub --policy replace-bed`），而不是叠加（叠加会留下原读错的音）。
 */

/** 受保护术语：脚本写法 + 可接受的 ASR 变体（同音/数字写法差异） */
export interface PronunciationTerm {
  /** 脚本里的规范写法（也是转写里应当出现的形态） */
  text: string;
  /**
   * 可接受的 ASR 变体（同音偏差、数字与中文互写）。
   * 只登记"听感一致"的偏差；读错音的形态（如 CBO / 监口）绝不登记。
   */
  aliases?: string[];
  /**
   * 送给 TTS 的替换写法（可选）。缺省不改写——本机克隆音色对 CEO / GEO / 种草
   * 均能读对（2026-09-27 实测），只有发现某个后端读错时才需要在这里登记。
   */
  ttsText?: string;
  /** 备注（为什么登记这个词） */
  note?: string;
}

/**
 * 默认术语表：产品名、缩写、易读错的行业词。
 * 依据：① 2026-09-27 真机 ASR 实测（见 pronunciation.test.ts 的固定样例）；
 *      ② 行业话术里最贵的几个词——读错一次，观众对"专业度"的判断就塌了。
 */
export const DEFAULT_PRONUNCIATION_LEXICON: PronunciationTerm[] = [
  { text: "CEO", note: "真机读成 CBO（VID-GROWTH-SALES02 CF-04）" },
  { text: "GEO", note: "AI 搜索优化；ASR 可能写成小写 geo，也可能误记 CEO" },
  { text: "WorkLoom", aliases: ["Workloom", "Work Loom", "workloom"], note: "产品名，ASR 会拆成两个词" },
  { text: "AI", aliases: ["Ai", "ai"], note: "全片高频" },
  { text: "获客", aliases: ["货客"], note: "huòkè 同音，ASR 常写『货客』（听感正确，不算错）" },
  { text: "询盘", aliases: ["寻盘", "寻单"], note: "B2B 术语；whisper 稳定误写成『寻盘/寻单』" },
  { text: "种草", note: "真机读成『监口』（VID-GROWTH-SALES02 CF-05）；zhòng cǎo 不能读成 zhǒng" },
  { text: "落地页", aliases: ["落地夜"], note: "ASR 同音偏差" },
  { text: "首响", aliases: ["首想"], note: "30 秒首响的首响；ASR 同音偏差" },
  { text: "四成二", aliases: ["4成2", "4乘2", "四乘二"], note: "口语百分比；ASR 会写成 4乘2" },
  { text: "影子试用", note: "产品专有阶段名（体检→影子→托管）" },
  { text: "托管", note: "产品专有阶段名" },
];

/** 去掉标点/空白并把拉丁字母统一小写（转写与台词的可比比形态） */
export function comparableForTerms(text: string | null | undefined): string {
  return String(text ?? "")
    .replace(/[\s，。！？、,.!?；;：:"'“”「」『』（）()\[\]{}<>/\-—…·|]/g, "")
    .toLowerCase();
}

export interface TermPronunciationInput {
  /** ASR 复核转写 */
  transcript: string | null | undefined;
  /** 该镜台词原文 */
  expectedText: string | null | undefined;
  /** 术语表（缺省用内置表） */
  lexicon?: PronunciationTerm[];
}

export interface TermPronunciationResult {
  ok: boolean;
  /** 本句台词里出现的受保护术语（需要核对的部分） */
  required: string[];
  /** 转写里核对不上的术语（缺词/被读错） */
  missing: string[];
  detail: string;
}

/**
 * 逐术语核对 ASR 转写。判据：**只要台词里出现受保护术语，转写里就必须能核到它
 * （本体或登记过的同音变体）**；核不到即判失败。
 *
 * 与 `speechAcceptance` 的分工：
 *   · `speechAcceptance` 回答"这句台词在不在"（整句相似度 + 人声活动度）；
 *   · 本函数回答"术语有没有读错"（单点、fail-closed）。
 *   两者都过才算这一镜的人声可用。
 */
export function termPronunciationCheck(input: TermPronunciationInput): TermPronunciationResult {
  const lexicon = input.lexicon ?? DEFAULT_PRONUNCIATION_LEXICON;
  const expected = comparableForTerms(input.expectedText);
  const transcript = comparableForTerms(input.transcript);
  if (!expected || !transcript) {
    return {
      ok: false,
      required: [],
      missing: [],
      detail: transcript ? "台词为空：不适用" : "转写为空：无法核对术语（不拿未测到的数据当通过）",
    };
  }
  const required: string[] = [];
  const missing: string[] = [];
  for (const term of lexicon) {
    const form = comparableForTerms(term.text);
    if (!form || !expected.includes(form)) continue;
    required.push(term.text);
    const accepted = [term.text, ...(term.aliases ?? [])].map(comparableForTerms).filter(Boolean);
    if (!accepted.some((candidate) => transcript.includes(candidate))) missing.push(term.text);
  }
  const ok = missing.length === 0;
  return {
    ok,
    required,
    missing,
    detail: required.length === 0
      ? "本句无受保护术语：术语门不适用"
      : ok
        ? `受保护术语 ${required.length} 个全部核对通过（${required.join(" / ")}）`
        : `受保护术语读错或缺失：${missing.join(" / ")}（台词里应当出现；转写「${String(input.transcript ?? "").slice(0, 60)}」）`,
  };
}

/**
 * 把台词改写成"给 TTS 的读法"（仅当术语登记了 `ttsText` 才改写）。
 * 默认不改写：本机克隆音色对 CEO / GEO / 种草 均能读对（2026-09-27 实测），
 * 改写只作为某个后端读错时的**定点纠正**手段，避免把正常文本改坏。
 */
export function normalizeForTts(text: string, lexicon: PronunciationTerm[] = DEFAULT_PRONUNCIATION_LEXICON): string {
  let out = String(text ?? "");
  for (const term of lexicon) {
    if (!term.ttsText) continue;
    out = out.split(term.text).join(term.ttsText);
  }
  return out;
}
