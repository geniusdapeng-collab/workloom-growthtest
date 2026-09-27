/**
 * character-archive —— 人物档案库（角色资产）P0 核心（T-2026-0923-0058）
 *
 * 设计见 `docs/character-archive-design.md`。要点：
 *   · 档案是**跨项目长期资产**：`var/media/characters/<id>/profile.json` + 多版本定妆照集；
 *   · 项目只做**引用**（`portrait-index.json` 指向库文件，可 pin 版本）；
 *   · 生成链路按镜头自动选角（1–10 人）并按配额挑参考图（Seedance 单次上限 4 张）；
 *   · 只增不改：换造型 = 新增 version，旧版保留，可做影响面分析。
 */
import { existsSync, readdirSync, readFileSync, lstatSync, realpathSync, mkdirSync, writeFileSync, renameSync, unlinkSync, openSync, closeSync } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { dirname, isAbsolute, join, relative, sep, resolve as resolvePath } from "node:path";
import { normalizeShotIntent, shotIntentHash, shotText, splitShotAssertions, type ShotIntentStatus } from "./shot-intent.js";

export type CharacterKind = "generated" | "authorized-real" | "virtual-preset";

export interface PortraitArtifactReceipt {
  path: string;
  realPath: string;
  sha256: string;
  bytes: number;
}

export interface PortraitSet {
  schemaVersion?: "workloom.portrait-set/v2";
  version: number;
  /** 相对角色目录（如 `portraits/v2`）或绝对路径 */
  dir: string;
  angles: string[];
  /** 来源：纯文生图 / 图生图 / 授权真人素材 */
  source: "pure-t2i" | "img2img" | "real-authorized";
  /**
   * 图生图锚点（授权真人素材）——只记录**相对角色目录**的路径，便于审计与复现；
   * 原始照片本身不进仓库、不外发（2026-09-24 真人出镜加装）。
   */
  anchors?: string[];
  /** 生成失败的角度（逐角度隔离；角度数组 angles 只含成功项） */
  failedAngles?: Array<{ angle: string; error: string }>;
  /** 背景干净度实测（抠像友好硬闸的留痕：阈值口径 + 逐角度实测值） */
  backgroundChecks?: Record<string, Record<string, unknown>>;
  active?: boolean;
  model?: string;
  seed?: number;
  prompt?: string;
  createdAt?: string;
  status?: "candidate" | "ready" | "failed";
  sourceHash?: string;
  requestHash?: string;
  wardrobe?: Record<string, unknown>;
  wardrobeHash?: string;
  /** Exact relative paths are authoritative for v2; filenames never choose a version. */
  files?: Record<string, string>;
  artifacts?: Record<string, PortraitArtifactReceipt>;
  angleRequests?: Record<string, string>;
  backgroundRequired?: boolean;
}

export interface CharacterProfile {
  schemaVersion: string;
  id: string;
  name: string;
  kind: CharacterKind;
  identity?: Record<string, unknown>;
  appearance?: Record<string, unknown>;
  wardrobe?: Array<Record<string, unknown>>;
  activeWardrobeId?: string;
  aliases?: string[];
  style?: string;
  subjectType?: string;
  persona?: Record<string, unknown>;
  biography?: string[];
  relations?: Array<{ characterId: string; relation: string }>;
  generation?: Record<string, unknown>;
  authorization?: { status?: string; evidence?: string; expiresAt?: string; note?: string };
  portraitSets: PortraitSet[];
  tags?: string[];
  createdAt?: string;
  updatedAt?: string;
}

export interface CharacterEntry extends CharacterProfile {
  /** 角色目录绝对路径 */
  dir: string;
  /** 当前生效的定妆照集 */
  activeSet: PortraitSet | null;
  /** 角度 → 绝对路径（库内文件）或 asset:// 引用 */
  files: Record<string, string>;
  verification: PortraitVersionVerification;
}

export interface PortraitVersionVerification {
  status: ShotIntentStatus;
  scope: "generation-receipt-and-current-bytes" | "legacy-current-bytes-only" | "no-selected-version";
  version: number | null;
  assets: Record<string, PortraitArtifactReceipt>;
  issues: string[];
}

/** 渲染核心必需角度（vendor REQUIRED_ANGLES 口径） */
export const REQUIRED_PORTRAIT_ANGLES = ["front", "threeQuarter", "closeup", "side"] as const;

const IMAGE_EXT = /\.(png|jpe?g|webp)$/i;
const plain = (value: unknown): value is Record<string, unknown> => Boolean(value && typeof value === "object" && !Array.isArray(value));
const inside = (root: string, file: string): boolean => { const rel = relative(root, file); return rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel); };

export function assertCharacterComponent(value: string): void {
  if (!value || [".", "..", "__proto__", "constructor", "prototype"].includes(value) || /[\\/\u0000-\u001f]/.test(value)) throw new Error("CHARACTER_PATH_INVALID: 角色或项目标识不能作为安全路径");
}

/** Local asset evidence, never an assertion about face identity or provider authorization. */
export function readPortraitArtifact(file: string, root?: string): PortraitArtifactReceipt {
  const absolute = resolvePath(file); const realPath = realpathSync(absolute); const stat = lstatSync(absolute);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size < 1024 || stat.size > 100_000_000) throw new Error(`PORTRAIT_ASSET_INVALID: 不是有效普通图片文件：${file}`);
  if (root) {
    const lexicalRoot = resolvePath(root); const canonicalRoot = realpathSync(root);
    if (!inside(lexicalRoot, absolute) || !inside(canonicalRoot, realPath) || realPath !== join(canonicalRoot, relative(lexicalRoot, absolute))) throw new Error(`PORTRAIT_ASSET_INVALID: 文件越界或父目录为symlink：${file}`);
  }
  const bytes = readFileSync(absolute);
  if (bytes.length !== stat.size || realpathSync(absolute) !== realPath) throw new Error(`PORTRAIT_ASSET_CHANGED: 读取期间文件变化：${file}`);
  return { path: absolute, realPath, sha256: createHash("sha256").update(bytes).digest("hex"), bytes: bytes.length };
}

export function writePortraitJson(file: string, value: unknown): void {
  const temporary = join(dirname(file), `.portrait-${randomUUID()}.tmp`);
  try {
    writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { flag: "wx", mode: 0o600 });
    renameSync(temporary, file);
  } finally { if (existsSync(temporary)) unlinkSync(temporary); }
}

export async function withCharacterArchiveLock<T>(dir: string, operation: () => Promise<T>): Promise<T> {
  const file = join(dir, ".portrait-agent.lock"); const token = JSON.stringify({ pid: process.pid, token: randomUUID() });
  let fd: number;
  try { fd = openSync(file, "wx", 0o600); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "EEXIST") throw new Error("PORTRAIT_ARCHIVE_BUSY: 角色档案已有生成或激活操作；禁止偷锁重复出图"); throw error; }
  try { writeFileSync(fd, token); } finally { closeSync(fd); }
  try { return await operation(); }
  finally {
    if (lstatSync(file).isSymbolicLink() || readFileSync(file, "utf8") !== token) throw new Error("PORTRAIT_ARCHIVE_LOCK_CHANGED: 不删除其他操作的锁");
    unlinkSync(file);
  }
}

export function selectPortraitWardrobe(profile: CharacterProfile, options: { wardrobeId?: string; wardrobe?: Record<string, unknown> } = {}): Record<string, unknown> {
  if (options.wardrobe && options.wardrobeId) throw new Error("PORTRAIT_WARDROBE_INVALID: 不能同时指定服装内容和服装ID");
  if (options.wardrobe) {
    if (!plain(options.wardrobe) || !shotText(options.wardrobe.name).trim()) throw new Error("PORTRAIT_WARDROBE_INVALID: 新服装必须有名称");
    shotIntentHash(options.wardrobe); return structuredClone(options.wardrobe);
  }
  const wardrobe = profile.wardrobe ?? [];
  if (!Array.isArray(wardrobe) || wardrobe.some((item) => !plain(item))) throw new Error("PORTRAIT_WARDROBE_INVALID: 服装列表无效");
  const id = options.wardrobeId ?? profile.activeWardrobeId;
  if (id) {
    const matches = wardrobe.filter((item) => item.id === id);
    if (matches.length !== 1) throw new Error(`PORTRAIT_WARDROBE_INVALID: 服装ID未唯一匹配：${id}`);
    return structuredClone(matches[0]!);
  }
  if (wardrobe.length > 1) throw new Error("PORTRAIT_WARDROBE_AMBIGUOUS: 多套服装必须指定wardrobeId");
  return structuredClone(wardrobe[0] ?? {});
}

/**
 * 在目录里找某角度的图。
 *
 * 首选规范命名 `<name>-<angle>.png` / `<name>-<angle>-v2.png`；
 * **回退口径**（2026-09-24 真机发现）：按"任意前缀-<角度>"匹配。
 * 起因：随仓分发的 1 号模特 `chen-zhuo` 档案里 `name` 是"陈卓"，
 * 但 `portraits/v3/` 下的文件是"平江路讲述人-front.png"（沿用上一代素材的文件名前缀）——
 * 严格按档案名匹配时 8 张定妆照**全部匹配不到**，于是"角色有定妆照"这件事对所有消费者都不存在
 * （G5 门因此亮红、图生图锚点为空，而链路表面上一切正常）。
 * 文件名前缀不是身份的唯一来源，档案 `name` 才是；因此这里允许前缀不同、以角度后缀为准。
 * 导出供 CLI/工位复用（避免各处再写一套匹配规则）。
 */
export function findAngleFile(dir: string, name: string, angle: string): string | null {
  if (!/^[a-zA-Z][a-zA-Z0-9]*$/.test(angle)) return null;
  if (!existsSync(dir)) return null;
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return null;
  }
  const exact = `${name}-${angle}`;
  const suffix = new RegExp(`-${angle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?:[-.]|$)`, "i");
  const candidates = entries.filter((file) => IMAGE_EXT.test(file) && suffix.test(file));
  const exactFiles = candidates.filter((file) => file.startsWith(`${exact}.`));
  const selected = exactFiles.length > 0 ? exactFiles : candidates;
  // Legacy compatibility allows one unambiguous file, never a lexicographic version guess.
  return selected.length === 1 ? join(dir, selected[0]!) : null;
}

export function verifyPortraitSet(dir: string, profile: CharacterProfile, set: PortraitSet): { files: Record<string, string>; verification: PortraitVersionVerification } {
  const files: Record<string, string> = {}; const assets: Record<string, PortraitArtifactReceipt> = {}; const issues: string[] = [];
  const modern = set.schemaVersion === "workloom.portrait-set/v2";
  const setDir = resolvePath(dir, set.dir);
  if (!inside(resolvePath(dir), setDir)) issues.push("定妆照目录逃离角色目录");
  if (modern && (set.status !== "ready" || !/^[a-f0-9]{64}$/.test(set.requestHash ?? "") || !/^[a-f0-9]{64}$/.test(set.sourceHash ?? "") || set.wardrobeHash !== shotIntentHash(set.wardrobe ?? {}))) issues.push("候选尚未完整或生成来源/服装收据无效");
  const seen = new Set<string>();
  // All declared angles belong to this immutable version, including optional back/action
  // views. Checking only the required four would let a changed fifth image be overwritten
  // in a ready version during a cache read.
  const angles = [...new Set<string>([...REQUIRED_PORTRAIT_ANGLES, ...set.angles])];
  if (new Set(set.angles).size !== set.angles.length) issues.push("版本角度重复");
  for (const angle of angles) {
    try {
      if (!/^[a-zA-Z][a-zA-Z0-9]*$/.test(angle) || ["constructor", "prototype"].includes(angle)) throw new Error("版本角度无效");
      if (!set.angles?.includes(angle)) throw new Error(`缺少必需角度 ${angle}`);
      const stored = set.files?.[angle];
      if (modern && !stored) throw new Error(`缺少 ${angle} 精确文件记录`);
      const file = stored ? resolvePath(dir, stored) : findAngleFile(setDir, profile.name, angle);
      if (!file || !inside(setDir, file)) throw new Error(`${angle} 文件缺失、歧义或不在版本目录`);
      const receipt = readPortraitArtifact(file, dir);
      if (seen.has(receipt.realPath)) throw new Error(`${angle} 与其他角度指向同一文件`);
      seen.add(receipt.realPath);
      if (modern && shotIntentHash(receipt) !== shotIntentHash(set.artifacts?.[angle] ?? null)) throw new Error(`${angle} 当前字节与生成收据不符`);
      if (modern && !/^[a-f0-9]{64}$/.test(set.angleRequests?.[angle] ?? "")) throw new Error(`${angle} 缺实际请求收据`);
      if (modern && set.backgroundRequired !== false) {
        const check = set.backgroundChecks?.[angle];
        if (!check || check.ok !== true || ![check.cornerSpread, check.maxRange, check.maxSat].every((value) => typeof value === "number" && Number.isFinite(value))) throw new Error(`${angle} 背景核验无效`);
      }
      files[angle] = file; assets[angle] = receipt;
    } catch (error) { issues.push(error instanceof Error ? error.message : String(error)); }
  }
  return { files: issues.length === 0 ? files : {}, verification: { status: issues.length === 0 ? "passed" : "unverified", scope: modern ? "generation-receipt-and-current-bytes" : "legacy-current-bytes-only", version: set.version, assets, issues } };
}

/** Only explicit active or pinned versions are selected; inactive candidates never become fallback. */
export function loadCharacterEntry(dir: string, options: { pinnedVersion?: number; wardrobeId?: string; wardrobe?: Record<string, unknown> } = {}): CharacterEntry | null {
  const profileFile = join(dir, "profile.json");
  if (!existsSync(profileFile)) return null;
  if (lstatSync(profileFile).isSymbolicLink()) throw new Error("CHARACTER_ARCHIVE_INVALID: profile不能是symlink");
  const profile = JSON.parse(readFileSync(profileFile, "utf8")) as CharacterProfile;
  if (!plain(profile) || profile.schemaVersion !== "workloom.character-profile/v1" || !profile.id || !profile.name || !Array.isArray(profile.portraitSets)) throw new Error("CHARACTER_ARCHIVE_INVALID: 档案结构无效");
  assertCharacterComponent(profile.id);
  const sets = profile.portraitSets;
  if (sets.some((set) => !plain(set) || !Number.isInteger(set.version) || set.version < 1 || typeof set.dir !== "string" || !Array.isArray(set.angles)) || new Set(sets.map((set) => set.version)).size !== sets.length) throw new Error("CHARACTER_ARCHIVE_INVALID: 版本无效或重复");
  if (options.pinnedVersion !== undefined && (!Number.isInteger(options.pinnedVersion) || options.pinnedVersion < 1)) throw new Error("PORTRAIT_VERSION_INVALID: pin必须为正整数");
  const active = sets.filter((set) => set.active === true);
  if (active.length > 1) throw new Error("PORTRAIT_VERSION_AMBIGUOUS: 同时激活多个版本");
  const activeSet = (options.pinnedVersion === undefined ? active[0] : sets.find((set) => set.version === options.pinnedVersion)) ?? null;
  let checked: ReturnType<typeof verifyPortraitSet> = activeSet ? verifyPortraitSet(dir, profile, activeSet) : { files: {}, verification: { status: "unverified", scope: "no-selected-version", version: null, assets: {}, issues: [options.pinnedVersion ? `指定版本 v${options.pinnedVersion} 不存在` : "没有显式激活版本"] } };
  if (activeSet && (options.wardrobeId || options.wardrobe)) {
    const wardrobe = selectPortraitWardrobe(profile, options);
    if (activeSet.wardrobeHash !== shotIntentHash(wardrobe)) checked = { files: {}, verification: { ...checked.verification, status: "unverified", issues: [...checked.verification.issues, "指定服装与当前版本不一致，需要生成或选择该服装候选"] } };
  }
  return { ...profile, dir: resolvePath(dir), activeSet, ...checked };
}

/** Explicit activation rechecks exact files and only replaces the active pointer after validation. */
export async function activatePortraitVersion(libraryRoot: string, characterId: string, version: number): Promise<CharacterEntry> {
  assertCharacterComponent(characterId); const dir = resolvePath(libraryRoot, characterId);
  if (lstatSync(dir).isSymbolicLink() || realpathSync(dir) !== join(realpathSync(libraryRoot), characterId)) throw new Error("CHARACTER_PATH_INVALID: 角色目录越界或为symlink");
  return withCharacterArchiveLock(dir, async () => {
    const entry = loadCharacterEntry(dir, { pinnedVersion: version });
    if (!entry || entry.id !== characterId || entry.verification.status !== "passed" || !entry.activeSet) throw new Error(`PORTRAIT_ACTIVATION_UNVERIFIED: ${entry?.verification.issues.join("；") || "档案不存在或ID不一致"}`);
    const profileFile = join(dir, "profile.json"); const profile = JSON.parse(readFileSync(profileFile, "utf8")) as CharacterProfile;
    const updated = { ...profile, portraitSets: profile.portraitSets.map((set) => ({ ...set, active: set.version === version })), updatedAt: new Date().toISOString() };
    const metadataDir = join(dir, "portrait-sets"); mkdirSync(metadataDir, { recursive: true });
    if (lstatSync(metadataDir).isSymbolicLink()) throw new Error("CHARACTER_PATH_INVALID: 版本元数据目录不能是symlink");
    writePortraitJson(join(metadataDir, `v${version}.json`), updated.portraitSets.find((set) => set.version === version));
    writePortraitJson(profileFile, updated);
    return loadCharacterEntry(dir)!;
  });
}

/** 读取档案库（目录下每个子目录一个角色） */
export function loadCharacterLibrary(root: string): Map<string, CharacterEntry> {
  const library = new Map<string, CharacterEntry>();
  if (!existsSync(root)) return library;
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name.startsWith("_")) continue;
    const loaded = loadCharacterEntry(resolvePath(root, entry.name));
    if (loaded) {
      if (library.has(loaded.id)) throw new Error(`CHARACTER_ARCHIVE_INVALID: 重复角色ID ${loaded.id}`);
      library.set(loaded.id, loaded);
    }
  }
  return library;
}

export interface ShotLikeForCasting {
  character?: unknown;
  characters?: unknown;
  character_ref?: unknown;
  characterRef?: unknown;
  prompt?: unknown;
  scene?: unknown;
  dialogueBlocks?: unknown;
  [key: string]: unknown;
}

/** Only original positive visual fields supply on-screen names; a dialogue speaker may be off-screen. */
export function shotCastingText(shot: ShotLikeForCasting): string {
  const source = normalizeShotIntent(shot).source;
  const fields = plain(source.fields) ? source.fields : {};
  const read = (key: string) => source[key] ?? fields[key];
  const visibleText = (value: unknown): string => Array.isArray(value) ? value.map(visibleText).filter(Boolean).join("；") : plain(value) && (value.onScreen === false || value.offScreen === true) ? "" : shotText(value);
  const visual = ["characters", "character", "characterId", "cast", "character_ref", "characterRef", "scene", "sceneDescription", "description", "action"].map((key) => visibleText(read(key))).filter(Boolean);
  if (visual.length === 0 && typeof source.prompt === "string") visual.push(source.prompt);
  return splitShotAssertions(visual.join("；")).positive.split(/[；。\n]/).filter((part) => !/旁白|画外|off[ -]?screen|voice[ -]?over/i.test(part)).join("；");
}

export interface CastingResult {
  characters: CharacterEntry[];
  /** 文本里提到、但档案库里没有的名字（提示建档） */
  unmatched: string[];
  status: ShotIntentStatus;
  sourceHash: string;
  expectedCount: number | null;
  notes: string[];
  selections: CastSelection[];
}

export interface CastSelection { characterId: string; pinnedVersion?: number; wardrobeId?: string; wardrobe?: Record<string, unknown>; costume?: string }
export interface CastIdentity { id: string; name: string; aliases?: string[] }
export interface CastResolution<T extends CastIdentity> extends Omit<CastingResult, "characters"> { characters: T[] }

/** Shared archive/project-index resolver. It never guesses identity from library size. */
export function resolveShotCast<T extends CastIdentity>(shot: ShotLikeForCasting, candidates: T[]): CastResolution<T> {
  const intent = normalizeShotIntent(shot); const source = intent.source;
  const fields = plain(source.fields) ? source.fields : {};
  const read = (key: string) => source[key] ?? fields[key];
  const base = { sourceHash: intent.sourceHash, expectedCount: null as number | null, unmatched: [] as string[], notes: [] as string[], selections: [] as CastSelection[] };
  const failure = (status: ShotIntentStatus, note: string, extra: Partial<typeof base> = {}): CastResolution<T> => ({ ...base, ...extra, characters: [], status, notes: [note, ...(extra.notes ?? [])] });
  const explicitEntries = ["cast", "characters", "characterId", "character", "character_ref", "characterRef"].map((field) => ({ field, value: read(field) })).filter(({ value }) => value !== undefined && value !== null);
  const explicitValues = explicitEntries.map(({ value }) => value);
  const raw: Array<{ name: string; data: Record<string, unknown>; field: string }> = [];
  let currentField = "";
  function add(value: unknown): void {
    if (Array.isArray(value)) { for (const item of value) add(item); return; }
    if (plain(value)) {
      if (value.onScreen === false || value.offScreen === true) return;
      if (Array.isArray(value.characters)) { add(value.characters); return; }
      const name = value.characterId ?? value.id ?? value.name ?? value.lead;
      if (typeof name !== "string") throw new Error("显式cast缺少角色ID/name");
      raw.push({ name: name.trim(), data: value, field: currentField }); return;
    }
    if (typeof value !== "string") throw new Error("显式cast必须是名称、数组或角色对象");
    const positive = splitShotAssertions(value).positive.trim();
    if (!positive || /^(?:无|无人物|无角色|none|null|n\/a)$/i.test(positive)) return;
    const namePart = positive.split(/[:：]/)[0]!.trim();
    for (const name of namePart.split(/[、,，;；|/&]|\s+(?:and|with)\s+/i).map((item) => item.trim()).filter(Boolean)) raw.push({ name, data: {}, field: currentField });
  }
  try { for (const { field, value } of explicitEntries) { currentField = field; add(value); } }
  catch (error) { return failure("failed", error instanceof Error ? error.message : String(error)); }
  const descriptor = ["scene", "sceneDescription", "description", "action", "composition"].map((key) => shotText(read(key))).join("；");
  const subject = plain(read("subject")) ? read("subject") as Record<string, unknown> : {};
  const explicitNoPerson = subject.hasPerson === false || subject.count === 0 || /^(?:none|object|product|environment|landscape|animal)$/.test(String(subject.kind ?? ""))
    || /空镜|无人(?!机)|无人物|无角色|没有(?:任何)?(?:人|人物|角色)|不出现(?:任何)?(?:人|人物|角色)|\bno (?:people|person|human|character)s?\b/i.test(descriptor)
    || explicitValues.some((value) => typeof value === "string" && /^(?:无|无人物|无角色|none|null)$/i.test(value.trim()));
  if (explicitNoPerson) return failure(raw.length ? "failed" : "not_applicable", raw.length ? "原镜头明确无人，但显式cast仍声明人物" : "原镜头明确无人，不绑定人物", { expectedCount: 0 });
  if (raw.length === 0 && ["animal", "object"].includes(intent.subject.kind)) return failure("not_applicable", `原镜头主体为${intent.subject.kind}，不从档案库带入人物`, { expectedCount: 0 });
  const text = shotCastingText(source);
  const matchIdentity = (name: string): T[] => candidates.filter((candidate) => [candidate.id, candidate.name, ...(candidate.aliases ?? [])].some((token) => token === name || name === `${token}-front` || name === `${token}-side`));
  const matched: T[] = []; const unmatched: string[] = []; const selectors = new Map<string, Record<string, unknown>>();
  for (const selected of raw) {
    const hits = matchIdentity(selected.name);
    if (hits.length > 1) return failure("unverified", `角色名称存在歧义：${selected.name}`, { unmatched: [selected.name] });
    if (hits.length === 0) { unmatched.push(selected.name); continue; }
    const hit = hits[0]!;
    const previous = selectors.get(hit.id);
    if (previous && Object.keys(previous).length && Object.keys(selected.data).length && shotIntentHash(previous) !== shotIntentHash(selected.data)) return failure("failed", `同一角色重复声明不同版本或服装：${hit.id}`);
    if (!matched.includes(hit)) matched.push(hit);
    if (!previous || Object.keys(selected.data).length) selectors.set(hit.id, selected.data);
  }
  // A structured cast can refine versions/outfits but cannot replace the author identities
  // declared in character/characters. The singular field may identify a lead in a wider cast.
  const castIds = new Set(raw.filter((item) => item.field === "cast").flatMap((item) => matchIdentity(item.name).map((hit) => hit.id)));
  if (castIds.size) {
    const otherIds = raw.filter((item) => item.field !== "cast").flatMap((item) => matchIdentity(item.name).map((hit) => hit.id));
    const pluralIds = new Set(raw.filter((item) => item.field === "characters").flatMap((item) => matchIdentity(item.name).map((hit) => hit.id)));
    if (otherIds.some((id) => !castIds.has(id)) || (pluralIds.size > 0 && [...castIds].some((id) => !pluralIds.has(id)))) return failure("failed", "显式cast与原角色字段身份不一致，不能通过合并名单替换或追加人物");
  }
  if (raw.length === 0) {
    const hits = candidates.flatMap((candidate) => [candidate.id, candidate.name, ...(candidate.aliases ?? [])].filter(Boolean).map((token) => ({ candidate, token, position: text.indexOf(token) })))
      .filter(({ token, position }) => position >= 0 && (/[\u3400-\u9fff]/.test(token) || new RegExp(`(?<![A-Za-z0-9_-])${token.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![A-Za-z0-9_-])`).test(text)))
      .sort((a, b) => a.position - b.position || b.token.length - a.token.length);
    const usedRanges: Array<[number, number]> = [];
    for (const hit of hits) {
      if (usedRanges.some(([start, end]) => hit.position >= start && hit.position < end) || matched.includes(hit.candidate)) continue;
      if (new Set(hits.filter((other) => other.position === hit.position && other.token === hit.token).map((other) => other.candidate.id)).size > 1) return failure("unverified", `原镜头名称存在多角色歧义：${hit.token}`);
      usedRanges.push([hit.position, hit.position + hit.token.length]); matched.push(hit.candidate);
    }
  }
  const countRaw = subject.count ?? read("characterCount") ?? read("personCount");
  const countWords: Record<string, number> = { 一: 1, 两: 2, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10 };
  const countMatch = splitShotAssertions(descriptor).positive.match(/([一两二三四五六七八九十]|\d+)\s*(?:个人|人)(?!物)|(?:单人|只有一人|仅一人)|(双人)/);
  const statedCount = countMatch ? countMatch[1] ? Number(countMatch[1]) || countWords[countMatch[1]]! : countMatch[2] ? 2 : 1 : null;
  const expectedCount = countRaw !== undefined ? Number(countRaw) : statedCount ?? (raw.length ? matched.length + unmatched.length : intent.subject.count || null);
  if (expectedCount !== null && (!Number.isInteger(expectedCount) || expectedCount < 1 || expectedCount > 10)) return failure("failed", "人物数量必须为1到10的整数", { expectedCount });
  if (unmatched.length > 0) return failure("unverified", "显式cast含未建档身份，不能用其他人物补位", { expectedCount, unmatched });
  if (matched.length === 0 && raw.length === 0 && intent.subject.kind === "environment") return failure("not_applicable", "环境镜头没有出镜人物证据", { expectedCount: 0 });
  if (matched.length === 0) return failure("unverified", "原镜头人物身份未唯一确定；旁白或唯一档案不构成出镜证据", { expectedCount });
  if (expectedCount !== null && expectedCount !== matched.length) return failure("failed", `原镜头人数${expectedCount}与已匹配人物${matched.length}不一致`, { expectedCount });
  if (/人群|众人|多人|群像/.test(descriptor) && countRaw === undefined && statedCount === null) return failure("unverified", "群像人数未明确，不能把已命名主角当成全部出镜人物");
  const selections: CastSelection[] = [];
  for (const character of matched) {
    const selected = selectors.get(character.id) ?? {};
    const version = selected.pinnedVersion ?? selected.portraitVersion ?? (matched.length === 1 ? read("pinnedVersion") ?? read("portraitVersion") : undefined);
    const wardrobeId = selected.wardrobeId ?? (matched.length === 1 ? read("wardrobeId") : undefined);
    const wardrobe = selected.wardrobe ?? (matched.length === 1 ? read("wardrobe") : undefined);
    const costume = selected.costume ?? (matched.length === 1 ? read("costume") : undefined);
    if (version !== undefined && (!Number.isInteger(version) || Number(version) < 1)) return failure("failed", "角色指定版本必须是正整数");
    if (wardrobeId !== undefined && (typeof wardrobeId !== "string" || !wardrobeId.trim())) return failure("failed", "服装ID无效");
    if (wardrobe !== undefined && !plain(wardrobe)) return failure("failed", "显式服装必须是对象");
    if (costume !== undefined && typeof costume !== "string") return failure("failed", "服装文本无效，需按角色提供明确服装");
    selections.push({ characterId: character.id, ...(version !== undefined ? { pinnedVersion: Number(version) } : {}), ...(typeof wardrobeId === "string" ? { wardrobeId } : {}), ...(plain(wardrobe) ? { wardrobe } : {}), ...(typeof costume === "string" && costume.trim() ? { costume } : {}) });
  }
  return { ...base, status: "passed", characters: matched, expectedCount: expectedCount ?? matched.length, selections, notes: [raw.length ? "按原镜头显式cast逐人匹配" : "按原镜头肯定出镜文本匹配；未使用唯一角色兜底"] };
}

/**
 * 镜头选角：按"先显式字段、后文本"的顺序匹配档案库里的 id/name。
 * 支持一次匹配多人（1–10），并保持出场顺序（显式 characters 数组优先）。
 */
export function resolveShotCharacters(
  shot: ShotLikeForCasting,
  library: Map<string, CharacterEntry>
): CastingResult {
  const resolved = resolveShotCast(shot, [...library.values()]);
  if (resolved.status !== "passed") return resolved;
  const characters: CharacterEntry[] = []; const notes = [...resolved.notes];
  for (const selection of resolved.selections) {
    const original = library.get(selection.characterId)!;
    const character = loadCharacterEntry(original.dir, selection);
    if (!character || character.verification.status !== "passed") return { ...resolved, characters: [], status: "unverified", notes: [...notes, `${original.name}：${character?.verification.issues.join("；") ?? "档案已消失"}`] };
    if (selection.costume && !portraitWardrobeMatches(character.activeSet?.wardrobe, selection.costume)) return { ...resolved, characters: [], status: "unverified", notes: [...notes, `${original.name} 原镜头服装与当前版本不一致或缺少服装收据，需要生成/选择新服装候选`] };
    characters.push(character);
  }
  return { ...resolved, characters, notes };
}

export function portraitWardrobeMatches(wardrobe: Record<string, unknown> | undefined, costume: string): boolean {
  if (/^(?:与|按)?(?:角色)?档案(?:中)?(?:的)?服装(?:保持)?一致[。.]?$|^保持原服装$/.test(costume.trim())) return true;
  if (!wardrobe) return false;
  const normalize = (value: string) => value.replace(/^(?:身穿|穿着|穿)/, "").replace(/[\s，。；、:：,.;（）()]/g, "");
  const declared = normalize(costume);
  return Boolean(declared) && [shotText(wardrobe.name), [shotText(wardrobe.name), shotText(wardrobe.detail)].filter(Boolean).join("，")].some((value) => normalize(value) === declared);
}

export interface SlotCharacterInput {
  id: string;
  name: string;
  /** 该角色的定妆照（角度 → 路径/asset 引用） */
  files: Record<string, string>;
  /** 台词条数（优先级用） */
  dialogueLines?: number;
  /** 是否主角 */
  lead?: boolean;
}

export interface SlotPlan {
  status: ShotIntentStatus;
  references: string[];
  used: Array<{ id: string; name: string; angle: string }>;
  venueUsed: string[];
  dropped: Array<{ id: string; name: string; reason: string }>;
  note: string;
}

/**
 * 参考图配额分配（Seedance 单次上限 4 张）：
 *   优先级 = 主角 > 有台词 > 出场顺序；人物优先占位，剩余给场景。
 *   超员或缺照返回 unverified 和空参考图，避免静默丢失人物身份。
 */
export function allocateReferenceSlots(options: {
  characters: SlotCharacterInput[];
  venueRefs: string[];
  maxRefs?: number;
  /** 每个角色的首选角度（默认 closeup → front） */
  anglePreference?: string[];
}): SlotPlan {
  const max = options.maxRefs ?? 4;
  if (!Number.isInteger(max) || max < 1 || max > 4) throw new Error("PORTRAIT_REFERENCE_LIMIT_INVALID: 配额必须为1..4");
  if (new Set(options.characters.map((character) => character.id)).size !== options.characters.length) throw new Error("PORTRAIT_CAST_INVALID: 参考图分配中人物ID重复");
  const angles = options.anglePreference ?? ["closeup", "front", "threeQuarter", "side"];
  const ranked = [...options.characters]
    .map((character, index) => ({ character, index }))
    .sort((a, b) => {
      const lead = Number(Boolean(b.character.lead)) - Number(Boolean(a.character.lead));
      if (lead !== 0) return lead;
      const lines = (b.character.dialogueLines ?? 0) - (a.character.dialogueLines ?? 0);
      if (lines !== 0) return lines;
      return a.index - b.index;
    })
    .map((r) => r.character);

  /** Every named on-screen identity needs a slot; venue images use only the remainder. */
  const maxCharacters = Math.min(ranked.length, max);
  const used: SlotPlan["used"] = [];
  const references: string[] = [];
  const dropped: SlotPlan["dropped"] = [];
  for (const [index, character] of ranked.entries()) {
    const angle = angles.find((a) => character.files[a]);
    if (index >= maxCharacters || !angle) {
      dropped.push({ id: character.id, name: character.name, reason: index >= maxCharacters ? "人物参考图配额不足，需要同框候选或拆镜，不能丢失身份" : "该角色没有可用定妆照" });
      continue;
    }
    references.push(character.files[angle]!);
    used.push({ id: character.id, name: character.name, angle });
  }
  if (dropped.length > 0) return { status: "unverified", references: [], used: [], venueUsed: [], dropped, note: `人物参考未完整：${dropped.map((item) => `${item.name} ${item.reason}`).join("；")}` };
  const venueUsed = [...new Set(options.venueRefs)].filter((file) => !references.includes(file)).slice(0, Math.max(0, max - references.length));
  references.push(...venueUsed);
  return {
    status: options.characters.length ? "passed" : "not_applicable",
    references,
    used,
    venueUsed,
    dropped,
    note: [
      `人物 ${used.length} 张（${used.map((u) => `${u.name}:${u.angle}`).join("、") || "无"}）`,
      `场景 ${venueUsed.length} 张`,
      dropped.length > 0 ? `降级 ${dropped.length} 人（${dropped.map((d) => d.name).join("、")}）` : null
    ].filter(Boolean).join(" + ")
  };
}

/** 定妆照集版本列表（从新到旧） */
export function listPortraitVersions(profile: CharacterProfile): PortraitSet[] {
  return [...(profile.portraitSets ?? [])].sort((a, b) => b.version - a.version);
}

export interface ProjectBinding {
  projectId: string;
  characterId: string;
  /** 缺省 = 下次绑定时解析 active；已生成的项目索引保持绑定时的版本快照。 */
  pinnedVersion?: number;
}

/**
 * 版本影响面：某角色换代后，pin 旧版需评估重渲；未 pin 项目下次绑定时可解析新 active。
 */
export function impactOfVersionChange(
  bindings: ProjectBinding[],
  change: { characterId: string; fromVersion: number; toVersion: number }
): { followActive: ProjectBinding[]; pinnedOld: ProjectBinding[]; pinnedNew: ProjectBinding[] } {
  const related = bindings.filter((b) => b.characterId === change.characterId);
  return {
    followActive: related.filter((b) => b.pinnedVersion === undefined),
    pinnedOld: related.filter((b) => b.pinnedVersion === change.fromVersion),
    pinnedNew: related.filter((b) => b.pinnedVersion === change.toVersion)
  };
}
