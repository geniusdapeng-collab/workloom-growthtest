/** Cryptographic fixtures only; no production receipt issuer is provided here. */
import { createHmac, randomBytes } from "node:crypto";
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { audioStemDigest, describeAudioStemSources } from "../bgm-bridge/audio-stems.mjs";
import { audioStemReceiptPayload, createAudioStemReceiptVerifier } from "../bgm-bridge/audio-stems-trust.mjs";

const now = Date.parse("2026-09-28T00:00:00.000Z");
const secret = randomBytes(32).toString("hex");
const env = { WORKLOOM_AUDIO_STEM_SIGNING_SECRET: secret, WORKLOOM_AUDIO_STEM_SIGNING_KEY_ID: "fixture-only" };
const scope = { tenantId: "t", workspaceId: "w", projectId: "p", revision: 1 };
const binding = describeAudioStemSources({ scope, shots: [{ shotId: "one", videoSha256: "a".repeat(64), durationSec: 1,
  stems: Object.fromEntries(["dialogue", "ambience", "foley", "music"].map((role) => [role, { status: "not_applicable", reason: "Explicit fixture only" }])) }] })[0].binding;
function signed(overrides = {}) {
  const receipt = { schemaVersion: "workloom.audio-stem-receipt/v1", purpose: "independent-audio-source",
    bindingSha256: audioStemDigest(binding), workerId: "test-worker", jobId: "test-job", evidenceSha256: "b".repeat(64),
    issuedAt: new Date(now - 1000).toISOString(), expiresAt: new Date(now + 3600000).toISOString(), keyId: "fixture-only", ...overrides };
  receipt.signature = createHmac("sha256", secret).update(audioStemReceiptPayload(receipt)).digest("hex");
  return receipt;
}
function request(receipt = signed(), bound = binding) {
  return { binding: bound, bindingSha256: audioStemDigest(bound), receipt, receiptSha256: audioStemDigest(receipt) };
}
describe("host audio source signature verification", () => {
  it("accepts an exact current independent-source receipt without exposing signing secrets", async () => {
    const result = await createAudioStemReceiptVerifier({ env, now: () => now })(request());
    assert.equal(result.status, "passed");
    assert.equal(result.workerId, "test-worker");
    assert.ok(!JSON.stringify(result).includes(secret));
  });
  it("has no default signing key and does not use bridge or delivery signing credentials", async () => {
    for (const input of [{}, { WORKLOOM_AUDIO_STEM_SIGNING_SECRET: "short" }, { WORKLOOM_DELIVERY_SIGNING_SECRET: secret }]) {
      await assert.rejects(createAudioStemReceiptVerifier({ env: input, now: () => now })(request()), { code: "audio_stems_source_unverified" });
    }
  });
  it("rejects a valid signature from a different tenant than the bound host", async () => {
    await assert.rejects(createAudioStemReceiptVerifier({ env, now: () => now, expectedTenant: "other" })(request()), { code: "audio_stems_source_unverified" });
    assert.equal((await createAudioStemReceiptVerifier({ env, now: () => now, expectedTenant: "t" })(request())).status, "passed");
  });
  it("rejects wrong key identity, altered signature and request digest", async () => {
    const verify = createAudioStemReceiptVerifier({ env, now: () => now });
    await assert.rejects(verify(request(signed({ keyId: "other" }))));
    const receipt = signed(); receipt.signature = "0".repeat(64);
    await assert.rejects(verify(request(receipt)));
    await assert.rejects(verify({ ...request(), receiptSha256: "c".repeat(64) }));
    await assert.rejects(verify({ ...request(), bindingSha256: "d".repeat(64) }));
  });
  it("rejects scope, role, original picture or timing replay even with a valid unchanged signature", async () => {
    const verify = createAudioStemReceiptVerifier({ env, now: () => now });
    for (const changed of [{ ...binding, role: "foley" }, { ...binding, shotSamples: 96000 },
      { ...binding, videoSha256: "c".repeat(64) }, { ...binding, scope: { ...scope, tenantId: "other" } },
      { ...binding, scope: { ...scope, projectId: "other" } }, { ...binding, scope: { ...scope, revision: 2 } }]) {
      await assert.rejects(verify(request(signed(), changed)), { code: "audio_stems_source_unverified" });
    }
  });
  it("checks current expiration on each call, including after a previous success", async () => {
    let clock = now;
    const verify = createAudioStemReceiptVerifier({ env, now: () => clock });
    const input = request();
    await verify(input);
    clock = now + 3600000;
    await assert.rejects(verify(input), { code: "audio_stems_source_unverified" });
    await assert.rejects(createAudioStemReceiptVerifier({ env, now: () => now })(request(signed({ issuedAt: new Date(now + 60000).toISOString() }))));
  });
  it("rejects self-declared clean, other-purpose seals, unknown fields and invalid time windows", () => {
    for (const changed of [{ clean: true }, { purpose: "delivery" }, { evidenceSha256: "short" },
      { expiresAt: new Date(now + 25 * 3600000).toISOString() }, { issuedAt: "2026-09-28" },
      { expiresAt: new Date(now - 2000).toISOString() }, { workerId: "" }]) {
      assert.throws(() => audioStemReceiptPayload({ ...signed(), ...changed }), { code: "audio_stems_source_unverified" });
    }
  });
});
