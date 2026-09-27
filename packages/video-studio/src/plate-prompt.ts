/** Compile a plate from the recovered shot intent and its explicit visual contracts. */
import { normalizeShotIntent, shotText, splitShotAssertions } from "./shot-intent.js";
import { DEVICE_PRESENCE_PATTERNS, devicePolicyPromptLines, type DeviceShotFields } from "./device-policy.js";
import { environmentProfilePromptLines, expandShotWithBible, propInteractionPromptLines, sceneBiblePromptLines, type EnvShotFields, type SceneBible } from "./scene-bible.js";
import type { EraProfile } from "./era-profile.js";

export interface PlatePromptShot {
  shotId?: string; costume?: string; makeup?: string; props?: unknown; scene?: string;
  sceneDescription?: string; action?: string; composition?: string; lighting?: string;
  color_palette?: string; depth_of_field?: string; mood?: string;
  [key: string]: unknown;
}
export interface PlatePromptOptions {
  characterName: string; appearanceText?: string; aspect?: string; resolution?: string; title?: string;
  eraProfile?: EraProfile; sceneBible?: SceneBible;
}
export const UNIVERSAL_SPATIAL_INVARIANT =
  "场景结构与物理自洽（通用）：可见建筑、地形与器物有真实结构、落点与支撑；同一空间的透视、尺度、光向与阴影自洽。"
  + "接触处有对应承重与遮挡，不出现悬空构件、结构断裂、穿模或无来由的延伸；画外结构不强行挤入当前构图。";
export const BRIDGE_STRUCTURE_CONSTRAINT =
  "桥类结构（本镜硬约束）：在当前构图可见范围内，桥面、栏杆、桥台与岸线的连接和承重成立，水位与桥体结构相符；"
  + "全景有连接关系时不得画成无来由的悬空步道。特写或画外桥头不要求同时看见两岸，不改变原景别补造拱洞或栏杆。";
export const ENVIRONMENT_REALISM_CONSTRAINT =
  "环境真实性（通用）：依据本镜声明的场所、材质、工艺、可见范围、光源和使用状态呈现真实空间；"
  + "旧环境保留已声明痕迹，全新、洁净或自然环境按其档案呈现；影棚与产品可使用已声明的棚灯。"
  + "不编造其他空间的家具、磨损、光源或装饰，不把抽象风格词当空间事实。";
export const PROP_INTERACTION_CONSTRAINT =
  "道具与人体交互（本镜硬约束）：按声明用途执行朝向与视线——操作时操作者可读，展示时观众可见，共享时双方可见；"
  + "手、支架或台面提供真实接触与承重，遮挡和关节成立；静置物件不添加操作人。";
export const DEVICE_STANDARD_CONSTRAINT =
  "设备口径（本镜硬约束）：逐台遵守已核实的具体型号、世代、冻结故事日期与明确设备档案；"
  + "外观比例、材质、颜色与接口一致，不使用未声明的替代型号或跨帧变换机型。";
const positive = (shot: PlatePromptShot): string => splitShotAssertions(shotText([shot.scene, shot.sceneDescription, shot.props, shot.composition, shot.action])).positive;
export function isBridgeScene(shot: PlatePromptShot): boolean { return /桥|栈道|廊桥/.test(positive(shot)); }
export function hasInteractiveProp(shot: PlatePromptShot): boolean { return /(手机|平板|遥控器|键盘|鼠标|相机|麦克风|耳机|笔记本|电脑|显示器|屏幕)/.test(positive(shot)); }
export function hasElectronicDevice(shot: PlatePromptShot): boolean {
  return (Array.isArray(shot.devices) ? shot.devices.length > 0 : shot.devices !== undefined)
    || DEVICE_PRESENCE_PATTERNS.some((entry) => entry.pattern.test(positive(shot)));
}
export function plateAspectLabel(aspect: string): string {
  const match = /^(\d+(?:\.\d+)?):(\d+(?:\.\d+)?)$/.exec(aspect);
  const width = Number(match?.[1]); const height = Number(match?.[2]);
  if (!match || !Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0 || width / height > 10 || height / width > 10) throw new Error(`PLATE_ASPECT_INVALID: ${aspect}`);
  return width > height ? "横幅" : width < height ? "竖幅" : "方幅";
}

/** No unrequested person, white balance, depth or number of faces is inserted. */
export function buildPlatePrompt(shot: PlatePromptShot, options: PlatePromptOptions): string {
  if (options.sceneBible !== undefined) shot = expandShotWithBible(shot, options.sceneBible);
  const intent = normalizeShotIntent(shot);
  if (intent.subject.kind === "unknown") throw new Error("PLATE_SUBJECT_UNVERIFIED: 原镜头主体未明确");
  const aspect = options.aspect ?? "9:16";
  const aspectLabel = plateAspectLabel(aspect);
  const resolution = options.resolution ?? "1080p";
  if (typeof resolution !== "string" || !resolution.trim()) throw new Error("PLATE_RESOLUTION_INVALID");
  const pick = (key: string): string => shotText(shot[key] ?? (shot.fields as Record<string, unknown> | undefined)?.[key]);
  const line = (label: string, value: string): string[] => value.trim() ? [`${label}${value}`] : [];
  const envShot = shot as EnvShotFields;
  const deviceShot = shot as DeviceShotFields;
  const environmental = options.sceneBible ? sceneBiblePromptLines(options.sceneBible, envShot)
    : [...environmentProfilePromptLines(envShot.environmentProfile), ...propInteractionPromptLines(envShot)];
  const person = intent.subject.hasPerson;
  const single = person && intent.subject.count === 1;
  const role = pick("character") || pick("characters") || pick("cast") || (single ? options.characterName : "");
  const lines = [
    `【关键帧】${pick("shotId")} ${options.title ?? ""}`.trim(),
    `主体合同：${person ? `人物；${intent.subject.count === null ? "人数按原卡群体构图" : `人数 ${intent.subject.count}`}；${intent.subject.faceVisible ? "脸部可见" : "脸部不在可见范围，不补正脸"}` : `${intent.subject.kind}；无人物，不添加默认角色`}`,
    ...(person ? [...line("角色：", role), ...(single ? line("人物外貌（本角色合同）：", options.appearanceText ?? "") : []), ...line("服装：", pick("costume")), ...line("妆造：", pick("makeup"))] : []),
    ...line("道具与质感：", pick("props")), ...line("场景：", pick("scene")), ...line("环境细节：", pick("sceneDescription")),
    ...line(person ? "人物动作与表情（这一帧的瞬间）：" : "主体状态与画面动作：", pick("action")),
    ...line("构图：", pick("composition")), ...line("景深：", pick("depth_of_field")),
    ...line("光线：", pick("lighting")), ...line("色调：", pick("color_palette")), ...line("情绪：", pick("mood")),
    `规格：${aspect} ${aspectLabel} ${resolution}，写实摄影${person && intent.subject.faceVisible ? "，可见皮肤保留自然质感" : ""}；光源、白平衡与清晰范围服从原镜头。`,
    UNIVERSAL_SPATIAL_INVARIANT, ENVIRONMENT_REALISM_CONSTRAINT,
    ...(isBridgeScene(shot) ? [BRIDGE_STRUCTURE_CONSTRAINT] : []), ...environmental,
    ...(hasInteractiveProp(shot) ? [PROP_INTERACTION_CONSTRAINT] : []),
    ...devicePolicyPromptLines(deviceShot, { eraProfile: options.eraProfile }),
    ...(hasElectronicDevice(shot) ? [DEVICE_STANDARD_CONSTRAINT] : []),
    "禁止：未要求的文字、字幕、水印、logo，非写实渲染，超出主体合同的人物或肢体，悬空无落点的建筑结构。",
  ];
  return lines.join("\n");
}
