import React from "react";
import { Audio, Sequence, staticFile } from "remotion";
import type { ExplainerCue } from "./props";

/**
 * 音效轨：由 props.cues（绝对秒）驱动，音量 ≤0.35（成片口径，demo 库的 0.65 是试听口径）。
 * 纪律：同帧最多一记；音效电平比人声低 ~12dB（具体值由 shotbook 的 sfx[].vol 给，缺省 0.3）。
 */
export const SfxTrack: React.FC<{ cues: ExplainerCue[] }> = ({ cues }) => {
  return (
    <>
      {cues.map((cue, index) => (
        <Sequence key={`${cue.t}-${cue.src}-${index}`} from={Math.round(cue.t * 30)} durationInFrames={60} layout="none">
          <Audio src={staticFile(cue.src)} volume={Math.min(0.35, cue.vol)} />
        </Sequence>
      ))}
    </>
  );
};
