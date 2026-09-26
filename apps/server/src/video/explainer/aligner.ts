/**
 * explainer/aligner.ts —— 字级时间戳对齐器（我们的实现；vendor 同 schema）· T-2026-0926-0008
 *
 * 与 spec v2.0 的偏差（review 修复 F5）：spec 只列了 sherpa(FireRed 767MB 手动模型) / faster-whisper /
 * cloud 三条后端。本机已有**配音工位 ASR**（mlx whisper-large-v3-turbo，:8099），中文 TTS 音频上
 * 句子切分质量足够；因此新增 `voice-station` 后端：ASR 出**词级时间戳** → 本模块做
 * 「口播稿 × ASR 词」逐字对齐 → 产出与 `scripts/timestamps_cpu.py` **同 schema** 的 timestamps.json。
 *
 * 对齐口径（与 vendor 的哲学一致，实现独立）：
 *   - 匹配键 = 繁简归一（常用异体/繁体映射 + NFKC）+ 标点剔除 + **阿拉伯数字→汉字读法**；
 *   - 序列对齐 = 带缺口罚分的 DP（等价于编辑距离最大匹配），匹配上的字拿 ASR 的时刻；
 *   - 未匹配的字（ASR 听错 / 漏字）在左右锚点之间线性插值——**绝不臆造**：插值来源可追（anchor 对）；
 *   - 每句 match = 命中字数 / 该句有效字数；< 0.90 标 ok=false，交人工听核（不静默放行）。
 *
 * 为什么不用 vendor 的 timestamps_cpu.py 直接跑：它的 ASR 后端与我们的配音工位不同源；
 * 但**输出 schema 与 make_timing 契约保持兼容**，`expandToTiming()` 与 `scripts/make_timing.py`
 * 的输出在真机自检里逐字段对账（explainer/pipeline.test 的 `timing parity` 用例）。
 */
import { TimestampsFileSchema, type ExplainerScript, type TimestampsFile } from "./types.js";

export interface AsrWord {
  text: string;
  start: number;
  end: number;
}

/* ================= 归一化 ================= */

/** 常见繁体/异体 → 简体（覆盖 ASR 常吐的几百字；不全时靠 DP 缺口兜底，不追求 100%） */
const TRAD_TO_SIMP: Record<string, string> = {
  們: "们", 個: "个", 這: "这", 說: "说", 來: "来", 對: "对", 時: "时", 會: "会",
  後: "后", 裡: "里", 為: "为", 麼: "么", 開: "开", 關: "关", 進: "进", 過: "过", 產: "产",
  業: "业", 現: "现", 場: "场", 發: "发", 務: "务", 員: "员", 隊: "队", 團: "团",
  報: "报", 數: "数", 據: "据", 實: "实", 機: "机", 構: "构", 統: "统", 線: "线", 網: "网",
  資: "资", 訊: "讯", 聯: "联", 繫: "系", 週: "周", 轉: "转", 換: "换", 選: "选", 擇: "择",
  優: "优", 質: "质", 價: "价", 錢: "钱", 賣: "卖", 買: "买", 單: "单", 點: "点", 擊: "击",
  評: "评", 測: "测", 講: "讲", 誰: "谁", 問: "问", 題: "题", 內: "内", 容: "容", 視: "视",
  頻: "频", 畫: "画", 聲: "声", 領: "领", 導: "导", 監: "监", 製: "制", 鐘: "钟",
  間: "间", 專: "专", 讓: "让", 覺: "觉", 織: "织", 認: "认", 識: "识", 習: "习", 練: "练",
  級: "级", 種: "种", 類: "类", 幫: "帮", 邊: "边", 遠: "远", 親: "亲", 顧: "顾", 響: "响",
  應: "应", 該: "该", 當: "当", 於: "于", 與: "与", 並: "并", 無: "无", 沒: "没",
  // 实战补：简体稿 + ASR 繁体转写是最典型的错配源（只补尚未登记的，重复键会直接编译失败）
  獲: "获", 將: "将", 續: "续", 夠: "够", 幾: "几", 準: "准",
  備: "备", 課: "课", 萬: "万", 億: "亿",
};

const CN_DIGITS = ["零", "一", "二", "三", "四", "五", "六", "七", "八", "九"];

/** 0–99999999 的整数 → 中文读法（对齐用；不是排版口径） */
export function intToChinese(value: number): string {
  if (!Number.isFinite(value) || value < 0 || value > 99_999_999 || !Number.isInteger(value)) return String(value);
  if (value === 0) return "零";
  const units = ["", "十", "百", "千"];
  const sections = ["", "万"];
  const digits = String(value).split("").map(Number);
  const out: string[] = [];
  let zeroPending = false;
  for (let i = 0; i < digits.length; i += 1) {
    const rest = digits.length - i;
    const sectionIndex = Math.floor((rest - 1) / 4);
    const unitIndex = (rest - 1) % 4;
    const d = digits[i]!;
    if (d === 0) {
      zeroPending = out.length > 0;
    } else {
      if (zeroPending) { out.push("零"); zeroPending = false; }
      out.push(CN_DIGITS[d]!);
      out.push(units[unitIndex]!);
    }
    if (unitIndex === 0 && sectionIndex > 0) {
      if (!out[out.length - 1]?.includes("万")) out.push(sections[sectionIndex] ?? "");
      // 段内全零不重复补"万"
      if (out[out.length - 1] === "" && out[out.length - 2] !== "万") out.pop();
    }
  }
  let s = out.join("");
  s = s.replace(/^一十/, "十");
  return s;
}

/** ASR 原文 → 可对齐字符流（去标点/空白，数字转汉字读法） */
export function normalizeSpoken(text: string): string {
  const nfkc = text.normalize("NFKC").toLowerCase();
  let out = "";
  for (let i = 0; i < nfkc.length; i += 1) {
    const ch = nfkc[i]!;
    if (/\d/.test(ch)) {
      let j = i;
      while (j < nfkc.length && /[\d.]/.test(nfkc[j]!)) j += 1;
      const raw = nfkc.slice(i, j);
      i = j - 1;
      if (raw.includes(".")) {
        const [intPart, fracPart] = raw.split(".");
        out += intToChinese(Number(intPart ?? "0"));
        out += "点";
        out += (fracPart ?? "").split("").map((d) => CN_DIGITS[Number(d)] ?? "").join("");
      } else {
        out += intToChinese(Number(raw));
      }
      continue;
    }
    if (/[\u4e00-\u9fff]/.test(ch)) { out += TRAD_TO_SIMP[ch] ?? ch; continue; }
    if (/[a-z0-9]/.test(ch)) { out += ch; continue; }
    // 其余（标点/空白/符号）跳过
  }
  return out;
}

/* ================= 对齐 ================= */

interface ScriptChar {
  sentenceIndex: number;
  ch: string;
  start: number | null;
  end: number | null;
  /** 是否来自 ASR 真实锚点（插值补齐的字不算命中——match 反映的是锚点覆盖率，不是"有没有时间"） */
  matched: boolean;
  /** 是否为拉丁整段 token 的一部分（words 归并用） */
  latin: boolean;
}

interface AsrChar {
  ch: string;
  start: number;
  end: number;
}

function scriptCharStream(script: ExplainerScript): { chars: ScriptChar[]; sentenceSpans: Array<{ from: number; to: number }> } {
  const chars: ScriptChar[] = [];
  const sentenceSpans: Array<{ from: number; to: number }> = [];
  for (let s = 0; s < script.sentences.length; s += 1) {
    const sentence = script.sentences[s]!;
    const from = chars.length;
    const normalized = sentence.text.normalize("NFKC").toLowerCase();
    for (const ch of normalized) {
      if (/[\u4e00-\u9fff]/.test(ch)) {
        chars.push({ sentenceIndex: s, ch: TRAD_TO_SIMP[ch] ?? ch, start: null, end: null, matched: false, latin: false });
      } else if (/[a-z]/.test(ch)) {
        chars.push({ sentenceIndex: s, ch, start: null, end: null, matched: false, latin: true });
      } else if (/\d/.test(ch)) {
        // 口播稿硬规要求数字写汉字；万一出现，按逐字汉字读法展开（对齐不失败，但会被上层校验拦）
        for (const digit of intToChinese(Number(ch))) {
          chars.push({ sentenceIndex: s, ch: digit, start: null, end: null, matched: false, latin: false });
        }
      }
    }
    sentenceSpans.push({ from, to: chars.length });
  }
  return { chars, sentenceSpans };
}

function asrCharStream(words: AsrWord[]): AsrChar[] {
  const chars: AsrChar[] = [];
  for (const word of words) {
    const normalized = normalizeSpoken(word.text);
    if (!normalized) continue;
    const width = Math.max(0, word.end - word.start);
    for (let i = 0; i < normalized.length; i += 1) {
      chars.push({
        ch: normalized[i]!,
        start: word.start + (width * i) / normalized.length,
        end: word.start + (width * (i + 1)) / normalized.length,
      });
    }
  }
  return chars;
}

const MATCH_SCORE = 1;
const MISMATCH_SCORE = -0.6;
const GAP_SCORE = -0.55;

/** DP 对齐：返回 scriptChars 每个位置匹配到的 asrChars 下标（-1 = 未匹配） */
export function alignSequences(scriptChars: ScriptChar[], asrChars: AsrChar[]): number[] {
  const n = scriptChars.length;
  const m = asrChars.length;
  const NEG = -1e9;
  let prev = new Float64Array(m + 1);
  let cur = new Float64Array(m + 1);
  const choice: Uint8Array[] = [];
  for (let j = 0; j <= m; j += 1) prev[j] = j === 0 ? 0 : NEG;
  for (let i = 1; i <= n; i += 1) {
    cur[0] = i === 0 ? 0 : prev[0]! + GAP_SCORE;
    const row = new Uint8Array(m + 1);
    for (let j = 1; j <= m; j += 1) {
      const diag = prev[j - 1]! + (scriptChars[i - 1]!.ch === asrChars[j - 1]!.ch ? MATCH_SCORE : MISMATCH_SCORE);
      const up = prev[j]! + GAP_SCORE;
      const left = cur[j - 1]! + GAP_SCORE;
      if (diag >= up && diag >= left) { cur[j] = diag; row[j] = 0; }
      else if (up >= left) { cur[j] = up; row[j] = 1; }
      else { cur[j] = left; row[j] = 2; }
    }
    choice.push(row);
    const tmp = prev; prev = cur; cur = tmp;
  }
  // 回溯
  const matched = new Array<number>(n).fill(-1);
  let i = n;
  let j = m;
  while (i > 0 && j >= 0) {
    const row = choice[i - 1]!;
    const dir = j === 0 ? 1 : row[j]!;
    if (dir === 0) {
      if (scriptChars[i - 1]!.ch === asrChars[j - 1]!.ch) matched[i - 1] = j - 1;
      i -= 1; j -= 1;
    } else if (dir === 1) {
      i -= 1;
    } else {
      j -= 1;
    }
  }
  return matched;
}

export interface AlignOptions {
  /** 采样率写进 timestamps.json（默认 16000，与 vendor 默认一致） */
  sampleRate?: number;
}

export function alignScriptToTimestamps(
  script: ExplainerScript,
  words: AsrWord[],
  total: number,
  opts: AlignOptions = {},
): TimestampsFile {
  const { chars, sentenceSpans } = scriptCharStream(script);
  const asrChars = asrCharStream(words);
  if (chars.length === 0) throw new Error("口播稿没有可对齐字符（空稿或全是标点）");
  const matched = alignSequences(chars, asrChars);
  for (let idx = 0; idx < chars.length; idx += 1) {
    const asrIdx = matched[idx]!;
    if (asrIdx >= 0) {
      chars[idx]!.start = asrChars[asrIdx]!.start;
      chars[idx]!.end = asrChars[asrIdx]!.end;
      chars[idx]!.matched = true;
    }
  }
  interpolateMissing(chars, total);

  const sentences = script.sentences.map((sentence, sIdx) => {
    const span = sentenceSpans[sIdx]!;
    const slice = chars.slice(span.from, span.to);
    const first = slice[0]!;
    const last = slice[slice.length - 1]!;
    const hit = slice.filter((c) => c.matched).length;
    const match = slice.length ? Math.round((hit / slice.length) * 1000) / 1000 : 0;
    return {
      i: sentence.i,
      text: sentence.text,
      start: round3(first.start ?? 0),
      end: round3(last.end ?? total),
      asr: asrTextFor(asrChars, slice),
      match,
      ok: match >= 0.9,
      words: tokenize(slice),
    };
  });

  return TimestampsFileSchema.parse({
    sr: opts.sampleRate ?? 16000,
    total: round3(total),
    sentences,
  });
}

function asrTextFor(asrChars: AsrChar[], slice: ScriptChar[]): string {
  // 句级 ASR 原文：取该句时间窗内落在 asrChars 的字符（留痕用途，不参与判定）
  const start = slice[0]?.start ?? 0;
  const end = slice[slice.length - 1]?.end ?? 0;
  return asrChars.filter((c) => c.end > start && c.start < end).map((c) => c.ch).join("");
}

function interpolateMissing(chars: ScriptChar[], total: number): void {
  let i = 0;
  while (i < chars.length) {
    if (chars[i]!.start !== null) { i += 1; continue; }
    let j = i;
    while (j < chars.length && chars[j]!.start === null) j += 1;
    const left = i > 0 ? chars[i - 1]!.end : null;
    const right = j < chars.length ? chars[j]!.start : null;
    const from = left ?? (right !== null ? Math.max(0, right - 0.3) : 0);
    const to = right ?? (left !== null ? Math.min(total, left + 0.3) : total);
    const count = j - i;
    for (let k = 0; k < count; k += 1) {
      const t0 = from + ((to - from) * k) / count;
      const t1 = from + ((to - from) * (k + 1)) / count;
      chars[i + k]!.start = t0;
      chars[i + k]!.end = t1;
    }
    i = j;
  }
}

/** CJK 逐字 + 拉丁整段 token（vendor words 口径） */
function tokenize(slice: ScriptChar[]): Array<{ text: string; start: number; end: number }> {
  const out: Array<{ text: string; start: number; end: number }> = [];
  let latin: { text: string; start: number; end: number } | null = null;
  for (const ch of slice) {
    if (ch.latin) {
      if (latin) { latin.text += ch.ch; latin.end = ch.end ?? latin.end; }
      else latin = { text: ch.ch, start: ch.start ?? 0, end: ch.end ?? ch.start ?? 0 };
      continue;
    }
    if (latin) { out.push({ ...latin, start: round3(latin.start), end: round3(latin.end) }); latin = null; }
    out.push({ text: ch.ch, start: round3(ch.start ?? 0), end: round3(ch.end ?? ch.start ?? 0) });
  }
  if (latin) out.push({ ...latin, start: round3(latin.start), end: round3(latin.end) });
  return out;
}

function round3(x: number): number {
  return Math.round(x * 1000) / 1000;
}

/* ================= timing.json（与 scripts/make_timing.py 同契约） ================= */

export interface TimingChar {
  ch: string;
  t: number;
  e: number;
}

/**
 * 逐字展开：CJK 保留 token 跨度；拉丁 token 内部按字符数线性插值；
 * 标点（含撇号两种写法）零时长——与 vendor `make_timing.py` 的 expand_chars 同口径。
 */
export function expandToTiming(timestamps: TimestampsFile, opts: { strict?: boolean } = {}): TimingChar[] {
  const out: TimingChar[] = [];
  for (const sentence of timestamps.sentences) {
    const tokens = sentence.words.filter((w) => normalizeSpoken(w.text) !== "");
    if (opts.strict) {
      const joined = tokens.map((w) => normalizeSpoken(w.text)).join("");
      if (joined !== normalizeSpoken(sentence.text)) {
        throw new Error(`第 ${sentence.i} 句对齐文本与口播稿不一致（strict）：${joined} ≠ ${normalizeSpoken(sentence.text)}`);
      }
    }
    let pos = 0;
    let previous = sentence.start;
    /**
     * 逐字展开（vendor make_timing.py 同口径）：
     *   **输出保留原文写法**（全角逗号就是全角逗号），归一化只用于"这个字吃几个 token"——
     *   上一版把输出也 NFKC 了，`，` 被写成 `,`，字幕/QA 帧的文件名与文本对不上（测试抓出）。
     */
    for (const ch of sentence.text) {
      const norm = normalizeSpoken(ch);
      const count = norm.length;
      if (count > 0 && pos + count <= tokens.length) {
        const spanTokens = tokens.slice(pos, pos + count);
        const t = spanTokens[0]!.start;
        const e = spanTokens[spanTokens.length - 1]!.end;
        pos += count;
        previous = e;
        out.push({ ch, t: round3(t), e: round3(e) });
      } else {
        out.push({ ch, t: round3(previous), e: round3(previous) });
      }
    }
  }
  return out;
}

export function timingJsonOf(timestamps: TimestampsFile): { chars: TimingChar[] } {
  return { chars: expandToTiming(timestamps, { strict: false }) };
}

/** 锚字查询（beat 校验/模板 tSay 的同一口径）：返回该句内锚字首字的开始秒 */
export function anchorTimeOf(timestamps: TimestampsFile, sentenceIndex: number, anchor: string): number | null {
  const sentence = timestamps.sentences.find((s) => s.i === sentenceIndex);
  if (!sentence) return null;
  const chars = expandToTiming({ sr: timestamps.sr, total: timestamps.total, sentences: [sentence] });
  const flat = chars.map((c) => c.ch).join("");
  const idx = flat.indexOf(anchor);
  if (idx < 0) return null;
  return chars[idx]!.t;
}
