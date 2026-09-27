/**
 * video/archive-resume.ts —— 恢复编排：断点推导 + 单执行者仲裁 + 复用既有补跑入口（T-2026-0926-0002）
 *
 * 设计（规格书 §6.4，含实施期修正）：
 *   ① 断点推导按**每个 stage 的最新 attempt** 判定，而不是"最早的一条 failed 行"——
 *      否则一次打回后的成功重跑仍会被判成失败断点（假断点）。
 *   ② 单执行者靠两把锁：resume 决策用 `pg_try_advisory_xact_lock`（事务级），
 *      真正的执行者租约在 `startRun` 内（会话级，见 archive-host.ts）。
 *      resume 事务内先试抢 run 锁，抢不到直接返回 busy，不重复烧额度。
 *   ③ pending approvals 按**本项目**过滤（规格书原文的 `approval_id IN (SELECT … status='pending')`
 *      是恒真子查询，会把别的项目的待审批误判成本项目断点）；这里 join biz_events 按
 *      `object.id = projectId` 或 `projectId:<gate>` 精确匹配。
 *   ④ 默认**不自动拉起**：启动扫描只把死进程留下的 `running` 台账归位为 interrupted 并留 finding，
 *      恢复动作交人工 `video.studio.resume`（规格书 §6.3 改动 C）。
 */
import path from "node:path";
import { newId } from "@workloom/shared";
import { getAppPool, getOwnerPool } from "@workloom/db";
import { ArchiveStore, readContextBundle, type ContextBundle } from "@hyperreality/video-studio";
import { scopedRows, archiveWorkDir, projectRunLockKey } from "./archive-host.js";

interface Scope {
  tenantId: string;
  workspaceId: string;
}

/** 台账里"仍然是断点"的状态（done/skipped 不算） */
const OPEN_STATUSES = ["running", "failed", "interrupted"] as const;

export interface StageBreakpoint {
  stageId: string;
  attempt: number;
  status: string;
  errorClass: string | null;
  startedAt: string;
}

export interface ResumeOptions {
  projectId: string;
  /** 人工裁决：强制从指定环节重跑 */
  fromStage?: string;
  /** 预生产续跑需要（缺省读 video_projects.title） */
  intent?: string;
  /** 复用既有补跑入口（router 传 `startRun(scope, …)`） */
  startRun: (input: {
    projectId: string;
    intent: string;
    isMarketing: boolean;
    metadata?: Record<string, unknown>;
  }) => string | Promise<string>;
  actor: { id: string; type: "human" | "system" };
}

export type ResumeResult =
  | { kind: "busy"; stage: null; message: string }
  | { kind: "awaiting_approval"; approvalId: string; stage: string; message: string }
  | { kind: "resumed"; stage: "preproduction"; runId: string; attempt: number | null; message: string }
  | { kind: "noaction"; stage: string; message: string };

/** 最新 attempt 的断点（每个 stage 只看最新一次；假断点会被 stage2 的成功重跑覆盖） */
export async function readStageBreakpoints(scope: Scope, projectId: string): Promise<StageBreakpoint[]> {
  return scopedRows<StageBreakpoint>(
    scope,
    `SELECT stage_id AS "stageId", attempt, status, error_class AS "errorClass", started_at AS "startedAt" FROM (
       SELECT stage_id, attempt, status, error_class, started_at,
              row_number() OVER (PARTITION BY stage_id ORDER BY attempt DESC) AS rn,
              min(started_at) OVER (PARTITION BY stage_id) AS first_at
         FROM production_stage_runs
        WHERE workspace_id=$1 AND project_id=$2
     ) latest
      WHERE rn=1 AND status = ANY($3::text[])
      ORDER BY first_at ASC, stage_id ASC`,
    [scope.workspaceId, projectId, [...OPEN_STATUSES]],
  );
}

/**
 * 本项目待审批门（精确到项目）：
 * 审批对象的 object.id 口径见 studio-worker.ts#gateObjectOf —— G7 用 projectId，
 * 其余门用 `${projectId}:${gate.toLowerCase()}`。
 */
async function findPendingApproval(scope: Scope, projectId: string): Promise<string | null> {
  const rows = await scopedRows<{ approval_id: string }>(
    scope,
    `SELECT a.approval_id
       FROM approvals a
       JOIN biz_events e ON e.event_id = a.event_id AND e.workspace_id = a.workspace_id
      WHERE a.workspace_id = $1
        AND a.status = 'pending'
        AND (e.payload->'object'->>'id' = $2 OR e.payload->'object'->>'id' LIKE $2 || ':%')
      ORDER BY a.created_at DESC
      LIMIT 1`,
    [scope.workspaceId, projectId],
  );
  return rows[0]?.approval_id ?? null;
}

/**
 * 恢复编排主体。锁口径：同一事务内先抢 resume 锁与 run 锁（都是 xact 锁，提交即释放），
 * 抢不到 run 锁 = 已有执行者在跑 → busy（不启动第二次，不重复烧额度）。
 */
export async function resumeProject(
  scope: Scope,
  opts: ResumeOptions,
): Promise<ResumeResult> {
  const app = getAppPool();
  const client = await app.connect();
  let interruptedRows = 0;
  let breakpoints: StageBreakpoint[] = [];
  let pendingApprovalId: string | null = null;
  let discard = false;
  try {
    await client.query("BEGIN");
    await client.query("SELECT set_config('app.workspace_id', $1, true)", [scope.workspaceId]);
    await client.query("SELECT set_config('app.tenant_id', $1, true)", [scope.tenantId]);

    const resumeLock = await client.query<{ ok: boolean }>(
      "SELECT pg_try_advisory_xact_lock(hashtext($1)) AS ok",
      [JSON.stringify(["archive-resume", scope.tenantId, scope.workspaceId, opts.projectId])],
    );
    if (resumeLock.rows[0]?.ok !== true && resumeLock.rows[0]?.ok !== false) throw new Error("RESUME_LOCK_RECEIPT_INVALID");
    if (resumeLock.rows[0].ok === false) {
      await client.query("ROLLBACK");
      return { kind: "busy", stage: null, message: `项目 ${opts.projectId} 已有恢复动作在执行（resume 锁未抢到）` };
    }
    const runLock = await client.query<{ ok: boolean }>(
      "SELECT pg_try_advisory_xact_lock(hashtext($1)) AS ok",
      [projectRunLockKey(scope, opts.projectId)],
    );
    if (runLock.rows[0]?.ok !== true && runLock.rows[0]?.ok !== false) throw new Error("PROJECT_LEASE_RECEIPT_INVALID");
    if (runLock.rows[0].ok === false) {
      await client.query("ROLLBACK");
      return {
        kind: "busy",
        stage: null,
        message: `项目 ${opts.projectId} 已有执行者持有运行租约（不重复启动，避免双份烧额度）`,
      };
    }

    /* 旧账归位：进程已死，状态不能继续撒谎 */
    const interrupted = await client.query(
      `UPDATE production_stage_runs SET status='interrupted', finished_at=now()
        WHERE workspace_id=$1 AND project_id=$2 AND status='running' RETURNING id`,
      [scope.workspaceId, opts.projectId],
    );
    interruptedRows = interrupted.rowCount ?? 0;

    const pending = await client.query<{ approval_id: string }>(
      `SELECT a.approval_id
         FROM approvals a
         JOIN biz_events e ON e.event_id = a.event_id AND e.workspace_id = a.workspace_id
        WHERE a.workspace_id = $1
          AND a.status = 'pending'
          AND (e.payload->'object'->>'id' = $2 OR e.payload->'object'->>'id' LIKE $2 || ':%')
        ORDER BY a.created_at DESC
        LIMIT 1`,
      [scope.workspaceId, opts.projectId],
    );
    pendingApprovalId = pending.rows[0]?.approval_id ?? null;

    await client.query("COMMIT");
  } catch (err) {
    try {
      await client.query("ROLLBACK");
    } catch (rollbackError) {
      discard = true;
      throw new AggregateError([err, rollbackError], "archive-resume-rollback-failed");
    }
    throw err;
  } finally {
    client.release(discard);
  }

  // 断点在事务提交后按同一口径重读（列别名与 readStageBreakpoints 保持一致，避免驼峰/蛇形漂移）
  breakpoints = await readStageBreakpoints(scope, opts.projectId);
  const stuckStage = opts.fromStage ?? breakpoints[0]?.stageId ?? "preproduction";
  const archive = new ArchiveStore(archiveWorkDir(), scope.workspaceId, opts.projectId);
  for (const stage of breakpoints) {
    // PG 完成写与失败补写可能同时不可用；本地 meta/output 仍是待对账证据。
    const meta = await archive.readJson<{ errorClass?: string }>(`stages/${stage.stageId}/attempt-${stage.attempt}.meta.json`);
    const pendingOutput = stage.status === "interrupted"
      ? await archive.readJson<unknown>(`stages/${stage.stageId}/attempt-${stage.attempt}.output.json`)
      : null;
    if (stage.errorClass === "RECEIPT_UNVERIFIED" || meta?.errorClass === "RECEIPT_UNVERIFIED" || pendingOutput !== null) {
      return {
        kind: "noaction", stage: stage.stageId,
        message: `阶段 ${stage.stageId} attempt=${stage.attempt} 的完成回执待核实；先对账已有产物与台账，禁止在未知外部结果下重跑。`,
      };
    }
  }

  /**
   * 审批等待中断保护分支：有 pending approval 就接续审批轮询，不重跑。
   * 为什么：resume 重跑会产生新 event，而 approvals 的幂等键是 (event_id, channel)，
   * 挡不住"新事件 → 第二张 approvals 行"，会同时出现两张待批单。
   */
  if (pendingApprovalId && !opts.fromStage) {
    return {
      kind: "awaiting_approval",
      approvalId: pendingApprovalId,
      stage: stuckStage,
      message: "存在本项目待审批门：走审批中心接续（批准/修改/驳回），不需要重跑管线",
    };
  }

  if (breakpoints.length === 0 && !opts.fromStage) {
    return { kind: "noaction", stage: stuckStage, message: "没有待恢复的阶段；已有完成回执的项目不会通过恢复入口重新执行。" };
  }

  if (stuckStage === "preproduction") {
    const project = (
      await scopedRows<{ title: string | null; kind: string | null }>(
        scope,
        `SELECT title, kind FROM video_projects WHERE id=$1 AND workspace_id=$2`,
        [opts.projectId, scope.workspaceId],
      )
    )[0];
    if (!project) {
      return { kind: "noaction", stage: stuckStage, message: `项目 ${opts.projectId} 不存在或不属于当前工作区` };
    }
    const runId = await opts.startRun({
      projectId: opts.projectId,
      intent: opts.intent ?? project.title ?? "",
      isMarketing: project.kind === "marketing",
    });
    const attempt = breakpoints[0]?.attempt ?? null;
    return {
      kind: "resumed",
      stage: "preproduction",
      runId,
      attempt,
      message:
        `预生产断点（attempt=${attempt ?? "-"}，状态=${breakpoints[0]?.status ?? "无记录"}）→ 走既有补跑入口续跑。`
        + `注意：vendor Phase checkpoint 仅在 blueprint 指纹一致时命中（真实模型下常不一致 → 全量重跑，重复计费风险）；`
        + `本轮开跑前已把 checkpoint 快照进档案（checkpoints/attempt-<n>-before/），跑完看输出里的 resumed 标记。`
        + (interruptedRows > 0 ? `已把 ${interruptedRows} 条 running 台账归位为 interrupted。` : ""),
    };
  }

  // 渲染/后期/交付段：poller 与 delivery 都从 PG 恢复，server 运行即自动接续
  return {
    kind: "noaction",
    stage: stuckStage,
    message: `断点在「${stuckStage}」段：该段由轮询/台账驱动，server 运行即自动接续；明细见 video.studio.archive`,
  };
}

export interface ArchiveSummary {
  projectId: string;
  archiveRoot: string;
  archiveExists: boolean;
  manifest: unknown;
  contextBundle: ContextBundle | null;
  stages: Array<{
    stageId: string;
    attempt: number;
    status: string;
    errorClass: string | null;
    errorMsg: string | null;
    outputRef: string | null;
    outputSha256: string | null;
    durationMs: number | null;
    cost: unknown;
    runId: string | null;
    startedAt: string;
    finishedAt: string | null;
    lastHeartbeatAt: string | null;
  }>;
  breakpoints: StageBreakpoint[];
  pendingApprovalId: string | null;
  recentEvents: Array<Record<string, unknown>>;
  findings: Array<Record<string, unknown>>;
}

/** 档案只读视图（任务详情页「制片档案」标签数据源）：文件本体 + PG 索引合并返回 */
export async function readArchiveSummary(scope: Scope, projectId: string): Promise<ArchiveSummary> {
  const store = new ArchiveStore(archiveWorkDir(), scope.workspaceId, projectId);
  const manifest = await store.readManifest();
  const contextBundle = await readContextBundle(store);
  const recentEvents = await store.readEvents(20);

  const stages = await scopedRows<{
    stage_id: string; attempt: number; status: string; error_class: string | null; error_msg: string | null;
    output_ref: string | null; output_sha256: string | null; duration_ms: number | null; cost: unknown;
    run_id: string | null; started_at: string; finished_at: string | null; last_heartbeat_at: string | null;
  }>(
    scope,
    `SELECT stage_id, attempt, status, error_class, error_msg, output_ref, output_sha256,
            duration_ms, cost, run_id, started_at, finished_at, last_heartbeat_at
       FROM production_stage_runs
      WHERE workspace_id=$1 AND project_id=$2
      ORDER BY started_at ASC, attempt ASC`,
    [scope.workspaceId, projectId],
  );
  const findings = await scopedRows<Record<string, unknown>>(
    scope,
    `SELECT id, category, severity, source, stage_id, title, evidence, status, task_ref, fix_ref, dedupe_key, created_at
       FROM engineering_findings
      WHERE workspace_id=$1 AND project_id=$2
      ORDER BY created_at DESC LIMIT 20`,
    [scope.workspaceId, projectId],
  );

  return {
    projectId,
    archiveRoot: store.root,
    archiveExists: manifest !== null,
    manifest,
    contextBundle,
    stages: stages.map((row) => ({
      stageId: row.stage_id,
      attempt: Number(row.attempt),
      status: row.status,
      errorClass: row.error_class,
      errorMsg: row.error_msg,
      outputRef: row.output_ref,
      outputSha256: row.output_sha256,
      durationMs: row.duration_ms === null ? null : Number(row.duration_ms),
      cost: row.cost,
      runId: row.run_id,
      startedAt: String(row.started_at),
      finishedAt: row.finished_at === null ? null : String(row.finished_at),
      lastHeartbeatAt: row.last_heartbeat_at === null ? null : String(row.last_heartbeat_at),
    })),
    breakpoints: await readStageBreakpoints(scope, projectId),
    pendingApprovalId: await findPendingApproval(scope, projectId),
    recentEvents,
    findings,
  };
}

export interface StartupScanReport {
  enabled: boolean;
  staleAfterMinutes: number;
  interrupted: Array<{ workspaceId: string; projectId: string; stageId: string; attempt: number; startedAt: string }>;
  findingsWritten: number;
}

/**
 * server 启动扫描（`ARCHIVE_AUTO_RESUME=1`）：
 * 把"进程已死但台账还在 running"的行归位为 interrupted，并留一张工程发现。
 * **不自动拉起管线**（规格书口径）：自动重跑会在人不知情时重复烧额度。
 *
 * 跨租户巡检的例外点：RLS 下无法一次查询所有工作区的 stale 行，
 * 这里用 owner 池**只做工作区枚举**（与登录引导同为显式例外），
 * 实际的归位与 finding 写入都回到 app 池 + 逐工作区 set_config（受 RLS 约束）。
 */
export async function scanStaleRunsOnStartup(env: NodeJS.ProcessEnv = process.env): Promise<StartupScanReport> {
  const enabled = (env.ARCHIVE_AUTO_RESUME ?? "0") === "1";
  const staleAfterMinutes = Math.max(1, Number(env.ARCHIVE_STALE_RUNNING_MIN ?? 10) || 10);
  const report: StartupScanReport = { enabled, staleAfterMinutes, interrupted: [], findingsWritten: 0 };
  if (!enabled) return report;

  const stale = await getOwnerPool().query<{
    workspace_id: string; tenant_id: string; project_id: string; stage_id: string; attempt: number; started_at: string;
  }>(
    `SELECT r.workspace_id, w.tenant_id, r.project_id, r.stage_id, r.attempt, r.started_at
       FROM production_stage_runs r
       JOIN workspaces w ON w.id = r.workspace_id
      WHERE r.status='running' AND COALESCE(r.last_heartbeat_at, r.started_at) < now() - ($1 || ' minutes')::interval
      ORDER BY r.started_at ASC
      LIMIT 100`,
    [String(staleAfterMinutes)],
  );
  if (stale.rows.length === 0) return report;

  const byWorkspace = new Map<string, { tenantId: string; rows: typeof stale.rows }>();
  for (const row of stale.rows) {
    const entry = byWorkspace.get(row.workspace_id) ?? { tenantId: row.tenant_id, rows: [] };
    entry.rows.push(row);
    byWorkspace.set(row.workspace_id, entry);
  }

  for (const [workspaceId, entry] of byWorkspace) {
    for (const row of entry.rows) {
      try {
        const client = await getAppPool().connect();
        let discard = false;
        try {
          await client.query("BEGIN");
          await client.query("SELECT set_config('app.workspace_id', $1, true)", [workspaceId]);
          await client.query("SELECT set_config('app.tenant_id', $1, true)", [entry.tenantId]);
          const runLock = await client.query<{ ok: boolean }>(
            "SELECT pg_try_advisory_xact_lock(hashtext($1)) AS ok",
            [projectRunLockKey({ tenantId: entry.tenantId, workspaceId }, row.project_id)],
          );
          if (runLock.rows[0]?.ok === false) {
            await client.query("ROLLBACK");
            continue;
          }
          if (runLock.rows[0]?.ok !== true) throw new Error("PROJECT_LEASE_RECEIPT_INVALID");
          const updated = await client.query(
            `UPDATE production_stage_runs SET status='interrupted', finished_at=now()
              WHERE workspace_id=$1 AND project_id=$2 AND stage_id=$3 AND attempt=$4 AND status='running'
                AND COALESCE(last_heartbeat_at, started_at) < now() - ($5 || ' minutes')::interval
              RETURNING id`,
            [workspaceId, row.project_id, row.stage_id, row.attempt, String(staleAfterMinutes)],
          );
          if ((updated.rowCount ?? 0) > 0) {
            const dedupeKey = JSON.stringify(["restart_leftover", row.project_id, row.stage_id, Number(row.attempt)]);
            await client.query(
              `INSERT INTO engineering_findings
                 (id, workspace_id, category, severity, source, project_id, stage_id, title, evidence, dedupe_key)
               VALUES ($1,$2,'bug','P1','runtime_log',$3,$4,$5,$6::jsonb,$7)
               ON CONFLICT (workspace_id, dedupe_key) DO UPDATE
                 SET evidence = jsonb_set(
                       engineering_findings.evidence, '{occurrences}',
                       to_jsonb(COALESCE((engineering_findings.evidence->>'occurrences')::int, 1) + 1)),
                     resolved_at = NULL
               RETURNING id`,
              [
                newId("EF"), workspaceId, row.project_id, row.stage_id,
                `重启遗留：${row.project_id}/${row.stage_id} 台账停在 running（进程死亡未收尾）`,
                JSON.stringify({
                  archiveRoot: path.join(archiveWorkDir(), "archive", workspaceId, row.project_id),
                  stageId: row.stage_id,
                  attempt: row.attempt,
                  startedAt: String(row.started_at),
                  occurrences: 1,
                  source: "server_startup_scan",
                }),
                dedupeKey,
              ],
            );
          }
          await client.query("COMMIT");
          if ((updated.rowCount ?? 0) > 0) {
            report.findingsWritten += 1;
            report.interrupted.push({
              workspaceId, projectId: row.project_id, stageId: row.stage_id,
              attempt: Number(row.attempt), startedAt: String(row.started_at),
            });
          }
        } catch (err) {
          try {
            await client.query("ROLLBACK");
          } catch (rollbackError) {
            discard = true;
            throw new AggregateError([err, rollbackError], "archive-scan-rollback-failed");
          }
          throw err;
        } finally {
          client.release(discard);
        }
      } catch (err) {
        console.error(
          `[archive] 启动扫描归位失败 ${row.project_id}/${row.stage_id}: ${(err as Error).message}`,
        );
      }
    }
  }
  return report;
}
