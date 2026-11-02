import { describe, expect, it } from 'vitest';
import { projectNarrativeActionSequence } from './vendor-compat.js';
describe('action projection preserves this project source instead of a sample story', () => {
  it.each([5, 6, 7])('keeps explicit performer and props with %s shots', shotCount => {
    const actions = ['林悦收伞', '林悦用智能锁开门', '林悦换鞋', '林悦打开落地台灯', '林悦坐下听雨'];
    const result = projectNarrativeActionSequence(actions, shotCount);
    expect(result).toHaveLength(shotCount);
    expect(result.join('；')).not.toMatch(/陈卓|白色|钥匙|出租屋/);
    for (const action of actions) expect(result.some(value => value.includes(action))).toBe(true);
  });
  it('does not substitute an orange cat and paper box for a dog on a balcony', () => {
    const result = projectNarrativeActionSequence(['白狗从阳台探头', '白狗抬起前爪伸向树叶', '白狗缩回前爪后盘成一团'], 6);
    expect(result.join('；')).not.toMatch(/橘猫|纸箱|屋檐|滴水/);
    expect(result.join('；')).toContain('白狗');
    expect(result.join('；')).toContain('树叶');
  });
  it('keeps exact ordered source actions when shot count is already equal', () => {
    const actions = ['王女士收伞', '王女士开门', '王女士换鞋', '王女士拧亮台灯', '王女士坐下听雨'];
    expect(projectNarrativeActionSequence(actions, actions.length)).toEqual(actions);
  });
});

import { applyNarrativeFinalPromptContract, deriveNarrativeShotDirection, normalizeHomecomingPrdContinuity } from './vendor-compat.js';

it('keeps this project scene, light and prop contract for familiar action words', () => {
  for (const action of ['林悦用智能锁开门', '林悦在别墅换鞋', '林悦按下台灯开关', '林悦坐下听雨']) {
    const input = { action, fallbackScene: '现代别墅客厅', fallbackLighting: '6000K自然日光，现代落地灯保持关闭', fallbackColor: '白色日光', fallbackProps: ['智能锁', '红色长靴', '现代落地灯'] };
    const result = deriveNarrativeShotDirection(input);
    expect(result.scene).toBe(input.fallbackScene);
    expect(result.lighting).toBe(input.fallbackLighting);
    expect(result.color).toBe(input.fallbackColor);
    expect(result.props).toEqual(input.fallbackProps);
  }
});

it.each([
  ['林悦', '智能锁', '红色长靴', '6000K', '现代别墅'],
  ['陈卓', '智能锁', '白色湿便鞋', '2700K', '出租屋'],
  ['陈卓', '钥匙', '红色长靴', '2700K', '出租屋'],
  ['陈卓', '钥匙', '白色湿便鞋', '6000K', '出租屋'],
])('does not rewrite %s / %s / %s / %s / %s into a sample PRD', (actor, lock, footwear, kelvin, home) => {
  const sourceIntent = `${actor}收伞，使用${lock}开门，回身关门，脱下${footwear}换鞋，打开${kelvin}台灯，在${home}坐下听雨。`;
  const scenes = Array.from({ length: 3 }, (_, index) => ({ sequence: index + 1, sceneId: `S${index}`, setting: home, purpose: sourceIntent, keyProps: [lock, footwear], visualRequirements: [kelvin], audioRequirements: ['环境声'] }));
  const prd = { projectDefinition: { sourceIntent }, characterSystem: { characters: [{ name: actor, costume: footwear }] }, scenePlan: { scenes }, visualSpecification: { lightingDirection: kelvin }, prdSummary: { keyHook: sourceIntent } };
  const before = structuredClone(prd);
  normalizeHomecomingPrdContinuity(prd, false);
  expect(prd).toEqual(before);
});

it('final projection does not replace source action and costume with footwear sample facts', () => {
  const source = { shotId: 'S1', duration: 6, prompt: '01.【场景】现代别墅。', scene: '现代别墅', action: '林悦脱下红色长靴，换穿蓝色便鞋', costume: '蓝色长裙，脚穿红色长靴', lighting: '6000K自然日光' };
  const result = applyNarrativeFinalPromptContract(source, { noDialogue: true, noMusic: true, maxLength: 3000, canonicalize: true, characterNames: ['林悦'], projectScene: source.scene, projectLighting: source.lighting, projectActions: [source.action], projectProps: ['红色长靴', '蓝色便鞋'] });
  expect(result.prompt).not.toMatch(/白色|湿便鞋|室内拖鞋|2700K|旧台灯|出租屋|钥匙/);
  expect(result.prompt).toContain('红色长靴');
  expect(result.prompt).toContain('蓝色便鞋');
});

it('keeps every source action in order when fewer shots combine actions', () => {
  const actions = ['林悦收伞', '林悦用智能锁开门', '林悦换鞋', '林悦打开落地台灯', '林悦坐下听雨'];
  const result = projectNarrativeActionSequence(actions, 3);
  expect(result).toHaveLength(3);
  const joined = result.join('；');
  for (let index = 0; index < actions.length; index++) {
    expect(joined).toContain(actions[index]);
    if (index) expect(joined.indexOf(actions[index]!)).toBeGreaterThan(joined.indexOf(actions[index - 1]!));
  }
});
