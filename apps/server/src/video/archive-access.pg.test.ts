import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ArchiveStore } from "@hyperreality/video-studio";
import { closeAllPools } from "@workloom/db";
import { readArchiveSummary } from "./archive-resume.js";

describe.runIf(process.env.RUN_DB_TESTS === "1")("档案文件读取遵守真实PG项目权限", () => {
  const owner = new pg.Pool({ connectionString: process.env.DATABASE_URL });
  const suffix = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const tenantId = `tenant-access-${suffix}`;
  const workspaceId = `ws-reader-${suffix}`;
  const foreignWorkspace = `ws-victim-${suffix}`;
  const projectId = `VID-own-${suffix}`;
  const foreignProject = `VID-secret-${suffix}`;
  const scope = { tenantId, workspaceId };
  let workDir: string;
  const previousWorkDir = process.env.HR_WORK_DIR;

  beforeAll(async () => {
    workDir = await mkdtemp(path.join(tmpdir(), "archive-access-pg-"));
    process.env.HR_WORK_DIR = workDir;
    await owner.query("INSERT INTO tenants (id,name,plan) VALUES ($1,'archive access','community')", [tenantId]);
    for (const id of [workspaceId, foreignWorkspace]) {
      await owner.query("INSERT INTO workspaces (id,tenant_id,name,slug,industry) VALUES ($1,$2,$1,$1,'general')", [id, tenantId]);
    }
    for (const [id, ws] of [[projectId, workspaceId], [foreignProject, foreignWorkspace]]) {
      await owner.query("INSERT INTO video_projects (id,workspace_id,title,kind,created_by) VALUES ($1,$2,'private video','narrative','test')", [id, ws]);
      const store = new ArchiveStore(workDir, ws, id);
      await store.ensure();
      await store.writeJsonAtomic("context-bundle.json", { projectId: id, progress: `private-${ws}` });
    }
  });
  afterAll(async () => {
    try {
      await owner.query("DELETE FROM video_projects WHERE workspace_id=ANY($1::text[])", [[workspaceId, foreignWorkspace]]);
      await owner.query("DELETE FROM workspaces WHERE id=ANY($1::text[])", [[workspaceId, foreignWorkspace]]);
      await owner.query("DELETE FROM tenants WHERE id=$1", [tenantId]);
    } finally {
      await owner.end();
      await closeAllPools();
      if (previousWorkDir === undefined) delete process.env.HR_WORK_DIR;
      else process.env.HR_WORK_DIR = previousWorkDir;
      if (workDir) await rm(workDir, { recursive: true, force: true });
    }
  });

  it("同租户的另一工作区也不能通过路径片段读取档案", async () => {
    await expect(readArchiveSummary(scope, `../${foreignWorkspace}/${foreignProject}`)).rejects.toThrow("ARCHIVE_PROJECT_NOT_FOUND");
    await expect(readArchiveSummary(scope, foreignProject)).rejects.toThrow("ARCHIVE_PROJECT_NOT_FOUND");
  });

  it("本工作区拥有项目时仍能读取真实文件", async () => {
    const result = await readArchiveSummary(scope, projectId);
    expect(result.manifest).toMatchObject({ projectId, workspaceId });
    expect(result.contextBundle?.progress).toBe(`private-${workspaceId}`);
  });
});
