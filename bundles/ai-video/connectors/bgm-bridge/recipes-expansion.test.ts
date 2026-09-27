/**
 * T-15 配方库扩库（16→32）与平台差异参数（platformOverrides）回归。
 *
 * 覆盖：
 * ① 配方总数 ≥30，且每条字段合法（mode/key/chords/instrumentation 在 synth.mjs 词汇体系内，
 *    musicLevelDb ∈ targets.musicLevelDbRange，duckingDb ∈ [8,14]，avoid ≥2）；
 * ② 新题材 brief 关键词能命中对应新配方（含 FC-BGM-001 反例：sports 不得抢江南口播）；
 * ③ platformOverrides：带平台上下文时用覆盖值，不带时与既有行为一致；
 * ④ 既有 16 条配方关键字段与既有题材命中回归。
 */
import { describe, expect, it } from "vitest";

import { analyzePromptBrief } from "./brief.mjs";
import { applyPlatformOverrides, callTool, findRecipes, loadRecipes } from "./core.mjs";
import { CHORDS, noteToMidi, SCALES } from "./synth.mjs";

const SYNTH_INSTRUMENTS = new Set(["pad", "bass", "pluck", "kick", "hat", "bell", "sub", "arp", "lead", "snare", "riser", "impact"]);
const KNOWN_PLATFORMS = new Set(["douyin", "xiaohongshu", "wechat-channels", "bilibili", "youtube", "all"]);
const OVERRIDE_FIELDS = new Set(["musicLevelDb", "duckingDb", "lufsTarget"]);

const EXISTING_16: Array<[string, number, number]> = [
  ["product-ad", -22, 12], ["interview", -26, 14], ["food", -22, 12], ["tech", -25, 12],
  ["travel", -21, 11], ["night-city", -24, 12], ["beauty", -26, 13], ["family", -23, 12],
  ["auto", -20, 10], ["realestate", -25, 13], ["festival-promo", -19, 10], ["documentary", -27, 14],
  ["premium-brand", -26, 13], ["drama-story", -25, 13], ["suspense", -24, 12], ["comedy-light", -22, 11],
];

const NEW_RECIPES = [
  "wedding", "sports", "esports", "fashion", "baby-family", "home-decor", "auto-ev", "finance",
  "city-dusk", "festival-holiday", "edu-explainer", "vlog-daily", "emotional-story", "brand-manifesto", "pets", "workout",
];

const doc = loadRecipes();
const recipes = doc.recipes as Array<Record<string, any>>;
const byId = new Map(recipes.map((recipe) => [recipe.id, recipe]));

describe("① 配方库规模与字段合法性", () => {
  it("总数 ≥30（16 既有 + 16 新增 = 32）", () => {
    expect(recipes.length).toBeGreaterThanOrEqual(30);
    for (const id of NEW_RECIPES) expect(byId.has(id), `缺新配方 ${id}`).toBe(true);
    expect(new Set(recipes.map((r) => r.id)).size).toBe(recipes.length);
  });

  it.each(recipes.map((r) => [r.id, r] as const))("配方 %s 字段完整且取值合法", (_id, recipe) => {
    for (const field of ["id", "genre", "scene", "mood", "mode", "key", "bpm", "chords", "instrumentation", "musicLevelDb", "duckingDb", "platforms", "avoid", "notes"]) {
      expect(recipe[field], `${recipe.id} 缺字段 ${field}`).not.toBeUndefined();
    }
    expect(Object.keys(SCALES)).toContain(recipe.mode);
    expect(() => noteToMidi(recipe.key)).not.toThrow();
    expect(Number.isFinite(recipe.bpm)).toBe(true);
    for (const chord of recipe.chords) expect(Object.keys(CHORDS), `${recipe.id} 和弦 ${chord}`).toContain(chord);
    for (const instrument of recipe.instrumentation) expect(SYNTH_INSTRUMENTS.has(instrument), `${recipe.id} 配器 ${instrument}`).toBe(true);
    const [levelMin, levelMax] = doc.targets.musicLevelDbRange;
    expect(recipe.musicLevelDb).toBeGreaterThanOrEqual(levelMin);
    expect(recipe.musicLevelDb).toBeLessThanOrEqual(levelMax);
    expect(recipe.duckingDb).toBeGreaterThanOrEqual(8);
    expect(recipe.duckingDb).toBeLessThanOrEqual(14);
    for (const platform of recipe.platforms) expect(KNOWN_PLATFORMS.has(platform), `${recipe.id} 平台 ${platform}`).toBe(true);
    expect(recipe.avoid.length).toBeGreaterThanOrEqual(2);
    expect(String(recipe.notes).length).toBeGreaterThan(10);
  });

  it("platformOverrides 只覆盖白名单字段且取值在域内，≥4 条新配方声明", () => {
    const withOverrides = recipes.filter((r) => r.platformOverrides && Object.keys(r.platformOverrides).length);
    expect(withOverrides.length).toBeGreaterThanOrEqual(4);
    for (const recipe of withOverrides) {
      expect(NEW_RECIPES, `${recipe.id} 不应是既有 16 条`).toContain(recipe.id);
      for (const [platform, override] of Object.entries(recipe.platformOverrides as Record<string, Record<string, number>>)) {
        expect(KNOWN_PLATFORMS.has(platform) && platform !== "all", `${recipe.id} 覆盖平台 ${platform}`).toBe(true);
        for (const [field, value] of Object.entries(override)) {
          expect(OVERRIDE_FIELDS.has(field), `${recipe.id}.${platform} 覆盖字段 ${field}`).toBe(true);
          if (field === "musicLevelDb") {
            expect(value).toBeGreaterThanOrEqual(-30);
            expect(value).toBeLessThanOrEqual(-16);
          }
          if (field === "duckingDb") {
            expect(value).toBeGreaterThanOrEqual(8);
            expect(value).toBeLessThanOrEqual(14);
          }
        }
      }
    }
  });
});

describe("② 新题材 brief 关键词命中", () => {
  const CASES: Array<[string, string]> = [
    ["婚礼现场交换戒指，誓言环节要庄重", "wedding"],
    ["中超联赛进球瞬间，赛场高燃快剪", "sports"],
    ["电竞比赛团战击杀集锦，排位上分", "esports"],
    ["时装周走秀街拍，超模穿搭大片", "fashion"],
    ["孕期记录到满月，婴儿哄睡与辅食", "baby-family"],
    ["全屋定制家居漫游，软装收纳前后对比", "home-decor"],
    ["新能源车智驾体验，充电桩续航实测", "auto-ev"],
    ["解读财报，基金投资理财与股市", "finance"],
    ["城市黄昏蓝调时刻，晚霞里的天台", "city-dusk"],
    ["年货市集圣诞布置，跨年倒数", "festival-holiday"],
    ["冷知识：拆解一下背后的原理", "edu-explainer"],
    ["独居一人食，下班路上碎碎念", "vlog-daily"],
    ["异地恋多年后的重逢，告白与和解", "emotional-story"],
    ["品牌宣言：我们的使命与初心", "brand-manifesto"],
    ["萌宠猫咪狗狗，铲屎官视角", "pets"],
    ["健身撸铁力量训练，增肌跟练课程", "workout"],
  ];
  it.each(CASES)("提示词「%s」命中 %s", (promptText, expected) => {
    const { brief } = analyzePromptBrief({ promptText });
    expect(brief.recipeId).toBe(expected);
  });

  it("FC-BGM-001 反例：江南国风口播不被 sports 抢走", () => {
    const { brief, matched } = analyzePromptBrief({ promptText: "江南水乡古镇，口播讲解人文历史" });
    expect(brief.recipeId).not.toBe("sports");
    expect(matched.genres.map((entry) => entry.recipe)).not.toContain("sports");
  });
});

describe("③ platformOverrides 消费", () => {
  it("带平台上下文用覆盖值；不带/未知平台返回配方基准值", () => {
    const sports = byId.get("sports")!;
    expect(applyPlatformOverrides(sports, "douyin")).toMatchObject({ musicLevelDb: -20, duckingDb: 11 });
    expect(applyPlatformOverrides(sports, "douyin").override).toEqual({ platform: "douyin", musicLevelDb: -20, duckingDb: 11 });
    expect(applyPlatformOverrides(sports, "bilibili")).toMatchObject({ musicLevelDb: -18, lufsTarget: -13 });
    expect(applyPlatformOverrides(sports, null)).toMatchObject({ musicLevelDb: -19, duckingDb: 10, override: null });
    expect(applyPlatformOverrides(sports, "tiktok").override).toBeNull();
    const wedding = byId.get("wedding")!;
    expect(applyPlatformOverrides(wedding, "douyin").override).toBeNull(); // 未声明覆盖的配方不生效
  });

  it("bgmread.brief：platform=douyin 时 suggestedRecipe 用覆盖值，不带平台时不变", async () => {
    const promptText = "中超联赛进球瞬间，赛场高燃快剪";
    const withPlatform = await callTool("bgmread.brief", { prompt_text: promptText, platform: "douyin" }) as any;
    expect(withPlatform.result.suggestedRecipe.id).toBe("sports");
    expect(withPlatform.result.suggestedRecipe.musicLevelDb).toBe(-20);
    expect(withPlatform.result.suggestedRecipe.duckingDb).toBe(11);
    expect(withPlatform.result.suggestedRecipe.platformOverride).toEqual({ platform: "douyin", musicLevelDb: -20, duckingDb: 11 });

    const without = await callTool("bgmread.brief", { prompt_text: promptText }) as any;
    expect(without.result.suggestedRecipe.musicLevelDb).toBe(-19);
    expect(without.result.suggestedRecipe.duckingDb).toBe(10);
    expect(without.result.suggestedRecipe.platformOverride).toBeNull();
  });
});

describe("④ 既有配方与题材命中回归", () => {
  it.each(EXISTING_16)("既有配方 %s 电平/让位不变", (id, musicLevelDb, duckingDb) => {
    const recipe = byId.get(id);
    expect(recipe, `缺既有配方 ${id}`).toBeTruthy();
    expect(recipe!.musicLevelDb).toBe(musicLevelDb);
    expect(recipe!.duckingDb).toBe(duckingDb);
    expect(recipe!.platformOverrides).toBeUndefined();
  });

  const REGRESSION: Array<[string, string]> = [
    ["美食探店，出锅特写", "food"],
    ["汽车试驾，发动机声浪", "auto"],
    ["夜景霓虹车流", "night-city"],
    ["双十一大促限时秒杀", "festival-promo"],
    ["母婴亲子家庭出游", "family"],
    ["悬疑反转推理", "suspense"],
    ["高端品牌形象片", "premium-brand"],
  ];
  it.each(REGRESSION)("既有题材「%s」仍命中 %s", (promptText, expected) => {
    expect(analyzePromptBrief({ promptText }).brief.recipeId).toBe(expected);
  });

  it("findRecipes 列表模式透出 platformOverrides（供 best 候选打分消费）", () => {
    const list = findRecipes({ list: true });
    expect(list.total).toBeGreaterThanOrEqual(30);
    const sports = (list.items as Array<Record<string, any>>).find((item) => item.id === "sports")!;
    expect(sports.platformOverrides.douyin).toEqual({ musicLevelDb: -20, duckingDb: 11 });
  });
});
