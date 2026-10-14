import { describe, expect, it } from "vitest";
import { auditRhythmPlan, buildRhythmPlan, rhythmSfxPlacements, rhythmTrimFilters, type RhythmPlanInput } from "./rhythm-plan.js";
const plan = (): RhythmPlanInput => ({ profile: "fast-cut", segments: [
  { id: "cut", sourceId: "s1", inSeconds: 1, outSeconds: 1.5, role: "fast", cutReason: "hand reaches product" },
  { id: "reveal", sourceId: "s2", inSeconds: 0, outSeconds: 2, role: "hold", cutReason: "reveal useful scale" },
  { id: "rest", sourceId: "s3", inSeconds: 0, outSeconds: 3, role: "breath", cutReason: "listen to room tone" },
], soundCues: [{ kind: "ambience", atSeconds: 2.5, reason: "room tone preserves breathing moment" }] });
const codes = (p: RhythmPlanInput, o: Parameters<typeof auditRhythmPlan>[1] = {}) => auditRhythmPlan(p, o).issues.map((issue) => issue.code);
describe("source-bound editorial rhythm", () => {
  it("compiles the actual source intervals and output cuts", () => {
    const p = buildRhythmPlan(plan()); expect(p.totalSeconds).toBe(5.5); expect(p.cutTimesSeconds).toEqual([0.5, 2.5]);
    expect(p.segments[2]!.startSeconds).toBe(2.5); expect(p.inputSha256).toHaveLength(64);
  });
  it("declared planning cannot claim measured delivery", () => { expect(auditRhythmPlan(plan()).status).toBe("unverified"); });
  it("accepts the measured planned output and explicitly keeps aesthetic quality unverified", () => {
    const result = auditRhythmPlan(plan(), { sourceDurationsSeconds: { s1: 4, s2: 4, s3: 4 }, actualDurationsSeconds: [0.5, 2, 3] });
    expect(result.pass).toBe(true); expect(result.status).toBe("passed"); expect(result.evidence.artisticQuality).toBe("unverified");
  });
  it("rejects provider minimum duration masquerading as a half-second cut", () => { expect(codes(plan(), { actualDurationsSeconds: [4, 4, 4] })).toContain("RHYTHM_OUTPUT_DURATION_MISMATCH"); });
  it("rejects all-fast cuts and a missing breathing moment", () => {
    const p = plan(); p.segments = p.segments.map((s) => ({ ...s, outSeconds: s.inSeconds + 0.5, role: "fast" }));
    expect(codes(p)).toEqual(expect.arrayContaining(["RHYTHM_FAST_SLOW_MISSING", "RHYTHM_BREATH_MISSING"]));
  });
  it("rejects trimming a protected sentence or action", () => {
    const p = plan(); p.segments[0]!.protectedRanges = [{ inSeconds: 0.5, outSeconds: 2, kind: "speech", reason: "complete sentence" }];
    expect(codes(p)).toContain("RHYTHM_PROTECTED_CONTENT_CUT");
  });
  it("accepts an intact protected action", () => {
    const p = plan(); p.segments[2]!.protectedRanges = [{ inSeconds: 0, outSeconds: 3, kind: "action", reason: "door opens and settles" }]; expect(auditRhythmPlan(p).pass).toBe(true);
  });
  it("requires a measured entire source for a trim lock", () => {
    const p = plan(); p.segments[0]!.lockTrim = true; expect(codes(p, { sourceDurationsSeconds: { s1: 4, s2: 4, s3: 4 } })).toContain("RHYTHM_LOCKED_SOURCE_TRIMMED");
  });
  it("rejects unknown or exhausted sources and sequence-count mismatch", () => {
    const p = plan(); expect(codes(p, { sourceDurationsSeconds: { s1: 1, s2: 4 } })).toEqual(expect.arrayContaining(["RHYTHM_SOURCE_OVERRUN", "RHYTHM_SOURCE_UNMEASURED"]));
    expect(codes(p, { actualDurationsSeconds: [0.5] })).toContain("RHYTHM_OUTPUT_COUNT_MISMATCH");
  });
  it.each<{ segments: RhythmPlanInput["segments"] }>([
    { segments: [] },
    { segments: [{ id: "x", sourceId: "s", inSeconds: 0, outSeconds: 0 }] },
    { segments: [{ id: "x", sourceId: "s", inSeconds: -1, outSeconds: 1 }] },
    { segments: [{ id: "x", sourceId: "s", inSeconds: 0, outSeconds: NaN }] },
  ])("rejects invalid ranges %j", ({ segments }) => { expect(auditRhythmPlan({ segments }).pass).toBe(false); });
  it("rejects duplicate ids, unsupported profiles and duration conflicts", () => {
    const p = plan(); p.segments[1]!.id = p.segments[0]!.id; expect(auditRhythmPlan(p).pass).toBe(false);
    const q = plan(); q.segments[0]!.durationSeconds = 4; expect(auditRhythmPlan(q).pass).toBe(false);
    expect(auditRhythmPlan({ ...plan(), profile: "guess" as never }).pass).toBe(false);
  });
  it("does not mistake declared BPM or empty analysis for measured beats", () => {
    const p = plan(); p.beatEvidence = { status: "measured", sourceSha256: "", method: "metadata", beatTimesSeconds: [] }; p.segments[0]!.beatIndex = 0;
    expect(codes(p)).toEqual(expect.arrayContaining(["RHYTHM_BEAT_EVIDENCE_UNVERIFIED", "RHYTHM_BEAT_REFERENCE_INVALID"]));
  });
  it("checks cuts against source-bound measured beats", () => {
    const p = plan(); p.beatEvidence = { status: "measured", sourceSha256: "a".repeat(64), method: "onset pulse analysis", beatTimesSeconds: [0.5, 2.5] }; p.segments[0]!.beatIndex = 0;
    expect(auditRhythmPlan(p).evidence.beatAlignment).toBe("declared"); p.beatEvidence.beatTimesSeconds[0] = 0.9; expect(codes(p)).toContain("RHYTHM_BEAT_MISALIGNED");
  });
  it("rejects out-of-window sound and nonsensical tolerances", () => {
    const p = plan(); p.soundCues![0]!.atSeconds = 99; expect(codes(p)).toContain("RHYTHM_SOUND_CUE_INVALID");
    expect(codes(plan(), { frameToleranceSeconds: 4 })).toContain("RHYTHM_TOLERANCE_INVALID");
  });
  it("uniform natural scenes get an advisory instead of an aesthetic rejection", () => {
    const p = { segments: [0, 1, 2, 3].map((i) => ({ id: String(i), sourceId: String(i), inSeconds: 0, outSeconds: 4 })) };
    expect(auditRhythmPlan(p).pass).toBe(true); expect(codes(p)).toContain("RHYTHM_FLAT_DURATION");
  });
  it("preserves original 1x speech with equal picture/audio intervals", () => {
    const filters = rhythmTrimFilters({ inSeconds: 1, outSeconds: 1.5 });
    expect(filters.video).toBe("trim=start=1.000000:end=1.500000,setpts=PTS-STARTPTS"); expect(filters.audio).toBe("atrim=start=1.000000:end=1.500000,asetpts=PTS-STARTPTS"); expect(JSON.stringify(filters)).not.toMatch(/atempo|\*PTS|\/PTS/);
  });
  it("executes only authored synthetic cues and never fills all cuts with effects", () => {
    const p = plan(); p.soundCues!.push({ atSeconds: 0.5, kind: "impact", reason: "latch releases", gainDb: -24 });
    expect(rhythmSfxPlacements(p)).toEqual([{ atSec: 0.5, kind: "impact", reason: "latch releases", gainDb: -24 }]);
    expect(rhythmSfxPlacements(plan())).toEqual([]);
  });
  it("rejects an inaudible end-point cue and unsafe effect gain", () => {
    const p = plan(); p.soundCues = [{ atSeconds: 5.5, kind: "impact", reason: "too late" }]; expect(auditRhythmPlan(p).pass).toBe(false);
    p.soundCues = [{ atSeconds: 0.5, kind: "impact", reason: "too loud", gainDb: 10 }]; expect(() => rhythmSfxPlacements(p)).toThrow(/RHYTHM_SOUND_PLAN_INVALID/);
  });
});
