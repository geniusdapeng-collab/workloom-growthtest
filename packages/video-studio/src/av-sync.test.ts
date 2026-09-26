import { describe, expect, it } from "vitest";
import {
  AV_SYNC_POLICY,
  crossCorrelationLag,
  describeAvSync,
  evaluateAvSync,
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
