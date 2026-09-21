/**
 * 真实业务库事件镜像（P4）：把网关 append-only JSONL 中的五元事件写入 workdata。
 *
 * 约束：
 *  - 通过策略桥的 `appendEvent` 走真实 `gatewayAppend`（权限 → PII → 高风险授权 → 同事务落库）；
 *  - 本地 event_id 与 DB event_id 的映射写入 `<dataDir>/mirror.jsonl`（append-only），可审计；
 *  - 镜像失败不回滚本地治理链，但必须记录 error 并在 Run 上暴露 `dbMirror`，禁止静默成功。
 */
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

function mapWho(who = {}) {
  if (who.type === "codex") return { type: "system", id: "system", version: who.version ?? "p1" };
  return { type: who.type ?? "system", id: who.id ?? "system", ...(who.version ? { version: who.version } : {}) };
}

export function createDbMirror({ policy, tenantId, workspaceId, dataDir }) {
  if (!policy || !dataDir) return null;
  const path = join(dataDir, "mirror.jsonl");
  const existing = existsSync(path)
    ? readFileSync(path, "utf8")
        .split(/\r?\n/)
        .filter(Boolean)
        .flatMap((line) => {
          try {
            return [JSON.parse(line)];
          } catch {
            return [];
          }
        })
    : [];
  const mapped = new Set(existing.filter((row) => row.ok).map((row) => row.localEventId));
  const record = (row) => {
    appendFileSync(path, `${JSON.stringify(row)}\n`, "utf8");
    existing.push(row);
  };

  async function mirrorEvent(localEvent) {
    if (mapped.has(localEvent.event_id)) {
      const prior = existing.find((row) => row.localEventId === localEvent.event_id && row.ok);
      return { ok: true, localEventId: localEvent.event_id, dbEventId: prior?.dbEventId ?? null, deduped: true };
    }
    const actor = mapWho(localEvent.who);
    try {
      const result = await policy.appendEvent({
        ctx: { tenantId, workspaceId, actor },
        draft: {
          who: actor,
          context: {
            tenant_id: tenantId,
            workspace_id: workspaceId,
            time: localEvent.ts ?? new Date().toISOString(),
            channel: localEvent.context?.channel ?? "codex",
          },
          object: localEvent.object ?? { type: "unknown" },
          decision: {
            action: localEvent.decision?.action ?? "unknown",
            ...(localEvent.decision?.before !== undefined ? { before: localEvent.decision.before } : {}),
            ...(localEvent.decision?.after !== undefined ? { after: localEvent.decision.after } : {}),
            ...(localEvent.decision?.basis ? { basis: localEvent.decision.basis } : {}),
          },
          rule_impact: localEvent.rule_impact ?? [],
        },
      });
      const row = { localEventId: localEvent.event_id, dbEventId: result.eventId, ok: true, at: new Date().toISOString() };
      record(row);
      mapped.add(localEvent.event_id);
      return row;
    } catch (error) {
      const row = { localEventId: localEvent.event_id, ok: false, error: error instanceof Error ? error.message : String(error), at: new Date().toISOString() };
      record(row);
      return row;
    }
  }

  return {
    path,
    async mirrorRun(store, runId) {
      const events = store.listLedger().filter((event) => (event.links ?? []).includes(runId));
      const results = [];
      for (const event of events) results.push(await mirrorEvent(event));
      const ok = results.filter((row) => row.ok).length;
      const failed = results.length - ok;
      return { ok: failed === 0, total: results.length, mirrored: ok, failed, dbEventIds: results.filter((row) => row.ok).map((row) => row.dbEventId) };
    },
    mirrorEvent,
  };
}
