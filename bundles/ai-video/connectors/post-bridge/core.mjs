/**
 * ai-video × 后期交付与返修工位 bridge 内核（core.mjs）
 *
 * 定位（2026-09-24 产品所有者口径）：**镜头生成是贵的，后期是便宜的**——所以
 *   ① 生成期：母版一律**不烧字幕**，字幕以旁挂文件（srt/ass/vtt + 清单）随片交付；
 *   ② 交付期：同一批镜头一次出**多个风格明显不同的变体**（封面 / BGM / 文案 / 调色 / 转场），
 *      让用户在后期**选**而不是让系统替他猜；
 *   ③ 返修期：用户反馈先做**变更影响分析**——能在本地重合成的绝不重新生成镜头；
 *      只有点名到"画面内容"时才走镜头重生成（花钱 → 走人审闸），重生成后照样回到本地合成。
 *
 * 纪律（与 subtitle/color/bgm 三个工位同构）：
 * - 原片只读：任何写入都落到新文件，覆盖原片直接拒绝；版本只增不覆盖（v1 → v2 → v3）；
 * - 无回执=未核实：每个产物带 sha256；"复用"必须给出"未被重算"的证据（哈希 + mtime 未变）；
 * - 不猜：未知的 patch 键、缺失的字体、找不到的曲目一律抛稳定 code 的错误，不静默兜底；
 * - 多版本执行各自声明的风格配方，记录产物与来源，不进行画面或音频品质票决；
 * - 花钱的动作不自动跑：需要重生成镜头时只产出计划 + 审批闸（G8），不擅自烧额度。
 *
 * 依赖关系：本工位是**总装工位**，复用三个专业工位的内核（同仓同 bundle，进程内 import）：
 *   subtitle-bridge/core.mjs  → 旁挂字幕（sidecar）、软字幕轨（softmux）、标题版式
 *   color-bridge/core.mjs     → 声明调色（grade，实际滤镜与产物回执）
 *   bgm-bridge/core.mjs       → 声明选曲与单次混音（findTracks / mix，品质未测为 null）
 */

import { createHash, randomUUID } from "node:crypto";
import { buildSampleAccurateConcatPlan } from "./av-sync.mjs";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { parseRootList } from "../../library/root-list.mjs";
import { fileURLToPath } from "node:url";

import {
  extractFrame, probeMedia, round, runBin, sha256File, tempDir,
} from "../subtitle-bridge/measure.mjs";
import {
  buildAssDocument, buildTransitionTimemap, cuesToSrt, exportSidecars, loadFontCatalog,
  parseSrt, plan as planSubtitle, retimeCuesForTransitions, softMux, srtSecondsToAss, SubtitleError,
} from "../subtitle-bridge/core.mjs";
import { grade as colorGrade } from "../color-bridge/core.mjs";
import { findTracks, loadAllLocalTracks, mix as bgmMix } from "../bgm-bridge/core.mjs";
import { audioStemDigest, renderAudioStems, verifyAudioStemBundle,
  muxAudioProgram, snapshotAudioStemArtifact } from "../bgm-bridge/audio-stems.mjs";
import { createAudioStemReceiptVerifier } from "../bgm-bridge/audio-stems-trust.mjs";
import { displayNamesForDelivery } from "../../library/naming.mjs";
import { findDirectorRecipe, attributeCreativeFeedback, directorHash } from "../../library/director-system/core.mjs";

/* ============================ 工具面与错误 ============================ */

/** 本工位工具面（白名单纪律与其它 bridge 同款：不在表内的工具直接拒绝）。 */
export const POST_TOOLS = [
  "postread.health",
  "postread.plan",
  "postread.impact",
  "postwrite.package",
  "postwrite.reedit",
  "postwrite.triage",
];

const TOOL_SET = new Set(POST_TOOLS);

export function isPostTool(name) {
  return TOOL_SET.has(name);
}

export class PostError extends Error {
  constructor(message, code = "engine_failed", retryable = false) {
    super(message);
    this.name = "PostError";
    this.code = code;
    this.retryable = retryable;
  }
}

export function resolveBinaries(env = process.env) {
  const localKit = path.join(os.homedir(), ".workloom-color", "bin");
  const localBin = (name) => {
    const candidate = path.join(localKit, name);
    try { fs.accessSync(candidate, fs.constants.X_OK); return candidate; }
    catch { return name; }
  };
  return {
    ffmpeg: env.WORKLOOM_POST_FFMPEG_PATH || env.WORKLOOM_SUBTITLE_FFMPEG_PATH || localBin("ffmpeg"),
    ffprobe: env.WORKLOOM_POST_FFPROBE_PATH || env.WORKLOOM_SUBTITLE_FFPROBE_PATH || localBin("ffprobe"),
  };
}

const here = path.dirname(fileURLToPath(import.meta.url));
/** `bundles/ai-video`（连接器目录的上两级）：变体包与 LUT 库都挂在这个 bundle 下。 */
export const BUNDLE_ROOT = path.resolve(here, "../..");
export const VARIANT_DIR = path.join(BUNDLE_ROOT, "library", "style-variants");
export const LUT_DIR = path.join(BUNDLE_ROOT, "library", "luts");
export const FILM_PROJECT_SCHEMA = "workloom.film-project/v1";
export const DELIVERY_SCHEMA = "workloom.delivery-package/v1";

/* ============================ 路径监狱 ============================ */

function isInside(child, parent) {
  const rel = path.relative(parent, child);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

function realpathDeepest(target) {
  let probe = target;
  while (!fs.existsSync(probe)) {
    const parent = path.dirname(probe);
    if (parent === probe) break;
    probe = parent;
  }
  const real = fs.realpathSync(probe);
  return path.join(real, path.relative(probe, target));
}

/** 允许根目录：环境变量优先，缺省只放行进程工作目录与系统临时目录。 */
export function allowedRoots(env = process.env) {
  const list = parseRootList(env.WORKLOOM_POST_ALLOWED_ROOTS, { fallback: [process.cwd(), os.tmpdir()] });
  return list.map((entry) => {
    try {
      return fs.realpathSync(entry);
    } catch {
      return path.resolve(entry);
    }
  });
}

export function assertPathAllowed(target, roots = allowedRoots(), label = "path") {
  if (typeof target !== "string" || !target.trim()) throw new PostError(`${label} 缺失`, "bad_request");
  const resolved = path.resolve(target);
  const real = realpathDeepest(resolved);
  if (!roots.some((root) => isInside(real, root))) {
    throw new PostError(`${label} 不在允许根目录内：${resolved}（可用 WORKLOOM_POST_ALLOWED_ROOTS 追加）`, "path_not_allowed");
  }
  return real;
}

/** 供 CLI 使用的默认工作根（交付包与缓存都在这里，避免污染素材目录）。 */
export function workRoot(env = process.env) {
  const raw = (env.WORKLOOM_POST_WORK_DIR ?? "").trim();
  return raw ? path.resolve(raw) : path.join(os.homedir(), ".workloom-post");
}

/* ============================ 风格变体包（library/style-variants） ============================ */

export function loadVariantIndex(file = path.join(VARIANT_DIR, "index.json")) {
  if (!fs.existsSync(file)) {
    throw new PostError(`风格变体索引不存在：${file}`, "not_configured");
  }
  const doc = JSON.parse(fs.readFileSync(file, "utf8"));
  if (!Array.isArray(doc?.variants) || doc.variants.length === 0) {
    throw new PostError(`风格变体索引为空：${file}`, "not_configured");
  }
  return doc;
}

/** 变体包：一个变体 = 一套「调色 + 转场 + BGM + 封面 + 文案」的完整风格配方。 */
export function findVariantPack(id, { file = path.join(VARIANT_DIR, "index.json") } = {}) {
  const director = findDirectorRecipe(id);
  if (director) return { ...director, _file: path.join(BUNDLE_ROOT,"library/director-system/recipes.json") };
  const index = loadVariantIndex(file);
  const entry = index.variants.find((item) => item.id === id);
  if (!entry) {
    throw new PostError(`未知风格变体：${id}（可用：${index.variants.map((item) => item.id).join(", ")}）`, "bad_recipe");
  }
  const packFile = path.resolve(path.dirname(file), entry.file);
  if (!isInside(packFile, path.dirname(file)) || !fs.existsSync(packFile)) {
    throw new PostError(`变体包文件缺失或越界：${entry.file}`, "not_configured");
  }
  const pack = JSON.parse(fs.readFileSync(packFile, "utf8"));
  if (pack.id !== id) throw new PostError(`变体包 id 与索引不一致：${pack.id} ≠ ${id}`, "bad_recipe");
  return { ...pack, _file: packFile, _index: entry };
}

export function listVariantPacks() {
  const index = loadVariantIndex();
  return index.variants.map((entry) => {
    const pack = findVariantPack(entry.id);
    return {
      id: pack.id,
      name: pack.name,
      positioning: pack.positioning,
      platforms: pack.platforms ?? [],
      color: pack.color ?? null,
      bgm: pack.bgm ?? null,
      transitions: pack.transitions ?? null,
      copy: pack.copy ?? null,
      cover: pack.cover ?? null,
      file: path.relative(BUNDLE_ROOT, pack._file),
    };
  });
}

/** LUT 只允许取仓内 library/luts 下的 .cube（不允许外部路径，避免"偷偷换 look"）。 */
export function resolveLut(fileName) {
  if (!fileName) return null;
  const target = path.resolve(LUT_DIR, String(fileName));
  if (!isInside(target, LUT_DIR)) throw new PostError(`LUT 越界：${fileName}`, "bad_lut");
  if (!fs.existsSync(target)) throw new PostError(`LUT 不存在：${target}`, "bad_lut");
  if (path.extname(target).toLowerCase() !== ".cube") throw new PostError(`LUT 必须是 .cube：${target}`, "bad_lut");
  return target;
}

/* ============================ 素材与工程 ============================ */

function text(value, label, { allowEmpty = false } = {}) {
  if (typeof value !== "string" || (!allowEmpty && !value.trim())) {
    throw new PostError(`${label} 缺失`, "bad_request");
  }
  return value.trim();
}

function optionalNumber(value, fallback = null) {
  if (value === undefined || value === null || value === true || value === "") return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

export const ASPECT_PRESETS = {
  "9:16": [1080, 1920],
  "16:9": [1920, 1080],
  "1:1": [1080, 1080],
  "4:5": [1080, 1350],
};

export const UHD_ASPECT_PRESETS = {
  "9:16": [2160, 3840],
  "16:9": [3840, 2160],
  "1:1": [2160, 2160],
  "4:5": [2160, 2700],
};

export function resolveQuality(project = {}) {
  const quality = project.quality ?? "hd";
  if (quality !== "hd" && quality !== "uhd") {
    throw new PostError(`未知清晰度档位：${quality}（可用：hd / uhd）`, "bad_request");
  }
  return quality;
}

export function resolveResolution(project = {}) {
  const quality = resolveQuality(project);
  const presets = quality === "uhd" ? UHD_ASPECT_PRESETS : ASPECT_PRESETS;
  if (Array.isArray(project.resolution) && project.resolution.length === 2) {
    const [width, height] = project.resolution.map(Number);
    if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0) {
      throw new PostError(`分辨率非法：${JSON.stringify(project.resolution)}`, "bad_request");
    }
    if (quality === "uhd" && !Object.values(UHD_ASPECT_PRESETS).some(([w, h]) => w === width && h === height)) {
      throw new PostError(`uhd 仅支持 ${Object.values(UHD_ASPECT_PRESETS).map((size) => size.join("×")).join("、")}`, "bad_request");
    }
    return [Math.max(2, Math.round(width / 2) * 2), Math.max(2, Math.round(height / 2) * 2)];
  }
  const aspect = String(project.aspect ?? "9:16");
  const preset = presets[aspect];
  if (!preset) {
    throw new PostError(`未知画幅：${aspect}（可用：${Object.keys(presets).join(", ")}）`, "bad_request");
  }
  return preset;
}

/** 交付计划：只读素材与配方，产出"要出哪些变体、差异在哪、预计几步"的计划（不动文件）。 */
export async function planDelivery({
  project = {}, shots = [], variants = null, bins = resolveBinaries(), env = process.env,
} = {}) {
  if (project.creativeMode === "director_auto" || project.deliveryTargetPlan) {
    const { planDirectorDelivery } = await import("./director-delivery.mjs");
    return planDirectorDelivery({project,shots,bins,env});
  }
  const projectId = text(project.projectId ?? project.project_id, "project.projectId");
  if (!Array.isArray(shots) || shots.length === 0) throw new PostError("shots 不能为空（交付要从镜头产物出发）", "bad_request");
  const index = loadVariantIndex();
  const wanted = Array.isArray(variants) && variants.length ? variants : index.defaults ?? index.variants.map((item) => item.id);
  const packs = wanted.map((id) => findVariantPack(id));
  if (packs.length < 2) {
    throw new PostError("多风格交付至少需要 2 个变体（否则用户没得选）", "bad_request");
  }
  const ids = new Set(packs.map((pack) => pack.id));
  if (ids.size !== packs.length) throw new PostError("变体 id 重复", "bad_request");
  const [width, height] = resolveResolution(project);
  const probed = [];
  for (const shot of shots) {
    const file = text(shot.path ?? shot.localPath, "shots[].path");
    if (!fs.existsSync(file)) throw new PostError(`镜头产物不存在：${file}`, "not_found");
    const probe = await probeMedia(file, { bins });
    probed.push({
      shotId: String(shot.shotId ?? shot.shot_id ?? path.basename(file)),
      path: file,
      duration: probe.duration,
      resolution: [probe.width, probe.height],
      hasAudio: probe.hasAudio,
      sha256: await sha256File(file),
    });
  }
  const totalSeconds = round(probed.reduce((acc, shot) => acc + (shot.duration ?? 0), 0), 2);
  return {
    schemaVersion: "workloom.delivery-plan/v1",
    projectId,
    quality: resolveQuality(project),
    resolution: [width, height],
    fps: optionalNumber(project.fps, 30),
    shots: probed,
    totalSeconds,
    variants: packs.map((pack) => ({
      id: pack.id,
      name: pack.name,
      positioning: pack.positioning,
      axes: {
        color: pack.color ? `${pack.color.profile ?? pack.color.lut} @${pack.color.intensity}` : "不调色",
        bgm: pack.bgm?.enabled === false ? "不配乐（保留原声）" : `${pack.bgm?.style ?? pack.bgm?.mood ?? "默认"} · ${pack.bgm?.policy ?? "keep-dialogue"}`,
        transitions: `${pack.transitions?.mode ?? "hard"}${pack.transitions?.fadeSec ? ` ${pack.transitions.fadeSec}s` : ""}`,
        cover: `${pack.cover?.template ?? "默认"} @${pack.cover?.at ?? 0.35}`,
        copy: pack.copy?.tone ?? "默认口吻",
      },
    })),
    steps: [

      "① 归一化镜头（一次，全部变体共用）",
      "② 按变体拼接（转场风格差异）",
      "③ 按声明配方执行一次调色",
      "④ 按声明曲目与参数执行一次混音",
      "⑤ 旁挂字幕包（srt/ass/vtt + 清单，母版不烧字）",
      "⑥ 封面 + 文案包（按变体差异）",
      "⑦ 软字幕轨版（真实视频 copy 与普通流元数据回读）",
      "⑧ 交付清单 + 工程文件（film-project.json，供后续本地返修）",
    ],
    cost: {
      shotGeneration: "复用已有镜头产物（本计划不含镜头生成）",
      tokenCostDelta: 0,
      note: "变体只在后期派生：镜头生成费一次，风格差异不吃 token",
    },
  };
}

/* ============================ 归一化 / 拼接（层 1） ============================ */

async function contentKey(value) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex").slice(0, 16);
}

/**
 * 逐镜归一化：统一 WxH / fps / yuv420p / AAC 48k 立体声，**并按内容哈希缓存**。
 * 缓存命中即复用（不重编码）——这正是"返修不重新生成镜头"的地基：镜头没换，归一化产物就不该重算。
 */
export async function normaliseShots({
  shots = [], project = {}, workDir, bins = resolveBinaries(), reuse = true, force = false, env = process.env,
}) {
  const [width, height] = resolveResolution(project);
  const quality = resolveQuality(project);
  const fps = optionalNumber(project.fps, 30);
  if (!Number.isFinite(fps) || fps <= 0 || fps > 240) throw new PostError("请求导出帧率无效", "bad_request");
  // Authorize before creating any output, and keep OS aliases above an allowed root
  // (macOS /var -> /private/var) distinct from forbidden symlinks below that root.
  const roots = allowedRoots(env);
  const lexicalWork = path.resolve(text(workDir, "workDir"));
  const canonicalWork = assertPathAllowed(lexicalWork, roots, "workDir");
  const root = roots.find(entry => isInside(canonicalWork, entry));
  let lexicalRoot = lexicalWork;
  while (realpathDeepest(lexicalRoot) !== root) {
    const parent = path.dirname(lexicalRoot);
    if (parent === lexicalRoot) throw new PostError("工作目录别名无法绑定允许根", "path_not_allowed");
    lexicalRoot = parent;
  }
  let component = lexicalRoot;
  for (const part of path.relative(lexicalRoot, path.join(lexicalWork, "norm")).split(path.sep).filter(Boolean)) {
    component = path.join(component, part);
    try {
      if (fs.lstatSync(component).isSymbolicLink()) throw new PostError("工作目录不允许符号链接", "path_not_allowed");
    } catch (error) { if (error.code !== "ENOENT") throw error; }
  }
  const dir = path.join(canonicalWork, "norm");
  await fsp.mkdir(dir, { recursive: true });
  const out = [];
  const ids = new Set();
  for (const shot of shots) {
    const source = assertPathAllowed(text(shot.path ?? shot.localPath, "shots[].path"), allowedRoots(env));
    if (!fs.existsSync(source)) throw new PostError(`镜头产物不存在：${source}`, "not_found");
    const shotId = String(shot.shotId ?? shot.shot_id ?? path.basename(source));
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(shotId) || ids.has(shotId)) throw new PostError("镜头 ID 缺失、非法或重复", "bad_request");
    ids.add(shotId);
    const sourceHash = await sha256File(source);
    const snapshotDir = await fsp.mkdtemp(path.join(dir, ".source-"));
    const frozenSource = (await snapshotAudioStemArtifact({ file: source, sha256: sourceHash,
      output: path.join(snapshotDir, "original"), allowedRoots: allowedRoots(env) })).path;
    const probe = await probeMedia(frozenSource, { bins });
    const sourceDuration = probe.videoDuration;
    if (!(sourceDuration > 0) || !(probe.width > 0) || !(probe.height > 0)) throw new PostError(`镜头 ${shotId} 缺视频流元数据`, "bad_media");
    const duration = optionalNumber(shot.durationSec ?? shot.duration, sourceDuration);
    if (!Number.isFinite(duration) || duration <= 0) throw new PostError(`镜头 ${shotId} 请求时长无效`, "bad_request");
    const sourceKind = String(shot.kind ?? project.sourceKind ?? project.mediaKind ?? "live-action");
    const enhancement = { status: "normalized", sourceResolution: [probe.width, probe.height], outputResolution: [width, height],
      sourceSha256: sourceHash, processingMode: "local-resize", model: null, qualityReviewed: false };
    const key = await contentKey({ sourceHash, width, height, fps, quality, duration, v: 4 });
    const target = path.join(dir, `${shotId}-${key}.mp4`);
    const receiptPath = `${target}.json`;
    const validOutput = (media) => media.width === width && media.height === height && media.hasAudio
      && media.videoCodec === "h264" && media.audioCodec === "aac" && media.videoDuration > 0
      && Math.abs((media.fps ?? 0) - fps) < 0.01 && Math.abs(media.videoDuration - duration) <= Math.max(0.05, 1 / fps);
    if (reuse && !force && fs.existsSync(target)) {
      let receipt;
      try { receipt = JSON.parse(await fsp.readFile(receiptPath, "utf8")); }
      catch (error) { throw new PostError(`归一化缓存回执不可读：${error.message}`, "verify_failed"); }
      const stat = await fsp.stat(target);
      const cachedHash = await sha256File(target);
      const metadata = await probeMedia(target, { bins });
      if (receipt.key !== key || receipt.sourceSha256 !== sourceHash || receipt.outputSha256 !== cachedHash
        || receipt.bytes !== stat.size || !validOutput(metadata) || await sha256File(source) !== sourceHash) {
        throw new PostError(`归一化缓存内容或请求规格不符：${target}`, "verify_failed");
      }
      out.push({ shotId, source, sourceHash, sourceDuration, sourceHasAudio: probe.hasAudio, audioStems: shot.audioStems ?? null, sourceKind, enhancement, quality,
        path: target, reused: true, sha256: cachedHash, bytes: stat.size, mtimeMs: Math.round(stat.mtimeMs), duration: metadata.videoDuration });
      continue;
    }
    const video = `scale=${width}:${height}:force_original_aspect_ratio=decrease,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2:color=black,setsar=1,fps=${fps},format=yuv420p,tpad=stop_mode=clone:stop_duration=${duration},trim=duration=${duration},setpts=PTS-STARTPTS`;
    const audio = `aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo,apad,atrim=duration=${duration},asetpts=N/SR/TB`;
    const args = ["-hide_banner", "-v", "error", "-n", "-filter_threads", "1", "-i", frozenSource];
    if (!probe.hasAudio) args.push("-f", "lavfi", "-i", "anullsrc=channel_layout=stereo:sample_rate=48000");
    const tempTarget = path.join(dir, `${shotId}-${key}.${randomUUID()}.tmp.mp4`);
    args.push("-map", "0:v:0", "-map", probe.hasAudio ? "0:a:0" : "1:a:0", "-vf", video, "-af", audio,
      "-c:v", "libx264", "-preset", quality === "uhd" ? "medium" : "veryfast", "-crf", quality === "uhd" ? "16" : "18",
      "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "192k", "-ar", "48000", "-ac", "2", "-t", String(duration), "-movflags", "+faststart", tempTarget);
    try {
      await runBin(bins.ffmpeg, args, { label: "ffmpeg(normalise)", timeoutMs: 900_000 });
      const stat = await fsp.stat(tempTarget);
      const media = await probeMedia(tempTarget, { bins });
      if (!stat.size || !validOutput(media)) throw new PostError(`镜头 ${shotId} 实际归一化产物不符合请求规格`, "verify_failed");
      const outputHash = await sha256File(tempTarget);
      if (await sha256File(source) !== sourceHash) throw new PostError(`镜头 ${shotId} 原字节在处理期间变化`, "verify_failed");
      await fsp.rename(tempTarget, target);
      await writeJson(receiptPath, { key, sourceSha256: sourceHash, inputSha256: sourceHash, outputSha256: outputHash,
        bytes: stat.size, width, height, fps, durationSec: media.videoDuration, hasAudio: true, qualityReviewed: false });
      out.push({ shotId, source, sourceHash, sourceDuration, sourceHasAudio: probe.hasAudio, audioStems: shot.audioStems ?? null, sourceKind, enhancement, quality,
        path: target, reused: false, sha256: outputHash, bytes: stat.size, mtimeMs: Math.round((await fsp.stat(target)).mtimeMs), duration: media.videoDuration });
    } finally { await fsp.rm(tempTarget, { force: true }); }
  }
  return out;
}

/**
 * 拼接（层 2）：三种转场口径，全部走"先归一化后拼接"，避免异构编码直接 concat 花屏。
 * - hard：concat demuxer 无损直拼（最快，适合快节奏信息流）；
 * - fade：逐镜淡入淡出后直拼（情绪连贯，适合叙事/文旅）；
 * - xfade：真交叉溶解（镜头之间重叠过渡，最"精致"但需重编码）。
 */
/** 按各段请求时长完成视频 copy、音轨 trim/pad、合流和普通元数据回读。
 * 记录真实时间线处理，不做 PCM 互相关、口型或源片品质复检。
 */
async function assembleSampleAccurate({
  bins, list, clips, output, workDir, fps = 30, verify = true, allowUnverified = false,
}) {
  // 归一化产物使用 duration；音画模块使用 durationSec。实际命令必须共享同一请求时长。
  const measuredClips = clips.map((clip) => ({
    ...clip, durationSec: Number(clip.durationSec ?? clip.duration ?? 0),
  }));
  if (measuredClips.some((clip) => !Number.isFinite(clip.durationSec) || clip.durationSec <= 0)) {
    throw new PostError("样点级拼接需要每个镜头的有效时长", "bad_media");
  }
  const plan = buildSampleAccurateConcatPlan({ listFile: list, clips: measuredClips, output, workDir, fps });
  await fsp.writeFile(list, plan.concatList, "utf8");
  await runBin(bins.ffmpeg, plan.videoArgs, { label: "ffmpeg(concat-video)", timeoutMs: 900_000 });
  await runBin(bins.ffmpeg, plan.audioArgs, { label: "ffmpeg(concat-audio)", timeoutMs: 900_000 });
  await runBin(bins.ffmpeg, plan.muxArgs, { label: "ffmpeg(concat-mux)", timeoutMs: 900_000 });
  const metadata = await probeMedia(output, { bins });
  const expectedDuration = measuredClips.reduce((sum, clip) => sum + clip.durationSec, 0);
  if (!metadata.hasAudio || !(metadata.videoDuration > 0) || Math.abs(metadata.videoDuration - expectedDuration) > Math.max(0.05, 1 / fps)) {
    throw new PostError("实际拼接产物缺音视频或请求时间线不符", "verify_failed");
  }
  const report = { schemaVersion: "workloom.composition-process/v1", processingSucceeded: true,
    audioAlignmentMeasured: false, qualityReviewed: false, durationSec: metadata.videoDuration, expectedDurationSec: expectedDuration,
    note: "按请求时间线处理；未做源片内容、声音质量或互相关复检" };
  await writeAvSyncReport(output, report);
  return report;
}

/** 时间线处理回执落地（与基座 CLI 同口径：`<输出>.av-sync.json`，便于发布方/审计复核）。 */
async function writeAvSyncReport(output, payload) {
  const target = `${output.replace(/\.mp4$/i, "")}.av-sync.json`;
  try {
    await fsp.writeFile(target, `${JSON.stringify({ generatedAt: new Date().toISOString(), output, ...payload }, null, 2)}\n`, "utf8");
  } catch (error) {
    throw new PostError(`时间线处理回执写入失败：${target}：${error instanceof Error ? error.message : String(error)}`, "io_failed");
  }
}

export async function assembleTimeline({
  clips = [], transitions = {}, output, resolution, fps = 30, quality = "hd", bins = resolveBinaries(),
}) {
  if (!Array.isArray(clips) || clips.length === 0) throw new PostError("拼接需要至少一个镜头", "bad_request");
  const mode = String(transitions.mode ?? "hard");
  const fadeSec = Math.max(0.05, optionalNumber(transitions.fadeSec, 0.5));
  const [width, height] = resolution ?? [1080, 1920];
  if (!["hd", "uhd"].includes(quality)) throw new PostError(`未知清晰度档位：${quality}`, "bad_request");
  const videoEncode = quality === "uhd"
    ? ["-c:v", "libx264", "-preset", "medium", "-crf", "16", "-threads", "2", "-pix_fmt", "yuv420p"]
    : ["-c:v", "libx264", "-preset", "veryfast", "-crf", "18", "-pix_fmt", "yuv420p"];
  for (const clip of clips) {
    if (!fs.existsSync(clip.path)) throw new PostError(`归一化产物缺失：${clip.path}`, "not_found");
  }
  await fsp.mkdir(path.dirname(path.resolve(output)), { recursive: true });
  const dir = path.join(path.dirname(path.resolve(output)), "assemble");
  await fsp.mkdir(dir, { recursive: true });

  if (mode === "hard" || clips.length === 1) {
    const list = path.join(dir, "concat.txt");
    /**
     * 硬切拼接的**音画对齐纪律**（2026-09-26 真机事故修复，与基座 compose-film 同口径）：
     * 逐段 aac 音轨按 1024 样点成帧、末帧向上取整 → 每段音轨比画面长 0–21ms；
     * `-f concat -c copy` 让 demuxer 按各自流的时长累计偏移 → 声音逐镜漂移（真机尾镜 +125ms）。
     * 现在：画面仍 `-c:v copy`（帧级无损），声音改走 **concat 滤镜**并按画面时长 atrim+apad 到精确长度，再合流。
     */
    const avSync = await assembleSampleAccurate({
      bins, list, clips, output, workDir: dir, fps,
      verify: transitions.verifyAvSync !== false,
      allowUnverified: transitions.allowUnverifiedAvSync === true,
    });
    return { output, mode, fadeSec: 0, shots: clips.length, avSync };
  }

  if (mode === "fade") {
    const parts = [];
    for (const [index, clip] of clips.entries()) {
      const duration = Number(clip.duration ?? 0);
      const fade = Math.min(fadeSec, Math.max(0.05, duration / 3));
      const target = path.join(dir, `fade-${index}.mp4`);
      await runBin(bins.ffmpeg, [
        "-hide_banner", "-v", "error", "-y", "-i", clip.path,
        "-vf", `fade=t=in:st=0:d=${fade},fade=t=out:st=${round(Math.max(0, duration - fade), 3)}:d=${fade}`,
        "-af", `afade=t=in:st=0:d=${fade},afade=t=out:st=${round(Math.max(0, duration - fade), 3)}:d=${fade}`,
        ...videoEncode,
        "-c:a", "aac", "-b:a", "192k", "-ar", "48000", "-ac", "2",
        target,
      ], { label: "ffmpeg(fade)", timeoutMs: 900_000 });
      parts.push(target);
    }
    const list = path.join(dir, "fade-concat.txt");
    /** 淡入淡出路径同样按样点级对齐拼接（各段已重编码，长度口径以各自的 durationSec 为准） */
    const avSync = await assembleSampleAccurate({
      bins, list,
      clips: await Promise.all(clips.map(async (clip, index) => {
        const file = parts[index] ?? clip.path;
        const fadedProbe = await probeMedia(file, { bins });
        if (!(fadedProbe.videoDuration > 0)) {
          throw new PostError(`淡化镜头 ${clip.shotId} 缺视频轨时长`, "bad_media");
        }
        return { ...clip, path: file, duration: fadedProbe.videoDuration };
      })),
      output, workDir: dir, fps,
      verify: transitions.verifyAvSync !== false,
      allowUnverified: transitions.allowUnverifiedAvSync === true,
    });
    return { output, mode, fadeSec: round(fadeSec, 3), shots: clips.length, avSync };
  }

  if (mode !== "xfade") throw new PostError(`未知转场模式：${mode}（可用：hard / fade / xfade）`, "bad_request");

  const durations = clips.map((clip) => Number(clip.duration ?? 0));
  if (durations.some((value) => !(value > 0))) {
    throw new PostError("xfade 需要每个镜头的时长（时长缺失无法算重叠点）", "bad_media");
  }
  const filters = [];
  const videoInputs = clips.map((_, index) => (index === 0 ? "[0:v]" : null));
  let lastVideo = "[0:v]";
  let lastAudio = "[0:a]";
  let offset = durations[0];
  for (let index = 1; index < clips.length; index += 1) {
    const fade = Math.min(fadeSec, Math.max(0.05, Math.min(durations[index], durations[index - 1]) / 2));
    offset = round(offset - fade, 3);
    const videoOut = index === clips.length - 1 ? "[vout]" : `[v${index}]`;
    const audioOut = index === clips.length - 1 ? "[aout]" : `[a${index}]`;
    filters.push(`${lastVideo}[${index}:v]xfade=transition=fade:duration=${fade}:offset=${offset}${videoOut}`);
    filters.push(`${lastAudio}[${index}:a]acrossfade=d=${fade}:c1=tri:c2=tri${audioOut}`);
    lastVideo = videoOut;
    lastAudio = audioOut;
    offset += durations[index];
  }
  void videoInputs;
  const args = ["-hide_banner", "-v", "error", "-y"];
  for (const clip of clips) args.push("-i", clip.path);
  args.push(
    "-filter_complex", filters.join(";"),
    "-map", "[vout]", "-map", "[aout]",
    ...videoEncode,
    "-c:a", "aac", "-b:a", "192k", "-ar", "48000", "-ac", "2",
    "-s", `${width}x${height}`, "-r", String(fps), "-movflags", "+faststart", output,
  );
  await runBin(bins.ffmpeg, args, { label: "ffmpeg(xfade)", timeoutMs: 1_800_000 });
  const metadata = await probeMedia(output, { bins });
  if (!metadata.hasAudio || !(metadata.videoDuration > 0) || metadata.width !== width || metadata.height !== height) {
    throw new PostError("实际转场产物缺音视频或画布规格不符", "verify_failed");
  }
  const avSync = { schemaVersion: "workloom.composition-process/v1", processingSucceeded: true,
    audioAlignmentMeasured: false, qualityReviewed: false, durationSec: metadata.videoDuration };
  await writeAvSyncReport(output, avSync);
  return { output, mode, fadeSec: round(fadeSec, 3), shots: clips.length, avSync };
}

/** 旧口径转场（整段 mode/fadeSec）→ 逐刀口径；非 xfade 视为全部硬切。 */
function legacyTransitionCuts(clips = [], transitions = {}) {
  if (String(transitions?.mode ?? "hard") !== "xfade") return [];
  const fadeSec = Math.max(0.05, Number(transitions?.fadeSec ?? 0.5));
  return clips.slice(1).map((clip) => ({ incomingSegmentId: String(clip.shotId), durationSeconds: fadeSec }));
}

/* ============================ 音频层（选曲 + 混音） ============================ */

/** 确定性选曲：按变体包的曲风/情绪过滤本地曲库，排序后取第一首可商用且文件在位者。 */
export function pickTrackForVariant(variant, { env = process.env } = {}) {
  const requestedStyle = String(variant.bgm?.style ?? "").trim().toLowerCase();
  const query = {};
  if (variant.bgm?.mood) query.mood = variant.bgm.mood;
  if (variant.bgm?.genre) query.genre = variant.bgm.genre;
  if (variant.bgm?.trackId) query.trackId = variant.bgm.trackId;
  /**
   * 指定曲目：走 `findTracks({ trackId })`——它会做许可可商用校验，找不到/不合规都如实报错。
   */
  if (variant.bgm?.trackId) {
    const byId = findTracks(query, env);
    const hit = byId.track ?? byId.items[0];
    if (!hit) throw new PostError(`曲库中未找到可用曲目：${variant.bgm.trackId}`, "not_found");
    return hit;
  }
  /**
   * 曲风（style）检索：`findTracks` 只按 mood/genre/id 过滤，而用户与配方说的是
   * "corporate-clean / sports-hype 那种风格"。这里直接在**全量曲库**上按风格关键词匹配
   * （id / style / genre / mood / tags / styleLabel 任一命中），再逐首过许可校验——
   * 不能只在前 20 条搜索结果里找风格（1034 首的库会漏）。找不到就如实报错，不静默换风格不符的曲目。
   */
  if (requestedStyle) {
    const library = loadAllLocalTracks(env);
    const matches = library.tracks
      .map((track) => ({
        track,
        haystack: [track.id, track.style, track.styleLabel, track.genre, track.mood,
          ...(Array.isArray(track.tags) ? track.tags : [])]
          .filter(Boolean).join(" ").toLowerCase(),
      }))
      .filter((entry) => entry.haystack.includes(requestedStyle))
      /**
       * 本地大曲库优先、随仓 50 首兜底（产品所有者口径 2026-10-11）：
       * 同风格候选中先排 `library-local`（工位/客户/自动发现），`library-curated` 恒排最后；
       * 同来源再按 id 稳定排序（可复现）。
       */
      .sort((a, b) => {
        const rank = (track) => (track.libraryKind === "local-curated" ? 1 : 0);
        const delta = rank(a.track) - rank(b.track);
        return delta !== 0 ? delta : String(a.track.id).localeCompare(String(b.track.id));
      });
    if (matches.length === 0) {
      throw new PostError(
        `曲库里没有「${variant.bgm.style}」风格的曲目：请换一个风格关键词（可用风格见 library/bgm-library-curated/tracks.json 的 style 字段）`,
        "not_found",
      );
    }
    for (const entry of matches) {
      try {
        const verified = findTracks({ trackId: entry.track.id }, env);
        const hit = verified.track ?? verified.items[0];
        if (hit) return hit;
      } catch {
        /* 该曲目许可不合规/文件缺失：继续找同风格的下一首（不静默降级，最终全不过就报错） */
      }
    }
    throw new PostError(
      `风格「${variant.bgm.style}」下 ${matches.length} 首曲目都不满足许可/文件要求：请补曲库或换风格`,
      "license_blocked",
    );
  }
  const result = findTracks(query, env);
  if (!result.items?.length) {
    throw new PostError(
      `曲库中没有匹配变体「${variant.id}」的可用曲目（mood=${variant.bgm?.mood ?? "—"} / style=${variant.bgm?.style ?? "—"}）：`
      + `${result.note ?? "请先接入曲库"}`,
      "not_found",
    );
  }
  const styleHit = (item) => {
    if (!requestedStyle) return 1;
    const haystack = [item.id, item.genre, item.mood, ...(Array.isArray(item.tags) ? item.tags : [])]
      .filter(Boolean).join(" ").toLowerCase();
    return haystack.includes(requestedStyle) ? 2 : 0;
  };
  const ranked = [...result.items]
    .map((item) => ({
      item,
      styleHit: styleHit(item),
    }))
    .sort((a, b) => (b.styleHit - a.styleHit) || String(a.item.id).localeCompare(String(b.item.id)));
  const usable = ranked.filter((entry) => entry.item.fileExists !== false && entry.item.path);
  if (requestedStyle && usable.every((entry) => entry.styleHit === 0)) {
    throw new PostError(
      `曲库里没有「${variant.bgm.style}」风格的可用曲目：请换一个风格关键词，或改用 mood/genre 检索`,
      "not_found",
    );
  }
  const chosen = usable[0]?.item;
  if (!chosen) {
    throw new PostError(`匹配到的曲目在工位上都不可用（文件缺失）：${result.items.map((item) => item.id).join(", ")}`, "not_found");
  }
  return chosen;
}

/* ============================ 封面与文案 ============================ */

export function buildCopyPack({ project = {}, variant = {} }) {
  const base = project.copy ?? {};
  const tone = variant.copy ?? {};
  const titleTemplate = tone.titleTemplate ?? "{title}";
  const title = String(titleTemplate)
    .replaceAll("{title}", String(base.title ?? project.title ?? ""))
    .replaceAll("{hook}", String(base.hook ?? ""));
  const hook = String(base.hook ?? "");
  const body = [tone.opening, String(base.body ?? ""), tone.closing].filter(Boolean).join("\n\n");
  const hashtags = Array.isArray(tone.hashtags) && tone.hashtags.length ? tone.hashtags : (Array.isArray(base.hashtags) ? base.hashtags : []);
  const cta = tone.cta ?? base.cta ?? "";
  const checks = [
    { kind: "title_length", ok: title.length > 0 && title.length <= 55, detail: { length: title.length, limit: 55, basis: "抖音标题上限 55 字（含标点）" } },
    { kind: "hook_present", ok: hook.length > 0, detail: { length: hook.length } },
    { kind: "hashtags", ok: hashtags.length >= 3 && hashtags.length <= 8, detail: { count: hashtags.length, basis: "3–8 个，避免标签堆砌" } },
    { kind: "cta_present", ok: cta.length > 0, detail: { length: cta.length } },
  ];
  const markdown = [
    `# ${title}`,
    "",
    `- 风格变体：${variant.name ?? variant.id ?? "—"}`,
    `- 口吻：${tone.tone ?? "默认"}`,
    "",
    "## 开头钩子",
    hook || "—",
    "",
    "## 正文",
    body || "—",
    "",
    "## 话题标签",
    hashtags.join(" ") || "—",
    "",
    "## 行动号召",
    cta || "—",
    "",
    "## 交付校验",
    ...checks.map((check) => `- ${check.kind}: ${check.ok ? "ok" : "fail"} ${JSON.stringify(check.detail)}`),
    "",
  ].join("\n");
  return { title, hook, body, hashtags, cta, tone: tone.tone ?? null, checks, markdown };
}

/**
 * 封面：从已调色母版抽一帧 → 按平台版式渲标题（与字幕同源字体/字号体系）→ PNG。
 * 按指定时点与文字实际渲染，核对请求画布、字体解析和产物摘要，不按源帧亮度或墨迹评分。
 */
export async function buildCover({
  input, output, project = {}, variant = {}, resolution, platform = null,
  bins = resolveBinaries(), workDir, catalog = loadFontCatalog(),
}) {
  const probe = await probeMedia(input, { bins });
  const duration = probe.videoDuration ?? probe.duration;
  if (!(duration > 0)) throw new PostError("封面来源缺视频轨时长", "bad_media");
  const maxAt = Math.max(0, duration - 0.1);
  const requestedAt = round(Math.min(maxAt, Math.max(0, duration * optionalNumber(variant.cover?.at, 0.35))), 3);
  const dir = path.join(workDir, "cover");
  await fsp.mkdir(dir, { recursive: true });
  const at = requestedAt;
  const frame = await extractFrame({ input, at, output: path.join(dir, `${variant.id}-frame.png`), bins });
  const background = { status: "not-reviewed", qualityReviewed: false };
  const titleLine = String(project.copy?.title ?? project.title ?? project.projectId ?? "");
  const hookLine = String(variant.cover?.subtitle ?? project.copy?.hook ?? "");
  const titleText = [titleLine, hookLine].filter(Boolean).join("\\N");
  const planOutcome = await planSubtitle({
    input: null,
    resolution,
    brief: { 平台: platform ?? project.platform ?? "默认", 内容调性: variant.copy?.tone ?? null },
    platform: platform ?? project.platform ?? null,
    titleText: titleLine,
    cues: [],
    scenes: ["标题"],
    catalog,
    bins,
    outputDir: dir,
    analyze: false,
  });
  const styles = planOutcome.styles.map((entry) => {
    if (entry.name !== "Title") return entry;
    const alignment = Number(variant.cover?.alignment ?? entry.style.alignment ?? 8);
    return {
      name: entry.name,
      style: {
        ...entry.style,
        alignment,
        marginV: Math.round((resolution?.[1] ?? 1920) * Number(variant.cover?.marginRatio ?? 0.08)),
      },
    };
  });
  const assText = buildAssDocument({
    resolution: resolution ?? [probe.width, probe.height],
    styles,
    events: [{
      layer: 0,
      start: srtSecondsToAss(0),
      end: srtSecondsToAss(3),
      style: "Title",
      name: variant.id,
      text: titleText || titleLine,
    }],
  });
  const assPath = path.join(dir, `${variant.id}-cover.ass`);
  await fsp.writeFile(assPath, assText, "utf8");
  const fontsDir = path.join(dir, "fonts-flat");
  await fsp.mkdir(fontsDir, { recursive: true });
  const fontFiles = [];
  const bundled = path.resolve(BUNDLE_ROOT, "library", "fonts");
  for (const sub of ["cn", "en"]) {
    const folder = path.join(bundled, sub);
    if (!fs.existsSync(folder)) continue;
    for (const file of await fsp.readdir(folder)) {
      if (!/\.(ttf|otf|ttc)$/i.test(file)) continue;
      const source = path.join(folder, file);
      const target = path.join(fontsDir, file);
      if (!fs.existsSync(target)) await fsp.copyFile(source, target);
      fontFiles.push(target);
    }
  }
  if (fontFiles.length === 0) throw new PostError(`封面渲染缺少字体（${bundled}）`, "font_not_found");
  const overlay = `ass=${assPath.replaceAll("\\", "\\\\").replaceAll(":", "\\:").replaceAll("'", "\\'")}:fontsdir=${fontsDir.replaceAll("\\", "\\\\").replaceAll(":", "\\:").replaceAll("'", "\\'")}`;
  await runBin(bins.ffmpeg, [
    "-hide_banner", "-v", "info", "-y", "-loop", "1", "-i", frame,
    "-vf", overlay, "-frames:v", "1", "-update", "1", output,
  ], { label: "ffmpeg(cover)", timeoutMs: 300_000 });
  if (!fs.existsSync(output)) throw new PostError(`封面未产出：${output}`, "ffmpeg_failed", true);
  const coverProbe = await probeMedia(output, { bins });
  const coverPlanChecks = planOutcome.checks.filter((check) => check.ok === false);
  const checks = [
    { kind: "cover_size", ok: coverProbe.width === (resolution?.[0] ?? coverProbe.width) && coverProbe.height === (resolution?.[1] ?? coverProbe.height), detail: { width: coverProbe.width, height: coverProbe.height } },
    { kind: "cover_title_present", ok: Boolean(titleText), detail: { text: titleText.replace("\\N", " / ") } },
    { kind: "cover_layout", ok: coverPlanChecks.length === 0, detail: coverPlanChecks.map((check) => check.kind) },

  ];
  return {
    output,
    at,
    requestedAt,
    background,
    frame,
    assPath,
    text: titleText.replace("\\N", " / "),
    fontsDir,
    width: coverProbe.width,
    height: coverProbe.height,
    sha256: await sha256File(output),
    bytes: (await fsp.stat(output)).size,
    checks,
  };
}

/* ============================ 交付包（主流程） ============================ */

/**
 * 封面两两差异（2026-10-11 客户反馈"几个版本的封面都还是用的同一个封面"）：
 * 缩到 64×36 灰度求平均绝对差（MAD）。identical（sha 相同）/ near-duplicate（<2）判硬失败，
 * similar（<6）在回执里提示——旧实现的 coverDivergence 是空占位，拦不住"两张一样的封面"。
 */
async function imageDivergence(a, b, bins) {
  const [hashA, hashB] = [await sha256File(a), await sha256File(b)];
  if (hashA === hashB) return { meanAbsDiff: 0, verdict: "identical" };
  const dir = await tempDir("workloom-cover-divergence-");
  const rawFile = path.join(dir, "diff.raw");
  await runBin(bins.ffmpeg, [
    "-hide_banner", "-loglevel", "error", "-y", "-i", a, "-i", b,
    "-lavfi", "[0:v]scale=64:36,format=gray[x];[1:v]scale=64:36,format=gray[y];[x][y]blend=all_mode=difference",
    "-frames:v", "1", "-f", "rawvideo", "-pix_fmt", "gray", rawFile,
  ], { label: "ffmpeg(cover-divergence)" });
  const bytes = await fsp.readFile(rawFile);
  if (!bytes.length) return { meanAbsDiff: Number.NaN, verdict: "similar" };
  let total = 0;
  for (const value of bytes) total += value;
  const meanAbsDiff = round(total / bytes.length, 2);
  if (meanAbsDiff < 2) return { meanAbsDiff, verdict: "near-duplicate" };
  if (meanAbsDiff < 6) return { meanAbsDiff, verdict: "similar" };
  return { meanAbsDiff, verdict: "distinct" };
}

async function writeJson(file, value) {
  await fsp.mkdir(path.dirname(file), { recursive: true });
  await fsp.writeFile(file, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  return file;
}

async function assertStoredArtifact(file, expectedSha256, label) {
  if (!file || !/^[a-f0-9]{64}$/.test(expectedSha256 ?? "") || !fs.existsSync(file)) {
    throw new PostError(`${label} 缺文件或 SHA-256 回执，不能声明复用`, "verify_failed");
  }
  if (await sha256File(file) !== expectedSha256) {
    throw new PostError(`${label} 哈希与工程文件不一致，不能声明复用`, "verify_failed");
  }
}

function assertBgmReportPassed(report) {
  if (report?.checks?.processingSucceeded !== true || !report.output?.hash) {
    throw new PostError("请求的混音未形成实际处理产物回执", "verify_failed");
  }
}

/** Source scope is the generation/script revision, not the local post-edit counter. */
function audioScope(project) {
  const scope = project.audioScope;
  if (!scope) return null;
  if (!scope || scope.projectId !== (project.projectId ?? project.project_id)
    || (project.tenantId != null && project.tenantId !== scope.tenantId)
    || (project.workspaceId != null && project.workspaceId !== scope.workspaceId)) {
    throw new PostError("缺少与工程归属一致的 project.audioScope", "audio_stems_source_unverified");
  }
  return scope;
}
function stemReference(bundle, base = null) {
  if (!bundle) return null;
  return { dir: base ? path.relative(base, bundle.dir) : bundle.dir,
    manifestSha256: bundle.manifestSha256, recipeSha256: bundle.recipeSha256, scope: bundle.recipe.scope };
}
function restoreStemReference(reference, base) {
  return reference ? { ...reference, dir: resolveStored(base, reference.dir) } : null;
}
function descriptorsFromBundle(bundle) {
  const byShot = {};
  for (const source of bundle.sources) {
    const b = source.binding;
    (byShot[b.shotId] ??= {})[b.role] = b.status === "ready" ? {
      status: "ready", sourceKind: b.sourceKind, sha256: b.sourceSha256,
      path: path.join(bundle.dir, source.snapshot.path), receipt: source.receipt,
      offsetSec: b.offsetSamples / b.sampleRate, inSec: b.inSamples / b.sampleRate,
      ...(b.takeSamples === null ? {} : { durationSec: b.takeSamples / b.sampleRate }),
    } : { status: "not_applicable", reason: b.reason, receipt: source.receipt };
  }
  return byShot;
}
async function verifyStoredStems(reference, project, base, env, bins) {
  const restored = restoreStemReference(reference, base);
  if (!restored || audioStemDigest(restored.scope) !== audioStemDigest(audioScope(project))) {
    throw new PostError("独立音轨与当前工程作用域不一致", "audio_stems_source_unverified");
  }
  return verifyAudioStemBundle({ dir: restored.dir, expectedManifestSha256: restored.manifestSha256,
    expectedRecipeSha256: restored.recipeSha256, scope: audioScope(project),
    verifySource: createAudioStemReceiptVerifier({ env, expectedTenant: env.WORKLOOM_POST_BRIDGE_TENANT }), allowedRoots: allowedRoots(env), bins });
}

async function timelineStems({ project, clips, transitions, cuts = null, padToSeconds = null, workDir, env, bins }) {
  if (clips.every((clip) => !clip.audioStems)) return null;
  if (clips.some((clip) => !clip.audioStems) || !audioScope(project)) throw new PostError("显式独立音轨需要完整镜头引用与工程作用域", "audio_stems_source_unverified");
  const shots = clips.map((clip) => ({ shotId: clip.shotId, videoSha256: clip.sourceHash,
    normalisedVideoSha256: clip.sha256, sourceDurationSec: clip.sourceDuration,
    durationSec: clip.duration, stems: clip.audioStems }));
  // Normalization is run from an owned original snapshot; hashes/durations here are measured, never caller assertions.
  for (const clip of clips) await assertStoredArtifact(clip.path, clip.sha256, `独立音轨画面 ${clip.shotId}`);
  return renderAudioStems({ scope: audioScope(project), shots, transitions, cuts, padToSeconds,
    outDir: path.join(workDir, "audio-stems", randomUUID()), allowedRoots: allowedRoots(env),
    verifySource: createAudioStemReceiptVerifier({ env, expectedTenant: env.WORKLOOM_POST_BRIDGE_TENANT }), bins });
}
async function cleanProgramOutput({ gradedInput, stems, output, env, bins }) {
  if (!stems) {
    await fsp.mkdir(path.dirname(output), { recursive: true });
    return snapshotAudioStemArtifact({ file: gradedInput, sha256: await sha256File(gradedInput), output, allowedRoots: allowedRoots(env) });
  }
  const reauthorize = async () => {
    const verify = createAudioStemReceiptVerifier({ env, expectedTenant: env.WORKLOOM_POST_BRIDGE_TENANT });
    for (const { binding, bindingSha256, receipt, receiptSha256 } of stems.sources) {
      await verify({ binding, bindingSha256, receipt, receiptSha256 });
    }
  };
  await reauthorize();
  const result = await muxAudioProgram({ videoPath: gradedInput, videoSha256: await sha256File(gradedInput),
    programPath: stems.program.path, programSha256: stems.program.sha256, output,
    allowedRoots: allowedRoots(env), bins });
  try { await reauthorize(); }
  catch (error) { await fsp.unlink(output); throw error; }
  return result;
}

/** Actual remixes are always rebuilt. A self-reported mixer cache cannot authorize output bytes. */
async function mixVariantAudio({ pack, gradedInput, workDir, output, bins, env, stems }) {
  if (pack.bgm?.enabled === false) {
    await cleanProgramOutput({ gradedInput, stems, output, env, bins });
    return { output, track: null, report: null, reused: false, failure: null, cacheKey: null };
  }
  const track = pickTrackForVariant(pack, { env });
  const trackHash = await sha256File(track.path);
  const requestedLevel = optionalNumber(pack.bgm?.musicLevelDb, null);
  const cacheKey = await contentKey({ picture: await sha256File(gradedInput), sourceManifest: stems?.manifestSha256 ?? null,
    trackSha256: trackHash, bgm: pack.bgm ?? null, v: 5 });
  const audioDir = path.join(workDir, "audio");
  await fsp.mkdir(audioDir, { recursive: true });
  const report = await bgmMix({ input: gradedInput, output: path.join(audioDir, `${pack.id}-${randomUUID()}.mp4`),
    bgmPath: track.path, audioStems: stemReference(stems), env, policy: pack.bgm?.policy ?? "keep-dialogue",
    musicLevelDb: requestedLevel, targetLufs: optionalNumber(pack.bgm?.targetLufs, -14),
    fadeInSec: optionalNumber(pack.bgm?.fadeInSec, 1.2), fadeOutSec: optionalNumber(pack.bgm?.fadeOutSec, 1.6), bins });
  assertBgmReportPassed(report);
  const slimTrack = { id: track.id, title: track.title, artist: track.artist, mood: track.mood, genre: track.genre,
    license: track.license, licenseLabel: track.licenseLabel, bpm: track.bpm, attribution: track.attribution, sourceSha256: trackHash };
  const slimReport = { ...report, output: { path: report.output.path, sha256: report.output.hash, duration: report.output.durationSec },
    mixing: { requestedMusicLevelDb: requestedLevel, appliedMusicLevelDb: report.mix.musicLevelDb, autoTrimDb: 0,
      qualityReviewed: false, qualityRetries: 0, note: "按指定配方执行一次混音" } };
  await snapshotAudioStemArtifact({ file: report.output.path, sha256: report.output.hash, output, allowedRoots: allowedRoots(env) });
  return { output, track: slimTrack, report: slimReport, reused: false, failure: null, cacheKey, mixing: slimReport.mixing };
}

function normalizePatchKeys(patch, allowed, label = "patch") {
  const unknown = Object.keys(patch ?? {}).filter((key) => !allowed.includes(key));
  if (unknown.length) {
    throw new PostError(
      `${label} 含未知键：${unknown.join(", ")}（允许：${allowed.join(", ")}）——未知指令不允许被静默忽略`,
      "bad_request",
    );
  }
}

/**
 * 出交付包：一次跑完「母版 → 旁挂字幕 → N 个风格变体（封面/文案/BGM/调色/转场）→ 软字幕轨 → 清单」。
 *
 * 产物结构（示例）：
 *   <outDir>/
 *     master/master-clean.mp4            干净母版（无字幕、无变体调色；后续返修的地基）
 *     subtitles/<name>.zh.srt|.zh.ass|.en.srt|.vtt + subtitle-manifest.json
 *     variants/<id>/<id>.mp4            变体成片（无字幕轨）
 *     variants/<id>/<id>.softsub.mp4    同画面 + 可开关字幕轨（视频 copy 与流元数据）
 *     variants/<id>/cover.png           封面
 *     variants/<id>/copy.md|copy.json   文案包（标题/钩子/正文/话题/CTA + 校验）
 *     variants/<id>/audio.json          BGM 曲目、许可、电平与实际处理回执
 *     film-project.json                 工程文件（层结构 + 产物血缘；返修的输入）
 *     delivery-manifest.json            交付清单（全部产物 sha256 + 实际处理事实）
 *     delivery-report.md                人看的交付说明（含变体差异）
 */
export async function buildDeliveryPackage({
  project = {},
  shots = [],
  subtitles = null,
  variants = null,
  outDir,
  burnSubtitles = false,
  softSubtitles = true,
  bins = resolveBinaries(),
  reuse = true,
  env = process.env,
} = {}) {
  if (project.creativeMode === "director_auto" || project.deliveryTargetPlan) {
    const { buildDirectorDelivery } = await import("./director-delivery.mjs");
    return buildDirectorDelivery({ project,shots,subtitles,outDir,burnSubtitles,softSubtitles,bins,env });
  }
  const projectId = text(project.projectId ?? project.project_id, "project.projectId");
  const target = path.resolve(text(outDir, "outDir"));
  await fsp.mkdir(target, { recursive: true });
  const plan = await planDelivery({ project, shots, variants, bins });
  const packs = plan.variants.map((entry) => findVariantPack(entry.id));
  const [width, height] = plan.resolution;
  const quality = plan.quality;
  const existingManifestPath = path.join(target, "delivery-manifest.json");
  if (fs.existsSync(existingManifestPath)) {
    throw new PostError("交付目录已有完成工程，请走 reedit 创建新版本", "idempotency_conflict");
  }
  const fps = optionalNumber(project.fps, 30);
  const platform = project.platform ?? null;
  const workDir = path.join(target, "work");
  await fsp.mkdir(workDir, { recursive: true });

  /* ① 归一化（全部变体共用；按内容哈希缓存，返修时可复用） */
  const normalised = await normaliseShots({ shots, project, workDir, bins, reuse, env });
  const totalSeconds = normalised.reduce((sum, clip) => sum + Number(clip.duration), 0);
  const baseTransitions = { mode: project.transitions?.mode ?? "hard", fadeSec: project.transitions?.fadeSec ?? 0.5 };
  const masterAssembly = await assembleTimeline({
    clips: normalised,
    transitions: baseTransitions,
    output: path.join(workDir, "master-picture.mp4"),
    resolution: [width, height],
    fps,
    quality,
    bins,
  });
  /** 母版节目声在装配之后生成：按逐刀口径 + 画面实测时长补齐（T-2026-1013-0002 移植）。 */
  const masterPictureProbe = normalised.some((clip) => Object.hasOwn(clip, "audioStems")) ? await probeMedia(masterAssembly.output, { bins }) : null;
  const masterStems = normalised.some((clip) => Object.hasOwn(clip, "audioStems"))
    ? await timelineStems({ project, clips: normalised, transitions: baseTransitions,
      cuts: legacyTransitionCuts(normalised, baseTransitions),
      padToSeconds: masterPictureProbe?.videoDuration ?? masterPictureProbe?.duration ?? null, workDir, env, bins })
    : null;
  const cleanMaster = path.join(target, "master", "master-clean.mp4");
  await cleanProgramOutput({ gradedInput: masterAssembly.output, stems: masterStems, output: cleanMaster, env, bins });
  masterAssembly.output = cleanMaster;
  const masterProbe = await probeMedia(masterAssembly.output, { bins });
  if (masterProbe.width !== width || masterProbe.height !== height
      || Math.abs((masterProbe.fps ?? 0) - fps) > 0.01) {
    throw new PostError(`干净母版规格不符：实测 ${masterProbe.width}×${masterProbe.height}/${masterProbe.fps}fps，目标 ${width}×${height}/${fps}fps`, "verify_failed");
  }

  /* ② 旁挂字幕（一次生成，全部变体共用同一份文字层；母版不烧字） */
  let sidecar = null;
  let timelineCues = null;
  let timelineCuesEn = [];
  let subtitleTiming = null;
  if (subtitles?.zhPath || subtitles?.zhCues || subtitles?.zhText) {
    const zhText = subtitles.zhText ?? (subtitles.zhPath ? await fsp.readFile(subtitles.zhPath, "utf8") : null);
    if (!zhText) throw new PostError("subtitles.zhText / zhPath 缺失（旁挂字幕需要内容）", "bad_request");
    const enText = subtitles.enText ?? (subtitles.enPath ? await fsp.readFile(subtitles.enPath, "utf8") : null);
    /** 时间轴口径 cue：所有形态的重映射都从它出发（避免在已映射时间上二次映射）。 */
    timelineCues = parseSrt(zhText);
    timelineCuesEn = enText ? parseSrt(enText) : [];
    const masterCuts = legacyTransitionCuts(normalised, baseTransitions);
    const masterTimemap = buildTransitionTimemap(
      normalised.map((clip) => ({ segmentId: String(clip.shotId), durationSeconds: Number(clip.duration ?? 0) })),
      masterCuts,
      { outputDurationSeconds: masterProbe.videoDuration ?? masterProbe.duration },
    );
    const masterRetime = retimeCuesForTransitions(timelineCues, masterTimemap);
    if (!masterRetime.cues.length) throw new PostError("按母版转场重映射后没有可用字幕条", "verify_failed");
    sidecar = await exportSidecars({
      input: masterAssembly.output,
      outputDir: path.join(target, "subtitles"),
      name: projectId,
      cues: masterRetime.cues,
      cuesEn: timelineCuesEn.length ? retimeCuesForTransitions(timelineCuesEn, masterTimemap).cues : [],
      platform,
      brief: { 平台: platform ?? "默认", 内容调性: project.copy?.tone ?? null },
      fontsDir: null,
      bins,
    });
    /** 时间轴口径 SRT（返修基线）：旁挂已重映射，返修必须回到时间轴再算一次。 */
    const timelineSrtPath = path.join(path.dirname(sidecar.files[0].path), `${projectId}.timeline.zh.srt`);
    await fsp.writeFile(timelineSrtPath, cuesToSrt(timelineCues), "utf8");
    subtitleTiming = {
      policy: "timeline→output：按各形态实际转场重映射；旁挂/软轨/烧录同源",
      timelineSrt: { path: path.relative(target, timelineSrtPath), sha256: await sha256File(timelineSrtPath), note: "时间轴口径：返修重映射基线" },
      master: {
        transitionCount: masterCuts.length,
        totalOverlapSeconds: masterTimemap.totalOverlapSeconds,
        cuesBefore: timelineCues.length,
        cuesAfter: masterRetime.cues.length,
        droppedCues: masterRetime.dropped.length,
        shiftSeconds: masterRetime.shiftSeconds,
      },
      variants: [],
    };
  }

  /* ③ 逐变体：拼接 → 调色 → 音频 → 封面 → 文案 →（可选）软字幕轨 / 硬字幕 */
  const variantsOut = [];
  const audioFailures = [];
  for (const pack of packs) {
    const variantDir = path.join(target, "variants", pack.id);
    await fsp.mkdir(variantDir, { recursive: true });
    const transitions = { ...baseTransitions, ...(pack.transitions ?? {}) };
    const assemblyKey = await contentKey({
      shots: normalised.map((clip) => clip.sha256), transitions, v: 2,
    });
    const assemblyPath = path.join(workDir, "assemble", `${pack.id}-${assemblyKey}.mp4`);
    const assemblyHash = await contentKey({ key: assemblyKey, type: "assembly" });
    const assemblyMetaPath = path.join(workDir, "assemble", `${pack.id}-${assemblyKey}.json`);
    let assembly = null;
    if (reuse && fs.existsSync(assemblyPath) && fs.existsSync(assemblyMetaPath)) {
      let meta;
      try { meta = JSON.parse(await fsp.readFile(assemblyMetaPath, "utf8")); }
      catch (error) {
        throw new PostError(`拼接缓存回执不可读：${error instanceof Error ? error.message : String(error)}`, "verify_failed");
      }
      await assertStoredArtifact(assemblyPath, meta.sha256, `变体 ${pack.id} 拼接缓存`);
      const cachedProbe = await probeMedia(assemblyPath, { bins });
      if (meta.key !== assemblyHash || cachedProbe.width !== width || cachedProbe.height !== height || !cachedProbe.hasAudio) {
        throw new PostError(`变体 ${pack.id} 拼接缓存规格或回执不一致`, "verify_failed");
      }
      assembly = { ...meta, output: assemblyPath, reused: true };
    } else {
      await assembleTimeline({
        clips: normalised, transitions, output: assemblyPath, resolution: [width, height], fps, quality, bins,
      });
      const assembledProbe = await probeMedia(assemblyPath, { bins });
      if (assembledProbe.width !== width || assembledProbe.height !== height || !assembledProbe.hasAudio) {
        throw new PostError(`变体 ${pack.id} 拼接产物规格不符`, "verify_failed");
      }
      assembly = { output: assemblyPath, mode: transitions.mode, fadeSec: transitions.fadeSec ?? 0, shots: normalised.length, reused: false, key: assemblyHash,
        /** 变体装配的实测视频轨时长：duration_consistent 与返修都以它为准（T-2026-1013-0002 移植）。 */
        durationSeconds: assembledProbe.videoDuration ?? assembledProbe.duration,
        sha256: await sha256File(assemblyPath) };
      await writeJson(assemblyMetaPath, assembly);
    }

    // 调色（color-bridge，自带"调了跟没调一样"的可见性拒绝）
    const lutPath = pack.color?.lut ? resolveLut(pack.color.lut) : null;
    const colorKey = await contentKey({
      assemblySha256: assembly.sha256,
      profile: pack.color?.profile ?? null,
      lutSha256: lutPath ? await sha256File(lutPath) : null,
      intensity: pack.color?.intensity ?? 0.8,
      quality,
      v: 2,
    });
    const gradedPath = path.join(workDir, "graded", `${pack.id}-${colorKey}.mp4`);
    const gradedMetaPath = `${gradedPath}.json`;
    let gradeReport = null;
    if (pack.color) {
      if (reuse && fs.existsSync(gradedPath) && fs.existsSync(gradedMetaPath)) {
        let meta;
        try { meta = JSON.parse(await fsp.readFile(gradedMetaPath, "utf8")); }
        catch (error) {
          throw new PostError(`调色缓存回执不可读：${error instanceof Error ? error.message : String(error)}`, "verify_failed");
        }
        await assertStoredArtifact(gradedPath, meta.sha256, `变体 ${pack.id} 调色缓存`);
        const cachedProbe = await probeMedia(gradedPath, { bins });
        if (meta.key !== colorKey || meta.inputSha256 !== assembly.sha256
            || cachedProbe.width !== width || cachedProbe.height !== height || !cachedProbe.hasAudio) {
          throw new PostError(`变体 ${pack.id} 调色缓存规格或回执不一致`, "verify_failed");
        }
        gradeReport = { output: gradedPath, sha256: meta.sha256, reused: true, profile: pack.color.profile ?? null, lut: pack.color.lut ?? null, intensity: pack.color.intensity ?? 0.8 };
      } else {
        gradeReport = await colorGrade({
          input: assemblyPath,
          output: gradedPath,
          profile: pack.color.profile ?? null,
          lutPath,
          intensity: optionalNumber(pack.color.intensity, 0.8),
          quality, verify: false, defects: false,
          bins,
        });
        const gradedProbe = await probeMedia(gradedPath, { bins });
        if (gradedProbe.width !== width || gradedProbe.height !== height || !gradedProbe.hasAudio) {
          throw new PostError(`变体 ${pack.id} 调色产物规格不符`, "verify_failed");
        }
        gradeReport = { ...gradeReport, sha256: await sha256File(gradedPath), reused: false };
        await writeJson(gradedMetaPath, { key: colorKey, inputSha256: assembly.sha256, sha256: gradeReport.sha256 });
      }
    }
    const gradedInput = gradeReport?.output ?? assemblyPath;

    // 音频层（BGM 选曲 + 混音；按内容哈希缓存，返修时可直接复用）
    const scoredPath = path.join(variantDir, `${pack.id}.mp4`);
    const stems = audioStemDigest(transitions) === audioStemDigest(baseTransitions) ? masterStems
      : await timelineStems({ project, clips: normalised, transitions,
        /** 逐刀口径与本变体一致 + 用待配音画面实测时长补齐。 */
        cuts: legacyTransitionCuts(normalised, transitions),
        padToSeconds: (await probeMedia(gradedInput, { bins })).videoDuration ?? null,
        workDir, env, bins });
    const audioOutcome = await mixVariantAudio({ pack, gradedInput, workDir, output: scoredPath, bins, env, stems });
    const audioReport = audioOutcome.report;
    const track = audioOutcome.track;
    const audioFailure = audioOutcome.failure;
    if (audioFailure) audioFailures.push(audioFailure);
    await writeJson(path.join(variantDir, "audio.json"), audioFailure
      ? {
        track: null,
        failed: true,
        code: audioFailure.code,
        message: audioFailure.message,
        note: "实际配乐处理失败，当前交付未完成",
      }
      : audioReport
        ? {
          track,
          policy: pack.bgm?.policy ?? "keep-dialogue",
          musicLevelDb: pack.bgm?.musicLevelDb ?? null,
          mixing: audioReport.mixing ?? null,
          loudness: audioReport.loudness,
          checks: audioReport.checks,
          levels: audioReport.levels,
          applicability: audioReport.applicability,
          retainedTracks: audioReport.retainedTracks,
          independentAudio: audioReport.independentAudio,
          output: { path: scoredPath, sha256: await sha256File(scoredPath), duration: (await probeMedia(scoredPath, { bins })).duration },
          ...(audioOutcome.reused ? { reused: true, cacheKey: audioOutcome.cacheKey } : {}),
        }
        : { track: null, policy: "原声（变体刻意不配乐）", note: pack.bgm?.note ?? null });
    const scoredProbe = await probeMedia(scoredPath, { bins });
    if (scoredProbe.width !== width || scoredProbe.height !== height
        || Math.abs((scoredProbe.fps ?? 0) - fps) > 0.01) {
      throw new PostError(`变体 ${pack.id} 规格不符：实测 ${scoredProbe.width}×${scoredProbe.height}/${scoredProbe.fps}fps，目标 ${width}×${height}/${fps}fps`, "verify_failed");
    }

    // 封面 + 文案
    const cover = await buildCover({
      input: gradedInput,
      output: path.join(variantDir, "cover.png"),
      project, variant: pack, resolution: [width, height], platform, bins, workDir,
    });
    const copy = buildCopyPack({ project, variant: pack });
    await fsp.writeFile(path.join(variantDir, "copy.md"), copy.markdown, "utf8");
    await writeJson(path.join(variantDir, "copy.json"), {
      title: copy.title, hook: copy.hook, body: copy.body, hashtags: copy.hashtags, cta: copy.cta,
      tone: copy.tone, checks: copy.checks,
    });

    // 软字幕轨（画面逐帧零改动）与可选硬字幕
    let softsub = null;
    let burned = null;
    /** 变体字幕：从时间轴 cue 按**本变体**转场重映射（各变体 mode/fadeSec 可不同）。 */
    let variantSubtitles = null;
    let variantCues = null;
    if (timelineCues && (softSubtitles || burnSubtitles)) {
      const variantCuts = legacyTransitionCuts(normalised, transitions);
      const variantTimemap = buildTransitionTimemap(
        normalised.map((clip) => ({ segmentId: String(clip.shotId), durationSeconds: Number(clip.duration ?? 0) })),
        variantCuts,
        { outputDurationSeconds: scoredProbe.videoDuration ?? scoredProbe.duration },
      );
      const retimed = retimeCuesForTransitions(timelineCues, variantTimemap);
      if (!retimed.cues.length) throw new PostError(`变体 ${pack.id} 按转场重映射后没有可用字幕条`, "verify_failed");
      const zhPath = path.join(variantDir, `${pack.id}.zh.srt`);
      await fsp.writeFile(zhPath, cuesToSrt(retimed.cues), "utf8");
      variantCues = retimed.cues;
      variantSubtitles = {
        zhPath,
        timing: {
          transitionCount: variantCuts.length,
          totalOverlapSeconds: variantTimemap.totalOverlapSeconds,
          cuesBefore: timelineCues.length,
          cuesAfter: retimed.cues.length,
          droppedCues: retimed.dropped.length,
          shiftSeconds: retimed.shiftSeconds,
        },
      };
      subtitleTiming?.variants.push({ id: pack.id, ...variantSubtitles.timing });
    }
    if (softSubtitles && (variantSubtitles || sidecar)) {
      const softTarget = path.join(variantDir, `${pack.id}.softsub.mp4`);
      /**
       * 每种语言只挂一条字幕轨：mp4/mov 用 mov_text 承载，ASS 样式本来就会被压掉，
       * 因此优先取该语言的 SRT（同一份文字层的纯文本形态）；mkv 才优先 ASS（保样式）。
       * 早先"过滤出全部 srt/ass"会让纯中文片挂出两条 chi 轨（一条 srt + 一条 ass），
       * 播放器里出现两个同语言菜单项——这是用户能直接看见的交付缺陷。
       */
      const byLang = new Map();
      for (const file of sidecar.files) {
        if (file.role !== "subtitle") continue;
        if (!["srt", "ass"].includes(file.format)) continue;
        const lang = file.lang === "eng" ? "eng" : "chi";
        const preferAss = path.extname(softTarget).toLowerCase() === ".mkv";
        const current = byLang.get(lang);
        const better = !current
          || (file.format === (preferAss ? "ass" : "srt") && current.format !== (preferAss ? "ass" : "srt"));
        if (better) byLang.set(lang, file);
      }
      const tracks = variantSubtitles
        ? [{ path: variantSubtitles.zhPath, lang: "chi", title: "中文", default: true }]
        : [...byLang.entries()].map(([lang, file], index) => ({
          path: file.path,
          lang,
          title: lang === "eng" ? "English" : "中文",
          default: index === 0,
        }));
      softsub = await softMux({ input: scoredPath, output: softTarget, subtitles: tracks, bins });
    }
    if (burnSubtitles && (variantCues || sidecar)) {
      const zh = sidecar.files.find((file) => file.format === "srt" && file.lang === "chi");
      const cues = variantCues ?? parseSrt(await fsp.readFile(zh.path, "utf8"));
      burned = await renderWithSubtitles({
        mode: "subtitle",
        input: scoredPath,
        output: path.join(variantDir, `${pack.id}.burned.mp4`),
        cues,
        platform,
        brief: { 平台: platform ?? "默认" },
        bins,
      });
    }

    variantsOut.push({
      id: pack.id,
      name: pack.name,
      positioning: pack.positioning,
      dir: variantDir,
      artifacts: {
        video: { path: scoredPath, sha256: await sha256File(scoredPath), duration: scoredProbe.duration, resolution: [scoredProbe.width, scoredProbe.height] },
        softsub: softsub ? { path: softsub.output, sha256: softsub.sha256, tracks: softsub.tracks, checks: softsub.checks } : null,
        burned: burned ? { path: burned.output.path, sha256: burned.output.hash, checks: burned.checks } : null,
        cover: { path: cover.output, sha256: cover.sha256, at: cover.at, requestedAt: cover.requestedAt, background: cover.background, text: cover.text, checks: cover.checks },
        copy: { path: path.join(variantDir, "copy.md"), checks: copy.checks, title: copy.title, hashtags: copy.hashtags },
        audioReceipt: { path: path.join(variantDir, "audio.json"), sha256: await sha256File(path.join(variantDir, "audio.json")) },
        audio: audioReport
          ? {
            path: path.join(variantDir, "audio.json"),
            trackId: track.id,
            trackTitle: track.title,
            attribution: track.attribution,
            policy: pack.bgm?.policy ?? "keep-dialogue",
            mixing: audioReport.mixing ?? null,
            loudness: audioReport.loudness,
            checks: audioReport.checks,
          }
          : (audioFailure
            ? { path: path.join(variantDir, "audio.json"), failed: true, code: audioFailure.code, message: audioFailure.message, trackId: null, trackTitle: null }
            : null),
      },
      style: {
        color: pack.color ?? null,
        bgm: pack.bgm ?? null,
        transitions,
        cover: pack.cover ?? null,
        copyTone: pack.copy?.tone ?? null,
      },
      layers: {
        audioStems: stemReference(stems),
        assembly: { path: assemblyPath, key: assemblyKey, sha256: assembly.sha256, reused: assembly.reused === true, mode: transitions.mode,
          /** 变体自己的装配时长（duration_consistent 与返修都以它为基准，T-2026-1013-0002 移植）。 */
          durationSeconds: assembly.durationSeconds },
        color: gradeReport ? { path: gradeReport.output, sha256: gradeReport.sha256, reused: gradeReport.reused === true, profile: gradeReport.profile ?? null, lut: gradeReport.lut ?? null, intensity: gradeReport.intensity ?? null, visibility: gradeReport.visibility ?? null } : null,
      },
    });
  }

  const divergence = [];
  const coverDivergence = [];
  const recipeFingerprints = variantsOut.map((variant) => JSON.stringify(variant.style));
  const recipeDistinct = new Set(recipeFingerprints).size === recipeFingerprints.length;
  if (!recipeDistinct) throw new PostError("请求的变体配方重复，无法形成独立风格版本", "bad_request");
  /** 变体封面两两差异化（硬门）：identical / near-duplicate 直接判失败，防止"几个版本同一个封面"回归。 */
  for (let i = 0; i < variantsOut.length; i += 1) {
    for (let j = i + 1; j < variantsOut.length; j += 1) {
      const a = variantsOut[i];
      const b = variantsOut[j];
      const diff = await imageDivergence(a.artifacts.cover.path, b.artifacts.cover.path, bins);
      coverDivergence.push({ a: a.id, b: b.id, diff });
    }
  }
  const duplicateCoverPairs = coverDivergence.filter((row) => row.diff.verdict === "identical" || row.diff.verdict === "near-duplicate");

  const packageChecks = [
    { kind: "source_audio_preserved", ok: true, detail: { sourceScope: audioScope(project), embeddedAudioUsed: !masterStems, independentStemsProvided: Boolean(masterStems), qualityReviewed: false } },
    {
      kind: "resolution_exact",
      ok: masterProbe.width === width && masterProbe.height === height
        && variantsOut.every((variant) => variant.artifacts.video.resolution[0] === width && variant.artifacts.video.resolution[1] === height),
      detail: { requested: [width, height], master: [masterProbe.width, masterProbe.height], variants: variantsOut.map((variant) => ({ id: variant.id, resolution: variant.artifacts.video.resolution })) },
    },
    { kind: "master_no_burn_in", ok: Boolean(masterAssembly.output), detail: { note: "干净母版不含任何烧录字幕；字幕只以旁挂文件 + 可开关字幕轨交付", subtitles: sidecar ? sidecar.files.length : 0 } },
    { kind: "sidecar_files", ok: sidecar ? sidecar.passed : true, detail: sidecar ? { files: sidecar.files.map((file) => path.basename(file.path)), timeline: sidecar.manifest.timeline } : { note: "本次未提供字幕，跳过旁挂交付" } },
    { kind: "variant_count", ok: variantsOut.length >= 2, detail: { variants: variantsOut.map((variant) => variant.id) } },
    { kind: "variant_recipes_distinct", ok: recipeDistinct, detail: { qualityReviewed: false, pixelDifferenceMeasured: false } },

    {
      kind: "covers_valid",
      ok: variantsOut.every((variant) => variant.artifacts.cover.checks.every((check) => check.ok === true)),
      detail: variantsOut.map((variant) => ({ id: variant.id, checks: variant.artifacts.cover.checks })),
    },
    {
      kind: "covers_distinct",
      ok: duplicateCoverPairs.length === 0,
      detail: {
        basis: "变体封面两两 64×36 灰度平均绝对差（MAD）；identical/near-duplicate(<2) 判失败，similar(<6) 提示",
        pairs: coverDivergence.map((row) => ({ a: row.a, b: row.b, meanAbsDiff: row.diff.meanAbsDiff, verdict: row.diff.verdict })),
        duplicates: duplicateCoverPairs.map((row) => ({ a: row.a, b: row.b, meanAbsDiff: row.diff.meanAbsDiff, verdict: row.diff.verdict })),
      },
    },
    { kind: "bgm_layer", ok: audioFailures.length === 0, detail: { failed: audioFailures, qualityReviewed: false, note: "请求的配乐处理已完成；实际处理错误会中止，不作原声降级" } },
    { kind: "softsub_video_unchanged", ok: variantsOut.every((variant) => !variant.artifacts.softsub || variant.artifacts.softsub.checks.every((check) => check.ok === true)), detail: variantsOut.filter((variant) => variant.artifacts.softsub).map((variant) => ({ id: variant.id, checks: variant.artifacts.softsub.checks.map((check) => check.kind) })) },
{
kind: "duration_consistent",
      /**
       * 每个变体都由完整归一化源时间轴独立装配；母版可能已做 xfade，不能再从它扣重叠
       * （T-2026-1013-0002 移植修复：旧口径拿"已被转场缩短过的母版"再减一次重叠 → 双重扣除，
       * 带 xfade 的变体会被判 duration_consistent 失败）。
       * 基准改为该变体**自己的装配产物时长**，保留真实加工时长检查（±0.4s 容差）。
       */
      ok: variantsOut.every((variant) => {
        const expected = variant.layers.assembly.durationSeconds;
        return Number.isFinite(expected) && expected > 0
          && Math.abs((variant.artifacts.video.duration ?? 0) - expected) <= 0.4;
      }),
      detail: {
        master: masterProbe.duration,
        variants: variantsOut.map((variant) => {
          const transitions = variant.style.transitions ?? {};
          return {
            id: variant.id,
            duration: variant.artifacts.video.duration,
            expected: round(variant.layers.assembly.durationSeconds, 3),
            transitions: `${transitions.mode}${transitions.fadeSec ? ` ${transitions.fadeSec}s` : ""}`,
          };
        }),
},
},
{
/**
 * 计划 vs 实际（T-2026-0925-0001）：
 * 镜头卡/PRD 给出的计划总时长（`project.targetDurationSec` / `target_duration_sec` / `briefDurationSec`）
 * 与本次实际素材总时长比对（±1s/镜，至少 ±2s）。
 * 计划缺失时**不静默通过**：ok=true 但 detail.note 明确写"计划时长未提供（未校验）"，
 * 报告与前端据此可区分"校验通过"与"未校验"。
 */
kind: "duration_plan_consistent",
blocking: false,
ok: (() => {
const planned = Number(project.targetDurationSec ?? project.target_duration_sec ?? project.briefDurationSec);
if (!Number.isFinite(planned) || planned <= 0) return true;
const tolerance = Math.max(2, normalised.length * 1);
return Math.abs(totalSeconds - planned) <= tolerance;
})(),
detail: (() => {
const plannedRaw = project.targetDurationSec ?? project.target_duration_sec ?? project.briefDurationSec;
const planned = Number(plannedRaw);
if (!Number.isFinite(planned) || planned <= 0) {
return { plannedSeconds: null, actualSeconds: totalSeconds, note: "计划时长未提供（未校验）" };
}
const tolerance = Math.max(2, normalised.length * 1);
return {
plannedSeconds: planned,
actualSeconds: totalSeconds,
deltaSeconds: round(totalSeconds - planned, 2),
toleranceSeconds: tolerance,
note: "计划口径 = 镜头卡/PRD 的目标总时长；实际口径 = 逐镜素材净时长合计",
};
})(),
},
  ];
  // A nominal plan discrepancy is descriptive evidence. It cannot reject a
  // completed source or require another generation after actual post succeeds.
  const failedChecks = packageChecks.filter((check) => check.ok === false && check.blocking !== false);
  if (failedChecks.length) throw new PostError(`实际交付文件或请求规格未完成：${failedChecks.map((check) => `${check.kind}`).join("、")}`, "verify_failed");

  /* ⑤ 工程文件 + 交付清单（返修的输入；也是"哪些层可复用"的事实源） */
  const packageKey = await contentKey({
    projectId,
    shots: normalised.map((clip) => clip.sha256),
    variants: variantsOut.map((variant) => ({ id: variant.id, video: variant.artifacts.video.sha256 })),
  });
  const filmProject = {
    schemaVersion: FILM_PROJECT_SCHEMA,
    projectId,
    audioScope: audioScope(project),
    version: 1,
    deliveryRoot: ".",
    createdAt: new Date().toISOString(),
    title: project.title ?? projectId,
    platform,
    quality,
    resolution: [width, height],
    fps,
    layers: {
      audioStems: stemReference(masterStems, target),
      shots: normalised.map((clip) => ({
        shotId: clip.shotId, source: clip.source, normalised: path.relative(target, clip.path),
        sha256: clip.sha256, sourceSha256: clip.sourceHash, duration: clip.duration, sourceDuration: clip.sourceDuration,
        kind: clip.sourceKind,
        enhancement: clip.enhancement ? {
          ...clip.enhancement,
          output: clip.enhancement.output ? path.relative(target, clip.enhancement.output) : null,
          provenancePath: clip.enhancement.provenancePath ? path.relative(target, clip.enhancement.provenancePath) : null,
        } : null,
      })),
      transitions: baseTransitions,
      text: sidecar ? {
        sidecarDir: path.relative(target, path.dirname(sidecar.files[0].path)),
        files: sidecar.files.map((file) => ({ role: file.role, lang: file.lang, format: file.format, path: path.relative(target, file.path), sha256: file.sha256 })),
        burnedInMaster: false,
      } : null,
      variants: variantsOut.map((variant) => ({
        id: variant.id,
        style: variant.style,
        audioStems: variant.layers.audioStems ? { ...variant.layers.audioStems, dir: path.relative(target, variant.layers.audioStems.dir) } : null,
        // 工程文件里的路径一律**相对交付根**（交付包可整体搬走；返修时再按根解析回来）
        color: variant.layers.color
          ? { ...variant.layers.color, path: path.relative(target, variant.layers.color.path) }
          : null,
        assembly: { ...variant.layers.assembly, path: path.relative(target, variant.layers.assembly.path) },
        bgm: variant.artifacts.audio ? { trackId: variant.artifacts.audio.trackId, policy: variant.artifacts.audio.policy } : null,
        artifacts: {
          audio: { ...variant.artifacts.audioReceipt, path: path.relative(target, variant.artifacts.audioReceipt.path) },
          video: { path: path.relative(target, variant.artifacts.video.path), sha256: variant.artifacts.video.sha256 },
          softsub: variant.artifacts.softsub ? { path: path.relative(target, variant.artifacts.softsub.path), sha256: variant.artifacts.softsub.sha256 } : null,
          cover: {
            path: path.relative(target, variant.artifacts.cover.path),
            sha256: variant.artifacts.cover.sha256,
            at: variant.artifacts.cover.at,
            requestedAt: variant.artifacts.cover.requestedAt,
          },
          copy: { path: path.relative(target, variant.artifacts.copy.path) },
        },
      })),
      copy: project.copy ?? null,
    },
    cache: { workDir: path.relative(target, workDir), packageKey },
    history: [{ at: new Date().toISOString(), kind: "initial-delivery", version: 1, variants: variantsOut.map((variant) => variant.id), patch: null }],
  };
  const projectPath = await writeJson(path.join(target, "film-project.json"), filmProject);

  const manifest = {
    schemaVersion: DELIVERY_SCHEMA,
    projectId,
    packageKey,
    createdAt: filmProject.createdAt,
    title: filmProject.title,
    platform,
    quality,
    resolution: [width, height],
    fps,
    audioScope: audioScope(project),
    independentAudio: stemReference(masterStems, target),
    master: {
      path: path.relative(target, masterAssembly.output),
      sha256: await sha256File(masterAssembly.output),
      duration: masterProbe.duration,
      resolution: [masterProbe.width, masterProbe.height],
      subtitles: "none（母版不烧字；字幕走旁挂文件或软字幕轨）",
    },
    subtitles: sidecar ? {
      timing: subtitleTiming,
      dir: path.relative(target, path.dirname(sidecar.files[0].path)),
      files: sidecar.files.map((file) => ({ path: path.relative(target, file.path), role: file.role, lang: file.lang, format: file.format, sha256: file.sha256, bytes: file.bytes })),
      manifest: path.relative(target, sidecar.manifestPath),
      checks: sidecar.checks,
    } : null,
    variants: variantsOut.map((variant) => ({
      id: variant.id,
      name: variant.name,
      positioning: variant.positioning,
      dir: path.relative(target, variant.dir),
      video: { path: path.relative(target, variant.artifacts.video.path), sha256: variant.artifacts.video.sha256, duration: variant.artifacts.video.duration, resolution: variant.artifacts.video.resolution },
      softsub: variant.artifacts.softsub ? { path: path.relative(target, variant.artifacts.softsub.path), sha256: variant.artifacts.softsub.sha256, tracks: variant.artifacts.softsub.tracks.map((track) => ({ lang: track.lang, title: track.title })) } : null,
      burned: variant.artifacts.burned ? { path: path.relative(target, variant.artifacts.burned.path), sha256: variant.artifacts.burned.sha256 } : null,
      cover: {
        path: path.relative(target, variant.artifacts.cover.path),
        sha256: variant.artifacts.cover.sha256,
        text: variant.artifacts.cover.text,
        at: variant.artifacts.cover.at,
        requestedAt: variant.artifacts.cover.requestedAt,
        background: variant.artifacts.cover.background,
        checks: variant.artifacts.cover.checks,
      },
      copy: { path: path.relative(target, variant.artifacts.copy.path), title: variant.artifacts.copy.title, hashtags: variant.artifacts.copy.hashtags, checks: variant.artifacts.copy.checks },
      audio: variant.artifacts.audio
        ? {
          path: path.relative(target, variant.artifacts.audio.path),
          trackId: variant.artifacts.audio.trackId,
          trackTitle: variant.artifacts.audio.trackTitle,
          attribution: variant.artifacts.audio.attribution,
          loudness: variant.artifacts.audio.loudness,
          // 记录声明电平和实际执行参数，不做自动降档或质量重试。
          mixing: variant.artifacts.audio.mixing ?? null,
          ...(variant.artifacts.audio.failed ? { failed: true, code: variant.artifacts.audio.code, message: variant.artifacts.audio.message } : {}),
        }
        : null,
      style: variant.style,
      independentAudio: variant.layers.audioStems ? { ...variant.layers.audioStems, dir: path.relative(target, variant.layers.audioStems.dir) } : null,
    })),
    divergence,
    displayNames: displayNamesForDelivery({
      title: project.title ?? project.projectId ?? "未命名",
      version: project.version ?? null,
      resolution: [width, height],
      variants: variantsOut.map((variant) => ({ id: variant.id, name: variant.name })),
    }),
    coverDivergence: coverDivergence.map((row) => ({ a: row.a, b: row.b, meanAbsDiff: row.diff.meanAbsDiff, verdict: row.diff.verdict })),
    checks: packageChecks,
    enhancements: normalised.map((clip) => ({
      shotId: clip.shotId,
      kind: clip.sourceKind,
      sourceSha256: clip.sourceHash,
      sourceResolution: clip.enhancement?.sourceResolution ?? null,
      status: clip.enhancement?.status ?? "not-requested",
      outputSha256: clip.enhancement?.sha256 ?? null,
      outputResolution: clip.enhancement?.outputResolution ?? null,
      provenancePath: clip.enhancement?.provenancePath ? path.relative(target, clip.enhancement.provenancePath) : null,
      model: clip.enhancement?.model ?? null,
    })),
    filmProject: path.relative(target, projectPath),
    cost: {
      shotGeneration: "reused（本包未生成任何新镜头）",
      tokenCostDelta: 0,
      note: "多风格变体只吃本地算力：镜头生成费只付一次，风格差异零 token",
    },
  };
  const manifestPath = await writeJson(path.join(target, "delivery-manifest.json"), manifest);

  const report = [
    `# 交付包 · ${manifest.title}`,
    "",
    `- 项目：${projectId} · 平台：${platform ?? "默认"} · 画幅：${width}×${height} @${fps}fps · 时长：${masterProbe.duration}s`,
    `- 清晰度档位：${quality === "uhd" ? "UHD（本地编码归一化）" : "HD"}；逐镜来源和模型记录见 \`delivery-manifest.json\` 的 \`enhancements\``,
    `- 干净母版：\`${manifest.master.path}\`（**不含字幕**；字幕只以旁挂文件/可开关字幕轨交付）`,
    sidecar ? `- 字幕文件：${manifest.subtitles.files.map((file) => file.path.split("/").pop()).join("、")}（时间轴回读 ${sidecar.manifest.timeline.readback.ass ? "ok" : "fail"}）` : "- 字幕文件：本次未提供字幕",
    "",
    "## 风格变体（选一个，或提返修意见）",
    "",
    "| 变体 | 定位 | 调色 | BGM | 转场 | 封面 |",
    "|---|---|---|---|---|---|",
    ...manifest.variants.map((variant) => [
      `| ${variant.name}（\`${variant.id}\`）`,
      variant.positioning ?? "—",
      variant.style.color ? `${variant.style.color.profile ?? variant.style.color.lut} @${variant.style.color.intensity}` : "不调色",
      variant.audio
        ? `${variant.audio.trackTitle ?? variant.audio.trackId}${variant.audio.failed ? "（实际处理失败）" : ""}`
        : "原声",
      `${variant.style.transitions.mode}${variant.style.transitions.fadeSec ? ` ${variant.style.transitions.fadeSec}s` : ""}`,
      `\`${variant.cover.path}\``,
    ].join(" | ")),
    "",
    "## 变体配方（已执行，未做画面或音频质量投票）",
    "",
    "上表记录每版实际执行的配方。画面像素、声音品质与审美差异未测，相关列表为空。",
    "",
    "## 返修怎么走（不用重新生成镜头）",
    "",
    "- 换字幕/改文案/换封面：`postwrite.reedit` 只重算文字层与封面层，画面直接复用；",
    "- 换 BGM/调音量：只重算音频层（视频轨 copy，画面零改动）；",
    "- 换调色/转场：只重算调色与拼接层，镜头产物不动；",
    "- 只有点名到「画面内容」（人物/穿帮/镜头不好）才需要重生成镜头，且走人审闸（G8）后只重跑被点名的镜头。",
    "",
    ...(audioFailures.length
      ? [
        "## 实际未完成的处理",
        "",
        ...audioFailures.map((failure) => `- 变体 \`${failure.variant}\` 配乐实际处理失败（${failure.code}）：${failure.message}。`),
        "",
      ]
      : []),
    `工程文件：\`${manifest.filmProject}\`（返修入口）· 清单：\`delivery-manifest.json\``,
    "",
  ].join("\n");
  const reportPath = path.join(target, "delivery-report.md");
  await fsp.writeFile(reportPath, report, "utf8");

  return {
    outDir: target,
    projectId,
    packageKey,
    filmProject,
    projectPath,
    manifest,
    manifestPath,
    reportPath,
    sidecar,
    variants: variantsOut,
    normalised,
    master: masterAssembly,
    checks: packageChecks,
    passed: packageChecks.every((check) => check.ok !== false || check.blocking === false),
  };
}

/* ============================ 变更影响分析（返修的第一步） ============================ */

const PATCH_KEYS = ["subtitles", "bgm", "color", "transitions", "cover", "copy", "variants", "shots"];
const LAYER_ORDER = ["shots", "assemble", "color", "audio", "text", "cover", "copy"];

/**
 * 变更影响分析：把"用户想改什么"翻译成"要重算哪些层、要不要重新生成镜头"。
 *
 * 这是整个返修机制的分水岭：
 * - 文字/音频/调色/封面/文案/转场 → **本地重合成**（既有镜头产物直接复用，token 增量 0）；
 * - 点名到画面内容 → **镜头重生成**（花钱 → 必须过 G8 人审，且只重跑被点名的镜头）；
 * - 未知键 → 直接报错（不允许"看不懂就忽略"）。
 */
export function analyzeImpact({ project = null, patch = {} } = {}) {
  normalizePatchKeys(patch, PATCH_KEYS, "patch");
  const layers = new Set();
  const reasons = [];
  let shotRegeneration = { required: false, shotIds: [], reason: null, gate: null };

  if (patch.subtitles) {
    normalizePatchKeys(patch.subtitles, ["zhText", "zhPath", "enText", "enPath", "style", "burn", "variantId"], "patch.subtitles");
    layers.add("text");
    reasons.push("字幕文字/样式变化：重出旁挂字幕文件 + 重建软字幕轨（画面不动）");
    if (patch.subtitles.burn === true) reasons.push("显式要求硬字幕：额外产出一支烧字副本（母版仍不烧）");
  }
  if (patch.bgm) {
    normalizePatchKeys(patch.bgm, ["variantId", "trackId", "mood", "genre", "style", "policy", "musicLevelDb", "targetLufs", "enabled"], "patch.bgm");
    layers.add("audio");
    reasons.push("配乐变化：只重跑选曲+混音（视频轨 copy，画面零改动）");
  }
  if (patch.color) {
    normalizePatchKeys(patch.color, ["variantId", "profile", "lut", "intensity"], "patch.color");
    layers.add("color");
    reasons.push("调色变化：从既有拼接母版重跑调色（镜头与拼接不动）");
  }
  if (patch.transitions) {
    normalizePatchKeys(patch.transitions, ["variantId", "mode", "fadeSec"], "patch.transitions");
    layers.add("assemble");
    reasons.push("转场/拼接变化：从既有镜头产物重拼接（镜头不动）");
  }
  if (patch.cover) {
    normalizePatchKeys(patch.cover, ["variantId", "at", "alignment", "marginRatio", "subtitle"], "patch.cover");
    layers.add("cover");
    reasons.push("封面变化：重出封面（不动成片）");
  }
  if (patch.copy) {
    normalizePatchKeys(patch.copy, ["variantId", "titleTemplate", "opening", "closing", "cta", "hashtags", "tone", "title", "hook", "body"], "patch.copy");
    layers.add("copy");
    reasons.push("文案变化：重出文案包（不动成片）");
  }
  if (patch.variants) {
    normalizePatchKeys(patch.variants, ["add", "remove"], "patch.variants");
    reasons.push("变体集合变化：只派生新增/移除的变体，既有变体产物复用");
  }
  if (patch.shots) {
    normalizePatchKeys(patch.shots, ["replace", "regenerate"], "patch.shots");
    const requested = [
      ...(Array.isArray(patch.shots.replace) ? patch.shots.replace.map((item) => item.shotId ?? item.shot_id) : []),
      ...(Array.isArray(patch.shots.regenerate) ? patch.shots.regenerate : []),
    ].filter(Boolean).map(String);
    const known = new Set((project?.layers?.shots ?? []).map((shot) => String(shot.shotId)));
    const unknown = requested.filter((shotId) => known.size && !known.has(shotId));
    if (unknown.length) {
      throw new PostError(`patch.shots 点名了不存在的镜头：${unknown.join(", ")}（本片镜头：${[...known].join(", ")}）`, "bad_request");
    }
    layers.add("shots");
    layers.add("assemble");
    shotRegeneration = {
      required: true,
      shotIds: requested,
      reason: "反馈点名到画面内容：需要重新生成这些镜头，再回到本地合成",
      gate: "G8",
      budgetNote: "镜头生成消耗额度，必须人审（G8）后由渲染链路只重跑被点名的镜头",
    };
    reasons.push(`镜头重生成：${requested.join("、") || "全部"}（走 G8 人审，只重跑点名镜头）`);
  }
  if (patch.transitions || patch.shots) layers.add("color");
  /**
   * 调色会重编码音频轨（color-bridge 的 grade 输出 `-c:a aac`），因此"只改调色"必然连带重算音频层：
   * 不是多余步骤，而是**母版必须由同一支已调色母版派生**——否则会出现"画面是 v2 调色、声音是 v1 母版"的
   * 隐性错配（听不出来、也查不出来）。同理，音频变了就要重出软字幕轨（字幕挂在成片容器上）。
   */
  if (patch.transitions || patch.color || patch.shots) layers.add("audio");
  if (patch.transitions || patch.shots) layers.add("text");
  if (patch.transitions || patch.color || patch.shots) layers.add("cover");

  const ordered = LAYER_ORDER.filter((layer) => layers.has(layer));
  const localOnly = !shotRegeneration.required;
  return {
    schemaVersion: "workloom.delivery-impact/v1",
    layers: ordered,
    rebuild: {
      normalise: ordered.includes("shots"),
      assemble: ordered.includes("assemble"),
      color: ordered.includes("color"),
      audio: ordered.includes("audio"),
      text: ordered.includes("text"),
      cover: ordered.includes("cover"),
      copy: ordered.includes("copy"),
    },
    reuse: {
      shots: !ordered.includes("shots"),
      text: !ordered.includes("text"),
      color: !ordered.includes("color"),
      audio: !ordered.includes("audio"),
      cover: !ordered.includes("cover"),
      copy: !ordered.includes("copy"),
    },
    shotRegeneration,
    localOnly,
    costHint: localOnly
      ? { tokenCostDelta: 0, note: "本地重合成：既有镜头产物全部复用，不花 token" }
      : { tokenCostDelta: ">0", note: "需要重生成镜头（仅点名的镜头），先过 G8 人审" },
    reasons,
  };
}

/* ============================ 本地二次编辑（层增量重合成） ============================ */

/** 工程文件里的路径是相对交付根的；同时容忍历史文件里的绝对路径（两者都能解析）。 */
function resolveStored(base, storedPath) {
  const value = String(storedPath ?? "");
  return path.isAbsolute(value) ? value : path.resolve(base, value);
}

/** A revision request compares both the chosen version and its exact bytes. */
export function readRevisionBase(projectPath) {
  const file = path.resolve(text(projectPath, "projectPath"));
  let fd;
  try { fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW); }
  catch (error) {
    const code = error.code === "ENOENT" ? "not_found" : error.code === "ELOOP" ? "path_not_allowed" : "revision_io_failed";
    throw new PostError(`无法读取返修工程：${error.message}`, code);
  }
  try {
    const before = fs.fstatSync(fd);
    if (!before.isFile() || before.size <= 0 || before.size > 4 * 1024 * 1024) {
      throw new PostError("返修工程必须是 4 MiB 以内的非空文件", "bad_request");
    }
    const bytes = fs.readFileSync(fd);
    const after = fs.fstatSync(fd);
    const current = fs.lstatSync(file);
    if (before.size !== bytes.length || before.size !== after.size || before.mtimeMs !== after.mtimeMs
      || before.ctimeMs !== after.ctimeMs || current.isSymbolicLink() || current.ino !== before.ino || current.dev !== before.dev) {
      throw new PostError("返修工程在读取期间变化", "revision_conflict");
    }
    let project;
    try { project = JSON.parse(bytes.toString("utf8")); }
    catch (error) { throw new PostError(`返修工程 JSON 非法：${error.message}`, "bad_request"); }
    if (project?.schemaVersion !== FILM_PROJECT_SCHEMA || !Number.isSafeInteger(project.version) || project.version < 1
      || typeof project.projectId !== "string" || !project.projectId.trim()) {
      throw new PostError("返修工程缺少有效 schemaVersion、projectId 或 version", "bad_request");
    }
    return { file, project, version: project.version, sha256: createHash("sha256").update(bytes).digest("hex") };
  } finally { fs.closeSync(fd); }
}

/** No symlinked version/root may redirect a local revision claim. */
function revisionPath(base, target, allowMissing = false) {
  const root = path.resolve(base);
  const rel = path.relative(root, path.resolve(target));
  if (rel === ".." || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) {
    throw new PostError("返修路径不在交付包内", "path_not_allowed");
  }
  const rootStat = fs.lstatSync(root);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) throw new PostError("交付包根不能是符号链接", "path_not_allowed");
  let current = root;
  for (const part of rel.split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    let stat;
    try { stat = fs.lstatSync(current); }
    catch (error) { if (allowMissing && error.code === "ENOENT") continue; throw error; }
    if (stat.isSymbolicLink()) throw new PostError("返修路径不允许符号链接", "path_not_allowed");
  }
  return path.resolve(target);
}

/** A published film-project is the commit point; reserved/failed versions are never reused. */
function revisionHead(base) {
  const initial = readRevisionBase(revisionPath(base, path.join(base, "film-project.json")));
  let latest = initial;
  let highestReserved = initial.version;
  const versions = revisionPath(base, path.join(base, "versions"), true);
  if (!fs.existsSync(versions)) return { latest, highestReserved };
  if (!fs.lstatSync(versions).isDirectory()) throw new PostError("versions 不是目录", "bad_request");
  for (const name of fs.readdirSync(versions)) {
    if (!/^v[1-9]\d*$/.test(name)) continue;
    const version = Number(name.slice(1));
    if (!Number.isSafeInteger(version)) throw new PostError("返修版本号越界", "bad_request");
    const dir = revisionPath(base, path.join(versions, name));
    if (!fs.lstatSync(dir).isDirectory()) throw new PostError(`返修版本不是目录：${name}`, "bad_request");
    highestReserved = Math.max(highestReserved, version);
    const file = revisionPath(base, path.join(dir, "film-project.json"), true);
    if (!fs.existsSync(file)) continue;
    const candidate = readRevisionBase(file);
    if (candidate.version !== version || candidate.project.projectId !== initial.project.projectId) {
      throw new PostError(`返修版本归属不一致：${name}`, "revision_conflict");
    }
    const receiptFile = revisionPath(base, path.join(dir, "revision.json"), true);
    const claimFile = revisionPath(base, path.join(dir, "revision-claim.json"), true);
    if (fs.existsSync(claimFile) && !fs.existsSync(receiptFile)) {
      throw new PostError(`返修提交记录缺失：${name}`, "revision_conflict");
    }
    if (fs.existsSync(receiptFile)) {
      const receipt = JSON.parse(fs.readFileSync(receiptFile, "utf8"));
      if (receipt.commit && (receipt.commit.projectSha256 !== candidate.sha256 || receipt.commit.version !== version)) {
        throw new PostError(`已提交返修工程指纹变化：${name}`, "revision_conflict");
      }
      if (fs.existsSync(claimFile)) {
        const claim = JSON.parse(fs.readFileSync(claimFile, "utf8"));
        if (!receipt.commit || receipt.commit.runId !== claim.runId || receipt.commit.baseProjectSha256 !== claim.baseProjectSha256
          || receipt.commit.baseVersion !== claim.baseVersion || claim.version !== version) {
          throw new PostError(`返修提交与认领记录不一致：${name}`, "revision_conflict");
        }
      }
    }
    if (candidate.version > latest.version) latest = candidate;
  }
  return { latest, highestReserved };
}

async function withRevisionClaim({ base, snapshot, expectedVersion, expectedProjectSha256, outDir }, execute) {
  if (!Number.isSafeInteger(expectedVersion) || expectedVersion < 1 || !/^[a-f0-9]{64}$/.test(expectedProjectSha256 ?? "")) {
    throw new PostError("执行返修需要 expectedVersion 和 expectedProjectSha256（先读取所选工程或 dryRun）", "bad_request");
  }
  if (snapshot.version !== expectedVersion || snapshot.sha256 !== expectedProjectSha256) {
    throw new PostError("返修基础版本或工程指纹已变化，请重新读取后再提交", "revision_conflict");
  }
  revisionPath(base, snapshot.file);
  const lockPath = revisionPath(base, path.join(base, ".revision.lock"), true);
  let fd;
  try { fd = fs.openSync(lockPath, "wx", 0o600); }
  catch (error) {
    if (error.code === "EEXIST") throw new PostError("该交付包已有返修持有排他锁；不得覆盖或自动抢占未对账的锁", "revision_busy");
    throw new PostError(`无法认领返修锁：${error.message}`, "revision_io_failed");
  }
  const lockIdentity = fs.fstatSync(fd);
  const runId = randomUUID();
  let targetDir = null;
  let published = false;
  const claim = { runId, pid: process.pid, host: os.hostname(), at: new Date().toISOString(), projectId: snapshot.project.projectId,
    baseVersion: expectedVersion, baseProjectSha256: expectedProjectSha256 };
  const assertCurrent = () => {
    const lock = fs.lstatSync(lockPath);
    if (lock.isSymbolicLink() || lock.ino !== lockIdentity.ino || lock.dev !== lockIdentity.dev
      || JSON.parse(fs.readFileSync(lockPath, "utf8")).runId !== runId) {
      throw new PostError("返修锁归属已变化，禁止提交产物", "revision_conflict");
    }
    const { latest } = revisionHead(base);
    if (latest.version !== expectedVersion || latest.sha256 !== expectedProjectSha256
      || fs.realpathSync(latest.file) !== fs.realpathSync(snapshot.file)) {
      throw new PostError("返修基础已不是当前版本，禁止覆盖新版本", "revision_conflict");
    }
  };
  try {
    fs.writeFileSync(fd, `${JSON.stringify(claim, null, 2)}\n`);
    fs.fsyncSync(fd);
    assertCurrent();
    const version = revisionHead(base).highestReserved + 1;
    if (!Number.isSafeInteger(version)) throw new PostError("返修版本号越界", "bad_request");
    const expectedTarget = path.join(base, "versions", `v${version}`);
    if (outDir && path.resolve(outDir) !== path.resolve(expectedTarget)) {
      throw new PostError(`返修 outDir 必须是当前可认领的新版本目录：${expectedTarget}`, "revision_conflict");
    }
    const versionsDir = revisionPath(base, path.join(base, "versions"), true);
    fs.mkdirSync(versionsDir, { recursive: true });
    revisionPath(base, expectedTarget, true);
    fs.mkdirSync(expectedTarget); // atomic, recursive=false: an existing version is never overwritten
    targetDir = expectedTarget;
    fs.writeFileSync(path.join(targetDir, "revision-claim.json"), `${JSON.stringify({ ...claim, version }, null, 2)}\n`, { flag: "wx", mode: 0o600 });
    const publish = async (nextProject, revision) => {
      assertCurrent();
      const bytes = `${JSON.stringify(nextProject, null, 2)}\n`;
      const projectSha256 = createHash("sha256").update(bytes).digest("hex");
      revision.commit = { ...claim, version, projectSha256 };
      await writeJson(path.join(targetDir, "revision.json"), revision);
      const pending = path.join(targetDir, `.film-project-${runId}.pending`);
      try {
        const pendingFd = fs.openSync(pending, "wx", 0o600);
        try { fs.writeFileSync(pendingFd, bytes); fs.fsyncSync(pendingFd); }
        finally { fs.closeSync(pendingFd); }
        assertCurrent();
        const projectFile = path.join(targetDir, "film-project.json");
        fs.linkSync(pending, projectFile); // atomic publish; unlike rename, an existing name is never replaced
        published = true;
        return projectFile;
      } finally { await fsp.rm(pending, { force: true }); }
    };
    return await execute({ version, targetDir, publish });
  } catch (error) {
    if (targetDir && !published) {
      try {
        await writeJson(path.join(targetDir, "revision-failed.json"), {
          schemaVersion: "workloom.delivery-revision-failure/v1", ...claim, failedAt: new Date().toISOString(),
          code: error.code ?? "engine_failed", message: error instanceof Error ? error.message : String(error),
        });
      } catch (recordError) {
        throw new PostError(`返修失败且失败记录无法写入：${recordError.message}；原错误：${error.message}`, "revision_io_failed");
      }
    }
    throw error;
  } finally {
    fs.closeSync(fd);
    let lock;
    try { lock = fs.lstatSync(lockPath); }
    catch (error) { throw new PostError(`返修锁无法复核，未删除：${error.message}`, "revision_conflict"); }
    if (lock.ino !== lockIdentity.ino || lock.dev !== lockIdentity.dev || lock.isSymbolicLink()
      || JSON.parse(fs.readFileSync(lockPath, "utf8")).runId !== runId) {
      throw new PostError("返修锁已被替换，不删除其他持有者的锁", "revision_conflict");
    }
    fs.unlinkSync(lockPath);
  }
}

/**
 * 本地二次编辑：读工程文件 → 只重算受影响层 → 落到**新版本目录**（v2/v3…）。
 * 不重新生成镜头；点名到镜头的 patch 会被拒绝执行，只返回计划（fail-closed，钱不能自动烧）。
 * @param {{projectPath?: string, deliveryDir?: string|null, expectedVersion?: number|null,
 * expectedProjectSha256?: string|null, patch?: Record<string, any>, outDir?: string|null,
 * shotPaths?: Record<string, string>|null, bins?: {ffmpeg: string, ffprobe: string},
 * dryRun?: boolean, env?: NodeJS.ProcessEnv}} options
 */
export async function reedit({
  projectPath,
  deliveryDir = null,
  expectedVersion = null,
  expectedProjectSha256 = null,
  patch = {},
  feedback = null,
  variantId = null,
  idempotencyKey = null,
  outDir = null,
  shotPaths = null,
  audioStemsByShot = null,
  bins = resolveBinaries(),
  dryRun = false,
  env = process.env,
} = {}) {
  const v2file=assertPathAllowed(projectPath,allowedRoots(env));
  const v2project=JSON.parse(await fsp.readFile(v2file,"utf8"));
  if(v2project.schemaVersion==="workloom.film-project/v2") {
    const message=feedback??"按已登记后期层调整";
    const baseHash=await sha256File(v2file);
    if(dryRun) return {executed:false,version:v2project.version,projectSha256:baseHash,
      attribution:attributeCreativeFeedback(message,{variantId,variants:v2project.variants}),patch,renderApiCalls:0};
    const { reviseDirectorDelivery }=await import("./director-delivery.mjs");
    return reviseDirectorDelivery({projectPath:v2file,feedback:message,variantId,patch:Object.keys(patch).length?patch:null,
      expectedVersion:expectedVersion??v2project.version,expectedProjectSha256:expectedProjectSha256??baseHash,
      idempotencyKey:idempotencyKey??directorHash({file:v2file,version:v2project.version,feedback,patch,variantId}),outDir:outDir??undefined,bins,env});
  }
  const snapshot = readRevisionBase(projectPath);
  const projectFile = snapshot.file;
  const project = snapshot.project;
  const impact = analyzeImpact({ project, patch });
  /**
   * 两个基准必须分开（2026-09-24 真机修复）：
   *   · `projectDir`：工程文件所在目录——**产物路径按它解析**（约定：路径相对工程文件自己所在目录）；
   *   · `base`：交付包根——**新版本目录与缓存按它落盘**（`versions/vN`、`work/`）。
   * 早先把两者都当成 projectDir，于是连续返修（基线 = versions/v2/film-project.json）会把新版本写成
   * `versions/v2/versions/v3`（嵌套两层）——版本链看着像有、其实结构已经错了。
   */
  const projectDir = path.dirname(projectFile);
  const inferredRoot = path.basename(path.dirname(projectDir)) === "versions"
    && path.basename(projectDir) === `v${project.version}`
    ? path.dirname(path.dirname(projectDir))
    : projectDir;
  const base = deliveryDir ? path.resolve(deliveryDir)
    : project.deliveryRoot ? path.resolve(projectDir, project.deliveryRoot) : inferredRoot;
  const version = project.version + 1;
  const targetDir = path.resolve(outDir ?? path.join(base, "versions", `v${version}`));

  if (impact.shotRegeneration.required && !shotPaths) {
    return {
      executed: false,
      impact,
      blocked: {
        code: "shot_regeneration_required",
        message: "该返修点名到画面内容：需要先重新生成镜头（G8 人审 + 只重跑点名镜头），再回到本地合成",
        nextActions: [
          "① 走渲染链路重跑被点名镜头（render-project.mts --only <shotIds>），产物落回素材库",
          "② 带上 `shotPaths`（shotId → 新镜头文件）重新调用 postwrite.reedit：那时就只做本地合成",
        ],
      },
      version,
      targetDir,
    };
  }

  const plan = impact;
  if (dryRun) {
    return { executed: false, dryRun: true, impact: plan, version, targetDir,
      expectedVersion: snapshot.version, expectedProjectSha256: snapshot.sha256 };
  }

  return withRevisionClaim({ base, snapshot, expectedVersion, expectedProjectSha256, outDir }, async ({ version, targetDir, publish }) => {
    const projectShots = (project.layers?.shots ?? []).map((shot) => ({
      shotId: shot.shotId,
      stored: shot,
    }));
    const [width, height] = project.resolution ?? [1080, 1920];
    const quality = resolveQuality(project);
    const fps = Number(project.fps ?? 30);
    const workDir = path.join(base, "work");
    await fsp.mkdir(path.join(targetDir, "variants"));

    const rebuilt = [];
    const reused = [];
    const hasIndependentAudio = Boolean(project.layers?.audioStems);
    const priorMasterStems = hasIndependentAudio
      ? await verifyStoredStems(project.layers.audioStems, project, projectDir, env, bins) : null;
    const priorSources = priorMasterStems ? descriptorsFromBundle(priorMasterStems) : {};


    /**
     * 层 1：镜头产物（**返修的地基**）。
     * 没被点名的镜头一律直接复用上一次归一化的产物，并复核哈希与工程文件一致——
     * 这样"不重新生成镜头"不是一句承诺，而是可以在 `revision.json` 里逐镜对账的哈希。
     * 只有被点名的镜头（shotPaths 传入的新产物）才重新归一化。
     */
    const normalised = [];
    for (const entry of projectShots) {
      const replacement = shotPaths?.[entry.shotId];
      if (replacement) {
        if (hasIndependentAudio && !audioStemsByShot?.[entry.shotId]) throw new PostError(`显式独立分轨工程的替换镜头 ${entry.shotId} 缺新来源回执`, "audio_stems_source_unverified");
        const [clip] = await normaliseShots({
          shots: [{ shotId: entry.shotId, path: replacement, kind: entry.stored.kind ?? "live-action", audioStems: audioStemsByShot?.[entry.shotId] }],
          project: { projectId: project.projectId, resolution: [width, height], quality, fps },
          workDir,
          bins,
          reuse: true, env,
        });
        normalised.push(clip);
        rebuilt.push({ layer: "shots", shotId: clip.shotId, path: clip.path, sha256: clip.sha256, note: "点名镜头：用重生成后的新产物归一化" });
        continue;
      }
      const file = resolveStored(projectDir, entry.stored.normalised);
      if (!fs.existsSync(file)) throw new PostError(`返修需要的镜头产物缺失：${entry.shotId} → ${file}`, "not_found");
      const sha256 = await sha256File(file);
      if (!entry.stored.sha256 || sha256 !== entry.stored.sha256) {
        throw new PostError(`返修镜头 ${entry.shotId} 的归一化产物与工程文件哈希不一致：请通过 shotPaths 显式替换或从原素材重新归一化`, "verify_failed");
      }
      const originalSource = resolveStored(projectDir, entry.stored.source ?? entry.stored.normalised);
      if (!entry.stored.sourceSha256 || !fs.existsSync(originalSource)
        || await sha256File(originalSource) !== entry.stored.sourceSha256) {
        throw new PostError(`返修镜头 ${entry.shotId} 的原始素材缺失或字节变化：请通过 shotPaths 显式替换`, "verify_failed");
      }
      const reusedProbe = await probeMedia(file, { bins });
      if (!(reusedProbe.videoDuration > 0)) {
        throw new PostError(`返修镜头 ${entry.shotId} 缺视频轨时长`, "bad_media");
      }
      const clip = {
        shotId: entry.shotId,
        source: originalSource,
        sourceHash: entry.stored.sourceSha256 ?? null,
        sourceDuration: entry.stored.sourceDuration ?? entry.stored.duration,
        audioStems: priorSources[entry.shotId] ?? null,
        sourceKind: entry.stored.kind ?? "live-action",
        quality,
        enhancement: entry.stored.enhancement ? {
          ...entry.stored.enhancement,
          output: entry.stored.enhancement.output ? resolveStored(projectDir, entry.stored.enhancement.output) : null,
          provenancePath: entry.stored.enhancement.provenancePath ? resolveStored(projectDir, entry.stored.enhancement.provenancePath) : null,
        } : null,
        path: file,
        sha256,
        duration: reusedProbe.videoDuration,
        reused: true,
      };
      normalised.push(clip);
      reused.push({ layer: "shots", shotId: clip.shotId, path: file, sha256, note: "复用上次归一化产物（哈希与工程文件一致）" });
    }

    const nextMasterStems = priorMasterStems && patch.shots
      ? await timelineStems({ project, clips: normalised, transitions: project.layers.transitions ?? {}, workDir, env, bins })
      : priorMasterStems;
    const variantIds = (project.layers?.variants ?? []).map((variant) => variant.id);
    const variantsOut = [];
    for (const variantId of variantIds) {
      const stored = project.layers.variants.find((variant) => variant.id === variantId);
      const pack = structuredClone(findVariantPack(variantId));
      const appliesToVariant = (change) => Boolean(change)
        && (change.variantId === undefined || change.variantId === variantId);
      const scoped = {
        subtitles: appliesToVariant(patch.subtitles),
        bgm: appliesToVariant(patch.bgm),
        color: appliesToVariant(patch.color),
        transitions: appliesToVariant(patch.transitions),
        cover: appliesToVariant(patch.cover),
        copy: appliesToVariant(patch.copy),
      };
      const rebuildVariant = {
        assemble: Boolean(patch.shots) || scoped.transitions,
        color: Boolean(patch.shots) || scoped.transitions || scoped.color,
        audio: Boolean(patch.shots) || scoped.transitions || scoped.color || scoped.bgm,
        text: Boolean(patch.shots) || scoped.transitions || scoped.subtitles,
        cover: Boolean(patch.shots) || scoped.transitions || scoped.color || scoped.cover,
      };
      const priorStyle = stored?.style ?? {};
      if (priorStyle.color) pack.color = { ...(pack.color ?? {}), ...priorStyle.color };
      else if (stored?.color) {
        for (const key of ["profile", "lut", "intensity"]) {
          if (stored.color[key] !== undefined) pack.color = { ...(pack.color ?? {}), [key]: stored.color[key] };
        }
      }
      if (priorStyle.bgm) pack.bgm = { ...(pack.bgm ?? {}), ...priorStyle.bgm };
      const bgmSelectionChanged = scoped.bgm
        && ["trackId", "mood", "genre", "style", "enabled"].some((key) => Object.hasOwn(patch.bgm, key));
      if (stored?.bgm?.trackId && !bgmSelectionChanged) {
        pack.bgm = {
          ...(pack.bgm ?? {}), trackId: stored.bgm.trackId, policy: stored.bgm.policy ?? pack.bgm?.policy,
          mood: undefined, genre: undefined, style: undefined,
        };
      }
      if (priorStyle.transitions) pack.transitions = { ...(pack.transitions ?? {}), ...priorStyle.transitions };
      else if (stored?.assembly?.mode) pack.transitions = { ...(pack.transitions ?? {}), mode: stored.assembly.mode };
      if (priorStyle.cover) pack.cover = { ...(pack.cover ?? {}), ...priorStyle.cover };
      if (priorStyle.copyTone) pack.copy = { ...(pack.copy ?? {}), tone: priorStyle.copyTone };
      if (scoped.bgm) {
        pack.bgm = {
          ...pack.bgm,
          ...(bgmSelectionChanged ? { trackId: undefined, mood: undefined, genre: undefined, style: undefined } : {}),
          ...patch.bgm,
        };
        delete pack.bgm.variantId;
      }
      if (scoped.color) {
        pack.color = { ...(pack.color ?? {}), ...patch.color };
        delete pack.color.variantId;
      }
      if (scoped.transitions) {
        pack.transitions = { ...(pack.transitions ?? {}), ...patch.transitions };
        delete pack.transitions.variantId;
      }
      if (scoped.cover) {
        pack.cover = { ...(pack.cover ?? {}), ...patch.cover };
        delete pack.cover.variantId;
      }
      if (scoped.copy) {
        pack.copy = { ...(pack.copy ?? {}), ...patch.copy };
        delete pack.copy.variantId;
      }

      const variantDir = path.join(targetDir, "variants", variantId);
      await fsp.mkdir(variantDir, { recursive: true });
      const previousVideo = stored?.artifacts?.video?.path ? resolveStored(projectDir, stored.artifacts.video.path) : null;
      const previousSoftsub = stored?.artifacts?.softsub?.path ? resolveStored(projectDir, stored.artifacts.softsub.path) : null;
      const previousCover = stored?.artifacts?.cover?.path ? resolveStored(projectDir, stored.artifacts.cover.path) : null;

      // 拼接层（只有转场/镜头变化才重算）
      let assemblyPath = stored?.assembly?.path ? resolveStored(projectDir, stored.assembly.path) : null;
      let assemblyReused = true;
      const assemblyTrustedFromStored = !rebuildVariant.assemble && Boolean(stored?.assembly?.sha256)
        && Boolean(assemblyPath) && fs.existsSync(assemblyPath);
      if (assemblyTrustedFromStored) {
        await assertStoredArtifact(assemblyPath, stored.assembly.sha256, `返修变体 ${variantId} 拼接层`);
      } else {
        const transitions = { ...(project.layers.transitions ?? {}), ...(pack.transitions ?? {}) };
        const key = await contentKey({ shots: normalised.map((clip) => clip.sha256), transitions, v: 2 });
        const receiptKey = await contentKey({ key, type: "assembly" });
        assemblyPath = path.join(workDir, "assemble", `${variantId}-${key}.mp4`);
        const metaPath = path.join(workDir, "assemble", `${variantId}-${key}.json`);
        if (fs.existsSync(assemblyPath) && fs.existsSync(metaPath)) {
          let meta;
          try { meta = JSON.parse(await fsp.readFile(metaPath, "utf8")); }
          catch (error) {
            throw new PostError(`返修变体 ${variantId} 拼接缓存回执不可读：${error instanceof Error ? error.message : String(error)}`, "verify_failed");
          }
          if (meta.key !== receiptKey) throw new PostError(`返修变体 ${variantId} 拼接缓存键不匹配`, "verify_failed");
          await assertStoredArtifact(assemblyPath, meta.sha256, `返修变体 ${variantId} 拼接缓存`);
        } else {
          await assembleTimeline({ clips: normalised, transitions, output: assemblyPath, resolution: [width, height], fps, quality, bins });
          await writeJson(metaPath, { sha256: await sha256File(assemblyPath), key: receiptKey });
          assemblyReused = false;
        }
      }
      const assemblyProbe = await probeMedia(assemblyPath, { bins });
      if (assemblyProbe.width !== width || assemblyProbe.height !== height || !assemblyProbe.hasAudio) {
        throw new PostError(`返修变体 ${variantId} 拼接层规格不符`, "verify_failed");
      }
      const assemblySha256 = await sha256File(assemblyPath);
      (assemblyReused ? reused : rebuilt).push({ layer: "assemble", variant: variantId, path: assemblyPath, reused: assemblyReused });

      // 调色层
      let gradedInput = assemblyPath;
      let colorReused = true;
      const storedColorPath = stored?.color?.path ? resolveStored(projectDir, stored.color.path) : null;
      const colorTrustedFromStored = pack.color && !rebuildVariant.color && assemblyTrustedFromStored
        && Boolean(stored?.color?.sha256) && Boolean(storedColorPath) && fs.existsSync(storedColorPath);
      if (pack.color && !colorTrustedFromStored) {
        const gradedPath = path.join(workDir, "graded", `${variantId}-re${version}.mp4`);
        const report = await colorGrade({
          input: assemblyPath,
          output: gradedPath,
          profile: pack.color.profile ?? null,
          lutPath: pack.color.lut ? resolveLut(pack.color.lut) : null,
          intensity: optionalNumber(pack.color.intensity, 0.8),
          quality, verify: false, defects: false,
          bins,
        });
        gradedInput = gradedPath;
        colorReused = false;
        (rebuilt).push({ layer: "color", variant: variantId, path: gradedPath, sha256: report.sha256 });
      } else if (colorTrustedFromStored) {
        await assertStoredArtifact(storedColorPath, stored.color.sha256, `返修变体 ${variantId} 调色层`);
        gradedInput = storedColorPath;
        reused.push({ layer: "color", variant: variantId, path: gradedInput, sha256: stored.color.sha256 });
      }
      const gradedSha256 = await sha256File(gradedInput);

      const stemTransitions = { ...(project.layers.transitions ?? {}), ...(pack.transitions ?? {}) };
      let stems = null;
      if (hasIndependentAudio) {
        stems = rebuildVariant.assemble || !stored.audioStems
          ? await timelineStems({ project, clips: normalised, transitions: stemTransitions, workDir, env, bins })
          : await verifyStoredStems(stored.audioStems, project, projectDir, env, bins);
      }
      // 音频层
      const videoTarget = path.join(variantDir, `${variantId}.mp4`);
      const audioReceiptPath = path.join(variantDir, "audio.json");
      let audioPassed = false;
      let trackId = stored?.bgm?.trackId ?? null;
      if (rebuildVariant.audio || !assemblyTrustedFromStored || (pack.color && !colorTrustedFromStored)) {
        const audioOutcome = await mixVariantAudio({ pack, gradedInput, workDir, output: videoTarget, bins, env, stems });
        trackId = audioOutcome.track?.id ?? null;
        audioPassed = !audioOutcome.failure;
        await writeJson(path.join(variantDir, "audio.json"), audioOutcome.failure
          ? { track: null, failed: true, code: audioOutcome.failure.code, message: audioOutcome.failure.message, note: "实际配乐处理失败，当前返修未完成" }
          : audioOutcome.report
            ? {
              track: audioOutcome.track,
              policy: pack.bgm?.policy ?? "keep-dialogue",
              musicLevelDb: pack.bgm?.musicLevelDb ?? null,
              mixing: audioOutcome.report.mixing ?? null,
              loudness: audioOutcome.report.loudness,
              checks: audioOutcome.report.checks,
              levels: audioOutcome.report.levels,
              applicability: audioOutcome.report.applicability,
              retainedTracks: audioOutcome.report.retainedTracks,
              independentAudio: audioOutcome.report.independentAudio,
              ...(audioOutcome.reused ? { reused: true, cacheKey: audioOutcome.cacheKey } : {}),
            }
            : { track: null, policy: "原声（变体刻意不配乐）" });
        const row = { layer: "audio", variant: variantId, path: videoTarget, sha256: await sha256File(videoTarget) };
        if (audioOutcome.reused && !audioOutcome.failure) reused.push({ ...row, note: "混音缓存命中（画面与曲目未变，未重跑混音）" });
        else rebuilt.push(audioOutcome.failure ? { ...row, failure: audioOutcome.failure } : row);
      } else {
        await assertStoredArtifact(previousVideo, stored?.artifacts?.video?.sha256, `返修变体 ${variantId} 视频`);
        await fsp.copyFile(previousVideo, videoTarget);
        if (stored?.artifacts?.audio) {
          const previousAudio = resolveStored(projectDir, stored.artifacts.audio.path);
          await assertStoredArtifact(previousAudio, stored.artifacts.audio.sha256, `返修变体 ${variantId} 音频回执`);
          await fsp.copyFile(previousAudio, audioReceiptPath);
          const priorAudio = JSON.parse(await fsp.readFile(audioReceiptPath, "utf8"));
          audioPassed = priorAudio.failed !== true && (pack.bgm?.enabled === false || priorAudio.checks?.processingSucceeded === true);
        } else {
          await writeJson(audioReceiptPath, { failed: true, code: "audio_stems_source_unverified", note: "旧工程缺少冻结音频回执，仅保留草稿" });
        }
        reused.push({ layer: "audio", variant: variantId, path: previousVideo, sha256: stored?.artifacts?.video?.sha256 ?? null });
      }

      // 文字层：旁挂字幕 + 软字幕轨
      const subtitleFiles = (project.layers?.text?.files ?? []);
      let textDir = project.layers?.text?.sidecarDir ? resolveStored(projectDir, project.layers.text.sidecarDir) : path.join(projectDir, "subtitles");
      let softsub = null;
      let softsubReused = true;
      if (rebuildVariant.text) {
        const { parseSrt } = await import("../subtitle-bridge/core.mjs");
        const baseCuesPath = subtitleFiles.find((file) => file.format === "srt" && file.lang === "chi")?.path;
        const zhText = patch.subtitles?.zhText
          ?? (patch.subtitles?.zhPath ? await fsp.readFile(path.resolve(patch.subtitles.zhPath), "utf8") : null)
          ?? (baseCuesPath ? await fsp.readFile(path.join(projectDir, baseCuesPath), "utf8") : null);
        if (!zhText) throw new PostError("返修文字层缺少字幕内容（既没有 patch.subtitles，也没有原字幕）", "bad_request");
        const enText = patch.subtitles?.enText
          ?? (patch.subtitles?.enPath ? await fsp.readFile(path.resolve(patch.subtitles.enPath), "utf8") : null)
          ?? (() => {
            const enPath = subtitleFiles.find((file) => file.format === "srt" && file.lang === "eng")?.path;
            return enPath ? fs.readFileSync(path.join(projectDir, enPath), "utf8") : null;
          })();
        textDir = path.join(targetDir, "subtitles");
        const sidecar = await exportSidecars({
          input: videoTarget,
          outputDir: textDir,
          name: project.projectId,
          cues: parseSrt(zhText),
          cuesEn: enText ? parseSrt(enText) : [],
          platform: project.platform ?? null,
          brief: { 平台: project.platform ?? "默认" },
          bins,
        });
        softsubReused = false;
        rebuilt.push({ layer: "text", variant: variantId, path: sidecar.manifestPath, files: sidecar.files.length, checks: sidecar.checks.map((check) => ({ kind: check.kind, ok: check.ok })) });
      }
      if (scoped.subtitles && patch.subtitles?.burn === true) {
        const { renderWithSubtitles, parseSrt } = await import("../subtitle-bridge/core.mjs");
        const cues = parseSrt(await fsp.readFile(path.join(textDir, `${project.projectId}.zh.srt`), "utf8"));
        const burned = await renderWithSubtitles({
          mode: "subtitle", input: videoTarget, output: path.join(variantDir, `${variantId}.burned.mp4`),
          cues, platform: project.platform ?? null, brief: { 平台: project.platform ?? "默认" }, bins,
        });
        rebuilt.push({ layer: "text-burn", variant: variantId, path: burned.output.path, sha256: burned.output.hash });
      }
      const shouldSoftMux = rebuildVariant.text || rebuildVariant.audio || rebuildVariant.color || rebuildVariant.assemble
        || !assemblyTrustedFromStored || (pack.color && !colorTrustedFromStored) || !previousSoftsub;
      if (shouldSoftMux) {
        const srtFiles = fs.existsSync(textDir)
          ? (await fsp.readdir(textDir)).filter((file) => file.endsWith(".srt")).sort()
          : [];
        if (srtFiles.length) {
          softsub = await softMux({
            input: videoTarget,
            output: path.join(variantDir, `${variantId}.softsub.mp4`),
            subtitles: srtFiles.map((file, index) => ({
              path: path.join(textDir, file),
              lang: file.includes(".en.") ? "eng" : "chi",
              title: file.includes(".en.") ? "English" : "中文",
              default: index === 0,
            })),
            bins,
          });
          softsubReused = false;
          rebuilt.push({ layer: "text", variant: variantId, path: softsub.output, tracks: softsub.tracks.length, videoUnchanged: true });
        }
      } else if (previousSoftsub) {
        await assertStoredArtifact(previousSoftsub, stored?.artifacts?.softsub?.sha256, `返修变体 ${variantId} 软字幕视频`);
        await fsp.copyFile(previousSoftsub, path.join(variantDir, `${variantId}.softsub.mp4`));
        softsub = { output: path.join(variantDir, `${variantId}.softsub.mp4`), sha256: await sha256File(previousSoftsub) };
        reused.push({ layer: "text", variant: variantId, path: previousSoftsub, sha256: stored?.artifacts?.softsub?.sha256 ?? null });
      }

      // 封面 + 文案
      const coverTarget = path.join(variantDir, "cover.png");
      if (rebuildVariant.cover || !assemblyTrustedFromStored || (pack.color && !colorTrustedFromStored) || !previousCover) {
        const cover = await buildCover({
          input: gradedInput, output: coverTarget, project, variant: pack, resolution: [width, height],
          platform: project.platform ?? null, bins, workDir,
        });
        rebuilt.push({ layer: "cover", variant: variantId, path: cover.output, sha256: cover.sha256 });
      } else {
        await assertStoredArtifact(previousCover, stored?.artifacts?.cover?.sha256, `返修变体 ${variantId} 封面`);
        await fsp.copyFile(previousCover, coverTarget);
        reused.push({ layer: "cover", variant: variantId, path: previousCover, sha256: stored?.artifacts?.cover?.sha256 ?? null });
      }
      const copy = buildCopyPack({ project: { ...project, copy: { ...(project.layers.copy ?? {}), ...(scoped.copy ? patch.copy : {}) } }, variant: pack });
      await fsp.writeFile(path.join(variantDir, "copy.md"), copy.markdown, "utf8");
      await writeJson(path.join(variantDir, "copy.json"), { ...copy, checks: copy.checks });

      const videoProbe = await probeMedia(videoTarget, { bins });
      if (videoProbe.width !== width || videoProbe.height !== height) {
        throw new PostError(`返修变体 ${variantId} 规格不符：实测 ${videoProbe.width}×${videoProbe.height}，目标 ${width}×${height}`, "verify_failed");
      }
      variantsOut.push({
        id: variantId,
        name: pack.name,
        dir: variantDir,
        layers: {
          audioStems: stems ? stemReference(stems) : null,
          assembly: { path: assemblyPath, sha256: assemblySha256, reused: assemblyReused },
          color: pack.color ? { path: gradedInput, sha256: gradedSha256, reused: colorReused } : null,
        },
        video: { path: videoTarget, sha256: await sha256File(videoTarget), duration: videoProbe.duration, resolution: [videoProbe.width, videoProbe.height] },
        softsub: softsub ? { path: softsub.output, sha256: await sha256File(softsub.output), reused: softsubReused } : null,
        cover: { path: coverTarget, sha256: await sha256File(coverTarget) },
        copy: { path: path.join(variantDir, "copy.md"), title: copy.title, hashtags: copy.hashtags, checks: copy.checks },
        bgm: trackId ? { trackId, policy: pack.bgm?.policy ?? "keep-dialogue" } : null,
        audioReceipt: { path: audioReceiptPath, sha256: await sha256File(audioReceiptPath), passed: audioPassed },
        style: { color: pack.color ?? null, bgm: pack.bgm ?? null, transitions: pack.transitions ?? null, cover: pack.cover ?? null, copyTone: pack.copy?.tone ?? null },
      });
    }

    const revision = {
      schemaVersion: "workloom.delivery-revision/v1",
      at: new Date().toISOString(),
      version,
      patch,
      impact,
      rebuilt,
      reused,
      quality,
      resolution: [width, height],
      checks: [{ kind: "source_audio_preserved", ok: true, detail: { independentStemsProvided: hasIndependentAudio, embeddedAudioUsed: !hasIndependentAudio, qualityReviewed: false } },
        { kind: "bgm_layer", ok: variantsOut.every((variant) => variant.audioReceipt.passed === true), detail: variantsOut.map((variant) => ({ id: variant.id, passed: variant.audioReceipt.passed })) },
        { kind: "resolution_exact", ok: variantsOut.every((variant) => variant.video.resolution[0] === width && variant.video.resolution[1] === height), detail: { requested: [width, height], variants: variantsOut.map((variant) => ({ id: variant.id, resolution: variant.video.resolution })) } }],
      outDir: targetDir,
      note: impact.localOnly ? "本地重合成（未重新生成镜头）" : "含镜头重生成后重新合成",
    };
    const nextProject = {
      ...project,
      version,
      deliveryRoot: path.relative(targetDir, base) || ".",
      updatedAt: revision.at,
      layers: {
        ...project.layers,
        audioStems: nextMasterStems ? stemReference(nextMasterStems, targetDir) : null,
        /**
         * 路径一律相对**新工程文件所在目录**重写：返修可以连续做多轮（v2 → v3 → v4），
         * 每轮的工程文件都必须能独立解析到自己用到的镜头/拼接/调色产物，
         * 否则第二轮返修会指着上一轮目录里的相对路径找不到文件（真机第一版就踩了这个坑）。
         */
        shots: (project.layers?.shots ?? []).map((shot) => {
          const fresh = normalised.find((clip) => clip.shotId === shot.shotId);
          if (!fresh) throw new PostError(`返修缺少镜头产物：${shot.shotId}`, "not_found");
          return {
            ...shot,
            source: path.relative(targetDir, path.resolve(fresh.source)),
            normalised: path.relative(targetDir, fresh.path),
            sha256: fresh.sha256,
            sourceSha256: fresh.sourceHash,
            sourceDuration: fresh.sourceDuration,
            duration: fresh.duration,
            kind: fresh.sourceKind ?? shot.kind ?? "live-action",
            enhancement: fresh.enhancement ? {
              ...fresh.enhancement,
              output: fresh.enhancement.output ? path.relative(targetDir, fresh.enhancement.output) : null,
              provenancePath: fresh.enhancement.provenancePath ? path.relative(targetDir, fresh.enhancement.provenancePath) : null,
            } : null,
          };
        }),
        variants: (project.layers?.variants ?? []).map((stored) => {
          const fresh = variantsOut.find((variant) => variant.id === stored.id);
          if (!fresh) return stored;
          return {
            ...stored,
            bgm: fresh.bgm,
            style: fresh.style,
            audioStems: fresh.layers.audioStems ? { ...fresh.layers.audioStems, dir: path.relative(targetDir, fresh.layers.audioStems.dir) } : null,
            assembly: fresh.layers?.assembly
              ? { ...(stored.assembly ?? {}), path: path.relative(targetDir, fresh.layers.assembly.path), sha256: fresh.layers.assembly.sha256, reused: fresh.layers.assembly.reused }
              : stored.assembly ?? null,
            color: fresh.layers?.color
              ? {
                ...(stored.color ?? {}),
                path: path.relative(targetDir, fresh.layers.color.path),
                sha256: fresh.layers.color.sha256,
                reused: fresh.layers.color.reused,
              }
              : null,
            artifacts: {
              ...stored.artifacts,
              audio: { path: path.relative(targetDir, fresh.audioReceipt.path), sha256: fresh.audioReceipt.sha256 },
              video: { path: path.relative(targetDir, fresh.video.path), sha256: fresh.video.sha256 },
              softsub: fresh.softsub ? { path: path.relative(targetDir, fresh.softsub.path), sha256: fresh.softsub.sha256 } : null,
              cover: { path: path.relative(targetDir, fresh.cover.path), sha256: fresh.cover.sha256 },
              copy: { path: path.relative(targetDir, fresh.copy.path) },
            },
          };
        }),
      },
      history: [...(project.history ?? []), { at: revision.at, kind: "revision", version, patch, localOnly: impact.localOnly }],
    };
    const projectPathOut = await publish(nextProject, revision);
    return {
      executed: true,
      version,
      targetDir,
      projectPath: projectPathOut,
      impact,
      revisionPath: path.join(targetDir, "revision.json"),
      revision,
      variants: variantsOut,
      rebuilt,
      reused,
      summary: {
        rebuiltLayers: [...new Set(rebuilt.map((row) => row.layer))],
        reusedLayers: [...new Set(reused.map((row) => row.layer))],
        // 同一次返修里"哪些层被重算、哪些层被复用"要能按变体看清楚：
        // 比如"只改了 clean-tech 的配乐"，就不该让 warm-story / bold-promo 显得也被重算。
        rebuiltByLayer: [...new Set(rebuilt.map((row) => row.layer))].map((layer) => ({
          layer,
          variants: [...new Set(rebuilt.filter((row) => row.layer === layer).map((row) => row.variant).filter(Boolean))],
          count: rebuilt.filter((row) => row.layer === layer).length,
        })),
        reusedByLayer: [...new Set(reused.map((row) => row.layer))].map((layer) => ({
          layer,
          variants: [...new Set(reused.filter((row) => row.layer === layer).map((row) => row.variant).filter(Boolean))],
          count: reused.filter((row) => row.layer === layer).length,
        })),
        tokenCostDelta: impact.costHint.tokenCostDelta,
        note: impact.costHint.note,
      },
    };
  });
}

/* ============================ 反馈分诊（把话变成返修任务） ============================ */

/**
 * 反馈 → 归因 → 路由（确定性规则表，不依赖 LLM，可复算、可考试）。
 * 规则表只回答"改哪一层"，不替代人做取舍：命中画面内容即要求走镜头重生成 + 人审。
 */
export const REVISION_RULES = [
  {
    kind: "shot",
    attribution: "rev.shot.content",
    layers: ["shots", "assemble", "color", "audio", "text"],
    requiresShotRegen: true,
    patterns: [/镜头|画面里|画面中|人物|主角|脸|穿帮|重拍|换镜头|重生成|不清楚|模糊|晃动|变形|走形|手|穿模|少了|多了个/i],
    reply: "这条意见动到画面内容：需要重新生成被点名的镜头（会消耗额度，先过 G8 人审），其余镜头与后期全部复用。",
  },
  {
    kind: "audio",
    attribution: "rev.audio.mix",
    layers: ["audio", "text"],
    requiresShotRegen: false,
    patterns: [/音乐|配乐|bgm|背景音|太吵|太响|声音小|没声音|音量大|音量小|换个曲|曲风|节奏感不够/i],
    reply: "配乐问题走本地重混：换曲/调音量只重算音频层，画面逐帧不动。",
  },
  {
    kind: "color",
    attribution: "rev.color.look",
    layers: ["color", "audio", "text"],
    requiresShotRegen: false,
    patterns: [/颜色|调色|色调|太暗|太亮|偏黄|偏蓝|偏冷|偏暖|发灰|饱和|对比度|黑白/i],
    reply: "调色问题走本地重调：从既有拼接母版重跑调色，镜头不重新生成。",
  },
  {
    kind: "text",
    attribution: "rev.text.track",
    layers: ["text"],
    requiresShotRegen: false,
    patterns: [/字幕|错别字|错字|文字|时间轴|台词|听译|标点|双语|英文|繁体|字号|描边/i],
    reply: "字幕问题走本地重出：旁挂字幕文件 + 软字幕轨重算，画面逐帧不动。",
  },
  {
    kind: "cover",
    attribution: "rev.cover.layout",
    layers: ["cover"],
    requiresShotRegen: false,
    patterns: [/封面|首图|头图|缩略图|封面图|封面字/i],
    reply: "封面问题只重出封面图，成片不动。",
  },
  {
    kind: "copy",
    attribution: "rev.copy.tone",
    layers: ["copy"],
    requiresShotRegen: false,
    patterns: [/文案|标题|话题|标签|#|简介|口吻|语气|措辞|导语|卖点/i],
    reply: "文案问题只重出文案包（标题/钩子/话题/CTA），成片不动。",
  },
  {
    kind: "edit",
    attribution: "rev.edit.pacing",
    layers: ["assemble", "color", "audio", "text"],
    requiresShotRegen: false,
    patterns: [/转场|节奏|太慢|太快|顺序|剪辑|镜头顺序|时长|拖沓|卡点/i],
    reply: "剪辑问题走本地重拼：转场/节奏/顺序从既有镜头产物重算，镜头不重新生成。",
  },
];

/**
 * 从自由文本里点名镜头。用户不会按我们的命名习惯说话，所以四种常见说法都要认：
 *   `SC-03` / `sc03`（内部编号）、`镜头3` / `第三个镜头`（按序号）、`shot 3`（英文）。
 * 认不出来就**不猜**：返回空数组，由调用方按"未点名"处理（而不是随便挑一个镜头重跑）。
 */
export function extractShotIds(feedback, knownShotIds = []) {
  const text = String(feedback ?? "");
  const found = new Set();
  const byIndex = (raw) => {
    const index = Number(raw);
    if (!Number.isFinite(index) || index <= 0) return null;
    return knownShotIds[index - 1]
      ?? knownShotIds.find((shotId) => new RegExp(`0*${index}$`).test(shotId))
      ?? null;
  };
  for (const match of text.matchAll(/\b([A-Za-z]{1,4}-?\d{1,3})\b/g)) {
    const raw = match[1];
    const hit = knownShotIds.find((shotId) => shotId.toLowerCase() === raw.toLowerCase());
    if (hit) found.add(hit);
  }
  const ordinalPatterns = [
    /镜头\s*([0-9]{1,3})/g,          // 镜头3 / 镜头 3
    /第\s*([0-9]{1,3})\s*个?\s*镜头/g, // 第3个镜头 / 第 3 镜头
    /第\s*([0-9]{1,3})\s*镜/g,        // 第3镜
    /\bshot\s*([0-9]{1,3})\b/gi,      // shot 3
    /\bsc(?:ene)?\s*([0-9]{1,3})\b/gi, // scene 3
  ];
  for (const pattern of ordinalPatterns) {
    for (const match of text.matchAll(pattern)) {
      const hit = byIndex(match[1]);
      if (hit) found.add(hit);
    }
  }
  return [...found];
}

export function triageFeedback({ feedback, project = null, variants = null } = {}) {
  if(project?.schemaVersion==="workloom.film-project/v2" || project?.creativeMode==="director_auto") {
    return attributeCreativeFeedback(feedback,{variants:project.variants??(variants??[]).map(id=>({id}))});
  }
  const message = text(feedback, "feedback");
  const knownShotIds = (project?.layers?.shots ?? []).map((shot) => String(shot.shotId));
  const hits = REVISION_RULES.filter((rule) => rule.patterns.some((pattern) => pattern.test(message)));
  const rules = hits.length ? hits : [{
    kind: "unclear",
    attribution: "other",
    layers: [],
    requiresShotRegen: false,
    reply: "这条意见没落到已定义的返修轴上：请指认要改的是字幕 / 配乐 / 调色 / 封面 / 文案 / 剪辑，还是画面内容（镜头）。",
  }];
  const shotIds = extractShotIds(message, knownShotIds);
  const requiresShotRegen = rules.some((rule) => rule.requiresShotRegen);
  const layers = [...new Set(rules.flatMap((rule) => rule.layers))];
  const orderedLayers = LAYER_ORDER.filter((layer) => layers.includes(layer));
  const namedVariants = Array.isArray(variants) && variants.length
    ? variants.filter((variant) => message.includes(variant) || message.includes(variant))
    : [];
  return {
    schemaVersion: "workloom.delivery-triage/v1",
    feedback: message,
    kinds: rules.map((rule) => rule.kind),
    attributions: rules.map((rule) => rule.attribution),
    layers: orderedLayers,
    requiresShotRegeneration: requiresShotRegen,
    shotIds,
    namedVariants,
    gate: requiresShotRegen ? "G8" : null,
    costHint: requiresShotRegen
      ? { tokenCostDelta: ">0", note: "需要重生成点名镜头（人审后执行）" }
      : { tokenCostDelta: 0, note: "本地重合成即可，无需重新生成镜头" },
    reply: rules.map((rule) => rule.reply).join(" "),
    nextActions: requiresShotRegen
      ? [
        "① 生成返修单（含点名镜头）→ G8 人审",
        "② 只重跑点名镜头（render-project.mts --only <shotIds>）",
        "③ 带新镜头路径调 postwrite.reedit 完成本地合成",
      ]
      : [
        "① 生成 patch（只含受影响层）",
        "② 调 postwrite.reedit：本地重合成出新版本（镜头与未受影响层复用）",
        "③ 对比新旧版本 sha256 与差异，出返修回执",
      ],
    patchHint: {
      ...(orderedLayers.includes("text") ? { subtitles: { zhText: "<新字幕文本或路径>" } } : {}),
      ...(orderedLayers.includes("audio") ? { bgm: { trackId: "<曲目 id> 或 mood/style" } } : {}),
      ...(orderedLayers.includes("color") ? { color: { profile: "<profile 或 lut>", intensity: 0.8 } } : {}),
      ...(orderedLayers.includes("cover") ? { cover: { at: 0.35 } } : {}),
      ...(orderedLayers.includes("copy") ? { copy: { cta: "<新 CTA>" } } : {}),
      ...(orderedLayers.includes("assemble") ? { transitions: { mode: "fade", fadeSec: 0.6 } } : {}),
      ...(requiresShotRegen ? { shots: { regenerate: shotIds.length ? shotIds : ["<shotId>"] } } : {}),
    },
  };
}

/* ============================ 健康探针 ============================ */

export async function health({ bins = resolveBinaries(), env = process.env } = {}) {
  const result = { ffmpeg: null, ffprobe: null, variants: null, luts: null, subtitle: null, bgm: null, enhance: null, errors: [] };
  try {
    const { binaryVersion } = await import("../subtitle-bridge/measure.mjs");
    result.ffmpeg = await binaryVersion(bins.ffmpeg);
    result.ffprobe = await binaryVersion(bins.ffprobe);
  } catch (error) {
    result.errors.push(`ffmpeg 探针失败：${String(error)}`);
  }
  try {
    result.variants = listVariantPacks().map((pack) => ({ id: pack.id, name: pack.name }));
  } catch (error) {
    result.errors.push(`变体索引不可用：${error instanceof Error ? error.message : String(error)}`);
  }
  try {
    const manifest = JSON.parse(await fsp.readFile(path.join(LUT_DIR, "manifest.json"), "utf8"));
    result.luts = { count: manifest.luts?.length ?? 0, dir: LUT_DIR };
  } catch (error) {
    result.errors.push(`LUT 清单不可用：${error instanceof Error ? error.message : String(error)}`);
  }
  try {
    const { health: subtitleHealth } = await import("../subtitle-bridge/core.mjs");
    const probe = await subtitleHealth({ bins, env });
    result.subtitle = {
      ok: probe.ok === true,
      videoEncoder: probe.videoEncoder ?? null,
      fonts: probe.fonts?.installed ?? null,
      fontsTotal: probe.fonts?.total ?? null,
      renderCapabilities: probe.renderCapabilities ?? null,
      platforms: probe.platforms ?? [],
    };
  } catch (error) {
    result.errors.push(`字幕工位不可用：${error instanceof Error ? error.message : String(error)}`);
  }
  try {
    const tracks = findTracks({}, env);
    result.bgm = { libraryPresent: tracks.libraryPresent, total: tracks.total, matched: tracks.matched };
  } catch (error) {
    result.errors.push(`曲库不可用：${error instanceof Error ? error.message : String(error)}`);
  }
  try {
    const { checkEnhanceEngine } = await import("../enhance-bridge/core.mjs");
    result.enhance = await checkEnhanceEngine({ bins });
  } catch (error) {
    result.enhance = { ready: false, error: error instanceof Error ? error.message : String(error) };
  }
  return result;
}

/* ============================ 工具入口 ============================ */

function resolveCues(params = {}) {
  return { zh: params.zh_text ?? params.zhText ?? null, ...params };
}

export async function callTool(name, params = {}, { bins = resolveBinaries(), env = process.env } = {}) {
  if (!isPostTool(name)) throw new PostError(`未提供的工具：${name}`, "not_provided");
  const roots = allowedRoots(env);
  switch (name) {
    case "postread.health":
      return { result: await health({ bins, env }), receipt: { synced: true, verified_at: new Date().toISOString() } };
    case "postread.plan": {
      const project = params.project ?? {};
      const shots = (params.shots ?? []).map((shot) => ({ ...shot, path: assertPathAllowed(shot.path ?? shot.localPath, roots, "shots[].path") }));
      const result = await planDelivery({ project, shots, variants: params.variants ?? null, bins, env });
      return { result, receipt: { synced: true, verified_at: new Date().toISOString() } };
    }
    case "postread.impact": {
      const result = analyzeImpact({ project: params.project ?? null, patch: params.patch ?? {} });
      return { result, receipt: { synced: true, verified_at: new Date().toISOString() } };
    }
    case "postwrite.package": {
      const outDir = assertPathAllowed(params.out_dir ?? params.outDir, roots, "out_dir");
      const shots = (params.shots ?? []).map((shot) => ({ ...shot, path: assertPathAllowed(shot.path ?? shot.localPath, roots, "shots[].path") }));
      const outcome = await buildDeliveryPackage({
        project: params.project ?? {},
        shots,
        subtitles: params.subtitles ?? null,
        variants: params.variants ?? null,
        outDir,
        burnSubtitles: params.burn_subtitles === true,
        softSubtitles: params.soft_subtitles !== false,
        bins,
        env,
      });
      const primary = outcome.manifest.variants[0]?.softsub ?? outcome.manifest.variants[0]?.video;
      return {
        result: {
          out_dir: outcome.outDir,
          project_id: outcome.projectId,
          package_key: outcome.packageKey,
          manifest_path: outcome.manifestPath,
          report_path: outcome.reportPath,
          project_path: outcome.projectPath,
          master: outcome.manifest.master,
          quality: outcome.manifest.quality,
          enhancements: outcome.manifest.enhancements,
          subtitles: outcome.manifest.subtitles,
          variants: outcome.manifest.variants,
          divergence: outcome.manifest.divergence,
          checks: outcome.checks,
          passed: outcome.passed,
        },
        receipt: {
          synced: outcome.passed === true,
          snapshot_uri: primary ? `post://package/${path.basename(String(primary.path))}` : `post://package/${outcome.packageKey}`,
          sha256: primary?.sha256 ?? null,
          verified_at: new Date().toISOString(),
        },
      };
    }
    case "postwrite.reedit": {
      const projectPath = assertPathAllowed(params.project_path ?? params.projectPath, roots, "project_path");
      const shotPaths = params.shot_paths
        ? Object.fromEntries(Object.entries(params.shot_paths).map(([shotId, file]) => [shotId, assertPathAllowed(file, roots, `shot_paths.${shotId}`)]))
        : null;
      const outcome = await reedit({
        projectPath,
        deliveryDir: params.delivery_dir ? assertPathAllowed(params.delivery_dir, roots, "delivery_dir") : null,
        expectedVersion: params.expected_version ?? null,
        expectedProjectSha256: params.expected_project_sha256 ?? null,
        patch: params.patch ?? {},
        feedback: params.feedback ?? null,
        variantId: params.variant_id ?? null,
        idempotencyKey: params.idempotency_key ?? null,
        outDir: params.out_dir ? assertPathAllowed(params.out_dir, roots, "out_dir") : null,
        shotPaths,
        audioStemsByShot: params.audio_stems_by_shot ?? null,
        bins,
        dryRun: params.dry_run === true,
        env,
      });
      return {
        result: outcome,
        receipt: {
          synced: !outcome.executed || outcome.revision?.checks?.every((check) => check.ok === true) === true,
          snapshot_uri: outcome.executed ? `post://revision/v${outcome.version}` : "post://revision/planned",
          verified_at: new Date().toISOString(),
        },
      };
    }
    case "postwrite.triage": {
      const result = triageFeedback({ feedback: params.feedback, project: params.project ?? null, variants: params.variants ?? null });
      return { result, receipt: { synced: true, verified_at: new Date().toISOString() } };
    }
    default:
      throw new PostError(`未实现的工具：${name}`, "not_provided");
  }
}

/** 作业留痕（与其它三个工位同款：每次调用一行 jsonl，失败也留痕）。 */
export function jobsDir(env = process.env) {
  return env.WORKLOOM_POST_JOBS_DIR || path.join(os.homedir(), ".workloom-post", "jobs");
}

export async function jobAppend(dir, record) {
  await fsp.mkdir(dir, { recursive: true });
  const file = path.join(dir, "jobs.jsonl");
  await fsp.appendFile(file, `${JSON.stringify({ at: new Date().toISOString(), ...record })}\n`, "utf8");
  return file;
}

/** 稳定序列化（键排序）用于幂等键与请求哈希。 */
export function STABLE_JSON(value) {
  const sort = (input) => {
    if (Array.isArray(input)) return input.map(sort);
    if (input && typeof input === "object") {
      return Object.fromEntries(Object.keys(input).sort().map((key) => [key, sort(input[key])]));
    }
    return input;
  };
  return JSON.stringify(sort(value));
}

export function hashKey(text) {
  return createHash("sha256").update(String(text)).digest("hex").slice(0, 32);
}

export { SubtitleError };
