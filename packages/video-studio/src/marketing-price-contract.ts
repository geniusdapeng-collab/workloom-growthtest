import { createRequire } from "node:module";
import path from "node:path";
import { videoRuntimeRoot } from "./runtime-root.js";
import { installSharedBridge } from "./vendor-compat.js";

type RecordValue = Record<string, unknown>;
type Distill = (raw?: RecordValue, context?: RecordValue) => RecordValue;
type Verify = (packs?: RecordValue, context?: RecordValue) => RecordValue;

function record(value: unknown): RecordValue {
  return value && typeof value === "object" && !Array.isArray(value) ? value as RecordValue : {};
}

/** 原币种分别列示；不把金额跨币种比较，也不在没有汇率证据时自行换算。 */
function mixedCurrencyBands(prices: unknown): string | null {
  if (!Array.isArray(prices)) return null;
  const groups = new Map<string, number[]>();
  for (const item of prices) {
    const price = record(item), amount = price.amount;
    const currency = typeof price.currency === "string" ? price.currency.trim().toUpperCase() : "";
    if (!currency || typeof amount !== "number" || !Number.isFinite(amount) || amount < 0) continue;
    const values = groups.get(currency) ?? [];
    values.push(amount); groups.set(currency, values);
  }
  if (groups.size < 2) return null;
  return [...groups].map(([currency, amounts]) => {
    const low = Math.min(...amounts), high = Math.max(...amounts);
    return `${currency} ${low === high ? low : `${low}-${high}`}`;
  }).join("；");
}

/** G1首次装订和Studio重装订共用；vendor源码保持原字节。 */
export function installVendorMarketingPriceBridge(): () => void {
  return installSharedBridge("vendor-marketing-price/v1", () => {
    const require = createRequire(import.meta.url);
    const directory = path.join(videoRuntimeRoot(import.meta.url), "vendor/supermickey/hyperreality-system/engines/data-mining-engine/agents");
    const collector = (require(path.join(directory, "product-info-collector.js")) as {
      ProductInfoCollector: { prototype: { distill: Distill } };
    }).ProductInfoCollector.prototype;
    const verifier = (require(path.join(directory, "cross-verifier.js")) as {
      CrossVerifier: { prototype: { verify: Verify } };
    }).CrossVerifier.prototype;
    if (typeof collector.distill !== "function" || typeof verifier.verify !== "function") {
      throw new Error("MARKETING_PRICE_CONTRACT_UNAVAILABLE：商品价格装订扩展点不可用");
    }
    const originalDistill = collector.distill, originalVerify = verifier.verify;
    collector.distill = function (raw = {}, context = {}) {
      const output = originalDistill.call(this, raw, context);
      const bands = mixedCurrencyBands(record(raw.identity).prices);
      if (bands) record(output.identity).price_band = bands;
      return output;
    };
    verifier.verify = function (packs = {}, context = {}) {
      const a1 = record(packs.a1), identity = record(a1.identity);
      const bands = typeof identity.price_band === "string" ? identity.price_band : "";
      if (!bands.includes("；")) return originalVerify.call(this, packs, context);
      // 原交叉验证器只有单币种区间合同。其它事实照常验证，价格保留分组，
      // 不用跨币种数值的离散度制造虚假冲突或升级为已交叉确认的同口径价格。
      const output = originalVerify.call(this, { ...packs, a1: { ...a1, identity: { ...identity, price_band: "" } } }, context);
      const verifiedIdentity = record(record(output.verified).identity);
      verifiedIdentity.price_band = bands;
      verifiedIdentity.price_confidence = "reported";
      const checks = record(output.verification_report).checks_run;
      if (Array.isArray(checks)) checks.push("价格样本按原币种分别列示，未汇率换算，不跨币种比较价格离散度");
      return output;
    };
    return () => { collector.distill = originalDistill; verifier.verify = originalVerify; };
  });
}
