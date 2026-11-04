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
