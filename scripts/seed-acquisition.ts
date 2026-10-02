/**
 * scripts/seed-acquisition.ts · 获客饱满运行态增强包（SALES-DEMO）
 *
 * 目的：让云栖酒店工作区呈现「获客丰厚」的完整运行态——
 *   ① account_metrics 近 30 天平台经营指标（4 账号日更 + 6 条爆款内容）；
 *   ② 近 48 小时高密度获客剧本事件 ×36（询盘秒回/线索/成交/券/GEO 上榜/归因周报）；
 *   ③ 3 条高含金量待审批（协议价/券定价/线索出域——R21/R22/R23 必审场景）。
 * 用法：pnpm db:seed:acq（幂等：指标按 acc-seed- 前缀清写、事件存在即跳过、审批同 ID 跳过）
 * 纪律：与 scripts/seed.ts 同——事件走 append_event_insert 特权函数 + E-SEED- 前缀 + zod 校验。
 */
import pg from "pg";
import { alignReadableIdSequences, eventHash, safeParseReplayAwareEvent } from "@workloom/base/workdata";

const DATABASE_URL = process.env.DATABASE_URL ?? "postgres://postgres:workloom@localhost:5432/workloom";
const GATEWAY_URL = process.env.DATABASE_GATEWAY_URL ?? "postgres://workloom_gateway:workloom_dev_gateway@localhost:5432/workloom";
const TENANT_ID = "tenant-demo";
const WS_ID = "ws-yunqi";
const WS_NAME = "云栖酒店";
const FENCE_VERSION = "hotel-baseline/v4";
const GENESIS_HASH = "GENESIS";

const now = Date.now();
const at = (minAgo: number) => new Date(now - minAgo * 60_000).toISOString();
const who = (id: string, version = "v3.0") => ({ type: "agent" as const, id, version });
const ctx = (time: string) => ({ tenant_id: TENANT_ID, workspace_id: WS_ID, time, stage: "stable", store: WS_NAME });
const mt = { model_id: "mock-hotel-001", tier: "standard", window: "peak", credits: 1 };
const receipt = (time: string) => ({ synced: true, snapshot_uri: "data/snapshots/acq.png", verified_at: time });
const ri = (rule_id: string, result = "pass") => [{ rule_id, version: FENCE_VERSION, result }];

/* ---------- ① 近 48h 获客剧本事件 ---------- */
const Q = [
  ["带娃住，酒店有儿童乐园吗？周末两大一小", "有的，3 层亲子乐园 9:00-21:00 免费开放，周末亲子双床房 ¥658 含三早，现在订送乐园快通卡"],
  ["明天出差到杭州，能开发票吗？支持延迟退房吗", "支持增值税专票/普票；商旅客人可免费延迟到 14:00 退房，需要帮您预留高楼层安静房吗"],
  ["你们家隔音怎么样？之前住别家被吵死", "本店 2024 年全楼层做过静音改造，实测夜间 ≤35 分贝，不满意首晚可免费换房"],
  ["有停车场吗？怎么收费", "地下两层停车场住客免费，特斯拉/蔚来充电桩 8 个，到店报房号激活"],
  ["早餐几点到几点？孩子 1.2 米收费吗", "6:30-10:30（周末到 11:00），1.2 米以下免费、1.2-1.4 米半价 ¥34"],
  ["西湖边步行能到吗？附近有什么逛的", "步行 12 分钟到西湖天地，楼下就是地铁 2 号线，武林夜市 800 米"],
  ["协议客户怎么订？我们是附近公司", "可签企业协议价（门市价 88 折 + 含早 + 月结），稍后给您发协议模板"],
  ["今晚还有房吗？两间大床", "有的，高级大床房今晚 ¥628，连订两间给您按 ¥598/间并备注相邻"],
  ["退房时间是几点？航班比较晚", "12:00 退房，可寄存行李；金卡会员可延到 16:00，今天帮您申请到 15:00 可以吗"],
  ["看到抖音你们有个亲子套餐，还能买吗", "「亲子 2 天 1 晚」套餐本周还有 14 份，¥799 含双早+乐园+旅拍，我发您下单链接"],
  ["会议室能租半天吗？20 人左右", "3 楼多功能厅半天 ¥1,200 含茶水投屏，今天 14:00 后有空档，可先来踩点"],
  ["长住一周有优惠吗", "连住 5 晚起 92 折、7 晚起 88 折含双早，长住房每周布草深度清洁两次"],
] as const;
const LEADS = [
  ["张女士 · 亲子客群", "周末两大一小，意向亲子双床房，预算 ¥700/晚", "douyin 评论", "高"],
  ["李总 · 商旅协议", "附近电商公司行政，月用房约 40 间夜，要协议价+月结", "私信", "高"],
  ["王先生 · 会议团", "20 人季度会 + 10 间房两晚，比价中", "电话咨询", "高"],
  ["周女士 · 长住客", "项目驻场 3 周，关注长住价与洗衣", "AI 搜索", "中"],
  ["陈先生 · 婚宴踩点", "国庆婚宴 15 桌 + 宾客房 30 间", "企微", "高"],
  ["吴女士 · 复购会员", "金卡，上季度住 6 晚，问会员日权益", "企微", "中"],
] as const;
const DEALS = [
  ["亲子双床房 ×2 晚", 1316, "douyin 团购券核销"],
  ["高级大床房 ×3 晚", 1884, "AI 搜索直订"],
  ["商旅单床房 ×2 晚", 1056, "企微复购"],
  ["亲子套餐 ×1 份", 799, "小红书种草"],
  ["长住大床房 ×7 晚", 3865, "协议价"],
] as const;

const EVENTS: unknown[] = [];
// 询盘秒回 ×12（间隔分布于近 36h）
Q.forEach(([q, a], i) => {
  const t = at(36 * 60 - i * 172);
  EVENTS.push({
    event_id: `E-SEED-AQ-${9101 + i}`, who: who("ai-receptionist"), context: ctx(t),
    object: { type: "intent_signal", id: `inq-${2400 + i}`, label: "住客询盘" },
    decision: { action: "ask.answer", after: { channel: i % 3 === 0 ? "douyin 评论" : i % 3 === 1 ? "私信" : "AI 搜索", q, a, latency_s: 3 + (i % 4), satisfaction: "resolved" } , basis: ["知识库命中", "询盘 SOP"] },
    rule_impact: ri("R25"), receipt: receipt(t), model_trace: mt,
  });
});
// 线索捕获 ×6
LEADS.forEach(([name, intent, source, level], i) => {
  const t = at(30 * 60 - i * 236);
  EVENTS.push({
    event_id: `E-SEED-AQ-${9113 + i}`, who: who("lead-concierge"), context: ctx(t),
    object: { type: "lead", id: `lead-${3100 + i}`, label: name },
    decision: { action: "lead.capture", after: { guest: name, intent, source, level, next: level === "高" ? "已转企微 1 对 1 跟进" : "48h 关怀触达" }, basis: ["意图评分 ≥0.72 自动建卡"] },
    rule_impact: ri("R23", "review"), receipt: receipt(t), model_trace: mt,
  });
});
// 成交归因 ×5
DEALS.forEach(([item, amount, source], i) => {
  const t = at(26 * 60 - i * 264);
  EVENTS.push({
    event_id: `E-SEED-AQ-${9119 + i}`, who: who("coupon-operator"), context: ctx(t),
    object: { type: "booking_order", id: `BK-${88210 + i}`, label: item },
    decision: { action: "booking.confirm", after: { item, amount, source, ota_saved: Math.round(amount * 0.18) }, basis: ["免 OTA 直连成交"] },
    rule_impact: [], receipt: receipt(t), model_trace: mt,
  });
});
// 转化归因汇总（月累计 · 北极星）
{
  const t = at(120);
  EVENTS.push({
    event_id: "E-SEED-AQ-9124", who: who("company-ceo"), context: ctx(t),
    object: { type: "conversion", id: "conv-mtd", label: "月度归因战报" },
    decision: { action: "conversion.attribute", after: { month_to_date: { deals: 152, amount: 128600, commission_saved_est: 14900, by_entry: { douyin: 61400, ai_search: 43800, xiaohongshu: 15600, wecom_referral: 7800 } }, wow: "+18.2%" }, basis: ["五元事件全链路归因"] },
    rule_impact: [], receipt: receipt(t), model_trace: mt,
  });
}
// GEO 曝光快照（上榜词）
{
  const t = at(200);
  EVENTS.push({
    event_id: "E-SEED-AQ-9125", who: who("content-agent"), context: ctx(t),
    object: { type: "visibility_snapshot", id: "vis-daily", label: "AI 搜索曝光快照" },
    decision: { action: "visibility.snapshot", after: { ranked: 12, top3: ["杭州亲子酒店推荐", "西湖边安静酒店", "杭州商旅延迟退房"], new_in: ["杭州酒店 儿童乐园", "杭州长住酒店 优惠"], answers_cited: 9 }, basis: ["GEO 双域内容矩阵"] },
    rule_impact: [], receipt: receipt(t), model_trace: mt,
  });
}
// 券运营 ×2
[
  ["「亲子 2 天 1 晚」套餐券", 799, 200, 186, "douyin 本地生活"],
  ["「商旅安心住」权益券", 99, 500, 342, "GEO 图文挂载"],
].forEach(([name, price, total, sold, channel], i) => {
  const t = at(20 * 60 - i * 400);
  EVENTS.push({
    event_id: `E-SEED-AQ-${9126 + i}`, who: who("coupon-operator"), context: ctx(t),
    object: { type: "coupon_sku", id: `sku-${600 + i}`, label: String(name) },
    decision: { action: "coupon.promote", after: { name, price, total, sold, channel, gmv: Number(price) * Number(sold) }, basis: ["库存熔断线 10%"] },
    rule_impact: ri("R22"), receipt: receipt(t), model_trace: mt,
  });
});
// 直播 ×1 / 竞对 ×2 / 评价 ×2 / 雷达 ×1 / 夜班投递 ×1
EVENTS.push(
  { event_id: "E-SEED-AQ-9128", who: who("content-agent"), context: ctx(at(16 * 60)), object: { type: "live_campaign", id: "live-081", label: "周三探店直播" },
    decision: { action: "live.campaign", after: { title: "云栖亲子房实拍 + 夜宵福利", viewers: 4260, leads: 37, gmv: 8600 }, basis: ["周三/六固定档"] }, rule_impact: [], receipt: receipt(at(16 * 60)), model_trace: mt },
  { event_id: "E-SEED-AQ-9129", who: who("competitor-agent"), context: ctx(at(14 * 60)), object: { type: "poi_store", id: "comp-008", label: "竞对价格监测" },
    decision: { action: "competitor.fetch", after: { card: "云栖轻奢酒店", price: 695, diff: -67, advice: "维持现价，对方含早弱势" }, basis: ["3 家竞对小时级"] }, rule_impact: [], receipt: receipt(at(14 * 60)), model_trace: mt },
  { event_id: "E-SEED-AQ-9130", who: who("review-agent"), context: ctx(at(12 * 60)), object: { type: "content", id: "rv-66413", label: "差评处置" },
    decision: { action: "review.reply", after: { rating: 2, topic: "电梯等待", reply: "已致歉并说明错峰方案，附 ¥50 早餐券", public: true }, basis: ["差评 2h 响应 SOP"] }, rule_impact: ri("R25"), receipt: receipt(at(12 * 60)), model_trace: mt },
  { event_id: "E-SEED-AQ-9131", who: who("review-agent"), context: ctx(at(11 * 60)), object: { type: "content", id: "rv-66421", label: "好评加热" },
    decision: { action: "review.asset.boost", after: { rating: 5, topic: "亲子乐园", action: "沉淀为 GEO 素材 + 置顶", exposures: 2140 }, basis: ["好评资产化"] }, rule_impact: [], receipt: receipt(at(11 * 60)), model_trace: mt },
  { event_id: "E-SEED-AQ-9132", who: who("channel-watcher"), context: ctx(at(10 * 60)), object: { type: "intent_signal", id: "radar-daily", label: "意图雷达日报" },
    decision: { action: "intent.radar.report", after: { top: ["杭州亲子酒店 带泳池 热度 1842 ↑", "西湖边 隔音好 热度 1207 ↑", "杭州商旅 延迟退房 热度 886 ↑"], play: "已排期 3 条对应内容" }, basis: ["四矿源采集"] }, rule_impact: [], receipt: receipt(at(10 * 60)), model_trace: mt },
  { event_id: "E-SEED-AQ-9133", who: who("night-shift"), context: ctx(at(8 * 60)), object: { type: "night_package", id: "np-daily", label: "夜班日报" },
    decision: { action: "night.package.deliver", after: { overnight: { inquiries: 23, answered: 23, leads: 6, deals: 2, amount: 2380 }, note: "询盘零漏接" }, basis: ["夜班值守"] }, rule_impact: [], receipt: receipt(at(8 * 60)), model_trace: mt },
  { event_id: "E-SEED-AQ-9134", who: who("content-agent"), context: ctx(at(6 * 60)), object: { type: "content", id: "cnt-3315", label: "内容发布" },
    decision: { action: "content.publish", after: { title: "亲子乐园实拍·周末遛娃免排队", channels: ["douyin", "xiaohongshu"], plays_1h: 3260, inquiries: 8 }, basis: ["双域内容工厂"] }, rule_impact: ri("R25"), receipt: receipt(at(6 * 60)), model_trace: mt },
  { event_id: "E-SEED-AQ-9135", who: who("content-agent"), context: ctx(at(5 * 60)), object: { type: "content", id: "cnt-3316", label: "GEO 图文发布" },
    decision: { action: "geo.publish", after: { title: "杭州商旅酒店怎么选（延迟退房/发票/安静房）", cited_target: "杭州商旅酒店推荐", status: "已收录待引用" }, basis: ["GEO 六段式"] }, rule_impact: ri("R25"), receipt: receipt(at(5 * 60)), model_trace: mt },
);

/* ---------- ② 待审批 ×3（完整 snapshot，高含金量） ---------- */
const APPROVALS = [
  {
    id: "apr-acq-001",
    eventRef: "E-SEED-AQ-9114",
    snapshot: {
      action: "deal.quote", summary: "商旅协议价审批：电商公司月 40 间夜，¥628/晚 含早（门市 ¥688）",
      title: "商旅协议价 ¥628/晚（88 折+月结）",
      ceo_rationale: "对方月贡献约 ¥25,000，低于 9 折需让渡延迟退房权益兜底；RevPAR 影响 -2.1%，间夜贡献 +18%",
      rule_version: "R21 hotel-baseline/v4", gate: "报价必审",
      params: { account: "电商公司行政 李总", nights_per_month: 40, price: 628, list_price: 688, terms: "含早/月结/免费延迟退房 14:00" },
      before: { price: 688, channel: "OTA 散客价" }, after: { price: 628, channel: "协议直连", save_for_guest: "月省 ¥2,400" },
    },
  },
  {
    id: "apr-acq-002",
    eventRef: "E-SEED-AQ-9126",
    snapshot: {
      action: "coupon.create", summary: "「周末亲子券」定价审批：¥50 早餐券 → ¥39 限量 200 份（拉新促核销）",
      title: "券定价 ¥50→¥39（限 200 份）",
      ceo_rationale: "毛利率仍 61%，预计带动亲子房预订 35+ 间夜；库存熔断线 10%",
      rule_version: "R26 hotel-baseline/v4", gate: "券定价必审",
      params: { sku: "周末亲子早餐券", from: 50, to: 39, stock: 200, est_rooms: 35 },
      before: { price: 50 }, after: { price: 39, margin: "61%", fuse: "库存 10% 熔断" },
    },
  },
  {
    id: "apr-acq-003",
    eventRef: "E-SEED-AQ-9113",
    snapshot: {
      action: "lead.assign", summary: "线索出域审批：38 条高意向线索导企微私域（含 2 条 VIP）",
      title: "38 条高意向线索导企微（R23 必审）",
      ceo_rationale: "全部已获客户授权；VIP 2 条建议王店长亲自跟进（婚宴/协议大客户）",
      rule_version: "R23 hotel-baseline/v4", gate: "线索出域必审",
      params: { leads: 38, vip: 2, consent: "全量授权", target: "企微私域 SOP-7" },
      before: { location: "平台私信" }, after: { location: "企微私域", owner: "销售组" },
    },
  },
];

/* ---------- ③ account_metrics：4 账号 × 30 天 + 6 爆款 ---------- */
const ACCOUNTS = [
  ["acc-seed-douyin-main", "douyin", 4200],
  ["acc-seed-douyin-poi", "douyin", 1500],
  ["acc-seed-xhs-main", "xiaohongshu", 2100],
  ["acc-seed-wecom", "wecom", 800],
] as const;
const HITS = [
  ["vid-hit-01", "亲子乐园实拍·周末遛娃免排队", 126000],
  ["vid-hit-02", "深夜酒店隔音实测（分贝仪实录）", 88000],
  ["vid-hit-03", "杭州商旅·延迟退房全攻略", 64000],
  ["vid-hit-04", "住客视角·西湖 12 分钟步行圈", 47000],
  ["vid-hit-05", "长住一周真实体验·布草深度清洁", 33000],
  ["vid-hit-06", "周三探店直播回放·夜宵福利", 29000],
] as const;

async function main() {
  const owner = new pg.Client({ connectionString: DATABASE_URL });
  await owner.connect();

  // 指标：按 acc-seed- 前缀清写（幂等）
  await owner.query(`DELETE FROM account_metrics WHERE workspace_id=$1 AND account_id LIKE 'acc-seed-%'`, [WS_ID]);
  let rows = 0;
  for (const [acc, platform, base] of ACCOUNTS) {
    for (let d = 29; d >= 0; d--) {
      const date = new Date(now - d * 86_400_000);
      const wave = 1 + 0.35 * Math.sin(d / 4) + (29 - d) / 90; // 缓升趋势
      const plays = Math.round(base * wave * (0.8 + Math.random() * 0.4));
      const likes = Math.round(plays * 0.062);
      const comments = Math.round(plays * 0.011);
      const shares = Math.round(plays * 0.007);
      const conversions = Math.round(plays * 0.0035);
      await owner.query(
        `INSERT INTO account_metrics (workspace_id, platform, account_id, video_id, captured_at, plays, likes, comments, shares, conversions)
         VALUES ($1,$2,$3,NULL,$4,$5,$6,$7,$8,$9)`,
        [WS_ID, platform, acc, date.toISOString(), plays, likes, comments, shares, conversions],
      );
      rows++;
    }
  }
  for (const [vid, , plays] of HITS) {
    const [acc, platform] = ACCOUNTS[Math.floor(Math.random() * 2)];
    await owner.query(
      `INSERT INTO account_metrics (workspace_id, platform, account_id, video_id, captured_at, plays, likes, comments, shares, conversions)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
      [WS_ID, platform, acc, vid, at(36 * 60), plays, Math.round(plays * 0.09), Math.round(plays * 0.02), Math.round(plays * 0.012), Math.round(plays * 0.006)],
    );
    rows++;
  }
  console.log(`✓ account_metrics：写入 ${rows} 行（4 账号×30 天 + 6 爆款）`);

  // 审批：同 ID 跳过
  let aprNew = 0;
  for (const a of APPROVALS) {
    const exists = await owner.query(`SELECT 1 FROM approvals WHERE approval_id=$1`, [a.id]);
    if ((exists.rowCount ?? 0) > 0) continue;
    await owner.query(
      `INSERT INTO approvals (approval_id, tenant_id, workspace_id, event_id, channel, status, tier, snapshot, created_at)
       VALUES ($1,$2,$3,$4,'inapp','pending','l4_chairman',$5,$6)`,
      [a.id, TENANT_ID, WS_ID, (a as unknown as { eventRef: string }).eventRef, JSON.stringify(a.snapshot), at(90)],
    );
    aprNew++;
  }
  console.log(`✓ 待审批：新写入 ${aprNew} 条（协议价/券定价/线索出域）`);

  // GR-02（2026-09-29 第二次修复）：手写号段写入方收尾对齐号源（取号函数只做 nextval）
  const seqFloor = await alignReadableIdSequences(owner);
  console.log(`✓ 可读号源对齐：threads→${seqFloor.threads}，video_projects→${seqFloor.videoProjects}`);

  await owner.end();

  // 事件：网关写入（哈希链接龙 + 存在即跳过）
  const gw = new pg.Client({ connectionString: GATEWAY_URL });
  await gw.connect();
  await gw.query("BEGIN");
  await gw.query("SELECT set_config('app.workspace_id', $1, true)", [WS_ID]);
  await gw.query("SELECT set_config('app.tenant_id', $1, true)", [TENANT_ID]);
  const last = await gw.query(`SELECT hash FROM biz_events WHERE tenant_id=$1 AND workspace_id=$2 ORDER BY seq DESC LIMIT 1`, [TENANT_ID, WS_ID]);
  let prevHash = (last.rows[0]?.hash as string) ?? GENESIS_HASH;
  let inserted = 0, skipped = 0;
  for (const raw of EVENTS) {
    const ev = raw as { event_id: string; context: { time: string } };
    const checked = safeParseReplayAwareEvent(ev as never);
    if (!checked.success) throw new Error(`事件 ${ev.event_id} 未过校验：${checked.error.message}`);
    const dup = await gw.query(`SELECT 1 FROM biz_events WHERE tenant_id=$1 AND event_id=$2`, [TENANT_ID, ev.event_id]);
    if ((dup.rowCount ?? 0) > 0) { skipped++; continue; }
    const payload = JSON.stringify(checked.data);
    const hash = eventHash(prevHash, checked.data);
    const res = await gw.query<{ inserted: boolean }>(
      `SELECT * FROM append_event_insert($1,$2,$3,$4,$5,$6,$7,$8)`,
      [ev.event_id, TENANT_ID, WS_ID, null, payload, prevHash, hash, ev.context.time],
    );
    if (res.rows[0]?.inserted) { prevHash = hash; inserted++; } else skipped++;
  }
  await gw.query("COMMIT");
  await gw.end();
  console.log(`✓ 获客剧本事件：新写入 ${inserted} 条，幂等跳过 ${skipped} 条`);
  console.log("获客饱满运行态增强包完成 ✅（询盘零漏接 · 月归因 ¥128,600 · GEO 上榜 12 词 · 佣金节省 ¥14,900）");
}

main().catch((e) => { console.error(e); process.exit(1); });
