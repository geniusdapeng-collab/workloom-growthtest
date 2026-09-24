/**
 * micromotion —— 微动作增强（管线 step_key `micromotion`，owner `micromotion-stylist`）
 *
 * 背景（T-2026-0924-0001）：`narrative-film.yml` 声明了"微动作增强：5 路流水线（面部/身体/眼神/呼吸/融合）"，
 * 但运行时从未接入——镜头卡里的动作描述停在"走两步、回头、摆手"这种**宏观动作**，
 * 生成模型于是只能给出"站着念完"的表演（真机审稿多次打回"动作证据不足、表情与台词不贴"）。
 *
 * 本模块把宏观动作**按 5 路补齐为可拍摄的微动作指令**，全部由镜头卡自身字段推导（确定性、可测、可复现）：
 *   ① facial 面部（眉/嘴角的先后关系）  ② eyes 眼神（注视点与眨眼时机）
 *   ③ body 身体（重心/肩线/步幅）        ④ breath 呼吸（与时长对齐的一次完整呼吸）
 *   ⑤ fusion 融合（微动作与台词节拍的对齐）
 *
 * 纪律：
 *   · 只写**画面语言**，不写技术参数（焦距/光圈/帧率）；
 *   · 幂等：同一张卡片重复增强不会叠加（第二次直接 skipped）；
 *   · 有界：总增量 ≤ 200 字，避免把提示词撑爆（交付闸对字数敏感，只加不删是反模式）。
 */

export type MicromotionChannelId = "facial" | "eyes" | "body" | "breath" | "fusion";

export interface MicromotionChannel {
  id: MicromotionChannelId;
  /** 写进提示词的画面语言 */
  clause: string;
  /** 为什么给这一条（可审计：命中了卡片里的哪个词/哪条规则） */
  because: string;
}

export interface MicromotionTrace {
  schemaVersion: "workloom.micromotion-trace/v1";
  shotId: string;
  applied: MicromotionChannel[];
  /** 已增强过 → 记录跳过原因（不重复叠加） */
  skipped: string | null;
  text: string;
  charDelta: number;
}

/** 幂等标记：写进 action 的开头，重复运行时作为"已增强"的判据 */
export const MICROMOTION_MARKER = "【微动作】";
const MAX_ADDED_CHARS = 200;

const pick = (card: Record<string, unknown>, key: string): string => {
  const value = card[key];
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map((v) => (typeof v === "string" ? v : JSON.stringify(v))).join(" ");
  return value ? JSON.stringify(value) : "";
};

/**
 * 五路规划（纯函数）：以卡片字段为唯一依据。
 * 每一路都必须能回答"这个词是从卡片哪一句推出来的"——推不出来就不加。
 */
export function planMicromotion(card: Record<string, unknown>): MicromotionTrace {
  const shotId = String(card.shotId ?? "");
  const action = pick(card, "action");
  const mood = pick(card, "mood");
  const pacing = pick(card, "pacing");
  const dialogue = pick(card, "dialogue");
  const duration = Number(card.duration ?? 0);
  const text = `${action} ${mood} ${pacing} ${dialogue}`;
  const applied: MicromotionChannel[] = [];

  /* ① 面部：情绪词决定"眉先动还是嘴角先动" */
  const facial = (() => {
    if (/惊喜|惊讶|惊艳|眼睛发亮/.test(text)) return { clause: "眉峰先上提半拍、嘴角随后展开，惊喜不堆在整张脸上", because: "情绪=惊喜" };
    if (/温柔|温暖|治愈|满足|松弛/.test(text)) return { clause: "眉尾轻放、嘴角先动，笑意慢慢到眼尾", because: "情绪=温柔/温暖" };
    if (/俏皮|调皮|笑/.test(text)) return { clause: "先抿一下嘴再放开笑，笑意有起有落", because: "情绪=俏皮" };
    if (/收束|告别|不舍|留余韵/.test(text)) return { clause: "表情在最后半拍收回平和，嘴角留一点余温", because: "情绪=收束" };
    if (/专注|认真|安静|纪实/.test(text)) return { clause: "面部只做必要微动：眼睑缓眨、眉不动", because: "情绪=克制" };
    return null;
  })();
  if (facial) applied.push({ id: "facial", clause: facial.clause, because: facial.because });

  /* ② 眼神：注视点 + 眨眼时机（有台词时避免"死盯"） */
  const eyes = (() => {
    if (/看向镜头|注视着镜头|视线.*镜头|眼神交流/.test(text)) {
      return dialogue
        ? { clause: "说话时视线落在镜头上不游移，句尾一次自然眨眼", because: "卡片要求与镜头交流且有台词" }
        : { clause: "视线稳定落在镜头上，中段一次轻眨", because: "卡片要求与镜头交流" };
    }
    if (/看.*河|看.*船|望向|远眺|看向画外|视线随/.test(text)) {
      return { clause: "视线追随主体移动，末尾收回到画面主轴", because: "卡片要求视线在画面内移动" };
    }
    if (/低头|垂眼/.test(text)) return { clause: "低头后抬眼时先动眼球再动下颌", because: "卡片含低头/抬眼动作" };
    return { clause: "视线稳定不飘，眨眼的闭合与张开都不抢戏", because: "无明确视线指令，给中性安全值" };
  })();
  applied.push({ id: "eyes", clause: eyes.clause, because: eyes.because });

  /* ③ 身体：重心与肩线（走路/站立/起身/蹲姿分别给不同的重心路径） */
  const body = (() => {
    if (/走近|向前走|走动|缓行|漫步|走过/.test(action)) {
      return { clause: "重心略前移、肩线放松随步微摆，步幅均匀不抢节拍", because: "动作=行走" };
    }
    if (/蹲|起身|站起/.test(action)) return { clause: "起身先重心前移再抬身，不做弹起式动作", because: "动作=蹲/起身" };
    if (/指|递|捧|端|勺|摆手|挥手/.test(action)) {
      return { clause: "持物/示意的手先到位、另一手保持平衡，手腕不僵直", because: "动作含手部叙事" };
    }
    if (/转身|回头|回眸/.test(action)) return { clause: "转身以腰带肩、头部最后到位，避免原地扭脖", because: "动作=转身/回眸" };
    return { clause: "呼吸带动肩线轻微起伏，重心在一只脚上自然承重", because: "无位移动作，给站姿微动" };
  })();
  applied.push({ id: "body", clause: body.clause, because: body.because });

  /* ④ 呼吸：与镜头时长对齐的一次完整呼吸（≤5s 镜最多一次，避免"喘"） */
  const breathClause = duration > 0 && duration <= 6
    ? "一次完整呼吸：吸气落在前三分之一，呼气落在后三分之一"
    : "呼吸平稳两到三次，起伏幅度不抢动作";
  applied.push({ id: "breath", clause: breathClause, because: duration > 0 ? `镜头时长 ${duration}s` : "未给时长，用平稳口径" });

  /* ⑤ 融合：微动作与台词节拍对齐（来自 pacing 字段的显式要求） */
  const fusion = /节拍|半拍|节奏|语速|停顿/.test(pacing)
    ? { clause: "句中微顿、句末留半拍静止，微动作让位给台词重音", because: "pacing 已显式规定节拍" }
    : { clause: "微动作与台词同起同落，不说话时动作不停、说话时动作减半", because: "无显式节拍指令，用通用对齐口径" };
  applied.push({ id: "fusion", clause: fusion.clause, because: fusion.because });

  let joined = applied.map((c) => c.clause).join("；");
  if (joined.length > MAX_ADDED_CHARS) joined = `${joined.slice(0, MAX_ADDED_CHARS - 1)}…`;
  return { schemaVersion: "workloom.micromotion-trace/v1", shotId, applied, skipped: null, text: joined, charDelta: joined.length };
}

/**
 * 应用到镜头卡：把 5 路语句追加到 `action` 末尾（并打上幂等标记）。
 * 返回**新的卡片对象**（不改原对象，便于对照与回滚）。
 */
export function applyMicromotion(card: Record<string, unknown>): { card: Record<string, unknown>; trace: MicromotionTrace } {
  const action = pick(card, "action");
  if (action.includes(MICROMOTION_MARKER)) {
    return {
      card: { ...card },
      trace: { schemaVersion: "workloom.micromotion-trace/v1", shotId: String(card.shotId ?? ""), applied: [], skipped: "卡片已含【微动作】标记，跳过（幂等）", text: "", charDelta: 0 }
    };
  }
  const plan = planMicromotion(card);
  const enhancedAction = action.trim() ? `${action.trim()} ${MICROMOTION_MARKER}${plan.text}` : `${MICROMOTION_MARKER}${plan.text}`;
  return { card: { ...card, action: enhancedAction }, trace: plan };
}
