/** Actual tRPC middleware + delivery filesystem; authority lookup and unused DB handles are mocked. */
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Identity } from "@workloom/base/tenancy";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const authority = vi.hoisted(() => vi.fn());
vi.mock("../service/access-authority.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("../service/access-authority.js")>(), currentMemberAuthority: authority,
  resolveAuthoritativeClientAccess: async () => ({ navigationPermissions: ["ai-video.media.read"] }),
}));
vi.mock("@workloom/db", async (importOriginal) => ({
  ...await importOriginal<typeof import("@workloom/db")>(),
  getAppPool: () => ({}), getGatewayPool: () => ({}),
}));
import { videoRouter } from "./router.js";
import { readDeliveryPackage, startDeliveryRevision } from "./delivery.js";
import { scopedDeliveryRoot } from "./delivery-trust.js";
import { seedTestPackage, writeFixtureJson, TEST_DELIVERY_SECRET } from "./delivery-fixture.test-support.js";

const owner: Identity = { kind: "member", memberId: "owner", memberNo: "MEM-OWNER", name: "Owner", role: "owner", plan: "pro", tenantId: "tenant-router", workspaceId: "ws-router" };
const scope = { tenantId: owner.tenantId, workspaceId: owner.workspaceId };
const caller = (identity: Identity | null = owner) => videoRouter.createCaller({ identity, session: identity, partnerIdentity: null, headers: new Headers() }).delivery;
const mediaCaller = (identity: Identity | null = owner) => videoRouter.createCaller({ identity, session: identity, partnerIdentity: null, headers: new Headers() }).media;
let root: string;
let pkg: string;
let previous: NodeJS.ProcessEnv;
const expectedBase = () => {
  const base = readDeliveryPackage("PKG-1", scope).revisionBase!;
  return { expectedVersion: base.version, expectedProjectSha256: base.projectSha256 };
};
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "delivery-router-"));
  previous = Object.fromEntries(["WORKLOOM_DELIVERY_DIR", "WORKLOOM_DELIVERY_SIGNING_SECRET", "WORKLOOM_POST_BRIDGE_CLI"].map((key) => [key, process.env[key]]));
  process.env.WORKLOOM_DELIVERY_DIR = root;
  process.env.WORKLOOM_DELIVERY_SIGNING_SECRET = TEST_DELIVERY_SECRET;
  pkg = join(scopedDeliveryRoot(root, scope), "PKG-1");
  seedTestPackage(pkg, scope);
  writeFixtureJson(join(pkg, "film-project.json"), { ...JSON.parse(readFileSync(join(pkg, "film-project.json"), "utf8")), schemaVersion: "workloom.film-project/v1" });
  authority.mockReset().mockImplementation(async (identity) => ({ identity, permissions: {} }));
});
afterEach(() => {
  for (const [key, value] of Object.entries(previous)) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
  rmSync(root, { recursive: true, force: true });
});

describe("delivery routes derive scope from the authenticated identity", () => {
  it("own package is visible and downloadable through actual route handlers", async () => {
    expect(await caller().list({ limit: 20 })).toHaveLength(1);
    expect(await caller().get({ dir: "PKG-1" })).toMatchObject({ projectId: "P1", passed: true });
    const artifact = await caller().artifact({ dir: "PKG-1", ref: "master.mp4" });
    expect(Buffer.from(artifact.base64, "base64")).toEqual(readFileSync(join(pkg, "master.mp4")));
  });
  it.each([{ workspaceId: "other-workspace" }, { tenantId: "other-tenant" }])("all package routes isolate %j", async (changed) => {
    const other = caller({ ...owner, ...changed });
    expect(await other.list({ limit: 20 })).toEqual([]);
    await expect(other.get({ dir: "PKG-1" })).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(other.artifact({ dir: "PKG-1", ref: "master.mp4" })).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(other.selectVariant({ dir: "PKG-1", variantId: "a" })).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(other.triage({ dir: "PKG-1", feedback: "修改字幕", record: true })).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(other.startRevision({ ...expectedBase(), dir: "PKG-1", patch: { copy: { title: "test" } } })).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(await other.job({ jobId: "unknown" })).toBeNull();
    expect(await other.jobs({ dir: "PKG-1" })).toEqual([]);
  });
  it("ignores forged tenant/workspace fields in client input", async () => {
    const other = caller({ ...owner, workspaceId: "other" });
    await expect(other.get({ dir: "PKG-1", scope, tenantId: owner.tenantId, workspaceId: owner.workspaceId } as never))
      .rejects.toMatchObject({ code: "NOT_FOUND" });
  });
  it("blocks unauthenticated reads and readonly writes before filesystem mutations", async () => {
    await expect(caller(null).list({ limit: 20 })).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    await expect(caller(null).artifact({ dir: "PKG-1", ref: "master.mp4" })).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    const readOnly = caller({ ...owner, role: "readonly" });
    await expect(readOnly.selectVariant({ dir: "PKG-1", variantId: "a" })).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(readOnly.triage({ dir: "PKG-1", feedback: "字幕", record: true })).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(readOnly.startRevision({ ...expectedBase(), dir: "PKG-1", patch: { copy: { title: "x" } } })).rejects.toMatchObject({ code: "FORBIDDEN" });
  });
  it("draft packages return a business rejection on selection", async () => {
    rmSync(join(pkg, "delivery-seal.json"));
    await expect(caller().selectVariant({ dir: "PKG-1", variantId: "a" })).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
  });
  it("media ingestion rejects drafts, escaping paths and other scopes with business codes before DB writes", async () => {
    rmSync(join(pkg, "delivery-seal.json"));
    await expect(mediaCaller().ingestDelivery({ dir: "PKG-1" })).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
    await expect(mediaCaller().ingestDelivery({ dir: "../PKG-1" })).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(mediaCaller({ ...owner, workspaceId: "other" }).ingestDelivery({ dir: "PKG-1" })).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(mediaCaller({ ...owner, tenantId: "other" }).ingestDelivery({ dir: "PKG-1" })).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
  it("media ingestion requires both authentication and workspace write access", async () => {
    await expect(mediaCaller(null).ingestDelivery({ dir: "PKG-1" })).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    await expect(mediaCaller({ ...owner, role: "readonly" }).ingestDelivery({ dir: "PKG-1" })).rejects.toMatchObject({ code: "FORBIDDEN" });
  });
  it("isolates real revision job IDs and never notifies completion after failed exit", async () => {
    const cli = join(root, "test-revision-cli.mjs");
    const release = join(root, "release-test-revision");
    writeFileSync(cli, `import { existsSync } from "node:fs"; console.log("返修完成：v2 → /fake"); setInterval(() => { if (existsSync(${JSON.stringify(release)})) process.exit(2); }, 20);`);
    process.env.WORKLOOM_POST_BRIDGE_CLI = cli;
    const completed = vi.fn();
    const job = await startDeliveryRevision({ ...expectedBase(), dir: "PKG-1", patch: { copy: { title: "test" } }, scope, onCompleted: completed });
    expect(await caller().job({ jobId: job.jobId })).toMatchObject({ jobId: job.jobId });
    const other = caller({ ...owner, tenantId: "other" });
    expect(await other.job({ jobId: job.jobId })).toBeNull();
    expect(await other.jobs({ dir: "PKG-1" })).toEqual([]);
    expect((await caller().jobs({ dir: "PKG-1" })).some((row) => row.jobId === job.jobId)).toBe(true);
    try {
      await vi.waitFor(() => expect(job.logTail.some((line) => line.includes("返修完成"))).toBe(true), { timeout: 10_000 });
      expect(job.status).toBe("running");
    } finally {
      writeFileSync(release, "release");
    }
    await vi.waitFor(() => expect(job.status).toBe("failed"), { timeout: 10_000 });
    expect(job.exitCode).toBe(2);
    expect(completed).not.toHaveBeenCalled();
  }, 30_000);
});


describe("返修路由版本前置条件", () => {
  it("页面 get 的旧快照遇到 v2 时返回 CONFLICT，并且没有启动作业", async () => {
    const detail = await caller().get({ dir: "PKG-1" });
    const base = detail.revisionBase!;
    const project = JSON.parse(readFileSync(join(pkg, "film-project.json"), "utf8"));
    writeFixtureJson(join(pkg, "versions", "v2", "film-project.json"), { ...project, version: 2 });
    await expect(caller().startRevision({ dir: "PKG-1", patch: { copy: { title: "old page" } }, expectedVersion: base.version, expectedProjectSha256: base.projectSha256 }))
      .rejects.toMatchObject({ code: "CONFLICT" });
    expect(existsSync(join(pkg, "revision-jobs"))).toBe(false);
  });
  it("缺少版本前置条件的旧客户端返回 BAD_REQUEST", async () => {
    await expect(caller().startRevision({ dir: "PKG-1", patch: { copy: { title: "old client" } } } as never))
      .rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect(existsSync(join(pkg, "revision-jobs"))).toBe(false);
  });
  it("服务将用户读取的两个前置条件原样交给真实 CLI 子进程", async () => {
    const cli = join(root, "capture-revision-cli.mjs");
    const captured = join(root, "captured-args.json");
    writeFileSync(cli, `import fs from "node:fs"; fs.writeFileSync(${JSON.stringify(captured)}, JSON.stringify(process.argv.slice(2)));`);
    process.env.WORKLOOM_POST_BRIDGE_CLI = cli;
    const expected = expectedBase();
    const job = await startDeliveryRevision({ ...expected, dir: "PKG-1", patch: { copy: { title: "current page" } }, scope });
    await vi.waitFor(() => expect(job.status).toBe("done"), { timeout: 10_000 });
    const args = JSON.parse(readFileSync(captured, "utf8")) as string[];
    expect(args[args.indexOf("--expected-version") + 1]).toBe(String(expected.expectedVersion));
    expect(args[args.indexOf("--expected-project-sha256") + 1]).toBe(expected.expectedProjectSha256);
    expect(job).toMatchObject(expected);
  }, 30_000);
});
