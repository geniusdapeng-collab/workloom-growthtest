/**
 * video/gen/cost.ts —— 报价预估、上限闸与渲染成本入账（T-2026-0921-0002）
 *
 * 口径：
 *   · 报价来自模型目录（USD 单价 + 核价日期）；缺价=null（不臆造），提交前 UI 标注"未核价"。
 *   · CNY 折算用 VIDEO_USD_CNY_RATE（默认 7.2，可配置）；账本货币沿用系统 CNY 口径。
 *   · 上限闸：VIDEO_MONTHLY_CAP_CNY / VIDEO_DAILY_CAP_CNY（0 或未配置 = 不设上限）；
 *     预估超限即拒（PRECONDITION_FAILED），提示调额或换低成本模型——不静默放行。
 *   · 实际成本入账走 cost-ledger.recordCost（幂等键 render:<jobId>），行与事件同事务（D16）。
 */
import type { getAppPool, getGatewayPool } from "@workloom/db";
import { recordCost } from "@workloom/base/cost-ledger";
import type { GenEstimate, MediaModel } from "./types.js";
import { scopedQuery, type Scope } from "./db.js";

export function usdCnyRate(env: NodeJS.ProcessEnv = process.env): number {
  const raw = Number(env.VIDEO_USD_CNY_RATE ?? "7.2");
  return Number.isFinite(raw) && raw > 0 ? raw : 7.2;
}

export interface EstimateInput {
  /** 视频秒数（unit=second 时必填；默认取目录 limits.default） */
  seconds?: number;
  /** 图像张数（unit=image 时；默认 1） */
  images?: number;
}

/** 预估成本：按目录单价 × 计量单位；缺价时 usd/cny 为 null 并给出 note（UI 显式标注） */
export function estimateCost(model: MediaModel, input: EstimateInput = {}): GenEstimate {
  const pricing = model.pricing;
  const unit = pricing?.unit ?? (model.kind === "image" ? "image" : "second");
  const units = unit === "second"
    ? Math.max(1, Math.round(input.seconds ?? model.limits?.durationSec?.default ?? 5))
    : unit === "image"
      ? Math.max(1, Math.round(input.images ?? 1))
      : 1;
  if (!pricing || pricing.usd === null) {
    return {
      modelId: model.id, provider: model.provider, unit, units, usd: null, cny: null,
      note: pricing?.note ?? "供应商未公开单价（以控制台账单为准）",
      promo: pricing?.promo, pricingAsOf: pricing?.asOf,
    };
  }
  const usd = Math.round(pricing.usd * units * 10000) / 10000;
  const cny = Math.round(usd * usdCnyRate() * 100) / 100;
  return {
    modelId: model.id, provider: model.provider, unit, units, usd, cny,
    promo: pricing.promo, pricingAsOf: pricing.asOf, note: pricing.note,
  };
}

export interface CostCaps {
  dailyCapCny: number | null;
  monthlyCapCny: number | null;
}

export function costCaps(env: NodeJS.ProcessEnv = process.env): CostCaps {
  const read = (v?: string) => {
    const n = Number(v ?? "0");
    return Number.isFinite(n) && n > 0 ? n : null;
  };
  return { dailyCapCny: read(env.VIDEO_DAILY_CAP_CNY), monthlyCapCny: read(env.VIDEO_MONTHLY_CAP_CNY) };
}

export interface CapCheck {
  allowed: boolean;
  spentDayCny: number;
  spentMonthCny: number;
  estCny: number | null;
  caps: CostCaps;
  reason?: string;
  /** 放行但有保留（例：模型未核价，预估按 0 计可能低估） */
  warning?: string;
}

/** 上限闸：预估金额 + 已花 > 上限 → 拒绝（预估缺失时只按已花判断，并在 reason 里说明） */
export function checkCostCaps(args: {
  spentDayCny: number; spentMonthCny: number; estCny: number | null; caps: CostCaps;
}): CapCheck {
  const { spentDayCny, spentMonthCny, estCny, caps } = args;
  const capsConfigured = caps.monthlyCapCny !== null || caps.dailyCapCny !== null;
  const missingPrice = "该模型未核价：预估按 0 计，可能低估，请以供应商账单为准";
  const overMonth = caps.monthlyCapCny !== null && spentMonthCny + (estCny ?? 0) > caps.monthlyCapCny;
  const overDay = caps.dailyCapCny !== null && spentDayCny + (estCny ?? 0) > caps.dailyCapCny;
  if (overMonth || overDay) {
    const which = overMonth
      ? `本月渲染成本将达 ¥${(spentMonthCny + (estCny ?? 0)).toFixed(2)}，超过上限 ¥${caps.monthlyCapCny!.toFixed(2)}`
      : `今日渲染成本将达 ¥${(spentDayCny + (estCny ?? 0)).toFixed(2)}，超过上限 ¥${caps.dailyCapCny!.toFixed(2)}`;
    return {
      allowed: false, spentDayCny, spentMonthCny, estCny, caps,
      reason: `${which}${estCny === null ? `（${missingPrice}）` : ""}——请调高 VIDEO_MONTHLY_CAP_CNY / VIDEO_DAILY_CAP_CNY，或改用低成本档位`,
    };
  }
  return {
    allowed: true, spentDayCny, spentMonthCny, estCny, caps,
    ...(capsConfigured && estCny === null ? { warning: missingPrice } : {}),
  };
}

/** 本月/今日渲染成本（budget_ledger 投影；cost_kind='render'，按 occurred_at 归属） */
export async function renderSpendCny(app: ReturnType<typeof getAppPool>, scope: Scope): Promise<{ month: number; day: number }> {
  const rows = await scopedQuery<{ month: string | null; day: string | null }>(
    app, scope,
    `SELECT
       COALESCE(SUM(amount) FILTER (WHERE occurred_at >= date_trunc('month', now())), 0)::text AS month,
       COALESCE(SUM(amount) FILTER (WHERE occurred_at >= date_trunc('day', now())), 0)::text AS day
     FROM budget_ledger
     WHERE workspace_id = $1 AND cost_kind = 'render'`,
    [scope.workspaceId],
  );
  return { month: Number(rows[0]?.month ?? 0), day: Number(rows[0]?.day ?? 0) };
}

export interface RenderCostInput {
  jobId: string;
  projectId?: string | null;
  shotId?: string | null;
  amountCny: number;
  usd?: number | null;
  provider: string;
  providerModel: string;
  seconds?: number | null;
  mock?: boolean;
  by: string;
}

/** 渲染成本入账（幂等键 render:<jobId>；mock 单入 0 元账并标注，不污染真实成本口径） */
export async function recordRenderCost(
  app: ReturnType<typeof getAppPool>,
  gateway: ReturnType<typeof getGatewayPool>,
  scope: Scope,
  input: RenderCostInput,
): Promise<{ deduped: boolean; amount: number }> {
  const amount = input.mock ? 0 : Math.round(input.amountCny * 100) / 100;
  const r = await recordCost(app, gateway, scope, {
    projectId: input.projectId ?? undefined,
    shotId: input.shotId ?? undefined,
    costKind: "render",
    amount,
    currency: "CNY",
    idempotencyKey: `render:${input.jobId}`,
    meta: {
      jobId: input.jobId, provider: input.provider, providerModel: input.providerModel,
      usd: input.usd ?? null, seconds: input.seconds ?? null, mock: Boolean(input.mock),
    },
    by: input.by,
  });
  return { deduped: r.deduped, amount };
}
