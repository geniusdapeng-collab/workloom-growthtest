import { afterEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  PRODUCT_ARCHIVE_SCHEMA,
  PRODUCT_ARCHIVE_SOURCE_PRIORITY,
  loadProductArchives,
  normalizeProductName,
  productArchivePromptLines,
  productHeroPhoto,
  selectProductArchive,
  sha256FileSync,
  verifyProductArchive,
  type ProductArchive
} from "./product-archive.js";

const dirs: string[] = [];
function directory(): string { const dir = mkdtempSync(join(tmpdir(), "product-archive-")); dirs.push(dir); return dir; }
afterEach(() => { dirs.splice(0).forEach((dir) => rmSync(dir, { recursive: true, force: true })); });

/** 造一张"够大"的假图（只校验字节/哈希/尺寸口径，不解析内容） */
function writePhoto(dir: string, name: string, bytes = 60_000): { file: string; sha256: string; bytes: number } {
  mkdirSync(join(dir, "photos"), { recursive: true });
  const file = join(dir, "photos", name);
  writeFileSync(file, randomBytes(bytes));
  return { file: `photos/${name}`, sha256: sha256FileSync(file), bytes };
}

function archiveFixture(dir: string, overrides: Partial<ProductArchive> = {}): ProductArchive {
  const photo = writePhoto(dir, "hero.jpg");
  return {
    schemaVersion: PRODUCT_ARCHIVE_SCHEMA,
    id: "demo-kiosk",
    displayName: "演示自助入住机",
    company: "演示酒店科技有限公司",
    brand: "演示",
    aliases: ["DemoKioskAlias"],
    source: { kind: "user-upload", priority: PRODUCT_ARCHIVE_SOURCE_PRIORITY["user-upload"], reviewStatus: "owner-confirmed" },
    photos: [{ id: "hero", file: photo.file, role: "hero", sha256: photo.sha256, bytes: photo.bytes, width: 1200, height: 1600 }],
    specs: { appearance: "银灰色立式机身，正面黑色玻璃触控面，下部取卡口" },
    ...overrides
  };
}

describe("product archive（真实商品档案）", () => {
  it("用户上传档案通过校验，缺证据的系统生成档案不通过", () => {
    const dir = directory();
    const user = archiveFixture(dir);
    expect(verifyProductArchive(user, { dir })).toEqual([]);

    const systemDir = directory();
    const system = archiveFixture(systemDir, {
      id: "demo-kiosk-system",
      source: { kind: "system-generated", priority: PRODUCT_ARCHIVE_SOURCE_PRIORITY["system-generated"] }
    });
    const issues = verifyProductArchive(system, { dir: systemDir });
    expect(issues.filter((issue) => issue.hard).map((issue) => issue.code).sort())
      .toEqual(["system-disclaimer", "system-evidence", "system-queries"]);
  });

  it("系统生成档案登记了检索证据/检索词/免责声明即可用（并提示未客户确认）", () => {
    const dir = directory();
    const system = archiveFixture(dir, {
      id: "demo-kiosk-system",
      source: {
        kind: "system-generated", priority: PRODUCT_ARCHIVE_SOURCE_PRIORITY["system-generated"],
        reviewStatus: "pending-owner-review", searchedQueries: ["演示 自助入住机 产品图"],
        evidence: [{ query: "演示 自助入住机 产品图", url: "https://example.com/product", title: "官方产品页" }],
        disclaimer: "系统检索生成，未经客户确认"
      }
    });
    const issues = verifyProductArchive(system, { dir });
    expect(issues.filter((issue) => issue.hard)).toEqual([]);
    expect(issues.some((issue) => issue.code === "system-review-status")).toBe(false);
  });

  it("图片哈希/大小/路径逃逸都会被拦", () => {
    const dir = directory();
    const archive = archiveFixture(dir);
    archive.photos[0]!.sha256 = "0".repeat(64);
    expect(verifyProductArchive(archive, { dir }).map((issue) => issue.code)).toContain("photo-hash");

    archive.photos[0]!.sha256 = sha256FileSync(join(dir, archive.photos[0]!.file));
    archive.photos[0]!.file = "../outside.jpg";
    expect(verifyProductArchive(archive, { dir }).map((issue) => issue.code)).toContain("photo-path");

    const smallDir = directory();
    const small = archiveFixture(smallDir);
    const tiny = writePhoto(smallDir, "tiny.jpg", 10_000);
    small.photos[0] = { id: "hero", file: tiny.file, role: "hero", sha256: tiny.sha256, bytes: tiny.bytes };
    expect(verifyProductArchive(small, { dir: smallDir }).map((issue) => issue.code)).toContain("photo-size");
  });

  it("选择器支持 id/商品名/别名/公司/品牌，且客户上传优先于系统生成", () => {
    const root = directory();
    const sysDir = join(root, "demo-kiosk"); mkdirSync(sysDir, { recursive: true });
    writeFileSync(join(sysDir, "profile.json"), JSON.stringify(archiveFixture(sysDir, {
      id: "demo-kiosk",
      source: {
        kind: "system-generated", priority: PRODUCT_ARCHIVE_SOURCE_PRIORITY["system-generated"],
        reviewStatus: "pending-owner-review", searchedQueries: ["q"], evidence: [{ query: "q", url: "https://example.com" }], disclaimer: "d"
      }
    })), "utf8");
    const userDir = join(root, "demo-kiosk-user"); mkdirSync(userDir, { recursive: true });
    writeFileSync(join(userDir, "profile.json"), JSON.stringify(archiveFixture(userDir, { id: "demo-kiosk-user" })), "utf8");

    const library = loadProductArchives(root);
    expect(library.archives).toHaveLength(2);
    const byName = selectProductArchive(library.archives, "演示自助入住机");
    expect(byName.archive?.source.kind).toBe("user-upload");
    expect(byName.reason).toContain("user-upload");
    expect(selectProductArchive(library.archives, "演示酒店科技有限公司")?.archive?.source.kind).toBe("user-upload");
    // 显式 id 优先于启发式匹配：写系统档案的 id 就取系统档案（调用方显式指定，系统不替它改主意）
    expect(selectProductArchive(library.archives, "demo kiosk")?.archive?.source.kind).toBe("system-generated");
    // 别名命中时仍按来源优先级取客户上传档
    expect(selectProductArchive(library.archives, "DemoKioskAlias")?.archive?.source.kind).toBe("user-upload");
    expect(selectProductArchive(library.archives, "不存在的商品").archive).toBeNull();
  });

  it("同优先级多档命中判歧义并给出候选（不猜）", () => {
    const root = directory();
    for (const id of ["a-kiosk", "b-kiosk"]) {
      const dir = join(root, id); mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "profile.json"), JSON.stringify(archiveFixture(dir, { id, displayName: "同名入住机" })), "utf8");
    }
    const library = loadProductArchives(root);
    const match = selectProductArchive(library.archives, "同名入住机");
    expect(match.archive).toBeNull();
    expect(match.reason).toContain("歧义");
    expect(match.candidates.sort()).toEqual(["a-kiosk", "b-kiosk"]);
  });

  it("主图优先 hero；提示词口径声明真实商品与不得改外观", () => {
    const dir = directory();
    const archive = archiveFixture(dir);
    archive.photos.push({ id: "detail", file: archive.photos[0]!.file, role: "detail", sha256: archive.photos[0]!.sha256, bytes: archive.photos[0]!.bytes });
    expect(productHeroPhoto(archive)?.role).toBe("hero");
    const lines = productArchivePromptLines(archive);
    expect(lines.join("\n")).toContain("产品一致性硬约束");
    expect(lines.join("\n")).toContain("以参考照片为准");

    const systemDir = directory();
    const system = archiveFixture(systemDir, {
      source: {
        kind: "system-generated", priority: PRODUCT_ARCHIVE_SOURCE_PRIORITY["system-generated"], reviewStatus: "pending-owner-review",
        searchedQueries: ["q"], evidence: [{ query: "q", url: "https://example.com" }], disclaimer: "d"
      }
    });
    expect(productArchivePromptLines(system).join("\n")).toContain("未经客户确认");
  });

  it("名称归一：全角/半角、空格与分隔符不影响命中", () => {
    expect(normalizeProductName("Demo Kiosk")).toBe(normalizeProductName("ｄｅｍｏ－ｋｉｏｓｋ"));
    expect(normalizeProductName("演示（自助）入住机")).toBe(normalizeProductName("演示自助入住机"));
  });
});
