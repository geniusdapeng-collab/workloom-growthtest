/** Pinned upstream media tools, installed atomically into a private client cache. */
import path from "node:path";
import os from "node:os";
import { readFileSync } from "node:fs";
import { mkdir, readFile, writeFile, rename, rm, chmod } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { gunzipSync } from "node:zlib";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execute = promisify(execFile);
export const MEDIA_RUNTIME_LOCK = JSON.parse(readFileSync(new URL("./media-runtime-lock.json", import.meta.url), "utf8"));
const hash = bytes => createHash("sha256").update(bytes).digest("hex");
const error = (code, message, cause) => Object.assign(new Error(message, cause ? { cause } : undefined), { code });
export function verifyMediaBytes(bytes, expectedHash, expectedBytes) {
  if (!Buffer.isBuffer(bytes) || bytes.length !== expectedBytes || hash(bytes) !== expectedHash)
    throw error("MEDIA_DOWNLOAD_INTEGRITY", "媒体工具下载不完整或摘要不匹配，未安装该文件");
  return bytes;
}
async function download(url, expectedBytes) {
  // URLs come exclusively from the checked-in release lock, never from a request.
  let networkError;
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(60_000) });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const chunks = []; let size = 0;
    for await (const chunk of response.body) {
      size += chunk.length;
      if (size > expectedBytes) throw error("MEDIA_DOWNLOAD_INTEGRITY", "媒体工具响应超过锁定大小");
      chunks.push(Buffer.from(chunk));
    }
    return Buffer.concat(chunks);
  } catch (failure) { networkError = failure; }
  // System curl also honors HTTPS_PROXY on machines that use a local proxy.
  try {
    const { stdout } = await execute(process.platform === "win32" ? "curl.exe" : "curl",
      ["--fail", "--location", "--silent", "--show-error", "--connect-timeout", "20", "--max-time", "300", url],
      { encoding: "buffer", timeout: 305_000, maxBuffer: expectedBytes + 4096, windowsHide: true });
    return stdout;
  } catch (failure) {
    throw error("MEDIA_DOWNLOAD_FAILED", "媒体工具未能下载。请检查网络或代理后重试；已保存的作品不会丢失", new AggregateError([networkError, failure]));
  }
}
async function validateExecutable(file, runner = execute) {
  const { stdout } = await runner(file, ["-hide_banner", "-version"], { timeout: 20_000, windowsHide: true, maxBuffer: 1024 * 1024 });
  if (!/^(ffmpeg|ffprobe) version /u.test(String(stdout)))
    throw error("MEDIA_RUNTIME_UNSUPPORTED", "锁定媒体工具无法运行");
  return String(stdout).split(/\r?\n/u)[0];
}
async function inspect(directory, manifest, suffix, runner, native) {
  let receipt;
  try { receipt = JSON.parse(await readFile(path.join(directory, "receipt.json"), "utf8")); }
  catch (failure) { if (failure.code === "ENOENT") throw failure; throw error("MEDIA_CACHE_CHANGED", "媒体工具缓存回执损坏", failure); }
  if (receipt.lockHash !== hash(Buffer.from(JSON.stringify(MEDIA_RUNTIME_LOCK)))) throw error("MEDIA_CACHE_CHANGED", "媒体工具缓存版本不匹配");
  const bins = {};
  for (const tool of ["ffmpeg", "ffprobe"]) {
    const file = path.join(directory, tool + suffix);
    verifyMediaBytes(await readFile(file), manifest[tool].sha256, manifest[tool].bytes);
    if (native) await validateExecutable(file, runner); bins[tool] = file;
  }
  for (const name of ["license", "readme"]) verifyMediaBytes(await readFile(path.join(directory, name.toUpperCase())), manifest[name].sha256, manifest[name].bytes);
  return { ...bins, receipt, installed: false };
}
export async function ensureMediaRuntime({ cacheDir = path.join(os.homedir(), ".workloom", "media-runtime"),
  platform = process.platform, arch = process.arch, downloader = download, runner = execute, onProgress = () => {} } = {}) {
  const key = `${platform}-${arch}`, manifest = MEDIA_RUNTIME_LOCK.platforms[key];
  if (!manifest) throw error("MEDIA_PLATFORM_UNSUPPORTED", `该平台尚无锁定媒体工具：${key}`);
  const directory = path.join(path.resolve(cacheDir), `${MEDIA_RUNTIME_LOCK.version}-${key}`), suffix = platform === "win32" ? ".exe" : "";
  await mkdir(path.dirname(directory), { recursive: true });
  try { return await inspect(directory, manifest, suffix, runner, platform === process.platform && arch === process.arch); }
  catch (failure) { if (failure.code !== "ENOENT" && failure.code !== "MEDIA_CACHE_CHANGED" && failure.code !== "MEDIA_DOWNLOAD_INTEGRITY") throw failure; }
  const lock = directory + ".lock";
  try { await mkdir(lock); await writeFile(path.join(lock, "owner.json"), JSON.stringify({ pid: process.pid }), { mode: 0o600 }); }
  catch (failure) {
    if (failure.code !== "EEXIST") throw failure;
    let owner;
    try { owner = JSON.parse(await readFile(path.join(lock, "owner.json"), "utf8")); }
    catch { throw error("MEDIA_INSTALL_BUSY", "媒体工具正在准备，请稍后重试"); }
    if (!Number.isInteger(owner.pid) || owner.pid < 1) throw error("MEDIA_INSTALL_BUSY", "媒体工具锁的持有者无效，请检查缓存目录");
    let alive = true;
    try { process.kill(owner.pid, 0); } catch (probe) { if (probe.code === "ESRCH") alive = false; else throw probe; }
    if (alive) throw error("MEDIA_INSTALL_BUSY", "另一个任务正在准备媒体工具，请稍后重试");
    await rm(lock, { recursive: true });
    return ensureMediaRuntime({ cacheDir, platform, arch, downloader, runner, onProgress });
  }
  const staging = directory + "." + randomUUID() + ".tmp";
  try {
    await mkdir(staging, { mode: 0o700 });
    const versions = {};
    for (const tool of ["ffmpeg", "ffprobe"]) {
      onProgress(`准备 ${tool}`);
      const pinned = manifest[tool], compressed = verifyMediaBytes(await downloader(pinned.url, pinned.compressedBytes), pinned.compressedSha256, pinned.compressedBytes);
      const binary = verifyMediaBytes(gunzipSync(compressed, { maxOutputLength: pinned.bytes }), pinned.sha256, pinned.bytes);
      const file = path.join(staging, tool + suffix); await writeFile(file, binary, { mode: 0o755 });
      if (platform !== "win32") await chmod(file, 0o755);
      if (platform === process.platform && arch === process.arch) versions[tool] = await validateExecutable(file, runner);
      else versions[tool] = "requires-target-execution";
    }
    for (const name of ["license", "readme"]) {
      const pinned = manifest[name];
      await writeFile(path.join(staging, name.toUpperCase()), verifyMediaBytes(await downloader(pinned.url, pinned.bytes), pinned.sha256, pinned.bytes));
    }
    const receipt = { schemaVersion: MEDIA_RUNTIME_LOCK.schemaVersion, version: MEDIA_RUNTIME_LOCK.version, platform, arch,
      lockHash: hash(Buffer.from(JSON.stringify(MEDIA_RUNTIME_LOCK))), sourceUrl: MEDIA_RUNTIME_LOCK.sourceUrl,
      releaseUrl: MEDIA_RUNTIME_LOCK.releaseUrl, versions,
      distributionPolicy: "private-upstream-download; binary-excluded-from-product-payload",
      installedAt: new Date().toISOString() };
    await writeFile(path.join(staging, "receipt.json"), JSON.stringify(receipt, null, 2) + "\n", { mode: 0o600 });
    await rm(directory, { recursive: true, force: true }); await rename(staging, directory);
    return { ffmpeg: path.join(directory, "ffmpeg" + suffix), ffprobe: path.join(directory, "ffprobe" + suffix), receipt, installed: true };
  } finally { await rm(staging, { recursive: true, force: true }); await rm(lock, { recursive: true, force: true }); }
}
