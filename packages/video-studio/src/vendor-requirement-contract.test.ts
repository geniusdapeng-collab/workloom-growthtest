import { createRequire } from "node:module";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const { RequirementDiscoveryEngine } = require(resolve(import.meta.dirname,
  "../../../vendor/supermickey/hyperreality-system/engines/requirement-discovery-engine.js")) as {
  RequirementDiscoveryEngine: new () => {
    agents: Record<string, {
      _callLLM: (input: Record<string, unknown>, schema: unknown) => Promise<unknown>;
      _validateAndFill: (output: unknown, schema: unknown, input: Record<string, unknown>) => any;
      _fallback: (input: Record<string, unknown>) => any;
      _buildPrompt: (input: Record<string, unknown>) => string;
      run: (input: Record<string, unknown>, schema: unknown) => Promise<any>;
    }>;
    generateMarkdown: (discovery: any) => string;
  };
};

const input = {
  type: "商业广告", theme: "手作器物的工序", duration_sec: 30,
  description: "展示器物从成形到完成的工序。", visual_style: "局部特写与固定机位",
  target_audience: "本片创作假设：对材料与手作过程感兴趣、想看完整工序的观众。",
  _workloomCustomerIntent: "制作30秒器物工序短片，无台词，保留工具与环境声。",
};

function audience() {
  return {
    primaryAudience: {
      ageRange: "25-30", gender: "all", occupation: "城市白领", consumptionLevel: "medium",
      interestTags: ["材料质感", "完整工序"],
    },
    secondaryAudience: ["对手作细节感兴趣的观看者"],
    emotionTriggers: ["工具落下前的停顿", "成品脱模瞬间"],
    painPoints: ["想看完整动作而不是无关切镜"],
    contentExpectations: ["动作前后可读", "保留工具声"],
  };
}

function scene() {
  return {
    opening: { duration: 8, purpose: "工具接近材料建立待完成的动作", keyElements: ["工具", "材料"] },
    scenes: [{ index: 1, duration: 14, purpose: "连续展示成形工序后取下成品", keyElements: ["器物"], emotionalBeat: "climax" }],
    ending: { duration: 8, purpose: "成品与材料同框展示工序结果", keyElements: ["成品"] },
    totalDuration: 999, sceneCount: 2, narrativeArc: "linear",
    requiredActions: ["保留工具与环境声"], requiredProps: ["工具"],
  };
}

function discovery(engine: InstanceType<typeof RequirementDiscoveryEngine>, profile: any): any {
  return {
    upstreamFields: input, audienceProfile: profile,
    sceneStructure: engine.agents.scene!._validateAndFill(scene(), {}, input),
    riskAssessment: { technicalRisks: [], mitigationSuggestions: [] },
    referenceCases: { filmReferences: [], adReferences: [], styleReferences: ["局部特写与固定机位"] },
  };
}

describe("native G3 customer evidence and scene contract", () => {
  it("counts actual opening, body and ending instead of trusting the author's contradictory count", () => {
    const engine = new RequirementDiscoveryEngine();
    const value = engine.agents.scene!._validateAndFill(scene(), {}, input);
    expect(value.sceneCount).toBe(3);
    expect(value.totalDuration).toBe(30);
    expect(value.requiredActions).toEqual(scene().requiredActions);
    expect(value.scenes).toEqual(scene().scenes);
    expect(engine.generateMarkdown(discovery(engine, audience()))).toContain("**总场景数**: 3个");
  });

  it("derives fractional duration and permits an opening plus ending with no invented body", () => {
    const engine = new RequirementDiscoveryEngine();
    const value = engine.agents.scene!._validateAndFill({ ...scene(), scenes: [],
      opening: { ...scene().opening, duration: 2.5 }, ending: { ...scene().ending, duration: 3.25 } }, {}, input);
    expect(value.sceneCount).toBe(2);
    expect(value.totalDuration).toBe(5.75);
    expect(value.scenes).toEqual([]);
  });

  it.each([10, 30, 45, 120])("keeps fallback node counts and duration consistent at %ss", duration_sec => {
    const engine = new RequirementDiscoveryEngine();
    const value = engine.agents.scene!._fallback({ ...input, duration_sec });
    const nodes = [value.opening, ...value.scenes, value.ending];
    expect(value.sceneCount).toBe(nodes.length);
    expect(nodes.reduce((sum: number, node: any) => sum + node.duration, 0)).toBe(duration_sec);
  });

  it("does not require an invented demographic or a film quota in the author prompt", () => {
    const engine = new RequirementDiscoveryEngine();
    const audiencePrompt = engine.agents.audience!._buildPrompt(input);
    const referencePrompt = engine.agents.reference!._buildPrompt(input);
    expect(audiencePrompt).toContain("null");
    expect(audiencePrompt).toContain("demographicEvidence");
    expect(audiencePrompt).toContain("本片创作假设");
    expect(audiencePrompt).not.toContain("ageRange 必须从枚举中选择");
    expect(referencePrompt).toContain("filmReferences=[]");
    expect(referencePrompt).not.toContain("至少一部同文化语境");
    expect(referencePrompt).not.toContain("filmReferences 2-4 个");
    expect(engine.agents.scene!._buildPrompt(input)).toContain("sceneCount 等于 opening、scenes 与 ending 的实际节点数之和");
  });

  it("carries the real run input into audience validation and clears all unsupported demographics", async () => {
    const engine = new RequirementDiscoveryEngine();
    engine.agents.audience!._callLLM = async () => audience();
    const value = await engine.agents.audience!.run(input, {});
    expect(value.primaryAudience).toEqual({ ...audience().primaryAudience,
      ageRange: null, gender: null, occupation: null, consumptionLevel: null });
    expect(value.audienceBasis).toBe("creative-hypothesis");
    expect(value.demographicEvidence).toEqual({ ageRange: null, gender: null, occupation: null, consumptionLevel: null });
    expect(value.excludedDemographics).toHaveLength(4);
    expect(value.primaryAudience.interestTags).toEqual(audience().primaryAudience.interestTags);
    expect(value.emotionTriggers).toEqual(audience().emotionTriggers);
    const markdown = engine.generateMarkdown(discovery(engine, value));
    expect(markdown).toContain("本片创作假设");
    expect(markdown).toContain("年龄段: 未指定");
    expect(markdown).toContain("性别: 未指定");
    expect(markdown).not.toContain("性别: 女性为主");
    expect(markdown).not.toContain("性别: 不限");
    expect(markdown).not.toContain("消费水平: 低");
  });

  it("retains client supplied demographics with exact per-field evidence", () => {
    const engine = new RequirementDiscoveryEngine();
    const stated = "受众为40岁以上女性，职业是教师，消费能力中等。";
    const value = engine.agents.audience!._validateAndFill({ ...audience(),
      audienceBasis: "customer-provided", audienceEvidenceQuote: stated,
      primaryAudience: { ...audience().primaryAudience, ageRange: "40岁以上", gender: "female", occupation: "教师" },
      demographicEvidence: { ageRange: "40岁以上", gender: "女性", occupation: "教师", consumptionLevel: "消费能力中等" },
    }, {}, { ...input, _workloomCustomerIntent: `制作工序短片。${stated}` });
    expect(value.primaryAudience).toMatchObject({ ageRange: "40岁以上", gender: "female", occupation: "教师", consumptionLevel: "medium" });
    expect(value.audienceBasis).toBe("customer-provided");
    expect(value.audienceEvidenceQuote).toBe(stated);
    expect(value.excludedDemographics).toEqual([]);
  });

  it("rejects invented evidence and incompatible values even when a different demographic occurs in the source", () => {
    const engine = new RequirementDiscoveryEngine();
    const value = engine.agents.audience!._validateAndFill({ ...audience(),
      audienceBasis: "customer-provided", audienceEvidenceQuote: "观众为女性教师。",
      demographicEvidence: { ageRange: "25-30岁", gender: "女性", occupation: "教师", consumptionLevel: "中等" },
      primaryAudience: { ...audience().primaryAudience, gender: "male", occupation: "工程师" },
    }, {}, { ...input, _workloomCustomerIntent: "观众为女性教师。" });
    expect(value.primaryAudience).toMatchObject({ ageRange: null, gender: null, occupation: null, consumptionLevel: null });
  });

  it("does not treat an enriched upstream description as customer evidence when a raw intent exists", () => {
    const engine = new RequirementDiscoveryEngine();
    const quote = "受众为25-30岁男性白领，消费能力中等。";
    const value = engine.agents.audience!._validateAndFill({ ...audience(), audienceBasis: "customer-provided", audienceEvidenceQuote: quote,
      demographicEvidence: { ageRange: "25-30岁", gender: "男性", occupation: "白领", consumptionLevel: "消费能力中等" },
    }, {}, { ...input, _originalStoryText: quote });
    expect(value.audienceBasis).toBe("creative-hypothesis");
    expect(value.primaryAudience.ageRange).toBeNull();
    expect(value.primaryAudience.gender).toBeNull();
  });

  it("does not promote a creative hypothesis to client supplied demographics because of a residual quote", () => {
    const engine = new RequirementDiscoveryEngine();
    const quote = "受众为25-30岁男性，消费能力中等。";
    const value = engine.agents.audience!._validateAndFill({ ...audience(), audienceBasis: "creative-hypothesis",
      audienceEvidenceQuote: quote,
      demographicEvidence: { ageRange: "25-30岁", gender: "男性", occupation: null, consumptionLevel: "消费能力中等" },
    }, {}, { ...input, _workloomCustomerIntent: quote });
    expect(value.audienceBasis).toBe("creative-hypothesis");
    expect(value.audienceEvidenceQuote).toBeNull();
    expect(value.primaryAudience.ageRange).toBeNull();
    expect(value.primaryAudience.gender).toBeNull();
  });

  it.each([
    "30岁女性模特",
    "请用30岁女性模特作为主角拍器物广告；客户未指定受众。",
  ])("does not mistake a role or an unspecified audience for audience evidence: %s", quote => {
    const engine = new RequirementDiscoveryEngine();
    const source = "请用30岁女性模特作为主角拍器物广告；客户未指定受众。";
    const value = engine.agents.audience!._validateAndFill({ ...audience(),
      audienceBasis: "customer-provided", audienceEvidenceQuote: quote,
      primaryAudience: { ...audience().primaryAudience, ageRange: "30岁", gender: "female" },
      demographicEvidence: { ageRange: "30岁", gender: "女性", occupation: null, consumptionLevel: null },
    }, {}, { ...input, _workloomCustomerIntent: source });
    expect(value.audienceBasis).toBe("creative-hypothesis");
    expect(value.primaryAudience.ageRange).toBeNull();
    expect(value.primaryAudience.gender).toBeNull();
  });

  it("keeps role facts before the audience clause out of audience demographics", () => {
    const engine = new RequirementDiscoveryEngine();
    const source = "请用30岁女性模特拍摄，目标受众为喜欢工序特写的观看者。";
    const value = engine.agents.audience!._validateAndFill({ ...audience(),
      audienceBasis: "customer-provided", audienceEvidenceQuote: source,
      primaryAudience: { ...audience().primaryAudience, ageRange: "30岁", gender: "female" },
      demographicEvidence: { ageRange: "30岁", gender: "女性", occupation: null, consumptionLevel: null },
    }, {}, { ...input, _workloomCustomerIntent: source });
    expect(value.audienceBasis).toBe("customer-provided");
    expect(value.primaryAudience.ageRange).toBeNull();
    expect(value.primaryAudience.gender).toBeNull();
    expect(value.primaryAudience.interestTags).toEqual(audience().primaryAudience.interestTags);
  });

  it("does not treat a generated target_audience as customer text without any original input", () => {
    const engine = new RequirementDiscoveryEngine();
    const quote = "目标受众为25-30岁男性，消费能力中等。";
    const value = engine.agents.audience!._validateAndFill({ ...audience(),
      audienceBasis: "customer-provided", audienceEvidenceQuote: quote,
      demographicEvidence: { ageRange: "25-30岁", gender: "男性", occupation: null, consumptionLevel: "中等" },
    }, {}, { target_audience: quote });
    expect(value.audienceBasis).toBe("creative-hypothesis");
    expect(value.primaryAudience.ageRange).toBeNull();
  });

  it("does not adopt a population explicitly excluded by the customer", () => {
    const engine = new RequirementDiscoveryEngine();
    const quote = "受众不是25-30岁女性。";
    const value = engine.agents.audience!._validateAndFill({ ...audience(),
      audienceBasis: "customer-provided", audienceEvidenceQuote: quote,
      primaryAudience: { ...audience().primaryAudience, gender: "female" },
      demographicEvidence: { ageRange: "25-30岁", gender: "女性", occupation: null, consumptionLevel: null },
    }, {}, { ...input, _workloomCustomerIntent: quote });
    expect(value.primaryAudience.ageRange).toBeNull();
    expect(value.primaryAudience.gender).toBeNull();
  });

  it("preserves affirmative audience attributes when a different group is excluded in another clause", () => {
    const engine = new RequirementDiscoveryEngine();
    const quote = "目标受众为40岁以上女性，排除25-30岁男性。";
    const value = engine.agents.audience!._validateAndFill({ ...audience(),
      audienceBasis: "customer-provided", audienceEvidenceQuote: quote,
      primaryAudience: { ...audience().primaryAudience, ageRange: "40岁以上", gender: "female" },
      demographicEvidence: { ageRange: "40岁以上", gender: "女性", occupation: null, consumptionLevel: null },
    }, {}, { ...input, _workloomCustomerIntent: quote });
    expect(value.primaryAudience.ageRange).toBe("40岁以上");
    expect(value.primaryAudience.gender).toBe("female");
  });

  it.each(["不得把受众设为25-30岁女性。", "受众设为25-30岁女性"])(
    "checks the raw population occurrence when a quote omits its negative prefix: %s", quote => {
      const engine = new RequirementDiscoveryEngine();
      const value = engine.agents.audience!._validateAndFill({ ...audience(),
        audienceBasis: "customer-provided", audienceEvidenceQuote: quote,
        primaryAudience: { ...audience().primaryAudience, gender: "female" },
        demographicEvidence: { ageRange: "25-30岁", gender: "女性", occupation: null, consumptionLevel: null },
      }, {}, { ...input, _workloomCustomerIntent: "不得把受众设为25-30岁女性。" });
      expect(value.audienceBasis).toBe("creative-hypothesis");
      expect(value.primaryAudience.ageRange).toBeNull();
      expect(value.primaryAudience.gender).toBeNull();
    });

  it("does not borrow audience context from an earlier sentence for a character's demographic", () => {
    const engine = new RequirementDiscoveryEngine();
    const quote = "受众为手作爱好者。主角是30岁女性模特。";
    const value = engine.agents.audience!._validateAndFill({ ...audience(),
      audienceBasis: "customer-provided", audienceEvidenceQuote: quote,
      primaryAudience: { ...audience().primaryAudience, ageRange: "30岁", gender: "female", occupation: "模特" },
      demographicEvidence: { ageRange: "30岁", gender: "女性", occupation: "模特", consumptionLevel: null },
    }, {}, { ...input, _workloomCustomerIntent: quote });
    expect(value.primaryAudience).toMatchObject({ ageRange: null, gender: null, occupation: null });
  });

  it("does not borrow a character clause after an audience clause in the same sentence", () => {
    const engine = new RequirementDiscoveryEngine();
    const quote = "受众为手作爱好者，主角是30岁女性模特。";
    const value = engine.agents.audience!._validateAndFill({ ...audience(),
      audienceBasis: "customer-provided", audienceEvidenceQuote: quote,
      primaryAudience: { ...audience().primaryAudience, ageRange: "30岁", gender: "female", occupation: "模特" },
      demographicEvidence: { ageRange: "30岁", gender: "女性", occupation: "模特", consumptionLevel: null },
    }, {}, { ...input, _workloomCustomerIntent: quote });
    expect(value.primaryAudience).toMatchObject({ ageRange: null, gender: null, occupation: null });
  });

  it.each(["", "，不指定受众人口属性"])(
    "does not classify the audience's viewing object as the audience population: %s", explicitUnknown => {
      const engine = new RequirementDiscoveryEngine();
      const quote = "目标受众观看30岁女性模特的器物操作";
      const value = engine.agents.audience!._validateAndFill({ ...audience(),
        audienceBasis: "customer-provided", audienceEvidenceQuote: quote,
        primaryAudience: { ...audience().primaryAudience, ageRange: "30岁", gender: "female", occupation: "模特" },
        demographicEvidence: { ageRange: "30岁", gender: "女性", occupation: "模特", consumptionLevel: null },
      }, {}, { ...input, _workloomCustomerIntent: `${quote}${explicitUnknown}。` });
      expect(value.primaryAudience).toMatchObject({ ageRange: null, gender: null, occupation: null });
    });

  it("retains the model profession when the customer defines the audience itself as that population", () => {
    const engine = new RequirementDiscoveryEngine();
    const quote = "目标受众为30岁女性模特并喜欢观看器物操作。";
    const value = engine.agents.audience!._validateAndFill({ ...audience(),
      audienceBasis: "customer-provided", audienceEvidenceQuote: quote,
      primaryAudience: { ...audience().primaryAudience, ageRange: "30岁", gender: "female", occupation: "模特" },
      demographicEvidence: { ageRange: "30岁", gender: "女性", occupation: "模特", consumptionLevel: null },
    }, {}, { ...input, _workloomCustomerIntent: quote });
    expect(value.primaryAudience).toMatchObject({ ageRange: "30岁", gender: "female", occupation: "模特" });
  });

  it("does not remove the raw instruction to leave population unspecified by cropping its quote", () => {
    const engine = new RequirementDiscoveryEngine();
    const quote = "目标受众为30岁女性";
    const value = engine.agents.audience!._validateAndFill({ ...audience(),
      audienceBasis: "customer-provided", audienceEvidenceQuote: quote,
      primaryAudience: { ...audience().primaryAudience, ageRange: "30岁", gender: "female" },
      demographicEvidence: { ageRange: "30岁", gender: "女性", occupation: null, consumptionLevel: null },
    }, {}, { ...input, _workloomCustomerIntent: `原先${quote}，本片不指定受众人口属性。` });
    expect(value.primaryAudience.ageRange).toBeNull();
    expect(value.primaryAudience.gender).toBeNull();
  });

  it("requires an unambiguous affirmative population clause when an extracted quote repeats", () => {
    const engine = new RequirementDiscoveryEngine();
    const quote = "受众为25-30岁女性";
    const value = engine.agents.audience!._validateAndFill({ ...audience(),
      audienceBasis: "customer-provided", audienceEvidenceQuote: quote,
      primaryAudience: { ...audience().primaryAudience, gender: "female" },
      demographicEvidence: { ageRange: "25-30岁", gender: "女性", occupation: null, consumptionLevel: null },
    }, {}, { ...input, _workloomCustomerIntent: `不得把${quote}。明确的${quote}。` });
    expect(value.primaryAudience.ageRange).toBeNull();
    expect(value.primaryAudience.gender).toBeNull();
  });

  it("renders the explicitly separate raw customer input, including an empty value, without enriched guidance", () => {
    const engine = new RequirementDiscoveryEngine();
    for (const raw of ["客户原文仅要求工序短片。", ""]) {
      const value = discovery(engine, audience());
      value.upstreamFields = { ...input, _workloomCustomerIntent: raw, _originalStoryText: "enriched host instruction must not appear" };
      const markdown = engine.generateMarkdown(value);
      expect(markdown).not.toContain("enriched host instruction");
      if (raw) expect(markdown).toContain(raw);
    }
  });

  it("renders legacy reference fixtures without assuming a newly added array exists", () => {
    const engine = new RequirementDiscoveryEngine();
    const value = discovery(engine, audience());
    value.referenceCases = { filmReferences: [], styleReferences: [] };
    expect(() => engine.generateMarkdown(value)).not.toThrow();
  });

  it("has no demographic or named work defaults on the no-model path", () => {
    const engine = new RequirementDiscoveryEngine();
    const profile = engine.agents.audience!._fallback(input);
    expect(profile.primaryAudience).toMatchObject({ ageRange: null, gender: null, occupation: null, consumptionLevel: null });
    expect(profile.audienceBasis).toBe("creative-hypothesis");
    const refs = engine.agents.reference!._fallback(input);
    expect(refs.filmReferences).toEqual([]);
    expect(refs.adReferences).toEqual([]);
    expect(refs.styleReferences).toContain(input.visual_style);
  });

  it("removes unsupported film and brand proposals while retaining executable unbranded techniques", () => {
    const engine = new RequirementDiscoveryEngine();
    const value = engine.agents.reference!._validateAndFill({
      filmReferences: [{ title: "《未提供的影片》", relevance: "high", keyTakeaway: "固定机位" }],
      adReferences: [{ brand: "未提供的广告", relevance: "high", keyTakeaway: "局部构图" }],
      styleReferences: ["局部特写与固定机位", "照搬《未提供的影片》的构图"],
    }, {}, input);
    expect(value.filmReferences).toEqual([]);
    expect(value.adReferences).toEqual([]);
    expect(value.styleReferences).toEqual(["局部特写与固定机位"]);
    expect(value.excludedReferences).toHaveLength(3);
  });

  it("retains a client named work only with matching source quote and an explicit limited use notice", () => {
    const engine = new RequirementDiscoveryEngine();
    const quote = "仅参考《客户提供的作品》的固定机位手法，不使用任何片段。";
    const value = engine.agents.reference!._validateAndFill({
      filmReferences: [{ title: "《客户提供的作品》", relevance: "high", keyTakeaway: "固定机位", sourceQuote: quote }],
      adReferences: [], styleReferences: ["固定机位观察工具与材料"],
    }, {}, { ...input, _workloomCustomerIntent: quote });
    expect(value.filmReferences).toHaveLength(1);
    expect(value.filmReferences[0].sourceQuote).toBe(quote);
    expect(value.filmReferences[0].usageRestriction).toBe("仅借鉴拍摄手法，不使用或复刻可识别素材");
    const markdown = engine.generateMarkdown({ ...discovery(engine, audience()),
      upstreamFields: { ...input, _workloomCustomerIntent: quote }, referenceCases: value });
    expect(markdown).toContain("仅借鉴拍摄手法，不使用或复刻可识别素材");
    expect(engine.generateMarkdown({ ...discovery(engine, audience()), referenceCases: value }))
      .not.toContain("《客户提供的作品》");
  });

  it("does not grant a named reference from the customer's prohibition", () => {
    const engine = new RequirementDiscoveryEngine();
    const quote = "不要参考《某作品》，本片只用固定机位。";
    const value = engine.agents.reference!._validateAndFill({
      filmReferences: [{ title: "《某作品》", relevance: "high", keyTakeaway: "固定机位", sourceQuote: quote }],
      adReferences: [], styleReferences: ["照搬《某作品》的机位", "固定机位观察工具与材料"],
    }, {}, { ...input, _workloomCustomerIntent: quote });
    expect(value.filmReferences).toEqual([]);
    expect(value.styleReferences).toEqual(["固定机位观察工具与材料"]);
  });

  it("checks the actual raw reference clause when an author crops away its prohibition", () => {
    const engine = new RequirementDiscoveryEngine();
    const value = engine.agents.reference!._validateAndFill({
      filmReferences: [{ title: "《春日》", relevance: "high", keyTakeaway: "固定机位", sourceQuote: "参考《春日》" }],
      adReferences: [], styleReferences: ["固定机位观察工具与材料"],
    }, {}, { ...input, _workloomCustomerIntent: "不要参考《春日》的镜头。" });
    expect(value.filmReferences).toEqual([]);
  });

  it("rejects an ambiguous repeated reference quote but accepts the complete affirmative clause", () => {
    const engine = new RequirementDiscoveryEngine();
    const source = "不要参考《春日》的故事；仅参考《春日》的固定机位，不使用原片。";
    const normalize = (sourceQuote: string) => engine.agents.reference!._validateAndFill({
      filmReferences: [{ title: "《春日》", relevance: "high", keyTakeaway: "固定机位", sourceQuote }],
      adReferences: [], styleReferences: ["固定机位观察工具与材料"],
    }, {}, { ...input, _workloomCustomerIntent: source });
    expect(normalize("参考《春日》").filmReferences).toEqual([]);
    expect(normalize("仅参考《春日》的固定机位，不使用原片。").filmReferences).toHaveLength(1);
  });
});
