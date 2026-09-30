import { describe, expect, it } from "vitest";
import { COVER_PLATFORMS } from "./cover-platforms.js";
import { hookWindowFor } from "./opening-hook.js";
import {
  FALLBACK_SPEECH_RATE,
  SPEECH_RATE_POLICY,
  SPEECH_RATE_PLATFORM_IDS,
  checkSpeechFit,
  dialogueText,
  hasSpeechRatePolicy,
  platformDeliveryGuidance,
  resolvePlatformIntent,
  speechRateProfile,
  spokenUnits,
} from "./platform-intent.js";

describe("平台意图识别", () => {
  it("需求没有平台词时按默认口径走抖音，并写明判据", () => {
    const decision = resolvePlatformIntent("给我们的获客系统做一条讲解视频");
    expect(decision).toMatchObject({ id: "douyin", source: "default", aspectRatio: "9:16" });
    expect(decision.reason).toContain("默认口径");
    expect(decision.evidence).toBe("");
  });

  it("需求文本命中平台词时自动切到该平台，画幅随之切换", () => {
    const xhs = resolvePlatformIntent("做一条小红书种草笔记视频");
    expect(xhs).toMatchObject({ id: "xiaohongshu", source: "text", evidence: "小红书", aspectRatio: "3:4" });
    expect(xhs.reason).toContain("小红书");
    const dy = resolvePlatformIntent("拍一条用于抖音的短视频");
    expect(dy).toMatchObject({ id: "douyin", source: "text", evidence: "抖音" });
  });

  it("复合别名「抖音/快手」整体命中抖音，不被拆成两个平台", () => {
    const decision = resolvePlatformIntent("投抖音/快手");
    expect(decision).toMatchObject({ id: "douyin", source: "text" });
  });

  it("英文平台词要求词边界，普通英文单词里的片段不算命中", () => {
    expect(resolvePlatformIntent("inside the studio we shoot").source).toBe("default");
    expect(resolvePlatformIntent("post it on TikTok").id).toBe("tiktok");
    expect(resolvePlatformIntent("upload to YouTube Shorts").id).toBe("youtube");
  });

  it("显式参数优先于文本命中；未登记的显式值落默认口径但保留原值", () => {
    const explicit = resolvePlatformIntent("发到抖音", "小红书");
    expect(explicit).toMatchObject({ id: "xiaohongshu", source: "explicit", evidence: "小红书" });
    const unknown = resolvePlatformIntent("发到抖音", "某不存在的平台");
    expect(unknown).toMatchObject({ id: "douyin", source: "default", requested: "某不存在的平台" });
    expect(unknown.reason).toContain("未登记");
  });
});

describe("平台语速口径", () => {
  it("抖音档相对既有全局口径明显更快，且短平台档位自洽", () => {
    const douyin = speechRateProfile("douyin");
    expect(douyin.tier).toBe("fast");
    /** "明显更快"必须能被断言：目标语速至少比 standard 档高 30%。 */
    expect(douyin.target).toBeGreaterThanOrEqual(FALLBACK_SPEECH_RATE.target * 1.3);
    expect(douyin.max).toBeGreaterThan(douyin.target);
    expect(douyin.min).toBeLessThan(douyin.target);
    expect(douyin.ttsSpeed).toBeGreaterThan(FALLBACK_SPEECH_RATE.ttsSpeed);
  });

  it("每个语速档键都在平台规格表里，不出现孤儿键；未登记平台回落全局口径", () => {
    for (const id of SPEECH_RATE_PLATFORM_IDS) {
      expect(COVER_PLATFORMS[id], `语速档 ${id} 没有对应的平台规格`).toBeDefined();
    }
    expect(hasSpeechRatePolicy("douyin")).toBe(true);
    expect(hasSpeechRatePolicy("未登记平台")).toBe(false);
    expect(speechRateProfile("未登记平台")).toEqual(FALLBACK_SPEECH_RATE);
    expect(speechRateProfile()).toEqual(FALLBACK_SPEECH_RATE);
  });

  it("钩子窗口与既有 hookWindowFor 口径一致，避免两处各说各话", () => {
    for (const id of SPEECH_RATE_PLATFORM_IDS) {
      const label = COVER_PLATFORMS[id]!.name;
      expect(hookWindowFor(label), `${label} 钩子窗口不一致`).toBe(SPEECH_RATE_POLICY[id]!.hookWindowSec);
    }
  });

  it("中文/英文/标点的可念字数口径：标点空白不计，英文串按两字符一字折算", () => {
    expect(spokenUnits("今天我们来聊聊增长")).toBe(9);
    expect(spokenUnits("今天，我们来聊聊增长。")).toBe(9);
    expect(spokenUnits("T1")).toBe(1);
    expect(spokenUnits("")).toBe(0);
  });

  it("镜头卡台词抽取兼容字符串 / 字符串数组 / {text} 数组三种形态", () => {
    expect(dialogueText("单句台词")).toBe("单句台词");
    expect(dialogueText(["第一句", "第二句"])).toBe("第一句\n第二句");
    expect(dialogueText([{ text: "对象形态" }, { text: "" }, "混合形态"])).toBe("对象形态\n混合形态");
    expect(dialogueText(undefined)).toBe("");
    expect(spokenUnits(dialogueText([{ text: "一二三四五" }]))).toBe(5);
  });

  it("按镜时长判念得完：超上限判硬失败、低于下限判节奏偏松、无台词免检", () => {
    const douyin = speechRateProfile("douyin");
    const ok = checkSpeechFit({ text: "今天聊聊获客闭环的三个关键动作", durationSec: 4, profile: douyin, shotId: "S-1" });
    expect(ok.ok).toBe(true);
    expect(ok.severity).toBe("pass");
    const over = checkSpeechFit({ text: "今天聊聊获客闭环的三个关键动作以及每一步的落地细节和常见坑", durationSec: 3, profile: douyin, shotId: "S-2" });
    expect(over.ok).toBe(false);
    expect(over.severity).toBe("over");
    expect(over.detail).toContain("不要拉快配音硬塞");
    const loose = checkSpeechFit({ text: "好的", durationSec: 5, profile: douyin });
    expect(loose.ok).toBe(true);
    expect(loose.severity).toBe("loose");
    const empty = checkSpeechFit({ text: "", durationSec: 5, profile: douyin });
    expect(empty).toMatchObject({ ok: true, severity: "pass" });
    const invalid = checkSpeechFit({ text: "随便一句", durationSec: 0, profile: douyin });
    expect(invalid).toMatchObject({ ok: false, severity: "invalid" });
  });

  it("同一个镜头时长下，抖音档比 standard 档容纳更多字（差异可被断言）", () => {
    const shot = { text: "一二三四五六七八九十一二三四五六七八九十一二", durationSec: 5 };
    const fast = checkSpeechFit({ ...shot, profile: speechRateProfile("douyin") });
    const standard = checkSpeechFit({ ...shot, profile: speechRateProfile("bilibili") });
    expect(fast.ok).toBe(true);
    expect(standard.ok).toBe(false);
    expect(standard.severity).toBe("over");
  });

  it("注入的平台制作口径块带齐画幅、钩子窗口、目标与上限语速", () => {
    const guidance = platformDeliveryGuidance(resolvePlatformIntent("做一条抖音短视频"));
    expect(guidance).toContain("[平台制作口径 douyin");
    expect(guidance).toContain("画幅 9:16");
    expect(guidance).toContain("前 3 秒");
    expect(guidance).toContain("目标 4.8 字/秒、上限 5.6 字/秒");
    expect(guidance).toContain("配音基础速率 1.15×");
  });
});
