/**
 * 场景圣经 · 环境真实性审计回归（2026-09-27 真机事故沉淀）
 *
 * 三条纪律：
 *   ① "空词 + 无材质 + 无实用光源 + 无使用痕迹"必须被判红——这是 AI 感的四个来源；
 *   ② 可交互道具（手机/平板…）必须声明物理关系与屏幕朝向——"手机屏幕朝观众"这类 badcase 由此兜住；
 *   ③ 圣经展开只动环境字段，不动表演/台词/时长/构图。
 */
import { describe, expect, it } from "vitest";
import {
  environmentDefects,
  expandShotWithBible,
  spaceSummary,
  summarizeDefects,
  validateSceneBible,
  type SceneBible,
  type EnvShotFields,
} from "./scene-bible.js";

const bible: SceneBible = {
  spaceId: "shanghai-bund-1930s-office-18f",
  space: {
    city: "上海",
    district: "外滩",
    building: "1930 年代原法租界银行改建办公楼 18 层会议室",
    areaM2: 30,
    ceilingM: 3.6,
    orientation: "东侧整面带纱帘落地窗",
    timeOfDay: "上午 10:20",
  },
  materials: [
    { item: "会议桌", material: "1960 年代丹麦胡桃木玫瑰木贴面", finish: "哑光打蜡", wear: "中央咖啡杯痕、边缘 2cm 磕痕" },
    { item: "墙面", material: "浅灰微水泥 + 深色胡桃木饰面", finish: "批刀痕、1.5mm 顺纹拼缝", wear: "两处极细裂纹" },
    { item: "地面", material: "浅橡木直铺实木地板", finish: "12cm 板宽", wear: "细划痕与两处旧钉眼" },
  ],
  practicalLights: [
    { type: "窗光", kelvin: 5600, direction: "东北向侧逆光，亚麻纱帘柔化" },
    { type: "天花筒灯", count: 4, lit: 2, kelvin: 3000 },
    { type: "桌上台灯", kelvin: 4000, shade: "米白纸质灯罩" },
  ],
  traces: ["桌面咖啡杯痕", "档案夹卷边与铅笔批注", "金属外壳指纹与划痕", "百叶薄灰"],
  colorDiscipline: "低饱和写实；肤色中性不偏黄；暗部保留材质纹理",
};

const genericShot: EnvShotFields = {
  shotId: "CF-04",
  scene: "稍远的机位：她坐在长桌主位，身后是简洁会议室背景",
  sceneDescription: "会议室背景干净留白，资料册只露纸张质感",
  lighting: "中性白平衡 5600K；柔光箱主光从镜头左前方 45° 打亮面部，右侧一块白板补出柔和过渡",
  props: "长桌、合上的资料册（无文字）、会议室背景、天光",
};

const richShot: EnvShotFields = {
  shotId: "CF-04E",
  sceneId: "shanghai-bund-1930s-office-18f",
  scene: "上海外滩 1930 年代原法租界银行改建办公楼第 18 层会议室：浅灰微水泥墙（批刀痕）+ 深色胡桃木饰面墙（1.5mm 拼缝）",
  sceneDescription: "会议桌有玫瑰木贴面与咖啡杯痕；牛皮纸档案夹边角卷起；琴叶榕叶面有水渍与两片黄叶",
  lighting: "窗光 5600K 穿过亚麻纱帘；天花筒灯 3000K 只开 2 只；桌上米白纸质台灯 4000K",
  props: "胡桃木长桌（咖啡杯痕）、银色旧钢笔、半满黑咖啡（杯渍）、合盖笔记本（指纹与划痕）",
  action: "她双手摊开做手势",
  depth_of_field: "等效 35mm 视角、大光圈浅景深",
};

describe("场景圣经校验", () => {
  it("完备圣经无错；缺实指/材质/光源/痕迹逐条报错", () => {
    expect(validateSceneBible(bible)).toEqual([]);
    const broken = validateSceneBible({
      spaceId: "",
      space: { building: "办公室" },
      materials: [{ item: "桌子", material: "原木" }],
      practicalLights: [{ type: "柔光箱" }],
      traces: [],
    });
    expect(broken.join(" ")).toMatch(/spaceId/);
    expect(broken.join(" ")).toMatch(/空间实指不足/);
    expect(broken.join(" ")).toMatch(/材质清单不足|缺工艺或使用状态/);
    expect(broken.join(" ")).toMatch(/实用光源不足/);
    expect(broken.join(" ")).toMatch(/使用痕迹清单为空/);
  });
});

describe("环境真实性审计", () => {
  it("通用样板间镜头必须判红（空词/材质/光源/痕迹/实指）", () => {
    const defects = environmentDefects([genericShot], bible);
    const rules = new Set(defects.map((defect) => defect.rule));
    for (const rule of ["generic-wording", "material-depth", "practical-light", "usage-traces", "space-specificity"]) {
      expect(rules.has(rule), `缺少规则 ${rule}`).toBe(true);
    }
    expect(summarizeDefects(defects).hard).toBeGreaterThanOrEqual(4);
  });

  it("实指化镜头没有硬缺陷（软提示允许：光学签名已给）", () => {
    const defects = environmentDefects([richShot], bible).filter((defect) => defect.hard);
    expect(defects).toEqual([]);
  });

  it("含手机但未声明物理关系 → 红；声明了但屏幕朝观众 → 红；朝使用者 → 过", () => {
    const phoneBase: EnvShotFields = { ...richShot, shotId: "CF-02E", props: `${richShot.props}；手机支架与亮屏手机`, action: "她侧身抬手点一下手机屏幕" };
    const missing = environmentDefects([phoneBase], bible).filter((defect) => defect.rule === "prop-interaction");
    expect(missing.length).toBeGreaterThan(0);

    const wrongOrientation = environmentDefects(
      [{ ...phoneBase, propInteraction: { prop: "手机", orientation: "屏幕正对镜头（观众看到屏）", operatedBy: "右手食指" } }],
      bible,
    ).filter((defect) => defect.rule === "prop-screen-orientation");
    expect(wrongOrientation.length).toBeGreaterThan(0);

    const ok = environmentDefects(
      [{
        ...phoneBase,
        propInteraction: { prop: "手机", orientation: "屏幕朝向主播本人，观众只见机身背面与侧缘", operatedBy: "右手食指", contact: "手机立于桌面支架，屏幕与桌面夹角 70°" },
      }],
      bible,
    ).filter((defect) => defect.rule.startsWith("prop-"));
    expect(ok).toEqual([]);
  });

  it("换空间未声明 → 空间连续性判红", () => {
    const defects = environmentDefects([{ ...richShot, sceneId: "beijing-cbd-office" }], bible)
      .filter((defect) => defect.rule === "space-continuity");
    expect(defects.length).toBe(1);
  });

  /**
   * 多空间（2026-09-27 扩展）：销售片常见"总部 + 门店/客户现场"两处空间。
   * 口径：出现在别的空间里的镜头**必须**用 `shot.sceneId` 指认，且该空间必须登记在 `otherSpaces`。
   * 这样既允许换空间，又不允许"每镜一个样板间"偷偷发生。
   */
  it("otherSpaces 登记过的空间可换；未登记的空间仍判红", () => {
    const multi = { ...bible, otherSpaces: [{ spaceId: "store-xuhui-front", city: "上海", district: "徐汇", building: "沿街品牌门店打烊后前厅", orientation: "临街玻璃门内", timeOfDay: "凌晨 0:40" }] };
    expect(validateSceneBible(multi)).toEqual([]);
    expect(environmentDefects([{ ...richShot, sceneId: "store-xuhui-front" }], multi).filter((defect) => defect.rule === "space-continuity")).toEqual([]);
    expect(environmentDefects([{ ...richShot, sceneId: "beijing-cbd-office" }], multi).filter((defect) => defect.rule === "space-continuity").length).toBe(1);
  });

  it("otherSpaces 条目的实指不足要报错（换空间不等于可以不实指）", () => {
    const issues = validateSceneBible({ ...bible, otherSpaces: [{ spaceId: "store-x", building: "门店" }] });
    expect(issues.join(" ")).toContain("其他空间 store-x 实指不足");
  });
});

describe("圣经展开", () => {
  it("只升级环境字段，不动表演/台词/时长/构图", () => {
    const card = {
      shotId: "CF-04E",
      duration: 12,
      scene: "稍远的机位",
      sceneDescription: "会议室背景",
      lighting: "柔光箱主光",
      props: "长桌、资料册",
      composition: "景别：中景",
      action: "她双手摊开",
      dialogue: [{ speaker: "陈卓", text: "四支团队、七十八个岗位" }],
    };
    const expanded = expandShotWithBible(card, bible);
    expect(expanded.scene).toContain("上海");
    expect(expanded.scene).toContain("胡桃木");
    expect(expanded.lighting).toContain("5600K");
    expect(expanded.props).toContain("咖啡杯痕");
    expect(expanded.sceneDescription).toContain("使用痕迹");
    expect(expanded.action).toBe(card.action);
    expect(expanded.duration).toBe(12);
    expect(expanded.composition).toBe(card.composition);
    expect(expanded.dialogue).toEqual(card.dialogue);
    expect(environmentDefects([expanded], bible).filter((defect) => defect.hard)).toEqual([]);
  });

  it("多空间展开：按 shot.sceneId 选对应空间的实指（不是无脑套主空间）", () => {
    const multi = { ...bible, otherSpaces: [{ spaceId: "store-xuhui-front", city: "上海", district: "徐汇", building: "沿街品牌门店打烊后前厅", orientation: "临街玻璃门内", timeOfDay: "凌晨 0:40" }] };
    const expanded = expandShotWithBible({ shotId: "GR-03", scene: "打烊后的店铺前厅", sceneDescription: "柜台与玻璃门", lighting: "手机屏冷光", action: "她低头看手机", sceneId: "store-xuhui-front" }, multi);
    expect(expanded.scene).toContain("徐汇");
    expect(expanded.scene).not.toContain("外滩");
    expect(spaceSummary(multi, "store-xuhui-front")).toContain("凌晨 0:40");
  });
});
