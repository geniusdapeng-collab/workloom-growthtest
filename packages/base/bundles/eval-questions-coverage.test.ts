/**
 * 视频域/酒店域考试院题集覆盖回归（T-2026-0926-0111）
 *
 * 背景：know-how 强化只是"写下来"，能不能被考、能不能被复算才算闭环。
 * 本组测试用与考试院同源的 loader 读题（含完整性摘要校验 + 严格 Schema 校验），
 * 并锁定关键围栏的覆盖，防止后续扩题时把关键红线题删掉。
 */
import { describe, expect, it } from "vitest";

import { loadVerifiedBundleEvalQuestions } from "./eval-questions.js";

const CASES: Array<{ bundleId: string; minCount: number; requiredTags: string[] }> = [
  {
    bundleId: "ai-video",
    minCount: 15,
    requiredTags: ["G1", "G6", "G8", "G9", "G-MAT1", "G-DLV1", "truth-check", "voice-clone"],
  },
  {
    bundleId: "hotel",
    minCount: 15,
    requiredTags: ["R1", "R2", "R10", "R17", "R18", "R21", "R24", "R26"],
  },
];

describe("考试院题集 · 视频域与酒店域覆盖", () => {
  for (const { bundleId, minCount, requiredTags } of CASES) {
    const set = loadVerifiedBundleEvalQuestions(bundleId);

    it(`${bundleId}：题量 ≥${minCount} 且 Schema/完整性校验通过`, () => {
      expect(set.questions.length).toBeGreaterThanOrEqual(minCount);
      expect(set.integrityDigest).toMatch(/^[0-9a-f]{64}$/);
    });

    it(`${bundleId}：关键围栏/场景覆盖齐备`, () => {
      const tags = new Set(set.questions.flatMap((q) => q.tags ?? []));
      const missing = requiredTags.filter((t) => !tags.has(t));
      expect(missing, `${bundleId} 缺关键覆盖：${missing.join(", ")}`).toEqual([]);
    });

    it(`${bundleId}：每题都有硬断言与评分口径`, () => {
      for (const q of set.questions) {
        expect(q.assertions.length, `${bundleId} 存在无断言题目`).toBeGreaterThan(0);
        expect(q.judgeRubric?.fullMarks, `${bundleId} 题缺评分口径`).toBeTruthy();
        expect(q.judgeRubric?.zeroMarks).toBeTruthy();
      }
    });

    it(`${bundleId}：红线题存在且包含 fail-closed 断言`, () => {
      const redLines = set.questions.filter((q) => q.redLine);
      expect(redLines.length, `${bundleId} 没有红线题`).toBeGreaterThanOrEqual(5);
      const hasFailClosed = redLines.some((q) =>
        q.assertions.some(
          (a) =>
            (a.type === "fence_verdict" && a.expected === "block")
            || a.type === "must_refuse_or_escalate"
            || a.type === "refusal_detected",
        ),
      );
      expect(hasFailClosed).toBe(true);
    });

    it(`${bundleId}：题面不重复（防复制粘贴扩题）`, () => {
      const inputs = set.questions.map((q) => q.scenario.turns.map((t) => t.input).join("\n"));
      expect(new Set(inputs).size).toBe(inputs.length);
    });
  }
});
