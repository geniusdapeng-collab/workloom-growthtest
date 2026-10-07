/** Current production CLI declarations and real child processes against loopback-only synthetic providers. */
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { runInNewContext } from "node:vm";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { generationRequestHash, isDefiniteGenerationRejection, readGenerationSubmissionState, submitGenerationOnce } from "./generation-submission.mjs";

const repo = fileURLToPath(new URL("../../../", import.meta.url));
const file = join(repo, "scripts/tools/portrait-set-from-asset.mts"), source = readFileSync(file, "utf8");
const sha = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
const originalHash = sha(source);
interface AstNode { name?: { text: string }; getFullText(source: AstSource): string }
interface AstSource { statements: ReadonlyArray<AstNode> }
interface Compiler {
  ScriptTarget: { Latest: number; ES2022: number }; ModuleKind: { CommonJS: number };
  createSourceFile(path: string, source: string, target: number, parents: boolean): AstSource;
  isFunctionDeclaration(node: AstNode): boolean;
  transpileModule(source: string, options: { compilerOptions: { target: number; module: number } }): { outputText: string };
}
const ts = createRequire(join(repo, "packages/video-studio/package.json"))("typescript") as Compiler;
const parsed = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
const names = new Set(["derivedSubmissionJournal", "canFallbackToVideo", "generateViaImage", "generateViaVideo"]);
const declarations = parsed.statements.filter(node => ts.isFunctionDeclaration(node) && node.name && names.has(node.name.text));
if (declarations.length !== names.size) throw new Error("DERIVED_FIXTURE_INVALID: current CLI declarations missing");
const compiled = ts.transpileModule(declarations.map(node => node.getFullText(parsed)).join("\n")
  + "\nexports.api = { generateViaImage, generateViaVideo, canFallbackToVideo };",
  { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;
interface Api {
  generateViaImage(prompt: string, referenceImages?: string[], key?: string): Promise<Buffer>;
  generateViaVideo(prompt: string, refs: string[], key?: string): Promise<Buffer>;
  canFallbackToVideo(error: unknown): boolean;
}
const roots: string[] = [], closers: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const close of closers.splice(0)) await close();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
afterAll(() => expect(sha(readFileSync(file)), "tested CLI must remain immutable during this run").toBe(originalHash));
function root() { const dir = mkdtempSync(join(tmpdir(), "wl-derived-once-")); roots.push(dir); return dir; }
async function wire(handle: (request: IncomingMessage, response: ServerResponse, count: number) => void) {
  const calls: Array<{ method?: string; url?: string; body: string }> = [];
  const server = createServer(async (request, response) => {
    let body = ""; for await (const chunk of request) body += chunk;
    calls.push({ method: request.method, url: request.url, body }); handle(request, response, calls.length);
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  closers.push(() => new Promise<void>((resolve, reject) => { server.close(error => error ? reject(error) : resolve()); server.closeAllConnections(); }));
  const address = server.address(); if (!address || typeof address === "string") throw new Error("loopback fixture unavailable");
  return { calls, url: `http://127.0.0.1:${address.port}` };
}
const reply = (response: ServerResponse, status: number, body: unknown) => { response.writeHead(status, { "content-type": "application/json" }); response.end(JSON.stringify(body)); };
function api(outDir: string, baseUrl: string): Api {
  const context = { exports: {} as { api: Api }, outDir, baseUrl, apiKey: "synthetic-only", model: "synthetic-image", env: {},
    characterId: "synthetic-character", assetRef: "asset://synthetic-only", anchorDataUrl: null, invalidAssetRefs: new Set<string>(),
    process: { env: { SEEDANCE_MODEL: "synthetic-video" } }, Buffer, Response, fetch, AbortSignal, console,
    arg: (_name: string, fallback: string) => fallback, join, existsSync, readFileSync, writeFileSync,
    generationRequestHash, isDefiniteGenerationRejection, readGenerationSubmissionState, submitGenerationOnce,
    setTimeout: (callback: () => void) => { callback(); return 0; },
    execFileSync: () => { throw new Error("no synthetic media is eligible for real frame extraction"); } };
  runInNewContext(compiled, context); return context.exports.api;
}
function child(dir: string, url: string, engine = "auto") {
  const library = join(dir, "library"), profile = join(library, "synthetic-character/profile.json"), keys = join(dir, "synthetic.env");
  mkdirSync(dirname(profile), { recursive: true }); writeFileSync(profile, '{"name":"Synthetic only"}\n'); writeFileSync(keys, `VOLCENGINE_ARK_API_KEY=synthetic-only\nARK_BASE_URL=${url}\nSEEDREAM_MODEL=synthetic-image\nSEEDANCE_MODEL=synthetic-video\n`);
  return new Promise<{ code: number | null; output: string }>((resolve, reject) => {
    const child = spawn(process.execPath, ["--import", "tsx", file, "--asset", "asset://synthetic-only", "--character", "synthetic-character",
      "--library", library, "--out-dir", join(dir, "outputs"), "--keys-file", keys, "--angles", "front", "--engine", engine],
    { cwd: repo, env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: dir } });
    let output = ""; const timer = setTimeout(() => { child.kill("SIGKILL"); reject(new Error("synthetic child timeout")); }, 15_000);
    child.stdout.on("data", data => { output += data; }); child.stderr.on("data", data => { output += data; });
    child.on("error", error => { clearTimeout(timer); reject(error); }); child.on("close", code => { clearTimeout(timer); resolve({ code, output }); });
  });
}

describe("肖像派生实际入口防重复付费", () => {
  it("accepted image download failure resumes its first URL across fresh VM callers", async () => {
    const dir = root();
    const w = await wire((request, response) => request.method === "POST" ? reply(response, 200, { data: [{ url: `${w.url}/image.png` }] }) : reply(response, 403, { error: "synthetic download denied" }));
    await expect(api(dir, w.url).generateViaImage("same", [], "side")).rejects.toThrow(/IMAGE_DOWNLOAD_FAILED/);
    await expect(api(dir, w.url).generateViaImage("same", [], "side")).rejects.toThrow(/IMAGE_DOWNLOAD_FAILED/);
    expect(w.calls.filter(call => call.method === "POST")).toHaveLength(1); expect(w.calls.filter(call => call.method === "GET")).toHaveLength(2);
    await expect(api(dir, w.url).generateViaImage("changed", [], "side")).rejects.toThrow(/REQUEST_CHANGED/);
    expect(w.calls.filter(call => call.method === "POST")).toHaveLength(1);
  });
  it("accepted video polling failure resumes its same task ID, including a previously rejected missing ref", async () => {
    const dir = root(); let posts = 0;
    const w = await wire((request, response) => {
      if (request.method === "POST") {
        posts += 1; return posts === 1 ? reply(response, 400, { error: { code: "InvalidParameter", message: "specified asset asset-invalid is not found" } })
          : reply(response, 200, { id: "synthetic-derived-task" });
      }
      reply(response, 403, { error: "synthetic poll denied" });
    });
    const refs = ["asset://asset-invalid", "asset://asset-valid"];
    await expect(api(dir, w.url).generateViaVideo("same", refs, "master-front")).rejects.toThrow(/VIDEO_POLL_FAILED/);
    await expect(api(dir, w.url).generateViaVideo("same", refs, "master-front")).rejects.toThrow(/VIDEO_POLL_FAILED/);
    expect(posts).toBe(2); expect(w.calls.filter(call => call.method === "GET").map(call => call.url)).toEqual(["/contents/generations/tasks/synthetic-derived-task", "/contents/generations/tasks/synthetic-derived-task"]);
    await expect(api(dir, w.url).generateViaVideo("changed", refs, "master-front")).rejects.toThrow(/REQUEST_CHANGED/); expect(posts).toBe(2);
  });
  it.each(["network", "server", "malformed"])("real CLI %s failure never retries image POST or falls back to video across processes", async mode => {
    const dir = root();
    const w = await wire((request, response) => {
      if (mode === "network") return request.socket.destroy();
      if (mode === "server") return reply(response, 503, { error: "unknown after acceptance" });
      response.end("{malformed");
    });
    expect((await child(dir, w.url)).code).not.toBe(0); expect((await child(dir, w.url)).code).not.toBe(0);
    expect(w.calls).toHaveLength(1); expect(w.calls[0]!.url).toBe("/images/generations");
  }, 20_000);
  it("real CLI accepted image download failure never starts a video fallback", async () => {
    const dir = root();
    const w = await wire((request, response) => request.method === "POST" ? reply(response, 200, { data: [{ url: `${w.url}/image.png` }] }) : reply(response, 403, { error: "synthetic download denied" }));
    expect((await child(dir, w.url)).code).not.toBe(0); expect((await child(dir, w.url)).code).not.toBe(0);
    expect(w.calls.filter(call => call.method === "POST").map(call => call.url)).toEqual(["/images/generations"]);
  }, 20_000);
  it("only structured unsupported asset 400 without an accepted output can authorize auto fallback", () => {
    const a = api(root(), "http://127.0.0.1:1");
    const allowed = { status: 400, body: JSON.stringify({ error: { code: "InvalidParameter", message: "asset:// reference not supported" } }) };
    expect(a.canFallbackToVideo(allowed)).toBe(true);
    for (const failure of [{ ...allowed, status: 503 }, { ...allowed, body: "asset:// unsupported" },
      { ...allowed, body: JSON.stringify({ id: "already-accepted", error: { code: "InvalidParameter", message: "asset:// unsupported" } }) },
      new Error("network timeout"), { ...allowed, body: JSON.stringify({ error: { code: "InvalidParameter", message: "bad size" } }) }]) expect(a.canFallbackToVideo(failure)).toBe(false);
  });
  it("legacy unjournaled master or angle files cannot authorize another paid POST", async () => {
    const dir = root(), w = await wire((_request, response) => reply(response, 200, {}));
    writeFileSync(join(dir, "_master-front.png"), "synthetic old unjournaled output");
    writeFileSync(join(dir, "synthetic-character-side.png"), "synthetic old unjournaled angle");
    await expect(api(dir, w.url).generateViaVideo("same", ["asset://synthetic-only"], "master-front")).rejects.toThrow(/LEGACY_SUBMISSION_UNKNOWN/);
    await expect(api(dir, w.url).generateViaImage("same", [], "side")).rejects.toThrow(/LEGACY_SUBMISSION_UNKNOWN/); expect(w.calls).toHaveLength(0);
  });
  it("an invalid task ID in a successful first response cannot trigger a new POST or unsafe poll", async () => {
    const dir = root(), w = await wire((_request, response) => reply(response, 200, { id: "../synthetic-other-task" }));
    for (let run = 0; run < 2; run += 1)
      await expect(api(dir, w.url).generateViaVideo("same", ["asset://synthetic-only"], "side")).rejects.toThrow(/ACCEPTED_TASK_INVALID/);
    expect(w.calls).toHaveLength(1); expect(w.calls[0]!.method).toBe("POST");
  });
});
