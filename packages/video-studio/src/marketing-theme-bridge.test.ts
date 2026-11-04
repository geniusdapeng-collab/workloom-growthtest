import { createRequire } from "node:module";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { videoRuntimeRoot } from "./runtime-root.js";
import { installVendorDiscoveryNarrativeBridge } from "./vendor-compat.js";

it("sends the scoped G2 field contract to the native theme author and retains its authored fields", async () => {
  const root = videoRuntimeRoot(import.meta.url);
  const require = createRequire(join(root, "package.json"));
  const { HyperrealitySystem } = require(join(root, "vendor/supermickey/hyperreality-system/index.js"));
  const { CreativeThemeGenerator } = require(join(root,
    "vendor/supermickey/hyperreality-system/skills/creative-theme-generator/index.js"));
  const source = {
    intent: "为北坡折叠灯拍竖屏短片，快速打开三段支架，最后把灯调暗，无台词，仅收录支架卡扣声。",
    product: "北坡折叠灯",
    restrictions: ["不加入商品报价"],
  };
  const studio = Object.create(HyperrealitySystem.prototype);
  const metadata = { brief: { product: source.product, category: "户外照明", platform: "douyin" } };
  const before = studio._buildThemeInput(source.intent, metadata);
  let active = true;
  const restore = installVendorDiscoveryNarrativeBridge({ marketingDiscovery: () => active ? source : undefined });
  const authored = {
    theme: "三声点亮",
    type: "商业广告",
    tone: "冷酷精密",
    description: "手指快速打开三段支架，最后把灯调暗。",
    target_audience: "创作假设：想在露营装备短片中看清装配动作的观众",
    visual_style: "低机位近景跟拍手指，柔和侧光照亮支架边缘",
    dialogue_requirement: "无台词，仅收录支架卡扣声。",
  };
  const generate = vi.fn(async (_prompt: string) => ({ content: JSON.stringify(authored) }));
  try {
    const generator = new CreativeThemeGenerator({ llmEngine: { generate } });
    const result = await generator.generate(studio._buildThemeInput(source.intent, metadata));
    expect(generate).toHaveBeenCalledOnce();
    const prompt = generate.mock.calls[0]?.[0];
    expect(prompt).toContain(source.intent);
    expect(prompt).toContain("优先于通用提炼心法");
    expect(prompt).toContain("冷酷精密、诗意哀伤中的一项");
    expect(prompt).toContain("明示是本片创作假设");
    expect(prompt).toContain("仅在客户原文明确提供第三方作品时才可提名");
    expect(prompt).toContain("台词字数与配音语速不适用");
    expect(result.tasks[0]).toMatchObject(authored);
    active = false;
    expect(studio._buildThemeInput(source.intent, metadata)).toBe(before);
  } finally {
    restore();
  }
});
