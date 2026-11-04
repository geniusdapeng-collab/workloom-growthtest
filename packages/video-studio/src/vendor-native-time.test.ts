import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const require = createRequire(import.meta.url);
const vendor = (file: string) => require(resolve(root, "vendor/supermickey/hyperreality-system", file));
const { RequirementDiscoveryEngine } = vendor("engines/requirement-discovery-engine.js");
const { PRDGenerator } = vendor("engines/prd-generator/prd-generator.js");
const { ProductionEngine } = vendor("engines/production-engine/production-engine.js");
const { PromptFusionAgent } = vendor("engines/production-engine/agents/prompt-fusion-agent.js");
const { ContinuityReviewAgent } = vendor("engines/production-engine/agents/continuity-review-agent.js");
const { BaseAgent } = vendor("engines/production-engine/agents/base-agent.js");
const { HealthMonitor } = vendor("shields/health-monitor/health-monitor.js");
const { Phase3PromptFusion } = vendor("engines/production-engine/phases/phase-3-prompt-fusion.js");

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

function createObservation(): Record<string, any>[] {
  const source = `
const root = ${JSON.stringify(root)};
const { HyperrealitySystem } = require(root + '/vendor/supermickey/hyperreality-system/index.js');
const { RequirementDiscoveryEngine } = require(root + '/vendor/supermickey/hyperreality-system/engines/requirement-discovery-engine.js');
const { RequirementListBuilder } = require(root + '/vendor/supermickey/hyperreality-system/engines/script-engine/core/requirement-list-builder.js');
const { CreativeIntensityEngine } = require(root + '/vendor/supermickey/hyperreality-system/engines/script-engine/core/creative-intensity-engine.js');
const coordinator = require(root + '/vendor/supermickey/scripts/run-coordinator.js');
coordinator.acquireLock = () => ({ acquired: true });
coordinator.startRun = () => 'offline-time-test';
coordinator.finishRun = () => {};
coordinator.releaseLock = () => {};
process.env.STORMAXE_TOTAL_DEADLINE_MS = '1';
process.env.STORMAXE_RENDER_RESERVE_MS = '999999999';
let time = Date.now();
Date.now = () => time;
const observations = [];
(async () => {
 for (const kind of ['narrative', 'marketing']) {
  const system = Object.create(HyperrealitySystem.prototype);
  const observation = { kind, modelEnabled: null, finiteDeadline: null, productionCalls: 0, shieldCalls: [] };
  const llm = { reasonStructured: async () => ({ success: true, data: {
   genre: '展台纪实', profile: { narrative_mode: 'documentary', dialogue_density: 'none', duration_target: 30, aspect_ratio: '9:16' }
  } }) };
  system.options = { llmEngine: llm };
  system.stabilityShield = {
   setLongTaskMode: (_id, enabled, timeout) => observation.shieldCalls.push({ enabled, unlimited: timeout === Infinity }),
   baselineRegistry: { findBestMatch: () => ({ isHotStart: false }) }
  };
  system.requirementAlignmentGate = { enabled: false };
  system.pipelineLogger = { enabled: false };
  system.pandaAdapter = { enabled: false };
  system.emotionIntentParser = { enabled: false };
  system.emotionArcDesigner = { enabled: false };
  system.narrativeRhythmAdapter = { enabled: false };
  system.creativeIntensityEngine = new CreativeIntensityEngine();
  system.creativeRecommender = { recommend: () => ({ intensity: 0.4 }) };
  system.requirementListBuilder = new RequirementListBuilder();
  system.requirementDiscoveryEngine = new RequirementDiscoveryEngine();
  for (const agent of Object.values(system.requirementDiscoveryEngine.agents)) agent._callLLM = async input => agent._fallback(input);
  system.creativeThemeGenerator = {
   generate: async () => {
    time += 8 * 60 * 60 * 1000;
    return { tasks: [{ type: '展台纪实', theme: '灯光亮起', description: '展台灯光依次亮起，最后定格。', duration_sec: 30, visual_style: '写实', creative_style: 0.4 }] };
   },
   generateConfirmationSummary: () => '创意主题确认'
  };
  system._waitForExternalConfirmation = async () => ({ approved: true, waitTimeMs: 0 });
  system.prdGenerator = {
   generate: async discovery => system._generateMinimalPRD(discovery),
   generateMarkdown: () => 'PRD确认'
  };
  system.scriptEngine = { process: async () => ({
   adapted: { scenes: [{ scene_id: 'S1' }], config: {} },
   blueprint: { meta: {} }, report: { scenes_count: 1, characters_count: 0, dialogues_count: 0 },
   validation: { passed: true, overall_score: 100 }
  }) };
  system.productionEngine = {
   updateAgentConfig: config => {
    observation.modelEnabled = config.enableLLMAgents !== false;
    observation.finiteDeadline = Number.isFinite(config.totalDeadlineMs);
   },
   produce: async () => { observation.productionCalls++; throw new Error('OFFLINE_PRODUCTION_BOUNDARY'); }
  };
  const result = await system.create('展台灯光依次亮起，最后定格。', {
   title: '灯光亮起', pipelineRoute: { kind }, brief: { duration: 30, aspectRatio: '9:16', platform: 'douyin' }
  }, { skipRender: true, skipPostProduction: true });
  observation.taskDeadlineCleared = system._globalDeadline === null;
  observation.boundaryReached = result.errors.some(error => error.message === 'OFFLINE_PRODUCTION_BOUNDARY');
  observation.lockReleased = system._activeRun === null;
  observations.push(observation);
 }
 console.log('RESULT ' + JSON.stringify(observations));
})().catch(error => { console.error(error); process.exitCode = 1; });
`;
  const output = execFileSync(process.execPath, ["-e", source], {
    cwd: root, encoding: "utf8", timeout: 30_000, maxBuffer: 2_000_000,
  });
  const line = output.split("\n").find(value => value.startsWith("RESULT "));
  if (!line) throw new Error(`Missing native time observation. ${output.slice(-2000)}`);
  return JSON.parse(line.slice(7));
}

describe("native preproduction continues independently of elapsed task time", () => {
  it("keeps model production available after eight hours for both routes despite legacy time environment values", () => {
    expect(createObservation()).toEqual(["narrative", "marketing"].map(kind => ({
      kind,
      modelEnabled: true,
      finiteDeadline: false,
      productionCalls: 1,
      shieldCalls: [{ enabled: true, unlimited: true }, { enabled: false, unlimited: false }],
      taskDeadlineCleared: true,
      boundaryReached: true,
      lockReleased: true,
    })));
  });

  it("runs every discovery agent after the previous total time allowance has elapsed", async () => {
    let time = 1_000_000;
    vi.spyOn(Date, "now").mockImplementation(() => (time += 60 * 60 * 1000));
    const engine = new RequirementDiscoveryEngine({ timeoutMs: 1, agentTimeoutMs: 180_000 });
    const input = { type: "商业广告", theme: "灯光亮起", duration_sec: 30 };
    const calls: string[] = [];
    for (const [role, agent] of Object.entries<any>(engine.agents)) {
      agent.run = async () => { calls.push(role); return agent._fallback(input); };
    }
    await engine.discover(input);
    expect(calls).toEqual(["audience", "scene", "risk", "reference"]);
    expect(Object.values<any>(engine.agents).map(agent => agent.timeoutMs)).toEqual([180_000, 180_000, 180_000, 180_000]);
  });

  it("clears a previous deadline and reaches every production phase after hours of work", async () => {
    let time = 1_000_000;
    vi.spyOn(Date, "now").mockImplementation(() => time);
    const engine = Object.create(ProductionEngine.prototype);
    const phases: Array<{ phase: string; unlimited: boolean }> = [];
    const agents = ["scene", "visual", "fusion"].map(() => ({ setDeadline: vi.fn() }));
    engine.agentConfig = { enableLLMAgents: true, totalDeadlineMs: 1 };
    engine._globalDeadline = time - 1;
    engine.agents = Object.fromEntries(agents.map((agent, index) => [index, agent]));
    engine.logs = [];
    engine.log = vi.fn();
    engine.degradationObserver = { canProceed: () => ({ allowed: true }), _generateReport: () => ({}) };
    engine.contractValidator = { validate: () => ({ valid: true }) };
    engine._extractScenes = () => ({ shots: [{ shotId: "S1", scene: "展台", duration: 5 }] });
    engine._allocateDuration = (shots: unknown[]) => ({ shots });
    engine._loadLatestCheckpoint = () => null;
    engine._clearCheckpoints = () => {};
    engine._buildMeta = () => ({});
    engine._finalIntegrityCheck = () => ({ valid: true });
    engine.boundaryGuard = { enforce: (shots: unknown[]) => shots };
    engine.qualityGate = { run: () => ({ passed: true }) };
    engine.ruleFallback = { engineerPromptsFallback: vi.fn(() => { throw new Error("UNEXPECTED_RULE_FALLBACK"); }) };
    for (const phase of ["phase1", "phase2", "phase3", "phase35"]) {
      engine[phase] = {
        globalDeadline: time - 1,
        fieldQualityPipeline: { setDeadline: vi.fn() },
        execute: async ({ shots }: { shots: unknown[] }) => {
          time += 4 * 60 * 60 * 1000;
          phases.push({ phase, unlimited: engine._budgetRemaining() === Infinity });
          return { success: true, shots };
        },
      };
    }
    const result = await engine.produce({ scenes: [{ scene_id: "S1" }], config: {} });
    expect(result.success).toBe(true);
    expect(phases).toEqual(["phase1", "phase2", "phase3", "phase35"].map(phase => ({ phase, unlimited: true })));
    expect(engine._globalDeadline).toBeNull();
    for (const agent of agents) expect(agent.setDeadline).toHaveBeenCalledWith(null);
    expect(engine.phase35.globalDeadline).toBeNull();
    expect(engine.phase35.fieldQualityPipeline.setDeadline).toHaveBeenCalledWith(null);
    expect(engine.ruleFallback.engineerPromptsFallback).not.toHaveBeenCalled();
  });

  it("waits for the complete PRD agents while each replacement request keeps its own timeout", async () => {
    vi.useFakeTimers();
    const discovery = new RequirementDiscoveryEngine()._fastMode({ type: "商业广告", theme: "灯光亮起", duration_sec: 30 });
    const generator = new PRDGenerator({ timeoutMs: 1, agent2TimeoutMs: 120_000, agent3TimeoutMs: 180_000 });
    const creative = generator.agent2.fallback(discovery);
    creative.creativeCore.coreTheme = "两次请求之后的真实创意";
    const production = generator.agent3.fallback(discovery, creative);
    production.visualSpecification.primaryStyle = "两次请求之后的真实规格";
    generator.agent2.process = async () => {
      await new Promise(resolve => setTimeout(resolve, 100_000));
      await new Promise(resolve => setTimeout(resolve, 100_000));
      return creative;
    };
    generator.agent3.process = async () => {
      await new Promise(resolve => setTimeout(resolve, 150_000));
      await new Promise(resolve => setTimeout(resolve, 150_000));
      return production;
    };
    const creativeFallback = vi.spyOn(generator.agent2, "fallback");
    const productionFallback = vi.spyOn(generator.agent3, "fallback");
    const running = generator.generate(discovery);
    await vi.advanceTimersByTimeAsync(500_000);
    const result = await running;
    expect(result.creativeCore.coreTheme).toBe(creative.creativeCore.coreTheme);
    expect(result.visualSpecification.primaryStyle).toBe(production.visualSpecification.primaryStyle);
    expect(creativeFallback).not.toHaveBeenCalled();
    expect(productionFallback).not.toHaveBeenCalled();
    expect(generator.agent2.timeoutMs).toBe(120_000);
    expect(generator.agent3.timeoutMs).toBe(180_000);
  });

  it("allows a shot model request and field completion with an expired legacy shot deadline", async () => {
    const agent = Object.create(PromptFusionAgent.prototype);
    agent._fuseSingleShot = vi.fn(async () => ({ shotId: "S1", prompt: "已生成" }));
    const shot = { shotId: "S1", sceneType: "transition", duration: 5 };
    const expired = Date.now() - 60 * 60 * 1000;
    await expect(agent._fuseSingleShotWithDeadline(shot, "9:16", [], {}, expired)).resolves.toEqual({ shotId: "S1", prompt: "已生成" });
    expect(agent._fuseSingleShot).toHaveBeenCalledWith(shot, "9:16", [], {});
    agent._extractFieldsFromShot = () => ({});
    agent._ensureFieldCompleteness = vi.fn(async () => ({ fields: {} }));
    agent._buildShotResult = () => ({ prompt: "补全步骤已执行" });
    await expect(agent._fillMissingFieldsWithRetry(shot, "9:16", [], expired)).resolves.toEqual({ prompt: "补全步骤已执行" });
    expect(agent._ensureFieldCompleteness).toHaveBeenCalledTimes(2);
  });

  it("keeps the native fusion phase and its retry settings available without an elapsed-time fast mode", async () => {
    const fs = require("node:fs");
    vi.spyOn(fs, "mkdirSync").mockReturnValue(undefined);
    vi.spyOn(fs, "appendFileSync").mockReturnValue(undefined);
    const model = {
      llmMaxRetries: 4,
      process: vi.fn(async (shots: unknown[]) => ({ shots, timing: 1 })),
      _callLLM: async () => ({ result: null }),
    };
    const monitor = { setLongTaskMode: vi.fn() };
    const phase = new Phase3PromptFusion({
      agents: { promptFusion: model },
      logFn: () => {},
      healthMonitor: monitor,
      budgetRemaining: () => 350_000,
      canAfford: () => false,
      cloneShots: (shots: unknown[]) => shots,
      mergeShots: (_before: unknown[], after: unknown[]) => after,
      saveCheckpoint: async () => {},
    });
    phase._checkDialogueTiming = async (shots: unknown[]) => shots;
    const response = await phase.execute({
      shots: [{ shotId: "S1", duration: 5, scene: "展台" }],
      result: { stages: {}, llmStats: {} },
      adaptedBlueprint: { config: {}, scenes: [{ scene_id: "S1" }] },
    });
    expect(response.success).toBe(true);
    expect(model.process).toHaveBeenCalledTimes(1);
    expect(model.llmMaxRetries).toBe(4);
    expect(monitor.setLongTaskMode).not.toHaveBeenCalled();
  });

  it("waits for continuity's multiple requests beyond the previous four minute race", async () => {
    vi.useFakeTimers();
    const agent = Object.create(ContinuityReviewAgent.prototype);
    agent.llmTimeout = 180_000;
    agent._processCore = async () => {
      await new Promise(resolve => setTimeout(resolve, 9 * 60 * 1000));
      return { review: { summary: "多个请求已完成" }, degraded: false };
    };
    let settled = false;
    const running = agent.process([], {}).then((value: unknown) => { settled = true; return value; });
    await vi.advanceTimersByTimeAsync(4 * 60 * 1000 + 1);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(5 * 60 * 1000);
    await expect(running).resolves.toEqual({ review: { summary: "多个请求已完成" }, degraded: false });
  });

  it("keeps the health monitor active after a day and stops its heartbeat on task exit", async () => {
    vi.useFakeTimers();
    vi.spyOn(console, "log").mockImplementation(() => {});
    const monitor = new HealthMonitor();
    const restart = vi.spyOn(monitor, "_handleDeadAgent");
    monitor.registerAgent("ProductionEngine", {});
    try {
      monitor.setLongTaskMode("ProductionEngine", true, Infinity);
      vi.setSystemTime(Date.now() + 24 * 60 * 60 * 1000);
      await vi.advanceTimersByTimeAsync(10_000);
      monitor._checkAllAgents();
      expect(restart).not.toHaveBeenCalled();
      expect(monitor.getHealthStatus("ProductionEngine").status).toBe("healthy");
      monitor.setLongTaskMode("ProductionEngine", false);
      expect(monitor.agents.get("ProductionEngine")._keepAliveTimer).toBeNull();
    } finally {
      monitor.stop();
    }
  });

  it("retains the timeout for one physical model request", async () => {
    vi.useFakeTimers();
    const agent = Object.create(BaseAgent.prototype);
    const running = agent._callWithTimeout(new Promise(() => {}), 30, "offline-request");
    const assertion = expect(running).rejects.toThrow("offline-request超时(30ms)");
    await vi.advanceTimersByTimeAsync(30);
    await assertion;
  });
});
