import { createRequire } from "node:module";
import { resolve } from "node:path";
import { expect, it, vi } from "vitest";
import { videoRuntimeRoot } from "./runtime-root.js";
import { createStudioCheckpointRunner, studioCheckpointHash,
  type StudioCheckpointRequest, type StudioEngineCheckpoint } from "./studio-checkpoints.js";

type Row = Record<string, unknown>;
type Fields = Record<string, string>;
interface GuardResult { pass: boolean; issues: string[]; fieldCount: number; charCount: number }
interface CheckerIssue { fieldA: string; fieldB: string; message: string; fixable: boolean;
  fix(fields: Fields): Partial<Fields> | null }

const require = createRequire(import.meta.url);
const vendor = resolve(videoRuntimeRoot(import.meta.url), "vendor/supermickey/hyperreality-system");
const { PromptFusionAgent } = require(resolve(vendor, "engines/production-engine/agents/prompt-fusion-agent.js"));
const { FieldConsistencyChecker } = require(resolve(vendor, "engines/field-consistency-checker.js"));
const { PromptDeliveryGuard } = require(resolve(vendor, "engines/production-engine/agents/prompt-delivery-guard.js"));
const { SemanticRefinementPass } = require(resolve(vendor, "engines/production-engine/agents/semantic-refinement-pass.js"));
const guard = new PromptDeliveryGuard() as { verify(prompt: string, shot: Row): GuardResult };
const mood = "紧张而专注，视线锁定手中器物，眉峰微收，指尖绷紧后随呼吸放松。";
const source = { shotId: "S1", sceneType: "action", duration: 6, character: "演员甲",
  scene: "工作室内，演员甲把器物平稳放上工作台。", action: "双手托住器物后放稳。", mood };
const suffix = "（着装与服装字段一致）";

// Synthetic in-memory content exercises the real guard. It is never a saved
// scene, approval, model response or reconstruction of a historical candidate.
function prompt(dialogue?: string, numbering = false, emotion = mood) {
  const fields: Fields = {
    语言约束: "全部使用中文。", 导演意图: "写实记录演员甲平稳放下器物，保留连续受力。",
    基础: "写实材质与自然纹理。", 约束: "9:16画幅，1080x1920分辨率，24fps，MP4格式。",
    场景: "工作台表面保留木纹，器物与演员甲的双手始终完整入画，背景墙面保持原有空间关系。".repeat(40),
    灯光设计: "左侧自然柔光，5600K，主光方向固定。", 明亮约束: "双手与器物轮廓清晰。",
    构图: "中景，演员甲位于中央。", "色彩/色调": "中性灰与器物原色。", 景深: "f/5.6，焦点保持器物。",
    运镜: "全程固定机位。", 角色: "演员甲双手托住器物。", 服装: "灰色工作外套。", 化妆: "自然妆容。",
    动作: "演员甲双手托住器物，把底部放到工作台后依次松开指尖。", 道具: "一件器物与工作台。",
    定妆照: "演员甲已登记的参考。", ...(dialogue === undefined ? {} : { 台词: dialogue }),
    时间轴: "T00:00—T00:02托住器物；T00:02—T00:04落到桌面；T00:04—T00:06依次松手。",
    情绪: emotion, 节奏: "先托住再落稳，随后松手。", 转场: "本镜动作结束后硬切。",
    音频: "器物触桌轻响、衣料摩擦与不可辨呼吸。", 负面约束: "禁止水印、虚构人物与物件。",
    角色约束: "仅已登记演员甲入画。", 角色一致性: "人物身份与服装保持一致。",
  };
  return Object.entries(fields).map(([key, value], index) =>
    `${numbering ? String(index + 1).padStart(2, "0") + "." : ""}【${key}】${value}`).join(numbering ? "\n" : " | ");
}

function expectsVisiblePerformance(text: string) {
  expect(text).toMatch(/mood[^\n]*中文情绪基调/u);
  expect(text).toMatch(/mood[^\n]*可见[^\n]*(?:表演|微动作)/u);
  expect(text).not.toMatch(/情绪关键词\(1-2个|mood字段可用英文单词/u);
}

it("uses the same visible Chinese mood contract in system, batch and field-fill instructions without rewriting source input", () => {
  const agent = Object.create(PromptFusionAgent.prototype);
  const blueprint = { title: "器物放稳", character_system: { characters: [] }, config: {} };
  const before = structuredClone(source);
  expectsVisiblePerformance(agent._getSystemPrompt());
  expectsVisiblePerformance(agent._buildBatchPrompt([source], "9:16", [], blueprint));
  expectsVisiblePerformance(agent._buildFillPrompt(source, ["mood"], {}, "9:16", [], blueprint));
  expect(source).toEqual(before);
});

it("carries the concrete mood contract through the real grouped minimal-author path with an in-memory transport", async () => {
  const agent = Object.create(PromptFusionAgent.prototype);
  const transport = vi.fn(async (text: string) => {
    expectsVisiblePerformance(text);
    return { result: { fields: { mood } }, degraded: false };
  });
  agent._callLLM = transport;
  const before = structuredClone(source);
  expect(await agent._batchMinimalLLMDegradation(["mood"], source, "9:16", [])).toEqual({ mood });
  expect(transport).toHaveBeenCalledOnce();
  expect(source).toEqual(before);
});

it.each([["紧张，视线锁定器物，指尖绷紧。", "tense"], ["史诗，肩背挺直，双手托稳器物。", "epic"],
  ["平静，呼吸放缓，眉峰舒展。", "calm"]])("preserves existing mood consumers for %s", (value, expected) => {
  const agent = Object.create(PromptFusionAgent.prototype);
  const checker = new FieldConsistencyChecker({ logLevel: "silent" });
  expect(agent._extractMoodFromString(value)).toBe(expected);
  expect(checker._extractMood(value)).toBe(expected);
});

it("keeps the concrete emotion guard: keyword-only moods fail and visible performance passes", () => {
  expect(guard.verify(prompt(undefined, false, "紧张、专注"), source).issues)
    .toContain("【情绪】缺可见部位微动作描述（疑似关键词式写法）");
  expect(guard.verify(prompt(), source)).toMatchObject({ pass: true, issues: [] });
});

it("appends the original costume suffix exactly once across repeated public autoFix calls without changing input or diagnostics", () => {
  const checker = new FieldConsistencyChecker({ logLevel: "silent" });
  const shot = { shotId: "S1", fields: { character: "演员甲位于工作台右侧𠮷。", costume: "灰色防护外套，黑色长裤", props: "器物" } };
  const before = structuredClone(shot);
  const warning = checker.check(shot).issues.map((issue: CheckerIssue) => [issue.fieldA, issue.fieldB, issue.message, issue.fixable]);
  const first = checker.autoFix(shot);
  expect(first.fields).toEqual({ ...shot.fields, character: shot.fields.character + suffix });
  let current = first;
  for (let round = 0; round < 5; round += 1) {
    current = checker.autoFix(current);
    expect(current).toEqual(first);
    expect(current.fields.character.split(suffix)).toHaveLength(2);
  }
  expect(checker.check(current).issues.map((issue: CheckerIssue) => [issue.fieldA, issue.fieldB, issue.message, issue.fixable])).toEqual(warning);
  expect(shot).toEqual(before);
});

it.each([`演员甲${suffix}位于工作台右侧。`, `演员甲${suffix}${suffix}`])(
  "preserves an existing marker verbatim without adding or cleaning historical text: %s", character => {
    const checker = new FieldConsistencyChecker({ logLevel: "silent" });
    const shot = { shotId: "S1", fields: { character, costume: "灰色防护外套" } };
    expect(checker.autoFix(shot)).toEqual(shot);
  });

it("returns no new costume write when a previously obtained fix is reused with already repaired fields", () => {
  const checker = new FieldConsistencyChecker({ logLevel: "silent" });
  const fields = { character: "演员甲站在工作台旁。", costume: "灰色防护外套" };
  const issue = checker.check({ fields }).issues.find((entry: CheckerIssue) => entry.fieldB === "costume") as CheckerIssue;
  expect(issue.fix({ ...fields, character: fields.character + suffix })).toBeNull();
});

it.each([
  { character: "演员甲穿灰色防护外套。", costume: "灰色防护外套" },
  { character: "演员甲灰色专业防护外套", costume: "身穿灰色专业防护外套，黑色长裤" },
  { character: "", costume: "灰色外套" }, { character: "演员甲", costume: "" },
  { character: "演员甲" }, { costume: "灰色外套" },
])("retains existing costume-match, costume-head and empty-field behavior for %j", fields => {
  const checker = new FieldConsistencyChecker({ logLevel: "silent" });
  const shot = { shotId: "S1", fields };
  expect(checker.autoFix(shot)).toEqual(shot);
});

const denials = ["无台词。", "（无台词、无对白、无旁白。）", "本镜无台词、无对白、无旁白。", "本镜及全片无台词、对白、旁白、口播，只保留现场原生声。",
  "无台词：本片无对白、无旁白、无口播，只保留现场原生声。", "不适用：本片为无台词短片，无对白、无旁白、无口播。"];

it.each(denials)("accepts only the complete explicit no-speech declaration without changing its text: %s", declaration => {
  const text = prompt(declaration);
  const before = structuredClone(source);
  const result = guard.verify(text, source);
  expect(result).toMatchObject({ pass: true, issues: [], fieldCount: 26 });
  expect(text).toContain(declaration);
  expect(source).toEqual(before);
});

it("accepts the same no-speech declaration through numbered native semantic refinement without bypassing the guard", async () => {
  const base = prompt("本镜无台词。", true);
  const refined = prompt("无台词：本片无对白、无旁白、无口播，只保留现场原生声。", true);
  const transport = vi.fn(async () => ({ result: { prompt: refined, actions: [] } }));
  const semantic = new SemanticRefinementPass({ callLLM: transport });
  const result = await semantic.refine(base, source);
  expect(result).toMatchObject({ applied: true, prompt: refined, fallbackReason: null, guard: { pass: true, issues: [] } });
  expect(transport).toHaveBeenCalledOnce();
});

it.each(["无台词；但加入一句旁白。", "无台词；演员甲说：\"放好了。\"", "无台词；口播：\"欢迎回来。\"",
  "无台词。欢迎回来。", "无台词但解禁对白。", "无台词？有旁白。", "并非无台词。", "不禁止台词。", "没有禁止对白。", "不得没有对白。",
  "无台词旁白：欢迎回来。", "无台词；陌生人：你好。", '无台词。\n[0s-1s] 演员甲 看向器物, 平静 说:"放好了。"',
  '无台词。【台词】[0s-1s] 演员甲 看向器物, 平静 说:"放好了。"', ""])(
  "rejects mixed, quoted, ambiguous or empty declaration bodies: %s", declaration => {
    const result = guard.verify(prompt(declaration), source);
    expect(result.pass).toBe(false);
    expect(result.issues).toContain("数据层无台词但出现【台词】字段（疑似虚构）");
  });

it.each(["演员甲", "NONE", undefined, null])("still rejects undeclared real speech with character=%s", character => {
  const result = guard.verify(prompt('[0s-6s] 演员甲 看向器物, 平静 说:"放好了。"'), { ...source, character });
  expect(result.pass).toBe(false);
  expect(result.issues.some(issue => /疑似虚构|空镜出现实际台词/u.test(issue))).toBe(true);
});

it("cannot use a no-speech declaration to hide source dialogue and retains valid speech format/rate checks", () => {
  const shot = { ...source, dialogueBlocks: [{ speaker: "演员甲", line: "放好了。" }] };
  expect(guard.verify(prompt("无台词。"), shot).pass).toBe(false);
  expect(guard.verify(prompt(), shot).issues).toContain("数据层有台词但【台词】字段缺失");
  expect(guard.verify(prompt('[0s-6s] 演员甲 看向器物, 平静 说:"放好了。"'), shot).pass).toBe(true);
  expect(guard.verify(prompt(`[0s-1s] 演员甲 看向器物, 平静 说:"${"长句".repeat(30)}"`), shot).issues)
    .toEqual(expect.arrayContaining([expect.stringMatching(/台词超速/u), expect.stringMatching(/台词总占比超标/u)]));
});

// _extractScenes supplies dialogueBlocks: [] alongside its legacy dialogue and
// dialogueText strings. Empty earlier aliases must not hide those source lines.
const unifiedLine = "演员甲|对白|平静|放好了。|LIP_SYNC:YES";
const sourceAliases: Array<{ name: string; aliases: Row; expectsSpeech: boolean }> = [
  { name: "empty dialogueBlocks before legacy dialogue", aliases: { dialogueBlocks: [], dialogue: unifiedLine }, expectsSpeech: true },
  { name: "empty dialogues before legacy dialogue", aliases: { dialogues: [], dialogue: unifiedLine }, expectsSpeech: true },
  { name: "empty arrays and string before dialogueText", aliases: { dialogueBlocks: [], dialogues: [], dialogue: "", dialogueText: "放好了。" }, expectsSpeech: true },
  { name: "empty blocks before nonempty dialogues", aliases: { dialogueBlocks: [], dialogues: [{ speaker: "演员甲", line: "放好了。" }] }, expectsSpeech: true },
  { name: "negative dialogue before actual dialogueText", aliases: { dialogueBlocks: [], dialogue: "无台词。", dialogueText: "放好了。" }, expectsSpeech: true },
  { name: "mixed source denial and narration", aliases: { dialogueBlocks: [], dialogue: "无台词；但加入一句旁白。" }, expectsSpeech: true },
  { name: "literal spoken words that say no-dialogue", aliases: { dialogueBlocks: [], dialogue: "演员甲|对白|平静|无台词|LIP_SYNC:YES" }, expectsSpeech: true },
  { name: "quoted actual dialogueText", aliases: { dialogueBlocks: [], dialogueText: '"无台词"' }, expectsSpeech: true },
  { name: "all empty actual29 source aliases", aliases: { dialogueBlocks: [], dialogues: [], dialogue: "", dialogueText: "" }, expectsSpeech: false },
  { name: "explicit pure negative source string", aliases: { dialogue: "本镜无台词。", dialogueText: "" }, expectsSpeech: false },
  { name: "pure negative strings after empty arrays", aliases: { dialogueBlocks: [], dialogues: [], dialogue: "无台词。", dialogueText: "本片无对白、无旁白、无口播。" }, expectsSpeech: false },
  { name: "only a pure negative dialogueText", aliases: { dialogueBlocks: [], dialogues: [], dialogueText: "全程无对白、无旁白、无口播。" }, expectsSpeech: false },
];

it.each(sourceAliases)("source speech aliases stay authoritative: $name", ({ aliases, expectsSpeech }) => {
  const shot = { ...source, ...aliases }; const before = structuredClone(shot);
  const denied = guard.verify(prompt("无台词。"), shot);
  expect(denied.pass).toBe(!expectsSpeech);
  const omitted = guard.verify(prompt(), shot);
  if (expectsSpeech) {
    expect(denied.issues).toEqual(expect.arrayContaining([expect.stringMatching(/台词格式不规范/u)]));
    expect(omitted.issues).toContain("数据层有台词但【台词】字段缺失");
  } else expect(omitted).toMatchObject({ pass: true, issues: [] });
  expect(shot).toEqual(before);
});

it("a no-speech declaration still cannot mask missing fields, opening requirements, short content or keyword-only mood", () => {
  expect(guard.verify("【台词】无台词。", source).pass).toBe(false);
  expect(guard.verify(prompt("无台词。", false, "紧张"), source).issues)
    .toContain("【情绪】缺可见部位微动作描述（疑似关键词式写法）");
  expect(guard.verify(prompt("无台词。"), { ...source, sceneType: "opening" }).issues)
    .toContain("缺片头专属字段:标题动画设计");
});

it("invalidates the previous v13 production contract and title descendant while reusing each upstream checkpoint", async () => {
  const seed = { intent: "unchanged" }; const input = { source: "unchanged", feedback: "unchanged" };
  const prior = [["G2_THEME", "theme-input-and-brief/v1"], ["G3_INSIGHT", "source-bound-discovery-and-assumptions/v2"],
    ["G3_PROFILE", "native-source-aware-production-profile/v2"], ["G4_PRD", "source-bound-prd-native-local-contract/v3"],
    ["SCRIPT", "native-script-and-metadata/v1"], ["PRODUCTION", "native-production-camera-repair-feedback/v13"],
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
  const snapshot = [...records.values()].map(value => structuredClone(value));
  const runner = createStudioCheckpointRunner({ load: async value => records.get(key(value)) ?? null, save: async () => undefined }, seed);
  const authored: string[] = [];
  for (const [stage] of prior) {
    const output = await runner.run(stage, input, async () => { authored.push(stage); return { stage, revised: true }; });
    expect(output).toEqual(stage === "PRODUCTION" || stage === "OPENING_TITLE" ? { stage, revised: true } : { stage, original: true });
  }
  expect(authored).toEqual(["PRODUCTION", "OPENING_TITLE"]);
  expect([...records.values()]).toEqual(snapshot);
});
