#!/usr/bin/env node
/**
 * gate-ledger-report.mts —— 门账本只读审计报告（T-2026-0926-0112）
 *
 * 用途：把 `stages.jsonl` 里按 step_key 记的门事件读出来，回答四个问题：
 *   ① 每个门被调用了几次、最后一次裁决是什么；
 *   ② 期望出现的门有没有缺席（声明了门却没被调用 = 被绕过）；
 *   ③ 有没有"打回后未复核"就往下走的；
 *   ④ 有没有门号与 step_key 错配的脏账本。
 *
 * 只读：不改任何运行态；`--strict` 时发现"缺门/打回未复核/错配"即退出码 1（可用于验收与 CI）。
 * 用法：
 *   pnpm exec tsx scripts/tools/gate-ledger-report.mts --log <path/to/stages.jsonl>
 *     [--expected g5-portrait-confirm,g6-prompt-confirm,...] [--json] [--strict]
 */
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import {
  auditGateLedger,
  PIPELINE_GATE_STEP_KEYS,
  readGateEvents,
  type PipelineGateStepKey,
} from "../../packages/video-studio/src/index.js";

const arg = (name: string, fallback = ""): string => {
  const i = process.argv.indexOf(name);
  return i >= 0 ? (process.argv[i + 1] ?? fallback) : fallback;
};
const flag = (name: string): boolean => process.argv.includes(name);

const logPath = resolve(arg("--log", "work/vm-work/logs/stages.jsonl"));
if (!existsSync(logPath)) {
  console.error(`✗ 找不到阶段日志：${logPath}（用 --log 指定 stages.jsonl）`);
  process.exit(2);
}

const lines = readFileSync(logPath, "utf8")
  .split("\n")
  .map((l) => l.trim())
  .filter(Boolean)
  .flatMap((l) => {
    try {
      return [JSON.parse(l) as Record<string, unknown>];
    } catch {
      return [];
    }
  });

const expectedArg = arg("--expected", "");
const expected = expectedArg
  ? (expectedArg.split(",").map((s) => s.trim()).filter(Boolean) as PipelineGateStepKey[])
  : PIPELINE_GATE_STEP_KEYS;

const audit = auditGateLedger(readGateEvents(lines), expected);

if (flag("--json")) {
  console.log(JSON.stringify({ logPath, ...audit }, null, 2));
} else {
  console.log(`门账本审计：${logPath}`);
  console.log(`事件总数 ${audit.total}；出现的门 ${audit.counts.length}/${expected.length}`);
  console.log("\nstep_key                  gate     次数  最后裁决  依据");
  for (const row of audit.summary) {
    const cnt = audit.counts.find((c) => c.stepKey === row.stepKey)?.count ?? 0;
    console.log(
      `${row.stepKey.padEnd(24)} ${String(row.gate).padEnd(8)} ${String(cnt).padStart(3)}   `
      + `${row.approved ? "放行" : "打回"}     ${(row.reason || row.via || "").slice(0, 40)}`,
    );
  }
  if (audit.missing.length) console.log(`\n✗ 缺门（声明了却没被调用）：${audit.missing.join("、")}`);
  if (audit.rejectedWithoutRecheck.length) console.log(`✗ 打回后未复核：${audit.rejectedWithoutRecheck.join("、")}`);
  if (audit.mismatched.length) {
    console.log(`✗ 门号错配：${audit.mismatched.map((m) => `${m.stepKey}(记成 ${m.gate}，应为 ${m.expected})`).join("、")}`);
  }
  if (!audit.missing.length && !audit.rejectedWithoutRecheck.length && !audit.mismatched.length) {
    console.log("\n✓ 门账本完整：无缺门、无打回未复核、无错配");
  }
}

const bad = audit.missing.length + audit.rejectedWithoutRecheck.length + audit.mismatched.length;
process.exit(flag("--strict") && bad > 0 ? 1 : 0);
