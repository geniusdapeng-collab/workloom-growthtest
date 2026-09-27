export type ShotCard = Record<string, unknown>;
export type ShotIntentStatus = "passed" | "failed" | "unverified" | "not_applicable";
export type EnhancementOwner = "micromotion" | "cine-kb";
export interface ShotIntent {
  schemaVersion: "workloom.shot-intent/v1";
  sourceHash: string;
  source: ShotCard;
  shotId: string;
  evidence: "deterministic-text-rules";
  subject: {
    kind: "person" | "animal" | "object" | "environment" | "unknown";
    count: number | null;
    hasPerson: boolean;
    faceVisible: boolean;
    visibleParts: string[];
    posture: "sleeping" | "lying" | "crouching" | "sitting" | "standing" | "unknown";
    eyesClosed: boolean;
    shotScale: "close" | "wide" | "medium" | "unknown";
  };
  camera: {
    modes: string[];
    positiveText: string;
    negativeConstraints: string[];
    hardStatic: boolean;
    pace: "static" | "slow" | "fast" | "unspecified";
  };
  performance: {
    action: string;
    mood: string;
    pacing: string;
    dialogue: string[];
    hasDialogue: boolean;
    negativeConstraints: string[];
    forbidSmile: boolean;
    forbidRise: boolean;
    forbidBlink: boolean;
    walking: boolean;
  };
  scene: {
    text: string;
    positiveText: string;
    timeOfDay: string[];
    lightSources: string[];
    lightDirections: string[];
    temperatures: string[];
    depthMode: "deep" | "shallow" | "moderate" | "unknown";
    negativeConstraints: string[];
    era: string | null;
  };
}
export interface ShotContributionResult {
  field: string;
  from: string;
  added: string;
  written: string;
  writtenChars: number;
  dropped?: "field-over-budget";
  originalChars?: number;
  fieldBudget?: number;
  fieldHash?: string;
}
export const SHOT_INTENT_VERSION: "workloom.shot-intent/v1";
export const ENHANCEMENT_META_KEY: "_workloomEnhancements";
export class ShotIntentError extends Error {
  readonly code: string;
  readonly status: "unverified";
  constructor(code: string, message: string);
}
export function shotIntentHash(value: unknown): string;
export function shotText(value: unknown): string;
export function splitShotAssertions(raw: unknown): { positive: string; negative: string[] };
export function restoreShotContributions(input: unknown, owner?: EnhancementOwner | null): { card: ShotCard; restored: string[] };
export function appendShotContributions(input: unknown, options: {
  owner: EnhancementOwner;
  policyVersion: string;
  sourceHash: string;
}, additions: Array<{ field: string; text: string; maxFieldChars?: number }>): { card: ShotCard; applied: ShotContributionResult[] };
export function normalizeShotIntent(input: unknown): ShotIntent;
export function resolveShotIntent(card: unknown, supplied?: unknown): ShotIntent;
