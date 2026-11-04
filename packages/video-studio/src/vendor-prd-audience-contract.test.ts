import { createRequire } from "node:module";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const native = (file: string) => require(resolve(import.meta.dirname,
  `../../../vendor/supermickey/hyperreality-system/engines/prd-generator/${file}`));
const { CreativeDirectionAgent } = native("agents/agent-2-creative-direction.js");
const { ConstraintSynthesisAgent } = native("agents/agent-4-constraint-synthesis.js");
const { PRDGenerator } = native("prd-generator.js");
const { PRDSchema, ENUM_DEFAULTS } = native("schema/prd-schema-v3.js");
const { HyperrealitySystem } = require(resolve(import.meta.dirname,
  "../../../vendor/supermickey/hyperreality-system/index.js"));

const raw = "制作30秒器物工序短片，无台词，保留工具与环境声。";
const demographics = ["ageRange", "gender", "occupation", "consumptionLevel"] as const;
const emptyDemographics = Object.fromEntries(demographics.map(key => [key, null]));

function profile() {
  return {
    primaryAudience: { ageRange: "25-30", gender: "all", occupation: "城市白领", consumptionLevel: "medium",
      interestTags: ["材料质感", "完整工序"] },
    emotionTriggers: ["工具落下前的停顿", "成品脱模瞬间"],
    contentExpectations: ["动作前后可读", "保留工具声"],
  };
}

function discovery(audienceProfile: any = profile(), source = raw) {
  return {
    upstreamFields: { type: "商业广告", theme: "手作器物的工序", duration_sec: 30,
      _workloomCustomerIntent: source,
      _originalStoryText: "上游生成提案：25-30岁城市白领，消费能力中等。",
      visual_style: "局部特写与固定机位" },
    audienceProfile,
    sceneStructure: { sceneCount: 3, totalDuration: 30, scenes: [] },
    riskAssessment: { technicalRisks: [], businessConstraints: [] },
    referenceCases: { filmReferences: [], adReferences: [], styleReferences: ["固定机位观察工序"] },
  };
}

function customerProfile() {
  const quote = "受众为40岁以上女性，职业是教师，消费能力中等。";
  return { ...profile(), audienceBasis: "customer-provided", audienceEvidenceQuote: quote,
    primaryAudience: { ...profile().primaryAudience, ageRange: "40岁以上", gender: "female", occupation: "教师" },
    demographicEvidence: { ageRange: "40岁以上", gender: "女性", occupation: "教师", consumptionLevel: "消费能力中等" },
    excludedDemographics: [],
  };
}

describe("PRD audience provenance survives native downstream consumers", () => {
  it("keeps absent demographics null even when the entire audience module is missing", () => {
    const value = new ConstraintSynthesisAgent().process(discovery(null), {}, {}, {}).audienceProfile;
    expect(value.primaryAudience).toMatchObject(emptyDemographics);
    expect(value.audienceBasis).toBe("creative-hypothesis");
    expect(value.audienceEvidenceQuote).toBeNull();
    expect(value.demographicEvidence).toEqual(emptyDemographics);
  });

  it("does not promote unsourced G3 demographics or lose the concrete creative interests", () => {
    const input = discovery();
    const before = JSON.stringify(input);
    const value = new ConstraintSynthesisAgent().process(input, {}, {}, {}).audienceProfile;
    expect(value.primaryAudience).toEqual({ ...emptyDemographics, interests: profile().primaryAudience.interestTags });
    expect(value.audienceBasis).toBe("creative-hypothesis");
    expect(value.excludedDemographics).toHaveLength(4);
    expect(value.emotionTriggers).toEqual(profile().emotionTriggers);
    expect(value.contentExpectations).toEqual(profile().contentExpectations);
    expect(JSON.stringify(input)).toBe(before);
  });

  it("retains exact customer evidence and open age/occupation text through the PRD interests mapping", () => {
    const input = customerProfile();
    const value = new ConstraintSynthesisAgent().process(discovery(input, `${raw}${input.audienceEvidenceQuote}`), {}, {}, {}).audienceProfile;
    expect(value.primaryAudience).toEqual({ ageRange: "40岁以上", gender: "female", occupation: "教师", consumptionLevel: "medium",
      interests: input.primaryAudience.interestTags });
    expect(value.audienceBasis).toBe("customer-provided");
    expect(value.audienceEvidenceQuote).toBe(input.audienceEvidenceQuote);
    expect(value.demographicEvidence).toEqual(input.demographicEvidence);
    expect(value.excludedDemographics).toEqual([]);
  });

  it("clears each unsupported field while preserving the real customer audience clause", () => {
    const input = customerProfile();
    delete (input.demographicEvidence as any).occupation;
    input.primaryAudience.gender = "male";
    const value = new ConstraintSynthesisAgent().process(discovery(input, input.audienceEvidenceQuote), {}, {}, {}).audienceProfile;
    expect(value.primaryAudience).toMatchObject({ ageRange: "40岁以上", gender: null, occupation: null, consumptionLevel: "medium" });
    expect(value.demographicEvidence).toEqual({ ...input.demographicEvidence, gender: null, occupation: null });
    expect(value.audienceBasis).toBe("customer-provided");
  });

  it("does not relabel a creative proposal as customer provided because a matching quote survives", () => {
    const input = { ...customerProfile(), audienceBasis: "creative-hypothesis" };
    const value = new ConstraintSynthesisAgent().process(discovery(input, input.audienceEvidenceQuote), {}, {}, {}).audienceProfile;
    expect(value.primaryAudience).toMatchObject(emptyDemographics);
    expect(value.audienceBasis).toBe("creative-hypothesis");
    expect(value.audienceEvidenceQuote).toBeNull();
  });

  it("does not derive an audience demographic from a named performer or an enriched story", () => {
    const actor = "请用30岁女性模特作为主角拍器物广告；客户未指定受众。";
    const input = { ...customerProfile(), audienceEvidenceQuote: actor,
      primaryAudience: { ...profile().primaryAudience, ageRange: "30", gender: "female", occupation: "模特" },
      demographicEvidence: { ageRange: "30岁", gender: "女性", occupation: "模特", consumptionLevel: null } };
    const value = new ConstraintSynthesisAgent().process(discovery(input, actor), {}, {}, {}).audienceProfile;
    expect(value.primaryAudience).toMatchObject(emptyDemographics);
    expect(value.audienceBasis).toBe("creative-hypothesis");
    const enriched = discovery(customerProfile(), "");
    enriched.upstreamFields._originalStoryText = customerProfile().audienceEvidenceQuote;
    expect(new ConstraintSynthesisAgent().process(enriched, {}, {}, {}).audienceProfile.primaryAudience).toMatchObject(emptyDemographics);
  });

  it("builds a director prompt with unknown demographics and explicit creative hypotheses", () => {
    const prompt = new CreativeDirectionAgent()._buildPrompt(discovery());
    const audience = prompt.split("【受众洞察】")[1].split("【场景结构】")[0];
    expect(audience).toContain("本片创作假设");
    expect(audience).toContain("年龄: 未指定");
    expect(audience).toContain("性别: 未指定");
    expect(audience).toContain("职业: 未指定");
    expect(audience).toContain("消费能力: 未指定");
    expect(audience).toContain("材料质感, 完整工序");
    expect(audience).not.toContain("25-30");
    expect(audience).not.toContain("all");
    expect(audience).not.toContain("medium");
  });

  it("shows the customer's exact audience clause and per-field evidence to the director", () => {
    const input = customerProfile();
    const prompt = new CreativeDirectionAgent()._buildPrompt(discovery(input, input.audienceEvidenceQuote));
    const audience = prompt.split("【受众洞察】")[1].split("【场景结构】")[0];
    expect(audience).toContain("客户明确指定");
    expect(audience).toContain(input.audienceEvidenceQuote);
    expect(audience).toContain(JSON.stringify(input.demographicEvidence));
    expect(audience).toContain("40岁以上");
  });

  it("defines null-compatible demographic schema and safe defaults instead of the old population enums", () => {
    const audience = PRDSchema.properties.audienceProfile;
    expect(audience.required).toEqual(expect.arrayContaining(["audienceBasis", "audienceEvidenceQuote", "demographicEvidence"]));
    const fields = audience.properties.primaryAudience.properties;
    for (const key of demographics) expect(fields[key].type).toEqual(["string", "null"]);
    expect(fields.ageRange.enum).toBeUndefined();
    expect(fields.consumptionLevel.enum).toBeUndefined();
    expect(fields.gender.enum).toContain(null);
    expect(ENUM_DEFAULTS.ageRange_audience).toBeNull();
    expect(ENUM_DEFAULTS.gender).toBeNull();
    expect(ENUM_DEFAULTS.consumptionLevel).toBeNull();
    const generator = new PRDGenerator();
    for (const key of demographics) {
      expect(generator._generateFallbackValue(fields[key], `audienceProfile.primaryAudience.${key}`)).toBeNull();
    }
    expect(generator._generateFallbackModule("audienceProfile", {}).primaryAudience).toMatchObject(emptyDemographics);
  });

  it("permits no named film reference in both schema and missing-module fallback paths", () => {
    expect(PRDSchema.properties.referenceCases.properties.filmReferences.minItems).toBe(0);
    expect(new ConstraintSynthesisAgent()._buildReferenceCases(null).filmReferences).toEqual([]);
    expect(new PRDGenerator()._generateFallbackModule("referenceCases", {}).filmReferences).toEqual([]);
  });

  it("keeps excluded population and named reference candidates out of author and user-facing claims", () => {
    const excluded = { field: "ageRange", value: "25-30", quote: null, reason: "customer-demographic-evidence-missing-or-incompatible" };
    const input = discovery({ ...profile(), primaryAudience: { ...profile().primaryAudience, ...emptyDemographics },
      audienceBasis: "creative-hypothesis", audienceEvidenceQuote: null, demographicEvidence: emptyDemographics,
      excludedDemographics: [excluded] });
    (input.referenceCases as any).excludedReferences = [{ title: "《被剔除的示例作品》" }];
    const constraint = new ConstraintSynthesisAgent().process(input, {}, {}, {});
    expect(constraint.audienceProfile.primaryAudience).toMatchObject(emptyDemographics);
    expect(constraint.audienceProfile.excludedDemographics).toEqual([excluded]);
    expect(constraint.referenceCases.filmReferences).toEqual([]);
    const prompt = new CreativeDirectionAgent()._buildPrompt(input);
    expect(prompt).not.toContain("《被剔除的示例作品》");
    expect(prompt.split("【受众洞察】")[1].split("【场景结构】")[0]).not.toContain("25-30");
    const markdown = new PRDGenerator().generateMarkdown({ ...constraint, _workloomCustomerIntent: raw });
    expect(markdown).not.toContain("《被剔除的示例作品》");
    expect(markdown.split("## 9. 受众定位")[1].split("## 10.")[0]).not.toContain("25-30");
  });

  it("uses real PRD generation and Markdown without replacing unknowns on author or fallback paths", async () => {
    const generator = new PRDGenerator();
    generator.agent2.process = async () => generator.agent2.fallback(discovery());
    generator.agent3.process = async () => generator.agent3.fallback(discovery());
    const prd = await generator.generate(discovery());
    expect(prd.audienceProfile.primaryAudience).toMatchObject(emptyDemographics);
    expect(prd._workloomCustomerIntent).toBe(raw);
    const section = generator.generateMarkdown(prd).split("## 9. 受众定位")[1].split("## 10.")[0];
    expect(section).toContain("本片创作假设");
    expect(section).toContain("年龄段**：未指定");
    expect(section).toContain("性别**：未指定");
    expect(section).toContain("职业**：未指定");
    expect(section).toContain("消费能力**：未指定");
    expect(section).not.toMatch(/25-30|\ball\b|\bmedium\b/);
    const fallback = generator._generateFallbackModule("audienceProfile", {});
    expect(fallback.audienceBasis).toBe("creative-hypothesis");
    expect(generator.generateMarkdown({ audienceProfile: fallback })).toContain("**消费能力**：未指定");
  });

  it("retains a source-bound customer clause after PRD generation and reports it with creative extensions labeled", async () => {
    const generator = new PRDGenerator();
    const audience = customerProfile();
    const input = discovery(audience, `${raw}${audience.audienceEvidenceQuote}`);
    generator.agent2.process = async () => generator.agent2.fallback(input);
    generator.agent3.process = async () => generator.agent3.fallback(input);
    const prd = await generator.generate(input);
    const section = generator.generateMarkdown(prd).split("## 9. 受众定位")[1].split("## 10.")[0];
    expect(section).toContain("客户明确指定");
    expect(section).toContain(audience.audienceEvidenceQuote);
    expect(section).toContain("**年龄段**：40岁以上");
    expect(section).toContain("**职业**：教师");
    expect(section).toContain("本片创作假设");
    expect(prd.audienceProfile.demographicEvidence).toEqual(audience.demographicEvidence);
  });

  it.each([false, true])("keeps raw provenance through real native conversion, PRD generation and Markdown (customer=%s)", async customer => {
    const audience = customer ? customerProfile() : profile();
    const source = customer ? `${raw}${customerProfile().audienceEvidenceQuote}` : raw;
    const input = discovery(audience);
    Reflect.deleteProperty(input.upstreamFields, "_workloomCustomerIntent");
    const beforeConversion = input.upstreamFields;
    const system = Object.create(HyperrealitySystem.prototype);
    system._profileResolver = { resolve: async () => ({ genre: "器物工序", presetRef: "commercial",
      profileSource: "llm", profile: { duration_target: 30, aspect_ratio: "9:16", dialogue_density: "none" } }) };
    const requirement = await system._convertDiscoveryToRequirementList(input,
      { ...input.upstreamFields, _workloomCustomerIntent: source, aspect_ratio: "9:16", platform_id: "douyin" });
    expect(beforeConversion).not.toHaveProperty("_workloomCustomerIntent");
    expect(input.upstreamFields).toMatchObject({ _workloomCustomerIntent: source, aspect_ratio: "9:16", platform_id: "douyin" });
    expect(requirement.targetDuration).toBe(30);
    const generator = new PRDGenerator();
    generator.agent2.process = async () => generator.agent2.fallback(input);
    generator.agent3.process = async () => generator.agent3.fallback(input);
    const prd = await generator.generate(input);
    expect(prd._workloomCustomerIntent).toBe(source);
    expect(prd.audienceProfile.primaryAudience).toMatchObject(customer
      ? { ageRange: "40岁以上", gender: "female", occupation: "教师", consumptionLevel: "medium" }
      : emptyDemographics);
    expect(prd.audienceProfile.audienceBasis).toBe(customer ? "customer-provided" : "creative-hypothesis");
    const markdown = generator.generateMarkdown(prd);
    const original = markdown.split("## 📖 用户原始输入（创作素材源）")[1].split("## 1. 项目定义")[0];
    expect(original).toContain(source);
    expect(original).not.toContain("上游生成提案");
    const section = markdown.split("## 9. 受众定位")[1].split("## 10.")[0];
    expect(section).toContain(customer ? customerProfile().audienceEvidenceQuote : "本片创作假设");
    expect(section).not.toContain("25-30");
  });

  it("does not relabel enriched story prose as raw customer input when raw is explicitly empty", () => {
    const generator = new PRDGenerator();
    const markdown = generator.generateMarkdown({ _workloomCustomerIntent: "",
      _originalStoryText: "上游生成提案：25-30岁城市白领", audienceProfile: profile() });
    expect(markdown).not.toContain("## 📖 用户原始输入");
    expect(markdown).not.toContain("上游生成提案");
    const section = markdown.split("## 9. 受众定位")[1].split("## 10.")[0];
    expect(section).toContain("本片创作假设");
    expect(section).toContain("**年龄段**：未指定");
  });
});
