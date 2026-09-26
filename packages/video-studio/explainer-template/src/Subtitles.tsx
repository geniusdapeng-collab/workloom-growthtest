import React from "react";
import { AbsoluteFill, useCurrentFrame, useVideoConfig } from "remotion";
import { hexAlpha } from "./Backdrop";
import type { ExplainerSentence, ExplainerTheme } from "./props";

/**
 * 素排字幕（design-language §5 铁律）：**整句硬现硬走、无动效、无标点**。
 * 位置：竖屏安全区——底边上抬 180px（避开平台文案区），宽度 84%，最多两行。
 * 唯一例外（关键词弹出）不在本模板里实现：它属于卡的能力，不是字幕的能力。
 */
export const Subtitles: React.FC<{
  sentences: ExplainerSentence[];
  theme: ExplainerTheme;
  /** 底边距（px）；竖屏缺省 190，横屏 100 */
  bottom?: number;
  fontSize?: number;
}> = ({ sentences, theme, bottom = 190, fontSize = 54 }) => {
  const frame = useCurrentFrame();
  const { fps, height } = useVideoConfig();
  const t = frame / fps;
  const active = sentences.find((s) => t >= s.start && t < s.end);
  if (!active) return null;
  const text = stripPunctuation(active.text);
  const lines = wrap(text, text.length > 24 ? 18 : 999);
  return (
    <AbsoluteFill style={{ justifyContent: "flex-end", alignItems: "center", pointerEvents: "none" }}>
      <div
        style={{
          position: "absolute",
          bottom,
          width: "84%",
          padding: "22px 30px",
          borderRadius: 22,
          background: hexAlpha("#000000", 0.42),
          backdropFilter: "blur(6px)",
          color: theme.ink,
          fontFamily: theme.font,
          fontSize,
          fontWeight: 600,
          lineHeight: 1.32,
          textAlign: "center",
          letterSpacing: 1.5,
          textShadow: "0 2px 18px rgba(0,0,0,0.65)",
        }}
      >
        {lines.map((line, i) => (
          <div key={i}>{line}</div>
        ))}
      </div>
      {fontSize > height / 20 ? null : null}
    </AbsoluteFill>
  );
};

/** 跟读字幕不带句读（数字/型号间的半角点号除外——本函数保留 . 与 ·） */
export function stripPunctuation(text: string): string {
  return text.replace(/[，。！？、；：""''（）()《》…—?!,;:"]/g, "").trim();
}

/** 中文按最大字数折行（不拆标点；无标点输入按字数切） */
export function wrap(text: string, perLine: number): string[] {
  if (text.length <= perLine) return [text];
  const lines: string[] = [];
  for (let i = 0; i < text.length; i += perLine) lines.push(text.slice(i, i + perLine));
  return lines.slice(0, 3);
}
