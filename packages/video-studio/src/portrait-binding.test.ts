import { mkdtempSync, writeFileSync, symlinkSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { composeShotReferences, pickCharacterPortrait, pickCharacterPortraits, shotCharacterText } from "./portrait-binding.js";
import { readPortraitArtifact } from "./character-archive.js";
import { shotIntentHash } from "./shot-intent.js";

function makeFile(name: string): string {
  const dir = mkdtempSync(join(tmpdir(), "wl-portrait-"));
  const file = join(dir, name);
  writeFileSync(file, Buffer.alloc(2048, 8));
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

  it("characters数组/明确characterRef/原prompt可命中，简称不触发唯一角色兜底", () => {
    expect(pickCharacterPortrait(index, { characters: ["平江路讲述人"] }).file).toBe(front);
    expect(pickCharacterPortrait(index, { characterRef: "平江路讲述人-front" }).file).toBe(front);
    expect(pickCharacterPortrait(index, { prompt: "镜头里出镜的是平江路讲述人" }).file).toBe(front);
    const fallback = pickCharacterPortrait(index, { scene: "讲述人沿街缓步" });
    expect(fallback.file).toBeNull();
    expect(fallback.status).toBe("unverified");
  });

  it("卡片显式给出定妆照路径时优先使用", () => {
    const pick = pickCharacterPortrait(index, { shotId: "S1", portraits: [side], character: "平江路讲述人" });
    expect(pick.file).toBe(side);
    expect(pick.matchedBy).toBe("explicit");
  });

  it("索引只有一个角色也不能给街巷环境镜塞人物", () => {
    const pick = pickCharacterPortrait(index, { shotId: "S3", scene: "平江路街巷石路" });
    expect(pick.file).toBeNull();
    expect(pick.status).toBe("unverified");
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

  it("已有原字段时不把派生prompt回读成新选角来源", () => {
    const text = shotCharacterText({ character: "甲", characters: ["乙"], prompt: "丙", scene: "丁" });
    for (const token of ["甲", "乙", "丁"]) expect(text).toContain(token);
    expect(text).not.toContain("丙");
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

    const byExplicit = pickCharacterPortrait(assetIndex, { character: "讲述人", portraits: ["asset://asset-20260923120000-ab12c"] });
    expect(byExplicit.file).toBe("asset://asset-20260923120000-ab12c");
    expect(byExplicit.matchedBy).toBe("explicit");
    expect(byExplicit.scope).toBe("external-asset-id-not-provider-verified");
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

describe("镜头身份、人数和当前版本不能被参考图路径覆盖", () => {
  const a = makeFile("a-front.png"); const b = makeFile("b-front.png");
  const index = { characters: { a: { id: "a", name: "陈卓", files: { front: a } }, b: { id: "b", name: "李静", files: { front: b } } } };
  it.each([{ scene: "无人的办公室空镜" }, { scene: "手表产品特写" }, { scene: "猫在草地行走" }, { subject: { kind: "environment", count: 0 } }])("旧显式肖像不能给非人物镜头添人：%j", shot => {
    const picked = pickCharacterPortraits(index, { ...shot, portraits: [a] });
    expect(picked.status).toBe("not_applicable"); expect(picked.picks).toEqual([]);
  });
  it("多人物返回全部，单人物API不能偷偷只取第一个", () => {
    const shot = { subject: { kind: "person", count: 2 }, characters: ["李静", "陈卓"] };
    const multi = pickCharacterPortraits(index, shot);
    expect(multi.status).toBe("passed"); expect(multi.picks.map(pick => pick.file)).toEqual([b, a]);
    const single = pickCharacterPortrait(index, shot); expect(single.status).toBe("unverified"); expect(single.file).toBeNull();
    const incomplete = pickCharacterPortraits(index, { subject: { count: 2 }, characters: ["陈卓"] }); expect(incomplete.status).toBe("failed"); expect(incomplete.picks).toEqual([]);
  });
  it("显式本地或asset路径必须属于对应角色，无法以路径替换身份", () => {
    for (const portraits of [[b], ["asset://other-identity"], [a, b]]) {
      const picked = pickCharacterPortraits(index, { characters: ["陈卓"], portraits }); expect(picked.status).toBe("unverified"); expect(picked.picks).toEqual([]);
    }
    expect(pickCharacterPortraits(index, { portraits: [a] }).status).toBe("unverified");
  });
  it("按版本与服装凭据绑定；指定旧版或新衣服不能使用当前文件", () => {
    const wardrobe = { id: "blue", name: "蓝色衬衫" };
    const versioned = { characters: { a: { ...index.characters.a, portraitVersion: 2, wardrobe, wardrobeHash: shotIntentHash(wardrobe), artifacts: { front: readPortraitArtifact(a) } } } };
    const current = pickCharacterPortrait(versioned, { character: "陈卓", portraitVersion: 2, costume: "蓝色衬衫" });
    expect(current.status).toBe("passed"); expect(current.version).toBe(2); expect(current.assetHash).toMatch(/^[a-f0-9]{64}$/);
    for (const shot of [{ character: "陈卓", portraitVersion: 1 }, { character: "陈卓", wardrobeId: "red" }, { character: "陈卓", costume: "红色外套" }]) {
      expect(pickCharacterPortrait(versioned, shot).status).toBe("unverified");
    }
  });
  it("当前文件改字节或变为symlink，不能继续按旧收据绑定", () => {
    const file = makeFile("current-front.png"); const receipt = readPortraitArtifact(file);
    const versioned = { characters: { actor: { id: "actor", name: "演员", files: { front: file }, artifacts: { front: receipt } } } };
    writeFileSync(file, Buffer.alloc(2048, 9)); expect(pickCharacterPortrait(versioned, { character: "演员" }).status).toBe("unverified");
    unlinkSync(file); symlinkSync(a, file); expect(pickCharacterPortrait(versioned, { character: "演员" }).status).toBe("unverified");
  });
  it("多人物参考占完整配额；非法上限和超员不静默裁掉人物", () => {
    expect(composeShotReferences({ portrait: null, portraits: [a, b], venueRefs: [a, "/venue/1", "/venue/1", "/venue/2", "/venue/3"] }).references).toEqual([a, b, "/venue/1", "/venue/2"]);
    for (const maxRefs of [0, 5, NaN, 1.5]) expect(() => composeShotReferences({ portrait: a, venueRefs: [], maxRefs })).toThrow("PORTRAIT_REFERENCE_LIMIT_INVALID");
    expect(() => composeShotReferences({ portrait: null, portraits: [a, b], venueRefs: [], maxRefs: 1 })).toThrow("PORTRAIT_REFERENCE_LIMIT_EXCEEDED");
  });
});
