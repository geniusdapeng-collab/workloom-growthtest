#!/usr/bin/env node
/**
 * 硬闸口径门禁（T-2026-0930-0015）：
 * 拦住"把创作/审美口径写成 hard: true"的改动——硬闸只允许事实类（见 scripts/ci/hard-gate-policy.mjs）。
 *
 * 用法：
 *   node scripts/ci/verify-hard-gate-policy.mjs                 # 扫默认范围（视频管线执行器 + video-studio 源码）
 *   node scripts/ci/verify-hard-gate-policy.mjs <file...>       # 只扫指定文件
 *   node scripts/ci/verify-hard-gate-policy.mjs --self-test     # 只跑内置样例（不读仓库文件）
 */
import fs from "node:fs";
import path from "node:path";
import { scanHardGatePolicy, describeViolations } from "./hard-gate-policy.mjs";

const DEFAULT_ROOTS = ["scripts/tools", "packages/video-studio/src"];
const MUTATING_EXTENSIONS = new Set([".mts", ".ts", ".mjs", ".js"]);
const SKIP_SUFFIXES = [".test.ts", ".test.mjs", ".test.js", ".d.ts"];

function walk(dir, out = []) {
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
      walk(full, out);
      continue;
    }
    if (!MUTATING_EXTENSIONS.has(path.extname(entry.name))) continue;
    if (SKIP_SUFFIXES.some((suffix) => entry.name.endsWith(suffix))) continue;
    out.push(full);
  }
  return out;
}

function selfTest() {
  const bad = [
    "checks.push({",
    "  id: `motion-richness:${shot.shotId}`,",
    "  pass: lastMotionVerdict.rich,",
    "  hard: true,",
    "  detail: \"够不够热闹\"",
    "});"
  ].join("\n");
  const good = bad.replace("hard: true", "hard: false");
  const advisory = bad.replace("hard: true", "hard: REVIEW_POLICY === \"blocking\"");
  const factual = [
    "checks.push({ id: \"duration\", pass: ok, hard: true, detail: \"时长\" });"
  ].join("\n");
  const failures = [];
  if (scanHardGatePolicy(bad, { file: "fixture-bad.mts" }).length !== 1) failures.push("应拦下创作口径 hard: true");
  if (scanHardGatePolicy(good, { file: "fixture-good.mts" }).length !== 0) failures.push("不应拦下 hard: false");
  if (scanHardGatePolicy(advisory, { file: "fixture-advisory.mts" }).length !== 0) failures.push("不应拦下按策略切换的 hard（blocking 才硬）");
  if (scanHardGatePolicy(factual, { file: "fixture-factual.mts" }).length !== 0) failures.push("不应拦下事实类硬闸");
  if (failures.length > 0) {
    console.error(`[hard-gate-policy] 自检失败：${failures.join("；")}`);
    process.exit(1);
  }
  console.log("[hard-gate-policy] 自检通过：创作口径 hard: true 会被拦，事实类硬闸与策略切换不受影响。");
}

const args = process.argv.slice(2);
if (args.includes("--self-test")) {
  selfTest();
  process.exit(0);
}

const explicit = args.filter((arg) => !arg.startsWith("--"));
const files = explicit.length > 0 ? explicit : DEFAULT_ROOTS.flatMap((root) => walk(root));
const violations = files.flatMap((file) => scanHardGatePolicy(fs.readFileSync(file, "utf8"), { file }));

if (violations.length > 0) {
  console.error(describeViolations(violations));
  process.exit(1);
}
console.log(`[hard-gate-policy] 通过：扫描 ${files.length} 个文件，未发现"创作口径写成硬闸"。`);
