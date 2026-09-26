import React from "react";
import { AbsoluteFill, useCurrentFrame, useVideoConfig } from "remotion";
import type { ExplainerTheme } from "./props";

/**
 * 全局背板：深底渐变 + 极缓漂移（每镜一条相机曲线之外的"底噪声"来源之一）。
 * 纪律：frame 纯函数、零随机、无渐变角度突变（色带在深底片上是可测缺陷）。
 */
export const Backdrop: React.FC<{ theme: ExplainerTheme }> = ({ theme }) => {
  const frame = useCurrentFrame();
  const { durationInFrames } = useVideoConfig();
  const p = durationInFrames > 1 ? frame / (durationInFrames - 1) : 0;
  const drift = 6 * Math.sin(p * Math.PI * 2);
  return (
    <AbsoluteFill style={{ backgroundColor: theme.base }}>
      <AbsoluteFill
        style={{
          background: `radial-gradient(120% 80% at ${18 + drift * 0.4}% ${12 + drift * 0.2}%, ${hexAlpha(theme.accent, 0.34)} 0%, ${hexAlpha(theme.accent, 0.06)} 42%, rgba(0,0,0,0) 72%)`,
        }}
      />
      <AbsoluteFill
        style={{
          background: `radial-gradient(90% 60% at ${86 - drift * 0.3}% ${92 + drift * 0.2}%, ${hexAlpha(theme.ink, 0.10)} 0%, rgba(0,0,0,0) 60%)`,
        }}
      />
    </AbsoluteFill>
  );
};

/** #RRGGBB + alpha → rgba()；非法值回落透明（不编颜色） */
export function hexAlpha(hex: string, alpha: number): string {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return `rgba(0,0,0,${alpha})`;
  const value = Number.parseInt(m[1]!, 16);
  const r = (value >> 16) & 255;
  const g = (value >> 8) & 255;
  const b = value & 255;
  return `rgba(${r},${g},${b},${alpha})`;
}
