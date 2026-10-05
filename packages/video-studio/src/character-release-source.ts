/**
 * Compile a release contract from operator-selected registration roots and a frozen shot source.
 * The parent service and CLI call this independently; child bindings, generated portraits and
 * caller-supplied anchor fingerprints are never registration evidence. No model or network I/O.
 */
import { createHash } from "node:crypto";
import {
  closeSync, constants, fstatSync, lstatSync, openSync, readFileSync, readdirSync, realpathSync,
  type Stats,
} from "node:fs";
import { isAbsolute, join, relative, resolve, sep, win32 } from "node:path";
import {
  buildCharacterReleaseContract, type CharacterIdentityAnchor, type CharacterReleaseBindingInput,
  type CharacterReleaseContract, type CharacterReleaseShotInput, type CharacterWardrobeChange,
  type CharacterWardrobeLock,
} from "./character-release-contract.js";
import { assetIdOf, isRealPersonAssetRef, type RealPersonAsset } from "./real-person-asset.js";

export interface RegisteredCharacterReleaseSourceInput {
  projectId: string;
  shots: readonly Record<string, unknown>[];
  /** Only the immutable project character declaration, never a child's resolved bindings. */
  character?: Record<string, unknown> | null;
  assetLibraryRoot: string;
  /** Ordered like the CLI: runtime library first, repository library last. */
  characterLibraryRoots: readonly string[];
  /** Defaults to registry.json in the last configured character root. */
  registryFile?: string;
}
export interface RegisteredCharacterReleaseSource {
  contract: CharacterReleaseContract;
  bindings: CharacterReleaseBindingInput[];
}
export class CharacterReleaseSourceError extends Error {
  constructor(readonly code: string, reason: string) {
    super(code + ": " + reason);
    this.name = "CharacterReleaseSourceError";
  }
}

interface RegistrationRoot { lexical: string; canonical: string | null }
interface RegisteredAsset { asset: RealPersonAsset; dir: string; profileFile: string }
interface RegisteredCharacter { id: string; name: string; wardrobeLock: CharacterWardrobeLock }
interface CharacterRegistry { defaultModel: string | null; aliases: Array<{ id: string; names: string[] }> }
const MAX_PROFILE_BYTES = 4_000_000;
const MAX_ANCHOR_BYTES = 100_000_000;
const plain = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
const text = (value: unknown): value is string => typeof value === "string" && value.trim().length > 0;
const inside = (root: string, file: string): boolean => {
  const part = relative(root, file);
  return part !== ".." && !part.startsWith(".." + sep) && !isAbsolute(part);
};
function fail(code: string, reason: string): never { throw new CharacterReleaseSourceError(code, reason); }
function guarded<T>(code: string, reason: string, operation: () => T): T {
  try { return operation(); }
  catch (error) {
    if (error instanceof CharacterReleaseSourceError) throw error;
    // Filesystem/JSON errors can include operator paths or document contents. Preserve only
    // our typed, actionable failure reason, never the original error text or cause.
    return fail(code, reason);
  }
}
function optionalStat(file: string): Stats | null {
  try { return lstatSync(file); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    return fail("CHARACTER_SOURCE_READ_FAILED", "受控登记文件不可读取，请检查本机目录权限与完整性");
  }
}
function registrationRoot(value: string): RegistrationRoot {
  if (!text(value) || /[\u0000-\u001f]/.test(value)) fail("CHARACTER_SOURCE_ROOT_INVALID", "必须使用可信运营配置中的有效资料库目录");
  const lexical = resolve(value), stat = optionalStat(lexical);
  if (!stat) return { lexical, canonical: null };
  return guarded("CHARACTER_SOURCE_ROOT_INVALID", "受控资料库不是可读取目录", () => {
    // The operator can intentionally configure a root alias (including macOS /var). Once
    // canonicalized, no nested source symlink is permitted to select another registration.
    const canonical = realpathSync(lexical);
    if (!lstatSync(canonical).isDirectory()) fail("CHARACTER_SOURCE_ROOT_INVALID", "受控资料库必须是目录");
    return { lexical, canonical };
  });
}
function stableStat(a: Stats, b: Stats): boolean {
  return a.dev === b.dev && a.ino === b.ino && a.size === b.size
    && a.mtimeMs === b.mtimeMs && a.ctimeMs === b.ctimeMs;
}
function snapshotFile(file: string, root: string, maximum: number, kind: "profile" | "anchor"): Buffer {
  const missingCode = kind === "anchor" ? "CHARACTER_SOURCE_ANCHOR_MISSING" : "CHARACTER_SOURCE_READ_FAILED";
  const invalidCode = kind === "anchor" ? "CHARACTER_SOURCE_ANCHOR_INVALID" : "CHARACTER_SOURCE_PROFILE_INVALID";
  if (!inside(root, file)) fail("CHARACTER_SOURCE_PATH_INVALID", "登记来源越过可信资料库边界，拒绝读取");
  const before = optionalStat(file);
  if (!before) fail(missingCode, kind === "anchor" ? "登记的认证基准图缺失，不能用生成镜头替代" : "受控登记文件缺失");
  if (before.isSymbolicLink()) fail("CHARACTER_SOURCE_PATH_INVALID", "登记来源含符号链接，拒绝读取其他来源");
  if (!before.isFile() || before.size < 1 || before.size > maximum) fail(invalidCode, "登记来源必须是大小有效的普通文件");
  return guarded("CHARACTER_SOURCE_READ_FAILED", "受控登记文件读取失败，请检查权限与完整性", () => {
    if (realpathSync(file) !== file) fail("CHARACTER_SOURCE_PATH_INVALID", "登记来源的父目录含符号链接，拒绝跨来源读取");
    let descriptor: number | undefined;
    try {
      descriptor = openSync(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
      const opened = fstatSync(descriptor);
      if (!opened.isFile() || !stableStat(before, opened)) fail("CHARACTER_SOURCE_CHANGED", "登记文件在读取前发生变化，请重新核验");
      const bytes = readFileSync(descriptor), afterRead = fstatSync(descriptor);
      const current = lstatSync(file);
      if (bytes.length !== before.size || !stableStat(opened, afterRead) || !stableStat(afterRead, current)
        || current.isSymbolicLink() || realpathSync(file) !== file)
        fail("CHARACTER_SOURCE_CHANGED", "登记文件在读取期间发生变化，请重新核验");
      return bytes;
    } finally { if (descriptor !== undefined) closeSync(descriptor); }
  });
}
function profileJson(file: string, root: string): Record<string, unknown> {
  const bytes = snapshotFile(file, root, MAX_PROFILE_BYTES, "profile");
  return guarded("CHARACTER_SOURCE_JSON_INVALID", "受控登记JSON损坏或不是对象，请修复登记文件后重新核验", () => {
    const value: unknown = JSON.parse(bytes.toString("utf8"));
    if (!plain(value)) fail("CHARACTER_SOURCE_JSON_INVALID", "受控登记JSON必须是对象");
    return value;
  });
}
function profiles(root: RegistrationRoot): Array<{ value: Record<string, unknown>; dir: string; file: string }> {
  if (!root.canonical) return [];
  const canonical = root.canonical;
  return guarded("CHARACTER_SOURCE_READ_FAILED", "受控资料库无法完整读取，请检查权限与完整性", () => {
    const result: Array<{ value: Record<string, unknown>; dir: string; file: string }> = [];
    // Keep the CLI's readdir/Map insertion order. Adding a new sorting rule would change
    // the documented first-profile fallback and explicit-id/name OR matching behavior.
    for (const name of readdirSync(canonical)) {
      const dir = join(canonical, name), stat = optionalStat(dir);
      if (!stat) fail("CHARACTER_SOURCE_CHANGED", "资料库条目在扫描期间消失，请重新核验");
      if (stat.isSymbolicLink()) fail("CHARACTER_SOURCE_PATH_INVALID", "资料库条目含符号链接，拒绝选择其他来源");
      if (!stat.isDirectory()) continue;
      if (realpathSync(dir) !== dir) fail("CHARACTER_SOURCE_PATH_INVALID", "登记目录越过可信资料库边界");
      const file = join(dir, "profile.json");
      if (!optionalStat(file)) continue;
      result.push({ value: profileJson(file, canonical), dir, file });
    }
    return result;
  });
}
function loadAssets(root: RegistrationRoot): RegisteredAsset[] {
  return profiles(root).map(({ value, dir, file }) => {
    if (!text(value.assetId) || !plain(value.certified) || !plain(value.authorization)
      || (value.referenceAssets !== undefined && (!Array.isArray(value.referenceAssets)
        || value.referenceAssets.some(item => typeof item !== "string"))))
      fail("CHARACTER_SOURCE_PROFILE_INVALID", "真人主档缺少有效素材标识、属性、授权或同组引用结构");
    return { asset: value as unknown as RealPersonAsset, dir, profileFile: file };
  });
}
function loadCharacters(roots: readonly RegistrationRoot[]): Map<string, RegisteredCharacter> {
  const library = new Map<string, RegisteredCharacter>();
  for (const root of roots) for (const { value } of profiles(root)) {
    if (!text(value.id) || !text(value.name)) fail("CHARACTER_SOURCE_PROFILE_INVALID", "角色主档缺少有效ID或姓名");
    const first = Array.isArray(value.wardrobe) && plain(value.wardrobe[0]) ? value.wardrobe[0] : {};
    library.set(value.id, { id: value.id, name: value.name, wardrobeLock: {
      id: String(first.id ?? first.name ?? ""),
      description: [first.name, first.detail].filter(Boolean).join("："),
    } });
  }
  return library;
}
function loadRegistry(file: string | undefined, roots: readonly RegistrationRoot[]): CharacterRegistry {
  const empty = { defaultModel: null, aliases: [] };
  if (file === undefined && !roots.length) return empty;
  const lexical = resolve(file ?? join(roots[roots.length - 1]!.lexical, "registry.json"));
  const matching = roots.find(root => inside(root.lexical, lexical) || (root.canonical && inside(root.canonical, lexical)));
  if (!matching) fail("CHARACTER_SOURCE_PATH_INVALID", "角色登记表必须位于可信角色资料库中");
  if (!matching.canonical) {
    if (!optionalStat(lexical)) return empty;
    return fail("CHARACTER_SOURCE_CHANGED", "角色资料库在扫描后变化，请重新核验");
  }
  const base = inside(matching.lexical, lexical) ? matching.lexical : matching.canonical;
  const canonicalFile = resolve(matching.canonical, relative(base, lexical));
  if (!optionalStat(canonicalFile)) return empty;
  const value = profileJson(canonicalFile, matching.canonical);
  if ((value.defaultModel !== undefined && value.defaultModel !== null && typeof value.defaultModel !== "string")
    || (value.models !== undefined && !Array.isArray(value.models)))
    fail("CHARACTER_SOURCE_PROFILE_INVALID", "角色登记表的默认角色或别名列表结构无效");
  const aliases = (value.models as unknown[] | undefined ?? []).map(model => {
    if (!plain(model) || !text(model.id) || (model.name !== undefined && typeof model.name !== "string")
      || (model.aliases !== undefined && (!Array.isArray(model.aliases) || model.aliases.some(name => typeof name !== "string"))))
      fail("CHARACTER_SOURCE_PROFILE_INVALID", "角色登记表的别名结构无效");
    return { id: model.id, names: [model.id, model.name ?? "", ...(model.aliases as string[] | undefined ?? [])].filter((name): name is string => !!name) };
  });
  return { defaultModel: value.defaultModel as string | null | undefined ?? null, aliases };
}
function selectLead(characters: Map<string, RegisteredCharacter>, registry: CharacterRegistry,
  character?: Record<string, unknown> | null): RegisteredCharacter | undefined {
  const list = [...characters.values()], explicitId = character?.id ?? "", explicitName = character?.name ?? "";
  if (typeof explicitId !== "string" || typeof explicitName !== "string") fail("CHARACTER_SOURCE_CHARACTER_INVALID", "冻结角色ID和姓名必须是字符串");
  // Preserve the existing CLI's one-pass OR rule, including contradictory id/name input.
  const byExplicit = list.find(item => item.id === explicitId || item.name === explicitName);
  if (byExplicit) return byExplicit;
  const alias = registry.aliases.find(item => item.names.some(name => name && name.length > 1 && explicitName.includes(name)));
  if (alias) return list.find(item => item.id === alias.id);
  if (registry.defaultModel) {
    const preferred = list.find(item => item.id === registry.defaultModel);
    if (preferred) return preferred;
  }
  return list[0];
}
function identityAnchor(entry: RegisteredAsset): CharacterIdentityAnchor {
  const name = entry.asset.anchorPhoto;
  if (!text(name)) fail("CHARACTER_SOURCE_ANCHOR_MISSING", "真人主档没有登记认证基准图，不能用生成首镜或角色定妆照替代");
  if (isAbsolute(name) || win32.isAbsolute(name) || /[\\]/.test(name) || /[\u0000-\u001f]/.test(name)
    || /^[A-Za-z][A-Za-z0-9+.-]*:/.test(name))
    fail("CHARACTER_SOURCE_PATH_INVALID", "认证基准图必须是登记asset目录内的相对普通文件");
  const file = resolve(entry.dir, name);
  if (!inside(entry.dir, file)) fail("CHARACTER_SOURCE_PATH_INVALID", "认证基准图越过登记asset目录边界");
  const bytes = snapshotFile(file, entry.dir, MAX_ANCHOR_BYTES, "anchor");
  return { path: file, sha256: createHash("sha256").update(bytes).digest("hex"), assetId: entry.asset.assetId,
    source: "registered-real-person-profile:" + entry.profileFile };
}
function wardrobe(value: unknown): CharacterWardrobeLock {
  if (!plain(value)) fail("CHARACTER_SOURCE_CHARACTER_INVALID", "冻结服饰锁必须是对象");
  // Pure contract validation owns missing/invalid id/description and explicit change rules.
  return structuredClone(value) as unknown as CharacterWardrobeLock;
}

/** Resolve trusted registration bytes independently, then use the existing pure contract rules. */
export function buildRegisteredCharacterReleaseSource(input: RegisteredCharacterReleaseSourceInput): RegisteredCharacterReleaseSource {
  if (!plain(input) || typeof input.projectId !== "string" || !Array.isArray(input.shots) || !Array.isArray(input.characterLibraryRoots)
    || (input.registryFile !== undefined && !text(input.registryFile))
    || (input.character !== undefined && input.character !== null && !plain(input.character)))
    fail("CHARACTER_SOURCE_INPUT_INVALID", "需要冻结镜头数组、可信角色root列表和角色声明对象");
  const roots = input.characterLibraryRoots.map(registrationRoot);
  const characters = loadCharacters(roots), registry = loadRegistry(input.registryFile, roots);
  const lead = selectLead(characters, registry, input.character);
  const entries = loadAssets(registrationRoot(input.assetLibraryRoot));
  // Keep every registration for the pure contract's duplicate-asset refusal. The lookup
  // keeps the old CLI's last-entry behavior, which cannot authorize a duplicate contract.
  const byAsset = new Map(entries.map(entry => [assetIdOf(entry.asset.assetId), entry]));
  const sourceShots: CharacterReleaseShotInput[] = [];
  const bindings = new Map<string, CharacterReleaseBindingInput>();
  const anchors = new Map<string, CharacterIdentityAnchor>();
  const baseline = input.character?.wardrobeLock ?? lead?.wardrobeLock ?? { id: "", description: "" };
  for (const shot of input.shots) {
    if (!plain(shot)) fail("CHARACTER_SOURCE_SHOT_INVALID", "冻结镜头必须是对象");
    if (shot.assetRef === undefined || (typeof shot.assetRef === "string" && !shot.assetRef.trim())) continue;
    if (!isRealPersonAssetRef(shot.assetRef) || !text(shot.shotId)
      || (shot.characterId !== undefined && shot.characterId !== null && typeof shot.characterId !== "string")
      || (shot.referenceAssets !== undefined && (!Array.isArray(shot.referenceAssets) || shot.referenceAssets.some(ref => typeof ref !== "string")))
      || (shot.wardrobeChange !== undefined && !plain(shot.wardrobeChange)))
      fail("CHARACTER_SOURCE_SHOT_INVALID", "冻结镜头的授权asset引用、人物标识或服饰声明结构无效");
    const assetRef = (shot.assetRef as string).trim(), id = String(shot.characterId ?? lead?.id ?? assetIdOf(assetRef));
    const entry = byAsset.get(assetIdOf(assetRef));
    let anchor: CharacterIdentityAnchor | undefined;
    if (entry) {
      anchor = anchors.get(entry.profileFile);
      if (!anchor) { anchor = identityAnchor(entry); anchors.set(entry.profileFile, anchor); }
    }
    bindings.set(id, { characterId: id, assetId: entry?.asset.assetId ?? assetIdOf(assetRef),
      wardrobeLock: wardrobe(baseline), ...(anchor ? { identityAnchor: structuredClone(anchor) } : {}) });
    sourceShots.push({ shotId: shot.shotId, characterId: id, assetRef,
      ...(shot.referenceAssets !== undefined ? { referenceAssets: [...shot.referenceAssets as string[]] } : {}),
      ...(shot.wardrobeLock !== undefined && shot.wardrobeLock !== null ? { wardrobeLock: wardrobe(shot.wardrobeLock) } : {}),
      ...(shot.wardrobeChange !== undefined ? { wardrobeChange: structuredClone(shot.wardrobeChange) as unknown as CharacterWardrobeChange } : {}),
    });
  }
  const resolved = [...bindings.values()];
  const contract = buildCharacterReleaseContract({ projectId: input.projectId,
    assets: entries.map(entry => entry.asset), characters: resolved, shots: sourceShots });
  return { contract, bindings: resolved };
}
