/**
 * explainer/db.ts —— 口播片的数据访问（RLS 事务 + 版本链读写）· T-2026-0926-0008
 *
 * 与 video/router.ts 的 scopedQuery 同口径（BEGIN + set_config + COMMIT），但不反向依赖
 * router.ts（避免循环 import）：RLS 谓词与 workspace 谓词双保险，越权返回空（L7.1）。
 */
import type pg from "pg";
import { createHash } from "node:crypto";
import { getAppPool, getGatewayPool } from "@workloom/db";
import { gatewayAppendOnClient, insertWithReadableId, VIDEO_PROJECT_ID_SOURCE } from "@workloom/base/workdata";
import { newId } from "@workloom/shared";
import type { ExplainerShotbook, QaReport } from "./types.js";
import { emptyShotbook, splitScript } from "./script.js";

export interface Scope {
  tenantId: string;
  workspaceId: string;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type QueryRow = { [column: string]: any };

export async function scopedQuery<T extends QueryRow>(
  sql: string,
  params: unknown[],
  scope: Scope,
): Promise<T[]> {
  const app = getAppPool();
  const client = await app.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT set_config('app.workspace_id', $1, true)", [scope.workspaceId]);
    const r = await client.query<T>(sql, params);
    await client.query("COMMIT");
    return r.rows;
  } catch (err) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}

export interface ShotbookRow {
  id: string;
  project_id: string;
  version: number;
  status: string;
  script_text: string;
  script_sha256: string;
  shotbook: ExplainerShotbook;
  timestamps_ref: string | null;
  timing_ref: string | null;
  audio_ref: string | null;
  job_dir: string | null;
  engine_pin: Record<string, unknown>;
  render_scope: Record<string, unknown>;
  qa_report: QaReport | null;
  voice_ref: Record<string, unknown>;
}

export async function latestShotbook(scope: Scope, projectId: string): Promise<ShotbookRow | null> {
  const rows = await scopedQuery<ShotbookRow>(
    `SELECT id, project_id, version, status, script_text, script_sha256, shotbook,
            timestamps_ref, timing_ref, audio_ref, job_dir, engine_pin, render_scope, qa_report, voice_ref
       FROM explainer_shotbooks
      WHERE workspace_id=$1 AND project_id=$2
      ORDER BY version DESC LIMIT 1`,
    [scope.workspaceId, projectId],
    scope,
  );
  return rows[0] ?? null;
}

export async function insertShotbook(
  scope: Scope,
  input: {
    projectId: string;
    version: number;
    status: string;
    scriptText: string;
    scriptSha256: string;
    shotbook: ExplainerShotbook;
    enginePin?: Record<string, unknown>;
    voiceRef?: Record<string, unknown>;
    by: string;
  },
): Promise<string> {
  const id = newId("ESB");
  const client = await getAppPool().connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT set_config('app.workspace_id', $1, true)", [scope.workspaceId]);
    await client.query("SELECT set_config('app.tenant_id', $1, true)", [scope.tenantId]);
    await client.query(
      `INSERT INTO explainer_shotbooks
         (id, workspace_id, project_id, version, status, script_text, script_sha256, shotbook,
          engine_pin, voice_ref, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
      [
        id, scope.workspaceId, input.projectId, input.version, input.status, input.scriptText,
        input.scriptSha256, JSON.stringify(input.shotbook), JSON.stringify(input.enginePin ?? {}),
        JSON.stringify(input.voiceRef ?? {}), input.by,
      ],
    );
    await gatewayAppendOnClient(client, { ...scope, actor: { id: input.by, type: "human" } }, {
      who: { type: "human", id: input.by },
      context: { tenant_id: scope.tenantId, workspace_id: scope.workspaceId, time: new Date().toISOString(), channel: "inapp" },
      object: { type: "video_project", id: input.projectId },
      decision: {
        action: "explainer.shotbook.create",
        after: { shotbookId: id, version: input.version, status: input.status, shots: input.shotbook.shots.length },
      },
      rule_impact: [],
    });
    await client.query("COMMIT");
    return id;
  } catch (err) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}

export async function updateShotbook(
  scope: Scope,
  id: string,
  patch: Partial<{
    status: string;
    shotbook: ExplainerShotbook;
    timestampsRef: string;
    timingRef: string;
    audioRef: string;
    jobDir: string;
    enginePin: Record<string, unknown>;
    renderScope: Record<string, unknown>;
    qaReport: QaReport;
    voiceRef: Record<string, unknown>;
  }>,
): Promise<void> {
  const sets: string[] = [];
  const params: unknown[] = [scope.workspaceId, id];
  const add = (column: string, value: unknown, json = false) => {
    params.push(json ? JSON.stringify(value) : value);
    sets.push(`${column}=$${params.length}`);
  };
  if (patch.status !== undefined) add("status", patch.status);
  if (patch.shotbook !== undefined) add("shotbook", patch.shotbook, true);
  if (patch.timestampsRef !== undefined) add("timestamps_ref", patch.timestampsRef);
  if (patch.timingRef !== undefined) add("timing_ref", patch.timingRef);
  if (patch.audioRef !== undefined) add("audio_ref", patch.audioRef);
  if (patch.jobDir !== undefined) add("job_dir", patch.jobDir);
  if (patch.enginePin !== undefined) add("engine_pin", patch.enginePin, true);
  if (patch.renderScope !== undefined) add("render_scope", patch.renderScope, true);
  if (patch.qaReport !== undefined) add("qa_report", patch.qaReport, true);
  if (patch.voiceRef !== undefined) add("voice_ref", patch.voiceRef, true);
  if (sets.length === 0) return;
  await scopedQuery(`UPDATE explainer_shotbooks SET ${sets.join(", ")} WHERE workspace_id=$1 AND id=$2`, params, scope);
}

export interface ExplainerProjectRow {
  id: string;
  title: string;
  kind: string;
  status: string;
}

export async function projectOf(scope: Scope, projectId: string): Promise<ExplainerProjectRow | null> {
  const rows = await scopedQuery<ExplainerProjectRow>(
    `SELECT id, title, kind, status FROM video_projects WHERE workspace_id=$1 AND id=$2`,
    [scope.workspaceId, projectId],
    scope,
  );
  return rows[0] ?? null;
}

/** 建口播片项目行（kind='explainer'；与 studio-worker 的 narrative/marketing 立项同口径） */
export async function createExplainerProject(
  scope: Scope,
  input: { intent: string; by: string },
): Promise<string> {
  const client = await getAppPool().connect();
  const projectId = await (async () => {
    try {
      await client.query("BEGIN");
      await client.query("SELECT set_config('app.workspace_id', $1, true)", [scope.workspaceId]);
      await client.query("SELECT set_config('app.tenant_id', $1, true)", [scope.tenantId]);
      // GR-02（2026-09-29 第二次修复）：与 studio-worker 同口径，避免第二处实现各写各的
      const id = (await insertWithReadableId(client, VIDEO_PROJECT_ID_SOURCE, async (projectId) => {
        await client.query(
          `INSERT INTO video_projects (id, workspace_id, title, kind, created_by) VALUES ($1,$2,$3,'explainer',$4)`,
          [projectId, scope.workspaceId, input.intent.slice(0, 200), input.by],
        );
        return projectId;
      })).id;
      await gatewayAppendOnClient(client, { ...scope, actor: { id: input.by, type: "human" } }, {
        who: { type: "human", id: input.by },
        context: { tenant_id: scope.tenantId, workspace_id: scope.workspaceId, time: new Date().toISOString(), channel: "inapp" },
        object: { type: "video_project", id },
        decision: { action: "video.project.create", after: { projectId: id, kind: "explainer", intent: input.intent.slice(0, 500) } },
        rule_impact: [],
      });
      await client.query("COMMIT");
      return id;
    } catch (err) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
  })();
  void getGatewayPool;
  return projectId;
}

/**
 * 立项 + v1 草稿分镜（`video.studio.start` 分流到 explainer 时用）：
 * 两行落库同一 scope；口播稿先放"目标原文"，等调用方用 `video.explainer.saveScript` 换成正式稿。
 */
export async function createExplainerDraft(
  scope: Scope,
  input: { intent: string; scriptText?: string; brandProduct?: string; by: string },
): Promise<{ projectId: string; shotbookId: string }> {
  const scriptText = (input.scriptText ?? input.intent).trim();
  const projectId = await createExplainerProject(scope, { intent: input.intent, by: input.by });
  const shotbookId = await insertShotbook(scope, {
    projectId,
    version: 1,
    status: "draft",
    scriptText,
    scriptSha256: sha256(scriptText),
    shotbook: emptyShotbook(input.brandProduct ?? input.intent.slice(0, 20)),
    by: input.by,
  });
  return { projectId, shotbookId };
}

function sha256(text: string): string {
  // 与 voice-prep.textFingerprint 同算法（sha256 of utf8），这里独立实现以免把执行层依赖带进数据层
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/** 渲染 job 行（供 finalize 判定渲染是否完成；不重复实现轮询写回） */
export async function renderJobOf(
  scope: Scope,
  idempotencyKey: string,
): Promise<{ id: string; status: string; task_id: string | null; result_url: string | null; asset_id: string | null; actual_seconds: number | null } | null> {
  const rows = await scopedQuery<{
    id: string; status: string; task_id: string | null; result_url: string | null; asset_id: string | null; actual_seconds: number | null;
  }>(
    `SELECT id, status, task_id, result_url, asset_id, actual_seconds
       FROM render_jobs WHERE workspace_id=$1 AND idempotency_key=$2`,
    [scope.workspaceId, idempotencyKey],
    scope,
  );
  return rows[0] ?? null;
}

export type { pg };
