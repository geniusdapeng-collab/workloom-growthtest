#!/usr/bin/env node
/**
 * portrait-agent CLI —— 定妆照生成 Agent（绑定角色档案）
 *
 * 用法：
 *   node scripts/tools/portrait-agent.mts plan --character <characterId>          # 只打印提示词（dry-run）
 *   node scripts/tools/portrait-agent.mts run  --character <characterId> [--seed 20260925]
 *        [--version 3] [--angles front,threeQuarter,closeup,side] [--no-activate]
 *
 * 纪律：纯写实 + 场景解耦（中性背景/中性光，只描述人）；默认 4 角度；产物写回档案库并置 active。
 * 设计见 `docs/character-archive-design.md`（附录 A.1/A.2）。
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { buildPortraitPlan, loadCharacterEntry, runPortraitAgent } from "../../packages/video-studio/src/index.js";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const LIBRARY_ROOT = resolve(REPO_ROOT, process.env.HR_CHARACTER_LIBRARY ?? "var/media/characters");

function arg(name: string, fallback = ""): string {
  const index = process.argv.indexOf(name);
  return index >= 0 ? String(process.argv[index + 1] ?? "") : fallback;
}
const flag = (name: string): boolean => process.argv.includes(name);

const ENV = Object.fromEntries(
  existsSync(resolve(REPO_ROOT, ".env"))
    ? readFileSync(resolve(REPO_ROOT, ".env"), "utf8")
        .split("\n")
        .filter((line) => line && !line.startsWith("#") && line.includes("="))
        .map((line) => { const i = line.indexOf("="); return [line.slice(0, i), line.slice(i + 1)]; })
    : []
) as Record<string, string>;

const command = process.argv[2] ?? "";
const characterId = arg("--character");

async function main(): Promise<void> {
  if (!characterId) {
    console.error("用法：portrait-agent.mts <plan|run> --character <characterId> [--seed N] [--version N] [--angles a,b] [--no-activate]");
    process.exitCode = 2;
    return;
  }
  const entry = loadCharacterEntry(join(LIBRARY_ROOT, characterId));
  if (!entry) {
    console.error(`未找到角色档案：${join(LIBRARY_ROOT, characterId, "profile.json")}`);
    process.exitCode = 1;
    return;
  }
  const config = {
    ...(arg("--seed") ? { seed: Number(arg("--seed")) } : {}),
    ...(arg("--version") ? { version: Number(arg("--version")) } : {}),
    ...(arg("--angles") ? { angles: arg("--angles").split(",").map((s) => s.trim()).filter(Boolean) } : {}),
    ...(flag("--no-activate") ? { activate: false } : {})
  };

  if (command === "plan") {
    const plan = buildPortraitPlan(entry, config);
    console.log(`角色：${plan.name}（${plan.characterId}）｜版本 v${plan.version}｜模式 ${plan.mode}（${plan.reason}）`);
    console.log(`角度：${plan.angles.join(" / ")}`);
    if (plan.negativeTerms) console.log(`负面词：${plan.negativeTerms}`);
    for (const [angle, prompt] of Object.entries(plan.prompts)) console.log(`\n[${angle}]\n${prompt}`);
    return;
  }

  if (command === "run") {
    const apiKey = ENV.VOLCENGINE_ARK_API_KEY || ENV.ARK_API_KEY || process.env.VOLCENGINE_ARK_API_KEY || process.env.ARK_API_KEY || "";
    if (!apiKey) {
      console.error("缺少 ARK 密钥（.env: VOLCENGINE_ARK_API_KEY / ARK_API_KEY）");
      process.exitCode = 1;
      return;
    }
    const model = ENV.ARK_IMAGE_MODEL || ENV.SEEDREAM_MODEL || "doubao-seedream-5-0-pro-260628";
    const result = await runPortraitAgent({
      libraryRoot: LIBRARY_ROOT,
      characterId,
      apiKey,
      model,
      baseUrl: ENV.ARK_BASE_URL,
      config,
      log: (line) => console.log(line)
    });
    console.log(`\n✅ ${result.characterId} v${result.version} 完成：${Object.keys(result.files).join("/")}`);
    console.log(`   档案：${result.profileFile}`);
    console.log(`   定妆照集：portrait-sets/v${result.version}.json（active=${result.portraitSet.active}）`);
    return;
  }

  console.error(`未知子命令：${command}（可用：plan / run）`);
  process.exitCode = 2;
}

await main();
