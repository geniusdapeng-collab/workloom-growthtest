/**
 * 置信度分流（shadow 建议，不授予任何写权限）
 *
 * 设计依据：
 *   - 官方定位：置信度用于"决定何时自动、何时转人审"（docs.typesafe.ai/confidence）；
 *   - 第三方早期实测（lindfors.no，2026-09-18）：置信度 ≥0.9 桶 14/15 正确，0.7~0.9 桶 97%，
 *     0.3~0.7 桶 34% —— 因此自动档只取高置信，中段一律人工复核；
 *   - 派生置信度（模型未自报、取最大概率）一律**不得自动**：没有校准信息的数字不能当校准用。
 *
 * 与围栏的关系（必须遵守的系统不变量「先围栏后动作」）：
 *   本模块输出的是"要不要转人工"的建议；真正的动作授权仍由基座围栏 + 审批决定，
 *   且 fact-precheck 的结论**不满足** G-GEO2 的 `context.fact_check_passed` 条件。
 */
import type { GateDecision, Route, SceneDecision, SceneKey } from "./types.js";

export interface GatePolicy {
  /** 置信度 ≥ autoAt 且非派生 → 允许进入自动档（shadow 只记账，不执行） */
  autoAt: number;
  /** 置信度 ≥ reviewAt → 人审队列；低于 → 人工处理 */
  reviewAt: number;
}

export const DEFAULT_GATE: GatePolicy = { autoAt: 0.9, reviewAt: 0.6 };

export const SCENE_GATE: Record<SceneKey, GatePolicy> = {
  // 评论初筛：批量高频，官方证据支持 0.9 以上自动
  "comment-classify": { autoAt: 0.9, reviewAt: 0.6 },
  // 线索分级：直接进销售跟进，档位错会浪费人力，门槛更严
  "lead-qualify": { autoAt: 0.93, reviewAt: 0.7 },
  // 事实预检：涉及外发合规，永不走 auto（由场景规则强制 human/review）
  "fact-precheck": { autoAt: 1.1, reviewAt: 0.6 },
};

function finite(value: number | undefined, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

/**
 * 计算分流建议。规则顺序（先保守后宽松，冲突取更保守结果）：
 *   ① 场景硬规则（fact-precheck 非 pass → human；comment 命中 needs_human → human；
 *      lead-qualify 档位贴边界 → review）
 *   ② 派生置信度 → 至少 review
 *   ③ 阈值：≥autoAt → auto（仅当场景允许）；≥reviewAt → review；否则 human
 */
export function gateDecision(scene: SceneKey, decision: SceneDecision): GateDecision {
  const policy = SCENE_GATE[scene];
  const reasons: string[] = [];
  const confidence = finite(decision.confidence, 0);

  if (scene === "fact-precheck" && decision.decision !== "pass") {
    reasons.push(`fact-precheck=${decision.decision}（合规预检非通过，必须人工）`);
    return { route: "human", reasons, shadow: true };
  }
  if (scene === "comment-classify") {
    const needsHuman = typeof decision.details["needs_human"] === "number" ? decision.details["needs_human"] : 0;
    if (needsHuman > 0.5) {
      reasons.push(`needs_human=${needsHuman.toFixed(2)}（投诉/合规/敏感信号）`);
      return { route: "human", reasons, shadow: true };
    }
  }
  if (scene === "lead-qualify" && decision.details["ambiguous"] === 1) {
    // 档位贴边界（最高两档概率差 ≤ LEAD_TIE_MARGIN）：按概率分布已取更保守的下档，
    // 但"低/中/高"本身要人来定——档位边界的平票不能由代码静默决定（首次真机复跑实测到 score 0.48/0.50 漂移）。
    const gap = typeof decision.details["level_gap"] === "number" ? decision.details["level_gap"] : undefined;
    reasons.push(`档位贴边界（gap=${gap === undefined ? "未知" : gap.toFixed(3)}），需人工确认档位`);
    return { route: "review", reasons, shadow: true };
  }

  if (decision.confidenceDerived) {
    reasons.push("置信度为派生值（模型未自报），不得自动");
  }

  let route: Route;
  if (!decision.confidenceDerived && confidence >= policy.autoAt) {
    route = "auto";
    reasons.push(`confidence=${confidence.toFixed(3)} ≥ autoAt=${policy.autoAt}`);
  } else if (confidence >= policy.reviewAt) {
    route = "review";
    reasons.push(`confidence=${confidence.toFixed(3)} ≥ reviewAt=${policy.reviewAt}`);
  } else {
    route = "human";
    reasons.push(`confidence=${confidence.toFixed(3)} < reviewAt=${policy.reviewAt}`);
  }
  return { route, reasons, shadow: true };
}
