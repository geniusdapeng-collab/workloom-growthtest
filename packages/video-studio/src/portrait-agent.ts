/**
 * portrait-agent —— 定妆照生成 Agent（2026-09-24）
 *
 * 定位：**专做一件事**——为一个角色档案生成"纯写实 + 场景解耦"的定妆照集（默认 4 角度），
 * 产出直接写回档案库（`portraits/vN` + `portrait-sets/vN.json` + `profile.json#portraitSets`）。
 * 后续要升级只改本 Agent（模板/参数/校验），不再散落在各处提示词里。
 *
 * 纪律（来自设计文档附录 A.1/A.2 的实测结论）：
 *   ① 只描述人（外貌/发型/服装）+ 中性浅灰背景 + 中性柔光 5600K；**不写地点/道具/时段**；
 *   ② 禁止美颜与 CG 词（超写实/CG/3D 渲染/8K 渲染/柔光箱），否则出图带塑料感；
 *   ③ 白平衡锚点前置，显式排除 golden hour / 暖黄滤镜；
 *   ④ 出片侧的对应纪律见 `shot-spec.ts#SCENE_DECOUPLE_CLAUSE`（场景只由镜头提示词给）。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync, lstatSync, realpathSync, renameSync, unlinkSync, readdirSync } from "node:fs";
import { join, relative, resolve as resolvePath, isAbsolute, sep } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { REQUIRED_PORTRAIT_ANGLES, assertCharacterComponent, loadCharacterEntry, readPortraitArtifact, selectPortraitWardrobe, verifyPortraitSet, withCharacterArchiveLock, writePortraitJson, type CharacterProfile, type PortraitSet, type PortraitArtifactReceipt } from "./character-archive.js";
import { REALISM_NEGATIVE_TERMS, STYLIZED_STYLES } from "./shot-spec.js";
import { shotIntentHash } from "./shot-intent.js";

export interface PortraitAgentConfig {
  /** 目标角度（默认渲染核心必需 4 角度） */
  angles?: string[];
  model?: string;
  seed?: number;
  size?: string;
  /** 版本号（默认自动 +1） */
  version?: number;
  /** 生成后是否置为 active（默认 true） */
  activate?: boolean;
  /** 图片接口基础地址 */
  baseUrl?: string;
  /**
   * 背景干净度硬闸（默认开启）。定妆照背景必须**均匀、中性、无渐变/无暗角/无投影**，
   * 否则下游 AI 视频环节抠像（matting）会把灰边、暗角与影子一起拖出来。
   * 只有明确的"非抠像用途"（例如艺术风格设定集）才可显式关闭。
   */
  requireCleanBackground?: boolean;
  /** 背景探针（默认 ffmpeg signalstats 实现；单测注入替身以免依赖 ffmpeg） */
  backgroundProber?: BackgroundProber;
  /**
   * 授权真人锚点照片（绝对路径或相对角色目录/仓库根）。给定时走**图生图**，
   * 定妆照集 `source` 记为 `img2img`——纯文生图无法锁住真人面部，这是真人出镜的必需项。
   * 锚点只在本地参与推理，路径按角色目录相对化后落 `portrait-sets/vN.json#anchors` 供审计。
   */
  anchorImages?: string[];
  /** 单次随附锚点上限（Seedream 一致性口径 4 张，默认 4） */
  maxAnchors?: number;
  wardrobeId?: string;
  /** A changed outfit is its own candidate, never a mutation of an existing version. */
  wardrobe?: Record<string, unknown>;
}

/** 角度 → 构图指令（与 vendor angle-catalog 语义一致） */
const ANGLE_FRAMING: Record<string, string> = {
  front: "正面全身像，直立平视镜头，完整身形入画，脚尖完整",
  threeQuarter: "45 度侧身半身像，腰部以上入画，面部转向镜头",
  closeup: "面部特写（头肩以上），直视镜头，五官与皮肤细节清晰",
  side: "90 度正侧面全身像，侧轮廓清晰完整",
  back: "正背面全身像，背对镜头直立，背部与服装细节完整",
  actionPose: "标志性动作全身像，动态张力与身体结构清晰",
  emotionCloseup: "情绪特写，核心情绪状态，微表情层次清晰",
  handDetail: "手部特写，自然姿态与持物姿态清晰",
};

/** 写实（默认）模板：注意不含任何地点/道具/时段词，也不含 CG/超写实/影棚词 */
const PHOTOREAL_TEMPLATE = [
  "白平衡中性（日光 5600K，肤色自然），人像定妆照（与任何场景无关）：",
  "{appearance}",
  /**
   * 抠像友好硬约束（2026-09-24 产品所有者口径）：
   * 定妆照必须能直接拿去抠图——背景是一块均匀的中性浅灰，不许渐变、暗角、投影与地面线。
   * 措辞里仍不出现「无缝纸/柔光箱」等影棚词（附录 A 实测：影棚词会把美颜风格带进成片）。
   */
  "背景为一块完全均匀的中性浅灰（约 RGB 236,236,236），从画面中心到四角亮度一致："
  + "无渐变、无暗角、无光斑、无纹理、无地面线、无地平线、无投影、无落在背景上的影子；",
  "背景里没有任何地点、建筑、道具、环境元素；人物边缘与背景对比清晰、边界干净，可直接用于抠像（matting）；",
  "光照为均匀的中性柔光（非影棚强光、无金色或橙色偏移），人物受光均匀且不会在背景上留下硬阴影；",
  "皮肤保留真实毛孔与细颗粒，眼睛有自然眼神光；85mm 定焦，f/4，低饱和，不做美颜修饰",
].join("");

/** 背景不合格时的加固措辞（重跑用：把"均匀/无投影/可抠像"量化强调一次） */
const PHOTOREAL_TEMPLATE_HARDENED =
  "【背景硬约束·重跑】背景必须是同一块纯色：四角与四边的像素亮度差极小、背景区域为纯中性灰（无彩偏），"
  + "画面中不出现任何渐变、暗角、阴影、地面线、光斑与纹理；人物与背景只靠轮廓分界，"
  + "不允许任何投影或反光落在背景上；整体观感像一张抠像用的基础图（matte），而不是带环境光的人像棚拍。";

const PHOTOREAL_NEGATIVE = [
  "no scene", "no location", "no props", "no golden hour", "no warm filter", "no studio glamour",
  REALISM_NEGATIVE_TERMS,
].join(", ");

/* ================= 背景干净度硬闸（抠像友好，2026-09-24） ================= */

export interface BackgroundBand {
  name: string;
  ylow: number;
  yhigh: number;
  yavg: number;
  satavg: number;
}

export interface BackgroundCheck {
  ok: boolean;
  /** 判定口径标识（写进档案，阈值改版可追溯） */
  policy: string;
  /** 采样模式：ring=外圈条带+四角（全身像）；corners=只判四角（主体填满画面的特写类） */
  mode: "ring" | "corners";
  bands: BackgroundBand[];
  /** 四角平均亮度极差（渐变/暗角越大，值越大） */
  cornerSpread: number;
  maxRange: number;
  maxSat: number;
  notes: string[];
  /**
   * 允许被投影进角色档案的宽类型字段：`PortraitSet.backgroundChecks` 声明为
   * `Record<string, Record<string, unknown>>`（档案是可演进 JSON，不锁死字段），
   * 没有这条索引签名时 `Record<string, BackgroundCheck>` 无法赋给它（TS2322，CI typecheck 直接红）。
   */
  [key: string]: unknown;
}

export type BackgroundProber = (file: string) => BackgroundCheck;

/**
 * 阈值口径 v1（2026-09-24 实测标定）。
 *
 * 标定依据：同批次 16 张定妆照（v1 纯文生图 8 张 + v2 图生图 8 张）实测，
 * 老模板下四角亮度极差 16.5–80.1（背景带渐变/暗角），抠像会拖出灰边；
 * 因此把"外圈均匀度"升级为**硬闸**：不合格即用加固措辞重跑，重跑仍不合格则该角度判失败。
 */
export const CLEAN_BACKGROUND_POLICY = {
  id: "clean-background/v2",
  /** 外圈条带 YLOW..YHIGH 允许跨度（越小越均匀） */
  bandRangeMax: 30,
  /** 外圈条带平均饱和度上限（中性灰 ≈ 0） */
  bandSatMax: 16,
  /**
   * 四角平均亮度极差上限（防渐变与暗角）。
   * v1 取 22，真机标定发现"图生图 + 加固措辞"下前视全身像的模型地板约 22.4（v2 老模板同类图 33–80），
   * 阈值卡在 22 会把合规产物全部拒掉；v2 定 26：仍能挡住带明显暗角/方向性渐变的旧产物，又留出模型地板余量。
   */
  cornerSpreadMax: 26,
  /** 外圈条带厚度（画面短边百分比） */
  ringRatio: 0.06,
  /**
   * 角度 → 采样模式（2026-09-24 真机修正）：
   *   · **全身像**（front/side/back/actionPose）→ 外圈应当全是背景，判 ring（条带 + 四角）；
   *   · **半身/特写**（threeQuarter/closeup/emotionCloseup/handDetail）→ 主体本来就触碰画面边缘，
   *     外圈条带必然压到身体（真机 threeQuarter 外圈跨度 102 而四角极差仅 9.8、closeup 外圈 78–154），
   *     外圈判定会误杀，因此只判**四角补丁**。
   * 特写仍有价值：四角若是背景，就不该有暗角与方向性渐变。
   */
  angleMode: {
    front: "ring", side: "ring", back: "ring", actionPose: "ring",
    threeQuarter: "corners", closeup: "corners", emotionCloseup: "corners", handDetail: "corners"
  } as Record<string, "ring" | "corners">
} as const;

function bandStats(file: string, filter: string, name: string): BackgroundBand {
  const bin = process.env.WL_FFMPEG ?? "ffmpeg";
  let out = "";
  try {
    out = execFileSync(bin, ["-v", "error", "-i", file, "-vf", `${filter},signalstats,metadata=print:file=-`, "-f", "null", "-"], {
      encoding: "utf8", maxBuffer: 8 * 1024 * 1024
    });
  } catch (err) {
    throw new Error(`背景探针失败（${name}）：${err instanceof Error ? err.message.slice(0, 160) : String(err)}`);
  }
  const get = (key: string): number => Number((out.match(new RegExp(`lavfi\\.signalstats\\.${key}=(-?[\\d.]+)`)) ?? [])[1] ?? NaN);
  return { name, ylow: get("YLOW"), yhigh: get("YHIGH"), yavg: get("YAVG"), satavg: get("SATAVG") };
}

/**
 * 默认探针：外圈四条带（上/下/左/右）+ 四角补丁。
 * 只看**最外圈**——那里在合规定妆照里应当全是背景色；有渐变、暗角或投影会立刻反映为亮度跨度变大。
 */
export function probeCleanBackground(file: string, angle = "front"): BackgroundCheck {
  const r = CLEAN_BACKGROUND_POLICY.ringRatio;
  const mode = CLEAN_BACKGROUND_POLICY.angleMode[angle] ?? "ring";
  const bands: BackgroundBand[] = mode === "ring"
    ? [
        bandStats(file, `crop=iw:ih*${r}:0:0`, "top"),
        bandStats(file, `crop=iw:ih*${r}:0:ih*${1 - r}`, "bottom"),
        bandStats(file, `crop=iw*${r}:ih*0.6:0:ih*0.2`, "left"),
        bandStats(file, `crop=iw*${r}:ih*0.6:iw*${1 - r}:ih*0.2`, "right")
      ]
    : [];
  const corners = [
    bandStats(file, `crop=iw*${r}:ih*${r}:0:0`, "corner-tl"),
    bandStats(file, `crop=iw*${r}:ih*${r}:iw*${1 - r}:0`, "corner-tr"),
    bandStats(file, `crop=iw*${r}:ih*${r}:0:ih*${1 - r}`, "corner-bl"),
    bandStats(file, `crop=iw*${r}:ih*${r}:iw*${1 - r}:ih*${1 - r}`, "corner-br")
  ];
  const ys = corners.map((c) => c.yavg);
  const cornerSpread = Math.max(...ys) - Math.min(...ys);
  const ranges = bands.map((b) => b.yhigh - b.ylow);
  const maxRange = ranges.length > 0 ? Math.max(...ranges) : 0;
  const maxSat = Math.max(...(bands.length > 0 ? bands : corners).map((b) => b.satavg));
  const notes: string[] = [];
  if ([...bands, ...corners].some((band) => ![band.ylow, band.yhigh, band.yavg, band.satavg].every(Number.isFinite))) notes.push("背景探针没有返回完整有限测量值");
  if (mode === "ring" && maxRange > CLEAN_BACKGROUND_POLICY.bandRangeMax) notes.push(`外圈亮度跨度 ${maxRange.toFixed(1)} > ${CLEAN_BACKGROUND_POLICY.bandRangeMax}（背景不均/有渐变或投影）`);
  if (cornerSpread > CLEAN_BACKGROUND_POLICY.cornerSpreadMax) notes.push(`四角亮度极差 ${cornerSpread.toFixed(1)} > ${CLEAN_BACKGROUND_POLICY.cornerSpreadMax}（有暗角或方向性渐变）`);
  if (maxSat > CLEAN_BACKGROUND_POLICY.bandSatMax) notes.push(`外圈饱和度 ${maxSat.toFixed(1)} > ${CLEAN_BACKGROUND_POLICY.bandSatMax}（背景偏色，抠像会带色边）`);
  return { ok: notes.length === 0, policy: CLEAN_BACKGROUND_POLICY.id, mode, bands, cornerSpread, maxRange, maxSat, notes };
}

export interface PortraitPlan {
  characterId: string;
  name: string;
  version: number;
  angles: string[];
  /** 角度 → 正向提示词 */
  prompts: Record<string, string>;
  negativeTerms: string;
  mode: "photoreal" | "stylized";
  reason: string;
  /** 解析后实际可用的锚点照片（绝对路径）；空数组 = 纯文生图 */
  anchors: string[];
  anchorReceipts: PortraitArtifactReceipt[];
  wardrobe: Record<string, unknown>;
  wardrobeHash: string;
  sourceHash: string;
  requestHash: string;
}

/** 角色档案 → 外观描述（写实模板的唯一角色变量） */
function appearanceOf(profile: CharacterProfile, wardrobe: Record<string, unknown>): string {
  const a = (profile.appearance ?? {}) as Record<string, unknown>;
  const i = (profile.identity ?? {}) as Record<string, unknown>;
  /** 性别用中文（档案里可能是 female/male） */
  const genderMap: Record<string, string> = { female: "女性", male: "男性", woman: "女性", man: "男性" };
  const rawGender = String(a.gender ?? i.gender ?? "").trim().toLowerCase();
  const gender = genderMap[rawGender] ?? (rawGender || "人物");
  const age = i.age ? String(i.age) : "";
  const parts = [
    `一位${age ? `${age}` : ""}${gender}`,
    a.face ? String(a.face) : "",
    a.skin ? `肤质：${String(a.skin)}` : "",
    a.eyes ? `眼睛：${String(a.eyes)}` : "",
    a.hair ? `${String(a.hair)}发型` : "",
    wardrobe.name ? `穿着${String(wardrobe.name)}${wardrobe.detail ? `（${String(wardrobe.detail)}）` : ""}` : ""
  ].filter(Boolean);
  return `${parts.join("，")}。`;
}

/**
 * 规划一次定妆照生成（纯函数，可 dry-run）：默认写实；显式声明风格或非人主体才豁免。
 */
export function buildPortraitPlan(
  profile: CharacterProfile,
  config: PortraitAgentConfig = {}
): PortraitPlan {
  assertCharacterComponent(profile.id);
  if (profile.schemaVersion !== "workloom.character-profile/v1" || !profile.name) throw new Error("PORTRAIT_PROFILE_INVALID: 角色档案无效");
  const angles = [...(config.angles ?? REQUIRED_PORTRAIT_ANGLES)];
  if (!angles.length || angles.some((angle) => !Object.hasOwn(ANGLE_FRAMING, angle)) || new Set(angles).size !== angles.length) throw new Error("PORTRAIT_ANGLES_INVALID: 角度为空、未知或重复");
  if (config.version !== undefined && (!Number.isInteger(config.version) || config.version < 1)) throw new Error("PORTRAIT_VERSION_INVALID: 版本必须为正整数");
  if (config.seed !== undefined && (!Number.isSafeInteger(config.seed) || config.seed < 0)) throw new Error("PORTRAIT_SEED_INVALID: seed必须是非负安全整数");
  if (config.maxAnchors !== undefined && (!Number.isInteger(config.maxAnchors) || config.maxAnchors < 1 || config.maxAnchors > 4)) throw new Error("PORTRAIT_ANCHOR_INVALID: 锚点上限必须为1..4");
  const wardrobe = selectPortraitWardrobe(profile, config);
  const declaredStyle = String((profile as unknown as Record<string, unknown>).style ?? "").trim().toLowerCase();
  const nonHuman = ["animal", "creature", "object", "product"].includes(String(profile.subjectType ?? profile.kind));
  if (nonHuman) throw new Error("PORTRAIT_SUBJECT_NOT_APPLICABLE: 非人主体不能套用人物定妆照模板");
  const stylized = (STYLIZED_STYLES as readonly string[]).includes(declaredStyle);
  const mode: PortraitPlan["mode"] = stylized ? "stylized" : "photoreal";
  const reason = nonHuman
    ? `角色类型为 ${profile.kind}（非人），不适用真人写实模板`
    : stylized
      ? `角色档案显式声明风格「${declaredStyle}」`
      : "默认口径（纯写实 + 场景解耦）";
  const appearance = appearanceOf(profile, wardrobe);
  /** Every declared anchor must exist and have current byte evidence; none may disappear silently. */
  const anchors = [...new Set(config.anchorImages ?? [])];
  if (anchors.length > (config.maxAnchors ?? 4)) throw new Error("PORTRAIT_ANCHOR_INVALID: 显式锚点超出上限，不能静默丢弃");
  const anchorReceipts = anchors.map((file) => readPortraitArtifact(file));
  const prompts: Record<string, string> = {};
  for (const angle of angles) {
    const framing = ANGLE_FRAMING[angle] ?? `${angle} 视角`;
    prompts[angle] = mode === "photoreal"
      ? `${PHOTOREAL_TEMPLATE.replace("{appearance}", appearance)}。${framing}。`
      : `${appearance}。${framing}。${declaredStyle ? `风格：${declaredStyle}。` : ""}`;
  }
  const sourceHash = shotIntentHash({ characterId: profile.id, name: profile.name, kind: profile.kind, identity: profile.identity ?? {}, appearance: profile.appearance ?? {}, wardrobe, style: declaredStyle, subjectType: profile.subjectType ?? "person" });
  const wardrobeHash = shotIntentHash(wardrobe);
  const requestHash = shotIntentHash({ schemaVersion: "workloom.portrait-plan/v2", sourceHash, model: config.model ?? null, endpoint: (config.baseUrl ?? "https://ark.cn-beijing.volces.com/api/v3").replace(/\/$/, ""), size: config.size ?? null, seed: config.seed ?? null, angles, prompts, anchors: anchorReceipts, backgroundPolicy: config.requireCleanBackground === false ? "disabled" : CLEAN_BACKGROUND_POLICY, hardenedTemplate: PHOTOREAL_TEMPLATE_HARDENED });
  const existing = (profile.portraitSets ?? []).map((set) => set.version);
  const reusable = [...(profile.portraitSets ?? [])].reverse().find((set) => set.schemaVersion === "workloom.portrait-set/v2" && set.requestHash === requestHash);
  const version = config.version ?? reusable?.version ?? (existing.length > 0 ? Math.max(...existing) + 1 : 1);
  const specified = profile.portraitSets?.find((set) => set.version === version);
  if (specified && specified.requestHash !== requestHash) throw new Error("PORTRAIT_VERSION_CONFLICT: 指定版本属于不同生成来源或旧无收据版本；需新版本候选");
  return {
    characterId: profile.id,
    name: profile.name,
    version,
    angles,
    prompts,
    negativeTerms: mode === "photoreal" ? PHOTOREAL_NEGATIVE : "",
    mode,
    reason: anchors.length > 0
      ? `${reason}；图生图锚定 ${anchors.length} 张授权真人照片`
      : reason,
    anchors, anchorReceipts, wardrobe, wardrobeHash, sourceHash, requestHash
  };
}

export interface PortraitAgentResult {
  characterId: string;
  version: number;
  files: Record<string, string>;
  /** 生成失败的角度（逐角度隔离；不等于整体失败） */
  failures: Array<{ angle: string; error: string }>;
  /** 复用的既有图（幂等：不重复烧额度） */
  reused: string[];
  /** 逐角度背景干净度实测（抠像友好硬闸的留痕） */
  backgroundChecks: Record<string, BackgroundCheck>;
  portraitSet: PortraitSet;
  profileFile: string;
  log: string[];
}

/**
 * 内容安全重试口径（2026-09-24 真机）：
 *   Ark 对"动作姿态/动态张力"这类措辞会命中 `OutputImageSensitiveContentDetected`（动作张力被读成
 *   危险姿态）。原实现一处失败即整体抛错，已出的 5 张全部作废。这里改为：命中安全拦截时用一版
 *   **去动作化**的措辞重试一次；仍失败则该角度记入 `failures` 并继续下一个角度。
 */
const SAFETY_SOFTENED_FRAMING: Record<string, string> = {
  actionPose: "自然生活姿态全身像：站立、重心稳定、双手自然摆放，不作夸张动作",
  back: "背面自然站姿全身像，背对镜头直立，背部与服装细节完整",
  handDetail: "手部自然摆放特写，手指放松，姿态日常"
};

/**
 * 执行生成：逐角度调用 Seedream（有锚点=图生图 / 无锚点=文生图）→ 写入 `portraits/vN`
 * → 追加 `portrait-sets/vN.json` → 更新 `profile.json`（新集置 active，旧集取消 active）。
 *
 * 失败策略（2026-09-24 修订）：
 *   · **逐角度隔离**：单个角度失败不再作废整批（已出图保留并登记）；
 *   · **幂等**：完整请求、背景检查和当前字节收据一致才复用；
 *   · 半套作为未激活候选保存，四个必需角度完整才允许激活。
 */
export async function runPortraitAgent(options: {
  libraryRoot: string;
  characterId: string;
  apiKey: string;
  baseUrl?: string;
  model: string;
  fetchImpl?: typeof fetch;
  config?: PortraitAgentConfig;
  log?: (line: string) => void;
}): Promise<PortraitAgentResult> {
  assertCharacterComponent(options.characterId);
  if (!options.apiKey?.trim() || !options.model?.trim()) throw new Error("PORTRAIT_CONFIG_INVALID: 缺模型或接口凭据");
  const dir = resolvePath(options.libraryRoot, options.characterId);
  if (lstatSync(dir).isSymbolicLink()) throw new Error("CHARACTER_PATH_INVALID: 角色目录不能是symlink");
  const root = realpathSync(options.libraryRoot);
  const relativeDir = relative(root, realpathSync(dir));
  if (relativeDir === ".." || relativeDir.startsWith(`..${sep}`) || isAbsolute(relativeDir)) throw new Error("CHARACTER_PATH_INVALID: 角色目录越界");
  const profileFile = join(dir, "profile.json");
  return withCharacterArchiveLock(dir, async () => {
    if (!loadCharacterEntry(dir)) throw new Error(`角色档案不存在：${profileFile}`);
    const profile = JSON.parse(readFileSync(profileFile, "utf8")) as CharacterProfile;
    if (profile.id !== options.characterId) throw new Error("PORTRAIT_PROFILE_INVALID: 路径角色与档案ID不一致");
    const logs: string[] = [];
    const say = (line: string): void => { logs.push(line); options.log?.(line); };
    const fetchImpl = options.fetchImpl ?? fetch;
    const base = (options.baseUrl ?? options.config?.baseUrl ?? "https://ark.cn-beijing.volces.com/api/v3").replace(/\/$/, "");
    const config: PortraitAgentConfig = {
      ...options.config, model: options.model, baseUrl: base,
      anchorImages: (options.config?.anchorImages ?? []).map((file) => isAbsolute(file) ? file : resolvePath(dir, file))
    };
    let plan = buildPortraitPlan(profile, config);
    let prior = profile.portraitSets.find((set) => set.version === plan.version);
    const occupied = () => existsSync(join(dir, "portraits", `v${plan.version}`)) && !prior;
    const changedReady = prior?.status === "ready" && verifyPortraitSet(dir, profile, prior).verification.status !== "passed";
    if (occupied() || changedReady) {
      if (config.version !== undefined) throw new Error("PORTRAIT_VERSION_OCCUPIED: 指定版本已有未知或改写的文件；需新候选版本");
      const dirs = existsSync(join(dir, "portraits")) ? readdirSync(join(dir, "portraits")).map((name) => /^v(\d+)$/.exec(name)?.[1]).filter(Boolean).map(Number) : [];
      plan = buildPortraitPlan(profile, { ...config, version: Math.max(plan.version, ...dirs, ...profile.portraitSets.map((set) => set.version)) + 1 });
      prior = undefined;
    }
    const ensure = (relativePath: string): string => {
      let current = dir;
      for (const part of relativePath.split("/")) {
        current = join(current, part);
        if (!existsSync(current)) mkdirSync(current);
        if (lstatSync(current).isSymbolicLink() || realpathSync(current) !== join(realpathSync(dir), relative(dir, current))) throw new Error("PORTRAIT_PATH_INVALID: 输出目录不能是symlink");
      }
      return current;
    };
    const setDir = ensure(`portraits/v${plan.version}`); const metadataDir = ensure("portrait-sets");
    const files: Record<string, string> = {}; const artifacts: Record<string, PortraitArtifactReceipt> = {};
    const angleRequests: Record<string, string> = {};
    const failures: Array<{ angle: string; error: string }> = []; const reused: string[] = [];
    const backgroundChecks: Record<string, BackgroundCheck> = {};
    const requireCleanBackground = config.requireCleanBackground !== false;
    const anchors = plan.anchors.map((file, index) => {
      const receipt = readPortraitArtifact(file);
      if (shotIntentHash(receipt) !== shotIntentHash(plan.anchorReceipts[index])) throw new Error("PORTRAIT_INPUT_CHANGED: 锚点已变化");
      const ext = file.toLowerCase().endsWith(".png") ? "png" : file.toLowerCase().endsWith(".webp") ? "webp" : "jpeg";
      const bytes = readFileSync(file);
      if (createHash("sha256").update(bytes).digest("hex") !== receipt.sha256) throw new Error("PORTRAIT_INPUT_CHANGED: 锚点发送字节与规划收据不一致");
      return `data:image/${ext};base64,${bytes.toString("base64")}`;
    });
    let expectedProfileHash = shotIntentHash(profile);
    let portraitSet: PortraitSet;
    const assertInputs = (): void => {
      if (lstatSync(profileFile).isSymbolicLink() || shotIntentHash(JSON.parse(readFileSync(profileFile, "utf8"))) !== expectedProfileHash) throw new Error("PORTRAIT_INPUT_CHANGED: 生成期间角色档案变化，不能覆盖外部更新");
      for (const receipt of plan.anchorReceipts) if (shotIntentHash(readPortraitArtifact(receipt.path)) !== shotIntentHash(receipt)) throw new Error("PORTRAIT_INPUT_CHANGED: 生成期间锚点变化");
    };
    const persist = (complete: boolean): void => {
      assertInputs();
      portraitSet = {
        schemaVersion: "workloom.portrait-set/v2", version: plan.version, dir: `portraits/v${plan.version}`,
        angles: Object.keys(files), files: Object.fromEntries(Object.entries(files).map(([angle, file]) => [angle, relative(dir, file)])), artifacts: { ...artifacts }, angleRequests: { ...angleRequests },
        source: anchors.length ? "img2img" : "pure-t2i", anchors: plan.anchors.map((file) => relative(dir, file)),
        sourceHash: plan.sourceHash, requestHash: plan.requestHash, wardrobe: plan.wardrobe, wardrobeHash: plan.wardrobeHash,
        status: complete ? "ready" : failures.length && !Object.keys(files).length ? "failed" : "candidate",
        active: complete && config.activate !== false, model: options.model, ...(config.seed !== undefined ? { seed: config.seed } : {}),
        // JSON null denotes a missing measurement; retaining NaN in the in-memory hash would
        // differ from the exact persisted JSON bytes and hide the original probe failure.
        prompt: plan.prompts.front ?? plan.prompts[plan.angles[0]!], failedAngles: [...failures], backgroundChecks: JSON.parse(JSON.stringify(backgroundChecks)) as PortraitSet["backgroundChecks"], backgroundRequired: requireCleanBackground,
        createdAt: prior?.createdAt ?? new Date().toISOString()
      };
      if (complete && verifyPortraitSet(dir, profile, portraitSet).verification.status !== "passed") throw new Error("PORTRAIT_ACTIVATION_UNVERIFIED: 当前候选产物未通过完整核验");
      const current = JSON.parse(readFileSync(profileFile, "utf8")) as CharacterProfile;
      const sets = current.portraitSets.filter((set) => set.version !== plan.version).map((set) => portraitSet.active ? { ...set, active: false } : set);
      // A ready version already active remains active on an identical no-activate cache read.
      if (complete && prior?.active && config.activate === false) portraitSet.active = true;
      sets.push(portraitSet);
      const updated = { ...current, portraitSets: sets, portraitAgent: { model: options.model, sourceHash: plan.sourceHash, requestHash: plan.requestHash, status: portraitSet.status, version: plan.version, failures: [...failures], reused: [...reused], backgroundPolicy: requireCleanBackground ? CLEAN_BACKGROUND_POLICY.id : "disabled", updatedAt: new Date().toISOString() }, updatedAt: new Date().toISOString() };
      writePortraitJson(join(metadataDir, `v${plan.version}.json`), portraitSet);
      writePortraitJson(profileFile, updated); expectedProfileHash = shotIntentHash(updated);
    };
    const checkBackground = (file: string, angle: string): BackgroundCheck => {
      let check: BackgroundCheck;
      try {
        check = config.backgroundProber ? config.backgroundProber(file) : probeCleanBackground(file, angle);
        if (![check.cornerSpread, check.maxRange, check.maxSat].every(Number.isFinite)) check = { ...check, ok: false, notes: [...(check.notes ?? []), "背景探针缺少有限数值"] };
      } catch (error) {
        check = { ok: false, policy: CLEAN_BACKGROUND_POLICY.id, mode: CLEAN_BACKGROUND_POLICY.angleMode[angle] ?? "ring", bands: [], cornerSpread: Number.NaN, maxRange: Number.NaN, maxSat: Number.NaN, notes: [`背景探针不可用：${error instanceof Error ? error.message : String(error)}`] };
      }
      backgroundChecks[angle] = check; return check;
    };
    const bodyOf = (prompt: string): Record<string, unknown> => ({ model: options.model, prompt, response_format: "url", watermark: false,
      ...(anchors.length ? { image: anchors.length === 1 ? anchors[0] : anchors } : {}), ...(config.size ? { size: config.size } : {}), ...(config.seed !== undefined ? { seed: config.seed } : {}) });
    say(`[portrait-agent] ${profile.name} v${plan.version}：${plan.mode}，服装来源 ${plan.wardrobeHash.slice(0, 12)}，角度 ${plan.angles.join("/")}`);
    // Reserve a candidate before external calls. Failed or partial sets never replace the active version.
    if (!prior) persist(false);
    for (const angle of plan.angles) {
      const file = join(setDir, `${profile.id}-${angle}.png`);
      const basePrompt = plan.prompts[angle]!; const softened = SAFETY_SOFTENED_FRAMING[angle];
      const hardened = `${basePrompt}。${PHOTOREAL_TEMPLATE_HARDENED}`;
      const attempts = [basePrompt, ...(softened ? [`${basePrompt}。${softened}`] : []), ...(requireCleanBackground ? [hardened, ...(softened ? [`${hardened}。${softened}`] : [])] : [])];
      const allowedRequests = attempts.map((prompt) => shotIntentHash({ endpoint: `${base}/images/generations`, payload: bodyOf(prompt) }));
      if (prior?.requestHash === plan.requestHash && prior.files?.[angle]) {
        try {
          const priorFile = resolvePath(dir, prior.files[angle]!); const actual = readPortraitArtifact(priorFile, dir);
          const priorBackground = prior.backgroundChecks?.[angle] as BackgroundCheck | undefined;
          const validBackground = !requireCleanBackground || Boolean(priorBackground?.ok && [priorBackground.cornerSpread, priorBackground.maxRange, priorBackground.maxSat].every(Number.isFinite));
          if (shotIntentHash(actual) === shotIntentHash(prior.artifacts?.[angle] ?? null) && allowedRequests.includes(prior.angleRequests?.[angle] ?? "") && validBackground) {
            if (priorBackground) backgroundChecks[angle] = structuredClone(priorBackground);
            files[angle] = priorFile; artifacts[angle] = actual; angleRequests[angle] = prior.angleRequests![angle]!; reused.push(angle); continue;
          }
        } catch (error) { say(`  · ${angle} 旧候选不可复用：${error instanceof Error ? error.message : String(error)}`); }
      }
      let lastError = "";
      for (const [attempt, prompt] of attempts.entries()) {
        try {
          assertInputs();
          const response = await fetchImpl(`${base}/images/generations`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${options.apiKey}` }, body: JSON.stringify(bodyOf(prompt)), signal: AbortSignal.timeout(240_000) });
          const text = await response.text();
          if (!response.ok) throw new Error(`HTTP ${response.status} ${text.slice(0, 200)}`);
          const url = (JSON.parse(text) as { data?: Array<{ url?: string }> }).data?.[0]?.url;
          if (!url) throw new Error("响应缺少url，不能自动重复已成功的生成请求");
          const download = await fetchImpl(url, { signal: AbortSignal.timeout(120_000) });
          if (!download.ok) throw new Error(`定妆照下载 HTTP ${download.status}`);
          const bytes = Buffer.from(await download.arrayBuffer());
          if (bytes.length < 1024 || bytes.length > 100_000_000) throw new Error("PORTRAIT_DOWNLOAD_INVALID: 图片大小无效");
          assertInputs();
          const temporary = join(setDir, `.portrait-${randomUUID()}.tmp`);
          try { writeFileSync(temporary, bytes, { flag: "wx", mode: 0o600 }); if (lstatSync(setDir).isSymbolicLink()) throw new Error("PORTRAIT_PATH_INVALID: 输出目录发生变化"); renameSync(temporary, file); }
          finally { if (existsSync(temporary)) unlinkSync(temporary); }
          if (requireCleanBackground && !checkBackground(file, angle).ok) { lastError = `background_not_clean：${backgroundChecks[angle]!.notes.join("；")}`; continue; }
          files[angle] = file; artifacts[angle] = readPortraitArtifact(file, dir); angleRequests[angle] = allowedRequests[attempt]!;
          say(`  · ${angle} 当前请求与产物收据已绑定`); break;
        } catch (error) {
          lastError = error instanceof Error ? error.message : String(error);
          say(`  · ${angle} 失败：${lastError.slice(0, 160)}`);
          if (!/SensitiveContent|Sensitive/i.test(lastError)) break;
        }
      }
      if (!files[angle]) failures.push({ angle, error: lastError || "未得到可核验产物" });
      persist(false);
    }
    const complete = failures.length === 0 && REQUIRED_PORTRAIT_ANGLES.every((angle) => Boolean(files[angle]));
    persist(complete);
    if (!Object.keys(files).length) throw new Error(`定妆照全部失败（${failures.map((item) => `${item.angle}:${item.error}`).join("；")}）`);
    say(`[portrait-agent] 完成：v${plan.version} ${portraitSet!.status}${portraitSet!.active ? "（已激活）" : "（未激活，原active保留）"}`);
    return { characterId: profile.id, version: plan.version, files, failures, reused, backgroundChecks, portraitSet: portraitSet!, profileFile, log: logs };
  });
}
