/** Per-space environmental facts and physical interaction contracts. Text checks are not visual proof. */
import { shotIntentHash, shotText, splitShotAssertions } from "./shot-intent.js";
import { resolveEraProfile, validateEraProfile, type EraProfile } from "./era-profile.js";

export interface SceneBibleMaterial { item: string; material: string; finish?: string; wear?: string }
export interface SceneBibleLight { type: string; kelvin?: number; direction?: string; count?: number; lit?: number; shade?: string }
export interface SceneBibleSpace {
  city?: string; district?: string; building?: string; areaM2?: number; ceilingM?: number;
  orientation?: string; timeOfDay?: string;
}
export interface EnvironmentProfile {
  setting: "interior" | "exterior" | "studio" | "product";
  /** A clean/new/sterile place is real too; only a deliberately used environment requires traces. */
  condition: "used" | "new" | "maintained" | "sterile" | "natural";
}
interface SpaceEnvironment {
  materials?: SceneBibleMaterial[];
  practicalLights?: SceneBibleLight[];
  traces?: string[];
  colorDiscipline?: string;
  environmentProfile?: EnvironmentProfile;
  eraProfile?: EraProfile;
}
export interface SceneBibleSpaceEntry extends SceneBibleSpace, SpaceEnvironment { spaceId: string }
export interface SceneBible extends SpaceEnvironment {
  spaceId: string;
  space: SceneBibleSpace;
  otherSpaces?: SceneBibleSpaceEntry[];
  materials: SceneBibleMaterial[];
  practicalLights: SceneBibleLight[];
  traces: string[];
}
export interface PropInteraction {
  prop: string;
  /** Explicit purpose; legacy author text can supply a clear operate/present/shared-view verb. */
  purpose?: "operate" | "present" | "shared-view" | "rest";
  orientation: string;
  operatedBy?: string;
  screenFacing?: "operator" | "audience" | "shared" | "away";
  contact?: string;
  occlusion?: string;
}
export interface EnvShotFields {
  shotId?: string; sceneId?: string; scene?: string; sceneDescription?: string; lighting?: string;
  props?: unknown; action?: string; composition?: string; depth_of_field?: string; color_palette?: string; envNarrative?: string;
  propInteraction?: PropInteraction | PropInteraction[];
  environmentProfile?: EnvironmentProfile;
  eraProfile?: EraProfile;
  /** Optional per-shot visibility filter; omitted means the selected space's material list. */
  visibleMaterials?: string[];
}
export interface EnvDefect {
  rule: string; shotId: string; detail: string; hard: boolean; status?: "failed" | "unverified";
}
export class SceneBibleError extends Error {
  readonly status = "unverified";
  constructor(readonly code: string, message: string) { super(message); this.name = "SceneBibleError"; }
}
export const SCENE_BIBLE_POLICY_VERSION = "workloom.scene-bible/v2";
export const GENERIC_SCENE_WORDS = ["简洁", "简约", "现代", "高级", "大气", "通透", "温馨", "氛围感", "干净留白", "宽敞明亮", "商务空间", "样板间"] as const;
const MATERIAL_WORDS = /(胡桃木|橡木|实木|玫瑰木|微水泥|乳胶漆|木饰面|亚麻|棉麻|黄铜|不锈钢|水磨石|大理石|花岗岩|皮革|羊毛|玻璃|水泥|陶|纸质|哑光|拉丝|磨砂|打蜡|清漆|拼缝|岩石|砂石|沙粒|水面|草叶|树皮)/g;
const PRACTICAL_LIGHT_WORDS = /(窗光|日光|阳光|天光|月光|星光|阴天|阴云|散射光|筒灯|射灯|台灯|落地灯|壁灯|灯带|霓虹|屏幕光|烛光|壁炉|路灯|火光)/;
const STUDIO_LIGHT_WORDS = /(柔光箱|反光板|摄影灯|闪光灯|影棚灯|棚灯|柔光板)/;
const TRACE_WORDS = /(痕迹|划痕|水渍|指纹|磨损|锈|褪色|卷边|污渍|灰尘|薄灰|磕痕|旧钉眼|发黄|杯痕|摩[擦蹭]|起毛)/;
const SCREEN_PROP_WORDS = /(手机|平板|笔记本|电脑|屏幕|显示器|iPhone|iPad|MacBook)/i;
const INTERACTIVE_PROP_WORDS = /(手机|平板|遥控器|键盘|鼠标|相机|麦克风|耳机|笔记本电脑|显示器|iPhone|iPad|MacBook)/i;
const ACTIVE_PROP_WORDS = /(手持|握着|拿起|抬手|点按|点击|滑动|输入|操作|读取|演示|展示|使用|看[^；。]{0,10}(手机|屏幕|平板)|敲下|键入)/;
const record = (value: unknown): value is Record<string, unknown> => Boolean(value && typeof value === "object" && !Array.isArray(value));
const nonempty = (value: unknown): value is string => typeof value === "string" && Boolean(value.trim());
const positive = (value: unknown): string => splitShotAssertions(shotText(value)).positive;
const joinOr = (items: readonly (string | undefined | null)[], separator = "；"): string => items.filter((item): item is string => nonempty(item)).join(separator);

export function validateEnvironmentProfile(value: unknown): string[] {
  if (!record(value)) return ["environmentProfile 必须为对象"];
  const issues: string[] = [];
  if (!["interior", "exterior", "studio", "product"].includes(String(value.setting))) issues.push("environmentProfile.setting 必须为 interior/exterior/studio/product");
  if (!["used", "new", "maintained", "sterile", "natural"].includes(String(value.condition))) issues.push("environmentProfile.condition 必须为 used/new/maintained/sterile/natural");
  for (const key of Object.keys(value)) if (key !== "setting" && key !== "condition") issues.push(`environmentProfile 未知字段 ${key}`);
  return issues;
}

function validateSpace(space: unknown, label: string): string[] {
  if (!record(space)) return [`${label} 必须为对象`];
  const issues: string[] = [];
  for (const key of ["city", "district", "building", "orientation", "timeOfDay"]) if (space[key] !== undefined && !nonempty(space[key])) issues.push(`${label}.${key} 必须为非空文字`);
  for (const key of ["areaM2", "ceilingM"]) if (space[key] !== undefined && (typeof space[key] !== "number" || !Number.isFinite(space[key]) || space[key] <= 0)) issues.push(`${label}.${key} 必须为有限正数`);
  if (!["city", "district", "building", "orientation"].some((key) => nonempty(space[key]))) issues.push(`${label} 缺少可指认的空间信息`);
  return issues;
}
function validateEnvironment(value: Record<string, unknown>, label: string, requiredArrays = false): string[] {
  const issues: string[] = [];
  for (const key of ["materials", "practicalLights", "traces"]) {
    if (value[key] === undefined && !requiredArrays) continue;
    if (!Array.isArray(value[key])) issues.push(`${label}.${key} 必须为数组`);
  }
  if (Array.isArray(value.materials)) for (const [index, item] of value.materials.entries()) {
    if (!record(item) || !nonempty(item.item) || !nonempty(item.material)) { issues.push(`${label}.materials[${index}] 缺 item/material`); continue; }
    for (const key of ["finish", "wear"]) if (item[key] !== undefined && !nonempty(item[key])) issues.push(`${label}.materials[${index}].${key} 必须为非空文字`);
  }
  if (Array.isArray(value.practicalLights)) for (const [index, light] of value.practicalLights.entries()) {
    if (!record(light) || !nonempty(light.type)) { issues.push(`${label}.practicalLights[${index}] 缺 type`); continue; }
    if (light.kelvin !== undefined && (typeof light.kelvin !== "number" || !Number.isFinite(light.kelvin) || light.kelvin < 500 || light.kelvin > 50000)) issues.push(`${label}.practicalLights[${index}].kelvin 非法`);
    if (light.count !== undefined && (typeof light.count !== "number" || !Number.isInteger(light.count) || light.count <= 0)) issues.push(`${label}.practicalLights[${index}].count 必须为正整数`);
    if (light.lit !== undefined && (typeof light.lit !== "number" || !Number.isInteger(light.lit) || light.lit < 0 || typeof light.count !== "number" || light.lit > light.count)) issues.push(`${label}.practicalLights[${index}].lit 必须在 0..count 之间`);
    for (const key of ["direction", "shade"]) if (light[key] !== undefined && !nonempty(light[key])) issues.push(`${label}.practicalLights[${index}].${key} 必须为非空文字`);
  }
  if (Array.isArray(value.traces) && !value.traces.every(nonempty)) issues.push(`${label}.traces 只接受非空文字`);
  if (value.colorDiscipline !== undefined && !nonempty(value.colorDiscipline)) issues.push(`${label}.colorDiscipline 必须为非空文字`);
  if (value.environmentProfile !== undefined) issues.push(...validateEnvironmentProfile(value.environmentProfile).map((message) => `${label}: ${message}`));
  if (value.eraProfile !== undefined) issues.push(...validateEraProfile(value.eraProfile).map((message) => `${label}: ${message}`));
  return issues;
}
/** Runtime shape checking, including malformed JSON. Never crashes before producing a diagnostic. */
export function validateSceneBible(value: unknown): string[] {
  if (!record(value)) return ["sceneBible 必须为对象"];
  const issues = [...validateSpace(value.space, "space"), ...validateEnvironment(value, "sceneBible", true)];
  if (!nonempty(value.spaceId)) issues.push("缺 spaceId");
  if (value.otherSpaces !== undefined && !Array.isArray(value.otherSpaces)) issues.push("otherSpaces 必须为数组");
  const seen = new Set([value.spaceId]);
  for (const [index, entry] of (Array.isArray(value.otherSpaces) ? value.otherSpaces : []).entries()) {
    const label = `otherSpaces[${index}]`;
    if (!record(entry)) { issues.push(`${label} 必须为对象`); continue; }
    if (!nonempty(entry.spaceId)) issues.push(`${label} 缺 spaceId`);
    else if (seen.has(entry.spaceId)) issues.push(`${label} 的 spaceId=${entry.spaceId} 重复`);
    seen.add(entry.spaceId);
    issues.push(...validateSpace(entry, label), ...validateEnvironment(entry, label));
  }
  return issues;
}

export interface ResolvedSceneEnvironment {
  spaceId: string; space: SceneBibleSpace; materials: SceneBibleMaterial[];
  practicalLights: SceneBibleLight[]; traces: string[]; colorDiscipline?: string;
  environmentProfile?: EnvironmentProfile; eraProfile?: EraProfile;
}
/** A secondary space never inherits furniture, lamps, wear, colour or profile from the primary room. */
export function resolveSceneEnvironment(bible: SceneBible, requestedSpaceId?: string): ResolvedSceneEnvironment {
  const issues = validateSceneBible(bible);
  if (issues.length) throw new SceneBibleError("SCENE_BIBLE_INVALID", issues.join("；"));
  const spaceId = requestedSpaceId ?? bible.spaceId;
  const selected = spaceId === bible.spaceId ? bible : bible.otherSpaces?.find((entry) => entry.spaceId === spaceId);
  if (!selected) throw new SceneBibleError("SCENE_SPACE_UNKNOWN", `未登记的 sceneId=${spaceId}，不能回退主空间`);
  return {
    spaceId, space: spaceId === bible.spaceId ? bible.space : selected as SceneBibleSpaceEntry,
    materials: selected.materials ?? [], practicalLights: selected.practicalLights ?? [], traces: selected.traces ?? [],
    ...(selected.colorDiscipline !== undefined ? { colorDiscipline: selected.colorDiscipline } : {}),
    ...(selected.environmentProfile !== undefined ? { environmentProfile: selected.environmentProfile } : {}),
    // Era is a project-level story fact; secondary spaces may explicitly declare a flashback.
    ...((selected.eraProfile ?? bible.eraProfile) !== undefined ? { eraProfile: selected.eraProfile ?? bible.eraProfile } : {}),
  };
}
function summaryOfSpace(space: SceneBibleSpace): string {
  return joinOr([joinOr([space.city, space.district], ""), space.building,
    typeof space.areaM2 === "number" ? `约 ${space.areaM2} ㎡` : "", typeof space.ceilingM === "number" ? `层高 ${space.ceilingM}m` : "",
    space.orientation, space.timeOfDay ? `时段 ${space.timeOfDay}` : ""]);
}
export function spaceSummary(bible: SceneBible, spaceId?: string): string { return summaryOfSpace(resolveSceneEnvironment(bible, spaceId).space); }
export function materialsSummary(bible: SceneBible, limit = 4, spaceId?: string): string {
  return resolveSceneEnvironment(bible, spaceId).materials.slice(0, limit).map((item) => joinOr([item.item, item.material, item.finish, item.wear], " · ")).join("；");
}
function lightSummary(lights: SceneBibleLight[]): string {
  return lights.map((light) => joinOr([
    light.count ? `${light.type} ${light.count} 只${typeof light.lit === "number" ? `（开 ${light.lit} 只）` : ""}` : light.type,
    typeof light.kelvin === "number" ? `${light.kelvin}K` : "", light.direction, light.shade,
  ], "，")).join("；");
}
export function practicalLightsSummary(bible: SceneBible, spaceId?: string): string { return lightSummary(resolveSceneEnvironment(bible, spaceId).practicalLights); }

function interactionsOf(shot: EnvShotFields): unknown[] {
  return shot.propInteraction === undefined ? [] : Array.isArray(shot.propInteraction) ? shot.propInteraction : [shot.propInteraction];
}
export function propInteractionDefects(shot: EnvShotFields): EnvDefect[] {
  const shotId = String(shot.shotId ?? "?");
  const defects: EnvDefect[] = [];
  const push = (rule: string, detail: string, status: "failed" | "unverified" = "unverified") => defects.push({ rule, shotId, detail, hard: true, status });
  const action = positive(shot.action);
  const text = positive([shot.scene, shot.sceneDescription, shot.props, shot.action]);
  const interactions = interactionsOf(shot);
  if (INTERACTIVE_PROP_WORDS.test(text) && ACTIVE_PROP_WORDS.test(action) && !interactions.length) {
    push("prop-interaction", "操作/持握/展示道具时缺 propInteraction；须声明用途、朝向、操作者与承重接触");
  }
  // An interaction for a phone must not cover an independently operated keyboard or computer.
  const propGroups = [/(?:手机|iPhone)/i, /(?:平板|iPad)/i, /(?:笔记本|MacBook)/i, /键盘/i, /鼠标/i, /(?:相机|摄像机)/i, /麦克风/i, /遥控器/i];
  for (const clause of action.split(/[；。]/).filter((entry) => ACTIVE_PROP_WORDS.test(entry))) {
    for (const group of propGroups) if (group.test(clause) && interactions.length && !interactions.some((entry) => record(entry) && group.test(shotText(entry.prop)))) {
      push("prop-interaction", `动作「${clause}」中的道具缺对应 propInteraction；其他道具的声明不能代替`);
    }
  }
  for (const [index, raw] of interactions.entries()) {
    if (!record(raw)) { push("prop-interaction", `propInteraction[${index}] 必须为对象`); continue; }
    if (!nonempty(raw.prop) || !nonempty(raw.orientation)) { push("prop-interaction", `propInteraction[${index}] 缺 prop/orientation`); continue; }
    for (const key of ["operatedBy", "contact", "occlusion"]) if (raw[key] !== undefined && !nonempty(raw[key])) push("prop-interaction", `${raw.prop} 的 ${key} 必须为非空文字`);
    if (raw.purpose !== undefined && !["operate", "present", "shared-view", "rest"].includes(String(raw.purpose))) { push("prop-interaction", `${raw.prop} 的 purpose 不受支持`); continue; }
    if (raw.screenFacing !== undefined && !["operator", "audience", "shared", "away"].includes(String(raw.screenFacing))) { push("prop-screen-orientation", `${raw.prop} 的 screenFacing 不受支持`); continue; }
    const purpose = raw.purpose ?? (/向(?:镜头|观众)展示|展示给(?:镜头|观众)/.test(action) ? "present"
      : /共同看|一起看|共享屏幕/.test(action) ? "shared-view"
        : /操作|点按|点击|低头看|读取|输入|滑动|键入/.test(action) ? "operate" : undefined);
    if (purpose !== "rest" && !nonempty(raw.operatedBy)) push("prop-interaction", `道具「${raw.prop}」缺 operatedBy（谁在操作/展示）`);
    if (!nonempty(raw.contact) && !/手持|握|支架|桌面|台面|地面|悬挂|吊架|承重|支撑/.test(raw.orientation)) push("prop-contact", `道具「${raw.prop}」缺承重与接触关系`);
    if (!SCREEN_PROP_WORDS.test(raw.prop)) continue;
    if (purpose === undefined) { push("prop-interaction-intent", `屏幕道具「${raw.prop}」未明确操作、展示或共享用途，不能假定朝内或朝外`); continue; }
    const orientation = positive(raw.orientation);
    const statedFacing = /朝(?:向|着)?(?:观众|镜头)|面向(?:观众|镜头)|正对(?:观众|镜头)/.test(orientation) ? "audience"
      : /共同|共享|两人|双方/.test(orientation) ? "shared"
        : /朝(?:向|着)?(?:主播|使用者|操作者|本人|自己)|面向(?:主播|使用者|操作者|本人)|屏幕朝内|机身背面|观众只见.*背面/.test(orientation) ? "operator"
          : /背向|朝外侧|屏幕朝下|背对/.test(orientation) ? "away" : undefined;
    const facing = raw.screenFacing ?? statedFacing;
    if (raw.screenFacing && statedFacing && raw.screenFacing !== statedFacing) push("prop-screen-orientation", `${raw.prop} 的 screenFacing 与 orientation 描述冲突`, "failed");
    if (!facing) push("prop-screen-orientation", `屏幕道具「${raw.prop}」缺可核对的 screenFacing 或明确朝向`);
    else if (purpose === "operate" && facing !== "operator" && facing !== "shared") push("prop-screen-orientation", `「${raw.prop}」用途是操作/读取，朝向 ${facing} 与操作者读取合同冲突`, "failed");
    else if (purpose === "present" && facing !== "audience" && facing !== "shared") push("prop-screen-orientation", `「${raw.prop}」用途是向观众展示，朝向 ${facing} 未实现展示合同`, "failed");
    else if (purpose === "shared-view" && facing !== "shared") push("prop-screen-orientation", `「${raw.prop}」用途是共享观看，需声明双方可见的 shared 朝向`, "failed");
  }
  return defects;
}
export function propInteractionSummary(shot: EnvShotFields): string {
  return interactionsOf(shot).filter(record).map((item) => joinOr([
    `${shotText(item.prop)}：${shotText(item.orientation)}`, item.purpose ? `用途 ${shotText(item.purpose)}` : "",
    item.screenFacing ? `屏幕朝向 ${shotText(item.screenFacing)}` : "", item.operatedBy ? `由${shotText(item.operatedBy)}操作/展示` : "",
    shotText(item.contact), shotText(item.occlusion),
  ], "，")).join("；");
}
export function propInteractionPromptLines(shot: EnvShotFields): string[] {
  const defects = propInteractionDefects(shot);
  if (defects.length) throw new SceneBibleError("PROP_INTERACTION_INVALID", defects.map((entry) => entry.detail).join("；"));
  const summary = propInteractionSummary(shot);
  return summary ? [`道具交互合同：${summary}。朝向与用途、操作者视线、接触及遮挡关系按此执行。`] : [];
}

export function environmentProfilePromptLines(profile?: EnvironmentProfile): string[] {
  if (profile === undefined) return [];
  const issues = validateEnvironmentProfile(profile);
  if (issues.length) throw new SceneBibleError("ENVIRONMENT_PROFILE_INVALID", issues.join("；"));
  const setting = { interior: "室内实景", exterior: "室外实景", studio: "摄影棚", product: "产品拍摄" }[profile.setting];
  const condition = { used: "已使用，保留声明的真实使用痕迹", new: "全新，保留真实制造工艺但不编造磨损", maintained: "经维护清洁，状态与原卡一致", sterile: "洁净无菌，保持声明的洁净表面", natural: "自然环境，纹理与气候状态按原场景" }[profile.condition];
  return [`环境档案：${setting}；${condition}。${profile.setting === "studio" || profile.setting === "product" ? "按已声明的影棚或产品光源布光。" : "光源、时段与阴影按本镜场景事实。"}`];
}

function textOf(shot: EnvShotFields): string { return positive([shot.scene, shot.sceneDescription, shot.props, shot.composition, shot.action, shot.envNarrative]); }
export function environmentDefects(shots: readonly EnvShotFields[], bible?: SceneBible | null): EnvDefect[] {
  const defects: EnvDefect[] = [];
  const push = (rule: string, shotId: string, detail: string, hard = true, status: "failed" | "unverified" = "failed") => defects.push({ rule, shotId, detail, hard, status });
  const bibleIssues = bible ? validateSceneBible(bible) : [];
  for (const issue of bibleIssues) push("scene-bible", record(bible) && typeof bible.spaceId === "string" ? bible.spaceId : "?", issue, true, "unverified");
  for (const shot of shots) {
    if (!shot || typeof shot !== "object" || Array.isArray(shot)) { push("environment-input", "?", "镜头必须为对象", true, "unverified"); continue; }
    const shotId = String(shot.shotId ?? "?");
    const text = textOf(shot);
    let selected: ResolvedSceneEnvironment | undefined;
    if (bible && !bibleIssues.length) {
      try { selected = resolveSceneEnvironment(bible, shot.sceneId); }
      catch (error) { push("space-continuity", shotId, error instanceof Error ? error.message : String(error)); }
    }
    const profile = shot.environmentProfile ?? selected?.environmentProfile;
    const profileIssues = profile === undefined ? [] : validateEnvironmentProfile(profile);
    for (const issue of profileIssues) push("environment-profile", shotId, issue, true, "unverified");
    if (!nonempty(shot.scene) && !nonempty(shot.sceneDescription)) push("space-specificity", shotId, "本镜缺可指认的场景描述", true, "unverified");
    const generic = GENERIC_SCENE_WORDS.filter((word) => text.includes(word));
    const materialHits = new Set(text.match(MATERIAL_WORDS) ?? []);
    if (generic.length && materialHits.size === 0) push("generic-wording", shotId, `场景只有风格词且无材质线索：${generic.join("、")}；补与画面任务相关的具体表面或空间描述`, false, "unverified");
    if (profile && !profileIssues.length) {
      const minimum = profile.setting === "interior" ? 2 : profile.setting === "product" ? 1 : 0;
      if (materialHits.size < minimum) push("material-depth", shotId, `${profile.setting} 环境的可见材质/工艺线索不足（${materialHits.size}/${minimum}）；只要求可见对象，不向空镜强塞家具`, true, "unverified");
      const lighting = positive(shot.lighting);
      const validLight = PRACTICAL_LIGHT_WORDS.test(lighting) || ((profile.setting === "studio" || profile.setting === "product") && STUDIO_LIGHT_WORDS.test(lighting));
      if (!validLight) push("practical-light", shotId, `${profile.setting} 环境缺适用光源描述；室外可用日光/天光/月光，产品或影棚可用棚灯`, true, "unverified");
      if (profile.condition === "used" && !TRACE_WORDS.test(text)) push("usage-traces", shotId, "环境档案明确为 used，但本镜没有声明实际可见的使用状态", true, "unverified");
    } else if (!nonempty(shot.lighting)) push("practical-light", shotId, "未给灯光或环境档案，光照保持未验证", false, "unverified");
    defects.push(...propInteractionDefects(shot));
    const optic = positive(shot.depth_of_field);
    if (!optic) push("optic-signature", shotId, "未声明本镜清晰范围；不自动替作者选择浅景深", false, "unverified");
  }
  return defects;
}

interface SceneContribution { field: string; before?: unknown; hadField: boolean; suffix: string; afterHash: string }
interface SceneExpansion {
  schemaVersion: typeof SCENE_BIBLE_POLICY_VERSION; spaceId: string; environmentHash: string;
  contributions: SceneContribution[]; defaults: Array<{ field: string; hash: string }>;
}
const META = "_workloomSceneBible";
const ENV_FIELDS = new Set(["scene", "sceneDescription", "lighting", "props", "color_palette"]);
/** Restore only verified owned contributions. Metadata is provenance for editing, never approval. */
function restoreExpansion<T extends EnvShotFields & Record<string, unknown>>(input: T): T {
  const next = { ...input };
  const raw = input[META];
  if (raw === undefined) return next;
  if (!record(raw) || raw.schemaVersion !== SCENE_BIBLE_POLICY_VERSION || !Array.isArray(raw.contributions) || !Array.isArray(raw.defaults)) throw new SceneBibleError("SCENE_EXPANSION_UNVERIFIED", "场景展开来源结构无效，不能猜测删除旧文本");
  for (const item of raw.contributions) {
    if (!record(item) || typeof item.field !== "string" || !ENV_FIELDS.has(item.field) || typeof item.suffix !== "string" || !item.suffix || typeof item.hadField !== "boolean") throw new SceneBibleError("SCENE_EXPANSION_UNVERIFIED", "场景展开来源条目非法");
    const before = item.before;
    if (before !== undefined && before !== null && typeof before !== "string") throw new SceneBibleError("SCENE_EXPANSION_UNVERIFIED", "场景原字段不是文字");
    const after = (before ?? "") + item.suffix;
    if (item.afterHash !== shotIntentHash(after) || typeof next[item.field] !== "string" || !(next[item.field] as string).endsWith(item.suffix)) throw new SceneBibleError("SCENE_EXPANSION_UNVERIFIED", `字段 ${item.field} 的旧场景贡献被改写，需明确原始卡再展开`);
    const current = next[item.field] as string;
    const restored = current.slice(0, -item.suffix.length);
    if (current === after) { if (item.hadField) next[item.field as keyof T] = before as T[keyof T]; else delete next[item.field]; }
    else next[item.field as keyof T] = restored as T[keyof T];
  }
  for (const item of raw.defaults) {
    if (!record(item) || typeof item.field !== "string" || !["sceneId", "environmentProfile", "eraProfile"].includes(item.field) || typeof item.hash !== "string") throw new SceneBibleError("SCENE_EXPANSION_UNVERIFIED", "场景默认字段来源无效");
    if (next[item.field] !== undefined && shotIntentHash(next[item.field]) === item.hash) delete next[item.field];
  }
  delete next[META];
  return next;
}

/** Append only facts from the selected space. Explicit per-shot light and colour take precedence. */
export function expandShotWithBible<T extends EnvShotFields & Record<string, unknown>>(input: T, bible: SceneBible): T & EnvShotFields & Record<string, unknown> {
  if (!record(input)) throw new SceneBibleError("SCENE_SHOT_INVALID", "镜头必须为对象");
  const shot = restoreExpansion(input);
  const selected = resolveSceneEnvironment(bible, shot.sceneId);
  if (shot.visibleMaterials !== undefined && (!Array.isArray(shot.visibleMaterials) || !shot.visibleMaterials.every(nonempty) || new Set(shot.visibleMaterials).size !== shot.visibleMaterials.length)) throw new SceneBibleError("SCENE_VISIBILITY_INVALID", "visibleMaterials 必须为不重复物件名数组");
  if (shot.visibleMaterials?.some((item) => !selected.materials.some((entry) => entry.item === item))) throw new SceneBibleError("SCENE_VISIBILITY_INVALID", "visibleMaterials 含所选空间没有登记的物件");
  const materials = selected.materials.filter((item) => shot.visibleMaterials === undefined || shot.visibleMaterials.includes(item.item));
  const materialText = materials.map((item) => joinOr([item.item, item.material, item.finish, item.wear], " · ")).join("；");
  const interaction = propInteractionSummary(shot);
  const contributions: SceneContribution[] = [];
  const defaults: SceneExpansion["defaults"] = [];
  const next = { ...shot };
  const append = (field: string, addition: string) => {
    if (!addition) return;
    const before = shot[field];
    if (before !== undefined && before !== null && typeof before !== "string") throw new SceneBibleError("SCENE_FIELD_INVALID", `${field} 是结构化字段，不能覆盖成拼接文字`);
    const suffix = (nonempty(before) ? "；" : "") + addition;
    const after = (before ?? "") + suffix;
    next[field as keyof T] = after as T[keyof T];
    contributions.push({ field, before, hadField: Object.hasOwn(shot, field), suffix, afterHash: shotIntentHash(after) });
  };
  append("scene", summaryOfSpace(selected.space));
  append("sceneDescription", joinOr([shot.envNarrative, selected.traces.length ? `使用状态：${selected.traces.join("、")}` : ""]));
  if (!nonempty(shot.lighting)) append("lighting", lightSummary(selected.practicalLights));
  append("props", joinOr([materialText ? `材质与工艺：${materialText}` : "", interaction ? `道具交互：${interaction}` : ""]));
  if (!nonempty(shot.color_palette)) append("color_palette", selected.colorDiscipline ?? "");
  const inherit = (field: string, value: unknown) => {
    if (shot[field] === undefined && value !== undefined) { next[field as keyof T] = value as T[keyof T]; defaults.push({ field, hash: shotIntentHash(value) }); }
  };
  inherit("sceneId", selected.spaceId);
  inherit("environmentProfile", selected.environmentProfile);
  inherit("eraProfile", selected.eraProfile ? resolveEraProfile(selected.eraProfile) : undefined);
  next[META as keyof T] = { schemaVersion: SCENE_BIBLE_POLICY_VERSION, spaceId: selected.spaceId, environmentHash: shotIntentHash(selected), contributions, defaults } as T[keyof T];
  return next as T & EnvShotFields & Record<string, unknown>;
}

export function sceneBiblePromptLines(bible: SceneBible, shot: EnvShotFields): string[] {
  const selected = resolveSceneEnvironment(bible, shot.sceneId);
  const visible = selected.materials.filter((item) => shot.visibleMaterials === undefined || shot.visibleMaterials.includes(item.item));
  return [
    `空间实指：${summaryOfSpace(selected.space)}`,
    ...(visible.length ? [`材质与工艺：${visible.map((item) => joinOr([item.item, item.material, item.finish, item.wear], " · ")).join("；")}`] : []),
    ...(nonempty(shot.lighting) ? [`本镜光源：${shot.lighting}`] : selected.practicalLights.length ? [`实用光源：${lightSummary(selected.practicalLights)}`] : []),
    ...(selected.traces.length ? [`使用状态：${selected.traces.join("、")}`] : []),
    ...environmentProfilePromptLines(shot.environmentProfile ?? selected.environmentProfile),
    ...propInteractionPromptLines(shot),
  ];
}
export function summarizeDefects(defects: readonly EnvDefect[]): { hard: number; soft: number; byRule: Record<string, number> } {
  const byRule: Record<string, number> = {}; let hard = 0; let soft = 0;
  for (const defect of defects) { byRule[defect.rule] = (byRule[defect.rule] ?? 0) + 1; if (defect.hard) hard += 1; else soft += 1; }
  return { hard, soft, byRule };
}
