import { createRequire } from "node:module";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const base = resolve(import.meta.dirname, "../../../vendor/supermickey/hyperreality-system");
const { ProfileResolver } = require(resolve(base, "engines/script-engine/core/profile-resolver.js"));
const { HyperrealitySystem } = require(resolve(base, "index.js"));

const upstream = { theme: "机械与弯道", description: "场地内的器械展示", type: "商业广告", duration_sec: 30, aspect_ratio: "9:16", platform: "抖音", platform_id: "douyin" };
const audience = {
  primaryAudience: { ageRange: null, gender: null, interests: ["器械运动"], consumptionLevel: null },
  audienceBasis: "creative-hypothesis", audienceEvidenceQuote: null,
  demographicEvidence: { ageRange: null, gender: null, consumptionLevel: null },
  emotionTriggers: ["动势"], contentExpectations: ["清楚看到操作过程"],
};

function llmResolver() {
  const prompts: string[] = [];
  return {
    prompts,
    resolver: new ProfileResolver({ llmEngine: { reasonStructured: async (prompt: string) => {
      prompts.push(prompt);
      return { success: true, data: { genre: "机械展示", profile: { duration_target: 120, aspect_ratio: "16:9", narrative_mode: "commercial", dialogue_density: "none" } } };
    } } }),
  };
}

describe("native discovery production profile and audience evidence", () => {
  it("keeps confirmed duration and aspect in the nested production profile despite model drift", async () => {
    const { resolver, prompts } = llmResolver();
    const output = await resolver.resolve(upstream);
    expect(output.profile).toMatchObject({ duration_target: 30, aspect_ratio: "9:16" });
    expect(prompts[0]).toContain("30");
    expect(prompts[0]).toContain("9:16");
    expect(prompts[0]).not.toContain("不出现品牌logo");
    expect(prompts[0]).toContain("禁止按题材新增");
  });

  it("includes confirmed technical inputs in cache identity", async () => {
    const { resolver, prompts } = llmResolver();
    const first = await resolver.resolve(upstream);
    const same = await resolver.resolve({ ...upstream });
    const changed = await resolver.resolve({ ...upstream, duration_sec: 45, aspect_ratio: "1:1" });
    expect(same).toEqual(first);
    expect(changed.profile).toMatchObject({ duration_target: 45, aspect_ratio: "1:1" });
    expect(prompts).toHaveLength(2);
  });

  it("retains explicit technical inputs when no model is available", async () => {
    const output = await new ProfileResolver().resolve(upstream);
    expect(output.profile).toMatchObject({ duration_target: 30, aspect_ratio: "9:16" });
  });

  it("does not treat invalid technical inputs as confirmed", async () => {
    const output = await new ProfileResolver().resolve({ ...upstream, duration_sec: "invalid", aspect_ratio: "bad" });
    expect(output.profile).toMatchObject({ duration_target: 60, aspect_ratio: "16:9" });
  });

  it("keeps top-level and nested native conversion values identical", async () => {
    const system = Object.create(HyperrealitySystem.prototype);
    system._profileResolver = llmResolver().resolver;
    const output = await system._convertDiscoveryToRequirementList({ audienceProfile: audience, sceneStructure: {}, riskAssessment: {} }, upstream);
    expect(output).toMatchObject({ targetDuration: 30, aspectRatio: "9:16", productionProfile: { duration_target: 30, aspect_ratio: "9:16" } });
  });

  it("persists separate raw customer text and confirmed parameters for G4 instead of enriched theme prose", async () => {
    const system = Object.create(HyperrealitySystem.prototype);
    system._profileResolver = llmResolver().resolver;
    const discovery = { upstreamFields: { description: "系统扩展的指导", _originalStoryText: "含自动追加画像的故事" },
      audienceProfile: audience, sceneStructure: {}, riskAssessment: {} };
    const prior = discovery.upstreamFields;
    const raw = "只拍器械运动，保留品牌结尾。";
    await system._convertDiscoveryToRequirementList(discovery, { ...upstream, _workloomCustomerIntent: raw });
    expect(discovery.upstreamFields).toMatchObject({ _workloomCustomerIntent: raw, duration_sec: 30,
      aspect_ratio: "9:16", platform_id: "douyin", description: "系统扩展的指导" });
    expect(prior).not.toHaveProperty("_workloomCustomerIntent");
  });

  it("uses the validated audience hypothesis and rejects a profile author's extra prohibition", async () => {
    const system = Object.create(HyperrealitySystem.prototype);
    system._profileResolver = { resolve: async () => ({ genre: "器械展示", profile: {
      duration_target: 30, aspect_ratio: "9:16", audience: "25-30岁高消费男性",
      special_constraints: ["不出现品牌logo"],
    } }) };
    const output = await system._convertDiscoveryToRequirementList({ audienceProfile: audience, sceneStructure: {},
      riskAssessment: { businessConstraints: ["品牌尾帧逐字保留"] } }, upstream);
    expect(output.productionProfile.audience).toContain("创作假设");
    expect(output.productionProfile.audience).not.toContain("25-30");
    expect(output.specialConstraints).toEqual([]);
    expect(output.productionProfile.special_constraints).toEqual([]);
    expect(output.contentConstraints).toEqual(["品牌尾帧逐字保留"]);
    const explicit = await system._convertDiscoveryToRequirementList({ audienceProfile: audience, sceneStructure: {} },
      { ...upstream, special_constraints: ["只使用已授权标识", "", 12] });
    expect(explicit.productionProfile.special_constraints).toEqual(["只使用已授权标识"]);
  });

  it("renders missing demographics as unspecified and retains the creative-hypothesis label", () => {
    const system = Object.create(HyperrealitySystem.prototype);
    const body = system._renderRequirementContract("机械展示", { brief: { duration: 30, aspectRatio: "9:16" } }, {}, { audienceProfile: audience, sceneStructure: {} });
    expect(body).toContain("创作假设");
    expect(body).toContain("客户未指定");
    expect(body).not.toContain("不限性别");
  });

  it("does not fabricate demographics or named references in native fallback PRD", () => {
    const system = Object.create(HyperrealitySystem.prototype);
    const prd = system._generateMinimalPRD({ upstreamFields: upstream });
    expect(prd.audienceProfile.primaryAudience).toMatchObject({ ageRange: null, gender: null, consumptionLevel: null });
    expect(prd.audienceProfile.audienceBasis).toBe("creative-hypothesis");
    expect(prd.referenceCases.filmReferences).toEqual([]);
    expect(prd.productPositioning).toMatchObject({ targetDuration: 30, aspectRatio: "9:16", targetPlatform: "抖音" });
  });

  it("preserves the validated discovery audience and references in native fallback PRD", () => {
    const system = Object.create(HyperrealitySystem.prototype);
    const references = { filmReferences: [], adReferences: [], styleReferences: ["低机位跟拍"] };
    const prd = system._generateMinimalPRD({ upstreamFields: upstream, audienceProfile: audience, referenceCases: references });
    expect(prd.audienceProfile).toEqual(audience);
    expect(prd.referenceCases).toEqual(references);
  });
});
