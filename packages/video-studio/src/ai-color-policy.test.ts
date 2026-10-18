import { describe, expect, it } from "vitest";
import { defaultAiColorVariants, designContentColor } from "./ai-color-policy.js";
import { assessVariantAxes, buildVariantPlan, resolveDeliveryVariants } from "./deliver.js";

describe("AI color policy", () => {
  it("defaults to original, exact D recipe and content design from the same parent", () => {
    const plans = buildVariantPlan({ master: "/tmp/共同 源.mp4", outDir: "/out", projectId: "P", coverHook: "家人", content: { shots: [{ scene: "家庭人像", duration: 8 }] } });
    expect(plans.map(row => row.variant.id)).toEqual(["original", "warm-story", "content-auto"]);
    expect(plans[0]!.passthrough).toBe(true); expect(plans[0]!.gradeArgs).toEqual([]);
    expect(plans[1]!.variant).toMatchObject({ gradeProfile: "warm-film", gradeIntensity: 0.3 });
    for (const plan of plans.slice(1)) { expect(plan.gradeArgs[plan.gradeArgs.indexOf("--in") + 1]).toBe("/tmp/共同 源.mp4"); expect(plan.gradeArgs).toContain("--no-auto"); }
    expect(plans[1]!.gradeArgs).not.toContain("--lut");
    expect(plans[2]!.variant.colorDecision?.category).toBe("portrait");
  });
  it.each([
    ["产品品牌色", "color-accurate", "natural", 0.12], ["霓虹夜景", "night", "natural", 0.15],
    ["美食餐桌", "food", "natural", 0.28], ["家庭人像", "portrait", "warm-film", 0.18],
    ["森林风景", "landscape", "natural", 0.45], ["运动赛事", "energetic", "high-contrast-social", 0.22],
    ["未声明", "unknown", "natural", 0.12],
  ])("uses declared %s", (scene, category, profile, intensity) => {
    expect(designContentColor({ shots: [{ shotId: "S1", scene, duration: 4 }] })).toMatchObject({ profile, intensity, decision: { category } });
  });
  it("weights duration and limits mixed scenes rather than counting shots", () => {
    const value = designContentColor({ shots: [{ scene: "portrait", duration: 2 }, { scene: "landscape", duration: 8 }] });
    expect(value.decision.category).toBe("landscape"); expect(value.decision.weightedShares.landscape).toBe(0.8);
    expect(designContentColor({ shots: [{ scene: "portrait", duration: 5 }, { scene: "landscape", duration: 5 }] }).decision.category).toBe("mixed");
  });
  it("honors declared color accuracy and protects night scenes before warm intent", () => {
    expect(designContentColor({ colorAccuracy: true, shots: [{ scene: "portrait" }] }).decision.category).toBe("color-accurate");
    expect(designContentColor({ shots: [{ scene: "night portrait" }] }).decision.category).toBe("night");
  });
  it.each([null, {}, { shots: [] }, { shots: [null, "bad", {}] }, { shots: [{ duration: Infinity }, { duration: -1 }] }])("handles missing or malformed attributes without guessing content", input => {
    const result = designContentColor(input); expect(result.decision.category).toBe("unknown");
    expect(Object.values(result.decision.weightedShares).every(Number.isFinite)).toBe(true);
    expect(result.decision.limitations.length).toBeGreaterThan(0);
  });
  it("does not mutate shot data or let a caller change subsequent defaults", () => {
    const content = { shots: [{ scene: "family", lighting: "soft", color_palette: ["blue", "green"] }] }; const before = structuredClone(content);
    const variants = defaultAiColorVariants(content); variants[1]!.gradeIntensity = 1;
    expect(content).toEqual(before); expect(defaultAiColorVariants(content)[1]!.gradeIntensity).toBe(0.3);
  });
  it("retains old recipe IDs when explicitly selected", () => {
    const plans = buildVariantPlan({ master: "m", outDir: "o", projectId: "p", coverHook: "h", variantIds: ["cool-tech", "warm-film", "punchy-social"] });
    expect(plans.map(row => row.variant.gradeProfile)).toEqual(["cool-technical", "warm-film", "high-contrast-social"]);
  });
  it("rejects unknown and duplicate requests instead of silently changing selection", () => {
    expect(() => resolveDeliveryVariants({}, ["typo"])).toThrow(/VARIANT_REQUEST_INVALID/);
    expect(() => resolveDeliveryVariants({}, ["original", "original"])).toThrow(/VARIANT_REQUEST_INVALID/);
  });
  it("rejects invalid intensity and unsafe LUT names before media work", () => {
    const options = { master: "m", outDir: "o", projectId: "p", coverHook: "h" };
    expect(() => buildVariantPlan({ ...options, variants: [{ ...defaultAiColorVariants()[1]!, gradeIntensity: NaN }] })).toThrow(/INTENSITY/);
    expect(() => buildVariantPlan({ ...options, variants: [{ ...defaultAiColorVariants()[1]!, gradeLut: "../secret.cube" }] })).toThrow(/LUT_INVALID/);
  });
});

it("compares actual recipes, including LUT and intensity, for energetic content", () => {
  const variants = defaultAiColorVariants({ shots: [{ scene: "sports" }] }).map((variant, index) => ({ ...variant, coverSha: `cover${index}`, bgmSha: `bgm${index}` }));
  expect(assessVariantAxes(variants).ok).toBe(true);
  variants[2] = { ...variants[2]!, gradeProfile: variants[1]!.gradeProfile, gradeIntensity: variants[1]!.gradeIntensity, gradeLut: variants[1]!.gradeLut };
  expect(assessVariantAxes(variants).ok).toBe(false);
});
