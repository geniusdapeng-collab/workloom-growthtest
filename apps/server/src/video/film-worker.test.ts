import { afterEach, describe, expect, it, vi } from "vitest";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { filmWorkerEnvironment, validateFilmChannelScope, handleChannelRequest, verifyCompletedFilmOriginals, type RunContext } from "./film-worker.js";
import { FILM_CHANNEL_METHOD_COMPONENT, filmRequestHash, FullChainFilmWorker, POST_RENDER_STAGES, type ProducerGateOptions, type FilmChannelTransport, type FilmWorkerJobContext, type FilmChannelRequestFrame } from "@hyperreality/video-studio";
import { pathToFileURL } from "node:url";

describe("parent independently revalidates actual completed originals", () => {
  const roots: string[] = [];
  afterEach(() => roots.splice(0).forEach(root => rmSync(root, { recursive: true, force: true })));
  const prepare = async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "parent-adopt-original-"))); roots.push(root);
    const projectId = "PARENT-OFFLINE-ADOPT", bytes = Buffer.from(JSON.stringify({ projectId, shots: [{ shotId: "S1", duration: 4 }, { shotId: "S2", duration: 4 }] }));
    const moduleFile = join(import.meta.dirname, "../../../../scripts/tools/film-standard-post.mts");
    const { freezeOriginalSubmission, issueOriginalRenderReceipt } = await import(pathToFileURL(moduleFile).href);
    const submitted = await freezeOriginalSubmission({ productionRoot: root, projectId, bytes });
    const file = join(root, "clips", projectId, "S1.mp4"); mkdirSync(join(root, "clips", projectId), { recursive: true });
    const encoded = spawnSync(process.env.WL_FFMPEG ?? "ffmpeg", ["-v", "error", "-nostdin", "-n", "-f", "lavfi", "-i", "color=black:s=64x64:r=24:d=4",
      "-an", "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", file], { encoding: "utf8", timeout: 30_000 });
    expect(encoded.status, encoded.stderr).toBe(0);
    const taskId = "offline-current-task-S1", accepted = join(root, "logs", projectId, "accepted-tasks"); mkdirSync(accepted, { recursive: true });
    writeFileSync(join(accepted, "S1.json"), JSON.stringify({ schemaVersion: "workloom.render-task/v1", state: "accepted", taskId, requestHash: createHash("sha256").update("offline original request").digest("hex") }));
    await issueOriginalRenderReceipt({ productionRoot: root, projectId, shotId: "S1", submittedSha256: submitted.sha256,
      artifactPath: file, taskId, requestInputVerified: true });
    return { root, file, projectId, submittedSha256: submitted.sha256, receipt: join(root, "logs", projectId, "original-issued", "S1.json") };
  };
  it("returns only currently issued source-byte-bound S1 and leaves pending S2 outside the exemption", async () => {
    const f = await prepare(), before = readFileSync(f.file);
    expect(await verifyCompletedFilmOriginals({ productionRoot: f.root, projectId: f.projectId, submittedSha256: f.submittedSha256 })).toEqual(["S1"]);
    expect(readFileSync(f.file)).toEqual(before);
  });
  it.each(["changed-source", "missing-source", "tampered-receipt", "other-project", "other-submission"])("rejects %s despite any child adoption marker", async defect => {
    const f = await prepare();
    if (defect === "changed-source") writeFileSync(f.file, Buffer.concat([readFileSync(f.file), Buffer.from("changed")]));
    if (defect === "missing-source") rmSync(f.file);
    if (defect === "tampered-receipt") { const value = JSON.parse(readFileSync(f.receipt, "utf8")); value.artifact.sha256 = "a".repeat(64); writeFileSync(f.receipt, JSON.stringify(value)); }
    await expect(verifyCompletedFilmOriginals({ productionRoot: f.root, projectId: defect === "other-project" ? "OTHER" : f.projectId,
      submittedSha256: defect === "other-submission" ? "a".repeat(64) : f.submittedSha256 })).rejects.toThrow();
  });
});

describe("film worker child environment", () => {
  it("keeps public local tools while dropping every account, database, model and signing credential", () => {
    const env = filmWorkerEnvironment({ PATH: "/local/bin", WL_FFMPEG: "/local/ffmpeg", SEEDANCE_MODEL: "test-model", LLM_API_KEY: "mock-test-only-secret", DEEPSEEK_API_KEY: "mock-test-only-secret", DEEPSEEK_BASE_URL: "https://api.deepseek.com", JWT_SECRET: "mock-test-only-secret", CNB_TOKEN: "mock-test-only-secret", DATABASE_URL: "mock-test-only-secret", CUSTOMER_OAUTH_TOKEN: "mock-test-only-secret", NODE_OPTIONS: "--import arbitrary" });
    expect(env).toEqual({ PATH: "/local/bin", WL_FFMPEG: "/local/ffmpeg", SEEDANCE_MODEL: "test-model" });
  });
});

describe("standard original-native parent authority", () => {
  const frozen = { shots: [{ shotId: "NATIVE", duration: 5, speechMode: "on-camera", dialogue: [{ text: "原声" }] },
    { shotId: "VO", duration: 6, speechMode: "voice-over", dialogue: [{ text: "原稿台词" }] }, { shotId: "AMBIENT", duration: 4 }] };
  const scope = { stages: ["videos", "material-gen", "voice"], projectId: "MOCK-NATIVE", frozen,
    shotIds: new Set(["NATIVE", "VO", "AMBIENT"]), options: { aspect: "9:16", resolution: "1080p" } };
  const frame = (method: string, sid: string, params: unknown): FilmChannelRequestFrame => ({ kind: "film.request", id: "mock-request", method,
    component: FILM_CHANNEL_METHOD_COMPONENT[method]!, stepKey: `${method === "voice.dub" ? "voice" : "videos"}:${sid}`, shotId: sid,
    params, idempotencyKey: "mock-idempotency", requestHash: "mock-scope-only" });
  it.each(["NATIVE", "VO", "AMBIENT"])("rejects local dubbing for %s before reservation", sid => {
    expect(() => validateFilmChannelScope(frame("voice.dub", sid, { text: "原稿台词" }), scope)).toThrow("AUDIO_NATIVE_SOURCE_REPLACED");
  });
  it.each([["VO", 6], ["AMBIENT", 4]])("requires rendered native audio for %s", (sid, seconds) => {
    expect(() => validateFilmChannelScope(frame("video.generate", String(sid), { prompt: "mock", refs: [], seconds, generateAudio: false,
      aspect: "9:16", resolution: "1080p", targetRef: `clips/${sid}.mp4` }), scope)).toThrow("AUDIO_NATIVE_GENERATION_REQUIRED");
  });
  it("refuses retiming before any parent component is reserved", () => {
    expect(() => validateFilmChannelScope(frame("media.fetch", "NATIVE", { ref: "clips/NATIVE.raw.mp4", targetRef: "clips/NATIVE.mp4", normalizeToSeconds: 5 }), scope))
      .toThrow("STANDARD_NATIVE_RETIME_FORBIDDEN");
  });
  it.each([3, 5.5, 13])("does not clamp or round submitted duration %s for generation", duration => {
    const changed = { ...scope, frozen: { shots: [{ shotId: "NATIVE", duration }] } };
    expect(() => validateFilmChannelScope(frame("video.generate", "NATIVE", { prompt: "mock", refs: [], seconds: Math.min(12, Math.max(4, Math.round(duration))),
      generateAudio: true, aspect: "9:16", resolution: "1080p", targetRef: "clips/NATIVE.mp4" }), changed)).toThrow("DURATION_FROZEN_MISMATCH");
  });
});

describe("film parent frozen method and shot scope", () => {
  const scope = { stages: ["cine-kb", "plates", "videos", "material-gen", "voice", "cover", "spec", "continuity"], projectId: "project-a", shotIds: new Set(["S1", "S2"]) };
  const frame = (method: string, stepKey: string, shotId: string | null, params: unknown = {}): FilmChannelRequestFrame => ({
    kind: "film.request", id: "request-a", method, component: FILM_CHANNEL_METHOD_COMPONENT[method]!,
    stepKey, shotId, params, idempotencyKey: "idempotency-a", requestHash: "unused-by-scope-validation",
  });
  it.each([
    ["image.generate", "cine-kb:S1", "S1", "METHOD_STAGE_MISMATCH"],
    ["video.generate", "plates:S1", "S1", "METHOD_STAGE_MISMATCH"],
    ["image.generate", "plates:S1", "S2", "STEP_SHOT_MISMATCH"],
    ["image.generate", "plates", "S1", "STEP_SHOT_MISMATCH"],
    ["image.generate", "plates:S1:extra", "S1", "STEP_SHOT_MISMATCH"],
    ["image.generate", "plates", null, "SHOT_NOT_FOUND"],
    ["voice.dub", "videos:S1", "S1", "METHOD_STAGE_MISMATCH"],
    ["llm.chat", "spec", null, "METHOD_STAGE_MISMATCH"],
    ["media.fetch", "cover", null, "METHOD_STAGE_MISMATCH"],
    ["image.generate", "outside:S1", "S1", "STEP_OUT_OF_SCOPE"],
    ["image.generate", "plates:S3", "S3", "SHOT_NOT_FOUND"],
  ])("rejects %s at %s bound to %s", (method, stepKey, shotId, error) => {
    expect(() => validateFilmChannelScope(frame(String(method), String(stepKey), shotId as string | null), scope)).toThrow(String(error));
  });
  it("accepts registered component routes and bound step keys", () => {
    for (const [method, stage, shot] of [["image.generate", "plates", "S1"], ["video.generate", "videos", "S1"], ["video.generate", "material-gen", "S2"], ["voice.dub", "voice", "S1"], ["voice.verify", "voice", "S2"], ["llm.chat", "cover", null], ["media.fetch", "plates", null]] as const) {
      expect(() => validateFilmChannelScope(frame(method, shot === null ? stage : `${stage}:${shot}`, shot), scope)).not.toThrow();
    }
  });
  it("binds review aliases, project, shot and material source before reservation", () => {
    const review = (stage: string, key: string, shotId: string | null, context: object = {}) => frame("gate.review", key, shotId, { projectId: "project-a", stage, context });
    expect(() => validateFilmChannelScope(review("prompt", "spec", null), scope)).not.toThrow();
    expect(() => validateFilmChannelScope(review("continuity", "continuity", null), scope)).not.toThrow();
    expect(() => validateFilmChannelScope(review("shot", "material-gen:S1", "S1", { shotId: "S1", sourceStage: "material-gen" }), scope)).not.toThrow();
    expect(() => validateFilmChannelScope(review("prompt", "plates", null), scope)).toThrow("METHOD_STAGE_MISMATCH");
    expect(() => validateFilmChannelScope(frame("gate.review", "spec", null, { projectId: "other", stage: "prompt" }), scope)).toThrow("REVIEW_SCOPE_INVALID");
    expect(() => validateFilmChannelScope(review("keyframe", "plates:S1", "S1", { shotId: "S2" }), scope)).toThrow("REVIEW_SCOPE_INVALID");
    expect(() => validateFilmChannelScope(review("shot", "material-gen:S1", "S1", { shotId: "S1", sourceStage: "videos" }), scope)).toThrow("REVIEW_SCOPE_INVALID");
  });
  it("denies a frozen source shot outside an explicit only selection", () => {
    expect(() => validateFilmChannelScope(frame("image.generate", "plates:S2", "S2"), { ...scope, shotIds: new Set(["S1"]) })).toThrow("SHOT_NOT_FOUND");
  });
});

describe("film parent frozen audio and format authority", () => {
  const frozen = { shots: [
    { shotId: "S1", durationSec: 5, speechMode: "on-camera", dialogue: [{ text: "同源对白" }] },
    { shotId: "S2", durationSec: 6, speechMode: "voice-over", dialogue: [{ text: "画外旁白" }] },
    { shotId: "S3", durationSec: 4 },
  ] };
  const scope = { stages: ["videos", "voice"], projectId: "P1", shotIds: new Set(["S1", "S2", "S3"]),
    frozen, options: { aspect: "16:9", resolution: "720p" } };
  const frame = (method: string, shotId: string, params: unknown): FilmChannelRequestFrame => ({ kind: "film.request", id: "test", method,
    component: FILM_CHANNEL_METHOD_COMPONENT[method]!, stepKey: `${method === "video.generate" ? "videos" : "voice"}:${shotId}`,
    shotId, params, idempotencyKey: "test", requestHash: "scope-validation-only" });
  const video = { prompt: "实际镜头提示词", refs: [], targetRef: "clips/S1.provider.mp4", seconds: 5,
    aspect: "16:9", resolution: "720p", generateAudio: true };
  it("rejects replacement of native on-camera dialogue before the component reservation boundary", () => {
    expect(() => validateFilmChannelScope(frame("voice.dub", "S1", { text: "同源对白" }), scope)).toThrow("AUDIO_NATIVE_SOURCE_REPLACED");
    expect(() => validateFilmChannelScope(frame("voice.dub", "S2", { text: "画外旁白" }), scope)).toThrow("AUDIO_NATIVE_SOURCE_REPLACED");
    expect(() => validateFilmChannelScope(frame("voice.dub", "S3", { text: "额外旁白" }), scope)).toThrow("AUDIO_NATIVE_SOURCE_REPLACED");
  });
  it("binds verification and permitted narration text to the exact frozen shot", () => {
    expect(() => validateFilmChannelScope(frame("voice.verify", "S1", { expectText: "同源对白" }), scope)).not.toThrow();
    expect(() => validateFilmChannelScope(frame("voice.verify", "S1", { expectText: "其它文本" }), scope)).toThrow("AUDIO_TEXT_MISMATCH");
    expect(() => validateFilmChannelScope(frame("voice.dub", "S2", { text: "其它文本" }), scope)).toThrow("AUDIO_NATIVE_SOURCE_REPLACED");
  });
  it.each([
    [{ ...video, aspect: "9:16" }, "FORMAT_FROZEN_MISMATCH"],
    [{ ...video, resolution: "1080p" }, "FORMAT_FROZEN_MISMATCH"],
    [{ ...video, seconds: 12 }, "DURATION_FROZEN_MISMATCH"],
    [{ ...video, generateAudio: false }, "AUDIO_NATIVE_GENERATION_REQUIRED"],
    [{ ...video, generateAudio: "false" }, "REQUEST_INVALID"],
    [{ ...video, refs: ["a", "b", "c", "d"] }, "REFERENCE_LIMIT_EXCEEDED"],
  ])("rejects altered frozen request %j", (params, code) => {
    expect(() => validateFilmChannelScope(frame("video.generate", "S1", params), scope)).toThrow(String(code));
  });
  it("requires native audio for voice-over while preserving source format authority", () => {
    expect(() => validateFilmChannelScope(frame("video.generate", "S1", video), scope)).not.toThrow();
    expect(() => validateFilmChannelScope(frame("video.generate", "S2", { ...video, seconds: 6, generateAudio: false }), scope)).toThrow("AUDIO_NATIVE_GENERATION_REQUIRED");
    expect(() => validateFilmChannelScope(frame("video.generate", "S1", { ...video, resolution: "1080p" }),
      { ...scope, options: { aspect: "16:9", resolution: "2160p" } })).not.toThrow();
  });
});


describe("真实父处理器与固定工位 IPC 的默认后期", () => {
  const roots: string[] = [];
  afterEach(() => { vi.restoreAllMocks(); roots.splice(0).forEach(root => rmSync(root, { recursive: true, force: true })); });
  const prepare = (stage: ProducerGateOptions["stage"] = "compose") => {
    const archive = realpathSync(mkdtempSync(join(tmpdir(), "parent-worker-post-"))); roots.push(archive);
    const workDir = join(archive, "jobs", "attempt-1"); mkdirSync(workDir, { recursive: true });
    const source = JSON.stringify({ projectId: "LOCAL-PARENT-POST", shots: [{ shotId: "S1", duration: 5 }] });
    writeFileSync(join(archive, "source.json"), source);
    const file = join(workDir, "black-odd-silent.mp4");
    const encoded = spawnSync(process.env.WL_FFMPEG ?? "ffmpeg", ["-v", "error", "-nostdin", "-n", "-f", "lavfi", "-i", "color=black:s=162x122:r=23",
      "-vf", "crop=161:121:exact=1", "-frames:v", "5", "-an", "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv444p", file], { encoding: "utf8", timeout: 30_000 });
    expect(encoded.status, encoded.stderr).toBe(0);
    const hash = (bytes: string | Buffer) => createHash("sha256").update(bytes).digest("hex");
    const sourceStage = stage === "shot" ? "videos" : stage;
    const context: FilmWorkerJobContext = { jobId: "FJ-POST", tenantId: "t", workspaceId: "w", projectId: "LOCAL-PARENT-POST", attempt: 1, runId: "run-current",
      workerName: "full-chain-film", workerVersion: "v1", stages: [sourceStage], options: {}, archiveRoot: archive, workDir,
      inputRef: "source.json", inputSha256: hash(source), budgetCny: 0, deadlineAt: new Date(Date.now() + 30_000).toISOString(), allowedMethods: ["gate.review"] };
    const reserves: Array<Record<string, unknown>> = [], dispatches: unknown[][] = [], accepted: unknown[][] = [], failures: unknown[][] = [];
    const ledger = { reserveComponent: async (request: Record<string, unknown>) => { reserves.push(request); return { row: { id: "COMP-POST" }, deduped: false }; },
      claimComponent: async () => ({ id: "COMP-POST" }), recordDispatch: async (...args: unknown[]) => { dispatches.push(args); },
      recordComponentAccepted: async (...args: unknown[]) => { accepted.push(args); }, recordComponentFailure: async (...args: unknown[]) => { failures.push(args); } };
    const parent = { env: { ...process.env, LLM_API_KEY: "", VOLCENGINE_ARK_API_KEY: "" }, job: { id: context.jobId, project_id: context.projectId, attempt: 1,
      stages: context.stages, options: { "review-policy": "blocking" } }, worker: { capabilities: ["gate.review"] }, ledger,
      workDir, archiveRoot: archive, frozen: JSON.parse(source), shots: new Map([["S1", { shotId: "S1", duration: 5 }]]),
      ownerToken: "LOCAL-IN-MEMORY-LEDGER", signal: new AbortController().signal, deadlineAt: Date.now() + 30_000 } as unknown as RunContext;
    let listener: ((frame: unknown) => void) | undefined;
    const frames: FilmChannelRequestFrame[] = [];
    const transport: FilmChannelTransport = { subscribe(handler) { listener = handler; return () => { listener = undefined; }; }, send(raw) {
      const frame = JSON.parse(raw) as FilmChannelRequestFrame; frames.push(frame);
      void handleChannelRequest(parent, frame).then(result => listener?.(JSON.stringify({ kind: "film.response", id: frame.id, ok: true, result })),
        error => listener?.(JSON.stringify({ kind: "film.response", id: frame.id, ok: false, error: { code: error.code ?? "PARENT_FAILED", message: error.message } })));
    } };
    const worker = new FullChainFilmWorker(context, archive, transport);
    const options: Omit<ProducerGateOptions, "contracts"> = { stage, projectId: context.projectId, artifacts: [{ path: file, kind: "video" }],
      deterministic: [{ id: "old-quality", pass: false, hard: true, detail: "historical clothes/black/dialogue score failed" }],
      context: stage === "shot" ? { shotId: "S1" } : {}, minScore: Number.NaN, referenceImages: [join(archive, "missing-quality-image.png")] };
    return { parent, worker, options, file, frames, reserves, dispatches, accepted, failures, before: hash(readFileSync(file)), hash };
  };
  it.each([...POST_RENDER_STAGES])("%s 贯通真实父处理器与子通道，零模型预算且无创作合同依赖", async stage => {
    const value = prepare(stage), fetch = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("UNEXPECTED_MODEL_CALL"));
    const result = await value.worker.review(value.options);
    expect(result).toMatchObject({ approved: true, status: "passed", score: null, qualityReviewed: false, rerun: false, via: "deterministic" });
    expect(result.contractHash).toBeUndefined(); expect(value.reserves).toHaveLength(1); expect(value.reserves[0]!.reservedCny).toBe(0);
    expect(value.dispatches).toHaveLength(1); expect(value.accepted).toHaveLength(1); expect(value.failures).toEqual([]);
    expect(fetch).not.toHaveBeenCalled(); expect(value.frames.map(frame => frame.method)).toEqual(["gate.review"]);
    expect(value.hash(readFileSync(value.file))).toBe(value.before); value.worker.channel.dispose();
  });
  it("直接父请求的旧品质分数/参考/要求名单不触发隐藏参数或模型准入", async () => {
    const value = prepare(), params = { stage: "compose", projectId: "LOCAL-PARENT-POST", artifacts: [{ ref: "black-odd-silent.mp4", kind: "video" }],
      deterministic: [], context: {}, minScore: "obsolete-not-a-score", referenceImages: ["../../missing.png"], requiredCheckIds: [null], rubric: [null] };
    const frame: FilmChannelRequestFrame = { kind: "film.request", id: "DIRECT-POST", component: "review", method: "gate.review", stepKey: "compose", shotId: null,
      params, idempotencyKey: "direct-current", requestHash: filmRequestHash({ method: "gate.review", stepKey: "compose", shotId: null, params }) };
    expect(await handleChannelRequest(value.parent, frame)).toMatchObject({ approved: true, score: null, qualityReviewed: false }); value.worker.channel.dispose();
  });
  it("真实工具错误终态保持失败，父服务不会发品质重渲或假通过", async () => {
    const value = prepare(); value.options.deterministic.push({ id: "tool-exit", pass: false, hard: true, detail: "real subprocess error" });
    const result = await value.worker.review(value.options);
    expect(result).toMatchObject({ approved: false, status: "failed", score: null, qualityReviewed: false, rerun: false });
    expect(result.hardFailures).toEqual(["tool-exit: real subprocess error"]); value.worker.channel.dispose();
  });
});
