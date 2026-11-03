import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { runSourceSession } from "./workloom-source-session.mjs";

const run = promisify(execFile);
const root = realpathSync(fileURLToPath(new URL("..", import.meta.url)));
const product = JSON.parse(readFileSync(join(root, "product.manifest.json"), "utf8"));
const fixtureToken = "header.sourceSessionFixture.signature";
const fixtureKey = "a".repeat(64);
const config = {
  WORKLOOM_BASE_URL: "http://127.0.0.1:9123",
  WORKLOOM_DESKTOP_INSTANCE_ID: "local-source-a",
  WORKLOOM_DESKTOP_LOGIN_KEY: fixtureKey,
  WORKLOOM_DESKTOP_MEMBER: "MEM-G01",
  WORKLOOM_SOURCE_TENANT_ID: "tenant-test",
  WORKLOOM_SOURCE_WORKSPACE_ID: "ws-test",
};
const identity = { memberId: "MEM-T1", memberNo: "MEM-G01", tenantId: "tenant-test", workspaceId: "ws-test" };
const health = { ok: true, productId: product.productId, desktopInstanceId: "local-source-a" };
const access = {
  schemaVersion: "workloom.client-access/v1",
  scope: { tenantId: identity.tenantId, workspaceId: identity.workspaceId },
  subject: { kind: "member", id: identity.memberId, memberNo: identity.memberNo },
  authority: { source: "server" },
};
const trpc = data => ({ result: { data } });
const readonlyArgs = ["agent", "--", "list"];
const workRoots = [];
const studioWorkRoot = () => {
  const dir = mkdtempSync(join(tmpdir(), "growthtest-start-"));
  workRoots.push(dir);
  return dir;
};
const studioStart = (workRoot = studioWorkRoot(), file = "-") => ["studio", "--", "start", "--work-root", workRoot, "--input-file", file];
test.afterEach(() => workRoots.splice(0).forEach(dir => rmSync(dir, { recursive: true, force: true })));
const studioIntent = { intent: "用 Growthtest 制作 18 秒雨后山间民宿短片。\n保留原始引号与动作。", durationSec: 18 };
const studioReceipt = { kind: "routed", projectId: "VID-T", runId: "RUN-T", pipeline: "narrative" };
const shotsReceipt = { projectId: "VID-T", sourceStageRunId: "SR-T", sourceAttempt: 1, promptsSha256: "a".repeat(64),
  shots: [{ shotId: "S1", durationSec: 9, promptSha256: "b".repeat(64) }] };

function fixtures({ healthBody = health, login = trpc({ token: fixtureToken, identity }), accessBody = trpc(access), status = 200, studio } = {}) {
  const calls = [];
  const responses = [Response.json(healthBody), Response.json(login, { status }), Response.json(accessBody)];
  if (studio !== undefined) responses.push(Response.json(trpc(studio)));
  const fetcher = async (url, init) => { calls.push({ url, init }); return responses[calls.length - 1]; };
  const spawnCalls = [];
  const spawnImpl = (...args) => {
    spawnCalls.push(args);
    const child = new EventEmitter();
    queueMicrotask(() => child.emit("exit", 9));
    return child;
  };
  return { calls, spawnCalls, fetcher, spawnImpl };
}

test("studio start preserves original intent and target through a single verified native dispatch", async () => {
  const f = fixtures({ studio: studioReceipt });
  const lines = [];
  const input = Readable.from([Buffer.from(JSON.stringify(studioIntent))]);
  assert.equal(await runSourceSession(studioStart(), { ...f, env: config, input, output: line => lines.push(line) }), 0);
  assert.deepEqual(f.calls.map(call => new URL(call.url).pathname),
    ["/health", "/trpc/auth.desktopLogin", "/trpc/access.me", "/trpc/video.studio.start"]);
  assert.equal(f.calls[3].init.method, "POST");
  assert.deepEqual(JSON.parse(f.calls[3].init.body), { ...studioIntent, route: "auto" });
  assert.deepEqual(f.calls[3].init.headers, { "content-type": "application/json", authorization: "Bearer " + fixtureToken });
  assert.equal(f.calls[3].init.redirect, "error");
  assert.equal(f.spawnCalls.length, 0);
  const parsed = JSON.parse(lines[0]);
  assert.match(parsed.requestSha256, /^[a-f0-9]{64}$/u);
  assert.deepEqual(parsed, {
    schemaVersion: "workloom.growthtest-studio-cli/v1", command: "start",
    deliveryComplete: false, result: studioReceipt, requestSha256: parsed.requestSha256, reused: false,
  });
});

test("studio start never retries an unknown or incompatible response", async () => {
  for (const studio of [undefined, { kind: "routed", pipeline: "narrative", projectId: "VID-T", runId: null }]) {
    const f = fixtures({ studio });
    const input = Readable.from([Buffer.from(JSON.stringify(studioIntent))]);
    await assert.rejects(runSourceSession(studioStart(), { ...f, env: config, input }),
      { code: "STUDIO_START_OUTCOME_UNKNOWN" });
    assert.equal(f.calls.length, 4);
    assert.equal(f.spawnCalls.length, 0);
  }
});

test("studio work root blocks duplicate POST after a lost response and rejects a changed request", async () => {
  const args = studioStart();
  const request = () => Readable.from([Buffer.from(JSON.stringify(studioIntent))]);
  const original = fixtures();
  const originalFetch = async (...init) => {
    const response = await original.fetcher(...init);
    if (original.calls.length === 4) throw new DOMException("fixture timeout", "TimeoutError");
    return response;
  };
  await assert.rejects(runSourceSession(args, { ...original, env: config, input: request(), fetcher: originalFetch }),
    { code: "STUDIO_START_OUTCOME_UNKNOWN" });
  assert.equal(original.calls.length, 4);
  const retry = fixtures({ studio: studioReceipt });
  await assert.rejects(runSourceSession(args, { ...retry, env: config, input: request() }), { code: "STUDIO_START_OUTCOME_UNKNOWN" });
  assert.equal(retry.calls.length, 3);
  const changed = fixtures({ studio: studioReceipt });
  const changedInput = Readable.from([Buffer.from(JSON.stringify({ ...studioIntent, durationSec: 19 }))]);
  await assert.rejects(runSourceSession(args, { ...changed, env: config, input: changedInput }), { code: "STUDIO_WORK_ROOT_CONFLICT" });
  assert.equal(changed.calls.length, 3);
});

test("studio work root admits at most one concurrent native start and records evidence before dispatch", async () => {
  const workRoot = studioWorkRoot(), args = studioStart(workRoot);
  const request = () => Readable.from([Buffer.from(JSON.stringify(studioIntent))]);
  const reservation = join(workRoot, "studio-start.request.json");
  const original = fixtures({ studio: studioReceipt });
  const pending = Promise.withResolvers();
  const reached = Promise.withResolvers();
  const fetcher = async (...init) => {
    const response = await original.fetcher(...init);
    if (original.calls.length === 4) {
      const marker = readFileSync(reservation, "utf8");
      assert.equal(JSON.parse(marker).workspaceId, identity.workspaceId);
      assert.ok(!marker.includes(fixtureKey) && !marker.includes(fixtureToken));
      if (process.platform !== "win32") assert.equal(statSync(reservation).mode & 0o777, 0o600);
      reached.resolve();
      await pending.promise;
    }
    return response;
  };
  const first = runSourceSession(args, { ...original, env: config, input: request(), fetcher, output: () => {} });
  try {
    await Promise.race([reached.promise, first]);
    const second = fixtures({ studio: studioReceipt });
    await assert.rejects(runSourceSession(args, { ...second, env: config, input: request() }), { code: "STUDIO_START_OUTCOME_UNKNOWN" });
    assert.equal(second.calls.length, 3);
  } finally {
    pending.resolve();
    assert.equal(await first, 0);
  }
});

test("studio work root fails closed when a saved receipt is changed or orphaned", async () => {
  const workRoot = studioWorkRoot(), args = studioStart(workRoot);
  const request = () => Readable.from([Buffer.from(JSON.stringify(studioIntent))]);
  const f = fixtures({ studio: studioReceipt });
  await runSourceSession(args, { ...f, env: config, input: request(), output: () => {} });
  const receipt = join(workRoot, "studio-start.receipt.json"), recorded = JSON.parse(readFileSync(receipt, "utf8"));
  writeFileSync(receipt, JSON.stringify({ ...recorded, result: { ...recorded.result, projectId: "VID-changed" } }));
  const changed = fixtures({ studio: studioReceipt });
  await assert.rejects(runSourceSession(args, { ...changed, env: config, input: request() }), { code: "STUDIO_START_OUTCOME_UNKNOWN" });
  assert.equal(changed.calls.length, 3);
  rmSync(join(workRoot, "studio-start.request.json"));
  const orphaned = fixtures({ studio: studioReceipt });
  await assert.rejects(runSourceSession(args, { ...orphaned, env: config, input: request() }), { code: "STUDIO_START_OUTCOME_UNKNOWN" });
  assert.equal(orphaned.calls.length, 3);
});

test("studio work root returns its saved verified start receipt without a second POST", async () => {
  const args = studioStart();
  const request = () => Readable.from([Buffer.from(JSON.stringify(studioIntent))]);
  const original = fixtures({ studio: studioReceipt });
  const first = [];
  await runSourceSession(args, { ...original, env: config, input: request(), output: line => first.push(JSON.parse(line)) });
  assert.equal(original.calls.length, 4);
  const retry = fixtures();
  const replayed = [];
  await runSourceSession(args, { ...retry, env: config, input: request(), output: line => replayed.push(JSON.parse(line)) });
  assert.equal(retry.calls.length, 3);
  assert.equal(replayed[0].reused, true);
  assert.deepEqual(replayed[0].result, first[0].result);
  assert.equal(replayed[0].requestSha256, first[0].requestSha256);
});

test("studio guard rejects arbitrary input and returns genuine clarify and explainer receipts", async () => {
  for (const bad of [{ ...studioIntent, durationSec: 0 }, { ...studioIntent, projectId: "VID-other" },
    { ...studioIntent, shots: [{ shotId: "handwritten" }] }, { ...studioIntent, metadata: [] }]) {
    const f = fixtures();
    const input = Readable.from([Buffer.from(JSON.stringify(bad))]);
    await assert.rejects(runSourceSession(studioStart(), { ...f, env: config, input }), { code: "STUDIO_INPUT_INVALID" });
    assert.equal(f.calls.length, 0);
  }
  for (const studio of [
    { kind: "clarify", question: "缺少具体商品名称", missing: ["product"] },
    { kind: "routed", projectId: "VID-X", runId: null, pipeline: "explainer", shotbookId: "BOOK-X" },
  ]) {
    const f = fixtures({ studio });
    const input = Readable.from([Buffer.from(JSON.stringify(studioIntent))]);
    const lines = [];
    assert.equal(await runSourceSession(studioStart(), { ...f, env: config, input, output: line => lines.push(line) }), 0);
    assert.equal(JSON.parse(lines[0]).deliveryComplete, false);
    assert.deepEqual(JSON.parse(lines[0]).result, studio);
  }
});

test("studio status, archive and shots only use their fixed read routes and requested identity", async () => {
  for (const [command, id, path, key, studio] of [
    ["status", "RUN-T", "/trpc/video.studio.status", "runId", { runId: "RUN-T", projectId: "VID-T", status: "finished" }],
    ["archive", "VID-T", "/trpc/video.studio.archive", "projectId", { projectId: "VID-T", archiveExists: true, stages: [] }],
    ["shots", "VID-T", "/trpc/video.production.shots", "projectId", shotsReceipt],
  ]) {
    const f = fixtures({ studio }), lines = [];
    assert.equal(await runSourceSession(["studio", "--", command, id], { ...f, env: config, output: line => lines.push(line) }), 0);
    const url = new URL(f.calls[3].url);
    assert.equal(url.pathname, path);
    assert.equal(f.calls[3].init.method, "GET");
    assert.deepEqual(JSON.parse(url.searchParams.get("input")), { [key]: id });
    assert.deepEqual(JSON.parse(lines[0]).result, studio);
    assert.equal(JSON.parse(lines[0]).deliveryComplete, false);
  }
  for (const studio of [{ ...shotsReceipt, projectId: "VID-other" }, { ...shotsReceipt, promptsSha256: "partial" },
    { ...shotsReceipt, sourceStageRunId: null }, { ...shotsReceipt, shots: [] }]) {
    const f = fixtures({ studio });
    await assert.rejects(runSourceSession(["studio", "--", "shots", "VID-T"], { ...f, env: config }),
      { code: "STUDIO_READBACK_INVALID" });
    assert.equal(f.calls.length, 4);
  }
});

test("studio CLI sends only the current brief to the actual local service URL", async t => {
  const rootDir = mkdtempSync(join(tmpdir(), "growthtest studio 中文 "));
  t.after(() => rmSync(rootDir, { recursive: true, force: true }));
  const brief = join(rootDir, "用户原话.json");
  writeFileSync(brief, JSON.stringify(studioIntent));
  const seen = [];
  const server = createServer(async (req, res) => {
    seen.push([req.method, req.url, req.headers["x-workloom-desktop-key"], req.headers.authorization]);
    const route = seen.length;
    let result;
    if (route === 1) result = health;
    if (route === 2) result = trpc({ token: fixtureToken, identity });
    if (route === 3) result = trpc(access);
    if (route === 4) {
      const body = [];
      for await (const chunk of req) body.push(chunk);
      seen.at(-1).push(JSON.parse(Buffer.concat(body).toString("utf8")));
      result = trpc(studioReceipt);
    }
    res.writeHead(result ? 200 : 403, { "content-type": "application/json" });
    res.end(JSON.stringify(result ?? {}));
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  const env = { ...process.env, ...config, WORKLOOM_BASE_URL: `http://127.0.0.1:${server.address().port}` };
  const { stdout, stderr } = await run(process.execPath,
    [join(root, "scripts/workloom-source-session.mjs"), ...studioStart(join(rootDir, "作业"), brief)],
    { cwd: rootDir, env, timeout: 10_000 });
  assert.deepEqual(JSON.parse(stdout).result, studioReceipt);
  assert.ok(!stdout.includes(fixtureKey) && !stdout.includes(fixtureToken) && !stderr);
  assert.deepEqual(seen, [
    ["GET", "/health", undefined, undefined],
    ["POST", "/trpc/auth.desktopLogin", fixtureKey, undefined],
    ["GET", "/trpc/access.me", undefined, "Bearer " + fixtureToken],
    ["POST", "/trpc/video.studio.start", undefined, "Bearer " + fixtureToken, { ...studioIntent, route: "auto" }],
  ]);
});

test("invalid origins, config and alternate executable fail before network or child", async () => {
  const f = fixtures();
  const options = { fetcher: f.fetcher, spawnImpl: f.spawnImpl };
  for (const value of [
    undefined, "https://127.0.0.1:9123", "http://localhost:9123", "http://127.1:9123",
    "http://2130706433:9123", "http://127.0.0.1:9123/", "http://127.0.0.1:9123/path",
    "http://127.0.0.1:9123?x=1", "http://user@127.0.0.1:9123", "http://example.invalid:9123",
  ]) {
    await assert.rejects(runSourceSession(readonlyArgs, { ...options, env: { ...config, WORKLOOM_BASE_URL: value } }), { code: "ORIGIN_INVALID" });
  }
  await assert.rejects(runSourceSession(readonlyArgs, { ...options, env: { ...config, WORKLOOM_DESKTOP_INSTANCE_ID: "" } }), { code: "CONFIG_INVALID" });
  await assert.rejects(runSourceSession(readonlyArgs, { ...options, env: { ...config, WORKLOOM_DESKTOP_LOGIN_KEY: "not a key" } }), { code: "BOOTSTRAP_KEY_INVALID" });
  await assert.rejects(runSourceSession(["node", "--", "-e", "process.exit()"], { ...options, env: config }), { code: "USAGE" });
  for (const option of ["--root", "--base-url", "--bundle"]) {
    await assert.rejects(runSourceSession([...readonlyArgs, option, "elsewhere"], { ...options, env: config }), { code: "AGENT_OVERRIDE_FORBIDDEN" });
  }
  assert.equal(f.calls.length, 0);
  assert.equal(f.spawnCalls.length, 0);
});

test("wrong product or instance never receives the bootstrap key", async () => {
  for (const healthBody of [{ ...health, desktopInstanceId: "another" }, { ...health, productId: "other-product" }]) {
    const f = fixtures({ healthBody });
    await assert.rejects(runSourceSession(readonlyArgs, { ...f, env: config }), { code: "RUNTIME_IDENTITY_MISMATCH" });
    assert.deepEqual(f.calls.map(call => [new URL(call.url).pathname, call.init.headers]), [["/health", undefined]]);
    assert.equal(f.spawnCalls.length, 0);
  }
});

test("refuses denied login, scope mismatch, invalid JWT and changed access without starting the CLI", async () => {
  for (const [scenario, expected, requests] of [
    [{ login: { error: { message: fixtureKey } }, status: 401 }, "SOURCE_HTTP_ERROR", 2],
    [{ login: trpc({ token: fixtureToken, identity: { ...identity, tenantId: "other" } }) }, "LOGIN_SCOPE_MISMATCH", 2],
    [{ login: trpc({ token: fixtureToken, identity: { ...identity, memberNo: "GUEST" } }) }, "LOGIN_SCOPE_MISMATCH", 2],
    [{ login: trpc({ token: fixtureToken.split(".")[0], identity }) }, "MEMBER_TOKEN_INVALID", 2],
    [{ accessBody: trpc({ ...access, scope: { ...access.scope, workspaceId: "other" } }) }, "ACCESS_SCOPE_MISMATCH", 3],
    [{ accessBody: trpc({ ...access, subject: { ...access.subject, id: "other" } }) }, "ACCESS_SCOPE_MISMATCH", 3],
  ]) {
    const f = fixtures(scenario);
    await assert.rejects(runSourceSession(readonlyArgs, { ...f, env: config }), error =>
      error.code === expected && !error.message.includes(fixtureKey) && !error.message.includes(fixtureToken));
    assert.equal(f.calls.length, requests);
    assert.equal(f.spawnCalls.length, 0);
  }
});

test("uses only a fixed checkout CLI and gives the child only the required session token", async () => {
  const f = fixtures();
  const args = ["director", "--", "job", "--input-file", "job.json"];
  const env = { ...config, HOME: "/isolated", WORKLOOM_ACCESS_TOKEN: "stale", WORKLOOM_TOKEN: "stale",
    JWT_SECRET: "unrelated", DEEPSEEK_API_KEY: "unrelated", NODE_OPTIONS: "unrelated" };
  assert.equal(await runSourceSession(args, { ...f, env }), 9);
  assert.deepEqual(f.calls.map(call => new URL(call.url).pathname), ["/health", "/trpc/auth.desktopLogin", "/trpc/access.me"]);
  assert.equal(f.calls[1].init.headers["x-workloom-desktop-key"], fixtureKey);
  assert.equal(f.calls[2].init.headers.authorization, "Bearer " + fixtureToken);
  assert.ok(f.calls.every(call => call.init.redirect === "error"));
  assert.deepEqual(f.spawnCalls, [[process.execPath, [join(root, "scripts/workloom-director.mjs"), ...args.slice(2)], {
    cwd: root, stdio: "inherit",
    env: { HOME: "/isolated", WORKLOOM_BASE_URL: config.WORKLOOM_BASE_URL, WORKLOOM_API: config.WORKLOOM_BASE_URL, WORKLOOM_DEV_AUTO_LOGIN: "0", WORKLOOM_ACCESS_TOKEN: fixtureToken },
  }]]);
});

test("real loopback runs the actual guide CLI and the read-only render catalog", async t => {
  const seen = [];
  const server = createServer((req, res) => {
    const path = new URL(req.url, "http://127.0.0.1").pathname;
    seen.push(path);
    let body;
    if (req.method === "GET" && req.url === "/health" && !req.headers["x-workloom-desktop-key"]) body = health;
    if (req.method === "POST" && req.url === "/trpc/auth.desktopLogin" && req.headers["x-workloom-desktop-key"] === fixtureKey) {
      body = trpc({ token: fixtureToken, identity });
    }
    if (req.method === "GET" && req.url === "/trpc/access.me" && req.headers.authorization === "Bearer " + fixtureToken
      && !req.headers["x-workloom-desktop-key"]) body = trpc(access);
    if (req.method === "GET" && path === "/trpc/video.gen.catalog" && req.headers.authorization === "Bearer " + fixtureToken
      && !req.headers["x-workloom-desktop-key"]) body = trpc({ models: [{ id: "fixture-model" }] });
    res.writeHead(body ? 200 : 403, { "content-type": "application/json" });
    res.end(JSON.stringify(body ?? {}));
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  const env = { ...process.env, ...config, WORKLOOM_BASE_URL: `http://127.0.0.1:${server.address().port}` };
  const { stdout, stderr } = await run(process.execPath,
    [join(root, "scripts/workloom-source-session.mjs"), "agent", "--", "invoke", "growth.video.workbench.guide"],
    { cwd: root, env, timeout: 10_000 });
  assert.equal(JSON.parse(stdout).result.repository, product.repository);
  assert.ok(!stdout.includes(fixtureKey) && !stdout.includes(fixtureToken) && !stderr);
  const catalog = await run(process.execPath,
    [join(root, "scripts/workloom-source-session.mjs"), "render", "--", "--list-models"],
    { cwd: root, env, timeout: 10_000 });
  assert.deepEqual(JSON.parse(catalog.stdout), { models: [{ id: "fixture-model" }] });
  for (const stream of [catalog.stdout, catalog.stderr]) {
    assert.ok(!stream.includes(fixtureKey) && !stream.includes(fixtureToken));
  }
  const handshake = ["/health", "/trpc/auth.desktopLogin", "/trpc/access.me"];
  assert.deepEqual(seen, [...handshake, ...handshake, "/trpc/video.gen.catalog"]);
});

test("a loopback redirect cannot forward the bootstrap credential or start a child", async t => {
  const seen = [];
  const server = createServer((req, res) => {
    seen.push(req.url);
    if (req.url === "/health") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(health));
    } else {
      res.writeHead(307, { location: "/not-an-auth-route" });
      res.end();
    }
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  const f = fixtures();
  await assert.rejects(runSourceSession(readonlyArgs, { env: { ...config, WORKLOOM_BASE_URL: `http://127.0.0.1:${server.address().port}` },
    spawnImpl: f.spawnImpl }), { code: "SOURCE_UNAVAILABLE" });
  assert.equal(f.spawnCalls.length, 0);
  assert.deepEqual(seen, ["/health", "/trpc/auth.desktopLogin"]);
});
