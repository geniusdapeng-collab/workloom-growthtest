/**
 * 数字员工配套技能「行业 Know-How 结构」回归（T-2026-0926-0101 → 0107 扩展）
 *
 * 为什么单独一组：技能文件是本仓最容易被"顺手改薄"的资产——
 *  · 决策原则被删成口号 → 岗位在真机上只能凭模型自由发挥；
 *  · SOP 丢掉"回执/失败"路径 → 失败时静默兜底，链路上看不见；
 *  · 关键指标没有来源 → 阈值变成拍脑袋，无法复核；
 *  · 岗位与技能绑定断开 → 技能存在但没人调用（孤儿资产）。
 * 这些都能在磁盘上静态验出来，所以本组测试不触 DB、不依赖 ffmpeg。
 *
 * 判定口径 = `scripts/tools/agent-knowhow-audit.mts` 的**结构等价**：
 *   ① 语义区块（标题含关键词即可，兼容「## 二、时窗适配」这类编号标题）；
 *   ② 全文量化阈值行（含比较符或带单位数值）；
 *   ③ 红线/禁止表述（作为参数边界的可判定形式）；
 *   ④ 失败模式允许「症状→检测器→处置」表，也允许「情形 → 处置」条目式。
 * 覆盖：视频域 18 个关键技能（S-A 3 / S-B 8 / S-C 7）。
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import YAML from "yaml";

import { bundlesRoot } from "./assembly.js";

const ROOT = bundlesRoot();
const BUNDLE_DIR = join(ROOT, "ai-video");

/** S-A 经营/决策型 */
const SKILLS_SA: Array<{ name: string; boundBy: string[] }> = [
  { name: "jenny-loom-research", boundBy: ["intel-collector", "intel-reviewer", "intel-competitor", "intel-verifier", "intel-binder", "trend-researcher"] },
  { name: "marketing-brief-parser", boundBy: ["creative-planner"] },
  { name: "director-review", boundBy: ["continuity-reviewer"] },
];

/** S-B 制作/工艺型 */
const SKILLS_SB: Array<{ name: string; boundBy: string[] }> = [
  { name: "shot-prompt-craft", boundBy: ["prompt-fuser", "field-inspector"] },
  { name: "portrait-studio", boundBy: ["portrait-artist"] },
  { name: "color-look-design", boundBy: ["colorist"] },
  { name: "bgm-score-design", boundBy: ["bgm-composer"] },
  { name: "subtitle-layout-design", boundBy: ["subtitle-stylist", "cover-designer"] },
  { name: "voice-profile-craft", boundBy: ["voice-artist"] },
  { name: "cinematography-kb", boundBy: ["cinematographer", "visual-director"] },
  { name: "voice-clone-consent", boundBy: ["voice-artist"] },
  /** 封面知识库（cover-kb）：平台规范 × 账号视觉锤 × 题材映射 × 钩子公式的检索与注入纪律 */
  { name: "cover-kb", boundBy: ["cover-designer"] },
];

/** S-C 工具/纪律型 */
const SKILLS_SC: Array<{ name: string; boundBy: string[] }> = [
  { name: "publish-ops", boundBy: ["publish-operator", "distribution-operator"] },
  { name: "render-ops", boundBy: ["render-operator"] },
  { name: "comment-ops", boundBy: ["comment-operator"] },
  { name: "producer-gate-review", boundBy: ["producer"] },
  { name: "caption-burnin-ops", boundBy: ["subtitle-stylist"] },
  { name: "delivery-package-ops", boundBy: ["post-editor", "cover-designer"] },
  { name: "delivery-revision-ops", boundBy: ["post-editor"] },
];

const skillText = (name: string): string => readFileSync(join(BUNDLE_DIR, "skills", name, "SKILL.md"), "utf8");

/** 取 "## 标题" 区块（到下一个 "## " 为止），标题允许带括注 */
function section(text: string, heading: string): string {
  const start = text.indexOf(`## ${heading}`);
  if (start < 0) return "";
  const rest = text.slice(start + heading.length + 3);
  const next = rest.search(/^## /m);
  return next >= 0 ? rest.slice(0, next) : rest;
}

const numbered = (block: string): number => (block.match(/^\d+\.\s/gm) ?? []).length;
const bullets = (block: string): number => (block.match(/^-\s/gm) ?? []).length;
const tableRows = (block: string): number => {
  const rows = block.split("\n").map((l) => l.trim()).filter((l) => l.startsWith("|"));
  let count = 0;
  for (let i = 0; i < rows.length; i += 1) {
    if (/^\|\s*-+/.test(rows[i]!)) continue;
    if (i + 1 < rows.length && /^\|\s*-+/.test(rows[i + 1]!)) continue;
    count += 1;
  }
  return count;
};

/** 所有命中标题的区块（同一语义可能被多节承载，取最强的那节） */
function findAllSections(text: string, keywords: string[]): string[] {
  const lines = text.split("\n");
  const bodies: string[] = [];
  for (let i = 0; i < lines.length; i += 1) {
    const m = /^##\s+(.*)$/.exec(lines[i]!);
    if (!m) continue;
    if (!keywords.some((k) => (m[1] ?? "").includes(k))) continue;
    const body: string[] = [];
    for (let j = i + 1; j < lines.length; j += 1) {
      if (/^##\s/.test(lines[j]!)) break;
      body.push(lines[j]!);
    }
    bodies.push(body.join("\n"));
  }
  return bodies;
}

function sectionMetrics(text: string, keywords: string[]): { rows: number; items: number; merged: string } {
  let rows = 0;
  let items = 0;
  const bodies = findAllSections(text, keywords);
  for (const body of bodies) {
    rows = Math.max(rows, tableRows(body));
    items = Math.max(items, numbered(body) + bullets(body));
  }
  return { rows, items, merged: bodies.join("\n") };
}

/** 量化阈值行数（判据"可判定"的最低证据） */
function quantifiedLines(text: string): number {
  const ROW = /(≤|≥|<|>|不超过|小于|大于)\s*\d|\d+(\.\d+)?\s*(%|dB|dBTP|LUFS|ms|毫秒|秒|s\b|×|°|字|行|条|像素|px|K|kbps)/;
  return text.split("\n").filter((l) => {
    const t = l.trim();
    if (!t || /^\|\s*-+/.test(t)) return false;
    return ROW.test(t);
  }).length;
}

/** 禁止/红线类表述行数 */
function prohibitionLines(text: string): number {
  return text
    .split("\n")
    .map((l) => l.trim())
    .filter((t) => t && !/^\|\s*-+/.test(t))
    .filter((t) => /禁止|不得|硬红线|红线|一票否决|必须|拒绝|fail-closed|失败关闭/.test(t)).length;
}

/** 岗位绑定未断链（技能不会变成孤儿） */
function expectBoundToPresets(name: string, boundBy: string[]): void {
  const bound: string[] = [];
  for (const preset of boundBy) {
    const p = join(BUNDLE_DIR, "presets", `${preset}.yml`);
    expect(existsSync(p), `preset 缺失：${preset}`).toBe(true);
    const doc = YAML.parse(readFileSync(p, "utf8")) as { skills?: string[] };
    if ((doc.skills ?? []).includes(name)) bound.push(preset);
  }
  expect(bound.length, `${name} 未被任何声明岗位绑定`).toBeGreaterThan(0);
}

describe("数字员工配套技能 · 行业 Know-How 结构（S-A 经营/决策型）", () => {
  for (const { name, boundBy } of SKILLS_SA) {
    const text = skillText(name);

    it(`${name}：五个 Know-How 区块齐备`, () => {
      for (const heading of ["决策原则", "打法库", "SOP", "关键指标", "失败模式"]) {
        expect(section(text, heading), `${name} 缺「${heading}」区块`).not.toBe("");
      }
    });

    it(`${name}：决策原则 ≥3 条且含阈值或失败关闭语义`, () => {
      const block = section(text, "决策原则");
      expect(numbered(block) + bullets(block)).toBeGreaterThanOrEqual(3);
      expect(/失败关闭|禁止|不得|即.*(剔除|打回|停摆|拒收|挂起)/.test(block), "决策原则必须可判定").toBe(true);
    });

    it(`${name}：打法库 ≥3 条且至少 2 条分支`, () => {
      const block = section(text, "打法库");
      expect(bullets(block)).toBeGreaterThanOrEqual(3);
      expect((block.match(/\*\*分支/g) ?? []).length).toBeGreaterThanOrEqual(2);
    });

    it(`${name}：SOP ≥3 步且每步带触发/回执/失败路径`, () => {
      const steps = section(text, "SOP").split("\n").filter((l) => /^\d+\.\s/.test(l));
      expect(steps.filter((l) => l.includes("触发") && l.includes("回执") && l.includes("失败")).length).toBeGreaterThanOrEqual(3);
    });

    it(`${name}：关键指标 ≥4 行且带来源列`, () => {
      const block = section(text, "关键指标");
      expect(tableRows(block)).toBeGreaterThanOrEqual(4);
      expect(block).toContain("来源");
    });

    it(`${name}：失败模式 ≥3 行且含检测器与处置`, () => {
      const block = section(text, "失败模式");
      expect(tableRows(block)).toBeGreaterThanOrEqual(3);
      expect(block).toContain("检测器");
      expect(block).toContain("处置");
    });

    it(`${name}：无不可判定的模板化表述 + 岗位绑定未断链`, () => {
      expect(/应加强专业性|提升专业水平|注意结合实际情况/.test(text)).toBe(false);
      expectBoundToPresets(name, boundBy);
    });
  }
});

describe("数字员工配套技能 · 行业 Know-How 结构（S-B 制作/工艺型）", () => {
  for (const { name, boundBy } of SKILLS_SB) {
    const text = skillText(name);

    it(`${name}：工艺判据 ≥4（语义区块或全文量化阈值行）`, () => {
      const metrics = sectionMetrics(text, [
        "工艺判据", "判据", "工艺", "参数", "手法", "目标值", "参数表", "配方",
        "规格", "版式", "选型", "策略", "口径", "适配", "同步", "决策", "判定", "问清",
      ]);
      const count = Math.max(metrics.rows, metrics.items, quantifiedLines(text));
      expect(count, `${name} 工艺判据不足`).toBeGreaterThanOrEqual(4);
    });

    it(`${name}：参数边界 ≥3（边界区块或红线/禁止表述）`, () => {
      const metrics = sectionMetrics(text, ["参数边界", "边界", "硬红线", "红线", "纪律", "限制", "禁用", "禁忌"]);
      expect(Math.max(metrics.items, prohibitionLines(text)), `${name} 缺参数边界`).toBeGreaterThanOrEqual(3);
    });

    it(`${name}：失败模式 ≥3（含"原因→处置"结构）`, () => {
      const kwargs = ["失败", "翻车", "故障", "异常", "不达标", "回退", "不可修复", "返工", "拒绝", "否决", "处置", "红线"];
      const metrics = sectionMetrics(text, kwargs);
      const count = Math.max(metrics.rows, metrics.items);
      expect(count, `${name} 缺失败模式区块`).toBeGreaterThanOrEqual(3);
      const hasCauseColumn = /检测器|首查|根因|原因|理由|症状|情形|现象/.test(metrics.merged);
      const hasArrowPairs = (metrics.merged.match(/→/g)?.length ?? 0) >= 2;
      expect(hasCauseColumn || hasArrowPairs, `${name} 失败模式缺少"原因→处置"结构`).toBe(true);
    });

    it(`${name}：无不可判定表述 + 岗位绑定未断链`, () => {
      expect(/应加强专业性|提升专业水平|注意结合实际情况/.test(text)).toBe(false);
      expectBoundToPresets(name, boundBy);
    });
  }
});

describe("数字员工配套技能 · 行业 Know-How 结构（S-C 工具/纪律型）", () => {
  for (const { name, boundBy } of SKILLS_SC) {
    const text = skillText(name);

    it(`${name}：前置校验 ≥3（语义区块或红线/必须表述）`, () => {
      const metrics = sectionMetrics(text, [
        "前置校验", "SOP", "触发条件", "校验", "检查", "发布包", "复检", "核对",
        "清单", "交付前", "交付", "口径", "影响",
      ]);
      expect(Math.max(metrics.items, prohibitionLines(text)), `${name} 前置校验不足`).toBeGreaterThanOrEqual(3);
    });

    it(`${name}：失败诊断 ≥3（含"原因→处置"结构）`, () => {
      const kwargs = ["失败", "翻车", "故障", "异常", "不达标", "回退", "不可修复", "处置", "红线"];
      const metrics = sectionMetrics(text, kwargs);
      expect(Math.max(metrics.rows, metrics.items), `${name} 失败诊断不足`).toBeGreaterThanOrEqual(3);
      const hasCauseColumn = /检测器|首查|根因|原因|理由|症状|情形|现象/.test(metrics.merged);
      const hasArrowPairs = (metrics.merged.match(/→/g)?.length ?? 0) >= 2;
      expect(hasCauseColumn || hasArrowPairs, `${name} 失败诊断缺少"原因→处置"结构`).toBe(true);
    });

    it(`${name}：证据口径 ≥2（证据/回执/留痕区块或表述）`, () => {
      const metrics = sectionMetrics(text, ["证据口径", "留痕", "回执", "证据", "清单"]);
      const evidenceLines = text
        .split("\n")
        .map((l) => l.trim())
        .filter((t) => t && !/^\|\s*-+/.test(t))
        .filter((t) => /回执|sha256|SHA256|证据链|留痕|清单/.test(t)).length;
      expect(Math.max(metrics.rows, metrics.items, evidenceLines), `${name} 证据口径不足`).toBeGreaterThanOrEqual(2);
    });

    it(`${name}：无不可判定表述 + 岗位绑定未断链`, () => {
      expect(/应加强专业性|提升专业水平|注意结合实际情况/.test(text)).toBe(false);
      expectBoundToPresets(name, boundBy);
    });
  }
});

/** geo-growth 视觉栈（S-B 制作/工艺型）：获客系统的成套视觉生产能力 */
const GEO_VISUAL_SKILLS: Array<{ name: string; boundBy: string[] }> = [
  { name: "compositor-designer", boundBy: ["visual-designer"] },
  { name: "art-direction", boundBy: ["material-scout", "visual-designer"] },
  { name: "design-brief", boundBy: ["visual-designer"] },
  { name: "design-critique", boundBy: ["visual-designer"] },
  { name: "material-scout", boundBy: ["material-scout", "visual-designer"] },
  { name: "image-retouch", boundBy: ["visual-designer"] },
  { name: "brand-guard", boundBy: ["visual-designer"] },
  { name: "product-poster", boundBy: ["visual-designer"] },
  { name: "video-cover", boundBy: ["visual-designer"] },
  { name: "asset-variant-forge", boundBy: ["visual-designer"] },
  { name: "geo-answer-card", boundBy: ["visual-designer"] },
  { name: "moments-post", boundBy: ["visual-designer"] },
  { name: "poster-series", boundBy: ["visual-designer"] },
  { name: "promo-banner", boundBy: ["visual-designer"] },
];

describe("geo-growth 视觉栈 · 行业 Know-How 结构（S-B 制作/工艺型）", () => {
  const GEO_DIR = join(ROOT, "geo-growth");
  const geoSkillText = (name: string): string => readFileSync(join(GEO_DIR, "skills", name, "SKILL.md"), "utf8");
  const expectGeoBound = (name: string, boundBy: string[]): void => {
    const bound: string[] = [];
    for (const preset of boundBy) {
      const p = join(GEO_DIR, "presets", `${preset}.yml`);
      expect(existsSync(p), `geo preset 缺失：${preset}`).toBe(true);
      const doc = YAML.parse(readFileSync(p, "utf8")) as { skills?: string[] };
      if ((doc.skills ?? []).includes(name)) bound.push(preset);
    }
    expect(bound.length, `${name} 未被任何声明岗位绑定`).toBeGreaterThan(0);
  };

  for (const { name, boundBy } of GEO_VISUAL_SKILLS) {
    const text = geoSkillText(name);

    it(`${name}：工艺判据 ≥4（语义区块或全文量化阈值行）`, () => {
      const metrics = sectionMetrics(text, [
        "工艺判据", "判据", "工艺", "参数", "手法", "目标值", "参数表", "配方",
        "规格", "版式", "选型", "策略", "口径", "适配", "同步", "决策", "判定", "问清", "方法", "清单",
      ]);
      expect(Math.max(metrics.rows, metrics.items, quantifiedLines(text)), `${name} 工艺判据不足`).toBeGreaterThanOrEqual(4);
    });

    it(`${name}：参数边界 ≥3（边界区块或红线/禁止表述）`, () => {
      const metrics = sectionMetrics(text, ["参数边界", "边界", "硬红线", "红线", "纪律", "限制", "禁用", "禁忌"]);
      expect(Math.max(metrics.items, prohibitionLines(text)), `${name} 缺参数边界`).toBeGreaterThanOrEqual(3);
    });

    it(`${name}：失败模式 ≥3（含"原因→处置"结构）`, () => {
      const kwargs = ["失败", "翻车", "故障", "异常", "不达标", "回退", "不可修复", "返工", "拒绝", "否决", "处置", "红线"];
      const metrics = sectionMetrics(text, kwargs);
      expect(Math.max(metrics.rows, metrics.items), `${name} 缺失败模式区块`).toBeGreaterThanOrEqual(3);
      const hasCauseColumn = /检测器|首查|根因|原因|理由|症状|情形|现象/.test(metrics.merged);
      const hasArrowPairs = (metrics.merged.match(/→/g)?.length ?? 0) >= 2;
      expect(hasCauseColumn || hasArrowPairs, `${name} 失败模式缺少"原因→处置"结构`).toBe(true);
    });

    it(`${name}：无不可判定表述 + 岗位绑定未断链`, () => {
      expect(/应加强专业性|提升专业水平|注意结合实际情况/.test(text)).toBe(false);
      expectGeoBound(name, boundBy);
    });
  }
});

/**
 * hotel 技能采用本仓另一种生产模板（触发条件/输入数据/方法/输出动作/围栏绑定/验收用例），
 * 因此这里只锁三条硬要求：前置校验 ≥3、失败诊断 ≥3（含可判定语义）、证据口径 ≥2。
 * 其中 10 个技能无岗位绑定（登记为可装配能力），故不做绑定断言。
 */
const HOTEL_SKILLS: string[] = [
  "ai-live-assistant", "channel-reconciler", "checkin-checkout", "content-marketing", "coupon-ops",
  "customer-service", "fast-scan", "finance-reporting", "guest-profile-crm", "handover-manager",
  "hotel-geo-content", "incident-postmortem", "inspection-suite", "intent-radar", "inventory-procurement",
  "lead-concierge", "maintenance-dispatch", "morning-briefing", "night-audit-suite", "ota-operations",
  "overbooking-parity-guard", "phone-concierge", "pricing-matrix", "retention-manager", "revenue-manager",
  "review-asset-mining", "review-crisis", "room-service-dispatch", "safety-compliance", "staff-scheduler",
];

describe("hotel 值守技能 · 行业 Know-How 结构（S-C 工具/纪律型）", () => {
  const HOTEL_DIR = join(ROOT, "hotel");

  for (const name of HOTEL_SKILLS) {
    const path = join(HOTEL_DIR, "skills", name, "SKILL.md");
    if (!existsSync(path)) continue; // 名称表兜底：不存在的条目跳过（由机检器负责报缺）
    const text = readFileSync(path, "utf8");

    it(`${name}：前置校验 ≥3`, () => {
      const metrics = sectionMetrics(text, [
        "前置校验", "SOP", "触发条件", "校验", "检查", "清单", "交付前", "交付", "口径", "输入数据", "方法", "输入",
      ]);
      expect(Math.max(metrics.items, prohibitionLines(text)), `${name} 前置校验不足`).toBeGreaterThanOrEqual(3);
    });

    it(`${name}：失败诊断 ≥3 且含可判定语义`, () => {
      const metrics = sectionMetrics(text, [
        "失败", "异常", "不达标", "回退", "不可修复", "处置", "红线", "验收用例", "异常路径", "边界", "围栏绑定", "不做什么",
      ]);
      expect(Math.max(metrics.rows, metrics.items), `${name} 失败诊断不足`).toBeGreaterThanOrEqual(3);
      expect(
        /异常路径|失败|block|review|不执行|不编造|未核实|回滚|挂起|熔断|打回|剔除|停止|冻结|撤回|告警|转人工|退回|报错|不可能/.test(metrics.merged),
        `${name} 失败诊断缺少可判定语义`,
      ).toBe(true);
    });

    it(`${name}：证据口径 ≥2`, () => {
      const metrics = sectionMetrics(text, ["证据口径", "留痕", "回执", "证据", "输出动作", "输出契约", "事件"]);
      const evidenceLines = text
        .split("\n")
        .map((l) => l.trim())
        .filter((t) => t && !/^\|\s*-+/.test(t))
        .filter((t) => /回执|sha256|SHA256|证据链|留痕|事件 ID/.test(t)).length;
      expect(Math.max(metrics.rows, metrics.items, evidenceLines), `${name} 证据口径不足`).toBeGreaterThanOrEqual(2);
    });
  }
});
