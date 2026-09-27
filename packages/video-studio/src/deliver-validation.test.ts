import { describe, expect, it } from "vitest";
import { assessVariantDistinctness, type VariantSample } from "./deliver.js";
const sample = (variantId: string, value: number): VariantSample => ({
  variantId, frames: [{ r: value, g: value, b: value }], loudness: { lufs: -14, peakDb: -1 },
});
describe("delivery distinctness measurement requirements", () => {
  it.each([{ rows: [] }, { rows: [sample("a", 80)] }])("does not approve fewer than two measured variants", ({ rows }) => {
    expect(assessVariantDistinctness(rows).approved).toBe(false);
  });
  it.each([
    [sample("a", 80), { ...sample("b", 150), frames: [] }],
    [sample("a", 80), sample("a", 150)],
    [sample("a", 80), sample("", 150)],
    [sample("a", 80), sample("b", Number.NaN)],
    [sample("a", 80), sample("b", 256)],
    [sample("a", 80), sample("b", -1)],
    [sample("a", 80), { ...sample("b", 150), loudness: { lufs: Infinity, peakDb: -1 } }],
  ])("rejects malformed evidence %#", (...rows) => {
    expect(assessVariantDistinctness(rows).approved).toBe(false);
  });
  it.each([0, -1, NaN, Infinity])("rejects invalid thresholds %s", (threshold) => {
    const rows = [sample("a", 80), sample("b", 150)];
    expect(assessVariantDistinctness(rows, { videoDelta: threshold, audioDelta: 1 }).approved).toBe(false);
    expect(assessVariantDistinctness(rows, { videoDelta: 6, audioDelta: threshold }).approved).toBe(false);
  });
  it("accepts valid visual differences even when the source has no audio measurement", () => {
    expect(assessVariantDistinctness([{ ...sample("a", 80), loudness: null }, { ...sample("b", 150), loudness: null }]).approved).toBe(true);
  });
  it("rejects identical frames without treating absent loudness as a measured difference", () => {
    expect(assessVariantDistinctness([{ ...sample("a", 80), loudness: null }, sample("b", 80)]).approved).toBe(false);
  });
});
