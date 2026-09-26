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
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { GenProvider, GenRequest, GenTaskStatus } from "@workloom/base/model-router";
import { engineDirOf, engineStatus, jobsDirOf, licenseStateOf, talkcraftEnabled } from "./engine.js";

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
  /** 并行度（缺省 TALKCRAFT_RENDER_WORKERS=2） */
  parallel?: number;
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
    const params = (req.params ?? {}) as RemotionSubmitParams & { providerModel?: string };
    const taskId = `rtc-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    const jobDir = params.jobDir ?? join(jobsDirOf(env), taskId);
    if (!existsSync(join(jobDir, "remotion", "props.json"))) {
      throw new Error(`RemotionProvider：工程未装配（缺 ${join(jobDir, "remotion/props.json")}）——先跑 project-builder`);
    }
    const license = licenseStateOf(engineDirOf(env), env);
    if (!license.okToRender) throw new Error(`RemotionProvider：许可闸拒绝渲染——${license.reason}`);

    const scope = params.scope ?? "full";
    writeJobState(jobDir, { status: "running", taskId, jobDir, scope, startedAt: new Date().toISOString() });
    const args = renderShotsArgs({
      scope,
      parallel: params.parallel ?? Number(env.TALKCRAFT_RENDER_WORKERS ?? 2),
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
    });
    let tail = "";
    const collect = (chunk: unknown) => {
      tail = (tail + String(chunk)).slice(-8000);
    };
    child.stdout.on("data", collect);
    child.stderr.on("data", collect);
    child.on("error", (err) => {
      writeJobState(jobDir, { status: "failed", taskId, jobDir, error: `渲染进程启动失败：${err.message}` });
    });
    child.on("exit", (code) => {
      const out = join(jobDir, "out", "v1.mp4");
      const ok = code === 0 && existsSync(out);
      writeJobState(jobDir, {
        status: ok ? "succeeded" : "failed",
        taskId,
        jobDir,
        scope,
        outputPath: ok ? out : undefined,
        seconds: params.audioSeconds,
        logTail: tail,
        error: ok ? undefined : `render_shots 退出码 ${code}：${tail.slice(-500)}`,
      });
    });
    return { taskId };
  }

  async poll(taskId: string): Promise<{ status: GenTaskStatus; uri?: string; actualUnits?: number; error?: string }> {
    const env = this.opts.env ?? process.env;
    const jobDir = join(jobsDirOf(env), taskId);
    const state = readJobState(jobDir);
    if (!state) {
      return { status: "running", error: `任务 ${taskId} 状态文件尚未落盘（渲染刚启动）` };
    }
    if (state.status === "running") return { status: "running" };
    if (state.status === "failed") return { status: "failed", error: state.error ?? "渲染失败（无错误文本）" };
    return { status: "succeeded", uri: state.outputPath, actualUnits: state.seconds };
  }
}
