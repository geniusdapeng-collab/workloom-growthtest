/** Publication cover assembly. The clean master stays separate; only frame zero is replaced. */
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
}

export interface CoverFirstFrameReceipt {
  schemaVersion: 1;
  mode: "replace-first-frame";
  coverFrameCount: 1;
  input: { path: string; sha256: string };
  cover: { path: string; sha256: string };
  output: { path: string; sha256: string };
  video: { width: number; height: number; fps: number; frameCount: number; durationSeconds: number; timelineSha256: string; coverPsnrDb: number | null };
  audio: { preserved: true; streamCount: number; packetSha256: string; decodedPcmSha256: string[] };
  subtitles: { preserved: true; streamCount: number; packetSha256: string };
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
  nb_read_frames?: string;
  sample_rate?: string;
  channels?: number;
  channel_layout?: string;
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
  const result = await execute(binary, ["-v", "error", "-count_frames", "-show_streams", "-show_format", "-of", "json", file], timeout);
  const parsed = JSON.parse(result.stdout) as MediaProbe;
  if (!Array.isArray(parsed.streams) || !parsed.format) throw new CoverAssemblyError("Invalid media probe");
  return parsed;
}

function numericRate(rate: string | undefined): number {
  const [a, b] = String(rate ?? "").split("/").map(Number);
  return Number(a) / Number(b);
}

async function videoTimeline(file: string, ffprobe: string, timeout: number): Promise<string> {
  const { stdout } = await execute(ffprobe, ["-v", "error", "-select_streams", "v:0", "-show_frames",
    "-show_entries", "frame=best_effort_timestamp_time,pkt_duration_time", "-of", "json", file], timeout);
  const frames = (JSON.parse(stdout) as { frames?: Array<{ best_effort_timestamp_time?: string; pkt_duration_time?: string }> }).frames;
  if (!frames?.length || frames.some((frame) => !Number.isFinite(Number(frame.best_effort_timestamp_time)))) {
    throw new CoverAssemblyError("Missing video presentation timestamps");
  }
  return digest(JSON.stringify(frames.map((frame) => [frame.best_effort_timestamp_time, frame.pkt_duration_time])));
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

async function decodedAudioHashes(file: string, count: number, ffmpeg: string, timeout: number): Promise<string[]> {
  const hashes: string[] = [];
  for (let index = 0; index < count; index += 1) {
    const { stdout } = await execute(ffmpeg, ["-v", "error", "-i", file, "-map", `0:a:${index}`, "-c:a", "pcm_s16le", "-f", "hash", "-hash", "sha256", "-"], timeout);
    const hash = /^SHA256=([0-9a-f]{64})\s*$/i.exec(stdout)?.[1]?.toLowerCase();
    if (!hash) throw new CoverAssemblyError("Missing decoded audio hash");
    hashes.push(hash);
  }
  return hashes;
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
 * FFmpeg timeline enable n=0 replaces exactly one frame. No prepend, concat, audio resampling,
 * fps conversion, duration trim, or subtitle shift occurs. Checks finish before atomic publication.
 * Reference: https://www.ffmpeg.org/ffmpeg-filters.html#Timeline-editing
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
    if (videos.length !== 1 || !video || Number(video.nb_read_frames) < 2) throw new CoverAssemblyError("Source must contain one video stream with at least two frames");
    if (!image || Number(image.nb_read_frames) !== 1) throw new CoverAssemblyError("Cover must contain exactly one image frame");
    if (image.width !== video.width || image.height !== video.height) throw new CoverAssemblyError("Cover dimensions must match publication video");
    if (video.side_data_list?.some((side) => side.rotation)) throw new CoverAssemblyError("Rotate source before publication cover assembly");
    const fps = numericRate(video.avg_frame_rate);
    const duration = Number(video.duration);
    if (!(fps > 0) || !(duration > 0) || !Number.isInteger(Number(video.nb_read_frames))) throw new CoverAssemblyError("Source video timing is incomplete");
    const audioCount = sourceInfo.streams.filter((stream) => stream.codec_type === "audio").length;
    const subtitleCount = sourceInfo.streams.filter((stream) => stream.codec_type === "subtitle").length;
    const [timeline, audioPackets, subtitlePackets] = await Promise.all([
      videoTimeline(input, ffprobe, timeout), packetFingerprint(input, "a", ffprobe, timeout), packetFingerprint(input, "s", ffprobe, timeout),
    ]);
    await execute(ffmpeg, ["-v", "error", "-nostdin", "-y", "-copyts", "-i", input, "-i", cover,
      "-filter_complex", "[1:v:0]format=yuv420p,setpts=PTS-STARTPTS[cover];[0:v:0][cover]overlay=0:0:enable='eq(n,0)':eof_action=repeat:repeatlast=1:shortest=0[v]",
      "-map", "[v]", "-map", "0:a?", "-map", "0:s?", "-map_metadata", "0", "-map_chapters", "0",
      "-c:v", "libx264", "-preset", "medium", "-crf", "17", "-pix_fmt", "yuv420p", "-fps_mode:v", "passthrough",
      "-video_track_timescale", String(Math.round(1 / numericRate(video.time_base))),
      "-c:a", "copy", "-c:s", "copy", "-movflags", "+faststart", pending], timeout);
    const produced = await probe(pending, ffprobe, timeout);
    const finalVideo = produced.streams.find((stream) => stream.codec_type === "video");
    assertInvariant(Boolean(finalVideo), "Publication has no video stream");
    assertInvariant(finalVideo!.width === video.width && finalVideo!.height === video.height, "Publication dimensions changed");
    assertInvariant(finalVideo!.nb_read_frames === video.nb_read_frames, "Publication frame count changed");
    assertInvariant(Math.abs(Number(finalVideo!.duration) - duration) <= 0.000001, "Publication video duration changed");
    assertInvariant(Math.abs(Number(produced.format.duration) - Number(sourceInfo.format.duration)) <= 0.000001, "Publication container duration changed");
    assertInvariant(Math.abs(numericRate(finalVideo!.avg_frame_rate) - fps) <= 0.000001, "Publication fps changed");
    assertInvariant(streamMetadata(sourceInfo.streams, "audio") === streamMetadata(produced.streams, "audio"), "Publication audio stream metadata changed");
    assertInvariant(streamMetadata(sourceInfo.streams, "subtitle") === streamMetadata(produced.streams, "subtitle"), "Publication subtitle stream metadata changed");
    const [finalTimeline, finalAudio, finalSubtitles, sourcePcm, finalPcm] = await Promise.all([
      videoTimeline(pending, ffprobe, timeout), packetFingerprint(pending, "a", ffprobe, timeout), packetFingerprint(pending, "s", ffprobe, timeout),
      decodedAudioHashes(input, audioCount, ffmpeg, timeout), decodedAudioHashes(pending, audioCount, ffmpeg, timeout),
    ]);
    assertInvariant(finalTimeline === timeline, "Publication video timestamps changed");
    assertInvariant(finalAudio === audioPackets, "Publication audio packets or timestamps changed");
    assertInvariant(finalSubtitles === subtitlePackets, "Publication subtitle packets or timestamps changed");
    assertInvariant(JSON.stringify(sourcePcm) === JSON.stringify(finalPcm), "Publication decoded audio changed");
    const visual = await execute(ffmpeg, ["-v", "info", "-nostdin", "-i", pending, "-i", cover,
      "-filter_complex", "[0:v:0]select='eq(n,0)',setpts=PTS-STARTPTS[frame];[1:v:0]format=yuv420p,setpts=PTS-STARTPTS[image];[frame][image]psnr=shortest=1",
      "-an", "-frames:v", "1", "-f", "null", "-"], timeout);
    const match = /PSNR[^\n]*average:([0-9.]+|inf)/i.exec(visual.stderr)?.[1];
    const coverPsnr = match === "inf" ? Infinity : Number(match);
    assertInvariant(coverPsnr >= 32, `Publication first frame does not match cover (PSNR ${match ?? "missing"})`);
    await execute(ffmpeg, ["-v", "error", "-xerror", "-nostdin", "-i", pending, "-map", "0:v:0", "-f", "null", "-"], timeout);
    const [finalInputHash, finalCoverHash, outputHash] = await Promise.all([sha256(input), sha256(cover), sha256(pending)]);
    assertInvariant(finalInputHash === sourceHash && finalCoverHash === coverHash, "Input changed during publication cover assembly");
    const receipt: CoverFirstFrameReceipt = {
      schemaVersion: 1, mode: "replace-first-frame", coverFrameCount: 1,
      input: { path: input, sha256: sourceHash }, cover: { path: cover, sha256: coverHash }, output: { path: output, sha256: outputHash },
      video: { width: video.width!, height: video.height!, fps, frameCount: Number(video.nb_read_frames), durationSeconds: duration,
        timelineSha256: timeline, coverPsnrDb: Number.isFinite(coverPsnr) ? coverPsnr : null },
      audio: { preserved: true, streamCount: audioCount, packetSha256: audioPackets, decodedPcmSha256: finalPcm },
      subtitles: { preserved: true, streamCount: subtitleCount, packetSha256: subtitlePackets },
    };
    await rename(pending, output);
    return receipt;
  } finally {
    await rm(pending, { force: true });
    await lock.close();
    await rm(lockPath, { force: true });
  }
}
