import { describe, expect, it } from "vitest";
import {
  VIDEO_AUTO_APPROVAL_ACTOR_ID,
  VIDEO_AUTO_APPROVAL_POLICY_VERSION,
  autoApproveVideoFence,
  isAiVideoPreset,
  isVideoApprovalGate,
  videoAutoApprovalEnabled,
  videoAutoReviewPolicy,
} from "./auto-approval.js";

describe("视频管线系统自动审批策略", () => {
  it("默认启用，VIDEO_AUTO_APPROVAL=0 可整体回滚", () => {
    expect(videoAutoApprovalEnabled({})).toBe(true);
    expect(videoAutoApprovalEnabled({ VIDEO_AUTO_APPROVAL: "1" })).toBe(true);
    expect(videoAutoApprovalEnabled({ VIDEO_AUTO_APPROVAL: "0" })).toBe(false);
  });

  it("按视频 preset 与显式视频动作生效，不把无关业务自动放行", () => {
    expect(isAiVideoPreset("director")).toBe(true);
    expect(isAiVideoPreset("comment-operator")).toBe(true);
    expect(videoAutoReviewPolicy({ presetKey: "director", action: "video.project.create" })).toMatchObject({
      status: "approved",
      actorId: VIDEO_AUTO_APPROVAL_ACTOR_ID,
      policyVersion: VIDEO_AUTO_APPROVAL_POLICY_VERSION,
    });
    expect(videoAutoReviewPolicy({ action: "render.submit", objectType: "render_script" })).toMatchObject({
      status: "approved",
    });
    expect(videoAutoReviewPolicy({ presetKey: "pricing-agent", action: "price.adjust", objectType: "room_price" })).toEqual({
      status: "not_applicable",
    });
    expect(videoAutoReviewPolicy({
      presetKey: "director",
      action: "creative.reedit",
      objectType: "creative",
    })).toEqual({ status: "not_applicable" });
    expect(videoAutoReviewPolicy({
      presetKey: "director",
      action: "dossier.confirm",
      objectType: "dossier",
      reviewRuleIds: ["G1"],
    })).toMatchObject({ status: "approved" });
    expect(videoAutoReviewPolicy({
      presetKey: "bgm-composer",
      action: "bgm.mix",
      objectType: "bgm_track",
      reviewRuleIds: ["G-BGM1"],
    })).toEqual({ status: "not_applicable" });
    expect(isVideoApprovalGate("G1_DOSSIER")).toBe(true);
    expect(isVideoApprovalGate("G5_PORTRAIT")).toBe(true);
    expect(isVideoApprovalGate("G10c")).toBe(true);
    expect(isVideoApprovalGate("G-BGM1")).toBe(false);
  });

  it("关闭策略后所有视频动作恢复原有审批路径", () => {
    expect(videoAutoReviewPolicy({
      presetKey: "director",
      action: "render.submit",
      objectType: "render_script",
      env: { VIDEO_AUTO_APPROVAL: "0" },
    })).toEqual({ status: "not_applicable" });
  });

  it("围栏 review 自动转 auto，block 始终原样保留", () => {
    const review = {
      level: "review" as const,
      impacts: [{ rule_id: "G9", version: "v2", result: "review" as const }],
      triggeredBy: ["公网发布必审"],
      evalErrors: [],
    };
    expect(autoApproveVideoFence(review)).toEqual({
      verdict: { ...review, level: "auto" },
      autoApproved: true,
    });
    const block = {
      level: "block" as const,
      impacts: [{ rule_id: "G9b", version: "v2", result: "blocked" as const }],
      triggeredBy: ["单账号日发布超限熔断"],
      evalErrors: [],
    };
    expect(autoApproveVideoFence(block)).toEqual({ verdict: block, autoApproved: false });
    expect(autoApproveVideoFence(review, { VIDEO_AUTO_APPROVAL: "0" })).toEqual({
      verdict: review,
      autoApproved: false,
    });
  });

  it("质量与许可 review、求值异常不得被系统自动审批降级", () => {
    const protectedReview = {
      level: "review" as const,
      impacts: [{ rule_id: "G-DLV5", version: "v1", result: "review" as const }],
      triggeredBy: ["镜头重生成（花钱）人审"],
      evalErrors: [],
    };
    expect(autoApproveVideoFence(protectedReview)).toEqual({
      verdict: protectedReview,
      autoApproved: false,
    });

    const unevaluable = {
      level: "review" as const,
      impacts: [],
      triggeredBy: [],
      evalErrors: ["G9: missing context"],
    };
    expect(autoApproveVideoFence(unevaluable)).toEqual({
      verdict: unevaluable,
      autoApproved: false,
    });
  });
});
