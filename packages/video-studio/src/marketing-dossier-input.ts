import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import path from "node:path";
import { videoRuntimeRoot } from "./runtime-root.js";
import { installSharedBridge } from "./vendor-compat.js";

type RecordValue = Record<string, unknown>;

function record(value: unknown): RecordValue {
  return value && typeof value === "object" && !Array.isArray(value) ? value as RecordValue : {};
}

export interface MarketingCreativeRequirements {
  role: "creative-and-delivery";
  intent: string;
  intentSha256: string;
}

const intentDigest = (intent: string): string => createHash("sha256").update(intent).digest("hex");
export const MARKETING_CREATIVE_RESTRICTIONS = [
  "creativeRequirements.intent 是本次创作和交付要求。角色、表演、虚构情节及竞赛结果不得作为真实战绩、人物背书、商品性能或认证的证据。",
  "按 creativeRequirements.intent 的完整原文保留明确要求的披露、屏幕文字、字幕和尾帧；在对应镜头或后期职责中落实。其文字、角色和创作设定不计入商品事实主张。",
  "媒体转述保留来源与报道限定，不能升级为厂家独立确认、当前报价、实测表现或素材使用权。规格与涂装等单项描述不能外推到战绩或性能保证。",
] as const;

export function freezeMarketingCreativeRequirements(intent: string): MarketingCreativeRequirements {
  return { role: "creative-and-delivery", intent, intentSha256: intentDigest(intent) };
}

export function verifyMarketingCreativeRequirements(value: unknown): value is MarketingCreativeRequirements {
  const input = record(value);
  return input.role === "creative-and-delivery" && typeof input.intent === "string" && Boolean(input.intent.trim())
    && input.intentSha256 === intentDigest(input.intent);
}

/** Apply the same evidence wording before both host and Studio A5 assembly emit their cards. */
export function installVendorMarketingReferenceBridge(): () => void {
  return installSharedBridge("vendor-marketing-reference/v1", () => {
    const require = createRequire(import.meta.url);
    const file = path.join(videoRuntimeRoot(import.meta.url),
      "vendor/supermickey/hyperreality-system/engines/data-mining-engine/contracts/summary-cards.js");
    const cardsModule = require(file) as { makeAllCards: (dossier: RecordValue) => RecordValue };
    const original = cardsModule.makeAllCards;
    if (typeof original !== "function") throw new Error("MARKETING_REFERENCE_CONTRACT_UNAVAILABLE");
    cardsModule.makeAllCards = function (dossier) {
      const cards = original.call(this, dossier);
      const manifest = record(cards.portrait_manifest);
      if (!Array.isArray(manifest.reference_images)) throw new Error("MARKETING_REFERENCE_CONTRACT_UNAVAILABLE");
      manifest.handoff_note = manifest.reference_images.length === 0
        ? "本档案没有可交接的商品参考图。不得跳过另行检索和型号、原始来源、使用授权核验；人物定妆照不属于商品参考图。"
        : `档案收录 ${manifest.reference_images.length} 个商品候选图。逐图核验原始来源、型号与使用授权后才能用于制作，候选收录不代表可用。`;
      const points = record(dossier.identity).official_selling_points;
      const reported = Array.isArray(points) ? points.filter(point => record(point).confidence === "reported").length : 0;
      const brief = record(cards.brief_card);
      if (reported > 0) {
        brief.evidence_note = `${String(brief.evidence_note ?? "")}。另有 ${reported} 条来源转述（reported），保留在身份事实底账，不能算作厂商独立确认或自动进入片中卖点。`;
      }
      return cards;
    };
    return () => { cardsModule.makeAllCards = original; };
  });
}

/**
 * 正式营销的装订身份只能来自宿主已审A1，查询线索只供发现来源。
 * Vendor会用input填补raw里缺失的身份字段；两次装订必须使用同一投影，
 * 避免G1首次装订与Studio重装订把未核实品牌、类别或型号重新升级成事实。
 */
export function verifiedMarketingDossierInput(rawByAgent: RecordValue): RecordValue {
  const identity = record(record(rawByAgent.A1).identity);
  const input: RecordValue = {};
  for (const key of ["name", "brand", "category", "model"] as const) {
    const value = identity[key];
    if (value === undefined && key !== "name") continue;
    if (typeof value !== "string" || !value.trim()) {
      throw new Error(`MARKETING_G1_REQUIRED：已审A1的${key}身份字段无效`);
    }
    input[key] = value;
  }
  const competitors = record(rawByAgent.A3).competitors;
  if (Array.isArray(competitors) && competitors.length === 0
    && Array.isArray(identity.official_selling_points) && identity.official_selling_points.length > 0) {
    // Vendor默认把己方卖点与竞品卖点求差集；空竞品语料不能证明“竞品没讲”。
    // 空数组在既有装订合同里显式关闭该推导，己方有证据卖点仍留在A1事实区。
    input.sellingPointCandidates = [];
  }
  return input;
}

/** Vendor规格需对象形态才能登记来源；原始提取及其哈希保持不变，仅给装订器传副本。 */
export function sourceBoundMarketingAssemblyRaw(rawByAgent: RecordValue, specSourceUrls: Record<string, string>): RecordValue {
  const output = structuredClone(rawByAgent);
  const identity = record(record(output.A1).identity);
  if (identity.specs === undefined) return output;
  if (!identity.specs || typeof identity.specs !== "object" || Array.isArray(identity.specs)) {
    throw new Error("MARKETING_SPEC_SOURCE_REQUIRED：已审规格表形状无效");
  }
  identity.specs = Object.fromEntries(Object.entries(identity.specs).map(([key, value]) => {
    const source = Object.hasOwn(specSourceUrls, key) ? specSourceUrls[key] : undefined;
    if (typeof source !== "string" || !source.trim()) {
      throw new Error(`MARKETING_SPEC_SOURCE_REQUIRED：已审规格${key}缺少对应正文来源`);
    }
    return [key, { value, source_url: source }];
  }));
  return output;
}
