import { describe, expect, it } from "vitest";
import {
  assessCharacterConsistency,
  CHARACTER_CONSISTENCY_POLICY,
  colorDelta,
  medianColor,
} from "./character-consistency.js";

const NAVY = { r: 42, g: 52, b: 84 };
const WHITE = { r: 246, g: 244, b: 238 };

describe("medianColor / colorDelta", () => {
  it("中位色抗离群（混入一个极亮像素不改变结论）", () => {
    const colors = [NAVY, NAVY, NAVY, { r: 250, g: 250, b: 250 }];
    const median = medianColor(colors)!;
    expect(colorDelta(median, NAVY)).toBeLessThan(20);
  });

  it("空输入返回 null（不编一个颜色）", () => {
    expect(medianColor([])).toBeNull();
  });
});

describe("assessCharacterConsistency", () => {
  it("真机形态：同一角色一镜深色工装、一镜白衣 → 判失败并点名串戏", () => {
    const report = assessCharacterConsistency({
      anchors: [{ characterId: "chen-zhuo", sampleColor: NAVY, fromShotId: "NC-09" }],
      shots: [
        { shotId: "NC-09", characterId: "chen-zhuo", declaredWardrobe: "深蓝工作围裙", sampleColor: NAVY, presenceRatio: 0.3 },
        { shotId: "NC-10", characterId: "chen-zhuo", declaredWardrobe: "深蓝工作围裙", sampleColor: WHITE, presenceRatio: 0.25 },
      ],
    });
    expect(report.ok).toBe(false);
    expect(report.issues.map((issue) => issue.kind)).toContain("wardrobe-drift");
    expect(report.issues.map((issue) => issue.kind)).toContain("cross-shot-drift");
    expect(report.detail).toMatch(/串戏|造型漂移/);
  });

  it("同一角色造型一致 → 放行（无告警）", () => {
    const report = assessCharacterConsistency({
      anchors: [{ characterId: "chen-zhuo", sampleColor: NAVY, fromShotId: "NC-01" }],
      shots: [
        { shotId: "NC-01", characterId: "chen-zhuo", sampleColor: NAVY, presenceRatio: 0.3 },
        { shotId: "NC-16", characterId: "chen-zhuo", sampleColor: { r: 52, g: 58, b: 88 }, presenceRatio: 0.28 },
      ],
    });
    expect(report.ok).toBe(true);
    expect(report.checked).toBe(2);
    expect(report.warnings).toHaveLength(0);
  });

  it("中等差异 → 只告警不拦（换装未声明的人工确认）", () => {
    const report = assessCharacterConsistency({
      anchors: [{ characterId: "lead", sampleColor: NAVY }],
      shots: [{ shotId: "S2", characterId: "lead", sampleColor: { r: 80, g: 90, b: 120 }, presenceRatio: 0.3 }],
    });
    expect(report.ok).toBe(true);
    expect(report.warnings.length).toBeGreaterThan(0);
    expect(report.warnings[0]!.detail).toMatch(/人工确认/);
  });

  it("未声明角色但检出人物 → 告警点名（不做人脸识别，如实说明需人工看一眼）", () => {
    const report = assessCharacterConsistency({
      anchors: [],
      shots: [{ shotId: "NC-10", characterId: null, sampleColor: WHITE, presenceRatio: 0.12 }],
    });
    expect(report.ok).toBe(true);
    expect(report.warnings[0]!.kind).toBe("undeclared-person");
    expect(report.warnings[0]!.detail).toMatch(/不做人脸识别/);
  });

  it("缺锚色 / 缺取样：登记跳过与告警，不误判", () => {
    const report = assessCharacterConsistency({
      anchors: [],
      shots: [
        { shotId: "S1", characterId: "lead", sampleColor: NAVY, presenceRatio: 0.3 },
        { shotId: "S2", characterId: "lead", sampleColor: null, presenceRatio: 0.3 },
      ],
    });
    expect(report.ok).toBe(true);
    expect(report.skipped).toEqual(["S2"]);
    expect(report.warnings[0]!.detail).toMatch(/没有锚色/);
  });

  it("阈值是显式口径（可审计）：默认告警 45 / 失败 90", () => {
    expect(CHARACTER_CONSISTENCY_POLICY.warnDelta).toBe(45);
    expect(CHARACTER_CONSISTENCY_POLICY.failDelta).toBe(90);
  });
});
