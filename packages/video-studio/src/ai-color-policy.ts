/** AI-generated pictures keep their rendered look unless a separate variant requests a look. */
import type { DeliveryVariant } from "./deliver.js";

export const AI_COLOR_POLICY_VERSION = "2026-10-15.1";
export type ColorCategory = "color-accurate" | "night" | "food" | "portrait" | "landscape" | "energetic" | "mixed" | "unknown";
export interface ContentColorDecision {
  policyVersion: string;
  category: ColorCategory;
  evidence: Array<{ shotId: string; attributes: string; seconds: number; categories: string[] }>;
  weightedShares: Record<string, number>;
  reasons: string[];
  limitations: string[];
}

const fields = ["scene", "sceneType", "sceneDescription", "description", "lighting", "color_palette", "colorPalette", "mood", "subject", "genre", "theme", "character", "characters"];
function text(value: unknown, depth = 0): string {
  if (typeof value === "string") return value.slice(0, 2000);
  if (depth > 2 || value === null || typeof value !== "object") return "";
  if (Array.isArray(value)) return value.slice(0, 20).map(item => text(item, depth + 1)).join(" ");
  return Object.values(value).slice(0, 20).map(item => text(item, depth + 1)).join(" ");
}
const rules = {
  "color-accurate": /商品|产品|品牌色|色卡|准确还原|珠宝|服装展示|product|catalog|brand.colou?r|color.accuracy/i,
  night: /夜景|夜晚|低照|暗调|霓虹|夜色|night|low.light|low.key|neon/i,
  food: /美食|食物|餐桌|烹饪|菜肴|水果|food|cooking|cuisine|meal|fruit/i,
  portrait: /人像|人物|家人|家庭|婚礼|面部|皮肤|肖像|portrait|family|wedding|skin|face/i,
  landscape: /风景|山水|自然|田野|森林|海洋|旅行|landscape|scenery|forest|ocean|travel/i,
  energetic: /运动|赛事|活力|节奏|动作|sports|action|energetic/i,
} as const;

/** Uses declared content, never invents a pixel analysis or an artistic approval. */
export function designContentColor(content: unknown): { profile: string; intensity: number; decision: ContentColorDecision } {
  const document = content && typeof content === "object" ? content as Record<string, unknown> : {};
  const shots = Array.isArray(document.shots) ? document.shots.filter((shot): shot is Record<string, unknown> => !!shot && typeof shot === "object" && !Array.isArray(shot)) : [];
  const rows = shots.length ? shots : [document];
  const totals: Record<string, number> = Object.fromEntries(Object.keys(rules).map(key => [key, 0]));
  let total = 0;
  const evidence: ContentColorDecision["evidence"] = rows.map((shot, index) => {
    const declared = Number(shot.durationSeconds ?? shot.durationSec ?? shot.duration ?? 0);
    const seconds = Number.isFinite(declared) && declared > 0 ? Math.min(declared, 86400) : 1;
    total += seconds;
    const attributes = fields.map(key => text(shot[key])).filter(Boolean).join(" ").slice(0, 12000);
    const categories = Object.entries(rules).filter(([, rule]) => rule.test(attributes)).map(([category]) => category);
    if (shot.colorAccuracy === true && !categories.includes("color-accurate")) categories.push("color-accurate");
    for (const category of categories) totals[category]! += seconds;
    return { shotId: String(shot.shotId ?? shot.id ?? index + 1), attributes, seconds, categories };
  });
  const weightedShares = Object.fromEntries(Object.entries(totals).map(([key, value]) => [key, Number((value / total).toFixed(4))]));
  const ranked = Object.entries(weightedShares).filter(([, share]) => share > 0).sort((a, b) => b[1] - a[1]);
  let category: ColorCategory;
  if (document.colorAccuracy === true || (weightedShares["color-accurate"] ?? 0) > 0) category = "color-accurate";
  else if ((weightedShares.night ?? 0) >= 0.25) category = "night";
  else if (!ranked.length) category = "unknown";
  else if (ranked[0]![1] < 0.5 || (ranked[1] && ranked[1][1] >= 0.35 && ranked[0]![1] - ranked[1][1] < 0.15)) category = "mixed";
  else category = ranked[0]![0] as ColorCategory;
  const choices: Record<ColorCategory, { profile: string; intensity: number; reason: string }> = {
    "color-accurate": { profile: "natural", intensity: 0.12, reason: "商品或准确还原约束优先：不偏移色温，仅作极轻的对比与饱和调整。" },
    night: { profile: "natural", intensity: 0.15, reason: "保留低照和夜色，不套自动提亮、暖色 LUT 或压黑曲线。" },
    food: { profile: "natural", intensity: 0.28, reason: "食物以可辨认的本色和白色餐具为先，克制增加层次。" },
    portrait: { profile: "warm-film", intensity: 0.18, reason: "人像或家庭内容使用轻暖配方，强度低于 D 组以保护肤色。" },
    landscape: { profile: "natural", intensity: 0.45, reason: "风光保持天空、植被本色，增加适量对比与饱和层次。" },
    energetic: { profile: "high-contrast-social", intensity: 0.22, reason: "动作和运动内容采用较轻的高对比，不叠加暖色 LUT。" },
    mixed: { profile: "natural", intensity: 0.18, reason: "多个题材并存，使用保守的全片配方，避免少数镜头决定全片色偏。" },
    unknown: { profile: "natural", intensity: 0.12, reason: "缺少可用内容属性，采用保守配方并明确标记未判定题材。" },
  };
  const chosen = choices[category];
  return { profile: chosen.profile, intensity: chosen.intensity, decision: { policyVersion: AI_COLOR_POLICY_VERSION, category, evidence, weightedShares,
    reasons: [chosen.reason], limitations: ["依据分镜中已声明的内容属性与时长选择全片配方，未进行像素、肤色分割或艺术评分。", "自动方案是可复核的建议，不声称对所有镜头都达到最佳观感。"] } };
}

export function defaultAiColorVariants(content?: unknown): DeliveryVariant[] {
  const designed = designContentColor(content);
  return [
    { id: "original", label: "原色", gradeProfile: null, gradeIntensity: 0, musicLevelDeltaDb: 0, copySuffix: "", coverAccent: "#E8E2D5",
      bgmGenre: "生活|自然", bgmMood: "安静舒缓|松弛平和", note: "保留渲染素材的创作色彩；后期共同源直接复制，不调用调色工位。" },
    { id: "warm-story", label: "暖调故事", gradeProfile: "high-contrast-social", gradeLut: "look-warm-film.cube", gradeIntensity: 0.5,
      musicLevelDeltaDb: 1.5, copySuffix: "｜暖调", coverAccent: "#E8B44A", bgmGenre: "旅拍|生活", bgmMood: "温暖自在|松弛平和",
      note: "D 组配方：high-contrast-social + look-warm-film.cube，强度 0.5；从未调色共同源独立派生。" },
    { id: "content-auto", label: "内容调色", gradeProfile: designed.profile, gradeIntensity: designed.intensity, colorDecision: designed.decision,
      musicLevelDeltaDb: 0.5, copySuffix: "", coverAccent: "#6FA8A4", bgmGenre: "生活|轻快", bgmMood: "松弛平和|明快愉悦",
      note: designed.decision.reasons.join(" ") },
  ];
}
