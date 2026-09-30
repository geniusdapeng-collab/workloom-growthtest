import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { CREATIVE_CHECK_IDS, describeViolations, scanHardGatePolicy } from "./hard-gate-policy.mjs";

describe("硬闸口径规则（创作口径不得作出厂否决票）", () => {
  it("创作口径 + hard: true 命中（含模板字符串 id 与 shotId 后缀）", () => {
    const source = [
      "checks.push({",
      "  id: `speed-ramp:${shot.shotId}`,",
      "  pass: lastRampVerdict.rich,",
      "  hard: true,",
      "  detail: \"速度坡道\"",
      "});"
    ].join("\n");
    const violations = scanHardGatePolicy(source, { file: "fixture.mts" });
    assert.equal(violations.length, 1);
    assert.equal(violations[0].id, "speed-ramp:${shot.shotId}");
    assert.ok(describeViolations(violations).includes("创作口径硬闸违规"));
  });

  it("hard: false / 按策略切换 / 事实类硬闸 都不拦", () => {
    assert.equal(scanHardGatePolicy("id: \"motion-richness\",\nhard: false", { file: "a.mts" }).length, 0);
    assert.equal(scanHardGatePolicy("id: \"scene-policy\",\nhard: REVIEW_POLICY === \"blocking\"", { file: "b.mts" }).length, 0);
    assert.equal(scanHardGatePolicy("id: \"duration\",\nhard: true", { file: "c.mts" }).length, 0);
    assert.equal(scanHardGatePolicy("id: \"av-sync\",\nhard: true", { file: "d.mts" }).length, 0);
    assert.equal(scanHardGatePolicy("id: \"p0-fields:${shot.shotId}\",\nhard: true", { file: "e.mts" }).length, 0);
  });

  it("窗口外（>12 行）的 hard: true 不误伤", () => {
    const source = ["id: \"motion-richness\",", ...Array.from({ length: 15 }, (_, i) => `// filler ${i}`), "hard: true"].join("\n");
    assert.equal(scanHardGatePolicy(source, { file: "fixture.mts" }).length, 0);
  });

  it("清单本身可审计（不是魔法字符串）", () => {
    assert.ok(CREATIVE_CHECK_IDS.includes("motion-richness"));
    assert.ok(CREATIVE_CHECK_IDS.includes("speed-ramp"));
    assert.ok(CREATIVE_CHECK_IDS.includes("scene-policy"));
  });
});
