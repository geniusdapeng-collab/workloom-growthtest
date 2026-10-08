/** Publication cover assembly. Formal exports prepend one cover frame and preserve the complete source body. */
import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, mkdir, open, realpath, rename, rm, stat } from "node:fs/promises";
import { basename, dirname, extname, join, resolve } from "node:path";
import { getCoverSpec, isKnownCoverPlatform } from "./cover-platforms.js";

export class CoverAssemblyError extends Error {
  constructor(message: string, readonly code = "cover_assembly_invalid") {
    super(message);
    this.name = "CoverAssemblyError";
  }
}

export type CoverVariantId = "warm-film" | "punchy-social" | "cool-tech";
export interface CoverVariantFilterInput {
  variantId: CoverVariantId;
  accent: string;
  platform?: string;
  width: number;
  height: number;
}

/** No user-visible operations labels are accepted by this renderer. */
export function buildVariantCoverFilters(input: CoverVariantFilterInput) {
  const grades: Record<CoverVariantId, string[]> = {
    "warm-film": ["colorbalance=rs=0.018:bs=-0.018", "eq=saturation=0.97:contrast=1.015"],
    "punchy-social": ["eq=saturation=1.10:contrast=1.055"],
    "cool-tech": ["colorbalance=rs=-0.018:bs=0.025", "eq=saturation=0.94:contrast=1.025"],
  };
  if (!Object.prototype.hasOwnProperty.call(grades, input.variantId)) throw new CoverAssemblyError("Unknown cover variant");
  if (!/^#[0-9a-f]{6}$/i.test(input.accent)) throw new CoverAssemblyError("Cover accent must be #RRGGBB");
  if (!isKnownCoverPlatform(input.platform)) throw new CoverAssemblyError("Unknown cover platform");
  if (![input.width, input.height].every((number) => Number.isSafeInteger(number) && number >= 16 && number <= 16384)) {
    throw new CoverAssemblyError("Invalid cover dimensions");
  }
  const spec = getCoverSpec(input.platform);
  const margin = Math.max(1, Math.round(input.width * 0.06));
  const safeArea = {
    left: margin,
    top: Math.ceil(input.height * spec.safeArea.topMinRatio),
    right: Math.floor(input.width * (1 - spec.safeArea.rightRailRatio)) - margin,
    bottom: Math.floor(input.height * (1 - spec.safeArea.bottomReservedRatio)),
  };
  const barHeight = Math.max(1, Math.round(input.height * 0.006));
  const accentBox = {
    x: safeArea.left,
    y: safeArea.bottom - Math.max(1, Math.round(input.height * 0.02)) - barHeight,
    width: safeArea.right - safeArea.left,
    height: barHeight,
  };
  if (accentBox.width < 1 || accentBox.y < safeArea.top) throw new CoverAssemblyError("No safe area available for cover accent");
  const filters = [...grades[input.variantId],
    `drawbox=x=${accentBox.x}:y=${accentBox.y}:w=${accentBox.width}:h=${accentBox.height}:color=${input.accent.replace("#", "0x")}@0.95:t=fill`];
  return { variantId: input.variantId, platform: spec.id, safeArea, accentBox, filters, filter: filters.join(",") };
}

export interface CoverFirstFrameInput {
  input: string;
  cover: string;
  output: string;
  ffmpeg?: string;
  ffprobe?: string;
  timeoutMs?: number;
  /** Keep every source picture by inserting the cover before the body. */
  preserveSourceFrames?: boolean;
}

export interface CoverFirstFrameReceipt {
  schemaVersion: 1 | 2;
  mode: "replace-first-frame" | "prepend-cover-frame";
  sourceVideo?: { frameCount: number; fps: number; durationSeconds: number };
  sourceOffsetFrames?: 1;
  bodyVideoOffsetSeconds?: number;
  audioOffsetSeconds?: 0;
  subtitleOffsetSeconds?: 0;
  coverFrameCount: 1;
  input: { path: string; sha256: string };
  cover: { path: string; sha256: string };
  output: { path: string; sha256: string };
  video: { width: number; height: number; fps: number; frameCount: number | null; frameCountBasis: "container-metadata" | "not-reported"; durationSeconds: number; timelineSha256: null; coverPsnrDb: null };
  audio: { preserved: true; streamCount: number; packetSha256: string; decodedPcmSha256: string[] };
  subtitles: { preserved: true; streamCount: number; packetSha256: string };
  qualityReviewPerformed: false;
  coverTransform: { width: number; height: number; mode: "contain-and-pad" };
  verificationBasis: string;
}

interface MediaStream {
  index: number;
  codec_type: string;
  codec_name?: string;
  width?: number;
  height?: number;
  avg_frame_rate?: string;
  time_base?: string;
  duration?: string;
  start_time?: string;
  nb_frames?: string;
  sample_rate?: string;
  channels?: number;
  channel_layout?: string;
  pix_fmt?: string;
  tags?: Record<string, string>;
  side_data_list?: Array<{ rotation?: number }>;
}
interface MediaProbe { streams: MediaStream[]; format: { duration?: string } }
const digest = (data: string): string => createHash("sha256").update(data).digest("hex");
const missing = (error: unknown): boolean => (error as NodeJS.ErrnoException).code === "ENOENT";

async function sha256(file: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest("hex");
}

function execute(binary: string, args: string[], timeout: number): Promise<{ stdout: string; stderr: string }> {
  return new Promise((accept, reject) => execFile(binary, args, { encoding: "utf8", timeout, maxBuffer: 64 * 1024 * 1024 }, (error, stdout, stderr) => {
    if (error) reject(new CoverAssemblyError(`${basename(binary)} failed: ${stderr.slice(-2400) || error.message}`, "cover_assembly_process_failed"));
    else accept({ stdout, stderr });
  }));
}

async function probe(file: string, binary: string, timeout: number): Promise<MediaProbe> {
  const result = await execute(binary, ["-v", "error", "-show_streams", "-show_format", "-of", "json", file], timeout);
  const parsed = JSON.parse(result.stdout) as MediaProbe;
  if (!Array.isArray(parsed.streams) || !parsed.format) throw new CoverAssemblyError("Invalid media probe");
  return parsed;
}

function numericRate(rate: string | undefined): number {
  const [a, b] = String(rate ?? "").split("/").map(Number);
  return Number(a) / Number(b);
}

async function packetFingerprint(file: string, selector: "a" | "s", ffprobe: string, timeout: number): Promise<string> {
  const { stdout } = await execute(ffprobe, ["-v", "error", "-select_streams", selector, "-show_packets", "-show_data_hash", "sha256",
    "-show_entries", "packet=stream_index,pts_time,dts_time,duration_time,size,data_hash:packet_side_data", "-of", "json", file], timeout);
  const packets = (JSON.parse(stdout) as { packets?: Array<Record<string, unknown>> }).packets ?? [];
  const streamOrdinals = new Map<unknown, number>();
  const canonical = packets.map((packet) => {
    if (!streamOrdinals.has(packet.stream_index)) streamOrdinals.set(packet.stream_index, streamOrdinals.size);
    return { ...packet, stream_index: streamOrdinals.get(packet.stream_index) };
  });
  return digest(JSON.stringify(canonical));
}

function streamMetadata(streams: MediaStream[], kind: "audio" | "subtitle"): string {
  return JSON.stringify(streams.filter((stream) => stream.codec_type === kind).map((stream) => ({
    codec: stream.codec_name, start: stream.start_time, duration: stream.duration,
    sampleRate: stream.sample_rate, channels: stream.channels, layout: stream.channel_layout,
    language: stream.tags?.language,
  })));
}

function assertInvariant(condition: boolean, message: string): asserts condition {
  if (!condition) throw new CoverAssemblyError(message, "cover_assembly_verify_failed");
}

/**
 * Formal exports insert one still frame at zero and shift every body picture by 1/fps.
 * Legacy callers can still replace frame zero. Audio/subtitle packet bytes and timestamps stay
 * on their original clock. Ordinary metadata and copied packets are verified before atomic
 * publication; this does not perform a picture/audio quality review.
 * Reference: https://www.ffmpeg.org/ffmpeg-filters.html#interleave_002c-ainterleave
 */
export async function embedCoverFirstFrame(options: CoverFirstFrameInput): Promise<CoverFirstFrameReceipt> {
  const ffmpeg = options.ffmpeg ?? "ffmpeg";
  const ffprobe = options.ffprobe ?? "ffprobe";
  const timeout = options.timeoutMs ?? 180_000;
  if (!Number.isSafeInteger(timeout) || timeout < 1 || timeout > 600_000) throw new CoverAssemblyError("Invalid process timeout");
  const input = await realpath(resolve(options.input));
  const cover = await realpath(resolve(options.cover));
  const desiredOutput = resolve(options.output);
  if ([input, cover, resolve(options.input), resolve(options.cover)].includes(desiredOutput)) {
    throw new CoverAssemblyError("Output must not alias source or cover");
  }
  if (extname(desiredOutput).toLowerCase() !== ".mp4") throw new CoverAssemblyError("Publication output must be .mp4");
  const [sourceStat, coverStat] = await Promise.all([stat(input), stat(cover)]);
  if (!sourceStat.isFile() || !coverStat.isFile() || sourceStat.size === 0 || coverStat.size === 0) throw new CoverAssemblyError("Empty or non-file media input");
  await mkdir(dirname(desiredOutput), { recursive: true });
  const output = join(await realpath(dirname(desiredOutput)), basename(desiredOutput));
  try {
    const target = await lstat(output);
    if (target.isSymbolicLink() || [sourceStat, coverStat].some((item) => item.dev === target.dev && item.ino === target.ino)) {
      throw new CoverAssemblyError("Output must not alias source or cover, or be a symlink");
    }
    if (!target.isFile()) throw new CoverAssemblyError("Existing output is not a file");
  } catch (error) { if (!missing(error)) throw error; }
  const lockPath = `${output}.cover-assembly.lock`;
  const pending = join(dirname(output), `.${basename(output, ".mp4")}.pending-${randomUUID()}.mp4`);
  let lock;
  try { lock = await open(lockPath, "wx"); }
  catch (error) { throw new CoverAssemblyError(`Publication is busy or lock cannot be created: ${(error as Error).message}`, "cover_assembly_busy"); }
  try {
    const [sourceInfo, coverInfo, sourceHash, coverHash] = await Promise.all([
      probe(input, ffprobe, timeout), probe(cover, ffprobe, timeout), sha256(input), sha256(cover),
    ]);
    const videos = sourceInfo.streams.filter((stream) => stream.codec_type === "video");
    const video = videos[0];
    const image = coverInfo.streams.find((stream) => stream.codec_type === "video");
    if (videos.length !== 1 || !video || !(Number(video.width) > 0) || !(Number(video.height) > 0)) throw new CoverAssemblyError("Source must contain one readable video stream");
    if (!image || !["png", "mjpeg", "webp", "bmp", "tiff"].includes(image.codec_name ?? "") || !(Number(image.width) > 0) || !(Number(image.height) > 0)) throw new CoverAssemblyError("Cover must be a readable still image");
    if (video.side_data_list?.some((side) => side.rotation)) throw new CoverAssemblyError("Rotate source before publication cover assembly");
    const fps = numericRate(video.avg_frame_rate);
    const duration = Number(video.duration);
    if (!Number.isFinite(fps) || !(fps > 0) || !Number.isFinite(duration) || !(duration > 0)) throw new CoverAssemblyError("Source video timing is incomplete");
    const frameCount = Number.isSafeInteger(Number(video.nb_frames)) && Number(video.nb_frames) > 0 ? Number(video.nb_frames) : null;
    const audioCount = sourceInfo.streams.filter((stream) => stream.codec_type === "audio").length;
    const subtitleCount = sourceInfo.streams.filter((stream) => stream.codec_type === "subtitle").length;
    const [audioPackets, subtitlePackets] = await Promise.all([
      packetFingerprint(input, "a", ffprobe, timeout), packetFingerprint(input, "s", ffprobe, timeout),
    ]);
    const preserve = options.preserveSourceFrames === true;
    if (preserve && frameCount === null) throw new CoverAssemblyError("Complete source frame metadata is required for cover insertion");
    const pixelFormat = preserve ? video.pix_fmt : "yuv420p";
    if (preserve && !["yuv420p", "yuv422p", "yuv444p", "gray"].includes(pixelFormat ?? "")) {
      throw new CoverAssemblyError("Complete-source cover insertion requires a lossless-compatible source pixel format");
    }
    const prepareCover = `[1:v:0]scale=${video.width}:${video.height}:force_original_aspect_ratio=decrease,pad=${video.width}:${video.height}:(ow-iw)/2:(oh-ih)/2,setsar=1,format=${pixelFormat},settb=AVTB,setpts=PTS-STARTPTS[cover]`;
    const filter = preserve
      ? `${prepareCover};[0:v:0]settb=AVTB,setpts=PTS-STARTPTS+${1 / fps}/TB[body];[cover][body]interleave=nb_inputs=2:duration=longest[v]`
      : `${prepareCover};[0:v:0][cover]overlay=0:0:enable='eq(n,0)':eof_action=repeat:repeatlast=1:shortest=0[v]`;
    await execute(ffmpeg, ["-v", "error", "-nostdin", "-y", "-copyts", "-i", input, "-i", cover,
      "-filter_complex", filter,
      "-map", "[v]", "-map", "0:a?", "-map", "0:s?", "-map_metadata", "0", "-map_chapters", "0",
      "-c:v", "libx264", "-preset", "medium", "-crf", preserve ? "0" : "17", "-pix_fmt", pixelFormat!, "-fps_mode:v", preserve ? "cfr" : "passthrough",
      ...(preserve ? ["-r:v", video.avg_frame_rate!] : []),
      "-video_track_timescale", String(Math.round(1 / numericRate(video.time_base))),
      "-c:a", "copy", "-c:s", "copy", "-movflags", "+faststart", pending], timeout);
    const produced = await probe(pending, ffprobe, timeout);
    const finalVideo = produced.streams.find((stream) => stream.codec_type === "video");
    assertInvariant(Boolean(finalVideo), "Publication has no video stream");
    assertInvariant(finalVideo!.width === video.width && finalVideo!.height === video.height, "Publication dimensions changed");
    const expectedFrames = frameCount === null ? null : frameCount + (preserve ? 1 : 0);
    const expectedDuration = duration + (preserve ? 1 / fps : 0);
    if (expectedFrames !== null) assertInvariant(Number(finalVideo!.nb_frames) === expectedFrames, "Publication metadata frame count changed");
    assertInvariant(Math.abs(Number(finalVideo!.duration) - expectedDuration) <= 0.000002, "Publication video duration changed");
    const expectedContainerDuration = Math.max(expectedDuration, ...sourceInfo.streams.filter(stream => stream.codec_type !== "video").map(stream => Number(stream.start_time ?? 0) + Number(stream.duration ?? 0)));
    if (!preserve) assertInvariant(Math.abs(Number(produced.format.duration) - Number(sourceInfo.format.duration)) <= 0.000001, "Publication container duration changed");
    else assertInvariant(Math.abs(Number(produced.format.duration) - expectedContainerDuration) <= 0.0011, "Publication container duration differs from its complete streams");
    assertInvariant(Math.abs(numericRate(finalVideo!.avg_frame_rate) - fps) <= 0.000001, "Publication fps changed");
    assertInvariant(streamMetadata(sourceInfo.streams, "audio") === streamMetadata(produced.streams, "audio"), "Publication audio stream metadata changed");
    assertInvariant(streamMetadata(sourceInfo.streams, "subtitle") === streamMetadata(produced.streams, "subtitle"), "Publication subtitle stream metadata changed");
    const [finalAudio, finalSubtitles] = await Promise.all([
      packetFingerprint(pending, "a", ffprobe, timeout), packetFingerprint(pending, "s", ffprobe, timeout),
    ]);
    assertInvariant(finalAudio === audioPackets, "Publication copied audio packets or timestamps changed");
    assertInvariant(finalSubtitles === subtitlePackets, "Publication copied subtitle packets or timestamps changed");
    const [finalInputHash, finalCoverHash, outputHash] = await Promise.all([sha256(input), sha256(cover), sha256(pending)]);
    assertInvariant(finalInputHash === sourceHash && finalCoverHash === coverHash, "Input changed during publication cover assembly");
    const receipt: CoverFirstFrameReceipt = {
      schemaVersion: preserve ? 2 : 1, mode: preserve ? "prepend-cover-frame" : "replace-first-frame", coverFrameCount: 1,
      ...(preserve ? { sourceVideo: { frameCount: frameCount!, fps, durationSeconds: duration }, sourceOffsetFrames: 1 as const,
        bodyVideoOffsetSeconds: 1 / fps, audioOffsetSeconds: 0 as const, subtitleOffsetSeconds: 0 as const } : {}),
      input: { path: input, sha256: sourceHash }, cover: { path: cover, sha256: coverHash }, output: { path: output, sha256: outputHash },
      video: { width: video.width!, height: video.height!, fps, frameCount: expectedFrames, frameCountBasis: expectedFrames === null ? "not-reported" : "container-metadata", durationSeconds: Number(finalVideo!.duration),
        timelineSha256: null, coverPsnrDb: null },
      audio: { preserved: true, streamCount: audioCount, packetSha256: audioPackets, decodedPcmSha256: [] },
      subtitles: { preserved: true, streamCount: subtitleCount, packetSha256: subtitlePackets },
      qualityReviewPerformed: false, coverTransform: { width: video.width!, height: video.height!, mode: "contain-and-pad" },
      verificationBasis: preserve
        ? "Actual cover insertion with lossless complete-source body encoding, copied audio/subtitle packets and original timestamps, ordinary stream/container metadata and unchanged input SHA. No PSNR, full video timestamps, decoded PCM or source-quality review."
        : "Actual first-frame overlay and copied audio/subtitle packets, ordinary stream/container metadata and unchanged input SHA. No PSNR, full video timestamps, decoded PCM or source-quality review.",
    };
    await rename(pending, output);
    return receipt;
  } finally {
    await rm(pending, { force: true });
    await lock.close();
    await rm(lockPath, { force: true });
  }
}
