/**
 * video/render-poller.ts —— 渲染结果轮询回填（v3.0 下一迭代：异步任务制第二步）
 *
 * 扫描 render_jobs 中 submitted/rendering 的任务，经 gen-pool poll(task_id) 回填：
 *   succeeded → status='done' + result_url + render.complete 事件（actual_seconds 台账回填）
 *   failed    → status='failed' + render.failed 事件（原因留痕，不静默）
 *   running   → status 推进 'rendering'
 * mock 任务（task_id 前缀 mock-）走 MockGenProvider（离线全流程可跑）。
 * 纪律：状态推进与事件同一事务同一 COMMIT（D16 同构）；provider 取自提交事件留痕。
 */
import type pg from "pg";
import { gatewayAppendOnClient } from "@workloom/base/workdata";
import {
  MockGenProvider, genPoolFromEnv, type GenProvider,
} from "@workloom/base/model-router";
import { newId } from "@workloom/shared";
import { videoGenPool } from "./gen/providers.js";
import { downloadToMediaStore, registerRenderedClip } from "./gen/ingest.js";
import { scopedQuery } from "./gen/db.js";
import { findModelByProviderModel } from "./gen/catalog.js";
import { recordRenderCost, usdCnyRate } from "./gen/cost.js";
import { classifyProviderError, logStageOutcome, type ArchiveStore, type StageLedgerWriter } from "@hyperreality/video-studio";
import { makeStageArchive } from "./archive-host.js";

interface Scope { tenantId: string; workspaceId: string }

interface OpenJob {
  id: string;
  task_id: string;
  script_id: string;
  project_id: string;
  provider_model: string | null;
  est_cny: string | null;
  est_usd: string | null;
  created_at: string;
  /** 提交事件原文（provider / request.aspectRatio 等留痕字段一次取回，避免重复扫事件表） */
  submit_payload: { decision?: { after?: { provider?: string; request?: { aspectRatio?: string } } } } | null;
}

/**
 * C-04 修复：渲染任务终态超时（小时）。此前 provider.poll 任何异常都被当作"仍在跑"，
 * 供应商网关持续故障时作业永远卡 submitted/rendering（无出口状态，实锤见排雷台账）。
 * 超龄任务无论 poll 返回什么都判 failed（原因留痕），给交付链一个终态出口。
 * 默认 24h（长片型渲染最慢以小时计）；可用 RENDER_JOB_TIMEOUT_H 调整，0 关闭。
 */
const RENDER_JOB_TIMEOUT_H = Number(process.env.RENDER_JOB_TIMEOUT_H ?? 24);
function renderJobTimedOut(job: OpenJob): boolean {
  if (!(RENDER_JOB_TIMEOUT_H > 0)) return false;
  // created_at 由 pg 返回 Date（也兼容驱动配成字符串的部署），统一走 Date 构造避免格式猜测
  const ageMs = Date.now() - new Date(job.created_at).getTime();
  return Number.isFinite(ageMs) && ageMs > RENDER_JOB_TIMEOUT_H * 3600_000;
}

export interface PollReport {
  checked: number;
  done: number;
  failed: number;
  running: number;
  ingested: number;
  details: Array<{
    jobId: string; status: string; uri?: string; error?: string;
    assetId?: string; ingestError?: string; costError?: string;
  }>;
}

/** 生成供应商解析：提交事件留痕优先；mock 前缀回退；缺省 seedance（首选） */
function resolveProvider(
  pool: Map<string, GenProvider>,
  job: OpenJob,
  mockPool: Map<string, GenProvider>,
): GenProvider | null {
  const provider = job.submit_payload?.decision?.after?.provider ?? null;
  if (job.task_id.startsWith("mock-")) {
    return mockPool.get(provider ?? "seedance") ?? mockPool.get("seedance") ?? null;
  }
  return pool.get(provider ?? "seedance") ?? null;
}

/**
 * 项目 kind → 媒资库片型（narrative / marketing / explainer）。
 *
 * T-2026-0926-0020：0042 起 `explainer`（口播解说片）是合法项目类型，
 * 白板片的产物不该被登记成 narrative——媒资库的片型筛选就是靠这一列。
 * 未知值按叙事片兜底（与既有行为一致，不因新增枚举引入空值）。
 */
export function pipelineKindOf(projectKind: string | null | undefined): "narrative" | "marketing" | "explainer" {
  if (projectKind === "marketing") return "marketing";
  if (projectKind === "explainer") return "explainer";
  return "narrative";
}

export async function pollRenderJobs(
  app: pg.Pool,
  gateway: pg.Pool,
  scope: Scope,
  opts: {
    limit?: number;
    pool?: Map<string, GenProvider>;
    /** 成片入库开关（默认 true；测试可关） */
    ingest?: boolean;
    fetchImpl?: typeof fetch;
    /**
     * 制片档案句柄（T-2026-0926-0002）：
     *   - 缺省（undefined）= 按 HR_WORK_DIR/ARCHIVE_ENABLED 自建；
     *   - `null` = 显式关闭（测试用）；
     *   - 显式传入 = 复用调用方句柄（同一项目多次轮询共用一个 store）。
     */
    archive?: { store: ArchiveStore; ledger: StageLedgerWriter } | null;
  } = {},
): Promise<PollReport> {
  // 生成池：基座 provider（Kling/即梦等）与视频接缝 provider（Ark 带参数 / Higgsfield / MuAPI）合并，
  // 后者优先（同 providerId 时以视频接缝实现为准：带参数与报价口径）。
  const realPool = opts.pool ?? new Map<string, GenProvider>([...genPoolFromEnv(), ...videoGenPool()]);
  const mockPool = new Map<string, GenProvider>([
    ["seedance", new MockGenProvider("seedance")],
    ["kling", new MockGenProvider("kling")],
    ["jimeng", new MockGenProvider("jimeng")],
  ]);
  const report: PollReport = { checked: 0, done: 0, failed: 0, running: 0, ingested: 0, details: [] };
  /** 档案句柄（每个项目一个：同一 job 的多次轮询不会重复开 attempt，只有终态才记账） */
  const archiveCache = new Map<string, { store: ArchiveStore; ledger: StageLedgerWriter } | null>();
  const archiveFor = (projectId: string) => {
    if (opts.archive === null) return null;
    if (opts.archive) return opts.archive;
    if (!archiveCache.has(projectId)) archiveCache.set(projectId, makeStageArchive(scope, projectId));
    return archiveCache.get(projectId) ?? null;
  };

  const client = await app.connect();
  let jobs: OpenJob[];
  try {
    // 事务级 RLS 上下文必须在显式事务内设置（编码铁律）
    await client.query("BEGIN");
    await client.query("SELECT set_config('app.workspace_id', $1, true)", [scope.workspaceId]);
    await client.query("SELECT set_config('app.tenant_id', $1, true)", [scope.tenantId]);
    // 开放任务 + 提交事件留痕的供应商（event 回放取 provider，无留痕回退推断）
    const rows = await client.query<OpenJob>(
      `SELECT j.id, j.task_id, j.script_id, j.project_id, j.provider_model, j.est_cny, j.est_usd, j.created_at,
              (SELECT e.payload
                 FROM biz_events e
                WHERE e.workspace_id=j.workspace_id
                  AND e.payload->'decision'->>'action'='render.submit'
                  AND e.payload->'decision'->'after'->>'jobId'=j.id
                ORDER BY e.seq DESC LIMIT 1) AS submit_payload
         FROM render_jobs j
        WHERE j.workspace_id=$1 AND j.status IN ('submitted','rendering') AND j.task_id IS NOT NULL
        ORDER BY j.created_at ASC
        LIMIT $2`,
      [scope.workspaceId, opts.limit ?? 20],
    );
    jobs = rows.rows;
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }

  const gw = await gateway.connect();
  for (const job of jobs) {
    report.checked += 1;
    const provider = resolveProvider(realPool, job, mockPool);
    if (!provider) {
      // C-04：供应商未配置也不能让作业永远悬停——超龄判 failed（有终态出口）
      if (renderJobTimedOut(job)) {
        await app.query(
          `UPDATE render_jobs SET status='failed', updated_at=now() WHERE id=$1 AND workspace_id=$2`,
          [job.id, scope.workspaceId],
        );
        report.failed += 1;
        report.details.push({ jobId: job.id, status: "failed", error: `供应商未配置且已超 ${RENDER_JOB_TIMEOUT_H}h（C-04 超时判死）` });
      } else {
        report.details.push({
          jobId: job.id,
          status: "skip",
          error: `供应商 ${job.submit_payload?.decision?.after?.provider ?? "seedance"} 未配置`,
        });
      }
      continue;
    }
    let result: { status: string; uri?: string; actualUnits?: number; error?: string };
    try {
      result = await provider.poll(job.task_id);
    } catch (err) {
      result = { status: "running", error: err instanceof Error ? err.message : String(err) };
    }
    // C-04：超龄任务无论 poll 返回什么都判 failed——poll 持续异常/供应商挂起不再永远悬停
    if (result.status === "running" && renderJobTimedOut(job)) {
      result = {
        status: "failed",
        error: `渲染超时判死（已超 ${RENDER_JOB_TIMEOUT_H}h；${result.error ?? "供应商持续无终态"}）`,
      };
    }

    if (result.status === "succeeded" || result.status === "failed") {
      const done = result.status === "succeeded";

      /* ---- ① 素材入库（T-2026-0921-0002 → T-2026-0926-0007 粒度修正）：
                下载 → sha256 → video_assets(kind=clip)（sha256 幂等去重）+ prompt/pipeline/时长/画幅 ---- */
      let ingested: { assetId: string; localPath: string; sha256: string; bytes: number } | null = null;
      let ingestError: string | null = null;
      if (done && result.uri && opts.ingest !== false) {
        try {
          const media = await downloadToMediaStore(result.uri, {
            workspaceId: scope.workspaceId,
            fetchImpl: opts.fetchImpl,
          });
          /**
           * 单镜 job 的产物是**镜头片段**（clip），不是成片（final_cut）。
           * 提示词从 render_scripts.md 冗余进素材（检索与复用匹配的唯一可用语料），
           * 管线类型取 video_projects.kind（双管线过滤口径）。
           */
          const scriptRow = await scopedQuery<{ md: string | null }>(app, scope,
            `SELECT md FROM render_scripts WHERE workspace_id=$1 AND id=$2`,
            [scope.workspaceId, job.script_id]);
          const projectRow = await scopedQuery<{ kind: string | null }>(app, scope,
            `SELECT kind FROM video_projects WHERE workspace_id=$1 AND id=$2`,
            [scope.workspaceId, job.project_id]);
          const reg = await registerRenderedClip(app, gateway, scope, {
            assetId: newId("VA"),
            kind: "clip",
            projectId: job.project_id,
            sha256: media.sha256,
            sourceUrl: result.uri,
            localRelPath: media.relPath,
            provider: provider.providerId,
            providerModel: job.provider_model ?? "",
            jobId: job.id,
            scriptId: job.script_id,
            seconds: result.actualUnits ?? null,
            title: `${job.project_id} · ${job.script_id}`,
            prompt: (scriptRow[0]?.md ?? "").slice(0, 4000) || null,
            /** 片型如实回填（T-2026-0926-0020；口径收在 pipelineKindOf，带单测） */
            pipelineKind: pipelineKindOf(projectRow[0]?.kind),
            aspectRatio: job.submit_payload?.decision?.after?.request?.aspectRatio ?? null,
            by: "render-poller",
          });
          ingested = { assetId: reg.assetId, localPath: media.relPath, sha256: media.sha256, bytes: media.bytes };
        } catch (err) {
          // 入库失败不推翻"生成成功"事实（产物仍在供应商侧 7 天）；失败原因进事件与报告，可重试
          ingestError = err instanceof Error ? err.message : String(err);
        }
      }

      /* ---- ② 实际成本（目录价 × 实际秒数；未核价 → 0 元入账并标 pricing=unknown） ---- */
      const catalogModel = job.submit_payload?.decision?.after?.provider
        ? findModelByProviderModel(provider.providerId, job.provider_model ?? "")
        : null;
      const actualUnits = result.actualUnits ?? null;
      let actualUsd: number | null = null;
      let actualCny: number | null = null;
      let pricingMode: "catalog" | "unknown" = "unknown";
      if (done && catalogModel?.pricing?.usd != null && actualUnits !== null) {
        actualUsd = Math.round(catalogModel.pricing.usd * actualUnits * 10000) / 10000;
        actualCny = Math.round(actualUsd * usdCnyRate() * 100) / 100;
        pricingMode = "catalog";
      }

      try {
        await gw.query("BEGIN");
        await gw.query("SELECT set_config('app.workspace_id', $1, true)", [scope.workspaceId]);
        await gw.query("SELECT set_config('app.tenant_id', $1, true)", [scope.tenantId]);
        await gw.query(
          `UPDATE render_jobs
              SET status=$3, result_url=$4, asset_id=COALESCE($5, asset_id),
                  actual_seconds=$6, actual_usd=$7, actual_cny=$8, updated_at=now()
            WHERE id=$1 AND workspace_id=$2`,
          [
            job.id, scope.workspaceId, done ? "done" : "failed", result.uri ?? null,
            ingested?.assetId ?? null, actualUnits, actualUsd, actualCny,
          ],
        );
        await gatewayAppendOnClient(gw, { ...scope, actor: { id: "render-poller", type: "system" } }, {
          who: { type: "system", id: "render-poller" },
          context: { tenant_id: scope.tenantId, workspace_id: scope.workspaceId, time: new Date().toISOString() },
          object: { type: "render_job", id: job.id },
          decision: {
            action: done ? "render.complete" : "render.failed",
            after: {
              task_id: job.task_id, provider: provider.providerId,
              /** C-01 修复：mock 产物必须可辨识——此前只能靠 task_id 前缀推断，事件面与真实成片同形 */
              mock: job.task_id.startsWith("mock-"),
              result_url: result.uri ?? null, error: result.error ?? null,
              actual_seconds: actualUnits,
              est_cny: job.est_cny === null ? null : Number(job.est_cny),
              actual_usd: actualUsd, actual_cny: actualCny, pricing: pricingMode,
              asset_id: ingested?.assetId ?? null,
              local_path: ingested?.localPath ?? null,
              /** 入库结果三态：ok / 失败原因 / 未尝试（mock 或已入库） */
              ingest: done
                ? (ingestError ? { ok: false, error: ingestError } : ingested ? { ok: true, bytes: ingested.bytes } : { ok: false, error: "无产物 URL 或入库已关闭" })
                : null,
            },
            basis: [done ? "轮询回填：渲染成功（异步任务制第二步）" : `轮询回填：渲染失败（${result.error ?? "未知原因"}；不静默）`],
          },
          rule_impact: [],
          /**
           * 2026-09-20 真机测试修复：渲染完成必须带**外部回执**（无回执不算完成）。
           * 成功=Seedance 返回的成片 URL（synced:true，可回溯到供应商对象）；失败=无回执并标原因。
           * C-01 修复：mock 任务（task_id 前缀 mock-）的"成功"是本地模拟，不得携带 synced:true 假回执——
           * 此前 mock 完成事件写 synced:true+verified_at，账本层面与真实外部回执无法区分（假交付）。
           */
          ...(done && result.uri && !job.task_id.startsWith("mock-")
            ? { receipt: { synced: true, snapshot_uri: result.uri, verified_at: new Date().toISOString() } }
            : done && result.uri
              ? { receipt: { synced: false, mode: "simulated", snapshot_uri: result.uri } }
              : { receipt: { synced: false } }),
        });
        await gw.query("COMMIT");
      } catch (err) {
        await gw.query("ROLLBACK").catch(() => undefined);
        throw err;
      }

      /* ---- ③ 成本入账（幂等键 render:<jobId>；失败不推翻已完成事实，但必须留痕） ---- */
      let costError: string | null = null;
      if (done) {
        try {
          await recordRenderCost(app, gateway, scope, {
            jobId: job.id,
            projectId: job.project_id,
            amountCny: actualCny ?? 0,
            usd: actualUsd,
            provider: provider.providerId,
            providerModel: job.provider_model ?? "",
            seconds: actualUnits,
            mock: job.task_id.startsWith("mock-"),
            by: "render-poller",
          });
        } catch (err) {
          costError = err instanceof Error ? err.message : String(err);
          console.error(`[render-poller] 成本入账失败 job=${job.id}：${costError}`);
        }
      }

      if (done) report.done += 1; else report.failed += 1;
      if (ingested) report.ingested += 1;

      /* ---- ④ 环节台账（T-2026-0926-0002）：每个 job 的终态迁移记一次 attempt（append-only） ---- */
      const archiveWriter = archiveFor(job.project_id);
      if (archiveWriter) {
        try {
          await logStageOutcome(archiveWriter.store, archiveWriter.ledger, {
            stageId: "renderPoll",
            status: done ? "done" : "failed",
            input: { jobId: job.id, taskId: job.task_id, provider: provider.providerId, scriptId: job.script_id },
            output: {
              jobId: job.id,
              taskId: job.task_id,
              assetId: ingested?.assetId ?? null,
              provider: provider.providerId,
              providerModel: job.provider_model ?? null,
              actualSeconds: actualUnits,
              actualCny: actualCny,
              pricing: pricingMode,
              resultUrl: result.uri ?? null,
              ingest: done ? (ingestError ? { ok: false, error: ingestError } : { ok: Boolean(ingested) }) : null,
            },
            errorClass: done ? null : classifyProviderError(result.error ?? "provider failed"),
            errorMsg: done ? null : (result.error ?? "供应商返回 failed（无原因文本）"),
            cost: { cashCny: actualCny },
            runId: null,
          });
        } catch (err) {
          console.error(`[render-poller] 档案记账失败（不影响回填）job=${job.id}：${(err as Error).message}`);
        }
      }

      report.details.push({
        jobId: job.id, status: done ? "done" : "failed", uri: result.uri,
        error: result.error, assetId: ingested?.assetId,
        ingestError: ingestError ?? undefined, costError: costError ?? undefined,
      });
    } else {
      // 仍在生成：状态推进 rendering（幂等）
      await app.query(
        `UPDATE render_jobs SET status='rendering' WHERE id=$1 AND workspace_id=$2 AND status='submitted'`,
        [job.id, scope.workspaceId],
      );
      /**
       * 进度心跳（T-2026-0926-0002，规格书 §6.2 改动 B）：
       * "慢" 与 "死" 必须可区分——in-flight 只写档案事件（带 jobId/taskId），不开新 attempt，
       * 避免每拍轮询都污染台账（台账只记终态迁移）。
       */
      const heartbeatArchive = archiveFor(job.project_id);
      if (heartbeatArchive) {
        try {
          await heartbeatArchive.store.appendJsonl("events.jsonl", {
            kind: "stage.heartbeat",
            stageId: "renderPoll",
            jobId: job.id,
            taskId: job.task_id,
            provider: provider.providerId,
            status: "rendering",
          });
        } catch (err) {
          console.error(`[render-poller] 档案心跳写入失败（不影响回填）job=${job.id}：${(err as Error).message}`);
        }
      }
      report.running += 1;
      report.details.push({ jobId: job.id, status: "running" });
    }
  }
  gw.release();
  return report;
}
