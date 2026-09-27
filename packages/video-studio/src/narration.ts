/**
 * narration.ts —— 逐镜人声核查的判据与"重复播报"防线（T-2026-0926-0121 真机缺陷修复）
 *
 * 真机事故（VID-GR01 第 1 镜）：模型自带人声**已经正确说出台词**（ASR 匹配 1.000、转写与台词逐字一致），
 * 但"人声活动度 0.228 < 下限 0.25"触发补旁白；`keep-dialogue` 策略把 TTS 旁白**叠在原声之上**，
 * 结果同一句被说了两遍（复核转写："还在给平台打工吗还在给平台打工吗"），听感是"主播没动嘴先说一遍、
 * 紧接着自己又重复一遍"。产品所有者当场听出并打回。
 *
 * 两条修法：
 *   1. `speechAcceptance`：**转写匹配对得上（强匹配）时，不得因活动度偏低而否决**——
 *      活动度是"这条音轨里人声占比"的制作指标，不是"有没有说这句台词"的判据；强匹配已直接证明台词在场。
 *   2. `isDoubledNarration`：补旁白之后**必须查重复播报**——复核转写里同一句出现两次即判补旁白失败，
 *      调用方应放弃这条配音产物（回退原片），而不是把"说了两遍"的音频交付出去。
 */

export interface SpeechAcceptanceInput {
  /** ASR 转写与台词的匹配率（0–1） */
  matchRatio: number | null;
  /** 人声活动度（人声段时长占比，0–1） */
  activeRatio: number | null;
  /** 匹配率下限（缺省 0.45） */
  matchMin?: number;
  /** 活动度下限（缺省 0.25） */
  activeMin?: number;
  /** 强匹配阈值（缺省 0.6）：达到即视为"台词确实在场" */
  strongMatchMin?: number;
}

export interface SpeechAcceptance {
  ok: boolean;
  reason: string;
  /** 是否命中强匹配（命中即不补旁白） */
  strongMatch: boolean;
}

/** 逐镜人声核查判据：双指标达标 **或** 强匹配达标（后者抑制"多余补旁白"） */
export function speechAcceptance(input: SpeechAcceptanceInput): SpeechAcceptance {
  const matchMin = input.matchMin ?? 0.45;
  const activeMin = input.activeMin ?? 0.25;
  const strongMatchMin = input.strongMatchMin ?? 0.6;
  const { matchRatio, activeRatio } = input;
  if (matchRatio === null || activeRatio === null) {
    return { ok: false, reason: "人声指标未测到（活动度或匹配率缺失）", strongMatch: false };
  }
  const strongMatch = matchRatio >= strongMatchMin;
  if (activeRatio >= activeMin && matchRatio >= matchMin) {
    return { ok: true, reason: `活动度 ${activeRatio.toFixed(3)} ≥ ${activeMin} 且匹配 ${matchRatio.toFixed(3)} ≥ ${matchMin}`, strongMatch };
  }
  if (strongMatch) {
    return {
      ok: true,
      strongMatch: true,
      reason: `台词强匹配 ${matchRatio.toFixed(3)} ≥ ${strongMatchMin}（转写已确证台词在场；活动度 ${activeRatio.toFixed(3)} 偏低不构成否决）`
    };
  }
  return {
    ok: false,
    strongMatch: false,
    reason: `活动度 ${activeRatio.toFixed(3)} < ${activeMin} 且匹配 ${matchRatio.toFixed(3)} < ${strongMatchMin}`
  };
}

/** 去掉标点与空白后的可比文本（中英标点一并去掉） */
function comparableText(text: string | null | undefined): string {
  return String(text ?? "").replace(/[\s，。！？、,.!?；;：:"'“”「」『』（）()\[\]{}<>/\-—…·|]/g, "");
}

/**
 * 是否出现"重复播报"：复核转写里**同一句台词出现 ≥2 次**。
 *
 * 用途：补旁白（keep-dialogue）会把 TTS 叠在原有对白之上；若原声本来就说对了这句，
 * 复核转写就会出现两遍。这里做确定性判定，调用方据此放弃配音产物、回退原片。
 */
export function isDoubledNarration(transcript: string | null | undefined, expectedText: string): boolean {
  const transcriptText = comparableText(transcript);
  const expected = comparableText(expectedText);
  if (!transcriptText || !expected) return false;
  let count = 0;
  let cursor = transcriptText.indexOf(expected);
  while (cursor !== -1) {
    count += 1;
    if (count >= 2) return true;
    cursor = transcriptText.indexOf(expected, cursor + expected.length);
  }
  return false;
}
