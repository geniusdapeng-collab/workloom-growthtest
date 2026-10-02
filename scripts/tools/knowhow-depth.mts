#!/usr/bin/env node
/**
 * knowhow-depth · 行业 knowhow 深度校验器（《GROWTH 深度产品方案》§5.1/§5.3 的门禁化）
 *
 * 对获客用增自研域的 15 个技能逐项校验"五维 + 评测覆盖"：
 *   ① 决策原则 ≥3 条（含阈值/失败关闭语义）；
 *   ② 打法库 ≥3 条（≥1 主线 + ≥2 分支）；
 *   ③ SOP ≥3 步（每步含"回执"与"失败"路径）；
 *   ④ 关键指标表 ≥4 行（基准/阈值列存在）；
 *   ⑤ 失败模式表 ≥3 行（检测器/处置列存在）；
 *   ⑥ 评测覆盖：该技能名出现在至少 1 道考题 tags 中。
 * 任一不达标即非 0 退出（CI test-gate 已接入）。
 *
 * 运行：pnpm scan:knowhow [--json]
 */
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dirname, "..", "..");
const BUNDLE = join(ROOT, "bundles", "geo-growth");
const JSON_OUT = process.argv.includes("--json");

/** 获客用增自研域 15 技能（双域 6 + 获客用增 9；视觉栈 14 技能属另一册，另行审计） */
const SKILLS = [
  "geo-query-craft", "ai-answer-rewrite", "visibility-monitor",
  "citation-reverse", "entity-consistency-check", "dual-entry-inquiry",
  "budget-portfolio", "experiment-design", "growth-review",
  "incrementality-measurement", "lead-scoring", "lifecycle-growth",
  "live-commerce", "growth-partnership", "cro-playbook",
];

interface SkillScore {
  skill: string;
  principles: number;
  plays: number;
  branches: number;
  sopSteps: number;
  kpiRows: number;
  failureRows: number;
  covered: boolean;
  ok: boolean;
  issues: string[];
}

function section(text: string, heading: string): string {
  const start = text.indexOf(heading);
  if (start < 0) return "";
  const rest = text.slice(start + heading.length);
  const next = rest.search(/^## /m);
  return next >= 0 ? rest.slice(0, next) : rest;
}

function tableRows(block: string): number {
  return block.split("\n").filter((l) => /^\|/.test(l.trim()) && !/^\|\s*-+/.test(l.trim()) && !/指标 \|/.test(l)).length;
}

const tags = new Set<string>(
  (JSON.parse(readFileSync(join(BUNDLE, "eval", "questions.json"), "utf8")) as {
    questions: Array<{ tags?: string[] }>;
  }).questions.flatMap((q) => q.tags ?? []),
);

const scores: SkillScore[] = [];
for (const skill of SKILLS) {
  const p = join(BUNDLE, "skills", skill, "SKILL.md");
  const issues: string[] = [];
  if (!existsSync(p)) {
    scores.push({ skill, principles: 0, plays: 0, branches: 0, sopSteps: 0, kpiRows: 0, failureRows: 0, covered: false, ok: false, issues: ["技能文件缺失"] });
    continue;
  }
  const text = readFileSync(p, "utf8");
  const principles = (section(text, "## 决策原则").match(/^\d+\.\s/gm) ?? []).length;
  const playsBlock = section(text, "## 打法库");
  const plays = (playsBlock.match(/^-\s/gm) ?? []).length;
  const branches = (playsBlock.match(/\*\*分支/g) ?? []).length;
  const sopBlock = section(text, "## SOP");
  const sopLines = sopBlock.split("\n").filter((l) => /^\d+\.\s/.test(l));
  const sopSteps = sopLines.filter((l) => l.includes("回执") && l.includes("失败")).length;
  const kpiBlock = section(text, "## 关键指标");
  const kpiRows = tableRows(kpiBlock);
  const failureBlock = section(text, "## 失败模式");
  const failureRows = tableRows(failureBlock);
  const covered = tags.has(skill);
  if (principles < 3) issues.push(`决策原则 ${principles} < 3`);
  if (plays < 3 || branches < 2) issues.push(`打法库 ${plays} 条 / 分支 ${branches} < 2`);
  if (sopSteps < 3) issues.push(`SOP 带回执与失败路径的步骤 ${sopSteps} < 3`);
  if (kpiRows < 4) issues.push(`关键指标 ${kpiRows} 行 < 4`);
  if (failureRows < 3) issues.push(`失败模式 ${failureRows} 行 < 3`);
  if (!covered) issues.push("评测覆盖：考题 tags 未出现该技能名");
  scores.push({ skill, principles, plays, branches, sopSteps, kpiRows, failureRows, covered, ok: issues.length === 0, issues });
}

const failed = scores.filter((s) => !s.ok);
if (JSON_OUT) console.log(JSON.stringify({ scope: SKILLS.length, scores }, null, 2));
else {
  console.log(`knowhow 深度校验：${SKILLS.length} 个技能（获客用增自研域）`);
  for (const s of scores) {
    console.log(
      `${s.ok ? "✓" : "✗"} ${s.skill.padEnd(28)} 原则 ${s.principles} · 打法 ${s.plays}(分支 ${s.branches}) · SOP ${s.sopSteps} · KPI ${s.kpiRows} · 失败模式 ${s.failureRows} · 评测 ${s.covered ? "✓" : "✗"}`
      + (s.issues.length ? `  ← ${s.issues.join("；")}` : ""),
    );
  }
  console.log(failed.length ? `\n✗ ${failed.length} 个技能未达标` : "\n✓ 15 技能五维齐全且评测覆盖达标");
}
process.exit(failed.length === 0 ? 0 : 1);
