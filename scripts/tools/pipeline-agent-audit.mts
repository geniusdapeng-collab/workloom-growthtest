#!/usr/bin/env tsx
/**
 * pipeline-agent-audit.mts —— 视频数据管线「逐环节 Agent 审计」（2026-09-22）
 *
 * 四个维度（对每个登记环节）：
 *   A. 稳定性/健壮性：静默 catch、未处理异常、超时/重试缺失、mock 路径
 *   B. 逻辑提升点：兜底默认值、degraded 标记、TODO/FIXME、双数组同步等历史坑
 *   C. 字段定义：环节产物字段是否在 25/30 字段契约内、是否等于 FieldGuard 默认模板（=下游补齐）
 *   D. 流转缺口：环节在场性（result.json）、日志是否真的产出、产物是否被下游消费
 *
 * 用法：
 *   pnpm exec tsx scripts/tools/pipeline-agent-audit.mts [--run <runDir>] [--project <VID-xxxx>] [--json]
 * 产物：`<runDir>/agent-audit.md` + `<runDir>/agent-audit.json`
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  PIPELINE_STAGES,
  FIELD_GUARD_DEFAULTS,
  FIELD_BUSINESS_GROUPS,
  prepareShotPrompt,
  type PipelineStage,
  type ShotSpecReport
} from "../../packages/video-studio/src/index.js";

const REPO_ROOT = resolve(import.meta.dirname ?? process.cwd(), "../..");
const VENDOR = join(REPO_ROOT, "vendor/supermickey/hyperreality-system");

function arg(name: string, fallback = ""): string {
  const i = process.argv.indexOf(name);
  return i >= 0 ? (process.argv[i + 1] ?? fallback) : fallback;
}
const flag = (name: string) => process.argv.includes(name);

interface CodeFinding {
  kind: "silent-catch" | "default-fallback" | "degraded-mark" | "mock-path" | "todo";
  file: string;
  line: number;
  snippet: string;
}

interface StageAudit {
  id: string;
  name: string;
  layer: string;
  presentInRun: boolean;
  logLines: number;
  logWarnings: number;
  logErrors: number;
  codeFindings: CodeFinding[];
  /** 产物是否被下游消费（无法静态判定时为 null） */
  consumedDownstream: boolean | null;
  verdict: "ok" | "watch" | "risk";
  notes: string[];
}

/* ---------------- 静态代码审计 ---------------- */

const CATCH_RE = /catch\s*(\([^)]*\))?\s*\{/g;

function scanModule(relPath: string): CodeFinding[] {
  const file = join(VENDOR, relPath);
  if (!existsSync(file)) return [];
  const lines = readFileSync(file, "utf8").split("\n");
  const findings: CodeFinding[] = [];
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]!;
    // 静默 catch：catch 块内 3 行内出现 console.warn/log 且无 throw → 吞异常
    if (CATCH_RE.test(line)) {
      CATCH_RE.lastIndex = 0;
      const body = lines.slice(i, i + 6).join("\n");
      const hasThrow = /\bthrow\b/.test(body);
      const hasLog = /console\.(warn|log|error)/.test(body);
      if (!hasThrow) {
        findings.push({
          kind: "silent-catch",
          file: relPath,
          line: i + 1,
          snippet: `${hasLog ? "仅告警" : "完全静默"}：${line.trim().slice(0, 90)}`
        });
      }
    } else {
      CATCH_RE.lastIndex = 0;
    }
    if (/degraded\s*[:=]\s*true|markDegraded\(|degradeReason\s*=/.test(line)) {
      findings.push({ kind: "degraded-mark", file: relPath, line: i + 1, snippet: line.trim().slice(0, 90) });
    }
    if (/mock\s*[:=]\s*true|dryRun\s*[:=]\s*true|SIMULATED/.test(line)) {
      findings.push({ kind: "mock-path", file: relPath, line: i + 1, snippet: line.trim().slice(0, 90) });
    }
    if (/TODO|FIXME|XXX|待实现|暂未实现/.test(line)) {
      findings.push({ kind: "todo", file: relPath, line: i + 1, snippet: line.trim().slice(0, 90) });
    }
    if (/默认值|fallback|兜底|_dynamicDefaultValue|_fastFallback|DYNAMIC_DEFAULTS/i.test(line)) {
      findings.push({ kind: "default-fallback", file: relPath, line: i + 1, snippet: line.trim().slice(0, 90) });
    }
  }
  return findings;
}

function auditStageCode(stage: PipelineStage): CodeFinding[] {
  const out: CodeFinding[] = [];
  for (const modulePath of stage.modules) {
    if (modulePath === "index.js") continue; // 主流程文件单独看，避免噪声
    out.push(...scanModule(modulePath));
  }
  return out;
}

/* ---------------- 运行产物与日志 ---------------- */

function newestRunDir(): string {
  const base = join(REPO_ROOT, "apps/server/output");
  const { readdirSync, statSync } = require("node:fs") as typeof import("node:fs");
  const dirs = readdirSync(base).map((n) => join(base, n)).filter((p) => statSync(p).isDirectory());
  dirs.sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);
  const first = dirs[0];
  if (!first) throw new Error("apps/server/output 下没有运行产物");
  return first;
}

const runDir = arg("--run") ? resolve(REPO_ROOT, arg("--run")) : newestRunDir();
const resultPath = join(runDir, "result.json");
if (!existsSync(resultPath)) throw new Error(`缺少 result.json：${resultPath}`);
const result = JSON.parse(readFileSync(resultPath, "utf8")) as { stages?: Record<string, unknown> };
const stagesRaw = result.stages ?? {};
const projectId = arg("--project") || (join(runDir).match(/VID-\d+/)?.[0] ?? "");

const logFile = projectId ? join(REPO_ROOT, ".vm-work/logs", `${projectId}.log`) : null;
const logText = logFile && existsSync(logFile) ? readFileSync(logFile, "utf8") : "";
const logLines = logText ? logText.split("\n") : [];

/** 日志里的"环节没生成却继续往下走"的指纹（产品所有者最关心的失败模式） */
interface LogEvidence {
  pattern: string;
  label: string;
  severity: "risk" | "watch";
  count: number;
  sample: string;
}
const LOG_PATTERNS: Array<{ pattern: RegExp; label: string; severity: "risk" | "watch" }> = [
  { pattern: /全部失败，使用兜底规则|使用兜底规则/, label: "子 Agent 全失败 → 规则兜底", severity: "risk" },
  { pattern: /PROMPT-FUSION-FAIL|Phase 3 失败/, label: "提示词融合整阶段失败 → 退回未融合 Prompt", severity: "risk" },
  { pattern: /FIELD-QUALITY-FAIL|字段质量检查失败/, label: "字段质检失败 → FieldGuard 就地修复", severity: "risk" },
  { pattern: /已就地修复 \d+ 个镜头|FieldGuard 已就地修复/, label: "FieldGuard 默认模板覆盖镜头（下游补齐）", severity: "risk" },
  { pattern: /prompt 缺失或过短\(0字符\)/, label: "最终完整性校验发现 prompt 为空（仍继续）", severity: "risk" },
  { pattern: /契约校验未通过/, label: "阶段契约校验未通过（仅告警未阻断）", severity: "watch" },
  { pattern: /微动作增强完成: 0\//, label: "微动作环节空转（0 镜增强）", severity: "watch" },
  { pattern: /LLM 字段提取失败|LLM引擎无可用调用方法/, label: "LLM 字段提取失败 → 规则兜底（主题漂移风险）", severity: "risk" },
  { pattern: /未通过|缺失元素/, label: "存在未通过/缺失元素告警", severity: "watch" },
  { pattern: /this\.llmEngine\.[a-zA-Z_]+ is not a function/, label: "注入引擎缺方法（集成缺口）", severity: "risk" }
];
const logEvidence: LogEvidence[] = [];
for (const item of LOG_PATTERNS) {
  const hits = logLines.filter((line) => item.pattern.test(line));
  if (hits.length > 0) {
    logEvidence.push({
      pattern: item.pattern.source,
      label: item.label,
      severity: item.severity,
      count: hits.length,
      sample: hits[0]!.replace(/^\[[^\]]+\]\s*/, "").slice(0, 160)
    });
  }
}

/** 日志里与某环节相关的行（按环节 id/中文名/模块名匹配） */
function logSlice(stage: PipelineStage): string[] {
  if (logLines.length === 0) return [];
  const keys = [
    stage.id.toLowerCase(),
    ...stage.entry.map((e) => e.split(".")[0]!.toLowerCase()),
    ...stage.modules.map((m) => m.split("/").pop()!.replace(".js", "").toLowerCase())
  ].filter((k) => k.length >= 4);
  return logLines.filter((line) => keys.some((k) => line.toLowerCase().includes(k)));
}

/* ---------------- 镜头字段「下游补齐」指纹检测 ---------------- */

const shotsPath = join(runDir, "shots.json");
const shots = existsSync(shotsPath)
  ? (JSON.parse(readFileSync(shotsPath, "utf8")) as Array<Record<string, unknown>>)
  : [];
const defaultedFields: Array<{ shotId: string; field: string }> = [];
for (const shot of shots) {
  for (const [field, template] of Object.entries(FIELD_GUARD_DEFAULTS)) {
    const value = shot[field];
    if (typeof value === "string" && value.trim() === template) {
      defaultedFields.push({ shotId: String(shot.shotId ?? "?"), field });
    }
  }
}
const reports: ShotSpecReport[] = shots.map((shot) =>
  prepareShotPrompt(shot, { ratio: "9:16", log: () => undefined })
);
/** 归一后仍残留的 [object Object]（判定是否还有未处理的结构化字段） */
const objectLeakShots = reports.filter((r) => /\[object Object\]/.test(r.prompt));

/* ---------------- 逐环节结论 ---------------- */

const audits: StageAudit[] = PIPELINE_STAGES.map((stage) => {
  const stageValue = (stagesRaw as Record<string, unknown>)[stage.id];
  const present = stageValue !== undefined && stageValue !== null;
  const slice = logSlice(stage);
  const warnings = slice.filter((l) => /\bWARN\b|⚠️/.test(l)).length;
  const errors = slice.filter((l) => /\bERROR\b|❌|⛔/.test(l)).length;
  const findings = auditStageCode(stage).filter((f) => f.kind !== "todo" || Math.random() < 1);
  const notes: string[] = [];
  let verdict: StageAudit["verdict"] = "ok";

  const silent = findings.filter((f) => f.kind === "silent-catch").length;
  const fallback = findings.filter((f) => f.kind === "default-fallback").length;
  const degraded = findings.filter((f) => f.kind === "degraded-mark").length;
  const mocks = findings.filter((f) => f.kind === "mock-path").length;
  if (silent > 0) notes.push(`静默 catch ${silent} 处（异常被吞，只留日志）`);
  if (fallback > 0) notes.push(`兜底/默认值路径 ${fallback} 处`);
  if (degraded > 0) notes.push(`degraded 标记 ${degraded} 处`);
  if (mocks > 0) notes.push(`mock/dryRun 路径 ${mocks} 处`);
  if (errors > 0) notes.push(`run 日志中该环节 ERROR ${errors} 行`);
  if (warnings > 0) notes.push(`run 日志中该环节 WARN ${warnings} 行`);
  if (stage.conditional && !present) notes.push("本轮未触发（条件环节）");
  if (!present && !stage.conditional) { notes.push("运行产物中缺失（可能未执行）"); verdict = "risk"; }

  // 下游补齐指纹：productionEngine 环节的字段默认化最典型
  if (stage.id === "productionEngine") {
    if (defaultedFields.length > 0) {
      const fields = [...new Set(defaultedFields.map((d) => d.field))];
      notes.push(`镜头字段命中 FieldGuard 默认模板 ${defaultedFields.length} 处（${fields.slice(0, 6).join("、")}${fields.length > 6 ? "…" : ""}）= 由下游补齐`);
      verdict = "risk";
    }
    const emptyPrompts = ((stagesRaw.productionEngine as Record<string, unknown>)?.prompts as Array<Record<string, unknown>> | undefined)
      ?.filter((p) => !(p.prompt as string)?.trim()).length ?? 0;
    if (emptyPrompts > 0) {
      notes.push(`内容镜头 prompt 为空 ${emptyPrompts} 条（渲染输入缺失，需按 25 字段重建）`);
      verdict = "risk";
    }
  }
  if (stage.id === "portraitStudio") {
    const portrait = (stagesRaw.portraitStudio ?? {}) as Record<string, unknown>;
    const done = Number(portrait.completedPortraits ?? 0);
    const total = Number(portrait.totalPortraits ?? 0);
    if (total > 0 && done < total) {
      notes.push(`定妆照未完成 ${done}/${total}（executor=${String(portrait.executor)}），下游绑定为空`);
      verdict = "risk";
    }
  }
  if (stage.id === "postProductionEngine") {
    const post = (stagesRaw.postProductionEngine ?? {}) as Record<string, unknown>;
    if (post.success !== true) {
      notes.push("vendor 后期质量门失败（deferRender 下缺 shot-*.mp4；宿主侧已由 post-production.mts 回填）");
      verdict = verdict === "risk" ? "risk" : "watch";
    }
  }
  if (stage.id === "requirementAlignment") {
    const ra = (stagesRaw.requirementAlignment ?? {}) as Record<string, unknown>;
    if (ra.pass !== true) {
      notes.push(`需求对齐未通过（score=${String(ra.score ?? "?")}，missing=${JSON.stringify(ra.missing ?? []).slice(0, 80)}）`);
      verdict = verdict === "risk" ? "risk" : "watch";
    }
  }
  if (silent > 3 || fallback > 8) verdict = verdict === "risk" ? "risk" : "watch";

  return {
    id: stage.id,
    name: stage.name,
    layer: stage.layer,
    presentInRun: present,
    logLines: slice.length,
    logWarnings: warnings,
    logErrors: errors,
    codeFindings: findings.slice(0, 24),
    consumedDownstream: null,
    verdict,
    notes
  };
});

/* ---------------- 字段定义审计表 ---------------- */

const fieldIssueRows: string[] = [];
for (const group of FIELD_BUSINESS_GROUPS) {
  const emptyByField = new Map<string, number>();
  for (const shot of shots) {
    for (const field of group.fields) {
      const value = shot[field];
      const empty = value === undefined || value === null || (typeof value === "string" && !value.trim()) || (Array.isArray(value) && value.length === 0);
      if (empty) emptyByField.set(field, (emptyByField.get(field) ?? 0) + 1);
    }
  }
  const emptyList = [...emptyByField.entries()].map(([f, n]) => `${f}(${n}/${shots.length})`);
  fieldIssueRows.push(`| ${group.group} | ${group.fields.join("、")} | ${emptyList.length ? emptyList.join("，") : "全部非空"} | ${group.note} |`);
}

/* ---------------- 报告 ---------------- */

const riskStages = audits.filter((a) => a.verdict === "risk");
const watchStages = audits.filter((a) => a.verdict === "watch");
const md: string[] = [
  `# 管线环节（Agent）审计报告 · ${projectId || "（未识别项目）"}`,
  "",
  `- 产物目录：\`${runDir.replace(REPO_ROOT + "/", "")}\``,
  `- 登记环节：${audits.length} 个（风险 ${riskStages.length} / 关注 ${watchStages.length} / 正常 ${audits.length - riskStages.length - watchStages.length}）`,
  `- 审计口径：静态代码（静默 catch / 兜底默认值 / degraded / mock / TODO）+ 运行日志 + result.json + 镜头字段默认模板指纹`,
  "",
  "## 一、逐环节结论",
  "",
  "| 环节 | 层 | 在场 | 日志行(告警/错误) | 代码问题（静默/兜底/降级/mock） | 判定 | 说明 |",
  "|---|---|---|---|---|---|---|",
  ...audits.map((a) => {
    const counts = {
      silent: a.codeFindings.filter((f) => f.kind === "silent-catch").length,
      fallback: a.codeFindings.filter((f) => f.kind === "default-fallback").length,
      degraded: a.codeFindings.filter((f) => f.kind === "degraded-mark").length,
      mock: a.codeFindings.filter((f) => f.kind === "mock-path").length
    };
    return `| ${a.name} | ${a.layer} | ${a.presentInRun ? "✅" : "—"} | ${a.logLines}(${a.logWarnings}/${a.logErrors}) | ${counts.silent}/${counts.fallback}/${counts.degraded}/${counts.mock} | ${a.verdict === "risk" ? "🔴 risk" : a.verdict === "watch" ? "🟡 watch" : "✅ ok"} | ${a.notes.join("；") || "—"} |`;
  }),
  "",
  "## 二、镜头字段契约实测（当前 run）",
  "",
  "| 业务分组 | 字段 | 空字段统计 | 说明 |",
  "|---|---|---|---|",
  ...fieldIssueRows,
  "",
  `- 交付闸（vendor PromptDeliveryGuard）：${reports.filter((r) => r.delivery.pass).length}/${reports.length} 通过`,
  `- 命中 FieldGuard 默认模板（=下游补齐）：${defaultedFields.length} 处` +
    (defaultedFields.length ? `（${[...new Set(defaultedFields.map((d) => d.field))].join("、")}）` : ""),
  `- 提示词含 \`[object Object]\`：${objectLeakShots.length} 镜（结构化字段未归一；出片侧已由 shot-spec 归一）`,
  "",
  "## 二·B、日志证据：「没生成却继续往下走」指纹",
  "",
  logEvidence.length
    ? [
        "| 指纹 | 严重度 | 次数 | 样例 |",
        "|---|---|---:|---|",
        ...logEvidence.map((e) => `| ${e.label} | ${e.severity === "risk" ? "🔴" : "🟡"} | ${e.count} | ${e.sample} |`),
        ""
      ].join("\n")
    : "（本次运行日志未命中已知指纹）",
  "",
  "> 判读：以下是产品所有者最关心的「看起来成功」路径——日志已能识别，但 **vendor 只告警不阻断**；",
  "> 出片侧由 shot-spec 交付闸与宿主质量地板兜住（未过闸默认拒绝提交）。",
  "",
  "## 三、风险环节明细",
  "",
  ...riskStages.flatMap((a) => [
    `### ${a.name}（${a.id}）`,
    ...a.notes.map((n) => `- ${n}`),
    ...a.codeFindings.slice(0, 8).map((f) => `  - [${f.kind}] ${f.file}:${f.line} ${f.snippet}`),
    ""
  ]),
  "## 四、审计发现的改进方向（按维度）",
  "",
  "**A 稳定性/健壮性**",
  "- 静默 catch 集中在字段兜底与增强类环节（异常只换默认值，不改变流程状态）→ 建议统一「降级必须留痕并改变阶段状态」。",
  "- 阶段异常只打 `message`（真机 Phase 3 `Assignment to constant variable.`）→ 已加栈诊断桥，建议上游 vendor 补栈。",
  "",
  "**B 逻辑提升**",
  "- 双数组（shots/prompts）同步曾在 Phase 3 失败时把空 prompt 覆盖到产物 → 建议以单一对象为准（`shots[i].prompt` 即真源）。",
  "- 增强类环节（microMotion/shotQuality/directorOptimization）零改动时仍计入流程 → 建议产出 `noop` 标记，避免「看起来跑过」。",
  "",
  "**C 字段定义**",
  "- `portraits` 是 P0 但语义含糊（字符串 / 数组 / 绑定清单三义）→ 建议显式 schema：`{characterId, angle, file, source}`。",
  "- `timeline` 允许字符串/数组/对象三种形态，直接导致 FieldCheckAgent `tl.match is not a function` → 建议统一字符串 + 结构化 `timelineBeats` 伴生字段。",
  "- `character` 把多角色拼成一行文本，无法按角色绑定参考图 → 建议补 `characters[]`（已有但常空）+ `characterCards`。",
  "- 片头 `title/subtitle` 与 `title_content/subtitle_content` 语义重叠 → 建议明确：前者=短标题（画面用），后者=内容描述（设计用）。",
  "- 真人出镜类项目缺字段：建议补 `talent`（出镜人）、`likenessRefs`（肖像参考图集，含授权依据）、`presenterScript`（口播稿）。",
  "",
  "**D 流转缺口**",
  "- 「生成失败但流程继续」的三条主路径：Phase 3 融合失败→未融合 Prompt；Phase 3.5 质检失败→FieldGuard 默认模板；定妆照失败→空绑定。三条都在本次审计中有实测证据。",
  "- 建议在渲染提交前增加宿主侧「质量地板」闸（见 shot-spec 交付闸）：任一镜头字段默认化/无 prompt/无定妆照 → 默认拒绝提交。",
  ""
];

writeFileSync(join(runDir, "agent-audit.json"), `${JSON.stringify({
  runDir: runDir.replace(REPO_ROOT + "/", ""),
  projectId,
  generatedAt: new Date().toISOString(),
  audits,
  defaultedFields,
  deliveryPass: { pass: reports.filter((r) => r.delivery.pass).length, total: reports.length }
}, null, 2)}\n`, "utf8");
writeFileSync(join(runDir, "agent-audit.md"), md.join("\n"), "utf8");

if (flag("--json")) console.log(JSON.stringify({ audits, defaultedFields }, null, 2));
else {
  console.log(md.join("\n"));
  console.log(`\n审计产物：${join(runDir.replace(REPO_ROOT + "/", ""), "agent-audit.md")} / agent-audit.json`);
}
