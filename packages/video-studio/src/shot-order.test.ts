import { describe, expect, it } from "vitest";
import { checkShotOrder } from "./shot-order.js";

const expected = ["NC-01", "NC-02", "NC-03", "NC-04"];

describe("checkShotOrder", () => {
  it("顺序与分镜一致 → 放行", () => {
    const check = checkShotOrder(expected, ["NC-01", "NC-02", "NC-03", "NC-04"]);
    expect(check.ok).toBe(true);
    expect(check.detail).toMatch(/与分镜一致/);
  });

  it("为卡点把两镜对调 → 拦下并指出第几位错", () => {
    const check = checkShotOrder(expected, ["NC-01", "NC-03", "NC-02", "NC-04"]);
    expect(check.ok).toBe(false);
    expect(check.firstDivergence).toEqual({ index: 1, expected: "NC-02", actual: "NC-03" });
    expect(check.detail).toMatch(/顺序被打乱/);
  });

  it("整镜取舍（少一镜）不算打乱顺序，但缺镜要报出来", () => {
    const check = checkShotOrder(expected, ["NC-01", "NC-02", "NC-04"]);
    expect(check.ok).toBe(false);
    expect(check.detail).toMatch(/镜头集合与分镜不一致/);
  });

  it("媒资库复用路径允许重排，但必须有重组依据", () => {
    const reordered = ["NC-04", "NC-01", "NC-03", "NC-02"];
    expect(checkShotOrder(expected, reordered, "reuse-assembly").ok).toBe(false);
    const withPlan = checkShotOrder(expected, reordered, "reuse-assembly", { reusePlan: "按夜景色温递进重排" });
    expect(withPlan.ok).toBe(true);
    expect(withPlan.detail).toMatch(/允许重组/);
  });
});
