/** UHD delivery is published as one immutable directory after both gates pass. */
import { createHash, randomUUID } from "node:crypto";
import {
  closeSync, constants, copyFileSync, existsSync, mkdirSync, openSync, readFileSync, readSync, renameSync, rmSync, statSync, writeFileSync,
} from "node:fs";
import { basename, dirname, isAbsolute, join, resolve, sep } from "node:path";

export type UhdArtifactReceipt = { relativePath: string; sha256: string; source?: string };

function safeRelativePath(value: string): string {
  const path = value.trim();
  if (!path || isAbsolute(path) || path === "." || path.split(/[\\/]/).includes("..")) {
    throw new Error(`UHD 交付包路径非法：${value}`);
  }
  return path;
}

function stagedPath(stagingDir: string, relativePath: string): string {
  const root = resolve(stagingDir);
  const file = resolve(root, safeRelativePath(relativePath));
  if (!file.startsWith(root + sep)) throw new Error(`UHD 交付包路径越界：${relativePath}`);
  return file;
}

export function uhdFileSha256(file: string): string {
  const hash = createHash("sha256");
  const fd = openSync(file, "r");
  const chunk = Buffer.allocUnsafe(1024 * 1024);
  try {
    while (true) {
      const bytes = readSync(fd, chunk, 0, chunk.length, null);
      if (bytes === 0) break;
      hash.update(chunk.subarray(0, bytes));
    }
  } finally {
    closeSync(fd);
  }
  return hash.digest("hex");
}

/** Copy a candidate into the unpublished generation and bind both copies to the same bytes. */
export function stageUhdFile(stagingDir: string, source: string, relativePath: string): UhdArtifactReceipt {
  const target = stagedPath(stagingDir, relativePath);
  if (resolve(source) === target) throw new Error(`UHD 候选与暂存路径重合：${source}`);
  const sourceSha = uhdFileSha256(source);
  mkdirSync(dirname(target), { recursive: true });
  copyFileSync(source, target, constants.COPYFILE_EXCL);
  if (uhdFileSha256(target) !== sourceSha || uhdFileSha256(source) !== sourceSha) {
    throw new Error(`UHD 候选在暂存时变化：${relativePath}`);
  }
  return { relativePath, sha256: sourceSha, source };
}

/** Register a variant or manifest already rendered inside the unpublished generation. */
export function registerUhdStagedFile(stagingDir: string, relativePath: string): UhdArtifactReceipt {
  return { relativePath, sha256: uhdFileSha256(stagedPath(stagingDir, relativePath)) };
}

/** One rename makes every validated artifact visible together; prior generations are untouched. */
export function publishUhdPackage(input: {
  stagingDir: string;
  packageDir: string;
  currentFile: string;
  projectId: string;
  runId: string;
  shotlistSha256: string;
  masterApproved: boolean;
  deliverApproved: boolean;
  receipts: UhdArtifactReceipt[];
}): { currentFile: string; manifestPath: string; manifestSha256: string } {
  if (!input.masterApproved || !input.deliverApproved) {
    throw new Error("UHD 母版与交付包必须同轮双重放行");
  }
  if (input.receipts.length === 0 || !input.receipts.some((item) => item.relativePath === "delivery-manifest.json")) {
    throw new Error("UHD 暂存包缺交付清单或文件摘要");
  }
  if (existsSync(input.packageDir)) throw new Error(`UHD 正式版本已存在：${input.packageDir}`);
  if (resolve(dirname(input.currentFile)) !== resolve(dirname(input.packageDir))) {
    throw new Error("UHD 当前版本指针必须与不可变版本包同目录");
  }
  if (statSync(dirname(input.stagingDir)).dev !== statSync(dirname(input.packageDir)).dev) {
    throw new Error("UHD 暂存区与正式目录不在同一文件系统，不能原子发布");
  }
  const seen = new Set<string>();
  for (const item of input.receipts) {
    const file = stagedPath(input.stagingDir, item.relativePath);
    if (seen.has(item.relativePath)) throw new Error(`UHD 暂存包重复路径：${item.relativePath}`);
    seen.add(item.relativePath);
    if (!/^[a-f0-9]{64}$/i.test(item.sha256) || uhdFileSha256(file) !== item.sha256
      || (item.source && uhdFileSha256(item.source) !== item.sha256)) {
      throw new Error(`UHD 暂存包发布前摘要变化：${item.relativePath}`);
    }
  }
  const manifest = JSON.parse(readFileSync(stagedPath(input.stagingDir, "delivery-manifest.json"), "utf8")) as {
    publicationArtifacts?: Array<{ path?: string; sha256?: string }>;
  };
  const expected = input.receipts.filter((item) => item.relativePath !== "delivery-manifest.json");
  if (!Array.isArray(manifest.publicationArtifacts) || manifest.publicationArtifacts.length !== expected.length
    || expected.some((item) => !manifest.publicationArtifacts!.some((row) =>
      row.path === join(input.packageDir, item.relativePath) && row.sha256 === item.sha256))) {
    throw new Error("UHD 清单中的主封面、软字幕、旁挂字幕、母版或变体摘要与暂存文件不符");
  }
  const manifestPath = join(input.packageDir, "delivery-manifest.json");
  const manifestSha256 = input.receipts.find((item) => item.relativePath === "delivery-manifest.json")!.sha256;
  const pendingPointer = `${input.currentFile}.${randomUUID()}.pending`;
  writeFileSync(pendingPointer, `${JSON.stringify({
    schemaVersion: "workloom.uhd-current/v1",
    projectId: input.projectId,
    runId: input.runId,
    shotlistSha256: input.shotlistSha256,
    packageDir: basename(input.packageDir),
    manifest: { path: `${basename(input.packageDir)}/delivery-manifest.json`, sha256: manifestSha256 },
  }, null, 2)}\n`, { flag: "wx" });
  let packageVisible = false;
  try {
    renameSync(input.stagingDir, input.packageDir);
    packageVisible = true;
    renameSync(pendingPointer, input.currentFile);
  } catch (error) {
    rmSync(pendingPointer, { force: true });
    if (packageVisible) rmSync(input.packageDir, { recursive: true, force: true });
    throw error;
  }
  return { currentFile: input.currentFile, manifestPath, manifestSha256 };
}
