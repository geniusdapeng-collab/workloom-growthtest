/**
 * 情报摘要卡「消费侧」回归（T-2026-0926-0115）
 *
 * 背景：六张摘要卡里只有 brief_card / theme_card 有真实消费者；
 * insight_card（受众/共识/差评地图）与 prd_card（演示场景/卖点证据/合规红线/钩子候选）
 * 从未进入下游提示词。本组测试锁定新证据块的四条纪律：
 *   ① 只搬运卡片字段；② 有界（默认 ≤600 字）；
 *   ③ 幂等（同卡同输出、带固定标记）；④ 无卡/空卡不产出（不编造）。
 */
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";

import { bundlesRoot } from "./assembly.js";

const require_ = createRequire(import.meta.url);
const VENDOR = join(dirname(bundlesRoot()), "vendor/supermickey/hyperreality-system");
const consumers = require_(join(VENDOR, "engines/data-mining-engine/card-consumers.js")) as {
  DOSSIER_EVIDENCE_MARKER: string;
  buildInsightEvidence: (cards: unknown, options?: { maxChars?: number }) => string;
  buildPrdEvidence: (cards: unknown, options?: { maxChars?: number }) => string;
  buildDossierEvidence: (cards: unknown, options?: { maxChars?: number }) => Array<{ card: string; marker: string; text: string }>;
  describeCardConsumption: () => Array<{ card: string; consumer: string; status: string }>;
};

const CARDS = {
  insight_card: {
    card: "insight_card",
    product: "星野空气循环扇",
    audience_profile: [
      { persona: "租房青年", scene: "卧室", moment: "夏夜", mentions: 12 },
      { persona: "母婴家庭", scene: "婴儿房", moment: "午睡", mentions: 7 },
    ],
    consensus_points: [{ point: "风感柔和", confidence: "confirmed", mentions: 9 }],
    complaint_map: [{ point: "App 注册繁琐", root_cause: "onboarding 太长", confidence: "reported", mentions: 5 }],
    market_position: { price_band: "399-499 元", our_opening: ["可拆洗网罩"] },
    competitor_briefs: [],
  },
  prd_card: {
    card: "prd_card",
    product: "星野空气循环扇",
    demo_scenes: [{ scene: "深夜卧室", persona: "租房青年", mentions: 12, suggest_fn: "demo" }],
    selling_point_evidence: [{ point: "风感柔和", nature: "user", confidence: "confirmed" }],
    compliance_redlines: ["不得宣称与「App 注册繁琐」相关的绝对化优势（用户有真实吐槽，宣称即翻车）"],
    hook_candidates: { data_points: ["6 小时续航"], conflicts: ["官方称静音 vs 用户吐槽夜间噪音"], questions: ["空调房还需要循环扇吗"] },
  },
};

describe("情报摘要卡消费侧 · 证据块", () => {
  it("① insight 证据包含受众/共识/差评/位势，且只来自卡片字段", () => {
    const text = consumers.buildInsightEvidence(CARDS);
    expect(text).toContain("租房青年");
    expect(text).toContain("风感柔和");
    expect(text).toContain("App 注册繁琐");
    expect(text).toContain("399-499 元");
    expect(text).toContain(consumers.DOSSIER_EVIDENCE_MARKER);
  });

  it("①′ prd 证据包含演示场景/卖点证据/合规红线/钩子候选", () => {
    const text = consumers.buildPrdEvidence(CARDS);
    expect(text).toContain("深夜卧室");
    expect(text).toContain("用户共识");
    expect(text).toContain("合规红线");
    expect(text).toContain("6 小时续航");
  });

  it("② 有界：默认单卡 ≤600 字，超长按字段截断", () => {
    const long = {
      insight_card: {
        ...CARDS.insight_card,
        consensus_points: Array.from({ length: 20 }, (_, i) => ({ point: `很长的用户共识第 ${i} 条`.repeat(3), confidence: "confirmed", mentions: i })),
      },
    };
    const text = consumers.buildInsightEvidence(long);
    expect(text.length).toBeLessThanOrEqual(600);
    const tiny = consumers.buildInsightEvidence(long, { maxChars: 80 });
    expect(tiny.length).toBeLessThanOrEqual(80);
  });

  it("③ 幂等与确定性：同输入两次结果一致", () => {
    const a = consumers.buildDossierEvidence(CARDS);
    const b = consumers.buildDossierEvidence(CARDS);
    expect(a).toEqual(b);
    expect(a.map((x) => x.card)).toEqual(["insight_card", "prd_card"]);
    expect(a.every((x) => x.marker === consumers.DOSSIER_EVIDENCE_MARKER)).toBe(true);
  });

  it("④ 无卡/空卡不产出（不编造）", () => {
    expect(consumers.buildDossierEvidence(null)).toEqual([]);
    expect(consumers.buildDossierEvidence({})).toEqual([]);
    expect(consumers.buildDossierEvidence({ insight_card: {}, prd_card: {} })).toEqual([]);
  });

  it("⑤ 消费矩阵如实标注：wired / wired-by-evidence-block / partial / unwired", () => {
    const matrix = consumers.describeCardConsumption();
    expect(matrix.map((m) => m.card)).toEqual([
      "brief_card", "theme_card", "insight_card", "prd_card", "portrait_manifest", "router_material",
    ]);
    expect(matrix.find((m) => m.card === "insight_card")?.status).toBe("wired-by-evidence-block");
    expect(matrix.find((m) => m.card === "prd_card")?.status).toBe("wired-by-evidence-block");
    expect(matrix.find((m) => m.card === "router_material")?.status).toBe("unwired");
  });
});
