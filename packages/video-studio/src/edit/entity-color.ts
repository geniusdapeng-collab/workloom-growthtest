/**
 * edit/entity-color.ts —— 实体级局部调色（镜头级调色之下的第二层，2026-10-11 产品所有者口径）。
 *
 * 问题（客户实测）：一支镜头里同时有人和食物时，镜头级 LUT 会把整帧往暖黄推——
 * 食物"暖黄"是对的，人像却跟着变黄，肤色发闷，体验很差。
 * 解法：在镜头级调色**之后**再加一层"按实体"的局部优化：
 *   · 人像 → 美白：提亮 + 收一点饱和 + 去黄（R 略降、B 略升），只作用在人物/肤色掩膜内；
 *   · 食物 → 暖黄：加暖 + 提饱和 + 提对比，只作用在食物掩膜内；
 *   · 两类实体同镜时分别作用、互不串色；掩膜来自视觉工位（macOS Vision：人物分割 + 实例分割 +
 *     分类），本模块只做**纯函数**的计划与滤镜图构建，执行由脚本负责，保证"同输入 → 同计划"。
 *
 * 边界：不改变镜头级调色的既有配方；不做审美评分；掩膜缺失时如实降级（该实体不作用），不猜。
 */

export interface NormalizedRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface EntitySignal {
  segmentId: string;
  /** 人物掩膜面积占比（0–1，多帧并集） */
  personRatio: number;
  /** 人脸框（归一化；无人脸时为空数组） */
  faces: NormalizedRect[];
  /**
   * 人物实例数（Vision 人物实例分割确认；0 = 未确认）。
   * 实测教训（2026-10-11）：俯拍食物镜的**通用**人物分割会把盘子当人（掩膜 63%），
   * 只有实例分割结果或人脸框才算"真人物"的强证据。
   */
  personInstances?: number;
  /** 人物掩膜内肤色证据占比（0–1；诊断证据，不能单独证明是人物） */
  personSkinRatio?: number | null;
  /** 掩膜来源：instance=实例分割强证据；segmentation=通用分割需佐证 */
  personRequest?: string | null;
  /**
   * 采样帧里检出人物的帧数（时间一致性证据）。
   * 实测：苹果树镜头 3 帧里只有 1 帧被误判出"人物实例"（4.9% 掩膜）——
   * 单帧偶发证据不足以开美白。缺省（null/undefined）= 未提供该证据，沿用旧行为。
   */
  personFrames?: number | null;
  /** 食物实例掩膜面积占比（0–1，多帧并集） */
  foodRatio: number;
  /** 食物实例的分类标签（证据；空数组=未识别到食物） */
  foodLabels: string[];
  /** 采样帧里检出食物的帧数（时间一致性证据；缺省=未提供） */
  foodFrames?: number | null;
  /** 采样时刻（片段内秒；供回执复核） */
  sampledAt: number[];
  /** framewise 时每个掩膜仅对应当前解码帧；不能跨帧复用。 */
  maskMode?: "framewise" | "sampled";
  personMaskPath?: string | null;
  foodMaskPath?: string | null;
}

export interface EntityGradeOptions {
  /** 人物掩膜占比阈值（默认 0.6%——太小的一块肤色不值得动） */
  minPersonRatio?: number;
  /** 食物掩膜占比阈值（默认 0.6%） */
  minFoodRatio?: number;
  /** 全局强度 0–1（默认 1；0 等于只出计划不执行） */
  intensity?: number;
  /** 单实体最大不透明度（默认 0.45——局部优化要克制，不能盖过镜头级调色） */
  maxOpacity?: number;
}

export interface EntityGradePlan {
  segmentId: string;
  person: { enabled: boolean; opacity: number; reason: string };
  food: { enabled: boolean; opacity: number; reason: string };
  notes: string[];
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(0, value));
}

function round(value: number, digits = 3): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

/**
 * 实体 → 调色计划。规则（可复算）：
 *   · 人像开启条件：人物掩膜占比 ≥ 阈值，或检出人脸（脸是强证据，哪怕掩膜占比小）；
 *     不透明度 = maxOpacity × min(1, 0.5 + ratio×8) × intensity（占比越大作用越足）；
 *   · 食物开启条件：食物掩膜占比 ≥ 阈值且分类标签命中食物词表（避免把暖色木头当食物）；
 *   · 单镜同时命中时两条都开——这正是"人物不变黄、食物更暖"的关键。
 */
export function planEntityGrade(signal: EntitySignal, options: EntityGradeOptions = {}): EntityGradePlan {
  const minPersonRatio = Number(options.minPersonRatio ?? 0.006);
  const minFoodRatio = Number(options.minFoodRatio ?? 0.006);
  const intensity = clamp01(Number(options.intensity ?? 1));
  const maxOpacity = clamp01(Number(options.maxOpacity ?? 0.45));
  const notes: string[] = [];

  const personRatio = clamp01(Number(signal.personRatio ?? 0));
  const foodRatio = clamp01(Number(signal.foodRatio ?? 0));
  const faces = (signal.faces ?? []).filter((face) => face && face.w > 0 && face.h > 0);
  const personInstances = Math.max(0, Math.round(Number(signal.personInstances ?? 0)));
  const personFrames = signal.personFrames == null ? null : Math.max(0, Math.round(Number(signal.personFrames)));
  const foodFrames = signal.foodFrames == null ? null : Math.max(0, Math.round(Number(signal.foodFrames)));
  const foodLabels = (signal.foodLabels ?? []).filter(Boolean);
  /** 只有分类命中食物词表的实例才算食物——暖色木头/桌面也会被实例分割框出来，误暖比不暖更糟。 */
  const foodLabelHits = foodLabels.filter((label) => isFoodLabel(label));

  /**
   * 食物时间一致性：≥2 个采样帧出现，或单帧就占了 ≥25% 画面（整盘/整锅那种强证据）。
   * 与人物不同：食物误暖一个木桌只是轻微偏色，漏掉"人物+食物同镜"里那道菜反而违背客户口径
   * （实测 seg-004：人脸 + 菜品同镜，但菜只在 1 个采样帧里占比 42%）。
   */
  const foodConsistent = signal.maskMode === "framewise" || foodFrames == null ? true : (foodFrames >= 2 || foodRatio >= 0.25);
  const foodEnabled = foodRatio >= minFoodRatio && foodLabelHits.length > 0 && foodConsistent && Boolean(signal.foodMaskPath) && intensity > 0;
  const foodOpacity = foodEnabled
    ? round(maxOpacity * Math.min(1, 0.5 + foodRatio * 4) * intensity, 3)
    : 0;
  const foodReason = foodEnabled
    ? `食物掩膜 ${(foodRatio * 100).toFixed(1)}%（${foodLabelHits.slice(0, 3).join("/")}）→ 加暖提饱和`
    : (foodRatio > 0 && !foodConsistent
      ? `食物掩膜 ${(foodRatio * 100).toFixed(1)}% 但只在 ${foodFrames} 个采样帧出现且单帧 <25%（判为偶发误检，不作用）`
      : foodRatio > 0
      ? `食物掩膜 ${(foodRatio * 100).toFixed(1)}% 但分类未命中食物词表${foodLabels.length ? `（${foodLabels.slice(0, 3).join("/")}）` : ""}（不作用）`
      : "未检出食物（不作用）");

  const personByMask = personRatio >= minPersonRatio;
  const personByFace = faces.length > 0;
  const personConsistent = signal.maskMode === "framewise" || personFrames == null ? true : personFrames >= 2;
  const instanceEvidence = personInstances > 0 && personConsistent;
  // 通用人物分割与肤色带都可能命中碗盘；没有人脸或人物实例时不能当作人物证据。
  /**
   * 同镜有食物且没有人脸证据时，不做人像美白。
   * 实测（2026-10-11 复核）：俯拍面碗/汤盆会被人物**实例**分割误判成"人"（掩膜 45%–94%，
   * 肤色占比 0.49），若按实例证据美白，等于把面条/汤"洗白"——正是客户要避免的串色。
   * 有人脸则是强证据，照常美白（人物+食物同镜的正常场景）。
   */
  const ambiguousWithFood = foodEnabled && !personByFace;
  const personEvidence = personByFace || (instanceEvidence && !ambiguousWithFood);
  const personEnabled = (personByMask || personByFace) && personEvidence && Boolean(signal.personMaskPath) && intensity > 0;
  const personOpacity = personEnabled
    ? round(maxOpacity * Math.min(1, 0.5 + personRatio * 8) * intensity, 3)
    : 0;
  const personReason = personEnabled
    ? [
      instanceEvidence ? `人物实例 ${personInstances} 个` : null,
      personByFace ? `人脸 ${faces.length} 处` : null,
      personByMask ? `人物掩膜 ${(personRatio * 100).toFixed(1)}%` : null,
      "肤色去黄提亮（美白）",
    ].filter(Boolean).join(" + ")
    : (ambiguousWithFood && personInstances > 0
      ? `同镜有食物（${foodLabelHits.slice(0, 2).join("/")}）且无人脸证据：不美白（避免把碗盘/食物当人）`
      : personInstances > 0 && !personConsistent
      ? `人物实例只在 ${personFrames} 个采样帧出现（<2），判为偶发误检（不作用）`
      : personRatio > 0 && !personEvidence
      ? `人物掩膜 ${(personRatio * 100).toFixed(1)}% 但无人物实例/人脸证据（疑似把食物/桌面误判成人），不作用`
      : personRatio > 0
        ? `人物掩膜 ${(personRatio * 100).toFixed(1)}% 低于阈值 ${(minPersonRatio * 100).toFixed(1)}%（不作用）`
        : "未检出人物/人脸（不作用）");

  if (personEnabled && foodEnabled) {
    notes.push("同镜人物+食物：分别作用——人像美白只吃人物掩膜，食物暖黄只吃食物掩膜，互不串色");
  }
  if (!signal.personMaskPath && (personByMask || personByFace)) notes.push("缺人物掩膜文件，已跳过人像层（如实降级）");
  if (!signal.foodMaskPath && foodRatio > 0) notes.push("缺食物掩膜文件，已跳过食物层（如实降级）");

  return {
    segmentId: signal.segmentId,
    person: { enabled: personEnabled, opacity: personOpacity, reason: personReason },
    food: { enabled: foodEnabled, opacity: foodOpacity, reason: foodReason },
    notes,
  };
}

/** 人像美白链：提亮 + 略收饱和 + 去黄（R 微降、B 微升）+ 轻微提对比，避免"灰白脸"。 */
export const PERSON_WHITEN_CHAIN = "eq=brightness=0.020:saturation=0.97:contrast=1.010,colorbalance=rs=-0.010:gs=0.002:bs=0.015";
/** 食物暖黄链：加暖 + 提饱和 + 提对比，让食物更有食欲。 */
export const FOOD_WARM_CHAIN = "eq=brightness=0.008:saturation=1.06:contrast=1.020,colorbalance=rs=0.030:gs=0.010:bs=-0.030";

export interface EntityFilterOptions {
  width: number;
  height: number;
  /** 人物掩膜输入标签（默认 1:v） */
  personInput?: string;
  /** 食物掩膜输入标签（默认 2:v） */
  foodInput?: string;
  /** 掩膜羽化半径（像素，默认 6；掩膜边缘硬会露边） */
  featherPx?: number;
  /** true 表示原始逐帧掩膜已按本帧不透明度调幅，滤镜不可重复调幅。 */
  masksPreweighted?: boolean;
}

export interface EntityFilterOutcome {
  /** ffmpeg -filter_complex 图；无任何实体时仍给出恒等图，调用方据此决定是否重编码 */
  filterComplex: string;
  /** 输出标签（恒为 vout） */
  outputLabel: string;
  /** 是否真的需要重编码（两条都为 false 时为 false，调用方直接 copy） */
  applied: boolean;
}

/**
 * 构建 ffmpeg filter_complex：
 *   [0:v] → 复制 → 人像链(掩膜1) → 食物链(掩膜2) → [vout]
 * 掩膜一律 format=gray → 羽化 → 缩到画面尺寸 → 按不透明度调幅（lut）→ maskedmerge。
 * 顺序为先人像后食物：食物掩膜通常更"局部"，压在最后一层可保证食物暖黄不会被美白层冲淡。
 */
export function buildEntityFilterComplex(plan: EntityGradePlan, options: EntityFilterOptions): EntityFilterOutcome {
  const width = Math.max(2, Math.round(options.width));
  const height = Math.max(2, Math.round(options.height));
  const feather = Math.max(0, Math.round(options.featherPx ?? 6));
  const personInput = options.personInput ?? "1:v";
  const foodInput = options.foodInput ?? "2:v";
  const person = plan.person.enabled && plan.person.opacity > 0;
  const food = plan.food.enabled && plan.food.opacity > 0;
  if (!person && !food) {
    return { filterComplex: "[0:v]null[vout]", outputLabel: "vout", applied: false };
  }
  const branches = person && food ? 3 : 2;
  const head = branches === 3
    ? "[0:v]format=gbrp,split=3[base][p0][f0]"
    : person ? "[0:v]format=gbrp,split=2[base][p0]" : "[0:v]format=gbrp,split=2[base][f0]";
  const parts: string[] = [head];
  let current = "base";
  if (person) {
    const mask = `[${personInput}]format=gray,scale=${width}:${height}${feather ? `,boxblur=${feather}:1` : ""},lut=y='clip(val*${options.masksPreweighted ? 1 : plan.person.opacity},0,255)',format=gbrp[pm]`;
    parts.push(mask);
    parts.push(`[p0]${PERSON_WHITEN_CHAIN},format=gbrp[pw]`);
    parts.push(`[${current}][pw][pm]maskedmerge[m1]`);
    current = "m1";
  }
  if (food) {
    const mask = `[${foodInput}]format=gray,scale=${width}:${height}${feather ? `,boxblur=${feather}:1` : ""},lut=y='clip(val*${options.masksPreweighted ? 1 : plan.food.opacity},0,255)',format=gbrp[fm]`;
    parts.push(mask);
    parts.push(`[f0]${FOOD_WARM_CHAIN},format=gbrp[fw]`);
    parts.push(`[${current}][fw][fm]maskedmerge[vout]`);
    current = "vout";
  }
  if (current !== "vout") parts.push(`[${current}]format=gbrp[vout]`);
  return { filterComplex: parts.join(";"), outputLabel: "vout", applied: true };
}

export interface EntityReceiptRow {
  segmentId: string;
  person: { enabled: boolean; opacity: number; reason: string };
  food: { enabled: boolean; opacity: number; reason: string };
  notes: string[];
  sampledAt: number[];
}

export function entityReceiptRows(signals: EntitySignal[], plans: EntityGradePlan[]): EntityReceiptRow[] {
  const byId = new Map(plans.map((plan) => [plan.segmentId, plan]));
  return signals.map((signal) => {
    const plan = byId.get(signal.segmentId) ?? planEntityGrade(signal);
    return {
      segmentId: signal.segmentId,
      person: plan.person,
      food: plan.food,
      notes: plan.notes,
      sampledAt: signal.sampledAt,
    };
  });
}

/** 供执行侧写回执时的汇总：应用了几段、其中同镜人物+食物几段。 */
export function summarizeEntityPlans(plans: EntityGradePlan[]): {
  segments: number;
  personSegments: number;
  foodSegments: number;
  bothSegments: number;
} {
  return {
    segments: plans.length,
    personSegments: plans.filter((plan) => plan.person.enabled).length,
    foodSegments: plans.filter((plan) => plan.food.enabled).length,
    bothSegments: plans.filter((plan) => plan.person.enabled && plan.food.enabled).length,
  };
}

/** 食物分类标签词表：Vision 分类结果里命中其一才认为"食物实例"（中英双语 + 常见子类）。 */
export const FOOD_LABEL_HINTS: string[] = [
  "food", "dish", "meal", "cuisine", "dessert", "snack", "breakfast", "lunch", "dinner", "banquet",
  "noodle", "noodles", "soup", "broth", "stew", "hotpot", "dumpling", "dumplings", "rice", "bun", "bread", "pasta",
  "meat", "beef", "pork", "chicken", "lamb", "fish", "seafood", "shrimp", "egg",
  "vegetable", "fruit", "apple", "salad", "cake", "pastry", "pizza", "burger", "taco", "sushi",
  "食物", "美食", "菜", "汤", "面", "饭", "肉", "鱼", "水果", "甜点", "小吃", "火锅", "饺子", "包子", "烧烤",
];

export function isFoodLabel(label: string): boolean {
  const normalized = String(label ?? "").trim().toLowerCase();
  if (!normalized) return false;
  /**
   * 英文标签按**整词**匹配（前缀/复数容差），不做相互包含——
   * 旧写法 `hint.includes(normalized)` 会让 "table" ⊂ "vegetable" 误判成食物。
   */
  const words = normalized.split(/[^a-z0-9\u4e00-\u9fff]+/u).filter(Boolean);
  const chineseDishes = ["羊汤", "牛肉汤", "鸡汤", "凉拌菜", "炒菜", "面条", "米饭", "面包", "鱼汤"];
  if (chineseDishes.includes(normalized)) return true;
  return FOOD_LABEL_HINTS.some((hint) => {
    const target = hint.toLowerCase();
    if (/[\u4e00-\u9fff]/u.test(target)) return words.includes(target);
    return words.some((word) => word === target || word === `${target}s` || word === `${target}es`);
  });
}

/** 当前掩膜乘本帧强度；起效缓入、不延续消失目标，不会把上帧位置带到下一帧。 */
export function weightCurrentMask(mask: Uint8Array, opacity: number, previousOpacity = 0): {
  mask: Uint8Array; opacity: number;
} {
  if (!mask.some((value) => value >= 128) || opacity <= 0) {
    return { mask: new Uint8Array(mask.length), opacity: 0 };
  }
  const currentOpacity = Math.min(clamp01(opacity), clamp01(previousOpacity) + 0.08);
  return { mask: Uint8Array.from(mask, (value) => Math.round(value * currentOpacity)), opacity: currentOpacity };
}
