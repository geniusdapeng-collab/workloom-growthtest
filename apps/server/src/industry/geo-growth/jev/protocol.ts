/**
 * Jev 协议层：请求构造无关；本文件只做两件事——
 *   ① 解析并**校验**回答（非法即拒，绝不猜测）；
 *   ② 概率归一化（网关按两位小数四舍五入；官方直连返回的概率同样不保证严格为 1）。
 *
 * 解析纪律（对齐 jev-ultrafast 的 validate_choice 与 TypeSafe 官方 API 文档）：
 *   - choice：`choice` 必须在 criteria 键内；概率仅在已知键上取值，未知键忽略；至少一个正数；
 *   - score：`score` 必须落在 [0, n-1]；概率键为 "0".."n-1"，缺失按 0 处理；
 *   - boolean（本地类型名）↔ 官方原语 `noul`：回答字段为 `noul`（官方直连）或 `probability`（网关），
 *     两者取其一，值必须为 [0,1] 内的有限数；回答的 `type` 允许 `boolean` 或 `noul`（同一原语的两种叫法）；
 *   - 置信度优先取模型自报（answer.confidence 或 providerMetadata.typesafe.confidence[id]），
 *     缺失时派生为最大概率，并标记 confidenceDerived=true（分流策略据此更保守）——
 *     官方直连对 Noul **不返回置信度**，因此 boolean 主决策场景恒为派生置信度、不得自动分流。
 */
import type { AnswerView, JevCallResult, JevQuestionSet, QuestionType } from "./types.js";

export class JevResponseError extends Error {
  readonly code = "invalid_response";
  constructor(message: string) {
    super(message);
    this.name = "JevResponseError";
  }
}

/** 每个问题类型接受的回答 type（boolean 与官方原语名 noul 等价） */
const ACCEPTED_ANSWER_TYPES: Record<QuestionType, readonly string[]> = {
  boolean: ["boolean", "noul"],
  choice: ["choice"],
  score: ["score"],
};

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function clamp01(value: number): number {
  return value < 0 ? 0 : value > 1 ? 1 : value;
}

/**
 * 概率表归一化：只保留已知键；剔除负数与非有限值；和必须为正；
 * 和与 1 的偏差 > 0.35 视为异常（不是四舍五入，而是答非所问）。
 */
export function normalizeProbabilities(
  raw: unknown,
  allowedKeys: readonly string[],
): { probabilities: Record<string, number>; renormalized: boolean } {
  if (typeof raw !== "object" || raw === null) {
    throw new JevResponseError("probabilities 缺失或不是对象");
  }
  const source = raw as Record<string, unknown>;
  const probabilities: Record<string, number> = {};
  let sum = 0;
  for (const key of allowedKeys) {
    const value = source[key];
    if (value === undefined || value === null) {
      probabilities[key] = 0;
      continue;
    }
    if (!isFiniteNumber(value) || value < 0 || value > 1) {
      throw new JevResponseError(`probabilities[${key}] 非法：${String(value)}`);
    }
    probabilities[key] = value;
    sum += value;
  }
  if (sum <= 0) throw new JevResponseError("probabilities 全为 0");
  if (Math.abs(sum - 1) > 0.35) {
    throw new JevResponseError(`probabilities 之和偏离 1 过大：${sum.toFixed(3)}`);
  }
  const renormalized = Math.abs(sum - 1) > 1e-9;
  if (renormalized) {
    for (const key of allowedKeys) {
      probabilities[key] = (probabilities[key] ?? 0) / sum;
    }
  }
  return { probabilities, renormalized };
}

function pickConfidence(
  answer: Record<string, unknown>,
  id: string,
  maxProbability: number,
  providerConfidence: Record<string, unknown> | undefined,
): { confidence: number; derived: boolean } {
  const candidates: unknown[] = [answer["confidence"], providerConfidence?.[id]];
  for (const candidate of candidates) {
    if (isFiniteNumber(candidate)) {
      return { confidence: clamp01(candidate), derived: false };
    }
  }
  return { confidence: clamp01(maxProbability), derived: true };
}

function extractProviderConfidence(body: Record<string, unknown>): Record<string, unknown> | undefined {
  const providerMetadata = body["providerMetadata"];
  if (typeof providerMetadata !== "object" || providerMetadata === null) return undefined;
  const typesafe = (providerMetadata as Record<string, unknown>)["typesafe"];
  if (typeof typesafe !== "object" || typesafe === null) return undefined;
  const confidence = (typesafe as Record<string, unknown>)["confidence"];
  if (typeof confidence !== "object" || confidence === null) return undefined;
  return confidence as Record<string, unknown>;
}

/** 不同网关/版本可能把 answers 放在不同层级；按已知位置顺序探测，找不到即拒 */
function extractAnswers(body: Record<string, unknown>): Record<string, unknown> {
  const candidates: unknown[] = [
    body["answers"],
    (body["output"] as Record<string, unknown> | undefined)?.["answers"],
    (body["result"] as Record<string, unknown> | undefined)?.["answers"],
  ];
  for (const candidate of candidates) {
    if (typeof candidate === "object" && candidate !== null) {
      return candidate as Record<string, unknown>;
    }
  }
  throw new JevResponseError("响应中找不到 answers");
}

function extractUsage(body: Record<string, unknown>): { inputTokens: number; outputTokens: number } {
  const usage = (body["usage"] ?? {}) as Record<string, unknown>;
  const input = usage["inputTokens"] ?? usage["input_tokens"] ?? usage["promptTokens"] ?? usage["prompt_tokens"];
  const output =
    usage["outputTokens"] ?? usage["output_tokens"] ?? usage["completionTokens"] ?? usage["completion_tokens"];
  return {
    inputTokens: isFiniteNumber(input) ? input : 0,
    outputTokens: isFiniteNumber(output) ? output : 0,
  };
}

/** 按问题定义逐一解析；任何问题不合法 → 整体拒绝（宁可失败，不猜答案） */
export function parseAnswers(
  body: unknown,
  questions: JevQuestionSet,
  fallbackModel: string,
  latencyMs: number,
): JevCallResult {
  if (typeof body !== "object" || body === null) {
    throw new JevResponseError("响应不是对象");
  }
  const record = body as Record<string, unknown>;
  const answers = extractAnswers(record);
  const providerConfidence = extractProviderConfidence(record);
  const byId: Record<string, AnswerView> = {};

  for (const [id, question] of Object.entries(questions)) {
    const rawAnswer = answers[id];
    if (typeof rawAnswer !== "object" || rawAnswer === null) {
      throw new JevResponseError(`缺少回答：${id}`);
    }
    const answer = rawAnswer as Record<string, unknown>;
    const rawType = answer["type"];
    if (rawType !== undefined && !ACCEPTED_ANSWER_TYPES[question.type].includes(String(rawType))) {
      throw new JevResponseError(`回答类型不符：${id} 期望 ${question.type} 实际 ${String(rawType)}`);
    }
    const type: QuestionType = question.type;

    if (question.type === "boolean") {
      const probability = answer["probability"] ?? answer["noul"];
      if (!isFiniteNumber(probability) || probability < 0 || probability > 1) {
        throw new JevResponseError(`boolean 概率非法：${id}=${String(probability)}`);
      }
      const { confidence, derived } = pickConfidence(
        answer,
        id,
        Math.max(probability, 1 - probability),
        providerConfidence,
      );
      byId[id] = {
        id,
        type,
        probability,
        confidence,
        confidenceDerived: derived,
        probabilitiesRenormalized: false,
      };
      continue;
    }

    if (question.type === "choice") {
      const allowed = Object.keys(question.criteria);
      const { probabilities, renormalized } = normalizeProbabilities(
        answer["probabilities"],
        allowed,
      );
      const choice = answer["choice"];
      if (typeof choice !== "string" || !allowed.includes(choice)) {
        throw new JevResponseError(`choice 非法：${id}=${String(choice)}`);
      }
      const top = Math.max(...allowed.map((key) => probabilities[key] ?? 0));
      const { confidence, derived } = pickConfidence(answer, id, top, providerConfidence);
      byId[id] = {
        id,
        type,
        choice,
        probabilities,
        confidence,
        confidenceDerived: derived,
        probabilitiesRenormalized: renormalized,
      };
      continue;
    }

    // score
    const levels = question.criteria.length;
    const score = answer["score"];
    if (!isFiniteNumber(score) || score < 0 || score > levels - 1) {
      throw new JevResponseError(`score 越界：${id}=${String(score)}（0..${levels - 1}）`);
    }
    const allowed = Array.from({ length: levels }, (_, index) => String(index));
    const { probabilities, renormalized } = normalizeProbabilities(
      answer["probabilities"],
      allowed,
    );
    const top = Math.max(...allowed.map((key) => probabilities[key] ?? 0));
    const { confidence, derived } = pickConfidence(answer, id, top, providerConfidence);
    byId[id] = {
      id,
      type,
      score,
      probabilities,
      confidence,
      confidenceDerived: derived,
      probabilitiesRenormalized: renormalized,
    };
  }

  const usage = extractUsage(record);
  const model = typeof record["model"] === "string" ? record["model"] : fallbackModel;
  return {
    byId,
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    latencyMs,
    model,
    raw: body,
  };
}
