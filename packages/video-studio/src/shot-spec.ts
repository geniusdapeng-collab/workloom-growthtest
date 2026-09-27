/**
 * shot-spec.ts —— 镜头卡字段规范（内容镜 25 字段 / 片头 30 字段）与交付闸
 *
 * 真机背景（2026-09-22 审计 VID-1019）：
 *  1. 管线产出的**内容镜头 `prompt` 为空**（`productionEngine.prompts[].prompt === ''`）：
 *     `index.js:1519-1533` 的"按 25 字段重算 prompt"依赖 `shot.fields`，而标准镜头卡里没有该字段，
 *     重算被跳过 → `DualArraySync` 把空 `prompt` 覆盖到 prompts 数组。只有片头镜头在
 *     `_optimizeOpeningTitle` 后被重新组装，所以 S1 有 prompt、其余为空。
 *  2. 我方出片工具当时用自写短提示词（400–900 字）直接提交，既低于 `prompt-length.js` 的
 *     `REFINED_MIN=1200`，也**丢掉片头 5 个专属字段**（片头规则在渲染接缝失效）。
 *
 * 本模块把"规范"完全交给 vendor 唯一真源，不在 TS 层复制任何字面值：
 *  · 字段规范      ← `engines/field-standardizer.js`（CRITICAL_FIELDS / standardizeShot / validateShot）
 *  · 组装器        ← `engines/production-engine/agents/prompt-fusion-agent.js`（_assembleStandardPrompt）
 *  · 交付闸        ← `engines/production-engine/agents/prompt-delivery-guard.js`（verify：25/30 字段 + 长度 + 台词 + 锚点）
 *  · 长度口径      ← `config/prompt-length.js`（TARGET_MIN/TARGET_MAX/HARD_MAX/REFINED_MIN）
 */
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, resolve as resolvePath } from "node:path";
import { fileURLToPath } from "node:url";
import { normalizeNegativeConstraintItems } from "./prompt-language.js";

export interface FieldSpec {
  p0: string[];
  p1: string[];
  p2: string[];
  p3: string[];
  common: string[];
  opening: string[];
  /** 片头专属 5 字段（第 26–30 字段） */
  openingExclusive: string[];
  lengths: { targetMin: number; targetMax: number; hardMax: number; refinedMin: number };
}

export interface ShotSpecReport {
  shotId: string;
  isOpening: boolean;
  durationSec: number;
  /** 交付用提示词（序号+独立行排版） */
  prompt: string;
  /** pipeline = 直接复用管线定稿；assembled = 由 25/30 字段按 vendor 组装器重建 */
  promptSource: "pipeline" | "assembled";
  charCount: number;
  /** 25 字段里为空的（P0/P1/P2/P3） */
  missingSpecFields: string[];
  /** 片头专属 5 字段里为空的 */
  missingOpeningFields: string[];
  /** vendor PromptDeliveryGuard 判定 */
  delivery: { pass: boolean; issues: string[] };
  degraded: boolean;
  degradeReason: string;
  /** 内容红线命中（实验车道：科幻/微观等与 brief 无关的意象） */
  redlines: string[];
  /**
   * 【场景】是否被 vendor 写实校验替换/漂移（2026-09-26 真机 T-2026-0926-0007）。
   * 被替换时提示词里的【场景】已经不是卡片写的那一段——必须显式暴露，不能等监制看画面才发现。
   */
  sceneSubstituted: boolean;
  /** 场景替换/漂移的细节（未替换时为 null） */
  sceneSubstitution: SceneSubstitutionReport | null;
}

/**
 * vendor 写实校验（`config/production-profile.js#REALISM_FORBIDDEN.full.scene`）使用的场景禁用词。
 * 命中后 vendor 的 `rule-fallback` 会把整段【场景】**静默替换**成 `config/neutral-fallbacks.js`
 * 里的中立模板；真机证据：卡片写"打烊店铺前厅 + 门外霓虹"，成图却是"简约室内房间 + 白墙窗帘"。
 */
export const REALISM_FORBIDDEN_SCENE_WORDS = [
  "全息", "虚拟", "投影", "抽象", "光影场域", "数据空间", "元宇宙", "时间操控",
  "霓虹", "微观世界", "宏观", "抽象几何", "流动光影", "交织光影", "色彩对冲"
];

/** vendor 的中立兜底场景模板（`config/neutral-fallbacks.js#FALLBACK_SCENES` 原样） */
export const NEUTRAL_FALLBACK_SCENES = [
  "室内明亮空间,白色顶灯均匀照明,浅色墙面挂有无文字图形装饰画,木质桌面带有细微使用痕迹,地面浅灰色地板",
  "现代开放式走廊,冷白色LED光源从顶部连续排列向下照射,无文字指示标识,地面浅色抛光瓷砖,墙面纯白涂层",
  "简约室内房间,白色墙面悬挂无文字示意图,桌面摆放日常器物,窗户透入自然光,浅色窗帘半掩",
  "开放式公共大厅,嵌入式灯带洒下柔和暖白光,接待台后方排列无文字图形展板,前方沙发与茶几,地面灰色哑光瓷砖"
];

export interface SceneSubstitutionReport {
  substituted: boolean;
  reason: string;
  /** 镜头卡里写的【场景】 */
  from: string;
  /** 组装后提示词里的【场景】 */
  to: string;
  /** 卡片场景命中的写实禁用词 */
  hits: string[];
  /** 两段场景文本的字符二元组重合度（0–1） */
  overlap: number;
}

/** 场景文本归一（去标点与空白），用于机械比对 */
function normalizeSceneForCompare(text: string): string {
  return String(text ?? "").replace(/[\s，。、；：,.;:"'“”「」（）()\-—…]/g, "");
}

function sceneBigrams(text: string): Set<string> {
  const out = new Set<string>();
  for (let i = 0; i + 1 < text.length; i += 1) out.add(text.slice(i, i + 2));
  return out;
}

/**
 * 【场景】替换/漂移检测（零 token 确定性判据）。
 *
 * 判定顺序：
 *   1. 组装后的场景**就是** vendor 的中立兜底模板 → 判替换（写实校验触发）；
 *   2. 组装后的场景与卡片场景的字符二元组重合度 < 0.35 → 判漂移（提示词里的场景已经不是卡片写的）；
 *   3. 其余判一致。
 */
export function detectSceneSubstitution(cardScene: string, assembledScene: string): SceneSubstitutionReport {
  const from = String(cardScene ?? "").trim();
  const to = String(assembledScene ?? "").trim();
  const hits = REALISM_FORBIDDEN_SCENE_WORDS.filter((word) => from.includes(word));
  const normFrom = normalizeSceneForCompare(from);
  const normTo = normalizeSceneForCompare(to);
  if (!normFrom || !normTo) {
    return { substituted: false, reason: "场景文本缺失，无法比对", from, to, hits, overlap: 0 };
  }
  const fallbackHit = NEUTRAL_FALLBACK_SCENES.some((template) => normalizeSceneForCompare(template) === normTo);
  const a = sceneBigrams(normFrom);
  const b = sceneBigrams(normTo);
  let inter = 0;
  for (const gram of a) if (b.has(gram)) inter += 1;
  const union = a.size + b.size - inter;
  const overlap = union > 0 ? inter / union : 0;
  if (fallbackHit) {
    return {
      substituted: true,
      reason: `【场景】被替换为 vendor 中立兜底模板（写实校验命中：${hits.join("、") || "未知词"}）`,
      from, to, hits, overlap: Number(overlap.toFixed(3))
    };
  }
  if (overlap < 0.35) {
    return {
      substituted: true,
      reason: `【场景】与镜头卡不一致（重合度 ${(overlap * 100).toFixed(0)}%）`,
      from, to, hits, overlap: Number(overlap.toFixed(3))
    };
  }
  return { substituted: false, reason: "场景与镜头卡一致", from, to, hits, overlap: Number(overlap.toFixed(3)) };
}

export interface PrepareOptions {
  /** 画幅（写入【约束】段），默认 9:16 */
  ratio?: string;
  /** 分辨率（写入【约束】段），默认 1080x1920（竖版） */
  resolution?: string;
  /** 实际提交帧率；不指定时保留历史 24fps 口径。 */
  fps?: number;
  /**
   * 内容红线词表（默认取自 vendor `field-standardizer` 的 scene 禁词 + 本车道补充观察到的漂移词）。
   * 命中即判不合格，除非在 `allowRedlines` 中显式放行。
   */
  redlineWords?: string[];
  allowRedlines?: string[];
  log?: (line: string) => void;
}

/**
 * 【约束】段画幅、像素与帧率归一。
 *
 * 真机发现（2026-09-22）：`PromptFusionAgent` 构造 `FieldContentRefiner` 时**硬编码**
 * `constraintTemplate: '16:9画幅，8K分辨率，24fps，MP4格式'`；只有当平台蓝图被判为
 * 社媒营销包（`isSocialCommerce(profile)`）时才改用 `constraintTemplateOf(profile)`。
 * 我们的竖版 9:16 项目在电影叙事画像下会拿到 16:9 的【约束】，与实际提交参数矛盾
 * （API 层 ratio 仍按 9:16 出片，但提示词自相矛盾）。这里按**实际提交参数**归一该段。
 */
export function normalizeConstraintSegment(
  prompt: string,
  ratio: string,
  resolution: string,
  fps = 24
): { prompt: string; changed: boolean; from: string | null } {
  if (!Number.isInteger(fps) || fps < 1 || fps > 120) throw new Error("镜头约束帧率必须是 1–120 的整数");
  const match = prompt.match(/【约束】([^\n|]*)/);
  if (!match) return { prompt, changed: false, from: null };
  const current = match[1]?.trim() ?? "";
  const target = `${ratio}画幅，${resolution}，${fps}fps，MP4格式`;
  if (current.includes(`${ratio}画幅`) && current.includes(resolution)
    && current.includes(`${fps}fps`) && /MP4/i.test(current)) return { prompt, changed: false, from: current };
  const format = /MP4(?:格式)?/i.exec(current);
  const suffix = format ? current.slice(format.index + format[0].length) : "";
  return {
    prompt: prompt.replace(match[0], `【约束】${target}${suffix}`),
    changed: true,
    from: current
  };
}

/** 供应商常用 "1080p"/"720p" 口径 → 具体像素（按画幅推导；已是 WxH 的原样返回） */
export function resolutionToPixels(resolution: string, ratio: string): string {
  if (/^\d+\s*[x×]\s*\d+$/.test(resolution)) return resolution.replace(/\s*[x×]\s*/, "x");
  const match = resolution.match(/^(\d+)p$/i);
  if (!match) return resolution;
  const short = Number(match[1]);
  const [w, h] = ratio.split(":").map(Number);
  if (!w || !h) return `${short}x${short}`;
  const long = Math.round((short * Math.max(w, h)) / Math.min(w, h));
  return w >= h ? `${long}x${short}` : `${short}x${long}`;
}

/* ================= 结构化字段 → 可读文案（消除 [object Object]） ================= */

/** 任意结构化值 → 可读字符串（数组 join、对象按 key 拼接、优先 `.string` 字段） */
export function readableValue(value: unknown, depth = 0): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return value.trim();
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (Array.isArray(value)) {
    return value.map((item) => readableValue(item, depth + 1)).filter(Boolean).join("；");
  }
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    if (typeof record.string === "string" && record.string.trim()) return record.string.trim();
    if (depth > 2) return "";
    return Object.entries(record)
      .filter(([key]) => !key.startsWith("_"))
      .map(([key, item]) => {
        const text = readableValue(item, depth + 1);
        if (!text) return "";
        const label = FIELD_LABEL_CN[key] ?? key;
        return label === key ? text : `${label}：${text}`;
      })
      .filter(Boolean)
      .join("；");
  }
  return "";
}

const FIELD_LABEL_CN: Record<string, string> = {
  key_light: "主光",
  fill_light: "补光",
  time_of_day: "时间",
  atmosphere: "氛围",
  composition: "构图",
  timeline: "时间轴",
  camera: "运镜",
  movement: "运动",
  shotType: "景别",
  purpose: "目的",
  string: "",
  object: ""
};

/**
 * 把镜头卡里的结构化字段规范成**可读字符串**。
 *
 * 真机证据（2026-09-22 VID-1021）：管线产出的 `lighting`/`camera_movement`/`timeline`/
 * `backgroundSound`/`dialogue` 是对象或数组，而 vendor 的字段契约（`[CONTRACT]` 校验）
 * 与提示词组装器（`_assembleStandardPrompt`）都按字符串消费 →
 * 组装出的提示词里出现 **6–7 处 `[object Object]`**，模型拿到的是占位垃圾；
 * 同时 `FieldCheckAgent._checkStructure` 对数组时间轴执行 `tl.match` 直接崩溃。
 *
 * 这里按"业务可读"归一：数组拼接、对象取 `.string` 或按键值中文化拼接，
 * 原始结构化值保留在 `_raw<Field>` 供需要结构化消费的环节使用。
 */
export function normalizeStructuredFields(
  shot: Record<string, unknown>
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...shot };
  const targets = [
    "lighting",
    "camera_movement",
    "cameraMovement",
    "timeline",
    "backgroundSound",
    "background_sound",
    "audio",
    "dialogue"
  ];
  for (const key of targets) {
    const value = out[key];
    if (value === null || value === undefined) continue;
    if (typeof value === "string") continue;
    const text = readableValue(value);
    if (!text) continue;
    out[`_raw${key.charAt(0).toUpperCase()}${key.slice(1)}`] = value;
    out[key] = text;
  }
  // dialogue 例外：vendor 交付格式是 dialogueBlocks；字符串化后的 dialogue 仅作兜底
  if (Array.isArray(out.dialogue) && out.dialogue.length > 0) {
    const blocks = out.dialogue
      .map((item) => (item && typeof item === "object" ? (item as Record<string, unknown>) : null))
      .filter(Boolean) as Array<Record<string, unknown>>;
    if (blocks.length > 0 && blocks.every((b) => typeof b.line === "string" || typeof b.text === "string")) {
      out.dialogue = blocks
        .map((b) => `${String(b.speaker ?? "角色")}：${String(b.line ?? b.text ?? "").trim()}`)
        .join("；");
    }
  }
  return out;
}

interface VendorFieldStandardizer {
  CRITICAL_FIELDS: {
    p0: string[]; p1: string[]; p2: string[]; p3: string[];
    common: string[]; opening: string[]; content: string[];
  };
  standardizeShot(shot: Record<string, unknown>): Record<string, unknown>;
  validateShot(shot: Record<string, unknown>, options?: Record<string, unknown>): {
    passed: boolean; errors: string[]; warnings: string[]; p0Missing: number; p1Missing: number; promptLength: number;
  };
  isOpeningShot(shot: Record<string, unknown>): boolean;
  FIELD_NAME_CN: Record<string, string>;
}

interface VendorFusionAgent {
  _assembleStandardPrompt(shot: Record<string, unknown>, fields: Record<string, unknown>, ratio: string): string;
  _parseUnifiedDialogueString(dialogueStr: string): Array<Record<string, unknown>>;
}

interface VendorDeliveryGuard {
  verify(promptText: string, shot: Record<string, unknown>): {
    pass: boolean; issues: string[]; fieldCount?: number; charCount?: number;
  };
}

/**
 * **片头 5 个专属字段已下线**（产品所有者口径，2026-09-26）。
 *
 * 原口径（vendor field-standardizer）：片头镜除 25 个标准字段外，还要 5 个专属字段——
 * `title_content` / `subtitle_content` / `title_animation` / `title_font_design` / `opening_audio_design`，
 * 让**生成模型直接把主标题烧进画面**。
 *
 * 为什么下线：标题与主视觉现在由**后期封面工位**产出（`cover` 阶段：封面设计师设计稿 + 确定性合成 +
 * 机检 + 监制），封面卡会作为片头合成进成片。生成阶段再让模型画一遍标题，只会带来两个问题：
 *   ① 生成模型的中文字形不可控（写成错字/糊字，只能整条重渲）；
 *   ② 后期换标题/改口径（如"南昌 46 秒"→"南昌 48 秒"）必须重渲，违背"镜头只生成一次、后续零 token"。
 *
 * 因此本层**不再向生成侧要求这 5 个字段**：片头镜与内容镜同为 25 字段口径，
 * 提示词里也不再注入【主标题内容】【副标题内容】【标题动画设计】【标题字体设计】【开场音频设计】。
 * vendor 真源里的字段定义保持只读不动（那是上游基线），差异在本层显式表达。
 */
export const OPENING_EXCLUSIVE_FIELDS_RETIRED: string[] = [];

/** 兼容出口：历史上片头专属字段的键名（仅用于审计回溯，不再参与校验与提示词注入） */
export const OPENING_EXCLUSIVE_FIELDS_LEGACY = [
  "title_content", "subtitle_content", "title_animation", "title_font_design", "opening_audio_design"
];

/** 已下线的 5 个片头标题段落在提示词里的字面标签（反向自检用） */
export const RETIRED_OPENING_LABELS = [
  "【主标题内容】", "【副标题内容】", "【标题动画设计】", "【标题字体设计】", "【开场音频设计】"
];

/** 实验车道补充红线：真机里出现过的、与行业 brief 无关的意象（vendor 禁词表之外） */
const EXTRA_REDLINE_WORDS = ["细胞质", "核糖体", "微管", "显微镜", "量子", "黑洞", "元宇宙", "数据空间"];

/**
 * 镜头内音频纪律（产品所有者口径，2026-09-23）：
 * 生成镜头**只允许**①台词人声 ②音效 ③旁白；**禁止镜头外加配乐/BGM**——配乐统一在后期环节加入。
 *
 * 边界（产品所有者 2026-09-23 听检 30s 样片后确认）：**画面内实况声源不算配乐**——
 * 街头评弹/三弦/店内音响等「画面里真实存在的声源」可以保留；禁的是镜头外铺底的 BGM/配乐。
 * 这段文本会追加到每个镜头的提示词末尾，并作为交付闸的必备标记（缺它即判不合格）。
 */
export const AUDIO_DISCIPLINE_CLAUSE =
  "【音频纪律】本镜头音频仅允许：台词人声、旁白、环境音效与动作音效；"
  + "严禁镜头外添加的背景音乐、BGM、配乐、音乐节拍（配乐由后期环节统一加入）；"
  + "画面内实况声源（如街头评弹、店内音响等实况音乐）不属配乐，允许保留；"
  + "台词人声清晰自然，环境音与动作音效贴合画面。";

/**
 * 追加到负面约束里的音乐禁词（与 vendor 的英文负面约束同语言）。
 *
 * 注意口径：只禁**非画内（non-diegetic）**的音乐铺底。像 `no singing voice`/`no song`/`no melody`
 * 这类会把画内实况音乐（评弹唱腔、店内广播旋律）一并压掉的词，按 2026-09-23 产品确认去掉。
 */
export const AUDIO_NEGATIVE_TERMS =
  "no non-diegetic music, no background music, no bgm, no soundtrack, no music score, no musical bed";

/* ============================ 写实纪律 + 场景解耦（2026-09-24） ============================ */

/**
 * 写实纪律（默认强制）：人物必须是纯写实真人质感，越像真人越好。
 * 例外：卡片/角色档案显式声明风格（cartoon/anime/3d/stylized/illustration）或主体非人（动物/器物）。
 */
export const REALISM_CLAUSE =
  "【写实纪律】出镜人物一律为纯写实真人质感：真实皮肤纹理（可见毛孔与细颗粒）、自然肤质与面部微结构、"
  + "自然光影与真实镜头语言（纪录片/电影实拍观感）；严禁卡通、动漫、插画、3D/CG 渲染感、塑料感或磨皮美颜。";

/**
 * 场景解耦（默认强制）：人物形象只由角色档案/定妆照决定；镜头场景、光线与色调只按本镜头描述生成，
 * 不得把定妆照的背景/光源/色调（或参考图中的场景特征）带进画面。
 */
export const SCENE_DECOUPLE_CLAUSE =
  "【场景解耦】人物形象（脸型、发型、服装）只以角色档案与定妆照为准；"
  + "本镜头的场景、光源、色调与构图仅按本镜头描述生成，不得照搬定妆照/参考图的背景、布光与色调，"
  + "也不得用参考图的场景特征替换本镜头场景。";

/**
 * 路人/群演写实：背景人物同样按真人质感描述，避免"塑料路人"。
 * 2026-09-28 T1 真机监制打回：原措辞在**单人镜**里被读成"要求出现群演/可能引入额外出镜主体"，
 * 因此改为条件句——只在画面出现群演时生效，并显式禁止无描述时添加人物。
 */
export const EXTRAS_REALISM_CLAUSE =
  "【路人写实】若本镜画面出现路人、群演或背景人物，同样按写实真人质感呈现："
  + "有可辨识的年龄、衣着与自然动作，个体面貌有差异，不出现塑料人偶、重复脸或无面孔人影；"
  + "本镜描述中未出现的群演不得额外添加。";

/** 写实模式下并入负面约束（与 vendor negative 同语言） */
export const REALISM_NEGATIVE_TERMS =
  "no cartoon, no anime, no illustration, no cgi look, no 3d render, no plastic skin, no wax figure, "
  + "no beauty filter, no airbrushed face, no mannequin crowd, no duplicated faces";

/** 允许显式声明的非写实风格（客户明确要求时才可开启） */
export const STYLIZED_STYLES = ["cartoon", "anime", "illustration", "3d", "cg", "stylized", "pixar", "comic"] as const;
/** 非人主体（动物/器物等）不适用"真人写实"约束 */
export const NON_HUMAN_SUBJECTS = ["animal", "creature", "object", "product", "vehicle", "plant", "food"] as const;

export interface RealismPolicy {
  mode: "photoreal" | "stylized";
  reason: string;
}

/**
 * 判定本镜是否走"写实强制"：
 * 默认 photoreal；只有**显式**声明风格或非人主体才豁免（并记录理由，便于审计）。
 */
export function resolveRealismPolicy(card: Record<string, unknown>): RealismPolicy {
  const style = String(card.style ?? card.visualStyle ?? card.renderStyle ?? "").trim().toLowerCase();
  if (!style) {
    /* 无显式风格声明 → 默认写实 */
  } else if ((STYLIZED_STYLES as readonly string[]).includes(style)) {
    return { mode: "stylized", reason: `卡片显式声明风格「${style}」` };
  } else if (style === "realistic" || style === "photoreal" || style === "live-action" || style === "写实") {
    /* 显式写实 → 照常强制 */
  } else if (style !== "realistic") {
    return { mode: "stylized", reason: `卡片显式声明风格「${style}」` };
  }
  const subject = String(card.subjectType ?? card.subject ?? "").trim().toLowerCase();
  if ((NON_HUMAN_SUBJECTS as readonly string[]).includes(subject)) {
    return { mode: "stylized", reason: `主体非人（${subject}），不适用真人写实约束` };
  }
  if (card.realism === false || card.photoreal === false) {
    return { mode: "stylized", reason: "卡片显式关闭写实约束（realism/photoreal=false）" };
  }
  return { mode: "photoreal", reason: "默认口径（未声明其它风格、主体为人）" };
}

/** 正向音乐词（用于清洗 audio 字段与提示词中的音乐指令） */
const POSITIVE_MUSIC_PATTERN =
  /(背景音乐|配乐|音乐风格|音乐节拍|旋律|歌曲|music\s*style|background\s*music|\bbgm\b|\bmusic\b|soundtrack)/gi;

/**
 * 否定式音乐表述（"无配乐/不加配乐/no bgm"）：与音频纪律**同向**，必须保留——
 * 真机出片（2026-09-23 平江路 30s dry-run）里 vendor 音频设计会写「人声清晰，无配乐」，
 * 若按正向词一刀切，会把这些合规表述一起删掉。
 */
const NEGATED_MUSIC_PATTERN =
  /(无|没有|不含|不加|不出现|不加入|禁止|避免|无需|不要)[^，。；;、,.]{0,6}(背景音乐|配乐|音乐|BGM|旋律|歌曲|soundtrack)|no\s+(background\s+)?music|no\s+bgm|without\s+(background\s+)?music/i;

/**
 * 清洗镜头卡的 `audio` 字段：vendor 的 `AudioDesignAgent` 会把「音乐风格/配乐」写进该字段，
 * 与"镜头内禁止 BGM"冲突。这里把含音乐词的分句整句剔除（保留环境音/音效描述），并记录日志。
 *
 * 口径边界（2026-09-23 产品确认）：**画内实况声源保留**——「远处评弹声」「三弦、琵琶声」
 * 「店内音响」这类画面里真实存在的声源不属配乐，不在此清洗范围；只有「背景音乐/配乐/音乐风格」
 * 这类后期职责的指令才剔除。
 */
export function sanitizeAudioField(
  audio: unknown,
  log: (line: string) => void = () => undefined
): { value: unknown; stripped: string[] } {
  if (typeof audio !== "string" || !audio.trim()) return { value: audio, stripped: [] };
  const stripped: string[] = [];
  const kept = audio
    .split(/[。；;\n]/)
    .map((seg) => seg.trim())
    .filter(Boolean)
    .filter((seg) => {
      /** 否定式（"无配乐"）与纪律同向：保留，避免误删合规表述 */
      if (NEGATED_MUSIC_PATTERN.test(seg)) return true;
      POSITIVE_MUSIC_PATTERN.lastIndex = 0;
      if (POSITIVE_MUSIC_PATTERN.test(seg)) {
        stripped.push(seg.slice(0, 60));
        return false;
      }
      return true;
    });
  if (stripped.length === 0) return { value: audio, stripped };
  const merged = kept.length > 0
    ? `${kept.join("；")}；${AUDIO_DISCIPLINE_CLAUSE}`
    : AUDIO_DISCIPLINE_CLAUSE;
  log(`[shot-spec] audio 字段剔除 ${stripped.length} 处音乐指令（镜头内禁止 BGM）：${stripped.join(" / ")}`);
  return { value: merged, stripped };
}

let vendorCache: {
  standardizer: VendorFieldStandardizer;
  fusionCtor: new (options?: Record<string, unknown>) => VendorFusionAgent;
  guardCtor: new () => VendorDeliveryGuard;
  spec: FieldSpec;
} | null = null;

function repoRoot(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  return resolvePath(here, "../../..");
}

function vendorRequire(): NodeRequire {
  return createRequire(resolvePath(repoRoot(), "package.json"));
}

function vendorPath(relative: string): string {
  return resolvePath(repoRoot(), "vendor/supermickey/hyperreality-system", relative);
}

function loadVendor() {
  if (vendorCache) return vendorCache;
  const req = vendorRequire();
  const standardizerPath = vendorPath("engines/field-standardizer.js");
  if (!existsSync(standardizerPath)) {
    throw new Error(`字段规范真源缺失：${standardizerPath}（vendor 只读基线不在位）`);
  }
  const standardizer = req(standardizerPath) as VendorFieldStandardizer;
  const lengthCfg = req(vendorPath("config/prompt-length.js")) as {
    TARGET_MIN: number; TARGET_MAX: number; HARD_MAX: number; REFINED_MIN: number;
  };
  const fusionMod = req(vendorPath("engines/production-engine/agents/prompt-fusion-agent.js")) as {
    PromptFusionAgent: new (options?: Record<string, unknown>) => VendorFusionAgent;
  };
  const guardMod = req(vendorPath("engines/production-engine/agents/prompt-delivery-guard.js")) as {
    PromptDeliveryGuard: new () => VendorDeliveryGuard;
  };

  const spec: FieldSpec = {
    p0: [...standardizer.CRITICAL_FIELDS.p0],
    p1: [...standardizer.CRITICAL_FIELDS.p1],
    p2: [...standardizer.CRITICAL_FIELDS.p2],
    p3: [...standardizer.CRITICAL_FIELDS.p3],
    common: [...standardizer.CRITICAL_FIELDS.common],
    opening: [...standardizer.CRITICAL_FIELDS.opening],
    /** 片头专属字段已下线（见 OPENING_EXCLUSIVE_FIELDS_RETIRED 注释）——本层固定为空 */
    openingExclusive: [...OPENING_EXCLUSIVE_FIELDS_RETIRED],
    lengths: {
      targetMin: lengthCfg.TARGET_MIN,
      targetMax: lengthCfg.TARGET_MAX,
      hardMax: lengthCfg.HARD_MAX,
      refinedMin: lengthCfg.REFINED_MIN
    }
  };
  vendorCache = {
    standardizer,
    fusionCtor: fusionMod.PromptFusionAgent,
    guardCtor: guardMod.PromptDeliveryGuard,
    spec
  };
  return vendorCache;
}

/** 字段规范快照（25 字段 + 片头 5 专属 + 长度口径），全部来自 vendor 真源 */
export function fieldSpec(): FieldSpec {
  return loadVendor().spec;
}

/** 25 字段的完整键列表（含 common 之外的 P0–P3 与片头 two title 字段） */
export function specFieldKeys(includeOpeningExtras = false): string[] {
  const spec = fieldSpec();
  const keys = [...spec.p0, ...spec.p1, ...spec.p2, ...spec.p3, ...spec.opening];
  return includeOpeningExtras ? [...keys, ...spec.openingExclusive] : keys;
}

function isEmptyValue(value: unknown): boolean {
  if (value === undefined || value === null) return true;
  if (typeof value === "string") return value.trim() === "";
  if (Array.isArray(value)) return value.length === 0;
  if (typeof value === "object") return Object.keys(value as Record<string, unknown>).length === 0;
  return false;
}

/**
 * 台词块归一：把镜头卡里的台词数据整理成 vendor 交付格式 `dialogueBlocks`。
 *
 * 为什么必须做（真机 2026-09-22）：组装器只在 `shot.dialogueBlocks` 存在时渲染
 * 「【台词】[Ns-Ms] 角色 触发, 情绪副词 说:"…"」；否则走旧回退把 `dialogue` 数组
 * `String()` 成 `[object Object]`，被交付闸判「台词格式不规范」。而 vendor 的标准镜头卡
 * （`standardizeShot` 产物）里根本没有 `dialogueBlocks` 键——台词在管线里注定丢失。
 * 这里优先复用 vendor 自己的 `_parseUnifiedDialogueString`（`SPEAKER|TYPE|EMOTION|TEXT|LIP_SYNC:YES`）。
 */
export function normalizeDialogueBlocks(
  card: Record<string, unknown>,
  fusion: Pick<VendorFusionAgent, "_parseUnifiedDialogueString">
): Array<Record<string, unknown>> {
  const explicit = card.dialogueBlocks;
  if (Array.isArray(explicit) && explicit.length > 0) {
    return explicit as Array<Record<string, unknown>>;
  }
  const dialogue = card.dialogue;
  const entries: unknown[] = Array.isArray(dialogue) ? dialogue : dialogue ? [dialogue] : [];
  const blocks: Array<Record<string, unknown>> = [];
  for (const entry of entries) {
    if (typeof entry === "string") {
      const parsed = fusion._parseUnifiedDialogueString(entry);
      if (parsed.length > 0) blocks.push(...parsed);
      else if (entry.trim()) blocks.push({ speaker: "角色", line: entry.trim(), emotion: "平静地", trigger: "看向对方" });
      continue;
    }
    if (!entry || typeof entry !== "object") continue;
    const record = entry as Record<string, unknown>;
    const text = typeof record.text === "string" ? record.text : typeof record.line === "string" ? record.line : "";
    if (!text.trim()) continue;
    if (text.includes("|")) {
      const parsed = fusion._parseUnifiedDialogueString(text);
      if (parsed.length > 0) {
        blocks.push(...parsed.map((block) => ({
          trigger: record.trigger ?? "看向对方",
          ...block
        })));
        continue;
      }
    }
    blocks.push({
      speaker: record.speaker ?? "角色",
      line: text.trim(),
      emotion: record.emotion ?? "平静地",
      trigger: record.trigger ?? "看向对方"
    });
  }
  return blocks;
}

/**
 * 把镜头卡准备成"可交付的提示词 + 规范报告"。
 *
 * 规则（不劣化优先）：
 *  1. 管线定稿 `prompt` 若已达标（过 vendor 交付闸）→ 直接复用（promptSource=pipeline）；
 *  2. 否则用 vendor 组装器按 25/30 字段重建（promptSource=assembled）；
 *  3. 两条路径都要过 vendor 交付闸；不过则如实列出 issues（调用方不得提交）。
 */
export function prepareShotPrompt(
  card: Record<string, unknown>,
  options: PrepareOptions = {}
): ShotSpecReport {
  const { standardizer, fusionCtor, guardCtor, spec } = loadVendor();
  const ratio = options.ratio ?? "9:16";
  const resolution = resolutionToPixels(
    options.resolution ?? (ratio === "9:16" ? "1080x1920" : "1920x1080"),
    ratio
  );
  const log = options.log ?? (() => undefined);
  /** 先做结构化字段归一：避免 `[object Object]` 进入提示词（真机 6–7 处/镜） */
  const normalizedCard = normalizeStructuredFields(card as Record<string, unknown>);
  /** 音频纪律：清洗 audio 字段里的音乐指令（vendor 音频设计会写「音乐风格/配乐」） */
  const audioClean = sanitizeAudioField(normalizedCard.audio, log);
  if (audioClean.value !== normalizedCard.audio) normalizedCard.audio = audioClean.value;
  const std = standardizer.standardizeShot(normalizedCard) as Record<string, unknown>;
  const isOpening = Boolean(standardizer.isOpeningShot(std)) || std.sceneType === "opening";
  const shotId = String(std.shotId ?? card.shotId ?? "");
  const durationSec = Number(std.duration ?? card.duration ?? 0) || 0;

  const fields: Record<string, unknown> = {};
  /**
   * 取值口径：标准化产物优先，但它可能把合法输入"标准化成空"——
   * 例如 `normalizeTimeline` 对字符串时间轴返回 `[]`（真机 2026-09-22 实测）。
   * 因此统一走 `effective()`：标准值为空时回落到原始镜头卡取值。
   */
  const effective = (key: string): unknown => {
    const normalized = std[key];
    if (!isEmptyValue(normalized)) return normalized;
    // 回落到**归一后的**卡片（而不是原始卡片）：否则结构化字段会绕过归一，
    // 再次以 `[object Object]` 进入提示词（真机 2026-09-22 复现）
    const raw = normalizedCard[key];
    return isEmptyValue(raw) ? undefined : raw;
  };
  for (const key of specFieldKeys(true)) {
    const value = effective(key);
    if (!isEmptyValue(value)) fields[key] = value;
  }

  const guard = new guardCtor();
  const fusion = new fusionCtor({ semanticRefinement: false });
  const dialogueBlocks = normalizeDialogueBlocks(card, fusion);
  const assemblyShot: Record<string, unknown> = dialogueBlocks.length > 0
    ? { ...std, dialogueBlocks }
    : std;

  const pipelinePrompt = typeof std.prompt === "string" ? std.prompt.trim() : "";
  let prompt = "";
  let promptSource: ShotSpecReport["promptSource"] = "assembled";
  if (pipelinePrompt) {
    const verdict = guard.verify(pipelinePrompt, assemblyShot);
    if (verdict.pass) {
      prompt = pipelinePrompt;
      promptSource = "pipeline";
    }
  }
  if (!prompt) {
    prompt = fusion._assembleStandardPrompt(assemblyShot, fields, ratio);
  }
  /**
   * 音频纪律子句 + 音乐负面词：确保**每一镜**都显式声明"禁止镜头内 BGM"，
   * 并追加英文负面约束（与 vendor 的 negative 同语言，便于模型按词面规避）。
   */
  if (!prompt.includes("【音频纪律】")) prompt += ` | ${AUDIO_DISCIPLINE_CLAUSE}`;
  if (!/no background music/i.test(prompt)) prompt += ` | ${AUDIO_NEGATIVE_TERMS}`;
  /**
   * 写实纪律 + 场景解耦 + 路人写实（2026-09-24 产品口径，**默认强制**）：
   * 人物纯写实（越像真人越好）；人物形象只由角色档案/定妆照决定，场景/光线/色调只按本镜头描述生成；
   * 路人同样按真人质感。仅当卡片显式声明风格（cartoon/anime/3d/stylized…）、主体非人，或 realism=false 时豁免。
   */
  const realismPolicy = resolveRealismPolicy(card as Record<string, unknown>);
  if (realismPolicy.mode === "photoreal") {
    if (!prompt.includes("【写实纪律】")) prompt += ` | ${REALISM_CLAUSE}`;
    if (!prompt.includes("【场景解耦】")) prompt += ` | ${SCENE_DECOUPLE_CLAUSE}`;
    if (!prompt.includes("【路人写实】")) prompt += ` | ${EXTRAS_REALISM_CLAUSE}`;
    if (!/no cartoon/i.test(prompt)) prompt += ` | ${REALISM_NEGATIVE_TERMS}`;
  } else {
    log(`[shot-spec] ${shotId} 写实约束豁免：${realismPolicy.reason}（如属误判请在卡片显式声明 style/subjectType）`);
  }
  const constraint = normalizeConstraintSegment(prompt, ratio, resolution, options.fps ?? 24);
  if (constraint.changed) {
    log(
      `[shot-spec] ${shotId} 【约束】画幅/分辨率/帧率归一：${constraint.from || "（空）"} → ${ratio}画幅，${resolution}，${options.fps ?? 24}fps`
      + "（按实际提交参数纠正 vendor 的固定模板）"
    );
    prompt = constraint.prompt;
  }

  /**
   * 无台词镜：**摘掉空的【台词】段**（2026-09-25 南昌片真机）。
   * 组装器会无条件输出一行 `NN.【台词】`；对显式声明 `dialogueFree: true` 的镜头（快剪城市片里
   * 只做动作不说话的临时角色/空镜），交付守卫会判「数据层无台词但出现【台词】字段（疑似虚构）」。
   * 这里在**交付前**把这一空段删掉（只删空段：有台词内容的镜头不动），既符合"空镜禁虚构"的纪律，
   * 也避免卡片被逼着写假台词。
   */
  if (card.dialogueFree === true) {
    const stripped = prompt
      .split("\n")
      .filter((line) => !/^\s*\d{1,2}\.\s*【台词】\s*$/.test(line))
      .join("\n");
    if (stripped !== prompt) {
      /**
       * 移除空【台词】段后**重排字段编号**：否则会出现 01…17、19…（缺 18）的断号，
       * 监制会把"字段缺号"当成结构性缺陷打回（真机 2026-09-25 NC-08）。
       */
      prompt = stripped
        .split("\n")
        .map((line, index) => (/^\s*\d{1,2}\.\s*【/.test(line) ? line.replace(/^\s*\d{1,2}\.\s*(?=【)/, `${String(index + 1).padStart(2, "0")}.`) : line))
        .join("\n");
      log(`[shot-spec] ${shotId} 无台词镜：已移除空【台词】段并重排字段编号（dialogueFree=true）`);
    }
  }

  /**
   * 语言约束的**显式豁免**（2026-09-25 南昌片真机）：
   * 管线自检要求提示词里保留少量英文禁词标记（`no background music` / `no cartoon` 等，见下方音频与写实纪律自检），
   * 而 vendor 的【语言约束】写的是"全部中文、禁止英文单词"——两者并存会被监制判"自相矛盾"。
   * 这里在【语言约束】后**显式写明豁免范围与用途**：既不偷偷违规，也不让机器标记被当成文案缺陷。
   */
  if (/【语言约束】/.test(prompt) && /(no background music|no non-diegetic music|no cartoon)/i.test(prompt)) {
    /** 幂等标记：复用已定稿 prompt 时不得重复追加豁免说明（真机单测：追加两次 = 文案噪声） */
    const exemptionMark = "（豁免：管线自检要求的英文禁词标记";
    prompt = prompt.replace(/^(\s*\d{1,2}\.\s*【语言约束】[^\n]*)$/m, (line) => {
      if (line.includes(exemptionMark)) return line;
      return `${line.replace(/[。\s]+$/, "")}（豁免：管线自检要求的英文禁词标记 no background music / no cartoon 等仅作机器校验，不作为画面语言。）`;
    });
  }

  /**
   * 【负面约束】**双重否定反转**归一（2026-09-25 南昌片真机）：
   * 组装器会把"no"前缀与中文否定词拼在一起，产生 `no 无扭曲` / `no malformed fingers` 这类半英半中、
   * 语义反转的条目（"不要无扭曲" = 要扭曲）。这里只对【负面约束】那一行做归一：英文 `no XXX` 逐条换成中文否定，
   * 中文里已有的 `无…` 保持；不触碰写实纪律/音频纪律自检所需的英文标记。
   */
  const negativeFixes: Array<[RegExp, string]> = [
    [/\bno\s+无/g, "无"],
    [/\bno\s+low resolution\b/gi, "无低分辨率"],
    [/\bno\s+pixelated\b/gi, "无像素化"],
    [/\bno\s+compression noise\b/gi, "无压缩噪点"],
    [/\bno\s+malformed fingers\b/gi, "无畸形手指"],
    [/\bno\s+fused fingers\b/gi, "无粘连手指"],
    [/\bno\s+artifacts?\b/gi, "无伪影"],
    [/\bno\s+distortion\b/gi, "无变形"],
    [/\bno\s+blur\b/gi, "无模糊"],
    [/\bno\s+extra limbs?\b/gi, "无多余肢体"]
  ];
  prompt = prompt.replace(/^(\s*\d{1,2}\.\s*【负面约束】)([^\n]*)$/m, (_line, head: string, body: string) => {
    let fixedBody = body;
    for (const [pattern, replacement] of negativeFixes) fixedBody = fixedBody.replace(pattern, replacement);
    fixedBody = fixedBody.replace(/,\s*,+/g, ", ").replace(/\s{2,}/g, " ");
    /**
     * 去重 + 补否定前缀：组装会把"无文字/无水印/无标牌"这类条目重复拼接，卡片里也可能把禁用项
     * 写成裸词（`水印`、`脸漂`）——两条都属于真机监制打回项，见 normalizeNegativeConstraintItems。
     */
    return `${head}${normalizeNegativeConstraintItems(fixedBody).body}`;
  });

  const delivery = guard.verify(prompt, assemblyShot);
  /**
   * 片头标题字段下线的**落地处理**（2026-09-26）：
   * vendor 交付闸（只读基线）仍按"片头 30 字段"口径报 `缺片头专属字段:…`，
   * 本层已不再向生成侧要求这 5 个字段（标题由后期封面产出），因此：
   *   ① 过滤掉这批告警（它们不再是缺陷）；
   *   ② 若过滤后没有其它问题 → 判放行（否则片头镜会永远卡在"缺标题字段"上，真机就是这么卡住的）；
   *   ③ 反向自检：提示词里**不该**再出现这 5 个段落（出现即说明有人把标题塞回生成侧）。
   */
  if (isOpening) {
    const retiredPattern = /^缺片头专属字段:/;
    const retired = delivery.issues.filter((issue) => retiredPattern.test(issue));
    if (retired.length > 0) {
      delivery.issues = delivery.issues.filter((issue) => !retiredPattern.test(issue));
      if (delivery.issues.length === 0) delivery.pass = true;
      log(`[shot-spec] ${shotId} 片头标题字段已下线：忽略 vendor 交付闸的 ${retired.length} 条"缺片头专属字段"（标题由后期封面产出）`);
    }
    const leaked = RETIRED_OPENING_LABELS.some((label) => prompt.includes(label));
    if (leaked) {
      delivery.pass = false;
      delivery.issues = [...delivery.issues, "提示词出现片头标题段落（主标题/副标题/标题动画/标题字体/开场音频设计）：该口径已下线，标题由后期封面产出"];
    }
  }
  /** 兜底自检：提示词里出现 `[object Object]` 属组装缺陷，直接判不合格 */
  const objectLeaks = (prompt.match(/\[object Object\]/g) ?? []).length;
  if (objectLeaks > 0) {
    delivery.pass = false;
    delivery.issues = [...delivery.issues, `提示词含 ${objectLeaks} 处 [object Object]（结构化字段未归一）`];
  }
  /** 音频纪律自检：缺标记 = 组装链路没带上禁令 → 判不合格（禁止无声放行 BGM） */
  if (!prompt.includes("【音频纪律】") || !/no background music/i.test(prompt)) {
    delivery.pass = false;
    delivery.issues = [...delivery.issues, "提示词缺少镜头内禁 BGM 的音频纪律子句"];
  }
  /**
   * 写实纪律自检（默认强制）：缺标记 = 组装链路没带上"纯写实 + 场景解耦"约束 → 判不合格。
   * 需要其它风格时必须显式声明（`style` / `subjectType` / `realism:false`），不允许默认静默降级。
   */
  if (realismPolicy.mode === "photoreal"
    && (!prompt.includes("【写实纪律】") || !prompt.includes("【场景解耦】") || !/no cartoon/i.test(prompt))) {
    delivery.pass = false;
    delivery.issues = [...delivery.issues, "提示词缺少「纯写实 + 场景解耦」纪律子句（默认强制；其它风格请在卡片显式声明 style/realism）"];
  }
  const missingSpecFields = [...spec.p0, ...spec.p1, ...spec.p2, ...spec.p3]
    /**
     * `dialogue` 的等价形态：vendor 交付格式是 `dialogueBlocks`（speaker/line/emotion/trigger），
     * 标准镜头卡里没有 dialogue 时不算缺字段（真机口径：有 blocks 即视为台词已提供）。
     *
     * 2026-09-25 补：**无台词镜**（快剪城市片/空镜/人物只做动作）在卡片里显式声明 `dialogueFree: true`
     * 即视为满足该字段——否则这类镜头会被逼着写一句假台词（真机：南昌片 4 个临时角色镜被"缺必备字段:台词"拦下，
     * 而按产品口径它们是**只做动作、不说话**的镜头）。声明是显式的：没写 dialogueFree 又没台词，仍然判缺字段。
     */
    .filter((key) => {
      if (key === "dialogue") {
        const blocks = (card as Record<string, unknown>).dialogueBlocks;
        if (Array.isArray(blocks) && blocks.length > 0) return false;
        if (card.dialogueFree === true) return false;
      }
      return isEmptyValue(effective(key));
    });
  const missingOpeningFields = isOpening
    ? spec.openingExclusive.filter((key) => isEmptyValue(effective(key)))
    : [];

  const redlineWords = options.redlineWords
    ?? [...EXTRA_REDLINE_WORDS];
  const allow = new Set(options.allowRedlines ?? []);
  const haystack = [
    std.scene, std.sceneDescription, std.action, std.character, std.costume, std.props, std.dialogue, std.title, std.subtitle
  ]
    .map((value) => (typeof value === "string" ? value : JSON.stringify(value ?? "")))
    .join(" ");
  const redlines = redlineWords.filter((word) => word && haystack.includes(word) && !allow.has(word));

  if (redlines.length > 0) {
    log(`[shot-spec] ${shotId} 命中内容红线：${redlines.join("、")}（提交前必须处理或显式放行）`);
  }

  /**
   * 【场景】替换/漂移检测（2026-09-26 真机 T-2026-0926-0007）：
   * vendor 的写实校验命中禁用词（如"霓虹"）时会把整段【场景】换成中立兜底模板，且**不写日志**。
   * 早先只能靠监制看画面与卡片不符打回（真机白烧一轮出图 + 一次评审），现在零 token 暴露。
   */
  const sceneSegment = prompt.match(/【场景】([^\n|]*)/);
  const sceneSubstitution = detectSceneSubstitution(String(card.scene ?? ""), sceneSegment?.[1]?.trim() ?? "");
  if (sceneSubstitution.substituted) {
    log(
      `[shot-spec] ${shotId} ⚠ ${sceneSubstitution.reason}｜卡片："${sceneSubstitution.from.slice(0, 40)}"`
      + ` → 提示词："${sceneSubstitution.to.slice(0, 40)}"（重合度 ${(sceneSubstitution.overlap * 100).toFixed(0)}%）`
    );
  }

  return {
    shotId,
    isOpening,
    durationSec,
    prompt,
    promptSource,
    charCount: prompt.length,
    missingSpecFields,
    missingOpeningFields,
    delivery: { pass: delivery.pass, issues: delivery.issues },
    degraded: Boolean(std.degraded),
    degradeReason: String(std.degradeReason ?? ""),
    redlines,
    sceneSubstituted: sceneSubstitution.substituted,
    sceneSubstitution
  };
}

/** 规范报告的 Markdown 表格（出片报告 / 审计报告共用） */
export function shotSpecMarkdown(reports: ShotSpecReport[]): string {
  const spec = fieldSpec();
  const lines = [
    `> 字段规范来源：vendor field-standardizer（25 字段 = P0 ${spec.p0.length} + P1 ${spec.p1.length} + P2 ${spec.p2.length} + P3 ${spec.p3.length}）；`
    + "**片头不再有 5 个专属字段**（主标题/副标题/标题动画/标题字体/开场音频设计）："
    + "标题与主视觉由后期封面工位产出（cover 阶段），生成侧只出 25 字段；"
    + `长度口径 ${spec.lengths.refinedMin}–${spec.lengths.hardMax} 字（目标 ${spec.lengths.targetMin}–${spec.lengths.targetMax}）`,
    "",
    "| 镜头 | 类型 | 字数 | 来源 | 25字段缺 | 交付闸 | 红线 |",
    "|---|---|---:|---|---:|---|---|",
    ...reports.map((r) =>
      `| ${r.shotId} | ${r.isOpening ? "片头(25)" : "内容(25)"} | ${r.charCount} | ${r.promptSource} | `
      + `${r.missingSpecFields.length}${r.missingSpecFields.length ? `（${r.missingSpecFields.slice(0, 3).join("、")}${r.missingSpecFields.length > 3 ? "…" : ""}）` : ""} | `
      + `${r.delivery.pass ? "pass" : `fail(${r.delivery.issues.length})`} | ${r.redlines.length ? r.redlines.join("、") : "—"} |`
    ),
    ""
  ];
  const problems = reports.filter((r) => !r.delivery.pass || r.redlines.length > 0 || r.missingSpecFields.length > 0);
  if (problems.length > 0) {
    lines.push("**未通过明细**", "");
    for (const r of problems) {
      lines.push(`- ${r.shotId}：${[...r.delivery.issues, ...r.redlines.map((w) => `内容红线命中「${w}」`)].join("；") || `缺字段 ${r.missingSpecFields.join("、")}`}`);
    }
    lines.push("");
  }
  return lines.join("\n");
}
