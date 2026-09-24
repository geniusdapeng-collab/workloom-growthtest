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
  note: string;
}

/**
 * 三个变体（"风格"要真的是风格，不是换一个滤镜名字）：
 *   · cool-tech 冷调技术感：低饱和冷调（城市/地标/科技题材）
 *   · warm-film 暖调胶片：暖色胶片颗粒（人文/旅行/情绪题材）
 *   · punchy-social 社交高对比：对比与饱和提起来（信息流里"跳出来"，小红书/抖音）
 * 干净母版本身是交付物的主件（不烧字/不调色的那支），不占变体名额。
 */
export const DELIVERY_VARIANTS: DeliveryVariant[] = [
  { id: "cool-tech", label: "冷调技术感", gradeProfile: "cool-technical", gradeIntensity: 0.55, musicLevelDeltaDb: 0, copySuffix: "｜冷调", note: "低饱和冷调，适合城市/地标" },
  { id: "warm-film", label: "暖调胶片", gradeProfile: "warm-film", gradeIntensity: 0.5, musicLevelDeltaDb: 1.5, copySuffix: "｜暖调", note: "暖色胶片，适合人文/旅行" },
  { id: "punchy-social", label: "社交高对比", gradeProfile: "high-contrast-social", gradeIntensity: 0.45, musicLevelDeltaDb: 0.5, copySuffix: "｜高对比", note: "信息流跳脱，适合小红书/抖音封面流" }
];

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

export interface DeliveryManifest {
  projectId: string;
  generatedAt: string;
  platform: string;
  deliverable: { path: string; sha256: string; bytes: number };
  subtitles: { sidecarDir: string | null; softsub: string | null; burned: boolean };
  cover: { path: string | null; hook: string };
  variants: Array<{ id: string; label: string; path: string; sha256: string; note: string; gradeProfile: string | null }>;
  /** G-DLV1 判定结果（雷同一票否决） */
  distinctness: DistinctnessReport;
  /** 证据：变体测量原始值（审计可复核） */
  samples: VariantSample[];
  reuseDiscipline: string;
}

export function buildDeliveryManifest(input: {
  projectId: string;
  platform: string;
  deliverable: { path: string; sha256: string; bytes: number };
  subtitles: { sidecarDir: string | null; softsub: string | null; burned: boolean };
  cover: { path: string | null; hook: string };
  variants: DeliveryManifest["variants"];
  distinctness: DistinctnessReport;
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
    samples: input.samples,
    reuseDiscipline: "变体只做后期层派生（调色/混音/文案），镜头不重新生成（零 token）；每支变体带 sha256 便于发布方核对"
  };
}
