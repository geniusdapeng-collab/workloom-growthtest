/**
 * Local-only image/video resolution enhancement for the ai-video post station.
 * No network calls are made here. The installer downloads a pinned engine;
 * this module only reads local source files, runs local binaries, and writes
 * new content-addressed files plus verification evidence.
 */
import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import fs, { createReadStream } from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { once } from "node:events";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { ENGINE_PIN } from "./pin.mjs";

export const ENHANCE_SCHEMA = "workloom.local-enhancement/v1";
const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, "../../../..");
const PNG_SIGNATURE = Buffer.from("89504e470d0a1a0a", "hex");
// Local 2026-09-27 M3/8 GiB smoke: x4plus 1920x1080 source to 3840x2160
// took ~120.7 s for one still including fixture/output checks. Half that
// measured rate is used as a conservative lower bound for video preflight.
const M3_X4PLUS_BASELINE = Object.freeze({ sourcePixels: 1920 * 1080, measuredSecPerFrame: 120.7, lowerBoundFactor: 0.5 });
const DEFAULTS = Object.freeze({
  maxInputBytes: 2 * 1024 ** 3,
  maxFrames: 3600,
  maxDurationSec: 120,
  maxInputPixels: 5_000_000,
  maxNativeInputPixels: 12_000_000,
  maxInferencePixels: 40_000_000,
  maxTargetPixels: 8_500_000,
  maxFrameBytes: 64 * 1024 ** 2,
  maxAiFrameBytes: 256 * 1024 ** 2,
  maxScratchBytes: 512 * 1024 ** 2,
  maxOutputBytes: 1024 ** 3,
  reserveBytes: 512 * 1024 ** 2,
  tileSize: 128,
  frameTimeoutMs: 300_000,
  totalTimeoutMs: 3_600_000,
  lockTimeoutMs: 120_000,
});

export class EnhanceError extends Error {
  constructor(message, code = "engine_failed", retryable = false, details = null) {
    super(message);
    this.name = "EnhanceError";
    this.code = code;
    this.retryable = retryable;
    if (details) this.details = details;
  }
}

export function estimateEnhanceVideoBudget({ sourcePixels, frameCount, modelName, totalTimeoutMs,
  cpuModel = os.cpus()[0]?.model || "", memoryBytes = os.totalmem() }) {
  if (cpuModel !== "Apple M3" || memoryBytes > 10 * 1024 ** 3 || modelName !== "realesrgan-x4plus") return null;
  const lowerBoundSecPerFrame = M3_X4PLUS_BASELINE.measuredSecPerFrame
    * M3_X4PLUS_BASELINE.lowerBoundFactor * sourcePixels / M3_X4PLUS_BASELINE.sourcePixels;
  const estimatedSec = lowerBoundSecPerFrame * frameCount;
  const budgetSec = totalTimeoutMs / 1000;
  return {
    hardware: "Apple M3 / 8 GiB class",
    measuredSecPerFrameAt1080p: M3_X4PLUS_BASELINE.measuredSecPerFrame,
    lowerBoundSecPerFrame: Number(lowerBoundSecPerFrame.toFixed(2)),
    estimatedSec: Math.ceil(estimatedSec), budgetSec,
    exceedsBudget: estimatedSec > budgetSec,
  };
}

export function resolveEnhanceBinaries(env = process.env) {
  const localKit = (name) => {
    const candidate = path.join(os.homedir(), ".workloom-color", "bin", name);
    try { fs.accessSync(candidate, fs.constants.X_OK); return candidate; }
    catch { return name; }
  };
  return {
    ffmpeg: env.WORKLOOM_ENHANCE_FFMPEG_PATH || env.WORKLOOM_POST_FFMPEG_PATH || localKit("ffmpeg"),
    ffprobe: env.WORKLOOM_ENHANCE_FFPROBE_PATH || env.WORKLOOM_POST_FFPROBE_PATH || localKit("ffprobe"),
  };
}

export function defaultEngineDir(env = process.env) {
  return path.resolve(env.WORKLOOM_ENHANCE_ENGINE_DIR || path.join(REPO_ROOT, "var/enhance-engine"));
}

async function sha256File(file) {
  const digest = createHash("sha256");
  for await (const chunk of createReadStream(file)) digest.update(chunk);
  return digest.digest("hex");
}

function hashJson(data) {
  return createHash("sha256").update(JSON.stringify(data)).digest("hex");
}

function tail(text, limit = 8000) {
  return text.length <= limit ? text : text.slice(-limit);
}

async function runProcess(bin, argv, { timeoutMs = 60_000, maxStdoutBytes = 16 * 1024 ** 2, label = path.basename(bin) } = {}) {
  return new Promise((resolve, reject) => {
    let child;
    try { child = spawn(bin, argv, { stdio: ["ignore", "pipe", "pipe"] }); }
    catch (error) { reject(new EnhanceError(`${label} 无法启动：${error.message}`, "tool_missing")); return; }
    let stdoutBytes = 0;
    const stdout = [];
    let stderr = "";
    let timedOut = false;
    let overflow = false;
    const timer = setTimeout(() => { timedOut = true; child.kill("SIGKILL"); }, timeoutMs);
    child.stdout.on("data", (chunk) => {
      stdoutBytes += chunk.length;
      if (stdoutBytes > maxStdoutBytes) { overflow = true; child.kill("SIGKILL"); }
      else stdout.push(chunk);
    });
    child.stderr.on("data", (chunk) => { stderr = tail(stderr + chunk.toString("utf8")); });
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(new EnhanceError(`${label} 无法启动：${error.message}`, error.code === "ENOENT" ? "tool_missing" : "process_failed"));
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      if (timedOut) reject(new EnhanceError(`${label} 超时（${timeoutMs}ms）`, "timeout", true));
      else if (overflow) reject(new EnhanceError(`${label} 输出超过 ${maxStdoutBytes} 字节`, "process_output_limit"));
      else if (code !== 0) reject(new EnhanceError(`${label} 退出码 ${code}：${tail(stderr, 1200)}`, "process_failed", true));
      else resolve({ stdout: Buffer.concat(stdout).toString("utf8"), stderr });
    });
  });
}

async function probeMedia(file, bins, { frames = false } = {}) {
  const args = ["-v", "error"];
  if (frames) args.push("-select_streams", "v:0", "-show_entries", "frame=best_effort_timestamp_time", "-show_frames");
  else args.push("-show_streams", "-show_format");
  args.push("-of", "json", file);
  const { stdout } = await runProcess(bins.ffprobe, args, {
    label: "ffprobe",
    timeoutMs: frames ? 120_000 : 30_000,
    maxStdoutBytes: frames ? 16 * 1024 ** 2 : 4 * 1024 ** 2,
  });
  try { return JSON.parse(stdout); }
  catch { throw new EnhanceError("ffprobe 返回无法解析的 JSON", "bad_media"); }
}

function mediaSummary(doc) {
  const video = doc.streams?.find((item) => item.codec_type === "video");
  if (!video || !Number.isInteger(video.width) || !Number.isInteger(video.height)) {
    throw new EnhanceError("媒体缺少可解码的视频/图像流", "bad_media");
  }
  const audio = (doc.streams || []).filter((item) => item.codec_type === "audio");
  const unsupported = (doc.streams || []).filter((item) => !["video", "audio"].includes(item.codec_type));
  if (unsupported.length) throw new EnhanceError("源文件含字幕/数据等本地增强暂不保留的流", "unsupported_stream");
  if ((doc.streams || []).filter((item) => item.codec_type === "video").length !== 1) {
    throw new EnhanceError("仅支持单视频流；多角度源需先显式选流", "unsupported_stream");
  }
  const color = [video.color_space, video.color_transfer, video.color_primaries].filter(Boolean).join(" ").toLowerCase();
  if (/bt2020|smpte2084|arib-std-b67|smpte2085/.test(color) || /p(10|12|16)|rgb48|rgba64/.test(video.pix_fmt || "")) {
    throw new EnhanceError("HDR/10-bit 源不经 8-bit PNG 路径处理，避免静默丢失色彩信息", "unsupported_color");
  }
  if (/rgba|yuva|argb|abgr|bgra/.test(video.pix_fmt || "")) {
    throw new EnhanceError("透明通道素材不经当前 8-bit 视频路径处理", "unsupported_alpha");
  }
  const rotation = Number(video.tags?.rotate || 0) || Number(video.side_data_list?.find((item) => item.rotation)?.rotation || 0);
  if (rotation) throw new EnhanceError("带旋转元数据的源需先归一化方向", "unsupported_rotation");
  const sar = video.sample_aspect_ratio;
  if (sar && !["1:1", "1/1", "0:1", "0/1"].includes(sar)) {
    throw new EnhanceError("非方形像素素材需先归一化 SAR，避免显示比例失真", "unsupported_aspect_ratio");
  }
  return {
    width: video.width,
    height: video.height,
    codec: video.codec_name || null,
    pixFmt: video.pix_fmt || null,
    frameRate: video.avg_frame_rate || video.r_frame_rate || null,
    timeBase: video.time_base || null,
    sampleAspectRatio: video.sample_aspect_ratio || null,
    startTime: numeric(video.start_time),
    duration: numeric(video.duration) ?? numeric(doc.format?.duration),
    colorSpace: video.color_space || null,
    colorTransfer: video.color_transfer || null,
    colorPrimaries: video.color_primaries || null,
    audio: audio.map((item) => ({ codec: item.codec_name || null, startTime: numeric(item.start_time), duration: numeric(item.duration) })),
    bytes: numeric(doc.format?.size),
  };
}

function numeric(value) {
  const result = Number(value);
  return Number.isFinite(result) ? result : null;
}

function rateValue(value) {
  if (typeof value !== "string") return null;
  const match = /^(\d+)(?:\/(\d+))?$/.exec(value);
  if (!match) return null;
  const top = Number(match[1]);
  const bottom = Number(match[2] || 1);
  return bottom > 0 ? top / bottom : null;
}

/** Verify that every presented frame has one uniform cadence before using image2pipe. */
export function analyzeCadence(timestamps, declaredRate, { maxFrames = DEFAULTS.maxFrames } = {}) {
  if (!Array.isArray(timestamps) || timestamps.length < 1) throw new EnhanceError("找不到帧时间戳", "bad_media");
  if (timestamps.length > maxFrames) throw new EnhanceError(`帧数超过上限 ${maxFrames}`, "frame_limit");
  const fps = rateValue(declaredRate);
  if (!fps || fps < 1 || fps > 120) throw new EnhanceError(`不支持帧率：${declaredRate}`, "unsupported_fps");
  const times = timestamps.map(Number);
  if (times.some((value) => !Number.isFinite(value))) throw new EnhanceError("源帧时间戳缺失", "bad_media");
  if (Math.abs(times[0]) > Math.max(0.02, 0.5 / fps)) {
    throw new EnhanceError("视频起始时间戳非零，当前流式处理不重写相对时间线", "timestamp_unsupported");
  }
  const deltas = [];
  for (let i = 1; i < times.length; i++) {
    const delta = times[i] - times[i - 1];
    if (delta <= 0) throw new EnhanceError("非单调帧时间戳", "vfr_unsupported");
    deltas.push(delta);
  }
  if (deltas.length) {
    const sorted = [...deltas].sort((a, b) => a - b);
    const median = sorted[Math.floor(sorted.length / 2)];
    const tolerance = Math.max(0.0005, median * 0.01);
    if (deltas.some((delta) => Math.abs(delta - median) > tolerance) || Math.abs(median - 1 / fps) > Math.max(0.001, 0.01 / fps)) {
      throw new EnhanceError("检测到可变帧率/丢帧时间线；本地增强拒绝重定时", "vfr_unsupported");
    }
  }
  return { fps, rate: declaredRate, frameCount: times.length, firstPtsSec: times[0], lastPtsSec: times.at(-1), cadence: "cfr" };
}

function validateOptions(options) {
  if (!options || typeof options !== "object") throw new EnhanceError("增强参数缺失", "bad_request");
  const { input, outputDir, scopeId, targetWidth, targetHeight, kind } = options;
  if (typeof input !== "string" || !input.trim()) throw new EnhanceError("input 缺失", "bad_request");
  if (typeof outputDir !== "string" || !outputDir.trim()) throw new EnhanceError("outputDir 缺失", "bad_request");
  if (typeof scopeId !== "string" || !scopeId.trim() || scopeId.length > 256) throw new EnhanceError("scopeId 必须标识当前租户/项目的缓存作用域", "bad_request");
  if (!Number.isInteger(targetWidth) || !Number.isInteger(targetHeight) || targetWidth < 32 || targetHeight < 32 || targetWidth % 2 || targetHeight % 2) {
    throw new EnhanceError("目标宽高必须是至少 32 的偶数", "bad_request");
  }
  if (targetWidth * targetHeight > DEFAULTS.maxTargetPixels) throw new EnhanceError("目标尺寸超过本地 4K 工作档上限", "target_limit");
  if (kind === "text") throw new EnhanceError("含文字/卡牌素材应重排版，禁止 AI 超分", "unsupported_content");
  if (kind !== "live-action" && kind !== "animation") throw new EnhanceError("kind 必须显式为 live-action 或 animation", "bad_request");
  return { input: path.resolve(input), outputDir: path.resolve(outputDir), scopeId: scopeId.trim(), targetWidth, targetHeight, kind };
}

function limitsFrom(options) {
  const limits = { ...DEFAULTS };
  for (const key of Object.keys(DEFAULTS)) {
    if (options[key] === undefined) continue;
    const value = Number(options[key]);
    if (!Number.isInteger(value) || value <= 0 || value > DEFAULTS[key]) throw new EnhanceError(`${key} 必须是 1..${DEFAULTS[key]} 的整数`, "bad_request");
    limits[key] = value;
  }
  if (limits.tileSize < 32 || limits.tileSize % 32) throw new EnhanceError("tileSize 必须是 32 的正整数倍", "bad_request");
  return limits;
}

function chooseModel(kind, source, target) {
  const fitFactor = Math.min(target.width / source.width, target.height / source.height);
  if (fitFactor <= 1.001) return null;
  let name;
  let scale;
  if (kind === "live-action") { name = ENGINE_PIN.models["live-action"].name; scale = 4; }
  else {
    name = ENGINE_PIN.models.animation.name;
    scale = ENGINE_PIN.models.animation.scales.find((candidate) => candidate + 0.001 >= fitFactor);
  }
  if (!scale || source.width * scale * source.height * scale > DEFAULTS.maxInferencePixels) {
    throw new EnhanceError("所需 AI 放大倍率或推理像素超出 M3 工作档", "unsupported_scale");
  }
  return { name, scale, fitFactor };
}

async function ensureEngine(engineDir) {
  if (process.platform !== "darwin" || process.arch !== "arm64") throw new EnhanceError("本地增强仅在 Apple Silicon macOS 开放", "unsupported_platform");
  let pin;
  let ready;
  try {
    [pin, ready] = await Promise.all([
      fsp.readFile(path.join(engineDir, "PINNED.json"), "utf8").then(JSON.parse),
      fsp.readFile(path.join(engineDir, ".runtime-ready"), "utf8").then(JSON.parse),
    ]);
  } catch {
    throw new EnhanceError("本地引擎未安装或未通过 GPU 冒烟；先运行 enhance-engine-install.mjs", "engine_not_ready");
  }
  if (pin.archiveSha256 !== ENGINE_PIN.sha256 || ready.archiveSha256 !== ENGINE_PIN.sha256) {
    throw new EnhanceError("引擎 PINNED 与预期发布包不一致", "engine_digest_mismatch");
  }
  for (const rel of ENGINE_PIN.archiveEntries) {
    if (!/^[a-f0-9]{64}$/.test(pin.files?.[rel] || "") || (await sha256File(path.join(engineDir, rel))) !== pin.files[rel]) {
      throw new EnhanceError(`引擎文件校验失败：${rel}`, "engine_digest_mismatch");
    }
  }
  const binary = path.join(engineDir, ENGINE_PIN.binary);
  try { await fsp.access(binary, fs.constants.X_OK); }
  catch { throw new EnhanceError("ncnn 二进制不可执行", "engine_not_ready"); }
  return { binary, modelDir: path.join(engineDir, "models"), manifest: pin, runtimeReady: ready };
}

export async function checkEnhanceEngine({ engineDir = defaultEngineDir(), bins = resolveEnhanceBinaries() } = {}) {
  try {
    const engine = await ensureEngine(path.resolve(engineDir));
    const ffmpeg = await runProcess(bins.ffmpeg, ["-hide_banner", "-version"], { label: "ffmpeg", timeoutMs: 15_000, maxStdoutBytes: 100_000 });
    const ffprobe = await runProcess(bins.ffprobe, ["-hide_banner", "-version"], { label: "ffprobe", timeoutMs: 15_000, maxStdoutBytes: 100_000 });
    return {
      ready: true,
      engineDir: path.resolve(engineDir),
      archiveSha256: ENGINE_PIN.sha256,
      models: Object.keys(ENGINE_PIN.models),
      ffmpeg: ffmpeg.stdout.split("\n")[0],
      ffprobe: ffprobe.stdout.split("\n")[0],
      smoke: engine.runtimeReady.smoke,
    };
  } catch (error) {
    return { ready: false, engineDir: path.resolve(engineDir), code: error.code || "engine_failed", reason: error.message };
  }
}

async function freeBytes(dir) {
  const info = await fsp.statfs(dir);
  return info.bavail * info.bsize;
}

async function checkDisk(outputDir, scratchRoot, limits, { scratchBytes, minOutputBytes }) {
  const [scratchFree, outputFree] = await Promise.all([freeBytes(scratchRoot), freeBytes(outputDir)]);
  const sameDevice = (await fsp.stat(scratchRoot)).dev === (await fsp.stat(outputDir)).dev;
  const sharedFree = Math.min(scratchFree, outputFree);
  const needed = scratchBytes + minOutputBytes + limits.reserveBytes;
  const evidence = { scratchFreeBytes: scratchFree, outputFreeBytes: outputFree, sameDevice,
    scratchBudgetBytes: scratchBytes, minimumOutputBytes: minOutputBytes, reserveBytes: limits.reserveBytes };
  if (minOutputBytes > limits.maxOutputBytes ||
      (sameDevice ? sharedFree < needed : scratchFree < scratchBytes + limits.reserveBytes || outputFree < minOutputBytes + limits.reserveBytes)) {
    throw new EnhanceError(`可用磁盘空间不足（任务至少需要 ${(needed / 1024 ** 3).toFixed(2)} GiB）`, "disk_quota_exceeded", false, evidence);
  }
  const outputAllowance = sameDevice ? sharedFree - scratchBytes - limits.reserveBytes : outputFree - limits.reserveBytes;
  const outputMaxBytes = Math.min(limits.maxOutputBytes, Math.floor(outputAllowance));
  return { outputMaxBytes, evidence: { ...evidence, outputMaxBytes } };
}

async function acquireLock(lockPath, outputPath, metadataPath, timeoutMs) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    try {
      const handle = await fsp.open(lockPath, "wx", 0o600);
      await handle.writeFile(JSON.stringify({ pid: process.pid, at: Date.now() }));
      await handle.close();
      return true;
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
      if (fs.existsSync(outputPath) && fs.existsSync(metadataPath)) return false;
      let stale = false;
      try {
        const owner = JSON.parse(await fsp.readFile(lockPath, "utf8"));
        if (Date.now() - Number(owner.at) > 3_600_000) {
          try { process.kill(Number(owner.pid), 0); } catch (killError) { stale = killError?.code === "ESRCH"; }
        }
      } catch { /* Invalid locks fail closed. */ }
      if (stale) { await fsp.unlink(lockPath); continue; }
      await delay(250);
    }
  }
  throw new EnhanceError("同一素材增强任务占用缓存锁超时", "cache_busy", true);
}

async function cachedResult(output, provenancePath, key, sourceSha256, expected) {
  const outputExists = fs.existsSync(output);
  const metadataExists = fs.existsSync(provenancePath);
  if (!outputExists && !metadataExists) return null;
  if (!outputExists || !metadataExists) throw new EnhanceError("缓存产物与证据不完整，拒绝静默覆盖", "cache_incomplete");
  let metadata;
  try { metadata = JSON.parse(await fsp.readFile(provenancePath, "utf8")); }
  catch { throw new EnhanceError("缓存证据无法解析", "cache_corrupt"); }
  if (metadata?.schema !== ENHANCE_SCHEMA || metadata.key !== key || metadata.source?.sha256 !== sourceSha256 ||
      metadata.target?.width !== expected.target.width || metadata.target?.height !== expected.target.height ||
      metadata.processingMode !== expected.processingMode || metadata.model !== expected.model ||
      metadata.modelScale !== expected.modelScale || JSON.stringify(metadata.engine) !== JSON.stringify(expected.engine) ||
      metadata.output?.path !== output || metadata.output?.sha256 !== await sha256File(output) ||
      metadata.receipt?.localVerified !== true || metadata.receipt?.sha256 !== metadata.output.sha256 ||
      metadata.receipt.provenancePath !== provenancePath || metadata.receipt.output !== output ||
      metadata.receipt.processingMode !== metadata.processingMode || metadata.receipt.model !== metadata.model ||
      metadata.receipt.modelScale !== metadata.modelScale || JSON.stringify(metadata.receipt.engine) !== JSON.stringify(metadata.engine) ||
      JSON.stringify(metadata.receipt.diskPreflight) !== JSON.stringify(metadata.process?.diskPreflight)) {
    throw new EnhanceError("缓存摘要或参数与证据不一致", "cache_corrupt");
  }
  return {
    output, sha256: metadata.output.sha256, sourceSha256, key, reused: true,
    provenancePath, probe: metadata.output.probe,
    processingMode: metadata.processingMode,
    model: metadata.model,
    modelScale: metadata.modelScale,
    engine: metadata.engine,
    diskPreflight: metadata.process?.diskPreflight,
    receipt: metadata.receipt,
  };
}

function scaleFilter(width, height, { image = false } = {}) {
  return `scale=${width}:${height}:flags=lanczos:force_original_aspect_ratio=decrease,`
    + `pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2:color=black,setsar=1${image ? ",format=rgb24" : ",format=yuv420p"}`;
}

async function checkFileLimit(file, maxBytes, code) {
  const bytes = (await fsp.stat(file)).size;
  if (bytes === 0 || bytes > maxBytes) throw new EnhanceError(`临时文件大小异常：${bytes} > ${maxBytes}`, code);
  return bytes;
}

async function runNcnn(engine, input, output, model, limits, timeoutMs) {
  await runProcess(engine.binary, [
    "-i", input, "-o", output, "-m", engine.modelDir,
    "-n", model.name, "-s", String(model.scale),
    "-t", String(limits.tileSize), "-j", "1:1:1",
  ], { label: "realesrgan-ncnn-vulkan", timeoutMs, maxStdoutBytes: 100_000 });
  await checkFileLimit(output, limits.maxAiFrameBytes, "scratch_limit");
}

class ExactReader {
  constructor(stream) { this.iterator = stream[Symbol.asyncIterator](); this.chunk = Buffer.alloc(0); this.offset = 0; this.ended = false; }
  async read(bytes) {
    const out = Buffer.allocUnsafe(bytes);
    let copied = 0;
    while (copied < bytes) {
      if (this.offset >= this.chunk.length) {
        const next = await this.iterator.next();
        if (next.done) { this.ended = true; break; }
        this.chunk = next.value;
        this.offset = 0;
      }
      const n = Math.min(bytes - copied, this.chunk.length - this.offset);
      this.chunk.copy(out, copied, this.offset, this.offset + n);
      copied += n;
      this.offset += n;
    }
    if (copied === 0 && this.ended) return null;
    if (copied !== bytes) throw new EnhanceError("PNG 帧流提前结束", "decode_failed");
    return out;
  }
}

async function readPngFrame(reader, limit) {
  const signature = await reader.read(8);
  if (signature === null) return null;
  if (!signature.equals(PNG_SIGNATURE)) throw new EnhanceError("ffmpeg 帧流不是 PNG", "decode_failed");
  const chunks = [signature];
  let total = 8;
  while (true) {
    const header = await reader.read(8);
    if (!header) throw new EnhanceError("PNG chunk header 缺失", "decode_failed");
    const length = header.readUInt32BE(0);
    total += length + 12;
    if (total > limit) throw new EnhanceError(`单帧 PNG 超过 ${limit} 字节`, "scratch_limit");
    const payload = await reader.read(length + 4);
    if (!payload) throw new EnhanceError("PNG chunk 数据缺失", "decode_failed");
    chunks.push(header, payload);
    if (header.toString("ascii", 4, 8) === "IEND") break;
  }
  return Buffer.concat(chunks, total);
}

function observeChild(child, label, timeoutMs) {
  let stderr = "";
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; child.kill("SIGKILL"); }, timeoutMs);
  child.stderr.on("data", (chunk) => { stderr = tail(stderr + chunk.toString("utf8")); });
  const done = new Promise((resolve) => {
    child.once("error", (error) => { clearTimeout(timer); resolve({ ok: false, error: new EnhanceError(`${label} 无法启动：${error.message}`, error.code === "ENOENT" ? "tool_missing" : "process_failed") }); });
    child.once("close", (code) => {
      clearTimeout(timer);
      resolve(timedOut ? { ok: false, error: new EnhanceError(`${label} 超时`, "timeout", true) }
        : code === 0 ? { ok: true } : { ok: false, error: new EnhanceError(`${label} 退出码 ${code}：${tail(stderr, 1200)}`, "process_failed", true) });
    });
  });
  return { done, get stderr() { return stderr; } };
}

async function pipeFileToStdin(file, stdin) {
  for await (const chunk of createReadStream(file)) {
    if (stdin.destroyed) throw new EnhanceError("编码器提前关闭输入管道", "encode_failed", true);
    if (!stdin.write(chunk)) await once(stdin, "drain");
  }
}

async function enhanceVideoStream({ input, tmpOutput, scratch, model, source, cadence, bins, engine, limits, target }) {
  const decoderArgs = ["-hide_banner", "-v", "error", "-noautorotate", "-i", input,
    "-map", "0:v:0", "-fps_mode", "passthrough", "-pix_fmt", "rgb24", "-f", "image2pipe", "-vcodec", "png", "pipe:1"];
  const encoderArgs = ["-hide_banner", "-v", "error", "-y", "-f", "image2pipe", "-framerate", cadence.rate,
    "-vcodec", "png", "-i", "pipe:0", "-i", input,
    "-map", "0:v:0", "-map", "1:a?", "-vf", scaleFilter(target.width, target.height),
    "-c:v", "libx264", "-preset", "veryfast", "-crf", "16", "-pix_fmt", "yuv420p",
    "-c:a", "copy", "-colorspace", "bt709", "-color_primaries", "bt709", "-color_trc", "bt709",
    "-movflags", "+faststart", "-fs", String(limits.maxOutputBytes), tmpOutput];
  const decoder = spawn(bins.ffmpeg, decoderArgs, { stdio: ["ignore", "pipe", "pipe"] });
  const encoder = spawn(bins.ffmpeg, encoderArgs, { stdio: ["pipe", "ignore", "pipe"] });
  const decoderState = observeChild(decoder, "ffmpeg decode", limits.totalTimeoutMs);
  const encoderState = observeChild(encoder, "ffmpeg encode", limits.totalTimeoutMs);
  const reader = new ExactReader(decoder.stdout);
  const inputFrame = path.join(scratch, "input.png");
  const aiFrame = path.join(scratch, "enhanced.png");
  const started = Date.now();
  let count = 0;
  try {
    for (let index = 0; index < cadence.frameCount; index++) {
      const png = await readPngFrame(reader, limits.maxFrameBytes);
      if (!png) throw new EnhanceError(`只收到 ${index}/${cadence.frameCount} 帧`, "decode_failed");
      await fsp.writeFile(inputFrame, png);
      const remaining = Math.max(1, limits.totalTimeoutMs - (Date.now() - started));
      await runNcnn(engine, inputFrame, aiFrame, model, limits, Math.min(limits.frameTimeoutMs, remaining));
      await pipeFileToStdin(aiFrame, encoder.stdin);
      await Promise.all([fsp.rm(inputFrame, { force: true }), fsp.rm(aiFrame, { force: true })]);
      count++;
      if (count === 1 && cadence.frameCount > 1) {
        const projectedMs = (Date.now() - started) * cadence.frameCount;
        if (projectedMs > limits.totalTimeoutMs * 1.25) {
          throw new EnhanceError(
            `首帧推理速度推算整段约 ${(projectedMs / 3_600_000).toFixed(1)} 小时，超过本机 ${(limits.totalTimeoutMs / 3_600_000).toFixed(1)} 小时工作档`,
            "time_budget_exceeded",
          );
        }
      }
    }
    if (await readPngFrame(reader, limits.maxFrameBytes)) throw new EnhanceError("解码帧数多于 ffprobe 声明", "decode_failed");
    encoder.stdin.end();
    const [decoded, encoded] = await Promise.all([decoderState.done, encoderState.done]);
    if (!decoded.ok) throw decoded.error;
    if (!encoded.ok) throw encoded.error;
    await checkFileLimit(tmpOutput, limits.maxOutputBytes, "output_limit");
    return { processedFrames: count, sourceAudioTracks: source.audio.length };
  } catch (error) {
    decoder.kill("SIGKILL");
    encoder.kill("SIGKILL");
    encoder.stdin.destroy();
    await Promise.allSettled([decoderState.done, encoderState.done]);
    throw error;
  }
}

async function processImage({ input, tmpOutput, scratch, model, bins, engine, limits, target }) {
  const inputFrame = path.join(scratch, "input.png");
  const aiFrame = path.join(scratch, "enhanced.png");
  await runProcess(bins.ffmpeg, ["-hide_banner", "-v", "error", "-y", "-i", input,
    "-frames:v", "1", "-pix_fmt", "rgb24", inputFrame], { label: "ffmpeg image decode", timeoutMs: 60_000, maxStdoutBytes: 100_000 });
  await checkFileLimit(inputFrame, limits.maxFrameBytes, "scratch_limit");
  await runNcnn(engine, inputFrame, aiFrame, model, limits, limits.frameTimeoutMs);
  await runProcess(bins.ffmpeg, ["-hide_banner", "-v", "error", "-y", "-i", aiFrame,
    "-vf", scaleFilter(target.width, target.height, { image: true }), "-frames:v", "1", tmpOutput],
  { label: "ffmpeg image encode", timeoutMs: 120_000, maxStdoutBytes: 100_000 });
  await checkFileLimit(tmpOutput, limits.maxOutputBytes, "output_limit");
  return { processedFrames: 1, sourceAudioTracks: 0 };
}

async function processNative({ type, input, tmpOutput, source, cadence, bins, limits, target, copySource }) {
  if (copySource) {
    await fsp.copyFile(input, tmpOutput, fs.constants.COPYFILE_EXCL);
    await checkFileLimit(tmpOutput, limits.maxOutputBytes, "output_limit");
    return { processedFrames: type === "image" ? 1 : cadence.frameCount, sourceAudioTracks: source.audio.length, nativeAction: "file-copy" };
  }
  if (type === "image") {
    await runProcess(bins.ffmpeg, ["-hide_banner", "-v", "error", "-y", "-noautorotate", "-i", input,
      "-vf", scaleFilter(target.width, target.height, { image: true }), "-frames:v", "1", tmpOutput],
    { label: "ffmpeg native image", timeoutMs: Math.min(120_000, limits.totalTimeoutMs), maxStdoutBytes: 100_000 });
  } else {
    await runProcess(bins.ffmpeg, ["-hide_banner", "-v", "error", "-y", "-noautorotate", "-i", input,
      "-map", "0:v:0", "-map", "0:a?", "-vf", scaleFilter(target.width, target.height),
      "-fps_mode", "passthrough", "-c:v", "libx264", "-preset", "veryfast", "-crf", "16", "-pix_fmt", "yuv420p",
      "-c:a", "copy", "-colorspace", "bt709", "-color_primaries", "bt709", "-color_trc", "bt709",
      "-movflags", "+faststart", "-fs", String(limits.maxOutputBytes), tmpOutput],
    { label: "ffmpeg native video", timeoutMs: limits.totalTimeoutMs, maxStdoutBytes: 100_000 });
  }
  await checkFileLimit(tmpOutput, limits.maxOutputBytes, "output_limit");
  return { processedFrames: type === "image" ? 1 : cadence.frameCount, sourceAudioTracks: source.audio.length, nativeAction: "resize-or-remux" };
}

async function verifyOutput({ kind, inputProbe, outputProbe, cadence, expected, bins, tmpOutput }) {
  const output = mediaSummary(outputProbe);
  if (output.width !== expected.width || output.height !== expected.height) throw new EnhanceError("增强输出分辨率与目标不符", "output_invalid");
  if (kind === "video") {
    if (output.audio.length !== inputProbe.audio.length ||
        output.audio.some((track, index) => track.codec !== inputProbe.audio[index].codec)) {
      throw new EnhanceError("音轨数量或编码未完整保留", "audio_mismatch");
    }
    const outputFrames = await probeMedia(tmpOutput, bins, { frames: true });
    const outTimes = (outputFrames.frames || []).map((frame) => frame.best_effort_timestamp_time);
    if (outTimes.length !== cadence.frameCount) throw new EnhanceError("输出帧数与输入不一致", "frame_mismatch");
    const outCadence = analyzeCadence(outTimes, cadence.rate, { maxFrames: cadence.frameCount });
    if (Math.abs(outCadence.fps - cadence.fps) > 0.01) throw new EnhanceError("输出帧率与输入不一致", "frame_mismatch");
    const tolerance = Math.max(0.12, 2 / cadence.fps);
    if (inputProbe.duration !== null && output.duration !== null && Math.abs(output.duration - inputProbe.duration) > tolerance) {
      throw new EnhanceError("输出时长与输入不一致", "duration_mismatch");
    }
    for (let i = 0; i < output.audio.length; i++) {
      const before = inputProbe.audio[i];
      const after = output.audio[i];
      if (before.startTime !== null && after.startTime !== null && Math.abs(before.startTime - after.startTime) > tolerance) {
        throw new EnhanceError(`第 ${i + 1} 条音轨起点变化超限`, "audio_mismatch");
      }
      if (before.duration !== null && after.duration !== null && Math.abs(before.duration - after.duration) > tolerance) {
        throw new EnhanceError(`第 ${i + 1} 条音轨时长变化超限`, "audio_mismatch");
      }
    }
    return { output, checks: { dimensions: true, frameCount: true, cfr: true, audioTracks: true, durationToleranceSec: tolerance } };
  }
  if (output.audio.length) throw new EnhanceError("图片增强输出意外含音轨", "output_invalid");
  return { output, checks: { dimensions: true, stillImage: true } };
}

async function enhance(type, options) {
  const spec = validateOptions(options);
  let limits = limitsFrom(options);
  const target = { width: spec.targetWidth, height: spec.targetHeight };
  const bins = options.bins || resolveEnhanceBinaries();
  const engineDir = path.resolve(options.engineDir || defaultEngineDir());
  let sourceStat;
  let input;
  try { input = await fsp.realpath(spec.input); sourceStat = await fsp.stat(input); }
  catch { throw new EnhanceError(`源文件不存在：${spec.input}`, "not_found"); }
  if (!sourceStat.isFile() || sourceStat.size === 0 || sourceStat.size > limits.maxInputBytes) throw new EnhanceError("源文件为空或超过输入限制", "input_limit");
  if (type === "image" && !/\.(png|jpe?g|webp|heic|heif|bmp)$/i.test(input)) throw new EnhanceError("图片接口只接收静态图片文件", "bad_media");
  const inputProbeDoc = await probeMedia(input, bins);
  const source = mediaSummary(inputProbeDoc);
  if (type === "image" && source.audio.length) throw new EnhanceError("图片接口不接受音轨", "bad_media");
  if (type === "video" && (source.duration === null || source.duration <= 0 || source.duration > limits.maxDurationSec)) {
    throw new EnhanceError(`视频时长不在 0..${limits.maxDurationSec}s 工作档内`, "duration_limit");
  }
  const model = chooseModel(spec.kind, source, target);
  const inputPixels = source.width * source.height;
  if (inputPixels > (model ? limits.maxInputPixels : limits.maxNativeInputPixels)) {
    throw new EnhanceError("输入像素数超过本机工作档", "input_limit");
  }
  const engine = model ? await ensureEngine(engineDir) : null;
  const exactDimensions = source.width === target.width && source.height === target.height;
  const copySource = !model && exactDimensions &&
    (type === "video" ? path.extname(input).toLowerCase() === ".mp4" : path.extname(input).toLowerCase() === ".png");
  const processingMode = model ? "ai-upscale" : copySource ? "passthrough" : "native-resize";
  const sourceSha256 = await sha256File(input);
  const modelFiles = !model ? [] : model.name === "realesrgan-x4plus"
    ? ["models/realesrgan-x4plus.param", "models/realesrgan-x4plus.bin"]
    : [`models/realesr-animevideov3-x${model.scale}.param`, `models/realesr-animevideov3-x${model.scale}.bin`];
  const engineInfo = model
    ? { name: "Real-ESRGAN ncnn Vulkan", release: ENGINE_PIN.release, archiveSha256: ENGINE_PIN.sha256,
        binarySha256: engine.manifest.files[ENGINE_PIN.binary], modelFiles: Object.fromEntries(modelFiles.map((file) => [file, engine.manifest.files[file]])), tileSize: limits.tileSize }
    : { name: copySource ? "source-copy" : "FFmpeg", release: null, archiveSha256: null,
        binarySha256: null, modelFiles: {}, tileSize: null };
  const sourceIdentity = { sha256: sourceSha256, scopeId: spec.scopeId, realpath: input };
  const key = hashJson({ schema: ENHANCE_SCHEMA, type, sourceIdentity, target, kind: spec.kind,
    processingMode, model: model?.name || null, scale: model?.scale || null,
    modelHashes: modelFiles.map((file) => engine.manifest.files[file]), engine: engineInfo.archiveSha256,
    encoder: copySource ? "source-copy-v1" : type === "video" ? "libx264-crf16-veryfast-bt709-v1" : "png-rgb24-v1" });
  const outputDir = path.join(spec.outputDir, key.slice(0, 2));
  await fsp.mkdir(outputDir, { recursive: true });
  const output = path.join(outputDir, `${key}.${type === "image" ? "png" : "mp4"}`);
  const provenancePath = path.join(outputDir, `${key}.json`);
  const cacheExpected = { target, processingMode, model: model?.name || null, modelScale: model?.scale || null, engine: engineInfo };
  const previous = await cachedResult(output, provenancePath, key, sourceSha256, cacheExpected);
  if (previous) return previous;
  const locked = await acquireLock(`${output}.lock`, output, provenancePath, limits.lockTimeoutMs);
  if (!locked) return (await cachedResult(output, provenancePath, key, sourceSha256, cacheExpected));
  const lockPath = `${output}.lock`;
  let scratch = null;
  let tmpOutput = null;
  let tmpMeta = null;
  let publishedOutput = false;
  try {
    const raced = await cachedResult(output, provenancePath, key, sourceSha256, cacheExpected);
    if (raced) return raced;
    const scratchRoot = path.resolve(options.scratchRoot || path.join(REPO_ROOT, "var/enhance-scratch"));
    await fsp.mkdir(scratchRoot, { recursive: true });
    const minOutputBytes = copySource ? sourceStat.size
      : type === "image" ? Math.min(limits.maxOutputBytes, 64 * 1024 ** 2)
        : Math.min(limits.maxOutputBytes, Math.max(64 * 1024 ** 2, sourceStat.size * (model ? 4 : 2)));
    const diskPreflight = await checkDisk(outputDir, scratchRoot, limits,
      { scratchBytes: model ? limits.maxScratchBytes : 0, minOutputBytes });
    limits = { ...limits, maxOutputBytes: diskPreflight.outputMaxBytes };
    scratch = await fsp.mkdtemp(path.join(scratchRoot, "job-"));
    tmpOutput = path.join(outputDir, `.${key}.${randomUUID()}.${type === "image" ? "png" : "mp4"}`);
    tmpMeta = path.join(outputDir, `.${key}.${randomUUID()}.json`);
    let cadence = null;
    if (type === "video") {
      const frameDoc = await probeMedia(input, bins, { frames: true });
      cadence = analyzeCadence((frameDoc.frames || []).map((frame) => frame.best_effort_timestamp_time), source.frameRate, { maxFrames: limits.maxFrames });
      if (source.audio.some((track) => track.startTime !== null && Math.abs(track.startTime) > 0.1)) {
        throw new EnhanceError("音轨有非零起始偏移；当前流式回封拒绝改动该时间线", "timestamp_unsupported");
      }
      if (model) {
        const budget = estimateEnhanceVideoBudget({ sourcePixels: inputPixels, frameCount: cadence.frameCount,
          modelName: model.name, totalTimeoutMs: limits.totalTimeoutMs });
        if (budget?.exceedsBudget) {
          throw new EnhanceError(
            `M3/8 GiB UHD 增强预检预计至少 ${(budget.estimatedSec / 3600).toFixed(1)} 小时，超过本机 ${(budget.budgetSec / 3600).toFixed(1)} 小时工作档；缩短镜头、提高本地算力或改变交付档后重试`,
            "time_budget_exceeded", false, budget,
          );
        }
      }
    }
    const processEvidence = !model
      ? await processNative({ type, input, tmpOutput, source, cadence, bins, limits, target, copySource })
      : type === "image"
        ? await processImage({ input, tmpOutput, scratch, model, bins, engine, limits, target })
        : await enhanceVideoStream({ input, tmpOutput, scratch, model, source, cadence, bins, engine, limits, target });
    const outputProbeDoc = await probeMedia(tmpOutput, bins);
    const verified = await verifyOutput({ kind: type, inputProbe: source, outputProbe: outputProbeDoc, cadence, expected: target, bins, tmpOutput });
    const sourceShaAfter = await sha256File(input);
    if (sourceShaAfter !== sourceSha256) throw new EnhanceError("处理期间源文件内容变化，拒绝登记产物", "source_changed");
    const sha256 = await sha256File(tmpOutput);
    const provenance = {
      schema: ENHANCE_SCHEMA, key, createdAt: new Date().toISOString(), scopeId: spec.scopeId,
      source: { path: input, sha256: sourceSha256, bytes: sourceStat.size, probe: source },
      target, kind: spec.kind, processingMode, model: model?.name || null, modelScale: model?.scale || null,
      engine: engineInfo,
      process: { ...processEvidence, inputCadence: cadence, diskPreflight: diskPreflight.evidence,
        scratchMaxBytes: limits.maxScratchBytes, outputMaxBytes: limits.maxOutputBytes,
        resize: copySource ? "source dimensions retained" : model ? "lanczos contain + black pad; no post-model enlargement" : "lanczos contain + black pad; no AI model" },
      output: { path: output, sha256, bytes: (await fsp.stat(tmpOutput)).size, probe: verified.output },
      checks: verified.checks,
      receipt: { localVerified: true, sha256, sourceSha256, key, output, provenancePath,
        processingMode, model: model?.name || null, modelScale: model?.scale || null, engine: engineInfo,
        diskPreflight: diskPreflight.evidence },
    };
    await fsp.writeFile(tmpMeta, `${JSON.stringify(provenance, null, 2)}\n`, { flag: "wx", mode: 0o600 });
    await fsp.link(tmpOutput, output);
    publishedOutput = true;
    await fsp.unlink(tmpOutput);
    tmpOutput = null;
    await fsp.link(tmpMeta, provenancePath);
    await fsp.unlink(tmpMeta);
    tmpMeta = null;
    return { output, sha256, sourceSha256, key, reused: false, provenancePath, probe: verified.output,
      processingMode, model: provenance.model, modelScale: provenance.modelScale, engine: engineInfo,
      diskPreflight: diskPreflight.evidence, receipt: provenance.receipt };
  } catch (error) {
    if (publishedOutput) await fsp.rm(output, { force: true });
    throw error;
  } finally {
    if (scratch) await fsp.rm(scratch, { recursive: true, force: true });
    if (tmpOutput) await fsp.rm(tmpOutput, { force: true });
    if (tmpMeta) await fsp.rm(tmpMeta, { force: true });
    await fsp.rm(lockPath, { force: true });
  }
}

export async function enhanceImage(options) { return enhance("image", options); }
export async function enhanceVideo(options) { return enhance("video", options); }
