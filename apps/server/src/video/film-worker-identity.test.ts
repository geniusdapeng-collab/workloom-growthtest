/** Parent channel integration: real compiler/provider adapters, local media, and post processing.
 * Only the HTTP boundary and database ledger are replaced. These fixtures are not model
 * likeness certification, real authorization registration, or a paid supplier render.
 */
import { createHash, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  buildCharacterIdentityReviewRequest, buildProducerReviewContract, buildRegisteredCharacterReleaseSource,
  characterReleaseHash, filmCanonicalJson, filmRequestHash, filmReviewContracts, generationIdentityLock,
  FILM_CHANNEL_METHOD_COMPONENT, FILM_CHANNEL_METHODS, REAL_PERSON_ASSET_SCHEMA, resolveEraProfile,
  type FilmChannelRequestFrame, type FilmVideoSubmissionReceipt, type ProducerVerdict,
} from "@hyperreality/video-studio";
import { canonicalRenderJson, renderSha256 } from "./gen/compiled-request.js";
import type { FilmComponentRow, FilmJobRow, FilmLedger, FilmWorkerRow } from "./film-ledger.js";
import type { RunContext } from "./film-worker.js";

const ffmpeg = process.env.WL_FFMPEG ?? "ffmpeg";
const ffprobe = process.env.WL_FFPROBE ?? "ffprobe";
const hash = (value: Buffer | string): string => createHash("sha256").update(value).digest("hex");
const hashFile = (file: string): string => hash(readFileSync(file));
const temporary: string[] = [];
const projectId = "VID-PARENT-IDENTITY";
const providerBase = "https://provider.test/api/v3";
const modelBase = "https://review.test/api/v1";
const outputUrl = "https://artifact.test/current-provider.mp4";
const issuedImageUrl = "https://artifact.test/current-plate.png";
const anchorPng = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aD1sAAAAASUVORK5CYII=", "base64");
let mediaRoot = "";
let videoBytes: Buffer;
let plateBytes: Buffer;
let shorterVideoBytes: Buffer;
let silentVideoBytes: Buffer;
let otherVideo: string;
let handle: typeof import("./film-worker.js").handleChannelRequest;

beforeAll(async () => {
  // Set before the dynamic import; use the real timer/poll loop without ten second waits.
  vi.stubEnv("FILM_VIDEO_POLL_MS", "1");
  vi.stubEnv("WL_FFMPEG", ffmpeg);
  vi.stubEnv("WL_FFPROBE", ffprobe);
  handle = (await import("./film-worker.js")).handleChannelRequest;
  mediaRoot = realpathSync(mkdtempSync(join(tmpdir(), "film-parent-real-media-")));
  const video = join(mediaRoot, "current.mp4");
  otherVideo = join(mediaRoot, "unrelated.mp4");
  for (const [file, source] of [[video, "testsrc2=size=90x160:rate=24"], [otherVideo, "color=c=red:size=90x160:rate=24"]]) {
    execFileSync(ffmpeg, ["-v", "error", "-y", "-f", "lavfi", "-i", source!, "-f", "lavfi", "-i", "sine=frequency=523:sample_rate=48000",
      "-t", "4", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", file!], { timeout: 30_000 });
  }
  videoBytes = readFileSync(video);
  const plate = join(mediaRoot, "plate.png");
  execFileSync(ffmpeg, ["-v", "error", "-y", "-i", video, "-frames:v", "1", plate], { timeout: 30_000 });
  plateBytes = readFileSync(plate);
  const shorter = join(mediaRoot, "shorter.mp4"), silent = join(mediaRoot, "silent.mp4");
  execFileSync(ffmpeg, ["-v", "error", "-y", "-i", video, "-t", "3.5", "-c", "copy", shorter], { timeout: 30_000 });
  execFileSync(ffmpeg, ["-v", "error", "-y", "-i", video, "-an", "-c:v", "copy", silent], { timeout: 30_000 });
  shorterVideoBytes = readFileSync(shorter); silentVideoBytes = readFileSync(silent);
});
afterEach(() => {
  vi.unstubAllGlobals();
  for (const dir of temporary.splice(0)) rmSync(dir, { recursive: true, force: true });
});
afterAll(() => { vi.unstubAllEnvs(); rmSync(mediaRoot, { recursive: true, force: true }); });

function jsonFile(file: string, value: unknown): void {
  mkdirSync(dirname(file), { recursive: true }); writeFileSync(file, JSON.stringify(value, null, 2));
}

function fixture(policy = "blocking", options: { multiCharacter?: boolean; only?: string } = {}) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "film-parent-identity-"))); temporary.push(root);
  const workDir = join(root, "work"), assets = join(root, "assets"), characters = join(root, "characters");
  mkdirSync(workDir); mkdirSync(join(workDir, "clips")); mkdirSync(join(workDir, "review"));
  const profileFile = join(assets, "primary", "profile.json");
  const asset = {
    schemaVersion: REAL_PERSON_ASSET_SCHEMA, assetId: "asset-primary", displayName: "测试授权主讲人",
    certified: { gender: "female", source: "仅本地夹具中的登记事实" }, anchorPhoto: "anchor.png",
    assetGroupId: "group-fixture", referenceAssets: ["asset-close", "asset-side"],
    authorization: { status: "real-authorized", scope: "仅本地合同测试", evidence: "测试夹具；没有现实平台授权" },
  };
  jsonFile(profileFile, asset); writeFileSync(join(dirname(profileFile), "anchor.png"), anchorPng);
  jsonFile(join(characters, "model", "profile.json"), { id: "model-test", name: "测试人物",
    wardrobe: [{ id: "black-suit", name: "黑色商务套装", detail: "西装翻领，不添加第二个人" }] });
  const registryFile = join(characters, "registry.json");
  jsonFile(registryFile, { defaultModel: "model-test", models: [{ id: "model-test", name: "测试人物", aliases: [] }] });
  const actorShot = (shotId: string) => ({ shotId, duration: 4, assetRef: "asset://asset-primary", character: "测试人物",
    sceneDescription: "摄影棚内的哑光背景板前", lighting: "摄影灯从左侧照射", composition: "人物正面中景",
    subject: { kind: "person", count: 1 }, action: "站在摄影棚中开口说出同源对白", speechMode: "on-camera", dialogue: [{ text: "同源对白" }] });
  const shots: Array<Record<string, unknown>> = [actorShot("S1"), actorShot("S2"),
    { shotId: "P1", duration: 4, subject: { kind: "product", count: 0 }, action: "商品缓慢旋转", sceneDescription: "摄影棚的玻璃台面", lighting: "摄影灯照射商品" },
    { shotId: "V1", duration: 4, subject: { kind: "product", count: 0 }, action: "商品展示", sceneDescription: "摄影棚的玻璃台面", lighting: "摄影灯照射商品", speechMode: "voice-over", dialogue: [{ text: "画外旁白" }] }];
  if (options.multiCharacter) {
    const second = { ...asset, assetId: "asset-secondary", displayName: "测试另一授权人物",
      assetGroupId: "group-secondary", referenceAssets: ["asset-secondary-close", "asset-secondary-side"] };
    const secondProfile = join(assets, "secondary", "profile.json");
    jsonFile(secondProfile, second); writeFileSync(join(dirname(secondProfile), "anchor.png"), anchorPng);
    for (const id of ["T1", "T2"]) shots.push({ ...actorShot(id), assetRef: "asset://asset-secondary", characterId: "second-person" });
  }
  const frozen = { shots, character: { id: "model-test" }, aspect: "9:16", resolution: "1080p",
    eraProfile: resolveEraProfile({ storyDate: "2026-10-05" }) };
  const registrationRoots = { assetLibraryRoot: assets, characterLibraryRoots: [characters], registryFile };
  const source = buildRegisteredCharacterReleaseSource({ ...registrationRoots, projectId, shots, character: frozen.character });
  expect(source.contract.status).toBe("passed");
  let sequence = 0;
  const ledger = {
    reserveComponent: vi.fn(async (..._args: Parameters<FilmLedger["reserveComponent"]>) => ({ row: { id: `component-${++sequence}`, state: "reserved" } as FilmComponentRow, deduped: false })),
    claimComponent: vi.fn(async (id: string, _owner: string) => ({ id, state: "dispatched" } as FilmComponentRow)),
    recordDispatch: vi.fn(async (..._args: Parameters<FilmLedger["recordDispatch"]>) => undefined),
    recordComponentAccepted: vi.fn(async (..._args: Parameters<FilmLedger["recordComponentAccepted"]>) => undefined),
    recordComponentFailure: vi.fn(async (..._args: Parameters<FilmLedger["recordComponentFailure"]>) => undefined),
  };
  const job: FilmJobRow = { id: "job-fixture", seq: "1", tenant_id: "tenant-fixture", workspace_id: "workspace-fixture", project_id: projectId,
    attempt: 1, run_id: "run-fixture", input_sha256: hash(filmCanonicalJson(frozen)), stages: ["videos", "voice", "plates"],
    options: { "review-policy": policy, aspect: "9:16", resolution: "1080p", ...(options.only ? { only: options.only } : {}) },
    worker_id: "worker-fixture", status: "running", budget_cny: 100, input_ref: "frozen/input.json", worker_entry_sha256: "f".repeat(64),
    started_at: new Date(), finished_at: null, error_class: null, error_msg: null, result_ref: null, result_sha256: null, created_by: "test-author" };
  const worker: FilmWorkerRow = { id: "worker-fixture", tenant_id: "tenant-fixture", workspace_id: "workspace-fixture",
    worker_name: "full-chain-film", worker_version: "fixture", entry_path: "scripts/tools/full-chain-film.mts", entry_sha256: "f".repeat(64),
    capabilities: [...FILM_CHANNEL_METHODS], status: "active", registered_by: "test-author", registered_at: new Date(), updated_at: new Date() };
  const ctx: RunContext = {
    scope: { tenantId: "tenant-fixture", workspaceId: "workspace-fixture" },
    env: { PATH: process.env.PATH, WL_FFMPEG: ffmpeg, WL_FFPROBE: ffprobe,
      VOLCENGINE_ARK_API_KEY: "test-provider-key", SEEDANCE_ENDPOINT: providerBase, SEEDANCE_MODEL: "test-video-model",
      LLM_BASE_URL: modelBase, LLM_API_KEY: "test-model-key", LLM_MODEL: "test-visual-model" },
    job, worker, ledger: ledger as unknown as FilmLedger, workDir, archiveRoot: root,
    frozen, shots: new Map(shots.map(shot => [String(shot.shotId), shot])),
    contractSource: { projectId, shots, eraProfile: frozen.eraProfile }, registrationRoots,
    issuedUrls: new Map(), videoFiles: new Map(), identityEvidence: new Map(), ownerToken: "test-parent-owner",
    log: vi.fn(), send: vi.fn(), signal: new AbortController().signal, deadlineAt: Date.now() + 120_000,
  };
  const calls: Array<{ url: string; method: string; body?: Record<string, unknown> }> = [];
  const response = { approved: true, score: 94, issues: [] as string[], suggestions: [] as string[], reason: "mock边界返回身份和显式服饰均受当前样本支持" };
  const net = vi.fn(async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = String(input), method = init?.method ?? "GET";
    const body = typeof init?.body === "string" ? JSON.parse(init.body) as Record<string, unknown> : undefined;
    calls.push({ url, method, ...(body ? { body } : {}) });
    if (url === `${providerBase}/contents/generations/tasks` && method === "POST") return Response.json({ id: `supplier-task-${calls.length}` });
    if (url.startsWith(`${providerBase}/contents/generations/tasks/`) && method === "GET") return Response.json({ status: "succeeded", content: { video_url: outputUrl } });
    if (url === outputUrl && method === "GET") return new Response(Uint8Array.from(videoBytes), { headers: { "content-type": "video/mp4", "content-length": String(videoBytes.length) } });
    if (url === issuedImageUrl && method === "GET") return new Response(Uint8Array.from(anchorPng));
    if (url === `${modelBase}/chat/completions` && method === "POST") return Response.json({ choices: [{ message: { content: JSON.stringify(response) } }] });
    throw new Error(`Unexpected external call denied by fixture: ${method} ${url}`);
  });
  vi.stubGlobal("fetch", net);
  return { root, ctx, source, ledger, calls, net, response, profileFile, asset };
}
type Fixture = ReturnType<typeof fixture>;

function frame(method: string, shotId: string, params: unknown, stage = method.startsWith("voice.") ? "voice" : method === "image.generate" ? "plates" : "videos"): FilmChannelRequestFrame {
  const stepKey = `${stage}:${shotId}`;
  return { kind: "film.request", id: randomUUID(), method, component: FILM_CHANNEL_METHOD_COMPONENT[method]!, stepKey,
    shotId, params, idempotencyKey: randomUUID(), requestHash: filmRequestHash({ method, stepKey, shotId, params }) };
}
function videoParams(f: Fixture, shotId = "S1"): Record<string, unknown> {
  const actor = f.source.contract.shots.some(shot => shot.shotId === shotId);
  const identity = actor ? generationIdentityLock(f.source.contract, shotId) : undefined;
  return { prompt: `当前镜头 ${shotId} 的实际提示词${identity ? "\n" + identity.promptFragment : ""}`,
    refs: identity?.referenceAssets ?? [], seconds: 4, generateAudio: true, aspect: "9:16", resolution: "1080p",
    targetRef: `clips/${shotId}.provider.mp4` };
}
async function generate(f: Fixture, shotId = "S1", overrides: Record<string, unknown> = {}) {
  const params = { ...videoParams(f, shotId), ...overrides };
  const request = frame("video.generate", shotId, params);
  const result = await handle(f.ctx, request) as { ref: string; sha256: string; bytes: number; taskId: string; submissionReceipt: FilmVideoSubmissionReceipt };
  return { result, request, params };
}
async function prepareIdentity(f: Fixture, options: { shotId?: string } = {}) {
  const shotId = options.shotId ?? "S1";
  const generated = await generate(f, shotId);
  const clipRef = `clips/${shotId}.mp4`;
  const copied = await handle(f.ctx, frame("media.fetch", shotId, { ref: generated.result.ref, targetRef: clipRef })) as {
      ref: string; sha256: string; bytes: number;
    };
  const clipPath = join(f.ctx.workDir, clipRef);
  const duration = Number(JSON.parse(execFileSync(ffprobe, ["-v", "error", "-show_entries", "format=duration", "-of", "json", clipPath], { encoding: "utf8", timeout: 30_000 })).format.duration);
  expect(Number.isFinite(duration) && duration > 0).toBe(true);
  const frames = [duration * 0.2, duration * 0.75].map((atSec, index) => {
    const ref = `review/${shotId}-${index}.jpg`, file = join(f.ctx.workDir, ref);
    execFileSync(ffmpeg, ["-v", "error", "-y", "-ss", String(atSec), "-i", clipPath, "-frames:v", "1", "-vf", "scale=720:-2", file], { timeout: 30_000 });
    return { ref, sha256: hashFile(file), atSec };
  });
  const referenceRef = `review/${shotId}-registered-reference.png`;
  const person = f.source.contract.shots.find(row => row.shotId === shotId)!;
  copyFileSync(f.source.contract.characters.find(row => row.characterId === person.characterId)!.identityAnchor!.path, join(f.ctx.workDir, referenceRef));
  const request = buildCharacterIdentityReviewRequest({ contract: f.source.contract, shotId,
    clip: { path: clipPath, sha256: hashFile(clipPath) }, promptSha256: hash(String(generated.params.prompt)),
    frames: frames.map(row => ({ path: join(f.ctx.workDir, row.ref), sha256: row.sha256, atSec: row.atSec })),
    producerContractHash: buildProducerReviewContract(filmReviewContracts(f.ctx.contractSource, shotId)).contractHash });
  const params = { stage: "shot", projectId, artifacts: [{ ref: clipRef, kind: "video" }],
    deterministic: [{ id: "provider-success", pass: true, hard: true, detail: generated.result.taskId },
      { id: "source-bytes", pass: true, hard: true, detail: copied.sha256 },
      { id: "old-identity-opinion", pass: false, hard: true, detail: "Historical identity and clothing opinion is not a post processing veto" }],
    identityReview: { purpose: "identity-and-explicit-wardrobe", request,
    clipRef, frames, referenceRef, requestHash: request.requestHash }, context: { shotId, purpose: "identity-and-explicit-wardrobe" } };
  return { generated, copied, clipRef, clipPath, frames, referenceRef, request, params };
}
type Prepared = Awaited<ReturnType<typeof prepareIdentity>>;
function rehashRequest(prepared: Prepared): void {
  const { requestHash: _old, ...body } = prepared.request;
  prepared.request.requestHash = characterReleaseHash(body);
  prepared.params.identityReview.requestHash = prepared.request.requestHash;
}
function modelCalls(f: Fixture) { return f.calls.filter(call => call.url === `${modelBase}/chat/completions`); }
function providerOutput(f: Fixture, bytes: Buffer): void {
  const original = f.net.getMockImplementation()!;
  f.net.mockImplementation(async (input, init) => String(input) === outputUrl
    ? new Response(Uint8Array.from(bytes), { headers: { "content-type": "video/mp4", "content-length": String(bytes.length) } }) : original(input, init));
}
function resetLedger(f: Fixture): void { for (const fn of Object.values(f.ledger)) fn.mockClear(); }
async function rejectedBeforeReserve(f: Fixture, request: FilmChannelRequestFrame, error?: string): Promise<void> {
  resetLedger(f);
  const before = f.net.mock.calls.length;
  if (error) await expect(handle(f.ctx, request)).rejects.toThrow(error);
  else await expect(handle(f.ctx, request)).rejects.toBeInstanceOf(Error);
  expect(f.ledger.reserveComponent).not.toHaveBeenCalled();
  expect(f.ledger.claimComponent).not.toHaveBeenCalled();
  expect(f.ledger.recordDispatch).not.toHaveBeenCalled();
  expect(f.ledger.recordComponentAccepted).not.toHaveBeenCalled();
  expect(f.ledger.recordComponentFailure).not.toHaveBeenCalled();
  expect(f.net.mock.calls).toHaveLength(before);
}
async function reviewProcessed(f: Fixture, prepared: Prepared): Promise<ProducerVerdict> {
  resetLedger(f);
  const beforeCalls = f.net.mock.calls.length;
  const rawHash = hashFile(join(f.ctx.workDir, prepared.generated.result.ref)), clipHash = hashFile(prepared.clipPath);
  const verdict = await handle(f.ctx, frame("gate.review", prepared.request.shotId, prepared.params)) as ProducerVerdict;
  expect(verdict).toMatchObject({ approved: true, status: "passed", score: null, qualityReviewed: false,
    via: "deterministic", rerun: false, hardFailures: [] });
  expect(verdict).not.toHaveProperty("identityEvidence"); expect(verdict.contractHash).toBeUndefined();
  expect(f.ctx.identityEvidence.size).toBe(0); expect(modelCalls(f)).toHaveLength(0);
  expect(f.net.mock.calls).toHaveLength(beforeCalls);
  expect(f.ledger.reserveComponent).toHaveBeenCalledTimes(1);
  expect(f.ledger.reserveComponent.mock.calls[0]?.[0].reservedCny).toBe(0);
  expect(f.ledger.recordComponentAccepted).toHaveBeenCalledTimes(1);
  expect(f.ledger.recordComponentAccepted.mock.calls[0]?.[2]).toMatchObject({ evidence: { score: null, contractHash: null } });
  expect(f.ledger.recordComponentFailure).not.toHaveBeenCalled();
  expect(hashFile(join(f.ctx.workDir, prepared.generated.result.ref))).toBe(rawHash);
  expect(hashFile(prepared.clipPath)).toBe(clipHash);
  return verdict;
}

describe("actual parent channel refuses frozen audio, format, and reference alterations before budget", () => {
  it.each([
    ["native-dub", "voice.dub", "S1", { text: "同源对白", inputRef: "clips/S1.mp4", outputRef: "clips/S1.voiced.mp4", profile: "test" }, "AUDIO_NATIVE_SOURCE_REPLACED"],
    ["silent-extra-voice", "voice.dub", "P1", { text: "额外旁白" }, "AUDIO_NATIVE_SOURCE_REPLACED"],
    ["native-verify-text", "voice.verify", "S1", { expectText: "被修改的台词" }, "AUDIO_TEXT_MISMATCH"],
    ["voiceover-dub-text", "voice.dub", "V1", { text: "被修改的旁白" }, "AUDIO_NATIVE_SOURCE_REPLACED"],
  ])("%s enters the handler but never reserves or calls a supplier", async (_label, method, shot, params, code) => {
    const f = fixture(); await rejectedBeforeReserve(f, frame(method, shot, params), code);
  });
  it.each([
    ["native-audio-disabled", { generateAudio: false }, "AUDIO_NATIVE_GENERATION_REQUIRED"],
    ["audio-nonboolean", { generateAudio: "false" }, "REQUEST_INVALID"],
    ["frozen-aspect", { aspect: "16:9" }, "FORMAT_FROZEN_MISMATCH"],
    ["frozen-resolution", { resolution: "720p" }, "FORMAT_FROZEN_MISMATCH"],
    ["frozen-duration", { seconds: 9 }, "DURATION_FROZEN_MISMATCH"],
    ["refs-over-limit", { refs: ["a", "b", "c", "d"] }, "REFERENCE_LIMIT_EXCEEDED"],
    ["duplicate-refs", { refs: ["asset://asset-primary", "asset://asset-primary"] }, "REQUEST_INVALID"],
    ["omitted-identity-lock", { prompt: "没有身份与服饰锁的普通描述" }, "CHARACTER_GENERATION_INPUT_BLOCKED"],
    ["stale-character-assets", { refs: ["asset://asset-stale"] }, "CHARACTER_GENERATION_INPUT_BLOCKED"],
  ])("%s cannot cross actual budget reservation", async (_label, overrides, code) => {
    const f = fixture(); await rejectedBeforeReserve(f, frame("video.generate", "S1", { ...videoParams(f), ...overrides }), code);
  });
  it("requires the independently registered anchor before any person submission", async () => {
    const f = fixture(); delete (f.asset as Partial<typeof f.asset>).anchorPhoto; jsonFile(f.profileFile, f.asset);
    await rejectedBeforeReserve(f, frame("video.generate", "S1", videoParams(f)), "CHARACTER_SOURCE_ANCHOR_MISSING");
  });
  it("submits an authorized person request without any visual model configuration", async () => {
    const f = fixture(); delete f.ctx.env.LLM_API_KEY;
    const { result } = await generate(f);
    expect(result.submissionReceipt.shotId).toBe("S1"); expect(result.submissionReceipt.artifact.sha256).toBe(hash(videoBytes));
    expect(f.ledger.reserveComponent).toHaveBeenCalledTimes(1); expect(modelCalls(f)).toHaveLength(0);
  });
  it("denies a person first-frame override even with the correct asset group and full lock", async () => {
    const f = fixture(); writeFileSync(join(f.ctx.workDir, "review/override.png"), anchorPng);
    await rejectedBeforeReserve(f, frame("video.generate", "S1", { ...videoParams(f), firstFrame: { ref: "review/override.png" } }));
  });
  it.each([
    ["both first-frame selectors", { ref: "review/input.png", hostedUrl: issuedImageUrl }],
    ["empty first-frame object", {}],
    ["unknown first-frame selector", { path: "review/input.png" }],
  ])("refuses %s before a product request is charged", async (_label, firstFrame) => {
    const f = fixture(); writeFileSync(join(f.ctx.workDir, "review/input.png"), anchorPng);
    await rejectedBeforeReserve(f, frame("video.generate", "P1", { ...videoParams(f, "P1"), firstFrame }));
  });
  it("refuses both media fetch sources before reservation instead of silently picking url", async () => {
    const f = fixture(); writeFileSync(join(f.ctx.workDir, "review/input.png"), anchorPng);
    f.ctx.issuedUrls.set(issuedImageUrl, { stepKey: "plates:P1", shotId: "P1", artifact: { ref: "review/input.png", sha256: hash(anchorPng), bytes: anchorPng.length } });
    await rejectedBeforeReserve(f, frame("media.fetch", "P1", { url: issuedImageUrl, ref: "review/input.png", targetRef: "review/copy.png" }));
  });
  it("refuses an unissued hosted first frame before reservation", async () => {
    const f = fixture(); await rejectedBeforeReserve(f, frame("video.generate", "P1", { ...videoParams(f, "P1"), firstFrame: { hostedUrl: issuedImageUrl } }));
  });
  it("rehashes the actual issued first-frame file before reservation", async () => {
    const f = fixture(); writeFileSync(join(f.ctx.workDir, "review/input.png"), Buffer.concat([anchorPng, Buffer.from("changed")]));
    f.ctx.issuedUrls.set(issuedImageUrl, { stepKey: "plates:P1", shotId: "P1", artifact: { ref: "review/input.png", sha256: hash(anchorPng), bytes: anchorPng.length } });
    await rejectedBeforeReserve(f, frame("video.generate", "P1", { ...videoParams(f, "P1"), firstFrame: { hostedUrl: issuedImageUrl } }));
  });
});

describe("actual parent compiled submission, provider download, and copied source", () => {
  it("records hashes from the exact compiled POST, accepted task, and actual downloaded bytes", async () => {
    const f = fixture(), generated = await generate(f);
    const sent = f.calls.find(call => call.url === `${providerBase}/contents/generations/tasks`)!;
    expect(sent.method).toBe("POST");
    expect(sent.body).toMatchObject({ model: "test-video-model", duration: 4, ratio: "9:16", resolution: "1080p", generate_audio: true, return_last_frame: true });
    expect(sent.body!.content).toEqual([{ type: "text", text: generated.params.prompt }, ...f.source.contract.shots[0]!.referenceAssets
      .map(url => ({ type: "image_url", image_url: { url }, role: "reference_image" }))]);
    const proof = generated.result.submissionReceipt;
    expect(proof).toMatchObject({ jobId: f.ctx.job.id, projectId, inputSha256: f.ctx.job.input_sha256, shotId: "S1",
      requestHash: generated.request.requestHash, taskId: generated.result.taskId, promptSha256: hash(String(generated.params.prompt)),
      aspect: "9:16", resolution: "1080p", seconds: 4, generateAudio: true,
      artifact: { ref: "clips/S1.provider.mp4", sha256: hash(videoBytes), bytes: videoBytes.length } });
    expect(proof.providerRequestHash).toBe(renderSha256(canonicalRenderJson({ provider: "seedance", providerModel: "test-video-model",
      endpoint: `${providerBase}/contents/generations/tasks`, method: "POST", body: sent.body })));
    expect(readFileSync(join(f.ctx.workDir, generated.result.ref))).toEqual(videoBytes);
    expect(f.ctx.videoFiles.get(generated.result.ref)).toEqual(proof);
    expect(f.ledger.recordComponentAccepted.mock.calls[0]?.[2]).toMatchObject({ evidence: { submissionReceipt: proof } });
    expect(f.ledger.reserveComponent.mock.invocationCallOrder[0]).toBeLessThan(f.net.mock.invocationCallOrder[0]!);
  });
  it("hashes local reference and first-frame bytes actually compiled into a nonperson request", async () => {
    const f = fixture(); writeFileSync(join(f.ctx.workDir, "review/local.png"), plateBytes);
    const { result } = await generate(f, "P1", { refs: ["review/local.png"], firstFrame: { ref: "review/local.png" } });
    expect(result.submissionReceipt.referenceInputs).toEqual([
      { role: "first-frame", ref: "review/local.png", sha256: hash(plateBytes), hashKind: "bytes" },
      { role: "reference-image", ref: "review/local.png", sha256: hash(plateBytes), hashKind: "bytes" },
    ]);
    const sent = f.calls.find(call => call.method === "POST")!.body!;
    expect(sent).not.toHaveProperty("ratio");
    expect(sent.content).toEqual([
      { type: "text", text: videoParams(f, "P1").prompt },
      { type: "image_url", image_url: { url: `data:image/png;base64,${plateBytes.toString("base64")}` }, role: "first_frame" },
      { type: "image_url", image_url: { url: `data:image/png;base64,${plateBytes.toString("base64")}` }, role: "reference_image" },
    ]);
  });
  it("copies current provider media while retaining both the raw bytes and the current private receipt", async () => {
    const f = fixture(), { result } = await generate(f);
    const copied = await handle(f.ctx, frame("media.fetch", "S1", { ref: result.ref, targetRef: "clips/S1.mp4" })) as { sha256: string; bytes: number };
    expect(copied).toMatchObject({ sha256: hash(videoBytes), bytes: videoBytes.length });
    expect(readFileSync(join(f.ctx.workDir, "clips/S1.mp4"))).toEqual(videoBytes);
    expect(readFileSync(join(f.ctx.workDir, result.ref))).toEqual(videoBytes);
    expect(f.ctx.videoFiles.get("clips/S1.mp4")).toEqual(result.submissionReceipt);
  });
  it("copies a provider video larger than the anchor-image limit using the media limit", async () => {
    const f = fixture(), large = Buffer.concat([videoBytes, Buffer.alloc(13 * 1024 * 1024)]);
    f.net.mockImplementation(async (input, init) => {
      const url = String(input), method = init?.method ?? "GET";
      if (url === `${providerBase}/contents/generations/tasks` && method === "POST") return Response.json({ id: "large-task" });
      if (url.includes("/contents/generations/tasks/")) return Response.json({ status: "succeeded", content: { video_url: outputUrl } });
      if (url === outputUrl) return new Response(Uint8Array.from(large), { headers: { "content-length": String(large.length) } });
      throw new Error("unexpected network outside large-media fixture");
    });
    const { result } = await generate(f, "P1");
    const copied = await handle(f.ctx, frame("media.fetch", "P1", { ref: result.ref, targetRef: "clips/P1.mp4" })) as { sha256: string; bytes: number };
    expect(copied).toMatchObject({ sha256: hash(large), bytes: large.length });
    expect(hashFile(join(f.ctx.workDir, "clips/P1.mp4"))).toBe(hash(large));
  });
  it("keeps dispatch/download failures out of the accepted private receipt map", async () => {
    const f = fixture(); f.net.mockResolvedValue(new Response("bad supplier response", { status: 502 }));
    await expect(generate(f)).rejects.toBeInstanceOf(Error);
    expect(f.ledger.reserveComponent).toHaveBeenCalledTimes(1);
    expect(f.ledger.recordComponentFailure).toHaveBeenCalledTimes(1);
    expect(f.ledger.recordComponentAccepted).not.toHaveBeenCalled();
    expect(f.ctx.videoFiles.size).toBe(0);
  });
});

describe("successful parent renders enter post under all historical review policies without quality approval", () => {
  it.each(["off", "advisory", "blocking"])("%s processes actual accepted media without a visual model or dedicated identity receipt", async policy => {
    const f = fixture(policy), prepared = await prepareIdentity(f);
    const legacyRequest = filmCanonicalJson(prepared.request);
    await reviewProcessed(f, prepared);
    expect(filmCanonicalJson(prepared.request)).toBe(legacyRequest);
    expect(f.ctx.videoFiles.get(prepared.clipRef)).toEqual(prepared.generated.result.submissionReceipt);
    expect(prepared.generated.result.submissionReceipt.taskId).toBeTruthy();
  });
  it.each(["off", "advisory", "blocking"])("%s leaves a denied historical identity opinion unchanged while processing current media", async policy => {
    const f = fixture(policy); f.response.approved = false; f.response.score = 93; f.response.reason = "mock拒绝：样本未支持同一人物和服饰";
    const prepared = await prepareIdentity(f), historicalOpinion = filmCanonicalJson(f.response);
    await reviewProcessed(f, prepared);
    expect(filmCanonicalJson(f.response)).toBe(historicalOpinion);
    expect(f.response.approved).toBe(false);
  });
  it("an unavailable visual endpoint is never called and does not block the next authorized person shot", async () => {
    const f = fixture("advisory"), prepared = await prepareIdentity(f), original = f.net.getMockImplementation()!;
    f.net.mockImplementation(async (input, init) => String(input) === `${modelBase}/chat/completions`
      ? new Response("review unavailable", { status: 503 }) : original(input, init));
    await reviewProcessed(f, prepared);
    expect((await generate(f, "S2")).result.submissionReceipt.shotId).toBe("S2");
    expect(modelCalls(f)).toHaveLength(0); expect(f.ctx.identityEvidence.size).toBe(0);
  });
});

describe("parent separates obsolete quality hints from the actual accepted source authority", () => {
  const mutations: Array<[string, (f: Fixture, p: Prepared) => void, boolean?]> = [
    ["self-reported request hash", (_f, p) => { p.params.identityReview.requestHash = "f".repeat(64); }],
    ["forged current prompt hash", (_f, p) => { p.request.promptSha256 = "a".repeat(64); rehashRequest(p); }],
    ["forged registration contract", (_f, p) => { p.request.contractHash = "a".repeat(64); rehashRequest(p); }],
    ["forged author contract", (_f, p) => { p.request.producerContractHash = "a".repeat(64); rehashRequest(p); }],
    ["forged registered identity anchor", (_f, p) => { p.request.referenceImage.path = "/child/generated-person.png"; rehashRequest(p); }],
    ["forged explicit wardrobe lock", (_f, p) => { p.request.wardrobeLock.description = "子进程另定的服饰"; rehashRequest(p); }],
    ["forged frame hash", (_f, p) => { p.frames[0]!.sha256 = "b".repeat(64); p.request.frames[0]!.sha256 = "b".repeat(64); rehashRequest(p); }],
    ["unrelated frame with a valid current hash", (f, p) => {
      const file = join(f.ctx.workDir, p.frames[0]!.ref);
      execFileSync(ffmpeg, ["-v", "error", "-y", "-ss", "0.8", "-i", otherVideo, "-frames:v", "1", "-vf", "scale=720:-2", file], { timeout: 30_000 });
      p.frames[0]!.sha256 = hashFile(file); p.request.frames[0]!.sha256 = hashFile(file); rehashRequest(p);
    }],
    ["different sampling timestamp", (_f, p) => { p.frames[0]!.atSec = 0.5; p.request.frames[0]!.atSec = 0.5; rehashRequest(p); }],
    ["duplicated sampling timestamp", (_f, p) => { p.frames[1]!.atSec = p.frames[0]!.atSec; p.request.frames[1]!.atSec = p.frames[0]!.atSec; rehashRequest(p); }],
    ["missing second frame", (_f, p) => { p.frames.splice(1); p.request.frames.splice(1); rehashRequest(p); }],
    ["changed copied registration image", (f, p) => { writeFileSync(join(f.ctx.workDir, p.referenceRef), Buffer.concat([anchorPng, Buffer.from("other-source")])); }],
    ["changed preserved provider raw", (f, p) => { writeFileSync(join(f.ctx.workDir, p.generated.result.ref), Buffer.concat([videoBytes, Buffer.from("changed-raw")])); }, true],
    ["changed copied clip with correctly updated child hash", (f, p) => {
      writeFileSync(p.clipPath, Buffer.concat([videoBytes, Buffer.from("changed-copy")])); p.request.clip.sha256 = hashFile(p.clipPath); rehashRequest(p);
    }, true],
    ["copied video bound to another job's provider proof", (f, p) => {
      const receipt = f.ctx.videoFiles.get(p.clipRef)!;
      f.ctx.videoFiles.set(p.clipRef, { ...receipt, jobId: "unrelated-job" });
    }, true],
    ["registration changed after submission", (f) => {
      f.asset.authorization.evidence = "changed-registration"; jsonFile(f.profileFile, f.asset);
    }],
    ["frame symlink to an external current image", (f, p) => {
      const file = join(f.ctx.workDir, p.frames[0]!.ref), outside = join(f.root, "outside-frame.jpg");
      copyFileSync(file, outside); rmSync(file); symlinkSync(outside, file);
    }],
  ];
  it.each(mutations)("handles %s at its actual authority boundary without a model", async (label, mutate, sourceChanged) => {
    const f = fixture(), prepared = await prepareIdentity(f); mutate(f, prepared);
    if (sourceChanged) {
      await rejectedBeforeReserve(f, frame("media.fetch", "S1", { ref: prepared.clipRef, targetRef: "clips/S1.post-input.mp4" }));
      expect(existsSync(join(f.ctx.workDir, "clips/S1.post-input.mp4"))).toBe(false);
    } else {
      await reviewProcessed(f, prepared);
      if (label === "registration changed after submission")
        await rejectedBeforeReserve(f, frame("video.generate", "S2", videoParams(f, "S2")), "CHARACTER_REGISTRATION_CHANGED");
    }
    expect(f.ctx.identityEvidence.size).toBe(0); expect(modelCalls(f)).toHaveLength(0);
  });
});

describe("parent person requests keep preauthorization without a rendered canary veto", () => {
  it("allows the next authorized person and unrelated product shot without a rendered canary", async () => {
    const f = fixture(); await generate(f);
    expect((await generate(f, "S2")).result.submissionReceipt.shotId).toBe("S2");
    expect((await generate(f, "P1")).result.submissionReceipt.shotId).toBe("P1");
    expect(f.ctx.identityEvidence.size).toBe(0); expect(modelCalls(f)).toHaveLength(0);
  });
  it("processes the first person's original without fabricating identity approval before the next request", async () => {
    const f = fixture(), prepared = await prepareIdentity(f);
    await reviewProcessed(f, prepared);
    const next = await generate(f, "S2"); expect(next.result.submissionReceipt.shotId).toBe("S2");
    expect(modelCalls(f)).toHaveLength(0);
  });
  it.each(["raw", "copied-clip"])("rejects changed %s before copying it into post despite an earlier processing receipt", async changed => {
    const f = fixture(), prepared = await prepareIdentity(f);
    await reviewProcessed(f, prepared);
    const file = changed === "raw" ? join(f.ctx.workDir, prepared.generated.result.ref) : prepared.clipPath;
    writeFileSync(file, Buffer.concat([readFileSync(file), Buffer.from("changed-after-review")]));
    await rejectedBeforeReserve(f, frame("media.fetch", "S1", { ref: prepared.clipRef, targetRef: "clips/S1.post-input.mp4" }), "VIDEO_SOURCE_CHANGED");
    expect(existsSync(join(f.ctx.workDir, "clips/S1.post-input.mp4"))).toBe(false);
  });
});

describe("standard parent preserves original media and rejects retiming before reservation", () => {
  it("copies actual shorter original bytes without retiming and reviews that same original clip", async () => {
    const f = fixture(); providerOutput(f, shorterVideoBytes);
    const prepared = await prepareIdentity(f);
    expect(prepared.copied).not.toHaveProperty("normalization");
    const duration = Number(JSON.parse(execFileSync(ffprobe, ["-v", "error", "-show_entries", "format=duration", "-of", "json", prepared.clipPath], { encoding: "utf8", timeout: 30_000 })).format.duration);
    expect(duration).toBeLessThan(4);
    expect(hashFile(join(f.ctx.workDir, prepared.generated.result.ref))).toBe(hash(shorterVideoBytes));
    expect(prepared.copied.sha256).toBe(hashFile(prepared.clipPath));
    expect(prepared.copied.sha256).toBe(hash(shorterVideoBytes));
    expect(readFileSync(prepared.clipPath)).toEqual(shorterVideoBytes);
    expect(f.ctx.videoFiles.get(prepared.clipRef)).toEqual(prepared.generated.result.submissionReceipt);
    expect(f.ctx.videoArtifacts?.get(prepared.clipRef)).toMatchObject({ ref: prepared.clipRef, sha256: prepared.copied.sha256, bytes: prepared.copied.bytes });
    await rejectedBeforeReserve(f, frame("media.fetch", "S1", { ref: prepared.generated.result.ref, targetRef: prepared.clipRef, normalizeToSeconds: 4 }), "STANDARD_NATIVE_RETIME_FORBIDDEN");
    expect(readFileSync(prepared.clipPath)).toEqual(shorterVideoBytes);
    expect(readFileSync(join(f.ctx.workDir, prepared.generated.result.ref))).toEqual(shorterVideoBytes);
    await reviewProcessed(f, prepared);
    expect(prepared.params.artifacts).toEqual([{ ref: prepared.clipRef, kind: "video" }]);
    expect(hashFile(prepared.clipPath)).toBe(prepared.copied.sha256);
    expect((await generate(f, "S2")).result.submissionReceipt.shotId).toBe("S2");
  });
  it("copies a silent accepted product original byte-for-byte and refuses any duration normalization", async () => {
    const f = fixture(); providerOutput(f, silentVideoBytes);
    const { result } = await generate(f, "P1");
    const copied = await handle(f.ctx, frame("media.fetch", "P1", { ref: result.ref, targetRef: "clips/P1.mp4" })) as {
      ref: string; sha256: string;
    };
    expect(copied).not.toHaveProperty("normalization");
    expect(copied.sha256).toBe(hash(silentVideoBytes));
    expect(readFileSync(join(f.ctx.workDir, copied.ref))).toEqual(silentVideoBytes);
    await rejectedBeforeReserve(f, frame("media.fetch", "P1", { ref: result.ref, targetRef: copied.ref, normalizeToSeconds: 4 }), "STANDARD_NATIVE_RETIME_FORBIDDEN");
    expect(readFileSync(join(f.ctx.workDir, copied.ref))).toEqual(silentVideoBytes);
    const streams = JSON.parse(execFileSync(ffprobe, ["-v", "error", "-show_entries", "stream=codec_type", "-of", "json", join(f.ctx.workDir, copied.ref)], { encoding: "utf8" })).streams as Array<{ codec_type: string }>;
    expect(streams.filter(stream => stream.codec_type === "audio")).toHaveLength(0);
    expect(streams.filter(stream => stream.codec_type === "video")).toHaveLength(1);
    expect(hashFile(join(f.ctx.workDir, result.ref))).toBe(hash(silentVideoBytes));
  });
  it.each([
    ["altered frozen duration", 6], ["string duration", "4"], ["zero duration", 0],
  ])("refuses %s before reservation", async (_label, normalizeToSeconds) => {
    const f = fixture(), { result } = await generate(f);
    await rejectedBeforeReserve(f, frame("media.fetch", "S1", { ref: result.ref, targetRef: "clips/S1.mp4", normalizeToSeconds }), "STANDARD_NATIVE_RETIME_FORBIDDEN");
    expect(hashFile(join(f.ctx.workDir, result.ref))).toBe(hash(videoBytes));
    expect(existsSync(join(f.ctx.workDir, "clips/S1.mp4"))).toBe(false);
  });
  it("refuses normalized output overwriting the retained provider source before reservation", async () => {
    const f = fixture(), { result } = await generate(f);
    await rejectedBeforeReserve(f, frame("media.fetch", "S1", { ref: result.ref, targetRef: result.ref, normalizeToSeconds: 4 }), "STANDARD_NATIVE_RETIME_FORBIDDEN");
    expect(hashFile(join(f.ctx.workDir, result.ref))).toBe(hash(videoBytes));
  });
  it("refuses normalizing another shot's accepted source before reservation", async () => {
    const f = fixture(), { result } = await generate(f);
    await rejectedBeforeReserve(f, frame("media.fetch", "S2", { ref: result.ref, targetRef: "clips/S2.mp4", normalizeToSeconds: 4 }), "STANDARD_NATIVE_RETIME_FORBIDDEN");
    expect(hashFile(join(f.ctx.workDir, result.ref))).toBe(hash(videoBytes));
    expect(existsSync(join(f.ctx.workDir, "clips/S2.mp4"))).toBe(false);
  });
  it("refuses normalizing a local file without an accepted provider source before reservation", async () => {
    const f = fixture(); writeFileSync(join(f.ctx.workDir, "clips/unaccepted.mp4"), videoBytes);
    await rejectedBeforeReserve(f, frame("media.fetch", "S1", { ref: "clips/unaccepted.mp4", targetRef: "clips/S1.mp4", normalizeToSeconds: 4 }), "STANDARD_NATIVE_RETIME_FORBIDDEN");
    expect(hashFile(join(f.ctx.workDir, "clips/unaccepted.mp4"))).toBe(hash(videoBytes));
    expect(existsSync(join(f.ctx.workDir, "clips/S1.mp4"))).toBe(false);
  });
  it("refuses url normalization instead of trusting caller-declared time and clip identity", async () => {
    const f = fixture(); await generate(f);
    await rejectedBeforeReserve(f, frame("media.fetch", "S1", { url: outputUrl, targetRef: "clips/S1.mp4", normalizeToSeconds: 4 }), "STANDARD_NATIVE_RETIME_FORBIDDEN");
    expect(hashFile(join(f.ctx.workDir, "clips/S1.provider.mp4"))).toBe(hash(videoBytes));
    expect(existsSync(join(f.ctx.workDir, "clips/S1.mp4"))).toBe(false);
  });
  it.each(["ref", "url"])("rehashes stale accepted %s source before even reserving a copy component", async selector => {
    const f = fixture(), { result } = await generate(f);
    writeFileSync(join(f.ctx.workDir, result.ref), Buffer.concat([videoBytes, Buffer.from("stale-provider-source")]));
    await rejectedBeforeReserve(f, frame("media.fetch", "S1", { [selector]: selector === "ref" ? result.ref : outputUrl, targetRef: "clips/S1.mp4" }), "VIDEO_SOURCE_CHANGED");
  });
});

describe("parent submission authority stays scoped to registered people and selected shots", () => {
  it("the first person's processed original does not impose a quality review on another authorized person", async () => {
    const f = fixture("off", { multiCharacter: true }), prepared = await prepareIdentity(f);
    await reviewProcessed(f, prepared);
    expect((await generate(f, "S2")).result.submissionReceipt.shotId).toBe("S2");
    expect((await generate(f, "T2")).result.submissionReceipt.shotId).toBe("T2");
    expect(modelCalls(f)).toHaveLength(0);
  });
  it("each person's selected shots retain their own registered asset groups without a cross-person canary", async () => {
    const f = fixture("off", { multiCharacter: true }); await generate(f);
    const second = await prepareIdentity(f, { shotId: "T1" });
    await reviewProcessed(f, second);
    const nextSecond = (await generate(f, "T2")).result.submissionReceipt;
    const nextFirst = (await generate(f, "S2")).result.submissionReceipt;
    expect(nextSecond.shotId).toBe("T2"); expect(nextFirst.shotId).toBe("S2");
    expect(nextSecond.referenceInputs.map(row => row.ref)).toContain("asset://asset-secondary");
    expect(nextFirst.referenceInputs.map(row => row.ref)).toContain("asset://asset-primary");
    expect(modelCalls(f)).toHaveLength(0);
  });
  it("only selects the first allowed shot of each person instead of demanding an out-of-scope earlier shot", async () => {
    const f = fixture("blocking", { multiCharacter: true, only: "S2,T2" });
    expect((await generate(f, "S2")).result.submissionReceipt.shotId).toBe("S2");
    expect((await generate(f, "T2")).result.submissionReceipt.shotId).toBe("T2");
    await rejectedBeforeReserve(f, frame("video.generate", "S1", videoParams(f, "S1")), "SHOT_NOT_FOUND");
  });
});

describe("parent keeps request scope and current-source failures at the actual processing boundary", () => {
  it("processes current accepted media after the visual model has become unavailable", async () => {
    const f = fixture(), prepared = await prepareIdentity(f); delete f.ctx.env.LLM_API_KEY;
    await reviewProcessed(f, prepared);
  });
  it.each([
    ["unregistered worker method", "METHOD_NOT_ALLOWED", (f: Fixture, _request: FilmChannelRequestFrame) => { f.ctx.worker.capabilities = ["video.generate"]; }],
    ["closed job deadline", "JOB_DEADLINE_EXCEEDED", (f: Fixture, _request: FilmChannelRequestFrame) => { f.ctx.deadlineAt = Date.now() - 1; }],
    ["different project", "REVIEW_SCOPE_INVALID", (_f: Fixture, request: FilmChannelRequestFrame) => { (request.params as Prepared["params"]).projectId = "OTHER"; request.requestHash = filmRequestHash(request); }],
    ["different declared component", "FRAME_INVALID", (_f: Fixture, request: FilmChannelRequestFrame) => { request.component = "video"; }],
  ])("refuses %s before even a zero-budget processing reservation", async (_label, code, mutate) => {
    const f = fixture(), prepared = await prepareIdentity(f), request = frame("gate.review", "S1", prepared.params);
    mutate(f, request); await rejectedBeforeReserve(f, request, code);
  });
  it.each(["clip", "raw", "provider-proof", "missing-clip", "missing-raw"])("refuses %s changed during actual copy dispatch without accepting an output", async changed => {
    const f = fixture(), prepared = await prepareIdentity(f), beforeCalls = f.net.mock.calls.length;
    f.ledger.recordDispatch.mockImplementation(async (_component, _owner, provider, model) => {
      expect([provider, model]).toEqual(["local", "media-fetch"]);
      if (changed === "provider-proof") {
        const receipt = f.ctx.videoFiles.get(prepared.clipRef)!;
        f.ctx.videoFiles.set(prepared.clipRef, { ...receipt, inputSha256: "a".repeat(64) });
      } else {
        const file = changed === "clip" || changed === "missing-clip" ? prepared.clipPath : join(f.ctx.workDir, prepared.generated.result.ref);
        if (changed.startsWith("missing-")) rmSync(file);
        else writeFileSync(file, Buffer.concat([readFileSync(file), Buffer.from("changed-during-copy-dispatch")]));
      }
    });
    resetLedger(f);
    await expect(handle(f.ctx, frame("media.fetch", "S1", { ref: prepared.clipRef, targetRef: "clips/S1.post-input.mp4" }))).rejects.toBeInstanceOf(Error);
    expect(f.ledger.reserveComponent).toHaveBeenCalledTimes(1); expect(f.ledger.recordDispatch).toHaveBeenCalledTimes(1);
    expect(modelCalls(f)).toHaveLength(0); expect(f.net.mock.calls).toHaveLength(beforeCalls);
    expect(f.ledger.recordComponentAccepted).not.toHaveBeenCalled(); expect(f.ledger.recordComponentFailure).toHaveBeenCalledTimes(1);
    expect(f.ctx.identityEvidence.size).toBe(0); expect(existsSync(join(f.ctx.workDir, "clips/S1.post-input.mp4"))).toBe(false);
  });
});
