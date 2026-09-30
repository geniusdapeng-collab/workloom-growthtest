#!/usr/bin/env tsx
/**
 * portrait-set-install.mts —— 把"客户导出的授权真人原图"（或派生定妆照）**逐张落实到角色档案的角度槽位**
 *
 * 为什么需要（2026-09-30）：
 *   认证真人素材（`asset://asset-…`）在本地只有主档 ID，没有图片文件；角色档案的 8 个角度槽位
 *   目前是"按同组 11 张循环映射、未逐张确认"（档案 note 里就写着）。要"保准"，只能由客户从平台
 *   导出原图，逐张落到角度槽位并留下"来源 → 槽位"的证据——之后像不像门/首镜身份锚才有真实基准。
 *
 * 用法：
 *   pnpm exec tsx scripts/tools/portrait-set-install.mts \
 *     --character demo-character \
 *     --library work/film/library/characters \
 *     --from ~/Downloads/真人素材导出 \
 *     --mapping work/film/library/characters/model-01-demo-character/portrait-mapping.json \
 *     [--version 2] [--source customer-export|asset-derived] [--activate] [--dry-run] [--out report.json]
 *
 * `--mapping` 形如：`{"front":"IMG_0031.jpg","threeQuarter":"IMG_0032.jpg", ...}`
 *   · 必填角度：`front` / `threeQuarter` / `closeup` / `side`（缺一即 fail-closed，不"凑一个"）
 *   · 可选角度：`frontFull` / `threeQuarterLeft` / `threeQuarterRight` / `smileCloseup`
 *
 * 纪律：
 *   1. **不覆盖既有版本**（版本号默认自增），不移动/改写原图（只读 + 复制）；
 *   2. `--source` 必须如实声明（`customer-export` = 客户从平台导出的原图；`asset-derived` = 以授权素材为参考生成的派生图）；
 *   3. 写入后跑 `verifyPortraitSet` 复核，未通过即失败（exit 2）——不许"写进去就算完"；
 *   4. 并发安全：与 portrait-agent 共用同一把角色档案锁。
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync } from "node:fs";
import { copyFileSync } from "node:fs";
import { join, resolve, extname, basename } from "node:path";
import {
  assertCharacterComponent,
  readPortraitArtifact,
  verifyPortraitSet,
  withCharacterArchiveLock,
  writePortraitJson,
  type CharacterProfile,
  type PortraitSet,
} from "../../packages/video-studio/src/character-archive.js";

function arg(name: string, fallback = ""): string {
  const index = process.argv.indexOf(name);
  return index >= 0 ? String(process.argv[index + 1] ?? "") : fallback;
}
const flag = (name: string): boolean => process.argv.includes(name);

const REQUIRED_ANGLES = ["front", "threeQuarter", "closeup", "side"] as const;
const OPTIONAL_ANGLES = ["frontFull", "threeQuarterLeft", "threeQuarterRight", "smileCloseup",
  "back", "actionPose", "emotionCloseup", "handDetail"] as const;
const KNOWN_ANGLES = new Set<string>([...REQUIRED_ANGLES, ...OPTIONAL_ANGLES]);
const IMAGE_EXT = /\.(png|jpe?g|webp)$/i;

const characterId = arg("--character").trim();
if (!characterId) {
  console.error("用法：portrait-set-install.mts --character <角色ID> --library <角色库目录> --from <导出原图目录> --mapping <mapping.json> [--version N] [--source customer-export|asset-derived] [--activate] [--dry-run] [--out report.json]");
  process.exit(2);
}
try { assertCharacterComponent(characterId); } catch (error) {
  console.error(`角色 ID 非法：${error instanceof Error ? error.message : String(error)}`);
  process.exit(2);
}
const libraryRoot = resolve(arg("--library", "var/media/characters"));
const characterDir = join(libraryRoot, characterId);
const fromDir = resolve(arg("--from"));
const mappingFile = resolve(arg("--mapping"));
const dryRun = flag("--dry-run");
const activate = flag("--activate");
const allowUnverified = flag("--allow-unverified");
const sourceKind = arg("--source", "customer-export").trim();
if (!["customer-export", "asset-derived"].includes(sourceKind)) {
  console.error(`--source 只支持 customer-export（客户导出原图）/ asset-derived（以授权素材为参考的派生图），收到：${sourceKind}`);
  process.exit(2);
}
if (!existsSync(join(characterDir, "profile.json"))) {
  console.error(`角色档案不存在：${join(characterDir, "profile.json")}`);
  process.exit(2);
}
if (!existsSync(fromDir) || !statSync(fromDir).isDirectory()) {
  console.error(`--from 不是目录：${fromDir}`);
  process.exit(2);
}
if (!existsSync(mappingFile)) {
  console.error(`--mapping 不存在：${mappingFile}`);
  process.exit(2);
}

const profile = JSON.parse(readFileSync(join(characterDir, "profile.json"), "utf8")) as CharacterProfile;
const mappingRaw = JSON.parse(readFileSync(mappingFile, "utf8")) as Record<string, unknown>;
const mapping: Array<{ angle: string; file: string }> = [];
for (const [angle, value] of Object.entries(mappingRaw)) {
  if (!KNOWN_ANGLES.has(angle)) {
    console.error(`mapping 里出现未知角度：${angle}（可用：${[...KNOWN_ANGLES].join(" / ")}）`);
    process.exit(2);
  }
  if (typeof value !== "string" || !value.trim()) {
    console.error(`mapping 的 ${angle} 必须是非空文件名`);
    process.exit(2);
  }
  mapping.push({ angle, file: value.trim() });
}
const missingRequired = REQUIRED_ANGLES.filter((angle) => !mapping.some((entry) => entry.angle === angle));
if (missingRequired.length > 0) {
  console.error(`缺必需角度：${missingRequired.join(" / ")}——先补齐再装（不允许"凑一个角度"）`);
  process.exit(2);
}

/** 版本号：默认自增（不覆盖既有版本） */
const versionsDir = join(characterDir, "portraits");
const existingVersions = existsSync(versionsDir)
  ? readdirSync(versionsDir).map((name) => /^v(\d+)$/.exec(name)?.[1]).filter(Boolean).map(Number)
  : [];
const version = Number(arg("--version", String((existingVersions.length > 0 ? Math.max(...existingVersions) : 0) + 1)));
if (!Number.isInteger(version) || version < 1) {
  console.error(`--version 非法：${arg("--version")}`);
  process.exit(2);
}
const targetDir = join(versionsDir, `v${version}`);
if (existsSync(targetDir) && !dryRun) {
  console.error(`目标版本已存在，拒绝覆盖：${targetDir}（换 --version 或先人工确认）`);
  process.exit(2);
}

/** 逐张校验来源：必须在 --from 内、是真实图片、读得到 sha256 */
const perAngle: Array<{ angle: string; slot: string; originalName: string; sha256: string; bytes: number; installed: string | null }> = [];
for (const entry of mapping) {
  const file = resolve(fromDir, entry.file);
  if (!(file === fromDir || file.startsWith(`${fromDir}/`)) || !IMAGE_EXT.test(file)) {
    console.error(`${entry.angle}：来源文件越界或不是图片（只允许 png/jpg/jpeg/webp，且必须在 --from 目录内）：${entry.file}`);
    process.exit(2);
  }
  if (!existsSync(file)) {
    console.error(`${entry.angle}：来源文件不存在：${file}`);
    process.exit(2);
  }
  let receipt;
  try {
    receipt = readPortraitArtifact(file);
  } catch (error) {
    console.error(`${entry.angle}：来源文件无效：${error instanceof Error ? error.message : String(error)}`);
    process.exit(2);
  }
  const ext = extname(file).toLowerCase();
  const installed = join(targetDir, `${profile.name}-${entry.angle}${ext}`);
  perAngle.push({
    angle: entry.angle,
    slot: `${profile.name}-${entry.angle}`,
    originalName: basename(file),
    sha256: receipt.sha256,
    bytes: receipt.bytes,
    installed: dryRun ? null : installed,
  });
}
/** 同一份原图不许占两个槽位（否则"8 角度"是假的） */
const byHash = new Map<string, string[]>();
for (const entry of perAngle) byHash.set(entry.sha256, [...(byHash.get(entry.sha256) ?? []), entry.angle]);
const duplicated = [...byHash.entries()].filter(([, angles]) => angles.length > 1);
if (duplicated.length > 0) {
  console.error(`同一张原图被指到多个角度（拒绝）：${duplicated.map(([, angles]) => angles.join("+")).join("，")}`);
  process.exit(2);
}

/** 既有 set 的资产映射（asset://）尽量保留，供审计对照 */
const previousSets = Array.isArray(profile.portraitSets) ? profile.portraitSets : [];
const previousActive = previousSets.find((set) => set.active) ?? previousSets[previousSets.length - 1];

let verification: unknown = null;
let reportPath: string | null = null;
if (!dryRun) {
  await withCharacterArchiveLock(characterDir, async () => {
    mkdirSync(targetDir, { recursive: true });
    for (const entry of perAngle) {
      const source = resolve(fromDir, entry.originalName);
      copyFileSync(source, join(targetDir, `${profile.name}-${entry.angle}${extname(source).toLowerCase()}`));
    }
    const sourceManifest = {
      schemaVersion: "workloom.portrait-source-map/v1",
      characterId,
      version,
      source: sourceKind,
      sourceNote: sourceKind === "customer-export"
        ? "客户从平台（火山方舟私域人像库）导出的授权真人原图，逐张人工落实角度槽位"
        : "以认证素材为参考生成的派生定妆照（非权威原图，仅供生成锚定）",
      fromDir,
      at: new Date().toISOString(),
      perAngle: perAngle.map((entry) => ({
        angle: entry.angle, file: `${profile.name}-${entry.angle}${extname(entry.originalName).toLowerCase()}`,
        originalName: entry.originalName, sha256: entry.sha256, bytes: entry.bytes,
      })),
      assetBinding: previousActive?.assets ?? null,
      note: "角度 → 文件 → 原图 sha256 的证据；请勿手改本文件（重装该版本即可刷新）",
    };
    writePortraitJson(join(targetDir, "source-map.json"), sourceManifest);

    const nextSet: PortraitSet = {
      version,
      dir: `portraits/v${version}`,
      angles: perAngle.map((entry) => entry.angle),
      files: Object.fromEntries(perAngle.map((entry) => [entry.angle, `portraits/v${version}/${profile.name}-${entry.angle}${extname(entry.originalName).toLowerCase()}`])),
      source: "real-authorized",
      active: activate,
      note: `${sourceKind === "customer-export" ? "客户导出原图" : "派生定妆照"}逐张落实（证据见 portraits/v${version}/source-map.json）`,
      ...(previousActive?.assets ? { assets: previousActive.assets } : {}),
    } as PortraitSet;
    const keptSets = previousSets
      .filter((set) => set.version !== version)
      .map((set) => (activate ? { ...set, active: false } : set));
    const nextProfile = { ...profile, portraitSets: [...keptSets, nextSet], updatedAt: new Date().toISOString() };
    writePortraitJson(join(characterDir, "profile.json"), nextProfile);
    const verified = verifyPortraitSet(characterDir, nextProfile as CharacterProfile, nextSet);
    verification = verified.verification;
    if (verified.verification.status !== "passed" && !allowUnverified) {
      throw new Error(`PORTRAIT_SET_UNVERIFIED：写入后复核未过——${verified.verification.issues.join("；")}`);
    }
  });
}

const report = {
  schemaVersion: "workloom.portrait-set-install-report/v1",
  at: new Date().toISOString(),
  characterId, version, dir: `portraits/v${version}`, source: sourceKind, dryRun, activate,
  requiredAngles: [...REQUIRED_ANGLES],
  missingOptionalAngles: OPTIONAL_ANGLES.filter((angle) => !perAngle.some((entry) => entry.angle === angle)),
  perAngle, verification,
};
const out = arg("--out");
if (out) {
  reportPath = resolve(out);
  mkdirSync(join(reportPath, ".."), { recursive: true });
  writePortraitJson(reportPath, report);
}
console.log(dryRun ? "（dry-run，未写入）" : "已安装");
console.log(`角色 ${characterId} → portraits/v${version}（${sourceKind}，${activate ? "已置为 active" : "未激活"}）`);
for (const entry of perAngle) {
  console.log(`  ${entry.angle.padEnd(18)} ← ${entry.originalName}  sha256 ${entry.sha256.slice(0, 12)}…（${(entry.bytes / 1024).toFixed(0)}KB）`);
}
if (report.missingOptionalAngles.length > 0) console.log(`  ⚠ 未提供的可选角度：${report.missingOptionalAngles.join(" / ")}`);
if (verification) console.log(`  复核：${JSON.stringify(verification).slice(0, 400)}`);
if (reportPath) console.log(`  报告：${reportPath}`);
