import { describe, expect, it } from "vitest";
import { filmWorkerEnvironment, validateFilmChannelScope } from "./film-worker.js";
import { FILM_CHANNEL_METHOD_COMPONENT, type FilmChannelRequestFrame } from "@hyperreality/video-studio";
describe("film worker child environment", () => {
  it("keeps public local tools while dropping every account, database, model and signing credential", () => {
    const env = filmWorkerEnvironment({ PATH: "/local/bin", WL_FFMPEG: "/local/ffmpeg", SEEDANCE_MODEL: "test-model", LLM_API_KEY: "mock-test-only-secret", JWT_SECRET: "mock-test-only-secret", CNB_TOKEN: "mock-test-only-secret", DATABASE_URL: "mock-test-only-secret", CUSTOMER_OAUTH_TOKEN: "mock-test-only-secret", NODE_OPTIONS: "--import arbitrary" });
    expect(env).toEqual({ PATH: "/local/bin", WL_FFMPEG: "/local/ffmpeg", SEEDANCE_MODEL: "test-model" });
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
    expect(() => validateFilmChannelScope(frame("voice.dub", "S2", { text: "画外旁白" }), scope)).not.toThrow();
    expect(() => validateFilmChannelScope(frame("voice.dub", "S3", { text: "额外旁白" }), scope)).toThrow("AUDIO_NO_DIALOGUE");
  });
  it("binds verification and permitted narration text to the exact frozen shot", () => {
    expect(() => validateFilmChannelScope(frame("voice.verify", "S1", { expectText: "同源对白" }), scope)).not.toThrow();
    expect(() => validateFilmChannelScope(frame("voice.verify", "S1", { expectText: "其它文本" }), scope)).toThrow("AUDIO_TEXT_MISMATCH");
    expect(() => validateFilmChannelScope(frame("voice.dub", "S2", { text: "其它文本" }), scope)).toThrow("AUDIO_TEXT_MISMATCH");
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
  it("keeps explicit silent voice-over generation and UHD source resolution semantics", () => {
    expect(() => validateFilmChannelScope(frame("video.generate", "S1", video), scope)).not.toThrow();
    expect(() => validateFilmChannelScope(frame("video.generate", "S2", { ...video, seconds: 6, generateAudio: false }), scope)).not.toThrow();
    expect(() => validateFilmChannelScope(frame("video.generate", "S1", { ...video, resolution: "1080p" }),
      { ...scope, options: { aspect: "16:9", resolution: "2160p" } })).not.toThrow();
  });
});
