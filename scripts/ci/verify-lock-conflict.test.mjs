import assert from "node:assert/strict";
import test from "node:test";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach } from "node:test";
import { changedFiles, collectBoundPulls, compareConflicts, fullPathOf, isSelfPull,
  LockApiClient, pathsFromCompare, repositorySlug, resolveLockContext, runLockGate } from "./verify-lock-conflict.mjs";
import { resolveLockPolicies } from "./protocol-rules.mjs";

const REPO = "workloom-ai/workloom-growthtest";
const SHA = "a".repeat(40);
const SELF = { selfNumber: "106", selfRepo: REPO, selfBranch: "task/current", selfHeadSha: SHA };

test("a different PR IID is not self merely because its source SHA matches", () => {
  assert.equal(isSelfPull({ ...SELF, number: "105", repo: REPO, headSha: SHA }), false);
});

test("a different PR IID is not self merely because its source branch matches", () => {
  assert.equal(isSelfPull({ ...SELF, number: "105", repo: REPO, headRef: "task/current" }), false);
});

test("a twelve-character SHA prefix cannot exclude another PR", () => {
  assert.equal(isSelfPull({ ...SELF, number: "105", repo: REPO, headSha: `${"a".repeat(12)}${"b".repeat(28)}` }), false);
});

test("another open PR that is an ancestor is still compared", () => {
  assert.equal(isSelfPull({ ...SELF, number: "105", repo: REPO, headSha: "b".repeat(40), ancestorOfHead: true }), false);
});

test("matching IID from a different target repository is not self", () => {
  assert.equal(isSelfPull({ ...SELF, number: "106", repo: "other/repo", headSha: SHA }), false);
});


// WORKLOOM_DELIVERY_BOUND_PROTOCOL_V1
import { admitSource, emptyState, leaseOperation } from "../delivery/queue-model.mjs";
const directories = [];
const VALID = "fix(growth): real lock fixture [T-2026-1006-0001]";
const OTHER = "b".repeat(40);
const BASE = "c".repeat(40);
const gitEnv = { PATH: process.env.PATH, GIT_CONFIG_NOSYSTEM: "1",
  GIT_AUTHOR_DATE: "2026-10-06T01:00:00+08:00", GIT_COMMITTER_DATE: "2026-10-06T01:00:00+08:00" };
afterEach(() => { for (const root of directories.splice(0)) rmSync(root, { recursive: true, force: true }); });
function gitFixture() {
  const root = mkdtempSync(join(tmpdir(), "lock-bound-git-")); directories.push(root);
  const git = (...args) => execFileSync("git", ["-c", "core.hooksPath=/dev/null", "-c", "commit.gpgsign=false", ...args],
    { cwd: root, encoding: "utf8", env: gitEnv, stdio: ["ignore", "pipe", "pipe"] }).trim();
  git("init", "--initial-branch=main"); git("config", "user.name", "Actual Git fixture"); git("config", "user.email", "fixture@example.invalid");
  for (const file of ["gone.txt", "old.txt", "type.txt"]) writeFileSync(join(root, file), file + "\n");
  git("add", "."); git("commit", "-m", VALID); const base = git("rev-parse", "HEAD");
  git("switch", "-c", "task/current"); git("rm", "--", "gone.txt"); mkdirSync(join(root, "sync")); git("mv", "--", "old.txt", "sync/renamed.txt");
  unlinkSync(join(root, "type.txt")); symlinkSync("sync/renamed.txt", join(root, "type.txt"));
  for (const file of ["normal.txt", " leading and trailing ", "line\nbreak.txt", "tab\tname.txt", "中文🚀.txt"]) writeFileSync(join(root, file), "new exact path\n");
  git("add", "."); git("commit", "-m", VALID); const source = git("rev-parse", "HEAD");
  git("switch", "main"); writeFileSync(join(root, "target-only.txt"), "target\n"); git("add", "."); git("commit", "-m", VALID); const target = git("rev-parse", "HEAD");
  git("merge", "--no-ff", "-m", "Merged source fixture", source); const merge = git("rev-parse", "HEAD");
  const env = { CNB_EVENT: "pull_request", CNB_PULL_REQUEST_IID: "106", CNB_REPO_SLUG: REPO,
    CNB_PULL_REQUEST_SHA: source, CNB_PULL_REQUEST_TARGET_SHA: target,
    CNB_PULL_REQUEST_MERGE_SHA: merge, CNB_COMMIT: source, CNB_BRANCH_SHA: target,
    CNB_PULL_REQUEST_SLUG: REPO, CNB_PULL_REQUEST_BRANCH: "task/current", CNB_BRANCH: "main", CNB_TOKEN: "fixture-only" };
  return { root, git, base, source, target, merge, env };
}
function pull(number, options = {}) {
  return { number: String(number), state: "open", title: "Bound pull", head: { sha: options.sourceSha ?? OTHER,
    ref: options.sourceBranch ?? "task/other", repo: { path: options.sourceRepo ?? REPO } },
    base: { sha: options.targetSha ?? BASE, ref: "main", repo: { path: REPO } } };
}
function compareFor(row, paths = ["apps/web/common.ts"]) {
  return { base_commit: { sha: row.base.sha }, head_commit: { sha: row.head.sha }, merge_base_commit: { sha: row.base.sha },
    total_commits: 1, files: paths.map((path) => ({ path, status: "modified" })) };
}
class PullFixture {
  constructor(rows = [pull(105), pull(106, { sourceSha: SHA, sourceBranch: "task/current" })]) {
    this.rows = rows; this.calls = []; this.listReads = 0; this.detailReads = new Map(); this.override = null;
    this.compares = new Map(rows.map((row) => [row.number, compareFor(row)])); this.fetch = this.fetch.bind(this);
  }
  async fetch(url, init) {
    const parsed = new URL(url); this.calls.push({ url: parsed.href, init });
    assert.equal(parsed.origin, "https://api.cnb.cool");
    assert.equal(init.redirect, "error"); assert.equal(init.headers.Authorization, "Bearer fixture-only");
    const path = parsed.pathname.split("/-/")[1];
    const overridden = await this.override?.(path, parsed, init);
    if (overridden !== undefined) return overridden;
    if (path === "pulls") {
      this.listReads += 1; const page = Number(parsed.searchParams.get("page")); const size = Number(parsed.searchParams.get("page_size"));
      assert.equal(parsed.searchParams.get("state"), "open");
      return Response.json(this.rows.slice((page - 1) * size, page * size));
    }
    const detail = /^pulls\/(\d+)$/.exec(path);
    if (detail) { this.detailReads.set(detail[1], (this.detailReads.get(detail[1]) ?? 0) + 1); return Response.json(this.rows.find((row) => row.number === detail[1])); }
    const files = /^pulls\/(\d+)\/files$/.exec(path);
    if (files) return Response.json(this.compares.get(files[1]).files.map((file) => ({ filename: file.path.split("/").at(-1),
      status: { added: "add", modified: "modify", deleted: "delete", renamed: "rename", copied: "copy" }[file.status], sha: "d".repeat(40) })));
    if (path.startsWith("git/compare/")) {
      const [base, head] = path.slice("git/compare/".length).split("...");
      return Response.json([...this.compares.values()].find((item) => item.base_commit.sha === base && item.head_commit.sha === head));
    }
    if (path.startsWith("git/commits/")) return Response.json({ sha: path.split("/").at(-1), parents: [] });
    throw new Error("Unexpected fixture request " + path);
  }
  client(options = {}) { return new LockApiClient({ repoSlug: REPO, token: "fixture-only", fetchImpl: this.fetch,
    pageSize: 2, rateLimitDelays: [1, 3, 9], ...options }); }
  context() { return { isPr: true, iid: "106", repoSlug: REPO, sourceSha: SHA, targetSha: BASE,
    sourceRepo: REPO, sourceBranch: "task/current", targetBranch: "main", policies: resolveLockPolicies({ event: "pull_request" }) }; }
}
function rejectCode(promise, code) { return assert.rejects(promise, (error) => { assert.match(error.message, new RegExp(code)); return true; }); }

test("self requires actual target repository and IID, including nested group slugs", () => {
  assert.equal(isSelfPull({ number: "106", repo: REPO, selfNumber: "106", selfRepo: REPO }), true);
  assert.equal(repositorySlug("root/team/repository"), "root/team/repository");
  for (const invalid of ["", "repo", "../repo", "root/../repo", "https://cnb.cool/root/repo", "root/repo?secret=1"]) assert.throws(() => repositorySlug(invalid));
});
test("official IID cannot be confused with the boolean PR event marker", () => {
  const f = gitFixture(); const context = resolveLockContext([], { ...f.env, CNB_PULL_REQUEST: "true" });
  assert.equal(context.iid, "106"); assert.equal(context.sourceSha, f.source); assert.equal(context.sourceRepo, REPO);
  for (const value of [undefined, "true", "0", "-1", "1.5", "01"]) assert.throws(() => resolveLockContext([], { ...f.env, CNB_PULL_REQUEST_IID: value }));
});
test("PR metadata, unsupported events, explicit repo/IID/range overrides fail closed", () => {
  const f = gitFixture();
  for (const patch of [{ CNB_PULL_REQUEST_SHA: "a".repeat(12) }, { CNB_PULL_REQUEST_TARGET_SHA: "0".repeat(40) },
    { CNB_PULL_REQUEST_SLUG: undefined }, { CNB_PULL_REQUEST_BRANCH: undefined }, { CNB_BRANCH: undefined },
    { CNB_EVENT: "pull_request.merged" }, { CNB_API_ENDPOINT: "https://evil.invalid" }]) assert.throws(() => resolveLockContext([], { ...f.env, ...patch }));
  for (const args of [["--repo", "foreign/repo"], ["--pr", "105"], ["--base", f.base], ["--wat"], ["--strict", "--strict"]]) assert.throws(() => resolveLockContext(args, f.env));
});
test("actual Git PR range preserves delete, rename old/new, type changes, Unicode and whitespace", () => {
  const f = gitFixture(); const context = resolveLockContext([], f.env); const result = changedFiles({ context, env: f.env, cwd: f.root });
  assert.equal(result.range, `${f.target}...${f.source}`);
  assert.deepEqual(result.files, ["gone.txt", "old.txt", "sync/renamed.txt", "type.txt", "normal.txt", " leading and trailing ", "line\nbreak.txt", "tab\tname.txt", "中文🚀.txt"].sort());
  assert.ok(!result.files.includes("target-only.txt"));
});
test("actual Git PR context must agree with supplied official IID and source branch", () => {
  const f = gitFixture(); const context = resolveLockContext([], f.env);
  for (const patch of [{ CNB_PULL_REQUEST_IID: "107" }, { CNB_PULL_REQUEST_BRANCH: "task/foreign" }]) {
    assert.throws(() => changedFiles({ context, env: { ...f.env, ...patch }, cwd: f.root }), /IDENTITY_UNVERIFIED/);
  }
});
test("PR Git checker receives supplied context without ambient CNB metadata contamination", () => {
  const f = gitFixture(); const context = resolveLockContext([], f.env); const previous = process.env.CNB_PULL_REQUEST_MERGE_SHA;
  process.env.CNB_PULL_REQUEST_MERGE_SHA = "e".repeat(40);
  try { const { CNB_PULL_REQUEST_MERGE_SHA, ...withoutCanonical } = f.env;
    assert.ok(changedFiles({ context, env: withoutCanonical, cwd: f.root }).files.includes("gone.txt"));
  } finally { if (previous === undefined) delete process.env.CNB_PULL_REQUEST_MERGE_SHA; else process.env.CNB_PULL_REQUEST_MERGE_SHA = previous; }
});
test("actual Git explicit empty range is terminal and unknown base never falls back", () => {
  const f = gitFixture(); const result = changedFiles({ context: { base: f.merge }, cwd: f.root });
  assert.deepEqual(result.files, []); assert.equal(result.range, `${f.merge}...${f.merge}`);
  assert.throws(() => changedFiles({ context: { base: "missing-explicit-ref" }, cwd: f.root }), /GIT_SCOPE_UNVERIFIED/);
});
test("actual Git push range includes deletions and a valid empty diff is preserved", () => {
  const f = gitFixture(); f.git("checkout", "--detach", f.source);
  const context = { event: "push" }; const env = { CNB_BEFORE_SHA: f.base, CNB_COMMIT: f.source, CNB_BRANCH_SHA: f.source };
  assert.ok(changedFiles({ context, env, cwd: f.root }).files.includes("gone.txt"));
  assert.deepEqual(changedFiles({ context, env: { ...env, CNB_BEFORE_SHA: f.source }, cwd: f.root }).files, []);
  assert.throws(() => changedFiles({ context, env: { ...env, CNB_COMMIT: f.target }, cwd: f.root }), /GIT_SCOPE_UNVERIFIED/);
});
test("actual Git shallow history is rejected rather than reading the visible slice", () => {
  const f = gitFixture(); const root = mkdtempSync(join(tmpdir(), "lock-shallow-")); directories.push(root);
  f.git("clone", "--no-local", "--depth=1", `file://${f.root}`, root);
  assert.throws(() => changedFiles({ context: { base: "HEAD" }, cwd: root }), /GIT_SCOPE_UNVERIFIED/);
});
test("actual Git foreign source or unrelated checkout fails before API collection", () => {
  const f = gitFixture(); const context = resolveLockContext([], f.env);
  assert.throws(() => changedFiles({ context: { ...context, sourceSha: "e".repeat(40) }, env: { ...f.env, CNB_PULL_REQUEST_SHA: "e".repeat(40) }, cwd: f.root }), /GIT_SCOPE_UNVERIFIED/);
  f.git("checkout", "--detach", f.target);
  assert.throws(() => changedFiles({ context, env: f.env, cwd: f.root }), /GIT_SCOPE_UNVERIFIED/);
});
test("ordinary overlap is advisory while modules are hard for later PR despite warn override", () => {
  const context = { iid: "106", policies: resolveLockPolicies({ event: "pull_request", envMode: "warn" }) };
  const result = compareConflicts(["apps/web/common.ts", "sync/a.mjs"], [{ number: "105", paths: ["apps/web/common.ts", "sync/b.mjs"] }], context);
  assert.equal(result.find((row) => row.kind === "ordinary").blocking, false);
  assert.equal(result.find((row) => row.kind === "modules").blocking, true);
  assert.equal(compareConflicts(["sync/a"], [{ number: "107", paths: ["sync/b"] }], context)[0].blocking, false);
});
test("push advises modules; strict mode can restore manual ordinary and module blocking", () => {
  const other = [{ number: "105", paths: ["sync/a"] }];
  assert.ok(compareConflicts(["sync/a"], other, { policies: resolveLockPolicies({ event: "push" }) }).every((row) => !row.blocking));
  assert.ok(compareConflicts(["sync/a"], other, { policies: resolveLockPolicies({ event: "push", strict: true }) }).every((row) => row.blocking));
});
test("paginated collection exhausts both scans and compares another IID with identical SHA and branch", async () => {
  const fake = new PullFixture([pull(101), pull(102), pull(105, { sourceSha: SHA, sourceBranch: "task/current" }), pull(106, { sourceSha: SHA, sourceBranch: "task/current" }), pull(107)]);
  const result = await collectBoundPulls(fake.client(), fake.context());
  assert.equal(result.complete, true); assert.equal(result.pages, 6); assert.equal(result.observedPulls, 5);
  assert.deepEqual(result.prs.map((row) => row.number), ["101", "102", "105", "107"]);
  assert.ok(fake.calls.some((call) => call.url.includes("pulls/105/files")));
});
test("an empty list is valid for push and cannot certify a missing current PR", async () => {
  const fake = new PullFixture([]);
  assert.deepEqual((await collectBoundPulls(fake.client(), { isPr: false })).prs, []);
  fake.override = (path) => path === "pulls/106" ? Response.json(pull(106, { sourceSha: SHA, sourceBranch: "task/current" })) : undefined;
  await rejectCode(collectBoundPulls(fake.client(), fake.context()), "STALE_PULL");
});
for (const shape of [{ data: [] }, null, {}, "rows"]) test("malformed list shape is incomplete: " + JSON.stringify(shape), async () => {
  const fake = new PullFixture(); fake.override = (path) => path === "pulls" ? Response.json(shape) : undefined;
  await rejectCode(collectBoundPulls(fake.client(), fake.context()), "API_INCOMPLETE");
});
test("pagination duplicate IID and page ceiling fail without partial success", async () => {
  const duplicate = new PullFixture([pull(105), pull(105)]);
  await rejectCode(collectBoundPulls(duplicate.client(), duplicate.context()), "STALE_PULL");
  const many = new PullFixture([pull(101), pull(102), pull(103)]);
  await rejectCode(collectBoundPulls(many.client({ maxPages: 1 }), { isPr: false }), "PAGINATION_LIMIT");
});
test("collection refuses source movement or closure between detail reads", async () => {
  for (const patch of [{ head: { sha: "e".repeat(40), ref: "task/other", repo: { path: REPO } } }, { state: "closed" }]) {
    const fake = new PullFixture(); let reads = 0;
    fake.override = (path) => path === "pulls/105" && ++reads === 2 ? Response.json({ ...fake.rows[0], ...patch }) : undefined;
    await rejectCode(collectBoundPulls(fake.client(), fake.context()), "STALE_PULL");
  }
});
test("changed open PR set between complete scans is stale", async () => {
  const fake = new PullFixture(); let reads = 0;
  fake.override = (path) => path === "pulls" && ++reads > 2 ? Response.json([]) : undefined;
  await rejectCode(collectBoundPulls(fake.client(), fake.context()), "STALE_PULL");
});
test("own PR source, target and repository metadata must match authoritative context", async () => {
  for (const patch of [{ sourceSha: OTHER }, { targetSha: OTHER }, { sourceRepo: "fork/repository" }, { sourceBranch: "foreign" }]) {
    const fake = new PullFixture([pull(106, { sourceSha: SHA, sourceBranch: "task/current", ...patch })]);
    await rejectCode(collectBoundPulls(fake.client(), fake.context()), "STALE_PULL");
  }
});
test("complete compare paths preserve deletion and both sides of rename, not basenames", async () => {
  const fake = new PullFixture(); const row = fake.rows[0]; const comparison = compareFor(row, []);
  comparison.files = [{ path: "sync/gone.mjs", status: "deleted" }, { path: "ordinary/new.mjs", previous_filename: "sync/old.mjs", status: "renamed" },
    { path: "apps/web/package.json", status: "modified" }, { path: "apps/webb/package.json", status: "modified" }];
  fake.compares.set("105", comparison);
  const result = await collectBoundPulls(fake.client(), fake.context());
  assert.deepEqual(result.prs[0].paths, ["apps/web/package.json", "apps/webb/package.json", "ordinary/new.mjs", "sync/gone.mjs", "sync/old.mjs"]);
});
test("file metadata cannot replace bound compare with filename-only proof", async () => {
  const fake = new PullFixture(); fake.override = (path) => path === "pulls/105/files" ? Response.json([{ filename: "different.ts", status: "modify" }]) : undefined;
  await rejectCode(collectBoundPulls(fake.client(), fake.context()), "PATH_UNVERIFIED");
  assert.throws(() => fullPathOf({ filename: "common.ts" }, { repoSlug: REPO, headSha: OTHER }), /PATH_UNVERIFIED/);
});
test("path plus supplied malicious URL is still rejected, and trusted URL must agree exactly", () => {
  const options = { repoSlug: REPO, headSha: OTHER };
  assert.throws(() => fullPathOf({ path: "safe/file.ts", raw_url: "https://evil.invalid/safe/file.ts" }, options), /PATH_UNVERIFIED/);
  assert.throws(() => fullPathOf({ path: "safe/file.ts", raw_url: `https://cnb.cool/${REPO}/-/git/raw/${OTHER}/other/file.ts` }, options), /PATH_UNVERIFIED/);
  assert.equal(fullPathOf({ path: "safe/中文.ts", raw_url: `https://cnb.cool/${REPO}/-/git/raw/${OTHER}/safe/%E4%B8%AD%E6%96%87.ts` }, options), "safe/中文.ts");
});
for (const suffix of ["wrong-repo/-/git/raw/" + OTHER + "/safe/file", REPO + "/-/git/raw/" + OTHER.slice(0, 12) + "/safe/file", REPO + "/-/git/raw/" + OTHER + "/%2e%2e/escape"]) {
  test("untrusted repository, abbreviated SHA or encoded escape URL fails: " + suffix, () => {
    assert.throws(() => fullPathOf({ raw_url: "https://cnb.cool/" + suffix }, { repoSlug: REPO, headSha: OTHER }), /PATH_UNVERIFIED/);
  });
}
test("compare rejects abbreviated identity, unknown status, missing rename origin, duplicate or truncated files", () => {
  const original = compareFor(pull(105)); const options = { baseSha: BASE, headSha: OTHER };
  for (const patch of [{ head_commit: { sha: OTHER.slice(0, 12) } }, { base_commit: { sha: SHA } }, { files: null }, { truncated: true },
    { files: [{ path: "a", status: "unknown" }] }, { files: [{ path: "a", status: "renamed" }] },
    { files: [{ path: "a", status: "modified" }, { path: "a", status: "modified" }] }]) assert.throws(() => pathsFromCompare({ ...original, ...patch }, options), /PATH_UNVERIFIED/);
});
test("fork head is proved by the actual source-repository commit endpoint; inaccessible fork cannot pass", async () => {
  const fake = new PullFixture([pull(105, { sourceRepo: "fork/team/repository" }), pull(106, { sourceSha: SHA, sourceBranch: "task/current" })]);
  await collectBoundPulls(fake.client(), fake.context());
  assert.ok(fake.calls.some((call) => call.url === `https://api.cnb.cool/fork/team/repository/-/git/commits/${OTHER}`));
  const inaccessible = new PullFixture(fake.rows); inaccessible.override = (path, url) => url.pathname.startsWith("/fork/") ? Response.json({ error: "no permission" }, { status: 403 }) : undefined;
  await rejectCode(collectBoundPulls(inaccessible.client(), inaccessible.context()), "API_INCOMPLETE");
});
for (const status of [401, 403, 429, 500]) test("HTTP " + status + " is a hard incomplete result without leaking response body", async () => {
  const fake = new PullFixture(); fake.override = () => new Response("secret signed-url=do-not-output", { status });
  await assert.rejects(collectBoundPulls(fake.client(), fake.context()), (error) => { assert.match(error.message, /API_INCOMPLETE/); assert.ok(!error.message.includes("do-not-output")); return true; });
});

function rateLimitFixture(responses, options = {}) {
  let clock = Date.UTC(2026, 9, 7, 12); const calls = [], delays = [];
  const client = new LockApiClient({ repoSlug: REPO, token: "fixture-only", budgetMs: 240_000,
    now: () => clock, sleep: async ms => { delays.push(ms); clock += ms; },
    fetchImpl: async (url, init) => {
      calls.push({ url, init });
      return typeof responses === "function" ? responses(calls.length) : responses[Math.min(calls.length - 1, responses.length - 1)].clone();
    }, ...options });
  return { client, calls, delays };
}

test("429 recovery keeps the same GET URL, credential, repository and actual response", async () => {
  const fixture = rateLimitFixture([new Response("private rate-limit detail", { status: 429 }), Response.json({ observed: "fresh" })]);
  assert.deepEqual(await fixture.client.api("pulls?state=open&page=1&page_size=10"), { observed: "fresh" });
  assert.deepEqual(fixture.delays, [5000]); assert.equal(fixture.calls.length, 2);
  for (const call of fixture.calls) {
    assert.equal(call.url, `https://api.cnb.cool/${REPO}/-/pulls?state=open&page=1&page_size=10`);
    assert.equal(call.init.method, "GET"); assert.equal(call.init.headers.Authorization, "Bearer fixture-only");
    assert.equal(call.init.redirect, "error"); assert.equal(call.init.signal.aborted, true);
  }
});

for (const header of ["30", "Wed, 07 Oct 2026 12:00:30 GMT"]) test("Retry-After is honored within the original total budget: " + header, async () => {
  const fixture = rateLimitFixture([new Response("", { status: 429, headers: { "Retry-After": header } }), Response.json({ observed: true })]);
  assert.deepEqual(await fixture.client.api("pulls"), { observed: true }); assert.deepEqual(fixture.delays, [30_000]);
});

for (const header of ["", "garbage", "0.5", "-1", "0", "Wed, 07 Oct 2026 11:00:00 GMT"]) test("missing, invalid or past retry hint retains bounded local backoff: " + header, async () => {
  const fixture = rateLimitFixture([new Response("", { status: 429, headers: { "Retry-After": header } }), Response.json([])]);
  assert.deepEqual(await fixture.client.api("pulls"), []); assert.deepEqual(fixture.delays, [5000]);
});

for (const header of ["241", "9999999999999999999999999", "Wed, 07 Oct 2026 13:00:00 GMT"]) test("a server retry window beyond the total budget is refused without another GET: " + header, async () => {
  const fixture = rateLimitFixture([new Response("private rate-limit detail", { status: 429, headers: { "Retry-After": header } })]);
  await assert.rejects(fixture.client.api("pulls"), /API_INCOMPLETE.*429/);
  assert.equal(fixture.calls.length, 1); assert.deepEqual(fixture.delays, []);
});

test("persistent 429 is a hard incomplete result after exactly three bounded waits", async () => {
  const fixture = rateLimitFixture([new Response("secret signed-url=do-not-output", { status: 429 })]);
  await assert.rejects(fixture.client.api("pulls"), error => {
    assert.equal(error.code, "API_INCOMPLETE"); assert.equal(error.status, 429);
    assert.ok(!error.message.includes("do-not-output")); return true;
  });
  assert.equal(fixture.calls.length, 4); assert.deepEqual(fixture.delays, [5000, 15_000, 45_000]);
});

for (const status of [401, 403, 404, 500]) test("non-rate-limit HTTP failure is terminal without waiting or retry: " + status, async () => {
  const fixture = rateLimitFixture([new Response("private upstream detail", { status })]);
  await rejectCode(fixture.client.api("pulls"), "API_INCOMPLETE");
  assert.equal(fixture.calls.length, 1); assert.deepEqual(fixture.delays, []);
});

test("raw GET recovery returns only the successful current response bytes", async () => {
  const fixture = rateLimitFixture([new Response("private rate-limit detail", { status: 429 }), new Response("actual-source-bytes\n")]);
  assert.equal(await fixture.client.api("git/raw/main/.cnb.yml", { raw: true }), "actual-source-bytes\n");
  assert.equal(fixture.calls.length, 2);
});

test("malformed successful JSON after a 429 is still terminal and never reused as proof", async () => {
  const fixture = rateLimitFixture([new Response("", { status: 429 }), new Response("not JSON"), Response.json([])]);
  await rejectCode(fixture.client.api("pulls"), "API_INCOMPLETE"); assert.equal(fixture.calls.length, 2);
});

test("a failed or non-returning backoff cannot leak errors or exceed the total budget", async () => {
  const failed = rateLimitFixture([new Response("", { status: 429 })], { sleep: async () => { throw new Error("private token do-not-output"); } });
  await assert.rejects(failed.client.api("pulls"), error => { assert.match(error.message, /API_INCOMPLETE/); assert.ok(!error.message.includes("do-not-output")); return true; });
  assert.equal(failed.calls.length, 1);
  const stalled = rateLimitFixture([new Response("", { status: 429 })], { budgetMs: 20, rateLimitDelays: [1], sleep: async () => new Promise(() => {}) });
  await rejectCode(stalled.client.api("pulls"), "API_INCOMPLETE"); assert.equal(stalled.calls.length, 1);
});

test("the full PR collection still rejects source drift across a 429 recovery window", async () => {
  const fake = new PullFixture(); let detailReads = 0;
  fake.override = path => {
    if (path !== "pulls/105") return undefined;
    detailReads += 1;
    if (detailReads === 2) return new Response("", { status: 429 });
    if (detailReads === 3) return Response.json({ ...fake.rows[0], head: { ...fake.rows[0].head, sha: "e".repeat(40) } });
  };
  await rejectCode(collectBoundPulls(fake.client(), fake.context()), "STALE_PULL");
  assert.equal(detailReads, 3);
});

test("retry configuration is bounded and cannot create unlimited attempts", () => {
  for (const rateLimitDelays of [null, [1, 2, 3, 4], [0], [-1], [1.5], [60_001]]) {
    assert.throws(() => new LockApiClient({ repoSlug: REPO, token: "fixture-only", rateLimitDelays }), /API_INCOMPLETE/);
  }
});
test("invalid JSON, network failure, per-request timeout and total budget all fail closed", async () => {
  for (const fetchImpl of [async () => new Response("not JSON"), async () => { throw new Error("token secret"); }, async () => new Promise(() => {})]) {
    const client = new LockApiClient({ repoSlug: REPO, token: "fixture-only", fetchImpl, timeoutMs: 5, budgetMs: 20 });
    await rejectCode(client.api("pulls"), "API_INCOMPLETE");
  }
  let now = 0; const fake = new PullFixture(); const client = fake.client({ now: () => now, budgetMs: 10 }); now = 11;
  await rejectCode(client.api("pulls"), "API_INCOMPLETE"); assert.equal(fake.calls.length, 0);
});
test("local lack of CNB context is explicit unverified skip; CI lacks token is failure", async () => {
  const f = gitFixture(); const result = await runLockGate({ env: {}, cwd: f.root });
  assert.equal(result.decision, "local-skip"); assert.equal(result.verified, false); assert.equal(result.complete, false);
  await rejectCode(runLockGate({ env: { CI: "true" }, cwd: f.root }), "API_INCOMPLETE");
});
function readyFixture() {
  const f = gitFixture();
  f.git("checkout", "task/current");
  f.git("merge", "--no-ff", "-m", "Merge latest target into source fixture", f.target);
  f.source = f.git("rev-parse", "HEAD");
  f.merge = f.git("commit-tree", f.git("rev-parse", "HEAD^{tree}"), "-p", f.target, "-p", f.source, "-m", "Canonical current merge");
  f.env = { ...f.env, CNB_PULL_REQUEST_SHA: f.source, CNB_COMMIT: f.source, CNB_PULL_REQUEST_MERGE_SHA: f.merge };
  return f;
}
function admissionFixture(installed = true) {
  const f = readyFixture(); const fake = new PullFixture([pull(105, { targetSha: f.target }),
    pull(106, { sourceSha: f.source, targetSha: f.target, sourceBranch: "task/current" })]);
  const state = emptyState(REPO); const paths = changedFiles({ context: resolveLockContext([], f.env), env: f.env, cwd: f.root }).files;
  admitSource(state, { number: 106, headSha: f.source, mainSha: f.target, files: paths });
  const comparison = { ...compareFor(fake.rows[1]), files: paths.map(path => ({ path, status: "modified" })) };
  fake.override = path => {
    if (path === "git/branches/main") return Response.json({ commit: { sha: f.target } });
    if (path === "git/compare/" + f.target + "..." + f.source) return Response.json(comparison);
    if (path === "git/raw/automation%2Fdelivery-state/state.json") return installed ? Response.json(state) : Response.json({}, { status: 404 });
    if (path === "git/branches/automation%2Fdelivery-state") return Response.json({}, { status: 404 });
    if (path === "git/raw/main/.cnb.yml") return new Response("main: {}");
  };
  const run = () => runLockGate({ env: f.env, cwd: f.root, fetchImpl: fake.fetch, apiOptions: { pageSize: 2 }, admissionOptions: { waitMs: 0 } });
  return { f, fake, state, paths, run };
}
test("actual gate uses real PR Git source and API observation for advisory and module decisions", async () => {
  const { f, fake } = admissionFixture(false);
  fake.compares.set("105", compareFor(fake.rows[0], ["normal.txt"]));
  const advisory = await runLockGate({ env: f.env, cwd: f.root, fetchImpl: fake.fetch, apiOptions: { pageSize: 2 } });
  assert.equal(advisory.decision, "pass"); assert.equal(advisory.verified, true); assert.equal(advisory.conflicts[0].blocking, false);
  fake.compares.set("105", compareFor(fake.rows[0], ["sync/another.mjs"]));
  const blocked = await runLockGate({ env: { ...f.env, LOCK_OVERLAP_MODE: "warn" }, cwd: f.root, fetchImpl: fake.fetch, apiOptions: { pageSize: 2 } });
  assert.equal(blocked.decision, "blocked"); assert.ok(blocked.conflicts.some((row) => row.kind === "modules" && row.blocking));
});

test("a supplied full PullFiles filename cannot contradict compare or hide path traversal", async () => {
  for (const filename of ["apps/other/common.ts", "../common.ts", "a\\common.ts", "apps//web/common.ts"]) {
    const fake = new PullFixture(); fake.override = (path) => path === "pulls/105/files" ? Response.json([{ filename, status: "modify" }]) : undefined;
    await rejectCode(collectBoundPulls(fake.client(), fake.context()), "PATH_UNVERIFIED");
  }
  const valid = new PullFixture(); valid.override = (path) => path === "pulls/105/files" ? Response.json([{ filename: "apps/web/common.ts", status: "modify" }]) : undefined;
  assert.deepEqual((await collectBoundPulls(valid.client(), valid.context())).prs[0].paths, ["apps/web/common.ts"]);
});
test("zero-commit compare cannot contain a manufactured nonempty file diff", () => {
  assert.throws(() => pathsFromCompare({ ...compareFor(pull(105)), total_commits: 0 }, { baseSha: BASE, headSha: OTHER }), /PATH_UNVERIFIED/);
  assert.deepEqual(pathsFromCompare({ ...compareFor(pull(105), []), total_commits: 0 }, { baseSha: BASE, headSha: OTHER }).paths, []);
});

test("CNB live compare short statuses normalize without weakening rename or unknown-state proof", () => {
  const original = compareFor(pull(105), []); const options = { baseSha: BASE, headSha: OTHER };
  original.files = [
    { path: "add.ts", status: "add" }, { path: "modify.ts", status: "modify" },
    { path: "delete.ts", status: "delete" }, { path: "new.ts", status: "rename", previous_filename: "old.ts" },
    { path: "copy.ts", status: "copy", previous_filename: "source.ts" },
  ];
  const result = pathsFromCompare(original, options);
  assert.deepEqual(result.records.map((record) => record.status), ["added", "modified", "deleted", "renamed", "copied"]);
  assert.deepEqual(result.paths, ["add.ts", "modify.ts", "delete.ts", "new.ts", "old.ts", "copy.ts", "source.ts"].sort());
  for (const file of [{ path: "a", status: "remove" }, { path: "a", status: "rename" }, { path: "a", status: "copy" }]) {
    assert.throws(() => pathsFromCompare({ ...original, files: [file] }, options), /PATH_UNVERIFIED/);
  }
});

test("installed admission releases old PR-number occupation without dropping bound Git/API proof", async () => {
  const fixture = admissionFixture(); fixture.fake.compares.set("105", compareFor(fixture.fake.rows[0], ["sync/old-open.mjs"]));
  const result = await fixture.run(); assert.equal(result.decision, "pass"); assert.equal(result.verified, true);
  assert.ok(result.conflicts.some(row => row.kind === "modules" && !row.blocking));
});
test("a live fenced development lease still blocks an installed PR even with ordinary warn", async () => {
  const fixture = admissionFixture(); leaseOperation(fixture.state, { action: "acquire", owner: "actual-other-developer", scopes: ["sync"] });
  await assert.rejects(fixture.run(), /有效开发租约/);
});
test("an expired occupation stops blocking while exact admission remains required", async () => {
  const fixture = admissionFixture(); leaseOperation(fixture.state, { action: "acquire", owner: "expired-developer", scopes: ["sync"] }, Date.now() - 1800000);
  assert.equal((await fixture.run()).decision, "pass");
});
test("missing sensitive admission and a receipt for another exact source both fail", async () => {
  for (const mismatch of [false, true]) { const fixture = admissionFixture();
    const replacement = emptyState(REPO); if (mismatch) admitSource(replacement, { number: 106, headSha: OTHER, mainSha: fixture.f.target, files: fixture.paths });
    Object.assign(fixture.state, replacement); await assert.rejects(fixture.run(), /接纳回执/);
  }
});
test("the installed PR cannot use a stale main or a shortened platform file set", async () => {
  for (const drift of ["main", "files"]) { const fixture = admissionFixture(); const previous = fixture.fake.override;
    fixture.fake.override = path => {
      if (drift === "main" && path === "git/branches/main") return Response.json({ commit: { sha: OTHER } });
      if (drift === "files" && path === "git/compare/" + fixture.f.target + "..." + fixture.f.source) return Response.json(compareFor(fixture.fake.rows[1], ["normal.txt"]));
      return previous(path);
    }; await assert.rejects(fixture.run());
  }
});
test("an unreadable installed ledger is an error rather than old-number fallback", async () => {
  const fixture = admissionFixture(); const previous = fixture.fake.override;
  fixture.fake.override = path => path === "git/raw/automation%2Fdelivery-state/state.json" ? Response.json({}, { status: 403 }) : previous(path);
  await assert.rejects(fixture.run(), /API_INCOMPLETE/);
});

test("actual deleted-file URLs bind only the exact target/base, including fork deletions", async () => {
  const fake = new PullFixture([pull(105, { sourceRepo: "fork/team/repository" }), pull(106, { sourceSha: SHA, sourceBranch: "task/current" })]);
  const comparison = compareFor(fake.rows[0], []); comparison.files = [{ path: "scripts/tools/deleted.mts", status: "deleted" }];
  fake.compares.set("105", comparison);
  const file = { filename: "deleted.mts", status: "delete", raw_url: "https://cnb.cool/" + REPO + "/-/git/raw/" + BASE + "/scripts/tools/deleted.mts",
    blob_url: "https://cnb.cool/" + REPO + "/-/blob/" + BASE + "/scripts/tools/deleted.mts" };
  fake.override = path => path === "pulls/105/files" ? Response.json([file]) : undefined;
  assert.deepEqual((await collectBoundPulls(fake.client(), fake.context())).prs[0].paths, ["scripts/tools/deleted.mts"]);
  for (const patch of [
    { raw_url: file.raw_url.replace(BASE, OTHER) }, { raw_url: file.raw_url.replace(BASE, BASE.slice(0, 12)) },
    { raw_url: file.raw_url.replace(REPO, "fork/team/repository") }, { status: "modify" },
    { blob_url: file.blob_url.replace("deleted.mts", "different.mts") },
  ]) { fake.override = path => path === "pulls/105/files" ? Response.json([{ ...file, ...patch }]) : undefined;
    await rejectCode(collectBoundPulls(fake.client(), fake.context()), "PATH_UNVERIFIED");
  }
});
