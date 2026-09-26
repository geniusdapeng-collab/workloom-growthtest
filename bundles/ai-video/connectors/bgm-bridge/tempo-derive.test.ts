/**
 * 剪辑点反推 BPM 的**聚类投票**口径（T-2026-0926-0007 真机缺陷修复）。
 *
 * 事故：VID-GR01 的配乐环节连续被监制打回。根因是 `deriveTempoFromCuts` 只挑"离基准 BPM 最近"的
 * 单个候选——调用方没传 `--bgm-bpm` 时基准落到默认 100，5.00s 间距反推 96、被转场偏移的 4.82s
 * 反推 99.6、4.50s 反推 106.7，"离 100 最近的 99.6"胜出；而 99.6BPM 的网格对不上自己的剪辑点，
 * 工位自判 `unaligned`（7/17 命中、平均 122ms）。
 *
 * 现在改为"±2BPM 聚类取票数最高"，个别被偏移的间隔不会带偏整体 BPM。
 */
import { describe, expect, it } from "vitest";

import { alignBeatGrid, deriveTempoFromCuts } from "./core.mjs";

describe("deriveTempoFromCuts（聚类投票口径）", () => {
  it("真机复现：4×转场偏移 + 4.5/5/5.5s 混合网格 → 不再被个别间隔带偏（基准 120）", () => {
    const cuts = [
      5, 10, 15, 20, 25, 29.82, 34.82, 39.32, 44.32, 49.14, 54.14, 59.14, 64.64, 68.96, 73.46, 78.46, 83.28
    ].map((at) => ({ at }));
    const derived = deriveTempoFromCuts({ cuts, baseBpm: 120 });
    expect(derived.source).toBe("cut-driven");
    // 反向断言旧口径：单个被偏移的 4.82s 间距会把 BPM 拉到 99.6 附近
    expect(derived.bpm).toBeGreaterThan(115);
    expect(derived.bpm).toBeLessThan(125);
    expect(derived.voteTotal).toBeGreaterThanOrEqual(derived.votes ?? 1);
  });

  it("同类修复：基准缺省（100）时也不至于选出一个对不上自己剪辑点的 BPM", () => {
    const cuts = [5, 10, 15, 20, 25, 29.82, 34.82, 39.32, 44.32].map((at) => ({ at }));
    const derived = deriveTempoFromCuts({ cuts, baseBpm: 100 });
    const grid = alignBeatGrid({ bpm: derived.bpm, cuts });
    // 与旧实现（122ms / 7-8 命中）相比：至少不能仍落在"平均误差 >120ms"的档位
    expect(grid.meanAbsErrorMs ?? 0).toBeLessThan(120);
  });

  it("规整网格（每 5s 硬切 = 10 拍 @120BPM）→ 精确反推 120", () => {
    const cuts = [5, 10, 15, 20, 25, 30, 35, 40].map((at) => ({ at }));
    const derived = deriveTempoFromCuts({ cuts, baseBpm: 120 });
    expect(Math.abs(derived.bpm - 120)).toBeLessThan(1);
    const grid = alignBeatGrid({ bpm: derived.bpm, cuts });
    expect(grid.verdict).toBe("aligned");
    expect(grid.meanAbsErrorMs).toBeLessThan(5);
  });

  it("无剪辑点 → 沿用配方 BPM 并如实说明（不凭空造值）", () => {
    const derived = deriveTempoFromCuts({ cuts: [], baseBpm: 120 });
    expect(derived.bpm).toBe(120);
    expect(derived.source).toBe("recipe");
    expect(String(derived.note)).toContain("无法反推");
  });
});
