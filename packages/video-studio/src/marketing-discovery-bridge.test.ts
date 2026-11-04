import { createRequire } from "node:module";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { videoRuntimeRoot } from "./runtime-root.js";
import { installVendorDiscoveryFixBridge, installVendorDiscoveryNarrativeBridge, normalizeNarrativePrdContract } from "./vendor-compat.js";

it("projects the current marketing contract through native G3 and keeps its real scene props and paired risks", async () => {
  const root = videoRuntimeRoot(import.meta.url);
  const require = createRequire(join(root, "package.json"));
  const { HyperrealitySystem } = require(join(root, "vendor/supermickey/hyperreality-system/index.js"));
  const { RequirementDiscoveryEngine } = require(join(root,
    "vendor/supermickey/hyperreality-system/engines/requirement-discovery-engine.js"));
  const source = { intent: "顾客穿着围裙举起知夏茶壶，倒茶后放下茶壶。尾帧显示原样文字。",
    product: "知夏茶壶", restrictions: ["不加入商品报价"] };
  const opening = { duration: 4, purpose: "顾客穿着围裙举起知夏茶壶。", keyElements: ["围裙", "知夏茶壶"] };
  const ending = { duration: 4, purpose: "顾客放下茶壶并保持把手朝向镜头，最后叠加完整尾帧文字。", keyElements: ["茶壶"] };
  const risks = { technicalRisks: [{ risk: "亮面瓷器反光在跨镜时跳变", level: "medium", impact: "釉面颜色不一致" }],
    mitigationSuggestions: ["在转动茶壶前锁定软光箱和曝光，逐镜对比壶身高光位置。"], businessConstraints: ["不加入商品报价"] };
  const scene = { opening, scenes: [{ index: 1, duration: 8, purpose: "顾客倒茶。", keyElements: ["知夏茶壶"], emotionalBeat: "climax" }],
    ending, totalDuration: 16, sceneCount: 3, narrativeArc: "linear", requiredActions: ["举起知夏茶壶", "倒茶", "放下茶壶"],
    requiredProps: ["围裙", "茶壶"] };
  const llm = { reasonStructured: vi.fn(async (prompt: string) => {
    expect(prompt).toContain(source.intent);
    expect(prompt).toContain(source.restrictions[0]);
    if (prompt.includes("requiredActions")) return { success: true, data: scene };
    expect(prompt).toContain("同一索引一一对应");
    return { success: true, data: risks };
  }) };
  const restoreDefaults = installVendorDiscoveryFixBridge();
  const restoreBridge = installVendorDiscoveryNarrativeBridge({ marketingDiscovery: () => source });
  try {
    const engine = new RequirementDiscoveryEngine({ llmEngine: llm });
    engine.agents.audience.run = async () => ({ primaryAudience: { ageRange: "25-30", gender: "all", interestTags: ["茶"], consumptionLevel: "medium" },
      emotionTriggers: ["手势"], contentExpectations: ["一镜一动作"] });
    engine.agents.reference.run = async () => ({ filmReferences: [], styleReferences: [] });
    const upstream = { type: "商业广告", duration_sec: 16, aspect_ratio: "9:16", platform: "douyin", _originalStoryText: source.intent };
    const discovery = await engine.discover(upstream);
    const studio = Object.create(HyperrealitySystem.prototype);
    studio._profileResolver = { resolve: vi.fn(async () => ({ profile: { aspect_ratio: "16:9" }, genre: "商业广告" })) };
    const requirements = await studio._convertDiscoveryToRequirementList(discovery, upstream);
    const brief = { product: source.product, duration: 16, aspectRatio: "9:16", platform: "douyin" };
    const contract = studio._renderRequirementContract(source.intent, { brief }, requirements, discovery);
    expect(llm.reasonStructured).toHaveBeenCalledTimes(2);
    expect(requirements).toMatchObject({ actions: scene.requiredActions, props: [source.product, ...scene.requiredProps], aspectRatio: "9:16" });
    expect(contract).toContain("**动作**（3）：举起知夏茶壶、倒茶、放下茶壶");
    expect(contract).toContain(ending.purpose);
    expect(contract).toContain(risks.mitigationSuggestions[0]);
    expect(contract).toContain("画幅 9:16");
    const markdown = engine.generateMarkdown(discovery) + contract;
    expect(markdown).toContain("关键元素: 围裙、知夏茶壶");
    expect(markdown).not.toMatch(/手机|湿地反光|雾板遮光/u);
    discovery.sceneStructure.requiredActions = ["喝下未在原文出现的饮料"];
    await expect(studio._convertDiscoveryToRequirementList(discovery, upstream)).rejects.toThrow(/MARKETING_DISCOVERY_UNVERIFIED/u);
    expect(studio._profileResolver.resolve).toHaveBeenCalledOnce();
  } finally {
    restoreBridge();
    restoreDefaults();
  }
});

it("keeps the portrait identity while projecting explicit project wardrobe and approved actions into G4", () => {
  const identity = { id: "chen-zhuo", name: "陈卓", role: "protagonist",
    portraitRef: "bundles/ai-video/library/characters/model-01-chen-zhuo/portraits/v3/平江路讲述人-front.png" };
  const actions = ["抬手检查扣带", "通过训练门架", "解扣后举盔"];
  const source = "陈卓穿专业防护服与护具，抬手检查扣带，通过训练门架，解扣后举盔。";
  const discovery = { _canonicalCharacters: [identity], upstreamFields: { duration_sec: 12, aspect_ratio: "9:16",
    platform: "douyin", _originalStoryText: source }, sceneStructure: {
    opening: { duration: 4, purpose: "室内训练区准备", keyElements: ["护具"] },
    scenes: [{ duration: 4, purpose: "通过室内训练装置", keyElements: ["训练门架"] }],
    ending: { duration: 4, purpose: "安全停下后结束训练", keyElements: ["头盔"] },
  } };
  const original = { characterSystem: { characters: [{ name: "陈卓", costume: "专业防护服与护具" }] }, scenePlan: {},
    projectDefinition: { sourceIntent: source }, creativeCore: { creativeHook: "扣带先出声" } };
  const result = normalizeNarrativePrdContract(original, discovery, { actions, props: ["专业防护服", "护具"] });
  expect(result.characterSystem).toMatchObject({ characters: [expect.objectContaining({ characterId: identity.id,
    costume: "专业防护服与护具", portraitPath: identity.portraitRef, authorization: "real-authorized" })] });
  expect(result.creativeCore).toMatchObject({ creativeHook: "扣带先出声" });
  const shots = result.shotContract as Array<{ purpose: string; keyProps: string[] }>;
  expect(shots).toHaveLength(3);
  actions.forEach((action, index) => expect(shots[index]?.purpose).toContain(action));
  expect(shots.map(shot => shot.keyProps)).toEqual([["护具"], ["训练门架"], ["头盔"]]);
});
