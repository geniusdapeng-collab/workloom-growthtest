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

it('preserves repeated source actions in their original temporal positions', () => {
  const actions = ['林悦开门', '林悦关门', '林悦开门'];
  expect(projectNarrativeActionSequence(actions, 3)).toEqual(actions);
});

it('combined shot timelines retain the fourth and later source actions', () => {
  const action = '林悦开门；林悦放下包；林悦关门；林悦按下台灯开关；林悦坐下';
  const result = applyNarrativeFinalPromptContract({ shotId: 'S1', duration: 12, action }, { noDialogue: true, maxLength: 3000, canonicalize: true, projectActions: [action], characterNames: ['林悦'] });
  const timeline = String(result.prompt).match(/【时间轴】([^\n]*)/)?.[1] ?? '';
  const pacing = String(result.prompt).match(/【节奏】([^\n]*)/)?.[1] ?? '';
  for (const sourceAction of action.split('；')) {
    expect(timeline).toContain(sourceAction);
    expect(pacing).toContain(sourceAction);
  }
});

it('rejects source actions exceeding the final prompt capacity instead of emitting an overlong successful prompt', () => {
  const action = Array.from({ length: 60 }, (_, index) => `林悦按顺序检查编号${index + 1}的红色盒子并合上盖子`).join('；');
  expect(() => applyNarrativeFinalPromptContract({ shotId: 'S-long', duration: 12, action }, {
    noDialogue: true, maxLength: 3000, canonicalize: true, projectActions: [action], characterNames: ['林悦'],
  })).toThrow(/FINAL_PROMPT_SOURCE_CAPACITY_EXCEEDED.*S-long.*3000/u);
});

it('counts supplementary-plane characters at the actual final source-preserving boundary', () => {
  const build = (count: number) => applyNarrativeFinalPromptContract({
    shotId: 'A', duration: 6, scene: '𠮷'.repeat(count), action: '𠮷禾举起杯子',
  }, {
    noDialogue: true, maxLength: 3000, canonicalize: true, characterNames: ['𠮷禾'],
    projectScene: '𠮷'.repeat(count), projectActions: ['𠮷禾举起杯子'],
  });
  const exact = String(build(1779).prompt);
  expect(Array.from(exact)).toHaveLength(3000);
  expect(exact.length).toBeGreaterThan(3000);
  expect(exact).toContain('𠮷'.repeat(1779));
  expect(exact).toContain('𠮷禾举起杯子');
  expect(() => build(1780)).toThrow(/FINAL_PROMPT_SOURCE_CAPACITY_EXCEEDED.*3001.*3000/u);
});

import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

it('capacity failure before G6 leaves the original action intact and never reaches a render boundary', () => {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
  const directory = mkdtempSync(join(tmpdir(), 'wl-source-capacity-'));
  const file = join(directory, 'capacity.mts');
  writeFileSync(file, `
import { createRequire } from 'node:module';
import { VideoStudio } from ${JSON.stringify(resolve(root, 'packages/video-studio/src/studio.ts'))};
import { listSharedBridges } from ${JSON.stringify(resolve(root, 'packages/video-studio/src/vendor-compat.ts'))};
const require = createRequire(${JSON.stringify(resolve(root, 'package.json'))});
const entry = require('./vendor/supermickey/hyperreality-system/index.js');
const Original = entry.HyperrealitySystem;
let approvals = 0, renderCalls = 0;
const events = [];
const action = Array.from({ length: 60 }, (_, index) => '林悦按顺序检查编号'+(index+1)+'的红色盒子并合上盖子').join('；');
const source = { shotId: 'S-long', duration: 12, action, fields: { action }, prompt: '01.【动作】按源动作执行。', _workloomPromptReviewPolicy: { noDialogue: true, maxLength: 3000, noCharacters: false, noAnimals: true, noMusic: true, noTitles: true, aspectRatio: '9:16', resolution: '1080x1920', characterNames: ['林悦'], characterPortraits: [], projectProps: [], projectActions: [action] } };
const before = JSON.stringify(source);
function OfflineSystem() {}
OfflineSystem.prototype = Object.create(Original.prototype);
OfflineSystem.prototype.constructor = OfflineSystem;
OfflineSystem.prototype._confirmPrompts = async function() { approvals++; return { approved: true }; };
OfflineSystem.prototype.create = async function() { await this._confirmPrompts([source]); renderCalls++; return { success: true, stages: {} }; };
entry.HyperrealitySystem = OfflineSystem;
try {
 let error = null;
 const studio = new VideoStudio({ llm: { model: 'offline', fastModel: 'offline' }, workDir: ${JSON.stringify(join(directory, 'work'))}, onApproval: async () => ({ approved: true }), log: () => {}, onEvent: event => events.push(event), portraits: { enabled: false } });
 try { await studio.runPreproduction({ projectId: 'capacity', intent: 'source capacity' }); } catch (failure) { error = failure.message; }
 console.log('RESULT '+JSON.stringify({ error, approvals, renderCalls, sourceUnchanged: before === JSON.stringify(source), events, bridges: listSharedBridges() }));
} finally { entry.HyperrealitySystem = Original; }
`);
  try {
    const output = execFileSync(process.execPath, [resolve(root, 'node_modules/tsx/dist/cli.mjs'), file], { cwd: root, encoding: 'utf8', timeout: 90_000, maxBuffer: 5_000_000 });
    const line = output.split('\n').find(value => value.startsWith('RESULT '));
    expect(line).toBeDefined();
    const result = JSON.parse(line!.slice(7));
    expect(result.error).toMatch(/FINAL_PROMPT_SOURCE_CAPACITY_EXCEEDED.*S-long.*3000/u);
    expect(result.approvals).toBe(0);
    expect(result.renderCalls).toBe(0);
    expect(result.sourceUnchanged).toBe(true);
    expect(result.bridges).toEqual([]);
    expect(result.events.some((event: { kind: string }) => event.kind === 'pipeline.failed')).toBe(true);
    expect(result.events.some((event: { kind: string }) => event.kind === 'pipeline.finished')).toBe(false);
  } finally { rmSync(directory, { recursive: true, force: true }); }
}, 100_000);
