import { expect, it } from "vitest";
import {
  applyNarrativeFinalPromptContract, normalizeNarrativePromptsForReview,
  type NarrativePromptReviewPolicy,
} from "./vendor-compat.js";

const requirements = ["拿起箱子", "走到门口", "放下箱子", "返回门内", "拿起箱子", "检查扣带", "走到门口", "放下箱子", "收起扣带"];
const policy: NarrativePromptReviewPolicy = {
  noDialogue: true, noMusic: true, noCharacters: false, noAnimals: true, noTitles: true,
  maxLength: 3000, durationSeconds: 8, aspectRatio: "9:16", resolution: "1080x1920",
  characterNames: ["顾客"], characterPortraits: [{ name: "顾客", path: "approved.png", costume: "项目级外套、帽子" }],
  projectScene: "项目级门口", projectLighting: "项目级光位", projectColor: "项目级色彩",
  projectProps: ["整片箱子", "整片扣带"], projectActions: requirements,
  marketingPrompt: { actions: requirements, overlay: ["封闭场地｜请勿模仿"], endCard: ["训练系列"] },
};

function nativeShot(id = "N1") {
  const fields = {
    scene: "门内储物间，箱子旁保持可行走的通道。", action: "顾客先解开扣带，再把箱子稳稳放到地面。",
    costume: "帽子已摘下握在左手，外套领口保持松开。", makeup: "自然肤色，额角有少量汗珠。",
    props: "一只箱子、一条已解开的扣带、左手握着的帽子。", timeline: "T00:00-T00:02 解开扣带；T00:02-T00:04 箱子接触地面，双手离开后保持静止。",
    composition: "全景，箱子与双手完整入画，画右保留通道。", lighting: "左侧窗光照亮手部，右侧保持自然阴影。",
    color_palette: "低饱和灰绿，肤色保持中性。", transition: "本镜落幅保持一秒，再硬切至门外。",
    mood: "视线随箱子落到地面，确认放稳后缓慢呼气。", camera_movement: "固定机位，保持同一轴线。",
    depth_of_field: "中等景深，扣带与箱子边缘同时清晰。", pacing: "前两秒解扣，后两秒放稳并收手。",
    character: "顾客站在箱子左侧，视线落在扣带接触点。", audio: "箱子落地的轻响；扣带摩擦声；背景音乐钢琴与人声旁白。",
  };
  return { shotId: id, duration: 4, ...fields, action: "旧顶层动作", scene: "旧顶层场景", fields,
    prompt: "01.【动作】错误的全局动作\n02.【音频】背景音乐钢琴与人声旁白", _workloomPromptReviewPolicy: policy };
}

const rendered = (shot: { prompt?: unknown }, label: string) =>
  String(shot.prompt).match(new RegExp(`^\\d+\\.【${label}】([^\\n]*)$`, "mu"))?.[1];

it("keeps complete native per-shot direction instead of reassigning global requirement positions", () => {
  const shot = nativeShot();
  const before = structuredClone(shot);
  const result = applyNarrativeFinalPromptContract(shot, { ...policy, canonicalize: true, chineseOnly: true, shotIndex: 1 });
  for (const [label, key] of Object.entries({ 场景: "scene", 动作: "action", 服装: "costume", 道具: "props",
    时间轴: "timeline", 构图: "composition", 灯光设计: "lighting", "色彩/色调": "color_palette", 转场: "transition",
    情绪: "mood", 节奏: "pacing", 运镜: "camera_movement", 景深: "depth_of_field" })) {
    expect(rendered(result, label), label).toBe(shot.fields[key as keyof typeof shot.fields]);
  }
  expect(rendered(result, "动作")).not.toBe(requirements[1]);
  expect(rendered(result, "服装")).not.toContain("项目级");
  expect(rendered(result, "道具")).not.toContain("整片");
  expect(result.prompt).toContain("后期成片叠加原文“封闭场地｜请勿模仿”");
  expect(shot).toEqual(before);
});

it("rebuilds marketing rows idempotently before G6 without restoring global actions or wardrobe", () => {
  const original = [nativeShot(), nativeShot("N2")];
  const before = structuredClone(original);
  const first = normalizeNarrativePromptsForReview(original, policy);
  const second = normalizeNarrativePromptsForReview(first, policy);
  expect(second.map(row => row.prompt)).toEqual(first.map(row => row.prompt));
  expect(rendered(first[0]!, "动作")).toBe(original[0]!.fields.action);
  expect(rendered(first[1]!, "服装")).toBe(original[1]!.fields.costume);
  expect(original).toEqual(before);
});

it("keeps explicit native spaces and props when the action contains familiar door and footwear words", () => {
  const shot = nativeShot();
  shot.fields.action = "顾客在摄影棚道具门旁换下红色长靴，再把蓝色便鞋放回展示台。";
  shot.fields.scene = "摄影棚乙区的展示台，背景道具门始终关闭，窗边自然光持续照明。";
  shot.fields.props = "红色长靴、蓝色便鞋、展示台，均保持当前镜头的位置。";
  const result = normalizeNarrativePromptsForReview([shot], { ...policy, postRainOnly: true })[0]!;
  expect(rendered(result, "场景")).toBe(shot.fields.scene);
  expect(rendered(result, "道具")).toBe(shot.fields.props);
  expect(rendered(result, "动作")).toBe(shot.fields.action);
});

it.each(["action", "scene", "timeline"] as const)("fails explicitly when the native %s is missing", key => {
  const shot = nativeShot();
  delete (shot as Record<string, unknown>)[key];
  delete (shot.fields as Record<string, unknown>)[key];
  expect(() => normalizeNarrativePromptsForReview([shot], policy))
    .toThrow(new RegExp(`MARKETING_NATIVE_SHOT_FIELD_MISSING.*N1.*${key}`, "u"));
});

it("keeps speech and music prohibitions active while preserving a native empty shot", () => {
  const shot = nativeShot();
  shot.fields.character = "无角色出场，不适用";
  shot.fields.action = "画面内无人物进入，窗边光线缓慢移动。";
  shot.fields.costume = "无角色出场，不适用";
  const result = normalizeNarrativePromptsForReview([shot], policy)[0]!;
  expect(rendered(result, "动作")).toBe(shot.fields.action);
  expect(rendered(result, "角色")).toContain("无人物");
  expect(rendered(result, "服装")).not.toContain("项目级外套");
  expect(rendered(result, "音频")).toContain("无人物声、无旁白");
  expect(rendered(result, "音频")).toContain("无音乐、无配乐、无音乐节拍");
  expect(rendered(result, "音频")).not.toContain("钢琴");
});

it("does not hide over-capacity native direction behind the short global requirement list", () => {
  const shot = nativeShot("native-too-long");
  shot.fields.action = "顾客逐项核对箱子与扣带的接触关系，保持每个动作连续。".repeat(150);
  expect(() => normalizeNarrativePromptsForReview([shot], policy))
    .toThrow(/FINAL_PROMPT_SOURCE_CAPACITY_EXCEEDED.*native-too-long.*3000/u);
});
