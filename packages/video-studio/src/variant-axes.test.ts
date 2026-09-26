import { describe, expect, it } from "vitest";
import { assessVariantAxes, DELIVERY_VARIANTS, VARIANT_MIN_COUNT, type VariantAxesEntry } from "./deliver.js";

const withAxes = (id: string, grade: string, cover: string, bgm: string): VariantAxesEntry => ({
  id, gradeProfile: grade, coverSha: cover, bgmSha: bgm,
});

describe("assessVariantAxes", () => {
  it("产品口径默认就是 3 支变体", () => {
    expect(VARIANT_MIN_COUNT).toBe(3);
    expect(DELIVERY_VARIANTS).toHaveLength(3);
    expect(new Set(DELIVERY_VARIANTS.map((v) => v.coverAccent)).size).toBe(3);
    expect(new Set(DELIVERY_VARIANTS.map((v) => `${v.bgmGenre}/${v.bgmMood}`)).size).toBe(3);
  });

  it("三轴两两不同 → 放行", () => {
    const report = assessVariantAxes([
      withAxes("cool-tech", "cool-technical", "c1", "b1"),
      withAxes("warm-film", "warm-film", "c2", "b2"),
      withAxes("punchy-social", "high-contrast-social", "c3", "b3"),
    ]);
    expect(report.ok).toBe(true);
    expect(report.detail).toMatch(/三轴上两两不同/);
  });

  it("只出 2 支 → 拦下（真机「为什么没执行」的那条约束）", () => {
    const report = assessVariantAxes([
      withAxes("cool-tech", "cool-technical", "c1", "b1"),
      withAxes("warm-film", "warm-film", "c2", "b2"),
    ]);
    expect(report.ok).toBe(false);
    expect(report.detail).toMatch(/变体数 2 < 3/);
  });

  it("三支只有滤镜不同、封面色与配乐相同 → 拦下", () => {
    const report = assessVariantAxes([
      withAxes("cool-tech", "cool-technical", "same", "same-track"),
      withAxes("warm-film", "warm-film", "same", "same-track"),
      withAxes("punchy-social", "high-contrast-social", "c3", "b3"),
    ]);
    expect(report.ok).toBe(false);
    expect(report.detail).toMatch(/封面相同|配乐相同/);
  });

  it("变体缺封面/缺配乐 → 拦下并逐条列出缺项", () => {
    const report = assessVariantAxes([
      { id: "cool-tech", gradeProfile: "cool-technical", coverSha: null, bgmSha: "b1" },
      { id: "warm-film", gradeProfile: "warm-film", coverSha: "c2", bgmSha: null },
      withAxes("punchy-social", "high-contrast-social", "c3", "b3"),
    ]);
    expect(report.ok).toBe(false);
    expect(report.missing.join("｜")).toMatch(/cool-tech 缺封面/);
    expect(report.missing.join("｜")).toMatch(/warm-film 缺配乐/);
  });
});
