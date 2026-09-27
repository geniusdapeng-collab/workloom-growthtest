import { describe, expect, it } from "vitest";
import { validateStageFacts, revalidateStageFacts } from "./marketing-facts.js";
import { renderSha256 } from "./gen/compiled-request.js";
import type { SourceSnapshot } from "./marketing-source-fetcher.js";
const body = "星野 F3 风量 9 档。价格 399 CNY。评价：低档安静。评分 4。另一款北斗支持 5 档。";
const source: SourceSnapshot = { sourceId: "SRC-1", requestedUrl: "https://source.example.com/f3", finalUrl: "https://source.example.com/f3", redirectChain: [], fetchedAt: new Date().toISOString(), contentType: "text/plain", rawSha256: renderSha256(body), textSha256: renderSha256(body), bytes: Buffer.byteLength(body), text: body, assetUrls: ["https://source.example.com/hero.png"] };
const citation = (pointer: string, quote = body) => ({ pointer, sourceId: source.sourceId, quote });
function fixture() { return { payload: { identity: { name: "星野 F3", specs: { 风量: "9 档" }, official_selling_points: [{ point: "风量 9 档", source_url: source.finalUrl, channel: "假称官方" }] }, images: [] }, citations: [citation("/identity/name"), citation("/identity/specs/风量"), citation("/identity/official_selling_points/0/point")] }; }
describe("逐事实叶子的正文绑定", () => {
  it("正常回填逐项有原文位置，渠道由实际URL产生并可复核", () => {
    const facts = validateStageFacts("A1", fixture(), [source]); expect(facts.status).toBe("source_bound"); expect(facts.claims).toHaveLength(3);
    expect(facts.claims[0]).toMatchObject({ quoteStart: 0, quoteEnd: body.length, textSha256: source.textSha256, status: "source-bound" });
    expect(JSON.stringify(facts.payload)).toContain("source.example.com"); expect(JSON.stringify(facts.payload)).not.toContain("假称官方");
    expect(() => revalidateStageFacts(facts, [source])).not.toThrow();
  });
  it.each(["missing", "duplicate", "wrong-pointer", "wrong-source", "invented-quote", "text-hash", "mixed-fake-url", "inferred"])("%s不能升格事实", kind => {
    const value = fixture(), sources = structuredClone([source]);
    if (kind === "missing") value.citations.pop();
    if (kind === "duplicate") value.citations.push(value.citations[0]!);
    if (kind === "wrong-pointer") value.citations[0]!.pointer = "/identity/unknown";
    if (kind === "wrong-source") value.citations[0]!.sourceId = "SRC-fake";
    if (kind === "invented-quote") value.citations[0]!.quote = "不存在的优势";
    if (kind === "text-hash") sources[0]!.text += "changed";
    if (kind === "mixed-fake-url") value.payload.identity.official_selling_points[0]!.source_url = "https://fake.example.com/";
    if (kind === "inferred") Object.assign(value.payload, { inferred_notes: ["推断"] });
    expect(() => validateStageFacts("A1", value, sources)).toThrow();
  });
  it("规格键叫source/url仍是事实，必须引证；JSON Pointer转义不丢键", () => {
    const value: any = fixture(); value.payload.identity.specs = { source: "产地", "a/b~c": "9 档" };
    expect(() => validateStageFacts("A1", value, [source])).toThrow();
    value.citations = [citation("/identity/name"), citation("/identity/specs/source"), citation("/identity/specs/a~1b~0c"), citation("/identity/official_selling_points/0/point")];
    expect(validateStageFacts("A1", value, [source]).claims).toHaveLength(4);
  });
  it("空A2/A3必须有明确缺证据原因，A1不能空", () => {
    for (const stage of ["A2", "A3"] as const) {
      const payload = stage === "A2" ? { reviews: [] } : { competitors: [] };
      expect(() => validateStageFacts(stage, { payload, citations: [] }, [])).toThrow("MARKETING_EVIDENCE_EMPTY");
      expect(validateStageFacts(stage, { payload, citations: [], noEvidenceReason: "未采到可验证正文" }, []).status).toBe("no_evidence");
    }
    expect(() => validateStageFacts("A1", { payload: { identity: { name: "商品" } }, citations: [], noEvidenceReason: "无" }, [])).toThrow();
  });
  it("评价必须原话，评分单独引证；合法URL不能证明改写评价", () => {
    const value = { payload: { reviews: [{ text: "低档安静", rating: 4, url: source.finalUrl }] }, citations: [citation("/reviews/0/text"), citation("/reviews/0/rating")] };
    expect(validateStageFacts("A2", value, [source]).claims).toHaveLength(2);
    value.payload.reviews[0]!.text = "所有档位绝对无声"; expect(() => validateStageFacts("A2", value, [source])).toThrow("MARKETING_REVIEW_PARAPHRASED");
  });
  it("图片只能来自实际页面候选，不能借合法page_url夹带假图", () => {
    const value: any = fixture(); value.payload.images = [{ url: source.assetUrls[0], page_url: source.finalUrl, angle: "unknown" }];
    expect(validateStageFacts("A1", value, [source]).claims).toHaveLength(3);
    value.payload.images[0].url = "https://other.example.com/fake.png"; expect(() => validateStageFacts("A1", value, [source])).toThrow("MARKETING_URL_UNVERIFIED");
  });
  it.each(["value", "offset", "hash", "status"])("已保存%s变化复读必须拒绝", kind => {
    const facts: any = validateStageFacts("A1", fixture(), [source]);
    if (kind === "value") facts.claims[0].value = "changed";
    if (kind === "offset") facts.claims[0].quoteStart = 1;
    if (kind === "hash") facts.claims[0].textSha256 = "0".repeat(64);
    if (kind === "status") facts.status = "supported";
    expect(() => revalidateStageFacts(facts, [source])).toThrow("MARKETING_FACTS_CHANGED");
  });
});
