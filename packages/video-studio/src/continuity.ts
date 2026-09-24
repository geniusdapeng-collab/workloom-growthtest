/**
 * continuity —— 连贯性导演评审（管线 step_key `continuity`，owner `continuity-reviewer`）
 *
 * 背景（T-2026-0924-0001）：`narrative-film.yml` 声明"连贯性导演评审：6 问评审 + 5 维评分，
 * 硬阻断直接打回"，但运行时从未接入——跨镜一致性只靠成片终审的"血缘 + 历史裁决"间接兜底，
 * 真机代价是"同一支片子里上午的光照接下午的台词"、"同一套衣服在不同镜里悄悄换款"这类问题到成片才被发现。
 *
 * 本模块把这一步做成**可机检的跨镜检查 + 5 维评分**，在烧渲染额度之前给出裁决：
 *   6 问：人物同一性 / 空间连续 / 时间与光线推进 / 动作与视线连续 / 道具状态连续 / 叙事节拍与总时长
 *   5 维评分（各 0–20，满分 100）：人物一致性 / 空间连续性 / 时间与光线 / 动作与视线 / 节奏与情绪
 *
 * 硬阻断（fail-closed）：服装/妆造无理由不一致、总时长与目标不符、台词重复。
 * 软信号（进问题清单、不影响放行）：时间倒退一档、相邻镜运动方向相反、缺少收束镜、道具凭空出现。
 */

export interface ContinuityCheck {
  id: string;
  pass: boolean;
  hard?: boolean;
  detail: string;
  shots: string[];
}

export interface ContinuityQuestion {
  id: string;
  question: string;
  answer: "pass" | "warn" | "block";
  note: string;
}

export interface ContinuityDimension {
  name: string;
  score: number;
  max: 20;
  note: string;
}

export interface ContinuityReport {
  schemaVersion: "workloom.continuity-report/v1";
  projectId: string;
  shotCount: number;
  targetSeconds: number | null;
  totalSeconds: number;
  questions: ContinuityQuestion[];
  checks: ContinuityCheck[];
  dimensions: ContinuityDimension[];
  score: number;
  approved: boolean;
  blocking: string[];
}

const text = (shot: Record<string, unknown>, key: string): string => {
  const value = shot[key];
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map((v) => (typeof v === "string" ? v : JSON.stringify(v))).join(" ");
  return value ? JSON.stringify(value) : "";
};

/** 时段推进序（用于"时间不倒退"检查；`unknown` 不参与比较） */
const TIME_ORDER: Array<{ key: string; pattern: RegExp }> = [
  { key: "morning", pattern: /清晨|早上|上午|晨光|日出/ },
  { key: "noon", pattern: /正午|中午|晌午/ },
  { key: "afternoon", pattern: /下午|午后/ },
  { key: "dusk", pattern: /黄昏|日落|傍晚|夕阳|黄金时刻|蓝调|暮色/ },
  { key: "night", pattern: /入夜|夜晚|夜色|夜景|深夜|晚上/ }
];

function timeSlot(shot: Record<string, unknown>): string | null {
  /**
   * 先剥否定语境（真机 2026-09-24）：分镜卡的白平衡锚点里写着"避免日落时段的金色调"，
   * 直接匹配会把**上午**的镜头读成 dusk，于是"上午→午后"被误判成"时段倒退两档"。
   * 与 cine-kb 的否定剥离同口径：谓词否定（避免/不要/禁止）剥掉整个从句。
   */
  const blob = `${text(shot, "scene")} ${text(shot, "lighting")} ${text(shot, "sceneDescription")} ${text(shot, "timeline")} ${text(shot, "bright_constraint")}`
    .replace(/(避免|不要|禁止)[^，。；、,;]{0,18}/g, " ");
  // 末位命中优先：一句话里同时出现"白天"与"入夜"时，以更晚的时段为准
  for (let i = TIME_ORDER.length - 1; i >= 0; i -= 1) if (TIME_ORDER[i]!.pattern.test(blob)) return TIME_ORDER[i]!.key;
  return null;
}

/** 造型「核心签名」：主服装 + 主色 —— 细节枚举（鞋/袖长/盘扣）逐镜写法可以不同，核心不能变 */
const GARMENT_ORDER = ["旗袍", "礼服", "婚纱", "上袄", "袄", "衬衫", "西装", "外套", "风衣", "裙", "裤", "制服", "披肩"];
const COSTUME_COLORS = ["月白", "藕粉", "藏青", "黛", "墨绿", "酒红", "米白", "米色", "青灰", "青", "白", "灰", "黑", "红", "蓝", "黄", "金", "银"];
const COSTUME_ACCESSORIES = ["耳饰", "耳环", "项链", "手镯", "发簪", "发钗", "珍珠", "胸针", "腰带"];

function costumeCore(shot: Record<string, unknown>): { garment: string | null; color: string | null; accessories: string[] } {
  const costume = text(shot, "costume");
  let garment: string | null = null;
  let at = -1;
  for (const token of GARMENT_ORDER) {
    const index = costume.indexOf(token);
    if (index >= 0 && (at < 0 || index < at)) { garment = token; at = index; }
  }
  /**
   * 主色取**主服装之前最近**的颜色词（"月白色苏式改良旗袍" → 月白）；
   * 前面找不到再看整句里的第一个颜色词——覆盖"旗袍，月白缎面"这种倒装写法。
   */
  const before = at >= 0 ? costume.slice(Math.max(0, at - 12), at) : costume;
  const color = COSTUME_COLORS.find((c) => before.includes(c)) ?? COSTUME_COLORS.find((c) => costume.includes(c)) ?? null;
  return { garment, color, accessories: COSTUME_ACCESSORIES.filter((a) => costume.includes(a)) };
}

/** 分镜是否声明了"同一场景/连续镜头"——只有声明了才做空间连续性检查（旅行类分镜本来就换场景） */
function claimsContinuity(shots: Array<Record<string, unknown>>): boolean {
  return shots.some((s) => /同一场景|同一地点|同一空间|连续镜头|接上一镜|一片连续|一镜到底/.test(
    `${text(s, "director_instruction")} ${text(s, "constraint")} ${text(s, "timeline")}`
  ));
}

/** 一档以内的小幅回退视为可接受（同一场戏里"午后→正午"不罕见），跨两档以上才算倒退 */
function backwardJump(from: string | null, to: string | null): boolean {
  if (!from || !to) return false;
  const a = TIME_ORDER.findIndex((t) => t.key === from);
  const b = TIME_ORDER.findIndex((t) => t.key === to);
  if (a < 0 || b < 0) return false;
  return a - b >= 2;
}

/** 运动/视线方向：用于"相邻镜方向相反"的软检查 */
function direction(shot: Record<string, unknown>): "left" | "right" | null {
  const blob = `${text(shot, "camera_movement")} ${text(shot, "action")} ${text(shot, "composition")}`;
  const left = /向左|左侧|从左|左移|左摇|左转/.test(blob);
  const right = /向右|右侧|从右|右移|右摇|右转/.test(blob);
  if (left && !right) return "left";
  if (right && !left) return "right";
  return null;
}

export function auditContinuity(shots: Array<Record<string, unknown>>, options: { targetSeconds?: number | null; projectId?: string } = {}): ContinuityReport {
  const ids = shots.map((s) => String(s.shotId ?? ""));
  const checks: ContinuityCheck[] = [];
  const totalSeconds = shots.reduce((sum, s) => sum + (Number(s.duration ?? 0) || 0), 0);
  const targetSeconds = options.targetSeconds ?? null;
  /**
   * **真实素材段**（卡里有 `photo`）：画面是实拍照片，没有人物的造型/动作/视线可查。
   * 造型一致性这类"同一个人跨镜同款"的硬闸对它们不适用——必须排除，
   * 否则"实拍图没有 costume 字段"会被误判成"换款"（2026-09-25 新增真图题材时暴露）。
   */
  const isPhotoShot = (s: Record<string, unknown>): boolean => String(s.photo ?? "").trim().length > 0;
  const photoIds = shots.filter(isPhotoShot).map((s) => String(s.shotId ?? ""));
  const characterShots = shots.filter((s) => !isPhotoShot(s));

  /* ── ① 人物同一性：造型**核心签名**（主服装 + 主色）跨镜一致（显式换装除外） ──
   * 真机校准（2026-09-24）：六张卡片写的是同一件"月白色苏式改良旗袍"，
   * 但细节枚举逐镜不同（有的写鞋、有的写袖长、有的加"蹲下自然褶皱"）——
   * 用全文比对会把正常的分镜写法判成"换造型"，所以只比核心签名；
   * 细节差异降级为软信号列出来，交给导演/监制判断。
   */
  const cores = characterShots.map((s) => costumeCore(s));
  const coreKeys = [...new Set(cores.map((c) => `${c.garment ?? "?"}|${c.color ?? "?"}`))];
  const declaresWardrobeChange = shots.some((s) => /换装|更衣|换上|脱下|换上另一套/.test(`${text(s, "action")} ${text(s, "director_instruction")}`));
  const costumePass = coreKeys.length <= 1 || declaresWardrobeChange;
  const characterIds = characterShots.map((s) => String(s.shotId ?? ""));
  const detailNotes = cores.map((c, i) => `${characterIds[i]}:${c.garment ?? "未标注服装"}${c.color ? `·${c.color}` : ""}${c.accessories.length > 0 ? `·${c.accessories.join("/")}` : ""}`);
  const photoNote = photoIds.length > 0 ? `；真实素材段 ${photoIds.join("/")} 不参与造型判定（实拍画面）` : "";
  checks.push({
    id: "costume-consistency",
    pass: costumePass,
    hard: true,
    detail: costumePass
      ? (coreKeys.length === 1
          ? `${characterShots.length} 个人物镜造型核心一致（${coreKeys[0]}）；细节：${detailNotes.join("，")}${photoNote}`
          : "存在多套造型，但卡片显式声明了换装动作")
      : `造型核心出现 ${coreKeys.length} 组（${coreKeys.join(" / ")}），且无换装动作声明——同一个人在同一场戏里换款（真机高危项）`,
    shots: ids
  });

  /* ── ② 空间连续：仅当分镜**声明了同一场景连续性**时才检查锚点是否整组更换 ── */
  const anchors = shots.map((s) => {
    const blob = `${text(s, "scene")} ${text(s, "sceneDescription")}`;
    const found: string[] = [];
    if (/河|河道|水面|湖/.test(blob)) found.push("河道");
    if (/桥/.test(blob)) found.push("桥");
    if (/船|乌篷|摇橹/.test(blob)) found.push("船");
    if (/白墙|黛瓦|木格窗|檐/.test(blob)) found.push("建筑");
    if (/巷|街|石板|石阶/.test(blob)) found.push("巷道");
    return found;
  });
  const continuityClaimed = claimsContinuity(shots);
  const disjointCuts: string[] = [];
  if (continuityClaimed) {
    for (let i = 1; i < anchors.length; i += 1) {
      const prev = anchors[i - 1]!;
      const next = anchors[i]!;
      if (prev.length > 0 && next.length > 0 && prev.every((a) => !next.includes(a))) disjointCuts.push(`${ids[i - 1]}→${ids[i]}`);
    }
  }
  const spacePass = disjointCuts.length === 0;
  checks.push({
    id: "space-continuity",
    pass: spacePass,
    hard: false,
    detail: spacePass
      ? (continuityClaimed
          ? "相邻镜的空间锚点没有整组更换"
          : "分镜未声明同一场景连续性（按多地点分镜处理，不判空间连续性）")
      : `声明了同一场景连续性，但相邻镜空间锚点整组更换：${disjointCuts.join("、")}`,
    shots: ids
  });

  /* ── ③ 时间与光线推进：不允许大跨度倒退（除非显式闪回/翌日） ── */
  const slots = shots.map((s) => timeSlot(s));
  const flashback = shots.some((s) => /闪回|回忆|翌日|第二天|次日/.test(`${text(s, "director_instruction")} ${text(s, "timeline")}`));
  const jumps: string[] = [];
  for (let i = 1; i < slots.length; i += 1) {
    if (backwardJump(slots[i - 1] ?? null, slots[i] ?? null)) jumps.push(`${ids[i - 1]}(${slots[i - 1]})→${ids[i]}(${slots[i]})`);
  }
  const timePass = jumps.length === 0 || flashback;
  checks.push({
    id: "time-flow",
    pass: timePass,
    hard: false,
    detail: timePass
      ? `时段推进顺序：${slots.map((s) => s ?? "未标注").join(" → ")}`
      : `时段出现跨两档以上倒退：${jumps.join("、")}（若无闪回交代，观众会读到"时间错乱"）`,
    shots: ids
  });

  /* ── ④ 动作与视线连续：相邻镜运动方向相反会读成"来回折返" ── */
  const dirs = shots.map((s) => direction(s));
  const flips: string[] = [];
  for (let i = 1; i < dirs.length; i += 1) {
    if (dirs[i] && dirs[i - 1] && dirs[i] !== dirs[i - 1]) flips.push(`${ids[i - 1]}(${dirs[i - 1]})→${ids[i]}(${dirs[i]})`);
  }
  checks.push({
    id: "direction-continuity",
    pass: flips.length === 0,
    hard: false,
    detail: flips.length === 0 ? "相邻镜的运动/机位方向没有相反跳变" : `相邻镜方向相反：${flips.join("、")}（如非刻意回环，建议统一朝向）`,
    shots: ids
  });

  /* ── ⑤ 道具状态连续：只在**同一处空间**（锚点重合 ≥2）内追关键道具的消失 ──
   * 真机校准：多地点分镜里"船/灯笼/碗"本来就会各自出现在不同场景，
   * 按"跨镜道具集合"比对会满屏提示；正确的口径是"同一处空间里道具不该凭空消失"。
   */
  /**
   * 只追**故事道具**（props 与 action 同时提到 = 人物真的在用它），不追陈设：
   * 真机校准——"支巷的红灯笼"在下一镜（河埠头）不在画面里完全正常，
   * 把陈设当故事道具会满屏误报；而"手里的碗"在下一镜无交代地消失才是真问题。
   */
  const STORY_PROP_TOKENS = ["碗", "勺", "船", "灯笼", "伞", "篮", "杯", "托盘", "帕子", "扇"];
  const propSets = shots.map((s) => {
    const props = text(s, "props");
    const action = text(s, "action");
    return STORY_PROP_TOKENS.filter((p) => props.includes(p) && action.includes(p));
  });
  const vanished: string[] = [];
  for (let i = 1; i < propSets.length; i += 1) {
    const samePlace = anchors[i - 1]!.filter((a) => anchors[i]!.includes(a)).length >= 2;
    if (!samePlace) continue;
    const gone = propSets[i - 1]!.filter((p) => !propSets[i]!.includes(p));
    if (gone.length > 0) vanished.push(`${ids[i - 1]}→${ids[i]}：${gone.join("/")}`);
  }
  checks.push({
    id: "prop-continuity",
    pass: vanished.length === 0,
    hard: false,
    detail: vanished.length === 0
      ? "同一处空间内的关键道具没有凭空消失"
      : `同一处空间内道具消失：${vanished.join("；")}（若有递出/收起的动作请在 action 里写明）`,
    shots: ids
  });

  /* ── ⑥ 叙事节拍与总时长：时长必须等于目标，且要有收束镜 ── */
  const durationPass = targetSeconds === null ? true : Math.abs(totalSeconds - targetSeconds) <= 0.5;
  const closingPass = /收束|告别|留白|余韵|结束|结尾/.test(shots.map((s) => `${text(s, "mood")} ${text(s, "pacing")} ${text(s, "director_instruction")}`).join(" "));
  checks.push({
    id: "duration-total",
    pass: durationPass,
    hard: true,
    detail: durationPass ? `总时长 ${totalSeconds}s 与目标一致` : `总时长 ${totalSeconds}s，与目标 ${targetSeconds}s 不符`,
    shots: ids
  });
  checks.push({
    id: "emotion-arc",
    pass: closingPass,
    hard: false,
    detail: closingPass ? "存在明确的收束/告别节拍" : "没有找到收束镜（结尾可能读成'话说一半断了'）",
    shots: ids
  });

  /* ── 台词去重（硬）：同一句台词在两镜重复，观众会以为卡带 ── */
  const lines = new Map<string, string[]>();
  for (const shot of shots) {
    const raw = text(shot, "dialogue").replace(/["'“”「」\s]/g, "");
    if (!raw || raw.length < 4) continue;
    for (const piece of raw.split(/[。！？!?；;]/).filter((p) => p.length >= 6)) {
      lines.set(piece, [...(lines.get(piece) ?? []), String(shot.shotId ?? "")]);
    }
  }
  const duplicates = [...lines.entries()].filter(([, idsWithLine]) => idsWithLine.length > 1);
  checks.push({
    id: "dialogue-dedup",
    pass: duplicates.length === 0,
    hard: true,
    detail: duplicates.length === 0 ? "台词没有跨镜重复" : `台词重复：${duplicates.map(([line, s]) => `"${line.slice(0, 12)}…" 出现在 ${s.join("/")}`).join("；")}`,
    shots: duplicates.flatMap(([, s]) => s)
  });

  /* ── 5 维评分：由检查结果折算，避免"另写一套主观分" ── */
  const dimension = (name: string, related: string[], note: string): ContinuityDimension => {
    const failedHard = checks.filter((c) => related.includes(c.id) && !c.pass && c.hard).length;
    const failedSoft = checks.filter((c) => related.includes(c.id) && !c.pass && !c.hard).length;
    const score = Math.max(0, 20 - failedHard * 8 - failedSoft * 3);
    return { name, score, max: 20, note };
  };
  const dimensions: ContinuityDimension[] = [
    dimension("人物一致性", ["costume-consistency"], "服装与妆造跨镜是否同一个人/同一套造型"),
    dimension("空间连续性", ["space-continuity", "prop-continuity"], "空间锚点与关键道具是否连续"),
    dimension("时间与光线", ["time-flow"], "时段推进与光线基调是否自洽"),
    dimension("动作与视线", ["direction-continuity"], "运动方向与视线是否读得通"),
    dimension("节奏与情绪", ["duration-total", "emotion-arc", "dialogue-dedup"], "总时长、台词与情绪曲线是否收得住")
  ];
  const score = dimensions.reduce((sum, d) => sum + d.score, 0);
  const blocking = checks.filter((c) => c.hard && !c.pass).map((c) => c.detail);
  const questions: ContinuityQuestion[] = [
    { id: "q1", question: "六个镜里是同一个人、同一套造型吗？", answer: checks[0]!.pass ? "pass" : "block", note: checks[0]!.detail },
    { id: "q2", question: "空间是连续的同一个地方吗？", answer: checks[1]!.pass ? "pass" : "warn", note: checks[1]!.detail },
    { id: "q3", question: "时间和光线是顺着走的吗？", answer: checks[2]!.pass ? "pass" : "warn", note: checks[2]!.detail },
    { id: "q4", question: "动作与视线接得上吗？", answer: checks[3]!.pass ? "pass" : "warn", note: checks[3]!.detail },
    { id: "q5", question: "道具状态讲得通吗？", answer: checks[4]!.pass ? "pass" : "warn", note: checks[4]!.detail },
    { id: "q6", question: "时长与情绪曲线收得住吗？", answer: checks[5]!.pass && checks[6]!.pass ? "pass" : checks[5]!.pass ? "warn" : "block", note: `${checks[5]!.detail}；${checks[6]!.detail}` }
  ];

  return {
    schemaVersion: "workloom.continuity-report/v1",
    projectId: options.projectId ?? "",
    shotCount: shots.length,
    targetSeconds,
    totalSeconds,
    questions,
    checks,
    dimensions,
    score,
    approved: blocking.length === 0,
    blocking
  };
}
