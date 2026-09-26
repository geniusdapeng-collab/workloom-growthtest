#!/usr/bin/env node
/**
 * audit-fence-coverage.mts —— 围栏覆盖矩阵审计器（T-2026-0926-0117）
 *
 * 回答三个问题（只读，不改任何文件）：
 *   A. **写动作是否都有围栏**：遍历 `presets/*.yml` 里 `tools[].access === "write"` 的动作，
 *      检查该 bundle 的 `fences/*.yml` 是否有规则在 `match.actions` 里接住它；
 *      未覆盖 = 潜在绕过点（也可能是有意放行的本地动作，需人工裁定）。
 *   B. **管线门 × 围栏**：遍历 `pipelines/*.yml` 的 `gate:`，检查围栏里存在同号或同前缀规则
 *      （如 `G10` → `G10a..G10d`），不一致即登记。
 *   C. **管线门 × 门账本 step_key**：管线里带 `gate` 的 step_key 是否落在
 *      `packages/video-studio/src/gate-ledger.ts#PIPELINE_GATE_STEP_KEYS` 白名单内
 *      （不在白名单 = 平台/CLI 两侧都不会按 step_key 记账）。
 *
 * 用法：
 *   pnpm exec tsx scripts/tools/audit-fence-coverage.mts [--bundle ai-video|geo-growth|hotel|all]
 *     [--json] [--strict] [--out <path.md>]
 * 退出码：默认 0；`--strict` 且存在 A 类未覆盖动作时退出 1（B/C 类不阻断，仅登记）。
 */
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import YAML from "yaml";

import { actionMatches } from "../../packages/base/fence-engine/judge.js";

const ROOT = resolve(import.meta.dirname, "..", "..");
const BUNDLES = ["ai-video", "geo-growth", "hotel"] as const;
const arg = (name: string, fallback = ""): string => {
  const i = process.argv.indexOf(name);
  return i >= 0 ? (process.argv[i + 1] ?? fallback) : fallback;
};
const flag = (name: string): boolean => process.argv.includes(name);

/** 门账本白名单（从 video-studio 源码里读，避免手工抄写漂移） */
function gateLedgerStepKeys(): string[] {
  const src = readFileSync(join(ROOT, "packages/video-studio/src/gate-ledger.ts"), "utf8");
  const block = /PIPELINE_GATE_STEP_KEYS\s*=\s*\[([\s\S]*?)\]\s*as const/.exec(src);
  if (!block) return [];
  return [...block[1].matchAll(/"([^"]+)"/g)].map((m) => m[1]!);
}

interface FenceRule {
  rule_id?: string;
  id?: string;
  name?: string;
  level?: string;
  match?: { object_types?: string[]; actions?: string[] };
}

interface BundleAudit {
  bundle: string;
  uncoveredActions: Array<{ action: string; presets: string[] }>;
  /**
   * 仅由"宽口径"动作词命中（动词段匹配 / 命名空间后缀匹配，HP-02 DSL ②③）：
   * 规则命中，但不是精确字面值——审计时需确认这是有意的域级覆盖。
   */
  broadMatchActions: Array<{ action: string; presets: string[]; ruleActions: string[]; ruleIds: string[] }>;
  autoOnlyActions: Array<{ action: string; ruleIds: string[] }>;
  coveredActions: number;
  writeActions: number;
  defaultLevels: string[];
  gateMismatches: Array<{ pipeline: string; gate: string; note: string }>;
  gateLedgerMismatches: Array<{ pipeline: string; stepKey: string; gate: string }>;
}

function listFiles(dir: string, suffix: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((f) => f.endsWith(suffix)).map((f) => join(dir, f));
}

function auditBundle(bundle: string): BundleAudit {
  const base = join(ROOT, "bundles", bundle);
  // 1) 围栏规则
  const rules: Array<FenceRule & { file: string }> = [];
  for (const file of listFiles(join(base, "fences"), ".yml")) {
    const doc = YAML.parse(readFileSync(file, "utf8")) as { rules?: FenceRule[] } | null;
    for (const rule of doc?.rules ?? []) rules.push({ ...rule, file });
  }
  const actionIndex = new Map<string, Array<{ id: string; level: string }>>();
  const allRuleActions = new Set<string>();
  for (const rule of rules) {
    const id = rule.rule_id ?? rule.id ?? "?";
    for (const action of rule.match?.actions ?? []) {
      allRuleActions.add(action);
      const list = actionIndex.get(action) ?? [];
      list.push({ id, level: String(rule.level ?? "?") });
      actionIndex.set(action, list);
    }
  }

  // 2) preset 写动作
  const writeActions = new Map<string, Set<string>>();
  for (const file of listFiles(join(base, "presets"), ".yml")) {
    const doc = YAML.parse(readFileSync(file, "utf8")) as {
      preset_key?: string;
      tools?: Array<{ name?: string; access?: string }>;
    } | null;
    const key = doc?.preset_key ?? file.split("/").pop()!.replace(".yml", "");
    for (const tool of doc?.tools ?? []) {
      if (tool?.access !== "write" || !tool.name) continue;
      const owners = writeActions.get(tool.name) ?? new Set<string>();
      owners.add(key);
      writeActions.set(tool.name, owners);
    }
  }

  const uncoveredActions: BundleAudit["uncoveredActions"] = [];
  const broadMatchActions: BundleAudit["broadMatchActions"] = [];
  const autoOnlyActions: BundleAudit["autoOnlyActions"] = [];
  let coveredActions = 0;
  for (const [action, owners] of [...writeActions.entries()].sort()) {
    // 用**围栏引擎的真实匹配语义**判定（精确 / 动词段 / 命名空间后缀，HP-02 DSL）
    const exact = actionIndex.get(action) ?? [];
    const broad = [...allRuleActions]
      .filter((ra) => ra !== action && actionMatches(ra, action, "write"))
      .flatMap((ra) => (actionIndex.get(ra) ?? []).map((h) => ({ ruleAction: ra, id: h.id, level: h.level })));
    if (exact.length === 0 && broad.length > 0) {
      broadMatchActions.push({
        action,
        presets: [...owners].sort(),
        ruleActions: [...new Set(broad.map((b) => b.ruleAction))].sort(),
        ruleIds: [...new Set(broad.map((b) => b.id))],
      });
      coveredActions += 1;
    } else if (exact.length === 0) {
      uncoveredActions.push({ action, presets: [...owners].sort() });
    } else {
      coveredActions += 1;
      if (exact.every((h) => h.level === "auto")) {
        autoOnlyActions.push({ action, ruleIds: exact.map((h) => h.id) });
      }
    }
  }

  // 3) 管线门 × 围栏 / × 门账本
  const ruleIds = rules.map((r) => r.rule_id ?? r.id ?? "?");
  const ledgerKeys = new Set(gateLedgerStepKeys());
  const gateMismatches: BundleAudit["gateMismatches"] = [];
  const gateLedgerMismatches: BundleAudit["gateLedgerMismatches"] = [];
  for (const file of listFiles(join(base, "pipelines"), ".yml")) {
    const doc = YAML.parse(readFileSync(file, "utf8")) as {
      quest?: string;
      steps?: Array<{ step_key?: string; gate?: string }>;
    } | null;
    const pipeline = doc?.quest ?? file.split("/").pop()!.replace(".yml", "");
    for (const step of doc?.steps ?? []) {
      if (!step.gate) continue;
      const sameNumber = ruleIds.filter((id) => id === step.gate || id.startsWith(`${step.gate}-`) || id.startsWith(step.gate!));
      if (sameNumber.length === 0) {
        gateMismatches.push({ pipeline, gate: step.gate, note: "围栏中没有同号或同前缀规则" });
      } else if (!ruleIds.includes(step.gate)) {
        gateMismatches.push({ pipeline, gate: step.gate, note: `围栏拆分为：${sameNumber.join("/")}（管线只写总号）` });
      }
      if (step.step_key && !ledgerKeys.has(step.step_key) && /^g\d|^material-generate|^deliver|^revise/.test(step.step_key)) {
        gateLedgerMismatches.push({ pipeline, stepKey: step.step_key, gate: step.gate });
      }
    }
  }

  return {
    bundle,
    uncoveredActions,
    broadMatchActions,
    autoOnlyActions,
    coveredActions,
    writeActions: writeActions.size,
    defaultLevels: defaultLevelsOf(base),
    gateMismatches,
    gateLedgerMismatches,
  };
}

/** 读取该 bundle 下所有围栏 файл 的 default_level（判定未命中写动作的兜底级别） */
function defaultLevelsOf(base: string): string[] {
  const levels = new Set<string>();
  for (const file of listFiles(join(base, "fences"), ".yml")) {
    const m = /^default_level:\s*(\S+)/m.exec(readFileSync(file, "utf8"));
    if (m) levels.add(m[1]!);
  }
  return [...levels].sort();
}

const bundleArg = arg("--bundle", "all");
const targets = bundleArg === "all" ? [...BUNDLES] : [bundleArg as (typeof BUNDLES)[number]];
const audits = targets.map(auditBundle);
const ledgerKeys = gateLedgerStepKeys();

if (flag("--json")) {
  console.log(JSON.stringify({ gateLedgerStepKeys: ledgerKeys, audits }, null, 2));
} else {
  console.log(`围栏覆盖矩阵审计（门账本白名单 ${ledgerKeys.length} 个 step_key）\n`);
  for (const a of audits) {
    console.log(`## ${a.bundle}`);
    console.log(
      `写动作 ${a.writeActions} 个：覆盖 ${a.coveredActions}（其中宽口径命中 ${a.broadMatchActions.length}）；`
      + `完全无规则 ${a.uncoveredActions.length}（未命中兜底 default_level=${a.defaultLevels.join("/") || "?"}）；仅 auto 覆盖 ${a.autoOnlyActions.length}`,
    );
    if (a.broadMatchActions.length) {
      console.log("  ~ 宽口径命中（非精确字面值，按 HP-02 DSL 动词段/命名空间后缀命中；需确认是有意的域级覆盖）：");
      for (const n of a.broadMatchActions) {
        console.log(`    - 工具 ${n.action}（${n.presets.join(", ")}） ⇢ 规则动作 ${n.ruleActions.join("/")}（${n.ruleIds.join("/")}）`);
      }
    }
    if (a.uncoveredActions.length) {
      console.log(`  ~ 完全无规则的写动作（未命中 → 按 default_level=${a.defaultLevels.join("/") || "?"} 保守处理，需确认是否有意如此）：`);
      for (const u of a.uncoveredActions) console.log(`    - ${u.action}  ← ${u.presets.join(", ")}`);
    }
    if (a.autoOnlyActions.length) {
      console.log("  ~ 仅 auto 覆盖（本地可逆动作？需确认）：");
      for (const u of a.autoOnlyActions.slice(0, 12)) console.log(`    - ${u.action}  ← ${u.ruleIds.join("/")}`);
      if (a.autoOnlyActions.length > 12) console.log(`    …（其余 ${a.autoOnlyActions.length - 12} 项见 --json）`);
    }
    if (a.gateMismatches.length) {
      console.log("  ! 管线门 × 围栏不一致：");
      for (const g of a.gateMismatches) console.log(`    - ${g.pipeline} gate=${g.gate}：${g.note}`);
    }
    if (a.gateLedgerMismatches.length) {
      console.log("  ! 管线门 × 门账本白名单不一致：");
      for (const g of a.gateLedgerMismatches) console.log(`    - ${g.pipeline} step=${g.stepKey} gate=${g.gate}`);
    }
    console.log("");
  }
}

const outPath = arg("--out", "");
if (outPath) {
  const lines = ["# 围栏覆盖矩阵（机检 · B 级）", "", `- 生成时间：${new Date().toISOString()}`, ""];
  for (const a of audits) {
    lines.push(
      `## ${a.bundle}`, "",
      `- 写动作 ${a.writeActions}；覆盖 ${a.coveredActions}（宽口径 ${a.broadMatchActions.length}）；完全无规则 ${a.uncoveredActions.length}；仅 auto ${a.autoOnlyActions.length}`,
      `- 未命中兜底 default_level：${a.defaultLevels.join(" / ") || "?"}`, "",
    );
    if (a.broadMatchActions.length) {
      lines.push("| 岗位工具动作 | 归属岗位 | 宽口径规则动作 | 规则号 |", "|---|---|---|---|");
      for (const n of a.broadMatchActions) {
        lines.push(`| \`${n.action}\` | ${n.presets.join(", ")} | ${n.ruleActions.join(" / ")} | ${n.ruleIds.join(" / ")} |`);
      }
      lines.push("");
    }
    if (a.uncoveredActions.length) {
      lines.push("| 未覆盖写动作 | 归属岗位 |", "|---|---|");
      for (const u of a.uncoveredActions) lines.push(`| \`${u.action}\` | ${u.presets.join(", ")} |`);
      lines.push("");
    }
    if (a.gateMismatches.length) {
      lines.push("| 管线 | 门 | 说明 |", "|---|---|---|");
      for (const g of a.gateMismatches) lines.push(`| ${g.pipeline} | ${g.gate} | ${g.note} |`);
      lines.push("");
    }
  }
  writeFileSync(outPath, lines.join("\n"), "utf8");
  console.log(`written: ${outPath}`);
}

const uncoveredTotal = audits.reduce((sum, a) => sum + a.uncoveredActions.length, 0);
process.exit(flag("--strict") && uncoveredTotal > 0 ? 1 : 0);
