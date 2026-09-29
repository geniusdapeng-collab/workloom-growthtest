/** Real FFmpeg/FFprobe media tests. The receipt verifier is an explicit host fixture. */
import { after, afterEach, before, beforeEach, describe, it, mock } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  AUDIO_STEM_ROLES, audioStemDigest, buildAudioStemTimeline, muxAudioProgram, renderAudioStems, verifyAudioStemBundle,
} from "../bgm-bridge/audio-stems.mjs";

const bins = {
  ffmpeg: process.env.WORKLOOM_POST_FFMPEG_PATH || "ffmpeg",
  ffprobe: process.env.WORKLOOM_POST_FFPROBE_PATH || "ffprobe",
};
const scope = { tenantId: "stem-tenant", workspaceId: "stem-workspace", projectId: "stem-film", revision: 1 };
const hash = (file) => createHash("sha256").update(fs.readFileSync(file)).digest("hex");
const read = (file) => JSON.parse(fs.readFileSync(file, "utf8"));
const encode = (args) => execFileSync(bins.ffmpeg, ["-hide_banner", "-v", "error", "-y", ...args], { timeout: 30000, stdio: "pipe" });
const NA = () => ({ status: "not_applicable", reason: "Explicit approved silent role in this synthetic fixture", receipt: { fixture: true, decision: "no-role" } });
const sourceKinds = { dialogue: "tts", ambience: "synthesized_ambience", foley: "synthesized_foley", music: "composed_music" };
const verifier = async ({ binding, bindingSha256, receiptSha256 }) => ({
  status: binding.scope.projectId === scope.projectId ? "passed" : "failed", bindingSha256, receiptSha256,
});
let fixtureDir;
let root;
let files;
let video;
function source(role, file = files[role], extra = {}) {
  return { status: "ready", sourceKind: sourceKinds[role], path: file, sha256: hash(file), receipt: { fixture: true, sourceId: path.basename(file) }, ...extra };
}
function shot(id = "SC-01", overrides = {}) {
  return { shotId: id, videoSha256: hash(video), durationSec: 1,
    stems: Object.fromEntries(AUDIO_STEM_ROLES.map((role) => [role, source(role)])), ...overrides };
}
function params(overrides = {}) {
  return { scope, shots: [shot()], outDir: path.join(root, "stems"), allowedRoots: [root, fixtureDir], verifySource: verifier, bins, ...overrides };
}
function pcm(file) {
  const bytes = execFileSync(bins.ffmpeg, ["-hide_banner", "-v", "error", "-i", file, "-vn", "-ac", "1", "-ar", "48000", "-f", "f32le", "-"], { timeout: 30000, maxBuffer: 8 * 1024 * 1024 });
  return new Float32Array(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.length));
}
function amplitude(samples, frequency, startSec = 0.1, durationSec = 0.7) {
  const start = Math.round(startSec * 48000), count = Math.min(Math.round(durationSec * 48000), samples.length - start);
  let re = 0, im = 0;
  for (let index = 0; index < count; index += 1) {
    const angle = 2 * Math.PI * frequency * index / 48000;
    re += samples[start + index] * Math.cos(angle);
    im += samples[start + index] * Math.sin(angle);
  }
  return 2 * Math.hypot(re, im) / count;
}
function rms(samples, startSec, durationSec) {
  const start = Math.round(startSec * 48000), count = Math.round(durationSec * 48000);
  return Math.sqrt(samples.slice(start, start + count).reduce((total, value) => total + value * value, 0) / count);
}

before(() => {
  fixtureDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "post-audio-stems-media-")));
  files = {};
  for (const [index, role] of AUDIO_STEM_ROLES.entries()) {
    const file = path.join(fixtureDir, `${role} 单轨 ' ;.wav`);
    encode(["-f", "lavfi", "-i", `sine=frequency=${440 * (index + 1)}:sample_rate=48000:duration=1`, "-af", "volume=0.4", "-c:a", "pcm_s16le", file]);
    files[role] = file;
  }
  files.second = path.join(fixtureDir, "second.wav");
  encode(["-f", "lavfi", "-i", "sine=frequency=550:sample_rate=44100:duration=1", "-af", "volume=0.4", "-c:a", "pcm_s16le", files.second]);
  files.long = path.join(fixtureDir, "long.wav");
  encode(["-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000:duration=2", "-c:a", "pcm_s16le", files.long]);
  video = path.join(fixtureDir, "old-scored.mp4");
  encode(["-f", "lavfi", "-i", "testsrc2=size=160x120:rate=24:duration=1", "-f", "lavfi", "-i", "sine=frequency=2200:sample_rate=48000:duration=1",
    "-shortest", "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", "-c:a", "aac", video]);
});
after(() => { if (fixtureDir) fs.rmSync(fixtureDir, { recursive: true, force: true }); });
beforeEach(() => { root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "post-audio-stems-"))); });
afterEach(() => { mock.restoreAll(); if (root) fs.rmSync(root, { recursive: true, force: true }); });

describe("independent audio stem derivation", { concurrency: false }, () => {
  it("preserves each source and excludes the separate music role from the real PCM program", async () => {
    const original = Object.fromEntries(AUDIO_STEM_ROLES.map((role) => [role, hash(files[role])]));
    const result = await renderAudioStems(params());
    const manifest = read(result.manifestPath);
    assert.equal(result.recipeSha256, audioStemDigest(manifest.recipe));
    assert.deepEqual(manifest.recipe.programRoles, ["dialogue", "ambience", "foley"]);
    assert.equal(manifest.recipe.musicExcludedFromProgram, true);
    const program = pcm(result.program.path);
    for (const [index, role] of AUDIO_STEM_ROLES.entries()) {
      assert.equal(hash(files[role]), original[role]);
      assert.equal(result.roles[role].samples, 48000);
      assert.equal(result.roles[role].sha256, hash(result.roles[role].path));
      assert.ok(amplitude(pcm(result.roles[role].path), 440 * (index + 1)) > 0.02);
      const snapshot = manifest.sources.find((entry) => entry.binding.role === role).snapshot;
      assert.equal(hash(path.join(result.dir, snapshot.path)), original[role]);
    }
    for (const frequency of [440, 880, 1320]) assert.ok(amplitude(program, frequency) > 0.02);
    assert.ok(amplitude(program, 1760) < 0.00005, "music must not bleed into the program bed");
  });

  it("maps picture plus explicit program, leaving both old embedded music and stored music out", async () => {
    const stems = await renderAudioStems(params());
    const result = await muxAudioProgram({ videoPath: video, videoSha256: hash(video), programPath: stems.program.path,
      programSha256: stems.program.sha256, output: path.join(root, "clean.mp4"), allowedRoots: [root, fixtureDir], bins });
    assert.equal(result.embeddedAudioUsed, false);
    const output = pcm(result.path);
    for (const frequency of [440, 880, 1320]) assert.ok(amplitude(output, frequency) > 0.015);
    assert.ok(amplitude(output, 2200) < 0.0002, "the old video's scored track must never be mapped");
    assert.ok(amplitude(output, 1760) < 0.0002, "the retained music stem must not be mapped automatically");
  });

  it("places hard-cut stems at exact samples, including a 44.1 kHz source", async () => {
    const second = shot("SC-02"); second.stems.dialogue = source("dialogue", files.second);
    const result = await renderAudioStems(params({ shots: [shot(), second] }));
    assert.equal(result.program.samples, 96000);
    assert.deepEqual(result.recipe.timeline.shots.map((entry) => entry.startSample), [0, 48000]);
    const dialogue = pcm(result.roles.dialogue.path);
    assert.ok(amplitude(dialogue, 440, 0.1, 0.7) > 0.02);
    assert.ok(amplitude(dialogue, 550, 1.1, 0.7) > 0.02);
    assert.ok(amplitude(dialogue, 440, 1.1, 0.7) < 0.0001);
  });

  it("uses the video's fade plan without shortening or changing playback speed", async () => {
    const result = await renderAudioStems(params({ shots: [shot(), shot("SC-02")], transitions: { mode: "fade", fadeSec: 0.2 } }));
    const dialogue = pcm(result.roles.dialogue.path);
    assert.equal(result.program.samples, 96000);
    assert.ok(rms(dialogue, 0, 0.03) < rms(dialogue, 0.3, 0.03) / 4);
    assert.ok(rms(dialogue, 1, 0.03) < rms(dialogue, 1.3, 0.03) / 4);
    assert.equal(result.recipe.speedChange, false);
  });

  it("crossfades four independent roles on the same overlap sample grid", async () => {
    const second = shot("SC-02"); second.stems.dialogue = source("dialogue", files.second);
    const result = await renderAudioStems(params({ shots: [shot(), second], transitions: { mode: "xfade", fadeSec: 0.25 } }));
    assert.equal(result.program.samples, 84000);
    assert.deepEqual(result.recipe.timeline.shots.map((entry) => entry.startSample), [0, 36000]);
    assert.ok(AUDIO_STEM_ROLES.every((role) => result.roles[role].samples === 84000));
    const dialogue = pcm(result.roles.dialogue.path);
    assert.ok(amplitude(dialogue, 440, 0.81, 0.1) > 0.01);
    assert.ok(amplitude(dialogue, 550, 0.81, 0.1) > 0.01);
  });

  it("supports an aligned segment with explicit source trim and placement, and pads silence", async () => {
    const item = shot();
    item.stems.dialogue = source("dialogue", files.long, { inSec: 0.4, durationSec: 0.3, offsetSec: 0.2 });
    const result = await renderAudioStems(params({ shots: [item] }));
    const samples = pcm(result.roles.dialogue.path);
    assert.ok(rms(samples, 0, 0.1) < 1e-7);
    assert.ok(rms(samples, 0.25, 0.1) > 0.04);
    assert.ok(rms(samples, 0.6, 0.1) < 1e-7);
    assert.deepEqual(result.recipe.sources[0].placement, { inSamples: 19200, offsetSamples: 9600, takeSamples: 14400 });
  });

  it("represents all N/A roles as authorized decisions and silent exact-length files", async () => {
    const item = shot(); item.stems = Object.fromEntries(AUDIO_STEM_ROLES.map((role) => [role, NA()]));
    const result = await renderAudioStems(params({ shots: [item] }));
    assert.ok(AUDIO_STEM_ROLES.every((role) => result.roles[role].status === "not_applicable"));
    assert.equal(rms(pcm(result.program.path), 0, 1), 0);
    assert.ok(result.recipe.sources.every((entry) => entry.binding.reason && entry.receiptSha256));
  });

  it("requires actual host authority and rejects self-declared clean metadata before output", async () => {
    await assert.rejects(renderAudioStems(params({ verifySource: undefined })), { code: "audio_stems_source_unverified" });
    await assert.rejects(renderAudioStems(params({ verifySource: async () => ({ status: "passed", clean: true }) })), { code: "audio_stems_source_unverified" });
    assert.equal(fs.existsSync(path.join(root, "stems")), false);
  });

  it("binds host approval to scope, shot, role, bytes, timing and exact receipt", async () => {
    const received = [];
    await renderAudioStems(params({ verifySource: async (input) => { received.push(input); return verifier(input); } }));
    assert.equal(received.length, 8);
    assert.equal(received[0].binding.videoSha256, hash(video));
    assert.equal(received[0].binding.sourceSha256, hash(files.dialogue));
    assert.deepEqual(received[0].binding.scope, scope);
    assert.equal(received[0].binding.shotSamples, 48000);
    await assert.rejects(renderAudioStems(params({ outDir: path.join(root, "other"), scope: { ...scope, projectId: "other-project" } })), { code: "audio_stems_source_unverified" });
  });

  it("surfaces verifier failure instead of treating an unavailable authority as approval", async () => {
    await assert.rejects(renderAudioStems(params({ verifySource: async () => { throw new Error("ledger unavailable"); } })), { code: "audio_stems_source_unverified" });
  });
  it("rechecks authority after rendering and never publishes an expired grant", async () => {
    let calls = 0;
    await assert.rejects(renderAudioStems(params({ verifySource: async (input) => {
      calls += 1;
      return calls <= 4 ? verifier(input) : { status: "expired" };
    } })), { code: "audio_stems_source_unverified" });
    assert.equal(fs.existsSync(path.join(root, "stems", "audio-stems.json")), false);
    assert.equal(read(path.join(root, "stems", "failed.json")).code, "audio_stems_source_unverified");
  });

  it("rejects unknown/mixed provenance and reusing the same bytes as two independent roles", async () => {
    for (const sourceKind of ["unknown_embedded", "mixed_native", "ffmpeg-center", "separated", "tts"]) {
      const item = shot(); item.stems.ambience.sourceKind = sourceKind;
      await assert.rejects(renderAudioStems(params({ shots: [item] })), { code: "audio_stems_source_unverified" });
    }
    const item = shot(); item.stems.ambience = source("ambience", files.dialogue);
    await assert.rejects(renderAudioStems(params({ shots: [item] })), { code: "audio_stems_source_unverified" });
  });

  it("rejects a video file declared as an independent dialogue stem", async () => {
    const item = shot(); item.stems.dialogue = source("dialogue", video);
    await assert.rejects(renderAudioStems(params({ shots: [item] })), { code: "audio_stems_source_unverified" });
    assert.equal(fs.existsSync(path.join(root, "stems", "audio-stems.json")), false);
    assert.equal(read(path.join(root, "stems", "failed.json")).status, "failed");
  });

  it("rejects a source changed after authority verification", async () => {
    const file = path.join(root, "mutable.wav"); fs.copyFileSync(files.dialogue, file);
    const item = shot(); item.stems.dialogue = source("dialogue", file);
    let changed = false;
    await assert.rejects(renderAudioStems(params({ shots: [item], verifySource: async (input) => {
      if (!changed) { changed = true; fs.appendFileSync(file, "changed"); }
      return verifier(input);
    } })), { code: "audio_stems_stale" });
    assert.equal(fs.existsSync(path.join(root, "stems", "audio-stems.json")), false);
  });

  it("rejects both direct and intermediate source symlinks", async () => {
    fs.symlinkSync(files.dialogue, path.join(root, "link.wav"));
    fs.symlinkSync(fixtureDir, path.join(root, "linked-directory"), "dir");
    for (const [index, file] of [path.join(root, "link.wav"), path.join(root, "linked-directory", path.basename(files.dialogue))].entries()) {
      const item = shot(); item.stems.dialogue = source("dialogue", file);
      await assert.rejects(renderAudioStems(params({ shots: [item], outDir: path.join(root, `symlink-${index}`) })), { code: "path_not_allowed" });
    }
  });

  it("rejects path escape and permission errors with explicit failure receipts", async () => {
    await assert.rejects(renderAudioStems(params({ allowedRoots: [root] })), { code: "path_not_allowed" });
    const open = fsp.open.bind(fsp);
    mock.method(fsp, "open", async (file, ...args) => {
      if (file === files.dialogue) throw Object.assign(new Error("permission denied"), { code: "EACCES" });
      return open(file, ...args);
    });
    await assert.rejects(renderAudioStems(params({ outDir: path.join(root, "permission") })), { code: "audio_stems_io_failed" });
    assert.equal(read(path.join(root, "permission", "failed.json")).code, "audio_stems_io_failed");
  });

  it("does not silently crop or speed up an overlong source", async () => {
    const item = shot(); item.stems.dialogue = source("dialogue", files.long);
    await assert.rejects(renderAudioStems(params({ shots: [item] })), { code: "audio_stems_alignment_failed" });
  });

  it("claims one output directory exclusively under two concurrent real renders", async () => {
    const outcomes = await Promise.allSettled([renderAudioStems(params()), renderAudioStems(params())]);
    assert.equal(outcomes.filter((entry) => entry.status === "fulfilled").length, 1);
    assert.equal(outcomes.find((entry) => entry.status === "rejected").reason.code, "audio_stems_busy");
    const before = hash(path.join(root, "stems", "audio-stems.json"));
    await assert.rejects(renderAudioStems(params()), { code: "audio_stems_busy" });
    assert.equal(hash(path.join(root, "stems", "audio-stems.json")), before);
  });

  it("keeps a failed render inspectable but never publishes a completed manifest", async () => {
    const fake = path.join(root, "failed-ffmpeg.sh");
    fs.writeFileSync(fake, '#!/bin/sh\nif [ "$1" = "-version" ]; then echo "fixture ffmpeg version"; exit 0; fi\nfor arg in "$@"; do last="$arg"; done\nprintf partial > "$last"\nexit 7\n', { mode: 0o700 });
    await assert.rejects(renderAudioStems(params({ bins: { ...bins, ffmpeg: fake } })), { code: "ffmpeg_failed" });
    assert.equal(read(path.join(root, "stems", "failed.json")).code, "ffmpeg_failed");
    assert.equal(fs.existsSync(path.join(root, "stems", "audio-stems.json")), false);
    await assert.rejects(renderAudioStems(params()), { code: "audio_stems_busy" });
  });

  it("rejects invalid timeline, role and N/A contracts before creating output", async () => {
    for (const shots of [[], [shot(), shot()], [shot("one", { durationSec: NaN })], [shot("one", { durationSec: 0 })]]) {
      assert.throws(() => buildAudioStemTimeline({ shots }));
    }
    for (const change of [
      (item) => { delete item.stems.foley; },
      (item) => { item.stems.foley = { ...NA(), reason: "" }; },
      (item) => { item.stems.foley = { ...NA(), path: files.foley }; },
      (item) => { item.stems.dialogue.offsetSec = 1; },
      (item) => { item.stems.dialogue.receipt = { invalid: () => true }; },
    ]) {
      const item = shot(); change(item);
      await assert.rejects(renderAudioStems(params({ shots: [item] })));
    }
    assert.equal(fs.existsSync(path.join(root, "stems")), false);
  });

  it("fails mux on stale hashes or duration mismatch and never overwrites an existing file", async () => {
    const stems = await renderAudioStems(params());
    const options = { videoPath: video, videoSha256: hash(video), programPath: stems.program.path,
      programSha256: stems.program.sha256, output: path.join(root, "mux.mp4"), allowedRoots: [root, fixtureDir], bins };
    await assert.rejects(muxAudioProgram({ ...options, programSha256: "a".repeat(64) }), { code: "audio_stems_stale" });
    await assert.rejects(muxAudioProgram({ ...options, programPath: files.long, programSha256: hash(files.long) }), { code: "audio_stems_alignment_failed" });
    fs.writeFileSync(options.output, "existing original");
    await assert.rejects(muxAudioProgram(options), { code: "audio_stems_busy" });
    assert.equal(fs.readFileSync(options.output, "utf8"), "existing original");
  });
});


describe("frozen stem bundle cache revalidation", { concurrency: false }, () => {
  async function frozen() {
    const bundle = await renderAudioStems(params());
    return { bundle, options: { dir: bundle.dir, expectedManifestSha256: bundle.manifestSha256,
      expectedRecipeSha256: bundle.recipeSha256, scope, verifySource: verifier, allowedRoots: [root, fixtureDir], bins } };
  }
  it("reopens exact current sources and deterministically derives every retained PCM output", async () => {
    const { bundle, options } = await frozen();
    const verified = await verifyAudioStemBundle(options);
    assert.equal(verified.program.sha256, bundle.program.sha256);
    assert.equal(verified.manifestSha256, bundle.manifestSha256);
    assert.ok(fs.readdirSync(bundle.dir).every((name) => !name.startsWith(".verify-")));
  });
  it("rejects changed role/program/source bytes and externally pinned manifest hashes", async () => {
    const { bundle, options } = await frozen();
    for (const file of [bundle.program.path, bundle.roles.dialogue.path,
      path.join(bundle.dir, bundle.sources[0].snapshot.path), bundle.manifestPath]) {
      const original = fs.readFileSync(file);
      fs.appendFileSync(file, "tampered");
      await assert.rejects(verifyAudioStemBundle(options));
      fs.writeFileSync(file, original);
    }
  });
  it("rechecks verifier failure and current project scope on every cache read", async () => {
    const { options } = await frozen();
    await assert.rejects(verifyAudioStemBundle({ ...options, verifySource: async () => ({ status: "failed" }) }), { code: "audio_stems_source_unverified" });
    await assert.rejects(verifyAudioStemBundle({ ...options, scope: { ...scope, workspaceId: "other" } }), { code: "audio_stems_stale" });
  });
  it("cannot forge a clean program by replacing it with retained music and recomputing public hashes", async () => {
    const { bundle, options } = await frozen();
    const manifest = read(bundle.manifestPath);
    fs.copyFileSync(bundle.roles.music.path, bundle.program.path);
    manifest.program.sha256 = hash(bundle.program.path);
    manifest.program.bytes = fs.statSync(bundle.program.path).size;
    fs.writeFileSync(bundle.manifestPath, JSON.stringify(manifest));
    await assert.rejects(verifyAudioStemBundle({ ...options, expectedManifestSha256: hash(bundle.manifestPath) }), { code: "audio_stems_stale" });
  });
  it("does not let a verifier mutate the bound scope, timing or receipt", async () => {
    await assert.rejects(renderAudioStems(params({ verifySource: async (input) => {
      input.binding.scope.projectId = "other";
      return verifier(input);
    } })), { code: "audio_stems_source_unverified" });
  });
});
