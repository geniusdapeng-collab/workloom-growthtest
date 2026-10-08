/** Shared creative policy. No media, network, approval or generation side effects. */
export const FILM_COMPLETION_GUIDANCE = '给用户或客户交付高完成度作品是影视制作的最高优先级。完整动作、整句口播、叙事收束和观看节奏高于名义总时长。30秒通常是创作目标，28、32、35秒均可保留；不得为凑秒截断动作或台词、压速、补帧、冻结、循环或填充。只有显式登记的硬上限才构成时长约束；超过时先修订创作方案，不自动损坏既有素材，不新增付费渲染。技术时钟与文件检查不认证作品审美，未评审不得虚构质量分数。';
const fail = detail => { throw new Error(`FILM_COMPLETION_INVALID: ${detail}`); };
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const seconds = (value, field) => {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) fail(`${field} must be a finite positive number`);
  return value;
};
export function resolveFilmCompletionPolicy(input = {}) {
  if (!object(input) || Object.keys(input).some(key => !['targetSeconds', 'hardMaximumSeconds'].includes(key))) fail('unknown duration policy field');
  const targetSeconds = seconds(input.targetSeconds, 'targetSeconds');
  const hardMaximumSeconds = seconds(input.hardMaximumSeconds, 'hardMaximumSeconds');
  if (targetSeconds !== null && hardMaximumSeconds !== null && targetSeconds > hardMaximumSeconds) fail('creative target exceeds the explicit hard maximum');
  return Object.freeze({schemaVersion:'workloom.film-completion/v1', priority:'complete-work', targetSeconds,
    hardMaximumSeconds, durationMode:hardMaximumSeconds === null ? 'creative-target' : 'explicit-hard-maximum',
    preserveCompleteAction:true, preserveCompleteSpeech:true, nominalDurationMayVary:true,
    fitByTrim:false, fitBySpeed:false, fitByPadding:false, fitByFreeze:false, fitByLoop:false});
}
/** Legacy durationSeconds becomes a target; a hard maximum must be declared separately. */
export function filmCompletionPolicyForDocument(document, fallbackTargetSeconds = null) {
  if (!object(document)) fail('film document must be an object');
  const intent = document.durationIntent ?? {};
  if (!object(intent) || Object.keys(intent).some(key => !['targetSeconds', 'hardMaximumSeconds'].includes(key))) fail('unknown durationIntent field');
  const legacy = seconds(document.durationSeconds, 'durationSeconds');
  const explicit = seconds(intent.targetSeconds, 'durationIntent.targetSeconds');
  if (legacy !== null && explicit !== null && legacy !== explicit) fail('durationSeconds and durationIntent.targetSeconds conflict');
  return resolveFilmCompletionPolicy({targetSeconds:explicit ?? legacy ?? seconds(fallbackTargetSeconds, 'fallbackTargetSeconds'),
    hardMaximumSeconds:intent.hardMaximumSeconds});
}
/** Only an unambiguous stated number is used; prose is never interpreted as a hard maximum. */
export function filmTargetSecondsFromIntent(intent) {
  if (typeof intent !== 'string') fail('intent must be a string');
  const values = [...new Set([...intent.matchAll(/(?:^|[^\d.])([1-9]\d*(?:\.\d+)?)\s*(?:秒|seconds?\b|s\b)/giu)].map(match => Number(match[1])))];
  return values.length === 1 && Number.isFinite(values[0]) ? values[0] : null;
}
/** This is duration provenance, never an automatic artistic-quality verdict. */
export function describeFilmCompletion(policy, actualSeconds) {
  if (!object(policy) || policy.schemaVersion !== 'workloom.film-completion/v1') fail('completion policy missing');
  const expected = resolveFilmCompletionPolicy({targetSeconds:policy.targetSeconds, hardMaximumSeconds:policy.hardMaximumSeconds});
  if (Object.keys(policy).length !== Object.keys(expected).length || Object.entries(expected).some(([key,value]) => policy[key] !== value)) fail('completion policy changed');
  const actual = seconds(actualSeconds, 'actualSeconds');
  if (actual === null) fail('actualSeconds is required');
  if (policy.hardMaximumSeconds !== null && actual > policy.hardMaximumSeconds + 1e-9)
    throw new Error(`FILM_COMPLETION_HARD_LIMIT: complete duration ${actual}s exceeds explicit ${policy.hardMaximumSeconds}s; revise the creative plan, never trim or retime to fit`);
  return Object.freeze({policy, actualSeconds:actual, deltaFromTargetSeconds:policy.targetSeconds === null ? null : actual - policy.targetSeconds,
    durationDisposition:policy.targetSeconds === actual ? 'target-met' : 'preserve-complete-work',
    artisticQuality:'unverified', qualityScore:null});
}
