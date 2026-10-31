/** Final prompt-set contract used before a preproduction result can become render-eligible. */

export type FinalShotIssueCode =
  | "SHOTS_REQUIRED"
  | "SHOT_ID_REQUIRED"
  | "SHOT_DUPLICATE"
  | "SHOT_PROMPT_REQUIRED"
  | "SHOT_PLACEHOLDER"
  | "PROMPT_TOO_LONG"
  | "SHOT_DEGRADED"
  | "DIALOGUE_FORBIDDEN"
  | "DURATION_INVALID"
  | "RENDER_SUBMIT_BLOCKED";

export interface FinalShotContractIssue {
  code: FinalShotIssueCode;
  shotId: string | null;
  message: string;
}

export interface FinalShotContractResult {
  pass: boolean;
  issues: FinalShotContractIssue[];
}

type ShotRecord = Record<string, unknown>;

function text(value: unknown): string {
  if (typeof value === "string") return value;
  if (typeof value === "number") return String(value);
  return "";
}

function hasDialogue(shot: ShotRecord, prompt: string): boolean {
  if (/【台词】/u.test(prompt)) return true;
  if (text(shot.dialogue).trim() || text(shot.dialogueText).trim()) return true;
  return Array.isArray(shot.dialogueBlocks) && shot.dialogueBlocks.length > 0;
}

export function inspectFinalShotContract(
  shots: ShotRecord[],
  options: { maxPromptLength: number; noDialogue?: boolean; minDurationSeconds?: number; maxDurationSeconds?: number },
): FinalShotContractResult {
  const issues: FinalShotContractIssue[] = [];
  if (shots.length === 0) {
    return {
      pass: false,
      issues: [{ code: "SHOTS_REQUIRED", shotId: null, message: "没有任何最终镜头" }],
    };
  }
  if (!Number.isInteger(options.maxPromptLength) || options.maxPromptLength < 1) {
    throw new Error(`PROMPT_LIMIT_INVALID: ${options.maxPromptLength}`);
  }
  const seen = new Set<string>();
  for (const [index, shot] of shots.entries()) {
    const shotId = text(shot.shotId).trim();
    const prompt = text(shot.prompt);
    if (!shotId) {
      issues.push({ code: "SHOT_ID_REQUIRED", shotId: null, message: `第 ${index + 1} 镜缺 shotId` });
    } else if (seen.has(shotId)) {
      issues.push({ code: "SHOT_DUPLICATE", shotId, message: `镜头 ID 重复：${shotId}` });
    } else {
      seen.add(shotId);
    }
    if (!prompt.trim()) {
      issues.push({ code: "SHOT_PROMPT_REQUIRED", shotId: shotId || null, message: "最终 prompt 为空" });
    } else if (/\[object Object\]|\b(?:undefined|null|NaN)\b/u.test(prompt)) {
      issues.push({ code: "SHOT_PLACEHOLDER", shotId: shotId || null, message: "最终 prompt 含对象/未定义占位符" });
    }
    if (prompt.length > options.maxPromptLength) {
      issues.push({
        code: "PROMPT_TOO_LONG",
        shotId: shotId || null,
        message: `prompt ${prompt.length} 字符，超过 ${options.maxPromptLength}`,
      });
    }
    if (shot.degraded === true) {
      issues.push({ code: "SHOT_DEGRADED", shotId: shotId || null, message: "镜头仍是降级结果" });
    }
    if (options.noDialogue && hasDialogue(shot, prompt)) {
      issues.push({ code: "DIALOGUE_FORBIDDEN", shotId: shotId || null, message: "无台词口径仍残留台词" });
    }
    const duration = Number(shot.duration ?? (shot.timing as ShotRecord | undefined)?.duration);
    const minDuration = options.minDurationSeconds ?? 1;
    const maxDuration = options.maxDurationSeconds ?? 300;
    if (!Number.isFinite(duration) || !Number.isInteger(duration) || duration < minDuration || duration > maxDuration) {
      issues.push({
        code: "DURATION_INVALID",
        shotId: shotId || null,
        message: `镜头时长必须是 ${minDuration}–${maxDuration} 秒的整数，收到 ${String(shot.duration ?? "空值")}`,
      });
    }
  }
  return { pass: issues.length === 0, issues };
}

export function assertRenderSubmissionEligible(input: {
  status: string;
  providerSubmission: boolean;
  contractPass: boolean;
}): void {
  if (input.status !== "eligible_pending_G8" || input.providerSubmission || !input.contractPass) {
    throw new Error(`RENDER_SUBMIT_BLOCKED: status=${input.status}, providerSubmission=${input.providerSubmission}, contractPass=${input.contractPass}`);
  }
}
