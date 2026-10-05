/** Parent video submission facts carried in the current IPC response.
 * receiptHash detects byte-contract changes; it is not a signature, provider
 * attestation, or face/likeness proof. Only the parent creates this receipt
 * after its compiled POST was accepted and the output was downloaded/hashed.
 */
import { createHash } from "node:crypto";
import { FilmChannelError, filmCanonicalJson, filmRequestHash } from "./film-worker-channel.js";

export interface FilmVideoArtifactBinding { ref: string; sha256: string; bytes: number }
export interface FilmVideoReferenceInput {
  role: "reference-image" | "first-frame";
  /** Job-relative byte source, or asset:// URI when only URI identity is known. */
  ref: string;
  sha256: string;
  hashKind: "bytes" | "asset-uri";
  /** Hosted first frame: URI identity in addition to its issued artifact bytes. */
  requestUriSha256?: string;
}
export interface FilmVideoSubmissionFacts {
  jobId: string;
  projectId: string;
  inputSha256: string;
  shotId: string;
  stepKey: string;
  /** filmRequestHash(video.generate, stepKey, shotId, actual IPC params). */
  requestHash: string;
  /** The actual compiled provider request payloadHash recorded by the parent. */
  providerRequestHash: string;
  taskId: string;
  artifact: FilmVideoArtifactBinding;
  promptSha256: string;
  /** Order is significant; the first frame has a distinct role. */
  referenceInputs: readonly FilmVideoReferenceInput[];
  aspect: string;
  resolution: string;
  seconds: number;
  generateAudio: boolean;
}
export interface FilmVideoSubmissionReceipt extends FilmVideoSubmissionFacts {
  schemaVersion: "workloom.film-video-submission/v1";
  receiptHash: string;
}
export interface FilmVideoSubmissionExpected extends Omit<FilmVideoSubmissionFacts, "requestHash" | "providerRequestHash"> {
  /** Independently retained actual parameters sent through the current IPC call. */
  requestParams: unknown;
  requestHash?: string;
  /** Optional when the child independently knows the compiled provider bytes. */
  providerRequestHash?: string;
}

const SCHEMA = "workloom.film-video-submission/v1" as const;
const FACT_KEYS = ["jobId", "projectId", "inputSha256", "shotId", "stepKey", "requestHash", "providerRequestHash", "taskId", "artifact", "promptSha256", "referenceInputs", "aspect", "resolution", "seconds", "generateAudio"] as const;
const HASH = /^[a-f0-9]{64}$/;
const ASSET = /^asset:\/\/[A-Za-z0-9][A-Za-z0-9._-]{0,255}$/;
const sha256 = (value: string): string => createHash("sha256").update(value).digest("hex");
function unverified(field: string): never { throw new FilmChannelError("VIDEO_SUBMISSION_UNVERIFIED", `视频提交事实回执未核实：${field} 缺失或格式非法`); }
function mismatch(field: string): never { throw new FilmChannelError("VIDEO_SUBMISSION_MISMATCH", `视频提交事实回执未核实：${field} 与当前作业/请求/字节不一致`); }
function object(value: unknown, field: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return unverified(field);
  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) return unverified(field);
  return value as Record<string, unknown>;
}
function keys(value: Record<string, unknown>, required: readonly string[], optional: readonly string[] = [], field = "receipt"): void {
  if (required.some(key => !Object.hasOwn(value, key) || value[key] === undefined)
    || Object.keys(value).some(key => !required.includes(key) && !optional.includes(key))) unverified(field);
}
function text(value: unknown, field: string, max = 256): string {
  if (typeof value !== "string" || !value || value !== value.trim() || value.length > max || /[\x00-\x1f\x7f]/.test(value)) return unverified(field);
  return value;
}
/** Prompts are authored multiline content; hash their exact UTF-8 bytes. */
function promptText(value: unknown): string {
  if (typeof value !== "string" || !value.trim() || value.length > 30_000 || /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(value)) {
    return unverified("requestParams.prompt");
  }
  return value;
}
function hash(value: unknown, field: string): string {
  if (typeof value !== "string" || !HASH.test(value)) return unverified(field);
  return value;
}
function jobRef(value: unknown, field: string): string {
  const ref = text(value, field, 1000);
  if (ref.includes("\\") || ref.includes(":") || ref.startsWith("/")
    || ref.split("/").some(part => !part || part === "." || part === ".." || part !== part.trim())) return unverified(field);
  return ref;
}
function artifact(value: unknown): FilmVideoArtifactBinding {
  const row = object(value, "artifact");
  keys(row, ["ref", "sha256", "bytes"], [], "artifact");
  if (!Number.isSafeInteger(row.bytes) || Number(row.bytes) <= 0) return unverified("artifact.bytes");
  return { ref: jobRef(row.ref, "artifact.ref"), sha256: hash(row.sha256, "artifact.sha256"), bytes: row.bytes as number };
}
function references(value: unknown): FilmVideoReferenceInput[] {
  if (!Array.isArray(value)) return unverified("referenceInputs");
  let firstFrames = 0;
  return value.map((raw, index) => {
    const label = `referenceInputs[${index}]`;
    const row = object(raw, label);
    keys(row, ["role", "ref", "sha256", "hashKind"], ["requestUriSha256"], label);
    if (row.role !== "reference-image" && row.role !== "first-frame") return unverified(`${label}.role`);
    if (row.role === "first-frame" && ++firstFrames > 1) return unverified("referenceInputs.first-frame");
    const ref = text(row.ref, `${label}.ref`, 1000);
    const digest = hash(row.sha256, `${label}.sha256`);
    if (ASSET.test(ref)) {
      if (row.hashKind !== "asset-uri" || row.role !== "reference-image" || digest !== sha256(ref)
        || row.requestUriSha256 !== undefined) return unverified(`${label}.asset-uri`);
    } else {
      jobRef(ref, `${label}.ref`);
      if (row.hashKind !== "bytes") return unverified(`${label}.hashKind`);
    }
    if (row.requestUriSha256 !== undefined && row.role !== "first-frame") return unverified(`${label}.requestUriSha256`);
    return { role: row.role, ref, sha256: digest, hashKind: row.hashKind as FilmVideoReferenceInput["hashKind"],
      ...(row.requestUriSha256 === undefined ? {} : { requestUriSha256: hash(row.requestUriSha256, `${label}.requestUriSha256`) }) };
  });
}
function facts(value: unknown): FilmVideoSubmissionFacts {
  const row = object(value, "facts");
  keys(row, FACT_KEYS, [], "facts");
  if (typeof row.seconds !== "number" || !Number.isFinite(row.seconds) || row.seconds <= 0) return unverified("seconds");
  if (typeof row.generateAudio !== "boolean") return unverified("generateAudio");
  return {
    jobId: text(row.jobId, "jobId"), projectId: text(row.projectId, "projectId"), inputSha256: hash(row.inputSha256, "inputSha256"),
    shotId: text(row.shotId, "shotId"), stepKey: text(row.stepKey, "stepKey"), requestHash: hash(row.requestHash, "requestHash"),
    providerRequestHash: hash(row.providerRequestHash, "providerRequestHash"), taskId: text(row.taskId, "taskId"),
    artifact: artifact(row.artifact), promptSha256: hash(row.promptSha256, "promptSha256"), referenceInputs: references(row.referenceInputs),
    aspect: text(row.aspect, "aspect", 64), resolution: text(row.resolution, "resolution", 64), seconds: row.seconds, generateAudio: row.generateAudio,
  };
}

/** No I/O or signing occurs here. The parent supplies actual accepted/downloaded facts. */
export function buildFilmVideoSubmissionReceipt(input: FilmVideoSubmissionFacts): FilmVideoSubmissionReceipt {
  const checked = facts(input);
  const body = { schemaVersion: SCHEMA, ...checked };
  const receipt = { ...body, receiptHash: sha256(filmCanonicalJson(body)) };
  Object.freeze(receipt.artifact);
  for (const reference of receipt.referenceInputs) Object.freeze(reference);
  Object.freeze(receipt.referenceInputs);
  return Object.freeze(receipt);
}

function expectedFacts(value: FilmVideoSubmissionExpected): FilmVideoSubmissionFacts {
  const row = object(value, "expected");
  const required = [...FACT_KEYS.filter(key => key !== "requestHash" && key !== "providerRequestHash"), "requestParams"];
  keys(row, required, ["requestHash", "providerRequestHash"], "expected");
  const params = object(row.requestParams, "requestParams");
  for (const key of ["prompt", "refs", "seconds", "generateAudio", "aspect", "resolution", "targetRef"]) {
    if (!Object.hasOwn(params, key) || params[key] === undefined) unverified(`requestParams.${key}`);
  }
  let channelHash: string;
  try {
    channelHash = filmRequestHash({ method: "video.generate", stepKey: text(row.stepKey, "expected.stepKey"), shotId: text(row.shotId, "expected.shotId"), params });
  } catch (error) {
    if (error instanceof FilmChannelError && error.code.startsWith("VIDEO_SUBMISSION_")) throw error;
    return unverified("requestParams.JSON");
  }
  if (row.requestHash !== undefined && hash(row.requestHash, "expected.requestHash") !== channelHash) mismatch("expected.requestHash");
  const { requestParams: ignoredParams, requestHash: ignoredHash, providerRequestHash, ...bound } = row;
  void ignoredParams; void ignoredHash;
  const expected = facts({ ...bound, requestHash: channelHash, providerRequestHash: providerRequestHash === undefined ? "0".repeat(64) : hash(providerRequestHash, "expected.providerRequestHash") });
  if (sha256(promptText(params.prompt)) !== expected.promptSha256) mismatch("requestParams.prompt");
  if (jobRef(params.targetRef, "requestParams.targetRef") !== expected.artifact.ref) mismatch("requestParams.targetRef");
  for (const name of ["aspect", "resolution", "seconds", "generateAudio"] as const) {
    if (params[name] !== expected[name]) mismatch(`requestParams.${name}`);
  }
  if (!Array.isArray(params.refs) || !params.refs.every(ref => typeof ref === "string" && ref.length > 0)) unverified("requestParams.refs");
  const referenceRefs = expected.referenceInputs.filter(reference => reference.role === "reference-image").map(reference => reference.ref);
  if (filmCanonicalJson(params.refs) !== filmCanonicalJson(referenceRefs)) mismatch("requestParams.refs");
  const first = expected.referenceInputs.find(reference => reference.role === "first-frame");
  if (params.firstFrame === undefined) {
    if (first) mismatch("requestParams.firstFrame");
  } else {
    const frame = object(params.firstFrame, "requestParams.firstFrame");
    if (!first) mismatch("referenceInputs.first-frame");
    if (Object.hasOwn(frame, "ref")) {
      keys(frame, ["ref"], [], "requestParams.firstFrame");
      if (jobRef(frame.ref, "requestParams.firstFrame.ref") !== first.ref || first.requestUriSha256 !== undefined) mismatch("requestParams.firstFrame.ref");
    } else {
      keys(frame, ["hostedUrl"], [], "requestParams.firstFrame");
      const hostedUrl = text(frame.hostedUrl, "requestParams.firstFrame.hostedUrl", 8192);
      let url: URL;
      try { url = new URL(hostedUrl); } catch { return unverified("requestParams.firstFrame.hostedUrl"); }
      if (url.protocol !== "https:" || url.username || url.password || url.hash) unverified("requestParams.firstFrame.hostedUrl");
      if (!first.requestUriSha256) unverified("referenceInputs.first-frame.requestUriSha256");
      if (sha256(hostedUrl) !== first.requestUriSha256) mismatch("requestParams.firstFrame.hostedUrl");
    }
  }
  return expected;
}

/** Verify the IPC receipt against independently hashed current input/artifacts.
 * This cannot prove who signed a JSON document or what person appears in a clip.
 * The caller must take the receipt from the current parent IPC response, rather
 * than constructing one or reading an unrelated cached JSON file as authority.
 */
export function assertFilmVideoSubmissionReceipt(receipt: unknown, expected: FilmVideoSubmissionExpected): FilmVideoSubmissionReceipt {
  const row = object(receipt, "receipt");
  keys(row, ["schemaVersion", ...FACT_KEYS, "receiptHash"], [], "receipt");
  if (row.schemaVersion !== SCHEMA) unverified("schemaVersion");
  const { schemaVersion: ignoredSchema, receiptHash, ...rawFacts } = row;
  void ignoredSchema;
  const checked = buildFilmVideoSubmissionReceipt(facts(rawFacts));
  if (hash(receiptHash, "receiptHash") !== checked.receiptHash) {
    throw new FilmChannelError("VIDEO_SUBMISSION_TAMPERED", "视频提交事实回执未核实：receiptHash 与合同字节不一致");
  }
  const bound = expectedFacts(expected);
  for (const key of FACT_KEYS) {
    if (key === "providerRequestHash" && expected.providerRequestHash === undefined) continue;
    if (filmCanonicalJson(checked[key]) !== filmCanonicalJson(bound[key])) mismatch(key);
  }
  return checked;
}
