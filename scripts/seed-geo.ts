/**
 * seed-geo.ts —— WorkLoom GEO（geo-growth Bundle）双域融合经营演示种子
 *
 * 与 scripts/seed-video.ts（ai-video Bundle）同构，装载：
 *  - 演示租户/工作区（industry: geo-growth）
 *  - 人类成员（客户老板/渠道运营——全托管线最小配置）
 *  - bundles/geo-growth 的 16 个数码员工 preset（情报组 2 + 内容组 4 + 分发组 3 + 数据组 3 + 经营组 2 + 指挥层 2；fence_bindings 原样落库）
 *  - geo-growth-baseline/v1 双域基线围栏（社媒域 G9/G10/G12/G15/G16 + GEO 域 G-GEO1/2/3 + 双域 G17/G18/G20 共 17 条）
 *  - 6 个 GEO 官方技能（安装即绑定围栏）
 *  - 一客一档 v2（七模块：企业品牌/产品实体卡/目标市场/内容资产/运营资产/GEO 资产/转化资产 + 数据边界声明）
 *  - 自动化触发器（情报站 07:00 / 清晨决策包 08:30 / 能见度品牌词日频+全量周频 / 周一经营会 / 月度回测 / 夜班值守 / CEO 节拍）
 *  - 演示运行态：query 集 v1 + 能见度基线 + 情报卡 + 双入口询盘样本 + 五元事件链
 *
 * 幂等可复跑（全部 ON CONFLICT DO NOTHING / DO UPDATE）。
 * 运行：pnpm db:seed:geo
 */
import pg from "pg";
import YAML from "yaml";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { alignReadableIdSequences, safeParseReplayAwareEvent } from "@workloom/base/workdata";
// 哈希链统一生产口径（events.ts 的 canonicalJson/eventHash），与 seed.ts/seed-video.ts 同一纪律
import { eventHash } from "@workloom/base/workdata";
// 技能围栏绑定表（与基座 seed.ts 共用同一事实源；见 scripts/skill-bindings.mts）
import { skillBindingsFor } from "./skill-bindings.mts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "..");
const BUNDLE_DIR = join(REPO_ROOT, "bundles/geo-growth");

const DATABASE_URL =
  process.env.DATABASE_URL ?? "postgres://postgres:workloom@localhost:5432/workloom";
const GATEWAY_URL =
  process.env.DATABASE_GATEWAY_URL ??
  "postgres://workloom_gateway:workloom_dev_gateway@localhost:5432/workloom";

/* ================= 固定演示标识（幂等键） ================= */

const TENANT_ID = "tenant-demo";
const WS_ID = "ws-geo";
const WS_NAME = "WorkLoom GEO · 双域经营演示工作室";
const WS_SLUG = "geo-growth";
const FENCE_VERSION = "geo-growth-baseline/v1";

const MEMBERS = [
  { id: "MEM-G01", name: "梁老板", role: "owner" },
  { id: "MEM-G02", name: "苏运营", role: "manager" },
] as const;

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
  tools: unknown[];
  prompt: Record<string, unknown>;
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
  /** 规则所属围栏包版本（多包并装时逐条落库，不能一律写基线版本）。 */
  packVersion?: string;
}

/**
 * 装载 bundle.json `provides.fences` 声明的全部基线围栏包。
 * `fences/patches/*` 是客群二选一的客户级补丁，由落地向导按需应用，此处跳过。
 * 之前只读 geo-growth-baseline.yml，导致新增的行业围栏包（如视觉工位 G-VIS 系列）
 * 永远进不了 fence_rules 表——判定器看不到规则，写动作只能落保守 review。
 */
function loadFences(): FenceRule[] {
  const manifest = JSON.parse(readFileSync(join(BUNDLE_DIR, "bundle.json"), "utf-8")) as {
    workloom?: { provides?: { fences?: string[] } };
  };
  const declared = manifest.workloom?.provides?.fences ?? ["fences/geo-growth-baseline.yml"];
  const rules: FenceRule[] = [];
  for (const assetPath of declared) {
    if (assetPath.includes("/patches/")) continue;
    const doc = YAML.parse(readFileSync(join(BUNDLE_DIR, assetPath), "utf-8"));
    const version = typeof doc?.version === "string" ? doc.version : FENCE_VERSION;
    for (const rule of (doc?.rules ?? doc?.fences ?? []) as FenceRule[]) {
      rules.push({ ...rule, packVersion: version });
    }
  }
  return rules;
}

interface SkillDoc {
  name: string;
  description: string;
  body: string;
}

/** 管线 YAML 解析校验：管线由 Quest 调度器直接消费 YAML，此处解析计数确保可解析 */
function loadPipelines(): string[] {
  const dir = join(BUNDLE_DIR, "pipelines");
  return readdirSync(dir)
    .filter((f) => f.endsWith(".yml"))
    .sort()
    .map((f) => {
      const doc = YAML.parse(readFileSync(join(dir, f), "utf-8"));
      return String(doc?.quest ?? f);
    });
}

function loadSkills(): SkillDoc[] {
  const dir = join(BUNDLE_DIR, "skills");
  return readdirSync(dir)
    .sort()
    .map((d) => {
      const raw = readFileSync(join(dir, d, "SKILL.md"), "utf-8");
      const m = raw.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
      const fm = YAML.parse(m?.[1] ?? "{}");
      return {
        name: String(fm.name ?? d),
        description: String(fm.description ?? ""),
        body: (m?.[2] ?? "").trim(),
      };
    });
}

/**
 * 组合技能并集（2026-09-20 真机验收修复）：
 * 组合编制（hotel + ai-video + geo-growth）里的酒店/视频岗位引用各自包的 official 技能；
 * 只装本包 29 条技能时，那些岗位被判「技能已声明未装备」（ui 探针 skillsOk=false）。
 * 这里按各包 bundle.json 的 provides.skills 逐条落 skills 行 + ws-geo 安装行，
 * 与基座 seed.ts 的组合技能安装同口径（安装快照取 skills 表当前值）。
 */
function loadComposedSkillDocs(): Array<{ bundle: string | null; doc: SkillDoc }> {
  const out: Array<{ bundle: string | null; doc: SkillDoc }> = [];
  for (const bundleId of ["hotel", "ai-video", "geo-growth"]) {
    const manifestPath = join(REPO_ROOT, "bundles", bundleId, "bundle.json");
    if (!existsSync(manifestPath)) continue;
    const manifest = JSON.parse(readFileSync(manifestPath, "utf-8")) as {
      workloom?: { provides?: { skills?: string[] } };
    };
    for (const rel of manifest.workloom?.provides?.skills ?? []) {
      const abs = join(REPO_ROOT, "bundles", bundleId, rel);
      if (!existsSync(abs)) continue;
      const raw = readFileSync(abs, "utf-8");
      const m = raw.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
      const fm = YAML.parse(m?.[1] ?? "{}") as Record<string, unknown>;
      const fallbackName = rel.split("/").slice(-2)[0] ?? "skill";
      out.push({
        bundle: bundleId,
        doc: {
          name: String(fm.name ?? fallbackName),
          description: String(fm.description ?? ""),
          body: (m?.[2] ?? "").trim(),
        },
      });
    }
  }
  // 编制引用的包外官方技能（<repo>/skills/official/*，如 deal-flow——商单全流程 SOP，G15 联动）：
  // bundle 为空表示不随任何行业包卸载；不装它们时 creator-partner / deal-manager 被判技能未装备。
  const officialDir = join(REPO_ROOT, "skills", "official");
  if (existsSync(officialDir)) {
    for (const d of readdirSync(officialDir).sort()) {
      const abs = join(officialDir, d, "SKILL.md");
      if (!existsSync(abs)) continue;
      const raw = readFileSync(abs, "utf-8");
      const m = raw.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
      const fm = YAML.parse(m?.[1] ?? "{}") as Record<string, unknown>;
      out.push({
        bundle: null,
        doc: {
          name: String(fm.name ?? d),
          description: String(fm.description ?? ""),
          body: (m?.[2] ?? "").trim(),
        },
      });
    }
  }
  return out;
}

/** 一客一档 v2（融合方案 §3.2 七模块；forbidden 红线双写，L1.6 同源纪律） */
function clientArchive(): Record<string, unknown> {
  return {
    // 模块①企业与品牌（D1 启动会建档）
    enterprise: {
      name: "演示客户·佛山锐科机械",
      profile: "佛山产业带激光切割设备工厂，产品竞争力强但从没做过海外社媒（A 类 0 基础客户）",
      qualifications: ["ISO9001", "CE 认证", "出口资质"],
      capacity: "月产激光切割机 120 台",
      brand_guideline: { tone: "专业务实，不吹牛", visual: "工业蓝主色" },
    },
    // 模块②产品与方案（品牌实体卡——GEO 实体一致性唯一权威源，客户逐项确认 L4）
    entity_card: {
      product_lines: [
        { model: "RK-1500W", material: "碳钢/不锈钢", applications: ["钣金加工", "广告字切割"], params: { power: "1500W", precision: "±0.03mm" } },
        { model: "RK-3000W", material: "碳钢/不锈钢/铝合金", applications: ["机箱机柜", "电梯部件"], params: { power: "3000W", precision: "±0.05mm" } },
      ],
      core_selling_points: ["同等功率价格低 30%", "24h 远程售后响应", "出口欧洲 CE 全认证"],
      price_logic: "功率分档定价，含一年质保与安装培训",
      confirmed: true,
    },
    // 模块③目标市场（D3 市场分析 Agent 出报告，人裁决）
    target_market: {
      countries: ["美国", "德国", "波兰"],
      languages: ["en", "zh"],
      buyer_roles: ["工厂主", "采购经理", "设备工程师"],
      competitors: [{ name: "竞对 A", note: "AI 问答首推率 42%，知乎布局完整" }],
    },
    // 模块④内容资产（持续沉淀）
    content_assets: { materials: 12, history_scripts: 5, high_perf_structures: [] },
    // 模块⑤运营资产（D3-D7 账号规划 Agent；含防关联标注）
    operation_assets: {
      accounts: [
        { platform: "tiktok", handle: "@RuikeLaser", group: "A", daily_publish_limit: 3 },
        { platform: "youtube", handle: "@RuikeLaserOfficial", group: "A", daily_publish_limit: 2 },
        { platform: "zhihu", handle: "锐科激光装备", group: "B", daily_publish_limit: 1 },
      ],
      stage: "setup",
      baseline: { plays_7d: 0, inquiries_30d: 0 },
    },
    // 模块⑥GEO 资产（D5-D10 引用源分析师+能见度监测官）
    geo_assets: {
      query_set: [
        { q: "锐科激光切割机怎么样", type: "brand", lang: "zh", priority: "P0", status: "未提及" },
        { q: "Ruike laser cutter review", type: "brand", lang: "en", priority: "P0", status: "未提及" },
        { q: "激光切割机怎么选", type: "category", lang: "zh", priority: "P1", status: "竞品首推" },
        { q: "best laser cutter for small business", type: "category", lang: "en", priority: "P1", status: "竞品首推" },
        { q: "小批量钣金加工找什么设备", type: "scene", lang: "zh", priority: "P2", status: "未覆盖" },
        { q: "锐科 vs 竞对A 哪个好", type: "compare", lang: "zh", priority: "P1", status: "负面偏差" },
      ],
      visibility_baseline: {
        mention_rate: 0.11, first_rate: 0.02, sov: 0.06,
        platforms: ["doubao", "deepseek", "yuanbao", "chatgpt"],
        by_platform: {
          doubao: { mention: 0.17, first: 0.04, sov: 0.09 },
          deepseek: { mention: 0.12, first: 0.02, sov: 0.07 },
          yuanbao: { mention: 0.08, first: 0.0, sov: 0.04 },
          chatgpt: { mention: 0.06, first: 0.01, sov: 0.03 },
        },
        trend_7d: [0.08, 0.08, 0.09, 0.09, 0.10, 0.10, 0.11],
        competitor_a: { mention: 0.34, first: 0.19, sov: 0.28 },
        captured_at: new Date().toISOString(),
      },
      citation_sources: [
        { platform: "zhihu", status: "待建", note: "品类词答案高频引用源" },
        { platform: "baijiahao", status: "待建", note: "新闻稿分发占位" },
      ],
      conflict_list: [
        { source: "某百科词条", wrong: "功率标称 1200W", correct: "RK-1500W 额定 1500W", status: "修复计划已立项" },
      ],
    },
    // 模块⑦转化资产（数据红线：客资明细留客户系统，此处仅存画像与阶段聚合）
    conversion_assets: {
      inquiry_total: 37, by_entry: { social: 24, ai_search: 13 },
      note: "客资明细不出客户系统边界（此处仅存画像与阶段聚合，红线 R4）",
      month_trend: [9, 14, 21, 28, 37],
      samples: [
        { who: "Hans Weber · 德国五金进口商（汉堡）", entry: "ai_search", stage: "报价谈判", quality: "A", source_path: "Perplexity「CE certified laser cutter China」→ 官网落地页 → WhatsApp", note: "要 3 台 RK-3000W，对比竞对 A 中；AI 答案首推我方的首周即进线" },
        { who: "Mike Torres · 美国金属加工厂主（俄亥俄）", entry: "social", stage: "已成交", quality: "A", source_path: "TikTok 选型口播 → 私信 → WhatsApp", note: "RK-1500W ×1，到仓安装完成，复购意向切割头耗材" },
        { who: "Anna Kowalski · 波兰家具设备采购（波兹南）", entry: "ai_search", stage: "需求确认", quality: "B", source_path: "ChatGPT「best fiber laser for small workshop」→ 知乎英文回答 → 表单", note: "预算敏感，要 CE 与售后 SLA 明细" },
        { who: "Carlos Mendez · 墨西哥钣金代工（蒙特雷）", entry: "social", stage: "画像清洗", quality: "B", source_path: "YouTube 实测视频 → 落地页表单", note: "西语客户，已转私域承接专员跟进" },
      ],
    },
    // 数字CEO 宪章（深度授权六步：shadow 影子模式 3 天 → 试用 7 天）
    charter: {
      version: 2,
      mode: "trial",
      identity: { name: "公司CEO", persona: "双域经营型" },
      autonomy: {
        ranges: {
          price_quote_band: { label: "报价相对基准区间", lower: 0.9, upper: 1.2, anchor: 1 },
        },
        caps: {
          publish_per_day_cap: { label: "账号每日发布条数上限", limit: 3 },
          geo_publish_per_day_cap: { label: "GEO 信源每日发布上限", limit: 2 },
        },
        lists: {
          reply_auto_scope: ["夸赞", "感谢"],
        },
      },
      escalate: [
        "对外公开承诺（赔偿/免费/声明）",
        "涉人设/品牌表态（G20 强制 L4）",
        "围栏规则放宽（任何放宽，G17）",
        "新平台/新账号上线",
        "投放加投（G12 必审）",
        "GEO 灰帽手段（G-GEO3 一票否决）",
        "宪章变更",
      ],
      briefing: { daily: "08:30", weekly: "Mon 09:00", monthly: "1st 10:00", channel: "both" },
      circuit_breaker: { window_days: 14, kpi_floor: { publish_success_rate: 0.95, visibility_drop_7d: -0.05 }, tightened: false },
      grant: {
        event_id: "E-GRANT-GEO01", granted_by: "MEM-G01",
        granted_at: new Date(Date.now() - 6 * 86400e3).toISOString(),
        disclosure_version: "risk-v1",
        clauses: ["双域内容外发", "自主评论分流回复", "能见度监测采集", "试用降档规则", "AI 非法律责任主体·授权人承担经营决策责任"],
        shadow_days: 3, trial_days: 7,
        trial_ends_at: new Date(Date.now() + 4 * 86400e3).toISOString(),
        retain_until: null,
      },
      updated_at: new Date().toISOString(),
    },
    platforms: ["tiktok", "youtube", "zhihu", "toutiao", "baijiahao", "gongzhonghao"],
    forbidden: [
      "禁止宣称超出官方口径的参数与功效（G-GEO2 事实红线）",
      "禁止使用广告法极限词（最/第一/国家级等）",
      "禁止灰帽手段：语料污染/伪造多源/机器刷量（G-GEO3 熔断）",
      "禁止虚构客户案例与成交数据",
    ],
    fact_red_lines: ["宣称不得超出官方口径", "创意前提必须与产品真实使用前提自洽", "品牌实体信息与实体卡逐字一致"],
    data_boundary: {
      rule: "客户业务数据（客资/WhatsApp 聊天/线索）留客户系统；WorkLoom 事件链只记录经营动作留痕（谁、何时、批了什么），不含聊天内容",
      evidence: "能见度监测原始答案截图存证，供双方核验",
    },
  };
}

/* ================= 主流程 ================= */

async function main() {
  const presets = loadPresets();
  const fences = loadFences();
  const skillsDocs = loadSkills();
  const pipelines = loadPipelines();
  console.log(
    `✓ Bundle 资产读取：${presets.length} preset / ${fences.length} 围栏 / ${skillsDocs.length} 技能 / ${pipelines.length} 管线（${pipelines.join("、")}）`,
  );

  const owner = new pg.Client({ connectionString: DATABASE_URL });
  await owner.connect();
  const q = (text: string, params: unknown[]) => owner.query(text, params);

  // 租户 / 工作区
  await q(
    `INSERT INTO tenants (id, name, plan) VALUES ($1,'WorkLoom GEO 演示租户','pro') ON CONFLICT (id) DO NOTHING`,
    [TENANT_ID],
  );
  await q(
    `INSERT INTO workspaces (id, tenant_id, name, slug, industry, stage, night_config, bundle_id, is_example)
     VALUES ($1,$2,$3,$4,'geo-growth','stable',$5,'geo-growth',true)
     ON CONFLICT (id) DO UPDATE SET bundle_id='geo-growth', is_example=true`,
    [
      WS_ID,
      TENANT_ID,
      WS_NAME,
      WS_SLUG,
      JSON.stringify({
        enabled: true,
        candidateTime: "18:00",
        startTime: "22:00",
        packageTime: "08:00",
        timezone: "Asia/Shanghai",
      }),
    ],
  );
  console.log(`✓ 租户与工作区：demo / ${WS_NAME}`);

  // 人类成员
  for (const m of MEMBERS) {
    await q(
      `INSERT INTO members (id, workspace_id, member_no, name, role)
       VALUES ($1,$2,$3,$4,$5) ON CONFLICT (workspace_id, member_no) DO NOTHING`,
      [`${m.id.toLowerCase()}-id`, WS_ID, m.id, m.name, m.role],
    );
  }
  console.log(`✓ 人类成员 ×${MEMBERS.length}（${MEMBERS.map((m) => m.name).join("、")}）`);

  // 数码员工 preset 实例（人机混编通讯录 IM.5；fence_bindings 原样落库 F2.10）
  for (const p of presets) {
    await q(
      `INSERT INTO agents (id, workspace_id, preset_key, name, version, kind, readonly, fence_bindings, skills, status, meta)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'ready',$10)
       ON CONFLICT (id) DO UPDATE
         SET name = EXCLUDED.name, version = EXCLUDED.version, kind = EXCLUDED.kind,
             readonly = EXCLUDED.readonly, fence_bindings = EXCLUDED.fence_bindings,
             skills = EXCLUDED.skills, status = 'ready', meta = EXCLUDED.meta`,
      [
        `agt-geo-${p.preset_key}`,
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
  console.log(`✓ 数码员工 ×${presets.length}（情报 2 + 内容 4 + 分发 3 + 数据 3 + 经营 2 + 指挥 2）`);

  /**
   * 组合编制上岗（2026-09-20 真机验收修复）：
   * geo-growth 的 bundle.json 声明 composition（hotel + ai-video 依赖，presetOwners 含 company-ceo 等），
   * 权威花名册 = 装配器 composeWorkforce 的运行结果（2026-09-24 实测 78 岗，含同名遮蔽裁决）。此前 seed 只落本包 27 岗，
   * 与基座 seed.ts（ws-yunqi 已按组合编制上岗，2026-09-24 实测 78 岗）口径不一致——RDAS L1 矩阵因此判 0/组合编制。
   * 这里与基座同口径补齐；围栏按组合并集落库（只紧不松，不滚动客户已收紧的规则）。
   */
  const { provisionComposedWorkforce } = await import("@workloom/base/bundles");
  const composed = await provisionComposedWorkforce(
    { query: (sql: string, params?: unknown[]) => owner.query(sql, params as never[]) },
    { tenantId: TENANT_ID, workspaceId: WS_ID },
    "geo-growth",
    "system:seed",
  );
  console.log(
    `✓ 组合编制上岗：${composed.bundleIds.join(" + ")} 共 ${composed.rosterSize} 岗`
    + `（围栏并集 ${composed.fenceRules} 条 · 同名遮蔽 ${composed.shadowed.length} 处按主包裁决）`,
  );

  // 组合技能安装：依赖包 official 技能（hotel 30 + ai-video 8）补行并装到本工作区，
  // 让组合编制里的酒店/视频岗位"技能已声明 = 已装备"（与基座 seed.ts 同口径）。
  const composedSkills = loadComposedSkillDocs();
  for (const { bundle, doc } of composedSkills) {
    const skillId = `skill-${doc.name}`;
    // 围栏绑定按共享绑定表回填；未登记（返回 null）时保留注册表现值，绝不臆造或清空。
    // 必须 UPSERT 而不是 DO NOTHING：db:seed:video 等先行种子可能已建行但没带绑定。
    const declared = skillBindingsFor(bundle, doc.name);
    await q(
      `INSERT INTO skills (id, level, bundle, name, version, description, fence_bindings, body, desensitized)
       VALUES ($1,'official',$2,$3,'1.0.0',$4,$5::jsonb,$6,false)
       ON CONFLICT (id) DO UPDATE SET
         bundle = EXCLUDED.bundle,
         description = EXCLUDED.description,
         body = EXCLUDED.body,
         fence_bindings = CASE WHEN $7::boolean THEN EXCLUDED.fence_bindings ELSE skills.fence_bindings END
       WHERE skills.description IS DISTINCT FROM EXCLUDED.description
          OR skills.body IS DISTINCT FROM EXCLUDED.body
          OR ($7::boolean AND skills.fence_bindings IS DISTINCT FROM EXCLUDED.fence_bindings)`,
      [skillId, bundle, doc.name, doc.description, JSON.stringify(declared ?? []), doc.body, declared !== null],
    );
    await q(
      `INSERT INTO skill_installs (skill_id, workspace_id, installed_by, fence_bindings_snapshot, installed_version)
       SELECT s.id, $2, 'system:seed', s.fence_bindings, s.version FROM skills s WHERE s.id=$1
       ON CONFLICT (skill_id, workspace_id) DO UPDATE SET
         fence_bindings_snapshot = EXCLUDED.fence_bindings_snapshot,
         installed_version = EXCLUDED.installed_version
       WHERE skill_installs.fence_bindings_snapshot IS DISTINCT FROM EXCLUDED.fence_bindings_snapshot
          OR skill_installs.installed_version IS DISTINCT FROM EXCLUDED.installed_version`,
      [skillId, WS_ID],
    );
  }
  console.log(`✓ 组合官方技能 ×${composedSkills.length} 已安装（hotel + ai-video + geo-growth 三包并集）`);

  // 一客一档 v2（dataMode=simulated：D24 落地向导横幅事实源——种子库即「全模拟运行态」）
  const archive = { ...clientArchive(), dataMode: "simulated" };
  await q(
    `INSERT INTO profiles (workspace_id, tenant_id, industry, archive, forbidden, pii_vault)
     VALUES ($1,$2,'geo-growth',$3,$4,NULL)
     ON CONFLICT (workspace_id) DO UPDATE SET archive = EXCLUDED.archive, forbidden = EXCLUDED.forbidden, updated_at = now()`,
    [WS_ID, TENANT_ID, JSON.stringify(archive), JSON.stringify(archive.forbidden)],
  );
  console.log("✓ 一客一档 v2（七模块 + forbidden 红线 ×4 + 数据边界声明）");

  // 双域基线围栏装载（active）
  for (const r of fences) {
    await q(
      `INSERT INTO fence_rules (id, rule_id, version, workspace_id, name, level, match_spec, action, is_baseline, status, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'active','system:seed')
       ON CONFLICT (rule_id, version, workspace_id) DO UPDATE
         SET name = EXCLUDED.name, level = EXCLUDED.level, match_spec = EXCLUDED.match_spec,
             action = EXCLUDED.action, is_baseline = EXCLUDED.is_baseline, status = 'active'`,
      [
        `fr-${r.rule_id.toLowerCase()}-v1-${WS_ID}`,
        r.rule_id,
        r.packVersion ?? FENCE_VERSION,
        WS_ID,
        r.name,
        r.level,
        JSON.stringify({ ...r.match, when: r.when }),
        JSON.stringify({
          result: r.level === "auto" ? "pass" : r.level === "review" ? "review" : "blocked",
          note: r.note ?? "",
        }),
        r.is_baseline,
      ],
    );
  }
  const fencePacks = [...new Set(fences.map((r) => r.packVersion ?? FENCE_VERSION))];
  console.log(`✓ 双域基线围栏装载 ×${fences.length}（${fencePacks.join(" + ")}，active）`);

  // GEO 官方技能 + 安装绑定（F8.1/F8.2）
  for (const s of skillsDocs) {
    const skillId = `skill-${s.name}`;
    await q(
      `INSERT INTO skills (id, level, bundle, name, version, description, fence_bindings, body, desensitized)
       VALUES ($1,'official','geo-growth',$2,'1.0.0',$3,'[]',$4,false)
       ON CONFLICT (id) DO NOTHING`,
      [skillId, s.name, s.description, s.body],
    );
    await q(
      `INSERT INTO skill_installs (skill_id, workspace_id, installed_by, fence_bindings_snapshot, installed_version)
       SELECT s.id, $2, 'MEM-G01', s.fence_bindings, s.version FROM skills s WHERE s.id=$1
       ON CONFLICT (skill_id, workspace_id) DO UPDATE SET
         fence_bindings_snapshot = EXCLUDED.fence_bindings_snapshot,
         installed_version = EXCLUDED.installed_version
       WHERE skill_installs.fence_bindings_snapshot IS DISTINCT FROM EXCLUDED.fence_bindings_snapshot
          OR skill_installs.installed_version IS DISTINCT FROM EXCLUDED.installed_version`,
      [skillId, WS_ID],
    );
  }
  console.log(`✓ GEO 官方技能 ×${skillsDocs.length} 已安装`);

  /**
   * 装配台账登记（bundle_installs）。
   *
   * 游客首启入口（accounts.guestEnter）按「is_example=true + 该 Bundle 有 active 安装行」
   * 自动发现示例工作区；漏登记这一行时，产品默认演示工作区（geo-growth）根本进不去——
   * 前端只会看到"示例工作区未就绪（首启种子未完成）"。与 scripts/seed.ts 同口径。
   */
  await q(
    `INSERT INTO bundle_installs (id, workspace_id, bundle_id, assets, status)
     VALUES ($1,$2,'geo-growth',$3,'active')
     ON CONFLICT (id) DO NOTHING`,
    [
      `bi-${WS_ID}-geo-growth`,
      WS_ID,
      JSON.stringify({
        preset_ids: presets.map((p) => `agt-${p.preset_key}`),
        fence_rule_ids: fences.map((r) => `fr-${r.rule_id.toLowerCase()}-v1-${WS_ID}`),
        skill_ids: skillsDocs.map((s) => `skill-${s.name}`),
      }),
    ],
  );
  console.log("✓ 装配台账登记（bundle_installs）");

  // 自动化触发器（4 条主干管线节拍 + CEO Loop）
  const triggers = [
    { id: "tg-geo-intel-0700", name: "情报站每日 07:00 刷新", kind: "cron", schedule: "0 7 * * *", action: { dispatch: "geo-researcher", template: "intel.collect" } },
    { id: "tg-geo-morning-0830", name: "清晨决策包 08:30", kind: "cron", schedule: "30 8 * * *", action: { dispatch: "company-ceo", template: "decision.pack" } },
    { id: "tg-geo-metrics-2h", name: "社媒指标每 2 小时采集", kind: "cron", schedule: "7 */2 * * *", action: { dispatch: "data-board-officer", template: "metrics.collect" } },
    { id: "tg-geo-comments-30m", name: "评论私信每 30 分钟分流", kind: "cron", schedule: "*/30 * * * *", action: { dispatch: "private-domain-operator", template: "comments.ingest" } },
    { id: "tg-geo-visibility-brand", name: "能见度品牌词日频采集", kind: "cron", schedule: "0 21 * * *", action: { dispatch: "visibility-watcher", template: "visibility.collect.brand" } },
    { id: "tg-geo-visibility-full", name: "能见度全量 query 集周频采集", kind: "cron", schedule: "0 9 * * 1", action: { dispatch: "visibility-watcher", template: "visibility.collect.full" } },
    { id: "tg-geo-battle-report", name: "周一全网存在感战报", kind: "cron", schedule: "0 9 * * 1", action: { dispatch: "review-analyst", template: "report.weekly" } },
    { id: "tg-geo-backtest-monthly", name: "月度决策回测", kind: "cron", schedule: "0 10 1 * *", action: { dispatch: "review-analyst", template: "backtest.run" } },
    { id: "tg-geo-entity-patrol", name: "实体一致性夜班巡检", kind: "cron", schedule: "0 2 * * *", action: { dispatch: "entity-inspector", template: "entity.scan" } },
    { id: "tg-geo-fleet-weekly", name: "集团CEO 交付人效看板", kind: "cron", schedule: "0 18 * * 5", action: { dispatch: "group-ceo", template: "fleet.scoreboard" } },
    // 数字CEO 节拍（D21：CEO Loop；调度器消费前经治理守卫校验 charter.mode）
    { id: "tg-geo-ceo-brief-0830", name: "公司CEO 晨报 08:30", kind: "cron", schedule: "30 8 * * *", action: { beat: "daily" } },
    { id: "tg-geo-ceo-queue-2h", name: "公司CEO 裁决巡检 2h", kind: "cron", schedule: "7 */2 * * *", action: { beat: "queue" } },
    { id: "tg-geo-ceo-deviation", name: "公司CEO 目标偏差扫描", kind: "cron", schedule: "15 */4 * * *", action: { beat: "deviation" } },
    { id: "tg-geo-ceo-breaker", name: "公司CEO 自治熔断巡检", kind: "cron", schedule: "45 23 * * *", action: { beat: "breaker" } },
  ];
  for (const t of triggers) {
    await q(
      `INSERT INTO triggers (id, workspace_id, name, kind, schedule, action, enabled, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,true,'system:seed') ON CONFLICT (id) DO NOTHING`,
      [t.id, WS_ID, t.name, t.kind, t.schedule, JSON.stringify(t.action)],
    );
  }
  console.log(`✓ 自动化触发器 ×${triggers.length}（4 条主干管线节拍 + CEO Loop）`);

  /* ================= 运行态剧本（双域演示运行态） ================= */

  // —— 演示线程 ——
  const threads = [
    { id: "T-G01", title: "激光切割机选型·双用选题内容生产", mode: "quest", status: "running", done: 6, total: 9, agent: "agt-geo-geo-content-planner", by: "MEM-G02" },
    { id: "T-G02", title: "query 集 v1 能见度基线采集", mode: "quest", status: "running", done: 18, total: 24, agent: "agt-geo-visibility-watcher", by: "MEM-G02" },
    { id: "T-G03", title: "周一全网存在感战报", mode: "ask", status: "completed", done: 5, total: 5, agent: "agt-geo-review-analyst", by: "MEM-G01" },
  ];
  for (const t of threads) {
    await q(
      `INSERT INTO threads (id, tenant_id, workspace_id, title, mode, status, progress_done, progress_total, created_by, agent_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) ON CONFLICT (id) DO NOTHING`,
      [t.id, TENANT_ID, WS_ID, t.title, t.mode, t.status, t.done, t.total, t.by, t.agent],
    );
  }
  console.log(`✓ 演示线程 ×${threads.length}`);

  // —— 夜班班次（昨夜：能见度采集 24 query / 评论分流 31 条 / 实体巡检 1 轮） ——
  const yesterday = new Date(); yesterday.setDate(yesterday.getDate() - 1);
  const runDate = yesterday.toISOString().slice(0, 10);
  await q(
    `INSERT INTO night_runs (id, workspace_id, run_date, status, fence_snapshot_version, candidate_count, stats, started_at, package_event_id)
     VALUES ($1,$2,$3,'package_generated',$4,11,$5,$6,NULL)
     ON CONFLICT (workspace_id, run_date) DO NOTHING`,
    [
      `nr-geo-${runDate}`, WS_ID, runDate, FENCE_VERSION,
      JSON.stringify({ done: 11, pending: 2, alerts: 1, note: "【社媒侧】TikTok 播放 2.1w（周末峰 ▲31%）/ 涨粉 +214 / 询盘 4 条；【GEO 侧】24 query 采集（品牌词提及 4/6 ▲2，品类词首推破零 1 条，SOV 6% ▲1pt）/ 引用源新增知乎收录 1；【交叉侧】双入口询盘 4 条（社媒 2 / AI 搜索 2，含德国 Hans 报价谈判推进）；评论分流 31 条（自动 27 / 待审 3 / 告警 1）/ 实体巡检发现百科功率口径冲突 1 处（修复计划已立项）" }),
      new Date(yesterday.setHours(22, 0, 0, 0)).toISOString(),
    ],
  );
  console.log("✓ 夜班班次（✓11 ◆2 ▲1，清晨决策包已生成）");

  // —— 账号指标时序（近 7 天 × 2 社媒账号） ——
  const metricRows: unknown[][] = [];
  // 真实感曲线（买单人视角）：非整数、有周末波峰、有日际抖动；伪随机种子固定保证复跑一致
  const jitter = (seed: number) => { const x = Math.sin(seed * 127.1 + 311.7) * 43758.5453; return x - Math.floor(x); };
  for (let d = 7; d >= 1; d--) {
    const day = new Date(); day.setDate(day.getDate() - d); day.setHours(20, 0, 0, 0);
    const dow = day.getDay();
    const weekend = dow === 0 || dow === 6 ? 1.31 : 1.0;
    const base = Math.round((7980 + (7 - d) * 2137) * weekend * (0.88 + jitter(d * 7 + 1) * 0.27));
    metricRows.push([WS_ID, "tiktok", "@RuikeLaser", null, day.toISOString(), base, Math.round(base * (0.038 + jitter(d * 7 + 2) * 0.011)), Math.round(base * (0.015 + jitter(d * 7 + 3) * 0.006)), Math.round(base * (0.009 + jitter(d * 7 + 4) * 0.004)), Math.round(1 + (7 - d) * 0.9 + jitter(d * 7 + 5) * 3)]);
    const yb = Math.round(base * (0.31 + jitter(d * 7 + 6) * 0.09));
    metricRows.push([WS_ID, "youtube", "@RuikeLaserOfficial", null, day.toISOString(), yb, Math.round(yb * 0.026), Math.round(yb * 0.008), Math.round(yb * 0.013), Math.round((1 + (7 - d) * 0.5) * (0.8 + jitter(d * 7 + 7) * 0.5))]);
  }
  for (const m of metricRows) {
    await q(
      `INSERT INTO account_metrics (workspace_id, platform, account_id, video_id, captured_at, plays, likes, comments, shares, conversions)
       SELECT $1,$2,$3,$4,$5,$6,$7,$8,$9,$10
       WHERE NOT EXISTS (SELECT 1 FROM account_metrics WHERE workspace_id=$1 AND platform=$2 AND account_id=$3 AND captured_at=$5)`,
      m as never,
    );
  }
  console.log(`✓ 账号指标时序 ×${metricRows.length}（7 天 × 2 账号）`);

  // —— 评论样本（夸赞自动回/咨询待审/负面告警） ——
  const cmts = [
    ...Array.from({ length: 6 }, (_, i) => ({ id: `cm-g-p${i}`, intent: "praise", body: [
      "Ordered the RK-1500W in March — cutting tolerance is genuinely ±0.03mm. Impressed.",
      "This price point for a 1500W fiber laser is unbeatable. Our shop in Ohio loves it.",
      "Remote support answered at 2am China time within 20 min. Respect.",
      "Second machine ordered for our Poland facility. CE docs were complete, customs smooth.",
      "The cutting demo video is exactly what the machine does. No exaggeration. Rare.",
      "Switched from a German brand — same cut quality, 40% cheaper. No regrets."][i % 6], auto: true })),
    { id: "cm-g-q1", intent: "query", body: "What's the actual cutting speed of the 1500W on 6mm carbon steel? Need real numbers for our production plan.", auto: false },
    { id: "cm-g-c1", intent: "crisis", body: "Machine arrived with a dented frame at the port of Hamburg. Need resolution ASAP!!", auto: false },
  ];
  for (const [i, c] of cmts.entries()) {
    await q(
      `INSERT INTO comments (id, workspace_id, platform, account_id, video_id, platform_comment_id, author, text, intent, route_level, status, collected_at)
       VALUES ($1,$2,'tiktok','@RuikeLaser','vid-g01',$3,$4,$5,$6,$7,$8,$9) ON CONFLICT (id) DO NOTHING`,
      [
        c.id, WS_ID, `pc-${c.id}`, `buyer_${i}`, c.body, c.intent,
        c.intent === "praise" ? "auto" : "review",
        c.auto ? "replied" : "pending_review",
        new Date(Date.now() - i * 53 * 60000).toISOString(),
      ],
    );
    if (c.auto) {
      await q(
        `INSERT INTO comment_replies (id, workspace_id, comment_id, text, channel, status, receipt, created_by, created_at)
         VALUES ($1,$2,$3,'Thanks! Full spec sheet & test report in DM.','auto','sent','{"delivered":true}','agt-geo-private-domain-operator',$4) ON CONFLICT (id) DO NOTHING`,
        [`cr-${c.id}`, WS_ID, c.id, new Date(Date.now() - i * 53 * 60000 + 300000).toISOString()],
      );
    }
  }
  console.log(`✓ 评论 ×${cmts.length}（夸赞自动回 6 / 咨询待审 1 / 危机告警 1）`);

  // —— 五元事件链（gateway 角色写入；60 条，双域场景） ——
  const gw = new pg.Client({ connectionString: GATEWAY_URL });
  await gw.connect();
  await gw.query("SELECT set_config('app.tenant_id', $1, false)", [TENANT_ID]);
  await gw.query("SELECT set_config('app.workspace_id', $1, false)", [WS_ID]);

  const agentWho = (key: string) => {
    const p = presets.find((x) => x.preset_key === key);
    return { type: "agent" as const, id: key, version: p?.version ?? "v1.0" };
  };
  const now = Date.now();
  const dayStart = new Date(); dayStart.setHours(0, 0, 0, 0);
  const times: Date[] = [];
  for (let i = 0; i < 60; i++) {
    let t: number;
    if (i % 5 < 3) {
      const ns = new Date(dayStart); ns.setDate(ns.getDate() - 1); ns.setHours(22, 0, 0, 0);
      const ne = new Date(dayStart); ne.setHours(8, 30, 0, 0);
      t = ns.getTime() + ((i * 7919) % 1000) / 1000 * (ne.getTime() - ns.getTime());
    } else {
      t = dayStart.getTime() - 86400e3 + ((i * 104729) % 1000) / 1000 * (now - (dayStart.getTime() - 86400e3));
    }
    times.push(new Date(t));
  }
  times.sort((a, b) => a.getTime() - b.getTime());

  // 事件编号段分配纪律（同租户 UNIQUE(tenant_id,event_id)，各种子不得重叠）：
  // seed.ts（hotel）8801-8900 / seed-video.ts 6601-6700 / seed-geo.ts 9901-9960
  const EVENT_BASE_G = 9900;
  const mkEvent = (i: number, time: Date) => {
    const id = `E-SEED-${EVENT_BASE_G + i}`;
    const scene = i % 10;
    const ctx = { tenant_id: TENANT_ID, workspace_id: WS_ID, time: time.toISOString(), stage: "stable", store: WS_NAME };
    const receipt = { synced: true, snapshot_uri: `data/snapshots/${id.toLowerCase()}.png`, verified_at: new Date(time.getTime() + 45000).toISOString() };
    const mt = { model_id: "mock-geo-001", tier: "standard", window: time.getHours() >= 22 || time.getHours() < 8 ? "off-peak" : "peak", credits: 1 };
    switch (scene) {
      case 0: return { event_id: id, who: agentWho("visibility-watcher"), context: ctx, object: { type: "visibility_snapshot", id: `vs-${(i % 24) + 1}`, label: "品牌词能见度快照" }, decision: { action: "visibility.collect", after: { platform: "deepseek", query: "锐科激光切割机怎么样", mentioned: true, first: false }, basis: ["品牌词日频采集", "原始答案截图已存证"] }, rule_impact: [], receipt, model_trace: mt };
      case 1: return { event_id: id, who: agentWho("geo-content-planner"), context: ctx, object: { type: "geo_content", id: "geo-c-001", label: "激光切割机怎么选·AI 答案版" }, decision: { action: "geo.rewrite", after: { format: "六段式", entity_anchors: "与实体卡逐字一致（已比对）" }, basis: ["脚本人审通过自动触发", "品类词→清单式结构"] }, rule_impact: [{ rule_id: "G-GEO2", version: FENCE_VERSION, result: "pass" }], receipt, model_trace: mt };
      case 2: return { event_id: id, who: agentWho("private-domain-operator"), context: ctx, object: { type: "inquiry", id: `inq-${(i % 3) + 1}`, label: "WhatsApp 询盘" }, decision: { action: "inquiry.tag", after: { entry: i % 3 === 0 ? "social" : "ai_search", quality: "有效" }, basis: ["双入口来源打标", "落地页渠道参数识别"] }, rule_impact: [], receipt, model_trace: mt };
      case 3: return { event_id: id, who: agentWho("source-distributor"), context: ctx, object: { type: "source_task", id: "st-zhihu-001", label: "知乎·选型清单文分发" }, decision: { action: "geo.publish", after: { platform: "zhihu", url: "https://example.invalid/zh/001" }, basis: ["G-GEO1 审批通过", "模拟人工节奏"] }, rule_impact: [{ rule_id: "G-GEO1", version: FENCE_VERSION, result: "pass" }], receipt, model_trace: mt };
      case 4: return { event_id: id, who: agentWho("company-ceo"), context: ctx, object: { type: "workspace", id: WS_ID, label: WS_NAME }, decision: { action: "ceo.briefing", after: { text: "董事长，早报已备：昨日能见度品牌词提及 4/6（▲2），社媒播放 1.9w（▲22%）；双入口询盘 3 条（社媒 2 / AI 搜索 1）；1 件谨慎上浮请您定——百科词条功率口径修复外发。试用期第 4 天，边界降一档执行中。" }, basis: ["CEO Loop 日频晨报 08:30"] }, rule_impact: [], receipt, model_trace: mt };
      case 5: return { event_id: id, who: agentWho("entity-inspector"), context: ctx, object: { type: "conflict_item", id: "cf-001", label: "百科功率口径冲突" }, decision: { action: "entity.scan", after: { wrong: "功率标称 1200W", correct: "RK-1500W 额定 1500W", plan: "平台申诉+更正稿双路径" }, basis: ["夜班实体巡检", "与实体卡 confirmed 字段逐字比对"] }, rule_impact: [], receipt, model_trace: mt };
      case 6: return { event_id: id, who: agentWho("geo-researcher"), context: ctx, object: { type: "intel_card", id: `ic-${(i % 5) + 1}`, label: "AI 问答高频问题情报卡" }, decision: { action: "intel_card.emit", after: { source_domain: "AI问答", topic: "出口欧洲的机械认证要求", suggest: "双用" }, basis: ["置信度 confirmed", "双用选题优先排产"] }, rule_impact: [], receipt, model_trace: mt };
      case 7: return { event_id: id, who: agentWho("publish-operator"), context: ctx, object: { type: "publish_task", id: "pt-tt-001", label: "选型指南口播·TikTok" }, decision: { action: "publish.execute", after: { platform: "tiktok", url: "https://example.invalid/tt/001" }, basis: ["G9 审批通过", "日发第 2 条（上限 3）"] }, rule_impact: [{ rule_id: "G9", version: FENCE_VERSION, result: "pass" }], receipt, model_trace: mt };
      case 8: return { event_id: id, who: agentWho("review-analyst"), context: ctx, object: { type: "battle_report", id: "br-w01", label: "全网存在感周报 W34" }, decision: { action: "report.weekly", after: { social: "播放 12.4w/询盘 9", geo: "提及率 8%→11%/首推率 0%→2%", cross: "AI 搜索入口询盘 2 条（首破零）" }, basis: ["三栏战报", "人签发后外发"] }, rule_impact: [], receipt, model_trace: mt };
      default: return { event_id: id, who: agentWho("company-ceo"), context: ctx, object: { type: "topic_card", id: "topic-001", label: "双用选题排产" }, decision: { action: "ceo.decision", after: { tier: "l2_captain", topic: "「CE 认证要求」双用选题排产", expected: "GEO 图文首推率 +3%，短视频播放 1.5w+" }, basis: ["宪章自治边界内", "双用选题优先纪律"] }, rule_impact: [], receipt, model_trace: mt };
    }
  };

  const lastHash = await gw.query(`SELECT hash FROM biz_events WHERE tenant_id=$1 ORDER BY seq DESC LIMIT 1`, [TENANT_ID]);
  let prevHash = (lastHash.rows[0]?.hash as string) ?? "GENESIS";
  const sessionOf = (scene: number) => (scene === 1 || scene === 3 || scene === 9 ? "T-G01" : scene === 0 ? "T-G02" : scene === 8 ? "T-G03" : null);
  let inserted = 0;
  for (let i = 1; i <= 60; i++) {
    const ev = mkEvent(i, times[i - 1] as Date);
    const checked = safeParseReplayAwareEvent(ev);
    if (!checked.success) throw new Error(`种子事件 ${ev.event_id} 未过校验：${checked.error.message}`);
    /**
     * 幂等口径（2026-09-20 真机验收修复）：先查存在再写。
     * 旧写法 `ON CONFLICT DO NOTHING` 在重复 seed 时每条冲突都会消耗一次 nextval——
     * 复跑一次就烧掉整批序号，verify-chain 判「>500 连续空洞，疑似恶意删段」（实测 777 空洞）。
     * 与基座 seed.ts 的 L1.4 口径一致：存在即跳过，序号只在该事件真正落账时消耗。
     */
    const exists = await gw.query(`SELECT 1 FROM biz_events WHERE tenant_id=$1 AND event_id=$2`, [TENANT_ID, ev.event_id]);
    if (exists.rowCount) continue;
    const payload = JSON.stringify(checked.data);
    const hash = eventHash(prevHash, checked.data);
    const res = await gw.query(
      `INSERT INTO biz_events (event_id, tenant_id, workspace_id, session_id, payload, prev_hash, hash, created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT (tenant_id, event_id) DO NOTHING RETURNING seq`,
      [ev.event_id, TENANT_ID, WS_ID, sessionOf(i % 10), payload, prevHash, hash, (ev.context as { time: string }).time],
    );
    if (res.rowCount && res.rowCount > 0) { prevHash = hash; inserted++; }
  }
  console.log(`✓ 五元事件链 ×${inserted}（双域场景，哈希链续接，可验链）`);

  // —— 待批请示（G-GEO1 外发 / G12 加投 / G20 品牌表态） ——
  const approvalsSeed = [
    { aid: "apr-g-001", eid: `E-SEED-${EVENT_BASE_G + 11}`, tier: "l2_captain", title: "GEO 内容外发知乎", snapshot: { title: "「激光切割机怎么选」AI 答案版外发知乎", action: "geo.publish", params: { platform: "zhihu", format: "六段式", word_count: 1450 }, gate: "G-GEO1", ceo_rationale: "G-GEO2 事实红线校验已通过（实体锚点与实体卡逐字一致），品类词 P1 优先级，建议批准。", contentMd: "# GEO 外发请示\n\n六段式齐全，信源引用 3 处，实体锚点比对 12/12 一致。" } },
    { aid: "apr-g-002", eid: `E-SEED-${EVENT_BASE_G + 21}`, tier: "l4_chairman", title: "Meta 加投 $500", snapshot: { title: "Meta 加投 $500 · 需要你拍板", action: "ads.boost", params: { campaign: "选型指南口播", amount: 500, window: "72h" }, gate: "G12", ceo_rationale: "素材正处爬升期（CTR 3.8%→5.1%），加投 ROI 预估 1:2.8；但涉预算，请您定。" } },
    { aid: "apr-g-003", eid: `E-SEED-${EVENT_BASE_G + 31}`, tier: "l4_chairman", title: "品牌表态回应（强制 L4）", snapshot: { title: "「锐科 vs 竞对A」AI 答案负面偏差回应 · 强制 L4", action: "content.submit", params: { involves_brand_stance: true, topic: "对比词负面偏差澄清" }, gate: "G20", ceo_rationale: "能见度监测发现对比词答案存在事实偏差，建议以实体卡口径发澄清稿——涉品牌表态，必须您本人裁决。" } },
  ];
  for (const a of approvalsSeed) {
    await q(
      `INSERT INTO approvals (approval_id, tenant_id, workspace_id, event_id, channel, status, tier, snapshot)
       VALUES ($1,$2,$3,$4,'inapp','pending',$5,$6)
       ON CONFLICT (approval_id) DO NOTHING`,
      [a.aid, TENANT_ID, WS_ID, a.eid, a.tier, JSON.stringify(a.snapshot)],
    );
  }
  console.log("✓ 待批请示 ×3（G-GEO1 外发 ×1 + G12 加投 L4 ×1 + G20 品牌表态 L4 ×1）");

  await gw.end();
  console.log("✓ 运行态剧本完成（情报/能见度/双域分发/私域/晨报/审批全量有数）");

  // GR-02（2026-09-29 第二次修复）：种子/手写 id 写入方收尾对齐号源（取号函数只做 nextval）
  const seqFloor = await alignReadableIdSequences(owner);
  console.log(`✓ 可读号源对齐：threads→${seqFloor.threads}，video_projects→${seqFloor.videoProjects}`);

  await owner.end();
  console.log("\nWorkLoom GEO 双域演示种子完成。下一步：pnpm dev 后在工作台查看（ws-geo 工作区）。");
}

main().catch((err) => {
  console.error("seed-geo 失败：", err);
  process.exit(1);
});
