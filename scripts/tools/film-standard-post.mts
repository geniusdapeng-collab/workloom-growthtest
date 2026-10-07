/** Standard postproduction: immutable submitted originals; only four post layers are configurable. */
import { execFile, spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { constants, createReadStream } from "node:fs";
import { access, appendFile, copyFile, lstat, mkdir, open, readFile, readdir, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { embedCoverFirstFrame, type CoverVariantId } from "../../packages/video-studio/src/cover-assembly.js";
import { candidateSyncWindows, crossCorrelationLag } from "../../packages/video-studio/src/av-sync.js";
import { buildStandardPostContract, assertStandardPostTimeline, type StandardPostContract, type StandardOriginalRender } from "../../packages/video-studio/src/standard-post-contract.js";
import { buildFilmVideoSubmissionReceipt } from "../../packages/video-studio/src/film-worker-provenance.js";
import { isKnownCoverPlatform } from "../../packages/video-studio/src/cover-platforms.js";
import { COVER_FONTS } from "../../packages/video-studio/src/cover-design.js";
import { assessVariantAxes, assessVariantDistinctness, type VariantSample } from "../../packages/video-studio/src/deliver.js";

export class StandardPostError extends Error {
  constructor(readonly code: string, message: string, options?: ErrorOptions) { super(`${code}: ${message}`, options); this.name = "StandardPostError"; }
}
interface Stream { codec_type?: string; codec_name?: string; width?: number; height?: number; avg_frame_rate?: string;
  nb_read_frames?: string; duration?: string; sample_rate?: string; channels?: number; side_data_list?: Array<{ rotation?: number }> }
interface Media { streams: Stream[]; format: { duration?: string } }
export interface StandardPostOptions { repoRoot?: string; ffmpeg?: string; ffprobe?: string; timeoutMs?: number }
interface FileBinding { path: string; sha256: string; bytes: number }
interface OriginalRecord extends FileBinding { shotId: string; receiptFile: string; receiptSha256: string }
interface OriginalManifest {
  schemaVersion: "workloom.original-renders/v1"; projectId: string; productionRoot: string;
  submitted: { json: string; sha256: string; bytes: number }; originals: OriginalRecord[];
}
interface OriginalReceipt { schemaVersion: "workloom.original-render/v1"; projectId: string; shotId: string;
  submittedSha256: string; artifact: FileBinding; taskId: string; kind: "current-runtime-receipt" | "current-local-render-receipt" | "legacy-user-adopted";
  evidence: Record<string, unknown> }
export interface StandardPostSettings {
  schemaVersion: "workloom.standard-post-settings/v1";
  music: Array<FileBinding & { id: string }>;
  subtitles: Array<{ startSec: number; endSec: number; text: string }>;
  subtitleFontsRoot: string;
  cover: { sourceShotId: string; atSec: number; title: string; subtitle?: string; platform: string; fontFile: string; fontSha256: string; fontId?: string };
  versions: Array<{ id: "master" | CoverVariantId; profile: "none" | "natural" | "warm-film" | "cool-technical" | "high-contrast-social";
    intensity: number; musicSourceId?: string; musicLevelDb?: number; duckingDb?: number; musicBpm?: number }>;
}
interface InternalSource extends FileBinding { id: string; role: "original-render" | "existing-music" }
interface InternalPlan extends Omit<StandardPostSettings, "cover" | "schemaVersion"> {
  projectId: string; outputDir: string; allowedRoots: string[]; width: number; height: number; fps: number; durationSec: number;
  sources: InternalSource[]; cover: StandardPostSettings["cover"] & { sourceId: string };
}
interface PreparedSegment { segment: { id: string; durationSec: number }; path: string; timelineStartSec: number;
  sourceAudio: { sha256: string; bytes: number; sampleRate: 48000; channels: 2 }; sha256: string }
const fail = (code: string, message: string): never => { throw new StandardPostError(code, message); };
function ensure(value: unknown, message: string): asserts value { if (!value) fail("STANDARD_POST_INVALID", message); }
function object(value: unknown, label: string): Record<string, unknown> {
  ensure(value && typeof value === "object" && !Array.isArray(value), `${label} must be an object`); return value as Record<string, unknown>;
}
function keys(value: Record<string, unknown>, allowed: string[], label: string) { ensure(Object.keys(value).every(k => allowed.includes(k)), `${label} has unsupported fields`); }
const finite = (n: unknown, min: number, max: number): n is number => typeof n === "number" && Number.isFinite(n) && n >= min && n <= max;
const id = (s: unknown): s is string => typeof s === "string" && /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(s) && !s.includes("..");
const hash = (s: unknown): s is string => typeof s === "string" && /^[a-f0-9]{64}$/.test(s);
const localPath = (p: unknown): p is string => typeof p === "string" && isAbsolute(p) && !/[\0\r\n,]/.test(p) && resolve(p) === p;
const text = (t: unknown, max: number): t is string => typeof t === "string" && Boolean(t.trim()) && t.length <= max && !/[\0\r]/.test(t);
const within = (file: string, root: string): boolean => { const r = relative(root, file); return r === "" || (!isAbsolute(r) && r !== ".." && !r.startsWith(`..${sep}`)); };
const missing = (e: unknown) => (e as NodeJS.ErrnoException).code === "ENOENT";
const directMediaInput = (): string[] => ["-protocol_whitelist", "file,pipe", "-format_whitelist", "mov,matroska,avi,mpegts,wav,mp3,aac,flac,ogg,aiff"];
const digest = (bytes: Buffer | string) => createHash("sha256").update(bytes).digest("hex");
const manifestPath = (root: string, project: string) => join(root, "logs", project, "original-render-manifest.json");
const submittedPath = (root: string, project: string) => join(root, "logs", project, "submitted-original.json");
const receiptPath = (root: string, project: string, shot: string) => join(root, "logs", project, "original-issued", `${shot}.json`);
const sealPath = (root: string, project: string, shot: string) => join(root, "logs", project, "original-issued", `${shot}.seal.json`);
async function regular(path: string): Promise<string> {
  ensure(localPath(path), "expected a canonical absolute file path");
  try {
    const resolved = await realpath(path); ensure(resolved === path && (await lstat(path)).isFile(), "symlink, alias or non-file source refused"); return resolved;
  } catch (error) {
    if (error instanceof StandardPostError) throw error;
    const reason = (error as NodeJS.ErrnoException).code ?? (error as Error).message;
    throw new StandardPostError("STANDARD_POST_INVALID", `source unavailable: ${path} (${reason})`, { cause: error });
  }
}
async function pinned(path: string, expected?: FileBinding): Promise<FileBinding> {
  await regular(path); const bytes = (await stat(path)).size, sha256 = await standardPostFileHash(path);
  ensure(bytes > 0 && (!expected || path === expected.path && bytes === expected.bytes && sha256 === expected.sha256), "file bytes changed");
  return { path, bytes, sha256 };
}
async function readJson(path: string, max = 2 * 1024 * 1024): Promise<{ bytes: Buffer; value: Record<string, unknown> }> {
  await regular(path); const bytes = await readFile(path); ensure(bytes.length <= max, "JSON too large");
  let value: unknown; try { value = JSON.parse(bytes.toString("utf8")); } catch { return fail("STANDARD_POST_INVALID", "invalid JSON"); }
  return { bytes, value: object(value, "document") };
}
async function writeFrozen(path: string, bytes: Buffer | string) {
  await mkdir(dirname(path), { recursive: true });
  try { const handle = await open(path, "wx", 0o600); try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); } }
  catch (e) { if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e; await regular(path); ensure((await readFile(path)).equals(Buffer.from(bytes)), "previously frozen source differs; use a new project"); }
}
/** Separate first-issuance witness. A checksum is not a signature or provider/identity attestation. */
async function sealOriginal(root: string, receipt: OriginalReceipt, serialized: string) {
  await writeFrozen(sealPath(root, receipt.projectId, receipt.shotId), `${JSON.stringify({ schemaVersion: "workloom.original-issuance-witness/v1",
    projectId: receipt.projectId, shotId: receipt.shotId, submittedSha256: receipt.submittedSha256,
    receiptSha256: digest(serialized), artifact: receipt.artifact, taskId: receipt.taskId }, null, 2)}\n`);
}
/** Only acceptance facts are immutable; old adapters rewrote updatedAt on GET. */
function localAcceptedFacts(value: Record<string, unknown>) {
  keys(value, ["schemaVersion", "state", "requestHash", "submissionSource", "taskId", "updatedAt"], "local accepted journal");
  ensure(value.schemaVersion === "workloom.render-task/v1" && value.state === "accepted" && hash(value.requestHash)
    && text(value.taskId, 256) && (value.submissionSource === undefined || value.submissionSource === "local-submit" || value.submissionSource === "provider-recovery")
    && (value.updatedAt === undefined || typeof value.updatedAt === "string" && Number.isFinite(Date.parse(value.updatedAt))), "invalid local accepted facts");
  return { schemaVersion: value.schemaVersion, state: value.state, requestHash: value.requestHash,
    ...(value.submissionSource === undefined ? {} : { submissionSource: value.submissionSource }), taskId: value.taskId };
}
async function validateLocalAcceptedReceipt(root: string, receipt: OriginalReceipt) {
  const e = receipt.evidence, expected = join(root, "logs", receipt.projectId, "accepted-tasks", `${receipt.shotId}.json`);
  ensure(e.requestInputVerified === true && e.taskId === receipt.taskId && e.acceptedFile === expected
    && hash(e.acceptedSha256) && hash(e.requestHash), "local accepted render proof missing");
  const accepted = await readJson(expected), facts = localAcceptedFacts(accepted.value);
  ensure(facts.taskId === receipt.taskId && facts.requestHash === e.requestHash, "local accepted render journal changed");
  if (e.acceptedFactsSha256 !== undefined) {
    ensure(hash(e.acceptedFactsSha256) && digest(JSON.stringify(facts)) === e.acceptedFactsSha256, "local accepted facts changed");
  } else if (digest(accepted.bytes) !== e.acceptedSha256) {
    // Compatibility for an already sealed local receipt: keep its original byte
    // fingerprint, task, request and witness; only a valid local GET time may drift.
    ensure(facts.submissionSource === "local-submit" && typeof accepted.value.updatedAt === "string",
      "local accepted render journal changed");
  }
}
/** Called before any generation from the exact submitted byte document. Never reconstructed from mutable cards. */
export async function freezeOriginalSubmission(input: { productionRoot: string; projectId: string; bytes: Buffer }) {
  ensure(localPath(input.productionRoot) && id(input.projectId) && Buffer.isBuffer(input.bytes), "invalid submission freeze");
  const document = JSON.parse(input.bytes.toString("utf8")) as Record<string, unknown>;
  ensure(document.projectId === input.projectId && Array.isArray(document.shots) && document.shots.length > 0, "submitted project and shots required");
  await writeFrozen(submittedPath(input.productionRoot, input.projectId), input.bytes);
  return { json: input.bytes.toString("utf8"), sha256: digest(input.bytes), bytes: input.bytes.length };
}
/** Trusted generation adapters call immediately after their actual accepted download, before any post work. */
export async function issueOriginalRenderReceipt(input: { productionRoot: string; projectId: string; shotId: string; submittedSha256: string;
  artifactPath: string; taskId: string; requestInputVerified: boolean; submissionReceipt?: unknown; parentWorkDir?: string }) {
  ensure(id(input.projectId) && id(input.shotId) && hash(input.submittedSha256) && text(input.taskId, 256) && input.requestInputVerified === true, "accepted original generation proof required");
  const submitted = await readFile(await regular(submittedPath(input.productionRoot, input.projectId)));
  ensure(digest(submitted) === input.submittedSha256, "original receipt is for another submission");
  const artifact = await pinned(input.artifactPath); ensure(within(artifact.path, join(input.productionRoot, "clips", input.projectId)), "original render outside project clips");
  let evidence: Record<string, unknown> = { requestInputVerified: true, taskId: input.taskId };
  if (input.submissionReceipt !== undefined) {
    const raw = object(input.submissionReceipt, "parent receipt"), { schemaVersion, receiptHash, ...facts } = raw;
    const receipt = buildFilmVideoSubmissionReceipt(facts as unknown as Parameters<typeof buildFilmVideoSubmissionReceipt>[0]);
    ensure(schemaVersion === receipt.schemaVersion && receiptHash === receipt.receiptHash && receipt.inputSha256 === input.submittedSha256
      && receipt.projectId === input.projectId && receipt.shotId === input.shotId && receipt.taskId === input.taskId && receipt.generateAudio === true
      && receipt.artifact.sha256 === artifact.sha256 && receipt.artifact.bytes === artifact.bytes, "parent accepted-download receipt differs");
    const parentWorkDir = input.parentWorkDir ?? input.productionRoot;
    ensure(localPath(parentWorkDir) && await realpath(parentWorkDir) === parentWorkDir && within(input.productionRoot, parentWorkDir)
      && resolve(parentWorkDir, receipt.artifact.ref) === artifact.path, "parent artifact namespace differs from the accepted original");
    evidence = { submissionReceipt: receipt, parentWorkDir };
  } else {
    const acceptedFile = join(input.productionRoot, "logs", input.projectId, "accepted-tasks", `${input.shotId}.json`);
    const accepted = await readJson(acceptedFile);
    ensure(accepted.value.schemaVersion === "workloom.render-task/v1" && accepted.value.state === "accepted"
      && accepted.value.taskId === input.taskId && hash(accepted.value.requestHash), "current accepted render journal missing or different");
    evidence = { requestInputVerified: true, taskId: input.taskId, acceptedFile, acceptedSha256: digest(accepted.bytes), requestHash: accepted.value.requestHash,
      acceptedFactsSha256: digest(JSON.stringify(localAcceptedFacts(accepted.value))) };
  }
  const value: OriginalReceipt = { schemaVersion: "workloom.original-render/v1", projectId: input.projectId, shotId: input.shotId,
    submittedSha256: input.submittedSha256, artifact, taskId: input.taskId,
    kind: input.submissionReceipt === undefined ? "current-local-render-receipt" : "current-runtime-receipt", evidence };
  const serialized = `${JSON.stringify(value, null, 2)}\n`;
  const issuedFile = receiptPath(input.productionRoot, input.projectId, input.shotId);
  let exists = false;
  try { await lstat(issuedFile); exists = true; } catch (error) { if (!missing(error)) throw error; }
  if (exists) {
    const original = await readJson(issuedFile), first = original.value as unknown as OriginalReceipt;
    keys(original.value, ["schemaVersion", "projectId", "shotId", "submittedSha256", "artifact", "taskId", "kind", "evidence"], "issued receipt");
    ensure(first.schemaVersion === value.schemaVersion && first.projectId === value.projectId && first.shotId === value.shotId
      && first.submittedSha256 === value.submittedSha256 && first.taskId === value.taskId && first.kind === value.kind
      && JSON.stringify(first.artifact) === JSON.stringify(value.artifact), "first issued original differs from current accepted render");
    if (first.kind === "current-local-render-receipt") await validateLocalAcceptedReceipt(input.productionRoot, first);
    else ensure(JSON.stringify(first.evidence) === JSON.stringify(value.evidence), "first parent accepted download differs");
    await sealOriginal(input.productionRoot, first, original.bytes.toString("utf8"));
    return first;
  }
  await writeFrozen(receiptPath(input.productionRoot, input.projectId, input.shotId), serialized);
  await sealOriginal(input.productionRoot, value, serialized); return value;
}
/** Explicit historical adoption is a maintenance operation, never a public free-edit plan or identity approval. */
export async function adoptLegacyOriginalRenders(input: { productionRoot: string; submittedFile: string;
  authorization: { submittedSha256: string; originalSha256ByShot: Record<string, string>; reason: string } }) {
  const bytes = await readFile(await regular(input.submittedFile)), document = JSON.parse(bytes.toString("utf8")) as Record<string, unknown>;
  ensure(id(document.projectId) && digest(bytes) === input.authorization.submittedSha256 && text(input.authorization.reason, 4000), "explicit exact legacy adoption required");
  const project = document.projectId, submitted = await freezeOriginalSubmission({ productionRoot: input.productionRoot, projectId: project, bytes });
  const shots = document.shots as Array<Record<string, unknown>>;
  ensure(Object.keys(input.authorization.originalSha256ByShot).length === shots.length, "legacy adoption must cover exact shot set");
  const historyFile = join(input.productionRoot, "logs", project, "stages.jsonl"), historyBytes = await readFile(await regular(historyFile));
  const lines = historyBytes.toString("utf8").split(/\r?\n/).filter(Boolean);
  for (const shot of shots) {
    ensure(id(shot.shotId), "invalid original shot id"); const sid = shot.shotId;
    const raw = join(input.productionRoot, "clips", project, `${sid}.raw.mp4`), ordinary = join(input.productionRoot, "clips", project, `${sid}.mp4`);
    let path = raw; try { await lstat(raw); } catch (e) { if (!missing(e)) throw e; path = ordinary; }
    const artifact = await pinned(path); ensure(artifact.sha256 === input.authorization.originalSha256ByShot[sid], "legacy source differs from explicitly adopted original");
    const acceptedFile = join(input.productionRoot, "logs", project, "accepted-tasks", `${sid}.json`), accepted = await readJson(acceptedFile);
    ensure(accepted.value.schemaVersion === "workloom.render-task/v1" && accepted.value.state === "accepted" && text(accepted.value.taskId, 256), "legacy accepted task missing");
    let matched: { line: number; rowSha256: string } | undefined;
    for (const [index, line] of lines.entries()) {
      const row = JSON.parse(line) as Record<string, any>, lineage = row.lineage;
      if (row.shotId === sid && row.ok === true && row.degraded === false && ["shot", "material-gen"].includes(row.stage)
        && lineage?.projectId === project && lineage.status === "passed" && row.evidence?.taskId === accepted.value.taskId
        && lineage.outputs?.some((f: FileBinding) => f.path === path && f.sha256 === artifact.sha256 && f.bytes === artifact.bytes)) {
        matched = { line: index + 1, rowSha256: digest(line) }; break;
      }
    }
    ensure(matched, "historical original output and accepted task cannot be independently bound");
    const value: OriginalReceipt = { schemaVersion: "workloom.original-render/v1", projectId: project, shotId: sid, submittedSha256: submitted.sha256,
      artifact, taskId: String(accepted.value.taskId), kind: "legacy-user-adopted", evidence: { historyFile, ...matched,
        acceptedFile, acceptedSha256: digest(accepted.bytes), reason: input.authorization.reason,
        certification: "historical-byte-lineage-only-no-provider-payload-or-identity-certification" } };
    const serialized = `${JSON.stringify(value, null, 2)}\n`;
    await writeFrozen(receiptPath(input.productionRoot, project, sid), serialized); await sealOriginal(input.productionRoot, value, serialized);
  }
  return captureOriginalRenderManifest({ productionRoot: input.productionRoot, projectId: project });
}
export async function captureOriginalRenderManifest(input: { productionRoot: string; projectId: string }) {
  ensure(localPath(input.productionRoot) && id(input.projectId), "invalid original capture");
  const bytes = await readFile(await regular(submittedPath(input.productionRoot, input.projectId))), document = JSON.parse(bytes.toString("utf8")) as Record<string, any>;
  const originals: OriginalRecord[] = [];
  for (const shot of document.shots) {
    ensure(id(shot.shotId), "invalid shot id"); const receiptFile = receiptPath(input.productionRoot, input.projectId, shot.shotId), receipt = await readJson(receiptFile);
    const issued = receipt.value as unknown as OriginalReceipt;
    ensure(issued.projectId === input.projectId && issued.shotId === shot.shotId && issued.submittedSha256 === digest(bytes), "issued original differs from submitted shot");
    const artifact = await pinned(issued.artifact.path, issued.artifact);
    originals.push({ shotId: shot.shotId, ...artifact, receiptFile, receiptSha256: digest(receipt.bytes) });
  }
  const manifest: OriginalManifest = { schemaVersion: "workloom.original-renders/v1", projectId: input.projectId, productionRoot: input.productionRoot,
    submitted: { json: bytes.toString("utf8"), sha256: digest(bytes), bytes: bytes.length }, originals };
  const file = manifestPath(input.productionRoot, input.projectId); await writeFrozen(file, `${JSON.stringify(manifest, null, 2)}\n`); return file;
}
/** Public argument must name the issued canonical manifest. Facts are rebuilt from actual pinned files and receipts. */
export async function loadOriginalRenderManifest(file: string, options: StandardPostOptions = {}) {
  const { bytes, value } = await readJson(file); keys(value, ["schemaVersion", "projectId", "productionRoot", "submitted", "originals"], "manifest");
  const manifest = value as unknown as OriginalManifest;
  ensure(manifest.schemaVersion === "workloom.original-renders/v1" && id(manifest.projectId) && localPath(manifest.productionRoot)
    && file === manifestPath(manifest.productionRoot, manifest.projectId) && await realpath(manifest.productionRoot) === manifest.productionRoot, "only the canonical issued original manifest is supported");
  const source = await readFile(await regular(submittedPath(manifest.productionRoot, manifest.projectId)));
  ensure(manifest.submitted.json === source.toString("utf8") && manifest.submitted.sha256 === digest(source) && manifest.submitted.bytes === source.length, "frozen submission changed");
  const doc = JSON.parse(source.toString("utf8")) as Record<string, any>;
  ensure(Array.isArray(manifest.originals) && manifest.originals.length === doc.shots.length, "issued shot count changed");
  const originals: StandardOriginalRender[] = [];
  for (const [index, row] of manifest.originals.entries()) {
    keys(object(row, "original"), ["shotId", "path", "sha256", "bytes", "receiptFile", "receiptSha256"], "original");
    ensure(row.shotId === doc.shots[index].shotId && row.receiptFile === receiptPath(manifest.productionRoot, manifest.projectId, row.shotId), "issued original order or receipt path changed");
    const loaded = await readJson(row.receiptFile); ensure(digest(loaded.bytes) === row.receiptSha256, "issued receipt changed");
    const receipt = loaded.value as unknown as OriginalReceipt;
    keys(loaded.value, ["schemaVersion", "projectId", "shotId", "submittedSha256", "artifact", "taskId", "kind", "evidence"], "issued receipt");
    const witness = await readJson(sealPath(manifest.productionRoot, manifest.projectId, row.shotId));
    const w = witness.value;
    ensure(w.schemaVersion === "workloom.original-issuance-witness/v1" && w.projectId === manifest.projectId && w.shotId === row.shotId
      && w.submittedSha256 === manifest.submitted.sha256 && w.receiptSha256 === digest(loaded.bytes) && w.taskId === receipt.taskId
      && JSON.stringify(w.artifact) === JSON.stringify(receipt.artifact), "first-issuance witness differs; rehashed wrappers cannot replace originals");
    ensure(receipt.schemaVersion === "workloom.original-render/v1" && receipt.projectId === manifest.projectId && receipt.shotId === row.shotId
      && receipt.submittedSha256 === manifest.submitted.sha256 && receipt.artifact.path === row.path && receipt.artifact.sha256 === row.sha256 && receipt.artifact.bytes === row.bytes, "original receipt binding differs");
    const raw = join(manifest.productionRoot, "clips", manifest.projectId, `${row.shotId}.raw.mp4`), ordinary = join(manifest.productionRoot, "clips", manifest.projectId, `${row.shotId}.mp4`);
    let canonical = raw; try { await lstat(raw); } catch (e) { if (!missing(e)) throw e; canonical = ordinary; }
    ensure(row.path === canonical, "derived, voiced, alternate or aliased source refused"); await pinned(row.path, row);
    if (receipt.kind === "legacy-user-adopted") {
      const e = receipt.evidence, historyFile = join(manifest.productionRoot, "logs", manifest.projectId, "stages.jsonl");
      ensure(e.historyFile === historyFile && e.acceptedFile === join(manifest.productionRoot, "logs", manifest.projectId, "accepted-tasks", `${row.shotId}.json`), "legacy evidence path changed");
      const lines = (await readFile(await regular(historyFile), "utf8")).split(/\r?\n/).filter(Boolean), line = lines[Number(e.line) - 1];
      ensure(typeof line === "string" && digest(line) === e.rowSha256, "historical source row changed");
      const history = JSON.parse(line) as Record<string, any>, accepted = await readJson(String(e.acceptedFile));
      ensure(digest(accepted.bytes) === e.acceptedSha256 && accepted.value.schemaVersion === "workloom.render-task/v1" && accepted.value.state === "accepted" && accepted.value.taskId === receipt.taskId
        && history.shotId === row.shotId && ["shot", "material-gen"].includes(history.stage) && history.ok === true && history.degraded === false
        && history.lineage?.projectId === manifest.projectId && history.lineage?.status === "passed"
        && history.evidence?.taskId === receipt.taskId && history.lineage?.outputs?.some((f: FileBinding) => f.path === row.path && f.sha256 === row.sha256 && f.bytes === row.bytes), "legacy accepted output no longer binds source");
    } else if (receipt.kind === "current-runtime-receipt") {
      const rawReceipt = object(receipt.evidence.submissionReceipt, "parent receipt"), { schemaVersion, receiptHash, ...facts } = rawReceipt;
      const parent = buildFilmVideoSubmissionReceipt(facts as unknown as Parameters<typeof buildFilmVideoSubmissionReceipt>[0]);
      ensure(schemaVersion === parent.schemaVersion && receiptHash === parent.receiptHash && parent.projectId === manifest.projectId && parent.shotId === row.shotId
        && parent.inputSha256 === manifest.submitted.sha256 && parent.generateAudio === true && parent.taskId === receipt.taskId
        && parent.seconds === Number(doc.shots[index].duration ?? doc.shots[index].durationSec ?? doc.shots[index].durationSeconds)
        && typeof receipt.evidence.parentWorkDir === "string" && localPath(receipt.evidence.parentWorkDir)
        && within(manifest.productionRoot, receipt.evidence.parentWorkDir)
        && resolve(receipt.evidence.parentWorkDir, parent.artifact.ref) === row.path
        && parent.artifact.sha256 === row.sha256 && parent.artifact.bytes === row.bytes, "issued parent download changed");
    } else {
      ensure(receipt.kind === "current-local-render-receipt" && receipt.evidence.requestInputVerified === true && receipt.evidence.taskId === receipt.taskId,
        "original issuance missing");
      await validateLocalAcceptedReceipt(manifest.productionRoot, receipt);
    }
    const media = await probe(row.path, { ffprobe: options.ffprobe ?? "ffprobe" }, options.timeoutMs ?? 600_000), video = media.streams.filter(s => s.codec_type === "video"), audio = media.streams.filter(s => s.codec_type === "audio");
    ensure(video.length === 1 && audio.length === 1 && !video[0]!.side_data_list?.some(s => s.rotation), "one original video and native audio stream required");
    originals.push({ shotId: row.shotId, role: "original-render", path: row.path, sha256: row.sha256, bytes: row.bytes,
      media: { fps: rate(video[0]!), width: Number(video[0]!.width), height: Number(video[0]!.height), videoFrames: Number(video[0]!.nb_read_frames),
        videoDurationSec: Number(video[0]!.duration), audioDurationSec: Number(audio[0]!.duration), audioSampleRate: Number(audio[0]!.sample_rate), audioChannels: Number(audio[0]!.channels) },
      authority: { kind: receipt.kind, evidenceId: row.receiptFile, evidenceSha256: row.receiptSha256 } });
  }
  const contract = buildStandardPostContract({ projectId: manifest.projectId, submitted: manifest.submitted, originals }); assertStandardPostTimeline(contract, contract.timeline);
  return { ...contract, manifestSha256: digest(bytes), manifestFile: file, productionRoot: manifest.productionRoot, contract };
}
export function validateStandardPostSettings(input: unknown, contract: StandardPostContract): StandardPostSettings {
  const p = object(input, "settings"); keys(p, ["schemaVersion", "music", "subtitles", "subtitleFontsRoot", "cover", "versions"], "settings");
  ensure(p.schemaVersion === "workloom.standard-post-settings/v1" && localPath(p.subtitleFontsRoot), "invalid post settings");
  ensure(Array.isArray(p.music) && p.music.length <= 10, "music must be existing local files"); const music = new Set<string>();
  for (const row of p.music) { const m = object(row, "music"); keys(m, ["id", "path", "sha256", "bytes"], "music");
    ensure(id(m.id) && !music.has(m.id) && !contract.originals.some(s => s.shotId === m.id || s.path === m.path || s.sha256 === m.sha256)
      && localPath(m.path) && [".mp3", ".m4a", ".wav", ".flac", ".ogg", ".aiff"].includes(extname(m.path).toLowerCase())
      && !/\.(?:voiced|raw|ramped)(?:\.|$)/i.test(basename(m.path)) && hash(m.sha256) && Number.isSafeInteger(m.bytes) && Number(m.bytes) > 0, "invalid music binding"); music.add(m.id); }
  ensure(Array.isArray(p.subtitles) && p.subtitles.length > 0 && p.subtitles.length <= 1000, "subtitle cues required"); let end = 0;
  for (const row of p.subtitles) { const c = object(row, "subtitle"); keys(c, ["startSec", "endSec", "text"], "subtitle");
    ensure(finite(c.startSec, end, contract.durationSec) && finite(c.endSec, 0, contract.durationSec) && c.endSec > c.startSec && text(c.text, 200)
      && !/[{}\\]/.test(c.text) && [c.startSec, c.endSec].every(s => Math.abs(s * 100 - Math.round(s * 100)) < 1e-6), "invalid ordered subtitle cue"); end = c.endSec; }
  const c = object(p.cover, "cover"); keys(c, ["sourceShotId", "atSec", "title", "subtitle", "platform", "fontFile", "fontSha256", "fontId"], "cover");
  const source = contract.timeline.find(s => s.shotId === c.sourceShotId);
  ensure(source && finite(c.atSec, 0, source.durationSec) && c.atSec < source.durationSec && text(c.title, 80) && (c.subtitle === undefined || text(c.subtitle, 100))
    && typeof c.platform === "string" && isKnownCoverPlatform(c.platform) && localPath(c.fontFile) && hash(c.fontSha256)
    && (c.fontId === undefined || typeof c.fontId === "string" && Object.hasOwn(COVER_FONTS, c.fontId)), "invalid pinned original cover");
  ensure(Array.isArray(p.versions) && p.versions.length > 0 && p.versions.length <= 4, "master and at most three versions required"); const ids = new Set<string>();
  for (const row of p.versions) { const v = object(row, "version"); keys(v, ["id", "profile", "intensity", "musicSourceId", "musicLevelDb", "duckingDb", "musicBpm"], "version");
    ensure(["master", "warm-film", "cool-tech", "punchy-social"].includes(String(v.id)) && !ids.has(String(v.id)), "invalid duplicate version"); ids.add(String(v.id));
    ensure(["none", "natural", "warm-film", "cool-technical", "high-contrast-social"].includes(String(v.profile)) && (v.profile === "none" ? v.id === "master" && v.intensity === 0 : finite(v.intensity, 0.1, 1)), "invalid color recipe");
    if (v.musicSourceId !== undefined) ensure(typeof v.musicSourceId === "string" && music.has(v.musicSourceId) && finite(v.musicLevelDb, -40, -12) && finite(v.duckingDb, 4, 40) && finite(v.musicBpm, 20, 300), "invalid existing music recipe");
    else ensure(v.musicLevelDb === undefined && v.duckingDb === undefined && v.musicBpm === undefined, "music recipe has no source"); }
  ensure(ids.has("master"), "master required");
  const settings = structuredClone(p) as unknown as StandardPostSettings;
  const variants = settings.versions.filter(v => v.id !== "master"), scored = variants.filter(v => v.musicSourceId !== undefined);
  if (variants.length !== 3 || ["warm-film", "cool-tech", "punchy-social"].some(style => !ids.has(style))
    || new Set(variants.map(v => v.profile)).size !== 3 || scored.length !== 0 && scored.length !== 3)
    fail("STANDARD_POST_VARIANTS_INVALID", "delivery requires three distinct graded styles with music either enabled for all or explicitly absent for all");
  if (scored.length === 3 && new Set(scored.map(v => settings.music.find(m => m.id === v.musicSourceId)!.sha256)).size !== 3)
    fail("STANDARD_POST_VARIANTS_INVALID", "the three styles must use different actual music bytes, not aliases or different volume settings");
  return settings;
}
/** Reuse the established G-DLV1 axes with actual final cover and consumed-music receipts. */
export function assertStandardPostVariantAxes(settings: StandardPostSettings, outputs: readonly Record<string, unknown>[]) {
  const variants = settings.versions.filter(v => v.id !== "master"), bgmRequired = variants.some(v => v.musicSourceId !== undefined);
  const axes = variants.map(version => {
    const output = outputs.find(o => o.id === version.id);
    if (!output) return fail("STANDARD_POST_VARIANTS_INVALID", `${version.id}: final output missing`);
    const cover = object(object(output.coverReceipt, "final cover receipt").cover, "final cover binding"), coverSha = cover.sha256;
    if (!hash(coverSha)) return fail("STANDARD_POST_VARIANTS_INVALID", `${version.id}: final cover fingerprint missing`);
    let bgmSha: string | null = null;
    if (version.musicSourceId !== undefined) {
      const source = settings.music.find(m => m.id === version.musicSourceId), receipt = object(object(output.bgm, "final BGM receipt").bgm, "consumed music");
      if (!source) return fail("STANDARD_POST_VARIANTS_INVALID", `${version.id}: pinned BGM source missing`);
      if (receipt.sha256 !== source.sha256 || receipt.playedSha256 !== source.sha256)
        fail("STANDARD_POST_VARIANTS_INVALID", `${version.id}: consumed BGM differs from the pinned source`);
      bgmSha = source.sha256;
    }
    return { id: version.id, gradeProfile: version.profile, coverSha, bgmSha };
  });
  const report = assessVariantAxes(axes, { bgmRequired });
  if (!report.ok) fail("STANDARD_POST_VARIANTS_INVALID", report.detail);
  return report;
}
export async function standardPostFileHash(path: string): Promise<string> {
  const sha = createHash("sha256"); for await (const chunk of createReadStream(path)) sha.update(chunk); return sha.digest("hex");
}
export async function resolveStandardPostBinary(value: string): Promise<string> {
  if (typeof value !== "string" || !value.trim() || /[\0\r\n]/.test(value) || value.includes("://")) fail("STANDARD_POST_BINARY_INVALID", "expected a local executable");
  const names = process.platform === "win32" && !extname(value) ? [value + ".exe", value] : [value];
  const candidates = isAbsolute(value) ? [value] : value.includes(sep) ? []
    : (process.env.PATH ?? "").split(process.platform === "win32" ? ";" : ":").filter(isAbsolute).flatMap((p) => names.map((n) => join(p, n)));
  for (const candidate of candidates) {
    try { const path = await realpath(candidate); if (!(await stat(path)).isFile()) continue; await access(path, constants.X_OK); return path; }
    catch (e) { if (!missing(e) && (e as NodeJS.ErrnoException).code !== "EACCES") throw e; }
  }
  return fail("STANDARD_POST_BINARY_INVALID", `local executable unavailable: ${value}`);
}
async function run(binary: string, args: string[], timeout: number, env = process.env, cwd?: string): Promise<{ stdout: Buffer; stderr: string }> {
  return new Promise((accept, reject) => execFile(binary, args, { encoding: "buffer", timeout, maxBuffer: 256 * 1024 * 1024, env, cwd }, (error, stdout, stderr) => {
    if (error) reject(new StandardPostError("STANDARD_POST_PROCESS_FAILED", `${basename(binary)}: ${String(stderr).slice(-2400) || error.message}`));
    else accept({ stdout, stderr: String(stderr) });
  }));
}
async function probe(path: string, bins: { ffprobe: string }, timeout: number): Promise<Media> {
  let stdout: Buffer;
  try { ({ stdout } = await run(bins.ffprobe, ["-v", "error", ...directMediaInput(), "-count_frames", "-show_streams", "-show_format", "-of", "json", path], timeout)); }
  catch (error) { return fail("STANDARD_POST_MEDIA_INVALID", `direct media probe failed: ${(error as Error).message}`); }
  let doc: Media; try { doc = JSON.parse(stdout.toString()) as Media; } catch { return fail("STANDARD_POST_MEDIA_INVALID", "malformed media probe"); }
  if (!Array.isArray(doc.streams) || !doc.format || !finite(Number(doc.format.duration), 0.001, 7200)) fail("STANDARD_POST_MEDIA_INVALID", `incomplete media probe: ${path}`);
  return doc;
}
function rate(s: Stream): number { const [a, b] = String(s.avg_frame_rate).split("/").map(Number); return Number(a) / Number(b); }
async function pcm(path: string, ffmpeg: string, timeout: number): Promise<Float32Array> {
  const b = (await run(ffmpeg, ["-v", "error", ...directMediaInput(), "-i", path, "-map", "0:a:0", "-ar", "16000", "-ac", "1", "-f", "f32le", "-"], timeout)).stdout;
  return new Float32Array(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength));
}
/** Count real decoded samples without padding, truncating, or keeping the full PCM in memory. */
export async function assertStandardPostAudioClock(file: string, durationSec: number, options: StandardPostOptions = {}) {
  ensure(finite(durationSec, 0.001, 7200), "invalid original picture clock"); await regular(file);
  const ffmpeg = await resolveStandardPostBinary(options.ffmpeg ?? process.env.WL_FFMPEG ?? "ffmpeg");
  const timeout = options.timeoutMs ?? 600_000;
  ensure(Number.isSafeInteger(timeout) && timeout > 0 && timeout <= 900_000, "invalid audio decode timeout");
  const decoded = await new Promise<{ bytes: number; sha256: string }>((accept, reject) => {
    const child = spawn(ffmpeg, ["-v", "error", "-xerror", "-nostdin", ...directMediaInput(), "-i", file,
      "-map", "0:a:0", "-ar", "48000", "-ac", "2", "-c:a", "pcm_s16le", "-f", "s16le", "pipe:1"], { stdio: ["ignore", "pipe", "pipe"] });
    let bytes = 0, stderr = "", timedOut = false; const sha = createHash("sha256");
    const timer = setTimeout(() => { timedOut = true; child.kill("SIGKILL"); }, timeout);
    child.stdout.on("data", (chunk: Buffer) => { bytes += chunk.length; sha.update(chunk); });
    child.stderr.on("data", (chunk: Buffer) => { stderr = (stderr + chunk.toString()).slice(-2400); });
    child.on("error", (e) => { clearTimeout(timer); reject(new StandardPostError("STANDARD_POST_PROCESS_FAILED", e.message)); });
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      if (timedOut || code !== 0 || signal) reject(new StandardPostError("STANDARD_POST_PROCESS_FAILED", `audio decode ${timedOut ? "timed out" : `exit=${code}, signal=${signal ?? "none"}`}: ${stderr}`));
      else accept({ bytes, sha256: sha.digest("hex") });
    });
  });
  const samplesPerChannel = decoded.bytes / 4, requiredSamples = Math.round(durationSec * 48000);
  if (!Number.isSafeInteger(samplesPerChannel) || samplesPerChannel < requiredSamples)
    fail("STANDARD_POST_NATIVE_CLOCK_INCOMPLETE", `${basename(file)}: decoded ${samplesPerChannel} samples, original picture clock requires ${requiredSamples}`);
  return { ...decoded, sampleRate: 48000, channels: 2, samplesPerChannel, requiredSamples,
    codecBoundarySamples: samplesPerChannel - requiredSamples,
    basis: "Actual decoded samples cover the entire original picture clock. No artificial padding or relaxed threshold; codec priming/padding is separately observed." };
}
async function verifyComposedSourceSpeech(segments: PreparedSegment[], master: string, ffmpeg: string, timeout: number) {
  const audio = await pcm(master, ffmpeg, timeout); const observations = [];
  for (const s of segments) {
    const reference = await pcm(s.path, ffmpeg, timeout); let best: { lagMs: number; correlation: number } | undefined;
    for (const w of candidateSyncWindows({ durationSec: s.segment.durationSec })) {
      const length = Math.round(w.lengthSec * 16000), from = Math.round(w.startSec * 16000), expected = Math.round((s.timelineStartSec + w.startSec) * 16000);
      const search = 1600, begin = Math.max(0, expected - search), end = Math.min(audio.length, expected + length + search);
      if (from + length > reference.length || end - begin < length + 32) continue;
      const m = crossCorrelationLag(reference.subarray(from, from + length), audio.subarray(begin, end), { sampleRate: 16000, maxLagMs: 100 });
      const measured = { lagMs: m.lagMs - (expected - begin) / 16, correlation: m.correlation };
      if (!best || measured.correlation > best.correlation) best = measured;
    }
    if (!best || best.correlation < 0.98 || Math.abs(best.lagMs) > 10) fail("STANDARD_POST_SOURCE_SPEECH_UNVERIFIED", `${s.segment.id}: ${JSON.stringify(best ?? null)}`);
    observations.push({ segmentId: s.segment.id, ...best });
  }
  return { basis: "actual complete original-source PCM fingerprint and composed native audio timing correlation", sampleRate: 16000, maxLagMs: 10, minimumCorrelation: 0.98, observations,
    limit: "Verifies speech source and timing before BGM mastering; does not certify face identity, words or phonetic lipsync." };
}

interface LocalCore { [name: string]: (...args: unknown[]) => unknown }
async function loadCore(repo: string, connector: string): Promise<LocalCore> {
  return await import(pathToFileURL(join(repo, "bundles/ai-video/connectors", connector, "core.mjs")).href) as LocalCore;
}
function relocate(value: unknown, staging: string, output: string): unknown {
  if (typeof value === "string") return value.startsWith(staging + sep) || value === staging ? output + value.slice(staging.length) : value;
  if (Array.isArray(value)) return value.map((v) => relocate(v, staging, output));
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, relocate(v, staging, output)]));
  return value;
}
async function codeBinding(repo: string, timeout: number) {
  const paths = ["scripts/tools/full-chain-film.mts", "scripts/tools/film-standard-post.mts", "packages/video-studio/src/standard-post-contract.ts", "packages/video-studio/src/film-completion.mjs", "scripts/tools/film-audio-policy.mjs", "scripts/tools/compose-film.mts",
    "packages/video-studio/src/film-worker-provenance.ts", "packages/video-studio/src/film-worker-channel.ts", "packages/video-studio/src/production-lineage.ts",
    "packages/video-studio/src/local-cover-render.ts", "packages/video-studio/src/cover-design.ts", "packages/video-studio/src/cover-platforms.ts",
    "packages/video-studio/src/cover-assembly.ts", "packages/video-studio/src/av-sync.ts", "packages/video-studio/src/deliver.ts", "bundles/ai-video/library/root-list.mjs",
    "bundles/ai-video/library/font-catalog/font_db.json", "bundles/ai-video/library/typography-recipes/recipes.json", "bundles/ai-video/library/bgm-recipes/recipes.json",
    ...["color-bridge", "subtitle-bridge", "bgm-bridge"].map((x) => `bundles/ai-video/connectors/${x}/core.mjs`),
    ...["subtitle-bridge", "bgm-bridge"].map((x) => `bundles/ai-video/connectors/${x}/measure.mjs`),
    "bundles/ai-video/connectors/bgm-bridge/audio-stems.mjs", "bundles/ai-video/connectors/bgm-bridge/audio-stems-trust.mjs",
    ...["synth", "brief", "sources", "tag"].map(x => `bundles/ai-video/connectors/bgm-bridge/${x}.mjs`)];
  const files = await Promise.all(paths.map(async (path) => ({ path, sha256: await standardPostFileHash(join(repo, path)) })));
  try {
    const commit = (await run("git", ["-C", repo, "rev-parse", "HEAD"], timeout)).stdout.toString().trim();
    const dirty = (await run("git", ["-C", repo, "status", "--porcelain"], timeout)).stdout.length > 0;
    return { commit, workingTreeDirty: dirty, files, gitObserved: true };
  } catch (e) { return { commit: null, workingTreeDirty: null, files, gitObserved: false, reason: (e as Error).message }; }
}
async function relocateGeneratedReceipts(directory: string, staging: string, output: string) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) await relocateGeneratedReceipts(path, staging, output);
    else if (entry.isFile() && entry.name !== "post-settings.json" && /\.json$/.test(entry.name)) {
      const value = JSON.parse(await readFile(path, "utf8"));
      await writeFile(path, `${JSON.stringify(relocate(value, staging, output), null, 2)}\n`);
    }
  }
}

/** Fresh output directory is published only after all actual local work and source rechecks pass. */
export async function runStandardPost(manifestFile: string, settingsFile: string, outputDir: string, options: StandardPostOptions = {}) {
  const repo = resolve(options.repoRoot ?? join(import.meta.dirname, "../..")), timeout = options.timeoutMs ?? 600_000;
  ensure(Number.isSafeInteger(timeout) && timeout > 0 && timeout <= 900_000 && localPath(outputDir), "invalid options or output directory");
  const bytes = await readFile(await regular(settingsFile)); ensure(bytes.length <= 2 * 1024 * 1024, "settings too large");
  let parsed: unknown; try { parsed = JSON.parse(bytes.toString("utf8")); } catch { return fail("STANDARD_POST_INVALID", "invalid settings JSON"); }
  const bins = { ffmpeg: await resolveStandardPostBinary(options.ffmpeg ?? process.env.WL_FFMPEG ?? "ffmpeg"),
    ffprobe: await resolveStandardPostBinary(options.ffprobe ?? process.env.WL_FFPROBE ?? "ffprobe") };
  const binaries = await Promise.all(Object.entries(bins).map(async ([name, path]) => ({ name, path, sha256: await standardPostFileHash(path) })));
  const original = await loadOriginalRenderManifest(manifestFile, { ...options, ...bins }), contract = original.contract;
  const settings = validateStandardPostSettings(parsed, contract), planHash = digest(bytes);
  const plan: InternalPlan = { ...settings, projectId: contract.projectId, outputDir, width: contract.width, height: contract.height,
    fps: contract.fps, durationSec: contract.durationSec, allowedRoots: [original.productionRoot, ...settings.music.map(m => dirname(m.path))],
    cover: { ...settings.cover, sourceId: settings.cover.sourceShotId },
    sources: [...contract.originals.map(s => ({ id: s.shotId, path: s.path, sha256: s.sha256, bytes: s.bytes, role: "original-render" as const })),
      ...settings.music.map(m => ({ ...m, role: "existing-music" as const }))] };
  const frozen = new Map<string, { source: InternalSource; path: string; media: Media }>();
  for (const source of plan.sources) { await pinned(source.path, source); const media = await probe(source.path, bins, timeout);
    ensure(media.streams.some(s => s.codec_type === "audio"), "source native audio or music missing");
    if (source.role === "existing-music") ensure(!within(source.path, join(original.productionRoot, "clips"))
      && media.streams.filter(s => s.codec_type === "audio").length === 1 && !media.streams.some(s => s.codec_type === "video"), "BGM must be an audio-only music file outside generated clips");
    frozen.set(source.id, { source, path: source.path, media }); }
  const font = await regular(plan.cover.fontFile);
  if (await standardPostFileHash(font) !== plan.cover.fontSha256) fail("STANDARD_POST_FONT_CHANGED", "cover font SHA mismatch");
  await mkdir(dirname(plan.outputDir), { recursive: true });
  const parent = await realpath(dirname(plan.outputDir)), output = join(parent, basename(plan.outputDir));
  if (frozen.size && [...frozen.values()].some((s) => within(s.path, output)) || within(font, output)) fail("STANDARD_POST_OVERWRITE_FORBIDDEN", "output contains source files");
  try { await lstat(output); fail("STANDARD_POST_OUTPUT_EXISTS", output); } catch (error) { if (!missing(error)) throw error; }
  const lockPath = `${output}.standard-post.lock`;
  let lock; try { lock = await open(lockPath, "wx", 0o600); } catch (e) { return fail("STANDARD_POST_BUSY", (e as Error).message); }
  const staging = `${output}.staging-${randomUUID()}`;
  try { await mkdir(staging, { recursive: false }); }
  catch (e) { await lock.close(); await rm(lockPath, { force: true }); throw e; }
  const evidenceDir = join(staging, "evidence"), post = join(staging, "post"), inputDir = join(staging, "inputs");
  const records: unknown[] = [];
  const evidence = async (name: string, value: unknown) => { const relocated = relocate(value, staging, output); await writeFile(join(evidenceDir, `${name}.json`), `${JSON.stringify(relocated, null, 2)}\n`, { flag: "wx" }); return relocated; };
  const stage = async (name: string, action: () => Promise<unknown>) => {
    const start = Date.now(); try {
      const value = await action(), record = { stage: name, invoked: true, ok: true, elapsedMs: Date.now() - start, evidence: `${name}.json` };
      await evidence(name, value); records.push(record); await appendFile(join(evidenceDir, "stages.jsonl"), JSON.stringify(record) + "\n"); return value;
    } catch (e) {
      const record = { stage: name, invoked: true, ok: false, elapsedMs: Date.now() - start, code: (e as { code?: string }).code ?? "local_stage_failed", error: (e as Error).message };
      records.push(record); await appendFile(join(evidenceDir, "stages.jsonl"), JSON.stringify(record) + "\n"); throw e;
    }
  };
  try {
    await Promise.all([mkdir(evidenceDir), mkdir(post), mkdir(inputDir)]);
    await writeFile(join(staging, "post-settings.json"), bytes, { flag: "wx" });
    const code = await codeBinding(repo, timeout);
    const sources = new Map<string, string>();
    await stage("source-snapshot", async () => {
      const rows = [];
      for (const [sid, s] of frozen) {
        const snapshot = join(inputDir, sid + extname(s.path)); await copyFile(s.path, snapshot);
        if (await standardPostFileHash(snapshot) !== s.source.sha256) fail("STANDARD_POST_SOURCE_CHANGED", sid);
        sources.set(sid, snapshot); rows.push({ ...s.source, resolvedSource: s.path, snapshot, media: s.media });
      }
      return { planSha256: planHash, sources: rows, contractSha256: contract.contractSha256, sourceAuthority: contract.originals.map(s => s.authority), declaration: "Issued original sources independently rechecked; legacy byte lineage never certifies provider payload or identity." };
    });
    const subtitle = await loadCore(repo, "subtitle-bridge");
    const catalog = subtitle.loadFontCatalog!();
    const fonts = subtitle.scanFonts!({ catalog, root: plan.subtitleFontsRoot, verifySha: true }) as { total: number; verified: number; missing: string[]; entries: Array<{ absolutePath: string; sha256: string; sha256Matches: boolean }> };
    if (fonts.verified !== fonts.total || fonts.missing.length) fail("STANDARD_POST_FONT_CHANGED", "subtitle font bundle is incomplete or changed");
    await evidence("fonts", { ...fonts, coverFont: { path: font, sha256: plan.cover.fontSha256 } });
    const prepared: PreparedSegment[] = []; let cursor = 0;
    await stage("original-timeline", async () => {
      assertStandardPostTimeline(contract, contract.timeline);
      for (const entry of contract.timeline) {
        const path = entry.video.path;
        const native = (await run(bins.ffmpeg, ["-v", "error", "-nostdin", ...directMediaInput(), "-i", path,
          "-map", "0:a:0", "-ar", "48000", "-ac", "2", "-c:a", "pcm_s16le", "-f", "s16le", "-"], timeout)).stdout;
        prepared.push({ segment: { id: entry.shotId, durationSec: entry.durationSec }, path, timelineStartSec: cursor,
          sha256: entry.video.sha256, sourceAudio: { sha256: digest(native), bytes: native.length, sampleRate: 48000, channels: 2 } }); cursor += entry.durationSec;
      }
      return { contractSha256: contract.contractSha256, timeline: contract.timeline, sources: prepared,
        boundary: "Original presented audio follows each original picture clock. Decoder priming/padding is recorded; no editorial trim or retiming." };
    });
    const composed = join(post, "composed.mp4");
    await stage("compose", async () => {
      const actualTimeline = prepared.map(s => ({ shotId: s.segment.id,
        video: { path: s.path, sha256: s.sha256, bytes: contract.originals.find(o => o.shotId === s.segment.id)!.bytes, inSec: 0 },
        audio: { path: s.path, sha256: s.sha256, bytes: contract.originals.find(o => o.shotId === s.segment.id)!.bytes, inSec: 0 },
        durationSec: s.segment.durationSec, speed: 1 }));
      assertStandardPostTimeline(contract, actualTimeline);
      const rechecked = await loadOriginalRenderManifest(manifestFile, { ...options, ...bins });
      ensure(rechecked.manifestSha256 === original.manifestSha256 && rechecked.contract.contractSha256 === contract.contractSha256, "original sources drifted before composition");
      const argv = ["--import", "tsx", join(repo, "scripts/tools/compose-film.mts"), "--clips", prepared.map((s) => s.path).join(","), "--out", composed,
        "--width", String(plan.width), "--height", String(plan.height), "--fps", String(plan.fps), "--fade", "0", "--color", "none", "--native-clock", "--json"];
      const result = await run(process.execPath, argv, timeout, { ...process.env, WL_FFMPEG: bins.ffmpeg, WL_FFPROBE: bins.ffprobe }, repo);
      const avSync = JSON.parse(await readFile(composed.replace(/\.mp4$/, ".av-sync.json"), "utf8")) as { ok?: boolean };
      if (avSync.ok !== true) fail("STANDARD_POST_SOURCE_SPEECH_UNVERIFIED", "official compose AV sync did not pass");
      for (const originalSource of contract.originals) await pinned(originalSource.path, originalSource);
      return { tool: "scripts/tools/compose-film.mts", argv, actualTimeline, stdout: result.stdout.toString().slice(-8000), avSync, sourceSpeech: await verifyComposedSourceSpeech(prepared, composed, bins.ffmpeg, timeout), sha256: await standardPostFileHash(composed) };
    });
    const cues = plan.subtitles.map((c) => ({ start: subtitle.srtSecondsToAss!(c.startSec), end: subtitle.srtSecondsToAss!(c.endSec), text: subtitle.stripSubtitlePunctuation!(c.text) }));
    if (cues.some((c) => !String(c.text).trim())) fail("STANDARD_POST_PLAN_INVALID", "punctuation removal leaves an empty subtitle");
    const platform = plan.cover.platform === "wechat-channels" ? "视频号" : plan.cover.platform;
    const brief = { 平台: platform, 题材: "酒店自助设备", 调性: "清晰可信", 分辨率: [plan.width, plan.height] };
    const sidecars = await stage("subtitle-sidecars", () => Promise.resolve(subtitle.exportSidecars!({ input: composed, outputDir: join(staging, "subtitles"), name: plan.projectId,
      cues, platform, brief, bins, fontsDir: plan.subtitleFontsRoot, catalog, titleText: "", evidenceDir: join(evidenceDir, "subtitle-sidecars") }))) as { passed?: boolean; files: Array<{ path: string; format: string }> };
    if (sidecars.passed !== true) fail("STANDARD_POST_SUBTITLE_UNVERIFIED", "official subtitle sidecar checks failed");
    const color = await loadCore(repo, "color-bridge"), bgm = await loadCore(repo, "bgm-bridge");
    const coverModule = await import(pathToFileURL(join(repo, "packages/video-studio/src/local-cover-render.ts")).href) as { renderLocalCover: (o: Record<string, unknown>) => Promise<{ path: string; receipt: unknown }> };
    const outputs: Array<Record<string, unknown>> = [];
    const samples: VariantSample[] = [];
    const measureModule = await import(pathToFileURL(join(repo, "bundles/ai-video/connectors/bgm-bridge/measure.mjs")).href) as {
      measureLoudness: (file: string, options: { bins: typeof bins }) => Promise<{ integratedLufs: number; truePeakDbtp: number }> };
    const bgmEnv = { ...process.env, WORKLOOM_BGM_ALLOWED_ROOTS: [staging, ...plan.allowedRoots].join(sep === "\\" ? ";" : ":") };
    for (const version of plan.versions) {
      const label = version.id === "master" ? plan.projectId : `${plan.projectId}-variant-${version.id}`;
      const graded = join(post, `${version.id}-graded.mp4`), picture = join(post, `${version.id}-picture.mp4`);
      await stage(`color-${version.id}`, async () => {
        if (version.profile === "none") {
          await copyFile(composed, picture);
          const pictureSha256 = await standardPostFileHash(picture);
          if (pictureSha256 !== await standardPostFileHash(composed)) fail("STANDARD_POST_SOURCE_CHANGED", "picture copy differs from composition");
          return { mode: "original-composition-passthrough", graded: false, applicable: false, reason: "master explicitly preserves composed source picture", source: composed, pictureSha256 };
        }
        const report = await Promise.resolve(color.grade!({ input: composed, output: graded, profile: version.profile, intensity: version.intensity, bins, auto: false,
          verifyAt: [2, 7, 12, 18, 21, 26].filter((n) => n < plan.durationSec), defects: true, onUnfixable: "report" }));
        await run(bins.ffmpeg, ["-v", "error", "-n", ...directMediaInput(), "-i", graded, ...directMediaInput(), "-i", composed, "-map", "0:v:0", "-map", "1:a:0", "-c", "copy", "-movflags", "+faststart", picture], timeout);
        return { report, sourceAudioRestoredFrom: composed, pictureSha256: await standardPostFileHash(picture) };
      });
      let scored = picture; let mixReport: unknown = { layer: "off", reason: "no music requested", sourceAuthority: "declared-unverified", stemsVerified: false };
      if (version.musicSourceId) {
        scored = join(post, `${version.id}-scored.mp4`);
        mixReport = await stage(`bgm-${version.id}`, () => Promise.resolve(bgm.mix!({ input: picture, output: scored, bgmPath: sources.get(version.musicSourceId!), declaredProgramMix: true,
          env: bgmEnv, bins, policy: "keep-dialogue", musicLevelDb: version.musicLevelDb, duckingDb: version.duckingDb, targetLufs: -14, truePeak: -1.5,
          cutTimes: prepared.slice(1).map((s) => s.timelineStartSec), bgmBpm: version.musicBpm, bpmOverride: version.musicBpm, align: true, section: "full",
          evidenceDir: join(evidenceDir, `bgm-${version.id}-frames`), licenseReviewed: false, commercialUse: false })));
      }
      const burned = join(post, `${version.id}-subtitled.mp4`);
      await stage(`subtitle-burn-${version.id}`, () => Promise.resolve(subtitle.renderWithSubtitles!({ mode: "subtitle", input: scored, output: burned, cues, titleText: "",
        platform, brief, fontsDir: plan.subtitleFontsRoot, catalog, bins, evidenceDir: join(evidenceDir, `subtitle-${version.id}-frames`) })));
      const cover = join(staging, `${label}-cover.png`);
      await stage(`cover-${version.id}`, () => coverModule.renderLocalCover({ source: { kind: "video-frame", path: sources.get(plan.cover.sourceId)!, timeSec: plan.cover.atSec },
        title: plan.cover.title, subtitle: plan.cover.subtitle, platform: plan.cover.platform, variant: version.id === "master" ? "warm-film" : version.id,
        out: cover, width: plan.width, height: plan.height, fontFile: font, fontSha256: plan.cover.fontSha256, fontId: plan.cover.fontId,
        ffmpeg: bins.ffmpeg, ffprobe: bins.ffprobe, footageOrigin: "generated", durationSeconds: plan.durationSec, timeoutMs: Math.min(timeout, 600_000) }));
      const final = join(staging, `${label}.mp4`);
      const coverReceipt = await stage(`cover-assembly-${version.id}`, () => embedCoverFirstFrame({ input: burned, cover, output: final, ...bins, timeoutMs: Math.min(timeout, 600_000) }));
      const media = await probe(final, bins, timeout), video = media.streams.find((s) => s.codec_type === "video");
      if (Number(video?.nb_read_frames) !== Math.round(plan.durationSec * plan.fps) || rate(video!) !== plan.fps
        || Math.abs(Number(video?.duration) - plan.durationSec) > 0.000001) fail("STANDARD_POST_TIMELINE_CHANGED", version.id);
      await run(bins.ffmpeg, ["-v", "error", "-xerror", ...directMediaInput(), "-i", final, "-map", "0:v:0", "-map", "0:a:0", "-f", "null", "-"], timeout);
      const nativeAudioClock = await stage(`native-audio-clock-${version.id}`, () => assertStandardPostAudioClock(final, plan.durationSec, { ...bins, timeoutMs: timeout }));
      outputs.push({ id: version.id, path: final, sha256: await standardPostFileHash(final), bytes: (await stat(final)).size, media, cover, coverReceipt, bgm: mixReport, nativeAudioClock });
      if (version.id !== "master") {
        const frames = [];
        for (const fraction of [0.2, 0.5, 0.8]) {
          const bytes = (await run(bins.ffmpeg, ["-v", "error", "-nostdin", "-ss", String(plan.durationSec * fraction), ...directMediaInput(), "-i", final,
            "-frames:v", "1", "-vf", "scale=1:1", "-f", "rawvideo", "-pix_fmt", "rgb24", "pipe:1"], timeout)).stdout;
          if (bytes.length !== 3) fail("STANDARD_POST_VARIANTS_INVALID", `${version.id}: actual style sample missing`);
          frames.push({ r: bytes[0]!, g: bytes[1]!, b: bytes[2]! });
        }
        const loudness = await measureModule.measureLoudness(final, { bins });
        if (![loudness.integratedLufs, loudness.truePeakDbtp].every(Number.isFinite))
          fail("STANDARD_POST_VARIANTS_INVALID", `${version.id}: actual full audio measurement missing`);
        samples.push({ variantId: version.id, frames, loudness: { lufs: loudness.integratedLufs, peakDb: loudness.truePeakDbtp } });
      }
      if (version.id === "master") {
        const cleanWithCover = join(post, "master-clean-cover.mp4");
        await stage("clean-cover-assembly", () => embedCoverFirstFrame({ input: scored, cover, output: cleanWithCover, ...bins, timeoutMs: Math.min(timeout, 600_000) }));
        const soft = join(staging, `${plan.projectId}-softsub.mp4`), srt = sidecars.files.find((f) => f.format === "srt")?.path;
        if (!srt) fail("STANDARD_POST_SUBTITLE_UNVERIFIED", "official SRT missing");
        const receipt = await stage("soft-subtitle-mux", () => Promise.resolve(subtitle.softMux!({ input: cleanWithCover, output: soft, subtitles: [{ path: srt, lang: "chi", default: true }], bins, verify: true })));
        const nativeAudioClock = await stage("native-audio-clock-softsub", () => assertStandardPostAudioClock(soft, plan.durationSec, { ...bins, timeoutMs: timeout }));
        outputs.push({ id: "softsub", path: soft, sha256: await standardPostFileHash(soft), bytes: (await stat(soft)).size, receipt, nativeAudioClock });
      }
      for (const temporary of [graded, picture, scored, burned, join(post, "master-clean-cover.mp4")]) {
        if (temporary !== composed) await rm(temporary, { force: true });
      }
    }
    const variantAxes = await stage("variant-axes", async () => assertStandardPostVariantAxes(settings, outputs));
    const distinctness = await stage("variant-distinctness", async () => {
      const report = assessVariantDistinctness(samples);
      if (!report.approved) fail("STANDARD_POST_VARIANTS_INVALID", report.detail);
      return { ...report, samples, basis: "Existing G-DLV1 thresholds applied to actual final frame samples and complete audio loudness measurements" };
    });
    for (const s of frozen.values()) if ((await stat(s.path)).size !== s.source.bytes || await standardPostFileHash(s.path) !== s.source.sha256) fail("STANDARD_POST_SOURCE_CHANGED", s.source.id);
    if (await standardPostFileHash(font) !== plan.cover.fontSha256 || await standardPostFileHash(settingsFile) !== planHash) fail("STANDARD_POST_SOURCE_CHANGED", "settings or cover font changed during postproduction");
    const finalOriginal = await loadOriginalRenderManifest(manifestFile, { ...options, ...bins });
    ensure(finalOriginal.manifestSha256 === original.manifestSha256 && finalOriginal.contractSha256 === contract.contractSha256, "issued originals changed during postproduction");
    const finalFonts = subtitle.scanFonts!({ catalog, root: plan.subtitleFontsRoot, verifySha: true }) as typeof fonts;
    if (JSON.stringify(finalFonts.entries.map((e) => e.sha256)) !== JSON.stringify(fonts.entries.map((e) => e.sha256))) fail("STANDARD_POST_FONT_CHANGED", "subtitle fonts changed during editing");
    const finalCode = await codeBinding(repo, timeout);
    if (JSON.stringify(finalCode) !== JSON.stringify(code)) fail("STANDARD_POST_CODE_CHANGED", "consumed code, commit or working tree changed during editing");
    for (const binary of binaries) if (await standardPostFileHash(binary.path) !== binary.sha256) fail("STANDARD_POST_BINARY_CHANGED", binary.name);
    await relocateGeneratedReceipts(staging, staging, output);
    const manifest = relocate({ schemaVersion: "workloom.standard-post-delivery/v1", generatedAt: new Date().toISOString(), projectId: plan.projectId,
      mode: "original-native-standard-postproduction", planSha256: planHash, sourceCode: { ...code, currentCodeRechecked: true }, binaries,
      width: plan.width, height: plan.height, fps: plan.fps, durationSec: plan.durationSec, completion: contract.completion,
      supplierGenerationCalls: 0, modelCalls: 0, ttsCalls: 0, asrCalls: 0, sourceFilesUnchanged: true, speed: 1, frameSynthesis: false,
      scope: "Every frozen original shot in submitted order/full duration with its same-file native audio. Only color, music, cover and subtitles were added; identity remains unverified.",
      originalManifestSha256: original.manifestSha256, contractSha256: contract.contractSha256, originalTimeline: contract.timeline, sourceAuthority: contract.originals.map(s => s.authority),
      sourceFiles: plan.sources, originalSources: prepared, authoredSubtitles: plan.subtitles,
      subtitleAlignment: "Authored sentence timing using existing audio; no new ASR or phonetic timing proof", openingTitle: { source: "none", burned: false },
      musicLicenseReview: { reviewed: false, commercialUse: false, basis: "Private local derived delivery using existing music files. Existing source declarations are retained; no upstream per-track license verification is claimed." },
      outputs, variantAxes, distinctness, stages: records }, staging, output);
    await writeFile(join(staging, `${plan.projectId}-delivery-manifest.json`), `${JSON.stringify(manifest, null, 2)}\n`, { flag: "wx" });
    try { await lstat(output); fail("STANDARD_POST_OUTPUT_EXISTS", "output appeared while editing"); } catch (e) { if (!missing(e)) throw e; }
    await rename(staging, output);
    return manifest;
  } catch (e) {
    await writeFile(join(staging, "failed.json"), `${JSON.stringify({ status: "failed", code: (e as { code?: string }).code ?? "local_stage_failed", message: (e as Error).message,
      planSha256: planHash, stages: records, officialOutputPublished: false }, null, 2)}\n`);
    throw e;
  } finally { await lock.close(); await rm(lockPath, { force: true }); }
}
