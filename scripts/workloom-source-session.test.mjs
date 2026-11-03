import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { EventEmitter } from "node:events";
import { readFileSync, realpathSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";
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

function fixtures({ healthBody = health, login = trpc({ token: fixtureToken, identity }), accessBody = trpc(access), status = 200 } = {}) {
  const calls = [];
  const responses = [Response.json(healthBody), Response.json(login, { status }), Response.json(accessBody)];
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
