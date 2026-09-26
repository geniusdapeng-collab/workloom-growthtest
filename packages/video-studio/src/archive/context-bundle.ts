/**
 * archive/context-bundle.ts —— 交接包（跨会话承接，对齐 DEVELOPMENT-PROTOCOL §6 交接单口径）。
 *
 * 作用：任何新会话/新 Agent 拿到 `<archiveRoot>/context-bundle.json` + `manifest.json`
 *       就能续跑，不必依赖原始对话上下文（规格书 §3 自包含原则）。
 * 重建时机：每次 `stage.done` / `stage.failed` 后重建（StageRunner 内置调用），
 *          终态由宿主再重建一次（把 resultSummary / 失败原因一并写进去）。
 *
 * 口径：`decisions / openQuestions / nextSteps` 为**人可读的承接线索**，不是权威事实源——
 *      权威事实源是 manifest.ledger（环节账本）+ production_stage_runs（索引面）+ Issue 回执。
 */
import { PIPELINE_STAGES } from "../stage-registry.js";
import type { ArchiveManifest, ArchiveStore, PipelineKind } from "./store.js";

export const CONTEXT_BUNDLE_VERSION = "production-archive/v1";

export interface ContextBundle {
  projectId: string;
  pipelineKind: PipelineKind;
  /** 关联任务线程（video_projects.thread_id；缺省 null） */
  threadId: string | null;
  /** 进度：由 manifest.ledger + 预生产输出推导的人可读摘要 */
  progress: string;
  decisions: string[];
  openQuestions: string[];
  nextSteps: string[];
  /** 档案根（绝对路径；文件系统是档案本体，跨会话承接直接用它） */
  archiveRoot: string;
  protocolVersion: string;
  updatedAt: string;
}

export interface ContextBundleInput {
  threadId?: string | null;
  pipelineKind?: PipelineKind;
  decisions?: string[];
  openQuestions?: string[];
  nextSteps?: string[];
  /** 最近完成的宿主环节（用于进度叙述） */
  lastStage?: string;
  /** 失败环节 + 分类（用于 openQuestions / nextSteps） */
  failedStage?: string;
  errorClass?: string | null;
  errorMsg?: string | null;
}

const MAX_ITEMS = 20;

function mergeList(previous: string[] | undefined, next: string[] | undefined): string[] {
  const out: string[] = [];
  for (const item of [...(previous ?? []), ...(next ?? [])]) {
    const text = String(item).trim();
    if (!text || out.includes(text)) continue;
    out.push(text);
    if (out.length >= MAX_ITEMS) break;
  }
  return out;
}

/**
 * 进度推导（不猜数字）：
 *   - 宿主环节：manifest.ledger 的已完成/总条目；
 *   - 预生产内部环节：读最近一次 `preproduction` 产物里的 `stages[]`（vendor 真实产出清单），
 *     分母用 stage-registry 登记表口径（29 条，含 6 条 conditional）。
 */
export async function summarizeArchiveProgress(
  store: ArchiveStore,
  manifest: ArchiveManifest | null,
  lastStage?: string,
): Promise<string> {
  const ledger = manifest?.ledger ?? {};
  const done = Object.values(ledger).filter((entry) => entry.status === "done").length;
  const total = Object.keys(ledger).length;
  const parts: string[] = [`宿主环节 ${done}/${total} 已归档`];

  const preAttempt = ledger["preproduction"]?.attempt;
  const candidates = preAttempt ? [preAttempt] : await store.listAttempts("preproduction").then((rows) => rows.map((row) => row.attempt).slice(-1));
  for (const attempt of [...candidates].reverse()) {
    const output = await store.readJson<{ stages?: unknown }>(`stages/preproduction/attempt-${attempt}.output.json`);
    const stages = Array.isArray(output?.stages) ? output!.stages.length : null;
    if (stages !== null) {
      parts.push(`预生产内部环节 ${stages}/${PIPELINE_STAGES.length} 已产出`);
      break;
    }
  }
  const current = lastStage ?? Object.keys(ledger).at(-1) ?? "未开始";
  parts.push(`当前 ${current}`);
  return parts.join("；");
}

function deriveNextSteps(input: ContextBundleInput, progress: string): string[] {
  if (input.failedStage) {
    return [
      `修复 ${input.failedStage} 失败（${input.errorClass ?? "未分类"}）后调用 video.studio.resume 续跑`,
      `如需从指定环节重来：video.studio.resume({ projectId, fromStage })（人工裁决）`,
    ];
  }
  if (!progress.includes("未开始")) {
    return ["读 manifest.ledger 对齐进度 → 调 video.studio.resume 续跑（渲染/后期段由 poller 自动接续）"];
  }
  return ["先跑 video.studio.start（projectId 补跑）立项预生产"];
}

/** 重建交接包（读改写，保留历史线索；写失败由调用方 safe() 兜底） */
export async function updateContextBundle(
  store: ArchiveStore,
  input: ContextBundleInput = {},
): Promise<ContextBundle> {
  const manifest = await store.readManifest();
  const previous = await store.readJson<ContextBundle>("context-bundle.json");
  const progress = await summarizeArchiveProgress(store, manifest, input.lastStage);

  /**
   * 交接包是**面向下一棒的行动指南**，不是过程博物馆：
   *   - `decisions`（历史裁决）继续累加，跨会话承接要看得见走过的路；
   *   - `openQuestions` 在同一环节失败时**替换旧条目**（否则每轮重跑都追加一条同义句）；
   *   - `nextSteps` 有新值即**整体替换**（旧建议会误导恢复动作）。
   * 真机审计：营销片三连跑后 openQuestions/nextSteps 出现同义重复（"失败（BUG）…"）
   * 与过期建议并存，故在此收紧。
   */
  const stalePrefix = input.failedStage ? `${input.failedStage} 失败` : null;
  const priorQuestions = (previous?.openQuestions ?? []).filter(
    (item) => !stalePrefix || !String(item).startsWith(stalePrefix),
  );
  const openQuestions = mergeList(priorQuestions, [
    ...(input.openQuestions ?? []),
    ...(input.failedStage
      ? [`${input.failedStage} 失败（${input.errorClass ?? "未分类"}）：${(input.errorMsg ?? "").slice(0, 200)}`]
      : []),
  ]);
  /** nextSteps 是行动指南：每次重建都以当轮结论为准（有值时整体替换，不与旧建议并存） */
  const nextSteps = mergeList(undefined, [...(input.nextSteps ?? []), ...deriveNextSteps(input, progress)]);

  const bundle: ContextBundle = {
    projectId: store.projectId,
    pipelineKind: input.pipelineKind ?? manifest?.pipelineKind ?? store.pipelineKind,
    threadId: input.threadId ?? previous?.threadId ?? null,
    progress,
    decisions: mergeList(previous?.decisions, input.decisions),
    openQuestions,
    nextSteps,
    archiveRoot: store.root,
    protocolVersion: CONTEXT_BUNDLE_VERSION,
    updatedAt: new Date().toISOString(),
  };
  await store.writeJsonAtomic("context-bundle.json", bundle);
  return bundle;
}

/** 只读交接包（跨会话承接标准动作第一步：读 manifest → 读 context-bundle → 调 studio.resume） */
export async function readContextBundle(store: ArchiveStore): Promise<ContextBundle | null> {
  return store.readJson<ContextBundle>("context-bundle.json");
}
