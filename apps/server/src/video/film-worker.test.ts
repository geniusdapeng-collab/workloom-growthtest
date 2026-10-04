import { describe, expect, it } from "vitest";
import { filmWorkerEnvironment, validateFilmChannelScope } from "./film-worker.js";
import { FILM_CHANNEL_METHOD_COMPONENT, type FilmChannelRequestFrame } from "@hyperreality/video-studio";
describe("film worker child environment", () => {
  it("keeps public local tools while dropping every account, database, model and signing credential", () => {
    const env = filmWorkerEnvironment({ PATH: "/local/bin", WL_FFMPEG: "/local/ffmpeg", SEEDANCE_MODEL: "test-model", LLM_API_KEY: "test-secret", JWT_SECRET: "test-secret", CNB_TOKEN: "test-secret", DATABASE_URL: "test-secret", CUSTOMER_OAUTH_TOKEN: "test-secret", NODE_OPTIONS: "--import arbitrary" });
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
