import { describe, expect, it } from 'vitest';
import { applyNarrativeFinalPromptContract, normalizeNarrativePromptsForReview, type NarrativePromptReviewPolicy } from './vendor-compat.js';

const shot = { shotId: 'S1', duration: 5, prompt: '01.【场景】现代厨房。', scene: '现代厨房', action: '林悦展示咖啡机', character: '林悦' };
const policy: NarrativePromptReviewPolicy = { noDialogue: false, noMusic: false, noCharacters: false, noAnimals: false, noTitles: false, maxLength: 3000, aspectRatio: '16:9', resolution: '1920x1080', characterNames: ['林悦'], characterPortraits: [], projectProps: ['咖啡机'], projectActions: ['林悦展示咖啡机'] };
describe('narrative final framing preserves the frozen aspect', () => {
  it.each(['16:9', '9:16', '1:1', '4:3'])('canonical prompt uses %s in both constraint and composition', aspectRatio => {
    const result = applyNarrativeFinalPromptContract(shot, { ...policy, aspectRatio, canonicalize: true });
    expect(result.prompt).toContain(`【约束】${aspectRatio}画幅`);
    expect(String(result.prompt).match(/【构图】([^\n]*)/)?.[1]).toContain(`${aspectRatio}`);
    if (aspectRatio !== '9:16') expect(String(result.prompt).match(/【构图】([^\n]*)/)?.[1]).not.toContain('9:16');
  });
  it('G6 re-projection preserves 16:9 after a post-fusion mutation', () => {
    const [result] = normalizeNarrativePromptsForReview([{ ...shot, _workloomPromptReviewPolicy: policy }], policy);
    expect(String(result!.prompt).match(/【构图】([^\n]*)/)?.[1]).toContain('16:9');
  });
});
