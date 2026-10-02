import { describe, expect, it } from "vitest";
import {
  resolveDeliveryTargets, buildDirectorDefaults, buildPostVariantPlans,
  assessPostVariantDifference, mapCuesToTimeline, attributeCreativeFeedback,
  validateCreativeDelegation, createCreativeDelegation, directorHash,
  applyTimelineFeedback,
} from "../../../bundles/ai-video/library/director-system/core.mjs";

const sources = {
  fps: 30, chronologyLocked: false,
  shots: ["establishing", "hero", "action", "detail", "resolution"].map((role, i) => ({
    shotId: `SC-${i + 1}`, sha256: String(i + 1).repeat(64), durationSec: 6,
    role, dialogue: i === 2 ? "这是我的选择。" : "", required: true,
  })),
};

describe("一句话导演与四版本合同", () => {
  it("无平台默认三平台和独立惊喜版", () => {
    const plan = resolveDeliveryTargets("生日短片，让我漂亮一点");
    expect(plan.regular.map(x => x.platform)).toEqual(["douyin", "xiaohongshu", "wechat-channels"]);
    expect(plan.expectedOutputs).toBe(4);
    expect(plan.targets.at(-1)?.kind).toBe("surprise");
  });
  it.each(["抖音", "小红书", "视频号"])("单平台 %s 有三个不同表达和惊喜", platform => {
    const plan = resolveDeliveryTargets(`发${platform}`);
    expect(plan.regular).toHaveLength(3);
    expect(new Set(plan.regular.map(x => x.platform)).size).toBe(1);
    expect(new Set(plan.regular.map(x => x.recipeId)).size).toBe(3);
    expect(plan.targets).toHaveLength(4);
  });
  it("排除、风格参照与发布目的分开", () => {
    expect(resolveDeliveryTargets("不要抖音，只发视频号").platforms).toEqual(["wechat-channels"]);
    expect(resolveDeliveryTargets("像抖音那样有冲击力但发小红书").platforms).toEqual(["xiaohongshu"]);
    expect(resolveDeliveryTargets("发抖音和小红书").regular).toHaveLength(2);
  });
  it("显式数量和不额外交付有效", () => {
    expect(resolveDeliveryTargets("视频号，只要一版").expectedOutputs).toBe(1);
    expect(resolveDeliveryTargets("不要导演惊喜版").targets.some(x => x.kind === "surprise")).toBe(false);
    expect(() => resolveDeliveryTargets("", { platforms: ["unknown"] })).toThrow();
  });
  it("来源与人物授权缺口可辨，普通创作不发问卷", () => {
    const a = buildDirectorDefaults({ intent: "我本人生日，要漂亮一些", identityAssets: [] });
    expect(a.requiredInputs).toEqual(["IDENTITY_ASSET_REQUIRED"]);
    const b = buildDirectorDefaults({ intent: "民宿电影感", identityAssets: [] });
    expect(b.requiredInputs).toHaveLength(0);
    expect(b.confirmationSteps).toBe(0);
    expect(b.presentation.skinTexture).toContain("自然");
    expect(b.defaults.every(x => x.origin === "default" || x.origin === "inferred")).toBe(true);
  });
  it("每版独立 EDL，完整保留说话镜，时间轴连续", () => {
    const plans = buildPostVariantPlans({ sourceManifest: sources, targetPlan: resolveDeliveryTargets("民宿") });
    expect(plans).toHaveLength(4);
    expect(new Set(plans.map(p => directorHash(p.pictureEdl))).size).toBe(4);
    for (const p of plans) {
      expect(p.musicPlan.allowOriginalScore).not.toBe(true);
      expect(p.musicPlan.sourcePolicy).toContain("缺曲时如实失败");
      const speech = p.pictureEdl.find(x => x.sourceId === "SC-3")!;
      expect(speech.inFrame).toBe(0);
      expect(speech.outFrame).toBe(180);
      expect(p.pictureEdl.every((x, i, es) => x.startFrame === (i ? es[i - 1]!.startFrame + es[i - 1]!.outFrame - es[i - 1]!.inFrame : 0))).toBe(true);
    }
  });
  it("字幕跟随 EDL 重排；切断一句话失败", () => {
    const p = buildPostVariantPlans({ sourceManifest: sources, targetPlan: resolveDeliveryTargets("民宿") })[0]!;
    const mapped = mapCuesToTimeline([{ startSec: 12.2, endSec: 14.6, text: "这是我的选择。" }], p, sources);
    const speech = p.pictureEdl.find(x => x.sourceId === "SC-3")!;
    expect(mapped[0]?.startSec).toBeCloseTo(speech.startFrame / 30 + .2, 4);
    expect(() => mapCuesToTimeline([{ startSec: 5.8, endSec: 6.2, text: "不能拆的句子" }], p, sources)).toThrow();
  });
  it("计划差异不是实际出片证据，相同剪辑无法靠音量过门", () => {
    const ps = buildPostVariantPlans({ sourceManifest: sources, targetPlan: resolveDeliveryTargets("民宿") });
    expect(assessPostVariantDifference(ps).approved).toBe(false);
    const actual = ps.map(p => ({ variantId: p.variantId, planHash: p.planHash,
      edlVerified: true, videoSha256: directorHash(p.variantId), durationFrames: p.durationFrames,
      pictureEdl: p.pictureEdl, visualVerified: true, coverVerified: true, coverSha256: directorHash(p.variantId + "cover"),
      colorSignature: directorHash(p.gradePlan), audioSignature: null, subtitleSignature: null,
    }));
    expect(assessPostVariantDifference(ps, actual).approved).toBe(true);
    actual[1]!.pictureEdl = actual[0]!.pictureEdl;
    expect(assessPostVariantDifference(ps, actual).approved).toBe(false);
  });
  it("反馈按层归因，模糊审美优先可回滚后期", () => {
    expect(attributeCreativeFeedback("第二版配乐轻一点").patch.bgm?.musicLevelDb).toBe(-27);
    expect(attributeCreativeFeedback("再酷一点，别像广告").requiresNewRender).toBe(false);
    expect(attributeCreativeFeedback("第三镜换成雪山，主角跑起来").requiresNewRender).toBe(true);
  });
  it("中文镜号节奏反馈只调整既有静默画面，重建样点时间线并保护完整台词", () => {
    const plans = buildPostVariantPlans({ sourceManifest: sources, targetPlan: resolveDeliveryTargets("民宿") });
    expect(plans).toHaveLength(4);
    const first = plans[0]!;
    const feedback = attributeCreativeFeedback("第一版第三镜太快，多留一点");
    expect(feedback.patch.timeline?.shotIds).toEqual(["SC-3"]);
    expect(feedback.patch.timeline).toBeDefined();
    // This exact source is speech protected, so extending it cannot fabricate footage.
    expect(() => applyTimelineFeedback(first, sources, feedback.patch.timeline!)).toThrow();
    const changed = applyTimelineFeedback(first, sources, { shotIds: ["SC-1"], factor: 1.35, pace: "slower" });
    expect(changed.durationFrames).toBeGreaterThan(first.durationFrames);
    expect(changed.pictureEdl.find(e => e.sourceId === "SC-3")?.outFrame).toBe(180);
    expect(changed.pictureEdl.every((e, i, es) => e.startFrame === (i ? es[i-1]!.startFrame+es[i-1]!.outFrame-es[i-1]!.inFrame : 0))).toBe(true);
    expect(changed.audioEdl.every((e,i) => e.startSample === changed.pictureEdl[i]!.startFrame * 1600)).toBe(true);
    expect(() => applyTimelineFeedback(first, sources, { shotIds: ["SC-99"], factor: 1.35 })).toThrow();
  });
  it("委托绑定作用域、运行、素材与有效期，不冒充人审", () => {
    const scope = { tenantId: "t1", workspaceId: "w1", projectId: "p1", runId: "r1" };
    const d = createCreativeDelegation({ ...scope, grantedBy: "member1", grantEventId: "evt1", identityAssetRefs: ["asset://a"], maxBudgetCny: 50 });
    expect(d.decisionSource).toBe("delegated-creative-review");
    expect(validateCreativeDelegation(d, scope).valid).toBe(true);
    expect(validateCreativeDelegation(d, { ...scope, tenantId: "t2" }).valid).toBe(false);
    expect(validateCreativeDelegation({ ...d, expiresAt: "2000-01-01T00:00:00Z" }, scope).valid).toBe(false);
    expect(validateCreativeDelegation({ ...d, grantedBy: "other" }, scope).valid).toBe(false);
  });
});
