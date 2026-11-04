import { createRequire } from "node:module";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { gateDeterministicChecks } from "./gate-policy.js";

const require = createRequire(import.meta.url);
const { PRDGenerator } = require(resolve(import.meta.dirname,
  "../../../../vendor/supermickey/hyperreality-system/engines/prd-generator/prd-generator.js"));

function draft() {
  return {
    projectDefinition: { projectName: "器物工序", sourceIntent: "展示器物工序" },
    creativeCore: { coreTheme: "器物工序", creativeHook: "连续展示成形动作" },
    audienceProfile: {
      primaryAudience: { ageRange: null, gender: null, occupation: null,
        consumptionLevel: null, interests: ["材料质感", "完整工序"] },
      audienceBasis: "creative-hypothesis", audienceEvidenceQuote: null,
      demographicEvidence: { ageRange: null, gender: null, occupation: null, consumptionLevel: null },
      emotionTriggers: ["成品脱模"], contentExpectations: ["看清完整动作"],
    },
  };
}

describe("PRD demographic evidence at the actual G4 hard gate", () => {
  it("renders absent evidence as human-readable unknowns while retaining structured nulls", () => {
    const input = draft();
    const before = JSON.stringify(input);
    const body = new PRDGenerator().generateMarkdown(input);
    expect(gateDeterministicChecks("G4_PRD", body).filter(check => check.hard && !check.pass)).toEqual([]);
    expect(body).toContain("年龄段：未提供");
    expect(body).toContain("性别：未提供");
    expect(body).toContain("职业：未提供");
    expect(body).toContain("消费能力：未提供");
    expect(JSON.stringify(input)).toBe(before);
    expect(input.audienceProfile.demographicEvidence.ageRange).toBeNull();
  });

  it("continues rejecting an actual unresolved field outside the evidence display", () => {
    const input = draft();
    input.creativeCore.coreTheme = "undefined";
    const checks = gateDeterministicChecks("G4_PRD", new PRDGenerator().generateMarkdown(input));
    expect(checks.find(check => check.id === "no-placeholder")).toMatchObject({ pass: false, hard: true });
  });
});
