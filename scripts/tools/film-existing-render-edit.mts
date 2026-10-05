/** Explicit local postproduction over frozen existing files. No provider, model, TTS or ASR calls. */
import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { constants, createReadStream } from "node:fs";
import { access, appendFile, copyFile, lstat, mkdir, open, readFile, readdir, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { embedCoverFirstFrame, type CoverVariantId } from "../../packages/video-studio/src/cover-assembly.js";
import { candidateSyncWindows, crossCorrelationLag } from "../../packages/video-studio/src/av-sync.js";
import { isKnownCoverPlatform } from "../../packages/video-studio/src/cover-platforms.js";
import { COVER_FONTS } from "../../packages/video-studio/src/cover-design.js";

export class ExistingRenderEditError extends Error {
  constructor(readonly code: string, message: string) { super(`${code}: ${message}`); this.name = "ExistingRenderEditError"; }
}
export interface ExistingEditSource {
  id: string; path: string; sha256: string; bytes: number;
  role: "original-render" | "existing-voice" | "existing-music";
  origin: string;
}
export interface ExistingEditSegment {
  id: string; videoSourceId: string; audioSourceId: string;
  videoInSec: number; audioInSec: number; durationSec: number;
  speechMode: "on-camera-native" | "voice-over-existing";
  pictureUse: "person" | "product" | "back-view";
  presentationChange?: string;
}
export interface ExistingEditVersion {
  id: "master" | CoverVariantId;
  profile: "none" | "natural" | "warm-film" | "cool-technical" | "high-contrast-social";
  intensity: number;
  musicSourceId?: string;
  musicLevelDb?: number;
  duckingDb?: number;
  musicBpm?: number;
}
export interface ExistingRenderEditPlan {
  schemaVersion: "workloom.existing-render-edit/v1";
  projectId: string; allowedRoots: string[]; outputDir: string;
  width: number; height: number; fps: number; durationSec: number;
  sources: ExistingEditSource[]; forbiddenVideoSourceIds: string[];
  segments: ExistingEditSegment[];
  subtitles: Array<{ startSec: number; endSec: number; text: string }>;
  subtitleFontsRoot: string;
  cover: { sourceId: string; atSec: number; title: string; subtitle?: string; platform: string;
    fontFile: string; fontSha256: string; fontId?: string };
  versions: ExistingEditVersion[];
}
interface Stream { codec_type?: string; codec_name?: string; width?: number; height?: number;
  avg_frame_rate?: string; nb_read_frames?: string; duration?: string; sample_rate?: string; channels?: number;
  side_data_list?: Array<{ rotation?: number }> }
interface Media { streams: Stream[]; format: { duration?: string } }
interface PreparedSegment { segment: ExistingEditSegment; path: string; timelineStartSec: number;
  sourceAudio: { sha256: string; bytes: number; sampleRate: 48000; channels: 2 }; sha256: string }
export interface ExistingEditOptions { repoRoot?: string; ffmpeg?: string; ffprobe?: string; timeoutMs?: number }

const fail = (code: string, message: string): never => { throw new ExistingRenderEditError(code, message); };
function ensure(value: unknown, message: string): asserts value {
  if (!value) fail("EXISTING_EDIT_PLAN_INVALID", message);
}
function object(value: unknown, label: string): Record<string, unknown> {
  ensure(value && typeof value === "object" && !Array.isArray(value), `${label} must be an object`);
  return value as Record<string, unknown>;
}
function keys(value: Record<string, unknown>, allowed: string[], label: string) {
  ensure(Object.keys(value).every((key) => allowed.includes(key)), `${label} contains unsupported fields`);
}
const finite = (n: unknown, min: number, max: number): n is number => typeof n === "number" && Number.isFinite(n) && n >= min && n <= max;
const id = (s: unknown): s is string => typeof s === "string" && /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(s) && !s.includes("..");
const hash = (s: unknown): s is string => typeof s === "string" && /^[a-f0-9]{64}$/.test(s);
const localPath = (p: unknown): p is string => typeof p === "string" && isAbsolute(p) && !/[\0\r\n]/.test(p);
const text = (t: unknown, max: number): t is string => typeof t === "string" && Boolean(t.trim()) && t.length <= max && !/[\0\r]/.test(t);
const aligned = (seconds: number, fps: number) => Math.abs(seconds * fps - Math.round(seconds * fps)) < 0.000001;
const within = (file: string, root: string): boolean => { const r = relative(root, file); return r === "" || (!isAbsolute(r) && r !== ".." && !r.startsWith(`..${sep}`)); };
const missing = (e: unknown) => (e as NodeJS.ErrnoException).code === "ENOENT";
// A frozen local playlist is not a frozen media source: its nested files can drift or escape roots.
const directMediaInput = (): string[] => ["-protocol_whitelist", "file,pipe", "-format_whitelist", "mov,matroska,avi,mpegts,wav,mp3,aac,flac,ogg,aiff"];

/** Strict schema validation happens before mkdir, locks, decoding or any external process. */
export function validateExistingRenderEditPlan(input: unknown): ExistingRenderEditPlan {
  const p = object(input, "plan");
  keys(p, ["schemaVersion", "projectId", "allowedRoots", "outputDir", "width", "height", "fps", "durationSec", "sources",
    "forbiddenVideoSourceIds", "segments", "subtitles", "subtitleFontsRoot", "cover", "versions"], "plan");
  ensure(p.schemaVersion === "workloom.existing-render-edit/v1", "unsupported schemaVersion");
  ensure(id(p.projectId), "invalid projectId");
  ensure(Array.isArray(p.allowedRoots) && p.allowedRoots.length > 0 && p.allowedRoots.length <= 16 && p.allowedRoots.every(localPath), "allowedRoots must be local absolute directories");
  ensure(localPath(p.outputDir) && !p.outputDir.includes(","), "outputDir must be an absolute path without commas");
  ensure(localPath(p.subtitleFontsRoot), "subtitleFontsRoot must be local");
  ensure([p.width, p.height].every((n) => Number.isSafeInteger(n) && finite(n, 160, 4096) && n % 2 === 0), "dimensions must be even integers from 160 to 4096");
  ensure(Number.isSafeInteger(p.fps) && finite(p.fps, 1, 60), "fps must be an integer from 1 to 60");
  ensure(finite(p.durationSec, 0.25, 600) && aligned(p.durationSec, p.fps), "durationSec must be a frame-aligned duration");
  ensure(Array.isArray(p.sources) && p.sources.length > 0 && p.sources.length <= 100, "sources must contain 1 to 100 files");
  const sourceIds = new Set<string>();
  for (const value of p.sources) {
    const s = object(value, "source");
    keys(s, ["id", "path", "sha256", "bytes", "role", "origin"], "source");
    ensure(id(s.id) && !sourceIds.has(s.id), "source ids must be unique"); sourceIds.add(s.id);
    ensure(localPath(s.path) && hash(s.sha256) && Number.isSafeInteger(s.bytes) && finite(s.bytes, 1, 100_000_000_000), "source needs local path, complete SHA256 and positive bytes");
    ensure(["original-render", "existing-voice", "existing-music"].includes(String(s.role)) && text(s.origin, 2000), "source role and existing-file origin are required");
  }
  const sources = new Map((p.sources as ExistingEditSource[]).map((s) => [s.id, s]));
  ensure(Array.isArray(p.forbiddenVideoSourceIds) && p.forbiddenVideoSourceIds.every((s) => typeof s === "string" && sources.has(s))
    && new Set(p.forbiddenVideoSourceIds).size === p.forbiddenVideoSourceIds.length, "forbiddenVideoSourceIds must name unique frozen sources");
  const forbiddenHashes = new Set((p.forbiddenVideoSourceIds as string[]).map((s) => sources.get(s)!.sha256));
  ensure(Array.isArray(p.segments) && p.segments.length > 0 && p.segments.length <= 100, "segments must contain 1 to 100 entries");
  let total = 0; const segmentIds = new Set<string>();
  for (const value of p.segments) {
    const s = object(value, "segment");
    keys(s, ["id", "videoSourceId", "audioSourceId", "videoInSec", "audioInSec", "durationSec", "speechMode", "pictureUse", "presentationChange"], "segment");
    ensure(id(s.id) && !segmentIds.has(s.id), "segment ids must be unique"); segmentIds.add(s.id);
    const v = sources.get(String(s.videoSourceId)), a = sources.get(String(s.audioSourceId));
    ensure(v?.role === "original-render" && a && a.role !== "existing-music", "picture requires an original render; speech cannot use music");
    ensure(!forbiddenHashes.has(v.sha256), "excluded source picture is forbidden, including aliases");
    ensure(finite(s.videoInSec, 0, 3600) && aligned(s.videoInSec, p.fps) && finite(s.audioInSec, 0, 3600)
      && Math.abs(s.audioInSec * 48000 - Math.round(s.audioInSec * 48000)) < 0.000001
      && finite(s.durationSec, 1 / p.fps, 600) && aligned(s.durationSec, p.fps), "segment ranges must be positive and frame/sample aligned");
    ensure(["on-camera-native", "voice-over-existing"].includes(String(s.speechMode)) && ["person", "product", "back-view"].includes(String(s.pictureUse)), "unsupported speechMode or pictureUse");
    if (s.speechMode === "on-camera-native") {
      ensure(v.sha256 === a.sha256 && v.path === a.path && s.videoInSec === s.audioInSec && s.pictureUse === "person", "on-camera-native must bind the same original picture, audio and in-point");
    }
    if (s.presentationChange !== undefined) ensure(text(s.presentationChange, 2000), "presentationChange must be explicit text");
    if (a.role === "original-render" && v.sha256 !== a.sha256) ensure(text(s.presentationChange, 2000), "native speech moved to different picture requires a presentationChange receipt");
    total += s.durationSec;
  }
  ensure(Math.abs(total - p.durationSec) < 0.000001, "segment durations do not match declared durationSec");
  ensure(Array.isArray(p.subtitles) && p.subtitles.length > 0 && p.subtitles.length <= 1000, "subtitles must contain 1 to 1000 cues");
  let previousEnd = 0;
  for (const value of p.subtitles) {
    const c = object(value, "subtitle"); keys(c, ["startSec", "endSec", "text"], "subtitle");
    ensure(finite(c.startSec, previousEnd, p.durationSec) && finite(c.endSec, 0, p.durationSec) && c.endSec > c.startSec && text(c.text, 200), "subtitle timeline must be ordered, nonoverlapping, bounded and nonempty");
    ensure([c.startSec, c.endSec].every((s) => Math.abs(s * 100 - Math.round(s * 100)) < 0.000001), "subtitle times must be exactly representable at ASS 10ms precision");
    ensure(!/[{}\\]/.test(c.text), "subtitle ASS control sequences are forbidden"); previousEnd = c.endSec;
  }
  const c = object(p.cover, "cover");
  keys(c, ["sourceId", "atSec", "title", "subtitle", "platform", "fontFile", "fontSha256", "fontId"], "cover");
  const coverSource = sources.get(String(c.sourceId));
  ensure(coverSource?.role === "original-render" && !forbiddenHashes.has(coverSource.sha256), "cover must use a permitted original picture source");
  ensure(finite(c.atSec, 0, 3600) && text(c.title, 80) && (c.subtitle === undefined || text(c.subtitle, 100))
    && typeof c.platform === "string" && isKnownCoverPlatform(c.platform) && localPath(c.fontFile) && hash(c.fontSha256)
    && (c.fontId === undefined || typeof c.fontId === "string" && Object.prototype.hasOwnProperty.call(COVER_FONTS, c.fontId)), "cover needs visible copy, known platform and font, local pinned font and a valid source time");
  ensure(Array.isArray(p.versions) && p.versions.length > 0 && p.versions.length <= 4, "versions must contain master and at most three variants");
  const versionIds = new Set<string>();
  for (const value of p.versions) {
    const v = object(value, "version"); keys(v, ["id", "profile", "intensity", "musicSourceId", "musicLevelDb", "duckingDb", "musicBpm"], "version");
    ensure(["master", "warm-film", "cool-tech", "punchy-social"].includes(String(v.id)) && !versionIds.has(String(v.id)), "unknown or duplicate version"); versionIds.add(String(v.id));
    ensure(["none", "natural", "warm-film", "cool-technical", "high-contrast-social"].includes(String(v.profile))
      && (v.profile === "none" ? v.id === "master" && v.intensity === 0 : finite(v.intensity, 0.1, 1)), "unknown or invalid color recipe");
    if (v.musicSourceId !== undefined) {
      ensure(sources.get(String(v.musicSourceId))?.role === "existing-music", "BGM must name a frozen existing music file");
      ensure(finite(v.musicLevelDb, -40, -12) && finite(v.duckingDb, 4, 40) && finite(v.musicBpm, 20, 300), "BGM needs bounded level, ducking and BPM");
    } else ensure(v.musicLevelDb === undefined && v.duckingDb === undefined && v.musicBpm === undefined, "BGM settings require an existing music source");
  }
  ensure(versionIds.has("master"), "master version is required");
  return structuredClone(p) as unknown as ExistingRenderEditPlan;
}

export async function existingEditFileHash(path: string): Promise<string> {
  const sha = createHash("sha256"); for await (const chunk of createReadStream(path)) sha.update(chunk); return sha.digest("hex");
}
export async function resolveExistingEditBinary(value: string): Promise<string> {
  if (typeof value !== "string" || !value.trim() || /[\0\r\n]/.test(value) || value.includes("://")) fail("EXISTING_EDIT_BINARY_INVALID", "expected a local executable");
  const names = process.platform === "win32" && !extname(value) ? [value + ".exe", value] : [value];
  const candidates = isAbsolute(value) ? [value] : value.includes(sep) ? []
    : (process.env.PATH ?? "").split(process.platform === "win32" ? ";" : ":").filter(isAbsolute).flatMap((p) => names.map((n) => join(p, n)));
  for (const candidate of candidates) {
    try { const path = await realpath(candidate); if (!(await stat(path)).isFile()) continue; await access(path, constants.X_OK); return path; }
    catch (e) { if (!missing(e) && (e as NodeJS.ErrnoException).code !== "EACCES") throw e; }
  }
  return fail("EXISTING_EDIT_BINARY_INVALID", `local executable unavailable: ${value}`);
}
async function run(binary: string, args: string[], timeout: number, env = process.env): Promise<{ stdout: Buffer; stderr: string }> {
  return new Promise((accept, reject) => execFile(binary, args, { encoding: "buffer", timeout, maxBuffer: 256 * 1024 * 1024, env }, (error, stdout, stderr) => {
    if (error) reject(new ExistingRenderEditError("EXISTING_EDIT_PROCESS_FAILED", `${basename(binary)}: ${String(stderr).slice(-2400) || error.message}`));
    else accept({ stdout, stderr: String(stderr) });
  }));
}
async function probe(path: string, bins: { ffprobe: string }, timeout: number): Promise<Media> {
  let stdout: Buffer;
  try { ({ stdout } = await run(bins.ffprobe, ["-v", "error", ...directMediaInput(), "-count_frames", "-show_streams", "-show_format", "-of", "json", path], timeout)); }
  catch (error) { return fail("EXISTING_EDIT_MEDIA_INVALID", `direct media probe failed: ${(error as Error).message}`); }
  let doc: Media; try { doc = JSON.parse(stdout.toString()) as Media; } catch { return fail("EXISTING_EDIT_MEDIA_INVALID", "malformed media probe"); }
  if (!Array.isArray(doc.streams) || !doc.format || !finite(Number(doc.format.duration), 0.001, 7200)) fail("EXISTING_EDIT_MEDIA_INVALID", `incomplete media probe: ${path}`);
  return doc;
}
function rate(s: Stream): number { const [a, b] = String(s.avg_frame_rate).split("/").map(Number); return Number(a) / Number(b); }
export async function verifyExistingEditSources(plan: ExistingRenderEditPlan, options: ExistingEditOptions = {}) {
  const timeout = options.timeoutMs ?? 600_000;
  const roots = await Promise.all(plan.allowedRoots.map(async (r) => { const path = await realpath(r); if (!(await stat(path)).isDirectory()) fail("EXISTING_EDIT_ROOT_INVALID", r); return path; }));
  const result = new Map<string, { source: ExistingEditSource; path: string; media: Media }>();
  for (const s of plan.sources) {
    const path = await realpath(s.path);
    if (!roots.some((r) => within(path, r))) fail("EXISTING_EDIT_SOURCE_OUTSIDE_ROOTS", s.id);
    const meta = await stat(path);
    if (!meta.isFile() || meta.size !== s.bytes || await existingEditFileHash(path) !== s.sha256) fail("EXISTING_EDIT_SOURCE_CHANGED", s.id);
    const media = await probe(path, { ffprobe: options.ffprobe ?? "ffprobe" }, timeout);
    result.set(s.id, { source: s, path, media });
  }
  for (const s of plan.segments) {
    const v = result.get(s.videoSourceId)!, a = result.get(s.audioSourceId)!;
    const videos = v.media.streams.filter((x) => x.codec_type === "video"), video = videos[0];
    const audio = a.media.streams.find((x) => x.codec_type === "audio");
    if (videos.length !== 1 || !video || rate(video) !== plan.fps || video.side_data_list?.some((x) => x.rotation)
      || !Number.isInteger(Number(video.nb_read_frames)) || Number(video.nb_read_frames) < Math.round((s.videoInSec + s.durationSec) * plan.fps)) {
      fail("EXISTING_EDIT_VIDEO_RANGE_INVALID", s.id);
    }
    if (!audio || !(Number(audio.channels) > 0) || !(Number(audio.sample_rate) > 0)
      || Number(audio.duration ?? a.media.format.duration) + 0.000001 < s.audioInSec + s.durationSec) fail("EXISTING_EDIT_AUDIO_RANGE_INVALID", s.id);
  }
  const cover = result.get(plan.cover.sourceId)!;
  if (plan.cover.atSec >= Number(cover.media.format.duration)) fail("EXISTING_EDIT_COVER_RANGE_INVALID", plan.cover.sourceId);
  for (const v of plan.versions) if (v.musicSourceId && !result.get(v.musicSourceId)!.media.streams.some((s) => s.codec_type === "audio")) fail("EXISTING_EDIT_MUSIC_INVALID", v.id);
  return result;
}

/** Clip picture and speech are trimmed independently at 1x; PCM equality is checked before compose. */
export async function prepareExistingEditSegment(input: {
  segment: ExistingEditSegment; video: string; audio: string; output: string; width: number; height: number; fps: number;
}, options: ExistingEditOptions = {}) {
  const ffmpeg = options.ffmpeg ?? "ffmpeg", ffprobe = options.ffprobe ?? "ffprobe", timeout = options.timeoutMs ?? 600_000;
  const { segment: s } = input;
  if ([resolve(input.video), resolve(input.audio)].includes(resolve(input.output))) fail("EXISTING_EDIT_OVERWRITE_FORBIDDEN", "segment output aliases a source");
  try { await lstat(input.output); fail("EXISTING_EDIT_OUTPUT_EXISTS", input.output); } catch (error) { if (!missing(error)) throw error; }
  await mkdir(dirname(input.output), { recursive: true });
  const start = Math.round(s.videoInSec * input.fps), count = Math.round(s.durationSec * input.fps);
  const audioFilter = `aresample=48000,atrim=start_sample=${Math.round(s.audioInSec * 48000)}:end_sample=${Math.round((s.audioInSec + s.durationSec) * 48000)},asetpts=N/SR/TB`;
  const expected = (await run(ffmpeg, ["-v", "error", "-nostdin", ...directMediaInput(), "-i", input.audio, "-map", "0:a:0", "-af", audioFilter,
    "-ar", "48000", "-ac", "2", "-c:a", "pcm_s16le", "-f", "s16le", "-"], timeout)).stdout;
  if (expected.length !== Math.round(s.durationSec * 48000) * 4) fail("EXISTING_EDIT_AUDIO_RANGE_INVALID", `${s.id} has incomplete speech samples`);
  await run(ffmpeg, ["-v", "error", "-nostdin", "-n", ...directMediaInput(), "-i", input.video, ...directMediaInput(), "-i", input.audio,
    "-filter_complex", `[0:v:0]trim=start_frame=${start}:end_frame=${start + count},setpts=PTS-STARTPTS,scale=${input.width}:${input.height}:force_original_aspect_ratio=decrease,pad=${input.width}:${input.height}:(ow-iw)/2:(oh-ih)/2:color=black,setsar=1[v];[1:a:0]${audioFilter}[a]`,
    "-map", "[v]", "-map", "[a]", "-c:v", "libx264", "-preset", "medium", "-crf", "17", "-pix_fmt", "yuv420p",
    "-fps_mode:v", "passthrough", "-c:a", "pcm_s16le", "-ar", "48000", "-ac", "2", input.output], timeout);
  const actual = (await run(ffmpeg, ["-v", "error", ...directMediaInput(), "-i", input.output, "-map", "0:a:0", "-c:a", "pcm_s16le", "-f", "s16le", "-"], timeout)).stdout;
  if (!actual.equals(expected)) fail("EXISTING_EDIT_NATIVE_AUDIO_CHANGED", `${s.id} trimmed speech differs from frozen source PCM`);
  const media = await probe(input.output, { ffprobe }, timeout), v = media.streams.find((x) => x.codec_type === "video");
  if (Number(v?.nb_read_frames) !== count || Math.abs(Number(v?.duration) - s.durationSec) > 0.000001) fail("EXISTING_EDIT_TIMELINE_CHANGED", s.id);
  return { sha256: await existingEditFileHash(input.output), sourceAudio: { sha256: createHash("sha256").update(expected).digest("hex"), bytes: expected.length, sampleRate: 48000 as const, channels: 2 as const } };
}

async function pcm(path: string, ffmpeg: string, timeout: number): Promise<Float32Array> {
  const b = (await run(ffmpeg, ["-v", "error", ...directMediaInput(), "-i", path, "-map", "0:a:0", "-ar", "16000", "-ac", "1", "-f", "f32le", "-"], timeout)).stdout;
  return new Float32Array(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength));
}
async function verifyComposedSourceSpeech(segments: PreparedSegment[], master: string, ffmpeg: string, timeout: number) {
  const audio = await pcm(master, ffmpeg, timeout); const observations = [];
  for (const s of segments) {
    const reference = await pcm(s.path, ffmpeg, timeout); let best: { lagMs: number; correlation: number } | undefined;
    for (const w of candidateSyncWindows({ durationSec: s.segment.durationSec })) {
      const length = Math.round(w.lengthSec * 16000), from = Math.round(w.startSec * 16000), expected = Math.round((s.timelineStartSec + w.startSec) * 16000);
      const search = 1600, begin = Math.max(0, expected - search), end = Math.min(audio.length, expected + length + search);
      if (from + length > reference.length || end - begin < length + 32) continue;
      const m = crossCorrelationLag(reference.subarray(from, from + length), audio.subarray(begin, end), { sampleRate: 16000, maxLagMs: 100 });
      const measured = { lagMs: m.lagMs - (expected - begin) / 16, correlation: m.correlation };
      if (!best || measured.correlation > best.correlation) best = measured;
    }
    if (!best || best.correlation < 0.98 || Math.abs(best.lagMs) > 10) fail("EXISTING_EDIT_SOURCE_SPEECH_UNVERIFIED", `${s.segment.id}: ${JSON.stringify(best ?? null)}`);
    observations.push({ segmentId: s.segment.id, ...best });
  }
  return { basis: "actual frozen-source PCM to prepared segment equality, then composed speech correlation", sampleRate: 16000, maxLagMs: 10, minimumCorrelation: 0.98, observations,
    limit: "Verifies speech source and timing before BGM mastering; does not certify face identity, words or phonetic lipsync." };
}

interface LocalCore { [name: string]: (...args: unknown[]) => unknown }
async function loadCore(repo: string, connector: string): Promise<LocalCore> {
  return await import(pathToFileURL(join(repo, "bundles/ai-video/connectors", connector, "core.mjs")).href) as LocalCore;
}
function relocate(value: unknown, staging: string, output: string): unknown {
  if (typeof value === "string") return value.startsWith(staging + sep) || value === staging ? output + value.slice(staging.length) : value;
  if (Array.isArray(value)) return value.map((v) => relocate(v, staging, output));
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, relocate(v, staging, output)]));
  return value;
}
async function codeBinding(repo: string, timeout: number) {
  const paths = ["scripts/tools/full-chain-film.mts", "scripts/tools/film-existing-render-edit.mts", "scripts/tools/compose-film.mts",
    "packages/video-studio/src/local-cover-render.ts", "packages/video-studio/src/cover-design.ts", "packages/video-studio/src/cover-platforms.ts",
    "packages/video-studio/src/cover-assembly.ts", "packages/video-studio/src/av-sync.ts", "bundles/ai-video/library/root-list.mjs",
    "bundles/ai-video/library/font-catalog/font_db.json", "bundles/ai-video/library/typography-recipes/recipes.json", "bundles/ai-video/library/bgm-recipes/recipes.json",
    ...["color-bridge", "subtitle-bridge", "bgm-bridge"].map((x) => `bundles/ai-video/connectors/${x}/core.mjs`),
    ...["subtitle-bridge", "bgm-bridge"].map((x) => `bundles/ai-video/connectors/${x}/measure.mjs`),
    "bundles/ai-video/connectors/bgm-bridge/audio-stems.mjs", "bundles/ai-video/connectors/bgm-bridge/audio-stems-trust.mjs"];
  const files = await Promise.all(paths.map(async (path) => ({ path, sha256: await existingEditFileHash(join(repo, path)) })));
  try {
    const commit = (await run("git", ["-C", repo, "rev-parse", "HEAD"], timeout)).stdout.toString().trim();
    const dirty = (await run("git", ["-C", repo, "status", "--porcelain"], timeout)).stdout.length > 0;
    return { commit, workingTreeDirty: dirty, files, gitObserved: true };
  } catch (e) { return { commit: null, workingTreeDirty: null, files, gitObserved: false, reason: (e as Error).message }; }
}
async function relocateGeneratedReceipts(directory: string, staging: string, output: string) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) await relocateGeneratedReceipts(path, staging, output);
    else if (entry.isFile() && entry.name !== "edit-plan.json" && /\.json$/.test(entry.name)) {
      const value = JSON.parse(await readFile(path, "utf8"));
      await writeFile(path, `${JSON.stringify(relocate(value, staging, output), null, 2)}\n`);
    }
  }
}

/** Fresh output directory is published only after all actual local work and source rechecks pass. */
export async function runExistingRenderEditPlan(planFile: string, options: ExistingEditOptions = {}) {
  const repo = resolve(options.repoRoot ?? join(import.meta.dirname, "../.."));
  const timeout = options.timeoutMs ?? 600_000;
  if (!Number.isSafeInteger(timeout) || timeout < 1 || timeout > 900_000) fail("EXISTING_EDIT_OPTIONS_INVALID", "timeoutMs must be 1 to 900000");
  const bytes = await readFile(planFile);
  if (bytes.length > 2 * 1024 * 1024) fail("EXISTING_EDIT_PLAN_INVALID", "plan exceeds 2 MiB");
  let parsed: unknown; try { parsed = JSON.parse(bytes.toString("utf8")); } catch { return fail("EXISTING_EDIT_PLAN_INVALID", "plan is not JSON"); }
  const plan = validateExistingRenderEditPlan(parsed), planHash = createHash("sha256").update(bytes).digest("hex");
  const bins = { ffmpeg: await resolveExistingEditBinary(options.ffmpeg ?? process.env.WL_FFMPEG ?? "ffmpeg"),
    ffprobe: await resolveExistingEditBinary(options.ffprobe ?? process.env.WL_FFPROBE ?? "ffprobe") };
  const binaries = await Promise.all(Object.entries(bins).map(async ([name, path]) => ({ name, path, sha256: await existingEditFileHash(path) })));
  const frozen = await verifyExistingEditSources(plan, { ...options, ...bins });
  const font = await realpath(plan.cover.fontFile);
  if (await existingEditFileHash(font) !== plan.cover.fontSha256) fail("EXISTING_EDIT_FONT_CHANGED", "cover font SHA mismatch");
  await mkdir(dirname(plan.outputDir), { recursive: true });
  const parent = await realpath(dirname(plan.outputDir)), output = join(parent, basename(plan.outputDir));
  if (frozen.size && [...frozen.values()].some((s) => within(s.path, output)) || within(font, output)) fail("EXISTING_EDIT_OVERWRITE_FORBIDDEN", "output contains source files");
  try { await lstat(output); fail("EXISTING_EDIT_OUTPUT_EXISTS", output); } catch (error) { if (!missing(error)) throw error; }
  const lockPath = `${output}.existing-edit.lock`;
  let lock; try { lock = await open(lockPath, "wx", 0o600); } catch (e) { return fail("EXISTING_EDIT_BUSY", (e as Error).message); }
  const staging = `${output}.staging-${randomUUID()}`;
  try { await mkdir(staging, { recursive: false }); }
  catch (e) { await lock.close(); await rm(lockPath, { force: true }); throw e; }
  const evidenceDir = join(staging, "evidence"), post = join(staging, "post"), inputDir = join(staging, "inputs");
  const records: unknown[] = [];
  const evidence = async (name: string, value: unknown) => { const relocated = relocate(value, staging, output); await writeFile(join(evidenceDir, `${name}.json`), `${JSON.stringify(relocated, null, 2)}\n`, { flag: "wx" }); return relocated; };
  const stage = async (name: string, action: () => Promise<unknown>) => {
    const start = Date.now(); try {
      const value = await action(), record = { stage: name, invoked: true, ok: true, elapsedMs: Date.now() - start, evidence: `${name}.json` };
      await evidence(name, value); records.push(record); await appendFile(join(evidenceDir, "stages.jsonl"), JSON.stringify(record) + "\n"); return value;
    } catch (e) {
      const record = { stage: name, invoked: true, ok: false, elapsedMs: Date.now() - start, code: (e as { code?: string }).code ?? "local_stage_failed", error: (e as Error).message };
      records.push(record); await appendFile(join(evidenceDir, "stages.jsonl"), JSON.stringify(record) + "\n"); throw e;
    }
  };
  try {
    await Promise.all([mkdir(evidenceDir), mkdir(post), mkdir(inputDir)]);
    await writeFile(join(staging, "edit-plan.json"), bytes, { flag: "wx" });
    const code = await codeBinding(repo, timeout);
    const sources = new Map<string, string>();
    await stage("source-snapshot", async () => {
      const rows = [];
      for (const [sid, s] of frozen) {
        const snapshot = join(inputDir, sid + extname(s.path)); await copyFile(s.path, snapshot);
        if (await existingEditFileHash(snapshot) !== s.source.sha256) fail("EXISTING_EDIT_SOURCE_CHANGED", sid);
        sources.set(sid, snapshot); rows.push({ ...s.source, resolvedSource: s.path, snapshot, media: s.media });
      }
      return { planSha256: planHash, sources: rows, forbiddenPictureHashes: plan.forbiddenVideoSourceIds.map((s) => frozen.get(s)!.source.sha256), declaration: "Existing file provenance is recorded as supplied; no legacy provider/identity approval is manufactured." };
    });
    const subtitle = await loadCore(repo, "subtitle-bridge");
    const catalog = subtitle.loadFontCatalog!();
    const fonts = subtitle.scanFonts!({ catalog, root: plan.subtitleFontsRoot, verifySha: true }) as { total: number; verified: number; missing: string[]; entries: Array<{ absolutePath: string; sha256: string; sha256Matches: boolean }> };
    if (fonts.verified !== fonts.total || fonts.missing.length) fail("EXISTING_EDIT_FONT_CHANGED", "subtitle font bundle is incomplete or changed");
    await evidence("fonts", { ...fonts, coverFont: { path: font, sha256: plan.cover.fontSha256 } });
    const prepared: PreparedSegment[] = []; let cursor = 0;
    await stage("prepare-segments", async () => {
      for (const segment of plan.segments) {
        const path = join(post, `${String(prepared.length).padStart(3, "0")}-${segment.id}.mov`);
        const receipt = await prepareExistingEditSegment({ segment, video: sources.get(segment.videoSourceId)!, audio: sources.get(segment.audioSourceId)!, output: path,
          width: plan.width, height: plan.height, fps: plan.fps }, { ...bins, timeoutMs: timeout });
        prepared.push({ segment, path, timelineStartSec: cursor, ...receipt }); cursor += segment.durationSec;
      }
      return { speed: 1, frameSynthesis: false, segments: prepared };
    });
    const composed = join(post, "composed.mp4");
    await stage("compose", async () => {
      const argv = ["--import", "tsx", join(repo, "scripts/tools/compose-film.mts"), "--clips", prepared.map((s) => s.path).join(","), "--out", composed,
        "--width", String(plan.width), "--height", String(plan.height), "--fps", String(plan.fps), "--fade", "0", "--color", "none", "--json"];
      const result = await run(process.execPath, argv, timeout, { ...process.env, WL_FFMPEG: bins.ffmpeg, WL_FFPROBE: bins.ffprobe });
      const avSync = JSON.parse(await readFile(composed.replace(/\.mp4$/, ".av-sync.json"), "utf8")) as { ok?: boolean };
      if (avSync.ok !== true) fail("EXISTING_EDIT_SOURCE_SPEECH_UNVERIFIED", "official compose AV sync did not pass");
      return { tool: "scripts/tools/compose-film.mts", argv, stdout: result.stdout.toString().slice(-8000), avSync, sourceSpeech: await verifyComposedSourceSpeech(prepared, composed, bins.ffmpeg, timeout), sha256: await existingEditFileHash(composed) };
    });
    const cues = plan.subtitles.map((c) => ({ start: subtitle.srtSecondsToAss!(c.startSec), end: subtitle.srtSecondsToAss!(c.endSec), text: subtitle.stripSubtitlePunctuation!(c.text) }));
    if (cues.some((c) => !String(c.text).trim())) fail("EXISTING_EDIT_PLAN_INVALID", "punctuation removal leaves an empty subtitle");
    const platform = plan.cover.platform === "wechat-channels" ? "视频号" : plan.cover.platform;
    const brief = { 平台: platform, 题材: "酒店自助设备", 调性: "清晰可信", 分辨率: [plan.width, plan.height] };
    const sidecars = await stage("subtitle-sidecars", () => Promise.resolve(subtitle.exportSidecars!({ input: composed, outputDir: join(staging, "subtitles"), name: plan.projectId,
      cues, platform, brief, bins, fontsDir: plan.subtitleFontsRoot, catalog, titleText: "", evidenceDir: join(evidenceDir, "subtitle-sidecars") }))) as { passed?: boolean; files: Array<{ path: string; format: string }> };
    if (sidecars.passed !== true) fail("EXISTING_EDIT_SUBTITLE_UNVERIFIED", "official subtitle sidecar checks failed");
    const color = await loadCore(repo, "color-bridge"), bgm = await loadCore(repo, "bgm-bridge");
    const coverModule = await import(pathToFileURL(join(repo, "packages/video-studio/src/local-cover-render.ts")).href) as { renderLocalCover: (o: Record<string, unknown>) => Promise<{ path: string; receipt: unknown }> };
    const outputs: Array<Record<string, unknown>> = [];
    const bgmEnv = { ...process.env, WORKLOOM_BGM_ALLOWED_ROOTS: [staging, ...plan.allowedRoots].join(sep === "\\" ? ";" : ":") };
    for (const version of plan.versions) {
      const label = version.id === "master" ? plan.projectId : `${plan.projectId}-variant-${version.id}`;
      const graded = join(post, `${version.id}-graded.mp4`), picture = join(post, `${version.id}-picture.mp4`);
      await stage(`color-${version.id}`, async () => {
        if (version.profile === "none") {
          await copyFile(composed, picture);
          const pictureSha256 = await existingEditFileHash(picture);
          if (pictureSha256 !== await existingEditFileHash(composed)) fail("EXISTING_EDIT_SOURCE_CHANGED", "picture copy differs from composition");
          return { mode: "source-passthrough", graded: false, applicable: false, reason: "master explicitly preserves composed source picture", source: composed, pictureSha256 };
        }
        const report = await Promise.resolve(color.grade!({ input: composed, output: graded, profile: version.profile, intensity: version.intensity, bins, auto: false,
          verifyAt: [2, 7, 12, 18, 21, 26].filter((n) => n < plan.durationSec), defects: true, onUnfixable: "report" }));
        await run(bins.ffmpeg, ["-v", "error", "-n", ...directMediaInput(), "-i", graded, ...directMediaInput(), "-i", composed, "-map", "0:v:0", "-map", "1:a:0", "-c", "copy", "-movflags", "+faststart", picture], timeout);
        return { report, sourceAudioRestoredFrom: composed, pictureSha256: await existingEditFileHash(picture) };
      });
      let scored = picture; let mixReport: unknown = { layer: "off", reason: "no music requested", sourceAuthority: "declared-unverified", stemsVerified: false };
      if (version.musicSourceId) {
        scored = join(post, `${version.id}-scored.mp4`);
        mixReport = await stage(`bgm-${version.id}`, () => Promise.resolve(bgm.mix!({ input: picture, output: scored, bgmPath: sources.get(version.musicSourceId!), declaredProgramMix: true,
          env: bgmEnv, bins, policy: "keep-dialogue", musicLevelDb: version.musicLevelDb, duckingDb: version.duckingDb, targetLufs: -14, truePeak: -1.5,
          cutTimes: prepared.slice(1).map((s) => s.timelineStartSec), bgmBpm: version.musicBpm, bpmOverride: version.musicBpm, align: true, section: "full",
          evidenceDir: join(evidenceDir, `bgm-${version.id}-frames`), licenseReviewed: false, commercialUse: false })));
      }
      const burned = join(post, `${version.id}-subtitled.mp4`);
      await stage(`subtitle-burn-${version.id}`, () => Promise.resolve(subtitle.renderWithSubtitles!({ mode: "subtitle", input: scored, output: burned, cues, titleText: "",
        platform, brief, fontsDir: plan.subtitleFontsRoot, catalog, bins, evidenceDir: join(evidenceDir, `subtitle-${version.id}-frames`) })));
      const cover = join(staging, `${label}-cover.png`);
      await stage(`cover-${version.id}`, () => coverModule.renderLocalCover({ source: { kind: "video-frame", path: sources.get(plan.cover.sourceId)!, timeSec: plan.cover.atSec },
        title: plan.cover.title, subtitle: plan.cover.subtitle, platform: plan.cover.platform, variant: version.id === "master" ? "warm-film" : version.id,
        out: cover, width: plan.width, height: plan.height, fontFile: font, fontSha256: plan.cover.fontSha256, fontId: plan.cover.fontId,
        ffmpeg: bins.ffmpeg, ffprobe: bins.ffprobe, footageOrigin: "generated", durationSeconds: plan.durationSec, timeoutMs: Math.min(timeout, 600_000) }));
      const final = join(staging, `${label}.mp4`);
      const coverReceipt = await stage(`cover-assembly-${version.id}`, () => embedCoverFirstFrame({ input: burned, cover, output: final, ...bins, timeoutMs: Math.min(timeout, 600_000) }));
      const media = await probe(final, bins, timeout), video = media.streams.find((s) => s.codec_type === "video");
      if (Number(video?.nb_read_frames) !== Math.round(plan.durationSec * plan.fps) || rate(video!) !== plan.fps
        || Math.abs(Number(video?.duration) - plan.durationSec) > 0.000001) fail("EXISTING_EDIT_TIMELINE_CHANGED", version.id);
      await run(bins.ffmpeg, ["-v", "error", "-xerror", ...directMediaInput(), "-i", final, "-map", "0:v:0", "-map", "0:a:0", "-f", "null", "-"], timeout);
      outputs.push({ id: version.id, path: final, sha256: await existingEditFileHash(final), bytes: (await stat(final)).size, media, cover, coverReceipt, bgm: mixReport });
      if (version.id === "master") {
        const cleanWithCover = join(post, "master-clean-cover.mp4");
        await stage("clean-cover-assembly", () => embedCoverFirstFrame({ input: scored, cover, output: cleanWithCover, ...bins, timeoutMs: Math.min(timeout, 600_000) }));
        const soft = join(staging, `${plan.projectId}-softsub.mp4`), srt = sidecars.files.find((f) => f.format === "srt")?.path;
        if (!srt) fail("EXISTING_EDIT_SUBTITLE_UNVERIFIED", "official SRT missing");
        const receipt = await stage("soft-subtitle-mux", () => Promise.resolve(subtitle.softMux!({ input: cleanWithCover, output: soft, subtitles: [{ path: srt, lang: "chi", default: true }], bins, verify: true })));
        outputs.push({ id: "softsub", path: soft, sha256: await existingEditFileHash(soft), bytes: (await stat(soft)).size, receipt });
      }
    }
    for (const s of frozen.values()) if ((await stat(s.path)).size !== s.source.bytes || await existingEditFileHash(s.path) !== s.source.sha256) fail("EXISTING_EDIT_SOURCE_CHANGED", s.source.id);
    if (await existingEditFileHash(font) !== plan.cover.fontSha256 || await existingEditFileHash(planFile) !== planHash) fail("EXISTING_EDIT_SOURCE_CHANGED", "plan or cover font changed during editing");
    const finalFonts = subtitle.scanFonts!({ catalog, root: plan.subtitleFontsRoot, verifySha: true }) as typeof fonts;
    if (JSON.stringify(finalFonts.entries.map((e) => e.sha256)) !== JSON.stringify(fonts.entries.map((e) => e.sha256))) fail("EXISTING_EDIT_FONT_CHANGED", "subtitle fonts changed during editing");
    const finalCode = await codeBinding(repo, timeout);
    if (JSON.stringify(finalCode) !== JSON.stringify(code)) fail("EXISTING_EDIT_CODE_CHANGED", "consumed code, commit or working tree changed during editing");
    for (const binary of binaries) if (await existingEditFileHash(binary.path) !== binary.sha256) fail("EXISTING_EDIT_BINARY_CHANGED", binary.name);
    await relocateGeneratedReceipts(staging, staging, output);
    const manifest = relocate({ schemaVersion: "workloom.existing-render-delivery/v1", generatedAt: new Date().toISOString(), projectId: plan.projectId,
      mode: "existing-render-local-postproduction", planSha256: planHash, sourceCode: { ...code, currentCodeRechecked: true }, binaries,
      width: plan.width, height: plan.height, fps: plan.fps, durationSec: plan.durationSec,
      supplierGenerationCalls: 0, modelCalls: 0, ttsCalls: 0, asrCalls: 0, sourceFilesUnchanged: true, speed: 1, frameSynthesis: false,
      scope: "Local downloadable derived edit. Source authority is declared existing files; no new provider provenance, identity model verdict or signed stems are claimed.",
      sourceFiles: plan.sources, segments: prepared, excludedPictureSources: plan.forbiddenVideoSourceIds, authoredSubtitles: plan.subtitles,
      subtitleAlignment: "Authored sentence timing using existing audio; no new ASR or phonetic timing proof", openingTitle: { source: "none", burned: false },
      musicLicenseReview: { reviewed: false, commercialUse: false, basis: "Private local derived delivery using existing music files. Existing source declarations are retained; no upstream per-track license verification is claimed." },
      outputs, stages: records }, staging, output);
    await writeFile(join(staging, `${plan.projectId}-delivery-manifest.json`), `${JSON.stringify(manifest, null, 2)}\n`, { flag: "wx" });
    try { await lstat(output); fail("EXISTING_EDIT_OUTPUT_EXISTS", "output appeared while editing"); } catch (e) { if (!missing(e)) throw e; }
    await rename(staging, output);
    return manifest;
  } catch (e) {
    await writeFile(join(staging, "failed.json"), `${JSON.stringify({ status: "failed", code: (e as { code?: string }).code ?? "local_stage_failed", message: (e as Error).message,
      planSha256: planHash, stages: records, officialOutputPublished: false }, null, 2)}\n`);
    throw e;
  } finally { await lock.close(); await rm(lockPath, { force: true }); }
}
