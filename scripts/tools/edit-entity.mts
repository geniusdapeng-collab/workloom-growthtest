#!/usr/bin/env tsx
/** 实体级调色：每个解码帧独立产生掩膜，目标消失即清零；CLI 原片只读。 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFileSync, closeSync, constants, copyFileSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, readSync, readdirSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  buildEntityFilterComplex, entityReceiptRows, planEntityGrade, summarizeEntityPlans, weightCurrentMask,
  type EntityGradePlan, type EntitySignal,
} from "../../packages/video-studio/src/edit/entity-color.js";
import { resolveColorManagement } from "../../bundles/ai-video/connectors/color-bridge/processing-quality.mjs";

const REPO_ROOT = resolve(import.meta.dirname ?? process.cwd(), "../..");
const FFMPEG = process.env.WL_FFMPEG ?? "ffmpeg";
const FFPROBE = process.env.WL_FFPROBE ?? "ffprobe";
const hash = (file: string) => {
  const digest = createHash("sha256"), descriptor = openSync(file, "r"), buffer = Buffer.alloc(1024 * 1024);
  try { let count: number; while ((count = readSync(descriptor, buffer, 0, buffer.length, null)) > 0) digest.update(buffer.subarray(0, count)); return digest.digest("hex"); }
  finally { closeSync(descriptor); }
};
function run(bin: string, args: string[]): string {
  try { return execFileSync(bin, args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024, timeout: 1_800_000, stdio: ["ignore", "pipe", "pipe"] }); }
  catch (err) {
    const failure = err as { stderr?: string; message?: string };
    throw new Error(`${bin} 执行失败：${String(failure.stderr || failure.message || "未知错误").split("\n").slice(-5).join(" | ")}`);
  }
}
/** 二进制按源码 SHA 缓存于调用方工作目录，不会复用另一仓的旧编译产物。 */
export function ensureEntityBinary(workDir = join(REPO_ROOT, "work", "entity-cache")): { path: string } | { reason: string } {
  const explicit = process.env.WL_VISION_ENTITY?.trim();
  if (explicit) return existsSync(explicit) ? { path: explicit } : { reason: `显式实体工位不存在：${explicit}` };
  if (process.platform !== "darwin") return { reason: "实体掩膜目前仅 macOS（Apple Vision）可用" };
  const source = join(REPO_ROOT, "scripts", "tools", "vision-entity.swift");
  if (!existsSync(source)) return { reason: `缺少 Swift 源码：${source}` };
  const target = join(workDir, "bin", `vision-entity-${hash(source).slice(0, 16)}`);
  if (existsSync(target)) return { path: target };
  try { mkdirSync(dirname(target), { recursive: true }); run("swiftc", ["-O", source, "-o", target]); return { path: target }; }
  catch (err) { return { reason: `vision-entity 编译失败：${err instanceof Error ? err.message : String(err)}` }; }
}
interface VisionSummary {
  personRatio: number; personSkinRatio: number | null; personInstances: number; personRequest: string;
  faceCount: number; foodRatio: number; foodLabels: string[]; personMask: boolean; foodMask: boolean; notes: string[];
}
const emptySummary = (note: string): VisionSummary => ({ personRatio: 0, personSkinRatio: null, personInstances: 0,
  personRequest: "none", faceCount: 0, foodRatio: 0, foodLabels: [], personMask: false, foodMask: false, notes: [note] });
function probe(file: string): { duration: number; width: number; height: number; video: { pixelFormat: string; colorPrimaries: string; colorTransfer: string; colorSpace: string; colorRange: string } } {
  const data = JSON.parse(run(FFPROBE, ["-v", "error", "-show_format", "-show_streams", "-of", "json", file]));
  const video = data.streams?.find((stream: { codec_type?: string }) => stream.codec_type === "video");
  const result = { duration: Number(video?.duration ?? data.format?.duration), width: Number(video?.width), height: Number(video?.height), video: {
    pixelFormat: video?.pix_fmt, colorPrimaries: video?.color_primaries, colorTransfer: video?.color_transfer, colorSpace: video?.color_space, colorRange: video?.color_range,
  } };
  if (!Number.isFinite(result.duration) || result.duration <= 0 || result.width < 2 || result.height < 2) throw new Error(`输入视频规格无效：${file}`);
  return result;
}
/** 解析工位输出的 PGM，拒绝缺帧或错误大小，不能拿上一帧来补。 */
export function readEntityPgm(file: string, width: number, height: number): Uint8Array {
  const data = readFileSync(file);
  const header = /^P5\n(\d+) (\d+)\n255\n/.exec(data.subarray(0, 80).toString("ascii"));
  if (!header || Number(header[1]) !== width || Number(header[2]) !== height || data.length !== header[0].length + width * height) {
    throw new Error(`实体掩膜规格不匹配：${file}`);
  }
  return data.subarray(header[0].length);
}
export interface EntityClip { shotId: string; path: string }
export interface EntityPassOptions { clips: EntityClip[]; workDir: string; fps: number; intensity?: number; onLog?: (line: string) => void }
export interface EntityPassResult {
  binary: string | null; reason: string | null; applied: number; skipped: number;
  rows: ReturnType<typeof entityReceiptRows>; summary: ReturnType<typeof summarizeEntityPlans>;
  generations: Array<{ shotId: string; filterComplex: string; sha256: string; sourceSha256: string; frames: number; maskMode: "framewise";
    colorManagement: ReturnType<typeof resolveColorManagement>; masks: Array<{ kind: "person" | "food"; path: string; sha256: string; width: number; height: number; fps: number; frames: number }> }>;
}
/** clips 是后期内部工作副本；成功后原子替换副本。源素材由 CLI 先复制，再进入此函数。 */
export async function applyEntityGrade(options: EntityPassOptions): Promise<EntityPassResult> {
  if (options.intensity != null && (!Number.isFinite(options.intensity) || options.intensity < 0 || options.intensity > 1)) throw new Error("实体调色 intensity 必须在 0..1");
  if (!Number.isFinite(options.fps) || options.fps < 1 || options.fps > 120) throw new Error("实体调色 fps 必须在 1..120");
  const log = options.onLog ?? (() => {}), binary = ensureEntityBinary(options.workDir);
  const signals: EntitySignal[] = [], plans: EntityGradePlan[] = [], generations: EntityPassResult["generations"] = [];
  let applied = 0, skipped = 0;
  for (const clip of options.clips) {
    if (!/^[A-Za-z0-9_.-]+$/.test(clip.shotId) || clip.shotId === "." || clip.shotId === "..") throw new Error("shotId 含非法路径字符");
    const signal: EntitySignal = { segmentId: clip.shotId, personRatio: 0, faces: [], foodRatio: 0, foodLabels: [], sampledAt: [], maskMode: "framewise" };
    if ("reason" in binary) {
      const plan = planEntityGrade(signal); plan.notes.push(binary.reason); signals.push(signal); plans.push(plan); skipped += 1; continue;
    }
    const sourceSha256 = hash(clip.path), source = probe(clip.path);
    const colorManagement = resolveColorManagement({ probe: source });
    const dir = join(options.workDir, clip.shotId), frameDir = join(dir, "frames");
    if (resolve(clip.path).startsWith(resolve(frameDir) + "/")) throw new Error("原片不能位于将清理的实体帧目录内");
    // 清除仅属于此片段的旧中间产物，防止重跑读到上一次多出来的尾帧。
    rmSync(frameDir, { recursive: true, force: true }); mkdirSync(frameDir, { recursive: true });
    const width = Math.max(2, Math.floor(Math.min(640, source.width) / 2) * 2);
    const height = Math.max(2, Math.round(width * source.height / source.width / 2) * 2);
    run(FFMPEG, ["-hide_banner", "-loglevel", "error", "-y", "-i", clip.path, "-vf", `${colorManagement.chain},fps=${options.fps},scale=${width}:${height}`, join(frameDir, "%06d.png")]);
    const frames = readdirSync(frameDir).filter((file) => /^\d{6}\.png$/.test(file)).sort();
    if (!frames.length) throw new Error(`实体调色无解码帧：${clip.path}`);
    const personRaw = join(dir, "person.gray"), foodRaw = join(dir, "food.gray");
    writeFileSync(personRaw, Buffer.alloc(0)); writeFileSync(foodRaw, Buffer.alloc(0));
    const framePlans: EntityGradePlan[] = []; const notes: string[] = [];
    let previousPersonOpacity = 0, previousFoodOpacity = 0, personFrameCount = 0, foodFrameCount = 0;
    for (const [index, file] of frames.entries()) {
      const maskDir = join(dir, `mask-${String(index + 1).padStart(6, "0")}`);
      rmSync(maskDir, { recursive: true, force: true }); mkdirSync(maskDir, { recursive: true });
      let summary: VisionSummary;
      try {
        summary = JSON.parse(run(binary.path, [join(frameDir, file), maskDir]).trim().split("\n").pop() ?? "{}");
        if (![summary.personRatio, summary.foodRatio].every((value) => Number.isFinite(value) && value >= 0 && value <= 1)
          || ![summary.personInstances, summary.faceCount].every((value) => Number.isInteger(value) && value >= 0)
          || !Array.isArray(summary.foodLabels) || !summary.foodLabels.every((value) => typeof value === "string")
          || !Array.isArray(summary.notes) || !summary.notes.every((value) => typeof value === "string")
          || typeof summary.personMask !== "boolean" || typeof summary.foodMask !== "boolean") throw new Error("工位摘要 schema 无效");
      }
      catch (err) { summary = emptySummary(`第 ${index + 1} 帧掩膜失败：${err instanceof Error ? err.message : String(err)}`); }
      let faces: EntitySignal["faces"] = [];
      if (existsSync(join(maskDir, "faces.json"))) {
        try {
          const parsed = JSON.parse(readFileSync(join(maskDir, "faces.json"), "utf8"));
          if (!Array.isArray(parsed)) throw new Error("人脸证据必须是数组");
          faces = parsed.filter((face) => face && [face.x, face.y, face.w, face.h].every(Number.isFinite)
            && face.x >= 0 && face.y >= 0 && face.w > 0 && face.h > 0 && face.x + face.w <= 1.001 && face.y + face.h <= 1.001);
        }
        catch (err) { notes.push(`第 ${index + 1} 帧人脸证据解析失败：${err instanceof Error ? err.message : String(err)}`); }
      }
      const current: EntitySignal = { ...signal, personRatio: Number(summary.personRatio ?? 0), personInstances: Number(summary.personInstances ?? 0),
        personSkinRatio: summary.personSkinRatio, personRequest: summary.personRequest, faces,
        foodRatio: Number(summary.foodRatio ?? 0), foodLabels: Array.isArray(summary.foodLabels) ? summary.foodLabels : [],
        sampledAt: [index / options.fps], personMaskPath: summary.personMask && existsSync(join(maskDir, "person.pgm")) ? join(maskDir, "person.pgm") : null,
        foodMaskPath: summary.foodMask && existsSync(join(maskDir, "food.pgm")) ? join(maskDir, "food.pgm") : null };
      const plan = planEntityGrade(current, { intensity: options.intensity ?? 1 });
      const readMask = (file: string | null | undefined): Uint8Array => {
        if (!file) return new Uint8Array(width * height);
        try { return readEntityPgm(file, width, height); }
        catch (err) { notes.push(`第 ${index + 1} 帧掩膜读取失败，清零：${err instanceof Error ? err.message : String(err)}`); return new Uint8Array(width * height); }
      };
      const person = weightCurrentMask(readMask(current.personMaskPath), plan.person.opacity, previousPersonOpacity);
      const food = weightCurrentMask(readMask(current.foodMaskPath), plan.food.opacity, previousFoodOpacity);
      previousPersonOpacity = person.opacity; previousFoodOpacity = food.opacity;
      plan.person.enabled = person.opacity > 0; plan.person.opacity = person.opacity;
      plan.food.enabled = food.opacity > 0; plan.food.opacity = food.opacity;
      if (plan.person.enabled) personFrameCount += 1; if (plan.food.enabled) foodFrameCount += 1;
      appendFileSync(personRaw, person.mask); appendFileSync(foodRaw, food.mask); framePlans.push(plan);
      signal.sampledAt.push(index / options.fps); signal.personRatio = Math.max(signal.personRatio, current.personRatio);
      signal.foodRatio = Math.max(signal.foodRatio, current.foodRatio); signal.foodLabels.push(...current.foodLabels);
      signal.faces.push(...faces); notes.push(...plan.notes, ...(summary.notes ?? []).filter((note) => !note.startsWith("食物证据为")));
    }
    signal.personMaskPath = personFrameCount ? personRaw : null; signal.foodMaskPath = foodFrameCount ? foodRaw : null;
    signal.foodLabels = [...new Set(signal.foodLabels)]; signal.faces = signal.faces.slice(0, 8);
    const aggregate: EntityGradePlan = { segmentId: clip.shotId,
      person: { enabled: personFrameCount > 0, opacity: Math.max(...framePlans.map((plan) => plan.person.opacity)), reason: `${personFrameCount}/${frames.length} 帧有当前人物肤色支持` },
      food: { enabled: foodFrameCount > 0, opacity: Math.max(...framePlans.map((plan) => plan.food.opacity)), reason: `${foodFrameCount}/${frames.length} 帧有当前食物实例分类支持` },
      notes: [...new Set(notes)].slice(0, 24).concat(["逐帧掩膜；无当前证据即清零；分类是启发式，不能保证食物语义分割"]) };
    const outcome = buildEntityFilterComplex(aggregate, { width: source.width, height: source.height, masksPreweighted: true, featherPx: 2,
      personInput: "1:v", foodInput: personFrameCount ? "2:v" : "1:v" });
    signals.push(signal); plans.push(aggregate);
    if (!outcome.applied) { skipped += 1; continue; }
    const temp = join(dir, "entity-output.mp4"), args = ["-hide_banner", "-loglevel", "error", "-y", "-i", clip.path];
    for (const file of [personFrameCount ? personRaw : null, foodFrameCount ? foodRaw : null].filter(Boolean)) {
      args.push("-f", "rawvideo", "-pixel_format", "gray", "-video_size", `${width}x${height}`, "-framerate", String(options.fps), "-i", file!);
    }
    const graph = outcome.filterComplex.replace("[0:v]format=gbrp", `[0:v]${colorManagement.chain},fps=${options.fps},format=gbrp`)
      .replace(/\[vout\]$/, "[entityrgb]") + ";[entityrgb]format=gbrp16le,zscale=primariesin=bt709:transferin=bt709:matrixin=gbr:rangein=full:primaries=bt709:transfer=bt709:matrix=bt709:range=limited:dither=error_diffusion,format=yuv420p[vout]";
    args.push("-filter_complex_threads", "1", "-filter_complex", graph, "-map", "[vout]", "-map", "0:a?", "-frames:v", String(frames.length),
      "-t", String(source.duration), "-c:v", "libx264", "-preset", "veryfast", "-crf", "18", "-pix_fmt", "yuv420p", "-color_primaries", "bt709", "-color_trc", "bt709", "-colorspace", "bt709", "-color_range", "tv", "-c:a", "copy", "-movflags", "+faststart", temp);
    try {
      run(FFMPEG, args); const result = probe(temp);
      if (hash(clip.path) !== sourceSha256 || result.width !== source.width || result.height !== source.height || Math.abs(result.duration - source.duration) > 1 / options.fps + 0.025) {
        throw new Error("实体调色时间线、尺寸或源片哈希校验失败");
      }
      renameSync(temp, clip.path);
    } catch (err) { rmSync(temp, { force: true }); throw err; }
    applied += 1; generations.push({ shotId: clip.shotId, filterComplex: graph, sourceSha256, sha256: hash(clip.path), frames: frames.length, maskMode: "framewise", colorManagement,
      masks: ([personFrameCount ? { kind: "person" as const, path: personRaw } : null, foodFrameCount ? { kind: "food" as const, path: foodRaw } : null].filter(Boolean) as Array<{kind:"person"|"food";path:string}>)
        .map((mask) => ({ ...mask, sha256: hash(mask.path), width, height, fps: options.fps, frames: frames.length })) });
    log(`实体调色 ${clip.shotId}：${frames.length} 帧，人像 ${personFrameCount} 帧、食物 ${foodFrameCount} 帧`);
  }
  const rows = entityReceiptRows(signals, plans), summary = summarizeEntityPlans(plans);
  const reason = "reason" in binary ? binary.reason : null;
  log(`实体级调色：${applied} 段执行 / ${skipped} 段保持原样`);
  return { binary: "path" in binary ? binary.path : null, reason, applied, skipped, rows, summary, generations };
}
async function main(): Promise<void> {
  const arg = (name: string, fallback = "") => { const index = process.argv.indexOf(name); return index >= 0 ? process.argv[index + 1] ?? fallback : fallback; };
  const abs = (file: string) => isAbsolute(file) ? file : resolve(REPO_ROOT, file);
  const input = arg("--input"); if (!input) throw new Error("用法：edit:entity --input <原片> --out <新文件> [--report <json>]");
  const inputPath = abs(input); if (!existsSync(inputPath)) throw new Error(`输入不存在：${inputPath}`);
  const outputPath = abs(arg("--out", join(dirname(inputPath), `${hash(inputPath).slice(0, 8)}.entity.mp4`)));
  if (inputPath === outputPath || existsSync(outputPath)) throw new Error("实体调色输出必须是不存在的新文件，禁止覆盖原片或已有产物");
  const reportPath = abs(arg("--report", `${outputPath}.entity-report.json`));
  const canonical = (file: string) => existsSync(file) ? realpathSync(file) : resolve(file);
  const sameFile = (a: string, b: string) => {
    if (canonical(a) === canonical(b)) return true;
    if (!existsSync(a) || !existsSync(b)) return false;
    const left = statSync(a), right = statSync(b); return left.dev === right.dev && left.ino === right.ino;
  };
  if ([inputPath, outputPath].some((file) => sameFile(file, reportPath))) throw new Error("回执不能通过路径、软链或硬链覆盖原片或成片");
  const sourceSha256 = hash(inputPath);
  mkdirSync(dirname(outputPath), { recursive: true });
  const requestedWorkDir = arg("--work-dir") ? abs(arg("--work-dir")) : dirname(outputPath);
  mkdirSync(requestedWorkDir, { recursive: true });
  const workDir = mkdtempSync(join(requestedWorkDir, ".entity-work-"));
  copyFileSync(inputPath, outputPath, constants.COPYFILE_EXCL);
  let result: EntityPassResult;
  try { result = await applyEntityGrade({ clips: [{ shotId: "single", path: outputPath }], workDir,
    fps: Number(arg("--fps", "30")), intensity: Number(arg("--intensity", "1")), onLog: (line) => console.log(line) }); }
  catch (err) { rmSync(outputPath, { force: true }); throw err; }
  const tempReport = `${reportPath}.${process.pid}.tmp`;
  try {
    if (hash(inputPath) !== sourceSha256) throw new Error("原片只读校验失败");
    mkdirSync(dirname(reportPath), { recursive: true });
    writeFileSync(tempReport, `${JSON.stringify({ schema: "workloom.video-edit/entity-grade/v2", input: inputPath, output: outputPath,
      sourceSha256, sha256: hash(outputPath), ...result, generatedAt: new Date().toISOString() }, null, 2)}\n`, { flag: "wx" });
    renameSync(tempReport, reportPath);
  } catch (error) { rmSync(tempReport, { force: true }); rmSync(outputPath, { force: true }); throw error; }
  console.log(`回执：${reportPath}`); if (process.argv.includes("--json")) console.log(JSON.stringify({ ...result, report: reportPath }, null, 2));
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((err) => { console.error(`✗ edit-entity 失败：${err instanceof Error ? err.message : String(err)}`); process.exitCode = 1; });
}
