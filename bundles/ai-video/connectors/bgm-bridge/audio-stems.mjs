/**
 * Independent audio sources for delivery and revision.
 *
 * This renderer never extracts a supposed clean stem from a mixed video. Every
 * ready source is an audio-only file bound to a host-verified receipt. Explicit
 * not-applicable decisions also need that authority. The host verifies receipt
 * authenticity; this module verifies exact bytes, placement, and derivation.
 */
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runBin, resolveBinaries, sha256File } from "../subtitle-bridge/measure.mjs";

export const AUDIO_STEM_SCHEMA = "workloom.audio-stems/v1";
export const AUDIO_STEM_ROLES = Object.freeze(["dialogue", "ambience", "foley", "music"]);
export const AUDIO_STEM_SAMPLE_RATE = 48_000;
const PROGRAM_ROLES = Object.freeze(["dialogue", "ambience", "foley"]);
const SHA256 = /^[a-f0-9]{64}$/;
const MAX_SOURCE_BYTES = 512 * 1024 * 1024;
const MAX_TOTAL_SOURCE_BYTES = 4 * 1024 * 1024 * 1024;
const SOURCE_KINDS = {
  dialogue: new Set(["tts", "isolated_recording"]),
  ambience: new Set(["synthesized_ambience", "isolated_recording"]),
  foley: new Set(["synthesized_foley", "isolated_recording"]),
  music: new Set(["composed_music", "licensed_music", "isolated_recording"]),
};

export class AudioStemError extends Error {
  constructor(message, code = "audio_stems_invalid", cause) {
    super(message, cause ? { cause } : undefined);
    this.name = "AudioStemError";
    this.code = code;
    this.retryable = false;
  }
}

function fail(message, code = "audio_stems_invalid") { throw new AudioStemError(message, code); }
function record(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) fail(`${label} 必须是对象`);
  return value;
}
function text(value, label) {
  if (typeof value !== "string" || !value.trim() || value.length > 4000) fail(`${label} 缺失或过长`);
  return value.trim();
}
function hash(value, label) {
  if (typeof value !== "string" || !SHA256.test(value)) fail(`${label} 必须是完整 SHA256`);
  return value;
}
function finite(value, label, { min = 0, max = 7200 } = {}) {
  if (typeof value !== "number" || !Number.isFinite(value) || value < min || value > max) fail(`${label} 越界`);
  return value;
}
function stable(value, depth = 0) {
  if (depth > 32) fail("回执/配方嵌套过深");
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (Array.isArray(value)) return value.map((entry) => stable(entry, depth + 1));
  record(value, "回执/配方");
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stable(value[key], depth + 1)]));
}
export function audioStemDigest(value) {
  return createHash("sha256").update(JSON.stringify(stable(value))).digest("hex");
}
function freeze(value) {
  if (value && typeof value === "object") {
    for (const item of Object.values(value)) freeze(item);
    Object.freeze(value);
  }
  return value;
}
function sampleCount(seconds, label) {
  const samples = Math.round(finite(seconds, label) * AUDIO_STEM_SAMPLE_RATE);
  if (!Number.isSafeInteger(samples)) fail(`${label} 样点数越界`);
  return samples;
}
function scopeOf(value) {
  const scope = record(value, "scope");
  if (!Number.isSafeInteger(scope.revision) || scope.revision < 1) fail("scope.revision 必须是正整数");
  return {
    tenantId: text(scope.tenantId, "scope.tenantId"), workspaceId: text(scope.workspaceId, "scope.workspaceId"),
    projectId: text(scope.projectId, "scope.projectId"), revision: scope.revision,
  };
}

/** The same hard/fade/xfade durations as post-bridge's video assembly, in samples. */
export function buildAudioStemTimeline({ shots, transitions = {} }) {
  if (!Array.isArray(shots) || !shots.length || shots.length > 256) fail("分轨需要 1–256 个已归一化镜头");
  record(transitions, "transitions");
  const mode = transitions.mode ?? "hard";
  if (!["hard", "fade", "xfade"].includes(mode)) fail("音轨转场必须为 hard、fade 或 xfade");
  const fadeSec = Math.max(0.05, finite(transitions.fadeSec ?? 0.5, "fadeSec", { max: 30 }));
  const ids = new Set();
  const entries = shots.map((shot) => {
    record(shot, "shot");
    const shotId = text(shot.shotId, "shotId");
    if (ids.has(shotId)) fail(`镜头重复：${shotId}`);
    ids.add(shotId);
    const samples = sampleCount(shot.durationSec, `${shotId}.durationSec`);
    if (samples < 1) fail(`镜头时长必须为正：${shotId}`);
    const sourceSamples = sampleCount(shot.sourceDurationSec ?? shot.durationSec, `${shotId}.sourceDurationSec`);
    if (sourceSamples < 1 || Math.abs(sourceSamples - samples) > 1920) fail("归一化前后画面时长差超过 40ms，音轨不能隐式变速", "audio_stems_alignment_failed");
    return { shotId, videoSha256: hash(shot.videoSha256, `${shotId}.videoSha256`), samples, sourceSamples,
      normalisedVideoSha256: shot.normalisedVideoSha256 == null ? null : hash(shot.normalisedVideoSha256, `${shotId}.normalisedVideoSha256`),
      durationSec: samples / AUDIO_STEM_SAMPLE_RATE, startSample: 0, fadeSamples: 0, overlapAfterSamples: 0 };
  });
  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index];
    if (mode === "fade" && entries.length > 1) {
      entry.fadeSamples = sampleCount(Math.min(fadeSec, Math.max(0.05, entry.durationSec / 3)), "fade");
      if (entry.fadeSamples * 2 > entry.samples) fail("镜头过短，无法按视频转场计划淡入淡出");
    }
    const next = entries[index + 1];
    if (next && mode === "xfade") {
      entry.overlapAfterSamples = sampleCount(Math.min(fadeSec, Math.max(0.05, Math.min(entry.durationSec, next.durationSec) / 2)), "overlap");
      if (entry.overlapAfterSamples >= Math.min(entry.samples, next.samples)) fail("交叉转场必须短于相邻镜头");
    }
    if (next) next.startSample = entry.startSample + entry.samples - entry.overlapAfterSamples;
  }
  const last = entries.at(-1);
  const samples = last.startSample + last.samples;
  if (samples > 7200 * AUDIO_STEM_SAMPLE_RATE) fail("分轨时间线超过 2 小时上限");
  return { sampleRate: AUDIO_STEM_SAMPLE_RATE, channels: 2, mode, fadeSec, samples,
    durationSec: samples / AUDIO_STEM_SAMPLE_RATE, shots: entries };
}

function allowedRootsOf(roots) {
  if (!Array.isArray(roots) || !roots.length) fail("分轨需要明确的 allowedRoots", "path_not_allowed");
  return roots.map((root) => {
    const lexical = path.resolve(text(root, "allowedRoot"));
    const real = fs.realpathSync(lexical);
    if (!fs.statSync(real).isDirectory()) fail("allowedRoot 不是目录", "path_not_allowed");
    return { lexical, real };
  });
}
function isInside(root, file) {
  const relative = path.relative(root, file);
  return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}
function guardedPath(file, roots, { missing = false } = {}) {
  const absolute = path.resolve(text(file, "path"));
  const root = roots.find((entry) => isInside(entry.lexical, absolute) || isInside(entry.real, absolute));
  if (!root) fail("音轨路径不在允许的资产根内", "path_not_allowed");
  const base = isInside(root.lexical, absolute) ? root.lexical : root.real;
  const relative = path.relative(base, absolute);
  let current = root.real;
  for (const part of relative.split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    let stat;
    try { stat = fs.lstatSync(current); }
    catch (error) { if (missing && error.code === "ENOENT") continue; throw error; }
    if (stat.isSymbolicLink()) fail("音轨路径不允许符号链接", "path_not_allowed");
  }
  return current;
}

/** Copy from the same opened inode that is hashed. Media engines only see this snapshot. */
async function snapshotSource(file, expectedSha256, target, roots, maxBytes = MAX_SOURCE_BYTES) {
  const source = guardedPath(file, roots);
  const handle = await fsp.open(source, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  let output;
  try {
    const before = await handle.stat();
    if (!before.isFile() || before.size <= 0 || before.size > maxBytes) fail("媒体文件为空、非普通文件或超过允许大小");
    output = await fsp.open(target, "wx", 0o600);
    const digest = createHash("sha256");
    const buffer = Buffer.allocUnsafe(1024 * 1024);
    let length = 0;
    for (;;) {
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
      if (!bytesRead) break;
      length += bytesRead;
      if (length > maxBytes) fail("音轨读取期间超过大小上限", "audio_stems_stale");
      digest.update(buffer.subarray(0, bytesRead));
      let written = 0;
      while (written < bytesRead) {
        const result = await output.write(buffer, written, bytesRead - written);
        if (!result.bytesWritten) fail("音轨快照写入没有进展", "audio_stems_io_failed");
        written += result.bytesWritten;
      }
    }
    const after = await handle.stat();
    const current = await fsp.lstat(source);
    const actualSha256 = digest.digest("hex");
    if (length !== before.size || before.size !== after.size || before.mtimeMs !== after.mtimeMs
      || before.ctimeMs !== after.ctimeMs || current.isSymbolicLink() || current.ino !== before.ino || current.dev !== before.dev
      || actualSha256 !== expectedSha256) fail("音轨源字节与权威回执不一致或读取期间变化", "audio_stems_stale");
    await output.sync();
    return { path: target, sha256: actualSha256, bytes: length };
  } finally {
    try { if (output) await output.close(); } finally { await handle.close(); }
  }
}

async function probeAudio(file, bins, { videoAllowed = false } = {}) {
  const { stdout } = await runBin(bins.ffprobe, ["-v", "error", "-show_streams", "-show_format", "-of", "json", file], { label: "ffprobe(stems)" });
  let doc;
  try { doc = JSON.parse(stdout); } catch (error) { throw new AudioStemError("分轨媒体探测返回无效 JSON", "bad_media", error); }
  const streams = Array.isArray(doc?.streams) ? doc.streams : [];
  const audio = streams.filter((stream) => stream.codec_type === "audio");
  if (audio.length !== 1 || (!videoAllowed && streams.some((stream) => stream.codec_type === "video"))) {
    fail("独立分轨必须是单一音频流文件；禁止从含画面的混合片提取", "audio_stems_source_unverified");
  }
  const stream = audio[0];
  const durationSec = Number(stream.duration ?? doc.format?.duration);
  const channels = Number(stream.channels);
  const sampleRate = Number(stream.sample_rate);
  if (!(durationSec > 0) || !Number.isFinite(durationSec) || ![1, 2].includes(channels) || !(sampleRate > 0)) fail("音轨时长、声道或采样率无效", "bad_media");
  return { durationSec, channels, sampleRate, samples: Math.round(durationSec * sampleRate) };
}
async function exactAudio(file, expectedSamples, bins) {
  const media = await probeAudio(file, bins);
  if (media.sampleRate !== AUDIO_STEM_SAMPLE_RATE || media.channels !== 2 || media.samples !== expectedSamples) {
    fail(`音轨样点数或规格不符：${media.samples}，期望 ${expectedSamples}`, "audio_stems_alignment_failed");
  }
  return { path: file, sha256: await sha256File(file), bytes: (await fsp.stat(file)).size,
    samples: media.samples, sampleRate: media.sampleRate, channels: media.channels, durationSec: expectedSamples / AUDIO_STEM_SAMPLE_RATE };
}

function sourceBinding(scope, shot, role, descriptor) {
  record(descriptor, `${shot.shotId}.${role}`);
  const common = { schemaVersion: AUDIO_STEM_SCHEMA, scope, shotId: shot.shotId,
    videoSha256: shot.videoSha256, shotSamples: shot.sourceSamples ?? shot.samples, sampleRate: AUDIO_STEM_SAMPLE_RATE, role };
  if (descriptor.status === "not_applicable") {
    if (descriptor.path != null || descriptor.sha256 != null || descriptor.sourceKind != null) fail("不适用的音轨不能同时携带媒体源");
    return { ...common, status: "not_applicable", reason: text(descriptor.reason, `${role}.reason`) };
  }
  if (descriptor.status !== "ready") fail(`${role} 缺独立来源，unknown/embedded 不能声明为干净轨`, "audio_stems_source_unverified");
  if (!SOURCE_KINDS[role].has(descriptor.sourceKind)) fail(`${role} 的来源不是已支持的独立音轨`, "audio_stems_source_unverified");
  const offsetSamples = sampleCount(descriptor.offsetSec ?? 0, `${role}.offsetSec`);
  const inSamples = sampleCount(descriptor.inSec ?? 0, `${role}.inSec`);
  const takeSamples = descriptor.durationSec == null ? null : sampleCount(descriptor.durationSec, `${role}.durationSec`);
  if (offsetSamples >= shot.samples || (takeSamples !== null && (takeSamples < 1 || takeSamples + offsetSamples > shot.samples))) fail(`${role} 放置超出镜头时间线`);
  return { ...common, status: "ready", sourceKind: descriptor.sourceKind,
    sourceSha256: hash(descriptor.sha256, `${role}.sha256`), offsetSamples, inSamples, takeSamples };
}

/** Canonical source bindings for an internal authority. This does not issue or approve receipts. */
export function describeAudioStemSources({ scope, shots, transitions = {} }) {
  const identity = scopeOf(scope);
  const timeline = buildAudioStemTimeline({ shots, transitions });
  return timeline.shots.flatMap((shot, index) => AUDIO_STEM_ROLES.map((role) => {
    const binding = sourceBinding(identity, shot, role, shots[index].stems?.[role]);
    return { binding, bindingSha256: audioStemDigest(binding) };
  }));
}

async function authorizedSources({ scope, shots, timeline, verifySource }) {
  if (typeof verifySource !== "function") fail("缺少宿主权威音轨回执验证器", "audio_stems_source_unverified");
  const sources = [];
  const rolesByHash = new Map();
  for (const [index, shot] of timeline.shots.entries()) {
    const descriptors = record(shots[index].stems, `${shot.shotId}.stems`);
    if (Object.keys(descriptors).some((role) => !AUDIO_STEM_ROLES.includes(role))) fail("音轨包含未知角色");
    for (const role of AUDIO_STEM_ROLES) {
      const descriptor = descriptors[role];
      const binding = freeze(sourceBinding(scope, shot, role, descriptor));
      const sourcePath = descriptor.path ?? null;
      const receipt = freeze(stable(record(descriptor.receipt, `${role}.receipt`)));
      if (Buffer.byteLength(JSON.stringify(receipt)) > 32768) fail("音轨来源回执超过 32 KiB");
      const bindingSha256 = audioStemDigest(binding);
      const receiptSha256 = audioStemDigest(receipt);
      let result;
      try { result = await verifySource({ binding, bindingSha256, receipt, receiptSha256 }); }
      catch (error) { throw new AudioStemError("宿主未能核实音轨来源回执", "audio_stems_source_unverified", error); }
      if (result?.status !== "passed" || result.bindingSha256 !== bindingSha256 || result.receiptSha256 !== receiptSha256) {
        fail("音轨来源回执未绑定本次项目、镜头、角色、字节和放置", "audio_stems_source_unverified");
      }
      if (binding.status === "ready") {
        text(descriptor.path, `${role}.path`);
        const previous = rolesByHash.get(binding.sourceSha256);
        if (previous && previous !== role) fail("同一媒体字节不能冒充不同角色的独立分轨", "audio_stems_source_unverified");
        rolesByHash.set(binding.sourceSha256, role);
      }
      sources.push({ binding, bindingSha256, receipt, receiptSha256, sourcePath, shotIndex: index });
    }
  }
  return sources;
}

async function toolchainOf(bins) {
  const versions = await Promise.all([bins.ffmpeg, bins.ffprobe].map(async (bin) => {
    const result = await runBin(bin, ["-version"], { label: "audio-stems(tool-version)", timeoutMs: 20000 });
    const version = (result.stdout || result.stderr).split("\n").slice(0, 3).join("\n").trim();
    if (!version) fail("媒体工具未返回版本", "audio_stems_source_unverified");
    return version;
  }));
  return { rendererSha256: await sha256File(fileURLToPath(import.meta.url)), ffmpeg: versions[0], ffprobe: versions[1] };
}

async function renderSegment({ source, shot, output, bins }) {
  const args = ["-hide_banner", "-v", "error", "-n"];
  let filter;
  if (source.binding.status === "not_applicable") {
    args.push("-f", "lavfi", "-i", "anullsrc=r=48000:cl=stereo");
    filter = `atrim=end_sample=${shot.samples},asetpts=N/SR/TB`;
  } else {
    args.push("-i", source.snapshot.path);
    const availableSamples = Math.round(source.media.durationSec * AUDIO_STEM_SAMPLE_RATE);
    const { inSamples, offsetSamples } = source.binding;
    const takeSamples = source.binding.takeSamples ?? (availableSamples - inSamples);
    if (takeSamples < 1 || inSamples + takeSamples > availableSamples + 1 || offsetSamples + takeSamples > shot.samples + 1) {
      fail(`${shot.shotId}/${source.binding.role} 音轨越界；不隐式裁切或变速`, "audio_stems_alignment_failed");
    }
    source.placement = { inSamples, offsetSamples, takeSamples };
    filter = `aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo,atrim=start_sample=${inSamples}:end_sample=${inSamples + takeSamples},asetpts=N/SR/TB,adelay=delays=${offsetSamples}S:all=1,apad=whole_len=${shot.samples},atrim=end_sample=${shot.samples}`;
  }
  if (shot.fadeSamples) filter += `,afade=t=in:ss=0:ns=${shot.fadeSamples},afade=t=out:ss=${shot.samples - shot.fadeSamples}:ns=${shot.fadeSamples}`;
  args.push("-af", filter, "-map", "0:a:0", "-ar", "48000", "-ac", "2", "-c:a", "pcm_f32le", output);
  await runBin(bins.ffmpeg, args, { label: "ffmpeg(independent-stem)", timeoutMs: 900000 });
  return exactAudio(output, shot.samples, bins);
}

async function combineRole({ files, timeline, output, bins }) {
  const args = ["-hide_banner", "-v", "error", "-n"];
  for (const file of files) args.push("-i", file.path);
  const chains = files.map((_, index) => `[${index}:a]asetpts=N/SR/TB[a${index}]`);
  let last = "[a0]";
  if (timeline.mode === "xfade") {
    for (let index = 1; index < files.length; index += 1) {
      const next = `[joined${index}]`;
      chains.push(`${last}[a${index}]acrossfade=ns=${timeline.shots[index - 1].overlapAfterSamples}:c1=tri:c2=tri${next}`);
      last = next;
    }
  } else if (files.length > 1) {
    chains.push(`${files.map((_, index) => `[a${index}]`).join("")}concat=n=${files.length}:v=0:a=1[joined]`);
    last = "[joined]";
  }
  chains.push(`${last}apad=whole_len=${timeline.samples},atrim=end_sample=${timeline.samples},asetpts=N/SR/TB[out]`);
  args.push("-filter_complex", chains.join(";"), "-map", "[out]", "-ar", "48000", "-ac", "2", "-c:a", "pcm_f32le", output);
  await runBin(bins.ffmpeg, args, { label: "ffmpeg(stem-timeline)", timeoutMs: 1800000 });
  return exactAudio(output, timeline.samples, bins);
}

async function writeJsonExclusive(file, data) {
  const handle = await fsp.open(file, "wx", 0o600);
  try { await handle.writeFile(`${JSON.stringify(data, null, 2)}\n`); await handle.sync(); }
  finally { await handle.close(); }
}
function relativeArtifact(root, artifact) { return { ...artifact, path: path.relative(root, artifact.path) }; }
function stableError(error) {
  if (error instanceof AudioStemError) return error;
  return new AudioStemError(error instanceof Error ? error.message : String(error),
    ["ENOENT", "EACCES", "EPERM", "EIO", "ENOSPC"].includes(error?.code) ? "audio_stems_io_failed" : error?.code ?? "audio_stems_failed", error);
}

/**
 * All four roles are required, including explicit N/A with an authority receipt.
 * A single aligned segment uses the same contract as a shot list. Source timing
 * is explicit (inSec/durationSec/offsetSec); this renderer never changes speed.
 * outDir must be new. Success is the final manifest, never file existence alone.
 */
export async function renderAudioStems({ scope, shots, transitions = {}, outDir, allowedRoots, verifySource, bins = resolveBinaries() }) {
  let target = null;
  let created = false;
  let runId = null;
  try {
    const identity = scopeOf(scope);
    const timeline = buildAudioStemTimeline({ shots, transitions });
    const roots = allowedRootsOf(allowedRoots);
    target = guardedPath(outDir, roots, { missing: true });
    const sources = await authorizedSources({ scope: identity, shots, timeline, verifySource });
    const toolchain = await toolchainOf(bins);
    // Parent creation is allowed only inside a guarded asset root; the final
    // directory itself is an exclusive claim, including between processes.
    await fsp.mkdir(path.dirname(target), { recursive: true });
    guardedPath(path.dirname(target), roots);
    try { await fsp.mkdir(target, { recursive: false, mode: 0o700 }); }
    catch (error) { if (error.code === "EEXIST") fail("音轨输出目录已被认领，不能覆盖", "audio_stems_busy"); throw error; }
    created = true;
    runId = randomUUID();
    await writeJsonExclusive(path.join(target, "claim.json"), { schemaVersion: AUDIO_STEM_SCHEMA, runId, scope: identity });
    await fsp.mkdir(path.join(target, "sources"));
    await fsp.mkdir(path.join(target, "segments"));
    const snapshots = new Map();
    let sourceBytes = 0;
    for (const source of sources) {
      if (source.binding.status !== "ready") continue;
      const sourceHash = source.binding.sourceSha256;
      if (!snapshots.has(sourceHash)) {
        const output = path.join(target, "sources", sourceHash);
        const snapshot = await snapshotSource(source.sourcePath, sourceHash, output, roots);
        sourceBytes += snapshot.bytes;
        if (sourceBytes > MAX_TOTAL_SOURCE_BYTES) fail("本次独立音轨超过 4 GiB 上限");
        snapshots.set(sourceHash, { snapshot, media: await probeAudio(output, bins) });
      } else {
        // A second path claiming identical content still has to match its
        // receipt. Never ignore a changed source merely because its hash exists.
        const duplicate = path.join(target, "sources", `check-${randomUUID()}`);
        await snapshotSource(source.sourcePath, sourceHash, duplicate, roots);
        await fsp.unlink(duplicate);
      }
      Object.assign(source, snapshots.get(sourceHash));
    }
    const roles = {};
    for (const role of AUDIO_STEM_ROLES) {
      const parts = [];
      const roleSources = sources.filter((source) => source.binding.role === role);
      for (const source of roleSources) {
        source.segment = await renderSegment({ source, shot: timeline.shots[source.shotIndex], bins,
          output: path.join(target, "segments", `${source.shotIndex}-${role}.wav`) });
        parts.push(source.segment);
      }
      const artifact = await combineRole({ files: parts, timeline, output: path.join(target, `${role}.wav`), bins });
      roles[role] = { ...artifact, status: roleSources.every((source) => source.binding.status === "not_applicable") ? "not_applicable" : "ready" };
    }
    const programPath = path.join(target, "program.wav");
    await runBin(bins.ffmpeg, ["-hide_banner", "-v", "error", "-n",
      ...PROGRAM_ROLES.flatMap((role) => ["-i", roles[role].path]),
      "-filter_complex", `[0:a][1:a][2:a]amix=inputs=3:duration=first:dropout_transition=0:normalize=0,atrim=end_sample=${timeline.samples},asetpts=N/SR/TB[out]`,
      "-map", "[out]", "-ar", "48000", "-ac", "2", "-c:a", "pcm_f32le", programPath,
    ], { label: "ffmpeg(clean-program-without-music)", timeoutMs: 1800000 });
    const program = await exactAudio(programPath, timeline.samples, bins);
    const recipe = {
      schemaVersion: AUDIO_STEM_SCHEMA, scope: identity, timeline, toolchain,
      programRoles: PROGRAM_ROLES, musicExcludedFromProgram: true, speedChange: false,
      sources: sources.map(({ binding, bindingSha256, receiptSha256, placement }) => ({ binding, bindingSha256, receiptSha256, placement: placement ?? null })),
    };
    const manifest = {
      schemaVersion: AUDIO_STEM_SCHEMA, runId, status: "ready", createdAt: new Date().toISOString(),
      recipe, recipeSha256: audioStemDigest(recipe),
      roles: Object.fromEntries(Object.entries(roles).map(([role, artifact]) => [role, relativeArtifact(target, artifact)])),
      program: relativeArtifact(target, program),
      sources: sources.map(({ binding, bindingSha256, receipt, receiptSha256, snapshot, segment, placement }) => ({
        binding, bindingSha256, receipt, receiptSha256, snapshot: snapshot ? relativeArtifact(target, snapshot) : null,
        segment: relativeArtifact(target, segment), placement: placement ?? null,
      })),
      checks: { sourceAuthority: "passed", sourceBytes: "passed", sampleAlignment: "passed", programExcludesMusic: "passed" },
    };
    // A long render must not publish a grant that expired while FFmpeg ran.
    for (const { binding, bindingSha256, receipt, receiptSha256 } of sources) {
      let result;
      try { result = await verifySource({ binding, bindingSha256, receipt, receiptSha256 }); }
      catch (error) { throw new AudioStemError("发布前音轨来源资格已失效", "audio_stems_source_unverified", error); }
      if (result?.status !== "passed" || result.bindingSha256 !== bindingSha256 || result.receiptSha256 !== receiptSha256) {
        fail("发布前音轨来源资格未通过复核", "audio_stems_source_unverified");
      }
    }
    await writeJsonExclusive(path.join(target, "audio-stems.json"), manifest);
    return { ...manifest, dir: target, manifestPath: path.join(target, "audio-stems.json"),
      roles, program, recipeSha256: manifest.recipeSha256, manifestSha256: await sha256File(path.join(target, "audio-stems.json")) };
  } catch (error) {
    const failure = stableError(error);
    if (created) {
      try { await writeJsonExclusive(path.join(target, "failed.json"), { schemaVersion: AUDIO_STEM_SCHEMA, runId, status: "failed", code: failure.code, message: failure.message }); }
      catch (recordError) { throw new AudioStemError(`音轨失败且失败回执无法写入：${recordError.message}；原错误：${failure.message}`, "audio_stems_io_failed", failure); }
    }
    throw failure;
  }
}

/**
 * Reopen a frozen bundle against the exact digest pinned by its owning project.
 * Every retained source, segment, role and program is rehashed from the same FD
 * snapshot that is probed. All original signed bindings are reauthorized now;
 * an expired receipt remains auditable but cannot authorize a new use.
 */
export async function verifyAudioStemBundle({ dir, expectedManifestSha256, expectedRecipeSha256,
  scope, verifySource, allowedRoots, bins = resolveBinaries() }) {
  let temporary;
  try {
    hash(expectedManifestSha256, "expectedManifestSha256");
    hash(expectedRecipeSha256, "expectedRecipeSha256");
    const identity = scopeOf(scope);
    const roots = allowedRootsOf(allowedRoots);
    const target = guardedPath(dir, roots);
    if (!fs.statSync(target).isDirectory()) fail("音轨缓存根不是目录", "audio_stems_stale");
    temporary = await fsp.mkdtemp(path.join(target, ".verify-"));
    const manifestPath = path.join(target, "audio-stems.json");
    await snapshotSource(manifestPath, expectedManifestSha256, path.join(temporary, "manifest"), roots, 4 * 1024 * 1024);
    let manifest;
    try { manifest = JSON.parse(await fsp.readFile(path.join(temporary, "manifest"), "utf8")); }
    catch (error) { throw new AudioStemError("音轨缓存清单无法解析", "audio_stems_stale", error); }
    const recipe = record(manifest?.recipe, "recipe");
    if (manifest.schemaVersion !== AUDIO_STEM_SCHEMA || manifest.status !== "ready"
      || recipe.schemaVersion !== AUDIO_STEM_SCHEMA || manifest.recipeSha256 !== expectedRecipeSha256
      || audioStemDigest(recipe) !== expectedRecipeSha256 || audioStemDigest(recipe.scope) !== audioStemDigest(identity)
      || audioStemDigest(recipe.programRoles) !== audioStemDigest(PROGRAM_ROLES)
      || recipe.musicExcludedFromProgram !== true || recipe.speedChange !== false
      || audioStemDigest(recipe.toolchain) !== audioStemDigest(await toolchainOf(bins))) {
      fail("音轨缓存清单、作用域、配方或工具指纹与工程快照不一致", "audio_stems_stale");
    }
    const priorTimeline = record(recipe.timeline, "timeline");
    const shots = priorTimeline.shots?.map((shot) => ({ shotId: shot.shotId, videoSha256: shot.videoSha256,
      normalisedVideoSha256: shot.normalisedVideoSha256, sourceDurationSec: shot.sourceSamples / AUDIO_STEM_SAMPLE_RATE,
      durationSec: shot.samples / AUDIO_STEM_SAMPLE_RATE, stems: {} }));
    const timeline = buildAudioStemTimeline({ shots, transitions: { mode: priorTimeline.mode, fadeSec: priorTimeline.fadeSec } });
    if (audioStemDigest(priorTimeline) !== audioStemDigest(timeline)
      || !Array.isArray(manifest.sources) || manifest.sources.length !== shots.length * AUDIO_STEM_ROLES.length) {
      fail("音轨缓存时间线或来源个数不一致", "audio_stems_stale");
    }
    const safeArtifact = (artifact, expectedPath) => {
      record(artifact, "artifact");
      if (artifact.path !== expectedPath || !Number.isSafeInteger(artifact.bytes) || artifact.bytes < 1) fail("音轨缓存产物路径或字节数非法", "audio_stems_stale");
      hash(artifact.sha256, "artifact.sha256");
      return guardedPath(path.join(target, expectedPath), roots);
    };
    const artifacts = new Map();
    const verifyArtifact = async (artifact, expectedPath, samples = null) => {
      const file = safeArtifact(artifact, expectedPath);
      const prior = artifacts.get(file);
      if (prior) {
        if (prior.sha256 !== artifact.sha256 || prior.bytes !== artifact.bytes) fail("缓存的同一路径声明不同字节", "audio_stems_stale");
        return { ...artifact, path: file };
      }
      const copied = await snapshotSource(file, artifact.sha256, path.join(temporary, `media-${artifacts.size}`), roots, MAX_TOTAL_SOURCE_BYTES);
      if (copied.bytes !== artifact.bytes) fail("音轨缓存字节数与清单不一致", "audio_stems_stale");
      if (samples !== null) await exactAudio(copied.path, samples, bins);
      else await probeAudio(copied.path, bins);
      artifacts.set(file, copied);
      return { ...artifact, path: file };
    };
    for (const [index, source] of manifest.sources.entries()) {
      record(source, "source");
      const shotIndex = Math.floor(index / AUDIO_STEM_ROLES.length);
      const role = AUDIO_STEM_ROLES[index % AUDIO_STEM_ROLES.length];
      const binding = record(source.binding, "binding");
      if (binding.role !== role || binding.shotId !== shots[shotIndex].shotId
        || audioStemDigest(binding) !== source.bindingSha256 || audioStemDigest(source.receipt) !== source.receiptSha256) {
        fail("音轨缓存签章绑定顺序或摘要不一致", "audio_stems_stale");
      }
      const descriptor = binding.status === "ready" ? {
        status: "ready", sourceKind: binding.sourceKind, sha256: binding.sourceSha256,
        offsetSec: binding.offsetSamples / AUDIO_STEM_SAMPLE_RATE, inSec: binding.inSamples / AUDIO_STEM_SAMPLE_RATE,
        ...(binding.takeSamples === null ? {} : { durationSec: binding.takeSamples / AUDIO_STEM_SAMPLE_RATE }),
        path: safeArtifact(source.snapshot, `sources/${binding.sourceSha256}`), receipt: source.receipt,
      } : { status: binding.status, reason: binding.reason, receipt: source.receipt };
      shots[shotIndex].stems[role] = descriptor;
      if (binding.status === "ready") {
        if (source.snapshot.sha256 !== binding.sourceSha256) fail("音轨缓存源字节未绑定签章", "audio_stems_stale");
        await verifyArtifact(source.snapshot, `sources/${binding.sourceSha256}`);
      } else if (source.snapshot !== null || source.placement !== null) fail("不适用音轨不能携带源快照", "audio_stems_stale");
      await verifyArtifact(source.segment, `segments/${shotIndex}-${role}.wav`, timeline.shots[shotIndex].samples);
    }
    const sources = await authorizedSources({ scope: identity, shots, timeline, verifySource });
    const canonicalSources = sources.map((source, index) => ({ binding: source.binding, bindingSha256: source.bindingSha256,
      receiptSha256: source.receiptSha256, placement: manifest.sources[index].placement }));
    if (audioStemDigest(canonicalSources) !== audioStemDigest(recipe.sources)) fail("音轨缓存源清单与配方不一致", "audio_stems_stale");
    const roles = {};
    for (const role of AUDIO_STEM_ROLES) {
      roles[role] = await verifyArtifact(manifest.roles?.[role], `${role}.wav`, timeline.samples);
      const status = sources.filter((source) => source.binding.role === role).every((source) => source.binding.status === "not_applicable") ? "not_applicable" : "ready";
      if (roles[role].status !== status) fail("音轨缓存角色状态与签章不一致", "audio_stems_stale");
    }
    const program = await verifyArtifact(manifest.program, "program.wav", timeline.samples);
    // Hashes supplied alongside arbitrary media are not derivation authority.
    // Replay the exact signed sources through the pinned renderer and compare
    // every derived PCM file before accepting a cache as an independent stem.
    const replay = await renderAudioStems({ scope: identity, shots,
      transitions: { mode: timeline.mode, fadeSec: timeline.fadeSec },
      outDir: path.join(temporary, "derived"), allowedRoots, verifySource, bins });
    if (replay.recipeSha256 !== expectedRecipeSha256 || replay.program.sha256 !== program.sha256
      || AUDIO_STEM_ROLES.some((role) => replay.roles[role].sha256 !== roles[role].sha256)
      || replay.sources.some((source, index) => source.segment.sha256 !== manifest.sources[index].segment.sha256)) {
      fail("音轨缓存并非由签章来源和固定配方派生", "audio_stems_stale");
    }
    // The path-based consumer gets the pinned digests and must snapshot again.
    return { ...manifest, dir: target, manifestPath, manifestSha256: expectedManifestSha256, roles, program };
  } catch (error) { throw stableError(error); }
  finally { if (temporary) await fsp.rm(temporary, { recursive: true, force: true }); }
}

/** Snapshot a verified artifact for a media consumer; the output must be a new owned file. */
export async function snapshotAudioStemArtifact({ file, sha256, output, allowedRoots }) {
  try {
    const roots = allowedRootsOf(allowedRoots);
    const target = guardedPath(output, roots, { missing: true });
    return await snapshotSource(file, hash(sha256, "sha256"), target, roots, MAX_TOTAL_SOURCE_BYTES);
  } catch (error) { throw stableError(error); }
}

/**
 * Mux only the explicit program with the video's picture stream. The video's
 * embedded audio (including any old BGM) is never mapped into the new result.
 * Inputs are copied from verified descriptors before ffmpeg gets their paths.
 */
export async function muxAudioProgram({ videoPath, videoSha256, programPath, programSha256, output, allowedRoots, bins = resolveBinaries() }) {
  let temporary = null;
  try {
    hash(videoSha256, "videoSha256"); hash(programSha256, "programSha256");
    const roots = allowedRootsOf(allowedRoots);
    const target = guardedPath(output, roots, { missing: true });
    if ([path.resolve(videoPath), path.resolve(programPath)].includes(target)) fail("禁止覆盖媒体源", "overwrite_source_forbidden");
    if (fs.existsSync(target)) fail("音频合流目标已存在，禁止覆盖", "audio_stems_busy");
    await fsp.mkdir(path.dirname(target), { recursive: true });
    guardedPath(path.dirname(target), roots);
    temporary = await fsp.mkdtemp(path.join(path.dirname(target), ".audio-program-"));
    const video = await snapshotSource(videoPath, videoSha256, path.join(temporary, "video"), roots, MAX_TOTAL_SOURCE_BYTES);
    const program = await snapshotSource(programPath, programSha256, path.join(temporary, "program"), roots, MAX_TOTAL_SOURCE_BYTES);
    const audio = await probeAudio(program.path, bins);
    const { stdout } = await runBin(bins.ffprobe, ["-v", "error", "-select_streams", "v:0", "-show_entries", "stream=duration", "-show_format", "-of", "json", video.path], { label: "ffprobe(program-video)" });
    let media;
    try { media = JSON.parse(stdout); } catch (error) { throw new AudioStemError("画面探测返回无效 JSON", "bad_media", error); }
    const stream = media?.streams?.[0];
    const videoDuration = Number(stream?.duration ?? media?.format?.duration);
    if (!stream || !(videoDuration > 0) || Math.abs(videoDuration - audio.durationSec) > 0.04) {
      fail("独立节目音轨与画面时长差超过 40ms，禁止静默裁切", "audio_stems_alignment_failed");
    }
    const candidate = path.join(temporary, "candidate.mp4");
    await runBin(bins.ffmpeg, ["-hide_banner", "-v", "error", "-n", "-i", video.path, "-i", program.path,
      "-map", "0:v:0", "-map", "1:a:0", "-c:v", "copy", "-c:a", "aac", "-b:a", "192k",
      "-t", String(audio.durationSec), "-movflags", "+faststart", candidate,
    ], { label: "ffmpeg(mux-clean-program)", timeoutMs: 1800000 });
    const mediaAfter = await probeAudio(candidate, bins, { videoAllowed: true });
    if (Math.abs(mediaAfter.durationSec - audio.durationSec) > 0.04) fail("合流音轨时长复检失败", "audio_stems_alignment_failed");
    const result = { path: target, sha256: await sha256File(candidate), bytes: (await fsp.stat(candidate)).size,
      durationSec: audio.durationSec, videoSha256, programSha256, embeddedAudioUsed: false };
    try { await fsp.link(candidate, target); }
    catch (error) { if (error.code === "EEXIST") fail("音频合流目标已被认领，禁止覆盖", "audio_stems_busy"); throw error; }
    return result;
  } catch (error) { throw stableError(error); }
  finally { if (temporary) await fsp.rm(temporary, { recursive: true, force: true }); }
}
