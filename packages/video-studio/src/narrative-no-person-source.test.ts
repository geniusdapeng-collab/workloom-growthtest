import { describe, expect, it } from 'vitest';
import { applyNarrativeFinalPromptContract } from './vendor-compat.js';

const cases = [
  { name: 'unoccupied kitchen', scene: '无人现代厨房，燃气灶与电热水壶位于石英台面', lighting: '4000K吊柜灯照亮石英台面，窗外为夜色', action: '电热水壶指示灯亮起，壶嘴蒸汽缓慢上升', props: ['燃气灶', '电热水壶', '石英台面'], audio: '水壶沸腾声', noAnimals: true },
  { name: 'product in an empty showroom', scene: '无人商品展厅，银色电饭煲放在黑色电动转台上', lighting: '5600K摄影棚柔光箱与右侧轮廓灯', action: '电动转台匀速旋转，电饭煲显示屏亮起', props: ['银色电饭煲', '黑色电动转台', '显示屏'], audio: '转台电机低鸣声', noAnimals: true },
  { name: 'city architecture without people', scene: '无人城市广场，玻璃幕墙建筑与LED路灯沿道路排列', lighting: '蓝调时刻的自然天光与3000K路灯同时存在', action: '建筑外墙LED灯带从左向右逐段点亮', props: ['玻璃幕墙建筑', 'LED路灯', '建筑外墙LED灯带'], audio: '远处车辆行驶声', noAnimals: false },
];

describe.each([false, true])('no-person contract preserves the declared environment (canonicalize=%s)', canonicalize => {
  it.each(cases)('$name', source => {
    const shot = { shotId: 'S1', duration: 8, scene: source.scene, lighting: source.lighting, action: source.action, props: source.props, audio: source.audio, camera_movement: '固定机位', prompt: [
      `01.【场景】${source.scene}`, `02.【灯光设计】${source.lighting}`, `03.【动作】${source.action}`, `04.【道具】${source.props.join('、')}`, `05.【音频】${source.audio}`, '06.【角色】无人出场', '07.【负面约束】无人物',
    ].join('\n') };
    const before = structuredClone(shot);
    const result = applyNarrativeFinalPromptContract(shot, { noDialogue: true, noMusic: true, noCharacters: true, noAnimals: source.noAnimals, chineseOnly: true, maxLength: 3000, canonicalize, projectScene: source.scene, projectLighting: source.lighting, projectProps: source.props, projectActions: [source.action] });
    const prompt = String(result.prompt);
    expect(prompt).toContain(source.scene);
    expect(prompt).toContain(source.lighting);
    expect(prompt).toContain(source.action);
    for (const prop of source.props) expect(prompt).toContain(prop);
    expect(prompt).toContain(source.audio);
    expect(prompt).not.toMatch(/湖面|芦苇|山体|薄雾|水痕|水面涟漪|无船只|无建筑|无现代设备|无人工光源|不添加人工道具/u);
    if (source.noAnimals) expect(prompt).toContain('无动物');
    else expect(prompt).not.toMatch(/无动物|无飞鸟/u);
    expect(shot).toEqual(before);
    expect(prompt.length).toBeLessThanOrEqual(3000);
  });
});

it.each([false, true])('keeps an explicitly declared source prohibition on buildings or devices (canonicalize=%s)', canonicalize => {
  const result = applyNarrativeFinalPromptContract({ shotId: 'S1', duration: 8, action: '树叶随风摆动', scene: '树林空镜', negative: '无建筑、无现代设备', prompt: '01.【场景】树林空镜\n02.【负面约束】无建筑、无现代设备' }, { noDialogue: true, noCharacters: true, noAnimals: true, canonicalize, chineseOnly: true, maxLength: 3000, projectScene: '树林空镜', projectActions: ['树叶随风摆动'], projectProps: ['树叶'] });
  expect(result.prompt).toContain('无建筑');
  expect(result.prompt).toContain('无现代设备');
});

it('an animal without people keeps its actual surface and prop evidence', () => {
  const action = '白狗在干燥阳台抬起前爪伸向树叶';
  const result = applyNarrativeFinalPromptContract({ shotId: 'DOG-1', duration: 8, action, scene: '白天干燥阳台', props: ['树叶'], lighting: '自然日光' }, { noDialogue: true, noCharacters: true, noAnimals: false, canonicalize: true, maxLength: 3000, characterNames: ['白狗'], projectScene: '白天干燥阳台', projectLighting: '自然日光', projectActions: [action], projectProps: ['树叶'] });
  expect(result.prompt).toContain(action);
  expect(result.prompt).not.toMatch(/橘猫|纸箱|屋檐|湿毛/u);
});
