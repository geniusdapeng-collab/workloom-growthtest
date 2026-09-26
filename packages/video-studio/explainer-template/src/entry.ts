/**
 * entry.ts —— Remotion 入口（render_shots.mjs 的 `--entry src/entry.ts` 默认值）。
 *
 * 只注册一个 composition（`Explainer`）：时长由 props.total 经 calculateMetadata 算出，
 * 与 shots.json 的末镜 end 严格对齐（render_shots 会断言差 ≤1 帧）。
 */
import React from "react";
import { Composition, registerRoot } from "remotion";
import { Main } from "./Main";
import { withDefaults, type ExplainerProps } from "./props";

const FALLBACK_PROPS: ExplainerProps = withDefaults({
  total: 8,
  shots: [{ id: "s01", start: 0, end: 8, card: "placeholder", hostForm: "无人物", container: "装框", hostSrc: null, label: "预览" }],
  sentences: [{ i: 1, text: "占位预览", start: 0, end: 8 }],
});

export const RemotionRoot: React.FC = () => (
  <Composition
    id="Explainer"
    component={Main}
    durationInFrames={Math.round(FALLBACK_PROPS.total * FALLBACK_PROPS.fps)}
    fps={FALLBACK_PROPS.fps}
    width={FALLBACK_PROPS.width}
    height={FALLBACK_PROPS.height}
    defaultProps={FALLBACK_PROPS}
    calculateMetadata={({ props }) => {
      const merged = withDefaults(props as Partial<ExplainerProps>);
      return {
        durationInFrames: Math.max(1, Math.round(merged.total * merged.fps)),
        fps: merged.fps,
        width: merged.width,
        height: merged.height,
      };
    }}
  />
);

registerRoot(RemotionRoot);
