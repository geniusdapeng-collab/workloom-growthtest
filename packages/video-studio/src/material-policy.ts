import type { QualityStatus } from "./quality-evidence.js";

/**
 * material-policy —— 真实素材（实拍照片/视频）的**用途硬约束**（2026-09-25 产品所有者规定）。
 *
 * 产品口径（原话）：**严禁在视频中直接静态展示图片**；找真实图片的目的是"以真实环境为参考生成视频"，
 * 素材是**渲染素材**，不是成片内容。所以：
 *   · 素材只能以 `usage: "generation-reference"` 进入管线，作为生成模型的首帧/参考输入；
 *   · 任何"把素材裁一裁、推拉一下就当镜头用"的静态直出（timeline 上的照片段）一律非法；
 *   · 素材镜头在时间线上必须能证明"画面由生成模型产出"（渲染任务号 + 生成产物指纹），
 *     并有确定性判据兜底（后段画面与素材的"复用度"过高即判静态直出）。
 *
 * 为什么用**模块 + 单测**而不是脚本里的一句 if：
 * 2026-09-24 的 `photo-motion` 事故就是"把静态图直接当镜头"的实现被写进了脚本，评审口径也随之放宽
 * （当时的评审 rubric 甚至写着"这是真实照片做的动态段，不要以缺少 AI 细节为由打回"）——
 * 规则必须在**能被断言的地方**（本模块 + 管线硬闸 + 围栏文件）落地，脚本只做编排。
 */

/** 素材用途策略版本（写进阶段日志与提示词，便于审计回溯口径） */
export const MATERIAL_POLICY_VERSION = "material-usage/v1";

/**
 * 场景构建策略版本（2026-09-25 产品所有者第三次口径纠偏）：
 * "你不是把图片简单变成动图增加一点变化，你是要从一开始就做的是视频，图片只是实景素材参考，
 *  是用来构建真实视频场景的，不是简单做个运镜了事，我们做的是视频。"
 *
 * 因此素材镜的**唯一合法产物形态**是"以参考素材为依据构建出来的真实视频场景"：
 *   · 参考图作 `reference_image`（**不再作 first_frame**）——首帧就不该是那张照片；
 *   · 机位/焦段/取景由模型自行构建（可换机位、可换高度角度），根据镜头意图选择固定机位或真实位移；
 *   · 画面位移镜头必须有真实三维视差；主体与环境变化遵循场景（云/水/光/人群/车流/植被）；
 *   · 参考图没拍到的画面边缘要合理补全，不得出现参考图边界/黑边/复刻构图。
 */
export const MATERIAL_SCENE_POLICY_VERSION = "material-scene/v1";

/** 场景构建策略原文（提示词、错误信息、文档共用） */
export const MATERIAL_SCENE_POLICY_STATEMENT = [
  "参考素材只作实景依据：用它确认地标形制、结构层次、文字标识、环境关系、材质与天色；",
  "成片必须是**构建出来的视频场景**：机位、焦段、取景、镜头运动由模型自行构建，根据镜头意图选择固定机位或真实位移；",
  "位移镜头必须有真实三维视差；主体与环境变化遵循场景（前景/中景/远景相对位移；云、水、光、人群、车流、植被随时间变化）；",
  "不得复刻参考图构图：首帧不是参考图（不出现参考图边界、黑边或「同一张图」的取景）；",
  "镜头运动不是遮羞布：固定机位本身不是错误，帧差只用于筛查，真实感须结合时序画面评审。"
].join("");

/** 给人与给模型看的政策原文（提示词、文档、错误信息共用一处，避免口径漂移） */
export const MATERIAL_POLICY_STATEMENT = [
  "真实素材只作生成输入：实拍照片/视频必须作为生成模型的首帧或参考输入（渲染素材），由模型产出带真实运动的镜头；",
  "禁止静态直出：素材本身（含裁切、缩放、推拉摇移等任何「仍是一张图」的加工）不得作为成片镜头段；",
  "禁止贴图式动效：不得用整幅画面平移/缩放/滤镜包装伪造「拍摄感」；",
  "生成仍须保真：生成结果必须保持素材中的真实地标、建筑形制与文字标识不被改造或臆造；",
  "不回归成片：素材用途声明、生成任务号与产物指纹必须写进阶段日志（无回执不算完成）。"
].join("");

/** 允许的素材用途（当前只有一种合法用法：当生成输入） */
export type MaterialUsage = "generation-reference";

/** 唯一的合法用途取值 */
export const REQUIRED_MATERIAL_USAGE: MaterialUsage = "generation-reference";

/** 显式非法用途（写进错误信息，便于调用方自查） */
export const FORBIDDEN_MATERIAL_USAGES = ["direct-display", "static-display", "slideshow", "b-roll-photo"] as const;

export class MaterialPolicyError extends Error {
  readonly code: string;
  constructor(message: string, code = "material_policy_violation") {
    super(message);
    this.name = "MaterialPolicyError";
    this.code = code;
  }
}

export interface MaterialSpec {
  /** 素材文件绝对路径（实拍照片） */
  photo: string;
  /** 用途声明：必须显式写 `generation-reference`（默认值不成立——默认值会让规则形同虚设） */
  usage: MaterialUsage;
  /** 素材描述（内容与来源），进生成提示词的保真约束 */
  description?: string;
  /** 生成时的镜头运动意图（镜头语言，不是硬参数） */
  motion?: string;
  /** 素材聚焦点（0–1）：决定裁到目标画幅时保留哪一块（只影响生成输入，不影响"成片内容"） */
  focus?: { x?: number; y?: number };
}

/**
 * 读取并校验镜头卡的素材声明。
 *
 * 兼容旧卡但**不放行**：旧卡只写 `photo`（没有用途声明）时抛错，错误信息直接给出改法与规则原文——
 * 这是刻意的破坏性变更：旧写法正是"素材被当镜头用"的入口，静默兼容等于规则失效。
 */
export function readMaterialSpec(shot: Record<string, unknown>): MaterialSpec {
  const rawPhoto = String(shot.photo ?? "").trim();
  if (!rawPhoto) {
    throw new MaterialPolicyError(`镜头 ${String(shot.shotId ?? "?")} 未声明素材（shot.photo 为空）`, "material_missing");
  }
  const rawUsage = shot.materialUsage ?? shot.material_usage ?? shot.usage;
  const usage = typeof rawUsage === "string" ? rawUsage.trim() : "";
  if (!usage) {
    throw new MaterialPolicyError(
      `镜头 ${String(shot.shotId ?? "?")} 的素材缺用途声明：必须在镜头卡里显式写 "materialUsage": "${REQUIRED_MATERIAL_USAGE}"`
        + "（素材只作生成输入；缺声明即视为把素材当镜头用，管线拒绝执行）。规则：" + MATERIAL_POLICY_STATEMENT,
      "material_usage_undeclared"
    );
  }
  if (usage !== REQUIRED_MATERIAL_USAGE) {
    const forbidden = (FORBIDDEN_MATERIAL_USAGES as readonly string[]).includes(usage);
    throw new MaterialPolicyError(
      `镜头 ${String(shot.shotId ?? "?")} 的素材用途 "${usage}" 不合法`
        + (forbidden ? "（静态直出/展示用途已被产品口径禁止）" : "")
        + `：只允许 "${REQUIRED_MATERIAL_USAGE}"。规则：` + MATERIAL_POLICY_STATEMENT,
      forbidden ? "material_static_display_forbidden" : "material_usage_invalid"
    );
  }
  const motion = typeof shot.motion === "string" && shot.motion.trim() ? shot.motion.trim() : undefined;
  const description = typeof shot.materialDescription === "string" && shot.materialDescription.trim()
    ? shot.materialDescription.trim()
    : typeof shot.scene === "string" && shot.scene.trim()
      ? shot.scene.trim()
      : undefined;
  const focusRaw = (shot.focus ?? undefined) as { x?: unknown; y?: unknown } | undefined;
  const clamp01 = (value: unknown): number | undefined => {
    const num = Number(value);
    return Number.isFinite(num) ? Math.min(1, Math.max(0, num)) : undefined;
  };
  const focus = focusRaw
    ? { x: clamp01(focusRaw.x) ?? 0.5, y: clamp01(focusRaw.y) ?? 0.5 }
    : undefined;
  return { photo: rawPhoto, usage: REQUIRED_MATERIAL_USAGE, motion, description, focus };
}

/** 镜头卡是否是"素材镜"（判据只看 `photo`：有素材就必须走生成，没有静态路径） */
export function isMaterialShot(shot: Record<string, unknown>): boolean {
  return String(shot.photo ?? "").trim().length > 0;
}

export interface MaterialMotionPromptOptions {
  characterName?: string;
  aspect?: string;
  resolution?: string;
  durationSec?: number;
  title?: string;
  /** 摄影知识库/连贯性环节注入的画面语言（原样并入，不改写） */
  injection?: string;
  /**
   * 运动强度档位（2026-09-25 产品所有者第二轮反馈后新增）：
   * 上一版提示词只写"运动幅度以明显可辨为准"，模型选了最保守的微动 → 成片"看着像图片"。
   * 现在按 `motionStrength` 追加**量化运动要求**（`assertive` 用于重跑升级）。
   */
  motionStrength?: "standard" | "assertive";
}

/**
 * 素材镜的**生成提示词**（Seedance i2v）。
 *
 * 与 `plate-prompt`（文生关键帧）不同，这里首帧已经是真实素材，提示词要解决的是三件事：
 *   ① 保真：地标形制、文字标识、环境关系不得被改造（模型很容易"顺手美化"建筑）；
 *   ② 出真运动：云/水/光/人群/植被/车流 + 镜头运动，而不是整幅图平移；
 *   ③ 自证不是静态直出：明确禁止"画面静止/整幅不变/贴图平移"。
 */
export function buildMaterialMotionPrompt(shot: Record<string, unknown>, options: MaterialMotionPromptOptions = {}): string {
  const spec = readMaterialSpec(shot);
  const aspect = options.aspect ?? "9:16";
  const resolution = options.resolution ?? "1080p";
  const duration = Number(options.durationSec ?? shot.duration ?? 5);
  const scene = String(shot.scene ?? spec.description ?? "").trim();
  const sceneDescription = String(shot.sceneDescription ?? "").trim();
  const lighting = String(shot.lighting ?? "").trim();
  const motionIntent = spec.motion ?? String(shot.camera_movement ?? "").trim();
  const colorPalette = String(shot.color_palette ?? "").trim();
  const props = String(shot.props ?? "").trim();
  const negative = String(shot.negative ?? "").trim();
  const lines = [
    `【素材镜·图生视频】以首帧的真实素材为环境基准，生成一段 ${duration} 秒、有真实运动的镜头。`,
    `【素材内容】${scene || "真实实拍素材"}${sceneDescription ? `；${sceneDescription}` : ""}`,
    "【保真硬约束】严格保持首帧中的真实地标/建筑结构与外观：楼的层数、檐口层叠关系、匾额与牌匾文字、"
      + "屋脊与脊兽、周边地形与水域关系都不得改造、增减或臆造；文字标识必须保持原有字形与内容；"
      + "不得把实拍建筑改成幻想建筑或添加原本不存在的构件。",
    "【必须生成真实运动】画面要有符合原场景的物理变化；仅对场景内存在的元素，例如云层与天空缓慢流动、水面波纹、树叶随风轻摆，按原意自然表现；不得凭空增加水域、人群、车流、灯笼或光源；"
      + "运动幅度以「明显可辨但不变形」为准，禁止用整幅画面平移、缩放、旋转等贴图式运动伪造真实运镜。",
    motionIntent ? `【镜头运动】${motionIntent}` : "【镜头运动】缓速推进后稳住，保持主体构图稳定。",
    motionDirection(shot, options.motionStrength === "assertive"),
    `【禁止静态直出】画面不得全程静止、不得整幅不变、不得出现"照片被平移/放大"的贴图感；`
      + `若模型无法生成运动，宁可输出极缓的自然运动（云、水、光的变化）也不得复刻首帧静止画面。`,
    "【画面质感】写实电影摄影质感，自然光与真实材质，噪点与颗粒自然；无 AI 绘画感、无塑料感、无油画笔触。",
    lighting ? `【光线】${lighting}` : "",
    colorPalette ? `【色调】${colorPalette}` : "",
    props ? `【画面元素】${props}` : "",
    `【约束】${aspect} 画幅 ${resolution}；无水印、无字幕、无标题字、无 LOGO、无边框、无遮挡角标；`
      + "画面内不出现任何新增文字；不出现第二处地标复制、不出现建筑镜像穿模与纹理重复。",
    negative ? `【负面】${negative}；静态画面、照片平移、贴图动效、建筑臆造、文字变化、水印字幕。`
      : "【负面】静态画面、照片平移、贴图动效、建筑臆造、文字变化、水印字幕。",
    options.injection ? String(options.injection).trim() : "",
    options.title ? `【作品】${options.title}` : ""
  ].filter((line) => line.length > 0);
  const prompt = lines.join("\n");
  assertNoDegenerateTokens(prompt);
  return prompt;
}

/** 退化哨兵（plate-prompt 事故同款）：提示词里不得出现 NaN/undefined/[object Object] */
export function assertNoDegenerateTokens(prompt: string): void {
  const hit = prompt.match(/NaN|undefined|\[object Object\]/);
  if (hit) throw new MaterialPolicyError(`素材生成提示词出现退化标记 ${hit[0]}（组装逻辑有缺陷）`, "material_prompt_degenerate");
}

export interface MaterialReuseSample {
  /** 采样点在镜头内的时刻（秒） */
  atSec: number;
  /**
   * 该帧与素材在"候选裁切/缩放窗口"里的**最佳匹配 PSNR（dB）**。
   * 越高越像"素材本身被平移/放大"；真实生成的画面会因为云/水/光/人群的变化而明显下降。
   */
  bestPsnrDb: number | null;
  /**
   * 同一候选窗口的**最佳结构相似度（0–1）**。
   *
   * 为什么要第二个指标（2026-09-26 真机）：模型"从远景推近到参考照片"时，后段画面是参考图的
   * **深度变焦**——它既不是像素级拷贝（PSNR 只有 20–35dB，到不了同一张图的 45dB），
   * 也不是真实重建场景（结构、构图、细节与参考图高度一致，SSIM ≥ 0.8）。
   * 只看 PSNR 会把这类"看起来就是那张照片"的镜头放行（真机 NC-02：复用度峰值 13.2dB 被判通过，
   * 但成片 5.5–9.5s 观众看到的就是照片特写）。
   */
  bestSsim?: number | null;
}

export interface MaterialReusePolicy {
  /** 判定"像素级几乎就是同一张图"的 PSNR 阈值（dB）：JPEG 重编码级别 ≈40，因此取 45 留出余量 */
  identicalPsnrDb: number;
  /**
   * 判定"视觉上就是那张照片"的 PSNR 下限（dB）：低于它时连结构都不像参考图，不参与照片判定。
   * 与 `photoLikeSsim` **同时满足**才计一次命中（两个指标互证，避免单一指标误杀）。
   */
  photoLikePsnrDb: number;
  /** 判定"视觉上就是那张照片"的结构相似度下限（0–1） */
  photoLikeSsim: number;
  /** 判定静态直出所需的最少命中采样数（单帧可能是巧合，中后段连续命中才是直出） */
  minHits: number;
  /** 采样点覆盖比例下限：低于该时刻的样本不参与"后段复用"判定 */
  lateSampleRatio: number;
}

export const MATERIAL_REUSE_POLICY: MaterialReusePolicy = {
  identicalPsnrDb: 45,
  /**
   * 26dB + SSIM 0.80：真机标定——NC-02 的照片变焦后段与"素材按 2–4× 变焦窗口"对齐后
   * 落在 26–34dB / SSIM 0.82–0.93；而正常重建场景（河岸远景、街景、夜市）在同样候选集下
   * 峰值 PSNR ≤ 20dB、SSIM ≤ 0.62。阈值取在两簇之间，既不误杀真实场景，也不放行照片变焦。
   */
  photoLikePsnrDb: 26,
  photoLikeSsim: 0.8,
  minHits: 2,
  lateSampleRatio: 0.4
};

export interface MaterialReuseAssessment {
  status: QualityStatus;
  passed: boolean;
  /** 硬判据：中后段连续命中 → 就是素材本身（像素级或视觉级） */
  staticDisplay: boolean;
  hits: number;
  samples: number;
  /** 全部采样帧里的最高 PSNR（dB），用于报告"最像素材的一帧有多像" */
  worst: number | null;
  /** 全部采样帧里的最高 SSIM（0–1） */
  maxSsim: number | null;
  /** 首次命中（`staticDisplay` 判据）的时刻（秒）；无命中为 null。用于**尾部裁剪**定位 */
  firstHitSec: number | null;
  /** 命中的判定依据：pixel（PSNR≥identicalPsnrDb）/ visual（PSNR+SSIM 双证据）/ null */
  hitKind: "pixel" | "visual" | null;
  detail: string;
}

/**
 * 静态直出判定（确定性，纯函数）。
 *
 * 口径：**中后段**（≥ 时长 40%）至少 `minHits` 个采样帧与素材的候选窗口匹配到 `identicalPsnrDb` 以上，
 * 说明这段时间里画面始终能在素材里找到几乎一样的像素 → 判"素材静态直出"（不一定能覆盖所有"涂脂抹粉"的直出，
 * 但能把"把照片放进时间线"这一类硬伤当场拦住；主判据仍是生成任务溯源）。
 */
export function assessMaterialReuse(
  samples: MaterialReuseSample[],
  options: { durationSec: number; policy?: MaterialReusePolicy }
): MaterialReuseAssessment {
  const policy = options.policy ?? MATERIAL_REUSE_POLICY;
  const isPixelHit = (s: MaterialReuseSample): boolean => (s.bestPsnrDb ?? -1) >= policy.identicalPsnrDb;
  /**
   * 视觉命中：PSNR 与 SSIM **同时**达标。
   * 单独用 SSIM 会把"构图相似但确是重建"的镜头误杀（真实场景重建也会保构图），
   * 单独用 PSNR 又会漏掉深度变焦（见 `bestSsim` 注释），两指标互证才稳。
   */
  const isVisualHit = (s: MaterialReuseSample): boolean => (
    (s.bestPsnrDb ?? -1) >= policy.photoLikePsnrDb
    && (s.bestSsim ?? -1) >= policy.photoLikeSsim
  );
  const validPsnr = (value: unknown): value is number => typeof value === "number" && (Number.isFinite(value) || value === Infinity);
  const validDuration = Number.isFinite(options.durationSec) && options.durationSec > 0;
  const validPolicy = Number.isFinite(policy.minHits) && policy.minHits >= 2 && Number.isInteger(policy.minHits)
    && [policy.identicalPsnrDb, policy.photoLikePsnrDb, policy.photoLikeSsim].every(Number.isFinite)
    && policy.identicalPsnrDb >= policy.photoLikePsnrDb && policy.photoLikeSsim >= -1 && policy.photoLikeSsim <= 1
    && Number.isFinite(policy.lateSampleRatio) && policy.lateSampleRatio > 0 && policy.lateSampleRatio < 1;
  const late = samples.filter((s) => validDuration && Number.isFinite(s.atSec) && s.atSec >= options.durationSec * policy.lateSampleRatio && s.atSec <= options.durationSec);
  const uniqueLate = new Map(late.map((s) => [s.atSec, s]));
  const validLate = [...uniqueLate.values()].filter((s) => validPsnr(s.bestPsnrDb)
    && (isPixelHit(s) || (typeof s.bestSsim === "number" && Number.isFinite(s.bestSsim) && s.bestSsim >= -1 && s.bestSsim <= 1)));
  const complete = validDuration && validPolicy && validLate.length >= policy.minHits && validLate.length === uniqueLate.size;
  const lateHits = validLate.filter((s) => isPixelHit(s) || isVisualHit(s));
  const measured = samples.map((s) => s.bestPsnrDb).filter(validPsnr);
  const ssims = samples.map((s) => s.bestSsim).filter((v): v is number => typeof v === "number" && Number.isFinite(v));
  const worstAll = measured.length > 0 ? Math.max(...measured) : null;
  const maxSsim = ssims.length > 0 ? Math.max(...ssims) : null;
  const staticDisplay = lateHits.length >= policy.minHits;
  const firstHitSec = lateHits.length > 0 ? Math.min(...lateHits.map((s) => s.atSec)) : null;
  const hitKind: MaterialReuseAssessment["hitKind"] = lateHits.length === 0
    ? null
    : (lateHits.some(isPixelHit) ? "pixel" : "visual");
  const detail = measured.length === 0
    ? "复用度未测到（无有效采样）"
    : `后段采样 ${late.length} 帧，命中 ${lateHits.length} 帧`
      + `（像素级 ≥${policy.identicalPsnrDb}dB 或 视觉级 ≥${policy.photoLikePsnrDb}dB 且 SSIM ≥${policy.photoLikeSsim}）`
      + `；峰值 PSNR ${worstAll === null ? "n/a" : `${worstAll.toFixed(1)}dB`} / 峰值 SSIM ${maxSsim === null ? "n/a" : maxSsim.toFixed(3)}`
      + (firstHitSec === null ? "" : `；首次命中 ${firstHitSec.toFixed(2)}s（可用于尾部裁剪）`);
  const status: QualityStatus = staticDisplay ? "failed" : complete ? "passed" : "unverified";
  return { status, passed: status === "passed", staticDisplay, hits: lateHits.length, samples: late.length, worst: worstAll, maxSsim, firstHitSec, hitKind, detail: status === "unverified" ? `复用度未测到完整有效证据（需至少 ${policy.minHits} 个不同后段时间点、PSNR及SSIM）：${detail}` : detail };
}

/**
 * 生成任务溯源判据：素材镜必须能证明"成片片段由生成模型产出"。
 * 缺任务号/模型名 → 无法证明不是静态直出 → 硬闸不通过。
 */
export function assertMaterialGenerationProvenance(evidence: {
  renderTaskId?: string | null;
  model?: string | null;
  sourceMaterialSha256?: string | null;
  outputSha256?: string | null;
}): { ok: boolean; detail: string } {
  const missing: string[] = [];
  if (!evidence.renderTaskId) missing.push("渲染任务号");
  if (!evidence.model) missing.push("生成模型");
  if (!evidence.sourceMaterialSha256) missing.push("素材指纹");
  if (!evidence.outputSha256) missing.push("产物指纹");
  if (missing.length > 0) {
    return { ok: false, detail: `素材镜缺生成溯源：${missing.join("、")}（无回执不算完成，禁止把素材当镜头用）` };
  }
  if (evidence.sourceMaterialSha256 === evidence.outputSha256) {
    return { ok: false, detail: "产物指纹与素材指纹相同：这就是素材本身（静态直出）" };
  }
  return { ok: true, detail: `生成溯源齐备：任务 ${evidence.renderTaskId}（${evidence.model}）` };
}

export interface MaterialScenePromptOptions extends MaterialMotionPromptOptions {
  /** 参考素材里"必须保持一致"的实景要素（地标形制/文字标识等），由镜头卡给出 */
  mustKeep?: string[];
}

/**
 * **场景构建提示词**（material-scene/v1，当前素材镜的唯一合法出片路径）。
 *
 * 与 `buildMaterialMotionPrompt`（旧：把参考图当首帧做动效）的区别就在第一句：
 * 这里要求模型"以参考为依据**构建**一段真实拍摄的视频场景"，并明确"禁止复刻参考图构图"。
 */
export function buildMaterialScenePrompt(shot: Record<string, unknown>, options: MaterialScenePromptOptions = {}): string {
  const spec = readMaterialSpec(shot);
  const aspect = options.aspect ?? "9:16";
  const resolution = options.resolution ?? "1080p";
  const duration = Number(options.durationSec ?? shot.duration ?? 5);
  const scene = String(shot.scene ?? spec.description ?? "").trim();
  const sceneDescription = String(shot.sceneDescription ?? "").trim();
  const lighting = String(shot.lighting ?? "").trim();
  const colorPalette = String(shot.color_palette ?? "").trim();
  const propsLine = String(shot.props ?? "").trim();
  const negative = String(shot.negative ?? "").trim();
  const motionIntent = spec.motion ?? String(shot.camera_movement ?? "").trim();
  const mustKeep = (options.mustKeep ?? [
    "地标/建筑的形制与层叠关系", "匾额与牌匾文字标识", "水域、地形与城市天际线的相对关系", "材质与天色的真实感"
  ]).join("、");
  const lines = [
    `【任务】以提供的实拍参考素材为**实景依据**，构建一段 ${duration} 秒的真实拍摄感视频场景。`
      + `注意：参考图只用于确认实景要素，**不是首帧、不是要你把它动起来**——你要拍的是这个真实场景里的一段视频。`,
    `【实景依据·保持一致】${mustKeep}。参考素材说明：${scene || "实拍地标"}${sceneDescription ? `；${sceneDescription}` : ""}`,
    "【必须由你构建的部分】机位与取景遵循镜头卡，不得用参考照片平移缩放冒充视频；有镜头位移时应有真实三维视差，固定机位则保持取景稳定。环境与主体仅按场景中实际存在的元素自然变化，不新增云、水、人群或道具。补全画面应遵守真实空间，不能出现参考图的边界或黑边。",
    motionIntent ? `【镜头运动（本镜意图）】${motionIntent}` : "【镜头运动（本镜意图）】缓速推进后稳住。",
    motionDirection(shot, options.motionStrength === "assertive"),
    "【禁止】把参考照片整幅平移/缩放/旋转作为成片；画面冻结；凭空增添元素；物理不成立的视差。",
    "【画面质感】写实电影摄影：真实镜头语言、自然景深与运动模糊、真实材质与光比；无 AI 绘画感、无塑料感、无穿模。",
    lighting ? `【光线】${lighting}` : "",
    colorPalette ? `【色调】${colorPalette}` : "",
    propsLine ? `【画面元素】${propsLine}` : "",
    `【约束】${aspect} 画幅 ${resolution}；无水印、无字幕、无标题字、无 LOGO、无边框；画面内不出现任何新增文字。`,
    negative ? `【负面】${negative}；照片复刻、贴图平移、参考图边界、静止画面、建筑臆造、文字变化、水印字幕。`
      : "【负面】照片复刻、贴图平移、参考图边界、静止画面、建筑臆造、文字变化、水印字幕。",
    options.injection ? String(options.injection).trim() : "",
    options.title ? `【作品】${options.title}` : ""
  ].filter((line) => line.length > 0);
  const prompt = lines.join("\n");
  assertNoDegenerateTokens(prompt);
  return prompt;
}

export interface ReferenceIndependenceSample {
  /** 成片首帧与参考素材（含候选裁切/缩放窗口）的**最佳匹配 PSNR**（dB） */
  firstFrameBestPsnrDb: number | null;
  /** 成片中段帧与参考素材的最佳匹配 PSNR（dB） */
  midFrameBestPsnrDb: number | null;
  /** 首帧与参考素材在"不缩放、不位移"下的直接 PSNR（越低越说明取景不同） */
  directPsnrDb: number | null;
}

export interface ReferenceIndependencePolicy {
  /** 首帧"就是参考图"的判据：最佳匹配 PSNR ≥ 该值即判复刻 */
  reproducedPsnrDb: number;
  /** 直接比对（不对齐）到该值以上也判复刻（同一张图、同一次取景） */
  directReproducedPsnrDb: number;
  /** 中段仍能高精度匹配到参考图 → 整段是参考图的变换而非重建场景 */
  midFrameReproducedPsnrDb: number;
}

export const REFERENCE_INDEPENDENCE_POLICY: ReferenceIndependencePolicy = {
  reproducedPsnrDb: 32,
  directReproducedPsnrDb: 40,
  midFrameReproducedPsnrDb: 34
};

/**
 * "这是构建出来的视频场景，还是把参考图动起来"的量化判据（material-scene/v1）。
 * 与"静态直出"（material-usage）判据的区别：直出管的是"画面有没有动"，
 * 这里管的是"画面是不是从参考图长出来的"——首帧/中段只要还能高精度对回参考图，就判复刻。
 */
export function assessReferenceIndependence(
  sample: ReferenceIndependenceSample,
  policy: ReferenceIndependencePolicy = REFERENCE_INDEPENDENCE_POLICY
): { status: QualityStatus; independent: boolean; detail: string } {
  const best = sample.firstFrameBestPsnrDb;
  const mid = sample.midFrameBestPsnrDb;
  const direct = sample.directPsnrDb;
  const reproducedByBest = best !== null && best >= policy.reproducedPsnrDb;
  const reproducedByDirect = direct !== null && direct >= policy.directReproducedPsnrDb;
  const reproducedMid = mid !== null && mid >= policy.midFrameReproducedPsnrDb;
  const detail = `首帧最佳匹配 ${best === null ? "未测到" : `${best.toFixed(1)}dB`}（≥${policy.reproducedPsnrDb} 判复刻）`
    + ` · 首帧直比 ${direct === null ? "未测到" : `${direct.toFixed(1)}dB`}（≥${policy.directReproducedPsnrDb} 判同图）`
    + ` · 中段最佳匹配 ${mid === null ? "未测到" : `${mid.toFixed(1)}dB`}（≥${policy.midFrameReproducedPsnrDb} 判复刻）`;
  const complete = [best, mid, direct].every((v) => typeof v === "number" && (Number.isFinite(v) || v === Infinity));
  const failed = reproducedByBest || reproducedByDirect || reproducedMid;
  return {
    status: failed ? "failed" : complete ? "passed" : "unverified",
    independent: complete && !failed,
    detail: reproducedByBest || reproducedByDirect || reproducedMid
      ? `${detail}——判定为"参考图被推动/复刻"，不是构建出来的视频场景（需换机位重做）`
      : complete ? detail : `${detail}——缺少有效测量，未验证`
  };
}

/**
 * 镜头运动强度（2026-09-25 产品所有者第二轮反馈后新增）。
 *
 * 事故：素材镜虽然**确实是生成画面**（溯源与复用度都过），但运镜保守——实测运动能量
 * SC-02 7.4 / SC-03 2.7 / SC-04 4.1、速度坡道比（峰值帧差 ÷ 平均帧差）1.1–1.5，
 * 观感仍是"会呼吸的照片"，被产品所有者判为"运镜拉跨、不高极、不像《土耳其瞭望塔》"。
 *
 * 判据两条（都在成片片段上实测，口径与 `scripts/tools/full-chain-film.mts#measureMotionRichness` 一致）：
 *   · `meanEnergy`：全片平均帧间差（160×284 灰度、4 像素步长）——衡量"有没有一直在动"；
 *   · `rampRatio`：峰值帧间差 ÷ 平均——衡量"有没有速度坡道"（匀速运动比值接近 1）。
 * 阈值按真机标定（2026-09-25）：达标样片 SC-05 甩镜 9.2 / 5.6；待改进的 SC-02/03/04 分别 7.4/1.2、2.7/1.1、4.1/1.5。
 */
export interface MotionRichness {
  /** 平均帧间差（0–255 灰度量级） */
  meanEnergy: number;
  /** 峰值帧间差 */
  maxEnergy: number;
  /** 速度坡道比 = maxEnergy / meanEnergy */
  rampRatio: number;
  frames?: number;
}

export interface MotionPolicy {
  minMeanEnergy: number;
  minRampRatio: number;
  intent?: "locked" | "steady" | "dynamic" | "speed-ramp";
}

export const MATERIAL_MOTION_POLICY: MotionPolicy = {
  minMeanEnergy: 8,
  minRampRatio: 1.8
};

/**
 * **原始渲染**的运动口径（2026-09-25 南昌片真机校准）：
 * 模型端只要"一直在动、有真实镜头位移"即可（mean ≥ 8），**速度坡道是后期的事**——
 * 早先拿成片口径（ramp ≥ 1.8）去卡原始渲染，会把"匀速但运动充分"的真实运镜误判为不合格
 * （真机：NC-05 平均 9.35／坡道比 1.45、NC-12 8.68／1.65 被判"缺少速度坡道"重渲，白烧两次额度）。
 * 这里只保留一个**很软**的坡道下限（≥1.25）：用来拦住"完全匀速的无人机式平移"，
 * 真正的节奏由 `applySpeedRamp` 在成片上保证。
 */
export const MATERIAL_RAW_MOTION_POLICY: MotionPolicy = {
  minMeanEnergy: 8,
  minRampRatio: 1.25
};

export function assessMotionRichness(
  motion: MotionRichness,
  policy: MotionPolicy = motionPolicyForShot({})
): { status: QualityStatus; rich: boolean; detail: string } {
  const valid = [motion.meanEnergy, motion.maxEnergy, motion.rampRatio].every((v) => Number.isFinite(v) && v >= 0)
    && motion.maxEnergy >= motion.meanEnergy && (motion.frames === undefined || Number.isInteger(motion.frames) && motion.frames >= 2);
  if (!valid) return { status: "unverified", rich: false, detail: "运动测量缺失或非法，未验证；帧差不能代替物理真实性评审" };
  const meanOk = motion.meanEnergy >= policy.minMeanEnergy;
  const rampOk = motion.rampRatio >= policy.minRampRatio;
  const detail = `运动能量 平均 ${motion.meanEnergy.toFixed(2)}／峰值 ${motion.maxEnergy.toFixed(2)}（下限 ${policy.minMeanEnergy}）`
    + ` · 速度坡道比 ${motion.rampRatio.toFixed(2)}（下限 ${policy.minRampRatio}，匀速约为 1）`;
  return {
    status: meanOk && rampOk ? "passed" : "failed",
    rich: meanOk && rampOk,
    detail: meanOk && rampOk
      ? detail
      : `${detail}——${meanOk ? "" : "运动幅度不足；"}${rampOk ? "" : "缺少速度坡道；"}需按原镜头意图复核；帧差不能证明物理真实性`
  };
}

/** Numeric profiles are screening thresholds, not proof of camera motion or physical realism. */
export function motionPolicyForShot(shot: Record<string, unknown>): MotionPolicy {
  const text = String(shot.motion ?? shot.camera_movement ?? "").toLowerCase();
  const explicit = shot.motionProfile;
  if (explicit === "locked" || /固定|锁定|静态机位|locked|static|tripod/.test(text)) return { intent: "locked", minMeanEnergy: 0.01, minRampRatio: 0 };
  if (explicit === "speed-ramp" || /(?<!不)(?<!无)速度坡道|speed[ -]?ramp/.test(text) && !/不要.*速度坡道|无速度坡道|no speed[ -]?ramp/.test(text)) return { intent: "speed-ramp", ...MATERIAL_MOTION_POLICY };
  if (explicit === "dynamic" || /高速|快速|甩镜|whip|fast|rapid/.test(text)) return { intent: "dynamic", minMeanEnergy: 4, minRampRatio: 0 };
  return { intent: "steady", minMeanEnergy: 0.2, minRampRatio: 0 };
}
function motionDirection(shot: Record<string, unknown>, retry: boolean): string {
  const policy = motionPolicyForShot(shot);
  return "【运动强度要求】保持本镜意图；" + (policy.intent === "locked"
    ? "固定机位允许成立，主体与环境按剧本自然变化，不额外加入推拉或速度坡道。"
    : policy.intent === "speed-ramp" ? "按已声明的速度坡道组织节奏，空间视差与加减速必须物理自洽。"
    : "按已声明的速度与方向完成真实三维运镜，有视差，不强加速度坡道或甩镜。")
    + (retry ? "【上一版复核】修正已发现的问题，保留原动作、运镜和节奏，不因重试擅自加大运动。" : "");
}
