import { describe, expect, it } from "vitest";
import {
  dedupeImageRefs, normalizeDialogueWindow, normalizePromptLanguage, restoreCardFieldText, restoreTimelineField
} from "./prompt-language.js";

describe("提示词语言与引用归一", () => {
  it("vendor 默认英文负面词 → 中文等价（语义不减，不留英文单词）", () => {
    const report = normalizePromptLanguage("24.【负面约束】no text, no watermark, no signage, 卡通、插画、3D渲染感、塑料皮肤。");
    expect(report.replacements).toBe(3);
    expect(report.prompt).toContain("无文字");
    expect(report.prompt).toContain("无水印");
    expect(report.prompt).toContain("无标牌");
    expect(report.prompt).not.toMatch(/\bno text\b/);
    expect(report.remainingLatin).not.toContain("text");
  });

  it("重复的角色图引用只保留一条", () => {
    const line = "17.【定妆照】image://characters/WIFE-01/portrait.png,image://characters/WIFE-01/portrait.png。";
    const deduped = dedupeImageRefs(line);
    expect(deduped.removed).toBe(1);
    expect(deduped.prompt.match(/image:\/\//g)).toHaveLength(1);
    expect(deduped.prompt).toContain("17.【定妆照】image://characters/WIFE-01/portrait.png。");
  });

  it("只报告剩余拉丁词，不改写（格式/路径/时间码不算英文词）", () => {
    const report = normalizePromptLanguage("规格：9:16 画幅，1080x1920，24fps；T00:00-00:02 走近；31. extra limbs and somethingEnglish");
    expect(report.remainingLatin).toContain("somethingEnglish");
    expect(report.remainingLatin).not.toContain("fps");
    expect(report.prompt).toContain("1080x1920");
  });

  it("替换后不产生重复的顿号/空项", () => {
    const report = normalizePromptLanguage("负面：no text, no text, no watermark。");
    expect(report.prompt).not.toMatch(/、、|、\s*。/);
  });

  /**
   * 真机（2026-09-24）：卡里三段节拍，进提示词只剩前两段（末段 1.5s 丢失）。
   */
  it("时间轴被组装器截断时，用卡片原文补回末段", () => {
    const prompt = [
      "18.【台词】这条河，流了八百年。",
      "19.【时间轴】T00:00-00:02 正面走来开口；T00:02-00:03.5 继续走近微笑；",
      "20.【情绪】开阔明亮"
    ].join("\n");
    const segments = ["T00:00-00:02 正面走来开口", "T00:02-00:03.5 继续走近微笑", "T00:03.5-00:05 停下说完，视线不离镜头"];
    const fixed = restoreTimelineField(prompt, segments);
    expect(fixed.restored).toBe(true);
    expect(fixed.prompt).toContain("T00:03.5-00:05 停下说完，视线不离镜头");
    expect(fixed.prompt).toContain("20.【情绪】开阔明亮");
    // 已经完整 → 不动
    expect(restoreTimelineField(fixed.prompt, segments).restored).toBe(false);
  });

  /**
   * 真机（2026-09-28 T1 商业真人片）：组装器默认负面词中文化后与卡片自带负面词重复拼接，
   * 且卡片把禁用项写成裸词（`水印`/`脸漂`）——监制按"负面约束重复退化串"打回。
   */
  it("【负面约束】中文化后去重并补否定前缀", () => {
    const report = normalizePromptLanguage("24.【负面约束】no text, no watermark, no signage, 无文字、水印、脸漂和塑料道具。");
    expect(report.prompt).toContain("24.【负面约束】无文字、无水印、无标牌、无脸漂、无塑料道具。");
  });

  it("管线强制的英文机器标记不算残留英文，正文残留英文仍被报出", () => {
    const report = normalizePromptLanguage(
      "01.【语言约束】全部字段必须使用中文。24.【负面约束】无文字。 | no non-diegetic music, no background music, no bgm | 与 active portraits/v6 同一造型"
    );
    expect(report.remainingLatin).not.toContain("music");
    expect(report.remainingLatin).not.toContain("bgm");
    expect(report.remainingLatin).toContain("portraits");
  });

  /**
   * 真机（2026-09-28 T1）：vendor 用 Math.round(duration) 算台词窗，4.5s 镜头被写成 [00s-05s]，
   * 监制按"台词窗超出本镜时长、与 4.5s 网格冲突"打回。
   */
  it("台词时间窗超出镜头时长时按真实时长重排", () => {
    const prompt = "18.【台词】[00s-05s] 陈卓 抬手停住后立即开口, 直接 说:\"询盘来了，谁来接？\"";
    const fixed = normalizeDialogueWindow(prompt, 4.5);
    expect(fixed.clamped).toBe(1);
    expect(fixed.prompt).toContain("[00s-04.5s]");
    expect(normalizeDialogueWindow(fixed.prompt, 4.5).clamped).toBe(0);
  });

  it("多段台词窗按块数等分真实时长", () => {
    const prompt = "18.【台词】[00s-03s] 甲 说:\"第一句\"\n[03s-05s] 乙 说:\"第二句\"";
    const fixed = normalizeDialogueWindow(prompt, 4.5);
    expect(fixed.prompt).toContain("[00s-02.3s]");
    expect(fixed.prompt).toContain("[02.3s-04.5s]");
  });

  /**
   * 真机（2026-09-28 T1）：vendor 精炼器把 bright_constraint 重写成 40 字通用句，
   * 并截断 pacing/depth_of_field 等字段末句——监制按"约束被弱化/口径被删"打回。
   */
  it("合同字段被重写或截断时，用镜头卡原文回写该行", () => {
    const prompt = [
      "07.【明亮约束】主体面部明亮清晰，阴影保留层次不死黑。",
      "10.【景深】等效50mm视角，人物眼睛、手与抽屉沿清楚；",
      "21.【节奏】先记录来源、后核对成交；"
    ].join("\n");
    const fixed = restoreCardFieldText(prompt, [
      { label: "明亮约束", value: "脸和黑裙明亮清楚，窗侧高光不过曝；人物上方是真实连续中庭净空，不被低板压顶。" },
      { label: "景深", value: "等效50mm视角，人物眼睛、手与抽屉沿清楚；纸面标签略失焦不可读" },
      { label: "节奏", value: "先记录来源、后核对成交；不暗示自动归因或客户 CRM 回写" }
    ]);
    expect(fixed.restored.map((item) => item.label)).toEqual(["明亮约束", "景深", "节奏"]);
    expect(fixed.prompt).toContain("10.【景深】等效50mm视角，人物眼睛、手与抽屉沿清楚；纸面标签略失焦不可读");
    expect(fixed.prompt).toContain("21.【节奏】先记录来源、后核对成交；不暗示自动归因或客户 CRM 回写");
    expect(fixed.prompt).toContain("07.【明亮约束】脸和黑裙明亮清楚，窗侧高光不过曝；");
  });

  it("场景圣经等扩展字段（提示词行比卡片长）不回写，避免丢失扩展信息", () => {
    const prompt = "05.【场景】明亮的高档别墅式企业会客厅首层正式访谈位；上海；约 1300 ㎡；东侧拱形高窗；";
    const fixed = restoreCardFieldText(prompt, [{ label: "场景", value: "明亮的高档别墅式企业会客厅首层正式访谈位" }]);
    expect(fixed.restored).toHaveLength(0);
    expect(fixed.prompt).toBe(prompt);
  });
});
