import { createRequire } from "node:module";
import { resolve } from "node:path";
import { expect, it } from "vitest";
import { videoRuntimeRoot } from "./runtime-root.js";

const require = createRequire(import.meta.url);
const { CoherenceValidator, normalizeScale } = require(resolve(videoRuntimeRoot(import.meta.url),
  "vendor/supermickey/systems/camera-coherence/index.js"));
type Issue = { rule: string; severity: string };

const criticalRules = (transition: string) => new CoherenceValidator().validate([
  { shotId: "S1", fields: { composition: "特写，固定机位" } },
  { shotId: "S2", fields: { composition: "全景，完整环境", transition } },
]).issues.filter((issue: Issue) => issue.severity === "critical").map((issue: Issue) => issue.rule);

it.each([
  ["中景起幅，后拉过程中展开全景环境", "MS"],
  ["全景起幅，末段推至大特写", "FS"],
  ["中近景，主体保持清晰", "MCU"],
  ["extreme close-up of a hand, then a wide environment", "ECU"],
  ["medium shot opening, extreme close-up ending", "MS"],
  ["MS 起幅，后拉至 FS 落幅", "MS"],
  ["disclosure with a nationwide context", null],
])("normalizes the first scale mention, using the longest alias only at the same position: %s", (raw, scale) => {
  expect(normalizeScale(raw)).toBe(scale);
});

it("checks the previous exit against the current entry without changing either authored shot", () => {
  const shots = [
    { shotId: "S1", fields: { composition: "全景起幅，末段缓推至特写落幅" } },
    { shotId: "S2", camera: { shot_size: "wide" }, fields: {
      composition: "中景起幅，后拉过程中画面从中景过渡到全景式的环境",
      transition: "入场：0.3秒叠化，不另加硬切。出场：0.4秒淡出。",
    } },
  ];
  const before = structuredClone(shots);
  const report = new CoherenceValidator().validate(shots);
  expect(report.issueCount.critical).toBe(0);
  expect(report.shotPlans.map((p: { scale: string; exitScale: string }) => [p.scale, p.exitScale]))
    .toEqual([["FS", "CU"], ["MS", "FS"]]);
  expect(report.rhythm.curve).toBe("FS → MS");
  expect(report.issues.some((issue: Issue) => issue.rule === "R1_scale_caution")).toBe(true);
  expect(shots).toEqual(before);
});

it.each(["camera_movement", "timeline"])("uses only explicit temporal scale statements in final %s to refine the exit", (field) => {
  const validator = new CoherenceValidator();
  const shot = { shotId: "S1", fields: {
    composition: "中景，主体在画面中央",
    [field]: "起幅固定；末段推势渐缓并落幅在近景，发梢回落停住。下一镜全景起幅。",
  } };
  const plan = validator.extractCameraPlan(shot);
  expect(plan.scale).toBe("MS");
  expect(plan.exitScale).toBe("MCU");
  const unrelated = validator.extractCameraPlan({ shotId: "S1", fields: {
    composition: "中景，主体在画面中央", [field]: "背景全景环境保持清晰；下一镜特写起幅。",
  } });
  expect(unrelated.scale).toBe("MS");
  expect(unrelated.exitScale).toBe("MS");
  const nextShotTarget = validator.extractCameraPlan({ shotId: "S1", fields: {
    composition: "中景，主体在画面中央", [field]: "末段为下一镜全景起幅预留视线空间。",
  } });
  expect(nextShotTarget.exitScale).toBe("MS");
});

it("keeps a final explicit composition boundary ahead of conflicting secondary and stale design fields", () => {
  const plan = new CoherenceValidator().extractCameraPlan({ shotId: "S1", camera: { shot_size: "wide" },
    timeline: "全景起幅，特写落幅", fields: {
      composition: "中景起幅，缓慢后拉至全景落幅",
      camera_movement: "末段特写落幅", timeline: "末段近景落幅",
    } });
  expect([plan.scale, plan.exitScale]).toEqual(["MS", "FS"]);
});

it("does not use a late end-scale mention to hide a real unmotivated incoming jump", () => {
  const report = new CoherenceValidator().validate([
    { shotId: "S1", fields: { composition: "特写，固定" } },
    { shotId: "S2", fields: { composition: "全景起幅，末段推至特写落幅", transition: "硬切" } },
  ]);
  expect(report.passed).toBe(false);
  expect(report.issueCount.critical).toBe(2);
});

it.each([
  "不另加硬切", "不硬切", "禁止使用硬切", "无需硬切", "避免 hard_cut",
  "no hard_cut", "do not use hard cut", "without a hard cut",
])("does not interpret a prohibited transition as a positive hard cut: %s", (negative) => {
  expect(criticalRules(`0.3秒叠化，${negative}`)).toEqual(["R1_scale_jump"]);
});

it.each([
  "硬切", "hard_cut", "hard cut", "直接切", "禁止叠化，改为硬切",
  "不使用叠化而硬切", "不另加硬切；随后使用硬切", "不改变色调，硬切",
])("keeps a genuine positive unmotivated hard cut blocked: %s", (positive) => {
  expect(criticalRules(positive)).toEqual(["R1_scale_jump", "R4_transition_mismatch"]);
});

it("checks the complete incoming declaration beyond the diagnostic summary", () => {
  const transition = `入场：${"保持人物动作、色彩与环境连续。".repeat(12)}随后采用硬切。出场：不另加硬切。`;
  expect(criticalRules(transition)).toEqual(["R1_scale_jump", "R4_transition_mismatch"]);
  const plan = new CoherenceValidator().extractCameraPlan({ shotId: "S2", fields: { composition: "全景", transition } });
  expect(plan.transition).toBe(transition);
  const report = new CoherenceValidator().validate([{ shotId: "S2", fields: { composition: "全景", transition } }]);
  expect(report.shotPlans[0].transition.length).toBeLessThanOrEqual(80);
});

it("keeps incoming and outgoing transition declarations in their own boundary", () => {
  expect(criticalRules("入场：0.3秒叠化。出场：硬切交给下一镜。")).toEqual(["R1_scale_jump"]);
  expect(criticalRules("上一镜→本镜：0.3秒叠化。本镜→下一镜：硬切。"))
    .toEqual(["R1_scale_jump"]);
  expect(criticalRules("出场：硬切交给下一镜。")).toEqual(["R1_scale_jump"]);
  expect(criticalRules("入场：硬切。出场：禁止硬切。"))
    .toEqual(["R1_scale_jump", "R4_transition_mismatch"]);
  expect(criticalRules("入场：叠化。出场：硬切，motivation: reveal。"))
    .toEqual(["R1_scale_jump"]);
});

it("still honors an existing valid incoming motivation and rejects an unknown motivation", () => {
  expect(criticalRules("入场：硬切，motivation: reveal。出场：淡出。")).toEqual([]);
  expect(criticalRules("入场：硬切，motivation: invented。出场：淡出。"))
    .toEqual(["R1_scale_jump", "R4_transition_mismatch"]);
});

it("does not flag a prohibited soft transition as an affirmative strict-mode overkill", () => {
  const report = new CoherenceValidator({ strictness: "strict" }).validate([
    { shotId: "S1", fields: { composition: "中景" } },
    { shotId: "S2", fields: { composition: "近景", transition: "硬切，不叠化，不淡入" } },
  ]);
  expect(report.issues.some((issue: Issue) => issue.rule === "R4_transition_overkill")).toBe(false);
});

it.each(["smooth_dissolve", "fade_out"])("retains strict-mode detection for the existing positive soft method %s", (method) => {
  const validate = (transition: string) => new CoherenceValidator({ strictness: "strict" }).validate([
    { shotId: "S1", fields: { composition: "中景" } },
    { shotId: "S2", fields: { composition: "近景", transition } },
  ]);
  expect(validate(method).issues.some((issue: Issue) => issue.rule === "R4_transition_overkill")).toBe(true);
  expect(validate(`no ${method}`).issues.some((issue: Issue) => issue.rule === "R4_transition_overkill")).toBe(false);
});

it("keeps empty or unknown scale and transition inputs non-mutating", () => {
  const shots = [{ shotId: "S1", fields: {} }, { shotId: "S2", fields: { composition: "主体沿对角线排列" } }];
  const before = structuredClone(shots);
  const report = new CoherenceValidator().validate(shots);
  expect(report.shotPlans.every((p: { scale: string | null; exitScale: string | null }) => p.scale === null && p.exitScale === null)).toBe(true);
  expect(report.issueCount.critical).toBe(0);
  expect(shots).toEqual(before);
});
