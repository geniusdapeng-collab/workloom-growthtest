/**
 * video/whiteboard/annotate.ts —— 语义标注生成（T-2026-0926-0020）
 *
 * 上游把"读字幕 + 看图写 annotation.json"交给视觉 Agent；本仓把它**确定性化**：
 *
 *   ① 元素区域 ground truth 来自 `lineart_tools.py analyze`（连通域 + 确定性聚合），
 *      不再向图像模型索取 bbox（规格 §2.5 的实施期修正，见 lineart.ts 头注）；
 *   ② 元素 ↔ 字幕事件按**幕内顺序一一对应**（第 i 个叙事事件 → 第 i 个区域，
 *      区域按阅读序给出）；narrativeRole 取上游规定的四段式枚举；
 *   ③ 时序由**真实字幕时长**派生，不是估算：元素串行作画（不重叠），
 *      总时长可被幕时长容纳；
 *   ④ 生成后过 Zod 校验（画布一致 / 区域在图内 / sequence 连续 / 时长区间），
 *      不过则按"收缩区域 + 重排时序"自愈重生成，最多 `WHITEBOARD_ANNOTATE_RETRY` 次。
 *
 * 关于 LLM 配对：上游 SKILL.md 的语义排序（场景铺垫→关键人物→动作变化→反应结果）在这里
 * 由**顺序规则**表达——分句顺序本身就是叙事顺序，区域按阅读序排列与之天然相容。
 * 真机验证表明这条规则比"再调一次 LLM 猜方位"更稳（且零 token）。需要人工微调时，
 * 走确认关：`whiteboard.preview` 出编号检查图，改标注后只重渲该幕。
 */
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import type { SrtCue } from "./srt.js";
import { WhiteboardEngineError, readImageSize, runLineartTool } from "./engine.js";

/* ================= 上游 annotation.json 契约（逐字段 Zod 化） ================= */

export const AnnotationRegionSchema = z.object({
  x: z.number().int().min(0),
  y: z.number().int().min(0),
  width: z.number().int().min(1),
  height: z.number().int().min(1),
});
export type AnnotationRegion = z.infer<typeof AnnotationRegionSchema>;

/** 上游 SKILL.md 规定的叙事角色四段式（受限枚举，避免"张冠李戴"的自由文本） */
export const NARRATIVE_ROLES = [
  "场景铺垫",
  "关键主体",
  "动作或变化",
  "反应或结果",
] as const;

export const AnnotationElementSchema = z.object({
  id: z.string().min(1).max(64),
  label: z.string().min(1).max(80),
  sequence: z.number().int().min(1),
  narrativeRole: z.enum(NARRATIVE_ROLES),
  subtitle: z.string().max(400),
  type: z.string().min(1).max(32).default("object"),
  region: AnnotationRegionSchema,
  reveal: z.object({
    direction: z.enum(["top_to_bottom", "bottom_to_top", "left_to_right", "right_to_left"]),
    startMs: z.number().int().min(0),
    durationMs: z.number().int().min(800).max(6000),
    maskPaddingPx: z.number().int().min(0).max(120).default(22),
    protectedRegions: z.array(AnnotationRegionSchema).default([]),
  }),
  handPath: z.object({
    start: z.tuple([z.number().int(), z.number().int()]),
    end: z.tuple([z.number().int(), z.number().int()]),
    easing: z.enum(["linear", "easeInOut", "easeOut"]).default("easeInOut"),
  }),
});
export type AnnotationElement = z.infer<typeof AnnotationElementSchema>;

export const AnnotationSchema = z.object({
  sceneId: z.string().min(1).max(64),
  canvas: z.object({ width: z.number().int().min(2), height: z.number().int().min(2) }),
  storyBasis: z.string().max(500),
  sceneDurationMs: z.number().int().min(1000),
  elements: z.array(AnnotationElementSchema).min(1).max(12),
});
export type WhiteboardAnnotation = z.infer<typeof AnnotationSchema>;

/**
 * 契约级校验（上游 SKILL.md「遮罩不变量」+ 质量检查的可机检部分）。
 * 返回问题清单（空数组 = 通过）——**不抛异常**，因为调用方要用问题清单指导自愈重生成。
 */
export function validateAnnotation(ann: unknown, imageSize: { width: number; height: number }): string[] {
  const parsed = AnnotationSchema.safeParse(ann);
  if (!parsed.success) {
    return parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`);
  }
  const value = parsed.data;
  const problems: string[] = [];
  if (value.canvas.width !== imageSize.width || value.canvas.height !== imageSize.height) {
    problems.push(`canvas ${value.canvas.width}×${value.canvas.height} 与原图 ${imageSize.width}×${imageSize.height} 不一致`);
  }
  const seqs = value.elements.map((e) => e.sequence).sort((a, b) => a - b);
  seqs.forEach((s, i) => {
    if (s !== i + 1) problems.push(`sequence 不连续：期望 ${i + 1}，实际 ${s}`);
  });
  for (const el of value.elements) {
    const r = el.region;
    if (r.x + r.width > value.canvas.width || r.y + r.height > value.canvas.height) {
      problems.push(`元素 ${el.id} 的区域越界：${r.x},${r.y} ${r.width}×${r.height}`);
    }
    for (const prot of el.reveal.protectedRegions) {
      if (prot.x + prot.width > value.canvas.width || prot.y + prot.height > value.canvas.height) {
        problems.push(`元素 ${el.id} 的 protectedRegion 越界`);
      }
    }
  }
  // 串行作画：startMs 不得重叠（上游 SKILL.md「时序模型」硬要求）
  const byStart = [...value.elements].sort((a, b) => a.reveal.startMs - b.reveal.startMs);
  for (let i = 1; i < byStart.length; i += 1) {
    const prev = byStart[i - 1]!;
    const cur = byStart[i]!;
    if (cur.reveal.startMs < prev.reveal.startMs + prev.reveal.durationMs) {
      problems.push(`元素 ${cur.id} 与 ${prev.id} 的作画区间重叠（应为串行）`);
    }
  }
  const last = byStart[byStart.length - 1]!;
  const finish = last.reveal.startMs + last.reveal.durationMs;
  if (value.sceneDurationMs < finish + 500) {
    problems.push(`sceneDurationMs=${value.sceneDurationMs} 未给结尾留出 0.5s 完整画面（元素画完于 ${finish}ms）`);
  }
  // 重叠区域必须有 protectedRegions 保护（遮罩不变量）
  for (let i = 0; i < value.elements.length; i += 1) {
    for (let j = i + 1; j < value.elements.length; j += 1) {
      const a = value.elements[i]!;
      const b = value.elements[j]!;
      if (overlapArea(a.region, b.region) <= 0) continue;
      const protectedLater = a.reveal.protectedRegions.some((p) => overlapArea(p, b.region) > 0);
      if (!protectedLater) {
        problems.push(`元素 ${a.id} 与后续元素 ${b.id} 区域重叠但未用 protectedRegions 保护`);
      }
    }
  }
  /**
   * 每个元素的**可见面积**必须为正：上游渲染器的允许掩码为空时画不出任何线
   * （打补丁前还会整幕崩，见 vendor PINNED.md 补丁④）。这里把它变成一条可机检的契约。
   */
  for (let i = 0; i < value.elements.length; i += 1) {
    const el = value.elements[i]!;
    const later = value.elements.slice(i + 1).map((e) => e.region);
    if (visibleArea(el.region, later) <= 0) {
      problems.push(`元素 ${el.id} 被后续区域完全覆盖（允许掩码为空，画不出任何内容）`);
    }
  }
  return problems;
}

function overlapArea(a: AnnotationRegion, b: AnnotationRegion): number {
  const x = Math.max(0, Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x));
  const y = Math.max(0, Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y));
  return x * y;
}

/**
 * 区域的"可见面积"：region 扣掉全部后续 region 之后还剩多少面积。
 *
 * 为什么需要：上游渲染器给每个元素算的允许掩码就是 `region − 后续区域 − protectedRegions`，
 * 掩码为空时既画不出东西、又（在打补丁前）会直接崩。这里用容斥原理精确算剩余面积
 * （后续区域最多 8 个 → 2^8 = 256 个子集，代价可忽略），把"空掩码"从源头拦掉。
 */
export function visibleArea(region: AnnotationRegion, laterRegions: AnnotationRegion[]): number {
  const rects = laterRegions.filter((r) => overlapArea(region, r) > 0);
  if (rects.length === 0) return region.width * region.height;
  let area = region.width * region.height;
  const n = rects.length;
  for (let mask = 1; mask < (1 << n); mask += 1) {
    let inter: AnnotationRegion | null = null;
    let bits = 0;
    for (let i = 0; i < n; i += 1) {
      if ((mask & (1 << i)) === 0) continue;
      bits += 1;
      inter = inter ? intersectRect(inter, rects[i]!) : rects[i]!;
      if (!inter) break;
    }
    if (!inter) continue;
    const sub = inter.width * inter.height;
    area += (bits % 2 === 1 ? -sub : sub);
  }
  return Math.max(0, area);
}

function intersectRect(a: AnnotationRegion, b: AnnotationRegion): AnnotationRegion | null {
  const x0 = Math.max(a.x, b.x);
  const y0 = Math.max(a.y, b.y);
  const x1 = Math.min(a.x + a.width, b.x + b.width);
  const y1 = Math.min(a.y + a.height, b.y + b.height);
  if (x1 <= x0 || y1 <= y0) return null;
  return { x: x0, y: y0, width: x1 - x0, height: y1 - y0 };
}

/* ================= 区域 ground truth ================= */

export interface AnalyzeResult {
  canvas: { width: number; height: number };
  candidates: number;
  regions: AnnotationRegion[];
}

export async function analyzeLineart(
  absPath: string,
  k: number,
  env: NodeJS.ProcessEnv = process.env,
): Promise<AnalyzeResult> {
  const res = await runLineartTool<AnalyzeResult>(
    ["analyze", "--in", absPath, "-k", String(Math.max(1, k)), "--order", "reading"],
    { env, timeoutMs: 180_000 },
  );
  if (!res.ok) throw new WhiteboardEngineError(`线稿区域分析失败：${res.error}`);
  return { canvas: res.canvas, candidates: res.candidates, regions: res.regions };
}

/* ================= 标注生成 ================= */

export interface BuildAnnotationInput {
  sceneNo: number;
  sceneTitle: string;
  /** 本幕字幕（逐句；顺序即叙事顺序） */
  cues: SrtCue[];
  lineartAbsPath: string;
  sceneDurationMs: number;
  env?: NodeJS.ProcessEnv;
  retries?: number;
}

export interface BuildAnnotationResult {
  annotation: WhiteboardAnnotation;
  /** 自愈重生成次数（0 = 一次过） */
  attempts: number;
  /** 最终一次校验的问题清单（空 = 通过） */
  problems: string[];
}

/** 元素标签：取该句的前若干字，作为"这一笔在画什么"的人类可读锚点 */
function labelOf(text: string, index: number, maxChars = 18): string {
  const clean = text.replace(/[\s。！？!?；;，,、：:]/g, "");
  const clipped = clean.length > maxChars ? `${clean.slice(0, maxChars)}…` : clean;
  return `${index + 1}. ${clipped || "画面元素"}`;
}

function directionOf(region: AnnotationRegion): AnnotationElement["reveal"]["direction"] {
  return region.width >= region.height ? "left_to_right" : "top_to_bottom";
}

/**
 * 生成一幕的 annotation.json（确定性 + 自愈）。
 *
 * 时序分配：把"元素串行作画"总预算 `sceneDurationMs - 500ms（结尾凝视）` 按各句时长
 * 占比分配，每个元素夹到 [800, 6000]ms；若夹紧后总时长超出预算，按比例整体收缩。
 */
export async function buildAnnotation(input: BuildAnnotationInput): Promise<BuildAnnotationResult> {
  const env = input.env ?? process.env;
  const size = readImageSize(input.lineartAbsPath);
  if (!size) throw new WhiteboardEngineError(`线稿不是可解析的 PNG/JPEG：${input.lineartAbsPath}`);
  if (input.cues.length === 0) throw new WhiteboardEngineError(`第 ${input.sceneNo} 幕没有字幕句，无法生成元素`);

  const maxAttempts = Math.max(1, input.retries ?? Number(env.WHITEBOARD_ANNOTATE_RETRY ?? "3"));
  const plan = planElements(input.cues, Number(env.WHITEBOARD_MAX_ELEMENTS ?? "8"));
  let shrink = 1.0;
  let problems: string[] = [];
  let annotation: WhiteboardAnnotation | null = null;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const analyzed = await analyzeLineart(input.lineartAbsPath, plan.length, env);
    const regions = clampRegions(analyzed.regions, size, shrink);
    annotation = composeAnnotation({
      sceneNo: input.sceneNo,
      sceneTitle: input.sceneTitle,
      cues: input.cues,
      plan,
      regions,
      canvas: size,
      sceneDurationMs: input.sceneDurationMs,
    });
    problems = validateAnnotation(annotation, size);
    if (problems.length === 0) {
      return { annotation, attempts: attempt, problems };
    }
    // 自愈：区域越界/重叠过多 → 下一轮整体收缩（0.9 倍），时序问题由 compose 侧的比例分配处理
    shrink *= 0.9;
  }
  if (!annotation) throw new WhiteboardEngineError(`第 ${input.sceneNo} 幕标注生成失败（无产物）`);
  return { annotation, attempts: maxAttempts, problems };
}

/**
 * 元素计划：把"字幕句"展开成"画面元素"。
 *
 * 为什么不能让元素数 = 句数：一句口播常常讲三件事（"先有人群，再有内容，再接住询盘"），
 * 白板镜头里这就是三笔。若一屏只画两笔，动感与信息密度都会明显不足（真机观感确认）。
 * 因此按句长把每句拆成 1–3 个元素（约每 22 字一笔），整幕上限 `maxElements`。
 *
 * 注意：**字幕本身不拆**——SRT 仍是逐句的完整句子（观众看到的字幕不该被腰斩），
 * 被拆开的多个元素共用同一句 `subtitle`。
 */
export interface ElementPlanItem {
  /** 归属的字幕句下标（0 起） */
  cueIndex: number;
  /** 该句内的第几个元素（0 起） */
  subIndex: number;
  /** 该句被拆成的元素总数 */
  subCount: number;
  subtitle: string;
  /** 该句真实时长（毫秒），用于按比例分配 */
  cueDurationMs: number;
}

export function planElements(cues: SrtCue[], maxElements = 8, charsPerElement = 22): ElementPlanItem[] {
  const perCue = cues.map((cue) =>
    Math.max(1, Math.min(3, Math.round(cue.text.replace(/\s/g, "").length / charsPerElement))));
  // 整幕上限：按"从最长的句子先减"削到上限，保证时长分配不失衡
  while (perCue.reduce((a, b) => a + b, 0) > maxElements) {
    let idx = 0;
    for (let i = 1; i < perCue.length; i += 1) {
      if (perCue[i]! > perCue[idx]! || (perCue[i] === perCue[idx] && cues[i]!.text.length > cues[idx]!.text.length)) idx = i;
    }
    if (perCue[idx]! <= 1) break;
    perCue[idx] = perCue[idx]! - 1;
  }
  const plan: ElementPlanItem[] = [];
  cues.forEach((cue, cueIndex) => {
    const subCount = perCue[cueIndex]!;
    for (let subIndex = 0; subIndex < subCount; subIndex += 1) {
      plan.push({ cueIndex, subIndex, subCount, subtitle: cue.text, cueDurationMs: Math.max(1, cue.durMs) });
    }
  });
  return plan;
}

function clampRegions(regions: AnnotationRegion[], size: { width: number; height: number }, shrink: number): AnnotationRegion[] {
  return regions.map((r) => {
    const cx = r.x + r.width / 2;
    const cy = r.y + r.height / 2;
    const width = Math.max(16, Math.round(r.width * shrink));
    const height = Math.max(16, Math.round(r.height * shrink));
    const x = Math.max(0, Math.min(size.width - width, Math.round(cx - width / 2)));
    const y = Math.max(0, Math.min(size.height - height, Math.round(cy - height / 2)));
    return { x, y, width: Math.min(width, size.width - x), height: Math.min(height, size.height - y) };
  });
}

function composeAnnotation(args: {
  sceneNo: number;
  sceneTitle: string;
  cues: SrtCue[];
  plan: ElementPlanItem[];
  regions: AnnotationRegion[];
  canvas: { width: number; height: number };
  sceneDurationMs: number;
}): WhiteboardAnnotation {
  const { cues, plan, canvas, sceneDurationMs } = args;
  /**
   * 去重叠预处理：丢掉"被后续区域完全盖住"的区域。
   *
   * 这类区域在上游渲染器里的允许掩码为空——画不出任何线，且（打补丁前）会让整幕崩。
   * 直接丢弃是**诚实**的处理：那一句口播仍然会播（字幕与配音都在），
   * 只是不给它单独起一笔，而不是硬塞一个永远画不出东西的区域。
   */
  const keptRegions: AnnotationRegion[] = [];
  args.regions.forEach((region, i) => {
    const later = args.regions.slice(i + 1);
    if (visibleArea(region, later) >= 16) keptRegions.push(region);
  });
  const regions = keptRegions.length > 0 ? keptRegions : [args.regions[0]!];
  const n = Math.min(plan.length, regions.length);
  const budgetMs = Math.max(1000, sceneDurationMs - 500);           // 结尾至少 0.5s 完整画面
  const breathMs = 120;                                              // 元素之间的"换笔呼吸"
  const usableMs = Math.max(800 * n, budgetMs - breathMs * Math.max(0, n - 1));

  // 按"元素所属句的时长 ÷ 句内元素数"分配（同一句拆出的元素等分该句时长）
  const raw = plan.slice(0, n).map((item) => Math.max(1, item.cueDurationMs / item.subCount));
  const totalRaw = raw.reduce((a, b) => a + b, 0);
  let durations = raw.map((d) => clamp(Math.round((d / totalRaw) * usableMs), 800, 6000));
  const sum = durations.reduce((a, b) => a + b, 0);
  if (sum > budgetMs) {
    const scale = budgetMs / sum;
    durations = durations.map((d) => Math.max(800, Math.floor(d * scale)));
  }
  // 若仍超出（元素过多导致 800ms 下限之和也超预算），从最长的元素开始递减
  let overflow = durations.reduce((a, b) => a + b, 0) + breathMs * (n - 1) - budgetMs;
  while (overflow > 0) {
    const idx = durations.indexOf(Math.max(...durations));
    if (durations[idx]! <= 800) break;
    const cut = Math.min(overflow, 50);
    durations[idx] = durations[idx]! - cut;
    overflow -= cut;
  }

  const elements: AnnotationElement[] = [];
  let cursor = 0;
  for (let i = 0; i < n; i += 1) {
    const region = regions[i]!;
    const cue = cues[i]!;
    const direction = directionOf(region);
    const protectedRegions: AnnotationRegion[] = [];
    for (let j = i + 1; j < n; j += 1) {
      const later = regions[j]!;
      if (overlapArea(region, later) > 0) protectedRegions.push(later);
    }
    const horizontal = direction === "left_to_right";
    const start: [number, number] = horizontal
      ? [region.x + 6, region.y + Math.round(region.height / 2)]
      : [region.x + Math.round(region.width / 2), region.y + 6];
    const end: [number, number] = horizontal
      ? [region.x + region.width - 6, region.y + Math.round(region.height / 2)]
      : [region.x + Math.round(region.width / 2), region.y + region.height - 6];
    elements.push({
      id: `s${String(args.sceneNo).padStart(2, "0")}-e${i + 1}`,
      label: labelOf(plan[i]!.subtitle, i),
      sequence: i + 1,
      narrativeRole: NARRATIVE_ROLES[Math.min(i, NARRATIVE_ROLES.length - 1)]!,
      subtitle: plan[i]!.subtitle.slice(0, 200),
      type: i === 0 ? "structure" : "object",
      region,
      reveal: { direction, startMs: cursor, durationMs: durations[i]!, maskPaddingPx: 22, protectedRegions },
      handPath: { start, end, easing: "easeInOut" },
    });
    cursor += durations[i]! + (i === n - 1 ? 0 : breathMs);
  }

  return {
    sceneId: `scene-${String(args.sceneNo).padStart(2, "0")}`,
    canvas,
    storyBasis: `${args.sceneTitle}：${cues.slice(0, n).map((c) => c.text).join(" ")}`.slice(0, 480),
    sceneDurationMs: Math.max(sceneDurationMs, cursor + 500),
    elements,
  };
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}

/** 落盘 annotation.json（与线稿同名，便于上游预览台直接载入目录） */
export function writeAnnotation(jobDir: string, sceneNo: number, annotation: WhiteboardAnnotation): string {
  const path = join(jobDir, `scene-${String(sceneNo).padStart(2, "0")}.annotation.json`);
  writeFileSync(path, `${JSON.stringify(annotation, null, 2)}\n`, "utf8");
  return path;
}
