import { describe, expect, it } from "vitest";
import { revalidateStageFacts, validateStageFacts } from "./marketing-facts.js";
import { renderSha256 } from "./gen/compiled-request.js";
import type { SourceSnapshot } from "./marketing-source-fetcher.js";

const sourceText = "星野 F3 风量 9 档。我的原话：低档安静，评分 4。北斗风扇支持 5 档，售价 299 元，白色背景，演示扇叶的视频样本 2 个。";
function source(sourceId: string, url: string, text = sourceText, fetchedAt = "2026-11-03T00:00:00.000Z"): SourceSnapshot {
  return { sourceId, requestedUrl: url, finalUrl: url, redirectChain: [], fetchedAt, contentType: "text/plain",
    rawSha256: renderSha256(text), textSha256: renderSha256(text), bytes: Buffer.byteLength(text), text, assetUrls: [] };
}
const first = source("SRC-first", "https://first.example.com/f3");
const other = source("SRC-other", "https://other.example.com/unrelated", "这里是另一页面，不含商品规格、评价或竞品。" );
const citation = (pointer: string) => ({ pointer, sourceId: first.sourceId, quote: sourceText });

describe("事实引用与下游来源归属保持同一来源", () => {
  it("不能把有正文支持的卖点归属给另一个已抓取页面", () => {
    const extraction = { payload: { identity: { name: "星野 F3", specs: { 风量: "9 档" },
      official_selling_points: [{ point: "风量 9 档", source_url: other.finalUrl }] }, images: [] },
    citations: [citation("/identity/name"), citation("/identity/specs/风量"), citation("/identity/official_selling_points/0/point")] };
    expect(() => validateStageFacts("A1", extraction, [first, other])).toThrow("MARKETING_CITATION_SOURCE_MISMATCH");
  });

  it.each(["text", "rating"])("评价%s引文不能借另一已抓取页面作为url", field => {
    const extraction = { payload: { reviews: [{ text: "低档安静", rating: 4, url: other.finalUrl }] },
      citations: [citation("/reviews/0/text"), citation("/reviews/0/rating")] };
    // 只让被测字段指错来源；另一字段仍绑定它自己的真实页面。
    const duplicateText = source(other.sourceId, other.requestedUrl);
    extraction.citations.find(item => !item.pointer.endsWith(`/${field}`))!.sourceId = other.sourceId;
    expect(() => validateStageFacts("A2", extraction, [first, duplicateText])).toThrow("MARKETING_CITATION_SOURCE_MISMATCH");
  });

  it.each(["selling-point", "price", "visual", "viral-pattern", "viral-count"])("竞品%s来源归属必须与引文一致", kind => {
    const competitor: Record<string, unknown> = { name: "北斗风扇", selling_points: [{ point: "支持 5 档", source_url: first.finalUrl }] };
    const citations = [citation("/competitors/0/name"), citation("/competitors/0/selling_points/0/point")];
    if (kind === "selling-point") (competitor.selling_points as Array<Record<string, unknown>>)[0]!.source_url = other.finalUrl;
    if (kind === "price") {
      Object.assign(competitor, { price_band: "299 元", price_source_url: other.finalUrl });
      citations.push(citation("/competitors/0/price_band"));
    }
    if (kind === "visual") {
      Object.assign(competitor, { visual_style: "白色背景", visual_source_url: other.finalUrl });
      citations.push(citation("/competitors/0/visual_style"));
    }
    if (kind.startsWith("viral")) {
      competitor.viral_patterns = [{ pattern: "演示扇叶", sample_count: 2, source_url: other.finalUrl }];
      citations.push(citation("/competitors/0/viral_patterns/0/pattern"), citation("/competitors/0/viral_patterns/0/sample_count"));
      const duplicateText = source(other.sourceId, other.requestedUrl);
      const exemptField = kind === "viral-pattern" ? "sample_count" : "pattern";
      citations.find(item => item.pointer.endsWith(`/${exemptField}`))!.sourceId = other.sourceId;
      expect(() => validateStageFacts("A3", { payload: { competitors: [competitor] }, citations }, [first, duplicateText]))
        .toThrow("MARKETING_CITATION_SOURCE_MISMATCH");
      return;
    }
    expect(() => validateStageFacts("A3", { payload: { competitors: [competitor] }, citations }, [first, other]))
      .toThrow("MARKETING_CITATION_SOURCE_MISMATCH");
  });

  it("两条真实跳转共享最终URL时，以价格引文选择来源快照，不被Map最后项覆盖", () => {
    const priceText = "星野 F3 风量 9 档，售价 399 元。";
    const finalUrl = "https://official.example.com/f3";
    const left = { ...source("SRC-left", "https://search.example.com/redirect-left", priceText, "2026-11-03T00:00:00.000Z"), finalUrl };
    const right = { ...source("SRC-right", "https://search.example.com/redirect-right", priceText, "2026-11-03T00:00:01.000Z"), finalUrl };
    const extraction = { payload: { identity: { name: "星野 F3", specs: { 风量: "9 档" }, prices: [{ amount: 399, currency: "CNY", source_url: finalUrl }] }, images: [] },
      citations: ["/identity/name", "/identity/specs/风量", "/identity/prices/0/amount", "/identity/prices/0/currency"].map(pointer => ({ pointer, sourceId: left.sourceId, quote: priceText })) };
    const facts = validateStageFacts("A1", extraction, [left, right]);
    expect((facts.payload.identity as { prices: Array<{ observedAt: string }> }).prices[0]!.observedAt).toBe(left.fetchedAt);
    expect(() => revalidateStageFacts(facts, [left, right])).not.toThrow();
  });

  it("同一来源的request/final别名与有效逐项引证保持可用", () => {
    const redirected = { ...first, finalUrl: "https://final.example.com/f3" };
    const extraction = { payload: { reviews: [{ text: "低档安静", rating: 4, url: redirected.finalUrl }] },
      citations: [citation("/reviews/0/text"), citation("/reviews/0/rating")] };
    const facts = validateStageFacts("A2", extraction, [redirected]);
    expect(facts.claims).toHaveLength(2);
    expect(() => revalidateStageFacts(facts, [redirected])).not.toThrow();
  });

  it.each(["price", "visual"])("竞品%s值不能在没有对应来源URL时进入档案", kind => {
    const competitor = { name: "北斗风扇", selling_points: [{ point: "支持 5 档", source_url: first.finalUrl }],
      ...(kind === "price" ? { price_band: "299 元" } : { visual_style: "白色背景" }) };
    const pointer = kind === "price" ? "/competitors/0/price_band" : "/competitors/0/visual_style";
    const extraction = { payload: { competitors: [competitor] },
      citations: [citation("/competitors/0/name"), citation("/competitors/0/selling_points/0/point"), citation(pointer)] };
    expect(() => validateStageFacts("A3", extraction, [first])).toThrow("MARKETING_CITATION_SOURCE_MISMATCH");
  });

  it("同finalURL的不同正文图片快照不会被最后项替换", () => {
    const finalUrl = "https://official.example.com/f3";
    const left = { ...first, requestedUrl: "https://search.example.com/left", finalUrl, assetUrls: ["https://official.example.com/hero-left.png"] };
    const right = { ...other, requestedUrl: "https://search.example.com/right", finalUrl, assetUrls: ["https://official.example.com/hero-right.png"] };
    const extraction = { payload: { identity: { name: "星野 F3", specs: { 风量: "9 档" } },
      images: [{ url: left.assetUrls[0], page_url: finalUrl, angle: "unknown" }] },
      citations: [citation("/identity/name"), citation("/identity/specs/风量")] };
    const facts = validateStageFacts("A1", extraction, [left, right]);
    expect((facts.payload.images as Array<{ url: string }>)[0]!.url).toBe(left.assetUrls[0]);
    expect(() => revalidateStageFacts(facts, [left, right])).not.toThrow();
  });

  it("规格键url/source/channel是商品事实，不按来源元数据校验或改写", () => {
    const specs = { url: first.finalUrl, source: "原产地江苏", channel: "双声道", support_url: "https://help.example.com/f3" };
    const extraction = { payload: { identity: { name: "星野 F3", specs }, images: [] },
      citations: [citation("/identity/name"), ...Object.keys(specs).map(key => citation(`/identity/specs/${key}`))] };
    const facts = validateStageFacts("A1", extraction, [first]);
    expect((facts.payload.identity as { specs: unknown }).specs).toEqual(specs);
    expect(() => revalidateStageFacts(facts, [first])).not.toThrow();
  });
});
