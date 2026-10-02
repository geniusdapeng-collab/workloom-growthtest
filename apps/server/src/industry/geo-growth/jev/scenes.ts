/**
 * growth 试点场景集（三个判断场景，与 bundles/geo-growth/model-policy.yml 的既有场景位对齐）
 *
 * 与现有场景的关系（不改基座、不改现有路由，先影子对照）：
 *   - comment-classify ↔ model-policy `comment-classify`（社媒评论/线索初筛，L1 谷时批量）
 *   - lead-qualify    ↔ model-policy `lead-qualify`（线索分级与跟进建议，L2）
 *   - fact-precheck   ↔ 围栏 G-GEO2「事实红线一票否决」的人工前置预检（**不替代**该围栏）
 *
 * 写法纪律（全部来自 TypeSafe 官方 jaggedness 文档）：
 *   ① instructions 一律英文短句、直述条件（模型字面理解，双关/双重否定会掉分）；
 *   ② 不做算术、不比较日期：需要数字/日期时留在代码里（本文件不构造此类问题）；
 *   ③ state 只放判断必需字段，避免无关长文干扰（context rot）；
 *   ④ 事实类问题只做「语义是否超出官方口径」的判断；品牌实体逐字一致性属于确定性比对，不进模型。
 */
import type {
  AnswerView,
  JevCallResult,
  JevRequest,
  Scene,
  SceneInput,
  SceneKey,
  SceneDecision,
} from "./types.js";

function percent(probability: number): string {
  return `${(probability * 100).toFixed(1)}%`;
}

function answer(result: JevCallResult, id: string): AnswerView {
  const found = result.byId[id];
  if (!found) throw new Error(`回答缺失：${id}`);
  return found;
}

/** 取所有回答置信度的最小值：任一维度不确定，整体就不该自动放行 */
function conservativeConfidence(result: JevCallResult, ids: readonly string[]): number {
  const values = ids.map((id) => answer(result, id).confidence);
  return Math.min(...values);
}

function anyDerived(result: JevCallResult, ids: readonly string[]): boolean {
  return ids.some((id) => answer(result, id).confidenceDerived);
}

/* ------------------------------------------------------------------ */
/* 场景 1：社媒评论 / 线索初筛                                          */
/* ------------------------------------------------------------------ */

const COMMENT_INTENT_CRITERIA: Record<string, string> = {
  inquiry: "Asks a factual question about the product, service, price or availability, without clear buying intent yet.",
  booking_intent: "States a concrete intention to book, buy, reserve or order, now or at a stated near-term time.",
  complaint: "Expresses dissatisfaction, a bad experience, or demands compensation or a fix.",
  smalltalk: "Social or off-topic chat that is not about the business offering.",
  spam: "Advertising, unrelated promotion, engagement bait, or a repeatable bot-like message.",
};

const COMMENT_INTENT_ZH: Record<string, string> = {
  inquiry: "咨询问询",
  booking_intent: "预订/购买意向",
  complaint: "投诉负面",
  smalltalk: "闲聊无关",
  spam: "广告/无效",
};

export const commentClassifyScene: Scene = {
  key: "comment-classify",
  version: "1.0.0",
  description: "社媒评论/私信初筛：意图分类 + 是否销售线索 + 是否需要人工处理",
  primary: { id: "intent", type: "choice" },
  labelsZh: COMMENT_INTENT_ZH,
  build(input: SceneInput): JevRequest {
    return {
      state: {
        task: "Classify one customer comment for a Chinese hospitality and travel business.",
        comment: input.text,
        ...(input.context ? { context: input.context } : {}),
      },
      questions: {
        intent: {
          type: "choice",
          instructions:
            "Choose the single best category for this comment. Judge what the comment is asking for or expressing, not individual keywords.",
          criteria: COMMENT_INTENT_CRITERIA,
        },
        is_lead: {
          type: "boolean",
          instructions:
            "Does the comment come from a person who could become a paying customer and shows purchase or booking interest?",
          criteria: {
            true: "A potential customer showing concrete interest in booking or buying.",
            false: "General chat, spam, a pure complaint without purchase interest, or an existing customer service issue.",
          },
        },
        needs_human: {
          type: "boolean",
          instructions:
            "Should a human handle this comment because it involves a complaint, a refund or compensation demand, legal risk, price negotiation, or sensitive personal data?",
          criteria: {
            true: "Complaint, compensation, legal risk, negotiation, or sensitive personal data.",
            false: "A routine inquiry, a simple booking intent, smalltalk or spam with no risk signal.",
          },
        },
      },
    };
  },
  decide(result: JevCallResult): SceneDecision {
    const intent = answer(result, "intent");
    const lead = answer(result, "is_lead");
    const human = answer(result, "needs_human");
    const decision = intent.choice ?? "unknown";
    return {
      decision,
      decisionZh: COMMENT_INTENT_ZH[decision] ?? decision,
      confidence: intent.confidence,
      confidenceDerived: intent.confidenceDerived,
      details: {
        is_lead: lead.probability ?? 0,
        needs_human: human.probability ?? 0,
      },
    };
  },
};

/* ------------------------------------------------------------------ */
/* 场景 2：线索分级                                                     */
/* ------------------------------------------------------------------ */

const LEAD_LEVELS = [
  "No purchase intent is expressed; the message is informational or social only.",
  "Interested but vague: asks about the offering without a concrete purchase step.",
  "Clear intent: states a concrete booking, buying or reserving action, or asks how to pay and proceed.",
] as const;

const LEAD_LEVEL_ZH: Record<string, string> = { "0": "低意向", "1": "中意向", "2": "高意向" };

/**
 * 档位落点：**按概率分布取最高档，并列取低档**（而不是四舍五入 score）
 *
 * 首次真机复跑暴露的问题（2026-09-21）：l-03「随便看看，先了解一下」两次运行给出 score 0.48 / 0.50，
 * 分布其实是 {0:0.5, 1:0.5} 的**平票**；原来用 `Math.round(score)` 取档，0.5 被静默抬到「中意向」，
 * 同一句话在两轮里给出不同档位。分数是"加权均值"，在边界上被噪声推一下就会翻档；
 * 而分布本身就带着"模型在两级之间"的信息。
 *
 * 规则：
 *   ① 取概率最高的档位；并列时取**更低**档（保守：不把线索往高意向夸）；
 *   ② 最高与次高概率差 ≤ `LEAD_TIE_MARGIN` 视为"贴边界"，标记 ambiguous=1（分流强制进人审队列）；
 *   ③ 原始 score（加权均值）仍进 details，供人审与口径对照，但不再直接决定档位。
 */
export const LEAD_TIE_MARGIN = 0.1;

export function leadLevelDecision(
  probabilities: Record<string, number>,
  levelCount: number,
): { level: number; gap: number; ambiguous: boolean } {
  const probs = Array.from({ length: levelCount }, (_, index) => probabilities[String(index)] ?? 0);
  let level = 0;
  for (let index = 1; index < probs.length; index += 1) {
    if ((probs[index] ?? 0) > (probs[level] ?? 0)) level = index; // 严格大于 → 并列取低档
  }
  const top = probs[level] ?? 0;
  const second = probs.reduce((max, value, index) => (index === level ? max : Math.max(max, value)), 0);
  const gap = top - second;
  // 浮点容差：概率来自 JSON 小数（如 0.55 - 0.45 = 0.10000000000000003），恰好卡阈值时必须仍判贴边界
  return { level, gap, ambiguous: gap <= LEAD_TIE_MARGIN + 1e-9 };
}

export const leadQualifyScene: Scene = {
  key: "lead-qualify",
  version: "1.0.0",
  description: "线索分级：购买意向强度（有序档位）+ 预算/时间/决策人三个事实问题",
  primary: { id: "intent_strength", type: "score" },
  labelsZh: LEAD_LEVEL_ZH,
  build(input: SceneInput): JevRequest {
    return {
      state: {
        task: "Qualify one sales lead for a Chinese hospitality and travel business.",
        message: input.text,
        ...(input.context ? { context: input.context } : {}),
      },
      questions: {
        intent_strength: {
          type: "score",
          instructions:
            "How concrete is this person's purchase or booking intent, judging only what the message states?",
          criteria: [...LEAD_LEVELS],
        },
        budget_stated: {
          type: "boolean",
          instructions: "Does the message state or ask about a budget, price range, or spending limit?",
        },
        timeline_stated: {
          type: "boolean",
          instructions:
            "Does the message mention a time horizon for the booking or purchase, such as this month, next week, or a specific trip date?",
        },
        decision_maker: {
          type: "boolean",
          instructions:
            "Does the message suggest the sender can decide or pay for this purchase themselves, for example by asking how to pay or to hold a room?",
        },
      },
    };
  },
  decide(result: JevCallResult): SceneDecision {
    const strength = answer(result, "intent_strength");
    const rawScore = strength.score ?? 0;
    const { level, gap, ambiguous } = leadLevelDecision(
      strength.probabilities ?? {},
      LEAD_LEVELS.length,
    );
    const decision = String(level);
    const ids = ["intent_strength", "budget_stated", "timeline_stated", "decision_maker"] as const;
    return {
      decision,
      decisionZh: LEAD_LEVEL_ZH[decision] ?? decision,
      confidence: conservativeConfidence(result, ids),
      confidenceDerived: anyDerived(result, ids),
      details: {
        intent_strength: Number(rawScore.toFixed(3)),
        level_gap: Number(gap.toFixed(3)),
        ambiguous: ambiguous ? 1 : 0,
        budget_stated: answer(result, "budget_stated").probability ?? 0,
        timeline_stated: answer(result, "timeline_stated").probability ?? 0,
        decision_maker: answer(result, "decision_maker").probability ?? 0,
      },
    };
  },
};

/* ------------------------------------------------------------------ */
/* 场景 3：事实红线预检（G-GEO2 的前置影子，不替代围栏）                  */
/* ------------------------------------------------------------------ */

const PRE_IDS = ["premise_supported", "invented_specifics", "brand_stance_risk"] as const;

/**
 * 事实预检的代码侧判定规则（**模型只给概率，标签由代码定**）
 *
 * 首次真机考卷暴露的问题（2026-09-21，真实 Jev 1.13）：原规则「invented>0.5 或 stance>0.5 → risk」
 * 会在两种情况下误判——
 *   ① 前提已被官方口径支撑（premise=0.83），但品牌表态是**抛硬币**（stance=0.52）→ 被翻成 risk；
 *   ② 前提完全不在口径内（premise=0.03），同时表态分很高（stance=0.86）→ 标签该是 unsupported
 *      （操作员要修的是「口径外的事实」），却被表态分抢走标签。
 *
 * 因此规则改为「红线优先 + 边界不翻标签」三段式：
 *   ① 编造具体信息（数字/奖项/认证/第三方背书）≥ 0.6 → `risk`（一票红线，最高优先，与围栏 G-GEO2 同向）；
 *   ② 前提支撑 < 0.5 → `unsupported`（主问题判定用中点，因为问的就是"是否在口径内"）；
 *   ③ 前提成立、但品牌表态 ≥ 0.6 → `risk`；
 *   ④ 其余 → `pass`。
 * 阈值取 0.6 而不是 0.5：Noul **没有置信度字段**（官方文档），0.5x 只代表"模型也拿不准"，
 * 不足以据此贴合规风险标签；且本场景任何非 pass 结论都强制人工，改标签不改变"不会自动放行"。
 *
 * 注意：本规则是在 n=4 的合成考卷 + 首次真机结果上定的**暂定校准**，必须用真实脱敏样本复核
 * （判据见 README §3：先看校准，再看准确率）。
 */
export const PRE_RISK_THRESHOLD = 0.6;
export const PRE_SUPPORT_THRESHOLD = 0.5;

export interface FactPrecheckSignals {
  /** 前提是否在官方口径内（Noul 概率） */
  premiseSupported: number;
  /** 是否编造了官方口径之外的具体信息（Noul 概率） */
  inventedSpecifics: number;
  /** 是否替品牌做出需人审的表态/承诺（Noul 概率） */
  brandStanceRisk: number;
}

/** 纯函数：三个信号 → 预检标签（可单测、可审计；不依赖模型调用） */
export function factPrecheckDecision(signals: FactPrecheckSignals): { decision: string; decisionZh: string } {
  const { premiseSupported, inventedSpecifics, brandStanceRisk } = signals;
  let decision: "pass" | "unsupported" | "risk";
  if (inventedSpecifics >= PRE_RISK_THRESHOLD) {
    decision = "risk";
  } else if (premiseSupported < PRE_SUPPORT_THRESHOLD) {
    decision = "unsupported";
  } else if (brandStanceRisk >= PRE_RISK_THRESHOLD) {
    decision = "risk";
  } else {
    decision = "pass";
  }
  const decisionZh =
    decision === "risk" ? "疑似编造/表态风险" : decision === "unsupported" ? "前提超出口径" : "预检通过";
  return { decision, decisionZh };
}

export const factPrecheckScene: Scene = {
  key: "fact-precheck",
  version: "1.0.0",
  description: "GEO 草稿事实红线预检：前提是否在官方口径内 / 是否编造具体信息 / 是否是品牌表态",
  primary: { id: "premise_supported", type: "boolean" },
  build(input: SceneInput): JevRequest {
    const claims = input.officialClaims ?? [];
    if (claims.length === 0) {
      // 没有官方口径就无从判断「是否超出口径」——fail-closed，不允许拿空清单去猜
      throw new Error("fact-precheck 需要 officialClaims（官方口径清单），拒绝空清单预检");
    }
    return {
      state: {
        task: "Check whether a marketing draft stays within the official claims of a hospitality business.",
        draft: input.text,
        official_claims: claims,
        ...(input.context ? { context: input.context } : {}),
      },
      questions: {
        premise_supported: {
          type: "boolean",
          instructions:
            "Does every factual premise this draft relies on appear in the official claims list?",
          criteria: {
            true: "All factual premises are supported by the official claims list.",
            false: "At least one factual premise is not supported, or adds conditions the list does not state.",
          },
        },
        invented_specifics: {
          type: "boolean",
          instructions:
            "Does the draft state specific numbers, awards, certifications, partner names or third-party endorsements that are absent from the official claims list?",
        },
        brand_stance_risk: {
          type: "boolean",
          instructions:
            "Does the draft make a brand-level promise, guarantee, or stance on behalf of the company that would need human approval before publishing?",
        },
      },
    };
  },
  decide(result: JevCallResult): SceneDecision {
    const premise = answer(result, "premise_supported");
    const invented = answer(result, "invented_specifics");
    const stance = answer(result, "brand_stance_risk");
    const inventedP = invented.probability ?? 0;
    const stanceP = stance.probability ?? 0;
    const premiseP = premise.probability ?? 0;
    const { decision, decisionZh } = factPrecheckDecision({
      premiseSupported: premiseP,
      inventedSpecifics: inventedP,
      brandStanceRisk: stanceP,
    });
    return {
      decision,
      decisionZh,
      confidence: conservativeConfidence(result, PRE_IDS),
      confidenceDerived: anyDerived(result, PRE_IDS),
      details: {
        premise_supported: premiseP,
        invented_specifics: inventedP,
        brand_stance_risk: stanceP,
      },
    };
  },
};

export const SCENES: Record<SceneKey, Scene> = {
  "comment-classify": commentClassifyScene,
  "lead-qualify": leadQualifyScene,
  "fact-precheck": factPrecheckScene,
};

export function sceneOf(key: string): Scene {
  const scene = SCENES[key as SceneKey];
  if (!scene) {
    throw new Error(`未知场景：${key}（可选：${Object.keys(SCENES).join(", ")}）`);
  }
  return scene;
}

/** 供报告与日志使用的可读摘要（不含 state 原文，避免把客户文本带进日志） */
export function summarizeDecision(decision: SceneDecision): string {
  const details = Object.entries(decision.details)
    .map(([key, value]) => `${key}=${typeof value === "number" ? percent(value) : value}`)
    .join(" ");
  return `${decision.decisionZh}(${decision.decision}) conf=${percent(decision.confidence)}${details ? ` ${details}` : ""}`;
}
