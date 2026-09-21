import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveRepoRoot } from "../src/paths.mjs";
import { generateCatalog } from "../src/catalog.mjs";
import { createStore } from "../src/store.mjs";
import { createFakePolicy } from "../src/policy-client.mjs";
import { createRunService } from "../src/runs.mjs";
import { createDbMirror } from "../src/mirror.mjs";

test("DB 镜像：本地五元事件映射到真实网关写入接口并去重", async () => {
  const repoRoot = resolveRepoRoot();
  const catalog = generateCatalog({ repoRoot });
  const dataDir = mkdtempSync(join(tmpdir(), "workloom-gw-mirror-"));
  const store = createStore({ dataDir });
  let calls = 0;
  const policy = {
    ...createFakePolicy(),
    async appendEvent({ ctx, draft }) {
      calls += 1;
      assert.equal(ctx.tenantId, "tenant-demo");
      assert.equal(ctx.workspaceId, "ws-geo");
      assert.equal(ctx.actor.type, "system");
      assert.ok(draft.decision.action);
      return { eventId: `E-${9000 + calls}`, piiHits: 0 };
    },
  };
  const mirror = createDbMirror({ policy, tenantId: "tenant-demo", workspaceId: "ws-geo", dataDir });
  const service = createRunService({ repoRoot, catalog, store, policy, mirror });

  const started = await service.startRun({ capabilityId: "pipeline:dual-content-factory", action: "publish.execute", objectType: "publish_task", context: { account_daily_published: 0 } });
  assert.equal(started.run.state, "waiting_approval");
  const decided = await service.decideApproval({ approvalId: started.approval.approvalId, gesture: { type: "approve" } });
  assert.equal(decided.run.state, "completed");
  assert.equal(decided.run.dbMirror.ok, true);
  assert.ok(decided.run.dbMirror.mirrored >= 4, `mirrored=${decided.run.dbMirror.mirrored}`);
  assert.equal(decided.run.dbMirror.failed, 0);

  const mirrorPath = join(dataDir, "mirror.jsonl");
  assert.ok(existsSync(mirrorPath));
  const rows = readFileSync(mirrorPath, "utf8").trim().split("\n").map((line) => JSON.parse(line));
  assert.ok(rows.length >= 4);
  assert.ok(rows.every((row) => row.ok && row.dbEventId));

  const before = calls;
  const again = await mirror.mirrorRun(store, started.run.runId);
  assert.equal(again.ok, true);
  assert.equal(calls, before, "重复镜像应去重，不重复写 DB");
  assert.ok(again.mirrored >= 4);
});
