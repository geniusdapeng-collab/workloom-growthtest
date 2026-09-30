/**
 * real-person-asset-sync —— 认证真人素材清单「对账」内核（T-2026-0930-0015，通用能力）
 *
 * 背景（2026-09-30 真机，**这不是某一个客户的定制问题**）：
 *   平台（火山方舟「私域真人人像库」）里的同一授权素材组通常有 N 张图；仓库主档里
 *   `referenceAssets` / `portraitSet` 是**人工登记**的，一旦记错（真机：10 个 ID 里 8 个控制台查无），
 *   管线取「主素材 + 前两张」作参考图时就带着无效 ID 提交 → 多参考图**实际未生效**，
 *   表现是"像不像不稳定"，而日志里看不出任何异常。
 *
 * 通用解法：**让客户提供一份平台侧权威清单**（控制台「资产详情」列表：源文件名 + asset ID，
 * 或直接导出/粘贴文本；截图可由 Agent 转成文本），本模块负责：
 *   1. 解析（容忍文件名+ID 两列、纯 ID、中英混排、Markdown 表格）；
 *   2. 与主档对账（新增/缺失/不变），生成**按清单顺序**的 referenceAssets；
 *   3. 保留既有 angleGuess（同 ID 时），新 ID 一律标"待确认"（**不猜角度**）；
 *   4. 产出可审计证据（清单 sha256、组 ID、主素材、逐条来源文件名）。
 * 纯函数、无文件 IO、无客户特定常量——CLI 只负责读写与留痕。
 */

import type { RealPersonAsset } from "./real-person-asset.js";

export const REAL_PERSON_SYNC_SCHEMA = "workloom.real-person-asset-sync/v1" as const;

/** 平台 assetId 形状（火山方舟：asset-<14 位时间戳>-<短码>；大小写不敏感） */
export const ASSET_ID_RE = /asset-\d{8,}-[a-z0-9]+/gi;
/** 源文件名（客户导出/控制台左列） */
const SOURCE_FILE_RE = /[A-Za-z0-9_@.()\-]+\.(?:jpe?g|png|webp|heic)/i;

export interface ConsoleAssetEntry {
  assetId: string;
  /** 控制台/导出里的源文件名（若有） */
  sourceFile?: string;
}

export interface ParsedConsoleList {
  entries: ConsoleAssetEntry[];
  /** 素材组 ID（若清单里带 group-…） */
  groupId?: string;
  /** 被忽略的非素材行（表头等），便于审计 */
  ignoredLines: string[];
}

/**
 * 解析客户提供的资产清单文本。容忍三种常见形态：
 *   · `mmeexport1790654691361.jpg   asset-20260929120546-z9b8h`
 *   · `asset-20260929120546-z9b8h`
 *   · Markdown/表格/中文说明混排（逐行扫 ID 与文件名，其余进 ignoredLines）
 * 同一 ID 出现多次只保留首次（附带的文件名若首次为空则回填）。
 */
export function parseConsoleAssetList(text: string): ParsedConsoleList {
  const entries: ConsoleAssetEntry[] = [];
  const seen = new Map<string, ConsoleAssetEntry>();
  const ignoredLines: string[] = [];
  let groupId: string | undefined;

  for (const rawLine of String(text ?? "").split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    const group = line.match(/group-\d{8,}-[a-z0-9]+/i);
    if (group && !groupId) groupId = group[0].toLowerCase();
    const ids = line.match(ASSET_ID_RE) ?? [];
    if (ids.length === 0) {
      ignoredLines.push(line);
      continue;
    }
    const file = line.match(SOURCE_FILE_RE)?.[0];
    for (const rawId of ids) {
      const assetId = rawId.toLowerCase();
      const existing = seen.get(assetId);
      if (existing) {
        if (!existing.sourceFile && file) existing.sourceFile = file;
        continue;
      }
      const entry: ConsoleAssetEntry = { assetId, ...(file ? { sourceFile: file } : {}) };
      seen.set(assetId, entry);
      entries.push(entry);
    }
  }
  return { entries, ...(groupId ? { groupId } : {}), ignoredLines };
}

export interface ReconcileReport {
  schemaVersion: typeof REAL_PERSON_SYNC_SCHEMA;
  primaryAssetId: string | null;
  groupId: string | null;
  /** 清单里没有、主档里有的（应删除：控制台查无此素材） */
  removed: string[];
  /** 清单里有、主档里没有的（应补上） */
  added: string[];
  /** 两边都有（保留其既有 angleGuess） */
  unchanged: string[];
  /** 对账后的参考图顺序（不含主素材） */
  referenceAssets: string[];
  notes: string[];
}

export interface ReconcileResult {
  profile: RealPersonAsset & Record<string, unknown>;
  report: ReconcileReport;
}

function unique<T>(items: T[]): T[] {
  return [...new Set(items)];
}

/**
 * 用平台清单对账主档（纯函数，不改磁盘）。
 *
 * 规则：
 *   · 主素材：显式 `primaryAssetId` > 主档既有 `assetId`（若仍在清单里）> 清单第一条；
 *   · `referenceAssets` 顺序 = **清单顺序去掉主素材**（顺序即优先级：管线取前两张）；
 *   · `angleGuess` 只在同一 ID 命中时保留；新 ID 标 `null`（待客户确认），绝不从顺序猜；
 *   · `assetGroupId` 与清单一致时保持，不一致则以清单为准并写进 notes（供人工复核）。
 */
export function reconcileRealPersonAsset(input: {
  profile: RealPersonAsset & Record<string, unknown>;
  parsed: ParsedConsoleList;
  primaryAssetId?: string | null;
  sourceLabel?: string;
  sourceSha256?: string;
  at?: string;
}): ReconcileResult {
  const { profile, parsed } = input;
  const listIds = unique(parsed.entries.map((entry) => entry.assetId));
  if (listIds.length === 0) throw new Error("ASSET_LIST_EMPTY: 清单里没有解析到任何 asset-… ID（请检查粘贴内容）");

  const explicit = (input.primaryAssetId ?? "").trim().toLowerCase() || null;
  if (explicit && !listIds.includes(explicit)) {
    throw new Error(`ASSET_PRIMARY_NOT_IN_LIST: 指定的主素材 ${explicit} 不在清单里`);
  }
  const existingPrimary = String(profile.assetId ?? "").trim().toLowerCase();
  const primary = explicit ?? (listIds.includes(existingPrimary) ? existingPrimary : listIds[0]!);

  const priorReferences = unique((profile.referenceAssets ?? []).map((id) => String(id).trim().toLowerCase()));
  const referenceAssets = listIds.filter((id) => id !== primary);
  const removed = priorReferences.filter((id) => !listIds.includes(id));
  const added = referenceAssets.filter((id) => !priorReferences.includes(id));
  const unchanged = referenceAssets.filter((id) => priorReferences.includes(id));

  /** 既有来源/角度信息（新格式 referenceAssetSources，旧格式 portraitSet.assets）都保留 */
  const priorSource = new Map<string, { sourceFile?: string; angleGuess?: string | null }>();
  const sources = (profile as { referenceAssetSources?: { assets?: Array<Record<string, unknown>> } }).referenceAssetSources;
  for (const entry of sources?.assets ?? []) {
    const id = String(entry.assetId ?? "").trim().toLowerCase();
    if (!id) continue;
    priorSource.set(id, {
      ...(typeof entry.sourceFile === "string" ? { sourceFile: entry.sourceFile } : {}),
      ...(entry.angleGuess === null || typeof entry.angleGuess === "string" ? { angleGuess: entry.angleGuess as string | null } : {})
    });
  }
  const portraitSet = (profile as {
    portraitSet?: { assets?: Array<Record<string, unknown>>; group?: unknown; count?: unknown; note?: unknown };
  }).portraitSet;
  for (const entry of portraitSet?.assets ?? []) {
    const id = String(entry.assetId ?? "").trim().toLowerCase();
    if (!id || priorSource.has(id)) continue;
    const angle = typeof entry.angleGuess === "string" ? entry.angleGuess : null;
    priorSource.set(id, {
      ...(typeof entry.sourceFile === "string" ? { sourceFile: entry.sourceFile } : {}),
      ...(angle ? { angleGuess: angle } : {})
    });
  }

  const fileFor = (id: string): string | undefined =>
    parsed.entries.find((entry) => entry.assetId === id)?.sourceFile ?? priorSource.get(id)?.sourceFile;
  const angleFor = (id: string): string | null => priorSource.get(id)?.angleGuess ?? null;

  const notes: string[] = [
    `对账来源：${input.sourceLabel ?? "客户提供的平台资产清单"}${input.sourceSha256 ? `（sha256 ${input.sourceSha256.slice(0, 12)}…）` : ""}`,
    "referenceAssets 顺序 = 清单顺序（去掉主素材）：管线取「主素材 + 前两张」，即前两张必须是最像本人的正面/近景参考。",
    "angleGuess 只沿用同 ID 的既有标注；新 ID 一律标 null（待客户确认），不从顺序猜角度。"
  ];
  if (parsed.groupId && profile.assetGroupId && parsed.groupId !== String(profile.assetGroupId).toLowerCase()) {
    notes.push(`⚠ 组 ID 不一致：主档 ${profile.assetGroupId} vs 清单 ${parsed.groupId}（已按清单写入，请人工复核授权范围）`);
  }

  const assets = [
    {
      assetId: primary, role: "primary",
      ...(fileFor(primary) ? { sourceFile: fileFor(primary) } : {}),
      ...(angleFor(primary) ? { angleGuess: angleFor(primary) } : {})
    },
    ...referenceAssets.map((id) => ({
      assetId: id,
      ...(fileFor(id) ? { sourceFile: fileFor(id) } : {}),
      angleGuess: angleFor(id)
    }))
  ];

  const report: ReconcileReport = {
    schemaVersion: REAL_PERSON_SYNC_SCHEMA,
    primaryAssetId: primary,
    groupId: parsed.groupId ?? (profile.assetGroupId ? String(profile.assetGroupId) : null),
    removed, added, unchanged, referenceAssets, notes
  };

  const nextProfile = {
    ...profile,
    assetId: primary,
    assetGroupId: parsed.groupId ?? profile.assetGroupId,
    referenceAssets,
    referenceAssetSources: {
      schemaVersion: "workloom.real-person-asset-sources/v1",
      evidence: input.sourceLabel ?? "客户提供的平台资产清单",
      ...(input.sourceSha256 ? { sourceSha256: input.sourceSha256 } : {}),
      verifiedAt: input.at ?? new Date().toISOString().slice(0, 10),
      orderNote: "顺序即 priority：管线取「主素材 + 前两张」作生成参考图（上限 3 张）",
      assets,
      note: "angleGuess 由缩略图/来源文件名初判，**待客户确认**；定妆照入库以本清单为准。"
    },
    portraitSet: portraitSet
      ? {
        ...portraitSet,
        group: parsed.groupId ?? portraitSet.group,
        count: listIds.length,
        assets: assets.map(({ assetId, sourceFile, angleGuess }) => ({
          assetId, ...(sourceFile ? { sourceFile } : {}), angleGuess: angleGuess ?? "待客户确认"
        })),
        note: "同组素材为同一授权人；assetId 以客户提供的平台清单为准，sourceFile 为控制台源文件名。"
      }
      : portraitSet
  } as RealPersonAsset & Record<string, unknown>;

  return { profile: nextProfile, report };
}

/** 对账报告的人类可读版（CLI 直接打印） */
export function renderReconcileReport(report: ReconcileReport): string {
  const lines = [
    `主素材：${report.primaryAssetId ?? "(未定)"}${report.groupId ? `　组：${report.groupId}` : ""}`,
    `参考图（${report.referenceAssets.length}）：${report.referenceAssets.join("、")}`,
    `新增：${report.added.length ? report.added.join("、") : "无"}`,
    `删除（清单查无）：${report.removed.length ? report.removed.join("、") : "无"}`,
    `不变：${report.unchanged.length ? report.unchanged.join("、") : "无"}`,
    ...report.notes.map((note) => `· ${note}`)
  ];
  return lines.join("\n");
}
