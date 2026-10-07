import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import test from "node:test";
import { adoptLegacyOriginalRenders, assertStandardPostAudioClock, assertStandardPostVariantAxes, captureOriginalRenderManifest, freezeOriginalSubmission, issueOriginalRenderReceipt,
  loadOriginalRenderManifest, resolveStandardPostBinary, standardPostFileHash, StandardPostError, validateStandardPostSettings, type StandardPostSettings } from "./film-standard-post.mjs";
const hash = (bytes: Buffer | string) => createHash("sha256").update(bytes).digest("hex");
const repo = resolve(import.meta.dirname, "../.."), cli = join(repo, "scripts/tools/full-chain-film.mts");
const ffmpeg = process.env.WL_FFMPEG ?? "ffmpeg", ffprobe = process.env.WL_FFPROBE ?? "ffprobe";
function call(args: string[]) { return spawnSync(process.execPath, ["--import", "tsx", cli, ...args], { cwd: repo, encoding: "utf8", timeout: 30_000,
  env: { ...process.env, FILM_WORKER_MODE: "", WL_FFMPEG: ffmpeg, WL_FFPROBE: ffprobe } }); }
function media(file: string) {
  const result = spawnSync(ffmpeg, ["-v", "error", "-nostdin", "-n", "-f", "lavfi", "-i", "testsrc2=s=160x288:r=24:d=1",
    "-f", "lavfi", "-i", `sine=frequency=${basename(file) === "S2.mp4" ? 866 : 733}:sample_rate=48000:duration=1`, "-map", "0:v:0", "-map", "1:a:0", "-c:v", "libx264", "-preset", "ultrafast",
    "-pix_fmt", "yuv420p", "-c:a", "aac", "-ar", "48000", "-ac", "2", "-t", "1", file], { encoding: "utf8", timeout: 60_000 });
  assert.equal(result.status, 0, result.stderr);
}
async function fixture(prefix = "standard-original-fixture-") {
  const root = realpathSync(mkdtempSync(join(tmpdir(), prefix))), projectId = "MOCK-STANDARD";
  const bytes = Buffer.from(JSON.stringify({ projectId, durationSeconds: 2, shots: [{ shotId: "S1", duration: 1 }, { shotId: "S2", duration: 1 }] }));
  const submitted = await freezeOriginalSubmission({ productionRoot: root, projectId, bytes });
  const clips = join(root, "clips", projectId); mkdirSync(clips, { recursive: true });
  for (const shotId of ["S1", "S2"]) {
    const file = join(clips, `${shotId}.mp4`); media(file);
    const accepted = join(root, "logs", projectId, "accepted-tasks"); mkdirSync(accepted, { recursive: true });
    writeFileSync(join(accepted, `${shotId}.json`), JSON.stringify({ schemaVersion: "workloom.render-task/v1", state: "accepted", taskId: `mock-${shotId}-accepted`, requestHash: hash(`mock-request-${shotId}`) }));
    await issueOriginalRenderReceipt({ productionRoot: root, projectId, shotId, submittedSha256: submitted.sha256,
      artifactPath: file, taskId: `mock-${shotId}-accepted`, requestInputVerified: true });
  }
  const manifestFile = await captureOriginalRenderManifest({ productionRoot: root, projectId });
  return { root, projectId, clips, bytes, submitted, manifestFile, receipt: join(root, "logs", projectId, "original-issued", "S1.json") };
}
const options = { ffprobe, timeoutMs: 60_000 };
async function using(action: (f: Awaited<ReturnType<typeof fixture>>) => Promise<void>) {
  const f = await fixture(); try { await action(f); } finally { rmSync(f.root, { recursive: true, force: true }); }
}
function settings(root: string): StandardPostSettings { return { schemaVersion: "workloom.standard-post-settings/v1", music: [], subtitleFontsRoot: root,
  subtitles: [{ startSec: 0.1, endSec: 0.9, text: "原镜 原声" }], cover: { sourceShotId: "S1", atSec: 0.5, title: "服务", platform: "wechat-channels",
    fontFile: join(root, "font.otf"), fontSha256: "a".repeat(64) }, versions: [{ id: "master", profile: "none", intensity: 0 },
      { id: "warm-film", profile: "warm-film", intensity: 0.65 }, { id: "cool-tech", profile: "cool-technical", intensity: 0.65 },
      { id: "punchy-social", profile: "high-contrast-social", intensity: 0.6 }] }; }
test("issued original manifest rebuilds exact complete native timeline from real current media", async () => using(async f => {
  const sourceBefore = hash(readFileSync(join(f.clips, "S1.mp4"))), loaded = await loadOriginalRenderManifest(f.manifestFile, options);
  assert.equal(loaded.durationSec, 2); assert.equal(loaded.totalFrames, 48); assert.equal(loaded.fps, 24);
  assert.deepEqual(loaded.timeline.map(s => s.shotId), ["S1", "S2"]); assert.equal(loaded.manifestSha256, hash(readFileSync(f.manifestFile)));
  for (const row of loaded.timeline) { assert.deepEqual(row.video, row.audio); assert.equal(row.video.inSec, 0); assert.equal(row.speed, 1); }
  assert.equal(hash(readFileSync(join(f.clips, "S1.mp4"))), sourceBefore);
  assert.deepEqual(validateStandardPostSettings(settings(f.root), loaded.contract), settings(f.root));
}));
test("temporary ancestor names containing S2 cannot turn two distinct original fixtures into duplicate media", async () => {
  const f = await fixture("standard-original-fixture-S2-");
  try {
    assert.notEqual(hash(readFileSync(join(f.clips, "S1.mp4"))), hash(readFileSync(join(f.clips, "S2.mp4"))));
    const loaded = await loadOriginalRenderManifest(f.manifestFile, options);
    assert.deepEqual(loaded.timeline.map(row => row.shotId), ["S1", "S2"]);
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});
test("a missing canonical manifest returns the stable standard error before media probing", async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "standard-missing-manifest-")));
  try {
    await assert.rejects(loadOriginalRenderManifest(join(root, "missing.json"), { ffprobe: "must-not-be-invoked" }),
      (error: unknown) => error instanceof StandardPostError && error.code === "STANDARD_POST_INVALID" && /ENOENT/.test(error.message));
  } finally { rmSync(root, { recursive: true, force: true }); }
});
test("a missing issued receipt fails capture with the stable error and publishes no manifest", async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "standard-missing-receipt-"))), projectId = "MOCK-MISSING";
  try {
    await freezeOriginalSubmission({ productionRoot: root, projectId,
      bytes: Buffer.from(JSON.stringify({ projectId, shots: [{ shotId: "EMPTY", duration: 4 }] })) });
    await assert.rejects(captureOriginalRenderManifest({ productionRoot: root, projectId }),
      (error: unknown) => error instanceof StandardPostError && error.code === "STANDARD_POST_INVALID" && /EMPTY\.json.*ENOENT/.test(error.message));
    assert.equal(existsSync(join(root, "logs", projectId, "original-render-manifest.json")), false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
test("final audio guard counts the full real original clock and records codec boundary samples", async () => using(async f => {
  const file = join(f.clips, "S1.mp4"), before = hash(readFileSync(file));
  const result = await assertStandardPostAudioClock(file, 1, { ffmpeg, timeoutMs: 60_000 });
  assert.equal(result.requiredSamples, 48000); assert.ok(result.samplesPerChannel >= 48000);
  assert.equal(result.bytes / 4, result.samplesPerChannel); assert.equal(result.codecBoundarySamples, result.samplesPerChannel - 48000);
  assert.equal(hash(readFileSync(file)), before);
}));
test("final audio guard refuses a real short audio track without padding it or altering the file", async () => using(async f => {
  const file = join(f.root, "mock-short-native-audio.mp4");
  const encode = spawnSync(ffmpeg, ["-v", "error", "-nostdin", "-n", "-f", "lavfi", "-i", "color=s=160x288:r=24:d=1",
    "-f", "lavfi", "-i", "sine=frequency=733:sample_rate=48000:duration=0.96", "-map", "0:v:0", "-map", "1:a:0",
    "-c:v", "libx264", "-c:a", "aac", "-ar", "48000", "-ac", "2", file], { encoding: "utf8", timeout: 60_000 });
  assert.equal(encode.status, 0, encode.stderr); const before = hash(readFileSync(file));
  await assert.rejects(assertStandardPostAudioClock(file, 1, { ffmpeg, timeoutMs: 60_000 }), /STANDARD_POST_NATIVE_CLOCK_INCOMPLETE/);
  assert.equal(hash(readFileSync(file)), before);
}));
const settingsMutations: Array<[string, (s: any) => void]> = [
  ["arbitrary sources", s => { s.sources = []; }], ["arbitrary segments", s => { s.segments = []; }], ["exclusion list", s => { s.forbiddenVideoSourceIds = ["S1"]; }],
  ["replacement project", s => { s.projectId = "OTHER"; }], ["fps override", s => { s.fps = 30; }], ["dimensions override", s => { s.width = 720; }],
  ["duration override", s => { s.durationSec = 1; }], ["voice source", s => { s.audio = { path: "/tmp/voice.mp4" }; }],
  ["transition", s => { s.transition = "crossfade"; }], ["speed", s => { s.speed = 2; }], ["crop", s => { s.crop = true; }], ["retime", s => { s.retime = true; }],
  ["source inpoint", s => { s.cover.videoInSec = 0.5; }], ["wrong cover shot", s => { s.cover.sourceShotId = "MISSING"; }],
  ["cover past end", s => { s.cover.atSec = 1; }], ["remote font", s => { s.cover.fontFile = "https://example.invalid/font"; }],
  ["unknown font", s => { s.cover.fontId = "mock-unknown-font"; }], ["unknown platform", s => { s.cover.platform = "mock-channel"; }],
  ["subtitle overflow", s => { s.subtitles[0].endSec = 3; }], ["subtitle injection", s => { s.subtitles[0].text = "{\\pos(0,0)}"; }],
  ["subtitle overlap", s => { s.subtitles.push({ startSec: 0.5, endSec: 1, text: "overlap" }); }], ["subtitle precision", s => { s.subtitles[0].startSec = 0.123; }],
  ["empty subtitle", s => { s.subtitles[0].text = ""; }], ["missing master", s => { s.versions[0].id = "cool-tech"; }],
  ["duplicate variant", s => { s.versions.push({ ...s.versions[0] }); }], ["unknown color", s => { s.versions[0].profile = "mock-filter"; }],
  ["hidden filter", s => { s.versions[0].filter = "setpts=2*PTS"; }], ["music without source", s => { s.versions[0].musicLevelDb = -20; }],
  ["unbound music", s => { s.versions[0].musicSourceId = "MISSING"; }], ["original as music", s => { s.music = [{ id: "S1", path: "/tmp/music.wav", sha256: "a".repeat(64), bytes: 1 }]; }],
];
test("post layer schema refuses every free-edit and malformed post setting before external work", async () => using(async f => {
  const loaded = await loadOriginalRenderManifest(f.manifestFile, options);
  for (const [label, mutate] of settingsMutations) { const input = settings(f.root); mutate(input); assert.throws(() => validateStandardPostSettings(input, loaded.contract), /STANDARD_POST_INVALID/, label); }
}));
test("standard delivery requires three styles and rejects repeated grade or music bytes before media work", async () => using(async f => {
  const loaded = await loadOriginalRenderManifest(f.manifestFile, options), full = settings(f.root);
  full.music = ["warm", "cool", "punchy"].map((id, i) => ({ id, path: join(f.root, `${id}.wav`), sha256: String(i + 1).repeat(64), bytes: 4000 }));
  full.versions.slice(1).forEach((v, i) => Object.assign(v, { musicSourceId: full.music[i]!.id, musicLevelDb: -24, duckingDb: 12, musicBpm: 120 }));
  assert.deepEqual(validateStandardPostSettings(full, loaded.contract), full);
  const mutations: Array<[string, (s: StandardPostSettings) => void]> = [
    ["master-only", s => { s.versions = s.versions.slice(0, 1); }],
    ["two styles", s => { s.versions.pop(); }],
    ["same grade under different style labels", s => { s.versions[2]!.profile = s.versions[1]!.profile; }],
    ["same source id", s => { s.versions[2]!.musicSourceId = s.versions[1]!.musicSourceId; }],
    ["same source bytes under different id and path", s => { s.music[1]!.sha256 = s.music[0]!.sha256; }],
    ["partially missing music", s => { for (const k of ["musicSourceId", "musicLevelDb", "duckingDb", "musicBpm"] as const) delete s.versions[2]![k]; }],
  ];
  for (const [label, mutate] of mutations) {
    const changed = structuredClone(full); mutate(changed);
    assert.throws(() => validateStandardPostSettings(changed, loaded.contract), /STANDARD_POST_VARIANTS_INVALID/, label);
  }
  assert.deepEqual(validateStandardPostSettings(settings(f.root), loaded.contract), settings(f.root), "all three explicitly unscored styles retain the existing BGM-off boundary");
}));
test("actual final cover and consumed BGM receipts must satisfy the established three-axis gate", () => {
  const plan = settings("/synthetic"), variants = plan.versions.slice(1);
  plan.music = variants.map((v, i) => ({ id: v.id, path: `/synthetic/${v.id}.wav`, sha256: String(i + 1).repeat(64), bytes: 4000 }));
  variants.forEach((v, i) => { v.musicSourceId = plan.music[i]!.id; });
  const outputs = variants.map((v, i) => ({ id: v.id, coverReceipt: { cover: { sha256: String(i + 4).repeat(64) } },
    bgm: { bgm: { sha256: plan.music[i]!.sha256, playedSha256: plan.music[i]!.sha256 } } }));
  assert.equal(assertStandardPostVariantAxes(plan, outputs).ok, true);
  const sameCover = structuredClone(outputs); sameCover[1]!.coverReceipt.cover.sha256 = sameCover[0]!.coverReceipt.cover.sha256;
  assert.throws(() => assertStandardPostVariantAxes(plan, sameCover), /STANDARD_POST_VARIANTS_INVALID/);
  for (const key of ["sha256", "playedSha256"] as const) {
    const wrongMusic = structuredClone(outputs); wrongMusic[1]!.bgm.bgm[key] = "f".repeat(64);
    assert.throws(() => assertStandardPostVariantAxes(plan, wrongMusic), /STANDARD_POST_VARIANTS_INVALID/);
  }
  assert.throws(() => assertStandardPostVariantAxes(plan, outputs.slice(0, 2)), /STANDARD_POST_VARIANTS_INVALID/);
  variants.forEach(v => { delete v.musicSourceId; });
  assert.equal(assertStandardPostVariantAxes(plan, outputs).ok, true, "explicit all-off musical axis leaves actual grade and cover gates enforced");
  assert.throws(() => assertStandardPostVariantAxes(plan, sameCover), /STANDARD_POST_VARIANTS_INVALID/);
});
const manifestMutations: Array<[string, (m: any) => void]> = [
  ["reorder", m => { m.originals.reverse(); }], ["drop", m => { m.originals.pop(); }], ["add", m => { m.originals.push(m.originals[0]); }],
  ["source bytes", m => { m.originals[0].bytes--; }], ["source hash", m => { m.originals[0].sha256 = "a".repeat(64); }],
  ["voiced selection", m => { m.originals[0].path = m.originals[0].path.replace(".mp4", ".voiced.mp4"); }],
  ["manifest segment", m => { m.segments = []; }], ["fake receipt", m => { m.originals[0].receiptSha256 = "a".repeat(64); }],
  ["changed submitted json", m => { m.submitted.json += " "; }], ["changed submitted bytes", m => { m.submitted.bytes++; }],
  ["wrong project", m => { m.projectId = "MOCK-OTHER"; }], ["media supplied by caller", m => { m.originals[0].media = { fps: 24 }; }],
];
test("canonical original manifest rejects edited count/order/fingerprints/receipts and supplied media facts", async () => using(async f => {
  const before = readFileSync(f.manifestFile), original = JSON.parse(before.toString());
  for (const [label, mutate] of manifestMutations) { const changed = structuredClone(original); mutate(changed); writeFileSync(f.manifestFile, JSON.stringify(changed));
    await assert.rejects(loadOriginalRenderManifest(f.manifestFile, options), (e: unknown) => e instanceof Error, label); }
  writeFileSync(f.manifestFile, before); await loadOriginalRenderManifest(f.manifestFile, options);
}));
test("copying or symlinking an issued manifest cannot create another standard authority", async () => using(async f => {
  const copied = join(f.root, "copy.json"), linked = join(f.root, "link.json"); copyFileSync(f.manifestFile, copied); symlinkSync(f.manifestFile, linked);
  await assert.rejects(loadOriginalRenderManifest(copied, options), /canonical/); await assert.rejects(loadOriginalRenderManifest(linked, options), /symlink/);
}));
test("mutated real original and symlinked canonical clip cannot be washed by retained receipt labels", async () => using(async f => {
  const file = join(f.clips, "S1.mp4"), before = readFileSync(file); writeFileSync(file, Buffer.concat([before, Buffer.from("mock-drift")]));
  await assert.rejects(loadOriginalRenderManifest(f.manifestFile, options), /changed/); writeFileSync(file, before);
  const copy = join(f.root, "alias.mp4"); copyFileSync(file, copy); rmSync(file); symlinkSync(copy, file); await assert.rejects(loadOriginalRenderManifest(f.manifestFile, options), /symlink/);
}));
test("frozen submission is idempotent but refuses changed project or mutable resubmission", async () => using(async f => {
  await freezeOriginalSubmission({ productionRoot: f.root, projectId: f.projectId, bytes: f.bytes });
  await assert.rejects(freezeOriginalSubmission({ productionRoot: f.root, projectId: f.projectId, bytes: Buffer.concat([f.bytes, Buffer.from(" ")]) }), /frozen source differs/);
  await assert.rejects(freezeOriginalSubmission({ productionRoot: f.root, projectId: "OTHER", bytes: f.bytes }), /project/);
}));
test("missing actual accepted input proof refuses original issuance", async () => using(async f => {
  await assert.rejects(issueOriginalRenderReceipt({ productionRoot: f.root, projectId: f.projectId, shotId: "S1", submittedSha256: f.submitted.sha256,
    artifactPath: join(f.clips, "S1.mp4"), taskId: "mock-S1-accepted", requestInputVerified: false }), /accepted original generation proof/);
}));
test("legacy adoption requires explicit exact original set and real matching accepted-task/history bytes", async () => using(async f => {
  // Rebuild fixture history as clearly synthetic diagnostic evidence; never a provider or identity approval.
  rmSync(join(f.root, "logs", f.projectId, "original-issued"), { recursive: true }); rmSync(f.manifestFile);
  const submittedFile = join(f.root, "human-submitted.json"); writeFileSync(submittedFile, f.bytes);
  const logs = join(f.root, "logs", f.projectId), accepted = join(logs, "accepted-tasks"); mkdirSync(accepted, { recursive: true });
  const hashes: Record<string, string> = {}, lines = [];
  for (const sid of ["S1", "S2"]) { const file = join(f.clips, `${sid}.mp4`), sha256 = await standardPostFileHash(file), taskId = `mock-${sid}-accepted`; hashes[sid] = sha256;
    writeFileSync(join(accepted, `${sid}.json`), JSON.stringify({ schemaVersion: "workloom.render-task/v1", state: "accepted", taskId }));
    lines.push(JSON.stringify({ shotId: sid, stage: "shot", ok: true, degraded: false, evidence: { taskId }, lineage: { projectId: f.projectId, status: "passed",
      outputs: [{ path: file, sha256, bytes: statSync(file).size }] } })); }
  writeFileSync(join(logs, "stages.jsonl"), lines.join("\n") + "\n");
  const authorization = { submittedSha256: f.submitted.sha256, originalSha256ByShot: hashes, reason: "mock explicit owner adoption for diagnostic fixture" };
  await assert.rejects(adoptLegacyOriginalRenders({ productionRoot: f.root, submittedFile, authorization: { ...authorization, originalSha256ByShot: { S1: hashes.S1! } } }), /exact shot set/);
  const manifest = await adoptLegacyOriginalRenders({ productionRoot: f.root, submittedFile, authorization });
  const loaded = await loadOriginalRenderManifest(manifest, options); assert.equal(loaded.originals[0]!.authority.kind, "legacy-user-adopted");
  const journal = join(accepted, "S1.json"); writeFileSync(journal, JSON.stringify({ schemaVersion: "workloom.render-task/v1", state: "accepted", taskId: "mock-other-task" }));
  await assert.rejects(loadOriginalRenderManifest(manifest, options), /legacy accepted output/);
}));
for (const args of [["--existing-render-edit", "arbitrary.json"], ["--existing-render-edit", "arbitrary.json", "--worker"]]) {
  test(`removed free-edit CLI rejects ${args.join(" ")} before shots/keys/runtime`, () => { const result = call(args); assert.notEqual(result.status, 0);
    assert.match(result.stderr, /FREE_EDIT_REMOVED/); assert.doesNotMatch(result.stderr, /需要 --shots|FILM_JOB_CONTEXT|ARK_API_KEY/); });
}
for (const args of [["--standard-post", "file.json"], ["--standard-post", "a", "--post-settings", "b", "--out", "c", "--shots", "d"],
  ["--standard-post", "a", "--post-settings", "b", "--out", "c", "--worker"]]) {
  test(`standard CLI rejects incompatible arguments ${args.join(" ")}`, () => { const result = call(args); assert.notEqual(result.status, 0); assert.match(result.stderr, /STANDARD_POST_(ARGUMENTS_INVALID|WORKER_FORBIDDEN)/); });
}
test("media executable resolver permits only current local executables", async () => {
  assert.equal(await resolveStandardPostBinary(process.execPath), realpathSync(process.execPath));
  for (const value of ["https://example.invalid/ffmpeg", "./ffmpeg", "ffmpeg\ninvalid", "workloom-no-such-media-command-10060002"])
    await assert.rejects(resolveStandardPostBinary(value), /STANDARD_POST_BINARY_INVALID/);
});
test("formal post adapter cannot invoke provider generation, local TTS, ASR or model adapters", () => {
  const source = readFileSync(join(repo, "scripts/tools/film-standard-post.mts"), "utf8");
  assert.doesNotMatch(source, /\bfetch\s*\(|(?:from|import\s*\()[^\n]*(?:producer-gate|voice-bridge|speech-bridge|llm-adapter|film-worker-runtime)/);
  assert.equal(existsSync(join(repo, "scripts/tools/film-standard-post.mts")), true);
});
