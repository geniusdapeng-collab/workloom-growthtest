import { createHash } from "node:crypto";
import { closeSync, existsSync, openSync, readSync, renameSync, rmSync, statSync } from "node:fs";

/** The stage log is the receipt for the exact raw clip, dialogue and voice profile. */
export interface VoiceArtifactRecord {
  stage: string;
  shotId: string | null;
  ok: boolean;
  degraded?: boolean;
  artifact: string | null;
  evidence: Record<string, unknown>;
}

export type VoiceArtifactStatus = {
  ok: boolean;
  voiced: boolean;
  reason: string;
  rawSha256?: string;
  textSha256?: string;
  voicedSha256?: string;
};

const VOICED_SOURCES = new Set(["tts-narration", "tts-term-replaced", "voiced-reuse"]);
const RAW_SOURCES = new Set(["clip-audio"]);

export function fingerprintText(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

/** Hash in chunks so checking a large rendered clip does not load it all into RAM. */
export function fingerprintFile(file: string): string {
  const hash = createHash("sha256");
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  const fd = openSync(file, "r");
  try {
    let bytes = 0;
    do {
      bytes = readSync(fd, buffer, 0, buffer.length, null);
      if (bytes > 0) hash.update(buffer.subarray(0, bytes));
    } while (bytes > 0);
  } finally {
    closeSync(fd);
  }
  return hash.digest("hex");
}

/** Old receipts without full provenance deliberately fail closed and trigger a new voice check. */
export function assessVoiceArtifact({
  record, projectId, shotId, raw, voiced, text, profile,
}: {
  record: VoiceArtifactRecord | null | undefined;
  projectId: string;
  shotId: string;
  raw: string;
  voiced: string;
  text: string;
  profile: string;
}): VoiceArtifactStatus {
  if (!record || record.stage !== "voice" || record.shotId !== shotId || !record.ok || record.degraded) {
    return { ok: false, voiced: false, reason: "missing_or_failed_voice_receipt" };
  }
  const evidence = record.evidence ?? {};
  if (evidence.projectId !== projectId) return { ok: false, voiced: false, reason: "project_mismatch" };
  if (!existsSync(raw)) return { ok: false, voiced: false, reason: "raw_missing" };
  try {
    const rawSha256 = fingerprintFile(raw);
    const textSha256 = fingerprintText(text);
    if (evidence.rawSha256 !== rawSha256) return { ok: false, voiced: false, reason: "raw_changed" };
    if (evidence.textSha256 !== textSha256) return { ok: false, voiced: false, reason: "dialogue_changed" };
    const source = evidence.source;
    if (RAW_SOURCES.has(String(source))) {
      return record.artifact === raw
        ? { ok: true, voiced: false, reason: "raw_voice_verified", rawSha256, textSha256 }
        : { ok: false, voiced: false, reason: "raw_artifact_mismatch" };
    }
    if (!VOICED_SOURCES.has(String(source))) return { ok: false, voiced: false, reason: "source_not_approved" };
    if (record.artifact !== voiced) return { ok: false, voiced: false, reason: "voiced_artifact_mismatch" };
    if (evidence.profile !== profile) return { ok: false, voiced: false, reason: "profile_changed" };
    if (!existsSync(voiced)) return { ok: false, voiced: false, reason: "voiced_missing" };
    const voicedSha256 = fingerprintFile(voiced);
    if (evidence.voicedSha256 !== voicedSha256) return { ok: false, voiced: false, reason: "voiced_changed" };
    return { ok: true, voiced: true, reason: "voiced_receipt_verified", rawSha256, textSha256, voicedSha256 };
  } catch (error) {
    return { ok: false, voiced: false, reason: `artifact_read_failed: ${error instanceof Error ? error.message : String(error)}` };
  }
}

/** Only a successful, checked new candidate may replace the last good voice artifact. */
export function promoteDubCandidate({
  candidate, final, commandOk, verifiedOk,
}: {
  candidate: string;
  final: string;
  commandOk: boolean;
  verifiedOk: boolean;
}): { ok: boolean; reason: string } {
  let reason = "";
  try {
    if (!commandOk) reason = "dub_command_failed";
    else if (!existsSync(candidate) || statSync(candidate).size === 0) reason = "dub_output_missing_or_empty";
    else if (!verifiedOk) reason = "dub_verification_failed";
    else {
      renameSync(candidate, final);
      return { ok: true, reason: "promoted" };
    }
  } catch (error) {
    reason = `dub_promotion_failed: ${error instanceof Error ? error.message : String(error)}`;
  }
  try {
    rmSync(candidate, { force: true });
  } catch (error) {
    reason += `; candidate_cleanup_failed: ${error instanceof Error ? error.message : String(error)}`;
  }
  return { ok: false, reason };
}
