/**
 * A5 · 演示种子数据（酒店试点业务前台夹具：云栖酒店）
 * 主题口径：本仓产品主题是「获客用增」；本文件产出的是首个垂直行业试点（酒店）的
 *          业务前台夹具（C 端行业适配器契约所需），获客用增的产品演示工作区
 *          （ws-geo，bundles/geo-growth）由 scripts/seed-geo.ts 产出，
 *          `pnpm db:seed` 已把两者串联为默认一键种子。
 * 用法：pnpm db:seed（读取 .env；幂等，可重复执行）
 *
 * 内容：demo 租户 / 云栖酒店工作区 / 3 人类成员 / 16 个基础 Agent preset 实例 +
 *      组合编制全员上岗（2026-09-24 实测 78 岗：hotel 16 + ai-video 36 + geo-growth 26，同名遮蔽 4 处按主包裁决，
 *      见 provisionComposedWorkforce；口径事实源为装配器运行结果，不在此手工维护）/
 *      一店一档（含 forbidden 硬约束 + 布草/断点/FAQ 字段组）/ 基线围栏 R1–R26（hotel-baseline/v4）装载 / 53 个组合官方技能 /
 *      2 触发器 / 昨夜夜班班次 / 100 条五元事件（哈希链）/ 审批样例 / 组织记忆
 *
 * 纪律：
 *  - 事件只经 workloom_gateway 角色写入（F1.2），其余表走 owner 种子连接（D10）；
 *  - 事件一律走 append_event_insert 特权函数（P0-3：不再裸 INSERT biz_events）；
 *    种子 event_id 用 E-SEED- 前缀（回放/种子独立命名空间，与序列分配的 E-<digits> 硬隔离）；
 *  - 每条事件写入前过 zod（safeParseReplayAwareEvent：E-SEED- 前缀经占位缝过同一附录 E schema）；
 *  - 幂等：组织模型 ON CONFLICT DO NOTHING；事件先查存在再写（L1.4 确定性幂等——
 *    演示时间轴含实时时钟，重跑 payload 必然不同，直撞 append_event_insert 会按
 *    P0-3 抢占攻击拒写，故存在即跳过、不触发 md5 冲突比对）；
 *  - GUC 一律 set_config(..., is_local=true) 且包在显式事务内（L2：不留会话级残留）；
 *  - 验收：写入后回读 100 条事件逐条过 zod，五元字段完整率必须 100%（附录 H-1）。
 */
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import YAML from "yaml";
// #32 修复：哈希链统一生产口径（events.ts 的 canonicalJson/eventHash）——
// 此前种子用 JSON.stringify 键序算哈希，与生产 canonicalJson 口径不一致，
// 种子 100 条事件用生产验证器重算全部不符（链上两种算法混杂）
// P0-3 续：种子 ID 走 E-SEED- 前缀，zod 经 safeParseReplayAwareEvent 占位缝校验
import { alignReadableIdSequences, eventHash, safeParseReplayAwareEvent } from "@workloom/base/workdata";
import { composeWorkforce } from "@workloom/base/bundles";
import { loadOfficialSkills } from "@workloom/base/skills";
// 2026-09-20：技能围栏绑定表收口到共享模块（seed.ts 与 seed-geo.ts 共用同一事实源）
import { COMPOSED_SKILL_BINDINGS, HOTEL_SKILL_BINDINGS, skillBindingsFor } from "./skill-bindings.mts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "..");
const BUNDLE_DIR = process.env.BUNDLE_DIR
  ? join(REPO_ROOT, process.env.BUNDLE_DIR)
  : join(REPO_ROOT, "bundles/hotel");

const DATABASE_URL =
  process.env.DATABASE_URL ?? "postgres://postgres:workloom@localhost:5432/workloom";
const GATEWAY_URL =
  process.env.DATABASE_GATEWAY_URL ??
  "postgres://workloom_gateway:workloom_dev_gateway@localhost:5432/workloom";

/* ================= 固定演示标识（幂等键） ================= */

const TENANT_ID = "tenant-demo";
const TENANT_NAME = "演示租户（Demo）";
const WS_ID = "ws-yunqi";
const WS_NAME = "云栖酒店";
const WS_SLUG = "yunqi-hotel";
const FENCE_VERSION = "hotel-baseline/v4";
/**
 * 本产品的组合主包：product.manifest.json 的 defaultBundle（获客主包）。
 * 融合获客系统的编制 = 主包（获客域）+ 依赖包（ai-video 内容生产 + hotel 酒店经营）。
 */
const PRODUCT_PRIMARY_BUNDLE = JSON.parse(
  readFileSync(join(REPO_ROOT, "product.manifest.json"), "utf-8"),
).defaultBundle as string;

const MEMBERS = [
  { id: "MEM-001", name: "王店长", role: "owner" },
  { id: "MEM-002", name: "陈经理", role: "manager" },
  { id: "MEM-003", name: "李前台", role: "readonly" },
] as const;

const EVENT_BASE = 8800; // 事件编号 E-SEED-8801 起（PRD 展示口径 + P0-3 种子前缀空间）
const EVENT_COUNT = 100;
const GENESIS_HASH = "GENESIS";

/* ================= 工具 ================= */

/** 确定性伪随机（mulberry32）：演示数据可复现 */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rand = mulberry32(20260816);
const pick = <T>(arr: readonly T[]): T => arr[Math.floor(rand() * arr.length)] as T;
const int = (min: number, max: number): number => min + Math.floor(rand() * (max - min + 1));

function iso(d: Date): string {
  return d.toISOString();
}

/** 演示时间轴：昨天 00:00 到今天现在；夜班段额外加密（22:00–08:30，F4.1） */
function demoTimeline(): Date[] {
  const now = new Date();
  const start = new Date(now);
  start.setDate(start.getDate() - 1);
  start.setHours(0, 0, 0, 0);
  const span = now.getTime() - start.getTime();
  const times: Date[] = [];
  for (let i = 0; i < EVENT_COUNT; i++) {
    // 60% 落在夜班窗口（昨晚 22:00 → 今 08:30），40% 全天均匀
    let t: number;
    if (i % 5 < 3) {
      const nightStart = new Date(start); nightStart.setHours(22, 0, 0, 0);
      const nightEnd = new Date(start); nightEnd.setDate(nightEnd.getDate() + 1); nightEnd.setHours(8, 30, 0, 0);
      t = nightStart.getTime() + rand() * (nightEnd.getTime() - nightStart.getTime());
    } else {
      t = start.getTime() + rand() * span;
    }
    times.push(new Date(t));
  }
  times.sort((a, b) => a.getTime() - b.getTime());
  return times;
}

/* ================= Bundle 资产读取 ================= */

interface Preset {
  preset_key: string;
  name: string;
  version: string;
  kind: string;
  description: string;
  readonly: boolean;
  night_shift: boolean;
  high_risk: boolean;
  fence_bindings: string[];
  skills: string[];
  tools: Array<{ name: string; access: string; desc: string }>;
  prompt: unknown;
  write_back: string[];
}

function loadPresets(): Preset[] {
  const dir = join(BUNDLE_DIR, "presets");
  return readdirSync(dir)
    .filter((f) => f.endsWith(".yml"))
    .sort()
    .map((f) => YAML.parse(readFileSync(join(dir, f), "utf-8")) as Preset);
}

interface FenceRule {
  rule_id: string;
  name: string;
  level: "auto" | "review" | "block";
  is_baseline: boolean;
  match: { object_types: string[]; actions: string[] };
  when: string;
  note?: string;
}

function loadFences(): FenceRule[] {
  const doc = YAML.parse(readFileSync(join(BUNDLE_DIR, "fences/hotel-baseline.yml"), "utf-8"));
  return (doc?.rules ?? []) as FenceRule[];
}

interface SkillDoc {
  /** 行业包技能记包名；底座官方技能（skills/official，不依附行业包）记 null */
  bundle: string | null;
  name: string;
  description: string;
  body: string;
  fenceBindings: string[];
}

/** 单包技能装载：SKILL.md front-matter + 显式围栏绑定表（未声明即空，不猜绑定） */
function loadBundleSkills(bundleId: string, dir: string, bindMap: Record<string, string[]>): SkillDoc[] {
  return readdirSync(dir)
    .sort()
    .map((d) => {
      const raw = readFileSync(join(dir, d, "SKILL.md"), "utf-8");
      const m = raw.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
      const fm = YAML.parse(m?.[1] ?? "{}");
      const name = String(fm.name ?? d);
      return {
        bundle: bundleId,
        name,
        description: String(fm.description ?? ""),
        body: (m?.[2] ?? "").trim(),
        fenceBindings: bindMap[name] ?? [],
      };
    });
}

function loadSkills(): SkillDoc[] {
  // v3 全量绑定表（30 技能）见 scripts/skill-bindings.mts（与 seed-geo.ts 共用同一事实源）
  return loadBundleSkills("hotel", join(BUNDLE_DIR, "skills"), HOTEL_SKILL_BINDINGS as Record<string, string[]>);
}

/**
 * 组合并入包（ai-video / geo-growth）的技能绑定表。
 * 口径：只收录 SKILL.md 描述中显式声明的围栏（未声明即空列表，不臆造绑定）。
 */
/**
 * 包外官方技能（`skills/official/`，bundle=null）的围栏绑定表。
 * 口径同行业包：只登记 SKILL.md 里**显式写明**的围栏，未写明就保持空绑定（不臆造）。
 */
const BASE_OFFICIAL_SKILL_BINDINGS: Record<string, string[]> = {
  // deal-flow：报价/合同/结案报告等对外文件必过 G15 审批后外发
  "deal-flow": ["G15"],
};

/**
 * 组合编制里被岗位引用、但不在任何行业包技能目录中的官方技能（当前为 deal-flow：
 * 商单经理/达人合作专员引用）。行业包 preset 允许引用底座官方技能资产，但资产必须在
 * 工作区**真的登记并安装**，否则岗位档案里这颗技能会静默消失（F8.2 安装即绑定）。
 */
function loadReferencedBaseOfficialSkills(bundleSkills: SkillDoc[]): SkillDoc[] {
  const referenced = new Set<string>();
  for (const entry of composeWorkforce(PRODUCT_PRIMARY_BUNDLE).presets.values()) {
    for (const skill of entry.preset.skills ?? []) referenced.add(skill);
  }
  const local = new Set(bundleSkills.map((s) => s.name));
  return loadOfficialSkills(REPO_ROOT)
    .filter((asset) => referenced.has(asset.name) && !local.has(asset.name))
    .map((asset) => ({
      bundle: null,
      name: asset.name,
      description: asset.description,
      body: asset.body,
      fenceBindings: BASE_OFFICIAL_SKILL_BINDINGS[asset.name] ?? [],
    }));
}

/** 组合技能并集：酒店 30 + ai-video 8 + geo-growth 15（三包技能无同名冲突）+ 编制引用的包外官方技能 */
function loadComposedSkills(): SkillDoc[] {
  const bundleSkills = [
    ...loadSkills(),
    ...loadBundleSkills("ai-video", join(REPO_ROOT, "bundles/ai-video/skills"), COMPOSED_SKILL_BINDINGS["ai-video"]),
    ...loadBundleSkills("geo-growth", join(REPO_ROOT, "bundles/geo-growth/skills"), COMPOSED_SKILL_BINDINGS["geo-growth"]),
  ];
  return [...bundleSkills, ...loadReferencedBaseOfficialSkills(bundleSkills)];
}

/**
 * 融合获客资产（bundles/geo-growth/schemas/archive.schema.json 对齐）。
 *
 * 本产品是"酒店获客复合系统"：一店一档既要装下酒店经营（房态/布草/供应商），
 * 也要装下获客域（品牌实体卡/目标客群/内容与 GEO 资产/转化资产）。
 * 缺了这一段，融合体在主包档案契约层就会被判不合规——只剩"酒店"，没有"获客"。
 */
function acquisitionAssets(): Record<string, unknown> {
  return {
    enterprise: {
      name: WS_NAME,
      profile: "杭州四钻 86 间客房单体酒店，OTA 依赖度高、直连占比低，正在用内容+GEO 换取直连客源",
      qualifications: ["四钻评级", "消防验收合格", "食品经营许可"],
      capacity: "86 间客房 / 日均接待 120 人次 / 宴会厅 2 个",
      brand_guideline: { tone: "真诚克制，不夸大、不承诺档案外补偿", visual: "湖山青主色 + 暖金点缀" },
    },
    entity_card: {
      product_lines: [
        { model: "RT-DLX-KING", name: "豪华大床房", applications: ["情侣/商务单人"], params: { size: "38㎡", bed: "1.8m", view: "城市景观" } },
        { model: "RT-FAM-TWIN", name: "亲子双床房", applications: ["亲子家庭"], params: { size: "42㎡", bed: "1.5m×2", extras: "儿童洗漱包" } },
        { model: "RT-BIZ-KING", name: "商旅大床房", applications: ["差旅长住"], params: { size: "32㎡", bed: "1.8m", extras: "免费洗衣 2 件" } },
      ],
      core_selling_points: ["步行 8 分钟到地铁 2 号线", "早餐现做、儿童免加床费", "直连下单免 OTA 佣金让利", "差评 24h 内闭环"],
      price_logic: "工作日 458 元锚定，周末与节假日按房态分档上浮，保底价 ¥380",
      confirmed: true,
    },
    target_market: {
      countries: ["中国"],
      languages: ["zh"],
      buyer_roles: ["商旅客人", "亲子家庭", "本地周末度假客", "企业差旅采购"],
      competitors: [
        { name: "西湖云舍酒店", note: "美团点评量高，但直连几乎没有" },
        { name: "溪上云居民宿", note: "小红书内容密度高，亲子客群强" },
      ],
    },
    content_assets: { materials: 26, history_scripts: 9, high_perf_structures: ["房型对比+价格锚定", "周边玩法清单", "差评反转故事"] },
    operation_assets: {
      accounts: [
        { platform: "douyin", handle: "@云栖酒店", group: "A", daily_publish_limit: 2 },
        { platform: "xiaohongshu", handle: "云栖酒店·杭州", group: "A", daily_publish_limit: 2 },
        { platform: "shipinhao", handle: "云栖酒店", group: "B", daily_publish_limit: 1 },
      ],
      stage: "setup",
      baseline: { plays_7d: 12_800, inquiries_30d: 46 },
    },
    geo_assets: {
      query_set: [
        { q: "杭州西湖附近酒店推荐", type: "category", lang: "zh", priority: "P0", status: "竞品首推" },
        { q: "云栖酒店怎么样", type: "brand", lang: "zh", priority: "P0", status: "未提及" },
        { q: "杭州亲子酒店哪家好", type: "scene", lang: "zh", priority: "P1", status: "未覆盖" },
        { q: "杭州地铁2号线附近住宿", type: "scene", lang: "zh", priority: "P1", status: "未提及" },
        { q: "云栖 vs 西湖云舍", type: "compare", lang: "zh", priority: "P1", status: "负面偏差" },
      ],
      visibility_baseline: {
        mention_rate: 0.14, first_rate: 0.03, sov: 0.08,
        platforms: ["doubao", "deepseek", "yuanbao", "chatgpt"],
        by_platform: {
          doubao: { mention: 0.19, first: 0.05, sov: 0.11 },
          deepseek: { mention: 0.16, first: 0.03, sov: 0.09 },
          yuanbao: { mention: 0.10, first: 0.01, sov: 0.05 },
          chatgpt: { mention: 0.11, first: 0.02, sov: 0.07 },
        },
      },
      citation_targets: ["携程目的地攻略", "知乎杭州住宿问答", "小红书城市榜单", "本地生活媒体"],
    },
    conversion_assets: {
      funnel_baseline: { exposure: 128_000, interaction: 6_400, inquiry: 820, lead: 310, deal: 96, repurchase: 21 },
      attribution: { chain: ["渠道", "内容ID", "入口", "线索ID"], ota_commission_saving_target: 42_000 },
      coupon_skus: [
        { sku: "CPN-STAY-300", title: "300 元住宿抵扣券", stock: 500, fuse_limit: 0.2 },
        { sku: "CPN-SPA-88", title: "88 元 SPA 体验券", stock: 300, fuse_limit: 0.3 },
      ],
    },
    data_boundary: {
      pii: "客资明文不出系统（R24）；导出/外发必审（R23）",
      cross_border: "境内存储，不跨境传输",
      retention_days: 730,
    },
  };
}

/** 一店一档（bundles/hotel/schemas/archive.schema.json 对齐；保底价 ¥380 与 R2 同源） */
function yunqiArchive(): Record<string, unknown> {
  return {
    // 融合体：酒店经营档案 + 获客资产档案同属一店一档（主包与行业包契约取并集）
    ...acquisitionAssets(),
    property: { name: WS_NAME, city: "杭州", rooms: 86, star: "四钻", segment: "low_star_single", pms_vendor: "示例PMS" },
    // 数字CEO 宪章（D21，演示：董事长已完成深度授权 → 试用期第 2 天）
    charter: {
      version: 1,
      mode: "trial",
      identity: { name: "公司CEO", persona: "稳健经营型" },
      // 自治边界形状与 base/captain charterSchema 对齐（ranges/caps/lists）；
      // 旧的 price_band/procurement_cap 平铺字段会被 .strict() 拒绝，
      // 导致整段自治配置静默回落到 disabled 默认宪章。
      autonomy: {
        ranges: {
          price_quote_band: { label: "调价相对基准区间", lower: 0.85, upper: 1.15, anchor: 1 },
        },
        caps: {
          procurement_cap: { label: "单笔采购上限", limit: 5000 },
          campaign_cap: { label: "单次活动预算上限", limit: 2000 },
        },
      },
      escalate: ["修改保底价/安全禁区相关", "单月累计让利超上限", "围栏规则放宽（任何放宽）", "新渠道/新平台上线", "对外公开承诺（赔偿/免费/声明）", "宪章变更"],
      briefing: { daily: "08:30", weekly: "Mon 09:00", monthly: "1st 10:00", channel: "both" },
      circuit_breaker: { window_days: 14, kpi_floor: { occ: 0.7 }, tightened: false },
      grant: {
        event_id: "E-SEED-GRANT01", granted_by: "MEM-001",
        granted_at: new Date(Date.now() - 9 * 86400e3).toISOString(),
        disclosure_version: "risk-v1",
        clauses: ["自主调价", "自主采购", "自主对外回复", "试用降档规则", "AI 非法律责任主体·授权人承担经营决策责任"],
        shadow_days: 3, trial_days: 7,
        trial_ends_at: new Date(Date.now() + 5 * 86400e3).toISOString(),
        retain_until: null,
      },
      updated_at: new Date().toISOString(),
    },
    brand_guideline: {
      tone: "真诚克制，不夸大、不承诺档案外补偿",
      banned_words: ["最低价全网保证", "百分百满意"],
      image_rules: "首图实拍、无水印、16:9",
      live_rules: "直播口播不承诺最低价，专享价不低于保底价",
    },
    business: {
      floor_price: 380,
      price_bands: { "雅致大床房": [398, 688], "亲子双床房": [468, 788], "商旅大床房": [358, 588] },
      commission_rules: { "美团": 0.10, "携程": 0.12, "飞猪": 0.08, "直连": 0 },
      refund_policy: { free_cancel_hours: 18, guarantee_required_after: "18:00" },
    },
    competitors: [
      { name: "西湖云舍酒店", channels: ["美团", "携程"], price_band: [420, 680] },
      { name: "溪上云居民宿", channels: ["美团"], price_band: [360, 520] },
      { name: "云栖轻奢酒店", channels: ["携程", "飞猪"], price_band: [460, 760] },
    ],
    audience: { 商旅客: 0.55, 亲子: 0.25, 情侣: 0.2 },
    history_curve: {
      "2026-06": { occ: 0.71, adr: 468, revpar: 332 },
      "2026-07": { occ: 0.83, adr: 512, revpar: 425 },
      "2026-08": { occ: 0.78, adr: 496, revpar: 387 },
    },
    sop: ["差评 24h 内响应", "调价须附竞对依据", "夜间对账三轮比对"],
    channels: [
      { name: "美团", kind: "ota", channel_new: false },
      { name: "携程", kind: "ota", channel_new: false },
      { name: "飞猪", kind: "ota", channel_new: false },
      { name: "抖音", kind: "live", channel_new: true },
      { name: "小红书", kind: "content", channel_new: true },
    ],
    price_calendar: {
      horizon_days: 90,
      holidays: [{ date: "2026-10-01", name: "国庆", strategy: "提前7天策略审批" }],
    },
    operations: {
      shifts: ["早班 08:00-16:00", "中班 16:00-24:00", "夜班 00:00-08:00"],
      night_window: { start: "22:00", end: "08:00", package_time: "08:30" },
      inspection_cron: ["10:00", "15:00", "20:00"],
      cleaning_sop: "预抵房>退房>续住房>空房；30-45分钟/间",
      room_check_items: ["清洁", "设施", "耗材", "minibar", "损坏丢失"],
    },
    staffing: { frontdesk: 3, housekeeping: 3, maintenance: 1, overtime_legal_max_h_month: 36 },
    suppliers: [
      { name: "洁雅布草洗涤", kind: "linen", backup: false },
      { name: "快捷酒店用品", kind: "consumable", backup: false },
      { name: "顺达维修", kind: "maintenance", backup: true },
    ],
    goals: {
      year: { revenue: 1_200_000, occ: 0.80, adr: 500, revpar: 400, bad_review_rate: 0.02, repurchase_rate: 0.28 },
      month_2026_08: { revenue: 108_000, occ: 0.83, adr: 512, note: "暑期旺季冲刺" },
      breakdown: { channels: { "美团": 0.38, "携程": 0.34, "飞猪": 0.16, "直连": 0.12 }, room_types: { "RT-DLX-KING": 0.45, "RT-FAM-TWIN": 0.33, "RT-BIZ-KING": 0.22 } },
      tracking: "goal.tracking 事件按周回写达成率与偏差归因（p12 仪表盘数据源）",
    },
    approval_matrix: {
      refund_review_threshold: 500,
      procurement_review_threshold: 1000,
      compensation: "review_only",
      night_high_risk: "block",
    },
    compensation_policy: { max_goodwill_amount: 200, upgrade_promise: "forbidden", refund_channel: "reconcile-agent" },
    memory: { case_index: [], note: "处置案例索引（第五类 case 记忆落地前的配置层锚点）" },
    // v2.1 字段组 ×3（schemas/archive.schema.json 对齐）
    linen: {
      initial_sets: { 床单: 180, 被套: 180, 枕套: 360, 毛巾: 260, 浴巾: 180 },
      laundry_vendor: "洁雅布草洗涤",
      delivery_tolerance: 0.02,
      baseline_loss_rate: 0.03,
      rfid_enabled: false,
    },
    incident_profile: {
      devices: [
        { kind: "self_checkin_kiosk", model: "示例自助机 K2", warranty_until: "2027-06-30" },
        { kind: "smart_lock", model: "示例门锁 L5", warranty_until: "2027-03-31" },
      ],
      emergency_contacts: [
        { level: 1, name: "值班手机", phone: "138****0001" },
        { level: 2, name: "远程店长 王店长", phone: "138****0002" },
        { level: 3, name: "就近应急 顺达维修", phone: "138****0003" },
      ],
      alarm_integration: "烟感/门磁联动 110/119 自动报警",
      backup_access: "前台保险柜机械钥匙 ×2（店长/业主各一）",
      current_fallback_levels: { order_anomaly: "ai_first", identity_fail: "remote_video", safety_event: "alarm_only" },
    },
    faq_kb: {
      top_questions: [
        { q: "有停车场吗", a: "酒店地下两层免费停车，入口在云栖路辅道", source_call_ids: [], confirmed: true },
        { q: "早餐几点", a: "06:30–10:00，一楼全日制餐厅", source_call_ids: [], confirmed: true },
        { q: "几点退房", a: "12:00 前；延迟退房按半日房费，视房态确认", source_call_ids: [], confirmed: true },
      ],
      last_mined_at: null,
      pending_candidates: [],
    },
    // v3.3 获客域字段组（获客五环配置锚点）
    acquisition: {
      query_set: {
        brand: ["云栖酒店怎么样", "云栖酒店 真实评价"],
        category: ["杭州亲子酒店推荐", "西湖边性价比酒店", "杭州商旅酒店 近地铁"],
        scene: ["带老人孩子杭州住哪", "杭州周末遛娃住宿"],
        competitor: ["西湖云舍和云栖哪个好"],
      },
      poi: { douyin_poi_id: "POI-YQ-001", meituan_shop_id: "MT-YQ-8899", status: "bound" },
      action_anchors: { ai_search_code: "云栖", monthly_rotation: true },
      funnel_targets: { month: { exposure: 6200000, inquiry: 1842, lead: 486, deal: 152, repurchase_rate: 0.31 } },
      ota_commission_benchmark: { "美团": 0.10, "携程": 0.12, "飞猪": 0.08 },
      market_scan: { region_heat: { 西湖区: 92, 滨江区: 74 }, ota_review_gap: "竞对差评高频：隔音/早餐排队/停车难", holiday: "国庆 10.4-10.6 有 35% 空窗可抢" },
      audience_segments: [
        { key: "亲子家庭", share: 0.42, hook: "带娃的一天 vlog", channels: ["抖音", "小红书"] },
        { key: "商旅人士", share: 0.35, hook: "商旅权益六段式", channels: ["AI搜索", "知乎"] },
        { key: "情侣周末", share: 0.23, hook: "日落窗景实拍", channels: ["小红书", "视频号"] },
      ],
      strategy_weekly: { theme: "开学季亲子收口 + 国庆错峰抢订", kpi: "线索≥90/券核销≥60/GEO提及率≥32%" },
    },
    // 巡检只读快照（M9/F9.1 探针输入；E1 补登：07:00 巡检真实检出——高危差评 + 中危价格/房态异常）
    inspection: {
      channels: [
        { channel: "美团", price: 458, parity: true, status: "online" },
        { channel: "携程", price: 458, parity: true, status: "online" },
        { channel: "飞猪", price: 438, parity: false, status: "online" },
      ],
      roomStates: [
        { roomType: "大床房", synced: true },
        { roomType: "双床房", synced: true },
        { roomType: "亲子房", synced: false },
      ],
      reviews: [
        { id: "rv-ctrip-9901", channel: "携程", score: 5 },
        { id: "rv-meituan-1032", channel: "美团", score: 2 },
      ],
      violations: [],
    },
    forbidden: [
      { rule: "美团大床房不低于 ¥380", scope: "room_price" },
      { rule: "不承诺档案之外的补偿金额", scope: "review" },
    ],
  };
}

/* ================= 事件剧本生成 ================= */

interface SeedEvent {
  event_id: string;
  who: { type: "human" | "agent" | "system"; id: string; version?: string };
  context: {
    tenant_id: string;
    workspace_id: string;
    time: string;
    channel?: string;
    stage?: string;
    store?: string;
    [k: string]: unknown;
  };
  object: { type: string; id?: string; [k: string]: unknown };
  decision: {
    action: string;
    before?: unknown;
    after?: unknown;
    basis?: string[];
    memory_refs?: string[];
    [k: string]: unknown;
  };
  rule_impact: Array<{ rule_id: string; version: string; result: string }>;
  receipt?: { synced?: boolean; snapshot_uri?: string; verified_at?: string };
  model_trace?: { model_id: string; tier?: string; window?: string; credits?: number };
  links?: string[];
  [k: string]: unknown;
}

const ROOM_TYPES = [
  { id: "RT-DLX-KING", label: "雅致大床房", base: 458 },
  { id: "RT-FAM-TWIN", label: "亲子双床房", base: 528 },
  { id: "RT-BIZ-KING", label: "商旅大床房", base: 398 },
] as const;
const CHANNELS = ["美团", "携程", "飞猪"] as const;

/** 生成一条剧本事件（按序号轮转场景，保证 R1–R6 均有命中样本） */
function makeEvent(i: number, time: Date, presets: Preset[]): SeedEvent {
  const id = `E-SEED-${EVENT_BASE + i}`;
  const scene = i % 10;
  const baseCtx = {
    tenant_id: TENANT_ID,
    workspace_id: WS_ID,
    time: iso(time),
    stage: "stable",
    store: WS_NAME,
  };
  const hour = time.getHours();
  const window = hour >= 22 || hour < 8 ? "off-peak" : "peak";
  const mt = (tier: "standard" | "flagship") => ({
    model_id: "mock-hotel-001",
    tier,
    window,
    credits: tier === "flagship" ? 2 : 1,
  });
  const receipt = (t: Date) => ({
    synced: true,
    snapshot_uri: `data/snapshots/${id.toLowerCase()}.png`,
    verified_at: iso(new Date(t.getTime() + 45_000)),
  });
  const agentWho = (key: string) => {
    const p = presets.find((x) => x.preset_key === key)!;
    return { type: "agent" as const, id: p.preset_key, version: p.version };
  };

  switch (scene) {
    case 0: {
      // R1 自动调价：涨幅 ≤8%（pass）
      const rt = pick(ROOM_TYPES);
      const before = rt.base + int(-10, 10);
      const after = Math.round(before * (1 + rand() * 0.07));
      return {
        event_id: id,
        who: agentWho("pricing-agent"),
        context: { ...baseCtx, channel: pick(CHANNELS) },
        object: { type: "room_price", id: rt.id, label: rt.label },
        decision: {
          action: "price.adjust",
          before: { price: before },
          after: { price: after },
          basis: ["竞对西湖云舍同房型 ¥" + (after + int(10, 40)), "近 7 日 OCC 0.78"],
        },
        rule_impact: [{ rule_id: "R1", version: FENCE_VERSION, result: "pass" }],
        receipt: receipt(time),
        model_trace: mt("standard"),
      };
    }
    case 1: {
      // R6 差评必审（review → 挂起）
      return {
        event_id: id,
        who: agentWho("review-agent"),
        context: { ...baseCtx, channel: pick(CHANNELS) },
        object: { type: "review", id: `RV-${int(10000, 99999)}` },
        decision: {
          action: "review.reply",
          params: { rating: int(1, 3) },
          after: { draft: "非常抱歉给您带来不好的体验，我们已核实空调异响问题并安排检修……" },
          basis: ["品牌规范致歉结构", "档案 forbidden 已核对"],
        },
        rule_impact: [{ rule_id: "R6", version: FENCE_VERSION, result: "review" }],
        model_trace: mt("standard"),
      };
    }
    case 2: {
      // 夜班对账：无差异通过（留痕 G8）
      return {
        event_id: id,
        who: agentWho("reconcile-agent"),
        context: { ...baseCtx, channel: "夜班" },
        object: { type: "order", id: `OD-${int(100000, 999999)}` },
        decision: {
          action: "order.reconcile",
          params: { guarantee_anomaly: false },
          after: { diff: 0, rounds: 3 },
          basis: ["订单流水 × 渠道结算 × 担保核验三轮比对一致"],
        },
        rule_impact: [{ rule_id: "R5", version: FENCE_VERSION, result: "pass" }],
        model_trace: mt("standard"),
      };
    }
    case 3: {
      // 竞对采集（只读子调用，数据卡供调价引用）
      return {
        event_id: id,
        who: agentWho("competitor-agent"),
        context: { ...baseCtx, channel: "夜班" },
        object: { type: "channel", id: pick(CHANNELS) },
        decision: {
          action: "competitor.fetch",
          after: {
            card: pick(["西湖云舍酒店", "溪上云居民宿", "云栖轻奢酒店"]),
            price: int(360, 760),
          },
          basis: ["频次自律：请求间隔 ≥3s（L3.3）"],
        },
        rule_impact: [],
        model_trace: mt("standard"),
      };
    }
    case 4: {
      // 人类审批手势（王店长 批准差评回复）
      return {
        event_id: id,
        who: { type: "human", id: "MEM-001" },
        context: { ...baseCtx, channel: "inapp" },
        object: { type: "review", id: `RV-${int(10000, 99999)}` },
        decision: {
          action: "approval.gesture",
          after: { gesture: "approve", weight: 1 },
          basis: ["回复符合品牌规范，无档案外补偿承诺"],
        },
        rule_impact: [],
      };
    }
    case 5: {
      // R4 大额退款必审（review）
      return {
        event_id: id,
        who: agentWho("reconcile-agent"),
        context: { ...baseCtx, channel: pick(CHANNELS) },
        object: { type: "order", id: `OD-${int(100000, 999999)}` },
        decision: {
          action: "order.refund",
          params: { amount: int(500, 1200) },
          basis: ["客人到店无房，协商全额退款"],
        },
        rule_impact: [{ rule_id: "R4", version: FENCE_VERSION, result: "review" }],
        model_trace: mt("standard"),
      };
    }
    case 6: {
      // 巡检：07:00 只读巡检，P2 级异常（L9.2 不静默）
      return {
        event_id: id,
        who: agentWho("inspection-agent"),
        context: { ...baseCtx, channel: "巡检" },
        object: { type: "channel", id: pick(CHANNELS) },
        decision: {
          action: "inspection.scan",
          after: { level: "p2", finding: "飞猪渠道房态同步延迟 12 分钟" },
          basis: ["渠道状态探针"],
        },
        rule_impact: [],
        model_trace: mt("standard"),
      };
    }
    case 7: {
      // R2 保底价熔断演示（blocked）：试图调至 ¥368 < ¥380
      const rt = ROOM_TYPES[0];
      return {
        event_id: id,
        who: agentWho("pricing-agent"),
        context: { ...baseCtx, channel: "美团" },
        object: { type: "room_price", id: rt.id, label: rt.label },
        decision: {
          action: "price.adjust",
          before: { price: rt.base },
          after: { price: 368 },
          basis: ["竞对溪上云居降至 ¥366（未核对档案 forbidden）"],
        },
        rule_impact: [{ rule_id: "R2", version: FENCE_VERSION, result: "blocked" }],
        model_trace: mt("standard"),
      };
    }
    case 8: {
      // 内容发布：老渠道发布（auto 通过）
      return {
        event_id: id,
        who: agentWho("content-agent"),
        context: { ...baseCtx, channel: pick(CHANNELS), channel_new: false },
        object: { type: "content", id: `CT-${int(1000, 9999)}` },
        decision: {
          action: "content.publish",
          after: { title: "秋日云栖·亲子双床房套餐上线" },
          basis: ["品牌规范首图 16:9 实拍", "已核对禁用表达清单"],
        },
        rule_impact: [{ rule_id: "R3", version: FENCE_VERSION, result: "pass" }],
        receipt: receipt(time),
        model_trace: mt("flagship"),
      };
    }
    default: {
      // 系统事件：夜班状态机迁移 / 记忆固化
      return {
        event_id: id,
        who: { type: "system", id: "night-shift" },
        context: { ...baseCtx, channel: "夜班" },
        object: { type: "store", id: WS_ID },
        decision: {
          action: pick(["night.run.start", "night.package.deliver", "memory.consolidate"]),
          after: { note: "夜班状态机推进（F4.8）" },
        },
        rule_impact: [],
      };
    }
  }
}

/* ================= 主流程 ================= */

async function main(): Promise<void> {
  const presets = loadPresets();
  const fences = loadFences();
  const skillsDocs = loadComposedSkills();
  console.log(`✓ Bundle 资产读取：${presets.length} preset / ${fences.length} 围栏 / ${skillsDocs.length} 组合技能`);

  // —— 组织模型走 owner 连接（种子/迁移账号，RLS 对其不生效；见 0001_init.sql 注记）
  const owner = new pg.Client({ connectionString: DATABASE_URL });
  await owner.connect();

  const q = (text: string, params: unknown[]) => owner.query(text, params);

  // 租户 / 工作区
  await q(
    `INSERT INTO tenants (id, name, plan) VALUES ($1,$2,'pro') ON CONFLICT (id) DO NOTHING`,
    [TENANT_ID, TENANT_NAME],
  );
  await q(
    `INSERT INTO workspaces (id, tenant_id, name, slug, industry, stage, night_config)
     VALUES ($1,$2,$3,$4,'hotel','stable',$5) ON CONFLICT (id) DO NOTHING`,
    [
      WS_ID,
      TENANT_ID,
      WS_NAME,
      WS_SLUG,
      JSON.stringify({
        enabled: true,
        candidateTime: "18:00",
        startTime: "22:00",
        packageTime: "08:30",
        timezone: "Asia/Shanghai",
      }),
    ],
  );
  console.log(`✓ 租户与工作区：demo / 云栖酒店（主包 ${PRODUCT_PRIMARY_BUNDLE} · is_example=true）`);

  // 人类成员（王店长 owner / 陈经理 manager / 李前台 readonly，F5.6）
  for (const m of MEMBERS) {
    await q(
      `INSERT INTO members (id, workspace_id, member_no, name, role)
       VALUES ($1,$2,$3,$4,$5) ON CONFLICT (workspace_id, member_no) DO NOTHING`,
      [`${m.id.toLowerCase()}-id`, WS_ID, m.id, m.name, m.role],
    );
  }
  console.log(`✓ 人类成员 ×${MEMBERS.length}（${MEMBERS.map((m) => `${m.name}/${m.role}`).join("、")}）`);

  // Agent preset 实例（IM.5；F2.10 fence_bindings 原样落库）
  for (const p of presets) {
    await q(
      `INSERT INTO agents (id, workspace_id, preset_key, name, version, kind, readonly, fence_bindings, skills, status, meta)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'ready',$10)
       -- 行业包演进（岗位版本/围栏绑定/技能清单变化）必须能进已有演示工作区：
       -- 只 DO NOTHING 会让老工作区永久停留在旧定义，装配校验随之误判（F2.10 围栏绑定完整）。
       ON CONFLICT (id) DO UPDATE SET
         name = EXCLUDED.name, version = EXCLUDED.version, kind = EXCLUDED.kind,
         readonly = EXCLUDED.readonly, fence_bindings = EXCLUDED.fence_bindings,
         skills = EXCLUDED.skills, status = 'ready', meta = EXCLUDED.meta`,
      [
        `agt-${p.preset_key}`,
        WS_ID,
        p.preset_key,
        p.name,
        p.version,
        p.kind,
        p.readonly,
        JSON.stringify(p.fence_bindings),
        JSON.stringify(p.skills),
        JSON.stringify({
          description: p.description,
          night_shift: p.night_shift,
          high_risk: p.high_risk,
          tools: p.tools,
          prompt: p.prompt,
          write_back: p.write_back,
        }),
      ],
    );
  }
  console.log(`✓ Agent 实例 ×${presets.length}（含只读 preset：巡检/竞对/业主驾驶舱，L9.1）`);

  /**
   * 组合编制上岗（融合获客系统口径）：酒店经营 + 内容生产 + GEO 分发三个领域的编制
   * 同属一个获客闭环，必须一次装齐；围栏按组合并集落库（只紧不松：客群补丁更严时保留补丁，
   * 不会因为装入基线把客户已收紧的规则滚回去）。
   * 这里传入显式 executor（seed 用单连接，不需要再开池）。
   */
  const { provisionComposedWorkforce } = await import("@workloom/base/bundles");
  const composed = await provisionComposedWorkforce(
    { query: (sql: string, params?: unknown[]) => owner.query(sql, params as never[]) },
    { tenantId: TENANT_ID, workspaceId: WS_ID },
    PRODUCT_PRIMARY_BUNDLE,
    "system:seed",
  );
  console.log(
    `✓ 组合编制上岗：${composed.bundleIds.join(" + ")} 共 ${composed.rosterSize} 岗`
    + `（围栏并集 ${composed.fenceRules} 条 · 同名遮蔽 ${composed.shadowed.length} 处按主包裁决）`,
  );

  // 一店一档（槽①；forbidden 双写：archive 内 + 独立列，L1.6）
  // dataMode=simulated：落地向导（D24）横幅事实源——种子库即「全模拟运行态」，向导启用真实模式后翻转
  const archive = { ...yunqiArchive(), dataMode: "simulated" };
  await q(
    `INSERT INTO profiles (workspace_id, tenant_id, industry, archive, forbidden, pii_vault)
     VALUES ($1,$2,'hotel',$3,$4,NULL)
     ON CONFLICT (workspace_id) DO UPDATE SET archive = EXCLUDED.archive, forbidden = EXCLUDED.forbidden, updated_at = now()`,
    [WS_ID, TENANT_ID, JSON.stringify(archive), JSON.stringify(archive.forbidden)],
  );
  console.log("✓ 一店一档（含 forbidden 硬约束 ×2，保底价 ¥380 与 R2 同源）");

  // 基线围栏装载（R1–R20 v3，active；单调守卫 F2.3 由阶段二 B4 判定器执行）
  // 版本化装载纪律：id 含版本 slug（重复 seed 不撞 pkey）；同 rule_id 的旧 active 版本滚动为 rolled_back，保证单一生效版本
  const fenceVerSlug = FENCE_VERSION.replace(/[^a-z0-9]+/gi, "-").toLowerCase();
  for (const r of fences) {
    await q(
      `UPDATE fence_rules SET status = 'rolled_back'
       WHERE workspace_id = $1 AND rule_id = $2 AND version <> $3 AND status = 'active'`,
      [WS_ID, r.rule_id, FENCE_VERSION],
    );
    await q(
      `INSERT INTO fence_rules (id, rule_id, version, workspace_id, name, level, match_spec, action, is_baseline, status, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'active','system:seed')
       ON CONFLICT (rule_id, version, workspace_id) DO UPDATE SET status = 'active', match_spec = EXCLUDED.match_spec, action = EXCLUDED.action`,
      [
        `fr-${r.rule_id.toLowerCase()}-${fenceVerSlug}-${WS_ID}`,
        r.rule_id,
        FENCE_VERSION,
        WS_ID,
        r.name,
        r.level,
        JSON.stringify({ ...r.match, when: r.when }),
        JSON.stringify({ result: r.level === "auto" ? "pass" : r.level === "review" ? "review" : "blocked", note: r.note ?? "" }),
        r.is_baseline,
      ],
    );
  }
  console.log(`✓ 基线围栏装载 ×${fences.length}（${FENCE_VERSION}，active）`);

  // 官方技能 + 安装绑定（F8.1/F8.2）
  for (const s of skillsDocs) {
    const skillId = `skill-${s.name}`;
    // 技能装载幂等升级：ON CONFLICT 版本比对——版本变化才升级 body/fence_bindings，
    // 同版本重跑不覆盖（避免无谓行 churn；#17 纪律下运行时读安装快照，此更新不影响已装并集）
    await q(
      `INSERT INTO skills (id, level, bundle, name, version, description, fence_bindings, body, desensitized)
       VALUES ($1,'official',$2,$3,'1.0.0',$4,$5,$6,false)
       ON CONFLICT (id) DO UPDATE SET bundle = EXCLUDED.bundle, body = EXCLUDED.body, version = EXCLUDED.version,
                                      fence_bindings = EXCLUDED.fence_bindings
       WHERE skills.version IS DISTINCT FROM EXCLUDED.version`,
      [skillId, s.bundle, s.name, s.description, JSON.stringify(s.fenceBindings), s.body],
    );
    // 安装行与运行时 installSkill 同口径（#17 安装时快照 + D15-⑤ installed_version）：
    // 快照/版本从 skills 表取，保证 seed 与运行时两条路径的围栏并集计算一致
    await q(
      `INSERT INTO skill_installs (skill_id, workspace_id, installed_by, fence_bindings_snapshot, installed_version)
       SELECT s.id, $2, 'MEM-001', s.fence_bindings, s.version FROM skills s WHERE s.id = $1
       ON CONFLICT (skill_id, workspace_id) DO NOTHING`,
      [skillId, WS_ID],
    );
  }
  const skillCounts = skillsDocs.reduce<Record<string, number>>((acc, s) => {
    const key = s.bundle ?? "包外官方（skills/official）";
    acc[key] = (acc[key] ?? 0) + 1;
    return acc;
  }, {});
  console.log(`✓ 组合官方技能 ×${skillsDocs.length} 已安装（${Object.entries(skillCounts).map(([b, n]) => `${b} ${n}`).join(" + ")}；围栏绑定随安装生效，安装快照已落）`);

  // —— bundle_installs 装配台账登记（V5：组合编制口径，一键清空的精确卸载依据；幂等） ——
  // 业务口径（获客用增主题）：
  //  - ws-yunqi 是「酒店获客」的试点业务前台：C 端行业适配器契约要求唯一 active 安装为 hotel；
  //  - 资产台账仍覆盖组合编制全部岗位/围栏/技能（hotel + ai-video + geo-growth），否则一键清空留无主资产；
  //  - 获客用增的「产品演示工作区」是 ws-geo（bundles/geo-growth 单包示例，is_example=true）：
  //    游客首启（guestEnter）与默认演示登录（MEM-G01）都落在那里。
  const installId = `bi-${WS_ID}-hotel`;
  const agentRows = await q(`SELECT id FROM agents WHERE workspace_id=$1 ORDER BY preset_key`, [WS_ID]);
  const fenceRows = await q(`SELECT id FROM fence_rules WHERE workspace_id=$1 AND status='active' ORDER BY rule_id`, [WS_ID]);
  // 只登记三包 official 技能与编制引用的包外官方技能（bundle=null）：
  // team（工作区自建）/industry（脱敏共享）技能不随行业包卸载。
  const skillRows = await q(
    `SELECT si.skill_id FROM skill_installs si
       JOIN skills s ON s.id = si.skill_id
      WHERE si.workspace_id=$1 AND s.level='official' AND (s.bundle = ANY($2::text[]) OR s.bundle IS NULL)
      ORDER BY si.skill_id`,
    [WS_ID, ["hotel", "ai-video", "geo-growth"]],
  );
  const ledgerAssets = {
    preset_ids: agentRows.rows.map((r) => String(r.id)),
    fence_rule_ids: fenceRows.rows.map((r) => String(r.id)),
    skill_ids: skillRows.rows.map((r) => String(r.skill_id)),
  };
  // 单活跃安装不变式：先退役旧口径安装行，再落组合主包安装行。
  await q(
    `UPDATE bundle_installs SET status='uninstalled', uninstalled_at=now()
     WHERE workspace_id=$1 AND status='active' AND id<>$2`,
    [WS_ID, installId],
  );
  await q(
    `INSERT INTO bundle_installs (id, workspace_id, bundle_id, assets, status)
     VALUES ($1,$2,$3,$4,'active')
     ON CONFLICT (id) DO UPDATE SET bundle_id = EXCLUDED.bundle_id, assets = EXCLUDED.assets,
                                    status='active', uninstalled_at=NULL`,
    [installId, WS_ID, "hotel", JSON.stringify(ledgerAssets)],
  );
  console.log(`✓ 组合装配台账（${PRODUCT_PRIMARY_BUNDLE} · ${ledgerAssets.preset_ids.length} 岗 / ${ledgerAssets.fence_rule_ids.length} 围栏 / ${ledgerAssets.skill_ids.length} 技能）`);

  // 团队技能 + 行业共享技能（P6 装备库三区演示数据；F8.1 三级体系；幂等 ON CONFLICT）
  await q(
    `INSERT INTO skills (id, level, bundle, name, version, description, fence_bindings, body, desensitized)
     VALUES ('skill-t-ws-yunqi-weekly-ops-review','team','hotel','周一经营复盘','1.2.0',
             '每周一 08:00 自动汇总上周经营：入住率/RevPAR/差评闭环/调价采纳率，产出复盘报告草稿（本工作区自建，F8.3 三要素零代码锻造）。',
             '[]',
             '# 周一经营复盘\n\n## 触发（何时用）\n每周一 08:00 定时触发。\n\n## 步骤（怎么做）\n1. 汇总上周入住率与 RevPAR 曲线（只读）。\n2. 汇总差评闭环与调价采纳率。\n3. 产出复盘报告草稿进 P4 待审。\n\n## 边界（什么不做）\n不直接改价、不直接回评价。',
             false)
     ON CONFLICT (id) DO NOTHING`,
  );
  // 团队技能安装行同样补快照/版本（与运行时 installSkill 同口径）
  await q(
    `INSERT INTO skill_installs (skill_id, workspace_id, installed_by, fence_bindings_snapshot, installed_version)
     SELECT s.id, $1, 'MEM-002', s.fence_bindings, s.version FROM skills s
     WHERE s.id = 'skill-t-ws-yunqi-weekly-ops-review'
     ON CONFLICT (skill_id, workspace_id) DO NOTHING`,
    [WS_ID],
  );
  await q(
    `INSERT INTO skills (id, level, bundle, name, version, description, fence_bindings, body, desensitized)
     VALUES ('skill-i-peak-season-sprint','industry','east-china-hotel-alliance','旺季满房冲刺包','2.1.0',
             '华东酒店联盟共享：旺季满房冲刺打法包（竞对盯价+满房溢价节奏+差评快反 SOP），326 店在用；上架前已脱敏（L8.1 ✓）。',
             '["R1","R2"]',
             '# 旺季满房冲刺包\n\n## 触发（何时用）\n旺季/节假日满房冲刺期。\n\n## 步骤（怎么做）\n1. 竞对盯价：同档房型价差 >5% 提醒。\n2. 满房溢价节奏建议（单日涨幅 ≤8%，R1 管辖）。\n3. 差评快反 SOP（R6 必审）。\n\n## 边界（什么不做）\n不低于保底价（R2 红线）。',
             true)
     ON CONFLICT (id) DO NOTHING`,
  );
  console.log(`✓ 团队技能 ×1（已装）+ 行业共享技能 ×1（已脱敏待装）`);

  // 触发器（F4.7：07:00 巡检 / 22:00 夜班出征）
  const triggers = [
    { id: "tg-inspection-0700", name: "每日 07:00 只读巡检", kind: "cron", schedule: "0 7 * * *", action: { dispatch: "inspection-agent", template: "inspection.daily" } },
    { id: "tg-night-2200", name: "夜班 22:00 战队出征", kind: "cron", schedule: "0 22 * * *", action: { dispatch: "night-shift", template: "night.run.start" } },
    // v2.1 行业触发器 ×4（差评SLA/倒挂超售/FAQ萃取/断点周报）
    { id: "tg-review-sla-30min", name: "差评 SLA 扫描（每 30 分钟，R19 联动）", kind: "cron", schedule: "*/30 * * * *", action: { dispatch: "review-agent", template: "review.sla.scan" } },
    { id: "tg-parity-15min", name: "倒挂超售看门狗（每 15 分钟，R17/R18 联动）", kind: "cron", schedule: "*/15 * * * *", action: { dispatch: "competitor-agent", template: "channel.parity.scan" } },
    { id: "tg-faq-mine-sun", name: "FAQ 知识库周萃取（周日 03:00）", kind: "cron", schedule: "0 3 * * *", action: { dispatch: "phone-agent", template: "faq.weekly.mine" } },
    { id: "tg-incident-weekly", name: "断点率周报（周一 04:00）", kind: "cron", schedule: "0 4 * * 1", action: { dispatch: "desktop-agent", template: "incident.weekly.report" } },
    // v3.3 获客域触发器 ×2
    { id: "tg-intent-radar-0700", name: "意图雷达四矿源扫描（每日 07:00）", kind: "cron", schedule: "0 7 * * *", action: { dispatch: "channel-watcher", template: "intent.radar.scan" } },
    { id: "tg-lead-follow-30min", name: "线索跟进巡检（每 30 分钟，A级 1h SLA）", kind: "cron", schedule: "*/30 * * * *", action: { dispatch: "ai-receptionist", template: "lead.follow.scan" } },
    // 数字CEO 节拍（D21：CEO Loop；调度器消费前经治理守卫校验 charter.mode）
    { id: "tg-ceo-brief-0830", name: "公司CEO 晨报 08:30", kind: "cron", schedule: "30 8 * * *", action: { beat: "daily" } },
    { id: "tg-ceo-queue-2h", name: "公司CEO 审批巡检 2h", kind: "cron", schedule: "7 */2 * * *", action: { beat: "queue" } },
    { id: "tg-ceo-deviation", name: "公司CEO 目标偏差扫描", kind: "cron", schedule: "15 */4 * * *", action: { beat: "deviation" } },
    { id: "tg-ceo-breaker", name: "公司CEO 自治熔断巡检", kind: "cron", schedule: "45 23 * * *", action: { beat: "breaker" } },
  ];
  for (const t of triggers) {
    await q(
      `INSERT INTO triggers (id, workspace_id, name, kind, schedule, action, enabled, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,true,'MEM-001') ON CONFLICT (id) DO NOTHING`,
      [t.id, WS_ID, t.name, t.kind, t.schedule, JSON.stringify(t.action)],
    );
  }
  console.log("✓ 触发器 ×12（巡检/夜班 + 行业 4 + 获客 2 + 公司CEO 节拍 ×4）");

  // 演示线程（P1/P2 有数据可投影）
  const threads = [
    { id: "T-101", title: "周五旺季调价（大床房/双床房）", mode: "quest", status: "completed", done: 6, total: 6, agent: "agt-pricing-agent", by: "MEM-001" },
    { id: "T-102", title: "差评应急回复（携程 2 分评价）", mode: "quest", status: "pending_review", done: 3, total: 5, agent: "agt-review-agent", by: "MEM-001" },
    { id: "T-103", title: "飞猪渠道新客首图发布", mode: "agent", status: "running", done: 1, total: 4, agent: "agt-content-agent", by: "MEM-002" },
  ];
  for (const t of threads) {
    await q(
      `INSERT INTO threads (id, tenant_id, workspace_id, title, mode, status, progress_done, progress_total, created_by, agent_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) ON CONFLICT (id) DO NOTHING`,
      [t.id, TENANT_ID, WS_ID, t.title, t.mode, t.status, t.done, t.total, t.by, t.agent],
    );
  }
  console.log(`✓ 演示线程 ×${threads.length}（completed / pending_review / running）`);

  // 凭据引用占位（F7.7/L7.3：演示环境密文为占位串，真实加密阶段二实现）
  for (const c of [
    { id: "cred-ota-meituan", provider: "ota-meituan", ref_key: "yunqi/meituan" },
    { id: "cred-ota-ctrip", provider: "ota-ctrip", ref_key: "yunqi/ctrip" },
  ]) {
    await q(
      `INSERT INTO credentials (id, workspace_id, provider, ref_key, secret_enc, scopes, health)
       VALUES ($1,$2,$3,$4,'demo-placeholder-ciphertext',$5,'unknown') ON CONFLICT (id) DO NOTHING`,
      [c.id, WS_ID, c.provider, c.ref_key, JSON.stringify(["read", "write"])],
    );
  }
  console.log("✓ 凭据引用 ×2（占位密文，事件只记引用 ID）");

  /**
   * GR-02（2026-09-29 第二次修复）：种子手写了 T-101..T-103，取号序列必须越过这段号段。
   * 为什么放在种子而不是取号函数里：0050 曾把 `max()` 读回取号函数，等于把并发原子性
   * 交还给 max 竞争（12 路并发实测 1 个 500）。号源函数只做 nextval，落后就在**写入方**对齐。
   */
  const seqFloor = await alignReadableIdSequences(owner);
  console.log(`✓ 可读号源对齐：threads→${seqFloor.threads}，video_projects→${seqFloor.videoProjects}`);

  // —— 事件写入：切 gateway 角色（F1.2 唯一可 INSERT biz_events）
  // L2：GUC 一律 is_local=true 且包在显式事务内（事务提交即失效，不留会话级残留）；
  // 后续 approvals/night_runs/org_memory/C 端运行态等 gateway 段写入同在此事务内。
  await owner.end();
  const gw = new pg.Client({ connectionString: GATEWAY_URL });
  await gw.connect();
  await gw.query("BEGIN");
  await gw.query("SELECT set_config('app.workspace_id', $1, true)", [WS_ID]);
  await gw.query("SELECT set_config('app.tenant_id', $1, true)", [TENANT_ID]);

  // 哈希链续接（幂等重跑时接在已有链尾之后；链内已存在的事件按存在预检跳过）
  // 链粒度 = tenant+workspace（P1-5 与 append_event_insert 同口径）
  const last = await gw.query(
    `SELECT hash FROM biz_events WHERE tenant_id=$1 AND workspace_id=$2 ORDER BY seq DESC LIMIT 1`,
    [TENANT_ID, WS_ID],
  );
  let prevHash = (last.rows[0]?.hash as string) ?? GENESIS_HASH;

  const times = demoTimeline();
  // 线程归属：调价/差评/内容场景挂对应线程，其余挂夜班会话
  const sessionOf = (scene: number): string | null =>
    scene === 0 || scene === 7 ? "T-101" : scene === 1 || scene === 4 ? "T-102" : scene === 8 ? "T-103" : null;

  /** 幂等存在预检（L1.4 确定性口径）：同 (tenant_id,event_id) 已存在即跳过——
   *  演示时间轴含实时时钟，重跑同 ID 事件 payload 必然不同，直撞 append_event_insert
   *  会触发 P0-3 md5 冲突比对按抢占攻击拒写；种子语义是「已种即跳过」，故先查后写。 */
  const eventExists = async (eventId: string): Promise<boolean> => {
    const r = await gw.query(
      `SELECT 1 FROM biz_events WHERE tenant_id=$1 AND event_id=$2`,
      [TENANT_ID, eventId],
    );
    return (r.rowCount ?? 0) > 0;
  };

  let inserted = 0;
  let dupSkipped = 0;
  for (let i = 1; i <= EVENT_COUNT; i++) {
    const ev = makeEvent(i, times[i - 1] as Date, presets);
    // E-SEED- 前缀经回放占位缝过附录 E 校验（结构强度与 safeParseBusinessEvent 一致）
    const checked = safeParseReplayAwareEvent(ev as never);
    if (!checked.success) {
      throw new Error(`种子事件 ${ev.event_id} 未过附录 E 校验：${checked.error.message}`);
    }
    if (await eventExists(ev.event_id)) {
      dupSkipped += 1;
      continue;
    }
    // #32：哈希输入与存库 payload 均为 zod parse 后的 checked.data（与 appendEvent 逐字节一致）
    const payload = JSON.stringify(checked.data);
    const hash = eventHash(prevHash, checked.data);
    // P0-3：走 append_event_insert 特权函数（不再裸 INSERT）——DB 层自校验
    // GUC 上下文一致性与链式接龙（断链拒写），冲突按 md5 比对（此处有存在预检兜底不会触达）
    const res = await gw.query<{ seq: string | null; inserted: boolean }>(
      `SELECT * FROM append_event_insert($1,$2,$3,$4,$5,$6,$7,$8)`,
      [ev.event_id, TENANT_ID, WS_ID, sessionOf(i % 10), payload, prevHash, hash, ev.context.time],
    );
    if (res.rows[0]?.inserted) {
      prevHash = hash; // 只有真实落库的事件才进链
      inserted += 1;
    } else {
      dupSkipped += 1; // 并发下被同 payload 抢先落库（理论路径，按幂等丢弃计）
    }
  }

  console.log(`✓ 五元事件：新写入 ${inserted} 条，幂等丢弃 ${dupSkipped} 条（L1.4）`);

  // ============ v3.3 获客域剧本事件 ×12（获客五环端到端留痕；E-SEED-8901 起） ============
  {
    const acqNow = Date.now();
    const acqAt = (minAgo: number) => new Date(acqNow - minAgo * 60_000).toISOString();
    const acqWho = (key: string) => {
      const pr = presets.find((x) => x.preset_key === key)!;
      return { type: "agent" as const, id: pr.preset_key, version: pr.version };
    };
    const acqCtx = (time: string) => ({ tenant_id: TENANT_ID, workspace_id: WS_ID, time, stage: "stable", store: WS_NAME });
    const acqMt = { model_id: "mock-hotel-001", tier: "standard", window: "peak", credits: 1 };
    const acqReceipt = (time: string) => ({ synced: true, snapshot_uri: "data/snapshots/acq.png", verified_at: time });
    const ri = (rule_id: string, result: string) => [{ rule_id, version: FENCE_VERSION, result }];

    const acqEvents: SeedEvent[] = [
      // ① 意图雷达周报（channel-watcher，只读员工产出情报）
      {
        event_id: "E-SEED-8901", who: acqWho("channel-watcher"), context: acqCtx(acqAt(480)),
        object: { type: "intent_signal", id: "radar-w35", label: "意图雷达周报 W35" },
        decision: { action: "intent.radar.report", after: { top: [
          { topic: "杭州亲子酒店 带泳池", heat: 1842, source: "竞对评论区+query", gap: "本店无泳池实测内容", play: "亲子双床房+儿童乐园实拍" },
          { topic: "西湖边 隔音好 酒店", heat: 1207, source: "OTA差评聚类（竞对隔音差评）", gap: "对手差评=我方卖点", play: "静音实测短视频" },
          { topic: "杭州商旅 延迟退房", heat: 886, source: "本店私信高频", gap: "GEO 图文缺场景词", play: "商旅延迟退房权益六段式" },
        ] }, basis: ["四矿源周频采集", "信号评分模型 频次0.4+增速0.3+意图浓度0.3"] },
        rule_impact: [], receipt: acqReceipt(acqAt(480)), model_trace: acqMt,
      } as SeedEvent,
      // ② 房态联动内容排期
      {
        event_id: "E-SEED-8902", who: acqWho("content-agent"), context: acqCtx(acqAt(460)),
        object: { type: "campaign", id: "camp-w35-family", label: "W35 亲子内容排期" },
        decision: { action: "campaign.schedule", after: { items: 3, note: "本周五-日满房 92%：满房停推大床房；下周三-四空房率 41%：淡季猛推亲子券", links: ["radar-w35"] }, basis: ["意图雷达 TOP1 信号", "房态日历联动"] },
        rule_impact: [], receipt: acqReceipt(acqAt(460)), model_trace: acqMt,
      } as SeedEvent,
      // ③ 亲子短视频发布（挂 POI+券；R25 口径过审）
      {
        event_id: "E-SEED-8903", who: acqWho("content-agent"), context: acqCtx(acqAt(420)),
        object: { type: "campaign", id: "vid-family-081", label: "短视频《带娃住云栖的一天》" },
        decision: { action: "campaign.publish", params: { fact_check_passed: true }, after: { platform: "douyin", poi: "POI-YQ-001", coupon: "CP-FAM-299", plays_24h: 86000 }, basis: ["R25 口径校验通过（房价/权益与档案一致）"] },
        rule_impact: ri("R25", "pass"), receipt: acqReceipt(acqAt(420)), model_trace: acqMt,
      } as SeedEvent,
      // ④ 评论区意图→私信留资（A 级；R21 报价人审通过）
      {
        event_id: "E-SEED-8904", who: acqWho("ai-receptionist"), context: acqCtx(acqAt(300)),
        object: { type: "lead", id: "lead-20260824-001", label: "A级线索·亲子国庆询价" },
        decision: { action: "lead.capture", after: {
          source_chain: { channel: "douyin", content_id: "vid-family-081", entry: "comment→dm" },
          intent: "国庆 3 天 2 晚，两大一小，要亲子双床房",
          contact_masked: "138****7766", grade: "A", first_response_sec: 26,
        }, basis: ["评论区意图识别→私信接待", "R21 报价口径人审通过（ap 同步留痕）"] },
        rule_impact: [...ri("R21", "pass"), ...ri("R24", "pass")], receipt: acqReceipt(acqAt(300)), model_trace: acqMt,
      } as SeedEvent,
      // ⑤ AI 搜索口令进线（B 级）
      {
        event_id: "E-SEED-8905", who: acqWho("ai-receptionist"), context: acqCtx(acqAt(260)),
        object: { type: "lead", id: "lead-20260824-002", label: "B级线索·AI搜索口令" },
        decision: { action: "lead.capture", after: {
          source_chain: { channel: "ai_search", query: "杭州商旅酒店 延迟退房", entry: "口令「云栖」→官网落地页" },
          intent: "下周出差 2 晚，关注延迟退房与发票", contact_masked: "wx_****_liu", grade: "B",
        }, basis: ["GEO 六段式行动锚点命中"] },
        rule_impact: ri("R24", "pass"), receipt: acqReceipt(acqAt(260)), model_trace: acqMt,
      } as SeedEvent,
      // ⑥ A 级派单店长接管（1h SLA 内）
      {
        event_id: "E-SEED-8906", who: acqWho("ai-receptionist"), context: acqCtx(acqAt(255)),
        object: { type: "lead", id: "lead-20260824-001", label: "A级线索派单" },
        decision: { action: "lead.assign", after: { owner: "MEM-001", sla_minutes: 60, elapsed_minutes: 5, summary: "国庆亲子询价，建议报价区间 788-888/晚（人审口径）" }, basis: ["A 级 1h SLA"] },
        rule_impact: [], receipt: acqReceipt(acqAt(255)), model_trace: acqMt,
      } as SeedEvent,
      // ⑦ 亲子通兑券 SKU 上架（R26 定价过线）
      {
        event_id: "E-SEED-8907", who: acqWho("coupon-operator"), context: acqCtx(acqAt(400)),
        object: { type: "coupon_sku", id: "CP-FAM-299", label: "亲子通兑券 299" },
        decision: { action: "coupon.create", params: { price: 299 }, after: { face_value: 528, stock: 200, validity_days: 120, blackout: ["2026-10-01", "2026-10-03"], floor_check: "299 ≥ 380×0.85=323？否→调整权益包后 339 过线" }, basis: ["R26 定价红线校验", "淡季填谷策略"] },
        rule_impact: ri("R26", "pass"), receipt: acqReceipt(acqAt(400)), model_trace: acqMt,
      } as SeedEvent,
      // ⑧ 售罄后推广被 R22 熔断（阻断样本）
      {
        event_id: "E-SEED-8908", who: acqWho("coupon-operator"), context: acqCtx(acqAt(180)),
        object: { type: "coupon_sku", id: "CP-BIZ-259", label: "商旅券推广熔断" },
        decision: { action: "coupon.promote", params: {}, after: { blocked_reason: "库存 0，相关内容已停投、AI 话术已切换" }, basis: ["R22 库存熔断"] },
        rule_impact: ri("R22", "blocked"), receipt: acqReceipt(acqAt(180)), model_trace: acqMt,
      } as SeedEvent,
      // ⑨ 券核销预订（成交）
      {
        event_id: "E-SEED-8909", who: acqWho("coupon-operator"), context: acqCtx(acqAt(240)),
        object: { type: "booking_order", id: "BK-20260824-101", label: "券核销订单" },
        decision: { action: "booking.confirm", after: { lead_id: "lead-20260824-001", coupon: "CP-FAM-299", room: "亲子双床房", nights: 2, amount: 678, checkin: "2026-10-04" }, basis: ["A 级线索店长接管后成交"] },
        rule_impact: [], receipt: acqReceipt(acqAt(240)), model_trace: acqMt,
      } as SeedEvent,
      // ⑩ AI 搜索入口直连预订（成交）
      {
        event_id: "E-SEED-8910", who: acqWho("ai-receptionist"), context: acqCtx(acqAt(200)),
        object: { type: "booking_order", id: "BK-20260824-102", label: "AI 搜索直连订单" },
        decision: { action: "booking.confirm", after: { lead_id: "lead-20260824-002", room: "商旅大床房", nights: 2, amount: 796, checkin: "2026-09-02", channel: "direct" }, basis: ["B 级培育池转化"] },
        rule_impact: [], receipt: acqReceipt(acqAt(200)), model_trace: acqMt,
      } as SeedEvent,
      // ⑪ 归因回写 + OTA 佣金节省对照（北极星数据源）
      {
        event_id: "E-SEED-8911", who: acqWho("coupon-operator"), context: acqCtx(acqAt(60)),
        object: { type: "conversion", id: "conv-daily-0824", label: "当日归因战报" },
        decision: { action: "conversion.attribute", after: {
          deals: 2, amount: 1474,
          by_entry: { douyin: 678, ai_search: 796 },
          ota_commission_saved: { note: "同单走 OTA 佣金对照", meituan_10pct: 147.4, xiecheng_12pct: 176.9 },
          month_to_date: { deals: 152, amount: 128600, commission_saved_est: 14900, by_entry_mtd: { douyin: 61400, ai_search: 43800, xiaohongshu: 15600, wecom_referral: 7800 } },
        }, basis: ["来源链回写", "commission_rules 档案口径"] },
        rule_impact: [], receipt: acqReceipt(acqAt(60)), model_trace: acqMt,
      } as SeedEvent,
      // ⑬ 市场动态扫描（区域热度/竞对/节假日需求）
      {
        event_id: "E-SEED-8913", who: acqWho("channel-watcher"), context: acqCtx(acqAt(1440)),
        object: { type: "intent_signal", id: "market-scan-w35", label: "市场动态扫描 W35" },
        decision: { action: "market.scan", after: {
          region_heat: { 西湖区: 92, 滨江区: 74, 拱墅区: 61, note: "开学季+中秋前置，亲子需求周环比 ▲38%" },
          competitor_moves: [{ name: "西湖云舍", move: "抖音首播卖券 399 亲子套餐", threat: "中" }, { name: "云栖轻奢", move: "携程评分 4.9 但价格上调 12%", threat: "低" }],
          ota_review_gap: "竞对近 30 天差评高频词：隔音(17)/早餐排队(11)/停车难(8)——全部是我方可打卖点",
          holiday_forecast: "国庆前 21 天预订曲线启动，预测 10.1-10.3 满房，10.4-10.6 仍有 35% 空窗可抢",
        }, basis: ["OTA/竞对/区域热度三源扫描", "节假日需求预测模型"] },
        rule_impact: [], receipt: acqReceipt(acqAt(1440)), model_trace: acqMt,
      } as SeedEvent,
      // ⑭ 周策略备忘（公司CEO 定调）
      {
        event_id: "E-SEED-8914", who: acqWho("company-ceo"), context: acqCtx(acqAt(1400)),
        object: { type: "campaign", id: "strategy-w35", label: "W35 获客策略备忘" },
        decision: { action: "strategy.memo", after: {
          theme: "开学季亲子收口 + 国庆错峰抢订",
          content_plan: "短视频 ×6（亲子实拍 3/静音实测 2/延迟退房 1）+ 直播 ×2（周四/周日晚）+ GEO 图文 ×4",
          coupon_plan: "亲子券补库存 200 → 400；上线国庆预售券 ¥899（10.4 后可约，填 35% 空窗）",
          budget: { douyin_boost: 3000, note: "小额测试先跑，CTR>4% 再加投（超上限必请示）" },
          kpi: "本周目标：线索 ≥90 / 券核销 ≥60 / GEO 提及率 ≥32%",
        }, basis: ["市场扫描 W35", "意图雷达 TOP3", "房态日历联动"] },
        rule_impact: [], receipt: acqReceipt(acqAt(1400)), model_trace: acqMt,
      } as SeedEvent,
      // ⑮ 目标人群圈选
      {
        event_id: "E-SEED-8915", who: acqWho("channel-watcher"), context: acqCtx(acqAt(1380)),
        object: { type: "intent_signal", id: "audience-w35", label: "人群圈选三细分" },
        decision: { action: "audience.segment", after: {
          segments: [
            { key: "亲子家庭", share: 0.42, intent: "儿童乐园/泳池/家庭房/安全", channels: ["抖音", "小红书"], hook: "带娃的一天 vlog" },
            { key: "商旅人士", share: 0.35, intent: "延迟退房/发票/安静/近地铁", channels: ["AI搜索", "知乎"], hook: "商旅权益六段式" },
            { key: "情侣周末", share: 0.23, intent: "湖景/拍照/氛围感", channels: ["小红书", "视频号"], hook: "日落窗景实拍" },
          ],
          note: "人群-意图-渠道-钩子四元组直接进内容排期与投放定向",
        }, basis: ["评论私信语义聚类", "query 词性分析", "历史成交画像"] },
        rule_impact: [], receipt: acqReceipt(acqAt(1380)), model_trace: acqMt,
      } as SeedEvent,
      // ⑯ 视频脚本成套（AI 视频制作）
      {
        event_id: "E-SEED-8916", who: acqWho("content-agent"), context: acqCtx(acqAt(1320)),
        object: { type: "content", id: "script-family-081", label: "脚本《带娃住云栖的一天》" },
        decision: { action: "script.draft", after: { shots: 7, hook: "2 岁娃进门第一句话：妈妈我还要来！", has_ai_answer_variant: true, duration: "38s" }, basis: ["人群钩子：亲子家庭", "意图信号：泳池+乐园"] },
        rule_impact: [], receipt: acqReceipt(acqAt(1320)), model_trace: acqMt,
      } as SeedEvent,
      // ⑰ 导演评审过线
      {
        event_id: "E-SEED-8917", who: acqWho("content-agent"), context: acqCtx(acqAt(1300)),
        object: { type: "content", id: "script-family-081", label: "导演评审 S01-S07" },
        decision: { action: "render.review", after: { scores: { 钩子: 4.6, 真实感: 4.8, 节奏: 4.2, 合规: 5.0, 转化力: 4.4 }, verdict: "pass", note: "S03 重拍一次（娃的表情穿帮）后过线" }, basis: ["5 维导演评分", "事实红线闸机"] },
        rule_impact: ri("R25", "pass"), receipt: acqReceipt(acqAt(1300)), model_trace: acqMt,
      } as SeedEvent,
      // ⑱ 渲染提交
      {
        event_id: "E-SEED-8918", who: acqWho("content-agent"), context: acqCtx(acqAt(1280)),
        object: { type: "content", id: "render-family-081", label: "渲染合成 v1" },
        decision: { action: "render.submit", after: { engine: "seedance-2.0", shots: 7, credits: 14, subtitle: true, platform_pack: ["douyin", "xiaohongshu"] }, basis: ["评审过线才允许烧额度"] },
        rule_impact: [], receipt: acqReceipt(acqAt(1280)), model_trace: acqMt,
      } as SeedEvent,
      // ⑲ 爆款发布（抖音 86.2w）
      {
        event_id: "E-SEED-8919", who: acqWho("content-agent"), context: acqCtx(acqAt(1180)),
        object: { type: "content", id: "vid-family-081", label: "抖音爆款《带娃住云栖的一天》" },
        decision: { action: "campaign.publish", params: { fact_check_passed: true }, after: { platform: "douyin", plays: 862000, likes: 21400, comments: 486, favorites: 3120, shares: 892, poi: "POI-YQ-001", coupon: "CP-FAM-299", note: "发布 48h 数据；评论区获客意图 73 条已全部分流" }, basis: ["R25 口径校验", "POI+券挂载"] },
        rule_impact: ri("R25", "pass"), receipt: acqReceipt(acqAt(1180)), model_trace: acqMt,
      } as SeedEvent,
      // ⑳ 小红书种草
      {
        event_id: "E-SEED-8920", who: acqWho("content-agent"), context: acqCtx(acqAt(1120)),
        object: { type: "content", id: "xhs-quiet-012", label: "小红书《临街酒店能有多安静》" },
        decision: { action: "campaign.publish", params: { fact_check_passed: true }, after: { platform: "xiaohongshu", plays: 53000, favorites: 3120, note: "灵感来自竞对差评「隔音差」——分贝仪实测，收藏率 5.9% 远超均值" }, basis: ["OTA 差评矿源", "人群钩子：商旅/浅眠"] },
        rule_impact: ri("R25", "pass"), receipt: acqReceipt(acqAt(1120)), model_trace: acqMt,
      } as SeedEvent,
      // ㉑ 直播卖券（2 场 GMV）
      {
        event_id: "E-SEED-8921", who: acqWho("coupon-operator"), context: acqCtx(acqAt(1000)),
        object: { type: "live_campaign", id: "live-w35-thu", label: "周四直播卖券专场" },
        decision: { action: "live.campaign", after: { sessions: 2, gmv: 18400, coupons_sold: 52, peak_online: 1200, note: "对标实证形态：边走边播看房型+亲子乐园实景；切片 6 条二次分发" }, basis: ["W35 策略备忘", "券库存联动"] },
        rule_impact: [...ri("R22", "pass"), ...ri("R26", "pass")], receipt: acqReceipt(acqAt(1000)), model_trace: acqMt,
      } as SeedEvent,
      // ㉒ GEO 六段式收录
      {
        event_id: "E-SEED-8922", who: acqWho("content-agent"), context: acqCtx(acqAt(900)),
        object: { type: "content", id: "geo-biz-007", label: "GEO 图文《杭州商旅酒店怎么选》" },
        decision: { action: "geo.publish", after: { channels: ["知乎", "百家号"], structure: "六段式（结论→事实→场景→细节→对比→行动锚点）", anchor_code: "云栖", indexed: true, note: "知乎发布 36h 被豆包/DeepSeek 引用" }, basis: ["hotel-geo-content 技能", "实体卡口径一致"] },
        rule_impact: ri("R25", "pass"), receipt: acqReceipt(acqAt(900)), model_trace: acqMt,
      } as SeedEvent,
      // ㉓ 酒店词能见度周报（区域第一）
      {
        event_id: "E-SEED-8923", who: acqWho("channel-watcher"), context: acqCtx(acqAt(840)),
        object: { type: "intent_signal", id: "visibility-w35", label: "酒店词能见度周报" },
        decision: { action: "visibility.snapshot", after: {
          mention_rate: 0.34, first_rate: 0.12, sov: 0.28, rank: "区域第一（竞对A 21%/10%/19%）",
          by_platform: { doubao: 0.41, deepseek: 0.36, yuanbao: 0.29, chatgpt: 0.30 },
          trend_4w: [0.22, 0.26, 0.30, 0.34], note: "4 周连涨；「杭州亲子酒店」首推破零后已 3 次",
        }, basis: ["query 集 32 词周频采集", "原始答案截图存证"] },
        rule_impact: [], receipt: acqReceipt(acqAt(840)), model_trace: acqMt,
      } as SeedEvent,
      // ㉔ 落地页批量留资（周末高峰）
      {
        event_id: "E-SEED-8924", who: acqWho("ai-receptionist"), context: acqCtx(acqAt(720)),
        object: { type: "lead", id: "lead-batch-w35", label: "周末落地页批量线索" },
        decision: { action: "lead.capture", after: { count: 47, entries: { douyin_lp: 21, xiaohongshu_lp: 14, ai_search_code: 12 }, peak_window: "周六 20-22 点", first_response_p50_sec: 31, note: "高峰首响仍守住 60s SLA（AI 接待已按复盘调整话术优先级）" }, basis: ["落地页表单+行动锚点"] },
        rule_impact: ri("R24", "pass"), receipt: acqReceipt(acqAt(720)), model_trace: acqMt,
      } as SeedEvent,
      // ㉕ B 级培育转化（商旅长住）
      {
        event_id: "E-SEED-8925", who: acqWho("ai-receptionist"), context: acqCtx(acqAt(600)),
        object: { type: "lead", id: "lead-20260820-017", label: "B级培育转化·商旅长住" },
        decision: { action: "lead.nurture", after: { nurture_days: 12, touches: 3, converted: true, deal: "长住协议价 ¥428/晚 × 每月 8 晚", note: "培育池第 3 次定向触达（延迟退房权益内容）后主动回询" }, basis: ["B 级培育 SOP", "频率合规 R9"] },
        rule_impact: ri("R9", "pass"), receipt: acqReceipt(acqAt(600)), model_trace: acqMt,
      } as SeedEvent,
      // ㉖ 会议团大单（A 级人审报价成交）
      {
        event_id: "E-SEED-8926", who: acqWho("ai-receptionist"), context: acqCtx(acqAt(500)),
        object: { type: "booking_order", id: "BK-20260824-103", label: "会议团 20 间夜大单" },
        decision: { action: "booking.confirm", after: { lead_id: "lead-20260824-003", rooms: 10, nights: 2, amount: 17520, rate: 438, deposit: 0.3, note: "R21 人审报价 438/间夜 + 30% 定金担保（R5 联动）；9 月中旬周中填谷" }, basis: ["A 级 1h SLA", "人审报价留痕"] },
        rule_impact: [...ri("R21", "pass"), ...ri("R5", "pass")], receipt: acqReceipt(acqAt(500)), model_trace: acqMt,
      } as SeedEvent,
      // ㉗ 月度归因战报（丰厚：¥128,600 / 节省 ¥14,900）
      {
        event_id: "E-SEED-8927", who: acqWho("coupon-operator"), context: acqCtx(acqAt(45)),
        object: { type: "conversion", id: "conv-month-0825", label: "月度归因战报（8.1-8.25）" },
        decision: { action: "conversion.attribute", after: {
          period: "2026-08-01~25", deals: 152, amount: 128600,
          by_entry: { douyin: 61400, ai_search: 43800, xiaohongshu: 15600, wecom_referral: 7800 },
          mix: { coupon_verified: { deals: 96, amount: 61400 }, direct_booking: { deals: 56, amount: 67200 } },
          ota_commission_saved: 14900, saved_note: "同单走 OTA 加权佣金（美团10%/携程12%）对照——这就是省下的纯利",
          occupancy_lift: "直连+券订单贡献 OCC +6.8pt（83% 中含）",
        }, basis: ["来源链全量回写", "commission_rules 档案口径"] },
        rule_impact: [], receipt: acqReceipt(acqAt(45)), model_trace: acqMt,
      } as SeedEvent,
      // ㉘ 老带新转介绍
      {
        event_id: "E-SEED-8928", who: acqWho("guest-success"), context: acqCtx(acqAt(400)),
        object: { type: "member", id: "referral-w35", label: "老带新转介绍周" },
        decision: { action: "member.referral", after: { deals: 17, amount: 7800, top_advocate: "周先生（金卡）带来 4 单", reward_cost: 680, roi: "激励成本 ¥680 → 成交 ¥7,800（11.5×）" }, basis: ["双向礼遇 SOP", "渠道码归因"] },
        rule_impact: [], receipt: acqReceipt(acqAt(400)), model_trace: acqMt,
      } as SeedEvent,
      // ㉙ 好评资产沉淀（OTA 4.6→4.8）
      {
        event_id: "E-SEED-8929", who: acqWho("guest-success"), context: acqCtx(acqAt(300)),
        object: { type: "member", id: "review-asset-w35", label: "好评资产周报" },
        decision: { action: "review.asset.boost", after: { new_reviews: 42, positive_rate: 0.93, ota_score: "4.6 → 4.8", note: "离店 2h 关怀触点的好评引导（合规不利诱）；差评 2 条均 SLA 内响应并闭环" }, basis: ["好评引导 SOP", "R19 差评 SLA"] },
        rule_impact: [...ri("R19", "pass"), ...ri("R9", "pass")], receipt: acqReceipt(acqAt(300)), model_trace: acqMt,
      } as SeedEvent,
      // ㉚ 六级漏斗周报复盘反哺
      {
        event_id: "E-SEED-8930", who: acqWho("company-ceo"), context: acqCtx(acqAt(120)),
        object: { type: "alert", id: "funnel-w35", label: "六级漏斗周报 W35" },
        decision: { action: "funnel.weekly", after: {
          funnel: { exposure: 6200000, engage: 312000, inquiry: 1842, lead: 486, deal: 152, repurchase: 47 },
          rates: { 曝光互动: 0.050, 互动询盘: 0.0059, 询盘留资: 0.264, 留资成交: 0.313, 成交复购: 0.309 },
          weakest: "互动→询盘 0.59%（视频 CTA 弱）",
          action: "下周全部视频前 3s 加「评论区扣 1 领券」口播；GEO 图文行动锚点前置到第 2 段",
          roi: "内容+投放成本 ¥9,400 → 归因成交 ¥128,600（13.7×）",
        }, basis: ["六级漏斗报表", "周一晨会裁决"] },
        rule_impact: [], receipt: acqReceipt(acqAt(120)), model_trace: acqMt,
      } as SeedEvent,
      // ⑫ 住客关怀 + 好评引导（合规）
      {
        event_id: "E-SEED-8912", who: acqWho("guest-success"), context: acqCtx(acqAt(30)),
        object: { type: "member", id: "mb-zhou", label: "住客关怀·周先生" },
        decision: { action: "guest.care.send", after: { stage: "checkout_2h", nps_hint: "满意", review_guided: true, no_inducement: true }, basis: ["离店 2h 关怀 SOP", "合规好评引导（不利诱）"] },
        rule_impact: ri("R9", "pass"), receipt: acqReceipt(acqAt(30)), model_trace: acqMt,
      } as SeedEvent,
    ];

    let acqInserted = 0;
    for (const ev of acqEvents) {
      const checked = safeParseReplayAwareEvent(ev as never);
      if (!checked.success) throw new Error(`获客事件 ${ev.event_id} 未过附录 E 校验：${checked.error.message}`);
      if (await eventExists(ev.event_id)) continue;
      const payload = JSON.stringify(checked.data);
      const hash = eventHash(prevHash, checked.data);
      const res = await gw.query<{ seq: string | null; inserted: boolean }>(
        `SELECT * FROM append_event_insert($1,$2,$3,$4,$5,$6,$7,$8)`,
        [ev.event_id, TENANT_ID, WS_ID, `sess-acq-${ev.event_id.slice(-2)}`, payload, prevHash, hash, (ev.context as { time: string }).time],
      );
      if (res.rows[0]?.inserted) { prevHash = hash; acqInserted += 1; }
    }
    console.log(`✓ 获客域剧本事件 ×${acqInserted}/30（市场扫描→策略→人群→AI视频→社媒→GEO→线索→成交→归因→复购，全流程留痕）`);
  }

  // CEO 晨报事件（剧场汇报气泡/董事长视图简报流的数据源；幂等键 E-SEED-8999）
  {
    const ev = {
      event_id: "E-SEED-8999",
      who: { type: "agent", id: "captain", version: "v1.0" },
      context: { tenant_id: TENANT_ID, workspace_id: WS_ID, time: new Date().toISOString(), stage: "stable", store: WS_NAME },
      object: { type: "workspace", id: WS_ID, label: WS_NAME },
      decision: {
        action: "ceo.briefing",
        after: { text: "董事长，早报已备：昨夜班组完成 14 项作业（评论/巡检/对账各线正常），1 件差评处置请您拍板；本周 OCC 与 RevPAR 趋势见节拍控制台。试用期边界降一档执行中。" },
        basis: ["CEO Loop 日频晨报 08:30"],
      },
      rule_impact: [],
      receipt: { synced: true, snapshot_uri: "data/snapshots/e-seed-8999.png", verified_at: new Date().toISOString() },
      model_trace: { model_id: "mock-hotel-001", tier: "standard", window: "peak", credits: 1 },
    };
    const checked = safeParseReplayAwareEvent(ev as never);
    if (!checked.success) throw new Error(`晨报事件未过校验：${checked.error.message}`);
    if (await eventExists(ev.event_id)) {
      console.log("✓ CEO 晨报事件（已存在，幂等跳过）");
    } else {
      const payload = JSON.stringify(checked.data);
      const hash = eventHash(prevHash, checked.data);
      const res = await gw.query<{ seq: string | null; inserted: boolean }>(
        `SELECT * FROM append_event_insert($1,$2,$3,$4,$5,$6,$7,$8)`,
        [ev.event_id, TENANT_ID, WS_ID, null, payload, prevHash, hash, ev.context.time],
      );
      if (res.rows[0]?.inserted) prevHash = hash;
      console.log("✓ CEO 晨报事件（剧场汇报气泡数据源）");
    }
  }

  // 审批样例：取最近两条 review 结果事件挂审批（一 pending 一 approved）
  const reviewEvents = await gw.query(
    `SELECT event_id, payload FROM biz_events
     WHERE tenant_id=$1 AND workspace_id=$2
       AND payload->'rule_impact' @> '[{"result":"review"}]'::jsonb
     ORDER BY seq DESC LIMIT 2`,
    [TENANT_ID, WS_ID],
  );
  for (const [idx, row] of reviewEvents.rows.entries()) {
    const p = row.payload as SeedEvent;
    const status = idx === 0 ? "pending" : "approved";
    await gw.query(
      `INSERT INTO approvals (approval_id, tenant_id, workspace_id, event_id, channel, status, gesture, snapshot, decided_by, decided_at)
       VALUES ($1,$2,$3,$4,'inapp',$5,$6,$7,$8,$9)
       ON CONFLICT (event_id, channel) DO NOTHING`,
      [
        `apr-${row.event_id.toLowerCase()}`,
        TENANT_ID,
        WS_ID,
        row.event_id,
        status,
        status === "approved"
          ? JSON.stringify({ type: "approve", weight: 1 })
          : null,
        JSON.stringify({
          before: p.decision.before ?? null,
          after: p.decision.after ?? null,
          // D21：裁决判据字段（action/params/base_price）——公司CEO 可据此裁决而非保守全上浮
          action: p.decision.action,
          params: p.decision.params ?? {},
          base_price: (p.decision.before as Record<string, unknown> | null)?.price ?? null,
          expires_at: iso(new Date(Date.now() + 24 * 3600 * 1000)), // G6：24h
        }),
        status === "approved" ? "MEM-001" : null,
        status === "approved" ? new Date().toISOString() : null,
      ],
    );
  }
  console.log(`✓ 审批样例 ×${reviewEvents.rows.length}（pending/approved 各一，UNIQUE(event_id,channel) 幂等）`);

  // 昨夜夜班班次（package_generated，决策包统计三栏）
  const yesterday = new Date();
  yesterday.setDate(yesterday.getDate() - 1);
  const runDate = yesterday.toISOString().slice(0, 10);
  // 0013 口径：班次 id = nr-<workspaceId>-<runDate>（PK 已改 (workspace_id, run_date)，
  // id 保留唯一约束，ON CONFLICT (id) 幂等不变）
  await gw.query(
    `INSERT INTO night_runs (id, workspace_id, run_date, status, fence_snapshot_version, candidate_count, stats, started_at, package_event_id)
     VALUES ($1,$2,$3,'package_generated',$4,$5,$6,$7,$8)
     ON CONFLICT (workspace_id, run_date) DO NOTHING`,
    [
      `nr-${WS_ID}-${runDate}`,
      WS_ID,
      runDate,
      FENCE_VERSION,
      14,
      JSON.stringify({ done: 9, pending: 3, need_human: 2, credits_used: 96, credits_est: 118 }),
      new Date(yesterday.setHours(22, 0, 0, 0)).toISOString(),
      `E-SEED-${EVENT_BASE + EVENT_COUNT}`,
    ],
  );
  console.log(`✓ 夜班班次 nr-${WS_ID}-${runDate}（package_generated，围栏快照 ${FENCE_VERSION}）`);

  // 组织记忆 + 归因（F1.4；来源事件为种子段 E-SEED- 前缀 ID）
  const memories = [
    { id: "mem-occ-friday", kind: "pattern", content: "周五晚大床房需求弹性高，18:00 前提价转化损失最小", source: ["E-SEED-8801"] },
    { id: "mem-review-sop", kind: "sop", content: "差评回复结构：致歉→核实→已采取措施→改进承诺，不承诺档案外补偿", source: ["E-SEED-8802"] },
  ];
  for (const m of memories) {
    await gw.query(
      `INSERT INTO org_memory (memory_id, tenant_id, workspace_id, scope, kind, content, source_events, confidence)
       VALUES ($1,$2,$3,'workspace',$4,$5,$6,0.6)
       ON CONFLICT (memory_id) DO NOTHING`,
      [m.id, TENANT_ID, WS_ID, m.kind, m.content, m.source],
    );
    await gw.query(
      `INSERT INTO memory_usage (memory_id, event_id, workspace_id) VALUES ($1,$2,$3)
       ON CONFLICT (memory_id, event_id) DO NOTHING`,
      [m.id, m.source[0], WS_ID],
    );
  }
  console.log(`✓ 组织记忆 ×${memories.length}（含来源事件归因）`);

  // —— 验收（附录 H-1）：回读本批次 100 条，逐条过 zod，五元完整率必须 100%
  const check = await gw.query(
    `SELECT payload FROM biz_events
     WHERE tenant_id=$1 AND workspace_id=$2 AND event_id >= $3 AND event_id <= $4
     ORDER BY seq`,
    [TENANT_ID, WS_ID, `E-SEED-${EVENT_BASE + 1}`, `E-SEED-${EVENT_BASE + EVENT_COUNT}`],
  );
  let valid = 0;
  for (const row of check.rows) {
    // E-SEED- 前缀经回放占位缝过同一附录 E schema
    if (safeParseReplayAwareEvent(row.payload as never).success) valid += 1;
  }
  const rate = check.rowCount ? valid / check.rowCount : 0;
  console.log(`✓ 验收（H-1）：回读 ${check.rowCount} 条，五元字段完整 ${valid} 条，完整率 ${(rate * 100).toFixed(1)}%`);
  if (check.rowCount !== EVENT_COUNT || rate !== 1) {
    throw new Error(`验收失败：期望 ${EVENT_COUNT} 条且完整率 100%（实际 ${check.rowCount} 条 / ${(rate * 100).toFixed(1)}%）`);
  }

  // ============ AI 服务前台 · 运行态剧本（ToBToC：C 端客服全域） ============
  const svcQ = (text: string, params: unknown[]) => gw.query(text, params);

  // C 端用户（会员绑定 + 纯游客各一）
  await svcQ(
    `INSERT INTO c_users (id, workspace_id, channel, openid, nickname, member_id, created_at)
     VALUES
       ('cu-zhangwei', $1, 'wechat-mini', 'openid-zhangwei', '张伟', 'M-GOLD-10086', $2),
       ('cu-xiaoli', $1, 'h5', 'fp-xiaoli-8f3a', '住客小李', NULL, $3)
     ON CONFLICT (id) DO NOTHING`,
    [WS_ID, new Date(Date.now() - 30 * 86400000).toISOString(), new Date(Date.now() - 2 * 86400000).toISOString()],
  );

  // 知识库第二集合：商品与服务目录（送物/餐饮/SPA）+ 官网来源登记
  await svcQ(
    `INSERT INTO kb_collections (id, workspace_id, name, description)
     VALUES ('kbc-service-catalog', $1, '商品与服务目录', '送物清单、餐饮、康体 SPA 等服务与价格')
     ON CONFLICT (id) DO NOTHING`,
    [WS_ID],
  );
  const catalogMd = `# 商品与服务目录\n\n## 免费送物清单\n矿泉水（每日 2 瓶免费）、牙刷套装、梳子、剃须刀、拖鞋、充电器借用。\n\n## 收费送物\n面膜 28 元/片、红酒 128 元/瓶、生日蛋糕 168 元/个（需提前 2 小时预约）。\n\n## 餐饮\n中西自助早餐 68 元/位（住店会员免费）；云栖轩中餐厅 11:00-21:00；客房送餐至 23:00。\n\n## 康体\n恒温泳池 07:00-22:00（住客免费）；SPA 60 分钟 398 元起，需预约。`;
  await svcQ(
    `INSERT INTO kb_documents (id, workspace_id, collection_id, title, source_kind, source_url, version, status, content_md, hash, created_at)
     VALUES ('kbd-service-catalog', $1, 'kbc-service-catalog', '商品与服务目录', 'manual', NULL, 1, 'active', $2, 'seed-hash-catalog', $3)
     ON CONFLICT (id) DO NOTHING`,
    [WS_ID, catalogMd, new Date(Date.now() - 20 * 86400000).toISOString()],
  );
  const catChunks: [number, string, string][] = [
    [0, '免费送物清单', '矿泉水（每日 2 瓶免费）、牙刷套装、梳子、剃须刀、拖鞋、充电器借用。'],
    [1, '收费送物', '面膜 28 元/片、红酒 128 元/瓶、生日蛋糕 168 元/个（需提前 2 小时预约）。'],
    [2, '餐饮', '中西自助早餐 68 元/位（住店会员免费）；云栖轩中餐厅 11:00-21:00；客房送餐至 23:00。'],
    [3, '康体', '恒温泳池 07:00-22:00（住客免费）；SPA 60 分钟 398 元起，需预约。'],
  ];
  for (const [idx, heading, content] of catChunks) {
    await svcQ(
      `INSERT INTO kb_chunks (workspace_id, document_id, chunk_index, heading, content)
       SELECT $1,'kbd-service-catalog',$2,$3,$4
       WHERE NOT EXISTS (SELECT 1 FROM kb_chunks WHERE document_id='kbd-service-catalog' AND chunk_index=$2)`,
      [WS_ID, idx, heading, content],
    );
  }
  await svcQ(
    `INSERT INTO kb_sources (id, workspace_id, url, fingerprint, last_crawled_at, schedule_cron, status)
     VALUES ('kbs-official-site', $1, 'https://www.yunqi-hotel.example', 'fp-a91c', $2, '0 3 * * *', 'active')
     ON CONFLICT (id) DO NOTHING`,
    [WS_ID, new Date(Date.now() - 86400000).toISOString()],
  );

  // 会话 1：会员张伟——退房时间问答（高置信带引用）
  await svcQ(
    `INSERT INTO c_conversations (id, workspace_id, c_user_id, channel, status, created_at, last_message_at)
     VALUES ('cv-seed-001', $1, 'cu-zhangwei', 'wechat-mini', 'open', $2, $3)
     ON CONFLICT (id) DO NOTHING`,
    [WS_ID, new Date(Date.now() - 26 * 3600000).toISOString(), new Date(Date.now() - 26 * 3600000 + 90000).toISOString()],
  );
  const conv1Msgs: [string, string, string, number, string, number][] = [
    ['user', '退房时间是几点？会员能延迟吗？', '', 0, '[]', 0],
    ['assistant', '【退房时间】本店标准退房时间为每日中午 12:00 前。您是金卡会员，可免费延迟至 14:00 退房。', 'kb_qa', 0.95, JSON.stringify([{ documentTitle: '云栖酒店住客服务须知', heading: '退房时间', content: '标准退房时间 12:00，会员可延迟至 14:00。' }]), 24],
    ['user', '早餐几点开始？收费吗？', '', 0, '[]', 0],
    ['assistant', '【早餐】中西自助早餐 07:00-10:30 供应，68 元/位；住店会员免费。地点：一层云栖餐厅。', 'kb_qa', 0.93, JSON.stringify([{ documentTitle: '云栖酒店住客服务须知', heading: '早餐', content: '早餐 07:00-10:30，会员免费。' }]), 21],
  ];
  for (let i = 0; i < conv1Msgs.length; i++) {
    const m = conv1Msgs[i]!;
    await svcQ(
      `INSERT INTO c_messages (workspace_id, conversation_id, role, content, intent, confidence, citations, latency_ms, created_at)
       SELECT $1,'cv-seed-001',$2,$3,$4,$5,$6::jsonb,$7,$8
       WHERE NOT EXISTS (SELECT 1 FROM c_messages WHERE conversation_id='cv-seed-001' AND content=$3)`,
      [WS_ID, m[0], m[1], m[2] || null, m[3] || null, m[4], m[5] || null, new Date(Date.now() - 26 * 3600000 + i * 30000).toISOString()],
    );
  }

  // 会话 2：住客小李——送物请求转工单 + 投诉建单
  await svcQ(
    `INSERT INTO c_conversations (id, workspace_id, c_user_id, channel, status, created_at, last_message_at)
     VALUES ('cv-seed-002', $1, 'cu-xiaoli', 'h5', 'open', $2, $3)
     ON CONFLICT (id) DO NOTHING`,
    [WS_ID, new Date(Date.now() - 3 * 3600000).toISOString(), new Date(Date.now() - 3 * 3600000 + 120000).toISOString()],
  );
  const conv2Msgs: [string, string, string, number, string, number][] = [
    ['user', '房间空调好像不制冷，能找人看看吗？8306', '', 0, '[]', 0],
    ['assistant', '很抱歉给您带来不便。我已为您生成维修工单，工程部会尽快上门处理，进度会实时通知您。', 'service_request', 0.91, '[]', 28],
  ];
  for (let i = 0; i < conv2Msgs.length; i++) {
    const m = conv2Msgs[i]!;
    await svcQ(
      `INSERT INTO c_messages (workspace_id, conversation_id, role, content, intent, confidence, citations, latency_ms, created_at)
       SELECT $1,'cv-seed-002',$2,$3,$4,$5,$6::jsonb,$7,$8
       WHERE NOT EXISTS (SELECT 1 FROM c_messages WHERE conversation_id='cv-seed-002' AND content=$3)`,
      [WS_ID, m[0], m[1], m[2] || null, m[3] || null, m[4], m[5] || null, new Date(Date.now() - 3 * 3600000 + i * 40000).toISOString()],
    );
  }

  // 工单 ×3（三种状态）+ 流转时间线
  const tickets: [string, string, string | null, string, string, string, string, string | null, string | null, number][] = [
    ['tck-seed-001', 'cu-xiaoli', 'cv-seed-002', 'repair', '8306 空调不制冷', 'processing', 'high', '工程部', '王师傅', 2],
    ['tck-seed-002', 'cu-zhangwei', null, 'delivery', '送两瓶矿泉水到 1208', 'assigned', 'normal', '客房部', null, 1],
    ['tck-seed-003', 'cu-xiaoli', null, 'complaint', '隔壁房间深夜噪音扰民', 'done', 'high', '值班经理', '刘经理', 20],
  ];
  for (const t of tickets) {
    await svcQ(
      `INSERT INTO c_tickets (id, workspace_id, c_user_id, conversation_id, kind, title, payload, status, priority, dept, assignee, sla_due_at, result, idempotency_key, created_at, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,'{}',$7,$8,$9,$10,$11,$12,$13,$14,$14)
       ON CONFLICT (id) DO NOTHING`,
      [t[0], WS_ID, t[1], t[2], t[3], t[4], t[5], t[6], t[7], t[8],
       new Date(Date.now() + 2 * 3600000).toISOString(),
       t[5] === 'done' ? JSON.stringify({ text: '已与隔壁房客沟通并提醒静音，赠送您一份果盘致歉。', rating: { score: 5 } }) : null,
       `seed-${t[0]}`, new Date(Date.now() - t[9] * 3600000 / 10).toISOString()],
    );
  }
  const tl: [string, string, string, string, string, number][] = [
    ['tck-seed-001', 'create', 'c_user', 'cu-xiaoli', '用户对话中建单', 180],
    ['tck-seed-001', 'assign', 'agent', 'agt-service-desk', '智能分派 → 工程部', 179],
    ['tck-seed-001', 'start', 'staff', '王师傅', '已接单，携带工具前往 8306', 95],
    ['tck-seed-002', 'create', 'c_user', 'cu-zhangwei', '服务台自助提交', 60],
    ['tck-seed-002', 'assign', 'agent', 'agt-service-desk', '智能分派 → 客房部', 59],
    ['tck-seed-003', 'create', 'c_user', 'cu-xiaoli', '投诉类必建单', 480],
    ['tck-seed-003', 'assign', 'agent', 'agt-service-desk', '智能分派 → 值班经理', 479],
    ['tck-seed-003', 'start', 'staff', '刘经理', '现场处理中', 460],
    ['tck-seed-003', 'complete', 'staff', '刘经理', '已沟通提醒并赠果盘致歉', 430],
    ['tck-seed-003', 'rate', 'c_user', 'cu-xiaoli', '满意度 5 星', 400],
  ];
  for (const e of tl) {
    await svcQ(
      `INSERT INTO c_ticket_events (workspace_id, ticket_id, action, actor_type, actor_id, detail, created_at)
       SELECT $1,$2,$3,$4,$5,$6::jsonb,$7
       WHERE NOT EXISTS (SELECT 1 FROM c_ticket_events WHERE ticket_id=$2 AND action=$3 AND actor_id=$4)`,
      [WS_ID, e[0], e[1], e[2], e[3], JSON.stringify({ note: e[4] }), new Date(Date.now() - e[5] * 60000).toISOString()],
    );
  }

  // 推送箱：受理 + 办结通知（仿服务通知）
  const notifs: [string, string, string, string, number][] = [
    ['ntf-seed-001', 'cu-xiaoli', 'ticket.accepted', '您的维修工单「8306 空调不制冷」已受理，工程部王师傅处理中。', 170],
    ['ntf-seed-002', 'cu-xiaoli', 'ticket.completed', '您的投诉工单「隔壁房间深夜噪音扰民」已办结：已与隔壁房客沟通提醒，并赠果盘致歉。欢迎评价。', 425],
    ['ntf-seed-003', 'cu-zhangwei', 'ticket.accepted', '您的送物工单「送两瓶矿泉水到 1208」已受理，客房部将尽快送达。', 55],
  ];
  for (const n of notifs) {
    await svcQ(
      `INSERT INTO c_notifications (workspace_id, c_user_id, channel, kind, payload, driver, status, created_at)
       SELECT $1,$2,'h5',$3,$4::jsonb,'mock','delivered',$5
       WHERE NOT EXISTS (SELECT 1 FROM c_notifications WHERE c_user_id=$2 AND kind=$3 AND payload->>'text'=$6)`,
      [WS_ID, n[1], n[2], JSON.stringify({ text: n[3], mock: true }), new Date(Date.now() - n[4] * 60000).toISOString(), n[3]],
    );
  }
  console.log("✓ AI 服务前台运行态：C 端用户×2 / 知识库集合×2+官网源 / 会话×2 / 工单×3（全状态+时间线）/ 通知×3");

  // ============ AI 服务前台 · 知识库全量预置（bundles/hotel/service-front） ============
  // 数据源：faq.json（十大类 385 问）+ delivery-catalog.json（46 种送物）+ repair-catalog.json（56 项报修）
  interface FaqFile { categories: Array<{ key: string; name: string; docTitle: string; items: Array<{ q: string; a: string }> }> }
  interface CatalogItem { name: string; category: string; price: number; unit: string; note?: string; robot?: boolean }
  interface CatalogFile { categories: Array<{ key: string; name: string }>; items: CatalogItem[] }
  interface RepairItem { name: string; category: string; symptoms: string; urgency: string; slaMinutes: number; dept: string; tip?: string }
  interface RepairFile { categories: Array<{ key: string; name: string }>; items: RepairItem[] }
  const SF_DIR = join(BUNDLE_DIR, "service-front");
  const faq = JSON.parse(readFileSync(join(SF_DIR, "faq.json"), "utf-8")) as FaqFile;
  const deliveryCat = JSON.parse(readFileSync(join(SF_DIR, "delivery-catalog.json"), "utf-8")) as CatalogFile;
  const repairCat = JSON.parse(readFileSync(join(SF_DIR, "repair-catalog.json"), "utf-8")) as RepairFile;

  // ① 住客常见问答集合（10 文档 / 385 知识块：一问一答即一块）
  await svcQ(
    `INSERT INTO kb_collections (id, workspace_id, name, description)
     VALUES ('kbc-guest-faq', $1, '住客常见问答', '十大类 385 条住客高频问题与标准答案（AI 服务前台核心知识源）')
     ON CONFLICT (id) DO NOTHING`,
    [WS_ID],
  );
  let faqChunks = 0;
  for (const cat of faq.categories) {
    const docId = `kbd-faq-${cat.key}`;
    const md = [`# ${cat.docTitle}`, ...cat.items.map((it) => `## ${it.q}\n${it.a}`)].join("\n\n");
    await svcQ(
      `INSERT INTO kb_documents (id, workspace_id, collection_id, title, source_kind, source_url, version, status, content_md, hash, created_at)
       VALUES ($1, $2, 'kbc-guest-faq', $3, 'manual', NULL, 1, 'active', $4, $5, $6)
       ON CONFLICT (id) DO NOTHING`,
      [docId, WS_ID, cat.docTitle, md, `seed-hash-faq-${cat.key}`, new Date(Date.now() - 18 * 86400000).toISOString()],
    );
    for (let i = 0; i < cat.items.length; i++) {
      const it = cat.items[i]!;
      const r = await svcQ(
        `INSERT INTO kb_chunks (workspace_id, document_id, chunk_index, heading, content)
         SELECT $1, $2, $3, $4, $5
         WHERE NOT EXISTS (SELECT 1 FROM kb_chunks WHERE document_id=$2 AND chunk_index=$3)`,
        [WS_ID, docId, i, it.q, it.a],
      );
      faqChunks += (r as unknown as { rowCount: number }).rowCount ?? 0;
    }
  }

  // ② 送物服务全目录（46 种，按分类切块；与 FAQ 送物类互证）
  {
    const catName = (k: string) => deliveryCat.categories.find((c) => c.key === k)?.name ?? k;
    const groups = new Map<string, CatalogItem[]>();
    for (const it of deliveryCat.items) {
      const arr = groups.get(it.category) ?? [];
      arr.push(it);
      groups.set(it.category, arr);
    }
    const md = ["# 送物服务全目录", ...[...groups.entries()].map(([k, arr]) =>
      `## ${catName(k)}\n${arr.map((i) => `- ${i.name}（${i.price === 0 ? "免费" : `${i.price} 元/${i.unit}`}${i.note ? `，${i.note}` : ""}${i.robot === false ? "，大件由服务员配送" : "，支持机器人配送"}）`).join("\n")}`,
    )].join("\n\n");
    await svcQ(
      `INSERT INTO kb_documents (id, workspace_id, collection_id, title, source_kind, source_url, version, status, content_md, hash, created_at)
       VALUES ('kbd-delivery-catalog', $1, 'kbc-service-catalog', '送物服务全目录（46 种）', 'manual', NULL, 1, 'active', $2, 'seed-hash-delivery-catalog', $3)
       ON CONFLICT (id) DO NOTHING`,
      [WS_ID, md, new Date(Date.now() - 18 * 86400000).toISOString()],
    );
    let idx = 0;
    for (const [k, arr] of groups) {
      const content = arr.map((i) => `${i.name}：${i.price === 0 ? "免费" : `${i.price} 元/${i.unit}`}${i.note ? `；${i.note}` : ""}${i.robot === false ? "；大件服务员配送" : "；可机器人配送"}`).join("。");
      await svcQ(
        `INSERT INTO kb_chunks (workspace_id, document_id, chunk_index, heading, content)
         SELECT $1, 'kbd-delivery-catalog', $2, $3, $4
         WHERE NOT EXISTS (SELECT 1 FROM kb_chunks WHERE document_id='kbd-delivery-catalog' AND chunk_index=$2)`,
        [WS_ID, idx++, catName(k), content],
      );
    }
  }

  // ③ 维修报修指引（56 项，按系统分类切块；含 SLA 与客人自救提示）
  {
    const catName = (k: string) => repairCat.categories.find((c) => c.key === k)?.name ?? k;
    const groups = new Map<string, RepairItem[]>();
    for (const it of repairCat.items) {
      const arr = groups.get(it.category) ?? [];
      arr.push(it);
      groups.set(it.category, arr);
    }
    const md = ["# 客房设施维修报修指引", ...[...groups.entries()].map(([k, arr]) =>
      `## ${catName(k)}\n${arr.map((i) => `- ${i.name}：${i.symptoms}（${i.urgency === "high" ? `加急 ${i.slaMinutes} 分钟内响应` : `常规 ${i.slaMinutes} 分钟内响应`}${i.tip ? `；${i.tip}` : ""}）`).join("\n")}`,
    )].join("\n\n");
    await svcQ(
      `INSERT INTO kb_documents (id, workspace_id, collection_id, title, source_kind, source_url, version, status, content_md, hash, created_at)
       VALUES ('kbd-repair-catalog', $1, 'kbc-service-catalog', '维修报修指引（56 项）', 'manual', NULL, 1, 'active', $2, 'seed-hash-repair-catalog', $3)
       ON CONFLICT (id) DO NOTHING`,
      [WS_ID, md, new Date(Date.now() - 18 * 86400000).toISOString()],
    );
    let idx = 0;
    for (const [k, arr] of groups) {
      const content = arr.map((i) => `${i.name}：${i.symptoms}，${i.urgency === "high" ? `加急${i.slaMinutes}分钟响应` : `常规${i.slaMinutes}分钟响应`}${i.tip ? `；${i.tip}` : ""}`).join("。");
      await svcQ(
        `INSERT INTO kb_chunks (workspace_id, document_id, chunk_index, heading, content)
         SELECT $1, 'kbd-repair-catalog', $2, $3, $4
         WHERE NOT EXISTS (SELECT 1 FROM kb_chunks WHERE document_id='kbd-repair-catalog' AND chunk_index=$2)`,
        [WS_ID, idx++, catName(k), content],
      );
    }
  }
  console.log(`✓ 知识库全量预置：FAQ ${faq.categories.length} 类 ${faq.categories.reduce((n, c) => n + c.items.length, 0)} 问（新入库 ${faqChunks} 块）+ 送物目录 ${deliveryCat.items.length} 种 + 报修指引 ${repairCat.items.length} 项`);

  // ============ AI 服务前台 · 扩充运行态（多客群/会员/订单/会话/工单/SLA） ============
  // 多客群 C 端用户（白金商务/家庭/长住/外籍）+ 会员档案 + 订单
  await svcQ(
    `INSERT INTO c_users (id, workspace_id, channel, openid, nickname, member_id, created_at)
     VALUES
       ('cu-wangzong', $1, 'wechat-mini', 'openid-wangzong', '王总', 'M-PLAT-20888', $2),
       ('cu-linvshi', $1, 'wechat-mini', 'openid-linvshi', '李女士', 'M-GOLD-31520', $3),
       ('cu-zhangxiansheng', $1, 'alipay', 'ali-zhang-xs', '张先生', NULL, $4),
       ('cu-smith', $1, 'h5', 'fp-smith-7a21', 'Mr. Smith', NULL, $5)
     ON CONFLICT (id) DO NOTHING`,
    [WS_ID,
      new Date(Date.now() - 60 * 86400000).toISOString(), new Date(Date.now() - 21 * 86400000).toISOString(),
      new Date(Date.now() - 45 * 86400000).toISOString(), new Date(Date.now() - 86400000).toISOString()],
  );
  await svcQ(
    `INSERT INTO demo_members (workspace_id, member_id, name, tier, points)
     VALUES
       ($1, 'M-PLAT-20888', '王总', '白金卡', 26800),
       ($1, 'M-GOLD-31520', '李女士', '金卡', 9800)
     ON CONFLICT (workspace_id, member_id) DO NOTHING`,
    [WS_ID],
  );
  /**
   * C 端服务前台 **e2e 契约夹具**（M-1001/M-1002 + 三张订单）。
   *
   * 为什么放在行业种子而不是基座服务层：基座 store.ts 只核验表结构、零行业词汇（第⑧槽纪律）；
   * 而 apps/server 的 e2e 契约用例按固定会员号断言（M-1001 见本人订单、M-1002 只见本人订单），
   * 夹具必须无条件存在——**不能按空表门控**：本文件上面的「扩充运行态」会先占表，
   * 门控会让夹具被静默跳过（D36 新装环境 e2e 七连挂的根因）。
   * INSERT 全部 ON CONFLICT DO NOTHING，幂等可重跑。
   */
  await svcQ(
    `INSERT INTO demo_members (member_id, workspace_id, name, phone, tier, points) VALUES
       ('M-1001',$1,'张伟','13800000001','金卡',2680),
       ('M-1002',$1,'刘芳','13800000002','银卡',860)
     ON CONFLICT (workspace_id, member_id) DO NOTHING`,
    [WS_ID],
  );
  await svcQ(
    `INSERT INTO demo_orders (order_id, workspace_id, member_id, room_type, check_in, check_out, amount_fen, status) VALUES
       ('O-20260820-001',$1,'M-1001','豪华大床房','2026-08-21','2026-08-23',117600,'已确认'),
       ('O-20260818-002',$1,'M-1001','行政双床房','2026-08-18','2026-08-19',68800,'已完成'),
       ('O-20260822-003',$1,'M-1002','山景大床房','2026-08-25','2026-08-26',52800,'已确认')
     ON CONFLICT (workspace_id, order_id) DO NOTHING`,
    [WS_ID],
  );
  await svcQ(
    `INSERT INTO demo_orders (workspace_id, order_id, member_id, room_type, check_in, check_out, amount_fen, status)
     VALUES
       ($1, 'YQ-20260824-108', 'M-PLAT-20888', '行政大床房', $2, $3, 326400, '在住'),
       ($1, 'YQ-20260822-076', 'M-GOLD-31520', '亲子主题房', $4, $5, 197600, '在住'),
       ($1, 'YQ-20260810-033', 'M-PLAT-20888', '行政大床房', $6, $7, 108800, '已退房')
     ON CONFLICT (workspace_id, order_id) DO NOTHING`,
    [WS_ID,
      new Date(Date.now() - 86400000).toISOString(), new Date(Date.now() + 2 * 86400000).toISOString(),
      new Date(Date.now() - 2 * 86400000).toISOString(), new Date(Date.now() + 86400000).toISOString(),
      new Date(Date.now() - 14 * 86400000).toISOString(), new Date(Date.now() - 13 * 86400000).toISOString()],
  );

  // 扩充会话 ×4（早餐/WiFi/送物建单/报修建单 全链路演示）
  const convs: Array<[string, string, string, number, Array<[string, string, string, number, string, number]>]> = [
    ["cv-seed-003", "cu-linvshi", "wechat-mini", 8, [
      ["user", "明天早餐几点开始？带孩子三个人怎么收费？", "", 0, "[]", 0],
      ["assistant", "【早餐】一层云栖餐厅中西自助 07:00-10:30（周末至 11:00），68 元/位；您是金卡会员本人免费，1.2 米以下儿童免费，超出儿童 34 元/位。", "kb_qa", 0.94, JSON.stringify([{ documentTitle: "住客常见问答·餐饮美食", heading: "早餐几点开始、到几点结束？", content: "早餐供应时间为每日07:00-10:30，周末及法定节假日延长至11:00收餐，位于酒店一层云栖餐厅。" }]), 26],
      ["user", "房间里能连 WiFi 吗？密码呢？", "", 0, "[]", 0],
      ["assistant", "【WiFi】全店无线网络 Yunqi-Hotel 免费使用，密码为您房间号的后四位数字。", "kb_qa", 0.96, JSON.stringify([{ documentTitle: "住客常见问答·网络与设施", heading: "WiFi密码是多少？", content: "WiFi密码为所住房间号的后四位数字，例如入住1208房，密码即为1208。" }]), 19],
    ]],
    ["cv-seed-004", "cu-wangzong", "wechat-mini", 5, [
      ["user", "帮我送两瓶矿泉水和一套牙具到 2508", "", 0, "[]", 0],
      ["assistant", "好的，已为您生成送物工单：矿泉水 2 瓶（免费额度内）+ 牙刷套装 1 套，将由配送机器人「小云」送达 2508，预计 10 分钟内到。", "service_request", 0.93, "[]", 24],
    ]],
    ["cv-seed-005", "cu-smith", "h5", 2, [
      ["user", "The air conditioner in my room is not cooling. Room 1832.", "", 0, "[]", 0],
      ["assistant", "抱歉给您带来不便。已为您生成维修工单：1832 房空调制冷异常，工程部加急 30 分钟内上门；处理进度会实时通知您。", "service_request", 0.9, "[]", 27],
    ]],
    ["cv-seed-006", "cu-zhangxiansheng", "alipay", 12, [
      ["user", "你们这儿去萧山机场怎么走最方便？多少钱？", "", 0, "[]", 0],
      ["assistant", "【机场交通】三种方式：①酒店接送机 7 座商务车 260 元/趟（提前 4 小时预约）；②机场大巴云栖线 35 元/人约 70 分钟，整点发车 07:00-21:00；③打车约 50 分钟约 130 元。早班机建议预约接送机。", "kb_qa", 0.92, JSON.stringify([{ documentTitle: "住客常见问答·交通位置", heading: "酒店离萧山机场多远？", content: "酒店距杭州萧山国际机场约42公里，打车正常路况约50分钟，车费约130元。" }]), 31],
    ]],
  ];
  for (const [cvId, cuId, ch, hoursAgo, msgs] of convs) {
    await svcQ(
      `INSERT INTO c_conversations (id, workspace_id, c_user_id, channel, status, created_at, last_message_at)
       VALUES ($1, $2, $3, $4, 'open', $5, $6)
       ON CONFLICT (id) DO NOTHING`,
      [cvId, WS_ID, cuId, ch, new Date(Date.now() - hoursAgo * 3600000).toISOString(), new Date(Date.now() - hoursAgo * 3600000 + 120000).toISOString()],
    );
    for (let i = 0; i < msgs.length; i++) {
      const m = msgs[i]!;
      await svcQ(
        `INSERT INTO c_messages (workspace_id, conversation_id, role, content, intent, confidence, citations, latency_ms, created_at)
         SELECT $1, $2, $3, $4, $5, $6, $7::jsonb, $8, $9
         WHERE NOT EXISTS (SELECT 1 FROM c_messages WHERE conversation_id=$2 AND content=$4)`,
        [WS_ID, cvId, m[0], m[1], m[2] || null, m[3] || null, m[4], m[5] || null, new Date(Date.now() - hoursAgo * 3600000 + i * 40000).toISOString()],
      );
    }
  }

  // 扩充工单 ×5（含 1 张 SLA 超时加急单）+ 时间线 + 通知
  const tickets2: Array<[string, string, string | null, string, string, string, string, string | null, number]> = [
    ["tck-seed-004", "cu-wangzong", "cv-seed-004", "delivery", "送矿泉水×2 + 牙刷套装到 2508", "done", "normal", "客房部", "配送机器人·小云", 5],
    ["tck-seed-005", "cu-smith", "cv-seed-005", "repair", "1832 房空调不制冷", "processing", "high", "工程部", "王师傅", 2],
    ["tck-seed-006", "cu-linvshi", null, "delivery", "儿童餐椅 + 温奶器送到 1208", "assigned", "normal", "客房部", null, 1],
    ["tck-seed-007", "cu-zhangxiansheng", null, "repair", "2021 房 WiFi 频繁掉线", "created", "normal", "工程部", null, 26], // SLA 超时样例（created 超 2h 未分派）
    ["tck-seed-008", "cu-wangzong", null, "other", "预约 08-26 06:30 送机（萧山 T3，7 座商务）", "done", "high", "前厅部", "礼宾-小周", 30],
  ];
  for (const t of tickets2) {
    await svcQ(
      `INSERT INTO c_tickets (id, workspace_id, c_user_id, conversation_id, kind, title, payload, status, priority, dept, assignee, sla_due_at, result, idempotency_key, created_at, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,'{}',$7,$8,$9,$10,$11,$12,$13,$14,$14)
       ON CONFLICT (id) DO NOTHING`,
      [t[0], WS_ID, t[1], t[2], t[3], t[4], t[5], t[6], t[7], t[8],
       new Date(Date.now() + (t[5] === "created" ? -3600000 : 2 * 3600000)).toISOString(), // 超时样例 due_at 已过
       t[5] === "done" ? JSON.stringify({ text: t[3] === "delivery" ? "已由机器人送达并电话确认。" : "送机车辆已准时出发，行程单已推送。", rating: { score: 5 } }) : null,
       `seed-${t[0]}`, new Date(Date.now() - t[9] * 3600000).toISOString()],
    );
  }
  const tl2: Array<[string, string, string, string, string, number]> = [
    ["tck-seed-004", "create", "c_user", "cu-wangzong", "对话中确认送物", 300],
    ["tck-seed-004", "assign", "agent", "agt-service-desk", "智能分派 → 客房部（机器人配送）", 299],
    ["tck-seed-004", "complete", "staff", "配送机器人·小云", "已送达 2508 并电话确认", 290],
    ["tck-seed-005", "create", "c_user", "cu-smith", "对话中建单（加急）", 120],
    ["tck-seed-005", "assign", "agent", "agt-service-desk", "智能分派 → 工程部", 119],
    ["tck-seed-005", "start", "staff", "王师傅", "已携检测设备前往 1832", 100],
    ["tck-seed-006", "create", "c_user", "cu-linvshi", "服务台自助提交", 60],
    ["tck-seed-006", "assign", "agent", "agt-service-desk", "智能分派 → 客房部", 59],
    ["tck-seed-007", "create", "c_user", "cu-zhangxiansheng", "支付宝小程序提交", 1560],
    ["tck-seed-008", "create", "c_user", "cu-wangzong", "电话登记转入", 1800],
    ["tck-seed-008", "assign", "agent", "agt-service-desk", "智能分派 → 前厅部", 1799],
    ["tck-seed-008", "complete", "staff", "礼宾-小周", "送机完成，行程单已推送", 1500],
  ];
  for (const e of tl2) {
    await svcQ(
      `INSERT INTO c_ticket_events (workspace_id, ticket_id, action, actor_type, actor_id, detail, created_at)
       SELECT $1,$2,$3,$4,$5,$6::jsonb,$7
       WHERE NOT EXISTS (SELECT 1 FROM c_ticket_events WHERE ticket_id=$2 AND action=$3 AND actor_id=$4)`,
      [WS_ID, e[0], e[1], e[2], e[3], JSON.stringify({ note: e[4] }), new Date(Date.now() - e[5] * 60000).toISOString()],
    );
  }
  const notifs2: Array<[string, string, string, string, number]> = [
    ["ntf-seed-004", "cu-wangzong", "ticket.completed", "您的送物工单「送矿泉水×2 + 牙刷套装到 2508」已办结：已由机器人送达并电话确认。欢迎评价。", 285],
    ["ntf-seed-005", "cu-smith", "ticket.accepted", "您的维修工单「1832 房空调不制冷」已受理（加急），工程部王师傅处理中。", 115],
    ["ntf-seed-006", "cu-linvshi", "ticket.accepted", "您的送物工单「儿童餐椅 + 温奶器送到 1208」已受理，客房部将尽快送达。", 58],
    ["ntf-seed-007", "cu-zhangxiansheng", "sla.escalated", "您的维修工单「2021 房 WiFi 频繁掉线」受理超时已升级为加急，值班经理已介入督办。", 60],
    ["ntf-seed-008", "cu-wangzong", "ticket.completed", "您的送机预约已完成，行程单已推送至微信。期待再次为您服务。", 1495],
  ];
  for (const n of notifs2) {
    await svcQ(
      `INSERT INTO c_notifications (workspace_id, c_user_id, channel, kind, payload, driver, status, created_at)
       SELECT $1,$2,'wechat-mini',$3,$4::jsonb,'mock','delivered',$5
       WHERE NOT EXISTS (SELECT 1 FROM c_notifications WHERE c_user_id=$2 AND kind=$3 AND payload->>'text'=$6)`,
      [WS_ID, n[1], n[2], JSON.stringify({ text: n[3], mock: true }), new Date(Date.now() - n[4] * 60000).toISOString(), n[3]],
    );
  }
  console.log("✓ 服务前台扩充运行态：多客群用户×4 / 会员×2 / 订单×3 / 会话×4 / 工单×5（含 SLA 超时样例）/ 时间线×11 / 通知×5");


  // L2 收口：显式 COMMIT——本事务内全部 gateway 段写入（事件/审批/夜班/记忆/C 端运行态）
  // 同一提交；若中途抛错，main 捕获退出时连接关闭，PG 自动 ROLLBACK 不留半提交态
  await gw.query("COMMIT");
  await gw.end();
  console.log("种子数据完成 ✅（酒店试点业务前台夹具就绪；获客用增演示由同链 seed-geo 产出）");
}

main().catch((err) => {
  console.error("seed 失败：", err?.message ?? err);
  process.exit(1);
});
