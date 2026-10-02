#!/usr/bin/env node
/**
 * acceptance-matrix.mts · 员工/技能验收矩阵生成器（A 契约层 + B 运行层）
 *
 * 为什么需要它：README/看板上的「72 岗 / 67 技能」是**派生统计**，人肉核对必然漂移。
 * 本脚本把三份事实源拉到一起逐条对账，产出可复核的矩阵（JSON + CSV + 摘要）：
 *   ① 组合编制事实源：composeWorkforce / loadComposedAssets（bundle 清单 + preset 文件）
 *   ② 运行态事实源：workspace 的 agents / fence_rules / skills / skill_installs（RLS 视角）
 *   ③ 技能文档事实源：各包 skills/<key>/SKILL.md（frontmatter + 正文声明的围栏）
 *
 * 验收分层（与《GROWTH体验验收标准与员工技能验收矩阵》一致）：
 *   A 契约层：字段/唯一性/围栏存在/技能存在/写读一致/来源归属/组合并集单调
 *   B 运行层：在编与状态/身份一致/围栏一致/技能一致/来源留痕/围栏不悬空/技能已装/夜班声明
 *   C 能力层：本脚本不做（需要真实模型与专业场景评分卡），列在输出里作为已知缺口
 *
 * 用法：
 *   pnpm acceptance:matrix --out <目录>          # 生成矩阵
 *   pnpm acceptance:matrix --out <目录> --fail-on-error   # 有失败项即 exit 1（可入门禁）
 * 环境：tsx --env-file=.env（DATABASE_URL 指向目标工作区所在库）
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import pg from "pg";
import YAML from "yaml";
import { composeWorkforce, loadComposedAssets, loadVerifiedBundleManifest, mergeComposedFenceRules } from "@workloom/base/bundles";
// 根级脚本统一走相对路径引行业契约源码（与 bundle-governance.mts 同口径）
import { formatContractError, parseWorkforcePreset, type WorkforcePreset } from "../packages/industry-contract/src/index.ts";

/* ============================== 参数与环境 ============================== */

const argv = process.argv.slice(2);
const argValue = (name: string): string | undefined => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
};
const hasFlag = (name: string) => argv.includes(name);

const REPO_ROOT = resolve(dirname(new URL(import.meta.url).pathname), "..");
const PRIMARY_BUNDLE = argValue("--bundle") ?? process.env.ACCEPTANCE_PRIMARY_BUNDLE ?? "geo-growth";
const WORKSPACE_ID = argValue("--workspace") ?? process.env.ACCEPTANCE_WORKSPACE_ID ?? "ws-yunqi";
const OUT_DIR = resolve(argValue("--out") ?? join(REPO_ROOT, "artifacts", "acceptance-matrix"));
const FAIL_ON_ERROR = hasFlag("--fail-on-error");

/* ============================== 类型 ============================== */

interface Check {
  ok: boolean;
  detail: string;
}

interface AgentMatrixRow {
  preset_key: string;
  name: string;
  bundle: string;
  kind: string;
  readonly: boolean;
  night_shift: boolean;
  high_risk: boolean;
  fences: string[];
  fences_effective: string[];
  skills: string[];
  shadowed_from: string[];
  /** 事件覆盖前缀（组合层唯一性检查用） */
  event_prefixes: string[];
  checks: Record<string, Check>;
  failures: string[];
  warnings: string[];
  status: "pass" | "fail";
}

interface SkillMatrixRow {
  skill: string;
  name: string;
  bundle: string;
  version: string;
  fences: string[];
  doc_declared_fences: string[];
  referenced_by: string[];
  body_chars: number;
  description_chars: number;
  checks: Record<string, Check>;
  failures: string[];
  warnings: string[];
  status: "pass" | "fail";
}

/* ============================== 事实源装配 ============================== */

const composed = loadComposedAssets(PRIMARY_BUNDLE);
const workforce = composeWorkforce(PRIMARY_BUNDLE);
const mergedRules = mergeComposedFenceRules(composed.fencePacks);
const ruleIds = new Set(mergedRules.map((m) => m.rule.rule_id));
const ruleLevel = new Map(mergedRules.map((m) => [m.rule.rule_id, m.rule.level ?? "review"]));

/** 组合编制内的岗位：preset_key → 权威 preset（含组合有效围栏与遮蔽来源） */
const authoritative = new Map<string, { preset: WorkforcePreset; bundleId: string; fences: string[]; shadowed: string[] }>();
for (const [key, entry] of workforce.presets) {
  authoritative.set(key, {
    preset: entry.preset,
    bundleId: entry.bundleId,
    fences: entry.effectiveFenceBindings,
    shadowed: entry.shadowedBundleIds,
  });
}

/** 组合层的技能全集（bundle 目录下的 SKILL.md） */
interface SkillAsset {
  bundle: string;
  key: string;
  name: string;
  description: string;
  body: string;
  file: string;
  docDeclaredFences: string[];
}

function assertInsideBundle(bundleRoot: string, assetPath: string): string {
  const full = resolve(bundleRoot, assetPath);
  const rel = relative(bundleRoot, full);
  if (rel.startsWith("..") || rel.startsWith(sep) || rel === "") {
    throw new Error(`技能资产越出 bundle 目录：${assetPath}`);
  }
  return full;
}

/** 从技能正文/描述里抽取围栏编号（G 系列与 R 系列），用于「文档提及」信息项 */
function declaredFences(text: string): string[] {
  const found = new Set<string>();
  for (const m of text.matchAll(/\bG-?[A-Z]{0,4}\d{0,3}[a-z]?\b/g)) found.add(m[0]);
  for (const m of text.matchAll(/\bR\d{1,2}\b/g)) found.add(m[0]);
  return [...found].sort();
}

/**
 * 从 description 里抽取**显式绑定声明**（“…绑定围栏 G2，卸载即撤销”“绑定围栏：R1/R2”）。
 * 只认这句话里的围栏，不把正文里的示例/旁述（如“由 R9 管辖”“参考 R10”）当成绑定，
 * 避免把产品写法的散文当契约断言（上一版全文抽取会产生大量假阳性）。
 */
function declaredBindingsFromDescription(description: string): string[] {
  const clause = description.match(/绑定围栏[:：]?\s*([^。；;\n]+)/)?.[1];
  if (!clause) return [];
  const found = new Set<string>();
  for (const m of clause.matchAll(/G-?[A-Z]{0,4}\d{0,3}[a-z]?|\bR\d{1,2}\b/g)) found.add(m[0]);
  return [...found].sort();
}

/** 声明“G10”视为被绑定“G10a/G10b/G10c/G10d”覆盖（父编号与子编号同源），反之不算 */
function fenceCoveredBy(declared: string, bindings: string[]): boolean {
  return bindings.some((bound) => bound === declared || bound.startsWith(declared));
}

function loadSkillAssets(): SkillAsset[] {
  const root = process.env.BUNDLES_ROOT ?? join(REPO_ROOT, "bundles");
  const out: SkillAsset[] = [];
  for (const bundleId of composed.bundleIds) {
    const manifest = loadVerifiedBundleManifest(bundleId, root);
    for (const assetPath of manifest.workloom.provides.skills) {
      const full = assertInsideBundle(join(root, bundleId), assetPath);
      if (!existsSync(full)) continue;
      const raw = readFileSync(full, "utf-8");
      const fm = raw.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
      const parsed = (YAML.parse(fm?.[1] ?? "{}") ?? {}) as Record<string, unknown>;
      const key = String(parsed.name ?? dirname(assetPath).split("/").at(-1));
      const body = (fm?.[2] ?? "").trim();
      const description = String(parsed.description ?? "");
      out.push({
        bundle: bundleId,
        key,
        name: key,
        description,
        body,
        file: relative(REPO_ROOT, full),
        docDeclaredFences: declaredFences(`${description}\n${body}`),
      });
    }
  }
  return out.sort((a, b) => (a.bundle + a.key).localeCompare(b.bundle + b.key));
}

const skillAssets = loadSkillAssets();
const skillKeys = new Set(skillAssets.map((s) => s.key));

/**
 * 包外技能资产：底座官方技能（skills/official，bundle=null，如 deal-flow）与注册表技能
 * （skills/registry）。行业包 preset 允许引用它们（本仓自带测试同口径 skillAssetExists），
 * 但“资产存在”与“工作区真的登记并安装”是两件事，前者看 A5、后者看 B7。
 */
function listAssetSkillNames(root: string): Set<string> {
  const names = new Set<string>();
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const full = join(dir, entry.name);
      const file = join(full, "SKILL.md");
      if (existsSync(file)) {
        const fm = readFileSync(file, "utf-8").match(/^---\n([\s\S]*?)\n---/)?.[1] ?? "";
        const name = fm.match(/^name:\s*(.+)$/m)?.[1]?.trim();
        names.add(name || entry.name);
      } else {
        walk(full);
      }
    }
  };
  const officialRoot = join(root, "official");
  if (existsSync(officialRoot)) walk(officialRoot);
  const registryRoot = join(root, "registry");
  if (existsSync(registryRoot)) {
    for (const entry of readdirSync(registryRoot, { withFileTypes: true })) {
      if (entry.isDirectory() && existsSync(join(registryRoot, entry.name, "SKILL.md"))) names.add(entry.name);
    }
  }
  return names;
}

const packageExternalSkillNames = listAssetSkillNames(join(REPO_ROOT, "skills"));
/** preset 声明的技能短名 → 引用它的岗位 */
const skillRefs = new Map<string, string[]>();
for (const [key, entry] of authoritative) {
  for (const skill of entry.preset.skills ?? []) {
    skillRefs.set(skill, [...(skillRefs.get(skill) ?? []), key]);
  }
}

/* ============================== A 契约层检查（岗位） ============================== */

const prefixOwners = new Map<string, string[]>();
for (const [key, entry] of authoritative) {
  for (const coverage of entry.preset.coverage ?? []) {
    prefixOwners.set(coverage.eventPrefix, [...(prefixOwners.get(coverage.eventPrefix) ?? []), key]);
  }
}

function checkPresetContract(key: string, entry: { preset: WorkforcePreset; bundleId: string; fences: string[]; shadowed: string[] }): {
  checks: Record<string, Check>;
  warnings: string[];
} {
  const preset = entry.preset;
  const checks: Record<string, Check> = {};
  const warnings: string[] = [];

  // A1 契约字段完整（走行业契约 Schema，与运行时同一只解析器）
  try {
    parseWorkforcePreset(preset);
    checks.A1_contract = { ok: true, detail: "字段完整（industry-contract 2.0 schema 通过）" };
  } catch (err) {
    checks.A1_contract = { ok: false, detail: formatContractError(err).join("；") || String(err) };
  }

  // A2 组合唯一性与遮蔽归属（同名定义必须由主包显式声明权威归属）
  const shadow = entry.shadowed;
  checks.A2_unique = {
    ok: true,
    detail: shadow.length === 0 ? "组合内唯一权威定义" : `权威=${entry.bundleId}，遮蔽=${shadow.join("/")}（已声明 presetOwners）`,
  };

  /**
   * A3 事件前缀在组合层唯一。单包 Schema 只保证包内唯一；跨包同名前缀目前**不阻断运行时**
   * （coverage 是岗位覆盖声明，未被运行时消费），但它让“事件域责任人”出现两个户主。
   * 因此按警告呈现并列入产品裁决清单，而不是伪装成硬失败或静默放过。
   */
  const conflicts = (preset.coverage ?? []).flatMap((coverage) => {
    const owners = (prefixOwners.get(coverage.eventPrefix) ?? []).filter((owner) => owner !== key);
    return owners.length ? [`${coverage.eventPrefix}←${owners.join("/")}`] : [];
  });
  if (conflicts.length) {
    warnings.push(`事件域前缀跨包重复：${conflicts.join("；")}（coverage 为声明元数据，需产品裁决归口）`);
  }
  checks.A3_event_prefix = {
    ok: true,
    detail: conflicts.length === 0
      ? `事件前缀 ${(preset.coverage ?? []).map((c) => c.eventPrefix).join(",") || "无（只读岗位）"} 组合层唯一`
      : `事件前缀 ${(preset.coverage ?? []).map((c) => c.eventPrefix).join(",")} 与其他包岗位重复（已记警告）`,
  };

  // A4 围栏绑定必须真实存在（不悬空）
  const missingFences = entry.fences.filter((fence) => !ruleIds.has(fence));
  checks.A4_fences_exist = {
    ok: missingFences.length === 0,
    detail: missingFences.length === 0
      ? `${entry.fences.length} 条绑定全部存在于组合围栏并集（含最严级：${entry.fences.map((f) => `${f}:${ruleLevel.get(f)}`).join(" ") || "无"}）`
      : `围栏不存在：${missingFences.join(",")}`,
  };

  // A5 技能资产必须可解析：行业包技能目录 ∪ 底座官方技能 ∪ 注册表技能（与仓库自带测试同口径）
  const missingSkills = (preset.skills ?? []).filter(
    (skill) => !skillKeys.has(skill) && !packageExternalSkillNames.has(skill),
  );
  const externalSkills = (preset.skills ?? []).filter((skill) => !skillKeys.has(skill) && packageExternalSkillNames.has(skill));
  checks.A5_skills_exist = {
    ok: missingSkills.length === 0,
    detail: missingSkills.length === 0
      ? `${(preset.skills ?? []).length} 个技能资产可解析（包外官方技能：${externalSkills.join(",") || "无"}）`
      : `技能资产缺失：${missingSkills.join(",")}`,
  };

  /**
   * A6 写读一致性：只读岗位无写工具；可写岗位必须声明覆盖/写工具；
   * write_back 的每一项必须是本岗位**已声明的动作名**（写回落点不能凭空出现）。
   * 落在只读动作上不算违约（回执采集类动作读回结果、再写回档案，如 publish.receipt），
   * 只作为提示列出。
   */
  const writeTools = new Set((preset.tools ?? []).filter((t) => t.access === "write").map((t) => t.name));
  const allTools = new Set((preset.tools ?? []).map((t) => t.name));
  const writeBackOrphans = (preset.write_back ?? []).filter((name) => !allTools.has(name));
  const readOnlyWriteBack = (preset.write_back ?? []).filter((name) => allTools.has(name) && !writeTools.has(name));
  if (readOnlyWriteBack.length) {
    warnings.push(`write_back 落在只读动作上：${readOnlyWriteBack.join(",")}（读回执再写回，提示项）`);
  }
  const a6Ok = preset.readonly
    ? writeTools.size === 0
    : writeTools.size > 0 && (preset.coverage ?? []).length > 0 && entry.fences.length > 0 && writeBackOrphans.length === 0;
  checks.A6_write_read = {
    ok: a6Ok,
    detail: preset.readonly
      ? `只读岗位，写工具 ${writeTools.size} 个`
      : `写工具 ${writeTools.size} / write_back ${(preset.write_back ?? []).length}（未声明动作 ${writeBackOrphans.join(",") || "无"}）`,
  };

  // A7 治理声明：夜班/高危必须显式布尔；高危必须绑围栏
  const governOk = typeof preset.night_shift === "boolean" && typeof preset.high_risk === "boolean"
    && (!preset.high_risk || entry.fences.length > 0);
  checks.A7_governance = {
    ok: governOk,
    detail: `night_shift=${preset.night_shift} high_risk=${preset.high_risk} 围栏=${entry.fences.length}`,
  };

  // A8 组合围栏并集单调：被遮蔽定义声明的围栏不得因融合被丢
  const rootDir = process.env.BUNDLES_ROOT ?? join(REPO_ROOT, "bundles");
  const dropped: string[] = [];
  for (const loserBundle of shadow) {
    const loserPath = join(rootDir, loserBundle, "presets", `${key}.yml`);
    if (!existsSync(loserPath)) continue;
    const loser = YAML.parse(readFileSync(loserPath, "utf-8")) as { fence_bindings?: string[] };
    for (const fence of loser.fence_bindings ?? []) {
      if (!entry.fences.includes(fence)) dropped.push(`${loserBundle}:${fence}`);
    }
  }
  checks.A8_union_monotonic = {
    ok: dropped.length === 0,
    detail: dropped.length === 0
      ? (shadow.length ? `被遮蔽包围栏已并入（${entry.fences.join(",")}）` : "无遮蔽定义，单包围栏即组合围栏")
      : `融合丢失围栏：${dropped.join(",")}`,
  };

  return { checks, warnings };
}

/* ============================== B 运行层检查（DB） ============================== */

interface DbAgent {
  id: string;
  preset_key: string;
  name: string;
  version: string;
  kind: string;
  readonly: boolean;
  status: string;
  invalid_reason: string | null;
  fence_bindings: string[];
  skills: string[];
  meta: Record<string, unknown>;
}

interface DbSkill {
  id: string;
  level: string;
  bundle: string | null;
  name: string;
  version: string;
  description: string;
  fence_bindings: string[];
}

const quoteArray = (values: string[]) => [...values].sort().join("\u0001");
const sameSet = (a: string[], b: string[]) => quoteArray(a) === quoteArray(b);

async function loadRuntime(): Promise<{
  connected: boolean;
  error?: string;
  agents: Map<string, DbAgent>;
  skills: Map<string, DbSkill>;
  installs: Map<string, { snapshot: string[]; version: string }>;
  activeFences: Map<string, string>;
}> {
  const url = process.env.DATABASE_URL;
  const empty = () => ({
    connected: false,
    agents: new Map<string, DbAgent>(),
    skills: new Map<string, DbSkill>(),
    installs: new Map<string, { snapshot: string[]; version: string }>(),
    activeFences: new Map<string, string>(),
  });
  if (!url) return { ...empty(), error: "DATABASE_URL 未设置" };
  const client = new pg.Client({ connectionString: url });
  try {
    await client.connect();
    const agents = await client.query<DbAgent>(
      `SELECT id, preset_key, name, version, kind, readonly, status, invalid_reason, fence_bindings, skills, meta
       FROM agents WHERE workspace_id=$1 ORDER BY preset_key`,
      [WORKSPACE_ID],
    );
    const skills = await client.query<DbSkill>(
      `SELECT s.id, s.level, s.bundle, s.name, s.version, s.description, s.fence_bindings
       FROM skills s JOIN skill_installs si ON si.skill_id = s.id
       WHERE si.workspace_id=$1`,
      [WORKSPACE_ID],
    );
    const installs = await client.query<{ skill_id: string; fence_bindings_snapshot: string[]; installed_version: string }>(
      `SELECT skill_id, fence_bindings_snapshot, installed_version FROM skill_installs WHERE workspace_id=$1`,
      [WORKSPACE_ID],
    );
    const fences = await client.query<{ rule_id: string; level: string }>(
      `SELECT DISTINCT ON (rule_id) rule_id, level FROM fence_rules
       WHERE (workspace_id=$1 OR workspace_id='*') AND status='active'
       ORDER BY rule_id, CASE level WHEN 'block' THEN 2 WHEN 'review' THEN 1 ELSE 0 END DESC`,
      [WORKSPACE_ID],
    );
    return {
      connected: true,
      agents: new Map(agents.rows.map((row) => [row.preset_key, row])),
      skills: new Map(skills.rows.map((row) => [row.name, row])),
      installs: new Map(installs.rows.map((row) => [row.skill_id, { snapshot: row.fence_bindings_snapshot, version: row.installed_version }])),
      activeFences: new Map(fences.rows.map((row) => [row.rule_id, row.level])),
    };
  } catch (err) {
    return { ...empty(), error: err instanceof Error ? err.message : String(err) };
  } finally {
    await client.end().catch(() => undefined);
  }
}

const runtime = await loadRuntime();

function checkAgentRuntime(
  key: string,
  entry: { preset: WorkforcePreset; bundleId: string; fences: string[]; shadowed: string[] },
): Record<string, Check> {
  const preset = entry.preset;
  const checks: Record<string, Check> = {};
  if (!runtime.connected) {
    const detail = `未连接数据库（${runtime.error ?? "unknown"}）：运行层未判定`;
    for (const id of ["B1_roster", "B2_identity", "B3_fences", "B4_skills", "B5_source", "B6_fence_live", "B7_skill_installed", "B8_night"]) {
      checks[id] = { ok: false, detail };
    }
    return checks;
  }
  const row = runtime.agents.get(key);
  if (!row) {
    const detail = `工作区 ${WORKSPACE_ID} 名册中不存在该岗位`;
    for (const id of ["B1_roster", "B2_identity", "B3_fences", "B4_skills", "B5_source", "B6_fence_live", "B7_skill_installed", "B8_night"]) {
      checks[id] = { ok: false, detail };
    }
    return checks;
  }

  checks.B1_roster = {
    ok: row.status === "ready" && !row.invalid_reason,
    detail: row.status === "ready" ? `status=ready（${row.id}）` : `status=${row.status}：${row.invalid_reason ?? ""}`,
  };
  const identityOk = row.name === preset.name && row.version === preset.version && row.kind === preset.kind && row.readonly === preset.readonly;
  checks.B2_identity = {
    ok: identityOk,
    detail: identityOk
      ? `${row.name} ${row.version} ${row.kind}${row.readonly ? "（只读）" : ""} 与 preset 一致`
      : `preset=${preset.name}/${preset.version}/${preset.kind}/${preset.readonly} vs DB=${row.name}/${row.version}/${row.kind}/${row.readonly}`,
  };
  const fencesOk = sameSet(row.fence_bindings ?? [], entry.fences);
  checks.B3_fences = {
    ok: fencesOk,
    detail: fencesOk ? `组合有效围栏 ${entry.fences.length} 条与 DB 一致` : `DB=${(row.fence_bindings ?? []).join(",")} vs 组合=${entry.fences.join(",")}`,
  };
  const skillsOk = sameSet(row.skills ?? [], preset.skills ?? []);
  checks.B4_skills = {
    ok: skillsOk,
    detail: skillsOk ? `技能 ${(preset.skills ?? []).length} 项与 DB 一致` : `DB=${(row.skills ?? []).join(",")} vs preset=${(preset.skills ?? []).join(",")}`,
  };
  const meta = row.meta ?? {};
  const shadowedInMeta = (meta.shadowedBundleIds as string[] | undefined) ?? [];
  const sourceOk = meta.sourceBundleId === entry.bundleId && sameSet(shadowedInMeta, entry.shadowed);
  checks.B5_source = {
    ok: sourceOk,
    detail: sourceOk
      ? `来源包=${entry.bundleId}${entry.shadowed.length ? `，遮蔽留痕=${entry.shadowed.join("/")}` : ""}`
      : `meta.sourceBundleId=${String(meta.sourceBundleId)}（期望 ${entry.bundleId}）shadowed=${shadowedInMeta.join(",")}（期望 ${entry.shadowed.join(",")}）`,
  };
  const dangling = (row.fence_bindings ?? []).filter((fence) => !runtime.activeFences.has(fence));
  checks.B6_fence_live = {
    ok: dangling.length === 0,
    detail: dangling.length === 0
      ? `DB 围栏绑定全部有 active 规则（最严级：${(row.fence_bindings ?? []).map((f) => `${f}:${runtime.activeFences.get(f)}`).join(" ") || "无"}）`
      : `悬空围栏（声明但无 active 规则）：${dangling.join(",")}`,
  };
  const notInstalled = (preset.skills ?? []).filter((skill) => !runtime.installs.has(`skill-${skill}`) && !runtime.installs.has(skill));
  checks.B7_skill_installed = {
    ok: notInstalled.length === 0,
    detail: notInstalled.length === 0 ? `声明技能均在本工作区安装` : `未安装：${notInstalled.join(",")}`,
  };
  const nightOk = (meta.night_shift === true) === (preset.night_shift === true);
  checks.B8_night = {
    ok: nightOk,
    detail: nightOk
      ? `夜班声明一致（night_shift=${preset.night_shift}）`
      : `夜班声明漂移：preset=${preset.night_shift} vs DB meta=${String(meta.night_shift)}`,
  };
  return checks;
}

/* ============================== 技能矩阵 ============================== */

function checkSkill(asset: SkillAsset): {
  checks: Record<string, Check>;
  warnings: string[];
  version: string;
  dbBundle: string;
  dbFences: string[];
} {
  const checks: Record<string, Check> = {};
  const warnings: string[] = [];
  const db = runtime.skills.get(asset.key);

  checks.SA1_doc = {
    ok: asset.description.length > 0 && asset.body.length >= 80,
    detail: `description ${asset.description.length} 字 / 正文 ${asset.body.length} 字${asset.body.length < 80 ? "（正文过短，疑似空壳技能）" : ""}`,
  };
  const bundleOk = db ? db.bundle === asset.bundle : asset.bundle === asset.bundle;
  checks.SA2_bundle = {
    ok: bundleOk,
    detail: db ? `目录包=${asset.bundle} / 注册表包=${db.bundle ?? "null"}` : "未装载到注册表（无法对账）",
  };
  const dbFences = db?.fence_bindings ?? [];
  const undeclaredInRegistry = dbFences.filter((fence) => !ruleIds.has(fence));
  const declared = declaredBindingsFromDescription(asset.description);
  const declaredNotBound = declared.filter((fence) => !fenceCoveredBy(fence, dbFences));
  checks.SA3_fences = {
    ok: undeclaredInRegistry.length === 0 && declaredNotBound.length === 0,
    detail: [
      `绑定=${dbFences.join(",") || "无"}`,
      `frontmatter 显式绑定声明=${declared.join(",") || "无"}`,
      `正文提及围栏=${asset.docDeclaredFences.join(",") || "无"}`,
      undeclaredInRegistry.length ? `绑定不在组合围栏内：${undeclaredInRegistry.join(",")}` : "",
      declaredNotBound.length ? `显式声明的绑定未进安装绑定：${declaredNotBound.join(",")}` : "",
    ].filter(Boolean).join("；"),
  };
  checks.SA4_registry = {
    ok: !!db && db.description.trim().length > 0 && db.version.trim().length > 0,
    detail: db ? `注册表 id=${db.id} level=${db.level} version=${db.version}` : "注册表无此行",
  };
  const install = db ? runtime.installs.get(db.id) : undefined;
  const snapshotOk = !!install && !!db && sameSet(install.snapshot, db.fence_bindings ?? []) && install.version === db.version;
  checks.SA5_install = {
    ok: snapshotOk,
    detail: install && db
      ? `安装快照=${install.snapshot.join(",") || "无"} / 版本 ${install.version}${snapshotOk ? "（与注册表一致）" : "（与注册表不一致）"}`
      : "无安装行",
  };
  const refs = skillRefs.get(asset.key) ?? [];
  if (refs.length === 0) {
    warnings.push("装备库预留：当前组合编制内没有岗位引用它（可被客户/其他包装配）");
  }
  // 该检查项只做事实记录（是否被引用），不单独判失败：未被引用的官方技能是装备库预留，
  // 真正的硬失败是「被岗位声明却没登记/没安装」（岗位侧 B7 判定）。
  checks.SA6_referenced = {
    ok: true,
    detail: refs.length ? `被 ${refs.length} 个岗位引用：${refs.slice(0, 6).join(",")}${refs.length > 6 ? "…" : ""}` : "未被本组合编制引用（装备库预留，已记警告）",
  };
  return { checks, warnings, version: db?.version ?? "", dbBundle: db?.bundle ?? "", dbFences };
}

/* ============================== 组装矩阵 ============================== */

const agentRows: AgentMatrixRow[] = [];
for (const [key, entry] of [...authoritative].sort((a, b) => a[0].localeCompare(b[0]))) {
  const contract = checkPresetContract(key, entry);
  const checks = { ...contract.checks, ...checkAgentRuntime(key, entry) };
  const failures = Object.entries(checks).filter(([, c]) => !c.ok).map(([id]) => id);
  agentRows.push({
    preset_key: key,
    name: entry.preset.name,
    bundle: entry.bundleId,
    kind: entry.preset.kind,
    readonly: entry.preset.readonly,
    night_shift: entry.preset.night_shift,
    high_risk: entry.preset.high_risk,
    fences: entry.preset.fence_bindings ?? [],
    fences_effective: entry.fences,
    skills: entry.preset.skills ?? [],
    shadowed_from: entry.shadowed,
    event_prefixes: (entry.preset.coverage ?? []).map((c) => c.eventPrefix),
    checks,
    failures,
    warnings: contract.warnings,
    status: failures.length === 0 ? "pass" : "fail",
  });
}

const skillRows: SkillMatrixRow[] = skillAssets.map((asset) => {
  const { checks, warnings, version, dbFences } = checkSkill(asset);
  const failures = Object.entries(checks).filter(([, c]) => !c.ok).map(([id]) => id);
  return {
    skill: asset.key,
    name: asset.key,
    bundle: asset.bundle,
    version,
    fences: dbFences,
    doc_declared_fences: asset.docDeclaredFences,
    referenced_by: skillRefs.get(asset.key) ?? [],
    body_chars: asset.body.length,
    description_chars: asset.description.length,
    checks,
    failures,
    warnings,
    status: failures.length === 0 ? "pass" : "fail",
  };
});

/* ============================== 输出 ============================== */

const agentFails = agentRows.filter((r) => r.status === "fail");
const skillFails = skillRows.filter((r) => r.status === "fail");
const agentWarns = agentRows.filter((r) => r.warnings.length > 0);
const skillWarns = skillRows.filter((r) => r.warnings.length > 0);
const perBundle = agentRows.reduce<Record<string, number>>((acc, row) => {
  acc[row.bundle] = (acc[row.bundle] ?? 0) + 1;
  return acc;
}, {});
const summary = {
  generatedAt: new Date().toISOString(),
  primaryBundle: PRIMARY_BUNDLE,
  bundles: composed.bundleIds,
  workspaceId: WORKSPACE_ID,
  runtimeConnected: runtime.connected,
  runtimeError: runtime.error ?? null,
  counts: {
    agents: agentRows.length,
    agentsPass: agentRows.length - agentFails.length,
    skills: skillRows.length,
    skillsPass: skillRows.length - skillFails.length,
    warnings: agentWarns.length + skillWarns.length,
    fenceRulesMerged: mergedRules.length,
    fenceRulesActiveInWorkspace: runtime.activeFences.size,
    shadowedPresets: composed.shadowed.length,
    perBundle,
  },
  capabilityLayer: {
    status: "not-run",
    reason: "C 能力层需要真实模型 + 专业场景评分卡；本脚本只覆盖 A 契约层与 B 运行层。",
    plan: "见 outputs/GROWTH体验验收标准与员工技能验收矩阵.md §3.2/§3.3",
  },
  failures: {
    agents: agentFails.map((row) => ({ preset_key: row.preset_key, failures: row.failures, detail: row.failures.map((id) => `${id}: ${row.checks[id]?.detail}`) })),
    skills: skillFails.map((row) => ({ skill: row.skill, failures: row.failures, detail: row.failures.map((id) => `${id}: ${row.checks[id]?.detail}`) })),
  },
  warnings: {
    agents: agentWarns.map((row) => ({ preset_key: row.preset_key, warnings: row.warnings })),
    skills: skillWarns.map((row) => ({ skill: row.skill, warnings: row.warnings })),
  },
};

mkdirSync(OUT_DIR, { recursive: true });
writeFileSync(join(OUT_DIR, "agent-matrix.json"), JSON.stringify({ summary, rows: agentRows }, null, 1));
writeFileSync(join(OUT_DIR, "skill-matrix.json"), JSON.stringify({ summary, rows: skillRows }, null, 1));

const checkIds = [...new Set(agentRows.flatMap((row) => Object.keys(row.checks)))];
const agentHeader = ["preset_key", "name", "bundle", "kind", "readonly", "night_shift", "high_risk", "fences", "skills", "status", ...checkIds];
const agentCsv = [
  agentHeader.join(","),
  ...agentRows.map((row) => [
    row.preset_key, row.name, row.bundle, row.kind, String(row.readonly), String(row.night_shift), String(row.high_risk),
    row.fences_effective.length, row.skills.length, row.status,
    ...checkIds.map((id) => (row.checks[id]?.ok ? "pass" : "FAIL")),
  ].map((cell) => (/[",\n]/.test(String(cell)) ? `"${String(cell).replace(/"/g, '""')}"` : String(cell))).join(",")),
].join("\n");
writeFileSync(join(OUT_DIR, "agent-matrix.csv"), `${agentCsv}\n`);

const skillIds = [...new Set(skillRows.flatMap((row) => Object.keys(row.checks)))];
const skillCsv = [
  ["skill", "bundle", "version", "fences", "referenced_by", "body_chars", "status", ...skillIds].join(","),
  ...skillRows.map((row) => [
    row.skill, row.bundle, row.version, row.fences.join(" "), row.referenced_by.length, row.body_chars, row.status,
    ...skillIds.map((id) => (row.checks[id]?.ok ? "pass" : "FAIL")),
  ].map((cell) => (/[",\n]/.test(String(cell)) ? `"${String(cell).replace(/"/g, '""')}"` : String(cell))).join(",")),
].join("\n");
writeFileSync(join(OUT_DIR, "skill-matrix.csv"), `${skillCsv}\n`);
writeFileSync(join(OUT_DIR, "matrix-summary.json"), JSON.stringify(summary, null, 1));

const md: string[] = [];
md.push(`# 员工/技能验收矩阵（A 契约层 + B 运行层）`);
md.push("");
md.push(`- 生成时间：${summary.generatedAt}`);
md.push(`- 组合主包：${PRIMARY_BUNDLE}（并集 ${composed.bundleIds.join(" + ")}）`);
md.push(`- 工作区：${WORKSPACE_ID}；数据库连接：${runtime.connected ? "正常" : `失败（${runtime.error}）`}`);
md.push(`- 员工：${summary.counts.agents} 岗，通过 ${summary.counts.agentsPass}（分布 ${Object.entries(perBundle).map(([b, n]) => `${b} ${n}`).join(" / ")}）`);
md.push(`- 技能：${summary.counts.skills} 个，通过 ${summary.counts.skillsPass}`);
md.push(`- 围栏：组合并集 ${summary.counts.fenceRulesMerged} 条，工作区 active ${summary.counts.fenceRulesActiveInWorkspace} 条`);
md.push(`- 遮蔽岗位留痕：${summary.counts.shadowedPresets} 条`);
md.push("");
md.push(`## 失败清单`);
md.push("");
if (!agentFails.length && !skillFails.length) {
  md.push("无：A/B 层全部通过。");
} else {
  for (const row of agentFails) {
    md.push(`- 岗位 \`${row.preset_key}\`（${row.name}）：${row.failures.map((id) => `${id} ${row.checks[id]?.detail}`).join(" | ")}`);
  }
  for (const row of skillFails) {
    md.push(`- 技能 \`${row.skill}\`（${row.bundle}）：${row.failures.map((id) => `${id} ${row.checks[id]?.detail}`).join(" | ")}`);
  }
}
md.push("");
md.push(`## 能力层（C）`);
md.push("");
md.push(`未在本脚本内执行：${summary.capabilityLayer.reason}`);
md.push("");
md.push(`## 警告清单（不判失败，需产品裁决/后续跟进）`);
md.push("");
if (!agentWarns.length && !skillWarns.length) {
  md.push("无。");
} else {
  for (const row of agentWarns) {
    md.push(`- 岗位 \`${row.preset_key}\`（${row.name}）：${row.warnings.join(" | ")}`);
  }
  for (const row of skillWarns) {
    md.push(`- 技能 \`${row.skill}\`（${row.bundle}）：${row.warnings.join(" | ")}`);
  }
}
writeFileSync(join(OUT_DIR, "matrix-summary.md"), `${md.join("\n")}\n`);

console.log(`[acceptance-matrix] 员工 ${summary.counts.agentsPass}/${summary.counts.agents} 通过；技能 ${summary.counts.skillsPass}/${summary.counts.skills} 通过`);
console.log(`[acceptance-matrix] 警告 ${summary.counts.warnings} 条（见 matrix-summary.md 警告清单）`);
console.log(`[acceptance-matrix] 输出：${OUT_DIR}`);
for (const row of agentFails.slice(0, 12)) console.log(`  ✗ ${row.preset_key}：${row.failures.join(",")}`);
for (const row of skillFails.slice(0, 12)) console.log(`  ✗ ${row.skill}：${row.failures.join(",")}`);

if (FAIL_ON_ERROR && (agentFails.length || skillFails.length || !runtime.connected)) process.exit(1);
