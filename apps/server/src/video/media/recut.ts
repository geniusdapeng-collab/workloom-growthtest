/**
 * media/recut.ts —— 合集重剪作业（T-2026-0926-0008）
 *
 * 片单 → 逐段归一化 → ffmpeg concat → 新成片自动入库（kind=final_cut / source_type=recut）。
 * 纪律（对齐交付层 `delivery.ts` 的本地作业范式）：
 *  - 不烧额度、不碰模型：纯本地 ffmpeg 作业；
 *  - 立刻返回 jobId，前端轮询（HTTP 长事务会把 UI 与网关一起拖住）；
 *  - 失败**显式进作业状态**（不静默）：缺 ffmpeg、素材不在本地、拼接报错都带原文；
 *  - 产出走 registerLocalAsset（sha256 幂等 + D16 事件），并回写合集 meta.producedAssetId。
 */
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type pg from "pg";
import { newId } from "@workloom/shared";
import { scopedQuery, type AppPool, type Scope } from "../gen/db.js";
import { deliveryRoot } from "../delivery.js";
import { mediaRoot } from "../gen/ingest.js";
import { resolveInside } from "./paths.js";
import { concatNormalize, ffmpegAvailable } from "./ffmpeg.js";
import { registerLocalAsset } from "./register-local.js";
import { markCollectionUsed } from "./collections.js";

export type RecutStatus = "running" | "done" | "failed";

export interface RecutJob {
  jobId: string;
  collectionId: string;
  title: string;
  status: RecutStatus;
  startedAt: string;
  finishedAt: string | null;
  segments: number;
  producedAssetId: string | null;
  outputPath: string | null;
  error: string | null;
  log: string[];
  by: string;
}

/** 作业注册表（内存投影；日志同时落盘 `var/delivery/recut-<jobId>/job.log` 供事后审计） */
const jobs = new Map<string, RecutJob>();

export function recutJob(jobId: string): RecutJob | null {
  return jobs.get(jobId) ?? readJobFromDisk(jobId);
}

/** 作业状态落盘（进程重启后仍可查询；深审发现原来只在内存里 → 重启即 404） */
function jobFile(jobId: string, env: NodeJS.ProcessEnv = process.env): string {
  return join(deliveryRoot(env), `recut-${jobId.toLowerCase()}`, "job.json");
}

function persistJob(job: RecutJob): void {
  try {
    writeFileSync(jobFile(job.jobId), `${JSON.stringify(job, null, 2)}\n`, "utf8");
  } catch (err) {
    console.warn(`[media] 重剪作业状态落盘失败（不影响作业）：${err instanceof Error ? err.message : String(err)}`);
  }
}

function readJobFromDisk(jobId: string): RecutJob | null {
  const file = jobFile(jobId);
  if (!existsSync(file)) return null;
  try {
    return JSON.parse(readFileSync(file, "utf8")) as RecutJob;
  } catch {
    return null;
  }
}

export function listRecutJobs(filter?: { collectionId?: string }): RecutJob[] {
  const rows = [...jobs.values()];
  return (filter?.collectionId ? rows.filter((j) => j.collectionId === filter.collectionId) : rows)
    .sort((a, b) => b.startedAt.localeCompare(a.startedAt));
}

type RecutItem = {
  seq: number;
  asset_id: string;
  local_path: string | null;
  duration_seconds: string | null;
  status: string;
};

export interface StartRecutResult {
  jobId: string;
  segments: number;
}

/**
 * 启动重剪作业：入参校验（合集存在、≥2 段、素材未归档、ffmpeg 可用）在**返回 jobId 之前**完成，
 * 这样"点了按钮却什么都不会发生"的情况在上层就是明确的 4xx，而不是一个永远失败的作业。
 */
export async function startRecut(
  app: AppPool,
  gateway: pg.Pool,
  scope: Scope,
  input: { collectionId: string; title: string; by: string; env?: NodeJS.ProcessEnv },
): Promise<StartRecutResult> {
  const env = input.env ?? process.env;
  const collection = await scopedQuery<{ id: string; title: string }>(app, scope,
    `SELECT id, title FROM media_collections WHERE workspace_id = $1 AND id = $2`,
    [scope.workspaceId, input.collectionId]);
  if (!collection[0]) throw new Error(`合集 ${input.collectionId} 不在当前工作区`);

  // 同一合集同时只允许一个重剪作业（深审实测：原实现可并行开两个，互相覆盖产出/争 CPU）
  const running = [...jobs.values()].find((job) => job.collectionId === input.collectionId && job.status === "running");
  if (running) throw new Error(`该合集已有重剪作业在执行中（${running.jobId}）：等它结束再提交`);

  const items = await scopedQuery<RecutItem>(app, scope,
    `SELECT i.seq, i.asset_id, a.meta->>'localPath' AS local_path, a.duration_seconds, a.status
       FROM media_collection_items i
       JOIN video_assets a ON a.workspace_id = i.workspace_id AND a.id = i.asset_id
      WHERE i.workspace_id = $1 AND i.collection_id = $2 AND a.status <> 'archived'
      ORDER BY i.seq ASC`,
    [scope.workspaceId, input.collectionId]);
  if (items.length < 2) throw new Error("合集至少 2 段素材才能重剪");
  const missing = items.filter((item) => {
    if (!item.local_path) return true;
    try {
      return !existsSync(resolveInside(mediaRoot(), item.local_path, "片段路径"));
    } catch {
      return true;   // 越界路径一律视为"不在本机媒体仓"
    }
  });
  if (missing.length > 0) {
    throw new Error(`有 ${missing.length} 段素材不在本机媒体仓（先点播触发文件拉取再重剪）：${missing.slice(0, 3).map((m) => m.asset_id).join("、")}`);
  }
  const avail = await ffmpegAvailable(env);
  if (!avail.ok) throw new Error(`重剪前置检查失败：${avail.error}`);

  const jobId = newId("RCJ");
  const outDir = join(deliveryRoot(env), `recut-${jobId.toLowerCase()}`);
  mkdirSync(outDir, { recursive: true });
  const job: RecutJob = {
    jobId,
    collectionId: input.collectionId,
    title: input.title,
    status: "running",
    startedAt: new Date().toISOString(),
    finishedAt: null,
    segments: items.length,
    producedAssetId: null,
    outputPath: null,
    error: null,
    log: [`[${new Date().toISOString()}] 重剪开始：合集 ${input.collectionId}（${items.length} 段）→ ${outDir}`],
    by: input.by,
  };
  jobs.set(jobId, job);
  persistJob(job);

  void (async () => {
    try {
      const outputPath = join(outDir, "master.mp4");
      const summary = await concatNormalize(
        items.map((item) => resolveInside(mediaRoot(), item.local_path!, "片段路径")),
        outputPath,
        { env, onProgress: (line) => { job.log.push(`[${new Date().toISOString()}] ${line}`); } },
      );
      const reg = await registerLocalAsset(app, gateway, scope, {
        absPath: outputPath,
        kind: "final_cut",
        title: input.title,
        tags: ["重剪"],
        sourceType: "recut",
        provenance: {
          source: "recut",
          collectionId: input.collectionId,
          fromAssets: items.map((item) => item.asset_id),
          fromPaths: items.map((item) => item.local_path),
          normalize: summary,
        },
        meta: { recutJobId: jobId, collectionId: input.collectionId },
        by: input.by,
      });
      await markCollectionUsed(app, scope, {
        collectionId: input.collectionId, producedAssetId: reg.assetId, by: input.by,
      });
      job.status = "done";
      job.producedAssetId = reg.assetId;
      job.outputPath = outputPath;
      job.finishedAt = new Date().toISOString();
      job.log.push(`[${job.finishedAt}] 重剪完成：${items.length} 段 → 新成片 ${reg.assetId}${reg.deduped ? "（sha256 命中既有素材，未重复入库）" : ""}`);
      persistJob(job);
    } catch (err) {
      job.status = "failed";
      job.error = err instanceof Error ? err.message : String(err);
      job.finishedAt = new Date().toISOString();
      job.log.push(`[${job.finishedAt}] 重剪失败：${job.error}`);
      persistJob(job);
    }
  })().finally(() => {
    // 归一化中间产物（.segments）只服务本次拼接，作业结束即清理（深审实测：原实现永久残留）
    try {
      rmSync(join(outDir, "master.mp4.segments"), { recursive: true, force: true });
    } catch (err) {
      console.warn(`[media] 重剪临时目录清理失败（不影响产出）：${err instanceof Error ? err.message : String(err)}`);
    }
  });

  return { jobId, segments: items.length };
}
