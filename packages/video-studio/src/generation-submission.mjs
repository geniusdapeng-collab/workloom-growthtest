/** One durable paid submission. Accepted responses are recovered locally; unknown outcomes never retry. */
import { createHash, randomUUID } from 'node:crypto';
import { closeSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

const schemaVersion = 'workloom.generation-submission/v1';
const sha = value => createHash('sha256').update(value).digest('hex');
const record = value => value && typeof value === 'object' && !Array.isArray(value);
export const generationRequestHash = (endpoint, body) => sha(JSON.stringify({ endpoint, body }));

export class GenerationSubmissionError extends Error {
  constructor(code, acceptance = 'unknown', options = {}) {
    super(code, options.cause ? { cause: options.cause } : undefined);
    this.name = 'GenerationSubmissionError'; this.acceptance = acceptance;
    this.called = options.called === true;
  }
}

/** HTTP alone does not prove non-acceptance. Require a structured, explicit provider rejection without an output. */
export function isDefiniteGenerationRejection(status, text) {
  if (![400, 401, 403, 404, 422].includes(status)) return false;
  let value; try { value = JSON.parse(text); } catch { return false; }
  if (!record(value) || value.id || value.data?.id || Array.isArray(value.data) && value.data.length || value.content?.video_url) return false;
  const code = value.error?.code;
  return typeof code === 'string' && /^(InvalidParameter|MissingParameter|InvalidArgument|BadRequest|Validation|Authentication|Unauthorized|Forbidden|PermissionDenied|AccessDenied|NotFound|ResourceNotFound|AccountOverdue|InputImageSensitiveContentDetected|SensitiveContent|ContentPolicyViolation)/i.test(code);
}

function ensureDirectory(dir) {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const info = lstatSync(dir);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new GenerationSubmissionError('GENERATION_JOURNAL_DIRECTORY_INVALID');
}
function readJournal(file) {
  if (!existsSync(file)) return null;
  const info = lstatSync(file);
  if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || info.size > 4 * 1024 * 1024) throw new GenerationSubmissionError('GENERATION_JOURNAL_INVALID');
  let value; try { value = JSON.parse(readFileSync(file, 'utf8')); } catch (cause) { throw new GenerationSubmissionError('GENERATION_JOURNAL_INVALID', 'unknown', { cause }); }
  if (!record(value) || value.schemaVersion !== schemaVersion || !['submission-unknown', 'accepted', 'rejected'].includes(value.state)
    || !/^[a-f0-9]{64}$/.test(value.requestHash ?? '') || !Number.isFinite(Date.parse(value.startedAt))) throw new GenerationSubmissionError('GENERATION_JOURNAL_INVALID');
  if (value.state !== 'submission-unknown' && (!Number.isInteger(value.status) || typeof value.responseText !== 'string'
    || value.responseSha256 !== sha(value.responseText) || !Number.isFinite(Date.parse(value.receivedAt)))) throw new GenerationSubmissionError('GENERATION_JOURNAL_INVALID');
  if (value.state === 'accepted' && (value.status < 200 || value.status >= 300)
    || value.state === 'rejected' && !isDefiniteGenerationRejection(value.status, value.responseText)) throw new GenerationSubmissionError('GENERATION_JOURNAL_INVALID');
  return value;
}
function writeDurably(file, value, exclusive = false) {
  const pending = exclusive ? file : `${file}.${randomUUID()}.pending`;
  let fd;
  try {
    fd = openSync(pending, 'wx', 0o600);
    writeFileSync(fd, JSON.stringify(value, null, 2) + '\n'); fsyncSync(fd);
  } finally { if (fd !== undefined) closeSync(fd); }
  if (!exclusive) {
    try { renameSync(pending, file); } finally { if (existsSync(pending)) unlinkSync(pending); }
  }
}
const responseOf = journal => new Response(journal.responseText, { status: journal.status, headers: { 'content-type': 'application/json' } });
/** Metadata only: select a previously accepted request from the caller's explicitly allowed input variants. */
export function readGenerationSubmissionState(file) {
  const value = readJournal(file);
  return value ? { state: value.state, requestHash: value.requestHash, endpoint: value.endpoint } : null;
}

/**
 * The journal is local private execution state (0600), including temporary media access URLs for GET recovery.
 * It stores neither headers/credentials nor request/reference bytes. Do not publish or commit it.
 * Only an explicit rejection permits a later paid attempt; a lock is never stolen after a crash.
 */
export async function submitGenerationOnce(options) {
  const { endpoint, body, journalFile } = options;
  if (typeof journalFile !== 'string' || !journalFile.trim() || typeof body !== 'string') throw new GenerationSubmissionError('GENERATION_SUBMISSION_CONFIG_INVALID');
  let url; try { url = new URL(endpoint); } catch { throw new GenerationSubmissionError('GENERATION_ENDPOINT_INVALID'); }
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) throw new GenerationSubmissionError('GENERATION_ENDPOINT_INVALID');
  const file = resolve(journalFile), dir = dirname(file);
  ensureDirectory(dir);
  const requestHash = generationRequestHash(endpoint, body);
  const recover = prior => {
    if (!prior) return null;
    if (prior.state === 'rejected') return null;
    if (prior.requestHash !== requestHash || prior.endpoint !== endpoint) throw new GenerationSubmissionError('GENERATION_REQUEST_CHANGED');
    if (prior.state === 'submission-unknown') throw new GenerationSubmissionError('GENERATION_SUBMISSION_OUTCOME_UNKNOWN: reconcile provider before another POST');
    return { response: responseOf(prior), acceptance: 'accepted', resumed: true, called: false, requestHash };
  };
  // Acceptance persisted before a crash remains recoverable even if its process left the lock behind.
  const cached = recover(readJournal(file)); if (cached) return cached;
  const lock = `${file}.lock`, owner = randomUUID(); let acquired = false;
  try {
    try { writeFileSync(lock, owner, { flag: 'wx', mode: 0o600 }); acquired = true; }
    catch (cause) { throw new GenerationSubmissionError('GENERATION_SUBMISSION_BUSY: no duplicate POST sent', 'unknown', { cause }); }
    const prior = readJournal(file), raced = recover(prior); if (raced) return raced;
    await options.beforeSubmit?.();
    const journal = { schemaVersion, state: 'submission-unknown', requestHash, endpoint, startedAt: new Date().toISOString(),
      ...(prior ? { rejectedAttempts: [...(prior.rejectedAttempts ?? []), { requestHash: prior.requestHash, status: prior.status, receivedAt: prior.receivedAt }].slice(-100) } : {}) };
    writeDurably(file, journal, !prior);
    let response, text;
    try {
      response = await (options.fetchImpl ?? fetch)(endpoint, { method: 'POST', headers: options.headers, body,
        signal: AbortSignal.timeout(options.timeoutMs ?? 120_000) });
      text = await response.text();
    } catch (cause) { throw new GenerationSubmissionError('GENERATION_SUBMISSION_OUTCOME_UNKNOWN: network/response failed; reconcile provider', 'unknown', { cause, called: true }); }
    if (text.length > 3 * 1024 * 1024) throw new GenerationSubmissionError('GENERATION_RESPONSE_TOO_LARGE: reconcile provider', 'unknown', { called: true });
    const credential = new Headers(options.headers).get('authorization')?.replace(/^Bearer\s+/i, '');
    if (credential && text.includes(credential)) throw new GenerationSubmissionError('GENERATION_RESPONSE_CONTAINS_CREDENTIAL: response not persisted; reconcile provider', 'unknown', { called: true });
    const acceptance = response.ok ? 'accepted' : isDefiniteGenerationRejection(response.status, text) ? 'rejected' : 'unknown';
    if (acceptance === 'unknown') throw new GenerationSubmissionError(`GENERATION_SUBMISSION_OUTCOME_UNKNOWN: HTTP ${response.status}; reconcile provider`, 'unknown', { called: true });
    // Do not parse output IDs or download until the full first response is durably captured.
    writeDurably(file, { ...journal, state: acceptance, status: response.status, responseText: text, responseSha256: sha(text), receivedAt: new Date().toISOString() });
    return { response: new Response(text, { status: response.status, headers: { 'content-type': 'application/json' } }), acceptance, resumed: false, called: true, requestHash };
  } finally {
    if (acquired) {
      if (lstatSync(lock).isSymbolicLink() || readFileSync(lock, 'utf8') !== owner) throw new GenerationSubmissionError('GENERATION_SUBMISSION_LOCK_CHANGED');
      unlinkSync(lock);
    }
  }
}
