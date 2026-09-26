/**
 * explainer/card-registry.ts —— 配方卡注册表（frontmatter → 结构化数据）· T-2026-0926-0008
 *
 * 事实源：引擎目录 `references/cards/<slug>.md` 的 YAML frontmatter（`name/标题/一句话/适用/时长/能量/
 * 类别/输入/语义/素材形态/位置/props/优先级/代码`）。规格书 §6.5 要求它是"选卡的数据源"，
 * 这里再加一层：**内容槽抽取**——扫 `template/cards/<slug>.tsx` 的模块级 `const NAME = <字面量>;`，
 * 让 LLM 只填数据（§0.2「分镜是数据，LLM 绝不产出代码」）。
 *
 * 白名单（`cards.whitelist.json`，首批受控）：生成器只能选白名单内的卡——PoC 期用来把
 * "108 张卡的自由组合"收敛到"经过逐卡核对内容槽与坑的卡"，避免 LLM 选到没人核过内容通道的卡。
 */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { CardEntrySchema, type CardEntry } from "./types.js";

/* ================= frontmatter ================= */

export function parseFrontmatter(md: string): Record<string, string> {
  const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(md);
  if (!m) return {};
  const out: Record<string, string> = {};
  for (const line of m[1]!.split(/\r?\n/)) {
    const kv = /^([A-Za-z_\u4e00-\u9fa5][^:：]*)[:：]\s*(.*)$/.exec(line);
    if (!kv) continue;
    out[kv[1]!.trim()] = kv[2]!.trim();
  }
  return out;
}

function splitList(raw: string | undefined): string[] {
  if (!raw) return [];
  return raw
    .split(/[,，、]/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/* ================= 内容槽抽取（模块级 const 字面量） ================= */

export interface ConstSlot {
  name: string;
  /** 字面量的源码文本（原样，供 LLM 与校验对照） */
  literal: string;
  /** 解析后的值（能 JSON 解析时给出；否则 null） */
  value: unknown;
}

/**
 * 抽取模块级 `const NAME = <字面量>;`。
 * 只认"等号右侧到深度 0 的分号"之间的内容，且内容必须是 JSON/JS 字面量形状
 * （字符串 / 数字 / 布尔 / 数组 / 对象 / 模板串），避免把 `const x = useMemo(...)` 这种
 * 运行期逻辑误当内容槽——后者不在数据层的可填范围内（要改它属于改代码，应由模板升级承载）。
 */
export function extractConstSlots(source: string): ConstSlot[] {
  const slots: ConstSlot[] = [];
  const re = /\nconst\s+([A-Za-z_$][\w$]*)\s*(?::[^=]+)?=\s*/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(source))) {
    const name = m[1]!;
    const start = m.index + m[0].length;
    const end = scanLiteralEnd(source, start);
    if (end < 0) continue;
    const literal = source.slice(start, end).trim();
    if (!looksLikeLiteral(literal)) continue;
    slots.push({ name, literal, value: tryParseLiteral(literal) });
    re.lastIndex = end;
  }
  return slots;
}

function scanLiteralEnd(source: string, start: number): number {
  let depth = 0;
  let quote: string | null = null;
  let template = 0;
  for (let i = start; i < source.length; i += 1) {
    const ch = source[i]!;
    const prev = source[i - 1];
    if (quote) {
      if (ch === quote && prev !== "\\") quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") { quote = ch; continue; }
    if (ch === "`") { template = template ? 0 : 1; continue; }
    if (template) continue;
    if (ch === "[" || ch === "{" || ch === "(") depth += 1;
    else if (ch === "]" || ch === "}" || ch === ")") depth -= 1;
    else if (ch === ";" && depth === 0) return i;
    else if (ch === "\n" && depth === 0 && /^const\s/m.test(source.slice(i, i + 8))) return -1;
  }
  return -1;
}

function looksLikeLiteral(literal: string): boolean {
  if (!literal) return false;
  if (/^["'`]/.test(literal)) return true;
  if (/^-?\d+(\.\d+)?$/.test(literal)) return true;
  if (/^(true|false|null)$/.test(literal)) return true;
  if (/^[[{]/.test(literal)) return true;
  return false;
}

function tryParseLiteral(literal: string): unknown {
  if (/^["'`]/.test(literal)) return literal.slice(1, -1);
  if (/^-?\d+(\.\d+)?$/.test(literal)) return Number(literal);
  if (literal === "true") return true;
  if (literal === "false") return false;
  if (literal === "null") return null;
  try {
    // JS 字面量（注释 / 单引号 / 未加引号的键 / 尾逗号）→ 保守归一后再解析
    const jsonish = stripComments(literal)
      .replace(/([{,[]\s*)([A-Za-z_$][\w$]*)\s*:/g, '$1"$2":')
      .replace(/'/g, '"')
      .replace(/,(\s*[}\]])/g, "$1");
    return JSON.parse(jsonish) as unknown;
  } catch {
    return null;
  }
}

/** 数据层补丁：const 槽替换（JSON 字面量）+ 精确字符串替换（必须唯一命中） */
export function patchCardSource(
  source: string,
  patch: { consts?: Record<string, unknown>; replaces?: Array<{ from: string; to: string }> },
): { source: string; applied: string[] } {
  let out = source;
  const applied: string[] = [];
  for (const [name, value] of Object.entries(patch.consts ?? {})) {
    const re = new RegExp(`(\\nconst\\s+${escapeRe(name)}\\s*(?::[^=]+)?=\\s*)`);
    const m = re.exec(out);
    if (!m) throw new Error(`卡源码里找不到内容槽 const ${name}（槽名必须来自注册表 slots）`);
    const start = m.index + m[0].length;
    const end = scanLiteralEnd(out, start);
    if (end < 0) throw new Error(`内容槽 ${name} 的字面量边界无法确定（不是模块级 const 字面量）`);
    /**
     * **对象槽做浅合并**（T-2026-0926-0008 实现期修正）：
     * 卡里的 `CONFIG` 往往有十几个键（时间轴/缓动/几何），只改 `target` 一个键时
     * 整体替换会把其余键连同注释一起丢掉 → 卡的时间轴直接塌掉。
     * 因此：槽原值是对象且补丁值也是对象 → 合并后序列化；其余情况整体替换。
     */
    const existing = out.slice(start, end).trim();
    const current = tryParseLiteral(existing);
    /**
     * 对象槽不能"整体覆盖"（真机事故，T-2026-0926-0008）：
     * `unit-grid-proportion` 的 CONFIG 含时序/几何十余键，补丁只改 `target` 时整体覆盖会丢键，
     * 卡在 render 期以 `mixHex(undefined)` 崩掉（帧 410 才炸，静帧 QA 看不出来）。
     * 因此：补丁值是对象但原值**解析不成对象**（含函数/表达式）→ 直接拒绝，让人改用 replace 通道。
     */
    if (isPlainObject(value) && current === null && existing.startsWith("{")) {
      throw new Error(
        `内容槽 ${name} 是对象字面量但无法安全解析合并（可能含函数/表达式）——`
        + `请改用 replaces 通道精确改文案，或把该槽的完整对象值给全（当前不支持部分合并）。`,
      );
    }
    const merged = isPlainObject(current) && isPlainObject(value) ? { ...current, ...value } : value;
    out = `${out.slice(0, start)}${JSON.stringify(merged)}${out.slice(end)}`;
    applied.push(`const:${name}`);
  }
  for (const { from, to } of patch.replaces ?? []) {
    const first = out.indexOf(from);
    if (first < 0) throw new Error(`卡源码里找不到待替换文本：${from.slice(0, 40)}`);
    if (out.indexOf(from, first + 1) >= 0) throw new Error(`待替换文本不唯一（出现多次）：${from.slice(0, 40)}`);
    out = `${out.slice(0, first)}${to}${out.slice(first + from.length)}`;
    applied.push(`replace:${from.slice(0, 20)}`);
  }
  return { source: out, applied };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * 展示文案抽取：把卡源码里"看得见的字"找出来（字符串字面量里的中文 + JSX 文本节点），
 * 供 LLM 作为 `replaces.from` 的候选（LLM 只能引用已存在的原文，不能凭空写代码）。
 * 先剥注释再抽，避免把注释里的中文当成界面文案。
 */
export function extractDisplayStrings(source: string, opts: { limit?: number; minLen?: number } = {}): string[] {
  const limit = opts.limit ?? 40;
  const minLen = opts.minLen ?? 1;
  const code = stripComments(source);
  const found: string[] = [];
  const push = (text: string) => {
    const clean = text.trim();
    if (clean.length < minLen || !/[\u4e00-\u9fff]/.test(clean)) return;
    if (found.includes(clean)) return;
    found.push(clean);
  };
  // ① 字符串字面量（单/双/反引号）
  const strRe = /(["'`])((?:\\.|(?!\1)[^\\])*)\1/g;
  let m: RegExpExecArray | null;
  while ((m = strRe.exec(code))) push(m[2]!.replace(/\\n/g, " "));
  // ② JSX 文本节点（>文字<）
  const jsxRe = />([^<>{}]+)</g;
  while ((m = jsxRe.exec(code))) push(m[1]!);
  return found.slice(0, limit);
}

function stripComments(source: string): string {
  let out = "";
  let quote: string | null = null;
  for (let i = 0; i < source.length; i += 1) {
    const ch = source[i]!;
    const next = source[i + 1];
    if (quote) {
      out += ch;
      if (ch === quote && source[i - 1] !== "\\") quote = null;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") { quote = ch; out += ch; continue; }
    if (ch === "/" && next === "/") {
      while (i < source.length && source[i] !== "\n") i += 1;
      out += "\n";
      continue;
    }
    if (ch === "/" && next === "*") {
      i += 2;
      while (i < source.length && !(source[i] === "*" && source[i + 1] === "/")) i += 1;
      i += 1;
      continue;
    }
    out += ch;
  }
  return out;
}

export interface CardBrief {
  slug: string;
  title: string;
  semantics: string[];
  inputs: string[];
  energy: string;
  oneLiner: string;
  /** 可替换的展示文案（`replaces.from` 的合法来源） */
  strings: string[];
  /** 模块级 const 槽（`consts` 的合法 key） */
  consts: Array<{ name: string; literal: string; value: unknown }>;
}

export function cardBrief(engineDir: string, entry: CardEntry, opts: { strings?: number; literalChars?: number } = {}): CardBrief {
  const tsxPath = join(engineDir, "template/cards", `${entry.slug}.tsx`);
  const source = existsSync(tsxPath) ? readFileSync(tsxPath, "utf8") : "";
  const slots = extractConstSlots(source);
  return {
    slug: entry.slug,
    title: entry.title,
    semantics: entry.semantics,
    inputs: entry.inputs,
    energy: entry.energy,
    oneLiner: entry.oneLiner,
    strings: extractDisplayStrings(source, { limit: opts.strings ?? 18 }),
    consts: slots
      .filter((s) => s.name !== "CSS")
      .map((s) => ({ name: s.name, literal: s.literal.slice(0, opts.literalChars ?? 320), value: s.value })),
  };
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/* ================= 注册表 ================= */

export interface CardRegistry {
  engineDir: string;
  entries: CardEntry[];
  bySlug: Map<string, CardEntry>;
}

export function buildCardRegistry(engineDir: string, opts: { whitelist?: string[] } = {}): CardRegistry {
  const mdDir = join(engineDir, "references/cards");
  const tsxDir = join(engineDir, "template/cards");
  if (!existsSync(mdDir) || !existsSync(tsxDir)) {
    throw new Error(`卡注册表构建失败：引擎目录缺 references/cards 或 template/cards（${engineDir}）`);
  }
  const allow = opts.whitelist?.length ? new Set(opts.whitelist) : null;
  const entries: CardEntry[] = [];
  for (const file of readdirSync(mdDir)) {
    if (!file.endsWith(".md")) continue;
    const slug = file.slice(0, -3);
    if (allow && !allow.has(slug)) continue;
    const fm = parseFrontmatter(readFileSync(join(mdDir, file), "utf8"));
    const tsxPath = join(tsxDir, `${slug}.tsx`);
    const slots = existsSync(tsxPath) ? extractConstSlots(readFileSync(tsxPath, "utf8")).map((s) => s.name) : [];
    entries.push(CardEntrySchema.parse({
      slug: fm.name?.trim() || slug,
      title: fm["标题"] ?? "",
      oneLiner: fm["一句话"] ?? "",
      fit: fm["适用"] ?? "",
      energy: fm["能量"] ?? "",
      category: fm["类别"] ?? "",
      inputs: splitList(fm["输入"]),
      semantics: splitList(fm["语义"]),
      materialForms: fm["素材形态"] ?? "",
      position: fm["位置"] ?? "",
      props: splitList(fm["props"]),
      priority: fm["优先级"] ?? "",
      codePath: fm["代码"] ?? (existsSync(tsxPath) ? `template/cards/${slug}.tsx` : ""),
      slots,
    }));
  }
  entries.sort((a, b) => a.slug.localeCompare(b.slug));
  return { engineDir, entries, bySlug: new Map(entries.map((e) => [e.slug, e])) };
}

/** 选卡候选：语义 × 素材输入两道过滤（taxonomy.md 的两道过滤口径） */
export function candidateCards(
  registry: CardRegistry,
  opts: { semantics?: string[]; inputs?: string[] } = {},
): CardEntry[] {
  const wantSems = new Set(opts.semantics ?? []);
  const wantInputs = new Set(opts.inputs ?? []);
  return registry.entries
    .map((entry) => {
      let score = 0;
      if (wantSems.size) {
        const hit = entry.semantics.filter((s) => wantSems.has(s)).length;
        if (hit === 0) return null;
        score += hit * 2;
      }
      if (wantInputs.size) {
        const hit = entry.inputs.filter((i) => wantInputs.has(i.replace(/\(.*\)$/, "").trim())).length;
        if (hit === 0 && entry.inputs.length > 0) return null;
        score += hit;
      }
      if (entry.priority === "P0") score += 1;
      return { entry, score };
    })
    .filter((x): x is { entry: CardEntry; score: number } => x !== null)
    .sort((a, b) => b.score - a.score || a.entry.slug.localeCompare(b.entry.slug))
    .map((x) => x.entry);
}
