import { describe, expect, it } from "vitest";
import { isDoubledNarration, speechAcceptance } from "./narration.js";

describe("speechAcceptance（逐镜人声核查判据）", () => {
  it("真机复现 VID-GR01 第 1 镜：匹配 1.000 / 活动度 0.228 → 放行，不再补旁白", () => {
    const verdict = speechAcceptance({ matchRatio: 1, activeRatio: 0.228 });
    expect(verdict.ok).toBe(true);
    expect(verdict.strongMatch).toBe(true);
    expect(verdict.reason).toContain("强匹配");
  });

  it("双指标达标 → 放行", () => {
    expect(speechAcceptance({ matchRatio: 0.72, activeRatio: 0.55 }).ok).toBe(true);
  });

  it("活动度达标但匹配不足 → 仍需补旁白（转写对不上台词）", () => {
    const verdict = speechAcceptance({ matchRatio: 0.2, activeRatio: 0.8 });
    expect(verdict.ok).toBe(false);
    expect(verdict.strongMatch).toBe(false);
  });

  it("两项都低 → 补旁白", () => {
    expect(speechAcceptance({ matchRatio: 0.3, activeRatio: 0.1 }).ok).toBe(false);
  });

  it("指标缺失 → 不放行（不拿未测到的数据当通过）", () => {
    expect(speechAcceptance({ matchRatio: null, activeRatio: 0.5 }).ok).toBe(false);
    expect(speechAcceptance({ matchRatio: 0.9, activeRatio: null }).ok).toBe(false);
  });

  it("阈值可配：把强匹配阈值提到 0.95 时，0.9 的转写不再豁免活动度", () => {
    expect(speechAcceptance({ matchRatio: 0.9, activeRatio: 0.2, strongMatchMin: 0.95 }).ok).toBe(false);
  });
});

describe("isDoubledNarration（重复播报防线）", () => {
  it("真机复现：复核转写出现两遍 → 判重复", () => {
    expect(isDoubledNarration("还在给平台打工吗还在给平台打工吗", "还在给平台打工吗？")).toBe(true);
  });

  it("只说一遍 → 不判重复（含标点与空格差异）", () => {
    expect(isDoubledNarration(" 还在给平台打工吗 ", "还在给平台打工吗？")).toBe(false);
  });

  it("转写为空或台词为空 → 不误报", () => {
    expect(isDoubledNarration("", "还在给平台打工吗")).toBe(false);
    expect(isDoubledNarration("随便一句", "")).toBe(false);
    expect(isDoubledNarration(null, "台词")).toBe(false);
  });

  it("子串包含关系不误伤：台词是转写的一部分但只出现一次 → 不判重复", () => {
    expect(isDoubledNarration("客户去问 AI 了，答案里没有你就出局", "客户去问 AI 了")).toBe(false);
  });
});
