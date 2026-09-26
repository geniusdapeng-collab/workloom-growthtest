import React from "react";
import { AbsoluteFill, Img, OffthreadVideo, staticFile, useCurrentFrame } from "remotion";
import { hexAlpha } from "./Backdrop";
import type { ExplainerShotProp, ExplainerTheme } from "./props";

/**
 * 主角窗口：人物素材按 `rhythmTable.hostForm` 换形态（版式轮换的数据侧落点）。
 * 素材既可以是 alpha/实拍视频（webm/mp4），也可以是定妆照静帧（png/jpg）——静帧走 Img 分支，
 * 由本组件补一条极缓推近，等价于"人物在画面里不动但镜头在动"（反 PPT 的合法解）。
 */

interface HostLayout {
  left: string;
  width: number;
  height: number;
  bottom: number;
  radius: number;
  /** 静帧的裁切焦点（人物脸部大致位置） */
  objectPosition: string;
}

const LAYOUTS: Record<string, HostLayout | null> = {
  半身: { left: "0%", width: 1080, height: 1150, bottom: 0, radius: 38, objectPosition: "50% 22%" },
  分屏格: { left: "0%", width: 1080, height: 920, bottom: 0, radius: 34, objectPosition: "50% 20%" },
  角标左下: { left: "6%", width: 452, height: 640, bottom: 300, radius: 32, objectPosition: "50% 20%" },
  角标右下: { left: "58%", width: 452, height: 640, bottom: 300, radius: 32, objectPosition: "50% 20%" },
  短离场: null,
  无人物: null,
};

const isVideo = (src: string): boolean => /\.(mp4|webm|mov|m4v)$/i.test(src);

export const HostWindow: React.FC<{
  shot: ExplainerShotProp;
  theme: ExplainerTheme;
  index: number;
}> = ({ shot, theme, index }) => {
  const frame = useCurrentFrame();
  const layout = LAYOUTS[shot.hostForm] ?? null;
  if (!layout || !shot.hostSrc) return null;
  const src = staticFile(shot.hostSrc);
  const zoom = 1.02 + 0.03 * Math.min(1, frame / 240);
  const drift = 10 * Math.sin((frame + index * 17) / 90);
  return (
    <div
      style={{
        position: "absolute",
        left: layout.left,
        bottom: layout.bottom,
        width: layout.width,
        height: layout.height,
        borderRadius: layout.radius,
        overflow: "hidden",
        border: `1px solid ${hexAlpha(theme.ink, 0.16)}`,
        boxShadow: "0 30px 90px rgba(0,0,0,0.5)",
        background: hexAlpha(theme.base, 0.9),
      }}
    >
      <AbsoluteFill
        style={{
          transform: `scale(${zoom.toFixed(4)}) translateY(${(drift / 10).toFixed(2)}px)`,
          transformOrigin: "50% 30%",
        }}
      >
        {isVideo(shot.hostSrc) ? (
          <OffthreadVideo
            src={src}
            muted
            style={{ width: "100%", height: "100%", objectFit: "cover", objectPosition: layout.objectPosition }}
          />
        ) : (
          <Img
            src={src}
            style={{ width: "100%", height: "100%", objectFit: "cover", objectPosition: layout.objectPosition }}
          />
        )}
      </AbsoluteFill>
      {/* 人物窗底部压暗：让字幕在任何素材上都读得清（可读性优先于画面亮度） */}
      <AbsoluteFill
        style={{
          background: `linear-gradient(to top, ${hexAlpha(theme.base, 0.88)} 0%, ${hexAlpha(theme.base, 0.28)} 26%, rgba(0,0,0,0) 52%)`,
        }}
      />
    </div>
  );
};
