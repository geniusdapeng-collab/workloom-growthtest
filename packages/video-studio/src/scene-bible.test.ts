import { describe, expect, it } from "vitest";
import {
  environmentDefects, environmentProfilePromptLines, expandShotWithBible, materialsSummary,
  practicalLightsSummary, propInteractionDefects, propInteractionPromptLines,
  resolveSceneEnvironment, sceneBiblePromptLines, spaceSummary, summarizeDefects, validateSceneBible,
  type SceneBible, type EnvShotFields,
} from "./scene-bible.js";

const bible: SceneBible = {
  spaceId: "office", space: { city: "上海", building: "1930 年代银行改建会议室", orientation: "东侧落地窗", timeOfDay: "上午 10:20" },
  materials: [
    { item: "会议桌", material: "胡桃木", finish: "哑光打蜡", wear: "咖啡杯痕" },
    { item: "墙面", material: "微水泥", finish: "批刀痕" },
  ],
  practicalLights: [{ type: "窗光", kelvin: 5600, direction: "东侧照入" }, { type: "台灯", kelvin: 3000 }],
  traces: ["桌面咖啡杯痕", "档案夹卷边"], colorDiscipline: "低饱和中性色",
  environmentProfile: { setting: "interior", condition: "used" },
  eraProfile: { storyDate: "2026-09-28", devicePolicy: "story-compatible" },
  otherSpaces: [{
    spaceId: "street", city: "苏州", building: "平江路街道", orientation: "沿河岸朝南", timeOfDay: "傍晚",
    materials: [{ item: "路面", material: "石板", finish: "凹凸接缝" }],
    practicalLights: [{ type: "日落天光", direction: "西侧低角度" }], traces: [],
    colorDiscipline: "暖色天光", environmentProfile: { setting: "exterior", condition: "natural" },
  }],
};
const shot = { shotId: "OFFICE", scene: "桌边中景", sceneDescription: "刚开完会", action: "女人双手摊开", composition: "中景", duration: 8, dialogue: [{ text: "会议结束。" }], depth_of_field: "桌面与人物同时清晰" };
const hard = (shots: EnvShotFields[], value?: SceneBible) => environmentDefects(shots, value).filter((entry) => entry.hard);

describe("逐空间事实与展开", () => {
  it("主空间按已声明档案展开，动作、台词、时长、构图不变", () => {
    expect(validateSceneBible(bible)).toEqual([]);
    const expanded = expandShotWithBible(shot, bible);
    expect(expanded.scene).toContain("上海");
    expect(expanded.scene).not.toContain("胡桃木");
    expect(expanded.props).toContain("胡桃木");
    expect(expanded.lighting).toContain("5600K");
    expect(expanded.sceneDescription).toContain("咖啡杯痕");
    expect(expanded).toMatchObject({ action: shot.action, dialogue: shot.dialogue, duration: shot.duration, composition: shot.composition });
    expect(hard([expanded], bible)).toEqual([]);
  });
  it("室外第二空间只使用自己的事实，不继承室内桌、灯、杯痕、profile或色彩", () => {
    const expanded = expandShotWithBible({ shotId: "STREET", sceneId: "street", scene: "傍晚街道空镜", action: "无人", depth_of_field: "全画面清晰" }, bible);
    const visible = [expanded.scene, expanded.sceneDescription, expanded.lighting, expanded.props, expanded.color_palette].join("；");
    expect(visible).toContain("苏州");
    expect(visible).toContain("石板");
    expect(visible).toContain("西侧低角度");
    expect(visible).not.toMatch(/胡桃木|会议室|台灯|杯痕|卷边|5600K|低饱和中性/);
    expect(expanded.environmentProfile).toEqual({ setting: "exterior", condition: "natural" });
    expect(expanded.eraProfile).toMatchObject({ storyDate: "2026-09-28" });
    expect(hard([expanded], bible)).toEqual([]);
    expect(sceneBiblePromptLines(bible, { sceneId: "street" }).join("；")).not.toMatch(/胡桃木|台灯|杯痕/);
    expect(materialsSummary(bible, 5, "street")).toContain("石板");
    expect(practicalLightsSummary(bible, "street")).not.toContain("台灯");
  });
  it("第二空间缺局部清单时保持未给，不拿主空间补齐", () => {
    const sparse = { ...bible, otherSpaces: [{ spaceId: "lake", city: "杭州", building: "西湖湖面" }] };
    const env = resolveSceneEnvironment(sparse, "lake");
    expect(env).toMatchObject({ materials: [], practicalLights: [], traces: [] });
    expect(env.environmentProfile).toBeUndefined();
    const expanded = expandShotWithBible({ shotId: "LAKE", sceneId: "lake", scene: "湖面空镜", lighting: "阴天天光" }, sparse);
    expect(expanded.props).toBeUndefined();
    expect(expanded.lighting).toBe("阴天天光");
    expect(JSON.stringify(expanded)).not.toContain("胡桃木");
  });
  it("显式每镜暖光、色彩优先，清单不会加冲突的5600K或日间窗光", () => {
    const expanded = expandShotWithBible({ ...shot, lighting: "烛光 2200K，从右侧照来", color_palette: "保留温暖琥珀色" }, bible);
    expect(expanded.lighting).toBe("烛光 2200K，从右侧照来");
    expect(expanded.color_palette).toBe("保留温暖琥珀色");
  });
  it("visibleMaterials仅展开当前构图可见的物件，空数组不添加材料", () => {
    const expanded = expandShotWithBible({ ...shot, visibleMaterials: ["会议桌"] }, bible);
    expect(expanded.props).toContain("胡桃木");
    expect(expanded.props).not.toContain("墙面");
    expect(expandShotWithBible({ ...shot, visibleMaterials: [] }, bible).props).toBeUndefined();
    expect(() => expandShotWithBible({ ...shot, visibleMaterials: ["路面"] }, bible)).toThrow(/没有登记/);
  });
  it("重复及JSON往返幂等，改空间和改圣经后只移除可证明的旧贡献", () => {
    const first = expandShotWithBible(shot, bible);
    expect(expandShotWithBible(JSON.parse(JSON.stringify(first)), bible)).toEqual(first);
    const changed = expandShotWithBible({ ...first, sceneId: "street" }, bible);
    expect(changed.scene).toContain("苏州");
    expect(changed.scene).not.toContain("上海");
    expect(changed.props).not.toContain("胡桃木");
    const revised = expandShotWithBible(first, { ...bible, materials: [{ item: "会议桌", material: "黄铜", finish: "拉丝" }] });
    expect(revised.props).toContain("黄铜");
    expect(revised.props).not.toContain("胡桃木");
    expect(revised.action).toBe(shot.action);
  });
  it("作者修改原句并保留自有后缀时保留修改；旧贡献被篡改时明确未验证", () => {
    const first = expandShotWithBible(shot, bible);
    const edited = { ...first, scene: first.scene.replace("桌边中景", "桌边近景") };
    expect(expandShotWithBible(edited, bible).scene).toContain("桌边近景");
    expect(() => expandShotWithBible({ ...first, props: String(first.props).replace("胡桃木", "假木头") }, bible)).toThrow(/旧场景贡献/);
    const tampered = JSON.parse(JSON.stringify(first)); tampered._workloomSceneBible.contributions[0].afterHash = "bad";
    expect(() => expandShotWithBible(tampered, bible)).toThrow(/旧场景贡献/);
  });
  it("未知空间不回退主空间，畸形圣经不会以TypeError崩溃", () => {
    expect(() => spaceSummary(bible, "missing")).toThrow(/未登记/);
    expect(hard([{ ...shot, sceneId: "missing" }], bible)).toContainEqual(expect.objectContaining({ rule: "space-continuity", status: "failed" }));
    for (const invalid of [null, [], {}, { ...bible, space: null }, { ...bible, traces: "旧" }, { ...bible, materials: [null] }, { ...bible, practicalLights: [null] }, { ...bible, otherSpaces: "街" }]) {
      expect(validateSceneBible(invalid).length).toBeGreaterThan(0);
      expect(() => expandShotWithBible(shot, invalid as SceneBible)).toThrow();
      try { expandShotWithBible(shot, invalid as SceneBible); } catch (error) { expect(error).toMatchObject({ name: "SceneBibleError", status: "unverified" }); }
    }
  });
  it("重复空间、非法面积和灯具数量均明确报错", () => {
    expect(validateSceneBible({ ...bible, otherSpaces: [{ ...bible.otherSpaces![0]!, spaceId: "office" }] }).join(" ")).toContain("重复");
    expect(validateSceneBible({ ...bible, space: { ...bible.space, areaM2: NaN } }).join(" ")).toContain("有限正数");
    expect(validateSceneBible({ ...bible, practicalLights: [{ type: "台灯", count: 1, lit: 2, kelvin: Infinity }] }).join(" ")).toMatch(/kelvin.*lit/);
  });
  it("结构化原字段不被拼接覆盖，并发按各自空间返回", async () => {
    expect(() => expandShotWithBible({ ...shot, props: { item: "作者的结构化道具" } }, bible)).toThrow(/结构化字段/);
    const results = await Promise.all(Array.from({ length: 12 }, (_, index) => Promise.resolve().then(() => expandShotWithBible({ ...shot, sceneId: index % 2 ? "office" : "street" }, bible))));
    expect(results.every((result, index) => result.scene.includes(index % 2 ? "上海" : "苏州"))).toBe(true);
    expect(shot).not.toHaveProperty("_workloomSceneBible");
  });
});

describe("按环境用途审核，不把磨损或影棚禁令套到所有场地", () => {
  it.each(["new", "maintained", "sterile"] as const)("明确%s室内不要求磨损，保留真实表面与光源要求", (condition) => {
    const clean: EnvShotFields = { shotId: "CLEAN", scene: "医院洁净室", props: "不锈钢台面与磨砂玻璃", lighting: "顶部面板灯与窗光", depth_of_field: "台面全清晰", environmentProfile: { setting: "interior", condition } };
    expect(hard([clean])).toEqual([]);
    expect(environmentProfilePromptLines(clean.environmentProfile).join(" ")).not.toContain("保留声明的真实使用痕迹");
  });
  it("used档案需要真实状态；负面“无磨损”不能充当磨损证据", () => {
    const used: EnvShotFields = { shotId: "USED", scene: "旧办公室", props: "胡桃木与磨砂玻璃，无划痕，无磨损", lighting: "窗光", environmentProfile: { setting: "interior", condition: "used" } };
    expect(hard([used]).map((entry) => entry.rule)).toContain("usage-traces");
    expect(hard([{ ...used, props: "胡桃木与磨砂玻璃，桌角有划痕" }])).toEqual([]);
  });
  it("影棚产品可用柔光箱，自然外景无需三个家具材质", () => {
    expect(hard([{ scene: "手表产品特写", props: "拉丝不锈钢表壳", lighting: "柔光箱从左侧照亮", environmentProfile: { setting: "product", condition: "new" } }])).toEqual([]);
    expect(hard([{ scene: "无人湖面空镜", lighting: "阴天散射天光", environmentProfile: { setting: "exterior", condition: "natural" } }])).toEqual([]);
  });
  it("明确室内档案缺可见材质和实用光仍未验证，不以删除规则冒充修复", () => {
    const defects = hard([{ scene: "现代商务空间", lighting: "柔光箱", environmentProfile: { setting: "interior", condition: "used" } }]);
    expect(defects.map((entry) => entry.rule)).toEqual(expect.arrayContaining(["material-depth", "practical-light", "usage-traces"]));
    expect(summarizeDefects(defects).hard).toBe(3);
  });
});

describe("道具用途与朝向合同", () => {
  const phone: EnvShotFields = { shotId: "PHONE", scene: "手机演示", action: "女人低头读取手机屏幕", propInteraction: { prop: "手机", purpose: "operate", orientation: "屏幕朝向操作者", operatedBy: "女人右手", contact: "手机由右手握持" } };
  it("自己读屏朝内通过，自己读屏却朝观众是冲突", () => {
    expect(propInteractionDefects(phone)).toEqual([]);
    const wrong = { ...phone, propInteraction: { ...(phone.propInteraction as object), orientation: "屏幕朝向观众" } } as EnvShotFields;
    expect(propInteractionDefects(wrong)).toContainEqual(expect.objectContaining({ rule: "prop-screen-orientation", status: "failed" }));
  });
  it("向观众演示允许屏幕朝外，共享观看允许shared", () => {
    const present: EnvShotFields = { ...phone, action: "女人向观众展示手机报表", propInteraction: { prop: "手机", purpose: "present", orientation: "屏幕朝向观众", screenFacing: "audience", operatedBy: "女人", contact: "固定在手持支架上" } };
    expect(propInteractionDefects(present)).toEqual([]);
    expect(propInteractionPromptLines(present).join(" ")).toContain("朝向观众");
    const shared: EnvShotFields = { ...phone, action: "两人共同看手机", propInteraction: { prop: "手机", purpose: "shared-view", orientation: "屏幕对两人共同可见", screenFacing: "shared", operatedBy: "两人", contact: "桌面支架承重" } };
    expect(propInteractionDefects(shared)).toEqual([]);
  });
  it("静置道具不要求凭空添加人，明示rest仍检查接触", () => {
    expect(propInteractionDefects({ scene: "桌面手机产品特写", action: "镜头固定" })).toEqual([]);
    expect(propInteractionDefects({ ...phone, action: "空镜", propInteraction: { prop: "手机", purpose: "rest", orientation: "屏幕朝下，置于桌面", screenFacing: "away" } })).toEqual([]);
  });
  it("每个实际操作对象要有自己的合同，其他道具声明不能盖过", () => {
    expect(propInteractionDefects({ ...phone, action: "女人读取手机，同时点击鼠标" })).toContainEqual(expect.objectContaining({ rule: "prop-interaction" }));
    expect(propInteractionDefects({ ...phone, propInteraction: { ...(phone.propInteraction as object), contact: 3 } } as never)).toContainEqual(expect.objectContaining({ rule: "prop-interaction" }));
  });
  it("没有用途/接触/操作人、冲突朝向和畸形结构都失败关闭", () => {
    const cases: unknown[] = [null, { prop: "手机", orientation: "侧面" }, { prop: "手机", purpose: "operate", orientation: "屏幕朝向观众", screenFacing: "operator", operatedBy: "演员", contact: "支架" }, { prop: "手机", purpose: "arbitrary", orientation: "向外" }];
    for (const propInteraction of cases) {
      const card = { ...phone, action: "站着", propInteraction } as unknown as EnvShotFields;
      expect(propInteractionDefects(card).length).toBeGreaterThan(0);
      expect(() => propInteractionPromptLines(card)).toThrow();
    }
    expect(propInteractionDefects({ ...phone, propInteraction: undefined })).toContainEqual(expect.objectContaining({ rule: "prop-interaction" }));
  });
});
