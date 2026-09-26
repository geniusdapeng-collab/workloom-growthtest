import React from "react";
import { AbsoluteFill } from "remotion";
import { SCENES } from "./scenes";
import { hexAlpha } from "./Backdrop";
import type { ExplainerShotProp, ExplainerTheme } from "./props";

/** 卡的原始舞台尺寸（引擎所有卡都是 960×540 或它的派生；douyin-follow-card 自带竖版，按同框缩放） */
const CARD_W = 960;
const CARD_H = 540;

interface Layout {
  /** 缩放（1 = 1080 宽面板；1.125 = 满宽） */
  scale: number;
  /** 面板顶边（px，1080×1920 画布） */
  top: number;
  /** 角标条显示与否 */
  label: boolean;
}

const LAYOUTS: Record<string, Layout> = {
  半身: { scale: 1.125, top: 96, label: true },
  分屏格: { scale: 1.125, top: 64, label: true },
  角标左下: { scale: 1.125, top: 120, label: true },
  角标右下: { scale: 1.125, top: 120, label: true },
  短离场: { scale: 1.3, top: 300, label: true },
  无人物: { scale: 1.125, top: 150, label: true },
};

const Placeholder: React.FC = () => (
  <AbsoluteFill style={{ background: "#111" }} />
);

/**
 * 卡面板：把引擎卡（960×540 舞台）放进竖屏画布，装框 + 角标条。
 * 卡内部的时间基是"本镜局部帧 0 = 本镜真实起点"（ShotStage 已做 lead 补偿），本组件不再动时间。
 */
export const CardStage: React.FC<{
  shot: ExplainerShotProp;
  theme: ExplainerTheme;
}> = ({ shot, theme }) => {
  const Scene = SCENES[shot.id] ?? Placeholder;
  const layout = LAYOUTS[shot.hostForm] ?? LAYOUTS["半身"]!;
  return (
    <div
      style={{
        position: "absolute",
        left: "50%",
        top: layout.top,
        width: CARD_W,
        height: CARD_H,
        transform: `translateX(-50%) scale(${layout.scale})`,
        transformOrigin: "top center",
        borderRadius: 24,
        overflow: "hidden",
        boxShadow: "0 24px 80px rgba(0,0,0,0.45)",
        outline: `2px solid ${hexAlpha(theme.ink, 0.10)}`,
        backgroundColor: "#0d0d12",
      }}
    >
      <Scene />
      {layout.label ? (
        <div
          style={{
            position: "absolute",
            left: 22,
            bottom: 18,
            padding: "8px 16px",
            borderRadius: 999,
            background: hexAlpha(theme.base, 0.72),
            color: hexAlpha(theme.ink, 0.92),
            fontFamily: theme.font,
            fontSize: 20,
            letterSpacing: 1.2,
            border: `1px solid ${hexAlpha(theme.ink, 0.14)}`,
          }}
        >
          <span style={{ color: theme.accent, fontWeight: 700 }}>●</span> {shot.label}
        </div>
      ) : null}
    </div>
  );
};
