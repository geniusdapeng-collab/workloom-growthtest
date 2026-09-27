/** 真 PG：唯一预占/CAS、RLS、不可变回执、接受后短事务及 COMMIT ack 丢失。供应商均注入测试替身，不触网。 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import pg from "pg";
import { newId } from "@workloom/shared";
import { SubmissionLedger, submissionRequestHash } from "./submission-ledger.js";
import { submitGenJob, type RenderScriptLike, type SubmitGenJobInput } from "./submit.js";

/** 该契约专测已获资格后的账本原子性；production-authority.pg.test 使用真实发行/验签链。 */
vi.mock("../production-authority.js", () => ({ authorizeRenderSubmission: async (input: SubmitGenJobInput) => {
  const { compileRenderRequest } = await import("./compiled-request.js");
  const { getModel } = await import("./catalog.js");
  const built = compileRenderRequest({ ...input, model: getModel(input.modelId)!, env: input.env ?? {} });
  return { compiled: built.compiled, requestHash: built.requestHash, reconciliationOnly: false, release: async () => undefined };
} }));
const providers = vi.hoisted(() => ({ submit: vi.fn() }));
vi.mock("./providers.js", () => ({ videoGenPool: () => new Map([
  ["seedance", { healthy: async () => true, submit: providers.submit }],
]) }));
const RUN_DB = process.env.RUN_DB_TESTS === "1" && Boolean(process.env.DATABASE_APP_URL);

describe.runIf(RUN_DB)("生成预占与接受回执活库契约", () => {
  const owner = new pg.Pool({ connectionString: process.env.DATABASE_URL });
  const app = new pg.Pool({ connectionString: process.env.DATABASE_APP_URL });
  const gateway = new pg.Pool({ connectionString: process.env.DATABASE_GATEWAY_URL });
  const suffix = newId("suite");
  const scope = { tenantId: `tenant-gen-${suffix}`, workspaceId: `ws-gen-${suffix}` };
  const other = { tenantId: `tenant-gen-other-${suffix}`, workspaceId: `ws-gen-other-${suffix}` };
  const projectId = `VID-GEN-${suffix}`;
  const otherProjectId = `VID-GEN-OTHER-${suffix}`;
  const ledger = new SubmissionLedger(app, scope);
  let seq = 0;

  beforeAll(async () => {
    for (const [context, project] of [[scope, projectId], [other, otherProjectId]] as const) {
      await owner.query("INSERT INTO tenants (id, name, plan) VALUES ($1,'生成提交契约租户','community')", [context.tenantId]);
      await owner.query("INSERT INTO workspaces (id,tenant_id,name,slug,industry) VALUES ($1,$2,'生成提交契约',$1,'general')", [context.workspaceId, context.tenantId]);
      await owner.query("INSERT INTO video_projects (id,workspace_id,title,kind,created_by) VALUES ($1,$2,'生成提交契约片','narrative','MEM-T')", [project, context.workspaceId]);
    }
  });
  // 五元事件 append-only，测试租户及关联证据按设计保留；不能删除链或吞掉 FK 清理失败。
  afterAll(async () => { await Promise.all([owner.end(), app.end(), gateway.end()]); });
  beforeEach(() => { providers.submit.mockReset().mockResolvedValue({ taskId: `provider-${suffix}-${seq}` }); });

  async function script(context = scope, project = projectId, idPrefix = "RS"): Promise<RenderScriptLike> {
    const id = `${idPrefix}-${suffix}-${seq++}`;
    const row: RenderScriptLike = { id, project_id: project, shot_id: `shot-${seq}`, script_key: id,
      version: 1, status: "approved", md: "固定机位拍摄玻璃杯，五秒", fields: { durationSec: 5, nested: { a: 1, b: 2 } } };
    await owner.query(`INSERT INTO render_scripts
      (id,workspace_id,project_id,shot_id,script_key,version,status,md,fields,created_by)
      VALUES ($1,$2,$3,$4,$5,1,'approved',$6,$7::jsonb,'MEM-T')`,
      [id, context.workspaceId, project, row.shot_id, row.script_key, row.md, JSON.stringify(row.fields)]);
    return row;
  }
  function reserveInput(row: RenderScriptLike, key = `key-${row.id}`) {
    return { projectId: row.project_id, scriptId: row.id, scriptVersion: row.version, key,
      requestHash: submissionRequestHash({ id: row.id, md: row.md }),
      script: { shot_id: row.shot_id, script_key: row.script_key, md: row.md, fields: row.fields } };
  }
  function submitInput(row: RenderScriptLike, pool = app): SubmitGenJobInput {
    return { app: pool, gateway, scope, actor: "MEM-T", script: row, modelId: "doubao-seedance-2-5",
      params: { durationSec: 5, aspectRatio: "16:9", extra: { source: "pg-test" } },
      mode: "manual", fenceLevel: "auto", fenceImpacts: [], env: { VOLCENGINE_ARK_API_KEY: "test-only" } };
  }
  async function counts(id: string) {
    const jobs = await owner.query("SELECT id FROM render_jobs WHERE script_id=$1", [id]);
    const events = await owner.query<{ action: string }>(`SELECT payload->'decision'->>'action' AS action FROM biz_events
      WHERE workspace_id=$1 AND (payload->'object'->>'id'=$2 OR payload->'decision'->'after'->>'jobId'
        IN (SELECT id FROM render_jobs WHERE script_id=$2)) ORDER BY seq`, [scope.workspaceId, id]);
    return { jobs: jobs.rowCount, actions: events.rows.map(row => row.action) };
  }
  /** 只在指定 SQL/COMMIT 点注入一次异常；其余连接与事务是实际 PG。 */
  function faultPool(needle: string, mode: "before" | "commit-before" | "commit-after" = "before") {
    let injected = false;
    return { connect: async () => {
      const client = await app.connect();
      let armed = false;
      return {
        query: async (sql: string, params?: unknown[]) => {
          if (!injected && sql.includes(needle)) {
            if (mode === "before") { injected = true; throw new Error("injected SQL failure"); }
            armed = true;
          }
          if (!injected && armed && sql === "COMMIT") {
            injected = true;
            if (mode === "commit-after") await client.query(sql, params);
            throw new Error("injected COMMIT ack failure");
          }
          return client.query(sql, params);
        },
        release: (discard?: boolean) => client.release(discard),
      };
    } } as unknown as pg.Pool;
  }

  it("16 个并发预占同 key 得同一行；16 个 CAS 只认领一次", async () => {
    const source = await script();
    const rows = await Promise.all(Array.from({ length: 16 }, () => ledger.reserve(reserveInput(source))));
    expect(new Set(rows.map(row => row.id)).size).toBe(1);
    const claims = await Promise.all(rows.map((row, index) => ledger.claim(row, `owner-${index}`)));
    expect(claims.filter(Boolean)).toHaveLength(1);
  });
  it("并发相同 key 不同 hash 只有一个成功；内容不能被抢占覆盖", async () => {
    const source = await script(), input = reserveInput(source);
    const results = await Promise.allSettled([
      ledger.reserve(input), ledger.reserve({ ...input, requestHash: submissionRequestHash({ changed: true }) }),
    ]);
    expect(results.filter(result => result.status === "fulfilled")).toHaveLength(1);
    const rejected = results.find(result => result.status === "rejected") as PromiseRejectedResult;
    expect(rejected.reason.code).toBe("IDEMPOTENCY_CONFLICT");
  });
  it("越租户/工作区/项目/版本以及替换正文，在 provider 前失败", async () => {
    const source = await script();
    for (const changed of [{ project_id: otherProjectId }, { version: 2 }, { md: "伪造脚本" }, { fields: { durationSec: 99 } }]) {
      await expect(submitGenJob(submitInput({ ...source, ...changed }))).rejects.toThrow(/SCRIPT_(SCOPE|CONTENT)_MISMATCH/);
    }
    await expect(new SubmissionLedger(app, other).reserve(reserveInput(source))).rejects.toThrow("SCRIPT_SCOPE_MISMATCH");
    await expect(new SubmissionLedger(app, { ...scope, tenantId: other.tenantId }).reserve(reserveInput(source))).rejects.toThrow("SCRIPT_SCOPE_MISMATCH");
    expect(providers.submit).not.toHaveBeenCalled();
  });
  it("RLS 未设 GUC/错租户不可见，同 key 在另一租户工作区独立", async () => {
    const source = await script(); const reserved = await ledger.reserve(reserveInput(source, "scope-key"));
    const bare = await app.query("SELECT id FROM generation_submissions WHERE id=$1", [reserved.id]);
    expect(bare.rows).toHaveLength(0);
    expect(await new SubmissionLedger(app, { ...scope, tenantId: other.tenantId }).read(reserved.id)).toBeNull();
    const second = await script(other, otherProjectId);
    const otherRow = await new SubmissionLedger(app, other).reserve(reserveInput(second, "scope-key"));
    expect(otherRow.id).not.toBe(reserved.id);
  });
  it("历史 render_jobs 有 key 无 hash 拒绝假去重，也不重发", async () => {
    const source = await script();
    await owner.query(`INSERT INTO render_jobs (id,workspace_id,project_id,script_id,script_version,task_id,idempotency_key)
      VALUES ($1,$2,$3,$4,1,'legacy-task','legacy-key')`, [`legacy-${source.id}`, scope.workspaceId, projectId, source.id]);
    await expect(submitGenJob({ ...submitInput(source), idempotencyKey: "legacy-key" })).rejects.toThrow("LEGACY_SUBMISSION_UNVERIFIED");
    expect(providers.submit).not.toHaveBeenCalled();
  });
  it("非法空 key/指纹拒绝；对象键序不同的脚本 fields 被视为同内容", async () => {
    const source = await script(); const input = reserveInput(source);
    await expect(ledger.reserve({ ...input, key: " " })).rejects.toThrow("REQUEST_INVALID");
    await expect(ledger.reserve({ ...input, requestHash: "bad" })).rejects.toThrow("REQUEST_INVALID");
    const changedOrder = { ...input, script: { ...input.script, fields: { nested: { b: 2, a: 1 }, durationSec: 5 } } };
    expect((await ledger.reserve(changedOrder)).state).toBe("reserved");
  });
  it("真实 submit 并发时一个 provider 调用、一个 job、两条合法原子事件", async () => {
    const source = await script(); const input = submitInput(source);
    let release!: () => void;
    providers.submit.mockImplementationOnce(async () => { await new Promise<void>(resolve => { release = resolve; }); return { taskId: "concurrent-task" }; });
    const first = submitGenJob(input);
    await vi.waitFor(() => expect(providers.submit).toHaveBeenCalledTimes(1));
    await expect(submitGenJob(input)).rejects.toThrow(/SUBMISSION_(UNVERIFIED|IN_PROGRESS)/);
    release(); const completed = await first;
    expect(await submitGenJob(input)).toMatchObject({ jobId: completed.jobId, deduped: true });
    expect(providers.submit).toHaveBeenCalledTimes(1);
    expect(await counts(source.id)).toEqual({ jobs: 1, actions: ["model.call", "render.submit"] });
  });
  it("render_jobs 写失败回滚整批记账，accepted 回执仍可恢复且不再调用 provider", async () => {
    const source = await script();
    await expect(submitGenJob(submitInput(source, faultPool("INSERT INTO render_jobs")))).rejects.toMatchObject({ code: "SUBMISSION_FINALIZATION_PENDING" });
    expect(await counts(source.id)).toEqual({ jobs: 0, actions: [] });
    const rows = await owner.query("SELECT state,task_id FROM generation_submissions WHERE script_id=$1", [source.id]);
    expect(rows.rows[0]).toMatchObject({ state: "accepted" });
    expect((await submitGenJob(submitInput(source))).deduped).toBe(true);
    expect(providers.submit).toHaveBeenCalledTimes(1);
    expect(await counts(source.id)).toEqual({ jobs: 1, actions: ["model.call", "render.submit"] });
  });
  it.each(["RS", "RS-1790528096006"])("计量事件写失败时脚本/job/trace 全回滚，重放仍保持原调用人（%s）", async (idPrefix) => {
    // 第二个前缀的时间戳通过 Luhn，会按网关契约脱敏，不能用原始 object.id 回查事件。
    const source = await script(scope, projectId, idPrefix);
    await expect(submitGenJob(submitInput(source, faultPool("append_event_insert")))).rejects.toThrow("SUBMISSION_FINALIZATION_PENDING");
    expect(await counts(source.id)).toEqual({ jobs: 0, actions: [] });
    const scriptRow = await owner.query("SELECT status FROM render_scripts WHERE id=$1", [source.id]);
    expect(scriptRow.rows[0].status).toBe("approved");
    const replay = await submitGenJob({ ...submitInput(source), actor: "MEM-RETRY" });
    const event = await owner.query(`SELECT payload->'who'->>'id' AS actor FROM biz_events
      WHERE workspace_id=$1 AND payload->'decision'->>'action'='render.submit'
        AND payload->'decision'->'after'->>'jobId'=$2`, [scope.workspaceId, replay.jobId]);
    expect(event.rows).toEqual([{ actor: "MEM-T" }]);
    expect(await counts(source.id)).toEqual({ jobs: 1, actions: ["model.call", "render.submit"] });
    expect(providers.submit).toHaveBeenCalledTimes(1);
  });
  it.each(["commit-before", "commit-after"] as const)("accepted %s 故障后不重复提交，已提交者可补账", async (mode) => {
    const source = await script();
    await expect(submitGenJob(submitInput(source, faultPool("SET state='accepted'", mode))))
      .rejects.toMatchObject({ code: "SUBMISSION_ACCEPTANCE_UNVERIFIED", details: { taskId: expect.any(String) } });
    const stored = await owner.query("SELECT state FROM generation_submissions WHERE script_id=$1", [source.id]);
    expect(stored.rows[0].state).toBe(mode === "commit-after" ? "accepted" : "submitting");
    if (mode === "commit-after") expect((await submitGenJob(submitInput(source))).deduped).toBe(true);
    else await expect(submitGenJob(submitInput(source))).rejects.toThrow("SUBMISSION_UNVERIFIED");
    expect(providers.submit).toHaveBeenCalledTimes(1);
  });
  it("finalize COMMIT ack 丢失后重试读 finalized，不重复事件", async () => {
    const source = await script();
    await expect(submitGenJob(submitInput(source, faultPool("SET state='finalized'", "commit-after")))).rejects.toThrow("SUBMISSION_FINALIZATION_PENDING");
    expect((await submitGenJob(submitInput(source))).deduped).toBe(true);
    expect(providers.submit).toHaveBeenCalledTimes(1);
    expect(await counts(source.id)).toEqual({ jobs: 1, actions: ["model.call", "render.submit"] });
  });
  it("未知接受结果持久化 unknown，重复 key/重新 claim 不会重发", async () => {
    const source = await script(); providers.submit.mockRejectedValue(new Error("network timeout"));
    await expect(submitGenJob(submitInput(source))).rejects.toThrow("SUBMISSION_UNKNOWN");
    await expect(submitGenJob(submitInput(source))).rejects.toThrow("SUBMISSION_UNVERIFIED");
    const rows = await owner.query("SELECT * FROM generation_submissions WHERE script_id=$1", [source.id]);
    expect(rows.rows[0].state).toBe("unknown"); expect(await ledger.claim(rows.rows[0], "new-owner")).toBeNull();
    expect(providers.submit).toHaveBeenCalledTimes(1);
  });
  it("数据库拒绝改身份、重置终态、覆盖已接受回执", async () => {
    const source = await script(); await submitGenJob(submitInput(source));
    await expect(owner.query("UPDATE generation_submissions SET request_hash=$2 WHERE script_id=$1", [source.id, "a".repeat(64)]))
      .rejects.toThrow("identity is immutable");
    await expect(owner.query("UPDATE generation_submissions SET state='reserved' WHERE script_id=$1", [source.id]))
      .rejects.toThrow("transition forbidden");
    await expect(owner.query("UPDATE generation_submissions SET task_id='forged' WHERE script_id=$1", [source.id]))
      .rejects.toThrow("transition forbidden");
  });
});
