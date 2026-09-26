import React from "react";
import { AbsoluteFill, useCurrentFrame } from "remotion";

/**
 * G1 相机：每镜一条**极缓推进**曲线（1.005 → 1.035），不做位移/旋转/模糊/脉冲。
 * 目的有二：① 反 PPT（任意 1 秒窗内画面必须活着）；② 让卡面板与人物窗共享同一相机，
 * 避免"卡片在动、人物不动"的分层感。
 *
 * 相机从 1.005 起（>1）——缩小时会露出背板边缘，是渲染事故的常见来源。
 */
export const ShotCamera: React.FC<{
  durationInFrames: number;
  children: React.ReactNode;
  /** 能量档：高 → 推进略快（1.005→1.045），低 → 1.005→1.02 */
  energy?: string;
}> = ({ durationInFrames, children, energy = "中" }) => {
  const frame = useCurrentFrame();
  const target = energy === "高" ? 1.045 : energy === "低" ? 1.02 : 1.035;
  const p = durationInFrames > 1 ? Math.min(1, Math.max(0, frame / (durationInFrames - 1))) : 0;
  const scale = 1.005 + (target - 1.005) * p;
  return (
    <AbsoluteFill style={{ transform: `scale(${scale.toFixed(4)})`, transformOrigin: "50% 58%" }}>
      {children}
    </AbsoluteFill>
  );
};
