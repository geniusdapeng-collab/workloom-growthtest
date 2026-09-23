import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  allocateReferenceSlots,
  impactOfVersionChange,
  listPortraitVersions,
  loadCharacterLibrary,
  resolveShotCharacters,
  type CharacterProfile
} from "./character-archive.js";

/** 造一个最小档案库：<root>/<id>/{profile.json, portraits/v2/<name>-<angle>.png} */
function makeLibrary(root: string, id: string, name: string, options: { version?: number } = {}): void {
  const version = options.version ?? 2;
  const dir = join(root, id);
  const setDir = join(dir, "portraits", `v${version}`);
  mkdirSync(setDir, { recursive: true });
  for (const angle of ["front", "threeQuarter", "closeup", "side"]) {
    writeFileSync(join(setDir, `${name}-${angle}.png`), "png");
  }
  const profile: CharacterProfile = {
    schemaVersion: "workloom.character-profile/v1",
    id,
    name,
    kind: "generated",
    biography: ["虚构生平：用于叙事一致性"],
    authorization: { status: "synthetic-no-real-person" },
    portraitSets: [
      { version: 1, dir: "portraits/v1", angles: ["front"], source: "pure-t2i", active: false },
      { version, dir: `portraits/v${version}`, angles: ["front", "threeQuarter", "closeup", "side"], source: "pure-t2i", active: true }
    ]
  };
  writeFileSync(join(dir, "profile.json"), JSON.stringify(profile, null, 2));
}

describe("人物档案库：装载与版本", () => {
  it("装载档案并解析 active 定妆照集的角度文件", () => {
    const root = mkdtempSync(join(tmpdir(), "wl-archive-"));
    makeLibrary(root, "presenter", "平江路讲述人");
    const library = loadCharacterLibrary(root);
    const entry = library.get("presenter")!;
    expect(entry.name).toBe("平江路讲述人");
    expect(entry.activeSet?.version).toBe(2);
    for (const angle of ["front", "threeQuarter", "closeup", "side"]) {
      expect(entry.files[angle]).toContain(`/portraits/v2/`);
    }
    expect(listPortraitVersions(entry).map((s) => s.version)).toEqual([2, 1]);
  });
});

describe("镜头选角（1–10 人）", () => {
  const root = mkdtempSync(join(tmpdir(), "wl-cast-"));
  makeLibrary(root, "presenter", "平江路讲述人");
  makeLibrary(root, "manager", "南园经理");
  makeLibrary(root, "guest", "住客甲");
  const library = loadCharacterLibrary(root);

  it("显式 characters 数组按出场顺序命中多人", () => {
    const cast = resolveShotCharacters({ characters: ["平江路讲述人", "南园经理"] }, library);
    expect(cast.characters.map((c) => c.id)).toEqual(["presenter", "manager"]);
  });

  it("单数 character 字段 + 台词 speaker 也能命中", () => {
    const cast = resolveShotCharacters({ character: "平江路讲述人" }, library);
    expect(cast.characters.map((c) => c.id)).toEqual(["presenter"]);
    const bySpeaker = resolveShotCharacters({ dialogueBlocks: [{ speaker: "南园经理", line: "欢迎入住" }] }, library);
    expect(bySpeaker.characters.map((c) => c.id)).toEqual(["manager"]);
  });

  it("文本里出现库外角色名时给出 unmatched（提示建档）", () => {
    const cast = resolveShotCharacters({ characters: ["陌生演员"] }, library);
    expect(cast.unmatched).toContain("陌生演员");
  });
});

describe("参考图配额分配（Seedance 单次上限 4 张）", () => {
  const files = (id: string) => ({ front: `/lib/${id}-front.png`, closeup: `/lib/${id}-closeup.png` });
  const venues = ["/v/1.jpg", "/v/2.jpg", "/v/3.jpg", "/v/4.jpg"];

  it("单人：人物 1 + 场景 3，人物用 closeup", () => {
    const plan = allocateReferenceSlots({ characters: [{ id: "a", name: "甲", files: files("a") }], venueRefs: venues });
    expect(plan.references).toEqual(["/lib/a-closeup.png", "/v/1.jpg", "/v/2.jpg", "/v/3.jpg"]);
    expect(plan.note).toContain("人物 1 张");
  });

  it("双人对话：2 人各 1 + 场景 2", () => {
    const plan = allocateReferenceSlots({
      characters: [
        { id: "a", name: "甲", files: files("a"), dialogueLines: 3 },
        { id: "b", name: "乙", files: files("b"), dialogueLines: 1 }
      ],
      venueRefs: venues
    });
    expect(plan.used.map((u) => u.id)).toEqual(["a", "b"]);
    expect(plan.venueUsed).toHaveLength(2);
    expect(plan.references).toHaveLength(4);
  });

  it("三人以上：主角优先，超员角色降级为文字描述并如实记录", () => {
    const plan = allocateReferenceSlots({
      characters: [
        { id: "c", name: "丙", files: files("c") },
        { id: "a", name: "甲", files: files("a"), lead: true },
        { id: "b", name: "乙", files: files("b"), dialogueLines: 2 }
      ],
      venueRefs: venues
    });
    expect(plan.used.map((u) => u.id)).toEqual(["a", "b", "c"]);
    expect(plan.dropped).toHaveLength(0);
    expect(plan.venueUsed).toHaveLength(1);

    const crowd = allocateReferenceSlots({
      characters: ["a", "b", "c", "d"].map((id, i) => ({ id, name: id, files: files(id), dialogueLines: 4 - i })),
      venueRefs: venues
    });
    expect(crowd.used).toHaveLength(3);
    expect(crowd.dropped.map((d) => d.id)).toEqual(["d"]);
    expect(crowd.note).toContain("降级");
  });

  it("角色没有可用定妆照时降级并记录（不静默）", () => {
    const plan = allocateReferenceSlots({ characters: [{ id: "x", name: "无照角色", files: {} }], venueRefs: venues });
    expect(plan.used).toHaveLength(0);
    expect(plan.dropped[0]?.reason).toContain("没有可用定妆照");
    expect(plan.references).toHaveLength(4);
  });
});

describe("版本影响面", () => {
  it("区分跟随 active / pin 旧版 / pin 新版", () => {
    const impact = impactOfVersionChange(
      [
        { projectId: "VID-1", characterId: "a" },
        { projectId: "VID-2", characterId: "a", pinnedVersion: 1 },
        { projectId: "VID-3", characterId: "a", pinnedVersion: 2 },
        { projectId: "VID-4", characterId: "b", pinnedVersion: 1 }
      ],
      { characterId: "a", fromVersion: 1, toVersion: 2 }
    );
    expect(impact.followActive.map((b) => b.projectId)).toEqual(["VID-1"]);
    expect(impact.pinnedOld.map((b) => b.projectId)).toEqual(["VID-2"]);
    expect(impact.pinnedNew.map((b) => b.projectId)).toEqual(["VID-3"]);
  });
});
