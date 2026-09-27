/**
 * 封面设计师回归（2026-09-25 产品所有者口径：封面不能只有标题）
 *
 * 三条硬口径：
 *   ① 设计稿必须"画面 + 人物 + 标题"三件套，越界/超长/缺人物位即判非法；
 *   ② 设计师不可用要有兜底稿，且兜底稿同样满足三件套（不允许退化成"只有标题"）；
 *   ③ 渲染后的机检必须能识别"字没画上/人物层没合成/底图带字幕/文字压进遮挡区"四类事故。
 */
import { describe, expect, it } from "vitest";
import { coverPrefersNightBackground } from "./cover-design.js";
import {
  COVER_DIFF_PSNR_DB,
  COVER_LOWER_BAND_SAFE_AREA,
  COVER_SAFE_AREA,
  CoverDesignError,
  buildCoverDesignPrompt,
  coverDeterministicChecks,
  fallbackCoverPlan,
  parseCoverPlan,
  validateCoverPlan,
  type CoverAccountProfile,
  type CoverDesignInput,
  type CoverMeasurements,
  type CoverPlan
} from "./cover-design.js";
import { getCoverSpec } from "./cover-platforms.js";

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
    /** 平台化（2026-09-27）：小红书封面是 3:4、底部遮挡 17%、标题带 7%–45% */
    expect(prompt).toContain("竖屏 3:4");
    expect(prompt).toContain("底部 17% 不放任何文字");
    expect(prompt).toContain("上部 7%–45% 的标题带内");
    expect(prompt).toContain("主标题 ≤14 个字");
    expect(prompt).toContain("rationale");
    expect(prompt).toContain("SC-05");
  });

  /**
   * 回归基线（硬约束）：默认平台（抖音，历史默认值就是"抖音/快手"）且不注入 KB/账号档案时，
   * **平台参数相关的提示词行**必须与平台化之前逐字一致——抖音封面行为不得因平台化改变。
   *
   * 唯一有意新增的行是第 7 条"数值边界"：真机（DeepSeek）出稿把 `person.widthRatio` 猜成 0.55
   * （校验区间 0.28–0.50）导致设计稿连打两次回、退兜底稿。把校验区间写进提示词属于
   * "减少无效往返"的确定性改进，不改变任何既有判据本身（见 docs/cover-platformization.md）。
   */
  it("抖音默认路径的提示词：平台参数行与历史逐字一致，且不比历史少任何硬约束", () => {
    const douyinInput: CoverDesignInput = { ...input, platform: "抖音/快手" };
    const prompt = buildCoverDesignPrompt(douyinInput);
    expect(prompt).toContain("平台：抖音/快手（竖屏 9:16，平台 UI 会遮住画面底部约 12%，顶部约 6% 也不宜放字）");
    expect(prompt).toContain("4. 文字全部落在上部 6%–42% 的标题带内，底部 12% 不放任何文字；");
    expect(prompt).toContain("2. 主标题 ≤12 个字，说人话、有钩子");
    /** 新增的数值边界行（真机修复：模型不再自己猜区间） */
    expect(prompt).toContain("7. 数值边界（越界即判非法、直接打回重出）");
    expect(prompt).toContain("`person.widthRatio` 0.28–0.50");
    expect(prompt).not.toContain("【封面知识库】");
    expect(prompt).not.toContain("【账号视觉锤】");
    /** 缺省平台 = 抖音 */
    expect(buildCoverDesignPrompt({ ...input, platform: undefined }))
      .toContain("平台：小红书（竖屏 3:4"); // 标签沿用调用方原文，规格按平台解析
    expect(getCoverSpec(undefined).id).toBe("douyin");
  });

  it("知识库注入：≤3 条、自带篇目前缀、不改变其他行", () => {
    const prompt = buildCoverDesignPrompt({
      ...input,
      kbHints: [
        "【封面知识库·PLAT-003§4】小红书 3:4 画幅，底部 17% 遮挡区不放文字",
        "题材：探店 → 拼图 + 数字清单版式",
        "钩子：价值预览式优先",
        "第四条应被截断"
      ]
    });
    expect(prompt).toContain("【封面知识库·PLAT-003§4】");
    expect(prompt).toContain("【封面知识库】题材：探店");
    expect(prompt).toContain("钩子：价值预览式优先");
    expect(prompt).not.toContain("第四条应被截断");
  });

  it("账号档案注入：视觉锤四件套与禁区进 prompt；偏离视觉锤 warn（strict 才判非法）", () => {
    const profile: CoverAccountProfile = {
      account_id: "chen-zhuo",
      display_name: "陈卓",
      positioning: "城市人文旅行人设号",
      account_type: "人设IP号",
      platforms: ["douyin"],
      visual_hammer: { fontId: "smiley-sans", palette: ["#FFFFFF", "#FFD166"], archetype_bias: "person-led", badge_series: "跟着陈卓走" },
      hook_bias: ["question", "contrast"],
      taboo: ["硬广话术"],
      strict: false
    };
    const prompt = buildCoverDesignPrompt({ ...input, platform: "抖音", accountProfile: profile });
    expect(prompt).toContain("【账号视觉锤】陈卓（chen-zhuo）");
    expect(prompt).toContain("smiley-sans");
    expect(prompt).toContain("系列角标「跟着陈卓走」");
    expect(prompt).toContain("【账号定位】城市人文旅行人设号");
    expect(prompt).toContain("【账号禁区】硬广话术");
    /** 优先级必须写明（真机：监制把"题材配色 vs 账号视觉锤"判成互相冲突而打回） */
    expect(prompt).toContain("【优先级】账号视觉锤 > 题材建议 > 平台通用建议");

    /** 字体偏离：默认只 warn（记进设计稿 warnings），strict=true 判非法 */
    const drifted = { ...validPlan, typography: { ...validPlan.typography, fontId: "source-han-heavy" as const } };
    const warned = validateCoverPlan(drifted, { ...input, platform: "抖音", accountProfile: profile });
    expect(warned.warnings?.join(" ")).toContain("偏离账号视觉锤");
    expect(() => validateCoverPlan(drifted, {
      ...input, platform: "抖音", accountProfile: { ...profile, strict: true }
    })).toThrow(/偏离账号视觉锤/);
    /** 命中禁区：strict 语义同上 */
    const tabooPlan = { ...validPlan, headline: "硬广话术", typography: { ...validPlan.typography, fontId: "smiley-sans" as const } };
    expect(validateCoverPlan(tabooPlan, { ...input, platform: "抖音", accountProfile: profile }).warnings?.join(" "))
      .toContain("账号禁区");
  });

  it("平台标题口径：小红书 14 字、B站 16 字、英文平台按词计数", () => {
    const base = { ...validPlan, typography: { ...validPlan.typography } };
    const xhs14: CoverPlan = { ...base, headline: "落霞秋水共长天一色的滕王阁夜" }; // 14 字
    expect(() => validateCoverPlan(xhs14, { ...input, platform: "小红书" })).not.toThrow();
    expect(() => validateCoverPlan({ ...base, headline: "落霞秋水共长天一色的滕王阁夜景" }, { ...input, platform: "小红书" }))
      .toThrow(/上限 14/);
    const bili16: CoverPlan = { ...base, headline: "落霞秋水共长天一色的滕王阁夜景里" }; // 16 字
    expect(() => validateCoverPlan(bili16, { ...input, platform: "bilibili" })).not.toThrow();
    const tiktokEn: CoverPlan = { ...base, headline: "THIS $10 FIND BLEW UP", typography: { ...base.typography, color: "#FFFFFF", accentColor: "#FFD166" } };
    expect(() => validateCoverPlan(tiktokEn, { ...input, platform: "tiktok" })).not.toThrow();
    expect(() => validateCoverPlan({ ...tiktokEn, headline: "THIS $10 FIND BLEW UP RIGHT NOW" }, { ...input, platform: "tiktok" }))
      .toThrow(/英文单词/);
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

  /**
   * 2026-09-27 真机两条：
   *   · 副标题里的「30 秒首响」是产品指标，不是片长声明——不得被判"时长与成片不符"；
   *   · 兜底标题来自片名（常带"· 副标题"），硬截 12 字会留尾随「·」，要先取主标题再截。
   */
  it("片长口径只认指向片子本身的表述（产品指标里的 30 秒不算片长）", () => {
    const metricPlan: CoverPlan = {
      ...validPlan,
      headline: "三笔账\n你都懂",
      subline: "四支团队 · 78 个岗位 · 30 秒首响",
      badge: "获客增长"
    };
    expect(() => validateCoverPlan(metricPlan, { ...input, durationSeconds: 89 })).not.toThrow();
    const lengthPlan: CoverPlan = { ...validPlan, headline: "89 秒看懂全片", subline: undefined };
    expect(() => validateCoverPlan(lengthPlan, { ...input, durationSeconds: 30 })).toThrow(/与成片/);
  });

  it("兜底标题取主标题并去尾标点，副标题用成片真实时长", () => {
    const plan = fallbackCoverPlan(
      { ...input, durationSeconds: 89 },
      { headline: "AI 班组住进你公司 · 获客增长系统 89 秒销售口播", heroShotId: "SC-05", personShotId: "SC-01" }
    );
    expect(plan.headline.endsWith("·")).toBe(false);
    expect(plan.headline.length).toBeLessThanOrEqual(12);
    expect(plan.subline).toContain("89 秒");
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

  /**
   * 平台化机检（2026-09-27）：画幅与安全区随平台——小红书 1080×1440、B站 1920×1080；
   * 旧签名（传安全区对象）保持抖音画幅，旧用例零改动。
   */
  it("平台机检：小红书 3:4 / B站 16:9 按各自画幅与安全区判定", () => {
    const xhs = coverDeterministicChecks(measure({ width: 1080, height: 1440 }), "xiaohongshu");
    expect(xhs.every((c) => c.pass)).toBe(true);
    expect(xhs.find((c) => c.id === "cover-produced")!.detail).toContain("1080x1440");

    const bili = coverDeterministicChecks(measure({ width: 1920, height: 1080 }), "bilibili");
    expect(bili.every((c) => c.pass)).toBe(true);
    expect(bili.find((c) => c.id === "cover-produced")!.detail).toContain("1920x1080");
    expect(bili.find((c) => c.id === "cover-produced")!.detail).toContain("bilibili");

    /** 画幅不符仍然拦下（小红书封面出来是 9:16 → 判失败） */
    expect(coverDeterministicChecks(measure({ width: 1080, height: 1920 }), "xiaohongshu")
      .find((c) => c.id === "cover-produced")!.pass).toBe(false);
  });

  it("旧签名（安全区对象）保持抖音画幅口径，机检行为不变", () => {
    const checks = coverDeterministicChecks(measure({ titleTopRatio: 0.55, titleBottomRatio: 0.80 }), COVER_LOWER_BAND_SAFE_AREA);
    expect(checks.find((c) => c.id === "cover-produced")!.pass).toBe(true);
    expect(checks.find((c) => c.id === "safe-area")!.pass).toBe(true);
    expect(checks.find((c) => c.id === "safe-area")!.detail).toContain("52%");
  });
});

describe("封面兜底稿的平台化", () => {
  it("B站兜底稿按 16:9 平台校验通过，标题取平台上限内的主标题", () => {
    const plan = fallbackCoverPlan(
      { ...input, platform: "bilibili", durationSeconds: 30 },
      { headline: "落霞秋水共长天一色的滕王阁夜景里", heroShotId: "SC-05", personShotId: "SC-01" }
    );
    expect(plan.headline.length).toBeLessThanOrEqual(16);
    expect(plan.source).toBe("fallback");
  });

  it("英文平台兜底稿按词截断并全大写，副标题不出现中文时长口径", () => {
    const plan = fallbackCoverPlan(
      { ...input, platform: "tiktok", durationSeconds: 30 },
      { headline: "this ten dollar find blew up right now", heroShotId: "SC-05", personShotId: "SC-01" }
    );
    expect(plan.headline).toBe("THIS TEN DOLLAR FIND BLEW");
    expect(plan.subline).toContain("30s");
  });

  it("账号档案锁定字体与色板时，兜底稿也遵守（视觉锤不因降级而漂移）", () => {
    const plan = fallbackCoverPlan(
      {
        ...input, platform: "douyin",
        accountProfile: {
          account_id: "chen-zhuo",
          visual_hammer: { fontId: "smiley-sans", palette: ["#FFFFFF", "#FFD166"] },
          strict: true
        }
      },
      { headline: "滕王阁 落霞秋水", heroShotId: "SC-05", personShotId: "SC-01" }
    );
    expect(plan.typography.fontId).toBe("smiley-sans");
    expect(plan.typography.accentColor).toBe("#FFD166");
  });
});

/**
 * 夜景意图判定（T-2026-0926-0121 真机修复）：过宽字表会把"五环**点亮**"误判成夜景意图，
 * 把设计稿选好的灯环底图换成人物近景（双手交叠）→ 封面被监制判"肢体畸变"打回。
 */
describe("coverPrefersNightBackground（封面夜景意图）", () => {
  it("无歧义夜色词 → 判夜景意图", () => {
    expect(coverPrefersNightBackground("赣江夜色，落在灯影里")).toBe(true);
    expect(coverPrefersNightBackground("深夜的城市与车流")).toBe(true);
    expect(coverPrefersNightBackground("灯火与霓虹之间")).toBe(true);
  });

  it("真机复现：设计理由写「五环点亮」→ 不再误判夜景", () => {
    expect(coverPrefersNightBackground("获客，算得清 · 五环闭环，90 秒讲透；理由：五环依次点亮，环环算得清")).toBe(false);
  });

  it("「亮起/亮点/灯环」这类词单独出现 → 不触发", () => {
    expect(coverPrefersNightBackground("灯环亮起，环环相扣")).toBe(false);
    expect(coverPrefersNightBackground("这是全片的亮点")).toBe(false);
  });

  it("空文本 → 不触发（不凭空假设夜景）", () => {
    expect(coverPrefersNightBackground("")).toBe(false);
  });
});
