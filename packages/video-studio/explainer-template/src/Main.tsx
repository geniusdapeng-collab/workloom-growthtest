import React from "react";
import { AbsoluteFill, useVideoConfig } from "remotion";
import { Subtitles } from "./Subtitles";
import { SfxTrack } from "./SfxTrack";
import { ShotStage } from "./ShotStage";
import { VoiceTrack } from "./VoiceTrack";
import { withDefaults, type ExplainerProps } from "./props";

/**
 * 口播解说片主合成：读 inputProps（`--props @props.json`）渲染全片。
 *
 * 结构（自下而上）：镜头舞台（背板 + 卡面板 + 人物窗，逐镜 Sequence） → 全局字幕 → 音效轨。
 * 纪律：Main 不做任何"整片级"动效（整片动效会盖掉逐镜相机曲线，运动做减法）。
 */
export const Main: React.FC<Partial<ExplainerProps>> = (input) => {
  const props = withDefaults(input);
  // 卡、人物窗与字幕的排版坐标以 HD 画布为基准；UHD 在原生 4K
  // composition 内将矢量 DOM 舞台按 2 倍布局，音轨仍保持原时间轴。
  const designWidth = props.width > props.height ? 1920 : 1080;
  const designHeight = props.width > props.height ? 1080 : 1920;
  const stageScale = props.width / designWidth;
  return (
    <AbsoluteFill style={{ backgroundColor: props.theme.base, fontFamily: props.theme.font }}>
      <div style={{
        position: "absolute", left: 0, top: 0, width: designWidth, height: designHeight,
        transform: `scale(${stageScale})`, transformOrigin: "top left", overflow: "hidden",
      }}>
        {props.shots.map((shot, index) => (
          <ShotStage key={shot.id} shot={shot} props={props} index={index} />
        ))}
        <Subtitles sentences={props.sentences} theme={props.theme} />
      </div>
      <VoiceTrack props={props} />
      <SfxTrack cues={props.cues} />
      <DebugOverlay enabled={Boolean(props.debug)} />
    </AbsoluteFill>
  );
};

/** 版式自检层（debug=true 时开）：安全区边线 + 画幅信息；成片必须关。 */
const DebugOverlay: React.FC<{ enabled: boolean }> = ({ enabled }) => {
  const { width, height } = useVideoConfig();
  if (!enabled) return null;
  const safe = { top: Math.round(height * 0.06), bottom: Math.round(height * 0.09), side: Math.round(width * 0.06) };
  return (
    <AbsoluteFill style={{ pointerEvents: "none" }}>
      <div
        style={{
          position: "absolute",
          left: safe.side, right: safe.side, top: safe.top, bottom: safe.bottom,
          border: "2px dashed rgba(255,80,80,0.75)",
        }}
      />
      <div style={{ position: "absolute", left: 12, top: 12, color: "#ff5050", fontSize: 22, fontFamily: "monospace" }}>
        {width}×{height} · debug
      </div>
    </AbsoluteFill>
  );
};
