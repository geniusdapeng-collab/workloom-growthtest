import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { assessVoiceArtifact, fingerprintFile, fingerprintText, promoteDubCandidate } from "./film-voice-artifact.ts";

function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), "film-voice-artifact-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const raw = join(dir, "SC-01.mp4");
  const voiced = join(dir, "SC-01.voiced.mp4");
  writeFileSync(raw, "raw clip A");
  writeFileSync(voiced, "dubbed from raw clip A");
  const text = "这一句需要人声。";
  const profile = "zh-xiaozhi";
  const projectId = "VID-A";
  const shotId = "SC-01";
  const record = {
    stage: "voice", shotId, ok: true, artifact: voiced,
    evidence: {
      projectId, source: "tts-narration", profile,
      rawSha256: fingerprintFile(raw), textSha256: fingerprintText(text), voicedSha256: fingerprintFile(voiced),
    },
  };
  const input = { record, projectId, shotId, raw, voiced, text, profile };
  return { ...input, dir };
}

test("a verified dubbed clip is reusable only while its complete provenance matches", (t) => {
  const f = fixture(t);
  assert.deepEqual(
    { ok: assessVoiceArtifact(f).ok, voiced: assessVoiceArtifact(f).voiced },
    { ok: true, voiced: true },
  );
  assert.equal(assessVoiceArtifact({ ...f, text: "换了一句台词。" }).reason, "dialogue_changed");
  assert.equal(assessVoiceArtifact({ ...f, profile: "another-voice" }).reason, "profile_changed");
  assert.equal(assessVoiceArtifact({ ...f, projectId: "VID-B" }).reason, "project_mismatch");
  writeFileSync(f.voiced, "tampered dub");
  assert.equal(assessVoiceArtifact(f).reason, "voiced_changed");
});

test("a newer old dub cannot hide a changed raw clip or a failed latest receipt", (t) => {
  const f = fixture(t);
  writeFileSync(f.raw, "raw clip B");
  const future = new Date(Date.now() + 60_000);
  utimesSync(f.voiced, future, future);
  assert.equal(assessVoiceArtifact(f).reason, "raw_changed");
  writeFileSync(f.raw, "raw clip A");
  assert.equal(assessVoiceArtifact({ ...f, record: { ...f.record, ok: false } }).reason, "missing_or_failed_voice_receipt");
  assert.equal(assessVoiceArtifact({ ...f, record: { ...f.record, evidence: { source: "tts-narration" } } }).reason, "project_mismatch");
});

test("a raw clip accepted by ASR remains the composition choice even with a newer dub file", (t) => {
  const f = fixture(t);
  const rawReceipt = {
    ...f.record,
    artifact: f.raw,
    evidence: { ...f.record.evidence, source: "clip-audio" },
  };
  const status = assessVoiceArtifact({ ...f, record: rawReceipt });
  assert.equal(status.ok, true);
  assert.equal(status.voiced, false);
});

test("a failed dub cannot accept or overwrite a stale previous output", (t) => {
  const f = fixture(t);
  const candidate = join(f.dir, "pending.mp4");
  writeFileSync(candidate, "partial new dub");
  const result = promoteDubCandidate({ candidate, final: f.voiced, commandOk: false, verifiedOk: true });
  assert.deepEqual(result, { ok: false, reason: "dub_command_failed" });
  assert.equal(readFileSync(f.voiced, "utf8"), "dubbed from raw clip A");
  assert.equal(readFileSync(f.raw, "utf8"), "raw clip A");
  assert.throws(() => readFileSync(candidate));
});

test("only a successful and verified new candidate is promoted", (t) => {
  const f = fixture(t);
  const candidate = join(f.dir, "pending.mp4");
  assert.equal(promoteDubCandidate({ candidate, final: f.voiced, commandOk: true, verifiedOk: true }).reason, "dub_output_missing_or_empty");
  writeFileSync(candidate, "unverified new dub");
  assert.equal(promoteDubCandidate({ candidate, final: f.voiced, commandOk: true, verifiedOk: false }).reason, "dub_verification_failed");
  assert.equal(readFileSync(f.voiced, "utf8"), "dubbed from raw clip A");
  writeFileSync(candidate, "verified new dub");
  assert.deepEqual(promoteDubCandidate({ candidate, final: f.voiced, commandOk: true, verifiedOk: true }), { ok: true, reason: "promoted" });
  assert.equal(readFileSync(f.voiced, "utf8"), "verified new dub");
});


test("an unverified or degraded voice receipt cannot authorize a raw clip", (t) => {
  const f = fixture(t);
  const unverified = { ...f.record, artifact: f.raw, evidence: { ...f.record.evidence, source: "clip-audio-unverified" } };
  assert.equal(assessVoiceArtifact({ ...f, record: unverified }).ok, false);
  const degraded = { ...unverified, degraded: true, evidence: { ...unverified.evidence, source: "clip-audio" } };
  assert.equal(assessVoiceArtifact({ ...f, record: degraded }).ok, false);
});
