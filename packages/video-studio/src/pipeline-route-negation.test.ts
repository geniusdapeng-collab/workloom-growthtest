import { describe, expect, it, vi } from "vitest";
import { routeVideoPipeline, scoreRoute } from "./pipeline-router.js";

describe("视频路由保留用户明确的否定选择", () => {
  it.each([
    ["不要营销片，走叙事片", "narrative"],
    ["不要叙事片，走营销片，商品名：星野风扇", "marketing"],
    ["不做营销片，而是叙事片", "narrative"],
    ["不做叙事片，而是营销片，商品名：星野风扇", "marketing"],
    ["不要口播片，走叙事片", "narrative"],
    ["走叙事片，不要营销片", "narrative"],
    ["走营销片，商品名：星野风扇，不要叙事片", "marketing"],
    ["不用营销管线，用通用管线", "narrative"],
    ["不要走营销管线，按通用管线拍清晨", "narrative"],
    ["不要营销片，走口播片", "explainer"],
    ["走叙事片，不要用口播管线", "narrative"],
    ["不要营销片，后来改为走营销片，商品名：星野风扇", "marketing"],
  ])("%s → %s", async (text, route) => {
    const llmCall = vi.fn();
    const decision = await routeVideoPipeline({ text }, { llmCall });
    expect(decision.route).toBe(route);
    expect(llmCall).not.toHaveBeenCalled();
  });

  it("只有否定而没有正向选择时，不借商品锚点重新选择已禁止的营销线", async () => {
    const text = "不要营销片，商品名：星野风扇";
    expect(scoreRoute(text).explicit).toBeUndefined();
    const decision = await routeVideoPipeline({ text });
    expect(decision.route).toBe("clarify");
    expect(decision.clarify?.missing).toEqual(["route"]);
  });

  it("规则强信号和模型都不能恢复用户已禁止的管线", async () => {
    const metadata = { dataMining: { name: "星野风扇" } };
    for (const text of ["不要营销片，给商品做带货投放视频", "不要营销片，制作一条视频"]) {
      const decision = await routeVideoPipeline({ text, metadata }, {
        llmCall: async () => JSON.stringify({ route: "marketing", confidence: 0.99, product: { name: "星野风扇" } }),
      });
      expect(decision.route).toBe("clarify");
    }
  });
});
