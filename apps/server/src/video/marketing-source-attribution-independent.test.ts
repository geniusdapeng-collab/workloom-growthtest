/** Independent MC-007 alias collision: an angle claim must describe an image from that same snapshot. */
import { describe, expect, it } from "vitest";
import { renderSha256 } from "./gen/compiled-request.js";
import { revalidateStageFacts, validateStageFacts } from "./marketing-facts.js";
import type { SourceSnapshot } from "./marketing-source-fetcher.js";

const finalUrl = "https://official.example.test/current-product";
const leftImage = "https://cdn.example.test/left-front.png";
const rightImage = "https://cdn.example.test/right-rear.png";
function snapshot(sourceId: string, image: string, text: string): SourceSnapshot {
  return { sourceId, requestedUrl: `https://search.example.test/${sourceId}`, finalUrl, redirectChain: [], fetchedAt: "2026-11-03T00:00:00.000Z",
    contentType: "text/plain", rawSha256: renderSha256(text), textSha256: renderSha256(text), bytes: Buffer.byteLength(text), text, assetUrls: [image] };
}
const left = snapshot("SRC-left", leftImage, "星野 F3 风量9档。该图片展示商品正面。");
const right = snapshot("SRC-right", rightImage, "星野 F3 风量9档。另一图片展示商品背面。");
const extraction = (image: string) => ({ payload: { identity: { name: "星野 F3", specs: { 风量: "9档" } }, images: [{ url: image, page_url: finalUrl, angle: "正面" }] },
  citations: ["/identity/name", "/identity/specs/风量", "/images/0/angle"].map(pointer => ({ pointer, sourceId: left.sourceId, quote: left.text })) });

describe("snapshot-specific image attribution with a shared final URL", () => {
  it("retains a correctly bound image and its angle through archive revalidation", () => {
    const facts = validateStageFacts("A1", extraction(leftImage), [left, right]);
    expect(() => revalidateStageFacts(facts, [left, right])).not.toThrow();
  });
  it("does not transfer a source-A angle claim onto a source-B image through the shared final-URL alias", () => {
    expect(() => validateStageFacts("A1", extraction(rightImage), [left, right])).toThrow("MARKETING_CITATION_SOURCE_MISMATCH");
  });
});
