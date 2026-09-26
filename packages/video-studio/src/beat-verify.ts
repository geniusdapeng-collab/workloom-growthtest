/**
 * 实测 BPM（beat-verified 选曲）——2026-09-26 真机事故沉淀。
 *
 * 事故：配乐按**标签 BPM**（曲库元数据）选曲与卡点，实测卡点平均误差 123ms；
 * 元数据里的 BPM 是人工/批量打标，和音频真实节拍经常差一截（半速/倍速、错标、变速混音都会偏）。
 *
 * 口径：选曲与卡点判定一律用**从音频实测出来的 BPM**，标签只用于初筛；
 * 同时给出"节拍与剪辑网格的实测偏差"，作为卡点能否放行的依据（不再用"标签 BPM ÷ 剪辑点间隔"反推）。
 */

export interface BpmMeasurement {
  /** 实测 BPM（取 70–180 区间内的最强自相关峰） */
  bpm: number;
  /** 峰的相对强度（0–1），越低说明节拍越弱（氛围/纯弦乐正常偏低） */
  strength: number;
  /** 候选倍速：bpm/2、bpm、bpm*2（用于判断与剪辑网格是否同族） */
  family: number[];
}

export interface BeatGridReport {
  ok: boolean;
  /** 每个剪辑点到最近节拍的距离（ms），取平均 */
  meanErrorMs: number;
  maxErrorMs: number;
  /** 与该网格最贴合的倍速（melody/倍速歧义用） */
  matchedBpm: number;
  detail: string;
}

/**
 * 从波形实测 BPM：谱通量起音包络 → 去均值 → 自相关 → 取 70–180 BPM 内最强峰。
 * 纯计算，调用方负责解码（16k 单声道足够）。
 */
export function measureBpm(samples: ArrayLike<number>, sampleRate: number, options: { minBpm?: number; maxBpm?: number } = {}): BpmMeasurement {
  const minBpm = options.minBpm ?? 70;
  const maxBpm = options.maxBpm ?? 180;
  const n = samples.length;
  if (n < sampleRate * 4) return { bpm: 0, strength: 0, family: [] };
  /**
   * 包络差分法（比"频带能量比"稳）：16ms 窗、8ms 跳，先算短时能量包络，
   * 再取正向差分作为起音强度——鼓点/贝斯/钢琴起音都能落到包络跳变上。
   */
  const frame = 256;
  const hop = 128;
  const frames = Math.floor((n - frame) / hop);
  if (frames < 16) return { bpm: 0, strength: 0, family: [] };
  const window = new Float64Array(frame);
  for (let i = 0; i < frame; i += 1) window[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (frame - 1));
  const envelope = new Float64Array(frames);
  for (let f = 0; f < frames; f += 1) {
    let energy = 0;
    const offset = f * hop;
    for (let i = 0; i < frame; i += 1) {
      const v = (samples[offset + i] ?? 0) * window[i]!;
      energy += v * v;
    }
    envelope[f] = Math.sqrt(energy / frame);
  }
  const flux = new Float64Array(frames);
  for (let f = 1; f < frames; f += 1) {
    flux[f] = Math.max(0, envelope[f]! - envelope[f - 1]!);
  }
  let mean = 0;
  for (let i = 0; i < frames; i += 1) mean += flux[i]!;
  mean /= frames;
  for (let i = 0; i < frames; i += 1) flux[i] = flux[i]! - mean;
  const fps = sampleRate / hop;
  const minLag = Math.max(1, Math.round((60 / maxBpm) * fps));
  const maxLag = Math.min(frames - 2, Math.round((60 / minBpm) * fps));
  let bestLag = 0;
  let bestScore = -Infinity;
  let totalScore = 0;
  /**
   * 梳状加权：把倍频/半频的分数也算进来，避免"半速错标"——
   * 真机上 123ms 卡点误差的成因之一就是标签 BPM 与实测差一个倍速。
   */
  const scoreAt = (lag: number): number => {
    let dot = 0;
    let energy = 0;
    for (let i = lag; i < frames; i += 1) {
      dot += flux[i]! * flux[i - lag]!;
      energy += flux[i - lag]! * flux[i - lag]!;
    }
    return energy > 0 ? dot / energy : 0;
  };
  for (let lag = minLag; lag <= maxLag; lag += 1) {
    let score = scoreAt(lag);
    const double = lag * 2;
    if (double <= frames - 2) score += 0.5 * scoreAt(double);
    const half = Math.round(lag / 2);
    if (half >= 1) score += 0.5 * scoreAt(half);
    totalScore += Math.max(0, score);
    if (score > bestScore) {
      bestScore = score;
      bestLag = lag;
    }
  }
  if (bestLag === 0) return { bpm: 0, strength: 0, family: [] };
  const bpm = (60 * fps) / bestLag;
  const strength = totalScore > 0 ? Math.max(0, Math.min(1, bestScore / (totalScore / (maxLag - minLag + 1) + 1e-9) / 8)) : 0;
  return {
    bpm: Number(bpm.toFixed(2)),
    strength: Number(strength.toFixed(3)),
    family: [Number((bpm / 2).toFixed(2)), Number(bpm.toFixed(2)), Number((bpm * 2).toFixed(2))],
  };
}

/**
 * 节拍 vs 剪辑网格：把每个剪辑点投影到最近的节拍上，给出实测偏差。
 * 为什么不用"标签 BPM ÷ 剪辑点间隔"：那是**反推**，等于假设标签是对的；
 * 这里是**实测**——真的去量"剪辑点离最近一拍差多少毫秒"。
 */
export function beatGridReport(
  bpm: number,
  cutTimes: readonly number[],
  thresholds: { meanErrorMs?: number; maxErrorMs?: number } = {},
): BeatGridReport {
  const meanLimit = thresholds.meanErrorMs ?? 80;
  const maxLimit = thresholds.maxErrorMs ?? 160;
  if (!(bpm > 0) || cutTimes.length === 0) {
    return { ok: false, meanErrorMs: Number.POSITIVE_INFINITY, maxErrorMs: Number.POSITIVE_INFINITY, matchedBpm: bpm, detail: "缺少 BPM 或剪辑点，无法判定卡点" };
  }
  /** 倍速歧义：60/120/240 同族；半速/倍速都能对上网格，取误差最小的那个 */
  const candidates = [bpm / 2, bpm, bpm * 2].filter((value) => value >= 30 && value <= 400);
  let best: BeatGridReport | null = null;
  for (const candidate of candidates) {
    const period = 60 / candidate;
    const errors = cutTimes.map((t) => {
      const phase = t / period;
      const distance = Math.abs(phase - Math.round(phase)) * period * 1000;
      return Math.min(distance, period * 1000 - distance);
    });
    const meanErrorMs = errors.reduce((sum, value) => sum + value, 0) / errors.length;
    const maxErrorMs = Math.max(...errors);
    const report: BeatGridReport = {
      ok: meanErrorMs <= meanLimit && maxErrorMs <= maxLimit,
      meanErrorMs: Number(meanErrorMs.toFixed(1)),
      maxErrorMs: Number(maxErrorMs.toFixed(1)),
      matchedBpm: Number(candidate.toFixed(2)),
      detail: `实测 ${candidate.toFixed(1)}BPM：剪辑点距最近一拍 平均 ${meanErrorMs.toFixed(1)}ms / 最大 ${maxErrorMs.toFixed(1)}ms`
        + `（阈值 平均 ≤${meanLimit}ms、最大 ≤${maxLimit}ms）`,
    };
    if (!best || report.meanErrorMs < best.meanErrorMs) best = report;
  }
  return best!;
}
