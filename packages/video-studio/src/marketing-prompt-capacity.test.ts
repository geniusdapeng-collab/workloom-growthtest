import { expect, it } from "vitest";
import { applyNarrativeFinalPromptContract } from "./vendor-compat.js";

const options = {
  noDialogue: true, noMusic: true, noCharacters: false, noAnimals: true, maxLength: 3000,
  aspectRatio: "9:16", characterNames: ["角色甲"], canonicalize: true, requireOpeningFields: true,
  isLastShot: true, marketingPrompt: { actions: ["拿起箱子"], overlay: ["演示$&𠮷｜请勿模仿"], endCard: ["训练系列"] },
};

function nativeShot() {
  const fields = {
    scene: "仓库内的展示台旁，通道空出。", action: "角色甲先解开扣带，再把箱子稳稳放到展示台上。",
    costume: "工作外套，帽子已摘下握在左手。", makeup: "自然肤色。", props: "一只箱子、一条解开的扣带。",
    timeline: "T00:00-T00:02 解开扣带；T00:02-T00:04 箱子放稳。", composition: "全景，箱子与双手完整入画。",
    lighting: "左侧窗光，右侧自然阴影。", color_palette: "中性灰绿，肤色自然。", transition: "落幅保持静止。",
    mood: "确认放稳后缓慢呼气。", pacing: "先解扣，再放稳。", depth_of_field: "箱子与双手同时清晰。",
    camera_movement: "固定机位。", character: "角色甲站在展示台左侧。", audio: "箱子落地声与扣带摩擦声。",
  };
  return { shotId: "capacity-native", sceneType: "opening", duration: 4, ...fields, fields,
    title_content: "训练演示", subtitle_content: "完整动作", title_animation: "片名由淡入到静止，不遮挡双手。",
    title_font_design: "简洁无衬线字，边缘留安全区。", opening_audio_design: "箱子落地声与扣带摩擦声。",
    prompt: "01.【基础】电影级写实，保留真实材质。" };
}

function atLength(target: number, padded: "scene" | "title_content" = "scene") {
  const shot = nativeShot();
  if (padded === "scene") shot.fields.scene = "墙".repeat(2000);
  else shot.title_content = "示".repeat(2000);
  const measure = () => Array.from(String(applyNarrativeFinalPromptContract(shot, { ...options, maxLength: 10000 }).prompt)).length;
  const count = 2000 + target - measure();
  if (padded === "scene") shot.fields.scene = "墙".repeat(count);
  else shot.title_content = "示".repeat(count);
  expect(measure()).toBe(target);
  return shot;
}

const field = (prompt: unknown, label: string) => String(prompt).match(new RegExp(`^\\d+\\.【${label}】([^\\n]*)$`, "mu"))?.[1];

it.each(["scene", "title_content"] as const)("fits a 3093-character assembly by shortening only host QA, with %s padding", padded => {
  const shot = atLength(3093, padded);
  const before = structuredClone(shot);
  const full = applyNarrativeFinalPromptContract(shot, { ...options, maxLength: 10000 });
  const result = applyNarrativeFinalPromptContract(shot, options);
  expect(Array.from(String(result.prompt)).length).toBeLessThanOrEqual(3000);
  for (const label of ["场景", "动作", "服装", "化妆", "道具", "时间轴", "构图", "灯光设计", "色彩/色调", "转场", "情绪", "节奏", "运镜", "景深"]) {
    expect(field(result.prompt, label), label).toBe(field(full.prompt, label));
  }
  for (const key of ["title_content", "subtitle_content", "title_animation", "title_font_design", "opening_audio_design"] as const) {
    expect(String(result.prompt)).toContain(shot[key]);
  }
  expect(result.prompt).toContain(options.marketingPrompt.overlay[0]);
  expect(result.prompt).toContain(options.marketingPrompt.endCard[0]);
  expect(String(result.prompt).match(/^\d+\.【[^】]+】/gmu)).toHaveLength(String(full.prompt).match(/^\d+\.【[^】]+】/gmu)!.length);
  const contract = result._workloomShotContract as Record<string, unknown>;
  expect(contract.verification).toBe(field(full.prompt, "本镜验收"));
  if (field(full.prompt, "交付复核")) expect(contract.deliveryReview).toBe(field(full.prompt, "交付复核"));
  expect(shot).toEqual(before);
});

it("leaves fitting assemblies unchanged and still rejects native content beyond the hard limit", () => {
  const fitting = atLength(2900);
  expect(applyNarrativeFinalPromptContract(fitting, options).prompt)
    .toBe(applyNarrativeFinalPromptContract(fitting, { ...options, maxLength: 10000 }).prompt);
  const overflowing = atLength(4500);
  const before = structuredClone(overflowing);
  expect(() => applyNarrativeFinalPromptContract(overflowing, options))
    .toThrow(/FINAL_PROMPT_SOURCE_CAPACITY_EXCEEDED.*capacity-native.*3000/u);
  expect(overflowing).toEqual(before);
});
