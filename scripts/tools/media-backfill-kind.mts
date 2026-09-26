#!/usr/bin/env tsx
/**
 * media-backfill-kind.mts —— 媒资存量订正与巡检（T-2026-0926-0007）
 *
 * 背景：T-2026-0921-0002 起，render-poller 把**每个单镜 job** 的产物都登记成 `final_cut`，
 * 于是"成片历史"里塞满 5 秒片段、真正的合成成片（交付包母版/变体/重剪产出）反而没有位置。
 * 本脚本把存量行订正回正确语义，并补齐 0039 的媒资列。
 *
 * 四件事（全部幂等，可重复跑）：
 *   ① 单镜产物降级：`meta->>'jobId' IS NOT NULL` 的 final_cut → clip
 *      （判据可靠：合成成片从未走过 registerFinalCut，带 jobId 的必是单镜产物）
 *   ② 回填 pipeline_kind：从 video_projects.kind 对齐双管线口径
 *   ③ 回填 prompt：从 render_scripts.md（截 4000 字）——检索与复用匹配的语料来源
 *   ④ 巡检媒资列漂移（`--check-columns`）：title/prompt 空但 meta 里有、或 source_type 与 provenance.source 不一致
 *
 * 用法：
 *   pnpm exec tsx --env-file=.env scripts/tools/media-backfill-kind.mts [--workspace ws-video] [--json]
 *   pnpm exec tsx --env-file=.env scripts/tools/media-backfill-kind.mts --check-columns
 * 回滚：反向 UPDATE 即可（`UPDATE video_assets SET kind='final_cut' WHERE kind='clip' AND meta->>'jobId' IS NOT NULL`），
 *       本条写进任务卡回执。
 */
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import pg from "pg";

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
const ONLY_WORKSPACE = arg("--workspace");
const CHECK_ONLY = flag("--check-columns");
const AS_JSON = flag("--json");

const client = new pg.Client({ connectionString: DATABASE_URL });

interface StepResult { step: string; rows: number; detail?: string }

async function run(): Promise<StepResult[]> {
  const results: StepResult[] = [];
  const wsFilter = ONLY_WORKSPACE ? " AND workspace_id = $1" : "";
  const wsParams = ONLY_WORKSPACE ? [ONLY_WORKSPACE] : [];

  if (CHECK_ONLY) {
    const drifted = await client.query(
      `SELECT id, workspace_id, kind, title, prompt, source_type, provenance->>'source' AS provenance_source
         FROM video_assets
        WHERE (NULLIF(title, '') IS NULL AND COALESCE(meta->>'title', '') <> '')
           OR (NULLIF(prompt, '') IS NULL AND COALESCE(meta->>'prompt', '') <> '')
           OR (source_type IS DISTINCT FROM provenance->>'source')
           ${wsFilter}
        ORDER BY created_at DESC LIMIT 50`,
      wsParams);
    results.push({
      step: "巡检：媒资列漂移（title/prompt 空但 meta 有值 / source_type 与 provenance 不一致）",
      rows: drifted.rowCount ?? 0,
      detail: drifted.rows.map((row) => `${row.workspace_id}/${row.id} kind=${row.kind} source_type=${row.source_type} provenance=${row.provenance_source ?? "—"}`).join(" | "),
    });
    return results;
  }

  const kindFix = await client.query(
    `UPDATE video_assets SET kind = 'clip'
      WHERE kind = 'final_cut' AND meta->>'jobId' IS NOT NULL ${wsFilter}`,
    wsParams);
  results.push({ step: "① 单镜产物 final_cut → clip", rows: kindFix.rowCount ?? 0 });

  const pipelineFix = await client.query(
    `UPDATE video_assets a SET pipeline_kind = CASE WHEN p.kind = 'marketing' THEN 'marketing' ELSE 'narrative' END
       FROM video_projects p
      WHERE a.project_id = p.id AND a.workspace_id = p.workspace_id
        AND a.pipeline_kind IS NULL AND a.project_id IS NOT NULL
        ${ONLY_WORKSPACE ? " AND a.workspace_id = $1" : ""}`,
    wsParams);
  results.push({ step: "② 回填 pipeline_kind（按项目 kind）", rows: pipelineFix.rowCount ?? 0 });

  const promptFix = await client.query(
    `UPDATE video_assets a SET prompt = left(s.md, 4000)
       FROM render_scripts s
      WHERE a.workspace_id = s.workspace_id
        AND COALESCE(a.meta->>'scriptId', a.provenance->>'scriptId') = s.id
        AND NULLIF(a.prompt, '') IS NULL
        AND NULLIF(s.md, '') IS NOT NULL
        ${ONLY_WORKSPACE ? " AND a.workspace_id = $1" : ""}`,
    wsParams);
  results.push({ step: "③ 回填 prompt（按 render_scripts.md）", rows: promptFix.rowCount ?? 0 });

  const sourceTypeFix = await client.query(
    `UPDATE video_assets SET source_type = CASE
         WHEN kind LIKE 'upload_%' THEN 'uploaded'
         WHEN provenance->>'source' IN ('uploaded','imported','recut') THEN provenance->>'source'
         ELSE 'generated'
       END
      WHERE source_type IS DISTINCT FROM CASE
         WHEN kind LIKE 'upload_%' THEN 'uploaded'
         WHEN provenance->>'source' IN ('uploaded','imported','recut') THEN provenance->>'source'
         ELSE 'generated'
       END
      ${wsFilter}`,
    wsParams);
  results.push({ step: "④ 对齐 source_type（upload_/provenance）", rows: sourceTypeFix.rowCount ?? 0 });

  return results;
}

try {
  await client.connect();
  const results = await run();
  if (AS_JSON) {
    console.log(JSON.stringify({ workspace: ONLY_WORKSPACE || "all", mode: CHECK_ONLY ? "check" : "fix", results }, null, 2));
  } else {
    console.log(CHECK_ONLY ? "== 媒资列巡检 ==" : "== 媒资存量订正 ==");
    for (const row of results) {
      console.log(`- ${row.step}：${row.rows} 行${row.detail ? `\n    ${row.detail}` : ""}`);
    }
    if (!CHECK_ONLY) {
      const total = results.reduce((sum, row) => sum + row.rows, 0);
      console.log(`合计订正 ${total} 行；二次运行应为 0 行（幂等）。`);
    }
  }
} catch (err) {
  console.error(`订正失败：${err instanceof Error ? err.message : String(err)}`);
  process.exitCode = 1;
} finally {
  await client.end().catch(() => undefined);
}
