/**
 * T-05 题材未命中负分降权（堵 FC-BGM-001「运动曲配江南口播」）。
 *
 * 覆盖：
 * ① 回归正例：运动/电竞类曲目对人文口播 brief 必须得负分且不入选（能量/BPM 维度不得把它捞回来）；
 * ② veto 策略：题材未命中直接出局（verdict=rejected），候选全出局时由既有三级兜底接管；
 * ③ 同族相邻：同族题材 +15（比全命中低、比错配高）；
 * ④ 反例词：人文/口播文本里的"运动会"不得把题材判成 sports（压制事实写进回执）；
 * ⑤ 无题材线索：不给分也不惩罚（退回按能量/结构选曲，行为与 T-23 口径一致）。
 */
import { describe, expect, it } from "vitest";

import { analyzePromptBrief, GENRE_ADJACENT_BONUS, GENRE_MISMATCH_PENALTY, scoreTrackAgainstBrief, sameGenreFamily } from "./brief.mjs";
import { loadRecipes } from "./core.mjs";

const CATALOG = loadRecipes().recipes as Array<Record<string, any>>;
const JIANGNAN = "江南古镇人文口播：讲述老手艺人守着一间铺子的日常，画面是雨巷与慢生活";

function track(extra: Record<string, unknown> = {}) {
  return {
    id: "t",
    title: "T",
    durationSec: 90,
    dynamicsDb: 9,
    ...extra,
  };
}

describe("T-05 题材未命中负分降权（FC-BGM-001）", () => {
  it("江南人文口播 brief：题材判成 documentary（不是 sports），动感曲目不再被选走", () => {
    const { brief } = analyzePromptBrief({ promptText: JIANGNAN, durationSec: 30 });
    expect(brief.recipeId).toBe("documentary");
    expect(brief.confidence).not.toBe("low");

    const sports = scoreTrackAgainstBrief({
      track: track({ genre: "体育赛事 / 集锦", mood: "燃向冲击", bpm: 132, energyScore: 0.9 }),
      brief, recipeCatalog: CATALOG,
    });
    const documentary = scoreTrackAgainstBrief({
      track: track({ genre: "纪录片 / 科普", mood: "克制叙事", bpm: 76, energyScore: 0.55, tags: ["key:G4", "mode:aeolian"] }),
      brief, recipeCatalog: CATALOG,
    });
    // 运动曲必须为负分（负分降权生效），且明显低于对题曲目
    expect(sports.score).toBeLessThan(0);
    expect(sports.reasons.some((r: string) => r.includes("题材未命中"))).toBe(true);
    expect(sports.verdict).toBe("weak");
    expect(documentary.score).toBeGreaterThan(sports.score + 50);
    expect(documentary.verdict).toBe("ok");
  });

  it("veto 策略：题材未命中直接出局（宁可不配也不配错）", () => {
    const { brief } = analyzePromptBrief({ promptText: JIANGNAN, genreMismatchPolicy: "veto" });
    expect(brief.genreMismatchPolicy).toBe("veto");
    const sports = scoreTrackAgainstBrief({
      track: track({ genre: "电子脉冲 / 游戏集锦", mood: "律动兴奋", bpm: 140, energyScore: 0.9 }),
      brief, recipeCatalog: CATALOG,
    });
    expect(sports.verdict).toBe("rejected");
    expect(sports.vetoed).toBe(true);
    expect(sports.reasons.join(" ")).toContain("veto");
  });

  it("同族相邻 +15：口播 brief 遇纪录片曲目是同族，不给全分也不给负分", () => {
    expect(sameGenreFamily("documentary", "interview")).toBe(true);
    expect(sameGenreFamily("sports", "documentary")).toBe(false);
    const { brief } = analyzePromptBrief({ promptText: "口播访谈：创始人讲品牌初心", durationSec: 30 });
    expect(brief.recipeId).toBe("interview");
    const adjacent = scoreTrackAgainstBrief({
      track: track({ genre: "纪录片 / 科普", mood: "克制叙事", bpm: 84, energyScore: 0.55 }),
      brief, recipeCatalog: CATALOG,
    });
    expect(adjacent.reasons.some((r: string) => r.includes("题材同族"))).toBe(true);
    const hit = scoreTrackAgainstBrief({
      track: track({ genre: "人物访谈 / 口播", mood: "可信温暖", bpm: 84, energyScore: 0.55 }),
      brief, recipeCatalog: CATALOG,
    });
    expect(hit.score - adjacent.score).toBeGreaterThanOrEqual(20);
    expect(adjacent.score).toBeGreaterThan(0);
    expect(GENRE_ADJACENT_BONUS).toBe(15);
  });

  it("反例词压制：人文口播里的「运动会」不判 sports，压制事实写进回执", () => {
    const { brief, matched } = analyzePromptBrief({
      promptText: "人文口播：古镇小学的秋季运动会，雨巷里的号子声与三代人的记忆",
      durationSec: 30,
    });
    expect(brief.recipeId).toBe("documentary");
    const suppressed = (matched as any).suppressedGenres ?? [];
    expect(suppressed.some((entry: { recipe: string }) => entry.recipe === "sports")).toBe(true);
    expect(brief.notes.join(" ")).toContain("反例词压制题材");
  });

  it("无题材线索：不给分也不惩罚（能量/结构定胜负，与 T-23 口径一致）", () => {
    const { brief } = analyzePromptBrief({ promptText: "随手拍的一段素材，配点音乐", durationSec: 30 });
    expect(brief.recipeId).toBeNull();
    const any = scoreTrackAgainstBrief({
      track: track({ genre: "电子脉冲 / 游戏集锦", mood: "律动兴奋", bpm: 140, energyScore: 0.6 }),
      brief, recipeCatalog: CATALOG,
    });
    expect(any.score).toBeGreaterThan(0);
    expect(any.reasons.some((r: string) => r.includes("无题材线索"))).toBe(true);
    expect(GENRE_MISMATCH_PENALTY).toBe(-30);
  });
});
