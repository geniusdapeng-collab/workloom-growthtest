import { createHash } from 'node:crypto';

/** Every rendered shot keeps its own provider audio, including offscreen speech and ambience. */
export const FILM_AUDIO_POLICY_VERSION = 'workloom.film-audio-policy/v2';

export class FilmAudioPolicyError extends Error {
  constructor(code, message, shotId = null) {
    super(`${code}${shotId ? ` [${shotId}]` : ''}: ${message}`);
    this.name = 'FilmAudioPolicyError';
    this.code = code;
    this.shotId = shotId;
  }
}

const object = value => Boolean(value && typeof value === 'object' && !Array.isArray(value));
const text = value => typeof value === 'string' ? value.trim() : '';
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');

function bool(value, name, fallback = false) {
  if (value === undefined) return fallback;
  if (typeof value !== 'boolean') throw new FilmAudioPolicyError('AUDIO_POLICY_INVALID', `${name} 必须为布尔值`);
  return value;
}

function dialogueRows(value, shotId) {
  if (value === undefined || value === null) return [];
  if (typeof value === 'string') return value.trim() ? [{ text: value.trim() }] : [];
  if (!Array.isArray(value)) throw new FilmAudioPolicyError('AUDIO_DIALOGUE_INVALID', 'dialogue 必须是台词数组或字符串', shotId);
  return value.map(row => {
    if (typeof row === 'string') return { text: row.trim() };
    if (!object(row) || (row.text !== undefined && typeof row.text !== 'string')) {
      throw new FilmAudioPolicyError('AUDIO_DIALOGUE_INVALID', '每条台词须含字符串 text', shotId);
    }
    return { text: text(row.text), speaker: text(row.speaker), trigger: text(row.trigger) };
  }).filter(row => row.text);
}

function payload(contract) {
  return {
    schemaVersion: contract.schemaVersion, shotId: contract.shotId, mode: contract.mode, sourcePolicy: contract.sourcePolicy,
    text: contract.text, semantics: contract.semantics,
  };
}

function validateContract(contract) {
  if (!object(contract) || contract.schemaVersion !== FILM_AUDIO_POLICY_VERSION
    || !text(contract.shotId) || !['native-dialogue', 'voiceover', 'none'].includes(contract.mode)
    || contract.sourcePolicy !== 'render-native'
    || typeof contract.text !== 'string' || !object(contract.semantics)
    || contract.policyHash !== hash(payload(contract))) {
    throw new FilmAudioPolicyError('AUDIO_CONTRACT_INVALID', '音频合同缺失、被修改或不属于当前策略版本');
  }
}

/** Keep authored speech semantics; they never authorize replacing rendered audio. */
export function resolveFilmAudioContract(shot) {
  if (!object(shot) || !text(shot.shotId)) {
    throw new FilmAudioPolicyError('AUDIO_SHOT_INVALID', '镜头须是含非空 shotId 的对象');
  }
  const shotId = text(shot.shotId);
  if (shot.speechMode !== undefined && !['on-camera', 'voice-over'].includes(shot.speechMode)) {
    throw new FilmAudioPolicyError('AUDIO_SPEECH_MODE_INVALID', 'speechMode 只允许 on-camera 或 voice-over', shotId);
  }
  const rows = dialogueRows(shot.dialogue, shotId);
  const dialogue = rows.map(row => row.text).join(' ');
  if (!dialogue && shot.speechMode !== undefined) {
    throw new FilmAudioPolicyError('AUDIO_DIALOGUE_TEXT_MISSING', '已声明口播或画外音但没有台词', shotId);
  }
  // Match authored performance cues, not injected scene prompts or a character name.
  const action = text(shot.action);
  const audio = text(shot.audio);
  const triggers = rows.map(row => row.trigger || '').join('；');
  const noSpeaking = /(?:不|未|没有|禁止|避免)\s*(?:再|正在|要|需)?\s*(?:开口|说话|讲话)|保持闭口|嘴唇闭合|全程闭口/.test(`${action}；${audio}；${triggers}`);
  const affirmative = `${action}；${audio}；${triggers}`
    .replace(/(?:不|未|没有|禁止|避免)\s*(?:再|正在|要|需)?\s*(?:开口(?:说话|讲话)?|说话|讲话)/g, '');
  const visibleSpeech = /开口|说出|口型同步|唇形同步|口播|lip[-\s]?sync|visible[-\s]?speaker/i.test(affirmative);
  const narration = /画外音|旁白|voice[-\s]?over|off[-\s]?screen/i.test(`${audio}；${triggers}`)
    || rows.some(row => /^(?:旁白|画外音|narrator|voice[-\s]?over)$/i.test(row.speaker || ''));
  if (shot.speechMode === 'voice-over' && visibleSpeech) {
    throw new FilmAudioPolicyError('AUDIO_SPEECH_MODE_CONFLICT', 'voice-over 与出镜开口/口型同步描述冲突', shotId);
  }
  if (shot.speechMode === 'on-camera' && noSpeaking) {
    throw new FilmAudioPolicyError('AUDIO_SPEECH_MODE_CONFLICT', 'on-camera 与不开口描述冲突', shotId);
  }
  const mode = !dialogue ? 'none'
    : shot.speechMode === 'on-camera' || visibleSpeech ? 'native-dialogue'
    : shot.speechMode === 'voice-over' || narration || noSpeaking ? 'voiceover' : 'native-dialogue';
  const reason = mode === 'none' ? '本镜没有台词'
    : mode === 'voiceover' ? '已声明画外音或不开口，保留该镜渲染时的同源音轨'
    : shot.speechMode === 'on-camera' || visibleSpeech ? '出镜讲话须保留原生声画'
    : '有台词但未能证实为画外音，按原生对白保护';
  const contract = {
    schemaVersion: FILM_AUDIO_POLICY_VERSION, shotId, mode, sourcePolicy: 'render-native', text: dialogue, reason,
    semantics: { speechMode: shot.speechMode ?? null, action, audio, rows },
  };
  return { ...contract, policyHash: hash(payload(contract)) };
}

/** Run before paid rendering. All shots require original audio; no verified=true flag permits a replacement. */
export function assertFilmAudioPreflight({ shots, unifiedNarration, generateAudio } = {}) {
  const unified = bool(unifiedNarration, 'unifiedNarration');
  const generate = bool(generateAudio, 'generateAudio', true);
  if (!Array.isArray(shots) || shots.length === 0) throw new FilmAudioPolicyError('AUDIO_SHOTS_INVALID', '预检须提供非空镜头数组');
  const contracts = shots.map(resolveFilmAudioContract);
  const ids = new Set();
  for (const contract of contracts) {
    if (ids.has(contract.shotId)) throw new FilmAudioPolicyError('AUDIO_DUPLICATE_SHOT_ID', '音频合同镜头 ID 重复', contract.shotId);
    ids.add(contract.shotId);
    if (unified) throw new FilmAudioPolicyError('AUDIO_UNIFIED_NATIVE_DIALOGUE_REJECTED', '--narration-unified 会替换镜头原声；后期必须保留每镜同源原始音轨', contract.shotId);
    if (!generate) throw new FilmAudioPolicyError('AUDIO_NATIVE_GENERATION_REQUIRED', '每个渲染镜头都必须开启原生音频，包括画外音和环境声', contract.shotId);
  }
  return contracts;
}

/** A measured missing/wrong line blocks the film; postproduction never synthesizes a replacement. */
export function decideFilmVoiceAction({ contract, rawSpeech, unifiedNarration } = {}) {
  validateContract(contract);
  const unified = bool(unifiedNarration, 'unifiedNarration');
  const decision = (action, code, reason) => ({ action, code, reason, policyHash: contract.policyHash });
  if (contract.mode === 'none') return decision('none', 'AUDIO_NO_DIALOGUE', '本镜没有台词，语音核验不适用');
  if (unified) {
    return decision('blocked', 'AUDIO_UNIFIED_NATIVE_DIALOGUE_REJECTED', '统一重配不能替换出镜对白');
  }
  const measured = object(rawSpeech) && ['passed', 'failed', 'unverified'].includes(rawSpeech.status)
    && typeof rawSpeech.ok === 'boolean'
    && (rawSpeech.status !== 'passed' || rawSpeech.ok)
    && (rawSpeech.status !== 'failed' || !rawSpeech.ok)
    && (rawSpeech.status !== 'unverified' || !rawSpeech.ok);
  if (!measured || rawSpeech.status === 'unverified') {
    return decision('blocked', 'AUDIO_NATIVE_UNVERIFIED', '语音或术语未核实，不得用 TTS 遮掩未知结果');
  }
  return rawSpeech.ok
    ? decision('preserve-native', 'AUDIO_NATIVE_PRESERVED', '原生台词通过核验，保留同源音轨')
    : decision('blocked', 'AUDIO_NATIVE_DIALOGUE_FAILED', '镜头原生对白缺失、台词或术语不符；停线修复源镜头');
}

/** Apply again when selecting old voice artifacts for composition and final delivery. */
export function assertFilmAudioSource({ contract, source } = {}) {
  validateContract(contract);
  if (source !== 'clip-audio') {
    throw new FilmAudioPolicyError('AUDIO_NATIVE_SOURCE_REPLACED', '每个镜头只能采用同源原始音轨；旧 TTS、重配和配音复用回执均不可进入后期', contract.shotId);
  }
  return true;
}
