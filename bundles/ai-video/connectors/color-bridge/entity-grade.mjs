/**
 * 实体级局部调色（镜头级调色之下的第二层；2026-10-11 产品所有者口径）。
 *
 * 问题：一支镜头里同时有人和食物时，镜头级 LUT 会把整帧往暖黄推——食物对了，人像跟着变黄。
 * 解法：镜头级调色**之后**再加一层按实体的局部优化：
 *   · 人像 → 美白（提亮 + 略收饱和 + 去黄），只作用在人物掩膜内；
 *   · 食物 → 暖黄（加暖 + 提饱和 + 提对比），只作用在食物掩膜内；
 *   · 同镜两类实体分别作用、互不串色。
 *
 * 本模块是**纯函数**（计划 + ffmpeg 滤镜图 + 判定），执行与掩膜生成由工作流负责；
 * 掩膜来源（macOS Vision：人物实例分割 + 前景实例分类）见视频剪辑管线的 vision-entity 工具。
 */

export const PERSON_WHITEN_CHAIN = "eq=brightness=0.045:saturation=0.90:contrast=1.015,colorbalance=rs=-0.020:gs=0.004:bs=0.030";
export const FOOD_WARM_CHAIN = "eq=brightness=0.012:saturation=1.10:contrast=1.030,colorbalance=rs=0.050:gs=0.015:bs=-0.055";

const clamp01 = (value) => (Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : 0);
const round = (value, digits = 3) => {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
};

export const FOOD_LABEL_HINTS = [
  "food", "dish", "meal", "cuisine", "dessert", "snack", "breakfast", "lunch", "dinner", "banquet",
  "noodle", "noodles", "soup", "broth", "stew", "hotpot", "dumpling", "dumplings", "rice", "bun", "bread", "pasta",
  "meat", "beef", "pork", "chicken", "lamb", "fish", "seafood", "shrimp", "egg",
  "vegetable", "fruit", "apple", "salad", "cake", "pastry", "pizza", "burger", "taco", "sushi",
  "食物", "美食", "菜", "汤", "面", "饭", "肉", "鱼", "水果", "甜点", "小吃", "火锅", "饺子", "包子", "烧烤",
];

/** 英文标签按整词（前缀/复数容差）匹配——旧写法 hint.includes(word) 会让 table ⊂ vegetable 误判食物。 */
export function isFoodLabel(label) {
  const normalized = String(label ?? "").trim().toLowerCase();
  if (!normalized) return false;
  const words = normalized.split(/[^a-z0-9\u4e00-\u9fff]+/u).filter(Boolean);
  return FOOD_LABEL_HINTS.some((hint) => {
    const target = hint.toLowerCase();
    if (!target) return false;
    if (/[\u4e00-\u9fff]/u.test(target)) return normalized.includes(target);
    return words.some((word) => word === target
      || (target.length >= 4 && word.startsWith(target))
      || (word.length >= 4 && target.startsWith(word)));
  });
}

/**
 * 实体信号 → 调色计划。
 * 人物证据纪律（实测 2026-10-11）：俯拍食物镜的**通用人物分割**会把盘子当人（掩膜 63%、肤色占比 0.82），
 * 所以只有「人物实例分割确认」或「人脸框」才算强证据；仅凭肤色 + 通用分割、且镜头已有食物证据时不美白。
 */
export function planEntityGrade(signal, options = {}) {
  const minPersonRatio = Number(options.minPersonRatio ?? 0.006);
  const minFoodRatio = Number(options.minFoodRatio ?? 0.006);
  const intensity = clamp01(Number(options.intensity ?? 1));
  const maxOpacity = clamp01(Number(options.maxOpacity ?? 0.85));
  const personRatio = clamp01(Number(signal.personRatio ?? 0));
  const foodRatio = clamp01(Number(signal.foodRatio ?? 0));
  const faces = (signal.faces ?? []).filter((face) => face && face.w > 0 && face.h > 0);
  const personInstances = Math.max(0, Math.round(Number(signal.personInstances ?? 0)));
  const personSkinRatio = signal.personSkinRatio == null ? null : clamp01(Number(signal.personSkinRatio));
  const foodLabels = (signal.foodLabels ?? []).filter(Boolean);
  const foodLabelHits = foodLabels.filter((label) => isFoodLabel(label));
  const notes = [];

  const foodEnabled = foodRatio >= minFoodRatio && foodLabelHits.length > 0 && intensity > 0;
  const foodOpacity = foodEnabled ? round(maxOpacity * Math.min(1, 0.5 + foodRatio * 4) * intensity, 3) : 0;
  const foodReason = foodEnabled
    ? `食物掩膜 ${(foodRatio * 100).toFixed(1)}%（${foodLabelHits.slice(0, 3).join("/")}）→ 加暖提饱和`
    : (foodRatio > 0
      ? `食物掩膜 ${(foodRatio * 100).toFixed(1)}% 但分类未命中食物词表（不作用）`
      : "未检出食物（不作用）");

  const personByMask = personRatio >= minPersonRatio;
  const personByFace = faces.length > 0;
  const instanceEvidence = personInstances > 0;
  const fallbackEvidence = String(signal.personRequest ?? "") === "segmentation"
    && personRatio >= minPersonRatio && (personSkinRatio ?? 0) >= 0.15 && !foodEnabled;
  const personEvidence = instanceEvidence || personByFace || fallbackEvidence;
  const personEnabled = (personByMask || personByFace) && personEvidence && intensity > 0;
  const personOpacity = personEnabled ? round(maxOpacity * Math.min(1, 0.5 + personRatio * 8) * intensity, 3) : 0;
  const personReason = personEnabled
    ? [
      instanceEvidence ? `人物实例 ${personInstances} 个` : null,
      personByFace ? `人脸 ${faces.length} 处` : null,
      personByMask ? `人物掩膜 ${(personRatio * 100).toFixed(1)}%` : null,
      fallbackEvidence && !instanceEvidence && !personByFace ? `肤色证据 ${((personSkinRatio ?? 0) * 100).toFixed(0)}%` : null,
      "肤色去黄提亮（美白）",
    ].filter(Boolean).join(" + ")
    : (personRatio > 0 && !personEvidence
      ? `人物掩膜 ${(personRatio * 100).toFixed(1)}% 但无人物实例/人脸证据（疑似把食物/桌面误判成人），不作用`
      : personRatio > 0
        ? `人物掩膜 ${(personRatio * 100).toFixed(1)}% 低于阈值（不作用）`
        : "未检出人物/人脸（不作用）");

  if (personEnabled && foodEnabled) notes.push("同镜人物+食物：分别作用——人像美白只吃人物掩膜，食物暖黄只吃食物掩膜，互不串色");
  if (signal.personMaskPath == null && personEnabled) notes.push("缺人物掩膜文件，执行侧应跳过人像层（如实降级）");
  if (signal.foodMaskPath == null && foodEnabled) notes.push("缺食物掩膜文件，执行侧应跳过食物层（如实降级）");

  return {
    segmentId: signal.segmentId,
    person: { enabled: personEnabled, opacity: personOpacity, reason: personReason },
    food: { enabled: foodEnabled, opacity: foodOpacity, reason: foodReason },
    notes,
  };
}

/**
 * 构建 ffmpeg filter_complex：base → 人像美白（掩膜1）→ 食物暖黄（掩膜2）→ [vout]。
 * 两条都不可用返回恒等图（applied=false，调用方直接 copy、不重编码）。
 */
export function buildEntityFilterComplex(plan, options) {
  const width = Math.max(2, Math.round(options.width));
  const height = Math.max(2, Math.round(options.height));
  const feather = Math.max(0, Math.round(options.featherPx ?? 6));
  const personInput = options.personInput ?? "1:v";
  const foodInput = options.foodInput ?? "2:v";
  const person = plan.person.enabled && plan.person.opacity > 0;
  const food = plan.food.enabled && plan.food.opacity > 0;
  if (!person && !food) return { filterComplex: "[0:v]null[vout]", outputLabel: "vout", applied: false };
  const head = person && food
    ? "[0:v]split=3[base][p0][f0]"
    : person ? "[0:v]split=2[base][p0]" : "[0:v]split=2[base][f0]";
  const parts = [head];
  let current = "base";
  if (person) {
    parts.push(`[${personInput}]format=gray${feather ? `,boxblur=${feather}:1` : ""},scale=${width}:${height},lut=y='clip(val*${plan.person.opacity},0,255)'[pm]`);
    parts.push(`[p0]${PERSON_WHITEN_CHAIN}[pw]`);
    parts.push(`[${current}][pw][pm]maskedmerge[m1]`);
    current = "m1";
  }
  if (food) {
    parts.push(`[${foodInput}]format=gray${feather ? `,boxblur=${feather}:1` : ""},scale=${width}:${height},lut=y='clip(val*${plan.food.opacity},0,255)'[fm]`);
    parts.push(`[f0]${FOOD_WARM_CHAIN}[fw]`);
    parts.push(`[${current}][fw][fm]maskedmerge[vout]`);
    current = "vout";
  }
  if (current !== "vout") parts.push(`[${current}]format=yuv420p[vout]`);
  return { filterComplex: parts.join(";"), outputLabel: "vout", applied: true };
}

export function summarizeEntityPlans(plans) {
  return {
    segments: plans.length,
    personSegments: plans.filter((plan) => plan.person.enabled).length,
    foodSegments: plans.filter((plan) => plan.food.enabled).length,
    bothSegments: plans.filter((plan) => plan.person.enabled && plan.food.enabled).length,
  };
}
