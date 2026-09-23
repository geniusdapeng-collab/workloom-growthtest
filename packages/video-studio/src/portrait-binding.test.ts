import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { composeShotReferences, pickCharacterPortrait, shotCharacterText } from "./portrait-binding.js";

function makeFile(name: string): string {
  const dir = mkdtempSync(join(tmpdir(), "wl-portrait-"));
  const file = join(dir, name);
  writeFileSync(file, "png");
  return file;
}

/**
 * 真机事故修复（T-2026-0923-0050）：镜头卡用 `character`（单数）时，
 * 旧实现拿 `prompt + characters` 匹配 → 永远 null → 定妆照一张都没下发。
 */
describe("镜头卡 → 定妆照绑定", () => {
  const front = makeFile("讲述人-front.png");
  const side = makeFile("讲述人-side.png");
  const index = {
    characters: { 平江路讲述人: { id: "平江路讲述人", name: "平江路讲述人", files: { front, side } } }
  };

  it("单数 character 字段也能命中（真机根因）", () => {
    const pick = pickCharacterPortrait(index, { shotId: "S1", character: "平江路讲述人：真人，三十岁上下女性" });
    expect(pick.file).toBe(front);
    expect(pick.matchedBy).toBe("token");
  });

  it("characters 数组 / characterRef / prompt / scene 任一命中即可", () => {
    expect(pickCharacterPortrait(index, { characters: ["平江路讲述人"] }).file).toBe(front);
    expect(pickCharacterPortrait(index, { characterRef: "平江路讲述人-front" }).file).toBe(front);
    expect(pickCharacterPortrait(index, { prompt: "镜头里出镜的是平江路讲述人" }).file).toBe(front);
    // 未提角色名时走"唯一角色兜底"（真人出镜项目的常态），并如实标注 matchedBy=sole
    const fallback = pickCharacterPortrait(index, { scene: "讲述人沿街缓步" });
    expect(fallback.file).toBe(front);
    expect(fallback.matchedBy).toBe("sole");
  });

  it("卡片显式给出定妆照路径时优先使用", () => {
    const pick = pickCharacterPortrait(index, { shotId: "S1", portraits: [side], character: "别人" });
    expect(pick.file).toBe(side);
    expect(pick.matchedBy).toBe("explicit");
  });

  it("索引里只有一个角色时兜底采用（真人出镜项目常见）", () => {
    const pick = pickCharacterPortrait(index, { shotId: "S3", scene: "平江路街巷石路" });
    expect(pick.file).toBe(front);
    expect(pick.matchedBy).toBe("sole");
    expect(pick.note).toContain("只有一个角色");
  });

  it("多角色且未命中 → 不猜（返回 none，交给上层 fail-closed）", () => {
    const multi = {
      characters: {
        A: { id: "A", name: "角色甲", files: { front } },
        B: { id: "B", name: "角色乙", files: { front: side } }
      }
    };
    const pick = pickCharacterPortrait(multi, { scene: "空镜" });
    expect(pick.file).toBeNull();
    expect(pick.matchedBy).toBe("none");
  });

  it("shotCharacterText 汇总所有可能提到角色的字段", () => {
    const text = shotCharacterText({ character: "甲", characters: ["乙"], prompt: "丙", scene: "丁" });
    for (const token of ["甲", "乙", "丙", "丁"]) expect(text).toContain(token);
  });

  /**
   * 真人肖像必须走方舟「已授权真人素材」（asset://<asset ID>）——直传真人图会被平台隐私闸拦。
   * 这类引用没有本地文件，不能被 existsSync 过滤掉。
   */
  it("支持方舟 asset:// 授权素材引用（人像库 asset ID）", () => {
    const assetIndex = {
      characters: { 讲述人: { id: "讲述人", name: "讲述人", files: { front: "asset://asset-20260923120000-ab12c" } } }
    };
    const byToken = pickCharacterPortrait(assetIndex, { character: "讲述人" });
    expect(byToken.file).toBe("asset://asset-20260923120000-ab12c");
    expect(byToken.matchedBy).toBe("token");

    const byExplicit = pickCharacterPortrait(index, { portraits: ["asset://asset-20260923120000-zz999"] });
    expect(byExplicit.file).toBe("asset://asset-20260923120000-zz999");
    expect(byExplicit.matchedBy).toBe("explicit");
  });
});

describe("参考图编排：人物优先", () => {
  const portrait = "/tmp/p/front.png";
  const venues = ["/tmp/v/ref-01.jpg", "/tmp/v/ref-02.jpg", "/tmp/v/ref-03.jpg", "/tmp/v/ref-04.jpg"];

  it("有人物时：人物 1 张 + 场景 3 张（总上限 4）", () => {
    const out = composeShotReferences({ portrait, venueRefs: venues });
    expect(out.references).toHaveLength(4);
    expect(out.references[0]).toBe(portrait);
    expect(out.venueUsed).toHaveLength(3);
    expect(out.note).toContain("人物定妆照 1 张");
  });

  it("无人物时退化为纯场景参考（调用方需按 fail-closed 处理）", () => {
    const out = composeShotReferences({ portrait: null, venueRefs: venues });
    expect(out.references).toHaveLength(4);
    expect(out.references).not.toContain(portrait);
    expect(out.note).toContain("无人物定妆照");
  });
});
