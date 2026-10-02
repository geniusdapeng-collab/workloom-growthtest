/**
 * scripts/suite-geo.ts · WorkLoom GEO 双域深度测试套件（72 用例）
 *
 * 覆盖：A Bundle 完整性 / B 围栏判定正反例 / C 种子与运行态 / D 管线节拍一致性 / E 事件留痕合规
 * 用法：pnpm suite:geo（要求 .env 就位、PG 已迁移 + pnpm db:seed:geo）
 * 纪律：只读校验 + 纯函数判定，不写业务表、不跨用例污染；失败不中断，末尾汇总。
 */
import pg from "pg";
import YAML from "yaml";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { judge, type RuntimeRule } from "@workloom/base/fence-engine";
import { composeWorkforce } from "@workloom/base/bundles";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "..");
const BUNDLE = join(REPO_ROOT, "bundles/geo-growth");
const APP_URL = process.env.DATABASE_APP_URL ?? "postgres://workloom_app:workloom_dev_app@localhost:5432/workloom";
const app = new pg.Client({ connectionString: APP_URL });
const WS = "ws-geo";
const TENANT = "tenant-demo";

interface Case { id: string; name: string; run: () => Promise<void> | void }
const cases: Case[] = [];
const C = (domain: string) => {
  let n = 0;
  return (name: string, run: Case["run"]) => cases.push({ id: `${domain}-${String(++n).padStart(2, "0")}`, name, run });
};
function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(`断言失败：${msg}`);
}
let appReady = false;
const q = async (text: string, params: unknown[] = []) => {
  if (!appReady) {
    await app.connect();
    // biz_events RLS：SELECT 需租户上下文（L7.1 数据管道纪律）
    await app.query("SELECT set_config('app.tenant_id', $1, false)", [TENANT]);
    await app.query("SELECT set_config('app.workspace_id', $1, false)", [WS]);
    appReady = true;
  }
  return app.query(text, params);
};

/* ================= Bundle 资产装载 ================= */
const bundleJson = JSON.parse(readFileSync(join(BUNDLE, "bundle.json"), "utf-8"));
const presets = readdirSync(join(BUNDLE, "presets")).filter(f => f.endsWith(".yml")).sort()
  .map(f => YAML.parse(readFileSync(join(BUNDLE, "presets", f), "utf-8")));
const fenceDoc = YAML.parse(readFileSync(join(BUNDLE, "fences/geo-growth-baseline.yml"), "utf-8"));
const fenceRules: RuntimeRule[] = (fenceDoc.rules ?? []).map((r: { rule_id: string; name: string; level: RuntimeRule["level"]; is_baseline: boolean; match: { object_types: string[]; actions: string[] }; when: string }) => ({
  rule_id: r.rule_id, version: fenceDoc.version, name: r.name, level: r.level, is_baseline: r.is_baseline,
  objectTypes: r.match.object_types, actions: r.match.actions, when: r.when,
}));
const objectsJson = JSON.parse(readFileSync(join(BUNDLE, "schemas/objects.json"), "utf-8"));
const stagesJson = JSON.parse(readFileSync(join(BUNDLE, "schemas/stages.json"), "utf-8"));
/**
 * 对象模型校验用**组合口径**：本包围栏（如 G-C01 内部协作放行）管的是组合编制（geo-growth + hotel + ai-video），
 * 事件对象类型自然包含其它两包声明的生产对象（scene_card / shot_card / video_asset / subtitle_track …）。
 * 只用本包 objects.json 会让这类跨包对象被判"未声明"（2026-09-24 实测 A-10 因此长期报红）。
 */
const objectTypes = new Set<string>(objectsJson.objects.map((o: { type: string }) => o.type));
for (const sibling of ["ai-video", "hotel"]) {
  const file = join(REPO_ROOT, "bundles", sibling, "schemas/objects.json");
  if (!existsSync(file)) continue;
  for (const o of JSON.parse(readFileSync(file, "utf-8")).objects as Array<{ type: string }>) objectTypes.add(o.type);
}
// 基座运行时对象（IM 线程 / 任务）：不属于任何行业包，但事件账本里普遍存在
for (const runtimeType of ["thread", "task"]) objectTypes.add(runtimeType);
const pipelines = readdirSync(join(BUNDLE, "pipelines")).filter(f => f.endsWith(".yml")).sort()
  .map(f => ({ file: f, doc: YAML.parse(readFileSync(join(BUNDLE, "pipelines", f), "utf-8")) }));
const presetKeys = new Set<string>(presets.map(p => p.preset_key));
const fenceIds = new Set<string>(fenceRules.map(r => r.rule_id));
// 视觉栈围栏（G-VIS*，独立基线包）：presets 的 fence_bindings 校验必须并集，否则视觉岗被判"绑了不存在的围栏"
const visualFenceDoc = YAML.parse(readFileSync(join(BUNDLE, "fences/geo-growth-visual.yml"), "utf-8"));
const visualFenceRules: RuntimeRule[] = ((visualFenceDoc.rules ?? []) as Array<{ rule_id: string; name: string; level: RuntimeRule["level"]; is_baseline: boolean; match: { object_types: string[]; actions: string[] }; when: string }>).map(r => ({
  rule_id: r.rule_id, version: visualFenceDoc.version, name: r.name, level: r.level, is_baseline: r.is_baseline,
  objectTypes: r.match.object_types, actions: r.match.actions, when: r.when,
}));
for (const r of visualFenceRules) fenceIds.add(r.rule_id);
/**
 * 两个基线包（baseline + visual）的规则并集：E-04「rule_impact 引用的规则存在」必须按
 * **工作区已激活的全部围栏包**判定。2026-09-20 真机验收修复：该检查此前只装 baseline 规则，
 * 视觉岗正常引用 G-VIS2（block 级事实红线）被判「未知规则」——假失败，非产品缺陷。
 */
const allFenceRules: RuntimeRule[] = [...fenceRules, ...visualFenceRules];

/* ================= A · Bundle 完整性 ================= */
const a = C("A");
a("bundle.json 声明的全部资产路径存在", () => {
  // provides 既有数组资产（presets/skills/…），也有单值字符串（modelPolicy）——只校验数组项，
  // 否则字符串会被逐字符遍历，产生「缺失资产 m」这类假失败。
  for (const paths of Object.values(bundleJson.workloom.provides) as Array<string[] | string>) {
    if (!Array.isArray(paths)) continue;
    for (const p of paths) assert(existsSync(join(BUNDLE, p)), `缺失资产 ${p}`);
  }
});
a("27 个 preset（双域 16 + 视觉栈 2 + 获客用增 9，含 2 个 P2 条件岗）且 preset_key 唯一", () => {
  assert(presets.length === 27, `期望 27，实际 ${presets.length}`);
  assert(presetKeys.size === 27, "preset_key 重复");
});
a("preset 必填字段完整（含 prompt 三要素）", () => {
  for (const p of presets) {
    for (const k of ["preset_key", "name", "version", "kind", "description", "fence_bindings", "tools", "prompt", "write_back"])
      assert(p[k] !== undefined, `${p.preset_key} 缺 ${k}`);
    assert(p.prompt.role && Array.isArray(p.prompt.goals) && Array.isArray(p.prompt.constraints), `${p.preset_key} prompt 缺 role/goals/constraints`);
    assert(p.prompt.goals.length >= 2 && p.prompt.constraints.length >= 2, `${p.preset_key} prompt 专业度不足（goals/constraints 过少）`);
  }
});
a("fence_bindings 引用的围栏均存在", () => {
  for (const p of presets) for (const f of p.fence_bindings) assert(fenceIds.has(f), `${p.preset_key} 绑了不存在的围栏 ${f}`);
});
a("夜班编制覆盖跨时区值守（≥5 员 night_shift）", () => {
  const n = presets.filter(p => p.night_shift).map(p => p.preset_key);
  assert(n.length >= 5, `夜班员工不足：${n.join(",")}`);
  for (const k of ["visibility-watcher", "entity-inspector", "data-board-officer", "company-ceo"])
    assert(n.includes(k), `${k} 应为夜班（跨时区/凌晨巡检纪律）`);
});
a("围栏包与 bundle 声明一致，且全部 is_baseline（只可加严）", () => {
  /**
   * 旧断言写死"25 条（双域 17 + 获客 8）"，随包演进漂移成假失败（2026-09-24 实测 28 条）。
   * 这里改成**不变量**：磁盘围栏文件 = `bundle.json#provides.fences` 声明数，且规则全为基线。
   * 数量本身以包为准，不再在测试里维护第二份真相。
   */
  const declaredFenceFiles = JSON.parse(readFileSync(join(BUNDLE, "bundle.json"), "utf-8")).workloom.provides.fences as string[];
  const diskFenceFiles = readdirSync(join(BUNDLE, "fences")).filter((f) => /\.ya?ml$/i.test(f));
  assert(declaredFenceFiles.length === diskFenceFiles.length,
    `provides.fences=${declaredFenceFiles.length} 与磁盘围栏文件=${diskFenceFiles.length} 不一致`);
  assert(fenceRules.length > 0, "围栏规则为空");
  assert(fenceRules.every(r => r.is_baseline), "存在非基线规则");
});
a("GEO 三闸到位：G-GEO1 review / G-GEO2 block / G-GEO3 block", () => {
  const lv = (id: string) => fenceRules.find(r => r.rule_id === id)?.level;
  assert(lv("G-GEO1") === "review" && lv("G-GEO2") === "block" && lv("G-GEO3") === "block", "GEO 三闸级别不符");
});
a("对象模型 ≥28 类且双域核心对象在场", () => {
  assert(objectsJson.objects.length >= 28, `对象 ${objectsJson.objects.length} 类`);
  for (const t of ["query_set", "query_item", "visibility_snapshot", "citation_source", "entity_card", "client_archive", "intel_card", "geo_content", "inquiry", "battle_report", "backtest_record", "decision_memo", "commercial_doc"])
    assert(objectTypes.has(t), `缺核心对象 ${t}`);
});
a("阶段机：六阶段 + 三层客户 + 三条交付线", () => {
  assert(stagesJson.account_stages.length === 6, "六阶段机缺环");
  assert(stagesJson.customer_tiers.length === 3 && stagesJson.delivery_lines.length === 3, "客户分层/交付线缺失");
});
a("围栏 match 引用的对象类型均在对象模型内", () => {
  for (const r of fenceRules) for (const t of r.objectTypes)
    assert(objectTypes.has(t) || ["fence_rule", "circuit_breaker"].includes(t), `${r.rule_id} 引用未声明对象 ${t}`);
});
a("技能 frontmatter 完整且与 bundle.json 对齐", () => {
  const dirs = readdirSync(join(BUNDLE, "skills"));
  assert(dirs.length === 29, `技能数 ${dirs.length}`);
  for (const d of dirs) {
    const raw = readFileSync(join(BUNDLE, "skills", d, "SKILL.md"), "utf-8");
    const m = raw.match(/^---\n([\s\S]*?)\n---\n/);
    assert(m, `${d} 缺 frontmatter`);
    const fm = YAML.parse(m![1]!);
    assert(fm.name && fm.description, `${d} frontmatter 缺 name/description`);
  }
});
a("ui/cases 页码落在 web 实际路由 p1-p9", () => {
  const ui = JSON.parse(readFileSync(join(BUNDLE, "ui/cases.json"), "utf-8"));
  for (const c of ui.cases) assert(/^p[1-9]$/.test(c.page), `非法页码 ${c.page}`);
});
a("floor-scene 双域作战室工位 ≥10（16 员工循环分配）", () => {
  const fs = JSON.parse(readFileSync(join(BUNDLE, "floor-scene.json"), "utf-8"));
  assert(fs.stations.length >= 10, `工位 ${fs.stations.length}`);
});

/* ================= B · 围栏判定（纯函数正反例） ================= */
const b = C("B");
const J = (input: Parameters<typeof judge>[0]) => judge(input, fenceRules, fenceDoc.default_level ?? "review");
b("G9 公网发布 → review", () => {
  const v = J({ object: { type: "publish_task" }, action: "publish.execute", context: { platform_first_use: false, account_daily_published: 1 } });
  assert(v.level === "review", `期望 review 实得 ${v.level}`);
});
b("G9a 新平台首发 → review（首发标记命中）", () => {
  const v = J({ object: { type: "publish_task" }, action: "publish.execute", context: { platform_first_use: true, account_daily_published: 0 } });
  assert(v.level === "review" && v.triggeredBy.some(n => n.includes("首发")), "首发必审未命中");
});
b("G9b 日发第 5 条 → block 熔断", () => {
  const v = J({ object: { type: "publish_task" }, action: "publish.execute", context: { account_daily_published: 5, platform_first_use: false } });
  assert(v.level === "block", `日发超限未熔断：${v.level}`);
});
b("G9b 边界：日发第 4 条不熔断（仍 G9 review）", () => {
  const v = J({ object: { type: "publish_task" }, action: "publish.execute", context: { account_daily_published: 4, platform_first_use: false } });
  assert(v.level === "review" && !v.triggeredBy.some(n => n.includes("熔断")), "边界误判");
});
b("G10a 夸赞评论 → auto 放行", () => {
  const v = J({ object: { type: "comment_reply" }, action: "comment.reply", params: { intent: "praise" } });
  assert(v.level === "auto", `夸赞未自动：${v.level}`);
});
b("G10b 咨询评论 → review", () => {
  const v = J({ object: { type: "comment_reply" }, action: "comment.reply", params: { intent: "consult" } });
  assert(v.level === "review", `${v.level}`);
});
b("G10c 负面评论 → review（告警语义）", () => {
  const v = J({ object: { type: "comment_reply" }, action: "comment.reply", params: { intent: "negative", text: "体验一般" } });
  assert(v.level === "review", `${v.level}`);
});
b("G10c 投诉关键词命中（即使 intent 非负面）", () => {
  const v = J({ object: { type: "comment_reply" }, action: "comment.reply", params: { intent: "consult", text: "我要投诉你们" } });
  assert(v.level === "review" && v.triggeredBy.some(n => n.includes("投诉") || n.includes("负面")), "关键词升级未命中");
});
b("G10d 敏感评论 → block", () => {
  const v = J({ object: { type: "comment_reply" }, action: "comment.reply", params: { intent: "sensitive" } });
  assert(v.level === "block", `${v.level}`);
});
b("G12 投放加投 → review（不可降级）", () => {
  const v = J({ object: { type: "ads_campaign" }, action: "ads.boost", params: { amount: 500 } });
  assert(v.level === "review", `${v.level}`);
});
b("G15 报价文件外发 → review", () => {
  const v = J({ object: { type: "commercial_doc" }, action: "doc.send_external", params: { doc_type: "quote" } });
  assert(v.level === "review", `${v.level}`);
});
b("G15 兼容底座 deal_order/deal.send_external 口径", () => {
  const v = J({ object: { type: "deal_order" }, action: "deal.send_external", params: { doc_type: "contract" } });
  assert(v.level === "review", "deal 口径未兼容");
});
b("G15 非对外文件类型不命中（内部草稿 → default review 但不触发 G15）", () => {
  const v = J({ object: { type: "commercial_doc" }, action: "doc.send_external", params: { doc_type: "internal_draft" } });
  assert(!v.triggeredBy.some(n => n.includes("商务文件")), "内部草稿误触发 G15");
});
b("G16 异常登录 → block", () => {
  const v = J({ object: { type: "account_metric" }, action: "account.login", context: { login_anomaly: true } });
  assert(v.level === "block", `${v.level}`);
});
b("G16 防关联违规 → block", () => {
  const v = J({ object: { type: "account_metric" }, action: "account.session_bind", context: { association_risk: true } });
  assert(v.level === "block", `${v.level}`);
});
b("G16 正常登录放行（default review 不触发 G16）", () => {
  const v = J({ object: { type: "account_metric" }, action: "account.login", context: {} });
  assert(!v.triggeredBy.some(n => n.includes("防关联")), "正常登录误伤");
});
b("G-GEO1 GEO 内容外发 → review", () => {
  const v = J({ object: { type: "geo_content" }, action: "geo.publish", params: {}, context: { fact_check_passed: true } });
  assert(v.level === "review" && v.triggeredBy.some(n => n.includes("外发必审")), "G-GEO1 未命中");
});
b("G-GEO2 事实红线未过 → block（一票否决压过 G-GEO1）", () => {
  const v = J({ object: { type: "geo_content" }, action: "geo.publish", params: {}, context: { fact_check_passed: false } });
  assert(v.level === "block" && v.triggeredBy.some(n => n.includes("一票否决")), "红线未否决");
});
b("G-GEO2 实体锚点不一致（undefined 视为未过）", () => {
  const v = J({ object: { type: "geo_content" }, action: "content.submit", params: {}, context: {} });
  assert(v.level === "block", "缺校验标记应熔断");
});
b("G-GEO3 语料污染 → block", () => {
  const v = J({ object: { type: "geo_content" }, action: "geo.publish", params: { technique: "corpus_pollution" }, context: { fact_check_passed: true } });
  assert(v.level === "block" && v.triggeredBy.some(n => n.includes("灰帽")), "灰帽未熔断");
});
for (const [i, tech] of ["fake_multi_source", "machine_seeding", "mass_ai_spam"].entries()) {
  b(`G-GEO3 灰帽变种 ${tech} → block`, () => {
    const v = J({ object: { type: "citation_source" }, action: "source.submit", params: { technique: tech }, context: {} });
    assert(v.level === "block", `${tech} 未熔断`);
  });
}
b("G20 涉人设内容 → block（强制 L4）", () => {
  const v = J({ object: { type: "geo_content" }, action: "content.submit", params: { involves_persona: true }, context: { fact_check_passed: true } });
  assert(v.level === "block" && v.triggeredBy.some(n => n.includes("L4")), "G20 未命中");
});
b("G20 涉品牌表态评论回复 → block（压过 G10a 自动）", () => {
  const v = J({ object: { type: "comment_reply" }, action: "comment.reply", params: { intent: "praise", involves_brand_stance: true } });
  assert(v.level === "block", "品牌表态未被 G20 拦截（deny 优先）");
});
b("G17 未授权放宽围栏 → block", () => {
  const v = J({ object: { type: "fence_rule" }, action: "fence.relax", context: {} });
  assert(v.level === "block", `${v.level}`);
});
b("G17 L4 已批放宽 → 不触发 G17（放行或落 default）", () => {
  const v = J({ object: { type: "fence_rule" }, action: "fence.relax", context: { l4_approved: true } });
  assert(!v.triggeredBy.some(n => n.includes("只紧不松")) && v.level !== "block", "L4 已批仍被误拦");
});
b("G-GEO4 信源日发第 3 条 → block 熔断（对称 G9b）", () => {
  const v = J({ object: { type: "source_task" }, action: "geo.publish", params: {}, context: { account_daily_source_published: 3, fact_check_passed: true } });
  assert(v.level === "block" && v.triggeredBy.some(n => n.includes("信源日发")), "信源日发超限未熔断");
});
b("G-GEO4 边界：geo_content 外发不触发信源日发熔断（仍 G-GEO1 review）", () => {
  const v = J({ object: { type: "geo_content" }, action: "geo.publish", params: {}, context: { account_daily_source_published: 2, fact_check_passed: true } });
  assert(v.level === "review" && v.triggeredBy.some(n => n.includes("外发必审")) && !v.triggeredBy.some(n => n.includes("信源日发")), "信源日发边界误判");
});
b("G18 熔断触发 → auto 放行但留痕", () => {
  const v = J({ object: { type: "circuit_breaker" }, action: "breaker.trigger" });
  assert(v.level === "auto", `${v.level}`);
});
b("未命中读类动作 → 恒 auto（不进 default）", () => {
  // HP-02 口径：只读动词仅认 list/read/get/fetch/query/search/describe；emit 未知按写处理。
  // 本用例验证「读类未命中恒 auto」，样例必须用真正的只读动作（intel_card.list）。
  const v = J({ object: { type: "intel_card" }, action: "intel_card.list" });
  assert(v.level === "auto", `${v.level}`);
});
b("未命中写类动作 → default_level review", () => {
  const v = J({ object: { type: "intel_card" }, action: "price.adjust" });
  assert(v.level === "review", `${v.level}`);
});
b("DSL 求值异常 → block（宁可错杀）", () => {
  const bad: RuntimeRule[] = [{ rule_id: "X", version: "v1", name: "异常规则", level: "review", is_baseline: false, objectTypes: ["geo_content"], actions: ["geo.publish"], when: "params.x.y.z >" }];
  const v = judge({ object: { type: "geo_content" }, action: "geo.publish" }, bad, "review");
  assert(v.level === "block" && v.evalErrors.length > 0, "异常未按 block 处理");
});
b("G-GROW7 生命周期岗未激活 → block", () => {
  const v = J({ object: { type: "lifecycle_program" }, action: "lifecycle.touch.write", context: { p2_activated: false } });
  assert(v.level === "block", `${v.level}`);
});
b("G-GROW7 生命周期岗激活后放行（未命中其他规则 → 写类 default review）", () => {
  const v = J({ object: { type: "lifecycle_program" }, action: "lifecycle.touch.write", context: { p2_activated: true } });
  assert(v.level === "review", `${v.level}`);
});
b("G-GROW8 渠道增长岗未激活 → block", () => {
  const v = J({ object: { type: "partnership" }, action: "partnership.plan.write", context: { p2_activated: false } });
  assert(v.level === "block", `${v.level}`);
});
b("G-GROW8 渠道增长岗激活后放行（未命中其他规则 → 写类 default review）", () => {
  const v = J({ object: { type: "partnership" }, action: "partnership.plan.write", context: { p2_activated: true } });
  assert(v.level === "review", `${v.level}`);
});

/* ================= C · 种子与运行态 ================= */
const c = C("C");
c("工作区存在且行业为 geo-growth", async () => {
  const r = await q(`SELECT industry, stage FROM workspaces WHERE id=$1`, [WS]);
  assert(r.rows[0]?.industry === "geo-growth", `industry=${r.rows[0]?.industry}`);
});
c("组合编制全部 ready 落库（本包 27 岗 ⊆ 组合编制，无缺岗）", async () => {
  /**
   * 2026-09-20 真机验收修复：花名册权威 = 装配器组合编制（geo-growth + hotel + ai-video，
   * 同名遮蔽按主包裁决），与基座 seed.ts（ws-yunqi 组合编制全员）同口径；seed-geo 已按组合编制上岗。
   * 旧断言写死 27（只数本包），组合上岗后必然假失败；
   * 2026-09-24 进一步：**总数不再写死**（历史写死值 72 随岗位扩充漂移），改为装配器实时推导。
   */
  const r = await q(`SELECT count(*) n, count(distinct preset_key) d FROM agents WHERE workspace_id=$1 AND status='ready'`, [WS]);
  const total = Number(r.rows[0].n);
  const distinct = Number(r.rows[0].d);
  const expected = composeWorkforce("geo-growth").presets.size;
  assert(total === expected, `组合编制 agents=${total}（装配器期望 ${expected}）`);
  assert(distinct === total, `agents=${total}/distinct=${distinct}`);
  const missing = await q(
    `SELECT p.preset_key FROM (VALUES ${presets.map((_p, i) => `($${i + 2}::text)`).join(",")}) AS p(preset_key)
     LEFT JOIN agents a ON a.workspace_id=$1 AND a.preset_key=p.preset_key AND a.status='ready'
     WHERE a.id IS NULL`,
    [WS, ...presets.map((p) => String(p.preset_key))],
  );
  assert(missing.rows.length === 0, `本包未上岗：${missing.rows.map((x) => x.preset_key).join(",")}`);
});
c("员工 fence_bindings 原样落库（F2.10）", async () => {
  const r = await q(`SELECT preset_key, fence_bindings FROM agents WHERE workspace_id=$1 AND preset_key='geo-content-planner'`, [WS]);
  const fb = r.rows[0]?.fence_bindings as string[];
  assert(Array.isArray(fb) && fb.includes("G-GEO1") && fb.includes("G-GEO2"), "绑定丢失");
});
c("围栏按基线包全量 active 装载（库表 = 磁盘规则数）", async () => {
  const r = await q(`SELECT count(*) n FROM fence_rules WHERE workspace_id=$1 AND status='active' AND version='geo-growth-baseline/v1'`, [WS]);
  const expected = fenceRules.filter((rule) => rule.version === "geo-growth-baseline/v1").length;
  assert(Number(r.rows[0].n) === expected, `fences=${r.rows[0].n}（磁盘基线规则期望 ${expected}）`);
});
c("29 个 GEO 技能已安装（双域 6 + 视觉 14 + 获客用增 9）", async () => {
  const r = await q(`SELECT count(*) n FROM skill_installs si JOIN skills s ON s.id=si.skill_id WHERE si.workspace_id=$1 AND s.bundle='geo-growth'`, [WS]);
  assert(Number(r.rows[0].n) === 29, `skills=${r.rows[0].n}`);
});
c("14 个触发器 enable", async () => {
  const r = await q(`SELECT count(*) n FROM triggers WHERE workspace_id=$1 AND enabled=true`, [WS]);
  assert(Number(r.rows[0].n) === 14, `triggers=${r.rows[0].n}`);
});
c("一客一档 v2 七模块齐全", async () => {
  const r = await q(`SELECT archive FROM profiles WHERE workspace_id=$1`, [WS]);
  const arc = r.rows[0]?.archive as Record<string, unknown>;
  for (const m of ["enterprise", "entity_card", "target_market", "content_assets", "operation_assets", "geo_assets", "conversion_assets"])
    assert(arc?.[m] !== undefined, `缺模块 ${m}`);
});
c("品牌实体卡已经客户确认（confirmed=true）", async () => {
  const r = await q(`SELECT archive->'entity_card'->>'confirmed' c FROM profiles WHERE workspace_id=$1`, [WS]);
  assert(r.rows[0]?.c === "true", "实体卡未确认——GEO 权威源不成立");
});
c("query 集覆盖四词类（brand/category/scene/compare）", async () => {
  const r = await q(`SELECT archive->'geo_assets'->'query_set' qs FROM profiles WHERE workspace_id=$1`, [WS]);
  const types = new Set((r.rows[0]?.qs as { type: string }[]).map(x => x.type));
  for (const t of ["brand", "category", "scene", "compare"]) assert(types.has(t), `缺词类 ${t}`);
});
c("能见度基线五平台口径与存证纪律", async () => {
  const r = await q(`SELECT archive->'geo_assets'->'visibility_baseline' vb FROM profiles WHERE workspace_id=$1`, [WS]);
  const vb = r.rows[0]?.vb as { platforms: string[]; mention_rate: number };
  assert(vb?.platforms?.length === 4 && typeof vb.mention_rate === "number", "基线字段缺失");
});
c("数据边界声明在场（红线 R4）", async () => {
  const r = await q(`SELECT archive->'data_boundary'->>'rule' rule FROM profiles WHERE workspace_id=$1`, [WS]);
  assert(typeof r.rows[0]?.rule === "string" && (r.rows[0].rule as string).includes("留痕"), "数据边界缺失");
});
c("宪章 escalate 含 G20/G-GEO3/G17 条款", async () => {
  const r = await q(`SELECT archive->'charter'->'escalate' e FROM profiles WHERE workspace_id=$1`, [WS]);
  const e = (r.rows[0]?.e as string[]).join("|");
  assert(e.includes("G20") && e.includes("G-GEO3") && e.includes("G17"), "escalate 条款不全");
});
c("评论四档分流 route_level 正确映射", async () => {
  const r = await q(`SELECT intent, route_level, count(*) FROM comments WHERE workspace_id=$1 GROUP BY 1,2`, [WS]);
  const map = Object.fromEntries(r.rows.map(x => [x.intent, x.route_level]));
  assert(map.praise === "auto" && map.query === "review" && map.crisis === "review", JSON.stringify(map));
});
c("待批请示 tier 分层正确（G-GEO1→L2 / G12、G20→L4）", async () => {
  const r = await q(`SELECT snapshot->>'gate' gate, tier FROM approvals WHERE workspace_id=$1 AND status='pending'`, [WS]);
  const m = Object.fromEntries(r.rows.map(x => [x.gate, x.tier]));
  assert(m["G-GEO1"] === "l2_captain" && m["G12"] === "l4_chairman" && m["G20"] === "l4_chairman", JSON.stringify(m));
});
c("账号指标时序 7 天 × 2 账号", async () => {
  const r = await q(`SELECT count(*) n FROM account_metrics WHERE workspace_id=$1`, [WS]);
  assert(Number(r.rows[0].n) === 14, `metrics=${r.rows[0].n}`);
});
c("种子幂等：复跑后事件数不膨胀", async () => {
  const before = await q(`SELECT count(*) n FROM biz_events WHERE workspace_id=$1`, [WS]);
  const { execSync } = await import("node:child_process");
  execSync("pnpm db:seed:geo", { cwd: REPO_ROOT, stdio: "pipe", env: { ...process.env } });
  const after = await q(`SELECT count(*) n FROM biz_events WHERE workspace_id=$1`, [WS]);
  assert(before.rows[0].n === after.rows[0].n, `幂等破坏：${before.rows[0].n}→${after.rows[0].n}`);
});
c("哈希链完整（ws-geo 段）", async () => {
  const { execSync } = await import("node:child_process");
  const out = execSync("pnpm db:verify-chain", { cwd: REPO_ROOT, stdio: "pipe", env: { ...process.env } }).toString();
  assert(/逐条重算全部一致|全库验证通过/.test(out), "ws-geo 验链失败");
});

/* ================= D · 管线节拍一致性 ================= */
const d = C("D");
d("4 条管线 YAML 可解析且 quest key 唯一", () => {
  const keys = pipelines.map(p => p.doc.quest);
  assert(pipelines.length === 4 && new Set(keys).size === 4, keys.join(","));
});
d("管线 owner 全部在 16 员编制内", () => {
  for (const p of pipelines) for (const s of p.doc.steps ?? [])
    assert(presetKeys.has(s.owner), `${p.doc.quest}/${s.step_key} owner=${s.owner} 不在编制`);
});
d("管线 gate 引用的围栏存在", () => {
  for (const p of pipelines) for (const s of p.doc.steps ?? []) {
    if (!s.gate) continue;
    const id = String(s.gate);
    assert([...fenceIds].some(f => id === f || id.startsWith(f) || f.startsWith(id)), `${p.doc.quest}/${s.step_key} gate=${id} 无对应围栏`);
  }
});
d("管线 outputs 对象类型在对象模型内", () => {
  for (const p of pipelines) for (const s of p.doc.steps ?? [])
    for (const o of s.outputs ?? [])
      assert(objectTypes.has(o) || ["shoot_list", "source_task", "conflict_item", "script_package", "publish_task", "account_metric", "comment_reply", "inquiry", "decision_memo", "battle_report", "backtest_record", "commercial_doc", "client_archive", "visibility_snapshot", "intel_card", "geo_content"].includes(o),
        `${p.doc.quest}/${s.step_key} 产出未声明对象 ${o}`);
});
d("能见度日频 cron 与种子触发器一致（0 21）", async () => {
  const vp = pipelines.find(p => p.doc.quest === "visibility-watch");
  const cron = vp?.doc.steps.find((s: { step_key: string }) => s.step_key === "brand-daily")?.cron;
  const r = await q(`SELECT schedule FROM triggers WHERE id='tg-geo-visibility-brand'`);
  assert(cron === r.rows[0]?.schedule, `管线 ${cron} vs 触发器 ${r.rows[0]?.schedule}`);
});
d("全量周频 cron 与种子触发器一致（周一 09:00）", async () => {
  const vp = pipelines.find(p => p.doc.quest === "visibility-watch");
  const cron = vp?.doc.steps.find((s: { step_key: string }) => s.step_key === "full-weekly")?.cron;
  const r = await q(`SELECT schedule FROM triggers WHERE id='tg-geo-visibility-full'`);
  assert(cron === r.rows[0]?.schedule, `${cron} vs ${r.rows[0]?.schedule}`);
});
d("清晨决策包 08:30 与晨报节拍一致", async () => {
  const r = await q(`SELECT schedule FROM triggers WHERE id='tg-geo-morning-0830'`);
  assert(r.rows[0]?.schedule === "30 8 * * *", `${r.rows[0]?.schedule}`);
});
d("月度回测节拍存在（每月 1 日）", async () => {
  const r = await q(`SELECT schedule FROM triggers WHERE id='tg-geo-backtest-monthly'`);
  assert(r.rows[0]?.schedule?.startsWith("0 10 1"), `${r.rows[0]?.schedule}`);
});

/* ================= E · 事件留痕合规 ================= */
const e = C("E");
/**
 * 平台系统对象（不属于行业对象模型，事件合规检查统一豁免）：
 *   thread/task/approval/conversation = 门禁活火事件（dispatch/quest/审批流）
 *   company_ceo = CEO 节拍（晨报/裁决留痕）  client = 客户档案动作
 *   workspace = 工作区级动作   member = 身份流程（欢迎仪式进度/重播）
 *   store = 平台运行态（model.degraded 模型路由降级通告的落点）
 */
const SYSTEM_TYPES = new Set([
  "thread", "task", "approval", "conversation", "company_ceo", "client", "workspace", "member", "store",
  // review = 审批对象在事件里的平台别名（approval.gesture 的 object.type；2026-09-20 真机验收增补）
  "review",
  // secretary_reminder = 个人域（织伴「我的」）提醒对象：不属于行业对象模型（2026-09-20 三合一增补）
  "secretary_reminder",
]);
e("ws-geo 事件 ≥60 条且五元字段完整（容忍门禁活火写入）", async () => {
  const r = await q(`SELECT count(*) n FROM biz_events WHERE workspace_id=$1`, [WS]);
  assert(Number(r.rows[0].n) >= 60, `events=${r.rows[0].n}`);
  // 门禁活火事件（thread/task 对象：dispatch/quest/审批流）与身份流程事件（member：欢迎仪式
  // 进度/重播，由 onboarding-continuity 直接落账，不是模型工具调用）属系统面事件，
  // receipt/model_trace 豁免（D31）——2026-09-19 真机复盘：/onboarding 走过一次即写入
  // onboarding.welcome.progress(member)，旧白名单没有 member，geo 套件因此假失败。
  /**
   * 回执位口径（2026-09-19 真机复盘修订）：receipt 只对**已执行事件**（decision.after 非空）强制——
   *   · 越围栏挂起（review/block）事件按设计没有回执：动作尚未发生，写回执反而是伪造回执；
   *   · 已执行但无真实外部回执的步骤，运行时写 receipt.synced=false 标「未核实」（E3.7），
   *     字段仍必须在位，好让下游区分「未核实」与「缺字段」；
   *   · 只读步骤/模型降级通告（model.degraded）没有 after，天然落在本检查之外。
   * 因此收敛为「已执行 → 五元必须齐」，不放宽已执行事件的回执纪律，也不把挂起当数据缺陷。
   */
  const bad = await q(`SELECT count(*) n FROM biz_events WHERE workspace_id=$1
    AND payload->'decision'->'after' IS NOT NULL
    AND COALESCE(payload->'object'->>'type','') <> ALL($2::text[])
    AND (payload->>'who' IS NULL OR payload->>'object' IS NULL OR payload->>'decision' IS NULL OR payload->>'receipt' IS NULL OR payload->>'model_trace' IS NULL)`, [WS, [...SYSTEM_TYPES]]);
  assert(Number(bad.rows[0].n) === 0, `五元缺失 ${bad.rows[0].n} 条`);
});
e("事件 GEO 对象类型全部在对象模型内（系统对象豁免）", async () => {
  const r = await q(`SELECT DISTINCT payload->'object'->>'type' t FROM biz_events WHERE workspace_id=$1`, [WS]);
  for (const row of r.rows) assert(objectTypes.has(row.t) || SYSTEM_TYPES.has(row.t), `事件对象 ${row.t} 未在对象模型`);
});
e("事件 who 全部在编制内（系统/人类豁免）", async () => {
  // model-router = 平台模型路由组件（缺省/降级时写 model.degraded 留痕），与 captain/fleet 同属系统身份
  const SYSTEM_ACTORS = new Set([
    "morning-briefing", "captain", "fleet", "im-channels", "model-router",
    // night-shift = 夜班调度器（night_runs / 决策包投递的留痕主体；2026-09-20 真机验收增补）
    "night-shift",
    // render-poller = 视频渲染轮询回填器（Seedance 异步任务第二步的留痕主体；2026-09-20 真机测试增补）
    "render-poller",
    // render-operator = 渲染提交的生成池计量主体（gen.degraded / 提交留痕；2026-09-20 真机测试增补）
    "render-operator",
  ]);
  const r = await q(`SELECT DISTINCT payload->'who'->>'id' id FROM biz_events WHERE workspace_id=$1`, [WS]);
  for (const row of r.rows) assert(presetKeys.has(row.id) || SYSTEM_ACTORS.has(row.id) || String(row.id).startsWith("MEM-"), `who=${row.id} 不在编制`);
});
e("rule_impact 引用的规则存在且级别一致", async () => {
  const r = await q(`SELECT DISTINCT ri->>'rule_id' rid, ri->>'result' res FROM biz_events, jsonb_array_elements(payload->'rule_impact') ri WHERE workspace_id=$1`, [WS]);
  for (const row of r.rows) {
    const rule = allFenceRules.find(x => x.rule_id === row.rid);
    assert(rule, `rule_impact 引用未知规则 ${row.rid}`);
    assert(["pass", "review", "blocked"].includes(row.res), `${row.rid} 非法 result=${row.res}`);
  }
});
e("能见度采集事件带原始答案截图存证", async () => {
  const r = await q(`SELECT count(*) n FROM biz_events WHERE workspace_id=$1 AND payload->'decision'->>'action'='visibility.collect' AND payload->'receipt'->>'snapshot_uri' IS NOT NULL`, [WS]);
  assert(Number(r.rows[0].n) >= 5, `存证不足 ${r.rows[0].n}`);
});
e("双入口询盘打标事件两种入口均在（social + ai_search）", async () => {
  const r = await q(`SELECT DISTINCT payload->'decision'->'after'->>'entry' entry FROM biz_events WHERE workspace_id=$1 AND payload->'decision'->>'action'='inquiry.tag'`, [WS]);
  const entries = new Set(r.rows.map(x => x.entry));
  assert(entries.has("social") && entries.has("ai_search"), `入口不全：${[...entries].join(",")}`);
});

/* ================= 执行 ================= */
const passed: string[] = [];
const failed: Array<{ id: string; name: string; err: string }> = [];
for (const c of cases) {
  try {
    await c.run();
    passed.push(c.id);
    console.log(`✓ ${c.id} ${c.name}`);
  } catch (err) {
    failed.push({ id: c.id, name: c.name, err: err instanceof Error ? err.message : String(err) });
    console.log(`✗ ${c.id} ${c.name} —— ${failed[failed.length - 1]!.err}`);
  }
}
await app.end();

console.log(`\n════════ GEO 双域用例：${passed.length}/${cases.length} 通过 ════════`);
if (failed.length) {
  console.log("失败清单：");
  for (const f of failed) console.log(`  ✗ ${f.id} ${f.name} —— ${f.err}`);
  process.exit(1);
}
