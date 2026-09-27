/**
 * explainer/remotion-provider.ts —— 本地 Remotion 渲染 provider（GenProvider 实现）· T-2026-0926-0008
 *
 * 编排依据：引擎 `scripts/render_shots.mjs` 的真实 CLI（spec §1.1②）：
 *   - **必须在工程 remotion/ 目录下执行**（Remotion 从工程 node_modules 解析，自动加载 remotion.config.ts）；
 *   - 段缓存 + 帧数断言内建：非零退出即 FAIL（禁止"看起来对了"）；
 *   - 音画对齐三纪律内建：音轨整条不分段 / 段边界 Math.round(start*fps) / 总量帧数断言。
 *
 * 与 Growth 链路的接法（spec §6.1）：
 *   `submitGenJob` 走 pool → 本 provider 的 submit（起异步渲染，写 status.json）→ `render-poller` 轮询
 *   → 成片入库（explainer kind 走 final_cut）→ 制片档案环节台账。
 *   任务目录 `var/talkcraft-jobs/<taskId>/` 是**唯一事实源**：进程崩溃后 poller 照常恢复（读 status.json）。
 */
import { execFile, spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { promisify } from "node:util";
import type { GenProvider, GenRequest, GenTaskStatus } from "@workloom/base/model-router";
import { engineDirOf, engineStatus, jobsDirOf, licenseStateOf, talkcraftEnabled } from "./engine.js";

const execFileAsync = promisify(execFile);

/** 读取编码后的视频流尺寸；不可探测时失败，不能把文件存在当成 UHD 回执。 */
export async function probeRenderedSize(
  file: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<{ width: number; height: number }> {
  const { stdout } = await execFileAsync(env.FFPROBE_PATH?.trim() || "ffprobe", [
    "-v", "error", "-select_streams", "v:0", "-show_entries", "stream=width,height", "-of", "csv=p=0:s=x", file,
  ], { env, timeout: 60_000 });
  const m = /^(\d+)x(\d+)$/.exec(stdout.trim());
  if (!m) throw new Error(`ffprobe 未返回视频尺寸：${file}（${stdout.trim().slice(0, 100)}）`);
  return { width: Number(m[1]), height: Number(m[2]) };
}

export interface RemotionJobState {
  status: "running" | "succeeded" | "failed";
  taskId: string;
  jobDir: string;
  outputPath?: string;
  seconds?: number;
  scope?: string;
  error?: string;
  startedAt?: string;
  updatedAt?: string;
  /** 渲染日志尾部（<=8KB；排障用，不进事件 payload） */
  logTail?: string;
}

export interface RemotionSubmitParams {
  /** 已装配好的工程目录（project-builder 产出；缺省按 taskId 推算） */
  jobDir?: string;
  /** 配音秒数（actualUnits 口径） */
  audioSeconds?: number;
  /** 渲染范围：full | changed:<shotId> | only:<a,b> */
  scope?: string;
  /** 并行度（HD 缺省 TALKCRAFT_RENDER_WORKERS=2；UHD 强制 1） */
  parallel?: number;
}

/** The generation router nests provider-specific fields under extra; direct CLI
 * callers use the historical top-level form. Conflicting copies fail before writes. */
export function remotionSubmitParams(req: GenRequest): RemotionSubmitParams {
  const all = req.params ?? {};
  const extra = all.extra;
  if (extra !== undefined && (!extra || typeof extra !== "object" || Array.isArray(extra))) {
    throw new Error("RemotionProvider：extra 必须是对象");
  }
  const nested = (extra ?? {}) as Record<string, unknown>;
  const values: Record<string, unknown> = {};
  for (const key of ["jobDir", "audioSeconds", "scope", "parallel"] as const) {
    if (all[key] !== undefined && nested[key] !== undefined && all[key] !== nested[key]) {
      throw new Error(`RemotionProvider：参数 ${key} 在 params 与 extra 中冲突`);
    }
    values[key] = nested[key] ?? all[key];
  }
  return z.object({
    jobDir: z.string().min(1).optional(), audioSeconds: z.number().positive().optional(),
    scope: z.string().regex(/^(full|changed:[^,\s:]+|only:[^,\s:]+(?:,[^,\s:]+)*)$/).optional(),
    parallel: z.number().int().min(1).max(64).optional(),
  }).parse(values);
}

/** 4K 帧在 8 GiB 工作站上只允许一个段渲染进程。 */
export function renderWorkerCount(width: number, height: number, requested: number): number {
  if (!Number.isInteger(requested) || requested < 1) {
    throw new Error(`TALKCRAFT_RENDER_WORKERS 必须是正整数，实际 ${requested}`);
  }
  return Math.max(width, height) >= 3840 ? 1 : requested;
}

export function statePathOf(jobDir: string): string {
  return join(jobDir, "status.json");
}

export function readJobState(jobDir: string): RemotionJobState | null {
  const file = statePathOf(jobDir);
  if (!existsSync(file)) return null;
  try {
    return JSON.parse(readFileSync(file, "utf8")) as RemotionJobState;
  } catch {
    return null;
  }
}

export function writeJobState(jobDir: string, state: RemotionJobState): void {
  mkdirSync(jobDir, { recursive: true });
  writeFileSync(statePathOf(jobDir), JSON.stringify({ ...state, updatedAt: new Date().toISOString() }, null, 1));
}

/** 渲染命令组装（独立导出便于单测与审计；参数顺序即真实 CLI 口径） */
export function renderShotsArgs(input: {
  scope?: string;
  parallel?: number;
  concatOut?: string;
  audioOut?: string;
  muxOut?: string;
  propsFile?: string;
  imageFormat?: string;
  jpegQuality?: number;
  crf?: number;
}): string[] {
  const args = ["--shots", "shots.json"];
  const scope = input.scope ?? "full";
  if (scope === "full") args.push("--all");
  else if (scope.startsWith("changed:")) args.push("--changed", scope.slice("changed:".length));
  else if (scope.startsWith("only:")) args.push("--only", scope.slice("only:".length));
  else throw new Error(`渲染范围非法：${scope}（合法：full | changed:<shotId> | only:<a,b>）`);
  args.push("--parallel", String(input.parallel ?? 2));
  if (input.concatOut) args.push("--concat", input.concatOut);
  if (input.audioOut) args.push("--audio", input.audioOut);
  if (input.muxOut) args.push("--mux", input.muxOut);
  if (input.propsFile) args.push("--props", `@${input.propsFile}`);
  if (input.imageFormat) args.push("--image-format", input.imageFormat);
  if (input.jpegQuality !== undefined) args.push("--jpeg-quality", String(input.jpegQuality));
  if (input.crf !== undefined) args.push("--crf", String(input.crf));
  return args;
}

export class RemotionProvider implements GenProvider {
  readonly providerId = "remotion-local";
  readonly kind = "video" as const;

  constructor(private readonly opts: { env?: NodeJS.ProcessEnv } = {}) {}

  async healthy(): Promise<boolean> {
    const env = this.opts.env ?? process.env;
    if (!talkcraftEnabled(env)) return false;
    return engineStatus(engineDirOf(env), env).ready;
  }

  async submit(req: GenRequest): Promise<{ taskId: string }> {
    const env = this.opts.env ?? process.env;
    const raw = req.params ?? {};
    const params = remotionSubmitParams(req);
    const taskId = `rtc-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    const jobDir = params.jobDir ?? join(jobsDirOf(env), taskId);
    const propsFile = join(jobDir, "remotion", "props.json");
    if (!existsSync(propsFile)) {
      throw new Error(`RemotionProvider：工程未装配（缺 ${join(jobDir, "remotion/props.json")}）——先跑 project-builder`);
    }
    const props = JSON.parse(readFileSync(propsFile, "utf8")) as { width?: number; height?: number };
    if (!Number.isInteger(props.width) || !Number.isInteger(props.height)
      || (props.width ?? 0) <= 0 || (props.height ?? 0) <= 0) {
      throw new Error(`RemotionProvider：工程 props 缺少有效画布尺寸：${propsFile}`);
    }
    const width = props.width!;
    const height = props.height!;
    const expected = `${width}x${height}`;
    if (raw.resolution !== undefined && raw.resolution !== expected) {
      throw new Error(`RemotionProvider：提交尺寸 ${raw.resolution} 与工程画布 ${expected} 不一致`);
    }
    const license = licenseStateOf(engineDirOf(env), env);
    if (!license.okToRender) throw new Error(`RemotionProvider：许可闸拒绝渲染——${license.reason}`);

    const scope = params.scope ?? "full";
    const parallel = renderWorkerCount(width, height,
      params.parallel ?? Number(env.TALKCRAFT_RENDER_WORKERS ?? 2));
    const uhd = Math.max(width, height) >= 3840;
    /**
     * taskId → jobDir 指针（真机事故，T-2026-0926-0008）：
     * 编排方给的工程目录不一定叫 taskId（服务端是 `<shotbookId>-v<n>/`），而 poll(taskId) 只能拿到 taskId。
     * 上一版让 poll 直接按 `jobsDir/<taskId>` 找 status.json → 永远读不到（渲染早就完成，CLI 却干等到超时）。
     * 指针文件就是这条映射的唯一事实源，崩溃重启后依然有效。
     */
    mkdirSync(jobsDirOf(env), { recursive: true });
    writeFileSync(join(jobsDirOf(env), `${taskId}.jobdir`), jobDir);
    writeJobState(jobDir, { status: "running", taskId, jobDir, scope, startedAt: new Date().toISOString() });
    const args = renderShotsArgs({
      scope,
      parallel,
      concatOut: "../out/assembled.mp4",
      audioOut: "../out/full-mix.wav",
      muxOut: "../out/v1.mp4",
      propsFile: "props.json",
      imageFormat: env.TALKCRAFT_IMAGE_FORMAT,
      jpegQuality: env.TALKCRAFT_JPEG_QUALITY ? Number(env.TALKCRAFT_JPEG_QUALITY) : 95,
      crf: env.TALKCRAFT_CRF ? Number(env.TALKCRAFT_CRF) : undefined,
    });
    const child = spawn("node", [join(engineDirOf(env), "scripts/render_shots.mjs"), ...args], {
      cwd: join(jobDir, "remotion"),
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, ...env, ...(uhd ? { TALKCRAFT_CONCURRENCY: "1" } : {}) },
    });
    let tail = "";
    const collect = (chunk: unknown) => {
      tail = (tail + String(chunk)).slice(-8000);
    };
    child.stdout.on("data", collect);
    child.stderr.on("data", collect);
    let startError: Error | null = null;
    child.on("error", (err) => { startError = err; });
    child.on("close", (code) => {
      void (async () => {
        const out = join(jobDir, "out", "v1.mp4");
        let error = startError ? `渲染进程启动失败：${startError.message}` : "";
        if (!error && (code !== 0 || !existsSync(out))) error = `render_shots 退出码 ${code}：${tail.slice(-500)}`;
        if (!error) {
          try {
            const actual = await probeRenderedSize(out, env);
            if (`${actual.width}x${actual.height}` !== expected) {
              error = `渲染尺寸不符：期望 ${expected}，实际 ${actual.width}x${actual.height}`;
            }
          } catch (err) {
            error = `渲染尺寸无法核验：${err instanceof Error ? err.message : String(err)}`;
          }
        }
        const ok = !error;
        writeJobState(jobDir, {
          status: ok ? "succeeded" : "failed",
          taskId,
          jobDir,
          scope,
          outputPath: ok ? out : undefined,
          seconds: params.audioSeconds,
          logTail: tail,
          error: ok ? undefined : error,
        });
      })().catch((err) => writeJobState(jobDir, {
        status: "failed", taskId, jobDir,
        error: `渲染收尾失败：${err instanceof Error ? err.message : String(err)}`,
      }));
    });
    return { taskId };
  }

  async poll(taskId: string): Promise<{ status: GenTaskStatus; uri?: string; actualUnits?: number; error?: string }> {
    const env = this.opts.env ?? process.env;
    const jobsDir = jobsDirOf(env);
    const pointer = join(jobsDir, `${taskId}.jobdir`);
    const jobDir = existsSync(pointer) ? readFileSync(pointer, "utf8").trim() : join(jobsDir, taskId);
    const state = readJobState(jobDir);
    if (!state) {
      return { status: "running", error: `任务 ${taskId} 状态文件尚未落盘（渲染刚启动）` };
    }
    if (state.status === "running") return { status: "running" };
    if (state.status === "failed") return { status: "failed", error: state.error ?? "渲染失败（无错误文本）" };
    return { status: "succeeded", uri: state.outputPath, actualUnits: state.seconds };
  }
}
