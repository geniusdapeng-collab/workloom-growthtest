#!/usr/bin/env node
/** MC-006：可在干净提交上复跑的工具路由/模拟回执断言。--db 增加真实 PG 验证。 */
import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
if (args.some((arg) => arg !== "--db")) {
  console.error("用法：node scripts/verify-geo-tool-routing.mjs [--db]");
  process.exit(2);
}

function run(label, commandArgs) {
  const result = spawnSync(process.execPath, commandArgs, { cwd: root, env: process.env, stdio: "inherit" });
  if (result.error) {
    console.error(`${label} 启动失败：${result.error.message}`);
    process.exit(1);
  }
  if (result.signal || result.status !== 0) {
    console.error(`${label} 未通过：${result.signal ? `signal=${result.signal}` : `exit=${result.status}`}`);
    process.exit(result.status && result.status > 0 ? result.status : 1);
  }
}

run("工具路由与回执单元回归", [
  "node_modules/vitest/vitest.mjs", "run", "packages/runtime/src", "apps/server/src/runtime/tool-executor.test.ts",
]);
run("原发布任务门禁的反例回归", ["--import", "tsx", "--test", "scripts/release-gate-quest.test.mjs"]);
if (args.includes("--db")) run("真实 PG 作用域与 replay 回归", ["--import", "tsx", "scripts/tools/verify-geo-tool-routing-db.mts"]);
console.log(`MC-006 断言通过（${args.includes("--db") ? "单元 + 真实 PG" : "单元；未请求 PG"}，付费模型/图像/视频 API 调用 0）。`);
