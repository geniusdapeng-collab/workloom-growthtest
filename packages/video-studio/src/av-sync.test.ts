import { describe, expect, it } from "vitest";
import {
  AV_SYNC_POLICY,
  avSyncPolicyForClipCount,
  buildCutAudioStep,
  candidateSyncWindows,
  crossCorrelationLag,
  describeAvSync,
  evaluateAvSync,
  verifyAvSyncEvidence,
  type AvSyncSample,
} from "./av-sync.js";

const SR = 16000;

/** 合成一段"有声信号"：低频脉冲 + 噪声，便于互相关定位。 */
function signal(seconds: number, seed = 7): Float32Array {
  const n = Math.round(seconds * SR);
  const out = new Float32Array(n);
  let state = seed;
  for (let i = 0; i < n; i += 1) {
    state = (state * 1103515245 + 12345) % 2147483648;
    const noise = state / 2147483648 - 0.5;
    const pulse = Math.sin((2 * Math.PI * 3 * i) / SR) * Math.sin((2 * Math.PI * 0.7 * i) / SR);
    out[i] = 0.6 * pulse + 0.4 * noise;
  }
  return out;
}

/** 按样本数平移（正数 = 整体后移）。 */
function shift(x: Float32Array, samples: number): Float32Array {
  const out = new Float32Array(x.length);
  for (let i = 0; i < x.length; i += 1) {
    const src = i - samples;
    out[i] = src >= 0 && src < x.length ? x[src]! : 0;
  }
  return out;
}

describe("crossCorrelationLag", () => {
  it("零偏移时给出 0ms 且相关性接近 1", () => {
    const ref = signal(1.5);
    const { lagMs, correlation } = crossCorrelationLag(ref, ref, { sampleRate: SR, maxLagMs: 200 });
    expect(Math.abs(lagMs)).toBeLessThanOrEqual(0.1);
    expect(correlation).toBeGreaterThan(0.99);
  });

  it("整体后移 80 个样点 → 识别为 +5ms", () => {
    const ref = signal(1.5);
    const { lagMs, correlation } = crossCorrelationLag(ref, shift(ref, 80), { sampleRate: SR, maxLagMs: 200 });
    expect(lagMs).toBeCloseTo(5, 0);
    expect(correlation).toBeGreaterThan(0.9);
  });
});

describe("evaluateAvSync", () => {
  const mk = (index: number, lagMs: number, correlation = 0.9): AvSyncSample => ({
    shotId: `NC-${String(index + 1).padStart(2, "0")}`,
    index,
    lagMs,
    correlation,
  });

  it("全部对齐 → ok", () => {
    const report = evaluateAvSync([0, 1, 2, 3, 4].map((i) => mk(i, 0.0)));
    expect(report.ok).toBe(true);
    expect(report.violations).toEqual([]);
    expect(report.driftMs).toBe(0);
  });

  it("复现真机事故：逐镜 +8ms 累计漂移（尾镜 +112ms）必须被拦下", () => {
    const samples = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14].map((i) => mk(i, i * 8));
    const report = evaluateAvSync(samples);
    expect(report.ok).toBe(false);
    expect(report.maxAbsLagMs).toBeGreaterThan(AV_SYNC_POLICY.maxAbsLagMs);
    expect(report.monotonic).toBe(true);
    expect(report.violations.join("｜")).toMatch(/累计漂移|单调漂移/);
    expect(describeAvSync(report)).toMatch(/FAIL/);
  });

  it("单镜把声音落到下一镜（+1.2s 级别的偏移按超阈值处理）", () => {
    const samples = [mk(0, 0), mk(1, 0), mk(2, 1200, 0.8), mk(3, 0)];
    const report = evaluateAvSync(samples);
    expect(report.ok).toBe(false);
    expect(report.violations.join("｜")).toMatch(/单镜偏移超阈值/);
  });

  it("静音窗口不可测 → 跳过并给告警；可测不足则判失败", () => {
    const samples = [mk(0, 0), mk(1, 0.1, 0.02), mk(2, 0, 0.01), mk(3, 0.2, 0.03)];
    const report = evaluateAvSync(samples);
    expect(report.ok).toBe(false);
    expect(report.skipped).toHaveLength(3);
    expect(report.warnings.join("｜")).toMatch(/不可测/);
    expect(report.violations.join("｜")).toMatch(/可测窗口不足/);
  });

  it("无取样 → 直接失败（不允许「没测就当过」）", () => {
    const report = evaluateAvSync([]);
    expect(report.ok).toBe(false);
    expect(report.violations[0]).toMatch(/没有任何可测窗口/);
  });
});

describe("verifyAvSyncEvidence", () => {
  const output = "/work/post/uhd/master-raw.mp4";
  const outputSha256 = "a".repeat(64);
  const samples: AvSyncSample[] = [0, 1, 2].map((index) => ({ shotId: `S-${index + 1}`, index, lagMs: 0, correlation: 0.9 }));
  const report = () => ({ ...evaluateAvSync(samples), output, outputSha256, clipCount: 3, policy: AV_SYNC_POLICY });
  const expected = { output, outputSha256, clipCount: 3 };

  it("当前 raw SHA、镜数、逐镜样本与现行判据一致才放行", () => {
    expect(verifyAvSyncEvidence(report(), expected).ok).toBe(true);
    expect(verifyAvSyncEvidence(report(), { ...expected, outputSha256: "b".repeat(64) }).ok).toBe(false);
    expect(verifyAvSyncEvidence(report(), { ...expected, clipCount: 4 }).ok).toBe(false);
    expect(verifyAvSyncEvidence({ ...report(), samples: samples.slice(1) }, expected).ok).toBe(false);
    expect(verifyAvSyncEvidence({ ...report(), ok: false }, expected).ok).toBe(false);
  });

  it("两镜片采用两镜可测策略，仍须两镜都实测", () => {
    const two = samples.slice(0, 2);
    const short = { ...evaluateAvSync(two, avSyncPolicyForClipCount(2)), output, outputSha256,
      clipCount: 2, policy: avSyncPolicyForClipCount(2) };
    expect(verifyAvSyncEvidence(short, { ...expected, clipCount: 2 }).ok).toBe(true);
    expect(verifyAvSyncEvidence({ ...short, samples: two.slice(0, 1) }, { ...expected, clipCount: 2 }).ok).toBe(false);
  });

  it("未测偏移不准借显式放行；已测超阈值必须显式声明", () => {
    const driftSamples = samples.map((sample, index) => ({ ...sample, lagMs: index * 40 }));
    const measured = { ...evaluateAvSync(driftSamples), samples: driftSamples, output, outputSha256, clipCount: 3, policy: AV_SYNC_POLICY };
    expect(measured.ok).toBe(false);
    expect(verifyAvSyncEvidence(measured, expected).ok).toBe(false);
    expect(verifyAvSyncEvidence(measured, { ...expected, allowMeasuredDrift: true }).ok).toBe(true);
    const unmeasured = { ...evaluateAvSync(samples.map((sample) => ({ ...sample, correlation: 0 }))), output, outputSha256, clipCount: 3, policy: AV_SYNC_POLICY };
    expect(verifyAvSyncEvidence(unmeasured, { ...expected, allowMeasuredDrift: true }).ok).toBe(false);
  });
});

describe("buildCutAudioStep", () => {
  /**
   * 2026-09-27 真机事故回归：硬切口曾用 `acrossfade=d=0.01` 凑数，
   * 每刀吃掉 10ms 音频（18 镜 14 刀 → 音轨比画面短 294ms、尾镜 -132.9ms 单调漂移），
   * 被 compose 的 av-sync 硬闸判红。硬切口必须走 `concat`，长度守恒。
   */
  it("硬切口走 concat（长度守恒），不得出现 0.01s 的 acrossfade", () => {
    const step = buildCutAudioStep({ prevLabel: "[aex0]", nextLabel: "[aex1]", outLabel: "[a1]", overlapSec: 0 });
    expect(step).toBe("[aex0][aex1]concat=n=2:v=0:a=1[a1]");
    expect(step).not.toMatch(/acrossfade/);
    expect(step).not.toMatch(/0\.01/);
  });

  it("转场口按真实转场时长 acrossfade（不接受最小交叉兜底）", () => {
    const step = buildCutAudioStep({ prevLabel: "[a2]", nextLabel: "[aex3]", outLabel: "[a3]", overlapSec: 0.18 });
    expect(step).toBe("[a2][aex3]acrossfade=d=0.180000:c1=tri:c2=tri[a3]");
    expect(step).not.toMatch(/concat/);
  });

  it("极短转场（如 0.01s）也按声明时长如实生成，而不是被静默替换成硬切", () => {
    const step = buildCutAudioStep({ prevLabel: "[a4]", nextLabel: "[aex5]", outLabel: "[a5]", overlapSec: 0.01 });
    expect(step).toBe("[a4][aex5]acrossfade=d=0.010000:c1=tri:c2=tri[a5]");
  });
});

describe("candidateSyncWindows", () => {
  /**
   * 2026-09-27 真机回归：单窗口实测会在停顿/环境声上锁到假峰（GR-06 报 -573.6ms），
   * 同一素材整段包络互相关却正好落在期望位置。改为多候选窗口取相关性最高者。
   */
  it("5s 镜头给出多个候选窗口，起点递增且都落在镜头内", () => {
    const windows = candidateSyncWindows({ durationSec: 5 });
    expect(windows.length).toBeGreaterThanOrEqual(3);
    expect(windows[0]).toEqual({ startSec: 0.35, lengthSec: 1.5 });
    const starts = windows.map((w) => w.startSec);
    expect([...starts].sort((a, b) => a - b)).toEqual(starts);
    for (const w of windows) {
      expect(w.startSec).toBeGreaterThanOrEqual(0);
      expect(w.startSec + w.lengthSec).toBeLessThanOrEqual(5 + 1e-6);
      expect(w.lengthSec).toBe(1.5);
    }
  });

  it("短镜（1s）只给一个窗口；过短（0.5s）直接不给窗口（按不可测处理）", () => {
    const one = candidateSyncWindows({ durationSec: 1 });
    expect(one).toHaveLength(1);
    expect(one[0]!.startSec).toBe(0.12);
    expect(one[0]!.lengthSec).toBe(0.63);
    expect(candidateSyncWindows({ durationSec: 0.5 })).toHaveLength(0);
  });

  it("候选数受 maxWindows 约束（避免长镜无谓放大计算量）", () => {
    const windows = candidateSyncWindows({ durationSec: 5, maxWindows: 2 });
    expect(windows.length).toBeLessThanOrEqual(3);
    expect(windows[0]!.startSec).toBe(0.35);
  });
});
