/**
 * character-archive —— 人物档案库（角色资产）P0 核心（T-2026-0923-0058）
 *
 * 设计见 `docs/character-archive-design.md`。要点：
 *   · 档案是**跨项目长期资产**：`var/media/characters/<id>/profile.json` + 多版本定妆照集；
 *   · 项目只做**引用**（`portrait-index.json` 指向库文件，可 pin 版本）；
 *   · 生成链路按镜头自动选角（1–10 人）并按配额挑参考图（Seedance 单次上限 4 张）；
 *   · 只增不改：换造型 = 新增 version，旧版保留，可做影响面分析。
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, resolve as resolvePath } from "node:path";

export type CharacterKind = "generated" | "authorized-real" | "virtual-preset";

export interface PortraitSet {
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
}

export interface CharacterProfile {
  schemaVersion: string;
  id: string;
  name: string;
  kind: CharacterKind;
  identity?: Record<string, unknown>;
  appearance?: Record<string, unknown>;
  wardrobe?: Array<Record<string, unknown>>;
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
}

/** 渲染核心必需角度（vendor REQUIRED_ANGLES 口径） */
export const REQUIRED_PORTRAIT_ANGLES = ["front", "threeQuarter", "closeup", "side"] as const;

const IMAGE_EXT = /\.(png|jpe?g|webp)$/i;

/** 在目录里找某角度的图：`<name>-<angle>.png` 或 `<name>-<angle>-v2.png`（含 asset:// 直写） */
function findAngleFile(dir: string, name: string, angle: string): string | null {
  if (!existsSync(dir)) return null;
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return null;
  }
  const exact = `${name}-${angle}`;
  const candidates = entries
    .filter((f) => IMAGE_EXT.test(f) && (f.startsWith(`${exact}.`) || f.startsWith(`${exact}-`)))
    .sort();
  return candidates.length > 0 ? join(dir, candidates[candidates.length - 1]!) : null;
}

/** 读取单个角色档案（含 active 定妆照集与角度文件） */
export function loadCharacterEntry(dir: string): CharacterEntry | null {
  const profileFile = join(dir, "profile.json");
  if (!existsSync(profileFile)) return null;
  let profile: CharacterProfile;
  try {
    profile = JSON.parse(readFileSync(profileFile, "utf8")) as CharacterProfile;
  } catch {
    return null;
  }
  const sets = Array.isArray(profile.portraitSets) ? profile.portraitSets : [];
  const activeSet = sets.find((s) => s.active) ?? sets[sets.length - 1] ?? null;
  const files: Record<string, string> = {};
  if (activeSet) {
    const setDir = activeSet.dir.startsWith("/") ? activeSet.dir : join(dir, activeSet.dir);
    for (const angle of activeSet.angles ?? []) {
      const file = findAngleFile(setDir, profile.name, angle);
      if (file) files[angle] = file;
    }
  }
  return { ...profile, dir, activeSet, files };
}

/** 读取档案库（目录下每个子目录一个角色） */
export function loadCharacterLibrary(root: string): Map<string, CharacterEntry> {
  const library = new Map<string, CharacterEntry>();
  if (!existsSync(root)) return library;
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name.startsWith("_")) continue;
    const loaded = loadCharacterEntry(resolvePath(root, entry.name));
    if (loaded) library.set(loaded.id, loaded);
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

function asArray(value: unknown): string[] {
  if (typeof value === "string") return value.trim() ? [value.trim()] : [];
  if (Array.isArray(value)) return value.map((v) => String(v)).filter((v) => v.trim().length > 0);
  return [];
}

/** 镜头文本（含台词 speaker）—— 用于选角匹配 */
export function shotCastingText(shot: ShotLikeForCasting): string {
  const speakers = Array.isArray(shot.dialogueBlocks)
    ? (shot.dialogueBlocks as Array<Record<string, unknown>>).map((b) => String(b?.speaker ?? ""))
    : [];
  return [
    ...asArray(shot.characters),
    ...asArray(shot.character),
    ...asArray(shot.character_ref),
    ...asArray(shot.characterRef),
    ...asArray(shot.prompt),
    ...asArray(shot.scene),
    ...speakers
  ].join(" ");
}

export interface CastingResult {
  characters: CharacterEntry[];
  /** 文本里提到、但档案库里没有的名字（提示建档） */
  unmatched: string[];
}

/**
 * 镜头选角：按"先显式字段、后文本"的顺序匹配档案库里的 id/name。
 * 支持一次匹配多人（1–10），并保持出场顺序（显式 characters 数组优先）。
 */
export function resolveShotCharacters(
  shot: ShotLikeForCasting,
  library: Map<string, CharacterEntry>
): CastingResult {
  const text = shotCastingText(shot);
  const ordered: CharacterEntry[] = [];
  const explicit = [...asArray(shot.characters), ...asArray(shot.character)];
  for (const name of explicit) {
    const hit = [...library.values()].find((c) => c.id === name || c.name === name);
    if (hit && !ordered.includes(hit)) ordered.push(hit);
  }
  for (const character of library.values()) {
    if (ordered.includes(character)) continue;
    if (character.id.length > 1 && text.includes(character.id)) { ordered.push(character); continue; }
    if (character.name.length > 1 && text.includes(character.name)) ordered.push(character);
  }
  /** 库里只有一个角色时的兜底（真人出镜项目常态） */
  if (ordered.length === 0 && library.size === 1) ordered.push([...library.values()][0]!);
  const unmatched: string[] = [];
  for (const name of explicit) {
    if (![...library.values()].some((c) => c.id === name || c.name === name)) unmatched.push(name);
  }
  return { characters: ordered, unmatched };
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
  references: string[];
  used: Array<{ id: string; name: string; angle: string }>;
  venueUsed: string[];
  dropped: Array<{ id: string; name: string; reason: string }>;
  note: string;
}

/**
 * 参考图配额分配（Seedance 单次上限 4 张）：
 *   优先级 = 主角 > 有台词 > 出场顺序；人物优先占位，剩余给场景。
 *   超员时把靠后角色"降级为文字描述"并如实记录（不静默丢弃）。
 */
export function allocateReferenceSlots(options: {
  characters: SlotCharacterInput[];
  venueRefs: string[];
  maxRefs?: number;
  /** 每个角色的首选角度（默认 closeup → front） */
  anglePreference?: string[];
}): SlotPlan {
  const max = Math.max(1, options.maxRefs ?? 4);
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

  /** 人物最多占 max-1 张（至少给场景留 1 张），且不超过实际人数 */
  const maxCharacters = Math.min(ranked.length, Math.max(1, max - 1));
  const used: SlotPlan["used"] = [];
  const references: string[] = [];
  const dropped: SlotPlan["dropped"] = [];
  for (const [index, character] of ranked.entries()) {
    const angle = angles.find((a) => character.files[a]);
    if (index >= maxCharacters || !angle) {
      dropped.push({ id: character.id, name: character.name, reason: index >= maxCharacters ? "参考图配额已满（降级为文字描述）" : "该角色没有可用定妆照" });
      continue;
    }
    references.push(character.files[angle]!);
    used.push({ id: character.id, name: character.name, angle });
  }
  const venueUsed = options.venueRefs.slice(0, Math.max(0, max - references.length));
  references.push(...venueUsed);
  return {
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
  /** 缺省 = 跟随 active 版本 */
  pinnedVersion?: number;
}

/**
 * 版本影响面：某角色换代后，哪些项目会受影响（pin 了旧版 → 需评估重渲；跟随 active → 自动跟随）。
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
