/** Editorial rhythm is measured on the finished timeline, independently of provider clip length. */
import { createHash } from "node:crypto";

export const RHYTHM_PLAN_VERSION = "editorial-rhythm/v1";
export type RhythmProfile = "natural" | "fast-cut" | "cinematic";
export type RhythmRole = "fast" | "hold" | "breath" | "story";
export interface RhythmSegment {
  id: string; sourceId: string; inSeconds: number; outSeconds: number; durationSeconds?: number;
  role?: RhythmRole; cutReason?: string; beatIndex?: number;
  /** Explicit source intervals that must survive intact: a spoken sentence or complete action. */
  protectedRanges?: Array<{ inSeconds: number; outSeconds: number; kind: "speech" | "action"; reason: string }>;
  lockTrim?: boolean;
}
export interface RhythmBeatEvidence {
  status: "measured" | "unverified"; sourceSha256: string; method: string;
  beatTimesSeconds: number[]; /** Times already mapped onto this output timeline. */
  confidence?: number;
}
export interface RhythmSoundCue {
  atSeconds: number; kind: "impact" | "whoosh" | "ambience" | "silence" | "music-entry" | "music-exit";
  reason: string; gainDb?: number;
}
export interface RhythmPlanInput {
  profile?: RhythmProfile; segments: RhythmSegment[]; beatEvidence?: RhythmBeatEvidence;
  soundCues?: RhythmSoundCue[]; beatToleranceSeconds?: number;
}
export interface RhythmPlan {
  version: typeof RHYTHM_PLAN_VERSION; profile: RhythmProfile; inputSha256: string;
  totalSeconds: number; cutTimesSeconds: number[];
  segments: Array<RhythmSegment & { durationSeconds: number; startSeconds: number; endSeconds: number }>;
  beatEvidence: RhythmBeatEvidence | null; soundCues: RhythmSoundCue[];
}
export interface RhythmIssue { code: string; severity: "error" | "advisory"; segmentId: string | null; detail: string }
export interface RhythmAudit {
  version: typeof RHYTHM_PLAN_VERSION; pass: boolean; status: "passed" | "failed" | "unverified";
  plan: RhythmPlan | null; issues: RhythmIssue[];
  evidence: { timeline: "declared" | "measured"; artisticQuality: "unverified"; beatAlignment: "declared" | "unverified" };
}
const finite = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);
const digest = (value: unknown): string => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const round = (value: number): number => Number(value.toFixed(6));

/** Strictly compile declared ranges. No automatic speed changes, source padding, or invented beats. */
export function buildRhythmPlan(input: RhythmPlanInput): RhythmPlan {
  if (!input || typeof input !== "object" || !Array.isArray(input.segments) || !input.segments.length) throw new Error("RHYTHM_SEGMENTS_REQUIRED");
  if (input.profile !== undefined && !["natural", "fast-cut", "cinematic"].includes(input.profile)) throw new Error("RHYTHM_PROFILE_INVALID");
  let cursor = 0;
  const seen = new Set<string>();
  const segments = input.segments.map((segment) => {
    if (!segment || typeof segment !== "object" || typeof segment.id !== "string" || !segment.id.trim() || seen.has(segment.id)
      || typeof segment.sourceId !== "string" || !segment.sourceId.trim()) throw new Error("RHYTHM_SEGMENT_ID_INVALID");
    seen.add(segment.id);
    if (!finite(segment.inSeconds) || !finite(segment.outSeconds) || segment.inSeconds < 0 || segment.outSeconds <= segment.inSeconds) throw new Error(`RHYTHM_SOURCE_RANGE_INVALID: ${segment.id}`);
    const durationSeconds = round(segment.outSeconds - segment.inSeconds);
    if (segment.durationSeconds !== undefined && (!finite(segment.durationSeconds) || Math.abs(segment.durationSeconds - durationSeconds) > 0.002)) throw new Error(`RHYTHM_DURATION_CONFLICT: ${segment.id}`);
    if (segment.role !== undefined && !["fast", "hold", "breath", "story"].includes(segment.role)) throw new Error(`RHYTHM_ROLE_INVALID: ${segment.id}`);
    const startSeconds = cursor; cursor = round(cursor + durationSeconds);
    return { ...segment, durationSeconds, startSeconds, endSeconds: cursor };
  });
  return { version: RHYTHM_PLAN_VERSION, profile: input.profile ?? "natural", inputSha256: digest(input), totalSeconds: cursor,
    cutTimesSeconds: segments.slice(0, -1).map((segment) => segment.endSeconds), segments,
    beatEvidence: input.beatEvidence ?? null, soundCues: input.soundCues ?? [] };
}

/** Errors concern verifiable contracts; editorial suggestions never masquerade as visual review. */
export function auditRhythmPlan(input: RhythmPlanInput, options: {
  sourceDurationsSeconds?: Record<string, number>; actualDurationsSeconds?: number[]; frameToleranceSeconds?: number;
} = {}): RhythmAudit {
  const issues: RhythmIssue[] = [];
  const issue = (code: string, severity: RhythmIssue["severity"], detail: string, segmentId: string | null = null): void => { issues.push({ code, severity, detail, segmentId }); };
  let plan: RhythmPlan;
  try { plan = buildRhythmPlan(input); } catch (error) {
    issue("RHYTHM_INPUT_INVALID", "error", error instanceof Error ? error.message : String(error));
    return { version: RHYTHM_PLAN_VERSION, pass: false, status: "failed", plan: null, issues,
      evidence: { timeline: "declared", artisticQuality: "unverified", beatAlignment: "unverified" } };
  }
  const tolerance = options.frameToleranceSeconds ?? 0.05;
  if (!finite(tolerance) || tolerance < 0 || tolerance > 0.2) issue("RHYTHM_TOLERANCE_INVALID", "error", "Frame tolerance must be between 0 and 0.2 seconds");
  const safeTolerance = finite(tolerance) && tolerance >= 0 && tolerance <= 0.2 ? tolerance : 0.05;
  for (const segment of plan.segments) {
    const sourceDuration = options.sourceDurationsSeconds?.[segment.sourceId];
    if (options.sourceDurationsSeconds && (!finite(sourceDuration) || sourceDuration <= 0)) issue("RHYTHM_SOURCE_UNMEASURED", "error", "Source duration has no current probe evidence", segment.id);
    else if (sourceDuration !== undefined && segment.outSeconds > sourceDuration + safeTolerance) issue("RHYTHM_SOURCE_OVERRUN", "error", `Source ends at ${sourceDuration}s; requested out point is ${segment.outSeconds}s`, segment.id);
    if (segment.lockTrim && (segment.inSeconds > safeTolerance || options.sourceDurationsSeconds !== undefined && (sourceDuration === undefined || Math.abs(segment.outSeconds - sourceDuration) > safeTolerance))) issue("RHYTHM_LOCKED_SOURCE_TRIMMED", "error", "Complete-action trim lock requires the entire measured source", segment.id);
    if (segment.protectedRanges !== undefined && !Array.isArray(segment.protectedRanges)) issue("RHYTHM_PROTECTION_INVALID", "error", "protectedRanges must be an array", segment.id);
    for (const range of Array.isArray(segment.protectedRanges) ? segment.protectedRanges : []) {
      if (!range || !finite(range.inSeconds) || !finite(range.outSeconds) || range.inSeconds < 0 || range.outSeconds <= range.inSeconds
        || !["speech", "action"].includes(range.kind) || typeof range.reason !== "string" || !range.reason.trim()) issue("RHYTHM_PROTECTION_INVALID", "error", "Protected interval requires source in/out, kind, and evidence reason", segment.id);
      else if (range.inSeconds < segment.inSeconds - safeTolerance || range.outSeconds > segment.outSeconds + safeTolerance) issue("RHYTHM_PROTECTED_CONTENT_CUT", "error", `${range.kind}: ${range.reason}`, segment.id);
    }
    if (plan.profile === "fast-cut" && (typeof segment.cutReason !== "string" || !segment.cutReason.trim())) issue("RHYTHM_CUT_REASON_MISSING", "error", "Explicit fast cut requires a story, action, speech, or measured beat reason", segment.id);
  }
  if (plan.profile === "fast-cut") {
    // These are transparent editorial heuristics, not universal cinematic quality thresholds.
    const fast = plan.segments.filter((segment) => segment.role === "fast" && segment.durationSeconds <= 1.2);
    const rests = plan.segments.filter((segment) => ["hold", "breath"].includes(segment.role ?? "") && segment.durationSeconds >= 1.5);
    if (!fast.length || !rests.length) issue("RHYTHM_FAST_SLOW_MISSING", "error", "Fast-cut contract requires at least one fast segment <=1.2s and one hold/breath >=1.5s; cut duration alone is insufficient");
    if (!plan.segments.some((segment) => segment.role === "breath")) issue("RHYTHM_BREATH_MISSING", "error", "Fast-cut contract requires a declared breathing moment");
    if (!plan.soundCues.length) issue("RHYTHM_SOUND_UNPLANNED", "advisory", "No action/ambience/music contrast cues were declared; sound design remains unverified");
  } else if (plan.segments.length >= 4 && Math.max(...plan.segments.map((s) => s.durationSeconds)) - Math.min(...plan.segments.map((s) => s.durationSeconds)) < 0.1) {
    issue("RHYTHM_FLAT_DURATION", "advisory", "Shot lengths are uniform; review whether the story needs an emphasis or breathing moment");
  }
  const beats = plan.beatEvidence;
  let measuredBeats = false;
  if (beats) {
    measuredBeats = beats.status === "measured" && /^[a-f0-9]{64}$/i.test(beats.sourceSha256) && typeof beats.method === "string" && Boolean(beats.method.trim())
      && Array.isArray(beats.beatTimesSeconds) && beats.beatTimesSeconds.length > 0
      && beats.beatTimesSeconds.every((time, index, all) => finite(time) && time >= 0 && (index === 0 || time > all[index - 1]!))
      && (beats.confidence === undefined || finite(beats.confidence) && beats.confidence >= 0 && beats.confidence <= 1);
    if (!measuredBeats) issue("RHYTHM_BEAT_EVIDENCE_UNVERIFIED", "advisory", "Measured beats require a source hash, method and strictly increasing finite timestamps; BPM metadata is insufficient");
  }
  const beatTolerance = input.beatToleranceSeconds ?? 0.08;
  if (!finite(beatTolerance) || beatTolerance < 0 || beatTolerance > 0.2) issue("RHYTHM_BEAT_TOLERANCE_INVALID", "error", "Beat tolerance must be between 0 and 0.2 seconds");
  for (const segment of plan.segments.slice(0, -1)) if (segment.beatIndex !== undefined) {
    const beat = measuredBeats && Number.isInteger(segment.beatIndex) && segment.beatIndex >= 0 ? beats!.beatTimesSeconds[segment.beatIndex] : undefined;
    if (beat === undefined) issue("RHYTHM_BEAT_REFERENCE_INVALID", "error", "Claimed beat cut has no measured beat at this index", segment.id);
    else if (Math.abs(beat - segment.endSeconds) > beatTolerance) issue("RHYTHM_BEAT_MISALIGNED", "error", `Cut ${segment.endSeconds}s differs from measured beat ${beat}s`, segment.id);
  }
  if (!Array.isArray(plan.soundCues)) issue("RHYTHM_SOUND_CUE_INVALID", "error", "soundCues must be an array");
  for (const cue of Array.isArray(plan.soundCues) ? plan.soundCues : []) if (!cue || !finite(cue.atSeconds) || cue.atSeconds < 0 || cue.atSeconds > plan.totalSeconds
    || ["impact", "whoosh"].includes(cue.kind) && cue.atSeconds >= plan.totalSeconds
    || !["impact", "whoosh", "ambience", "silence", "music-entry", "music-exit"].includes(cue.kind) || typeof cue.reason !== "string" || !cue.reason.trim()
    || cue.gainDb !== undefined && (!finite(cue.gainDb) || cue.gainDb < -60 || cue.gainDb > 0)) issue("RHYTHM_SOUND_CUE_INVALID", "error", "Sound cue requires a valid output time, supported kind, reason, and gain between -60 and 0 dB");
  const actual = options.actualDurationsSeconds;
  if (actual !== undefined) {
    if (!Array.isArray(actual) || actual.length !== plan.segments.length) issue("RHYTHM_OUTPUT_COUNT_MISMATCH", "error", "Measured output intervals do not cover the declared sequence");
    else actual.forEach((duration, index) => {
      if (!finite(duration) || duration <= 0 || Math.abs(duration - plan.segments[index]!.durationSeconds) > safeTolerance) issue("RHYTHM_OUTPUT_DURATION_MISMATCH", "error", `Measured ${duration}s; planned ${plan.segments[index]!.durationSeconds}s`, plan.segments[index]!.id);
    });
  }
  const pass = !issues.some((entry) => entry.severity === "error");
  return { version: RHYTHM_PLAN_VERSION, pass, status: pass ? actual !== undefined ? "passed" : "unverified" : "failed", plan, issues,
    // Supplied timestamps can be compared; this pure audit did not decode their music source.
    evidence: { timeline: actual !== undefined ? "measured" : "declared", artisticQuality: "unverified", beatAlignment: measuredBeats ? "declared" : "unverified" } };
}

/** Only explicitly authored synthetic cues execute here; ambience/music need their own source receipts. */
export function rhythmSfxPlacements(input: RhythmPlanInput): Array<{ atSec: number; kind: "impact" | "whoosh"; gainDb: number; reason: string }> {
  const audit = auditRhythmPlan(input);
  if (!audit.pass || !audit.plan) throw new Error("RHYTHM_SOUND_PLAN_INVALID");
  return audit.plan.soundCues.filter((cue): cue is RhythmSoundCue & { kind: "impact" | "whoosh" } => cue.kind === "impact" || cue.kind === "whoosh")
    .map((cue) => ({ atSec: cue.atSeconds, kind: cue.kind, gainDb: cue.gainDb ?? -18, reason: cue.reason }));
}

/** Same 1x timeline for picture and programme audio; reset timestamps only, never accelerate speech. */
export function rhythmTrimFilters(segment: Pick<RhythmSegment, "inSeconds" | "outSeconds">): { video: string; audio: string } {
  if (!finite(segment.inSeconds) || !finite(segment.outSeconds) || segment.inSeconds < 0 || segment.outSeconds <= segment.inSeconds) throw new Error("RHYTHM_SOURCE_RANGE_INVALID");
  const range = `start=${segment.inSeconds.toFixed(6)}:end=${segment.outSeconds.toFixed(6)}`;
  return { video: `trim=${range},setpts=PTS-STARTPTS`, audio: `atrim=${range},asetpts=PTS-STARTPTS` };
}
