import { describe, expect, it } from 'vitest';
import { applyNarrativeFinalPromptContract } from './vendor-compat.js';
const shot = { shotId: 'S1', duration: 5, prompt: '01.【场景】现代厨房。\n02.【音频】人物说话声、杯子触桌声、钢琴音乐。', scene: '现代厨房', action: '林悦展示咖啡机', dialogue: '林悦说：欢迎回家。', audio: '人物说话声、杯子触桌声、钢琴音乐。' };
describe('narrative speech and music are independent constraints', () => {
  it.each([false, true])('noMusic preserves approved speech, canonicalize=%s', canonicalize => {
    const result = applyNarrativeFinalPromptContract(shot, { noDialogue: false, noMusic: true, maxLength: 3000, canonicalize, characterNames: ['林悦'] });
    const audio = String(result.prompt).match(/【音频】([^\n]*)/)?.[1] ?? '';
    expect(audio).not.toMatch(/无人物声|无旁白/);
    expect(audio).toMatch(/人物|人声|台词/);
    expect(audio).toMatch(/无音乐|无配乐/);
  });
  it.each([false, true])('noDialogue continues to prohibit all speech, canonicalize=%s', canonicalize => {
    const result = applyNarrativeFinalPromptContract(shot, { noDialogue: true, noMusic: true, maxLength: 3000, canonicalize });
    expect(String(result.prompt).match(/【音频】([^\n]*)/)?.[1]).toMatch(/无人物声|无旁白/);
  });
});

it.each([false, true])('noDialogue preserves source sound when music was not prohibited, canonicalize=%s', canonicalize => {
  const result = applyNarrativeFinalPromptContract({ ...shot, audio: '风声；街边音响传出的钢琴音乐' }, { noDialogue: true, noMusic: false, maxLength: 3000, canonicalize });
  const audio = String(result.prompt).match(/【音频】([^\n]*)/)?.[1] ?? '';
  expect(audio).toMatch(/无人物声|无旁白/);
  expect(audio).not.toMatch(/无音乐|无配乐|无节拍/);
  expect(audio).toContain('钢琴音乐');
});

it.each([false, true])('neither restriction leaves source audio intact, canonicalize=%s', canonicalize => {
  const result = applyNarrativeFinalPromptContract(shot, { noDialogue: false, noMusic: false, maxLength: 3000, canonicalize });
  const audio = String(result.prompt).match(/【音频】([^\n]*)/)?.[1] ?? '';
  expect(audio).toContain('人物说话声');
  expect(audio).toContain('钢琴音乐');
  expect(audio).not.toMatch(/无人物声|无旁白|无音乐/);
});
