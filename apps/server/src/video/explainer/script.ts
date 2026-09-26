/**
 * explainer/script.ts —— 口播稿的纯函数工具（不依赖 tRPC / DB）· T-2026-0926-0008
 *
 * 抽出来的原因：`video.studio.start` 需要它建 v1 草稿，而 `explainer/router.ts` 已经依赖 tRPC 上下文——
 * 若 studio.start 反向 import router.ts 会形成环。这里只留"文本 → 句子数组"与"空分镜占位"两个纯函数。
 */
import type { ExplainerShotbook } from "./types.js";

/** 口播稿文本 → 句子数组（空行分段，按句末标点切句；保留原标点） */
export function splitScript(text: string): { i: number; text: string }[] {
  const sentences: string[] = [];
  for (const paragraph of text.split(/\n+/)) {
    const clean = paragraph.trim();
    if (!clean) continue;
    const parts = clean.match(/[^。！？!?]+[。！？!?]?/g) ?? [clean];
    for (const part of parts) {
      const trimmed = part.trim();
      if (trimmed) sentences.push(trimmed);
    }
  }
  return sentences.map((sentence, index) => ({ i: index + 1, text: sentence }));
}

/** 空分镜（立项/改稿时的占位；真分镜由 video.explainer.shotbook 生成） */
export function emptyShotbook(
  product: string,
  brand?: { accent?: string; base?: string; ink?: string },
): ExplainerShotbook {
  return {
    style: {
      domain: product,
      tone: "待生成",
      palette: { base: brand?.base ?? "#0B1020", accent: brand?.accent ?? "#7A5AF8", ink: brand?.ink ?? "#F5F7FF" },
      font: "PingFang SC / Noto Sans SC",
      energy: "中",
    },
    rhythmTable: [{ shotId: "s01", hostForm: "无人物", container: "装框", card: "placeholder" }],
    shots: [{
      id: "s01", start: 0, end: 2, text: "待生成", card: "placeholder",
      content: {}, replace: [], skin: {}, material: { kind: "文" }, sfx: [], notes: "占位：尚未生成分镜",
    }],
  };
}
