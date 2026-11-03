import { afterEach, describe, expect, it, vi } from "vitest";
import { JimengProvider, KlingProvider, SeedanceProvider } from "@workloom/base/model-router";
import { buildVideoGenPool } from "./providers.js";

const configured = () => buildVideoGenPool({ env: {
  KLING_API_KEY: "test-only-domestic-poll", JIMENG_API_KEY: "test-only-domestic-poll",
  WHITEBOARD_ENABLED: "0", TALKCRAFT_ENABLED: "0",
} });
const providers = [
  ["legacy Seedance", () => new SeedanceProvider({ apiKey: "test-only-domestic-poll" })],
  ["configured Kling", () => configured().get("kling")!],
  ["configured Jimeng", () => configured().get("jimeng")!],
] as const;

afterEach(() => vi.unstubAllGlobals());

describe.each(providers)("%s preserves an accepted task after an unverified lookup", (_name, make) => {
  it.each([401, 403, 404, 429, 500, 503])("HTTP %s cannot declare the accepted generation failed", async status => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("lookup unavailable", { status })));
    await expect(make().poll("accepted-task")).rejects.toMatchObject({ acceptance: "unknown", fallbackAllowed: false });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it.each(["null", "{}", "not-json"])("invalid task body %s cannot invent a terminal or progress state", async body => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(body)));
    await expect(make().poll("accepted-task")).rejects.toMatchObject({ acceptance: "unknown", fallbackAllowed: false });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("network failure remains an unverified lookup without permitting fallback", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("query connection lost"); }));
    await expect(make().poll("accepted-task")).rejects.toMatchObject({ acceptance: "unknown", fallbackAllowed: false });
  });
});

describe("documented domestic-provider snapshots", () => {
  it.each([
    ["Seedance queued", () => new SeedanceProvider({ apiKey: "test-only" }), { status: "queued" }, "submitted"],
    ["Seedance running", () => new SeedanceProvider({ apiKey: "test-only" }), { status: "running" }, "running"],
    ["Kling submitted", () => new KlingProvider({ apiKey: "test-only" }), { code: 0, data: { task_status: "submitted" } }, "submitted"],
    ["Kling processing", () => new KlingProvider({ apiKey: "test-only" }), { code: 0, data: { task_status: "processing" } }, "running"],
    ["Jimeng queued", () => new JimengProvider({ apiKey: "test-only" }), { code: 10000, data: { status: "in_queue" } }, "submitted"],
    ["Jimeng generating", () => new JimengProvider({ apiKey: "test-only" }), { code: 10000, data: { status: "generating" } }, "running"],
  ] as const)("%s retains nonterminal progress", async (_label, make, body, status) => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json(body)));
    await expect(make().poll("accepted-task")).resolves.toEqual({ status });
  });

  it.each([
    ["Seedance", () => new SeedanceProvider({ apiKey: "test-only" }), { status: "succeeded", content: { video_url: "https://cdn.example.test/real.mp4" } }],
    ["Kling", () => new KlingProvider({ apiKey: "test-only" }), { code: 0, data: { task_status: "succeed", task_result: { videos: [{ url: "https://cdn.example.test/real.mp4" }] } } }],
    ["Jimeng", () => new JimengProvider({ apiKey: "test-only" }), { code: 10000, data: { status: "done", video_url: "https://cdn.example.test/real.mp4" } }],
  ] as const)("%s retains valid completed media", async (_label, make, body) => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json(body)));
    await expect(make().poll("accepted-task")).resolves.toMatchObject({ status: "succeeded", uri: "https://cdn.example.test/real.mp4" });
  });

  it.each([
    ["Seedance missing result", () => new SeedanceProvider({ apiKey: "test-only" }), { status: "succeeded" }],
    ["Seedance unknown state", () => new SeedanceProvider({ apiKey: "test-only" }), { status: "new-state" }],
    ["Kling missing result", () => new KlingProvider({ apiKey: "test-only" }), { code: 0, data: { task_status: "succeed" } }],
    ["Kling failed lookup", () => new KlingProvider({ apiKey: "test-only" }), { code: 1100, message: "invalid credentials" }],
    ["Kling unknown state", () => new KlingProvider({ apiKey: "test-only" }), { code: 0, data: { task_status: "new-state" } }],
    ["Jimeng missing result", () => new JimengProvider({ apiKey: "test-only" }), { code: 10000, data: { status: "done" } }],
    ["Jimeng failed lookup", () => new JimengProvider({ apiKey: "test-only" }), { code: 50500, data: null, message: "internal error" }],
    ["Jimeng missing task", () => new JimengProvider({ apiKey: "test-only" }), { code: 10000, data: { status: "not_found" } }],
    ["Jimeng expired lookup", () => new JimengProvider({ apiKey: "test-only" }), { code: 10000, data: { status: "expired" } }],
    ["Jimeng unknown state", () => new JimengProvider({ apiKey: "test-only" }), { code: 10000, data: { status: "new-state" } }],
  ] as const)("%s cannot invent task progress or a deliverable", async (_label, make, body) => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json(body)));
    await expect(make().poll("accepted-task")).rejects.toMatchObject({ acceptance: "unknown", fallbackAllowed: false });
  });

  it.each([
    ["Seedance failed", () => new SeedanceProvider({ apiKey: "test-only" }), { status: "failed", error: { message: "provider task failed" } }],
    ["Seedance expired", () => new SeedanceProvider({ apiKey: "test-only" }), { status: "expired" }],
    ["Kling failed", () => new KlingProvider({ apiKey: "test-only" }), { code: 0, data: { task_status: "failed", task_status_msg: "provider task failed" } }],
  ] as const)("%s remains a verified task failure", async (_label, make, body) => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json(body)));
    await expect(make().poll("accepted-task")).resolves.toMatchObject({ status: "failed" });
  });

  it.each([["Seedance", SeedanceProvider], ["Kling", KlingProvider]] as const)("%s treats the task ID as one opaque path component", async (_label, Adapter) => {
    const requests: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async input => { requests.push(String(input)); return Response.json(Adapter === SeedanceProvider ? { status: "queued" } : { code: 0, data: { task_status: "submitted" } }); }));
    await new Adapter({ apiKey: "test-only" }).poll("task/a?x=y#z");
    expect(requests[0]).toContain("task%2Fa%3Fx%3Dy%23z"); expect(new URL(requests[0]!).search).toBe("");
  });
});
