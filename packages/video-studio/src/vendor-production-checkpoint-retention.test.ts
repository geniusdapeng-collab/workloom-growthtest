import { mkdtempSync, existsSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const require = createRequire(import.meta.url);
const base = resolve(import.meta.dirname, "../../../vendor/supermickey/hyperreality-system/engines/production-engine");
const { ProductionEngine } = require(join(base, "production-engine.js"));
const { PromptFusionAgent } = require(join(base, "agents/prompt-fusion-agent.js"));
const directories: string[] = [];

afterEach(() => {
  vi.restoreAllMocks();
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function fixture(options: { critical?: boolean; integrityFailure?: boolean; qualityFailure?: boolean; shotDegraded?: boolean; phaseThrows?: boolean } = {}) {
  vi.spyOn(console, "log").mockImplementation(() => {});
  const directory = mkdtempSync(join(tmpdir(), "native-production-checkpoints-"));
  directories.push(directory);
  const shots = ["S1", "S2"].map((shotId, index) => ({
    shotId, duration: 5, scene: "同一场地的器物工作台", degraded: options.shotDegraded === true,
    prompt: options.integrityFailure ? "过短" : "camera stays stable, lighting follows the existing practical light, keeping the physical action fully visible.",
    camera: { shot_size: index === 0 ? "LS" : options.critical ? "ECU" : "FS" },
    fields: { composition: index === 0 ? "LS" : options.critical ? "ECU" : "FS", camera_movement: "static", transition: "hard_cut" },
  }));
  const engine = Object.create(ProductionEngine.prototype);
  engine.agentConfig = { enableLLMAgents: true };
  engine.agents = {};
  engine.logs = [];
  engine._checkpointDir = directory;
  engine._checkpointManager = null;
  engine._enableResume = false;
  engine.degradationObserver = { canProceed: () => ({ allowed: true }), _generateReport: () => ({}) };
  engine.contractValidator = { validate: () => ({ valid: true }) };
  engine._extractScenes = () => ({ shots });
  engine._allocateDuration = (value: unknown[]) => ({ shots: value });
  engine._buildMeta = () => ({});
  engine.boundaryGuard = { enforce: (value: unknown[]) => value };
  engine.qualityGate = { run: () => ({ passed: !options.qualityFailure }) };
  engine.ruleFallback = { engineerPromptsFallback: vi.fn(async () => []) };
  engine.phase1 = { execute: async ({ shots: value }: { shots: unknown[] }) => {
    await engine._saveCheckpoint("phase1", value);
    if (options.phaseThrows) throw new Error("OFFLINE_PHASE_FAILURE");
    return { success: true, shots: value };
  } };
  engine.phase2 = { execute: async ({ shots: value }: { shots: unknown[] }) => ({ success: true, shots: value }) };
  engine.phase3 = { execute: async ({ shots: value }: { shots: unknown[] }) => {
    // Use the actual native serializers and filesystem lifecycle, with no model call.
    Object.create(PromptFusionAgent.prototype)._saveSubCheckpoint({ baseDir: directory }, "12345678abcdef01", value, value.length, value.length);
    await engine._saveCheckpoint("phase3", value);
    return { success: true, shots: value };
  } };
  engine.phase35 = { execute: async ({ shots: value }: { shots: unknown[] }) => {
    await engine._saveCheckpoint("phase3.5", value);
    return { success: true, shots: value };
  } };
  const unrelated = join(directory, "unrelated.json");
  writeFileSync(unrelated, "unrelated fixture must remain\n");
  const blueprint = { scenes: [{ scene_id: "S1" }, { scene_id: "S2" }], config: {} };
  return { engine, directory, blueprint, unrelated };
}

describe("native produce retains evidence until all existing completion checks pass", () => {
  it("keeps phase and shot checkpoints for real critical coherence failures and logs every original diagnosis", async () => {
    const { engine, directory, blueprint } = fixture({ critical: true });
    const result = await engine.produce(blueprint);
    expect(result.success).toBe(true);
    expect(result.degraded).toBe(true);
    const report = result.stages.cameraCoherence;
    expect(report.passed).toBe(false);
    expect(report.issueCount.critical).toBe(2);
    expect(JSON.parse(readFileSync(join(directory, "checkpoint-phase3.5.json"), "utf8")).shots).toHaveLength(2);
    expect(existsSync(join(directory, "checkpoint-phase3-12345678abcdef01.json"))).toBe(true);
    const logged = result.logs.filter((entry: any) => entry.stage === "CAMERA-COHERENCE" && entry.message.startsWith("{"))
      .map((entry: any) => JSON.parse(entry.message));
    expect(logged).toEqual(report.issues.filter((issue: any) => issue.severity === "critical").map((issue: any) => ({
      rule: issue.rule, severity: issue.severity, shotIds: issue.shots, message: issue.message, rewrite_hint: issue.rewrite_hint,
    })));
    expect(logged.map((issue: any) => issue.rule)).toEqual(["R1_scale_jump", "R4_transition_mismatch"]);
  });

  it("cleans native checkpoints after a nondegraded success and leaves unrelated files intact", async () => {
    const { engine, directory, blueprint, unrelated } = fixture();
    const result = await engine.produce(blueprint);
    expect(result.success).toBe(true);
    expect(result.degraded).toBe(false);
    expect(result.stages.cameraCoherence.passed).toBe(true);
    expect(readdirSync(directory)).toEqual(["unrelated.json"]);
    expect(readFileSync(unrelated, "utf8")).toBe("unrelated fixture must remain\n");
  });

  it.each([
    { integrityFailure: true }, { qualityFailure: true }, { shotDegraded: true },
  ])("retains checkpoints for an existing failed completion check: %j", async options => {
    const { engine, directory, blueprint } = fixture(options);
    const result = await engine.produce(blueprint);
    expect(result.success).toBe(true); // This repair preserves the existing native result contract.
    if (options.integrityFailure) expect(result.stages.finalIntegrity.valid).toBe(false);
    if (options.qualityFailure) expect(result.stages.qualityGate.passed).toBe(false);
    expect(existsSync(join(directory, "checkpoint-phase3.5.json"))).toBe(true);
    expect(existsSync(join(directory, "checkpoint-phase3-12345678abcdef01.json"))).toBe(true);
  });

  it("retains the last checkpoint when a phase throws before completion", async () => {
    const { engine, directory, blueprint } = fixture({ phaseThrows: true });
    const result = await engine.produce(blueprint);
    expect(result.success).toBe(false);
    expect(result.errors).toContainEqual({ stage: "production", message: "OFFLINE_PHASE_FAILURE" });
    expect(existsSync(join(directory, "checkpoint-phase1.json"))).toBe(true);
  });
});
