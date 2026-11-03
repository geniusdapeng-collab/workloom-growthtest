import { afterEach, describe, expect, it, vi } from "vitest";
import { ArkVideoProvider, HiggsfieldProvider, MuapiProvider } from "./providers.js";

const providers = [
  ["Ark", () => new ArkVideoProvider({ apiKey: "test-only-poll" })],
  ["Higgsfield", () => new HiggsfieldProvider({ keyId: "test-only-poll", keySecret: "test-only-poll" })],
  ["MuAPI", () => new MuapiProvider({ apiKey: "test-only-poll" })],
] as const;

afterEach(() => vi.unstubAllGlobals());

describe.each(providers)("%s polling preserves an already accepted task", (_name, make) => {
  it.each([401, 403, 404, 429, 500, 503])("HTTP %s is a failed lookup, not a provider task failure", async status => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("query unavailable", { status })));
    await expect(make().poll("accepted-task")).rejects.toMatchObject({ name: "ProviderError", acceptance: "unknown", fallbackAllowed: false });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(vi.mocked(fetch).mock.calls[0]?.[1]?.method).toBe("GET");
  });

  it.each(["not-json", "null", "[]", "{}", '{"status":"unexpected-new-state"}'])("unverified lookup body %s cannot become a terminal result", async text => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(text, { status: 200 })));
    await expect(make().poll("accepted-task")).rejects.toMatchObject({ name: "ProviderError", acceptance: "unknown", fallbackAllowed: false });
  });

  it("network failure keeps the existing task unverified without permitting resubmission", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("connection reset"); }));
    await expect(make().poll("accepted-task")).rejects.toMatchObject({ name: "ProviderError", acceptance: "unknown", fallbackAllowed: false });
  });

  it("treats task IDs as one opaque URL component", async () => {
    const seen: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async input => { seen.push(String(input)); return new Response('{"status":"queued"}'); }));
    await make().poll("task/part?key=value#fragment");
    expect(seen).toHaveLength(1);
    expect(seen[0]).toContain("task%2Fpart%3Fkey%3Dvalue%23fragment");
    expect(new URL(seen[0]!).search).toBe("");
    expect(new URL(seen[0]!).hash).toBe("");
  });
});

describe("documented provider terminal states and complete media results", () => {
  it.each([
    ["Ark queued", () => new ArkVideoProvider({ apiKey: "test-only" }), "queued", "submitted"],
    ["Ark running", () => new ArkVideoProvider({ apiKey: "test-only" }), "running", "running"],
    ["Higgsfield queued", () => new HiggsfieldProvider({ keyId: "test-only", keySecret: "test-only" }), "queued", "submitted"],
    ["Higgsfield in progress", () => new HiggsfieldProvider({ keyId: "test-only", keySecret: "test-only" }), "in_progress", "running"],
    ["MuAPI queued", () => new MuapiProvider({ apiKey: "test-only" }), "queued", "submitted"],
    ["MuAPI processing", () => new MuapiProvider({ apiKey: "test-only" }), "processing", "running"],
  ] as const)("%s remains nonterminal", async (_label, make, status, expected) => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ status }))));
    await expect(make().poll("accepted-task")).resolves.toEqual({ status: expected });
  });

  it.each([
    ["Ark expired", () => new ArkVideoProvider({ apiKey: "test-only" }), "expired"],
    ["Ark cancelled", () => new ArkVideoProvider({ apiKey: "test-only" }), "cancelled"],
    ["Higgsfield canceled", () => new HiggsfieldProvider({ keyId: "test-only", keySecret: "test-only" }), "canceled"],
    ["MuAPI cancelled", () => new MuapiProvider({ apiKey: "test-only" }), "cancelled"],
  ] as const)("%s is a real provider terminal failure", async (_label, make, status) => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ status }))));
    await expect(make().poll("accepted-task")).resolves.toMatchObject({ status: "failed" });
  });

  it.each([
    ["Ark", () => new ArkVideoProvider({ apiKey: "test-only" }), { status: "succeeded", content: { video_url: "https://cdn.example.test/real.mp4" } }],
    ["Higgsfield", () => new HiggsfieldProvider({ keyId: "test-only", keySecret: "test-only" }), { status: "completed", video: { url: "https://cdn.example.test/real.mp4" } }],
    ["MuAPI", () => new MuapiProvider({ apiKey: "test-only" }), { status: "completed", outputs: ["https://cdn.example.test/real.mp4"] }],
  ] as const)("%s retains valid completed outputs", async (_label, make, body) => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(body))));
    await expect(make().poll("accepted-task")).resolves.toMatchObject({ status: "succeeded", uri: "https://cdn.example.test/real.mp4" });
  });

  it.each([null, false, 42, {}, " "])("invalid media URI %s cannot be ingested", async uri => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ status: "succeeded", content: { video_url: uri } }))));
    await expect(new ArkVideoProvider({ apiKey: "test-only" }).poll("accepted-task")).rejects.toMatchObject({ name: "ProviderError", acceptance: "unknown" });
  });

  it.each([
    ["Ark", () => new ArkVideoProvider({ apiKey: "test-only" }), "succeeded"],
    ["Higgsfield", () => new HiggsfieldProvider({ keyId: "test-only", keySecret: "test-only" }), "completed"],
    ["MuAPI", () => new MuapiProvider({ apiKey: "test-only" }), "completed"],
  ] as const)("%s success without a media URI remains unverified", async (_label, make, status) => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ status }))));
    await expect(make().poll("accepted-task")).rejects.toMatchObject({ name: "ProviderError", acceptance: "unknown" });
  });

  it("Ark keeps the provider-reported video duration without inferring seconds from token usage", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ status: "succeeded", duration: 7,
      usage: { completion_tokens: 109586 }, content: { video_url: "https://cdn.example.test/real.mp4" } }))));
    await expect(new ArkVideoProvider({ apiKey: "test-only" }).poll("accepted-task")).resolves.toEqual({ status: "succeeded", uri: "https://cdn.example.test/real.mp4", actualUnits: 7 });
  });
});
