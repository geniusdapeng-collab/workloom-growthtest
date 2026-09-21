import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveRepoRoot } from "../src/paths.mjs";
import { startGateway } from "../src/server.mjs";

test("HTTP 网关：health / catalog / snapshot / stage 页面 / SSE", async (t) => {
  const instance = await startGateway({ port: 0, repoRoot: resolveRepoRoot() });
  t.after(() => instance.close());

  const health = await (await fetch(`${instance.url}/health`)).json();
  assert.equal(health.ok, true);
  assert.equal(health.mode, "read-only");
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
  assert.match(html, /P0 只读实验/);

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
  const instance = await startGateway({ port: 0, repoRoot: resolveRepoRoot() });
  t.after(() => instance.close());
  const response = await fetch(`${instance.url}/stage/../../product.manifest.json`);
  assert.ok([403, 404].includes(response.status), `status=${response.status}`);
});
