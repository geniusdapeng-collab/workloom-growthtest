import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");

function runRuntimeConfigProbe(withHealthMonitor: boolean): Record<string, any> {
  const directory = mkdtempSync(join(tmpdir(), "wl-runtime-agents-"));
  const script = join(directory, "probe.mts");
  writeFileSync(script, `
import { createRequire } from 'node:module';
import { installVendorPhase3FusionBridge, listSharedBridges } from ${JSON.stringify(resolve(root, "packages/video-studio/src/vendor-compat.ts"))};
const require = createRequire(${JSON.stringify(resolve(root, "package.json"))});
const { ProductionEngine } = require('./vendor/supermickey/hyperreality-system/engines/production-engine/production-engine.js');
const originalUpdate = ProductionEngine.prototype.updateAgentConfig;
const dispose = installVendorPhase3FusionBridge({ log: () => {} });
const calls = [];
const engine = new ProductionEngine({ agentConfig: { llmModel: 'old-deep', fastModel: 'old-fast', llmTimeout: 300000, checkpointDir: ${JSON.stringify(join(directory, "checkpoints"))}, enableResume: false } });
if (${JSON.stringify(withHealthMonitor)}) engine.setHealthMonitor({ setLongTaskMode: () => {} });
function boundary(agents, generation) {
 for (const [role, agent] of Object.entries(agents)) agent.process = async function(shots) {
   calls.push({ role, generation, model: this.llmModel, timeout: this.llmTimeout, deadline: this._globalDeadline });
   if (role === 'openingDesign') return { opening: {}, timing: 0 };
   if (role === 'continuityReview') return { review: { overallScore: 100, issues: [] }, timing: 0 };
   return { shots, timing: 0 };
 };
}
try {
 boundary(engine.agents, 'old');
 engine.updateAgentConfig({ llmModel: 'new-deep', fastModel: 'new-fast', llmTimeout: 12345, totalDeadlineMs: 900000 });
 boundary(engine.agents, 'new');
 const deadline = Date.now() + 800000;
 engine._globalDeadline = deadline;
 engine._setAgentDeadline(deadline);
 const shots = [{ shotId: 'S1', duration: 8, sceneType: 'establishing', scene: '本项目空展厅', action: '显示屏依次亮起' }];
 const result = { stages: {}, llmStats: {} };
 const blueprint = { scenes: [], config: {}, characters: [] };
 const p1 = await engine.phase1.execute({ shots, result, adaptedBlueprint: blueprint });
 const p2 = await engine.phase2.execute({ shots: p1.shots, result, adaptedBlueprint: blueprint });
 const currentBindings = ['phase1','phase2','phase3','phase35'].map(key => ({ phase: key, current: engine[key].agents === engine.agents }));
 const other = new ProductionEngine({ agentConfig: { llmModel: 'other-deep', fastModel: 'other-fast', checkpointDir: ${JSON.stringify(join(directory, "other-checkpoints"))}, enableResume: false } });
 const isolated = other.phase1.agents !== engine.phase1.agents && other.phase1.agents.sceneDesign.llmModel === 'other-deep';
 dispose();
 console.log('RESULT '+JSON.stringify({ calls, deadline, currentBindings, p1: p1.success, p2: p2.success, isolated, restored: ProductionEngine.prototype.updateAgentConfig === originalUpdate, bridges: listSharedBridges() }));
} finally { dispose(); }
`);
  try {
    const output = execFileSync(process.execPath, [resolve(root, "node_modules/tsx/dist/cli.mjs"), script], {
      cwd: root, encoding: "utf8", timeout: 90_000, maxBuffer: 8_000_000,
    });
    const line = output.split("\n").find(value => value.startsWith("RESULT "));
    if (!line) throw new Error(`Missing runtime result: ${output.slice(-1000)}`);
    return JSON.parse(line.slice(7));
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

describe("runtime agent configuration reaches the actual production phases", () => {
  it.each([false, true])("real Phase1/Phase2 consume the current models, timeout and deadline (healthMonitor=%s)", withHealthMonitor => {
    const result = runRuntimeConfigProbe(withHealthMonitor);
    expect(result.p1).toBe(true);
    expect(result.p2).toBe(true);
    expect(result.calls).toHaveLength(5);
    for (const call of result.calls) {
      expect(call.generation).toBe("new");
      expect(call.model).toBe(call.role === "sceneDesign" || call.role === "visualLanguage" ? "new-deep" : "new-fast");
      expect(call.deadline).toBe(result.deadline);
      if (call.role !== "visualLanguage") expect(call.timeout).toBe(12345);
    }
    expect(result.currentBindings.every((row: { current: boolean }) => row.current)).toBe(true);
    expect(result.isolated).toBe(true);
    expect(result.restored).toBe(true);
    expect(result.bridges).toEqual([]);
  }, 100_000);
});
