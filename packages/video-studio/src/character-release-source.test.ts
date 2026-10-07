import { createHash } from "node:crypto";
import {
  mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, truncateSync, writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildRegisteredCharacterReleaseSource } from "./character-release-source.js";
import { generationIdentityLock } from "./character-release-contract.js";
import { REAL_PERSON_ASSET_SCHEMA, type RealPersonAsset } from "./real-person-asset.js";

const temporary: string[] = [];
const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aD1sAAAAASUVORK5CYII=", "base64");
const hashFile = (file: string): string => createHash("sha256").update(readFileSync(file)).digest("hex");
const white = { id: "author-white", description: "客户明确要求的白色商务套装" };
const black = { id: "registered-black", description: "黑色商务套装：金色纽扣、合体外套" };
const gray = { id: "shot-gray", description: "本镜明确要求的灰色礼服" };
type Input = Parameters<typeof buildRegisteredCharacterReleaseSource>[0];

function writeJson(file: string, value: unknown): void {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(value, null, 2));
}
function asset(assetId = "asset-primary"): RealPersonAsset {
  return {
    schemaVersion: REAL_PERSON_ASSET_SCHEMA, assetId, displayName: "测试授权CEO",
    certified: { gender: "female", source: "测试的已登记属性" },
    assetGroupId: "group-test", referenceAssets: ["asset-close", "asset-side", "asset-extra"],
    anchorPhoto: "anchor.png", role: "授权主讲人",
    authorization: { status: "real-authorized", scope: "本地合同测试", evidence: "本地测试授权回执" },
  };
}
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "registered-character-source-")); temporary.push(dir);
  const assetRoot = join(dir, "assets"), characterRoot = join(dir, "characters");
  const primaryDir = join(assetRoot, "primary"), profileFile = join(primaryDir, "profile.json");
  const registered = asset();
  writeJson(profileFile, registered); writeFileSync(join(primaryDir, "anchor.png"), png);
  const profiles = [
    { id: "model-a", name: "测试甲", wardrobe: [{ id: "registered-black", name: "黑色商务套装", detail: "金色纽扣、合体外套" }],
      portraitSets: [{ dir: "portraits/v1", angles: [], active: true, version: 1, assets: { front: "asset://asset-stale-angle" } }] },
    { id: "model-b", name: "测试乙", wardrobe: [{ id: "blue", name: "蓝色套装", detail: "简洁剪裁" }] },
  ];
  writeJson(join(characterRoot, "a-model", "profile.json"), profiles[0]);
  writeJson(join(characterRoot, "b-model", "profile.json"), profiles[1]);
  const registryFile = join(characterRoot, "registry.json");
  writeJson(registryFile, { defaultModel: "model-a", models: [
    { id: "model-a", name: "测试甲", aliases: ["甲总"] }, { id: "model-b", name: "测试乙", aliases: ["乙总"] },
  ] });
  const input: Input = {
    projectId: "VID-REGISTERED", shots: [{ shotId: "S1", assetRef: "asset://asset-primary" }],
    assetLibraryRoot: assetRoot, characterLibraryRoots: [characterRoot], registryFile,
  };
  return { dir, primaryDir, assetRoot, characterRoot, profileFile, registered, profiles, registryFile, input };
}
function expectSourceFailure(run: () => unknown, code: string, privateValues: string[] = []): void {
  let caught: unknown;
  try { run(); } catch (error) { caught = error; }
  expect(caught).toBeInstanceOf(Error);
  const message = (caught as Error).message;
  expect(message).toContain(code);
  for (const value of privateValues) expect(message).not.toContain(value);
}
function portraitFixture() {
  const f = fixture(), characterDir = join(f.characterRoot, "a-model");
  const characterFile = join(characterDir, "profile.json"), portraitFile = join(characterDir, "portraits/v1/测试甲-front.png");
  const set = { version: 1, dir: "portraits/v1", angles: ["front"], active: true,
    files: { front: "portraits/v1/测试甲-front.png" } };
  const profile = { ...f.profiles[0], kind: "authorized-real", authorization: {
    status: "real-authorized", evidence: "asset://asset-primary",
  }, portraitSets: [set] };
  writeJson(characterFile, profile); mkdirSync(dirname(portraitFile), { recursive: true }); writeFileSync(portraitFile, png);
  const { anchorPhoto: _unused, ...noAnchor } = f.registered;
  writeJson(f.profileFile, noAnchor);
  return { ...f, characterDir, characterFile, portraitFile, profile, set };
}

beforeEach(() => { vi.stubGlobal("fetch", vi.fn(() => { throw new Error("测试禁止外部网络或供应商请求"); })); });
afterEach(() => {
  expect(fetch).not.toHaveBeenCalled(); vi.unstubAllGlobals();
  for (const dir of temporary.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("从受控登记源构建人物发布合同", () => {
  it("真实登记基准文件及SHA来自真人主档，旧角色角度asset不进入统一引用", () => {
    const f = fixture(), result = buildRegisteredCharacterReleaseSource(f.input);
    expect(result.contract.status).toBe("passed");
    expect(result.bindings).toHaveLength(1);
    expect(result.bindings[0]).toMatchObject({ characterId: "model-a", assetId: "asset-primary", wardrobeLock: black,
      identityAnchor: { path: realpathSync(join(f.primaryDir, "anchor.png")), sha256: hashFile(join(f.primaryDir, "anchor.png")),
        assetId: "asset-primary", source: "registered-real-person-profile:" + realpathSync(f.profileFile) } });
    expect(result.contract.shots[0]?.referenceAssets).toEqual(["asset://asset-primary", "asset://asset-close", "asset://asset-side"]);
    expect(JSON.stringify(result.contract)).not.toContain("asset-stale-angle");
  });

  it("父子独立调用同一可信roots及冻结资料得到同一合同且不修改输入", () => {
    const f = fixture(), before = JSON.stringify(f.input);
    const parent = buildRegisteredCharacterReleaseSource(f.input);
    const child = buildRegisteredCharacterReleaseSource(structuredClone(f.input));
    expect(parent.contract.contractHash).toBe(child.contract.contractHash);
    expect(parent.bindings).toEqual(child.bindings);
    expect(JSON.stringify(f.input)).toBe(before);
    child.bindings[0]!.wardrobeLock.description = "只修改返回值";
    expect(parent.bindings[0]?.wardrobeLock).toEqual(black);
    expect(parent.contract.characters[0]?.wardrobeLock).toEqual(black);
  });

  it("冻结character中的child自报anchor和bindings不覆盖真实登记基准", () => {
    const f = fixture();
    f.input.character = { id: "model-a", identityAnchor: { path: "/child/generated-first-frame.jpg", sha256: "f".repeat(64) },
      bindings: [{ assetId: "asset-forged", identityAnchor: { path: "/child/private.jpg" } }] };
    const result = buildRegisteredCharacterReleaseSource(f.input);
    expect(result.bindings[0]?.identityAnchor?.path).toBe(realpathSync(join(f.primaryDir, "anchor.png")));
    expect(JSON.stringify(result)).not.toContain("/child/");
    expect(result.contract.status).toBe("passed");
  });

  it.each([
    ["explicit-id", { id: "model-b" }, "model-b"],
    ["exact-name", { name: "测试乙" }, "model-b"],
    ["registered-alias", { name: "请由乙总出镜" }, "model-b"],
    ["registered-default", undefined, "model-a"],
  ])("%s沿用当前CLI选角规则", (_label, character, expected) => {
    const f = fixture();
    const result = buildRegisteredCharacterReleaseSource({ ...f.input, character: character as Record<string, unknown> | undefined });
    expect(result.bindings[0]?.characterId).toBe(expected);
  });

  it("显式ID与姓名冲突沿用CLI同一次OR匹配的库顺序", () => {
    const f = fixture();
    const result = buildRegisteredCharacterReleaseSource({ ...f.input, character: { id: "model-b", name: "测试甲" } });
    expect(result.bindings[0]?.characterId).toBe("model-a");
    expect(result.bindings[0]?.wardrobeLock).toEqual(black);
  });

  it("无默认/匹配时使用首个档案；registry省略时从最后一个角色root读取", () => {
    const f = fixture();
    writeJson(f.registryFile, { models: [] });
    const { registryFile: _unused, ...input } = f.input;
    const first = readdirSync(f.characterRoot).find(name => name !== "registry.json")!;
    const expected = JSON.parse(readFileSync(join(f.characterRoot, first, "profile.json"), "utf8")).id;
    expect(buildRegisteredCharacterReleaseSource(input).bindings[0]?.characterId).toBe(expected);
    writeJson(f.registryFile, { defaultModel: "model-b", models: [] });
    expect(buildRegisteredCharacterReleaseSource(input).bindings[0]?.characterId).toBe("model-b");
  });

  it("别名指向不存在角色时不偷偷回退默认，按CLI保留未选中lead", () => {
    const f = fixture();
    writeJson(f.registryFile, { defaultModel: "model-a", models: [{ id: "missing-model", aliases: ["别名客户"] }] });
    const result = buildRegisteredCharacterReleaseSource({ ...f.input, character: { name: "别名客户", wardrobeLock: white } });
    expect(result.bindings[0]?.characterId).toBe("asset-primary");
    expect(result.contract.status).toBe("passed");
  });

  it("多roots按当前CLI顺序覆盖同ID，第一衣橱保留id/name/detail口径", () => {
    const f = fixture(), laterRoot = join(f.dir, "later-characters");
    writeJson(join(laterRoot, "same-model", "profile.json"), { id: "model-a", name: "测试甲",
      wardrobe: [{ name: "新版黑色套装", detail: "无品牌标识" }, { id: "unused", name: "不选择的第二衣橱" }] });
    const result = buildRegisteredCharacterReleaseSource({ ...f.input, characterLibraryRoots: [f.characterRoot, laterRoot] });
    expect(result.bindings[0]?.wardrobeLock).toEqual({ id: "新版黑色套装", description: "新版黑色套装：无品牌标识" });
    expect(result.contract.status).toBe("passed");
  });

  it("镜头明确characterId优先；主asset绑定冻结shot而非角色角度档案", () => {
    const f = fixture();
    const result = buildRegisteredCharacterReleaseSource({ ...f.input, shots: [{ shotId: "S1", characterId: "customer-role", assetRef: "asset://asset-primary" }] });
    expect(result.bindings[0]).toMatchObject({ characterId: "customer-role", assetId: "asset-primary", wardrobeLock: black });
    expect(result.contract.shots[0]?.characterId).toBe("customer-role");
  });

  it("两个镜头明确同一人物却用不同主asset由纯合同拒绝，不选择最后一份伪装一致", () => {
    const f = fixture(), second = asset("asset-second");
    writeJson(join(f.assetRoot, "second", "profile.json"), second); writeFileSync(join(f.assetRoot, "second", "anchor.png"), png);
    const result = buildRegisteredCharacterReleaseSource({ ...f.input, shots: [
      { shotId: "S1", characterId: "same-role", assetRef: "asset://asset-primary" },
      { shotId: "S2", characterId: "same-role", assetRef: "asset://asset-second" },
    ] });
    expect(result.contract.status).toBe("failed");
    expect(result.contract.issues.map(item => item.code)).toContain("shot-asset-mismatch");
  });

  it("多个授权人物按冻结镜头独立绑定；角色变化修改合同摘要", () => {
    const f = fixture(), second = asset("asset-second");
    writeJson(join(f.assetRoot, "second", "profile.json"), second); writeFileSync(join(f.assetRoot, "second", "anchor.png"), png);
    const first = buildRegisteredCharacterReleaseSource(f.input);
    const result = buildRegisteredCharacterReleaseSource({ ...f.input, shots: [
      { shotId: "S1", characterId: "first-speaker", assetRef: "asset://asset-primary" },
      { shotId: "S2", characterId: "second-speaker", assetRef: "asset://asset-second" },
    ] });
    expect(result.contract.status).toBe("passed");
    expect(result.bindings.map(item => [item.characterId, item.assetId])).toEqual([["first-speaker", "asset-primary"], ["second-speaker", "asset-second"]]);
    expect(result.contract.contractHash).not.toBe(first.contract.contractHash);
  });

  it("冻结character明确服饰锁优先，注册第一衣橱不覆盖客户作者合同", () => {
    const f = fixture();
    const result = buildRegisteredCharacterReleaseSource({ ...f.input, character: { id: "model-a", wardrobeLock: white } });
    expect(result.bindings[0]?.wardrobeLock).toEqual(white);
    expect(result.contract.shots[0]?.wardrobeLock).toEqual(white);
    expect(result.contract.status).toBe("passed");
  });

  it.each([false, true])("逐镜换装声明完整=%s时按现有纯合同裁决", declared => {
    const f = fixture();
    const result = buildRegisteredCharacterReleaseSource({ ...f.input, character: { wardrobeLock: white }, shots: [
      { shotId: "S1", assetRef: "asset://asset-primary" },
      { shotId: "S2", assetRef: "asset://asset-primary", wardrobeLock: gray,
        ...(declared ? { wardrobeChange: { declaredBy: "product-owner", source: "冻结作者需求回执", reason: "第二镜明确换装" } } : {}) },
    ] });
    expect(result.contract.status).toBe(declared ? "passed" : "failed");
    if (declared) expect(generationIdentityLock(result.contract, "S2").promptFragment).toContain("冻结作者需求回执");
    else expect(result.contract.issues.map(item => item.code)).toContain("wardrobe-change-undeclared");
  });

  it("重复真人asset主档全部交给纯合同，不在loader去重后假通过", () => {
    const f = fixture();
    writeJson(join(f.assetRoot, "duplicate", "profile.json"), f.registered); writeFileSync(join(f.assetRoot, "duplicate", "anchor.png"), png);
    const result = buildRegisteredCharacterReleaseSource(f.input);
    expect(result.contract.status).toBe("failed");
    expect(result.contract.issues.map(item => item.code)).toContain("asset-duplicate");
  });

  it("不同可信root、登记role、衣橱或基准bytes使合同摘要变化", () => {
    const f = fixture(), initial = buildRegisteredCharacterReleaseSource(f.input).contract.contractHash;
    writeJson(f.profileFile, { ...f.registered, role: "另一个已登记授权角色" });
    expect(buildRegisteredCharacterReleaseSource(f.input).contract.contractHash).not.toBe(initial);
    writeJson(f.profileFile, f.registered);
    writeFileSync(join(f.primaryDir, "anchor.png"), Buffer.concat([png, Buffer.from("changed-current-bytes")]));
    expect(buildRegisteredCharacterReleaseSource(f.input).contract.contractHash).not.toBe(initial);
    writeFileSync(join(f.primaryDir, "anchor.png"), png);
    writeJson(join(f.characterRoot, "a-model", "profile.json"), { ...f.profiles[0], wardrobe: [{ id: "w2", name: "新登记服装" }] });
    expect(buildRegisteredCharacterReleaseSource(f.input).contract.contractHash).not.toBe(initial);
    writeJson(join(f.characterRoot, "a-model", "profile.json"), f.profiles[0]);
    const otherRoot = join(f.dir, "other-assets");
    writeJson(join(otherRoot, "primary", "profile.json"), f.registered); writeFileSync(join(otherRoot, "primary", "anchor.png"), png);
    expect(buildRegisteredCharacterReleaseSource({ ...f.input, assetLibraryRoot: otherRoot }).contract.contractHash).not.toBe(initial);
  });

  it.each(["pending", "revoked", "expired", "missing-scope", "missing-gender"] as const)("%s登记主档由纯合同拒绝", variant => {
    const f = fixture(), registered = structuredClone(f.registered);
    if (variant === "pending" || variant === "revoked") registered.authorization.status = variant;
    if (variant === "expired") registered.authorization.expiresAt = "2000-01-01T00:00:00Z";
    if (variant === "missing-scope") registered.authorization.scope = "";
    if (variant === "missing-gender") delete (registered.certified as Partial<RealPersonAsset["certified"]>).gender;
    writeJson(f.profileFile, registered);
    expect(buildRegisteredCharacterReleaseSource(f.input).contract.status).toBe("failed");
  });

  it("未知asset缺登记不会从child绑定或生成首镜编造人物来源", () => {
    const f = fixture();
    const result = buildRegisteredCharacterReleaseSource({ ...f.input, shots: [{ shotId: "S1", assetRef: "asset://asset-unknown" }] });
    expect(result.contract.status).toBe("failed");
    expect(result.contract.issues.map(item => item.code)).toContain("asset-unregistered");
  });

  it("没有授权真人镜头时显式不适用，缺失可选角色库不制造模特", () => {
    const f = fixture();
    const result = buildRegisteredCharacterReleaseSource({ ...f.input, shots: [{ shotId: "S-landscape", scene: "自然风景" }],
      characterLibraryRoots: [join(f.dir, "absent-characters")], registryFile: undefined });
    expect(result.contract.status).toBe("not_applicable"); expect(result.bindings).toEqual([]);
  });
});

describe("登记文件与认证基准路径失败关闭", () => {
  it("缺anchorPhoto即使character/shot含生成图也不能自证身份", () => {
    const f = fixture(), { anchorPhoto: _unused, ...noAnchor } = f.registered;
    writeJson(f.profileFile, noAnchor);
    expectSourceFailure(() => buildRegisteredCharacterReleaseSource({ ...f.input,
      character: { id: "model-a", wardrobeLock: black, identityAnchor: { path: join(f.primaryDir, "anchor.png"), sha256: hashFile(join(f.primaryDir, "anchor.png")) } },
      shots: [{ shotId: "S1", assetRef: "asset://asset-primary", identityAnchor: join(f.primaryDir, "anchor.png") }],
    }), "CHARACTER_SOURCE_ANCHOR_MISSING", [f.dir]);
  });

  it("当前真实CEO直接复用已入库定妆照，不要求重新下载或登记真人原图", () => {
    const repoRoot = resolve(import.meta.dirname, "../../..");
    const result = buildRegisteredCharacterReleaseSource({
      projectId: "VID-CURRENT-CEO", shots: [{ shotId: "GT-03", assetRef: "asset://asset-20260101000000-demo" }],
      character: { id: "demo-character" },
      assetLibraryRoot: join(repoRoot, "bundles/ai-video/library/real-person-assets"),
      characterLibraryRoots: [join(repoRoot, "bundles/ai-video/library/characters")],
    });
    const portrait = join(repoRoot, "bundles/ai-video/library/characters/model-03-demo-character/portraits/v1/客户方CEO-front.jpg");
    expect(result.contract.status).toBe("passed");
    expect(result.bindings[0]?.identityAnchor).toMatchObject({ path: realpathSync(portrait), sha256: hashFile(portrait),
      assetId: "asset-20260101000000-demo" });
    expect(result.bindings[0]?.identityAnchor?.source).toContain("registered-character-portrait:");
    expect(result.bindings[0]?.identityAnchor?.source).toContain("#v1/front");
    expect(JSON.stringify(result)).not.toContain("sources/客户方CEO-anchor.jpg");
  });

  it("登记anchor文件缺失不能返回可发布合同", () => {
    const f = fixture(); writeJson(f.profileFile, { ...f.registered, anchorPhoto: "missing-anchor.png" });
    expectSourceFailure(() => buildRegisteredCharacterReleaseSource(f.input), "CHARACTER_SOURCE_ANCHOR_MISSING", [f.dir]);
  });

  it("空文件或目录不算真实认证基准", () => {
    const f = fixture(); writeFileSync(join(f.primaryDir, "anchor.png"), "");
    expectSourceFailure(() => buildRegisteredCharacterReleaseSource(f.input), "CHARACTER_SOURCE_ANCHOR_INVALID");
    writeJson(f.profileFile, { ...f.registered, anchorPhoto: "directory-anchor" }); mkdirSync(join(f.primaryDir, "directory-anchor"));
    expectSourceFailure(() => buildRegisteredCharacterReleaseSource(f.input), "CHARACTER_SOURCE_ANCHOR_INVALID");
  });

  it.each(["absolute", "traversal", "file-url", "windows"] as const)("%s基准路径不能越过登记asset目录", kind => {
    const f = fixture(), outside = join(f.dir, "private-outside.png"); writeFileSync(outside, png);
    const anchorPhoto = kind === "absolute" ? outside : kind === "traversal" ? "../../private-outside.png"
      : kind === "file-url" ? "file://" + outside : "C:\\private\\outside.png";
    writeJson(f.profileFile, { ...f.registered, anchorPhoto });
    expectSourceFailure(() => buildRegisteredCharacterReleaseSource(f.input), "CHARACTER_SOURCE_PATH_INVALID", [f.dir, "private-outside"]);
  });

  it.each(["asset-directory", "asset-profile", "anchor-file", "anchor-parent", "character-directory", "character-profile", "registry"] as const)(
    "%s符号链接不读取外部来源", target => {
      const f = fixture(), outside = join(f.dir, "outside-private"); mkdirSync(outside);
      writeJson(join(outside, "profile.json"), target.startsWith("character") ? f.profiles[0] : f.registered);
      writeFileSync(join(outside, "anchor.png"), png);
      writeJson(join(outside, "registry.json"), { defaultModel: "model-a", models: [] });
      if (target === "asset-directory") { rmSync(f.primaryDir, { recursive: true }); symlinkSync(outside, f.primaryDir, "dir"); }
      if (target === "asset-profile") { rmSync(f.profileFile); symlinkSync(join(outside, "profile.json"), f.profileFile); }
      if (target === "anchor-file") { rmSync(join(f.primaryDir, "anchor.png")); symlinkSync(join(outside, "anchor.png"), join(f.primaryDir, "anchor.png")); }
      if (target === "anchor-parent") {
        symlinkSync(outside, join(f.primaryDir, "linked"), "dir"); writeJson(f.profileFile, { ...f.registered, anchorPhoto: "linked/anchor.png" });
      }
      if (target === "character-directory") { rmSync(join(f.characterRoot, "a-model"), { recursive: true }); symlinkSync(outside, join(f.characterRoot, "a-model"), "dir"); }
      if (target === "character-profile") { rmSync(join(f.characterRoot, "a-model", "profile.json")); symlinkSync(join(outside, "profile.json"), join(f.characterRoot, "a-model", "profile.json")); }
      if (target === "registry") { rmSync(f.registryFile); symlinkSync(join(outside, "registry.json"), f.registryFile); }
      expectSourceFailure(() => buildRegisteredCharacterReleaseSource(f.input), "CHARACTER_SOURCE_PATH_INVALID", [f.dir, "outside-private"]);
    },
  );

  it("registryFile必须位于同一可信角色roots", () => {
    const f = fixture(), outside = join(f.dir, "outside-registry.json"); writeJson(outside, { defaultModel: "model-b" });
    expectSourceFailure(() => buildRegisteredCharacterReleaseSource({ ...f.input, registryFile: outside }), "CHARACTER_SOURCE_PATH_INVALID", [f.dir]);
  });

  it.each(["asset", "character", "registry"] as const)("%s损坏JSON不吞错误、不回显内容或私有路径", kind => {
    const f = fixture(), privateContent = "operator-private-secret-fragment";
    const file = kind === "asset" ? f.profileFile : kind === "character" ? join(f.characterRoot, "a-model", "profile.json") : f.registryFile;
    writeFileSync(file, "{ " + privateContent);
    expectSourceFailure(() => buildRegisteredCharacterReleaseSource(f.input), "CHARACTER_SOURCE_JSON_INVALID", [f.dir, privateContent]);
  });

  it("冻结shot明确未授权同组refs仍交给纯合同拒绝", () => {
    const f = fixture();
    const result = buildRegisteredCharacterReleaseSource({ ...f.input, shots: [
      { shotId: "S1", assetRef: "asset://asset-primary", referenceAssets: ["asset://asset-forged"] },
    ] });
    expect(result.contract.status).toBe("failed");
    expect(result.contract.issues.map(item => item.code)).toContain("reference-not-authorized");
  });

  it.each(["asset-without-scheme", "asset://../private", "file:///child/generated.jpg"])("%s不是官方asset引用不能降级为不适用", assetRef => {
    const f = fixture();
    expectSourceFailure(() => buildRegisteredCharacterReleaseSource({ ...f.input, shots: [{ shotId: "S1", assetRef }] }), "CHARACTER_SOURCE_SHOT_INVALID");
  });
});

describe("前置处理完成的登记定妆照复用", () => {
  it("在用定妆照优先于可选真人原图，来源如实保留角色版本与实际字节", () => {
    const f = portraitFixture(); writeJson(f.profileFile, f.registered);
    const result = buildRegisteredCharacterReleaseSource(f.input);
    expect(result.contract.status).toBe("passed");
    expect(result.bindings[0]?.identityAnchor).toEqual({ path: realpathSync(f.portraitFile), sha256: hashFile(f.portraitFile),
      assetId: "asset-primary", source: `registered-character-portrait:${realpathSync(f.characterFile)}#v1/front` });
    expect(result.contract.shots[0]?.referenceAssets).toEqual(["asset://asset-primary", "asset://asset-close", "asset://asset-side"]);
  });

  it("父子独立解析同一在用定妆照得到相同发布合同，不接受child自报的首镜基准", () => {
    const f = portraitFixture(); f.input.character = { id: "model-a", identityAnchor: { path: "/child/current-clip.jpg" } };
    const first = buildRegisteredCharacterReleaseSource(f.input), second = buildRegisteredCharacterReleaseSource(structuredClone(f.input));
    expect(first.contract.contractHash).toBe(second.contract.contractHash);
    expect(first.bindings[0]?.identityAnchor?.path).toBe(realpathSync(f.portraitFile));
    expect(JSON.stringify(first)).not.toContain("/child/");
    writeFileSync(f.portraitFile, Buffer.concat([png, Buffer.from("changed-portrait-bytes")]));
    expect(buildRegisteredCharacterReleaseSource(f.input).contract.contractHash).not.toBe(first.contract.contractHash);
  });

  it("角度asset只是已有身份的来源登记，生成参考仍以主授权素材组为准", () => {
    const f = portraitFixture();
    writeJson(f.characterFile, { ...f.profile, authorization: { status: "real-authorized", evidence: "已处理的角色素材" },
      portraitSets: [{ ...f.set, assets: { front: "asset://asset-primary", side: "asset://asset-stale-angle" } }] });
    const result = buildRegisteredCharacterReleaseSource(f.input);
    expect(result.contract.status).toBe("passed");
    expect(result.bindings[0]?.identityAnchor?.path).toBe(realpathSync(f.portraitFile));
    expect(result.contract.shots[0]?.referenceAssets).not.toContain("asset://asset-stale-angle");
  });

  it("不同人物的定妆照不能借给另一主asset或不在库的角色", () => {
    const f = portraitFixture();
    writeJson(f.characterFile, { ...f.profile, authorization: { status: "real-authorized", evidence: "asset://asset-other-person" } });
    expectSourceFailure(() => buildRegisteredCharacterReleaseSource(f.input), "CHARACTER_SOURCE_ANCHOR_MISSING");
    writeJson(f.characterFile, f.profile);
    expectSourceFailure(() => buildRegisteredCharacterReleaseSource({ ...f.input,
      shots: [{ shotId: "S1", assetRef: "asset://asset-primary", characterId: "missing-role" }] }), "CHARACTER_SOURCE_ANCHOR_MISSING");
  });

  it.each(["inactive", "pending", "revoked", "generated"] as const)("%s定妆照不是当前授权角色的在用参考", kind => {
    const f = portraitFixture();
    const profile = kind === "inactive" ? { ...f.profile, portraitSets: [{ ...f.set, active: false }] }
      : kind === "generated" ? { ...f.profile, kind: "generated" }
      : { ...f.profile, authorization: { ...f.profile.authorization, status: kind } };
    writeJson(f.characterFile, profile);
    expectSourceFailure(() => buildRegisteredCharacterReleaseSource(f.input), "CHARACTER_SOURCE_ANCHOR_MISSING");
  });

  it.each(["pending", "revoked", "expired"] as const)("定妆照可复用仍不会豁免%s主素材授权", kind => {
    const f = portraitFixture();
    writeJson(f.profileFile, { ...f.registered, anchorPhoto: undefined, authorization: { ...f.registered.authorization,
      ...(kind === "expired" ? { expiresAt: "2000-01-01T00:00:00Z" } : { status: kind }) } });
    expect(buildRegisteredCharacterReleaseSource(f.input).contract.status).toBe("failed");
  });

  it("切换在用版本立即采用新版本；无files字段的历史档案按登记角度精确解析", () => {
    const f = portraitFixture(), next = join(f.characterDir, "portraits/v2/测试甲-front.png");
    mkdirSync(dirname(next), { recursive: true }); writeFileSync(next, Buffer.concat([png, Buffer.from("version-two")]));
    const { files: _unused, ...legacy } = f.set;
    writeJson(f.characterFile, { ...f.profile, portraitSets: [f.set, { ...legacy, version: 2, dir: "portraits/v2" }] });
    expect(buildRegisteredCharacterReleaseSource(f.input).bindings[0]?.identityAnchor).toMatchObject({ path: realpathSync(next), sha256: hashFile(next) });
  });

  it.each(["absolute", "traversal", "file-url", "other-version"] as const)("%s定妆照路径不能越过登记角色和版本边界", kind => {
    const f = portraitFixture(), outside = join(f.dir, "private-outside.png"); writeFileSync(outside, png);
    const path = kind === "absolute" ? outside : kind === "traversal" ? "../../private-outside.png"
      : kind === "file-url" ? "file://" + outside : "portraits/v2/front.png";
    writeJson(f.characterFile, { ...f.profile, portraitSets: [{ ...f.set, files: { front: path } }] });
    expectSourceFailure(() => buildRegisteredCharacterReleaseSource(f.input), "CHARACTER_SOURCE_PATH_INVALID", [f.dir]);
  });

  it.each(["file", "parent"] as const)("%s符号链接不能把外部图片包装成已处理定妆照", kind => {
    const f = portraitFixture(), outside = join(f.dir, "outside-private"); mkdirSync(outside); writeFileSync(join(outside, "测试甲-front.png"), png);
    if (kind === "file") { rmSync(f.portraitFile); symlinkSync(join(outside, "测试甲-front.png"), f.portraitFile); }
    else { rmSync(dirname(f.portraitFile), { recursive: true }); symlinkSync(outside, dirname(f.portraitFile), "dir"); }
    expectSourceFailure(() => buildRegisteredCharacterReleaseSource(f.input), "CHARACTER_SOURCE_PATH_INVALID", [f.dir]);
  });

  it.each(["missing", "empty", "directory", "oversize"] as const)("%s登记定妆照保留明确失败，不用另一张图静默顶替", kind => {
    const f = portraitFixture();
    if (kind === "missing") rmSync(f.portraitFile);
    if (kind === "empty") writeFileSync(f.portraitFile, "");
    if (kind === "directory") { rmSync(f.portraitFile); mkdirSync(f.portraitFile); }
    if (kind === "oversize") truncateSync(f.portraitFile, 100_000_001);
    expectSourceFailure(() => buildRegisteredCharacterReleaseSource(f.input),
      kind === "missing" ? "CHARACTER_SOURCE_ANCHOR_MISSING" : "CHARACTER_SOURCE_ANCHOR_INVALID", [f.dir]);
  });

  it("重复在用版本拒绝歧义，空定妆照集保留外部客户原基准路径", () => {
    const f = portraitFixture(); writeJson(f.characterFile, { ...f.profile, portraitSets: [f.set, f.set] });
    expectSourceFailure(() => buildRegisteredCharacterReleaseSource(f.input), "CHARACTER_SOURCE_PROFILE_INVALID");
    writeJson(f.characterFile, { ...f.profile, portraitSets: [] }); writeJson(f.profileFile, f.registered);
    expect(buildRegisteredCharacterReleaseSource(f.input).bindings[0]?.identityAnchor?.path).toBe(realpathSync(join(f.primaryDir, "anchor.png")));
  });
});


describe("登记边界与输入完整性回归", () => {
  it("operator配置root别名规范为同一真实来源，不能因macOS目录别名产生不同合同", () => {
    const f = fixture(), initial = buildRegisteredCharacterReleaseSource(f.input);
    const rootAlias = join(f.dir, "asset-root-alias"), characterAlias = join(f.dir, "character-root-alias");
    symlinkSync(f.assetRoot, rootAlias, "dir"); symlinkSync(f.characterRoot, characterAlias, "dir");
    const aliased = buildRegisteredCharacterReleaseSource({ ...f.input, assetLibraryRoot: rootAlias,
      characterLibraryRoots: [characterAlias], registryFile: join(characterAlias, "registry.json") });
    expect(aliased.contract.contractHash).toBe(initial.contract.contractHash);
    expect(aliased.bindings).toEqual(initial.bindings);
  });

  it("登记asset目录内的普通子目录基准有效，身份证据仍为该主档", () => {
    const f = fixture(), sub = join(f.primaryDir, "verified", "本人登记.png");
    mkdirSync(dirname(sub), { recursive: true }); writeFileSync(sub, png);
    writeJson(f.profileFile, { ...f.registered, anchorPhoto: "verified/本人登记.png" });
    const result = buildRegisteredCharacterReleaseSource(f.input);
    expect(result.contract.status).toBe("passed");
    expect(result.bindings[0]?.identityAnchor?.path).toBe(realpathSync(sub));
    expect(result.bindings[0]?.identityAnchor?.sha256).toBe(hashFile(sub));
  });

  it("即使符号链接留在同root也不从别的登记文件借认证基准", () => {
    const f = fixture(), other = join(f.primaryDir, "another-anchor.png");
    writeFileSync(other, png); rmSync(join(f.primaryDir, "anchor.png"));
    symlinkSync(other, join(f.primaryDir, "anchor.png"));
    expectSourceFailure(() => buildRegisteredCharacterReleaseSource(f.input), "CHARACTER_SOURCE_PATH_INVALID");
  });

  it("相同基准与姓名的登记JSON格式变化不会误报人物合同变更", () => {
    const f = fixture(), initial = buildRegisteredCharacterReleaseSource(f.input).contract.contractHash;
    writeFileSync(f.profileFile, JSON.stringify(f.registered) + "\n\n");
    expect(buildRegisteredCharacterReleaseSource(f.input).contract.contractHash).toBe(initial);
  });

  it("没有真人镜头不要求未使用资产的基准图，不把无人物片标为失败", () => {
    const f = fixture(), { anchorPhoto: _unused, ...noAnchor } = f.registered;
    writeJson(f.profileFile, noAnchor);
    const result = buildRegisteredCharacterReleaseSource({ ...f.input, shots: [] });
    expect(result.contract.status).toBe("not_applicable"); expect(result.bindings).toEqual([]);
  });

  it("空服饰锁和重复shotId由纯合同保留失败，不补猜衣橱", () => {
    const f = fixture();
    const missing = buildRegisteredCharacterReleaseSource({ ...f.input, character: { wardrobeLock: {} } });
    expect(missing.contract.status).toBe("failed");
    expect(missing.contract.issues.map(item => item.code)).toContain("wardrobe-lock-missing");
    const duplicate = buildRegisteredCharacterReleaseSource({ ...f.input, shots: [
      { shotId: "S1", assetRef: "asset://asset-primary" }, { shotId: "S1", assetRef: "asset://asset-primary" },
    ] });
    expect(duplicate.contract.status).toBe("failed");
    expect(duplicate.contract.issues.map(item => item.code)).toContain("shot-duplicate-or-missing");
  });

  it.each(["shots", "roots", "character", "project", "registry"] as const)("%s输入结构无效时失败有明确原因", field => {
    const f = fixture(), bad: Record<string, unknown> = { ...f.input };
    if (field === "shots") bad.shots = null;
    if (field === "roots") bad.characterLibraryRoots = "mock-operator-private-fragment";
    if (field === "character") bad.character = [];
    if (field === "project") bad.projectId = { secret: "mock-operator-private-fragment" };
    if (field === "registry") bad.registryFile = 123;
    expectSourceFailure(() => buildRegisteredCharacterReleaseSource(bad as unknown as Input),
      "CHARACTER_SOURCE_INPUT_INVALID", ["mock-operator-private-fragment"]);
  });

  it("不存在的assetroot明确拒绝未登记主素材，而非读取child路径", () => {
    const f = fixture();
    const result = buildRegisteredCharacterReleaseSource({ ...f.input, assetLibraryRoot: join(f.dir, "missing-assets") });
    expect(result.contract.status).toBe("failed");
    expect(result.contract.issues.map(item => item.code)).toContain("asset-unregistered");
  });

  it.each(["profile", "anchor"] as const)("%s超大登记文件在读正文前拒绝", kind => {
    const f = fixture(), file = kind === "profile" ? f.profileFile : join(f.primaryDir, "anchor.png");
    // Sparse files exercise the actual filesystem size boundary without allocating large buffers.
    truncateSync(file, kind === "profile" ? 4_000_001 : 100_000_001);
    expectSourceFailure(() => buildRegisteredCharacterReleaseSource(f.input),
      kind === "profile" ? "CHARACTER_SOURCE_PROFILE_INVALID" : "CHARACTER_SOURCE_ANCHOR_INVALID");
  });

  it("root是文件或登记profile是目录时显式拒绝", () => {
    const f = fixture();
    expectSourceFailure(() => buildRegisteredCharacterReleaseSource({ ...f.input, assetLibraryRoot: f.profileFile }), "CHARACTER_SOURCE_ROOT_INVALID");
    rmSync(f.profileFile); mkdirSync(f.profileFile);
    expectSourceFailure(() => buildRegisteredCharacterReleaseSource(f.input), "CHARACTER_SOURCE_PROFILE_INVALID");
  });

  it.each(["default", "model-id", "aliases"] as const)("%s无效登记表不静默降级", field => {
    const f = fixture();
    writeJson(f.registryFile, field === "default" ? { defaultModel: { secret: "mock-private-document-value" } }
      : field === "model-id" ? { models: [{ id: "" }] } : { models: [{ id: "model-a", aliases: "mock-private-document-value" }] });
    expectSourceFailure(() => buildRegisteredCharacterReleaseSource(f.input), "CHARACTER_SOURCE_PROFILE_INVALID", ["mock-private-document-value"]);
  });

  it.each(["assetRef", "characterId", "referenceAssets", "wardrobeChange", "shotId"] as const)("%s无效冻结镜头不会进入来源绑定", field => {
    const f = fixture(), shot: Record<string, unknown> = { shotId: "S1", assetRef: "asset://asset-primary" };
    if (field === "assetRef") shot.assetRef = null;
    if (field === "characterId") shot.characterId = {};
    if (field === "referenceAssets") shot.referenceAssets = ["asset://asset-close", 123];
    if (field === "wardrobeChange") shot.wardrobeChange = "private-customer-fragment";
    if (field === "shotId") shot.shotId = "";
    expectSourceFailure(() => buildRegisteredCharacterReleaseSource({ ...f.input, shots: [shot] }), "CHARACTER_SOURCE_SHOT_INVALID", ["private-customer-fragment"]);
  });
});
