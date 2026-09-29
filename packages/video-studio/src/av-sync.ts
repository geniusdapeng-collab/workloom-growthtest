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

/** A film shorter than three shots must still measure every available shot. */
export function avSyncPolicyForClipCount(clipCount: number): AvSyncPolicy {
  if (!Number.isInteger(clipCount) || clipCount < 1) throw new Error("AV_SYNC_INVALID_CLIP_COUNT");
  return { ...AV_SYNC_POLICY, minMeasurable: Math.min(AV_SYNC_POLICY.minMeasurable, clipCount) };
}

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

/**
 * A saved measurement is evidence for this master only when it names the exact
 * raw bytes and the current shot count. Recompute the verdict from samples so
 * a stale or edited `ok: true` field cannot approve another render.
 */
export function verifyAvSyncEvidence(
  value: unknown,
  expected: { output: string; outputSha256: string; clipCount: number; allowMeasuredDrift?: boolean },
): { ok: boolean; detail: string; measured: number } {
  const fail = (detail: string) => ({ ok: false, detail, measured: 0 });
  if (!value || typeof value !== "object" || Array.isArray(value)) return fail("音画报告缺失或格式错误");
  const report = value as Partial<AvSyncReport> & {
    output?: unknown; outputSha256?: unknown; clipCount?: unknown; policy?: unknown;
  };
  if (report.output !== expected.output || report.outputSha256 !== expected.outputSha256
    || !/^[a-f0-9]{64}$/.test(expected.outputSha256)) {
    return fail("音画报告未绑定当前原始母版路径与 SHA-256");
  }
  if (!Number.isInteger(expected.clipCount) || expected.clipCount < 1 || report.clipCount !== expected.clipCount) {
    return fail("音画报告镜头数量与当前分镜不一致");
  }
  const policy = avSyncPolicyForClipCount(expected.clipCount);
  if (JSON.stringify(report.policy) !== JSON.stringify(policy)) return fail("音画报告使用的判据不是当前版本");
  if (!Array.isArray(report.samples) || report.samples.length !== expected.clipCount) {
    return fail("音画报告缺少逐镜测量样本");
  }
  const indexes = new Set<number>();
  for (const sample of report.samples) {
    if (!sample || typeof sample.shotId !== "string" || !sample.shotId
      || !Number.isInteger(sample.index) || sample.index < 0 || sample.index >= expected.clipCount
      || !Number.isFinite(sample.lagMs) || !Number.isFinite(sample.correlation)
      || sample.correlation < -1 || sample.correlation > 1 || indexes.has(sample.index)) {
      return fail("音画报告样本编号、偏移或相关性无效");
    }
    indexes.add(sample.index);
  }
  const measured = evaluateAvSync(report.samples, policy);
  if (report.ok !== measured.ok || report.measured !== measured.measured
    || report.maxAbsLagMs !== measured.maxAbsLagMs || report.driftMs !== measured.driftMs
    || JSON.stringify(report.violations) !== JSON.stringify(measured.violations)) {
    return fail("音画报告结论与逐镜实测值不一致");
  }
  if (measured.ok) return { ok: true, detail: `当前母版 ${measured.measured} 镜音画实测通过`, measured: measured.measured };
  if (expected.allowMeasuredDrift && measured.measured >= policy.minMeasurable) {
    return { ok: true, detail: `显式带瑕疵放行：${measured.violations.join("；")}`, measured: measured.measured };
  }
  return { ok: false, detail: measured.violations.join("；") || "音画实测未通过", measured: measured.measured };
}

/** 一句话结论（写进阶段日志/终审证据）。 */
export function describeAvSync(report: AvSyncReport): string {
  if (!report.ok) {
    return `音画对齐 FAIL：${report.violations.join("；")}`;
  }
  const drift = report.driftMs === null ? "n/a" : `${report.driftMs.toFixed(1)}ms`;
  return `音画对齐 ok：可测 ${report.measured} 镜，最大偏移 ${report.maxAbsLagMs.toFixed(1)}ms，累计漂移 ${drift}`;
}

/**
 * 拼一刀**音频**的 filter 步骤（2026-09-27 真机事故修复）。
 *
 * 事故：`xfade duration=0` 等价硬切、视频侧一点不损；音频侧早先用
 * `acrossfade=d=Math.max(0.01, overlap)`「凑最小交叉」——于是**每一刀硬切都吃掉 10ms 音频**。
 * 本片（18 镜、14 刀硬切）实测：音轨比画面短 294ms，尾镜音画偏移 -132.9ms、单调漂移 -131.4ms，
 * 被 compose 的音画对齐硬闸直接判红（报告 `*.av-sync.json`），而终审拿它当"素材拼接坏"的证据。
 *
 * 口径：转场口按真实转场时长 `acrossfade`；**硬切口走 `concat`**（样点级顺序拼接，长度守恒），
 * 不再用任何"最小交叉"兜底——硬切就该是硬切，音频不许被静默削短。
 */
export function buildCutAudioStep(options: {
  /** 上一段音频的 filter 标签，如 `[aex0]` / `[a3]` */
  prevLabel: string;
  /** 本段音频的 filter 标签，如 `[aex4]` */
  nextLabel: string;
  /** 输出标签，如 `[a4]` */
  outLabel: string;
  /** 该刀口的转场时长（秒）；0 = 硬切 */
  overlapSec: number;
}): string {
  const { prevLabel, nextLabel, outLabel, overlapSec } = options;
  return overlapSec > 0
    ? `${prevLabel}${nextLabel}acrossfade=d=${overlapSec.toFixed(6)}:c1=tri:c2=tri${outLabel}`
    : `${prevLabel}${nextLabel}concat=n=2:v=0:a=1${outLabel}`;
}

/**
 * 音画对齐实测的**候选取样窗口**（2026-09-27 真机：单窗口会锁到假峰）。
 *
 * 事故：18 镜销售片的实测里，GR-06 那一段固定窗口正好落在停顿/环境声上，
 * 互相关只有 0.439，并锁到邻近镜的相似内容上，报出 -573.6ms 的假偏移（硬闸误判）。
 * 同一素材改用整段包络互相关复核是 0.995、位置正好等于期望值——素材没问题，是**取样窗口**不好。
 *
 * 口径：同一镜给若干候选窗口（起点等差 + 末尾一窗），逐个互相关取**相关性最高**者；
 * 相关性仍低于阈值就按"不可测"处理（判据不放宽），只是不再拿一个坏窗口给整镜定罪。
 */
export function candidateSyncWindows(options: {
  durationSec: number;
  /** 候选窗口起点步长（秒） */
  hopSec?: number;
  /** 最多候选数（含末尾窗口） */
  maxWindows?: number;
}): Array<{ startSec: number; lengthSec: number }> {
  const { durationSec, hopSec = 0.8, maxWindows = 4 } = options;
  const base = Math.min(0.35, Math.max(0.05, durationSec * 0.12));
  const lengthSec = Math.min(1.5, Math.max(0.5, durationSec - base - 0.25));
  if (!(lengthSec >= 0.4)) return [];
  const starts: number[] = [base];
  while (starts.length < maxWindows) starts.push(starts[starts.length - 1]! + hopSec);
  const tail = durationSec - lengthSec - 0.3;
  if (tail > base) starts.push(tail);
  const unique = [...new Set(starts.map((value) => Number(value.toFixed(3))))]
    .filter((value) => value >= 0 && value + lengthSec <= durationSec + 1e-6)
    .sort((a, b) => a - b);
  return unique.map((startSec) => ({ startSec, lengthSec }));
}
