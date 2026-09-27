/** 生成提交的持久预占与 CAS。网络请求不得在本模块的数据库事务内执行。 */
import { createHash } from "node:crypto";
import type pg from "pg";
import type { EventDraft } from "@workloom/base/workdata";
import { newId } from "@workloom/shared";
import type { AppPool, Scope } from "./db.js";

export class SubmissionError extends Error {
  constructor(public readonly code: string, message: string, public readonly details?: { submissionId: string; key: string; requestHash: string; taskId?: string; provider?: string }) {
    super(`${code}: ${message}`);
    this.name = "SubmissionError";
  }
}

/** JSON 对象键排序；数组保序。拒绝不可忠实表达的数值/循环，不能静默损失身份信息。 */
export function submissionRequestHash(value: unknown): string {
  const active = new Set<object>();
  const canonical = (item: unknown): unknown => {
    if (item === null || typeof item === "string" || typeof item === "boolean") return item;
    if (typeof item === "number" && Number.isFinite(item)) return item;
    if (typeof item !== "object" || !item) throw new SubmissionError("REQUEST_INVALID", "请求指纹只接受 JSON 数据");
    if (active.has(item)) throw new SubmissionError("REQUEST_INVALID", "请求指纹含循环引用");
    active.add(item);
    try {
      if (Array.isArray(item)) return item.map((entry) => entry === undefined ? null : canonical(entry));
      if (Object.getPrototypeOf(item) !== Object.prototype && Object.getPrototypeOf(item) !== null) {
        throw new SubmissionError("REQUEST_INVALID", "请求指纹含非普通对象");
      }
      const result: Record<string, unknown> = Object.create(null);
      for (const key of Object.keys(item).sort()) {
        const entry = (item as Record<string, unknown>)[key];
        if (entry !== undefined) result[key] = canonical(entry);
      }
      return result;
    } finally {
      active.delete(item);
    }
  };
  return createHash("sha256").update(JSON.stringify(canonical(value))).digest("hex");
}

export interface SubmissionReceipt {
  jobId: string;
  taskId: string;
  provider: string;
  providerModel: string;
  mock: boolean;
  estUsd: number | null;
  estCny: number | null;
  degraded: Array<{ from: string; to: string | null; reason: string }>;
  /** 原始接受时点的记账证据；恢复时不能用新的调用方身份或模型配置替换。 */
  events: EventDraft[];
}

export interface SubmissionRow extends pg.QueryResultRow {
  id: string;
  tenant_id: string;
  workspace_id: string;
  project_id: string;
  script_id: string;
  script_version: number;
  idempotency_key: string;
  request_hash: string;
  job_id: string;
  state: "reserved" | "submitting" | "accepted" | "finalized" | "rejected" | "unknown";
  owner_token: string | null;
  provider: string | null;
  provider_model: string | null;
  task_id: string | null;
  receipt: SubmissionReceipt | null;
  last_error: string | null;
  dispatch_count: number;
}

export class SubmissionLedger {
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
      try { await client.query("ROLLBACK"); }
      catch (rollbackError) {
        discard = true;
        throw new AggregateError([error, rollbackError], "generation-submission-rollback-failed");
      }
      throw error;
    } finally {
      client.release(discard);
    }
  }

  async reserve(input: {
    projectId: string; scriptId: string; scriptVersion: number; key: string; requestHash: string;
    script: { shot_id: string; script_key: string; md: string; fields?: Record<string, unknown> | null };
  }): Promise<SubmissionRow> {
    if (!input.key.trim() || !/^[0-9a-f]{64}$/.test(input.requestHash)) throw new SubmissionError("REQUEST_INVALID", "幂等键或请求指纹无效");
    return this.transaction(async (client) => {
      const previous = await client.query<SubmissionRow>(
        "SELECT * FROM generation_submissions WHERE tenant_id=$1 AND workspace_id=$2 AND idempotency_key=$3",
        [this.scope.tenantId, this.scope.workspaceId, input.key],
      );
      if (previous.rows[0]) return this.checkHash(previous.rows[0], input.requestHash);
      // 历史任务只有 key，没有完整 requestHash；不能伪称它与新请求内容相同。
      const legacy = await client.query("SELECT id FROM render_jobs WHERE workspace_id=$1 AND idempotency_key=$2", [this.scope.workspaceId, input.key]);
      if (legacy.rowCount) throw new SubmissionError("LEGACY_SUBMISSION_UNVERIFIED", "历史任务缺少完整请求指纹，请先核实已有任务，不能盲目重发");
      const scripts = await client.query<{ shot_id: string; script_key: string; md: string; fields: Record<string, unknown> }>(
        `SELECT s.shot_id, s.script_key, s.md, s.fields FROM render_scripts s
           JOIN video_projects p ON p.id=s.project_id AND p.workspace_id=s.workspace_id
           JOIN workspaces w ON w.id=s.workspace_id
          WHERE s.id=$1 AND s.project_id=$2 AND s.version=$3 AND s.workspace_id=$4 AND w.tenant_id=$5 FOR SHARE OF s`,
        [input.scriptId, input.projectId, input.scriptVersion, this.scope.workspaceId, this.scope.tenantId],
      );
      if (!scripts.rows[0]) throw new SubmissionError("SCRIPT_SCOPE_MISMATCH", "脚本版本不存在或不属于当前租户、工作区和项目");
      const expected = { ...input.script, fields: input.script.fields ?? {} };
      if (submissionRequestHash(scripts.rows[0]) !== submissionRequestHash(expected)) {
        throw new SubmissionError("SCRIPT_CONTENT_MISMATCH", "请求中的脚本内容与数据库版本不一致，拒绝提交");
      }
      const created = await client.query<SubmissionRow>(
        `INSERT INTO generation_submissions
           (id, tenant_id, workspace_id, project_id, script_id, script_version, idempotency_key, request_hash, job_id)
         SELECT $1,$2,$3,$4,$5,$6,$7,$8,$9 FROM render_scripts s
           JOIN video_projects p ON p.id=s.project_id AND p.workspace_id=s.workspace_id
           JOIN workspaces w ON w.id=s.workspace_id
          WHERE s.id=$5 AND s.project_id=$4 AND s.version=$6 AND s.workspace_id=$3 AND w.tenant_id=$2
         ON CONFLICT (tenant_id, workspace_id, idempotency_key) DO NOTHING RETURNING *`,
        [newId("GS"), this.scope.tenantId, this.scope.workspaceId, input.projectId, input.scriptId, input.scriptVersion, input.key, input.requestHash, newId("RJ")],
      );
      if (created.rows[0]) return created.rows[0];
      const raced = await client.query<SubmissionRow>(
        "SELECT * FROM generation_submissions WHERE tenant_id=$1 AND workspace_id=$2 AND idempotency_key=$3",
        [this.scope.tenantId, this.scope.workspaceId, input.key],
      );
      if (!raced.rows[0]) throw new SubmissionError("SCRIPT_SCOPE_MISMATCH", "脚本版本不存在或不属于当前租户、工作区和项目");
      return this.checkHash(raced.rows[0], input.requestHash);
    });
  }

  private checkHash(row: SubmissionRow, expected: string): SubmissionRow {
    if (row.request_hash !== expected) throw new SubmissionError("IDEMPOTENCY_CONFLICT", "同一幂等键已绑定不同的完整生成请求");
    return row;
  }

  async read(id: string): Promise<SubmissionRow | null> {
    return this.transaction(async (client) => {
      const result = await client.query<SubmissionRow>(
        "SELECT * FROM generation_submissions WHERE tenant_id=$1 AND workspace_id=$2 AND id=$3",
        [this.scope.tenantId, this.scope.workspaceId, id],
      );
      return result.rows[0] ?? null;
    });
  }

  async claim(row: SubmissionRow, ownerToken: string): Promise<SubmissionRow | null> {
    return this.transaction(async (client) => {
      const changed = await client.query<SubmissionRow>(
        `UPDATE generation_submissions SET state='submitting', owner_token=$4, updated_at=now()
          WHERE tenant_id=$1 AND workspace_id=$2 AND id=$3 AND state='reserved' RETURNING *`,
        [this.scope.tenantId, this.scope.workspaceId, row.id, ownerToken],
      );
      return changed.rows[0] ?? null;
    });
  }

  async recordDispatch(id: string, ownerToken: string, provider: string, providerModel: string): Promise<void> {
    await this.transaction(async (client) => {
      const result = await client.query(
        `UPDATE generation_submissions SET provider=$5, provider_model=$6, dispatch_count=dispatch_count+1, updated_at=now()
          WHERE tenant_id=$1 AND workspace_id=$2 AND id=$3 AND owner_token=$4 AND state='submitting' RETURNING id`,
        [this.scope.tenantId, this.scope.workspaceId, id, ownerToken, provider, providerModel],
      );
      this.requireChanged(result.rowCount);
    });
  }

  async recordAccepted(id: string, ownerToken: string, receipt: SubmissionReceipt): Promise<void> {
    if (typeof receipt.taskId !== "string" || !receipt.taskId.trim()) throw new SubmissionError("PROVIDER_RECEIPT_INVALID", "供应商未返回有效任务号，必须对账后再提交");
    await this.transaction(async (client) => {
      const result = await client.query(
        `UPDATE generation_submissions SET state='accepted', task_id=$5, receipt=$6::jsonb, last_error=NULL, updated_at=now()
          WHERE tenant_id=$1 AND workspace_id=$2 AND id=$3 AND owner_token=$4 AND state='submitting'
            AND job_id=$7 AND provider=$8 AND provider_model=$9 RETURNING id`,
        [this.scope.tenantId, this.scope.workspaceId, id, ownerToken, receipt.taskId, JSON.stringify(receipt), receipt.jobId, receipt.provider, receipt.providerModel],
      );
      this.requireChanged(result.rowCount);
    });
  }

  async recordFailure(id: string, ownerToken: string, state: "unknown" | "rejected", error: string): Promise<void> {
    await this.transaction(async (client) => {
      const result = await client.query(
        `UPDATE generation_submissions SET state=$5, last_error=$6, updated_at=now()
          WHERE tenant_id=$1 AND workspace_id=$2 AND id=$3 AND owner_token=$4 AND state='submitting' RETURNING id`,
        [this.scope.tenantId, this.scope.workspaceId, id, ownerToken, state, error.slice(0, 500)],
      );
      this.requireChanged(result.rowCount);
    });
  }

  private requireChanged(count: number | null): void {
    if (count !== 1) throw new SubmissionError("SUBMISSION_STATE_CONFLICT", "提交状态或执行者已改变，拒绝继续外部动作");
  }

  async finalize(id: string, fn: (client: pg.PoolClient, row: SubmissionRow, receipt: SubmissionReceipt) => Promise<void>): Promise<{ receipt: SubmissionReceipt; deduped: boolean }> {
    return this.transaction(async (client) => {
      const selected = await client.query<SubmissionRow>(
        "SELECT * FROM generation_submissions WHERE tenant_id=$1 AND workspace_id=$2 AND id=$3 FOR UPDATE",
        [this.scope.tenantId, this.scope.workspaceId, id],
      );
      const row = selected.rows[0];
      if (!row || !["accepted", "finalized"].includes(row.state) || !row.receipt) {
        throw new SubmissionError("SUBMISSION_UNVERIFIED", "供应商接受回执尚未核实，禁止重发");
      }
      if (row.state === "finalized") return { receipt: row.receipt, deduped: true };
      await fn(client, row, row.receipt);
      const updated = await client.query(
        "UPDATE generation_submissions SET state='finalized', updated_at=now() WHERE id=$1 AND state='accepted' RETURNING id",
        [id],
      );
      this.requireChanged(updated.rowCount);
      return { receipt: row.receipt, deduped: false };
    });
  }
}
