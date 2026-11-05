import { createRequire } from "node:module";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { expect, it, vi } from "vitest";
import { installVendorPhase3FusionBridge } from "./vendor-compat.js";
import { cinematicSkillHash } from "./cinematic-skill-policy.js";
import { videoRuntimeRoot } from "./runtime-root.js";

type Row = Record<string, unknown>;
const require = createRequire(import.meta.url);
const root = videoRuntimeRoot(import.meta.url);
const vendor = resolve(root, "vendor/supermickey/hyperreality-system");
const { ProductionEngine } = require(resolve(vendor, "engines/production-engine/production-engine.js"));
const { Phase1SceneDesign } = require(resolve(vendor, "engines/production-engine/phases/phase-1-scene-design.js"));
const { Phase2VisualAudio } = require(resolve(vendor, "engines/production-engine/phases/phase-2-visual-audio.js"));
const { Phase3PromptFusion } = require(resolve(vendor, "engines/production-engine/phases/phase-3-prompt-fusion.js"));
const { PromptFusionAgent } = require(resolve(vendor, "engines/production-engine/agents/prompt-fusion-agent.js"));
const router = require(resolve(vendor, "skills/hollywood-cinematography/cinematography-skill-router.js"));

function blueprint(): Row {
  return {
    config: { title: "杯沿的光", aspectRatio: "9:16", target_duration: 10 },
    scenes: [1, 2].map(index => ({ scene_id: `S${index}`, scene_type: "establishing",
      setting: "安静的器物摄影工位，木桌上摆放一只没有文字的陶杯。", action: "光线沿杯沿缓慢移动。",
      timing: { start: (index - 1) * 5, duration: 5, end: index * 5 }, characters: [] })),
    characters: [], character_system: { characters: [] },
    _creativeTheme: { type: "纪录片", tone: "平静观察", theme: "杯沿的光", target_audience: "器物爱好者",
      description: "观察陶杯表面与自然光线的连续变化。" },
    _workloomProductionRepairFeedback: "合成工位修复上下文：保留陶杯与木桌，不增加人物或道具。",
    meta: { _metadata: { dialogueRequirement: "不添加人声旁白或对白，不添加配乐。", _prd: {
      _workloomMarketingPrompt: { actions: [], overlay: [], endCard: [] },
      productPositioning: { targetDuration: 10, aspectRatio: "9:16", resolution: "1080x1920" },
      characterSystem: { characters: [] },
    } } },
  };
}

function authoredRow(shot: Row): Row {
  const fields = {
    scene: `器物摄影工位，${"木桌与灰墙保留真实纹理。".repeat(500)}`,
    action: "自然光沿陶杯杯沿缓慢移动，陶杯保持静止。", costume: "无人物出场，不适用。",
    makeup: "无人物出场，不适用。", props: "一只素色陶杯、一张木桌。",
    timeline: "T00:00-00:02光线进入；T00:02-00:04沿杯沿移动；T00:04-00:05停稳。",
    composition: "陶杯近景，杯沿位于画面中央。", lighting: "左侧窗户提供5600K柔光。",
    color_palette: "中性灰色与木纹暖色。", transition: "入场硬切，出场硬切至下一镜。",
    mood: "平静，光线缓慢移动。", camera_movement: "固定近景，机位水平稳定。",
    pacing: "开头进入、中段移动、结尾停稳。", depth_of_field: "焦点在杯沿，背景轻微虚化。",
    audio: "窗外风声与室内细微环境声。",
  };
  return { ...shot, ...fields, fields, prompt: "01.【场景】陶杯静置木桌，光线沿杯沿移动。", degraded: false };
}

interface ProcessInput {
  referencesCurrentBlueprint: boolean;
  sourceHashes: unknown[];
  originalKey: unknown;
  effectiveKey?: unknown;
}

function productionFixture(directory: string, boundedScene = false) {
  const processInputs: ProcessInput[] = [];
  const author = vi.fn(async (shot: Row) => {
    const row = authoredRow(shot);
    if (boundedScene) {
      row.scene = "器物摄影工位，木桌与灰墙保留真实纹理，陶杯静置桌面。";
      (row.fields as Row).scene = row.scene;
    }
    return row;
  });
  const pass = vi.fn(async (shots: Row[]) => ({ shots, timing: 0 }));
  const opening = vi.fn(async () => ({ opening: null, timing: 0 }));
  const native = new PromptFusionAgent({ semanticRefinement: false });
  native._callLLM = vi.fn(async () => ({ result: { picks: [] }, degraded: false }));
  native._fuseSingleShotWithDeadline = author;
  native.process = async function recordedProcess(shots: Row[], currentBlueprint: Row, options: Row) {
    const input: ProcessInput = { referencesCurrentBlueprint: shots.every(shot => shot._blueprint === currentBlueprint),
      sourceHashes: shots.map(shot => (shot._workloomSkillPlan as Row).sourceHash), originalKey: options.blueprintHash };
    processInputs.push(input);
    const result = await PromptFusionAgent.prototype.process.call(this, shots, currentBlueprint, options);
    input.effectiveKey = result.checkpointBlueprintHash;
    return result;
  };
  const agents = { promptFusion: native, sceneDesign: { process: pass }, openingDesign: { process: opening },
    visualLanguage: { process: pass }, audioDesign: { process: pass }, continuityReview: { process: pass } };
  const engine = Object.create(ProductionEngine.prototype);
  const logs: Array<{ stage: string; message: string }> = [];
  Object.assign(engine, { agentConfig: { enableLLMAgents: true }, agents, modules: {}, config: { maxPromptLength: 3000 },
    _checkpointDir: directory, _enableResume: true, _checkpointManager: null, logs,
    log(stage: string, message: string) { logs.push({ stage, message }); },
    degradationObserver: { canProceed: () => ({ allowed: true }), _generateReport: () => ({}) },
    contractValidator: { validate: () => ({ valid: true }) },
    shotNormalizer: { buildMood: () => "calm", buildAction: (scene: Row) => scene.action, buildCharacterRef: () => "" },
    ruleFallback: { engineerPromptsFallback: async () => [] },
  });
  const options = { agents, logFn: engine.log.bind(engine), saveCheckpoint: engine._saveCheckpoint.bind(engine),
    canAfford: () => true, budgetRemaining: () => Infinity, checkMemory: () => {},
    cloneShots: engine._cloneShots.bind(engine), mergeShots: engine._mergeShotsByShotId.bind(engine),
    checkpointManager: engine._getCheckpointManager() };
  engine.phase1 = new Phase1SceneDesign(options);
  engine.phase2 = new Phase2VisualAudio(options);
  engine.phase3 = new Phase3PromptFusion(options);
  return { engine, native, author, pass, opening, logs, processInputs };
}

async function completedFusionFixture(directory: string, phase: string) {
  const fixture = productionFixture(directory, true);
  Object.assign(fixture.engine, {
    // This fixture tests completed-checkpoint admission, not field-quality model output.
    phase35: { execute: async (state: Row) => ({ success: true, shots: state.shots }) },
    boundaryGuard: { enforce: (shots: Row[]) => shots },
    // Keep the native checkpoint for the second produce call under the existing cleanup rule.
    qualityGate: { run: async () => ({ passed: false, checks: [] }) },
  });
  const fresh = blueprint();
  const result = await fixture.engine.produce(fresh);
  expect(result.stages.phase3Fusion.status).toBe("passed");
  expect(result.shots.every((shot: Row) => (shot._workloomFusion as Row).blueprintHash === cinematicSkillHash(fresh))).toBe(true);
  if (phase === "phase3.5") {
    // Store only the original host-authored rows and their original stamps through the native writer.
    await fixture.engine._saveCheckpoint(phase, result.shots, { opening: result.opening, llmStats: result.llmStats });
  }
  const checkpoint = resolve(directory, `checkpoint-${phase}.json`);
  return { ...fixture, fresh, checkpoint, originalBytes: readFileSync(checkpoint) };
}

function phase1Fixture(currentBlueprint: Row) {
  const log = vi.fn();
  const phase = new Phase1SceneDesign({
    agents: { sceneDesign: { process: async (shots: Row[]) => ({ shots, timing: 0 }) },
      openingDesign: { process: async () => ({ opening: null, timing: 0 }) } },
    cloneShots: structuredClone, logFn: log, saveCheckpoint: async () => {},
  });
  const state = { shots: [{ shotId: "S1", scene: "陶杯静置木桌。" }],
    result: { stages: {}, llmStats: {} }, adaptedBlueprint: currentBlueprint };
  return { phase, state, log };
}

it.each(["phase1", "phase2"])("reuses the original PF child after real safe serialization and native %s restore", async resumePhase => {
  const directory = mkdtempSync(resolve(tmpdir(), "wl-native-phase2-hydration-"));
  const uninstall = installVendorPhase3FusionBridge();
  try {
    const f = productionFixture(directory);
    const fresh = blueprint();
    await expect(f.engine.produce(fresh)).rejects.toThrow("Phase3 未通过");
    expect(f.author).toHaveBeenCalledTimes(2);
    expect(f.pass).toHaveBeenCalledTimes(4);
    expect(f.opening).toHaveBeenCalledTimes(1);
    const checkpoint = resolve(directory, "checkpoint-phase2.json");
    const before = readFileSync(checkpoint);
    const saved = JSON.parse(before.toString("utf8"));
    expect(saved.phase).toBe("phase2");
    expect(saved.shots.every((shot: Row) => !Object.hasOwn(shot, "_blueprint"))).toBe(true);
    expect(f.processInputs[0]!.referencesCurrentBlueprint).toBe(true);
    const firstKey = f.processInputs[0]!.effectiveKey;
    expect(String(firstKey)).toMatch(/^[a-f0-9]{24}$/u);
    const child = resolve(directory, `checkpoint-phase3-${String(firstKey)}.json`);
    const childBefore = readFileSync(child);
    if (resumePhase === "phase1") rmSync(checkpoint);

    const replayed = blueprint();
    await expect(f.engine.produce(replayed)).rejects.toThrow("Phase3 未通过");
    expect(f.logs.some(row => row.stage === "RESUME" && row.message.includes(`${resumePhase} checkpoint`))).toBe(true);
    expect(f.processInputs[1]!.referencesCurrentBlueprint).toBe(true);
    expect(f.processInputs[1]!.sourceHashes).toEqual(f.processInputs[0]!.sourceHashes);
    expect(f.processInputs[1]!.originalKey).toBe(f.processInputs[0]!.originalKey);
    expect(f.processInputs[1]!.effectiveKey).toBe(firstKey);
    expect(f.author).toHaveBeenCalledTimes(2);
    expect(f.pass).toHaveBeenCalledTimes(resumePhase === "phase1" ? 7 : 4);
    expect(f.opening).toHaveBeenCalledTimes(1);
    if (resumePhase === "phase2") expect(readFileSync(checkpoint)).toEqual(before);
    expect(readFileSync(child)).toEqual(childBefore);
    for (const key of ["genre", "mood", "theme", "targetAudience", "description", "filmDirector", "filmDirectorSource"]) {
      expect(replayed[key]).toEqual(fresh[key]);
    }
  } finally { uninstall(); rmSync(directory, { recursive: true, force: true }); }
});

it("preserves already provided business context and director provenance in the real Phase1 caller", async () => {
  const provided = { genre: "记录影像", mood: "自定义情绪", theme: "既定主题", targetAudience: "既定受众",
    description: "既定说明", filmDirector: "已提供导演", filmDirectorSource: "provided-source", director: "NOLAN" };
  const current: Row = { ...blueprint(), ...provided };
  const f = phase1Fixture(current);
  expect((await f.phase.execute(f.state)).success).toBe(true);
  for (const [key, value] of Object.entries(provided)) expect(current[key]).toBe(value);
});

it.each(["phase3", "phase3.5"])("verifies the original full-blueprint stamp after completed native %s restore", async phase => {
  const directory = mkdtempSync(resolve(tmpdir(), "wl-completed-fusion-context-"));
  const uninstall = installVendorPhase3FusionBridge();
  try {
    const fixture = await completedFusionFixture(directory, phase);
    const saved = JSON.parse(fixture.originalBytes.toString("utf8"));
    expect(saved.phase).toBe(phase);
    expect(saved.shots.every((shot: Row) => !Object.hasOwn(shot, "_blueprint"))).toBe(true);
    const authorCalls = fixture.author.mock.calls.length;
    const replayed = blueprint();
    const restored = await fixture.engine.produce(replayed);
    expect(restored.resumed).toBe(true);
    expect(restored.stages.phase3Fusion).toMatchObject({ status: "passed", resumed: true });
    expect(cinematicSkillHash(replayed)).toBe(cinematicSkillHash(fixture.fresh));
    expect(restored.shots.map((shot: Row) => shot._workloomFusion)).toEqual(saved.shots.map((shot: Row) => shot._workloomFusion));
    expect(restored.shots.every((shot: Row) => !Object.hasOwn(shot, "_blueprint"))).toBe(true);
    expect(fixture.logs.some(row => row.stage === "RESUME" && row.message.includes(`${phase} checkpoint`))).toBe(true);
    expect(fixture.author).toHaveBeenCalledTimes(authorCalls);
    expect(fixture.processInputs).toHaveLength(1);
    expect(readFileSync(fixture.checkpoint)).toEqual(fixture.originalBytes);
  } finally { uninstall(); rmSync(directory, { recursive: true, force: true }); }
});

it.each(["phase3", "phase3.5"])("still rejects changed business context against original native %s stamps", async phase => {
  const directory = mkdtempSync(resolve(tmpdir(), "wl-completed-fusion-context-change-"));
  const uninstall = installVendorPhase3FusionBridge();
  try {
    const fixture = await completedFusionFixture(directory, phase);
    const authorCalls = fixture.author.mock.calls.length;
    const replayed = blueprint();
    (replayed._creativeTheme as Row).description = "业务说明已改为观察另一种器物，不得复用原融合凭据。";
    await expect(fixture.engine.produce(replayed)).rejects.toThrow("PHASE3_FUSION_UNVERIFIED");
    expect(fixture.logs.some(row => row.stage === "RESUME" && row.message.includes(`${phase} checkpoint`))).toBe(true);
    expect(fixture.author).toHaveBeenCalledTimes(authorCalls);
    expect(fixture.processInputs).toHaveLength(1);
    expect(readFileSync(fixture.checkpoint)).toEqual(fixture.originalBytes);
  } finally { uninstall(); rmSync(directory, { recursive: true, force: true }); }
});

it("keeps style selection failure nonblocking and records the original error", async () => {
  const selector = vi.spyOn(router, "assignFilmDirector").mockImplementationOnce(() => { throw new Error("style fixture unavailable"); });
  try {
    const current = blueprint();
    const f = phase1Fixture(current);
    expect((await f.phase.execute(f.state)).success).toBe(true);
    expect(current.genre).toBe("纪录片");
    expect(current.mood).toBe("平静观察");
    expect(current).not.toHaveProperty("filmDirector");
    expect(f.log.mock.calls.some(args => args.some(value => String(value).includes("style fixture unavailable")))).toBe(true);
  } finally { selector.mockRestore(); }
});
