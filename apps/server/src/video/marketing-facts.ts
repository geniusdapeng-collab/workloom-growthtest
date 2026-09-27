/** 逐主张证据合同。引用由服务复核到保存正文的位置；模型自报 approved/分数不参与此层。 */
import { z } from "zod";
import type { SourceSnapshot } from "./marketing-source-fetcher.js";
import type { IntelStage } from "./data-mining-executor.js";
import { canonicalRenderJson, renderSha256 } from "./gen/compiled-request.js";

const text = z.string().trim().min(1).max(8000);
const url = z.string().url().max(8192);
const factValue = z.union([text, z.number().finite(), z.boolean()]);
const point = z.object({ point: text, source_url: url, channel: z.string().max(200).optional() }).strict();
const a1 = z.object({ identity: z.object({ name: text, brand: text.optional(), category: text.optional(), model: text.optional(),
  specs: z.record(z.string().min(1).max(100), factValue).default({}),
  prices: z.array(z.object({ amount: z.number().finite().nonnegative(), currency: z.string().min(1).max(10), note: text.optional(), source_url: url }).strict()).max(30).default([]),
  official_selling_points: z.array(point).max(30).default([]),
}).strict(), images: z.array(z.object({ url, page_url: url, source: z.string().max(200).optional(), angle: text.optional() }).strict()).max(20).default([]),
  inferred_notes: z.array(z.unknown()).max(0).optional(),
}).strict();
const a2 = z.object({ reviews: z.array(z.object({ text, source: z.string().max(200).optional(), url,
  rating: z.number().min(1).max(5).optional(), suspect: z.boolean().optional(),
}).strict()).max(30) }).strict();
const a3 = z.object({ competitors: z.array(z.object({ name: text, price_band: text.optional(), price_source_url: url.optional(),
  selling_points: z.array(point).min(1).max(15), visual_style: text.optional(), visual_source_url: url.optional(),
  viral_patterns: z.array(z.object({ pattern: text, sample_count: z.number().int().positive(), source_url: url }).strict()).max(10).optional(),
  weakness_notes: text.optional(),
}).strict()).max(3), adjacent_notes: z.array(z.unknown()).max(0).optional() }).strict();
export const extractionSchema = z.object({ payload: z.unknown(), citations: z.array(z.object({
  pointer: z.string().min(1).max(500), sourceId: z.string().min(1).max(100), quote: z.string().min(1).max(6000),
}).strict()).max(200), noEvidenceReason: text.optional() }).strict();
export interface ClaimEvidence {
  claimId: string; stage: IntelStage; pointer: string; value: string | number | boolean;
  sourceId: string; textSha256: string; quote: string; quoteStart: number; quoteEnd: number;
  status: "source-bound";
}
export interface ValidatedStageFacts {
  stage: IntelStage; status: "source_bound" | "no_evidence"; payload: Record<string, unknown>;
  claims: ClaimEvidence[]; noEvidenceReason?: string;
}
const escapePointer = (value: string) => value.replace(/~/g, "~0").replace(/\//g, "~1");
const sourceFields = new Set(["url", "source_url", "page_url", "price_source_url", "visual_source_url", "source", "channel", "suspect"]);
function factLeaves(value: unknown, pointer = "", out = new Map<string, string | number | boolean>()): Map<string, string | number | boolean> {
  if (Array.isArray(value)) value.forEach((entry, i) => factLeaves(entry, `${pointer}/${i}`, out));
  else if (value && typeof value === "object") for (const [key, entry] of Object.entries(value)) {
    if ((!sourceFields.has(key) || pointer === "/identity/specs") && !(key === "angle" && entry === "unknown")) factLeaves(entry, `${pointer}/${escapePointer(key)}`, out);
  }
  else if (["string", "number", "boolean"].includes(typeof value)) out.set(pointer, value as string | number | boolean);
  return out;
}
export function stagePayloadShape(stage: IntelStage, raw: unknown): Record<string, unknown> {
  try { return (stage === "A1" ? a1 : stage === "A2" ? a2 : a3).parse(raw) as Record<string, unknown>; }
  catch (error) { throw new Error(`MARKETING_PAYLOAD_INVALID：${stage} ${error instanceof Error ? error.message : String(error)}`); }
}

export function validateStageFacts(stage: IntelStage, raw: unknown, sources: SourceSnapshot[]): ValidatedStageFacts {
  const extraction = extractionSchema.parse(raw);
  const payload = stagePayloadShape(stage, extraction.payload);
  const sourceMap = new Map(sources.map(source => [source.sourceId, source]));
  if (sourceMap.size !== sources.length) throw new Error("MARKETING_SOURCE_INVALID：来源ID重复");
  const leaves = factLeaves(payload); const covered = new Set<string>(); const claims: ClaimEvidence[] = [];
  for (const citation of extraction.citations) {
    if (!leaves.has(citation.pointer) || covered.has(citation.pointer)) throw new Error(`MARKETING_CITATION_INVALID：主张路径不存在或重复 ${citation.pointer}`);
    const source = sourceMap.get(citation.sourceId);
    if (!source || renderSha256(source.text) !== source.textSha256) throw new Error("MARKETING_CITATION_INVALID：主张引用的正文不可核实");
    const quoteStart = source.text.indexOf(citation.quote);
    if (quoteStart < 0) throw new Error("MARKETING_CITATION_INVALID：引文不是保存正文的连续原文");
    const value = leaves.get(citation.pointer)!;
    if (stage === "A2" && /^\/reviews\/\d+\/text$/.test(citation.pointer) && (typeof value !== "string" || !citation.quote.includes(value))) {
      throw new Error("MARKETING_REVIEW_PARAPHRASED：用户评价必须保留原话，不能改写后宣称引文");
    }
    covered.add(citation.pointer);
    claims.push({ claimId: `CL-${renderSha256(canonicalRenderJson({ stage, pointer: citation.pointer, value, sourceId: source.sourceId, quote: citation.quote })).slice(0, 24)}`,
      stage, pointer: citation.pointer, value, sourceId: source.sourceId, textSha256: source.textSha256,
      quote: citation.quote, quoteStart, quoteEnd: quoteStart + citation.quote.length, status: "source-bound" });
  }
  const missing = [...leaves.keys()].filter(pointer => !covered.has(pointer));
  if (missing.length) throw new Error(`MARKETING_CLAIM_UNSOURCED：${stage} 缺少逐项原文引用 ${missing.join(",")}`);
  const actualUrls = new Map(sources.flatMap(source => [[source.requestedUrl, source], [source.finalUrl, source]] as const));
  const walk = (node: unknown): void => {
    if (Array.isArray(node)) { node.forEach(walk); return; }
    if (!node || typeof node !== "object") return;
    const object = node as Record<string, unknown>;
    for (const [key, value] of Object.entries(object)) {
      if ((key === "url" || key.endsWith("_url")) && typeof value === "string") {
        const image = key === "url" && typeof object.page_url === "string";
        const source = image ? actualUrls.get(object.page_url as string) : actualUrls.get(value);
        if (!source || image && !source.assetUrls.includes(value)) throw new Error(`MARKETING_URL_UNVERIFIED：${key} 不属于实际抓取正文或页面图片`);
      }
      walk(value);
    }
    // 渠道标签从实际URL产生，不能由模型自称“官方/用户授权”。
    const recordUrl = object.page_url ?? object.source_url ?? object.url;
    if (typeof recordUrl === "string" && actualUrls.has(recordUrl)) {
      if ("source" in object) object.source = new URL(recordUrl).hostname;
      if ("channel" in object) object.channel = new URL(recordUrl).hostname;
    }
  };
  walk(payload);
  if (stage === "A1") {
    const identity = payload.identity as { specs: Record<string, unknown>; official_selling_points: unknown[] };
    if (!Object.keys(identity.specs).length && !identity.official_selling_points.length) throw new Error("MARKETING_A1_INCOMPLETE：缺少任何有证据的商品规格或卖点");
  }
  if (!claims.length && (stage === "A1" || !extraction.noEvidenceReason)) throw new Error("MARKETING_EVIDENCE_EMPTY：空站必须明确缺证据原因，不能假称采集通过");
  return { stage, status: claims.length ? "source_bound" : "no_evidence", payload, claims,
    ...(extraction.noEvidenceReason ? { noEvidenceReason: extraction.noEvidenceReason } : {}) };
}

/** 复读已归档的原始payload/citations，不能把落盘“通过”字段当证据。 */
export function revalidateStageFacts(facts: ValidatedStageFacts, sources: SourceSnapshot[]): void {
  const checked = validateStageFacts(facts.stage, { payload: facts.payload, citations: facts.claims.map(claim => ({
    pointer: claim.pointer, sourceId: claim.sourceId, quote: claim.quote,
  })), ...(facts.noEvidenceReason ? { noEvidenceReason: facts.noEvidenceReason } : {}) }, sources);
  if (canonicalRenderJson(checked) !== canonicalRenderJson(facts)) throw new Error("MARKETING_FACTS_CHANGED：原始主张、引证位置或状态与档案不一致");
}
