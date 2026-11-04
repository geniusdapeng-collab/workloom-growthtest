import { createRequire } from "node:module";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { videoRuntimeRoot } from "./runtime-root.js";
import { installVendorDiscoveryFixBridge, installVendorDiscoveryNarrativeBridge } from "./vendor-compat.js";

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
