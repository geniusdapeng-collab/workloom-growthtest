/** Source-bound micromotion. Applicability comes before channel count or decorative prose. */
import {
  appendShotContributions, ENHANCEMENT_META_KEY, resolveShotIntent, restoreShotContributions,
  shotIntentHash, shotText, type ShotIntent, type ShotIntentStatus,
} from "./shot-intent.js";

export type MicromotionChannelId = "facial" | "eyes" | "body" | "breath" | "fusion";
export interface MicromotionChannel { id: MicromotionChannelId; clause: string; because: string }
export interface MicromotionTrace {
  schemaVersion: "workloom.micromotion-trace/v1";
  policyVersion: string;
  shotId: string;
  status: ShotIntentStatus;
  sourceHash: string | null;
  intentHash: string | null;
  channels: Array<{ id: MicromotionChannelId; status: ShotIntentStatus; reason: string }>;
  applied: MicromotionChannel[];
  skipped: string | null;
  text: string;
  charDelta: number;
  outputHash?: string;
  errorCode?: string;
}
export const MICROMOTION_MARKER = "【微动作】";
export const MICROMOTION_POLICY_VERSION = "workloom.micromotion-policy/v2";
const MAX_ADDED_CHARS = 200;
const CHANNELS: MicromotionChannelId[] = ["facial", "eyes", "body", "breath", "fusion"];

function empty(card: Record<string, unknown>, status: ShotIntentStatus, reason: string, intent?: ShotIntent): MicromotionTrace {
  return {
    schemaVersion: "workloom.micromotion-trace/v1", policyVersion: MICROMOTION_POLICY_VERSION,
    shotId: String(card?.shotId ?? card?.shot_id ?? ""), status,
    sourceHash: intent?.sourceHash ?? null, intentHash: intent ? shotIntentHash(intent) : null,
    channels: CHANNELS.map((id) => ({ id, status, reason })), applied: [], skipped: reason, text: "", charDelta: 0,
  };
}
function errorTrace(card: Record<string, unknown>, error: unknown): MicromotionTrace {
  const trace = empty(card, "unverified", error instanceof Error ? error.message : String(error));
  trace.errorCode = typeof error === "object" && error && "code" in error ? String(error.code) : "MICROMOTION_INTENT_INVALID";
  return trace;
}

/** Pure proposal. Only complete, compatible clauses enter the bounded proposal. */
export function planMicromotion(card: Record<string, unknown>, options: { intent?: ShotIntent } = {}): MicromotionTrace {
  let intent: ShotIntent;
  try { intent = resolveShotIntent(card, options.intent); } catch (error) { return errorTrace(card, error); }
  if (shotText(intent.source.action ?? (intent.source.fields as Record<string, unknown> | undefined)?.action).includes(MICROMOTION_MARKER)) {
    return empty(card, "unverified", "旧微动作标记没有可验证的本系统贡献记录，需先复核源动作", intent);
  }
  if (!intent.subject.hasPerson) {
    return empty(card, intent.subject.kind === "unknown" ? "unverified" : "not_applicable",
      intent.subject.kind === "unknown" ? "原卡没有可验证的人物主体" : `主体为 ${intent.subject.kind}，人物微动作不适用`, intent);
  }
  const trace = empty(card, "not_applicable", "当前可见部位与动作没有适用的微动作", intent);
  const { subject, performance } = intent;
  const { action, mood, pacing } = performance;
  const proposed: MicromotionChannel[] = [];
  const add = (id: MicromotionChannelId, clause: string, because: string) => proposed.push({ id, clause, because });
  const hasPart = (part: string) => subject.visibleParts.includes(part);
  const awakeFace = subject.faceVisible && !subject.eyesClosed;
  if (awakeFace) {
    if (/惊喜|惊讶|惊艳|眼睛发亮/.test(mood + action)) add("facial", "眉峰轻提后自然回落，嘴角保持原状态", "原卡明确惊喜情绪且面部可见，不额外制造笑意");
    else if (!performance.forbidSmile && /温柔|温暖|治愈|满足|俏皮|调皮|微笑|浅笑/.test(mood + action)) add("facial", "嘴角轻动、笑意缓慢展开，眉部放松", "原卡明确温柔或笑意且未禁止微笑");
    else if (/专注|认真|安静|纪实|克制/.test(mood + action) || performance.forbidSmile) add("facial", "眉部保持放松，嘴角保持原状态", "原卡要求克制或禁止笑意");
  }
  if (awakeFace && hasPart("eyes") && !performance.forbidBlink) {
    if (/看向镜头|注视着镜头|视线.*镜头|眼神交流/.test(action)) add("eyes", "视线保持原注视点，自然眨眼不抢动作", "原卡明确看向镜头");
    else if (/望向|远眺|看向画外|看向|视线随|低头|垂眼/.test(action)) add("eyes", "保持原有视线方向，眼睑轻动不改变注视对象", "原卡已给视线方向");
  }
  if (hasPart("body") || hasPart("upperBody") || hasPart("hands")) {
    if (hasPart("body") || hasPart("upperBody")) {
      if (performance.walking) add("body", "保持原行进路线，重心随步幅平稳转移", "原动作明确行走");
      else if (!performance.forbidRise && /起身|站起/.test(action)) add("body", "沿原起身方向平稳转移重心，抬身不突跳", "原卡明确要求起身，起始坐姿或蹲姿不应阻止动作");
      else if (subject.posture === "crouching") add("body", "保持原蹲姿，重心稳定且不抬身", "原动作是蹲姿");
      else if (subject.posture === "sitting") add("body", "保持原坐姿，肩线放松且不改变支撑位置", "原动作是坐姿");
      else if (["lying", "sleeping"].includes(subject.posture)) add("body", "保持原卧姿与身体支撑位置", "原动作是卧姿或睡眠");
      else if (/转身|回头|回眸/.test(action)) add("body", "保持原转动方向与幅度，肩颈衔接平顺", "原卡明确转身或回头");
      else if (subject.posture === "standing") add("body", "保持原站姿，肩线放松且不增加位移", "原卡明确站姿");
    }
    if (!proposed.some((item) => item.id === "body") && hasPart("hands") && /指|递|捧|端|摆手|挥手|握|拿/.test(action)) add("body", "手部沿原动作路径自然衔接，保持原持物关系", "原动作含可见手部动作");
  }
  if ((hasPart("body") || hasPart("upperBody")) && !performance.hasDialogue && !/屏息|停止呼吸|不呼吸|breath.hold/i.test(action + performance.negativeConstraints.join("；"))) {
    add("breath", "呼吸起伏与原动作强度一致，不改变原有姿态", "原卡人物躯干可见且没有说话或屏息要求");
  }
  if (performance.hasDialogue && /节拍|半拍|节奏|语速|停顿|重音/.test(pacing)) {
    add("fusion", "微动作服从原台词节拍与停顿，不增加额外动作", "原卡有真实台词并显式规定节拍");
  }
  // The marker and separator also count against the promised total increment.
  let used = MICROMOTION_MARKER.length + (shotText(intent.source.action ?? (intent.source.fields as Record<string, unknown> | undefined)?.action) ? 1 : 0);
  for (const item of proposed) {
    const cost = item.clause.length + (trace.applied.length ? 1 : 0);
    const channel = trace.channels.find((entry) => entry.id === item.id)!;
    if (used + cost > MAX_ADDED_CHARS) { channel.status = "unverified"; channel.reason = "整句超出增量预算，未写入"; continue; }
    trace.applied.push(item); used += cost;
    channel.status = "passed"; channel.reason = item.because;
  }
  trace.text = trace.applied.map((item) => item.clause).join("；");
  trace.charDelta = trace.text ? used : 0;
  trace.status = trace.applied.length ? (trace.channels.some((entry) => entry.status === "unverified") ? "unverified" : "passed") : "not_applicable";
  trace.skipped = trace.applied.length ? null : trace.skipped;
  return trace;
}

/** Apply an owned append with exact source/output evidence; repeated application is byte-stable. */
export function applyMicromotion(card: Record<string, unknown>, options: { intent?: ShotIntent } = {}): { card: Record<string, unknown>; trace: MicromotionTrace } {
  const trace = planMicromotion(card, options);
  if (!trace.sourceHash || trace.status === "unverified" && !trace.applied.length) return { card: { ...card }, trace };
  try {
    const restored = restoreShotContributions(card, "micromotion").card;
    if (!trace.applied.length) return { card: restored, trace };
    const beforeAction = shotText(restored.action ?? (restored.fields as Record<string, unknown> | undefined)?.action);
    const result = appendShotContributions(card, { owner: "micromotion", policyVersion: MICROMOTION_POLICY_VERSION, sourceHash: trace.sourceHash }, [{ field: "action", text: MICROMOTION_MARKER + trace.text }]);
    trace.outputHash = shotIntentHash(result.card.action);
    const prior = card[ENHANCEMENT_META_KEY];
    if (prior && shotIntentHash(result.card) === shotIntentHash(card)) {
      trace.skipped = "源意图与贡献一致，复用已核验微动作（幂等）";
      trace.charDelta = 0;
    } else trace.charDelta = shotText(result.card.action).length - beforeAction.length;
    return { card: result.card, trace };
  } catch (error) { return { card: { ...card }, trace: errorTrace(card, error) }; }
}
