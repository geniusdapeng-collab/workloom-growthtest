/** Read-only rendering acceptance ledger shared by the CLI and capability transport. */
const renderStages = new Set(['material-gen', 'shot']);
const postStages = new Set(['compose', 'color', 'subtitle', 'danmaku', 'bgm', 'sfx', 'cover', 'mux', 'master', 'deliver']);
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);

export function isAcceptedFilmTaskId(value) {
  return typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(value);
}

function reasonFor(row) {
  const evidence = record(row.evidence) ? row.evidence : {};
  const verdict = record(row.verdict) ? row.verdict : {};
  const hard = Array.isArray(verdict.hardFailures) ? verdict.hardFailures[0] : null;
  return String(hard ?? verdict.reason ?? row.note ?? evidence.reason ?? evidence.error ?? '').slice(0, 240);
}

/**
 * A valid provider task ID is acceptance evidence. Repeated, resumed and cached rows
 * for that ID are one task, and the latest recorded outcome supersedes earlier failures.
 * Records without an accepted ID are reported as unknown; an invocation is not a paid task.
 * This reports recorded acceptance and outcomes, never billing or lip-sync quality.
 */
export function buildFilmRenderLedger(history, { projectId = '', generatedAt = new Date().toISOString() } = {}) {
  if (!Array.isArray(history) || history.some(row => !record(row))) throw new Error('RENDER_LEDGER_HISTORY_INVALID');
  const byShot = new Map();
  const byTask = new Map();
  const byPost = new Map();
  let unacceptedRenderRecords = 0;
  const warnings = [];
  const shotEntry = shotId => {
    let entry = byShot.get(shotId);
    if (!entry) {
      entry = { shotId, attempts: 0, rejected: 0, lastReason: null, platformRejections: 0, canaryAborts: 0 };
      byShot.set(shotId, entry);
    }
    return entry;
  };
  for (const row of history) {
    const stage = String(row.stage ?? '');
    const evidence = record(row.evidence) ? row.evidence : {};
    const reason = reasonFor(row);
    if (renderStages.has(stage)) {
      const shotId = typeof row.shotId === 'string' && row.shotId.trim() ? row.shotId : '(unassigned)';
      if (isAcceptedFilmTaskId(evidence.taskId)) {
        const previous = byTask.get(evidence.taskId);
        if (previous && previous.shotId !== shotId && shotId !== '(unassigned)' && previous.shotId !== '(unassigned)') {
          warnings.push(`任务 ${evidence.taskId} 在账本关联多个镜头：${previous.shotId} / ${shotId}`);
        }
        const assignedShot = previous?.shotId && previous.shotId !== '(unassigned)' ? previous.shotId : shotId;
        byTask.set(evidence.taskId, { taskId: evidence.taskId, shotId: assignedShot,
          ok: typeof row.ok === 'boolean' ? row.ok : previous?.ok ?? null,
          reason: row.ok === false ? reason || previous?.reason || null : row.ok === true ? null : previous?.reason ?? null });
      } else if (row.invoked === true && row.cached !== true && evidence.resumed !== true) {
        const entry = shotEntry(shotId);
        const error = String(evidence.error ?? '');
        if (/AccountOverdue|quota|限额|insufficient/iu.test(error)) entry.platformRejections += 1;
        else if (error.startsWith('CANARY_ABORT')) entry.canaryAborts += 1;
        else unacceptedRenderRecords += 1;
      }
      continue;
    }
    if (postStages.has(stage) && row.invoked === true && row.ok === false && row.cached !== true) {
      const entry = byPost.get(stage) ?? { stage, retries: 0, lastReason: null };
      entry.retries += 1;
      entry.lastReason = reason || entry.lastReason;
      byPost.set(stage, entry);
    }
  }
  for (const task of byTask.values()) {
    const entry = shotEntry(task.shotId);
    entry.attempts += 1;
    if (task.ok === false) {
      entry.rejected += 1;
      entry.lastReason = task.reason || entry.lastReason;
    }
  }
  const shots = [...byShot.values()].sort((a, b) => a.shotId.localeCompare(b.shotId));
  const posts = [...byPost.values()].sort((a, b) => a.stage.localeCompare(b.stage));
  return {
    generatedAt, projectId,
    totals: {
      renderAttempts: byTask.size,
      rendersRejected: [...byTask.values()].filter(task => task.ok === false).length,
      platformRejections: shots.reduce((sum, entry) => sum + entry.platformRejections, 0),
      canaryAborts: shots.reduce((sum, entry) => sum + entry.canaryAborts, 0),
      postStageRetries: posts.reduce((sum, entry) => sum + entry.retries, 0),
    },
    shots, postStages: posts,
    acceptedTaskIds: [...byTask.keys()].sort(),
    unacceptedRenderRecords,
    warnings: [...new Set(warnings)],
    notes: [
      '口径：material-gen / shot 中带有效平台 taskId 的记录按任务 ID 去重；GET 接续、缓存和重复记账不新增受理次数。',
      '受理后未通过按同一任务最近一次已记录结果计数；下载或审查失败不等于新渲染，也不据此断言平台计费。',
      `没有有效任务 ID 的调用记录：${unacceptedRenderRecords} 条，受理状态未知，不计为渲染次数；平台拒收与 canary 中止另外列出。`,
      '只记已记录事实，不做费用估算，也不把台账当作画面、口型或身份质量证明。',
    ],
  };
}
