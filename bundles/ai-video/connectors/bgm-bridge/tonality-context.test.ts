/**
 * T-23：调性相容维度 + brief 上下文增强（情绪弧线偏好 / "允许不配"前置提示）。
 *
 * 覆盖：
 * 1. 同题材两候选：调性相容者得分高于冲突者；
 * 2. 无调性标签曲目得分不变（回归：记 0 且不惩罚，reason 如实注明）；
 * 3. 权重再分配后总分口径恒为 100（人工核对的期望值写死在用例里）；
 * 4. 弧线偏好加分生效 / 不生效；
 * 5. brief 不配乐前置提示（命中与不命中；不写 SKIP 字样）。
 */
import { describe, expect, it } from "vitest";

import { analyzePromptBrief, arcPreferenceFromEmotionArc, scoreTrackAgainstBrief } from "./brief.mjs";

/** 受控配方：固定 genre/bpm/key/mode，让期望值可以手算。 */
const CATALOG = [
  { id: "food", genre: "美食 / 餐饮", bpm: 96, key: "G4", mode: "major" },
] as any;

const BASE_BRIEF = {
  recipeId: "food",
  genreTags: ["美食", "餐饮"],
  energyLevel: "medium",
  bpmScale: 1,
  durationSec: 30,
  instrumentation: { prefer: [], avoid: [] },
} as any;

/** 满分配件：题材全命中 + 能量贴目标 + BPM 贴目标 + 时长够 + 有结构。 */
function baseTrack(tags: string[] = [], extra: Record<string, unknown> = {}) {
  return {
    id: "t",
    title: "T",
    genre: "美食 / 餐饮",
    mood: "诱人温暖",
    tags,
    energyScore: 0.55,
    bpm: 96,
    durationSec: 60,
    dynamicsDb: 9,
    ...extra,
  };
}

describe("调性相容维度（T-23）", () => {
  it("权重再分配：无调性标签记 0 不惩罚，其余维度满分 = 90（38+18+18+9+7+0）", () => {
    const result = scoreTrackAgainstBrief({ track: baseTrack(), brief: BASE_BRIEF, recipeCatalog: CATALOG });
    expect(result.score).toBe(90);
    expect(result.reasons.some((r: string) => r.includes("无调性标签不参与调性评分"))).toBe(true);
  });

  it("同题材两候选：同调相容者（100）> 冲突调性者（85）", () => {
    const compatible = scoreTrackAgainstBrief({
      track: baseTrack(["key:G4", "mode:major"]), brief: BASE_BRIEF, recipeCatalog: CATALOG,
    });
    const conflicting = scoreTrackAgainstBrief({
      track: baseTrack(["key:F#4", "mode:major"]), brief: BASE_BRIEF, recipeCatalog: CATALOG,
    });
    expect(compatible.score).toBe(100); // 90 + 10
    expect(conflicting.score).toBe(85); // 90 - 5（小二度冲突）
    expect(compatible.score).toBeGreaterThan(conflicting.score);
    expect(conflicting.reasons.some((r: string) => r.includes("冲突调性"))).toBe(true);
  });

  it("关系大小调 +6：E4 minor ↔ G4 major", () => {
    const result = scoreTrackAgainstBrief({
      track: baseTrack(["key:E4", "mode:minor"]), brief: BASE_BRIEF, recipeCatalog: CATALOG,
    });
    expect(result.score).toBe(96); // 90 + 6
    expect(result.reasons.some((r: string) => r.includes("关系大小调"))).toBe(true);
  });

  it("五度圈相邻 +6：D4 major ↔ G4 major（纯四度）", () => {
    const result = scoreTrackAgainstBrief({
      track: baseTrack(["key:D4", "mode:major"]), brief: BASE_BRIEF, recipeCatalog: CATALOG,
    });
    expect(result.score).toBe(96);
    expect(result.reasons.some((r: string) => r.includes("五度圈相邻"))).toBe(true);
  });

  it("中性 +3：大三度等无冲突音程；纯打击配器即使冲突音程也按中性 +3", () => {
    const neutral = scoreTrackAgainstBrief({
      track: baseTrack(["key:B4", "mode:major"]), brief: BASE_BRIEF, recipeCatalog: CATALOG,
    });
    expect(neutral.score).toBe(93); // 90 + 3（大三度，非同调/关系/五度/冲突）
    const percussion = scoreTrackAgainstBrief({
      track: baseTrack(["key:F#4", "mode:major"], { instrumentation: ["kick", "hat", "shaker"] }),
      brief: BASE_BRIEF,
      recipeCatalog: CATALOG,
    });
    expect(percussion.score).toBe(93); // 冲突音程但纯打击 → 中性 +3
    expect(percussion.reasons.some((r: string) => r.includes("中性 +3"))).toBe(true);
  });

  it("配方无调性目标时同样不惩罚（记 0 并注明）", () => {
    const result = scoreTrackAgainstBrief({
      track: baseTrack(["key:G4", "mode:major"]),
      brief: BASE_BRIEF,
      recipeCatalog: [{ id: "food", genre: "美食 / 餐饮", bpm: 96 }] as any,
    });
    expect(result.score).toBe(90);
    expect(result.reasons.some((r: string) => r.includes("配方未给调性目标"))).toBe(true);
  });
});

describe("情绪弧线偏好（T-23）", () => {
  it("arcPreferenceFromEmotionArc：推到结尾 → rising-steady；多峰 → wave-narrative；平坦 → flat-ambient", () => {
    expect(arcPreferenceFromEmotionArc(["平静", "期待", "燃"])!.arc).toBe("rising-steady");
    expect(arcPreferenceFromEmotionArc(["燃", "回落", "紧张", "燃", "收束"])!.arc).toBe("wave-narrative");
    expect(arcPreferenceFromEmotionArc(["治愈", "安静", "温柔"])!.arc).toBe("flat-ambient");
    expect(arcPreferenceFromEmotionArc("开场燃炸，随后舒缓收束")!.arc).toBe("front-loaded");
    expect(arcPreferenceFromEmotionArc(["单标签不足"])).toBeNull();
  });

  it("brief 可选输入 emotionArc → brief.arcPreference；无输入时为 null", () => {
    const withArc = analyzePromptBrief({ promptText: "美食探店", emotionArc: ["平静", "推进", "燃"] });
    expect(withArc.brief.arcPreference?.arc).toBe("rising-steady");
    const without = analyzePromptBrief({ promptText: "美食探店" });
    expect(without.brief.arcPreference).toBeNull();
  });

  it("弧线偏好生效：arc 命中 +5、同族 +2、走向不符 +0（权重从调性外维度协调，满分仍 100）", () => {
    const brief = { ...BASE_BRIEF, arcPreference: { arc: "build-drop", source: "emotion-arc" } };
    const hit = scoreTrackAgainstBrief({
      track: baseTrack(["arc:build-drop"]), brief, recipeCatalog: CATALOG,
    });
    // 有弧线时权重：题材36+能量17+BPM17+时长8+结构7+调性0+弧线5 = 90
    expect(hit.score).toBe(90);
    expect(hit.reasons.some((r: string) => r.includes("弧线：命中"))).toBe(true);

    const sameFamily = scoreTrackAgainstBrief({
      track: baseTrack(["arc:wave-narrative"]), brief, recipeCatalog: CATALOG,
    });
    expect(sameFamily.score).toBe(87); // 85 + 2

    const mismatch = scoreTrackAgainstBrief({
      track: baseTrack(["arc:flat-ambient"]), brief, recipeCatalog: CATALOG,
    });
    expect(mismatch.score).toBe(85); // 36+17+17+8+7+0+0

    // 相对排序：命中 > 同族 > 不符
    expect(hit.score).toBeGreaterThan(sameFamily.score);
    expect(sameFamily.score).toBeGreaterThan(mismatch.score);
  });

  it("无弧线输入不生效：arc 标签不加分、理由里不出现弧线维度", () => {
    const result = scoreTrackAgainstBrief({
      track: baseTrack(["arc:build-drop"]), brief: BASE_BRIEF, recipeCatalog: CATALOG,
    });
    expect(result.score).toBe(90); // 与无 arc 标签完全一致
    expect(result.reasons.some((r: string) => r.startsWith("弧线"))).toBe(false);
  });

  it("有弧线偏好但曲目无 arc 标签：记 0 不惩罚并注明", () => {
    const brief = { ...BASE_BRIEF, arcPreference: { arc: "build-drop", source: "emotion-arc" } };
    const result = scoreTrackAgainstBrief({ track: baseTrack(), brief, recipeCatalog: CATALOG });
    expect(result.score).toBe(85); // 36+17+17+8+7+0+0
    expect(result.reasons.some((r: string) => r.includes("无 arc 标签不参与弧线评分"))).toBe(true);
  });
});

describe('"允许不配"前置提示（T-23）', () => {
  it("ASMR/保留现场声命中判据③ → noScoreHint 提示 + 依据，且不写 SKIP 字样", () => {
    const { brief } = analyzePromptBrief({ promptText: "ASMR 咀嚼音记录，保留现场声" });
    expect(brief.noScoreHint?.suggested).toBe(true);
    expect(brief.noScoreHint.criteria.join()).toContain("判据③");
    expect(brief.noScoreHint.basis).toContain("SCORE-006");
    expect(brief.notes.some((n: string) => n.includes("建议评估不配乐"))).toBe(true);
    // 只提示不判定：noMusic 仍为 false，且任何字段都不含 SKIP
    expect(brief.noMusic).toBe(false);
    expect(JSON.stringify(brief)).not.toContain("SKIP");
  });

  it("悼念场景命中'沉默即立场'提示", () => {
    const { brief } = analyzePromptBrief({ promptText: "悼念追思短片，黑白画面" });
    expect(brief.noScoreHint?.suggested).toBe(true);
    expect(brief.noScoreHint.basis).toContain("沉默");
  });

  it("普通产品广告不命中：noScoreHint 为 null", () => {
    const { brief } = analyzePromptBrief({ promptText: "产品广告，快节奏卡点，促销大促" });
    expect(brief.noScoreHint).toBeNull();
  });

  it("明确'不要音乐'走 do-no-harm 通道（noMusic=true），不再叠加提示", () => {
    const { brief } = analyzePromptBrief({ promptText: "ASMR 记录，不要背景音乐" });
    expect(brief.noMusic).toBe(true);
    expect(brief.noScoreHint).toBeNull();
  });
});
