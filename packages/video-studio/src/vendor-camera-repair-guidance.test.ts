import { createRequire } from "node:module";
import { resolve } from "node:path";
import { expect, it } from "vitest";
import { videoRuntimeRoot } from "./runtime-root.js";

const require = createRequire(import.meta.url);
const { CoherenceValidator, buildNeighborContext, buildGlobalChoreographyGuide, SHOCK_MOTIVATIONS } = require(resolve(videoRuntimeRoot(import.meta.url),
  "vendor/supermickey/systems/camera-coherence/index.js"));
type Motivation = { name: string; desc: string };
type Issue = { rule: string; severity: string; rewrite_hint: string };

it("gives the single-shot author every existing motivation and identifies the checked transition boundary", () => {
  const plans = [
    { shotId: "S5", scale: "MS", movementRaw: "缓推", transition: "上一镜的原生说明" },
    { shotId: "S6", scale: "ECU", movementRaw: "固定机位", transition: "本镜的原生说明" },
    { shotId: "S7", scale: "MS", movementRaw: "缓慢后拉", transition: "下一镜的原生说明" },
  ];
  const before = structuredClone(plans);
  for (const context of [buildNeighborContext(plans, 1), buildGlobalChoreographyGuide([])]) {
    for (const [id, motivation] of Object.entries(SHOCK_MOTIVATIONS as Record<string, Motivation>)) {
      expect(context).toContain(`${id}(${motivation.name}): ${motivation.desc}`);
    }
    expect(context).toContain("上一镜→本镜");
    expect(context).toContain("本镜→下一镜");
    expect(context).toContain("原始合同");
    expect(context).toContain("真实");
    expect(context).toContain("减小景别跨度");
    expect(context).toMatch(/叠化.*不能.*R1/u);
  }
  expect(plans).toEqual(before);
});

it("keeps large unmotivated jumps blocked and tells the author that a soft transition alone cannot satisfy R1", () => {
  const validator = new CoherenceValidator();
  const shots = [
    { shotId: "S5", fields: { composition: "中景，主体与环境清晰", transition: "原生转场说明" } },
    { shotId: "S6", fields: { composition: "大特写，主体局部细节", transition: "硬切，0.2秒" } },
  ];
  const before = structuredClone(shots);
  const report = validator.validate(shots);
  const critical = report.issues.filter((issue: Issue) => issue.severity === "critical");
  expect(critical.map((issue: Issue) => issue.rule)).toEqual(["R1_scale_jump", "R4_transition_mismatch"]);
  expect(critical[0].rewrite_hint).toContain("原始合同");
  expect(critical[0].rewrite_hint).toContain("否则减小景别跨度");
  const hint = critical.find((issue: Issue) => issue.rule === "R4_transition_mismatch").rewrite_hint;
  expect(hint).toContain("R1");
  expect(hint).toContain("真实");
  expect(hint).toContain("减小景别跨度");
  expect(hint).toMatch(/叠化.*不能.*R1/u);
  for (const transition of ["叠化，0.4秒", "柔和淡入，0.8秒", "闪白，0.2秒"]) {
    const softened = structuredClone(shots);
    softened[1]!.fields.transition = transition;
    const result = validator.validate(softened);
    expect(result.passed).toBe(false);
    expect(result.issues.some((issue: Issue) => issue.rule === "R1_scale_jump" && issue.severity === "critical")).toBe(true);
    expect(result.shotPlans[1].motivation).toBeNull();
  }
  const ordinary = structuredClone(shots);
  ordinary[1]!.fields.composition = "近景，主体上半身清晰";
  expect(validator.validate(ordinary).passed).toBe(true);
  expect(shots).toEqual(before);
});
