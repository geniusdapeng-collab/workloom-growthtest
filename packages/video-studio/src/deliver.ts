/**
 * deliver —— 多风格交付包（管线 step_key `deliver`，gate `G-DLV1`）
 *
 * 管线 yml 的口径：**干净母版 + 旁挂字幕 + 2–3 个风格变体（封面/文案/BGM/调色/转场）+ 软字幕轨版 +
 * 交付清单 + 工程文件；镜头只生成一次，变体零 token**（只做后期层派生，绝不重跑渲染）。
 * gate `G-DLV1`：**变体雷同（画面与音轨都测不出差别）一票否决**。
 *
 * 本模块只做"决定 + 判定"的纯逻辑（可单测），真正的 ffmpeg/工位调用在 runner 里：
 *   · `DELIVERY_VARIANTS`   变体配方（调色档 + 文案后缀 + 音乐电平偏移）
 *   · `buildVariantPlan()`  把母版派生成变体的执行计划（含 ffmpeg/工位参数）
 *   · `assessVariantDistinctness()` 画面/音轨双维度差异判定 → G-DLV1 的判据
 *   · `buildDeliveryManifest()`     交付清单（哪支母版、哪些变体、字幕与软轨在哪、各自的指纹）
 */

export interface DeliveryVariant {
  id: string;
  label: string;
  /** 调色档（交给 color-bridge 的 profile；null = 不调色，用母版原样） */
  gradeProfile: string | null;
  gradeIntensity: number;
  /** 音乐电平偏移（dB；0 = 与母版一致） */
  musicLevelDeltaDb: number;
  /** 封面/文案后缀（标题党护栏：只做风格前缀，不改钩子语义） */
  copySuffix: string;
  /** 该变体封面的强调色（#RRGGBB）——三支变体的封面必须互相可区分 */
  coverAccent: string;
  /** 该变体配乐的曲库检索线索（实测 BPM 命中剪辑网格后才允许入选） */
  bgmGenre: string;
  bgmMood: string;
  note: string;
}

/**
 * 三个变体（"风格"要真的是风格，不是换一个滤镜名字）：
 *   · cool-tech 冷调技术感：低饱和冷调（城市/地标/科技题材）
 *   · warm-film 暖调胶片：暖色胶片颗粒（人文/旅行/情绪题材）
 *   · punchy-social 社交高对比：对比与饱和提起来（信息流里"跳出来"，小红书/抖音）
 * 干净母版本身是交付物的主件（不烧字/不调色的那支），不占变体名额。
 *
 * 2026-09-26 产品所有者口径：**一次必须产出 3 个不同风格的后期版本**，
 * 且三支要在**封面 / 配乐 / 调色**三个维度上都不同（只换滤镜名不算）。
 */
export const DELIVERY_VARIANTS: DeliveryVariant[] = [
  /** 曲风线索用 `|` 分隔多个候选词，与曲库标签（如「游戏 / 电子」「旅拍 / 生活」「卡点 / 律动」）对齐 */
  { id: "cool-tech", label: "冷调技术感", gradeProfile: "cool-technical", gradeIntensity: 0.55, musicLevelDeltaDb: 0, copySuffix: "｜冷调", coverAccent: "#6FD3E8", bgmGenre: "游戏|电子|史诗", bgmMood: "律动兴奋|宏大推进|安静舒缓", note: "低饱和冷调，适合城市/地标" },
  { id: "warm-film", label: "暖调胶片", gradeProfile: "warm-film", gradeIntensity: 0.5, musicLevelDeltaDb: 1.5, copySuffix: "｜暖调", coverAccent: "#E8B44A", bgmGenre: "旅拍|生活", bgmMood: "温暖自在|松弛平和", note: "暖色胶片，适合人文/旅行" },
  { id: "punchy-social", label: "社交高对比", gradeProfile: "high-contrast-social", gradeIntensity: 0.45, musicLevelDeltaDb: 0.5, copySuffix: "｜高对比", coverAccent: "#FF6A5A", bgmGenre: "轻快|卡点", bgmMood: "律动兴奋|明快愉悦", note: "信息流跳脱，适合小红书/抖音封面流" }
];

/** 交付包最少变体数（产品口径：一次产出 3 个不同风格的后期版本让用户选） */
export const VARIANT_MIN_COUNT = 3;

export interface VariantAxesEntry {
  id: string;
  gradeProfile: string | null;
  /** 变体封面指纹（缺 = 该变体没出封面） */
  coverSha?: string | null;
  /** 变体配乐指纹（缺 = 该变体没换曲） */
  bgmSha?: string | null;
}

export interface VariantAxesReport {
  ok: boolean;
  count: number;
  missing: string[];
  detail: string;
}

/**
 * 三轴判据：数量 ≥3，且 **调色 / 封面 / 配乐** 三个维度上都不能出现"两支一样"。
 * 为什么是硬判据：2026-09-26 产品所有者点名"我看系统里有一次产出几个版本的约束，为什么没执行"——
 * 除了"阶段没被调用"这个执行问题，约束本身也只有"≥2 且画面/音轨可测差异"，
 * 允许"三支只有滤镜不同、封面与配乐完全一样"混过去。这里把口径收紧到产品意图。
 */
export function assessVariantAxes(variants: VariantAxesEntry[]): VariantAxesReport {
  const count = variants.length;
  const missing: string[] = [];
  const duplicate = (key: "gradeProfile" | "coverSha" | "bgmSha", label: string): string | null => {
    const seen = new Map<string, string>();
    for (const variant of variants) {
      const value = variant[key];
      if (value === null || value === undefined || value === "") {
        missing.push(`${variant.id} 缺${label}`);
        continue;
      }
      const previous = seen.get(String(value));
      if (previous) return `${previous} 与 ${variant.id} 的${label}相同（${String(value).slice(0, 12)}）`;
      seen.set(String(value), variant.id);
    }
    return null;
  };
  const problems: string[] = [];
  if (count < VARIANT_MIN_COUNT) {
    problems.push(`变体数 ${count} < ${VARIANT_MIN_COUNT}（产品口径：一次产出 3 个不同风格的后期版本让用户选）`);
  }
  const dupGrade = duplicate("gradeProfile", "调色档");
  const dupCover = duplicate("coverSha", "封面");
  const dupBgm = duplicate("bgmSha", "配乐");
  for (const item of [dupGrade, dupCover, dupBgm]) if (item) problems.push(item);
  if (problems.length === 0 && missing.length === 0) {
    return {
      ok: true, count, missing,
      detail: `${count} 支变体在 调色/封面/配乐 三轴上两两不同（${variants.map((v) => v.id).join("、")}）`,
    };
  }
  return {
    ok: false, count, missing,
    detail: [...problems, ...(missing.length > 0 ? [`缺项：${missing.join("；")}`] : [])].join("；"),
  };
}

export interface VariantPlan {
  variant: DeliveryVariant;
  output: string;
  /** 是否为"零改动"变体（直接复制母版，不做调色/混音） */
  passthrough: boolean;
  /** 交给 color-bridge grade 的参数（passthrough 时为空数组） */
  gradeArgs: string[];
  coverCopy: string;
}

export function buildVariantPlan(options: {
  master: string;
  outDir: string;
  projectId: string;
  coverHook: string;
  variants?: DeliveryVariant[];
}): VariantPlan[] {
  const variants = options.variants ?? DELIVERY_VARIANTS;
  return variants.map((variant) => ({
    variant,
    output: `${options.outDir}/${options.projectId}-variant-${variant.id}.mp4`,
    passthrough: variant.gradeProfile === null,
    gradeArgs: variant.gradeProfile
      ? ["grade", "--in", options.master, "--profile", variant.gradeProfile, "--intensity", String(variant.gradeIntensity)]
      : [],
    coverCopy: `${options.coverHook}${variant.copySuffix}`
  }));
}

export interface VariantSample {
  variantId: string;
  /** 抽帧的平均 RGB（0–255）× N 帧 */
  frames: Array<{ r: number; g: number; b: number }>;
  /** 整片响度与真峰值（LUFS / dBTP） */
  loudness: { lufs: number; peakDb: number } | null;
}

export interface DistinctnessPair {
  a: string;
  b: string;
  videoDelta: number;
  audioDelta: number;
  identical: boolean;
}

export interface DistinctnessReport {
  pairs: DistinctnessPair[];
  /** G-DLV1：存在"画面与音轨都测不出差别"的一对 → 一票否决 */
  worstPair: DistinctnessPair | null;
  approved: boolean;
  detail: string;
}

const meanColor = (frames: Array<{ r: number; g: number; b: number }>): { r: number; g: number; b: number } => {
  if (frames.length === 0) return { r: 0, g: 0, b: 0 };
  const sum = frames.reduce((acc, f) => ({ r: acc.r + f.r, g: acc.g + f.g, b: acc.b + f.b }), { r: 0, g: 0, b: 0 });
  return { r: sum.r / frames.length, g: sum.g / frames.length, b: sum.b / frames.length };
};

/**
 * G-DLV1 判定（阈值口径写在参数里，便于审计复核）：
 *   · 画面差异 = 平均色差的欧氏距离（0–441）。**< 6 视为"画面测不出差别"**（≈肉眼同色）；
 *   · 音轨差异 = |LUFS 差| + |真峰值差|。**< 1.0 视为"音轨测不出差别"**；
 *   · 两者同时低于阈值 → `identical = true` → 该对变体雷同，交付包 **不放行**（要真的做出风格差异）。
 */
export function assessVariantDistinctness(
  samples: VariantSample[],
  thresholds: { videoDelta: number; audioDelta: number } = { videoDelta: 6, audioDelta: 1.0 }
): DistinctnessReport {
  const pairs: DistinctnessPair[] = [];
  const invalid = (detail: string): DistinctnessReport => ({
    pairs: [], worstPair: null, approved: false, detail: `变体差异未核实：${detail}`,
  });
  if (!Array.isArray(samples) || samples.length < 2) return invalid("至少需要两支变体的实际测量，空集或单样本不能证明差异");
  if (![thresholds.videoDelta, thresholds.audioDelta].every((value) => Number.isFinite(value) && value > 0)) {
    return invalid("差异阈值必须为正有限数");
  }
  const ids = new Set<string>();
  for (const sample of samples) {
    if (!sample || typeof sample.variantId !== "string" || !sample.variantId.trim() || ids.has(sample.variantId)) return invalid("变体标识缺失或重复");
    ids.add(sample.variantId);
    if (!Array.isArray(sample.frames) || sample.frames.length === 0 || sample.frames.some((frame) =>
      !frame || ![frame.r, frame.g, frame.b].every((value) => Number.isFinite(value) && value >= 0 && value <= 255))) {
      return invalid(`${sample.variantId} 缺有效抽帧测量`);
    }
    if (sample.loudness !== null && (!sample.loudness
      || ![sample.loudness.lufs, sample.loudness.peakDb].every(Number.isFinite))) return invalid(`${sample.variantId} 响度测量非法`);
  }
  for (let i = 0; i < samples.length; i += 1) {
    for (let j = i + 1; j < samples.length; j += 1) {
      const a = samples[i]!;
      const b = samples[j]!;
      const ca = meanColor(a.frames);
      const cb = meanColor(b.frames);
      const videoDelta = Math.round(Math.sqrt(((ca.r - cb.r) ** 2 + (ca.g - cb.g) ** 2 + (ca.b - cb.b) ** 2)) * 100) / 100;
      const audioDelta = a.loudness && b.loudness
        ? Math.round((Math.abs(a.loudness.lufs - b.loudness.lufs) + Math.abs(a.loudness.peakDb - b.loudness.peakDb)) * 100) / 100
        : 0;
      pairs.push({
        a: a.variantId, b: b.variantId, videoDelta, audioDelta,
        identical: videoDelta < thresholds.videoDelta && audioDelta < thresholds.audioDelta
      });
    }
  }
  const worstPair = pairs.find((pair) => pair.identical) ?? null;
  return {
    pairs,
    worstPair,
    approved: worstPair === null,
    detail: worstPair
      ? `变体雷同（G-DLV1 一票否决）：${worstPair.a} 与 ${worstPair.b} 的画面差 ${worstPair.videoDelta}（阈值 ${thresholds.videoDelta}）、音轨差 ${worstPair.audioDelta}（阈值 ${thresholds.audioDelta}）——风格差异测不出来，不能算两个变体`
      : `变体差异达标：${pairs.map((p) => `${p.a}×${p.b} 画面 ${p.videoDelta}/音轨 ${p.audioDelta}`).join("；")}`
  };
}

export interface DeliverableNamingAudit {
  ok: boolean;
  /** 文件名里写明的时长（秒；识别不到为 null） */
  claimedDurationSec: number | null;
  /** 成片实际时长（秒） */
  actualDurationSec: number;
  detail: string;
  /** 与成片口径一致的改名建议（名字里没写时长时为 null） */
  suggestedName: string | null;
}

/**
 * 文件名 / 成片时长口径审计（2026-09-26 真机事故）：
 * 交付清单 `deliverable.path` 指到 `…-30s-final.mp4`，而实际成片是 51.07s——
 * 发布方按路径/文件名核对就踩空（"这到底是不是那支片？"）。
 * 纪律：**文件名里写明的时长必须与成片实际时长一致（±1s）**；不一致就给改名建议并判不合格。
 */
export function auditDeliverableNaming(input: {
  path: string;
  durationSec: number;
  toleranceSec?: number;
}): DeliverableNamingAudit {
  const tolerance = input.toleranceSec ?? 1;
  const actual = Number(input.durationSec ?? 0);
  const file = input.path.split("/").pop() ?? input.path;
  /** 支持 `-30s-`、`_48s.`、`-48秒-`、`-51sec-` 等写法 */
  const match = file.match(/(\d{1,3})\s*(?:s(?:ec)?|秒)(?![a-z])/i);
  if (!(actual > 0)) {
    return {
      ok: false, claimedDurationSec: match ? Number(match[1]) : null, actualDurationSec: actual,
      detail: `成片时长未知（${input.durationSec}），无法核对文件名口径`, suggestedName: null,
    };
  }
  if (!match) {
    return {
      ok: true, claimedDurationSec: null, actualDurationSec: Number(actual.toFixed(2)),
      detail: `文件名未写时长（${file}）；成片实际 ${actual.toFixed(2)}s——建议文件名带时长便于发布方核对`,
      suggestedName: null,
    };
  }
  const claimed = Number(match[1]);
  const delta = Math.abs(claimed - actual);
  const suggested = file.replace(match[0], `${Math.round(actual)}s`);
  if (delta <= tolerance) {
    return {
      ok: true, claimedDurationSec: claimed, actualDurationSec: Number(actual.toFixed(2)),
      detail: `文件名时长 ${claimed}s 与成片 ${actual.toFixed(2)}s 一致（容差 ±${tolerance}s）`,
      suggestedName: null,
    };
  }
  return {
    ok: false, claimedDurationSec: claimed, actualDurationSec: Number(actual.toFixed(2)),
    detail: `文件名时长 ${claimed}s 与成片实际 ${actual.toFixed(2)}s 不符（差 ${delta.toFixed(2)}s > 容差 ±${tolerance}s）：`
      + `发布方按名字核对会踩空，建议改名为 ${suggested}`,
    suggestedName: suggested,
  };
}

export interface DeliveryManifest {
  projectId: string;
  generatedAt: string;
  platform: string;
  deliverable: {
    path: string; sha256: string; bytes: number;
    /** 成片实际时长（秒）——与文件名里的时长口径同源，发布方核对时不再踩空 */
    durationSec?: number;
    /** 文件名签发时长审计（见 auditDeliverableNaming） */
    namingAudit?: DeliverableNamingAudit;
  };
  subtitles: { sidecarDir: string | null; softsub: string | null; burned: boolean };
  cover: { path: string | null; hook: string };
  variants: Array<{
    id: string; label: string; path: string; sha256: string; note: string; gradeProfile: string | null;
    /** 该变体自己的封面（三轴口径：封面必须互相可区分） */
    cover?: { path: string; sha256: string } | null;
    /** 该变体自己的配乐（曲库曲目 + 实测 BPM/卡点偏差） */
    bgm?: { track: string; sha256: string; measuredBpm?: number; gridErrorMs?: number } | null;
  }>;
  /** G-DLV1 判定结果（雷同一票否决） */
  distinctness: DistinctnessReport;
  /** 三轴判据（数量 ≥3 且 调色/封面/配乐 两两不同） */
  variantAxes?: VariantAxesReport;
  /** 证据：变体测量原始值（审计可复核） */
  samples: VariantSample[];
  reuseDiscipline: string;
}

export function buildDeliveryManifest(input: {
  projectId: string;
  platform: string;
  deliverable: DeliveryManifest["deliverable"];
  subtitles: { sidecarDir: string | null; softsub: string | null; burned: boolean };
  cover: { path: string | null; hook: string };
  variants: DeliveryManifest["variants"];
  distinctness: DistinctnessReport;
  variantAxes?: VariantAxesReport;
  samples: VariantSample[];
  at?: string;
}): DeliveryManifest {
  return {
    projectId: input.projectId,
    generatedAt: input.at ?? new Date().toISOString(),
    platform: input.platform,
    deliverable: input.deliverable,
    subtitles: input.subtitles,
    cover: input.cover,
    variants: input.variants,
    distinctness: input.distinctness,
    ...(input.variantAxes ? { variantAxes: input.variantAxes } : {}),
    samples: input.samples,
    reuseDiscipline: "变体只做后期层派生（调色/混音/文案），镜头不重新生成（零 token）；每支变体带 sha256 便于发布方核对"
  };
}
