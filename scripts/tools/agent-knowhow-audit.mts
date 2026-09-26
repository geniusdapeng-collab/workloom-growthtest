#!/usr/bin/env node
/**
 * agent-knowhow-audit.mts —— 数字员工「配套技能行业 Know-How 结构」只读审计器（T-2026-0926-0101）
 *
 * 定位：把 `scripts/tools/knowhow-depth.mts`（只覆盖 geo-growth 15 个自研技能）扩展到
 * 三个行业包 + 包外官方技能，并按技能分型判定「结构等价」而不是「章节名一致」：
 *   S-A 经营/决策型：决策原则（含阈值/失败关闭）+ 打法库（主线+分支）+ SOP（触发/回执/失败）
 *                    + 关键指标（含基准/阈值/来源）+ 失败模式（症状→检测器→处置）
 *   S-B 制作/工艺型：工艺判据表（≥4 行）+ 参数边界（≥3 条）+ 失败模式（≥3 行）+ 输出契约
 *   S-C 工具/纪律型：前置校验（≥3）+ 失败诊断（≥3）+ 证据口径（≥2）+ 输出契约
 *
 * 分型规则：先看绑定岗位的 `kind`（research/analyst/content/orchestrator/reviewer → S-A；
 * operator/artist → S-B），无绑定或其它 kind 默认 S-C，`OVERRIDES` 可显式覆写。
 *
 * 纪律：本工具**只读**，默认不作为门禁（退出码 0）；`--strict` 时任一技能不达标即退出码 1。
 * 用法：
 *   pnpm exec tsx scripts/tools/agent-knowhow-audit.mts [--bundle ai-video|geo-growth|hotel|all]
 *     [--type S-A|S-B|S-C] [--skill <name>] [--json] [--md=<path>] [--strict]
 */
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import YAML from "yaml";

const ROOT = resolve(import.meta.dirname, "..", "..");
const BUNDLES = ["ai-video", "geo-growth", "hotel"] as const;
type Bundle = (typeof BUNDLES)[number];

const arg = (name: string, fallback = ""): string => {
  const i = process.argv.indexOf(name);
  return i >= 0 ? (process.argv[i + 1] ?? fallback) : fallback;
};
const flag = (name: string): boolean => process.argv.includes(name);

/** 显式分型覆写（默认按绑定岗位 kind 推导；这里放"岗位 kind 会误判"的技能） */
const OVERRIDES: Record<string, KnowhowType> = {
  "render-ops": "S-C",
  "publish-ops": "S-C",
  "delivery-package-ops": "S-C",
  "delivery-revision-ops": "S-C",
  "comment-ops": "S-C",
  "caption-burnin-ops": "S-C",
  "producer-gate-review": "S-C",
  "cinematography-kb": "S-B",
  "shot-prompt-craft": "S-B",
  // geo-growth 视觉栈属制作/工艺型（岗位 kind=content 会误判为 S-A）
  "art-direction": "S-B",
  "asset-variant-forge": "S-B",
  "brand-guard": "S-B",
  "compositor-designer": "S-B",
  "design-brief": "S-B",
  "design-critique": "S-B",
  "geo-answer-card": "S-B",
  "image-retouch": "S-B",
  "material-scout": "S-B",
  "moments-post": "S-B",
  "poster-series": "S-B",
  "product-poster": "S-B",
  "promo-banner": "S-B",
  "video-cover": "S-B",
  // 该技能已按 S-A 口径建设并通过 scripts/tools/knowhow-depth.mts
  "growth-partnership": "S-A",
  "lead-scoring": "S-A",
  "lifecycle-growth": "S-A",
  "live-commerce": "S-A",
};

type KnowhowType = "S-A" | "S-B" | "S-C";

interface SkillReport {
  bundle: string;
  skill: string;
  path: string;
  type: KnowhowType;
  boundPresets: string[];
  lines: number;
  metrics: Record<string, number | boolean>;
  issues: string[];
  /** 建议项：不影响达标判定（与既有 knowhow-depth 门禁口径保持可比），但在报告中可见 */
  warnings: string[];
  ok: boolean;
}

const KIND_TYPE: Record<string, KnowhowType> = {
  research: "S-A",
  analyst: "S-A",
  content: "S-A",
  orchestrator: "S-A",
  reviewer: "S-A",
  operator: "S-B",
  artist: "S-B",
};

function read(path: string): string {
  return readFileSync(path, "utf8");
}

/** 取 "## 标题" 区块（到下一个 "## " 为止） */
function section(text: string, heading: string): string {
  const start = text.indexOf(`## ${heading}`);
  if (start < 0) return "";
  const rest = text.slice(start + heading.length + 3);
  const next = rest.search(/^## /m);
  return next >= 0 ? rest.slice(0, next) : rest;
}

function firstSection(text: string, headings: string[]): { heading: string; body: string } {
  for (const h of headings) {
    const body = section(text, h);
    if (body) return { heading: h, body };
  }
  return { heading: "", body: "" };
}

/**
 * 语义区块查找（结构等价）：标题命中即可，兼容本仓两种写法——
 *   「## 工艺判据」 与 「## 二、时窗适配：语速是最后手段」
 */
function findSection(text: string, keywords: string[]): { heading: string; body: string } {
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i += 1) {
    const m = /^##\s+(.*)$/.exec(lines[i]!);
    if (!m) continue;
    const title = m[1] ?? "";
    if (!keywords.some((k) => title.includes(k))) continue;
    const body: string[] = [];
    for (let j = i + 1; j < lines.length; j += 1) {
      if (/^##\s/.test(lines[j]!)) break;
      body.push(lines[j]!);
    }
    return { heading: title, body: body.join("\n") };
  }
  return { heading: "", body: "" };
}

/** 所有命中标题的区块（结构等价：同一语义可能被多节承载，取最强的那节） */
function findAllSections(text: string, keywords: string[]): string[] {
  const lines = text.split("\n");
  const bodies: string[] = [];
  for (let i = 0; i < lines.length; i += 1) {
    const m = /^##\s+(.*)$/.exec(lines[i]!);
    if (!m) continue;
    if (!keywords.some((k) => (m[1] ?? "").includes(k))) continue;
    const body: string[] = [];
    for (let j = i + 1; j < lines.length; j += 1) {
      if (/^##\s/.test(lines[j]!)) break;
      body.push(lines[j]!);
    }
    bodies.push(body.join("\n"));
  }
  return bodies;
}

/** 语义区块计量：取所有命中区块中的最大值（表行数 / 条目数），并返回合并正文供语义判定 */
function sectionMetrics(text: string, keywords: string[]): { rows: number; items: number; merged: string } {
  let rows = 0;
  let items = 0;
  const bodies = findAllSections(text, keywords);
  for (const body of bodies) {
    rows = Math.max(rows, tableRows(body));
    items = Math.max(items, numbered(body) + bullets(body));
  }
  return { rows, items, merged: bodies.join("\n") };
}

/** 量化阈值行数：含比较符或带单位的数值（判据"可判定"的最低证据） */
function quantifiedLines(text: string): number {
  const ROW = /(≤|≥|<|>|不超过|小于|大于)\s*\d|\d+(\.\d+)?\s*(%|dB|dBTP|LUFS|ms|毫秒|秒|s\b|×|°|字|行|条|像素|px|K|kbps)/;
  return text.split("\n").filter((l) => {
    const t = l.trim();
    if (!t || /^\|\s*-+/.test(t)) return false;
    return ROW.test(t);
  }).length;
}

/** 禁止/红线类表述行数（参数边界的可判定形式之一） */
function prohibitionLines(text: string): number {
  return text
    .split("\n")
    .map((l) => l.trim())
    .filter((t) => t && !/^\|\s*-+/.test(t))
    .filter((t) => /禁止|不得|硬红线|红线|一票否决|必须|拒绝|fail-closed|失败关闭/.test(t)).length;
}

const numbered = (block: string): number => (block.match(/^\d+\.\s/gm) ?? []).length;
const bullets = (block: string): number => (block.match(/^-\s/gm) ?? []).length;
const branches = (block: string): number => (block.match(/\*\*分支/g) ?? []).length;
function tableRows(block: string): number {
  const rows = block.split("\n").map((l) => l.trim()).filter((l) => l.startsWith("|"));
  let count = 0;
  for (let i = 0; i < rows.length; i += 1) {
    if (/^\|\s*-+/.test(rows[i]!)) continue; // 分隔行
    if (i + 1 < rows.length && /^\|\s*-+/.test(rows[i + 1]!)) continue; // 表头行（下一行是分隔行）
    count += 1;
  }
  return count;
}

/** 收集某技能被哪些 preset 绑定 + 这些 preset 的 kind */
function bindingIndex(): Map<string, { presets: string[]; kinds: Set<string> }> {
  const index = new Map<string, { presets: string[]; kinds: Set<string> }>();
  for (const b of BUNDLES) {
    const dir = join(ROOT, "bundles", b, "presets");
    if (!existsSync(dir)) continue;
    for (const f of readdirSync(dir)) {
      if (!f.endsWith(".yml")) continue;
      const doc = YAML.parse(read(join(dir, f))) as {
        preset_key?: string;
        kind?: string;
        skills?: unknown;
      } | null;
      const key = doc?.preset_key ?? f.replace(/\.yml$/, "");
      const kind = typeof doc?.kind === "string" ? doc.kind : "";
      const raw = Array.isArray(doc?.skills) ? doc!.skills : [];
      for (const s of raw) {
        const name = String(s);
        const entry = index.get(name) ?? { presets: [], kinds: new Set<string>() };
        entry.presets.push(key);
        if (kind) entry.kinds.add(kind);
        index.set(name, entry);
      }
    }
  }
  return index;
}

function resolveType(skill: string, kinds: Set<string>): KnowhowType {
  const override = OVERRIDES[skill];
  if (override) return override;
  const mapped = [...kinds].map((k) => KIND_TYPE[k]).filter(Boolean) as KnowhowType[];
  if (mapped.includes("S-A")) return "S-A";
  if (mapped.includes("S-B")) return "S-B";
  return "S-C";
}

function auditSkill(bundle: string, skill: string, path: string, bindings: Map<string, { presets: string[]; kinds: Set<string> }>): SkillReport {
  const text = read(path);
  const bound = bindings.get(skill) ?? { presets: [], kinds: new Set<string>() };
  const type = resolveType(skill, bound.kinds);
  const issues: string[] = [];
  const warnings: string[] = [];
  const metrics: Record<string, number | boolean> = {};

  const hasScene = Boolean(firstSection(text, ["适用场景", "触发条件"]).body);
  metrics["适用场景"] = hasScene;
  if (!hasScene) warnings.push("缺「适用场景/触发条件」");

  const contract = Boolean(firstSection(text, ["输出契约", "交付契约"]).body);
  metrics["输出契约"] = contract;
  if (!contract) warnings.push("缺「输出契约/交付契约」");

  if (type === "S-A") {
    const principles = firstSection(text, ["决策原则", "决策原则（含阈值与失败关闭）"]).body;
    const nPrinciples = numbered(principles) + bullets(principles);
    metrics["决策原则"] = nPrinciples;
    if (nPrinciples < 3) issues.push(`决策原则 ${nPrinciples} < 3`);

    const plays = firstSection(text, ["打法库", "打法库（场景 → 动作序列 → 判据）"]).body;
    const nPlays = bullets(plays);
    const nBranches = branches(plays);
    metrics["打法库"] = nPlays;
    metrics["分支"] = nBranches;
    if (nPlays < 3 || nBranches < 2) issues.push(`打法库 ${nPlays} 条 / 分支 ${nBranches} < 2`);

    const sop = firstSection(text, ["SOP", "SOP（每步带触发/回执/失败路径）"]).body;
    const sopSteps = sop.split("\n").filter((l) => /^\d+\.\s/.test(l));
    const nSop = sopSteps.filter((l) => l.includes("回执") && l.includes("失败")).length;
    metrics["SOP"] = nSop;
    if (nSop < 3) issues.push(`SOP 带回执与失败路径的步骤 ${nSop} < 3`);

    const kpi = firstSection(text, ["关键指标", "关键指标（含基准与护栏）"]).body;
    const nKpi = tableRows(kpi);
    metrics["关键指标"] = nKpi;
    if (nKpi < 4) issues.push(`关键指标 ${nKpi} 行 < 4`);
    if (kpi && !kpi.includes("来源")) warnings.push("关键指标缺「来源」列（建议补齐阈值来源）");

    const fail = firstSection(text, ["失败模式", "失败模式（症状 → 检测器 → 处置）"]).body;
    const nFail = tableRows(fail);
    metrics["失败模式"] = nFail;
    if (nFail < 3) issues.push(`失败模式 ${nFail} 行 < 3`);
  } else if (type === "S-B") {
    // 结构等价：判据 = 语义区块内的表格/条目数，与全文量化阈值行数取大者
    // （本仓工艺型技能常用「目标值表 / 配方 / 版式表 / 时窗适配」等命名承载判据）
    const craftMetrics = sectionMetrics(text, [
      "工艺判据", "判据", "工艺", "参数", "手法", "目标值", "参数表", "配方",
      "规格", "版式", "选型", "策略", "口径", "适配", "同步", "决策", "判定", "问清",
    ]);
    const nCraft = Math.max(craftMetrics.rows, craftMetrics.items, quantifiedLines(text));
    metrics["工艺判据"] = nCraft;
    if (nCraft < 4) issues.push(`工艺判据 ${nCraft} < 4`);

    // 结构等价：本仓常用「硬红线 / 红线 / 纪律 / 禁忌」表达参数边界
    const boundaryMetrics = sectionMetrics(text, ["参数边界", "边界", "硬红线", "红线", "纪律", "限制", "禁用", "禁忌"]);
    const nBoundary = Math.max(boundaryMetrics.items, prohibitionLines(text));
    metrics["边界"] = nBoundary;
    if (nBoundary < 3) issues.push(`参数边界 ${nBoundary} < 3`);

    // 结构等价：本仓常用「常见翻车 / 翻车 / 故障 / 异常处置」表达失败模式
    const failMetrics = sectionMetrics(text, ["失败", "翻车", "故障", "异常", "不达标", "回退", "不可修复", "返工", "拒绝", "否决", "处置", "红线"]);
    const nFail = failMetrics.rows;
    metrics["失败模式"] = nFail;
    if (nFail < 3) {
      // 允许以带"检测器/处置"语义的条目列表表达（脚本化判定兜底）
      const nItems = failMetrics.items;
      metrics["失败模式"] = nItems;
      if (nItems < 3) issues.push(`失败模式 ${nFail} 行 / 条目 ${nItems} < 3`);
    }
  } else {
    /**
     * S-C 工具/纪律型（含酒店值守模板的结构等价）：
     *   前置校验 ← 前置校验/SOP/触发条件/输入数据/方法/校验/检查/清单/口径
     *   失败诊断 ← 失败/异常/处置/红线/验收用例/边界/围栏绑定（需含"异常路径/block/未核实"语义）
     *   证据口径 ← 证据/留痕/回执/输出动作/输出契约/事件
     */
    const preMetrics = sectionMetrics(text, [
      "前置校验", "SOP", "触发条件", "校验", "检查", "发布包", "复检", "核对",
      "清单", "交付前", "交付", "口径", "影响", "输入数据", "方法", "输入",
    ]);
    const nPre = Math.max(preMetrics.items, prohibitionLines(text));
    metrics["前置校验"] = nPre;
    if (nPre < 3) issues.push(`前置校验 ${nPre} < 3`);

    const failMetrics = sectionMetrics(text, [
      "失败", "翻车", "故障", "异常", "不达标", "回退", "不可修复", "处置", "红线",
      "验收用例", "异常路径", "边界", "围栏绑定", "不做什么",
    ]);
    const nFail = Math.max(failMetrics.rows, failMetrics.items);
    metrics["失败诊断"] = nFail;
    if (nFail < 3) issues.push(`失败诊断 ${nFail} < 3`);
    else if (!/异常路径|失败|block|review|不执行|不编造|未核实|回滚|挂起|熔断|打回|剔除|停止|冻结|撤回|告警|转人工|退回|报错|不可能/.test(failMetrics.merged)) {
      issues.push("失败诊断缺少可判定语义（异常路径/Fail-closed/挂起）");
    }

    const evidenceMetrics = sectionMetrics(text, ["证据口径", "留痕", "回执", "证据", "输出动作", "输出契约", "事件"]);
    const evidenceLines = text
      .split("\n")
      .map((l) => l.trim())
      .filter((t) => t && !/^\|\s*-+/.test(t))
      .filter((t) => /回执|sha256|SHA256|证据链|留痕|同步回执/.test(t)).length;
    const nEvidence = Math.max(evidenceMetrics.rows, evidenceMetrics.items, evidenceLines);
    metrics["证据口径"] = nEvidence;
    if (nEvidence < 2) issues.push(`证据口径 ${nEvidence} < 2`);
  }

  const filler = /应加强专业性|提升专业水平|注意结合实际情况|进一步提高(内容|质量)水平/.test(text);
  metrics["模板化表述"] = filler;
  if (filler) issues.push("含不可判定的模板化表述");

  return {
    bundle,
    skill,
    path: path.slice(ROOT.length + 1),
    type,
    boundPresets: [...bound.presets].sort(),
    lines: text.split("\n").length,
    metrics,
    issues,
    warnings,
    ok: issues.length === 0,
  };
}

function collectSkills(bundleFilter: string, skillFilter: string): Array<[string, string, string]> {
  const out: Array<[string, string, string]> = [];
  const bundles = bundleFilter && bundleFilter !== "all" ? [bundleFilter as Bundle] : [...BUNDLES];
  for (const b of bundles) {
    const dir = join(ROOT, "bundles", b, "skills");
    if (!existsSync(dir)) continue;
    for (const name of readdirSync(dir).sort()) {
      const p = join(dir, name, "SKILL.md");
      if (existsSync(p) && (!skillFilter || name === skillFilter)) out.push([b, name, p]);
    }
  }
  if (!bundleFilter || bundleFilter === "all") {
    const off = join(ROOT, "skills", "official");
    const walk = (dir: string): void => {
      if (!existsSync(dir)) return;
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const p = join(dir, entry.name);
        if (entry.isDirectory()) walk(p);
        else if (entry.name === "SKILL.md" && (!skillFilter || p.includes(skillFilter))) {
          out.push(["official", p.split("/").slice(-2, -1)[0]!, p]);
        }
      }
    };
    walk(off);
  }
  return out;
}

const bundleFilter = arg("--bundle", "all");
const skillFilter = arg("--skill", "");
const bindings = bindingIndex();
const reports = collectSkills(bundleFilter, skillFilter).map(([b, name, p]) => auditSkill(b, name, p, bindings));
const failed = reports.filter((r) => !r.ok);
const byType = (t: KnowhowType): SkillReport[] => reports.filter((r) => r.type === t);
const rate = (list: SkillReport[]): string => `${list.filter((r) => r.ok).length}/${list.length}`;

const mdPath = arg("--md", "");
if (flag("--json")) {
  console.log(JSON.stringify({ scope: reports.length, ok: reports.length - failed.length, failed: failed.length, reports }, null, 2));
} else {
  console.log(`Know-How 结构审计：${reports.length} 个技能（S-A ${byType("S-A").length} / S-B ${byType("S-B").length} / S-C ${byType("S-C").length}）`);
  for (const r of reports) {
    const detail =
      r.type === "S-A"
        ? `原则 ${r.metrics["决策原则"]} · 打法 ${r.metrics["打法库"]}(分支 ${r.metrics["分支"]}) · SOP ${r.metrics["SOP"]} · KPI ${r.metrics["关键指标"]} · 失败 ${r.metrics["失败模式"]}`
        : r.type === "S-B"
          ? `判据 ${r.metrics["工艺判据"]} · 边界 ${r.metrics["边界"]} · 失败 ${r.metrics["失败模式"]}`
          : `前置 ${r.metrics["前置校验"]} · 诊断 ${r.metrics["失败诊断"]} · 证据 ${r.metrics["证据口径"]}`;
    console.log(
      `${r.ok ? "✓" : "✗"} [${r.type}] ${r.bundle}/${r.skill.padEnd(26)} ${detail}`
      + `${r.issues.length ? `  ← ${r.issues.join("；")}` : ""}`
      + `${r.warnings.length ? `  ~ ${r.warnings.join("；")}` : ""}`,
    );
  }
  console.log(`\n达标率：S-A ${rate(byType("S-A"))} · S-B ${rate(byType("S-B"))} · S-C ${rate(byType("S-C"))} · 合计 ${reports.length - failed.length}/${reports.length}`);
}

if (mdPath) {
  const lines: string[] = [
    "# Know-How 结构审计报告（机检 · B 级）",
    "",
    `- 生成时间：${new Date().toISOString()}`,
    `- 范围：${bundleFilter}${skillFilter ? ` / ${skillFilter}` : ""}；共 ${reports.length} 个技能`,
    `- 达标率：S-A ${rate(byType("S-A"))} · S-B ${rate(byType("S-B"))} · S-C ${rate(byType("S-C"))}`,
    "",
    "| 技能 | 包 | 分型 | 行数 | 绑定岗位 | 结论 | 问题 |",
    "|---|---|---|---:|---|---|---|",
    ...reports.map(
      (r) =>
        `| \`${r.skill}\` | ${r.bundle} | ${r.type} | ${r.lines} | ${r.boundPresets.join(", ") || "（无）"} | ${r.ok ? "达标" : "不达标"} | ${[...r.issues, ...r.warnings.map((w) => `建议：${w}`)].join("；") || "—"} |`,
    ),
    "",
  ];
  writeFileSync(mdPath, lines.join("\n"), "utf8");
  console.log(`written: ${mdPath}`);
}

process.exit(flag("--strict") && failed.length > 0 ? 1 : 0);
