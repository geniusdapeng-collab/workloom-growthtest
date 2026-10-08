import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { lstatSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import YAML from "yaml";
import { sealPlatform } from "../desktop-release-finalizer.mjs";
import {
  CnbClient,
  assertGitBinding,
  preflightRelease,
  publishRelease,
  readPreflightObservation,
  selectLatestRequiredChecks,
  validatePreflightObservation,
  stagePlatform,
  validateContext,
} from "./cnb-desktop-release.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "../..");
const SHA = "a".repeat(40);
const REPOSITORY = "workloom-ai/workloom-growthtest";
const TAG = "v1.2.3";
const BUILD_ID = "cnb-test-123";
const PREFIX = `/${REPOSITORY}/-/`;

function sha512(value) {
  return createHash("sha512").update(value).digest("hex");
}

function publisherEnv(fake, buildIds = { macos: BUILD_ID, windows: BUILD_ID }) {
  const result = env("publisher");
  for (const platform of ["macos", "windows"]) {
    const prefix = platform.toUpperCase();
    result[`${prefix}_CANDIDATE_BUILD_ID`] = buildIds[platform];
    result[`${prefix}_CANDIDATE_MANIFEST_SHA512`] = sha512(fake.commitAssets.get(
      `desktop-${platform}-candidate-${buildIds[platform]}-desktop-${platform}-manifest.json`,
    ));
  }
  return result;
}

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "workloom-cnb-release-test-"));
  writeFileSync(join(root, "product.manifest.json"), JSON.stringify({
    repository: REPOSITORY,
    release: { channel: "stable" },
  }));
  const release = join(root, "release");
  mkdirSync(release);
  writeFileSync(join(release, "WorkLoom.GEO-mac-arm64.dmg"), "mac arm64 payload\n");
  writeFileSync(join(release, "WorkLoom.GEO-mac-x64.dmg"), "mac x64 payload\n");
  writeFileSync(join(release, "WorkLoom.GEO-win-x64.exe"), "windows payload\n");
  return {
    root,
    release,
    cleanup() { rmSync(root, { recursive: true, force: true }); },
  };
}

function env(role) {
  return {
    CNB_EVENT: "api_trigger_desktop_release",
    CNB_BRANCH: "main",
    CNB_DEFAULT_BRANCH: "main",
    CNB_BRANCH_SHA: SHA,
    CNB_COMMIT: SHA,
    CNB_REPO_SLUG: REPOSITORY,
    CNB_PIPELINE_NAME: role === "publisher" ? "desktop-publisher" : `desktop-${role}`,
    CNB_BUILD_ID: BUILD_ID,
    CNB_API_ENDPOINT: "https://api.cnb.cool",
    CNB_TOKEN: "temporary-test-token",
    RELEASE_TAG: TAG,
    RELEASE_SHA: SHA,
    PLATFORM_SIGNING: "signed",
  };
}

async function bytes(body) {
  if (typeof body === "string") return Buffer.from(body);
  const chunks = [];
  for await (const chunk of body) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}

function json(value, status = 200) {
  return Response.json(value, { status });
}

class FakeCnb {
  constructor() {
    this.mainSha = SHA;
    this.mainName = "refs/heads/main";
    this.mainProtected = true;
    this.tagSha = SHA;
    this.tagName = `refs/tags/${TAG}`;
    this.commitAssets = new Map();
    this.releaseAssets = new Map();
    this.pending = new Map();
    this.release = null;
    this.calls = [];
    this.tamperCommitDownload = null;
    this.tamperReleaseDownload = null;
    this.onCreateRelease = null;
    this.badVerifyUrl = false;
    this.onPublicPromotion = null;
    this.onReadMain = null;
    this.mainReads = 0;
    this.mergeBaseSha = SHA;
    this.checks = requiredChecks();
    this.override = null;
    this.fetch = this.fetch.bind(this);
  }

  releaseRecord() {
    return {
      id: this.release.id,
      tag_name: TAG,
      tag_commitish: SHA,
      draft: this.release.draft,
      prerelease: false,
      is_latest: this.release.latest,
      assets: [...this.releaseAssets].map(([name, value]) => ({ name, size: value.length })),
    };
  }

  addCandidates(root, buildIds = { macos: BUILD_ID, windows: BUILD_ID }) {
    for (const platform of ["macos", "windows"]) {
      const output = join(root, platform);
      sealPlatform({
        platform,
        releaseDir: join(root, "release"),
        outputDir: output,
        tag: TAG,
        sha: SHA,
        platformSigning: "signed",
        repository: REPOSITORY,
      });
      for (const name of readdirSync(output)) {
        this.commitAssets.set(`desktop-${platform}-candidate-${buildIds[platform]}-${name}`,
          readFileSync(join(output, name)));
      }
    }
  }

  async fetch(input, init = {}) {
    const url = new URL(input);
    const method = init.method ?? "GET";
    this.calls.push({ method, url: url.href, body: init.body });
    if (url.origin === "https://uploads.invalid") {
      if (method !== "PUT") return json({ error: "method" }, 405);
      const key = decodeURIComponent(url.pathname.slice(1));
      this.pending.set(key, await bytes(init.body));
      return new Response(null, { status: 200 });
    }
    if (url.origin === "https://downloads.invalid") {
      const [kind, ...parts] = url.pathname.slice(1).split("/");
      const name = decodeURIComponent(parts.join("/"));
      const value = kind === "commit" ? this.commitAssets.get(name) : this.releaseAssets.get(name);
      if (!value) return new Response(null, { status: 404 });
      const changed = kind === "commit"
        ? this.tamperCommitDownload?.(name, value) ?? value
        : this.tamperReleaseDownload?.(name, value) ?? value;
      return new Response(changed, { status: 200 });
    }
    assert.equal(url.origin, "https://api.cnb.cool");
    assert.ok(url.pathname.startsWith(PREFIX), `unexpected path ${url.pathname}`);
    const path = url.pathname.slice(PREFIX.length);
    const overridden = await this.override?.(path, method, init);
    if (overridden !== undefined) return overridden;
    if (method === "GET" && path === "git/branches/main") {
      this.mainReads += 1; this.onReadMain?.(this.mainReads);
      return json({ name: this.mainName, protected: this.mainProtected, commit: { sha: this.mainSha } });
    }
    if (method === "GET" && path === `git/commit-statuses/${SHA}`) return json(this.checks);
    if (method === "GET" && path.startsWith("git/compare/")) {
      const [base, head] = path.slice("git/compare/".length).split("...");
      return json({ base_commit: { sha: base }, head_commit: { sha: head }, merge_base_commit: { sha: this.mergeBaseSha }, total_commits: 1, files: [] });
    }
    if (method === "GET" && path === `git/tags/${TAG}`) {
      return json({ name: this.tagName, target_type: "commit", target: this.tagSha,
        commit: { sha: this.tagSha } });
    }
    if (method === "GET" && path === `releases/tags/${TAG}`) {
      return this.release ? json(this.releaseRecord()) : json({ error: "absent" }, 404);
    }
    if (method === "GET" && path === `git/commit-assets/${SHA}`) {
      return json([...this.commitAssets].map(([name, value]) => ({ name, size_in_byte: value.length })));
    }
    if (method === "POST" && path === `git/commit-assets/${SHA}/asset-upload-url`) {
      const body = JSON.parse(init.body);
      assert.equal(body.ttl, 1);
      return json({
        upload_url: `https://uploads.invalid/commit/${encodeURIComponent(body.asset_name)}`,
        verify_url: this.badVerifyUrl
          ? "https://evil.invalid/steal"
          : `https://api.cnb.cool${PREFIX}git/commit-assets/${SHA}/asset-upload-confirmation/token/${encodeURIComponent(body.asset_name)}`,
      }, 201);
    }
    if (method === "POST" && path.startsWith(`git/commit-assets/${SHA}/asset-upload-confirmation/token/`)) {
      const name = decodeURIComponent(path.split("/").at(-1));
      const value = this.pending.get(`commit/${name}`);
      assert.ok(value);
      this.commitAssets.set(name, value);
      this.pending.delete(`commit/${name}`);
      return json({ status: "ok" });
    }
    if (method === "GET" && path.startsWith(`commit-assets/download/${SHA}/`)) {
      const name = decodeURIComponent(path.split("/").at(-1));
      return new Response(null, { status: 302,
        headers: { location: `https://downloads.invalid/commit/${encodeURIComponent(name)}` } });
    }
    if (method === "POST" && path === "releases") {
      assert.equal(this.release, null);
      const body = JSON.parse(init.body);
      assert.equal(body.tag_name, TAG);
      assert.equal(body.target_commitish, SHA);
      assert.equal(body.draft, true);
      assert.equal(body.make_latest, "false");
      this.release = { id: "release-1", draft: true, latest: false };
      this.onCreateRelease?.();
      return json(this.releaseRecord(), 201);
    }
    if (method === "POST" && path === "releases/release-1/asset-upload-url") {
      const body = JSON.parse(init.body);
      assert.equal(body.overwrite, false);
      assert.equal(body.ttl, 0);
      return json({
        upload_url: `https://uploads.invalid/release/${encodeURIComponent(body.asset_name)}`,
        verify_url: `https://api.cnb.cool${PREFIX}releases/release-1/asset-upload-confirmation/token/${encodeURIComponent(body.asset_name)}`,
      }, 201);
    }
    if (method === "POST" && path.startsWith("releases/release-1/asset-upload-confirmation/token/")) {
      const name = decodeURIComponent(path.split("/").at(-1));
      const value = this.pending.get(`release/${name}`);
      assert.ok(value);
      this.releaseAssets.set(name, value);
      this.pending.delete(`release/${name}`);
      return json({ status: "ok" });
    }
    if (method === "GET" && path.startsWith(`releases/download/${TAG}/`)) {
      const name = decodeURIComponent(path.split("/").at(-1));
      return new Response(null, { status: 302,
        headers: { location: `https://downloads.invalid/release/${encodeURIComponent(name)}` } });
    }
    if (method === "GET" && path === "releases/release-1") return json(this.releaseRecord());
    if (method === "PATCH" && path === "releases/release-1") {
      const body = JSON.parse(init.body);
      assert.deepEqual(body, { draft: false, prerelease: false, make_latest: "true" });
      this.release.draft = false;
      this.release.latest = true;
      this.onPublicPromotion?.();
      return new Response(null, { status: 200 });
    }
    if (method === "GET" && path === "releases/latest") {
      return this.release?.latest ? json(this.releaseRecord()) : json({ error: "absent" }, 404);
    }
    throw new Error(`unexpected mock call ${method} ${path}`);
  }
}

test("CNB config has main-only signed producers and one locked publisher", () => {
  const config = YAML.parse(readFileSync(join(ROOT, ".cnb.yml"), "utf8"));
  assert.equal(config["**"]?.api_trigger_desktop_release, undefined);
  const jobs = config.main.api_trigger_desktop_release;
  assert.deepEqual(jobs.map((job) => job.name),
    ["desktop-macos", "desktop-windows", "desktop-publisher"]);
  assert.deepEqual(jobs[1].lock, {
    key: "workloom-desktop-windows-pg17-install",
    expires: 64800,
    wait: true,
    timeout: 64800,
  });
  for (const [index, platform] of ["macos", "windows"].entries()) {
    assert.equal(jobs[index].runner.namespace, "group");
    assert.ok(jobs[index].runner.tags.includes(`workloom-growth-desktop-${platform}`));
    const stage = jobs[index].stages.find((item) => item.script?.includes(`stage-platform --platform ${platform}`));
    const ready = jobs[index].stages.find((item) => item.type === "cnb:resolve");
    assert.equal(stage.exports.candidate_manifest_sha512,
      `${platform.toUpperCase()}_CANDIDATE_MANIFEST_SHA512`);
    assert.equal(ready.options.data.buildId, "$CNB_BUILD_ID");
    assert.equal(ready.options.data.manifestSha512,
      `$${platform.toUpperCase()}_CANDIDATE_MANIFEST_SHA512`);
    assert.ok(!JSON.stringify(jobs[index]).includes("releases/"));
  }
  const publisher = jobs[2];
  assert.equal(publisher.lock.key, "desktop-production-release");
  assert.deepEqual(publisher.stages.filter((stage) => stage.type === "cnb:await").map((stage) => stage.options.key),
    ["desktop-macos-candidate-ready", "desktop-windows-candidate-ready"]);
  for (const [index, platform] of ["macos", "windows"].entries()) {
    const awaited = publisher.stages.filter((stage) => stage.type === "cnb:await")[index];
    assert.deepEqual(awaited.exports, {
      buildId: `${platform.toUpperCase()}_CANDIDATE_BUILD_ID`,
      manifestSha512: `${platform.toUpperCase()}_CANDIDATE_MANIFEST_SHA512`,
    });
  }
  assert.ok(publisher.stages.some((stage) => stage.script?.includes("cnb-desktop-release.mjs publish")));
});

test("Windows release runner calls pwsh and creates the pgvector source directory before git -C", () => {
  const config = YAML.parse(readFileSync(join(ROOT, ".cnb.yml"), "utf8"));
  const windows = config.main.api_trigger_desktop_release.find((job) => job.name === "desktop-windows");
  const preflight = windows.stages.find((stage) => stage.name.includes("校验发布身份"));
  const pgvector = windows.stages.find((stage) => stage.name.includes("PostgreSQL"));
  assert.match(preflight.script, /Get-Command pwsh/u);
  assert.match(pgvector.script, /& pwsh -NoProfile -File scripts\/build-pgvector-win\.ps1/u);
  const source = readFileSync(join(ROOT, "scripts/build-pgvector-win.ps1"), "utf8");
  const create = source.indexOf("New-Item -ItemType Directory -Path $SourceRoot");
  const init = source.indexOf("git -C $SourceRoot init --quiet");
  assert.ok(create > 0 && init > create, "git -C requires an existing source directory");
});

test("context rejects wrong branch, source SHA, repo, role, or unsigned mode", () => {
  const f = fixture();
  try {
    const good = env("publisher");
    assert.equal(validateContext(good, { role: "publisher", cwd: f.root, checkoutSha: SHA }).sha, SHA);
    assert.equal(validateContext({ ...good, CNB_BUILD_ID: "1" },
      { role: "publisher", cwd: f.root, checkoutSha: SHA }).buildId, "1");
    for (const patch of [
      { CNB_BRANCH: "task/unsafe" }, { CNB_COMMIT: "b".repeat(40) },
      { CNB_BRANCH_SHA: "b".repeat(40) }, { CNB_REPO_SLUG: "other/repo" },
      { PLATFORM_SIGNING: "unsigned" }, { CNB_PIPELINE_NAME: "desktop-macos" },
      { CNB_EVENT: "push" }, { CNB_TOKEN: "" },
    ]) {
      assert.throws(() => validateContext({ ...good, ...patch },
        { role: "publisher", cwd: f.root, checkoutSha: SHA }));
    }
    assert.throws(() => validateContext(good, { role: "publisher", cwd: f.root, checkoutSha: "c".repeat(40) }));
  } finally { f.cleanup(); }
});

test("preflight binds remote main and tag and refuses an existing Release", async () => {
  const fake = new FakeCnb();
  const client = new CnbClient({ token: "test", fetchImpl: fake.fetch });
  const identity = { tag: TAG, sha: SHA };
  await assertGitBinding(client, identity);
  fake.mainName = "main";
  fake.tagName = TAG;
  await assertGitBinding(client, identity);
  fake.mainName = "refs/heads/main-other";
  await assert.rejects(assertGitBinding(client, identity), /分支保护/u);
  fake.mainName = "refs/heads/main";
  fake.tagName = `refs/tags/${TAG}-other`;
  await assert.rejects(assertGitBinding(client, identity), /tag 名称不符/u);
  fake.tagName = `refs/tags/${TAG}`;
  fake.mainProtected = false;
  await assert.rejects(assertGitBinding(client, identity), /分支保护/u);
  fake.mainProtected = true;
  fake.mainSha = "b".repeat(40);
  await assert.rejects(assertGitBinding(client, identity), /main 已偏离/u);
  fake.mainSha = SHA;
  fake.tagSha = "b".repeat(40);
  await assert.rejects(assertGitBinding(client, identity), /tag 未精确指向/u);
  fake.tagSha = SHA;
  fake.release = { id: "already-there", draft: true, latest: false };
  await assert.rejects(assertGitBinding(client, identity), /已存在/u);
});

test("Mac producer seals exact candidates, uploads them once, and reads back SHA-512", async () => {
  const f = fixture();
  const fake = new FakeCnb();
  try {
    const result = await stagePlatform({ env: env("macos"), platform: "macos",
      releaseDir: f.release, cwd: f.root, checkoutSha: SHA, fetchImpl: fake.fetch });
    assert.equal(result.files, 3);
    assert.match(result.manifestSha512, /^[0-9a-f]{128}$/u);
    assert.equal(fake.commitAssets.size, 3);
    assert.equal(fake.release, null);
    assert.equal(fake.calls.filter((call) => call.method === "PUT").length, 3);
    assert.ok(fake.calls.every((call) => call.method !== "DELETE"));
    await assert.rejects(stagePlatform({ env: env("macos"), platform: "macos",
      releaseDir: f.release, cwd: f.root, checkoutSha: SHA, fetchImpl: fake.fetch }), /已存在/u);
  } finally { f.cleanup(); }
});

test("producer rejects a substituted remote candidate and untrusted confirmation URL", async () => {
  const f = fixture();
  try {
    const fake = new FakeCnb();
    fake.tamperCommitDownload = () => Buffer.from("substituted");
    await assert.rejects(stagePlatform({ env: env("macos"), platform: "macos",
      releaseDir: f.release, cwd: f.root, checkoutSha: SHA, fetchImpl: fake.fetch }), /SHA-512 不匹配/u);
    const evil = new FakeCnb();
    evil.badVerifyUrl = true;
    await assert.rejects(stagePlatform({ env: env("macos"), platform: "macos",
      releaseDir: f.release, cwd: f.root, checkoutSha: SHA, fetchImpl: evil.fetch }), /确认地址/u);
    assert.ok(!evil.calls.some((call) => call.url.startsWith("https://evil.invalid")));
  } finally { f.cleanup(); }
});

test("publisher creates draft, uploads exactly five assets, verifies remote bytes, then makes Latest", async () => {
  const f = fixture();
  const fake = new FakeCnb();
  try {
    const buildIds = { macos: "mac-producer-123", windows: "win-producer-456" };
    fake.addCandidates(f.root, buildIds);
    const releaseEnv = { ...publisherEnv(fake, buildIds), CNB_BUILD_ID: "publisher-789" };
    const result = await publishRelease({ env: releaseEnv, cwd: f.root,
      checkoutSha: SHA, fetchImpl: fake.fetch, sleep: async () => {} });
    assert.equal(result.assets.length, 5);
    assert.equal(fake.releaseAssets.size, 5);
    assert.equal(fake.release.draft, false);
    assert.equal(fake.release.latest, true);
    assert.ok(fake.calls.every((call) => call.method !== "DELETE"));
    const uploads = fake.calls.filter((call) => call.method === "POST" && call.url.includes("/asset-upload-url"));
    assert.equal(uploads.length, 5);
    assert.ok(uploads.every((call) => JSON.parse(call.body).overwrite === false));
    const patch = fake.calls.findIndex((call) => call.method === "PATCH");
    const downloads = fake.calls.flatMap((call, index) => call.url.startsWith("https://downloads.invalid/release/") ? [index] : []);
    assert.equal(downloads.length, 10);
    assert.ok(downloads.slice(0, 5).every((index) => index < patch), "five draft bytes must be read before public PATCH");
    assert.ok(downloads.slice(5).every((index) => index > patch), "five public bytes must be read again after public PATCH");
  } finally { f.cleanup(); }
});

test("publisher leaves a draft when remote Release bytes change; never makes it public", async () => {
  const f = fixture();
  const fake = new FakeCnb();
  try {
    fake.addCandidates(f.root);
    fake.tamperReleaseDownload = (name, value) => name.endsWith(".exe") ? Buffer.from("tampered") : value;
    await assert.rejects(publishRelease({ env: publisherEnv(fake), cwd: f.root,
      checkoutSha: SHA, fetchImpl: fake.fetch, sleep: async () => {} }), /SHA-512 不匹配/u);
    assert.equal(fake.release.draft, true);
    assert.ok(!fake.calls.some((call) => call.method === "PATCH"));
  } finally { f.cleanup(); }
});

test("publisher rejects a coherently replaced installer and manifest before creating a draft", async () => {
  const f = fixture();
  const fake = new FakeCnb();
  try {
    fake.addCandidates(f.root);
    const trustedEnv = publisherEnv(fake);
    const installerKey = `desktop-windows-candidate-${BUILD_ID}-WorkLoom.GEO-win-x64.exe`;
    const manifestKey = `desktop-windows-candidate-${BUILD_ID}-desktop-windows-manifest.json`;
    const replacement = Buffer.from("attacker substituted installer bytes");
    const manifest = JSON.parse(fake.commitAssets.get(manifestKey).toString("utf8"));
    const record = manifest.assets.find((asset) => asset.name === "WorkLoom.GEO-win-x64.exe");
    record.size = replacement.length;
    record.sha512 = sha512(replacement);
    fake.commitAssets.set(installerKey, replacement);
    fake.commitAssets.set(manifestKey, Buffer.from(`${JSON.stringify(manifest)}\n`));

    await assert.rejects(publishRelease({ env: trustedEnv, cwd: f.root,
      checkoutSha: SHA, fetchImpl: fake.fetch, sleep: async () => {} }),
    /候选清单 SHA-512 与 producer resolve 摘要不匹配/u);
    assert.equal(fake.release, null);
    assert.ok(!fake.calls.some((call) => call.method === "POST" && call.url.endsWith("/-/releases")));
  } finally { f.cleanup(); }
});

test("publisher refuses mixed-build candidates before creating any Release", async () => {
  const f = fixture();
  const fake = new FakeCnb();
  try {
    fake.addCandidates(f.root);
    const trustedEnv = publisherEnv(fake);
    fake.commitAssets.delete(`desktop-windows-candidate-${BUILD_ID}-desktop-windows-manifest.json`);
    await assert.rejects(publishRelease({ env: trustedEnv, cwd: f.root,
      checkoutSha: SHA, fetchImpl: fake.fetch, sleep: async () => {} }), /候选必须精确包含/u);
    assert.equal(fake.release, null);
  } finally { f.cleanup(); }
});

test("publisher rejects unsafe remote candidate filenames before download", async () => {
  const f = fixture();
  const fake = new FakeCnb();
  try {
    fake.addCandidates(f.root);
    fake.commitAssets.set(`desktop-windows-candidate-${BUILD_ID}-../escape-win-x64.exe`,
      Buffer.from("malicious"));
    await assert.rejects(publishRelease({ env: publisherEnv(fake), cwd: f.root,
      checkoutSha: SHA, fetchImpl: fake.fetch, sleep: async () => {} }), /不安全文件名/u);
    assert.equal(fake.release, null);
  } finally { f.cleanup(); }
});

test("publisher rejects a corrupted downloaded installer before the first Release write", async () => {
  const f = fixture();
  const fake = new FakeCnb();
  try {
    fake.addCandidates(f.root);
    fake.tamperCommitDownload = (name, value) => name.endsWith("-win-x64.exe")
      ? Buffer.alloc(value.length, 0x78) : value;
    await assert.rejects(publishRelease({ env: publisherEnv(fake), cwd: f.root,
      checkoutSha: SHA, fetchImpl: fake.fetch, sleep: async () => {} }), /sha512 不匹配/u);
    assert.equal(fake.release, null);
    assert.ok(!fake.calls.some((call) => call.method === "POST" && call.url.endsWith("/-/releases")));
  } finally { f.cleanup(); }
});

test("publisher keeps a draft if main diverges before public promotion", async () => {
  const f = fixture();
  const fake = new FakeCnb();
  try {
    fake.addCandidates(f.root);
    fake.onCreateRelease = () => { fake.mainSha = "b".repeat(40); fake.mergeBaseSha = "c".repeat(40); };
    await assert.rejects(publishRelease({ env: publisherEnv(fake), cwd: f.root,
      checkoutSha: SHA, fetchImpl: fake.fetch, sleep: async () => {} }), /不是 RELEASE_SHA 的真实后继/u);
    assert.equal(fake.release.draft, true);
    assert.ok(!fake.calls.some((call) => call.method === "PATCH"));
  } finally { f.cleanup(); }
});

test("a bound build can publish while protected main advances normally", async () => {
  const f = fixture();
  const fake = new FakeCnb();
  try {
    fake.addCandidates(f.root);
    fake.onCreateRelease = () => { fake.mainSha = "b".repeat(40); };
    const result = await publishRelease({ env: publisherEnv(fake), cwd: f.root,
      checkoutSha: SHA, fetchImpl: fake.fetch, sleep: async () => {},
      preflightObservation: await preflightRelease({ env: env("publisher"), role: "publisher", cwd: f.root,
        checkoutSha: SHA, fetchImpl: fake.fetch }) });
    assert.equal(result.published, true);
    assert.equal(result.verification, "complete");
    assert.equal(fake.release.draft, false);
  } finally { f.cleanup(); }
});

test("a post-promotion tag violation reports that the release is already public", async () => {
  const f = fixture();
  const fake = new FakeCnb();
  try {
    fake.addCandidates(f.root);
    fake.onPublicPromotion = () => { fake.tagSha = "b".repeat(40); };
    await assert.rejects(publishRelease({ env: publisherEnv(fake), cwd: f.root,
      checkoutSha: SHA, fetchImpl: fake.fetch, sleep: async () => {} }), (error) => {
      assert.equal(error.publicationReceipt?.published, true);
      assert.equal(error.publicationReceipt?.publicPatchAttempted, true);
      assert.equal(error.publicationReceipt?.verification, "violation");
      assert.equal(error.publicationReceipt?.releaseId, "release-1");
      return true;
    });
    assert.equal(fake.release.draft, false);
  } finally { f.cleanup(); }
});


const PIPELINES = ["pipeline-1(static-gate)", "pipeline-2(db-gate)", "pipeline-3(test-gate)"];
function requiredChecks(family = "push", state = "success", time = "2026-10-05T17:00:00Z") {
  return PIPELINES.map((pipeline) => ({ context: `cnb/${family}/${pipeline}`, state, created_at: time, updated_at: time }));
}
function completeIdentity(role = "publisher") {
  return { repository: REPOSITORY, tag: TAG, sha: SHA, buildId: BUILD_ID, role, platformSigning: "signed" };
}
async function observed(fake, f, role = "publisher", receiptPath) {
  return preflightRelease({ env: env(role), role, cwd: f.root, checkoutSha: SHA, fetchImpl: fake.fetch, receiptPath });
}
async function publishFixture(fake, f, options = {}) {
  return publishRelease({ env: publisherEnv(fake), cwd: f.root, checkoutSha: SHA, fetchImpl: fake.fetch, sleep: async () => {}, ...options });
}
function publicationError(promise, { published, verification, attempted = true } = {}) {
  return assert.rejects(promise, (error) => {
    assert.equal(error.publicationReceipt?.schema, "workloom.desktop-publication/v1");
    assert.equal(error.publicationReceipt?.published, published);
    assert.equal(error.publicationReceipt?.verification, verification);
    assert.equal(error.publicationReceipt?.publicPatchAttempted, attempted);
    assert.equal(error.publicationReceipt?.sha, SHA); assert.equal(error.publicationReceipt?.tag, TAG);
    assert.equal(error.publicationReceipt?.repository, REPOSITORY); assert.equal(error.publicationReceipt?.buildId, BUILD_ID);
    return true;
  });
}
test("latest required checks choose full push family over prior green PR family", () => {
  const rows = [...requiredChecks("pull_request"), ...requiredChecks("push")];
  assert.equal(selectLatestRequiredChecks(rows).family, "push");
  rows[3].state = "failure"; assert.throws(() => selectLatestRequiredChecks(rows), /CI_NOT_GREEN/);
  assert.throws(() => selectLatestRequiredChecks([...requiredChecks("pull_request"), requiredChecks("push")[0]]), /CI_UNVERIFIED/);
});
test("absence of any push family permits exactly three latest PR checks", () => {
  assert.equal(selectLatestRequiredChecks(requiredChecks("pull_request")).family, "pull_request");
  assert.throws(() => selectLatestRequiredChecks(requiredChecks("pull_request").slice(0, 2)), /CI_UNVERIFIED/);
});
test("later failing, pending, skipped or unknown state cannot inherit an older success", () => {
  for (const state of ["failure", "error", "pending", "skip", "cancelled"]) {
    const rows = [...requiredChecks(), { ...requiredChecks()[0], state, created_at: "2026-10-05T18:00:00Z", updated_at: "2026-10-05T18:01:00Z" }];
    assert.throws(() => selectLatestRequiredChecks(rows), /CI_(?:NOT_GREEN|UNVERIFIED)/);
  }
});
test("latest success may replace an earlier failure and conflicting ties fail", () => {
  const rows = [...requiredChecks("push", "error"), ...requiredChecks("push", "success", "2026-10-05T18:00:00Z")];
  assert.ok(selectLatestRequiredChecks(rows).checks.every((check) => check.state === "success"));
  rows.push({ ...rows.at(-1), state: "failure" }); assert.throws(() => selectLatestRequiredChecks(rows), /同时刻状态矛盾/);
});
test("empty, enveloped, malformed or invalid timestamp CI data is incomplete", () => {
  for (const rows of [[], { data: requiredChecks() }, null, [null], [{ context: "cnb/push/pipeline-1(static-gate)", state: "success" }]]) {
    assert.throws(() => selectLatestRequiredChecks(rows), /CI_UNVERIFIED/);
  }
  for (const patch of [{ updated_at: "yesterday" }, { created_at: "2026-10-05T18:00:00Z", updated_at: "2026-10-05T17:00:00Z" }]) {
    const rows = requiredChecks(); rows[0] = { ...rows[0], ...patch }; assert.throws(() => selectLatestRequiredChecks(rows), /CI_UNVERIFIED/);
  }
});
test("preflight writes fresh mode 0600 exact-source observation and refuses overwrite", async () => {
  const f = fixture(); const fake = new FakeCnb();
  try {
    const result = await observed(fake, f, "publisher", "desktop-preflight.json");
    assert.equal(result.schema, "workloom.desktop-preflight/v1"); assert.equal(result.exactMainSha, SHA); assert.equal(result.checks.sha, SHA);
    assert.equal(lstatSync(join(f.root, "desktop-preflight.json")).mode & 0o777, 0o600);
    assert.deepEqual(readPreflightObservation("desktop-preflight.json", completeIdentity(), f.root), result);
    await assert.rejects(observed(fake, f, "publisher", "desktop-preflight.json"), /不覆盖旧回执/);
  } finally { f.cleanup(); }
});
test("first preflight stays exact even when a descendant compare would pass", async () => {
  const f = fixture(); const fake = new FakeCnb(); fake.mainSha = "b".repeat(40);
  try { await assert.rejects(observed(fake, f), /INITIAL_MAIN_MISMATCH/); assert.ok(!fake.calls.some((call) => call.url.includes("/git/compare/"))); }
  finally { f.cleanup(); }
});
test("preflight observation is bound to repo, SHA, tag, build, role, signing and current checks", async () => {
  const f = fixture(); const fake = new FakeCnb();
  try {
    const observation = await observed(fake, f);
    for (const patch of [{ repository: "other/repo" }, { sha: "b".repeat(40) }, { tag: "v1.2.4" }, { buildId: "other-build" },
      { role: "macos" }, { platformSigning: "unsigned" }, { protected: false }, { exactMainSha: "b".repeat(40) },
      { observedAt: "never" }, { observedAt: "2999-01-01T00:00:00Z" }, { checks: undefined }]) {
      assert.throws(() => validatePreflightObservation({ ...observation, ...patch }, completeIdentity()));
    }
    assert.throws(() => validatePreflightObservation({ ...observation, checks: { ...observation.checks, sha: "b".repeat(40) } }, completeIdentity()));
  } finally { f.cleanup(); }
});
test("receipt file rejects missing, malformed, oversized, symlink and outside workspace paths", async () => {
  const f = fixture(); const fake = new FakeCnb();
  try {
    await observed(fake, f, "publisher", "valid.json");
    writeFileSync(join(f.root, "malformed.json"), "not-json"); writeFileSync(join(f.root, "oversized.json"), "x".repeat(70_000));
    symlinkSync(join(f.root, "valid.json"), join(f.root, "linked.json"));
    for (const path of ["missing.json", "malformed.json", "oversized.json", "linked.json", "../outside.json"]) {
      assert.throws(() => readPreflightObservation(path, completeIdentity(), f.root));
    }
  } finally { f.cleanup(); }
});
test("later binding accepts protected exact main or a bound real descendant", async () => {
  const f = fixture(); const fake = new FakeCnb();
  try {
    const observation = await observed(fake, f); const client = new CnbClient({ token: "test", fetchImpl: fake.fetch });
    const options = { phase: "later", preflightObservation: observation };
    await assertGitBinding(client, completeIdentity(), options); fake.mainSha = "b".repeat(40);
    const result = await assertGitBinding(client, completeIdentity(), options);
    assert.equal(result.mainSha, fake.mainSha); assert.equal(result.phase, "later");
    assert.ok(fake.calls.some((call) => call.url.endsWith(`git/compare/${SHA}...${fake.mainSha}`)));
    await assert.rejects(assertGitBinding(client, completeIdentity(), { phase: "later" }), /PREFLIGHT_BINDING_INVALID/);
  } finally { f.cleanup(); }
});
test("later compare refuses divergent, abbreviated or incorrectly bound source and target", async () => {
  for (const patch of [{ merge_base_commit: { sha: "c".repeat(40) } }, { base_commit: { sha: "c".repeat(40) } },
    { head_commit: { sha: "b".repeat(12) } }, { merge_base_commit: undefined }]) {
    const f = fixture(); const fake = new FakeCnb();
    try {
      const observation = await observed(fake, f); fake.mainSha = "b".repeat(40);
      fake.override = (path) => path.startsWith("git/compare/") ? json({ base_commit: { sha: SHA }, head_commit: { sha: fake.mainSha },
        merge_base_commit: { sha: SHA }, ...patch }) : undefined;
      await assert.rejects(assertGitBinding(new CnbClient({ token: "test", fetchImpl: fake.fetch }), completeIdentity(),
        { phase: "later", preflightObservation: observation }), /(?:MAIN_ANCESTRY_VIOLATION|ANCESTRY_UNVERIFIED)/);
    } finally { f.cleanup(); }
  }
});
test("main movement during reads is retried within three attempts and continuous movement fails", async () => {
  const f = fixture(); const fake = new FakeCnb();
  try {
    const observation = await observed(fake, f); fake.mainReads = 0;
    fake.onReadMain = (count) => { if (count === 2) fake.mainSha = "b".repeat(40); };
    const options = { phase: "later", preflightObservation: observation };
    await assertGitBinding(new CnbClient({ token: "test", fetchImpl: fake.fetch }), completeIdentity(), options);
    assert.equal(fake.mainReads, 4);
    fake.mainReads = 0; fake.onReadMain = (count) => { fake.mainSha = (count % 2 ? "b" : "c").repeat(40); };
    await assert.rejects(assertGitBinding(new CnbClient({ token: "test", fetchImpl: fake.fetch }), completeIdentity(), options), /有界重读期间持续变化/);
    assert.equal(fake.mainReads, 6);
  } finally { f.cleanup(); }
});
test("post-build producer uses persisted first observation when protected main advances", async () => {
  const f = fixture(); const fake = new FakeCnb();
  try {
    await observed(fake, f, "macos", "macos-preflight.json"); fake.mainSha = "b".repeat(40);
    const result = await stagePlatform({ env: env("macos"), platform: "macos", releaseDir: f.release,
      cwd: f.root, checkoutSha: SHA, fetchImpl: fake.fetch, preflightReceiptPath: "macos-preflight.json" });
    assert.equal(result.files, 3); assert.equal(fake.release, null);
  } finally { f.cleanup(); }
});
test("publisher initial mismatch or newer red CI never performs a Release write", async () => {
  for (const patch of ["main", "ci"]) {
    const f = fixture(); const fake = new FakeCnb();
    try {
      fake.addCandidates(f.root); if (patch === "main") fake.mainSha = "b".repeat(40); else fake.checks[0].state = "failure";
      await assert.rejects(publishFixture(fake, f)); assert.equal(fake.release, null);
      assert.ok(!fake.calls.some((call) => call.method === "POST" && call.url.endsWith("/-/releases")));
    } finally { f.cleanup(); }
  }
});
test("publisher uses persisted first observation across candidate await and normal main movement", async () => {
  const f = fixture(); const fake = new FakeCnb();
  try {
    fake.addCandidates(f.root); await observed(fake, f, "publisher", "publisher-preflight.json"); fake.mainSha = "b".repeat(40);
    const result = await publishFixture(fake, f, { preflightReceiptPath: "publisher-preflight.json" });
    assert.equal(result.published, true); assert.equal(result.verification, "complete");
    assert.equal(result.assetEvidence.length, 5); assert.ok(result.assetEvidence.every((asset) => /^[0-9a-f]{128}$/.test(asset.sha512) && asset.size > 0));
  } finally { f.cleanup(); }
});
test("binding failure before PATCH preserves an actual draft receipt", async () => {
  const f = fixture(); const fake = new FakeCnb();
  try {
    fake.addCandidates(f.root); fake.onCreateRelease = () => { fake.checks[0].state = "pending"; };
    await publicationError(publishFixture(fake, f), { published: false, verification: "violation", attempted: false });
    assert.equal(fake.release.draft, true); assert.ok(!fake.calls.some((call) => call.method === "PATCH"));
  } finally { f.cleanup(); }
});
test("PATCH network ambiguity after successful promotion is reconciled by GET without repeating writes", async () => {
  const f = fixture(); const fake = new FakeCnb();
  try {
    fake.addCandidates(f.root); fake.onPublicPromotion = () => { throw new Error("mock network response lost with secret"); };
    const result = await publishFixture(fake, f);
    assert.equal(result.published, true); assert.equal(result.verification, "complete");
    assert.equal(fake.calls.filter((call) => call.method === "PATCH").length, 1);
    assert.equal(fake.calls.filter((call) => call.method === "POST" && call.url.endsWith("/-/releases")).length, 1);
    assert.ok(!JSON.stringify(result).includes("secret"));
  } finally { f.cleanup(); }
});
test("PATCH failure with an observed draft reports false and performs no overwrite or second promotion", async () => {
  const f = fixture(); const fake = new FakeCnb();
  try {
    fake.addCandidates(f.root); fake.override = (path, method) => method === "PATCH" ? json({ secret: "hidden" }, 500) : undefined;
    await publicationError(publishFixture(fake, f), { published: false, verification: "incomplete" });
    assert.equal(fake.release.draft, true); assert.equal(fake.calls.filter((call) => call.method === "PATCH").length, 1);
    assert.ok(fake.calls.every((call) => call.method !== "DELETE"));
  } finally { f.cleanup(); }
});
test("all state GETs failing after PATCH reports unknown rather than claiming unpublished", async () => {
  const f = fixture(); const fake = new FakeCnb();
  try {
    fake.addCandidates(f.root); fake.onPublicPromotion = () => {
      fake.override = (path, method) => method === "GET" && ["releases/release-1", "releases/latest"].includes(path) ? json({ error: "network" }, 503) : undefined;
    };
    await publicationError(publishFixture(fake, f), { published: "unknown", verification: "incomplete" });
    assert.equal(fake.release.draft, false); assert.equal(fake.calls.filter((call) => call.method === "PATCH").length, 1);
  } finally { f.cleanup(); }
});
test("visible public release whose Latest cannot be confirmed reports true and incomplete", async () => {
  const f = fixture(); const fake = new FakeCnb();
  try {
    fake.addCandidates(f.root); fake.onPublicPromotion = () => { fake.release.latest = false; };
    await publicationError(publishFixture(fake, f), { published: true, verification: "incomplete" });
    assert.equal(fake.release.draft, false);
  } finally { f.cleanup(); }
});
for (const change of ["ci", "protection", "ancestry"]) test("post-promotion " + change + " violation preserves published=true", async () => {
  const f = fixture(); const fake = new FakeCnb();
  try {
    fake.addCandidates(f.root); fake.onPublicPromotion = () => {
      if (change === "ci") fake.checks[0].state = "failure";
      if (change === "protection") fake.mainProtected = false;
      if (change === "ancestry") { fake.mainSha = "b".repeat(40); fake.mergeBaseSha = "c".repeat(40); }
    };
    await publicationError(publishFixture(fake, f), { published: true, verification: "violation" });
  } finally { f.cleanup(); }
});
test("normal protected main advance after promotion returns complete actual publication receipt", async () => {
  const f = fixture(); const fake = new FakeCnb();
  try {
    fake.addCandidates(f.root); fake.onPublicPromotion = () => { fake.mainSha = "b".repeat(40); };
    const result = await publishFixture(fake, f);
    assert.equal(result.published, true); assert.equal(result.verification, "complete"); assert.equal(result.publicPatchAttempted, true);
    assert.equal(result.releaseId, "release-1"); assert.equal(result.assetEvidence.length, 5);
    assert.ok(fake.calls.every((call) => call.method !== "DELETE"));
  } finally { f.cleanup(); }
});
test("post-promotion public asset mutation is detected with actual byte evidence", async () => {
  const f = fixture(); const fake = new FakeCnb();
  try {
    fake.addCandidates(f.root); fake.onPublicPromotion = () => { fake.tamperReleaseDownload = () => Buffer.from("substituted public bytes"); };
    await publicationError(publishFixture(fake, f), { published: true, verification: "violation" });
  } finally { f.cleanup(); }
});
test("post-promotion source API failure is incomplete while actual public state remains true", async () => {
  const f = fixture(); const fake = new FakeCnb();
  try {
    fake.addCandidates(f.root); fake.onPublicPromotion = () => {
      fake.override = (path, method) => method === "GET" && path.startsWith("git/") ? json({}, 503) : undefined;
    };
    await publicationError(publishFixture(fake, f), { published: true, verification: "incomplete" });
  } finally { f.cleanup(); }
});
test("CI API authorization, throttle and schema failure cannot certify preflight", async () => {
  for (const status of [401, 403, 429, 500]) {
    const f = fixture(); const fake = new FakeCnb();
    try {
      fake.override = (path) => path.startsWith("git/commit-statuses/") ? new Response("secret signed URL", { status }) : undefined;
      await assert.rejects(observed(fake, f), (error) => { assert.ok(!error.message.includes("secret")); return true; });
    } finally { f.cleanup(); }
  }
});
test("CI config uses role-local first observations and explicit full lock/release contract tests", () => {
  const config = YAML.parse(readFileSync(join(ROOT, ".cnb.yml"), "utf8")); const jobs = config.main.api_trigger_desktop_release;
  for (const job of jobs) {
    const name = `desktop-preflight-${job.name}.json`; const scripts = job.stages.map((stage) => stage.script ?? "").join("\n");
    assert.ok(scripts.includes(`preflight --receipt ${name}`));
    assert.ok(scripts.includes(`--preflight-receipt ${name}`));
  }
  const source = readFileSync(join(ROOT, ".cnb.yml"), "utf8");
  for (const path of ["scripts/ci/verify-lock-conflict.test.mjs", "scripts/ci/cnb-desktop-release.test.mjs", "scripts/tools/film-existing-render-edit.test.ts"]) assert.ok(source.includes(path));
  const legacyTestAlias = readFileSync(join(ROOT, "scripts/tools/film-existing-render-edit.test.ts"), "utf8");
  assert.equal(fs.existsSync(join(ROOT, "scripts/tools/film-standard-post.test.ts")), true);
  assert.equal(fs.existsSync(join(ROOT, "scripts/tools/film-existing-render-edit.mts")), false);
  // Execute the unchanged alias in real Node processes. Only the canonical
  // runner boundary is synthetic here; its full media suite still runs in CI.
  const root = realpathSync(mkdtempSync(join(tmpdir(), "standard-post-alias-contract-")));
  try {
    const tools = join(root, "scripts/tools"), runnerRoot = join(root, "node_modules/vitest");
    const unrelatedCwd = join(root, "outside-cwd");
    for (const directory of [tools, runnerRoot, unrelatedCwd]) mkdirSync(directory, { recursive: true });
    writeFileSync(join(root, "package.json"), JSON.stringify({ type: "module" }));
    writeFileSync(join(runnerRoot, "package.json"), JSON.stringify({ name: "vitest", type: "module" }));
    const alias = join(tools, "film-existing-render-edit.test.ts"), runner = join(runnerRoot, "vitest.mjs");
    writeFileSync(alias, legacyTestAlias);
    writeFileSync(runner, `console.log(JSON.stringify({ fixture: "canonical-runner-boundary", cwd: process.cwd(), args: process.argv.slice(2) }));
if (process.env.ALIAS_FIXTURE_OUTCOME === "failure") process.exitCode = 17;
if (process.env.ALIAS_FIXTURE_OUTCOME === "signal") process.kill(process.pid, "SIGTERM");
`);
    const call = (env) => spawnSync(process.execPath, [alias], {
      cwd: unrelatedCwd, env, encoding: "utf8", timeout: 20_000,
    });
    for (const outcome of ["success", "failure", "signal"]) {
      const result = call({ ALIAS_FIXTURE_OUTCOME: outcome });
      assert.equal(result.error, undefined, result.error?.message);
      assert.equal(result.signal, null);
      assert.deepEqual(JSON.parse(result.stdout.trim()), { fixture: "canonical-runner-boundary",
        cwd: root, args: ["run", "scripts/tools/film-standard-post.test.ts"] });
      if (outcome === "signal") {
        assert.notEqual(result.status, 0);
        assert.match(result.stderr, /Canonical standard-post suite terminated by SIGTERM/u);
      } else assert.equal(result.status, outcome === "success" ? 0 : 17, result.stderr);
    }
    rmSync(runner);
    const missingRunner = call({});
    assert.equal(missingRunner.error, undefined);
    assert.notEqual(missingRunner.status, 0);
    assert.match(missingRunner.stderr, /Cannot find module/u);
    const canonical = join(tools, "film-standard-post.test.js");
    writeFileSync(canonical, 'console.log("canonical-vitest-import-boundary");\n');
    const vitestImport = call({ VITEST: "1" });
    assert.equal(vitestImport.status, 0, vitestImport.stderr);
    assert.equal(vitestImport.stdout.trim(), "canonical-vitest-import-boundary");
    writeFileSync(canonical, 'throw new Error("canonical-vitest-import-failure");\n');
    const failedImport = call({ VITEST: "1" });
    assert.notEqual(failedImport.status, 0);
    assert.match(failedImport.stderr, /canonical-vitest-import-failure/u);
    assert.equal(readFileSync(alias, "utf8"), legacyTestAlias);
    assert.equal(readFileSync(join(ROOT, "scripts/tools/film-existing-render-edit.test.ts"), "utf8"), legacyTestAlias);
  } finally { rmSync(root, { recursive: true, force: true }); }
});


async function withPublisherCleanupFailure(action) {
  const original = fs.rmSync; const retained = [];
  fs.rmSync = (path, options) => {
    if (String(path).includes("workloom-desktop-publisher-")) {
      retained.push(path); throw new Error("simulated local cleanup failure with hidden detail");
    }
    return original(path, options);
  };
  syncBuiltinESMExports();
  try { return await action(); }
  finally {
    fs.rmSync = original; syncBuiltinESMExports();
    for (const path of retained) original(path, { recursive: true, force: true });
  }
}
test("a cleanup exception after successful public verification preserves the actual publication receipt", async () => {
  const f = fixture(); const fake = new FakeCnb();
  try {
    fake.addCandidates(f.root);
    await withPublisherCleanupFailure(async () => {
      await assert.rejects(publishFixture(fake, f), (error) => {
        assert.equal(error.publicationReceipt?.published, true);
        assert.equal(error.publicationReceipt?.verification, "complete");
        assert.equal(error.publicationReceipt?.cleanup?.state, "failed");
        assert.equal(error.publicationReceipt?.errorCode, "LOCAL_CLEANUP_FAILED");
        assert.ok(!error.message.includes("hidden detail")); return true;
      });
    });
    assert.equal(fake.release.draft, false); assert.equal(fake.calls.filter((call) => call.method === "PATCH").length, 1);
  } finally { f.cleanup(); }
});
test("cleanup failure cannot replace a primary postpublication tag violation or its receipt", async () => {
  const f = fixture(); const fake = new FakeCnb();
  try {
    fake.addCandidates(f.root); fake.onPublicPromotion = () => { fake.tagSha = "b".repeat(40); };
    await withPublisherCleanupFailure(async () => {
      await assert.rejects(publishFixture(fake, f), (error) => {
        assert.match(error.message, /TAG_BINDING_VIOLATION/);
        assert.equal(error.publicationReceipt?.published, true);
        assert.equal(error.publicationReceipt?.verification, "violation");
        assert.equal(error.publicationReceipt?.cleanup?.state, "failed");
        assert.equal(error.publicationReceipt?.errorCode, "TAG_BINDING_VIOLATION"); return true;
      });
    });
  } finally { f.cleanup(); }
});

test("a newer created pending or failed run cannot inherit an older run that finished later", () => {
  for (const state of ["pending", "failure", "error", "skip"]) {
    const rows = requiredChecks("push", "success", "2026-10-05T18:00:00Z");
    rows[0].updated_at = "2026-10-05T18:20:00Z";
    rows.push({ ...rows[0], state, created_at: "2026-10-05T18:10:00Z", updated_at: "2026-10-05T18:10:00Z" });
    assert.throws(() => selectLatestRequiredChecks(rows), /CI_NOT_GREEN/);
  }
});
test("same-created different run targets or unidentifiable conflicting states are ambiguous", () => {
  const rows = requiredChecks();
  rows[0].target_url = "https://cnb.cool/workloom-ai/workloom-growthtest/-/build/logs/old";
  const newerUpdate = { ...rows[0], target_url: "https://cnb.cool/workloom-ai/workloom-growthtest/-/build/logs/new", updated_at: "2026-10-05T17:01:00Z" };
  assert.throws(() => selectLatestRequiredChecks([...rows, newerUpdate]), /CI_UNVERIFIED/);
  delete rows[0].target_url; delete newerUpdate.target_url; newerUpdate.state = "pending";
  assert.throws(() => selectLatestRequiredChecks([...rows, newerUpdate]), /CI_UNVERIFIED/);
  const identifiable = requiredChecks(); identifiable[0] = { ...identifiable[0], target_url: "https://cnb.cool/build/same", state: "pending" };
  const finished = { ...identifiable[0], state: "success", updated_at: "2026-10-05T17:02:00Z" };
  assert.equal(selectLatestRequiredChecks([...identifiable, finished]).checks[0].state, "success");
});
