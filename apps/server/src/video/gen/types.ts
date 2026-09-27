/**
 * video/gen/types.ts —— 视频生成接缝的公共类型（T-2026-0921-0002）
 *
 * 分层：
 *   ① 目录（catalog）：模型清单 + 供应商映射 + 档位 + 报价 + 参数能力（bundles/ai-video 资产）
 *   ② 供应商适配器（providers）：中立参数 → 各家 API 载荷；submit/poll/estimate
 *   ③ 成本（cost）：报价 → USD/CNY 预估与上限闸、完成后实际成本入账
 *   ④ 入库（ingest）：成片下载 + sha256 + asset-cms 注册 + 签名媒体 URL
 *   ⑤ 发布链（publish）：成片 → 发布任务（G9 预检）→ 执行器（dry-run / 桌面驱动）
 *
 * 纪律：供应商密钥只从环境变量读取（秘密不进文件/日志）；mock 与真实在数据与界面均明确区分。
 */

import { GenSubmissionError } from "@workloom/base/model-router";

/** 生成模态（本仓当前真实接入 video；image/audio 目录登记、按 availability 标注） */
export type MediaKind = "video" | "image" | "audio";

/**
 * 生成模式：文生/图生/参考图/视频生视频/唇形 + **本机合成渲染**（render）。
 * `render` 是本仓新增的档位：它不吃"文生视频"语义（提示词不是画面内容，而是数据层的口播稿摘要），
 * 由本地 Remotion provider（talkcraft 引擎）按分镜数据装配渲染——因此**不参与默认模型选择**，
 * 也不作为其他模型的降级备援（模式交集为空，天然隔离）。
 */
export type MediaMode = "t2v" | "i2v" | "r2v" | "v2v" | "t2i" | "i2i" | "lipsync" | "audio" | "render";

/** 档位（与 model-policy.yml 的 L1/L2/L3 同口径） */
export type MediaTier = "L1" | "L2" | "L3";

/** 参数能力位（中立口径；各 provider 自行翻译成自家字段名） */
export type ParamCapability =
  | "duration" | "aspectRatio" | "resolution" | "audio"
  | "firstFrame" | "references" | "seed" | "negativePrompt";

export interface ModelLimits {
  durationSec?: { min: number; max: number; default?: number };
  resolutions?: string[];
  aspectRatios?: string[];
  maxReferenceImages?: number;
  maxPromptChars?: number;
}

export interface ModelPricing {
  /** 计价单位：按秒（视频）/按张（图像）/按次（工具类） */
  unit: "second" | "image" | "request";
  /** 单价（USD）；null = 供应商未公开/未核价 → 预估缺失，UI 与闸门按"未核价"处理 */
  usd: number | null;
  /** 促销价标记（价目随促销波动，UI 提示"促销价"） */
  promo?: boolean;
  /** 核价日期（ISO 日期）；超过 30 天 UI 标"价格待核" */
  asOf: string;
  note?: string;
}

export interface MediaModel {
  /** 目录内唯一 id（我们的口径，不随供应商改名而变） */
  id: string;
  name: string;
  /** 供应商（与 providerId 对齐：seedance / higgsfield / kling / jimeng / muapi / seedream） */
  provider: string;
  /** 供应商侧模型 id / endpoint id（可由环境变量覆盖） */
  providerModel: string;
  kind: MediaKind;
  modes: MediaMode[];
  tier: MediaTier;
  supports: ParamCapability[];
  limits?: ModelLimits;
  pricing: ModelPricing | null;
  /** 供应商侧产物保留天数（决定"必须尽快入库"的紧迫度；null=未知） */
  retentionDays: number | null;
  /** wired=本仓已实现适配器；catalog-only=仅登记（选中时明确拒绝，不静默降级） */
  availability: "wired" | "catalog-only";
  docs?: string;
  /** 补充说明（端点未核实、计费口径等；UI 原样展示，避免把"未核实"说成"已支持"） */
  notes?: string;
}

export interface MediaCatalog {
  schemaVersion: "workloom.media-catalog/v1";
  generatedFrom?: Record<string, unknown>;
  models: MediaModel[];
}

/** 中立生成参数（提交入参；provider 适配器只取自己支持的位） */
export interface VideoGenParams {
  prompt?: string;
  durationSec?: number;
  aspectRatio?: string;
  resolution?: string;
  generateAudio?: boolean;
  firstFrameUrl?: string;
  referenceImageUrls?: string[];
  /** 视频参考（v2v/omni 参考任务；role 由调用方给出，默认 reference_video） */
  referenceVideoUrls?: string[];
  /** 音频参考（音频驱动口播；role 默认 reference_audio） */
  referenceAudioUrls?: string[];
  seed?: number;
  negativePrompt?: string;
  /** 平台是否加水印（默认 false：成片不应带平台水印） */
  watermark?: boolean;
  /** 机位是否固定（口播/棚拍镜头） */
  cameraFixed?: boolean;
  /** 返回尾帧（供下一镜 first_frame 接力） */
  returnLastFrame?: boolean;
  /** 服务档位：default | flex（flex 更低成本/更低优先级） */
  serviceTier?: "default" | "flex" | string;
  /** 排队优先级（数值，平台口径） */
  priority?: number;
  /** 任务执行过期时间（秒） */
  executionExpiresAfter?: number;
  /** 帧数口径（与 durationSec 二选一，平台口径） */
  frames?: number;
  /** 输出格式（平台口径，如 mp4） */
  outputFormat?: string;
  /** 完成回调（公网可达；本地开发留空走轮询） */
  callbackUrl?: string;
  /** 供应商特有的透传参数（目录 providerExtras 声明者才允许） */
  extra?: Record<string, unknown>;
}

export interface GenEstimate {
  modelId: string;
  provider: string;
  unit: "second" | "image" | "request";
  units: number;
  usd: number | null;
  cny: number | null;
  /** 报价缺失原因（usd=null 时说明） */
  note?: string;
  promo?: boolean;
  pricingAsOf?: string;
}

/** 供应商错误分类（统一失败语义；见 T-2026-0921-0002 §5.2 映射表） */
export type ProviderErrorKind =
  | "AUTH" | "CONCURRENCY" | "MODEL_UNAVAILABLE" | "RETRYABLE" | "MODERATION" | "PROVIDER_FAILED" | "BAD_REQUEST";

export class ProviderError extends GenSubmissionError {
  constructor(
    public readonly kind: ProviderErrorKind,
    message: string,
    public readonly status?: number,
    acceptance: "not-accepted" | "unknown" = ["AUTH", "CONCURRENCY", "MODERATION", "BAD_REQUEST"].includes(kind)
      ? "not-accepted" : "unknown",
  ) {
    super(message, acceptance, acceptance === "not-accepted" && ["AUTH", "MODEL_UNAVAILABLE", "RETRYABLE"].includes(kind));
    this.name = "ProviderError";
  }
}

/** 供应商返回体归一（submit/poll 共用） */
export interface GenTaskSnapshot {
  status: "submitted" | "running" | "succeeded" | "failed";
  uri?: string;
  actualUnits?: number;
  error?: string;
  raw?: unknown;
}
