/**
 * duration-projection.ts —— 镜头时长**单点守恒投影器**（唯一允许改时长的宿主位置）
 *
 * 背景（本仓实测问题，均有代码出处）：
 *   · 生成端 prompt 不含任何时长规则（`script-generator.js:266-278`），单镜可产出 3s 或 54s；
 *   · 总量对齐允许单镜 3–60s（`:1314-1315`），越出模型能力 4–30s；
 *   · 台词修复与运行期权重表重分配互不感知（`duration-constraint-manager.js:112-143`），
 *     实测把已修好的台词适配整体抹平（critical 0 → 2）；
 *   · 残差兜底把差额塞给最后一镜且无上限（`production-engine.js:1288-1295`）。
 *
 * 本模块提供**唯一**的时长决策实现：给定计划时长、台词硬下限、目标总时长与模型能力区间，
 * 解出一个满足全部硬约束的整数秒方案；无解时返回结构化 INFEASIBLE（禁止静默破坏台词下限）。
 *
 * 台词硬下限（三条取 max，全部来自仓库真源）：
 *   ① DialogueTimingCalculator 的朗读时长（含情绪语速、标点 0.3s/个、句末 0.5s/句）
 *   ② 交付闸的台词占比规则：台词秒数 ÷ MAX_DIALOGUE_RATIO(0.8)
 *      （`prompt-delivery-guard.js:117-121`：dialogueSec > duration × 0.8 即报 issue）
 *   ③ 单句极限语速：Σ(每句非标点字数) ÷ LIMIT(4.5)
 *      （`prompt-delivery-guard.js:100-115`：units / segSec > limit 即报 issue）
 */
import { createRequire } from "node:module";
import { dirname, resolve as resolvePath } from "node:path";
import { fileURLToPath } from "node:url";

export interface SpeechRateConfig {
  RATES: { slow: number; normal: number; fast: number; rapid: number };
  NORMAL: number;
  LIMIT: number;
  PUNCTUATION_PAUSE: number;
  SENTENCE_PAUSE: number;
  MAX_DIALOGUE_RATIO: number;
}

export interface ProjectionShotInput {
  shotId: string;
  /** 计划时长（LLM/镜头卡意图） */
  duration?: number;
  /** 兼容：部分链路的时长只写在 timing 上 */
  timing?: { start?: number; duration?: number; end?: number };
  dialogue?: unknown;
  emotion?: string;
  mood?: string;
  sceneType?: string;
  isOpening?: boolean;
  isClosing?: boolean;
}

export interface ProjectionEntry {
  shotId: string;
  planSeconds: number;
  seconds: number;
  voiceFloorSeconds: number;
  /** 下限来自哪一条规则（诊断用） */
  floorDriver: "dialogue-seconds" | "ratio-0.8" | "line-limit";
  raised: boolean;
  lowered: boolean;
}

export type ProjectionResult =
  | {
      ok: true;
      entries: ProjectionEntry[];
      totalSeconds: number;
      /** 投影器抬高的镜头（计划时长低于硬下限） */
      raisedShotIds: string[];
    }
  | {
      ok: false;
      error: "INFEASIBLE";
      reason: "voice-floor-exceeds-target" | "capacity-below-target";
      overloadSeconds: number;
      entries: ProjectionEntry[];
      suggestions: string[];
    };

export interface ProjectionOptions {
  targetSeconds: number;
  minSeconds?: number;
  maxSeconds?: number;
  /**
   * 是否把台词硬下限作为**约束**（默认 true）。
   * 规划阶段（台词尚未精简）通常不可满足，此时用 false：
   * 仍保证 Σ=目标 与 [min,max] 区间，把"说得完"交给台词修复后的执行阶段强制。
   * 无论哪种模式，`voiceFloorSeconds` 与 `driver` 都会如实返回，便于报告与阻断判断。
   */
  enforceVoiceFloor?: boolean;
  /** 情绪→语速映射覆盖（默认内置副词/数值/mood 三级映射） */
  emotionRateMap?: Record<string, keyof SpeechRateConfig["RATES"]>;
}

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolvePath(here, "../../..");

let speechRateCache: SpeechRateConfig | null = null;
/** 语速真源：`vendor/supermickey/hyperreality-system/config/speech-rate.js` */
export function loadSpeechRate(): SpeechRateConfig {
  if (speechRateCache) return speechRateCache;
  const require = createRequire(resolvePath(repoRoot, "package.json"));
  const cfg = require(resolvePath(repoRoot, "vendor/supermickey/hyperreality-system/config/speech-rate.js")) as SpeechRateConfig;
  speechRateCache = cfg;
  return cfg;
}

interface VendorDialogueTimingCalculator {
  calculateDuration(dialogue: unknown, emotion?: string): number;
}

let calculatorCache: VendorDialogueTimingCalculator | null = null;
/** 台词时长真源：vendor DialogueTimingCalculator（本模块只在"情绪归一"后调用它） */
export function loadDialogueCalculator(): VendorDialogueTimingCalculator {
  if (calculatorCache) return calculatorCache;
  const require = createRequire(resolvePath(repoRoot, "package.json"));
  const mod = require(
    resolvePath(repoRoot, "vendor/supermickey/hyperreality-system/utils/dialogue-timing-calculator.js")
  ) as { DialogueTimingCalculator: new (o?: Record<string, unknown>) => VendorDialogueTimingCalculator };
  calculatorCache = new mod.DialogueTimingCalculator({ autoAdjust: false });
  return calculatorCache;
}

/* ============================ 情绪 → 语速契约 ============================ */

/**
 * 真实链路里的"情绪"有三种形态，原计算器只认 11 个整词，导致恒回落 normal
 * （实测：复合 mood 串与英文副词全部不命中）：
 *   ① 台词行级英文副词（prompt 强制要求，`script-generator.js:272`）
 *   ② 场地级 emotional_target.valence/arousal（`:307`）
 *   ③ buildMood() 产出的逗号复合串（`shot-normalizer.js:58-83`）
 * 这里做归一：把任意形态映射到计算器认识的整词（calm/normal/excited/urgent）。
 */
export const DEFAULT_EMOTION_RATE_MAP: Record<string, keyof SpeechRateConfig["RATES"]> = {
  // slow
  calm: "slow", calmly: "slow", gently: "slow", softly: "slow", quietly: "slow",
  sad: "slow", sadly: "slow", peacefully: "slow", peaceful: "slow", hesitates: "slow",
  hesitantly: "slow", nostalgic: "slow", warm: "slow", melancholic: "slow",
  // fast
  excited: "fast", excitedly: "fast", confidently: "fast", firmly: "fast",
  tense: "fast", angrily: "fast", angry: "fast", urgent: "fast", urgently: "fast",
  intense: "fast", dramatic: "fast", determined: "fast", brave: "fast",
  // rapid
  panicked: "rapid", panicking: "rapid", shouting: "rapid", screaming: "rapid",
};

const RATE_KEY_TO_CALCULATOR_WORD: Record<keyof SpeechRateConfig["RATES"], string> = {
  slow: "calm",
  normal: "normal",
  fast: "excited",
  rapid: "urgent",
};

/** 归一情绪串 → 语速档位（slow/normal/fast/rapid） */
export function resolveRateKey(
  raw: string | undefined,
  map: Record<string, keyof SpeechRateConfig["RATES"]> = DEFAULT_EMOTION_RATE_MAP
): keyof SpeechRateConfig["RATES"] {
  const text = String(raw ?? "").toLowerCase();
  if (!text) return "normal";
  const tokens = text.split(/[,，;；/|]+/).map((t) => t.trim()).filter(Boolean);
  for (const token of tokens) {
    const direct = map[token];
    if (direct) return direct;
    // 复合 token（如 "very gently"）取其中第一个命中词
    for (const word of token.split(/\s+/)) {
      const hit = map[word];
      if (hit) return hit;
    }
  }
  // valence/arousal 形态：调用方通过 emotion 传入 "arousal:0.9" 这类标记
  const arousal = /arousal[:=]\s*([0-9.]+)/.exec(text);
  if (arousal) {
    const value = Number(arousal[1]);
    if (Number.isFinite(value)) {
      if (value > 0.7) return "fast";
      if (value < 0.3) return "slow";
    }
  }
  return "normal";
}

/* ============================ 台词文本工具 ============================ */

const PUNCTUATION = /[，。！？；：、…—""''（）,.!?;:'"()\-—…\s]/g;

/** 可控口径：剔除标点与空白后的可见字符数（比交付闸的"只剔中文标点"更严，方向安全） */
export function countVisibleUnits(text: string): number {
  return String(text ?? "").replace(PUNCTUATION, "").length;
}

/**
 * 抽取台词文本。**取值优先级必须与 vendor 一致**（`dialogue-timing-calculator.js:281-292`）：
 * text → lines → blocks（三选一，不能相加，否则同一句会被计两遍、台词下限翻倍）。
 */
export function extractDialogueLines(dialogue: unknown): string[] {
  if (!dialogue) return [];
  if (typeof dialogue === "string") return [dialogue].filter(Boolean);
  const d = dialogue as Record<string, unknown>;
  const out: string[] = [];
  const push = (value: unknown) => {
    if (typeof value === "string" && value.trim()) out.push(value);
  };
  if (typeof d.text === "string" && d.text.trim()) return [d.text];
  if (Array.isArray(d.lines)) {
    for (const line of d.lines) {
      if (typeof line === "string") push(line);
      else if (line && typeof line === "object") push((line as Record<string, unknown>).text);
    }
    if (out.length > 0) return out;
  }
  if (Array.isArray(d.blocks)) {
    for (const block of d.blocks) {
      if (!block || typeof block !== "object") continue;
      const b = block as Record<string, unknown>;
      push(b.line ?? b.text);
    }
  }
  return out;
}

/* ============================ 台词硬下限 ============================ */

export interface VoiceFloor {
  seconds: number;
  driver: ProjectionEntry["floorDriver"];
  dialogueSeconds: number;
  ratioSeconds: number;
  lineLimitSeconds: number;
}

/**
 * 计算单镜台词硬下限（三条取 max）——这是"说得完"的唯一定义。
 * @param emotionRaw 行级副词 / mood 复合串 / arousal 标记，均可
 */
export function computeVoiceFloor(shot: ProjectionShotInput, emotionRaw?: string): VoiceFloor {
  const speech = loadSpeechRate();
  const lines = extractDialogueLines(shot.dialogue);
  const emotion = emotionRaw ?? shot.emotion ?? shot.mood;
  const rateKey = resolveRateKey(emotion);
  const calculator = loadDialogueCalculator();
  const dialogueSeconds = lines.length
    ? Math.max(0, Number(calculator.calculateDuration(shot.dialogue, RATE_KEY_TO_CALCULATOR_WORD[rateKey])) || 0)
    : 0;
  const visibleUnits = lines.reduce((sum, line) => sum + countVisibleUnits(line), 0);
  const ratioSeconds = visibleUnits > 0 ? visibleUnits / speech.NORMAL / speech.MAX_DIALOGUE_RATIO : 0;
  const lineLimitSeconds = visibleUnits > 0 ? visibleUnits / speech.LIMIT : 0;
  const candidates: Array<{ seconds: number; driver: ProjectionEntry["floorDriver"] }> = [
    { seconds: dialogueSeconds, driver: "dialogue-seconds" },
    { seconds: ratioSeconds, driver: "ratio-0.8" },
    { seconds: lineLimitSeconds, driver: "line-limit" },
  ];
  const best = candidates.reduce((a, b) => (b.seconds > a.seconds ? b : a), candidates[0]!);
  return {
    seconds: Math.ceil(best.seconds),
    driver: best.driver,
    dialogueSeconds,
    ratioSeconds,
    lineLimitSeconds,
  };
}

/* ============================ 守恒投影 ============================ */

/**
 * 在硬约束下求"最接近计划"的整数秒方案。
 * 硬约束：d[i] ≥ max(modelMin, voiceFloor[i])；d[i] ≤ modelMax；Σd = target。
 * 采用"先落硬下限、再用最大余数法把余量按计划缺口分配"的确定性算法（同输入必同输出）。
 */
export function projectShotDurations(shots: ProjectionShotInput[], options: ProjectionOptions): ProjectionResult {
  const min = Number(options.minSeconds ?? 4);
  const max = Number(options.maxSeconds ?? 30);
  const target = Math.round(Number(options.targetSeconds));
  if (!Number.isFinite(target) || target <= 0) {
    throw new TypeError(`[duration-projection] targetSeconds 必须为正数，收到 ${options.targetSeconds}`);
  }
  if (min > max) throw new TypeError(`[duration-projection] min(${min}) > max(${max})`);
  if (shots.length === 0) {
    return { ok: true, entries: [], totalSeconds: 0, raisedShotIds: [] };
  }

  const floors = shots.map((shot) => {
    const floor = computeVoiceFloor(shot, shot.emotion ?? shot.mood);
    const plan = Math.round(Number(shot.duration ?? shot.timing?.duration ?? floor.seconds) || 0);
    const bound = options.enforceVoiceFloor === false ? Math.max(plan, 0) : floor.seconds;
    return { shot, floor, lower: Math.max(min, Math.min(max, Math.max(bound, min))) };
  });
  const lowerSum = floors.reduce((sum, f) => sum + f.lower, 0);
  const capacity = shots.length * max;

  const entries: ProjectionEntry[] = floors.map(({ shot, floor, lower }) => {
    const plan = Math.round(Number(shot.duration ?? shot.timing?.duration ?? lower) || lower);
    return {
      shotId: shot.shotId,
      planSeconds: plan,
      seconds: lower,
      voiceFloorSeconds: floor.seconds,
      floorDriver: floor.driver,
      raised: false,
      lowered: false,
    };
  });

  if (lowerSum > target) {
    const overload = lowerSum - target;
    return {
      ok: false,
      error: "INFEASIBLE",
      reason: "voice-floor-exceeds-target",
      overloadSeconds: overload,
      entries,
      suggestions: [
        `台词硬下限合计 ${lowerSum}s > 目标 ${target}s（超载 ${overload}s）`,
        `可执行修复：① 精简台词（约删 ${Math.ceil(overload * loadSpeechRate().NORMAL)} 字）；② 目标总时长加至 ${lowerSum}s；③ 减少镜头数`,
      ],
    };
  }
  if (capacity < target) {
    return {
      ok: false,
      error: "INFEASIBLE",
      reason: "capacity-below-target",
      overloadSeconds: target - capacity,
      entries,
      suggestions: [
        `${shots.length} 镜 × 上限 ${max}s = ${capacity}s < 目标 ${target}s`,
        `可执行修复：① 目标总时长降至 ${capacity}s 以内；② 增加镜头数至 ${Math.ceil(target / max)} 镜`,
      ],
    };
  }

  let remaining = target - lowerSum;
  // 按"计划缺口"分配余量；缺口为 0 的镜头进入等权补充轮次
  const order = entries
    .map((entry, index) => ({ entry, index }))
    .sort((a, b) => {
      const gapA = Math.max(0, a.entry.planSeconds - a.entry.seconds);
      const gapB = Math.max(0, b.entry.planSeconds - b.entry.seconds);
      if (gapB !== gapA) return gapB - gapA;
      return a.entry.shotId.localeCompare(b.entry.shotId);
    });

  let guard = 0;
  while (remaining > 0 && guard < shots.length * (max + 2)) {
    guard += 1;
    let moved = false;
    for (const { entry } of order) {
      if (remaining <= 0) break;
      const room = max - entry.seconds;
      if (room <= 0) continue;
      const gap = Math.max(0, entry.planSeconds - entry.seconds);
      const step = gap > 0 ? Math.min(gap, room, remaining) : Math.min(1, room, remaining);
      if (step <= 0) continue;
      entry.seconds += step;
      remaining -= step;
      moved = true;
    }
    if (!moved) break;
  }

  if (remaining > 0) {
    return {
      ok: false,
      error: "INFEASIBLE",
      reason: "capacity-below-target",
      overloadSeconds: remaining,
      entries,
      suggestions: [`余量 ${remaining}s 无法在 [${min}, ${max}] 区间内分配，请调整目标或镜头数`],
    };
  }

  for (const entry of entries) {
    entry.raised = entry.seconds > entry.planSeconds;
    entry.lowered = entry.seconds < entry.planSeconds;
  }
  return {
    ok: true,
    entries,
    totalSeconds: entries.reduce((sum, entry) => sum + entry.seconds, 0),
    raisedShotIds: entries.filter((entry) => entry.raised).map((entry) => entry.shotId),
  };
}

/**
 * 把投影结果写回镜头：**同时**更新顶层 duration 与 timing{start,duration,end}
 * （消除 `phase-3-prompt-fusion.js:280-289` 引入的双字段分叉）。
 */
export function applyProjectedDurations<T extends { shotId?: string; duration?: number; timing?: { start?: number; duration?: number; end?: number } }>(
  shots: T[],
  entries: ProjectionEntry[]
): T[] {
  const byId = new Map(entries.map((entry) => [entry.shotId, entry]));
  let cursor = 0;
  return shots.map((shot, index) => {
    const entry = byId.get(String(shot.shotId ?? index));
    const seconds = Math.round(Number(entry?.seconds ?? shot.timing?.duration ?? shot.duration ?? 0));
    const next = {
      ...shot,
      duration: seconds,
      timing: { start: cursor, duration: seconds, end: cursor + seconds },
    } as T;
    cursor += seconds;
    return next;
  });
}
