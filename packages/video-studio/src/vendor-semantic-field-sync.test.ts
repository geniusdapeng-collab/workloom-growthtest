import { createRequire } from "node:module";
import { resolve } from "node:path";
import { expect, it, vi } from "vitest";
import { applyNarrativeFinalPromptContract, installVendorNarrativePromptReviewBridge,
  normalizeNarrativePromptsForReview, type NarrativePromptReviewPolicy } from "./vendor-compat.js";
import { createStudioCheckpointRunner, studioCheckpointHash,
  type StudioCheckpointRequest, type StudioEngineCheckpoint } from "./studio-checkpoints.js";
import { videoRuntimeRoot } from "./runtime-root.js";

type Row = Record<string, unknown>;
type Fields = Record<string, unknown>;
interface Audit { applied: boolean; actions: Row[]; fallbackReason: string | null; fieldSync: Row }
const require = createRequire(import.meta.url);
const vendor = resolve(videoRuntimeRoot(import.meta.url), "vendor/supermickey/hyperreality-system");
const { PromptFusionAgent } = require(resolve(vendor, "engines/production-engine/agents/prompt-fusion-agent.js"));
const { PromptDeliveryGuard } = require(resolve(vendor, "engines/production-engine/agents/prompt-delivery-guard.js"));
const { HyperrealitySystem } = require(resolve(vendor, "index.js"));
const guard = new PromptDeliveryGuard();
const pairs = [
  ["导演意图", "director_instruction"], ["基础", "baseline"], ["约束", "constraint"], ["场景", "scene"],
  ["灯光设计", "lighting"], ["明亮约束", "bright_constraint"], ["构图", "composition"], ["色彩/色调", "color_palette"],
  ["景深", "depth_of_field"], ["运镜", "camera_movement"], ["角色", "character"], ["服装", "costume"],
  ["化妆", "makeup"], ["动作", "action"], ["道具", "props"], ["定妆照", "portraits"], ["时间轴", "timeline"],
  ["情绪", "mood"], ["节奏", "pacing"], ["转场", "transition"], ["音频", "audio"], ["负面约束", "negative"],
  ["角色约束", "character_constraint"], ["角色一致性", "consistency"],
] as const;
const openingPairs = [["主标题内容", "title_content"], ["副标题内容", "subtitle_content"],
  ["标题动画设计", "title_animation"], ["标题字体设计", "title_font_design"], ["开场音频设计", "opening_audio_design"]] as const;
const protectedLabels = new Set(["基础", "约束", "明亮约束", "负面约束"]);
const oldCharacter = "演员甲仅双手入画，脸部不在画面中（着装与服装字段一致）。";
const newCharacter = "演员甲仅双手入画，服装依已登记灰色工作外套。";

// Synthetic in-memory author data. The real native finalizer, semantic pass,
// delivery guard and downstream projections run; only the LLM transport is replaced.
function fixture(numbered = true, opening = false) {
  const fields: Fields = {
    director_instruction: "写实记录器物落到木桌的连续受力，不附加画面外的角色动作。",
    baseline: "写实材质与自然纹理。", constraint: "9:16画幅，1080x1920分辨率，24fps，MP4格式。",
    scene: "摄影工位内，木桌保留清晰纹理，器物置于中央，灰墙、窗户与桌面边缘的空间关系固定。".repeat(25),
    lighting: "原灯光由左窗5600K柔光形成，光源位置和方向全程固定，衣料与器物均有细微层次。",
    bright_constraint: "手部与器物轮廓清晰，暗部保留材质。", composition: "固定中景，双手与器物完整入画，木桌边缘位于画面下部。",
    color_palette: "灰墙与原木色保持中性，器物本色不变。", depth_of_field: "f/5.6，焦点锁定器物。",
    camera_movement: "原机位沿木桌平行横移，起幅落幅始终保留器物与双手。", character: oldCharacter,
    costume: "灰色工作外套，衣袖纹理保持一致。", makeup: "脸部不入画，不新增面部细节。",
    action: "演员甲双手托住器物，把底部平稳放到工作台后依次松开指尖；手腕保持同一平面。",
    props: "一件器物与木桌，数量与相对位置固定。", portraits: "演员甲已有的授权身份资料。",
    dialogue: "", timeline: "T00:00—T00:02托稳器物；T00:02—T00:04器物落桌；T00:04—T00:06指尖依次松开。",
    mood: "紧张而专注，指尖绷紧后随呼吸放松。", pacing: "先托住再落稳，随后松手，动作连续。",
    transition: "本镜动作结束后硬切，保持屏幕方向一致。", audio: "器物触桌轻响与衣料摩擦声，音量随接触自然变化。",
    negative: "禁止水印、虚构人物与物件。", character_constraint: "只出现已登记演员甲的双手。",
    consistency: "器物材质、外套与光源方向跨帧一致。",
    ...(opening ? { title_content: "器物的光", subtitle_content: "一次安静的放置", title_animation: "主标题从静止透明渐显，随后保持原位。",
      title_font_design: "灰白无衬线字体，标题位置与字重全程固定。", opening_audio_design: "起幅保留器物接触木桌的自然轻响。" } : {}),
  };
  const sections: Array<[string, string]> = [["语言约束", "全部字段使用中文。"],
    ...pairs.map(([label, key]): [string, string] => [label, String(fields[key])]),
    ...(opening ? openingPairs.map(([label, key]): [string, string] => [label, String(fields[key])]) : [])];
  const format = (rows: Array<[string, string]>) => rows.map(([label, value], index) =>
    `${numbered ? `${String(index + 1).padStart(2, "0")}.` : ""}【${label}】${value}`).join(numbered ? "\n" : " | ");
  const source: Row = { shotId: opening ? "SC00" : "S1", sceneType: opening ? "opening" : "action", duration: 6,
    character: "演员甲", characters: ["演员甲"], dialogue: "", dialogueText: "", dialogueBlocks: [],
    _blueprint: { title: "器物放置的合成测试", _originalStoryText: "双手把器物放上木桌。" } };
  const result: Row = { ...source, ...fields, fields, fusionText: fields.scene, prompt: format(sections),
    cameraString: fields.camera_movement, cameraMovement: fields.camera_movement,
    lightingString: fields.lighting, backgroundSoundString: fields.audio,
    degraded: false, degradeReason: null };
  result.promptCharCount = Array.from(String(result.prompt)).length;
  const replace = (updates: Record<string, string>) => format(sections.map(([label, value]) => [label, updates[label] ?? value]));
  return { fields, sections, format, source, result, replace };
}

async function finalize(f: ReturnType<typeof fixture>, refined: string, actions: Row[] = []) {
  expect(guard.verify(String(f.result.prompt), f.source)).toMatchObject({ pass: true, issues: [] });
  const agent = new PromptFusionAgent();
  const transport = vi.fn(async () => ({ result: { prompt: refined, actions } }));
  agent._callLLM = transport;
  const output = await agent._finalizeShotResult(f.source, f.result);
  expect(transport).toHaveBeenCalledOnce();
  expect(agent._llmEngineLoaded).toBe(false);
  return output as Row;
}

function semantic(row: Row): Audit { return row.semanticRefinement as Audit; }

it.each([true, false])("keeps the real semantic author's changed fields, top-level values and existing aliases coherent (numbered=%s)", async numbered => {
  const f = fixture(numbered); const beforeSource = structuredClone(f.source); const beforeFields = structuredClone(f.fields);
  const updates = { 角色: newCharacter, 运镜: "固定机位，器物与双手完整入画。", 灯光设计: "左窗5600K柔光，光源固定。",
    动作: "双手把器物平稳放上木桌，再依次松开指尖。", 情绪: "专注，指尖稳住器物后放松。", 音频: "器物触桌轻响与衣料摩擦。" };
  const refined = f.replace(updates);
  expect(guard.verify(refined, f.source).pass).toBe(true);
  const output = await finalize(f, refined, [{ type: "矛盾仲裁", field: "角色", description: "保留仅双手入画的本镜合同。" }]);
  expect(semantic(output).applied).toBe(true);
  for (const [label, key] of pairs.filter(([label]) => Object.hasOwn(updates, label))) {
    expect((output.fields as Fields)[key]).toBe(updates[label as keyof typeof updates]);
    expect(output[key]).toBe(updates[label as keyof typeof updates]);
  }
  expect(output.cameraString).toBe(updates.运镜); expect(output.cameraMovement).toBe(updates.运镜);
  expect(output.lightingString).toBe(updates.灯光设计); expect(output.backgroundSoundString).toBe(updates.音频);
  expect(output.prompt).toBe(refined); expect(output.promptCharCount).toBe(Array.from(refined).length);
  expect(output.fields).not.toBe(f.fields); expect(f.fields).toEqual(beforeFields); expect(f.source).toEqual(beforeSource);
  expect(semantic(output).fieldSync).toMatchObject({ schemaVersion: "workloom.semantic-field-sync/v1", status: "applied",
    original: { prompt: f.format(f.sections), fields: beforeFields }, refined: { prompt: refined, fields: output.fields } });
  expect((semantic(output).fieldSync.changes as Row[]).map(row => row.field)).toEqual(expect.arrayContaining([
    "character", "camera_movement", "lighting", "action", "mood", "audio",
  ]));
});

it.each(pairs.filter(([label]) => !protectedLabels.has(label)))("synchronizes the actual native %s mapping to %s", async (label, key) => {
  const f = fixture();
  const value = key === "scene" ? String(f.fields.scene).slice(0, -30) : key === "mood" ? "专注，指尖稳住器物。" : `精炼后${f.fields[key]}`;
  const output = await finalize(f, f.replace({ [label]: value }));
  expect(semantic(output).applied).toBe(true); expect((output.fields as Fields)[key]).toBe(value); expect(output[key]).toBe(value);
  if (key === "scene") expect(output.fusionText).toBe(value);
});

it.each(openingPairs)("synchronizes the native opening %s mapping to %s", async (label, key) => {
  const f = fixture(true, true); const value = `精炼后${f.fields[key]}`;
  const output = await finalize(f, f.replace({ [label]: value }));
  expect(semantic(output).applied).toBe(true); expect((output.fields as Fields)[key]).toBe(value); expect(output[key]).toBe(value);
});

it("preserves full untouched author fields, structured metadata and the original source when the displayed scene was already shortened", async () => {
  const f = fixture(); const completeScene = `${f.fields.scene}正文之外的完整作者细节𠮷。`;
  f.fields.scene = completeScene; f.result.scene = completeScene; f.result.fusionText = completeScene;
  const timeline = { beats: [{ time: 0, label: "托稳" }], totalDuration: 6 }; f.fields.timeline = timeline; f.result.timeline = timeline;
  const camera = { movement: "原结构化摄影计划", lens: { focalLength: 50 } }; f.result.camera = camera;
  const lighting = { key: { temperature: 5600, position: "左窗" } }; f.result.lighting = lighting;
  const backgroundSound = { ambience: ["衣料摩擦"], noSpeech: true }; f.result.backgroundSound = backgroundSound;
  const output = await finalize(f, f.replace({ 角色: newCharacter, 运镜: "固定机位。", 灯光设计: "左窗柔光保持固定。", 音频: "器物触桌轻响。" }));
  expect(semantic(output).applied).toBe(true); expect((output.fields as Fields).scene).toBe(completeScene);
  expect(output.scene).toBe(completeScene); expect(output.fusionText).toBe(completeScene);
  expect((output.fields as Fields).timeline).toBe(timeline); expect(output.timeline).toBe(timeline);
  expect(output.camera).toBe(camera); expect(output.lighting).toBe(lighting); expect(output.backgroundSound).toBe(backgroundSound);
  expect(output.cameraString).toBe("固定机位。"); expect(output.lightingString).toBe("左窗柔光保持固定。");
  expect(output.backgroundSoundString).toBe("器物触桌轻响。");
});

it("does not overwrite any field on a no-op reply or formatting-only rewrite", async () => {
  for (const formattingOnly of [false, true]) {
    const f = fixture(); const fields = f.fields; const fullScene = `${fields.scene}未显示的完整细节。`;
    fields.scene = fullScene; f.result.scene = fullScene;
    const refined = formattingOnly ? f.sections.map(([label, value]) => `【${label}】${value}`).join(" | ") : String(f.result.prompt);
    const output = await finalize(f, refined);
    expect(semantic(output).applied).toBe(true); expect(output.fields).toBe(fields); expect(fields.scene).toBe(fullScene);
    expect(semantic(output).fieldSync).toMatchObject({ status: "unchanged", changes: [] });
  }
});

const malformed: Array<{ name: string; change(f: ReturnType<typeof fixture>): string }> = [
  { name: "duplicate label", change: f => f.replace({ 角色: newCharacter }) + "\n26.【运镜】固定机位。" },
  { name: "unknown appended label", change: f => f.replace({ 角色: newCharacter }) + "\n26.【未登记字段】不可接收。" },
  { name: "prototype property label", change: f => f.replace({ 角色: newCharacter }) + "\n26.【constructor】不可接收。" },
  { name: "reordered labels", change: f => f.format([f.sections[0]!, f.sections[2]!, f.sections[1]!, ...f.sections.slice(3)]) },
  { name: "empty field body", change: f => f.replace({ 角色: newCharacter, 服装: "" }) },
  { name: "unseparated label", change: f => f.replace({ 角色: newCharacter }).replace("\n11.【运镜】", "【运镜】") },
  { name: "protected negative body", change: f => f.replace({ 角色: newCharacter, 负面约束: "禁止水印与变形。" }) },
  { name: "protected language body", change: f => f.replace({ 角色: newCharacter, 语言约束: "使用另一种语言。" }) },
  { name: "changed unmapped metadata", change: f => {
    f.sections.push(["音频纪律", "无对白、无旁白。"]); f.result.prompt = f.format(f.sections);
    return f.replace({ 角色: newCharacter, 音频纪律: "无对白、无旁白、无口播。" });
  } },
  { name: "removed metadata", change: f => {
    const refined = f.replace({ 角色: newCharacter }); f.sections.push(["音频纪律", "无对白、无旁白。"]);
    f.result.prompt = f.format(f.sections); return refined;
  } },
];

it.each(malformed)("rejects $name atomically even when the original delivery guard accepts it", async ({ change }) => {
  const f = fixture(); const refined = change(f); const original = structuredClone(f.result); const fields = f.fields;
  expect(guard.verify(refined, f.source)).toMatchObject({ pass: true, issues: [] });
  const output = await finalize(f, refined);
  expect(output.prompt).toBe(original.prompt); expect(output.fields).toBe(fields); expect(output.fields).toEqual(original.fields);
  for (const [, key] of pairs) expect(output[key]).toEqual(original[key]);
  expect(semantic(output)).toMatchObject({ applied: false, fieldSync: { status: "rejected" } });
  expect(semantic(output).fallbackReason).toMatch(/字段同步/u);
});

it("rejects a semantic timeline rewrite that cannot preserve its structured source, without accepting another valid change", async () => {
  const f = fixture(); const timeline = { totalDuration: 6, beats: [{ time: 0, label: "托稳" }] };
  f.fields.timeline = timeline; f.result.timeline = timeline;
  const originalPrompt = f.result.prompt;
  const output = await finalize(f, f.replace({ 角色: newCharacter, 时间轴: "T00:00—T00:06连续完成放置。" }));
  expect(output.prompt).toBe(originalPrompt); expect(output.character).toBe(oldCharacter);
  expect((output.fields as Fields).timeline).toBe(timeline); expect(semantic(output).applied).toBe(false);
});

it("preserves legitimate multiline field content and spoken vertical bars without treating them as delimiters", async () => {
  const f = fixture(false); const line = '[0s-6s] 演员甲 看向器物, 平静 说:"甲|乙。"';
  f.source.dialogueBlocks = [{ speaker: "演员甲", line: "甲|乙。" }];
  f.fields.dialogue = line; f.result.dialogue = line; f.sections.splice(17, 0, ["台词", line]);
  f.sections.find(([label]) => label === "时间轴")![1] += "\n后续拍点保留原木桌关系。";
  f.result.prompt = f.format(f.sections);
  const output = await finalize(f, f.replace({ 角色: newCharacter }));
  expect(semantic(output).applied).toBe(true); expect((output.fields as Fields).dialogue).toBe(line);
  expect(output.prompt).toContain('说:"甲|乙。"'); expect(output.prompt).toContain("\n后续拍点保留原木桌关系。");
});

it("keeps genuine guard rejection and transport failure on the original prompt and structured values", async () => {
  const f = fixture(); const original = structuredClone(f.result);
  const output = await finalize(f, "【角色】不完整的短回复。");
  expect(output.prompt).toBe(original.prompt); expect(output.fields).toEqual(original.fields); expect(semantic(output).applied).toBe(false);
  expect(semantic(output).fallbackReason).toMatch(/守卫拦截/u);
  const failing = fixture(); const before = structuredClone(failing.result); const agent = new PromptFusionAgent();
  agent._callLLM = vi.fn(async () => { throw new Error("synthetic transport unavailable"); });
  const failed = await agent._finalizeShotResult(failing.source, failing.result);
  expect(failed.prompt).toBe(before.prompt); expect(failed.fields).toEqual(before.fields);
  expect(semantic(failed)).toMatchObject({ applied: false, fallbackReason: "LLM调用异常:synthetic transport unavailable" });
});

it("isolates simultaneous native semantic replies without mutating either source or sharing field patches", async () => {
  const first = fixture(); const second = fixture(); second.source.shotId = "S2"; second.result.shotId = "S2";
  const [one, two] = await Promise.all([finalize(first, first.replace({ 角色: newCharacter })),
    finalize(second, second.replace({ 运镜: "固定机位，只观察第二件器物。" }))]);
  expect((one.fields as Fields).character).toBe(newCharacter); expect((two.fields as Fields).character).toBe(oldCharacter);
  expect((one.fields as Fields).camera_movement).toBe(first.fields.camera_movement);
  expect((two.fields as Fields).camera_movement).toBe("固定机位，只观察第二件器物。");
  expect(first.source.character).toBe("演员甲"); expect(second.source.character).toBe("演员甲");
});

it.each(["readonly", "setter"])("never partially mutates the original result when a later canonical property is %s", async mode => {
  const f = fixture(); const before = structuredClone(f.result); const setter = vi.fn(() => { throw new Error("synthetic setter rejects writes"); });
  Object.defineProperty(f.result, "action", mode === "readonly"
    ? { value: f.result.action, enumerable: true, writable: false, configurable: false }
    : { get: () => before.action, set: setter, enumerable: true, configurable: false });
  const updates = { 运镜: "固定机位。", 动作: "双手将器物放稳后依次松开指尖。" };
  const output = await finalize(f, f.replace(updates));
  expect(semantic(output).applied).toBe(true); expect(output).not.toBe(f.result);
  expect(output.camera_movement).toBe(updates.运镜); expect(output.action).toBe(updates.动作);
  expect((output.fields as Fields).camera_movement).toBe(updates.运镜); expect((output.fields as Fields).action).toBe(updates.动作);
  expect(f.result).toEqual(before); expect(f.fields).toEqual(before.fields); expect(setter).not.toHaveBeenCalled();
});

it("retains native semantic edits through marketing canonicalization, final review reprojection and the real G6 report", async () => {
  const f = fixture(); const updates = { 运镜: "固定机位，器物与双手完整入画。", 灯光设计: "左窗5600K柔光保持固定。",
    动作: "双手把器物平稳放上木桌，再依次松开指尖。", 情绪: "专注，指尖稳住器物后放松。" };
  const output = await finalize(f, f.replace(updates));
  const policy: NarrativePromptReviewPolicy = { noDialogue: true, maxLength: 3000, noCharacters: false, noAnimals: true,
    noMusic: true, noTitles: true, durationSeconds: 6, aspectRatio: "9:16", resolution: "1080x1920", characterNames: ["演员甲"],
    characterPortraits: [], projectProps: [], projectActions: [], marketingPrompt: { actions: [], overlay: [], endCard: [] } };
  const canonical = applyNarrativeFinalPromptContract(output, { ...policy, canonicalize: true });
  const reviewed = normalizeNarrativePromptsForReview([canonical], policy)[0]!;
  const uninstall = installVendorNarrativePromptReviewBridge();
  try {
    const system = Object.create(HyperrealitySystem.prototype);
    const report = system._generatePromptsReport([reviewed]) as string;
    for (const [label, value] of Object.entries(updates)) {
      expect(String(canonical.prompt)).toContain(`【${label}】${value}`);
      expect(String(reviewed.prompt)).toContain(`【${label}】${value}`); expect(report).toContain(`【${label}】${value}`);
    }
    expect(semantic(reviewed).fieldSync).toMatchObject({ status: "applied" });
    expect(report).toContain("结构化镜头合同"); expect(report).not.toContain("原机位沿木桌平行横移");
  } finally { uninstall(); }
});

it("invalidates the old v14 production and title descendant while preserving every upstream checkpoint and prior bytes", async () => {
  const seed = { unchanged: true }; const input = { source: "unchanged", feedback: "same-private-feedback" };
  const prior = [["G2_THEME", "theme-input-and-brief/v1"], ["G3_INSIGHT", "source-bound-discovery-and-assumptions/v2"],
    ["G3_PROFILE", "native-source-aware-production-profile/v2"], ["G4_PRD", "source-bound-prd-native-local-contract/v3"],
    ["SCRIPT", "native-script-and-metadata/v1"], ["PRODUCTION", "native-production-camera-repair-feedback/v14"],
    ["OPENING_TITLE", "native-opening-title-fields/v2"]] as const;
  const records = new Map<string, StudioEngineCheckpoint>();
  const key = (value: StudioCheckpointRequest) => `${value.stage}/${value.inputSha256}/${value.dependencySha256}`;
  let dependencySha256 = studioCheckpointHash(seed);
  for (const [stage, policyVersion] of prior) {
    const output = { stage, original: true }; const outputSha256 = studioCheckpointHash(output);
    const inputSha256 = studioCheckpointHash({ policyVersion, input });
    const record: StudioEngineCheckpoint = { schemaVersion: "workloom.studio-engine-checkpoint/v1", stage,
      inputSha256, dependencySha256, output, outputSha256 };
    records.set(key(record), record);
    dependencySha256 = studioCheckpointHash({ previous: dependencySha256, stage, inputSha256, outputSha256 });
  }
  const before = JSON.stringify([...records]); const authored: string[] = [];
  const runner = createStudioCheckpointRunner({ load: async request => records.get(key(request)) ?? null, save: async () => undefined }, seed);
  for (const [stage] of prior) {
    const output = await runner.run(stage, input, async () => { authored.push(stage); return { stage, revised: true }; });
    expect(output).toEqual(stage === "PRODUCTION" || stage === "OPENING_TITLE" ? { stage, revised: true } : { stage, original: true });
  }
  expect(authored).toEqual(["PRODUCTION", "OPENING_TITLE"]); expect(JSON.stringify([...records])).toBe(before);
});
