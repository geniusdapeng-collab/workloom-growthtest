/** Real PG/RLS with provider and download fixtures; never creates a paid generation. */
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import pg from "pg";
import { newId } from "@workloom/shared";
import type { GenProvider } from "@workloom/base/model-router";
import { pollRenderJobs } from "./render-poller.js";

const RUN_DB = process.env.RUN_DB_TESTS === "1" && Boolean(process.env.DATABASE_APP_URL);

describe.runIf(RUN_DB)("render poller persisted recovery and isolation", () => {
  const owner = new pg.Pool({ connectionString: process.env.DATABASE_URL });
  const app = new pg.Pool({ connectionString: process.env.DATABASE_APP_URL, max: 3 });
  const gateway = new pg.Pool({ connectionString: process.env.DATABASE_GATEWAY_URL, max: 1 });
  let scope: { tenantId: string; workspaceId: string };
  let projectId: string;
  let scriptId: string;
  let jobId: string;
  const uri = "https://cdn.example.test/poller-fixture.mp4";
  const provider = (poll: GenProvider["poll"]): GenProvider => ({ providerId: "seedance", kind: "video",
    healthy: async () => true, submit: async () => { throw new Error("polling must never submit"); }, poll });
  const options = (poll: GenProvider["poll"], extra = {}) => ({ pool: new Map([["seedance", provider(poll)]]), archive: null, ...extra });
  const job = async () => (await owner.query("SELECT * FROM render_jobs WHERE id=$1", [jobId])).rows[0];
  const actions = async () => (await owner.query<{ action: string }>(`SELECT payload->'decision'->>'action' AS action
    FROM biz_events WHERE workspace_id=$1 AND payload->'object'->>'id'=$2 ORDER BY seq`, [scope.workspaceId, jobId])).rows.map(row => row.action);

  beforeEach(async () => {
    const suffix = newId("poll");
    scope = { tenantId: `tenant-${suffix}`, workspaceId: `ws-${suffix}` };
    projectId = `VID-${suffix}`; scriptId = `RS-${suffix}`; jobId = `RJ-${suffix}`;
    await owner.query("INSERT INTO tenants (id,name,plan) VALUES ($1,'轮询恢复契约','community')", [scope.tenantId]);
    await owner.query("INSERT INTO workspaces (id,tenant_id,name,slug,industry) VALUES ($1,$2,'轮询恢复契约',$1,'general')", [scope.workspaceId, scope.tenantId]);
    await owner.query("INSERT INTO video_projects (id,workspace_id,title,kind,created_by) VALUES ($1,$2,'轮询恢复片','narrative','test')", [projectId, scope.workspaceId]);
    await owner.query(`INSERT INTO render_scripts (id,workspace_id,project_id,shot_id,script_key,version,status,md,created_by)
      VALUES ($1,$2,$3,'shot-1',$1,1,'submitted','五秒玻璃杯镜头','test')`, [scriptId, scope.workspaceId, projectId]);
    await owner.query(`INSERT INTO render_jobs (id,workspace_id,project_id,script_id,script_version,task_id,provider,mock,est_seconds)
      VALUES ($1,$2,$3,$4,1,'accepted-task','seedance',false,5)`, [jobId, scope.workspaceId, projectId, scriptId]);
  });
  afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });
  // Evidence events are append-only; keep the isolated test tenants for inspection.
  afterAll(async () => { await Promise.all([owner.end(), app.end(), gateway.end()]); });

  it("running progress is written with real app-role RLS, rather than a zero-row bare update", async () => {
    const report = await pollRenderJobs(app, gateway, scope, options(async () => ({ status: "running" })));
    expect(report.running).toBe(1);
    expect((await job()).status).toBe("rendering");
  });

  it("missing-provider timeout persists a scoped terminal row and its failure event", async () => {
    await owner.query("UPDATE render_jobs SET created_at=now()-interval '30 hours' WHERE id=$1", [jobId]);
    const report = await pollRenderJobs(app, gateway, scope, { pool: new Map(), archive: null });
    expect(report.failed).toBe(1);
    expect((await job()).status).toBe("failed");
    expect(await actions()).toEqual(["render.failed"]);
  });

  it("a different workspace cannot poll, modify, or emit an event for the job", async () => {
    const poll = vi.fn(async () => ({ status: "failed" as const }));
    const report = await pollRenderJobs(app, gateway, { ...scope, workspaceId: "unrelated-workspace" }, options(poll));
    expect(report.checked).toBe(0); expect(poll).not.toHaveBeenCalled();
    expect((await job()).status).toBe("submitted"); expect(await actions()).toEqual([]);
  });

});
