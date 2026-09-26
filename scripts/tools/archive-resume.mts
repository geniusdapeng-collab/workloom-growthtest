#!/usr/bin/env tsx
/**
 * archive-resume.mts —— 制片档案运维 CLI（T-2026-0926-0003 · 规格书 §1.1/§9）
 *
 * 与 tRPC `video.studio.archive` / `video.studio.resume` 的分工：
 *   - 服务端入口需要登录身份与运行中的 server；
 *   - 本 CLI 面向**离线运维/夜班巡检**（终端、cron、无人值守机器）：直接读写档案与台账，
 *     不启动预生产（拉起管线仍走 `video.studio.resume`，避免脚本悄悄烧额度）。
 *
 * 命令：
 *   list [--json]                        列出档案（manifest + 断点 + 最近台账行）
 *   show --project VID-xxx [--json]      单项目详表（台账 + manifest + context-bundle + 最近事件）
 *   mark-interrupted --project VID-xxx   把 running 台账归位为 interrupted（进程已死，状态不能撒谎）
 *   findings [--status open] [--project] 列工程发现
 *   receipt --finding EF-xxx --task T-… [--fix <PR/commit>] [--status fixed|distilled|wontfix] [--distilled-to docs/badcases/x.md]
 *
 * 用法：pnpm exec tsx --env-file=.env scripts/tools/archive-resume.mts show --project VID-1004
 */
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import pg from "pg";
import { archiveWorkDir } from "../../apps/server/src/video/archive-host.js";

function loadDotEnvIfNeeded(): void {
  if (process.env.DATABASE_URL) return;
  const file = resolve(import.meta.dirname ?? process.cwd(), "../../.env");
  if (!existsSync(file)) return;
  for (const line of readFileSync(file, "utf8").split("\n")) {
    const matched = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line.trim());
    if (!matched) continue;
    const [, key, raw] = matched;
    if (process.env[key!] !== undefined) continue;
    process.env[key!] = raw!.replace(/^"(.*)"$/, "$1");
  }
}

function arg(name: string, fallback = ""): string {
  const index = process.argv.indexOf(name);
  return index >= 0 ? (process.argv[index + 1] ?? fallback) : fallback;
}
const flag = (name: string) => process.argv.includes(name);

loadDotEnvIfNeeded();

const DATABASE_URL = process.env.DATABASE_URL ?? "";
if (!DATABASE_URL) {
  console.error("缺少 DATABASE_URL（用 `pnpm exec tsx --env-file=.env …` 或在 .env 里配置）");
  process.exit(2);
}
const WORK_DIR = archiveWorkDir();
const ARCHIVE_ROOT = join(WORK_DIR, "archive");
const AS_JSON = flag("--json");
const owner = new pg.Pool({ connectionString: DATABASE_URL, max: 4 });

interface RunRow {
  workspace_id: string; project_id: string; stage_id: string; attempt: number; status: string;
  error_class: string | null; output_ref: string | null; duration_ms: number | null;
  started_at: string; finished_at: string | null; last_heartbeat_at: string | null;
}

function readJsonSafe<T>(file: string): T | null {
  try {
    return JSON.parse(readFileSync(file, "utf8")) as T;
  } catch {
    return null;
  }
}

async function rowsForProject(projectId: string): Promise<RunRow[]> {
  const r = await owner.query<RunRow>(
    `SELECT workspace_id, project_id, stage_id, attempt, status, error_class, output_ref,
            duration_ms, started_at, finished_at, last_heartbeat_at
       FROM production_stage_runs WHERE project_id=$1
      ORDER BY started_at ASC, attempt ASC`,
    [projectId],
  );
  return r.rows;
}

async function cmdList(): Promise<void> {
  const rows = await owner.query<{
    project_id: string; workspace_id: string; stages: string; open_stages: string; last_at: string;
  }>(
    `SELECT project_id, min(workspace_id) AS workspace_id,
            count(DISTINCT stage_id)::text AS stages,
            count(DISTINCT stage_id) FILTER (WHERE status IN ('running','failed','interrupted'))::text AS open_stages,
            max(started_at) AS last_at
       FROM production_stage_runs GROUP BY project_id ORDER BY max(started_at) DESC LIMIT 100`,
  );
  const enriched = rows.rows.map((row) => {
    const dir = join(ARCHIVE_ROOT, row.workspace_id, row.project_id);
    const manifest = readJsonSafe<{ pipelineKind?: string; ledger?: Record<string, { status: string }> }>(join(dir, "manifest.json"));
    const bundle = readJsonSafe<{ progress?: string }>(join(dir, "context-bundle.json"));
    return {
      projectId: row.project_id,
      workspaceId: row.workspace_id,
      pipelineKind: manifest?.pipelineKind ?? null,
      archive: existsSync(dir),
      stages: Number(row.stages),
      openStages: Number(row.open_stages),
      lastAt: String(row.last_at),
      progress: bundle?.progress ?? null,
    };
  });
  if (AS_JSON) {
    console.log(JSON.stringify(enriched, null, 2));
    return;
  }
  console.log(`档案总数 ${enriched.length}（工作目录 ${ARCHIVE_ROOT}）`);
  for (const row of enriched) {
    console.log(
      `  · ${row.projectId}（${row.workspaceId}/${row.pipelineKind ?? "?"}）档案=${row.archive ? "有" : "无"}`
      + ` 环节=${row.stages} 未收口=${row.openStages} 最近=${row.lastAt}`
      + `${row.progress ? `\n      ${row.progress}` : ""}`,
    );
  }
}

async function cmdShow(): Promise<void> {
  const projectId = arg("--project");
  if (!projectId) throw new Error("show 需要 --project VID-xxx");
  const rows = await rowsForProject(projectId);
  if (rows.length === 0) {
    console.log(JSON.stringify({ projectId, stages: [], note: "台账无记录（项目可能在别的库/工作区）" }, null, 2));
    return;
  }
  const { workspace_id: workspaceId } = rows[0]!;
  const dir = join(ARCHIVE_ROOT, workspaceId, projectId);
  const manifest = readJsonSafe<Record<string, unknown>>(join(dir, "manifest.json"));
  const bundle = readJsonSafe<Record<string, unknown>>(join(dir, "context-bundle.json"));
  const eventsFile = join(dir, "events.jsonl");
  const recentEvents = existsSync(eventsFile)
    ? readFileSync(eventsFile, "utf8").split("\n").filter(Boolean).slice(-10)
      .flatMap((line) => {
        try { return [JSON.parse(line) as Record<string, unknown>]; } catch { return []; }
      })
    : [];
  const attemptFiles = existsSync(join(dir, "stages"))
    ? readdirSync(join(dir, "stages")).flatMap((stage) => {
        const stageDir = join(dir, "stages", stage);
        if (!statSync(stageDir).isDirectory()) return [];
        return [`${stage}: ${readdirSync(stageDir).sort().join(", ")}`];
      })
    : [];

  const payload = {
    projectId, workspaceId, archiveRoot: dir, archiveExists: existsSync(dir),
    stages: rows.map((row) => ({
      stage: row.stage_id, attempt: row.attempt, status: row.status, errorClass: row.error_class,
      outputRef: row.output_ref, durationMs: row.duration_ms,
      startedAt: row.started_at, finishedAt: row.finished_at, lastHeartbeatAt: row.last_heartbeat_at,
    })),
    manifest, contextBundle: bundle, attemptFiles, recentEvents,
  };
  if (AS_JSON) {
    console.log(JSON.stringify(payload, null, 2));
    return;
  }
  console.log(`项目 ${projectId}（${workspaceId}）档案：${existsSync(dir) ? dir : "缺失"}`);
  for (const stage of payload.stages) {
    console.log(
      `  · ${stage.stage} attempt=${stage.attempt} ${stage.status}`
      + `${stage.errorClass ? ` err=${stage.errorClass}` : ""}`
      + `${stage.durationMs !== null ? ` ${stage.durationMs}ms` : ""}`
      + `${stage.outputRef ? ` → ${stage.outputRef}` : ""}`,
    );
  }
  if (attemptFiles.length > 0) {
    console.log("  档案文件：");
    for (const line of attemptFiles) console.log(`    ${line}`);
  }
  if (bundle) {
    console.log("  交接包：");
    console.log(`    进度：${bundle.progress ?? "-"}`);
    const list = (key: string) => Array.isArray(bundle[key]) ? (bundle[key] as string[]) : [];
    for (const item of list("openQuestions").slice(0, 5)) console.log(`    待解：${item}`);
    for (const item of list("nextSteps").slice(0, 3)) console.log(`    下一步：${item}`);
  }
}

async function cmdMarkInterrupted(): Promise<void> {
  const projectId = arg("--project");
  if (!projectId) throw new Error("mark-interrupted 需要 --project VID-xxx");
  const r = await owner.query(
    `UPDATE production_stage_runs SET status='interrupted', finished_at=now()
      WHERE project_id=$1 AND status='running' RETURNING id, stage_id, attempt`,
    [projectId],
  );
  console.log(`已归位 ${r.rowCount ?? 0} 条 running → interrupted`);
  for (const row of r.rows as Array<{ id: string; stage_id: string; attempt: number }>) {
    console.log(`  · ${row.stage_id} attempt=${row.attempt}（${row.id}）`);
  }
  if ((r.rowCount ?? 0) === 0) console.log("（没有 running 行；无动作）");
}

async function cmdFindings(): Promise<void> {
  const status = arg("--status", "open");
  const projectId = arg("--project");
  const params: unknown[] = [status];
  let sql = `SELECT id, workspace_id, category, severity, source, project_id, stage_id, title, status,
                    task_ref, fix_ref, distilled_to, dedupe_key, created_at, evidence
               FROM engineering_findings WHERE status=$1`;
  if (projectId) {
    params.push(projectId);
    sql += ` AND project_id=$${params.length}`;
  }
  sql += ` ORDER BY severity ASC, created_at DESC LIMIT 100`;
  const r = await owner.query<Record<string, unknown>>(sql, params);
  if (AS_JSON) {
    console.log(JSON.stringify(r.rows, null, 2));
    return;
  }
  console.log(`工程发现（status=${status}）共 ${r.rows.length} 条`);
  for (const row of r.rows) {
    const evidence = (row.evidence ?? {}) as { occurrences?: number };
    console.log(
      `  · [${row.severity}] ${row.title}（${row.dedupe_key} occurrence=${evidence.occurrences ?? 1}）`
      + `\n      finding=${row.id} task=${row.task_ref ?? "-"} fix=${row.fix_ref ?? "-"} status=${row.status}`,
    );
  }
}

async function cmdReceipt(): Promise<void> {
  const findingId = arg("--finding");
  const taskRef = arg("--task");
  const fixRef = arg("--fix");
  const status = arg("--status", "fixed");
  const distilledTo = arg("--distilled-to");
  if (!findingId) throw new Error("receipt 需要 --finding EF-xxx");
  const allowed = ["open", "triaged", "fixing", "fixed", "distilled", "wontfix"];
  if (!allowed.includes(status)) throw new Error(`--status 只接受 ${allowed.join("|")}`);
  const r = await owner.query(
    `UPDATE engineering_findings
        SET status=$2,
            task_ref=COALESCE(NULLIF($3,''), task_ref),
            fix_ref=COALESCE(NULLIF($4,''), fix_ref),
            distilled_to=COALESCE(NULLIF($5,''), distilled_to),
            resolved_at=CASE WHEN $2 IN ('fixed','distilled','wontfix') THEN now() ELSE resolved_at END
      WHERE id=$1 RETURNING id, status, task_ref, fix_ref, distilled_to`,
    [findingId, status, taskRef, fixRef, distilledTo],
  );
  if ((r.rowCount ?? 0) === 0) throw new Error(`finding ${findingId} 不存在`);
  console.log(`已回写：${JSON.stringify(r.rows[0])}`);
}

const cmd = process.argv[2] ?? "list";
const table: Record<string, () => Promise<void>> = {
  list: cmdList,
  show: cmdShow,
  "mark-interrupted": cmdMarkInterrupted,
  findings: cmdFindings,
  receipt: cmdReceipt,
};
const fn = table[cmd];
if (!fn) {
  console.error(`未知命令 ${cmd}；可用：${Object.keys(table).join(" | ")}`);
  process.exit(2);
}
await fn();
await owner.end();
