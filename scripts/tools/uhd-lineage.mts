/** UHD 发布前的确定性血缘核验。调用方负责从磁盘重新计算全部 SHA-256。 */
export type UhdLineageRecord = {
  stage: string;
  shotId: string | null;
  invoked: boolean;
  ok: boolean;
  degraded: boolean;
  runId?: string;
  projectId?: string;
  shotlistSha256?: string;
  quality?: string;
  verdict?: { approved?: boolean } | null;
  evidence?: Record<string, unknown>;
};

export type UhdShotDigest = { shotId: string; sourceSha256: string; enhancedSha256: string };
export type UhdStageDigest = { stage: "color" | "subtitle" | "danmaku" | "bgm" | "sfx"; inputSha256: string; outputSha256: string };

const sha256 = (value: unknown): value is string => typeof value === "string" && /^[a-f0-9]{64}$/i.test(value);

export function verifyUhdLineage(input: {
  records: UhdLineageRecord[];
  projectId: string;
  runId: string;
  shotlistSha256: string;
  shots: UhdShotDigest[];
  masterRawSha256: string;
  stages: UhdStageDigest[];
  avReport: { ok?: boolean; outputSha256?: string; clipCount?: number } | null;
}): { ok: boolean; errors: string[] } {
  const errors: string[] = [];
  if (!input.runId || !sha256(input.shotlistSha256) || !sha256(input.masterRawSha256)) {
    errors.push("缺本轮运行标识、分镜或原始母版 SHA-256");
  }
  const rows = input.records.filter((row) => row.invoked && row.quality === "uhd"
    && row.projectId === input.projectId && row.runId === input.runId
    && row.shotlistSha256 === input.shotlistSha256);
  const compose = rows.filter((row) => row.stage === "compose").at(-1);
  const composedInputs = compose?.evidence?.clipInputs;
  if (!compose || !compose.ok || compose.degraded || compose.verdict?.approved !== true
    || compose.evidence?.outputSha256 !== input.masterRawSha256
    || !Array.isArray(composedInputs) || composedInputs.length !== input.shots.length) {
    errors.push("合成回执未批准，或其运行、分镜、输入数、母版摘要与当前文件不符");
  }
  const inputRows = Array.isArray(composedInputs) ? composedInputs as Array<Record<string, unknown>> : [];
  for (const shot of input.shots) {
    const bound = inputRows.find((entry) => entry.shotId === shot.shotId);
    if (!sha256(shot.sourceSha256) || !sha256(shot.enhancedSha256)
      || bound?.sourceSha256 !== shot.sourceSha256 || bound?.enhancedSha256 !== shot.enhancedSha256) {
      errors.push(`镜头 ${shot.shotId} 的当前源片或增强片与合成输入摘要不符`);
      continue;
    }
    const enhancement = rows.filter((row) => row.stage === "enhance" && row.shotId === shot.shotId).at(-1);
    if (!enhancement?.ok || enhancement.degraded || enhancement.evidence?.localVerified !== true
      || enhancement.evidence?.sourceSha256 !== shot.sourceSha256
      || enhancement.evidence?.outputSha256 !== shot.enhancedSha256) {
      errors.push(`镜头 ${shot.shotId} 缺同轮、同源片的已核验增强回执`);
    }
  }
  if (input.avReport?.ok !== true || input.avReport.outputSha256 !== input.masterRawSha256
    || input.avReport.clipCount !== input.shots.length) {
    errors.push("音画实测报告未通过，或未绑定当前母版摘要与镜头数");
  }
  let preceding = input.masterRawSha256;
  for (const stage of input.stages) {
    if (!sha256(stage.inputSha256) || !sha256(stage.outputSha256) || stage.inputSha256 !== preceding) {
      errors.push(`${stage.stage} 实际输入摘要未接上前一层`);
    }
    const receipt = rows.filter((row) => row.stage === stage.stage).at(-1);
    const colorFallback = stage.stage === "color" && receipt?.evidence?.fallbackToOriginal === true
      && receipt.evidence.inputSha256 === receipt.evidence.outputSha256;
    if (!receipt?.ok || receipt.degraded || (!colorFallback && receipt.verdict?.approved !== true)
      || receipt.evidence?.inputSha256 !== stage.inputSha256
      || receipt.evidence?.outputSha256 !== stage.outputSha256) {
      errors.push(`${stage.stage} 缺同轮、已批准且哈希首尾相接的阶段回执`);
    }
    preceding = stage.outputSha256;
  }
  return { ok: errors.length === 0, errors };
}
