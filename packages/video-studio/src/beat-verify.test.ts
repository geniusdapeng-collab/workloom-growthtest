import { describe, expect, it } from "vitest";
import { beatGridReport, measureBpm } from "./beat-verify.js";

const SR = 16000;

/** 合成"鼓点"信号：每拍一个短促衰减噪声脉冲。 */
function clickTrack(bpm: number, seconds: number, offsetSec = 0): Float32Array {
  const n = Math.round(seconds * SR);
  const out = new Float32Array(n);
  const period = 60 / bpm;
  let state = 12345;
  for (let beat = 0; ; beat += 1) {
    const start = Math.round((offsetSec + beat * period) * SR);
    if (start >= n) break;
    for (let i = 0; i < Math.round(0.06 * SR); i += 1) {
      const index = start + i;
      if (index >= n) break;
      state = (state * 1103515245 + 12345) % 2147483648;
      const noise = state / 2147483648 - 0.5;
      const envelope = Math.exp(-i / (0.012 * SR));
      out[index] = (out[index] ?? 0) + 0.8 * noise * envelope;
    }
  }
  return out;
}

describe("measureBpm", () => {
  it("120BPM 的鼓点 → 实测落在 120（或它的倍速族内）", () => {
    const measured = measureBpm(clickTrack(120, 20), SR);
    expect(measured.family.some((value) => Math.abs(value - 120) < 3)).toBe(true);
    expect(measured.strength).toBeGreaterThan(0);
  });

  it("90BPM 的鼓点 → 实测落在 90（或它的倍速族内）", () => {
    const measured = measureBpm(clickTrack(90, 24), SR);
    expect(measured.family.some((value) => Math.abs(value - 90) < 4)).toBe(true);
  });

  it("时长过短 → 返回 0（不硬猜）", () => {
    const measured = measureBpm(clickTrack(120, 1), SR);
    expect(measured.bpm).toBe(0);
    expect(measured.family).toEqual([]);
  });
});

describe("beatGridReport", () => {
  it("剪辑点正好落在拍上 → 误差 0 且放行", () => {
    const cuts = [0.5, 2.5, 4.5, 6.5, 8.5];
    const report = beatGridReport(120, cuts);
    expect(report.maxErrorMs).toBeLessThan(1);
    expect(report.ok).toBe(true);
  });

  it("剪辑点整体偏 100ms → 判不通过（真机 123ms 卡点误差的场景）", () => {
    /** 注意：整体错"半拍"在 120/240 网格族里其实仍落在拍上，所以要用**非网格族**的偏移来建模 */
    const cuts = [0.5, 2.5, 4.5, 6.5].map((t) => Number((t + 0.1).toFixed(3)));
    const report = beatGridReport(120, cuts);
    expect(report.ok).toBe(false);
    expect(report.meanErrorMs).toBeGreaterThan(80);
    expect(report.detail).toMatch(/剪辑点距最近一拍/);
  });

  it("倍速歧义：实测 60BPM 也能对上 120 网格（取同族最优）", () => {
    const cuts = [0.5, 1.5, 2.5, 3.5];
    const report = beatGridReport(60, cuts);
    expect(report.ok).toBe(true);
    expect(report.matchedBpm).toBeGreaterThanOrEqual(60);
  });

  it("缺 BPM 或剪辑点 → 判不通过并说明原因", () => {
    expect(beatGridReport(0, [1, 2]).ok).toBe(false);
    expect(beatGridReport(120, []).ok).toBe(false);
  });
});
