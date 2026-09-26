/**
 * archive/store.ts —— 制片档案存储（T-2026-0926-0001）
 *
 * 一部片子 = 一个自包含档案夹：`<workDir>/archive/<workspaceId>/<projectId>/`。
 *
 * 纪律（规格书 §3/§5.1）：
 *   - **append-only**：重试开新 attempt 文件，历史永不覆盖；
 *   - **原子写**：tmp + rename（沿用 vendor checkpoint 模式）；
 *   - **旁路不阻断**：写盘失败只 console.error，绝不阻断主流程（档案是证据，不是闸门）；
 *   - **路径监狱**：所有相对路径收在档案根内，绝对路径与 `..` 越界一律拒绝。
 *
 * 事实源：文件是档案本体（大产物在此），PG 只是索引面（production_stage_runs）。
 */
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";

export const ARCHIVE_SCHEMA_VERSION = "production-archive/v1";

export type PipelineKind = "marketing" | "narrative";

export interface ArchiveLedgerEntry {
  attempt: number;
  status: string;
  finishedAt: string | null;
}

export interface ArchiveManifest {
  schemaVersion: string;
  projectId: string;
  workspaceId: string;
  /** 管线类型（两条制片管线：marketing 含前置情报层 / narrative 通用；见规格书 §5.4） */
  pipelineKind: PipelineKind;
  /** 路由决策元数据（aspectRatio 9:16 等，供跨会话承接重建上下文） */
  routeMeta?: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
  /** 环节账本：stageId → 最新一次 attempt 摘要 */
  ledger: Record<string, ArchiveLedgerEntry>;
}

/** 档案相对路径监狱：拒绝绝对路径与越出档案根的 `..`（回归：`../../etc/passwd`） */
export function assertInsideRoot(root: string, relPath: string): string {
  if (!relPath || path.isAbsolute(relPath)) {
    throw new Error(`档案路径必须是档案根内的相对路径：${relPath}`);
  }
  const abs = path.resolve(root, relPath);
  const rootResolved = path.resolve(root);
  if (abs !== rootResolved && !abs.startsWith(rootResolved + path.sep)) {
    throw new Error(`档案路径越出档案根：${relPath}`);
  }
  return abs;
}

export class ArchiveStore {
  readonly root: string;

  constructor(
    workDir: string,
    readonly workspaceId: string,
    readonly projectId: string,
    readonly pipelineKind: PipelineKind = "narrative",
    readonly routeMeta?: Record<string, unknown>,
  ) {
    // 路径监狱：与 dossiers 同口径收在 workDir 下，不接受外部传入的绝对路径
    this.root = path.join(workDir, "archive", workspaceId, projectId);
  }

  /** 建档案夹 + 写 manifest（已存在则原样保留，不覆盖历史） */
  async ensure(): Promise<void> {
    await fs.mkdir(this.root, { recursive: true });
    const manifestPath = path.join(this.root, "manifest.json");
    try {
      await fs.access(manifestPath);
    } catch {
      const now = new Date().toISOString();
      const manifest: ArchiveManifest = {
        schemaVersion: ARCHIVE_SCHEMA_VERSION,
        projectId: this.projectId,
        workspaceId: this.workspaceId,
        pipelineKind: this.pipelineKind,
        ...(this.routeMeta ? { routeMeta: this.routeMeta } : {}),
        createdAt: now,
        updatedAt: now,
        ledger: {},
      };
      await this.writeJsonAtomic("manifest.json", manifest);
    }
  }

  /** 原子写 JSON（tmp + rename）；返回产物 sha256（对账用） */
  async writeJsonAtomic(relPath: string, data: unknown): Promise<{ sha256: string }> {
    const abs = assertInsideRoot(this.root, relPath);
    await fs.mkdir(path.dirname(abs), { recursive: true });
    const tmp = `${abs}.tmp`;
    const body = JSON.stringify(data, null, 2);
    await fs.writeFile(tmp, body, "utf8");
    await fs.rename(tmp, abs);
    return { sha256: createHash("sha256").update(body).digest("hex") };
  }

  /** 追加一行到 JSONL（events.jsonl / logs/<stage>.jsonl），自动带 ts */
  async appendJsonl(relPath: string, record: unknown): Promise<void> {
    const abs = assertInsideRoot(this.root, relPath);
    await fs.mkdir(path.dirname(abs), { recursive: true });
    const line = `${JSON.stringify({ ts: new Date().toISOString(), ...(record as object) })}\n`;
    await fs.appendFile(abs, line, "utf8");
  }

  async readJson<T>(relPath: string): Promise<T | null> {
    try {
      return JSON.parse(await fs.readFile(assertInsideRoot(this.root, relPath), "utf8")) as T;
    } catch {
      return null;
    }
  }

  async readText(relPath: string): Promise<string | null> {
    try {
      return await fs.readFile(assertInsideRoot(this.root, relPath), "utf8");
    } catch {
      return null;
    }
  }

  /** 读档案事件流（append-only JSONL，坏行跳过；监控/对账用） */
  async readEvents(limit = 200): Promise<Record<string, unknown>[]> {
    const text = await this.readText("events.jsonl");
    if (!text) return [];
    const lines = text.split("\n").filter((line) => line.trim());
    return lines.slice(-limit).flatMap((line) => {
      try {
        return [JSON.parse(line) as Record<string, unknown>];
      } catch {
        return [];
      }
    });
  }

  /** 该 stage 已发生的 attempt 文件名清单（审计"历史不丢"用） */
  async listAttempts(stageId: string): Promise<{ attempt: number; files: string[] }[]> {
    const dir = assertInsideRoot(this.root, `stages/${stageId}`);
    let names: string[] = [];
    try {
      names = await fs.readdir(dir);
    } catch {
      return [];
    }
    const byAttempt = new Map<number, string[]>();
    for (const name of names) {
      const matched = /^attempt-(\d+)\.(.+)$/.exec(name);
      if (!matched) continue;
      const attempt = Number(matched[1]);
      byAttempt.set(attempt, [...(byAttempt.get(attempt) ?? []), name]);
    }
    return [...byAttempt.entries()]
      .map(([attempt, files]) => ({ attempt, files: files.sort() }))
      .sort((a, b) => a.attempt - b.attempt);
  }

  /** 更新 manifest 账本（读改写；单执行者模型下无并发，项目级租约见 apps/server archive-host.ts） */
  async updateLedger(stageId: string, entry: ArchiveLedgerEntry): Promise<void> {
    const manifest = await this.readJson<ArchiveManifest>("manifest.json");
    if (!manifest) return;
    manifest.ledger[stageId] = entry;
    manifest.updatedAt = new Date().toISOString();
    await this.writeJsonAtomic("manifest.json", manifest);
  }

  /** 幂等补齐 manifest（档案夹存在但 manifest 缺失/损坏时重建；不丢已有账本） */
  async readManifest(): Promise<ArchiveManifest | null> {
    return this.readJson<ArchiveManifest>("manifest.json");
  }

  /**
   * 把档案夹**外部**的运行态目录快照进档案（只读源目录，不删不改）。
   *
   * 为什么需要（真机发现的方案缺陷修复）：vendor 的 Phase checkpoint 在做指纹校验失败时
   * 会**删除**自己的 checkpoint 文件（`production-engine.js#_loadLatestCheckpoint`），
   * 于是"曾经有过断点、但恢复没生效"这段过程证据在重跑后被就地销毁。
   * 档案是过程证据的本体：每轮 attempt 开跑前留一份只读快照，恢复是否命中都能事后对账。
   *
   * @param sourceAbsDir 源目录绝对路径（例如 `<WORK_DIR>/checkpoints/<projectId>`）
   * @param destRelDir   档案内相对目录（例如 `checkpoints/attempt-2-before`）
   */
  async snapshotExternalDir(
    sourceAbsDir: string,
    destRelDir: string,
    opts: { maxFiles?: number; maxBytes?: number; filter?: (name: string) => boolean } = {},
  ): Promise<{ files: number; bytes: number; skipped: string[] }> {
    const maxFiles = opts.maxFiles ?? 200;
    const maxBytes = opts.maxBytes ?? 32 * 1024 * 1024;
    const destAbs = assertInsideRoot(this.root, destRelDir);
    let names: string[] = [];
    try {
      names = await fs.readdir(sourceAbsDir);
    } catch {
      return { files: 0, bytes: 0, skipped: [] };
    }
    const skipped: string[] = [];
    let files = 0;
    let bytes = 0;
    for (const name of names.sort()) {
      if (files >= maxFiles) {
        skipped.push(`${name}(超文件数上限)`);
        continue;
      }
      if (opts.filter && !opts.filter(name)) continue;
      const from = path.join(sourceAbsDir, name);
      let stat;
      try {
        stat = await fs.stat(from);
      } catch {
        continue;
      }
      if (!stat.isFile()) continue;
      if (bytes + stat.size > maxBytes) {
        skipped.push(`${name}(超体积上限)`);
        continue;
      }
      await fs.mkdir(path.dirname(destAbs), { recursive: true });
      await fs.mkdir(destAbs, { recursive: true });
      await fs.copyFile(from, path.join(destAbs, name));
      files += 1;
      bytes += stat.size;
    }
    return { files, bytes, skipped };
  }
}
