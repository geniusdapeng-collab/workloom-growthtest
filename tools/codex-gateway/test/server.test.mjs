import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveRepoRoot } from "../src/paths.mjs";
import { startGateway } from "../src/server.mjs";
import { generateCatalog } from "../src/catalog.mjs";
import { createStore } from "../src/store.mjs";
import { createFakePolicy } from "../src/policy-client.mjs";
import { createRunService } from "../src/runs.mjs";

function makeService(verdicts) {
  const repoRoot = resolveRepoRoot();
  const catalog = generateCatalog({ repoRoot });
  const store = createStore({ dataDir: mkdtempSync(join(tmpdir(), "workloom-gw-srv-")) });
  return createRunService({ repoRoot, catalog, store, policy: createFakePolicy(verdicts) });
}

test("HTTP 网关：health / catalog / snapshot / stage 页面 / SSE", async (t) => {
  const service = makeService({});
  const instance = await startGateway({ port: 0, repoRoot: resolveRepoRoot(), runService: service });
  t.after(() => instance.close());
  t.after(() => service.close());

  const health = await (await fetch(`${instance.url}/health`)).json();
  assert.equal(health.ok, true);
  assert.equal(health.mode, "governed");
  assert.ok(health.counts.employees > 0);

  const summary = await (await fetch(`${instance.url}/catalog?summary=1`)).json();
  assert.ok(summary.summary.pipelines >= 4);

  const snapshot = await (await fetch(`${instance.url}/stage/snapshot`)).json();
  assert.equal(snapshot.dataMode, "mock");
  assert.ok(snapshot.agents.length >= 27);
  assert.ok(snapshot.approvals.length >= 1);
  assert.ok(snapshot.runs.length >= 1);
  assert.ok(snapshot.capabilities.pipelines.length >= 4);

  const html = await (await fetch(instance.stageUrl)).text();
  assert.match(html, /数字人团队工作台/);
  assert.match(html, /P1 治理实验/);

  const controller = new AbortController();
  const stream = await fetch(`${instance.url}/stage/stream?demo=1`, { signal: controller.signal });
  assert.equal(stream.headers.get("content-type"), "text/event-stream; charset=utf-8");
  const reader = stream.body.getReader();
  const first = await reader.read();
  const text = new TextDecoder().decode(first.value);
  assert.match(text, /event: stage\.snapshot/);
  assert.match(text, /"dataMode":"mock"/);
  controller.abort();
});

test("静态资源路径穿越被拒绝", async (t) => {
  const service = makeService({});
  const instance = await startGateway({ port: 0, repoRoot: resolveRepoRoot(), runService: service });
  t.after(() => instance.close());
  t.after(() => service.close());
  const response = await fetch(`${instance.url}/stage/../../product.manifest.json`);
  assert.ok([403, 404].includes(response.status), `status=${response.status}`);
});

test("P1 写路径：经 HTTP 走完 review → approve → completed", async (t) => {
  const service = makeService({});
  const instance = await startGateway({ port: 0, repoRoot: resolveRepoRoot(), runService: service });
  t.after(() => instance.close());
  t.after(() => service.close());

  const started = await (
    await fetch(`${instance.url}/runs`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ capabilityId: "pipeline:dual-content-factory", action: "publish.execute", objectType: "publish_task" }),
    })
  ).json();
  assert.equal(started.run.state, "waiting_approval");

  const decided = await (
    await fetch(`${instance.url}/approvals/${encodeURIComponent(started.approval.approvalId)}/decide`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ gesture: { type: "approve" }, role: "owner" }),
    })
  ).json();
  assert.equal(decided.run.state, "completed");
  assert.equal(decided.run.receipt.synced, true);

  const verified = await (await fetch(`${instance.url}/ledger/verify`)).json();
  assert.equal(verified.ok, true);
  const snapshot = await (await fetch(`${instance.url}/stage/snapshot`)).json();
  assert.equal(snapshot.dataMode, "simulated");
  assert.ok(snapshot.runs.some((run) => run.runId === started.run.runId));
});
