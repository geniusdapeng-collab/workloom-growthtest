import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, resolve, join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");

it.each([
  { first: "A", failed: false },
  { first: "B", failed: false },
  { first: "A", failed: true },
  { first: "B", failed: true },
])("$first finishing first (failed=$failed) keeps the other studio's real bridges, policies, logs and events isolated", ({ first, failed }) => {
  const directory = mkdtempSync(join(tmpdir(), "wl-studio-overlap-"));
  const file = join(directory, "overlap.mts");
  writeFileSync(file, `
import { createRequire } from 'node:module';
import { VideoStudio } from ${JSON.stringify(resolve(root, "packages/video-studio/src/studio.ts"))};
import { listSharedBridges } from ${JSON.stringify(resolve(root, "packages/video-studio/src/vendor-compat.ts"))};
const require = createRequire(${JSON.stringify(resolve(root, "package.json"))});
const entry = require('./vendor/supermickey/hyperreality-system/index.js');
const { RuleChecker } = require('./vendor/supermickey/hyperreality-system/engines/field-quality/field-check-agent.js');
const { ConfigIsolator } = require('./vendor/supermickey/hyperreality-system/utils/config-isolator.js');
const { ScriptGenerator } = require('./vendor/supermickey/hyperreality-system/engines/script-engine/core/script-generator.js');
const Original = entry.HyperrealitySystem;
const originalRule = RuleChecker.prototype._checkStructure;
const originalIsolator = ConfigIsolator.isolate;
const originalDuration = ScriptGenerator.prototype._enforceTargetDuration;
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const started = { A: deferred(), B: deferred() }, release = { A: deferred(), B: deferred() };
const logs = { A: [], B: [], C: [] }, events = { A: [], B: [], C: [] }, durations = { A: [], B: [], C: [] };
function project(id) {
  const scenes = [{ sceneId: id+'1', duration: id === 'A' ? 12 : 8 }, { sceneId: id+'2', duration: 4 }];
  const parsed = { structure: { scenes } };
  ScriptGenerator.prototype._enforceTargetDuration.call({}, parsed, id === 'A' ? 16 : 12);
  durations[id].push(scenes.map(scene => scene.duration));
}
function OfflineSystem() {}
OfflineSystem.prototype = Object.create(Original.prototype);
OfflineSystem.prototype.constructor = OfflineSystem;
OfflineSystem.prototype.create = async function(id) {
  project(id);
  if (id !== 'C') { started[id].resolve(); await release[id].promise; }
  project(id);
  if (id === ${JSON.stringify(first)} && ${JSON.stringify(failed)}) throw new Error('controlled-'+id);
  return { success: true, stages: {} };
};
const baseConfirm = OfflineSystem.prototype._confirmPrompts;
entry.HyperrealitySystem = OfflineSystem;
const make = id => new VideoStudio({ llm: { model: 'offline', fastModel: 'offline' }, workDir: ${JSON.stringify(join(directory, "work"))}, deferRender: true, portraits: { enabled: false }, durationPolicy: id === 'A' ? { minSingleShotSeconds: 4, maxSingleShotSeconds: 30 } : { minSingleShotSeconds: 6, maxSingleShotSeconds: 6 }, onApproval: async () => ({ approved: true }), log: line => logs[id].push(line), onEvent: event => events[id].push(event) });
const state = () => ({ field: RuleChecker.prototype._checkStructure !== originalRule, isolator: ConfigIsolator.isolate !== originalIsolator, review: OfflineSystem.prototype._confirmPrompts !== baseConfirm, duration: ScriptGenerator.prototype._enforceTargetDuration !== originalDuration });
try {
 const run = id => make(id).runPreproduction({ projectId: id, intent: id }).then(result => ({ success: result.success }), error => ({ error: error.message }));
 const a = run('A'); await started.A.promise;
 const b = run('B'); await started.B.promise;
 const both = listSharedBridges();
 const first = ${JSON.stringify(first)}, second = first === 'A' ? 'B' : 'A';
 release[first].resolve(); const firstResult = await (first === 'A' ? a : b);
 const activeSecond = state(), remaining = listSharedBridges();
 release[second].resolve(); const secondResult = await (second === 'A' ? a : b);
 const afterBoth = state(), remainingAfterBoth = listSharedBridges();
 await run('C');
 console.log('RESULT '+JSON.stringify({ both, activeSecond, remaining, firstResult, secondResult, afterBoth, remainingAfterBoth, afterThird: state(), remainingAfterThird: listSharedBridges(), logs, events, durations }));
} finally { entry.HyperrealitySystem = Original; }
`);
  try {
    const output = execFileSync(process.execPath, [resolve(root, "node_modules/tsx/dist/cli.mjs"), file], { cwd: root, encoding: "utf8", timeout: 90_000, maxBuffer: 5_000_000 });
    const line = output.split("\n").find(value => value.startsWith("RESULT "));
    expect(line).toBeDefined();
    const result = JSON.parse(line!.slice(7));
    expect(result.activeSecond).toEqual({ field: true, isolator: true, review: true, duration: true });
    expect(result.afterBoth).toEqual({ field: false, isolator: false, review: false, duration: false });
    expect(result.afterThird).toEqual(result.afterBoth);
    expect(result.remainingAfterBoth).toEqual([]);
    expect(result.remainingAfterThird).toEqual([]);
    expect(result.both.length).toBeGreaterThan(15);
    for (const bridge of result.remaining) expect(bridge.refs).toBe(1);
    expect(result.firstResult).toEqual(failed ? { error: `controlled-${first}` } : { success: true });
    expect(result.secondResult).toEqual({ success: true });
    expect(result.durations.A).toEqual([[12, 4], [12, 4]]);
    expect(result.durations.B).toEqual([[6, 6], [6, 6]]);
    expect(result.durations.C).toEqual([[6, 6], [6, 6]]);
    for (const id of ["A", "B", "C"]) {
      expect(result.events[id].filter((event: { kind: string }) => event.kind === "pipeline.duration.projected")).toHaveLength(2);
      for (const event of result.events[id]) expect(event.projectId).toBe(id);
      const target = id === "A" ? 16 : 12;
      expect(result.logs[id].filter((line: string) => line.includes(`2 场景 / 合计 ${target}s`))).toHaveLength(2);
      expect(result.logs[id].some((line: string) => line.includes(`2 场景 / 合计 ${target === 16 ? 12 : 16}s`))).toBe(false);
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}, 100_000);
