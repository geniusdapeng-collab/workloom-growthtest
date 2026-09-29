import { describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  PRODUCT_ARCHIVE_SCHEMA,
  PRODUCT_ARCHIVE_SOURCE_PRIORITY,
  loadProductArchives,
  selectProductArchive,
  sha256FileSync,
  verifyProductArchive,
  type ProductArchive
} from "./product-archive.js";

/** 多商品方案（公司 / 方案 / 商品 三层）与型号点单的校验口径 */
const dirs: string[] = [];
function directory(): string { const dir = mkdtempSync(join(tmpdir(), "product-archive-multi-")); dirs.push(dir); return dir; }
function photo(dir: string, name = "hero.png"): { file: string; sha256: string; bytes: number } {
  mkdirSync(join(dir, "photos"), { recursive: true });
  const file = join(dir, "photos", name);
  writeFileSync(file, randomBytes(70_000));
  return { file: `photos/${name}`, sha256: sha256FileSync(file), bytes: 70_000 };
}
function base(dir: string, overrides: Partial<ProductArchive> = {}): ProductArchive {
  const image = photo(dir);
  return {
    schemaVersion: PRODUCT_ARCHIVE_SCHEMA,
    id: "demo-frontdesk",
    displayName: "示例品牌 AI 智慧前台（自助机 + 小程序）",
    type: "product",
    model: "DEMO-02",
    company: "示例企业",
    brand: "示例品牌",
    aliases: ["自助入住机"],
    source: {
      kind: "user-upload",
      priority: PRODUCT_ARCHIVE_SOURCE_PRIORITY["user-upload"],
      reviewStatus: "owner-confirmed",
      providedBy: "示例品牌智慧酒店生态产品解决方案.pptx",
      extraction: { method: "pptx-slide-keyword-mapping", verified: false }
    },
    photos: [{ id: "hero", file: image.file, role: "hero", sha256: image.sha256, bytes: image.bytes }],
    specs: { parameters: [{ name: "型号", value: "DEMO-02", source: "slide 3" }] },
    ...overrides
  };
}

describe("多商品方案档案（company / solution / product）", () => {
  it("商品档案缺图不可用；公司/方案档案允许只挂索引与证据", () => {
    const productDir = directory();
    const broken = base(productDir, { photos: [] });
    expect(verifyProductArchive(broken, { dir: productDir }).map((issue) => issue.code)).toContain("photos-empty");

    const companyDir = directory();
    const company = base(companyDir, { id: "示例企业", type: "company", photos: [], relations: { products: ["demo-frontdesk"], solutions: ["suit-1"] } });
    expect(verifyProductArchive(company, { dir: companyDir }).filter((issue) => issue.hard)).toEqual([]);

    const solutionDir = directory();
    const solution = base(solutionDir, { id: "suit-1", type: "solution", photos: [], relations: { includes: [{ id: "demo-frontdesk", role: "自助入住终端" }] } });
    expect(verifyProductArchive(solution, { dir: solutionDir }).filter((issue) => issue.hard)).toEqual([]);
  });

  it("方案档案必须登记成员商品；公司档案缺成员索引只给软提示", () => {
    const solutionDir = directory();
    const solution = base(solutionDir, { type: "solution", photos: [], relations: { includes: [] } });
    expect(verifyProductArchive(solution, { dir: solutionDir }).map((issue) => issue.code)).toContain("solution-includes");

    const companyDir = directory();
    const company = base(companyDir, { type: "company", photos: [], relations: {} });
    const issues = verifyProductArchive(company, { dir: companyDir });
    expect(issues.find((issue) => issue.code === "company-relations")?.hard).toBe(false);
  });

  it("参数必须带来源：缺 source 是软提示，缺 name/value 是硬问题", () => {
    const dir = directory();
    const withoutSource = base(dir, { specs: { parameters: [{ name: "屏幕尺寸", value: "27英寸" }] } });
    const sourceIssue = verifyProductArchive(withoutSource, { dir }).find((issue) => issue.code === "parameter-source");
    expect(sourceIssue?.hard).toBe(false);

    const incomplete = base(dir, { specs: { parameters: [{ name: "", value: "27英寸", source: "slide 3" }] } });
    expect(verifyProductArchive(incomplete, { dir }).map((issue) => issue.code)).toContain("parameter-incomplete");
  });

  it("按型号点单命中商品档案（含 variants 型号）", () => {
    const root = directory();
    const dir = join(root, "demo-frontdesk"); mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "profile.json"), JSON.stringify(base(dir, { variants: [{ name: "立式机", model: "DEMO-02" }] })), "utf8");
    const library = loadProductArchives(root);
    expect(selectProductArchive(library.archives, "DEMO-02")?.archive?.id).toBe("demo-frontdesk");
    expect(selectProductArchive(library.archives, "自助入住机")?.archive?.id).toBe("demo-frontdesk");
  });

  it("同一个商品在库里有公司/方案/商品三层时不互相顶替（各按 id/名称解析）", () => {
    const root = directory();
    for (const [id, type, extra] of [
      ["示例企业", "company", { relations: { products: ["demo-frontdesk"] }, photos: [] }],
      ["示例品牌-智慧酒店生态方案", "solution", { relations: { includes: [{ id: "demo-frontdesk" }] }, photos: [] }],
      ["demo-frontdesk", "product", {}]
    ] as const) {
      const dir = join(root, id); mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "profile.json"), JSON.stringify(base(dir, { id, type, ...(extra as object) })), "utf8");
    }
    const library = loadProductArchives(root);
    expect(library.archives).toHaveLength(3);
    expect(selectProductArchive(library.archives, "示例企业")?.archive?.type).toBe("company");
    expect(selectProductArchive(library.archives, "示例品牌-智慧酒店生态方案")?.archive?.type).toBe("solution");
    expect(selectProductArchive(library.archives, "demo-frontdesk")?.archive?.type).toBe("product");
  });
});
