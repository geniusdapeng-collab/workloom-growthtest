import { describe, expect, it } from 'vitest';
import { computeVoiceFloor, projectShotDurations } from './duration-projection.js';

describe('voice floor is a hard constraint, even above the per-shot provider ceiling', () => {
  it('returns a localized infeasible result without modifying the source dialogue', () => {
    const shots = [{ shotId: 'SOURCE-A', duration: 12, dialogue: '这是一段必须完整保留且不能截断的台词。'.repeat(12) }];
    const before = structuredClone(shots);
    const floor = computeVoiceFloor(shots[0]!).seconds;
    expect(floor).toBeGreaterThan(12);
    const result = projectShotDurations(shots, { targetSeconds: 12, minSeconds: 4, maxSeconds: 12 });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('infeasible voice was accepted');
    expect(result.reason).toBe('voice-floor-exceeds-model-limit');
    expect(result.suggestions.join('；')).toContain('SOURCE-A');
    expect(result.entries[0]).toMatchObject({ shotId: 'SOURCE-A', voiceFloorSeconds: floor });
    expect(shots).toEqual(before);
  });
  it('rejects a single overfull shot even when project total can hold all spoken words', () => {
    const shots = [
      { shotId: 'LONG', duration: 12, dialogue: '这是一段必须完整保留且不能截断的台词。'.repeat(3) },
      ...Array.from({ length: 5 }, (_, i) => ({ shotId: `EMPTY-${i}`, duration: 8, dialogue: '' })),
    ];
    expect(computeVoiceFloor(shots[0]!).seconds).toBeGreaterThan(12);
    const result = projectShotDurations(shots, { targetSeconds: 52, minSeconds: 4, maxSeconds: 12 });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('voice-floor-exceeds-model-limit');
  });
  it('accepts speech exactly at its voice floor and preserves shot ids and duration total', () => {
    const shots = [{ shotId: 'A', duration: 5, dialogue: '欢迎回家。' }, { shotId: 'B', duration: 7, dialogue: '' }];
    const floor = computeVoiceFloor(shots[0]!).seconds;
    const result = projectShotDurations(shots, { targetSeconds: 12, minSeconds: 4, maxSeconds: 12 });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('short dialogue unexpectedly rejected');
    expect(result.entries.map(row => row.shotId)).toEqual(['A', 'B']);
    expect(result.entries[0]!.seconds).toBeGreaterThanOrEqual(floor);
    expect(result.entries.reduce((sum, row) => sum + row.seconds, 0)).toBe(12);
    expect(result.entries.every(row => row.seconds >= 4 && row.seconds <= 12)).toBe(true);
  });
  it('planning can explicitly leave voice feasibility pending while keeping the provider range', () => {
    const result = projectShotDurations([{ shotId: 'PLAN', duration: 12, dialogue: '这是一段长台词。'.repeat(30) }], { targetSeconds: 12, minSeconds: 4, maxSeconds: 12, enforceVoiceFloor: false });
    expect(result.ok).toBe(true);
    expect(result.entries[0]!.voiceFloorSeconds).toBeGreaterThan(12);
  });
});
