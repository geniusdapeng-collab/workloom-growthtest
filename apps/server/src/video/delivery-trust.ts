/**
 * Delivery trust is a server-side verification boundary, not a manifest flag.
 * No signing API is exported here. Only the internal production authority may
 * issue delivery-seal.json after final review; local CLI output remains draft.
 */
import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import {
  closeSync, constants, existsSync, fstatSync, lstatSync, openSync, readSync, realpathSync,
} from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

export interface DeliveryScope { tenantId: string; workspaceId: string; projectId?: string }
export class DeliveryError extends Error {
  constructor(message: string, readonly code = "bad_request") {
    super(message);
    this.name = "DeliveryError";
  }
}
export type DeliveryArtifactRole = "master" | "variant" | "softsub" | "burned" | "cover" | "subtitle";
export interface RegisteredDeliveryArtifact {
  ref: string; sha256: string; role: DeliveryArtifactRole; variantId: string | null;
}
export interface DeliveryManifestIdentity {
  projectId?: string;
  revision?: number;
  scope?: { tenantId?: string; workspaceId?: string };
  master?: { path?: string; sha256?: string };
  variants?: Array<{
    id?: string;
    video?: { path?: string; sha256?: string } | null;
    softsub?: { path?: string; sha256?: string } | null;
    burned?: { path?: string; sha256?: string } | null;
    cover?: { path?: string; sha256?: string } | null;
  }>;
  subtitles?: { files?: Array<{ path?: string; sha256?: string }> } | null;
  checks?: Array<{ kind?: string; ok?: boolean }>;
}
export const DELIVERY_SEAL_SCHEMA = "workloom.delivery-seal/v1";
export const DELIVERY_CHECK_SET = "workloom.delivery-required/v1";
export const DELIVERY_REQUIRED_CHECKS: Record<DeliveryArtifactRole | "package", readonly string[]> = {
  master: ["visual", "audio", "subtitle", "provenance", "final_review"],
  variant: ["visual", "audio", "subtitle", "provenance", "final_review"],
  softsub: ["visual", "audio", "subtitle", "provenance", "final_review"],
  burned: ["visual", "audio", "subtitle", "provenance", "final_review"],
  cover: ["visual", "provenance"],
  subtitle: ["subtitle", "provenance"],
  package: ["variant_axes", "variant_distinctness"],
};
export interface DeliverySealPayload {
  issuer: "workloom.production-authority";
  checkSet: typeof DELIVERY_CHECK_SET;
  scope: { tenantId: string; workspaceId: string };
  projectId: string;
  revision: number;
  manifestSha256: string;
  recipeSha256: string;
  toolchainSha256: string;
  issuedAt: string;
  expiresAt: string;
  packageRealPath: string;
  artifacts: Array<RegisteredDeliveryArtifact & { bytes: number; realpath: string }>;
  checks: Array<{
    id: string; artifactRef: string | null; artifactSha256: string;
    status: "passed";
    evidence: { ref: string; sha256: string };
  }>;
}
export interface DeliveryTrust {
  status: "verified" | "draft" | "invalid";
  reason: string;
  manifestSha256: string | null;
  revision: number | null;
  sealSha256: string | null;
}
const SHA = /^[a-f0-9]{64}$/;
function fail(message: string, code = "delivery_unverified"): never { throw new DeliveryError(message, code); }
export const deliverySha256 = (bytes: string | Buffer): string => createHash("sha256").update(bytes).digest("hex");

/** Canonical bytes are part of the seal protocol; fields cannot depend on key order. */
export function canonicalDeliveryJson(value: unknown): string {
  if (value === null || typeof value !== "object") {
    const encoded = JSON.stringify(value);
    if (encoded === undefined || (typeof value === "number" && !Number.isFinite(value))) fail("封签含不可序列化值");
    return encoded;
  }
  if (Array.isArray(value)) return `[${value.map(canonicalDeliveryJson).join(",")}]`;
  return `{${Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
    .map(([key, item]) => `${JSON.stringify(key)}:${canonicalDeliveryJson(item)}`).join(",")}}`;
}

export function assertDeliveryScope(scope: DeliveryScope): void {
  for (const [key, value] of Object.entries({ tenantId: scope?.tenantId, workspaceId: scope?.workspaceId })) {
    if (typeof value !== "string" || !value.trim() || value !== value.trim() || value.length > 200 || /[\x00-\x1f]/.test(value)) {
      fail(`缺少有效交付作用域 ${key}`, "scope_required");
    }
  }
  if (scope.projectId !== undefined && (typeof scope.projectId !== "string" || !scope.projectId.trim() || scope.projectId.length > 200)) {
    fail("交付 projectId 非法", "bad_request");
  }
}
export function scopedDeliveryRoot(root: string, scope: DeliveryScope): string {
  assertDeliveryScope(scope);
  return join(resolve(root), "scopes", deliverySha256(`${scope.tenantId}\0${scope.workspaceId}`));
}
export function assertManifestScope(manifest: DeliveryManifestIdentity, scope: DeliveryScope): void {
  assertDeliveryScope(scope);
  if (!manifest || typeof manifest !== "object" || typeof manifest.projectId !== "string" || !manifest.projectId.trim()) fail("交付清单缺 projectId", "bad_media");
  // Legacy files can be previewed only after explicit placement in this scoped
  // directory. An explicit conflicting owner is always rejected, even in draft.
  if (manifest.scope && (manifest.scope.tenantId !== scope.tenantId || manifest.scope.workspaceId !== scope.workspaceId)) {
    fail("交付包不在当前租户或工作区", "scope_mismatch");
  }
  if (scope.projectId !== undefined && scope.projectId !== manifest.projectId) fail("交付包不属于当前项目", "scope_mismatch");
}

export function cleanDeliveryRef(ref: unknown): string {
  if (typeof ref !== "string" || !ref || ref !== ref.trim() || isAbsolute(ref) || /[\\\x00-\x1f]/.test(ref)
    || /^[A-Za-z]:/.test(ref) || ref.split("/").some((part) => !part || part === "." || part === "..")) {
    fail("交付物引用非法", "path_not_allowed");
  }
  return ref;
}

/** Reject symlinks in every relative component, not only in the final file. */
export function safeDeliveryPath(root: string, ref: string, allowMissing = false): string {
  const clean = cleanDeliveryRef(ref);
  const absRoot = resolve(root);
  if (!existsSync(absRoot) || !lstatSync(absRoot).isDirectory() || lstatSync(absRoot).isSymbolicLink()) fail("交付根不存在或为符号链接", "path_not_allowed");
  const canonicalRoot = realpathSync(absRoot);
  let current = absRoot;
  for (const part of clean.split("/")) {
    current = join(current, part);
    if (!existsSync(current)) {
      // lstat catches dangling symlinks too.
      try { if (lstatSync(current).isSymbolicLink()) fail("交付路径不允许符号链接", "path_not_allowed"); }
      catch (error) { if (error instanceof DeliveryError) throw error; if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
      if (allowMissing) continue;
      fail("交付物不存在", "not_found");
    }
    if (lstatSync(current).isSymbolicLink()) fail("交付路径不允许符号链接", "path_not_allowed");
    const real = realpathSync(current);
    if (real !== canonicalRoot && !real.startsWith(canonicalRoot + sep)) fail("交付路径越界", "path_not_allowed");
  }
  return current;
}

/** Hash and optionally read the same file descriptor; compare identity before/after. */
export function inspectDeliveryFile(root: string, ref: string, options: { read?: boolean; maxBytes?: number } = {}): {
  path: string; sha256: string; bytes: number; content?: Buffer;
} {
  const file = safeDeliveryPath(root, ref);
  const fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = fstatSync(fd);
    if (!before.isFile() || before.size <= 0) fail("交付物不是非空文件", "bad_media");
    if (options.maxBytes !== undefined && before.size > options.maxBytes) fail("超过页内取件上限", "artifact_too_large");
    const hash = createHash("sha256");
    const block = Buffer.allocUnsafe(256 * 1024);
    const contents: Buffer[] = [];
    let bytes = 0;
    for (;;) {
      const count = readSync(fd, block, 0, block.length, null);
      if (count === 0) break;
      bytes += count;
      if (options.maxBytes !== undefined && bytes > options.maxBytes) fail("超过页内取件上限", "artifact_too_large");
      hash.update(block.subarray(0, count));
      if (options.read) contents.push(Buffer.from(block.subarray(0, count)));
    }
    const after = fstatSync(fd);
    const current = lstatSync(safeDeliveryPath(root, ref));
    if (bytes !== before.size || after.size !== before.size || after.mtimeMs !== before.mtimeMs
      || after.ctimeMs !== before.ctimeMs || current.ino !== before.ino || current.dev !== before.dev) {
      fail("交付文件在核验期间发生变化", "artifact_changed");
    }
    return { path: file, sha256: hash.digest("hex"), bytes, ...(options.read ? { content: Buffer.concat(contents) } : {}) };
  } finally { closeSync(fd); }
}

export function readDeliveryManifestFile(packageDir: string): { manifest: DeliveryManifestIdentity; sha256: string } {
  const read = inspectDeliveryFile(packageDir, "delivery-manifest.json", { read: true, maxBytes: 4 * 1024 * 1024 });
  try {
    const manifest = JSON.parse(read.content!.toString("utf8")) as DeliveryManifestIdentity;
    if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) fail("交付清单格式非法", "bad_media");
    if (manifest.variants !== undefined && (!Array.isArray(manifest.variants)
      || manifest.variants.some((variant) => !variant || typeof variant !== "object" || Array.isArray(variant)))) fail("交付变体清单格式非法", "bad_media");
    if (manifest.checks !== undefined && (!Array.isArray(manifest.checks)
      || manifest.checks.some((check) => !check || typeof check !== "object" || Array.isArray(check)))) fail("交付检查清单格式非法", "bad_media");
    if (manifest.subtitles?.files !== undefined && (!Array.isArray(manifest.subtitles.files)
      || manifest.subtitles.files.some((file) => !file || typeof file !== "object" || Array.isArray(file)))) fail("交付字幕清单格式非法", "bad_media");
    return { manifest, sha256: read.sha256 };
  } catch (error) { if (error instanceof DeliveryError) throw error; fail("交付清单 JSON 解析失败", "bad_media"); }
}

/** Only product artifacts declared by the manifest are previewable; no arbitrary files. */
export function registeredDeliveryArtifacts(manifest: DeliveryManifestIdentity): RegisteredDeliveryArtifact[] {
  const rows: RegisteredDeliveryArtifact[] = [];
  const add = (value: { path?: string; sha256?: string } | null | undefined, role: DeliveryArtifactRole, variantId: string | null) => {
    if (!value) return;
    const ref = cleanDeliveryRef(value.path);
    if (!SHA.test(value.sha256 ?? "")) fail(`交付物 ${ref} 缺有效 sha256`, "artifact_unregistered");
    if (rows.some((row) => row.ref === ref)) fail(`交付物引用重复 ${ref}`, "artifact_unregistered");
    rows.push({ ref, sha256: value.sha256!, role, variantId });
  };
  add(manifest.master, "master", null);
  if (manifest.variants !== undefined && !Array.isArray(manifest.variants)) fail("变体清单格式非法", "bad_media");
  const ids = new Set<string>();
  for (const variant of manifest.variants ?? []) {
    if (!variant || typeof variant.id !== "string" || !variant.id.trim() || ids.has(variant.id)) fail("变体标识缺失或重复", "bad_media");
    ids.add(variant.id);
    add(variant.video, "variant", variant.id);
    add(variant.softsub, "softsub", variant.id);
    add(variant.burned, "burned", variant.id);
    add(variant.cover, "cover", variant.id);
  }
  if (manifest.subtitles?.files !== undefined && !Array.isArray(manifest.subtitles.files)) fail("字幕清单格式非法", "bad_media");
  for (const file of manifest.subtitles?.files ?? []) add(file, "subtitle", null);
  return rows;
}

export function inspectRegisteredDeliveryArtifact(packageDir: string, manifest: DeliveryManifestIdentity, ref: string,
  options: { read?: boolean; maxBytes?: number } = {}): ReturnType<typeof inspectDeliveryFile> & RegisteredDeliveryArtifact {
  const row = registeredDeliveryArtifacts(manifest).find((artifact) => artifact.ref === cleanDeliveryRef(ref));
  if (!row) fail("交付物未在清单登记", "artifact_unregistered");
  const file = inspectDeliveryFile(packageDir, row.ref, options);
  if (file.sha256 !== row.sha256) fail(`交付物指纹不一致 ${row.ref}`, "artifact_changed");
  return { ...row, ...file };
}

export function inspectDeliveryTrust(packageDir: string, scope: DeliveryScope, env: NodeJS.ProcessEnv = process.env): DeliveryTrust {
  let manifestSha256: string | null = null;
  let revision: number | null = null;
  try {
    const loaded = readDeliveryManifestFile(packageDir);
    manifestSha256 = loaded.sha256;
    const manifest = loaded.manifest;
    assertManifestScope(manifest, scope);
    revision = Number.isSafeInteger(manifest.revision) && manifest.revision! > 0 ? manifest.revision! : null;
    if (!existsSync(join(packageDir, "delivery-seal.json"))) return { status: "draft", reason: "缺少服务端生产封签", manifestSha256, revision, sealSha256: null };
    const secret = env.WORKLOOM_DELIVERY_SIGNING_SECRET;
    if (!secret || Buffer.byteLength(secret) < 32) fail("服务端交付验签密钥未配置");
    const sealFile = inspectDeliveryFile(packageDir, "delivery-seal.json", { read: true, maxBytes: 4 * 1024 * 1024 });
    const seal = JSON.parse(sealFile.content!.toString("utf8")) as { schemaVersion?: string; payload?: DeliverySealPayload; signature?: string };
    if (seal.schemaVersion !== DELIVERY_SEAL_SCHEMA || !seal.payload || !SHA.test(seal.signature ?? "")) fail("交付封签格式非法");
    const expected = createHmac("sha256", secret).update(canonicalDeliveryJson(seal.payload)).digest();
    const actual = Buffer.from(seal.signature!, "hex");
    if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) fail("交付封签签名不匹配");
    const payload = seal.payload;
    if (payload.issuer !== "workloom.production-authority" || payload.checkSet !== DELIVERY_CHECK_SET
      || payload.scope?.tenantId !== scope.tenantId || payload.scope?.workspaceId !== scope.workspaceId
      || manifest.scope?.tenantId !== scope.tenantId || manifest.scope?.workspaceId !== scope.workspaceId
      || payload.projectId !== manifest.projectId || payload.revision !== revision || revision === null
      || payload.manifestSha256 !== manifestSha256 || !SHA.test(payload.recipeSha256) || !SHA.test(payload.toolchainSha256)
      || !Number.isFinite(Date.parse(payload.issuedAt)) || Date.parse(payload.issuedAt) > Date.now() + 60_000
      || !Number.isFinite(Date.parse(payload.expiresAt)) || Date.parse(payload.expiresAt) <= Date.now()
      || Date.parse(payload.expiresAt) <= Date.parse(payload.issuedAt)
      || payload.packageRealPath !== realpathSync(packageDir)) fail("交付封签归属、版本、配方或清单指纹不匹配");
    if (!Array.isArray(manifest.checks) || manifest.checks.length === 0 || manifest.checks.some((check) => check?.ok !== true)) fail("交付清单检查缺失或未显式通过");
    const registered = registeredDeliveryArtifacts(manifest);
    if (!registered.some((row) => row.role === "master") || registered.filter((row) => row.role === "variant").length < 3
      || (manifest.variants ?? []).some((variant) => !variant.video || !variant.cover)) fail("交付主件、三支变体或封面缺失");
    if (!Array.isArray(payload.artifacts) || payload.artifacts.length !== registered.length || !Array.isArray(payload.checks)) fail("交付封签产物集合不匹配");
    const actualFiles = new Map<string, string>();
    for (const row of registered) {
      const claims = payload.artifacts.filter((artifact) => artifact.ref === row.ref);
      if (claims.length !== 1) fail("交付封签产物缺失或重复");
      const claim = claims[0]!;
      const file = inspectRegisteredDeliveryArtifact(packageDir, manifest, row.ref);
      if (claim.sha256 !== file.sha256 || claim.bytes !== file.bytes || claim.realpath !== realpathSync(file.path) || claim.role !== row.role || claim.variantId !== row.variantId) fail("交付封签与当前产物不一致");
      actualFiles.set(row.ref, file.sha256);
    }
    const required = [{ ref: null, role: "package" as const, sha256: manifestSha256 }, ...registered];
    const expectedKeys = new Set(required.flatMap((row) => DELIVERY_REQUIRED_CHECKS[row.role].map((id) => `${row.ref ?? "package"}\0${id}`)));
    const seen = new Set<string>();
    for (const check of payload.checks) {
      const key = `${check.artifactRef ?? "package"}\0${check.id}`;
      if (seen.has(key) || !expectedKeys.has(key) || check.status !== "passed") fail("交付封签检查未通过、重复或不属于固定检查集合");
      seen.add(key);
      const boundHash = check.artifactRef === null ? manifestSha256 : actualFiles.get(check.artifactRef);
      if (check.artifactSha256 !== boundHash || !SHA.test(check.evidence?.sha256 ?? "")) fail("检查未绑定当前产物及证据");
      const evidence = inspectDeliveryFile(packageDir, check.evidence.ref, { read: true, maxBytes: 4 * 1024 * 1024 });
      if (evidence.sha256 !== check.evidence.sha256) fail("交付检查证据指纹不一致");
      const record = JSON.parse(evidence.content!.toString("utf8")) as Record<string, unknown>;
      const recordScope = record.scope as DeliveryScope | undefined;
      if (record.schemaVersion !== "workloom.delivery-evidence/v1" || record.status !== "passed"
        || recordScope?.tenantId !== scope.tenantId || recordScope?.workspaceId !== scope.workspaceId
        || record.projectId !== payload.projectId || record.revision !== payload.revision
        || record.artifactRef !== check.artifactRef || record.artifactSha256 !== boundHash || record.checkId !== check.id
        || typeof record.receiptId !== "string" || !record.receiptId.trim()
        || typeof record.method !== "string" || !record.method.trim()
        || !record.observations || typeof record.observations !== "object" || Array.isArray(record.observations)
        || Object.keys(record.observations).length === 0) fail("交付检查证据缺少执行回执或作用域、版本、产物绑定不一致");
    }
    if (seen.size !== expectedKeys.size) fail("交付封签缺少必需检查");
    // Recheck the manifest after all file reads; a concurrent replacement cannot
    // inherit approval from the snapshot used at the beginning of the request.
    if (readDeliveryManifestFile(packageDir).sha256 !== manifestSha256) fail("交付清单在核验期间变化");
    return { status: "verified", reason: "服务端封签与当前产物、证据及固定检查集合一致", manifestSha256, revision, sealSha256: sealFile.sha256 };
  } catch (error) {
    return { status: "invalid", reason: error instanceof Error ? error.message : String(error), manifestSha256, revision, sealSha256: null };
  }
}
export function requireDeliveryTrust(packageDir: string, scope: DeliveryScope, env: NodeJS.ProcessEnv = process.env): DeliveryTrust {
  const trust = inspectDeliveryTrust(packageDir, scope, env);
  if (trust.status !== "verified") fail(`交付包尚未核实：${trust.reason}`);
  return trust;
}

/** Absolute internal callers must still enter the same scoped package store. */
export function assertScopedPackagePath(root: string, packageDir: string, scope: DeliveryScope): string {
  const scoped = scopedDeliveryRoot(root, scope);
  const rel = relative(scoped, resolve(packageDir));
  if (!rel || rel.includes(sep) || rel.startsWith(".")) fail("交付包不在当前租户或工作区", "scope_mismatch");
  safeDeliveryPath(resolve(root), relative(resolve(root), scoped).split(sep).join("/"));
  const safe = safeDeliveryPath(scoped, rel);
  if (!lstatSync(safe).isDirectory()) fail("交付包不是目录", "not_found");
  return safe;
}
