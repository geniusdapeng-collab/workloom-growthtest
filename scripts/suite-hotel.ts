/**
 * scripts/suite-hotel.ts · 酒店垂直经营系统深度测试套件（v3.3 获客域）
 *
 * 覆盖：A Bundle 完整性 / B 围栏判定正反例（R21-R26 获客域 + 关键基线）/
 *       C 种子与运行态 / D 管线与客群分型 / E 获客事件留痕合规
 * 用法：pnpm suite:hotel（要求 .env 就位、PG 已迁移 + pnpm db:seed）
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
const BUNDLE = join(REPO_ROOT, "bundles/hotel");
const APP_URL = process.env.DATABASE_APP_URL ?? "postgres://workloom_app:workloom_dev_app@localhost:5432/workloom";
const app = new pg.Client({ connectionString: APP_URL });
const WS = "ws-yunqi";
const TENANT = "tenant-demo";
const FENCE_VERSION = "hotel-baseline/v4";

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
const fenceDoc = YAML.parse(readFileSync(join(BUNDLE, "fences/hotel-baseline.yml"), "utf-8"));
const fenceRules: RuntimeRule[] = (fenceDoc.rules ?? []).map((r: { rule_id: string; name: string; level: RuntimeRule["level"]; is_baseline: boolean; match: { object_types: string[]; actions: string[] }; when: string }) => ({
  rule_id: r.rule_id, version: fenceDoc.version, name: r.name, level: r.level, is_baseline: r.is_baseline,
  objectTypes: r.match.object_types, actions: r.match.actions, when: r.when,
}));
const objectsJson = JSON.parse(readFileSync(join(BUNDLE, "schemas/objects.json"), "utf-8"));
const objectTypes = new Set<string>(objectsJson.objects.map((o: { type: string }) => o.type));
const pipelines = readdirSync(join(BUNDLE, "pipelines")).filter(f => f.endsWith(".yml")).sort()
  .map(f => ({ file: f, doc: YAML.parse(readFileSync(join(BUNDLE, "pipelines", f), "utf-8")) }));
const segmentDefaults = YAML.parse(readFileSync(join(BUNDLE, "segment-defaults.yml"), "utf-8"));
const connectors = JSON.parse(readFileSync(join(BUNDLE, "connectors/connectors.json"), "utf-8"));
const presetKeys = new Set<string>(presets.map(p => p.preset_key));
const fenceIds = new Set<string>(fenceRules.map(r => r.rule_id));
const skillDirs = readdirSync(join(BUNDLE, "skills")).filter(d => existsSync(join(BUNDLE, "skills", d, "SKILL.md")));

const J = (input: Parameters<typeof judge>[0]) => judge(input, fenceRules, "review");

/* ================= A · Bundle 完整性 ================= */
const a = C("A");
a("bundle.json 声明的全部资产路径存在", () => {
  // provides 既有数组资产（presets/skills/…），也有单值字符串（modelPolicy）——只校验数组项，
  // 否则字符串会被逐字符遍历，产生「缺失资产 m」这类假失败（组合包同样适用）。
  for (const paths of Object.values(bundleJson.workloom.provides) as Array<string[] | string>) {
    if (!Array.isArray(paths)) continue;
    for (const p of paths) assert(existsSync(join(BUNDLE, p)), `缺失资产 ${p}`);
  }
});
a("16 个 preset（运营 11 + 获客 4 + 指挥 1）且 preset_key 唯一", () => {
  assert(presets.length === 16, `期望 16，实际 ${presets.length}`);
  assert(presetKeys.size === 16, "preset_key 重复");
  for (const k of ["ai-receptionist", "coupon-operator", "guest-success", "channel-watcher"])
    assert(presetKeys.has(k), `获客员工缺失 ${k}`);
});
a("preset 必填字段完整（含 prompt 三要素）", () => {
  for (const p of presets) {
    for (const k of ["preset_key", "name", "version", "kind", "description", "fence_bindings", "tools", "prompt", "write_back"])
      assert(p[k] !== undefined, `${p.preset_key} 缺 ${k}`);
    assert(p.prompt.role && Array.isArray(p.prompt.goals) && Array.isArray(p.prompt.constraints), `${p.preset_key} prompt 三要素不全`);
  }
});
a("围栏 v4 共 26 条且全部 is_baseline", () => {
  assert(fenceDoc.version === FENCE_VERSION, `版本 ${fenceDoc.version}`);
  assert(fenceRules.length === 26, `期望 26，实际 ${fenceRules.length}`);
  for (const r of fenceRules) assert(r.is_baseline === true, `${r.rule_id} 未标 baseline`);
});
a("获客域围栏 R21-R26 齐备且级别正确", () => {
  const want: Record<string, string> = { R21: "review", R22: "block", R23: "review", R24: "block", R25: "review", R26: "block" };
  for (const [id, level] of Object.entries(want)) {
    const r = fenceRules.find(x => x.rule_id === id);
    assert(r, `缺 ${id}`);
    assert(r!.level === level, `${id} level=${r!.level} ≠ ${level}`);
  }
});
a("30 个技能目录且 frontmatter 合法", () => {
  assert(skillDirs.length === 30, `期望 30，实际 ${skillDirs.length}`);
  for (const d of skillDirs) {
    const raw = readFileSync(join(BUNDLE, "skills", d, "SKILL.md"), "utf-8");
    const m = raw.match(/^---\n([\s\S]*?)\n---\n/);
    assert(m, `${d} 缺 frontmatter`);
    const fm = YAML.parse(m![1]!);
    assert(fm.name && fm.description, `${d} frontmatter 缺 name/description`);
  }
});
a("对象模型 28 类（含 7 类获客对象 + content）", () => {
  assert(objectTypes.size === 28, `期望 28，实际 ${objectTypes.size}`);
  for (const t of ["intent_signal", "lead", "coupon_sku", "booking_order", "poi_store", "conversion", "live_campaign"])
    assert(objectTypes.has(t), `获客对象缺失 ${t}`);
});
a("围栏 match 引用的对象类型全部在对象模型内", () => {
  for (const r of fenceRules)
    for (const t of r.objectTypes) assert(objectTypes.has(t), `${r.rule_id} 引用未知对象 ${t}`);
});
a("preset fence_bindings 引用的围栏均存在", () => {
  for (const p of presets)
    for (const f of p.fence_bindings as string[]) assert(fenceIds.has(f), `${p.preset_key} 绑定未知围栏 ${f}`);
});
a("外部连接器清单 4 件且 mock 先行", () => {
  assert(connectors.connectors.length === 4, "连接器数量");
  for (const c of connectors.connectors) assert(c.driver === "mock", `${c.key} 非 mock`);
});

/* ================= B · 围栏判定正反例 ================= */
const b = C("B");
b("R21 AI 接待含报价承诺 → review", () => {
  const v = J({ object: { type: "lead" }, action: "lead.reply", params: { body: "给您申请了特价优惠，今晚 299 保证最低" } });
  assert(v.level === "review" && v.triggeredBy.some(n => n.includes("报价承诺")), `应人审，实际 ${v.level}`);
});
b("R21 边界：纯 FAQ 应答无承诺词 → auto", () => {
  const v = J({ object: { type: "lead" }, action: "lead.reply", params: { body: "早餐 06:30-10:00，一楼全日制餐厅" } });
  assert(!v.triggeredBy.some(n => n.includes("报价承诺")), "纯 FAQ 不应触发 R21");
});
b("R22 券售罄后推广 → block 熔断", () => {
  const v = J({ object: { type: "coupon_sku" }, action: "coupon.promote", params: {}, context: { coupon_stock: 0 } });
  assert(v.level === "block" && v.triggeredBy.some(n => n.includes("库存熔断")), "售罄推广未熔断");
});
b("R22 边界：库存充足推广 → 不触发 block", () => {
  const v = J({ object: { type: "coupon_sku" }, action: "coupon.promote", params: {}, context: { coupon_stock: 50 } });
  assert(!v.triggeredBy.some(n => n.includes("库存熔断")), "库存充足不应熔断");
});
b("R23 线索导出 → 恒 review（无条件）", () => {
  const v = J({ object: { type: "lead" }, action: "lead.export", params: { desensitized: true, batch_size: 10 } });
  assert(v.level === "review", `出域必审，实际 ${v.level}`);
});
b("R24 未脱敏批量导出 → block（与 R23 并集 deny 优先）", () => {
  const v = J({ object: { type: "lead" }, action: "lead.export", params: { desensitized: false, batch_size: 200 } });
  assert(v.level === "block" && v.triggeredBy.some(n => n.includes("隐私红线")), "未脱敏批量导出未熔断");
});
b("R24 边界：脱敏且小批量 → 不触发 block", () => {
  const v = J({ object: { type: "lead" }, action: "lead.export", params: { desensitized: true, batch_size: 10 } });
  assert(!v.triggeredBy.some(n => n.includes("隐私红线")), "脱敏小批量不应熔断");
});
b("R25 获客内容未经事实校验 → review", () => {
  const v = J({ object: { type: "campaign" }, action: "campaign.publish", params: { fact_check_passed: false } });
  assert(v.level === "review" && v.triggeredBy.some(n => n.includes("口径校验")), "未校验内容未拦截");
});
b("R25 边界：口径校验通过 → auto", () => {
  const v = J({ object: { type: "campaign" }, action: "campaign.publish", params: { fact_check_passed: true, caliber_mismatch: false } });
  assert(!v.triggeredBy.some(n => n.includes("口径校验")), "已过校验不应人审");
});
b("R26 券价击穿保底价×0.85 → block", () => {
  const v = J({ object: { type: "coupon_sku" }, action: "coupon.create", params: { price: 299 }, context: { floor_price: 380 } });
  assert(v.level === "block" && v.triggeredBy.some(n => n.includes("定价红线")), `299 < 323 未熔断`);
});
b("R26 边界：券价 339 ≥ 323 → 不熔断", () => {
  const v = J({ object: { type: "coupon_sku" }, action: "coupon.create", params: { price: 339 }, context: { floor_price: 380 } });
  assert(!v.triggeredBy.some(n => n.includes("定价红线")), "339 不应熔断");
});
b("基线回归：R2 保底价熔断仍生效", () => {
  const v = J({ object: { type: "room_price" }, action: "price.adjust", params: { price: 350 }, context: { floor_price: 380 } });
  assert(v.level === "block", "R2 保底价熔断失效");
});

/* ================= C · 种子与运行态 ================= */
const c = C("C");
c("16 个酒店岗全部在编（组合编制全员在编）", async () => {
  /**
   * 组合编制口径（hotel + ai-video + geo-growth，主包 geo-growth 裁决同名遮蔽）：
   * 期望总数**从装配器实时推导**，不再写死数字——2026-09-24 实测 78 岗
   * （历史写死值 72 已随岗位扩充漂移，导致本用例长期误报）。
   * 种子走的是同一个 provisionComposedWorkforce（scripts/seed.ts），所以两者必然一致。
   */
  const expected = composeWorkforce("geo-growth").presets.size;
  const all = await q(`SELECT count(*) n FROM agents WHERE workspace_id=$1`, [WS]);
  assert(Number(all.rows[0].n) === expected, `组合编制 agents=${all.rows[0].n}（装配器期望 ${expected}）`);
  const hotel = await q(
    `SELECT count(*) n FROM agents WHERE workspace_id=$1 AND (meta->>'sourceBundleId' = 'hotel' OR meta->>'sourceBundleId' IS NULL)`,
    [WS],
  );
  assert(Number(hotel.rows[0].n) === 16, `酒店岗=${hotel.rows[0].n}`);
});
c("获客 4 员工在编且 preset 夜班声明正确", async () => {
  const r = await q(`SELECT preset_key FROM agents WHERE workspace_id=$1 AND preset_key IN ('ai-receptionist','coupon-operator','guest-success','channel-watcher')`, [WS]);
  assert(r.rowCount === 4, "获客员工缺编");
  const nightMap = Object.fromEntries(presets.map(p => [p.preset_key, p.night_shift === true]));
  assert(nightMap["ai-receptionist"] === true && nightMap["channel-watcher"] === true, "承接/哨兵应声明夜班");
});
c("26 条围栏 v4 active（单一版本）", async () => {
  const r = await q(`SELECT count(*) n FROM fence_rules WHERE workspace_id=$1 AND status='active' AND version=$2`, [WS, FENCE_VERSION]);
  assert(Number(r.rows[0].n) === 26, `fences=${r.rows[0].n}`);
  const dup = await q(`SELECT rule_id, count(*) n FROM fence_rules WHERE workspace_id=$1 AND status='active' GROUP BY rule_id HAVING count(*)>1`, [WS]);
  assert(dup.rowCount === 0, `同 rule_id 多 active 版本：${JSON.stringify(dup.rows)}`);
});
c("29 个技能安装且快照落库", async () => {
  const r = await q(`SELECT count(*) n FROM skill_installs si JOIN skills s ON s.id=si.skill_id WHERE si.workspace_id=$1 AND s.level='official'`, [WS]);
  assert(Number(r.rows[0].n) >= 29, `installs=${r.rows[0].n}`);
  const snap = await q(`SELECT count(*) n FROM skill_installs WHERE workspace_id=$1 AND fence_bindings_snapshot IS NULL`, [WS]);
  assert(Number(snap.rows[0].n) === 0, "存在空快照");
});
c("获客技能绑定正确（lead-concierge 含 R21/R24）", async () => {
  const r = await q(`SELECT s.fence_bindings FROM skills s WHERE s.name='lead-concierge'`);
  const binds = r.rows[0]?.fence_bindings as string[];
  assert(binds?.includes("R21") && binds?.includes("R24"), `lead-concierge 绑定 ${binds}`);
});
c("12 个触发器（含获客 2 个）", async () => {
  const r = await q(`SELECT count(*) n FROM triggers WHERE workspace_id=$1 AND enabled=true`, [WS]);
  assert(Number(r.rows[0].n) >= 12, `triggers=${r.rows[0].n}`);
  const acq = await q(`SELECT id FROM triggers WHERE workspace_id=$1 AND id IN ('tg-intent-radar-0700','tg-lead-follow-30min')`, [WS]);
  assert(acq.rowCount === 2, "获客触发器缺失");
});
c("获客域剧本事件 30 条全部落库", async () => {
  const r = await q(`SELECT count(*) n FROM biz_events WHERE workspace_id=$1 AND event_id >= 'E-SEED-8901' AND event_id <= 'E-SEED-8930'`, [WS]);
  assert(Number(r.rows[0].n) === 30, `获客事件=${r.rows[0].n}`);
});
c("一店一档含获客字段组（query 集/POI/漏斗目标）", async () => {
  const r = await q(`SELECT archive FROM profiles WHERE workspace_id=$1 LIMIT 1`, [WS]);
  const acq = (r.rows[0]?.archive as { acquisition?: { query_set?: unknown; poi?: unknown } })?.acquisition;
  assert(acq?.query_set && acq?.poi, "档案缺 acquisition 字段组");
});

/* ================= D · 管线与客群分型 ================= */
const d = C("D");
d("获客主链路管线 9 步且 owner 全部在编", () => {
  const p = pipelines.find(x => x.doc.quest === "hotel-acquisition-loop");
  assert(p, "缺 hotel-acquisition-loop 管线");
  assert(p!.doc.steps.length === 9, `管线步数=${p!.doc.steps.length}`);
  for (const st of p!.doc.steps) assert(presetKeys.has(st.owner), `管线 owner ${st.owner} 不在编`);
});
d("管线 gates 引用的围栏均存在", () => {
  const p = pipelines.find(x => x.doc.quest === "hotel-acquisition-loop")!;
  for (const st of p.doc.steps)
    for (const g of (st.gates ?? []) as string[]) assert(fenceIds.has(g), `gate ${g} 无对应围栏`);
});
d("管线五环顺序正确（雷达→排期→发布→承接→分级→转化→归因→复购→复盘）", () => {
  const p = pipelines.find(x => x.doc.quest === "hotel-acquisition-loop")!;
  const keys = p.doc.steps.map((s: { step_key: string }) => s.step_key);
  const want = ["intent-radar", "content-schedule", "dual-publish", "reception", "lead-grading", "coupon-convert", "attribution", "guest-retention", "funnel-review"];
  assert(JSON.stringify(keys) === JSON.stringify(want), `五环顺序 ${keys.join("→")}`);
});
d("四客群分型齐备；托管型三客群均含获客组", () => {
  const segs = Object.keys(segmentDefaults.segments);
  assert(segs.length === 4, `客群数=${segs.length}`);
  for (const [k, seg] of Object.entries(segmentDefaults.segments) as [string, { presets: string[]; skills_ordered: string[]; fence_patch: string }][]) {
    // audit_only 为只读体检期（零风险先行，无写通道），不装配获客组——托管型客群才校验
    if (k !== "audit_only") {
      for (const ap of ["ai-receptionist", "coupon-operator", "guest-success", "channel-watcher"])
        assert(seg.presets.includes(ap), `${k} 缺获客员工 ${ap}`);
      for (const sk of ["lead-concierge", "coupon-ops", "hotel-geo-content", "intent-radar"])
        assert(seg.skills_ordered.includes(sk), `${k} 缺获客技能 ${sk}`);
    }
    assert(existsSync(join(BUNDLE, seg.fence_patch)), `${k} patch 缺失`);
  }
});
d("民宿客群获客技能前置（content-marketing 之后）", () => {
  const seg = segmentDefaults.segments.homestay.skills_ordered as string[];
  const cm = seg.indexOf("content-marketing");
  const ir = seg.indexOf("intent-radar");
  assert(cm >= 0 && ir > cm && ir <= cm + 2, `民宿获客技能未前置（cm=${cm}, ir=${ir}）`);
});
d("客群 patch 与基线单调守卫（只紧不松）", () => {
  for (const f of readdirSync(join(BUNDLE, "fences/patches")).filter(x => x.endsWith(".yml"))) {
    const patch = YAML.parse(readFileSync(join(BUNDLE, "fences/patches", f), "utf-8"));
    for (const pr of patch.rules ?? []) {
      const base = fenceRules.find(x => x.rule_id === pr.rule_id);
      if (!base) continue;
      const rank = { auto: 0, review: 1, block: 2 } as const;
      assert(rank[pr.level as keyof typeof rank] >= rank[base.level], `${f} 的 ${pr.rule_id} 放宽了基线（${base.level}→${pr.level}）`);
    }
  }
});

/* ================= E · 获客事件留痕合规 ================= */
const e = C("E");
e("获客事件对象类型全部在对象模型内", async () => {
  const r = await q(`SELECT DISTINCT payload->'object'->>'type' t FROM biz_events WHERE workspace_id=$1 AND event_id >= 'E-SEED-8901' AND event_id <= 'E-SEED-8930'`, [WS]);
  for (const row of r.rows) assert(objectTypes.has(row.t), `事件对象 ${row.t} 未在对象模型`);
});
e("获客事件 who 全部在编", async () => {
  const r = await q(`SELECT DISTINCT payload->'who'->>'id' id FROM biz_events WHERE workspace_id=$1 AND event_id >= 'E-SEED-8901' AND event_id <= 'E-SEED-8930'`, [WS]);
  for (const row of r.rows) assert(presetKeys.has(row.id), `who=${row.id} 不在编`);
});
e("获客事件五元字段完整", async () => {
  const r = await q(`SELECT count(*) n FROM biz_events WHERE workspace_id=$1 AND event_id >= 'E-SEED-8901' AND event_id <= 'E-SEED-8930' AND (payload->>'who' IS NULL OR payload->>'object' IS NULL OR payload->>'decision' IS NULL OR payload->>'receipt' IS NULL OR payload->>'model_trace' IS NULL)`, [WS]);
  assert(Number(r.rows[0].n) === 0, `五元缺失 ${r.rows[0].n} 条`);
});
e("rule_impact 引用的规则均存在且版本正确", async () => {
  const r = await q(`SELECT DISTINCT ir->>'rule_id' rid, ir->>'version' ver FROM biz_events, jsonb_array_elements(payload->'rule_impact') ir WHERE workspace_id=$1 AND event_id >= 'E-SEED-8901' AND event_id <= 'E-SEED-8930'`, [WS]);
  for (const row of r.rows) {
    assert(fenceIds.has(row.rid), `未知规则 ${row.rid}`);
    assert(row.ver === FENCE_VERSION, `${row.rid} 版本 ${row.ver} ≠ ${FENCE_VERSION}`);
  }
});
e("R22 熔断事件留痕（阻断样本存在）", async () => {
  const r = await q(`SELECT count(*) n FROM biz_events, jsonb_array_elements(payload->'rule_impact') ir WHERE workspace_id=$1 AND ir->>'rule_id'='R22' AND ir->>'result'='blocked'`, [WS]);
  assert(Number(r.rows[0].n) >= 1, "R22 阻断样本缺失");
});
e("归因事件含来源链与佣金对照（北极星数据）", async () => {
  const r = await q(`SELECT payload->'decision'->'after' aft FROM biz_events WHERE workspace_id=$1 AND payload->'decision'->>'action'='conversion.attribute' LIMIT 1`, [WS]);
  const aft = r.rows[0]?.aft as { by_entry?: unknown; ota_commission_saved?: unknown };
  assert(aft?.by_entry && aft?.ota_commission_saved, "归因缺来源链/佣金对照");
});
e("线索事件客资已脱敏（无明文手机号）", async () => {
  // 批量留资事件（count 口径）无单体 contact 字段，只校验含 contact_masked 的单体线索事件
  const r = await q(`SELECT payload->'decision'->'after'->>'contact_masked' cm FROM biz_events WHERE workspace_id=$1 AND payload->'decision'->>'action'='lead.capture' AND payload->'decision'->'after'->>'contact_masked' IS NOT NULL`, [WS]);
  assert(r.rowCount! >= 2, "线索样本不足");
  for (const row of r.rows) assert(String(row.cm).includes("****"), `客资未脱敏 ${row.cm}`);
});

/* ================= 执行 ================= */
let pass = 0;
const failed: Array<{ id: string; name: string; err: string }> = [];
for (const cse of cases) {
  try {
    await cse.run();
    pass += 1;
    console.log(`✓ ${cse.id} ${cse.name}`);
  } catch (err) {
    failed.push({ id: cse.id, name: cse.name, err: err instanceof Error ? err.message : String(err) });
    console.log(`✗ ${cse.id} ${cse.name} —— ${err instanceof Error ? err.message : String(err)}`);
  }
}
console.log(`\n套件总报告：${pass}/${cases.length} 通过，${failed.length} 失败`);
if (appReady) await app.end();
process.exit(failed.length > 0 ? 1 : 0);
