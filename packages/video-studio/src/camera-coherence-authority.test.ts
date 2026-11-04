import { createRequire } from "node:module";
import { resolve } from "node:path";
import { expect, it } from "vitest";
import { videoRuntimeRoot } from "./runtime-root.js";

const require = createRequire(import.meta.url);
const { CoherenceValidator, extractLightPlans } = require(resolve(videoRuntimeRoot(import.meta.url),
  "vendor/supermickey/systems/camera-coherence/index.js"));

it("checks the final fused full shot instead of the stale close shot from visual design", () => {
  // Actual9 had an LS→MCU critical pair while S2's final consistency check
  // reported a full composition. This fixture reproduces that authority split.
  const shots = [
    { shotId: "S1", camera: { shot_size: "wide" }, fields: { composition: "远景，赛道全貌", transition: "hard_cut" } },
    { shotId: "S2", camera: { shot_size: "medium_close" }, fields: { composition: "全景，车身与路肩完整入画", transition: "hard_cut" } },
  ];
  const before = structuredClone(shots);
  const report = new CoherenceValidator().validate(shots);
  expect(report.passed).toBe(true);
  expect(report.issueCount.critical).toBe(0);
  expect(report.rhythm.curve).toBe("LS → FS");
  expect(extractLightPlans(shots)[1].scaleRaw).toBe(shots[1]!.fields.composition);
  expect(shots).toEqual(before);
});

it("still rejects a real final unmotivated scale jump even when the old design would pass", () => {
  const shots = [
    { shotId: "S1", camera: { shot_size: "medium" }, fields: { composition: "远景，赛道全貌" } },
    { shotId: "S2", camera: { shot_size: "medium" }, fields: { composition: "近景，车手上身", transition: "hard_cut" } },
  ];
  const report = new CoherenceValidator().validate(shots);
  expect(report.passed).toBe(false);
  expect(report.issues.filter((issue: { severity: string }) => issue.severity === "critical")
    .map((issue: { rule: string; shots: string[] }) => ({ rule: issue.rule, shots: issue.shots })))
    .toEqual([{ rule: "R1_scale_jump", shots: ["S1", "S2"] }, { rule: "R4_transition_mismatch", shots: ["S1", "S2"] }]);
});

it("retains the structured design fallback when no final composition has been produced", () => {
  const shot = { shotId: "S1", camera: { shot_size: "medium_close" }, fields: { transition: "hard_cut" } };
  expect(new CoherenceValidator().extractCameraPlan(shot).scale).toBe("MCU");
  expect(extractLightPlans([shot])[0].scaleRaw).toBe("medium_close");
});
