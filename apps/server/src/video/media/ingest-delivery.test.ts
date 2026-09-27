import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { deliverySha256, scopedDeliveryRoot } from "../delivery-trust.js";
import { seedTestPackage, TEST_DELIVERY_SECRET } from "../delivery-fixture.test-support.js";

const state = vi.hoisted(() => ({
  copyMode: "" as "" | "source" | "destination", register: vi.fn(), columns: vi.fn(),
}));
vi.mock("@workloom/base/asset-cms", () => ({ register: state.register }));
vi.mock("./columns.js", () => ({ applyMediaColumns: state.columns }));
vi.mock("./ffmpeg.js", () => ({
  probeMedia: async () => ({ durationSeconds: null, width: null, height: null }),
  extractThumbnail: async () => ({ ok: false, error: "test fixture has no real video" }),
}));
vi.mock("node:fs/promises", async (importOriginal) => {
  const original = await importOriginal<typeof import("node:fs/promises")>();
  const fs = await import("node:fs");
  return { ...original, copyFile: async (...args: Parameters<typeof original.copyFile>) => {
    await original.copyFile(...args);
    if (state.copyMode === "source") fs.writeFileSync(args[0], "mutated source while copying");
    if (state.copyMode === "destination") fs.writeFileSync(args[1], "mutated copy while copying");
  } };
});
const { ingestDeliveryPackage } = await import("./ingest-delivery.js");
const { registerLocalAsset, mediaRelPathFor } = await import("./register-local.js");
const scope = { tenantId: "tenant-ingest", workspaceId: "ws-ingest" };
let root: string;
let pkg: string;
let env: NodeJS.ProcessEnv;
let previousMediaDir: string | undefined;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "delivery-ingest-"));
  pkg = join(scopedDeliveryRoot(join(root, "delivery"), scope), "PKG-1");
  seedTestPackage(pkg, scope);
  previousMediaDir = process.env.WORKLOOM_MEDIA_DIR;
  process.env.WORKLOOM_MEDIA_DIR = join(root, "media");
  env = { WORKLOOM_DELIVERY_DIR: join(root, "delivery"), WORKLOOM_DELIVERY_SIGNING_SECRET: TEST_DELIVERY_SECRET };
  state.copyMode = "";
  state.register.mockReset().mockImplementation(async (_app, _gateway, _scope, input) => ({ asset: { id: input.id }, deduped: false }));
  state.columns.mockReset().mockResolvedValue(undefined);
});
afterEach(() => {
  if (previousMediaDir === undefined) delete process.env.WORKLOOM_MEDIA_DIR;
  else process.env.WORKLOOM_MEDIA_DIR = previousMediaDir;
  rmSync(root, { recursive: true, force: true });
});
const ingest = (overrides = {}) => ingestDeliveryPackage(null as never, null as never, scope, { dir: pkg, by: "test", env, ...overrides });
const source = () => join(pkg, "master.mp4");
const register = (overrides = {}) => registerLocalAsset(null as never, null as never, scope, {
  absPath: source(), expectedSha256: deliverySha256(readFileSync(source())), expectedRealPath: realpathSync(source()),
  kind: "final_cut", by: "test", probe: false, thumbnail: false, ...overrides,
});

describe("sealed delivery to actual media copy", () => {
  it("copies each verified asset, then registers generated provenance bound to the seal", async () => {
    const result = await ingest();
    expect(result.errors).toEqual([]);
    expect(result.registered).toHaveLength(7);
    for (const call of state.register.mock.calls) {
      const input = call[3];
      expect(input.provenance).toMatchObject({ composedFrom: "delivery", revision: 1, source: "generated" });
      expect(input.provenance.sealSha256).toMatch(/^[a-f0-9]{64}$/);
      expect(deliverySha256(readFileSync(join(process.env.WORKLOOM_MEDIA_DIR!, input.meta.localPath)))).toBe(input.sha256);
    }
  });
  it("does not call the DB for unsigned, tampered, cross-scope or wrong-project packages", async () => {
    await expect(ingest({ projectId: "P2" })).rejects.toThrow(/项目/);
    await expect(ingestDeliveryPackage(null as never, null as never, { ...scope, tenantId: "other" }, { dir: pkg, by: "test", env })).rejects.toThrow(/工作区/);
    rmSync(join(pkg, "delivery-seal.json"));
    await expect(ingest()).rejects.toThrow(/尚未核实/);
    seedTestPackage(pkg, scope);
    writeFileSync(join(pkg, "variants/c/cover.png"), "changed");
    await expect(ingest()).rejects.toThrow(/尚未核实/);
    expect(state.register).not.toHaveBeenCalled();
  });
  it("reports a database failure honestly and stops later registration", async () => {
    state.register.mockRejectedValueOnce(new Error("database unavailable"));
    const result = await ingest();
    expect(result.registered).toEqual([]);
    expect(result.errors).toEqual(["master：database unavailable"]);
    expect(state.register).toHaveBeenCalledTimes(1);
  });
  it.each(["source", "destination"] as const)("rejects %s mutation during actual copy before registration", async (mode) => {
    state.copyMode = mode;
    const result = await ingest();
    expect(result.registered).toEqual([]);
    expect(result.errors[0]).toMatch(/期间变化|拷贝后指纹不一致/);
    expect(state.register).not.toHaveBeenCalled();
  });
});

describe("registerLocalAsset content-addressed copy", () => {
  it("rejects expected hash or realpath mismatch before database calls", async () => {
    await expect(register({ expectedSha256: "a".repeat(64) })).rejects.toThrow(/指纹/);
    await expect(register({ expectedRealPath: "/another/master.mp4" })).rejects.toThrow(/realpath/);
    expect(state.register).not.toHaveBeenCalled();
  });
  it("detects and repairs an existing same-size corrupt target, then verifies its bytes", async () => {
    const hash = deliverySha256(readFileSync(source()));
    const target = join(process.env.WORKLOOM_MEDIA_DIR!, mediaRelPathFor("final_cut", scope.workspaceId, hash, source()));
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, Buffer.alloc(readFileSync(source()).length, 120));
    await register();
    expect(readFileSync(target)).toEqual(readFileSync(source()));
    expect(state.register).toHaveBeenCalledTimes(1);
  });
  it("rejects symlink source and symlink media target even when bytes match", async () => {
    const alias = join(pkg, "alias.mp4");
    symlinkSync(source(), alias);
    await expect(register({ absPath: alias })).rejects.toThrow(/realpath/);
    const hash = deliverySha256(readFileSync(source()));
    const target = join(process.env.WORKLOOM_MEDIA_DIR!, mediaRelPathFor("final_cut", scope.workspaceId, hash, source()));
    mkdirSync(dirname(target), { recursive: true }); symlinkSync(source(), target);
    await expect(register()).rejects.toThrow(/符号链接/);
    expect(state.register).not.toHaveBeenCalled();
  });
  it.each([
    { project_id: "other-project", source_type: "generated" },
    { project_id: "P1", source_type: "uploaded" },
  ])("does not relabel an existing content asset's project or origin: %j", async (existing) => {
    state.register.mockResolvedValueOnce({ asset: { id: "prior", ...existing }, deduped: true });
    await expect(register({ projectId: "P1" })).rejects.toThrow(/其他项目或来源/);
    expect(state.columns).not.toHaveBeenCalled();
  });
  it("does not accept empty files", async () => {
    writeFileSync(source(), "");
    await expect(register()).rejects.toThrow(/非空文件/);
  });
});
