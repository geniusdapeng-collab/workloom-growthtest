/**
 * Append-only JSONL 存储（P1 实验适配器）。
 *
 * 纪律：
 *  - 只增不改：runs/approvals 的每次状态变化追加一条带 revision 的完整记录，物化视图取最后一条；
 *  - 五元事件账本：event_id 单调递增，hash = sha256(prevHash + canonical(event))，可 verify；
 *  - 多进程可见：CLI / MCP / stage 服务可能各自持有 store 实例，读操作前按文件大小变化自动重载；
 *  - 运行时数据落在 <repo>/data/codex-gateway/（.gitignore 已忽略 data/），不进仓库；
 *  - 该适配器是 P1 实验实现；生产应切到 workdata（RLS + 同事务 + 幂等号源）。
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";

function readJsonl(path) {
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8")
    .split(/\r?\n/)
    .filter(Boolean)
    .flatMap((line) => {
      try {
        return [JSON.parse(line)];
      } catch {
        return [];
      }
    });
}

function sizeOf(path) {
  try {
    return statSync(path).size;
  } catch {
    return 0;
  }
}

export function canonicalize(value) {
  // 对齐 JSON.stringify 语义：对象里 undefined 值的键会被丢弃，数组里 undefined 变 null。
  // 否则写入时算进的 undefined 字段在落盘/重载后被 JSON 丢掉，哈希链跨进程必坏。
  if (value === undefined) return "null";
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((item) => (item === undefined ? "null" : canonicalize(item))).join(",")}]`;
  return `{${Object.keys(value)
    .filter((key) => value[key] !== undefined)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalize(value[key])}`)
    .join(",")}}`;
}

export function hashEvent(prevHash, event) {
  return createHash("sha256").update(`${prevHash}\n${canonicalize(event)}`).digest("hex");
}

export function createStore({ dataDir }) {
  mkdirSync(dataDir, { recursive: true });
  const paths = {
    runs: join(dataDir, "runs.jsonl"),
    approvals: join(dataDir, "approvals.jsonl"),
    ledger: join(dataDir, "ledger.jsonl"),
  };

  const runs = new Map();
  const approvals = new Map();
  const ledger = [];
  let lastHash = "GENESIS";
  let seq = 0;
  const sizes = { runs: -1, approvals: -1, ledger: -1 };

  function loadAll() {
    runs.clear();
    for (const record of readJsonl(paths.runs)) runs.set(record.runId, record);
    approvals.clear();
    for (const record of readJsonl(paths.approvals)) approvals.set(record.approvalId, record);
    ledger.length = 0;
    ledger.push(...readJsonl(paths.ledger));
    lastHash = ledger.length ? ledger[ledger.length - 1].hash ?? "GENESIS" : "GENESIS";
    seq = ledger.reduce((max, event) => {
      const match = String(event.event_id ?? "").match(/^E-(\d+)$/);
      return match ? Math.max(max, Number(match[1])) : max;
    }, 0);
    sizes.runs = sizeOf(paths.runs);
    sizes.approvals = sizeOf(paths.approvals);
    sizes.ledger = sizeOf(paths.ledger);
  }

  function refreshIfChanged() {
    if (sizeOf(paths.runs) !== sizes.runs || sizeOf(paths.approvals) !== sizes.approvals || sizeOf(paths.ledger) !== sizes.ledger) {
      loadAll();
    }
  }

  loadAll();

  const append = (path, record, key) => {
    refreshIfChanged();
    appendFileSync(path, `${JSON.stringify(record)}\n`, "utf8");
    if (key) sizes[key] = sizeOf(path);
  };

  return {
    paths,
    dataDir,
    reload: loadAll,
    appendRun(record) {
      refreshIfChanged();
      const previous = runs.get(record.runId);
      const next = { ...record, revision: (previous?.revision ?? 0) + 1 };
      append(paths.runs, next, "runs");
      runs.set(next.runId, next);
      return next;
    },
    getRun(runId) {
      refreshIfChanged();
      return runs.get(runId) ?? null;
    },
    listRuns() {
      refreshIfChanged();
      return [...runs.values()].sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)));
    },
    findByCapabilityAndStatus(capabilityId, states = []) {
      refreshIfChanged();
      return [...runs.values()].filter((run) => run.capabilityId === capabilityId && (!states.length || states.includes(run.state)));
    },
    findByIdempotencyKey(key) {
      if (!key) return null;
      refreshIfChanged();
      return [...runs.values()].find((run) => run.idempotencyKey === key) ?? null;
    },
    appendApproval(record) {
      refreshIfChanged();
      const previous = approvals.get(record.approvalId);
      const next = { ...record, revision: (previous?.revision ?? 0) + 1 };
      append(paths.approvals, next, "approvals");
      approvals.set(next.approvalId, next);
      return next;
    },
    getApproval(approvalId) {
      refreshIfChanged();
      return approvals.get(approvalId) ?? null;
    },
    listApprovals({ status } = {}) {
      refreshIfChanged();
      return [...approvals.values()]
        .filter((approval) => !status || approval.status === status)
        .sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)));
    },
    /** 追加五元事件；调用方给出不含 event_id/hash/ts 的事件主体。 */
    appendLedger({ who, context, object, decision, rule_impact, receipt, links, model_trace, ...rest }) {
      refreshIfChanged();
      seq += 1;
      const base = {
        event_id: `E-${seq}`,
        who,
        context,
        object,
        decision,
        rule_impact: rule_impact ?? [],
        ...(receipt ? { receipt } : {}),
        ...(links ? { links } : {}),
        ...(model_trace ? { model_trace } : {}),
        ...rest,
        ts: new Date().toISOString(),
      };
      const hash = hashEvent(lastHash, base);
      const record = { ...base, hash };
      append(paths.ledger, record, "ledger");
      ledger.push(record);
      lastHash = hash;
      return record;
    },
    listLedger({ since } = {}) {
      refreshIfChanged();
      if (!since) return [...ledger];
      const match = String(since).match(/^E-(\d+)$/);
      const from = match ? Number(match[1]) : 0;
      return ledger.filter((event) => {
        const id = String(event.event_id ?? "").match(/^E-(\d+)$/);
        return id ? Number(id[1]) > from : false;
      });
    },
    get lastEventId() {
      refreshIfChanged();
      return seq ? `E-${seq}` : null;
    },
    verifyLedger() {
      refreshIfChanged();
      let prev = "GENESIS";
      for (const event of ledger) {
        const { hash, ...base } = event;
        const expected = hashEvent(prev, base);
        if (expected !== hash) {
          return { ok: false, brokenAt: event.event_id, expected, actual: hash, total: ledger.length };
        }
        prev = hash;
      }
      return { ok: true, total: ledger.length, lastHash: prev };
    },
  };
}
