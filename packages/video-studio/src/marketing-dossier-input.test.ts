import { describe, expect, it } from "vitest";
import { sourceBoundMarketingAssemblyRaw, verifiedMarketingDossierInput } from "./marketing-dossier-input.js";

describe("已审营销事实的装订投影", () => {
  it("零值、布尔值、特殊规格键只附加原来源，不改已审raw、不新增规格", () => {
    const raw = { A1: { identity: { name: "已审产品", specs: { "a/b~c": 0, source: false, url: "https://service.example.com" } } },
      A2: { reviews: [] }, A3: { competitors: [] } };
    const snapshot = JSON.stringify(raw);
    const projected = sourceBoundMarketingAssemblyRaw(raw, { "a/b~c": "https://source.example.com/spec", source: "https://source.example.com/flag",
      url: "https://source.example.com/url", unused: "https://source.example.com/not-a-fact" });
    expect((projected.A1 as any).identity.specs).toEqual({
      "a/b~c": { value: 0, source_url: "https://source.example.com/spec" },
      source: { value: false, source_url: "https://source.example.com/flag" },
      url: { value: "https://service.example.com", source_url: "https://source.example.com/url" },
    });
    expect(JSON.stringify(raw)).toBe(snapshot);
    expect(verifiedMarketingDossierInput(raw)).toEqual({ name: "已审产品" });
  });

  it.each(["missing", "partial", "inherited"])("%s来源映射在装订前明确失败，不能再落无来源档案", kind => {
    const raw = { A1: { identity: { name: "已审产品", specs: { 风量: "9 档", 功率: "10 W" } } } };
    const sources = kind === "partial" ? { 风量: "https://source.example.com/spec" }
      : kind === "inherited" ? Object.create({ 风量: "https://source.example.com/spec", 功率: "https://source.example.com/spec" }) : {};
    expect(() => sourceBoundMarketingAssemblyRaw(raw, sources)).toThrow("MARKETING_SPEC_SOURCE_REQUIRED");
    expect(raw.A1.identity.specs).toEqual({ 风量: "9 档", 功率: "10 W" });
  });
});
