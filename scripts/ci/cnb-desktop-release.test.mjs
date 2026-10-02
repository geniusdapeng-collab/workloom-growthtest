import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import YAML from "yaml";
import { sealPlatform } from "../desktop-release-finalizer.mjs";
import {
  CnbClient,
  assertGitBinding,
  publishRelease,
  stagePlatform,
  validateContext,
} from "./cnb-desktop-release.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "../..");
const SHA = "a".repeat(40);
const REPOSITORY = "workloom-ai/WorkLoom-growth";
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
    this.mainProtected = true;
    this.tagSha = SHA;
    this.commitAssets = new Map();
    this.releaseAssets = new Map();
    this.pending = new Map();
    this.release = null;
    this.calls = [];
    this.tamperCommitDownload = null;
    this.tamperReleaseDownload = null;
    this.onCreateRelease = null;
    this.badVerifyUrl = false;
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
    if (method === "GET" && path === "git/branches/main") {
      return json({ name: "main", protected: this.mainProtected, commit: { sha: this.mainSha } });
    }
    if (method === "GET" && path === `git/tags/${TAG}`) {
      return json({ name: TAG, target_type: "commit", target: this.tagSha,
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
    const lastDownload = fake.calls.findLastIndex((call) => call.url.startsWith("https://downloads.invalid/release/"));
    assert.ok(patch > lastDownload);
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

test("publisher keeps an incomplete draft if main moves before public promotion", async () => {
  const f = fixture();
  const fake = new FakeCnb();
  try {
    fake.addCandidates(f.root);
    fake.onCreateRelease = () => { fake.mainSha = "b".repeat(40); };
    await assert.rejects(publishRelease({ env: publisherEnv(fake), cwd: f.root,
      checkoutSha: SHA, fetchImpl: fake.fetch, sleep: async () => {} }), /main 已偏离/u);
    assert.equal(fake.release.draft, true);
    assert.ok(!fake.calls.some((call) => call.method === "PATCH"));
  } finally { f.cleanup(); }
});
