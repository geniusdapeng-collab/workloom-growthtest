/**
 * 真实 PostgreSQL 控制面契约：RLS、双状态、产物绑定、事件幂等和命令重放。
 * 测试不调用模型、图像、视频或发布供应商。
 */
import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";
import {
  PipelineCoordinator,
  compilePipeline,
  pipelineSha256,
} from "@hyperreality/video-studio";
import { PostgresPipelineRepository } from "./pipeline-control-plane.js";

const RUN_DB = process.env.RUN_DB_TESTS === "1" && Boolean(process.env.DATABASE_APP_URL);

describe.runIf(RUN_DB)("视频管线持久化控制面", () => {
  const owner = new pg.Pool({ connectionString: process.env.DATABASE_URL || "" });
  const app = new pg.Pool({ connectionString: process.env.DATABASE_APP_URL || "", max: 3 });
  const suffix = randomBytes(6).toString("hex");
  const scope = { tenantId: `tenant-pipeline-${suffix}`, workspaceId: `ws-pipeline-${suffix}` };
  const projectId = `VID-PIPE-${suffix}`;
  const facts = "a".repeat(64);
  const plan = compilePipeline({
    quest: "pg-control-plane",
    name: "PG 控制面契约",
    version: "v1",
    steps: [
      { step_key: "script", name: "剧本", owner: "scriptwriter", outputs: ["script_blueprint"] },
      { step_key: "g1-script", name: "G1", owner: "director", gate: "G1", outputs: ["review_report"] },
    ],
  }, {
    adapterRegistry: [{ id: "vendor-preproduction", pipelineKeys: ["pg-control-plane"] }],
    knownGates: new Set(["G1"]),
  });
  const coordinator = new PipelineCoordinator(new PostgresPipelineRepository(app), {
    autoApproveGate: () => ({
      decision: "passed",
      actor: "video-auto-approval",
      policyVersion: "workloom.video-auto-approval/v1",
      reason: "PG test video auto approval after quality review",
    }),
  });
  let pipelineRunId = "";

  beforeAll(async () => {
    await owner.query("INSERT INTO tenants (id,name,plan) VALUES ($1,'管线控制面契约','community')", [scope.tenantId]);
    await owner.query(
      `INSERT INTO workspaces (id,tenant_id,name,slug,industry)
       VALUES ($1,$2,'管线控制面契约',$1,'general')`,
      [scope.workspaceId, scope.tenantId],
    );
    await owner.query(
      `INSERT INTO video_projects (id,workspace_id,title,kind,created_by)
       VALUES ($1,$2,'控制面契约片','narrative','MEM-PIPE')`,
      [projectId, scope.workspaceId],
    );
    pipelineRunId = (await coordinator.startCompiledPipeline(scope, plan, {
      projectId,
      planKey: plan.pipelineKey,
      factsSnapshotHash: facts,
      budgetGrantId: null,
      expectedProjectRevision: 0,
      idempotencyKey: `start-${suffix}`,
      createdBy: "MEM-PIPE",
      sourceSystem: "pg-test",
      sourceRunId: `RUN-${suffix}`,
    })).pipelineRunId;
  });

  afterAll(async () => {
    await Promise.all([owner.end(), app.end()]);
  });

  it("only commits a run through scoped coordinates and reuses the exact command receipt", async () => {
    const replay = await coordinator.startCompiledPipeline(scope, plan, {
      projectId,
      planKey: plan.pipelineKey,
      factsSnapshotHash: facts,
      budgetGrantId: null,
      expectedProjectRevision: 0,
      idempotencyKey: `start-${suffix}`,
      createdBy: "MEM-PIPE",
      sourceSystem: "pg-test",
      sourceRunId: `RUN-${suffix}`,
    });
    expect(replay.pipelineRunId).toBe(pipelineRunId);
    const counts = await owner.query<{ runs: string; stages: string; receipts: string }>(
      `SELECT
         (SELECT count(*) FROM video_pipeline_runs WHERE tenant_id=$1 AND workspace_id=$2)::text AS runs,
         (SELECT count(*) FROM production_stage_runs WHERE tenant_id=$1 AND workspace_id=$2 AND pipeline_run_id IS NOT NULL)::text AS stages,
         (SELECT count(*) FROM video_pipeline_command_receipts WHERE tenant_id=$1 AND workspace_id=$2)::text AS receipts`,
      [scope.tenantId, scope.workspaceId],
    );
    expect(counts.rows[0]).toEqual({ runs: "1", stages: "2", receipts: "1" });
  });

  it("keeps output_ready separate from verification and binds a gate to artifact bytes", async () => {
    const run = await coordinator.getRunBySource(scope, "pg-test", `RUN-${suffix}`);
    if (!run) throw new Error("run missing");
    await coordinator.beginStage(scope, {
      pipelineRunId: run.id,
      nodeKey: "script",
      idempotencyKey: `begin-${suffix}`,
    });
    const hash = pipelineSha256({ script: "contract" });
    const output = await coordinator.recordStageOutput(scope, {
      pipelineRunId: run.id,
      nodeKey: "script",
      idempotencyKey: `output-${suffix}`,
      artifacts: [{
        role: "script_blueprint",
        schemaVersion: "workloom.script/v1",
        ref: `pg-test/${suffix}/script.json`,
        sha256: hash,
        logicalHash: hash,
        factsSnapshotHash: facts,
        contentType: "application/json",
      }],
    });
    expect(output.stage.executionStatus).toBe("output_ready");
    expect(output.stage.verificationStatus).toBe("not_run");
    const pending = await coordinator.requestGate(scope, {
      pipelineRunId: run.id,
      nodeKey: "script",
      idempotencyKey: `request-gate-${suffix}`,
      gateKey: "G1",
      checkSetVersion: "pg-test/v1",
      artifactHashes: [hash],
    });
    expect(pending.verificationStatus).toBe("passed");

    const decision = await coordinator.recordGateDecision(scope, {
      pipelineRunId: run.id,
      nodeKey: "script",
      idempotencyKey: `gate-${suffix}`,
      gateKey: "G1",
      checkSetVersion: "pg-test/v1",
      decision: "rejected",
      actor: "reviewer-pg",
      artifactHashes: [hash],
      issues: ["缺少有来源的事实"],
      findings: [{
        code: "G1_SOURCE_MISSING",
        severity: "P1",
        targetType: "field",
        targetId: "script",
        fieldPath: "source",
        expected: "cited source",
        actual: null,
        evidenceRefs: [`artifact:${hash}`],
        repairClass: "semantic",
        blocking: true,
      }],
    });
    expect(decision.decision).toBe("rejected");
    expect(decision.artifactManifestHash).toMatch(/^[a-f0-9]{64}$/);
    expect(decision.findings[0]?.code).toBe("G1_SOURCE_MISSING");
    const projection = await coordinator.readProjection(scope, run.id);
    expect(projection?.stages.find(stage => stage.nodeKey === "script")?.verificationStatus).toBe("rejected");
    expect(projection?.stages.find(stage => stage.nodeKey === "script")?.itemKey).toBe("");
    expect(projection?.nextAction).toBe("repair");
  });

  it("enforces tenant/workspace RLS for the application role", async () => {
    const client = await app.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT set_config('app.tenant_id',$1,true),set_config('app.workspace_id',$2,true)",
        [scope.tenantId, scope.workspaceId]);
      const visible = await client.query<{ count: string }>("SELECT count(*)::text AS count FROM video_pipeline_runs");
      expect(visible.rows[0]?.count).toBe("1");
      await client.query("SET LOCAL app.workspace_id='other-workspace'");
      const hidden = await client.query<{ count: string }>("SELECT count(*)::text AS count FROM video_pipeline_runs");
      expect(hidden.rows[0]?.count).toBe("0");
      await client.query("ROLLBACK");
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  });

  it("rejects evidence mutation and illegal stage state jumps at the database boundary", async () => {
    await expect(owner.query(
      `UPDATE video_pipeline_events SET kind='tampered'
        WHERE tenant_id=$1 AND workspace_id=$2`,
      [scope.tenantId, scope.workspaceId],
    )).rejects.toThrow(/append-only/);
    await expect(owner.query(
      `DELETE FROM production_stage_runs WHERE pipeline_run_id=$1`,
      [pipelineRunId],
    )).rejects.toThrow(/append-only/);
    const client = await app.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT set_config('app.tenant_id',$1,true),set_config('app.workspace_id',$2,true)",
        [scope.tenantId, scope.workspaceId]);
      await expect(client.query(
        `UPDATE production_stage_runs
            SET execution_status='completed', verification_status='passed', disposition='continue',
                revision=revision+1, status='done'
          WHERE pipeline_run_id=$1 AND node_key='g1-script'`,
        [pipelineRunId],
      )).rejects.toThrow(/execution transition forbidden/);
      await client.query("ROLLBACK");
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  });

  it("makes Studio/Film and Director contend on the same project execution lease", async () => {
    const { acquireProjectLease } = await import("./archive-host.js");
    const { acquireDirectorLease } = await import("./director-jobs.js");
    const archiveLease = await acquireProjectLease(scope, projectId);
    expect(archiveLease).not.toBeNull();
    const current = await coordinator.getRun(scope, pipelineRunId);
    if (!current) throw new Error("run missing during lease test");
    const resumed = await coordinator.resumePipeline(scope, {
      pipelineRunId,
      expectedRevision: current.revision,
      idempotencyKey: `resume-while-executing-${suffix}`,
    });
    expect(resumed.id).toBe(pipelineRunId);
    const directorWhileArchiveRuns = await acquireDirectorLease(scope, projectId);
    expect(directorWhileArchiveRuns).toBeNull();
    await archiveLease!.release();
    const directorLease = await acquireDirectorLease(scope, projectId);
    expect(directorLease).not.toBeNull();
    await directorLease!.release();
  });

  it("loads the shipped narrative YAML and records a shadow stage without media side effects", async () => {
    process.env.PIPELINE_CONTROL_SHADOW = "1";
    const { createShadowSession } = await import("./pipeline-control-plane.js");
    const shadow = await createShadowSession({
      scope,
      projectId,
      planKey: "narrative-film",
      facts: { source: "pg-shadow" },
      sourceSystem: "studio-worker",
      sourceRunId: `SHADOW-${suffix}`,
      createdBy: "pg-test",
      idempotencyKey: `shadow-${suffix}`,
    });
    expect(shadow).not.toBeNull();
    const run = await shadow!.start();
    expect(run.planKey).toBe("narrative-film");
    expect(run.plan.steps.length).toBe(26);
    const stage = await shadow!.stageStarted({ observationId: "script-start", nodeKey: "script" });
    expect(stage.executionStatus).toBe("running");
    const rows = await owner.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM video_pipeline_runs
        WHERE tenant_id=$1 AND workspace_id=$2 AND source_system='studio-worker' AND source_run_id=$3`,
      [scope.tenantId, scope.workspaceId, `SHADOW-${suffix}`],
    );
    expect(rows.rows[0]?.count).toBe("1");
  });

  it("server coordinator wires video auto approval without a human wait", async () => {
    const { getPipelineCoordinator } = await import("./pipeline-control-plane.js");
    const server = getPipelineCoordinator();
    const autoPlan = compilePipeline({
      quest: "pg-auto-approval",
      name: "PG 自动审批",
      version: "v1",
      steps: [{ step_key: "script", name: "剧本", owner: "scriptwriter", gate: "G1", outputs: ["script_blueprint"] }],
    }, {
      adapterRegistry: [{ id: "vendor-preproduction", pipelineKeys: ["pg-auto-approval"] }],
      knownGates: new Set(["G1"]),
    });
    const autoProject = `VID-AUTO-${suffix}`;
    await owner.query(
      `INSERT INTO video_projects (id,workspace_id,title,kind,created_by)
       VALUES ($1,$2,'控制面自动审批','narrative','MEM-PIPE')`,
      [autoProject, scope.workspaceId],
    );
    const started = await server.startCompiledPipeline(scope, autoPlan, {
      projectId: autoProject,
      planKey: autoPlan.pipelineKey,
      factsSnapshotHash: facts,
      budgetGrantId: null,
      expectedProjectRevision: 0,
      idempotencyKey: `auto-start-${suffix}`,
      createdBy: "MEM-PIPE",
      sourceSystem: "pg-auto",
      sourceRunId: `AUTO-${suffix}`,
    });
    await server.beginStage(scope, {
      pipelineRunId: started.pipelineRunId,
      nodeKey: "script",
      idempotencyKey: `auto-begin-${suffix}`,
    });
    const hash = pipelineSha256({ script: "auto-approved" });
    const output = await server.recordStageOutput(scope, {
      pipelineRunId: started.pipelineRunId,
      nodeKey: "script",
      idempotencyKey: `auto-output-${suffix}`,
      artifacts: [{
        role: "script_blueprint",
        schemaVersion: "workloom.script/v1",
        ref: `pg-auto/${suffix}/script.json`,
        sha256: hash,
        logicalHash: hash,
        factsSnapshotHash: facts,
        contentType: "application/json",
      }],
    });
    const decided = await server.requestGate(scope, {
      pipelineRunId: started.pipelineRunId,
      nodeKey: "script",
      idempotencyKey: `auto-gate-${suffix}`,
      gateKey: "G1",
      checkSetVersion: "pg-auto/v1",
      artifactHashes: [output.artifacts[0]!.sha256],
    });
    expect(decided).toMatchObject({ executionStatus: "output_ready", verificationStatus: "passed", disposition: "continue" });
    const projection = await server.readProjection(scope, started.pipelineRunId);
    expect(projection?.nextAction).not.toBe("wait_approval");
    const event = await owner.query<{ actor: string; policy_version: string }>(
      `SELECT payload->>'actor' AS actor,payload->>'policyVersion' AS policy_version
         FROM video_pipeline_events
        WHERE tenant_id=$1 AND workspace_id=$2 AND pipeline_run_id=$3 AND kind='gate.auto_approved'`,
      [scope.tenantId, scope.workspaceId, started.pipelineRunId],
    );
    expect(event.rows[0]).toEqual({ actor: "video-auto-approval", policy_version: "workloom.video-auto-approval/v1" });
  });
});
