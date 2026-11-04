import { createRequire } from "node:module";
import { mkdtempSync, mkdirSync, readFileSync, existsSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { expect, it, vi } from "vitest";
import { videoRuntimeRoot } from "./runtime-root.js";

const require = createRequire(import.meta.url);
const root = videoRuntimeRoot(import.meta.url);
const { PromptFusionAgent } = require(resolve(root,
  "vendor/supermickey/hyperreality-system/engines/production-engine/agents/prompt-fusion-agent.js"));
const { ProductionEngine } = require(resolve(root,
  "vendor/supermickey/hyperreality-system/engines/production-engine/production-engine.js"));

const fingerprint = "a".repeat(64);
const shots = [{ shotId: "N1", action: "举起箱子" }, { shotId: "N2", action: "放下箱子" }];
const blueprint = { config: { aspectRatio: "9:16" }, character_system: { characters: [] } };

function offlineAgent() {
  const calls = vi.fn(async (shot: Record<string, unknown>) => ({ ...shot, fields: { action: shot.action },
    prompt: `01.【动作】${String(shot.action)}`, degraded: false }));
  const agent = Object.assign(Object.create(PromptFusionAgent.prototype), { _fuseSingleShotWithDeadline: calls });
  return { agent, calls };
}

it("retains fully fused raw rows until surrounding validation succeeds and reuses their exact project fingerprint", async () => {
  const directory = mkdtempSync(resolve(tmpdir(), "wl-fusion-retain-"));
  const baseDir = resolve(directory, "project-a");
  const otherDir = resolve(directory, "project-b");
  mkdirSync(baseDir); mkdirSync(otherDir);
  try {
    const { agent, calls } = offlineAgent();
    const first = await agent.process(shots, blueprint, { checkpointManager: { baseDir }, blueprintHash: fingerprint });
    const file = resolve(baseDir, `checkpoint-phase3-${fingerprint}.json`);
    expect(existsSync(file)).toBe(true);
    const raw = JSON.parse(readFileSync(file, "utf8"));
    expect(raw).toMatchObject({ phase: "phase3-incremental", blueprintHash: fingerprint, completed: 2, total: 2 });
    expect(raw.results).toEqual(first.shots);
    const next = await agent.process(shots, blueprint, { checkpointManager: { baseDir }, blueprintHash: fingerprint });
    expect(next.shots).toEqual(first.shots);
    expect(calls).toHaveBeenCalledTimes(2);
    expect(agent._loadSubCheckpoint({ baseDir }, "b".repeat(64))).toBeNull();
    expect(agent._loadSubCheckpoint({ baseDir: otherDir }, fingerprint)).toBeNull();
    expect(existsSync(file)).toBe(true);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

it("lets the existing successful production cleanup remove raw fusion rows only inside its project directory", async () => {
  const directory = mkdtempSync(resolve(tmpdir(), "wl-fusion-cleanup-"));
  const baseDir = resolve(directory, "project-a");
  const otherDir = resolve(directory, "project-b");
  mkdirSync(baseDir); mkdirSync(otherDir);
  try {
    const { agent } = offlineAgent();
    await agent.process(shots, blueprint, { checkpointManager: { baseDir }, blueprintHash: fingerprint });
    const retained = resolve(baseDir, `checkpoint-phase3-${fingerprint}.json`);
    expect(existsSync(retained)).toBe(true);
    writeFileSync(resolve(baseDir, "checkpoint-phase2.json"), JSON.stringify({ phase: "phase2", shots }));
    const other = resolve(otherDir, `checkpoint-phase3-${fingerprint}.json`);
    writeFileSync(other, "unrelated project");
    ProductionEngine.prototype._clearCheckpoints.call({ _checkpointDir: baseDir, log: vi.fn() });
    expect(existsSync(retained)).toBe(false);
    expect(existsSync(resolve(baseDir, "checkpoint-phase2.json"))).toBe(false);
    expect(readFileSync(other, "utf8")).toBe("unrelated project");
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

it("exposes the native cache key so a host-repaired S1 survives the next seven-shot resume", async () => {
  const baseDir = mkdtempSync(resolve(tmpdir(), "wl-fusion-repaired-row-"));
  const sevenShots = Array.from({ length: 7 }, (_, index) => ({
    shotId: `S${index + 1}`, action: `原生镜头动作${index + 1}`,
  }));
  try {
    const { agent, calls } = offlineAgent();
    // Model calls are offline stubs. This reproduces the real seven-row cache
    // shape (only S1 degraded), without claiming to recover its lost retry bytes.
    calls.mockImplementation(async (shot: Record<string, unknown>) => ({ ...shot,
      fields: { action: shot.action }, prompt: `01.【动作】${String(shot.action)}`,
      degraded: shot.shotId === "S1" }));
    const first = await agent.process(sevenShots, blueprint,
      { checkpointManager: { baseDir }, blueprintHash: fingerprint });
    expect(first.checkpointBlueprintHash).toBe(fingerprint);
    expect(calls).toHaveBeenCalledTimes(7);
    expect(first.shots.filter((shot: Record<string, unknown>) => shot.degraded).map((shot: Record<string, unknown>) => shot.shotId)).toEqual(["S1"]);
    const repairedS1 = { ...first.shots[0], fields: { action: "单镜原生修复后的动作" },
      prompt: "01.【动作】单镜原生修复后的动作", degraded: false };
    const repaired = [repairedS1, ...first.shots.slice(1)];
    // The host uses the existing native writer before canonical validation.
    agent._saveSubCheckpoint({ baseDir }, first.checkpointBlueprintHash, repaired, repaired.length, sevenShots.length);
    calls.mockClear();
    const resumed = await agent.process(sevenShots, blueprint,
      { checkpointManager: { baseDir }, blueprintHash: fingerprint });
    expect(calls).not.toHaveBeenCalled();
    expect(resumed.shots).toEqual(repaired);
    expect(resumed.shots.slice(1)).toEqual(first.shots.slice(1));
    expect(first.shots[0].degraded).toBe(true);
    const saved = JSON.parse(readFileSync(resolve(baseDir, `checkpoint-phase3-${fingerprint}.json`), "utf8"));
    expect(saved).toMatchObject({ completed: 7, total: 7, results: repaired });
  } finally { rmSync(baseDir, { recursive: true, force: true }); }
});

it("returns the effective feedback hash and keeps host repair saves isolated by feedback", async () => {
  const baseDir = mkdtempSync(resolve(tmpdir(), "wl-fusion-feedback-key-"));
  const feedbackA = { ...blueprint, _workloomProductionRepairFeedback: "S1按先停车再摘盔的顺序修复" };
  const feedbackB = { ...blueprint, _workloomProductionRepairFeedback: "S1只修复声音与动作的同步" };
  try {
    const { agent, calls } = offlineAgent();
    const baseline = await agent.process(shots, blueprint,
      { checkpointManager: { baseDir }, blueprintHash: fingerprint });
    const first = await agent.process(shots, feedbackA,
      { checkpointManager: { baseDir }, blueprintHash: fingerprint });
    expect(first.checkpointBlueprintHash).toMatch(/^[0-9a-f]{24}$/u);
    expect(first.checkpointBlueprintHash).not.toBe(fingerprint);
    const repaired = [{ ...first.shots[0], prompt: "01.【动作】反馈A的单镜修复结果" }, first.shots[1]];
    agent._saveSubCheckpoint({ baseDir }, first.checkpointBlueprintHash, repaired, repaired.length, shots.length);
    const other = await agent.process(shots, feedbackB,
      { checkpointManager: { baseDir }, blueprintHash: fingerprint });
    expect(other.checkpointBlueprintHash).not.toBe(first.checkpointBlueprintHash);
    expect(other.shots).toEqual(baseline.shots);
    expect(calls).toHaveBeenCalledTimes(6);
    calls.mockClear();
    const resumed = await agent.process(shots, feedbackA,
      { checkpointManager: { baseDir }, blueprintHash: fingerprint });
    expect(resumed.checkpointBlueprintHash).toBe(first.checkpointBlueprintHash);
    expect(resumed.shots).toEqual(repaired);
    expect(calls).not.toHaveBeenCalled();
    expect(agent._loadSubCheckpoint({ baseDir }, fingerprint).results).toEqual(baseline.shots);
    expect(agent._loadSubCheckpoint({ baseDir }, other.checkpointBlueprintHash).results).toEqual(other.shots);
  } finally { rmSync(baseDir, { recursive: true, force: true }); }
});
