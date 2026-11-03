/** Real PG/RLS with provider and download fixtures; never creates a paid generation. */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pg from "pg";
import { newId } from "@workloom/shared";
import type { GenProvider } from "@workloom/base/model-router";
import { pollRenderJobs } from "./render-poller.js";
import { ArkVideoProvider } from "./gen/providers.js";

const RUN_DB = process.env.RUN_DB_TESTS === "1" && Boolean(process.env.DATABASE_APP_URL);

describe.runIf(RUN_DB)("render poller persisted recovery and isolation", () => {
  const owner = new pg.Pool({ connectionString: process.env.DATABASE_URL });
  const app = new pg.Pool({ connectionString: process.env.DATABASE_APP_URL, max: 3 });
  const gateway = new pg.Pool({ connectionString: process.env.DATABASE_GATEWAY_URL, max: 1 });
  let scope: { tenantId: string; workspaceId: string };
  let projectId: string;
  let scriptId: string;
  let jobId: string;
  let mediaDir: string;
  const uri = "https://cdn.example.test/poller-fixture.mp4";
  const provider = (poll: GenProvider["poll"]): GenProvider => ({ providerId: "seedance", kind: "video",
    healthy: async () => true, submit: async () => { throw new Error("polling must never submit"); }, poll });
  const options = (poll: GenProvider["poll"], extra = {}) => ({ pool: new Map([["seedance", provider(poll)]]), archive: null, ...extra });
  const job = async () => (await owner.query("SELECT * FROM render_jobs WHERE id=$1", [jobId])).rows[0];
  const actions = async () => (await owner.query<{ action: string }>(`SELECT payload->'decision'->>'action' AS action
    FROM biz_events WHERE workspace_id=$1 AND payload->'object'->>'id'=$2 ORDER BY seq`, [scope.workspaceId, jobId])).rows.map(row => row.action);

  beforeAll(() => { mediaDir = mkdtempSync(join(tmpdir(), "workloom-poller-test-")); });
  beforeEach(async () => {
    vi.stubEnv("WORKLOOM_MEDIA_DIR", mediaDir);
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
  afterAll(async () => { await Promise.all([owner.end(), app.end(), gateway.end()]); rmSync(mediaDir, { recursive: true, force: true }); });

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

  it("a nonmock accepted task cannot become mock:// success after provider credentials disappear", async () => {
    for (const key of ["VOLCENGINE_ARK_API_KEY", "HF_API_KEY_ID", "HF_API_KEY_SECRET", "MUAPI_API_KEY", "KLING_API_KEY", "JIMENG_API_KEY"]) vi.stubEnv(key, "");
    vi.stubEnv("WHITEBOARD_ENABLED", "0"); vi.stubEnv("TALKCRAFT_ENABLED", "0");
    const fetch = vi.fn(async () => { throw new Error("no outbound request expected"); }); vi.stubGlobal("fetch", fetch);
    const report = await pollRenderJobs(app, gateway, scope, { ingest: false, archive: null });
    expect(report.done).toBe(0); expect((await job()).result_url).toBeNull();
    expect(await actions()).toEqual([]); expect(fetch).not.toHaveBeenCalled();
  });

  it("a real task ID beginning mock- still uses the real provider and a truthful receipt", async () => {
    await owner.query("UPDATE render_jobs SET task_id='mock-prefix-real-task' WHERE id=$1", [jobId]);
    const poll = vi.fn(async () => ({ status: "succeeded" as const, uri, actualUnits: 5 }));
    await pollRenderJobs(app, gateway, scope, options(poll, { ingest: false }));
    expect(poll).toHaveBeenCalledWith("mock-prefix-real-task");
    expect((await job()).result_url).toBe(uri);
    const event = (await owner.query(`SELECT payload FROM biz_events WHERE workspace_id=$1
      AND payload->'decision'->>'action'='render.complete'`, [scope.workspaceId])).rows[0].payload;
    expect(event.decision.after.mock).toBe(false); expect(event.receipt.synced).toBe(true);
  });

  it("a simulated row uses its persisted mock flag even when its task ID has no prefix", async () => {
    await owner.query("UPDATE render_jobs SET mock=true WHERE id=$1", [jobId]);
    const poll = vi.fn(async () => { throw new Error("real provider must not run for a mock row"); });
    const report = await pollRenderJobs(app, gateway, scope, options(poll, { ingest: false }));
    expect(poll).not.toHaveBeenCalled(); expect(report.done).toBe(1);
    const event = (await owner.query(`SELECT payload FROM biz_events WHERE workspace_id=$1
      AND payload->'decision'->>'action'='render.complete'`, [scope.workspaceId])).rows[0].payload;
    expect(event.decision.after.mock).toBe(true); expect(event.receipt).toMatchObject({ synced: false, mode: "simulated" });
  });

  it("a real provider cannot turn a simulated URI or missing URI into an external success receipt", async () => {
    for (const invalidUri of ["mock://gen/forged.mp4", undefined, " "]) {
      const report = await pollRenderJobs(app, gateway, scope, options(async () => ({ status: "succeeded", uri: invalidUri }), { ingest: false }));
      expect(report.done).toBe(0); expect((await job()).result_url).toBeNull();
      expect(await actions()).toEqual([]);
    }
  });
  it("a failed first download is retried from its persisted result without a second generation or completion event", async () => {
    const poll = vi.fn(async () => ({ status: "succeeded" as const, uri, actualUnits: 5 }));
    const fetchImpl = vi.fn(async () => new Response("temporary", { status: 503 }));
    const first = await pollRenderJobs(app, gateway, scope, options(poll, { fetchImpl }));
    expect(first.details[0]?.ingestError).toContain("503"); expect((await job()).status).toBe("done");
    // A valid PNG allows the real register/probe/column pipeline to execute without a paid renderer.
    const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a/ZkAAAAASUVORK5CYII=", "base64");
    const retryFetch = vi.fn(async () => new Response(png, { headers: { "content-type": "image/png" } }));
    const second = await pollRenderJobs(app, gateway, scope, { pool: new Map(), archive: null, fetchImpl: retryFetch });
    expect(second.ingested).toBe(1); expect((await job()).asset_id).toEqual(expect.any(String));
    expect(poll).toHaveBeenCalledTimes(1); expect(retryFetch).toHaveBeenCalledWith(uri, expect.any(Object));
    expect((await actions()).filter(action => action === "render.complete")).toHaveLength(1);
    expect(await actions()).toContain("render.ingested");
  });

  it("concurrent batches finalize one job once and cannot duplicate its completion event", async () => {
    let release!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    const poll = vi.fn(async () => { await held; return { status: "succeeded" as const, uri, actualUnits: 5 }; });
    const first = pollRenderJobs(app, gateway, scope, options(poll, { ingest: false }));
    await vi.waitFor(() => expect(poll).toHaveBeenCalledTimes(1));
    const second = pollRenderJobs(app, gateway, scope, options(poll, { ingest: false }));
    await new Promise(resolve => setTimeout(resolve, 30)); release();
    await Promise.all([first, second]);
    expect(poll).toHaveBeenCalledTimes(1);
    expect((await actions()).filter(action => action === "render.complete")).toHaveLength(1);
  });

  it("terminal transaction failure releases the gateway client and leaves a retryable job", async () => {
    const client = await gateway.connect(); let released = false;
    const faultGateway = { connect: async () => ({
      query: async (sql: string, params?: unknown[]) => { if (sql.includes("UPDATE render_jobs")) throw new Error("injected terminal SQL failure"); return client.query(sql, params); },
      release: () => { released = true; client.release(); },
    }) } as unknown as pg.Pool;
    try {
      await expect(pollRenderJobs(app, faultGateway, scope, options(async () => ({ status: "failed", error: "provider failed" })))).rejects.toThrow("injected terminal SQL failure");
      expect(released).toBe(true); expect((await job()).status).toBe("submitted");
    } finally { if (!released) client.release(); }
  });

  it("completion with a failed cost write is reconciled once without polling the provider again", async () => {
    let injected = false;
    const faultApp = { connect: async () => {
      const client = await app.connect();
      return { query: async (sql: string, params?: unknown[]) => {
        if (!injected && sql.includes("INSERT INTO budget_ledger")) { injected = true; throw new Error("injected cost write failure"); }
        return client.query(sql, params);
      }, release: (discard?: boolean) => client.release(discard) };
    } } as unknown as pg.Pool;
    const poll = vi.fn(async () => ({ status: "succeeded" as const, uri, actualUnits: 5 }));
    const first = await pollRenderJobs(faultApp, gateway, scope, options(poll, { ingest: false }));
    expect(first.details[0]?.costError).toContain("injected cost write failure");
    await pollRenderJobs(app, gateway, scope, options(poll, { ingest: false }));
    const costs = await owner.query("SELECT * FROM budget_ledger WHERE workspace_id=$1 AND idempotency_key=$2", [scope.workspaceId, `render:${jobId}`]);
    expect(costs.rows).toHaveLength(1); expect(poll).toHaveBeenCalledTimes(1);
    expect((await actions()).filter(action => action === "render.complete")).toHaveLength(1);
  });

  it("a provider that stays queued beyond the configured job age also reaches a scoped failure", async () => {
    await owner.query("UPDATE render_jobs SET created_at=now()-interval '30 hours' WHERE id=$1", [jobId]);
    const report = await pollRenderJobs(app, gateway, scope, options(async () => ({ status: "submitted" })));
    expect(report.failed).toBe(1); expect((await job()).status).toBe("failed");
    expect(await actions()).toEqual(["render.failed"]);
  });

  it("a failed HTTP lookup recovers the accepted provider task on the next batch with no POST", async () => {
    const fetch = vi.fn()
      .mockResolvedValueOnce(new Response("unavailable", { status: 503 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ status: "succeeded", duration: 5, content: { video_url: uri } })));
    vi.stubGlobal("fetch", fetch);
    const opts = { pool: new Map([["seedance", new ArkVideoProvider({ apiKey: "test-only" })]]), ingest: false, archive: null };
    expect((await pollRenderJobs(app, gateway, scope, opts)).running).toBe(1);
    expect((await job()).status).toBe("rendering");
    expect((await pollRenderJobs(app, gateway, scope, opts)).done).toBe(1);
    expect((await job()).actual_seconds).toBe(5);
    expect(fetch).toHaveBeenCalledTimes(2); expect(fetch.mock.calls.every(call => call[1].method === "GET")).toBe(true);
    expect(await actions()).toEqual(["render.complete"]);
  });

  it("a competing poller skips a held job lock without opening another paid lookup", async () => {
    const wideGateway = new pg.Pool({ connectionString: process.env.DATABASE_GATEWAY_URL, max: 2 });
    let release!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    const poll = vi.fn(async () => { await held; return { status: "succeeded" as const, uri, actualUnits: 5 }; });
    const first = pollRenderJobs(app, wideGateway, scope, options(poll, { ingest: false }));
    try {
      await vi.waitFor(() => expect(poll).toHaveBeenCalledTimes(1));
      const second = await pollRenderJobs(app, wideGateway, scope, options(poll, { ingest: false }));
      expect(second.checked).toBe(0); expect(poll).toHaveBeenCalledTimes(1);
    } finally { release(); await first; await wideGateway.end(); }
    expect((await actions()).filter(action => action === "render.complete")).toHaveLength(1);
  });

  it("an external terminal change while polling cannot be overwritten by a stale success", async () => {
    let release!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    const poll = vi.fn(async () => { await held; return { status: "succeeded" as const, uri, actualUnits: 5 }; });
    const pending = pollRenderJobs(app, gateway, scope, options(poll, { ingest: false }));
    await vi.waitFor(() => expect(poll).toHaveBeenCalledTimes(1));
    await owner.query("UPDATE render_jobs SET status='failed' WHERE id=$1", [jobId]);
    release(); const report = await pending;
    expect(report.done).toBe(0); expect((await job()).status).toBe("failed");
    expect(await actions()).toEqual([]);
  });

  it("a lost terminal COMMIT acknowledgement is reconciled from the persisted receipt without polling again", async () => {
    const client = await gateway.connect(); let armed = false; let injected = false; let released = false;
    const faultGateway = { connect: async () => ({
      query: async (sql: string, params?: unknown[]) => {
        if (sql.includes("UPDATE render_jobs")) armed = true;
        const result = await client.query(sql, params);
        if (!injected && armed && sql === "COMMIT") { injected = true; throw new Error("injected COMMIT acknowledgement lost"); }
        return result;
      }, release: (discard?: boolean) => { released = true; client.release(discard); },
    }) } as unknown as pg.Pool;
    const poll = vi.fn(async () => ({ status: "succeeded" as const, uri, actualUnits: 5 }));
    try {
      await expect(pollRenderJobs(app, faultGateway, scope, options(poll, { ingest: false }))).rejects.toThrow("COMMIT acknowledgement lost");
      expect(released).toBe(true); expect((await job()).status).toBe("done");
    } finally { if (!released) client.release(); }
    await pollRenderJobs(app, gateway, scope, { pool: new Map(), ingest: false, archive: null });
    expect(poll).toHaveBeenCalledTimes(1); expect(await actions()).toEqual(["render.complete"]);
    const costs = await owner.query("SELECT id FROM budget_ledger WHERE workspace_id=$1 AND idempotency_key=$2", [scope.workspaceId, `render:${jobId}`]);
    expect(costs.rows).toHaveLength(1);
  });
});
