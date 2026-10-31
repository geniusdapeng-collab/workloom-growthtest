import { randomUUID } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type pg from "pg";
import YAML from "yaml";
import { getAppPool } from "@workloom/db";
import {
  DEFAULT_KNOWN_GATES,
  LEGACY_STAGE_ADAPTERS,
  PipelineCoordinator,
  PipelineShadowSession,
  pipelineControlStateLockKey,
  parseAndCompilePipeline,
  pipelineSha256,
  type ArtifactVersion,
  type CompiledPipelinePlan,
  type GateDecision,
  type GateAutoApprovalInput,
  type PipelineCommandReceipt,
  type PipelineEvent,
  type PipelineRepository,
  type PipelineRun,
  type PipelineScope,
  type PipelineTransaction,
  type StageRun,
} from "@hyperreality/video-studio";
import {
  VIDEO_AUTO_APPROVAL_ACTOR_ID,
  VIDEO_AUTO_APPROVAL_POLICY_VERSION,
  isVideoApprovalGate,
  videoAutoApprovalEnabled,
  videoAutoApprovalReason,
} from "./auto-approval.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(here, "../../../..");
const PIPELINE_DIR = path.join(REPO_ROOT, "bundles/ai-video/pipelines");
const PRESET_DIR = path.join(REPO_ROOT, "bundles/ai-video/presets");

function iso(value: unknown): string {
  if (value instanceof Date) return value.toISOString();
  const parsed = new Date(String(value));
  return Number.isNaN(parsed.getTime()) ? String(value) : parsed.toISOString();
}

function isoOrNull(value: unknown): string | null {
  return value === null || value === undefined ? null : iso(value);
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function legacyStatus(status: StageRun["executionStatus"]): string {
  switch (status) {
    case "pending":
    case "ready":
    case "running":
      return status;
    case "output_ready":
    case "completed":
      return "done";
    case "failed":
      return "failed";
    case "interrupted":
      return "interrupted";
  }
}

class PostgresPipelineTransaction implements PipelineTransaction {
  constructor(
    private readonly client: pg.PoolClient,
    private readonly scope: PipelineScope,
  ) {}

  private assertScope(scope: PipelineScope): void {
    if (scope.tenantId !== this.scope.tenantId || scope.workspaceId !== this.scope.workspaceId) {
      throw new Error("PIPELINE_SCOPE_MISMATCH");
    }
  }

  async lockProject(scope: PipelineScope, projectId: string): Promise<void> {
    this.assertScope(scope);
    await this.client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [
      pipelineControlStateLockKey(scope, projectId),
    ]);
  }

  async getRun(scope: PipelineScope, id: string): Promise<PipelineRun | null> {
    this.assertScope(scope);
    const result = await this.client.query<PipelineRunRow>(
      `SELECT * FROM video_pipeline_runs
        WHERE tenant_id=$1 AND workspace_id=$2 AND id=$3`,
      [scope.tenantId, scope.workspaceId, id],
    );
    return result.rows[0] ? runFromRow(result.rows[0]) : null;
  }

  async getRunBySource(scope: PipelineScope, sourceSystem: string, sourceRunId: string): Promise<PipelineRun | null> {
    this.assertScope(scope);
    const result = await this.client.query<PipelineRunRow>(
      `SELECT * FROM video_pipeline_runs
        WHERE tenant_id=$1 AND workspace_id=$2 AND source_system=$3 AND source_run_id=$4`,
      [scope.tenantId, scope.workspaceId, sourceSystem, sourceRunId],
    );
    return result.rows[0] ? runFromRow(result.rows[0]) : null;
  }

  async getLatestProjectRun(scope: PipelineScope, projectId: string): Promise<PipelineRun | null> {
    this.assertScope(scope);
    const result = await this.client.query<PipelineRunRow>(
      `SELECT * FROM video_pipeline_runs
        WHERE tenant_id=$1 AND workspace_id=$2 AND project_id=$3
        ORDER BY created_at DESC, id DESC LIMIT 1`,
      [scope.tenantId, scope.workspaceId, projectId],
    );
    return result.rows[0] ? runFromRow(result.rows[0]) : null;
  }

  async insertRun(run: PipelineRun): Promise<PipelineRun> {
    this.assertScope(run);
    const result = await this.client.query<PipelineRunRow>(
      `INSERT INTO video_pipeline_runs
        (id,tenant_id,workspace_id,project_id,plan_key,plan_version,plan_hash,plan_json,
         source_digest,facts_snapshot_hash,status,revision,current_frontier,budget_grant_id,
         source_system,source_run_id,created_by,created_at,updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9,$10,$11,$12,$13::jsonb,$14,$15,$16,$17,$18,$19)
       RETURNING *`,
      [
        run.id, run.tenantId, run.workspaceId, run.projectId, run.planKey, run.planVersion,
        run.planHash, JSON.stringify(run.plan), run.sourceDigest, run.factsSnapshotHash, run.status,
        run.revision, JSON.stringify(run.currentFrontier), run.budgetGrantId, run.sourceSystem,
        run.sourceRunId, run.createdBy, run.createdAt, run.updatedAt,
      ],
    );
    return runFromRow(result.rows[0]!);
  }

  async updateRun(run: PipelineRun, expectedRevision: number): Promise<PipelineRun> {
    this.assertScope(run);
    const result = await this.client.query<PipelineRunRow>(
      `UPDATE video_pipeline_runs
          SET status=$4, revision=$5, current_frontier=$6::jsonb, updated_at=$7
        WHERE tenant_id=$1 AND workspace_id=$2 AND id=$3 AND revision=$8
        RETURNING *`,
      [
        run.tenantId, run.workspaceId, run.id, run.status, run.revision,
        JSON.stringify(run.currentFrontier), run.updatedAt, expectedRevision,
      ],
    );
    if (!result.rows[0]) throw new Error(`PIPELINE_RUN_REVISION_CONFLICT: ${run.id}`);
    return runFromRow(result.rows[0]);
  }

  async getStage(scope: PipelineScope, id: string): Promise<StageRun | null> {
    this.assertScope(scope);
    const result = await this.client.query<StageRunRow>(
      `SELECT * FROM production_stage_runs
        WHERE tenant_id=$1 AND workspace_id=$2 AND id=$3 AND pipeline_run_id IS NOT NULL`,
      [scope.tenantId, scope.workspaceId, id],
    );
    return result.rows[0] ? stageFromRow(result.rows[0]) : null;
  }

  async getLatestStage(scope: PipelineScope, pipelineRunId: string, nodeKey: string, itemKey = ""): Promise<StageRun | null> {
    this.assertScope(scope);
    const result = await this.client.query<StageRunRow>(
      `SELECT * FROM production_stage_runs
        WHERE tenant_id=$1 AND workspace_id=$2 AND pipeline_run_id=$3 AND node_key=$4 AND item_key=$5
        ORDER BY attempt DESC LIMIT 1`,
      [scope.tenantId, scope.workspaceId, pipelineRunId, nodeKey, itemKey],
    );
    return result.rows[0] ? stageFromRow(result.rows[0]) : null;
  }

  async nextStageAttempt(scope: PipelineScope, projectId: string, nodeKey: string, itemKey = ""): Promise<number> {
    this.assertScope(scope);
    const result = await this.client.query<{ next_attempt: number }>(
      `SELECT COALESCE(MAX(attempt),0)+1 AS next_attempt
         FROM production_stage_runs
        WHERE tenant_id=$1 AND workspace_id=$2 AND project_id=$3 AND node_key=$4 AND item_key=$5`,
      [scope.tenantId, scope.workspaceId, projectId, nodeKey, itemKey],
    );
    return Number(result.rows[0]?.next_attempt ?? 1);
  }

  async insertStage(stage: StageRun): Promise<StageRun> {
    this.assertScope({
      tenantId: this.scope.tenantId,
      workspaceId: this.scope.workspaceId,
    });
    const legacyStageId = stage.itemKey ? `${stage.nodeKey}#${stage.itemKey}` : stage.nodeKey;
    const result = await this.client.query<StageRunRow>(
      `INSERT INTO production_stage_runs
        (id,tenant_id,workspace_id,project_id,stage_id,attempt,status,input_ref,output_ref,
         output_sha256,run_id,started_at,finished_at,pipeline_run_id,node_key,item_key,
         stage_contract_version,plan_hash,facts_snapshot_hash,execution_status,
         verification_status,disposition,input_sha256,contract_hash,repair_of_stage_run_id,
         idempotency_key,worker_token_hash,revision,updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,NULL,NULL,$8,$9,COALESCE($10,now()),$11,$12,$13,$14,$15,$16,$17,$18,$19,
               $20,$21,$22,$23,$24,$25,$26,$27)
       RETURNING *`,
      [
        stage.id, this.scope.tenantId, this.scope.workspaceId, stage.projectId, legacyStageId,
        stage.attempt, legacyStatus(stage.executionStatus), stage.outputSha256, stage.pipelineRunId,
        stage.startedAt, stage.finishedAt, stage.pipelineRunId, stage.nodeKey, stage.itemKey,
        stage.stageContractVersion, stage.planHash, stage.factsSnapshotHash,
        stage.executionStatus, stage.verificationStatus, stage.disposition, stage.inputSha256,
        stage.contractHash, stage.repairOfStageRunId, stage.idempotencyKey, stage.workerTokenHash,
        stage.revision, stage.updatedAt,
      ],
    );
    return stageFromRow(result.rows[0]!);
  }

  async updateStage(stage: StageRun, expectedRevision: number): Promise<StageRun> {
    const result = await this.client.query<StageRunRow>(
      `UPDATE production_stage_runs
          SET status=$4, output_ref=$5, output_sha256=$6, error_class=$7, error_msg=$8,
              finished_at=$9, execution_status=$10, verification_status=$11, disposition=$12,
              input_sha256=$13, worker_token_hash=$14, revision=$15, updated_at=$16
        WHERE tenant_id=$1 AND workspace_id=$2 AND id=$3
          AND pipeline_run_id IS NOT NULL AND revision=$17
        RETURNING *`,
      [
        this.scope.tenantId, this.scope.workspaceId, stage.id, legacyStatus(stage.executionStatus),
        stage.outputRef, stage.outputSha256, stage.errorClass, stage.errorMessage, stage.finishedAt,
        stage.executionStatus, stage.verificationStatus, stage.disposition, stage.inputSha256,
        stage.workerTokenHash, stage.revision, stage.updatedAt, expectedRevision,
      ],
    );
    if (!result.rows[0]) throw new Error(`PIPELINE_STAGE_REVISION_CONFLICT: ${stage.id}`);
    return stageFromRow(result.rows[0]);
  }

  async listStages(scope: PipelineScope, pipelineRunId: string): Promise<StageRun[]> {
    this.assertScope(scope);
    const result = await this.client.query<StageRunRow>(
      `SELECT * FROM production_stage_runs
        WHERE tenant_id=$1 AND workspace_id=$2 AND pipeline_run_id=$3
        ORDER BY attempt,node_key,item_key,id`,
      [scope.tenantId, scope.workspaceId, pipelineRunId],
    );
    return result.rows.map(stageFromRow);
  }

  async insertArtifact(artifact: ArtifactVersion): Promise<ArtifactVersion> {
    const result = await this.client.query<ArtifactRow>(
      `INSERT INTO video_artifacts
        (id,tenant_id,workspace_id,pipeline_run_id,stage_run_id,role,schema_version,content_type,
         ref,sha256,logical_hash,facts_snapshot_hash,created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
       RETURNING *`,
      [
        artifact.id, this.scope.tenantId, this.scope.workspaceId, artifact.pipelineRunId,
        artifact.stageRunId, artifact.role, artifact.schemaVersion, artifact.contentType,
        artifact.ref, artifact.sha256, artifact.logicalHash, artifact.factsSnapshotHash, artifact.createdAt,
      ],
    );
    return artifactFromRow(result.rows[0]!);
  }

  async listArtifacts(scope: PipelineScope, stageRunId: string): Promise<ArtifactVersion[]> {
    this.assertScope(scope);
    const result = await this.client.query<ArtifactRow>(
      `SELECT * FROM video_artifacts
        WHERE tenant_id=$1 AND workspace_id=$2 AND stage_run_id=$3
        ORDER BY created_at,id`,
      [scope.tenantId, scope.workspaceId, stageRunId],
    );
    return result.rows.map(artifactFromRow);
  }

  async insertGateDecision(decision: GateDecision): Promise<GateDecision> {
    const result = await this.client.query<GateRow>(
      `INSERT INTO video_gate_decisions
        (id,tenant_id,workspace_id,pipeline_run_id,stage_run_id,gate_key,check_set_version,
         artifact_manifest_hash,decision,actor,artifact_hashes,issues,suggestions,findings,
         evidence_hashes,approval_id,expires_at,created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb,$12::jsonb,$13::jsonb,$14::jsonb,
               $15::jsonb,$16,$17,$18)
       RETURNING *`,
      [
        decision.id, this.scope.tenantId, this.scope.workspaceId, decision.pipelineRunId,
        decision.stageRunId, decision.gateKey, decision.checkSetVersion, decision.artifactManifestHash,
        decision.decision, decision.actor, JSON.stringify(decision.artifactHashes),
        JSON.stringify(decision.issues), JSON.stringify(decision.suggestions),
        JSON.stringify(decision.findings), JSON.stringify(decision.evidenceHashes),
        decision.approvalId, decision.expiresAt, decision.createdAt,
      ],
    );
    return gateFromRow(result.rows[0]!);
  }

  async listGateDecisions(scope: PipelineScope, stageRunId: string): Promise<GateDecision[]> {
    this.assertScope(scope);
    const result = await this.client.query<GateRow>(
      `SELECT * FROM video_gate_decisions
        WHERE tenant_id=$1 AND workspace_id=$2 AND stage_run_id=$3
        ORDER BY created_at,id`,
      [scope.tenantId, scope.workspaceId, stageRunId],
    );
    return result.rows.map(gateFromRow);
  }

  async insertEdge(scope: PipelineScope, edge: {
    pipelineRunId: string;
    parentStageRunId: string;
    childStageRunId: string;
    inputRole: string;
  }): Promise<void> {
    this.assertScope(scope);
    await this.client.query(
      `INSERT INTO video_stage_edges
        (tenant_id,workspace_id,pipeline_run_id,parent_stage_run_id,child_stage_run_id,input_role)
       VALUES ($1,$2,$3,$4,$5,$6)
       ON CONFLICT DO NOTHING`,
      [scope.tenantId, scope.workspaceId, edge.pipelineRunId, edge.parentStageRunId, edge.childStageRunId, edge.inputRole],
    );
  }

  async appendEvent(event: PipelineEvent): Promise<PipelineEvent> {
    const result = await this.client.query<EventRow>(
      `INSERT INTO video_pipeline_events
        (id,tenant_id,workspace_id,pipeline_run_id,stage_run_id,kind,idempotency_key,payload,created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9)
       ON CONFLICT (tenant_id,workspace_id,idempotency_key) DO NOTHING
       RETURNING *`,
      [
        event.id, this.scope.tenantId, this.scope.workspaceId, event.pipelineRunId, event.stageRunId,
        event.kind, event.idempotencyKey, JSON.stringify(event.payload), event.createdAt,
      ],
    );
    if (result.rows[0]) return eventFromRow(result.rows[0]);
    const existing = await this.client.query<EventRow>(
      `SELECT * FROM video_pipeline_events
        WHERE tenant_id=$1 AND workspace_id=$2 AND idempotency_key=$3`,
      [this.scope.tenantId, this.scope.workspaceId, event.idempotencyKey],
    );
    if (!existing.rows[0]) throw new Error(`PIPELINE_EVENT_IDEMPOTENCY_CONFLICT: ${event.idempotencyKey}`);
    return eventFromRow(existing.rows[0]);
  }

  async listEvents(scope: PipelineScope, pipelineRunId: string, afterSequence = 0): Promise<PipelineEvent[]> {
    this.assertScope(scope);
    const result = await this.client.query<EventRow>(
      `SELECT * FROM video_pipeline_events
        WHERE tenant_id=$1 AND workspace_id=$2 AND pipeline_run_id=$3 AND seq>$4
        ORDER BY seq`,
      [scope.tenantId, scope.workspaceId, pipelineRunId, afterSequence],
    );
    return result.rows.map(eventFromRow);
  }

  async getCommandReceipt<T = unknown>(
    scope: PipelineScope,
    idempotencyKey: string,
  ): Promise<PipelineCommandReceipt<T> | null> {
    this.assertScope(scope);
    const result = await this.client.query<CommandReceiptRow>(
      `SELECT * FROM video_pipeline_command_receipts
        WHERE tenant_id=$1 AND workspace_id=$2 AND idempotency_key=$3`,
      [scope.tenantId, scope.workspaceId, idempotencyKey],
    );
    return result.rows[0] ? receiptFromRow<T>(result.rows[0]) : null;
  }

  async insertCommandReceipt<T = unknown>(receipt: PipelineCommandReceipt<T>): Promise<PipelineCommandReceipt<T>> {
    this.assertScope(receipt.scope);
    const result = await this.client.query<CommandReceiptRow>(
      `INSERT INTO video_pipeline_command_receipts
        (id,tenant_id,workspace_id,idempotency_key,request_hash,result_json,created_at)
       VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7)
       ON CONFLICT (tenant_id,workspace_id,idempotency_key) DO NOTHING
       RETURNING *`,
      [
        `PCR-${randomUUID().replace(/-/gu, "").slice(0, 16).toUpperCase()}`,
        this.scope.tenantId, this.scope.workspaceId, receipt.idempotencyKey,
        receipt.requestHash, JSON.stringify(receipt.result), receipt.createdAt,
      ],
    );
    if (result.rows[0]) return receiptFromRow<T>(result.rows[0]);
    const existing = await this.client.query<CommandReceiptRow>(
      `SELECT * FROM video_pipeline_command_receipts
        WHERE tenant_id=$1 AND workspace_id=$2 AND idempotency_key=$3`,
      [this.scope.tenantId, this.scope.workspaceId, receipt.idempotencyKey],
    );
    const found = existing.rows[0] ? receiptFromRow<T>(existing.rows[0]) : null;
    if (!found || found.requestHash !== receipt.requestHash) {
      throw new Error(`PIPELINE_IDEMPOTENCY_CONFLICT: ${receipt.idempotencyKey}`);
    }
    return found;
  }
}

export class PostgresPipelineRepository implements PipelineRepository {
  constructor(private readonly app: ReturnType<typeof getAppPool> = getAppPool()) {}

  async transaction<T>(scope: PipelineScope, fn: (tx: PipelineTransaction) => Promise<T>): Promise<T> {
    const client = await this.app.connect();
    let discard = false;
    try {
      await client.query("BEGIN");
      await client.query("SELECT set_config('app.workspace_id', $1, true)", [scope.workspaceId]);
      await client.query("SELECT set_config('app.tenant_id', $1, true)", [scope.tenantId]);
      const result = await fn(new PostgresPipelineTransaction(client, scope));
      await client.query("COMMIT");
      return result;
    } catch (error) {
      try {
        await client.query("ROLLBACK");
      } catch (rollbackError) {
        discard = true;
        throw new AggregateError([error, rollbackError], "pipeline-control-transaction-rollback-failed");
      }
      throw error;
    } finally {
      client.release(discard);
    }
  }
}

interface PipelineRunRow extends pg.QueryResultRow {
  id: string;
  tenant_id: string;
  workspace_id: string;
  project_id: string;
  plan_key: string;
  plan_version: number;
  plan_hash: string;
  plan_json: CompiledPipelinePlan;
  source_digest: string;
  facts_snapshot_hash: string;
  status: PipelineRun["status"];
  revision: string | number;
  current_frontier: string[];
  budget_grant_id: string | null;
  source_system: string;
  source_run_id: string;
  created_by: string;
  created_at: Date | string;
  updated_at: Date | string;
}

interface StageRunRow extends pg.QueryResultRow {
  id: string;
  tenant_id: string;
  workspace_id: string;
  project_id: string;
  pipeline_run_id: string;
  node_key: string;
  item_key: string;
  attempt: number;
  stage_contract_version: number;
  plan_hash: string;
  facts_snapshot_hash: string;
  execution_status: StageRun["executionStatus"];
  verification_status: StageRun["verificationStatus"];
  disposition: StageRun["disposition"];
  idempotency_key: string;
  worker_token_hash: string | null;
  input_sha256: string | null;
  contract_hash: string | null;
  repair_of_stage_run_id: string | null;
  output_ref: string | null;
  output_sha256: string | null;
  error_class: string | null;
  error_msg: string | null;
  started_at: Date | string | null;
  finished_at: Date | string | null;
  revision: string | number;
  updated_at: Date | string;
}

interface ArtifactRow extends pg.QueryResultRow {
  id: string;
  pipeline_run_id: string;
  stage_run_id: string;
  role: string;
  schema_version: string;
  content_type: string;
  ref: string;
  sha256: string;
  logical_hash: string;
  facts_snapshot_hash: string;
  created_at: Date | string;
}

interface GateRow extends pg.QueryResultRow {
  id: string;
  pipeline_run_id: string;
  stage_run_id: string;
  gate_key: string;
  check_set_version: string;
  artifact_manifest_hash: string;
  decision: GateDecision["decision"];
  actor: string;
  artifact_hashes: string[];
  issues: string[];
  suggestions: string[];
  findings: GateDecision["findings"];
  evidence_hashes: string[];
  approval_id: string | null;
  expires_at: Date | string | null;
  created_at: Date | string;
}

interface EventRow extends pg.QueryResultRow {
  id: string;
  pipeline_run_id: string | null;
  stage_run_id: string | null;
  kind: string;
  idempotency_key: string;
  payload: Record<string, unknown>;
  created_at: Date | string;
}

interface CommandReceiptRow extends pg.QueryResultRow {
  tenant_id: string;
  workspace_id: string;
  idempotency_key: string;
  request_hash: string;
  result_json: unknown;
  created_at: Date | string;
}

function runFromRow(row: PipelineRunRow): PipelineRun {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    workspaceId: row.workspace_id,
    projectId: row.project_id,
    planKey: row.plan_key,
    planVersion: Number(row.plan_version),
    planHash: row.plan_hash,
    plan: row.plan_json,
    sourceDigest: row.source_digest,
    factsSnapshotHash: row.facts_snapshot_hash,
    status: row.status,
    revision: Number(row.revision),
    currentFrontier: Array.isArray(row.current_frontier) ? row.current_frontier : [],
    budgetGrantId: row.budget_grant_id,
    sourceSystem: row.source_system,
    sourceRunId: row.source_run_id,
    createdBy: row.created_by,
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  };
}

function stageFromRow(row: StageRunRow): StageRun {
  return {
    id: row.id,
    pipelineRunId: row.pipeline_run_id,
    projectId: row.project_id,
    nodeKey: row.node_key,
    itemKey: row.item_key,
    attempt: Number(row.attempt),
    stageContractVersion: Number(row.stage_contract_version),
    planHash: row.plan_hash,
    factsSnapshotHash: row.facts_snapshot_hash,
    executionStatus: row.execution_status,
    verificationStatus: row.verification_status,
    disposition: row.disposition,
    idempotencyKey: row.idempotency_key,
    workerTokenHash: row.worker_token_hash,
    inputSha256: row.input_sha256,
    contractHash: row.contract_hash,
    repairOfStageRunId: row.repair_of_stage_run_id,
    outputRef: row.output_ref,
    outputSha256: row.output_sha256,
    errorClass: row.error_class,
    errorMessage: row.error_msg,
    startedAt: isoOrNull(row.started_at),
    finishedAt: isoOrNull(row.finished_at),
    revision: Number(row.revision),
    createdAt: iso(row.started_at ?? row.updated_at),
    updatedAt: iso(row.updated_at),
  };
}

function artifactFromRow(row: ArtifactRow): ArtifactVersion {
  return {
    id: row.id,
    pipelineRunId: row.pipeline_run_id,
    stageRunId: row.stage_run_id,
    role: row.role,
    schemaVersion: row.schema_version,
    contentType: row.content_type,
    ref: row.ref,
    sha256: row.sha256,
    logicalHash: row.logical_hash,
    factsSnapshotHash: row.facts_snapshot_hash,
    createdAt: iso(row.created_at),
  };
}

function gateFromRow(row: GateRow): GateDecision {
  return {
    id: row.id,
    pipelineRunId: row.pipeline_run_id,
    stageRunId: row.stage_run_id,
    gateKey: row.gate_key,
    checkSetVersion: row.check_set_version,
    artifactManifestHash: row.artifact_manifest_hash,
    decision: row.decision,
    actor: row.actor,
    artifactHashes: row.artifact_hashes,
    issues: row.issues,
    suggestions: row.suggestions,
    findings: row.findings,
    evidenceHashes: row.evidence_hashes,
    approvalId: row.approval_id,
    expiresAt: isoOrNull(row.expires_at),
    createdAt: iso(row.created_at),
  };
}

function eventFromRow(row: EventRow): PipelineEvent {
  return {
    id: row.id,
    pipelineRunId: row.pipeline_run_id,
    stageRunId: row.stage_run_id,
    kind: row.kind,
    idempotencyKey: row.idempotency_key,
    payload: record(row.payload),
    createdAt: iso(row.created_at),
  };
}

function receiptFromRow<T>(row: CommandReceiptRow): PipelineCommandReceipt<T> {
  return {
    scope: { tenantId: row.tenant_id, workspaceId: row.workspace_id },
    idempotencyKey: row.idempotency_key,
    requestHash: row.request_hash,
    result: row.result_json as T,
    createdAt: iso(row.created_at),
  };
}

let coordinator: PipelineCoordinator | null = null;
const planCache = new Map<string, CompiledPipelinePlan>();
let knownOwnersPromise: Promise<ReadonlySet<string>> | null = null;

async function loadKnownOwners(): Promise<ReadonlySet<string>> {
  if (!knownOwnersPromise) {
    knownOwnersPromise = (async () => {
      const names = await readdir(PRESET_DIR);
      const owners = new Set<string>();
      for (const name of names.filter(entry => entry.endsWith(".yml") || entry.endsWith(".yaml"))) {
        const document = YAML.parse(await readFile(path.join(PRESET_DIR, name), "utf8")) as { preset_key?: unknown };
        if (typeof document?.preset_key === "string") owners.add(document.preset_key);
      }
      return owners;
    })();
  }
  return knownOwnersPromise;
}

export async function loadCompiledVideoPipeline(planKey: string): Promise<CompiledPipelinePlan> {
  const cached = planCache.get(planKey);
  if (cached) return cached;
  const safeKey = /^[a-z0-9][a-z0-9-]{1,119}$/u.test(planKey) ? planKey : "";
  if (!safeKey) throw new Error("PIPELINE_KEY_INVALID");
  const source = await readFile(path.join(PIPELINE_DIR, `${safeKey}.yml`), "utf8");
  const plan = parseAndCompilePipeline(source, {
    knownOwners: await loadKnownOwners(),
    knownGates: DEFAULT_KNOWN_GATES,
    adapterRegistry: LEGACY_STAGE_ADAPTERS,
  });
  if (plan.pipelineKey !== planKey) throw new Error(`PIPELINE_KEY_MISMATCH: ${planKey} != ${plan.pipelineKey}`);
  planCache.set(planKey, plan);
  return plan;
}

const AUTO_GATE_REQUIRED_OUTPUT: Readonly<Record<string, string>> = {
  G1: "dossier",
  G2: "theme",
  G3: "insight",
  G4: "prd",
  G5: "portrait_set",
  G6: "prompt_package",
  G7: "video_project",
  G8: "render_job",
  G9: "publish_task",
  G10: "comment_reply",
  G12: "ads_campaign",
  G15: "deal_order",
};

function normalizedGateKey(gateKey: string): string {
  return gateKey
    .replace(/^G1_DOSSIER$/u, "G1")
    .replace(/^G2_THEME$/u, "G2")
    .replace(/^G3_INSIGHT$/u, "G3")
    .replace(/^G4_PRD$/u, "G4")
    .replace(/^G5_PORTRAIT$/u, "G5")
    .replace(/^G6_PROMPT$/u, "G6")
    .replace(/^G7_FINAL$/u, "G7")
    .replace(/^G10[a-d]?$/u, "G10");
}

/**
 * 控制面自动通过必须绑定“门所属阶段 + 当前事实快照 + 阶段输出契约 + 具体门产物”。
 * 仅凭 gateKey 命中白名单不能证明 G1/G5/G8 等门真的跑了质量检查。
 */
export function validatePipelineGateAutoApproval(input: GateAutoApprovalInput): {
  valid: boolean;
  reason: string;
} {
  const contract = input.run.plan.steps.find((step) => step.stageKey === input.stage.nodeKey);
  if (!contract) return { valid: false, reason: `门阶段 ${input.stage.nodeKey} 不在当前计划中` };
  const normalizedGate = normalizedGateKey(input.gateKey);
  if (!contract.verify.gate || normalizedGateKey(contract.verify.gate) !== normalizedGate) {
    return { valid: false, reason: `门 ${input.gateKey} 未声明在阶段 ${input.stage.nodeKey}` };
  }
  const requiredRole = AUTO_GATE_REQUIRED_OUTPUT[normalizedGate];
  if (!requiredRole) return { valid: false, reason: `门 ${input.gateKey} 没有登记自动审批产物契约` };
  const outputContract = contract.outputContract.find((output) => output.role === requiredRole);
  if (!outputContract) {
    return { valid: false, reason: `阶段 ${input.stage.nodeKey} 未声明 ${requiredRole} 输出` };
  }
  if (input.artifacts.some((artifact) => artifact.factsSnapshotHash !== input.run.factsSnapshotHash)) {
    return { valid: false, reason: "门产物不是当前事实快照生成的版本" };
  }
  const evidence = input.artifacts.find((artifact) => artifact.role === requiredRole);
  if (!evidence) return { valid: false, reason: `门 ${input.gateKey} 缺少 ${requiredRole} 门产物` };
  if (evidence.schemaVersion !== outputContract.schema) {
    return {
      valid: false,
      reason: `门 ${input.gateKey} 产物 schema 不符：${evidence.schemaVersion} != ${outputContract.schema}`,
    };
  }
  return { valid: true, reason: `${requiredRole} 产物、schema 与事实快照均已绑定` };
}

export function getPipelineCoordinator(): PipelineCoordinator {
  if (!coordinator) {
    coordinator = new PipelineCoordinator(new PostgresPipelineRepository(), {
      resolvePlan: (planKey) => loadCompiledVideoPipeline(planKey),
      autoApproveGate: (input) => {
        if (!videoAutoApprovalEnabled() || !isVideoApprovalGate(input.gateKey)) return null;
        const validation = validatePipelineGateAutoApproval(input);
        if (!validation.valid) {
          return {
            decision: "unverified",
            actor: VIDEO_AUTO_APPROVAL_ACTOR_ID,
            policyVersion: VIDEO_AUTO_APPROVAL_POLICY_VERSION,
            reason: `控制面自动审批证据不足：${validation.reason}`,
            issues: [validation.reason],
            findings: [{
              code: "AUTO_GATE_EVIDENCE_INVALID",
              severity: "P1",
              targetType: "stage",
              targetId: input.stage.id,
              fieldPath: "artifacts",
              expected: "当前事实快照下的契约产物",
              actual: input.artifacts.map((artifact) => ({
                role: artifact.role,
                schemaVersion: artifact.schemaVersion,
                factsSnapshotHash: artifact.factsSnapshotHash,
              })),
              evidenceRefs: input.artifactHashes,
              repairClass: "no_repair",
              blocking: true,
            }],
            evidenceHashes: input.artifactHashes,
          };
        }
        return {
          decision: "passed",
          actor: VIDEO_AUTO_APPROVAL_ACTOR_ID,
          policyVersion: VIDEO_AUTO_APPROVAL_POLICY_VERSION,
          reason: videoAutoApprovalReason(`${input.run.plan.pipelineKey}/${input.stage.nodeKey}/${input.gateKey}`),
          evidenceHashes: input.artifactHashes,
        };
      },
    });
  }
  return coordinator;
}

export async function createShadowSession(input: {
  scope: PipelineScope;
  projectId: string;
  planKey: string;
  facts: unknown;
  sourceSystem: string;
  sourceRunId: string;
  createdBy: string;
  idempotencyKey: string;
}): Promise<PipelineShadowSession | null> {
  const configured = process.env.PIPELINE_CONTROL_SHADOW;
  if ((configured ?? (process.env.NODE_ENV === "test" ? "0" : "1")) === "0") return null;
  const plan = await loadCompiledVideoPipeline(input.planKey);
  return new PipelineShadowSession(getPipelineCoordinator(), {
    scope: input.scope,
    projectId: input.projectId,
    plan,
    factsSnapshotHash: pipelineSha256(input.facts),
    sourceSystem: input.sourceSystem,
    sourceRunId: input.sourceRunId,
    createdBy: input.createdBy,
    idempotencyKey: input.idempotencyKey,
  });
}

export async function ignorePipelineShadow<T>(
  label: string,
  fn: () => Promise<T>,
): Promise<T | null> {
  try {
    return await fn();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[pipeline-shadow] ${label}: ${message.slice(0, 1_000)}`);
    return null;
  }
}

export type { PipelineShadowSession } from "@hyperreality/video-studio";
