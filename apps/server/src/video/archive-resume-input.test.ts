import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const db = vi.hoisted(() => ({ query: vi.fn(), release: vi.fn() }));
vi.mock("@workloom/db", () => ({ getAppPool: () => ({ connect: async () => ({ query: db.query, release: db.release }) }) }));
import { ArchiveStore } from "@hyperreality/video-studio";
import { resumeProject } from "./archive-resume.js";

const scope = { tenantId: "tenant-resume", workspaceId: "ws-resume" };
const projectId = "VID-input";
const createdAt = "2026-11-03T00:00:00.000Z";
const originalIntent = `拍摄山间风景。${"保留原始动作顺序和自然环境。".repeat(30)}末尾必须保留一朵紫色花。`;
const metadata = { aspectRatio: "16:9", noMusic: true, brief: { audience: "游客", product: "企业负责人" } };
let workDir: string;
beforeEach(async () => {
  vi.resetAllMocks();
  workDir = await mkdtemp(path.join(tmpdir(), "resume-input-"));
  vi.stubEnv("HR_WORK_DIR", workDir);
  db.query.mockImplementation(async (sql: string) => {
    if (sql.includes("pg_try_advisory_xact_lock")) return { rows: [{ ok: true }], rowCount: 1 };
    if (sql.startsWith("SELECT stage_id AS")) return { rows: [{ stageId: "preproduction", attempt: 3, status: "failed", errorClass: "GATE_REJECTED", startedAt: createdAt }], rowCount: 1 };
    if (sql.startsWith("SELECT attempt, input_ref")) return { rows: [{ attempt: 3, input_ref: "stages/preproduction/attempt-3.input.json" }], rowCount: 1 };
    if (sql.startsWith("SELECT title, kind")) return { rows: [{ title: originalIntent.slice(0, 200), kind: "narrative", created_at: createdAt, thread_id: null }], rowCount: 1 };
    return { rows: [], rowCount: 0 };
  });
});
afterEach(async () => { vi.unstubAllEnvs(); await rm(workDir, { recursive: true, force: true }); });

function snapshot() {
  return { schemaVersion: "workloom.studio-resume-input/v1", ...scope, projectId, projectCreatedAt: createdAt,
    intent: originalIntent, rawIntent: "原始用户风景需求", metadata, isMarketing: false, requiresDelegation: false,
    scenePolicyDecision: { id: null, version: null, sourceSha256: null, reason: "原始客户未选择片型", evidence: [] },
    scenePolicyInput: null, platformId: "douyin",
  };
}
async function save(value: unknown) {
  const store = new ArchiveStore(workDir, scope.workspaceId, projectId);
  await store.writeJsonAtomic("stages/preproduction/attempt-3.input.json", { stageId: "preproduction", attempt: 3,
    input: { intent: `${originalIntent}\n系统已追加制作口径`, resumeInput: value },
  });
}

describe("档案恢复使用原始完整输入而非项目标题", () => {
  it("保留末尾需求、原始metadata和已选无片型，不让加工brief重新选型", async () => {
    await save(snapshot());
    const startRun = vi.fn().mockReturnValue("RUN-restored");
    const result = await resumeProject(scope, { projectId, startRun, actor: { id: "MEM", type: "human" } });
    expect(result.kind).toBe("resumed");
    expect(startRun).toHaveBeenCalledWith(expect.objectContaining({ intent: originalIntent, rawIntent: "原始用户风景需求", metadata, isMarketing: false,
      selectedScenePolicy: expect.objectContaining({ policy: null, decision: expect.objectContaining({ id: null }) }),
    }));
  });

  it("显式续跑文案仍保留原metadata", async () => {
    await save(snapshot());
    const startRun = vi.fn().mockReturnValue("RUN-edited");
    await resumeProject(scope, { projectId, intent: "保留紫花，改为日落", startRun, actor: { id: "MEM", type: "human" } });
    expect(startRun).toHaveBeenCalledWith(expect.objectContaining({ intent: "保留紫花，改为日落", rawIntent: "保留紫花，改为日落", metadata }));
  });

  it("显式重跑已完成的前期阶段，仍采用最新合法输入快照", async () => {
    await save(snapshot());
    const query = db.query.getMockImplementation()!;
    db.query.mockImplementation((sql: string) => sql.startsWith("SELECT stage_id AS") ? Promise.resolve({ rows: [], rowCount: 0 }) : query(sql));
    const startRun = vi.fn().mockReturnValue("RUN-forced");
    const result = await resumeProject(scope, { projectId, fromStage: "preproduction", startRun, actor: { id: "MEM", type: "human" } });
    expect(result).toMatchObject({ kind: "resumed", attempt: 3 });
    expect(startRun).toHaveBeenCalledWith(expect.objectContaining({ intent: originalIntent, metadata }));
  });

  it.each(["legacy", "version", "identity", "director"])("%s输入不可安全恢复时不以默认参数启动", async (kind) => {
    const value = snapshot();
    if (kind === "version") value.schemaVersion = "unsupported/v9";
    if (kind === "identity") value.projectCreatedAt = "2020-01-01T00:00:00.000Z";
    if (kind === "director") value.requiresDelegation = true;
    await save(kind === "legacy" ? undefined : value);
    const startRun = vi.fn().mockReturnValue("RUN-unsafe");
    const result = await resumeProject(scope, { projectId, fromStage: "preproduction", startRun, actor: { id: "MEM", type: "human" } });
    expect(result.kind).toBe("noaction");
    expect(startRun).not.toHaveBeenCalled();
  });
});
