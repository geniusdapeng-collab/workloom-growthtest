/**
 * 封面设计师回归（2026-09-25 产品所有者口径：封面不能只有标题）
 *
 * 三条硬口径：
 *   ① 设计稿必须"画面 + 人物 + 标题"三件套，越界/超长/缺人物位即判非法；
 *   ② 设计师不可用要有兜底稿，且兜底稿同样满足三件套（不允许退化成"只有标题"）；
 *   ③ 渲染后的机检必须能识别"字没画上/人物层没合成/底图带字幕/文字压进遮挡区"四类事故。
 */
import { describe, expect, it } from "vitest";
import {
  COVER_DIFF_PSNR_DB,
  COVER_SAFE_AREA,
  CoverDesignError,
  buildCoverDesignPrompt,
  coverDeterministicChecks,
  fallbackCoverPlan,
  parseCoverPlan,
  validateCoverPlan,
  type CoverDesignInput,
  type CoverMeasurements,
  type CoverPlan
} from "./cover-design.js";

const input: CoverDesignInput = {
  title: "滕王阁 · 落霞秋水",
  platform: "小红书",
  brief: { platform: "小红书", goal: "让观众 30 秒认识滕王阁并产生想去", tone: "亲切开场 + 快剪震撼", coverHook: "滕王阁 落霞秋水" },
  character: { id: "chen-zhuo", name: "陈卓" },
  shots: [
    { shotId: "SC-01", scene: "傍晚天台，人物口播", hasCharacter: true, dialogueText: "大家好，我是陈卓" },
    { shotId: "SC-02", scene: "滕王阁白天全景", hasCharacter: false, dialogueText: "南昌滕王阁，江南名楼之首" },
    { shotId: "SC-05", scene: "滕王阁夜景灯光", hasCharacter: false, dialogueText: "今晚的滕王阁" }
  ]
};

const validPlan: CoverPlan = {
  headline: "落霞秋水\n滕王阁",
  subline: "陈卓带你 30 秒看懂",
  badge: "南昌 · 江南名楼",
  layout: "person-right",
  background: { shotId: "SC-05", atSec: 1.2, treatment: "grade" },
  person: { enabled: true, shotId: "SC-01", atSec: 1.1, widthRatio: 0.42 },
  typography: { fontId: "source-han-heavy", headlineSizeRatio: 0.075, sublineSizeRatio: 0.034, color: "#FFFFFF", accentColor: "#FFD166", align: "left" },
  rationale: "夜景地标 + 人物 + 大字标题，一眼看懂地点与人",
  source: "llm"
};

describe("封面设计稿", () => {
  it("提示词把版式（两种主视觉）与安全区写清楚（设计师不能只交标题）", () => {
    const prompt = buildCoverDesignPrompt(input);
    expect(prompt).toContain("禁止只有一行标题");
    /**
     * 2026-09-26 产品口径：封面只有两种主视觉——人物为主 / 物体为主（景物·商品·动物等非人主体）。
     * 旧提示词写死"必须有人物肖像卡"，导致人物小图贴地标（两种主视觉打架）——这条断言随口径一起改。
     */
    expect(prompt).toContain("版式（archetype）二选一");
    expect(prompt).toContain("subject-led");
    expect(prompt).toContain("person-led");
    expect(prompt).toContain("底部 12% 不放任何文字");
    expect(prompt).toContain("rationale");
    expect(prompt).toContain("SC-05");
  });

  it("合法设计稿通过校验；缺人物位/超长标题/越界字级被拒", () => {
    expect(() => validateCoverPlan(validPlan, input)).not.toThrow();

    expect(() => validateCoverPlan({ ...validPlan, headline: "落霞秋水共长天一色的滕王阁夜景" }, input))
      .toThrowError(CoverDesignError);
    expect(() => validateCoverPlan({ ...validPlan, person: { enabled: true, widthRatio: 0.42 } }, input))
      .toThrow(/人物卡开启但没有来源镜头/);
    expect(() => validateCoverPlan({ ...validPlan, person: { ...validPlan.person, widthRatio: 0.9 } }, input))
      .toThrow(/人物卡宽度比例/);
    expect(() => validateCoverPlan({ ...validPlan, typography: { ...validPlan.typography, headlineSizeRatio: 0.3 } }, input))
      .toThrow(/主标题字级/);
    expect(() => validateCoverPlan({ ...validPlan, typography: { ...validPlan.typography, fontId: "comic-sans" as never } }, input))
      .toThrow(/不在白名单/);
    expect(() => validateCoverPlan({ ...validPlan, background: { ...validPlan.background, shotId: "SC-99" } }, input))
      .toThrow(/不在镜头表里/);
  });

  it("解析容忍 markdown 包裹，非法 JSON 明确抛错", () => {
    const raw = "```json\n" + JSON.stringify(validPlan) + "\n```";
    const parsed = parseCoverPlan(raw, input);
    expect(parsed.headline).toContain("滕王阁");
    expect(parsed.source).toBe("llm");
    expect(() => parseCoverPlan("我觉得可以做得很高级", input)).toThrowError(CoverDesignError);
  });

  it("人物来源镜头由管线注入：设计师只决定'要不要人物卡、放多宽'（避免模型编造素材路径）", () => {
    const designerPlan = { ...validPlan, person: { enabled: true, widthRatio: 0.4 } } as unknown as CoverPlan;
    /** 不给来源 → 校验拦住（人物卡不能空着） */
    expect(() => parseCoverPlan(JSON.stringify(designerPlan), input)).toThrow(/人物卡开启但没有来源镜头/);
    /** 管线注入来源镜头 → 放行，且来源来自管线而不是模型 */
    const parsed = parseCoverPlan(JSON.stringify(designerPlan), input, { personShotId: "SC-01", personAtSec: 1.4 });
    expect(parsed.person.shotId).toBe("SC-01");
    expect(parsed.person.atSec).toBe(1.4);
  });

  it("兜底稿也必须是三件套（人物 + 画面 + 标题），不能退化回只有标题", () => {
    const plan = fallbackCoverPlan(input, { headline: "滕王阁 落霞秋水", heroShotId: "SC-05", personShotId: "SC-01" });
    expect(plan.source).toBe("fallback");
    expect(plan.person.enabled).toBe(true);
    expect(plan.subline).toContain("陈卓");
    expect(plan.background.shotId).toBe("SC-05");
    expect(plan.headline.length).toBeLessThanOrEqual(12);
  });
});

describe("封面机检", () => {
  const measure = (patch: Partial<CoverMeasurements> = {}): CoverMeasurements => ({
    bytes: 1_400_000, width: 1080, height: 1920,
    titleBandPsnrDb: 18.4, personBoxPsnrDb: 22.7,
    backgroundMatchesCleanMaster: true,
    titleTopRatio: 0.09, titleBottomRatio: 0.33, bottomBandInkRatio: 0.001,
    ...patch
  });
  const byId = (checks: ReturnType<typeof coverDeterministicChecks>, id: string) => checks.find((c) => c.id === id)!;

  it("正常封面全部通过", () => {
    const checks = coverDeterministicChecks(measure());
    expect(checks.every((c) => c.pass)).toBe(true);
  });

  it("标题没画上（与无字版几乎一致）判失败", () => {
    const checks = coverDeterministicChecks(measure({ titleBandPsnrDb: COVER_DIFF_PSNR_DB + 12 }));
    expect(byId(checks, "title-rendered").pass).toBe(false);
    expect(byId(checks, "title-rendered").detail).toContain(`${COVER_DIFF_PSNR_DB}dB`);
  });

  it("人物层没合成进去判失败", () => {
    const checks = coverDeterministicChecks(measure({ personBoxPsnrDb: null }));
    expect(byId(checks, "person-layer").pass).toBe(false);
  });

  it("底图带字幕/文字压进平台遮挡区判失败", () => {
    const checks = coverDeterministicChecks(measure({ backgroundMatchesCleanMaster: false, bottomBandInkRatio: 0.08 }));
    expect(byId(checks, "clean-source").pass).toBe(false);
    expect(byId(checks, "safe-area").pass).toBe(false);
    expect(byId(checks, "safe-area").detail).toContain(`${(COVER_SAFE_AREA.bottomReservedRatio * 100).toFixed(0)}%`);
  });
});
