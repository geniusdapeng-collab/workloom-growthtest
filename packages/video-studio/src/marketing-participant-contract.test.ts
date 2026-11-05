import { expect, it } from "vitest";
import { applyNarrativeFinalPromptContract } from "./vendor-compat.js";

type Row = Record<string, unknown>;
const participants = "主角甲与源剧本声明的服务员乙同框；乙在柜台内接过器物$&𠮷，甲的登记身份保持不变。";
const profile = { name: "主角甲", path: "image://characters/lead/front.png", appearance: "短发、灰色外套。" };
const options = { noDialogue: true, noMusic: true, noCharacters: false, noAnimals: true,
  maxLength: 3000, canonicalize: true, characterNames: ["主角甲"], characterPortraits: [profile],
  marketingPrompt: { actions: ["甲将器物交给源剧本声明的服务员乙"], overlay: [], endCard: [] } };
const field = (prompt: unknown, label: string) => String(prompt).match(new RegExp(`^\\d+\\.【${label}】([^\\n]*)$`, "mu"))?.[1];
function shot(role = participants): Row {
  const fields = { scene: "柜台前，甲与服务员各站一侧。", action: "甲双手递出器物，服务员乙接稳后放到柜台上。",
    character: role, costume: "甲穿灰色外套，乙穿源剧本声明的工作围裙。", makeup: "自然肤色。",
    props: "一件器物、一张柜台。", timeline: "T00:00-T00:02递出；T00:02-T00:04接稳放下。",
    composition: "中景，双方双手和器物完整入画。", lighting: "左侧窗户自然柔光。", color_palette: "中性灰。",
    transition: "器物放稳后硬切。", mood: "甲看向器物，乙确认接稳后点头。", camera_movement: "固定机位。",
    pacing: "递出、接稳、放下依次完成。", depth_of_field: "双方双手与器物同时清晰。", audio: "器物接触柜台的轻响。" };
  return { shotId: "handover", sceneType: "action", duration: 4, ...fields, fields,
    prompt: "01.【基础】电影级写实材质。" };
}

it("retains the complete native participant contract while binding registered identity without excluding declared supporting roles", () => {
  const source = shot(); const before = structuredClone(source);
  const output = applyNarrativeFinalPromptContract(source, options);
  expect(field(output.prompt, "角色")).toContain(participants);
  expect(field(output.prompt, "角色")).toContain("主角甲");
  expect(field(output.prompt, "定妆照")).toContain(profile.path);
  expect(field(output.prompt, "角色约束")).toContain("源剧本");
  expect(field(output.prompt, "角色约束")).toContain("不得增加未声明人物");
  expect(field(output.prompt, "角色约束")).not.toContain("仅允许 主角甲 入画");
  expect(field(output.prompt, "角色一致性")).toContain("主角甲");
  expect(field(output.prompt, "角色一致性")).toContain("其他已声明参与者");
  expect(field(output.prompt, "动作")).toBe((source.fields as Row).action);
  expect(field(output.prompt, "时间轴")).toBe((source.fields as Row).timeline);
  const contract = output._workloomShotContract as Row;
  expect(contract.subjectCount).toBeNull();
  expect(contract.registeredSubjectCount).toBe(1);
  expect(contract.participants).toBe(participants);
  expect(contract.characterNames).toEqual(["主角甲"]);
  expect(source).toEqual(before);
  expect(applyNarrativeFinalPromptContract(output, options).prompt).toBe(output.prompt);
});

it("keeps the whole native role body during real host compaction and refuses oversized native role text", () => {
  const source = shot();
  const policy = { ...options, characterPortraits: [{ ...profile, appearance: profile.appearance.repeat(260) }] };
  const detailed = applyNarrativeFinalPromptContract(source, { ...policy, maxLength: 10000 });
  expect(Array.from(String(detailed.prompt)).length).toBeGreaterThan(3000);
  const compact = applyNarrativeFinalPromptContract(source, policy);
  expect(Array.from(String(compact.prompt)).length).toBeLessThanOrEqual(3000);
  expect(field(compact.prompt, "角色")).toContain(participants);
  expect(field(compact.prompt, "定妆照")).toContain(profile.path);
  const templates = ((compact._workloomShotContract as Row).hostTemplates as Row);
  expect(templates["角色"]).toContain(participants);
  expect(templates["角色"]).toContain(profile.appearance);
  const tooLong = shot("源剧本声明的参与者".repeat(550)); const before = structuredClone(tooLong);
  expect(() => applyNarrativeFinalPromptContract(tooLong, options)).toThrow("FINAL_PROMPT_SOURCE_CAPACITY_EXCEEDED");
  expect(tooLong).toEqual(before);
});

it("keeps the explicit no-person boundary and does not change the narrative-only identity rule", () => {
  const withoutPeople = applyNarrativeFinalPromptContract(shot(), { ...options, noCharacters: true });
  expect(field(withoutPeople.prompt, "角色")).not.toContain("服务员乙");
  expect(field(withoutPeople.prompt, "角色约束")).toContain("禁止人物");
  expect((withoutPeople._workloomShotContract as Row).subjectCount).toBe(0);
  const narrative = applyNarrativeFinalPromptContract(shot(), { ...options, marketingPrompt: undefined });
  expect(field(narrative.prompt, "角色约束")).toContain("仅允许 主角甲 入画");
  expect(field(narrative.prompt, "角色")).not.toContain("服务员乙");
});

it("retains the registered identity fallback when no native participant field was authored", () => {
  const source = shot("");
  const output = applyNarrativeFinalPromptContract(source, options);
  expect(field(output.prompt, "角色")).toContain("主角甲");
  expect(field(output.prompt, "角色")).not.toContain("服务员乙");
  expect((output._workloomShotContract as Row).subjectCount).toBeNull();
  expect((output._workloomShotContract as Row).registeredSubjectCount).toBe(1);
  expect((output._workloomShotContract as Row).characterNames).toEqual(["主角甲"]);
});


it.each([[], ["主角甲"]])("does not invent a registered identity anchor from an empty portrait registry, names=%j", (...names) => {
  const role = "主角甲与源剧本声明的服务员乙同框，双手在柜台上完成器物交接。";
  const source = shot(role);
  source.prompt += "\n17.【定妆照】使用未经登记的参考图";
  const output = applyNarrativeFinalPromptContract(source, { ...options,
    characterNames: names.flat() as string[], characterPortraits: [] });
  expect(field(output.prompt, "角色")).toContain(role);
  for (const label of ["角色", "角色约束", "角色一致性"]) {
    expect(field(output.prompt, label)).not.toMatch(/已登记|登记身份|授权/u);
  }
  expect(field(output.prompt, "角色约束")).toContain("不得增加未声明人物");
  expect(field(output.prompt, "定妆照")).toContain("当前未登记人像素材");
  expect(field(output.prompt, "定妆照")).not.toContain("使用未经登记的参考图");
  expect((output._workloomShotContract as Row).registeredSubjectCount).toBe(0);
  expect((output._workloomShotContract as Row).subjectCount).toBeNull();
});
