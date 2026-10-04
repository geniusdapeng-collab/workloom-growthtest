#!/usr/bin/env node

/**
 * CNB desktop Release publisher for WorkLoom-growth.
 *
 * The api_trigger_desktop_release event runs a Mac producer, a Windows producer,
 * and one publisher in parallel. Producers put sealed candidates in the commit
 * attachment store under the globally unique CNB_BUILD_ID. Only the publisher
 * calls the Release API. The platform token is temporary; this script never
 * accepts a long-lived token through CLI arguments or writes it to disk.
 *
 * CNB's Release API has no immutable-release field. This code refuses existing
 * Releases and never overwrites or deletes assets; repository permissions must
 * separately prevent later edits and deletions by other actors.
 */

import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  createReadStream,
  createWriteStream,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";
import {
  CHECKSUM_NAME,
  PLATFORM_MANIFEST_NAMES,
  RELEASE_MANIFEST_NAME,
  assembleRelease,
  sealPlatform,
  verifyRelease,
} from "../desktop-release-finalizer.mjs";

const REPOSITORY = "workloom-ai/workloom-growthtest";
const EVENT = "api_trigger_desktop_release";
const API_ORIGIN = "https://api.cnb.cool";
const TAG_PATTERN = /^v\d+\.\d+\.\d+$/u;
const SHA_PATTERN = /^[0-9a-f]{40}$/u;
const SHA512_PATTERN = /^[0-9a-f]{128}$/u;
const BUILD_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,99}$/u;
const SAFE_FILE_PATTERN = /^[^/\\\r\n\0]+$/u;
const PIPELINE_BY_ROLE = Object.freeze({
  macos: "desktop-macos",
  windows: "desktop-windows",
  publisher: "desktop-publisher",
});
const UPLOAD_TIMEOUT_MS = 60 * 60 * 1000;
const API_TIMEOUT_MS = 30 * 1000;

function fail(message) {
  throw new Error(message);
}

function assert(condition, message) {
  if (!condition) fail(message);
}

function requireSha(value, label) {
  assert(SHA_PATTERN.test(value ?? ""), `${label} 必须为 40 位小写 Git SHA`);
  return value;
}

function filesOnly(directory) {
  const entries = readdirSync(directory, { withFileTypes: true });
  assert(entries.every((entry) => entry.isFile()), `${directory} 中含非普通文件`);
  return entries.map((entry) => entry.name).sort();
}

function installerNames(platform, names) {
  const patterns = platform === "macos"
    ? [/-mac-arm64\.dmg$/u, /-mac-x64\.dmg$/u]
    : [/-win-x64\.exe$/u];
  assert(PLATFORM_MANIFEST_NAMES[platform], "平台只能为 macos 或 windows");
  return patterns.map((pattern) => {
    const matches = names.filter((name) => pattern.test(name));
    assert(matches.length === 1, `${platform} 的 ${pattern} 安装包必须唯一`);
    return matches[0];
  });
}

function assertCandidateNames(platform, names) {
  assert(names.every((name) => typeof name === "string" && SAFE_FILE_PATTERN.test(name)
    && name !== "." && name !== ".."), `${platform} 候选含不安全文件名`);
  const expected = [
    ...installerNames(platform, names),
    PLATFORM_MANIFEST_NAMES[platform],
  ].sort();
  assert(JSON.stringify(names.slice().sort()) === JSON.stringify(expected),
    `${platform} 候选必须精确包含安装包和平台清单`);
  return expected;
}

async function sha512File(file) {
  const hash = createHash("sha512");
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest("hex");
}

function productRepository(cwd) {
  let product;
  try {
    product = JSON.parse(readFileSync(join(cwd, "product.manifest.json"), "utf8"));
  } catch {
    fail("无法读取产品清单，拒绝发布");
  }
  assert(product?.repository === REPOSITORY, "产品清单仓库身份不符");
  assert(product?.release?.channel === "stable", "产品清单发布通道必须为 stable");
  return product.repository;
}

export function validateContext(env, { role, cwd = process.cwd(), checkoutSha } = {}) {
  const repository = productRepository(cwd);
  assert(env.CNB_EVENT === EVENT, "仅允许 CNB 桌面 Release API 触发事件");
  assert(env.CNB_BRANCH === "main" && env.CNB_DEFAULT_BRANCH === "main",
    "桌面 Release 只能从默认 main 分支触发");
  assert(env.CNB_REPO_SLUG === repository, "CNB 仓库身份与产品清单不符");
  assert(env.CNB_PIPELINE_NAME === PIPELINE_BY_ROLE[role], "CNB 流水线角色不符");
  assert(BUILD_ID_PATTERN.test(env.CNB_BUILD_ID ?? ""), "CNB_BUILD_ID 缺失或格式非法");
  assert(TAG_PATTERN.test(env.RELEASE_TAG ?? ""), "仅允许 vMAJOR.MINOR.PATCH 稳定 tag");
  const sha = requireSha(env.RELEASE_SHA, "RELEASE_SHA");
  assert(env.CNB_COMMIT === sha, "触发提交与 RELEASE_SHA 不一致");
  assert(env.CNB_BRANCH_SHA === sha, "触发时 main SHA 与 RELEASE_SHA 不一致");
  assert(checkoutSha === sha, "工作区 HEAD 与 RELEASE_SHA 不一致");
  assert(env.PLATFORM_SIGNING === "signed", "正式发行必须签名并完成 Apple 公证");
  assert(typeof env.CNB_TOKEN === "string" && env.CNB_TOKEN.length > 0,
    "缺少 CNB 流水线临时令牌");
  const endpoint = new URL(env.CNB_API_ENDPOINT || API_ORIGIN);
  assert(endpoint.origin === API_ORIGIN && endpoint.pathname === "/", "CNB API 地址不受信任");
  return {
    repository,
    tag: env.RELEASE_TAG,
    sha,
    platformSigning: "signed",
    buildId: env.CNB_BUILD_ID,
    role,
  };
}

function currentCheckoutSha(cwd) {
  try {
    return execFileSync("git", ["rev-parse", "HEAD"], {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    fail("无法读取工作区 HEAD");
  }
}

export class CnbClient {
  constructor({ token, fetchImpl = globalThis.fetch } = {}) {
    assert(typeof token === "string" && token.length > 0, "缺少 CNB 临时令牌");
    assert(typeof fetchImpl === "function", "缺少网络传输实现");
    this.token = token;
    this.fetchImpl = fetchImpl;
  }

  apiUrl(path) {
    return `${API_ORIGIN}/${REPOSITORY}/-/${path}`;
  }

  async api(method, path, { body, allow404 = false, expectedStatus = 200, expectJson = true } = {}) {
    const headers = {
      Accept: "application/vnd.cnb.api+json",
      Authorization: `Bearer ${this.token}`,
    };
    if (body !== undefined) headers["Content-Type"] = "application/json";
    let response;
    try {
      response = await this.fetchImpl(this.apiUrl(path), {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        redirect: "manual",
        signal: AbortSignal.timeout(API_TIMEOUT_MS),
      });
    } catch {
      fail(`CNB API ${method} ${path} 网络失败`);
    }
    if (allow404 && response.status === 404) return null;
    assert(response.status === expectedStatus,
      `CNB API ${method} ${path} 返回 HTTP ${response.status}，期望 ${expectedStatus}`);
    if (!expectJson) return null;
    try {
      return await response.json();
    } catch {
      fail(`CNB API ${method} ${path} 返回无效 JSON`);
    }
  }

  async uploadSignedUrl(uploadUrl, file) {
    const url = safeHttpsUrl(uploadUrl);
    const size = statSync(file).size;
    assert(size > 0, "拒绝上传空资产");
    let response;
    try {
      response = await this.fetchImpl(url.href, {
        method: "PUT",
        body: createReadStream(file),
        duplex: "half",
        headers: { "Content-Length": String(size) },
        redirect: "error",
        signal: AbortSignal.timeout(UPLOAD_TIMEOUT_MS),
      });
    } catch {
      fail("CNB 预签名上传失败");
    }
    assert(response.ok, `CNB 预签名上传返回 HTTP ${response.status}`);
  }

  async confirm(verifyUrl, expectedPathPrefix, ttl) {
    const url = safeHttpsUrl(verifyUrl);
    assert(url.origin === API_ORIGIN && url.pathname.startsWith(expectedPathPrefix),
      "CNB 上传确认地址与仓库或目标对象不符");
    url.searchParams.set("ttl", String(ttl));
    let response;
    try {
      response = await this.fetchImpl(url.href, {
        method: "POST",
        headers: {
          Accept: "application/vnd.cnb.api+json",
          Authorization: `Bearer ${this.token}`,
        },
        redirect: "manual",
        signal: AbortSignal.timeout(API_TIMEOUT_MS),
      });
    } catch {
      fail("CNB 附件上传确认网络失败");
    }
    assert(response.status === 200, `CNB 附件上传确认返回 HTTP ${response.status}`);
  }

  async download(path, destination) {
    assert(!existsSync(destination), `拒绝覆盖下载文件 ${basename(destination)}`);
    let response;
    try {
      response = await this.fetchImpl(this.apiUrl(path), {
        method: "GET",
        headers: {
          Accept: "application/octet-stream",
          Authorization: `Bearer ${this.token}`,
        },
        redirect: "manual",
        signal: AbortSignal.timeout(API_TIMEOUT_MS),
      });
    } catch {
      fail(`CNB 附件 ${basename(destination)} 下载入口失败`);
    }
    if (response.status === 302 || response.status === 307) {
      const location = response.headers.get("location");
      const signed = safeHttpsUrl(location);
      try {
        response = await this.fetchImpl(signed.href, {
          method: "GET",
          redirect: "error",
          signal: AbortSignal.timeout(UPLOAD_TIMEOUT_MS),
        });
      } catch {
        fail(`CNB 附件 ${basename(destination)} 预签名下载失败`);
      }
    }
    assert(response.ok && response.body, `CNB 附件 ${basename(destination)} 下载返回 HTTP ${response.status}`);
    try {
      await pipeline(Readable.fromWeb(response.body), createWriteStream(destination, { flags: "wx" }));
    } catch {
      rmSync(destination, { force: true });
      fail(`CNB 附件 ${basename(destination)} 下载流失败`);
    }
  }
}

function safeHttpsUrl(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    fail("CNB 返回无效的附件 URL");
  }
  assert(url.protocol === "https:" && !url.username && !url.password,
    "CNB 附件 URL 必须为无凭据 HTTPS");
  return url;
}

export async function assertGitBinding(client, identity, { requireAbsentRelease = true } = {}) {
  const main = await client.api("GET", "git/branches/main");
  assert(["main", "refs/heads/main"].includes(main?.name) && main.protected === true,
    "远端 main 必须已启用 CNB 分支保护");
  assert(requireSha(main?.commit?.sha, "远端 main SHA") === identity.sha,
    "远端 main 已偏离 RELEASE_SHA");

  const tag = await client.api("GET", `git/tags/${encodeURIComponent(identity.tag)}`);
  const tagSha = tag?.commit?.sha
    ?? (tag?.target_type === "commit" ? tag.target : null);
  assert(requireSha(tagSha, "远端 tag 提交 SHA") === identity.sha,
    "远端稳定 tag 未精确指向 RELEASE_SHA");
  assert([identity.tag, `refs/tags/${identity.tag}`].includes(tag?.name), "远端 tag 名称不符");

  if (requireAbsentRelease) {
    const existing = await client.api("GET", `releases/tags/${encodeURIComponent(identity.tag)}`,
      { allow404: true });
    assert(existing === null, "目标 Release 已存在；拒绝覆盖或接续旧草稿");
  }
}

function candidatePrefix(buildId, platform) {
  return `desktop-${platform}-candidate-${buildId}-`;
}

async function uploadCommitAsset(client, identity, name, file) {
  const size = statSync(file).size;
  const path = `git/commit-assets/${identity.sha}/asset-upload-url`;
  const address = await client.api("POST", path, {
    body: { asset_name: name, size, ttl: 1 },
    expectedStatus: 201,
  });
  assert(address?.upload_url && address?.verify_url, "CNB 未返回完整的提交附件上传地址");
  await client.uploadSignedUrl(address.upload_url, file);
  await client.confirm(address.verify_url,
    `/${REPOSITORY}/-/git/commit-assets/${identity.sha}/asset-upload-confirmation/`, 1);
}

async function listCommitAssets(client, sha) {
  const rows = await client.api("GET", `git/commit-assets/${sha}`);
  assert(Array.isArray(rows), "CNB 提交附件列表格式错误");
  return rows;
}

export async function stagePlatform({ env, platform, releaseDir, cwd = process.cwd(), fetchImpl, checkoutSha } = {}) {
  const role = platform;
  const identity = validateContext(env, {
    role,
    cwd,
    checkoutSha: checkoutSha ?? currentCheckoutSha(cwd),
  });
  const client = new CnbClient({ token: env.CNB_TOKEN, fetchImpl });
  await assertGitBinding(client, identity);
  const prefix = candidatePrefix(identity.buildId, platform);
  const before = await listCommitAssets(client, identity.sha);
  assert(!before.some((row) => typeof row?.name === "string" && row.name.startsWith(prefix)),
    `${platform} 本次构建候选已存在；拒绝覆盖或混用`);

  const scratch = mkdtempSync(join(tmpdir(), `workloom-${platform}-candidate-`));
  try {
    const candidate = join(scratch, "candidate");
    sealPlatform({
      platform,
      releaseDir: resolve(releaseDir),
      outputDir: candidate,
      tag: identity.tag,
      sha: identity.sha,
      platformSigning: identity.platformSigning,
      repository: identity.repository,
    });
    const names = assertCandidateNames(platform, filesOnly(candidate));
    for (const name of names) {
      const file = join(candidate, name);
      assert(lstatSync(file).isFile() && statSync(file).size > 0, `候选 ${name} 非普通非空文件`);
      await uploadCommitAsset(client, identity, `${prefix}${name}`, file);
    }

    const after = await listCommitAssets(client, identity.sha);
    const selected = after.filter((row) => typeof row?.name === "string" && row.name.startsWith(prefix));
    assert(selected.length === names.length, `${platform} 远端候选数量不符`);
    for (const name of names) {
      const rows = selected.filter((row) => row.name === `${prefix}${name}`);
      assert(rows.length === 1 && rows[0].size_in_byte === statSync(join(candidate, name)).size,
        `${platform} 远端候选 ${name} 大小或唯一性不符`);
      const copy = join(scratch, `remote-${name}`);
      await client.download(
        `commit-assets/download/${identity.sha}/${encodeURIComponent(prefix + name)}`,
        copy,
      );
      assert(await sha512File(copy) === await sha512File(join(candidate, name)),
        `${platform} 远端候选 ${name} SHA-512 不匹配`);
    }
    return {
      platform,
      files: names.length,
      buildId: identity.buildId,
      sha: identity.sha,
      manifestSha512: await sha512File(join(candidate, PLATFORM_MANIFEST_NAMES[platform])),
    };
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

function expectedCandidateBindings(env) {
  const bindings = {};
  for (const platform of ["macos", "windows"]) {
    const prefix = platform.toUpperCase();
    const buildId = env[`${prefix}_CANDIDATE_BUILD_ID`];
    const manifestSha512 = env[`${prefix}_CANDIDATE_MANIFEST_SHA512`];
    assert(BUILD_ID_PATTERN.test(buildId ?? ""), `${platform} resolve 构建序号缺失或格式非法`);
    assert(SHA512_PATTERN.test(manifestSha512 ?? ""), `${platform} resolve 清单 SHA-512 缺失或格式非法`);
    bindings[platform] = { buildId, manifestSha512 };
  }
  return bindings;
}

async function downloadCandidates(client, identity, root, bindings) {
  const all = await listCommitAssets(client, identity.sha);
  for (const platform of ["macos", "windows"]) {
    const prefix = candidatePrefix(bindings[platform].buildId, platform);
    const rows = all.filter((row) => typeof row?.name === "string" && row.name.startsWith(prefix));
    const names = rows.map((row) => row.name.slice(prefix.length));
    assertCandidateNames(platform, names);
    const directory = join(root, platform);
    mkdirSync(directory, { recursive: true });
    for (const row of rows) {
      const name = row.name.slice(prefix.length);
      assert(Number.isSafeInteger(row.size_in_byte) && row.size_in_byte > 0,
        `提交候选 ${name} 大小无效`);
      const destination = join(directory, name);
      await client.download(
        `commit-assets/download/${identity.sha}/${encodeURIComponent(row.name)}`,
        destination,
      );
      assert(statSync(destination).size === row.size_in_byte,
        `提交候选 ${name} 下载大小不符`);
    }
    assertCandidateNames(platform, filesOnly(directory));
    const manifestDigest = await sha512File(join(directory, PLATFORM_MANIFEST_NAMES[platform]));
    assert(manifestDigest === bindings[platform].manifestSha512,
      `${platform} 候选清单 SHA-512 与 producer resolve 摘要不匹配`);
  }
}

function assertReleaseRecord(release, identity, { draft, expectedFiles } = {}) {
  assert(typeof release?.id === "string" && release.id.length > 0, "CNB Release ID 缺失");
  assert(release.tag_name === identity.tag && release.tag_commitish === identity.sha,
    "CNB Release 的 tag 或目标提交不符");
  assert(release.draft === draft && release.prerelease === false,
    "CNB Release 草稿或预发布状态不符");
  const assets = release.assets ?? [];
  assert(Array.isArray(assets), "CNB Release 附件列表格式错误");
  if (expectedFiles) {
    const actual = assets.map((asset) => asset.name).sort();
    assert(JSON.stringify(actual) === JSON.stringify(expectedFiles.slice().sort()),
      "CNB Release 必须精确包含五份指定资产");
    assert(assets.every((asset) => Number.isSafeInteger(asset.size) && asset.size > 0),
      "CNB Release 存在空资产或无效大小");
  } else {
    assert(assets.length === 0, "新 Release 草稿必须为空资产集");
  }
}

async function uploadReleaseAsset(client, identity, releaseId, name, file) {
  const size = statSync(file).size;
  const address = await client.api("POST", `releases/${encodeURIComponent(releaseId)}/asset-upload-url`, {
    body: { asset_name: name, size, overwrite: false, ttl: 0 },
    expectedStatus: 201,
  });
  assert(address?.upload_url && address?.verify_url, "CNB 未返回完整的 Release 附件上传地址");
  await client.uploadSignedUrl(address.upload_url, file);
  await client.confirm(address.verify_url,
    `/${REPOSITORY}/-/releases/${encodeURIComponent(releaseId)}/asset-upload-confirmation/`, 0);
}

async function checkRemoteReleaseBytes(client, identity, releaseId, localDir, remoteDir) {
  const names = filesOnly(localDir);
  assert(names.length === 5, "正式资产集必须精确包含五项");
  for (const name of names) {
    await client.download(`releases/download/${encodeURIComponent(identity.tag)}/${encodeURIComponent(name)}`,
      join(remoteDir, name));
    assert(await sha512File(join(remoteDir, name)) === await sha512File(join(localDir, name)),
      `Release 远端资产 ${name} SHA-512 不匹配`);
  }
  verifyRelease({
    directory: remoteDir,
    tag: identity.tag,
    sha: identity.sha,
    platformSigning: identity.platformSigning,
    repository: identity.repository,
  });
  const record = await client.api("GET", `releases/${encodeURIComponent(releaseId)}`);
  assertReleaseRecord(record, identity, { draft: true, expectedFiles: names });
  for (const asset of record.assets) {
    assert(asset.size === statSync(join(localDir, asset.name)).size,
      `Release 远端资产 ${asset.name} 元数据大小不符`);
  }
  return names;
}

export async function publishRelease({ env, cwd = process.cwd(), fetchImpl, checkoutSha, sleep = (ms) => new Promise((r) => setTimeout(r, ms)) } = {}) {
  const identity = validateContext(env, {
    role: "publisher",
    cwd,
    checkoutSha: checkoutSha ?? currentCheckoutSha(cwd),
  });
  const bindings = expectedCandidateBindings(env);
  const client = new CnbClient({ token: env.CNB_TOKEN, fetchImpl });
  await assertGitBinding(client, identity);

  const scratch = mkdtempSync(join(tmpdir(), "workloom-desktop-publisher-"));
  try {
    await downloadCandidates(client, identity, scratch, bindings);
    const releaseDir = join(scratch, "release");
    const remoteDir = join(scratch, "remote");
    mkdirSync(remoteDir);
    assembleRelease({
      macDir: join(scratch, "macos"),
      windowsDir: join(scratch, "windows"),
      outputDir: releaseDir,
      tag: identity.tag,
      sha: identity.sha,
      platformSigning: identity.platformSigning,
      repository: identity.repository,
    });
    const names = filesOnly(releaseDir);
    assert(names.length === 5 && names.includes(CHECKSUM_NAME) && names.includes(RELEASE_MANIFEST_NAME),
      "正式 Release 资产集不是三安装包加两证据文件");

    // Check a second time immediately before the first public write.
    await assertGitBinding(client, identity);
    const release = await client.api("POST", "releases", {
      expectedStatus: 201,
      body: {
        tag_name: identity.tag,
        target_commitish: identity.sha,
        name: `${REPOSITORY.split("/")[1]} ${identity.tag}`,
        body: `已签名、公证的 WorkLoom 桌面版。构建 ${identity.buildId}；提交 ${identity.sha}。安装包及 SHA-512 校验表见附件。`,
        draft: true,
        prerelease: false,
        make_latest: "false",
      },
    });
    assertReleaseRecord(release, identity, { draft: true });

    for (const name of names) await uploadReleaseAsset(client, identity, release.id, name, join(releaseDir, name));
    await checkRemoteReleaseBytes(client, identity, release.id, releaseDir, remoteDir);

    // A moved tag or main invalidates the draft. It remains a draft for manual inspection.
    await assertGitBinding(client, identity, { requireAbsentRelease: false });
    await client.api("PATCH", `releases/${encodeURIComponent(release.id)}`, {
      body: { draft: false, prerelease: false, make_latest: "true" },
      expectJson: false,
    });

    for (let attempt = 0; attempt < 12; attempt += 1) {
      const current = await client.api("GET", `releases/${encodeURIComponent(release.id)}`);
      const latest = await client.api("GET", "releases/latest", { allow404: true });
      if (current?.draft === false && current?.is_latest === true
        && latest?.id === release.id && latest?.is_latest === true) {
        assertReleaseRecord(current, identity, { draft: false, expectedFiles: names });
        assertReleaseRecord(latest, identity, { draft: false, expectedFiles: names });
        await assertGitBinding(client, identity, { requireAbsentRelease: false });
        return { tag: identity.tag, sha: identity.sha, buildId: identity.buildId,
          releaseId: release.id, assets: names };
      }
      if (attempt < 11) await sleep(5000);
    }
    fail("Release 已更新但尚未证实为完整 Latest；需人工复核公开状态");
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

function parseOptions(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    assert(key?.startsWith("--") && value && !value.startsWith("--"), "参数必须使用 --name value");
    const name = key.slice(2).replace(/-([a-z])/gu, (_, letter) => letter.toUpperCase());
    assert(!Object.hasOwn(options, name), `参数重复：${key}`);
    options[name] = value;
  }
  return options;
}

export async function runCli(argv = process.argv.slice(2), env = process.env) {
  const [command, ...rest] = argv;
  const options = parseOptions(rest);
  const cwd = process.cwd();
  const checkoutSha = currentCheckoutSha(cwd);
  if (command === "preflight") {
    assert(!Object.keys(options).length, "preflight 不接受参数");
    const role = env.CNB_PIPELINE_NAME === PIPELINE_BY_ROLE.publisher
      ? "publisher"
      : env.CNB_PIPELINE_NAME === PIPELINE_BY_ROLE.macos
        ? "macos" : "windows";
    const identity = validateContext(env, { role, cwd, checkoutSha });
    await assertGitBinding(new CnbClient({ token: env.CNB_TOKEN }), identity);
    return { tag: identity.tag, sha: identity.sha, buildId: identity.buildId, role };
  }
  if (command === "stage-platform") {
    assert(Object.keys(options).sort().join() === "platform,releaseDir", "stage-platform 参数不完整");
    return stagePlatform({ env, platform: options.platform, releaseDir: options.releaseDir, cwd, checkoutSha });
  }
  if (command === "publish") {
    assert(!Object.keys(options).length, "publish 不接受参数");
    return publishRelease({ env, cwd, checkoutSha });
  }
  fail("用法：cnb-desktop-release.mjs preflight|stage-platform --platform macos|windows --release-dir path|publish");
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const result = await runCli();
    if (process.argv[2] === "stage-platform") {
      process.stdout.write(`##[set-output candidate_manifest_sha512=${result.manifestSha512}]\n`);
    }
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } catch (error) {
    // Never print a fetch error or response body: signed URLs and tokens may be present.
    process.stderr.write(`❌ ${error instanceof Error ? error.message : "CNB Release 未知错误"}\n`);
    process.exitCode = 1;
  }
}
