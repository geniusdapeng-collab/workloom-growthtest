import { afterEach, describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ProductionClient, renderServiceProject, type ProductionProjectResult, type ServiceShotList } from "./production-client.js";
const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const dirs: string[] = [];
afterEach(() => { dirs.splice(0).forEach(dir => rmSync(dir, { recursive: true, force: true })); });
const digest = (text: string): string => createHash("sha256").update(text).digest("hex");
const token = "test-workspace-token-never-log";
const qualificationToken = "test-qualification-never-log";
type Call = { route: string; body: Record<string, unknown>; method: string; authorization: string | null };
type Hook = (call: Call, value: unknown) => unknown | Promise<unknown>;
function fixture(hook?: Hook) {
  const calls: Call[] = [];
  const source: ServiceShotList = { projectId: "P", sourceStageRunId: "RUN", sourceAttempt: 2, promptsSha256: digest("archive"),
    shots: [{ shotId: "S1", durationSec: 6, prompt: '完整原稿\n"特殊字符"，片尾事实', fields: { scene: "无人庭院空镜" }, promptSha256: digest('完整原稿\n"特殊字符"，片尾事实') }] };
  const handle = async (call: Call): Promise<unknown> => {
    calls.push(call);
    const shot = String(call.body.shotId ?? "S1");
    const defaults: Record<string, unknown> = {
      "video.production.shots": structuredClone(source),
      "video.gen.estimate": { allowed: true, estimate: { cny: 2.5 } },
      "video.production.qualifyShot": { qualificationId: `Q-${shot}`, qualificationToken, scriptId: `SCRIPT-${shot}`, scriptVersion: 1,
        modelId: "model", params: call.body.params, mode: "auto", requestHash: digest("request"), payloadHash: digest("payload"), promptSha256: source.shots.find(s => s.shotId === shot)?.promptSha256, expiresAt: "2100-01-01T00:00:00Z" },
      "video.render.submit": { jobId: "J-S1", taskId: "T-S1", mock: false, durationSec: 6 },
      "video.render.poll": { checked: 1 },
      "video.gen.jobs": [{ id: "J-S1", project_id: "P", script_id: "SCRIPT-S1", script_version: 1, task_id: "T-S1", status: "done", mock: false, asset_id: "A-S1", local_path: "/trusted/media/s1.mp4", actual_cny: 2.3 }],
      "video.gen.catalog": { models: [{ id: "model", name: "fixture" }] },
    };
    const value = defaults[call.route];
    if (value === undefined) throw new Error(`Unexpected route ${call.route}`);
    return hook ? await hook(call, value) : value;
  };
  const fetchImpl = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const url = new URL(String(input));
    const body = JSON.parse(init?.body ? String(init.body) : url.searchParams.get("input") ?? "{}");
    const value = await handle({ route: url.pathname.split("/").at(-1)!, body, method: init?.method ?? "GET", authorization: new Headers(init?.headers).get("authorization") });
    return value instanceof Response ? value : new Response(JSON.stringify({ result: { data: value } }));
  }) as typeof fetch;
  return { calls, source, handle, client: new ProductionClient({ api: "https://service.invalid", token, fetchImpl }) };
}
const run = (f: ReturnType<typeof fixture>, options: Partial<Parameters<typeof renderServiceProject>[0]> = {}) => renderServiceProject({ client: f.client, projectId: "P", modelId: "model", pollRounds: 1, pollIntervalMs: 0, wait: async () => undefined, ...options });

describe("service production client", () => {
  it("quotes before review, submits only qualification, and persists exact service revision without credentials", async () => {
    const f = fixture(); const snapshots: ProductionProjectResult[] = [];
    const result = await run(f, { params: { aspectRatio: "16:9", generateAudio: false }, onProgress: value => { snapshots.push(value); } });
    expect(result).toMatchObject({ status: "done", estimatedCny: 2.5, sourceAttempt: 2, shots: [{ seconds: 6, status: "done", scriptId: "SCRIPT-S1", actualCny: 2.3 }] });
    expect(f.calls.map(c => c.route)).toEqual(["video.production.shots", "video.gen.estimate", "video.production.qualifyShot", "video.production.shots", "video.render.submit", "video.render.poll", "video.gen.jobs"]);
    expect(f.calls.find(c => c.route.endsWith("qualifyShot"))!.body.params).toEqual({ durationSec: 6, aspectRatio: "16:9", generateAudio: false });
    expect(f.calls.find(c => c.route.endsWith("submit"))!.body).toEqual({ qualificationToken });
    expect(f.calls.every(c => c.authorization === `Bearer ${token}`)).toBe(true);
    expect(JSON.stringify(snapshots)).not.toContain(token); expect(JSON.stringify(snapshots)).not.toContain(qualificationToken);
    expect(snapshots.some(s => s.shots[0]!.status === "submitted")).toBe(true);
  });
  it.each(["http://public.example", "https://user:pass@example.com", "https://example.com/?secret=1"])("rejects unsafe credential endpoint %s", api => {
    expect(() => new ProductionClient({ api, token })).toThrow("API_ENDPOINT_INVALID");
  });
  it("requires auth and rejects invalid limits before contacting service", async () => {
    expect(() => new ProductionClient({ api: "http://127.0.0.1", token: "" })).toThrow("AUTH_REQUIRED");
    const f = fixture(); await expect(run(f, { pollRounds: -1 })).rejects.toThrow("LIMIT_INVALID"); expect(f.calls).toHaveLength(0);
    await expect(run(f, { params: { durationSec: 12 } })).rejects.toThrow("DURATION_SOURCE_REQUIRED");
  });
  it.each(["hash", "duplicate", "empty", "scope"])("refuses invalid current source %s before paid operations", async mode => {
    const f = fixture((_call, value) => value);
    if (mode === "hash") f.source.shots[0]!.prompt += "changed";
    if (mode === "duplicate") f.source.shots.push(structuredClone(f.source.shots[0]!));
    if (mode === "empty") f.source.shots = [];
    if (mode === "scope") f.source.projectId = "OTHER";
    await expect(run(f)).rejects.toThrow("SOURCE_INVALID"); expect(f.calls).toHaveLength(1);
  });
  it("does not turn an unknown or repeated --only into full-project generation", async () => {
    for (const only of [["GHOST"], ["S1", "S1"]]) {
      const f = fixture(); await expect(run(f, { only })).rejects.toThrow("SHOT_SCOPE_INVALID"); expect(f.calls).toHaveLength(1);
    }
  });
  it("budget denial or aggregate limit stops before any review or generation", async () => {
    const f = fixture(); await expect(run(f, { maxEstimatedCny: 2 })).rejects.toThrow("BUDGET_EXCEEDED");
    expect(f.calls.every(c => c.method === "GET")).toBe(true);
    const denied = fixture((c, value) => c.route.endsWith("estimate") ? { allowed: false, reason: "budget closed" } : value);
    await expect(run(denied)).rejects.toThrow("BUDGET_UNVERIFIED"); expect(denied.calls.every(c => c.method === "GET")).toBe(true);
  });
  it("missing estimates and malformed/HTTP errors never become implicit success", async () => {
    for (const response of [new Response("invalid"), new Response(JSON.stringify({ error: { message: "denied" } }), { status: 403 }), new Response(JSON.stringify({ result: {} }))]) {
      const f = fixture(() => response); await expect(run(f)).rejects.toThrow(); expect(f.calls).toHaveLength(1);
    }
    const f = fixture((c, v) => c.route.endsWith("estimate") ? { allowed: true } : v);
    await expect(run(f)).rejects.toThrow("BUDGET_UNVERIFIED");
  });
  it.each(["params", "promptSha256", "modelId", "requestHash"])("different qualification %s cannot be submitted", async key => {
    const f = fixture((c, value) => c.route.endsWith("qualifyShot") ? { ...(value as object), [key]: key === "params" ? { durationSec: 30 } : "wrong" } : value);
    const result = await run(f); expect(result.status).toBe("unverified"); expect(f.calls.some(c => c.route.endsWith("submit"))).toBe(false);
  });
  it("unknown submit outcome stops the batch without retry and redacts both credentials", async () => {
    const f = fixture((c, value) => { if (c.route.endsWith("submit")) throw new Error(`${token} ${qualificationToken}: socket lost`); return value; });
    const result = await run(f); expect(result.shots[0]!.status).toBe("unknown");
    expect(f.calls.filter(c => c.route.endsWith("submit"))).toHaveLength(1); expect(f.calls.some(c => c.route.endsWith("poll"))).toBe(false);
    expect(JSON.stringify(result)).not.toContain(token); expect(JSON.stringify(result)).not.toContain(qualificationToken);
  });
  it("same prompt in a newer preproduction attempt cannot be mislabeled as the quoted revision", async () => {
    const f = fixture((call, value) => { if (call.route.endsWith("qualifyShot")) { f.source.sourceAttempt += 1; f.source.sourceStageRunId = "NEW-RUN"; } return value; });
    const result = await run(f);
    expect(result.status).toBe("unverified"); expect(result.shots[0]!.error).toContain("SOURCE_CHANGED");
    expect(f.calls.some(c => c.route.endsWith("submit"))).toBe(false);
  });
  it("mock or malformed submission receipt cannot claim a real delivery", async () => {
    for (const reply of [{ jobId: "J-S1", taskId: "T-S1", mock: true, durationSec: 6 }, { jobId: "J-S1", mock: false, durationSec: 6 }]) {
      const f = fixture((c, value) => c.route.endsWith("submit") ? reply : value);
      expect((await run(f)).status).toBe("unverified"); expect(f.calls.filter(c => c.route.endsWith("submit"))).toHaveLength(1);
    }
  });
  it.each(["project_id", "script_id", "script_version", "task_id", "mock", "asset_id", "local_path"])("does not reuse a mismatched or incomplete job %s", async key => {
    const f = fixture((c, value) => c.route.endsWith("jobs") ? [{ ...(value as object[])[0], [key]: key === "script_version" ? 2 : key === "mock" ? true : key === "asset_id" || key === "local_path" ? null : "OTHER" }] : value);
    expect((await run(f)).status).toBe("unverified");
  });
  it("records failed and poll-limited jobs without resubmission", async () => {
    const failed = fixture((c, value) => c.route.endsWith("jobs") ? [{ ...(value as object[])[0], status: "failed" }] : value);
    expect((await run(failed)).status).toBe("failed");
    const timeout = fixture(); const r = await run(timeout, { pollRounds: 0 });
    expect(r).toMatchObject({ status: "unverified", shots: [{ status: "unknown" }] });
    expect(timeout.calls.filter(c => c.route.endsWith("submit"))).toHaveLength(1);
  });
  it("failed local persistence prevents starting paid work", async () => {
    const f = fixture(); await expect(run(f, { onProgress: () => { throw new Error("disk full"); } })).rejects.toThrow("disk full");
    expect(f.calls.every(c => c.method === "GET")).toBe(true);
  });
});

async function command(args: string[], api: string): Promise<{ code: number | null; output: string }> {
  return new Promise((resolveCommand, reject) => {
    const child = spawn(process.execPath, ["--import", "tsx", "scripts/tools/render-project.mts", ...args], {
      cwd: root, env: { ...process.env, WORKLOOM_API: api, WORKLOOM_TOKEN: token, ARK_API_KEY: "", VOLCENGINE_ARK_API_KEY: "" }, stdio: ["ignore", "pipe", "pipe"] });
    let output = ""; child.stdout.on("data", data => { output += data; }); child.stderr.on("data", data => { output += data; });
    child.on("error", reject); child.on("close", code => resolveCommand({ code, output }));
  });
}
describe("real render-project CLI over authenticated HTTP", () => {
  it("normal service entry uses only token submit, saves safe receipt, and never creates CMS or calls a provider", async () => {
    const f = fixture(); const server = createServer(async (req, res) => {
      try {
        const parts: Buffer[] = []; for await (const part of req) parts.push(Buffer.from(part));
        const url = new URL(req.url!, "http://127.0.0.1");
        const body = JSON.parse(parts.length ? Buffer.concat(parts).toString() : url.searchParams.get("input") ?? "{}");
        const value = await f.handle({ route: url.pathname.split("/").at(-1)!, body, method: req.method!, authorization: req.headers.authorization ?? null });
        res.setHeader("content-type", "application/json"); res.end(JSON.stringify({ result: { data: value } }));
      } catch (error) { res.statusCode = 500; res.end(JSON.stringify({ error: { message: String(error) } })); }
    });
    await new Promise<void>(resolveListen => server.listen(0, "127.0.0.1", resolveListen));
    const api = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    const dir = mkdtempSync(join(tmpdir(), "production-cli-")); dirs.push(dir); const summary = join(dir, "receipt.json");
    try {
      const result = await command(["--project", "P", "--model", "model", "--poll-rounds", "1", "--poll-interval-ms", "0", "--summary-out", summary], api);
      expect(result.code, result.output).toBe(0);
      const saved = readFileSync(summary, "utf8"); expect(JSON.parse(saved).status).toBe("done"); expect(saved).not.toContain(qualificationToken); expect(result.output).not.toContain(token);
      expect(f.calls.find(c => c.route.endsWith("submit"))!.body).toEqual({ qualificationToken });
      const count = f.calls.length;
      const rejected = await command(["--project", "P", "--model", "model", "--shots", "local.json"], api);
      expect(rejected.code).not.toBe(0); expect(rejected.output).toContain("LOCAL_PRODUCTION_OVERRIDE_REJECTED"); expect(f.calls).toHaveLength(count);
      const models = await command(["--list-models"], api); expect(models.code, models.output).toBe(0); expect(models.output).toContain('"model"');
    } finally { server.closeAllConnections(); await new Promise<void>((resolveClose, reject) => server.close(error => error ? reject(error) : resolveClose())); }
  }, 30_000);
});
