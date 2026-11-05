import { expect, it } from "vitest";
import { applyNarrativeFinalPromptContract, normalizeNarrativePromptsForReview,
  type NarrativePromptReviewPolicy } from "./vendor-compat.js";
import { createStudioCheckpointRunner, studioCheckpointHash,
  type StudioCheckpointRequest, type StudioEngineCheckpoint } from "./studio-checkpoints.js";

type Row = Record<string, any>;
type Options = Parameters<typeof applyNarrativeFinalPromptContract>[1];
const policy: NarrativePromptReviewPolicy = { noDialogue: true, noMusic: false, noCharacters: false,
  noAnimals: true, noTitles: true, maxLength: 3000, durationSeconds: 4, aspectRatio: "9:16",
  resolution: "1080x1920", characterNames: ["演员甲"], characterPortraits: [], projectProps: [],
  projectActions: [], marketingPrompt: { actions: [], overlay: [], endCard: [] } };
const options: Options = { ...policy, canonicalize: true, chineseOnly: true };

function nativeShot(): Row {
  const fields = {
    // Actual28's contradictory technical values, in a portable creative fixture.
    constraint: "9:16画幅，4K分辨率，24fps，MP4格式",
    baseline: "8K超采样后的电影级写实质感，真实胶片颗粒。",
    scene: "封闭训练场的直道末端，护墙与远处看台在同一空间。",
    action: "演员甲压低上身握稳车把，车轮沿白线连续前行后停稳。",
    costume: "同一套深灰防护服与手套。", makeup: "自然肤色，不改变妆造。",
    props: "样车、热熔胎、头盔与路面白线。",
    timeline: "T00:00-T00:02连续前行；T00:02-T00:04停稳后落幅。",
    composition: "中景，演员甲与前轮在画面右侧，护墙留在左侧。",
    lighting: "右后方自然硬光5600K，暗部保留纹理。",
    color_palette: "中性灰与低饱和暖金，保持原场景层次。",
    transition: "本镜静止落幅，下一镜按原边界衔接。", mood: "专注地控制前轮落点。",
    camera_movement: "沿原轴线缓慢跟拍，减速后保持静止。", pacing: "连续前行后停稳。",
    depth_of_field: "演员甲与前轮清晰，远处看台保持原有层次。",
    audio: "热熔胎滚过路面的沙沙声；远处看台欢呼与演员甲呼吸持续",
    character: "演员甲位于车把后方，同一服装与身体位置。", dialogue: "",
    portraits: "本片没有登记图片参考。", negative: "禁止额外人物和未声明道具。",
    bright_constraint: "主体高光不过曝，暗部保留材质。",
    character_constraint: "演员甲与源场景已声明参与者保持原样。",
    consistency: "同一演员甲、样车与热熔胎；不增加未经核实的商品参数。",
    director_instruction: "沿本镜原生动作和空间执行，声音保留原生声。",
  };
  return { shotId: "SC-1", sceneType: "content", duration: 4, ...fields, fields: { ...fields },
    prompt: `01.【基础】${fields.baseline}\n02.【约束】16:9画幅，8K分辨率，24fps，MP4格式。` };
}

function promptValue(row: Row, label: string): string {
  return String(row.prompt).split("\n").find(line => line.includes(`.【${label}】`))
    ?.split(`【${label}】`)[1] ?? "";
}

function expectTechnicalAgreement(row: Row, expectedConstraint: string): void {
  expect(promptValue(row, "约束")).toBe(expectedConstraint);
  expect(row.constraint).toBe(expectedConstraint);
  expect(row.fields.constraint).toBe(expectedConstraint);
  expect(row.baseline).toBe(promptValue(row, "基础"));
  expect(row.fields.baseline).toBe(promptValue(row, "基础"));
  expect(row.fields.baseline).not.toMatch(/\b(?:4K|8K)\b/iu);
}

it("aligns the final 1080 contract and qualitative baseline without hiding unsupported props, native actions or crowd audio", () => {
  const source = nativeShot(); const before = structuredClone(source);
  const output = applyNarrativeFinalPromptContract(source, options) as Row;
  expectTechnicalAgreement(output, "9:16画幅，1080x1920，4秒，24fps，MP4格式。");
  expect(output.baseline).toBe("电影级超采样后的电影级写实质感，真实胶片颗粒。");
  const unchanged = Object.keys(source.fields).filter(key => key !== "constraint" && key !== "baseline");
  for (const key of unchanged) {
    expect(output.fields[key]).toEqual(source.fields[key]);
    expect(output[key]).toEqual(source[key]);
  }
  expect(Object.keys(output.fields)).toEqual(Object.keys(source.fields));
  for (const value of [source.action, source.props, source.audio, "热熔胎", "看台欢呼", "呼吸"]) {
    expect(output.prompt).toContain(value);
  }
  expect(applyNarrativeFinalPromptContract(output, options)).toEqual(output);
  expect(source).toEqual(before);
  expect(output.fields).not.toBe(source.fields);
});

it.each([
  { aspectRatio: "16:9", resolution: "1920x1080", expected: "16:9画幅，1920x1080，4秒，24fps，MP4格式。" },
  { aspectRatio: "1:1", resolution: "1536x1536", deliveryConstraint: "1:1画幅，1536x1536，30fps，MOV格式；",
    expected: "1:1画幅，1536x1536，30fps，MOV格式。" },
])("uses the same final technical values for an explicit delivery contract $expected", delivery => {
  const source = nativeShot(); const before = structuredClone(source);
  const output = applyNarrativeFinalPromptContract(source, { ...options, ...delivery }) as Row;
  expectTechnicalAgreement(output, delivery.expected);
  expect(source).toEqual(before);
});

it.each(["top-only", "fields-only", "mixed"])("synchronizes both aliases when technical fields start as %s", mode => {
  const source = nativeShot();
  if (mode === "top-only") { delete source.fields.constraint; delete source.fields.baseline; }
  if (mode === "fields-only") { delete source.constraint; delete source.baseline; }
  if (mode === "mixed") { delete source.fields.constraint; delete source.baseline; }
  const before = structuredClone(source);
  const output = applyNarrativeFinalPromptContract(source, options) as Row;
  expectTechnicalAgreement(output, "9:16画幅，1080x1920，4秒，24fps，MP4格式。");
  expect(source).toEqual(before);
});

it("retains the creative-only shape when neither alias supplies a technical field", () => {
  const source = nativeShot();
  for (const key of ["constraint", "baseline"]) { delete source[key]; delete source.fields[key]; }
  const before = structuredClone(source);
  const output = applyNarrativeFinalPromptContract(source, options) as Row;
  expect(promptValue(output, "约束")).toBe("9:16画幅，1080x1920，4秒，24fps，MP4格式。");
  for (const key of ["constraint", "baseline"]) {
    expect(output).not.toHaveProperty(key);
    expect(output.fields).not.toHaveProperty(key);
  }
  expect(output.fields).toEqual(source.fields);
  expect(source).toEqual(before);
});

it.each([false, undefined])("keeps raw technical aliases and fields unchanged with canonicalize=%s", canonicalize => {
  const source = nativeShot(); const before = structuredClone(source);
  const output = applyNarrativeFinalPromptContract(source, { ...options, canonicalize }) as Row;
  for (const key of ["constraint", "baseline"]) {
    expect(output[key]).toBe(source[key]);
    expect(output.fields[key]).toBe(source.fields[key]);
  }
  // Raw mode already projects the prompt constraint; do not redefine that behavior.
  expect(promptValue(output, "约束")).toBe("9:16画幅，1080x1920，4秒，24fps，MP4格式。");
  expect(source).toEqual(before);
});

it("keeps the technical agreement through the real final-review projection used for FACT", () => {
  const source = nativeShot(); const before = structuredClone(source);
  const reviewed = normalizeNarrativePromptsForReview([source], policy)[0]! as Row;
  expectTechnicalAgreement(reviewed, "9:16画幅，1080x1920，4秒，24fps，MP4格式。");
  for (const key of ["action", "scene", "props", "audio", "consistency"]) {
    expect(reviewed.fields[key]).toBe(source.fields[key]);
  }
  expect(reviewed.prompt).toContain("热熔胎");
  expect(reviewed.prompt).toContain("看台欢呼");
  expect(reviewed.fields._workloomShotContract).toEqual(reviewed._workloomShotContract);
  expect(source).toEqual(before);
});

it("rejects the previous production projection cache while retaining every upstream station", async () => {
  const seed = "same frozen request"; const input = { source: "unchanged" };
  const prior = [["G2_THEME", "theme-input-and-brief/v1"], ["G3_INSIGHT", "source-bound-discovery-and-assumptions/v2"],
    ["G3_PROFILE", "native-source-aware-production-profile/v2"], ["G4_PRD", "source-bound-prd-native-local-contract/v3"],
    ["SCRIPT", "native-script-and-metadata/v1"], ["PRODUCTION", "native-production-camera-repair-feedback/v12"],
    ["OPENING_TITLE", "native-opening-title-fields/v2"]] as const;
  const records = new Map<string, StudioEngineCheckpoint>();
  const key = (value: StudioCheckpointRequest) => `${value.stage}/${value.inputSha256}/${value.dependencySha256}`;
  let dependencySha256 = studioCheckpointHash(seed);
  for (const [stage, policyVersion] of prior) {
    const output = { stage, retained: true }; const outputSha256 = studioCheckpointHash(output);
    const inputSha256 = studioCheckpointHash({ policyVersion, input });
    const record: StudioEngineCheckpoint = { schemaVersion: "workloom.studio-engine-checkpoint/v1", stage,
      inputSha256, dependencySha256, output, outputSha256 };
    records.set(key(record), record);
    dependencySha256 = studioCheckpointHash({ previous: dependencySha256, stage, inputSha256, outputSha256 });
  }
  const runner = createStudioCheckpointRunner({ load: async request => records.get(key(request)) ?? null,
    save: async record => { records.set(key(record), record); } }, seed);
  const authored: string[] = [];
  for (const [stage] of prior) {
    const output = await runner.run(stage, input, async () => { authored.push(stage); return { stage, rewritten: true }; });
    expect(output).toEqual(stage === "PRODUCTION" || stage === "OPENING_TITLE"
      ? { stage, rewritten: true } : { stage, retained: true });
  }
  expect(authored).toEqual(["PRODUCTION", "OPENING_TITLE"]);
});
