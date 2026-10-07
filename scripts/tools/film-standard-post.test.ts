import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "vitest";
import { adoptCompletedOriginalRenders, runStandardPost, adoptLegacyOriginalRenders, assertStandardPostAudioClock, assertStandardPostVariantAxes, captureOriginalRenderManifest, freezeOriginalSubmission, issueOriginalRenderReceipt,
  loadOriginalRenderManifest, resolveStandardPostBinary, standardPostFileHash, StandardPostError, validateStandardPostSettings, type StandardPostSettings } from "./film-standard-post.mjs";
const hash = (bytes: Buffer | string) => createHash("sha256").update(bytes).digest("hex");
const repo = resolve(import.meta.dirname, "../.."), cli = join(repo, "scripts/tools/full-chain-film.mts");
const ffmpeg = process.env.WL_FFMPEG ?? "ffmpeg", ffprobe = process.env.WL_FFPROBE ?? "ffprobe";
function call(args: string[]) { return spawnSync(process.execPath, ["--import", "tsx", cli, ...args], { cwd: repo, encoding: "utf8", timeout: 30_000,
  env: { ...process.env, FILM_WORKER_MODE: "", WL_FFMPEG: ffmpeg, WL_FFPROBE: ffprobe } }); }
function media(file: string) {
  const result = spawnSync(ffmpeg, ["-v", "error", "-nostdin", "-n", "-f", "lavfi", "-i", "testsrc2=s=160x288:r=24:d=1",
    "-f", "lavfi", "-i", `sine=frequency=${file.includes("S2") ? 866 : 733}:sample_rate=48000:duration=1`, "-map", "0:v:0", "-map", "1:a:0", "-c:v", "libx264", "-preset", "ultrafast",
    "-pix_fmt", "yuv420p", "-c:a", "aac", "-ar", "48000", "-ac", "2", "-t", "1", file], { encoding: "utf8", timeout: 60_000 });
  assert.equal(result.status, 0, result.stderr);
}
async function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "standard-original-fixture-"))), projectId = "MOCK-STANDARD";
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
  const result = await assertStandardPostAudioClock(file, 1, { ffmpeg: "must-not-be-invoked", ffprobe, timeoutMs: 60_000 });
  assert.equal(result.actualDurationSec, 1); assert.equal(result.requestedDurationSec, 1);
  assert.match(result.basis, /metadata only.*No complete PCM decode/);
  assert.equal(hash(readFileSync(file)), before);
}));
test("final clock readback rejects a requested export duration mismatch and preserves bytes", async () => using(async f => {
  const file = join(f.clips, "S1.mp4"), before = hash(readFileSync(file));
  await assert.rejects(assertStandardPostAudioClock(file, 2, { ffmpeg: "must-not-be-invoked", ffprobe, timeoutMs: 60_000 }), /STANDARD_POST_EXPORT_CLOCK_INVALID/);
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
        outputs: [{ path, sha256, bytes: bytes.length }], errors: [] } };
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

async function unusualCompletedFixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "standard-raw-completed-"))), projectId = "MOCK-RAW-COMPLETED";
  const bytes = Buffer.from(JSON.stringify({ projectId, title: "原片后期", durationSeconds: 10, aspect: "9:16", resolution: "720p", fps: 24,
    shots: [{ shotId: "S1", duration: 10, scene: "已生成的原镜头", action: "保留原镜头", dialogue: [{ speaker: "原片", text: "原片无声" }] }] }));
  const submitted = await freezeOriginalSubmission({ productionRoot: root, projectId, bytes });
  const clips = join(root, "clips", projectId); mkdirSync(clips, { recursive: true });
  const raw = join(clips, "S1.mp4"), result = spawnSync(ffmpeg, ["-v", "error", "-nostdin", "-n", "-f", "lavfi", "-i",
    "color=c=black:s=162x122:r=24", "-vf", "crop=161:121:exact=1", "-frames:v", "241", "-an", "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv444p", raw],
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
test.each([false, true])("actual standard post creates all presentations from unusual completed media without quality/model review (music=%s)", async withMusic => {
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
    assert.equal(delivered.projectId, f.projectId);
    const manifest = JSON.parse(readFileSync(join(outputDir, `${f.projectId}-delivery-manifest.json`), "utf8"));
    assert.equal(manifest.outputs.length, 5); assert.equal(manifest.modelCalls, 0); assert.equal(manifest.supplierGenerationCalls, 0);
    assert.equal(manifest.ttsCalls, 0); assert.equal(manifest.asrCalls, 0); assert.equal(manifest.sourceFilesUnchanged, true);
    assert.equal(manifest.distinctness.qualityReviewPerformed, false);
    for (const output of manifest.outputs) { assert.equal(existsSync(output.path), true); assert.equal(hash(readFileSync(output.path)), output.sha256); }
    if (withMusic) for (const output of manifest.outputs.filter((row: { id: string }) => ["warm-film", "cool-tech", "punchy-social"].includes(row.id))) {
      assert.equal(output.bgm.independentAudio.sourceAuthority, "native-source"); assert.equal(output.bgm.independentAudio.stemsVerified, false);
      assert.equal(output.bgm.metrics, null); assert.equal(output.bgm.qualityReviewPerformed, false);
      assert.equal(output.bgm.bgm.playedSha256, postSettings.music.find(row => row.id === output.id)!.sha256);
    }
    assert.equal(hash(readFileSync(f.raw)), f.rawSha256); assert.deepEqual(readFileSync(f.historyFile), f.history);
  } finally { rmSync(f.root, { recursive: true, force: true }); }
}, 300_000);


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

test("whole normal CLI completes all official post stages with declared single mixes and no default source-quality scans", async () => {
  const f = await unusualCompletedFixture();
  try {
    const shots = join(f.root, "source.json"), denyNetwork = join(f.root, "deny-network.mjs"), binary = join(f.root, "no-quality-ffmpeg.mjs"), commands = join(f.root, "commands.jsonl");
    writeFileSync(shots, f.bytes);
    writeFileSync(denyNetwork, 'globalThis.fetch = async () => { throw new Error("FORBIDDEN_NETWORK_OR_PAID_CALL"); };\n');
    const actualFfmpeg = await resolveStandardPostBinary(ffmpeg);
    writeFileSync(binary, `#!${process.execPath}\nimport {spawnSync} from 'node:child_process';\nimport fs from 'node:fs';\nconst args=process.argv.slice(2);\nfs.appendFileSync(${JSON.stringify(commands)},JSON.stringify(args)+'\\n');\nif(args.includes('-count_frames')||args.some(arg=>/signalstats|psnr|framemd5|edgedetect|ebur128|astats|blurdetect|bbox=/.test(arg))||args.includes('f32le')){process.stderr.write('forbidden default quality review');process.exit(87); }\nconst result=spawnSync(${JSON.stringify(actualFfmpeg)},args,{stdio:'inherit'});\nif(result.error){process.stderr.write(result.error.message);process.exit(52); }\nprocess.exit(result.status??53);\n`); chmodSync(binary, 0o755);
    const output = join(f.root, "delivery");
    const result = spawnSync(process.execPath, ["--import", "tsx", "--import", denyNetwork, cli, "--shots", shots,
      "--work-dir", f.root, "--out", output, "--keys-file", join(f.root, "nonexistent.env"), "--stages", "voice,compose,color,subtitle,danmaku,bgm,cover,mux,master,deliver"],
    { cwd: repo, encoding: "utf8", timeout: 240_000, env: { ...process.env, FILM_WORKER_MODE: "", WL_FFMPEG: binary, WL_FFPROBE: ffprobe,
      WORKLOOM_BGM_DISCOVER: "0", WORKLOOM_BGM_LIBRARY_DIR: join(f.root, "empty-custom-library"), WORKLOOM_BGM_HOME: join(f.root, "empty-bgm-home") } });
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    assert.equal(hash(readFileSync(f.raw)), f.rawSha256);
    assert.doesNotMatch(result.stdout + result.stderr, /FORBIDDEN_NETWORK_OR_PAID_CALL|forbidden default quality review|平台已受理/);
    const records = readFileSync(f.historyFile, "utf8").slice(f.history.length).trim().split("\n").map(line => JSON.parse(line));
    for (const stage of ["compose", "color", "subtitle", "danmaku", "bgm", "cover", "mux", "master", "deliver"]) {
      assert.equal(records.some(row => row.stage === stage && row.ok === true), true, stage);
    }
    const manifest = JSON.parse(readFileSync(join(output, `${f.projectId}-delivery-manifest.json`), "utf8"));
    assert.equal(manifest.variants.length, 3);
    assert.equal(manifest.distinctness.status, "not-reviewed");
    assert.equal(manifest.variants.every((row: { bgm: { measuredBpm: unknown; gridErrorMs: unknown } }) => row.bgm.measuredBpm === null && row.bgm.gridErrorMs === null), true);
    const actualCommands = readFileSync(commands, "utf8").trim().split("\n").map(line => JSON.parse(line));
    assert.equal(actualCommands.filter(args => args.some((value: string) => value.includes('sidechaincompress'))).length, 4, "one main and one requested music mix per variant");
  } finally { rmSync(f.root, { recursive: true, force: true }); }
}, 300_000);
