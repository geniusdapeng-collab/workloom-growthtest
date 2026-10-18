/**
 * 普通 AI 视频全链的缺省交付契约。
 *
 * 默认只产出一支交付母版：保留渲染素材原色，拼接完成后烧封面、烧台词、混入 BGM；
 * 弹幕只在调用方显式提供条目或传 `--auto-danmaku` 时启用。
 * 多风格变体仍可通过显式把 `deliver` 放进 `--stages` 请求，不能由缺省参数悄悄开启。
 */
export const AI_PRODUCTION_DEFAULT_STAGES = Object.freeze([
  "cine-kb",
  "continuity",
  "micromotion",
  "spec",
  "plates",
  "material-gen",
  "videos",
  "voice",
  "compose",
  "color",
  "subtitle",
  "bgm",
  "cover",
  "mux",
  "master",
] as const);

export const AI_PRODUCTION_DEFAULT_SUBTITLE_MODE = "burn" as const;

export function resolveAiProductionDanmakuEnabled(input: {
  danmakuFile?: string | null;
  autoDanmaku?: boolean;
  noDanmaku?: boolean;
}): boolean {
  if (input.noDanmaku === true) return false;
  return input.autoDanmaku === true || Boolean(String(input.danmakuFile ?? "").trim());
}
