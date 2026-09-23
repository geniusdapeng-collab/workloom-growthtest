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
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, relative, resolve as resolvePath } from "node:path";
import { execFileSync } from "node:child_process";
import { REQUIRED_PORTRAIT_ANGLES, type CharacterProfile, type PortraitSet } from "./character-archive.js";
import { REALISM_NEGATIVE_TERMS, STYLIZED_STYLES } from "./shot-spec.js";

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
}

/** 角色档案 → 外观描述（写实模板的唯一角色变量） */
function appearanceOf(profile: CharacterProfile): string {
  const a = (profile.appearance ?? {}) as Record<string, unknown>;
  const i = (profile.identity ?? {}) as Record<string, unknown>;
  const wardrobe = Array.isArray(profile.wardrobe) && profile.wardrobe.length > 0
    ? (profile.wardrobe[0] as Record<string, unknown>)
    : {};
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
  const angles = config.angles ?? [...REQUIRED_PORTRAIT_ANGLES];
  const existing = (profile.portraitSets ?? []).map((s) => s.version);
  const version = config.version ?? (existing.length > 0 ? Math.max(...existing) + 1 : 1);
  const declaredStyle = String((profile as unknown as Record<string, unknown>).style ?? "").trim().toLowerCase();
  const nonHuman = ["animal", "creature", "object", "product"].includes(String(profile.kind));
  const stylized = (STYLIZED_STYLES as readonly string[]).includes(declaredStyle) || nonHuman;
  const mode: PortraitPlan["mode"] = stylized ? "stylized" : "photoreal";
  const reason = nonHuman
    ? `角色类型为 ${profile.kind}（非人），不适用真人写实模板`
    : stylized
      ? `角色档案显式声明风格「${declaredStyle}」`
      : "默认口径（纯写实 + 场景解耦）";
  const appearance = appearanceOf(profile);
  /**
   * 锚点解析（2026-09-24）：不存在的文件静默剔除（不阻断），但**一个都不剩**时要如实降级为纯文生图，
   * 由调用方（CLI/监制）在日志里看到 `source=pure-t2i`，而不是以为挂上了真人锚点。
   */
  const anchors = (config.anchorImages ?? []).filter((file) => {
    try {
      return existsSync(file) && statSync(file).size > 1024;
    } catch {
      return false;
    }
  }).slice(0, Math.max(1, config.maxAnchors ?? 4));
  const prompts: Record<string, string> = {};
  for (const angle of angles) {
    const framing = ANGLE_FRAMING[angle] ?? `${angle} 视角`;
    prompts[angle] = mode === "photoreal"
      ? `${PHOTOREAL_TEMPLATE.replace("{appearance}", appearance)}。${framing}。`
      : `${appearance}。${framing}。${declaredStyle ? `风格：${declaredStyle}。` : ""}`;
  }
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
    anchors
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
 *   · **幂等**：目标文件已存在且非空即复用，不重复烧额度；
 *   · 只有**一个角度都没成功**时才抛错（不写半套档案）。
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
  const log = options.log ?? (() => undefined);
  const logs: string[] = [];
  const say = (line: string): void => { logs.push(line); log(line); };
  const fetchImpl = options.fetchImpl ?? fetch;
  const base = (options.baseUrl ?? "https://ark.cn-beijing.volces.com/api/v3").replace(/\/$/, "");
  const dir = join(options.libraryRoot, options.characterId);
  const profileFile = join(dir, "profile.json");
  if (!existsSync(profileFile)) throw new Error(`角色档案不存在：${profileFile}`);
  const profile = JSON.parse(readFileSync(profileFile, "utf8")) as CharacterProfile;
  const plan = buildPortraitPlan(profile, { ...options.config, model: options.model });
  say(`[portrait-agent] ${profile.name} v${plan.version}：${plan.mode}（${plan.reason}），角度 ${plan.angles.join("/")}`);

  const setDir = join(dir, "portraits", `v${plan.version}`);
  mkdirSync(setDir, { recursive: true });
  const files: Record<string, string> = {};
  const failures: Array<{ angle: string; error: string }> = [];
  const reused: string[] = [];
  const backgroundChecks: Record<string, BackgroundCheck> = {};
  /**
   * 背景干净度硬闸：默认开启（产品所有者 2026-09-24 口径）。
   * 探针不可用（例如没装 ffmpeg）时**不静默放行**：记为失败并说明，避免"看着像过了"。
   */
  const requireCleanBackground = options.config?.requireCleanBackground !== false;
  /** 注入的替身探针（单测用）优先；生产走自带实现，并按角度选择 ring / corners 采样 */
  const injectedProber = options.config?.backgroundProber;
  const checkBackground = (file: string, angle: string): BackgroundCheck => {
    try {
      const check = injectedProber ? injectedProber(file) : probeCleanBackground(file, angle);
      backgroundChecks[angle] = check;
      if (!check.ok) say(`  · ${angle} 背景干净度不合格：${check.notes.join("；")}`);
      else say(`  · ${angle} 背景干净度合格（外圈跨度 ${check.maxRange.toFixed(1)} · 四角极差 ${check.cornerSpread.toFixed(1)} · 饱和 ${check.maxSat.toFixed(1)}）`);
      return check;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const failed: BackgroundCheck = {
        ok: false, policy: CLEAN_BACKGROUND_POLICY.id, bands: [], cornerSpread: Number.NaN, maxRange: Number.NaN, maxSat: Number.NaN,
        notes: [`背景探针不可用：${message.slice(0, 160)}（按不合格处理，不静默放行）`]
      };
      backgroundChecks[angle] = failed;
      say(`  · ${angle} ${failed.notes[0]}`);
      return failed;
    }
  };
  /** 锚点 → base64 data URL（Ark 接受；本地文件不出网，只有 base64 进请求体） */
  const anchorPayloads = plan.anchors.map((file) => {
    const ext = file.toLowerCase().endsWith(".png") ? "png" : file.toLowerCase().endsWith(".webp") ? "webp" : "jpeg";
    return `data:image/${ext};base64,${readFileSync(file).toString("base64")}`;
  });
  const anchorRel = plan.anchors.map((file) => relative(dir, file));
  for (const angle of plan.angles) {
    const file = join(setDir, `${profile.name}-${angle}.png`);
    /**
     * ① 幂等复用：同角度文件已存在且非空 → 复用（不重复烧额度）。
     * **但复用也要过硬闸**：历史图可能是老模板产出的脏背景图，直接复用等于把不合格资产放进档案。
     */
    if (existsSync(file) && statSync(file).size > 1024) {
      const reusable = requireCleanBackground ? checkBackground(file, angle).ok : true;
      if (reusable) {
        files[angle] = file;
        reused.push(angle);
        say(`  · ${angle} → 复用既有产物（${statSync(file).size} B）`);
        continue;
      }
      say(`  · ${angle} 既有产物背景不合格，改为重新生成（不复用脏背景图）`);
    }
    const buildBody = (prompt: string): Record<string, unknown> => ({
      model: options.model,
      prompt,
      response_format: "url",
      watermark: false,
      ...(anchorPayloads.length > 0
        ? { image: anchorPayloads.length === 1 ? anchorPayloads[0] : anchorPayloads }
        : {}),
      ...(options.config?.size ? { size: options.config.size } : {}),
      ...(options.config?.seed ? { seed: options.config.seed } : {})
    });
    /** ② 逐角度出图（安全拦截 → 去动作化重试一次；仍失败只记该角度） */
    const softened = SAFETY_SOFTENED_FRAMING[angle];
    /**
     * 尝试序列（按需组合，最多 4 次）：
     *   ① 常规提示词（已含背景硬约束）
     *   ② 动作类角度命中内容安全 → 追加去动作化措辞
     *   ③ 背景干净度不合格 → 追加加固措辞
     *   ④ 两者叠加
     */
    const basePrompt = plan.prompts[angle]!;
    const bgHardened = `${basePrompt}。${PHOTOREAL_TEMPLATE_HARDENED}`;
    const softenedPrompt = softened ? `${basePrompt}。${softened}` : null;
    const attempts: string[] = [basePrompt];
    if (softenedPrompt) attempts.push(softenedPrompt);
    if (requireCleanBackground) attempts.push(bgHardened);
    if (softenedPrompt) attempts.push(`${bgHardened}。${softened}`);
    let ok = false;
    let lastError = "";
    for (const [index, prompt] of attempts.entries()) {
      try {
        const res = await fetchImpl(`${base}/images/generations`, {
          method: "POST",
          headers: { "content-type": "application/json", authorization: `Bearer ${options.apiKey}` },
          body: JSON.stringify(buildBody(prompt))
        });
        const text = await res.text();
        if (!res.ok) throw new Error(`HTTP ${res.status} ${text.slice(0, 200)}`);
        const parsed = JSON.parse(text) as { data?: Array<{ url?: string }> };
        const url = parsed.data?.[0]?.url;
        if (!url) throw new Error("响应缺少 url");
        const bytes = Buffer.from(await (await fetchImpl(url)).arrayBuffer());
        writeFileSync(file, bytes);
        say(`  · ${angle} → ${file}（${bytes.byteLength} B${index > 0 ? ` · 第 ${index + 1} 次尝试` : ""}）`);
        /**
         * 背景干净度硬闸（产品所有者口径）：不合格**不算产出**，用加固措辞重跑；
         * 最后一次仍不合格 → 该角度判失败并把原因写进档案（下游据此知道"这张不能拿来抠像"）。
         */
        if (requireCleanBackground) {
          const check = checkBackground(file, angle);
          if (!check.ok) {
            lastError = `background_not_clean：${check.notes.join("；")}`;
            if (index < attempts.length - 1) {
              say(`  · ${angle} 背景不合格 → 用加固措辞重跑（还剩 ${attempts.length - index - 1} 次机会）`);
              continue;
            }
            failures.push({ angle, error: lastError });
            break;
          }
        }
        files[angle] = file;
        ok = true;
        break;
      } catch (err) {
        lastError = err instanceof Error ? err.message : String(err);
        const isSafety = /SensitiveContent|Sensitive/i.test(lastError);
        say(`  · ${angle} 第 ${index + 1} 次失败：${lastError.slice(0, 160)}${isSafety && index + 1 < attempts.length ? "（命中内容安全，改用语软化措辞重试）" : ""}`);
      }
    }
    if (!ok && !failures.some((f) => f.angle === angle)) failures.push({ angle, error: lastError });
  }
  if (Object.keys(files).length === 0) {
    throw new Error(`定妆照全军覆没（${failures.map((f) => `${f.angle}:${f.error.slice(0, 80)}`).join("；")}）`);
  }

  const portraitSet: PortraitSet = {
    version: plan.version,
    dir: `portraits/v${plan.version}`,
    angles: Object.keys(files),
    source: anchorPayloads.length > 0 ? "img2img" : "pure-t2i",
    ...(anchorRel.length > 0 ? { anchors: anchorRel } : {}),
    active: options.config?.activate !== false,
    model: options.model,
    ...(options.config?.seed ? { seed: options.config.seed } : {}),
    prompt: plan.prompts[Object.keys(files)[0] ?? "front"],
    ...(failures.length > 0 ? { failedAngles: failures } : {}),
    /** 逐角度背景测量留痕（阈值口径 + 实测值），供下游判断"这张能不能直接抠像" */
    ...(Object.keys(backgroundChecks).length > 0 ? { backgroundChecks } : {}),
    createdAt: new Date().toISOString()
  };
  mkdirSync(join(dir, "portrait-sets"), { recursive: true });
  writeFileSync(join(dir, "portrait-sets", `v${plan.version}.json`), `${JSON.stringify(portraitSet, null, 2)}\n`);

  /**
   * 版本台账按 version **upsert**（2026-09-24 真机修复）：
   * 同版本重跑（补角度/修背景）此前会再 push 一条同 version 的记录，
   * 于是 `portraitSets` 里出现两条 v3，`find(version===3)` 取到的是**旧那条**——
   * 评审与下游就会看到"实际只有 side/actionPose"的过期结论。
   */
  const sets = [...(profile.portraitSets ?? [])].filter((set) => set.version !== portraitSet.version);
  if (portraitSet.active) for (const set of sets) set.active = false;
  sets.push(portraitSet);
  const updated: CharacterProfile = {
    ...profile,
    portraitSets: sets,
    portraitAgent: {
      model: options.model,
      angles: Object.keys(files),
      ...(failures.length > 0 ? { failures } : {}),
      ...(reused.length > 0 ? { reused } : {}),
      backgroundPolicy: requireCleanBackground ? CLEAN_BACKGROUND_POLICY.id : "disabled",
      mode: plan.mode,
      negativeTerms: plan.negativeTerms,
      updatedAt: new Date().toISOString()
    },
    updatedAt: new Date().toISOString()
  } as CharacterProfile;
  writeFileSync(profileFile, `${JSON.stringify(updated, null, 2)}\n`);
  say(`[portrait-agent] 完成：v${plan.version}${portraitSet.active ? "（已置为 active）" : ""}；档案已更新`);
  if (failures.length > 0) say(`[portrait-agent] 失败角度（已登记，不阻断交付）：${failures.map((f) => f.angle).join("、")}`);
  return { characterId: profile.id, version: plan.version, files, failures, reused, backgroundChecks, portraitSet, profileFile, log: logs };
}
