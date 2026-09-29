/** Native integration: real FFmpeg, signed synthetic inputs, actual CLI and HTTP processes. */
import assert from "node:assert/strict";
import { before, after, describe, it } from "node:test";
import { createHash, createHmac, randomBytes } from "node:crypto";
import { execFileSync, spawn } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { mix, callTool } from "./core.mjs";
import { renderAudioStems, describeAudioStemSources } from "./audio-stems.mjs";
import { audioStemReceiptPayload, createAudioStemReceiptVerifier } from "./audio-stems-trust.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const bins = { ffmpeg: process.env.WORKLOOM_POST_FFMPEG_PATH || "ffmpeg", ffprobe: process.env.WORKLOOM_POST_FFPROBE_PATH || "ffprobe" };
const scope = { tenantId: "fixture-t", workspaceId: "fixture-w", projectId: "fixture-p", revision: 1 };
const secret = randomBytes(32).toString("hex");
const env = { ...process.env, WORKLOOM_AUDIO_STEM_SIGNING_SECRET: secret,
  WORKLOOM_AUDIO_STEM_SIGNING_KEY_ID: "fixture-only", WORKLOOM_BGM_DISCOVER: "0" };
const hash = (file) => createHash("sha256").update(fs.readFileSync(file)).digest("hex");
const encode = (args) => execFileSync(bins.ffmpeg, ["-hide_banner", "-v", "error", "-y", ...args], { timeout: 30000, stdio: "pipe" });
let root, video, music, bundle, reference, shot;
function authorize(item) {
  for (const { binding, bindingSha256 } of describeAudioStemSources({ scope, shots: [item] })) {
    const now = Date.now();
    const receipt = { schemaVersion: "workloom.audio-stem-receipt/v1", purpose: "independent-audio-source", bindingSha256,
      workerId: "synthetic-fixture-worker", jobId: "fixture-job", evidenceSha256: "b".repeat(64),
      issuedAt: new Date(now - 1000).toISOString(), expiresAt: new Date(now + 3600000).toISOString(), keyId: "fixture-only" };
    receipt.signature = createHmac("sha256", secret).update(audioStemReceiptPayload(receipt)).digest("hex");
    item.stems[binding.role].receipt = receipt;
  }
  return item;
}
function pcm(file) {
  const bytes = execFileSync(bins.ffmpeg, ["-v", "error", "-i", file, "-vn", "-ac", "1", "-ar", "48000", "-f", "f32le", "-"], { maxBuffer: 8 << 20 });
  return new Float32Array(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
}
function amplitude(samples, frequency, startSec, lengthSec = 0.5) {
  const start = Math.round(startSec * 48000), length = Math.round(lengthSec * 48000);
  let re = 0, im = 0;
  for (let index = 0; index < length; index += 1) {
    re += samples[start + index] * Math.cos(2 * Math.PI * frequency * index / 48000);
    im += samples[start + index] * Math.sin(2 * Math.PI * frequency * index / 48000);
  }
  return 2 * Math.hypot(re, im) / length;
}
function options(name, extra = {}) {
  return { input: video, output: path.join(root, `${name}.mp4`), bgmPath: music, audioStems: reference,
    policy: "keep-dialogue", musicLevelDb: -24, duckingDb: 12, fadeInSec: 0.1, fadeOutSec: 0.1,
    align: false, section: "full", env, bins, ...extra };
}
async function subprocess(file, args, childEnv = env) {
  const child = spawn(process.execPath, [file, ...args], { env: childEnv, stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "", stderr = "";
  child.stdout.on("data", (chunk) => { stdout += chunk; });
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  const timer = setTimeout(() => child.kill("SIGKILL"), 120000);
  try { const [code] = await once(child, "close"); return { code, stdout, stderr }; }
  finally { clearTimeout(timer); }
}
async function startServer(kind) {
  const prefix = `WORKLOOM_${kind.toUpperCase()}`;
  const child = spawn(process.execPath, [path.join(here, `../${kind}-bridge/server.mjs`)], {
    env: { ...env, [`${prefix}_BRIDGE_PORT`]: "0", [`${prefix}_BRIDGE_TOKEN`]: "test-only-bridge-token", [`${prefix}_BRIDGE_TENANT`]: scope.tenantId,
      [`${prefix}_JOBS_DIR`]: path.join(root, `${kind}-jobs`) }, stdio: ["ignore", "pipe", "pipe"],
  });
  let text = "", stderr = "";
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  const port = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`server readiness timed out: ${stderr}`)), 20000);
    child.once("exit", (code) => { clearTimeout(timer); reject(new Error(`server exited ${code}: ${stderr}`)); });
    child.stdout.on("data", (chunk) => {
      text += chunk;
      const found = /listening on http:\/\/127\.0\.0\.1:(\d+)/.exec(text);
      if (found) { clearTimeout(timer); resolve(Number(found[1])); }
    });
  });
  const request = (tool, params, token = "test-only-bridge-token") => fetch(`http://127.0.0.1:${port}/action`, {
    method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify({ tool, params: { tenant_id: scope.tenantId, ...params } }),
  }).then(async (response) => ({ status: response.status, body: await response.json() }));
  return { request, stop: async () => { child.kill("SIGTERM"); await once(child, "close"); } };
}

before(async () => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "post6-signed-mix-")));
  env.WORKLOOM_BGM_ALLOWED_ROOTS = root;
  env.WORKLOOM_POST_ALLOWED_ROOTS = root;
  video = path.join(root, "old-scored.mp4");
  music = path.join(root, "new-music.wav");
  encode(["-f", "lavfi", "-i", "testsrc2=size=160x120:rate=24:duration=8", "-f", "lavfi", "-i", "sine=frequency=2200:sample_rate=48000:duration=8",
    "-shortest", "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", "-c:a", "aac", video]);
  encode(["-f", "lavfi", "-i", "sine=frequency=3300:sample_rate=48000:duration=8", "-c:a", "pcm_s16le", music]);
  const stems = {};
  for (const [role, frequency, volume, kind] of [["dialogue", 440, 2, "tts"], ["ambience", 880, 0.015, "synthesized_ambience"],
    ["foley", 1320, 0.01, "synthesized_foley"], ["music", 1760, 0.4, "composed_music"]]) {
    const file = path.join(root, `${role}.wav`);
    const gate = role === "dialogue" ? ",volume='if(between(t,1,2.5)+between(t,4,5.5),1,0)':eval=frame" : "";
    encode(["-f", "lavfi", "-i", `sine=frequency=${frequency}:sample_rate=48000:duration=8`, "-af", `volume=${volume}${gate}`, "-c:a", "pcm_f32le", file]);
    stems[role] = { status: "ready", sourceKind: kind, path: file, sha256: hash(file) };
  }
  shot = authorize({ shotId: "one", videoSha256: hash(video), durationSec: 8, stems });
  bundle = await renderAudioStems({ scope, shots: [shot], outDir: path.join(root, "stems"), allowedRoots: [root], bins,
    verifySource: createAudioStemReceiptVerifier({ env }) });
  reference = { dir: bundle.dir, manifestSha256: bundle.manifestSha256, recipeSha256: bundle.recipeSha256, scope };
}, { timeout: 60000 });
after(async () => { if (root) await fsp.rm(root, { recursive: true, force: true }); });

describe("signed stems in normal mixer", { concurrency: false }, () => {
  it("mixes only program plus newly selected music and measures independent tracks after the same gain", async () => {
    const result = await mix(options("normal"));
    assert.ok(Object.values(result.checks).every((value) => value === true));
    assert.equal(result.independentAudio.embeddedAudioUsed, false);
    assert.equal(result.loudness.normalization.method, "shared-linear-gain");
    assert.equal(result.loudness.normalization.limiterApplied, false);
    assert.ok(result.levels.speechToMusicMarginDb >= 3);
    assert.ok(result.levels.duckingDepthDb <= -4);
    const samples = pcm(result.output.path);
    assert.ok(amplitude(samples, 440, 1.5) > 0.02);
    assert.ok(amplitude(samples, 3300, 3) > 0.005);
    assert.ok(amplitude(samples, 1760, 3) < 0.0002, "retained previous music is excluded");
    assert.ok(amplitude(samples, 2200, 3) < 0.0002, "embedded old music is excluded");
    for (const track of result.retainedTracks) assert.equal(hash(track.path), track.sha256);
    await assert.rejects(mix(options("normal")), { code: "idempotency_conflict" });
  });
  it("has no mixed/embedded fallback and no default signing key", async () => {
    await assert.rejects(mix(options("missing", { audioStems: null })), { code: "audio_stems_source_unverified" });
    await assert.rejects(mix(options("untrusted", { env: { ...env, WORKLOOM_AUDIO_STEM_SIGNING_SECRET: undefined } })), { code: "audio_stems_source_unverified" });
    await assert.rejects(mix(options("wrong-scope", { audioStems: { ...reference, scope: { ...scope, projectId: "other" } } })), { code: "audio_stems_stale" });
    assert.equal(fs.existsSync(path.join(root, "missing.mp4")), false);
  });
  it("does not permit music-only to discard signed dialogue", async () => {
    await assert.rejects(mix(options("discard", { policy: "music-only", allowDiscardOriginal: true })), { code: "audio_stems_source_unverified" });
  });
  it("rejects invalid numeric controls before media work", async () => {
    for (const overrides of [{ targetLufs: NaN }, { truePeak: Infinity }, { fadeInSec: -1 }, { musicLevelDb: 12 }]) {
      await assert.rejects(mix(options("invalid-controls", overrides)), { code: "bad_request" });
    }
  });
  it("treats signed dialogue N/A explicitly instead of fabricating voice measurements", async () => {
    const noVoice = structuredClone(shot);
    noVoice.stems.dialogue = { status: "not_applicable", reason: "This synthetic clip intentionally contains no speech" };
    authorize(noVoice);
    const silent = await renderAudioStems({ scope, shots: [noVoice], outDir: path.join(root, "no-dialogue"), allowedRoots: [root], bins,
      verifySource: createAudioStemReceiptVerifier({ env }) });
    const result = await mix(options("no-dialogue-mix", { audioStems: { ...reference, dir: silent.dir,
      manifestSha256: silent.manifestSha256, recipeSha256: silent.recipeSha256 } }));
    assert.equal(result.applicability.dialogue_preserved, "not_applicable");
    assert.equal(result.levels.speechToMusicMarginDb, null);
    assert.equal(result.levels.duckingDepthDb, null);
    assert.equal(result.checks.dialogue_preserved, true);
    assert.equal(result.checks.ducking_applied, true);
  });
  it("normal tool and CLI consume the pinned signed bundle and expose its measured result", async () => {
    const args = options("tool");
    const result = await callTool("bgmwrite.mix", { input_path: args.input, output_path: args.output, bgm_path: args.bgmPath,
      audio_stems: reference, align: false, fade_in_sec: 0.1, fade_out_sec: 0.1, music_level_db: -24 }, { env, bins });
    assert.equal(result.receipt.synced, true);
    assert.equal(result.result.independentAudio.manifestSha256, reference.manifestSha256);
    const referencePath = path.join(root, "pinned.json"); fs.writeFileSync(referencePath, JSON.stringify(reference));
    const cli = await subprocess(path.join(here, "cli.mjs"), ["mix", "--in", video, "--out", path.join(root, "cli.mp4"),
      "--bgm", music, "--audio-stems", referencePath, "--music-level", "-24"]);
    assert.equal(cli.code, 0, cli.stderr);
    assert.ok(cli.stdout.includes("已配乐"));
    assert.ok(amplitude(pcm(path.join(root, "cli.mp4")), 2200, 3) < 0.0002);
  }, { timeout: 120000 });
  it("post CLI retains shots.json source descriptors and rejects a tampered signature", async () => {
    const projectFile = path.join(root, "project.json"), shotsFile = path.join(root, "shots.json");
    fs.writeFileSync(projectFile, JSON.stringify({ projectId: scope.projectId, audioScope: scope, resolution: [160, 120], fps: 24 }));
    const invalid = structuredClone(shot.stems); invalid.dialogue.receipt.signature = "0".repeat(64);
    fs.writeFileSync(shotsFile, JSON.stringify([{ shotId: "one", path: video, audioStems: invalid }]));
    const result = await subprocess(path.join(here, "../post-bridge/cli.mjs"), ["deliver", "--project", projectFile,
      "--shots", shotsFile, "--out-dir", path.join(root, "invalid-post"), "--variants", "warm-story,clean-tech"]);
    assert.equal(result.code, 3);
    assert.ok(result.stderr.includes("audio_stems_source_unverified"), result.stderr);
    assert.ok(!result.stderr.includes("每镜必须提供"), "CLI must not discard descriptors");
  }, { timeout: 120000 });
  it("real HTTP bridge shares an in-flight write but rejects completed stale-success replay and key conflicts", async () => {
    const server = await startServer("bgm");
    try {
      const params = { input_path: video, output_path: path.join(root, "http.mp4"), bgm_path: music,
        audio_stems: reference, align: false, music_level_db: -24, fade_in_sec: 0.1, fade_out_sec: 0.1, idempotency_key: "same-fixture-key" };
      const crossTenant = await server.request("bgmwrite.mix", { ...params, idempotency_key: "nested-tenant",
        audio_stems: { ...reference, scope: { ...scope, tenantId: "other" } } });
      assert.equal(crossTenant.status, 403);
      const [first, second] = await Promise.all([server.request("bgmwrite.mix", params), server.request("bgmwrite.mix", params)]);
      assert.equal(first.body.ok, true, JSON.stringify(first.body));
      assert.equal(second.body.ok, true, JSON.stringify(second.body));
      assert.equal(first.body.job_id, second.body.job_id);
      assert.ok(first.body.idempotent_inflight || second.body.idempotent_inflight);
      const replay = await server.request("bgmwrite.mix", params);
      assert.equal(replay.status, 409); assert.equal(replay.body.error, "idempotency_revalidation_required");
      const conflict = await server.request("bgmwrite.mix", { ...params, music_level_db: -28 });
      assert.equal(conflict.status, 409); assert.equal(conflict.body.error, "idempotency_conflict");
      assert.equal((await server.request("bgmwrite.mix", params, "wrong")).status, 401);
      assert.equal((await server.request("bgmwrite.mix", { ...params, tenant_id: "other" })).status, 403);
    } finally { await server.stop(); }
  }, { timeout: 120000 });
  it("post HTTP bridge also rejects completed request replay and different-payload key reuse", async () => {
    const server = await startServer("post");
    try {
      const params = { patch: { copy: { body: "fixture" } }, idempotency_key: "post-fixture" };
      assert.equal((await server.request("postread.impact", params)).body.ok, true);
      assert.equal((await server.request("postread.impact", params)).body.error, "idempotency_revalidation_required");
      assert.equal((await server.request("postread.impact", { ...params, patch: {} })).body.error, "idempotency_conflict");
    } finally { await server.stop(); }
  });
});
