import { describe, expect, it } from "vitest";
import {
  BRIDGE_STRUCTURE_CONSTRAINT,
  DEVICE_STANDARD_CONSTRAINT,
  ENVIRONMENT_REALISM_CONSTRAINT,
  PROP_INTERACTION_CONSTRAINT,
  buildPlatePrompt,
  hasElectronicDevice,
  hasInteractiveProp,
  isBridgeScene,
  UNIVERSAL_SPATIAL_INVARIANT
} from "./plate-prompt.js";

const shot = {
  shotId: "SC-02",
  costume: "月白色苏式改良旗袍，立领盘扣",
  makeup: "通透裸妆，豆沙唇",
  scene: "苏州平江路的石拱桥桥头：人物站在桥头青石板桥面上，身后桥面沿拱形延伸并与对岸巷口相接",
  sceneDescription: "青石栏杆沿桥面两侧连续延伸，透过栏杆可见桥下河道",
  action: "沿桥面从画面深处正面走近镜头",
  composition: "人物居中偏下、面部正对镜头；脚下桥面石板清晰可见",
  lighting: "上午十点柔和散射日光",
  color_palette: "黛青与月白",
  mood: "开阔明亮"
};
const options = { characterName: "陈卓", appearanceText: "中国江南女性", aspect: "9:16", resolution: "1080p", title: "平江路 慢慢走" };

describe("关键帧提示词组装（从脚本搬进公开模块 + 回归保护）", () => {
  /**
   * 真机二次事故：脚本版数组里残留 diff 标记 `+`，那一行成了 `+"…"` = NaN，
   * 于是"空间物理自洽"整段没进提示词，进 Ark 的是字面 "NaN"。
   * 这两条断言就是防它再犯的哨兵。
   */
  it("不得出现 NaN / undefined / [object Object] 这三种退化哨兵", () => {
    const prompt = buildPlatePrompt(shot, options);
    expect(prompt).not.toMatch(/(^|\n)NaN(\n|$)/);
    expect(prompt).not.toContain("undefined");
    expect(prompt).not.toContain("[object Object]");
  });

  it("通用空间物理不变量必须真的在提示词里", () => {
    expect(buildPlatePrompt(shot, options)).toContain(UNIVERSAL_SPATIAL_INVARIANT);
  });

  it("桥类场景追加桥体硬约束；非桥场景不加", () => {
    expect(isBridgeScene(shot)).toBe(true);
    expect(buildPlatePrompt(shot, options)).toContain(BRIDGE_STRUCTURE_CONSTRAINT);
    const indoors = {
      ...shot,
      scene: "老字号茶食铺门口，木招牌与青砖门头",
      sceneDescription: "竹托盘上摆着青花瓷碗",
      composition: "人物居中，面部正对镜头",
      action: "双手捧起青花瓷碗，低头轻闻后抬眼看镜头"
    };
    expect(isBridgeScene(indoors)).toBe(false);
    expect(buildPlatePrompt(indoors, options)).not.toContain(BRIDGE_STRUCTURE_CONSTRAINT);
    // 只要动作里出现"桥"，就按桥类场景加硬约束（宁可多约束，不可漏）
    expect(isBridgeScene({ ...indoors, action: "沿石桥桥面走近镜头" })).toBe(true);
  });

  it("字段齐全且顺序稳定（白平衡锚点在最前、禁止项在最后）", () => {
    const prompt = buildPlatePrompt(shot, options);
    const lines = prompt.split("\n");
    expect(lines[0]).toContain("白平衡中性");
    expect(lines.at(-1)).toContain("禁止：文字、字幕、水印");
    for (const field of ["服装：", "妆造：", "场景：", "环境细节：", "人物动作与表情", "构图：", "光线：", "色调：", "情绪：", "规格："]) {
      expect(prompt, `${field} 必须在场`).toContain(field);
    }
    expect(prompt).toContain("陈卓");
  });
});

/**
 * 2026-09-25 第四轮知识注入审计（落地层）：
 * 知识注入把"该浅还是该深""画面里有什么材质/粒子"写进 depth_of_field 与 props，
 * 但关键帧提示词此前根本没有这两行；而「规格」行无条件写着"浅景深"——
 * 于是风光/建筑/合影/车轨/微距的深景深档在关键帧阶段被覆盖（航拍梯田也按浅景深出图）。
 * 关键帧是图生视频的首帧：首帧没有的东西，后面不会长出来。
 */
describe("知识注入落地层：景深与道具必须进关键帧提示词", () => {
  it("注入的 depth_of_field 出现在提示词，且【规格】行不再硬编码浅景深", () => {
    const withDepth = { ...shot, depth_of_field: "全画面锐利、细节丰富（较深景深）" };
    const prompt = buildPlatePrompt(withDepth, options);
    expect(prompt).toContain("景深：全画面锐利、细节丰富（较深景深）");
    expect(prompt.split("\n").find((l) => l.startsWith("规格："))).not.toContain("浅景深");
  });

  it("卡片没有声明景深时，规格行仍给通用安全值浅景深（不劣化）", () => {
    const prompt = buildPlatePrompt(shot, options);
    expect(prompt).not.toContain("景深：");
    expect(prompt.split("\n").find((l) => l.startsWith("规格："))).toContain("浅景深");
  });

  it("注入的 props 出现在提示词；无 props 时不产生空的占位行", () => {
    const withProps = { ...shot, props: "无风水面如镜面，倒影清晰稳定" };
    expect(buildPlatePrompt(withProps, options)).toContain("道具与质感：无风水面如镜面，倒影清晰稳定");
    expect(buildPlatePrompt(shot, options)).not.toContain("道具与质感：");
  });

  it("空字符串字段不得变成空行（避免占位噪音进提示词）", () => {
    const prompt = buildPlatePrompt({ ...shot, depth_of_field: "   ", props: "" }, options);
    expect(prompt).not.toMatch(/^景深：\s*$/m);
    expect(prompt).not.toMatch(/^道具与质感：\s*$/m);
  });
});

/**
 * 2026-09-27 真机事故（产品所有者一眼判"不像实拍"）：
 * 旧提示词侧**没有任何"环境真实性"约束**——模型收到"现代简约商务空间"这类空词，
 * 只能落回训练分布里的**平均办公室**。这一组断言守住"约束真的在提示词里"（提示词侧兜一层）。
 */
describe("环境真实性与道具交互（2026-09-27 事故机制化）", () => {
  it("环境真实性约束对**每一镜**生效（不挑场景类型）", () => {
    expect(buildPlatePrompt(shot, options)).toContain(ENVIRONMENT_REALISM_CONSTRAINT);
    const office = {
      ...shot,
      scene: "1930 年代外滩银行改建办公楼 18 层会议室，胡桃木饰面墙与混凝土梁",
      sceneDescription: "浅橡木地板有细划痕与旧钉眼，桌面有咖啡杯痕",
      composition: "人物坐姿半身，面部正对镜头",
      action: "右手按住桌上的档案夹，抬眼看镜头"
    };
    expect(buildPlatePrompt(office, options)).toContain(ENVIRONMENT_REALISM_CONSTRAINT);
  });

  it("出现可交互器物时追加道具-人体交互硬约束；没有器物时不加（避免噪音）", () => {
    expect(hasInteractiveProp(shot)).toBe(false);
    expect(buildPlatePrompt(shot, options)).not.toContain(PROP_INTERACTION_CONSTRAINT);

    const phoneShot = {
      ...shot,
      scene: "1930 年代银行改建会议室",
      sceneDescription: "桌上立着手机支架与笔记本",
      action: "低头看手机屏幕，随后抬眼看镜头"
    };
    expect(hasInteractiveProp(phoneShot)).toBe(true);
    const prompt = buildPlatePrompt(phoneShot, options);
    expect(prompt).toContain(PROP_INTERACTION_CONSTRAINT);
    /** 手机屏幕朝观众这个 badcase 的判据必须写死：观众只见机身背面或侧缘 */
    expect(prompt).toContain("屏幕朝向它的使用者");
  });

  it("约束顺序稳定：通用物理不变量 → 环境真实性 → 场景条件约束 → 禁止项（禁止项仍在最后一行）", () => {
    const prompt = buildPlatePrompt(shot, options);
    const lines = prompt.split("\n");
    const indexOf = (needle: string): number => lines.findIndex((line) => line.includes(needle));
    expect(indexOf("场景结构与物理自洽（通用）")).toBeGreaterThan(-1);
    expect(indexOf("环境真实性（通用）")).toBeGreaterThan(indexOf("场景结构与物理自洽（通用）"));
    expect(indexOf("桥类结构（本镜硬约束）")).toBeGreaterThan(indexOf("环境真实性（通用）"));
    expect(lines.at(-1)).toContain("禁止：文字、字幕、水印");
  });
});

/**
 * 设备口径（2026-09-27 产品所有者硬约束）：场景里的电子设备**全部使用 2024 年之后的 Apple 设备**。
 * 提示词侧只给"机型按卡片声明的型号呈现 + 无非 Apple 标识"这类**画面语言**，
 * 具体机型清单由 `device-policy.ts#DEVICE_ALLOWLIST` 单一事实源给出（避免两处维护）。
 */
describe("设备口径（2024 年后 Apple 设备）", () => {
  it("含电子设备的镜头追加设备硬约束；不含设备的不加", () => {
    expect(hasElectronicDevice(shot)).toBe(false);
    expect(buildPlatePrompt(shot, options)).not.toContain(DEVICE_STANDARD_CONSTRAINT);

    const laptopShot = {
      ...shot,
      scene: "1936 年纺织厂改建办公楼 4 层会议室",
      sceneDescription: "长桌上放着一台 MacBook Pro（M4 世代）与一杯咖啡",
      action: "她合上 MacBook Pro 屏幕后抬眼看向镜头"
    };
    expect(hasElectronicDevice(laptopShot)).toBe(true);
    const prompt = buildPlatePrompt(laptopShot, options);
    expect(prompt).toContain(DEVICE_STANDARD_CONSTRAINT);
    expect(prompt).toContain("Apple 在售机型");
    expect(linesOf(prompt).at(-1)).toContain("禁止：文字、字幕、水印");
  });
});

const linesOf = (prompt: string): string[] => prompt.split("\n");
