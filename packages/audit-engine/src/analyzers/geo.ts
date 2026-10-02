/**
 * 获客转化线·GEO 可见度缺口（fast-scan SKILL.md 步骤 6；获客系统特有检项）
 * 三个子项：
 *  1) 目标关键词 AI 搜索无引用：query 集中 mentioned=false 的目标词
 *     （P0 品牌词缺席升 P1——AI 搜索入口完全断流；品类词缺席 P2）
 *  2) 竞对被引己方缺席：同一 query 下 competitorsCited 非空且我方未提及
 *     （品类词 P1——需求被竞对截流；品牌词被竞对截流升 P0，疑似品牌词被截胡）
 *  3) 内容结构不利于引用：GEO 内容资产无 FAQ 块 / 无结构化数据（JSON-LD）
 *     （聚合 P2——AI 答案引用亲和度低，引用源建设清单）
 * 降级纪律：geoQueries 为空 → 整线 not-covered；geoAssets 为空 → 子项 3 跳过（engine 标 partial）。
 * 口径锚点：geo-growth-baseline（能见度监测/引用源建设纪律；G-GEO 灰帽零容忍——本线只诊断不优化）。
 */
import type { AuditSnapshot, Finding } from "../types.js";
import { makeFinding, type AnalyzerContext } from "./util.js";

/** 竞对截流的线索分流经验系数：每个被截流品类 query 按 2 条/月线素流失估算 */
export const HIJACK_LEAD_MONTHLY = 2;
/** 品牌词缺席的线索断流经验系数：每个 P0 品牌词按 3 条/月估算 */
export const BRAND_ABSENT_LEAD_MONTHLY = 3;

export function analyzeGeo(snapshot: AuditSnapshot, ctx: AnalyzerContext): Finding[] {
  void ctx;
  const findings: Finding[] = [];
  const hotelById = new Map(snapshot.hotels.map((h) => [h.hotelId, h]));
  const nameOf = (hotelId: string) => hotelById.get(hotelId)?.hotelName ?? hotelId;

  /* ---------- 子项 1：目标关键词 AI 搜索无引用 ---------- */
  for (const q of snapshot.geoQueries) {
    if (q.mentioned) continue;
    const isBrandP0 = q.type === "brand" && q.priority === "P0";
    findings.push(
      makeFinding({
        line: "geo",
        severity: isBrandP0 ? "P1" : "P2",
        hotelId: q.hotelId,
        title: `GEO 可见度缺口：「${q.query}」AI 搜索未引用我方（${nameOf(q.hotelId)}）`,
        description: `目标${q.type === "brand" ? "品牌" : "品类"}词「${q.query}」（${q.priority}${q.platform ? ` / ${q.platform}` : ""}）的 AI 答案中我方零提及——该入口的获客流量完全断流。`,
        suggestion: `按 geo-query-craft 口径补建该 query 的答案型内容（六段式+FAQ 块），并同步引用源平台（知乎/百科/官网结构化页）。`,
        evidence: [{ kind: "geo-query", id: q.query, fields: { type: q.type, priority: q.priority, mentioned: 0, ...(q.platform ? { platform: q.platform } : {}) } }],
        calculation: {
          formula: "目标 query mentioned = false",
          inputs: { query: q.query, type: q.type, priority: q.priority },
          result: "未提及",
        },
        ...(isBrandP0
          ? {
              estimatedImpact: {
                amount: BRAND_ABSENT_LEAD_MONTHLY,
                currency: "LEADS" as const,
                period: "monthly" as const,
                confidence: "estimate" as const,
                basis: `P0 品牌词 AI 入口断流 × ${BRAND_ABSENT_LEAD_MONTHLY} 条/月线索（经验估计）`,
              },
            }
          : {}),
      }),
    );
  }

  /* ---------- 子项 2：竞对被引己方缺席 ---------- */
  for (const q of snapshot.geoQueries) {
    if (q.mentioned || q.competitorsCited.length === 0) continue;
    const brandHijack = q.type === "brand";
    findings.push(
      makeFinding({
        line: "geo",
        severity: brandHijack ? "P0" : "P1",
        hotelId: q.hotelId,
        title: `GEO 竞对截流：「${q.query}」竞对 ${q.competitorsCited.join("/")} 被引用，我方缺席`,
        description: `AI 答案在「${q.query}」下引用了 ${q.competitorsCited.length} 家竞对（${q.competitorsCited.join("、")}）而我方未被提及——${
          brandHijack ? "品牌词被竞对截胡，疑似竞对内容占位/实体混淆，最高优先处置" : "品类需求在 AI 入口被竞对截流"
        }。`,
        suggestion: brandHijack
          ? "核查品牌实体一致性（entity-consistency-check），对截流答案做引用源反查（citation-reverse），用权威信源纠正实体口径。"
          : "对该 query 做引用源反查（citation-reverse），定位竞对被引页面结构，产出同题更优答案型内容。",
        evidence: [{ kind: "geo-query", id: q.query, fields: { type: q.type, competitors: q.competitorsCited.join("/"), mentioned: 0 } }],
        calculation: {
          formula: "competitorsCited ≥ 1 且 mentioned = false",
          inputs: { query: q.query, type: q.type, competitorCount: q.competitorsCited.length },
          result: `竞对 ${q.competitorsCited.length} 家被引 / 我方 0`,
        },
        estimatedImpact: {
          amount: HIJACK_LEAD_MONTHLY * (brandHijack ? 2 : 1),
          currency: "LEADS",
          period: "monthly",
          confidence: "estimate",
          basis: `被截流 query × ${HIJACK_LEAD_MONTHLY} 条/月线索${brandHijack ? " × 2（品牌词截胡加倍）" : ""}（经验估计）`,
        },
      }),
    );
  }

  /* ---------- 子项 3：内容结构不利于引用（无 FAQ 块 / 无结构化数据） ---------- */
  const byHotel = new Map<string, { noFaq: string[]; noLd: string[] }>();
  for (const a of snapshot.geoAssets) {
    if (a.hasFaqBlock && a.hasStructuredData) continue;
    const e = byHotel.get(a.hotelId) ?? { noFaq: [], noLd: [] };
    if (!a.hasFaqBlock) e.noFaq.push(a.assetId);
    if (!a.hasStructuredData) e.noLd.push(a.assetId);
    byHotel.set(a.hotelId, e);
  }
  for (const [hotelId, e] of byHotel) {
    const affected = new Set([...e.noFaq, ...e.noLd]).size;
    findings.push(
      makeFinding({
        line: "geo",
        severity: "P2",
        hotelId,
        title: `GEO 引用亲和度低：${affected} 个内容资产缺 FAQ 块/结构化数据（${nameOf(hotelId)}）`,
        description: `缺 FAQ 块 ${e.noFaq.length} 个、缺结构化数据（JSON-LD）${e.noLd.length} 个——AI 爬虫难以抽取答案片段，同样内容被引用概率显著低于结构化竞对页面。`,
        suggestion: "按 ai-answer-rewrite 口径为TOP落地页补 FAQ 块（问句小标题+简答）与 JSON-LD（Hotel/FAQPage schema），优先覆盖高流量页面。",
        evidence: [
          ...e.noFaq.slice(0, 3).map((id) => ({ kind: "geo-asset", id, fields: { missing: "faq-block" } })),
          ...e.noLd.slice(0, 3).map((id) => ({ kind: "geo-asset", id, fields: { missing: "structured-data" } })),
        ],
        calculation: {
          formula: "hasFaqBlock = false ∨ hasStructuredData = false 的资产计数",
          inputs: { noFaq: e.noFaq.length, noStructuredData: e.noLd.length, affected },
          result: `${affected} 个资产待结构化`,
        },
      }),
    );
  }

  return findings;
}
