#!/usr/bin/env node
/**
 * fence-alias-scan · S9 围栏别名扫描器（《GROWTH 深度产品方案》§8 S9）
 *
 * 事故背景（2026-09-19 真机验收）：加投审批 G12 只匹配对象 `ads_campaign`，
 * 而规划器按工具名前缀派生出对象视图 `ads`（ads.watch / ads.boost），
 * 导致「加投绕过 G12 的对象维度」。本扫描器把这类**对象别名缺口**变成门禁：
 *
 * 判定（确定性、无启发式打分）：
 *   对每条基线围栏规则的每个 `match.actions` 动作，取其前缀（action.split(".")[0]）；
 *   若组合编制声明了与**前缀同名**的对象（planner 派生视图），
 *   而该规则的 `match.object_types` 未包含它 → 报 FAIL（别名缺口）。
 *   另附「写动作未被任何规则覆盖」只读报告（advisory，不阻断）。
 *
 * 运行：pnpm scan:fences [--json]（CI test-gate 已接入）
 */
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { composeWorkforce, loadComposedAssets, mergeComposedFenceRules } from "../../packages/base/bundles/index.js";

const ROOT = join(import.meta.dirname, "..", "..");
const PRIMARY = process.env.ACCEPTANCE_PRIMARY_BUNDLE ?? "geo-growth";
const JSON_OUT = process.argv.includes("--json");

function readObjects(bundleId: string): Set<string> {
  const p = join(ROOT, "bundles", bundleId, "schemas", "objects.json");
  if (!existsSync(p)) return new Set();
  const doc = JSON.parse(readFileSync(p, "utf8")) as { objects?: Array<{ type: string }> };
  return new Set((doc.objects ?? []).map((o) => o.type));
}

const composed = composeWorkforce(PRIMARY);
const assets = loadComposedAssets(PRIMARY);
const merged = mergeComposedFenceRules(assets.fencePacks);

const objectTypes = new Set<string>();
for (const bundleId of assets.bundleIds) for (const t of readObjects(bundleId)) objectTypes.add(t);

interface Finding { ruleId: string; action: string; alias: string; bundleId: string }
const findings: Finding[] = [];
for (const { bundleId, rule } of merged) {
  for (const action of rule.match?.actions ?? []) {
    const dot = action.indexOf(".");
    if (dot <= 0) continue;
    const alias = action.slice(0, dot);
    // 仅当组合编制确实声明了「前缀同名对象」（planner 派生视图）时才判定：
    if (!objectTypes.has(alias)) continue;
    if (!(rule.match?.object_types ?? []).includes(alias)) {
      findings.push({ ruleId: rule.rule_id, action, alias, bundleId });
    }
  }
}

// advisory：写类工具动作是否被任何规则覆盖（只读报告，不阻断）
const writeActions = new Set<string>();
for (const [, entry] of composed.presets) {
  for (const tool of entry.preset.tools ?? []) {
    if (tool.access === "write") writeActions.add(tool.name);
  }
}
const coveredActions = new Set<string>();
for (const { rule } of merged) for (const a of rule.match?.actions ?? []) coveredActions.add(a);
const uncoveredWriteActions = [...writeActions].filter((a) => !coveredActions.has(a)).sort();

const report = {
  primary: PRIMARY,
  bundles: assets.bundleIds,
  rules: merged.length,
  objectTypes: objectTypes.size,
  aliasFindings: findings,
  uncoveredWriteActions,
};

if (JSON_OUT) console.log(JSON.stringify(report, null, 2));
else {
  console.log(`围栏别名扫描：${PRIMARY} 组合（${assets.bundleIds.join(" + ")}）· 基线规则 ${merged.length} 条 · 对象 ${objectTypes.size} 类`);
  if (findings.length) {
    console.log(`✗ 对象别名缺口 ${findings.length} 处（G12 同类风险）：`);
    for (const f of findings) console.log(`  - ${f.ruleId}（${f.bundleId}）动作 ${f.action} 缺别名对象「${f.alias}」`);
  } else {
    console.log("✓ 无对象别名缺口（每条规则均覆盖其动作前缀对应的 planner 派生对象）");
  }
  if (uncoveredWriteActions.length) {
    console.log(`ℹ 写动作未经任何围栏覆盖 ${uncoveredWriteActions.length} 个（advisory）：${uncoveredWriteActions.join(", ")}`);
  }
}

process.exit(findings.length === 0 ? 0 : 1);
