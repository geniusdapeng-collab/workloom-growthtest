import { AsyncLocalStorage } from "node:async_hooks";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { expect, it, vi } from "vitest";
import { videoRuntimeRoot } from "./runtime-root.js";
import { installVendorDiscoveryNarrativeBridge, normalizeNarrativePrdContract,
  renderPrdContractMarkdown, type SourceBoundMarketingDiscovery } from "./vendor-compat.js";
import { createStudioCheckpointRunner, studioCheckpointHash,
  type StudioEngineCheckpoint, type StudioCheckpointRequest } from "./studio-checkpoints.js";

type Row = Record<string, any>;
const require = createRequire(import.meta.url);
const root = videoRuntimeRoot(import.meta.url);
const { CreativeDirectionAgent } = require(resolve(root,
  "vendor/supermickey/hyperreality-system/engines/prd-generator/agents/agent-2-creative-direction.js"));
const { ProductionSpecificationAgent } = require(resolve(root,
  "vendor/supermickey/hyperreality-system/engines/prd-generator/agents/agent-3-production-specification.js"));

const customerIntent = "演员甲把样品交给匿名工作人员，工作人员放稳样品。无对白，保留样品接触工作台的原生声。成片叠加“演示$&𠮷｜请勿模仿”，尾帧“工序完成”。";
const source: SourceBoundMarketingDiscovery = { intent: customerIntent, product: "样品", restrictions: ["不得添加未经核实的商品数字"] };
const contract = { intent: customerIntent, actions: ["演员甲把样品交给匿名工作人员", "工作人员放稳样品"], props: ["样品"] };
const anonymous = { characterId: "anon-worker", name: "匿名工作人员", role: "supporting",
  ageRange: "不限", appearance: "只见护袖和双手，不露可辨认面孔", personality: "按动作完成交接",
  costume: "深灰工作服", portraitPath: "", consistencyRequirements: "同一工作服与手套" };
const lead = { characterId: "lead", name: "演员甲", role: "protagonist", ageRange: "青年",
  appearance: "作者为主角保留的外观描述", personality: "沉稳", costume: "本片作者的蓝色工作服",
  portraitPath: "", consistencyRequirements: "同一人" };

function discovery(): Row {
  return { upstreamFields: { type: "商业广告", duration_sec: 8, aspect_ratio: "9:16", platform: "douyin",
    theme: "样品交接", visual_style: "侧面慢速跟拍交接，结尾固定机位", dialogue_requirement: "无对白；保留样品接触工作台的原生声。",
    _originalStoryText: "上游扩展故事，不能冒充客户原文", _workloomCustomerIntent: customerIntent },
    _canonicalCharacters: [{ id: "lead", characterId: "lead", name: "演员甲", role: "protagonist", portraitRef: "" }],
    audienceProfile: { primaryAudience: { interestTags: ["完整工序"] } }, referenceCases: { filmReferences: [], styleReferences: [] },
    riskAssessment: { businessConstraints: ["本片不额外加入配乐；原文允许的现场声照常保留。"] },
    sceneStructure: { opening: { duration: 3, purpose: "上游场景摘要甲", keyElements: ["样品"] },
      scenes: [], ending: { duration: 5, purpose: "上游场景摘要乙", keyElements: ["工作台"] }, sceneCount: 2, totalDuration: 8 } };
}

function authoredPrd(): Row {
  return { projectDefinition: { sourceIntent: customerIntent },
    productPositioning: { targetDuration: 8, aspectRatio: "9:16", frameRate: 24 },
    creativeCore: { keyMessages: ["按作者的本地动作推进"] },
    visualSpecification: { cameraLanguage: "侧面慢速跟拍交接，结尾固定机位", lightingDirection: "窗边柔光", colorPalette: { dominant: "灰色" } },
    audioSpecification: { musicStyle: "未规划镜头外配乐", soundDesign: "样品接触工作台的轻响", voicePolicy: "无对白" },
    characterSystem: { characters: [structuredClone(anonymous), structuredClone(lead)] },
    scenePlan: { scenes: [
      { sceneId: "LOCAL-A", sequence: 1, duration: 3, purpose: "演员甲把样品交给匿名工作人员", setting: "工作台左侧交接区",
        characters: ["lead", "anon-worker"], visualRequirements: ["从侧面慢速跟拍交接"], audioRequirements: ["手套摩擦样品"], keyProps: ["样品"], dialogue: "" },
      { sceneId: "LOCAL-B", sequence: 2, duration: 5, purpose: "匿名工作人员在工作台上放稳样品", setting: "工作台右侧放置区",
        characters: ["anon-worker"], visualRequirements: ["固定机位观察落稳"], audioRequirements: ["样品接触工作台的轻响"], keyProps: ["样品", "工作台"], dialogue: "" },
    ], shotMapping: [
      { sceneId: "LOCAL-A", estimatedShots: 1, shotBreakdownHint: ["medium"], shots: [
        { purpose: "双方手掌交接同一件样品", action: "演员甲松手，匿名工作人员接稳", cameraMovement: "slow_tracking",
          participants: ["lead", "anon-worker"], keyProps: ["样品"], startSeconds: 0, endSeconds: 3 },
      ] },
      { sceneId: "LOCAL-B", estimatedShots: 1, shotBreakdownHint: ["close-up"], shots: [
        { purpose: "接手后把样品放稳在工作台右侧", action: "匿名工作人员让样品底部接触台面后松手", cameraMovement: "locked",
          participants: ["anon-worker"], keyProps: ["样品", "工作台"], startSeconds: 3, endSeconds: 8 },
      ] },
    ] }, productionConstraints: { qualityThresholds: {} },
    deliveryStandard: { outputFormat: { videoCodec: "H.265", audioCodec: "AAC", container: "MP4" },
      deliverables: [{ item: "video_master", spec: "native old spec", priority: "required" }] } };
}

it("preserves native marketing scenes, local actions and shot hints instead of grafting G3 summaries or global literal actions", () => {
  const prd = authoredPrd(); const before = structuredClone(prd.scenePlan); const input = discovery(); const held = structuredClone(input);
  const output = normalizeNarrativePrdContract(prd, input, contract) as Row;
  expect(output.scenePlan.scenes).toEqual(before.scenes);
  expect(output.scenePlan.shotMapping).toEqual(before.shotMapping);
  expect(output.shotContract.map((row: Row) => [row.sceneId, row.purpose, row.action, row.cameraMovement]))
    .toEqual([["LOCAL-A", "双方手掌交接同一件样品", "演员甲松手，匿名工作人员接稳", "slow_tracking"],
      ["LOCAL-B", "接手后把样品放稳在工作台右侧", "匿名工作人员让样品底部接触台面后松手", "locked"]]);
  expect(output.shotContract.map((row: Row) => [row.startSeconds, row.endSeconds])).toEqual([[0, 3], [3, 8]]);
  expect(output.visualSpecification.cameraLanguage).toBe(prd.visualSpecification.cameraLanguage);
  expect(output.visualSpecification.cameraLanguage).not.toContain("三脚架锁死");
  expect(output.creativeCore.keyMessages.join("\n")).toContain("原文必需项清单");
  expect(output.creativeCore.keyMessages.join("\n")).not.toContain("按顺序执行");
  for (const action of contract.actions) expect(output.creativeCore.keyMessages.join("\n")).toContain(action);
  expect(input).toEqual(held);
});

it("matches registered identity by id or name, retains authored anonymous cast and local references, and fabricates no authorization", () => {
  const output = normalizeNarrativePrdContract(authoredPrd(), discovery(), contract) as Row;
  expect(output.characterSystem.characters).toHaveLength(2);
  const registered = output.characterSystem.characters.find((row: Row) => row.characterId === "lead");
  const contextual = output.characterSystem.characters.find((row: Row) => row.characterId === "anon-worker");
  expect(registered.appearance).toContain(lead.appearance);
  expect(registered.appearance).not.toContain(anonymous.appearance);
  expect(registered.costume).toBe(lead.costume);
  expect(contextual).toEqual(anonymous);
  expect(contextual).not.toHaveProperty("authorization");
  expect(contextual).not.toHaveProperty("portraitEvidence");
  expect(output.shotContract[0].subjectIds).toEqual(["lead", "anon-worker"]);
  expect(output.shotContract[0].subjectCount).toBe(2);
  expect(output.shotContract[1].subjectIds).toEqual(["anon-worker"]);
  expect(output.shotContract[1].subjectCount).toBe(1);
});

it("does not invent contextual cast when the native author has supplied none", () => {
  const prd = authoredPrd(); prd.characterSystem.characters = [structuredClone(lead)];
  const output = normalizeNarrativePrdContract(prd, discovery(), contract) as Row;
  expect(output.characterSystem.characters.map((row: Row) => row.name)).toEqual(["演员甲"]);
  expect(output.shotContract[0].participants).toEqual(["lead", "anon-worker"]); // Preserve declared unresolved references for the real gate.
});

it("keeps an anonymous-only native cast without inventing registered identity assets or removing its physical actions", () => {
  const input = discovery(); input._canonicalCharacters = [];
  const prd = authoredPrd(); prd.characterSystem.characters = [structuredClone(anonymous)];
  prd.scenePlan.scenes[0].purpose = "匿名工作人员用手掌接稳样品，保留呼吸声";
  const output = normalizeNarrativePrdContract(prd, input, contract) as Row;
  expect(output.characterSystem.characters).toEqual([anonymous]);
  expect(output.characterSystem.characters[0]).not.toHaveProperty("portraitEvidence");
  expect(output.characterSystem.characters[0]).not.toHaveProperty("authorization");
  expect(output.scenePlan.scenes[0].purpose).toBe("匿名工作人员用手掌接稳样品，保留呼吸声");
  expect(output.deliveryStandard.characterAssets.required).toBe(false);
  expect(output.deliveryStandard.characterAssets.reason).toContain("没有已登记身份参考");
  expect(output.deliveryStandard.characterAssets.reason).not.toMatch(/没有角色|动物角色/u);
});

it.each(["medium", "close-up"])("does not infer locked movement from a size-only native hint %s", hint => {
  const prd = authoredPrd(); const mapping = prd.scenePlan.shotMapping[0]; delete mapping.shots; mapping.shotBreakdownHint = [hint];
  const output = normalizeNarrativePrdContract(prd, discovery(), contract) as Row;
  expect(output.shotContract[0].cameraMovement).toBe(prd.visualSpecification.cameraLanguage);
  expect(output.shotContract[0].cameraMovement).not.toBe("locked");
});

it("retains an explicitly authored locked global camera and keeps nonmarketing legacy reconciliation scoped", () => {
  const prd = authoredPrd(); prd.visualSpecification.cameraLanguage = "固定机位，三脚架锁死";
  delete prd.scenePlan.shotMapping[0].shots;
  const output = normalizeNarrativePrdContract(prd, discovery(), contract) as Row;
  expect(output.shotContract[0].cameraMovement).toBe("固定机位，三脚架锁死");
  const narrative = normalizeNarrativePrdContract(authoredPrd(), discovery()) as Row;
  expect(narrative.scenePlan.scenes[0].purpose).toBe("上游场景摘要甲");
});

it.each([
  ["H.265", "AAC", "MP4"], ["ProRes", "PCM", "MOV"],
])("uses one native canonical codec/container/audio format in the required master (%s/%s/%s)", (videoCodec, audioCodec, container) => {
  const prd = authoredPrd(); prd.deliveryStandard.outputFormat = { videoCodec, audioCodec, container };
  const output = normalizeNarrativePrdContract(prd, discovery(), contract) as Row;
  expect(output.deliveryStandard.outputFormat).toMatchObject({ videoCodec, audioCodec, container });
  expect(output.deliveryStandard.deliverables.find((row: Row) => row.item === "video_master").spec)
    .toContain(`${container}/${videoCodec}/${audioCodec}`);
});

it("separates exact post graphics and end-card literals from absent dialogue subtitles", () => {
  const output = normalizeNarrativePrdContract(authoredPrd(), discovery(), contract) as Row;
  expect(output.deliveryStandard.subtitles).toEqual({ mode: "none", burned: false, sidecar: false });
  const markdown = renderPrdContractMarkdown(output);
  expect(markdown).toContain("画面图形与尾帧");
  expect(markdown).toContain("语音字幕");
  expect(markdown).toContain("标准后期");
  for (const literal of ["演示$&𠮷｜请勿模仿", "工序完成"]) expect(markdown).toContain(literal);
  expect(markdown).toContain("平台安全区");
  expect(output._workloomMarketingPrompt).toEqual({ actions: contract.actions,
    overlay: ["演示$&𠮷｜请勿模仿"], endCard: ["工序完成"] });
});

it("keeps explicit speech-subtitle instructions while retaining separate graphics", () => {
  const input = discovery(); input.upstreamFields.dialogue_requirement = "保留旁白；烧录字幕";
  const output = normalizeNarrativePrdContract(authoredPrd(), input, contract) as Row;
  expect(output.deliveryStandard.subtitles).toEqual({ mode: "burned", burned: true, sidecar: false });
  expect(renderPrdContractMarkdown(output)).toContain("演示$&𠮷｜请勿模仿");
});

it("does not move an authored in-film overlay/end-card message outside the film because speech subtitles are absent", () => {
  const prd = authoredPrd(); const message = "片中叠加“演示$&𠮷｜请勿模仿”，尾帧“工序完成”进入成片。";
  prd.creativeCore.keyMessages = [message];
  const output = normalizeNarrativePrdContract(prd, discovery(), contract) as Row;
  expect(output.creativeCore.keyMessages[0]).toBe(message);
  expect(output.creativeCore.keyMessages[0]).not.toContain("站外发布");
  expect(renderPrdContractMarkdown(output)).toContain("工序完成");
});

it("preserves allowed native crowd voices and negative narration declarations without inventing an audio ban", () => {
  const input = discovery(); input.upstreamFields.dialogue_requirement = "无对白、无旁白，保留观众人声欢呼与动作原生声。";
  const prd = authoredPrd(); const audio = ["观众人声欢呼", "无旁白，保留观众欢呼与样品接触台面的原生声。"];
  prd.scenePlan.scenes[0].audioRequirements = audio;
  prd.audioSpecification.soundDesign = audio[1];
  prd.productionConstraints.businessConstraints = [audio[1]];
  const raw = "无对白、无旁白，保留观众人声欢呼与动作原生声。";
  const output = normalizeNarrativePrdContract(prd, input, { ...contract, intent: raw }) as Row;
  expect(output.scenePlan.scenes[0].audioRequirements).toEqual(audio);
  expect(output.shotContract[0].audioAnchors).toEqual(audio);
  expect(output.audioSpecification.soundDesign).toBe(audio[1]);
  expect(output.productionConstraints.businessConstraints).toEqual([audio[1]]);
  expect(output._workloomCustomerIntent).toBe(raw);
});

it("passes exact source voice/business/full scene context into both real native PRD author prompts and restores their methods", async () => {
  const originals = [CreativeDirectionAgent.prototype._buildPrompt, ProductionSpecificationAgent.prototype._buildPrompt];
  const scope = new AsyncLocalStorage<SourceBoundMarketingDiscovery>();
  const restore = installVendorDiscoveryNarrativeBridge({ marketingDiscovery: () => scope.getStore() });
  const restoreAgain = installVendorDiscoveryNarrativeBridge({ marketingDiscovery: () => scope.getStore() });
  const input = discovery(); const before = structuredClone(input);
  const sources = [source, { ...source, intent: "另一个并发原文PRD_SCOPE_B", restrictions: ["另一个围栏"] }];
  try {
    for (const Agent of [CreativeDirectionAgent, ProductionSpecificationAgent]) {
      const agent = new Agent({ llmModel: "fixed-test-author" });
      const prompts = await Promise.all(sources.map(current => scope.run(current, async () => {
        await Promise.resolve();
        return agent._buildPrompt(input, { creativeCore: { coreTheme: "作者主题", creativeHook: "作者钩子" } });
      })));
      for (const [index, prompt] of prompts.entries()) {
        const section = prompt.split("【当前已核对的营销 PRD 创作合同】");
        expect(section).toHaveLength(2);
        expect(section[1]).toContain(sources[index]!.intent);
        expect(section[1]).toContain(sources[index]!.restrictions[0]);
        expect(section[1]).toContain(input.upstreamFields.dialogue_requirement);
        expect(section[1]).toContain(input.riskAssessment.businessConstraints[0]);
        expect(section[1]).toContain(input.sceneStructure.opening.purpose);
        expect(section[1]).toContain(input.sceneStructure.ending.purpose);
        expect(section[1]).toContain("身份资产");
        expect(section[1]).toContain("匿名");
        expect(section[1]).not.toContain(sources[1 - index]!.intent);
      }
      expect(agent.llmModel).toBe("fixed-test-author");
      expect(agent._buildPrompt(input, {})).not.toContain("【当前已核对的营销 PRD 创作合同】");
    }
    expect(input).toEqual(before);
  } finally { restoreAgain(); restore(); }
  expect(CreativeDirectionAgent.prototype._buildPrompt).toBe(originals[0]);
  expect(ProductionSpecificationAgent.prototype._buildPrompt).toBe(originals[1]);
});

it("retains optional native per-shot action/movement/participant data through the actual production-specification parser", () => {
  const native = authoredPrd(); const agent = new ProductionSpecificationAgent();
  agent._lastDiscoveryResult = discovery();
  const parsed = agent._parseResult(JSON.stringify(native), discovery());
  const output = normalizeNarrativePrdContract(parsed, discovery(), contract) as Row;
  expect(output.scenePlan.shotMapping[0].shots).toEqual(native.scenePlan.shotMapping[0].shots);
  expect(output.shotContract[0].action).toBe(native.scenePlan.shotMapping[0].shots[0].action);
  expect(output.shotContract[0].participants).toEqual(["lead", "anon-worker"]);
});

it("sends the source contract through both actual native process methods with one synthetic transport call each", async () => {
  const restore = installVendorDiscoveryNarrativeBridge({ marketingDiscovery: () => source });
  const input = discovery(); const before = structuredClone(input);
  const director = new CreativeDirectionAgent({ llmModel: "native-director-fixed", timeoutMs: 3210 });
  const specification = new ProductionSpecificationAgent({ llmModel: "native-spec-fixed", timeoutMs: 4320 });
  const creativeReply = { coreTheme: "样品的交接", creativeHook: "前3秒让交接动作清晰", emotionalArc: "setup→climax→resolution",
    keyMessages: ["P0: 完整交接"], twistPoint: "", endingType: "闭合式" };
  const nativeReply = authoredPrd();
  const directorTransport = vi.fn(async function(this: object, prompt: string, schema: unknown, fallback: unknown, options: unknown) {
    expect(this).toBe(director); expect(prompt).toContain(customerIntent);
    expect(prompt).toContain(input.upstreamFields.dialogue_requirement);
    expect(schema).toEqual({ required: ["coreTheme", "creativeHook", "emotionalArc", "keyMessages", "endingType"] });
    expect(fallback).toBeNull(); expect(options).toEqual({ timeoutMs: 3210 });
    return { result: creativeReply, degraded: false };
  });
  const specificationTransport = vi.fn(async function(this: object, prompt: string, schema: unknown, fallback: unknown, options: unknown) {
    expect(this).toBe(specification); expect(prompt).toContain(customerIntent);
    expect(prompt).toContain(input.riskAssessment.businessConstraints[0]);
    expect(schema).toEqual({ required: ["visualSpecification", "audioSpecification"] });
    expect(fallback).toBeNull(); expect(options).toEqual({ timeoutMs: 4320 });
    return { result: nativeReply, degraded: false };
  });
  director._callLLM = directorTransport; specification._callLLM = specificationTransport;
  try {
    const creative = await director.process(input);
    const produced = await specification.process(input, creative);
    expect(creative.creativeCore).toEqual(creativeReply);
    expect(produced.scenePlan).toEqual(nativeReply.scenePlan);
    expect(directorTransport).toHaveBeenCalledOnce(); expect(specificationTransport).toHaveBeenCalledOnce();
    expect([director.llmModel, specification.llmModel]).toEqual(["native-director-fixed", "native-spec-fixed"]);
    expect(input).toEqual(before);
  } finally { restore(); }
});

it("advances only G4 semantics, reusing the completed upstream stations and rejecting the old PRD policy cache", async () => {
  const records = new Map<string, StudioEngineCheckpoint>(); const key = (r: StudioCheckpointRequest) => `${r.stage}/${r.inputSha256}/${r.dependencySha256}`;
  const adapter = { load: async (r: StudioCheckpointRequest) => records.get(key(r)) ?? null,
    save: async (r: StudioEngineCheckpoint) => { records.set(key(r), structuredClone(r)); } };
  const seed = "same frozen request"; const input = { source: "unchanged" };
  const stages = ["G2_THEME", "G3_INSIGHT", "G3_PROFILE"] as const;
  const policies = ["theme-input-and-brief/v1", "source-bound-discovery-and-assumptions/v2", "native-source-aware-production-profile/v2"];
  const first = createStudioCheckpointRunner(adapter, seed); const authors = stages.map(stage => vi.fn(async () => ({ stage })));
  for (let i = 0; i < stages.length; i++) await first.run(stages[i]!, input, authors[i]!);
  const upstream = [...records.values()];
  expect(upstream.map((r, i) => r.inputSha256)).toEqual(policies.map(policyVersion => studioCheckpointHash({ policyVersion, input })));
  const last = upstream.at(-1)!; const prior = { badPrd: "old host forced template" };
  const old: StudioEngineCheckpoint = { schemaVersion: "workloom.studio-engine-checkpoint/v1", stage: "G4_PRD",
    inputSha256: studioCheckpointHash({ policyVersion: "source-bound-prd-and-assumptions/v2", input }),
    dependencySha256: studioCheckpointHash({ previous: last.dependencySha256, stage: last.stage,
      inputSha256: last.inputSha256, outputSha256: last.outputSha256 }), output: prior, outputSha256: studioCheckpointHash(prior) };
  await adapter.save(old);
  const replay = createStudioCheckpointRunner(adapter, seed);
  for (let i = 0; i < stages.length; i++) await replay.run(stages[i]!, input, authors[i]!);
  const prdAuthor = vi.fn(async () => ({ nativeLocalContract: true }));
  expect(await replay.run("G4_PRD", input, prdAuthor)).toEqual({ nativeLocalContract: true });
  expect(prdAuthor).toHaveBeenCalledOnce();
  for (const author of authors) expect(author).toHaveBeenCalledOnce();
});
