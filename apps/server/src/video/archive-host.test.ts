import { beforeEach, describe, expect, it, vi } from "vitest";

const db = vi.hoisted(() => ({ connect: vi.fn(), query: vi.fn(), release: vi.fn() }));
vi.mock("@workloom/db", () => ({ getAppPool: () => ({ connect: db.connect }) }));

import { acquireProjectLease, makeLedgerWriter, projectRunLockKey, scopedRows } from "./archive-host.js";

const scope = { tenantId: "tenant:a", workspaceId: "ws:b" };
beforeEach(() => {
  vi.resetAllMocks();
  db.connect.mockResolvedValue({ query: db.query, release: db.release });
  db.query.mockResolvedValue({ rows: [], rowCount: 0 });
});

describe("项目租约的作用域与失败关闭", () => {
  it("同 ID 的跨工作区锁隔离，字段含冒号也不会歧义", () => {
    expect(projectRunLockKey(scope, "VID:1")).not.toBe(projectRunLockKey({ tenantId: "tenant", workspaceId: "a:ws:b" }, "VID:1"));
    expect(projectRunLockKey(scope, "VID:1")).not.toBe(projectRunLockKey({ ...scope, workspaceId: "ws:c" }, "VID:1"));
    expect(() => projectRunLockKey({ ...scope, tenantId: "" }, "VID:1")).toThrow("SCOPE_INVALID");
  });

  it("成功取得并释放同一锁，重复 release 幂等", async () => {
    db.query.mockResolvedValue({ rows: [{ ok: true }] });
    const lease = await acquireProjectLease(scope, "VID:1");
    expect(lease).not.toBeNull();
    expect(db.release).not.toHaveBeenCalled();
    await lease!.release();
    await lease!.release();
    expect(db.query.mock.calls.map((call) => call[1])).toEqual([[projectRunLockKey(scope, "VID:1")], [projectRunLockKey(scope, "VID:1")]]);
    expect(db.release).toHaveBeenCalledExactlyOnceWith(false);
  });

  it("明确 busy 返回 null 并归还未持锁连接", async () => {
    db.query.mockResolvedValue({ rows: [{ ok: false }] });
    await expect(acquireProjectLease(scope, "VID:1")).resolves.toBeNull();
    expect(db.release).toHaveBeenCalledExactlyOnceWith();
  });

  it.each(["throw", "missing"])("取得锁 %s 时销毁可能持有未知锁的连接", async (mode) => {
    if (mode === "throw") db.query.mockRejectedValue(new Error("socket closed after lock"));
    await expect(acquireProjectLease(scope, "VID:1")).rejects.toThrow();
    expect(db.release).toHaveBeenCalledExactlyOnceWith(true);
  });

  it.each(["throw", "false", "missing"])("解锁 %s 时拒绝成功并销毁连接", async (mode) => {
    db.query.mockResolvedValueOnce({ rows: [{ ok: true }] });
    if (mode === "throw") db.query.mockRejectedValueOnce(new Error("unlock network failed"));
    else db.query.mockResolvedValueOnce({ rows: mode === "false" ? [{ ok: false }] : [] });
    const lease = await acquireProjectLease(scope, "VID:1");
    await expect(lease!.release()).rejects.toThrow();
    await lease!.release();
    expect(db.release).toHaveBeenCalledExactlyOnceWith(true);
  });

  it("连接失败原样上抛", async () => {
    const failure = new Error("pool exhausted");
    db.connect.mockRejectedValue(failure);
    await expect(acquireProjectLease(scope, "VID:1")).rejects.toBe(failure);
    expect(db.query).not.toHaveBeenCalled();
  });
});

describe("权威阶段台账", () => {
  const row = {
    projectId: "VID-1", stageId: "preproduction", attempt: 2, status: "done" as const,
    outputRef: "out.json", outputSha256: "abc", errorClass: null, errorMsg: null, durationMs: 10,
  };

  it("UPDATE 未命中且无精确终态回执，不能虚报完成", async () => {
    await expect(makeLedgerWriter(scope).finishRun(row)).rejects.toThrow("STAGE_RECEIPT_CONFLICT");
    expect(db.query.mock.calls.some(([sql]) => sql === "ROLLBACK")).toBe(true);
    expect(db.query.mock.calls.some(([sql]) => sql === "COMMIT")).toBe(false);
  });

  it.each(["updated", "duplicate"])("%s 回执得到明确确认后才提交", async (kind) => {
    db.query.mockImplementation(async (sql: string) => ({
      rows: [], rowCount: (kind === "updated" ? sql.startsWith("UPDATE production_stage_runs") : sql.startsWith("SELECT id FROM production_stage_runs")) ? 1 : 0,
    }));
    await expect(makeLedgerWriter(scope).finishRun(row)).resolves.toBeUndefined();
    expect(db.query.mock.calls.at(-1)?.[0]).toBe("COMMIT");
    if (kind === "duplicate") {
      const [sql, params] = db.query.mock.calls.find(([sql]) => sql.startsWith("SELECT id FROM"))!;
      expect(sql).toContain("output_sha256 IS NOT DISTINCT FROM");
      expect(sql).toContain("cost=$10::jsonb");
      expect(params).toEqual([scope.workspaceId, row.projectId, row.stageId, "done", "out.json", "abc", null, null, 10, "{}", 2]);
    }
  });

  it("非法 running 终结回执拒绝写入", async () => {
    await expect(makeLedgerWriter(scope).finishRun({ ...row, status: "running" })).rejects.toThrow("STAGE_FINISH_INVALID");
    expect(db.query.mock.calls.some(([sql]) => sql.startsWith("UPDATE"))).toBe(false);
  });

  it("不在工作区内的项目不能认领阶段", async () => {
    await expect(makeLedgerWriter(scope).claimRun({ id: "SR-1", projectId: "foreign", stageId: "preproduction", inputRefTemplate: "a-{attempt}", runId: null })).rejects.toThrow("未返回行");
    const [sql] = db.query.mock.calls.find(([sql]) => sql.startsWith("INSERT INTO"))!;
    expect(sql).toContain("FROM video_projects p");
    expect(sql).toContain("p.workspace_id=$2 AND p.id=$3");
  });

  it("事务失败且回滚失败，保留两份错误并销毁连接", async () => {
    db.query.mockImplementation(async (sql: string) => {
      if (sql === "boom" || sql === "ROLLBACK") throw new Error(sql);
      return { rows: [], rowCount: 0 };
    });
    const error = await scopedRows(scope, "boom", []).catch((error: unknown) => error);
    expect(error).toBeInstanceOf(AggregateError);
    expect((error as AggregateError).errors.map((error) => error.message)).toEqual(["boom", "ROLLBACK"]);
    expect(db.release).toHaveBeenCalledExactlyOnceWith(true);
  });
});
