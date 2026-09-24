import { describe, expect, it } from "vitest";
import { BRIDGE_STRUCTURE_CONSTRAINT, buildPlatePrompt, isBridgeScene, UNIVERSAL_SPATIAL_INVARIANT } from "./plate-prompt.js";

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
