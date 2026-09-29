import { describe, expect, it } from "vitest";
import { FilmServiceClient, FilmServiceClientError, type FilmJobStatus } from "./film-service-client.js";

const hash = (char: string) => char.repeat(64);

function startReceipt(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    jobId: "FJ-1", projectId: "VID-1", attempt: 1, runId: "film-run-1", status: "running",
    inputSha256: hash("a"), workerEntrySha256: hash("b"), stages: ["plates", "videos"],
    startedAt: "2026-09-28T00:00:00.000Z", budgetCny: 12.5, ...overrides,
  };
}

function jobStatus(overrides: Partial<FilmJobStatus> = {}): FilmJobStatus {
  return {
    jobId: "FJ-1", projectId: "VID-1", attempt: 1, runId: "film-run-1", workerName: "full-chain-film",
    status: "running", stages: ["plates"], startedAt: "2026-09-28T00:00:00.000Z", finishedAt: null,
    errorClass: null, errorMessage: null, resultRef: null, resultSha256: null,
    components: [{ component: "image", stepKey: "plates:SC-01", shotId: "SC-01", state: "accepted", reservedCny: 0.3, actualCny: null, updatedAt: "2026-09-28T00:01:00.000Z" }],
    reservedCny: 0.3, spentCny: 0.3, ...overrides,
  };
}

function clientWith(handler: (route: string, body: unknown) => { status?: number; body: unknown }): { client: FilmServiceClient; calls: Array<{ route: string; init: RequestInit }> } {
  const calls: Array<{ route: string; init: RequestInit }> = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const route = url.split("/trpc/")[1]!.split("?")[0]!;
    calls.push({ route, init: init ?? {} });
    const body = init?.body ? JSON.parse(String(init.body)) : JSON.parse(decodeURIComponent(new URL(url).searchParams.get("input") ?? "{}"));
    const reply = handler(route, body);
    return new Response(JSON.stringify({ result: { data: reply.body } }), { status: reply.status ?? 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  return { client: new FilmServiceClient({ api: "http://127.0.0.1:8787", token: "test-only-workspace-token", fetchImpl }), calls };
}

describe("film-service-client（公开 CLI 只做提交与状态查询）", () => {
  it("拒绝非回环 http、带凭据 URL 与空 token", () => {
    expect(() => new FilmServiceClient({ api: "http://example.com", token: "x" })).toThrow(FilmServiceClientError);
    expect(() => new FilmServiceClient({ api: "https://user:pass@example.com", token: "x" })).toThrow(/不得携带凭据/);
    expect(() => new FilmServiceClient({ api: "http://127.0.0.1:8787/", token: "  " })).toThrow(/WORKLOOM_TOKEN/);
  });

  it("start 提交作业并校验回执身份与阶段清单", async () => {
    const { client, calls } = clientWith(() => ({ body: startReceipt() }));
    const receipt = await client.start({ projectId: "VID-1", workerName: "full-chain-film", document: { shots: [{ shotId: "SC-01" }] }, stages: ["plates", "videos"] });
    expect(receipt.jobId).toBe("FJ-1");
    expect(calls[0]!.route).toBe("video.film.start");
    expect(calls[0]!.init.method).toBe("POST");
    expect(JSON.parse(String(calls[0]!.init.body)).stages).toEqual(["plates", "videos"]);
  });

  it("start 拒绝被服务改写的阶段清单或畸形回执", async () => {
    const { client } = clientWith(() => ({ body: startReceipt({ stages: ["videos"] }) }));
    await expect(client.start({ projectId: "VID-1", workerName: "full-chain-film", document: {}, stages: ["plates", "videos"] }))
      .rejects.toMatchObject({ code: "START_RECEIPT_INVALID" });
    const { client: broken } = clientWith(() => ({ body: startReceipt({ inputSha256: "short" }) }));
    await expect(broken.start({ projectId: "VID-1", workerName: "full-chain-film", document: {}, stages: ["plates"] }))
      .rejects.toMatchObject({ code: "START_RECEIPT_INVALID" });
  });

  it("status 校验作业/组件回执；已完成作业必须有结果引用与摘要", async () => {
    const { client, calls } = clientWith(() => ({ body: jobStatus() }));
    await expect(client.status("FJ-1")).resolves.toMatchObject({ jobId: "FJ-1", status: "running" });
    expect(calls[0]!.route).toBe("video.film.status");
    const { client: badFinish } = clientWith(() => ({ body: jobStatus({ status: "finished", resultRef: null, resultSha256: null }) }));
    await expect(badFinish.status("FJ-1")).rejects.toMatchObject({ code: "STATUS_RECEIPT_INVALID" });
    const { client: badComponent } = clientWith(() => ({ body: jobStatus({ components: [{ component: "image", stepKey: "p", shotId: null, state: "whatever" as never, reservedCny: 0, actualCny: null, updatedAt: "x" }] }) }));
    await expect(badComponent.status("FJ-1")).rejects.toMatchObject({ code: "STATUS_RECEIPT_INVALID" });
  });

  it("服务拒绝与网络失败都按未核实处理，且不回显 token", async () => {
    const fetchImpl = (async () => new Response(JSON.stringify({ error: { message: "PRECONDITION_FAILED: 作业不存在 test-only-workspace-token" } }), { status: 412 })) as typeof fetch;
    const client = new FilmServiceClient({ api: "http://127.0.0.1:8787", token: "test-only-workspace-token", fetchImpl });
    await expect(client.status("FJ-1")).rejects.toMatchObject({ code: "SERVICE_REJECTED" });
    const failed = await client.status("FJ-1").catch((error: FilmServiceClientError) => error);
    expect(String(failed)).not.toContain("test-only-workspace-token");
    expect(String(failed)).toContain("[redacted]");
  });

  it("wait 轮询到终态后停止（不因超时自动重发）", async () => {
    let round = 0;
    const { client } = clientWith(() => {
      round += 1;
      return { body: jobStatus(round >= 3 ? { status: "finished", finishedAt: "2026-09-28T00:10:00.000Z", resultRef: "stages/film/attempt-1/film-result.json", resultSha256: hash("c") } : {}) };
    });
    const seen: string[] = [];
    const final = await client.wait("FJ-1", { pollRounds: 10, pollIntervalMs: 0, onProgress: (status) => { seen.push(status.status); } });
    expect(final.status).toBe("finished");
    expect(final.resultSha256).toBe(hash("c"));
    expect(seen).toEqual(["running", "running", "finished"]);
  });
});
