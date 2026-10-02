/**
 * @workloom/audit-engine —— 质检模式「获客全链路快照快扫」确定性检测引擎
 * 出口：类型 + 七个分析器 + runFastScan 主入口 + 阈值常量（测试/调参用）。
 * 方法论锚点：bundles/hotel/skills/fast-scan/SKILL.md（双线七线）
 *            + bundles/hotel/fences/hotel-baseline.yml（R 系阈值）
 *            + bundles/geo-growth/fences/geo-growth-baseline.yml（G 系口径）。
 */
export * from "./types.js";
export { runFastScan, DEFAULT_FLOOR_PRICE, CHAIN_OF_LINE } from "./engine.js";
export {
  analyzePrice,
  PARITY_GAP_THRESHOLD,
  PARITY_GAP_P0,
  HOLIDAY_UPLIFT_MIN,
  WEEKDAY_HIGH_RATIO,
  WEEKDAY_LOW_RATIO,
} from "./analyzers/price.js";
export { analyzeInventory, MAINTENANCE_RATIO_REDLINE } from "./analyzers/inventory.js";
export {
  analyzeChannel,
  COMMISSION_TOLERANCE_PP,
  COMMISSION_DIFF_P1_AMOUNT,
  CHANNEL_DEPENDENCE_REDLINE,
  CHANNEL_DEPENDENCE_P0,
} from "./analyzers/channel.js";
export {
  analyzeReputation,
  BAD_RATING_MAX,
  UNREPLIED_HOURS,
  UNREPLIED_HOURS_P0,
  LOW_RATING,
  RATING_DROP_REDLINE,
  CLUSTER_DAYS,
  CLUSTER_MIN_BAD,
  BAD_KEYWORDS,
} from "./analyzers/reputation.js";
export {
  analyzeGrowth,
  LIMIT_DROP_RATIO,
  LIMIT_STREAK_MIN,
  LIMIT_STREAK_P0,
  SENSITIVE_OPS_MAX,
  STALE_DAYS_P1,
  STALE_DAYS_P0,
  LOW_COMPLETION,
  LOW_COMPLETION_SHARE,
  HIT_MULTIPLE,
  REUSE_WINDOW_DAYS,
} from "./analyzers/growth.js";
export { analyzeGeo, HIJACK_LEAD_MONTHLY, BRAND_ABSENT_LEAD_MONTHLY } from "./analyzers/geo.js";
export {
  analyzeFunnel,
  DM_RESPONSE_HOURS,
  LEAD_FOLLOWUP_HOURS,
  LEAD_CONV_RATE,
  NO_COMPONENT_LEAD_RATE,
  LEAD_NO_VISIT_DAYS,
} from "./analyzers/funnel.js";
export type { AnalyzerContext } from "./analyzers/util.js";
