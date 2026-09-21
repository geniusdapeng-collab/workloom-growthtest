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
import { downloadToMediaStore, registerFinalCut } from "./gen/ingest.js";
import { findModelByProviderModel } from "./gen/catalog.js";
import { recordRenderCost, usdCnyRate } from "./gen/cost.js";

interface Scope { tenantId: string; workspaceId: string }

interface OpenJob {
  id: string;
  task_id: string;
  script_id: string;
  project_id: string;
  provider: string | null;
  provider_model: string | null;
  est_cny: string | null;
  est_usd: string | null;
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
  if (job.task_id.startsWith("mock-")) {
    return mockPool.get(job.provider ?? "seedance") ?? mockPool.get("seedance") ?? null;
  }
  return pool.get(job.provider ?? "seedance") ?? null;
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

  const client = await app.connect();
  let jobs: OpenJob[];
  try {
    // 事务级 RLS 上下文必须在显式事务内设置（编码铁律）
    await client.query("BEGIN");
    await client.query("SELECT set_config('app.workspace_id', $1, true)", [scope.workspaceId]);
    await client.query("SELECT set_config('app.tenant_id', $1, true)", [scope.tenantId]);
    // 开放任务 + 提交事件留痕的供应商（event 回放取 provider，无留痕回退推断）
    const rows = await client.query<OpenJob>(
      `SELECT j.id, j.task_id, j.script_id, j.project_id, j.provider_model, j.est_cny, j.est_usd,
              (SELECT e.payload->'decision'->'after'->>'provider'
                 FROM biz_events e
                WHERE e.workspace_id=j.workspace_id
                  AND e.payload->'decision'->>'action'='render.submit'
                  AND e.payload->'decision'->'after'->>'jobId'=j.id
                ORDER BY e.seq DESC LIMIT 1) AS provider
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
      report.details.push({ jobId: job.id, status: "skip", error: `供应商 ${job.provider ?? "seedance"} 未配置` });
      continue;
    }
    let result: { status: string; uri?: string; actualUnits?: number; error?: string };
    try {
      result = await provider.poll(job.task_id);
    } catch (err) {
      result = { status: "running", error: err instanceof Error ? err.message : String(err) };
    }

    if (result.status === "succeeded" || result.status === "failed") {
      const done = result.status === "succeeded";

      /* ---- ① 成片入库（T-2026-0921-0002）：下载 → sha256 → video_assets（sha256 幂等去重） ---- */
      let ingested: { assetId: string; localPath: string; sha256: string; bytes: number } | null = null;
      let ingestError: string | null = null;
      if (done && result.uri && opts.ingest !== false) {
        try {
          const media = await downloadToMediaStore(result.uri, {
            workspaceId: scope.workspaceId,
            fetchImpl: opts.fetchImpl,
          });
          const reg = await registerFinalCut(app, gateway, scope, {
            assetId: newId("VA"),
            projectId: job.project_id,
            sha256: media.sha256,
            sourceUrl: result.uri,
            localRelPath: media.relPath,
            provider: provider.providerId,
            providerModel: job.provider_model ?? "",
            jobId: job.id,
            scriptId: job.script_id,
            seconds: result.actualUnits ?? null,
            by: "render-poller",
          });
          ingested = { assetId: reg.assetId, localPath: media.relPath, sha256: media.sha256, bytes: media.bytes };
        } catch (err) {
          // 入库失败不推翻"生成成功"事实（产物仍在供应商侧 7 天）；失败原因进事件与报告，可重试
          ingestError = err instanceof Error ? err.message : String(err);
        }
      }

      /* ---- ② 实际成本（目录价 × 实际秒数；未核价 → 0 元入账并标 pricing=unknown） ---- */
      const catalogModel = job.provider
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
           */
          ...(done && result.uri
            ? { receipt: { synced: true, snapshot_uri: result.uri, verified_at: new Date().toISOString() } }
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
      report.running += 1;
      report.details.push({ jobId: job.id, status: "running" });
    }
  }
  gw.release();
  return report;
}
