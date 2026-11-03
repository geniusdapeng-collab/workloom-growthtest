import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
type Scenario = "approval-error" | "model-error" | "rejected" | "approved" | "parallel-preview";

function probe(scenario: Scenario): Record<string, any> {
  const directory = mkdtempSync(join(tmpdir(), "wl-prd-gate-"));
  const script = join(directory, "probe.mts");
  writeFileSync(script, `
import { createRequire } from 'node:module';
import { VideoStudio } from ${JSON.stringify(resolve(root, "packages/video-studio/src/studio.ts"))};
import { listSharedBridges } from ${JSON.stringify(resolve(root, "packages/video-studio/src/vendor-compat.ts"))};
const require = createRequire(${JSON.stringify(resolve(root, "package.json"))});
const systemMod = require('./vendor/supermickey/hyperreality-system/index.js');
const OriginalSystem = systemMod.HyperrealitySystem;
const originalMinimalPrd = OriginalSystem.prototype._generateMinimalPRD;
const { RequirementDiscoveryEngine } = require('./vendor/supermickey/hyperreality-system/engines/requirement-discovery-engine.js');
const { RequirementListBuilder } = require('./vendor/supermickey/hyperreality-system/engines/script-engine/core/requirement-list-builder.js');
const { CreativeIntensityEngine } = require('./vendor/supermickey/hyperreality-system/engines/script-engine/core/creative-intensity-engine.js');
const coordinator = require('./vendor/supermickey/scripts/run-coordinator.js');
coordinator.acquireLock = () => ({ acquired: true });
coordinator.startRun = () => 'probe-run';
coordinator.finishRun = () => {};
coordinator.releaseLock = () => {};
const scenario = ${JSON.stringify(scenario)};
const llm = { model: 'offline-fixture', fastModel: 'offline-fixture', reasonStructured: async () => ({ success: true,
 data: { genre: '展台纪实', profile: { narrative_mode: 'documentary', dialogue_density: 'none', duration_target: 30, aspect_ratio: '9:16' } } }) };
function fixture(modelError = false) {
 const system = Object.create(OriginalSystem.prototype);
 const counts = { script: 0, result: null };
 const originalCreate = OriginalSystem.prototype.create;
 system.create = async (...args) => { counts.result = await originalCreate.apply(system, args); return counts.result; };
 system.options = { llmEngine: llm };
 system.stabilityShield = { setLongTaskMode: () => {}, baselineRegistry: { findBestMatch: () => ({ isHotStart: false }) } };
 system.requirementAlignmentGate = { enabled: false };
 system.pipelineLogger = { enabled: false };
 system.pandaAdapter = { enabled: false };
 system.emotionIntentParser = { enabled: false };
 system.creativeIntensityEngine = new CreativeIntensityEngine();
 system.creativeRecommender = { recommend: () => ({ intensity: 0.4 }) };
 system.requirementListBuilder = new RequirementListBuilder();
 system.requirementDiscoveryEngine = new RequirementDiscoveryEngine();
 for (const agent of Object.values(system.requirementDiscoveryEngine.agents)) agent._callLLM = async input => agent._fallback(input);
 system.creativeThemeGenerator = {
  generate: async () => ({ tasks: [{ type: '展台纪实', theme: '灯光亮起', description: '展台灯光依次亮起，最后定格。', duration_sec: 30, visual_style: '写实', dialogue_requirement: '无台词，纯画面', creative_style: 0.4 }] }),
  generateConfirmationSummary: () => '创意主题确认'
 };
 system.prdGenerator = {
  generate: async discovery => {
   if (modelError) throw new Error('PRD_MODEL_UNAVAILABLE');
   // A deterministic model response; do not invoke the runtime fallback guard.
   return originalMinimalPrd.call(system, discovery);
  },
  generateMarkdown: () => 'PRD待审批'
 };
 system.scriptEngine = { process: async () => { counts.script++; throw new Error('PROBE_SCRIPT_BOUNDARY_REACHED'); } };
 return { system, counts };
}
const host = fixture(scenario === 'model-error');
// Replace only constructor bootstrapping (background engines / disk state).
// VideoStudio and the original vendor create/convert/confirm/fallback execute.
function FixtureSystem() { return host.system; }
FixtureSystem.prototype = OriginalSystem.prototype;
systemMod.HyperrealitySystem = FixtureSystem;
const gates = [];
const events = [];
let started;
let release;
const atG4 = new Promise(resolve => { started = resolve; });
const heldG4 = new Promise(resolve => { release = resolve; });
const studio = new VideoStudio({ llm, workDir: ${JSON.stringify(directory)}, deferRender: true, portraits: { enabled: false }, log: () => {},
 onEvent: event => { events.push(event); },
 onApproval: async request => {
  gates.push(request.gate);
  if (request.gate === 'G4_PRD') {
   if (scenario === 'parallel-preview') { started(); await heldG4; }
   if (scenario === 'approval-error' || scenario === 'parallel-preview') throw new Error('APPROVAL_STORE_UNAVAILABLE');
   if (scenario === 'rejected') return { approved: false, reason: 'user-rejected' };
  }
  return { approved: true, suggestions: [] };
 }
});
const metadata = { title: '灯光亮起', pipelineRoute: { kind: 'narrative' }, brief: { duration: 30, aspectRatio: '9:16', platform: 'douyin' } };
let previewScriptCalls = null;
try {
 const running = studio.runPreproduction({ projectId: 'host-project', intent: '展台灯光依次亮起，最后定格。', metadata });
 if (scenario === 'parallel-preview') {
  await atG4;
  const preview = fixture(true);
  preview.system._waitForExternalConfirmation = async () => ({ approved: true, waitTimeMs: 0 });
  await preview.system.create('展台灯光依次亮起，最后定格。', metadata, { skipRender: true, skipPostProduction: true });
  previewScriptCalls = preview.counts.script;
  release();
 }
 let hostFailure = null;
 const result = await running.catch(error => { hostFailure = error.message; return host.counts.result; });
 console.log('RESULT '+JSON.stringify({ gates, events: events.map(event => ({ kind: event.kind, gate: event.gate, payload: event.payload })),
  scriptCalls: host.counts.script, previewScriptCalls, hostFailure, success: result.success, errors: result.errors,
  prd: result.confirmations?.prd, prdDegraded: result.stages?.prdGeneration?.degraded,
  released: host.system._activeRun === null, restored: OriginalSystem.prototype._generateMinimalPRD === originalMinimalPrd,
  bridges: listSharedBridges() }));
} finally { release(); systemMod.HyperrealitySystem = OriginalSystem; }
`);
  try {
    const output = execFileSync(process.execPath, [resolve(root, "node_modules/tsx/dist/cli.mjs"), script], {
      cwd: root, encoding: "utf8", timeout: 90_000, maxBuffer: 8_000_000,
    });
    const line = output.split("\n").find(value => value.startsWith("RESULT "));
    if (!line) throw new Error(`Missing PRD result: ${output.slice(-3000)}`);
    return JSON.parse(line.slice(7));
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

describe("host PRD approval must precede downstream model work", () => {
  it.each(["approval-error", "model-error", "rejected"] as const)("%s cannot reach the script/model boundary", scenario => {
    const result = probe(scenario);
    expect(result.scriptCalls).toBe(0);
    expect(result.success).toBe(false);
    if (scenario === "model-error") expect(result.gates).not.toContain("G4_PRD");
    else expect(result.prd?.approved).toBe(false);
    if (scenario === "approval-error") expect(result.hostFailure).toBe("APPROVAL_STORE_UNAVAILABLE");
    expect(result.released).toBe(true);
    expect(result.restored).toBe(true);
    expect(result.bridges).toEqual([]);
  }, 100_000);

  it("a genuine approval keeps the downstream path available", () => {
    const result = probe("approved");
    expect(result.prd?.approved).toBe(true);
    expect(result.scriptCalls).toBe(1);
    expect(result.restored).toBe(true);
    expect(result.bridges).toEqual([]);
  }, 100_000);

  it("an unscoped vendor preview retains its fallback while a host run holds shared bridges", () => {
    const result = probe("parallel-preview");
    expect(result.previewScriptCalls).toBe(1);
    expect(result.scriptCalls).toBe(0);
    expect(result.prd?.approved).toBe(false);
    expect(result.hostFailure).toBe("APPROVAL_STORE_UNAVAILABLE");
    expect(result.restored).toBe(true);
    expect(result.bridges).toEqual([]);
  }, 100_000);
});
