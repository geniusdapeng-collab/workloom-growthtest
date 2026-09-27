#!/usr/bin/env node
/**
 * character-archive —— 人物档案库命令行（P0）
 *
 * 用法：
 *   node scripts/tools/character-archive.mts list
 *   node scripts/tools/character-archive.mts show <characterId>
 *   node scripts/tools/character-archive.mts versions <characterId>
 *   node scripts/tools/character-archive.mts bind --project VID-1023 --character <id> [--pin 2]
 *   node scripts/tools/character-archive.mts impact --character <id> --from 1 --to 2
 *
 * 设计见 `docs/character-archive-design.md`（档案是跨项目资产；项目只做引用 + 可 pin 版本）。
 */
import { existsSync, readFileSync, readdirSync, writeFileSync, mkdirSync, realpathSync, lstatSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  impactOfVersionChange,
  listPortraitVersions,
  loadCharacterEntry,
  loadCharacterLibrary,
  activatePortraitVersion, assertCharacterComponent, readPortraitArtifact, withCharacterArchiveLock, writePortraitJson,
  type ProjectBinding
} from "../../packages/video-studio/src/index.js";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const LIBRARY_ROOT = resolve(REPO_ROOT, process.env.HR_CHARACTER_LIBRARY ?? "var/media/characters");
const WORK_DIR = resolve(REPO_ROOT, process.env.HR_WORK_DIR ?? ".vm-work");

function arg(name: string, fallback = ""): string {
  const index = process.argv.indexOf(name);
  if (index < 0) return fallback;
  const value = process.argv[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`参数缺少值：${name}`);
  return value;
}

const command = process.argv[2] ?? "";

function listCommand(): void {
  const library = loadCharacterLibrary(LIBRARY_ROOT);
  if (library.size === 0) {
    console.log(`档案库为空：${LIBRARY_ROOT}`);
    return;
  }
  console.log(`人物档案库：${LIBRARY_ROOT}（${library.size} 个角色）`);
  for (const character of library.values()) {
    const angles = Object.keys(character.files).join("/") || "无定妆照";
    console.log(`  · ${character.name}（${character.id}）｜类型=${character.kind}｜active=v${character.activeSet?.version ?? "-"}｜角度=${angles}`);
    if (character.authorization?.status) console.log(`      授权：${character.authorization.status}${character.authorization.expiresAt ? `（至 ${character.authorization.expiresAt}）` : ""}`);
  }
}

function showCommand(id: string): void {
  assertCharacterComponent(id);
  const entry = loadCharacterEntry(join(LIBRARY_ROOT, id));
  if (!entry) {
    console.error(`未找到角色：${id}（在 ${LIBRARY_ROOT}）`);
    process.exitCode = 1;
    return;
  }
  const { dir: _dir, activeSet, files, ...profile } = entry;
  console.log(JSON.stringify({ ...profile, activeSet, files }, null, 2));
}

function versionsCommand(id: string): void {
  assertCharacterComponent(id);
  const entry = loadCharacterEntry(join(LIBRARY_ROOT, id));
  if (!entry) {
    console.error(`未找到角色：${id}`);
    process.exitCode = 1;
    return;
  }
  console.log(`${entry.name} 的定妆照集（新→旧）：`);
  for (const set of listPortraitVersions(entry)) {
    console.log(`  v${set.version}${set.active ? "（active）" : ""}｜来源=${set.source}｜角度=${set.angles.join("/")}`
      + `${set.seed ? `｜seed=${set.seed}` : ""}${set.createdAt ? `｜${set.createdAt}` : ""}`);
    if (set.prompt) console.log(`      提示词：${String(set.prompt).slice(0, 120)}`);
  }
}

/** 扫描所有项目绑定（`.vm-work/characters/<projectId>/portrait-index.json`） */
function loadBindings(): ProjectBinding[] {
  const root = join(WORK_DIR, "characters");
  if (!existsSync(root)) return [];
  const bindings: ProjectBinding[] = [];
  for (const projectId of readdirSync(root)) {
    const file = join(root, projectId, "portrait-index.json");
    if (!existsSync(file)) continue;
    try {
      const index = JSON.parse(readFileSync(file, "utf8")) as {
        characters?: Record<string, { id?: string; pinnedVersion?: number }>;
      };
      for (const [key, value] of Object.entries(index.characters ?? {})) {
        bindings.push({ projectId, characterId: value.id ?? key, pinnedVersion: value.pinnedVersion });
      }
    } catch (error) {
      throw new Error(`项目绑定索引无法读取：${file}；${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return bindings;
}

async function bindCommand(): Promise<void> {
  const projectId = arg("--project");
  const characterId = arg("--character");
  const pinned = arg("--pin");
  if (!projectId || !characterId) {
    console.error("用法：bind --project <projectId> --character <characterId> [--pin <version>]");
    process.exitCode = 2;
    return;
  }
  assertCharacterComponent(projectId); assertCharacterComponent(characterId);
  const characterDir = join(LIBRARY_ROOT, characterId);
  if (!existsSync(characterDir)) throw new Error(`未找到角色：${characterId}`);
  if (lstatSync(characterDir).isSymbolicLink() || realpathSync(characterDir) !== join(realpathSync(LIBRARY_ROOT), characterId)) throw new Error("CHARACTER_PATH_INVALID: 绑定来源目录越界或为symlink");
  const entry = loadCharacterEntry(characterDir, pinned ? { pinnedVersion: Number(pinned) } : {});
  if (!entry) {
    console.error(`未找到角色：${characterId}`);
    process.exitCode = 1;
    return;
  }
  if (entry.id !== characterId) throw new Error("CHARACTER_ARCHIVE_INVALID: 绑定来源路径与档案ID不一致");
  if (entry.verification.status !== "passed" || !entry.activeSet) throw new Error(`绑定未通过：${entry.verification.issues.join("；")}`);
  const projectRoot = join(WORK_DIR, "characters", projectId);
  mkdirSync(WORK_DIR, { recursive: true });
  let current = WORK_DIR;
  for (const part of ["characters", projectId]) {
    current = join(current, part); if (!existsSync(current)) mkdirSync(current);
    if (lstatSync(current).isSymbolicLink()) throw new Error("CHARACTER_PATH_INVALID: 项目目录不能是symlink");
  }
  await withCharacterArchiveLock(projectRoot, async () => {
  const projectCharacterDir = join(projectRoot, entry.id);
  const portraitDir = join(projectCharacterDir, "portraits", `v${entry.activeSet!.version}`);
  current = projectRoot;
  for (const part of [entry.id, "portraits", `v${entry.activeSet!.version}`]) { current = join(current, part); if (!existsSync(current)) mkdirSync(current); if (lstatSync(current).isSymbolicLink()) throw new Error("CHARACTER_PATH_INVALID: 绑定目录不能是symlink"); }
  const files: Record<string, string> = {};
  const artifacts: Record<string, unknown> = {};
  for (const [angle, source] of Object.entries(entry.files)) {
    const target = join(portraitDir, `${entry.id}-${angle}.png`);
    const original = readPortraitArtifact(source, entry.dir);
    if (original.sha256 !== entry.verification.assets[angle]?.sha256) throw new Error("PORTRAIT_BINDING_CHANGED: 拷贝前来源发生变化");
    if (!existsSync(target)) writeFileSync(target, readFileSync(source), { flag: "wx", mode: 0o600 });
    const copied = readPortraitArtifact(target, projectRoot);
    if (copied.sha256 !== original.sha256) throw new Error("PORTRAIT_BINDING_CHANGED: 已有版本副本字节不符，不覆盖历史绑定");
    files[angle] = target;
    artifacts[angle] = copied;
  }
  const indexFile = join(projectRoot, "portrait-index.json");
  if (existsSync(indexFile) && lstatSync(indexFile).isSymbolicLink()) throw new Error("CHARACTER_PATH_INVALID: 索引不能是symlink");
  const index = existsSync(indexFile)
    ? (JSON.parse(readFileSync(indexFile, "utf8")) as { schemaVersion: string; projectId: string; characters?: Record<string, unknown>; products?: Record<string, unknown> })
    : { schemaVersion: "workloom.portrait-index/v1", projectId, characters: {}, products: {} };
  if (index.schemaVersion !== "workloom.portrait-index/v1" || index.projectId !== projectId || !index.characters || typeof index.characters !== "object") throw new Error("CHARACTER_ARCHIVE_INVALID: 项目索引不匹配");
  index.characters = index.characters ?? {};
  for (const [key, value] of Object.entries(index.characters)) if (value && typeof value === "object" && (value as { id?: string }).id === entry.id) delete index.characters[key];
  index.characters[entry.id] = {
    kind: "character",
    id: entry.id,
    name: entry.name,
    dir: projectCharacterDir,
    libraryRef: realpathSync(entry.dir),
    ...(pinned ? { pinnedVersion: Number(pinned) } : {}),
    portraitVersion: entry.activeSet!.version,
    wardrobe: entry.activeSet!.wardrobe,
    wardrobeHash: entry.activeSet!.wardrobeHash,
    sourceHash: entry.activeSet!.sourceHash,
    bindingMode: pinned ? "pinned" : "active-at-bind",
    files, artifacts
  };
  writePortraitJson(indexFile, index);
  console.log(`✅ 已绑定：${projectId} ← ${entry.name}（v${entry.activeSet?.version ?? "-"}${pinned ? `，pin v${pinned}` : ""}）`);
  console.log(`   绑定文件：${indexFile}`);
  });
}

function impactCommand(): void {
  const characterId = arg("--character");
  assertCharacterComponent(characterId);
  const from = Number(arg("--from", "1"));
  const to = Number(arg("--to", "0")) || ((loadCharacterEntry(join(LIBRARY_ROOT, characterId))?.activeSet?.version) ?? from + 1);
  if (!characterId) {
    console.error("用法：impact --character <characterId> [--from 1] [--to 2]");
    process.exitCode = 2;
    return;
  }
  const impact = impactOfVersionChange(loadBindings(), { characterId, fromVersion: from, toVersion: to });
  console.log(`版本影响面：${characterId} v${from} → v${to}`);
  console.log(`  使用 active 的项目（下次绑定解析当前版本）：${impact.followActive.map((b) => b.projectId).join("、") || "无"}`);
  console.log(`  钉在旧版 v${from}（需评估重渲）：${impact.pinnedOld.map((b) => b.projectId).join("、") || "无"}`);
  console.log(`  已钉新版 v${to}：${impact.pinnedNew.map((b) => b.projectId).join("、") || "无"}`);
}

try { switch (command) {
  case "list": listCommand(); break;
  case "show": showCommand(process.argv[3] ?? ""); break;
  case "versions": versionsCommand(process.argv[3] ?? ""); break;
  case "bind": await bindCommand(); break;
  case "activate": {
    const entry = await activatePortraitVersion(LIBRARY_ROOT, arg("--character"), Number(arg("--version")));
    console.log(`已激活 ${entry.id} v${entry.activeSet?.version}；四角度与当前文件收据已核验`); break;
  }
  case "impact": impactCommand(); break;
  default:
    console.log([
      "用法：",
      "  character-archive.mts list",
      "  character-archive.mts show <characterId>",
      "  character-archive.mts versions <characterId>",
      "  character-archive.mts bind --project <projectId> --character <characterId> [--pin <version>]",
      "  character-archive.mts activate --character <characterId> --version <version>",
      "  character-archive.mts impact --character <characterId> [--from <v>] [--to <v>]"
    ].join("\n"));
    process.exitCode = command ? 2 : 0;
} } catch (error) { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; }
