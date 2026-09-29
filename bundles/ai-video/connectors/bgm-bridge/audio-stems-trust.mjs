/**
 * Verify independent-source receipts issued by the internal media worker.
 * There is deliberately no signer or network signing endpoint in this bridge.
 * A user-supplied `clean: true`, tool receipt, or delivery seal is not authority.
 */
import { createHmac, timingSafeEqual } from "node:crypto";
import { AudioStemError, audioStemDigest } from "./audio-stems.mjs";

export const AUDIO_STEM_RECEIPT_SCHEMA = "workloom.audio-stem-receipt/v1";
export const AUDIO_STEM_RECEIPT_PURPOSE = "independent-audio-source";
const FIELDS = ["schemaVersion", "purpose", "bindingSha256", "workerId", "jobId", "evidenceSha256", "issuedAt", "expiresAt", "keyId"];
const SHA256 = /^[a-f0-9]{64}$/;
const MAX_VALIDITY_MS = 24 * 60 * 60 * 1000;
const CLOCK_SKEW_MS = 30_000;
const fail = (message) => { throw new AudioStemError(message, "audio_stems_source_unverified"); };

/** Canonical bytes consumed by the internal worker's HMAC implementation. This does not sign. */
export function audioStemReceiptPayload(receipt) {
  if (!receipt || typeof receipt !== "object" || Array.isArray(receipt)
    || Object.keys(receipt).some((key) => ![...FIELDS, "signature"].includes(key))) fail("音轨来源签章结构非法");
  if (FIELDS.some((key) => typeof receipt[key] !== "string" || !receipt[key].trim() || receipt[key].length > 1000)) fail("音轨来源签章字段缺失或非法");
  if (receipt.schemaVersion !== AUDIO_STEM_RECEIPT_SCHEMA || receipt.purpose !== AUDIO_STEM_RECEIPT_PURPOSE
    || !SHA256.test(receipt.bindingSha256) || !SHA256.test(receipt.evidenceSha256)) fail("音轨来源签章用途或摘要非法");
  const issued = Date.parse(receipt.issuedAt), expires = Date.parse(receipt.expiresAt);
  if (!Number.isFinite(issued) || !Number.isFinite(expires) || expires <= issued || expires - issued > MAX_VALIDITY_MS
    || new Date(issued).toISOString() !== receipt.issuedAt || new Date(expires).toISOString() !== receipt.expiresAt) {
    fail("音轨来源签章有效期非法");
  }
  return JSON.stringify(Object.fromEntries([...FIELDS].sort().map((key) => [key, receipt[key]])));
}

/**
 * Only the trusted host constructs this factory from service/CLI configuration.
 * Call parameters and manifests cannot override the key. Keys never enter the
 * returned evidence. Expired grants must be renewed by the media authority.
 */
export function createAudioStemReceiptVerifier({ env = process.env, now = () => Date.now(), expectedTenant = null } = {}) {
  const secret = env.WORKLOOM_AUDIO_STEM_SIGNING_SECRET;
  const keyId = env.WORKLOOM_AUDIO_STEM_SIGNING_KEY_ID || "audio-stems-v1";
  return async ({ binding, bindingSha256, receipt, receiptSha256 }) => {
    if (expectedTenant && binding?.scope?.tenantId !== expectedTenant) fail("音轨来源租户与工位绑定不符");
    if (typeof secret !== "string" || Buffer.byteLength(secret) < 32 || secret.length > 4096
      || typeof keyId !== "string" || !keyId.trim()) fail("工位未配置独立音轨来源验证密钥");
    if (audioStemDigest(binding) !== bindingSha256 || audioStemDigest(receipt) !== receiptSha256) fail("来源验证请求摘要不一致");
    const payload = audioStemReceiptPayload(receipt);
    if (receipt.keyId !== keyId || receipt.bindingSha256 !== bindingSha256 || !SHA256.test(receipt.signature ?? "")) fail("来源签章未绑定本次音轨或密钥身份");
    const at = now();
    if (!Number.isFinite(at) || Date.parse(receipt.issuedAt) > at + CLOCK_SKEW_MS || Date.parse(receipt.expiresAt) <= at) fail("音轨来源资格尚未生效或已过期，需要服务重新核实");
    const expected = createHmac("sha256", secret).update(payload).digest();
    if (!timingSafeEqual(expected, Buffer.from(receipt.signature, "hex"))) fail("音轨来源签章无法验证");
    return { status: "passed", bindingSha256, receiptSha256, workerId: receipt.workerId,
      jobId: receipt.jobId, evidenceSha256: receipt.evidenceSha256, expiresAt: receipt.expiresAt };
  };
}
