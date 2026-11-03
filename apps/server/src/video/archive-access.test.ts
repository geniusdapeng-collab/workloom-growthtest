import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const db = vi.hoisted(() => ({ query: vi.fn(), release: vi.fn() }));
vi.mock("@workloom/db", () => ({
  getAppPool: () => ({ connect: async () => ({ query: db.query, release: db.release }) }),
}));
import { ArchiveStore } from "@hyperreality/video-studio";
import { readArchiveSummary } from "./archive-resume.js";

const scope = { tenantId: "tenant-reader", workspaceId: "ws-reader" };
let workDir: string;
beforeEach(async () => {
  vi.resetAllMocks();
  workDir = await mkdtemp(path.join(tmpdir(), "archive-access-"));
  vi.stubEnv("HR_WORK_DIR", workDir);
  db.query.mockResolvedValue({ rows: [], rowCount: 0 });
});
afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  await rm(workDir, { recursive: true, force: true });
});

describe("制片档案读取先核验项目权限", () => {
  it("路径逃逸不能读到另一个工作区的档案", async () => {
    const victim = new ArchiveStore(workDir, "ws-victim", "VID-secret");
    await victim.ensure();
    await victim.writeJsonAtomic("context-bundle.json", { privateCustomerIntent: "victim-only" });
    await expect(readArchiveSummary(scope, "../ws-victim/VID-secret")).rejects.toThrow();
  });

  it("项目不可见时不读取任何磁盘档案", async () => {
    const read = vi.spyOn(ArchiveStore.prototype, "readManifest");
    await expect(readArchiveSummary(scope, "VID-not-visible")).rejects.toThrow("ARCHIVE_PROJECT_NOT_FOUND");
    expect(read).not.toHaveBeenCalled();
  });

  it("合法项目保留manifest、context及事件读取", async () => {
    const own = new ArchiveStore(workDir, scope.workspaceId, "VID-own");
    await own.ensure();
    await own.writeJsonAtomic("context-bundle.json", { projectId: "VID-own", progress: "own-only" });
    await own.appendJsonl("events.jsonl", { kind: "stage.done" });
    db.query.mockImplementation(async (sql: string) => ({
      rows: sql.startsWith("SELECT title, kind, thread_id")
        ? [{ title: "own", kind: "narrative", thread_id: null, created_at: null }] : [],
      rowCount: 0,
    }));
    const result = await readArchiveSummary(scope, "VID-own");
    expect(result.manifest).toMatchObject({ projectId: "VID-own" });
    expect(result.contextBundle).toMatchObject({ progress: "own-only" });
    expect(result.recentEvents).toMatchObject([{ kind: "stage.done" }]);
  });
});
