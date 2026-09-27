import { describe, expect, it } from "vitest";
import { aggregateQuality, type QualityCheck } from "./quality-evidence.js";
const check = (id: string, status: QualityCheck["status"], required = true): QualityCheck => ({ id, status, required, detail: id });
describe("quality evidence aggregation", () => {
  it("empty, missing, duplicated or unverified required checks cannot pass", () => {
    expect(aggregateQuality([])).toBe("unverified");
    expect(aggregateQuality([check("a", "passed")], ["b"])).toBe("unverified");
    expect(aggregateQuality([check("a", "passed"), check("a", "passed")])).toBe("unverified");
    expect(aggregateQuality([check("a", "unverified")])).toBe("unverified");
  });
  it("required failure wins; nonapplicability remains explicit", () => {
    expect(aggregateQuality([check("a", "failed"), check("b", "unverified")])).toBe("failed");
    expect(aggregateQuality([check("a", "not_applicable")])).toBe("not_applicable");
    expect(aggregateQuality([check("a", "passed"), check("b", "not_applicable")])).toBe("passed");
    expect(aggregateQuality([check("a", "passed"), check("b", "failed", false)])).toBe("passed");
  });
});
