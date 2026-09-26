#!/usr/bin/env tsx
/**
 * 白板引擎回退开关验收（T-2026-0926-0020；对应规格 §2.10 验收 8 的"WHITEBOARD_ENABLED=0 回退"）
 *
 * 验收口径：置 0 之后引擎必须**完全消失**——不是"列在目录里、点了才报错"，
 * 而是「引擎不就绪 / provider 未配置 / 生成池里没有它 / 目录不列它」四件事同时成立。
 * 这四件事分别对应 UI 选型、提交入口、poll 解析、成本预估四个面，任一漏了都会留下"假能力"。
 *
 * 用法：pnpm exec tsx --env-file=.env scripts/tools/whiteboard-rollback-check.mts
 * 退出码：0 = 回退语义成立；1 = 有面没关干净（会打印哪一面漏了）。
 */
import { providerConfigured, listModels } from "../../apps/server/src/video/gen/catalog.js";
import { buildVideoGenPool } from "../../apps/server/src/video/gen/providers.js";
import { whiteboardEngineHint, whiteboardEngineReady } from "../../apps/server/src/video/whiteboard/engine.js";

const on = { ...process.env, WHITEBOARD_ENABLED: "1" } as NodeJS.ProcessEnv;
const off = { ...process.env, WHITEBOARD_ENABLED: "0" } as NodeJS.ProcessEnv;

const rows: string[] = [];
let failed = 0;
const check = (name: string, actual: unknown, expected: unknown) => {
  const ok = actual === expected;
  if (!ok) failed += 1;
  rows.push(`${ok ? "✓" : "✗"} ${name}：实际 ${String(actual)}，期望 ${String(expected)}`);
};

check("ENABLED=1 且 venv 就绪 → 引擎可用", whiteboardEngineReady(on), true);
check("ENABLED=0 → 引擎不可用（不依赖 venv 是否存在）", whiteboardEngineReady(off), false);
check("ENABLED=0 → providerConfigured=false（提交入口关闭）", providerConfigured("whiteboard-local", off), false);
check("ENABLED=1 → providerConfigured=true", providerConfigured("whiteboard-local", on), true);
check("ENABLED=0 → 生成池无 whiteboard-local（poller 解析不到）", buildVideoGenPool({ env: off }).has("whiteboard-local"), false);
check("ENABLED=1 → 生成池有 whiteboard-local", buildVideoGenPool({ env: on }).has("whiteboard-local"), true);
check("ENABLED=0 → 目录不列 whiteboard-stream（UI 选不到）",
  listModels({ kind: "video", env: off }).some((m) => m.id === "whiteboard-stream"), false);
check("ENABLED=1 → 目录列出 whiteboard-stream",
  listModels({ kind: "video", env: on }).some((m) => m.id === "whiteboard-stream"), true);

const reason = listModels({ kind: "video", onlyAvailable: false, env: off })
  .find((m) => m.id === "whiteboard-stream")?.unavailableReason ?? "(目录里查不到该条目)";

console.log(rows.join("\n"));
console.log(`\n回退提示语（ENABLED=0 时给用户看的那句话）：\n  ${whiteboardEngineHint(off)}`);
console.log(`\n目录里 whiteboard-stream 的不可用原因（includeUnavailable=true 时）：\n  ${reason}`);
if (failed > 0) {
  console.error(`\n回退语义不完整：${failed} 项未通过——置 0 后仍有面把白板引擎当成可用能力。`);
  process.exit(1);
}
console.log("\n回退语义成立：置 0 = 完全回到接入前行为（四面对齐关闭）。");
