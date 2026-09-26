/**
 * media/ffmpeg.ts —— 媒资库本地媒体工具（缩略图抽取 / 元信息探测 / 重剪归并）
 *
 * 纪律（规格书 §10 风险清单「ffmpeg 抽帧/归一化在缺 ffmpeg 环境失败」）：
 *  - 全部显式失败：抽帧失败返回 null（缩略图留空，不阻断列表），重剪失败抛错进作业状态；
 *  - 绝不静默降级为"看起来成功"——重剪前置检测 ffmpeg/ffprobe 可用性，缺则直接报错。
 */
import { spawn } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

function bin(env: NodeJS.ProcessEnv, key: "ffmpeg" | "ffprobe", fallback: string): string {
  return (key === "ffmpeg" ? env.WL_FFMPEG : env.WL_FFPROBE)?.trim() || fallback;
}

export interface RunResult { code: number; stdout: string; stderr: string }

/** 跑一条外部命令（收集输出，超时即杀）；不做 shell 拼接，参数一律数组传入 */
export function run(binary: string, args: string[], opts: { timeoutMs?: number; env?: NodeJS.ProcessEnv } = {}): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(binary, args, { stdio: ["ignore", "pipe", "pipe"], env: opts.env ?? process.env });
    let stdout = "";
    let stderr = "";
    const timer = opts.timeoutMs
      ? setTimeout(() => {
          child.kill("SIGKILL");
          reject(new Error(`${binary} 超时（${opts.timeoutMs}ms）`));
        }, opts.timeoutMs)
      : null;
    child.stdout?.on("data", (chunk: Buffer) => { stdout += chunk.toString("utf8"); });
    child.stderr?.on("data", (chunk: Buffer) => { stderr += chunk.toString("utf8"); });
    child.on("error", (err) => {
      if (timer) clearTimeout(timer);
      reject(new Error(`${binary} 启动失败：${err.message}`));
    });
    child.on("close", (code) => {
      if (timer) clearTimeout(timer);
      resolve({ code: code ?? -1, stdout, stderr });
    });
  });
}

export interface MediaProbe {
  durationSeconds: number | null;
  width: number | null;
  height: number | null;
}

/**
 * 探测媒体元信息（时长/宽高）。
 *  - ffprobe 不可用或文件不是媒体 → 返回全 null（调用方按"未知"处理，不编数字）；
 *  - 视频流缺失时退化为音频（时长有、宽高无）。
 */
export async function probeMedia(absPath: string, env: NodeJS.ProcessEnv = process.env): Promise<MediaProbe> {
  if (!existsSync(absPath)) return { durationSeconds: null, width: null, height: null };
  const ffprobe = bin(env, "ffprobe", "ffprobe");
  try {
    const r = await run(ffprobe, [
      "-v", "error",
      "-show_entries", "format=duration:stream=width,height,codec_type",
      "-of", "json",
      absPath,
    ], { timeoutMs: 30_000, env });
    if (r.code !== 0) return { durationSeconds: null, width: null, height: null };
    const parsed = JSON.parse(r.stdout || "{}") as {
      format?: { duration?: string };
      streams?: Array<{ width?: number; height?: number; codec_type?: string }>;
    };
    const duration = Number(parsed.format?.duration);
    const video = (parsed.streams ?? []).find((s) => s.codec_type === "video");
    return {
      durationSeconds: Number.isFinite(duration) && duration > 0 ? Math.round(duration * 100) / 100 : null,
      width: video?.width ?? null,
      height: video?.height ?? null,
    };
  } catch {
    return { durationSeconds: null, width: null, height: null };
  }
}

/**
 * 抽首帧缩略图（1 秒处；不足 1 秒的素材退化为第 0 帧）。
 * 失败一律返回 null：缩略图是"锦上添花"，不能阻断入库与列表。
 */
export async function extractThumbnail(
  absPath: string,
  targetAbsPath: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<{ ok: boolean; error?: string }> {
  if (!existsSync(absPath)) return { ok: false, error: `源文件不存在：${absPath}` };
  const ffmpeg = bin(env, "ffmpeg", "ffmpeg");
  mkdirSync(dirname(targetAbsPath), { recursive: true });
  const common = ["-hide_banner", "-loglevel", "error", "-y", "-i", absPath];
  const attempts: string[][] = [
    ["-ss", "1", "-frames:v", "1", "-vf", "scale=640:-2"],
    ["-frames:v", "1", "-vf", "scale=640:-2"],
  ];
  let lastError: string | undefined;
  for (const extra of attempts) {
    try {
      const r = await run(ffmpeg, [...common, ...extra, targetAbsPath], { timeoutMs: 120_000, env });
      if (r.code === 0 && existsSync(targetAbsPath)) return { ok: true };
      lastError = r.stderr.trim().slice(-300) || `ffmpeg 退出码 ${r.code}`;
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
    }
  }
  return { ok: false, error: lastError ?? "抽帧失败" };
}

/** ffmpeg + ffprobe 可用性（重剪前置检测；缺任一即视为不可用） */
export async function ffmpegAvailable(env: NodeJS.ProcessEnv = process.env): Promise<{ ok: boolean; error?: string }> {
  for (const [key, fallback] of [["ffmpeg", "ffmpeg"], ["ffprobe", "ffprobe"]] as const) {
    try {
      const r = await run(bin(env, key, fallback), ["-version"], { timeoutMs: 15_000, env });
      if (r.code !== 0) return { ok: false, error: `${key} 不可用（退出码 ${r.code}）` };
    } catch (err) {
      return { ok: false, error: `${key} 不可用：${err instanceof Error ? err.message : String(err)}` };
    }
  }
  return { ok: true };
}

/**
 * 重剪归并：逐段归一化（对齐首段分辨率/帧率/像素格式/音轨）→ concat demuxer 无损拼接。
 * 与 `scripts/tools/compose-film.mts` 同口径（该工具是人工跑批入口，本函数是服务内作业入口）。
 */
export async function concatNormalize(
  inputs: string[],
  outPath: string,
  opts: { env?: NodeJS.ProcessEnv; fps?: number; width?: number; height?: number; onProgress?: (line: string) => void } = {},
): Promise<{ segments: number; fps: number; width: number; height: number }> {
  const env = opts.env ?? process.env;
  if (inputs.length < 2) throw new Error("重剪至少需要 2 段素材");
  for (const input of inputs) {
    if (!existsSync(input)) throw new Error(`重剪素材不在本地媒体仓：${input}（可先在媒资库点播触发文件拉取）`);
  }
  const avail = await ffmpegAvailable(env);
  if (!avail.ok) throw new Error(`重剪前置检查失败：${avail.error}`);
  const ffmpeg = bin(env, "ffmpeg", "ffmpeg");
  const first = await probeMedia(inputs[0]!, env);
  const width = opts.width ?? first.width ?? 1080;
  const height = opts.height ?? first.height ?? 1920;
  const fps = opts.fps ?? 30;

  const workDir = `${outPath}.segments`;
  mkdirSync(workDir, { recursive: true });
  mkdirSync(dirname(outPath), { recursive: true });
  const normalized: string[] = [];
  for (const [index, input] of inputs.entries()) {
    const target = `${workDir}/${String(index).padStart(3, "0")}.mp4`;
    const r = await run(ffmpeg, [
      "-hide_banner", "-loglevel", "error", "-y", "-i", input,
      "-vf", `scale=${width}:${height}:force_original_aspect_ratio=decrease,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2,setsar=1,fps=${fps}`,
      "-c:v", "libx264", "-preset", "veryfast", "-crf", "20", "-pix_fmt", "yuv420p",
      "-c:a", "aac", "-ar", "48000", "-ac", "2",
      target,
    ], { timeoutMs: 900_000, env });
    if (r.code !== 0) throw new Error(`第 ${index + 1} 段归一化失败：${r.stderr.trim().slice(-400)}`);
    opts.onProgress?.(`归一化 ${index + 1}/${inputs.length}`);
    normalized.push(target);
  }
  const listPath = `${workDir}/concat.txt`;
  const listBody = normalized.map((p) => `file '${p.replace(/'/g, "'\\''")}'`).join("\n");
  const { writeFileSync } = await import("node:fs");
  writeFileSync(listPath, `${listBody}\n`, "utf8");
  const concat = await run(ffmpeg, [
    "-hide_banner", "-loglevel", "error", "-y",
    "-f", "concat", "-safe", "0", "-i", listPath,
    "-c", "copy", "-movflags", "+faststart", outPath,
  ], { timeoutMs: 900_000, env });
  if (concat.code !== 0) throw new Error(`拼接失败：${concat.stderr.trim().slice(-400)}`);
  if (!existsSync(outPath)) throw new Error("拼接结束但未产出文件");
  opts.onProgress?.(`拼接完成：${inputs.length} 段 → ${outPath}`);
  return { segments: inputs.length, fps, width, height };
}
