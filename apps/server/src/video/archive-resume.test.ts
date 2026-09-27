import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const db = vi.hoisted(() => ({ ownerQuery: vi.fn(), query: vi.fn(), release: vi.fn(), connect: vi.fn() }));
vi.mock("@workloom/db", () => ({
  getOwnerPool: () => ({ query: db.ownerQuery }),
  getAppPool: () => ({ connect: db.connect }),
}));
import { ArchiveStore } from "@hyperreality/video-studio";
import { projectRunLockKey } from "./archive-host.js";
import { resumeProject, scanStaleRunsOnStartup } from "./archive-resume.js";

const stale = (project = "VID-1", attempt = 1) => ({
  workspace_id: "ws-1", tenant_id: "tenant-1", project_id: project,
  stage_id: "preproduction", attempt, started_at: "2026-09-26T00:00:00Z",
});
const env = { ARCHIVE_AUTO_RESUME: "1", ARCHIVE_STALE_RUNNING_MIN: "10" };
beforeEach(() => {
  vi.resetAllMocks();
  vi.spyOn(console, "error").mockImplementation(() => undefined);
  vi.spyOn(ArchiveStore.prototype, "readJson").mockResolvedValue(null);
  db.connect.mockResolvedValue({ query: db.query, release: db.release });
  db.ownerQuery.mockResolvedValue({ rows: [stale()] });
  db.query.mockImplementation(async (sql: string) => {
    if (sql.includes("pg_try_advisory_xact_lock")) return { rows: [{ ok: true }], rowCount: 1 };
    if (sql.startsWith("UPDATE production_stage_runs")) return { rows: [{ id: "SR-1" }], rowCount: 1 };
    return { rows: [], rowCount: 0 };
  });
});
afterEach(() => { vi.restoreAllMocks(); });

describe("启动恢复不打断仍在运行的阶段", () => {
  it("关闭扫描不查询数据库", async () => {
    expect(await scanStaleRunsOnStartup({ ARCHIVE_AUTO_RESUME: "0" })).toMatchObject({ enabled: false, findingsWritten: 0 });
    expect(db.ownerQuery).not.toHaveBeenCalled();
  });

  it("发现与更新均按心跳超时判断，更新前持有与执行者完全相同的锁", async () => {
    const result = await scanStaleRunsOnStartup(env);
    expect(db.ownerQuery.mock.calls[0]?.[0]).toContain("COALESCE(r.last_heartbeat_at, r.started_at)");
    const lockIndex = db.query.mock.calls.findIndex(([sql]) => sql.includes("pg_try_advisory_xact_lock"));
    const updateIndex = db.query.mock.calls.findIndex(([sql]) => sql.startsWith("UPDATE"));
    expect(lockIndex).toBeLessThan(updateIndex);
    expect(db.query.mock.calls[lockIndex]?.[1]).toEqual([projectRunLockKey({ tenantId: "tenant-1", workspaceId: "ws-1" }, "VID-1")]);
    expect(db.query.mock.calls[updateIndex]?.[0]).toContain("COALESCE(last_heartbeat_at, started_at)");
    expect(db.query.mock.calls[updateIndex]?.[1]).toEqual(["ws-1", "VID-1", "preproduction", 1, "10"]);
    expect(result).toMatchObject({ findingsWritten: 1, interrupted: [{ projectId: "VID-1", attempt: 1 }] });
  });

  it("已有执行者持锁时不改台账也不写 finding", async () => {
    db.query.mockImplementation(async (sql: string) => ({ rows: sql.includes("pg_try_advisory_xact_lock") ? [{ ok: false }] : [], rowCount: 0 }));
    const result = await scanStaleRunsOnStartup(env);
    expect(result.findingsWritten).toBe(0);
    expect(db.query.mock.calls.some(([sql]) => sql.startsWith("UPDATE") || sql.startsWith("INSERT"))).toBe(false);
    expect(db.query.mock.calls.at(-1)?.[0]).toBe("ROLLBACK");
  });

  it("发现后心跳刷新或阶段完成，事务复检不命中则不报 interrupted", async () => {
    db.query.mockImplementation(async (sql: string) => ({ rows: sql.includes("pg_try_advisory_xact_lock") ? [{ ok: true }] : [], rowCount: 0 }));
    const result = await scanStaleRunsOnStartup(env);
    expect(result.interrupted).toEqual([]);
    expect(db.query.mock.calls.some(([sql]) => sql.startsWith("INSERT"))).toBe(false);
  });

  it("finding 键区分同一阶段的不同项目与 attempt", async () => {
    db.ownerQuery.mockResolvedValue({ rows: [stale("VID-1", 1), stale("VID-2", 1), stale("VID-1", 2)] });
    const report = await scanStaleRunsOnStartup(env);
    const keys = db.query.mock.calls.filter(([sql]) => sql.startsWith("INSERT INTO engineering_findings")).map(([, params]) => params[6]);
    expect(new Set(keys).size).toBe(3);
    expect(report.findingsWritten).toBe(3);
  });

  it.each(["INSERT INTO engineering_findings", "COMMIT"])("%s 失败不虚报已写 finding", async (point) => {
    db.query.mockImplementation(async (sql: string) => {
      if (sql.startsWith(point)) throw new Error("transaction failed");
      if (sql.includes("pg_try_advisory_xact_lock")) return { rows: [{ ok: true }], rowCount: 1 };
      return { rows: [], rowCount: sql.startsWith("UPDATE") ? 1 : 0 };
    });
    const report = await scanStaleRunsOnStartup(env);
    expect(report).toMatchObject({ findingsWritten: 0, interrupted: [] });
    expect(console.error).toHaveBeenCalled();
    expect(db.query.mock.calls.at(-1)?.[0]).toBe("ROLLBACK");
  });

  it("锁确认缺失与回滚失败时销毁连接，扫描继续报告真实结果", async () => {
    db.query.mockImplementation(async (sql: string) => {
      if (sql === "ROLLBACK") throw new Error("rollback failed");
      return { rows: [], rowCount: 0 };
    });
    expect((await scanStaleRunsOnStartup(env)).interrupted).toEqual([]);
    expect(db.release).toHaveBeenCalledExactlyOnceWith(true);
  });
});

describe("人工恢复共用运行锁", () => {
  const scope = { tenantId: "tenant-1", workspaceId: "ws-1" };
  it("resume 锁取得但 run 锁 busy，不调用启动函数", async () => {
    let lockCount = 0;
    db.query.mockImplementation(async (sql: string) => ({ rows: sql.includes("pg_try_advisory_xact_lock") ? [{ ok: ++lockCount === 1 }] : [], rowCount: 0 }));
    const startRun = vi.fn();
    const result = await resumeProject(scope, { projectId: "VID-1", startRun, actor: { id: "MEM-1", type: "human" } });
    expect(result.kind).toBe("busy");
    expect(startRun).not.toHaveBeenCalled();
    expect(db.query.mock.calls.filter(([sql]) => sql.includes("pg_try_advisory_xact_lock"))[1]?.[1]).toEqual([projectRunLockKey(scope, "VID-1")]);
  });

  it.each([undefined, "preproduction"])("完成回执待核实，fromStage=%s 也不能重发外部动作", async (fromStage) => {
    db.query.mockImplementation(async (sql: string) => {
      if (sql.includes("pg_try_advisory_xact_lock")) return { rows: [{ ok: true }], rowCount: 1 };
      if (sql.startsWith("SELECT stage_id AS")) return { rows: [{ stageId: "preproduction", attempt: 2, status: "interrupted", errorClass: "RECEIPT_UNVERIFIED", startedAt: "2026-09-27" }], rowCount: 1 };
      return { rows: [], rowCount: 0 };
    });
    const startRun = vi.fn();
    const result = await resumeProject(scope, { projectId: "VID-1", fromStage, startRun, actor: { id: "MEM-1", type: "human" } });
    expect(result).toMatchObject({ kind: "noaction", stage: "preproduction" });
    expect(result.message).toContain("完成回执待核实");
    expect(startRun).not.toHaveBeenCalled();
  });

  it.each(["meta", "output"])("PG 补写失败时，档案 %s 仍阻止未知副作用重跑", async (evidence) => {
    db.query.mockImplementation(async (sql: string) => {
      if (sql.includes("pg_try_advisory_xact_lock")) return { rows: [{ ok: true }], rowCount: 1 };
      if (sql.startsWith("SELECT stage_id AS")) return { rows: [{ stageId: "preproduction", attempt: 2, status: "interrupted", errorClass: null, startedAt: "2026-09-27" }], rowCount: 1 };
      return { rows: [], rowCount: 0 };
    });
    vi.mocked(ArchiveStore.prototype.readJson).mockImplementation(async <T>(rel: string): Promise<T | null> => {
      if (rel.endsWith(`.${evidence}.json`)) return (evidence === "meta" ? { errorClass: "RECEIPT_UNVERIFIED" } : { success: true }) as T;
      return null;
    });
    const startRun = vi.fn();
    const result = await resumeProject(scope, { projectId: "VID-1", startRun, actor: { id: "MEM-1", type: "human" } });
    expect(result).toMatchObject({ kind: "noaction", stage: "preproduction" });
    expect(startRun).not.toHaveBeenCalled();
  });

  it("已有阶段都完成且无待审批时，恢复不会默认启动新预生产", async () => {
    const startRun = vi.fn();
    const result = await resumeProject(scope, { projectId: "VID-1", startRun, actor: { id: "MEM-1", type: "human" } });
    expect(result).toMatchObject({ kind: "noaction" });
    expect(result.message).toContain("没有待恢复");
    expect(startRun).not.toHaveBeenCalled();
  });

  it("异常锁回执不是 busy，更不能启动；回滚失败销毁连接", async () => {
    db.query.mockImplementation(async (sql: string) => {
      if (sql === "ROLLBACK") throw new Error("rollback failed");
      return { rows: [], rowCount: 0 };
    });
    const startRun = vi.fn();
    await expect(resumeProject(scope, { projectId: "VID-1", startRun, actor: { id: "MEM-1", type: "human" } })).rejects.toBeInstanceOf(AggregateError);
    expect(startRun).not.toHaveBeenCalled();
    expect(db.release).toHaveBeenCalledExactlyOnceWith(true);
  });
});
