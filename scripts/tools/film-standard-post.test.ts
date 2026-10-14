import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { test } from "vitest";
import { inspectGenerationManifest } from "./generation-quality.mjs";
import { adoptCompletedOriginalRenders, runStandardPost, adoptLegacyOriginalRenders, assertStandardPostAudioClock, assertStandardPostExportClock, assertStandardPostVariantAxes, captureOriginalRenderManifest, freezeOriginalSubmission, issueOriginalRenderReceipt,
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
    writeFileSync(join(accepted, `${shotId}.json`), JSON.stringify({ schemaVersion: "workloom.render-task/v1", state: "accepted", taskId: `mock-${shotId}-accepted`, requestHash: hash(`mock-request-${shotId}`),
      submissionSource: "local-submit", updatedAt: "2026-10-07T01:00:00.000Z" }));
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
 }), 60_000);
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
test("final clock readback uses ordinary ffprobe metadata without PCM quality inspection", async () => using(async f => {
  const file = join(f.clips, "S1.mp4"), before = hash(readFileSync(file));
  const result = await assertStandardPostExportClock(file, 1, { ffmpeg: "must-not-be-invoked", ffprobe, timeoutMs: 60_000 });
  assert.equal(result.actualDurationSec, 1); assert.equal(result.requestedDurationSec, 1);
  assert.match(result.basis, /metadata only.*No complete PCM decode/);
  assert.equal(hash(readFileSync(file)), before);
}));
test("final clock readback rejects a requested export duration mismatch and preserves bytes", async () => using(async f => {
  const file = join(f.clips, "S1.mp4"), before = hash(readFileSync(file));
  await assert.rejects(assertStandardPostExportClock(file, 2, { ffmpeg: "must-not-be-invoked", ffprobe, timeoutMs: 60_000 }), /STANDARD_POST_EXPORT_CLOCK_INVALID/);
  assert.equal(hash(readFileSync(file)), before);
}));
test("final clock readback rejects even one lost frame and an unexpected fps without the former fifty-millisecond slack", async () => using(async f => {
  const file = join(f.clips, "S1.mp4"), before = hash(readFileSync(file));
  await assert.rejects(assertStandardPostExportClock(file, 25 / 24, { ffprobe, expectedVideoFrames: 25, expectedFps: 24 }), /STANDARD_POST_EXPORT_CLOCK_INVALID/);
  await assert.rejects(assertStandardPostExportClock(file, 1, { ffprobe, expectedVideoFrames: 24, expectedFps: 30 }), /STANDARD_POST_EXPORT_CLOCK_INVALID/);
  const actual = await assertStandardPostExportClock(file, 1, { ffprobe, expectedVideoFrames: 24, expectedFps: 24 });
  assert.equal(actual.videoFrames, 24); assert.equal(actual.requestedFrames, 24); assert.equal(hash(readFileSync(file)), before);
}));
test("explicit audio diagnostic still decodes the whole clock and rejects short coverage at its original threshold", async () => using(async f => {
  const file = join(f.clips, "S1.mp4"), before = hash(readFileSync(file));
  const result = await assertStandardPostAudioClock(file, 1, { ffmpeg, timeoutMs: 60_000 });
  assert.ok(result.samplesPerChannel >= result.requiredSamples); assert.match(result.basis, /Actual decoded samples/);
  await assert.rejects(assertStandardPostAudioClock(file, 2, { ffmpeg, timeoutMs: 60_000 }), /STANDARD_POST_NATIVE_CLOCK_INCOMPLETE/);
  assert.equal(hash(readFileSync(file)), before);
}), 60_000);
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
for (const legacy of [false, true]) test(`${legacy ? "legacy v1" : "current"} GET timestamp change reuses the exact first original receipt and seal without rewriting evidence`, async () => using(async f => {
  const journal = join(f.root, "logs", f.projectId, "accepted-tasks", "S1.json"), current = JSON.parse(readFileSync(journal, "utf8"));
  const sealFile = f.receipt.replace(/\.json$/, ".seal.json");
  if (legacy) {
    // Reproduce a pre-fix issuance in an explicitly synthetic fixture only.
    const old = JSON.parse(readFileSync(f.receipt, "utf8")); delete old.evidence.acceptedFactsSha256;
    writeFileSync(f.receipt, JSON.stringify(old, null, 2) + "\n");
    const witness = JSON.parse(readFileSync(sealFile, "utf8")); witness.receiptSha256 = hash(readFileSync(f.receipt));
    writeFileSync(sealFile, JSON.stringify(witness, null, 2) + "\n");
    const list = JSON.parse(readFileSync(f.manifestFile, "utf8")); list.originals[0].receiptSha256 = witness.receiptSha256;
    writeFileSync(f.manifestFile, JSON.stringify(list, null, 2) + "\n");
  }
  const receipt = readFileSync(f.receipt), seal = readFileSync(sealFile), manifest = readFileSync(f.manifestFile);
  writeFileSync(journal, JSON.stringify({ ...current, updatedAt: "2026-10-07T04:00:00.000Z" }));
  const resumed = await issueOriginalRenderReceipt({ productionRoot: f.root, projectId: f.projectId, shotId: "S1", submittedSha256: f.submitted.sha256,
    artifactPath: join(f.clips, "S1.mp4"), taskId: "mock-S1-accepted", requestInputVerified: true });
  assert.deepEqual(resumed, JSON.parse(receipt.toString()));
  assert.deepEqual(readFileSync(f.receipt), receipt); assert.deepEqual(readFileSync(sealFile), seal);
  const loaded = await loadOriginalRenderManifest(f.manifestFile, options);
  assert.equal(loaded.totalFrames, 48); assert.deepEqual(readFileSync(f.manifestFile), manifest);
}));
test("a changed accepted task, request, state, source or extra fact cannot reuse a first issuance", async () => using(async f => {
  const journal = join(f.root, "logs", f.projectId, "accepted-tasks", "S1.json"), original = JSON.parse(readFileSync(journal, "utf8"));
  const receipt = readFileSync(f.receipt);
  for (const changed of [{ taskId: "mock-other" }, { requestHash: hash("other-request") }, { state: "submission-unknown" },
    { submissionSource: "provider-recovery" }, { unexpectedAuthority: true }, { updatedAt: "not-a-timestamp" }]) {
    writeFileSync(journal, JSON.stringify({ ...original, updatedAt: "2026-10-07T04:00:00.000Z", ...changed }));
    await assert.rejects(issueOriginalRenderReceipt({ productionRoot: f.root, projectId: f.projectId, shotId: "S1", submittedSha256: f.submitted.sha256,
      artifactPath: join(f.clips, "S1.mp4"), taskId: "mock-S1-accepted", requestInputVerified: true }), /STANDARD_POST_INVALID/);
    await assert.rejects(loadOriginalRenderManifest(f.manifestFile, options), /STANDARD_POST_INVALID/);
    assert.deepEqual(readFileSync(f.receipt), receipt);
  }
  writeFileSync(journal, JSON.stringify(original)); await loadOriginalRenderManifest(f.manifestFile, options);
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

async function failedQualityHistory(f: Awaited<ReturnType<typeof fixture>>) {
  rmSync(join(f.root, "logs", f.projectId, "original-issued"), { recursive: true });
  rmSync(join(f.root, "logs", f.projectId, "original-seals"), { recursive: true, force: true });
  rmSync(f.manifestFile, { force: true });
  const rows = ["S1", "S2"].map(shotId => {
    const path = join(f.clips, `${shotId}.mp4`), bytes = readFileSync(path), sha256 = hash(bytes);
    return { stage: "shot", shotId, artifact: path, ok: false, degraded: false, verdict: { approved: false, score: 30, reason: "historical wardrobe quality rejection" },
      evidence: { taskId: `mock-${shotId}-accepted`, requestInputVerified: true, rawSha256: sha256 },
      lineage: { schemaVersion: "workloom.production-lineage/v1", projectId: f.projectId, sourceHash: hash(`shot-source-${shotId}`),
        stage: "shot", shotId, runId: "historical-local-fixture", recipeHash: hash("old-component"), status: "failed",
        inputs: [{ path: join(f.root, "logs", f.projectId, "submitted-original.json"), sha256: f.submitted.sha256, bytes: f.bytes.length }],
        outputs: [{ path, sha256, bytes: bytes.length }], errors: [] as string[] } };
  });
  const file = join(f.root, "logs", f.projectId, "stages.jsonl"), bytes = Buffer.from(rows.map(row => JSON.stringify(row)).join("\n") + "\n");
  writeFileSync(file, bytes);
  return { file, bytes, rows };
}
test("provider-success adoption accepts historical quality failures after recipe changes without changing old rows", async () => using(async f => {
  const old = await failedQualityHistory(f);
  const adopted = await adoptCompletedOriginalRenders({ productionRoot: f.root, projectId: f.projectId, submittedSha256: f.submitted.sha256 });
  assert.equal(adopted.length, 2); assert.equal(adopted[0]!.disposition, "provider-success-adopted");
  assert.deepEqual(readFileSync(old.file), old.bytes);
  const manifest = await captureOriginalRenderManifest({ productionRoot: f.root, projectId: f.projectId });
  const loaded = await loadOriginalRenderManifest(manifest, options);
  assert.equal(loaded.originals[0]!.authority.kind, "provider-success-adopted");
  assert.equal(JSON.parse(readFileSync(f.receipt, "utf8")).kind, "provider-success-adopted");
}));
for (const defect of ["missing", "tampered", "provider-failed", "unknown-input", "wrong-task", "wrong-project", "wrong-schema", "wrong-stage", "wrong-shot", "empty-inputs", "wrong-source-input", "changed-input", "lineage-error"] as const) {
  test(`completed adoption rejects ${defect} and leaves original history untouched without issuing a replacement`, async () => using(async f => {
    const old = await failedQualityHistory(f), raw = join(f.clips, "S1.mp4");
    if (defect === "missing") rmSync(raw);
    if (defect === "tampered") writeFileSync(raw, Buffer.concat([readFileSync(raw), Buffer.from("tamper")]));
    if (defect === "provider-failed") Object.assign(old.rows[0]!.evidence, { providerSuccess: false });
    if (defect === "unknown-input") old.rows[0]!.evidence.requestInputVerified = false;
    if (defect === "wrong-task") old.rows[0]!.evidence.taskId = "different-task";
    if (defect === "wrong-project") old.rows[0]!.lineage.projectId = "OTHER";
    if (defect === "wrong-schema") old.rows[0]!.lineage.schemaVersion = "untrusted-schema";
    if (defect === "wrong-stage") old.rows[0]!.lineage.stage = "compose";
    if (defect === "wrong-shot") old.rows[0]!.lineage.shotId = "OTHER";
    if (defect === "empty-inputs") old.rows[0]!.lineage.inputs = [];
    if (defect === "wrong-source-input") old.rows[0]!.lineage.inputs[0]!.sha256 = hash("other submission");
    if (defect === "changed-input") old.rows[0]!.lineage.inputs.push({ path: join(f.root, "missing-input.json"), sha256: hash("missing"), bytes: 7 });
    if (defect === "lineage-error") old.rows[0]!.lineage.errors = ["source changed during production"];
    const before = Buffer.from(old.rows.map(row => JSON.stringify(row)).join("\n") + "\n"); writeFileSync(old.file, before);
    await assert.rejects(adoptCompletedOriginalRenders({ productionRoot: f.root, projectId: f.projectId, submittedSha256: f.submitted.sha256 }), /STANDARD_POST_INVALID/);
    assert.deepEqual(readFileSync(old.file), before); assert.equal(existsSync(f.receipt), false);
  }));
}
test("a missing previously issued original fails instead of silently entering a new submit path", async () => using(async f => {
  rmSync(join(f.clips, "S1.mp4"));
  await assert.rejects(adoptCompletedOriginalRenders({ productionRoot: f.root, projectId: f.projectId, submittedSha256: f.submitted.sha256 }), /ENOENT/);
  assert.equal(existsSync(f.receipt), true);
}));

async function unusualCompletedFixture(options: { audio?: boolean; nominalSeconds?: number; videoFrames?: number; tailMarker?: boolean; providerCanvas?: boolean } = {}) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "standard-raw-completed-"))), projectId = "MOCK-RAW-COMPLETED";
  const nominalSeconds = options.nominalSeconds ?? 10, videoFrames = options.videoFrames ?? 241, actualSeconds = videoFrames / 24;
  const bytes = Buffer.from(JSON.stringify({ projectId, title: "原片后期", durationSeconds: nominalSeconds, aspect: "9:16", resolution: options.providerCanvas ? "provider-original" : "720p", fps: 24,
    shots: [{ shotId: "S1", duration: nominalSeconds, scene: "已生成的原镜头", action: "保留原镜头", dialogue: [{ speaker: "原片", text: options.audio ? "原片原声" : "原片无声" }] }] }));
  const submitted = await freezeOriginalSubmission({ productionRoot: root, projectId, bytes });
  const clips = join(root, "clips", projectId); mkdirSync(clips, { recursive: true });
  const sourceFilter = options.providerCanvas ? "color=c=blue:s=144x256:r=24" : "color=c=black:s=162x122:r=24";
  const videoFilter = [options.providerCanvas ? "null" : "crop=161:121:exact=1", ...(options.tailMarker ? [`drawbox=color=red:t=fill:enable='gte(t,${actualSeconds - 0.25})'`] : [])].join(",");
  const raw = join(clips, "S1.mp4"), result = spawnSync(ffmpeg, ["-v", "error", "-nostdin", "-n", "-f", "lavfi", "-i", sourceFilter,
    ...(options.audio ? ["-f", "lavfi", "-i", `sine=frequency=733:sample_rate=48000:duration=${actualSeconds}`] : []),
    "-map", "0:v:0", ...(options.audio ? ["-map", "1:a:0", "-c:a", "aac", "-ar", "48000", "-ac", "2"] : ["-an"]),
    "-vf", videoFilter, "-frames:v", String(videoFrames), "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", options.providerCanvas ? "yuv420p" : "yuv444p", raw],
  { encoding: "utf8", timeout: 60_000 });
  assert.equal(result.status, 0, result.stderr);
  const accepted = join(root, "logs", projectId, "accepted-tasks"); mkdirSync(accepted, { recursive: true });
  writeFileSync(join(accepted, "S1.json"), JSON.stringify({ schemaVersion: "workloom.render-task/v1", state: "accepted",
    taskId: "mock-S1-completed", requestHash: hash("original paid request fixture") }));
  const rawSha256 = hash(readFileSync(raw)), historyFile = join(root, "logs", projectId, "stages.jsonl");
  const history = Buffer.from(JSON.stringify({ stage: "shot", shotId: "S1", artifact: raw, ok: false, degraded: false,
    verdict: { approved: false, score: 0, reason: "historical black frame, wardrobe, dialogue and motion quality rejection" },
    evidence: { taskId: "mock-S1-completed", requestInputVerified: true, providerSuccess: true, rawSha256 },
    lineage: { schemaVersion: "workloom.production-lineage/v1", projectId, runId: "historical-fixture", stage: "shot", shotId: "S1",
      sourceHash: hash("historical semantic source"), recipeHash: hash("historical component"), status: "failed",
      inputs: [{ path: join(root, "logs", projectId, "submitted-original.json"), sha256: submitted.sha256, bytes: bytes.length }],
      outputs: [{ path: raw, sha256: rawSha256, bytes: statSync(raw).size }], errors: [] } }) + "\n");
  writeFileSync(historyFile, history);
  return { root, projectId, bytes, submitted, raw, rawSha256, historyFile, history };
}
test("full normal CLI accepts historical rejected black odd-sized 10.04s silent media and composes without keys or any network call", async () => {
  const f = await unusualCompletedFixture();
  try {
    const shots = join(f.root, "source.json"), denyNetwork = join(f.root, "deny-network.mjs"); writeFileSync(shots, f.bytes);
    writeFileSync(denyNetwork, 'globalThis.fetch = async () => { throw new Error("FORBIDDEN_NETWORK_OR_PAID_CALL"); };\n');
    const result = spawnSync(process.execPath, ["--import", "tsx", "--import", denyNetwork, cli, "--shots", shots,
      "--work-dir", f.root, "--out", join(f.root, "out"), "--keys-file", join(f.root, "nonexistent.env"), "--stages", "voice,compose"],
    { cwd: repo, encoding: "utf8", timeout: 180_000, env: { ...process.env, FILM_WORKER_MODE: "", WL_FFMPEG: ffmpeg, WL_FFPROBE: ffprobe } });
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    assert.match(result.stdout, /直接正式后期/); assert.doesNotMatch(result.stdout + result.stderr, /FORBIDDEN_NETWORK_OR_PAID_CALL|平台已受理|品质.*重试/);
    const composed = join(f.root, "post", f.projectId, "master-raw.mp4"); assert.equal(existsSync(composed), true);
    const manifest = await loadOriginalRenderManifest(join(f.root, "logs", f.projectId, "original-render-manifest.json"), options);
    assert.equal(manifest.originals[0]!.media.width, 161); assert.equal(manifest.originals[0]!.media.audioChannels, 0);
    assert.ok(Math.abs(manifest.originals[0]!.media.videoDurationSec - 241 / 24) < 0.001);
    assert.equal(hash(readFileSync(f.raw)), f.rawSha256);
    assert.equal(readFileSync(f.historyFile).subarray(0, f.history.length).equals(f.history), true);
    const newRows = readFileSync(f.historyFile, "utf8").slice(f.history.length).trim().split("\n").map(line => JSON.parse(line));
    assert.equal(newRows.filter(row => row.stage === "render-adopted").length, 1);
    assert.equal(newRows.filter(row => row.stage === "voice").every(row => row.evidence.spokenTextVerified === false && row.evidence.lipSyncVerified === false), true);
    assert.equal(newRows.filter(row => row.stage === "compose").every(row => row.ok && row.verdict?.score === null), true);
  } finally { rmSync(f.root, { recursive: true, force: true }); }
}, 240_000);
test.each([false, true])("actual standard post creates all presentations with current technical QA and no model review (music=%s)", async withMusic => {
  const f = await unusualCompletedFixture();
  try {
    await adoptCompletedOriginalRenders({ productionRoot: f.root, projectId: f.projectId, submittedSha256: f.submitted.sha256 });
    const manifestFile = await captureOriginalRenderManifest({ productionRoot: f.root, projectId: f.projectId });
    const postSettings = settings(f.root), fonts = join(repo, "bundles/ai-video/library/fonts"), font = join(fonts, "cn/SourceHanSansCN-Heavy.otf");
    postSettings.subtitleFontsRoot = fonts; Object.assign(postSettings.cover, { fontFile: font, fontSha256: hash(readFileSync(font)), fontId: "source-han-heavy" });
    if (withMusic) {
      postSettings.music = postSettings.versions.slice(1).map((version, index) => {
        const path = join(f.root, `${version.id}.wav`), encoded = spawnSync(ffmpeg, ["-v", "error", "-nostdin", "-n", "-f", "lavfi", "-i",
          `sine=frequency=${600 + index * 377}:sample_rate=48000:duration=2`, "-c:a", "pcm_s16le", path], { encoding: "utf8", timeout: 60_000 });
        assert.equal(encoded.status, 0, encoded.stderr);
        Object.assign(version, { musicSourceId: version.id, musicLevelDb: -24, duckingDb: 12, musicBpm: 120 });
        return { id: version.id, path, sha256: hash(readFileSync(path)), bytes: statSync(path).size };
      });
    }
    const settingsFile = join(f.root, "settings.json"), outputDir = join(f.root, "delivery"); writeFileSync(settingsFile, JSON.stringify(postSettings));
    const delivered = await runStandardPost(manifestFile, settingsFile, outputDir, { repoRoot: repo, ffmpeg, ffprobe, timeoutMs: 180_000 });
    assert.ok(delivered && typeof delivered === "object"); assert.equal(Reflect.get(delivered, "projectId"), f.projectId);
    const manifest = JSON.parse(readFileSync(join(outputDir, `${f.projectId}-delivery-manifest.json`), "utf8"));
    assert.equal(manifest.outputs.length, 5); assert.equal(manifest.modelCalls, 0); assert.equal(manifest.supplierGenerationCalls, 0);
    assert.equal(manifest.ttsCalls, 0); assert.equal(manifest.asrCalls, 0); assert.equal(manifest.sourceFilesUnchanged, true);
    assert.equal(manifest.distinctness.qualityReviewPerformed, false);
    assert.equal(manifest.generationQuality.schemaVersion, "workloom.generation-quality/v1");
    const currentQuality = await inspectGenerationManifest({ root: outputDir, manifest, bins: { ffmpeg, ffprobe } });
    assert.equal(currentQuality.passed, true, JSON.stringify(currentQuality.checks.filter((row: { hard: boolean; ok: boolean }) => row.hard && !row.ok)));
    assert.equal(currentQuality.artisticQualityReviewed, false); assert.equal(currentQuality.paidCalls, 0);
    assert.equal(currentQuality.generationQuality.sourceCount, 1);
    for (const output of manifest.outputs) { assert.equal(existsSync(output.path), true); assert.equal(hash(readFileSync(output.path)), output.sha256); }
    if (withMusic) for (const output of manifest.outputs.filter((row: { id: string }) => ["warm-film", "cool-tech", "punchy-social"].includes(row.id))) {
      assert.equal(output.bgm.independentAudio.sourceAuthority, "native-source"); assert.equal(output.bgm.independentAudio.stemsVerified, false);
      assert.equal(output.bgm.metrics, null); assert.equal(output.bgm.qualityReviewPerformed, false);
      assert.equal(output.bgm.bgm.playedSha256, postSettings.music.find(row => row.id === output.id)!.sha256);
    }
    assert.equal(hash(readFileSync(f.raw)), f.rawSha256); assert.deepEqual(readFileSync(f.historyFile), f.history);
  } finally { rmSync(f.root, { recursive: true, force: true }); }
}, 300_000);

function decodedVideoHashes(file: string): string[] {
  const result = spawnSync(ffmpeg, ["-v", "error", "-xerror", "-nostdin", "-i", file, "-map", "0:v:0", "-pix_fmt", "yuv420p", "-f", "framehash", "-hash", "sha256", "-"],
    { encoding: "utf8", timeout: 60_000, maxBuffer: 8 * 1024 * 1024 });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.split("\n").filter(line => line && !line.startsWith("#")).map(line => line.split(",").at(-1)!.trim());
}
function audioPacketFacts(file: string) {
  const result = spawnSync(ffprobe, ["-v", "error", "-select_streams", "a:0", "-show_packets", "-show_data_hash", "sha256", "-of", "json", file],
    { encoding: "utf8", timeout: 60_000, maxBuffer: 8 * 1024 * 1024 });
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout).packets.map((packet: Record<string, unknown>) => ({ pts: packet.pts, dts: packet.dts, duration: packet.duration,
    size: packet.size, data_hash: packet.data_hash, side_data_list: packet.side_data_list }));
}
async function completeTailPostFixture() {
  const f = await unusualCompletedFixture({ audio: true, nominalSeconds: 2, videoFrames: 102, tailMarker: true, providerCanvas: true });
  await adoptCompletedOriginalRenders({ productionRoot: f.root, projectId: f.projectId, submittedSha256: f.submitted.sha256 });
  const manifestFile = await captureOriginalRenderManifest({ productionRoot: f.root, projectId: f.projectId }), postSettings = settings(f.root);
  const fonts = join(repo, "bundles/ai-video/library/fonts"), font = join(fonts, "cn/SourceHanSansCN-Heavy.otf");
  postSettings.subtitleFontsRoot = fonts; Object.assign(postSettings.cover, { fontFile: font, fontSha256: hash(readFileSync(font)), fontId: "source-han-heavy" });
  const settingsFile = join(f.root, "settings.json"); writeFileSync(settingsFile, JSON.stringify(postSettings));
  return { ...f, manifestFile, settingsFile };
}
test("formal post uses measured fractional-cadence composition boundaries for every requested music cut", async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "standard-fractional-cadence-"))), projectId = "MOCK-FRACTIONAL-CADENCE";
  try {
    const specifications = [{ shotId: "S1", fps: 17, frames: 69 }, { shotId: "S2", fps: 24, frames: 25 }];
    const bytes = Buffer.from(JSON.stringify({ projectId, durationSeconds: 30, aspect: "9:16", resolution: "provider-original", fps: 24,
      shots: specifications.map(source => ({ shotId: source.shotId, duration: 2 })) }));
    const submitted = await freezeOriginalSubmission({ productionRoot: root, projectId, bytes });
    const clips = join(root, "clips", projectId), accepted = join(root, "logs", projectId, "accepted-tasks");
    mkdirSync(clips, { recursive: true }); mkdirSync(accepted, { recursive: true });
    const originalHashes: string[] = [];
    for (const source of specifications) {
      const path = join(clips, `${source.shotId}.mp4`), duration = source.frames / source.fps;
      const made = spawnSync(ffmpeg, ["-v", "error", "-nostdin", "-n", "-f", "lavfi", "-i", `color=c=blue:s=144x256:r=${source.fps}:d=${duration}`,
        "-f", "lavfi", "-i", `sine=frequency=${source.fps === 17 ? 733 : 866}:sample_rate=48000:duration=${duration}`,
        "-map", "0:v:0", "-map", "1:a:0", "-frames:v", String(source.frames), "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p",
        "-c:a", "aac", "-ar", "48000", "-ac", "2", path], { encoding: "utf8", timeout: 60_000 });
      assert.equal(made.status, 0, made.stderr); originalHashes.push(hash(readFileSync(path)));
      const taskId = `offline-${source.shotId}`;
      writeFileSync(join(accepted, `${source.shotId}.json`), JSON.stringify({ schemaVersion: "workloom.render-task/v1", state: "accepted", taskId,
        requestHash: hash(`offline-fractional-${source.shotId}`) }));
      await issueOriginalRenderReceipt({ productionRoot: root, projectId, shotId: source.shotId, submittedSha256: submitted.sha256,
        artifactPath: path, taskId, requestInputVerified: true });
    }
    const manifestFile = await captureOriginalRenderManifest({ productionRoot: root, projectId }), postSettings = settings(root);
    const fonts = join(repo, "bundles/ai-video/library/fonts"), font = join(fonts, "cn/SourceHanSansCN-Heavy.otf");
    postSettings.subtitleFontsRoot = fonts; Object.assign(postSettings.cover, { fontFile: font, fontSha256: hash(readFileSync(font)), fontId: "source-han-heavy" });
    postSettings.music = postSettings.versions.slice(1).map((version, index) => {
      const path = join(root, `${version.id}.wav`), made = spawnSync(ffmpeg, ["-v", "error", "-nostdin", "-n", "-f", "lavfi", "-i",
        `sine=frequency=${600 + index * 377}:sample_rate=48000:duration=2`, "-c:a", "pcm_s16le", path], { encoding: "utf8", timeout: 60_000 });
      assert.equal(made.status, 0, made.stderr); Object.assign(version, { musicSourceId: version.id, musicLevelDb: -24, duckingDb: 12, musicBpm: 120 });
      return { id: version.id, path, sha256: hash(readFileSync(path)), bytes: statSync(path).size };
    });
    const settingsFile = join(root, "settings.json"), output = join(root, "delivery"); writeFileSync(settingsFile, JSON.stringify(postSettings));
    await runStandardPost(manifestFile, settingsFile, output, { repoRoot: repo, ffmpeg, ffprobe, timeoutMs: 180_000 });
    const delivered = JSON.parse(readFileSync(join(output, `${projectId}-delivery-manifest.json`), "utf8"));
    assert.equal(delivered.bodyFrames, 123); assert.equal(delivered.totalFrames, 124);
    assert.deepEqual(delivered.compositionTimeline, [
      { shotId: "S1", startFrame: 0, frameCount: 98, fps: 24, startSec: 0, durationSec: 98 / 24, endSec: 98 / 24 },
      { shotId: "S2", startFrame: 98, frameCount: 25, fps: 24, startSec: 98 / 24, durationSec: 25 / 24, endSec: 123 / 24 },
    ]);
    assert.notEqual(delivered.compositionTimeline[1].startSec, 69 / 17);
    for (const version of delivered.outputs.filter((version: { id: string }) => ["warm-film", "cool-tech", "punchy-social"].includes(version.id))) {
      assert.deepEqual(version.bgm.compositionCuts, { requestedSeconds: [98 / 24], basis: "measured-composition-frame-clock", reviewed: false });
      assert.equal(version.bgm.qualityReviewPerformed, false); assert.equal(version.exportClock.videoFrames, 124);
    }
    assert.deepEqual(specifications.map(source => hash(readFileSync(join(clips, `${source.shotId}.mp4`)))), originalHashes);
    assert.equal(delivered.modelCalls, 0); assert.equal(delivered.supplierGenerationCalls, 0);
  } finally { rmSync(root, { recursive: true, force: true }); }
}, 240_000);
test("formal standard post preserves every nominal-two actual-4.25-second frame and native AAC packet through the soft-subtitle delivery, with one concurrent publisher", async () => {
  const f = await completeTailPostFixture();
  try {
    const output = join(f.root, "delivery"), originalFrames = decodedVideoHashes(f.raw), originalPackets = audioPacketFacts(f.raw);
    const calls = await Promise.allSettled([runStandardPost(f.manifestFile, f.settingsFile, output, { repoRoot: repo, ffmpeg, ffprobe, timeoutMs: 180_000 }),
      runStandardPost(f.manifestFile, f.settingsFile, output, { repoRoot: repo, ffmpeg, ffprobe, timeoutMs: 180_000 })]);
    assert.equal(calls.filter(call => call.status === "fulfilled").length, 1, calls.map(call => call.status === "rejected" ? String(call.reason) : "fulfilled").join("\n"));
    const rejected = calls.find(call => call.status === "rejected") as PromiseRejectedResult;
    assert.match(String(rejected.reason), /STANDARD_POST_(BUSY|OUTPUT_EXISTS)/);
    const manifest = JSON.parse(readFileSync(join(output, `${f.projectId}-delivery-manifest.json`), "utf8"));
    assert.equal(manifest.bodyDurationSec, 4.25); assert.equal(manifest.bodyFrames, 102); assert.equal(manifest.totalFrames, 103);
    assert.equal(manifest.durationSec, 103 / 24); assert.equal(manifest.compositionClock.sourceDurationSec, 4.25);
    assert.deepEqual(manifest.coverPrefix, { frames: 1, bodyVideoOffsetSeconds: 1 / 24, audioOffsetSeconds: 0, subtitleOffsetSeconds: 0,
      basis: "One cover video frame precedes every complete body frame; original audio packets and subtitle timestamps remain on their source clock. AV quality was not reviewed." });
    assert.equal(manifest.outputs.length, 5);
    for (const row of manifest.outputs) { assert.equal(row.exportClock.videoFrames, 103); assert.equal(row.exportClock.fps, 24); assert.equal(hash(readFileSync(row.path)), row.sha256); }
    const soft = manifest.outputs.find((row: { id: string }) => row.id === "softsub");
    assert.equal(soft.colorMode, "native-composed-program");
    const finalFrames = decodedVideoHashes(soft.path);
    assert.equal(originalFrames.length, 102); assert.equal(finalFrames.length, 103); assert.deepEqual(finalFrames.slice(1), originalFrames);
    assert.deepEqual(audioPacketFacts(soft.path), originalPackets);
    assert.deepEqual(readFileSync(f.historyFile), f.history); assert.equal(hash(readFileSync(f.raw)), f.rawSha256);
    assert.equal(existsSync(`${output}.standard-post.lock`), false);
    await assert.rejects(runStandardPost(f.manifestFile, f.settingsFile, output, { repoRoot: repo, ffmpeg, ffprobe }), /STANDARD_POST_OUTPUT_EXISTS/);
  } finally { rmSync(f.root, { recursive: true, force: true }); }
}, 240_000);
test("formal standard post keeps a real composition failure in staging and publishes no official directory or changed source", async () => {
  const f = await completeTailPostFixture();
  try {
    const output = join(f.root, "delivery"), binary = join(f.root, "actual-composition-failure.mjs"), actualFfmpeg = await resolveStandardPostBinary(ffmpeg);
    writeFileSync(binary, `#!${process.execPath}\nimport {spawnSync} from 'node:child_process';\nconst args=process.argv.slice(2);\nif(args.at(-1)?.endsWith('/composed.mp4')){process.stderr.write('requested composition fixture failure');process.exit(91);}\nconst result=spawnSync(${JSON.stringify(actualFfmpeg)},args,{stdio:'inherit'});\nif(result.error){process.stderr.write(result.error.message);process.exit(92);}\nprocess.exit(result.status??93);\n`); chmodSync(binary, 0o755);
    await assert.rejects(runStandardPost(f.manifestFile, f.settingsFile, output, { repoRoot: repo, ffmpeg: binary, ffprobe, timeoutMs: 60_000 }), /STANDARD_POST_PROCESS_FAILED/);
    assert.equal(existsSync(output), false); assert.equal(existsSync(`${output}.standard-post.lock`), false);
    const staging = readdirSync(f.root).filter(name => name.startsWith("delivery.staging-")); assert.equal(staging.length, 1);
    const failed = JSON.parse(readFileSync(join(f.root, staging[0]!, "failed.json"), "utf8"));
    assert.equal(failed.officialOutputPublished, false); assert.equal(failed.stages.some((row: { stage: string; ok: boolean }) => row.stage === "compose" && row.ok === false), true);
    assert.equal(hash(readFileSync(f.raw)), f.rawSha256); assert.deepEqual(readFileSync(f.historyFile), f.history);
  } finally { rmSync(f.root, { recursive: true, force: true }); }
}, 90_000);


test.each(["sidecar", "burn", "danmaku", "softmux"])("whole normal CLI stops after actual %s processing failure without publishing a later master", async kind => {
  const f = await unusualCompletedFixture();
  try {
    const shots = join(f.root, "source.json"), denyNetwork = join(f.root, "deny-network.mjs"), binary = join(f.root, "processing-failure-ffmpeg.mjs");
    writeFileSync(shots, f.bytes);
    writeFileSync(denyNetwork, 'globalThis.fetch = async () => { throw new Error("FORBIDDEN_NETWORK_OR_PAID_CALL"); };\n');
    writeFileSync(binary, `#!${process.execPath}\nimport {spawnSync} from 'node:child_process';\nconst args=process.argv.slice(2);\nconst kind=${JSON.stringify(kind)};\nconst output=args.at(-1)||'';\nif((kind==='burn'&&output.includes('master-subtitled'))||(kind==='danmaku'&&output.includes('master-danmaku'))||(kind==='softmux'&&output.includes('-softsub'))){process.stderr.write('fixture requested processing failed');process.exit(51); }\nconst result=spawnSync(${JSON.stringify(ffmpeg)},args,{stdio:'inherit'});\nif(result.error){process.stderr.write(result.error.message);process.exit(52); }\nprocess.exit(result.status??53);\n`); chmodSync(binary, 0o755);
    const stages = kind === "danmaku" ? "compose,danmaku,master" : kind === "softmux" ? "compose,subtitle,mux,master" : "compose,subtitle,master";
    const output = join(f.root, "delivery");
    const result = spawnSync(process.execPath, ["--import", "tsx", "--import", denyNetwork, cli, "--shots", shots,
      "--work-dir", f.root, "--out", output, "--keys-file", join(f.root, "nonexistent.env"), "--stages", stages,
      "--subtitle-mode", kind === "burn" ? "burn" : "sidecar", "--no-open-with-cover"],
    { cwd: repo, encoding: "utf8", timeout: 180_000, env: { ...process.env, FILM_WORKER_MODE: "", WL_FFMPEG: binary, WL_FFPROBE: ffprobe,
      WORKLOOM_SUBTITLE_FFMPEG_PATH: binary, WORKLOOM_SUBTITLE_FFPROBE_PATH: ffprobe,
      ...(kind === "sidecar" ? { WORKLOOM_SUBTITLE_FONTS_DIR: f.root } : {}) } });
    assert.notEqual(result.status, 0, `${result.stdout}\n${result.stderr}`);
    assert.match(result.stderr, /POST_PROCESSING_FAILED/);
    assert.doesNotMatch(result.stdout + result.stderr, /FORBIDDEN_NETWORK_OR_PAID_CALL|平台已受理/);
    const rows = readFileSync(f.historyFile, "utf8").slice(f.history.length).trim().split("\n").map(line => JSON.parse(line));
    const expectedStage = kind === "danmaku" ? "danmaku" : kind === "softmux" ? "mux" : "subtitle";
    assert.equal(rows.some(row => row.stage === expectedStage && row.ok === false), true);
    assert.equal(rows.some(row => row.stage === "master"), false);
    assert.equal(existsSync(join(output, `${f.projectId}-delivery-manifest.json`)), false);
    assert.equal(hash(readFileSync(f.raw)), f.rawSha256);
  } finally { rmSync(f.root, { recursive: true, force: true }); }
}, 240_000);

test("whole normal CLI completes all official post stages with current technical QA and no source artistic or model review", async () => {
  const f = await unusualCompletedFixture({ audio: true });
  try {
    const shots = join(f.root, "source.json"), denyNetwork = join(f.root, "deny-network.mjs"), binary = join(f.root, "no-quality-ffmpeg.mjs"), commands = join(f.root, "commands.jsonl");
    writeFileSync(shots, f.bytes);
    writeFileSync(denyNetwork, 'globalThis.fetch = async () => { throw new Error("FORBIDDEN_NETWORK_OR_PAID_CALL"); };\n');
    const actualFfmpeg = await resolveStandardPostBinary(ffmpeg);
    writeFileSync(binary, `#!${process.execPath}\nimport {spawnSync} from 'node:child_process';\nimport fs from 'node:fs';\nconst args=process.argv.slice(2);\nfs.appendFileSync(${JSON.stringify(commands)},JSON.stringify(args)+'\\n');\nif(args.some(arg=>/edgedetect|blurdetect|bbox=/.test(arg))){process.stderr.write('forbidden source artistic review');process.exit(87); }\nconst result=spawnSync(${JSON.stringify(actualFfmpeg)},args,{stdio:'inherit'});\nif(result.error){process.stderr.write(result.error.message);process.exit(52); }\nprocess.exit(result.status??53);\n`); chmodSync(binary, 0o755);
    const output = join(f.root, "delivery");
    const result = spawnSync(process.execPath, ["--import", "tsx", "--import", denyNetwork, cli, "--shots", shots,
      "--work-dir", f.root, "--out", output, "--keys-file", join(f.root, "nonexistent.env"), "--stages", "voice,compose,color,subtitle,danmaku,bgm,cover,mux,master,deliver"],
    { cwd: repo, encoding: "utf8", timeout: 240_000, env: { ...process.env, FILM_WORKER_MODE: "", WL_FFMPEG: binary, WL_FFPROBE: ffprobe,
      WORKLOOM_POST_FFMPEG_PATH: binary, WORKLOOM_POST_FFPROBE_PATH: ffprobe,
      WORKLOOM_COLOR_FFMPEG_PATH: binary, WORKLOOM_COLOR_FFPROBE_PATH: ffprobe,
      WORKLOOM_SUBTITLE_FFMPEG_PATH: binary, WORKLOOM_SUBTITLE_FFPROBE_PATH: ffprobe,
      WORKLOOM_BGM_FFMPEG_PATH: binary, WORKLOOM_BGM_FFPROBE_PATH: ffprobe,
      WORKLOOM_BGM_DISCOVER: "0", WORKLOOM_BGM_LIBRARY_DIR: join(f.root, "empty-custom-library"), WORKLOOM_BGM_HOME: join(f.root, "empty-bgm-home") } });
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    assert.equal(hash(readFileSync(f.raw)), f.rawSha256);
    assert.doesNotMatch(result.stdout + result.stderr, /FORBIDDEN_NETWORK_OR_PAID_CALL|forbidden source artistic review|平台已受理/);
    const records = readFileSync(f.historyFile, "utf8").slice(f.history.length).trim().split("\n").map(line => JSON.parse(line));
    for (const stage of ["compose", "color", "subtitle", "danmaku", "bgm", "cover", "mux", "master", "deliver"]) {
      assert.equal(records.some(row => row.stage === stage && row.ok === true), true, stage);
    }
    const pointer = JSON.parse(readFileSync(join(output, "current.json"), "utf8"));
    const manifest = JSON.parse(readFileSync(join(pointer.releaseDir, `${f.projectId}-delivery-manifest.json`), "utf8"));
    assert.equal(manifest.variants.length, 3);
    assert.equal(manifest.distinctness.status, "not-reviewed");
    assert.equal(manifest.variants.every((row: { bgm: { measuredBpm: unknown; gridErrorMs: unknown } }) => row.bgm.measuredBpm === null && row.bgm.gridErrorMs === null), true);
    const actualCommands = readFileSync(commands, "utf8").trim().split("\n").map(line => JSON.parse(line));
    assert.equal(actualCommands.filter(args => args.some((value: string) => value.includes('sidechaincompress'))).length, 4, "one main and one requested music mix per variant");
    assert.ok(actualCommands.some(args => args.includes('-xerror')), "current generated video is fully decoded before formal publication");
    assert.ok(actualCommands.some(args => args.some((value: string) => value.includes('loudnorm=') && value.includes('print_format=json'))), "actual final audio loudness and true peak are recorded without a paid model");
    const currentQuality = await inspectGenerationManifest({ root: pointer.releaseDir, manifest, bins: { ffmpeg, ffprobe } });
    assert.equal(currentQuality.passed, true); assert.equal(currentQuality.artisticQualityReviewed, false);
    for (const id of ["master", ...manifest.variants.map((variant: { id: string }) => `variant:${variant.id}`)]) {
      const asset = currentQuality.assets.find((row: { id: string }) => row.id === id);
      assert.ok(Number.isFinite(asset?.audioMeasurement?.integratedLufs), `actual current ${id} has measured LUFS`);
      assert.ok(Number.isFinite(asset?.audioMeasurement?.truePeakDbtp), `actual current ${id} has measured true peak`);
      assert.equal(asset?.audioMeasurement?.windowSec, null, "final audio measurement covers the whole file");
    }
  } finally { rmSync(f.root, { recursive: true, force: true }); }
}, 300_000);


async function partialCompletedFixture(pendingChange: Record<string, unknown> = {}) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "partial-original-prerender-"))), projectId = "MOCK-PARTIAL";
  const photo = join(root, "pending.jpg"), encodedPhoto = spawnSync(ffmpeg, ["-v", "error", "-nostdin", "-n", "-f", "lavfi", "-i", "color=blue:s=64x64", "-frames:v", "1", photo], { encoding: "utf8", timeout: 30_000 });
  assert.equal(encodedPhoto.status, 0, encodedPhoto.stderr);
  const originalCard = { shotId: "S1", duration: 4, scene: "历史原片卡片不再改写", product: "ABSENT-HISTORICAL-PRODUCT", photo: "/absent/historical.jpg", materialUsage: "static-display", assetRef: "malformed historical reference" };
  const pendingCard = { shotId: "S2", duration: 4, scene: "无人海边岩岸空镜", action: "无人，只有日落天光", composition: "海岸远景", depth_of_field: "全画面清晰", photo, materialUsage: "generation-reference", environmentProfile: { setting: "exterior", condition: "natural" }, ...pendingChange };
  const source = { projectId, durationSeconds: 8, fps: 24, aspect: "9:16", resolution: "720p",
    sceneBible: { spaceId: "coast", space: { city: "上海", building: "海边岩岸", orientation: "朝海", timeOfDay: "傍晚" }, materials: [], practicalLights: [{ type: "日落天光", direction: "西侧" }], traces: [], environmentProfile: { setting: "exterior", condition: "natural" }, eraProfile: { storyDate: "2024-01-01" } }, shots: [originalCard, pendingCard] };
  const bytes = Buffer.from(JSON.stringify(source)), shots = join(root, "shots.json"); writeFileSync(shots, bytes);
  const submitted = await freezeOriginalSubmission({ productionRoot: root, projectId, bytes }), clips = join(root, "clips", projectId); mkdirSync(clips, { recursive: true });
  const raw = join(clips, "S1.raw.mp4"), encoded = spawnSync(ffmpeg, ["-v", "error", "-nostdin", "-n", "-f", "lavfi", "-i", "color=black:s=64x64:r=24:d=4", "-an", "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", raw], { encoding: "utf8", timeout: 30_000 });
  assert.equal(encoded.status, 0, encoded.stderr);
  const rawSha256 = hash(readFileSync(raw)), logs = join(root, "logs", projectId), accepted = join(logs, "accepted-tasks"); mkdirSync(accepted, { recursive: true });
  const taskId = "offline-original-S1"; writeFileSync(join(accepted, "S1.json"), JSON.stringify({ schemaVersion: "workloom.render-task/v1", state: "accepted", taskId, requestHash: hash("offline accepted original") }));
  const historyFile = join(logs, "stages.jsonl"), history = Buffer.from(JSON.stringify({ stage: "shot", shotId: "S1", ok: false, degraded: false, artifact: raw, verdict: { approved: false, score: 1, reason: "historical quality rejection" }, evidence: { taskId, requestInputVerified: true, providerSuccess: true, rawSha256 },
    lineage: { schemaVersion: "workloom.production-lineage/v1", projectId, stage: "shot", shotId: "S1", runId: "offline-historical", sourceHash: hash("old semantic card"), recipeHash: hash("old component"), status: "failed", inputs: [{ path: shots, sha256: submitted.sha256, bytes: bytes.length }], outputs: [{ path: raw, sha256: rawSha256, bytes: statSync(raw).size }], errors: [] } }) + "\n");
  writeFileSync(historyFile, history);
  const promptDir = join(root, "prompts", projectId); mkdirSync(promptDir, { recursive: true }); const oldPrompt = join(promptDir, "S1.txt"); writeFileSync(oldPrompt, "IMMUTABLE HISTORICAL PROMPT");
  const deny = join(root, "deny-network.mjs"); writeFileSync(deny, 'globalThis.fetch = async () => { throw new Error("FORBIDDEN_NETWORK_OR_PAID_CALL"); };\n');
  const execute = () => spawnSync(process.execPath, ["--import", "tsx", "--import", deny, cli, "--shots", shots, "--work-dir", root, "--out", join(root, "out"), "--keys-file", join(root, "missing.env"), "--route-kind", "narrative", "--platform", "B站", "--stages", "cine-kb,micromotion,spec,plates"],
    // This explicitly offline local pre-production fixture records plausibility as unverified; the production model gate stays fail-closed.
    { cwd: repo, encoding: "utf8", timeout: 60_000, env: { ...process.env, FILM_WORKER_MODE: "", WL_FFMPEG: ffmpeg, WL_FFPROBE: ffprobe, LLM_PROVIDER: "mock", LLM_API_KEY: "", VOLCENGINE_ARK_API_KEY: "" } });
  return { root, projectId, raw, rawSha256, source, historyFile, history, oldPrompt, execute };
}
test("partial completed S1 preserves old card and prompt while pending material S2 receives the requested local prerender stages", async () => {
  const f = await partialCompletedFixture();
  try {
    const done = f.execute(); assert.equal(done.status, 0, done.stdout + done.stderr); assert.doesNotMatch(done.stdout + done.stderr, /FORBIDDEN_NETWORK_OR_PAID_CALL|平台已受理/);
    assert.equal(hash(readFileSync(f.raw)), f.rawSha256); assert.equal(readFileSync(f.oldPrompt, "utf8"), "IMMUTABLE HISTORICAL PROMPT"); assert.deepEqual(readFileSync(f.historyFile).subarray(0, f.history.length), f.history);
    const current = JSON.parse(readFileSync(join(f.root, `shotlist-current-${f.projectId}.json`), "utf8")); assert.deepEqual(current.shots[0], f.source.shots[0]);
    const rows = readFileSync(f.historyFile, "utf8").slice(f.history.length).trim().split("\n").map(line => JSON.parse(line));
    assert.equal(rows.filter(row => row.stage === "render-adopted" && row.shotId === "S1").length, 1);
    assert.equal(rows.some(row => ["cine-kb", "micromotion", "spec", "keyframe"].includes(row.stage) && row.shotId === "S1"), false);
    for (const stage of ["spec", "keyframe"]) assert.equal(rows.some(row => row.stage === stage && row.shotId === "S2" && row.ok), true, stage);
    const pack = rows.find(row => row.stage === "prompt-package"); assert.deepEqual(pack.evidence.materialShots, ["S2"]); assert.equal(pack.invoked, false);
    assert.equal(rows.some(row => row.stage === "prompt-review"), false); assert.equal(existsSync(join(f.root, "logs", f.projectId, "accepted-tasks", "S2.json")), false);
  } finally { rmSync(f.root, { recursive: true, force: true }); }
}, 90_000);
test.each([
  { change: { product: "ABSENT-PENDING-PRODUCT" }, error: /镜头 S2 声明了商品/ },
  { change: { assetRef: "malformed pending reference" }, error: /授权真人素材引用格式非法（S2）/ },
  { change: { materialUsage: "static-display" }, error: /素材用途硬约束未通过/ },
])("pending S2 prerequisite $change still blocks before any network or paid work", async ({ change, error }) => {
  const f = await partialCompletedFixture(change);
  try { const done = f.execute(); assert.notEqual(done.status, 0, done.stdout + done.stderr); assert.match(done.stdout + done.stderr, error); assert.doesNotMatch(done.stdout + done.stderr, /FORBIDDEN_NETWORK_OR_PAID_CALL|平台已受理/);
    assert.equal(hash(readFileSync(f.raw)), f.rawSha256); assert.equal(readFileSync(f.oldPrompt, "utf8"), "IMMUTABLE HISTORICAL PROMPT"); assert.equal(existsSync(join(f.root, "logs", f.projectId, "accepted-tasks", "S2.json")), false);
  } finally { rmSync(f.root, { recursive: true, force: true }); }
}, 90_000);
