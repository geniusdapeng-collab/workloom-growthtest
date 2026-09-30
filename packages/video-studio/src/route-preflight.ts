/**
 * route-preflight.ts —— 「先判视频类型再出片」的 CLI 入口硬约束（T-2026-0930-0015）
 *
 * 背景（2026-09-30 真机复盘）：
 *   分流器 `pipeline-router.ts`（2026-09-25）此前只接在**服务端派活**（apps/server/src/video/router.ts、
 *   apps/server/src/trpc/router.ts）。AI agent / 交付同学是直接跑 `scripts/tools/full-chain-film.mts` 的，
 *   于是会**跳过"先判营销片 / 叙事片"**这一步：营销片该有的商品锚点、情报层与 G1 门被绕开，
 *   判不准时也不会向用户澄清（"走错管线 = 花钱做了用户不想要的片子"）。
 *
 * 本模块把"必须有分流结论"变成出片 CLI 的 **fail-closed 前置检查**：
 *   · 先跑 `scripts/tools/route-video.mts --out work/route.json`，再用 `--route work/route.json` 出片；
 *   · 已确认过的项目补跑可用 `--route-kind marketing|narrative` 显式声明（同样写进阶段记录与交付清单）；
 *   · 营销片缺商品锚点 → 拒绝（纪律：**不猜商品**；商品名只来自显式声明 / metadata / 模型抽取）。
 *   explainer（口播解说片）不走这条执行器，报错时直接给出 `pnpm explainer:run` 的正确入口。
 *
 * 本模块是纯函数（不读文件、不打点），文件读取与留痕由 CLI 负责。
 */

export const ROUTE_RECORD_SCHEMA = "workloom.video-route-record/v1" as const;

export type RoutePreflightKind = "marketing" | "narrative";
export type RoutePreflightSource = "route-file" | "explicit";

export type RoutePreflightErrorCode =
  | "ROUTE_REQUIRED"
  | "ROUTE_FILE_INVALID"
  | "ROUTE_CLARIFY"
  | "ROUTE_KIND_UNSUPPORTED"
  | "MARKETING_PRODUCT_ANCHOR_MISSING";

export class RoutePreflightError extends Error {
  constructor(readonly code: RoutePreflightErrorCode, message: string) {
    super(message);
    this.name = "RoutePreflightError";
  }
}

export interface RouteRecordDecision {
  route?: unknown;
  confidence?: unknown;
  via?: unknown;
  rationale?: unknown;
  product?: unknown;
  clarify?: { question?: unknown; options?: unknown } | null;
}

export interface RouteRecord {
  schemaVersion?: unknown;
  title?: unknown;
  cleanedIntent?: unknown;
  decision?: RouteRecordDecision;
}

export interface RoutePreflightResult {
  kind: RoutePreflightKind;
  source: RoutePreflightSource;
  /** 商品锚点显示名（营销片必需；叙事片可为空） */
  productAnchor: string | null;
  notes: string[];
  record: RouteRecord | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nonEmpty(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

/**
 * 商品锚点识别（只认显式声明，**不猜**）：
 *   ① brief.product（字符串，或 `{ name }`）；② brief.products[]；③ shotlist.products[]；
 *   ④ 镜头卡 `shots[].productRef`（字符串或 `{ name | id }`）。
 * 返回可读名称（找不到一律 null，由调用方按"营销片缺锚点"拒绝）。
 */
export function detectProductAnchor(input: { brief?: unknown; shotlist?: unknown }): string | null {
  const fromProduct = (value: unknown): string | null => {
    if (nonEmpty(value)) return nonEmpty(value);
    if (isRecord(value)) return nonEmpty(value.name) ?? nonEmpty(value.id) ?? nonEmpty(value.title);
    return null;
  };
  const fromList = (value: unknown): string | null => {
    if (!Array.isArray(value)) return null;
    for (const entry of value) {
      const hit = fromProduct(entry);
      if (hit) return hit;
    }
    return null;
  };

  if (isRecord(input.brief)) {
    const direct = fromProduct(input.brief.product);
    if (direct) return direct;
    const list = fromList(input.brief.products);
    if (list) return list;
    /** 兼容 `brief.brand = { name }` + `brief.product = { name }` 之外的旧形态：`brief.productName` */
    const legacy = nonEmpty(input.brief.productName);
    if (legacy) return legacy;
  }
  if (isRecord(input.shotlist)) {
    const list = fromList(input.shotlist.products);
    if (list) return list;
    const shots = Array.isArray(input.shotlist.shots) ? input.shotlist.shots : [];
    for (const shot of shots) {
      if (!isRecord(shot)) continue;
      const hit = fromProduct(shot.productRef);
      if (hit) return hit;
    }
  }
  return null;
}

/** 出片入口的 fail-closed 分流检查（纯函数；文件读取与阶段留痕由 CLI 负责） */
export function resolveRoutePreflight(input: {
  /** `--route <route.json>` 解析后的对象（未传则 undefined） */
  routeRecord?: unknown;
  /** `--route-kind marketing|narrative`（已确认过的补跑项目） */
  routeKind?: string;
  /** `detectProductAnchor()` 的结果 */
  productAnchor: string | null;
}): RoutePreflightResult {
  const notes: string[] = [];
  const explicitKind = (input.routeKind ?? "").trim();
  let kind: RoutePreflightKind;
  let source: RoutePreflightSource;
  let record: RouteRecord | null = null;

  if (explicitKind) {
    if (explicitKind === "explainer") {
      throw new RoutePreflightError("ROUTE_KIND_UNSUPPORTED",
        "explainer（口播解说片）不走 full-chain-film：请用 `pnpm explainer:run -- --script <稿> --profile <音色档>`（见 bundles/ai-video/README.md §2）。");
    }
    if (explicitKind !== "marketing" && explicitKind !== "narrative") {
      throw new RoutePreflightError("ROUTE_KIND_UNSUPPORTED",
        `--route-kind 只支持 marketing | narrative（收到：${explicitKind}）；口播解说片请用 pnpm explainer:run。`);
    }
    kind = explicitKind;
    source = "explicit";
    notes.push("分流来源：显式声明（--route-kind）。已确认过的项目补跑可以这样走，但结论会写进阶段记录与交付清单。");
  } else if (input.routeRecord !== undefined) {
    if (!isRecord(input.routeRecord)) {
      throw new RoutePreflightError("ROUTE_FILE_INVALID", "--route 指向的不是合法 JSON 对象；请用 scripts/tools/route-video.mts --out 生成。");
    }
    record = input.routeRecord as RouteRecord;
    if (record.schemaVersion !== ROUTE_RECORD_SCHEMA) {
      throw new RoutePreflightError("ROUTE_FILE_INVALID",
        `分流记录 schema 不匹配（期望 ${ROUTE_RECORD_SCHEMA}，收到 ${String(record.schemaVersion ?? "(缺)")}）；请重新跑 scripts/tools/route-video.mts。`);
    }
    const decision = isRecord(record.decision) ? record.decision as RouteRecordDecision : null;
    const route = decision ? decision.route : undefined;
    if (route === "clarify") {
      const question = isRecord(decision?.clarify) ? nonEmpty((decision!.clarify as Record<string, unknown>).question) : null;
      throw new RoutePreflightError("ROUTE_CLARIFY",
        `分流结论是"判不准，先问用户"${question ? `：${question}` : ""}。请先与用户确认视频类型（营销片 / 叙事片）与商品锚点，再出片——不要替用户花钱。`);
    }
    if (route === "explainer") {
      throw new RoutePreflightError("ROUTE_KIND_UNSUPPORTED",
        "分流结论是口播解说片（explainer）：请用 `pnpm explainer:run -- --script <稿> --profile <音色档>`，不要走 full-chain-film。");
    }
    if (route !== "marketing" && route !== "narrative") {
      throw new RoutePreflightError("ROUTE_FILE_INVALID",
        `分流记录里没有可用的 decision.route（收到：${String(route ?? "(缺)")}）；请重新跑 scripts/tools/route-video.mts。`);
    }
    kind = route;
    source = "route-file";
    notes.push(`分流来源：route 记录（confidence=${String(decision?.confidence ?? "?")}，via=${String(decision?.via ?? "?")}）`);
  } else {
    throw new RoutePreflightError("ROUTE_REQUIRED",
      [
        "出片前必须先判视频类型（营销片 / 叙事片 / 口播解说片）——本入口要求分流结论，拒绝无类型直接出片。",
        "先跑：pnpm exec tsx scripts/tools/route-video.mts --title \"<用户需求原文>\" --llm --out work/route.json",
        "再跑：在本命令上加 --route work/route.json",
        "已确认过的补跑项目：用 --route-kind marketing|narrative 显式声明（留痕）；口播解说片请用 pnpm explainer:run。",
      ].join("\n　　"));
  }

  if (kind === "marketing") {
    if (!input.productAnchor) {
      throw new RoutePreflightError("MARKETING_PRODUCT_ANCHOR_MISSING",
        [
          "营销片缺少商品锚点（纪律：不猜商品；商品名只来自用户显式声明 / metadata / 模型抽取）。",
          "请在分流时带上：scripts/tools/route-video.mts ... --product \"<商品名>\" [--brand \"<品牌>\"]，",
          "或把商品写进 brief（brief.product / brief.products[]）或 shotlist（products[] / shots[].productRef）。",
        ].join("\n　　"));
    }
    notes.push(`商品锚点：${input.productAnchor}（营销片必需，G-PROD1 会逐镜校验真实商品绑定）`);
  }

  return { kind, source, productAnchor: input.productAnchor, notes, record };
}
