import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFile, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { runVideoCli, startVideo, statusVideo, validateVideoIntent } from "./workloom-video.mjs";

const checkout = { repository: "geniusdapeng-collab/workloom-growthtest", commit: "1".repeat(40), productId: "workloom-ai-growth" };
const expected = {
  origin: "http://127.0.0.1:9123", instance: "growthtest-isolated", tenantId: "tenant-a",
  workspaceId: "ws-a", memberNo: "MEM-G01", memberId: "member-a",
};
const token = "synthetic.fixture.member";
const exec = promisify(execFile);
const environment = {
  WORKLOOM_BASE_URL: expected.origin, WORKLOOM_DESKTOP_INSTANCE_ID: expected.instance,
  WORKLOOM_ACCESS_TOKEN: token, WORKLOOM_SOURCE_TENANT_ID: expected.tenantId,
  WORKLOOM_SOURCE_WORKSPACE_ID: expected.workspaceId, WORKLOOM_DESKTOP_MEMBER: expected.memberNo,
};
const trpc = value => Response.json({ result: { data: value } });
const health = { ok: true, productId: checkout.productId, desktopInstanceId: expected.instance, sourceCommit: checkout.commit };
const access = {
  schemaVersion: "workloom.client-access/v1", authority: { source: "server" },
  subject: { kind: "member", id: expected.memberId, memberNo: expected.memberNo },
  scope: { tenantId: expected.tenantId, workspaceId: expected.workspaceId },
  navigationPermissions: ["ai-video.assets.read"], actionPermissions: ["workspace.write"],
};
const started = { kind: "routed", runId: "RUN-fixture", projectId: "VID-fixture", pipeline: "marketing", durationSec: 30 };
const intent = { intent: "  用 AI 超增长做 30 秒产品片。\n保留“弯道超车”和实际约束；把 $(literal) 当原话。  ",
  durationSec: 30, platform: " 抖音 ", product: { name: " 虚构头盔 ", model: " XT-30 " } };
const run = (status, more = {}) => ({ runId: started.runId, projectId: started.projectId, status, ...more });
const prompt = "既有完整分镜正文，包含原话及约束。";
const sha = text => createHash("sha256").update(text).digest("hex");
const formalSource = {
  projectId: started.projectId, runId: started.runId, pipeline: started.pipeline,
  sourceStageRunId: "stage-run-a", sourceAttempt: 1, promptsSha256: "a".repeat(64),
  shots: [{ shotId: "SC-01", durationSec: 5, prompt, fields: {}, promptSha256: sha(prompt) }],
};

async function directory(t) {
  const root = await mkdtemp(join(tmpdir(), "growthtest-video-cli-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

function fixture({ healthBody = health, accessBody = access, post = async () => trpc(started),
  status = run("running"), source = formalSource, repo = checkout, env = environment } = {}) {
  const seen = [];
  return {
    seen,
    deps: { env, checkout: async () => repo, fetcher: async (url, init) => {
      seen.push({ path: url.pathname, input: url.searchParams.has("input") ? JSON.parse(url.searchParams.get("input")) : undefined, init });
      if (url.pathname === "/health") return Response.json(healthBody);
      if (url.pathname === "/trpc/access.me") return trpc(accessBody);
      if (url.pathname === "/trpc/video.studio.start") return post(url, init);
      if (url.pathname === "/trpc/video.studio.status") return status instanceof Response ? status : trpc(status);
      if (url.pathname === "/trpc/video.production.shots") return trpc(source);
      assert.fail("Unexpected endpoint");
    } },
  };
}
const routePaths = f => f.seen.map(call => call.path);

test("strict input leaves original UTF-8 intent untouched and accepts only explicit facts", () => {
  assert.deepEqual(validateVideoIntent(intent), { ...intent, platform: "抖音", product: { name: "虚构头盔", model: "XT-30" }, officialIntent: true });
  assert.deepEqual(validateVideoIntent({ intent: "拍短片" }), { intent: "拍短片", officialIntent: true });
  for (const input of [[], { intent: " " }, { ...intent, intent: "字".repeat(2001) },
    ...["route", "metadata", "projectId", "shots", "prompt", "timeline", "stage", "officialIntent"].map(key => ({ ...intent, [key]: [] })),
    { ...intent, durationSec: 301 }, { ...intent, durationSec: 1.5 }, { ...intent, platform: "字".repeat(41) },
    { ...intent, product: { name: "../../secret" } }, { ...intent, product: { name: "头盔", source: "/private" } },
  ]) assert.throws(() => validateVideoIntent(input), { code: "INVALID_INPUT" });
});

test("writes owner-only scope and hash before the single official POST; retains IDs without intent or bearer", async t => {
  const jobFile = join(await directory(t), "job.json");
  const f = fixture({ post: async (_url, init) => {
    const marker = JSON.parse(await readFile(jobFile, "utf8"));
    assert.equal(marker.phase, "start_unknown");
    assert.equal(marker.durationSec, 30);
    assert.equal(marker.requestSha256, sha(init.body));
    assert.deepEqual(JSON.parse(init.body), validateVideoIntent(intent));
    if (process.platform !== "win32") assert.equal((await stat(jobFile)).mode & 0o777, 0o600);
    return trpc(started);
  } });
  const result = await startVideo(intent, jobFile, f.deps);
  assert.equal(result.phase, "preproduction_submitted");
  assert.equal(result.mediaReady, false);
  assert.equal(result.runId, started.runId);
  assert.equal(result.durationSec, 30);
  const saved = await readFile(jobFile, "utf8");
  const record = JSON.parse(saved);
  assert.deepEqual(record.binding, { ...checkout, ...expected });
  assert.equal(record.durationSec, 30);
  assert(!saved.includes(intent.intent.trim()) && !saved.includes(token));
  assert.deepEqual(routePaths(f), ["/health", "/trpc/access.me", "/trpc/video.studio.start"]);
  assert.equal(f.seen[0].init.headers, undefined);
  assert.ok(f.seen.every(call => call.init.redirect === "error"));
  assert.equal(f.seen[2].init.headers.authorization, "Bearer " + token);
  assert.equal(f.seen[2].init.method, "POST");
});

test("scope/instance, read/write permission and disallowed origins close before mutation", async t => {
  const root = await directory(t);
  const invalidFixtures = [
    [fixture({ healthBody: { ...health, desktopInstanceId: "other" } }), "RUNTIME_IDENTITY_MISMATCH", 1],
    [fixture({ healthBody: { ...health, sourceCommit: "9".repeat(40) } }), "RUNTIME_SOURCE_MISMATCH", 1],
    [fixture({ healthBody: { ...health, sourceCommit: undefined } }), "RUNTIME_SOURCE_MISMATCH", 1],
    [fixture({ accessBody: { ...access, scope: { ...access.scope, workspaceId: "other" } } }), "ACCESS_SCOPE_MISMATCH", 2],
    [fixture({ accessBody: { ...access, navigationPermissions: [] } }), "ACCESS_SCOPE_MISMATCH", 2],
    [fixture({ accessBody: { ...access, actionPermissions: [] } }), "WRITE_PERMISSION_REQUIRED", 2],
    [fixture({ env: { ...environment, WORKLOOM_BASE_URL: "https://user@api.invalid" } }), "ORIGIN_INVALID", 0],
    [fixture({ env: { ...environment, WORKLOOM_BASE_URL: "http://remote.invalid" } }), "ORIGIN_INVALID", 0],
    [fixture({ env: { ...environment, WORKLOOM_ACCESS_TOKEN: "" } }), "MEMBER_SESSION_REQUIRED", 0],
  ];
  for (const [index, [f, code, requestCount]] of invalidFixtures.entries()) {
    await assert.rejects(startVideo(intent, join(root, index + ".json"), f.deps), { code });
    assert.equal(f.seen.length, requestCount);
    assert.ok(!routePaths(f).includes("/trpc/video.studio.start"));
  }
});

test("ambiguous response, concurrency and repeated start keep one submission and preserve original marker", async t => {
  const jobFile = join(await directory(t), "job.json");
  const f = fixture({ post: async () => { throw new Error("fixture lost response " + token); } });
  const concurrent = await Promise.allSettled([startVideo(intent, jobFile, f.deps), startVideo(intent, jobFile, f.deps)]);
  assert.equal(concurrent.filter(result => result.status === "fulfilled").length, 1);
  assert.equal(concurrent.find(result => result.status === "fulfilled").value.phase, "start_unknown");
  assert.equal(concurrent.find(result => result.status === "rejected").reason.code, "JOB_ALREADY_EXISTS");
  assert.equal(routePaths(f).filter(path => path === "/trpc/video.studio.start").length, 1);
  const retained = await readFile(jobFile, "utf8");
  await assert.rejects(startVideo(intent, jobFile, f.deps), { code: "JOB_ALREADY_EXISTS" });
  assert.equal((await statusVideo(jobFile, f.deps)).phase, "start_unknown");
  assert.equal(await readFile(jobFile, "utf8"), retained);
  assert.equal(routePaths(f).filter(path => path === "/trpc/video.studio.start").length, 1);
  assert.ok(!retained.includes(token));
  assert.ok(!routePaths(f).includes("/trpc/video.studio.status"));
});

test("service clarification and explainer handoff persist without inventing projects", async t => {
  const root = await directory(t);
  for (const scenario of [
    { result: { kind: "clarify", question: "请确认商品名", missing: ["product"] }, phase: "clarify", detail: "question" },
    { result: { kind: "unsupported", pipeline: "explainer" }, phase: "unsupported", detail: "handoff" },
  ]) {
    const jobFile = join(root, scenario.phase + ".json");
    const f = fixture({ post: async () => trpc(scenario.result) });
    const result = await startVideo(intent, jobFile, f.deps);
    assert.equal(result.phase, scenario.phase);
    assert.ok(result[scenario.detail]);
    assert.ok(!Object.hasOwn(result, "projectId"));
    assert.deepEqual(await statusVideo(jobFile, f.deps), result);
  }
});

test("captures an effective server duration without rewriting raw intent and rejects a conflicting explicit duration", async t => {
  const root = await directory(t);
  const implicitIntent = " 做一条三十秒的视频，保留原话和格式。 ";
  const f = fixture({ post: async (_url, init) => {
    assert.deepEqual(JSON.parse(init.body), { intent: implicitIntent, officialIntent: true });
    return trpc(started);
  } });
  const agreed = await startVideo({ intent: implicitIntent }, join(root, "effective.json"), f.deps);
  assert.equal(agreed.durationSec, 30);
  const mismatch = fixture({ post: async () => trpc({ ...started, durationSec: 20 }) });
  const refused = await startVideo(intent, join(root, "mismatch.json"), mismatch.deps);
  assert.equal(refused.phase, "start_unknown");
  assert.equal(refused.durationSec, 30);
  assert.equal(refused.runId, started.runId);
  assert.equal((await statusVideo(join(root, "mismatch.json"), mismatch.deps)).phase, "start_unknown");
});

test("status checks same scope and run, never reads shots before verified terminal success", async t => {
  const jobFile = join(await directory(t), "job.json");
  await startVideo(intent, jobFile, fixture().deps);
  for (const [status, phase] of [
    [run("running"), "preproduction_running"], [run("awaiting_approval", { currentGate: "G6_PROMPT", pendingApprovalId: "APR-1" }), "awaiting_approval"],
    [run("failed", { error: "failure" }), "preproduction_failed"], [run("finished"), "status_unavailable"],
    [run("running", { projectId: "another" }), "status_unavailable"],
  ]) {
    const f = fixture({ status });
    const result = await statusVideo(jobFile, f.deps);
    assert.equal(result.phase, phase);
    assert.equal(result.mediaReady, false);
    assert.deepEqual(routePaths(f), ["/health", "/trpc/access.me", "/trpc/video.studio.status"]);
    assert.deepEqual(f.seen[2].input, { runId: started.runId });
  }
  const otherCommit = fixture({ repo: { ...checkout, commit: "2".repeat(40) }, healthBody: { ...health, sourceCommit: "2".repeat(40) } });
  await assert.rejects(statusVideo(jobFile, otherCommit.deps), { code: "JOB_SCOPE_MISMATCH" });
  assert.deepEqual(routePaths(otherCommit), ["/health", "/trpc/access.me"]);
});

test("a missing in-memory run after restart recovers only the exact authoritative archive", async t => {
  const jobFile = join(await directory(t), "job.json");
  await startVideo(intent, jobFile, fixture().deps);
  for (const status of [
    null,
    Response.json({ error: { message: "Run no longer in process memory", data: { code: "NOT_FOUND" } } }, { status: 404 }),
  ]) {
    const f = fixture({ status });
    const result = await statusVideo(jobFile, f.deps);
    assert.equal(result.phase, "preproduction_ready");
    assert.equal(result.source.stageRunId, formalSource.sourceStageRunId);
    assert.deepEqual(routePaths(f), ["/health", "/trpc/access.me", "/trpc/video.studio.status", "/trpc/video.production.shots"]);
  }
  const stale = fixture({ status: null, source: { ...formalSource, runId: "older-run" } });
  assert.equal((await statusVideo(jobFile, stale.deps)).phase, "status_unavailable");
  const denied = fixture({ status: Response.json({ error: { data: { code: "FORBIDDEN" } } }, { status: 403 }) });
  await assert.rejects(statusVideo(jobFile, denied.deps), { code: "FORBIDDEN" });
  assert.ok(!routePaths(denied).includes("/trpc/video.production.shots"));
});

test("same run, pipeline and matching per-shot prompt digest required for preproduction_ready", async t => {
  const jobFile = join(await directory(t), "job.json");
  await startVideo(intent, jobFile, fixture().deps);
  for (const [source, phase] of [
    [formalSource, "preproduction_ready"],
    [{ ...formalSource, runId: "different" }, "status_unavailable"],
    [{ ...formalSource, pipeline: "narrative" }, "status_unavailable"],
    [{ ...formalSource, sourceAttempt: 0 }, "status_unavailable"],
    [{ ...formalSource, shots: [] }, "status_unavailable"],
    [{ ...formalSource, shots: [formalSource.shots[0], formalSource.shots[0]] }, "status_unavailable"],
    [{ ...formalSource, shots: [{ ...formalSource.shots[0], promptSha256: "0".repeat(64) }] }, "status_unavailable"],
  ]) {
    const f = fixture({ status: run("finished", { resultSummary: { success: true } }), source });
    const result = await statusVideo(jobFile, f.deps);
    assert.equal(result.phase, phase);
    assert.equal(result.mediaReady, false);
    assert.ok(!JSON.stringify(result).includes(prompt));
    assert.deepEqual(f.seen[3].input, { projectId: started.projectId });
  }
});

test("CLI rejects unknown arguments, invalid file encoding and symlinked or shared job records", async t => {
  const root = await directory(t);
  const job = join(root, "job.json");
  const path = join(root, "input.json");
  const f = fixture();
  await writeFile(path, Buffer.from([0xff, 0xfe]));
  await assert.rejects(runVideoCli(["start", "--input-file", path, "--job-file", job], f.deps), { code: "INVALID_INPUT" });
  await assert.rejects(runVideoCli(["start", "--input-file", path, "--job-file", job, "--job-file", "another"], f.deps), { code: "USAGE" });
  await assert.rejects(runVideoCli(["status", "--input-file", path, "--job-file", job], f.deps), { code: "USAGE" });
  await writeFile(path, "{}", { mode: 0o644 });
  await symlink(path, job);
  await assert.rejects(statusVideo(job, f.deps), { code: "JOB_FILE_INVALID" });
  assert.deepEqual(routePaths(f), []);
});

test("actual CLI and source-session process start and recover the same job through a loopback service", async t => {
  const root = await directory(t);
  const repo = join(root, "repo");
  await mkdir(join(repo, "scripts"), { recursive: true });
  for (const file of ["workloom-video.mjs", "workloom-source-session.mjs", "agent-capabilities.mjs"]) {
    await copyFile(new URL(file, import.meta.url), join(repo, "scripts", file));
  }
  await writeFile(join(repo, "product.manifest.json"), JSON.stringify(checkout));
  const git = (...args) => exec("git", ["-C", repo, ...args]);
  await git("init", "-q");
  await git("remote", "add", "origin", "https://github.com/geniusdapeng-collab/workloom-growthtest.git");
  await git("add", "scripts", "product.manifest.json");
  await git("-c", "user.email=fixture@example.invalid", "-c", "user.name=Fixture", "-c", "commit.gpgsign=false",
    "-c", "core.hooksPath=/dev/null", "commit", "-qm", "fixture");
  const commit = (await git("rev-parse", "HEAD")).stdout.trim();
  const seen = [];
  const bootstrapKey = "c".repeat(64);
  let rejectedBody = false;
  const server = createServer(async (req, res) => {
    const url = new URL(req.url, "http://127.0.0.1");
    seen.push([req.method, url.pathname]);
    let data;
    if (url.pathname === "/health" && !req.headers.authorization) data = { ...health, sourceCommit: commit };
    if (url.pathname === "/trpc/auth.desktopLogin" && req.headers["x-workloom-desktop-key"] === bootstrapKey) {
      data = { token, identity: { tenantId: expected.tenantId, workspaceId: expected.workspaceId, memberId: expected.memberId, memberNo: expected.memberNo } };
    }
    if (req.headers.authorization === "Bearer " + token && !req.headers["x-workloom-desktop-key"]) {
      if (url.pathname === "/trpc/access.me") data = access;
      if (url.pathname === "/trpc/video.studio.start" && req.method === "POST") {
        const chunks = [];
        for await (const chunk of req) chunks.push(chunk);
        const received = JSON.parse(Buffer.concat(chunks));
        rejectedBody = JSON.stringify(received) !== JSON.stringify(validateVideoIntent(intent));
        if (!rejectedBody) data = started;
      }
      if (url.pathname === "/trpc/video.studio.status") data = run("finished", { resultSummary: { success: true } });
      if (url.pathname === "/trpc/video.production.shots") data = formalSource;
    }
    res.writeHead(data ? 200 : 403, { "content-type": "application/json" });
    res.end(JSON.stringify(url.pathname === "/health" ? data : { result: { data } }));
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  const job = join(root, "private-job.json");
  const env = { ...process.env, ...environment, WORKLOOM_DESKTOP_LOGIN_KEY: bootstrapKey, WORKLOOM_ACCESS_TOKEN: "discarded",
    WORKLOOM_BASE_URL: "http://127.0.0.1:" + server.address().port };
  const cli = (...args) => exec(process.execPath, [join(repo, "scripts/workloom-source-session.mjs"), "video", "--", ...args],
    { cwd: repo, env, timeout: 60_000 });
  const starting = cli("start", "--input-file", "-", "--job-file", job);
  starting.child.stdin.end(JSON.stringify(intent));
  const launch = await starting;
  assert.equal(JSON.parse(launch.stdout).phase, "preproduction_submitted");
  assert.equal(JSON.parse(launch.stdout).commit, commit);
  assert.equal(rejectedBody, false);
  const verify = await cli("status", "--job-file", job);
  const output = JSON.parse(verify.stdout);
  assert.equal(output.phase, "preproduction_ready");
  assert.equal(output.mediaReady, false);
  assert.equal(output.runId, started.runId);
  assert.equal(output.durationSec, 30);
  assert.equal(output.source.promptsSha256, formalSource.promptsSha256);
  assert(!launch.stdout.includes(token) && !launch.stdout.includes(bootstrapKey) && !launch.stderr);
  assert(!verify.stdout.includes(token) && !verify.stdout.includes(bootstrapKey) && !verify.stderr);
  assert.equal(seen.filter(([, path]) => path === "/trpc/video.studio.start").length, 1);
  assert.equal(seen.filter(([method, path]) => method === "GET" && path === "/trpc/video.production.shots").length, 1);
});
