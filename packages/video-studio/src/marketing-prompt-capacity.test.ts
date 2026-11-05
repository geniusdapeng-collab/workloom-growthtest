import { expect, it } from "vitest";
import { applyNarrativeFinalPromptContract, normalizeNarrativePromptsForReview,
  type NarrativePromptReviewPolicy } from "./vendor-compat.js";

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

it.each(["scene", "title_content"] as const)("fits the observed3120 QA-only boundary by shortening host templates, preserving %s", padded => {
  const base = applyNarrativeFinalPromptContract(atLength(3300, padded), { ...options, maxLength: 10000 });
  const oldCompactQa = [
    "按本镜原生合同核对动作、声画与跨镜连续性",
    ...options.marketingPrompt.overlay.map(text => `后期成片叠加原文“${text}”，底画面无需模型生成文字`),
    ...options.marketingPrompt.endCard.map(text => `本镜结束在后期尾帧原文“${text}”`),
  ].join("；");
  const qaSaving = Array.from(field(base.prompt, "本镜验收")!).length - Array.from(oldCompactQa).length
    + (field(base.prompt, "交付复核") ? Array.from(field(base.prompt, "交付复核")!).length - Array.from("详细复核见结构化镜头合同，按本镜原生字段逐项验收。").length : 0);
  const shot = atLength(3120 + qaSaving, padded);
  shot.prompt += "\n24.【负面约束】无船只、无建筑、无现代设备";
  const extra = Array.from(String(applyNarrativeFinalPromptContract(shot, { ...options, maxLength: 10000 }).prompt)).length - qaSaving - 3120;
  if (padded === "scene") shot.fields.scene = shot.fields.scene.slice(0, -extra);
  else shot.title_content = shot.title_content.slice(0, -extra);
  const original = structuredClone(shot);
  const full = applyNarrativeFinalPromptContract(shot, { ...options, maxLength: 10000 });
  // The previous QA-only projection of this synthetic source is exactly3120.
  expect(Array.from(String(full.prompt)).length - qaSaving).toBe(3120);
  const result = applyNarrativeFinalPromptContract(shot, options);
  expect(Array.from(String(result.prompt)).length).toBeLessThanOrEqual(3000);
  for (const label of ["场景", "动作", "服装", "化妆", "道具", "时间轴", "构图", "灯光设计", "色彩/色调", "转场", "情绪", "节奏", "运镜", "景深"]) {
    expect(field(result.prompt, label), label).toBe(field(full.prompt, label));
  }
  for (const key of ["title_content", "subtitle_content", "title_animation", "title_font_design", "opening_audio_design"] as const) {
    expect(String(result.prompt)).toContain(shot[key]);
  }
  for (const literal of [...options.marketingPrompt.overlay, ...options.marketingPrompt.endCard, "无船只", "无建筑", "无现代设备"]) {
    expect(String(result.prompt)).toContain(literal);
  }
  const contract = result._workloomShotContract as Record<string, unknown>;
  const templates = contract.hostTemplates as Record<string, string>;
  for (const label of ["语言约束", "导演意图", "明亮约束", "负面约束", "角色约束", "角色一致性", "台词", "音频", "本镜验收"]) {
    expect(templates[label], label).toBe(field(full.prompt, label));
  }
  expect(field(result.prompt, "角色")).toBe(field(full.prompt, "角色"));
  expect(String(result.prompt).match(/^\d+\.【[^】]+】/gmu)).toHaveLength(String(full.prompt).match(/^\d+\.【[^】]+】/gmu)!.length);
  expect(shot).toEqual(original);
  expect(applyNarrativeFinalPromptContract(result, options).prompt).toBe(result.prompt);
});

it("retains complete registered identity text in the report contract while keeping the exact portrait path in the compact prompt", () => {
  const portrait = { name: "角色甲", path: "image://characters/actor-a/front.png", appearance: "短发、灰眼、左颊一颗痣。".repeat(15) };
  const shot = atLength(3300);
  const policy = { ...options, characterPortraits: [portrait] };
  const measured = applyNarrativeFinalPromptContract(shot, { ...policy, maxLength: 10000 });
  const oldCompactQa = ["按本镜原生合同核对动作、声画与跨镜连续性",
    ...options.marketingPrompt.overlay.map(text => `后期成片叠加原文“${text}”，底画面无需模型生成文字`),
    ...options.marketingPrompt.endCard.map(text => `本镜结束在后期尾帧原文“${text}”`)].join("；");
  const qaSaving = Array.from(field(measured.prompt, "本镜验收")!).length - Array.from(oldCompactQa).length
    + (field(measured.prompt, "交付复核") ? Array.from(field(measured.prompt, "交付复核")!).length - Array.from("详细复核见结构化镜头合同，按本镜原生字段逐项验收。").length : 0);
  const extra = Array.from(String(measured.prompt)).length - qaSaving - 3120;
  shot.fields.scene = shot.fields.scene.slice(0, -extra);
  const full = applyNarrativeFinalPromptContract(shot, { ...policy, maxLength: 10000 });
  expect(Array.from(String(full.prompt)).length - qaSaving).toBe(3120);
  const result = applyNarrativeFinalPromptContract(shot, policy);
  expect(Array.from(String(result.prompt)).length).toBeLessThanOrEqual(3000);
  expect(field(result.prompt, "角色")).toContain(portrait.name);
  expect(field(result.prompt, "定妆照")).toContain(portrait.path);
  const templates = (result._workloomShotContract as Record<string, unknown>).hostTemplates as Record<string, string>;
  expect(templates["角色"]).toBe(field(full.prompt, "角色"));
  expect(templates["角色"]).toContain(portrait.appearance);
  expect((result._workloomShotContract as Record<string, unknown>).portraitAssets)
    .toMatchObject([{ name: portrait.name, path: portrait.path, authorization: "unverified" }]);
  expect(String(result.prompt)).toContain(options.marketingPrompt.overlay[0]);
});

it("rebuilds an observed3823-character unnumbered postprocess draft from native marketing fields before the final cap", () => {
  const shot = { ...nativeShot(), prompt: "稿".repeat(3823) };
  const before = structuredClone(shot);
  const policy: NarrativePromptReviewPolicy = { ...options, noTitles: false, resolution: "1080x1920",
    characterPortraits: [], projectProps: [], projectActions: options.marketingPrompt.actions };
  const full = applyNarrativeFinalPromptContract(nativeShot(), { ...options, maxLength: 10000 });
  const result = normalizeNarrativePromptsForReview([shot], policy)[0]!;
  expect(Array.from(String(result.prompt)).length).toBeLessThanOrEqual(3000);
  for (const label of ["场景", "动作", "服装", "化妆", "道具", "时间轴", "构图", "灯光设计", "色彩/色调", "转场", "情绪", "节奏", "运镜", "景深"]) {
    expect(field(result.prompt, label), label).toBe(field(full.prompt, label));
  }
  for (const key of ["title_content", "subtitle_content", "title_animation", "title_font_design", "opening_audio_design"] as const) {
    expect(String(result.prompt)).toContain(shot[key]);
  }
  expect(normalizeNarrativePromptsForReview([result], policy)[0]!.prompt).toBe(result.prompt);
  expect(shot).toEqual(before);
});

it("does not bypass unstructured input limits without marketing canonical reconstruction", () => {
  const shot = { ...nativeShot(), prompt: "稿".repeat(3823) };
  expect(() => applyNarrativeFinalPromptContract(shot, { ...options, canonicalize: false }))
    .toThrow("FINAL_PROMPT_UNCOMPRESSIBLE");
  expect(() => applyNarrativeFinalPromptContract(shot, { ...options, marketingPrompt: undefined }))
    .toThrow("FINAL_PROMPT_UNCOMPRESSIBLE");
});

it("still rejects oversized native creative content after discarding an unnumbered postprocess draft", () => {
  const shot = { ...atLength(4500), prompt: "稿".repeat(3823) };
  const before = structuredClone(shot);
  expect(() => applyNarrativeFinalPromptContract(shot, options))
    .toThrow(/FINAL_PROMPT_SOURCE_CAPACITY_EXCEEDED.*3000/u);
  expect(shot).toEqual(before);
});

const registeredOptions = {
  ...options, requireOpeningFields: false, noAnimals: false, noMusic: false,
  characterPortraits: [{ name: "角色甲", path: "bundles/characters/actor-a/portraits/front.png",
    appearance: "短发、灰眼，穿灰色工作服。", authorization: "registered" }],
};

function atSecondCompactLength(target: number, overrides: Partial<typeof registeredOptions> = {}) {
  const shot = nativeShot();
  const policy = { ...registeredOptions, ...overrides };
  shot.sceneType = "content";
  if (policy.noCharacters) {
    Object.assign(shot.fields, { character: "空镜无角色", costume: "不适用：无人物", makeup: "不适用：无人物",
      action: "箱盖缓慢合上并停稳。", timeline: "T00:00-T00:04 箱盖合拢至停稳。" });
  }
  shot.fields.scene = "墙".repeat(2500);
  const measure = () => Array.from(String(applyNarrativeFinalPromptContract(shot, {
    ...policy, maxLength: Number.MAX_SAFE_INTEGER, forceCompactMarketingHost: true,
  }).prompt)).length;
  shot.fields.scene = "墙".repeat(2500 + target - measure());
  expect(measure()).toBe(target);
  return shot;
}

it.each([3067, 3123])("fits the observed %i-character second-pass boundary using only repeated host policy", target => {
  const shot = atSecondCompactLength(target);
  const before = structuredClone(shot);
  const full = applyNarrativeFinalPromptContract(shot, { ...registeredOptions, maxLength: Number.MAX_SAFE_INTEGER });
  const priorCompact = applyNarrativeFinalPromptContract(shot, {
    ...registeredOptions, maxLength: Number.MAX_SAFE_INTEGER, forceCompactMarketingHost: true,
  });
  expect(Array.from(String(priorCompact.prompt))).toHaveLength(target);
  const result = applyNarrativeFinalPromptContract(shot, registeredOptions);
  expect(Array.from(String(result.prompt)).length).toBeLessThanOrEqual(3000);
  for (const label of ["场景", "动作", "服装", "化妆", "道具", "时间轴", "构图", "灯光设计", "色彩/色调", "转场", "情绪", "节奏", "运镜", "景深"]) {
    expect(field(result.prompt, label), label).toBe(field(full.prompt, label));
  }
  expect(field(result.prompt, "角色")).toBe(shot.fields.character);
  expect(result.audio).toBe((result.fields as Record<string, unknown>).audio);
  expect(String(field(result.prompt, "音频"))).toContain(String(result.audio));
  expect(String(result.prompt)).toContain(registeredOptions.characterPortraits[0]!.path);
  for (const literal of [...options.marketingPrompt.overlay, ...options.marketingPrompt.endCard]) expect(String(result.prompt)).toContain(literal);
  for (const literal of ["中文", "技术参数", "时间码", "资产路径", "声画", "跨镜", "禁过曝", "正面补光",
    "水印", "品牌", "特效", "光晕", "模糊", "暗黑", "塑料", "金属感高光", "禁未声明角色",
    "身份", "服妆", "发型", "合并", "替换", "增减", "禁台词", "对白", "旁白", "口播", "禁镜头外配乐"]) {
    expect(String(result.prompt), literal).toContain(literal);
  }
  const templates = (result._workloomShotContract as Record<string, unknown>).hostTemplates as Record<string, string>;
  for (const label of ["导演意图", "明亮约束", "负面约束", "角色约束", "角色一致性", "角色", "音频", "本镜验收"]) {
    expect(templates[label], label).toBe(field(full.prompt, label));
  }
  expect(String(result.prompt).match(/^\d+\.【[^】]+】/gmu)).toHaveLength(27);
  expect(applyNarrativeFinalPromptContract(result, registeredOptions).prompt).toBe(result.prompt);
  expect(shot).toEqual(before);
});

it.each([0, 1, 4, 5])("defers only pre-title marketing body lines with %i inherited native title fields", count => {
  const shot = nativeShot();
  const keys = ["title_content", "subtitle_content", "title_animation", "title_font_design", "opening_audio_design"] as const;
  const kept = count === 4 ? keys.filter(key => key !== "title_animation") : keys.slice(0, count);
  for (const key of keys) if (!kept.includes(key)) delete (shot as Record<string, unknown>)[key];
  if (count > 0) shot.title_content = "继承旧稿".repeat(900);
  const before = structuredClone(shot);
  const result = applyNarrativeFinalPromptContract(shot, {
    ...registeredOptions, deferOpeningFields: true,
  } as Parameters<typeof applyNarrativeFinalPromptContract>[1]);
  expect(Array.from(String(result.prompt)).length).toBeLessThanOrEqual(3000);
  for (const key of keys) expect(result[key]).toEqual((shot as Record<string, unknown>)[key]);
  for (const label of ["主标题内容", "副标题内容", "标题动画设计", "标题字体设计", "开场音频设计"]) {
    expect(String(result.prompt)).not.toContain("【" + label + "】");
  }
  expect(shot).toEqual(before);
  for (const [key, value] of Object.entries(shot.fields)) {
    if (key !== "audio") expect((result.fields as Record<string, unknown>)[key], key).toBe(value);
  }
  expect(() => normalizeNarrativePromptsForReview([result], {
    ...registeredOptions, noTitles: false, resolution: "1080x1920", projectProps: [], projectActions: [],
  })).toThrow(count < keys.length ? /FINAL_PROMPT_OPENING_FIELDS_MISSING/u : /FINAL_PROMPT_SOURCE_CAPACITY_EXCEEDED/u);
  if (count > 0) expect(() => applyNarrativeFinalPromptContract(shot, registeredOptions))
    .toThrow(/FINAL_PROMPT_SOURCE_CAPACITY_EXCEEDED/u);
});

it("retains the exact 3000/3001 Unicode boundary after the final host pass", () => {
  const shot = atSecondCompactLength(3123);
  const first = applyNarrativeFinalPromptContract(shot, registeredOptions);
  const room = 3000 - Array.from(String(first.prompt)).length;
  shot.fields.scene += "𠮷".repeat(room);
  const result = applyNarrativeFinalPromptContract(shot, registeredOptions);
  expect(Array.from(String(result.prompt))).toHaveLength(3000);
  expect(field(result.prompt, "场景")).toBe(shot.fields.scene);
  shot.fields.scene += "𠮷";
  const before = structuredClone(shot);
  expect(() => applyNarrativeFinalPromptContract(shot, registeredOptions))
    .toThrow(/FINAL_PROMPT_SOURCE_CAPACITY_EXCEEDED.*3001.*3000/u);
  expect(shot).toEqual(before);
});

it("does not let the pre-title option bypass final opening requirements or alter nonmarketing behavior", () => {
  const shot = nativeShot();
  const complete = applyNarrativeFinalPromptContract(shot, {
    ...registeredOptions, requireOpeningFields: true, deferOpeningFields: true,
  });
  expect(String(complete.prompt)).toContain("【标题动画设计】" + shot.title_animation);
  const nonmarketing = applyNarrativeFinalPromptContract(shot, {
    ...registeredOptions, marketingPrompt: undefined, deferOpeningFields: true,
  });
  expect(String(nonmarketing.prompt)).toContain("【标题动画设计】" + shot.title_animation);
  delete (shot as Record<string, unknown>).title_animation;
  expect(() => applyNarrativeFinalPromptContract(shot, {
    ...registeredOptions, requireOpeningFields: true, deferOpeningFields: true,
  })).toThrow(/FINAL_PROMPT_OPENING_FIELDS_MISSING/u);
});

it("keeps additional environment, animal and music prohibitions inside the third-pass prompt", () => {
  const shot = atSecondCompactLength(3067);
  shot.prompt += "\n24.【负面约束】无船只、无建筑、无现代设备";
  const before = structuredClone(shot);
  const result = applyNarrativeFinalPromptContract(shot, {
    ...registeredOptions, noAnimals: true, noMusic: true,
  });
  for (const literal of ["无船只", "无建筑", "无现代设备", "禁动物/飞鸟", "禁音乐/配乐/音乐节拍", "禁台词", "对白", "旁白", "口播"]) {
    expect(String(result.prompt), literal).toContain(literal);
  }
  expect(Array.from(String(result.prompt)).length).toBeLessThanOrEqual(3000);
  expect(shot).toEqual(before);
});

it("keeps undeclared-role and no-person prohibitions when an empty shot needs the third host pass", () => {
  const policy = { ...registeredOptions, noCharacters: true, characterNames: [], characterPortraits: [] };
  const shot = atSecondCompactLength(3001, policy);
  const before = structuredClone(shot);
  const result = applyNarrativeFinalPromptContract(shot, policy);
  for (const literal of ["未声明角色", "人物", "人影", "人体局部", "拟人化表演"]) {
    expect(String(result.prompt), literal).toContain(literal);
  }
  expect(Array.from(String(result.prompt)).length).toBeLessThanOrEqual(3000);
  expect(shot).toEqual(before);
});
