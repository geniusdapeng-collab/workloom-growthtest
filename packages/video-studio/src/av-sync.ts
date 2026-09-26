/**
 * 音画对齐机制（2026-09-26 真机事故沉淀：T-2026-0924-0001 南昌片）。
 *
 * 事故：分段拼接时**逐段 AAC 音轨比画面短几毫秒**（编码器 priming/帧对齐），
 * 用 `-f concat -c copy` 拼时 demuxer 对每条流分别按"自己那条流的时长"做偏移，
 * 于是声音相对画面**逐镜累计漂移**（真机实测：15 镜尾镜 +125ms，听感就是"上一镜的音效串到下一镜"）。
 *
 * 机制分两层：
 *   ① 预防：拼接必须样点级对齐（画面可直拷，声音走 concat 滤镜或按画面时长补齐）——见 `scripts/tools/compose-film.mts`；
 *   ② 检出：拼完必须**实测**逐镜偏移与全片累计漂移，超阈值即判失败并留报告（本模块）。
 *
 * 本模块只做纯计算（不碰 ffmpeg/文件），便于单测；取样由调用方负责（通常 ffmpeg 抽 16k 单声道）。
 */

export interface AvSyncPolicy {
  /** 单镜允许的最大绝对偏移（ms）。超过即判"这一镜的声音不在这一镜上" */
  maxAbsLagMs: number;
  /** 首镜→末镜允许的累计漂移（ms）。分段拼接时长不守恒会在这里暴露 */
  maxDriftMs: number;
  /** 低于此相关性的窗口视为"不可测"（静音段、纯氛围段） */
  minCorrelation: number;
  /** 至少要有多少个可测窗口，否则判"证据不足" */
  minMeasurable: number;
  /** 连续同号偏移占比超过该值且漂移明显时，判"单调漂移" */
  monotonicRatio: number;
}

export const AV_SYNC_POLICY: AvSyncPolicy = {
  maxAbsLagMs: 40,
  maxDriftMs: 30,
  minCorrelation: 0.25,
  minMeasurable: 3,
  monotonicRatio: 0.6,
};

export interface AvSyncSample {
  shotId: string;
  /** 在成片里的序号（从 0 起），用于判漂移方向 */
  index: number;
  lagMs: number;
  correlation: number;
}

export interface AvSyncReport {
  ok: boolean;
  violations: string[];
  warnings: string[];
  measured: number;
  skipped: string[];
  maxAbsLagMs: number;
  driftMs: number | null;
  monotonic: boolean;
  samples: AvSyncSample[];
}

export interface CrossCorrelationOptions {
  sampleRate: number;
  /** 搜索窗口（ms）。只在这个范围内找峰值，避免把邻镜声音当成对齐证据 */
  maxLagMs: number;
}

export interface CrossCorrelationResult {
  lagMs: number;
  correlation: number;
}

/**
 * 归一化互相关求时延：返回 `target` 相对 `ref` 的偏移（正数 = target 落后于 ref）。
 * 两个信号长度相同、零均值化后按下式打分（分母用重叠窗口的能量，避免长窗口天然占优）。
 */
export function crossCorrelationLag(
  ref: ArrayLike<number>,
  target: ArrayLike<number>,
  options: CrossCorrelationOptions,
): CrossCorrelationResult {
  const { sampleRate, maxLagMs } = options;
  const n = Math.min(ref.length, target.length);
  if (n < 32 || !(sampleRate > 0)) return { lagMs: 0, correlation: 0 };
  const maxLag = Math.max(1, Math.min(n - 16, Math.round((maxLagMs / 1000) * sampleRate)));
  let bestLag = 0;
  let bestScore = -Infinity;
  for (let lag = -maxLag; lag <= maxLag; lag += 1) {
    const startRef = Math.max(0, -lag);
    const startTarget = Math.max(0, lag);
    const length = n - Math.abs(lag);
    if (length < 16) continue;
    let sumRef = 0;
    let sumTarget = 0;
    for (let i = 0; i < length; i += 1) {
      sumRef += ref[startRef + i]!;
      sumTarget += target[startTarget + i]!;
    }
    const meanRef = sumRef / length;
    const meanTarget = sumTarget / length;
    let dot = 0;
    let energyRef = 0;
    let energyTarget = 0;
    for (let i = 0; i < length; i += 1) {
      const a = ref[startRef + i]! - meanRef;
      const b = target[startTarget + i]! - meanTarget;
      dot += a * b;
      energyRef += a * a;
      energyTarget += b * b;
    }
    const denom = Math.sqrt(energyRef * energyTarget);
    const score = denom > 0 ? dot / denom : 0;
    if (score > bestScore) {
      bestScore = score;
      bestLag = lag;
    }
  }
  return {
    lagMs: (bestLag / sampleRate) * 1000,
    correlation: Number.isFinite(bestScore) ? bestScore : 0,
  };
}

/** 把逐镜实测汇总成"能不能出厂"的判定（门禁口径）。 */
export function evaluateAvSync(
  samples: readonly AvSyncSample[],
  policy: AvSyncPolicy = AV_SYNC_POLICY,
): AvSyncReport {
  const violations: string[] = [];
  const warnings: string[] = [];
  if (samples.length === 0) {
    return {
      ok: false, violations: ["没有任何可测窗口（未提供取样）"], warnings, measured: 0,
      skipped: [], maxAbsLagMs: 0, driftMs: null, monotonic: false, samples: [],
    };
  }
  const ordered = [...samples].sort((a, b) => a.index - b.index);
  const measurable = ordered.filter((sample) => sample.correlation >= policy.minCorrelation);
  const skipped = ordered.filter((sample) => sample.correlation < policy.minCorrelation).map((sample) => sample.shotId);
  if (skipped.length > 0) {
    warnings.push(`${skipped.length} 个窗口不可测（相关性 < ${policy.minCorrelation}）：${skipped.join("、")}`);
  }
  if (measurable.length < policy.minMeasurable) {
    violations.push(
      `可测窗口不足：${measurable.length} < ${policy.minMeasurable}（无法证明音画对齐，按失败处理）`,
    );
  }
  const maxAbsLagMs = measurable.reduce((max, sample) => Math.max(max, Math.abs(sample.lagMs)), 0);
  const worst = measurable.find((sample) => Math.abs(sample.lagMs) === maxAbsLagMs) ?? null;
  if (maxAbsLagMs > policy.maxAbsLagMs) {
    violations.push(
      `单镜偏移超阈值：${worst?.shotId ?? "?"} ${worst?.lagMs.toFixed(1) ?? "?"}ms（上限 ${policy.maxAbsLagMs}ms）`,
    );
  }
  let driftMs: number | null = null;
  let monotonic = false;
  if (measurable.length >= 2) {
    const first = measurable[0]!;
    const last = measurable[measurable.length - 1]!;
    driftMs = last.lagMs - first.lagMs;
    if (Math.abs(driftMs) > policy.maxDriftMs) {
      violations.push(
        `全片累计漂移 ${driftMs.toFixed(1)}ms（首镜 ${first.lagMs.toFixed(1)}ms → 末镜 ${last.lagMs.toFixed(1)}ms，上限 ${policy.maxDriftMs}ms）`,
      );
    }
    const deltas: number[] = [];
    for (let i = 1; i < measurable.length; i += 1) deltas.push(measurable[i]!.lagMs - measurable[i - 1]!.lagMs);
    const positives = deltas.filter((value) => value > 0).length;
    const negatives = deltas.filter((value) => value < 0).length;
    const dominant = Math.max(positives, negatives);
    monotonic = deltas.length > 0 && dominant / deltas.length >= policy.monotonicRatio;
    if (monotonic && Math.abs(driftMs) > policy.maxDriftMs / 2) {
      violations.push(
        `单调漂移：${dominant}/${deltas.length} 段偏移同向且累计 ${driftMs.toFixed(1)}ms —— `
        + "典型成因是分段拼接时长不守恒（aac 逐段比画面短，concat demuxer 逐段累计）",
      );
    }
  }
  return {
    ok: violations.length === 0,
    violations,
    warnings,
    measured: measurable.length,
    skipped,
    maxAbsLagMs: Number(maxAbsLagMs.toFixed(1)),
    driftMs: driftMs === null ? null : Number(driftMs.toFixed(1)),
    monotonic,
    samples: ordered,
  };
}

/** 一句话结论（写进阶段日志/终审证据）。 */
export function describeAvSync(report: AvSyncReport): string {
  if (!report.ok) {
    return `音画对齐 FAIL：${report.violations.join("；")}`;
  }
  const drift = report.driftMs === null ? "n/a" : `${report.driftMs.toFixed(1)}ms`;
  return `音画对齐 ok：可测 ${report.measured} 镜，最大偏移 ${report.maxAbsLagMs.toFixed(1)}ms，累计漂移 ${drift}`;
}
