/** Measure actual 1x edits against authored ranges. Source bytes and editorial advice remain separate facts. */
import { auditRhythmPlan, type RhythmPlanInput, type RhythmProfile, type RhythmSegment } from "../../../packages/video-studio/src/rhythm-plan.js";
import type { EditTimeline } from "../../../packages/video-studio/src/edit/timeline.js";
import { rhythmFileSha256, rhythmMediaFacts } from "../rhythm-edit.mts";
export async function inspectEditedRhythm({ timeline, profile, declared, clips, ffprobe }: {
  timeline: EditTimeline; profile: RhythmProfile; declared?: RhythmPlanInput | null;
  clips: Array<{ shotId: string; path: string }>; ffprobe: string;
}) {
  const sourceFacts = await Promise.all(timeline.sources.map(async (source) => {
    const sha256 = await rhythmFileSha256(source.path);
    if (sha256 !== source.sha256) throw new Error(`RHYTHM_SOURCE_HASH_CHANGED: ${source.sourceId}`);
    return { sourceId: source.sourceId, path: source.path, sha256, media: rhythmMediaFacts(source.path, ffprobe) };
  }));
  const authored = timeline.segments.map((segment): RhythmSegment => ({ id: segment.segmentId, sourceId: segment.sourceId,
    inSeconds: segment.sourceIn, outSeconds: segment.sourceOut, durationSeconds: segment.durationSeconds,
    cutReason: segment.motive ?? undefined }));
  const requested = declared ?? { profile, segments: authored };
  if (requested.profile && requested.profile !== profile) throw new Error("RHYTHM_PROFILE_CONFLICT");
  if (requested.segments.length !== authored.length || requested.segments.some((segment, index) => {
    const actual = authored[index]!;
    return segment.id !== actual.id || segment.sourceId !== actual.sourceId || segment.inSeconds !== actual.inSeconds || segment.outSeconds !== actual.outSeconds;
  })) throw new Error("RHYTHM_TIMELINE_PLAN_CONFLICT");
  if (timeline.segments.some((segment) => (segment.speed ?? 1) !== 1)) {
    if (profile !== "natural" || declared) throw new Error("RHYTHM_EXPLICIT_1X_REQUIRED: fast cutting must not accelerate speech");
    return { schemaVersion: "workloom.edit-rhythm/v1", status: "unverified", passed: true, profile, plan: requested,
      sourceFacts, actualClips: clips.map((clip) => ({ ...clip, media: rhythmMediaFacts(clip.path, ffprobe) })),
      reason: "时间轴显式变速使用既有变速契约；不把变速结果冒充 1x 节奏实测", paidCalls: 0, artisticQuality: "unverified" };
  }
  const input: RhythmPlanInput = { ...requested, profile, segments: requested.segments };
  const actualClips = await Promise.all(clips.map(async (clip) => ({ ...clip, sha256: await rhythmFileSha256(clip.path), media: rhythmMediaFacts(clip.path, ffprobe) })));
  if (actualClips.length !== authored.length || actualClips.some((clip, index) => clip.shotId !== authored[index]!.id)) throw new Error("RHYTHM_CLIP_SEQUENCE_CONFLICT");
  const audit = auditRhythmPlan(input, { sourceDurationsSeconds: Object.fromEntries(sourceFacts.map((source) => [source.sourceId, source.media.videoSeconds])),
    actualDurationsSeconds: actualClips.map((clip) => clip.media.videoSeconds), frameToleranceSeconds: 1 / timeline.target.fps + 0.002 });
  if (!audit.pass) throw new Error(`RHYTHM_EDIT_FAILED: ${audit.issues.filter((issue) => issue.severity === "error").map((issue) => `${issue.segmentId ?? "timeline"}: ${issue.code}`).join(", ")}`);
  return { schemaVersion: "workloom.edit-rhythm/v1", status: audit.status, passed: audit.pass, profile, plan: input, audit,
    sourceFacts, actualClips, paidCalls: 0, artisticQuality: "unverified" };
}
export async function assertEditedSourcesPreserved(facts: Array<{ path: string; sha256: string }>) {
  for (const source of facts) if (await rhythmFileSha256(source.path) !== source.sha256) throw new Error("RHYTHM_SOURCE_CHANGED_DURING_POST");
}
