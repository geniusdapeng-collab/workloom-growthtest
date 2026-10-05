import assert from 'node:assert/strict';
import test from 'node:test';
import {
  FILM_AUDIO_POLICY_VERSION, FilmAudioPolicyError,
  assertFilmAudioPreflight, assertFilmAudioSource, decideFilmVoiceAction, resolveFilmAudioContract,
} from './film-audio-policy.mjs';

const shot = (speechMode = 'on-camera', extra = {}) => ({
  shotId: 'GT-01', speechMode, dialogue: [{ speaker: 'CEO', text: '入住，还要排队等前台？' }], ...extra,
});
const speech = (status = 'passed') => ({ status, ok: status === 'passed' });
const undeclared = (extra = {}) => {
  const value = shot('on-camera', extra);
  delete value.speechMode;
  return value;
};

test('camera dialogue and declared B-roll narration use distinct contracts', () => {
  assert.equal(resolveFilmAudioContract(shot()).mode, 'native-dialogue');
  assert.equal(resolveFilmAudioContract(shot('voice-over', { action: '她背对镜头行走，不开口说话。' })).mode, 'voiceover');
  assert.equal(resolveFilmAudioContract({ shotId: 'EMPTY', action: '空镜' }).mode, 'none');
  assert.equal(FILM_AUDIO_POLICY_VERSION, 'workloom.film-audio-policy/v1');
});

test('undeclared audible speech defaults to native; only explicit narration cues allow dubbing', () => {
  assert.equal(resolveFilmAudioContract(undeclared()).mode, 'native-dialogue');
  assert.equal(resolveFilmAudioContract(undeclared({ audio: '画外音讲述功能。' })).mode, 'voiceover');
  assert.equal(resolveFilmAudioContract(undeclared({ dialogue: [{ speaker: '旁白', text: '旅途从这里开始。' }] })).mode, 'voiceover');
  assert.equal(resolveFilmAudioContract(undeclared({ action: '她不开口说话，背影行走。' })).mode, 'voiceover');
});

test('declared voice-over cannot conceal a visible speaking or lip-sync request', () => {
  for (const extra of [
    { action: '她看向镜头，开口说出品牌台词。' },
    { dialogue: [{ text: '入住，还要排队？', trigger: '看向镜头时开口' }] },
    { audio: '人物说话的口型同步。' },
  ]) assert.throws(() => resolveFilmAudioContract(shot('voice-over', extra)), error => error.code === 'AUDIO_SPEECH_MODE_CONFLICT');
});

test('malformed or conflicting shot declarations fail before external I/O', () => {
  for (const input of [null, [], { shotId: '' }, shot('narration'), shot(false), shot('on-camera', { dialogue: [] }), shot('voice-over', { dialogue: [] }), shot('on-camera', { dialogue: false })]) {
    assert.throws(() => resolveFilmAudioContract(input), FilmAudioPolicyError);
  }
  assert.throws(() => resolveFilmAudioContract(shot('on-camera', { action: '不开口说话，纯画外音。' })), error => error.code === 'AUDIO_SPEECH_MODE_CONFLICT');
});

test('unified narration with a visible speaker is rejected by render preflight', () => {
  assert.throws(() => assertFilmAudioPreflight({ shots: [shot()], unifiedNarration: true, generateAudio: true }), error => error.code === 'AUDIO_UNIFIED_NATIVE_DIALOGUE_REJECTED');
  assert.throws(() => assertFilmAudioPreflight({ shots: [shot()], unifiedNarration: true, generateAudio: true, replacement: { verified: true } }), error => error.code === 'AUDIO_UNIFIED_NATIVE_DIALOGUE_REJECTED');
  assert.throws(() => assertFilmAudioPreflight({ shots: [shot()], unifiedNarration: false, generateAudio: false }), error => error.code === 'AUDIO_NATIVE_GENERATION_REQUIRED');
  assert.equal(assertFilmAudioPreflight({ shots: [shot('voice-over')], unifiedNarration: true, generateAudio: false }).length, 1);
  assert.equal(assertFilmAudioPreflight({ shots: [shot()], unifiedNarration: false }).length, 1);
});

test('render preflight validates every shot, empty sets, duplicates, and booleans', () => {
  assert.throws(() => assertFilmAudioPreflight({ shots: [] }), FilmAudioPolicyError);
  assert.throws(() => assertFilmAudioPreflight({ shots: [shot(), shot()] }), error => error.code === 'AUDIO_DUPLICATE_SHOT_ID');
  assert.throws(() => assertFilmAudioPreflight({ shots: [shot()], unifiedNarration: 'false' }), FilmAudioPolicyError);
  assert.throws(() => assertFilmAudioPreflight({ shots: [shot()], generateAudio: 0 }), FilmAudioPolicyError);
  assert.throws(() => assertFilmAudioPreflight({ shots: [shot('voice-over'), shot('on-camera', { shotId: 'GT-03' })], unifiedNarration: true }), error => error.code === 'AUDIO_UNIFIED_NATIVE_DIALOGUE_REJECTED');
});

test('native dialogue must survive ASR and term checks without a TTS fallback', () => {
  const contract = resolveFilmAudioContract(shot());
  assert.equal(decideFilmVoiceAction({ contract, rawSpeech: speech(), unifiedNarration: false }).action, 'preserve-native');
  for (const rawSpeech of [speech('failed'), speech('unverified'), { status: 'passed', ok: false }, null]) {
    const decision = decideFilmVoiceAction({ contract, rawSpeech, unifiedNarration: false });
    assert.equal(decision.action, 'blocked');
    assert.match(decision.code, /NATIVE/);
  }
  assert.equal(decideFilmVoiceAction({ contract, rawSpeech: speech(), unifiedNarration: true }).action, 'blocked');
});

test('voice-over may be dubbed after a measured failure or an explicit unified request', () => {
  const contract = resolveFilmAudioContract(shot('voice-over'));
  assert.equal(decideFilmVoiceAction({ contract, rawSpeech: speech(), unifiedNarration: false }).action, 'preserve-native');
  assert.equal(decideFilmVoiceAction({ contract, rawSpeech: speech('failed'), unifiedNarration: false }).action, 'dub-voiceover');
  assert.equal(decideFilmVoiceAction({ contract, rawSpeech: speech(), unifiedNarration: true }).action, 'dub-voiceover');
  assert.equal(decideFilmVoiceAction({ contract, rawSpeech: speech('unverified'), unifiedNarration: true }).action, 'blocked');
});

test('unknown checks, forged contracts, and invalid boolean flags never authorize dubbing', () => {
  const contract = resolveFilmAudioContract(shot('voice-over'));
  for (const rawSpeech of [{ status: 'passed', ok: 'true' }, { status: 'unknown', ok: false }, {}, { status: 'failed', ok: true }]) {
    assert.equal(decideFilmVoiceAction({ contract, rawSpeech }).action, 'blocked');
  }
  assert.throws(() => decideFilmVoiceAction({ contract: { ...contract, mode: 'native-dialogue' }, rawSpeech: speech() }), FilmAudioPolicyError);
  assert.throws(() => decideFilmVoiceAction({ contract, rawSpeech: speech(), unifiedNarration: 'false' }), FilmAudioPolicyError);
});

test('a stale successful TTS receipt is never a native composition source', () => {
  const contract = resolveFilmAudioContract(shot());
  assert.equal(assertFilmAudioSource({ contract, source: 'clip-audio' }), true);
  for (const source of ['tts-narration', 'tts-term-replaced', 'voiced-reuse', 'clip-audio-unverified', undefined]) {
    assert.throws(() => assertFilmAudioSource({ contract, source }), error => error.code === 'AUDIO_NATIVE_SOURCE_REPLACED');
  }
  assert.equal(assertFilmAudioSource({ contract: resolveFilmAudioContract(shot('voice-over')), source: 'tts-narration' }), true);
});

test('policy fingerprints bind speech mode, source wording, shot identity and dialogue', () => {
  const native = resolveFilmAudioContract(shot());
  assert.match(native.policyHash, /^[a-f0-9]{64}$/);
  assert.equal(resolveFilmAudioContract(shot()).policyHash, native.policyHash);
  for (const extra of [{ shotId: 'GT-03' }, { dialogue: [{ text: '新台词' }] }, { action: '从容说话' }]) {
    assert.notEqual(resolveFilmAudioContract(shot('on-camera', extra)).policyHash, native.policyHash);
  }
  assert.notEqual(resolveFilmAudioContract(shot('voice-over')).policyHash, native.policyHash);
});

test('silent B-roll needs no speech check while invalid silent receipts still fail', () => {
  const contract = resolveFilmAudioContract({ shotId: 'BROLL' });
  assert.equal(decideFilmVoiceAction({ contract }).action, 'none');
  assert.equal(assertFilmAudioSource({ contract, source: null }), true);
  assert.throws(() => assertFilmAudioSource({ contract, source: 'tts-narration' }), error => error.code === 'AUDIO_UNEXPECTED_NARRATION');
});
