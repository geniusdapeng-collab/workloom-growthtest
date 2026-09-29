import { describe, expect, it } from "vitest";
import {
  FILM_CHANNEL_FRAME_LIMIT,
  FILM_CHANNEL_METHOD_COMPONENT,
  FilmChannelError,
  FilmWorkerChannel,
  decodeFilmChannelFrame,
  encodeFilmChannelFrame,
  filmCanonicalJson,
  filmRequestHash,
  parseFilmWorkerJobContext,
  processIpcTransport,
  type FilmChannelTransport,
} from "./film-worker-channel.js";

function memoryTransport(): FilmChannelTransport & { sent: string[]; deliver: (raw: string) => void } {
  const handlers: Array<(raw: unknown) => void> = [];
  return {
    sent: [],
    send(raw: string) {
      this.sent.push(raw);
    },
    subscribe(handler) {
      handlers.push(handler);
      return () => handlers.splice(handlers.indexOf(handler), 1);
    },
    deliver(raw: string) {
      for (const handler of [...handlers]) handler(raw);
    },
  };
}

describe("固定影片工位通道（T-2026-0927-0039）", () => {
  it("canonical JSON 与请求哈希稳定：键序无关、数组保序、拒绝非 JSON 值", () => {
    expect(filmCanonicalJson({ b: 1, a: [2, 1] })).toBe(filmCanonicalJson({ a: [2, 1], b: 1 }));
    expect(filmCanonicalJson({ a: [1, 2] })).not.toBe(filmCanonicalJson({ a: [2, 1] }));
    expect(() => filmCanonicalJson({ a: Number.NaN })).toThrow(FilmChannelError);
    // 对象里的 undefined 按键缺失处理（与 JSON.stringify 同口径）；数组里的 undefined 必须拒绝。
    expect(filmCanonicalJson({ a: undefined })).toBe(filmCanonicalJson({}));
    expect(() => filmCanonicalJson({ a: [undefined] })).toThrow(/undefined/);
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(() => filmCanonicalJson(cyclic)).toThrow(/循环/);
    const hash = filmRequestHash({ method: "image.generate", stepKey: "plates:SC-01", shotId: "SC-01", params: { size: "2048x1152" } });
    expect(hash).toMatch(/^[a-f0-9]{64}$/);
    expect(filmRequestHash({ method: "image.generate", stepKey: "plates:SC-01", shotId: "SC-01", params: { size: "2048x1152" } })).toBe(hash);
    expect(filmRequestHash({ method: "image.generate", stepKey: "plates:SC-01", shotId: "SC-01", params: { size: "1024x1024" } })).not.toBe(hash);
  });

  it("帧编解码拒绝未知类型与超限帧", () => {
    const frame = { kind: "film.event", event: "stage.started" } as const;
    expect(decodeFilmChannelFrame(encodeFilmChannelFrame(frame))).toEqual(frame);
    expect(() => decodeFilmChannelFrame("not-json")).toThrow(/合法 JSON/);
    expect(() => decodeFilmChannelFrame(JSON.stringify({ kind: "other" }))).toThrow(/未知的通道帧类型/);
    expect(() => encodeFilmChannelFrame({ kind: "film.event", event: "x".repeat(FILM_CHANNEL_FRAME_LIMIT) })).toThrow(/上限/);
  });

  it("调用携带方法/步骤/镜号/幂等键与请求哈希，并按响应还原结果", async () => {
    const transport = memoryTransport();
    const channel = new FilmWorkerChannel({ transport, timeoutMs: { "llm.chat": 5_000 } });
    const pending = channel.call("llm.chat", { stepKey: "cover:design", params: { prompt: "写封面设计稿" } });
    expect(transport.sent).toHaveLength(1);
    const frame = JSON.parse(transport.sent[0]!);
    expect(frame.kind).toBe("film.request");
    expect(frame.method).toBe("llm.chat");
    expect(frame.component).toBe(FILM_CHANNEL_METHOD_COMPONENT["llm.chat"]);
    expect(frame.stepKey).toBe("cover:design");
    expect(frame.shotId).toBeNull();
    expect(frame.idempotencyKey).toContain("llm.chat:cover:design");
    expect(frame.requestHash).toBe(filmRequestHash({ method: "llm.chat", stepKey: "cover:design", shotId: null, params: { prompt: "写封面设计稿" } }));
    transport.deliver(JSON.stringify({ kind: "film.response", id: frame.id, ok: true, result: { content: "{}" } }));
    await expect(pending).resolves.toEqual({ content: "{}" });
  });

  it("父服务拒绝时抛出带 code 的通道错误；未知方法直接拒绝", async () => {
    const transport = memoryTransport();
    const channel = new FilmWorkerChannel({ transport, timeoutMs: { "media.fetch": 5_000 } });
    const pending = channel.call("media.fetch", { stepKey: "plates:SC-02", params: { ref: "a.png", targetRef: "b.png" } });
    const frame = JSON.parse(transport.sent[0]!);
    transport.deliver(JSON.stringify({ kind: "film.response", id: frame.id, ok: false, error: { code: "STEP_OUT_OF_SCOPE", message: "步骤不在冻结阶段内" } }));
    await expect(pending).rejects.toMatchObject({ code: "STEP_OUT_OF_SCOPE" });
    await expect(channel.call("image.generate", { stepKey: "", params: {} })).rejects.toThrow(/缺少步骤键/);
  });

  it("超时按未核实处理（不自动重发），dispose 后全部在途调用失败关闭", async () => {
    const transport = memoryTransport();
    const channel = new FilmWorkerChannel({ transport, timeoutMs: { "voice.verify": 20 } });
    await expect(channel.call("voice.verify", { stepKey: "voice:SC-01", params: {} })).rejects.toMatchObject({ code: "CHANNEL_TIMEOUT" });
    expect(transport.sent).toHaveLength(1); // 超时后不得自动重发
    const pending = channel.call("voice.verify", { stepKey: "voice:SC-02", params: {} });
    channel.dispose();
    await expect(pending).rejects.toMatchObject({ code: "CHANNEL_CLOSED" });
    await expect(channel.call("voice.verify", { stepKey: "voice:SC-03", params: {} })).rejects.toMatchObject({ code: "CHANNEL_CLOSED" });
  });

  it("事件帧只回调不上账；非法帧关闭通道", async () => {
    const transport = memoryTransport();
    const events: string[] = [];
    const channel = new FilmWorkerChannel({ transport, onEvent: (event) => events.push(event), timeoutMs: { "gate.review": 5_000 } });
    transport.deliver(JSON.stringify({ kind: "film.event", event: "stage.progress" }));
    expect(events).toEqual(["stage.progress"]);
    const pending = channel.call("gate.review", { stepKey: "shot:SC-01", shotId: "SC-01", params: {} });
    transport.deliver("{not-json");
    await expect(pending).rejects.toMatchObject({ code: "FRAME_INVALID" });
  });

  it("作业上下文校验：字段完整、方法白名单、缺密钥泄漏自检", () => {
    const context = {
      jobId: "FJ-1", tenantId: "t1", workspaceId: "ws1", projectId: "VID-1", attempt: 2, runId: "film-run-1",
      workerName: "full-chain-film", workerVersion: "v1", stages: ["plates", "videos"], options: { aspect: "16:9" },
      inputRef: "stages/film/inputs/abc.json", inputSha256: "a".repeat(64), workDir: "/tmp/work", archiveRoot: "/tmp/archive",
      allowedMethods: ["llm.chat", "image.generate"], budgetCny: 10, deadlineAt: new Date(Date.now() + 60_000).toISOString(),
    };
    const env = { FILM_JOB_ID: "FJ-1", FILM_JOB_CONTEXT: JSON.stringify(context), FILM_FORBIDDEN_SECRETS: "VOLCENGINE_ARK_API_KEY" } as NodeJS.ProcessEnv;
    expect(parseFilmWorkerJobContext(env).jobId).toBe("FJ-1");
    expect(() => parseFilmWorkerJobContext({ ...env, FILM_JOB_ID: "FJ-2" })).toThrow(/不一致/);
    expect(() => parseFilmWorkerJobContext({ ...env, FILM_JOB_CONTEXT: "{}" })).toThrow(/缺失或格式非法/);
    expect(() => parseFilmWorkerJobContext({ ...env, VOLCENGINE_ARK_API_KEY: "leaked" })).toThrow(/不得携带/);
    expect(() => parseFilmWorkerJobContext({ ...env, FILM_JOB_CONTEXT: JSON.stringify({ ...context, allowedMethods: ["exec"] }) })).toThrow(/缺失或格式非法/);
  });

  it("没有父进程 IPC 时拒绝发送（不能在没有服务的情况下伪装工位）", () => {
    const transport = processIpcTransport({ send: undefined, on: () => undefined, off: () => undefined } as unknown as NodeJS.Process);
    expect(() => transport.send("{}")).toThrow(/父通道/);
  });
});
