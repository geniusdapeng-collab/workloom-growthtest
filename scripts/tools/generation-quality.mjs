/** Technical quality for actual local generation post-processing and immutable releases.
 * Source snapshots are captured before processors run. A manifest or a caller's
 * passed flag can never create a processing receipt. No model/provider is called.
 */
import { createHash, randomUUID } from 'node:crypto';
import { constants, copyFileSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { POST_QUALITY_STAGES, inspectPostQuality, assertPostQuality, writePostQuality, writeProcessingProof, verifyProcessingProof } from '../../bundles/ai-video/connectors/post-bridge/quality-gate.mjs';
import { probeMedia } from '../../bundles/ai-video/connectors/subtitle-bridge/measure.mjs';

export const GENERATION_QUALITY_SCHEMA = 'workloom.generation-quality/v1';
const hashJson = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const validHash = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const within = (root, file) => { const rel = path.relative(root, file); return rel === '' || !path.isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${path.sep}`); };
const errorMessage = error => error instanceof Error ? error.message : String(error);
const serial = value => JSON.parse(JSON.stringify(value));
export class GenerationQualityError extends Error {
  constructor(message, report = null) { super(message); this.name = 'GenerationQualityError'; this.code = 'generation_quality_failed'; this.retryable = false; this.report = report; }
}
export function generationFileSha256(file) {
  const before = statSync(file);
  if (!before.isFile() || before.size < 1) throw new GenerationQualityError(`非空常规文件缺失：${file}`);
  const result = createHash('sha256').update(readFileSync(file)).digest('hex');
  const after = statSync(file);
  if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs)
    throw new GenerationQualityError(`读取期间文件变化：${file}`);
  return result;
}
const mediaType = file => /\.(srt|ass|vtt)$/i.test(file) ? 'subtitle' : /\.json$/i.test(file) ? 'json'
  : /\.(png|jpe?g|webp|gif)$/i.test(file) ? 'image' : /\.(mp4|mkv|mov|avi|webm)$/i.test(file) ? 'video' : 'text';
const stageFor = name => ({ enhance: 'resolution', 'rhythm-edit': 'resolution', compose: 'transitions', color: 'color', subtitle: 'subtitles', mux: 'subtitles',
  danmaku: 'danmaku', bgm: 'bgm', sfx: 'bgm', cover: 'cover', 'cover-intro': 'cover', master: 'resolution' })[name] ?? null;
const cliFlag = (args, flag) => { const i = args.indexOf(flag); return i < 0 ? null : args[i + 1] ?? null; };
function exactFile(root, file) {
  const resolved = path.resolve(root, file);
  if (!within(root, resolved) || !within(realpathSync(root), realpathSync(resolved)) || !lstatSync(resolved).isFile()) throw new GenerationQualityError(`加工资产越过根目录或不是常规文件：${file}`);
  return resolved;
}
function executionChecks(report) {
  const checks = report?.checks;
  if (Array.isArray(checks)) return checks.filter(row => typeof (row.ok ?? row.pass) === 'boolean').map(row => ({ kind: row.kind, ok: (row.ok ?? row.pass) === true, hard: row.hard !== false }));
  if (checks && typeof checks === 'object') return Object.entries(checks).filter(([, value]) => typeof value === 'boolean').map(([kind, ok]) => ({ kind, ok, hard: true }));
  return [];
}
function cueCount(report, args) {
  const value = report?.timeline?.cues ?? report?.timeline?.sourceCues ?? report?.manifest?.timeline?.cues ?? report?.density?.kept;
  if (Number.isInteger(value) && value > 0) return value;
  const file = cliFlag(args, '--srt');
  if (file && existsSync(file)) return (readFileSync(file, 'utf8').match(/-->/g) ?? []).length;
  const items = cliFlag(args, '--items');
  if (items && existsSync(items)) { const values = JSON.parse(readFileSync(items, 'utf8')); return Array.isArray(values) ? values.length : 0; }
  return 0;
}
function collectReportOutputs(report) {
  const result = [];
  for (const value of [report?.output, report?.output?.path, report?.outputDir, ...(report?.files ?? []).map(file => file.path)]) {
    if (typeof value === 'string' && existsSync(value) && statSync(value).isFile()) result.push(value);
  }
  return [...new Set(result)];
}

/** Host-side lifecycle; every begin token is exclusive to one successful call. */
export function createGenerationQuality({ root, bins, enabled = true } = {}) {
  const base = path.resolve(root), active = new Map(), pending = [], deferredErrors = [], descriptors = [], sourceBindings = new Map(), completedOutputs = new Map();
  if (enabled) mkdirSync(base, { recursive: true });
  const snapshot = (file, expected = null) => {
    const source = path.resolve(file), original = realpathSync(source), sha256 = generationFileSha256(source);
    if (expected && sha256 !== expected) throw new GenerationQualityError(`调用前来源摘要不符：${file}`);
    const extension = path.extname(source).slice(0, 12), target = path.join(base, 'quality', 'snapshots', `${sha256}${extension}`);
    mkdirSync(path.dirname(target), { recursive: true });
    if (!existsSync(target)) copyFileSync(source, target, constants.COPYFILE_EXCL);
    if (generationFileSha256(target) !== sha256 || generationFileSha256(source) !== sha256 || realpathSync(source) !== original)
      throw new GenerationQualityError(`调用前快照复制不一致：${file}`);
    return { source, original, path: target, sha256 };
  };
  const begin = (stage, id, files, parameters = {}) => {
    if (!enabled) return null;
    if (!POST_QUALITY_STAGES.includes(stage) || typeof id !== 'string' || !id || !Array.isArray(files) || files.length < 1)
      throw new GenerationQualityError('调用前加工步骤、ID或输入缺失');
    const rows = [...new Set(files.map(file => path.resolve(file)))].map(file => snapshot(file));
    const token = { token: randomUUID(), stage, id, inputs: rows, parameters: serial(parameters), startedAt: new Date().toISOString() };
    active.set(token.token, token);
    return token;
  };
  const finish = (token, { outputs = [], execution = {}, parameters = {}, beforeInputs = [] } = {}) => {
    if (!enabled || token === null) return null;
    if (!token || active.get(token.token) !== token) throw new GenerationQualityError('缺调用前凭证或重复消费加工凭证');
    if (execution.exitCode !== undefined && execution.exitCode !== 0) { active.delete(token.token); throw new GenerationQualityError('加工器失败，不能写完成凭证'); }
    for (const row of token.inputs) if (realpathSync(row.source) !== row.original || generationFileSha256(row.source) !== row.sha256)
      throw new GenerationQualityError(`加工过程修改来源：${row.source}`);
    // Generated/selected local music can be unknown to the outer caller. The
    // actual core exposes its own before-call SHA, independently rechecked here.
    for (const row of beforeInputs) {
      if (!validHash(row?.sha256) || typeof row?.path !== 'string') throw new GenerationQualityError('加工器没有实际调用前来源摘要');
      if (!token.inputs.some(input => input.sha256 === row.sha256)) token.inputs.push(snapshot(row.path, row.sha256));
    }
    if (!outputs.length) throw new GenerationQualityError('加工调用成功但没有实际输出');
    const actual = [...new Set(outputs.map(output => typeof output === 'string' ? output : output.path))].map(file => {
      const row = snapshot(file);
      return { path: row.path, sha256: row.sha256, media: mediaType(file), sourcePath: path.resolve(file) };
    });
    const merged = { ...token.parameters, ...serial(parameters) };
    const evidence = { ...serial(execution), exitCode: 0, beginToken: token.token, startedAt: token.startedAt,
      completedAt: new Date().toISOString(), actualSourceRechecks: token.inputs.map(row => ({ sha256: row.sha256, unchanged: true })) };
    if (token.stage === 'color') evidence.outputSha256 = actual[0].sha256;
    active.delete(token.token);
    for (const row of actual) completedOutputs.set(row.sourcePath, row.sha256);
    const promise = writeProcessingProof({ root: base, stage: token.stage, id: token.id,
      inputs: token.inputs.map(row => ({ path: row.path, sha256: row.sha256 })), outputs: actual,
      parameters: merged, execution: evidence }).then(proof => {
      proof.outputs = proof.outputs.map((row, index) => ({ ...row, sourcePath: path.relative(base, actual[index].sourcePath), media: actual[index].media }));
      descriptors.push(proof); return proof;
    });
    // Observe rejection immediately even while synchronous ffmpeg operations run.
    pending.push(promise.then(value => value, error => { deferredErrors.push(error); return null; }));
    return { stage: token.stage, id: token.id, outputs: actual };
  };
  const abort = token => { if (token) active.delete(token.token); };
  const stageTokens = new Map();
  const beginStage = (name, files, parameters = {}) => {
    const stage = stageFor(name);
    if (!stage || !enabled) return null;
    const previous = stageTokens.get(name); if (previous) abort(previous);
    if (['compose', 'color', 'subtitle', 'danmaku', 'bgm', 'mux', 'master'].includes(name)) return null;
    const token = begin(stage, name, files, { mode: name, ...parameters }); stageTokens.set(name, token); return token;
  };
  const recordStage = record => {
    const token = stageTokens.get(record.stage); if (!token) return;
    stageTokens.delete(record.stage);
    if (!record.invoked || !record.ok || record.degraded || !record.artifact) { abort(token); return; }
    const outputs = [record.artifact, ...(record.evidence?.outputFiles ?? [])].filter(file => typeof file === 'string' && existsSync(file));
    // CLI receipts already certify these stages; the host record is reserved
    // for operations performed directly (cover and SFX), not a second invented call.
    if (['compose', 'color', 'subtitle', 'danmaku', 'bgm', 'mux'].includes(record.stage)) { abort(token); return; }
    const execution = { ...record.evidence, invoked: true, checks: executionChecks(record.evidence), exitCode: 0 };
    if (record.stage === 'sfx') return finish(token, { outputs, parameters: { mode: 'original-program', request: record.evidence }, execution });
    return finish(token, { outputs, parameters: { request: record.evidence }, execution });
  };
  const beginCli = (cli, args) => {
    if (!enabled) return null;
    const name = String(cli), command = args[0];
    let stage;
    if (/compose-film\.mts$/.test(name)) stage = 'transitions';
    else if (/color-bridge\/cli\.mjs$/.test(name) && ['grade', 'best'].includes(command)) stage = 'color';
    else if (/subtitle-bridge\/cli\.mjs$/.test(name) && ['sidecar', 'burn', 'best', 'title', 'karaoke', 'softmux', 'danmaku', 'sticker'].includes(command)) stage = command === 'danmaku' ? 'danmaku' : 'subtitles';
    else if (/bgm-bridge\/cli\.mjs$/.test(name) && ['mix', 'best'].includes(command)) stage = 'bgm';
    if (!stage) return null;
    const files = [];
    for (const option of ['--in', '--bgm', '--srt', '--srt-en', '--items', '--brief', '--audio-stems', '--lut']) {
      const value = cliFlag(args, option); if (value) files.push(value);
    }
    const clips = cliFlag(args, '--clips'); if (clips) files.push(...clips.split(',').filter(Boolean));
    const token = begin(stage, `${stage}-${descriptors.length}-${randomUUID()}`, files, { mode: command ?? 'compose',
      request: { tool: path.relative(path.resolve(import.meta.dirname, '../..'), path.resolve(cli)), argv: args } });
    token.cli = cli; token.args = [...args]; return token;
  };
  const finishCli = (token, { report = null, outputs = [], receiptFile = null } = {}) => {
    if (!token) return null;
    const args = token.args, detail = report?.report ?? report, parameters = {}, execution = { tool: token.cli, argv: args, exitCode: 0,
      checks: executionChecks(detail), processorReport: report };
    const allOutputs = [...outputs, ...collectReportOutputs(detail)];
    const target = cliFlag(args, '--out'); if (target && existsSync(target)) allOutputs.unshift(target);
    if (receiptFile && existsSync(receiptFile)) allOutputs.push(receiptFile);
    if (token.stage === 'color') {
      parameters.profile = detail?.profile ?? report?.winnerLabel ?? cliFlag(args, '--profile');
      parameters.lut = detail?.lut ?? cliFlag(args, '--lut');
      parameters.intensity = Number(detail?.intensity ?? cliFlag(args, '--intensity'));
      parameters.technicalOnly = !parameters.profile && !parameters.lut;
      execution.processingQuality = detail?.processingQuality ?? report?.processingQuality ?? null;
    } else if (token.stage === 'transitions') {
      const receipt = report ?? (receiptFile ? JSON.parse(readFileSync(receiptFile, 'utf8')) : null);
      if (!receipt || !Array.isArray(receipt.cuts) || !Number.isInteger(receipt.shotCount)
        || receipt.outputSha256 !== generationFileSha256(target)) throw new GenerationQualityError('合成没有实际逐刀执行回执');
      execution.cuts = receipt.cuts; execution.shotCount = receipt.shotCount;
      execution.retimeFactor = receipt.retimeFactor; execution.compositionReceipt = receipt;
    } else if (token.stage === 'bgm') {
      const music = detail?.bgm;
      if (!music || !validHash(music.sha256) || !Array.isArray(detail.beforeInputs)) throw new GenerationQualityError('配乐没有实际源曲及调用前输入回执');
      parameters.policy = detail.policy; parameters.mode = 'mix'; execution.trackId = music.id ?? path.basename(music.path);
      execution.trackSha256 = music.sha256; execution.playedSha256 = music.playedSha256 ?? null;
    } else if (token.stage === 'subtitles' || token.stage === 'danmaku') {
      execution.cueCount = cueCount(detail, args); parameters.mode = token.stage === 'danmaku' ? 'danmaku' : args[0];
      if (!execution.cueCount) throw new GenerationQualityError('字幕或弹幕没有实际文字与执行条数');
      const files = detail?.files ?? [];
      for (const file of files) if (file?.path && existsSync(file.path)) allOutputs.push(file.path);
    }
    return finish(token, { outputs: [...new Set(allOutputs)], parameters, execution,
      beforeInputs: token.stage === 'bgm' ? detail.beforeInputs : [] });
  };
  const preserveSource = (file, id) => {
    if (!enabled) return null;
    const row = snapshot(file); const binding = { id, path: path.relative(base, row.path), sha256: row.sha256, origin: row.source };
    sourceBindings.set(id, binding); return binding;
  };
  const flush = async () => {
    await Promise.all(pending);
    if (deferredErrors.length) throw deferredErrors[0];
    return serial(descriptors);
  };
  const artifact = async (id, file, options = {}) => {
    const original = path.resolve(file), real = within(base, original) ? exactFile(base, file) : snapshot(original).path, media = options.media ?? mediaType(file), facts = ['video', 'image'].includes(media) ? await probeMedia(real, { bins }) : null;
    return { ...options, id, path: path.relative(base, real), sha256: generationFileSha256(real), media,
      ...(facts ? { resolution: options.resolution ?? [facts.width, facts.height], ...(media === 'video' ? { fps: options.fps ?? facts.fps, durationSeconds: options.durationSeconds ?? facts.videoDuration, requireAudio: options.requireAudio ?? facts.hasAudio } : {}) } : {}) };
  };
  const inspect = async ({ phase, artifacts, requirements, resolution, sourceResolution, variantIds = [], scope = 'delivery',
    allowDownscale = false, allowReframe = false, reframeReason = null, audioQuality = null, requiredOutputIds = [], minimumVariantCount = 2 } = {}) => {
    for (const source of sourceBindings.values()) if (generationFileSha256(source.origin) !== source.sha256) throw new GenerationQualityError(`原片在加工后发生变化：${source.origin}`);
    if (active.size) throw new GenerationQualityError('仍有未完成的加工调用，不能验收');
    const proofs = await flush();
    const manifest = { schemaVersion: GENERATION_QUALITY_SCHEMA, phase, scope, resolution, sourceResolution, variantIds,
      allowDownscale, allowReframe, reframeReason, audioQuality: audioQuality ?? { mode: 'report', targetLufs: -14, toleranceLu: 1, maxTruePeakDbtp: -1 },
      artifacts: await Promise.all(artifacts.map(row => artifact(row.id, row.path, { ...row, ...(['video', 'image'].includes(row.media ?? mediaType(row.path)) && row.role !== 'cover' ? { resolution } : {}) }))),
      requiredOutputIds, minimumVariantCount, requirements: serial(requirements), processing: proofs, sources: [...sourceBindings.values()] };
    const report = await inspectGenerationManifest({ root: base, manifest: { generationQuality: manifest }, bins, phase });
    const qualityFile = await writePostQuality(base, report);
    assertPostQuality(report);
    return { manifest, report, qualityFile, files: listGenerationQualityFiles(base) };
  };
  const ownsOutput = file => { try { return [...completedOutputs.values()].includes(generationFileSha256(file)); } catch { return false; } };
  return { begin, finish, abort, beginStage, recordStage, beginCli, finishCli, preserveSource, flush, artifact, inspect, ownsOutput };
}

export function listGenerationQualityFiles(root) {
  const result = [], folder = path.join(root, 'quality');
  const visit = dir => { if (!existsSync(dir)) return; for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const file = path.join(dir, entry.name); if (entry.isDirectory()) visit(file); else if (entry.isFile()) result.push(file);
    else throw new GenerationQualityError(`质量证据目录含非文件项：${file}`);
  } };
  visit(folder); return result.sort();
}

/** Stable external read-only interface. Recompute from current files, never reuse a passed boolean. */
export async function inspectGenerationManifest({ root, manifest, bins, phase = 'delivery' } = {}) {
  const base = realpathSync(path.resolve(root)), contract = manifest?.generationQuality;
  if (contract?.schemaVersion !== GENERATION_QUALITY_SCHEMA || !Array.isArray(contract.artifacts) || !Array.isArray(contract.processing)
    || !Array.isArray(contract.sources) || !Array.isArray(contract.requirements) || !Array.isArray(contract.variantIds))
    throw new GenerationQualityError('清单缺当前生成加工契约，旧 hash 清单不能作为质量验收');
  const groups = Object.fromEntries(POST_QUALITY_STAGES.map(stage => [stage, []]));
  const bindings = Object.fromEntries(POST_QUALITY_STAGES.map(stage => [stage, {}]));
  const assets = contract.artifacts.map(row => ({ ...row })), documents = [], extra = [];
  for (const [index, proof] of contract.processing.entries()) {
    if (!POST_QUALITY_STAGES.includes(proof?.stage)) { extra.push({ kind: `proof:${index}:stage`, hard: true, ok: false }); continue; }
    const id = `proof:${index}`, file = exactFile(base, proof.path), document = JSON.parse(readFileSync(file, 'utf8'));
    documents.push({ proof, document, assetId: id });
    assets.push({ id, path: proof.path, sha256: proof.sha256, media: 'json' }); groups[proof.stage].push(id);
    const outputIds = [];
    for (const [outputIndex, output] of (proof.outputs ?? []).entries()) {
      const outputId = `proof-output:${index}:${outputIndex}`;
      const outputFile = exactFile(base, output.path), media = output.media ?? mediaType(output.path);
      const facts = ['video', 'image'].includes(media) ? await probeMedia(outputFile, { bins }) : null;
      assets.push({ id: outputId, path: output.path, sha256: output.sha256, media,
        ...(facts ? { resolution: [facts.width, facts.height], ...(media === 'video' ? { durationSeconds: facts.videoDuration } : {}) } : {}) });
      outputIds.push(outputId);
    }
    bindings[proof.stage][id] = outputIds;
    extra.push({ kind: `proof:${index}:descriptor`, hard: true, ok: document.id === proof.id && document.stage === proof.stage
      && JSON.stringify(document.outputs) === JSON.stringify((proof.outputs ?? []).map(({ media, sourcePath, ...row }) => row)) });
  }
  const duplicate = new Set();
  for (const artifact of contract.artifacts) {
    if (artifact.media === 'video') groups.resolution.push(artifact.id);
    if (artifact.role === 'cover') groups.cover.push(artifact.id);
    if (artifact.media === 'subtitle') groups.subtitles.push(artifact.id);
    extra.push({ kind: `artifact:${artifact.id}:unique`, hard: true, ok: !duplicate.has(artifact.id) }); duplicate.add(artifact.id);
  }
  const requirementFor = stage => contract.requirements.filter(row => row?.name === stage);
  const stages = POST_QUALITY_STAGES.map(name => {
    const rows = requirementFor(name), row = rows[0];
    if (rows.length !== 1) return { name, requirement: 'missing' };
    if (row.requirement === 'not_applicable') {
      // An actually invoked stage is still validated even if the final profile
      // excludes it; a caller cannot conceal a bad proof by declaring NA.
      if (!groups[name].length) return { ...row };
      return { name, requirement: 'required', artifactIds: groups[name], outputIdsByProof: bindings[name] };
    }
    return { name, requirement: row.requirement, artifactIds: groups[name], outputIdsByProof: bindings[name] };
  });
  const receipts = POST_QUALITY_STAGES.map(name => ({ name, status: 'completed', artifactIds: groups[name], checks: [] }));
  const requiredIds = [...new Set([...(contract.scope === 'master' ? ['master'] : ['master', ...contract.variantIds.map(id => `variant:${id}`)]), ...(contract.requiredOutputIds ?? [])])];
  extra.push({ kind: 'required-final-forms', hard: true, ok: requiredIds.every(id => contract.artifacts.filter(row => row.id === id).length === 1) });
  extra.push({ kind: 'variant-set', hard: true, ok: contract.scope === 'master' ? contract.variantIds.length === 0
    : contract.variantIds.length >= (contract.minimumVariantCount === 1 ? 1 : 2) && new Set(contract.variantIds).size === contract.variantIds.length
      && contract.artifacts.filter(row => row.id.startsWith('variant:') && row.media === 'video').length === contract.variantIds.length });
  const sourceHashes = new Set();
  for (const [index, source] of contract.sources.entries()) {
    let ok = false;
    try { ok = validHash(source.sha256) && generationFileSha256(exactFile(base, source.path)) === source.sha256; }
    catch { ok = false; }
    extra.push({ kind: `source:${index}:pinned`, hard: true, ok }); if (ok) sourceHashes.add(source.sha256);
  }
  extra.push({ kind: 'original-sources-present', hard: true, ok: sourceHashes.size > 0 });
  // Each output carries the actual source identities and stages of its consumed inputs.
  // A trim or an enhancement is a real processor edge, so composition may consume
  // derived clips without pretending that their bytes equal the original provider files.
  const origins = new Map(), ancestors = new Map();
  for (const source of contract.sources) {
    const ids = origins.get(source.sha256) ?? new Set(); ids.add(source.id); origins.set(source.sha256, ids);
    ancestors.set(source.sha256, new Set());
  }
  let progress = true;
  while (progress) { progress = false; for (const { proof, document } of documents) {
    if (document.status !== 'completed' || document.sourcePreserved !== true || document.execution?.exitCode !== 0 || !Array.isArray(document.inputs) || !Array.isArray(document.outputs)) continue;
    const used = document.inputs.filter(input => origins.has(input.sha256)); if (!used.length) continue;
    const ids = new Set(used.flatMap(input => [...origins.get(input.sha256)]));
    const steps = new Set([proof.id, ...used.flatMap(input => [...(ancestors.get(input.sha256) ?? [])])]);
    for (const output of document.outputs) {
      const previous = origins.get(output.sha256), priorSteps = ancestors.get(output.sha256);
      if (!previous || [...ids].some(id => !previous.has(id)) || !priorSteps || [...steps].some(id => !priorSteps.has(id))) {
        origins.set(output.sha256, new Set([...(previous ?? []), ...ids])); ancestors.set(output.sha256, new Set([...(priorSteps ?? []), ...steps])); progress = true;
      }
    }
  } }
  const allSourceIds = contract.sources.map(source => source.id);
  extra.push({ kind: 'source-identities-unique', hard: true, ok: allSourceIds.length > 0 && new Set(allSourceIds).size === allSourceIds.length });
  const composed = documents.filter(row => row.proof.stage === 'transitions');
  extra.push({ kind: 'actual-composition', hard: true, ok: composed.some(({ document }) => {
    const used = new Set((document.inputs ?? []).flatMap(input => [...(origins.get(input.sha256) ?? [])]));
    return Array.isArray(document.execution?.cuts) && document.execution.shotCount === allSourceIds.length
      && document.execution.cuts.length === Math.max(0, allSourceIds.length - 1) && allSourceIds.every(id => used.has(id));
  }) });
  for (const artifact of contract.artifacts.filter(row => row.media === 'video')) {
    const ids = origins.get(artifact.sha256), steps = ancestors.get(artifact.sha256) ?? new Set();
    extra.push({ kind: `chain:${artifact.id}`, hard: true, ok: allSourceIds.every(id => ids?.has(id)), detail: '当前输出字节沿实际加工边追溯到每一个原镜头身份' });
    const consumed = documents.filter(({ proof }) => steps.has(proof.id));
    for (const stage of artifact.requiredStages ?? []) extra.push({ kind: `chain:${artifact.id}:${stage}`, hard: true,
      ok: consumed.some(({ proof }) => proof.stage === stage), detail: '该文件自己的实际加工链包含请求步骤' });
    const colorCalls = consumed.filter(({ proof }) => proof.stage === 'color');
    if (artifact.expectedColorCount !== undefined) extra.push({ kind: `chain:${artifact.id}:color-count`, hard: true,
      ok: Number.isInteger(artifact.expectedColorCount) && artifact.expectedColorCount >= 0 && colorCalls.length === artifact.expectedColorCount });
    if (artifact.expectedColorInputSha256 !== undefined) extra.push({ kind: `chain:${artifact.id}:color-input`, hard: true,
      ok: validHash(artifact.expectedColorInputSha256) && colorCalls.length === 1
        && colorCalls[0].document.inputs?.[0]?.sha256 === artifact.expectedColorInputSha256 });
    if (artifact.expectedColorLut !== undefined) extra.push({ kind: `chain:${artifact.id}:color-lut`, hard: true,
      ok: colorCalls.length === 1 && (colorCalls[0].document.parameters.lut ? path.basename(colorCalls[0].document.parameters.lut) : null) === artifact.expectedColorLut });
    if (artifact.expectedColorIntensity !== undefined) extra.push({ kind: `chain:${artifact.id}:color-intensity`, hard: true,
      ok: Number.isFinite(artifact.expectedColorIntensity) && colorCalls.length === 1
        && colorCalls[0].document.parameters.intensity === artifact.expectedColorIntensity });
    if (artifact.expectedColorProfile !== undefined) extra.push({ kind: `chain:${artifact.id}:color-profile`, hard: true,
      ok: consumed.some(({ proof, document }) => proof.stage === 'color' && (document.parameters.profile ?? null) === artifact.expectedColorProfile), detail: artifact.expectedColorProfile });
  }
  for (const { proof, document } of documents) {
    if (proof.stage === 'bgm' && document.parameters?.mode !== 'original-program') extra.push({ kind: `music:${proof.id}:consumed`, hard: true,
      ok: document.inputs?.some(input => input.sha256 === document.execution?.trackSha256) });
    if (proof.stage === 'transitions') extra.push({ kind: `composition:${proof.id}:speed`, hard: true,
      ok: Number.isFinite(document.execution?.retimeFactor) && Math.abs(document.execution.retimeFactor - 1) < 1e-6 });
  }
  const report = await inspectPostQuality({ root: base, assets, receipts, bins, checks: extra,
    contract: { schemaVersion: 'workloom.post-contract/v1', phase, resolution: contract.resolution, sourceResolution: contract.sourceResolution,
      allowDownscale: contract.allowDownscale === true, allowReframe: contract.allowReframe === true, reframeReason: contract.reframeReason,
      audioQuality: contract.audioQuality, stages } });
  // Resolution entries may represent real trims or enhancements, so their schema,
  // request digest and current input/output bytes need the same verification as every other processor.
  const currentAssets = new Map(report.assets.map(asset => [asset.id, asset]));
  for (const { proof, document, assetId } of documents.filter(row => row.proof.stage === 'resolution')) {
    let ok = true, detail = null;
    try { await verifyProcessingProof(document, 'resolution', base, currentAssets, bindings.resolution[assetId] ?? []); }
    catch (error) { ok = false; detail = errorMessage(error); }
    report.checks.push({ kind: `processing:resolution-proof:${proof.id}`, hard: true, ok, detail });
  }
  report.passed = report.checks.every(row => !row.hard || row.ok);
  report.generationQuality = { schemaVersion: GENERATION_QUALITY_SCHEMA, scope: contract.scope,
    sourceCount: contract.sources.length, processingCount: contract.processing.length, requestedVariants: contract.variantIds,
    currentFileInspection: true, manifestSha256: hashJson(contract) };
  return report;
}
