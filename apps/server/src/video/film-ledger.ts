/**
 * video/film-ledger.ts —— 固定影片工位的作业与组件台账（T-2026-0927-0039）。
 *
 * 三条不变量：
 *   ① 工位代码摘要不可换绑：改代码必须新增登记行；同一工位名同时只允许一份 active。
 *   ② 作业输入由服务冻结：attempt 递增、输入引用与摘要写死在行上，工位不得换绑。
 *   ③ 先留账后外呼：组件调用先 `reserve`（含费用预占），认领（dispatched）只有一次机会，
 *      accepted/failed/unknown 终态回执不可覆盖；unknown 不自动重发，必须对账。
 *
 * 与 `gen/submission-ledger.ts` 同纪律：RLS 作用域事务、网络调用不在事务内、状态 CAS 带 owner。
 */
import { createHash } from "node:crypto";
import type pg from "pg";
import type { AppPool, Scope } from "./gen/db.js";
import { SubmissionError } from "./gen/submission-ledger.js";

export type FilmComponentKind = "llm" | "image" | "video" | "media" | "voice" | "review";
export type FilmComponentState = "reserved" | "dispatched" | "accepted" | "failed" | "unknown";
export type FilmJobState = "running" | "finished" | "failed" | "interrupted";

export interface FilmWorkerRow extends pg.QueryResultRow {
  id: string;
  tenant_id: string;
  workspace_id: string;
  worker_name: string;
  worker_version: string;
  entry_path: string;
  entry_sha256: string;
  capabilities: string[];
  status: "active" | "disabled";
  registered_by: string;
  registered_at: Date | string;
  updated_at: Date | string;
}

export interface FilmJobRow extends pg.QueryResultRow {
  id: string;
  seq: string;
  tenant_id: string;
  workspace_id: string;
  project_id: string;
  worker_id: string;
  attempt: number;
  run_id: string;
  status: FilmJobState;
  stages: string[];
  options: Record<string, unknown>;
  budget_cny: string | number;
  input_ref: string;
  input_sha256: string;
  worker_entry_sha256: string;
  started_at: Date | string;
  finished_at: Date | string | null;
  error_class: string | null;
  error_msg: string | null;
  result_ref: string | null;
  result_sha256: string | null;
  created_by: string;
}

export interface FilmComponentRow extends pg.QueryResultRow {
  id: string;
  seq: number;
  tenant_id: string;
  workspace_id: string;
  project_id: string;
  job_id: string;
  component: FilmComponentKind;
  step_key: string;
  shot_id: string | null;
  idempotency_key: string;
  request_hash: string;
  payload_hash: string;
  state: FilmComponentState;
  owner_token: string | null;
  provider: string | null;
  provider_model: string | null;
  reserved_cny: string | number;
  actual_cny: string | number | null;
  dispatch_count: number;
  evidence: Record<string, unknown>;
  created_at: Date | string;
  updated_at: Date | string;
}

export interface FilmComponentSummary {
  component: FilmComponentKind;
  stepKey: string;
  shotId: string | null;
  state: FilmComponentState;
  reservedCny: number;
  actualCny: number | null;
  updatedAt: string;
}

export interface FilmJobStatusView {
  jobId: string;
  projectId: string;
  attempt: number;
  runId: string;
  workerName: string;
  status: FilmJobState;
  stages: string[];
  startedAt: string;
  finishedAt: string | null;
  errorClass: string | null;
  errorMessage: string | null;
  resultRef: string | null;
  resultSha256: string | null;
  components: FilmComponentSummary[];
  reservedCny: number;
  spentCny: number;
}

/** 工位登记主键：由作用域 + 工位名 + 代码摘要派生（改代码 → 新修订 → 新 id）。 */
export function filmWorkerId(input: { tenantId: string; workspaceId: string; workerName: string; entrySha256: string }): string {
  return `FW-${createHash("sha256")
    .update(`${input.tenantId}\u0000${input.workspaceId}\u0000${input.workerName}\u0000${input.entrySha256}`)
    .digest("hex")
    .slice(0, 24)}`;
}

function fail(code: string, message: string): never {
  throw new SubmissionError(code, message);
}

function iso(value: Date | string): string {
  const parsed = value instanceof Date ? value : new Date(value);
  return Number.isNaN(parsed.getTime()) ? String(value) : parsed.toISOString();
}

function money(value: string | number | null): number | null {
  if (value === null) return null;
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

export class FilmLedger {
  constructor(private readonly app: AppPool, private readonly scope: Scope) {}

  private async transaction<T>(fn: (client: pg.PoolClient) => Promise<T>): Promise<T> {
    const client = await this.app.connect();
    let discard = false;
    try {
      await client.query("BEGIN");
      await client.query("SELECT set_config('app.workspace_id', $1, true)", [this.scope.workspaceId]);
      await client.query("SELECT set_config('app.tenant_id', $1, true)", [this.scope.tenantId]);
      const result = await fn(client);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      try {
        await client.query("ROLLBACK");
      } catch (rollbackError) {
        discard = true;
        throw new AggregateError([error, rollbackError], "film-ledger-rollback-failed");
      }
      throw error;
    } finally {
      client.release(discard);
    }
  }

  /** 登记（或复用）固定工位代码修订；同名不同摘要会停用旧修订后启用新修订。 */
  async registerWorker(input: {
    workerName: string;
    workerVersion: string;
    entryPath: string;
    entrySha256: string;
    capabilities: FilmComponentKind[];
    actor: string;
  }): Promise<FilmWorkerRow> {
    if (!input.workerName.trim() || !input.workerVersion.trim()) fail("FILM_WORKER_INVALID", "工位名与版本必填");
    if (!/^[a-f0-9]{64}$/.test(input.entrySha256)) fail("FILM_WORKER_INVALID", "工位代码摘要非法");
    if (input.entryPath.startsWith("/") || input.entryPath.split(/[\\/]/).some((part) => part === ".." || part === ".")) {
      fail("FILM_WORKER_INVALID", "工位入口必须是仓库内相对路径");
    }
    if (!Array.isArray(input.capabilities) || input.capabilities.length === 0) fail("FILM_WORKER_INVALID", "工位能力清单不得为空");
    const id = filmWorkerId({ ...this.scope, workerName: input.workerName, entrySha256: input.entrySha256 });
    return this.transaction(async (client) => {
      await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [
        JSON.stringify(["film-worker", this.scope.tenantId, this.scope.workspaceId, input.workerName]),
      ]);
      // 同一工位名同时只允许一份 active（幂等回滚/改代码都先停用别的修订，避免撞部分唯一索引）。
      await client.query(
        `UPDATE film_workers SET status='disabled', updated_at=now()
          WHERE tenant_id=$1 AND workspace_id=$2 AND worker_name=$3 AND status='active' AND entry_sha256<>$4`,
        [this.scope.tenantId, this.scope.workspaceId, input.workerName, input.entrySha256],
      );
      const existing = await client.query<FilmWorkerRow>(
        `SELECT * FROM film_workers WHERE tenant_id=$1 AND workspace_id=$2 AND worker_name=$3 AND entry_sha256=$4`,
        [this.scope.tenantId, this.scope.workspaceId, input.workerName, input.entrySha256],
      );
      if (existing.rows[0]) {
        const row = existing.rows[0];
        if (row.status === "active") return row;
        const revived = await client.query<FilmWorkerRow>(
          `UPDATE film_workers SET status='active', updated_at=now() WHERE id=$1 AND status='disabled' RETURNING *`,
          [row.id],
        );
        if (!revived.rows[0]) fail("FILM_WORKER_STATE_CONFLICT", "工位登记状态已变化，拒绝静默启用");
        return revived.rows[0];
      }
      const created = await client.query<FilmWorkerRow>(
        `INSERT INTO film_workers
           (id, tenant_id, workspace_id, worker_name, worker_version, entry_path, entry_sha256, capabilities, status, registered_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,'active',$9)
         RETURNING *`,
        [id, this.scope.tenantId, this.scope.workspaceId, input.workerName, input.workerVersion,
          input.entryPath, input.entrySha256, JSON.stringify(input.capabilities), input.actor],
      );
      const row = created.rows[0];
      if (!row) fail("FILM_WORKER_INVALID", "工位登记未返回行");
      return row;
    });
  }

  async activeWorker(workerName: string): Promise<FilmWorkerRow | null> {
    return this.transaction(async (client) => {
      const result = await client.query<FilmWorkerRow>(
        `SELECT * FROM film_workers WHERE tenant_id=$1 AND workspace_id=$2 AND worker_name=$3 AND status='active'`,
        [this.scope.tenantId, this.scope.workspaceId, workerName],
      );
      return result.rows[0] ?? null;
    });
  }

  async workerById(id: string): Promise<FilmWorkerRow | null> {
    return this.transaction(async (client) => {
      const result = await client.query<FilmWorkerRow>(
        `SELECT * FROM film_workers WHERE tenant_id=$1 AND workspace_id=$2 AND id=$3`,
        [this.scope.tenantId, this.scope.workspaceId, id],
      );
      return result.rows[0] ?? null;
    });
  }

  /** 认领一次作业：同项目 attempt 递增，输入/摘要/预算写死在行上。 */
  async claimJob(input: {
    projectId: string;
    workerId: string;
    runId: string;
    stages: string[];
    options: Record<string, unknown>;
    budgetCny: number;
    inputRef: string;
    inputSha256: string;
    workerEntrySha256: string;
    actor: string;
  }): Promise<FilmJobRow> {
    if (!/^[a-f0-9]{64}$/.test(input.inputSha256) || !/^[a-f0-9]{64}$/.test(input.workerEntrySha256)) {
      fail("FILM_JOB_INVALID", "作业输入或工位摘要非法");
    }
    if (!Number.isFinite(input.budgetCny) || input.budgetCny < 0) fail("FILM_JOB_INVALID", "作业预算非法");
    return this.transaction(async (client) => {
      await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [
        JSON.stringify(["film-job", this.scope.tenantId, this.scope.workspaceId, input.projectId]),
      ]);
      const attempt = await client.query<{ n: number }>(
        `SELECT COALESCE(MAX(attempt),0)+1 AS n FROM film_jobs WHERE tenant_id=$1 AND workspace_id=$2 AND project_id=$3`,
        [this.scope.tenantId, this.scope.workspaceId, input.projectId],
      );
      const created = await client.query<FilmJobRow>(
        `INSERT INTO film_jobs
           (id, tenant_id, workspace_id, project_id, worker_id, attempt, run_id, status, stages, options, budget_cny,
            input_ref, input_sha256, worker_entry_sha256, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,'running',$8::jsonb,$9::jsonb,$10,$11,$12,$13,$14)
         RETURNING *`,
        [`FJ-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`,
          this.scope.tenantId, this.scope.workspaceId, input.projectId, input.workerId,
          Number(attempt.rows[0]?.n ?? 1), input.runId, JSON.stringify(input.stages), JSON.stringify(input.options),
          input.budgetCny, input.inputRef, input.inputSha256, input.workerEntrySha256, input.actor],
      );
      const row = created.rows[0];
      if (!row) fail("FILM_JOB_INVALID", "作业认领未返回行");
      return row;
    });
  }

  async readJob(jobId: string): Promise<FilmJobRow | null> {
    return this.transaction(async (client) => {
      const result = await client.query<FilmJobRow>(
        `SELECT * FROM film_jobs WHERE tenant_id=$1 AND workspace_id=$2 AND id=$3`,
        [this.scope.tenantId, this.scope.workspaceId, jobId],
      );
      return result.rows[0] ?? null;
    });
  }

  async activeJobForProject(projectId: string): Promise<FilmJobRow | null> {
    return this.transaction(async (client) => {
      const result = await client.query<FilmJobRow>(
        `SELECT * FROM film_jobs WHERE tenant_id=$1 AND workspace_id=$2 AND project_id=$3 AND status='running'
          ORDER BY seq DESC LIMIT 1`,
        [this.scope.tenantId, this.scope.workspaceId, projectId],
      );
      return result.rows[0] ?? null;
    });
  }

  /** 作业终态；同一回执重送幂等，不同回执拒绝。 */
  async finishJob(jobId: string, receipt: {
    status: Exclude<FilmJobState, "running">;
    resultRef?: string | null;
    resultSha256?: string | null;
    errorClass?: string | null;
    errorMsg?: string | null;
  }): Promise<FilmJobRow> {
    return this.transaction(async (client) => {
      const current = await client.query<FilmJobRow>(
        `SELECT * FROM film_jobs WHERE tenant_id=$1 AND workspace_id=$2 AND id=$3 FOR UPDATE`,
        [this.scope.tenantId, this.scope.workspaceId, jobId],
      );
      const row = current.rows[0];
      if (!row) fail("FILM_JOB_NOT_FOUND", "作业不存在或不属于当前作用域");
      if (row.status !== "running") {
        const same = row.status === receipt.status
          && (row.result_ref ?? null) === (receipt.resultRef ?? null)
          && (row.result_sha256 ?? null) === (receipt.resultSha256 ?? null)
          && (row.error_class ?? null) === (receipt.errorClass ?? null)
          && (row.error_msg ?? null) === (receipt.errorMsg ?? null);
        if (!same) fail("FILM_JOB_RECEIPT_CONFLICT", "作业已有不同终态回执，拒绝覆盖");
        return row;
      }
      if (receipt.status === "finished" && (!receipt.resultRef || !/^[a-f0-9]{64}$/.test(receipt.resultSha256 ?? ""))) {
        fail("FILM_JOB_RECEIPT_INVALID", "完成回执必须带结果引用与摘要");
      }
      if (receipt.status !== "finished" && !receipt.errorMsg?.trim()) {
        fail("FILM_JOB_RECEIPT_INVALID", "失败/中断回执必须带原因");
      }
      const updated = await client.query<FilmJobRow>(
        `UPDATE film_jobs SET status=$4, finished_at=now(), result_ref=$5, result_sha256=$6, error_class=$7, error_msg=$8
          WHERE tenant_id=$1 AND workspace_id=$2 AND id=$3 AND status='running' RETURNING *`,
        [this.scope.tenantId, this.scope.workspaceId, jobId, receipt.status,
          receipt.resultRef ?? null, receipt.resultSha256 ?? null, receipt.errorClass ?? null, receipt.errorMsg ?? null],
      );
      const finished = updated.rows[0];
      if (!finished) fail("FILM_JOB_STATE_CONFLICT", "作业状态已变化，拒绝继续写终态");
      return finished;
    });
  }

  /** 逐镜/逐步骤组件请求：先留账（含费用预占），同键不同内容拒绝。 */
  async reserveComponent(input: {
    jobId: string;
    component: FilmComponentKind;
    stepKey: string;
    shotId: string | null;
    idempotencyKey: string;
    requestHash: string;
    payloadHash: string;
    reservedCny: number;
  }): Promise<{ row: FilmComponentRow; deduped: boolean }> {
    if (!/^[a-f0-9]{64}$/.test(input.requestHash) || !/^[a-f0-9]{64}$/.test(input.payloadHash)) {
      fail("FILM_COMPONENT_INVALID", "组件请求指纹非法");
    }
    if (!Number.isFinite(input.reservedCny) || input.reservedCny < 0) fail("FILM_COMPONENT_INVALID", "预占费用非法");
    if (!input.stepKey.trim() || !input.idempotencyKey.trim()) fail("FILM_COMPONENT_INVALID", "步骤键与幂等键必填");
    if (input.idempotencyKey.length > 400 || input.stepKey.length > 200) fail("FILM_COMPONENT_INVALID", "步骤键或幂等键超长");
    return this.transaction(async (client) => {
      await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [
        JSON.stringify(["film-component", this.scope.tenantId, this.scope.workspaceId, input.jobId]),
      ]);
      const job = await client.query<FilmJobRow>(
        `SELECT * FROM film_jobs WHERE tenant_id=$1 AND workspace_id=$2 AND id=$3 FOR SHARE`,
        [this.scope.tenantId, this.scope.workspaceId, input.jobId],
      );
      const jobRow = job.rows[0];
      if (!jobRow) fail("FILM_JOB_NOT_FOUND", "作业不存在或不属于当前作用域");
      if (jobRow.status !== "running") fail("FILM_JOB_NOT_RUNNING", "作业已终态，拒绝新的组件调用");
      const previous = await client.query<FilmComponentRow>(
        `SELECT * FROM film_component_requests WHERE job_id=$1 AND idempotency_key=$2`,
        [input.jobId, input.idempotencyKey],
      );
      if (previous.rows[0]) {
        const row = previous.rows[0];
        if (row.request_hash !== input.requestHash || row.payload_hash !== input.payloadHash) {
          fail("IDEMPOTENCY_CONFLICT", "同一幂等键已绑定不同的组件请求");
        }
        if (row.component !== input.component || row.step_key !== input.stepKey || (row.shot_id ?? null) !== (input.shotId ?? null)) {
          fail("IDEMPOTENCY_CONFLICT", "同一幂等键的组件分类、步骤或镜头不一致");
        }
        return { row, deduped: true };
      }
      const totals = await client.query<{ reserved: string }>(
        `SELECT COALESCE(SUM(reserved_cny),0)::text AS reserved FROM film_component_requests WHERE job_id=$1`,
        [input.jobId],
      );
      const committed = Number(totals.rows[0]?.reserved ?? 0) + input.reservedCny;
      const budget = money(jobRow.budget_cny) ?? 0;
      if (committed > budget + 1e-6) {
        fail("FILM_BUDGET_EXCEEDED", `组件预占累计 ${committed.toFixed(4)} 元超过作业预算 ${budget.toFixed(4)} 元`);
      }
      const nextSeq = await client.query<{ n: number }>(
        `SELECT COALESCE(MAX(seq),0)+1 AS n FROM film_component_requests WHERE job_id=$1`,
        [input.jobId],
      );
      const created = await client.query<FilmComponentRow>(
        `INSERT INTO film_component_requests
           (id, seq, tenant_id, workspace_id, project_id, job_id, component, step_key, shot_id,
            idempotency_key, request_hash, payload_hash, state, reserved_cny)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,'reserved',$13)
         RETURNING *`,
        [`FC-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`, Number(nextSeq.rows[0]?.n ?? 1),
          this.scope.tenantId, this.scope.workspaceId, jobRow.project_id, input.jobId, input.component,
          input.stepKey, input.shotId, input.idempotencyKey, input.requestHash, input.payloadHash, input.reservedCny],
      );
      const row = created.rows[0];
      if (!row) fail("FILM_COMPONENT_INVALID", "组件台账未返回行");
      return { row, deduped: false };
    });
  }

  /** 认领组件请求：reserved → dispatched 只有一次机会。 */
  async claimComponent(id: string, ownerToken: string): Promise<FilmComponentRow | null> {
    if (!ownerToken.trim()) fail("FILM_COMPONENT_INVALID", "缺少执行者令牌");
    return this.transaction(async (client) => {
      const changed = await client.query<FilmComponentRow>(
        `UPDATE film_component_requests SET state='dispatched', owner_token=$4, updated_at=now()
          WHERE tenant_id=$1 AND workspace_id=$2 AND id=$3 AND state='reserved' RETURNING *`,
        [this.scope.tenantId, this.scope.workspaceId, id, ownerToken],
      );
      return changed.rows[0] ?? null;
    });
  }

  async recordDispatch(id: string, ownerToken: string, provider: string, providerModel: string): Promise<void> {
    await this.transaction(async (client) => {
      const result = await client.query(
        `UPDATE film_component_requests
            SET provider=$5, provider_model=$6, dispatch_count=dispatch_count+1, updated_at=now()
          WHERE tenant_id=$1 AND workspace_id=$2 AND id=$3 AND owner_token=$4 AND state='dispatched' RETURNING id`,
        [this.scope.tenantId, this.scope.workspaceId, id, ownerToken, provider, providerModel],
      );
      this.requireChanged(result.rowCount);
    });
  }

  async recordComponentAccepted(id: string, ownerToken: string, receipt: {
    provider: string;
    providerModel: string;
    actualCny: number | null;
    evidence: Record<string, unknown>;
  }): Promise<void> {
    if (!receipt.evidence || typeof receipt.evidence.artifactSha256 !== "string" || !/^[a-f0-9]{64}$/.test(receipt.evidence.artifactSha256)) {
      fail("FILM_COMPONENT_RECEIPT_INVALID", "接受回执必须带产物摘要证据");
    }
    await this.transaction(async (client) => {
      const result = await client.query(
        `UPDATE film_component_requests
            SET state='accepted', provider=$5, provider_model=$6, actual_cny=$7, evidence=$8::jsonb, updated_at=now()
          WHERE tenant_id=$1 AND workspace_id=$2 AND id=$3 AND owner_token=$4 AND state='dispatched' RETURNING id`,
        [this.scope.tenantId, this.scope.workspaceId, id, ownerToken,
          receipt.provider, receipt.providerModel,
          receipt.actualCny === null || receipt.actualCny === undefined ? null : receipt.actualCny,
          JSON.stringify(receipt.evidence)],
      );
      this.requireChanged(result.rowCount);
    });
  }

  async recordComponentFailure(id: string, ownerToken: string, receipt: {
    state: "failed" | "unknown";
    failureClass: string;
    actualCny?: number | null;
    evidence?: Record<string, unknown>;
  }): Promise<void> {
    if (!receipt.failureClass.trim()) fail("FILM_COMPONENT_RECEIPT_INVALID", "失败回执必须带分类");
    await this.transaction(async (client) => {
      const result = await client.query(
        `UPDATE film_component_requests
            SET state=$5, actual_cny=$6, evidence=$7::jsonb || jsonb_build_object('failureClass',$8::text), updated_at=now()
          WHERE tenant_id=$1 AND workspace_id=$2 AND id=$3 AND owner_token=$4 AND state IN ('dispatched','reserved') RETURNING id`,
        [this.scope.tenantId, this.scope.workspaceId, id, ownerToken, receipt.state,
          receipt.actualCny === null || receipt.actualCny === undefined ? null : receipt.actualCny,
          JSON.stringify({ ...(receipt.evidence ?? {}) }), receipt.failureClass],
      );
      this.requireChanged(result.rowCount);
    });
  }

  async componentById(id: string): Promise<FilmComponentRow | null> {
    return this.transaction(async (client) => {
      const result = await client.query<FilmComponentRow>(
        `SELECT * FROM film_component_requests WHERE tenant_id=$1 AND workspace_id=$2 AND id=$3`,
        [this.scope.tenantId, this.scope.workspaceId, id],
      );
      return result.rows[0] ?? null;
    });
  }

  /** 作业状态视图：作业 + 组件摘要 + 费用合计（供 `video.film.status` 与巡检）。 */
  async jobStatus(jobId: string): Promise<FilmJobStatusView | null> {
    return this.transaction(async (client) => {
      const job = await client.query<FilmJobRow & { worker_name: string }>(
        `SELECT j.*, w.worker_name FROM film_jobs j JOIN film_workers w ON w.id = j.worker_id
          WHERE j.tenant_id=$1 AND j.workspace_id=$2 AND j.id=$3`,
        [this.scope.tenantId, this.scope.workspaceId, jobId],
      );
      const row = job.rows[0];
      if (!row) return null;
      const components = await client.query<FilmComponentRow>(
        `SELECT * FROM film_component_requests WHERE job_id=$1 ORDER BY seq`,
        [jobId],
      );
      let reserved = 0;
      let spent = 0;
      const summaries: FilmComponentSummary[] = components.rows.map((component) => {
        const reservedCny = money(component.reserved_cny) ?? 0;
        const actualCny = money(component.actual_cny);
        reserved += reservedCny;
        if (component.state === "accepted") spent += actualCny ?? reservedCny;
        return {
          component: component.component,
          stepKey: component.step_key,
          shotId: component.shot_id,
          state: component.state,
          reservedCny,
          actualCny,
          updatedAt: iso(component.updated_at),
        };
      });
      return {
        jobId: row.id,
        projectId: row.project_id,
        attempt: Number(row.attempt),
        runId: row.run_id,
        workerName: row.worker_name,
        status: row.status,
        stages: Array.isArray(row.stages) ? row.stages.map(String) : [],
        startedAt: iso(row.started_at),
        finishedAt: row.finished_at ? iso(row.finished_at) : null,
        errorClass: row.error_class,
        errorMessage: row.error_msg,
        resultRef: row.result_ref,
        resultSha256: row.result_sha256,
        components: summaries,
        reservedCny: Number(reserved.toFixed(4)),
        spentCny: Number(spent.toFixed(4)),
      };
    });
  }

  private requireChanged(count: number | null): void {
    if (count !== 1) fail("FILM_COMPONENT_STATE_CONFLICT", "组件状态或执行者已改变，拒绝继续外部动作");
  }
}
