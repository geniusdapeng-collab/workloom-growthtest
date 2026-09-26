/**
 * explainer/shotbook.ts —— SHOTBOOK 生成器（LLM 产数据 + 确定性校验）· T-2026-0926-0008
 *
 * 两段式（spec §6.4）：
 *   ① LLM 产出：输入口播稿 + 字级时间戳 + 语义标注 + **卡简报**（卡注册表里的候选 + 每卡可替换文案 +
 *      const 槽），输出严格 Zod 的 SHOTBOOK；LLM 只产数据，**绝不产代码**——
 *      它对卡的所有改动都只能写成 `consts`（槽名来自注册表）或 `replaces`（原文必须是卡源码里
 *      唯一出现的子串）；这两条通道在执行前会先做一次"确定性试打补丁"，打不上就带着错误重生成。
 *   ② 确定性校验：卡 ∈ 白名单 ∩ 注册表、文本逐字覆盖口播稿、镜间隔/时长、同卡连用、版式节奏表、
 *      素材路径形态、sfx 落点。**任一 FAIL 带原因重生成（≤3 次）**；仍不过 → 按调用方策略
 *      （`fallback: 'error'` 转人工 / `'rule'` 落规则分镜并在报告中标注降级）。
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { cardBrief, patchCardSource, type CardRegistry, type CardBrief } from "./card-registry.js";
import { extractJson, type LlmCall } from "./semantics.js";
import {
  ExplainerShotbookSchema,
  type ExplainerScript,
  type ExplainerShotbook,
  type SemanticsFile,
  type TimestampsFile,
} from "./types.js";
import { anchorTimeOf } from "./aligner.js";

/* ================= 校验 ================= */

export interface ValidationIssue {
  level: "error" | "warn";
  shotId: string | null;
  rule: string;
  message: string;
}

export interface ValidateInput {
  shotbook: ExplainerShotbook;
  script: ExplainerScript;
  timestamps: TimestampsFile;
  registry: CardRegistry;
  engineDir: string;
  /** 工程 public 目录（给了就校验素材文件在场；④ 之前可为 null） */
  publicDir?: string | null;
  /** 全片时长上限（TALKCRAFT_MAX_SECONDS） */
  maxSeconds?: number;
}

const normalizeText = (text: string): string => text.replace(/[\s，。！？、；：""''（）()《》…—\-·,.!?;:"']/g, "");

export function validateShotbook(input: ValidateInput): { ok: boolean; errors: ValidationIssue[]; warnings: ValidationIssue[] } {
  const errors: ValidationIssue[] = [];
  const warnings: ValidationIssue[] = [];
  const err = (shotId: string | null, rule: string, message: string) => errors.push({ level: "error", shotId, rule, message });
  const warn = (shotId: string | null, rule: string, message: string) => warnings.push({ level: "warn", shotId, rule, message });
  const { shotbook, script, timestamps, registry, engineDir } = input;
  const total = timestamps.total;

  /* ---- ① 结构：id 唯一 / 时序单调 / 时长 ---- */
  const ids = new Set<string>();
  for (const shot of shotbook.shots) {
    if (ids.has(shot.id)) err(shot.id, "结构", `镜头 id 重复：${shot.id}`);
    ids.add(shot.id);
    const duration = shot.end - shot.start;
    if (duration < 1.2) err(shot.id, "结构", `镜长 ${duration.toFixed(2)}s < 1.2s（转场会吞掉内容）`);
    if (shot.end > total + 0.75) err(shot.id, "结构", `镜尾 ${shot.end.toFixed(2)}s 超出配音总长 ${total.toFixed(2)}s`);
  }
  const ordered = [...shotbook.shots].sort((a, b) => a.start - b.start);
  for (let i = 1; i < ordered.length; i += 1) {
    const prev = ordered[i - 1]!;
    const cur = ordered[i]!;
    const overlap = prev.end - cur.start;
    if (overlap < -0.02) err(cur.id, "结构", `与上一镜（${prev.id}）之间有空档 ${(-overlap).toFixed(2)}s`);
    if (overlap > 0.55) err(cur.id, "结构", `与上一镜重叠 ${overlap.toFixed(2)}s > 0.55s`);
  }
  if (ordered.length > 0) {
    if (ordered[0]!.start > 0.6) warn(ordered[0]!.id, "结构", `片头留白 ${ordered[0]!.start.toFixed(2)}s`);
    const tail = total - ordered[ordered.length - 1]!.end;
    if (tail > 0.8) err(ordered[ordered.length - 1]!.id, "结构", `片尾空 ${tail.toFixed(2)}s（口播已结束但画面没跟上）`);
  }
  if (input.maxSeconds && total > input.maxSeconds) err(null, "结构", `配音 ${total.toFixed(1)}s 超过 TALKCRAFT_MAX_SECONDS=${input.maxSeconds}`);

  /* ---- ② 文本：逐字覆盖口播稿（防编造） ---- */
  const scriptText = normalizeText(script.sentences.map((s) => s.text).join(""));
  const shotText = normalizeText(shotbook.shots.map((s) => s.text).join(""));
  if (scriptText !== shotText) {
    const at = firstDifference(scriptText, shotText);
    err(null, "文本", `镜头文本拼接 ≠ 口播稿（第 ${at} 字起：口播稿「${scriptText.slice(at, at + 12)}」 vs 分镜「${shotText.slice(at, at + 12)}」）`);
  }
  // 每镜文本必须是口播稿的连续片段（防跳读/重复）
  let cursor = 0;
  for (const shot of shotbook.shots) {
    const piece = normalizeText(shot.text);
    const found = scriptText.indexOf(piece, cursor);
    if (found !== cursor) {
      err(shot.id, "文本", found < 0 ? "本镜文本不是口播稿的连续片段（疑似改写/编造）" : `本镜文本跳读了第 ${found} 字（期望从 ${cursor} 起）`);
      cursor = found < 0 ? cursor : found + piece.length;
    } else {
      cursor += piece.length;
    }
  }

  /* ---- ③ 卡：白名单 ∩ 注册表 + 补丁可执行 ---- */
  for (const shot of shotbook.shots) {
    const entry = registry.bySlug.get(shot.card);
    if (!entry) {
      err(shot.id, "选卡", `卡 ${shot.card} 不在受控白名单里（候选：${[...registry.bySlug.keys()].slice(0, 12).join("、")}…）`);
      continue;
    }
    const tsxPath = join(engineDir, "template/cards", `${entry.slug}.tsx`);
    if (!existsSync(tsxPath)) {
      err(shot.id, "选卡", `卡源码缺失：${tsxPath}`);
      continue;
    }
    try {
      patchCardSource(readFileSync(tsxPath, "utf8"), { consts: shot.content, replaces: shot.replace });
    } catch (e) {
      err(shot.id, "内容通道", (e as Error).message);
    }
    if (shot.replace.length === 0 && Object.keys(shot.content).length === 0 && entry.slots.length > 0) {
      warn(shot.id, "内容通道", `该卡有 const 槽（${entry.slots.join("/")}）但本镜未填充：画面会保留 vendor 演示文案`);
    }
    void cardBrief;
  }

  /* ---- ④ 素材：V/图/截图 必须给路径；纯文镜必须有陪衬图形（G5 口径 → WARN） ---- */
  for (const shot of shotbook.shots) {
    if (shot.material.kind !== "文" && !shot.material.ref) {
      err(shot.id, "素材", `素材类型 ${shot.material.kind} 未给 ref 路径`);
    }
    if (shot.material.ref && input.publicDir) {
      const abs = join(input.publicDir, shot.material.ref);
      if (!existsSync(abs)) err(shot.id, "素材", `素材文件不在场：public/${shot.material.ref}`);
    }
    if (shot.material.kind === "文" && shot.replace.length === 0 && Object.keys(shot.content).length === 0) {
      warn(shot.id, "素材", "纯文镜且未填充卡内容：文字与卡的演示文案可能不符");
    }
  }

  /* ---- ⑤ 版式轮换：同卡连用 ≥3 镜 FAIL；版式节奏表必须覆盖全片 ---- */
  let streak = 1;
  for (let i = 1; i < shotbook.shots.length; i += 1) {
    if (shotbook.shots[i]!.card === shotbook.shots[i - 1]!.card) {
      streak += 1;
      if (streak >= 3) err(shotbook.shots[i]!.id, "版式", `同一张卡连用 ${streak} 镜（≥3 镜 FAIL，需换版式）`);
    } else {
      streak = 1;
    }
  }
  const rhythmIds = new Set(shotbook.rhythmTable.map((r) => r.shotId));
  for (const shot of shotbook.shots) if (!rhythmIds.has(shot.id)) err(shot.id, "版式", "版式节奏表缺本镜");

  /* ---- ⑥ sfx：落点必须落在本镜时间窗内且不在最后 0.3s（镜尾保护带） ---- */
  for (const shot of shotbook.shots) {
    for (const cue of shot.sfx) {
      if (cue.t < shot.start - 0.01 || cue.t > shot.end - 0.3) {
        err(shot.id, "音效", `cue ${cue.name}@${cue.t.toFixed(2)}s 不在本镜可用窗（${shot.start.toFixed(2)}–${(shot.end - 0.3).toFixed(2)}s）`);
      }
    }
  }

  return { ok: errors.length === 0, errors, warnings };
}

function firstDifference(a: string, b: string): number {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i += 1) if (a[i] !== b[i]) return i;
  return n;
}

/**
 * 分镜时间**首尾相接**（T-2026-0926-0008 实现期修正）。
 *
 * 为什么必须做：口播稿的句间气口（TTS 气口 180ms + 自然停顿，实测 0.26–0.76s）不是"空白"——
 * talkcraft 的分镜纪律是**镜与镜首尾相接**（转场靠 12 帧交叠，不靠留白），留白会让画面断档，
 * 也会让 render_shots 的"末镜 end == composition 时长"断言失败。
 * 处置：把空档并入**前一镜的镜尾**（新元素仍在词锚处进场，不提前），末镜补到配音总长。
 */
export function chainShotTimes<T extends { id: string; start: number; end: number }>(shots: T[], total: number): T[] {
  const ordered = [...shots].sort((a, b) => a.start - b.start);
  const out: T[] = ordered.map((shot) => ({ ...shot }));
  /**
   * 片头留白并入首镜（真机补）：配音首字前通常有 0.3–0.8s 静默，若首镜从首字开始，
   * 时间线 0..start 这一段**没有任何段覆盖**——render_shots 拼装出的总帧数会比 composition
   * 少这一段（实测 2783→2763，差 20 帧），直接以"拼装总帧数不一致"FAIL。
   * 首镜从 0 起还能满足引擎"开镜不空台"的纪律：画面先到，第一句话再落。
   */
  if (out[0]) out[0].start = 0;
  for (let i = 0; i < out.length - 1; i += 1) {
    const next = out[i + 1]!;
    if (out[i]!.end < next.start) out[i]!.end = next.start;
  }
  const last = out[out.length - 1];
  if (last && last.end < total) last.end = total;
  return out;
}

/* ================= 生成 ================= */

export interface GenerateInput {
  script: ExplainerScript;
  timestamps: TimestampsFile;
  semantics: SemanticsFile;
  registry: CardRegistry;
  engineDir: string;
  llm?: LlmCall;
  aspect?: "9:16" | "16:9";
  /** 品牌口径（写进 G0 风格档；缺省用中性深底档） */
  brand?: { product: string; tone: string; accent?: string; base?: string; ink?: string };
  /** LLM 三次不过时：'error' 转人工（服务端缺省）/ 'rule' 落规则分镜（CLI 离线兜底） */
  fallback?: "error" | "rule";
  maxSeconds?: number;
  publicDir?: string | null;
  onLog?: (line: string) => void;
}

export interface GenerateResult {
  shotbook: ExplainerShotbook;
  via: "llm" | "rule";
  attempts: number;
  /** 每次失败的校验摘要（留痕，进制片档案） */
  failures: string[];
}

export async function generateShotbook(input: GenerateInput): Promise<GenerateResult> {
  const failures: string[] = [];
  if (input.llm) {
    const prompt = buildShotbookPrompt(input);
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      try {
        const text = await input.llm(attempt === 1 ? prompt : `${prompt}\n\n上一次输出被校验拒绝，原因如下，请逐条修正后重新输出完整 JSON：\n${failures[failures.length - 1]}`);
        const parsed = ExplainerShotbookSchema.parse(extractJson(text));
        // LLM 的时间来自时间戳，但句间气口会留空档 → 统一做"首尾相接"再校验（确定性、可复现）
        const shotbook: ExplainerShotbook = {
          ...parsed,
          shots: chainShotTimes(parsed.shots, input.timestamps.total),
        };
        const check = validateShotbook({
          shotbook, script: input.script, timestamps: input.timestamps,
          registry: input.registry, engineDir: input.engineDir,
          publicDir: input.publicDir ?? null, maxSeconds: input.maxSeconds,
        });
        if (check.ok) {
          input.onLog?.(`[shotbook] LLM 分镜通过校验（第 ${attempt} 次尝试，${shotbook.shots.length} 镜）`);
          return { shotbook, via: "llm", attempts: attempt, failures };
        }
        const summary = check.errors.slice(0, 8).map((e) => `${e.rule}/${e.shotId ?? "-"}：${e.message}`).join("；");
        failures.push(summary);
        input.onLog?.(`[shotbook] 第 ${attempt} 次输出未过校验：${summary}`);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        failures.push(message);
        input.onLog?.(`[shotbook] 第 ${attempt} 次输出无法解析：${message}`);
      }
    }
  } else {
    failures.push("未提供 LLM（离线/规则路径）");
  }

  if ((input.fallback ?? "error") === "error") {
    throw new Error(`SHOTBOOK 生成失败（LLM 3 次未过校验），转人工：${failures.join(" | ").slice(0, 800)}`);
  }
  const shotbook = ruleShotbook(input);
  const check = validateShotbook({
    shotbook, script: input.script, timestamps: input.timestamps,
    registry: input.registry, engineDir: input.engineDir,
    publicDir: input.publicDir ?? null, maxSeconds: input.maxSeconds,
  });
  if (!check.ok) {
    throw new Error(`规则兜底分镜也未过校验：${check.errors.map((e) => e.message).join("；").slice(0, 600)}`);
  }
  input.onLog?.(`[shotbook] 降级规则分镜（${shotbook.shots.length} 镜）：${failures.slice(-1)[0]?.slice(0, 160) ?? ""}`);
  return { shotbook, via: "rule", attempts: failures.length, failures };
}

/** LLM 提示词：卡简报是唯一的"可改内容"白名单来源 */
export function buildShotbookPrompt(input: GenerateInput): string {
  const aspect = input.aspect ?? "9:16";
  const briefs: CardBrief[] = input.registry.entries.slice(0, 26).map((entry) => cardBrief(input.engineDir, entry, { strings: 14, literalChars: 260 }));
  const briefLines = briefs.map((b) => [
    `- slug=${b.slug}（${b.title}）语义=${b.semantics.join("/")} 输入=${b.inputs.join("/") || "-"} 能量=${b.energy}`,
    `  说明：${b.oneLiner.slice(0, 90)}`,
    b.strings.length ? `  可替换文案（replaces.from 只能从这里选，且必须整串照抄）：${b.strings.map((s) => `「${s.slice(0, 28)}」`).join(" ")}` : "  可替换文案：无（只能用 consts 槽）",
    b.consts.length ? `  const 槽（consts 的合法 key）：${b.consts.map((c) => c.name).join("、")}` : "  const 槽：无",
  ].join("\n")).join("\n");

  return [
    "你是口播解说片的导演。把口播稿拆成镜头（SHOTBOOK 层矩阵），只输出严格 JSON，不要解释、不要代码。",
    `画幅：${aspect}；节奏：每镜 1.2–5.5 秒，镜与镜首尾相接（允许 ≤0.5s 交叠做转场）。`,
    "",
    "硬规矩（违反会被机器闸拒绝并让你重做）：",
    "1) shots[].text 必须按顺序逐字拼出口播稿全文（不许改写、不许漏字、不许跳读）；每镜文本是口播稿的连续片段。",
    "2) shots[].card 只能从下面候选里选；同一张卡不允许连用 3 镜。",
    "3) 卡内容只能通过两条数据通道改：consts（key 用该卡的 const 槽名）与 replaces（from 必须逐字来自该卡「可替换文案」列表且全片唯一）。改不出合适文案就换卡，不要硬改。",
    "4) rhythmTable 必须覆盖全部镜头：{shotId, hostForm(半身/角标左下/角标右下/分屏格内/抠人贴角/短离场/无人物), container(出血全屏/装框/分屏格/底床/多图编排/长页/无), card}。",
    "5) 镜头时间必须贴合字级时间戳：shots[].start 取本镜首句首字时间，shots[].end 取末字结束时间（±0.15s 内）。",
    "6) 主角是「陈卓」：至少 3 镜使用带 hostSrc 的人形卡（hostForm 填具体形态），其余镜可以纯图文。",
    "7) 音效 sfx 可选，给了必须落在本镜窗口内、且距镜尾 ≥0.3s。",
    "",
    "G0 风格档（style）：domain/tone/palette{base,accent,ink}/font/energy 五项必填；energy ∈ 低/中/高。",
    input.brand ? `品牌口径：产品=${input.brand.product}；语气=${input.brand.tone}；主色=${input.brand.accent ?? "由你定"}。` : "品牌口径：中性深底 + 高对比强调色。",
    "",
    "字级时间戳（每句：起止秒 + 文本）：",
    ...input.timestamps.sentences.map((s) => `S${s.i} ${s.start.toFixed(2)}–${s.end.toFixed(2)} ${s.text}`),
    "",
    "语义标注（选卡第一依据）：",
    ...input.semantics.sentences.map((s) => `S${s.i} ${s.sem}(${s.weight})${s.need ? ` need=${s.need}` : ""}`),
    "",
    "候选卡简报（白名单内）：",
    briefLines,
    "",
    '输出 JSON 结构：{"style":{"domain":"","tone":"","palette":{"base":"#","accent":"#","ink":"#"},"font":"","energy":"中"},'
      + '"rhythmTable":[{"shotId":"s01","hostForm":"角标左下","container":"装框","card":"<slug>"}],'
      + '"shots":[{"id":"s01","start":0,"end":4.2,"text":"...","card":"<slug>","content":{},"replace":[],"skin":{},"material":{"kind":"文"},"sfx":[],"notes":""}]}',
  ].join("\n");
}

/* ================= 规则兜底分镜 ================= */

/**
 * 导演手写计划 → SHOTBOOK（数据层便捷通道）
 *
 * 为什么需要：分镜的"时间"必须来自字级时间戳（禁止手敲秒数），但人写分镜时想表达的是
 * **"哪几句归一个镜头"**。于是提供一层计划格式：`shots[].sentences` 给句号（或句号区间，
 * 形如 "3-5"），本函数用 timestamps 把句号换算成起止秒——人只写结构，机器出时间。
 */
export interface ShotPlan {
  style?: Partial<ExplainerShotbook["style"]>;
  shots: Array<{
    id: string;
    /** 句号或句号区间（1 起；"3-5" 表示第 3 到第 5 句） */
    sentences: string;
    card: string;
    content?: Record<string, unknown>;
    replace?: Array<{ from: string; to: string }>;
    skin?: Record<string, string>;
    material?: { kind: "V" | "图" | "截图" | "文"; ref?: string };
    sfx?: Array<{ t?: number; at?: string; name: string; vol?: number }>;
    notes?: string;
  }>;
  /** 版式节奏表（缺省按人物形态轮换自动生成） */
  rhythm?: Array<{ shotId: string; hostForm: string; container: string; card: string }>;
}

export function shotbookFromPlan(
  plan: ShotPlan,
  script: ExplainerScript,
  timestamps: TimestampsFile,
  defaults: { product: string; tone?: string; palette?: { base: string; accent: string; ink: string } },
): ExplainerShotbook {
  const byIndex = new Map(timestamps.sentences.map((s) => [s.i, s]));
  const textOf = new Map(script.sentences.map((s) => [s.i, s.text]));
  const shots = plan.shots.map((entry) => {
    const indexes = parseSentenceSpec(entry.sentences);
    const spans = indexes.map((i) => {
      const sentence = byIndex.get(i);
      if (!sentence) throw new Error(`分镜计划 ${entry.id} 引用了不存在的句号 ${i}（本片共 ${timestamps.sentences.length} 句）`);
      return sentence;
    });
    if (spans.length === 0) throw new Error(`分镜计划 ${entry.id} 没指定句号`);
    const text = indexes.map((i) => textOf.get(i) ?? "").join("");
    const start = spans[0]!.start;
    const end = spans[spans.length - 1]!.end;
    return {
      id: entry.id,
      start: Math.round(start * 1000) / 1000,
      end: Math.round(end * 1000) / 1000,
      text,
      card: entry.card,
      content: entry.content ?? {},
      replace: entry.replace ?? [],
      skin: entry.skin ?? {},
      material: entry.material ?? { kind: "文" as const },
      // 音效落点在第一遍先保留锚点表达式（`end-0.35` 依赖**首尾相接后**的镜尾，见下面的第二遍）
      sfx: [] as Array<{ t: number; name: string; vol: number }>,
      _sfxPlan: entry.sfx ?? [],
      notes: entry.notes ?? "",
    };
  });
  const chained = chainShotTimes(shots, timestamps.total);
  /**
   * 音效落点第二遍（真机修正）：`end-0.35` 必须用**首尾相接后的镜尾**——
   * 首遍用的是"末句结束"，接缝之前落在语音里，sfx_check --mix 会判 MASKED
   * （实测 14 记 cue 全部不在气口：识别的 14 处 ≥0.5s 气口里 cue 命中 0 处）。
   */
  for (const shot of chained) {
    const plan = (shot as unknown as { _sfxPlan?: ShotPlan["shots"][number]["sfx"] })._sfxPlan ?? [];
    shot.sfx = plan.map((cue) => {
      let t = cue.t ?? null;
      if (t === null && cue.at) {
        const tail = /^end\s*-\s*([\d.]+)$/i.exec(cue.at.trim());
        if (tail) {
          t = shot.end - Number(tail[1]);
        } else {
          const [anchor, offsetRaw] = cue.at.split("@");
          const sentenceIndex = Number(anchor?.replace(/^s/i, ""));
          const offset = Number(offsetRaw ?? 0);
          const sentence = byIndex.get(sentenceIndex);
          if (!sentence) throw new Error(`分镜计划 ${shot.id} 的 sfx 锚点句号不存在：${cue.at}`);
          t = sentence.start + (Number.isFinite(offset) ? offset : 0);
        }
      }
      if (t === null) throw new Error(`分镜计划 ${shot.id} 的 sfx 缺 t 或 at（at 形如 "3@0.2" 或 "end-0.35"）`);
      return { t: Math.round(t * 1000) / 1000, name: cue.name, vol: cue.vol ?? 0.3 };
    });
    delete (shot as unknown as Record<string, unknown>)._sfxPlan;
  }
  const rhythm = plan.rhythm ?? shots.map((shot, index) => ({
    shotId: shot.id,
    hostForm: RULE_HOST_FORMS[index % RULE_HOST_FORMS.length]!,
    container: RULE_CONTAINERS[index % RULE_CONTAINERS.length]!,
    card: shot.card,
  }));
  return ExplainerShotbookSchema.parse({
    style: {
      domain: plan.style?.domain ?? defaults.product,
      tone: plan.style?.tone ?? defaults.tone ?? "专业、克制、有结论",
      palette: plan.style?.palette ?? defaults.palette ?? { base: "#0B1020", accent: "#7A5AF8", ink: "#F5F7FF" },
      font: plan.style?.font ?? "PingFang SC / Noto Sans SC",
      energy: plan.style?.energy ?? "中",
    },
    rhythmTable: rhythm,
    shots: chained,
  });
}

/** "3" → [3]；"3-5" → [3,4,5]；"1,2,5" → [1,2,5] */
function parseSentenceSpec(spec: string): number[] {
  const out: number[] = [];
  for (const part of spec.split(",")) {
    const range = /^\s*(\d+)\s*-\s*(\d+)\s*$/.exec(part);
    if (range) {
      const from = Number(range[1]);
      const to = Number(range[2]);
      if (to < from) throw new Error(`句号区间非法：${part}`);
      for (let i = from; i <= to; i += 1) out.push(i);
      continue;
    }
    const single = Number(part.trim());
    if (!Number.isInteger(single) || single < 1) throw new Error(`句号非法：${part}`);
    out.push(single);
  }
  return out;
}

/** 语义 → 偏好卡（只用于兜底；生产路径由 LLM 选卡） */
const RULE_CARD_PREFERENCE: Record<string, string[]> = {
  钩子: ["slab-punch-title", "impact-open-title"],
  标题: ["slab-punch-title", "chapter-title-card"],
  章节: ["chapter-title-card", "numbered-step-stack"],
  列举: ["numbered-step-stack", "alt-block-lines"],
  数据: ["bar-chart-growth", "number-counter"],
  对比: ["chart-grow", "alt-block-lines"],
  步骤: ["numbered-step-stack", "host-card-glass-board"],
  例证: ["info-card-assemble", "host-card-glass-board"],
  定义: ["info-card-assemble", "quote-card"],
  转折: ["strike-and-replace", "slab-punch-title"],
  金句: ["quote-card", "split-text-stagger"],
  号召: ["subscribe-cta", "logo-enter"],
  结尾: ["logo-enter", "quote-card"],
  自我介绍: ["lower-third-nameplate", "chevron-lower-third"],
  介绍他人: ["lower-third-nameplate"],
  强调: ["highlight-sweep", "info-card-assemble"],
  机制: ["source-converge", "info-card-assemble"],
  论点: ["alt-block-lines", "info-card-assemble"],
};

const RULE_HOST_FORMS = ["角标左下", "半身", "角标右下", "分屏格内"];
const RULE_CONTAINERS = ["装框", "底床", "出血全屏", "分屏格"];

export function ruleShotbook(input: GenerateInput): ExplainerShotbook {
  const { script, timestamps, semantics, registry } = input;
  const styleBase = input.brand?.base ?? "#0B1020";
  const styleAccent = input.brand?.accent ?? "#7A5AF8";
  const styleInk = input.brand?.ink ?? "#F5F7FF";
  const bySentence = new Map(semantics.sentences.map((s) => [s.i, s]));
  const sentenceTimes = new Map(timestamps.sentences.map((s) => [s.i, s]));

  // 按"累计时长 2.4–5.2s"分镜，且不切断句子（口播句是天然节拍）
  const groups: Array<{ sentences: number[]; start: number; end: number }> = [];
  let current: { sentences: number[]; start: number; end: number } | null = null;
  for (const sentence of script.sentences) {
    const time = sentenceTimes.get(sentence.i);
    if (!time) throw new Error(`规则分镜缺第 ${sentence.i} 句的时间戳`);
    if (!current) {
      current = { sentences: [sentence.i], start: time.start, end: time.end };
      continue;
    }
    const duration = time.end - current.start;
    const currentDuration = current.end - current.start;
    if (duration <= 5.2 || currentDuration < 2.4) {
      current.sentences.push(sentence.i);
      current.end = time.end;
    } else {
      groups.push(current);
      current = { sentences: [sentence.i], start: time.start, end: time.end };
    }
  }
  if (current) groups.push(current);

  const used = new Set<string>();
  const shots = groups.map((group, index) => {
    const id = `s${String(index + 1).padStart(2, "0")}`;
    const sem = bySentence.get(group.sentences[0]!);
    const prefs = RULE_CARD_PREFERENCE[sem?.sem ?? "论点"] ?? RULE_CARD_PREFERENCE["论点"]!;
    const card = prefs.find((slug) => registry.bySlug.has(slug) && !used.has(`${slug}:${index - 1}`))
      ?? [...registry.bySlug.keys()][index % Math.max(1, registry.bySlug.size)]!;
    used.add(card);
    const text = group.sentences.map((i) => script.sentences.find((s) => s.i === i)!.text).join("");
    return {
      id,
      start: Math.round(group.start * 1000) / 1000,
      end: Math.round(group.end * 1000) / 1000,
      text,
      card,
      content: {},
      replace: [],
      skin: {},
      material: { kind: "文" as const },
      sfx: [],
      notes: "规则兜底分镜（未经 LLM 精修）",
    };
  });
  const chained = chainShotTimes(shots, timestamps.total);

  return ExplainerShotbookSchema.parse({
    style: {
      domain: input.brand?.product ?? "产品解说",
      tone: input.brand?.tone ?? "专业、克制、有结论",
      palette: { base: styleBase, accent: styleAccent, ink: styleInk },
      font: "PingFang SC / Noto Sans SC",
      energy: "中",
    },
    rhythmTable: chained.map((shot, index) => ({
      shotId: shot.id,
      hostForm: RULE_HOST_FORMS[index % RULE_HOST_FORMS.length]!,
      container: RULE_CONTAINERS[index % RULE_CONTAINERS.length]!,
      card: shot.card,
    })),
    shots: chained,
  });
}

/* ================= beats / anchors 派生（绝不允许手敲秒数） ================= */

export interface BeatRow {
  t: number;
  anchor: string;
  sentence: number;
  what: string;
  label: string;
  shot: string;
}

/** 每镜取 1 个词锚节拍（本镜首句的前两字），t 由 timing 查得——机器可验、不手敲 */
export function deriveBeats(shotbook: ExplainerShotbook, timestamps: TimestampsFile, semantics: SemanticsFile): BeatRow[] {
  const beats: BeatRow[] = [];
  for (const shot of shotbook.shots) {
    const clean = shot.text.replace(/[^\u4e00-\u9fffA-Za-z0-9]/g, "");
    const anchor = clean.slice(0, 2) || shot.id;
    const sentence = semantics.sentences.find((s) => shot.text.includes(s.text) || s.text.includes(shot.text.slice(0, 8)))
      ?? semantics.sentences[0]!;
    const t = anchorTimeOf(timestamps, sentence.i, anchor);
    if (t === null) throw new Error(`镜头 ${shot.id} 的锚字「${anchor}」在第 ${sentence.i} 句里查不到时间戳`);
    beats.push({
      t: Math.round(t * 1000) / 1000,
      anchor,
      /**
       * `sentence` 用 **0 基下标**：`beat_lint.py` 的实现是 `sentences[b["sentence"]]`（列表下标），
       * 写 1 基句号时最后一句会越界（`IndexError: list index out of range`，真机踩过）。
       */
      sentence: sentence.i - 1,
      what: `镜头 ${shot.id} 入场（卡 ${shot.card}）`,
      label: `${shot.id}-in`,
      shot: shot.id,
    });
  }
  return beats;
}

export interface AnchorRow {
  t: number;
  label: string;
  /** 状态切换/高风险点：连拍三帧对（qa_extract 口径） */
  burst: boolean;
}

export function deriveAnchors(beats: BeatRow[], shotbook: ExplainerShotbook): AnchorRow[] {
  const materialHeavy = new Set(shotbook.shots.filter((s) => s.material.kind !== "文").map((s) => s.id));
  return beats.map((beat) => ({
    t: beat.t,
    label: beat.label,
    burst: materialHeavy.has(beat.shot) || shotbook.shots[0]?.id === beat.shot,
  }));
}
