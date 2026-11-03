/** Independent MC-002 counterexample: Phase3.5 constructs its own checker from a cached model. */
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
function observePhase35(healthAfterUpdate: boolean): { calls: Array<{ llmModel: string; deadline: number }>; expectedDeadline: number } {
  const dir = mkdtempSync(join(tmpdir(), "independent-phase35-model-"));
  const file = join(dir, "probe.mts");
  writeFileSync(file, `
import { createRequire } from 'node:module';
import { installVendorPhase3FusionBridge } from ${JSON.stringify(resolve(root, "packages/video-studio/src/vendor-compat.ts"))};
const require = createRequire(${JSON.stringify(resolve(root, "package.json"))});
const { ProductionEngine } = require('./vendor/supermickey/hyperreality-system/engines/production-engine/production-engine.js');
const field = require('./vendor/supermickey/hyperreality-system/engines/field-quality/index.js');
const previous = field.FieldQualityPipeline;
const calls = [];
// Keep the actual Phase3.5.execute and replace only its expensive checker boundary.
field.FieldQualityPipeline = class {
 constructor(options) { this.options = options; }
 setPRDFromBlueprint() {}
 setDeadline(deadline) { this.deadline = deadline; }
 async runAll(shots) { calls.push({ llmModel: this.options.llmModel, deadline: this.deadline }); return { finalShots: shots, summary: { passed: shots.length, totalShots: shots.length, totalRepairs: 0 } }; }
};
const dispose = installVendorPhase3FusionBridge();
try {
 const engine = new ProductionEngine({ agentConfig: { llmModel: 'old-model', fastModel: 'old-fast', checkpointDir: ${JSON.stringify(join(dir, "checkpoints"))}, enableResume: false } });
 if (!${healthAfterUpdate}) engine.setHealthMonitor({ setLongTaskMode: () => {} });
 engine.updateAgentConfig({ llmModel: 'current-model', fastModel: 'current-fast' });
 if (${healthAfterUpdate}) engine.setHealthMonitor({ setLongTaskMode: () => {} });
 const deadline = Date.now() + 500000; engine._globalDeadline = deadline; engine._setAgentDeadline(deadline); engine.phase35.globalDeadline = deadline;
 const result = await engine.phase35.execute({ shots: [{ shotId: 'S1', duration: 5 }], result: { stages: {}, llmStats: {} }, adaptedBlueprint: { config: {}, scenes: [] } });
 if (!result.success) throw new Error('real Phase3.5 failed: '+result.error);
 console.log('RESULT '+JSON.stringify({ calls, expectedDeadline: deadline }));
} finally { dispose(); field.FieldQualityPipeline = previous; }
`);
  try {
    const output = execFileSync(process.execPath, [resolve(root, "node_modules/tsx/dist/cli.mjs"), file], { cwd: root, encoding: "utf8", timeout: 60_000, maxBuffer: 4_000_000 });
    const result = output.split("\n").find(line => line.startsWith("RESULT "));
    if (!result) throw new Error("Missing actual Phase3.5 observation");
    return JSON.parse(result.slice(7));
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

describe("independent Phase3.5 runtime model propagation", () => {
  it.each([false, true])("constructs the checker with the updated model when health monitor is set after=%s", healthAfterUpdate => {
    const observation = observePhase35(healthAfterUpdate);
    expect(observation.calls).toEqual([{ llmModel: "current-model", deadline: observation.expectedDeadline }]);
  });
});
