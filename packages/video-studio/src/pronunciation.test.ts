import { describe, expect, it } from "vitest";

import { DEFAULT_PRONUNCIATION_LEXICON, normalizeForTts, termPronunciationCheck } from "./pronunciation.js";

/**
 * 固定样例全部来自 2026-09-27 真机（VID-GROWTH-SALES02）：
 * 左 = 视频模型自带音频的 ASR 转写（真读错），右 = 本机克隆音色重配后的 ASR 转写（读对）。
 */
describe("termPronunciationCheck（关键术语发音核查）", () => {
  it("真机 CF-04：『数字 CBO』判失败（整句相似度 0.96 也拦得住）", () => {
    const verdict = termPronunciationCheck({
      transcript: "四支团队,七十八个岗位,数字CBO排产。你只管定方向,拍板。",
      expectedText: "四支团队、七十八个岗位，数字 CEO 排产，你只管定方向、拍板。",
    });
    expect(verdict.ok).toBe(false);
    expect(verdict.required).toContain("CEO");
    expect(verdict.missing).toEqual(["CEO"]);
  });

  it("真机 CF-05：『短视频监口』判失败", () => {
    const verdict = termPronunciationCheck({
      transcript: "短视频监口加GEO占领AI答案,一次生产,双域变现。",
      expectedText: "短视频种草，加 GEO 占领 AI 答案，一次生产、双域变现。",
    });
    expect(verdict.ok).toBe(false);
    expect(verdict.missing).toEqual(["种草"]);
  });

  it("同一句重配后（本机克隆音色）判通过", () => {
    expect(termPronunciationCheck({
      transcript: "四支团队78个岗位数字CEO排产你只管定方向拍板",
      expectedText: "四支团队、七十八个岗位，数字 CEO 排产，你只管定方向、拍板。",
    }).ok).toBe(true);
    expect(termPronunciationCheck({
      transcript: "短视频种草加geo占领AI答案一次生产双域变现",
      expectedText: "短视频种草，加 GEO 占领 AI 答案，一次生产、双域变现。",
    }).ok).toBe(true);
  });

  it("ASR 已知同音偏差不误杀：获客→货客、询盘→寻单、落地页→落地夜、首响→首想、四成二→4乘2", () => {
    const verdict = termPronunciationCheck({
      transcript: "评论 私信 落地夜 30秒首想夜间寻单不再白丢",
      expectedText: "评论、私信、落地页，30 秒首响，夜间询盘不再白丢。",
    });
    expect(verdict.required).toEqual(expect.arrayContaining(["落地页", "首响", "询盘"]));
    expect(verdict.ok).toBe(true);

    const cheng = termPronunciationCheck({
      transcript: "还有一笔新账4乘2消费者先问AI再决定买谁",
      expectedText: "还有一笔新账，四成二消费者先问 AI，再决定买谁。",
    });
    expect(cheng.ok).toBe(true);

    const huoke = termPronunciationCheck({
      transcript: "通用AI是单线工具Workloom是住进你公司的AI货客班组",
      expectedText: "通用 AI 是单线工具；WorkLoom 是住进你公司的 AI 获客班组。",
    });
    expect(huoke.ok).toBe(true);
  });

  it("同音字不算错、但读错音必须报：种草 vs 监口", () => {
    expect(termPronunciationCheck({ transcript: "短视频种草", expectedText: "短视频种草" }).ok).toBe(true);
    expect(termPronunciationCheck({ transcript: "短视频种菜", expectedText: "短视频种草" }).ok).toBe(false);
    expect(termPronunciationCheck({ transcript: "短视频种草", expectedText: "短视频种草" }).missing).toEqual([]);
  });

  it("台词里没有受保护术语 → 术语门不适用（不误杀普通句子）", () => {
    const verdict = termPronunciationCheck({ transcript: "今天天气不错", expectedText: "今天天气不错" });
    expect(verdict.ok).toBe(true);
    expect(verdict.required).toEqual([]);
  });

  it("转写缺失 → 不放行（不拿未测到的数据当通过）", () => {
    expect(termPronunciationCheck({ transcript: null, expectedText: "数字 CEO 排产" }).ok).toBe(false);
    expect(termPronunciationCheck({ transcript: "数字CEO排产", expectedText: "" }).ok).toBe(false);
  });

  it("术语表可注入（行业可加自己的词）", () => {
    const lexicon = [...DEFAULT_PRONUNCIATION_LEXICON, { text: "滕王阁", aliases: ["藤王閣", "藤王阁"] }];
    const verdict = termPronunciationCheck({
      transcript: "一片藤王閣序火了1300年",
      expectedText: "一篇滕王阁序，火了 1300 年",
      lexicon,
    });
    expect(verdict.ok).toBe(true);
  });
});

describe("normalizeForTts（给 TTS 的定点读法改写）", () => {
  it("未登记 ttsText 的术语不改写（避免把能读对的文本改坏）", () => {
    expect(normalizeForTts("数字 CEO 排产，短视频种草")).toBe("数字 CEO 排产，短视频种草");
  });

  it("登记 ttsText 的术语按登记改写", () => {
    const out = normalizeForTts("数字 CEO 排产", [{ text: "CEO", ttsText: "C E O" }]);
    expect(out).toBe("数字 C E O 排产");
  });
});
