/** Real local media regression: source bytes, frames, protected speech, and failed attempts. */
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { executeRhythmEdit, executeRhythmSound, rhythmFileSha256, rhythmMediaFacts, type RhythmEditSource } from "./rhythm-edit.mjs";
import type { RhythmPlanInput } from "../../packages/video-studio/src/rhythm-plan.js";

const ffmpeg = process.env.WL_FFMPEG ?? "ffmpeg", ffprobe = process.env.WL_FFPROBE ?? "ffprobe";
const bases: string[] = [];
let sourceDir: string, audio: string, silent: string, sourceHashes: string[];
const makeRoot = (): string => { const dir = mkdtempSync(join(tmpdir(), "workloom-rhythm-")); bases.push(dir); return dir; };
beforeAll(async () => {
  sourceDir = mkdtempSync(join(tmpdir(), "workloom-rhythm-sources-"));
  audio = join(sourceDir, "native programme & picture.mp4"); silent = join(sourceDir, "silent.mp4");
  execFileSync(ffmpeg, ["-v", "error", "-nostdin", "-n", "-f", "lavfi", "-i", "color=c=blue:s=160x90:r=30:d=4",
    "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000:duration=4", "-map", "0:v:0", "-map", "1:a:0",
    "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-ar", "48000", "-ac", "2", audio], { timeout: 60_000 });
  execFileSync(ffmpeg, ["-v", "error", "-nostdin", "-n", "-i", audio, "-map", "0:v:0", "-c", "copy", "-an", silent], { timeout: 60_000 });
  sourceHashes = await Promise.all([audio, silent].map(rhythmFileSha256));
});
afterEach(async () => {
  expect(await Promise.all([audio, silent].map(rhythmFileSha256))).toEqual(sourceHashes);
  for (const dir of bases.splice(0)) rmSync(dir, { recursive: true, force: true });
});
afterAll(() => rmSync(sourceDir, { recursive: true, force: true }));
const plan = (): RhythmPlanInput => ({ profile: "fast-cut", segments: [
  { id: "detail", sourceId: "a", inSeconds: 1, outSeconds: 1.5, role: "fast", cutReason: "cut on latch release" },
  { id: "reveal", sourceId: "b", inSeconds: 0, outSeconds: 2, role: "hold", cutReason: "read room layout" },
  { id: "breath", sourceId: "c", inSeconds: 0, outSeconds: 3, role: "breath", cutReason: "listen to room tone" },
] });
const sources = (): RhythmEditSource[] => [{ sourceId: "a", file: audio }, { sourceId: "b", file: silent }, { sourceId: "c", file: audio }];
const execute = (p = plan(), s = sources(), root = makeRoot(), binary = ffmpeg) => executeRhythmEdit({ plan: p, sources: s, outputDir: root, ffmpeg: binary, ffprobe, fps: 30 });

describe("actual local rhythm edit preserves provider sources", () => {
  it("cuts measured 0.5/2/3-second ranges at 1x, preserves native canvas, and emits current hashes", async () => {
    const result = await execute(); expect(result.actualDurationsSeconds).toEqual([0.5, 2, 3]);
    expect(result.cutTimesSeconds).toEqual([0.5, 2.5]); expect(result.durationSeconds).toBe(5.5);
    const receipt = JSON.parse(readFileSync(result.reportFile, "utf8"));
    expect(receipt).toMatchObject({ schemaVersion: "workloom.rhythm-edit/v1", originalSpeed: 1, pictureAndAudioSameRanges: true,
      qualityReviewPerformed: false, soundCueExecution: "unverified", audit: { pass: true, status: "passed", evidence: { artisticQuality: "unverified" } } });
    expect(receipt.outputs.map((output: { media: { videoFrames: number } }) => output.media.videoFrames)).toEqual([15, 60, 90]);
    for (const [index, clip] of result.clips.entries()) {
      expect(receipt.outputs[index].sha256).toBe(await rhythmFileSha256(clip));
      expect(rhythmMediaFacts(clip, ffprobe)).toMatchObject({ fps: 30, width: 160, height: 90, hasAudio: index !== 1 });
    }
    const pcm = execFileSync(ffmpeg, ["-v", "error", "-i", result.clips[0]!, "-ss", "0.05", "-t", "0.35", "-map", "0:a:0", "-ac", "1", "-ar", "48000", "-f", "f32le", "-"], { maxBuffer: 1024 * 1024 });
    let crossings = 0; for (let byte = 4; byte < pcm.length; byte += 4) if (pcm.readFloatLE(byte - 4) <= 0 && pcm.readFloatLE(byte) > 0) crossings++;
    const measuredFrequency = crossings / (pcm.length / 4 / 48000);
    expect(measuredFrequency).toBeGreaterThan(435); expect(measuredFrequency).toBeLessThan(445);
  }, 60_000);
  it("keeps repeated executions isolated so an earlier successful receipt cannot certify a later attempt", async () => {
    const root = makeRoot(), first = await execute(plan(), sources(), root), second = await execute(plan(), sources(), root);
    expect(first.reportFile).not.toBe(second.reportFile); expect(existsSync(first.reportFile)).toBe(true); expect(existsSync(second.reportFile)).toBe(true);
    const before = readdirSync(root); await expect(execute(plan(), sources(), root, "/missing-ffmpeg")).rejects.toThrow();
    expect(readdirSync(root)).toEqual(before);
  }, 60_000);
  it("retains a complete declared spoken interval and refuses unknown spoken timing", async () => {
    const p = plan(), s = sources(); s[0]!.hasSpeech = true;
    await expect(execute(p, s)).rejects.toThrow(/RHYTHM_SPEECH_PROTECTION_REQUIRED/);
    p.segments[0]!.protectedRanges = [{ inSeconds: 1.1, outSeconds: 1.4, kind: "speech", reason: "complete source sentence" }];
    expect((await execute(p, s)).actualDurationsSeconds[0]).toBe(0.5);
  }, 60_000);
  it.each(["speech", "action"] as const)("blocks cutting a protected %s interval before creating output", async kind => {
    const p = plan(), root = makeRoot(); p.segments[0]!.protectedRanges = [{ inSeconds: 0.5, outSeconds: 2, kind, reason: "complete interval" }];
    await expect(execute(p, sources(), root)).rejects.toThrow(/RHYTHM_PROTECTED_CONTENT_CUT/); expect(readdirSync(root)).toEqual([]);
  });
  it("rejects source overrun and a whole-source lock", async () => {
    const p = plan(); p.segments[0]!.outSeconds = 4.5; await expect(execute(p)).rejects.toThrow(/RHYTHM_SOURCE_OVERRUN/);
    const s = sources(); s[0]!.lockTrim = true; await expect(execute(plan(), s)).rejects.toThrow(/RHYTHM_LOCKED_SOURCE_TRIMMED/);
  });
  it("rejects missing, duplicate and reordered source registries", async () => {
    const s = sources(); s[0]!.file = join(sourceDir, "missing.mp4"); await expect(execute(plan(), s)).rejects.toThrow(/RHYTHM_SOURCE_FILE_MISSING/);
    const duplicate = sources(); duplicate[1]!.sourceId = "a"; await expect(execute(plan(), duplicate)).rejects.toThrow(/RHYTHM_SOURCE_REGISTRY_INVALID/);
    await expect(execute(plan(), sources().reverse())).rejects.toThrow(/RHYTHM_SEQUENCE_CONFLICT/);
  });
  it("cleans a failed subprocess attempt and refuses invalid export fps", async () => {
    const root = makeRoot(); await expect(execute(plan(), sources(), root, "/missing-ffmpeg")).rejects.toThrow(); expect(readdirSync(root)).toEqual([]);
    await expect(executeRhythmEdit({ plan: plan(), sources: sources(), outputDir: root, ffmpeg, ffprobe, fps: NaN })).rejects.toThrow(/RHYTHM_EXPORT_FPS_INVALID/);
  });
  it("renders a declared effect at its current timeline point, retains quiet breathing time and leaves picture packets unchanged", async () => {
    const p: RhythmPlanInput = { segments: [{ id: "body", sourceId: "source", inSeconds: 0, outSeconds: 4 }],
      soundCues: [{ atSeconds: 0.5, kind: "impact", reason: "latch opens", gainDb: -12 }, { atSeconds: 2, kind: "ambience", reason: "hold the native room tone" }] };
    const result = await executeRhythmSound({ plan: p, file: silent, outputDir: makeRoot(), ffmpeg, ffprobe });
    expect(result.placements).toEqual([{ atSec: 0.5, kind: "impact", reason: "latch opens", gainDb: -12 }]);
    const receipt = JSON.parse(readFileSync(result.reportFile, "utf8"));
    expect(receipt).toMatchObject({ schemaVersion: "workloom.rhythm-sound/v1", videoPacketsUnchanged: true,
      programmeSpeed: 1, qualityReviewPerformed: false, artisticQuality: "unverified" });
    expect(receipt.unverifiedCues).toHaveLength(1); expect(receipt.output.sha256).toBe(await rhythmFileSha256(result.file));
    const peak = (from: string, duration: string): number => {
      const pcm = execFileSync(ffmpeg, ["-v", "error", "-i", result.file, "-ss", from, "-t", duration, "-map", "0:a:0", "-ac", "1", "-f", "f32le", "-"], { maxBuffer: 1024 * 1024 });
      let value = 0; for (let byte = 0; byte < pcm.length; byte += 4) value = Math.max(value, Math.abs(pcm.readFloatLE(byte))); return value;
    };
    expect(peak("0.1", "0.1")).toBeLessThan(0.00001); expect(peak("0.5", "0.3")).toBeGreaterThan(0.001); expect(peak("2", "0.3")).toBeLessThan(0.00001);
  }, 60_000);
  it("sound processing preserves the original programme pitch and reports the actual unchanged source hash", async () => {
    const p: RhythmPlanInput = { segments: [{ id: "body", sourceId: "source", inSeconds: 0, outSeconds: 4 }], soundCues: [{ atSeconds: 0.5, kind: "whoosh", reason: "authored camera move" }] };
    const result = await executeRhythmSound({ plan: p, file: audio, outputDir: makeRoot(), ffmpeg, ffprobe });
    const pcm = execFileSync(ffmpeg, ["-v", "error", "-i", result.file, "-ss", "1.2", "-t", "0.5", "-map", "0:a:0", "-ac", "1", "-ar", "48000", "-f", "f32le", "-"], { maxBuffer: 1024 * 1024 });
    let crossings = 0; for (let byte = 4; byte < pcm.length; byte += 4) if (pcm.readFloatLE(byte - 4) <= 0 && pcm.readFloatLE(byte) > 0) crossings++;
    expect(crossings / (pcm.length / 4 / 48000)).toBeCloseTo(440, 0);
    expect(JSON.parse(readFileSync(result.reportFile, "utf8")).source.sha256).toBe(sourceHashes[0]);
  }, 60_000);
  it("sound processing refuses a mismatched timeline, absent synthetic request, and failed tool without a success receipt", async () => {
    const root = makeRoot(), p: RhythmPlanInput = { segments: [{ id: "body", sourceId: "source", inSeconds: 0, outSeconds: 4 }], soundCues: [{ atSeconds: 0.5, kind: "impact", reason: "action" }] };
    await expect(executeRhythmSound({ plan: plan(), file: silent, outputDir: root, ffmpeg, ffprobe })).rejects.toThrow(/RHYTHM_SYNTHETIC_SOUND_NOT_REQUESTED/);
    await expect(executeRhythmSound({ plan: { ...p, segments: [{ id: "body", sourceId: "source", inSeconds: 0, outSeconds: 3 }] }, file: silent, outputDir: root, ffmpeg, ffprobe })).rejects.toThrow(/RHYTHM_SOUND_TIMELINE_MISMATCH/);
    await expect(executeRhythmSound({ plan: p, file: silent, outputDir: root, ffmpeg: "/missing-ffmpeg", ffprobe })).rejects.toThrow(); expect(readdirSync(root)).toEqual([]);
  });
});
