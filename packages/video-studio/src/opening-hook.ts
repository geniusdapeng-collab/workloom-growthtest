/**
 * opening-hook.ts —— **开场钩子 · 前 3 秒机制**（2026-09-27 产品所有者要求：新增岗位/机制）
 *
 * 起因（产品所有者口径）：抖音类平台上，完播率的分水岭在**前 3 秒**。此前管线里：
 *   · 有"片头设计师"（30 字段片头镜头卡 + 标题），但他管的是**片头这一段画面**，
 *     不管"第 1 秒用什么把人钉住"，也没有任何产物能回答"钩子是什么类型、承诺了什么、在哪一镜兑现"；
 *   · 有转场音效层（whoosh/impact/riser），但**只铺在剪辑点**上——0–0.6s 是空白，
 *     而短平台的"钩子音"恰恰落在这一窗口（开场冲击 + 视觉钩子同步）；
 *   · 监制 rubric 里没有"钩子"这一类目，所以"开头三秒平平"永远过闸。
 *
 * 本模块把钩子做成**可校验的产物**（钩子卡）而非形容词：
 *   `HookCard{ type, promise, payoffShotId, firstShotTemplate, sfx }`
 * 三个确定性判据：① 类型在类型库内；② 承诺在正片有兑现镜头（反标题党）；
 * ③ 钩子音效落在平台窗口内（抖音 0–0.6s）。视觉/表演质量仍由监制评审兜（rubric 已同步加类目）。
 *
 * 纪律：钩子**不许撒谎**——`promise` 必须由 `payoffShotId` 那一镜的真实内容兑现；宁可不写钩子，
 * 也不写一个正片兑现不了的钩子（这是"标题党"的技术定义）。
 */

/** 钩子类型库（短平台实测有效的前 3 秒结构；不含"喊口号"这类无效型） */
export const HOOK_TYPES = [
  "question",
  "conflict",
  "counterintuitive",
  "benefit",
  "result-first",
  "suspense",
  "number",
  "scene-shock",
] as const;
export type HookType = (typeof HOOK_TYPES)[number];

export const HOOK_TYPE_LABELS: Record<HookType, string> = {
  question: "疑问开场（把观众的问题先说出口）",
  conflict: "冲突开场（当场呈现一个对立/矛盾）",
  counterintuitive: "反常识开场（先否定一个共识，再给依据）",
  benefit: "利益点开场（先说观众能拿走什么）",
  "result-first": "结果前置（先给结果画面，再回述过程）",
  suspense: "悬念开场（给出未完成的信息缺口）",
  number: "数字开场（用一个可验证的数字立信）",
  "scene-shock": "画面冲击开场（先给最有辨识度的画面事实）",
};

export interface HookSfxSpec {
  kind: "impact" | "whoosh" | "riser";
  /** 起点（秒，相对成片时间轴） */
  atSec: number;
  /** 增益（dB，负值） */
  gainDb?: number;
}

/** 首镜模板：0–3 秒的画面与声音节拍（钩子设计师的产物，不是形容词） */
export interface HookFirstShotTemplate {
  /** 画面（可被摄影机拍到的语言） */
  visual: string;
  /** 首句台词/字幕（短平台口径：≤ 18 字，念得完） */
  line: string;
  /** 该句占用的秒数（用于核对"念得完"） */
  lineSec?: number;
}

export interface HookCard {
  type: HookType;
  /** 钩子承诺（一句话；正片必须兑现） */
  promise: string;
  /** 兑现承诺的镜头 id（必须存在于镜头卡里） */
  payoffShotId: string;
  firstShotTemplate?: HookFirstShotTemplate;
  sfx?: HookSfxSpec;
  /** 钩子设计师给的理由（进证据，便于复盘"为什么这个钩子有效"） */
  rationale?: string;
}

/** 钩子窗口（秒）：观众决定是否滑走的临界点——抖音类短平台 3s，长视频平台 5s */
export const HOOK_WINDOW_SEC = 3;
/** 钩子音效窗口（秒）：必须落在开头这一小段里，否则不叫"开场音" */
export const HOOK_SFX_WINDOW_SEC = 0.6;

/** 平台 → 钩子窗口（秒）。短平台更苛刻。 */
export function hookWindowFor(platform: string): number {
  return /抖音|快手|视频号|小红书|TikTok|Reels|Shorts/i.test(platform) ? HOOK_WINDOW_SEC : 5;
}

/** 钩子卡自身完备性（硬错误逐条返回） */
export function validateHookCard(card: HookCard): string[] {
  const issues: string[] = [];
  if (!HOOK_TYPES.includes(card.type)) {
    issues.push(`钩子类型「${String(card.type)}」不在类型库内（${HOOK_TYPES.join(" / ")}）`);
  }
  if (!card.promise?.trim()) issues.push("缺 promise（钩子承诺：一句话说清第 1 秒许了什么）");
  if (!card.payoffShotId?.trim()) issues.push("缺 payoffShotId（兑现承诺的镜头）——没有兑现镜头的钩子即标题党");
  if (!card.firstShotTemplate?.visual?.trim()) issues.push("缺 firstShotTemplate.visual（首镜 0–3s 的画面语言）");
  if (!card.firstShotTemplate?.line?.trim()) issues.push("缺 firstShotTemplate.line（首句台词/字幕）");
  const line = card.firstShotTemplate?.line ?? "";
  if (line && line.length > 18) issues.push(`首句台词 ${line.length} 字（短平台口径 ≤18 字，否则念不完）`);
  if (card.sfx && !(card.sfx.atSec >= 0 && card.sfx.atSec <= HOOK_SFX_WINDOW_SEC)) {
    issues.push(`钩子音效起点 ${card.sfx.atSec}s 不在 0–${HOOK_SFX_WINDOW_SEC}s 窗口内`);
  }
  return issues;
}

export interface HookShotLike {
  shotId: string;
  duration?: number;
  action?: string;
  scene?: string;
  sceneDescription?: string;
  dialogue?: Array<{ text?: string }> | string;
}

export interface HookCheck {
  id: string;
  pass: boolean;
  hard: boolean;
  detail: string;
}

/** 取镜头卡里可读的文本（台词 + 动作 + 场景），用于"承诺是否真的落在首镜/兑现镜" */
function shotTextOf(shot: HookShotLike): string {
  const dialogue = typeof shot.dialogue === "string"
    ? shot.dialogue
    : (shot.dialogue ?? []).map((entry) => String(entry?.text ?? "")).join(" ");
  return [dialogue, shot.action, shot.scene, shot.sceneDescription].map((value) => String(value ?? "")).join(" ");
}

/** 中文取 2-gram 关键词（去标点与空白），用于"承诺是否在文本里出现"的松判据 */
function keygrams(text: string): Set<string> {
  const cleaned = text.replace(/[\s，。、；：！？（）()【】「」"',.!?;:]/g, "");
  const grams = new Set<string>();
  for (let index = 0; index + 2 <= cleaned.length; index += 1) grams.add(cleaned.slice(index, index + 2));
  return grams;
}

/** 承诺与某一镜文本的重叠度（0–1）：用于"钩子承诺在首镜提出、在兑付镜落实" */
export function promiseOverlap(promise: string, text: string): number {
  const grams = keygrams(promise);
  if (grams.size === 0) return 0;
  const target = keygrams(text);
  let hits = 0;
  for (const gram of grams) if (target.has(gram)) hits += 1;
  return Number((hits / grams.size).toFixed(3));
}

export interface HookCheckInput {
  shots: readonly HookShotLike[];
  hook?: HookCard | null;
  platform: string;
  /** 平台是否短平台（短平台缺钩子卡 = 硬失败；长视频平台为软提示） */
  shortForm?: boolean;
}

/**
 * 开场钩子确定性判据（零 token）。返回逐条检查结果，调用方按 hard 决定 fail-closed。
 * 说明：`hard` 在两类情形下为真——① 钩子卡已存在但**自身不自洽**（承诺无兑现/音效越窗）；
 * ② 平台是短平台却**根本没有钩子卡**（前 3 秒靠运气的片子不进流水线）。
 */
export function openingHookChecks(input: HookCheckInput): HookCheck[] {
  const window = hookWindowFor(input.platform);
  const shortForm = input.shortForm ?? /抖音|快手|视频号|小红书|TikTok|Reels|Shorts/i.test(input.platform);
  const checks: HookCheck[] = [];
  const hook = input.hook ?? null;
  const first = input.shots[0];

  checks.push({
    id: "hook-card",
    pass: Boolean(hook),
    hard: shortForm,
    detail: hook
      ? `钩子卡在场：${hook.type}（${HOOK_TYPE_LABELS[hook.type] ?? "未知类型"}）`
      : `缺钩子卡：${shortForm ? `短平台（${input.platform}）前 ${window}s 必须有钩子（type/promise/payoffShotId）` : "建议在 shotlist 顶层加 hook（类型/承诺/兑现镜/首镜模板）"}`
  });
  if (!hook) return checks;

  const cardIssues = validateHookCard(hook);
  checks.push({
    id: "hook-card-complete",
    pass: cardIssues.length === 0,
    hard: true,
    detail: cardIssues.length === 0 ? "钩子卡字段齐备且自洽" : `钩子卡问题：${cardIssues.join("；")}`
  });

  const payoff = input.shots.find((shot) => shot.shotId === hook.payoffShotId);
  checks.push({
    id: "hook-payoff-shot",
    pass: Boolean(payoff),
    hard: true,
    detail: payoff
      ? `兑现镜 ${hook.payoffShotId} 在场`
      : `兑现镜 ${hook.payoffShotId} 不在镜头卡里——钩子承诺无处兑现（标题党）`
  });

  if (!first) {
    checks.push({ id: "hook-first-shot", pass: false, hard: true, detail: "没有首镜，无法核对钩子窗口" });
  } else {
    const firstSeconds = Number(first.duration ?? 0);
    checks.push({
      id: "hook-window",
      pass: firstSeconds >= window - 0.5,
      hard: false,
      detail: `首镜 ${first.shotId} 时长 ${firstSeconds}s（钩子窗口 ${window}s，首镜太短会把钩子切在半句里）`
    });
    const line = hook.firstShotTemplate?.line ?? "";
    const overlap = promiseOverlap(hook.promise, shotTextOf(first));
    checks.push({
      id: "hook-promise-stated",
      pass: overlap >= 0.2 || (line.length > 0 && promiseOverlap(line, shotTextOf(first)) >= 0.2),
      hard: false,
      detail: `钩子承诺与首镜文本重叠度 ${overlap}（建议 ≥0.2：首镜要真的把承诺说出口/演出来）`
    });
  }

  if (payoff) {
    const overlap = promiseOverlap(hook.promise, shotTextOf(payoff));
    /**
     * 疑问型/悬念型钩子的"兑现"是**回应**，不是字面重复：
     * "还在给平台打工吗？" → 正片里"别再买工具，你缺的是一支班组"就是兑现，
     * 但两句的字面 2-gram 重叠接近 0。因此这两类钩子的判据改为"另有镜头用台词给出回应"，
     * 字面重叠只作为其余类型（利益点/结果前置/数字）的判据。
     */
    const questionLike = hook.type === "question" || hook.type === "suspense";
    const answers = typeof payoff.dialogue === "string"
      ? payoff.dialogue.trim().length > 0
      : (payoff.dialogue ?? []).some((entry) => String(entry?.text ?? "").trim().length > 0);
    checks.push({
      id: "hook-promise-paid",
      pass: overlap >= 0.2 || (questionLike && answers && payoff.shotId !== first?.shotId),
      hard: false,
      detail: questionLike
        ? `兑现镜 ${payoff.shotId} 以台词回应钩子（疑问/悬念型以「回应」为兑现判据；字面重叠度 ${overlap} 仅作参考）`
        : `兑现镜 ${payoff.shotId} 与承诺重叠度 ${overlap}（建议 ≥0.2；钩子承诺必须在正片落地）`
    });
  }

  if (hook.sfx) {
    checks.push({
      id: "hook-sfx-window",
      pass: hook.sfx.atSec >= 0 && hook.sfx.atSec <= HOOK_SFX_WINDOW_SEC,
      hard: true,
      detail: `钩子音效 ${hook.sfx.kind}@${hook.sfx.atSec}s（窗口 0–${HOOK_SFX_WINDOW_SEC}s）`
    });
  }
  return checks;
}

/** 摘要（给日志/报告）：硬失败条数 + 逐条 detail */
export function summarizeHookChecks(checks: readonly HookCheck[]): { hard: number; soft: number; hardFailures: HookCheck[] } {
  const hardFailures = checks.filter((check) => !check.pass && check.hard);
  return {
    hard: hardFailures.length,
    soft: checks.filter((check) => !check.pass && !check.hard).length,
    hardFailures
  };
}

/** 钩子音效默认摆放（钩子卡未声明 sfx 时由管线按平台给一个安全默认） */
export function defaultHookSfx(platform: string): HookSfxSpec {
  const shortForm = /抖音|快手|视频号|小红书|TikTok|Reels|Shorts/i.test(platform);
  return shortForm
    ? { kind: "impact", atSec: 0.08, gainDb: -11 }
    : { kind: "whoosh", atSec: 0.12, gainDb: -13 };
}
