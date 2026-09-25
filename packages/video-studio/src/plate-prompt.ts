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
    ...(isBridgeScene(shot) ? [BRIDGE_STRUCTURE_CONSTRAINT] : []),
    "禁止：文字、字幕、水印、logo、卡通、插画、3D 渲染、塑料皮肤、多余手指、第二个人物清晰入镜、悬空无落点的建筑结构"
  ];
  return lines.filter((line) => line.trim().length > 0).join("\n");
}
