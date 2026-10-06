export const FILM_AUDIO_POLICY_VERSION: 'workloom.film-audio-policy/v2';
export class FilmAudioPolicyError extends Error {
  code: string;
  shotId: string | null;
  constructor(code: string, message: string, shotId?: string | null);
}
export interface FilmAudioShot {
  shotId: string;
  speechMode?: 'on-camera' | 'voice-over';
  dialogue?: unknown;
  action?: unknown;
  audio?: unknown;
  [key: string]: unknown;
}
export interface FilmAudioContract {
  schemaVersion: typeof FILM_AUDIO_POLICY_VERSION;
  shotId: string;
  mode: 'native-dialogue' | 'voiceover' | 'none';
  sourcePolicy: 'render-native';
  text: string;
  reason: string;
  semantics: { speechMode: 'on-camera' | 'voice-over' | null; action: string; audio: string; rows: Array<{ text: string; speaker?: string; trigger?: string }> };
  policyHash: string;
}
export interface FilmVoiceDecision {
  action: 'none' | 'preserve-native' | 'blocked';
  code: string;
  reason: string;
  policyHash: string;
}
export function resolveFilmAudioContract(shot: FilmAudioShot): FilmAudioContract;
export function assertFilmAudioPreflight(input: { shots: FilmAudioShot[]; unifiedNarration?: boolean; generateAudio?: boolean }): FilmAudioContract[];
export function decideFilmVoiceAction(input: {
  contract: FilmAudioContract;
  rawSpeech?: { status: 'passed' | 'failed' | 'unverified'; ok: boolean } | null;
  unifiedNarration?: boolean;
}): FilmVoiceDecision;
export function assertFilmAudioSource(input: { contract: FilmAudioContract; source?: string | null }): true;
