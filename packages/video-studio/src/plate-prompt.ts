/**
 * plate-prompt —— 关键帧（plate）提示词组装。
 *
 * 为什么从脚本里搬出来（2026-09-24 真机二次事故）：
 * `scripts/tools/full-chain-film.mts` 里的 `platePrompt()` 被**残留的 diff 标记 `+`** 破坏——
 * 数组里那一行成了 `+"场景结构与物理自洽（通用）：…"`，求值结果是 **NaN**，
 * 于是每次进 Ark 的关键帧提示词尾部都带一行字面 "NaN"，而**通用空间/物理不变量整段没进提示词**。
 * 评审侧（`producer-gate.ts#PRODUCER_RUBRICS`）有这套不变量、提示词侧没有，
 * 所以"无头之桥"（桥面两侧直接临水、看不到两端连接）屡次通过评审却屡次复现。
 *
 * 教训与对策：
 *   ① 长提示词组装的产物必须**可被单元测试断言**（不能只活在脚本里）——本模块即为此；
 *   ② 断言里必须包含"提示词不得含 NaN/undefined/[object Object]"这类**退化哨兵**；
 *   ③ 桥/栈道类结构给"场景条件硬约束"，不再指望模型从通用不变量里自行推演。
 */

export interface PlatePromptShot {
  shotId?: string;
  costume?: string;
  makeup?: string;
  /** 知识库注入的道具/材质画面语言（如"镜面倒影""烛火小而稳定""细密雨丝"） */
  props?: unknown;
  scene?: string;
  sceneDescription?: string;
  action?: string;
  composition?: string;
  lighting?: string;
  color_palette?: string;
  /** 知识库（OPTICS-001 光圈顾问）注入的景深画面语言；**不含 f 值** */
  depth_of_field?: string;
  mood?: string;
  [key: string]: unknown;
}

export interface PlatePromptOptions {
  characterName: string;
  appearanceText?: string;
  aspect?: string;
  resolution?: string;
  title?: string;
}

/** 通用空间/物理不变量（任何镜头都成立；2026-09-24 起由本模块保证真的进提示词） */
export const UNIVERSAL_SPATIAL_INVARIANT =
  "场景结构与物理自洽（通用）：画面中每一个建筑、地形与器物都应是有来由、有落点、有支撑的完整结构"
  + "（桥有桥头并连着两岸、路通向某端、台阶连着地面与水面、门窗嵌在墙体内、器物可被真实手持或承重）；"
  + "同一场景共享一条地平线与一套透视；光向、色温、阴影方向与时段一致，物体与地面有接触阴影；"
  + "不出现悬空构件、断裂结构、无来由的延伸、漂浮物体或与人物尺度冲突的元素。";

/**
 * 桥/栈道类场景的**条件硬约束**（真机：交付成片里出现"从水里走上来的桥"）。
 * 通用不变量只说"桥有桥头并连着两岸"，会被"石拱桥上、桥面通向镜头"这类场景描述压过；
 * 这里对桥类场景把结构讲死，并给出禁止项。
 */
export const BRIDGE_STRUCTURE_CONSTRAINT =
  "桥类结构（本镜硬约束）：必须一眼看出这是**一座桥**——桥体呈拱形或梁式结构、"
  + "两端各有桥头并与岸线（青石驳岸／石阶／巷口）真实相接、栏杆沿桥面两侧连续延伸；"
  + "水面只能出现在桥体两侧或下方，并且能从栏杆缝隙或拱洞看到桥下水面。"
  + "禁止把桥面画成两侧直接临水、看不到任何一端连接的悬空步道（「无头之桥」）；"
  + "禁止桥体与水面之间没有驳岸或桥台过渡。";

/** 场景是否含桥/栈道类结构 */
export function isBridgeScene(shot: PlatePromptShot): boolean {
  const blob = [shot.scene, shot.sceneDescription, shot.composition, shot.action]
    .map((v) => String(v ?? ""))
    .join(" ");
  return /桥|栈道|廊桥/.test(blob);
}

/**
 * 环境真实性**通用约束**（2026-09-27 真机事故 → 提示词侧）：
 * 事故现场：8 镜监制全放行，但成片被一眼判"不像实拍"。根因之一是提示词侧从来没有这条约束——
 * 模型收到的场景是"现代简约商务空间"这类空词，只能生成训练分布里的**平均房间**。
 *
 * 与 `scene-bible.ts#environmentDefects`（确定性审计）和 `producer-gate.ts#PRODUCER_RUBRICS`
 * （视觉复核）**三处同源**：提示词侧让模型有约束可用，审计侧在渲染前判红，评审侧兜住漏网。
 * 纪律：这条对所有镜头生效，不针对具体空间类型（不枚举办公室/厨房/工地）。
 */
export const ENVIRONMENT_REALISM_CONSTRAINT =
  "环境真实性（通用）：空间必须是一个**具体、可指认的真实场所**，不是「平均样板间」——"
  + "材质要带**工艺与使用状态**（如「胡桃木哑光打蜡、边缘 2cm 磕痕」「微水泥批刀痕、两处细裂纹」），"
  + "灯光必须包含**场景内真实存在的实用光源**（窗光／筒灯／台灯／屏幕光／壁灯，方向与色温明确），"
  + "画面要留有**使用痕迹**（指纹、水渍、卷边、划痕、薄灰、杯痕、旧钉眼），"
  + "并带可读的空间实指（空间类型、尺度、朝向、时段）。"
  + "禁止：无任何使用痕迹的样板间、影棚柔光箱式打光、材质只写一级名词（「原木」「浅色墙面」）、"
  + "空旷到与人物活动不符、每镜一换装修风格。";

/** 可交互器物（有朝向语义的一类）：命中即追加条件硬约束 */
const INTERACTIVE_PROP_WORDS = /(手机|平板|遥控器|键盘|鼠标|相机|麦克风|耳机|笔记本|电脑|显示器|屏幕)/;

/** 场景是否含可交互器物 */
export function hasInteractiveProp(shot: PlatePromptShot): boolean {
  const blob = [shot.scene, shot.sceneDescription, shot.props, shot.composition, shot.action]
    .map((v) => String(v ?? ""))
    .join(" ");
  return INTERACTIVE_PROP_WORDS.test(blob);
}

/**
 * 道具-人体交互**条件硬约束**（真机 badcase：手机屏幕朝观众）。
 * 剧本里明明是"主播自己在看手机"，成片却是"把手机举给观众看"——道具与人的物理关系
 * 既没被声明、也没被复核。这里把关系讲死；可见性/承重/遮挡由镜头卡的 `propInteraction` 提供细节。
 */
export const PROP_INTERACTION_CONSTRAINT =
  "道具与人体交互（本镜硬约束）：被手持或被操作的器物必须有成立的物理关系——"
  + "**屏幕朝向它的使用者**（观众只见机身背面或侧缘，不出现屏幕内容／界面正对镜头），"
  + "有真实承重与接触（立于支架、置于桌面、被手指真实包裹），手指数量与关节正常、遮挡范围合理，"
  + "操作者的视线与手部落点指向他正在操作的界面。"
  + "禁止：手机／平板／笔记本屏幕内容朝观众、道具漂浮或穿模、手指畸变、道具凭空出现或消失。";

/**
 * 设备口径**条件硬约束**（2026-09-27 产品所有者：场景里的电子设备全部使用 2024 年之后的 Apple 设备）。
 * 与 `device-policy.ts` 的允许清单同源：清单扩展后这条约束自动跟随（不在这里重复机型列表）。
 * 纪律：机型必须在镜头卡里**写死**（裸词"笔记本电脑/平板/显示器"不算），避免模型自己补一台杂牌或旧机型。
 */
export const DEVICE_STANDARD_CONSTRAINT =
  "设备口径（本镜硬约束）：画面里的电子设备（笔记本电脑、台式机、手机、平板、显示器、耳机、键鼠等）"
  + "**全部为 2024 年之后世代的 Apple 在售机型**，机型按镜头卡给定的型号呈现（机身比例、材质、颜色与接口符合该机型），"
  + "机身与屏幕上不出现任何其他品牌标识、贴纸或旧世代外观特征。"
  + "禁止：非 Apple 品牌的笔记本／显示器／手机，旧世代或已停产机型外观，无品牌的通用设备，"
  + "同一画面出现两台外观不一致的「同型号」设备。";

/** 电子设备出现判据：命中即追加设备口径约束 */
/** 与 `device-policy.ts#DEVICE_PRESENCE_PATTERNS` 同步：只收"Apple 有对应品类"的设备（相机/云台/读卡器不入内） */
const DEVICE_PRESENCE_HINT = /(笔记本电脑|手提电脑|MacBook|台式机|台式电脑|一体机|主机箱|手机|iPhone|平板电脑|平板|iPad|显示器|显示屏|大屏|耳机|AirPods|键盘|鼠标|触控板|数位板|智能手表|Apple\s?Watch)/i;

/** 本镜是否出现电子设备（命中即需要设备口径约束） */
export function hasElectronicDevice(shot: PlatePromptShot): boolean {
  const blob = [shot.scene, shot.sceneDescription, shot.props, shot.composition, shot.action]
    .map((v) => String(v ?? ""))
    .join(" ");
  return DEVICE_PRESENCE_HINT.test(blob);
}

/**
 * 组装关键帧提示词。
 * 返回值保证：不含 `NaN` / `undefined` / `[object Object]` 这三种退化哨兵（单测强制）。
 */
export function buildPlatePrompt(shot: PlatePromptShot, options: PlatePromptOptions): string {
  const pick = (key: string): string => {
    const value = shot[key];
    if (value === undefined || value === null) return "";
    if (typeof value === "string") return value;
    if (Array.isArray(value)) return value.map((v) => (typeof v === "string" ? v : JSON.stringify(v))).join("；");
    return JSON.stringify(value);
  };
  const aspect = options.aspect ?? "9:16";
  const resolution = options.resolution ?? "1080p";
  /**
   * 只在有值时才出一行：`景深：` 这种空字段行会变成占位噪音进提示词。
   */
  const onlyWhenFilled = (label: string, value: string): string[] => (value.trim() ? [`${label}${value}`] : []);
  /**
   * 景深与道具必须进关键帧提示词（2026-09-25 四轮审计 · 注入落地层）：
   * 知识注入把"该浅还是该深、画面里有什么材质/粒子"写进 `depth_of_field` 与 `props`，
   * 但关键帧提示词此前**根本没有这两行**——结果：
   *   ① 注入给风光的"全画面锐利、细节丰富（较深景深）"从没进过关键帧，
   *      而「规格」行硬编码的"浅景深"把每一镜都按浅景深出图（航拍梯田/雾中湖面/车轨全中）；
   *   ② 镜面倒影、湖面微澜、烛火、雨丝这些 props 注入同样只到视频提示词，关键帧里没有。
   * 关键帧是图生视频的首帧，首帧没有的东西后面也不会长出来 —— 所以这里是"注入是否真的生效"的关键一环。
   */
  const depthOfField = pick("depth_of_field");
  const lines = [
    /**
     * 白平衡锚点**前置**（`docs/character-archive-design.md` 附录 A.1 复验：写在中后段压不住前置的光照描述，
     * 暖黄肤 warm 0.237 → 0.085 靠的正是把中性白平衡放到最前面）。
     */
    "白平衡中性（日光 5600K，肤色自然）：均匀中性光、没有金色或橙色偏移；避免日落时段的金色调、避免暖黄滤镜、避免橙色调。",
    `【关键帧】${pick("shotId")} ${options.title ?? ""}`.trim(),
    `角色：${options.characterName}${options.appearanceText ? `。人物外貌（必须严格按此描述，跨镜一致）：${options.appearanceText}` : ""}`,
    `服装：${pick("costume")}`,
    `妆造：${pick("makeup")}`,
    ...onlyWhenFilled("道具与质感：", pick("props")),
    `场景：${pick("scene")}`,
    `环境细节：${pick("sceneDescription")}`,
    `人物动作与表情（这一帧的瞬间）：${pick("action")}`,
    `构图：${pick("composition")}`,
    ...onlyWhenFilled("景深：", depthOfField),
    `光线：${pick("lighting")}`,
    `色调：${pick("color_palette")}`,
    `情绪：${pick("mood")}`,
    /**
     * "浅景深"不再无条件硬编码：卡片/知识注入没有声明景深时才给这个通用安全值；
     * 已声明时以 `景深：` 行为准（两处互相打架会把 KB 的档位裁决冲掉）。
     */
    `规格：${aspect} 竖幅 ${resolution}，写实电影感摄影，自然肤质（保留毛孔与细颗粒，不做美颜磨皮）${depthOfField.trim() ? "" : "，浅景深"}，纪实风格`,
    UNIVERSAL_SPATIAL_INVARIANT,
    ENVIRONMENT_REALISM_CONSTRAINT,
    ...(isBridgeScene(shot) ? [BRIDGE_STRUCTURE_CONSTRAINT] : []),
    ...(hasInteractiveProp(shot) ? [PROP_INTERACTION_CONSTRAINT] : []),
    ...(hasElectronicDevice(shot) ? [DEVICE_STANDARD_CONSTRAINT] : []),
    "禁止：文字、字幕、水印、logo、卡通、插画、3D 渲染、塑料皮肤、多余手指、第二个人物清晰入镜、悬空无落点的建筑结构"
  ];
  return lines.filter((line) => line.trim().length > 0).join("\n");
}
