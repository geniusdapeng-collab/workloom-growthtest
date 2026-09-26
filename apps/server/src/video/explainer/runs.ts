/**
 * explainer/runs.ts —— 口播片运行投影（内存 run 注册表）· T-2026-0926-0008
 *
 * 与 studio-worker 的 vendor 预生产 run 注册表**分开**：explainer 不跑 vendor 的工序，
 * 但 `video.studio.status` 会兜底查这里，前端只认 runId，不需要知道背后是哪条管线。
 */
import { newId } from "@workloom/shared";
import type { ExplainerStageId } from "./pipeline.js";

export interface ExplainerRunEntry {
  runId: string;
  projectId: string;
  workspaceId: string;
  taskId: string;
  status: "running" | "done" | "failed";
  stage: ExplainerStageId | null;
  startedAt: string;
  finishedAt: string | null;
  error: string | null;
  resultSummary: string | null;
  aborted: boolean;
}

const runs = new Map<string, ExplainerRunEntry>();

export function newExplainerRunId(): string {
  return newId("RUN");
}

export function registerExplainerRun(entry: Omit<ExplainerRunEntry, "aborted"> & { aborted?: boolean }): ExplainerRunEntry {
  const full: ExplainerRunEntry = { aborted: false, ...entry };
  runs.set(full.runId, full);
  return full;
}

export function updateExplainerRun(runId: string, patch: Partial<ExplainerRunEntry>): void {
  const current = runs.get(runId);
  if (!current) return;
  runs.set(runId, { ...current, ...patch });
}

export function getExplainerRun(runId: string, workspaceId: string): ExplainerRunEntry | null {
  const entry = runs.get(runId);
  if (!entry || entry.workspaceId !== workspaceId) return null;
  return entry;
}

export function listExplainerRuns(workspaceId: string): ExplainerRunEntry[] {
  return [...runs.values()].filter((r) => r.workspaceId === workspaceId);
}
