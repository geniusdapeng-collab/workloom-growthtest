/**
 * video/whiteboard/store.ts —— 白板渲染任务目录（唯一事实源，崩溃可恢复）
 *
 * 为什么落文件而不是只靠内存：渲染是分钟级长任务，进程重启/被 kill 之后必须知道
 * 「哪一幕已经渲完、合并到哪一步」，否则重跑会把已完成的幕重烧一遍 CPU。
 * 口径与 talkcraft 规格 §2.6 一致：`<WHITEBOARD_JOBS_DIR>/<taskId>/` 为唯一事实源，
 * `render_jobs` + poller 仍是**状态权威**（本文件只是执行面的断点续跑凭据）。
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { whiteboardEnv } from "./engine.js";

export type SceneRunStatus = "pending" | "rendering" | "rendered" | "failed";
export type JobRunStatus = "running" | "succeeded" | "failed";

export interface SceneRunState {
  sceneNo: number;
  sceneId: string;
  status: SceneRunStatus;
  annotationPath: string;
  outputPath: string;
  renderMs?: number;
  error?: string;
}

export interface WhiteboardJobState {
  taskId: string;
  projectId: string;
  status: JobRunStatus;
  /** 已完成的幕数 / 总幕数（人类可读进度） */
  progress: string;
  scenes: SceneRunState[];
  mergedPath: string | null;
  outputPath: string | null;
  durationMs: number | null;
  error: string | null;
  startedAt: string;
  updatedAt: string;
}

export function jobDir(taskId: string, env: NodeJS.ProcessEnv = process.env): string {
  return join(whiteboardEnv(env).jobsDir, taskId);
}

export function jobStatePath(taskId: string, env: NodeJS.ProcessEnv = process.env): string {
  return join(jobDir(taskId, env), "status.json");
}

/** 原子写：先写临时文件再 rename，避免 poller 读到半截 JSON */
export function writeJobState(state: WhiteboardJobState, env: NodeJS.ProcessEnv = process.env): void {
  const dir = jobDir(state.taskId, env);
  mkdirSync(dir, { recursive: true });
  const target = jobStatePath(state.taskId, env);
  const tmp = `${target}.tmp`;
  writeFileSync(tmp, `${JSON.stringify({ ...state, updatedAt: new Date().toISOString() }, null, 2)}\n`, "utf8");
  renameSync(tmp, target);
}

export function readJobState(taskId: string, env: NodeJS.ProcessEnv = process.env): WhiteboardJobState | null {
  const path = jobStatePath(taskId, env);
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf8")) as WhiteboardJobState;
  } catch {
    return null;
  }
}

/**
 * 断点续跑：已 `rendered` 且产物文件仍在的幕直接复用，不重渲。
 *
 * 真机场景：第 3 幕渲染中 kill -9 → 重启后任务目录里前 2 幕是 rendered，
 * 第 3 幕是 rendering（进程死了，没写终结态）→ 这里把它当 pending 重跑该幕。
 */
export function resumableScene(state: SceneRunState): boolean {
  return state.status === "rendered" && existsSync(state.outputPath);
}
