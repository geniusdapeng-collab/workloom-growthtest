/**
 * portrait-binding —— 镜头卡 → 定妆照参考图 的绑定与参考图编排（T-2026-0923-0050）
 *
 * 背景（真机事故，2026-09-23）：出片工具此前用 `shot.prompt + shot.characters` 去匹配定妆照索引，
 * 而我们的镜头卡用的是 `character`（单数、字符串）且没有 `prompt` 字段 → **永远匹配不到**，
 * 于是发给 Seedance 的 4 张参考图全是建筑/场景图，视频里的人只能靠文字瞎编。
 *
 * 本模块把"谁出镜、带哪张脸"这件事收敛成纯函数，并用单测锁死：
 *   ① 匹配字段归一：`character`(字符串) / `characters`(数组或字符串) / `character_ref` / `prompt` / `scene`；
 *   ② 原镜头适用性、身份和人数一致才绑定，不从档案库大小推断出镜；
 *   ③ 参考图编排：人物逐人占位，场景使用剩余配额；超员或缺照明确阻断。
 */
import { readPortraitArtifact, resolveShotCast, shotCastingText, portraitWardrobeMatches, type PortraitArtifactReceipt } from "./character-archive.js";
import { shotIntentHash, type ShotIntentStatus } from "./shot-intent.js";

/**
 * 方舟「已授权真人素材」引用形态：`asset://asset-20260401123823-6d4x2`。
 * 真人素材必须走官方人像库授权后拿到 asset ID（直传真人照片会被平台审核拦截：
 * `InputImageSensitiveContentDetected.PrivacyInformation`），因此这类引用不需要本地文件存在。
 */
export const ASSET_REF_PREFIX = "asset://";

export function isAssetRef(value: unknown): value is string {
  return typeof value === "string" && /^asset:\/\/[A-Za-z0-9][A-Za-z0-9_-]*$/.test(value);
}

/** 可用的定妆照引用：本地存在的文件，或方舟 asset:// 引用 */
function usablePortraitRef(file: string | undefined): string | null {
  if (!file) return null;
  if (isAssetRef(file)) return file;
  try { readPortraitArtifact(file); return file; } catch { return null; }
}

export interface PortraitIndexEntryLike {
  id?: string;
  name?: string;
  files?: Record<string, string>;
  portraitVersion?: number;
  pinnedVersion?: number;
  wardrobe?: Record<string, unknown>;
  wardrobeHash?: string;
  artifacts?: Record<string, PortraitArtifactReceipt>;
  receipts?: Record<string, { output: PortraitArtifactReceipt }>;
}

export interface PortraitIndexLike {
  characters?: Record<string, PortraitIndexEntryLike>;
  products?: Record<string, PortraitIndexEntryLike>;
}

export interface ShotLike {
  shotId?: string;
  /** 单数形态：卡片里写 `character: "平江路讲述人：真人，三十岁上下女性…"` */
  character?: unknown;
  characters?: unknown;
  character_ref?: unknown;
  characterRef?: unknown;
  prompt?: unknown;
  scene?: unknown;
  sceneDescription?: unknown;
  /** 卡片里直接给出的定妆照本地路径（本工具回填后会出现） */
  portraits?: unknown;
  [key: string]: unknown;
}

export interface PortraitPick {
  /** 命中的定妆照文件（不存在则为 null） */
  file: string | null;
  /** 匹配方式：explicit=卡片直接给路径；token=文本命中角色；sole=索引里唯一角色兜底；none=未命中 */
  matchedBy: "explicit" | "token" | "sole" | "none";
  /** 命中的角色标识（便于日志/审计） */
  character?: string;
  note?: string;
  status: ShotIntentStatus;
  sourceHash?: string;
  version?: number;
  assetHash?: string;
  scope?: "current-local-bytes" | "external-asset-id-not-provider-verified";
}

function toArray(value: unknown): string[] {
  if (typeof value === "string") return value.trim() ? [value] : [];
  if (Array.isArray(value)) return value.map((v) => String(v)).filter((v) => v.trim().length > 0);
  return [];
}

/** 镜头卡里所有"可能提到角色"的文本，按可信度排序 */
export function shotCharacterText(shot: ShotLike): string {
  return shotCastingText(shot);
}

/**
 * 逐角度挑一张可用的定妆照：front → threeQuarter → closeup → side → 任意。
 * 返回 null 表示索引里这个角色确实没有可用图。
 */
function frontOf(entry: PortraitIndexEntryLike): string | null {
  const files = entry.files ?? {};
  for (const angle of ["front", "threeQuarter", "closeup", "side", "actionPose", "emotionCloseup"]) {
    const file = usablePortraitRef(files[angle]);
    if (file) return file;
  }
  const any = Object.values(files).map((file) => usablePortraitRef(file)).find((file) => Boolean(file));
  return any ?? null;
}

/**
 * 挑出该镜头应带的人物定妆照。
 * 先核验原镜头身份与人数，再接受对应角色的当前版本或显式路径。
 */
export function pickCharacterPortrait(index: PortraitIndexLike | null, shot: ShotLike): PortraitPick {
  const result = pickCharacterPortraits(index, shot);
  if (result.status !== "passed") return { file: null, matchedBy: "none", status: result.status, sourceHash: result.sourceHash, note: result.note };
  if (result.picks.length !== 1) return { file: null, matchedBy: "none", status: "unverified", sourceHash: result.sourceHash, note: `本镜头需要${result.picks.length}个人物参考，单角色接口不能静默丢人；使用pickCharacterPortraits` };
  return result.picks[0]!;
}

export function pickCharacterPortraits(index: PortraitIndexLike | null, shot: ShotLike): { status: ShotIntentStatus; sourceHash: string; picks: PortraitPick[]; note: string } {
  const entries = Object.entries(index?.characters ?? {}).map(([key, entry]) => ({ id: entry.id ?? key, name: entry.name ?? key, aliases: [key], entry }));
  const cast = resolveShotCast(shot, entries);
  const reject = (status: ShotIntentStatus, note: string) => ({ status, sourceHash: cast.sourceHash, picks: [] as PortraitPick[], note });
  if (cast.status !== "passed") return reject(cast.status, cast.notes.join("；"));
  const explicit = toArray(shot.portraits); const consumed = new Set<string>(); const picks: PortraitPick[] = [];
  for (const character of cast.characters) {
    const entry = character.entry; const selection = cast.selections.find((item) => item.characterId === character.id)!;
    const version = entry.pinnedVersion ?? entry.portraitVersion;
    if (selection.pinnedVersion !== undefined && version !== selection.pinnedVersion) return reject("unverified", `${character.name} 指定版本与索引版本不一致`);
    if (selection.wardrobeId && entry.wardrobe?.id !== selection.wardrobeId) return reject("unverified", `${character.name} 指定服装没有当前版本证据`);
    if (selection.wardrobe && entry.wardrobeHash !== shotIntentHash(selection.wardrobe)) return reject("unverified", `${character.name} 服装已变，需要新版本候选`);
    if (selection.costume && !portraitWardrobeMatches(entry.wardrobe, selection.costume)) return reject("unverified", `${character.name} 原镜头服装与版本记录不符，需要新服装候选`);
    const owned = Object.values(entry.files ?? {});
    const preferred = explicit.filter((file) => owned.includes(file));
    const file = explicit.length > 0 ? preferred.length === 1 ? usablePortraitRef(preferred[0]) : null : frontOf(entry);
    if (!file) return reject("unverified", `${character.name} 没有可核验的当前定妆照，显式路径不能替换人物身份`);
    consumed.add(file);
    const angle = Object.entries(entry.files ?? {}).find(([, value]) => value === file)?.[0];
    let assetHash: string | undefined;
    if (!isAssetRef(file)) {
      const actual = readPortraitArtifact(file); const stored = angle ? entry.artifacts?.[angle] ?? entry.receipts?.[angle]?.output : undefined;
      if ((entry.artifacts || entry.receipts) && (!stored || shotIntentHash(actual) !== shotIntentHash(stored))) return reject("unverified", `${character.name} 当前文件字节与版本收据不一致`);
      assetHash = actual.sha256;
    }
    picks.push({ file, matchedBy: explicit.length ? "explicit" : "token", character: character.id, status: "passed", sourceHash: cast.sourceHash, ...(version !== undefined ? { version } : {}), ...(assetHash ? { assetHash } : {}), scope: isAssetRef(file) ? "external-asset-id-not-provider-verified" : "current-local-bytes" });
  }
  if (explicit.some((file) => !consumed.has(file))) return reject("unverified", "显式人物参考含未匹配角色或历史版本，不能混入当前镜头");
  return { status: "passed", sourceHash: cast.sourceHash, picks, note: cast.notes.join("；") };
}

/**
 * 参考图编排：**人物优先**，人物占 1 张，场景最多 3 张（默认总上限 4）。
 * 返回 `references`（按下发顺序）与 `venueUsed`（便于日志/审计）。
 */
export function composeShotReferences(options: {
  portrait: string | null;
  portraits?: string[];
  venueRefs: string[];
  maxRefs?: number;
}): { references: string[]; venueUsed: string[]; note: string } {
  const max = options.maxRefs ?? 4;
  if (!Number.isInteger(max) || max < 1 || max > 4) throw new Error("PORTRAIT_REFERENCE_LIMIT_INVALID: 参考图配额必须为1..4");
  const portraits = [...new Set(options.portraits ?? (options.portrait ? [options.portrait] : []))];
  if (portraits.length > max) throw new Error("PORTRAIT_REFERENCE_LIMIT_EXCEEDED: 人物参考超出配额，禁止静默丢人");
  const venueLimit = max - portraits.length;
  const venueUsed = [...new Set(options.venueRefs)].filter((ref) => !portraits.includes(ref)).slice(0, venueLimit);
  const references = [...portraits, ...venueUsed];
  return {
    references,
    venueUsed,
    note: portraits.length
      ? `人物定妆照 ${portraits.length} 张 + 场景参考 ${venueUsed.length} 张`
      : `无人物定妆照，仅场景参考 ${venueUsed.length} 张`
  };
}
