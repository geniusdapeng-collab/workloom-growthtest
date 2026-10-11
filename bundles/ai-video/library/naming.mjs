/**
 * 交付文件命名规范（唯一事实源；2026-10-11 产品所有者口径）。
 *
 * 中文名 = 片名 · 版本名 · 核心特点 · 分辨率 · 版本号；`·` 分隔、无空格；
 * 分辨率一律按产出文件**实测值**换算（4K / 2K / 1080P / 720P），预览件额外标注「预览」。
 * 例：别人挤景区我回村摘苹果·暖调故事版·带字幕·4K·V10.mp4
 *
 * 为什么进 bundle：文件名是用户拿到交付包后第一眼看到的东西。旧命名（warm-story.burned.cover.mp4、
 * v9-warm-story-1080p.mp4）用户看不懂哪条能直接发，分辨率还跟实测脱钩。
 */

/** 分辨率徽标：按短边换算成用户口语里的档位。 */
export function resolutionBadge(size) {
  const width = Number(size?.width ?? 0);
  const height = Number(size?.height ?? 0);
  if (!(width > 0) || !(height > 0)) return "未知分辨率";
  const short = Math.min(width, height);
  if (short >= 2160) return "4K";
  if (short >= 1440) return "2K";
  if (short >= 1080) return "1080P";
  if (short >= 720) return "720P";
  if (short >= 480) return "480P";
  return `${width}x${height}`;
}

/** 片段清洗：去掉路径分隔符/保留字符/中文标点与分隔符「·」，避免文件名与分隔符撞车。 */
export function sanitizeNamePart(value) {
  return String(value ?? "")
    .replace(/[\\/:*?"<>|\n\r\t]/gu, "")
    .replace(/[，。！？；：、·「」『』《》〈〉（）()\[\]【】“”‘’…—～~!,.?;:'"`]/gu, "")
    .replace(/[\s\u3000]+/gu, "")
    .trim();
}

export function buildArtifactName(input) {
  const ext = String(input.ext ?? "").replace(/^\./u, "").toLowerCase();
  if (!ext) throw new Error("buildArtifactName 需要扩展名");
  const limit = Number.isFinite(input.titleMaxChars) ? Number(input.titleMaxChars) : 24;
  const title = sanitizeNamePart(input.title).slice(0, Math.max(1, limit)) || "未命名";
  const variant = sanitizeNamePart(String(input.variantName ?? ""));
  const feature = sanitizeNamePart(String(input.feature ?? "")) || "成片";
  const badge = input.resolution ? resolutionBadge(input.resolution) : "未知分辨率";
  const version = sanitizeNamePart(String(input.version ?? ""));
  const parts = [title, variant, feature, badge, input.preview ? "预览" : "", version].filter(Boolean);
  return `${parts.join("·")}.${ext}`;
}

export const VARIANT_DISPLAY_NAME = {
  "warm-story": "暖调故事版",
  "clean-tech": "干净科技版",
  "bold-promo": "强推促销版",
  "segmented-story": "分段调色版",
};

export function variantDisplayName(variantId, fallbackName = null) {
  return String(VARIANT_DISPLAY_NAME[variantId] ?? fallbackName ?? variantId);
}

/** 交付说明（Markdown）：推荐直接发布的带字幕版排最前。 */
export function buildDeliveryIndexMarkdown(options) {
  const { title, version, platform, resolution, artifacts = [] } = options;
  const generatedAt = options.generatedAt ?? new Date().toISOString();
  const lines = [];
  lines.push(`# 交付说明 · ${title}`);
  lines.push("");
  lines.push(`- 版本：${version || "未标注"}`);
  lines.push(`- 平台：${platform || "未标注"}`);
  lines.push(`- 分辨率：${resolution ? `${resolution.width}×${resolution.height}（${resolutionBadge(resolution)}）` : "未知"}`);
  lines.push(`- 生成时间：${generatedAt}`);
  lines.push("");
  const order = [
    ["burned", "推荐直接发布：带字幕成片"],
    ["softsub", "软字幕轨成片（播放器可开关字幕）"],
    ["master", "干净母版（不含烧录字幕）"],
    ["variant", "无字幕画面版"],
    ["danmaku", "弹幕版"],
    ["cover", "封面"],
    ["subtitle", "字幕文件"],
    ["preview", "预览"],
    ["other", "其他"],
  ];
  for (const [role, heading] of order) {
    const rows = artifacts.filter((artifact) => artifact.role === role);
    if (!rows.length) continue;
    lines.push(`## ${heading}`);
    lines.push("");
    for (const row of rows) lines.push(`- \`${row.displayName}\``);
    lines.push("");
  }
  lines.push("> 文件名规范：片名 · 版本名 · 核心特点 · 分辨率 · 版本号；分辨率一律按产出文件实测标注。");
  lines.push("");
  return lines.join("\n");
}

/** 交付包各变体的规范中文名（供 post-bridge 写进 delivery-manifest.displayNames）。 */
export function displayNamesForDelivery({ title, version = null, resolution = null, variants = [] }) {
  const rows = [];
  for (const variant of variants) {
    const variantName = variantDisplayName(variant.id, variant.name ?? null);
    rows.push({
      variantId: variant.id,
      variantName,
      burned: buildArtifactName({ title, variantName, feature: "带字幕", resolution, version, ext: "mp4" }),
      softsub: buildArtifactName({ title, variantName, feature: "软字幕轨", resolution, version, ext: "mp4" }),
      clean: buildArtifactName({ title, variantName, feature: "无字幕", resolution, version, ext: "mp4" }),
      cover: buildArtifactName({ title, variantName, feature: "封面", resolution, version, ext: "png" }),
    });
  }
  return {
    master: buildArtifactName({ title, feature: "干净母版", resolution, version, ext: "mp4" }),
    variants: rows,
    namingRule: "片名·版本名·核心特点·分辨率·版本号（分辨率按产出文件实测；预览件额外标注「预览」）",
  };
}
