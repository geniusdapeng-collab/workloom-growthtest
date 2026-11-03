/** Real component ledger and parent handler, with outbound provider methods stubbed. */
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pg from "pg";
import { newId } from "@workloom/shared";
import { FILM_CHANNEL_METHODS, filmRequestHash, resolveEraProfile, type FilmChannelRequestFrame } from "@hyperreality/video-studio";
import { FilmLedger } from "./film-ledger.js";
import { handleChannelRequest, type RunContext } from "./film-worker.js";
import { ArkImageProvider, ArkVideoProvider } from "./gen/providers.js";

const RUN_DB = process.env.RUN_DB_TESTS === "1" && Boolean(process.env.DATABASE_APP_URL);
const hash = (value: string) => createHash("sha256").update(value).digest("hex");

describe.runIf(RUN_DB)("film provider acceptance survives local failure", () => {
  const owner = new pg.Pool({ connectionString: process.env.DATABASE_URL });
  const app = new pg.Pool({ connectionString: process.env.DATABASE_APP_URL, max: 3 });
  const roots: string[] = [];
  let ctx: RunContext;
  let controller: AbortController;
  let ledger: FilmLedger;
  let scope: { tenantId: string; workspaceId: string };
  beforeEach(async () => {
    const suffix = newId("filmreceipt");
    scope = { tenantId: `tenant-${suffix}`, workspaceId: `ws-${suffix}` };
    const projectId = `P-${suffix}`;
    await owner.query("INSERT INTO tenants (id,name,plan) VALUES ($1,'影片接受回执契约','community')", [scope.tenantId]);
    await owner.query("INSERT INTO workspaces (id,tenant_id,name,slug,industry) VALUES ($1,$2,'影片接受回执契约',$1,'general')", [scope.workspaceId, scope.tenantId]);
    await owner.query("INSERT INTO video_projects (id,workspace_id,title,kind,created_by) VALUES ($1,$2,'影片接受回执片','narrative','test')", [projectId, scope.workspaceId]);
    ledger = new FilmLedger(app, scope);
    const worker = await ledger.registerWorker({ workerName: "full-chain-film", workerVersion: "test-only", entryPath: "scripts/tools/full-chain-film.mts",
      entrySha256: hash("test-worker"), capabilities: [...FILM_CHANNEL_METHODS], actor: "test" });
    const job = await ledger.claimJob({ projectId, workerId: worker.id, runId: `run-${suffix}`, stages: ["plates", "videos"],
      options: { aspect: "16:9", resolution: "720p" }, budgetCny: 10, inputRef: "inputs/source.json", inputSha256: hash("test-frozen"),
      workerEntrySha256: worker.entry_sha256, actor: "test" });
    const root = realpathSync(mkdtempSync(join(tmpdir(), "film-provider-receipt-"))); roots.push(root);
    const workDir = join(root, "attempt-1"); mkdirSync(workDir);
    controller = new AbortController();
    const shot = { shotId: "S1", duration: 5 };
    ctx = { scope, ledger, job, worker, workDir, archiveRoot: root, frozen: { shots: [shot] }, shots: new Map([["S1", shot]]),
      contractSource: { projectId, shots: [shot], eraProfile: resolveEraProfile({ storyDate: "2026-11-03" }) }, env: { VOLCENGINE_ARK_API_KEY: "test-only-never-outbound", SEEDANCE_MODEL: "test-video", SEEDREAM_MODEL: "test-image" },
      issuedUrls: new Map(), videoFiles: new Map(), identityEvidence: new Map(), ownerToken: "test-owner", log: () => undefined, send: () => undefined,
      signal: controller.signal, deadlineAt: Date.now() + 30_000 } as RunContext;
  });
  afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); roots.splice(0).forEach(root => rmSync(root, { recursive: true, force: true })); });
  afterAll(async () => { await Promise.all([owner.end(), app.end()]); });

  const frame = (kind: "image" | "video"): FilmChannelRequestFrame => {
    const method = kind === "image" ? "image.generate" : "video.generate";
    const stepKey = `${kind === "image" ? "plates" : "videos"}:S1`;
    const params = kind === "image" ? { prompt: "测试空镜", size: "1024x1024", anchors: [], targetRef: "images/S1.png" }
      : { prompt: "测试空镜", refs: [], seconds: 5, generateAudio: true, aspect: "16:9", resolution: "720p", targetRef: "clips/S1.mp4" };
    return { kind: "film.request", id: `frame-${kind}`, method, component: kind, stepKey, shotId: "S1", params,
      idempotencyKey: `idem-${kind}`, requestHash: filmRequestHash({ method, stepKey, shotId: "S1", params }) };
  };
  const component = async () => (await owner.query("SELECT * FROM film_component_requests WHERE job_id=$1", [ctx.job.id])).rows[0];

  it("persists the accepted video task before cancellation, leaving the receipt available for reconciliation", async () => {
    const submit = vi.spyOn(ArkVideoProvider.prototype, "submit").mockImplementation(async () => { controller.abort(); return { taskId: "already-paid-video-task" }; });
    const poll = vi.spyOn(ArkVideoProvider.prototype, "poll");
    await expect(handleChannelRequest(ctx, frame("video"))).rejects.toThrow(/DEADLINE|TIMEOUT/);
    await vi.waitFor(async () => expect((await component()).evidence).toMatchObject({ providerTaskId: "already-paid-video-task", providerRequestHash: expect.stringMatching(/^[a-f0-9]{64}$/) }));
    expect((await component()).state).toBe("unknown");
    expect(submit).toHaveBeenCalledTimes(1); expect(poll).not.toHaveBeenCalled();
  });

  it("retains the known synchronous image task when its media download fails, and refuses replay", async () => {
    const taskId = `sync-url-${Buffer.from("https://cdn.example.test/accepted.png").toString("base64url")}`;
    const submit = vi.spyOn(ArkImageProvider.prototype, "submit").mockResolvedValue({ taskId });
    vi.stubGlobal("fetch", vi.fn(async () => new Response("temporary", { status: 503 })));
    await expect(handleChannelRequest(ctx, frame("image"))).rejects.toThrow("MEDIA_FETCH_FAILED");
    const row = await component();
    expect(row.evidence).toMatchObject({ providerTaskId: taskId, providerRequestHash: expect.stringMatching(/^[a-f0-9]{64}$/), failureClass: "MEDIA_FETCH_FAILED" });
    await expect(handleChannelRequest(ctx, frame("image"))).rejects.toThrow(/CLAIM|RECONCILIATION/);
    expect(submit).toHaveBeenCalledTimes(1);
  });

  it("records a provider acknowledgement that arrives after the abort already marked the component unknown", async () => {
    let acknowledge!: (value: { taskId: string }) => void;
    const accepted = new Promise<{ taskId: string }>(resolve => { acknowledge = resolve; });
    const submit = vi.spyOn(ArkVideoProvider.prototype, "submit").mockReturnValue(accepted);
    const pending = handleChannelRequest(ctx, frame("video"));
    await vi.waitFor(() => expect(submit).toHaveBeenCalledTimes(1));
    controller.abort(); await expect(pending).rejects.toThrow("DEADLINE");
    expect((await component()).state).toBe("unknown");
    acknowledge({ taskId: "late-paid-video-task" });
    await vi.waitFor(async () => expect((await component()).evidence.providerTaskId).toBe("late-paid-video-task"));
    expect((await component()).state).toBe("unknown"); expect(submit).toHaveBeenCalledTimes(1);
  });

  it("retains a late provider acknowledgement when its first database write fails after cancellation", async () => {
    let acknowledge!: (value: { taskId: string }) => void;
    let injected = false;
    const faultApp = { connect: async () => {
      const client = await app.connect();
      return { query: async (sql: string, params?: unknown[]) => {
        if (!injected && sql.includes("'providerTaskId',$5")) { injected = true; throw new Error("injected late receipt write failure"); }
        return client.query(sql, params);
      }, release: (discard?: boolean) => client.release(discard) };
    } } as unknown as pg.Pool;
    ctx.ledger = new FilmLedger(faultApp, scope);
    const accepted = new Promise<{ taskId: string }>(resolve => { acknowledge = resolve; });
    const submit = vi.spyOn(ArkVideoProvider.prototype, "submit").mockReturnValue(accepted);
    const poll = vi.spyOn(ArkVideoProvider.prototype, "poll").mockResolvedValue({ status: "submitted" });
    const pending = handleChannelRequest(ctx, frame("video"));
    await vi.waitFor(() => expect(submit).toHaveBeenCalledTimes(1));
    controller.abort();
    await expect(pending).rejects.toThrow("DEADLINE");
    expect((await component()).state).toBe("unknown");
    acknowledge({ taskId: "late-paid-video-with-write-fault" });
    await vi.waitFor(() => expect(injected).toBe(true));
    await vi.waitFor(async () => expect((await component()).evidence).toMatchObject({
      providerTaskId: "late-paid-video-with-write-fault", providerRequestHash: expect.stringMatching(/^[a-f0-9]{64}$/),
    }));
    expect((await component()).state).toBe("unknown");
    expect((await component()).dispatch_count).toBe(1);
    expect(poll).not.toHaveBeenCalled();
  });

  it("the database rejects replacing a known provider task or request even on an unknown component", async () => {
    const reserved = await ledger.reserveComponent({ jobId: ctx.job.id, component: "video", stepKey: "videos:S1", shotId: "S1",
      idempotencyKey: "guard-task", requestHash: hash("guard-request"), payloadHash: hash("guard-payload"), reservedCny: 1 });
    await ledger.claimComponent(reserved.row.id, ctx.ownerToken);
    await ledger.recordDispatch(reserved.row.id, ctx.ownerToken, "seedance", "test-video");
    await owner.query("UPDATE film_component_requests SET state='unknown',evidence=$2::jsonb WHERE id=$1", [reserved.row.id,
      JSON.stringify({ providerTaskId: "known-paid-task", providerRequestHash: hash("compiled-request") })]);
    await expect(owner.query("UPDATE film_component_requests SET evidence=jsonb_set(evidence,'{providerTaskId}','\"another-task\"') WHERE id=$1", [reserved.row.id]))
      .rejects.toThrow("provider acceptance receipt is immutable");
    await expect(owner.query("UPDATE film_component_requests SET evidence='{}'::jsonb WHERE id=$1", [reserved.row.id]))
      .rejects.toThrow("provider acceptance receipt is immutable");
  });

  it("a transient acceptance write failure keeps the known task in its unknown failure receipt and never polls or submits twice", async () => {
    let injected = false;
    const faultApp = { connect: async () => {
      const client = await app.connect();
      return { query: async (sql: string, params?: unknown[]) => {
        if (!injected && sql.includes("'providerTaskId',$5")) { injected = true; throw new Error("injected acceptance write failure"); }
        return client.query(sql, params);
      }, release: (discard?: boolean) => client.release(discard) };
    } } as unknown as pg.Pool;
    ctx.ledger = new FilmLedger(faultApp, scope);
    const submit = vi.spyOn(ArkVideoProvider.prototype, "submit").mockResolvedValue({ taskId: "known-after-db-fault" });
    const poll = vi.spyOn(ArkVideoProvider.prototype, "poll");
    await expect(handleChannelRequest(ctx, frame("video"))).rejects.toMatchObject({ code: "PROVIDER_ACCEPTANCE_UNKNOWN", details: { taskId: "known-after-db-fault" } });
    expect((await component()).state).toBe("unknown"); expect((await component()).evidence.providerTaskId).toBe("known-after-db-fault");
    await expect(handleChannelRequest(ctx, frame("video"))).rejects.toThrow("RECONCILIATION_REQUIRED");
    expect(submit).toHaveBeenCalledTimes(1); expect(poll).not.toHaveBeenCalled();
  });

  it("a normal image completion preserves the acceptance time and exposes its task in the scoped status view", async () => {
    const taskId = `sync-url-${Buffer.from("https://cdn.example.test/accepted.png").toString("base64url")}`;
    vi.spyOn(ArkImageProvider.prototype, "submit").mockResolvedValue({ taskId });
    const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a/ZkAAAAASUVORK5CYII=", "base64");
    vi.stubGlobal("fetch", vi.fn(async () => new Response(png)));
    await handleChannelRequest(ctx, frame("image"));
    const row = await component();
    expect(row.state).toBe("accepted"); expect(row.evidence.providerAcceptedAt).toEqual(expect.any(String));
    expect(row.evidence.artifactSha256).toBe(createHash("sha256").update(png).digest("hex"));
    expect((await ledger.jobStatus(ctx.job.id))?.components[0]).toMatchObject({ provider: "seedream", providerModel: "test-image", providerTaskId: taskId,
      providerRequestHash: row.evidence.providerRequestHash });
  });

  it("same-task late evidence is idempotent but different task, request, owner, model, or scope cannot replace it", async () => {
    const reserved = await ledger.reserveComponent({ jobId: ctx.job.id, component: "video", stepKey: "videos:S1", shotId: "S1",
      idempotencyKey: "immutable-receipt", requestHash: hash("immutable-request"), payloadHash: hash("immutable-payload"), reservedCny: 1 });
    await ledger.claimComponent(reserved.row.id, ctx.ownerToken); await ledger.recordDispatch(reserved.row.id, ctx.ownerToken, "seedance", "test-video");
    const receipt = { provider: "seedance", providerModel: "test-video", taskId: "immutable-known-task", providerRequestHash: hash("compiled-immutable") };
    await ledger.recordProviderAcceptance(reserved.row.id, ctx.ownerToken, receipt);
    const acceptedAt = (await component()).evidence.providerAcceptedAt;
    await ledger.recordComponentFailure(reserved.row.id, ctx.ownerToken, { state: "unknown", failureClass: "PROVIDER_TIMEOUT_UNKNOWN", evidence: { message: "query pending" } });
    await ledger.recordProviderAcceptance(reserved.row.id, ctx.ownerToken, receipt);
    expect((await component()).evidence.providerAcceptedAt).toBe(acceptedAt);
    for (const patch of [{ taskId: "other-task" }, { providerRequestHash: hash("other-request") }, { providerModel: "other-model" }, { provider: "other-provider" }]) {
      await expect(ledger.recordProviderAcceptance(reserved.row.id, ctx.ownerToken, { ...receipt, ...patch })).rejects.toThrow("FILM_COMPONENT_STATE_CONFLICT");
    }
    await expect(ledger.recordProviderAcceptance(reserved.row.id, "other-owner", receipt)).rejects.toThrow("FILM_COMPONENT_STATE_CONFLICT");
    await expect(new FilmLedger(app, { ...scope, tenantId: "wrong-tenant" }).recordProviderAcceptance(reserved.row.id, ctx.ownerToken, receipt))
      .rejects.toThrow("FILM_COMPONENT_STATE_CONFLICT");
    expect((await component()).evidence).toMatchObject({ providerTaskId: receipt.taskId, providerRequestHash: receipt.providerRequestHash });
    expect((await component()).dispatch_count).toBe(1);
  });
});
