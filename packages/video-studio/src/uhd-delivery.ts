/**
 * UHD releases are immutable directories. Only `current.json` is switched in
 * place, with one rename after every asset and manifest digest has been checked.
 * Readers resolve that pointer; a failed release leaves the old generation live.
 */
import { createHash, randomUUID } from "node:crypto";
import { createReadStream, copyFileSync, existsSync, lstatSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

export interface UhdPublishInput {
  stagingDir: string;
  publicRoot: string;
  releaseId: string;
  assets: string[];
  manifestName: string;
  approved: boolean;
}

export async function sha256UhdAsset(file: string): Promise<string> {
  const before = statSync(file);
  if (!before.isFile() || before.size < 1) throw new Error(`UHD_PUBLISH_EMPTY_ASSET: ${file}`);
  const digest = createHash("sha256");
  for await (const chunk of createReadStream(file)) digest.update(chunk);
  const after = statSync(file);
  if (before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ino !== after.ino) {
    throw new Error(`UHD_PUBLISH_ASSET_CHANGED: ${file}`);
  }
  return digest.digest("hex");
}

function safeRelative(file: string): string {
  if (!file || isAbsolute(file) || file.split(/[\\/]/).some((part) => !part || part === ".." || part === ".")) {
    throw new Error(`UHD_PUBLISH_UNSAFE_PATH: ${file}`);
  }
  return file;
}

function manifestReferences(manifest: Record<string, unknown>): Array<{ path: string; sha256: string }> {
  const result: Array<{ path: string; sha256: string }> = [];
  const deliverable = manifest.deliverable as { path?: unknown; sha256?: unknown } | undefined;
  if (typeof deliverable?.path !== "string" || typeof deliverable.sha256 !== "string") {
    throw new Error("UHD_PUBLISH_MANIFEST_MISSING_MASTER");
  }
  result.push({ path: deliverable.path, sha256: deliverable.sha256 });
  const variants = manifest.variants;
  if (!Array.isArray(variants) || variants.length === 0) throw new Error("UHD_PUBLISH_MANIFEST_MISSING_VARIANTS");
  for (const value of variants) {
    const item = value as { path?: unknown; sha256?: unknown; cover?: { path?: unknown; sha256?: unknown } | null };
    if (typeof item.path !== "string" || typeof item.sha256 !== "string") {
      throw new Error("UHD_PUBLISH_MANIFEST_INVALID_VARIANT");
    }
    result.push({ path: item.path, sha256: item.sha256 });
    if (item.cover) {
      if (typeof item.cover.path !== "string" || typeof item.cover.sha256 !== "string") {
        throw new Error("UHD_PUBLISH_MANIFEST_INVALID_COVER");
      }
      result.push({ path: item.cover.path, sha256: item.cover.sha256 });
    }
  }
  const assets = manifest.assets;
  if (!Array.isArray(assets) || assets.length === 0) throw new Error("UHD_PUBLISH_MANIFEST_MISSING_ASSET_HASHES");
  for (const value of assets) {
    const item = value as { path?: unknown; sha256?: unknown };
    if (typeof item?.path !== "string" || typeof item.sha256 !== "string") {
      throw new Error("UHD_PUBLISH_MANIFEST_INVALID_ASSET_HASH");
    }
    result.push({ path: item.path, sha256: item.sha256 });
  }
  return result;
}

export async function publishUhdDelivery(
  input: UhdPublishInput,
  move: typeof renameSync = renameSync,
): Promise<{ releaseDir: string; currentFile: string; files: number }> {
  if (!input.approved) throw new Error("UHD_PUBLISH_GATE_NOT_APPROVED");
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(input.releaseId) || input.releaseId.includes("..")) {
    throw new Error("UHD_PUBLISH_INVALID_RELEASE_ID");
  }
  const stagingDir = resolve(input.stagingDir), publicRoot = resolve(input.publicRoot);
  if (stagingDir === publicRoot || publicRoot.startsWith(`${stagingDir}${sep}`) || stagingDir.startsWith(`${publicRoot}${sep}`)) {
    throw new Error("UHD_PUBLISH_DIRECTORY_OVERLAP");
  }
  const releaseDir = join(publicRoot, "releases", input.releaseId);
  const currentFile = join(publicRoot, "current.json");
  if (existsSync(releaseDir)) throw new Error(`UHD_PUBLISH_RELEASE_EXISTS: ${releaseDir}`);
  const manifestName = safeRelative(input.manifestName);
  const assets = [...new Set(input.assets.map(safeRelative))];
  if (!assets.includes(manifestName)) throw new Error("UHD_PUBLISH_MANIFEST_NOT_STAGED");
  const pending = join(dirname(releaseDir), `.pending-${randomUUID()}`);
  const pointerPending = join(publicRoot, `.current-${randomUUID()}.pending`);
  mkdirSync(dirname(releaseDir), { recursive: true });
  let releaseMoved = false;
  try {
    mkdirSync(pending, { recursive: false });
    for (const asset of assets) {
      const source = join(stagingDir, asset), target = join(pending, asset);
      if (!lstatSync(source).isFile()) throw new Error(`UHD_PUBLISH_NON_FILE: ${source}`);
      const sourceSha = await sha256UhdAsset(source);
      mkdirSync(dirname(target), { recursive: true });
      copyFileSync(source, target);
      if (sourceSha !== await sha256UhdAsset(target) || sourceSha !== await sha256UhdAsset(source)) {
        throw new Error(`UHD_PUBLISH_COPY_MISMATCH: ${asset}`);
      }
    }
    const manifest = JSON.parse(readFileSync(join(pending, manifestName), "utf8")) as Record<string, unknown>;
    const refs = manifestReferences(manifest);
    const declaredAssets = (manifest.assets as Array<{ path: string }>).map((entry) => {
      const rel = safeRelative(relative(releaseDir, resolve(entry.path)));
      return rel;
    });
    const copiedContent = assets.filter((asset) => asset !== manifestName).sort();
    if (JSON.stringify(declaredAssets.sort()) !== JSON.stringify(copiedContent)) {
      throw new Error("UHD_PUBLISH_MANIFEST_ASSET_SET_MISMATCH");
    }
    for (const entry of refs) {
      if (!/^[a-f0-9]{64}$/.test(entry.sha256)) throw new Error("UHD_PUBLISH_INVALID_SHA256");
      const rel = safeRelative(relative(releaseDir, resolve(entry.path)));
      if (!assets.includes(rel) || await sha256UhdAsset(join(pending, rel)) !== entry.sha256) {
        throw new Error(`UHD_PUBLISH_MANIFEST_DIGEST_MISMATCH: ${entry.path}`);
      }
    }
    const manifestSha256 = await sha256UhdAsset(join(pending, manifestName));
    const pointer = { schemaVersion: "workloom.uhd-release/v1", releaseId: input.releaseId,
      releaseDir, manifest: join(releaseDir, manifestName), manifestSha256 };
    writeFileSync(pointerPending, `${JSON.stringify(pointer, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
    // This is the only media-directory rename. The previous release stays put.
    move(pending, releaseDir); releaseMoved = true;
    if (await sha256UhdAsset(join(releaseDir, manifestName)) !== manifestSha256) {
      throw new Error("UHD_PUBLISH_MANIFEST_CHANGED_AFTER_RELEASE");
    }
    // Replacing a single file is atomic on the same volume: no empty current path.
    move(pointerPending, currentFile);
    return { releaseDir, currentFile, files: assets.length };
  } catch (error) {
    if (existsSync(pointerPending)) rmSync(pointerPending, { force: true });
    if (releaseMoved && existsSync(releaseDir)) rmSync(releaseDir, { recursive: true, force: true });
    if (existsSync(pending)) rmSync(pending, { recursive: true, force: true });
    throw error;
  }
}
