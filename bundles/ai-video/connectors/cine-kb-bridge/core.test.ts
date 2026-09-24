/**
 * 摄影知识库连接器测试（2026-09-24）
 *
 * 覆盖三件事：
 *  ① 全库可解析：19 篇 / 每篇第六章都有映射条目 / 索引引用的篇目不得缺（缺就报缺，不静默）；
 *  ② 光圈顾问：按场景给档位（日景人像 f/2.8–4、夜景人像 f/1.4–1.8、风光 f/8–11、合影 f/5.6–8、星芒 f/16）；
 *  ③ 自动注入纪律：≤3 条、每字段一条、**不写 f 值**（KB 总则：模型只认画面语言），
 *     且日景镜头不得被注入日落/夜景配方（真机事故回归）。
 */
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { enrichShotCard, injectionContext, kbStatus, loadKb, recommendAperture } from "./core.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const KB_DIR = resolve(here, "../../library/cinematography-kb");

const kb = loadKb(KB_DIR);

describe("摄影知识库：解析", () => {
  it("19 篇全部可解析，第六章都有可调用映射，索引无缺篇", () => {
    expect(existsSync(KB_DIR)).toBe(true);
    const status = kbStatus(kb);
    expect(status.topics).toBe(19);
    expect(status.missingTopics).toEqual([]);
    expect(status.topicsWithEmptyMappings).toEqual([]);
    expect(status.entries).toBeGreaterThan(300);
    for (const topic of kb.topics) expect(topic.entries.length, `${topic.id} 无映射条目`).toBeGreaterThan(5);
  });

  it("NARR-001 的「参数→情绪反查」表与「情绪配方」表被分开处理（反查表不能当提示词用）", () => {
    const narr = kb.topics.find((t) => t.id === "NARR-001")!;
    expect(narr.entries.every((e) => e.kind === "recipe")).toBe(true);
    expect(narr.reverseEntries.length).toBeGreaterThan(5);
    for (const row of narr.reverseEntries) expect(row.emotion.length).toBeGreaterThan(0);
  });
});

describe("光圈顾问（OPTICS-001 权威口径）", () => {
  const cases: Array<[string, Record<string, unknown>, string]> = [
    ["日景人像（中景·平江路口播）", { scene: "苏州平江路上午的青石板主街，白墙黛瓦", character: "女主，江南女性", action: "沿街缓步、停步回眸", composition: "景别：中景转中近景" }, "f/2.8–f/4"],
    ["夜景人像（灯笼下走两步）", {
      mood: "温柔收束留余韵：眼睑缓眨、视线温柔落在镜头，肩背放松，嘴角浅笑",
      scene: "入夜的平江路，河道两岸灯笼次第亮起，暖黄灯光倒映在水面，青石路湿润反光",
      lighting: "白平衡中性（夜景 4000K）：灯笼暖光只作环境色与轮廓光，面部主光保持中性不偏黄",
      character: "女主（WIFE-01），与定妆照一致的面部结构与发型",
      action: "站在灯笼下的青石路上，转身面向镜头慢慢向前走两步，抬手轻轻向镜头摆手告别",
      composition: "景别：全景转中景；人物位于画面中轴线略偏右",
      camera_movement: "全景固定机位；人物走近时由全景自然过渡到中景"
    }, "f/1.4–f/1.8"],
    ["风光大场景（雪山湖泊）", { scene: "雪山脚下的湖泊倒影，前景野花，清晨低角度阳光" }, "f/8–f/11"],
    ["十人团队合影", { scene: "公司门口团队合影，背景是办公楼", character: "十人团队", action: "集体微笑看镜头" }, "f/5.6–f/8"],
    /** 星芒必须显式要求（只是"场景里有太阳"不算——见下方回归用例） */
    ["太阳星芒风光（显式要星芒）", { scene: "海边日落，太阳呈放射状星芒，前景礁石", mood: "史诗" }, "f/16"],
    ["美食特写（糖粥蒸汽）", { scene: "老字号茶食铺，桂花糖粥与海棠糕，蒸汽升起", action: "低头闻香" }, "f/2.8"]
  ];
  for (const [label, card, expected] of cases) {
    it(`${label} → ${expected}`, () => {
      const pick = recommendAperture(kb, card);
      expect(pick, "光圈顾问不可用（缺 OPTICS-001？）").toBeTruthy();
      expect(pick!.aperture).toBe(expected);
      expect(pick!.effectZh.length).toBeGreaterThan(4);
      expect(pick!.source).toContain("OPTICS-001");
    });
  }

  /**
   * 深度抽查回归（2026-09-24 第二轮审计）：这三条都是"注入错了"的真实案例，
   * 起因都是**把场景里的词当成了意图**（有太阳≠要星芒、室内≠街拍、散射≠午后硬光）。
   */
  it("阴天散射光不被判成「午后斜光」，而是柔光路线", () => {
    const pick = recommendAperture(kb, { scene: "阴天的茶室内，木格窗外是青瓦白墙", character: "陈卓", action: "端起茶杯轻抿" });
    expect(pick!.aperture).not.toBe("f/8");
    const { trace } = enrichShotCard(kb, { scene: "阴天的茶室内，木格窗外是青瓦白墙，桌上有青瓷茶杯", character: "陈卓", action: "端起茶杯轻抿", mood: "安静" });
    const lighting = trace.applied.find((a) => a.field === "lighting")?.added ?? "";
    expect(lighting).not.toContain("午后阳光");
  });

  it("海边人像不因场景里有太阳而被判成星芒档（星芒必须是显式意图）", () => {
    const pick = recommendAperture(kb, { scene: "海边日落，太阳贴着海平面，人物站在礁石上", character: "陈卓", action: "迎风站立", mood: "史诗" });
    expect(pick!.aperture).not.toBe("f/16");
    const explicit = recommendAperture(kb, { scene: "海边日落，太阳星芒四射，礁石前景", mood: "史诗" });
    expect(explicit!.aperture).toBe("f/16");
  });

  it("室内人物镜头不走「街拍 f/8」档", () => {
    const pick = recommendAperture(kb, { scene: "室内会议室，白墙前", character: "陈卓", action: "坐着说话" });
    expect(pick!.aperture).not.toBe("f/8");
  });
});

describe("自动注入：纪律与回归", () => {
  const daytimePortrait: Record<string, unknown> = {
    shotId: "SC-01",
    mood: "清晨安宁温柔",
    scene: "苏州平江路上午的青石板主街，白墙黛瓦与木格窗，河岸垂柳，薄雾未散",
    lighting: "白平衡中性（日光 5600K）：上午十点柔和的阴天散射日光；避免日落时段的金色调、避免暖黄滤镜",
    character: "女主，江南女性，深栗棕及肩锁骨发",
    action: "沿青石板路缓步向前，停步回眸",
    color_palette: "主色调：月白与黛青；低饱和",
    composition: "景别：中景转中近景",
    camera_movement: "跟随跟拍；缓慢推近到半身",
    depth_of_field: "焦点：人物面部；景深：浅"
  };

  it("每镜注入有条数上限、每字段一条，且提示词字段里不出现 f 值", () => {
    const { card, trace } = enrichShotCard(kb, daytimePortrait);
    /** 政策更新（三轮审计）：字段级仍"一字段一条"，但总量上限放宽到 5（灯光/构图/运镜/色调/材质各一） */
    const injected = trace.applied.filter((a) => a.field !== "depth_of_field");
    expect(injected.length).toBeLessThanOrEqual(5);
    expect(new Set(injected.map((a) => a.field)).size).toBe(injected.length);
    for (const field of ["lighting", "composition", "camera_movement", "color_palette", "props", "baseline"]) {
      const value = String((card as Record<string, unknown>)[field] ?? "");
      expect(/\bf\/\d/.test(value), `${field} 不应出现 f 值：${value}`).toBe(false);
    }
    /** f 值只允许出现在 trace 里 */
    expect(trace.suggestedParams.aperture?.recommendedRange).toMatch(/^f\//);
  });

  it("否定语境回归：卡片写「避免日落」时不得被判成黄金时刻/日落意图", () => {
    const ctx = injectionContext(daytimePortrait);
    expect(ctx.goldenHour).toBe(false);
    expect(ctx.night).toBe(false);
    const { trace } = enrichShotCard(kb, daytimePortrait);
    /**
     * 只看**注入进去的那部分**（added）：卡片原文里的"避免日落时段的金色调"是我们自己的白平衡锚点，
     * 不能拿它当"注入了日落"。
     */
    const blob = trace.applied.map((a) => a.added).join(" ");
    for (const bad of ["日落", "落日", "夕阳", "黄金时刻", "霓虹", "赛博", "夜景"]) {
      expect(blob.includes(bad), `日景镜头不应注入「${bad}」`).toBe(false);
    }
  });

  it("白天巷口的灯笼不算夜景（点光源 ≠ 夜间）", () => {
    const ctx = injectionContext({ scene: "平江路支巷，巷口挂着一串红灯笼，天光从巷口落下", action: "停下脚步侧头倾听" });
    expect(ctx.lantern).toBe(true);
    expect(ctx.night).toBe(false);
  });

  it("景别不重复注入：卡片已有「中景」时不再叠加别的景别", () => {
    const { trace } = enrichShotCard(kb, daytimePortrait);
    const framingApplied = trace.applied.find((a) => a.topics?.includes("CINE-002") && a.field === "composition");
    expect(framingApplied).toBeUndefined();
  });
});
