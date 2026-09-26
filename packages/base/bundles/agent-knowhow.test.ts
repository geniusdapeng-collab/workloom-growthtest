/**
 * 数字员工配套技能「行业 Know-How 结构」回归（T-2026-0926-0101）
 *
 * 为什么单独一组：技能文件是本仓最容易被"顺手改薄"的资产——
 *  · 决策原则被删成口号 → 岗位在真机上只能凭模型自由发挥；
 *  · SOP 丢掉"回执/失败"路径 → 失败时静默兜底，链路上看不见；
 *  · 关键指标没有来源 → 阈值变成拍脑袋，无法复核；
 *  · 岗位与技能绑定断开 → 技能存在但没人调用（孤儿资产）。
 * 这些都能在磁盘上静态验出来，所以本组测试不触 DB、不依赖 ffmpeg。
 *
 * 覆盖范围：本轮先锁「营销前置两站 + 事实红线评审」三个技能（S-A 分型）。
 * 随后逐批把其它技能纳入（见 docs/audit/GAP-LEDGER.md）。
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import YAML from "yaml";

import { bundlesRoot } from "./assembly.js";

const ROOT = bundlesRoot();
const BUNDLE_DIR = join(ROOT, "ai-video");

/** S-A 型技能必须齐备的五个区块（结构等价判定，允许标题带括注） */
const REQUIRED_SECTIONS = ["决策原则", "打法库", "SOP", "关键指标", "失败模式"] as const;

const SKILLS_SA: Array<{ name: string; boundBy: string[] }> = [
  // 营销片前置：情报五站（G1 前）
  { name: "jenny-loom-research", boundBy: ["intel-collector", "intel-reviewer", "intel-competitor", "intel-verifier", "intel-binder", "trend-researcher"] },
  // 营销片前置：Brief 解析（G2 前）
  { name: "marketing-brief-parser", boundBy: ["creative-planner"] },
  // 营销片事实红线闸 + G6 评审材料
  { name: "director-review", boundBy: ["continuity-reviewer"] },
];

/** S-B 制作/工艺型：工艺判据表 + 参数边界 + 失败模式 + 输出契约 */
const SKILLS_SB: Array<{ name: string; boundBy: string[] }> = [
  { name: "shot-prompt-craft", boundBy: ["prompt-fuser", "field-inspector"] },
  { name: "portrait-studio", boundBy: ["portrait-artist"] },
  // 后期链四工位（调色选型 / 配乐定调 / 字幕版式 / 音色档案）
  { name: "color-look-design", boundBy: ["colorist"] },
  { name: "bgm-score-design", boundBy: ["bgm-composer"] },
  { name: "subtitle-layout-design", boundBy: ["subtitle-stylist", "cover-designer"] },
  { name: "voice-profile-craft", boundBy: ["voice-artist"] },
];

/** S-C 工具/纪律型：前置校验 + 失败诊断 + 证据口径 + 输出契约 */
const SKILLS_SC: Array<{ name: string; boundBy: string[] }> = [
  { name: "publish-ops", boundBy: ["publish-operator", "distribution-operator"] },
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

/** 语义区块查找（结构等价）：兼容「## 工艺判据」与「## 二、时窗适配：…」两种写法 */
function findSection(text: string, keywords: string[]): string {
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i += 1) {
    const m = /^##\s+(.*)$/.exec(lines[i]!);
    if (!m) continue;
    if (!keywords.some((k) => (m[1] ?? "").includes(k))) continue;
    const body: string[] = [];
    for (let j = i + 1; j < lines.length; j += 1) {
      if (/^##\s/.test(lines[j]!)) break;
      body.push(lines[j]!);
    }
    return body.join("\n");
  }
  return "";
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
  expect(bound.length).toBeGreaterThan(0);
}

describe("数字员工配套技能 · 行业 Know-How 结构（S-A 经营/决策型）", () => {
  for (const { name, boundBy } of SKILLS_SA) {
    const text = skillText(name);

    it(`${name}：五个 Know-How 区块齐备`, () => {
      for (const heading of REQUIRED_SECTIONS) {
        expect(section(text, heading), `${name} 缺「${heading}」区块`).not.toBe("");
      }
    });

    it(`${name}：决策原则 ≥3 条且含阈值或失败关闭语义`, () => {
      const block = section(text, "决策原则");
      expect(numbered(block) + bullets(block)).toBeGreaterThanOrEqual(3);
      expect(/失败关闭|禁止|不得|即.*(剔除|打回|停摆|拒收|挂起)/.test(block), "决策原则必须可判定（阈值或失败关闭）").toBe(true);
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

    it(`${name}：无不可判定的模板化表述`, () => {
      expect(/应加强专业性|提升专业水平|注意结合实际情况/.test(text)).toBe(false);
    });

    it(`${name}：岗位绑定未断链（技能不会变成孤儿）`, () => {
      expectBoundToPresets(name, boundBy);
    });
  }
});

describe("数字员工配套技能 · 行业 Know-How 结构（S-B 制作/工艺型）", () => {
  for (const { name, boundBy } of SKILLS_SB) {
    const text = skillText(name);

    it(`${name}：工艺判据 ≥4（语义区块或全文量化阈值行）`, () => {
      const block = findSection(text, [
        "工艺判据", "判据", "工艺", "参数", "手法", "目标值", "参数表", "配方",
        "规格", "版式", "选型", "策略", "口径", "适配", "同步", "决策",
      ]);
      const count = Math.max(tableRows(block), numbered(block), bullets(block), quantifiedLines(text));
      expect(count, `${name} 工艺判据不足（区块命中=${block ? "有" : "无"}）`).toBeGreaterThanOrEqual(4);
    });

    it(`${name}：参数边界 ≥3（边界区块或红线/禁止表述）`, () => {
      const block = findSection(text, ["参数边界", "边界", "硬红线", "红线", "纪律", "限制", "禁用", "禁忌"]);
      const count = Math.max(numbered(block) + bullets(block), prohibitionLines(text));
      expect(count).toBeGreaterThanOrEqual(3);
    });

    it(`${name}：失败模式 ≥3（含检测器与处置语义）`, () => {
      const block = findSection(text, ["失败", "翻车", "故障", "异常处置"]);
      const count = Math.max(tableRows(block), numbered(block), bullets(block));
      expect(count, `${name} 缺失败模式区块`).toBeGreaterThanOrEqual(3);
      expect(block).toMatch(/检测器|根因|原因/);
      expect(block).toMatch(/处置|回退|修复|停用|拒绝/);
    });

    it(`${name}：参数边界可见（边界/红线区块或全文红线表述）`, () => {
      const boundarySection = findSection(text, ["参数边界", "边界", "硬红线", "红线", "纪律", "限制", "禁用", "禁忌"]);
      expect(boundarySection !== "" || prohibitionLines(text) >= 3, `${name} 缺参数边界`).toBe(true);
    });

    it(`${name}：岗位绑定未断链（技能不会变成孤儿）`, () => {
      expectBoundToPresets(name, boundBy);
    });
  }
});

describe("数字员工配套技能 · 行业 Know-How 结构（S-C 工具/纪律型）", () => {
  for (const { name, boundBy } of SKILLS_SC) {
    const text = skillText(name);

    it(`${name}：前置校验 ≥3 条`, () => {
      const block = section(text, "前置校验");
      expect(block, `${name} 缺「前置校验」区块`).not.toBe("");
      expect(numbered(block) + bullets(block)).toBeGreaterThanOrEqual(3);
    });

    it(`${name}：失败诊断 ≥3 行且含检测器与处置`, () => {
      const block = section(text, "失败诊断");
      expect(block, `${name} 缺「失败诊断」区块`).not.toBe("");
      expect(tableRows(block)).toBeGreaterThanOrEqual(3);
      expect(block).toContain("检测器");
      expect(block).toContain("处置");
    });

    it(`${name}：证据口径 ≥2 条`, () => {
      const block = section(text, "证据口径");
      expect(block, `${name} 缺「证据口径」区块`).not.toBe("");
      expect(numbered(block) + bullets(block)).toBeGreaterThanOrEqual(2);
    });

    it(`${name}：输出契约齐备 + 无不可判定表述`, () => {
      expect(section(text, "输出契约")).not.toBe("");
      expect(/应加强专业性|提升专业水平|注意结合实际情况/.test(text)).toBe(false);
    });

    it(`${name}：岗位绑定未断链（技能不会变成孤儿）`, () => {
      expectBoundToPresets(name, boundBy);
    });
  }
});
