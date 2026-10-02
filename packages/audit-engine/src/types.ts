/**
 * @workloom/audit-engine · 核心类型（获客全链路版）
 * 质检模式（audit_only）「获客全链路快照快扫」的确定性检测引擎数据模型。
 * 方法论事实源：bundles/hotel/skills/fast-scan/SKILL.md（双线扫描）。
 * 阈值口径：bundles/hotel/fences/hotel-baseline.yml（R2 保底价 ¥380 / R17 倒挂 / R18 超售漏售 / R19 差评 24h SLA）
 *          + bundles/geo-growth/fences/geo-growth-baseline.yml（G9/G16 账号纪律、GEO 能见度口径）。
 *
 * 数据流：连接器只读快照（PMS/OTA + 社媒 + GEO）→ AuditSnapshot（归一化数据集）
 *        → 七个分析器（酒店运营线 4 + 获客转化线 3）→ Finding[] → AuditReport。
 * 全程只读：引擎不触碰任何 PMS/OTA/社媒/GEO 写接口，只读快照进、发现/报告出。
 *
 * 分层纪律：通用质检模型（Severity/Confidence/ImpactPeriod/Coverage…）
 * 一律复用 @workloom/audit-core 内核（packages/base/audit-core，vendored from workloom-im），
 * 本文件只保留双线快照数据集、行业发现/报告视图与计量单位口径，不再重复定义内核类型。
 */

// ---------- 内核通用类型（re-export，事实源在 audit-core） ----------

import type {
  Coverage,
  Coverage as LineCoverage,
  ImpactConfidence as Confidence,
  ImpactPeriod,
  Severity,
} from "../../base/audit-core/index.js";

export type {
  Severity,
  ImpactConfidence,
  /** 兼容旧名：Confidence = ImpactConfidence */
  ImpactConfidence as Confidence,
  ImpactPeriod,
  Coverage,
  /** 兼容旧名：LineCoverage = Coverage */
  Coverage as LineCoverage,
} from "../../base/audit-core/index.js";

// ---------- 行业检线 ----------

/** 双线七线：酒店运营线（hotel_*）+ 获客转化线（growth/geo/funnel） */
export type AuditLine =
  | "hotel_price"
  | "hotel_inventory"
  | "hotel_channel"
  | "hotel_reputation"
  | "growth"
  | "geo"
  | "funnel";

/** 链路环节（报告按「流量→转化→成交」分组） */
export type ChainStage = "traffic" | "conversion" | "deal";

/**
 * 估算计量单位（复用 currency 字段名，与电商版骨架一致）：
 *  CNY=可勾稽金额；LEADS=预估线索（条）；FANS=预估涨粉/粉丝流失。
 * 每条 estimatedImpact 必须在 basis 中写明计算口径（SKILL.md：估算口径透明）。
 */
export type ImpactUnit = "CNY" | "LEADS" | "FANS";

// ---------- 快照数据集（输入）：酒店运营侧 ----------

/** 渠道档案（佣金协议比例为对账勾稽基准；缺失时该渠道佣金子项降级） */
export interface ChannelProfile {
  /** 渠道编码：ctrip/meituan/fliggy/dy/direct… */
  channel: string;
  /** OTA 佣金应提比例（0–1；直连/直销渠道可为 0） */
  commissionRate?: number;
}

/** 门店档案 + 口碑指标（一店一档口径；缺省字段表示该指标未采集） */
export interface HotelInfo {
  hotelId: string;
  hotelName: string;
  /** ISO 4217 币种 */
  currency: string;
  timezone: string;
  /** 保底价（business.floor_price 同源，R2；缺失时引擎按默认 ¥380 判定并在报告中标注） */
  floorPrice?: number;
  /** 总房量（问题房占比分母；缺失时该子项按 roomDays 推算） */
  roomCount?: number;
  /** 当前综合评分（OTA 汇总；口碑线输入） */
  rating?: number;
  /** 近 30 天评分变化（负=下滑；口碑线输入） */
  ratingDelta30d?: number;
  /** 已授权渠道档案 */
  channels: ChannelProfile[];
}

/** 房型主数据（价格带基准） */
export interface RoomTypeRecord {
  hotelId: string;
  roomTypeId: string;
  name: string;
  /** 价格带基准价（远期日历异常子项的中位数缺省回退） */
  basePrice?: number;
  currency: string;
}

/** 渠道在售房价（价格日历 × 渠道；倒挂与破防判定输入） */
export interface ChannelPriceRecord {
  hotelId: string;
  roomTypeId: string;
  /** 入住日期 YYYY-MM-DD */
  date: string;
  channel: string;
  price: number;
  currency: string;
}

/**
 * 房态库存逐日记录（PMS 实盘 × 渠道可售）。
 * totalRooms/sold/maintenanceRooms 为 PMS 口径（同房型同日跨渠道行应一致）；
 * available/closed 为渠道口径。
 */
export interface RoomDayRecord {
  hotelId: string;
  roomTypeId: string;
  /** 入住日期 YYYY-MM-DD */
  date: string;
  channel: string;
  /** PMS 实盘总房量（该房型当日） */
  totalRooms: number;
  /** PMS 已售间数 */
  sold: number;
  /** 问题房（维修中/锁房）间数；未采集省略则问题房子项降级 */
  maintenanceRooms?: number;
  /** 渠道可售间数（负值=超售） */
  available: number;
  /** 渠道是否关房 */
  closed: boolean;
}

/** 酒店订单（近 90 天，含取消/no-show 标记） */
export interface HotelOrderRecord {
  hotelId: string;
  orderId: string;
  channel: string;
  roomTypeId?: string;
  /** 成交总额（含全部间夜） */
  amount: number;
  currency: string;
  /** 间夜数 */
  nights: number;
  status: "confirmed" | "completed" | "cancelled" | "no-show" | "refunded";
  /** 入住日期 YYYY-MM-DD */
  checkIn: string;
  createdAt: string; // ISO 8601
}

/** OTA 渠道账单行（渠道健康线勾稽输入） */
export interface ChannelBillLineRecord {
  lineId: string;
  type: "order" | "commission" | "refund" | "no-show-charge";
  /** 关联单据号（订单号） */
  refId: string;
  amount: number;
  currency: string;
}

export interface ChannelBillRecord {
  hotelId: string;
  channel: string;
  billId: string;
  /** 账期 YYYY-MM */
  period: string;
  lines: ChannelBillLineRecord[];
}

/** 评价记录（口碑线输入） */
export interface HotelReviewRecord {
  hotelId: string;
  reviewId: string;
  channel?: string;
  roomTypeId?: string;
  /** 1–5 分 */
  rating: number;
  createdAt: string; // ISO 8601
  /** 回复时间；未回复省略 */
  repliedAt?: string;
  content?: string;
}

// ---------- 快照数据集（输入）：获客转化侧 ----------

/** 违规/处罚记录（账号健康输入，G9/G16 域只读核查） */
export interface ViolationRecord {
  violationId: string;
  /** 违规类型描述（如"搬运判定""导流处罚"） */
  type: string;
  occurredAt: string; // ISO 8601
  level: "warning" | "minor" | "major";
}

/** 主页资料与转化组件核查面（头像/简介归 growth 线；橱窗/预约/联系方式归 funnel 线，互不双算） */
export interface ProfileComponents {
  avatar: boolean;
  bio: boolean;
  /** 团购/券挂载位 */
  showcase: boolean;
  /** 预约组件（订房/看房预约） */
  booking: boolean;
  /** 联系方式（电话/微信/官网链接任一） */
  contact: boolean;
}

/** 私信自动回复配置状态（funnel 线输入） */
export interface AutoReplyStatus {
  configured: boolean;
  /** 已配置但失效（如接口掉授权/开关被关） */
  active: boolean;
}

/** 社媒账号档案 + 状态指标（挂属门店；缺省字段表示该指标未采集，对应子项降级） */
export interface SocialAccountInfo {
  accountId: string;
  /** 挂属门店（报告按店归集） */
  hotelId: string;
  platformId: string;
  accountName: string;
  followers: number;
  profile: ProfileComponents;
  violations: ViolationRecord[];
  /** 近 30 天敏感操作次数（频繁改绑/换设备/改实名等，G16 域只读核查输入） */
  sensitiveOps30d?: number;
  autoReply?: AutoReplyStatus;
  /** 自设发布节律（条/周；缺失时节律子项降级） */
  expectedPostsPerWeek?: number;
  /** 粉丝活跃高峰小时（0-23；缺失时时段错配子项降级） */
  trafficPeakHours?: number[];
}

/** 内容（视频/图文）记录（限流判定、内容节律、爆款挂载核查输入） */
export interface ContentRecord {
  accountId: string;
  contentId: string;
  title: string;
  publishedAt: string; // ISO 8601
  plays: number;
  /** 完播率 0-1（未采集可省略，完播子项跳过该条） */
  completionRate?: number;
  likes: number;
  comments: number;
  shares: number;
  /** 选题方向（高潜素材复用判定的分组键） */
  topic?: string;
  /** 是否挂载转化组件（团购/券/预约/链接任一） */
  hasConversionComponent: boolean;
  /** 内容指纹（矩阵搬运判定：同 hash 多号发布=重复内容） */
  contentHash?: string;
}

/** 私信记录（funnel 线：响应时效与未承接高意向判定输入） */
export interface DirectMessageRecord {
  accountId: string;
  messageId: string;
  text: string;
  receivedAt: string; // ISO 8601
  /** 首次响应时间；未响应省略 */
  respondedAt?: string;
  /** 高意向咨询（问价/问房态/要联系方式类） */
  isInquiry?: boolean;
}

/** 线索记录（询盘→跟进→到店→成交链路，funnel 线断点判定输入；脱敏聚合口径，R24 同源） */
export interface LeadRecord {
  accountId: string;
  leadId: string;
  /** 询盘时间（私信/表单/评论转化而来） */
  inquiryAt: string; // ISO 8601
  /** 首次跟进时间；未跟进省略 */
  followedUpAt?: string;
  /** 到店/看房时间；未到店省略 */
  visitedAt?: string;
  /** 成交时间；未成交省略 */
  dealAt?: string;
  sourceContentId?: string;
}

// ---------- 快照数据集（输入）：GEO 能见度侧 ----------

/** GEO query 能见度记录（AI 搜索答案快照；geo 线输入） */
export interface GeoQueryRecord {
  hotelId: string;
  /** 目标关键词（如「杭州西湖边亲子酒店推荐」） */
  query: string;
  /** brand=品牌词；category=品类/场景词 */
  type: "brand" | "category";
  /** 业务优先级 */
  priority: "P0" | "P1" | "P2";
  /** 我方是否被 AI 答案提及/引用 */
  mentioned: boolean;
  /** 我方是否为首推（提及中的第一位） */
  firstRecommended?: boolean;
  /** 该 query 下被 AI 答案引用的竞对（空=无竞对被引） */
  competitorsCited: string[];
  /** 采集的 AI 平台（deepseek/doubao/perplexity…） */
  platform?: string;
}

/** GEO 内容资产（官网/图文/落地页；引用友好度核查输入） */
export interface GeoContentAsset {
  hotelId: string;
  assetId: string;
  title: string;
  url?: string;
  /** 是否含 FAQ 块（AI 答案引用的高亲和结构） */
  hasFaqBlock: boolean;
  /** 是否含结构化数据（JSON-LD/Schema.org） */
  hasStructuredData: boolean;
}

// ---------- 快照数据集（总） ----------

/**
 * 快照数据集：一次体检的全部输入。
 * 各字段可为空数组——对应数据源缺失时该线标注「未覆盖」，引擎降级出部分报告（SKILL.md 四）。
 */
export interface AuditSnapshot {
  snapshotId: string;
  /** 快照生成时间（差评 24h SLA、私信 12h、断更天数、近 30 天窗口等均以 now 为锚） */
  generatedAt: string; // ISO 8601
  /* 酒店运营侧 */
  hotels: HotelInfo[];
  roomTypes: RoomTypeRecord[];
  channelPrices: ChannelPriceRecord[];
  roomDays: RoomDayRecord[];
  orders: HotelOrderRecord[];
  channelBills: ChannelBillRecord[];
  reviews: HotelReviewRecord[];
  /** 节假日日期清单（YYYY-MM-DD，收益日历来源；缺失时远期日历子项降级） */
  holidays: string[];
  /* 获客转化侧 */
  accounts: SocialAccountInfo[];
  contents: ContentRecord[];
  directMessages: DirectMessageRecord[];
  leads: LeadRecord[];
  /* GEO 能见度侧 */
  geoQueries: GeoQueryRecord[];
  geoAssets: GeoContentAsset[];
}

// ---------- 发现（输出） ----------

/** 证据记录引用：指向快照中的具体单据 */
export interface EvidenceRef {
  /** 证据类别：channel-price/room-day/order/bill-line/review/account/content/dm/lead/geo-query/geo-asset/hotel… */
  kind: string;
  id: string;
  /** 关键字段快照（审计留痕，原样透传） */
  fields?: Record<string, string | number>;
}

/** 计算过程快照：公式 + 输入 + 结果，报告可复算（SKILL.md 回执=计算过程快照） */
export interface CalculationSnapshot {
  formula: string;
  inputs: Record<string, number | string>;
  result: number | string;
}

/** 估算挽回（禁止把估算说成确定值——confidence 必填；计量单位见 ImpactUnit） */
export interface EstimatedImpact {
  amount: number;
  /** 计量单位：CNY/LEADS/FANS（字段名与电商版一致，语义为计量单位） */
  currency: ImpactUnit;
  period: ImpactPeriod;
  confidence: Confidence;
  /** 计算口径说明（如"近30天该渠道间夜 × 每间夜价差"） */
  basis: string;
}

export interface Finding {
  /** 引擎内唯一编号：FND-<线>-<序号> */
  id: string;
  line: AuditLine;
  severity: Severity;
  /** 归集门店（社媒/GEO 发现经账号挂属关系归集到门店） */
  hotelId: string;
  /** 触发主体（社媒发现=accountId；酒店侧发现省略） */
  subjectId?: string;
  title: string;
  /** 问题描述 + 建议动作 */
  description: string;
  suggestion: string;
  evidence: EvidenceRef[];
  calculation: CalculationSnapshot;
  estimatedImpact?: EstimatedImpact;
}

// ---------- 报告（输出） ----------

/** 一店一份 */
export interface HotelReport {
  hotelId: string;
  hotelName: string;
  currency: string;
  findings: Finding[];
  /** 按严重度计数 */
  counts: Record<Severity, number>;
  /** 该店估算挽回合计（按计量单位分桶，不跨单位相加） */
  totalRecoverableByUnit: Record<string, number>;
}

/** 集团总览 */
export interface GroupOverview {
  hotelCount: number;
  findingCount: number;
  counts: Record<Severity, number>;
  /** 按计量单位分桶的估算挽回合计（CNY/LEADS/FANS 不互相折算） */
  totalRecoverableByUnit: Record<string, number>;
}

export interface AuditReport {
  reportId: string;
  generatedAt: string;
  /** 快照引用（审计留痕） */
  snapshotId: string;
  /** 各线覆盖度（未覆盖的线在此标注，报告仍为有效部分报告） */
  coverage: Record<AuditLine, LineCoverage>;
  /** 覆盖度备注（如"GEO 快照缺失，geo 线未覆盖"） */
  coverageNotes: string[];
  hotels: HotelReport[];
  overview: GroupOverview;
  /** 按「流量→转化→成交」链路分组的发现（各组内按严重度+年化挽回降序） */
  chainGroups: Record<ChainStage, Finding[]>;
  /** 按年化挽回降序的 Top10 行动清单（集团视角；LEADS/FANS 以原值参与排序） */
  top10: Finding[];
  /** 实际耗时（毫秒）与软预算（分钟），时间纪律留痕 */
  elapsedMs: number;
  timeBudgetMinutes: number;
}

/** runFastScan 选项 */
export interface FastScanOptions {
  /** 软时间预算（分钟），默认 30；超时后剩余线标注 not-covered 出部分报告 */
  timeBudgetMinutes?: number;
  /** 报告锚定时间（默认取 snapshot.generatedAt；测试可注入固定钟） */
  now?: Date;
  /** 默认保底价（一店一档缺失时回退，默认 380，R2 口径） */
  floorPriceDefault?: number;
}
