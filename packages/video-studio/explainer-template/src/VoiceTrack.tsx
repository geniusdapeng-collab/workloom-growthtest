import React from "react";
import { Audio, staticFile } from "remotion";
import type { ExplainerProps } from "./props";

/**
 * 主音轨（配音）——整条、不分段（render_shots.mjs 纪律 A）。
 *
 * - `sfxSolo=true`（sfx_check 的 solo 渲染）时**静默人声**，只留音效轨，用于验证每条 cue 真的在场；
 * - 音量缺省 1.0（不在这里做归一：成片响度由 ⑧ 的两遍 loudnorm 统一处理，避免双重归一）。
 */
export const VoiceTrack: React.FC<{ props: ExplainerProps }> = ({ props }) => {
  if (props.sfxSolo || !props.voice) return null;
  return <Audio src={staticFile(props.voice.src)} volume={props.voice.gain ?? 1} />;
};
