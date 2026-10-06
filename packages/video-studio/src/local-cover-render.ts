import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, mkdtemp, open, readFile, realpath, rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname, extname, isAbsolute, join, resolve } from "node:path";
import { buildVariantCoverFilters, type CoverVariantId } from "./cover-assembly.js";
import { COVER_FONTS, validateCoverVisibleCopy, type CoverFontId } from "./cover-design.js";
import { getCoverSpec, isKnownCoverPlatform } from "./cover-platforms.js";

export class LocalCoverRenderError extends Error {
  /** If rename was attempted, callers can report its side effect without treating an error as an absent file. */
  publication?: { state: "published" | "unknown"; renameCompleted: boolean; expectedOutput: FileBinding };
  constructor(message: string, readonly code = "LOCAL_COVER_INPUT_INVALID") {
    super(message);
    this.name = "LocalCoverRenderError";
  }
}

export interface LocalCoverRenderInput {
  source: { kind: "image"; path: string } | { kind: "video-frame"; path: string; timeSec: number };
  title: string;
  subtitle?: string;
  platform: string;
  variant?: CoverVariantId;
  out: string;
  width: number;
  height: number;
  fontFile: string;
  fontSha256: string;
  fontId?: CoverFontId;
  ffmpeg: string;
  ffprobe: string;
  footageOrigin?: "generated" | "live-action" | "mixed";
  durationSeconds?: number;
  timeoutMs?: number;
}

export interface LocalCoverPixelBox { x: number; y: number; width: number; height: number }
interface FileBinding { path: string; sha256: string; bytes: number }
export interface LocalCoverTextReceipt {
  field: "title" | "subtitle";
  line: number;
  text: string;
  textSha256: string;
  fontSize: number;
  bbox: LocalCoverPixelBox;
  alphaPixelCount: number;
  changedPixelCount: number;
  fitAttempts: number;
}
export interface LocalCoverRenderReceipt {
  schemaVersion: "workloom.local-cover-render/v1";
  purpose: "existing-local-edit";
  source: FileBinding & { kind: "image" | "video-frame"; timeSec?: number; frameSha256: string; frameRgbaSha256: string };
  font: FileBinding & { id: CoverFontId; glyphCoverageChecked: true; codePoints: number[] };
  recipe: {
    platform: string; variant: CoverVariantId; width: number; height: number;
    title: string; subtitle?: string; titleColor: string; accentColor: string;
    safeBounds: { left: number; top: number; right: number; bottom: number; titleBottom: number };
    backgroundFilters: string[]; sha256: string;
  };
  text: LocalCoverTextReceipt[];
  output: FileBinding & { width: number; height: number; rgbaSha256: string };
  binaries: { ffmpeg: FileBinding; ffprobe: FileBinding };
  commands: Array<{ binary: "ffmpeg" | "ffprobe"; argv: string[] }>;
  checks: { currentInputs: true; exactDimensions: true; textInsideSafeBounds: true; textPixelsVisible: true; singlePngFrame: true };
  limits: string[];
}
export interface LocalCoverRenderResult {
  path: string; width: number; height: number; sha256: string; receipt: LocalCoverRenderReceipt;
}

interface Snapshot extends FileBinding { dev: number; ino: number; data: Buffer }
interface Probe {
  streams: Array<{ codec_type?: string; codec_name?: string; width?: number; height?: number; nb_read_frames?: string;
    duration?: string; side_data_list?: Array<{ rotation?: number }> }>;
  format?: { duration?: string };
}
const hash = (value: string | Buffer): string => createHash("sha256").update(value).digest("hex");
const absent = (error: unknown): boolean => (error as NodeJS.ErrnoException).code === "ENOENT";
// Disallow playlist demuxers and network protocols even when a local file embeds another URL.
const STILL_FORMATS = "png_pipe,jpeg_pipe,webp_pipe,bmp_pipe,tiff_pipe,apng,gif";
const VIDEO_FORMATS = "mov,matroska,avi,mpegts";
const localInput = (formats: string): string[] => ["-protocol_whitelist", "file,pipe", "-format_whitelist", formats];
function fail(message: string, code: string): never { throw new LocalCoverRenderError(message, code); }
const binding = (file: Snapshot): FileBinding => ({ path: file.path, sha256: file.sha256, bytes: file.bytes });
const same = (left: Snapshot | null, right: Snapshot | null): boolean => left === null || right === null
  ? left === right : left.sha256 === right.sha256 && left.dev === right.dev && left.ino === right.ino;

async function snapshot(path: string, maxBytes: number, code: string): Promise<Snapshot> {
  try {
    if (typeof path !== "string" || !isAbsolute(path) || path.includes("\0")) fail("Expected an absolute local file path", code);
    const canonical = resolve(path);
    const info = await lstat(canonical);
    if (info.isSymbolicLink() || !info.isFile() || info.size < 1 || info.size > maxBytes || await realpath(canonical) !== canonical) {
      fail("Input must be a nonempty regular file without symlink ancestors, within the byte limit", code);
    }
    const data = await readFile(canonical);
    const after = await lstat(canonical);
    if (data.length !== info.size || after.dev !== info.dev || after.ino !== info.ino || after.size !== info.size || after.mtimeMs !== info.mtimeMs) {
      fail("File changed while being read", "LOCAL_COVER_INPUT_CHANGED");
    }
    return { path: canonical, sha256: hash(data), bytes: data.length, dev: info.dev, ino: info.ino, data };
  } catch (error) {
    if (error instanceof LocalCoverRenderError) throw error;
    fail(`Cannot read local file: ${(error as Error).message}`, code);
  }
}

/** Bounded OpenType Unicode cmap formats 4/12. A .notdef glyph is never accepted as visible copy. */
function checkGlyphs(font: Buffer, copy: string): number[] {
  function invalid(message: string): never { return fail(message, "LOCAL_COVER_FONT_INVALID"); }
  const uint16 = (offset: number): number => {
    if (offset < 0 || offset + 2 > font.length) invalid("Truncated font table");
    return font.readUInt16BE(offset);
  };
  const uint32 = (offset: number): number => {
    if (offset < 0 || offset + 4 > font.length) invalid("Truncated font table");
    return font.readUInt32BE(offset);
  };
  if (font.length < 12 || ![0x00010000, 0x4f54544f].includes(uint32(0))) invalid("Expected a single TrueType/OpenType font");
  const count = uint16(4);
  if (!count || count > 256 || 12 + count * 16 > font.length) invalid("Invalid font table directory");
  const tables = new Map<string, { offset: number; length: number }>();
  for (let index = 0; index < count; index += 1) {
    const at = 12 + index * 16;
    const tag = font.toString("ascii", at, at + 4);
    const offset = uint32(at + 8), length = uint32(at + 12);
    if (offset < 12 + count * 16 || offset + length > font.length || tables.has(tag)) invalid("Invalid or duplicate font table");
    tables.set(tag, { offset, length });
  }
  const cmap = tables.get("cmap"), maxp = tables.get("maxp");
  if (!cmap || cmap.length < 4 || !maxp || maxp.length < 6 || uint16(cmap.offset) !== 0) invalid("Missing Unicode cmap/maxp table");
  const glyphCount = uint16(maxp.offset + 4);
  if (!glyphCount) invalid("Font has no glyphs");
  const entries = uint16(cmap.offset + 2);
  if (!entries || entries > 256 || 4 + entries * 8 > cmap.length) invalid("Invalid cmap directory");
  const lookups: Array<(point: number) => number> = [];
  const seen = new Set<number>();
  for (let index = 0; index < entries; index += 1) {
    const entry = cmap.offset + 4 + index * 8;
    const platform = uint16(entry), encoding = uint16(entry + 2), relative = uint32(entry + 4);
    if (!(platform === 0 || platform === 3 && [1, 10].includes(encoding))) continue;
    if (relative < 4 + entries * 8 || relative + 2 > cmap.length) invalid("Invalid cmap subtable offset");
    const at = cmap.offset + relative;
    if (seen.has(at)) continue;
    seen.add(at);
    const format = uint16(at);
    if (format === 12) {
      if (relative + 16 > cmap.length) invalid("Truncated cmap format 12");
      const length = uint32(at + 4), groups = uint32(at + 12);
      if (length < 16 || relative + length > cmap.length || groups > 100_000 || 16 + groups * 12 > length) invalid("Invalid cmap format 12 bounds");
      let previous = -1;
      const ranges: Array<[number, number, number]> = [];
      for (let group = 0; group < groups; group += 1) {
        const pos = at + 16 + group * 12;
        const start = uint32(pos), end = uint32(pos + 4), glyph = uint32(pos + 8);
        if (start <= previous || end < start || end > 0x10ffff || glyph + end - start >= glyphCount) invalid("Invalid cmap format 12 group");
        previous = end;
        ranges.push([start, end, glyph]);
      }
      lookups.unshift((point) => {
        let low = 0, high = ranges.length - 1;
        while (low <= high) {
          const middle = (low + high) >>> 1, range = ranges[middle]!;
          if (point < range[0]) high = middle - 1;
          else if (point > range[1]) low = middle + 1;
          else return range[2] + point - range[0];
        }
        return 0;
      });
    } else if (format === 4) {
      if (relative + 16 > cmap.length) invalid("Truncated cmap format 4");
      const length = uint16(at + 2), segments = uint16(at + 6) / 2;
      if (!Number.isInteger(segments) || !segments || length < 16 + segments * 8 || relative + length > cmap.length) invalid("Invalid cmap format 4 bounds");
      const ends = at + 14, starts = ends + segments * 2 + 2, deltas = starts + segments * 2, offsets = deltas + segments * 2;
      let previous = -1;
      for (let segment = 0; segment < segments; segment += 1) {
        const start = uint16(starts + segment * 2), end = uint16(ends + segment * 2);
        if (start > end || end <= previous) invalid("Invalid cmap format 4 segment order");
        previous = end;
        const rangeOffset = uint16(offsets + segment * 2);
        if (rangeOffset && (rangeOffset % 2 || offsets + segment * 2 + rangeOffset + (end - start) * 2 + 2 > at + length)) invalid("Invalid cmap glyph array");
      }
      lookups.push((point) => {
        if (point > 0xffff) return 0;
        for (let segment = 0; segment < segments; segment += 1) {
          if (point > uint16(ends + segment * 2)) continue;
          const start = uint16(starts + segment * 2);
          if (point < start) return 0;
          const delta = uint16(deltas + segment * 2), rangeOffset = uint16(offsets + segment * 2);
          if (!rangeOffset) return (point + delta) & 0xffff;
          const glyph = uint16(offsets + segment * 2 + rangeOffset + (point - start) * 2);
          return glyph ? (glyph + delta) & 0xffff : 0;
        }
        return 0;
      });
    }
  }
  if (!lookups.length) invalid("Font lacks supported Unicode cmap formats 4/12");
  const points = [...new Set([...copy.replace(/\n/g, "")].map((char) => char.codePointAt(0)!))];
  for (const point of points) {
    const glyph = lookups.map((lookup) => lookup(point)).find((mapped) => mapped > 0 && mapped < glyphCount);
    if (!glyph) fail(`Pinned font lacks U+${point.toString(16).toUpperCase()}`, "LOCAL_COVER_FONT_GLYPH_MISSING");
  }
  return points;
}

function alphaBox(data: Buffer, width: number, height: number): { bbox: LocalCoverPixelBox; pixels: number } | null {
  let left = width, top = height, right = -1, bottom = -1, pixels = 0;
  for (let y = 0; y < height; y += 1) for (let x = 0; x < width; x += 1) {
    if (data[(y * width + x) * 4 + 3]! > 0) {
      left = Math.min(left, x); top = Math.min(top, y); right = Math.max(right, x); bottom = Math.max(bottom, y); pixels += 1;
    }
  }
  return pixels ? { bbox: { x: left, y: top, width: right - left + 1, height: bottom - top + 1 }, pixels } : null;
}

/** Purely local, bounded post-edit renderer. No model, provider, credentials, or network adapters are imported. */
export async function renderLocalCover(input: LocalCoverRenderInput): Promise<LocalCoverRenderResult> {
  const code = "LOCAL_COVER_INPUT_INVALID";
  if (!input || !input.source || !["image", "video-frame"].includes(input.source.kind)
    || typeof input.platform !== "string" || !input.platform.trim() || !isKnownCoverPlatform(input.platform)) fail("Unknown source kind or cover platform", code);
  const spec = getCoverSpec(input.platform), variant = input.variant ?? "warm-film", fontId = input.fontId ?? "source-han-heavy";
  if (!["warm-film", "punchy-social", "cool-tech"].includes(variant) || !Object.prototype.hasOwnProperty.call(COVER_FONTS, fontId)) fail("Unknown style or font ID", code);
  const { width, height } = input;
  if (![width, height].every((value) => Number.isSafeInteger(value) && value >= 96 && value <= 4096)
    || width * spec.canvas.height !== height * spec.canvas.width) fail("Dimensions must be integers 96..4096 matching the platform ratio", code);
  if (input.durationSeconds !== undefined && (!Number.isFinite(input.durationSeconds) || input.durationSeconds <= 0)) fail("Invalid film duration", code);
  if (input.footageOrigin !== undefined && !["generated", "live-action", "mixed"].includes(input.footageOrigin)) fail("Invalid footage origin", code);
  const copyIssues = validateCoverVisibleCopy({ headline: input.title, subline: input.subtitle }, {
    platform: spec.id, durationSeconds: input.durationSeconds, footageOrigin: input.footageOrigin
  });
  if (copyIssues.length) fail(copyIssues.join("; "), "LOCAL_COVER_COPY_INVALID");
  if ([...input.title].length > 128 || Buffer.byteLength(input.title, "utf8") > 1024
    || [...`${input.title}${input.subtitle ?? ""}`].some((char) => { const point = char.codePointAt(0)!; return point >= 0xd800 && point <= 0xdfff; })) {
    fail("Copy exceeds the local measurement bound or has an unpaired surrogate", "LOCAL_COVER_COPY_INVALID");
  }
  if (input.source.kind === "video-frame" && (!Number.isFinite(input.source.timeSec) || input.source.timeSec < 0)) fail("Invalid video frame time", "LOCAL_COVER_SOURCE_INVALID");
  if (typeof input.fontSha256 !== "string" || !/^[a-f0-9]{64}$/i.test(input.fontSha256)) fail("Expected pinned font SHA256", "LOCAL_COVER_FONT_INVALID");
  const timeout = input.timeoutMs ?? 120_000;
  if (!Number.isSafeInteger(timeout) || timeout < 1 || timeout > 600_000) fail("Invalid local render deadline", code);
  const deadline = Date.now() + timeout;
  const [source, font, encoder, prober] = await Promise.all([
    snapshot(input.source.path, input.source.kind === "image" ? 64 * 1024 * 1024 : 128 * 1024 * 1024, "LOCAL_COVER_SOURCE_INVALID"),
    snapshot(input.fontFile, 32 * 1024 * 1024, "LOCAL_COVER_FONT_INVALID"),
    snapshot(input.ffmpeg, 128 * 1024 * 1024, code), snapshot(input.ffprobe, 128 * 1024 * 1024, code)
  ]);
  if (font.sha256 !== input.fontSha256.toLowerCase()) fail("Font bytes do not match the supplied pin", "LOCAL_COVER_FONT_INVALID");
  const codePoints = checkGlyphs(font.data, `${input.title}${input.subtitle ?? ""}`);
  if (typeof input.out !== "string" || !isAbsolute(input.out) || input.out.includes("\0") || extname(input.out).toLowerCase() !== ".png") fail("Output must be an absolute PNG path", "LOCAL_COVER_OUTPUT_INVALID");
  let output: string;
  try {
    const requestedParent = dirname(resolve(input.out));
    const missingParents: string[] = [];
    let existingParent = requestedParent;
    while (true) {
      try {
        const info = await lstat(existingParent);
        if (!info.isDirectory() || info.isSymbolicLink() || await realpath(existingParent) !== existingParent) fail("Output directory must not have symlink ancestors", "LOCAL_COVER_OUTPUT_INVALID");
        break;
      } catch (error) {
        if (!absent(error)) throw error;
        missingParents.unshift(existingParent);
        existingParent = dirname(existingParent);
      }
    }
    for (const missingParent of missingParents) {
      try { await mkdir(missingParent); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
      const info = await lstat(missingParent);
      if (!info.isDirectory() || info.isSymbolicLink() || await realpath(missingParent) !== missingParent) fail("Output directory changed or has a symlink ancestor", "LOCAL_COVER_OUTPUT_INVALID");
    }
    const parent = await realpath(requestedParent);
    if (parent !== requestedParent) fail("Output directory changed", "LOCAL_COVER_OUTPUT_INVALID");
    output = join(parent, basename(input.out));
  } catch (error) {
    if (error instanceof LocalCoverRenderError) throw error;
    fail(`Cannot prepare output directory: ${(error as Error).message}`, "LOCAL_COVER_OUTPUT_INVALID");
  }
  const originals = [source, font, encoder, prober];
  if (originals.some((file) => file.path === output)) fail("Output aliases an input", "LOCAL_COVER_OUTPUT_INVALID");
  const currentTarget = async (): Promise<Snapshot | null> => {
    try { return await snapshot(output, 128 * 1024 * 1024, "LOCAL_COVER_OUTPUT_INVALID"); }
    catch (error) {
      try { await lstat(output); } catch (missing) { if (absent(missing)) return null; }
      throw error;
    }
  };
  const prior = await currentTarget();
  if (prior && originals.some((file) => file.dev === prior.dev && file.ino === prior.ino)) fail("Output hardlinks an input", "LOCAL_COVER_OUTPUT_INVALID");
  const lockPath = `${output}.local-cover.lock`, owner = randomUUID();
  let lock;
  try { lock = await open(lockPath, "wx", 0o600); }
  catch (error) { fail(`Output is busy or cannot be locked: ${(error as Error).message}`, "LOCAL_COVER_OUTPUT_BUSY"); }
  let lockStat: { dev: number; ino: number } | null = null;
  let lockReady = false;
  const ownsLock = async (): Promise<boolean> => {
    try {
      const info = await lstat(lockPath);
      return Boolean(lockStat && info.isFile() && !info.isSymbolicLink() && info.ino === lockStat.ino && info.dev === lockStat.dev
        && (!lockReady || (await readFile(lockPath, "utf8")) === owner));
    } catch (error) { if (absent(error)) return false; throw error; }
  };
  let scratch: string | undefined;
  let publication: LocalCoverRenderError["publication"];
  let primaryFailure: LocalCoverRenderError | undefined;
  const commands: LocalCoverRenderReceipt["commands"] = [];
  try {
    lockStat = await lock.stat();
    await lock.writeFile(owner);
    lockReady = true;
    scratch = await mkdtemp(join(dirname(output), ".local-cover-"));
    const execute = async (binary: "ffmpeg" | "ffprobe", args: string[]): Promise<Buffer> => {
      const remaining = deadline - Date.now();
      if (remaining < 1) fail("Local cover deadline expired", "LOCAL_COVER_PROCESS_FAILED");
      commands.push({ binary, argv: [...args] });
      return await new Promise<Buffer>((accept, reject) => {
        execFile(binary === "ffmpeg" ? encoder.path : prober.path, args, {
          cwd: scratch, encoding: "buffer", timeout: remaining, maxBuffer: 80 * 1024 * 1024,
          env: { PATH: dirname(encoder.path), LANG: "C", LC_ALL: "C", TMPDIR: scratch }
        }, (error, stdout, stderr) => {
          if (error) reject(new LocalCoverRenderError(`${binary} failed: ${stderr.toString().slice(-1600) || error.message}`, "LOCAL_COVER_PROCESS_FAILED"));
          else accept(stdout);
        });
      });
    };
    const probe = async (path: string, countFrames: boolean, formats = "png_pipe"): Promise<Probe> => {
      const result = await execute("ffprobe", ["-v", "error", ...localInput(formats), ...(countFrames ? ["-count_frames"] : []), "-show_streams", "-show_format", "-of", "json", path]);
      try {
        const parsed = JSON.parse(result.toString()) as Probe;
        if (!Array.isArray(parsed.streams) || !parsed.streams.length) throw new Error("Missing streams");
        return parsed;
      } catch (error) { fail(`Invalid media probe: ${(error as Error).message}`, "LOCAL_COVER_VERIFY_FAILED"); }
    };
    const decode = async (path: string, w: number, h: number): Promise<Buffer> => {
      const data = await execute("ffmpeg", ["-v", "error", "-xerror", "-nostdin", ...localInput("png_pipe"), "-i", path, "-map", "0:v:0", "-frames:v", "1", "-f", "rawvideo", "-pix_fmt", "rgba", "-"]);
      if (data.length !== w * h * 4) fail("Decoded image dimensions/bytes differ from the requested canvas", "LOCAL_COVER_VERIFY_FAILED");
      return data;
    };
    await Promise.all([writeFile(join(scratch, "source.media"), source.data), writeFile(join(scratch, "font.otf"), font.data)]);
    const sourceFormats = input.source.kind === "image" ? STILL_FORMATS : VIDEO_FORMATS;
    const sourceInfo = await probe("source.media", input.source.kind === "image", sourceFormats);
    const videos = sourceInfo.streams.filter((stream) => stream.codec_type === "video"), media = videos[0];
    if (videos.length !== 1 || !media || !Number.isSafeInteger(media.width) || !Number.isSafeInteger(media.height)
      || media.width! < 1 || media.height! < 1 || media.width! * media.height! > 16_777_216) fail("Source must have exactly one video/image stream within the pixel bound", "LOCAL_COVER_SOURCE_INVALID");
    if (input.source.kind === "image" && (!['png', 'mjpeg', 'webp', 'bmp', 'tiff'].includes(media.codec_name ?? "") || Number(media.nb_read_frames) !== 1)) fail("Image must decode to exactly one supported still frame", "LOCAL_COVER_SOURCE_INVALID");
    if (input.source.kind === "video-frame") {
      const duration = Number(media.duration ?? sourceInfo.format?.duration);
      if (!(duration > 0) || !Number.isFinite(duration) || input.source.timeSec >= duration) fail("Video frame time must precede finite source EOF", "LOCAL_COVER_SOURCE_INVALID");
    }
    await execute("ffmpeg", ["-v", "error", "-xerror", "-nostdin", "-y", ...localInput(sourceFormats), "-i", "source.media",
      ...(input.source.kind === "video-frame" ? ["-ss", String(input.source.timeSec)] : []), "-map", "0:v:0", "-frames:v", "1", "-an", "-c:v", "png", "-threads", "1", "frame.png"]);
    const frameInfo = await probe("frame.png", true), frame = frameInfo.streams[0];
    if (!frame || Number(frame.nb_read_frames) !== 1 || !frame.width || !frame.height || frame.width * frame.height > 16_777_216) fail("No bounded frame was extracted", "LOCAL_COVER_SOURCE_INVALID");
    const frameData = await readFile(join(scratch, "frame.png")), frameRgba = await decode("frame.png", frame.width, frame.height);
    const colors = {
      "warm-film": { title: "#161E25", accent: "#C39A58", scrim: "0xFFFAEF", opacity: 0.92 },
      "punchy-social": { title: "#FFFFFF", accent: "#FFCF40", scrim: "0x071118", opacity: 0.77 },
      "cool-tech": { title: "#FFFFFF", accent: "#59C5D3", scrim: "0x102333", opacity: 0.83 }
    }[variant];
    const style = buildVariantCoverFilters({ variantId: variant, accent: colors.accent, platform: spec.id, width, height });
    const safeBounds = { ...style.safeArea, titleBottom: Math.min(style.safeArea.bottom, Math.floor(height * spec.titleBand.bottomMaxRatio)) };
    const top = Math.max(safeBounds.top, Math.ceil(height * (spec.titleBand.topRatio + 0.015)));
    const bandEnd = Math.min(height, Math.ceil(height * (spec.titleBand.bottomMaxRatio + 0.08)));
    const scrimFilters: string[] = [];
    for (let step = 0; step < 40; step += 1) {
      const y = Math.floor(bandEnd * step / 40), next = Math.floor(bandEnd * (step + 1) / 40);
      scrimFilters.push(`drawbox=x=0:y=${y}:w=${width}:h=${next - y}:color=${colors.scrim}@${(colors.opacity * (1 - step / 39)).toFixed(4)}:t=fill`);
    }
    const backgroundFilters = [`scale=${width}:${height}:force_original_aspect_ratio=increase`, `crop=${width}:${height}:(iw-ow)/2:(ih-oh)*0.38`, "setsar=1", ...style.filters, ...scrimFilters];
    await execute("ffmpeg", ["-v", "error", "-xerror", "-nostdin", "-y", ...localInput("png_pipe"), "-i", "frame.png", "-vf", backgroundFilters.join(","), "-frames:v", "1", "-c:v", "png", "-threads", "1", "background.png"]);
    const lines: Array<{ field: "title" | "subtitle"; line: number; text: string }> = input.title.split("\n").map((text, line) => ({ field: "title", line, text }));
    if (input.subtitle?.trim()) lines.push({ field: "subtitle", line: 0, text: input.subtitle });
    for (let index = 0; index < lines.length; index += 1) await writeFile(join(scratch, `text-${index}.txt`), lines[index]!.text, "utf8");
    let fontSize = Math.max(8, Math.min(192, Math.round(Math.min(height * 0.074, width * 0.17))));
    const minimumSize = Math.max(6, Math.floor(Math.min(height * 0.031, width * 0.07)));
    let fitted: Array<{ file: string; box: LocalCoverPixelBox; size: number; pixels: number; field: "title" | "subtitle"; line: number; text: string }> | null = null;
    let fitAttempts = 0;
    while (fontSize >= minimumSize && fitAttempts < 12) {
      fitAttempts += 1;
      const measured = [];
      let totalHeight = 0, fits = true;
      for (let index = 0; index < lines.length; index += 1) {
        const line = lines[index]!, size = line.field === "title" ? fontSize : Math.max(6, Math.round(fontSize * 0.36));
        const pad = size * 2, mw = width + pad * 2, mh = size * 5;
        const file = `measure-${index}.png`;
        await execute("ffmpeg", ["-v", "error", "-xerror", "-nostdin", "-y", "-f", "lavfi", "-i", `color=c=black@0.0:s=${mw}x${mh}:r=1,format=rgba`,
          "-vf", `drawtext=fontfile=font.otf:textfile=text-${index}.txt:expansion=none:fontcolor=${colors.title.replace("#", "0x")}:fontsize=${size}:x=${pad}:y=${pad}`,
          "-frames:v", "1", "-c:v", "png", "-threads", "1", file]);
        const alpha = alphaBox(await decode(file, mw, mh), mw, mh);
        if (!alpha) fail("Text rendered no alpha pixels", "LOCAL_COVER_VERIFY_FAILED");
        const box = alpha.bbox;
        if (box.x < size || box.y < size || box.x + box.width > mw - size || box.y + box.height > mh - size
          || box.width > safeBounds.right - safeBounds.left) fits = false;
        if (index > 0) totalHeight += Math.round(fontSize * (line.field === "subtitle" ? 0.48 : 0.19));
        totalHeight += box.height;
        measured.push({ ...line, field: line.field as "title" | "subtitle", file, box, size, pixels: alpha.pixels });
      }
      if (fits && totalHeight <= safeBounds.titleBottom - top) { fitted = measured; break; }
      const next = Math.max(minimumSize, Math.floor(fontSize * 0.82));
      if (next === fontSize) break;
      fontSize = next;
    }
    if (!fitted) fail("Visible copy cannot fit inside the platform title/safe region", "LOCAL_COVER_TEXT_FIT_FAILED");
    const args = ["-v", "error", "-xerror", "-nostdin", "-y", ...localInput("png_pipe"), "-i", "background.png"];
    for (const line of fitted) args.push(...localInput("png_pipe"), "-i", line.file);
    const filters: string[] = [], text: LocalCoverTextReceipt[] = [];
    let cursor = top;
    for (let index = 0; index < fitted.length; index += 1) {
      const line = fitted[index]!;
      if (index > 0) cursor += Math.round(fontSize * (line.field === "subtitle" ? 0.48 : 0.19));
      filters.push(`[${index + 1}:v]format=rgba,crop=${line.box.width}:${line.box.height}:${line.box.x}:${line.box.y}[text${index}]`);
      filters.push(`[${index ? `out${index - 1}` : "0:v"}][text${index}]overlay=x=${safeBounds.left}:y=${cursor}:format=auto[out${index}]`);
      text.push({ field: line.field, line: line.line, text: line.text, textSha256: hash(line.text), fontSize: line.size,
        bbox: { x: safeBounds.left, y: cursor, width: line.box.width, height: line.box.height }, alphaPixelCount: line.pixels, changedPixelCount: 0, fitAttempts });
      cursor += line.box.height;
    }
    args.push("-filter_complex", filters.join(";"), "-map", `[out${fitted.length - 1}]`, "-frames:v", "1", "-c:v", "png", "-threads", "1", "cover.png");
    await execute("ffmpeg", args);
    const produced = await probe("cover.png", true).catch((error: unknown) => fail(`Rendered PNG probe failed: ${(error as Error).message}`, "LOCAL_COVER_VERIFY_FAILED"));
    const image = produced.streams[0];
    if (produced.streams.length !== 1 || image?.codec_name !== "png" || image.width !== width || image.height !== height || Number(image.nb_read_frames) !== 1) fail("Output is not one PNG frame at the exact target size", "LOCAL_COVER_VERIFY_FAILED");
    const rgba = await decode("cover.png", width, height), background = await decode("background.png", width, height);
    for (const line of text) {
      const box = line.bbox;
      if (box.x < safeBounds.left || box.y < safeBounds.top || box.x + box.width > safeBounds.right || box.y + box.height > safeBounds.titleBottom) fail("Measured text crosses platform bounds", "LOCAL_COVER_VERIFY_FAILED");
      for (let y = box.y; y < box.y + box.height; y += 1) for (let x = box.x; x < box.x + box.width; x += 1) {
        const offset = (y * width + x) * 4;
        if (rgba[offset] !== background[offset] || rgba[offset + 1] !== background[offset + 1] || rgba[offset + 2] !== background[offset + 2]) line.changedPixelCount += 1;
      }
      if (!line.changedPixelCount) fail("Text pixels are invisible in the composed cover", "LOCAL_COVER_VERIFY_FAILED");
    }
    const rechecked = await Promise.all(originals.map((file) => snapshot(file.path, 128 * 1024 * 1024, "LOCAL_COVER_INPUT_CHANGED")));
    if (rechecked.some((file, index) => !same(file, originals[index]!))) fail("Source, font or binary changed during rendering", "LOCAL_COVER_INPUT_CHANGED");
    if (!same(prior, await currentTarget()) || !await ownsLock()) fail("Output or writer lock changed during rendering", "LOCAL_COVER_OUTPUT_CHANGED");
    const pending = await snapshot(join(scratch, "cover.png"), 128 * 1024 * 1024, "LOCAL_COVER_VERIFY_FAILED");
    const recipeData = { platform: spec.id, variant, width, height, title: input.title, ...(input.subtitle !== undefined ? { subtitle: input.subtitle } : {}),
      titleColor: colors.title, accentColor: colors.accent, safeBounds, backgroundFilters };
    const recipeSha = hash(JSON.stringify({ ...recipeData, sourceSha256: source.sha256, fontSha256: font.sha256, text }));
    const receipt: LocalCoverRenderReceipt = {
      schemaVersion: "workloom.local-cover-render/v1", purpose: "existing-local-edit",
      source: { ...binding(source), kind: input.source.kind, ...(input.source.kind === "video-frame" ? { timeSec: input.source.timeSec } : {}), frameSha256: hash(frameData), frameRgbaSha256: hash(frameRgba) },
      font: { ...binding(font), id: fontId, glyphCoverageChecked: true, codePoints },
      recipe: { ...recipeData, sha256: recipeSha }, text,
      output: { path: output, sha256: pending.sha256, bytes: pending.bytes, width, height, rgbaSha256: hash(rgba) },
      binaries: { ffmpeg: binding(encoder), ffprobe: binding(prober) }, commands,
      checks: { currentInputs: true, exactDimensions: true, textInsideSafeBounds: true, textPixelsVisible: true, singlePngFrame: true },
      limits: ["Local file/frame and glyph/pixel checks only; no person identity or model review is certified.", "Output uses a fixed crop; an operator must inspect whether the chosen product remains visible."]
    };
    publication = { state: "unknown", renameCompleted: false, expectedOutput: receipt.output };
    await rename(pending.path, output);
    publication = { ...publication, state: "published", renameCompleted: true };
    const published = await snapshot(output, 128 * 1024 * 1024, "LOCAL_COVER_OUTPUT_CHANGED");
    if (published.sha256 !== pending.sha256 || published.ino !== pending.ino || published.dev !== pending.dev) fail("Published output changed before receipt readback", "LOCAL_COVER_OUTPUT_CHANGED");
    return { path: output, width, height, sha256: pending.sha256, receipt };
  } catch (error) {
    primaryFailure = error instanceof LocalCoverRenderError ? error
      : new LocalCoverRenderError(`Local cover operation failed: ${(error as Error).message}`, "LOCAL_COVER_PROCESS_FAILED");
    if (publication) primaryFailure.publication = publication;
    throw primaryFailure;
  } finally {
    const cleanupErrors: string[] = [];
    if (scratch) {
      try { await rm(scratch, { recursive: true, force: true }); }
      catch (error) { cleanupErrors.push(`scratch: ${(error as Error).message}`); }
    }
    try { await lock.close(); }
    catch (error) { cleanupErrors.push(`lock handle: ${(error as Error).message}`); }
    try { if (await ownsLock()) await rm(lockPath); }
    catch (error) { cleanupErrors.push(`owned lock: ${(error as Error).message}`); }
    if (cleanupErrors.length) {
      const error = new LocalCoverRenderError(`Local cover cleanup failed: ${cleanupErrors.join("; ")}${primaryFailure ? `; original ${primaryFailure.code}: ${primaryFailure.message}` : ""}`, "LOCAL_COVER_PROCESS_FAILED");
      if (publication) error.publication = publication;
      throw error;
    }
  }
}
