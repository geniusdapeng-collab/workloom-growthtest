import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  canonicalDeliveryJson, deliverySha256, inspectDeliveryTrust, inspectRegisteredDeliveryArtifact,
  readDeliveryManifestFile, requireDeliveryTrust, scopedDeliveryRoot, type DeliverySealPayload,
} from "./delivery-trust.js";
import {
  deliveryJobStatus, listDeliveryJobs, listDeliveryPackages, readDeliveryArtifact,
  readDeliveryPackage, recordRevisionRequest, resolvePackageDir, selectDeliveryVariant,
  startDeliveryRevision, triageDeliveryFeedback,
} from "./delivery.js";
import { seedTestPackage, sealTestPackage, TEST_DELIVERY_SECRET, writeFixtureJson, writeTestSeal } from "./delivery-fixture.test-support.js";

const scope = { tenantId: "tenant-A", workspaceId: "workspace-A", projectId: "P1" };
let root: string;
let pkg: string;
let env: NodeJS.ProcessEnv;
const payload = (): DeliverySealPayload => JSON.parse(readFileSync(join(pkg, "delivery-seal.json"), "utf8")).payload;
const verdict = () => inspectDeliveryTrust(pkg, scope, env);
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "delivery-trust-"));
  pkg = join(scopedDeliveryRoot(root, scope), "PKG-1");
  seedTestPackage(pkg, scope);
  env = { WORKLOOM_DELIVERY_DIR: root, WORKLOOM_DELIVERY_SIGNING_SECRET: TEST_DELIVERY_SECRET };
});
afterEach(() => { rmSync(root, { recursive: true, force: true }); });

describe("service seal and real bytes", () => {
  it("accepts a complete internal test authority receipt and records exact selection identity", () => {
    expect(verdict().status).toBe("verified");
    const selection = selectDeliveryVariant({ dir: "PKG-1", variantId: "a", scope, env });
    expect(selection).toMatchObject({ projectId: "P1", revision: 1 });
    expect(selection.variantSha256).toBe(deliverySha256("test video a P1"));
    expect(selection.manifestSha256).toBe(readDeliveryManifestFile(pkg).sha256);
    expect(selection.sealSha256).toBe(deliverySha256(readFileSync(join(pkg, "delivery-seal.json"))));
  });
  it("does not carry a previous selection across a replacement authority seal", () => {
    selectDeliveryVariant({ dir: "PKG-1", variantId: "a", scope, env });
    expect(readDeliveryPackage("PKG-1", scope, env).selectedVariantId).toBe("a");
    const next = payload();
    next.expiresAt = new Date(Date.parse(next.expiresAt) + 60_000).toISOString();
    writeTestSeal(pkg, next);
    expect(verdict().status).toBe("verified");
    expect(readDeliveryPackage("PKG-1", scope, env).selectedVariantId).toBeNull();
    expect(listDeliveryPackages({ scope, env })[0]!.selectedVariantId).toBeNull();
    selectDeliveryVariant({ dir: "PKG-1", variantId: "b", scope, env });
    expect(readDeliveryPackage("PKG-1", scope, env).selectedVariantId).toBe("b");
  });
  it("keeps unsigned packages draft even with every caller check marked true", () => {
    rmSync(join(pkg, "delivery-seal.json"));
    expect(verdict().status).toBe("draft");
    expect(readDeliveryPackage("PKG-1", scope, env)).toMatchObject({ passed: false, trustStatus: "draft" });
    expect(() => selectDeliveryVariant({ dir: "PKG-1", variantId: "a", scope, env })).toThrow(/尚未核实/);
    expect(readDeliveryArtifact({ dir: "PKG-1", ref: "master.mp4", scope, env }).bytes).toBeGreaterThan(0);
  });
  it.each([undefined, "short", "x".repeat(40)])("rejects missing, short or different server secret %s", (secret) => {
    expect(inspectDeliveryTrust(pkg, scope, { ...env, WORKLOOM_DELIVERY_SIGNING_SECRET: secret }).status).toBe("invalid");
  });
  it("rejects a caller-crafted signature", () => {
    const seal = JSON.parse(readFileSync(join(pkg, "delivery-seal.json"), "utf8"));
    seal.signature = "a".repeat(64);
    writeFixtureJson(join(pkg, "delivery-seal.json"), seal);
    expect(verdict().reason).toMatch(/签名不匹配/);
  });
  it("rejects manifest mutation and same-size media replacement", () => {
    writeFileSync(join(pkg, "master.mp4"), "fake master P1");
    expect(verdict().status).toBe("invalid");
    expect(() => readDeliveryArtifact({ dir: "PKG-1", ref: "master.mp4", scope, env })).toThrow(/指纹不一致/);
    seedTestPackage(pkg, scope);
    const manifest = readDeliveryManifestFile(pkg).manifest;
    writeFixtureJson(join(pkg, "delivery-manifest.json"), { ...manifest, title: "mutated" });
    expect(verdict().reason).toMatch(/清单指纹/);
  });
  it.each([0, 1, 2])("cannot sign an incomplete required variant set (%s)", (count) => {
    const manifest = readDeliveryManifestFile(pkg).manifest;
    manifest.variants = manifest.variants!.slice(0, count);
    writeFixtureJson(join(pkg, "delivery-manifest.json"), manifest);
    sealTestPackage(pkg, scope);
    expect(verdict().reason).toMatch(/三支变体/);
  });
  it.each([{ checks: [] }, { checks: [{ kind: "foo" }] }, { checks: [{ kind: "foo", ok: false }] }])("does not treat absent or false manifest checks as approval %#", ({ checks }) => {
    const manifest = readDeliveryManifestFile(pkg).manifest;
    writeFixtureJson(join(pkg, "delivery-manifest.json"), { ...manifest, checks });
    sealTestPackage(pkg, scope);
    expect(verdict().reason).toMatch(/未显式通过/);
  });
  it.each([
    ["expiry", (p: DeliverySealPayload) => { p.expiresAt = new Date(Date.now() - 1000).toISOString(); }],
    ["future issue", (p: DeliverySealPayload) => { p.issuedAt = new Date(Date.now() + 120_000).toISOString(); }],
    ["revision", (p: DeliverySealPayload) => { p.revision += 1; }],
    ["project", (p: DeliverySealPayload) => { p.projectId = "P2"; }],
    ["tenant", (p: DeliverySealPayload) => { p.scope.tenantId = "tenant-B"; }],
    ["workspace", (p: DeliverySealPayload) => { p.scope.workspaceId = "workspace-B"; }],
    ["recipe", (p: DeliverySealPayload) => { p.recipeSha256 = ""; }],
    ["toolchain", (p: DeliverySealPayload) => { p.toolchainSha256 = ""; }],
    ["path", (p: DeliverySealPayload) => { p.packageRealPath = "/different"; }],
    ["artifact path", (p: DeliverySealPayload) => { p.artifacts[0]!.realpath = "/different/master.mp4"; }],
    ["artifact bytes", (p: DeliverySealPayload) => { p.artifacts[0]!.bytes += 1; }],
  ] as const)("rejects signed but inconsistent %s", (_label, mutate) => {
    const p = payload(); mutate(p); writeTestSeal(pkg, p);
    expect(verdict().status).toBe("invalid");
  });
  it.each([
    ["missing", (p: DeliverySealPayload) => { p.checks.pop(); }],
    ["duplicate", (p: DeliverySealPayload) => { p.checks.push(p.checks[0]!); }],
    ["failed", (p: DeliverySealPayload) => { p.checks[0]!.status = "failed" as never; }],
    ["unknown", (p: DeliverySealPayload) => { p.checks[0]!.id = "caller_approved"; }],
    ["wrong hash", (p: DeliverySealPayload) => { p.checks[0]!.artifactSha256 = "a".repeat(64); }],
  ] as const)("requires the complete fixed check set: %s", (_label, mutate) => {
    const p = payload(); mutate(p); writeTestSeal(pkg, p);
    expect(verdict().status).toBe("invalid");
  });
  it.each(["scope", "projectId", "revision", "artifactSha256", "artifactRef", "checkId", "receiptId", "observations"])("binds evidence %s even if an authority signed its bytes", (field) => {
    const p = payload();
    const check = p.checks[0]!;
    const file = join(pkg, check.evidence.ref);
    const record = JSON.parse(readFileSync(file, "utf8"));
    record[field] = field === "scope" ? { tenantId: "tenant-B", workspaceId: scope.workspaceId }
      : field === "observations" ? {} : field === "receiptId" ? "" : "wrong";
    writeFixtureJson(file, record);
    check.evidence.sha256 = deliverySha256(readFileSync(file));
    writeTestSeal(pkg, p);
    expect(verdict().reason).toMatch(/执行回执|绑定不一致/);
  });
  it("rejects evidence replacement after sealing", () => {
    writeFileSync(join(pkg, payload().checks[0]!.evidence.ref), "{}");
    expect(verdict().reason).toMatch(/证据指纹不一致/);
  });
  it("does not accept a byte-for-byte copied package under a different path", () => {
    const target = join(scopedDeliveryRoot(root, scope), "PKG-COPY");
    cpSync(pkg, target, { recursive: true });
    expect(inspectDeliveryTrust(target, scope, env).status).toBe("invalid");
  });
});

describe("scoped registered artifact access", () => {
  it.each([
    { ...scope, workspaceId: "other" }, { ...scope, tenantId: "other" }, { ...scope, projectId: "other" },
  ])("isolates every package API for %j", async (other) => {
    expect(listDeliveryPackages({ scope: other, env })).toEqual([]);
    expect(() => resolvePackageDir("PKG-1", other, env)).toThrow();
    expect(() => readDeliveryPackage("PKG-1", other, env)).toThrow();
    expect(() => readDeliveryArtifact({ dir: "PKG-1", ref: "master.mp4", scope: other, env })).toThrow();
    expect(() => selectDeliveryVariant({ dir: "PKG-1", variantId: "a", scope: other, env })).toThrow();
    expect(() => recordRevisionRequest({ dir: "PKG-1", feedback: "字幕", triage: {}, scope: other, env })).toThrow();
    await expect(startDeliveryRevision({ dir: "PKG-1", patch: { text: {} }, scope: other, env,
      expectedVersion: 1, expectedProjectSha256: deliverySha256(readFileSync(join(pkg, "film-project.json"))) })).rejects.toThrow();
    await expect(triageDeliveryFeedback("PKG-1", "字幕", other, env)).rejects.toThrow();
    expect(deliveryJobStatus("nonexistent", other)).toBeNull();
    expect(listDeliveryJobs(other)).toEqual([]);
  });
  it("rejects missing identity and copied conflicting ownership", () => {
    expect(() => listDeliveryPackages({ scope: undefined as never, env })).toThrow(/作用域/);
    expect(() => deliveryJobStatus("x", undefined as never)).toThrow(/作用域/);
    const manifest = readDeliveryManifestFile(pkg).manifest;
    writeFixtureJson(join(pkg, "delivery-manifest.json"), { ...manifest, scope: { ...scope, workspaceId: "other" } });
    expect(() => readDeliveryPackage("PKG-1", scope, env)).toThrow(/工作区/);
  });
  it.each(["delivery-seal.json", "film-project.json", "secret.txt", "../secret.txt", "/etc/passwd", "variants\\a\\video.mp4"])("refuses unregistered or escaping ref %s", (ref) => {
    writeFileSync(join(pkg, "secret.txt"), "secret");
    expect(() => readDeliveryArtifact({ dir: "PKG-1", ref, scope, env })).toThrow();
  });
  it("rejects artifact symlinks, including identical bytes", () => {
    const outside = join(root, "outside.mp4");
    writeFileSync(outside, readFileSync(join(pkg, "master.mp4")));
    rmSync(join(pkg, "master.mp4"));
    symlinkSync(outside, join(pkg, "master.mp4"));
    expect(() => readDeliveryArtifact({ dir: "PKG-1", ref: "master.mp4", scope, env })).toThrow(/符号链接/);
    expect(verdict().status).toBe("invalid");
  });
  it("rejects an intermediate-directory symlink even when its target bytes are identical", () => {
    const outside = join(root, "outside-variants");
    cpSync(join(pkg, "variants"), outside, { recursive: true });
    rmSync(join(pkg, "variants"), { recursive: true });
    symlinkSync(outside, join(pkg, "variants"), "dir");
    expect(() => readDeliveryArtifact({ dir: "PKG-1", ref: "variants/a/video.mp4", scope, env })).toThrow(/符号链接/);
    expect(() => selectDeliveryVariant({ dir: "PKG-1", variantId: "a", scope, env })).toThrow(/尚未核实/);
    expect(verdict().status).toBe("invalid");
  });
  it("rejects symlinked package roots and scope roots", () => {
    const alias = join(scopedDeliveryRoot(root, scope), "PKG-LINK");
    symlinkSync(pkg, alias, "dir");
    expect(() => resolvePackageDir("PKG-LINK", scope, env)).toThrow(/符号链接/);
    const outside = join(root, "outside");
    cpSync(pkg, join(outside, "PKG-1"), { recursive: true });
    rmSync(scopedDeliveryRoot(root, scope), { recursive: true });
    symlinkSync(outside, scopedDeliveryRoot(root, scope), "dir");
    expect(() => resolvePackageDir("PKG-1", scope, env)).toThrow(/符号链接/);
  });
  it("never serves an empty file or non-file as a registered artifact", () => {
    const manifest = readDeliveryManifestFile(pkg).manifest;
    writeFileSync(join(pkg, "master.mp4"), "");
    expect(() => inspectRegisteredDeliveryArtifact(pkg, manifest, "master.mp4")).toThrow(/非空文件/);
    rmSync(join(pkg, "master.mp4")); mkdirSync(join(pkg, "master.mp4"));
    expect(() => inspectRegisteredDeliveryArtifact(pkg, manifest, "master.mp4")).toThrow(/非空文件/);
  });
  it("canonical encoding is independent of key insertion order", () => {
    expect(canonicalDeliveryJson({ z: 1, a: { y: 2, x: 3 } })).toBe(canonicalDeliveryJson({ a: { x: 3, y: 2 }, z: 1 }));
    expect(() => requireDeliveryTrust(pkg, scope, {})).toThrow(/尚未核实/);
  });
});
