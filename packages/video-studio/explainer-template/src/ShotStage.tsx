import React from "react";
import { AbsoluteFill, Sequence, useCurrentFrame, useVideoConfig } from "remotion";
import { Backdrop } from "./Backdrop";
import { CardStage } from "./CardStage";
import { HostWindow } from "./HostWindow";
import { ShotCamera } from "./ShotCamera";
import type { ExplainerProps, ExplainerShotProp } from "./props";

/** 相邻镜交叠帧数（12 帧 = 0.4s @30fps）：新镜在上层淡入，形成运动承接的转场 */
export const FADE_FRAMES = 12;

/**
 * 单镜舞台：卡面板 + 人物窗 + 相机，统一放进一条 `Sequence`。
 *
 * 时间口径（与 render_shots.mjs 的段边界取整同规则）：
 *   from      = round(shot.start*fps) − lead      （lead = 12 帧，首镜 0）
 *   duration  = round(shot.end*fps) − from
 *   卡内容    = 从本地帧 lead 起（= 本镜真实起点），所以卡的入场动画不会被转场提前
 */
export const ShotStage: React.FC<{
  shot: ExplainerShotProp;
  props: ExplainerProps;
  index: number;
}> = ({ shot, props, index }) => {
  const { fps } = useVideoConfig();
  const startFrame = Math.round(shot.start * fps);
  const endFrame = Math.round(shot.end * fps);
  const lead = index === 0 ? 0 : FADE_FRAMES;
  const from = Math.max(0, startFrame - lead);
  const duration = Math.max(1, endFrame - from);
  return (
    <Sequence from={from} durationInFrames={duration} layout="none">
      <ShotFade lead={lead}>
        <ShotCamera durationInFrames={duration} energy={props.theme.energy}>
          <Backdrop theme={props.theme} />
          <CardStage shot={shot} theme={props.theme} />
          <HostWindow shot={shot} theme={props.theme} index={index} />
        </ShotCamera>
      </ShotFade>
    </Sequence>
  );
};

/** 透明度承接：新镜在前 lead 帧内 0→1 淡入（上一镜仍在下面，形成交叉溶解） */
const ShotFade: React.FC<{ lead: number; children: React.ReactNode }> = ({ lead, children }) => {
  const frame = useCurrentFrame();
  const opacity = lead <= 0 ? 1 : Math.min(1, Math.max(0, frame / lead));
  return <AbsoluteFill style={{ opacity }}>{children}</AbsoluteFill>;
};
