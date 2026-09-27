#!/usr/bin/env node
/** Install a checksum-pinned local ncnn engine into ignored var/enhance-engine. */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import { createReadStream } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { deflateSync } from "node:zlib";
import { ENGINE_PIN } from "../../bundles/ai-video/connectors/enhance-bridge/pin.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const args = process.argv.slice(2);

function option(name) {
  const at = args.indexOf(`--${name}`);
  if (at < 0) return null;
  if (at + 1 >= args.length || args[at + 1].startsWith("--")) throw new Error(`--${name} 需要值`);
  return args[at + 1];
}

const dest = path.resolve(option("dest") || process.env.WORKLOOM_ENHANCE_ENGINE_DIR || path.join(repoRoot, "var/enhance-engine"));
const archiveInput = option("archive");
const checkOnly = args.includes("--check");

function run(bin, argv, { cwd, timeout = 120_000, stdoutFd } = {}) {
  const result = spawnSync(bin, argv, {
    cwd, timeout,
    encoding: stdoutFd === undefined ? "utf8" : undefined,
    stdio: ["ignore", stdoutFd === undefined ? "pipe" : stdoutFd, "pipe"],
    maxBuffer: 2 * 1024 * 1024,
  });
  if (result.error || result.status !== 0) {
    const detail = String(result.stderr || result.error?.message || "").slice(-800);
    throw new Error(`${path.basename(bin)} 失败（exit=${result.status ?? "spawn"}）：${detail}`);
  }
  return String(result.stdout || "");
}

async function sha256(file) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest("hex");
}

function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let i = 0; i < 8; i++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type, payload) {
  const name = Buffer.from(type, "ascii");
  const size = Buffer.alloc(4);
  size.writeUInt32BE(payload.length);
  const checksum = Buffer.alloc(4);
  checksum.writeUInt32BE(crc32(Buffer.concat([name, payload])));
  return Buffer.concat([size, name, payload, checksum]);
}

function smokePng() {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(16, 0);
  ihdr.writeUInt32BE(16, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // RGB
  const scanlines = [];
  for (let y = 0; y < 16; y++) {
    const row = Buffer.alloc(1 + 16 * 3);
    for (let x = 0; x < 16; x++) {
      row[1 + x * 3] = x * 16;
      row[2 + x * 3] = y * 16;
      row[3 + x * 3] = (x + y) * 8;
    }
    scanlines.push(row);
  }
  return Buffer.concat([
    Buffer.from("89504e470d0a1a0a", "hex"),
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", deflateSync(Buffer.concat(scanlines))),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

async function checkInstall(dir) {
  let pin;
  try {
    pin = JSON.parse(await fsp.readFile(path.join(dir, "PINNED.json"), "utf8"));
    const ready = JSON.parse(await fsp.readFile(path.join(dir, ".runtime-ready"), "utf8"));
    if (pin.archiveSha256 !== ENGINE_PIN.sha256 || ready.archiveSha256 !== ENGINE_PIN.sha256) throw new Error("archive digest mismatch");
    if (!pin.files || Object.keys(pin.files).length !== ENGINE_PIN.archiveEntries.length) throw new Error("incomplete files manifest");
    for (const rel of ENGINE_PIN.archiveEntries) {
      if (!/^[a-f0-9]{64}$/.test(pin.files[rel] || "")) throw new Error(`missing file digest: ${rel}`);
      if ((await sha256(path.join(dir, rel))) !== pin.files[rel]) throw new Error(`file digest mismatch: ${rel}`);
    }
    const binary = path.join(dir, ENGINE_PIN.binary);
    await fsp.access(binary, fs.constants.X_OK);
    return { ready: true, engineDir: dir, release: pin.release, archiveSha256: pin.archiveSha256, smoke: ready.smoke };
  } catch (error) {
    return { ready: false, engineDir: dir, reason: error instanceof Error ? error.message : String(error) };
  }
}

async function lockInstall(lock) {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const handle = await fsp.open(lock, "wx", 0o600);
      await handle.writeFile(JSON.stringify({ pid: process.pid, at: Date.now() }));
      await handle.close();
      return;
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
      let stale = false;
      try {
        const owner = JSON.parse(await fsp.readFile(lock, "utf8"));
        if (Date.now() - Number(owner.at) > 3_600_000) {
          try { process.kill(Number(owner.pid), 0); } catch (killError) { stale = killError?.code === "ESRCH"; }
        }
      } catch { /* Invalid lock is not silently removed. */ }
      if (!stale) throw new Error(`安装锁正在使用：${lock}`);
      await fsp.unlink(lock);
    }
  }
  throw new Error(`无法取得安装锁：${lock}`);
}

async function install() {
  if (process.platform !== "darwin" || process.arch !== "arm64") {
    throw new Error(`仅支持 Apple Silicon macOS 本地安装；当前 ${process.platform}/${process.arch}`);
  }
  const old = await checkInstall(dest);
  if (checkOnly) {
    process.stdout.write(`${JSON.stringify(old, null, 2)}\n`);
    if (!old.ready) process.exitCode = 1;
    return;
  }
  if (old.ready) {
    process.stdout.write(`${JSON.stringify({ ...old, reused: true }, null, 2)}\n`);
    return;
  }

  await fsp.mkdir(path.dirname(dest), { recursive: true });

  const lock = `${dest}.install.lock`;
  await lockInstall(lock);
  let stage;
  let backup;
  try {
    stage = await fsp.mkdtemp(path.join(path.dirname(dest), ".enhance-install-"));
    const archive = path.join(stage, "package.zip");
    if (archiveInput) await fsp.copyFile(path.resolve(archiveInput), archive);
    else run("curl", ["--http1.1", "-fsSL", "--retry", "3", "--max-time", "1800", "-o", archive, ENGINE_PIN.url], { timeout: 1_900_000 });
    const digest = await sha256(archive);
    if (digest !== ENGINE_PIN.sha256) throw new Error(`下载包 SHA256 不匹配：expected=${ENGINE_PIN.sha256} actual=${digest}`);

    const files = {};
    for (const rel of ENGINE_PIN.archiveEntries) {
      const target = path.join(stage, rel);
      await fsp.mkdir(path.dirname(target), { recursive: true });
      const fd = fs.openSync(target, "wx", 0o600);
      try { run("unzip", ["-p", archive, rel], { stdoutFd: fd }); }
      finally { fs.closeSync(fd); }
      if ((await fsp.stat(target)).size === 0) throw new Error(`发布包路径为空：${rel}`);
      files[rel] = await sha256(target);
    }
    await fsp.chmod(path.join(stage, ENGINE_PIN.binary), 0o700);
    const smokeDir = path.join(stage, ".smoke");
    await fsp.mkdir(smokeDir);
    const input = path.join(smokeDir, "input.png");
    const output = path.join(smokeDir, "output.png");
    await fsp.writeFile(input, smokePng());
    run(path.join(stage, ENGINE_PIN.binary), ["-i", input, "-o", output, "-m", path.join(stage, "models"), "-n", "realesr-animevideov3", "-s", "2", "-t", "32", "-j", "1:1:1"], { timeout: 60_000 });
    const result = await fsp.readFile(output);
    if (!result.subarray(0, 8).equals(Buffer.from("89504e470d0a1a0a", "hex")) || result.readUInt32BE(16) !== 32 || result.readUInt32BE(20) !== 32) {
      throw new Error("GPU 冒烟产物不是 32×32 PNG");
    }
    await fsp.rm(smokeDir, { recursive: true, force: true });
    await fsp.rm(archive, { force: true });
    await fsp.writeFile(path.join(stage, "PINNED.json"), `${JSON.stringify({ schema: "workloom.enhance-engine-pin/v1", release: ENGINE_PIN.release, sourceUrl: ENGINE_PIN.url, archiveSha256: ENGINE_PIN.sha256, license: ENGINE_PIN.license, files, installedAt: new Date().toISOString() }, null, 2)}\n`, { mode: 0o600 });
    await fsp.writeFile(path.join(stage, ".runtime-ready"), `${JSON.stringify({ archiveSha256: ENGINE_PIN.sha256, smoke: "16x16→32x32 animevideov3 x2 on local GPU", at: new Date().toISOString() })}\n`, { mode: 0o600 });
    const staged = await checkInstall(stage);
    if (!staged.ready) throw new Error(`安装阶段核验失败：${staged.reason}`);
    try { await fsp.access(dest); backup = `${dest}.previous-${Date.now()}`; await fsp.rename(dest, backup); } catch (error) { if (error?.code !== "ENOENT") throw error; }
    try { await fsp.rename(stage, dest); stage = null; }
    catch (error) { if (backup) { await fsp.rename(backup, dest); backup = null; } throw error; }
    if (backup) { await fsp.rm(backup, { recursive: true, force: true }); backup = null; }
    process.stdout.write(`${JSON.stringify(await checkInstall(dest), null, 2)}\n`);
  } finally {
    if (stage) await fsp.rm(stage, { recursive: true, force: true });
    await fsp.rm(lock, { force: true });
  }
}

install().catch((error) => {
  process.stderr.write(`enhance-engine-install: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
