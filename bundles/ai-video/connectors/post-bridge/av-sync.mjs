/**
 * 音画对齐（平台侧 · 交付包内自带实现，2026-09-26 真机事故 T-2026-0924-0001 沉淀）
 *
 * 事故：逐段 mp4 的 aac 音轨按 1024 样点成帧、末帧向上取整 → 每段音轨比画面长 0–21ms；
 * `-f concat -c copy` 让 demuxer 按**各自流的时长**累计偏移 → 声音相对画面逐镜漂移
 * （真机：15 镜尾镜 +125ms，听感就是"上一镜的音效串到下一镜"）。
 *
 * 本文件是**交付包内的自洽实现**（bundles 是独立分发单元，不能 import 基座 TS 包）：
 *   · `buildSampleAccurateConcatPlan()` —— 拼接参数生成：画面 `-c:v copy`、声音走 concat 滤镜；
 *   · `crossCorrelationLag()` / `evaluateAvSync()` —— 拼完逐镜实测偏移与累计漂移；
 *   · `verifyAssembledAvSync()` —— 对产物做整轨解码 + 互相关，超阈值即抛错（不许静默出厂）。
 *
 * 与基座 `packages/video-studio/src/av-sync.ts` 的**判据保持一致**（同阈值、同单调漂移特征），
 * 并由 `packages/base/bundles/post-av-sync.test.ts` 做等价性回归，避免两侧口径漂移。
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/** 与 packages/video-studio/src/av-sync.ts#AV_SYNC_POLICY 同口径 */
export const AV_SYNC_POLICY = {
  maxAbsLagMs: 40,
  maxDriftMs: 30,
  minCorrelation: 0.25,
  minMeasurable: 3,
  monotonicRatio: 0.6,
};

export const AV_SYNC_SAMPLE_RATE = 16000;

/**
 * 实测不可执行（**不是**"没偏移"，是"测不了"）的显式口径。
 *
 * 为什么要单列这一类：真机上出现过"环境缺能力 → 检查静默跳过 → 当成通过"的事故族。
 * 因此这里把结果分成三种，任何一种都不会被当成"通过"：
 *   · `ok: true`             —— 真测过且达标；
 *   · `ok: false, kind: "drift"`        —— 测到了偏移（真实缺陷，**永不降级**）；
 *   · `ok: false, kind: "unverifiable"` —— 测不了（缺 ffmpeg/解码失败/窗口不足）。
 * 后者的处置交给调用方显式选择：默认**阻断**（抛 `av_sync_unverifiable`）；
 * 只有在 `allowUnverified: true`（调用方显式声明"这一环境确实无法实测"）时才降级放行，
 * 且必须写报告文件 + 在返回值里带 `degraded: true`，让下游/审计看得见。
 */
export const AV_SYNC_FAILURE_KINDS = Object.freeze({ drift: "drift", unverifiable: "unverifiable" });

/**
 * 归一化互相关求时延（正数 = target 落后于 ref）。
 * 与基座 TS 版逐行同口径：同一滞后范围、同一重叠窗口能量归一。
 */
export function crossCorrelationLag(ref, target, { sampleRate, maxLagMs }) {
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
      sumRef += ref[startRef + i];
      sumTarget += target[startTarget + i];
    }
    const meanRef = sumRef / length;
    const meanTarget = sumTarget / length;
    let dot = 0;
    let energyRef = 0;
    let energyTarget = 0;
    for (let i = 0; i < length; i += 1) {
      const a = ref[startRef + i] - meanRef;
      const b = target[startTarget + i] - meanTarget;
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

/** 汇总判定：逐镜偏移 + 全片漂移 + 单调漂移特征（分段拼接时长不守恒的指纹）。 */
export function evaluateAvSync(samples, policy = AV_SYNC_POLICY) {
  const violations = [];
  const warnings = [];
  if (!Array.isArray(samples) || samples.length === 0) {
    return {
      ok: false, violations: ["没有任何可测窗口（未提供取样）"], warnings,
      measured: 0, skipped: [], maxAbsLagMs: 0, driftMs: null, monotonic: false, samples: [],
    };
  }
  const ordered = [...samples].sort((a, b) => a.index - b.index);
  const measurable = ordered.filter((sample) => sample.correlation >= policy.minCorrelation);
  const skipped = ordered.filter((sample) => sample.correlation < policy.minCorrelation).map((s) => s.shotId);
  if (skipped.length > 0) warnings.push(`${skipped.length} 个窗口不可测（相关性 < ${policy.minCorrelation}）：${skipped.join("、")}`);
  if (measurable.length < policy.minMeasurable) {
    violations.push(`可测窗口不足：${measurable.length} < ${policy.minMeasurable}（无法证明音画对齐，按失败处理）`);
  }
  const maxAbsLagMs = measurable.reduce((max, sample) => Math.max(max, Math.abs(sample.lagMs)), 0);
  const worst = measurable.find((sample) => Math.abs(sample.lagMs) === maxAbsLagMs) ?? null;
  if (maxAbsLagMs > policy.maxAbsLagMs) {
    violations.push(`单镜偏移超阈值：${worst?.shotId ?? "?"} ${worst?.lagMs?.toFixed?.(1) ?? "?"}ms（上限 ${policy.maxAbsLagMs}ms）`);
  }
  let driftMs = null;
  let monotonic = false;
  if (measurable.length >= 2) {
    const first = measurable[0];
    const last = measurable[measurable.length - 1];
    driftMs = last.lagMs - first.lagMs;
    if (Math.abs(driftMs) > policy.maxDriftMs) {
      violations.push(`全片累计漂移 ${driftMs.toFixed(1)}ms（首镜 ${first.lagMs.toFixed(1)}ms → 末镜 ${last.lagMs.toFixed(1)}ms，上限 ${policy.maxDriftMs}ms）`);
    }
    const deltas = [];
    for (let i = 1; i < measurable.length; i += 1) deltas.push(measurable[i].lagMs - measurable[i - 1].lagMs);
    const positives = deltas.filter((value) => value > 0).length;
    const negatives = deltas.filter((value) => value < 0).length;
    const dominant = Math.max(positives, negatives);
    monotonic = deltas.length > 0 && dominant / deltas.length >= policy.monotonicRatio;
    if (monotonic && Math.abs(driftMs) > policy.maxDriftMs / 2) {
      violations.push(
        `单调漂移：${dominant}/${deltas.length} 段偏移同向且累计 ${driftMs.toFixed(1)}ms —— `
        + "典型成因是分段拼接时长不守恒（aac 逐段比画面短，concat 逐流累计）",
      );
    }
  }
  return {
    ok: violations.length === 0, violations, warnings,
    measured: measurable.length, skipped,
    maxAbsLagMs: Number(maxAbsLagMs.toFixed(1)),
    driftMs: driftMs === null ? null : Number(driftMs.toFixed(1)),
    monotonic, samples: ordered,
  };
}

/**
 * 拼接方案（样点级对齐）：
 *   ① 画面：concat demuxer `-c:v copy`（帧级无损，不重编码）；
 *   ② 声音：`concat` 滤镜按顺序接（样点级），每段先按**画面时长** atrim+apad 到精确长度；
 *   ③ 合流：`-c:v copy` + `-c:a aac` + `-shortest`。
 * 返回三段命令的参数（不执行 ffmpeg），便于测试与审计。
 */
export function buildSampleAccurateConcatPlan({ listFile, clips, output, workDir, fps = 30, sampleRate = 48000 }) {
  const videoOnly = `${workDir}/video-only.mp4`;
  const voiceWav = `${workDir}/voice.wav`;
  const concatList = [
    "ffconcat version 1.0",
    ...clips.flatMap((clip) => {
      const seconds = Number(clip.durationSec);
      if (!Number.isFinite(seconds) || seconds <= 0) {
        throw new Error("每个拼接片段需要实测视频轨时长");
      }
      return [
        `file '${clip.path.replaceAll("'", "'\\''")}'`,
        `duration ${seconds.toFixed(6)}`,
      ];
    }),
  ].join("\n") + "\n";
  const filters = [];
  const labels = [];
  clips.forEach((clip, index) => {
    const seconds = Number(clip.durationSec ?? 0) > 0
      ? Number(clip.durationSec)
      : (Number(clip.frames ?? 0) > 0 ? Number(clip.frames) / fps : null);
    labels.push(`[aex${index}]`);
    if (seconds && seconds > 0) {
      filters.push(
        `[${index}:a]atrim=end=${seconds.toFixed(6)},asetpts=N/SR/TB,apad=whole_dur=${seconds.toFixed(6)}[aex${index}]`,
      );
    } else {
      filters.push(`[${index}:a]anull[aex${index}]`);
    }
  });
  filters.push(`${labels.join("")}concat=n=${clips.length}:v=0:a=1[aout]`);
  return {
    videoOnly,
    voiceWav,
    concatList,
    videoArgs: ["-hide_banner", "-v", "error", "-y", "-f", "concat", "-safe", "0", "-i", listFile, "-c:v", "copy", "-an", videoOnly],
    audioArgs: [
      "-hide_banner", "-v", "error", "-y",
      ...clips.flatMap((clip) => ["-i", clip.path]),
      "-filter_complex", filters.join(";"),
      "-map", "[aout]", "-c:a", "pcm_s16le", "-ar", String(sampleRate), "-ac", "2", voiceWav,
    ],
    muxArgs: [
      "-hide_banner", "-v", "error", "-y", "-i", videoOnly, "-i", voiceWav,
      "-map", "0:v:0", "-map", "1:a:0",
      "-c:v", "copy", "-c:a", "aac", "-b:a", "192k", "-ar", String(sampleRate), "-ac", "2",
      "-shortest", "-movflags", "+faststart", output,
    ],
  };
}

/** 整轨解码为 Float32 单声道（16k）：不做局部 seek——aac 帧对齐会让 seek 自带 0–21ms 量化误差。 */
export async function decodePcm16k(ffmpeg, file) {
  const { stdout } = await execFileAsync(ffmpeg, [
    "-v", "error", "-i", file, "-vn", "-ac", "1", "-ar", String(AV_SYNC_SAMPLE_RATE),
    "-f", "f32le", "-",
  ], { encoding: "buffer", maxBuffer: 256 * 1024 * 1024 });
  const view = new Float32Array(stdout.buffer, stdout.byteOffset, Math.floor(stdout.byteLength / 4));
  return view.slice();
}

/**
 * 拼完实测：逐镜取窗口与源片段做互相关，返回报告（不抛错）。
 * 窗口取 `0.12×时长` 起、最长 1.5s；搜索范围 ±300ms。
 */
export async function measureAssembledAvSync({ ffmpeg, output, clips, starts, policy = AV_SYNC_POLICY }) {
  /**
   * 实测不可执行时**不抛错**，而是返回 `unverifiable` 报告（交由调用方决定阻断还是显式降级）：
   * 缺 ffmpeg、产物不可解码、可测窗口不足都属于这一类；真实测到偏移则仍是 `drift`。
   */
  let master;
  try {
    master = await decodePcm16k(ffmpeg, output);
  } catch (error) {
    return {
      ok: false,
      kind: AV_SYNC_FAILURE_KINDS.unverifiable,
      reason: `解码母版失败：${error instanceof Error ? error.message.slice(0, 200) : String(error)}`,
      violations: [], warnings: [], measured: 0, skipped: [], maxAbsLagMs: 0, driftMs: null,
      monotonic: false, samples: [],
    };
  }
  const searchSamples = Math.round((300 / 1000) * AV_SYNC_SAMPLE_RATE);
  const samples = [];
  for (let index = 0; index < clips.length; index += 1) {
    const clip = clips[index];
    const duration = Number(clip.durationSec ?? 0);
    if (!(duration > 0)) continue;
    const winStart = Math.min(0.35, Math.max(0.05, duration * 0.12));
    const winLen = Math.min(1.5, Math.max(0.5, duration - winStart - 0.25));
    if (winLen < 0.4) continue;
    let segment;
    try {
      segment = await decodePcm16k(ffmpeg, clip.path);
    } catch {
      /** 单镜片段不可解码 = 该窗口不可测（计入 skipped），不影响其它窗口 */
      continue;
    }
    const refStart = Math.round(winStart * AV_SYNC_SAMPLE_RATE);
    const refLen = Math.round(winLen * AV_SYNC_SAMPLE_RATE);
    if (refStart + refLen > segment.length) continue;
    const ref = segment.subarray(refStart, refStart + refLen);
    const expected = Math.round((Number(starts[index] ?? 0) + winStart) * AV_SYNC_SAMPLE_RATE);
    const targetStart = Math.max(0, expected - searchSamples);
    const targetEnd = Math.min(master.length, expected + refLen + searchSamples);
    const target = master.subarray(targetStart, targetEnd);
    if (target.length < refLen + 32) continue;
    const measured = crossCorrelationLag(ref, target, { sampleRate: AV_SYNC_SAMPLE_RATE, maxLagMs: 300 });
    const trueLagMs = measured.lagMs - ((expected - targetStart) / AV_SYNC_SAMPLE_RATE) * 1000;
    samples.push({
      shotId: clip.shotId ?? `#${index + 1}`,
      index,
      lagMs: Number(trueLagMs.toFixed(2)),
      correlation: Number(measured.correlation.toFixed(3)),
    });
  }
  const report = evaluateAvSync(samples, policy);
  const kind = classifyAvSyncFailure(report);
  return kind ? { ...report, kind } : report;
}

/**
 * 判定归因（纯函数，可单测）：只有"真实测到偏移"才算 `drift`；
 * "没有可测窗口/测不够"归为 `unverifiable`。两者的处置不同——**drift 永不降级**，
 * unverifiable 才允许在调用方显式声明后降级（并留报告）。
 */
export function classifyAvSyncFailure(report) {
  if (!report || report.ok) return null;
  if (!Array.isArray(report.samples) || report.samples.length === 0) return AV_SYNC_FAILURE_KINDS.unverifiable;
  return report.violations?.some((line) => /单镜偏移|累计漂移|单调漂移/.test(String(line)))
    ? AV_SYNC_FAILURE_KINDS.drift
    : AV_SYNC_FAILURE_KINDS.unverifiable;
}

/**
 * 实测 + 断言。
 * 默认（`allowUnverified: false`）：偏移与"测不了"都抛错，但错误码区分
 *   `av_sync_failed`（测到偏移）/ `av_sync_unverifiable`（测不了）。
 * `allowUnverified: true`：仅对"测不了"降级——返回 `{ ok: null, degraded: true, reason }`，
 * 调用方必须把 `degraded` 写进产物回执（**不静默**）；测到偏移仍然抛错。
 */
export async function verifyAssembledAvSync(options) {
  const { allowUnverified = false, ...measureOptions } = options;
  const report = await measureAssembledAvSync(options);
  if (report.ok) return report;
  if (report.kind === AV_SYNC_FAILURE_KINDS.unverifiable && allowUnverified) {
    return {
      ok: null,
      degraded: true,
      kind: AV_SYNC_FAILURE_KINDS.unverifiable,
      reason: report.reason ?? report.violations.join("；") ?? "实测不可执行",
      report,
    };
  }
  const error = new Error(
    report.kind === AV_SYNC_FAILURE_KINDS.unverifiable
      ? `音画对齐无法实测：${report.reason ?? report.violations.join("；")}`
      : `音画对齐实测不通过：${report.violations.join("；")}`,
  );
  error.code = report.kind === AV_SYNC_FAILURE_KINDS.unverifiable ? "av_sync_unverifiable" : "av_sync_failed";
  error.report = report;
  throw error;
}
