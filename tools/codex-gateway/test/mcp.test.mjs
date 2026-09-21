import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { join } from "node:path";
import { gatewayRoot, resolveRepoRoot } from "../src/paths.mjs";
import { createMcpHandler } from "../src/mcp.mjs";
import { generateCatalog } from "../src/catalog.mjs";
import { createStore } from "../src/store.mjs";
import { createFakePolicy } from "../src/policy-client.mjs";
import { createRunService } from "../src/runs.mjs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";

test("MCP handler：握手、工具、资源", async () => {
  const repoRoot = resolveRepoRoot();
  const catalog = generateCatalog({ repoRoot });
  const service = createRunService({ repoRoot, catalog, store: createStore({ dataDir: mkdtempSync(join(tmpdir(), "workloom-gw-mcp-")) }), policy: createFakePolicy() });
  const handler = createMcpHandler({ repoRoot, catalog, runService: service });
  const init = await handler.handle({ jsonrpc: "2.0", id: 1, method: "initialize", params: { clientInfo: { name: "test" } } });
  assert.equal(init.result.serverInfo.name, "workloom-codex-gateway");
  assert.ok(init.result.capabilities.tools);

  const tools = await handler.handle({ jsonrpc: "2.0", id: 2, method: "tools/list" });
  assert.ok(tools.result.tools.length >= 12);
  const names = tools.result.tools.map((tool) => tool.name);
  assert.ok(names.includes("workloom_catalog_search"));
  assert.ok(names.includes("workloom_stage_snapshot"));
  assert.ok(names.includes("workloom_run_start"));
  assert.ok(names.includes("workloom_approval_decide"));

  const call = await handler.handle({
    jsonrpc: "2.0",
    id: 3,
    method: "tools/call",
    params: { name: "workloom_catalog_search", arguments: { query: "GEO", limit: 5 } },
  });
  const payload = JSON.parse(call.result.content[0].text);
  assert.ok(payload.capabilities.length > 0);
  assert.equal(payload.dataMode, "generated");

  const missing = await handler.handle({
    jsonrpc: "2.0",
    id: 4,
    method: "tools/call",
    params: { name: "workloom_catalog_describe", arguments: { capabilityId: "does-not-exist" } },
  });
  assert.equal(missing.result.isError, true);

  const resources = await handler.handle({ jsonrpc: "2.0", id: 5, method: "resources/list" });
  assert.equal(resources.result.resources.length, 3);
  const read = await handler.handle({ jsonrpc: "2.0", id: 6, method: "resources/read", params: { uri: "workloom://health" } });
  assert.equal(read.result.contents[0].uri, "workloom://health");

  const runStart = await handler.handle({
    jsonrpc: "2.0",
    id: 7,
    method: "tools/call",
    params: { name: "workloom_run_start", arguments: { capabilityId: "pipeline:dual-content-factory" } },
  });
  const runPayload = JSON.parse(runStart.result.content[0].text);
  assert.equal(runPayload.run.state, "waiting_approval");
  const decide = await handler.handle({
    jsonrpc: "2.0",
    id: 8,
    method: "tools/call",
    params: { name: "workloom_approval_decide", arguments: { approvalId: runPayload.approval.approvalId, gesture: { type: "approve" } } },
  });
  const decidePayload = JSON.parse(decide.result.content[0].text);
  assert.equal(decidePayload.run.state, "completed");
  service.close();
});

test("MCP stdio 入口可被真实拉起", async () => {
  const child = spawn(process.execPath, [join(gatewayRoot(), "bin", "mcp.mjs")], {
    env: { ...process.env, WORKLOOM_REPO_ROOT: resolveRepoRoot() },
    stdio: ["pipe", "pipe", "pipe"],
  });
  const rl = createInterface({ input: child.stdout });
  const replies = [];
  const done = new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(`MCP stdio 超时，已收到 ${replies.length} 条回复`)), 8000);
    rl.on("line", (line) => {
      try {
        replies.push(JSON.parse(line));
      } catch {
        return;
      }
      if (replies.length >= 2) {
        clearTimeout(timeout);
        resolve();
      }
    });
    child.once("error", reject);
  });

  child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} })}\n`);
  child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" })}\n`);
  await done;
  child.kill("SIGTERM");

  assert.equal(replies[0].result.serverInfo.name, "workloom-codex-gateway");
  assert.ok(replies[1].result.tools.length >= 5);
});
