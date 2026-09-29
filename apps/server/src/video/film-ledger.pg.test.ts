/** 固定影片工位台账活库契约：登记修订、作业认领、先留账后外呼、终态不可覆盖。 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";
import { createHash, randomBytes } from "node:crypto";
import { FilmLedger, filmWorkerId } from "./film-ledger.js";
import type { AppPool } from "./gen/db.js";

const RUN_DB = process.env.RUN_DB_TESTS === "1" && Boolean(process.env.DATABASE_URL) && Boolean(process.env.DATABASE_APP_URL);
/** 台账只接受 64 位十六进制；用真实摘要而不是重复字符。 */
const hash = (seed: string): string => createHash("sha256").update(seed).digest("hex");

describe.runIf(RUN_DB)("固定影片工位台账活库契约（T-2026-0927-0039）", () => {
  const owner = new pg.Pool({ connectionString: process.env.DATABASE_URL });
  const app = new pg.Pool({ connectionString: process.env.DATABASE_APP_URL, max: 4, connectionTimeoutMillis: 3_000 });
  const suffix = randomBytes(6).toString("hex");
  const scope = { tenantId: `t-film-${suffix}`, workspaceId: `w-film-${suffix}` };
  const ledger = new FilmLedger(app as unknown as AppPool, scope);
  let projectId = "";

  beforeAll(async () => {
    await owner.query("INSERT INTO tenants (id,name,plan) VALUES ($1,'固定工位契约','community')", [scope.tenantId]);
    await owner.query("INSERT INTO workspaces (id,tenant_id,name,slug,industry) VALUES ($1,$2,'固定工位契约',$1,'general')", [scope.workspaceId, scope.tenantId]);
    projectId = `P-${suffix}`;
    await owner.query("INSERT INTO video_projects (id,workspace_id,title,kind,created_by) VALUES ($1,$2,'固定工位契约片','narrative','MEM-T')", [projectId, scope.workspaceId]);
  });

  afterAll(async () => {
    await owner.end();
    await app.end();
  });

  async function register(sha: string, version = "v1") {
    return ledger.registerWorker({
      workerName: "full-chain-film", workerVersion: version, entryPath: "scripts/tools/full-chain-film.mts",
      entrySha256: sha, capabilities: ["llm", "image", "video", "media", "review", "voice"], actor: "MEM-T",
    });
  }

  async function claim(attemptInput = "a") {
    const worker = await register(hash("1"));
    return ledger.claimJob({
      projectId, workerId: worker.id, runId: `film-run-${suffix}-${attemptInput}`, stages: ["plates", "videos"],
      options: { aspect: "16:9" }, budgetCny: 5, inputRef: `stages/film/inputs/${hash(attemptInput)}.json`,
      inputSha256: hash(attemptInput), workerEntrySha256: hash("1"), actor: "MEM-T",
    });
  }

  it("工位登记：同摘要幂等复用，改摘要必须换修订并停用旧行", async () => {
    const first = await register(hash("1"));
    expect(first.status).toBe("active");
    expect(first.id).toBe(filmWorkerId({ ...scope, workerName: "full-chain-film", entrySha256: hash("1") }));
    const again = await register(hash("1"));
    expect(again.id).toBe(first.id);
    const changed = await register(hash("2"), "v2");
    expect(changed.id).not.toBe(first.id);
    const old = await ledger.workerById(first.id);
    expect(old?.status).toBe("disabled");
    const active = await ledger.activeWorker("full-chain-film");
    expect(active?.entry_sha256).toBe(hash("2"));
  });

  it("作业认领：attempt 递增、输入摘要写死、终态回执不可覆盖", async () => {
    const first = await claim("a");
    expect(first.attempt).toBe(1);
    expect(first.status).toBe("running");
    expect(first.input_sha256).toBe(hash("a"));
    const finished = await ledger.finishJob(first.id, { status: "finished", resultRef: "stages/film/attempt-1/film-result.json", resultSha256: hash("f") });
    expect(finished.status).toBe("finished");
    const sameAgain = await ledger.finishJob(first.id, { status: "finished", resultRef: "stages/film/attempt-1/film-result.json", resultSha256: hash("f") });
    expect(sameAgain.id).toBe(first.id);
    await expect(ledger.finishJob(first.id, { status: "failed", errorMsg: "想覆盖" })).rejects.toMatchObject({ code: "FILM_JOB_RECEIPT_CONFLICT" });
    const second = await claim("b");
    expect(second.attempt).toBe(2);
    await expect(ledger.finishJob(second.id, { status: "finished", resultRef: "x", resultSha256: "short" })).rejects.toMatchObject({ code: "FILM_JOB_RECEIPT_INVALID" });
  });

  it("先留账后外呼：同键幂等、换内容拒绝、超预算拦住", async () => {
    const job = await claim("c");
    const base = { jobId: job.id, component: "image" as const, stepKey: "plates:SC-01", shotId: "SC-01",
      idempotencyKey: "image:plates:SC-01:1", requestHash: hash("r"), payloadHash: hash("p"), reservedCny: 0.3 };
    const reserved = await ledger.reserveComponent(base);
    expect(reserved.deduped).toBe(false);
    expect(reserved.row.state).toBe("reserved");
    const deduped = await ledger.reserveComponent(base);
    expect(deduped.deduped).toBe(true);
    expect(deduped.row.id).toBe(reserved.row.id);
    await expect(ledger.reserveComponent({ ...base, payloadHash: hash("q") })).rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });
    await expect(ledger.reserveComponent({ ...base, idempotencyKey: "image:plates:SC-01:2", reservedCny: 4.8 })).rejects.toMatchObject({ code: "FILM_BUDGET_EXCEEDED" });
    await expect(ledger.reserveComponent({ ...base, idempotencyKey: "image:plates:SC-01:3", stepKey: "not-frozen:1" })).resolves.toMatchObject({ deduped: false });
  });

  it("组件状态机：认领一次、dispatch 记账、接受回执不可返回、作业终态后拒绝新调用", async () => {
    const job = await claim("d");
    const { row } = await ledger.reserveComponent({ jobId: job.id, component: "video", stepKey: "videos:SC-09", shotId: "SC-09",
      idempotencyKey: "video:videos:SC-09:1", requestHash: hash("r2"), payloadHash: hash("p2"), reservedCny: 1.5 });
    const claimed = await ledger.claimComponent(row.id, "owner-1");
    expect(claimed?.state).toBe("dispatched");
    expect(await ledger.claimComponent(row.id, "owner-2")).toBeNull();
    await ledger.recordDispatch(row.id, "owner-1", "seedance", "doubao-test");
    await ledger.recordComponentAccepted(row.id, "owner-1", { provider: "seedance", providerModel: "doubao-test", actualCny: null,
      evidence: { artifactSha256: hash("e"), artifactRef: "clips/SC-09.mp4" } });
    const stored = await ledger.componentById(row.id);
    expect(stored?.state).toBe("accepted");
    expect(stored?.evidence.artifactSha256).toBe(hash("e"));
    await expect(ledger.recordComponentAccepted(row.id, "owner-1", { provider: "seedance", providerModel: "doubao-test", actualCny: null,
      evidence: { artifactSha256: hash("e") } })).rejects.toMatchObject({ code: "FILM_COMPONENT_STATE_CONFLICT" });
    await ledger.finishJob(job.id, { status: "failed", errorClass: "WORKER_EXIT_NONZERO", errorMsg: "测试收尾" });
    await expect(ledger.reserveComponent({ jobId: job.id, component: "llm", stepKey: "cover:1", shotId: null,
      idempotencyKey: "llm:cover:1", requestHash: hash("r3"), payloadHash: hash("p3"), reservedCny: 0.1 }))
      .rejects.toMatchObject({ code: "FILM_JOB_NOT_RUNNING" });
  });

  it("状态视图汇总预占与已接受费用", async () => {
    const job = await claim("e");
    const ok = await ledger.reserveComponent({ jobId: job.id, component: "media", stepKey: "plates:SC-11", shotId: "SC-11",
      idempotencyKey: "media:plates:SC-11:1", requestHash: hash("r4"), payloadHash: hash("p4"), reservedCny: 0.2 });
    await ledger.claimComponent(ok.row.id, "owner-x");
    await ledger.recordDispatch(ok.row.id, "owner-x", "local", "media-fetch");
    await ledger.recordComponentAccepted(ok.row.id, "owner-x", { provider: "local", providerModel: "media-fetch", actualCny: 0,
      evidence: { artifactSha256: hash("a4") } });
    const view = await ledger.jobStatus(job.id);
    expect(view?.components).toHaveLength(1);
    expect(view?.reservedCny).toBeCloseTo(0.2, 4);
    expect(view?.spentCny).toBeCloseTo(0, 4);
  });
});
