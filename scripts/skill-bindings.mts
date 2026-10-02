/**
 * 组合技能围栏绑定表（ai-video / geo-growth）。
 *
 * 2026-09-20 真机验收修复：该表原先只存在于 `scripts/seed.ts` 内部，`scripts/seed-geo.ts`
 * 安装组合技能（hotel + ai-video + geo-growth）时无从复用，只能落空绑定——
 * 结果是 ai-video 技能注册表 `fence_bindings=[]`，而 SKILL.md 显式声明 G10/G6/G1…，
 * RDAS matrix 的 SA3_fences 判「声明未进绑定」（0/67）。绑定表收口到本模块（唯一事实源），
 * 两个 seed 共用；未声明的技能保持空绑定（不臆造）。
 */

/** hotel 包技能绑定表（30 技能；与 workloom-hotel v3.4.0 同口径，原在 seed.ts 内部）。 */
export const HOTEL_SKILL_BINDINGS: Record<string, string[]> = {
  "revenue-manager": ["R1", "R2", "R7", "R8"],
  "review-crisis": ["R6"],
  "channel-reconciler": ["R4", "R5"],
  "inspection-suite": [],
  "night-audit-suite": ["R5"],
  "checkin-checkout": ["R4", "R14"],
  "customer-service": ["R13"],
  "content-marketing": ["R3", "R15"],
  "retention-manager": ["R9"],
  "inventory-procurement": ["R11"],
  "staff-scheduler": ["R12"],
  "safety-compliance": ["R10"],
  "finance-reporting": [],
  "morning-briefing": [],
  "handover-manager": [],
  "pricing-matrix": ["R1", "R2"],
  "review-asset-mining": [],
  "room-service-dispatch": ["R14"],
  "maintenance-dispatch": [],
  "ai-live-assistant": ["R15", "R2"],
  "ota-operations": [],
  "guest-profile-crm": [],
  "phone-concierge": ["R9", "R13"],
  "overbooking-parity-guard": ["R17", "R18", "R2"],
  "incident-postmortem": ["R10"],
  // v3.3 获客域技能绑定
  "lead-concierge": ["R21", "R23", "R24", "R25"],
  "coupon-ops": ["R22", "R26"],
  "hotel-geo-content": ["R25"],
  "intent-radar": [],
};

export const COMPOSED_SKILL_BINDINGS: Record<"ai-video" | "geo-growth", Record<string, string[]>> = {
  "ai-video": {
    "comment-ops": ["G10a", "G10b", "G10c", "G10d"],
    "director-review": ["G6"],
    "jenny-loom-research": ["G1"],
    "marketing-brief-parser": ["G2"],
    "portrait-studio": ["G5"],
    "publish-ops": ["G9", "G9a"],
    "render-ops": ["G8"],
    "shot-prompt-craft": ["G6"],
    // 后期 BGM 配乐师五件套（2026-09-22）：安装即绑定成片配乐门 G-BGM0..G-BGM5，卸载即撤销。
    // 注：同批的调色师四件套（color-*）未登记在本表（历史遗留，见 docs/bgm-composer-role-design.md §13），
    // 其围栏目前只经 colorist preset 的 fence_bindings 生效；补登记会把色桥技能并集一次性放宽，故留作独立任务卡。
    "bgm-score-design": ["G-BGM0", "G-BGM1", "G-BGM3", "G-BGM5"],
    "bgm-audio-layering": ["G-BGM0", "G-BGM2", "G-BGM3", "G-BGM4"],
    "bgm-vocal-separation": ["G-BGM0", "G-BGM3"],
    "bgm-library-license": ["G-BGM1", "G-BGM5"],
    "bgm-delivery-spec": ["G-BGM0", "G-BGM1", "G-BGM2", "G-BGM3", "G-BGM4", "G-BGM5"],
    // 后期字幕师五件套（2026-09-23）：安装即绑定标题字幕门 G-SUB0..G-SUB5，卸载即撤销。
    // 注：字幕与围栏的关系不是"一对一"——选型看到品牌视觉锤与许可，烧录看到覆盖原片与安全区，
    // 交付规范看全量，所以按技能职责分配绑定，不做并集兜底。
    "font-selection": ["G-SUB0", "G-SUB1", "G-SUB3", "G-SUB5"],
    "subtitle-layout-design": ["G-SUB0", "G-SUB3", "G-SUB6"],
    "caption-burnin-ops": ["G-SUB0", "G-SUB2", "G-SUB3", "G-SUB6"],
    "font-license-compliance": ["G-SUB1", "G-SUB5"],
    "subtitle-delivery-spec": ["G-SUB0", "G-SUB1", "G-SUB2", "G-SUB3", "G-SUB4", "G-SUB5", "G-SUB6"],
    // 后期配音师五件套（2026-09-23）：安装即绑定本地声音克隆/配音门 G-VOICE0..G-VOICE6，卸载即撤销。
    // 授权（G-VOICE1/G-VOICE6）与声纹不出域（G-VOICE5）是这套技能的核心纪律，故五件套全量绑定。
    "voice-clone-consent": ["G-VOICE1", "G-VOICE5", "G-VOICE6"],
    "voice-reference-craft": ["G-VOICE0", "G-VOICE1", "G-VOICE5"],
    "voice-profile-craft": ["G-VOICE0", "G-VOICE1", "G-VOICE2", "G-VOICE5", "G-VOICE6"],
    "voice-dubbing-sync": ["G-VOICE2", "G-VOICE3", "G-VOICE4"],
    "voice-delivery-spec": ["G-VOICE0", "G-VOICE1", "G-VOICE2", "G-VOICE3", "G-VOICE4", "G-VOICE5", "G-VOICE6"],
  },
  "geo-growth": {
    "ai-answer-rewrite": ["G-GEO1", "G-GEO2"],
    "entity-consistency-check": ["G-GEO2"],
    // 获客用增班组技能（v1.2）：预算带/实验登记与停止/价格承诺/转介与数据边界
    "experiment-design": ["G-GROW3", "G-GROW4"],
    "budget-portfolio": ["G-GROW1"],
    "lead-scoring": ["G-GROW6"],
    "cro-playbook": ["G-GROW2"],
    "live-commerce": ["G-GROW2", "G-GROW4"],
    "growth-review": [],
    "incrementality-measurement": ["G-GROW6"],
    // P2 条件岗技能（默认未激活，硬门禁 G-GROW7/8）
    "lifecycle-growth": ["G-GROW7", "G-GROW2"],
    "growth-partnership": ["G-GROW8", "G-GROW2"],
  },
} as const;

/**
 * 统一查询：bundle + 技能名 → 围栏绑定。
 * 返回 null 表示"登记表未收录"——调用方必须保留注册表原值，不得当作空绑定清空。
 */
export function skillBindingsFor(bundle: string | null | undefined, name: string): string[] | null {
  if (bundle === "hotel") return HOTEL_SKILL_BINDINGS[name] ?? null;
  if (bundle === "ai-video" || bundle === "geo-growth") return COMPOSED_SKILL_BINDINGS[bundle][name] ?? null;
  return null;
}
