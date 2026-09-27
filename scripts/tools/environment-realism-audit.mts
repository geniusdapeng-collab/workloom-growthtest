#!/usr/bin/env tsx
/**
 * environment-realism-audit.mts —— 环境真实性审计（确定性，零 token）
 *
 * 2026-09-27 真机事故：8 镜全部通过监制，但产品所有者一眼看出"空间布景不像实拍"。
 * 逐镜取证发现 8/8 镜缺"空间实指"与"使用痕迹"、7/8 镜灯光只有柔光箱/反光板这类棚具语言、
 * 材质全部停留在一级名词——本工具把这几件事变成**渲染前就能判红**的确定性规则，
 * 避免"渲完才发现不像实拍"（重渲 + 重后期）。
 *
 * 用法：
 *   tsx scripts/tools/environment-realism-audit.mts --shots <shotlist.json> [--scene-bible <bible.json>]
 *     [--expand] [--json] [--report <path>] [--accept-soft]
 *
 * 退出码：0=无硬缺陷；1=有硬缺陷（阻断渲染）；2=用法/文件错误。
 * 报告：默认写到 `<shotlist 同目录>/env-realism-report.json`。
 *
 * 说明：
 *   · `--scene-bible` 用于**圣经与镜头卡分开维护**的团队（圣经进设计稿库、镜头卡按镜头生成）；
 *     不给时按 shotlist 顶层 `sceneBible` 取（与 `full-chain-film.mts` 同口径）；
 *   · `--expand` 按**管线的真实口径**先把圣经展开进每镜字段再审计（= `full-chain-film.mts` 的判据）；
 *     不带它则审计**镜头卡原文**——这正是"改造前取证"要看的形态（圣经写了、卡里没带 = 模型只收到空词）。
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import {
  DEVICE_POLICY_VERIFIED_AT,
  DEVICE_POLICY_VERSION,
  allowedModelSummary,
  deviceDefects,
  environmentDefects,
  expandShotWithBible,
  summarizeDeviceDefects,
  summarizeDefects,
  validateSceneBible,
  type DeviceShotFields,
  type EnvShotFields,
  type SceneBible,
} from "../../packages/video-studio/src/index.js";

const args = process.argv.slice(2);
const value = (name: string, fallback = ""): string => {
  const index = args.indexOf(name);
  return index >= 0 ? (args[index + 1] ?? fallback) : fallback;
};
const flag = (name: string): boolean => args.includes(name);

const shotsArg = value("--shots");
if (!shotsArg) {
  console.error("用法：tsx scripts/tools/environment-realism-audit.mts --shots <shotlist.json> [--json] [--report <path>]");
  process.exit(2);
}
const shotsPath = isAbsolute(shotsArg) ? shotsArg : resolve(process.cwd(), shotsArg);
if (!existsSync(shotsPath)) {
  console.error(`找不到镜头卡：${shotsPath}`);
  process.exit(2);
}

const shotlist = JSON.parse(readFileSync(shotsPath, "utf8")) as {
  projectId?: string;
  title?: string;
  sceneBible?: SceneBible;
  shots?: EnvShotFields[];
};
const shots = shotlist.shots ?? [];
if (shots.length === 0) {
  console.error("镜头卡里没有 shots[]");
  process.exit(2);
}
const bibleArg = value("--scene-bible");
const sceneBiblePath = bibleArg ? (isAbsolute(bibleArg) ? bibleArg : resolve(process.cwd(), bibleArg)) : "";
if (sceneBiblePath && !existsSync(sceneBiblePath)) {
  console.error(`找不到场景圣经：${sceneBiblePath}`);
  process.exit(2);
}
const bible = sceneBiblePath
  ? (JSON.parse(readFileSync(sceneBiblePath, "utf8")) as SceneBible)
  : (shotlist.sceneBible ?? null);

/**
 * 审计对象：默认是**镜头卡原文**（改造前取证口径）；`--expand` 时按管线真实口径先展开圣经。
 * 两种口径的差别就是"圣经写了但卡里没带"这一真机形态——展开前判红、展开后应清零。
 */
const auditedShots: EnvShotFields[] = flag("--expand") && bible
  ? shots.map((shot) => expandShotWithBible(shot as EnvShotFields & Record<string, unknown>, bible))
  : shots;
const defects = environmentDefects(auditedShots, bible);
const summary = summarizeDefects(defects);
/** 设备口径（2026-09-27 产品所有者硬约束）：与环境审计合并——都是资产级硬约束，一份报告即可复核 */
const devDefectsList = deviceDefects(auditedShots as DeviceShotFields[]);
const devSummary = summarizeDeviceDefects(devDefectsList);
const combinedSummary = {
  hard: summary.hard + devSummary.hard,
  soft: summary.soft + devSummary.soft,
  byRule: { ...summary.byRule, ...devSummary.byRule },
};
const bibleIssues = bible ? validateSceneBible(bible) : [];
const perShot = auditedShots.map((shot) => {
  const own = [...defects, ...devDefectsList].filter((defect) => defect.shotId === shot.shotId);
  return {
    shotId: String(shot.shotId ?? "?"),
    hard: own.filter((defect) => defect.hard).length,
    soft: own.filter((defect) => !defect.hard).length,
    rules: own.map((defect) => `${defect.rule}${defect.hard ? "" : "(软)"}`),
    detail: own.map((defect) => defect.detail),
  };
});

const report = {
  schemaVersion: "workloom.env-realism-report/v1",
  generatedAt: new Date().toISOString(),
  shotlist: shotsPath,
  mode: flag("--expand") ? "expanded" : "raw",
  projectId: shotlist.projectId ?? null,
  sceneBible: bible ? { spaceId: bible.spaceId, issues: bibleIssues } : null,
  summary: combinedSummary,
  environment: summary,
  devicePolicy: { version: DEVICE_POLICY_VERSION, verifiedAt: DEVICE_POLICY_VERIFIED_AT, ...devSummary },
  perShot,
  defects: [...defects, ...devDefectsList],
};

const reportPath = value("--report") || join(dirname(shotsPath), "env-realism-report.json");
writeFileSync(reportPath, JSON.stringify(report, null, 2), "utf8");

if (flag("--json")) {
  console.log(JSON.stringify(report, null, 2));
} else {
  console.log(`═══ 环境真实性审计 · ${shotlist.title ?? shotlist.projectId ?? shotsPath} ═══`);
  console.log(bible
    ? `场景圣经：${bible.spaceId}（材质 ${bible.materials?.length ?? 0} · 实用光源 ${bible.practicalLights?.length ?? 0} · 使用痕迹 ${bible.traces?.length ?? 0}）`
      + (bibleIssues.length ? `\n  ⚠ 圣经自身问题：${bibleIssues.join("；")}` : "")
    : "场景圣经：未提供（无法校验空间连续性与实指一致性；建议在 shotlist 顶层加 sceneBible）");
  for (const row of perShot) {
    const head = row.hard > 0 ? "✗" : "✓";
    console.log(`${head} ${row.shotId}：硬缺陷 ${row.hard} · 软提示 ${row.soft}${row.rules.length ? ` → ${row.rules.join("、")}` : ""}`);
    for (const detail of row.detail) console.log(`    · ${detail}`);
  }
  console.log(`\n规则统计：${Object.entries(summary.byRule).map(([rule, count]) => `${rule}×${count}`).join(" · ") || "无"}`);
  console.log(`环境规则：${Object.entries(summary.byRule).map(([rule, count]) => `${rule}×${count}`).join(" · ") || "无"}`);
  console.log(`设备口径（${DEVICE_POLICY_VERSION}，核对 ${DEVICE_POLICY_VERIFIED_AT}）：${Object.entries(devSummary.byRule).map(([rule, count]) => `${rule}×${count}`).join(" · ") || "无"}`);
  console.log(`合计：硬缺陷 ${combinedSummary.hard}（环境 ${summary.hard} + 设备 ${devSummary.hard}）· 软提示 ${combinedSummary.soft} ｜ 报告：${reportPath}`);
}

const softAccepted = flag("--accept-soft");
if (combinedSummary.hard > 0) {
  console.error(`⛔ 硬缺陷 ${combinedSummary.hard} 项（环境 ${summary.hard} + 设备口径 ${devSummary.hard}）：渲染前必须修复（或显式声明风险后人工放行）`);
  if (devSummary.hard > 0) console.error(`   设备口径修法：每镜补 devices[]（category + model）——裸词不算机型，可用机型见 ${allowedModelSummary()}`);
  process.exit(1);
}
if (combinedSummary.soft > 0 && !softAccepted) {
  console.log(`ℹ 软提示 ${combinedSummary.soft} 项：建议修（不阻断渲染；--accept-soft 可静默）`);
}
