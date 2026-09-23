/**
 * portrait-binding —— 镜头卡 → 定妆照参考图 的绑定与参考图编排（T-2026-0923-0050）
 *
 * 背景（真机事故，2026-09-23）：出片工具此前用 `shot.prompt + shot.characters` 去匹配定妆照索引，
 * 而我们的镜头卡用的是 `character`（单数、字符串）且没有 `prompt` 字段 → **永远匹配不到**，
 * 于是发给 Seedance 的 4 张参考图全是建筑/场景图，视频里的人只能靠文字瞎编。
 *
 * 本模块把"谁出镜、带哪张脸"这件事收敛成纯函数，并用单测锁死：
 *   ① 匹配字段归一：`character`(字符串) / `characters`(数组或字符串) / `character_ref` / `prompt` / `scene`；
 *   ② 兜底：索引里**只有一个角色**时直接采用（真人出镜项目常见），并在 note 里说明；
 *   ③ 参考图编排：**人物优先**（人物 1 张 + 场景 ≤3 张），不再被 4 张场景图挤掉。
 */
import { existsSync } from "node:fs";

/**
 * 方舟「已授权真人素材」引用形态：`asset://asset-20260401123823-6d4x2`。
 * 真人素材必须走官方人像库授权后拿到 asset ID（直传真人照片会被平台审核拦截：
 * `InputImageSensitiveContentDetected.PrivacyInformation`），因此这类引用不需要本地文件存在。
 */
export const ASSET_REF_PREFIX = "asset://";

export function isAssetRef(value: unknown): value is string {
  return typeof value === "string" && value.startsWith(ASSET_REF_PREFIX) && value.length > ASSET_REF_PREFIX.length;
}

/** 可用的定妆照引用：本地存在的文件，或方舟 asset:// 引用 */
function usablePortraitRef(file: string | undefined): string | null {
  if (!file) return null;
  return isAssetRef(file) || existsSync(file) ? file : null;
}

export interface PortraitIndexEntryLike {
  id?: string;
  name?: string;
  files?: Record<string, string>;
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
}

function toArray(value: unknown): string[] {
  if (typeof value === "string") return value.trim() ? [value] : [];
  if (Array.isArray(value)) return value.map((v) => String(v)).filter((v) => v.trim().length > 0);
  return [];
}

/** 镜头卡里所有"可能提到角色"的文本，按可信度排序 */
export function shotCharacterText(shot: ShotLike): string {
  return [
    ...toArray(shot.characters),
    ...toArray(shot.character),
    ...toArray(shot.character_ref),
    ...toArray(shot.characterRef),
    ...toArray(shot.prompt),
    ...toArray(shot.scene),
    ...toArray(shot.sceneDescription)
  ].join(" ");
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
 * 优先级：卡片显式路径 → 文本命中角色 id/name → 索引里唯一角色兜底。
 */
export function pickCharacterPortrait(index: PortraitIndexLike | null, shot: ShotLike): PortraitPick {
  if (!index?.characters) return { file: null, matchedBy: "none" };
  const explicit = toArray(shot.portraits).map((file) => usablePortraitRef(file)).find((file) => Boolean(file));
  if (explicit) return { file: explicit, matchedBy: "explicit" };

  const entries = Object.entries(index.characters);
  if (entries.length === 0) return { file: null, matchedBy: "none" };
  const text = shotCharacterText(shot);

  for (const [key, entry] of entries) {
    const tokens = [entry.id, entry.name, key].filter((t): t is string => Boolean(t && t.length > 1));
    if (tokens.some((token) => text.includes(token))) {
      const file = frontOf(entry);
      if (file) return { file, matchedBy: "token", character: entry.name ?? entry.id ?? key };
      return { file: null, matchedBy: "token", character: entry.name ?? entry.id ?? key, note: `${entry.name ?? key} 的定妆照文件不可读` };
    }
  }

  if (entries.length === 1) {
    const [key, entry] = entries[0]!;
    const file = frontOf(entry);
    const name = entry.name ?? entry.id ?? key;
    return {
      file,
      matchedBy: file ? "sole" : "none",
      character: name,
      note: file
        ? `镜头文本未提及角色，但项目只有一个角色「${name}」→ 直接采用其定妆照`
        : `项目只有一个角色「${name}」，但其定妆照文件不可读`
    };
  }
  return { file: null, matchedBy: "none", note: `索引里有 ${entries.length} 个角色，镜头文本未命中任何一个` };
}

/**
 * 参考图编排：**人物优先**，人物占 1 张，场景最多 3 张（默认总上限 4）。
 * 返回 `references`（按下发顺序）与 `venueUsed`（便于日志/审计）。
 */
export function composeShotReferences(options: {
  portrait: string | null;
  venueRefs: string[];
  maxRefs?: number;
}): { references: string[]; venueUsed: string[]; note: string } {
  const max = Math.max(1, options.maxRefs ?? 4);
  const venueLimit = options.portrait ? max - 1 : max;
  const venueUsed = options.venueRefs.slice(0, venueLimit);
  const references = options.portrait ? [options.portrait, ...venueUsed] : venueUsed;
  return {
    references,
    venueUsed,
    note: options.portrait
      ? `人物定妆照 1 张 + 场景参考 ${venueUsed.length} 张`
      : `无人物定妆照，仅场景参考 ${venueUsed.length} 张`
  };
}
