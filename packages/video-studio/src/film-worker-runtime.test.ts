import { afterEach, describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { POST_RENDER_STAGES, postProcessingVerdict } from "./post-render-acceptance.js";
import type { ProducerGateOptions } from "./producer-gate.js";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { FullChainFilmWorker, normalizeFilmJobRequest, assertFilmStageCoverage } from "./film-worker-runtime.js";
import { filmRequestHash, type FilmWorkerJobContext, type FilmChannelRequestFrame, type FilmChannelTransport } from "./film-worker-channel.js";
import { buildFilmVideoSubmissionReceipt, type FilmVideoReferenceInput } from "./film-worker-provenance.js";
import { adaptCharacterVisualVerdict, characterReleaseHash, type CharacterIdentityReviewRequest, type CharacterVisualVerdict } from "./character-release-contract.js";
const dirs: string[] = [];
const hash = (data: Buffer | string): string => createHash("sha256").update(data).digest("hex");
function fixture(sourceFormat: Record<string, unknown> = {}, options: Record<string, unknown> = { aspect: "16:9", only: ["S1"] }, stages: string[] = ["plates", "videos", "voice", "cover"]) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "film-worker-runtime-"))); dirs.push(root);
  const workDir = join(root, "archive", "stages", "film", "attempt-1");
  mkdirSync(workDir, { recursive: true });
  const source = JSON.stringify({ shots: [{ shotId: "S1", scene: "海边空镜，无人物" }], ...sourceFormat });
  writeFileSync(join(root, "archive", "source.json"), source);
  const context: FilmWorkerJobContext = { jobId: "FJ-test", tenantId: "t", workspaceId: "w", projectId: "P1", attempt: 1, runId: "run-1",
    workerName: "full-chain-film", workerVersion: "v1", stages, options,
    archiveRoot: join(root, "archive"), workDir, inputRef: "source.json", inputSha256: hash(source), budgetCny: 1,
    deadlineAt: new Date(Date.now() + 60_000).toISOString(), allowedMethods: ["image.generate", "video.generate", "media.fetch", "voice.dub", "voice.verify", "gate.review", "llm.chat"] };
  let listener: ((raw: unknown) => void) | undefined;
  const frames: FilmChannelRequestFrame[] = [];
  const issued = new Map<string, string>();
  const respond = (frame: FilmChannelRequestFrame): any => {
    if (frame.method === "voice.verify") return { checked: { text_match_status: "passed" } };
    if (frame.method === "llm.chat") return { content: "{\"headline\":\"test\"}" };
    const params = frame.params as Record<string, unknown>;
    const ref = String(params.targetRef ?? params.outputRef);
    const bytes = Buffer.from("test artifact bytes");
    const file = join(workDir, ref); mkdirSync(dirname(file), { recursive: true }); writeFileSync(file, bytes);
    const artifact = { ref, sha256: hash(bytes), bytes: bytes.length, hostedUrl: "https://provider.invalid/issued.png", taskId: "video-task-test" };
    if (frame.method === "image.generate") issued.set(artifact.hostedUrl, ref);
    if (frame.method !== "video.generate") return artifact;
    const references: FilmVideoReferenceInput[] = (params.refs as string[]).map((reference) => ({ role: "reference-image", ref: reference,
      sha256: hash(reference.startsWith("asset://") ? reference : readFileSync(join(workDir, reference))), hashKind: reference.startsWith("asset://") ? "asset-uri" : "bytes" }));
    const first = params.firstFrame as { ref?: string; hostedUrl?: string } | undefined;
    if (first) {
      const firstRef = first.ref ?? issued.get(first.hostedUrl!)!;
      references.unshift({ role: "first-frame", ref: firstRef, sha256: hash(readFileSync(join(workDir, firstRef))), hashKind: "bytes",
        ...(first.hostedUrl ? { requestUriSha256: hash(first.hostedUrl) } : {}) });
    }
    return { ...artifact, submissionReceipt: buildFilmVideoSubmissionReceipt({ jobId: context.jobId, projectId: context.projectId,
      inputSha256: context.inputSha256, shotId: frame.shotId!, stepKey: frame.stepKey, requestHash: filmRequestHash(frame),
      providerRequestHash: hash("fake accepted provider request"), taskId: artifact.taskId,
      artifact: { ref, sha256: artifact.sha256, bytes: artifact.bytes }, promptSha256: hash(String(params.prompt)), referenceInputs: references,
      aspect: String(params.aspect ?? "16:9"), resolution: String(params.resolution ?? "720p"), seconds: Number(params.seconds), generateAudio: params.generateAudio as boolean }) };
  };
  let reply: (frame: FilmChannelRequestFrame) => unknown = respond;
  const transport: FilmChannelTransport = { subscribe(handler) { listener = handler; return () => { listener = undefined; }; }, send(raw) {
    const frame = JSON.parse(raw) as FilmChannelRequestFrame;
    frames.push(frame);
    listener?.(JSON.stringify({ kind: "film.response", id: frame.id, ok: true, result: reply(frame) }));
  } };
  const worker = new FullChainFilmWorker(context, root, transport);
  return { root, context, frames, worker, respond, setReply: (fn: typeof reply) => { reply = fn; } };
}
function identityFixture(source: Record<string, unknown> = {}, stages?: string[]) {
  const value = fixture(source, undefined, stages);
  (value.context as FilmWorkerJobContext & { characterVisionAvailable: boolean }).characterVisionAvailable = true;
  const fingerprint = (name: string) => {
    const path = join(value.context.workDir, name); writeFileSync(path, `actual bytes: ${name}`);
    return { path, sha256: hash(readFileSync(path)) };
  };
  const body = { schemaVersion: "workloom.character-identity-review/v1" as const, purpose: "identity-and-explicit-wardrobe" as const,
    projectId: value.context.projectId, shotId: "S1", characterId: "host", assetId: "asset-host", contractHash: hash("identity contract"), producerContractHash: hash("producer contract"),
    clip: fingerprint("clip.mp4"), promptSha256: hash("actual prompt"), frames: [{ ...fingerprint("frame0.png"), atSec: 0 }, { ...fingerprint("frame1.png"), atSec: 1 }],
    referenceImage: { ...fingerprint("anchor.png"), assetId: "asset-host", source: "registered authorized reference" },
    wardrobeLock: { id: "suit", description: "same dark suit" }, rubric: ["same authorized person", "explicit wardrobe"], context: { purpose: "identity-and-explicit-wardrobe" } };
  const request: CharacterIdentityReviewRequest = { ...body, requestHash: characterReleaseHash(body) };
  const verdict: CharacterVisualVerdict = { stage: "shot", status: "passed", approved: true, via: "llm", model: "fake visual test model", degraded: false,
    contractHash: request.producerContractHash, reason: "fake dedicated visual result", evidence: [{ ...request.clip, scope: "temporal-sample:0,1; audio-not-reviewed" },
      ...request.frames.map((frame) => ({ path: frame.path, sha256: frame.sha256, scope: "image" })), { ...request.referenceImage, scope: "reference-image" }] };
  const evidence = adaptCharacterVisualVerdict({ request, verdict });
  value.setReply(() => ({ identityEvidence: evidence }));
  return { ...value, request, verdict, evidence };
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
    expect(() => assertFilmStageCoverage(["plates", "videos"], {}, source, [{ ...ok, stage: "keyframe", shotId: "S1" }])).toThrow("videos");
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
    expect(normalizeFilmJobRequest(["master"], { autoDanmaku: true }).stages).toEqual(["master", "danmaku"]);
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
    setReply(() => ({ stage: "shot", approved: true, status: "passed", score: null, qualityReviewed: false, via: "deterministic", rerun: false, hardFailures: [] }));
    await worker.review({ stage: "shot", projectId: context.projectId, artifacts: [{ path: file, kind: "video" }],
      deterministic: [], context: { shotId: "S1", sourceStage: "material-gen" } });
    expect(frames[0]!.stepKey).toBe("material-gen:S1");
    worker.channel.dispose();
  });
});

describe("worker current-response submission and dedicated identity contracts", () => {
  it("retains provider bytes, sends aspect/resolution and copies via media.fetch before local postprocessing", async () => {
    const { context, worker, frames } = fixture();
    const target = join(context.workDir, "work", "clip.mp4");
    const result = await worker.video({ prompt: "precise prompt", refs: ["asset://authorized"], seconds: 5, generateAudio: false, aspect: "9:16", resolution: "1080p", stage: "videos", shotId: "S1", target });
    expect(result).toMatchObject({ taskId: "video-task-test", lastFrame: null, resumed: false, requestInputVerified: true });
    expect((frames[0]!.params as Record<string, unknown>)).toMatchObject({ aspect: "9:16", resolution: "1080p", targetRef: "work/clip.mp4.provider.mp4", generateAudio: false });
    expect(result.submissionReceipt.artifact.ref).toBe("work/clip.mp4.provider.mp4");
    await worker.download(result.url, target);
    expect(frames.map((frame) => frame.method)).toEqual(["video.generate", "media.fetch"]);
    expect(readFileSync(target)).toEqual(readFileSync(`${target}.provider.mp4`));
    writeFileSync(target, "local postprocess changed bytes");
    expect(hash(readFileSync(`${target}.provider.mp4`))).toBe(result.submissionReceipt.artifact.sha256);
    worker.channel.dispose();
  });
  it("does not mark an old bare response verified and rejects a current receipt for another job", async () => {
    for (const invalid of ["missing", "other-job"]) {
      const { context, worker, respond, setReply } = fixture();
      setReply((frame) => { const result = respond(frame); if (invalid === "missing") delete result.submissionReceipt;
        else { const { schemaVersion: ignoredSchema, receiptHash: ignoredHash, ...facts } = result.submissionReceipt; void ignoredSchema; void ignoredHash;
          result.submissionReceipt = buildFilmVideoSubmissionReceipt({ ...facts, jobId: "FJ-other" }); } return result; });
      await expect(worker.video({ prompt: "test", refs: [], seconds: 5, generateAudio: true, stage: "videos", shotId: "S1", target: join(context.workDir, "v.mp4") })).rejects.toThrow(/VIDEO_SUBMISSION_/);
      await expect(worker.download("film-artifact:v.mp4.provider.mp4", join(context.workDir, "v.mp4"))).rejects.toThrow(/URL_NOT_ISSUED/);
      worker.channel.dispose();
    }
  });
  it("uses frozen default geometry and rejects invalid geometry before parent dispatch", async () => {
    const { context, worker, frames } = fixture(); context.options.resolution = "1080p";
    const options = { prompt: "test", refs: [], seconds: 5, generateAudio: true, stage: "videos", shotId: "S1", target: join(context.workDir, "v.mp4") };
    await expect(worker.video({ ...options, aspect: "invalid" })).rejects.toThrow(/OPTION_INVALID/);
    expect(frames).toHaveLength(0);
    const result = await worker.video(options);
    expect(result.submissionReceipt).toMatchObject({ aspect: "16:9", resolution: "1080p" }); worker.channel.dispose();
  });
  it.each([
    [{}, {}, "9:16", "1080p"],
    [{ aspect: "1:1", resolution: "2160p" }, {}, "1:1", "1080p"],
    [{ aspect: "1:1", resolution: "720p" }, { aspect: "4:5", resolution: "2160p" }, "4:5", "1080p"],
  ])("follows actual CLI/parent options→frozen source→1080p and maps 2160p delivery to 1080p source %j", async (source, options, aspect, resolution) => {
    const { context, worker } = fixture(source as Record<string, unknown>, options as Record<string, unknown>);
    const result = await worker.video({ prompt: "test", refs: [], seconds: 5, generateAudio: true, stage: "videos", shotId: "S1", target: join(context.workDir, "v.mp4") });
    expect(result.submissionReceipt).toMatchObject({ aspect, resolution }); worker.channel.dispose();
  });
  it("rejects source/reference mutation during the current call even with an internally valid parent receipt", async () => {
    for (const mutation of ["input", "reference"]) {
      const { context, worker, frames, respond, setReply } = fixture();
      const reference = join(context.workDir, "ref.png"); writeFileSync(reference, "reference bytes");
      setReply((frame) => { const result = respond(frame); writeFileSync(mutation === "input" ? worker.inputPath : reference, "changed while in flight"); return result; });
      await expect(worker.video({ prompt: "test", refs: ["film-ref:ref.png"], seconds: 5, generateAudio: true, stage: "videos", shotId: "S1", target: join(context.workDir, "v.mp4") })).rejects.toThrow(/INPUT_CHANGED|REFERENCE_CHANGED/);
      expect(frames).toHaveLength(1); worker.channel.dispose();
    }
  });
  it("rejects a confined-looking symlink reference escape before dispatch", async () => {
    const { root, context, worker, frames } = fixture();
    const external = join(root, "private.png"); writeFileSync(external, "private bytes"); symlinkSync(external, join(context.workDir, "escape.png"));
    await expect(worker.video({ prompt: "test", refs: ["film-ref:escape.png"], seconds: 5, generateAudio: true, stage: "videos", shotId: "S1", target: join(context.workDir, "v.mp4") })).rejects.toThrow(/REFERENCE_INVALID/);
    expect(frames).toHaveLength(0); worker.channel.dispose();
  });
  it("fails a media.fetch copy whose receipt is valid for different bytes", async () => {
    const { context, worker, respond, setReply } = fixture();
    const target = join(context.workDir, "v.mp4");
    const video = await worker.video({ prompt: "test", refs: [], seconds: 5, generateAudio: true, stage: "videos", shotId: "S1", target });
    setReply((frame) => { const result = respond(frame); writeFileSync(join(context.workDir, result.ref), "different copy");
      return { ...result, sha256: hash("different copy"), bytes: Buffer.byteLength("different copy") }; });
    await expect(worker.download(video.url, target)).rejects.toThrow(/ARTIFACT_CHANGED/); worker.channel.dispose();
  });
  it("rejects more than three references and unissued hosted first frames before dispatch", async () => {
    const { context, worker, frames } = fixture();
    const options = { prompt: "test", refs: [], seconds: 5, generateAudio: true, stage: "videos", shotId: "S1", target: join(context.workDir, "v.mp4") };
    await expect(worker.video({ ...options, refs: ["asset://one", "asset://two", "asset://three", "asset://four"] })).rejects.toThrow(/REFERENCE/);
    await expect(worker.video({ ...options, firstFrame: "https://unissued.invalid/frame.png" })).rejects.toThrow(/URL_NOT_ISSUED/);
    expect(frames).toHaveLength(0); worker.channel.dispose();
  });
  it("issued hosted first frames remain bound to current artifact bytes", async () => {
    const { context, worker, frames } = fixture();
    const plate = join(context.workDir, "plate.png");
    const firstFrame = await worker.image("plate", [], "1280x720", "S1", plate);
    writeFileSync(plate, "changed issued image");
    await expect(worker.video({ prompt: "test", refs: [], firstFrame, seconds: 5, generateAudio: true, stage: "videos", shotId: "S1", target: join(context.workDir, "v.mp4") })).rejects.toThrow(/ARTIFACT_CHANGED/);
    expect(frames.map((frame) => frame.method)).toEqual(["image.generate"]); worker.channel.dispose();
  });
  it("re-hashes local first frames and ordered reference bytes independently of parent receipt", async () => {
    const { context, worker, frames } = fixture();
    for (const name of ["first.png", "ref.png"]) writeFileSync(join(context.workDir, name), name);
    const result = await worker.video({ prompt: "test", firstFrame: "film-ref:first.png", refs: ["film-ref:ref.png", "asset://authorized"], seconds: 5,
      generateAudio: true, stage: "videos", shotId: "S1", target: join(context.workDir, "v.mp4") });
    expect(result.submissionReceipt.referenceInputs).toEqual([{ role: "first-frame", ref: "first.png", sha256: hash("first.png"), hashKind: "bytes" },
      { role: "reference-image", ref: "ref.png", sha256: hash("ref.png"), hashKind: "bytes" }, { role: "reference-image", ref: "asset://authorized", sha256: hash("asset://authorized"), hashKind: "asset-uri" }]);
    expect((frames[0]!.params as any).refs).toEqual(["ref.png", "asset://authorized"]); worker.channel.dispose();
  });
  it("sends dedicated identity purpose and byte references, recomputes the exact parent evidence", async () => {
    const { context, worker, frames, request, evidence } = identityFixture();
    expect(worker.identityVisionAvailable).toBe(true);
    expect(await worker.identityReview(request)).toEqual(evidence);
    const params = frames[0]!.params as any;
    expect(params).toMatchObject({ stage: "shot", projectId: context.projectId, context: { shotId: "S1", purpose: "identity-and-explicit-wardrobe" },
      identityReview: { purpose: "identity-and-explicit-wardrobe", requestHash: request.requestHash, request, clipRef: "clip.mp4", referenceRef: "references/" + request.referenceImage.sha256 + ".png" } });
    expect(params.identityReview.frames).toEqual(request.frames.map((frame) => ({ ref: worker.ref(frame.path), sha256: frame.sha256, atSec: frame.atSec })));
    worker.channel.dispose();
  });
  it("missing vision availability and changed review bytes fail before dispatch", async () => {
    const { context, worker, frames, request } = identityFixture();
    (context as any).characterVisionAvailable = false;
    expect(worker.identityVisionAvailable).toBe(false);
    await expect(worker.identityReview(request)).rejects.toThrow(/IDENTITY_VISION_UNAVAILABLE/);
    (context as any).characterVisionAvailable = true;
    writeFileSync(request.frames[0]!.path, "changed temporal frame");
    await expect(worker.identityReview(request)).rejects.toThrow(/IDENTITY_REVIEW_CHANGED/);
    expect(frames).toHaveLength(0); worker.channel.dispose();
  });
  it("dedicated material identity review follows the frozen material shot when both source stages are selected", async () => {
    const { worker, request, frames } = identityFixture({ shots: [{ shotId: "S1", photo: "registered material.jpg" }] }, ["plates", "videos", "material-gen", "voice", "cover"]);
    await worker.identityReview(request);
    expect(frames[0]!.stepKey).toBe("material-gen:S1");
    expect((frames[0]!.params as any).identityReview.request).toEqual(request);
    worker.channel.dispose();
  });
  it("bare generic off/advisory success and cross-request identity evidence cannot certify identity", async () => {
    for (const mode of ["generic", "cross-request", "forged-checks"]) {
      const { worker, request, verdict, evidence, setReply } = identityFixture();
      setReply(() => mode === "generic" ? { stage: "shot", approved: true, via: "deterministic", contractHash: request.producerContractHash }
        : { identityEvidence: mode === "cross-request" ? adaptCharacterVisualVerdict({ request: { ...request, shotId: "S2" }, verdict })
          : { ...evidence, checks: { identity: "unverified", wardrobe: "passed" } } });
      await expect(worker.identityReview(request)).rejects.toThrow(/IDENTITY_REVIEW_UNVERIFIED/);
      worker.channel.dispose();
    }
  });
  it("a dedicated model rejection remains rejected and an unverified generic verdict remains unverified", async () => {
    for (const mode of ["rejected", "generic"]) {
      const { worker, request, verdict, setReply } = identityFixture();
      const parentVerdict = mode === "rejected" ? { ...verdict, status: "failed", approved: false }
        : { ...verdict, via: "deterministic", approved: true };
      const evidence = adaptCharacterVisualVerdict({ request, verdict: parentVerdict });
      setReply(() => ({ identityEvidence: evidence }));
      const result = await worker.identityReview(request);
      expect(result.checks).toEqual({ identity: "unverified", wardrobe: "unverified" });
      expect(result.rejected).toBe(mode === "rejected"); worker.channel.dispose();
    }
  });
  it("identity review input mutation during IPC cannot inherit a stale valid evidence receipt", async () => {
    const { worker, request, evidence, setReply } = identityFixture();
    setReply(() => { writeFileSync(request.clip.path, "changed review video"); return { identityEvidence: evidence }; });
    await expect(worker.identityReview(request)).rejects.toThrow(/IDENTITY_REVIEW_CHANGED/); worker.channel.dispose();
  });
});

describe("worker original-native video retiming prohibition", () => {
  const prepare = async (stage = "videos") => {
    const value = fixture({ shots: [{ shotId: "S1", duration: 4 }] }, undefined, ["videos", "material-gen"]);
    const target = join(value.context.workDir, "work", "clip.mp4");
    const video = await value.worker.video({ stage, shotId: "S1", target, prompt: "test", refs: [], seconds: 5, generateAudio: true });
    await value.worker.download(video.url, target);
    // Current-response video provenance and byte-preserving copy remain usable.
    expect(readFileSync(target)).toEqual(readFileSync(`${target}.provider.mp4`));
    expect(hash(readFileSync(target))).toBe(video.submissionReceipt.artifact.sha256);
    const reply = (frame: FilmChannelRequestFrame, changes: Record<string, unknown> = {}) => {
      const params = frame.params as Record<string, unknown>;
      const ref = String(changes.ref ?? params.targetRef);
      const bytes = Buffer.from(`forbidden retime response: ${value.frames.length}`);
      const file = join(value.context.workDir, ref); mkdirSync(dirname(file), { recursive: true }); writeFileSync(file, bytes);
      return { ref, sha256: hash(bytes), bytes: bytes.length, normalization: { factor: 0.8, from: 5, to: 4 }, ...changes };
    };
    value.setReply((frame) => reply(frame));
    return { ...value, target, video, reply };
  };
  const originalBytes = (value: Awaited<ReturnType<typeof prepare>>) => ({
    target: readFileSync(value.target), provider: readFileSync(`${value.target}.provider.mp4`), input: readFileSync(value.worker.inputPath),
  });
  const assertForbidden = async (value: Awaited<ReturnType<typeof prepare>>, target = value.target, seconds = 4, stage = "videos", shotId = "S1") => {
    const before = originalBytes(value); const framesBefore = [...value.frames];
    await expect(value.worker.normalizeVideo(target, seconds, stage, shotId)).rejects.toMatchObject({ code: "STANDARD_NATIVE_RETIME_FORBIDDEN" });
    expect(value.frames).toEqual(framesBefore);
    expect(originalBytes(value)).toEqual(before);
  };
  it("rejects repeated retiming before IPC and retains both original provider and downloaded-copy bytes", async () => {
    const value = await prepare();
    await assertForbidden(value); await assertForbidden(value);
    expect(value.frames.map((frame) => frame.method)).toEqual(["video.generate", "media.fetch"]);
    expect(hash(readFileSync(`${value.target}.provider.mp4`))).toBe(value.video.submissionReceipt.artifact.sha256);
    value.worker.channel.dispose();
  });
  it("rejects retiming in the material stage before IPC and preserves the original copy", async () => {
    const value = await prepare("material-gen");
    await assertForbidden(value, value.target, 4, "material-gen");
    expect(value.frames[1]!.stepKey).toBe("material-gen:S1"); value.worker.channel.dispose();
  });
  it.each(["unknown", "wrong-stage", "wrong-shot", "provider-raw", "changed-copy", "changed-provider", "changed-input"])(
    "uses the same unconditional prohibition for %s before any file validation or IPC", async (invalid) => {
      const value = await prepare();
      let selected = value.target; let stage = "videos"; let shotId = "S1";
      if (invalid === "unknown") { selected = join(value.context.workDir, "unknown.mp4"); writeFileSync(selected, "not issued"); }
      if (invalid === "wrong-stage") stage = "material-gen";
      if (invalid === "wrong-shot") shotId = "S2";
      if (invalid === "provider-raw") selected = `${value.target}.provider.mp4`;
      if (invalid === "changed-copy") writeFileSync(value.target, "changed without parent");
      if (invalid === "changed-provider") writeFileSync(`${value.target}.provider.mp4`, "changed preserved provider");
      if (invalid === "changed-input") writeFileSync(value.worker.inputPath, "{}");
      await assertForbidden(value, selected, 4, stage, shotId);
      if (invalid === "unknown") {
        await assertForbidden(value, join(value.context.workDir, "missing.mp4"));
        await assertForbidden(value, join(value.root, "outside.mp4"));
        await assertForbidden(value, null as unknown as string);
      }
      expect(value.frames).toHaveLength(2); value.worker.channel.dispose();
    },
  );
  it.each([0, -1, Number.NaN, Number.POSITIVE_INFINITY])("uses the prohibition for invalid target duration %s before dispatch", async (seconds) => {
    const value = await prepare();
    await assertForbidden(value, value.target, seconds);
    expect(value.frames).toHaveLength(2); value.worker.channel.dispose();
  });
  it.each([
    ["missing", undefined], ["zero-factor", { factor: 0, from: 5, to: 4 }],
    ["string-factor", { factor: "0.8", from: 5, to: 4 }], ["wrong-target", { factor: 0.8, from: 5, to: 4.11 }],
    ["inconsistent-factor", { factor: 0.5, from: 5, to: 4 }], ["invalid-from", { factor: 0.8, from: -5, to: 4 }],
  ])("never requests a parent response carrying %s retiming metadata", async (_name, normalization) => {
    const value = await prepare(); let calls = 0;
    value.setReply((frame) => { calls += 1; return value.reply(frame, { normalization }); });
    await assertForbidden(value);
    expect(calls).toBe(0); value.worker.channel.dispose();
  });
  it("does not permit retiming based on frame/AAC duration rounding", async () => {
    const value = await prepare(); let calls = 0;
    value.setReply((frame) => { calls += 1; return value.reply(frame, { normalization: { factor: 0.8, from: 5, to: 4.08 } }); });
    await assertForbidden(value);
    expect(calls).toBe(0); value.worker.channel.dispose();
  });
  it("does not issue IPC or create/register another output through a retiming response", async () => {
    const value = await prepare(); let calls = 0;
    value.setReply((frame) => { calls += 1; return value.reply(frame, { ref: "wrong-output.mp4" }); });
    await assertForbidden(value);
    expect(calls).toBe(0);
    expect(existsSync(join(value.context.workDir, "wrong-output.mp4"))).toBe(false);
    await expect(value.worker.download("film-artifact:wrong-output.mp4", join(value.context.workDir, "copy.mp4"))).rejects.toThrow(/URL_NOT_ISSUED/);
    expect(value.frames).toHaveLength(2); value.worker.channel.dispose();
  });
  it.each(["provider", "input"])("prevents parent retiming code from changing preserved %s bytes", async (changed) => {
    const value = await prepare(); let calls = 0;
    value.setReply((frame) => { calls += 1; const result = value.reply(frame); writeFileSync(changed === "provider" ? `${value.target}.provider.mp4` : value.worker.inputPath, "changed in channel"); return result; });
    await assertForbidden(value);
    expect(calls).toBe(0); value.worker.channel.dispose();
  });
});

describe("frozen shot coverage and canonical CLI options", () => {
  const spoken = { shots: [
    { shotId: "S1", dialogue: [{ text: "第一句" }] },
    { shotId: "S2", dialogue: [{ text: "第二句" }] },
  ] };
  const passed = (stage: string, shotId: string | null = null) => ({ stage, shotId, ok: true, degraded: false, invoked: true, cached: false });

  it.each([["plates", "keyframe"], ["videos", "shot"], ["voice", "voice"], ["material-gen", "material-gen"]])(
    "%s requires both frozen shots rather than any one row", (stage, alias) => {
      const source = stage === "material-gen"
        ? { shots: spoken.shots.map((shot) => ({ ...shot, photo: `${shot.shotId}.jpg` })) } : spoken;
      expect(() => assertFilmStageCoverage([stage], {}, source, [passed(alias, "S1")])).toThrow("S2");
      expect(() => assertFilmStageCoverage([stage], {}, source, [passed(alias, "S1"), passed(alias, "S2")])).not.toThrow();
    },
  );
  it.each(["plates", "videos", "voice"])("%s refuses an unknown or unselected shot even beside complete evidence", (stage) => {
    const alias = stage === "plates" ? "keyframe" : stage === "videos" ? "shot" : "voice";
    expect(() => assertFilmStageCoverage([stage], {}, spoken, [passed(alias, "S1"), passed(alias, "S2"), passed(alias, "FOREIGN")])).toThrow("冻结");
    expect(() => assertFilmStageCoverage([stage], { only: ["S1"] }, spoken, [passed(alias, "S1"), passed(alias, "S2")])).toThrow("范围");
  });
  it("refuses unknown only before a source-bound stage can become vacuously inapplicable", () => {
    expect(() => assertFilmStageCoverage(["material-gen", "voice"], { only: ["FOREIGN"] }, spoken, [])).toThrow("only");
    expect(() => assertFilmStageCoverage(["videos"], { only: " S1, S2 " }, spoken, [passed("shot", "S1"), passed("shot", "S2")])).not.toThrow();
    expect(() => assertFilmStageCoverage(["videos"], { only: ["S2"] }, spoken, [passed("shot", "S2")])).not.toThrow();
  });
  it.each([{}, { shots: [] }, { shots: [{ shotId: "" }] }, { shots: [{ shotId: "S1" }, { shotId: "S1" }] }])(
    "rejects a missing, empty or ambiguous frozen shot inventory %j", (source) => {
      expect(() => assertFilmStageCoverage(["cine-kb"], {}, source, [passed("cine-kb")])).toThrow("原稿");
    },
  );
  it("rejects malformed rows even when all requested stages are inapplicable", () => {
    expect(() => assertFilmStageCoverage(["material-gen"], {}, spoken, [null])).toThrow("记录");
    expect(() => assertFilmStageCoverage(["material-gen"], {}, spoken, [passed("material-gen", "FOREIGN")])).toThrow("冻结");
  });
  it("does not allow null summary evidence to replace per-shot work", () => {
    expect(() => assertFilmStageCoverage(["videos"], {}, spoken, [passed("shot")])).toThrow("镜号");
    expect(() => assertFilmStageCoverage(["compose"], {}, spoken, [passed("compose", "S1")])).toThrow("全片");
  });
  it("spec requires each prompt and the global prompt review, not a package alias for missing prompts", () => {
    const review = passed("prompt-review");
    expect(() => assertFilmStageCoverage(["spec"], {}, spoken, [review])).toThrow("S1");
    expect(() => assertFilmStageCoverage(["spec"], {}, spoken, [passed("spec", "S1"), review])).toThrow("S2");
    expect(() => assertFilmStageCoverage(["spec"], {}, spoken, [passed("spec", "S1"), passed("spec", "S2")])).toThrow("prompt-review");
    expect(() => assertFilmStageCoverage(["spec"], {}, spoken, [passed("spec", "S1"), passed("spec", "S2"), review])).not.toThrow();
    expect(() => assertFilmStageCoverage(["spec"], {}, spoken, [passed("spec", "S1"), passed("spec", "S2"), passed("prompt-package")])).toThrow("不适用");
  });
  it("uses source-bound nonapplicability for material, authorized-reference plates and silent voice", () => {
    const source = { shots: [{ shotId: "S1", photo: "material.jpg" }, { shotId: "S2", assetRef: "asset://authorized" }] };
    const skipped = (stage: string, shotId: string | null) => ({ ...passed(stage, shotId), invoked: false });
    expect(() => assertFilmStageCoverage(["plates", "voice"], {}, source, [skipped("keyframe", "S1"), skipped("keyframe", "S2"), skipped("voice", "S1"), skipped("voice", "S2")])).not.toThrow();
    expect(() => assertFilmStageCoverage(["plates", "voice"], {}, source, [])).not.toThrow();
    expect(() => assertFilmStageCoverage(["plates"], {}, spoken, [skipped("keyframe", "S1"), skipped("keyframe", "S2")])).toThrow("没有通过");
    expect(() => assertFilmStageCoverage(["voice"], {}, spoken, [skipped("voice", "S1"), skipped("voice", "S2")])).toThrow("没有通过");
  });
  it("permits an all-material prompt package only while its prompt stage is actually inapplicable", () => {
    const source = { shots: [{ shotId: "S1", photo: "material.jpg" }] };
    expect(() => assertFilmStageCoverage(["spec"], {}, source, [{ ...passed("prompt-package"), invoked: false }])).not.toThrow();
    expect(() => assertFilmStageCoverage(["spec"], {}, source, [{ ...passed("prompt-package"), invoked: false, ok: false }])).toThrow("没有通过");
  });
  it("keeps failures visible even for inapplicable stages and only skips mux for explicit burn", () => {
    expect(() => assertFilmStageCoverage(["material-gen"], {}, spoken, [{ ...passed("material-gen", "S1"), ok: false }])).toThrow("没有通过");
    expect(() => assertFilmStageCoverage(["mux"], {}, spoken, [])).toThrow("mux");
    expect(() => assertFilmStageCoverage(["mux"], { "subtitle-mode": "burn" }, spoken, [])).not.toThrow();
    expect(() => assertFilmStageCoverage(["danmaku"], {}, spoken, [])).toThrow("danmaku");
    expect(() => assertFilmStageCoverage(["revise"], { "revise-note": "修第一镜" }, spoken, [])).toThrow("revise");
  });
  it("canonical aliases share the same latest slot and an older successful alias cannot mask failure", () => {
    const rows = [passed("keyframe", "S1"), passed("plates", "S1"), passed("keyframe", "S2"), { ...passed("plates", "S1"), ok: false }];
    expect(() => assertFilmStageCoverage(["plates"], {}, spoken, rows)).toThrow("没有通过");
    expect(() => assertFilmStageCoverage(["plates"], {}, spoken, [...rows, passed("keyframe", "S1")])).not.toThrow();
  });
  it("accepts the actual title/audio flags and maps the harmless historical narration alias", () => {
    const normalized = normalizeFilmJobRequest(["subtitle", "voice"], { narrationUnified: true, openingTitle: "经营首页", noTitleCard: false });
    expect(normalized.options).toEqual({ "narration-unified": true, "opening-title": "经营首页", "no-title-card": false });
    expect(normalizeFilmJobRequest(["voice"], { "unified-narration": true }).options).toEqual({ "narration-unified": true });
    expect(() => normalizeFilmJobRequest(["voice"], { "unified-narration": false, narrationUnified: true })).toThrow("重复");
    expect(() => normalizeFilmJobRequest(["subtitle"], { "no-title-card": "true" })).toThrow("布尔");
    expect(() => normalizeFilmJobRequest(["subtitle"], { "opening-title": true })).toThrow("格式");
  });
  it.each([[], [""], ["S1", 2], "S1,,S2", "--out"].map((only) => [only]))("rejects malformed only selection %j", (only) => {
    expect(() => normalizeFilmJobRequest(["videos"], { only })).toThrow("only");
  });
  it("canonicalizes only to one nonempty ordered set without changing CLI selection meaning", () => {
    expect(normalizeFilmJobRequest(["videos"], { only: [" S1 ", "S2", "S1"] }).options.only).toBe("S1,S2");
    expect(normalizeFilmJobRequest(["videos"], { only: " S1, S2,S1 " }).options.only).toBe("S1,S2");
  });
});

describe("current official adoption scopes prerender work to pending shots", () => {
  const source = { shots: [{ shotId: "S1", assetRef: "invalid historical reference", dialogue: [{ text: "old native line" }] }, { shotId: "S2" }] };
  const adopted = { stage: "render-adopted", shotId: "S1", ok: true, degraded: false, invoked: false, cached: true };
  const passed = (stage: string, shotId: string | null = null) => ({ stage, shotId, ok: true, degraded: false, invoked: true, cached: false });
  const pending = [passed("spec", "S2"), passed("prompt-review"), passed("keyframe", "S2"), passed("shot", "S2")];
  it("requires official parent verification rather than trusting a child adoption label", () => {
    expect(() => assertFilmStageCoverage(["spec", "plates", "videos"], {}, source, [adopted, ...pending])).toThrow("官方验证");
    expect(() => assertFilmStageCoverage(["spec", "plates", "videos"], {}, source, [adopted, ...pending], ["S1"])).not.toThrow();
  });
  it.each(["spec", "keyframe", "shot"])("still requires the pending S2 %s work", alias => {
    expect(() => assertFilmStageCoverage(["spec", "plates", "videos"], {}, source, [adopted, ...pending.filter(row => row.stage !== alias)], ["S1"])).toThrow("S2");
  });
  it("keeps pending prompt review, asset authority and post work mandatory", () => {
    expect(() => assertFilmStageCoverage(["spec"], {}, source, [adopted, passed("spec", "S2")], ["S1"])).toThrow("prompt-review");
    expect(() => assertFilmStageCoverage(["plates"], {}, { shots: [...source.shots.slice(0, 1), { shotId: "S2", assetRef: "invalid pending reference" }] }, [adopted, passed("keyframe", "S2")], ["S1"])).toThrow("S2");
    expect(() => assertFilmStageCoverage(["compose"], {}, source, [adopted], ["S1"])).toThrow("compose");
    expect(() => assertFilmStageCoverage(["voice"], {}, source, [adopted], ["S1"])).toThrow("S1");
  });
  it("preserves verified adoption outside only while rejecting work outside the selection", () => {
    expect(() => assertFilmStageCoverage(["spec", "plates", "videos"], { only: "S2" }, source, [adopted, ...pending], ["S1"])).not.toThrow();
    expect(() => assertFilmStageCoverage(["plates"], { only: "S2" }, source, [adopted, passed("keyframe", "S1"), passed("keyframe", "S2")], ["S1"])).toThrow("范围");
  });
  it.each([{ ok: false }, { degraded: true }, { invoked: true }, { cached: false }, { cached: undefined }, { shotId: "S2" }])("rejects an invalid adoption record %j", change => {
    expect(() => assertFilmStageCoverage(["spec", "plates", "videos"], {}, source, [{ ...adopted, ...change }, ...pending], ["S1"])).toThrow("官方验证");
  });
  it("only makes global preparation inapplicable when every selected shot is currently adopted", () => {
    expect(() => assertFilmStageCoverage(["cine-kb", "continuity", "micromotion"], { only: "S1" }, source, [adopted], ["S1"])).not.toThrow();
    expect(() => assertFilmStageCoverage(["continuity"], {}, source, [adopted], ["S1"])).toThrow("continuity");
    for (const ids of [["FOREIGN"], ["S1", "S1"]]) expect(() => assertFilmStageCoverage(["plates"], {}, source, [adopted], ids)).toThrow("本次官方任务");
  });
});


describe("worker 当前父通道默认后期回执", () => {
  const prepare = (stage: ProducerGateOptions["stage"] = "compose") => {
    const value = fixture({}, {}, [stage === "shot" ? "videos" : stage]);
    const file = join(value.context.workDir, "raw-black-silent.mp4");
    const media = spawnSync(process.env.WL_FFMPEG ?? "ffmpeg", ["-v", "error", "-nostdin", "-n", "-f", "lavfi", "-i",
      "color=black:s=162x122:r=23", "-vf", "crop=161:121:exact=1", "-frames:v", "5", "-an", "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv444p", file],
      { encoding: "utf8", timeout: 30_000 });
    expect(media.status, media.stderr).toBe(0);
    const options: Omit<ProducerGateOptions, "contracts"> = { stage, projectId: value.context.projectId, artifacts: [{ path: file, kind: "video" }],
      deterministic: [{ id: "wardrobe-quality", pass: false, hard: true, detail: "obsolete quality veto" }],
      minScore: Number.NaN, requiredCheckIds: ["obsolete-quality"], referenceImages: [join(value.root, "missing-quality-reference.png")],
      rubric: ["obsolete raw-source quality score"], context: stage === "shot" ? { shotId: "S1" } : {} };
    const response = (frame: FilmChannelRequestFrame) => {
      const params = frame.params as ProducerGateOptions;
      return postProcessingVerdict({ ...params, artifacts: (params.artifacts as unknown as Array<{ ref: string; kind: "video" }>).map((artifact) =>
        ({ path: join(value.context.workDir, artifact.ref), kind: artifact.kind })), env: { ...process.env } });
    };
    value.setReply(response);
    return { ...value, file, options, response };
  };
  it.each([...POST_RENDER_STAGES])("%s 接收实际文件的无品质回执，不要求创作合同或读取品质参数", async stage => {
    const value = prepare(stage), before = hash(readFileSync(value.file));
    const result = await value.worker.review(value.options);
    expect(result).toMatchObject({ stage, approved: true, status: "passed", score: null, qualityReviewed: false, rerun: false, via: "deterministic" });
    expect(result.contractHash).toBeUndefined(); expect(hash(readFileSync(value.file))).toBe(before);
    expect(value.frames.map(frame => frame.method)).toEqual(["gate.review"]);
    const params = value.frames[0]!.params as Record<string, unknown>;
    for (const key of ["referenceImages", "requiredCheckIds", "minScore", "rubric"]) expect(Object.hasOwn(params, key)).toBe(false);
    expect(value.frames[0]!.stepKey).toBe(stage === "shot" ? "videos:S1" : stage); value.worker.channel.dispose();
  });
  it("实际加工失败返回失败终态，不被合同兼容或默认接收洗成通过", async () => {
    const value = prepare();
    value.options.deterministic.push({ id: "tool-exit", pass: false, hard: true, detail: "actual ffmpeg exited 51" });
    const result = await value.worker.review(value.options);
    expect(result).toMatchObject({ approved: false, status: "failed", score: null, qualityReviewed: false, rerun: false });
    expect(result.hardFailures).toEqual(["tool-exit: actual ffmpeg exited 51"]); value.worker.channel.dispose();
  });
  it.each(["score", "quality", "rerun", "status", "hard-failures", "missing-quality-marker"])("拒绝父通道 %s 伪品质/不完整回执", async defect => {
    const value = prepare();
    value.setReply(frame => { const receipt = value.response(frame);
      if (defect === "score") receipt.score = 100;
      if (defect === "quality") receipt.qualityReviewed = true;
      if (defect === "rerun") receipt.rerun = true;
      if (defect === "status") receipt.status = "failed";
      if (defect === "hard-failures") receipt.hardFailures = ["actual error"];
      if (defect === "missing-quality-marker") delete receipt.qualityReviewed;
      return receipt;
    });
    await expect(value.worker.review(value.options)).rejects.toMatchObject({ code: "REVIEW_UNVERIFIED" }); value.worker.channel.dispose();
  });
  it.each(["artifact", "input"])("当前父通道期间 %s 字节改变不能继承旧通过", async kind => {
    const value = prepare();
    value.setReply(frame => { const receipt = value.response(frame); writeFileSync(kind === "artifact" ? value.file : value.worker.inputPath, "changed during parent response"); return receipt; });
    await expect(value.worker.review(value.options)).rejects.toMatchObject({ code: kind === "artifact" ? "ARTIFACT_CHANGED" : "INPUT_CHANGED" }); value.worker.channel.dispose();
  });
});
