/**
 * photo-motion —— 真实照片 → 动态镜头段（管线 step_key `photo-motion`，2026-09-25 新增）
 *
 * 为什么需要：叙事片管线原本只有"文生图 → 图生视频"一条出画路径，
 * 遇到"必须用**真实照片**（地标/新闻图/官方图）"的题材就没法拍——硬用 AI 生成建筑会被看出来。
 * 本模块把一张静态真图变成 5 秒可用镜头段：**填满 9:16 / 16:9 画幅 + 速度坡道运镜**
 * （快起慢收 / 慢起快收 / 甩镜定住），配合硬切与节拍，观感接近《土耳其瞭望塔》那一类快剪片。
 *
 * 实现要点（可测、无随机）：
 *   · 先在 **2 倍目标分辨率**上按焦点裁切（保证 9:16 里主体不丢），再交给 `zoompan` 做带缓动的推/拉/摇；
 *   · 缓动函数只允许三种（easeOutCubic / easeInOutSine / whip），全部是 `on`（输出帧号）的解析式——
 *     同一张图 + 同一预设 → 完全一致的结果，便于回归与复现；
 *   · 输出统一 `setsar=1` + `yuv420p` + 指定 fps，避免拼接阶段像素格式/时序事故。
 */

export type PhotoMotionPreset =
  | "push-in-hard"
  | "pull-out-hard"
  | "detail-hold"
  | "pan-left-fast"
  | "pan-right-fast"
  | "tilt-up-fast"
  | "whip-in";

type Ease = "out-cubic" | "in-out-sine" | "whip";

interface PresetSpec {
  /** 缩放起止（1 = 恰好填满画幅；>1 = 放大） */
  zoom: [number, number];
  /** 水平/垂直取景窗口位置（0 = 最左/最上，1 = 最右/最下） */
  x: [number, number];
  y: [number, number];
  ease: Ease;
  comment: string;
}

/**
 * 预设表（每个都是"能讲清怎么动"的镜头语言，不是随意数值）：
 *   · push-in-hard  快推近后缓收（最通用的"抓人"起手，适合全景/建筑）
 *   · pull-out-hard 从特写快速拉开、尾巴稳住（适合"落霞/秋水"这类意境镜）
 *   · pan-left/right-fast 高速横摇后定住（扫过画面，像瞭望塔里的横向甩镜）
 *   · tilt-up-fast  自下而上抬升（拍高楼/牌匾）
 *   · whip-in       前 10% 吃掉 55% 行程的甩镜（硬切前的加速段，剪点最"炸"）
 */
export const PHOTO_MOTION_PRESETS: Record<PhotoMotionPreset, PresetSpec> = {
  "push-in-hard": { zoom: [1.02, 1.34], x: [0.5, 0.5], y: [0.5, 0.44], ease: "out-cubic", comment: "快推近后缓收" },
  "pull-out-hard": { zoom: [1.34, 1.02], x: [0.5, 0.5], y: [0.44, 0.5], ease: "out-cubic", comment: "快速拉开稳住" },
  /**
   * 细节镜（2026-09-25 真机加）：匾额/文字/纹样这类"一动就切掉字"的画面，
   * 用极缓推近 + 微移（窗口始终 ≥87% 画幅），保证主体细节不被裁出画外。
   */
  "detail-hold": { zoom: [1.05, 1.14], x: [0.44, 0.56], y: [0.5, 0.44], ease: "in-out-sine", comment: "细节保住：极缓推近+微移" },
  "pan-left-fast": { zoom: [1.2, 1.24], x: [0.78, 0.22], y: [0.5, 0.5], ease: "out-cubic", comment: "高速向左横扫后定住" },
  "pan-right-fast": { zoom: [1.2, 1.24], x: [0.22, 0.78], y: [0.5, 0.5], ease: "out-cubic", comment: "高速向右横扫后定住" },
  "tilt-up-fast": { zoom: [1.18, 1.26], x: [0.5, 0.5], y: [0.86, 0.18], ease: "out-cubic", comment: "自下而上抬升" },
  "whip-in": { zoom: [1.06, 1.4], x: [0.86, 0.42], y: [0.54, 0.44], ease: "whip", comment: "甩镜加速后定住（快剪起手）" }
};

/** 缓动表达式（t = on/frames，0→1） */
function easeExpression(ease: Ease, total: number): string {
  const t = `(on/${total})`;
  switch (ease) {
    case "in-out-sine":
      return `(1-cos(PI*${t}))/2`;
    case "whip":
      /** 前 10% 行程吃掉 55%，其余用 easeOutCubic 收尾（两段在 t=0.1 处连续） */
      return `if(lt(${t},0.1),5.5*${t},0.55+0.45*(1-pow(1-(${t}-0.1)/0.9,3)))`;
    case "out-cubic":
    default:
      return `(1-pow(1-${t},3))`;
  }
}

export interface PhotoMotionOptions {
  preset: PhotoMotionPreset;
  durationSec: number;
  fps?: number;
  width: number;
  height: number;
  /** 焦点（0–1）：决定 2 倍裁切窗口落在原图哪里，默认居中；建筑类给 0.5 水平、0.45 垂直更常见 */
  focus?: { x?: number; y?: number };
  /** 过采样倍率（默认 2：先在 2× 目标尺寸上裁切，再缩放输出，避免清晰度损失） */
  oversample?: number;
}

export interface PhotoMotionPlan {
  frames: number;
  /** 送 ffmpeg 的 video filter（不含 [in]/[out] 标签） */
  filter: string;
  preset: PhotoMotionPreset;
  comment: string;
}

export function buildPhotoMotion(options: PhotoMotionOptions): PhotoMotionPlan {
  const preset = PHOTO_MOTION_PRESETS[options.preset];
  if (!preset) throw new Error(`未知的 photo-motion 预设：${options.preset}`);
  const fps = options.fps ?? 30;
  const frames = Math.max(1, Math.round(options.durationSec * fps));
  const scale = options.oversample ?? 2;
  const workW = options.width * scale;
  const workH = options.height * scale;
  const fx = Math.min(1, Math.max(0, options.focus?.x ?? 0.5));
  const fy = Math.min(1, Math.max(0, options.focus?.y ?? 0.5));
  const ease = easeExpression(preset.ease, frames);
  const z = `(${preset.zoom[0]}+(${preset.zoom[1]}-${preset.zoom[0]})*${ease})`;
  const x = `(iw-iw/zoom)*(${preset.x[0]}+(${preset.x[1]}-${preset.x[0]})*${ease})`;
  const y = `(ih-ih/zoom)*(${preset.y[0]}+(${preset.y[1]}-${preset.y[0]})*${ease})`;
  const filter = [
    /** 先按"覆盖"放大到 2× 目标并裁切：横图进 9:16 时裁掉两侧，主体由焦点决定 */
    `scale=${workW}:${workH}:force_original_aspect_ratio=increase`,
    `crop=${workW}:${workH}:(iw-${workW})*${fx}:(ih-${workH})*${fy}`,
    `zoompan=z='${z}':x='${x}':y='${y}':d=${frames}:s=${options.width}x${options.height}:fps=${fps}`,
    "setsar=1",
    "format=yuv420p"
  ].join(",");
  return { frames, filter, preset: options.preset, comment: preset.comment };
}

/**
 * ffmpeg 命令（照片 → 片段）。
 * 照片段**没有原声**，这里补一条静音 AAC 轨——否则拼接阶段各段音轨不一致，
 * `-c copy` 拼接会断音（真机 2026-09-24 的音频事故就是同类原因）。
 */
export function photoMotionCommand(options: PhotoMotionOptions & { input: string; output: string }): string[] {
  const plan = buildPhotoMotion(options);
  return [
    "-y",
    "-loop", "1", "-i", options.input,
    "-f", "lavfi", "-i", "anullsrc=channel_layout=stereo:sample_rate=48000",
    "-filter_complex", `[0:v]${plan.filter}[v]`,
    "-map", "[v]", "-map", "1:a",
    "-t", String(options.durationSec),
    "-r", String(options.fps ?? 30),
    "-c:v", "libx264", "-preset", "slow", "-crf", "18", "-pix_fmt", "yuv420p",
    "-c:a", "aac", "-b:a", "192k", "-ar", "48000", "-ac", "2",
    "-movflags", "+faststart",
    options.output
  ];
}
