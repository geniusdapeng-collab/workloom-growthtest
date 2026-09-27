/**
 * 制片档案活库契约（T-2026-0926-0002）：真 PG 上验证台账写入器、断点推导与恢复编排。
 *
 * 覆盖不变量：
 *   ① claimRun 原子认领（attempt 递增、input_ref 指向本次尝试）；
 *   ② finishRun 带 attempt 谓词——历史 attempt 行不被后一次终结写覆盖；
 *   ③ 断点推导只看每个 stage 的**最新** attempt（打回后成功重跑不算断点）；
 *   ④ resume 的 busy / resumed / noaction / awaiting_approval 四分支；
 *   ⑤ RLS 安全默认：未设置 app.workspace_id 时台账不可见。
 *
 * 说明：审批分支用 gateway 池真实 append 五元事件（与 studio-worker#onApproval 同口径）；
 * biz_events 是 append-only（触发器禁删改），测试事件按设计留在链上，不清理。
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";

process.env.DATABASE_URL ??= "postgres://postgres:workloom@localhost:5432/workloom";
process.env.DATABASE_APP_URL ??= "postgres://workloom_app:workloom_dev_app@localhost:5432/workloom";
process.env.DATABASE_GATEWAY_URL ??= "postgres://workloom_gateway:workloom_dev_gateway@localhost:5432/workloom";

const RUN_DB = process.env.RUN_DB_TESTS === "1" && Boolean(process.env.DATABASE_APP_URL);

describe.runIf(RUN_DB)("制片档案活库契约", () => {
  const owner = new pg.Pool({ connectionString: process.env.DATABASE_URL });
  const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const tenantId = `tenant-archive-${suffix}`;
  const workspaceId = `ws-archive-${suffix}`;
  const projectId = `VID-AR-${suffix.slice(-6)}`;
  const scope = { tenantId, workspaceId };

  let makeLedgerWriter: typeof import("./archive-host.js").makeLedgerWriter;
  let acquireProjectLease: typeof import("./archive-host.js").acquireProjectLease;
  let readStageBreakpoints: typeof import("./archive-resume.js").readStageBreakpoints;
  let resumeProject: typeof import("./archive-resume.js").resumeProject;
  let scanStaleRunsOnStartup: typeof import("./archive-resume.js").scanStaleRunsOnStartup;
  let readArchiveSummary: typeof import("./archive-resume.js").readArchiveSummary;
  let gatewayAppendOnClient: typeof import("@workloom/base/workdata").gatewayAppendOnClient;
  let getGatewayPool: typeof import("@workloom/db").getGatewayPool;
  let getAppPool: typeof import("@workloom/db").getAppPool;

  beforeAll(async () => {
    ({ makeLedgerWriter, acquireProjectLease } = await import("./archive-host.js"));
    ({ readStageBreakpoints, resumeProject, readArchiveSummary, scanStaleRunsOnStartup } = await import("./archive-resume.js"));
    ({ gatewayAppendOnClient } = await import("@workloom/base/workdata"));
    ({ getGatewayPool, getAppPool } = await import("@workloom/db"));
    await owner.query(`INSERT INTO tenants (id, name, plan) VALUES ($1,$2,'community')`, [tenantId, "制片档案契约租户"]);
    await owner.query(
      `INSERT INTO workspaces (id, tenant_id, name, slug, industry) VALUES ($1,$2,'档案契约工作区',$3,'general')`,
      [workspaceId, tenantId, `archive-${suffix}`],
    );
    await owner.query(
      `INSERT INTO video_projects (id, workspace_id, title, kind, created_by) VALUES ($1,$2,'档案契约片','narrative','MEM-T')`,
      [projectId, workspaceId],
    );
  });

  afterAll(async () => {
    await owner.query(`DELETE FROM production_stage_runs WHERE workspace_id=$1`, [workspaceId]).catch(() => undefined);
    await owner.query(`DELETE FROM engineering_findings WHERE workspace_id=$1`, [workspaceId]).catch(() => undefined);
    await owner.query(`DELETE FROM approvals WHERE workspace_id=$1`, [workspaceId]).catch(() => undefined);
    await owner.query(`DELETE FROM video_projects WHERE workspace_id=$1`, [workspaceId]).catch(() => undefined);
    await owner.query(`DELETE FROM workspaces WHERE id=$1`, [workspaceId]).catch(() => undefined);
    await owner.query(`DELETE FROM tenants WHERE id=$1`, [tenantId]).catch(() => undefined);
    await owner.end();
  });

  it("claimRun 原子认领 attempt；finishRun 带 attempt 谓词不写串历史行", async () => {
    const ledger = makeLedgerWriter(scope);
    const first = await ledger.claimRun({
      id: "SR-pg-1", projectId, stageId: "preproduction",
      inputRefTemplate: "stages/preproduction/attempt-{attempt}.input.json", runId: "RUN-1",
    });
    const second = await ledger.claimRun({
      id: "SR-pg-2", projectId, stageId: "preproduction",
      inputRefTemplate: "stages/preproduction/attempt-{attempt}.input.json", runId: "RUN-2",
    });
    expect(first.attempt).toBe(1);
    expect(second.attempt).toBe(2);
    expect(second.inputRef).toBe("stages/preproduction/attempt-2.input.json");

    await ledger.finishRun({
      projectId, stageId: "preproduction", attempt: 2, status: "done",
      outputRef: "stages/preproduction/attempt-2.output.json", outputSha256: "sha2",
      errorClass: null, errorMsg: null, durationMs: 1200, cost: { tokens: 7 },
    });
    const rows = await owner.query<{
      attempt: number; status: string; input_ref: string | null; output_ref: string | null; cost: { tokens: number };
    }>(
      `SELECT attempt, status, input_ref, output_ref, cost FROM production_stage_runs WHERE workspace_id=$1 AND project_id=$2 ORDER BY attempt`,
      [workspaceId, projectId],
    );
    expect(rows.rows.map((r) => [r.attempt, r.status, r.input_ref, r.output_ref])).toEqual([
      [1, "running", "stages/preproduction/attempt-1.input.json", null],
      [2, "done", "stages/preproduction/attempt-2.input.json", "stages/preproduction/attempt-2.output.json"],
    ]);
    expect(rows.rows[1]?.cost).toEqual({ tokens: 7 });

    await ledger.finishRun({
      projectId, stageId: "preproduction", attempt: 1, status: "failed",
      outputRef: null, outputSha256: null, errorClass: "BUG", errorMsg: "崩溃", durationMs: 900,
    });
    const after = await owner.query<{ attempt: number; status: string; error_class: string | null }>(
      `SELECT attempt, status, error_class FROM production_stage_runs WHERE workspace_id=$1 AND project_id=$2 AND stage_id='preproduction' ORDER BY attempt`,
      [workspaceId, projectId],
    );
    expect(after.rows).toEqual([
      { attempt: 1, status: "failed", error_class: "BUG" },
      { attempt: 2, status: "done", error_class: null },
    ]);
  });

  it("断点推导只看每个 stage 的最新 attempt（打回后成功重跑不算断点）", async () => {
    await owner.query(`DELETE FROM production_stage_runs WHERE workspace_id=$1 AND project_id=$2`, [workspaceId, projectId]);
    await owner.query(
      `INSERT INTO production_stage_runs (id, workspace_id, project_id, stage_id, attempt, status, started_at, finished_at)
       VALUES ('SR-a1',$1,$2,'preproduction',1,'failed', now() - interval '10 minutes', now() - interval '9 minutes'),
              ('SR-a2',$1,$2,'preproduction',2,'done',   now() - interval '8 minutes',  now() - interval '7 minutes'),
              ('SR-b1',$1,$2,'renderPoll',    1,'failed', now() - interval '6 minutes',  now() - interval '5 minutes')`,
      [workspaceId, projectId],
    );
    const breakpoints = await readStageBreakpoints(scope, projectId);
    expect(breakpoints.map((b) => b.stageId)).toEqual(["renderPoll"]);
    expect(breakpoints[0]?.status).toBe("failed");
  });

  it("resume：预生产断点 → resumed（running 归位 interrupted + 走既有补跑入口）", async () => {
    await owner.query(`DELETE FROM production_stage_runs WHERE workspace_id=$1 AND project_id=$2`, [workspaceId, projectId]);
    await owner.query(
      `INSERT INTO production_stage_runs (id, workspace_id, project_id, stage_id, attempt, status)
       VALUES ('SR-run1',$1,$2,'preproduction',1,'running')`,
      [workspaceId, projectId],
    );
    const started: Array<Record<string, unknown>> = [];
    const result = await resumeProject(scope, {
      projectId,
      intent: "续跑契约用例",
      startRun: (runInput) => {
        started.push(runInput);
        return "RUN-RESUMED";
      },
      actor: { id: "MEM-T", type: "human" },
    });
    expect(result.kind).toBe("resumed");
    if (result.kind === "resumed") expect(result.runId).toBe("RUN-RESUMED");
    expect(started[0]).toMatchObject({ projectId, intent: "续跑契约用例", isMarketing: false });
    const rows = await owner.query<{ status: string }>(
      `SELECT status FROM production_stage_runs WHERE workspace_id=$1 AND project_id=$2`,
      [workspaceId, projectId],
    );
    expect(rows.rows[0]?.status).toBe("interrupted");
  });

  it("resume：已有执行者持有运行租约 → busy（不重复烧额度）", async () => {
    const lease = await acquireProjectLease(scope, projectId);
    expect(lease).not.toBeNull();
    try {
      const result = await resumeProject(scope, {
        projectId,
        startRun: () => "RUN-SHOULD-NOT-START",
        actor: { id: "MEM-T", type: "human" },
      });
      expect(result.kind).toBe("busy");
    } finally {
      await lease?.release();
    }
  });

  it("resume：渲染段断点 → noaction（轮询驱动，无需重拉）", async () => {
    await owner.query(`DELETE FROM production_stage_runs WHERE workspace_id=$1 AND project_id=$2`, [workspaceId, projectId]);
    await owner.query(
      `INSERT INTO production_stage_runs (id, workspace_id, project_id, stage_id, attempt, status)
       VALUES ('SR-poll',$1,$2,'renderPoll',1,'failed')`,
      [workspaceId, projectId],
    );
    const result = await resumeProject(scope, {
      projectId,
      startRun: () => "RUN-SHOULD-NOT-START",
      actor: { id: "MEM-T", type: "human" },
    });
    expect(result.kind).toBe("noaction");
    if (result.kind === "noaction") expect(result.stage).toBe("renderPoll");
  });

  it("resume：本项目 pending approval → awaiting_approval（不重跑、不产生第二张单）", async () => {
    await owner.query(`DELETE FROM production_stage_runs WHERE workspace_id=$1 AND project_id=$2`, [workspaceId, projectId]);
    await owner.query(`DELETE FROM approvals WHERE workspace_id=$1`, [workspaceId]);
    await owner.query(
      `INSERT INTO production_stage_runs (id, workspace_id, project_id, stage_id, attempt, status)
       VALUES ('SR-gate',$1,$2,'preproduction',1,'failed')`,
      [workspaceId, projectId],
    );
    const eventId = `EV-ARCHIVE-${suffix}`;
    const gw = await getGatewayPool().connect();
    try {
      await gw.query("BEGIN");
      await gw.query("SELECT set_config('app.workspace_id', $1, true)", [workspaceId]);
      await gw.query("SELECT set_config('app.tenant_id', $1, true)", [tenantId]);
      await gatewayAppendOnClient(gw, { ...scope, actor: { id: "video-studio", type: "system" } }, {
        who: { id: "video-studio", type: "system" },
        context: { tenant_id: tenantId, workspace_id: workspaceId, time: new Date().toISOString(), channel: "inapp" },
        object: { type: "prd", id: `${projectId}:g4_prd` },
        decision: { action: "prd.confirm", after: { gate: "G4_PRD", projectId } },
        rule_impact: [],
      });
      await gw.query(
        `INSERT INTO approvals (approval_id, tenant_id, workspace_id, event_id, channel, status, snapshot)
         VALUES ($1,$2,$3,(SELECT event_id FROM biz_events WHERE workspace_id=$3 ORDER BY seq DESC LIMIT 1),'inapp','pending','{}')
         ON CONFLICT (event_id, channel) DO NOTHING`,
        [`apr-${eventId}`, tenantId, workspaceId],
      );
      await gw.query("COMMIT");
    } catch (err) {
      await gw.query("ROLLBACK").catch(() => undefined);
      throw err;
    } finally {
      gw.release();
    }

    const started: unknown[] = [];
    const result = await resumeProject(scope, {
      projectId,
      startRun: (input) => {
        started.push(input);
        return "RUN-SHOULD-NOT-START";
      },
      actor: { id: "MEM-T", type: "human" },
    });
    expect(result.kind).toBe("awaiting_approval");
    expect(started).toHaveLength(0);
    const approvals = await owner.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM approvals WHERE workspace_id=$1 AND status='pending'`,
      [workspaceId],
    );
    expect(approvals.rows[0]?.n).toBe("1");
  });

  it("RLS 安全默认：未设置 app.workspace_id 时台账不可见；档案视图返回台账 + 断点", async () => {
    const app = getAppPool();
    const bare = await app.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM production_stage_runs WHERE workspace_id=$1`,
      [workspaceId],
    );
    expect(bare.rows[0]?.n).toBe("0");

    const summary = await readArchiveSummary(scope, projectId);
    expect(summary.projectId).toBe(projectId);
    expect(summary.stages.length).toBeGreaterThan(0);
    expect(summary.breakpoints.map((b) => b.stageId)).toContain("preproduction");
    expect(Array.isArray(summary.findings)).toBe(true);
  });

  it("并发认领得到唯一 attempt，外工作区项目不能建立交叉台账", async () => {
    const ledger = makeLedgerWriter(scope);
    const claims = await Promise.all([1, 2, 3].map((n) => ledger.claimRun({
      id: `SR-concurrent-${suffix}-${n}`, projectId, stageId: "concurrent-contract",
      inputRefTemplate: "stages/concurrent/attempt-{attempt}.input.json", runId: null,
    })));
    expect(claims.map((claim) => claim.attempt).sort()).toEqual([1, 2, 3]);
    await expect(makeLedgerWriter({ ...scope, workspaceId: "other-workspace" }).claimRun({
      id: `SR-foreign-${suffix}`, projectId, stageId: "foreign-contract",
      inputRefTemplate: "stages/foreign-{attempt}.json", runId: null,
    })).rejects.toThrow("未返回行");
  });

  it("相同终态回执可重送，冲突或不存在的回执不能虚报成功", async () => {
    const ledger = makeLedgerWriter(scope);
    await ledger.claimRun({
      id: `SR-receipt-${suffix}`, projectId, stageId: "receipt-contract",
      inputRefTemplate: "stages/receipt-{attempt}.json", runId: null,
    });
    const receipt = {
      projectId, stageId: "receipt-contract", attempt: 1, status: "done" as const,
      outputRef: "stages/receipt.output.json", outputSha256: "verified-sha", errorClass: null, errorMsg: null, durationMs: 5,
    };
    await ledger.finishRun(receipt);
    await ledger.finishRun(receipt);
    await expect(ledger.finishRun({ ...receipt, status: "interrupted", errorClass: "RECEIPT_UNVERIFIED" })).rejects.toThrow("STAGE_RECEIPT_CONFLICT");
    await expect(ledger.finishRun({ ...receipt, attempt: 99 })).rejects.toThrow("STAGE_RECEIPT_CONFLICT");
    const saved = await owner.query("SELECT status, output_sha256 FROM production_stage_runs WHERE id=$1", [`SR-receipt-${suffix}`]);
    expect(saved.rows).toEqual([{ status: "done", output_sha256: "verified-sha" }]);
  });

  it("租约同 scope 互斥，跨工作区同项目 ID 不串锁，释放后可再取得", async () => {
    const first = await acquireProjectLease(scope, projectId);
    expect(first).not.toBeNull();
    let other: Awaited<ReturnType<typeof acquireProjectLease>> = null;
    try {
      expect(await acquireProjectLease(scope, projectId)).toBeNull();
      other = await acquireProjectLease({ ...scope, workspaceId: `${workspaceId}-other` }, projectId);
      expect(other).not.toBeNull();
    } finally {
      await first?.release();
      await other?.release();
    }
    const next = await acquireProjectLease(scope, projectId);
    expect(next).not.toBeNull();
    await next?.release();
  });

  it("启动扫描保留新鲜心跳和活跃租约，只归位无锁且过期的行；finding 按项目分离", async () => {
    const secondProject = `${projectId}-scan`;
    await owner.query(`INSERT INTO video_projects (id, workspace_id, title, kind, created_by) VALUES ($1,$2,'扫描契约','narrative','MEM-T')`, [secondProject, workspaceId]);
    for (const [id, project, heartbeat] of [
      [`SR-fresh-${suffix}`, projectId, true],
      [`SR-stale-${suffix}`, projectId, false],
      [`SR-other-${suffix}`, secondProject, false],
    ] as const) {
      await owner.query(
        `INSERT INTO production_stage_runs (id, workspace_id, project_id, stage_id, attempt, status, started_at, last_heartbeat_at)
         VALUES ($1,$2,$3,$4,1,'running',now()-interval '1 hour',CASE WHEN $5 THEN now() ELSE now()-interval '1 hour' END)`,
        [id, workspaceId, project, heartbeat ? "fresh-scan" : "stale-scan", heartbeat],
      );
    }
    const env = { ARCHIVE_AUTO_RESUME: "1", ARCHIVE_STALE_RUNNING_MIN: "10" };
    const lease = await acquireProjectLease(scope, projectId);
    try {
      const firstScan = await scanStaleRunsOnStartup(env);
      expect(firstScan.interrupted.filter((row) => row.workspaceId === workspaceId).map((row) => row.projectId)).toEqual([secondProject]);
      const held = await owner.query("SELECT status FROM production_stage_runs WHERE id=$1", [`SR-stale-${suffix}`]);
      expect(held.rows[0]?.status).toBe("running");
    } finally {
      await lease?.release();
    }
    const secondScan = await scanStaleRunsOnStartup(env);
    expect(secondScan.interrupted.filter((row) => row.workspaceId === workspaceId).map((row) => row.projectId)).toEqual([projectId]);
    const fresh = await owner.query("SELECT status FROM production_stage_runs WHERE id=$1", [`SR-fresh-${suffix}`]);
    expect(fresh.rows[0]?.status).toBe("running");
    const findings = await owner.query("SELECT project_id, dedupe_key FROM engineering_findings WHERE workspace_id=$1 AND stage_id='stale-scan'", [workspaceId]);
    expect(findings.rows).toHaveLength(2);
    expect(new Set(findings.rows.map((row) => row.dedupe_key)).size).toBe(2);
    expect(new Set(findings.rows.map((row) => row.project_id))).toEqual(new Set([projectId, secondProject]));
  });

});
