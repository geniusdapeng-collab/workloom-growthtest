/**
 * Standard post-production preserves every submitted original shot and its own native
 * audio. This pure contract binds facts supplied by the trusted production adapter;
 * caller labels, hashes and authority descriptions do not certify a provider, identity,
 * speech content or file existence. The adapter must verify its accepted render receipts
 * and current file bytes before building, and again before invoking a media tool.
 */
import { createHash } from "node:crypto";
import { isAbsolute, normalize } from "node:path";
import { productionHash } from "./production-lineage.js";
import { filmCompletionPolicyForDocument, describeFilmCompletion, type FilmCompletionRecord } from "./film-completion.mjs";

export const STANDARD_POST_SCHEMA = "workloom.standard-post/v3" as const;
export interface StandardPostSubmitted { json: string; sha256: string; bytes: number }
export interface StandardPostMedia {
  fps: number; width: number; height: number; videoFrames: number; videoDurationSec: number;
  audioDurationSec: number; audioSampleRate: number; audioChannels: number;
}
export interface StandardOriginalRender {
  shotId: string; role: "original-render"; path: string; sha256: string; bytes: number;
  media: StandardPostMedia; authority: { kind: string; evidenceId: string; evidenceSha256: string };
}
export type StandardPostOriginal = StandardOriginalRender;
export interface StandardPostBuildInput {
  projectId: string; submitted: StandardPostSubmitted; originals: readonly StandardOriginalRender[];
}
export interface StandardPostTimelineSource { path: string; sha256: string; bytes: number; inSec: number }
export interface StandardPostTimelineEntry {
  shotId: string; video: StandardPostTimelineSource; audio: StandardPostTimelineSource; durationSec: number; speed: number;
}
export interface StandardPostNativeAudioProof {
  readonly shotId: string; readonly sourceDurationSec: number; readonly videoDurationSec: number;
  /** Metadata duration difference; neither a decoded sample count nor speech certification. */
  readonly deltaSec: number; readonly maximumBoundarySec: number;
  readonly disposition: "exact" | "preserve-presented-native-clock" | "preserve-available-native-audio" | "normalize-presented-native-clock" | "silent-source";
  readonly certification: "duration-only-no-speech-certification";
}
export interface StandardPostContract {
  readonly schemaVersion: typeof STANDARD_POST_SCHEMA; readonly mode: "standard-native";
  readonly projectId: string; readonly submitted: Readonly<StandardPostSubmitted>;
  readonly originals: readonly StandardOriginalRender[]; readonly timeline: readonly StandardPostTimelineEntry[];
  readonly fps: number; readonly width: number; readonly height: number;
  readonly totalFrames: number; readonly durationSec: number;
  readonly completion: FilmCompletionRecord;
  /** Planned export clock. Actual normalized frame counts must be read from the composition receipt. */
  readonly compositionClock: {
    readonly basis: "complete-source-clock-with-export-frame-rounding";
    readonly sourceDurationSec: number;
    readonly rounding: "ceil-each-complete-source-range";
    readonly entries: readonly {
      shotId: string; sourceFrames: number; sourceFps: number; sourceDurationSec: number;
      plannedOutputFrames: number; plannedOutputDurationSec: number; roundingDeltaSec: number;
    }[];
  };
  readonly nativeAudioProof: readonly StandardPostNativeAudioProof[]; readonly contractSha256: string;
}

const HASH = /^[a-f0-9]{64}$/;
const ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const MAX_SHOTS = 100;
function fail(code: string, detail: string): never { throw new Error(`STANDARD_POST_${code}: ${detail}`); }
const text = (value: unknown): value is string => typeof value === "string" && value.trim().length > 0 && !/[\u0000\r\n]/.test(value);
const positive = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value) && value > 0;
const integer = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value > 0;
const hash = (value: unknown): value is string => typeof value === "string" && HASH.test(value);
const near = (a: number, b: number, tolerance: number): boolean => Math.abs(a - b) <= tolerance;
function record(value: unknown, code: string, name: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)
    || (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)) fail(code, `${name} must be a plain object`);
  return value as Record<string, unknown>;
}
/** Strict schemas prevent an editor passing a second, unexamined override alongside facts. */
function shape(value: unknown, keys: readonly string[], code: string, name: string): Record<string, unknown> {
  const object = record(value, code, name); const actual = Reflect.ownKeys(object);
  if (actual.length !== keys.length || actual.some((key) => typeof key !== "string" || !keys.includes(key))) fail(code, `${name} has missing or unknown fields`);
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(object, key);
    if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) fail(code, `${name}.${key} is not an enumerable data field`);
  }
  return object;
}
function denseArray(value: unknown, code: string, name: string): unknown[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > MAX_SHOTS) fail(code, `${name} must contain 1..${MAX_SHOTS} entries`);
  const keys = Reflect.ownKeys(value);
  if (keys.length !== value.length + 1 || keys.some((key) => key !== "length"
    && (typeof key !== "string" || !/^(?:0|[1-9]\d*)$/.test(key) || Number(key) >= value.length))) fail(code, `${name} is sparse or has unknown fields`);
  for (let index = 0; index < value.length; index++) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) fail(code, `${name}[${index}] is not a data entry`);
  }
  return value;
}
function freeze<T>(value: T): T {
  if (value && typeof value === "object") {
    for (const part of Object.values(value)) freeze(part);
    Object.freeze(value);
  }
  return value;
}

/** Submitted seconds are creative intent, never a permission to trim a successful
 * render. Only its complete measured picture clock defines the original interval.
 * Audio metadata differences are observations, without a quality verdict. */
export function validateStandardNativeClock(media: StandardPostMedia, requestedSec: number): {
  durationSec: number; requestedFrames: number; frameDelta: number; deltaSec: number; maximumBoundarySec: number;
} {
  if (!positive(media.fps) || !integer(media.videoFrames) || !positive(media.videoDurationSec) || !positive(requestedSec))
    fail("MEDIA_INVALID", "invalid original picture clock or submitted duration");
  const durationSec = media.videoFrames / media.fps;
  if (!near(media.videoDurationSec, durationSec, 1e-6)) fail("MEDIA_INVALID", "measured video duration differs from its complete frame clock");
  const silent = media.audioDurationSec === 0 && media.audioSampleRate === 0 && media.audioChannels === 0;
  if (!silent && (!positive(media.audioDurationSec) || !integer(media.audioSampleRate) || media.audioSampleRate > 384000
    || !integer(media.audioChannels) || media.audioChannels > 32)) fail("AUDIO_INVALID", "available audio metadata is invalid");
  const requestedFrames = requestedSec * media.fps;
  const deltaSec = media.audioDurationSec - media.videoDurationSec, maximumBoundarySec = silent ? 0 : 2 * 1024 / media.audioSampleRate;
  return { durationSec, requestedFrames, frameDelta: media.videoFrames - requestedFrames, deltaSec, maximumBoundarySec };
}

/** Rebuild old sealed bodies under their original rules. No historical receipt is
 * rewritten or upgraded merely because the current export schema has changed. */
type ContractVersion = "workloom.standard-post/v1" | "workloom.standard-post/v2" | typeof STANDARD_POST_SCHEMA;
/** Original JSON bytes, not a caller-created shot array, own duration and order. */
export function buildStandardPostContract(input: StandardPostBuildInput): StandardPostContract {
  return buildContract(input, STANDARD_POST_SCHEMA) as StandardPostContract;
}
function buildContract(input: StandardPostBuildInput, version: ContractVersion) {
  const top = shape(input, ["projectId", "submitted", "originals"], "INPUT_INVALID", "input");
  if (!text(top.projectId) || !ID.test(top.projectId) || top.projectId.includes("..")) fail("INPUT_INVALID", "invalid projectId");
  const submitted = shape(top.submitted, ["json", "sha256", "bytes"], "SUBMITTED_INVALID", "submitted");
  if (typeof submitted.json !== "string" || !submitted.json.length || !hash(submitted.sha256) || !integer(submitted.bytes)
    || Buffer.byteLength(submitted.json, "utf8") !== submitted.bytes
    || createHash("sha256").update(submitted.json, "utf8").digest("hex") !== submitted.sha256) fail("SUBMITTED_INVALID", "original JSON bytes, length and sha256 disagree");
  let parsed: unknown;
  try { parsed = JSON.parse(submitted.json); }
  catch (error) { fail("SUBMITTED_INVALID", `invalid original JSON: ${error instanceof Error ? error.message : String(error)}`); }
  const source = record(parsed, "SUBMITTED_INVALID", "original document");
  if (source.projectId !== top.projectId) fail("SUBMITTED_INVALID", "original document projectId differs");
  const submittedShots = denseArray(source.shots, "SUBMITTED_INVALID", "original document shots");
  const shots: Array<{ shotId: string; durationSec: number }> = []; const seenShots = new Set<string>();
  for (const value of submittedShots) {
    const shot = record(value, "SUBMITTED_INVALID", "original shot");
    if (!text(shot.shotId) || !ID.test(shot.shotId) || seenShots.has(shot.shotId) || !positive(shot.duration)) fail("SUBMITTED_INVALID", "original shot ID/duration missing, invalid or duplicate");
    seenShots.add(shot.shotId); shots.push({ shotId: shot.shotId, durationSec: shot.duration });
  }
  const submittedDurationSec = shots.reduce((total, shot) => total + shot.durationSec, 0);
  if (!positive(source.durationSeconds) || !positive(submittedDurationSec)) fail("SUBMITTED_INVALID", "document target and original shot durations must be positive");
  if (version === "workloom.standard-post/v1" && !near(submittedDurationSec, source.durationSeconds, 1e-9))
    fail("SUBMITTED_INVALID", "document durationSeconds differs from original shot durations");
  const completionPolicy = filmCompletionPolicyForDocument(source, submittedDurationSec);
  if (version !== "workloom.standard-post/v1") describeFilmCompletion(completionPolicy, submittedDurationSec);
  const supplied = denseArray(top.originals, "SOURCE_INVALID", "originals");
  if (supplied.length !== shots.length) fail("SOURCE_INVALID", "every submitted shot requires exactly one original");
  const originalsById = new Map<string, StandardPostOriginal>(); const paths = new Set<string>(); const digests = new Set<string>();
  for (const value of supplied) {
    const original = shape(value, ["shotId", "role", "path", "sha256", "bytes", "media", "authority"], "SOURCE_INVALID", "original");
    if (!text(original.shotId) || !seenShots.has(original.shotId) || originalsById.has(original.shotId)
      || original.role !== "original-render" || !text(original.path) || !isAbsolute(original.path) || normalize(original.path) !== original.path
      || !hash(original.sha256) || !integer(original.bytes)
      || version !== STANDARD_POST_SCHEMA && (paths.has(original.path) || digests.has(original.sha256))) fail("SOURCE_INVALID", "unknown/duplicate shot, non-original role or invalid fingerprint");
    const media = shape(original.media, ["fps", "width", "height", "videoFrames", "videoDurationSec", "audioDurationSec", "audioSampleRate", "audioChannels"], "MEDIA_INVALID", "original.media");
    if (!positive(media.fps) || !integer(media.width) || !integer(media.height)
      || !integer(media.videoFrames) || !positive(media.videoDurationSec)) fail("MEDIA_INVALID", "invalid video measurements");
    const silent = media.audioDurationSec === 0 && media.audioSampleRate === 0 && media.audioChannels === 0;
    if ((version !== STANDARD_POST_SCHEMA || !silent) && (!positive(media.audioDurationSec) || !integer(media.audioSampleRate) || media.audioSampleRate > 384000
      || !integer(media.audioChannels) || media.audioChannels > 32)) fail("AUDIO_INVALID", "invalid available audio metadata");
    const authority = shape(original.authority, ["kind", "evidenceId", "evidenceSha256"], "SOURCE_INVALID", "original.authority");
    if (!text(authority.kind) || !text(authority.evidenceId) || !hash(authority.evidenceSha256)) fail("SOURCE_INVALID", "source authority evidence is missing");
    paths.add(original.path); digests.add(original.sha256);
    originalsById.set(original.shotId, structuredClone(original) as unknown as StandardPostOriginal);
  }
  const originals = shots.map((shot) => originalsById.get(shot.shotId)!);
  const first = originals[0]!.media; const timeline: StandardPostTimelineEntry[] = []; const nativeAudioProof: StandardPostNativeAudioProof[] = [];
  // The export canvas and cadence are requested settings; source intervals remain
  // complete, in submitted order at speed 1 even when normalization is necessary.
  const exportFps = positive(source.fps) && source.fps <= 240 ? source.fps : first.fps <= 240 ? first.fps : 24;
  const ratios: Record<string, [number, number]> = { "9:16": [9, 16], "16:9": [16, 9], "1:1": [1, 1], "4:5": [4, 5] };
  const ratio = ratios[String(source.aspect ?? "")];
  const edge = Number(String(source.resolution ?? "").replace(/p$/, ""));
  const even = (value: number): number => Math.max(2, Math.round(value / 2) * 2);
  const exportWidth = even(ratio && [720, 1080, 2160].includes(edge) ? edge * ratio[0] / Math.min(...ratio) : first.width);
  const exportHeight = even(ratio && [720, 1080, 2160].includes(edge) ? edge * ratio[1] / Math.min(...ratio) : first.height);
  const fps = version === STANDARD_POST_SCHEMA ? exportFps : first.fps;
  const width = version === STANDARD_POST_SCHEMA ? exportWidth : first.width, height = version === STANDARD_POST_SCHEMA ? exportHeight : first.height;
  const clockEntries: StandardPostContract["compositionClock"]["entries"][number][] = [];
  let totalFrames = 0, sourceDurationSec = 0;
  for (const [index, shot] of shots.entries()) {
    const original = originals[index]!; const media = original.media;
    const clock = validateStandardNativeClock(media, shot.durationSec);
    if (version !== STANDARD_POST_SCHEMA) {
      if (media.fps !== first.fps || media.width !== first.width || media.height !== first.height || media.fps > 240)
        fail("MEDIA_INVALID", "sealed originals must have the same native clock and geometry");
      if (!Number.isSafeInteger(Math.round(clock.requestedFrames)) || !near(clock.requestedFrames, Math.round(clock.requestedFrames), 1e-8)
        || (version === "workloom.standard-post/v1" ? clock.frameDelta !== 0 : clock.frameDelta !== 0 && clock.frameDelta !== 1))
        fail("FRAME_INVALID", "sealed original frame range differs from its historical schema");
      if (Math.abs(clock.deltaSec) > (version === "workloom.standard-post/v1" ? 1024 : 2048) / media.audioSampleRate + 1e-9)
        fail("AUDIO_INVALID", "sealed native audio differs from its historical metadata boundary");
    }
    const durationSec = version === "workloom.standard-post/v1" ? shot.durationSec : clock.durationSec;
    const exactOutputFrames = durationSec * fps;
    const plannedOutputFrames = version === STANDARD_POST_SCHEMA ? Math.max(1, Math.ceil(exactOutputFrames - 1e-8)) : media.videoFrames;
    totalFrames += plannedOutputFrames; sourceDurationSec += durationSec;
    if (!Number.isSafeInteger(totalFrames)) fail("FRAME_INVALID", "total frame count exceeds the exact integer range");
    const sourceFingerprint = { path: original.path, sha256: original.sha256, bytes: original.bytes, inSec: 0 };
    timeline.push({ shotId: shot.shotId, video: { ...sourceFingerprint }, audio: { ...sourceFingerprint }, durationSec, speed: 1 });
    const maximumBoundarySec = version === "workloom.standard-post/v1" ? 1024 / media.audioSampleRate : clock.maximumBoundarySec;
    nativeAudioProof.push({ shotId: shot.shotId, sourceDurationSec: media.audioDurationSec, videoDurationSec: media.videoDurationSec,
      deltaSec: clock.deltaSec, maximumBoundarySec, disposition: media.audioChannels === 0 ? "silent-source"
        : clock.deltaSec === 0 ? "exact" : Math.abs(clock.deltaSec) <= maximumBoundarySec ? "preserve-presented-native-clock"
          : version === STANDARD_POST_SCHEMA ? "preserve-available-native-audio" : "normalize-presented-native-clock",
      certification: "duration-only-no-speech-certification" });
    clockEntries.push({ shotId: shot.shotId, sourceFrames: media.videoFrames, sourceFps: media.fps,
      sourceDurationSec: durationSec, plannedOutputFrames, plannedOutputDurationSec: plannedOutputFrames / fps,
      roundingDeltaSec: plannedOutputFrames / fps - durationSec });
  }
  const durationSec = version === "workloom.standard-post/v1" ? submittedDurationSec : totalFrames / fps;
  const body = { schemaVersion: version, mode: "standard-native" as const, projectId: top.projectId,
    submitted: structuredClone(submitted) as unknown as StandardPostSubmitted, originals, timeline,
    fps, width, height, totalFrames, durationSec, nativeAudioProof,
    ...(version === "workloom.standard-post/v1" ? {} : { completion: describeFilmCompletion(completionPolicy, durationSec) }),
    ...(version !== STANDARD_POST_SCHEMA ? {} : { compositionClock: { basis: "complete-source-clock-with-export-frame-rounding" as const,
      sourceDurationSec, rounding: "ceil-each-complete-source-range" as const, entries: clockEntries } }) };
  return freeze({ ...body, contractSha256: productionHash(body) });
}

/** Check the exact timeline passed to composition, never merely the plan's provenance label. */
export function assertStandardPostTimeline(contract: unknown, actual: unknown): asserts actual is readonly StandardPostTimelineEntry[] {
  let expected: ReturnType<typeof buildContract>;
  try {
    const declared = record(contract, "CONTRACT_INVALID", "contract").schemaVersion;
    if (![STANDARD_POST_SCHEMA, "workloom.standard-post/v1", "workloom.standard-post/v2"].includes(String(declared))) fail("CONTRACT_INVALID", "unknown sealed contract schema");
    const version = declared as ContractVersion;
    const value = shape(contract, ["schemaVersion", "mode", "projectId", "submitted", "originals", "timeline", "fps", "width", "height", "totalFrames", "durationSec", "nativeAudioProof", "contractSha256",
      ...(version === "workloom.standard-post/v1" ? [] : ["completion"]), ...(version === STANDARD_POST_SCHEMA ? ["compositionClock"] : [])], "CONTRACT_INVALID", "contract");
    expected = buildContract({ projectId: value.projectId as string, submitted: value.submitted as StandardPostSubmitted,
      originals: value.originals as StandardPostOriginal[] }, version);
    if (productionHash(value) !== productionHash(expected)) fail("CONTRACT_INVALID", "contract hash/body differs from its bound original source");
  } catch (error) {
    fail("CONTRACT_INVALID", error instanceof Error ? error.message : String(error));
  }
  const entries = denseArray(actual, "TIMELINE_INVALID", "timeline");
  if (entries.length !== expected.timeline.length) fail("TIMELINE_INVALID", "original shot count changed (drop, add or split)");
  for (const [index, value] of entries.entries()) {
    const entry = shape(value, ["shotId", "video", "audio", "durationSec", "speed"], "TIMELINE_INVALID", `timeline[${index}]`);
    shape(entry.video, ["path", "sha256", "bytes", "inSec"], "TIMELINE_INVALID", `timeline[${index}].video`);
    shape(entry.audio, ["path", "sha256", "bytes", "inSec"], "TIMELINE_INVALID", `timeline[${index}].audio`);
    let same = false;
    try { same = productionHash(entry) === productionHash(expected.timeline[index]); }
    catch (error) { fail("TIMELINE_INVALID", error instanceof Error ? error.message : String(error)); }
    if (!same) fail("TIMELINE_INVALID", `timeline[${index}] differs from the original order, full duration, same-file native audio, fingerprint, zero in-point or speed 1`);
  }
}
