import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");

function runDiscoveryProbe(withHostBridge: boolean, rejectConversion = false): Record<string, any> {
  const directory = mkdtempSync(join(tmpdir(), "wl-discovery-await-"));
  const script = join(directory, "probe.mts");
  writeFileSync(script, `
import { createRequire } from 'node:module';
import { installVendorDiscoveryNarrativeBridge } from ${JSON.stringify(resolve(root, "packages/video-studio/src/vendor-compat.ts"))};
const require = createRequire(${JSON.stringify(resolve(root, "package.json"))});
const { HyperrealitySystem } = require('./vendor/supermickey/hyperreality-system/index.js');
const { RequirementDiscoveryEngine } = require('./vendor/supermickey/hyperreality-system/engines/requirement-discovery-engine.js');
const { RequirementListBuilder } = require('./vendor/supermickey/hyperreality-system/engines/script-engine/core/requirement-list-builder.js');
const coordinator = require('./vendor/supermickey/scripts/run-coordinator.js');
// Isolate filesystem run-state I/O. The original create, discovery, conversion,
// contract rendering and confirmation methods remain under test.
coordinator.acquireLock = () => ({ acquired: true });
coordinator.startRun = () => 'probe-run';
coordinator.finishRun = () => {};
coordinator.releaseLock = () => {};
const dispose = ${JSON.stringify(withHostBridge)} ? installVendorDiscoveryNarrativeBridge() : () => {};
let profileCompleted = false;
let profileCompletedAtG3 = false;
const confirmations = [];
const system = Object.create(HyperrealitySystem.prototype);
const llm = { reasonStructured: async () => {
 await new Promise(resolve => setImmediate(resolve));
 profileCompleted = true;
 return { success: true, data: { genre: '展台纪实', profile: { narrative_mode: 'documentary', dialogue_density: 'none', duration_target: 60, aspect_ratio: '9:16' } } };
} };
system.options = { llmEngine: llm };
system.stabilityShield = { setLongTaskMode: () => {} };
system.requirementAlignmentGate = { enabled: false };
system.pipelineLogger = { enabled: false };
system.pandaAdapter = { enabled: false };
if (${JSON.stringify(rejectConversion)}) system._profileResolver = { resolve: async () => {
 await new Promise(resolve => setImmediate(resolve));
 throw new Error('DISCOVERY_PROFILE_CONVERSION_FAILED');
} };
system.requirementListBuilder = new RequirementListBuilder();
system.requirementDiscoveryEngine = new RequirementDiscoveryEngine();
for (const agent of Object.values(system.requirementDiscoveryEngine.agents)) {
 // The model boundary supplies deterministic valid outputs; real agent.run,
 // schema filling, discover and generateMarkdown still execute.
 agent._callLLM = async input => agent._fallback(input);
}
system.creativeThemeGenerator = {
 generate: async () => ({ tasks: [{ type: '展台纪实', theme: '灯光亮起', description: '展台灯光依次亮起，最后定格。', duration_sec: 30, visual_style: '写实', dialogue_requirement: '无台词，纯画面', creative_style: 0.4 }] }),
 generateConfirmationSummary: () => '创意主题确认'
};
system._waitForExternalConfirmation = async type => {
 confirmations.push(type);
 if (type === 'requirement') { profileCompletedAtG3 = profileCompleted; return { approved: false, reason: 'probe-complete', waitTimeMs: 0 }; }
 return { approved: true, waitTimeMs: 0 };
};
try {
 const result = await system.create('展台灯光依次亮起，最后定格。', { title: '灯光亮起', pipelineRoute: { kind: 'narrative' }, brief: { duration: 30, aspectRatio: '9:16', platform: 'douyin' } }, { skipRender: true, skipPostProduction: true });
 const requirement = result.confirmations.requirementList?.requirementList;
 const metadata = requirement ? system.requirementListBuilder.toScriptEngineMetadata(requirement) : {};
 console.log('RESULT '+JSON.stringify({ confirmations, profileCompletedAtG3, isPromise: typeof requirement?.then === 'function', title: requirement?.title, genre: requirement?.genre, targetDuration: requirement?.targetDuration, aspectRatio: requirement?.aspectRatio, scriptDuration: metadata.target_duration, rejected: result.stages.requirementReview?.reason, errors: result.errors, released: system._activeRun === null }));
 // Let the intentionally delayed profile call settle on the broken baseline,
 // so the probe also catches unexpected rejected background work.
 await new Promise(resolve => setImmediate(resolve));
} finally { dispose(); }
`);
  try {
    const output = execFileSync(process.execPath, [resolve(root, "node_modules/tsx/dist/cli.mjs"), script], {
      cwd: root, encoding: "utf8", timeout: 90_000, maxBuffer: 8_000_000,
    });
    const line = output.split("\n").find(value => value.startsWith("RESULT "));
    if (!line) throw new Error(`Missing discovery result: ${output.slice(-2000)}`);
    return JSON.parse(line.slice(7));
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

describe("real create waits for discovery conversion before the G3 confirmation", () => {
  it.each([false, true])("G3 receives resolved requirements and downstream metadata (hostBridge=%s)", withHostBridge => {
    const result = runDiscoveryProbe(withHostBridge);
    console.info("discovery observation", { withHostBridge, ...result });
    expect(result.errors).toEqual([]);
    expect(result.confirmations).toEqual(["creative-theme", "requirement"]);
    expect(result.profileCompletedAtG3).toBe(true);
    expect(result.isPromise).toBe(false);
    expect(result.title).toBe("灯光亮起");
    expect(result.genre).toBe("展台纪实");
    expect(result.targetDuration).toBe(30);
    expect(result.aspectRatio).toBe("9:16");
    expect(result.scriptDuration).toBe(30);
    expect(result.rejected).toBe("probe-complete");
    expect(result.released).toBe(true);
  }, 100_000);

  it.each([false, true])("conversion rejection stops before G3 and releases run state (hostBridge=%s)", withHostBridge => {
    const result = runDiscoveryProbe(withHostBridge, true);
    expect(result.confirmations).toEqual(["creative-theme"]);
    expect(result.errors).toEqual([expect.objectContaining({
      stage: "HYPERREALITY_SYSTEM", message: "DISCOVERY_PROFILE_CONVERSION_FAILED",
    })]);
    expect(result.released).toBe(true);
  }, 100_000);
});
