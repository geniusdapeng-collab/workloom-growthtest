/** Durable Ark task acceptance; resuming never sends another paid POST. */
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

const validTaskId = (value) => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(value);

export function readResumeTasks(file, knownShotIds) {
  if (!file) return {};
  const value = JSON.parse(readFileSync(file, 'utf8'));
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('RESUME_TASK_MAP_INVALID');
  const known = new Set(knownShotIds), used = new Set();
  for (const [shotId, taskId] of Object.entries(value)) {
    if (!known.has(shotId) || !validTaskId(taskId) || used.has(taskId)) throw new Error(`RESUME_TASK_MAP_INVALID: ${shotId}`);
    used.add(taskId);
  }
  return value;
}

function saveJournal(file, value) {
  mkdirSync(dirname(file), { recursive: true });
  const pending = `${file}.${randomUUID()}.pending`;
  writeFileSync(pending, JSON.stringify(value, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
  renameSync(pending, file);
}

/** Validate provider metadata before downloading an explicitly resumed task. */
export function verifyTaskResult(task, expected, taskId) {
  if (task.id !== taskId) throw new Error('RESUME_TASK_ID_MISMATCH');
  for (const key of ['model', 'duration', 'resolution', 'ratio']) {
    if (task[key] !== expected[key]) throw new Error(`RESUME_TASK_SPEC_MISMATCH: ${key}`);
  }
  if (!task.content?.video_url) throw new Error('RENDER_TASK_VIDEO_MISSING');
}

/**
 * Journal contains task ID and request digest only, never tokens, signed URLs or reference bytes.
 * Unknown POST outcomes are fail-closed. A caller must query the provider and supply the accepted ID.
 */
export async function runFilmRenderTask(options) {
  const { baseUrl, apiKey, body, journalFile, resumeTaskId, expected } = options;
  if (resumeTaskId && !validTaskId(resumeTaskId)) throw new Error('RESUME_TASK_ID_INVALID');
  const fetchImpl = options.fetchImpl ?? fetch;
  const sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  const now = options.now ?? Date.now;
  const requestHash = createHash('sha256').update(JSON.stringify(body)).digest('hex');
  let journal = existsSync(journalFile) ? JSON.parse(readFileSync(journalFile, 'utf8')) : null;
  if (journal && (journal.schemaVersion !== 'workloom.render-task/v1' || !['submission-unknown', 'accepted'].includes(journal.state))) {
    throw new Error('RENDER_TASK_JOURNAL_INVALID');
  }
  if (journal?.requestHash !== undefined && journal.requestHash !== requestHash && !resumeTaskId) throw new Error('RENDER_TASK_REQUEST_CHANGED');
  if (journal?.state === 'accepted' && !validTaskId(journal.taskId)) throw new Error('RENDER_TASK_JOURNAL_INVALID');
  if (resumeTaskId && journal?.taskId && journal.taskId !== resumeTaskId) throw new Error('RESUME_TASK_JOURNAL_CONFLICT');
  let taskId = resumeTaskId ?? journal?.taskId;
  const resumed = Boolean(taskId);
  let requestInputVerified = Boolean(journal?.state === 'accepted' && journal.submissionSource === 'local-submit' && journal.requestHash === requestHash);
  const boundRequestHash = journal?.requestHash ?? requestHash;
  let submissionSource = journal?.state === 'accepted' && journal.submissionSource === 'local-submit' ? 'local-submit' : 'provider-recovery';
  const persist = (state, acceptedId) => {
    // An accepted journal is the durable first acceptance, not a polling log.
    // GET recovery must preserve its bytes for already issued original receipts.
    if (state === 'accepted' && journal?.state === 'accepted' && journal.taskId === acceptedId
      && journal.requestHash === boundRequestHash && journal.submissionSource === submissionSource) return;
    journal = { schemaVersion: 'workloom.render-task/v1', state, requestHash: boundRequestHash, submissionSource,
      ...(acceptedId ? { taskId: acceptedId } : {}), updatedAt: new Date(now()).toISOString() };
    if (state === 'submission-unknown') {
      mkdirSync(dirname(journalFile), { recursive: true });
      // Exclusive creation prevents two processes from paying for the same shot concurrently.
      writeFileSync(journalFile, JSON.stringify(journal, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
    } else saveJournal(journalFile, journal);
  };
  if (!taskId) {
    if (journal) throw new Error('RENDER_SUBMISSION_OUTCOME_UNKNOWN: query provider tasks before retrying');
    // Only a new paid POST is guarded. Read-only recovery remains available for internal audit.
    await options.beforeSubmit?.();
    submissionSource = 'local-submit';
    persist('submission-unknown');
    const response = await fetchImpl(`${baseUrl}/contents/generations/tasks`, {
      method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
      body: JSON.stringify(body), signal: AbortSignal.timeout(120_000)
    });
    if (!response.ok) throw new Error(`RENDER_SUBMIT_HTTP_${response.status}: inspect provider before retrying`);
    const result = await response.json();
    taskId = result.id ?? result.data?.id;
    if (!validTaskId(taskId)) throw new Error('RENDER_SUBMIT_TASK_ID_MISSING');
    requestInputVerified = true;
  }
  // Persist acceptance before polling; a GET or download failure must never lose the paid task.
  persist('accepted', taskId);
  options.log?.(`${resumed ? '接续既有任务（GET）' : '平台已受理'}：${taskId}`);
  const deadline = now() + (options.timeoutMs ?? 20 * 60_000);
  let transientFailures = 0;
  while (now() < deadline) {
    let response;
    try {
      response = await fetchImpl(`${baseUrl}/contents/generations/tasks/${taskId}`, {
        headers: { authorization: `Bearer ${apiKey}` }, signal: AbortSignal.timeout(60_000)
      });
    } catch (error) {
      if (++transientFailures > 3) throw new Error(`RENDER_POLL_NETWORK_FAILED: ${taskId}`, { cause: error });
      options.log?.(`任务 ${taskId} 只读轮询暂时失败（${transientFailures}/3）`);
      await sleep(10_000); continue;
    }
    if (!response.ok) {
      if ((response.status === 429 || response.status >= 500) && ++transientFailures <= 3) {
        await sleep(10_000); continue;
      }
      throw new Error(`RENDER_POLL_HTTP_${response.status}: ${taskId}`);
    }
    transientFailures = 0;
    const result = await response.json();
    if (['succeeded', 'success'].includes(result.status)) {
      verifyTaskResult(result, expected, taskId);
      return { taskId, url: result.content.video_url, lastFrame: result.content.last_frame_url ?? null, resumed, requestInputVerified };
    }
    if (['failed', 'cancelled', 'expired'].includes(result.status)) throw new Error(`RENDER_TASK_${result.status.toUpperCase()}: ${taskId}`);
    if (!['queued', 'running', 'pending'].includes(result.status)) throw new Error(`RENDER_TASK_STATUS_INVALID: ${taskId}`);
    await sleep(10_000);
  }
  throw new Error(`RENDER_POLL_TIMEOUT: ${taskId}`);
}
