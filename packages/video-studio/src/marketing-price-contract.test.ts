import { createRequire } from "node:module";
import { afterEach, describe, expect, it } from "vitest";
import { installVendorMarketingPriceBridge } from "./marketing-price-contract.js";
import { videoRuntimeRoot } from "./runtime-root.js";
import path from "node:path";

const require = createRequire(import.meta.url);
const { JennyLoomEngine } = require(path.join(videoRuntimeRoot(import.meta.url), "vendor/supermickey/hyperreality-system/engines/data-mining-engine/index.js"));
const restores: Array<() => void> = [];
afterEach(() => { while (restores.length) restores.pop()!(); });

describe("营销价格原币种装订与零报价边界", () => {
  it.each([
    [[{ amount: 0, currency: "USD" }, { amount: 0, currency: "CNY" }], "USD 0；CNY 0"],
    [[{ amount: 0, currency: "CNY" }], "CNY 0"],
  ])("全零价仍有来源与正确摘要：%j", (samples, expected) => {
    restores.push(installVendorMarketingPriceBridge());
    const engine = new JennyLoomEngine({ mode: "api" }); engine.a5.store = null;
    const input = { name: "真实试用产品" };
    const raw = { A1: { identity: { name: input.name, specs: {}, prices: samples.map(price => ({ ...price, source_url: "https://source.example.com/offer" })) }, images: [] }, A2: { reviews: [] }, A3: { competitors: [] } };
    const original = JSON.stringify(raw);
    const result = engine.assemble(engine.plan(input).trace_id, input, raw);
    expect(result.ok).toBe(true);
    expect(result.dossier.identity.price_band).toBe(expected);
    expect(result.cards.insight_card.market_position.price_band).toBe(expected);
    expect(result.dossier.provenance.filter((item: { claim_ref: string }) => item.claim_ref === "identity.price_band")).toHaveLength(samples.length);
    expect(result.dossier.gaps).not.toContain("未采集到价格信息，price_band 为空");
    expect(JSON.stringify(raw)).toBe(original);
  });

  it("原始金额null或空值不变成零价；并发持有者释放一个后桥仍有效", () => {
    const first = installVendorMarketingPriceBridge(); restores.push(first);
    restores.push(installVendorMarketingPriceBridge()); first();
    const engine = new JennyLoomEngine({ mode: "api" }); engine.a5.store = null;
    const output = engine.a1.distill({ identity: { name: "产品", prices: [{ amount: null, currency: "USD" }, { amount: "", currency: "CNY" }] }, images: [] }, { input: { name: "产品" } });
    expect(output.identity.price_band).toBe("");
  });
});
