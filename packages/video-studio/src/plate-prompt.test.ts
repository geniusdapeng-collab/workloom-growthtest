import { describe, expect, it } from "vitest";
import { BRIDGE_STRUCTURE_CONSTRAINT, DEVICE_STANDARD_CONSTRAINT, ENVIRONMENT_REALISM_CONSTRAINT, PROP_INTERACTION_CONSTRAINT, UNIVERSAL_SPATIAL_INVARIANT, buildPlatePrompt, hasElectronicDevice, hasInteractiveProp, isBridgeScene } from "./plate-prompt.js";
const options = { characterName: "陈卓", appearanceText: "中国江南女性", aspect: "9:16", resolution: "1080p" };
const shot = { shotId: "SC-02", scene: "女人站在石桥桥头", sceneDescription: "桥面连接两岸", action: "保持蹲姿，不笑，不起身", costume: "月白旗袍", makeup: "裸妆", composition: "近景", lighting: "右侧烛光 2200K", color_palette: "暖琥珀色", mood: "沉静", depth_of_field: "深景深，前后景清晰" };
describe("关键帧消费镜头意图和合同", () => {
  it("保留原始光线、姿态、景深，实际写入物理规则", () => {
    const result = buildPlatePrompt(shot, options);
    for (const value of [shot.action, shot.lighting, shot.depth_of_field, UNIVERSAL_SPATIAL_INVARIANT, ENVIRONMENT_REALISM_CONSTRAINT, BRIDGE_STRUCTURE_CONSTRAINT]) expect(result).toContain(value);
    expect(result).not.toMatch(/5600K|浅景深|第二个人物清晰入镜|\bNaN\b|undefined|\[object Object\]/);
    expect(result).toContain("陈卓"); expect(result.split("\n").at(-1)).toContain("禁止：");
  });
  it.each([["16:9", "横幅"], ["9:16", "竖幅"], ["1:1", "方幅"], ["2.39:1", "横幅"]])("实际画幅 %s 为 %s", (aspect, label) => {
    expect(buildPlatePrompt(shot, { ...options, aspect })).toContain(`规格：${aspect} ${label}`);
  });
  it.each(["", "0:1", "-1:2", "NaN:1", "16/9", "100:1"])("非法画幅 %s 失败关闭", (aspect) => expect(() => buildPlatePrompt(shot, { ...options, aspect })).toThrow("PLATE_ASPECT_INVALID"));
  it.each(["无人办公室空镜", "手表商品特写", "树枝上的猫头鹰"])("%s 不被默认角色/皮肤/表情模板污染", (scene) => {
    const result = buildPlatePrompt({ scene, composition: "特写", action: "镜头固定" }, options);
    expect(result).not.toMatch(/陈卓|江南女性|服装：|妆造：|皮肤|人物动作与表情/);
    expect(result).not.toContain("浅景深");
  });
  it("双人构图不会只套一个默认角色或禁止第二人", () => {
    const result = buildPlatePrompt({ scene: "两人坐在窗边", characters: ["甲", "乙"], subject: { kind: "person", count: 2 } }, options);
    expect(result).toContain("人数 2"); expect(result).toContain("角色：甲；乙");
    expect(result).not.toMatch(/陈卓|江南女性|无第二张脸|第二个人物清晰入镜/);
  });
  it("背影不补正脸；桥特写不强迫两个桥头入画；否定不造桥或设备", () => {
    expect(buildPlatePrompt({ scene: "女人背对镜头", composition: "近景" }, options)).toContain("脸部不在可见范围");
    expect(BRIDGE_STRUCTURE_CONSTRAINT).toContain("不要求同时看见两岸");
    expect(isBridgeScene({ scene: "湖面，无桥" })).toBe(false);
    const empty = { scene: "无人海滩，无手机", action: "不要拿手机" };
    expect(hasElectronicDevice(empty)).toBe(false); expect(hasInteractiveProp(empty)).toBe(false);
  });
  it("设备型号与冻结年代进入实际prompt，未核实设备不能只靠口号通过", () => {
    const device = { scene: "手机产品特写", props: "金属机身", eraProfile: { storyDate: "2024-09-20" }, devices: [{ category: "phone", model: "iPhone 16", placement: "桌面支架", role: "展示外观" }] };
    const result = buildPlatePrompt(device, options);
    expect(result).toContain("设备声明：iPhone 16 · 桌面支架 · 展示外观"); expect(result).toContain("2024-09-20"); expect(result).toContain(DEVICE_STANDARD_CONSTRAINT);
    expect(result).not.toContain("全部为");
    expect(() => buildPlatePrompt({ ...device, eraProfile: { storyDate: "2012-01-01" } }, options)).toThrow(/晚于/);
    expect(() => buildPlatePrompt({ scene: "手机" }, options)).toThrow(/缺少冻结/);
  });
  it("面向观众展示屏幕合法，自己读屏需向操作者，缺合同不继续", () => {
    const device = { ...shot, scene: "女人展示手机", action: "向观众展示手机", eraProfile: { storyDate: "2025-01-01" }, devices: [{ category: "phone", model: "iPhone 16" }], propInteraction: { prop: "手机", purpose: "present", orientation: "屏幕朝向观众", operatedBy: "女人", contact: "右手握持" } };
    const result = buildPlatePrompt(device, options); expect(result).toContain(PROP_INTERACTION_CONSTRAINT); expect(result).toContain("屏幕朝向观众");
    expect(() => buildPlatePrompt({ ...device, propInteraction: undefined }, options)).toThrow(/propInteraction/);
  });
  it("洁净产品场景不凭空造磨损，空字段不输出占位行", () => {
    const result = buildPlatePrompt({ scene: "手表产品", props: "不锈钢", environmentProfile: { setting: "product", condition: "new" }, lighting: "柔光箱", depth_of_field: "  " }, options);
    expect(result).toContain("全新，保留真实制造工艺但不编造磨损"); expect(result).not.toMatch(/^景深：\s*$/m);
  });
});
