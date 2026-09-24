import { describe, expect, it } from "vitest";
import { dedupeImageRefs, normalizePromptLanguage, restoreTimelineField } from "./prompt-language.js";

describe("提示词语言与引用归一", () => {
  it("vendor 默认英文负面词 → 中文等价（语义不减，不留英文单词）", () => {
    const report = normalizePromptLanguage("24.【负面约束】no text, no watermark, no signage, 卡通、插画、3D渲染感、塑料皮肤。");
    expect(report.replacements).toBe(3);
    expect(report.prompt).toContain("无文字");
    expect(report.prompt).toContain("无水印");
    expect(report.prompt).toContain("无标牌");
    expect(report.prompt).not.toMatch(/\bno text\b/);
    expect(report.remainingLatin).not.toContain("text");
  });

  it("重复的角色图引用只保留一条", () => {
    const line = "17.【定妆照】image://characters/WIFE-01/portrait.png,image://characters/WIFE-01/portrait.png。";
    const deduped = dedupeImageRefs(line);
    expect(deduped.removed).toBe(1);
    expect(deduped.prompt.match(/image:\/\//g)).toHaveLength(1);
    expect(deduped.prompt).toContain("17.【定妆照】image://characters/WIFE-01/portrait.png。");
  });

  it("只报告剩余拉丁词，不改写（格式/路径/时间码不算英文词）", () => {
    const report = normalizePromptLanguage("规格：9:16 画幅，1080x1920，24fps；T00:00-00:02 走近；31. extra limbs and somethingEnglish");
    expect(report.remainingLatin).toContain("somethingEnglish");
    expect(report.remainingLatin).not.toContain("fps");
    expect(report.prompt).toContain("1080x1920");
  });

  it("替换后不产生重复的顿号/空项", () => {
    const report = normalizePromptLanguage("负面：no text, no text, no watermark。");
    expect(report.prompt).not.toMatch(/、、|、\s*。/);
  });

  /**
   * 真机（2026-09-24）：卡里三段节拍，进提示词只剩前两段（末段 1.5s 丢失）。
   */
  it("时间轴被组装器截断时，用卡片原文补回末段", () => {
    const prompt = [
      "18.【台词】这条河，流了八百年。",
      "19.【时间轴】T00:00-00:02 正面走来开口；T00:02-00:03.5 继续走近微笑；",
      "20.【情绪】开阔明亮"
    ].join("\n");
    const segments = ["T00:00-00:02 正面走来开口", "T00:02-00:03.5 继续走近微笑", "T00:03.5-00:05 停下说完，视线不离镜头"];
    const fixed = restoreTimelineField(prompt, segments);
    expect(fixed.restored).toBe(true);
    expect(fixed.prompt).toContain("T00:03.5-00:05 停下说完，视线不离镜头");
    expect(fixed.prompt).toContain("20.【情绪】开阔明亮");
    // 已经完整 → 不动
    expect(restoreTimelineField(fixed.prompt, segments).restored).toBe(false);
  });
});
