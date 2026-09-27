import { mkdirSync, mkdtempSync, writeFileSync, readFileSync, symlinkSync, unlinkSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  allocateReferenceSlots,
  findAngleFile,
  impactOfVersionChange,
  listPortraitVersions,
  loadCharacterLibrary,
  loadCharacterEntry, activatePortraitVersion, resolveShotCast,
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
    writeFileSync(join(setDir, `${name}-${angle}.png`), Buffer.alloc(2048, 8));
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
  /**
   * 真机 bug（2026-09-24）：随仓 1 号模特的档案 name 是"陈卓"，
   * 但 portraits/v3 下的文件名是"平江路讲述人-front.png"（沿用上一代素材前缀）→
   * 严格前缀匹配时 8 张定妆照全部解析不到，G5 门亮红才发现。
   */
  it("文件名前缀与档案名不一致时，仍能按角度后缀解析到定妆照", () => {
    const dir = mkdtempSync(join(tmpdir(), "wl-angle-"));
    writeFileSync(join(dir, "平江路讲述人-front.png"), "png");
    writeFileSync(join(dir, "平江路讲述人-threeQuarter.png"), "png");
    expect(findAngleFile(dir, "陈卓", "front")).toBe(join(dir, "平江路讲述人-front.png"));
    expect(findAngleFile(dir, "陈卓", "threeQuarter")).toBe(join(dir, "平江路讲述人-threeQuarter.png"));
    // 角度不存在 → null（不许拿别的角度顶替）
    expect(findAngleFile(dir, "陈卓", "side")).toBeNull();
  });

  it("规范命名优先于回退命名", () => {
    const dir = mkdtempSync(join(tmpdir(), "wl-angle-prio-"));
    writeFileSync(join(dir, "平江路讲述人-front.png"), "png");
    writeFileSync(join(dir, "陈卓-front.png"), "png");
    expect(findAngleFile(dir, "陈卓", "front")).toBe(join(dir, "陈卓-front.png"));
  });

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

  it("单数character命中，只有台词speaker不能证明画内出镜", () => {
    const cast = resolveShotCharacters({ character: "平江路讲述人" }, library);
    expect(cast.characters.map((c) => c.id)).toEqual(["presenter"]);
    const bySpeaker = resolveShotCharacters({ dialogueBlocks: [{ speaker: "南园经理", line: "欢迎入住" }] }, library);
    expect(bySpeaker.characters).toEqual([]);
    expect(bySpeaker.status).toBe("unverified");
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

  it("四人完整占位；超员时阻断，不能把角色降级成无参考文字", () => {
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
    expect(crowd.used).toHaveLength(4);
    expect(crowd.dropped).toEqual([]);
    expect(crowd.venueUsed).toEqual([]);
    const over = allocateReferenceSlots({ characters: ["a", "b", "c", "d", "e"].map(id => ({ id, name: id, files: files(id) })), venueRefs: venues });
    expect(over.status).toBe("unverified"); expect(over.references).toEqual([]); expect(over.dropped[0]!.id).toBe("e");
  });

  it("角色没有可用定妆照时阻断并记录", () => {
    const plan = allocateReferenceSlots({ characters: [{ id: "x", name: "无照角色", files: {} }], venueRefs: venues });
    expect(plan.used).toHaveLength(0);
    expect(plan.dropped[0]?.reason).toContain("没有可用定妆照");
    expect(plan.status).toBe("unverified"); expect(plan.references).toEqual([]);
  });
});

describe("原镜头人物适用性与精确人数", () => {
  const identities = [{ id: "a", name: "陈卓", aliases: ["讲述人"] }, { id: "b", name: "李静" }];
  it.each([
    { scene: "无人的办公室空镜", portraits: ["/stale/person.png"] },
    { scene: "陈卓的手表产品特写" },
    { scene: "橘猫独自在草地行走" },
    { subject: { kind: "environment", count: 0 }, scene: "雨后街道" },
    { character: "NONE", scene: "山间的晨雾" }
  ])("非人镜头不因项目角色库存在而带入人物：%j", (shot) => {
    const result = resolveShotCast(shot, identities.slice(0, 1));
    expect(result.status).toBe("not_applicable"); expect(result.characters).toEqual([]); expect(result.expectedCount).toBe(0);
  });
  it("未知主体、只有旁白、被否定角色和结构化画外角色都不猜", () => {
    for (const shot of [{}, { dialogueBlocks: [{ speaker: "陈卓", line: "欢迎" }] }, { scene: "不要陈卓出镜" }, { characters: [{ id: "a", onScreen: false }], scene: "只见窗外雨滴" }]) {
      const result = resolveShotCast(shot, identities.slice(0, 1)); expect(result.characters).toEqual([]); expect(result.status).not.toBe("passed");
    }
  });
  it("显式cast对象按原顺序与人数匹配并保留每人版本/服装", () => {
    const result = resolveShotCast({ subject: { kind: "person", count: 2 }, cast: [{ id: "b", pinnedVersion: 2, wardrobeId: "red" }, { id: "a", wardrobe: { name: "蓝色衬衫" } }] }, identities);
    expect(result.status).toBe("passed"); expect(result.characters.map(item => item.id)).toEqual(["b", "a"]);
    expect(result.selections).toEqual([{ characterId: "b", pinnedVersion: 2, wardrobeId: "red" }, { characterId: "a", wardrobe: { name: "蓝色衬衫" } }]);
  });
  it("人数矛盾、无人镜的显式cast、未知身份和同名歧义均无可提交人物", () => {
    for (const shot of [{ subject: { count: 2 }, characters: ["陈卓"] }, { scene: "单人出镜", characters: ["陈卓", "李静"] }, { scene: "无人空镜", characters: ["陈卓"] }, { characters: ["陌生演员"] }]) {
      const result = resolveShotCast(shot, identities); expect(result.status).not.toBe("passed"); expect(result.characters).toEqual([]);
    }
    expect(resolveShotCast({ characters: ["讲述人"] }, [...identities, { id: "c", name: "讲述人" }]).status).toBe("unverified");
    expect(resolveShotCast({ scene: "讲述人在办公室站立" }, [...identities, { id: "c", name: "讲述人" }]).status).toBe("unverified");
  });
  it("明确原字段优先，派生prompt和台词不能追加第三个人", () => {
    const result = resolveShotCast({ characters: ["陈卓"], scene: "陈卓在办公室站立", prompt: "李静与陈卓同框", dialogueBlocks: [{ speaker: "李静" }] }, identities);
    expect(result.status).toBe("passed"); expect(result.characters.map(item => item.id)).toEqual(["a"]);
  });
  it("结构化cast只能细化原角色，不得把冲突身份拼成多人镜", () => {
    for (const shot of [{ character: "陈卓", cast: [{ id: "b" }] }, { characters: ["陈卓"], cast: [{ id: "a" }, { id: "b" }] }]) {
      const result = resolveShotCast(shot, identities); expect(result.status).toBe("failed"); expect(result.characters).toEqual([]);
    }
    expect(resolveShotCast({ character: "陈卓", cast: [{ id: "a" }, { id: "b" }] }, identities).characters.map(item => item.id)).toEqual(["a", "b"]);
    expect(resolveShotCast({ characters: ["陈卓", "李静"], cast: [{ id: "a", pinnedVersion: 2 }, { id: "b" }] }, identities).status).toBe("passed");
  });
});

describe("激活、pin与文件版本的真实消费", () => {
  function twoVersions() {
    const root = mkdtempSync(join(tmpdir(), "wl-version-")); makeLibrary(root, "presenter", "陈卓");
    const dir = join(root, "presenter"); const file = join(dir, "profile.json"); const profile = JSON.parse(readFileSync(file, "utf8")) as CharacterProfile;
    profile.portraitSets[0]!.angles = ["front", "threeQuarter", "closeup", "side"];
    mkdirSync(join(dir, "portraits/v1"), { recursive: true });
    for (const angle of profile.portraitSets[0]!.angles) writeFileSync(join(dir, "portraits/v1", `陈卓-${angle}.png`), Buffer.alloc(2048, 1));
    writeFileSync(file, JSON.stringify(profile)); return { root, dir, file, profile };
  }
  it("inactive最后一版不会自动成为active，pin读取指定旧版实际字节", () => {
    const { dir, file, profile } = twoVersions();
    const pinned = loadCharacterEntry(dir, { pinnedVersion: 1 })!;
    expect(pinned.activeSet?.version).toBe(1); expect(readFileSync(pinned.files.front!)[0]).toBe(1);
    expect(loadCharacterEntry(dir)!.activeSet?.version).toBe(2);
    for (const set of profile.portraitSets) set.active = false; writeFileSync(file, JSON.stringify(profile));
    const unloaded = loadCharacterEntry(dir)!; expect(unloaded.activeSet).toBeNull(); expect(unloaded.files).toEqual({}); expect(unloaded.verification.status).toBe("unverified");
  });
  it("多个active/重复版本不猜；缺角度和symlink不能激活", async () => {
    const fixture = twoVersions(); fixture.profile.portraitSets[0]!.active = true; writeFileSync(fixture.file, JSON.stringify(fixture.profile));
    expect(() => loadCharacterEntry(fixture.dir)).toThrow("PORTRAIT_VERSION_AMBIGUOUS");
    fixture.profile.portraitSets[0]!.active = false; fixture.profile.portraitSets.push({ ...fixture.profile.portraitSets[0]! }); writeFileSync(fixture.file, JSON.stringify(fixture.profile));
    expect(() => loadCharacterEntry(fixture.dir)).toThrow("CHARACTER_ARCHIVE_INVALID"); fixture.profile.portraitSets.pop(); writeFileSync(fixture.file, JSON.stringify(fixture.profile));
    const side = join(fixture.dir, "portraits/v1/陈卓-side.png"); unlinkSync(side);
    await expect(activatePortraitVersion(fixture.root, "presenter", 1)).rejects.toThrow("PORTRAIT_ACTIVATION_UNVERIFIED");
    symlinkSync(join(fixture.dir, "portraits/v2/陈卓-side.png"), side);
    expect(loadCharacterEntry(fixture.dir, { pinnedVersion: 1 })!.verification.status).toBe("unverified");
    expect(loadCharacterEntry(fixture.dir)!.activeSet?.version).toBe(2);
  });
  it("完整候选可显式激活；找不到指定版本不替成active", async () => {
    const { root, dir } = twoVersions(); const activated = await activatePortraitVersion(root, "presenter", 1);
    expect(activated.activeSet?.version).toBe(1); expect(activated.portraitSets.filter(set => set.active)).toHaveLength(1);
    const missing = loadCharacterEntry(dir, { pinnedVersion: 9 })!; expect(missing.files).toEqual({}); expect(missing.verification.issues.join()).toContain("不存在");
  });
  it("旧目录有多个角度候选时不按字典序猜版本", () => {
    const dir = mkdtempSync(join(tmpdir(), "wl-ambiguous-"));
    writeFileSync(join(dir, "other-front-v2.png"), Buffer.alloc(2048)); writeFileSync(join(dir, "other-front-v10.png"), Buffer.alloc(2048));
    expect(findAngleFile(dir, "陈卓", "front")).toBeNull();
  });
  it("真实CLI bind --pin和activate使用指定版本，并创建准确项目文件", () => {
    const { root, dir } = twoVersions(); const work = mkdtempSync(join(tmpdir(), "wl-bind-cli-"));
    const repo = resolve(fileURLToPath(new URL("../../../", import.meta.url)));
    const cli = join(repo, "scripts/tools/character-archive.mts");
    const run = (...args: string[]) => execFileSync(process.execPath, ["--import", "tsx", cli, ...args], { cwd: repo, encoding: "utf8", env: { ...process.env, HR_CHARACTER_LIBRARY: root, HR_WORK_DIR: work } });
    expect(run("bind", "--project", "P1", "--character", "presenter", "--pin", "1")).toContain("pin v1");
    const index = JSON.parse(readFileSync(join(work, "characters/P1/portrait-index.json"), "utf8"));
    expect(index.characters.presenter.portraitVersion).toBe(1); expect(readFileSync(index.characters.presenter.files.front)[0]).toBe(1);
    expect(loadCharacterEntry(dir)!.activeSet?.version).toBe(2);
    expect(run("activate", "--character", "presenter", "--version", "1")).toContain("已激活 presenter v1");
    expect(loadCharacterEntry(dir)!.activeSet?.version).toBe(1);
    expect(() => run("bind", "--project", "P2", "--character", "presenter", "--pin")).toThrow();
  }, 30_000);
  it("真实生成CLI plan消费指定服装和锚点，缺失锚点或参数拒绝规划", () => {
    const { root } = twoVersions(); const repo = resolve(fileURLToPath(new URL("../../../", import.meta.url)));
    const cli = join(repo, "scripts/tools/portrait-agent.mts");
    const run = (...args: string[]) => execFileSync(process.execPath, ["--import", "tsx", cli, "plan", "--character", "presenter", ...args], { cwd: repo, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, HR_CHARACTER_LIBRARY: root, ARK_IMAGE_MODEL: "offline-plan-model" } });
    const plan = run("--wardrobe", "红色外套", "--seed", "0"); expect(plan).toContain("服装：红色外套"); expect(plan).toContain("穿着红色外套"); expect(plan).toContain("请求hash=");
    expect(() => run("--anchor", "missing.png")).toThrow(); expect(() => run("--wardrobe")).toThrow();
  }, 30_000);
  it("真实绑定CLI拒绝目录别名、档案身份错配及保留项目标识", () => {
    const fixture = twoVersions(); const work = mkdtempSync(join(tmpdir(), "wl-bind-identity-"));
    const repo = resolve(fileURLToPath(new URL("../../../", import.meta.url)));
    const cli = join(repo, "scripts/tools/character-archive.mts");
    const run = (character: string, project = "P1") => execFileSync(process.execPath, ["--import", "tsx", cli, "bind", "--project", project, "--character", character], { cwd: repo, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, HR_CHARACTER_LIBRARY: fixture.root, HR_WORK_DIR: work } });
    symlinkSync(fixture.dir, join(fixture.root, "alias"));
    expect(() => run("alias")).toThrow("CHARACTER_PATH_INVALID");
    fixture.profile.id = "another-person"; writeFileSync(fixture.file, JSON.stringify(fixture.profile));
    expect(() => run("presenter")).toThrow("CHARACTER_ARCHIVE_INVALID");
    expect(() => run("presenter", "__proto__")).toThrow("CHARACTER_PATH_INVALID");
  }, 30_000);
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
