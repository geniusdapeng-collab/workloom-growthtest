#!/usr/bin/env tsx
/**
 * real-person-assets.mts —— 认证真人素材「清单对账」CLI（T-2026-0930-0015，通用能力）
 *
 * 用一句话说清它解决什么：**客户给一份平台侧权威清单（控制台「资产详情」截图/导出/粘贴文本），
 * 系统自动把主档里的 referenceAssets / portraitSet 对平**，不再靠人肉登记（真机：10 个 ID 里 8 个
 * 控制台查无 → 多参考图实际未生效 → 像不像不稳定）。
 *
 * 用法：
 *   pnpm exec tsx scripts/tools/real-person-assets.mts list --asset <assetId>
 *   pnpm exec tsx scripts/tools/real-person-assets.mts reconcile --asset <assetId> --from <清单文件>
 *        [--primary <assetId>] [--apply] [--library <真人主档库>] [--label "<来源说明>"]
 *
 * 清单文件支持：
 *   · 控制台复制/导出的文本（每行"源文件名 + asset-…"，或只有 asset-…；含 group-… 也行）；
 *   · JSON：["asset-…", …] 或 { "assets": [{ "assetId": "asset-…", "sourceFile": "x.jpg" }] }。
 *   截图本身不用直接喂给程序：让 Agent（或客户）把截图里的"文件名 + asset ID"两列贴成文本即可。
 *
 * 纪律：
 *   · 纯函数对账（packages/video-studio/src/real-person-asset-sync.ts）：新 ID 一律"待确认"，**不猜角度**；
 *   · 默认 dry-run，只有 `--apply` 才写主档；写前把原档备份为 profile.json.bak，证据单独落盘；
 *   · 写后立刻用 `loadRealPersonAssets` + `verifyRealPersonAsset` 自检，并打印管线实取的前 3 张参考图。
 */
import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  REAL_PERSON_ASSET_SCHEMA,
  loadRealPersonAssets,
  referenceAssetRefs,
  verifyRealPersonAsset,
  type RealPersonAsset
} from "../../packages/video-studio/src/real-person-asset.js";
import {
  parseConsoleAssetList,
  reconcileRealPersonAsset,
  renderReconcileReport,
  type ConsoleAssetEntry
} from "../../packages/video-studio/src/real-person-asset-sync.js";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const DEFAULT_LIBRARY = join(REPO_ROOT, "bundles/ai-video/library/real-person-assets");

function arg(name: string, fallback = ""): string {
  const index = process.argv.indexOf(name);
  return index >= 0 ? String(process.argv[index + 1] ?? "") : fallback;
}
const flag = (name: string): boolean => process.argv.includes(name);
const abs = (p: string): string => (isAbsolute(p) ? p : resolve(process.cwd(), p));

const command = process.argv[2] ?? "";
const library = resolve(arg("--library", DEFAULT_LIBRARY));
const assetId = arg("--asset").trim().toLowerCase();
if (!assetId) {
  console.error("用法：real-person-assets.mts <list|reconcile> --asset <assetId> [--from <清单文件>] [--primary <assetId>] [--apply] [--library <目录>]");
  process.exit(2);
}
const profileFile = join(library, assetId, "profile.json");
if (!existsSync(profileFile)) {
  console.error(`找不到主档：${profileFile}\n（先按 docs/real-person-asset.md 建档，本工具只做"对账"，不替客户猜属性）`);
  process.exit(2);
}
const profile = JSON.parse(readFileSync(profileFile, "utf8")) as RealPersonAsset & Record<string, unknown>;

if (command === "list") {
  console.log(`主档 ${profile.assetId}（${profile.displayName}）· 库 ${library}`);
  console.log(`组：${String(profile.assetGroupId ?? "(未登记)")}　授权：${profile.authorization?.status ?? "?"}`);
  const refs = (profile.referenceAssets ?? []) as string[];
  console.log(`referenceAssets（${refs.length}）：${refs.join("、") || "(空)"}`);
  const sources = (profile as { referenceAssetSources?: { assets?: Array<Record<string, unknown>> } }).referenceAssetSources;
  if (sources?.assets?.length) {
    console.log("来源映射：");
    for (const entry of sources.assets) {
      console.log(`  ${String(entry.assetId)}　${String(entry.sourceFile ?? "(无文件名)")}　角度：${String(entry.angleGuess ?? "待确认")}`);
    }
  }
  console.log(`管线实取（主素材 + 前两张）：${referenceAssetRefs(profile, 3).join(" + ")}`);
  process.exit(0);
}

if (command !== "reconcile") {
  console.error(`未知子命令：${command}（可用：list / reconcile）`);
  process.exit(2);
}

const fromFile = abs(arg("--from"));
if (!fromFile || !existsSync(fromFile)) {
  console.error("reconcile 需要 --from <客户清单文件>（控制台复制/导出的文本，或 JSON 数组）");
  process.exit(2);
}
const raw = readFileSync(fromFile, "utf8");
const sourceSha256 = createHash("sha256").update(raw).digest("hex");
/** JSON 形态直接归一成 entries；文本形态走宽容解析 */
const parsed = (() => {
  try {
    const doc = JSON.parse(raw) as unknown;
    const list = Array.isArray(doc)
      ? doc
      : doc && typeof doc === "object" && Array.isArray((doc as { assets?: unknown[] }).assets)
        ? (doc as { assets: unknown[] }).assets
        : null;
    if (!list) throw new Error("not-a-list");
    const entries: ConsoleAssetEntry[] = [];
    for (const item of list) {
      if (typeof item === "string") entries.push({ assetId: item.trim().toLowerCase() });
      else if (item && typeof item === "object") {
        const record = item as Record<string, unknown>;
        const id = String(record.assetId ?? record.id ?? "").trim().toLowerCase();
        if (!id) continue;
        entries.push({ assetId: id, ...(typeof record.sourceFile === "string" ? { sourceFile: record.sourceFile } : {}) });
      }
    }
    const group = doc && typeof doc === "object" && !Array.isArray(doc) && typeof (doc as { group?: unknown }).group === "string"
      ? String((doc as { group: string }).group).toLowerCase() : undefined;
    return { entries, ...(group ? { groupId: group } : {}), ignoredLines: [] as string[] };
  } catch {
    return parseConsoleAssetList(raw);
  }
})();

const label = arg("--label") || `客户提供的平台资产清单：${fromFile}`;
const result = reconcileRealPersonAsset({
  profile, parsed,
  primaryAssetId: arg("--primary") || null,
  sourceLabel: label,
  sourceSha256
});

console.log(renderReconcileReport(result.report));
const apply = flag("--apply");
if (!apply) {
  console.log("\n（dry-run）加 --apply 才写入主档；写前会备份 profile.json.bak，写后自动自检。");
  process.exit(0);
}

const evidenceFile = join(library, assetId, "asset-list-evidence.json");
const backupFile = `${profileFile}.bak`;
mkdirSync(dirname(profileFile), { recursive: true });
if (existsSync(profileFile)) copyFileSync(profileFile, backupFile);
const tmpFile = `${profileFile}.tmp-${process.pid}`;
writeFileSync(tmpFile, `${JSON.stringify(result.profile, null, 2)}\n`, "utf8");
renameSync(tmpFile, profileFile);
writeFileSync(evidenceFile, `${JSON.stringify({
  schemaVersion: "workloom.real-person-asset-list-evidence/v1",
  at: new Date().toISOString(),
  source: label,
  sourceFile: fromFile,
  sourceSha256,
  groupId: result.report.groupId,
  primaryAssetId: result.report.primaryAssetId,
  entries: parsed.entries,
  ignoredLines: parsed.ignoredLines,
  reconcile: result.report
}, null, 2)}\n`, "utf8");
console.log(`\n✅ 已写入主档（备份 ${backupFile}）；证据：${evidenceFile}`);

/** 写后自检：主档能装载 + 属性校验通过 + 管线实取参考图 */
const reloaded = loadRealPersonAssets(library, { now: new Date() });
const entry = reloaded.byAssetId.get(assetId);
if (!entry) {
  console.error("⛔ 写后自检失败：主档无法装载（schema 或目录结构有问题）");
  process.exit(1);
}
const issues = verifyRealPersonAsset(entry.asset);
if (issues.length > 0) {
  console.error("⛔ 写后自检失败（属性/授权问题）：");
  for (const issue of issues) console.error(`  - ${issue.code}: ${issue.detail}`);
  process.exit(1);
}
console.log(`✅ 自检通过；管线实取（主素材 + 前两张）：${referenceAssetRefs(entry.asset, 3).join(" + ")}`);
