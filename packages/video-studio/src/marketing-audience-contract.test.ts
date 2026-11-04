import { createRequire } from "node:module";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { videoRuntimeRoot } from "./runtime-root.js";
import { installVendorDiscoveryFixBridge, installVendorDiscoveryNarrativeBridge } from "./vendor-compat.js";

const root = videoRuntimeRoot(import.meta.url);
const require = createRequire(join(root, "package.json"));
const { RequirementDiscoveryEngine } = require(join(root,
  "vendor/supermickey/hyperreality-system/engines/requirement-discovery-engine.js"));

function audienceCandidate() {
  return {
    audienceBasis: "customer-provided",
    audienceEvidenceQuote: "目标受众是25-30岁女性茶艺师，消费水平高",
    demographicEvidence: {
      ageRange: "25-30岁", gender: "女性", occupation: "茶艺师", consumptionLevel: "消费水平高",
    },
    primaryAudience: {
      ageRange: "25-30", gender: "female", occupation: "茶艺师", consumptionLevel: "high",
      interestTags: ["茶壶出水细节", "倒茶动作"],
    },
    secondaryAudience: ["希望看清茶壶使用动作的观看者"],
    emotionTriggers: ["茶水从壶嘴落入杯中", "放壶时清脆的接触声"],
    painPoints: [],
    contentExpectations: ["看清出水与收壶动作", "识别本次推广的茶壶"],
  };
}

it("checks native demographic candidates against raw customer intent and keeps the approved theme unchanged", async () => {
  const source = { intent: "制作16秒茶壶广告。\n无台词，画幅9:16，只拍举壶、倒茶和放壶。",
    product: "茶壶", restrictions: ["不得编造用户调查"] };
  const upstream = {
    type: "商业广告", theme: "一壶茶的动作", duration_sec: 16,
    target_audience: "本片创作假设：对茶壶出水和倒茶动作感兴趣的观看者。",
    _originalStoryText: `${source.intent}\n[自动补充画像]25-30岁女性茶艺师，消费水平高`,
    _workloomCustomerIntent: "客户未提供的伪造上游字段",
  };
  const approvedTheme = structuredClone(upstream);
  const llm = { reasonStructured: vi.fn(async () => ({ success: true, data: audienceCandidate() })) };
  const restoreDefaults = installVendorDiscoveryFixBridge();
  const restoreBridge = installVendorDiscoveryNarrativeBridge({ marketingDiscovery: () => source });
  try {
    const engine = new RequirementDiscoveryEngine({ llmEngine: llm });
    const audience = engine.agents.audience;
    const buildPrompt = vi.spyOn(audience, "_buildPrompt");
    const validate = vi.spyOn(audience, "_validateAndFill");
    engine.agents.scene.run = async () => ({ opening: {}, scenes: [], ending: {}, sceneCount: 2 });
    engine.agents.risk.run = async () => ({ technicalRisks: [] });
    engine.agents.reference.run = async () => ({ filmReferences: [] });
    const discovery = await engine.discover(upstream);
    const result = discovery.audienceProfile;
    expect(result.primaryAudience).toMatchObject({ ageRange: null, gender: null, occupation: null, consumptionLevel: null,
      interestTags: audienceCandidate().primaryAudience.interestTags });
    expect(result.audienceBasis).toBe("creative-hypothesis");
    expect(result.emotionTriggers).toEqual(audienceCandidate().emotionTriggers);
    const promptInput = buildPrompt.mock.calls[0]?.[0];
    expect(promptInput).toMatchObject({ _workloomCustomerIntent: source.intent });
    expect(validate.mock.calls[0]?.[2]).toBe(promptInput);
    expect(promptInput).not.toBe(upstream);
    expect(upstream).toEqual(approvedTheme);
    expect(discovery.upstreamFields).not.toHaveProperty("_workloomCustomerIntent");
    expect(llm.reasonStructured).toHaveBeenCalledOnce();
  } finally {
    restoreBridge();
    restoreDefaults();
    vi.restoreAllMocks();
  }
});

it("passes the complete customer text to the native prompt and validation without source claims or global mutation", async () => {
  const source = { intent: "目标受众是25-30岁女性茶艺师，消费水平高。\n用茶壶制作16秒竖屏广告。",
    product: "茶壶", restrictions: ["商品数据仅用来源支持的主张"] };
  const upstream = Object.freeze({ type: "商业广告", theme: "倒茶动作", duration_sec: 16,
    target_audience: "本片创作假设：希望看清出水动作的观看者。", _originalStoryText: "扩展系统证据包含来源规格，但不是客户人口信息。" });
  const llm = { reasonStructured: vi.fn(async () => ({ success: true, data: audienceCandidate() })) };
  const restoreBridge = installVendorDiscoveryNarrativeBridge({ marketingDiscovery: () => source });
  try {
    const engine = new RequirementDiscoveryEngine({ llmEngine: llm });
    const audience = engine.agents.audience;
    const buildPrompt = vi.spyOn(audience, "_buildPrompt");
    const validate = vi.spyOn(audience, "_validateAndFill");
    const result = await audience.run(upstream, {});
    expect(result.primaryAudience).toMatchObject(audienceCandidate().primaryAudience);
    expect(result.audienceBasis).toBe("customer-provided");
    const promptInput = buildPrompt.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(promptInput._workloomCustomerIntent).toBe(source.intent);
    expect(validate.mock.calls[0]?.[2]).toBe(promptInput);
    expect(Object.keys(upstream)).not.toContain("_workloomCustomerIntent");
    expect(upstream._originalStoryText).toBe("扩展系统证据包含来源规格，但不是客户人口信息。");
    expect(JSON.stringify(promptInput._workloomCustomerIntent)).not.toContain("扩展系统证据");
    expect(llm.reasonStructured).toHaveBeenCalledOnce();
  } finally {
    restoreBridge();
    vi.restoreAllMocks();
  }
});

it("preserves unscoped native input and restores the original audience method after the bridge scope", async () => {
  const engineBefore = new RequirementDiscoveryEngine({ llmEngine: null });
  const originals = ["audience", "reference"].map(name => {
    const prototype = Object.getPrototypeOf(engineBefore.agents[name]);
    return { prototype, run: prototype.run, hadOwnRun: Object.hasOwn(prototype, "run") };
  });
  const llm = { reasonStructured: vi.fn(async () => ({ success: true, data: audienceCandidate() })) };
  const restoreBridge = installVendorDiscoveryNarrativeBridge();
  try {
    const engine = new RequirementDiscoveryEngine({ llmEngine: llm });
    const audience = engine.agents.audience;
    const buildPrompt = vi.spyOn(audience, "_buildPrompt");
    const input = { type: "商业广告", target_audience: "客户原文受众", _originalStoryText: "普通原生调用" };
    await audience.run(input, {});
    expect(buildPrompt.mock.calls[0]?.[0]).toBe(input);
    expect(input).not.toHaveProperty("_workloomCustomerIntent");
  } finally {
    restoreBridge();
    vi.restoreAllMocks();
  }
  for (const original of originals) {
    expect(original.prototype.run).toBe(original.run);
    expect(Object.hasOwn(original.prototype, "run")).toBe(original.hadOwnRun);
  }
});

it("rejects a named work found only in enriched theme evidence while preserving unnamed technique proposals", async () => {
  const source = { intent: "制作茶壶的竖屏广告，只拍举壶、倒茶和放壶。", product: "茶壶", restrictions: [] };
  const upstream = Object.freeze({ type: "商业广告", visual_style: "低机位近景，柔和侧光",
    _originalStoryText: `${source.intent}\n[自动参考建议]参考《春日》`,
    _workloomCustomerIntent: "参考《春日》" });
  const candidate = { filmReferences: [{ title: "《春日》", relevance: "high", keyTakeaway: "低机位看清手部动作", sourceQuote: "参考《春日》" }],
    adReferences: [], styleReferences: ["低机位近景看清壶嘴出水", "固定侧光保持釉面高光"] };
  const llm = { reasonStructured: vi.fn(async () => ({ success: true, data: candidate })) };
  const restoreBridge = installVendorDiscoveryNarrativeBridge({ marketingDiscovery: () => source });
  try {
    const engine = new RequirementDiscoveryEngine({ llmEngine: llm });
    const reference = engine.agents.reference;
    const buildPrompt = vi.spyOn(reference, "_buildPrompt");
    const validate = vi.spyOn(reference, "_validateAndFill");
    const result = await reference.run(upstream, {});
    expect(result.filmReferences).toEqual([]);
    expect(result.styleReferences).toEqual(candidate.styleReferences);
    expect(result.excludedReferences).toEqual(expect.arrayContaining([
      expect.objectContaining({ value: candidate.filmReferences[0] }),
    ]));
    const localInput = buildPrompt.mock.calls[0]?.[0];
    expect(localInput).toMatchObject({ _workloomCustomerIntent: source.intent });
    expect(validate.mock.calls[0]?.[2]).toBe(localInput);
    expect(upstream._workloomCustomerIntent).toBe("参考《春日》");
    expect(llm.reasonStructured).toHaveBeenCalledOnce();
  } finally {
    restoreBridge();
    vi.restoreAllMocks();
  }
});

it("retains a customer-named work with its original source quote and explicit technique-only usage limit", async () => {
  const source = { intent: "请参考《春日》的低机位手部近景拍茶壶，不使用该片素材。", product: "茶壶", restrictions: [] };
  const candidate = { filmReferences: [{ title: "《春日》", relevance: "high", keyTakeaway: "低机位看清倒茶手部动作", sourceQuote: "参考《春日》" }],
    adReferences: [], styleReferences: ["低机位近景看清壶嘴出水"] };
  const llm = { reasonStructured: vi.fn(async () => ({ success: true, data: candidate })) };
  const restoreBridge = installVendorDiscoveryNarrativeBridge({ marketingDiscovery: () => source });
  try {
    const engine = new RequirementDiscoveryEngine({ llmEngine: llm });
    const result = await engine.agents.reference.run({ type: "商业广告", _originalStoryText: "系统扩展证据没有该片名" }, {});
    expect(result.filmReferences).toEqual([expect.objectContaining({ ...candidate.filmReferences[0],
      usageRestriction: "仅借鉴拍摄手法，不使用或复刻可识别素材" })]);
    expect(result.styleReferences).toEqual(candidate.styleReferences);
    expect(llm.reasonStructured).toHaveBeenCalledOnce();
  } finally {
    restoreBridge();
  }
});

it("stops the source-bound audience before author dispatch when the checkpoint scope is no longer active", async () => {
  const llm = { reasonStructured: vi.fn(async () => ({ success: true, data: audienceCandidate() })) };
  const restoreBridge = installVendorDiscoveryNarrativeBridge({
    marketingDiscovery: () => ({ intent: "拍茶壶。", product: "茶壶", restrictions: [] }),
    assertActive: () => { throw new Error("STUDIO_CHECKPOINT_WRITE_UNVERIFIED"); },
  });
  try {
    const engine = new RequirementDiscoveryEngine({ llmEngine: llm });
    await expect(engine.agents.audience.run({ type: "商业广告" }, {})).rejects.toThrow("STUDIO_CHECKPOINT_WRITE_UNVERIFIED");
    expect(llm.reasonStructured).not.toHaveBeenCalled();
  } finally {
    restoreBridge();
  }
});
