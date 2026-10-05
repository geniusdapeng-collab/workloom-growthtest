import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { existingEditFileHash, prepareExistingEditSegment, resolveExistingEditBinary, validateExistingRenderEditPlan, verifyExistingEditSources,
  type ExistingRenderEditPlan } from "./film-existing-render-edit.mjs";

const root = resolve(import.meta.dirname, "../..");
const cli = join(root, "scripts/tools/full-chain-film.mts");
function callCli(args: string[]) {
  return spawnSync(process.execPath, ["--import", "tsx", cli, ...args], {
    cwd: root, encoding: "utf8", timeout: 30_000,
    env: { ...process.env, FILM_WORKER_MODE: "", WL_FFMPEG: "ffmpeg", WL_FFPROBE: "ffprobe" },
  });
}

test("existing edit rejects worker mode before creating the restricted IPC runtime", () => {
  const result = callCli(["--existing-render-edit", "missing.json", "--worker"]);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /EXISTING_EDIT_WORKER_FORBIDDEN/);
  assert.doesNotMatch(result.stderr, /FILM_JOB_CONTEXT|需要 --shots/);
});

test("existing edit parses its own plan before shots, keys or generation preflight", () => {
  const temp = mkdtempSync(join(tmpdir(), "existing-edit-cli-"));
  try {
    const plan = join(temp, "plan.json");
    writeFileSync(plan, "{}\n");
    const result = callCli(["--existing-render-edit", plan]);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /EXISTING_EDIT_PLAN_INVALID/);
    assert.doesNotMatch(result.stderr, /需要 --shots|ARK_API_KEY|VISION/);
  } finally { rmSync(temp, { recursive: true, force: true }); }
});

function planAt(temp: string): ExistingRenderEditPlan {
  return {
    schemaVersion: "workloom.existing-render-edit/v1", projectId: "EDIT-TEST", allowedRoots: [temp], outputDir: join(temp, "delivery"),
    width: 160, height: 288, fps: 24, durationSec: 2, subtitleFontsRoot: temp,
    sources: [{ id: "original", path: join(temp, "original.mp4"), sha256: "a".repeat(64), bytes: 1, role: "original-render", origin: "existing synthetic test media" }],
    forbiddenVideoSourceIds: [],
    segments: [{ id: "segment", videoSourceId: "original", audioSourceId: "original", videoInSec: 0, audioInSec: 0, durationSec: 2,
      speechMode: "on-camera-native", pictureUse: "person" }],
    subtitles: [{ startSec: 0.2, endSec: 1.4, text: "Existing speech" }],
    cover: { sourceId: "original", atSec: 0.5, title: "Service", platform: "wechat-channels", fontFile: join(temp, "font.otf"), fontSha256: "b".repeat(64) },
    versions: [{ id: "master", profile: "natural", intensity: 0.3 }],
  };
}

test("strict plan accepts native speech, immutable source hashes and authored captions without changing its input", () => {
  const plan = planAt(tmpdir()), copy = structuredClone(plan);
  const result = validateExistingRenderEditPlan(plan);
  assert.deepEqual(result, copy);
  result.segments[0]!.durationSec = 1;
  assert.deepEqual(plan, copy);
});

test("plan accepts two picture cuts over one continuously advancing existing voice", () => {
  const plan = planAt(tmpdir());
  plan.sources.push({ id: "voice", path: join(tmpdir(), "voice.mp4"), sha256: "c".repeat(64), bytes: 1, role: "existing-voice", origin: "existing test voice" });
  plan.segments = [0, 1].map((n) => ({ id: `part-${n}`, videoSourceId: "original", audioSourceId: "voice", videoInSec: n, audioInSec: n,
    durationSec: 1, speechMode: "voice-over-existing", pictureUse: "product" }));
  assert.equal(validateExistingRenderEditPlan(plan).segments[1]!.audioInSec, 1);
});

const invalidCases: Array<[string, (p: any) => void, RegExp]> = [
  ["unknown schema", (p) => { p.schemaVersion = "legacy"; }, /schemaVersion/],
  ["hidden generation option", (p) => { p.generateAudio = true; }, /unsupported fields/],
  ["project traversal", (p) => { p.projectId = "..\/other"; }, /projectId/],
  ["remote read root", (p) => { p.allowedRoots = ["https://example.org"]; }, /allowedRoots/],
  ["comma output breaks compose CSV", (p) => { p.outputDir += ",escape"; }, /outputDir/],
  ["odd picture dimensions", (p) => { p.width = 161; }, /dimensions/],
  ["fractional fps", (p) => { p.fps = 23.5; }, /fps/],
  ["zero duration", (p) => { p.durationSec = 0; }, /durationSec/],
  ["remote source", (p) => { p.sources[0].path = "https://example.org/a.mp4"; }, /local path/],
  ["missing complete source hash", (p) => { p.sources[0].sha256 = "123"; }, /SHA256/],
  ["empty frozen source", (p) => { p.sources[0].bytes = 0; }, /positive bytes/],
  ["duplicate source id", (p) => { p.sources.push(structuredClone(p.sources[0])); }, /unique/],
  ["unsupported source provenance", (p) => { p.sources[0].role = "new-render"; }, /role/],
  ["missing excluded source", (p) => { p.forbiddenVideoSourceIds = ["missing"]; }, /forbiddenVideoSourceIds/],
  ["duplicate excluded source", (p) => { p.forbiddenVideoSourceIds = ["original", "original"]; }, /forbiddenVideoSourceIds/],
  ["excluded picture source", (p) => { p.forbiddenVideoSourceIds = ["original"]; }, /excluded source picture/],
  ["excluded picture through alias", (p) => { p.sources.push({ ...p.sources[0], id: "alias" }); p.forbiddenVideoSourceIds = ["alias"]; }, /excluded source picture/],
  ["missing video source", (p) => { p.segments[0].videoSourceId = "missing"; }, /original render/],
  ["music substituted for speech", (p) => { p.sources[0].role = "existing-music"; }, /original render/],
  ["negative source start", (p) => { p.segments[0].videoInSec = -1; }, /ranges/],
  ["nonframe source start", (p) => { p.segments[0].videoInSec = 0.01; }, /ranges/],
  ["speed change hidden in segment", (p) => { p.segments[0].speed = 0.8; }, /unsupported fields/],
  ["duration sum mismatch", (p) => { p.durationSec = 3; }, /durations do not match/],
  ["native audio moved to another in point", (p) => { p.segments[0].audioInSec = 0.5; }, /same original/],
  ["native audio over product picture", (p) => { p.segments[0].pictureUse = "product"; }, /same original/],
  ["native voiceover presentation change omitted", (p) => { p.sources.push({ ...p.sources[0], id: "second", path: "/tmp/second.mp4", sha256: "c".repeat(64) }); p.segments[0].audioSourceId = "second"; p.segments[0].speechMode = "voice-over-existing"; }, /presentationChange/],
  ["empty subtitle", (p) => { p.subtitles[0].text = " "; }, /nonempty/],
  ["subtitle outside film", (p) => { p.subtitles[0].endSec = 3; }, /timeline/],
  ["overlapping captions", (p) => { p.subtitles.push({ startSec: 1, endSec: 1.8, text: "Second" }); }, /timeline/],
  ["unrepresentable subtitle precision", (p) => { p.subtitles[0].startSec = 0.201; }, /10ms precision/],
  ["ASS override injection", (p) => { p.subtitles[0].text = "{\\pos(0,0)}wrong"; }, /control sequences/],
  ["excluded cover source", (p) => { p.sources.push({ ...p.sources[0], id: "bad", sha256: "c".repeat(64) }); p.forbiddenVideoSourceIds = ["bad"]; p.cover.sourceId = "bad"; }, /cover must/],
  ["unfrozen cover font", (p) => { p.cover.fontSha256 = ""; }, /pinned font/],
  ["unknown cover font id", (p) => { p.cover.fontId = "fake-font"; }, /known platform and font/],
  ["unknown cover platform", (p) => { p.cover.platform = "unknown-channel"; }, /known platform and font/],
  ["unknown post profile", (p) => { p.versions[0].profile = "arbitrary-filter"; }, /color recipe/],
  ["missing master version", (p) => { p.versions[0].id = "cool-tech"; }, /master version/],
  ["duplicate version output", (p) => { p.versions.push(structuredClone(p.versions[0])); }, /duplicate version/],
  ["BGM settings without file", (p) => { p.versions[0].musicLevelDb = -20; }, /BGM settings/],
  ["new unfrozen BGM", (p) => { p.versions[0].musicSourceId = "missing"; }, /frozen existing music/],
  ["variant pretending to be graded", (p) => { p.versions.push({ id: "cool-tech", profile: "none", intensity: 0 }); }, /color recipe/],
];
for (const [label, mutate, message] of invalidCases) test(`plan rejects ${label} before external work`, () => {
  const plan = planAt(tmpdir()); mutate(plan);
  assert.throws(() => validateExistingRenderEditPlan(plan), (e: unknown) => e instanceof Error && /EXISTING_EDIT_PLAN_INVALID/.test(e.message) && message.test(e.message));
});

function makeMedia(path: string) {
  const result = spawnSync(process.env.WL_FFMPEG ?? "ffmpeg", ["-v", "error", "-nostdin", "-n", "-f", "lavfi", "-i", "testsrc2=s=160x288:r=24:d=2",
    "-f", "lavfi", "-i", "sine=frequency=733:sample_rate=48000:duration=2", "-map", "0:v:0", "-map", "1:a:0", "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p",
    "-c:a", "aac", "-b:a", "128k", "-ar", "48000", "-ac", "2", "-t", "2", path], { encoding: "utf8", timeout: 60_000 });
  assert.equal(result.status, 0, result.stderr);
}

test("real FFmpeg source probe verifies frozen bytes and rejects range, hash and root changes", async () => {
  const temp = mkdtempSync(join(tmpdir(), "existing-edit-media-"));
  try {
    const plan = planAt(temp), file = plan.sources[0]!.path;
    makeMedia(file); plan.sources[0]!.bytes = statSync(file).size; plan.sources[0]!.sha256 = await existingEditFileHash(file);
    const options = { ffmpeg: process.env.WL_FFMPEG ?? "ffmpeg", ffprobe: process.env.WL_FFPROBE ?? "ffprobe", timeoutMs: 60_000 };
    const valid = await verifyExistingEditSources(validateExistingRenderEditPlan(plan), options);
    assert.equal(valid.get("original")!.media.streams[0]!.nb_read_frames, "48");
    const range = structuredClone(plan); range.segments[0]!.videoInSec = 1;
    await assert.rejects(verifyExistingEditSources(range, options), /EXISTING_EDIT_VIDEO_RANGE_INVALID/);
    const audioRange = structuredClone(plan); audioRange.segments[0]!.audioInSec = 1;
    await assert.rejects(verifyExistingEditSources(audioRange, options), /EXISTING_EDIT_AUDIO_RANGE_INVALID/);
    const out = structuredClone(plan); out.allowedRoots = [join(temp, "missing-root")];
    await assert.rejects(verifyExistingEditSources(out, options));
    const tamper = structuredClone(plan); tamper.sources[0]!.sha256 = "0".repeat(64);
    await assert.rejects(verifyExistingEditSources(tamper, options), /EXISTING_EDIT_SOURCE_CHANGED/);
    const coverRange = structuredClone(plan); coverRange.cover.atSec = 2;
    await assert.rejects(verifyExistingEditSources(coverRange, options), /EXISTING_EDIT_COVER_RANGE_INVALID/);
    const short = structuredClone(plan); short.sources[0]!.bytes -= 1;
    await assert.rejects(verifyExistingEditSources(short, options), /EXISTING_EDIT_SOURCE_CHANGED/);
  } finally { rmSync(temp, { recursive: true, force: true }); }
});

test("real FFmpeg trim preserves chosen native PCM samples and frames with special input path characters", async () => {
  const temp = mkdtempSync(join(tmpdir(), "existing-edit-trim-"));
  try {
    const source = join(temp, "source , '$() 空格.mp4"), target = join(temp, "trim.mov");
    makeMedia(source);
    const segment = { ...planAt(temp).segments[0]!, videoInSec: 0.5, audioInSec: 0.5, durationSec: 1 };
    const options = { ffmpeg: process.env.WL_FFMPEG ?? "ffmpeg", ffprobe: process.env.WL_FFPROBE ?? "ffprobe", timeoutMs: 60_000 };
    const result = await prepareExistingEditSegment({ segment, video: source, audio: source, output: target, width: 160, height: 288, fps: 24 }, options);
    assert.equal(result.sourceAudio.bytes, 192000);
    assert.match(result.sourceAudio.sha256, /^[a-f0-9]{64}$/);
    assert.equal(result.sha256, await existingEditFileHash(target));
    assert.ok(existsSync(source));
    const before = readFileSync(source);
    await assert.rejects(prepareExistingEditSegment({ segment, video: source, audio: source, output: source, width: 160, height: 288, fps: 24 }, options), /EXISTING_EDIT_OVERWRITE_FORBIDDEN/);
    await assert.rejects(prepareExistingEditSegment({ segment, video: source, audio: source, output: target, width: 160, height: 288, fps: 24 }, options), /EXISTING_EDIT_OUTPUT_EXISTS/);
    assert.deepEqual(readFileSync(source), before);
  } finally { rmSync(temp, { recursive: true, force: true }); }
});

test("frozen playlist bytes cannot authorize an unfrozen media file outside the read roots", async () => {
  const temp = mkdtempSync(join(tmpdir(), "existing-edit-playlist-"));
  try {
    const allowed = join(temp, "allowed"); mkdirSync(allowed);
    const original = join(temp, "outside-original.mp4"), nested = join(temp, "outside.ts"); makeMedia(original);
    const ffmpeg = process.env.WL_FFMPEG ?? "ffmpeg", ffprobe = process.env.WL_FFPROBE ?? "ffprobe";
    const converted = spawnSync(ffmpeg, ["-v", "error", "-nostdin", "-n", "-i", original, "-c", "copy", "-bsf:v", "h264_mp4toannexb", "-f", "mpegts", nested], { encoding: "utf8", timeout: 60_000 });
    assert.equal(converted.status, 0, converted.stderr);
    const plan = planAt(allowed), playlist = plan.sources[0]!.path;
    writeFileSync(playlist, `#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-TARGETDURATION:3\n#EXT-X-MEDIA-SEQUENCE:0\n#EXTINF:2.0,\n${nested}\n#EXT-X-ENDLIST\n`);
    plan.sources[0]!.bytes = statSync(playlist).size; plan.sources[0]!.sha256 = await existingEditFileHash(playlist);
    await assert.rejects(verifyExistingEditSources(validateExistingRenderEditPlan(plan), { ffprobe }), /EXISTING_EDIT_MEDIA_INVALID/);
    const target = join(temp, "must-not-publish.mov");
    await assert.rejects(prepareExistingEditSegment({ segment: plan.segments[0]!, video: playlist, audio: playlist, output: target, width: 160, height: 288, fps: 24 }, { ffmpeg, ffprobe }), /EXISTING_EDIT_PROCESS_FAILED/);
    assert.equal(existsSync(target), false);
  } finally { rmSync(temp, { recursive: true, force: true }); }
});

test("direct existing MP3 and WAV sources still pass the media restriction", async () => {
  const temp = mkdtempSync(join(tmpdir(), "existing-edit-direct-audio-"));
  try {
    const plan = planAt(temp); makeMedia(plan.sources[0]!.path);
    plan.sources[0]!.bytes = statSync(plan.sources[0]!.path).size; plan.sources[0]!.sha256 = await existingEditFileHash(plan.sources[0]!.path);
    for (const extension of ["mp3", "wav"]) {
      const file = join(temp, `music.${extension}`);
      const result = spawnSync(process.env.WL_FFMPEG ?? "ffmpeg", ["-v", "error", "-nostdin", "-n", "-i", plan.sources[0]!.path, "-map", "0:a:0", "-vn", file], { encoding: "utf8", timeout: 60_000 });
      assert.equal(result.status, 0, result.stderr);
      plan.sources.push({ id: extension, path: file, bytes: statSync(file).size, sha256: await existingEditFileHash(file), role: "existing-music", origin: "direct existing fixture audio" });
    }
    const sources = await verifyExistingEditSources(validateExistingRenderEditPlan(plan), { ffprobe: process.env.WL_FFPROBE ?? "ffprobe" });
    assert.equal(sources.size, 3);
    for (const extension of ["mp3", "wav"]) assert.equal(sources.get(extension)!.media.streams[0]!.codec_type, "audio");
  } finally { rmSync(temp, { recursive: true, force: true }); }
});

test("local CLI rejects generation switches rather than silently combining modes", () => {
  const result = callCli(["--existing-render-edit", "plan.json", "--shots", "legacy.json"]);
  assert.notEqual(result.status, 0); assert.match(result.stderr, /EXISTING_EDIT_PLAN_INVALID/);
  assert.doesNotMatch(result.stderr, /需要 --shots/);
});
test("normal generation CLI still requires an explicit regular shots file", () => {
  for (const args of [[], ["--shots", root]]) {
    const result = callCli(args);
    assert.notEqual(result.status, 0); assert.match(result.stderr, /需要 --shots/);
    assert.doesNotMatch(result.stderr, /EISDIR|EXISTING_EDIT_PLAN_INVALID/);
  }
});

test("source does not import provider clients, vision, voice or ASR adapters in the local editor", () => {
  const code = readFileSync(join(root, "scripts/tools/film-existing-render-edit.mts"), "utf8");
  assert.doesNotMatch(code, /(?:from|import\s*\()[^\n]*(?:ark|producer-gate|voice-bridge|speech-bridge|llm-adapter|film-worker-runtime)/);
  assert.doesNotMatch(code, /\bfetch\s*\(|allowFallbackApprove|accept-av-sync-drift/);
});

test("explicit master passthrough does not require a fake creative look", () => {
  const p = planAt(tmpdir()); p.versions[0]!.profile = "none"; p.versions[0]!.intensity = 0;
  assert.equal(validateExistingRenderEditPlan(p).versions[0]!.profile, "none");
});
test("executable resolution accepts a current absolute local executable", async () => {
  assert.equal(await resolveExistingEditBinary(process.execPath), process.execPath);
});
test("executable resolution rejects unavailable commands before media work", async () => {
  await assert.rejects(resolveExistingEditBinary("workloom-no-such-media-command-10060001"), /EXISTING_EDIT_BINARY_INVALID/);
});
test("executable resolution rejects remote, relative directory and control values", async () => {
  for (const binary of ["https://example.org/ffmpeg", "./ffmpeg", "ffmpeg\nwrong"]) {
    await assert.rejects(resolveExistingEditBinary(binary), /EXISTING_EDIT_BINARY_INVALID/);
  }
});
