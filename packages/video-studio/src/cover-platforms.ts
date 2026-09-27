/**
 * cover-platforms —— 封面平台规格注册表（**封面侧唯一事实源**）。
 *
 * 背景：封面链路此前只有 9:16 单一口径（1080×1920、标题带 6%–42%、底部 12%），
 * 平台差异全部硬编码在 `cover-design.ts` 与 `scripts/tools/full-chain-film.mts`。
 * 本模块把 8 个平台的画幅/安全区/标题带/文案政策/钩子风格做成注册表，
 * 两条链路一律从这里取数（调用方不得再写字面量）。
 *
 * 上游事实源（换算依据同步见 docs/cover-platformization.md）：
 *   `vendor/supermickey/hyperreality-system/config/platform-profiles.js` 的 `safeArea`
 *   px 值 ÷ 画布高/宽 = 比例。**px 原文登记在 `COVER_PLATFORM_VENDOR_SOURCES`**，
 *   `cover-platforms.test.ts` 会直接读 vendor 文件逐项比对（漂移即红）——
 *   这样"本表"与"vendor 蓝图"不会各说各话。
 *
 * 回归基线（硬约束）：`getCoverSpec("douyin")` 必须与 `cover-design.ts` 既有
 * `COVER_SAFE_AREA`（0.06 / 0.42 / 0.12）和 1080×1920 完全一致——有单测锁死。
 * 抖音口径来自本链路真机验证（底部 12%），不随 vendor 的 `bottomPx: 320`（≈16.7%，
 * 那是"成片安全区"口径）改动；差异在 `vendorNote` 里写明。
 */

export interface CoverPlatformSpec {
  /** 平台 ID（小写连字符） */
  id: string;
  /** 中文/英文展示名 */
  name: string;
  /** 画幅描述（如 "9:16"） */
  ratio: string;
  /** 画幅方向：竖屏 / 横版（渲染取帧与排版分叉用） */
  orientation: "vertical" | "horizontal";
  /** 封面画布像素尺寸 */
  canvas: { width: number; height: number };
  /**
   * 安全区（比例口径，相对画布高/宽）：
   *   topMinRatio         顶部留白下限：标题不得贴顶
   *   bottomReservedRatio 底部平台 UI 遮挡区：不放任何文字
   *   rightRailRatio      右侧操作栏遮挡（相对画布宽；无右侧栏的平台为 0）
   */
  safeArea: { topMinRatio: number; bottomReservedRatio: number; rightRailRatio: number };
  /** 标题带（比例，相对画布高）：主标题必须落在 [topRatio, bottomMaxRatio] */
  titleBand: { topRatio: number; bottomMaxRatio: number };
  /** 封面标题语言 */
  language: "zh" | "en";
  /** 主标题上限：中文按视觉字符数，英文按**词数** */
  headlineMaxChars: number;
  /** 该平台吃香的封面钩子风格（与 KB `HOOK-001` 公式 ID 对应） */
  hookStyles: string[];
  /** 平台文案调性（进 prompt 的 copyTone） */
  copyTone: string;
  /** 平台特殊机制/备注（进 prompt 的提示，如三连封面、横版 CTR 法则） */
  notes: string;
  /** 与 vendor 蓝图的口径差异说明（为空表示与本表一致） */
  vendorNote?: string;
}

export const COVER_PLATFORMS: Record<string, CoverPlatformSpec> = {
  /**
   * 抖音 —— 回归基线。数值 = 链路既有硬编码口径（COVER_SAFE_AREA），
   * 真机验证过的 12% 底部口径**不随 vendor 的 320px（16.7%）调整**。
   */
  douyin: {
    id: "douyin",
    name: "抖音",
    ratio: "9:16",
    orientation: "vertical",
    canvas: { width: 1080, height: 1920 },
    safeArea: { topMinRatio: 0.06, bottomReservedRatio: 0.12, rightRailRatio: 0.11 },
    titleBand: { topRatio: 0.06, bottomMaxRatio: 0.42 },
    language: "zh",
    headlineMaxChars: 12,
    hookStyles: ["question", "conflict", "data-shock", "contrast"],
    copyTone: "大字强钩子，节奏快信息密，钩子直接不绕弯",
    notes: "底部约 12% 被平台文案区遮挡；右侧 11% 操作栏区域避免放关键信息",
    vendorNote: "vendor bottomPx 320（≈16.7%）是成片安全区口径；封面沿用本链路真机验证的 12%"
  },
  /** 快手：bottomPx 320/1920≈0.167、rightRail 120/1080≈0.111、top 120/1920=0.0625 */
  kuaishou: {
    id: "kuaishou",
    name: "快手",
    ratio: "9:16",
    orientation: "vertical",
    canvas: { width: 1080, height: 1920 },
    safeArea: { topMinRatio: 0.06, bottomReservedRatio: 0.17, rightRailRatio: 0.11 },
    titleBand: { topRatio: 0.06, bottomMaxRatio: 0.42 },
    language: "zh",
    headlineMaxChars: 12,
    hookStyles: ["question", "conflict", "data-shock"],
    copyTone: "老铁式真实口语，强信任背书，忌精致过度",
    notes: "封面宁'糙'勿'假'：过度精修的广告感封面在快手 CTR 反而低"
  },
  /** 小红书：3:4 画幅；bottomPx 240/1440≈0.167、top 100/1440≈0.069、无右侧栏 */
  xiaohongshu: {
    id: "xiaohongshu",
    name: "小红书",
    ratio: "3:4",
    orientation: "vertical",
    canvas: { width: 1080, height: 1440 },
    safeArea: { topMinRatio: 0.07, bottomReservedRatio: 0.17, rightRailRatio: 0 },
    titleBand: { topRatio: 0.07, bottomMaxRatio: 0.45 },
    language: "zh",
    headlineMaxChars: 14,
    hookStyles: ["aesthetic", "value-preview", "contrast"],
    copyTone: "审美先行，价值预览式文案，弱化硬广",
    notes: "双列信息流场景：封面在列表里只有约 1/4 屏宽，字必须更大更聚焦；流行花字/拼图/对比版式"
  },
  /** 视频号：bottomPx 300/1920≈0.156→0.16、top 120/1920=0.0625 */
  "wechat-channels": {
    id: "wechat-channels",
    name: "微信视频号",
    ratio: "9:16",
    orientation: "vertical",
    canvas: { width: 1080, height: 1920 },
    safeArea: { topMinRatio: 0.06, bottomReservedRatio: 0.16, rightRailRatio: 0.11 },
    titleBand: { topRatio: 0.06, bottomMaxRatio: 0.42 },
    language: "zh",
    headlineMaxChars: 12,
    hookStyles: ["question", "value-preview", "conflict"],
    copyTone: "熟人社交语境，真实分享感，克制不硬广",
    notes: "中老年用户占比高：字级建议取区间上限，避免细瘦字体"
  },
  /** B站横版：16:9；bottomPx 90/1080≈0.083→0.09（进度条）、top 60/1080≈0.056→0.06 */
  bilibili: {
    id: "bilibili",
    name: "B站（哔哩哔哩）",
    ratio: "16:9",
    orientation: "horizontal",
    canvas: { width: 1920, height: 1080 },
    safeArea: { topMinRatio: 0.06, bottomReservedRatio: 0.09, rightRailRatio: 0 },
    titleBand: { topRatio: 0.06, bottomMaxRatio: 0.55 },
    language: "zh",
    headlineMaxChars: 16,
    hookStyles: ["question", "value-preview", "data-shock"],
    copyTone: "社区语境，信息密度高，允许梗化表达，忌硬广口吻",
    notes: "横版缩略图在信息流中占比小：主体居中放大、标题靠左大字；系列视频保持模板一致"
  },
  /** TikTok：safeArea 同抖音的 px 口径（bottom 320/1920≈0.167、right 120/1080≈0.111） */
  tiktok: {
    id: "tiktok",
    name: "TikTok",
    ratio: "9:16",
    orientation: "vertical",
    canvas: { width: 1080, height: 1920 },
    safeArea: { topMinRatio: 0.06, bottomReservedRatio: 0.17, rightRailRatio: 0.11 },
    titleBand: { topRatio: 0.06, bottomMaxRatio: 0.42 },
    language: "en",
    headlineMaxChars: 5, // 英文按词数：≤5 词
    hookStyles: ["pattern-interrupt", "question", "data-shock", "contrast"],
    copyTone: "原生感英文短句，口语化，弱化广告感",
    notes: "英文标题全大写 + 高对比描边是主流；前 2 秒首帧即封面场景多，封面与首帧钩子需一致"
  },
  /**
   * YouTube：横版缩略图 16:9（Shorts 复用 9:16 竖屏规格，走 tiktok 口径）。
   * vendor 蓝图未覆盖 YouTube，安全区按平台缩略图规则标定（右下角时长角标区、5% 顶带）。
   */
  youtube: {
    id: "youtube",
    name: "YouTube",
    ratio: "16:9",
    orientation: "horizontal",
    canvas: { width: 1920, height: 1080 },
    safeArea: { topMinRatio: 0.05, bottomReservedRatio: 0.08, rightRailRatio: 0 },
    titleBand: { topRatio: 0.05, bottomMaxRatio: 0.6 },
    language: "en",
    headlineMaxChars: 5,
    hookStyles: ["curiosity-gap", "contrast", "data-shock", "face-closeup"],
    copyTone: "CTR 驱动：curiosity gap + 高对比 + 表情特写，标题 ≤5 词",
    notes: "缩略图与标题互补不重复；右下角时长角标区（约 12%×8%）避免放关键元素；小尺寸可辨性优先",
    vendorNote: "vendor 蓝图未收录 YouTube，规格来自封面侧标定（PLAT-006）"
  },
  /** Instagram Reels：bottomPx 280/1920≈0.146→0.15 */
  "instagram-reels": {
    id: "instagram-reels",
    name: "Instagram Reels",
    ratio: "9:16",
    orientation: "vertical",
    canvas: { width: 1080, height: 1920 },
    safeArea: { topMinRatio: 0.06, bottomReservedRatio: 0.15, rightRailRatio: 0.11 },
    titleBand: { topRatio: 0.06, bottomMaxRatio: 0.42 },
    language: "en",
    headlineMaxChars: 4,
    hookStyles: ["aesthetic-first-frame", "pattern-interrupt"],
    copyTone: "aesthetic 首帧美学，英文短句，克制收尾",
    notes: "Reels 封面同时用于主页网格（1:1 居中裁切）：构图需保证中心 1:1 区域独立成立"
  }
};

/**
 * vendor 蓝图原文 px（唯一上游事实源）——供 `cover-platforms.test.ts` 直接读
 * `vendor/supermickey/hyperreality-system/config/platform-profiles.js` 逐项比对。
 * 本表只是"对照索引"，规格数值仍以 `COVER_PLATFORMS` 为准。
 */
export const COVER_PLATFORM_VENDOR_SOURCES: Record<string, {
  vendorKey: string;
  topPx: number;
  bottomPx: number;
  rightRailPx: number;
  /** px → 比例用的基准：顶部/底部按画布高，右侧栏按画布宽 */
  canvas: { width: number; height: number };
}> = {
  douyin: { vendorKey: "douyin", topPx: 120, bottomPx: 320, rightRailPx: 120, canvas: { width: 1080, height: 1920 } },
  kuaishou: { vendorKey: "kuaishou", topPx: 120, bottomPx: 320, rightRailPx: 120, canvas: { width: 1080, height: 1920 } },
  xiaohongshu: { vendorKey: "xiaohongshu", topPx: 100, bottomPx: 240, rightRailPx: 0, canvas: { width: 1080, height: 1440 } },
  "wechat-channels": { vendorKey: "wechat-channels", topPx: 120, bottomPx: 300, rightRailPx: 120, canvas: { width: 1080, height: 1920 } },
  bilibili: { vendorKey: "bilibili", topPx: 60, bottomPx: 90, rightRailPx: 0, canvas: { width: 1920, height: 1080 } },
  tiktok: { vendorKey: "tiktok", topPx: 120, bottomPx: 320, rightRailPx: 120, canvas: { width: 1080, height: 1920 } },
  "instagram-reels": { vendorKey: "instagram-reels", topPx: 120, bottomPx: 280, rightRailPx: 120, canvas: { width: 1080, height: 1920 } }
};

/** 中文名/别名 → 平台 ID（兼容旧调用里"抖音/快手"这类中文透传） */
export const PLATFORM_ALIASES: Record<string, string> = {
  "抖音": "douyin",
  /** full-chain-film 的历史默认值就是"抖音/快手"（一个透传串），按抖音口径解析 */
  "抖音/快手": "douyin",
  "快手": "kuaishou",
  "小红书": "xiaohongshu",
  "视频号": "wechat-channels",
  "微信视频号": "wechat-channels",
  "B站": "bilibili",
  "哔哩哔哩": "bilibili",
  "b站": "bilibili",
  "油管": "youtube",
  "ins": "instagram-reels",
  "ig": "instagram-reels",
  "reels": "instagram-reels"
};

export const DEFAULT_COVER_PLATFORM = "douyin";

/**
 * 取平台规格：未知/缺省平台一律落 douyin（不抛错，保证旧调用零影响）。
 * 支持平台 ID（`douyin`）与中文别名（`抖音`/`抖音/快手`）两种入参。
 */
export function getCoverSpec(platform?: string | null): CoverPlatformSpec {
  if (!platform) return COVER_PLATFORMS[DEFAULT_COVER_PLATFORM]!;
  const raw = String(platform).trim();
  const key = raw.toLowerCase();
  const direct = COVER_PLATFORMS[key];
  if (direct) return direct;
  const alias = PLATFORM_ALIASES[raw] ?? PLATFORM_ALIASES[key];
  if (alias && COVER_PLATFORMS[alias]) return COVER_PLATFORMS[alias]!;
  console.warn(`[cover-platforms] 未知平台 "${platform}"，按 ${DEFAULT_COVER_PLATFORM} 口径处理`);
  return COVER_PLATFORMS[DEFAULT_COVER_PLATFORM]!;
}

/** 平台是否已登记（用于 CLI 校验与"未登记平台"提示，不触发 warn） */
export function isKnownCoverPlatform(platform?: string | null): boolean {
  if (!platform) return true;
  const raw = String(platform).trim();
  return Boolean(COVER_PLATFORMS[raw.toLowerCase()] ?? PLATFORM_ALIASES[raw] ?? PLATFORM_ALIASES[raw.toLowerCase()]);
}

/** 全部平台 ID（供 CLI 校验与测试遍历） */
export const COVER_PLATFORM_IDS = Object.keys(COVER_PLATFORMS);

/** 英文平台（标题按词数计），其余按中文视觉字数计 */
export const isEnglishCoverPlatform = (spec: CoverPlatformSpec): boolean => spec.language === "en";

/**
 * 标题长度口径（与 `validateCoverPlan` 一致）：
 *   中文平台 = 视觉字数（去掉换行后逐字计，数字/半角按 1 计——严格口径，宁可多报超标）；
 *   英文平台 = 词数（空格切分）。
 */
export function headlineUnits(text: string, spec: CoverPlatformSpec): number {
  const raw = String(text ?? "");
  if (isEnglishCoverPlatform(spec)) {
    return raw.split(/\s+/).map((w) => w.trim()).filter(Boolean).length;
  }
  return [...raw.replace(/\n/g, "")].length;
}

/** 标题长度上限的人话描述（进 prompt 与错误信息） */
export function headlineLimitLabel(spec: CoverPlatformSpec): string {
  return isEnglishCoverPlatform(spec)
    ? `≤${spec.headlineMaxChars} 个英文单词（全大写，介词能省则省）`
    : `≤${spec.headlineMaxChars} 个字`;
}

/** 比例 → 百分比整数文本（6% / 12% / 17%），用于 prompt 与机检明细 */
export const ratioPercent = (ratio: number): string => `${(ratio * 100).toFixed(0)}%`;
