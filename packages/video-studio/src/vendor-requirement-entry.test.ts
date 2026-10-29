import { createRequire } from "node:module";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const { RequirementDiscoveryEngine } = require(
  resolve(import.meta.dirname, "../../../vendor/supermickey/hyperreality-system/engines/requirement-discovery-engine.js"),
) as {
  RequirementDiscoveryEngine: new (options?: Record<string, unknown>) => {
    agents: { scene: { llmEngine: unknown; _callLLM: (input: unknown, schema: unknown) => Promise<unknown> } };
  };
};

describe("isolated SceneArchitect transport", () => {
  it("requests one complete non-thinking JSON response instead of a 4k prose response", async () => {
    const engine = new RequirementDiscoveryEngine();
    const scene = {
      opening: { duration: 5, purpose: "开场用轮胎摩擦烟雾建立赛道冲突", keyElements: ["赛车"] },
      scenes: [
        { index: 1, duration: 8, purpose: "骑手绕车检查车辆并指向车头", keyElements: ["骑手", "赛车"], emotionalBeat: "setup" },
        { index: 2, duration: 10, purpose: "低机位追拍车辆高速压过弯心", keyElements: ["赛车", "弯道"], emotionalBeat: "climax" },
      ],
      ending: { duration: 5, purpose: "人物与车辆静置同框收束品牌信息", keyElements: ["人物", "赛车"] },
      totalDuration: 28,
      sceneCount: 2,
      narrativeArc: "linear",
    };
    const calls: Array<Record<string, unknown>> = [];
    engine.agents.scene.llmEngine = {
      reasonStructured: async () => ({ success: false }),
      reason: async (_prompt: string, options: Record<string, unknown>) => {
        calls.push(options);
        return { success: true, content: JSON.stringify(scene) };
      },
      _extractJsonObject: (text: string) => text,
    };

    const result = await engine.agents.scene._callLLM({
      type: "商业广告", theme: "赛道机械", duration_sec: 30, tone: "克制高燃", description: "赛道专用机车展示",
    }, {});

    expect(result).toEqual(scene);
    expect(calls).toEqual([
      expect.objectContaining({
        maxTokens: 16_384,
        temperature: 0.4,
        forceJson: true,
        thinking: { type: "disabled" },
      }),
    ]);
  });
});
