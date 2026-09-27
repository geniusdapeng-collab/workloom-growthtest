#!/usr/bin/env node
/**
 * portrait-agent CLI —— 定妆照生成 Agent（绑定角色档案）
 *
 * 用法：
 *   node scripts/tools/portrait-agent.mts plan --character <characterId>          # 只打印提示词（dry-run）
 *   node scripts/tools/portrait-agent.mts run  --character <characterId> [--seed 20260925]
 *        [--version 3] [--angles front,threeQuarter,closeup,side] [--no-activate]
 *        [--anchor <角色目录相对路径或绝对路径，可逗号分隔；也可给目录>]
 *   node scripts/tools/portrait-agent.mts review --character <characterId> [--version N] [--anchor <参考照片>]
 *        # AI 监制评审：拿授权真人照片当基准，判断定妆照"是不是同一个人"；不合格即判 rerun
 *
 * 纪律：纯写实 + 场景解耦（中性背景/中性光，只描述人）；默认 4 角度；产物写回档案库并置 active。
 * 授权真人：`--anchor` 给定本人照片即走图生图（source=img2img），锁面部与身形；不给则纯文生图。
 * 设计见 `docs/character-archive-design.md`（附录 A.1/A.2）。
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  appendGateEvent, assertCharacterComponent, buildGateEvent, buildPortraitPlan, loadCharacterEntry, reviewStage, runPortraitAgent
} from "../../packages/video-studio/src/index.js";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const LIBRARY_ROOT = resolve(REPO_ROOT, process.env.HR_CHARACTER_LIBRARY ?? "var/media/characters");

function arg(name: string, fallback = ""): string {
  const index = process.argv.indexOf(name);
  return index >= 0 ? String(process.argv[index + 1] ?? "") : fallback;
}
const flag = (name: string): boolean => process.argv.includes(name);

/**
 * 密钥加载（2026-09-24 修复）：与 `full-chain-film.mts` 同口径——**先读仓库外密钥文件**
 * `~/.workloom/live.env`（VOLCENGINE_ARK_API_KEY / LLM_* 的真实位置），再读仓库 `.env`，
 * 最后让进程环境覆盖。早先这里只读仓库 `.env`，于是 `portrait-agent review` 在真机上
 * 永远拿不到评审模型（fail-closed 打回），定妆照评审实际从未跑成过。
 */
const ENV: Record<string, string> = (() => {
  const out: Record<string, string> = {};
  const files = [resolve(homedir(), ".workloom", "live.env"), resolve(REPO_ROOT, ".env")];
  for (const file of files) {
    if (!existsSync(file)) continue;
    for (const line of readFileSync(file, "utf8").split("\n")) {
      const match = line.match(/^([A-Z0-9_]+)=(.*)$/);
      if (match && match[2]!.trim() && !out[match[1]!]) out[match[1]!] = match[2]!.trim();
    }
  }
  for (const [key, value] of Object.entries(process.env)) if (value) out[key] = value;
  return out;
})();

const command = process.argv[2] ?? "";
const characterId = arg("--character");

const IMAGE_EXT = /\.(png|jpe?g|webp)$/i;

/**
 * 锚点解析：支持（a）逗号分隔的文件列表、（b）目录（取其中全部图片，按文件名排序）、
 * （c）相对角色目录或相对仓库根。目录项 `sources/` 是真人照片的约定落点。
 */
function resolveAnchors(spec: string, characterDir: string): string[] {
  if (!spec) return [];
  const out: string[] = [];
  for (const raw of spec.split(",").map((s) => s.trim()).filter(Boolean)) {
    const candidates = [
      resolve(characterDir, raw),
      resolve(REPO_ROOT, raw),
      resolve(raw)
    ];
    const hit = candidates.find((p) => existsSync(p));
    if (!hit) throw new Error(`显式锚点不存在：${raw}，不能静默改成纯文生图`);
    const stat = statSync(hit);
    if (stat.isDirectory()) {
      for (const name of readdirSync(hit).sort()) {
        if (IMAGE_EXT.test(name)) out.push(join(hit, name));
      }
      continue;
    }
    out.push(hit);
  }
  if (out.length === 0) throw new Error("显式锚点目录没有图片，不能静默改成纯文生图");
  return out;
}

async function main(): Promise<void> {
  if (!characterId) {
    console.error("用法：portrait-agent.mts <plan|run> --character <characterId> [--seed N] [--version N] [--angles a,b] [--no-activate]");
    process.exitCode = 2;
    return;
  }
  assertCharacterComponent(characterId);
  for (const name of ["--character", "--seed", "--version", "--angles", "--anchor", "--size", "--wardrobe-id", "--wardrobe"]) {
    const value = arg(name);
    if (flag(name) && (!value || value.startsWith("--"))) throw new Error(`参数缺少值：${name}`);
  }
  const entry = loadCharacterEntry(join(LIBRARY_ROOT, characterId));
  if (!entry) {
    console.error(`未找到角色档案：${join(LIBRARY_ROOT, characterId, "profile.json")}`);
    process.exitCode = 1;
    return;
  }
  const model = ENV.ARK_IMAGE_MODEL || ENV.SEEDREAM_MODEL || "doubao-seedream-5-0-pro-260628";
  const config = {
    model, baseUrl: ENV.ARK_BASE_URL,
    ...(arg("--seed") ? { seed: Number(arg("--seed")) } : {}),
    ...(arg("--version") ? { version: Number(arg("--version")) } : {}),
    ...(arg("--angles") ? { angles: arg("--angles").split(",").map((s) => s.trim()).filter(Boolean) } : {}),
    ...(arg("--anchor") ? { anchorImages: resolveAnchors(arg("--anchor"), join(LIBRARY_ROOT, characterId)) } : {}),
    ...(arg("--size") ? { size: arg("--size") } : {}),
    ...(flag("--no-activate") ? { activate: false } : {}),
    ...(arg("--wardrobe-id") ? { wardrobeId: arg("--wardrobe-id") } : {}),
    ...(arg("--wardrobe") ? { wardrobe: { name: arg("--wardrobe") } } : {})
  };

  if (command === "plan") {
    const plan = buildPortraitPlan(entry, config);
    console.log(`角色：${plan.name}（${plan.characterId}）｜版本 v${plan.version}｜模式 ${plan.mode}（${plan.reason}）`);
    console.log(`锚点：${plan.anchors.length > 0 ? plan.anchors.map((f) => f.split("/").slice(-1)[0]).join(" / ") : "无（纯文生图）"}`);
    console.log(`角度：${plan.angles.join(" / ")}`);
    console.log(`服装：${String(plan.wardrobe.name ?? "未指定")}｜服装hash=${plan.wardrobeHash}｜请求hash=${plan.requestHash}`);
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
    const result = await runPortraitAgent({
      libraryRoot: LIBRARY_ROOT,
      characterId,
      apiKey,
      model,
      baseUrl: ENV.ARK_BASE_URL,
      config,
      log: (line) => console.log(line)
    });
    console.log(`\n${result.portraitSet.status === "ready" ? "已完成" : "候选未完整"}：${result.characterId} v${result.version} ${Object.keys(result.files).join("/")}`);
    console.log(`   档案：${result.profileFile}`);
    console.log(`   定妆照集：portrait-sets/v${result.version}.json（active=${result.portraitSet.active}）`);
    if (result.portraitSet.status !== "ready") process.exitCode = 4;
    return;
  }

  if (command === "review") {
    const characterDir = join(LIBRARY_ROOT, characterId);
    const versionArg = arg("--version") ? Number(arg("--version")) : null;
    const selected = loadCharacterEntry(characterDir, versionArg === null ? {} : { pinnedVersion: versionArg });
    const target = selected?.activeSet;
    if (!target) {
      console.error(`未找到定妆照集（version=${versionArg ?? "active"}）`);
      process.exitCode = 1;
      return;
    }
    if (selected!.verification.status !== "passed") throw new Error(`候选尚不可评审：${selected!.verification.issues.join("；")}`);
    const produced = Object.values(selected!.files);
    const anchors = (target.anchors ?? []).map((p) => resolve(characterDir, p)).filter(existsSync);
    const fallbackAnchors = anchors.length > 0
      ? anchors
      : (existsSync(join(characterDir, "sources")) ? readdirSync(join(characterDir, "sources")).filter((f) => IMAGE_EXT.test(f)).slice(0, 4).map((f) => join(characterDir, "sources", f)) : []);
    const required = ["front", "threeQuarter", "closeup", "side"];
    const verdict = await reviewStage({
      stage: "keyframe",
      projectId: `portrait:${entry.id}:v${target.version}`,
      artifacts: produced.map((path) => ({ path, kind: "image" as const, bytes: statSync(path).size })),
      referenceImages: fallbackAnchors,
      deterministic: [
        { id: "required-angles", pass: required.every((a) => (target.angles ?? []).includes(a)), hard: true, detail: `必需角度 ${required.join("/")}；实际 ${(target.angles ?? []).join("/")}` },
        { id: "file-size", pass: produced.every((f) => statSync(f).size > 50_000), hard: true, detail: produced.map((f) => `${f.split("/").slice(-1)[0]}=${(statSync(f).size / 1024).toFixed(0)}KB`).join(" ") },
        { id: "anchor-present", pass: fallbackAnchors.length > 0, detail: fallbackAnchors.length > 0 ? `基准照片 ${fallbackAnchors.length} 张（可做人脸一致性比对）` : "无基准照片（无法判断像不像，仅能判画质与纪律）" }
      ],
      context: {
        characterId: entry.id,
        name: entry.name,
        kind: entry.kind,
        source: target.source,
        version: target.version,
        discipline: "定妆照按设计口径**场景解耦**：中性浅灰无缝背景、中性柔光 5600K、只描述人——因此「没有实景/没有道具」不是缺陷，不要据此扣分。",
        note: "评审要点：定妆照必须与基准照片是同一张脸（五官比例/眼型/鼻型/唇形/脸型），同一发型与发色；允许妆造与服装变化。不确定时以「能不能认出是同一个人」为唯一硬标准。"
      },
      allowFallbackApprove: false,
      /**
       * 必须显式传 env（2026-09-24 真机）：`reviewStage` 缺省只读 `process.env`，
       * 而密钥在 `~/.workloom/live.env` 里 → 不传 env 就永远"无可用评审模型"，
       * 定妆照评审实际从未跑成（G5 门因此长期只有 degraded 记录）。
       */
      env: ENV,
      log: (line) => console.log(line)
    });
    const reviewDir = join(characterDir, "reviews");
    mkdirSync(reviewDir, { recursive: true });
    const reviewFile = join(reviewDir, `v${target.version}-${new Date().toISOString().replace(/[:.]/g, "-")}.json`);
    writeFileSync(reviewFile, `${JSON.stringify({ at: new Date().toISOString(), characterId: entry.id, version: target.version, source: target.source, verdict, artifacts: produced, references: fallbackAnchors }, null, 2)}\n`);
    /**
     * G5 门事件落账（2026-09-24）：定妆照确认门 `g5-portrait-confirm` 以前只有 review 文件，
     * 片场运行时（full-chain-film 的 G5）读不到"按 step_key 记账的门记录"，只能标 degraded。
     * 这里把评审结论写进角色目录的 `gates.jsonl`（与阶段日志同一门账本格式），供片场与平台按 step_key 检索。
     */
    const gateEvent = buildGateEvent({
      stepKey: "g5-portrait-confirm",
      projectId: `portrait:${entry.id}:v${target.version}`,
      sourceStage: "portrait-review",
      shotIds: [],
      checks: [
        { id: "required-angles", pass: required.every((a) => (target.angles ?? []).includes(a)), hard: true, detail: `必需角度 ${required.join("/")}；实际 ${(target.angles ?? []).join("/")}` },
        { id: "file-size", pass: produced.every((f) => statSync(f).size > 50_000), hard: true, detail: produced.map((f) => `${f.split("/").slice(-1)[0]}=${(statSync(f).size / 1024).toFixed(0)}KB`).join(" ") },
        { id: "anchor-present", pass: fallbackAnchors.length > 0, detail: fallbackAnchors.length > 0 ? `基准照片 ${fallbackAnchors.length} 张` : "无基准照片（人像同一性无法与真人比对，仅判画质与跨角度一致性）" }
      ],
      softApproved: verdict.approved,
      via: verdict.via,
      score: verdict.score,
      degraded: verdict.degraded,
      reason: verdict.reason,
      evidence: { reviewFile, artifacts: produced.length, references: fallbackAnchors.length, characterId: entry.id, version: target.version }
    });
    appendGateEvent(join(characterDir, "gates.jsonl"), gateEvent);
    console.log(`门记录（g5-portrait-confirm）：${gateEvent.ok ? "放行" : "未过"} → ${join(characterDir, "gates.jsonl")}`);
    console.log(`监制结论：${verdict.approved ? "放行" : "打回重跑"}（score=${verdict.score} · via=${verdict.via}）`);
    console.log(`  理由：${verdict.reason}`);
    if (verdict.issues.length > 0) console.log(`  问题：${verdict.issues.join("；")}`);
    if (verdict.suggestions.length > 0) console.log(`  建议：${verdict.suggestions.join("；")}`);
    console.log(`  评审记录：${reviewFile}`);
    if (!verdict.approved) process.exitCode = 4;
    return;
  }

  console.error(`未知子命令：${command}（可用：plan / run）`);
  process.exitCode = 2;
}

try { await main(); } catch (error) { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; }
