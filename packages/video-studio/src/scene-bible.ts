/**
 * scene-bible.ts —— **场景圣经 · 环境真实性**（2026-09-27 真机事故沉淀）
 *
 * 事故：销售口播片 8 镜全部通过监制，但产品所有者一眼看出"空间布景不像实拍、像随意口播"。
 * 逐镜取证的结论是**必然**的：8/8 镜缺"空间实指"与"使用痕迹"，7/8 镜的"灯光"只写柔光箱/反光板
 * 这类棚具语言，材质全部停留在一级名词（"原木/浅色墙"）。模型拿到"现代明亮的商务空间"这种空词时，
 * 只能落回训练分布里的**平均办公室**——平均化正是"AI 感"的定义。
 *
 * 本模块把"像实拍"拆成可校验的四件事，并给出两个能力：
 *   ① `validateSceneBible` / `environmentDefects`：把空词、材质深度、实用光源、使用痕迹、
 *      空间实指、道具交互、空间连续性、光学签名变成**确定性判据**（零 token，可进 CI 与渲染前闸）；
 *   ② `expandShotWithBible`：把场景圣经**展开进镜头卡既有字段**（scene/sceneDescription/lighting/props），
 *      这样关键帧提示词（plate-prompt）与视频提示词（vendor 组装器）都能吃到，不需要改 vendor 字段规范。
 *
 * 纪律：真实参考图只作实景依据，不得复刻构图（沿用 material-scene/v1）。
 */

export interface SceneBibleMaterial {
  /** 物件名（"会议桌""墙面""地面"） */
  item: string;
  /** 材质（"1960 年代丹麦胡桃木/玫瑰木贴面"） */
  material: string;
  /** 工艺/表面处理（"哑光打蜡""1.5mm 顺纹拼缝"） */
  finish?: string;
  /** 使用状态/磨损（"中央咖啡杯痕、边缘 2cm 磕痕"） */
  wear?: string;
}

export interface SceneBibleLight {
  /** 光源类型（"窗光""天花筒灯""桌上台灯""屏幕余光"） */
  type: string;
  /** 色温（K）；实用光源必须给 */
  kelvin?: number;
  /** 方向/来源（"东北向侧逆光，亚麻纱帘柔化"） */
  direction?: string;
  /** 数量与点亮数量（筒灯 4 只开 2 只） */
  count?: number;
  lit?: number;
  /** 灯罩/灯具细节（"米白纸质灯罩"） */
  shade?: string;
}

export interface SceneBibleSpace {
  city?: string;
  district?: string;
  /** 建筑实指（"1930 年代原法租界银行改建办公楼 18 层会议室"） */
  building?: string;
  areaM2?: number;
  ceilingM?: number;
  /** 朝向/窗位（"东侧整面带纱帘落地窗"） */
  orientation?: string;
  /** 时段（"上午 10:20"） */
 timeOfDay?: string;
}

/** 同一支片子里的**其他**空间（门店/客户现场/街景…）：每镜用 `shot.sceneId` 指认归属 */
export interface SceneBibleSpaceEntry extends SceneBibleSpace {
  spaceId: string;
}

/** 片级场景圣经：整片共用一间/一套真实空间，避免"每镜一个样板间" */
export interface SceneBible {
  /** 空间标识；同一支片子的各镜默认同属这个空间 */
  spaceId: string;
  space: SceneBibleSpace;
  /**
   * 其他空间（可选）：销售片常见的"总部 + 客户现场"两处空间。
   * 纪律：出现在别的空间里的镜头**必须**用 `shot.sceneId` 显式指认；指认不到圣经里的空间即判红
   * （"每镜一个样板间"与"换场景没交代"是同一类事故）。
   */
  otherSpaces?: SceneBibleSpaceEntry[];
  materials: SceneBibleMaterial[];
  practicalLights: SceneBibleLight[];
  /** 使用痕迹（真实感的来源：指纹/水渍/卷边/划痕/薄灰/黄叶…） */
  traces: string[];
  /** 色彩纪律（"低饱和写实；肤色中性不偏黄；暗部保留材质纹理"） */
  colorDiscipline?: string;
}

/** 可交互道具的物理关系（"手机屏幕朝观众"这类 badcase 的机制解） */
export interface PropInteraction {
  /** 道具（"手机""平板""笔记本""咖啡杯"） */
  prop: string;
  /** 朝向（"屏幕朝向主播本人，观众只见机身背面与侧缘"） */
  orientation: string;
  /** 谁在操作（"主播右手食指"） */
  operatedBy: string;
  /** 接触/承重（"手机立于桌面支架，屏幕与桌面夹角 70°"） */
  contact?: string;
  /** 遮挡关系（"手指挡住屏幕下缘 1/5"） */
  occlusion?: string;
}

/** 镜头卡里与"环境真实性"相关的字段（可增量扩展，未知字段不影响） */
export interface EnvShotFields {
  shotId?: string;
  /** 空间标识（缺省=片级 spaceId） */
  sceneId?: string;
  scene?: string;
  sceneDescription?: string;
  lighting?: string;
  props?: string;
  action?: string;
  composition?: string;
  depth_of_field?: string;
  /** 本镜的环境叙事任务（"桌面档案与杯痕让人读出这里刚开完一场会"） */
  envNarrative?: string;
  /** 可交互道具的物理关系（1 个或数组） */
  propInteraction?: PropInteraction | PropInteraction[];
}

export interface EnvDefect {
  rule: string;
  shotId: string;
  detail: string;
  /** 硬闸：必须修才能渲 */
  hard: boolean;
}

/** 空词黑名单：出现即视为"没有实指"，必须替换成具体空间/材质/光源描述 */
export const GENERIC_SCENE_WORDS = [
  "简洁", "简约", "现代", "高级", "大气", "通透", "温馨", "氛围感",
  "干净留白", "宽敞明亮", "商务空间", "样板间",
] as const;

/** 材质关键词（要求"材质 + 工艺/状态"，单纯"原木"不算深度） */
const MATERIAL_WORDS = /(胡桃木|橡木|实木|玫瑰木|微水泥|乳胶漆|木饰面|亚麻|棉麻|黄铜|不锈钢|水磨石|大理石|花岗岩|皮革|羊毛|玻璃|水泥|陶|纸质|哑光|拉丝|磨砂|打蜡|清漆|拼缝|做旧)/g;
/** 实用光源关键词（棚具语言不算） */
const PRACTICAL_LIGHT_WORDS = /(窗光|日光|天光|筒灯|射灯|台灯|落地灯|壁灯|灯带|霓虹|屏幕光|烛光|壁炉)/;
/** 使用痕迹关键词 */
const TRACE_WORDS = /(痕迹|划痕|水渍|指纹|磨损|锈|褪色|卷边|污渍|灰尘|薄灰|磕痕|旧钉眼|发黄|杯痕|摩[擦蹭]|起毛)/;
/**
 * 必须声明物理关系的道具（2026-09-27 二次校准）：
 * 只收"会被手持/操作"的一类——屏幕设备（有朝向语义）+ 手持器材。
 * 杯子/笔/书/椅/门这类静置道具**不强制**（否则每一镜都被判红，规则失去信号）。
 */
const HANDHELD_PROP_WORDS = /(手机|平板|遥控器|键盘|鼠标|相机|麦克风|耳机)/;
/**
 * 桌面设备（笔记本/电脑/屏幕）：只有在"在用/亮屏/被操作"时才要求声明朝向与操作关系（合盖静置不要求）。
 * 2026-09-27 收紧：早先的 `打开` 单独成词，把"肩背打开"这类**人体动作**误判成"设备在使用"
 * （模板 18 镜实测：GR-06 的合盖笔记本被误判要求声明物理关系）。判据必须只认设备语境的词。
 */
const DESK_DEVICE_WORDS = /(笔记本|电脑|屏幕|显示器)/;
const DESK_DEVICE_IN_USE = /(亮屏|开机|正在用|正在操作|点按|滑动|输入|看屏幕|读取屏幕|屏幕朝|使用中|打开电脑|打开笔记本|敲下|键入)/;
/** 屏幕类道具（必须有屏幕朝向声明） */
const SCREEN_PROP_WORDS = /(手机|平板|笔记本|电脑|屏幕|显示器)/;

function textOf(shot: EnvShotFields): string {
  return [shot.scene, shot.sceneDescription, shot.props, shot.composition, shot.action, shot.envNarrative]
    .map((value) => String(value ?? ""))
    .join(" ");
}

function interactionsOf(shot: EnvShotFields): PropInteraction[] {
  const raw = shot.propInteraction;
  if (!raw) return [];
  const list = Array.isArray(raw) ? raw : [raw];
  return list.filter((entry): entry is PropInteraction => Boolean(entry && typeof entry === "object"));
}

function specificityHits(space: SceneBibleSpace, sceneText: string): string[] {
  const hits: string[] = [];
  if (space.city && sceneText.includes(space.city)) hits.push(`城市:${space.city}`);
  if (space.building && sceneText.includes(space.building.slice(0, 6))) hits.push("建筑");
  if (space.district && sceneText.includes(space.district)) hits.push("地段");
  if (space.orientation) hits.push("朝向");
  if (space.timeOfDay) hits.push("时段");
  if (typeof space.areaM2 === "number") hits.push("面积");
  if (typeof space.ceilingM === "number") hits.push("层高");
  if (/\d{4}\s*年代|\d{4}\s*年/.test(sceneText)) hits.push("年代");
  return hits;
}

/**
 * 逐镜"空间实指"命中（只看**镜头文本本身**是否带实指，而不是看圣经写没写）：
 * 真机上"圣经写了、但镜头卡没带"正是"模型只收到空词"的形态，必须判红。
 */
function specificityHitsInText(text: string): string[] {
  const hits: string[] = [];
  if (/\d{4}\s*年代|\d{4}\s*年/.test(text)) hits.push("年代");
  if (/(市|区|路|街|外滩|陆家嘴|天际线)/.test(text)) hits.push("地段/城市");
  if (/(层高|㎡|平方米|米高|\d+\s*m\s*[×x]\s*\d+\s*m)/i.test(text)) hits.push("尺度");
  if (/(落地窗|纱帘|朝向|东侧|西侧|南向|北向|窗光)/.test(text)) hits.push("朝向/窗位");
  if (/(上午|下午|清晨|黄昏|傍晚|夜间|时段|\d{1,2}[:：]\d{2})/.test(text)) hits.push("时段");
  if (/(会议室|办公室|车间|门店|大厅|书房|厨房|卧室|厂房|茶室)/.test(text)) hits.push("空间类型");
  return hits;
}

/** 场景圣经自身的完备性（硬错误逐条返回） */
export function validateSceneBible(bible: SceneBible): string[] {
  const issues: string[] = [];
  if (!bible.spaceId?.trim()) issues.push("缺 spaceId");
  const hits = specificityHits(bible.space, `${bible.space.building ?? ""} ${bible.space.orientation ?? ""}`);
  if (hits.length < 3) issues.push(`空间实指不足（当前 ${hits.length} 项：${hits.join("、") || "无"}；要求 ≥3：城市/建筑/年代/朝向/时段/面积/层高）`);
  for (const entry of bible.otherSpaces ?? []) {
    if (!entry.spaceId?.trim()) { issues.push("otherSpaces 里有条目缺 spaceId"); continue; }
    if (entry.spaceId === bible.spaceId) { issues.push(`otherSpaces 里的 ${entry.spaceId} 与主空间重名`); continue; }
    const entryHits = specificityHits(entry, `${entry.building ?? ""} ${entry.orientation ?? ""}`);
    if (entryHits.length < 3) issues.push(`其他空间 ${entry.spaceId} 实指不足（当前 ${entryHits.length} 项：${entryHits.join("、") || "无"}；要求 ≥3）`);
  }
  if (!bible.materials?.length || bible.materials.length < 3) issues.push(`材质清单不足（要求 ≥3 项，当前 ${bible.materials?.length ?? 0}）`);
  for (const [index, material] of (bible.materials ?? []).entries()) {
    if (!material.material?.trim()) issues.push(`materials[${index}] 缺 material`);
    if (!material.finish && !material.wear) issues.push(`materials[${index}]（${material.item}）缺工艺或使用状态（真实感来自工艺与磨损，不是名词）`);
  }
  if (!bible.practicalLights?.some((light) => typeof light.kelvin === "number" || Boolean(light.direction)))
    issues.push("实用光源不足（要求 ≥1 项带色温或方向：窗光/筒灯/台灯…；柔光箱/反光板属棚具语言，不算）");
  if (!bible.traces?.length) issues.push("使用痕迹清单为空（要求 ≥1：指纹/水渍/卷边/划痕/薄灰…）");
  return issues;
}

/**
 * 环境真实性审计（确定性，零 token）。
 * 返回**逐镜缺陷**；调用方按 `hard` 决定是否阻断渲染（完整链路里在 plates 之前 fail-closed）。
 */
export function environmentDefects(shots: readonly EnvShotFields[], bible?: SceneBible | null): EnvDefect[] {
  const defects: EnvDefect[] = [];
  const push = (rule: string, shotId: string, detail: string, hard = true) => defects.push({ rule, shotId, detail, hard });
  if (bible) {
    for (const issue of validateSceneBible(bible)) {
      push("scene-bible", bible.spaceId || "(未命名空间)", issue, false);
    }
  }
  for (const shot of shots) {
    const shotId = String(shot.shotId ?? "?");
    const text = textOf(shot);
    const generic = GENERIC_SCENE_WORDS.filter((word) => text.includes(word));
    if (generic.length > 0) push("generic-wording", shotId, `场景里出现空词：${generic.join("、")}（空词只能生成"平均空间"，请换成分镜实指）`);
    const materialHits = new Set(text.match(MATERIAL_WORDS) ?? []);
    if (materialHits.size < 3) push("material-depth", shotId, `材质与工艺项不足（当前 ${materialHits.size} 项：${[...materialHits].join("、") || "无"}；要求 ≥3，且要带工艺/状态）`);
    if (!PRACTICAL_LIGHT_WORDS.test(String(shot.lighting ?? ""))) push("practical-light", shotId, "灯光里没有场景内实用光源（窗光/筒灯/台灯/屏幕光…）；只有柔光箱/反光板会让画面像影棚");
    else if (!/\d{3,5}\s*K|色温/.test(String(shot.lighting ?? ""))) push("practical-light", shotId, "实用光源缺色温标定（要求写 K 值或「色温」口径）", false);
    if (!TRACE_WORDS.test(text)) push("usage-traces", shotId, "没有任何使用痕迹（指纹/水渍/卷边/划痕/薄灰…）——不存在「无痕」的真实办公室");
    if (specificityHitsInText(`${shot.scene ?? ""} ${shot.sceneDescription ?? ""}`).length < 3)
      push("space-specificity", shotId, "本镜场景未带上空间实指（年代/地段/尺度/朝向/时段/空间类型 中至少 3 项）");
    const knownSpaceIds = bible ? [bible.spaceId, ...(bible.otherSpaces ?? []).map((entry) => entry.spaceId)] : [];
    if (bible && shot.sceneId && !knownSpaceIds.includes(shot.sceneId))
      push("space-continuity", shotId, `本镜声明 sceneId=${shot.sceneId}，不在片级圣经登记的空间里（现有：${knownSpaceIds.join("、")}）——换空间必须写进 sceneBible.otherSpaces 并交代转场`);
    const needsInteraction = HANDHELD_PROP_WORDS.test(text)
      || (DESK_DEVICE_WORDS.test(text) && DESK_DEVICE_IN_USE.test(text));
    const interactions = interactionsOf(shot);
    if (needsInteraction && interactions.length === 0)
      push("prop-interaction", shotId, "画面含可交互道具（手机/杯/门…）但未声明物理关系：请给 propInteraction（prop/orientation/operatedBy）——「手机屏幕朝观众」正是缺这一项");
    for (const interaction of interactions) {
      if (!interaction.orientation?.trim()) push("prop-interaction", shotId, `道具「${interaction.prop}」缺 orientation（朝向）`);
      if (!interaction.operatedBy?.trim()) push("prop-interaction", shotId, `道具「${interaction.prop}」缺 operatedBy（谁在操作）`);
      if (SCREEN_PROP_WORDS.test(interaction.prop) && !/(朝向|朝着|面向)[^，。；]{0,12}(本人|自己|使用|主播|屏幕朝内)|背面|机身背面/.test(interaction.orientation))
        push("prop-screen-orientation", shotId, `屏幕类道具「${interaction.prop}」未声明屏幕朝向使用者（应写"屏幕朝向主播本人，观众只见机身背面/侧缘"）`);
    }
    const optic = `${shot.depth_of_field ?? ""} ${String((shot as { spaceShot?: unknown }).spaceShot ?? "")}`;
    if (!/等效\s*\d+\s*mm|\d+\s*mm\s*(定焦|焦段|视角)/.test(optic))
      push("optic-signature", shotId, "缺光学签名（等效焦段/光圈口径）——建议写「等效 35mm 视角、大光圈浅景深」", false);
  }
  return defects;
}

const joinOr = (items: readonly (string | undefined | null)[], separator = "；"): string =>
  items.map((item) => String(item ?? "").trim()).filter(Boolean).join(separator);

/**
 * 空间实指摘要（进 scene 前段）。
 * `spaceId` 给定且命中 `otherSpaces` 时用该空间的实指（门店/客户现场等），否则用主空间。
 */
export function spaceSummary(bible: SceneBible, spaceId?: string): string {
  const space: SceneBibleSpace = (spaceId ? bible.otherSpaces?.find((entry) => entry.spaceId === spaceId) : undefined) ?? bible.space;
  return joinOr([
    joinOr([space.city, space.district], ""),
    space.building,
    typeof space.areaM2 === "number" ? `约 ${space.areaM2} ㎡` : "",
    typeof space.ceilingM === "number" ? `层高 ${space.ceilingM}m` : "",
    space.orientation,
    space.timeOfDay ? `时段 ${space.timeOfDay}` : "",
  ]);
}

export function materialsSummary(bible: SceneBible, limit = 4): string {
  return bible.materials.slice(0, limit).map((m) => joinOr([m.item, m.material, m.finish, m.wear], " · ")).join("；");
}

export function practicalLightsSummary(bible: SceneBible): string {
  return bible.practicalLights.map((light) => joinOr([
    light.count ? `${light.type} ${light.count} 只${typeof light.lit === "number" ? `（开 ${light.lit} 只）` : ""}` : light.type,
    typeof light.kelvin === "number" ? `${light.kelvin}K` : "",
    light.direction,
    light.shade,
  ], "，")).join("；");
}

export function propInteractionSummary(shot: EnvShotFields): string {
  const items = interactionsOf(shot);
  if (items.length === 0) return "";
  return items.map((item) => joinOr([
    `${item.prop}：${item.orientation}`,
    item.operatedBy ? `由${item.operatedBy}操作` : "",
    item.contact,
    item.occlusion,
  ], "，")).join("；");
}

/**
 * 把场景圣经展开进镜头卡既有字段（关键帧提示词与视频提示词都能吃到）：
 *   scene            ← 空间实指 + 材质与工艺（前 4 项）
 *   sceneDescription ← 本镜环境叙事 + 原描述 + 使用痕迹
 *   lighting         ← 实用光源清单 + 原灯光（棚具语言保留作补充）
 *   props            ← 原道具 + 材质细节 + 道具交互
 * 纪律：不改 action/台词/时长/构图，保证"只升级环境，不动表演与节奏"。
 */
export function expandShotWithBible<T extends EnvShotFields & Record<string, unknown>>(shot: T, bible: SceneBible): T {
  const traces = bible.traces.join("、");
  const interaction = propInteractionSummary(shot);
  const spaceId = shot.sceneId ?? bible.spaceId;
  const next: T = {
    ...shot,
    sceneId: spaceId,
    scene: joinOr([spaceSummary(bible, spaceId), materialsSummary(bible, 3), shot.scene]),
    sceneDescription: joinOr([shot.envNarrative, shot.sceneDescription, traces ? `使用痕迹：${traces}` : ""]),
    lighting: joinOr([practicalLightsSummary(bible), shot.lighting]),
    props: joinOr([shot.props, `材质与工艺：${materialsSummary(bible, 5)}`, interaction ? `道具交互：${interaction}` : ""]),
    ...(bible.colorDiscipline ? { color_palette: joinOr([bible.colorDiscipline, String(shot.color_palette ?? "")]) } : {}),
  };
  return next;
}

/** 提示词补充行（供需要显式成行的调用方使用；plate-prompt / 组装器已通过字段吃到） */
export function sceneBiblePromptLines(bible: SceneBible, shot: EnvShotFields): string[] {
  return [
    `空间实指：${spaceSummary(bible, shot.sceneId)}`,
    `材质与工艺：${materialsSummary(bible)}`,
    `实用光源：${practicalLightsSummary(bible)}`,
    `使用痕迹：${bible.traces.join("、")}`,
    ...(propInteractionSummary(shot) ? [`道具交互：${propInteractionSummary(shot)}`] : []),
  ];
}

/** 审计摘要（给日志/报告用） */
export function summarizeDefects(defects: readonly EnvDefect[]): { hard: number; soft: number; byRule: Record<string, number> } {
  const byRule: Record<string, number> = {};
  let hard = 0;
  let soft = 0;
  for (const defect of defects) {
    byRule[defect.rule] = (byRule[defect.rule] ?? 0) + 1;
    if (defect.hard) hard += 1;
    else soft += 1;
  }
  return { hard, soft, byRule };
}
