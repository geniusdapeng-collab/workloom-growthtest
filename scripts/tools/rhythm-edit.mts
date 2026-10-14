/** Local editorial trim executor. Original provider files are read-only and retain their native 1x sound. */
import { createHash, randomUUID } from "node:crypto";
import { createReadStream, existsSync, mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join, resolve } from "node:path";
import { auditRhythmPlan, rhythmSfxPlacements, rhythmTrimFilters, type RhythmPlanInput, type RhythmSegment } from "../../packages/video-studio/src/rhythm-plan.js";
import { buildSfxArgs } from "../../packages/video-studio/src/sfx-synth.js";
export interface RhythmEditSource {
  sourceId: string; file: string; lockTrim?: boolean; hasSpeech?: boolean;
  protectedRanges?: RhythmSegment["protectedRanges"];
}

/** Same compressed picture packets, original programme audio at 1x, and only the requested synthetic effects. */
export async function executeRhythmSound(input: {
  plan: RhythmPlanInput; file: string; outputDir: string; ffmpeg: string; ffprobe: string;
}): Promise<{ file: string; reportFile: string; placements: ReturnType<typeof rhythmSfxPlacements> }> {
  const placements = rhythmSfxPlacements(input.plan);
  if (!placements.length) throw new Error("RHYTHM_SYNTHETIC_SOUND_NOT_REQUESTED");
  const sourceSha256 = await rhythmFileSha256(input.file), sourceMedia = rhythmMediaFacts(input.file, input.ffprobe);
  const plan = auditRhythmPlan(input.plan).plan!;
  if (Math.abs(sourceMedia.videoSeconds - plan.totalSeconds) > 1 / sourceMedia.fps + 0.005) throw new Error("RHYTHM_SOUND_TIMELINE_MISMATCH");
  const attemptDir = join(input.outputDir, `sound-${plan.inputSha256.slice(0, 12)}-${randomUUID()}`);
  mkdirSync(attemptDir, { recursive: true });
  let completed = false;
  try {
    const effects = placements.map((placement, index) => {
      const file = join(attemptDir, `effect-${String(index + 1).padStart(3, "0")}.wav`);
      execFileSync(input.ffmpeg, ["-v", "error", "-nostdin", "-n", ...buildSfxArgs({ kind: placement.kind, durationSec: placement.kind === "impact" ? 0.26 : 0.36 }), file], { maxBuffer: 8 * 1024 * 1024 });
      return file;
    });
    const track = join(attemptDir, "effects.wav");
    const delays = placements.map((placement, index) => `[${index}:a]adelay=${Math.round(placement.atSec * 1000)}:all=1,volume=${placement.gainDb}dB[a${index}]`).join(";");
    const effectMix = placements.map((_, index) => `[a${index}]`).join("");
    execFileSync(input.ffmpeg, ["-v", "error", "-nostdin", "-n", ...effects.flatMap((file) => ["-i", file]),
      "-filter_complex", `${delays};${effectMix}amix=inputs=${placements.length}:normalize=0:dropout_transition=0,apad[aout]`,
      "-map", "[aout]", "-t", String(sourceMedia.videoSeconds), "-ar", "48000", "-ac", "2", "-c:a", "pcm_s16le", track], { maxBuffer: 8 * 1024 * 1024 });
    const file = join(attemptDir, "master-sound.mp4");
    const args = ["-v", "error", "-nostdin", "-n", "-i", input.file, "-i", track];
    if (sourceMedia.hasAudio) args.push("-filter_complex", "[0:a:0][1:a:0]amix=inputs=2:duration=longest:normalize=0[aout]", "-map", "0:v:0", "-map", "[aout]");
    else args.push("-map", "0:v:0", "-map", "1:a:0");
    args.push("-c:v", "copy", "-c:a", "aac", "-b:a", "192k", "-ar", "48000", "-ac", "2", "-t", String(sourceMedia.videoSeconds), "-movflags", "+faststart", file);
    execFileSync(input.ffmpeg, args, { maxBuffer: 8 * 1024 * 1024 });
    const outputMedia = rhythmMediaFacts(file, input.ffprobe);
    if (outputMedia.videoFrames !== sourceMedia.videoFrames || Math.abs(outputMedia.fps - sourceMedia.fps) > 0.00001
      || outputMedia.width !== sourceMedia.width || outputMedia.height !== sourceMedia.height || !outputMedia.hasAudio) throw new Error("RHYTHM_SOUND_EXPORT_CHANGED_PICTURE_CLOCK");
    const videoPayload = (mediaFile: string): string[] => {
      const value = JSON.parse(execFileSync(input.ffprobe, ["-v", "error", "-select_streams", "v:0", "-show_packets", "-show_data_hash", "sha256", "-show_entries", "packet=data_hash", "-of", "json", mediaFile], { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 })) as { packets?: Array<{ data_hash?: string }> };
      if (!value.packets?.length || value.packets.some((packet) => !/^SHA256:[a-f0-9]{64}$/i.test(packet.data_hash ?? ""))) throw new Error("RHYTHM_SOUND_PICTURE_HASH_UNREADABLE");
      return value.packets.map((packet) => packet.data_hash!);
    };
    const originalVideoPayload = videoPayload(input.file), outputVideoPayload = videoPayload(file);
    if (JSON.stringify(originalVideoPayload) !== JSON.stringify(outputVideoPayload)) throw new Error("RHYTHM_SOUND_PICTURE_PAYLOAD_CHANGED");
    execFileSync(input.ffmpeg, ["-v", "error", "-xerror", "-i", file, "-map", "0:v:0", "-map", "0:a:0", "-f", "null", "-"], { maxBuffer: 8 * 1024 * 1024 });
    if (await rhythmFileSha256(input.file) !== sourceSha256) throw new Error("RHYTHM_SOUND_SOURCE_CHANGED");
    const reportFile = join(attemptDir, "sound-receipt.json");
    writeFileSync(reportFile, `${JSON.stringify({ schemaVersion: "workloom.rhythm-sound/v1", at: new Date().toISOString(),
      planSha256: plan.inputSha256, source: { file: resolve(input.file), sha256: sourceSha256, media: sourceMedia },
      output: { file, sha256: await rhythmFileSha256(file), media: outputMedia }, placements,
      effectFiles: await Promise.all(effects.map(async (effectFile) => ({ file: effectFile, sha256: await rhythmFileSha256(effectFile) }))),
      videoPayloadSha256: createHash("sha256").update(JSON.stringify(originalVideoPayload)).digest("hex"),
      videoPacketsUnchanged: true, programmeSpeed: 1, qualityReviewPerformed: false,
      unverifiedCues: plan.soundCues.filter((cue) => cue.kind !== "impact" && cue.kind !== "whoosh"), artisticQuality: "unverified" }, null, 2)}\n`, "utf8");
    completed = true;
    return { file, reportFile, placements };
  } finally { if (!completed) rmSync(attemptDir, { recursive: true, force: true }); }
}
export interface RhythmMediaFacts { videoSeconds: number; fps: number; videoFrames: number; hasAudio: boolean; width: number; height: number; displayWidth: number; displayHeight: number; codedWidth: number; codedHeight: number; rotationDegrees: number }
export async function rhythmFileSha256(file: string): Promise<string> {
  const digest = createHash("sha256");
  for await (const chunk of createReadStream(file)) digest.update(chunk);
  return digest.digest("hex");
}
export function rhythmMediaFacts(file: string, ffprobe: string): RhythmMediaFacts {
  const raw = execFileSync(ffprobe, ["-v", "error", "-count_frames", "-show_streams", "-show_format", "-of", "json", file], { encoding: "utf8", maxBuffer: 8 * 1024 * 1024 });
  const media = JSON.parse(raw) as { streams?: Array<Record<string, unknown>>; format?: Record<string, unknown> };
  const video = media.streams?.find((stream) => stream.codec_type === "video");
  if (!video) throw new Error("RHYTHM_VIDEO_STREAM_MISSING");
  const [numerator, denominator] = String(video.avg_frame_rate ?? video.r_frame_rate ?? "0/1").split("/").map(Number);
  const fps = numerator! / denominator!, videoFrames = Number(video.nb_read_frames ?? video.nb_frames ?? 0);
  const videoSeconds = videoFrames > 0 && fps > 0 ? videoFrames / fps : Number(video.duration ?? media.format?.duration ?? 0);
  if (!Number.isFinite(videoSeconds) || videoSeconds <= 0 || !Number.isFinite(fps) || fps <= 0) throw new Error("RHYTHM_VIDEO_CLOCK_UNREADABLE");
  const sideData = Array.isArray(video.side_data_list) ? video.side_data_list as Array<Record<string, unknown>> : [];
  const tags = video.tags && typeof video.tags === "object" ? video.tags as Record<string, unknown> : {};
  const rotationDegrees = Number(sideData.find((entry) => entry.rotation !== undefined)?.rotation ?? tags.rotate ?? 0);
  if (!Number.isFinite(rotationDegrees) || Math.abs(rotationDegrees / 90 - Math.round(rotationDegrees / 90)) > 0.00001) throw new Error("RHYTHM_SOURCE_ROTATION_UNSUPPORTED");
  const codedWidth = Number(video.width), codedHeight = Number(video.height);
  if (!Number.isInteger(codedWidth) || codedWidth < 1 || !Number.isInteger(codedHeight) || codedHeight < 1) throw new Error("RHYTHM_NATIVE_CANVAS_UNREADABLE");
  const swap = Math.abs(Math.round(rotationDegrees / 90)) % 2 === 1;
  return { videoSeconds, fps, videoFrames, hasAudio: Boolean(media.streams?.some((stream) => stream.codec_type === "audio")),
    width: swap ? codedHeight : codedWidth, height: swap ? codedWidth : codedHeight, displayWidth: swap ? codedHeight : codedWidth, displayHeight: swap ? codedWidth : codedHeight, codedWidth, codedHeight, rotationDegrees };
}
export async function executeRhythmEdit(input: {
  plan: RhythmPlanInput; sources: RhythmEditSource[]; outputDir: string; ffmpeg: string; ffprobe: string; fps: number;
}): Promise<{ clips: string[]; actualDurationsSeconds: number[]; cutTimesSeconds: number[]; durationSeconds: number; reportFile: string }> {
  if (!Number.isFinite(input.fps) || input.fps < 1 || input.fps > 240) throw new Error("RHYTHM_EXPORT_FPS_INVALID");
  if (!input.sources.length || new Set(input.sources.map((source) => source.sourceId)).size !== input.sources.length) throw new Error("RHYTHM_SOURCE_REGISTRY_INVALID");
  if (input.sources.some((source) => !source.sourceId || !existsSync(source.file))) throw new Error("RHYTHM_SOURCE_FILE_MISSING");
  if (input.plan.segments.length !== input.sources.length || input.plan.segments.some((segment, index) => segment.sourceId !== input.sources[index]!.sourceId)) throw new Error("RHYTHM_SEQUENCE_CONFLICT: use the declared storyboard order; reassembly requires its own source plan");
  const originals = await Promise.all(input.sources.map(async (source) => ({ ...source, file: resolve(source.file), sha256: await rhythmFileSha256(source.file), media: rhythmMediaFacts(source.file, input.ffprobe) })));
  const plan: RhythmPlanInput = { ...input.plan, segments: input.plan.segments.map((segment, index) => ({ ...segment,
    lockTrim: Boolean(segment.lockTrim || originals[index]!.lockTrim),
    protectedRanges: [...(segment.protectedRanges ?? []), ...(originals[index]!.protectedRanges ?? [])],
  })) };
  const sourceDurationsSeconds = Object.fromEntries(originals.map((source) => [source.sourceId, source.media.videoSeconds]));
  const before = auditRhythmPlan(plan, { sourceDurationsSeconds, frameToleranceSeconds: 1 / input.fps + 0.005 });
  if (!before.pass || !before.plan) throw new Error(`RHYTHM_SOURCE_CONTRACT_FAILED: ${before.issues.filter((issue) => issue.severity === "error").map((issue) => `${issue.segmentId ?? "film"}/${issue.code}: ${issue.detail}`).join("; ")}`);
  for (const [index, segment] of plan.segments.entries()) {
    const source = originals[index]!;
    const changedRange = segment.inSeconds > 1 / input.fps || segment.outSeconds < source.media.videoSeconds - 1 / input.fps;
    if (changedRange && source.hasSpeech && !segment.protectedRanges?.some((range) => range.kind === "speech")) throw new Error(`RHYTHM_SPEECH_PROTECTION_REQUIRED: ${segment.id}: declare the complete spoken intervals before trimming`);
  }
  // A failed attempt cannot leave a mix of current and earlier output slices.
  const attemptDir = join(input.outputDir, `attempt-${before.plan.inputSha256.slice(0, 12)}-${randomUUID()}`);
  mkdirSync(attemptDir, { recursive: true });
  const pending: string[] = [];
  const outputs: Array<{ file: string; sha256: string; media: RhythmMediaFacts }> = [];
  let completed = false;
  try {
    for (const [index, segment] of before.plan.segments.entries()) {
      const source = originals[index]!, output = join(attemptDir, `segment-${String(index + 1).padStart(3, "0")}.mp4`);
      if (originals.some((entry) => entry.file === resolve(output))) throw new Error("RHYTHM_OUTPUT_OVERWRITES_SOURCE");
      const temp = output.replace(/\.mp4$/i, `.pending-${randomUUID()}.mp4`); pending.push(temp);
      const filters = rhythmTrimFilters(segment);
      const args = ["-y", "-i", source.file, "-map", "0:v:0", "-vf", filters.video, "-r", String(input.fps), "-c:v", "libx264", "-preset", "fast", "-crf", "18", "-pix_fmt", "yuv420p"];
      if (source.media.hasAudio) args.push("-map", "0:a:0", "-af", filters.audio, "-c:a", "aac", "-b:a", "192k");
      else args.push("-an");
      args.push("-movflags", "+faststart", temp);
      execFileSync(input.ffmpeg, args, { stdio: ["ignore", "pipe", "pipe"], maxBuffer: 8 * 1024 * 1024 });
      const media = rhythmMediaFacts(temp, input.ffprobe);
      if (source.media.hasAudio && !media.hasAudio) throw new Error(`RHYTHM_PROGRAMME_AUDIO_LOST: ${segment.id}`);
      if (Math.abs(media.fps - input.fps) > 0.001 || Math.abs(media.videoSeconds - segment.durationSeconds) > 1 / input.fps + 0.005) throw new Error(`RHYTHM_TRIM_CLOCK_MISMATCH: ${segment.id}`);
      if (media.width !== source.media.width || media.height !== source.media.height) throw new Error(`RHYTHM_NATIVE_CANVAS_CHANGED: ${segment.id}`);
      execFileSync(input.ffmpeg, ["-v", "error", "-xerror", "-i", temp, "-map", "0:v:0", "-map", "0:a?", "-f", "null", "-"], { stdio: ["ignore", "pipe", "pipe"], maxBuffer: 8 * 1024 * 1024 });
      if (await rhythmFileSha256(source.file) !== source.sha256) throw new Error(`RHYTHM_SOURCE_CHANGED_DURING_EDIT: ${segment.id}`);
      const sha256 = await rhythmFileSha256(temp); renameSync(temp, output); outputs.push({ file: output, sha256, media });
    }
    const actualDurationsSeconds = outputs.map((output) => output.media.videoSeconds);
    const audit = auditRhythmPlan(plan, { sourceDurationsSeconds, actualDurationsSeconds, frameToleranceSeconds: 1 / input.fps + 0.005 });
    if (!audit.pass) throw new Error("RHYTHM_OUTPUT_CONTRACT_FAILED");
    const reportFile = join(attemptDir, "rhythm-receipt.json");
    writeFileSync(reportFile, `${JSON.stringify({ schemaVersion: "workloom.rhythm-edit/v1", at: new Date().toISOString(),
      audit, originals, outputs, originalSpeed: 1, pictureAndAudioSameRanges: true, soundCueExecution: "unverified", qualityReviewPerformed: false }, null, 2)}\n`, "utf8");
    completed = true;
    let seconds = 0;
    return { clips: outputs.map((output) => output.file), actualDurationsSeconds,
      cutTimesSeconds: actualDurationsSeconds.slice(0, -1).map((duration) => { seconds += duration; return seconds; }),
      durationSeconds: actualDurationsSeconds.reduce((sum, duration) => sum + duration, 0), reportFile };
  } finally {
    for (const file of pending) if (existsSync(file)) rmSync(file);
    if (!completed) rmSync(attemptDir, { recursive: true, force: true });
  }
}
