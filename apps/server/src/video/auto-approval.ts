/**
 * GrowthTest 视频管线的系统自动审批策略。
 *
 * 产品所有者 2026-10-31 明确授权：视频管线取消人类审批等待，但保留原有质量审核、
 * 围栏 block、预算、授权、资格和真实回执检查。自动审批只替换“人等结果”这一步，
 * 不替换任何质量判断或安全硬闸。
 */
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { JudgeVerdict } from "@workloom/base/fence-engine";

export const VIDEO_AUTO_APPROVAL_POLICY_VERSION = "workloom.video-auto-approval/v1" as const;
export const VIDEO_AUTO_APPROVAL_ACTOR_ID = "video-auto-approval" as const;

const here = path.dirname(fileURLToPath(import.meta.url));
const VIDEO_PRESET_DIR = path.resolve(here, "../../../../bundles/ai-video/presets");
const AUTO_APPROVABLE_VIDEO_RULES = new Set([
  "G1", "G2", "G3", "G4", "G5", "G6", "G7", "G8", "G9", "G9a",
  "G10", "G10a", "G10b", "G10c", "G11", "G12", "G15",
]);

export interface AutoReviewPolicyResult {
  status: "approved" | "not_applicable";
  actorId?: typeof VIDEO_AUTO_APPROVAL_ACTOR_ID;
  policyVersion?: typeof VIDEO_AUTO_APPROVAL_POLICY_VERSION;
  reason?: string;
}

/**
 * `VIDEO_AUTO_APPROVAL=0` 是兼容与回滚开关。默认开启是产品所有者本轮明确要求；
 * 关闭后只恢复等待审批路径，不会降低任何质量检查。
 */
export function videoAutoApprovalEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.VIDEO_AUTO_APPROVAL !== "0";
}

/** 视频 bundle 的岗位是自动审批的主作用域，按仓内 preset 文件判定，不靠岗位名猜测。 */
export function isAiVideoPreset(presetKey: string): boolean {
  if (!/^[a-z0-9][a-z0-9-]{1,119}$/u.test(presetKey)) return false;
  return existsSync(path.join(VIDEO_PRESET_DIR, `${presetKey}.yml`))
    || existsSync(path.join(VIDEO_PRESET_DIR, `${presetKey}.yaml`));
}

/** 视频动作/对象是否具有显式作用域；岗位归属只在确认门能够证明视频范围时参与判断。 */
export function isAiVideoAction(input: { action: string; objectType?: string; presetKey?: string }): boolean {
  if (input.objectType === "video_project" || input.objectType === "render_script"
    || input.objectType === "publish_task" || input.objectType === "comment_reply"
    || input.objectType === "ads_campaign" || input.objectType === "budget_ledger"
    || input.objectType === "deal_order") return true;
  return /^(?:video|render|publish|comment|ads|deal)\./u.test(input.action);
}

export function isVideoApprovalGate(gateKey: string): boolean {
  const normalized = gateKey
    .replace(/^G1_DOSSIER$/u, "G1")
    .replace(/^G2_THEME$/u, "G2")
    .replace(/^G3_INSIGHT$/u, "G3")
    .replace(/^G4_PRD$/u, "G4")
    .replace(/^G5_PORTRAIT$/u, "G5")
    .replace(/^G6_PROMPT$/u, "G6")
    .replace(/^G7_FINAL$/u, "G7")
    .replace(/^G10[a-d]?$/u, "G10");
  return AUTO_APPROVABLE_VIDEO_RULES.has(normalized);
}

export function videoAutoReviewPolicy(input: {
  presetKey?: string;
  action: string;
  objectType?: string;
  reviewRuleIds?: string[];
  env?: NodeJS.ProcessEnv;
}): AutoReviewPolicyResult {
  if (!videoAutoApprovalEnabled(input.env)) return { status: "not_applicable" };
  const reviewRuleIds = input.reviewRuleIds ?? [];
  const hasReviewRules = reviewRuleIds.length > 0;
  if (hasReviewRules && reviewRuleIds.some((ruleId) => !isVideoApprovalGate(ruleId))) {
    return { status: "not_applicable" };
  }
  /**
   * 视频岗位本身不能证明动作属于视频域：同一岗位可能执行通用复盘、素材整理等
   * default-review 步骤。只有显式视频动作/对象，或命中已登记的视频确认门时才生效。
   */
  const videoPreset = Boolean(input.presetKey && isAiVideoPreset(input.presetKey));
  const videoGate = hasReviewRules && reviewRuleIds.every(isVideoApprovalGate);
  if (!isAiVideoAction(input) && !(videoPreset && videoGate)) return { status: "not_applicable" };
  return {
    status: "approved",
    actorId: VIDEO_AUTO_APPROVAL_ACTOR_ID,
    policyVersion: VIDEO_AUTO_APPROVAL_POLICY_VERSION,
    reason: `视频管线系统自动审批（${VIDEO_AUTO_APPROVAL_POLICY_VERSION}）：保留质量审核与围栏硬闸，取消人类等待`,
  };
}

export function videoAutoApprovalReason(scope: string): string {
  return `${scope}：${VIDEO_AUTO_APPROVAL_POLICY_VERSION} 系统自动审批；质量审核与 block 硬闸保持不变`;
}

/** 把围栏 review 转成系统 auto；block 原样保留，绝不因策略开关放宽。 */
export function autoApproveVideoFence<T extends JudgeVerdict>(
  verdict: T,
  env: NodeJS.ProcessEnv = process.env,
): { verdict: T; autoApproved: boolean } {
  /**
   * 只转换可自动审批门触发的 review。质量/许可类 review 必须保持原级，
   * 否则带 G-DLV5/G-BGM1 等规则的 render.submit 会在直连路由里绕过其人工裁决。
   * 围栏求值异常也不得被系统审批掩盖。
   */
  const hasProtectedReview = (verdict.impacts ?? []).some((impact) =>
    impact.result === "review" && !isVideoApprovalGate(impact.rule_id));
  if (verdict.level !== "review" || (verdict.evalErrors?.length ?? 0) > 0
    || hasProtectedReview || !videoAutoApprovalEnabled(env)) {
    return { verdict, autoApproved: false };
  }
  return {
    verdict: { ...verdict, level: "auto" },
    autoApproved: true,
  };
}
