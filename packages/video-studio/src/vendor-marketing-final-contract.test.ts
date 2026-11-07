import { createRequire } from "node:module";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  applyNarrativeFinalPromptContract, installVendorPhase3FusionBridge,
  normalizeNarrativePromptsForReview, type NarrativePromptReviewPolicy,
} from "./vendor-compat.js";
import { videoRuntimeRoot } from "./runtime-root.js";

type Row = Record<string, unknown>;
type ContractOptions = Parameters<typeof applyNarrativeFinalPromptContract>[1];
type Portrait = NonNullable<ContractOptions["characterPortraits"]>[number];
const require = createRequire(import.meta.url);
const { Phase3PromptFusion } = require(resolve(videoRuntimeRoot(import.meta.url),
  "vendor/supermickey/hyperreality-system/engines/production-engine/phases/phase-3-prompt-fusion.js")) as {
  Phase3PromptFusion: new (options: Row) => { execute(state: Row): Promise<Row>; agents: { promptFusion: Row } };
};
const portraits: Portrait[] = [
  { name: "陈卓", path: "registered/chen-zhuo/front.webp", appearance: "陈卓登记外观锚点", authorization: "registered" },
  { name: "匿名对手车手", path: "", appearance: "GLOBAL_ANON_APPEARANCE", authorization: "not-registered" },
];

const nativeFields = (): Row => ({
  character: "陈卓独自跨坐赛车，保持当前登记的外观与服装。",
  character_constraint: "本镜仅陈卓入画；不出现其他车手或未声明人物。",
  action: "陈卓沿弯道保持低姿态，右手拧油后把赛车扶正。",
  scene: "封闭赛道的弯道出口，远处护栏与路肩位置连续。",
  costume: "陈卓穿同一套深色赛车服，护具完整。",
  makeup: "陈卓保持登记外观，无新增妆造。",
  props: "碳纤维全盔、赛车手套、赛车靴、同一辆赛车。",
  timeline: "0至2秒保持低姿态；2至5秒拧油扶正并稳定出弯。",
  composition: "中景竖屏构图，赛车与人物轮廓清晰。",
  lighting: "侧后方日光照亮轮廓，护栏投影方向不变。",
  color_palette: "深色赛车服与灰色赛道，日光色温一致。",
  transition: "落幅保持同向运动后硬切下一镜。",
  mood: "专注而紧张，以收紧的身体姿态表达。",
  camera_movement: "沿弯道外侧平稳跟随，保持拍摄轴线。",
  pacing: "动作连续推进，最后半秒稳定落幅。",
  depth_of_field: "人物与赛车清晰，远处护栏自然虚化。",
  audio: "引擎随拧油拔高，轮胎压过路肩产生连续摩擦声。",
});

const shot = (patch: Row = {}): Row => ({
  shotId: "SC-3", sceneType: "story", duration: 5,
  characters: ["chen-zhuo"],
  fields: { ...nativeFields(), ...patch },
  prompt: "01.【基础】保留本镜原生场景与动作。",
});

const project = (row: Row, compact = false, overrides: Partial<ContractOptions> = {}): Row => applyNarrativeFinalPromptContract(row, {
  noDialogue: true, noMusic: true, maxLength: 3000, canonicalize: true,
  noTitles: true, durationSeconds: 5, aspectRatio: "9:16", resolution: "1080x1920",
  characterNames: ["陈卓", "匿名对手车手"],
  characterPortraits: portraits,
  marketingPrompt: { actions: ["沿弯道拧油出弯"], overlay: [], endCard: [] },
  forceCompactMarketingHost: compact,
  ...overrides,
});

function phaseFixture(initial: Row[], catalog: Portrait[] = portraits) {
  const directory = mkdtempSync(resolve(tmpdir(), "wl-native-final-contract-"));
  const process = vi.fn(async (_shots: Row[]) => ({ shots: structuredClone(initial),
    checkpointBlueprintHash: "c".repeat(64), degraded: false, stats: { total: initial.length, failed: 0 } }));
  const repair = vi.fn(async (..._args: unknown[]) => { throw new Error("UNEXPECTED_OFFLINE_AUTHOR_REPAIR"); });
  const writer = vi.fn();
  const finalCheckpoint = vi.fn(async () => undefined);
  const agent = { process, _fuseSingleShot: repair, _saveSubCheckpoint: writer,
    _callLLM: vi.fn(async (_prompt: string) => ({ result: { picks: [] }, degraded: false })) };
  const phase = new Phase3PromptFusion({ agents: { promptFusion: agent }, checkpointManager: { baseDir: directory },
    logFn: () => undefined, cloneShots: structuredClone,
    mergeShots: (_base: Row[], updated: Row[]) => updated, saveCheckpoint: finalCheckpoint });
  const blueprint = {
    title: "离线原生字段最终合同", config: { aspect_ratio: "9:16", target_duration: initial.length * 5 },
    _workloomMarketingFieldWriterPolicy: "native-marketing-field-authority/v6",
    character_system: { characters: [] },
    meta: { _metadata: { dialogueRequirement: "无台词、无对白、无旁白、无口播；无配乐。",
      _prd: { _workloomMarketingPrompt: { actions: [], overlay: [], endCard: [] },
        productPositioning: { targetDuration: initial.length * 5, aspectRatio: "9:16", resolution: "1080x1920" },
        characterSystem: { characters: catalog.map(profile => ({ ...profile, portraitPath: profile.path })) } } } },
  };
  const source = structuredClone(initial);
  const state = { shots: source, adaptedBlueprint: blueprint, result: { stages: {}, llmStats: {} } };
  return { phase, agent, process, repair, writer, finalCheckpoint, blueprint, source, state,
    close: () => rmSync(directory, { recursive: true, force: true }) };
}

describe("marketing final contract preserves the current native shot", () => {
  it("does not append an offscreen project character's appearance to a single-person shot", () => {
    const source = shot();
    const output = project(source);
    expect(String(output.prompt)).not.toContain("GLOBAL_ANON_APPEARANCE");
    expect((output.fields as Row).character).toBe((source.fields as Row).character);
  });

  it("keeps compact contract rosters and retained host templates local to the current shot", () => {
    const output = project(shot(), true);
    const contract = output._workloomShotContract as Row;
    expect(contract.characterNames).toEqual(["陈卓"]);
    expect(JSON.stringify(contract.hostTemplates ?? {})).not.toContain("GLOBAL_ANON_APPEARANCE");
    expect(contract.registeredCharacterNames).toEqual(["陈卓"]);
  });

  it("retains fields-first native sounds after negative BPM and an explicit native-sound boundary", () => {
    const events = "仅保留现场原生声：护栏在风里轻微颤动，车身贴边超车那一瞬风压贴耳切过，热熔胎发出嘶啦声，引擎转速随她拧油拔高，卡扣合死一声咔哒";
    const source = shot({ audio: `人声对话清晰可辨，无配乐，BPM不适用，${events}；【音频纪律】后附模板不属于原生事件。` });
    source.audio = "STALE_TOP_AUDIO：背景音乐持续响起。";
    const output = project(source);
    const audio = String((output.fields as Row).audio);
    expect(audio).toContain(events);
    expect(audio).not.toContain("人声对话清晰可辨");
    expect(audio).not.toContain("STALE_TOP_AUDIO");
    expect(output.audio).toBe(audio);
    expect(String(output.prompt)).toContain(events);
  });

  it("keeps parenthesized prop descriptions intact in the machine contract", () => {
    const props = "碳纤维全盔（戴在头上、面罩闭合）、护颈、透明护目镜(无标识、无文字)、赛车服";
    const output = project(shot({ props }));
    const contract = output._workloomShotContract as Row;
    expect(contract.props).toEqual([
      "碳纤维全盔（戴在头上、面罩闭合）", "护颈", "透明护目镜(无标识、无文字)", "赛车服",
    ]);
    expect((output.fields as Row).props).toBe(props);
    expect(String(output.prompt)).toContain(props);
  });

  it.each([false, true])("retains an explicitly allowed anonymous participant without inventing its portrait, compact=%s", compact => {
    const source = shot({ character_constraint: "本镜仅允许陈卓与合同明确声明的匿名对手车手入画；匿名对手车手全盔遮面。" });
    const before = structuredClone(source);
    const contract = project(source, compact)._workloomShotContract as Row;
    expect(contract.characterNames).toEqual(["陈卓", "匿名对手车手"]);
    expect(contract.registeredCharacterNames).toEqual(["陈卓"]);
    expect((contract.portraitAssets as Row[]).map(asset => asset.name)).toEqual(["陈卓"]);
    expect(contract.subjectCount).toBeNull();
    expect(source).toEqual(before);
  });

  it("does not treat an exclusion or a prohibition on cloning as an offscreen participant declaration", () => {
    const source = shot({ character_constraint: "禁止匿名对手车手入画；禁止陈卓分身与重复出现。" });
    source.character = "STALE_TOP_CHARACTER：匿名对手车手。";
    const output = project(source);
    expect((output._workloomShotContract as Row).characterNames).toEqual(["陈卓"]);
    expect(String(output.prompt)).not.toContain("GLOBAL_ANON_APPEARANCE");
    expect(String(output.prompt)).not.toContain("STALE_TOP_CHARACTER");
  });

  it.each([
    "本镜仅允许非陈卓的工作人员乙入画；陈卓本人不得入画。",
    "本镜仅允许非陈卓的工作人员乙入画。",
    "本镜仅允许陈卓与工作人员乙入画；陈卓本人不得入画。",
  ].flatMap(character_constraint => [false, true].map(compact => ({ character_constraint, compact }))))(
    "respects explicit negative identities before an exclusive roster, compact=$compact: $character_constraint", ({ character_constraint, compact }) => {
    const fields = JSON.parse(JSON.stringify(nativeFields()).replaceAll("陈卓", "工作人员乙")) as Row;
    const source = shot({ ...fields, character_constraint, dialogue: "",
      audio: "引擎随拧油拔高，轮胎压过路肩产生连续摩擦声" });
    source.characters = ["工作人员乙"];
    const before = structuredClone(source);
    const output = project(source, compact, { characterNames: ["陈卓"], characterPortraits: [portraits[0]!] });
    const contract = output._workloomShotContract as Row;
    expect(contract.characterNames).toEqual([]);
    expect(contract.registeredCharacterNames).toEqual([]);
    expect(contract.portraitAssets).toEqual([]);
    expect(contract.registeredSubjectCount).toBe(0);
    expect(contract.participants).toBe((source.fields as Row).character);
    expect(output.fields).toEqual(source.fields);
    expect(String(output.prompt)).not.toContain("陈卓登记外观锚点");
    expect(String(output.prompt)).not.toContain("registered/chen-zhuo/front.webp");
    expect(source).toEqual(before);
  });

  it.each([false, true])("retains a positive exclusive identity when only its cloning is prohibited, compact=%s", compact => {
    const source = shot({ character_constraint: "本镜仅允许陈卓入画；禁止增加陈卓分身与重复出现。", dialogue: "",
      audio: "引擎随拧油拔高，轮胎压过路肩产生连续摩擦声" });
    const before = structuredClone(source);
    const output = project(source, compact);
    const contract = output._workloomShotContract as Row;
    expect(contract.characterNames).toEqual(["陈卓"]);
    expect(contract.registeredCharacterNames).toEqual(["陈卓"]);
    expect((contract.portraitAssets as Row[]).map(asset => asset.name)).toEqual(["陈卓"]);
    expect(output.fields).toEqual(source.fields);
    expect(source).toEqual(before);
  });

  it("preserves a participant explicitly present in the native scene even when registered IDs name only the lead", () => {
    const output = project(shot({ character_constraint: "参与者遵循本镜人物与场景合同。",
      scene: "陈卓与匿名对手车手在封闭赛道同框，前后位置遵循动作字段。" }));
    expect((output._workloomShotContract as Row).characterNames).toEqual(["陈卓", "匿名对手车手"]);
  });

  it("keeps unknown authored participants as source text without guessing an identity from the project catalog", () => {
    const output = project(shot({ character: "未登记引导员甲手持无字旗站在安全区。",
      character_constraint: "参与者按当前源字段执行，不新增人物。",
      scene: "安全区的地面标线与护栏保持不变。", action: "引导员甲挥动无字旗后停下。" }));
    const contract = output._workloomShotContract as Row;
    expect(contract.participants).toBe("未登记引导员甲手持无字旗站在安全区。");
    expect(contract.characterNames).toEqual([]);
    expect(contract.portraitAssets).toEqual([]);
    expect(String(output.prompt)).not.toContain("陈卓登记外观锚点");
    expect(String(output.prompt)).not.toContain("GLOBAL_ANON_APPEARANCE");
  });

  it("preserves the existing single registered identity fallback only when the native participant contract is absent", () => {
    const source = shot({ character: "", character_constraint: "", scene: "甲在柜台前递出器物。", action: "甲将器物放到柜台上。" });
    delete source.characters;
    const output = project(source, false, { characterNames: ["陈卓"], characterPortraits: [portraits[0]!] });
    const contract = output._workloomShotContract as Row;
    expect(contract.characterNames).toEqual(["陈卓"]);
    expect(contract.registeredCharacterNames).toEqual(["陈卓"]);
    expect(String(output.prompt)).toContain("陈卓登记外观锚点");
    expect(String(output.prompt)).not.toContain("GLOBAL_ANON_APPEARANCE");
  });

  it.each([
    { character_constraint: "禁止陈卓入画。" },
    { scene: "本镜仅服务员乙入画，人物站在柜台内。", action: "服务员乙把器物放稳。" },
    { scene: "服务员乙独自站在柜台内。", action: "服务员乙把器物放稳。" },
    { scene: "陈卓不出镜，台面保留器物。", action: "器物放稳。" },
  ])("does not override explicit local participation or exclusions with the single registered fallback: %j", patch => {
    const source = shot({ character: "", character_constraint: "", scene: "柜台与器物。", action: "器物放稳。", ...patch });
    delete source.characters;
    const output = project(source, false, { characterNames: ["陈卓"], characterPortraits: [portraits[0]!] });
    expect((output._workloomShotContract as Row).characterNames).toEqual([]);
    expect((output._workloomShotContract as Row).portraitAssets).toEqual([]);
    expect(String(output.prompt)).not.toContain("陈卓登记外观锚点");
  });

  it("does not turn an absent participant field into permission to use a multi-person project roster", () => {
    const output = project(shot({ character: "", character_constraint: "", scene: "柜台与器物。", action: "器物放稳。" }));
    const contract = output._workloomShotContract as Row;
    expect(contract.characterNames).toEqual([]);
    expect(contract.portraitAssets).toEqual([]);
    expect(String(output.prompt)).not.toContain("GLOBAL_ANON_APPEARANCE");
  });

  it("does not invent the legacy identity fallback when the single catalog name has no registered portrait", () => {
    const output = project(shot({ character: "", character_constraint: "", scene: "柜台与器物。", action: "器物放稳。" }), false,
      { characterNames: ["陈卓"], characterPortraits: [] });
    expect((output._workloomShotContract as Row).characterNames).toEqual([]);
    expect((output._workloomShotContract as Row).registeredSubjectCount).toBe(0);
  });

  it("uses an explicit shot-local portrait name without admitting the remaining project actors", () => {
    const source = shot({ character: "", character_constraint: "", portraitName: "陈卓", scene: "柜台与器物。", action: "器物放稳。" });
    const output = project(source);
    expect((output._workloomShotContract as Row).characterNames).toEqual(["陈卓"]);
    expect((output._workloomShotContract as Row).registeredCharacterNames).toEqual(["陈卓"]);
    expect(String(output.prompt)).not.toContain("GLOBAL_ANON_APPEARANCE");
  });

  it("retains an authored empty scene without catalog portraits or actors", () => {
    const output = project(shot({ character: "本镜无人物出场。", character_constraint: "本镜无人物。",
      scene: "空的检修台面。", action: "两件工具在台面两端停稳。",
      costume: "本镜无人物，不适用。", makeup: "本镜无人物，不适用。", props: "两件检修工具。" }));
    const contract = output._workloomShotContract as Row;
    expect(contract.characterNames).toEqual([]);
    expect(contract.subjectCount).toBe(0);
    expect(contract.portraitAssets).toEqual([]);
  });

  it.each(["BPM不适用", "BPM：不适用", "无需BPM", "无BPM", "BPM: N/A"])(
    "does not turn a negative technical marker into music context: %s", bpm => {
      const events = "仅保留现场原生声：引擎逐渐拔高，轮胎摩擦沥青，卡扣轻响";
      const output = project(shot({ audio: `无配乐，${bpm}，${events}。` }));
      expect(String((output.fields as Row).audio)).toContain(events);
    });

  it("still removes real forbidden music and speech without discarding the following native sound section", () => {
    const events = "仅保留现场原生声：引擎逐渐拔高，轮胎摩擦沥青，卡扣轻响";
    const output = project(shot({ audio: `背景音乐持续铺底，钢琴旋律渐强；${events}；可辨旁白说出品牌。` }));
    const audio = String((output.fields as Row).audio);
    expect(audio).toContain(events);
    expect(audio).not.toMatch(/背景音乐|钢琴|旋律|旁白|说出品牌/u);
  });

  it.each(["静音；无音轨；无配乐；无台词；BPM不适用", "无配乐；无台词；BPM不适用"])(
    "preserves authored silence or prohibition-only text without creating a positive-sound requirement: %s", audio => {
      const output = project(shot({ audio }));
      expect((output.fields as Row).audio).toBe(audio);
      expect(String(output.prompt)).not.toContain("与画面同步的环境声和主体动作声");
    });

  it("keeps the preexisting failure for truly missing audio instead of composing a replacement", () => {
    expect(() => project(shot({ audio: "" }))).toThrow(/MARKETING_NATIVE_SHOT_FIELD_MISSING.*audio/u);
  });

  it("keeps permitted in-scene music under the original no-background-music boundary", () => {
    const audio = "画面内现场乐队演奏的鼓点与现场掌声同步；无镜头外配乐。";
    const output = project(shot({ audio }), false, { noMusic: false });
    expect(String((output.fields as Row).audio)).toContain("画面内现场乐队演奏的鼓点与现场掌声同步");
  });

  it.each([
    { props: "全盔（外壳(无字、无标)、面罩闭合）、“工具甲、工具乙”套装、护具", expected: ["全盔（外壳(无字、无标)、面罩闭合）", "“工具甲、工具乙”套装", "护具"] },
    { props: "🚦标志（甲、乙）、【护具、卡扣】组合、工具", expected: ["🚦标志（甲、乙）", "【护具、卡扣】组合", "工具"] },
  ])("preserves complete nested and Unicode groups without changing authored prop text: $props", ({ props, expected }) => {
    const output = project(shot({ props }));
    expect((output._workloomShotContract as Row).props).toEqual(expected);
    expect((output.fields as Row).props).toBe(props);
  });

  it.each(["全盔（面罩闭合、护具", "全盔(面罩闭合）、护具", "未知来源物件"])(
    "keeps incomplete or unknown original props opaque instead of inventing a correction: %s", props => {
      const output = project(shot({ props }));
      expect((output._workloomShotContract as Row).props).toEqual([props]);
      expect((output.fields as Row).props).toBe(props);
    });

  it("leaves the existing nonmarketing global narrative identity policy unchanged", () => {
    const output = project(shot(), false, { marketingPrompt: undefined });
    expect((output._workloomShotContract as Row).characterNames).toEqual(["陈卓", "匿名对手车手"]);
    expect(String(output.prompt)).toContain("GLOBAL_ANON_APPEARANCE");
  });

  it("uses per-shot identities in the real Phase3 output policy and the later G6 reprojection", async () => {
    const first = shot(); first.shotId = "LOCAL-1";
    const second = shot({ character_constraint: "本镜仅允许陈卓与匿名对手车手入画；不得增加第三人物。" }); second.shotId = "LOCAL-2";
    const fixture = phaseFixture([first, second]);
    const sourceBefore = structuredClone(fixture.source);
    const blueprintBefore = structuredClone(fixture.blueprint);
    const uninstall = installVendorPhase3FusionBridge();
    try {
      const output = await fixture.phase.execute(fixture.state);
      expect(output.success).toBe(true);
      const rows = output.shots as Row[];
      const policies = rows.map(row => row._workloomPromptReviewPolicy as NarrativePromptReviewPolicy);
      expect(policies.map(policy => policy.characterNames)).toEqual([["陈卓"], ["陈卓", "匿名对手车手"]]);
      expect(policies.map(policy => policy.characterPortraits.map(profile => profile.name))).toEqual([["陈卓"], ["陈卓", "匿名对手车手"]]);
      const reviewed = normalizeNarrativePromptsForReview(rows, policies[0]!);
      expect(reviewed.map(row => (row._workloomShotContract as Row).characterNames)).toEqual([["陈卓"], ["陈卓", "匿名对手车手"]]);
      expect(JSON.stringify(reviewed[0])).not.toContain("GLOBAL_ANON_APPEARANCE");
      expect(fixture.repair).not.toHaveBeenCalled();
      expect(fixture.writer).not.toHaveBeenCalled();
      expect(fixture.finalCheckpoint).toHaveBeenCalledOnce();
      expect(fixture.source).toEqual(sourceBefore);
      expect(fixture.blueprint).toEqual(blueprintBefore);
    } finally { uninstall(); fixture.close(); }
  });

  it("isolates local character catalogs when two real Phase3 runs share a base agent concurrently", async () => {
    const makeRow = (name: string, id: string): Row => {
      const fields = JSON.parse(JSON.stringify(nativeFields()).replaceAll("陈卓", name)) as Row;
      return { ...shot(fields), shotId: id };
    };
    const aRow = makeRow("演员甲", "A-1"); const bRow = makeRow("演员乙", "B-1");
    const a = phaseFixture([aRow], [{ name: "演员甲", path: "registered/a.webp", appearance: "A_LOCAL" },
      { name: "甲路未出镜者", path: "", appearance: "A_OFFSCREEN" }]);
    const b = phaseFixture([bRow], [{ name: "演员乙", path: "registered/b.webp", appearance: "B_LOCAL" },
      { name: "乙路未出镜者", path: "", appearance: "B_OFFSCREEN" }]);
    b.phase.agents.promptFusion = a.agent;
    let release!: () => void; let arrived = 0;
    const together = new Promise<void>(resolveTogether => { release = resolveTogether; });
    a.process.mockImplementation(async (sourceRows: Row[]) => {
      if (++arrived === 2) release();
      await together;
      return { shots: structuredClone(sourceRows[0]!.shotId === "A-1" ? [aRow] : [bRow]),
        checkpointBlueprintHash: "c".repeat(64), degraded: false, stats: { total: 1, failed: 0 } };
    });
    const before = structuredClone([a.source, b.source, a.blueprint, b.blueprint]);
    const uninstall = installVendorPhase3FusionBridge();
    try {
      const outputs = await Promise.all([a.phase.execute(a.state), b.phase.execute(b.state)]);
      const rows = outputs.map(output => (output.shots as Row[])[0]!);
      expect(rows.map(row => (row._workloomPromptReviewPolicy as NarrativePromptReviewPolicy).characterNames)).toEqual([["演员甲"], ["演员乙"]]);
      expect(rows.map(row => (row._workloomShotContract as Row).characterNames)).toEqual([["演员甲"], ["演员乙"]]);
      expect(JSON.stringify(rows[0])).not.toMatch(/B_LOCAL|B_OFFSCREEN|A_OFFSCREEN|演员乙/u);
      expect(JSON.stringify(rows[1])).not.toMatch(/A_LOCAL|A_OFFSCREEN|B_OFFSCREEN|演员甲/u);
      expect(a.repair).not.toHaveBeenCalled(); expect(a.writer).not.toHaveBeenCalled();
      expect(a.agent).not.toHaveProperty("_workloomSetCanonicalCapacityRepair");
      expect([a.source, b.source, a.blueprint, b.blueprint]).toEqual(before);
    } finally { release(); uninstall(); a.close(); b.close(); }
  });
});
