import { afterEach, describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
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

describe("worker verified local video normalization", () => {
  const prepare = async (stage = "videos") => {
    const value = fixture({ shots: [{ shotId: "S1", duration: 4 }] }, undefined, ["videos", "material-gen"]);
    const target = join(value.context.workDir, "work", "clip.mp4");
    const video = await value.worker.video({ stage, shotId: "S1", target, prompt: "test", refs: [], seconds: 5, generateAudio: true });
    await value.worker.download(video.url, target);
    const reply = (frame: FilmChannelRequestFrame, changes: Record<string, unknown> = {}) => {
      const params = frame.params as Record<string, unknown>;
      const ref = String(changes.ref ?? params.targetRef);
      const bytes = Buffer.from(`normalized current copy: ${value.frames.length}`);
      const file = join(value.context.workDir, ref); mkdirSync(dirname(file), { recursive: true }); writeFileSync(file, bytes);
      return { ref, sha256: hash(bytes), bytes: bytes.length, normalization: { factor: 0.8, from: 5, to: 4 }, ...changes };
    };
    value.setReply((frame) => reply(frame));
    return { ...value, target, video, reply };
  };
  it("normalizes only the downloaded copy, retains provider bytes and replaces its registered fingerprint for later calls", async () => {
    const { worker, target, video, frames } = await prepare();
    const providerHash = hash(readFileSync(`${target}.provider.mp4`));
    expect(await worker.normalizeVideo(target, 4, "videos", "S1")).toEqual({ factor: 0.8, from: 5, to: 4 });
    expect(frames[2]).toMatchObject({ method: "media.fetch", stepKey: "videos:S1", shotId: "S1",
      params: { ref: "work/clip.mp4", targetRef: "work/clip.mp4", normalizeToSeconds: 4 } });
    expect(hash(readFileSync(target))).not.toBe(providerHash);
    expect(hash(readFileSync(`${target}.provider.mp4`))).toBe(video.submissionReceipt.artifact.sha256);
    await expect(worker.normalizeVideo(target, 4, "videos", "S1")).resolves.toEqual({ factor: 0.8, from: 5, to: 4 });
    expect(frames.map((frame) => frame.method)).toEqual(["video.generate", "media.fetch", "media.fetch", "media.fetch"]);
    worker.channel.dispose();
  });
  it("preserves the material stage when both video-generating stages are frozen", async () => {
    const { worker, target, frames } = await prepare("material-gen");
    await worker.normalizeVideo(target, 4, "material-gen", "S1");
    expect(frames[2]!.stepKey).toBe("material-gen:S1"); worker.channel.dispose();
  });
  it.each(["unknown", "wrong-stage", "wrong-shot", "provider-raw", "changed-copy", "changed-provider", "changed-input"])(
    "refuses %s before the normalization channel call", async (invalid) => {
      const { worker, context, target, frames } = await prepare();
      let selected = target; let stage = "videos"; let shotId = "S1";
      if (invalid === "unknown") { selected = join(context.workDir, "unknown.mp4"); writeFileSync(selected, "not issued"); }
      if (invalid === "wrong-stage") stage = "material-gen";
      if (invalid === "wrong-shot") shotId = "S2";
      if (invalid === "provider-raw") selected = `${target}.provider.mp4`;
      if (invalid === "changed-copy") writeFileSync(target, "changed without parent");
      if (invalid === "changed-provider") writeFileSync(`${target}.provider.mp4`, "changed preserved provider");
      if (invalid === "changed-input") writeFileSync(worker.inputPath, "{}");
      await expect(worker.normalizeVideo(selected, 4, stage, shotId)).rejects.toThrow(/VIDEO_NORMALIZATION_SOURCE_INVALID|ARTIFACT_CHANGED|INPUT_CHANGED/);
      expect(frames).toHaveLength(2); worker.channel.dispose();
    },
  );
  it.each([0, -1, Number.NaN, Number.POSITIVE_INFINITY])("rejects invalid target duration %s before dispatch", async (seconds) => {
    const { worker, target, frames } = await prepare();
    await expect(worker.normalizeVideo(target, seconds, "videos", "S1")).rejects.toThrow(/VIDEO_NORMALIZATION_INVALID/);
    expect(frames).toHaveLength(2); worker.channel.dispose();
  });
  it.each([
    ["missing", undefined], ["zero-factor", { factor: 0, from: 5, to: 4 }],
    ["string-factor", { factor: "0.8", from: 5, to: 4 }], ["wrong-target", { factor: 0.8, from: 5, to: 4.11 }],
    ["inconsistent-factor", { factor: 0.5, from: 5, to: 4 }], ["invalid-from", { factor: 0.8, from: -5, to: 4 }],
  ])("rejects %s normalization metadata even for current correctly hashed bytes", async (_name, normalization) => {
    const { worker, target, reply, setReply } = await prepare();
    setReply((frame) => reply(frame, { normalization }));
    await expect(worker.normalizeVideo(target, 4, "videos", "S1")).rejects.toThrow(/VIDEO_NORMALIZATION_INVALID/);
    worker.channel.dispose();
  });
  it("accepts real frame/AAC duration rounding and validates factor against requested duration", async () => {
    const { worker, target, reply, setReply } = await prepare();
    setReply((frame) => reply(frame, { normalization: { factor: 0.8, from: 5, to: 4.08 } }));
    await expect(worker.normalizeVideo(target, 4, "videos", "S1")).resolves.toEqual({ factor: 0.8, from: 5, to: 4.08 });
    worker.channel.dispose();
  });
  it("rejects an otherwise valid response that names another output and does not register it", async () => {
    const { worker, context, target, reply, setReply } = await prepare();
    setReply((frame) => reply(frame, { ref: "wrong-output.mp4" }));
    await expect(worker.normalizeVideo(target, 4, "videos", "S1")).rejects.toThrow(/VIDEO_NORMALIZATION_INVALID/);
    await expect(worker.download("film-artifact:wrong-output.mp4", join(context.workDir, "copy.mp4"))).rejects.toThrow(/URL_NOT_ISSUED/);
    worker.channel.dispose();
  });
  it.each(["provider", "input"])("rechecks preserved %s bytes after parent processing", async (changed) => {
    const { worker, target, reply, setReply } = await prepare();
    setReply((frame) => { const result = reply(frame); writeFileSync(changed === "provider" ? `${target}.provider.mp4` : worker.inputPath, "changed in channel"); return result; });
    await expect(worker.normalizeVideo(target, 4, "videos", "S1")).rejects.toThrow(/ARTIFACT_CHANGED|INPUT_CHANGED/);
    worker.channel.dispose();
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
