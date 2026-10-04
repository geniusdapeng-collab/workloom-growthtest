import { afterEach, describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { FullChainFilmWorker, normalizeFilmJobRequest, assertFilmStageCoverage } from "./film-worker-runtime.js";
import type { FilmWorkerJobContext, FilmChannelRequestFrame, FilmChannelTransport } from "./film-worker-channel.js";
const dirs: string[] = [];
const hash = (data: Buffer | string): string => createHash("sha256").update(data).digest("hex");
function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "film-worker-runtime-"))); dirs.push(root);
  const workDir = join(root, "archive", "stages", "film", "attempt-1");
  mkdirSync(workDir, { recursive: true });
  const source = JSON.stringify({ shots: [{ shotId: "S1", scene: "海边空镜，无人物" }] });
  writeFileSync(join(root, "archive", "source.json"), source);
  const context: FilmWorkerJobContext = { jobId: "FJ-test", tenantId: "t", workspaceId: "w", projectId: "P1", attempt: 1, runId: "run-1",
    workerName: "full-chain-film", workerVersion: "v1", stages: ["plates", "videos", "voice", "cover"], options: { aspect: "16:9", only: ["S1"] },
    archiveRoot: join(root, "archive"), workDir, inputRef: "source.json", inputSha256: hash(source), budgetCny: 1,
    deadlineAt: new Date(Date.now() + 60_000).toISOString(), allowedMethods: ["image.generate", "video.generate", "media.fetch", "voice.dub", "voice.verify", "gate.review", "llm.chat"] };
  let listener: ((raw: unknown) => void) | undefined;
  const frames: FilmChannelRequestFrame[] = [];
  let reply = (frame: FilmChannelRequestFrame): unknown => {
    if (frame.method === "voice.verify") return { checked: { text_match_status: "passed" } };
    if (frame.method === "llm.chat") return { content: "{\"headline\":\"test\"}" };
    const params = frame.params as Record<string, unknown>;
    const ref = String(params.targetRef ?? params.outputRef);
    const bytes = Buffer.from("test artifact bytes");
    const file = join(workDir, ref); mkdirSync(dirname(file), { recursive: true }); writeFileSync(file, bytes);
    return { ref, sha256: hash(bytes), bytes: bytes.length, hostedUrl: "https://provider.invalid/issued.png", taskId: "video-task-test" };
  };
  const transport: FilmChannelTransport = { subscribe(handler) { listener = handler; return () => { listener = undefined; }; }, send(raw) {
    const frame = JSON.parse(raw) as FilmChannelRequestFrame;
    frames.push(frame);
    listener?.(JSON.stringify({ kind: "film.response", id: frame.id, ok: true, result: reply(frame) }));
  } };
  const worker = new FullChainFilmWorker(context, root, transport);
  return { root, context, frames, worker, setReply: (fn: typeof reply) => { reply = fn; } };
}
afterEach(() => dirs.splice(0).forEach((dir) => rmSync(dir, { recursive: true, force: true })));
describe("frozen full-chain worker adapter", () => {
  it("requires evidence for each requested stage and does not accept a bare summary or stale success", () => {
    const source = { shots: [{ shotId: "S1" }] };
    expect(() => assertFilmStageCoverage(["cine-kb"], {}, source, [])).toThrow("缺请求阶段");
    expect(() => assertFilmStageCoverage(["cine-kb"], {}, source, undefined)).toThrow("缺阶段记录");
    const ok = { stage: "cine-kb", shotId: null, ok: true, degraded: false, invoked: true };
    expect(() => assertFilmStageCoverage(["cine-kb"], {}, source, [ok])).not.toThrow();
    expect(() => assertFilmStageCoverage(["cine-kb"], {}, source, [ok, { ...ok, ok: false }])).toThrow("没有通过");
    expect(() => assertFilmStageCoverage(["cine-kb"], {}, source, [{ ...ok, invoked: false, cached: false }])).toThrow("没有通过");
    expect(() => assertFilmStageCoverage(["cine-kb"], {}, source, [{ ...ok, invoked: false, cached: true }])).not.toThrow();
    expect(() => assertFilmStageCoverage(["plates"], {}, source, [{ ...ok, stage: "keyframe", shotId: "S1" }])).not.toThrow();
    expect(() => assertFilmStageCoverage(["plates", "videos"], {}, source, [{ ...ok, stage: "keyframe" }])).toThrow("videos");
  });
  it("allows only source-bound inapplicable stages and explicitly declared post-only degradation", () => {
    const source = { shots: [{ shotId: "S1" }] };
    expect(() => assertFilmStageCoverage(["material-gen", "mux", "danmaku"], { "subtitle-mode": "burn", "no-danmaku": true }, source, [])).not.toThrow();
    expect(() => assertFilmStageCoverage(["material-gen"], {}, { shots: [{ shotId: "S1", photo: "material.jpg" }] }, [])).toThrow("缺请求阶段");
    const declared = [{ stage: "compose", shotId: null, ok: true, degraded: true, invoked: true, assemblyMode: "post-only" }];
    expect(() => assertFilmStageCoverage(["compose"], {}, source, declared)).toThrow("没有通过");
    expect(() => assertFilmStageCoverage(["compose"], { "assembly-mode": "post-only" }, source, declared)).not.toThrow();
    expect(() => assertFilmStageCoverage(["compose"], { "assembly-mode": "post-only" }, source, [{ ...declared[0], ok: false }])).toThrow("没有通过");
  });
  it("normalizes complete stage dependencies and rejects unknown stages, paths, code and bypass options", () => {
    expect(normalizeFilmJobRequest(["deliver"], { aspect: "16:9", maxAttempts: 2 }).stages).toEqual(["deliver", "master"]);
    expect(normalizeFilmJobRequest(["compose"], { assemblyMode: "post-only" }).stages).toEqual(["compose", "spec"]);
    for (const key of ["keys-file", "work-dir", "out", "shots", "worker", "execute-revision", "accept-rejected", "allow-fallback-approve"]) expect(() => normalizeFilmJobRequest(["plates"], { [key]: "secret" })).toThrow("不接受");
    expect(() => normalizeFilmJobRequest(["storyboard"], {})).toThrow("阶段");
    expect(() => normalizeFilmJobRequest(["plates"], { maxAttempts: 100 })).toThrow("范围");
    expect(() => normalizeFilmJobRequest(["plates"], { aspect: "--out" })).toThrow("控制字符");
    expect(() => normalizeFilmJobRequest(["plates"], { noResume: "true" })).toThrow("布尔");
  });
  it("copies exact frozen bytes and constructs arguments only under the current job", () => {
    const { context, worker } = fixture();
    expect(hash(readFileSync(worker.inputPath))).toBe(context.inputSha256);
    expect(worker.args).toContain(context.projectId);
    expect(worker.args).toContain(join(context.workDir, "delivery"));
    expect(worker.args).toContain("--only"); expect(worker.args).toContain("S1");
    worker.channel.dispose();
  });
  it("rejects changed input, expired jobs, symlink escape and child stage expansion", () => {
    const { root, context, worker } = fixture(); worker.channel.dispose();
    const transport = { send() { throw new Error("not expected"); }, subscribe() { return () => {}; } };
    expect(() => new FullChainFilmWorker({ ...context, inputSha256: "0".repeat(64) }, root, transport)).toThrow("摘要不符");
    expect(() => new FullChainFilmWorker({ ...context, deadlineAt: new Date(0).toISOString() }, root, transport)).toThrow("截止");
    expect(() => new FullChainFilmWorker({ ...context, stages: ["deliver"] }, root, transport)).toThrow("增加阶段");
    const external = join(root, "outside.json"); writeFileSync(external, "{}"); symlinkSync(external, join(context.archiveRoot, "escape.json"));
    expect(() => new FullChainFilmWorker({ ...context, inputRef: "escape.json", inputSha256: hash("{}") }, root, transport)).toThrow("越出");
  });
  it("image/video use scoped parent methods and downloads verify the actual bytes without another paid call", async () => {
    const { context, worker, frames } = fixture();
    const plate = join(context.workDir, "work", "plate.png");
    const url = await worker.image("test", [], "1280x720", "S1", plate);
    await worker.download(url, plate);
    const video = await worker.video({ stage: "videos", shotId: "S1", target: join(context.workDir, "work", "clip.mp4"), prompt: "test", refs: [], firstFrame: url, seconds: 5, generateAudio: true });
    expect(video.taskId).toBe("video-task-test");
    expect(frames.map((frame) => frame.method)).toEqual(["image.generate", "video.generate"]);
    expect(frames.every((frame) => frame.shotId === "S1")).toBe(true);
    writeFileSync(plate, "changed");
    await expect(worker.download(url, plate)).rejects.toThrow("字节");
    await expect(worker.download("https://unissued.invalid", plate)).rejects.toThrow("未签发");
    worker.channel.dispose();
  });
  it("parent rejection, ungranted methods and references outside the archive fail before another call", async () => {
    const { root, context, worker, frames, setReply } = fixture();
    const file = join(root, "private.png"); writeFileSync(file, "private");
    expect(() => worker.reference(file)).toThrow("受控素材");
    await expect(worker.image("test", [], "1280x720", "S1", file)).rejects.toThrow("作业目录");
    expect(frames).toHaveLength(0);
    context.allowedMethods = ["llm.chat"];
    await expect(worker.image("test", [], "1280x720", "S1", join(context.workDir, "p.png"))).rejects.toThrow("未授予");
    context.allowedMethods = ["image.generate"];
    setReply(() => ({ ref: "p.png", sha256: "0".repeat(64), bytes: 1 })); writeFileSync(join(context.workDir, "p.png"), "x");
    await expect(worker.image("test", [], "1280x720", "S1", join(context.workDir, "p.png"))).rejects.toThrow("字节");
    expect(frames).toHaveLength(1); worker.channel.dispose();
  });
  it("voice and design requests stay on the parent channel and carry the shot", async () => {
    const { context, worker, frames } = fixture();
    const raw = join(context.workDir, "raw.mp4"), voiced = join(context.workDir, "voiced.mp4");
    writeFileSync(raw, "input");
    const checked = await worker.speech(raw, "台词", "S1");
    expect(JSON.parse(checked.out).result.checked.text_match_status).toBe("passed");
    await worker.dub(raw, voiced, "台词", "profile", "replace-bed", "S1");
    expect(await worker.design("设计稿")).toContain("headline");
    expect(frames.map((frame) => [frame.method, frame.shotId])).toEqual([["voice.verify", "S1"], ["voice.dub", "S1"], ["llm.chat", null]]);
    worker.channel.dispose();
  });
  it("review excludes process environment and functions and requires a parent contract receipt", async () => {
    const { context, worker, frames, setReply } = fixture();
    const file = join(context.workDir, "plate.png"); writeFileSync(file, "image");
    setReply(() => ({ stage: "keyframe", approved: true, contractHash: "a".repeat(64) }));
    await worker.review({ stage: "keyframe", projectId: context.projectId, artifacts: [{ path: file, kind: "image" }], deterministic: [{ id: "bytes", pass: true, hard: true, detail: "tested" }], context: { shotId: "S1" }, env: { LLM_API_KEY: "must-not-leak" }, log: () => {} });
    expect(JSON.stringify(frames)).not.toContain("must-not-leak");
    expect(frames[0]!.stepKey).toBe("plates:S1");
    setReply(() => ({ stage: "keyframe", approved: true }));
    await expect(worker.review({ stage: "keyframe", projectId: context.projectId, artifacts: [{ path: file, kind: "image" }], deterministic: [], context: { shotId: "S1" } })).rejects.toThrow("合同");
    worker.channel.dispose();
  });
  it("material shot review remains in its original stage when both material and video stages are selected", async () => {
    const { context, worker, frames, setReply } = fixture();
    context.stages.push("material-gen");
    const file = join(context.workDir, "clip.mp4"); writeFileSync(file, "video");
    setReply(() => ({ stage: "shot", approved: true, contractHash: "a".repeat(64) }));
    await worker.review({ stage: "shot", projectId: context.projectId, artifacts: [{ path: file, kind: "video" }],
      deterministic: [], context: { shotId: "S1", sourceStage: "material-gen" } });
    expect(frames[0]!.stepKey).toBe("material-gen:S1");
    worker.channel.dispose();
  });
});
