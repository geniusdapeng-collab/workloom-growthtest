import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PipelineCoordinator, compilePipeline, pipelineControlStateLockKey, pipelineSha256 } from "@hyperreality/video-studio";
import { PostgresPipelineRepository } from "./pipeline-control-plane.js";

describe.runIf(process.env.RUN_DB_TESTS === "1")("控制面并发幂等命令的真实PG回执", () => {
  const suffix = randomUUID().slice(0, 8);
  const applicationName = `pipeline-race-${suffix}`;
  const owner = new pg.Pool({ connectionString: process.env.DATABASE_URL });
  const app = new pg.Pool({ connectionString: process.env.DATABASE_APP_URL, application_name: applicationName, max: 4 });
  const scope = { tenantId: `tenant-race-${suffix}`, workspaceId: `ws-race-${suffix}` };
  const coordinator = new PipelineCoordinator(new PostgresPipelineRepository(app));
  const plan = compilePipeline({ quest: "race-test", name: "race", version: 1,
    steps: [{ step_key: "script", name: "script", owner: "writer", outputs: ["script"] }],
  }, { adapterRegistry: [{ id: "vendor-preproduction", pipelineKeys: ["race-test"] }] });
  const factsSnapshotHash = "a".repeat(64);
  beforeAll(async () => {
    await owner.query("INSERT INTO tenants (id,name,plan) VALUES ($1,'race','community')", [scope.tenantId]);
    await owner.query("INSERT INTO workspaces (id,tenant_id,name,slug,industry) VALUES ($1,$2,'race',$1,'general')", [scope.workspaceId, scope.tenantId]);
  });
  afterAll(async () => { await Promise.all([owner.end(), app.end()]); });

  async function createRun(label: string) {
    const projectId = `VID-race-${suffix}-${label}`;
    await owner.query("INSERT INTO video_projects (id,workspace_id,title,kind,created_by) VALUES ($1,$2,'race','narrative','test')", [projectId, scope.workspaceId]);
    const run = await coordinator.startCompiledPipeline(scope, plan, {
      projectId, planKey: plan.pipelineKey, factsSnapshotHash, budgetGrantId: null,
      expectedProjectRevision: 0, idempotencyKey: `start-${projectId}`, createdBy: "test", sourceSystem: "race-test", sourceRunId: projectId,
    });
    await coordinator.beginStage(scope, { pipelineRunId: run.pipelineRunId, nodeKey: "script", idempotencyKey: `begin-${projectId}` });
    return { ...run, projectId };
  }

  it("同一输出命令并发重放只登记一次产物并返回相同持久化回执", async () => {
    const run = await createRun("same");
    const blocker = await owner.connect();
    let locked = true;
    try {
      await blocker.query("BEGIN");
      await blocker.query("SELECT pg_advisory_xact_lock(hashtext($1))", [pipelineControlStateLockKey(scope, run.projectId)]);
      const command = { pipelineRunId: run.pipelineRunId, nodeKey: "script", idempotencyKey: `output-${suffix}`,
        artifacts: [{ role: "script", schemaVersion: "test/v1", ref: "script.json", sha256: pipelineSha256("script"), logicalHash: pipelineSha256("script"), factsSnapshotHash, contentType: "application/json" }],
      };
      const calls = [coordinator.recordStageOutput(scope, command), coordinator.recordStageOutput(scope, command)];
      const deadline = Date.now() + 3000;
      let waiting = 0;
      while (Date.now() < deadline) {
        const result = await owner.query<{ n: string }>("SELECT count(*)::text AS n FROM pg_stat_activity WHERE application_name=$1 AND wait_event='advisory'", [applicationName]);
        waiting = Number(result.rows[0]?.n);
        if (waiting === 2) break;
        await delay(10);
      }
      await blocker.query("COMMIT");
      locked = false;
      const [first, second] = await Promise.all(calls);
      expect(waiting, "两条真实事务必须在锁上重叠").toBe(2);
      expect(second).toEqual(first);
      const count = await owner.query<{ n: string }>("SELECT count(*)::text AS n FROM video_artifacts WHERE pipeline_run_id=$1", [run.pipelineRunId]);
      expect(count.rows[0]?.n).toBe("1");
    } finally {
      if (locked) await blocker.query("ROLLBACK");
      blocker.release();
    }
  });

  it("同幂等键不同内容拒绝，保持原产物和回执", async () => {
    const run = await createRun("mismatch");
    const command = { pipelineRunId: run.pipelineRunId, nodeKey: "script", idempotencyKey: `mismatch-${suffix}`,
      artifacts: [{ role: "script", schemaVersion: "test/v1", ref: "original.json", sha256: pipelineSha256("original"), logicalHash: pipelineSha256("original"), factsSnapshotHash, contentType: "application/json" }],
    };
    const original = await coordinator.recordStageOutput(scope, command);
    await expect(coordinator.recordStageOutput(scope, { ...command, artifacts: [{ ...command.artifacts[0]!, ref: "changed.json" }] })).rejects.toThrow("IDEMPOTENCY_MISMATCH");
    expect(await coordinator.recordStageOutput(scope, command)).toEqual(original);
    const count = await owner.query<{ n: string }>("SELECT count(*)::text AS n FROM video_artifacts WHERE pipeline_run_id=$1", [run.pipelineRunId]);
    expect(count.rows[0]?.n).toBe("1");
  });
});
