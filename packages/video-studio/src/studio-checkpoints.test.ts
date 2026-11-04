import { expect, it, vi } from "vitest";
import {
  bindStudioEngineCheckpoints, createStudioCheckpointRunner, studioCheckpointHash, studioCheckpointInput, studioCheckpointJson,
  type StudioCheckpointAdapter, type StudioEngineCheckpoint, type StudioCheckpointRequest,
} from "./studio-checkpoints.js";
import { restoreMarketingDiscoveryCheckpoint } from "./vendor-compat.js";

const key = (request: StudioCheckpointRequest) =>
  [request.stage, request.inputSha256, request.dependencySha256].join("/");

function memoryStore() {
  const records = new Map<string, StudioEngineCheckpoint>();
  const adapter: StudioCheckpointAdapter = {
    load: async request => records.get(key(request)) ?? null,
    save: async record => { records.set(key(record), structuredClone(record)); },
  };
  return { adapter, records };
}

it("reuses completed native outputs and invalidates downstream work when an upstream result changes", async () => {
  const { adapter, records } = memoryStore();
  const first = createStudioCheckpointRunner(adapter, { projectId: "P1", rawIntent: "same" });
  const theme = vi.fn(async () => ({ tasks: [{ theme: "原生主题" }] }));
  const discovery = vi.fn(async () => ({ scenes: ["真实场景"] }));
  await first.run("G2_THEME", "same author input", theme);
  await first.run("G3_INSIGHT", { theme: "原生主题" }, discovery);
  const replay = createStudioCheckpointRunner(adapter, { rawIntent: "same", projectId: "P1" });
  await replay.run("G2_THEME", "same author input", theme);
  await replay.run("G3_INSIGHT", { theme: "原生主题" }, discovery);
  expect(theme).toHaveBeenCalledOnce();
  expect(discovery).toHaveBeenCalledOnce();
  expect(records.size).toBe(2);
  const changed = createStudioCheckpointRunner(adapter, { projectId: "P1", rawIntent: "changed" });
  await changed.run("G2_THEME", "same author input", theme);
  await changed.run("G3_INSIGHT", { theme: "原生主题" }, discovery);
  expect(theme).toHaveBeenCalledTimes(2);
  expect(discovery).toHaveBeenCalledTimes(2);
  expect(records.size).toBe(4);
});

it("retains the approved theme while invalidating discovery, profile and PRD from the old semantic policies", async () => {
  const { adapter, records } = memoryStore();
  const seed = { rawIntent: "原文保持不变" };
  const input = { theme: "已通过主题" };
  const themeOutput = { tasks: [{ theme: "已通过主题" }] };
  const themeRequest: StudioCheckpointRequest = {
    schemaVersion: "workloom.studio-engine-checkpoint/v1", stage: "G2_THEME",
    inputSha256: studioCheckpointHash({ policyVersion: "theme-input-and-brief/v1", input }),
    dependencySha256: studioCheckpointHash(seed),
  };
  const outputSha256 = studioCheckpointHash(themeOutput);
  await adapter.save({ ...themeRequest, output: themeOutput, outputSha256 });
  let dependencySha256 = studioCheckpointHash({ previous: themeRequest.dependencySha256,
    stage: themeRequest.stage, inputSha256: themeRequest.inputSha256, outputSha256 });
  for (const [stage, policyVersion] of [
    ["G3_INSIGHT", "source-bound-discovery/v1"], ["G3_PROFILE", "native-production-profile/v1"],
    ["G4_PRD", "source-bound-prd/v1"],
  ] as const) {
    const output = { stage, old: true };
    const inputSha256 = studioCheckpointHash({ policyVersion, input });
    const outputSha256 = studioCheckpointHash(output);
    await adapter.save({ schemaVersion: "workloom.studio-engine-checkpoint/v1", stage, inputSha256,
      dependencySha256, output, outputSha256 });
    dependencySha256 = studioCheckpointHash({ previous: dependencySha256, stage, inputSha256, outputSha256 });
  }
  const runner = createStudioCheckpointRunner(adapter, seed);
  const theme = vi.fn(async () => themeOutput);
  const author = vi.fn(async () => ({ current: true }));
  expect(await runner.run("G2_THEME", input, theme)).toEqual(themeOutput);
  for (const stage of ["G3_INSIGHT", "G3_PROFILE", "G4_PRD"] as const) {
    expect(await runner.run(stage, input, author)).toEqual({ current: true });
  }
  expect(theme).not.toHaveBeenCalled();
  expect(author).toHaveBeenCalledTimes(3);
  expect(records.size).toBe(7);
});

it("rejects altered output or mismatched identity before executing a new native call", async () => {
  const { adapter, records } = memoryStore();
  await createStudioCheckpointRunner(adapter, "seed").run("G2_THEME", "input", async () => ({ value: "kept" }));
  const record = [...records.values()][0]!;
  record.output = { value: "tampered" };
  const author = vi.fn(async () => ({ value: "repeated" }));
  await expect(createStudioCheckpointRunner(adapter, "seed").run("G2_THEME", "input", author))
    .rejects.toThrow("STUDIO_CHECKPOINT_INVALID");
  expect(author).not.toHaveBeenCalled();
  record.output = { value: "kept" };
  record.stage = "G4_PRD";
  await expect(createStudioCheckpointRunner(adapter, "seed").run("G2_THEME", "input", author))
    .rejects.toThrow("STUDIO_CHECKPOINT_INVALID");
});

it("surfaces an unresolved checkpoint write after completed work and preserves the original failure", async () => {
  const load = vi.fn(async () => null);
  const save = vi.fn(async () => { throw new Error("archive offline"); });
  const author = vi.fn(async () => ({ output: "completed" }));
  await expect(createStudioCheckpointRunner({ load, save }, "seed").run("G2_THEME", "input", author))
    .rejects.toThrow("STUDIO_CHECKPOINT_WRITE_UNVERIFIED");
  expect(author).toHaveBeenCalledOnce();
  expect(save).toHaveBeenCalledOnce();
  const failed = vi.fn(async () => { throw new Error("provider outcome unknown"); });
  await expect(createStudioCheckpointRunner({ load, save }, "seed").run("G2_THEME", "input", failed))
    .rejects.toThrow("provider outcome unknown");
  expect(save).toHaveBeenCalledOnce();
});

it("serializes vendor blueprint data without calling its string-returning toJSON method", () => {
  class NativeBlueprint {
    meta = { title: "真实剧本" };
    toJSON() { return "incorrect string"; }
  }
  expect(JSON.parse(studioCheckpointJson(new NativeBlueprint()))).toEqual({ meta: { title: "真实剧本" } });
  expect(studioCheckpointHash({ a: 1, b: 2 })).toBe(studioCheckpointHash({ b: 2, a: 1 }));
  expect(() => studioCheckpointJson({ unsupported: new Map([["secret", "value"]]) })).toThrow("STUDIO_CHECKPOINT_INVALID");
});

it("keeps native output property order intact across replay while using canonical hashes", async () => {
  const { adapter } = memoryStore();
  const original = { zFirst: { second: 2, first: 1 }, aLast: "same content" };
  const first = await createStudioCheckpointRunner(adapter, "same").run("G2_THEME", "input", async () => original);
  const next = await createStudioCheckpointRunner(adapter, "same").run("G2_THEME", "input", async () => ({}));
  expect(JSON.stringify(next)).toBe(JSON.stringify(first));
});

it("replays opening fields in place so the native report retains current prompt and shot aliases", async () => {
  const { adapter } = memoryStore();
  const optimize = vi.fn(async (production: Record<string, unknown>, _report: Record<string, unknown>, _metadata: Record<string, unknown>) => {
    const prompts = production.prompts as Array<Record<string, unknown>>;
    prompts[0]!.title_content = "已经完成的片名";
    prompts[0]!.prompt = "完整提示词，原生片头已完成";
  });
  const make = () => ({ creativeThemeGenerator: { generate: async () => ({}) },
    requirementDiscoveryEngine: { discover: async () => ({}) }, prdGenerator: { generate: async () => ({}) },
    scriptEngine: { process: async () => ({}) }, productionEngine: { produce: async () => ({}) },
    _optimizeOpeningTitle: optimize });
  for (let run = 0; run < 2; run++) {
    const system = make();
    bindStudioEngineCheckpoints(system, adapter, "same", { assertActive() {}, onFailure(error) { throw error; } });
    const prompts = [{ shotId: "SC00", prompt: "完整提示词" }] as Array<Record<string, unknown>>;
    const firstPrompt = prompts[0]!;
    const production = { prompts };
    const report = { stages: { productionEngine: { prompts } } };
    await system._optimizeOpeningTitle(production, report, {});
    expect(production.prompts).toBe(prompts);
    expect(report.stages.productionEngine.prompts[0]).toBe(firstPrompt);
    expect(firstPrompt.title_content).toBe("已经完成的片名");
    expect(firstPrompt.prompt).toContain("原生片头已完成");
  }
  expect(optimize).toHaveBeenCalledOnce();
});

it("restores script metadata and production blueprint side effects while reusing the native outputs", async () => {
  const { adapter } = memoryStore();
  let count = 0;
  const makeSystem = () => ({
    creativeThemeGenerator: { generate: vi.fn(async () => ({ tasks: [] })) },
    requirementDiscoveryEngine: { discover: vi.fn(async () => ({})) },
    prdGenerator: { generate: vi.fn(async () => ({})) },
    scriptEngine: { process: vi.fn(async (_intent: string, metadata: Record<string, unknown>) => {
      count++;
      metadata.narrativeMode = "commercial";
      return { adapted: { scenes: ["S1"] }, blueprint: { meta: { title: "stored" } } };
    }) },
    productionEngine: { produce: vi.fn(async (blueprint: Record<string, unknown>) => {
      count++;
      blueprint.normalized = true;
      return { success: true, shots: [{ shotId: "S1", prompt: "actual" }] };
    }) },
  });
  const failure = vi.fn();
  const first = makeSystem();
  bindStudioEngineCheckpoints(first, adapter, "seed", { assertActive() {}, onFailure: failure });
  await first.scriptEngine.process("intent", { product: "tea" });
  await first.productionEngine.produce({ scenes: ["S1"] });
  const second = makeSystem();
  bindStudioEngineCheckpoints(second, adapter, "seed", { assertActive() {}, onFailure: failure });
  const metadata: Record<string, unknown> = { product: "tea" };
  const blueprint: Record<string, unknown> = { scenes: ["S1"] };
  const script = await second.scriptEngine.process("intent", metadata);
  const production = await second.productionEngine.produce(blueprint);
  expect(count).toBe(2);
  expect(second.scriptEngine.process).not.toHaveProperty("mock");
  expect(metadata.narrativeMode).toBe("commercial");
  expect(blueprint.normalized).toBe(true);
  expect(script.blueprint.meta.title).toBe("stored");
  expect(production.shots[0]?.prompt).toBe("actual");
  expect(failure).not.toHaveBeenCalled();
});

it("keeps current-run failures active so a native fallback cannot dispatch another work station", async () => {
  const { adapter } = memoryStore();
  let failure: unknown;
  const author = vi.fn(async () => { throw new Error("known stage failed"); });
  const following = vi.fn(async () => ({ scenes: ["must not execute"] }));
  const system = {
    creativeThemeGenerator: { generate: author }, requirementDiscoveryEngine: { discover: following },
    prdGenerator: { generate: following }, scriptEngine: { process: following }, productionEngine: { produce: following },
  };
  bindStudioEngineCheckpoints(system, adapter, "seed", {
    assertActive() { if (failure) throw failure; },
    onFailure(error) { failure ??= error; },
  });
  await expect(system.creativeThemeGenerator.generate()).rejects.toThrow("known stage failed");
  await expect(system.requirementDiscoveryEngine.discover()).rejects.toThrow("known stage failed");
  expect(author).toHaveBeenCalledOnce();
  expect(following).not.toHaveBeenCalled();
});

it("rehydrates a verified source-bound discovery marker and rejects legacy fallback risks", () => {
  const source = { intent: "拿起茶杯后举杯。", product: "茶杯", restrictions: [] };
  const discovery = { sceneStructure: { requiredActions: ["拿起茶杯", "举杯"], requiredProps: ["杯"] },
    riskAssessment: { technicalRisks: [{ risk: "杯沿跨镜跳变", impact: "杯体不连续", level: "medium" }],
      mitigationSuggestions: ["锁定杯沿朝向并逐帧核对"], businessConstraints: ["保留原始动作"] } };
  const restored = restoreMarketingDiscoveryCheckpoint(JSON.parse(studioCheckpointJson(discovery)), source);
  expect(Object.getOwnPropertySymbols(restored.riskAssessment)).toHaveLength(1);
  expect(studioCheckpointHash(restored)).toBe(studioCheckpointHash(discovery));
  discovery.riskAssessment.mitigationSuggestions.push("错误的额外项");
  expect(() => restoreMarketingDiscoveryCheckpoint(discovery, source)).toThrow("MARKETING_RISK_ASSESSMENT_UNVERIFIED");
});

it("reuses the paid production profile with its discovery changes and preserves the authenticated marketing marker", async () => {
  const { adapter } = memoryStore();
  const source = { intent: "拿起茶杯后举杯。", product: "茶杯", restrictions: [] };
  const initial = () => restoreMarketingDiscoveryCheckpoint({
    sceneStructure: { requiredActions: ["拿起茶杯", "举杯"], requiredProps: ["杯"] },
    riskAssessment: { technicalRisks: [{ risk: "杯沿跨镜跳变", impact: "杯体不连续", level: "medium" }],
      mitigationSuggestions: ["锁定杯沿朝向并逐帧核对"], businessConstraints: ["保留原始动作"] },
  }, source);
  const profile = vi.fn(async (discovery: Record<string, unknown>) => {
    discovery._canonicalCharacters = [{ id: "actor", name: "本项目演员" }];
    return { productionProfile: { genre: "本项目题材", aspect_ratio: "16:9" } };
  });
  const make = () => ({ creativeThemeGenerator: { generate: async () => ({}) },
    requirementDiscoveryEngine: { discover: async () => ({}) }, prdGenerator: { generate: async () => ({}) },
    scriptEngine: { process: async () => ({}) }, productionEngine: { produce: async () => ({}) },
    _convertDiscoveryToRequirementList: profile });
  const outputs = [];
  for (let run = 0; run < 2; run++) {
    const system = make();
    bindStudioEngineCheckpoints(system, adapter, "same", { assertActive() {}, onFailure(error) { throw error; },
      restoreDiscovery: output => restoreMarketingDiscoveryCheckpoint(output, source) });
    const discovery = initial();
    outputs.push(await system._convertDiscoveryToRequirementList(discovery));
    expect(discovery._canonicalCharacters).toEqual([{ id: "actor", name: "本项目演员" }]);
    expect(Object.getOwnPropertySymbols(discovery.riskAssessment)).toHaveLength(1);
  }
  expect(profile).toHaveBeenCalledOnce();
  expect(outputs[0]).toEqual(outputs[1]);
});

it("keeps title fingerprints stable across execution reports while invalidating real title or shot changes", () => {
  const production = { success: true, shots: [{ shotId: "SC00", prompt: "本项目完整提示词" }] };
  const metadata = { title: "客户片名", _creativeTheme: { theme: "原主题" } };
  const input = (report: object, meta = metadata, output = production) =>
    studioCheckpointHash(studioCheckpointInput("OPENING_TITLE", [output, report, meta]));
  expect(input({ title: "客户片名", stages: { adapter: { scenes: ["S1"] } }, runId: "first", timing: 1 }))
    .toBe(input({ title: "客户片名", stages: { adapter: { scenes: ["S1"] } }, runId: "next", timing: 999 }));
  expect(input({}, { ...metadata, title: "新片名" })).not.toBe(input({}));
  expect(input({}, metadata, { ...production, shots: [{ shotId: "SC00", prompt: "改过提示词" }] })).not.toBe(input({}));
  expect(input({ stages: { adapter: { scenes: ["S2"] } } })).not.toBe(input({ stages: { adapter: { scenes: ["S1"] } } }));
});

it("excludes only runtime dossier reports and production deadlines from stage fingerprints", () => {
  const script = (trace: string, cards = { theme: "已核实事实" }) => studioCheckpointHash(studioCheckpointInput("SCRIPT", ["完整原话", {
    _dataDossier: { product_id: "product", cards, trace_id: trace, saved: trace, envelopes: [trace], chain: trace },
    characters: [{ portraitRef: "current.jpg" }],
  }]));
  expect(script("first-run")).toBe(script("later-run"));
  expect(script("first", { theme: "事实已变更" })).not.toBe(script("first"));
  const production = (totalDeadlineMs: number, model = "same-model") =>
    studioCheckpointHash(studioCheckpointInput("PRODUCTION", [{ scenes: ["S1"] }, { totalDeadlineMs, model }]));
  expect(production(1000)).toBe(production(999_999));
  expect(production(1000, "other-model")).not.toBe(production(1000));
});
