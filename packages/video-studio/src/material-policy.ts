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
 *   · 机位/焦段/取景由模型自行构建（可换机位、可换高度角度），至少完成一次真实镜头位移；
 *   · 画面必须有真实三维视差与环境运动（云/水/光/人群/车流/植被）；
 *   · 参考图没拍到的画面边缘要合理补全，不得出现参考图边界/黑边/复刻构图。
 */
export const MATERIAL_SCENE_POLICY_VERSION = "material-scene/v1";

/** 场景构建策略原文（提示词、错误信息、文档共用） */
export const MATERIAL_SCENE_POLICY_STATEMENT = [
  "参考素材只作实景依据：用它确认地标形制、结构层次、文字标识、环境关系、材质与天色；",
  "成片必须是**构建出来的视频场景**：机位、焦段、取景、镜头运动由模型自行构建，至少完成一次真实镜头位移；",
  "必须有真实三维视差与环境运动（前景/中景/远景相对位移；云、水、光、人群、车流、植被随时间变化）；",
  "不得复刻参考图构图：首帧不是参考图（不出现参考图边界、黑边或「同一张图」的取景）；",
  "镜头运动不是遮羞布：没有镜头位移、只有环境微动的画面不算视频场景（会被机检打回）。"
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
    "【必须生成真实运动】画面要有物理自洽的真实运动：云层与天空缓慢流动、水面波纹与倒影轻晃、"
      + "树叶与灯笼随风轻摆、光线随时间轻微变化、远处人群与车流自然移动；"
      + "运动幅度以「明显可辨但不变形」为准，禁止用整幅画面平移、缩放、旋转等方式伪造运动。",
    motionIntent ? `【镜头运动】${motionIntent}` : "【镜头运动】缓速推进后稳住，保持主体构图稳定。",
    /**
     * 运动强度（2026-09-25 新增）：把"要明显的镜头运动"写成可执行要求——
     * 允许并鼓励**真实的三维镜头位移**（推/拉/横摇/俯仰/升降/环绕 + 速度坡道），
     * 仍然禁止"整幅画面平移缩放的贴图式运动"（那是把静态图当镜头，属产品口径的红线）。
     */
    "【运动强度要求】镜头必须有**明显的位移与速度变化**：画面要在 5 秒内完成一次完整的运镜"
      + "（例如高速推进后急停稳住、低空俯冲后拉升、快速横摇后定住、环绕半圈、升降穿越前景），"
      + "并带**速度坡道**（起手快→收尾稳，或起手慢→中段加速→收尾快）、至少两段不同速度；"
      + "前景/中景/背景要因为镜头位移产生**明显视差**（近处元素移动幅度显著大于远处，证明是三维空间里的真实运镜）。"
      + "允许并鼓励镜头运动幅度大、速度快；**禁止的只是「整幅画面平移/缩放的贴图式运动」**"
      + "（那是把静态照片当镜头用，与真实运镜的区别在于：真实运镜有视差、有透视变化、有前后景相对位移）。",
    options.motionStrength === "assertive"
      ? "【上一版问题·必须加大】上一版镜头运动幅度不足（实测运动能量偏低）：这次把镜头位移距离与速度变化**显著加大**"
        + "（推近/拉开的行程更大、横摇更快、俯仰更明显、速度坡道的快慢对比更极端），"
        + "运动要从画面第一帧就开始、到最后一帧都保持可辨；宁可运镜更「猛」，也不要「像一张会呼吸的照片」。"
      : "",
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
}

export interface MaterialReusePolicy {
  /** 判定"几乎就是同一张图"的 PSNR 阈值（dB）：JPEG 重编码级别 ≈40，因此取 45 留出余量 */
  identicalPsnrDb: number;
  /** 判定静态直出所需的最少命中采样数（单帧可能是巧合，中后段连续命中才是直出） */
  minHits: number;
  /** 采样点覆盖比例下限：低于该时刻的样本不参与"后段复用"判定 */
  lateSampleRatio: number;
}

export const MATERIAL_REUSE_POLICY: MaterialReusePolicy = {
  identicalPsnrDb: 45,
  minHits: 2,
  lateSampleRatio: 0.4
};

export interface MaterialReuseAssessment {
  staticDisplay: boolean;
  hits: number;
  samples: number;
  worst: number | null;
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
  const late = samples.filter((s) => s.atSec >= options.durationSec * policy.lateSampleRatio && s.bestPsnrDb !== null);
  const hits = late.filter((s) => (s.bestPsnrDb as number) >= policy.identicalPsnrDb);
  const measured = samples.map((s) => s.bestPsnrDb).filter((v): v is number => v !== null);
  const worstAll = measured.length > 0 ? Math.max(...measured) : null;
  const staticDisplay = hits.length >= policy.minHits;
  const detail = measured.length === 0
    ? "复用度未测到（无有效采样）"
    : `后段采样 ${late.length} 帧，最佳匹配 PSNR ${hits.length} 帧 ≥ ${policy.identicalPsnrDb}dB`
      + `（峰值 ${worstAll === null ? "n/a" : `${worstAll.toFixed(1)}dB`}；越低越说明画面是生成出来的）`;
  return { staticDisplay, hits: hits.length, samples: late.length, worst: worstAll, detail };
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
    "【必须由你构建的部分】① **机位与取景自己定**：不得复刻参考图的构图；可以从更高/更低、更近/更远、"
      + "偏左/偏右的位置拍，可以换焦段（广角全景 → 长焦细节）；② **至少完成一次真实镜头位移**"
      + "（推近/拉开/横摇/俯仰/升降/环绕/甩镜，允许速度坡道：快起稳收或慢起快收）；"
      + "③ **真实三维视差**：前景、中景、远景的相对位移必须不同（这是「真实场景」与「照片被推动」的分水岭）；"
      + "④ **环境运动**：云层流动、水面波纹与倒影、光线变化、树叶/灯笼/旗帜摆动、人群与车流自然移动；"
      + "⑤ **补全画面**：参考图没拍到的边缘（天空、地面、侧向空间）要按真实场景合理延伸，"
      + "不得出现参考图的边界、黑边、贴图边缘或「原图被放大」的观感。",
    motionIntent ? `【镜头运动（本镜意图）】${motionIntent}` : "【镜头运动（本镜意图）】低空推进后抬升，让地标从画面下缘进入并稳住。",
    options.motionStrength === "assertive"
      ? "【上一版问题·必须加大】上一版被判定为「像参考图被推动」：这一版**换一个机位**重新构建场景，"
        + "镜头位移更大、视差更明确、环境运动更容易看出来（云/水/人群至少两处在动）。"
      : "",
    "【禁止】把参考照片整幅平移/缩放/旋转（贴图式运动）；复刻参考图构图；出现参考图边界或黑边；"
      + "画面全程静止；只有环境微动而镜头不动；把静态照片直接当镜头。",
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
): { independent: boolean; detail: string } {
  const best = sample.firstFrameBestPsnrDb;
  const mid = sample.midFrameBestPsnrDb;
  const direct = sample.directPsnrDb;
  const reproducedByBest = best !== null && best >= policy.reproducedPsnrDb;
  const reproducedByDirect = direct !== null && direct >= policy.directReproducedPsnrDb;
  const reproducedMid = mid !== null && mid >= policy.midFrameReproducedPsnrDb;
  const detail = `首帧最佳匹配 ${best === null ? "未测到" : `${best.toFixed(1)}dB`}（≥${policy.reproducedPsnrDb} 判复刻）`
    + ` · 首帧直比 ${direct === null ? "未测到" : `${direct.toFixed(1)}dB`}（≥${policy.directReproducedPsnrDb} 判同图）`
    + ` · 中段最佳匹配 ${mid === null ? "未测到" : `${mid.toFixed(1)}dB`}（≥${policy.midFrameReproducedPsnrDb} 判复刻）`;
  return {
    independent: !reproducedByBest && !reproducedByDirect && !reproducedMid,
    detail: reproducedByBest || reproducedByDirect || reproducedMid
      ? `${detail}——判定为"参考图被推动/复刻"，不是构建出来的视频场景（需换机位重做）`
      : detail
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
}

export const MATERIAL_MOTION_POLICY: MotionPolicy = {
  minMeanEnergy: 8,
  minRampRatio: 1.8
};

export function assessMotionRichness(
  motion: MotionRichness,
  policy: MotionPolicy = MATERIAL_MOTION_POLICY
): { rich: boolean; detail: string } {
  const meanOk = motion.meanEnergy >= policy.minMeanEnergy;
  const rampOk = motion.rampRatio >= policy.minRampRatio;
  const detail = `运动能量 平均 ${motion.meanEnergy.toFixed(2)}／峰值 ${motion.maxEnergy.toFixed(2)}（下限 ${policy.minMeanEnergy}）`
    + ` · 速度坡道比 ${motion.rampRatio.toFixed(2)}（下限 ${policy.minRampRatio}，匀速约为 1）`;
  return {
    rich: meanOk && rampOk,
    detail: meanOk && rampOk
      ? detail
      : `${detail}——${meanOk ? "" : "运动幅度不足；"}${rampOk ? "" : "缺少速度坡道；"}需重渲（加大镜头位移与速度变化）`
  };
}
