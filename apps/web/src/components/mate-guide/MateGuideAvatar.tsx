/**
 * MateGuideAvatar · 首日上岗引导形象 = 织伴本体（产品数字人）
 *
 * 纪律（`LoomMate.tsx` 2026-09 品牌事故记录）：兜底/引导形象必须是**系统内真实形象**，
 * 禁止手绘或自创替代品（此前手绘金毛 SVG 造成品牌事故）。因此这里直接使用织伴
 * Live2D 官方海报 `/live2d/mao/poster.png`——与挂件兜底同源；换形象 = 换模型 + 换 poster.png，两件同批。
 *
 * 为什么引导层不再起第二个 Live2D 实例：经营主页已挂载织伴挂件（WebGL 多 canvas 共存不稳定，
 * 首装舞台独占唯一数字人实例）。引导层用**海报 + 状态环**表达"她在听 / 在汇报 / 在跟进 / 庆祝 / 需要放行"，
 * 既保证形象一致，又不与主实例抢资源。
 *
 * 降级：`prefers-reduced-motion` 下只保留静态形象（呼吸/脉冲动画全部关闭）；
 * 海报加载失败时退化为带岗位简称的底框，不影响任何业务按钮。
 */
import { useState } from "react";

export type GuideMood = "idle" | "listen" | "talk" | "think" | "celebrate" | "alert";

export interface MateGuideAvatarProps {
  /** 画布边长（px）——引导层刻意用小尺寸，主形象仍归挂件 */
  size?: number;
  mood?: GuideMood;
  /** 是否正在说话（驱动状态环脉冲） */
  speaking?: boolean;
  className?: string;
  /** 无障碍标签；默认按状态生成 */
  label?: string;
}

/** 状态 → 环色/状态词（与成长化文案一致：她在听、在汇报、在跟进、庆祝、需要您放行） */
const MOOD_STYLE: Record<GuideMood, { ring: string; glow: string; label: string }> = {
  idle: { ring: "#8f9aac", glow: "rgba(143,154,172,.35)", label: "待命" },
  listen: { ring: "#8ad8ff", glow: "rgba(138,216,255,.40)", label: "在听" },
  talk: { ring: "#e8c97a", glow: "rgba(232,201,122,.45)", label: "正在汇报" },
  think: { ring: "#9fd0c0", glow: "rgba(159,208,192,.40)", label: "正在跟进" },
  celebrate: { ring: "#6adf8a", glow: "rgba(106,223,138,.45)", label: "在庆祝" },
  alert: { ring: "#ffbe6a", glow: "rgba(255,190,106,.50)", label: "需要您放行" },
};

const GUIDE_CSS = `
@keyframes mate-guide-breath { 0%,100% { transform: translateY(0) } 50% { transform: translateY(-2px) } }
@keyframes mate-guide-pulse { 0%,100% { opacity:.55; transform: scale(1) } 50% { opacity:1; transform: scale(1.06) } }
@media (prefers-reduced-motion: reduce) {
  .mate-guide-figure { animation: none !important }
  .mate-guide-ring { animation: none !important }
}`;

export function MateGuideAvatar({
  size = 96,
  mood = "idle",
  speaking = false,
  className,
  label,
}: MateGuideAvatarProps) {
  // 说话且不是庆祝/警示时，视觉上按"正在汇报"处理（与语音同步）
  const activeMood: GuideMood = speaking && mood !== "celebrate" && mood !== "alert" ? "talk" : mood;
  const style = MOOD_STYLE[activeMood];
  const [broken, setBroken] = useState(false);
  const aria = label ?? `织伴（${style.label}）`;

  return (
    <span
      className={className}
      data-mate-guide="true"
      data-guide-mood={activeMood}
      style={{ display: "inline-block", width: size, height: size, lineHeight: 0 }}
    >
      <style>{GUIDE_CSS}</style>
      <span
        className="mate-guide-ring"
        style={{
          display: "inline-flex",
          alignItems: "center",
          justifyContent: "center",
          width: size,
          height: size,
          borderRadius: "9999px",
          border: `2px solid ${style.ring}`,
          boxShadow: `0 0 ${Math.round(size / 6)}px ${style.glow}`,
          background: "rgba(24,28,36,.85)",
          overflow: "hidden",
          animation: speaking ? "mate-guide-pulse 1.6s ease-in-out infinite" : undefined,
        }}
        role="img"
        aria-label={aria}
        title={`织伴 · ${style.label}`}
      >
        {broken ? (
          <span style={{ fontSize: Math.max(11, Math.round(size / 6)), color: "#e8c97a", fontWeight: 700 }}>
            织伴
          </span>
        ) : (
          <img
            src="/live2d/mao/poster.png"
            alt=""
            draggable={false}
            onError={() => setBroken(true)}
            className="mate-guide-figure"
            style={{
              width: "100%",
              height: "100%",
              objectFit: "cover",
              objectPosition: "50% 18%",
              userSelect: "none",
              animation: activeMood === "celebrate"
                ? "mate-guide-pulse 1.1s ease-in-out infinite"
                : "mate-guide-breath 3.4s ease-in-out infinite",
            }}
          />
        )}
      </span>
    </span>
  );
}
