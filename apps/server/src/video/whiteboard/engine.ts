/**
 * video/whiteboard/engine.ts —— 手绘白板渲染引擎桥（T-2026-0926-0020）
 *
 * 职责：把 `vendor/srt-whiteboard`（上游 MIT 引擎 + 本仓补丁）与 `scripts/whiteboard/
 * lineart_tools.py` 两个 Python 侧入口，包成 Node 侧可 await 的确定性调用。
 *
 * 纪律：
 *   · **不 mock**：venv 不存在 / 解释器缺失 → `whiteboardEngineUnavailable()` 明确报错，
 *     由调用方决定"降级为不可用"（目录里不出现该模型），而不是伪造一段视频；
 *   · **超时必杀**：渲染是长任务，`--timeout-ms` 到点 SIGKILL，避免进程挂死拖垮服务；
 *   · **末行契约**：上游渲染器末行输出 `OUTPUT=<路径>`，这里校验它，不靠"退出码 0 就算成功"；
 *   · 子进程输出的 stderr 只保留尾部若干行进错误信息（真机排障够用，且不污染日志）。
 */
import { execFile } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const HERE = dirname(fileURLToPath(import.meta.url));
/** whiteboard → video → src → server → apps → <repo root> */
export const REPO_ROOT = resolve(HERE, "../../../../..");

export class WhiteboardEngineError extends Error {
  constructor(message: string, public readonly detail?: string) {
    super(message);
    this.name = "WhiteboardEngineError";
  }
}

/* ================= 环境与路径 ================= */

export interface WhiteboardEnv {
  enabled: boolean;
  engineDir: string;
  jobsDir: string;
  python: string;
  /** 官方样例素材（验证 1「官方样例复现」用） */
  exampleImage: string;
  exampleAnnotation: string;
  /** 白板执笔手素材（本仓自有，中性无第三方标识） */
  handImage: string;
  /** 线稿工具（本仓扩展） */
  lineartTool: string;
  ffmpeg: string;
  ffprobe: string;
}

export function whiteboardEnv(env: NodeJS.ProcessEnv = process.env): WhiteboardEnv {
  /**
   * 相对路径一律按**仓库根**解析（与 archive-host.ts#archiveWorkDir 同口径）。
   * 真机踩过：`.env` 写 `WHITEBOARD_JOBS_DIR=var/whiteboard-jobs` 时，若原样透传相对路径，
   * 拼出来的产物地址会是 `file://var/...` → Node 把它当 **host** 而不是路径，
   * 报 `ERR_INVALID_FILE_URL_HOST`，入库整条链失败。这里一次解析成绝对路径，杜绝该形态。
   */
  const engineDir = resolveDir(env.WHITEBOARD_ENGINE_DIR?.trim() || "vendor/srt-whiteboard");
  const jobsDir = resolveDir(env.WHITEBOARD_JOBS_DIR?.trim() || "var/whiteboard-jobs");
  const venvPython = process.platform === "win32"
    ? join(engineDir, ".venv", "Scripts", "python.exe")
    : join(engineDir, ".venv", "bin", "python");
  return {
    enabled: (env.WHITEBOARD_ENABLED ?? "0") === "1",
    engineDir,
    jobsDir,
    python: env.WHITEBOARD_PYTHON?.trim() || venvPython,
    exampleImage: join(engineDir, "examples/scene-01-monkey-mountain-banana.png"),
    exampleAnnotation: join(engineDir, "examples/scene-01-monkey-mountain-banana.annotation.json"),
    handImage: env.WHITEBOARD_HAND_IMAGE?.trim() || join(REPO_ROOT, "assets/whiteboard/drawing-hand-workloom.png"),
    lineartTool: join(REPO_ROOT, "scripts/whiteboard/lineart_tools.py"),
    ffmpeg: env.WHITEBOARD_FFMPEG?.trim() || env.FFMPEG_PATH?.trim() || "ffmpeg",
    ffprobe: env.WHITEBOARD_FFPROBE?.trim() || "ffprobe",
  };
}

/** 相对路径 → 仓库根下的绝对路径；绝对路径原样返回 */
function resolveDir(dir: string): string {
  return dir.startsWith("/") || /^[A-Za-z]:[\\/]/.test(dir) ? dir : join(REPO_ROOT, dir);
}

/**
 * 引擎就绪判定（`healthy()` 的唯一事实源）：
 * 开关打开 **且** venv 解释器存在。缺任意一项都视为不可用——
 * 目录侧据此不列出 `whiteboard-stream`，而不是让用户选中后失败。
 */
export function whiteboardEngineReady(env: NodeJS.ProcessEnv = process.env): boolean {
  const cfg = whiteboardEnv(env);
  return cfg.enabled && existsSync(cfg.python);
}

/** 引擎不可用时的可执行修复建议（错误信息里带上，避免"报错但不知道怎么修"） */
export function whiteboardEngineHint(env: NodeJS.ProcessEnv = process.env): string {
  const cfg = whiteboardEnv(env);
  if (!cfg.enabled) return "WHITEBOARD_ENABLED=0（白板引擎总开关关闭）：置 1 后重试";
  if (!existsSync(cfg.python)) {
    return `白板渲染 venv 缺失（${cfg.python}）：执行 \`pnpm exec tsx scripts/tools/whiteboard-env-install.mts\` 安装`;
  }
  return "引擎就绪";
}

/* ================= 子进程封装 ================= */

export interface RunOptions {
  timeoutMs?: number;
  /** 追加到子进程 PATH 的目录（ffmpeg 常装在用户级 bin） */
  extraPathDirs?: string[];
}

export interface RunResult {
  stdout: string;
  stderr: string;
  durationMs: number;
}

/** 跑一个 python 入口，返回 stdout/stderr 全文（超时抛 WhiteboardEngineError） */
export async function runPython(
  scriptPath: string,
  args: string[],
  opts: RunOptions & { env?: NodeJS.ProcessEnv } = {},
): Promise<RunResult> {
  const cfg = whiteboardEnv(opts.env);
  if (!existsSync(cfg.python)) {
    throw new WhiteboardEngineError(`白板渲染解释器不存在：${cfg.python}`, whiteboardEngineHint(opts.env));
  }
  if (!existsSync(scriptPath)) {
    throw new WhiteboardEngineError(`白板脚本不存在：${scriptPath}`);
  }
  const timeoutMs = opts.timeoutMs ?? Number(opts.env?.WHITEBOARD_RUN_TIMEOUT_MS ?? 30 * 60_000);
  const started = Date.now();
  try {
    const { stdout, stderr } = await execFileAsync(cfg.python, [scriptPath, ...args], {
      timeout: timeoutMs,
      killSignal: "SIGKILL",
      maxBuffer: 32 * 1024 * 1024,
      env: childEnv(cfg, opts.extraPathDirs),
    });
    return { stdout, stderr, durationMs: Date.now() - started };
  } catch (err) {
    const e = err as { killed?: boolean; signal?: string; stdout?: string; stderr?: string; message?: string };
    if (e.killed || e.signal === "SIGKILL") {
      throw new WhiteboardEngineError(
        `白板渲染超时（${Math.round(timeoutMs / 1000)}s 未结束，已 SIGKILL）：${scriptPath}`,
        `可用 WHITEBOARD_RUN_TIMEOUT_MS 调高；被杀的进程可能留下 *_raw.mp4 半成品`,
      );
    }
    throw new WhiteboardEngineError(
      `白板脚本执行失败：${scriptPath}`,
      tail(`${e.stdout ?? ""}\n${e.stderr ?? e.message ?? ""}`, 1200),
    );
  }
}

function childEnv(cfg: WhiteboardEnv, extraPathDirs?: string[]): NodeJS.ProcessEnv {
  const pathKey = process.platform === "win32" ? "Path" : "PATH";
  const dirs = [
    ...(extraPathDirs ?? []),
    dirname(cfg.ffmpeg),
    join(process.env.HOME ?? "", ".local/bin"),
    process.env[pathKey] ?? "",
  ].filter((d) => d && d !== ".");
  return { ...process.env, [pathKey]: dirs.join(process.platform === "win32" ? ";" : ":") };
}

/** 取输出尾部 N 字符（错误信息里够用；超长输出不入日志） */
function tail(text: string, n: number): string {
  const t = text.trim();
  return t.length <= n ? t : `…${t.slice(-n)}`;
}

/** 从上游渲染器的末行契约 `OUTPUT=<路径>` 解析产物路径（缺失即失败，不猜路径） */
export function parseOutputLine(stdout: string): string | null {
  const lines = stdout.trim().split(/\r?\n/);
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const m = /^OUTPUT=(.+)$/.exec(lines[i]!.trim());
    if (m) return m[1]!.trim();
  }
  return null;
}

/* ================= 上游渲染器 ================= */

export interface RenderSceneInput {
  imagePath: string;
  annotationPath: string;
  outputPath: string;
  handPath?: string;
  fps?: number;
  capLongEdge?: number;
  inkPath?: "grid" | "skeleton";
  colorFill?: "contour-wipe" | "brush";
  bareTip?: boolean;
  totalMs?: number;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
}

/** 单幕渲染：`render_stream_whiteboard.py`（上游 CLI，末行 OUTPUT= 校验） */
export async function renderWhiteboardScene(input: RenderSceneInput): Promise<{ outputPath: string; durationMs: number }> {
  const cfg = whiteboardEnv(input.env);
  const args = [
    input.imagePath,
    input.annotationPath,
    input.outputPath,
    input.bareTip ? "" : (input.handPath ?? cfg.handImage),
    "--ink-path", input.inkPath ?? "grid",
    "--color-fill", input.colorFill ?? "contour-wipe",
    "--fps", String(input.fps ?? 30),
    "--cap-long-edge", String(input.capLongEdge ?? 1280),
    ...(input.totalMs ? ["--total-ms", String(input.totalMs)] : []),
    ...(input.bareTip ? ["--bare-tip"] : []),
  ];
  const run = await runPython(join(cfg.engineDir, "scripts/render_stream_whiteboard.py"), args, {
    timeoutMs: input.timeoutMs,
    env: input.env,
  });
  const out = parseOutputLine(run.stdout);
  if (!out) {
    throw new WhiteboardEngineError(
      `白板渲染未输出 OUTPUT= 行（输出路径不可信）：${input.outputPath}`,
      tail(run.stdout, 600),
    );
  }
  if (!existsSync(out)) throw new WhiteboardEngineError(`白板渲染声称产出但文件不存在：${out}`);
  return { outputPath: out, durationMs: run.durationMs };
}

/** 多幕合并：`merge_scenes.py`（上游 CLI；单片时直接改名，不空跑 ffmpeg） */
export async function mergeWhiteboardScenes(
  inputs: string[],
  output: string,
  opts: { env?: NodeJS.ProcessEnv; timeoutMs?: number } = {},
): Promise<string> {
  const cfg = whiteboardEnv(opts.env);
  if (inputs.length === 0) throw new WhiteboardEngineError("白板合并失败：没有输入分幕");
  const run = await runPython(
    join(cfg.engineDir, "scripts/merge_scenes.py"),
    ["--inputs", ...inputs, "--output", output],
    { timeoutMs: opts.timeoutMs ?? 10 * 60_000, env: opts.env },
  );
  const out = parseOutputLine(run.stdout);
  if (!out || !existsSync(out)) {
    throw new WhiteboardEngineError(`白板合并未产出可读文件：${output}`, tail(run.stdout, 600));
  }
  return out;
}

/** 标注编号检查图：`render_annotation_preview.py`（确认关呈阅产物；本仓已打跨平台字体补丁） */
export async function renderAnnotationPreview(
  imagePath: string,
  annotationPath: string,
  outputPath: string,
  opts: { env?: NodeJS.ProcessEnv } = {},
): Promise<string> {
  const cfg = whiteboardEnv(opts.env);
  await runPython(
    join(cfg.engineDir, "scripts/render_annotation_preview.py"),
    [imagePath, annotationPath, outputPath],
    { timeoutMs: 60_000, env: opts.env },
  );
  if (!existsSync(outputPath)) throw new WhiteboardEngineError(`标注检查图未产出：${outputPath}`);
  return outputPath;
}

/* ================= 本仓线稿工具 ================= */

export type LineartToolResult<T> = ({ ok: true } & T) | { ok: false; error: string };

/**
 * 调 `scripts/whiteboard/lineart_tools.py` 的子命令。
 * 该工具统一「stdout = 一行 JSON」，因此这里直接解析并返回，失败信息原样带出。
 */
export async function runLineartTool<T>(
  args: string[],
  opts: { env?: NodeJS.ProcessEnv; timeoutMs?: number; allowNonZero?: boolean } = {},
): Promise<LineartToolResult<T>> {
  const cfg = whiteboardEnv(opts.env);
  let stdout = "";
  try {
    const run = await runPython(cfg.lineartTool, args, {
      timeoutMs: opts.timeoutMs ?? 10 * 60_000,
      env: opts.env,
    });
    stdout = run.stdout;
  } catch (err) {
    // `check` 用非 0 退出码表达"机检不过"，其 stdout 仍是合法 JSON——这里要读出来而不是丢掉
    const detail = (err as WhiteboardEngineError).detail ?? (err as Error).message;
    const line = detail.split(/\r?\n/).reverse().find((l) => l.trim().startsWith("{"));
    if (!opts.allowNonZero || !line) throw err;
    stdout = line;
  }
  const line = stdout.trim().split(/\r?\n/).reverse().find((l) => l.trim().startsWith("{"));
  if (!line) throw new WhiteboardEngineError(`线稿工具未输出 JSON：${args.join(" ")}`);
  return JSON.parse(line) as LineartToolResult<T>;
}

/* ================= 图片尺寸（不依赖第三方库，用于 annotation 校验） ================= */

export interface ImageSize { width: number; height: number }

/**
 * 读 PNG / JPEG 的像素尺寸。
 * 为什么自己解析：annotation.canvas 必须等于原图像素尺寸（上游 SKILL.md 的硬要求），
 * 而 `analyze` 的读数只在走线稿工具时才有；上传/复用线稿时需要一个不依赖 python 的校验面。
 */
export function readImageSize(absPath: string): ImageSize | null {
  if (!existsSync(absPath)) return null;
  const buf = readFileSync(absPath);
  // PNG：89 50 4E 47 0D 0A 1A 0A | IHDR 长度(4) 类型(4) 宽(4) 高(4)
  if (buf.length > 24 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) {
    return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
  }
  // JPEG：顺序扫描段，遇 SOF0..SOF15（不含 DHT/DAC 等）取尺寸
  if (buf.length > 4 && buf[0] === 0xff && buf[1] === 0xd8) {
    let offset = 2;
    while (offset + 9 < buf.length) {
      if (buf[offset] !== 0xff) { offset += 1; continue; }
      const marker = buf[offset + 1]!;
      if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) { offset += 2; continue; }
      const size = buf.readUInt16BE(offset + 2);
      const isSof = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
      if (isSof) {
        return { height: buf.readUInt16BE(offset + 5), width: buf.readUInt16BE(offset + 7) };
      }
      offset += 2 + size;
    }
  }
  return null;
}
