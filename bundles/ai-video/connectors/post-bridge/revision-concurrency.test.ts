/** Real local files, real FFprobe and separate Node processes; no model/paid calls. */
import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { callTool, readRevisionBase, reedit, resolveBinaries } from "./core.mjs";
import { createPostBridgeExecutor } from "./executor.ts";

const bins = resolveBinaries();
const cli = fileURLToPath(new URL("./cli.mjs", import.meta.url));
let fixtureDir: string;
let fixture: string;
let root: string;
let projectPath: string;
const json = (file: string) => JSON.parse(fs.readFileSync(file, "utf8"));
const writeJson = (file: string, value: unknown) => fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
const expectBase = (file = projectPath) => {
  const base = readRevisionBase(file);
  return { expectedVersion: base.version, expectedProjectSha256: base.sha256 };
};
const revise = async (options: Record<string, unknown> = {}) => reedit({
  projectPath, deliveryDir: root, ...expectBase(), patch: { copy: { body: "revised" } }, bins, ...options,
});
function child(args: string[]) {
  return new Promise<{ code: number | null; output: string }>((resolve, reject) => {
    const process = spawn(globalThis.process.execPath, [cli, ...args], { stdio: ["ignore", "pipe", "pipe"] });
    const chunks: Buffer[] = [];
    process.stdout.on("data", (chunk: Buffer) => chunks.push(chunk));
    process.stderr.on("data", (chunk: Buffer) => chunks.push(chunk));
    process.on("error", reject);
    process.on("close", (code) => resolve({ code, output: Buffer.concat(chunks).toString("utf8") }));
  });
}

beforeAll(() => {
  fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), "revision-cas-media-"));
  fixture = path.join(fixtureDir, "source.mp4");
  execFileSync(bins.ffmpeg, ["-v", "error", "-y", "-f", "lavfi", "-i", "testsrc2=size=160x120:rate=12:duration=1",
    "-f", "lavfi", "-i", "sine=frequency=523:sample_rate=48000:duration=1", "-shortest",
    "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", "-c:a", "aac", fixture], { timeout: 30_000 });
  execFileSync(bins.ffprobe, ["-v", "error", "-show_format", fixture], { stdio: "ignore", timeout: 30_000 });
}, 60_000);
afterAll(() => { if (fixtureDir) fs.rmSync(fixtureDir, { recursive: true, force: true }); });
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "revision-cas-"));
  const video = path.join(root, "norm.mp4");
  fs.copyFileSync(fixture, video);
  fs.writeFileSync(path.join(root, "cover.png"), "test-only-cover-copy");
  const videoSha256 = createHash("sha256").update(fs.readFileSync(video)).digest("hex");
  const coverSha256 = createHash("sha256").update(fs.readFileSync(path.join(root, "cover.png"))).digest("hex");
  projectPath = path.join(root, "film-project.json");
  writeJson(projectPath, {
    schemaVersion: "workloom.film-project/v1", projectId: "cas-project", version: 1, resolution: [160, 120], fps: 12,
    layers: {
      shots: [{ shotId: "SC-01", source: "norm.mp4", normalised: "norm.mp4", sha256: videoSha256, sourceSha256: videoSha256, duration: 1 }],
      variants: [{ id: "warm-story", assembly: { path: "norm.mp4", sha256: videoSha256 }, color: { path: "norm.mp4", sha256: videoSha256 },
        artifacts: { video: { path: "norm.mp4", sha256: videoSha256 }, cover: { path: "cover.png", sha256: coverSha256 } } }],
      copy: { title: "test", hook: "test", body: "before" },
    },
  });
});
afterEach(() => { vi.restoreAllMocks(); if (root) fs.rmSync(root, { recursive: true, force: true }); });

describe("revision compare-and-swap and exclusive ownership", () => {
  it("requires exact expected version and digest before claiming output", async () => {
    for (const expected of [
      { expectedVersion: null }, { expectedProjectSha256: null }, { expectedVersion: 0 },
      { expectedVersion: Number.NaN }, { expectedVersion: 1.2 }, { expectedProjectSha256: "short" },
    ]) await expect(revise(expected)).rejects.toMatchObject({ code: "bad_request" });
    await expect(revise({ expectedVersion: 2 })).rejects.toMatchObject({ code: "revision_conflict" });
    await expect(revise({ expectedProjectSha256: "a".repeat(64) })).rejects.toMatchObject({ code: "revision_conflict" });
    expect(fs.existsSync(path.join(root, "versions"))).toBe(false);
    expect(fs.existsSync(path.join(root, ".revision.lock"))).toBe(false);
  });
  it("dry-run returns the exact write precondition without files or a lock", async () => {
    const plan = await reedit({ projectPath, patch: { copy: { title: "next" } }, dryRun: true });
    expect(plan).toMatchObject({ executed: false, dryRun: true, ...expectBase() });
    expect(fs.existsSync(path.join(root, "versions"))).toBe(false);
    expect(fs.existsSync(path.join(root, ".revision.lock"))).toBe(false);
  });
  it("one of two simultaneous real revisions wins; old bytes and the winner remain unchanged", async () => {
    const before = fs.readFileSync(projectPath);
    const results = await Promise.allSettled([revise(), revise()]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    const loser = results.find((result) => result.status === "rejected") as PromiseRejectedResult;
    expect(["revision_busy", "revision_conflict"]).toContain(loser.reason.code);
    const completed = results.find((result) => result.status === "fulfilled") as PromiseFulfilledResult<Awaited<ReturnType<typeof reedit>>>;
    expect(completed.value.version).toBe(2);
    expect(fs.readdirSync(path.join(root, "versions"))).toEqual(["v2"]);
    expect(fs.readFileSync(projectPath)).toEqual(before);
    const second = readRevisionBase(completed.value.projectPath);
    expect(json(completed.value.revisionPath).commit).toMatchObject({
      version: 2, baseVersion: 1, baseProjectSha256: expectBase().expectedProjectSha256, projectSha256: second.sha256,
    });
    await expect(revise()).rejects.toMatchObject({ code: "revision_conflict" });
    expect(readRevisionBase(completed.value.projectPath).sha256).toBe(second.sha256);
    expect(fs.existsSync(path.join(root, ".revision.lock"))).toBe(false);
  });
  it("separate CLI processes cannot both commit from the same base", async () => {
    const patchFile = path.join(root, "patch.json"); writeJson(patchFile, { copy: { title: "from process" } });
    const expected = expectBase();
    const args = ["reedit", "--project", projectPath, "--delivery-dir", root, "--patch", patchFile,
      "--expected-version", String(expected.expectedVersion), "--expected-project-sha256", expected.expectedProjectSha256];
    const results = await Promise.all([child(args), child(args)]);
    expect(results.map((result) => result.code).sort()).toEqual([0, 3]);
    expect(results.find((result) => result.code === 3)!.output).toMatch(/revision_busy|revision_conflict/);
    expect(fs.readdirSync(path.join(root, "versions"))).toEqual(["v2"]);
    expect(fs.existsSync(path.join(root, ".revision.lock"))).toBe(false);
  }, 30_000);
  it("a failed reservation is kept for audit and a retry consumes a fresh version", async () => {
    const project = json(projectPath);
    project.layers.variants[0].artifacts.video.path = "missing-video.mp4";
    writeJson(projectPath, project);
    await expect(revise()).rejects.toThrow();
    const failed = path.join(root, "versions", "v2");
    expect(json(path.join(failed, "revision-failed.json"))).toMatchObject({ schemaVersion: "workloom.delivery-revision-failure/v1", baseVersion: 1 });
    expect(fs.existsSync(path.join(failed, "film-project.json"))).toBe(false);
    expect(fs.existsSync(path.join(root, ".revision.lock"))).toBe(false);
    fs.copyFileSync(fixture, path.join(root, "missing-video.mp4"));
    const retry = await revise();
    expect(retry.version).toBe(3);
    expect(fs.existsSync(path.join(failed, "revision-failed.json"))).toBe(true);
    expect(json(retry.revisionPath).commit.baseVersion).toBe(1);
  });
  it("never overwrites a caller-selected old or escaping output directory", async () => {
    for (const outDir of [root, path.join(root, "variants"), path.join(root, "..", "escape")]) {
      await expect(revise({ outDir })).rejects.toMatchObject({ code: "revision_conflict" });
    }
    expect(fs.existsSync(path.join(root, "versions"))).toBe(false);
  });
  it("infers the package root on the next revision and keeps versions flat", async () => {
    const first = await revise();
    const second = await reedit({ projectPath: first.projectPath, ...expectBase(first.projectPath), patch: { copy: { body: "third" } }, bins });
    expect(second.targetDir).toBe(path.join(root, "versions", "v3"));
    expect(fs.existsSync(path.join(root, "versions", "v2", "versions"))).toBe(false);
  });
  it("detects a base mutation during the real copy and does not publish a success project", async () => {
    const original = fsp.copyFile.bind(fsp);
    let changed = false;
    vi.spyOn(fsp, "copyFile").mockImplementation(async (...args) => {
      if (!changed) { changed = true; const project = json(projectPath); project.title = "changed during render"; writeJson(projectPath, project); }
      return original(...args);
    });
    await expect(revise()).rejects.toMatchObject({ code: "revision_conflict" });
    expect(json(path.join(root, "versions", "v2", "revision-failed.json")).code).toBe("revision_conflict");
    expect(fs.existsSync(path.join(root, "versions", "v2", "film-project.json"))).toBe(false);
  });
  it("never releases or commits under a replacement lock belonging to another writer", async () => {
    const original = fsp.copyFile.bind(fsp);
    let changed = false;
    vi.spyOn(fsp, "copyFile").mockImplementation(async (...args) => {
      if (!changed) { changed = true; fs.unlinkSync(path.join(root, ".revision.lock")); writeJson(path.join(root, ".revision.lock"), { runId: "other-writer" }); }
      return original(...args);
    });
    await expect(revise()).rejects.toMatchObject({ code: "revision_conflict" });
    expect(json(path.join(root, ".revision.lock")).runId).toBe("other-writer");
    expect(fs.existsSync(path.join(root, "versions", "v2", "film-project.json"))).toBe(false);
  });
  it("does not steal a lock left by a terminated process", async () => {
    execFileSync(process.execPath, ["--input-type=module", "-e", `import fs from 'node:fs'; fs.writeFileSync(${JSON.stringify(path.join(root, ".revision.lock"))}, JSON.stringify({pid:process.pid,runId:'terminated-test-writer'}), {flag:'wx'});`]);
    await expect(revise()).rejects.toMatchObject({ code: "revision_busy" });
    expect(json(path.join(root, ".revision.lock")).runId).toBe("terminated-test-writer");
    expect(fs.existsSync(path.join(root, "versions"))).toBe(false);
  });
  it.each(["versions", "film-project.json"])('rejects symlinked %s before making a reservation', async (entry) => {
    const outside = path.join(fixtureDir, `link-target-${entry.replaceAll(".", "-")}`);
    if (entry === "versions") fs.mkdirSync(outside, { recursive: true });
    else { fs.copyFileSync(projectPath, outside); fs.rmSync(projectPath); }
    fs.symlinkSync(outside, path.join(root, entry), entry === "versions" ? "dir" : "file");
    await expect(revise()).rejects.toThrow();
    expect(fs.existsSync(path.join(root, ".revision.lock"))).toBe(false);
  });
  it("refuses mutation or missing commit evidence in a published version", async () => {
    const first = await revise();
    const good = fs.readFileSync(first.projectPath);
    const project = json(first.projectPath); project.title = "tampered"; writeJson(first.projectPath, project);
    await expect(revise({ projectPath: first.projectPath, ...expectBase(first.projectPath) })).rejects.toMatchObject({ code: "revision_conflict" });
    fs.writeFileSync(first.projectPath, good);
    fs.rmSync(first.revisionPath);
    await expect(revise({ projectPath: first.projectPath, ...expectBase(first.projectPath) })).rejects.toMatchObject({ code: "revision_conflict" });
  });
  it("maps lock permission errors to a stable failure without creating versions", async () => {
    const original = fs.openSync.bind(fs);
    vi.spyOn(fs, "openSync").mockImplementation(((file: fs.PathLike, flags: string | number, mode?: fs.Mode) => {
      if (String(file).endsWith(".revision.lock")) throw Object.assign(new Error("permission denied"), { code: "EACCES" });
      return original(file, flags, mode);
    }) as typeof fs.openSync);
    await expect(revise()).rejects.toMatchObject({ code: "revision_io_failed" });
    expect(fs.existsSync(path.join(root, "versions"))).toBe(false);
  });
  it("tool ingress requires preconditions and CLI rejects malformed explicit flags", async () => {
    await expect(callTool("postwrite.reedit", { project_path: projectPath, delivery_dir: root, patch: { copy: { body: "tool" } } }, { bins }))
      .rejects.toMatchObject({ code: "bad_request" });
    const expected = expectBase();
    const result = await callTool("postwrite.reedit", { project_path: projectPath, delivery_dir: root, patch: { copy: { body: "tool" } },
      expected_version: expected.expectedVersion, expected_project_sha256: expected.expectedProjectSha256 }, { bins });
    expect(result.result).toMatchObject({ executed: true, version: 2 });
    const patchFile = path.join(root, "patch.json"); writeJson(patchFile, { copy: { title: "bad flags" } });
    const malformed = await child(["reedit", "--project", projectPath, "--patch", patchFile, "--expected-version", "1"]);
    expect(malformed.code).toBe(3); expect(malformed.output).toContain("bad_request");
  }, 30_000);
  it.each(["revision_conflict", "revision_busy", "revision_io_failed"])("executor never retries %s on another endpoint", async (code) => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ ok: false, error: code, message: "conflict", retryable: true })));
    const executor = createPostBridgeExecutor({ baseUrl: ["http://first.invalid", "http://second.invalid"], token: "test-only-token", softFailures: false, fetchImpl });
    await expect(executor("postwrite.reedit", {})).rejects.toMatchObject({ code, retryable: false });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
  it("CLI dry-run exposes the chosen snapshot and never silently follows a newer version", async () => {
    const patchFile = path.join(root, "patch.json"); writeJson(patchFile, { copy: { title: "cli" } });
    const args = ["reedit", "--project", projectPath, "--patch", patchFile];
    const plan = await child([...args, "--dry-run"]);
    expect(plan.code).toBe(0);
    expect(JSON.parse(plan.output.split("\n")[0]!)).toEqual(expectBase());
    expect(fs.existsSync(path.join(root, "versions"))).toBe(false);
    await revise();
    const stale = await child(args);
    expect(stale.code).toBe(3);
    expect(stale.output).toContain("revision_conflict");
    expect(fs.readdirSync(path.join(root, "versions"))).toEqual(["v2"]);
  }, 30_000);
});
