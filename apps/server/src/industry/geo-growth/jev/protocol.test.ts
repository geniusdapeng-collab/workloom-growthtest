/**
 * 协议层单测：概率归一化 + 回答校验 + 置信度来源（不触网、不调模型）。
 *
 * 覆盖的是"模型回答能不能信"这一层的硬契约：
 *   ① 网关按两位小数取整 → 必须重新归一化；
 *   ② 非法回答（未知 choice / 越界 score / 概率出界 / 缺回答）必须整体拒绝；
 *   ③ 置信度优先取模型自报，缺失时派生并标记（分流据此更保守）。
 */
import { describe, expect, it } from "vitest";
import { JevResponseError, normalizeProbabilities, parseAnswers } from "./protocol.js";
import type { JevQuestionSet } from "./types.js";

const QUESTIONS: JevQuestionSet = {
  intent: {
    type: "choice",
    instructions: "Choose one",
    criteria: { inquiry: "asks a question", complaint: "expresses dissatisfaction", spam: "advertising" },
  },
  strength: { type: "score", instructions: "How strong", criteria: ["none", "vague", "clear"] },
  urgent: { type: "boolean", instructions: "Is it urgent" },
};

describe("normalizeProbabilities", () => {
  it("两位小数取整后的概率会被重新归一化", () => {
    const { probabilities, renormalized } = normalizeProbabilities(
      { inquiry: 0.84, complaint: 0.09, spam: 0.06 },
      ["inquiry", "complaint", "spam"],
    );
    expect(renormalized).toBe(true);
    const sum = Object.values(probabilities).reduce((total, value) => total + value, 0);
    expect(sum).toBeCloseTo(1, 10);
  });

  it("未知键忽略、缺失键按 0 处理", () => {
    const { probabilities, renormalized } = normalizeProbabilities(
      { inquiry: 1, unknown: 5 },
      ["inquiry", "complaint"],
    );
    expect(probabilities["complaint"]).toBe(0);
    expect(renormalized).toBe(false);
  });

  it("负数或全 0 概率直接拒绝", () => {
    expect(() => normalizeProbabilities({ inquiry: -0.1 }, ["inquiry"])).toThrow(JevResponseError);
    expect(() => normalizeProbabilities({ inquiry: 0, complaint: 0 }, ["inquiry", "complaint"])).toThrow(
      JevResponseError,
    );
  });

  it("概率之和偏离 1 过大（>0.35）视为答非所问", () => {
    expect(() => normalizeProbabilities({ inquiry: 0.3, complaint: 0.2 }, ["inquiry", "complaint"])).toThrow(
      /偏离 1 过大/,
    );
  });
});

describe("parseAnswers", () => {
  it("解析 choice/score/boolean，并取 providerMetadata 中的置信度", () => {
    const result = parseAnswers(
      {
        model: "typesafe-ai/jev",
        answers: {
          intent: { type: "choice", choice: "inquiry", probabilities: { inquiry: 0.9, complaint: 0.06, spam: 0.03 } },
          strength: { type: "score", score: 1.6, probabilities: { "0": 0.1, "1": 0.6, "2": 0.3 } },
          urgent: { type: "boolean", probability: 0.22 },
        },
        providerMetadata: { typesafe: { confidence: { intent: 0.91, strength: 0.8, urgent: 0.77 } } },
        usage: { inputTokens: 1200, outputTokens: 0 },
      },
      QUESTIONS,
      "fallback-model",
      123,
    );
    expect(result.byId["intent"]?.choice).toBe("inquiry");
    expect(result.byId["intent"]?.confidence).toBeCloseTo(0.91);
    expect(result.byId["intent"]?.confidenceDerived).toBe(false);
    expect(result.byId["strength"]?.score).toBeCloseTo(1.6);
    expect(result.byId["urgent"]?.probability).toBeCloseTo(0.22);
    expect(result.inputTokens).toBe(1200);
    expect(result.latencyMs).toBe(123);
  });

  it("模型未自报置信度时派生并标记", () => {
    const result = parseAnswers(
      {
        answers: {
          intent: { type: "choice", choice: "spam", probabilities: { inquiry: 0.05, complaint: 0.05, spam: 0.9 } },
          strength: { type: "score", score: 2, probabilities: { "0": 0, "1": 0.2, "2": 0.8 } },
          urgent: { type: "boolean", probability: 0.9 },
        },
        usage: { input_tokens: 10, output_tokens: 0 },
      },
      QUESTIONS,
      "m",
      1,
    );
    expect(result.byId["intent"]?.confidenceDerived).toBe(true);
    expect(result.byId["intent"]?.confidence).toBeCloseTo(0.9);
    expect(result.inputTokens).toBe(10);
  });

  it("官方直连形状：boolean 问题的回答 type 是 noul、字段是 noul（docs.typesafe.ai/api 示例口径）", () => {
    const result = parseAnswers(
      {
        model: "jev-1.13.0",
        answers: {
          intent: {
            type: "choice",
            choice: "inquiry",
            probabilities: { inquiry: 0.88, complaint: 0.12, spam: 0 },
            confidence: 0.81,
          },
          strength: {
            type: "score",
            score: 1.05,
            legend: { "0": "none", "1": "vague", "2": "clear" },
            probabilities: { "0": 0, "1": 0.95, "2": 0.05 },
            confidence: 0.92,
          },
          urgent: { type: "noul", noul: 0.95 },
        },
        usage: { input_tokens: 296, output_tokens: 20 },
      },
      QUESTIONS,
      "jev-latest",
      42,
    );
    expect(result.model).toBe("jev-1.13.0");
    expect(result.byId["urgent"]?.probability).toBeCloseTo(0.95);
    // Noul 没有置信度字段 → 派生（更保守，不得进自动档）
    expect(result.byId["urgent"]?.confidenceDerived).toBe(true);
    expect(result.byId["intent"]?.confidence).toBeCloseTo(0.81);
    expect(result.byId["strength"]?.confidence).toBeCloseTo(0.92);
    expect(result.inputTokens).toBe(296);
    expect(result.outputTokens).toBe(20);
  });

  it("官方直连形状：noul 回答越界同样整体拒绝", () => {
    expect(() =>
      parseAnswers(
        { answers: { urgent: { type: "noul", noul: 1.4 } }, usage: {} },
        { urgent: { type: "boolean", instructions: "q" } },
        "m",
        0,
      ),
    ).toThrow(JevResponseError);
  });

  it.each([
    ["未知 choice", { intent: { type: "choice", choice: "invented", probabilities: { inquiry: 1 } } }],
    ["概率出界", { intent: { type: "choice", choice: "inquiry", probabilities: { inquiry: 1.4 } } }],
    ["score 越界", { strength: { type: "score", score: 3, probabilities: { "0": 1 } } }],
    ["boolean 非法", { urgent: { type: "boolean", probability: 7 } }],
  ])("非法回答整体拒绝：%s", (_label, answers) => {
    expect(() =>
      parseAnswers({ answers, usage: {} }, QUESTIONS, "m", 0),
    ).toThrow(JevResponseError);
  });

  it("缺少回答或类型不符时拒绝", () => {
    expect(() =>
      parseAnswers({ answers: { intent: { type: "choice", choice: "inquiry", probabilities: { inquiry: 1 } } } }, QUESTIONS, "m", 0),
    ).toThrow(/缺少回答/);
    expect(() =>
      parseAnswers(
        {
          answers: {
            intent: { type: "boolean", probability: 1 },
            strength: { type: "score", score: 1, probabilities: { "0": 0.5, "1": 0.5 } },
            urgent: { type: "boolean", probability: 0.5 },
          },
        },
        QUESTIONS,
        "m",
        0,
      ),
    ).toThrow(/类型不符/);
  });

  it("响应中没有 answers 时拒绝", () => {
    expect(() => parseAnswers({ model: "m" }, QUESTIONS, "m", 0)).toThrow(/找不到 answers/);
  });
});
