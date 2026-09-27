import { describe, expect, it } from "vitest";
import {
  applyBpmMeasurement,
  BPM_BACKFILL_VERSION,
  harmonicFamily,
  reconcileBpm,
  summarizeBpmBackfill,
} from "./library-bpm.js";

const AT = "2026-09-27T03:00:00.000Z";

describe("applyBpmMeasurement", () => {
  it("首次回填：写实测 BPM、保留原标签、记录来源与强度", () => {
    const { track, changed } = applyBpmMeasurement(
      { id: "city-beneath", bpm: 120, durationSec: 60 },
      { bpm: 163.04, strength: 0.57 },
      { at: AT },
    );
    expect(changed).toBe(true);
    expect(track.bpm).toBe(163);
    expect(track.bpmLabel).toBe(120);
    expect(track.bpmMeasured).toBe(163.04);
    expect(track.bpmMeasuredStrength).toBe(0.57);
    expect(track.bpmMeasuredSource).toBe(BPM_BACKFILL_VERSION);
    expect(track.bpmMeasuredAt).toBe(AT);
  });

  it("二次回填幂等：已有实测值时不动（除非 force）", () => {
    const existing = { id: "x", bpm: 163, bpmLabel: 120, bpmMeasured: 163.04, bpmMeasuredAt: "old" };
    const skipped = applyBpmMeasurement(existing, { bpm: 100, strength: 0.9 }, { at: AT });
    expect(skipped.changed).toBe(false);
    expect(skipped.skippedReason).toBe("already-measured");
    expect(skipped.track.bpmMeasured).toBe(163.04);
    const forced = applyBpmMeasurement(existing, { bpm: 100, strength: 0.9 }, { at: AT, force: true });
    expect(forced.changed).toBe(true);
    expect(forced.track.bpm).toBe(100);
    /** 标签只写一次：force 重算也不能把"实测值"当标签覆盖掉 */
    expect(forced.track.bpmLabel).toBe(120);
  });

  it("强度不足 / 测量非法：如实跳过，不硬写", () => {
    const weak = applyBpmMeasurement({ id: "ambient", bpm: 60 }, { bpm: 68.2, strength: 0.04 }, { at: AT, minStrength: 0.1 });
    expect(weak.changed).toBe(false);
    expect(weak.skippedReason).toBe("low-strength");
    const invalid = applyBpmMeasurement({ id: "bad", bpm: 60 }, { bpm: 0, strength: 0.5 }, { at: AT });
    expect(invalid.changed).toBe(false);
    expect(invalid.skippedReason).toBe("invalid-measurement");
  });

  it("不改入参对象（纯函数）", () => {
    const input = { id: "x", bpm: 120 };
    applyBpmMeasurement(input, { bpm: 163.04, strength: 0.5 }, { at: AT });
    expect(input.bpm).toBe(120);
    expect("bpmMeasured" in input).toBe(false);
  });
});

describe("summarizeBpmBackfill", () => {
  it("偏差按**谐波族**折算（同族记法差异不算冲突），并单列异族冲突条数", () => {
    const summary = summarizeBpmBackfill([
      { id: "a", bpmLabel: 120, bpmMeasured: 163.04, bpmConflict: false },
      { id: "b", bpmLabel: 120, bpmMeasured: 105.63, bpmConflict: false },
      { id: "c", bpmLabel: 96, bpmMeasured: 170.45, bpmConflict: true },
      { id: "d", bpmLabel: 120, bpmMeasured: 174.42, bpmConflict: false },
    ]);
    expect(summary.measured).toBe(4);
    /** 偏差 = 标签到"实测谐波族"最近成员的距离；族内记法差异（如 120 vs 174.42 的 3/2=116.28）只剩个位数 */
    expect(summary.maxAbsDeltaBpm).toBeLessThan(15);
    expect(summary.meanAbsDeltaBpm).toBeLessThan(15);
    expect(summary.conflicts).toBe(1);
    expect(summary.shareConflicts).toBeCloseTo(0.25, 3);
    /** worst 按 |偏差| 降序，且携带族与冲突标记（审计要能看出"是记法差异还是真错"） */
    const deltas = summary.worst.map((row) => Math.abs(row.deltaBpm));
    expect([...deltas].sort((a, b) => b - a)).toEqual(deltas);
    expect(summary.worst.every((row) => Array.isArray(row.family) && typeof row.conflict === "boolean")).toBe(true);
  });

  it("没有可配对的记录时如实返回空汇总（不编数）", () => {
    const summary = summarizeBpmBackfill([{ id: "a", bpm: 120 }]);
    expect(summary.measured).toBe(0);
    expect(summary.meanAbsDeltaBpm).toBeNull();
    expect(summary.worst).toEqual([]);
  });
});

describe("谐波族对账（倍频歧义不是数据错误）", () => {
  it("harmonicFamily 覆盖 1/3、1/2、2/3、1×、3/2、2×、3×", () => {
    expect(harmonicFamily(120)).toEqual([40, 60, 80, 120, 180, 240, 360]);
    expect(harmonicFamily(174.42).map((v) => Number(v.toFixed(2)))).toEqual([58.14, 87.21, 116.28, 174.42, 261.63, 348.84]);
  });

  it("真机形态：标签 120 / 实测 79.79（≈2/3，附点记法）→ 同族，不判冲突", () => {
    const result = reconcileBpm(120, 79.79);
    expect(result.conflict).toBe(false);
    expect(result.canonical).toBe(120);
  });

  it("真机形态：标签 60 / 实测 174.42 → 同族，保留标签且不判冲突", () => {
    const result = reconcileBpm(60, 174.42);
    expect(result.conflict).toBe(false);
    expect(result.canonical).toBe(60);
    expect(result.reason).toMatch(/同族/);
  });

  it("真机形态：标签 96 / 实测 170.45 → 异族，以实测为准并标冲突", () => {
    const result = reconcileBpm(96, 170.45);
    expect(result.conflict).toBe(true);
    expect(result.canonical).toBe(170);
    expect(result.reason).toMatch(/冲突/);
  });

  it("回填记录带 bpmFamily / bpmConflict，供下游网格匹配与审计", () => {
    const { track } = applyBpmMeasurement({ id: "x", bpm: 60 }, { bpm: 174.42, strength: 0.5 }, { at: AT });
    expect(track.bpm).toBe(60);
    expect(track.bpmConflict).toBe(false);
    expect(track.bpmFamily).toEqual([58.14, 87.21, 116.28, 174.42, 261.63, 348.84]);
  });
});
