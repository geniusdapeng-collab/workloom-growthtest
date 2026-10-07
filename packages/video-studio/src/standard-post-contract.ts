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

export const STANDARD_POST_SCHEMA = "workloom.standard-post/v1" as const;
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
  readonly disposition: "exact" | "preserve-presented-native-clock" | "normalize-presented-native-clock" | "silent-source";
  readonly certification: "duration-only-no-speech-certification";
}
export interface StandardPostContract {
  readonly schemaVersion: typeof STANDARD_POST_SCHEMA; readonly mode: "standard-native";
  readonly projectId: string; readonly submitted: Readonly<StandardPostSubmitted>;
  readonly originals: readonly StandardOriginalRender[]; readonly timeline: readonly StandardPostTimelineEntry[];
  readonly fps: number; readonly width: number; readonly height: number;
  readonly totalFrames: number; readonly durationSec: number;
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

/** Original JSON bytes, not a caller-created shot array, own duration and order. */
export function buildStandardPostContract(input: StandardPostBuildInput): StandardPostContract {
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
  const durationSec = shots.reduce((total, shot) => total + shot.durationSec, 0);
  if (!positive(source.durationSeconds) || !Number.isFinite(durationSec) || !near(durationSec, source.durationSeconds, 1e-9)) fail("SUBMITTED_INVALID", "document durationSeconds differs from original shot durations");
  const supplied = denseArray(top.originals, "SOURCE_INVALID", "originals");
  if (supplied.length !== shots.length) fail("SOURCE_INVALID", "every submitted shot requires exactly one original");
  const originalsById = new Map<string, StandardPostOriginal>();
  for (const value of supplied) {
    const original = shape(value, ["shotId", "role", "path", "sha256", "bytes", "media", "authority"], "SOURCE_INVALID", "original");
    if (!text(original.shotId) || !seenShots.has(original.shotId) || originalsById.has(original.shotId)
      || original.role !== "original-render" || !text(original.path) || !isAbsolute(original.path) || normalize(original.path) !== original.path
      || !hash(original.sha256) || !integer(original.bytes)) fail("SOURCE_INVALID", "unknown/duplicate shot, non-original role or invalid fingerprint");
    const media = shape(original.media, ["fps", "width", "height", "videoFrames", "videoDurationSec", "audioDurationSec", "audioSampleRate", "audioChannels"], "MEDIA_INVALID", "original.media");
    if (!positive(media.fps) || !integer(media.width) || !integer(media.height)
      || !integer(media.videoFrames) || !positive(media.videoDurationSec)) fail("MEDIA_INVALID", "invalid video measurements");
    const silent = media.audioDurationSec === 0 && media.audioSampleRate === 0 && media.audioChannels === 0;
    if (!silent && (!positive(media.audioDurationSec) || !integer(media.audioSampleRate) || media.audioSampleRate > 384000
      || !integer(media.audioChannels) || media.audioChannels > 32)) fail("AUDIO_INVALID", "invalid available audio metadata");
    const authority = shape(original.authority, ["kind", "evidenceId", "evidenceSha256"], "SOURCE_INVALID", "original.authority");
    if (!text(authority.kind) || !text(authority.evidenceId) || !hash(authority.evidenceSha256)) fail("SOURCE_INVALID", "source authority evidence is missing");
    originalsById.set(original.shotId, structuredClone(original) as unknown as StandardPostOriginal);
  }
  const originals = shots.map((shot) => originalsById.get(shot.shotId)!);
  const first = originals[0]!.media; const timeline: StandardPostTimelineEntry[] = []; const nativeAudioProof: StandardPostNativeAudioProof[] = [];
  // These are the requested export settings. Provider originals keep their actual
  // clock and geometry; postproduction performs the necessary normalization.
  const fps = positive(source.fps) && source.fps <= 240 ? source.fps : 24;
  const ratios: Record<string, [number, number]> = { "9:16": [9, 16], "16:9": [16, 9], "1:1": [1, 1], "4:5": [4, 5] };
  const ratio = ratios[String(source.aspect ?? "")];
  const edge = Number(String(source.resolution ?? "").replace(/p$/, ""));
  const even = (value: number): number => Math.max(2, Math.round(value / 2) * 2);
  const width = even(ratio && [720, 1080, 2160].includes(edge) ? edge * ratio[0] / Math.min(...ratio) : first.width);
  const height = even(ratio && [720, 1080, 2160].includes(edge) ? edge * ratio[1] / Math.min(...ratio) : first.height);
  let totalFrames = 0;
  for (const [index, shot] of shots.entries()) {
    const original = originals[index]!; const media = original.media;
    const expectedFrames = Math.round(shot.durationSec * fps);
    if (!Number.isSafeInteger(expectedFrames) || expectedFrames < 1) fail("FRAME_INVALID", `${shot.shotId} requested export range is invalid`);
    const deltaSec = media.audioDurationSec - media.videoDurationSec; const maximumBoundarySec = media.audioSampleRate > 0 ? 1024 / media.audioSampleRate : 0;
    totalFrames += expectedFrames;
    if (!Number.isSafeInteger(totalFrames)) fail("FRAME_INVALID", "total frame count exceeds the exact integer range");
    const sourceFingerprint = { path: original.path, sha256: original.sha256, bytes: original.bytes, inSec: 0 };
    timeline.push({ shotId: shot.shotId, video: { ...sourceFingerprint }, audio: { ...sourceFingerprint }, durationSec: shot.durationSec, speed: 1 });
    nativeAudioProof.push({ shotId: shot.shotId, sourceDurationSec: media.audioDurationSec, videoDurationSec: media.videoDurationSec,
      deltaSec, maximumBoundarySec, disposition: media.audioChannels === 0 ? "silent-source"
        : deltaSec === 0 ? "exact" : Math.abs(deltaSec) <= maximumBoundarySec ? "preserve-presented-native-clock" : "normalize-presented-native-clock",
      certification: "duration-only-no-speech-certification" });
  }
  const body = { schemaVersion: STANDARD_POST_SCHEMA, mode: "standard-native" as const, projectId: top.projectId,
    submitted: structuredClone(submitted) as unknown as StandardPostSubmitted, originals, timeline,
    fps, width, height, totalFrames, durationSec, nativeAudioProof };
  return freeze({ ...body, contractSha256: productionHash(body) });
}

/** Check the exact timeline passed to composition, never merely the plan's provenance label. */
export function assertStandardPostTimeline(contract: unknown, actual: unknown): asserts actual is readonly StandardPostTimelineEntry[] {
  let expected: StandardPostContract;
  try {
    const value = shape(contract, ["schemaVersion", "mode", "projectId", "submitted", "originals", "timeline", "fps", "width", "height", "totalFrames", "durationSec", "nativeAudioProof", "contractSha256"], "CONTRACT_INVALID", "contract");
    expected = buildStandardPostContract({ projectId: value.projectId as string, submitted: value.submitted as StandardPostSubmitted,
      originals: value.originals as StandardPostOriginal[] });
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
