#!/usr/bin/env tsx
/**
 * archive-watch.mts —— 制片档案监控器（T-2026-0926-0003 · 规格书 §7）
 *
 * 把"运行期异常"变成"可跟踪的工程发现"（第二类数据闭环）：
 *   ① 僵死：running 环节超过 `ARCHIVE_HEARTBEAT_STALE_MIN` 分钟无心跳 → P1
 *   ② 失败聚类：24h 内同 (stage, errorClass) 跨项目 ≥3 → errorClass='BUG' 记 P0，其余 P2
 *   ③ 成本异常：单环节 `cost.cashCny` 超 `ARCHIVE_WATCH_COST_CAP` → P2
 *   ④ interrupted 遗留：1 小时内新产生的 interrupted（重启未恢复）→ P1
 *   ⑤ 台账 vs 文件对账：output_ref 指向的档案文件缺失（以文件为准）→ P2
 *   ⑥ 恢复未生效（真机发现）：attempt>1 且开跑前有 Phase checkpoint 但 `resumed=false`
 *      → P1「重启后全量重跑、重复计费风险」（vendor 指纹不匹配会删除自身 checkpoint，
 *      快照证据见 `<archive>/checkpoints/attempt-<n>-before/`）
 *
 * 幂等：`engineering_findings` 按 (workspace_id, dedupe_key) 唯一；重复发现只累加 `evidence.occurrences`。
 * 产物：`findings-issue.md`（人读清单）；有 `CNB_TOKEN` 时可 `--issue` 直接开任务卡（缺省只落文件）。
 *
 * 用法：
 *   pnpm exec tsx --env-file=.env scripts/tools/archive-watch.mts [--workspace ws-geo] [--json]
 *     [--out <dir>] [--dry-run] [--issue] [--repo workloom-ai/workloom-growth]
 *   夜班巡检建议：每 15 分钟一次（cron / fleet-run）。
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import pg from "pg";
import { newId } from "@workloom/shared";
import { archiveWorkDir } from "../../apps/server/src/video/archive-host.js";

/* ================= 环境 ================= */

/** 工具允许不走 --env-file：缺 DATABASE_URL 时读仓库根 .env（只做 KEY=VALUE 解析，不做变量展开） */
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
const APP_URL = process.env.DATABASE_APP_URL ?? DATABASE_URL;
if (!DATABASE_URL) {
  console.error("缺少 DATABASE_URL（用 `pnpm exec tsx --env-file=.env …` 或在 .env 里配置）");
  process.exit(2);
}
const REPO_ROOT = resolve(import.meta.dirname ?? process.cwd(), "../..");
/** 与服务器同口径（相对路径按仓库根，兼容历史 cwd 相对路径）；见 apps/server/src/video/archive-host.ts */
const WORK_DIR = archiveWorkDir();
const STALE_MIN = Math.max(1, Number(process.env.ARCHIVE_HEARTBEAT_STALE_MIN ?? 30) || 30);
const COST_CAP = Number(process.env.ARCHIVE_WATCH_COST_CAP ?? 50) || 50;
const ONLY_WORKSPACE = arg("--workspace");
const OUT_DIR = resolve(arg("--out", join(WORK_DIR, "findings")));
const AS_JSON = flag("--json");
const DRY_RUN = flag("--dry-run");
const CREATE_ISSUE = flag("--issue");
const CNB_REPO = arg("--repo", "workloom-ai/workloom-growth");

/* ================= 类型 ================= */

type Severity = "P0" | "P1" | "P2" | "P3";
type Category = "bug" | "optimization" | "new_solution" | "experience";

interface Finding {
  dedupeKey: string;
  workspaceId: string;
  category: Category;
  severity: Severity;
  projectId: string | null;
  stageId: string | null;
  title: string;
  evidence: Record<string, unknown>;
}

interface StageRow {
  id: string; workspace_id: string; project_id: string; stage_id: string; attempt: number;
  status: string; output_ref: string | null; error_class: string | null; error_msg: string | null;
  cost: Record<string, unknown> | null; duration_ms: number | null;
  started_at: string; finished_at: string | null; last_heartbeat_at: string | null;
}

/* ================= 检测 ================= */

const owner = new pg.Pool({ connectionString: DATABASE_URL, max: 4 });
const app = new pg.Pool({ connectionString: APP_URL, max: 4 });

async function workspaces(): Promise<string[]> {
  const rows = await owner.query<{ id: string }>(
    ONLY_WORKSPACE ? `SELECT id FROM workspaces WHERE id=$1` : `SELECT id FROM workspaces ORDER BY id`,
    ONLY_WORKSPACE ? [ONLY_WORKSPACE] : [],
  );
  return rows.rows.map((r) => r.id);
}

/**
 * 跨租户读（巡检例外点，与 server 启动扫描同口径）：
 * RLS 下无法一次读完所有工作区，巡检器用 owner 只读台账；**写发现**回到 app 池 + set_config。
 */
async function stageRows(sql: string, params: unknown[]): Promise<StageRow[]> {
  const rows = await owner.query<StageRow>(sql, params);
  return rows.rows;
}

function archiveFileExists(workspaceId: string, projectId: string, relPath: string): boolean {
  const abs = join(WORK_DIR, "archive", workspaceId, projectId, relPath);
  return existsSync(abs);
}

/** ⑥ 恢复未生效：读 attempt 产物里的 preCheckpointSnapshot + resumed */
function resumeEvidence(workspaceId: string, projectId: string, outputRef: string | null): { snapshots: number; resumed: boolean } | null {
  if (!outputRef) return null;
  try {
    const abs = join(WORK_DIR, "archive", workspaceId, projectId, outputRef);
    const parsed = JSON.parse(readFileSync(abs, "utf8")) as {
      preCheckpointSnapshot?: { files?: number };
      resumed?: boolean;
    };
    /** 只有预生产产物会写 `resumed`（vendor 的续跑标记）；渲染段产物没有这个字段，不适用本规则 */
    if (!("resumed" in parsed)) return null;
    const files = Number(parsed.preCheckpointSnapshot?.files ?? 0);
    return { snapshots: files, resumed: parsed.resumed === true };
  } catch {
    return null;
  }
}

async function collectFindings(): Promise<{ findings: Finding[]; scanned: number }> {
  const findings: Finding[] = [];
  const ids = await workspaces();
  let scanned = 0;

  for (const workspaceId of ids) {
    /* ① 僵死（running 且心跳过旧：无心跳时退化为 started_at） */
    const stale = await stageRows(
      `SELECT * FROM production_stage_runs
        WHERE workspace_id=$1 AND status='running'
          AND COALESCE(last_heartbeat_at, started_at) < now() - ($2 || ' minutes')::interval`,
      [workspaceId, String(STALE_MIN)],
    );
    scanned += stale.length;
    for (const row of stale) {
      findings.push({
        dedupeKey: `watch:stale:${row.stage_id}`,
        workspaceId,
        category: "bug",
        severity: "P1",
        projectId: row.project_id,
        stageId: row.stage_id,
        title: `僵死：${row.project_id}/${row.stage_id} attempt=${row.attempt} 超 ${STALE_MIN} 分钟无心跳`,
        evidence: {
          archiveRoot: join(WORK_DIR, "archive", workspaceId, row.project_id),
          errorClass: row.error_class,
          occurrences: 1,
          stageId: row.stage_id,
          attempt: row.attempt,
          lastHeartbeatAt: row.last_heartbeat_at,
          startedAt: String(row.started_at),
          rule: "stale_running",
        },
      });
    }

    /* ② 失败聚类（24h 内同 stage × errorClass 跨项目 ≥3） */
    const clusters = await stageRows(
      `SELECT stage_id, error_class, COUNT(DISTINCT project_id)::int AS projects,
              COUNT(*)::int AS total, MAX(started_at) AS last_at
         FROM production_stage_runs
        WHERE workspace_id=$1 AND status IN ('failed','interrupted')
          AND started_at > now() - interval '24 hours'
        GROUP BY stage_id, error_class
       HAVING COUNT(DISTINCT project_id) >= 3`,
      [workspaceId],
    );
    scanned += clusters.length;
    for (const row of clusters) {
      const errorClass = row.error_class ?? "UNCLASSIFIED";
      findings.push({
        dedupeKey: `watch:cluster:${row.stage_id}:${errorClass}`,
        workspaceId,
        category: "bug",
        severity: errorClass === "BUG" ? "P0" : "P2",
        projectId: null,
        stageId: row.stage_id,
        title: `失败聚类：${row.stage_id} × ${errorClass} 24h 内 ${row.projects} 个项目 / ${row.total} 次`,
        evidence: {
          errorClass,
          occurrences: 1,
          projects: row.projects,
          total: row.total,
          lastAt: String(row.last_at),
          stageId: row.stage_id,
          archiveRoot: join(WORK_DIR, "archive", workspaceId),
          rule: "failure_cluster",
        },
      });
    }

    /* ③ 成本异常 */
    const costly = await stageRows(
      `SELECT * FROM production_stage_runs
        WHERE workspace_id=$1 AND NULLIF(cost->>'cashCny','')::numeric > $2
        ORDER BY NULLIF(cost->>'cashCny','')::numeric DESC LIMIT 20`,
      [workspaceId, COST_CAP],
    );
    scanned += costly.length;
    for (const row of costly) {
      const cashCny = Number(row.cost?.cashCny ?? 0);
      findings.push({
        dedupeKey: `watch:cost:${row.stage_id}`,
        workspaceId,
        category: "optimization",
        severity: "P2",
        projectId: row.project_id,
        stageId: row.stage_id,
        title: `成本异常：${row.project_id}/${row.stage_id} 单环节 ¥${cashCny} 超阈值 ¥${COST_CAP}`,
        evidence: {
          cashCny,
          capCny: COST_CAP,
          occurrences: 1,
          stageId: row.stage_id,
          attempt: row.attempt,
          rule: "cost_outlier",
        },
      });
    }

    /* ④ interrupted 遗留（1 小时内新产生；已有更新 attempt 的行不算——那是被后一轮接续过的历史） */
    const interrupted = await stageRows(
      `SELECT * FROM production_stage_runs
        WHERE workspace_id=$1 AND status='interrupted' AND finished_at > now() - interval '1 hour'
          AND NOT EXISTS (
            SELECT 1 FROM production_stage_runs newer
             WHERE newer.workspace_id = production_stage_runs.workspace_id
               AND newer.project_id = production_stage_runs.project_id
               AND newer.stage_id = production_stage_runs.stage_id
               AND newer.attempt > production_stage_runs.attempt)
        ORDER BY finished_at DESC LIMIT 20`,
      [workspaceId],
    );
    scanned += interrupted.length;
    for (const row of interrupted) {
      findings.push({
        dedupeKey: `watch:interrupted:${row.stage_id}`,
        workspaceId,
        category: "bug",
        severity: "P1",
        projectId: row.project_id,
        stageId: row.stage_id,
        title: `中断未恢复：${row.project_id}/${row.stage_id} attempt=${row.attempt} 仍处于 interrupted`,
        evidence: {
          archiveRoot: join(WORK_DIR, "archive", workspaceId, row.project_id),
          occurrences: 1,
          stageId: row.stage_id,
          attempt: row.attempt,
          finishedAt: row.finished_at,
          rule: "interrupted_pending_resume",
        },
      });
    }

    /* ⑤ 台账 vs 文件对账（文件是本体：台账指向的文件不存在 = 漂移） */
    const withOutput = await stageRows(
      `SELECT * FROM production_stage_runs
        WHERE workspace_id=$1 AND output_ref IS NOT NULL
        ORDER BY started_at DESC LIMIT 200`,
      [workspaceId],
    );
    scanned += withOutput.length;
    const drifted = withOutput.filter((row) => !archiveFileExists(workspaceId, row.project_id, row.output_ref!));
    for (const row of drifted) {
      findings.push({
        dedupeKey: `watch:drift:${row.stage_id}`,
        workspaceId,
        category: "bug",
        severity: "P2",
        projectId: row.project_id,
        stageId: row.stage_id,
        title: `台账/档案漂移：${row.project_id}/${row.stage_id} 的 output_ref 文件不存在`,
        evidence: {
          outputRef: row.output_ref,
          archiveRoot: join(WORK_DIR, "archive", workspaceId, row.project_id),
          occurrences: 1,
          rule: "ledger_file_drift",
        },
      });
    }

    /**
     * ⑥ 恢复未生效（重启后全量重跑）
     *
     * 判定条件（避免误报）：attempt>1 且与上一 attempt 之间有 >60s 空档（= 重启/人工 resume，
     * 不是同一次 run 内的监制打回重试——后者本就没有 checkpoint 可用），且本轮 `resumed!==true`。
     * 证据优先取档案里的 `preCheckpointSnapshot`（跑前快照了几个 checkpoint 文件）。
     */
    const resumeCandidates = await stageRows(
      `SELECT r.*, prev.finished_at AS prev_finished_at
         FROM production_stage_runs r
         JOIN LATERAL (
           SELECT finished_at FROM production_stage_runs p
            WHERE p.workspace_id=r.workspace_id AND p.project_id=r.project_id
              AND p.stage_id=r.stage_id AND p.attempt < r.attempt
            ORDER BY p.attempt DESC LIMIT 1
         ) prev ON true
        WHERE r.workspace_id=$1 AND r.attempt > 1 AND r.output_ref IS NOT NULL
          AND r.started_at > now() - interval '7 days'
        ORDER BY r.started_at DESC LIMIT 100`,
      [workspaceId],
    );
    for (const row of resumeCandidates) {
      const snapshot = resumeEvidence(workspaceId, row.project_id, row.output_ref);
      // 产物里没有 `resumed` 字段 = 该环节不适用续跑语义（渲染/提交段），不报
      if (!snapshot) continue;
      if (snapshot.resumed) continue;
      const prevFinished = (row as unknown as { prev_finished_at: string | null }).prev_finished_at;
      const gapMs = prevFinished ? Date.parse(row.started_at) - Date.parse(prevFinished) : 0;
      const hadCheckpoint = snapshot.snapshots > 0;
      if (!hadCheckpoint && gapMs < 60_000) continue; // 同一次 run 内的重试：不报
      findings.push({
        dedupeKey: `watch:resume:${row.stage_id}`,
        workspaceId,
        category: "optimization",
        severity: "P1",
        projectId: row.project_id,
        stageId: row.stage_id,
        title:
          `恢复未生效：${row.project_id}/${row.stage_id} attempt=${row.attempt}`
          + `${hadCheckpoint ? ` 跑前有 ${snapshot.snapshots} 个 checkpoint` : " 无 checkpoint 快照"}`
          + ` 但 resumed=false（全量重跑 ${Math.round((row.duration_ms ?? 0) / 1000)}s）`,
        evidence: {
          archiveRoot: join(WORK_DIR, "archive", workspaceId, row.project_id),
          checkpointFiles: snapshot.snapshots,
          gapFromPrevAttemptMs: gapMs,
          durationMs: row.duration_ms,
          resumed: false,
          occurrences: 1,
          rule: "resume_ineffective",
          note: "vendor 以 blueprint 指纹校验 Phase checkpoint，不一致即丢弃并删除；根因修复需 blueprint 复用（另立任务卡）",
        },
      });
    }
  }
  return { findings, scanned };
}

/* ================= 写入 ================= */

async function upsertFindings(findings: Finding[]): Promise<Array<{ id: string; dedupeKey: string; occurrences: number; title: string; severity: string }>> {
  const out: Array<{ id: string; dedupeKey: string; occurrences: number; title: string; severity: string }> = [];
  for (const finding of findings) {
    const client = await app.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT set_config('app.workspace_id', $1, true)", [finding.workspaceId]);
      const r = await client.query<{ id: string; occurrences: number }>(
        `INSERT INTO engineering_findings
           (id, workspace_id, category, severity, source, project_id, stage_id, title, evidence, dedupe_key)
         VALUES ($1,$2,$3,$4,'archive_watch',$5,$6,$7,$8::jsonb,$9)
         ON CONFLICT (workspace_id, dedupe_key) DO UPDATE
           SET evidence = jsonb_set(
                 engineering_findings.evidence, '{occurrences}',
                 to_jsonb(COALESCE((engineering_findings.evidence->>'occurrences')::int, 1) + 1)),
               title = EXCLUDED.title,
               severity = EXCLUDED.severity,
               resolved_at = NULL
         RETURNING id, COALESCE((evidence->>'occurrences')::int, 1) AS occurrences`,
        [
          newId("EF"), finding.workspaceId, finding.category, finding.severity,
          finding.projectId, finding.stageId, finding.title,
          JSON.stringify(finding.evidence), finding.dedupeKey,
        ],
      );
      await client.query("COMMIT");
      out.push({
        id: r.rows[0]!.id, dedupeKey: finding.dedupeKey, occurrences: Number(r.rows[0]!.occurrences),
        title: finding.title, severity: finding.severity,
      });
    } catch (err) {
      await client.query("ROLLBACK").catch(() => undefined);
      console.error(`✗ 发现写入失败 ${finding.dedupeKey}: ${(err as Error).message}`);
    } finally {
      client.release();
    }
  }
  return out;
}

const SEVERITY_ORDER: Record<string, number> = { P0: 0, P1: 1, P2: 2, P3: 3 };

function renderIssueMarkdown(rows: Array<{ id: string; dedupeKey: string; occurrences: number; title: string; severity: string }>): string {
  const date = new Date().toISOString().slice(0, 10);
  const lines = [
    `# 制片档案巡检发现（${date}）`,
    "",
    `> 由 \`scripts/tools/archive-watch.mts\` 生成；台账 = production_stage_runs，档案本体 = \`<HR_WORK_DIR>/archive\`。`,
    `> 处理流程：建任务卡（\`scripts/tools/task.mjs new\`）→ 修复 PR → 回写 \`fix_ref\` → 有价值沉淀进 \`docs/badcases/\`。`,
    "",
    "| 严重度 | 任务卡 | 发现 | occurrences | dedupe_key |",
    "|---|---|---|---|---|",
    ...rows
      .sort((a, b) => (SEVERITY_ORDER[a.severity] ?? 9) - (SEVERITY_ORDER[b.severity] ?? 9))
      .map((row) => `| ${row.severity} | [T-${date.slice(0, 4)}-${date.slice(5, 7)}${date.slice(8, 10)}-____] | ${row.title} | ${row.occurrences} | \`${row.dedupeKey}\` |`),
    "",
  ];
  return lines.join("\n");
}

async function createCnbIssue(rows: Array<{ id: string; severity: string; title: string }>): Promise<void> {
  const token = process.env.CNB_TOKEN;
  if (!token) {
    console.warn("! 未配置 CNB_TOKEN：只落文件，不建任务卡（规格书 §7.2 允许）");
    return;
  }
  const p0p1 = rows.filter((row) => row.severity === "P0" || row.severity === "P1");
  if (p0p1.length === 0) {
    console.log("- 无 P0/P1 发现，不建任务卡");
    return;
  }
  /**
   * 任务号口径：`T-YYYY-MMDD-9xxx`（9xxx 段预留给自动巡检卡，避免与人工卡的 0xxx 段撞号）。
   * 提交门禁只校验格式 `\[T-\d{4}-\d{4}-\d{4}\]`，具体编号由本脚本生成并写进 Issue 标题。
   */
  const autoNo = String(9000 + (Date.now() % 1000)).padStart(4, "0");
  const today = new Date().toISOString().slice(0, 10);
  /** 任务号格式 T-YYYY-MMDD-XXXX（协议 §5）：MMDD 是 4 位紧凑日期 */
  const taskDate = `${today.slice(0, 4)}-${today.slice(5, 7)}${today.slice(8, 10)}`;
  const title = `[T-${taskDate}-${autoNo}] 制片档案巡检：P0/P1 发现 ${p0p1.length} 条`;
  const body = [
    "由 `archive-watch.mts` 自动巡检产生（source=archive_watch）。",
    "",
    ...p0p1.map((row) => `- **${row.severity}** ${row.title}（finding ${row.id}）`),
    "",
    "处理要求：按 docs/DEVELOPMENT-PROTOCOL.md 一任务一分支一 PR；修复合并在 PR，处理完把 finding 置 fixed + fix_ref。",
  ].join("\n");
  const res = await fetch(`https://api.cnb.cool/${CNB_REPO}/-/issues`, {
    method: "POST",
    // CNB OpenAPI 要求显式 Accept，否则 406 "either of 'application/json' or 'application/vnd.cnb.api+json'"
    headers: {
      authorization: `Bearer ${token}`,
      accept: "application/json",
      "content-type": "application/json",
    },
    body: JSON.stringify({ title, body, labels: ["t/draft", "src/auto"] }),
  });
  if (!res.ok) {
    console.error(`✗ 建任务卡失败：HTTP ${res.status} ${(await res.text()).slice(0, 200)}`);
    return;
  }
  const created = (await res.json()) as { number?: string; iid?: number };
  console.log(`+ 已建任务卡 #${created.number ?? created.iid ?? "?"}：${title}`);
}

/* ================= main ================= */

const started = Date.now();
const { findings, scanned } = await collectFindings();
/** 同一 dedupe_key 在一次巡检里出现多次（多项目/多 attempt）时，只保留一条并累计次数（台账本身按行累加） */
const merged = new Map<string, { dedupeKey: string; occurrences: number; title: string; severity: string; workspaceId: string; category: Category; projectId: string | null; stageId: string | null; evidence: Record<string, unknown> }>();
for (const finding of findings) {
  const existing = merged.get(finding.dedupeKey);
  if (existing) {
    existing.occurrences += 1;
    existing.evidence = finding.evidence; // 取最新现场
    continue;
  }
  merged.set(finding.dedupeKey, { ...finding, occurrences: 1 });
}
const dedupedFindings = [...merged.values()];
const rows = DRY_RUN ? dedupedFindings.map((f) => ({
  id: `dry-run-${createHash("sha1").update(f.dedupeKey).digest("hex").slice(0, 8)}`,
  dedupeKey: f.dedupeKey, occurrences: f.occurrences, title: f.title, severity: f.severity,
})) : await upsertFindings(dedupedFindings);

mkdirSync(OUT_DIR, { recursive: true });
const mdPath = join(OUT_DIR, "findings-issue.md");
writeFileSync(mdPath, renderIssueMarkdown(rows), "utf8");

if (AS_JSON) {
  console.log(JSON.stringify({ scanned, findings: rows, markdown: mdPath, dryRun: DRY_RUN }, null, 2));
} else {
  console.log(`[archive-watch] 扫描台账行 ${scanned} / 命中发现 ${dedupedFindings.length} 条${DRY_RUN ? "（dry-run 不落库）" : ""}`);
  for (const row of rows.sort((a, b) => (SEVERITY_ORDER[a.severity] ?? 9) - (SEVERITY_ORDER[b.severity] ?? 9))) {
    console.log(`  · [${row.severity}] ${row.title}（occurrences=${row.occurrences}）`);
  }
  console.log(`  清单：${mdPath}（${Date.now() - started}ms）`);
}

if (CREATE_ISSUE) await createCnbIssue(rows);

await owner.end();
await app.end();

// 有 P0（疑似代码缺陷）时给 cron/CI 一个非零退出码，便于外部告警接线
if (rows.some((row) => row.severity === "P0")) process.exitCode = 1;
