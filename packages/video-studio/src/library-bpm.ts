/**
 * 曲库实测 BPM 回填（2026-09-26 真机事故沉淀）。
 *
 * 事故：选曲/卡点按曲库**标签 BPM**，真机实测卡点平均误差 123ms；
 * 抽测本地曲库发现标签与实测最大差 40%+（例：city-beneath-the-waves 标签 120BPM / 实测 163.04BPM）。
 * 标签是人工/批量打标，与音频真实节拍经常差一截（半速错标、变速混音、静音头尾都会偏）。
 *
 * 本模块只做**纯逻辑**（可单测）：拿到一条实测结果后如何回填曲库记录、如何汇总偏差。
 * 真正的解码与测量由脚本负责（`scripts/tools/bgm-bpm-backfill.mts`，ffmpeg 抽 16k 单声道 + `measureBpm`）。
 *
 * 回填纪律：
 *   · `bpm`        → 写**实测值**（四舍五入到整数，保持既有消费方按整数用的习惯）；
 *   · `bpmMeasured`→ 实测原值（浮点）+ 强度 + 来源版本 + 时间戳，可追溯；
 *   · `bpmLabel`   → 原标签值（**只写一次**，不覆盖历史），便于"标签 vs 实测"的长期审计；
 *   · 强度过低（氛围/纯弦乐）不硬写：`skippedReason = "low-strength"`，避免把"测不准"当"测得准"。
 */

export const BPM_BACKFILL_VERSION = "bpm-backfill/onset-autocorrelation-v1";

/**
 * 谐波族（倍速/半速/三倍频都在族内）。
 *
 * 为什么必须有这一层：自相关测速天然有**倍频歧义**——同一首曲子既能在 60BPM（一拍 1s）成立，
 * 也能在 120/180BPM（每半拍/三分之一拍一个脉冲）成立；鼓点密集的曲目往往在**高阶谐波**上得分更高。
 * 真机回填可见：标签 60 → 实测 174.42（≈3×）、标签 120 → 实测 79.79（≈2/3，附点/三连音造成的记法差异），
 * 若直接判"冲突"，就会把"同一速度的两种记法"误报成数据错误，也会让下游"剪辑网格族匹配"（60/120/240）失效。
 * 判冲突要**先对族**：族内不叫冲突（含 1/3、1/2、2/3、1×、3/2、2×、3×）。
 */
export function harmonicFamily(bpm: number): number[] {
  if (!Number.isFinite(bpm) || bpm <= 0) return [];
  return [bpm / 3, bpm / 2, (bpm * 2) / 3, bpm, (bpm * 3) / 2, bpm * 2, bpm * 3]
    .filter((value) => value >= 20 && value <= 400);
}

export interface BpmReconcileResult {
  /** 写回曲库的规范 BPM（整数） */
  canonical: number;
  /** 标签与实测是否**不同族**（同族 = 只是记法不同，不算冲突） */
  conflict: boolean;
  reason: string;
  family: number[];
}

/** 标签 vs 实测对账：同族保留标签（人类语义更稳），异族以实测为准并标冲突。 */
export function reconcileBpm(label: number | undefined, measured: number): BpmReconcileResult {
  const family = harmonicFamily(measured);
  if (!Number.isFinite(measured) || measured <= 0) {
    return { canonical: Number.isFinite(label) ? Number(label) : 0, conflict: false, reason: "无实测值", family: [] };
  }
  if (label === undefined || !Number.isFinite(label) || label <= 0) {
    return { canonical: Math.round(measured), conflict: false, reason: "无标签（以实测为准）", family };
  }
  const tolerance = 0.04;
  const hit = family.find((candidate) => Math.abs(candidate - label) / candidate <= tolerance);
  if (hit !== undefined) {
    return {
      canonical: Math.round(label), conflict: false, family,
      reason: `同族（实测 ${measured.toFixed(2)}BPM 的谐波族含标签 ${label}BPM，保留标签作为规范值）`,
    };
  }
  return {
    canonical: Math.round(measured), conflict: true, family,
    reason: `冲突（标签 ${label}BPM 不在实测 ${measured.toFixed(2)}BPM 的谐波族 ${family.map((v) => v.toFixed(1)).join("/")} 内，以实测为准）`,
  };
}

export interface LibraryTrackLike {
  id?: string;
  title?: string;
  bpm?: number;
  bpmLabel?: number;
  bpmMeasured?: number;
  bpmMeasuredStrength?: number;
  bpmMeasuredAt?: string;
  bpmMeasuredSource?: string;
  /** 实测值的谐波族（下游做"剪辑网格族匹配"时用） */
  bpmFamily?: number[];
  /** 标签与实测**不同族**（同族只是记法差异，不算冲突） */
  bpmConflict?: boolean;
  [key: string]: unknown;
}

export interface BpmMeasurementLike {
  bpm: number;
  strength: number;
}

export interface ApplyBpmOptions {
  /** ISO 时间戳（由调用方注入，便于测试与审计） */
  at: string;
  /** 低于该强度视为"测不准"，不写回（默认 0） */
  minStrength?: number;
  /** 已有实测值时是否重算覆盖（默认 false：幂等） */
  force?: boolean;
}

export interface ApplyBpmResult {
  track: LibraryTrackLike;
  changed: boolean;
  skippedReason?: "low-strength" | "already-measured" | "invalid-measurement";
}

/** 把一次实测结果回填到曲库记录（纯函数：不改入参对象）。 */
export function applyBpmMeasurement(
  track: LibraryTrackLike,
  measurement: BpmMeasurementLike,
  options: ApplyBpmOptions,
): ApplyBpmResult {
  const minStrength = options.minStrength ?? 0;
  if (!Number.isFinite(measurement?.bpm) || measurement.bpm <= 0) {
    return { track: { ...track }, changed: false, skippedReason: "invalid-measurement" };
  }
  if (!options.force && typeof track.bpmMeasured === "number" && track.bpmMeasured > 0) {
    return { track: { ...track }, changed: false, skippedReason: "already-measured" };
  }
  if (Number.isFinite(measurement.strength) && measurement.strength < minStrength) {
    return { track: { ...track }, changed: false, skippedReason: "low-strength" };
  }
  const label = typeof track.bpmLabel === "number" ? track.bpmLabel : (Number.isFinite(track.bpm) ? Number(track.bpm) : undefined);
  const reconciled = reconcileBpm(label, measurement.bpm);
  const next: LibraryTrackLike = {
    ...track,
    ...(label === undefined ? {} : { bpmLabel: label }),
    bpm: reconciled.canonical,
    bpmMeasured: Number(measurement.bpm.toFixed(2)),
    bpmMeasuredStrength: Number((Number.isFinite(measurement.strength) ? measurement.strength : 0).toFixed(3)),
    bpmMeasuredAt: options.at,
    bpmMeasuredSource: BPM_BACKFILL_VERSION,
    bpmFamily: reconciled.family.map((value) => Number(value.toFixed(2))),
    bpmConflict: reconciled.conflict,
  };
  return { track: next, changed: true };
}

export interface BpmBackfillSummary {
  measured: number;
  withLabel: number;
  /** 标签与实测**不同族**的条数（真正的数据错误；同族的倍频差不算） */
  conflicts: number;
  shareConflicts: number | null;
  meanAbsDeltaBpm: number | null;
  medianAbsDeltaBpm: number | null;
  maxAbsDeltaBpm: number | null;
  shareOver10Percent: number | null;
  /** 偏差最大的若干条（审计用） */
  worst: Array<{
    id: string; label: number; measured: number; family: number[]; conflict: boolean;
    deltaBpm: number; deltaPercent: number;
  }>;
}

/** 汇总"标签 vs 实测"的偏差（写进回填报告，作为口径依据）。 */
export function summarizeBpmBackfill(tracks: LibraryTrackLike[], worstLimit = 10): BpmBackfillSummary {
  const rows = tracks
    .filter((track) => Number.isFinite(track.bpmLabel) && Number.isFinite(track.bpmMeasured) && Number(track.bpmLabel) > 0)
    .map((track) => {
      const label = Number(track.bpmLabel);
      const measured = Number(track.bpmMeasured);
      /**
       * 偏差口径：同族（倍频/半速/三倍频）按"折算到最近谐波"算，避免把记法差异记成数据错误；
       * 同时单独统计"异族冲突"条数——那才是需要人看一眼的曲目。
       */
      const family = harmonicFamily(measured);
      /**
       * 偏差 = **标签**到"实测值谐波族"里最近成员的距离（不是 measured − label）：
       * 若标签与实测同族（如 60 与 178.57/3=59.52），偏差应≈0；异族时才是真实的量级差。
       */
      const nearest = family.length > 0
        ? family.reduce((best, candidate) => (Math.abs(candidate - label) < Math.abs(best - label) ? candidate : best), family[0]!)
        : measured;
      const deltaBpm = label - nearest;
      return {
        id: String(track.id ?? track.title ?? "?"),
        label,
        measured,
        family,
        conflict: Boolean(track.bpmConflict),
        deltaBpm: Number(deltaBpm.toFixed(2)),
        deltaPercent: Number(((deltaBpm / label) * 100).toFixed(1)),
      };
    });
  if (rows.length === 0) {
    return {
      measured: 0, withLabel: 0, conflicts: 0, shareConflicts: null,
      meanAbsDeltaBpm: null, medianAbsDeltaBpm: null,
      maxAbsDeltaBpm: null, shareOver10Percent: null, worst: [],
    };
  }
  const abs = rows.map((row) => Math.abs(row.deltaBpm)).sort((a, b) => a - b);
  const mean = abs.reduce((sum, value) => sum + value, 0) / abs.length;
  const median = abs.length % 2 === 1 ? abs[(abs.length - 1) / 2]! : (abs[abs.length / 2 - 1]! + abs[abs.length / 2]!) / 2;
  const over10 = rows.filter((row) => Math.abs(row.deltaPercent) > 10).length;
  const conflicts = rows.filter((row) => row.conflict).length;
  return {
    measured: rows.length,
    withLabel: rows.length,
    conflicts,
    shareConflicts: Number((conflicts / rows.length).toFixed(3)),
    meanAbsDeltaBpm: Number(mean.toFixed(2)),
    medianAbsDeltaBpm: Number(median.toFixed(2)),
    maxAbsDeltaBpm: abs[abs.length - 1]!,
    shareOver10Percent: Number((over10 / rows.length).toFixed(3)),
    worst: [...rows].sort((a, b) => Math.abs(b.deltaBpm) - Math.abs(a.deltaBpm)).slice(0, worstLimit),
  };
}
