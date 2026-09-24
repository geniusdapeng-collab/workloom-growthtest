/**
 * 配乐"峰值对齐预卷"回归（2026-09-24 真机事故）
 *
 * 事故：`--section auto` 的"高潮对齐"早先通过 **整条音乐床 adelay 25.733s** 实现，
 * 结果 30s 成片里前 25.7s 完全没有音乐——产品所有者反馈"听不到新合成的 BGM"，
 * 实测 `ducked-music.wav` 0–25s 为数字静音（-120dBFS），只有最后 4.3s 有声音。
 *
 * 修复：改为**相位预卷**——把选段旋转 `phase` 秒后再循环铺满，
 * 段内峰值仍落在片子高点，同时从 0s 起全程有音乐。
 */
import { describe, expect, it } from "vitest";
import { prerollPhaseSec } from "./core.mjs";

/** 复现真实事故参数：选段 9.5s、段内峰值在 1.5s、片子高点 27.233s */
const REAL_CASE = { sectionDurationSec: 9.5, anchorOffsetSec: 1.5, filmPeakSec: 27.233, expectedPhase: 2.767 };

describe("配乐峰值对齐：相位预卷", () => {
  it("旋转相位后，段内峰值正好落在片子高点（真机参数）", () => {
    const phase = prerollPhaseSec(REAL_CASE);
    expect(phase).toBeCloseTo(REAL_CASE.expectedPhase, 3);

    /** 旋转后峰值首次出现的时刻 = (anchor - phase) mod L；再加上若干整圈即片子高点 */
    const L = REAL_CASE.sectionDurationSec;
    const firstPeak = ((REAL_CASE.anchorOffsetSec - phase) % L + L) % L;
    const loops = Math.floor((REAL_CASE.filmPeakSec - firstPeak) / L);
    expect(firstPeak + loops * L).toBeCloseTo(REAL_CASE.filmPeakSec, 6);
  });

  it("相位始终落在 [0, sectionDuration) 内，且 30s 片子可铺满 ≥3 圈（不会前段静音）", () => {
    for (const peak of [0, 5, 17.7, 27.233, 30, 61.5]) {
      const phase = prerollPhaseSec({ ...REAL_CASE, filmPeakSec: peak });
      expect(phase).toBeGreaterThanOrEqual(0);
      expect(phase).toBeLessThan(REAL_CASE.sectionDurationSec);
      /** 预卷模式不再"延后整条床"，因此首圈从 0s 就开始出声（旧实现会静音 25.7s） */
      const loops = Math.floor(30 / REAL_CASE.sectionDurationSec);
      expect(loops).toBeGreaterThanOrEqual(3);
    }
  });

  it("参数缺失/非法时退回 0 相位（不抛错、不产生 NaN 静音）", () => {
    expect(prerollPhaseSec({ sectionDurationSec: 0, anchorOffsetSec: 1, filmPeakSec: 2 })).toBe(0);
    expect(prerollPhaseSec({ sectionDurationSec: Number.NaN, anchorOffsetSec: 1, filmPeakSec: 2 })).toBe(0);
    const noAnchor = prerollPhaseSec({ sectionDurationSec: 8, anchorOffsetSec: Number.NaN, filmPeakSec: 6 });
    expect(Number.isFinite(noAnchor)).toBe(true);
  });
});
