/**
 * platform-intent.ts —— 平台意图识别与平台化语速口径（T-2026-0930-0005）。
 *
 * 背景：`cover-platforms.ts` 已经把 8 个平台的封面规格做成唯一事实源，但**平台值本身**
 * 一直没有自动来源——服务端派活链路只传时长与画幅，用户在需求里写"做一条抖音短视频"
 * 不会让抖音口径生效，只有 `--platform` 参数或调用方显式传 `metadata.brief.platform`
 * 才生效。结果是"平台的调性与节奏自动执行"只在 CLI 与显式传参时成立。
 *
 * 本模块补两件事，都不改封面规格：
 *   1. **平台意图识别**：显式参数 > 需求文本命中 > 默认抖音；结论带来源、命中词与判据，
 *      写进事件账本，可审计"为什么走了这个平台"。
 *   2. **平台语速口径**：把"抖音的语速要明显更快"从形容词变成可校验的数字
 *      （目标语速 / 念得完上限 / 配音基础速率 / 钩子窗口），并给出确定性判据。
 *
 * 语速口径的来历与边界（改数值前先读这一段）：
 *   · `standard` 档与既有全局口径**逐值一致**（`presets/prd-specialist.yml` 的
 *     语速 3.5 字/秒、slow 2.5；`presets/hook-designer.yml` 的 2.5–3.5 折算），
 *     因此未识别平台时不会引入行为漂移；
 *   · 抖音/快手等短平台档位来自产品所有者 2026-09-30 口径（"客户感知是语速要明显更快"），
 *     相对 `standard` 提升约 37%（4.8 / 3.5）。**具体数值属于待真机听感校准的工程口径**，
 *     全部集中在 `SPEECH_RATE_POLICY` 一张表里，校准时只改这一处；
 *   · 语速靠"台词写得更紧 + 配音基础速率"实现，**不靠 atempo 硬拉**——
 *     `bundles/ai-video/connectors/voice-bridge` 的 `fitTempo` 上限 1.25 保持不变
 *     （其 README 明写"改文案或允许溢出，别硬拉语速"）。
 */
import { COVER_PLATFORMS, DEFAULT_COVER_PLATFORM, PLATFORM_ALIASES, getCoverSpec } from "./cover-platforms.js";

export type PlatformIntentSource = "explicit" | "text" | "default";

export interface PlatformIntentDecision {
  /** 平台 ID（与 cover-platforms.ts 同一命名空间） */
  id: string;
  /** 平台展示名 */
  label: string;
  source: PlatformIntentSource;
  /** 人类可读判据，写进事件账本与回执 */
  reason: string;
  /** 命中的原词（`text` 来源）或显式传入值（`explicit` 来源） */
  evidence: string;
  /** 显式传入但未登记的原值（未登记时保留原文，便于排查"为什么没按我写的走"） */
  requested?: string;
  /** 画幅（取自媒体规格表，供需求口径块直接使用） */
  aspectRatio: string;
}

/** 语速档位：fast（短平台强节奏）/ medium（种草与社交）/ standard（长视频与未知平台） */
export type SpeechRateTier = "fast" | "medium" | "standard";

export interface SpeechRateProfile {
  tier: SpeechRateTier;
  /** 撰写台词的目标语速（字/秒）：决定"每秒钟该写多少字" */
  target: number;
  /** 念得完的硬上限（字/秒）：超过即判"本镜念不完"，必须改文案 */
  max: number;
  /** 低于此值判"节奏过松"（软提示：口播浪费了时窗，不是硬失败） */
  min: number;
  /** 配音基础速率倍率（交给 voice-bridge 的 speed 参数） */
  ttsSpeed: number;
  /** 开场钩子窗口（秒）：短平台前 3 秒、长视频前 5 秒 */
  hookWindowSec: number;
}

/**
 * 平台语速口径表（唯一可校准点）。
 * 键必须能在 `COVER_PLATFORMS` 里找到——由 `platform-intent.test.ts` 锁死，防止孤儿键。
 */
export const SPEECH_RATE_POLICY: Record<string, SpeechRateProfile> = {
  douyin: { tier: "fast", target: 4.8, max: 5.6, min: 3.6, ttsSpeed: 1.15, hookWindowSec: 3 },
  kuaishou: { tier: "fast", target: 4.6, max: 5.4, min: 3.5, ttsSpeed: 1.12, hookWindowSec: 3 },
  tiktok: { tier: "fast", target: 4.8, max: 5.6, min: 3.6, ttsSpeed: 1.15, hookWindowSec: 3 },
  "instagram-reels": { tier: "fast", target: 4.6, max: 5.4, min: 3.5, ttsSpeed: 1.12, hookWindowSec: 3 },
  xiaohongshu: { tier: "medium", target: 4.2, max: 5.0, min: 3.2, ttsSpeed: 1.08, hookWindowSec: 3 },
  "wechat-channels": { tier: "medium", target: 4.0, max: 4.8, min: 3.0, ttsSpeed: 1.05, hookWindowSec: 3 },
  bilibili: { tier: "standard", target: 3.5, max: 4.2, min: 2.5, ttsSpeed: 1.0, hookWindowSec: 5 },
  youtube: { tier: "standard", target: 3.5, max: 4.2, min: 2.5, ttsSpeed: 1.0, hookWindowSec: 5 },
};

/** 未识别平台时的兜底档：与既有全局口径（3.5 / 2.5）逐值一致，不引入漂移。 */
export const FALLBACK_SPEECH_RATE: SpeechRateProfile = {
  tier: "standard", target: 3.5, max: 4.2, min: 2.5, ttsSpeed: 1.0, hookWindowSec: 5,
};

export const DEFAULT_PLATFORM_ID = DEFAULT_COVER_PLATFORM;

/** 英文平台词（需词边界，避免 "ins" 命中 "inside" 这类误伤）。 */
const ENGLISH_PLATFORM_PATTERNS: Array<{ re: RegExp; id: string }> = [
  { re: /\btiktok\b/i, id: "tiktok" },
  { re: /\byoutube\b/i, id: "youtube" },
  { re: /\bbilibili\b/i, id: "bilibili" },
  { re: /\bdouyin\b/i, id: "douyin" },
  { re: /\bxiaohongshu\b/i, id: "xiaohongshu" },
  { re: /\binstagram\b/i, id: "instagram-reels" },
  { re: /\breels\b/i, id: "instagram-reels" },
  { re: /\bshorts\b/i, id: "youtube" },
  { re: /\b(?:ig|ins)\b/i, id: "instagram-reels" },
];

/** 中文别名按长度倒序匹配：`抖音/快手` 必须先于 `抖音` 命中，否则复合写法会被拆散。 */
const CHINESE_ALIASES: Array<{ alias: string; id: string }> = Object.entries(PLATFORM_ALIASES)
  .filter(([alias]) => /[\u3400-\u9fff]/.test(alias))
  .map(([alias, id]) => ({ alias, id }))
  .sort((a, b) => b.alias.length - a.alias.length);

function detectFromText(text: string): { id: string; evidence: string; index: number } | null {
  let best: { id: string; evidence: string; index: number } | null = null;
  for (const { alias, id } of CHINESE_ALIASES) {
    const index = text.indexOf(alias);
    if (index < 0) continue;
    if (!best || index < best.index || (index === best.index && alias.length > best.evidence.length)) {
      best = { id, evidence: alias, index };
    }
  }
  for (const { re, id } of ENGLISH_PLATFORM_PATTERNS) {
    const match = re.exec(text);
    if (!match) continue;
    const index = match.index;
    if (!best || index < best.index || (index === best.index && match[0].length > best.evidence.length)) {
      best = { id, evidence: match[0], index };
    }
  }
  return best;
}

const text = (value: unknown): string => (typeof value === "string" ? value : "");

/**
 * 平台标识归一：接受平台 ID、中文别名与展示名三种写法，未登记返回 null。
 * `hookWindowFor` 与本模块共用这一处解析，避免"同一个平台字符串在两处解析成不同结果"。
 */
export function platformIdOf(value?: string | null): string | null {
  const raw = text(value).trim();
  if (!raw) return null;
  const key = raw.toLowerCase();
  if (COVER_PLATFORMS[key]) return COVER_PLATFORMS[key]!.id;
  const aliased = PLATFORM_ALIASES[raw] ?? PLATFORM_ALIASES[key];
  if (aliased && COVER_PLATFORMS[aliased]) return aliased;
  const byName = Object.values(COVER_PLATFORMS).find((spec) => spec.name === raw);
  return byName ? byName.id : null;
}

/**
 * 解析目标平台：显式参数 > 需求文本命中 > 默认抖音。
 * 不会抛错——未登记的显式值按默认口径处理，但保留 `requested` 原值便于排查。
 */
export function resolvePlatformIntent(rawIntent: string, explicit?: string | null): PlatformIntentDecision {
  const request = text(explicit).trim();
  if (request) {
    const id = platformIdOf(request);
    if (id) {
      const resolved = COVER_PLATFORMS[id]!;
      return {
        id: resolved.id, label: resolved.name, source: "explicit",
        reason: `调用方显式指定平台 ${resolved.name}`, evidence: request,
        aspectRatio: resolved.ratio,
      };
    }
    const fallback = getCoverSpec(DEFAULT_PLATFORM_ID);
    return {
      id: fallback.id, label: fallback.name, source: "default", requested: request,
      reason: `显式平台「${request}」未登记，按默认口径 ${fallback.name} 处理`, evidence: request,
      aspectRatio: fallback.ratio,
    };
  }
  const intent = text(rawIntent);
  const hit = intent ? detectFromText(intent) : null;
  if (hit) {
    const spec = getCoverSpec(hit.id);
    return {
      id: spec.id, label: spec.name, source: "text",
      reason: `需求文本命中平台词「${hit.evidence}」`, evidence: hit.evidence,
      aspectRatio: spec.ratio,
    };
  }
  const spec = getCoverSpec(DEFAULT_PLATFORM_ID);
  return {
    id: spec.id, label: spec.name, source: "default",
    reason: `需求未指定平台，按默认口径 ${spec.name} 处理`, evidence: "",
    aspectRatio: spec.ratio,
  };
}

/** 取平台语速档；未登记平台走 `FALLBACK_SPEECH_RATE`（与既有全局口径一致）。 */
export function speechRateProfile(platformId?: string | null): SpeechRateProfile {
  const id = platformIdOf(platformId);
  return id ? SPEECH_RATE_POLICY[id] ?? FALLBACK_SPEECH_RATE : FALLBACK_SPEECH_RATE;
}

const CJK = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\u3040-\u30ff\uac00-\ud7af]/;
const SKIP = /[\s，。、；：？！…—～·「」『』（）〈〉《》【】“”‘’,.;:?!"'()\[\]{}<>~\-_/\\|@#$%^&*+=`]/;

/**
 * 可念字数：汉字/假名/谚文每字计 1；连续 ASCII 字母数字串按"每 2 个字符计 1 个字"
 * 折算（英文发音密度高于中文单字），至少计 1；标点与空白不计。
 * 口径保守（宁可多报超标），与 `cover-platforms.ts` 的标题字数口径同源。
 */
export function spokenUnits(raw: string): number {
  let units = 0;
  let run = 0;
  const flush = (): void => {
    if (run > 0) { units += Math.max(1, Math.ceil(run / 2)); run = 0; }
  };
  for (const ch of text(raw)) {
    if (CJK.test(ch)) { flush(); units += 1; continue; }
    if (SKIP.test(ch)) { flush(); continue; }
    run += 1;
  }
  flush();
  return units;
}

export interface SpeechFitInput {
  /** 该镜的台词（字符串或已拼好的多行文本） */
  text?: string | null;
  /** 该镜时长（秒） */
  durationSec?: number | null;
  profile: SpeechRateProfile;
  /** 用于判据文案的镜头号（可选） */
  shotId?: string | null;
}

/**
 * 从镜头卡的 dialogue 字段抽取可念文本，兼容三种既有形态：
 * 字符串、字符串数组、`{ text }` 对象数组（与 scene-policy 的台词口径一致）。
 */
export function dialogueText(value: unknown): string {
  if (typeof value === "string") return value;
  if (!Array.isArray(value)) return "";
  return value
    .map((row) => (typeof row === "string" ? row : row && typeof row === "object" && !Array.isArray(row)
      ? text((row as Record<string, unknown>).text)
      : ""))
    .filter((line) => line.trim())
    .join("\n");
}

export interface SpeechFitResult {
  ok: boolean;
  severity: "pass" | "over" | "loose" | "invalid";
  units: number;
  durationSec: number;
  /** 该时长下按上限能容纳的字数 */
  maxUnits: number;
  /** 该时长下按目标语速应写的字数 */
  targetUnits: number;
  unitsPerSecond: number;
  detail: string;
}

/**
 * "念得完"判据：按平台上限校验本镜台词。
 * 只判可念性，不判内容合规（内容由片型审计与监制评审负责）。
 */
export function checkSpeechFit(input: SpeechFitInput): SpeechFitResult {
  const profile = input.profile;
  const duration = Number(input.durationSec);
  const units = spokenUnits(text(input.text));
  const where = input.shotId ? `镜头 ${input.shotId} ` : "";
  if (!Number.isFinite(duration) || duration <= 0) {
    return {
      ok: false, severity: "invalid", units, durationSec: 0, maxUnits: 0, targetUnits: 0,
      unitsPerSecond: 0, detail: `${where}时长非法，无法判"念得完"`,
    };
  }
  const maxUnits = duration * profile.max;
  const targetUnits = duration * profile.target;
  const unitsPerSecond = units / duration;
  const base = {
    units, durationSec: Number(duration.toFixed(3)), maxUnits: Number(maxUnits.toFixed(3)),
    targetUnits: Number(targetUnits.toFixed(3)), unitsPerSecond: Number(unitsPerSecond.toFixed(3)),
  };
  if (units === 0) {
    return { ...base, ok: true, severity: "pass", detail: `${where}无台词，免检` };
  }
  if (units > maxUnits) {
    return {
      ...base, ok: false, severity: "over",
      detail: `${where}台词 ${units} 字放不进 ${base.durationSec}s（按 ${profile.max} 字/秒上限只能放 ${Math.floor(maxUnits)} 字，实际 ${base.unitsPerSecond} 字/秒）：改写更短的文案，不要拉快配音硬塞`,
    };
  }
  if (units < duration * profile.min) {
    return {
      ...base, ok: true, severity: "loose",
      detail: `${where}台词 ${units} 字仅 ${base.unitsPerSecond} 字/秒（低于 ${profile.min} 字/秒）：节奏偏松，建议补信息或缩短该镜`,
    };
  }
  return {
    ...base, ok: true, severity: "pass",
    detail: `${where}台词 ${units} 字 / ${base.durationSec}s = ${base.unitsPerSecond} 字/秒，在 ${profile.min}–${profile.max} 字/秒口径内`,
  };
}

/** 注入需求正文的平台制作口径块（供应商与生成端都能看到，不依赖元数据被正确读取）。 */
export function platformDeliveryGuidance(decision: PlatformIntentDecision): string {
  const profile = speechRateProfile(decision.id);
  return `\n[平台制作口径 ${decision.id}·${decision.label}] 目标平台：${decision.label}（${decision.reason}）。`
    + `画幅 ${decision.aspectRatio}；开场钩子须落在前 ${profile.hookWindowSec} 秒。`
    + `语速：目标 ${profile.target} 字/秒、上限 ${profile.max} 字/秒；`
    + `每句台词按镜时长折算后可念字数（镜时长 × ${profile.max}），放不下就改写更短的文案——禁止靠拉快配音把长文案硬塞进短镜。`
    + `配音基础速率 ${profile.ttsSpeed}×。`;
}

/** 平台 ID 是否已登记语速档（供测试与运维校验，不触发告警）。 */
export const hasSpeechRatePolicy = (platformId: string): boolean =>
  Object.hasOwn(SPEECH_RATE_POLICY, String(platformId ?? "").toLowerCase());

/** 全部已登记语速档的平台 ID。 */
export const SPEECH_RATE_PLATFORM_IDS = Object.keys(SPEECH_RATE_POLICY);
