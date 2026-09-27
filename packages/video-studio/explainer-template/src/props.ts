/**
 * props.ts —— 模板与 project-builder 的 props 契约（改这边必须同步改 project-builder.ts）。
 *
 * 这些值全部来自数据层（shotbook.json / timing.json / 工程清单），**不含任何代码**。
 */

export interface ExplainerTheme {
  base: string;
  accent: string;
  ink: string;
  font: string;
  energy: string;
  /** 品牌主体名（角标条显示，如「获客增长系统」） */
  product: string;
}

export interface ExplainerSentence {
  i: number;
  text: string;
  start: number;
  end: number;
}

export interface ExplainerShotProp {
  id: string;
  start: number;
  end: number;
  card: string;
  /** 版式节奏表口径：半身 / 分屏格 / 角标左下 / 角标右下 / 短离场 / 无人物 */
  hostForm: string;
  /** 容器口径（装框 / 出血全屏 / 分屏格 / 底床 / 无） */
  container: string;
  /** 人物素材（工程 public/ 相对路径；null = 本镜无人物） */
  hostSrc: string | null;
  /** 角标条文字（如「获客五环 · 03」） */
  label: string;
}

export interface ExplainerCue {
  t: number;
  src: string;
  vol: number;
}

export interface ExplainerProps {
  fps: number;
  width: number;
  height: number;
  quality: "hd" | "uhd";
  /** 配音总长（秒）——composition 时长按它算，与 shots.json 末镜对齐 */
  total: number;
  theme: ExplainerTheme;
  sentences: ExplainerSentence[];
  shots: ExplainerShotProp[];
  cues: ExplainerCue[];
  /**
   * 主音轨（配音）：工程 public 内相对路径。
   * 渲染纪律（render_shots.mjs 纪律 A）：视频段一律 muted 渲染，**音轨整条单独渲一次**（--audio）——
   * 所以本音轨必须在合成里（否则 --audio 渲出来是静音），且音轨在整片里只出现一次。
   */
  voice: { src: string; gain?: number } | null;
  /** 纯音效轨渲染开关（sfx_check 的 solo 模式；由 --props '{"sfxSolo":true}' 注入） */
  sfxSolo?: boolean;
  /** QA 调试层（九项版式自检用；成片必须 false） */
  debug?: boolean;
}

export const DEFAULT_THEME: ExplainerTheme = {
  base: "#0B1020",
  accent: "#7A5AF8",
  ink: "#F5F7FF",
  font: "PingFang SC, Noto Sans SC, Helvetica Neue, sans-serif",
  energy: "中",
  product: "WorkLoom",
};

export function withDefaults(input: Partial<ExplainerProps>): ExplainerProps {
  return {
    fps: input.fps ?? 30,
    width: input.width ?? 1080,
    height: input.height ?? 1920,
    quality: input.quality ?? "hd",
    total: input.total ?? 60,
    theme: { ...DEFAULT_THEME, ...(input.theme ?? {}) },
    sentences: input.sentences ?? [],
    shots: input.shots ?? [],
    cues: input.cues ?? [],
    voice: input.voice ?? null,
    sfxSolo: input.sfxSolo ?? false,
    debug: input.debug ?? false,
  };
}
