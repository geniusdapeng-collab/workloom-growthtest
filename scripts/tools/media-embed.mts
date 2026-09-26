#!/usr/bin/env tsx
/**
 * media-embed.mts —— 媒资向量回填（T-2026-0926-0010 规格书 §7.4）
 *
 * 扫 `embedding IS NULL AND (title|prompt|tags 非空)` 的素材，拼 `title + "\n" + prompt + "\n" + tags`
 * 走 model-router 的 embeddings 通道（OpenAI 兼容；缺密钥回落到 MockEmbedder 并**显式标注 mock**），
 * 批量回填 `video_assets.embedding`。幂等可重跑：只处理 NULL 行，单行失败留 NULL 下轮再来。
 *
 * 用法：
 *   pnpm exec tsx --env-file=.env scripts/tools/media-embed.mts [--workspace ws-video] [--batch 50] [--max 500] [--json]
 * 启用语义检索：`.env` 设 `MEDIA_SEMANTIC_ENABLED=1`（缺省 0：检索行为与 P1 一致）。
 */
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import pg from "pg";
import { backfillEmbeddings } from "../../apps/server/src/video/media/embed.js";

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

const app = new pg.Pool({ connectionString: process.env.DATABASE_APP_URL ?? DATABASE_URL });
const owner = new pg.Pool({ connectionString: DATABASE_URL });
const ONLY_WORKSPACE = arg("--workspace");
const BATCH = Number(arg("--batch", "50")) || 50;
const MAX = Number(arg("--max", "500")) || 500;
const AS_JSON = flag("--json");

interface WorkspaceRow { id: string; tenant_id: string }

async function targets(): Promise<WorkspaceRow[]> {
  const rows = await owner.query<WorkspaceRow>(
    ONLY_WORKSPACE
      ? `SELECT id, tenant_id FROM workspaces WHERE id = $1`
      : `SELECT id, tenant_id FROM workspaces ORDER BY created_at ASC`,
    ONLY_WORKSPACE ? [ONLY_WORKSPACE] : []);
  return rows.rows;
}

try {
  const list = await targets();
  if (list.length === 0) {
    console.log("没有可回填的工作区（检查 --workspace 或种子数据）");
  }
  const report: Array<Record<string, unknown>> = [];
  for (const workspace of list) {
    const scope = { tenantId: workspace.tenant_id, workspaceId: workspace.id };
    const result = await backfillEmbeddings(app, scope, { batch: BATCH, max: MAX });
    report.push({ workspaceId: workspace.id, ...result });
    console.log(
      `- ${workspace.id}：扫描 ${result.scanned} / 回填 ${result.embedded} / 失败 ${result.failed}`
      + `${result.mock ? "（Mock 向量：无语义，仅串联链路；配 LLM_BASE_URL+LLM_API_KEY 后重跑可得真实语义）" : `（模型 ${result.model}）`}`,
    );
    for (const error of result.errors.slice(0, 5)) console.warn(`    ! ${error}`);
  }
  if (AS_JSON) console.log(JSON.stringify({ report }, null, 2));
} catch (err) {
  console.error(`回填失败：${err instanceof Error ? err.message : String(err)}`);
  process.exitCode = 1;
} finally {
  await app.end().catch(() => undefined);
  await owner.end().catch(() => undefined);
}
