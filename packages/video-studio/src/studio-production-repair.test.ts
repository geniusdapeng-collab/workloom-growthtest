import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expect, it, vi } from "vitest";
import { videoRuntimeRoot } from "./runtime-root.js";

const root = videoRuntimeRoot(import.meta.url);
const require = createRequire(import.meta.url);
const { ProductionEngine } = require(resolve(root,
  "vendor/supermickey/hyperreality-system/engines/production-engine/production-engine.js"));
const { PromptFusionAgent } = require(resolve(root,
  "vendor/supermickey/hyperreality-system/engines/production-engine/agents/prompt-fusion-agent.js"));
const feedback = '已核实的晚期 FACT 拒绝：S1 的“无来源认证100%”不受原文支持。原坏镜头：无来源认证100%。原始合同：陶杯静置木桌，杯沿反光；不作性能或认证声明。删除无来源认证，按原合同重写。HOST_DIAG_END_42';

it("keeps approved upstream native stations cached while a diagnosed production repair reaches the actual PromptFusion author", () => {
  const directory = mkdtempSync(join(tmpdir(), "wl-production-repair-entry-"));
  const file = join(directory, "entry.mts");
  writeFileSync(file, `
import { createRequire } from "node:module";
import { VideoStudio } from ${JSON.stringify(resolve(root, "packages/video-studio/src/studio.ts"))};
import { WorkloomLLMEngine } from ${JSON.stringify(resolve(root, "packages/video-studio/src/llm-adapter.ts"))};
const require = createRequire(${JSON.stringify(join(root, "package.json"))});
const entry = require("./vendor/supermickey/hyperreality-system/index.js");
const { PromptFusionAgent } = require("./vendor/supermickey/hyperreality-system/engines/production-engine/agents/prompt-fusion-agent.js");
const Original = entry.HyperrealitySystem;
const feedback = ${JSON.stringify(feedback)};
const calls = [], gates = [], documents = [], records = new Map(), authorInputs = [], upstreamInputs = [], checkpointRequests = [];
const key = request => [request.stage, request.inputSha256, request.dependencySha256].join("/");
const checkpoints = { load: async request => { checkpointRequests.push(request); return records.get(key(request)) ?? null; },
 save: async checkpoint => { records.set(key(checkpoint), structuredClone(checkpoint)); } };
class NativeBoundaryFixture {
 creativeThemeGenerator = { generate: async intent => { calls.push("G2_THEME"); upstreamInputs.push(intent); return { tasks: [{ theme: intent }] }; } };
 requirementDiscoveryEngine = { discover: async theme => { calls.push("G3_INSIGHT"); upstreamInputs.push(JSON.stringify(theme)); return { theme, confirmationStatus: { timestamp: "2026-11-04T00:00:00.000Z" } }; } };
 async _convertDiscoveryToRequirementList(discovery) { calls.push("G3_PROFILE"); upstreamInputs.push(JSON.stringify(discovery)); return { profile: "原画像" }; }
 prdGenerator = { generate: async discovery => { calls.push("G4_PRD"); upstreamInputs.push(JSON.stringify(discovery)); return { discovery, shotCount: 1 }; } };
 scriptEngine = { process: async (intent, metadata) => { calls.push("SCRIPT"); upstreamInputs.push(JSON.stringify({ intent, metadata })); return { adapted: { title: "陶杯", scenes: [{ scene_id: "S1" }], config: { aspectRatio: "9:16" }, _originalStoryText: "陶杯静置木桌，杯沿反光；不作性能或认证声明。" } }; } };
 productionEngine = { produce: async blueprint => {
  calls.push("PRODUCTION");
  const agent = new PromptFusionAgent({ semanticRefinement: false });
  agent.consistencyChecker = { check: () => ({ valid: true, warningCount: 0 }) };
  agent._callLLM = async (prompt, schema) => {
   authorInputs.push({ hasDiagnosis: prompt.includes(feedback), hasTail: prompt.includes("HOST_DIAG_END_42") });
   if (prompt.includes("镜头补齐任务")) return { degraded: false, result: { fields: {} } };
   const fields = Object.fromEntries(["director_instruction","constraint","baseline","scene","lighting","composition","color_palette","depth_of_field","camera_movement","character","costume","makeup","action","props","portraits","dialogue","timeline","mood","pacing","transition","audio","negative","bright_constraint","character_constraint","consistency"]
    .map(name => [name, name === "scene" ? (prompt.includes("HOST_DIAG_END_42") ? "陶杯静置木桌，杯沿反光" : "无来源认证100%") : "实拍"]));
   return { degraded: false, result: { shots: [{ shotId: "S1", fields }] } };
  };
  const result = await agent.process([{ shotId: "S1", sceneType: "transition", scene: "陶杯静置木桌", duration: 6, _blueprint: blueprint }], blueprint);
  return { success: true, shots: result.shots };
 } };
 async _optimizeOpeningTitle(production) { calls.push("OPENING_TITLE"); production.shots[0].prompt += "，原生片头"; }
 async create(intent, metadata) {
  const approve = (type, content) => globalThis.__HR_CONFIRMATION_HANDLER__({ type, content, runId: "native-fixture" });
  const theme = await this.creativeThemeGenerator.generate(intent);
  await approve("creative-theme", JSON.stringify(theme));
  const discovery = await this.requirementDiscoveryEngine.discover(theme);
  metadata.profile = (await this._convertDiscoveryToRequirementList(discovery)).profile;
  await approve("requirement-list", JSON.stringify(discovery));
  const prd = await this.prdGenerator.generate(discovery);
  await approve("prd", JSON.stringify(prd));
  const script = await this.scriptEngine.process(intent, metadata);
  const production = await this.productionEngine.produce(script.adapted);
  const privateFieldRetained = Object.hasOwn(script.adapted, "_workloomProductionRepairFeedback");
  await this._optimizeOpeningTitle(production, { stages: {} }, metadata);
  const verdict = await approve("prompt", Original.prototype._generatePromptsReport.call(Original.prototype, production.shots));
  return { success: verdict.approved, stages: {}, prompt: production.shots[0].prompt, privateFieldRetained };
 }
}
entry.HyperrealitySystem = NativeBoundaryFixture;
try {
 const outputs = [];
 for (const diagnosis of [undefined, feedback, feedback]) {
  const studio = new VideoStudio({ llm: new WorkloomLLMEngine({ baseUrl: "https://offline.invalid", apiKey: "test-only", model: "deepseek-flash" }),
   workDir: ${JSON.stringify(join(directory, "work"))}, checkpoints, productionRepairFeedback: diagnosis,
   onApproval: async request => { gates.push(request.gate); documents.push(request.contentMd); return { approved: request.gate !== "G6_PROMPT" || !request.contentMd.includes("无来源认证") }; }, log: () => {} });
  outputs.push(await studio.runPreproduction({ projectId: "same-project", intent: "陶杯静置木桌，杯沿反光。", metadata: {} }));
 }
 console.log("RESULT " + JSON.stringify({ calls, gates, documents, outputs, authorInputs, upstreamInputs, checkpointRequests }));
} finally { entry.HyperrealitySystem = Original; }
`);
  try {
    const output = execFileSync(process.execPath, [resolve(root, "node_modules/tsx/dist/cli.mjs"), file], {
      cwd: root, encoding: "utf8", timeout: 30_000, maxBuffer: 3_000_000,
    });
    const line = output.split("\n").find(value => value.startsWith("RESULT "));
    const result = JSON.parse(line!.slice(7));
    expect(result.calls).toEqual(["G2_THEME", "G3_INSIGHT", "G3_PROFILE", "G4_PRD", "SCRIPT", "PRODUCTION", "OPENING_TITLE", "PRODUCTION", "OPENING_TITLE"]);
    expect(result.outputs.map((value: { success: boolean }) => value.success)).toEqual([false, true, true]);
    expect(result.outputs[0].prompt).toContain("无来源认证");
    expect(result.outputs[1].prompt).toContain("陶杯静置木桌");
    expect(result.outputs[1].prompt).not.toContain("无来源认证");
    expect(result.outputs[1].prompt).not.toContain("HOST_DIAG_END_42");
    expect(result.outputs[2].prompt).toBe(result.outputs[1].prompt);
    expect(result.outputs.every((value: { privateFieldRetained: boolean }) => !value.privateFieldRetained)).toBe(true);
    expect(result.authorInputs.slice(0, 2).every((value: { hasDiagnosis: boolean }) => !value.hasDiagnosis)).toBe(true);
    expect(result.authorInputs.slice(2).every((value: { hasDiagnosis: boolean; hasTail: boolean }) => value.hasDiagnosis && value.hasTail)).toBe(true);
    expect(JSON.stringify(result.upstreamInputs)).not.toContain("HOST_DIAG_END_42");
    expect(result.gates).toEqual(Array.from({ length: 3 }, () => ["G2_THEME", "G3_INSIGHT", "G4_PRD", "G6_PROMPT"]).flat());
    expect(result.documents.slice(0, 3)).toEqual(result.documents.slice(4, 7));
    expect(result.documents.slice(4, 7)).toEqual(result.documents.slice(8, 11));
    const requests = result.checkpointRequests.filter((value: { stage: string }) => value.stage === "PRODUCTION");
    expect(requests[0].inputSha256).not.toBe(requests[1].inputSha256);
    expect(requests[1].inputSha256).toBe(requests[2].inputSha256);
    expect(requests[0].dependencySha256).toBe(requests[1].dependencySha256);
  } finally { rmSync(directory, { recursive: true, force: true }); }
}, 35_000);

it("includes the complete private diagnosis in the native author prompt without truncation", () => {
  const agent = new PromptFusionAgent({ semanticRefinement: false });
  const complete = `${"已核实诊断𠮷".repeat(3000)}诊断末尾`;
  const prompt = agent._buildDirectorContext([{ shotId: "S1" }], { _workloomProductionRepairFeedback: complete });
  expect(prompt.includes(complete)).toBe(true);
});

it("keeps the verified diagnosis available to the final semantic author without copying it into the work", async () => {
  const agent = new PromptFusionAgent();
  const calls: string[] = [];
  const prompt = "【场景】陶杯静置木桌，杯沿反光。";
  agent._callLLM = vi.fn(async (input: string) => {
    calls.push(input);
    return { result: { prompt, actions: [] } };
  });
  const output = await agent._finalizeShotResult({ shotId: "S1", duration: 6 }, { prompt },
    { _workloomProductionRepairFeedback: feedback });
  expect(calls).toHaveLength(1);
  expect(calls[0]).toContain(feedback);
  expect(output.prompt).toBe(prompt);
  expect(output.prompt).not.toContain("HOST_DIAG_END_42");
});

it.each([false, true])("native phase resume includes diagnosis=%s while preserving ordinary infrastructure recovery", async repair => {
  const directory = mkdtempSync(join(tmpdir(), "wl-production-repair-phase-"));
  try {
    const engine = Object.create(ProductionEngine.prototype);
    const scenes = [{ scene_id: "S1" }];
    const oldHash = createHash("md5").update(JSON.stringify(scenes)).digest("hex").slice(0, 8);
    writeFileSync(join(directory, "checkpoint-phase3.5.json"), JSON.stringify({ phase: "phase3.5", shots: [{ shotId: "S1", prompt: "旧原生产物" }], blueprintFingerprint: { hash: oldHash } }));
    Object.assign(engine, { agentConfig: { enableLLMAgents: true }, agents: {}, _checkpointDir: directory, _enableResume: true,
      logs: [], log() {}, degradationObserver: { canProceed: () => ({ allowed: true }), _generateReport: () => ({}) },
      contractValidator: { validate: () => ({ valid: true }) }, boundaryGuard: { enforce: (shots: unknown) => shots },
      qualityGate: { run: () => ({ passed: true }) }, _finalIntegrityCheck: () => ({ valid: true }), _buildMeta: () => ({}),
      _extractScenes: () => ({ shots: [{ shotId: "S1", duration: 6 }] }), _allocateDuration: (shots: unknown) => ({ shots }) });
    const phases: string[] = [];
    for (const name of ["phase1", "phase2", "phase3", "phase35"]) engine[name] = { execute: async () => {
      phases.push(name); return { success: true, shots: [{ shotId: "S1", prompt: "按诊断改正的新原生产物", duration: 6 }] };
    } };
    const result = await engine.produce({ scenes, ...(repair ? { _workloomProductionRepairFeedback: feedback } : {}) });
    expect(result.shots[0].prompt).toBe(repair ? "按诊断改正的新原生产物" : "旧原生产物");
    expect(phases).toEqual(repair ? ["phase1", "phase2", "phase3", "phase35"] : []);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

it.each([false, true])("native shot resume includes diagnosis=%s while preserving ordinary infrastructure recovery", async repair => {
  const directory = mkdtempSync(join(tmpdir(), "wl-production-repair-shot-"));
  try {
    writeFileSync(join(directory, "checkpoint-phase3-same-blueprint.json"), JSON.stringify({ blueprintHash: "same-blueprint", completed: 1, total: 1, results: [{ shotId: "S1", prompt: "旧原生镜头" }] }));
    const agent = Object.create(PromptFusionAgent.prototype);
    agent._fuseSingleShotWithDeadline = vi.fn(async () => ({ shotId: "S1", prompt: "按诊断改正的新原生镜头" }));
    const result = await agent.process([{ shotId: "S1", duration: 6 }], { config: {}, ...(repair ? { _workloomProductionRepairFeedback: feedback } : {}) },
      { checkpointManager: { baseDir: directory }, blueprintHash: "same-blueprint" });
    expect(result.shots[0].prompt).toBe(repair ? "按诊断改正的新原生镜头" : "旧原生镜头");
    expect(agent._fuseSingleShotWithDeadline).toHaveBeenCalledTimes(repair ? 1 : 0);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
