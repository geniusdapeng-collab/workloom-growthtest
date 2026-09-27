/**
 * sfx-synth —— 转场音效**合成器**（2026-09-25 新增，为《瞭望塔》式城市片补上缺的一层声音）。
 *
 * 为什么是"合成"而不是"下载素材"：
 *   · 版权干净：全部由 ffmpeg 的噪声/正弦/滤波生成，无第三方采样，商用无顾虑；
 *   · 确定性：同一参数 → 同一波形（可复现、可回归），便于"剪辑点与音效严格对齐"；
 *   · 轻量：不需要随仓分发音频资产，也不需要额外授权登记。
 *
 * 三种音色（对齐《土耳其瞭望塔》的听感：剪辑点上有"气流 + 冲击"）：
 *   · `whoosh`  0.28–0.45s 带通噪声、中心频率从低扫到高再回落——跟甩镜/擦除转场走；
 *   · `impact`  0.20–0.30s 低频正弦 + 短噪声爆音、快衰减——落在段落重音/硬切上；
 *   · `riser`   0.8–1.6s  噪声 + 缓慢上升的带通与音量——用于进入高潮段之前。
 */

export type SfxKind = "whoosh" | "impact" | "riser";

export interface SfxSpec {
  kind: SfxKind;
  durationSec: number;
  /** 相对峰值（dBFS，负值）；混音时再按 gainDb 衰减 */
  peakDb?: number;
  /** 采样率（默认 48000，与母版一致） */
  sampleRate?: number;
}

const DEFAULT_DURATION: Record<SfxKind, number> = {
  whoosh: 0.36,
  impact: 0.26,
  riser: 1.2
};

/** 解析音效时长（未给则用该音色的默认值，并做合理区间钳制） */
export function resolveSfxDuration(kind: SfxKind, durationSec?: number): number {
  const fallback = DEFAULT_DURATION[kind];
  const value = Number.isFinite(durationSec) && (durationSec ?? 0) > 0 ? Number(durationSec) : fallback;
  const [min, max] = kind === "riser" ? [0.6, 2.4] : kind === "impact" ? [0.12, 0.5] : [0.2, 0.8];
  return Math.min(max, Math.max(min, Number(value.toFixed(3))));
}

/**
 * 生成 ffmpeg 参数（不含 `-y` 与输出路径）：**纯函数**，便于单测断言"参数里没有随机源"。
 * 说明：噪声源用 `anoisesrc` 的固定 seed，扫频用 `asetrate`/`highpass`/`lowpass` 组合表达，
 * 因此同一 spec 每次都得到同一段波形（确定性）。
 */
export function buildSfxArgs(spec: SfxSpec): string[] {
  const kind = spec.kind;
  const duration = resolveSfxDuration(kind, spec.durationSec);
  const sr = spec.sampleRate ?? 48000;
  const peak = spec.peakDb ?? (kind === "impact" ? -3 : -6);
  const fadeOut = kind === "impact" ? 0.18 : 0.12;
  const fadeIn = kind === "impact" ? 0.005 : 0.06;
  const filters: string[] = [];
  if (kind === "whoosh") {
    /** 带通中心频率下→上：用两次带通串联 + 音量包络近似"气流扫过" */
    filters.push(
      `highpass=f=420`,
      `lowpass=f=6800`,
      `equalizer=f=1200:t=q:w=1.2:g=6`,
      `equalizer=f=3800:t=q:w=1.1:g=4`,
      `afade=t=in:st=0:d=${fadeIn}`,
      `afade=t=out:st=${Math.max(0, duration - fadeOut).toFixed(3)}:d=${fadeOut}`,
      `volume=${peak}dB`
    );
  } else if (kind === "impact") {
    filters.push(
      `lowpass=f=180`,
      `equalizer=f=60:t=q:w=0.9:g=8`,
      `afade=t=in:st=0:d=${fadeIn}`,
      `afade=t=out:st=${Math.max(0, duration - fadeOut).toFixed(3)}:d=${fadeOut}`,
      `volume=${peak}dB`
    );
  } else {
    filters.push(
      `highpass=f=300`,
      `equalizer=f=900:t=q:w=0.8:g=8`,
      `equalizer=f=2600:t=q:w=0.9:g=6`,
      `afade=t=in:st=0:d=0.25`,
      `afade=t=out:st=${Math.max(0, duration - 0.15).toFixed(3)}:d=0.15`,
      `volume=${peak}dB`
    );
  }
  return [
    "-f", "lavfi",
    "-i", `anoisesrc=color=${kind === "impact" ? "brown" : "white"}:seed=20260925:duration=${duration.toFixed(3)}:sample_rate=${sr}`,
    "-ac", "1",
    "-af", filters.join(","),
    "-c:a", "pcm_s16le",
    "-t", duration.toFixed(3)
  ];
}

export interface SfxPlacement {
  atSec: number;
  kind: SfxKind;
  /** 混音增益（dB，负值） */
  gainDb: number;
  /** 为什么放在这里（进证据） */
  reason: string;
}

export interface CutSfxPlanInput {
  /** 剪辑点（秒，相对成片时间轴） */
  cutTimes: number[];
  durationSec: number;
  /** whoosh 提前量（秒）：音效要在画面前一点点起，听感才对得上 */
  leadSec?: number;
  /** 段落重音（秒）：这些点用 impact；缺省取第 1 个与最后一个剪辑点 */
  accentTimes?: number[];
  /** 高潮那一刻（秒）：riser 会**结束**在这一刻（前置抬升），而不是在它之后才响 */
  climaxAtSec?: number;
  /** 兼容旧参数：直接指定 riser 起点（秒） */
  riserAtSec?: number;
  /** riser 时长（秒，默认 1.2）：用于反推起点 */
  riserDurationSec?: number;
}

export interface CutSfxPolicy {
  whooshGainDb: number;
  impactGainDb: number;
  riserGainDb: number;
  whooshLeadSec: number;
  /** 剪辑点过密时的最小间隔（秒）：低于它不再叠 whoosh，避免糊成一片 */
  minGapSec: number;
}

export const CUT_SFX_POLICY: CutSfxPolicy = {
  whooshGainDb: -13,
  impactGainDb: -9,
  riserGainDb: -16,
  whooshLeadSec: 0.06,
  minGapSec: 0.45
};

/**
 * 剪辑点 → 音效摆放（纯函数）。
 *
 * 纪律（2026-09-25 真机监制打回后收紧）：
 *   ① 段落重音用 impact、高潮前用 riser、其余剪辑点用 whoosh；
 *   ② **riser 必须前置**：结束在高潮那一刻（真机事故：riser 落在切点之后，等于"高潮过去了才抬升"）；
 *   ③ 任意两条音效间隔 ≥ `minGapSec`（真机事故：riser 与 whoosh 只隔 0.15s → 糊成一片、压人声）；
 *   ④ 冲突时按优先级保留（impact > riser > whoosh），被丢掉的如实记在 `dropped` 里（不静默吞）。
 */
export function planCutSfxDetailed(
  input: CutSfxPlanInput,
  policy: CutSfxPolicy = CUT_SFX_POLICY
): { placements: SfxPlacement[]; dropped: SfxPlacement[] } {
  const lead = input.leadSec ?? policy.whooshLeadSec;
  const accents = (input.accentTimes && input.accentTimes.length > 0
    ? input.accentTimes
    : [input.cutTimes[0], input.cutTimes[input.cutTimes.length - 1]]
  ).filter((value): value is number => Number.isFinite(value));
  const candidates: SfxPlacement[] = [];
  for (const cut of [...input.cutTimes].sort((a, b) => a - b)) {
    if (!Number.isFinite(cut) || cut <= 0 || cut >= input.durationSec) continue;
    const at = Math.max(0, Number((cut - lead).toFixed(3)));
    /** 重音判定用 ±0.15s 的紧口径：避免把相邻刀口也判成重音（真机：4.3 的重音让 4.0 也跟着变 impact） */
    const isAccent = accents.some((accent) => Math.abs(accent - cut) <= 0.15);
    if (isAccent) {
      candidates.push({
        atSec: at, kind: "impact", gainDb: policy.impactGainDb,
        reason: `段落重音（剪辑点 ${cut.toFixed(2)}s）`
      });
      continue;
    }
    candidates.push({
      atSec: at, kind: "whoosh", gainDb: policy.whooshGainDb,
      reason: `剪辑点 ${cut.toFixed(2)}s（提前 ${lead}s 起）`
    });
  }
  /** riser：优先按"高潮时刻"反推起点（结束在高潮），否则用显式 riserAtSec */
  const riserDuration = Math.max(0.6, Number(input.riserDurationSec ?? 1.2));
  const climax = Number(input.climaxAtSec ?? NaN);
  const riserStart = Number.isFinite(climax) && climax > 0
    ? Math.max(0, Number((climax - riserDuration - 0.05).toFixed(3)))
    : (Number.isFinite(input.riserAtSec) ? Number(input.riserAtSec) : NaN);
  if (Number.isFinite(riserStart) && riserStart > 0 && riserStart < input.durationSec) {
    candidates.push({
      atSec: Number(riserStart.toFixed(3)), kind: "riser", gainDb: policy.riserGainDb,
      reason: Number.isFinite(climax)
        ? `高潮（${climax.toFixed(2)}s）前的抬升：${riserDuration}s 前置`
        : "进入高潮段前的抬升"
    });
  }
  /** 冲突消解：按优先级（impact > riser > whoosh）贪心接受，间隔不足者记 dropped */
  const priority: Record<SfxKind, number> = { impact: 3, riser: 2, whoosh: 1 };
  const ordered = [...candidates].sort((a, b) => (priority[b.kind] - priority[a.kind]) || (a.atSec - b.atSec));
  const accepted: SfxPlacement[] = [];
  const dropped: SfxPlacement[] = [];
  for (const candidate of ordered) {
    const conflict = accepted.find((entry) => Math.abs(entry.atSec - candidate.atSec) < policy.minGapSec);
    if (conflict) {
      dropped.push({ ...candidate, reason: `${candidate.reason}；与 ${conflict.kind}@${conflict.atSec}s 间隔 < ${policy.minGapSec}s 被丢弃` });
      continue;
    }
    accepted.push(candidate);
  }
  return { placements: accepted.sort((a, b) => a.atSec - b.atSec), dropped: dropped.sort((a, b) => a.atSec - b.atSec) };
}

/** 只取摆放结果（兼容旧调用） */
export function planCutSfx(input: CutSfxPlanInput, policy: CutSfxPolicy = CUT_SFX_POLICY): SfxPlacement[] {
  return planCutSfxDetailed(input, policy).placements;
}

/**
 * 开场钩子音效（2026-09-27 新增：前 3 秒机制的"声音那一半"）。
 *
 * 背景：转场音效只铺在**剪辑点**上——0–0.6s 一直是空白。但短平台的"钉住观众"发生在第 1 秒：
 * 画面钩子（首镜模板）与**钩子音**必须同帧起，否则钩子只是文案。本函数把这条补上，
 * 判据与 `opening-hook.ts#HOOK_SFX_WINDOW_SEC` 同源（配音/画面/音效三者的窗口口径一致）。
 *
 * 纪律：
 *   · 只在 0–0.6s 窗口内摆放（越窗即抛错——宁可不出声，也不在 2s 处放一个"开场音"）；
 *   · 钩子音是**一记**，不是一串：本函数只回一条摆放（由调用方与转场音效一起去冲突）；
 *   · 增益默认低于 impact（-11dB）：开场音要"抬一下"，不能盖住首句台词。
 */
export const HOOK_SFX_POLICY = {
  /** 允许摆放的窗口（秒）：与 opening-hook.ts#HOOK_SFX_WINDOW_SEC 同源 */
  windowSec: 0.6,
  /** 默认起点：略晚于 0（ffmpeg 第 0 帧起音会与波形起点对齐，听感上"抢半拍"） */
  atSec: 0.08,
  kind: "impact" as SfxKind,
  gainDb: -11,
  /** 钩子音时长（不越过窗口结束太多：0.26s 的冲击落在 0.34s 内收完） */
  durationSec: 0.26
};

export interface HookSfxInput {
  enabled: boolean;
  /** 覆盖默认起点（秒） */
  atSec?: number;
  kind?: SfxKind;
  gainDb?: number;
  durationSec?: number;
}

export function planHookSfx(
  input: HookSfxInput,
  policy: typeof HOOK_SFX_POLICY = HOOK_SFX_POLICY
): SfxPlacement | null {
  if (!input.enabled) return null;
  const atSec = Number((input.atSec ?? policy.atSec).toFixed(3));
  if (!Number.isFinite(atSec) || atSec < 0 || atSec > policy.windowSec) {
    throw new Error(`钩子音效起点 ${input.atSec}s 不在 0–${policy.windowSec}s 窗口内（开场音必须在开头，不允许"迟到"）`);
  }
  return {
    atSec,
    kind: input.kind ?? policy.kind,
    gainDb: input.gainDb ?? policy.gainDb,
    reason: `开场钩子音：前 ${policy.windowSec}s 窗口内与钩子画面同帧（${input.kind ?? policy.kind}）`
  };
}

/**
 * 从镜头时长 + 逐刀转场参数推出剪辑点（与 compose 的 xfade 口径一致）。
 * `transitionAt` 用**入点序号**（1 起，与 CLI `--transition-at` 同义）：第 N 个镜头进场处是否有转场。
 */
export function cutTimesFromShots(shotDurations: number[], transitionDuration = 0, transitionAt: number[] = []): number[] {
  const cuts: number[] = [];
  if (shotDurations.length === 0) return cuts;
  /** 时间轴口径：第 i 镜的入场时刻 = 前 (i-1) 镜总时长 − 已消耗的转场重叠量 */
  let cursor = Number(shotDurations[0]!.toFixed(3));
  for (let index = 1; index < shotDurations.length; index += 1) {
    const incomingOrdinal = index + 1;
    const overlap = transitionAt.length === 0 || transitionAt.includes(incomingOrdinal) ? transitionDuration : 0;
    const startOfClip = Number((cursor - overlap).toFixed(3));
    cuts.push(startOfClip);
    cursor = Number((startOfClip + shotDurations[index]!).toFixed(3));
  }
  return cuts;
}
