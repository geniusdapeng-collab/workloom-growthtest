/**
 * producer-gate —— AI 监制（制片人）门：把"人工确认"换成"机器评审 + 打回重跑"
 *
 * 背景（T-2026-0924-0001）：
 *   视频链路上原有 G1–G7 七个确认门。早先实现是两道极端：要么挂人工审批卡等人点（停线），
 *   要么用 `HR_AUTO_GATES` 一律 `approved:true`（等于没有质量门，坏产物直接往下流）。
 *   产品口径是**全自动预生产 + 人类只在花钱/对外时介入**，所以中间门需要的是"AI 监制"：
 *   看产物、按纪律打分、不合格就打回重跑，并把裁决写进日志与事件。
 *
 * 本模块提供三件事：
 *   1. `PRODUCER_RUBRICS` —— 逐环节评审要点（与 bundles/ai-video/skills 的纪律同源）；
 *   2. 确定性硬闸（调用方传入 ffprobe/文件校验结果）—— 硬失败直接打回，不消耗模型额度；
 *   3. 可选的 LLM 评审（含图像）—— 打分 + 问题清单 + 修改建议；模型不可用时**如实降级**并标注。
 *
 * 纪律：默认 fail-closed —— 硬闸失败必打回；LLM 不可用且无硬闸结论时**不放行**（返回 rerun），
 * 只有"硬闸全过 + 显式允许降级"才降级放行并标记 `via:"fallback"`（便于审计"哪些门是空转的"）。
 */

export type ProducerStage =
  | "script"
  | "continuity"
  | "micromotion"
  | "prompt"
  | "keyframe"
  | "shot"
  | "compose"
  | "color"
  | "subtitle"
  | "mux"
  | "danmaku"
  | "bgm"
  | "cover"
  | "master";

import { existsSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";

export interface DeterministicCheck {
  id: string;
  pass: boolean;
  detail: string;
  /** 硬闸：失败即打回（LLM 无权推翻）。缺省 = 软信号（只进问题清单，不影响放行判定） */
  hard?: boolean;
}

export interface ProducerArtifact {
  path: string;
  kind: "image" | "video" | "audio" | "text" | "json";
  bytes?: number;
  /** ffprobe 摘要（video/audio）：width/height/duration/loudness 等 */
  probe?: Record<string, unknown>;
  note?: string;
}

export interface ProducerVerdict {
  stage: ProducerStage;
  approved: boolean;
  /** 0–100；硬闸失败为 0 */
  score: number;
  hardFailures: string[];
  issues: string[];
  suggestions: string[];
  /** 建议重跑本环节（approved=false 时恒为 true） */
  rerun: boolean;
  via: "deterministic" | "llm" | "fallback";
  model?: string;
  ms: number;
  reason: string;
  /** 降级放行（模型不可用但硬闸全过）——审计要用 */
  degraded: boolean;
}

/**
 * 逐环节评审要点（与 bundles/ai-video/skills 的纪律同源；中文，便于直接落日志/审批卡）。
 * 注意：这里是"监制看什么"，不是确定性断言——确定性断言由调用方按产物实测传入。
 */
export const PRODUCER_RUBRICS: Record<ProducerStage, string[]> = {
  script: [
    "台词速率 ≤ 3.6 字/秒（按镜头时长硬算），不出现念不完的长句",
    "每镜有明确的动作与情绪变化，不是静态摆拍",
    "镜头时长合计等于目标总时长，节奏有起伏（开场/推进/收尾）"
  ],
  prompt: [
    "25/30 字段齐备且非模板默认值（字段是生成的，不是下游补的）",
    "提示词长度达到交付口径（≥1200 字），含【约束】实际画幅分辨率",
    "不含红线词（科幻/微观等与 brief 无关的意象），无 [object Object]",
    "场景与人物解耦：定妆照只描述人，场景只由镜头提示词给"
  ],
  /**
   * 连贯性导演评审（2026-09-24 接入）：跨镜头看"还是不是同一支片子"。
   * 6 问 + 5 维与 `packages/video-studio/src/continuity.ts` 的确定性检查同源，
   * LLM 只负责"机检查不出来的语义跳变"（例如同一场景里空间关系讲不通）。
   */
  continuity: [
    "人物同一性：六镜是同一个人、同一套造型（服装/妆造/发型无可解释变化）",
    "空间连续性：同一场所的空间锚点（河道/桥/船/建筑/巷道）连续，转场有交代",
    "时间与光线推进：时段单向推进或显式闪回，不出现时间错乱",
    "动作与视线连续：相邻镜的运动方向与视线读得通，没有来回折返",
    "道具状态连续：关键道具（碗/勺/船/灯笼/伞）的出现与消失都有动作交代",
    "节奏与情绪：总时长对齐目标，情绪曲线有起承转收，结尾收得住"
  ],
  /**
   * 微动作增强（2026-09-24 接入）：5 路（面部/身体/眼神/呼吸/融合）是否真的落到提示词里。
   */
  micromotion: [
    "五路微动作齐备：面部（眉/嘴角）、眼神（注视点与眨眼）、身体（重心/肩线）、呼吸（与时长对齐）、融合（与台词节拍对齐）",
    "微动作是**画面语言**（可被摄影机拍到），不是情绪形容词堆砌",
    "微动作与宏观动作不冲突（不出现'站在原地走两步'这类互斥描述）",
    "增量有界：微动作补充不把提示词撑到影响交付闸（增量 ≤200 字）"
  ],
  keyframe: [
    /**
     * 桥/栈道类结构（2026-09-24 真机二次事故命名化）：
     * 交付成片里出现过"桥面两侧直接临水、看不到任何一端连接"的悬空步道（观众读作「从水里走上来的一座桥」）。
     * 这类结构问题在旧 rubric 里只能靠"空间与物理自洽（通用）"间接覆盖，评审时容易被人物/画质项盖过；
     * 现在单独点名，且给出可判定的判据。
     */
    "桥/栈道类结构（场景含桥、栈道时必判）：桥体可辨（拱形或梁式）、两端各有桥头并与岸线/地面真实相接、栏杆沿桥面连续；不出现「桥面两侧直接临水且看不到任何一端连接」的悬空步道（无头之桥）、不出现桥体与水面之间无驳岸/桥台过渡",
    "画面里的人物与角色档案/定妆照是同一张脸、同一发型与服装",
    "是纯写实影像（非插画/3D/CG），皮肤有真实质感不塑料",
    "构图符合镜头卡（景别/朝向/留白），主体完整入画无裁切事故",
    "无文字、无水印、无多余手指/肢体，无第二张脸",
    "场景与镜头卡一致（地点/时段/道具），且没有出现定妆照里的中性背景",
    /**
     * 通用空间/物理自洽（2026-09-24 机制化）：
     * 这条**不对场景做任何枚举**，而是给出"任何画面都必须成立"的物理不变量——
     * 起因：「无头之桥」（水面上一条看不到桥头、看不出通往何处的桥面）能通过关键帧与视频两道门，
     * 因为当时 rubric 只查人物一致性/肢体/构图，没有"结构是否成立"这一类目。
     * 穷举场景（桥/栈道/台阶…）永远有漏网，唯一可扩展的做法是把**物理不变量**写进评审层。
     */
    "空间与物理自洽（通用，任何场景都要判）：① 结构完整性——画面里的建筑/地形/器物都是有来由、有落点、有支撑的完整结构，不出现悬空构件、断裂结构、无来由的延伸；② 尺度关系——人物与环境元素的尺度比合理（门高于人、栏杆到腰、路宽于步幅、器物可被手持）；③ 透视一致——同一场景内线性元素共享地平线与消失点，不出现两套透视；④ 光影一致——光向/色温/阴影方向与时段相符，物体与地面有接触阴影；⑤ 接触与承重——脚踩地、手有支撑、道具被真实承重，无穿模与漂浮"
  ],
  shot: [
    "桥/栈道类结构（场景含桥、栈道时必判）：整镜内桥体与两端连接保持一致，不出现结构凭空出现/消失、桥面变成悬空步道、桥体与水面的接触关系翻转",
    "肢体语言自然：重心、步态、手部动作有真实物理感，无肢体畸变",
    "表情丰富且与台词情绪一致（眉眼/嘴角有变化，不是面无表情）",
    "口型与台词时长匹配，动作连贯无跳帧感",
    "与前后镜人物形象一致（同脸同服装），无跨镜漂移",
    "空间与物理自洽（通用）：镜头内的场景结构、尺度、透视、光影、接触关系在时间上保持一致，不出现结构凭空出现/消失、物体漂浮或穿模"
  ],
  compose: [
    "拼接处无花屏/丢帧/音画不同步，转场自然",
    "总时长与目标一致（±0.5s），分辨率/帧率/像素格式全片统一"
  ],
  color: [
    "肤色不偏色（不蜡黄不发青），暗部不死黑、高光不溢出",
    "影调统一且符合题材（江南水乡：低饱和、月白黛青、暖灯不过饱和）",
    "调色后画质不劣于原片（择优机制：拿不到提升就不调）"
  ],
  subtitle: [
    "字幕在安全区内（避开平台 UI 遮挡区与画面主体面部）",
    "字体/字号/描边与题材匹配，可现度达标（Δ 超过阈值）",
    "时间轴与台词逐条对齐，无错字与断句事故"
  ],
  /**
   * 软字幕轨收口（2026-09-24 补登记）。这个环节一直是**默认阶段**（`mux`），
   * 但因为一直没人跑到它就没人发现 rubric 缺失——真机第一次跑到即 TypeError，
   * 把整条交付链打断在最后一步。补上判据。
   */
  mux: [
    "软字幕轨版可播放，字幕轨可开关（画面与声音轨逐帧 copy、零改动）",
    "时长与母版一致（±0.05s），无重新编码导致的画质劣化",
    "旁挂字幕文件（srt/ass/vtt + 清单）随交付目录齐备，语言标注正确",
    "字幕轨内容与旁挂文件一致（不是两份各说各话）"
  ],
  danmaku: [
    "弹幕不遮挡主体面部与字幕带，密度不过载（并发未超上限）",
    "弹幕内容与画面语境相符，不出现与题材无关的评论",
    "滚动/固定弹幕分层清晰，透明度不淹没画面"
  ],
  bgm: [
    "整片响度达标（−14 LUFS 附近）且真峰值不超 −1 dBTP",
    "人声/环境声时刻 BGM 让位（ducking），不盖台词",
    /**
     * 曲风判据必须**跟着 brief 走**（2026-09-25 真机）：早先写死"江南水乡：温润、中慢、器乐为主"，
     * 于是给城市地标片挑的电子律动曲被按上一部片子的题材打回，点评理由与 brief 直接冲突。
     * 现在只要求"与 brief/平台调性一致"，并把 brief 里的 tone/editingStyle 作为事实依据传进来。
     */
    "曲风与 brief 的题材、平台与剪辑风格一致（城市地标/快剪可走电子律动；抒情纪实走温润器乐），无人声唱歌抢戏",
    "卡点与画面切换点对齐（误差在片长容忍内；快剪片以硬切点为基准）"
  ],
  cover: [
    "钩子文案与成片内容一致（不标题党），主标题 ≤ 9 字/行、最多两行",
    "主体面部不被文字压住，底部平台 UI 遮挡区不放大字",
    "封面与视频首帧风格统一，色彩与调色后母版一致"
  ],
  master: [
    "整片可播放、时长/分辨率/帧率/音轨符合交付规格",
    "五项后期能力（调色/字幕/弹幕/配乐/封面）都在成片里可见",
    "无黑帧、无静音段事故、无编码错误",
    "全片空间与物理自洽（通用）复核：抽检各镜的场景结构完整性、尺度与透视一致性，未出现悬空/断裂结构、漂浮物体或与人物尺度冲突的元素"
  ]
};

export interface ProducerGateOptions {
  stage: ProducerStage;
  projectId: string;
  artifacts: ProducerArtifact[];
  deterministic: DeterministicCheck[];
  /** 覆盖默认评审要点 */
  rubric?: string[];
  /** 画面类环节可附视觉基准（如定妆照）做一致性比对 */
  referenceImages?: string[];
  context?: Record<string, unknown>;
  /** 允许在"硬闸全过 + 模型不可用"时降级放行（默认 false，fail-closed） */
  allowFallbackApprove?: boolean;
  env?: Record<string, string | undefined>;
  fetchImpl?: typeof fetch;
  log?: (line: string) => void;
  /**
   * 评审图压缩器（2026-09-24 三轮审计）：送审图大于预算时调用，返回压缩后的图片路径（失败返回 null）。
   * 默认实现用 ffmpeg 缩到 720 宽 JPEG；测试注入替身，避免单测依赖 ffmpeg。
   */
  shrinkImage?: (path: string) => string | null;
}

interface LlmConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
}

/** 解析评审模型（与 model-router 的 LLM_* 口径一致，兼容 DEEPSEEK_* 秘密文件） */
export function resolveProducerLlm(env: Record<string, string | undefined> = process.env): LlmConfig | null {
  const baseUrl = env.LLM_BASE_URL ?? env.DEEPSEEK_BASE_URL ?? "";
  const apiKey = env.LLM_API_KEY ?? env.DEEPSEEK_API_KEY ?? "";
  const model = env.LLM_MODEL ?? env.DEEPSEEK_MODEL ?? "";
  if (!baseUrl || !apiKey || !model) return null;
  return { baseUrl: baseUrl.replace(/\/$/, ""), apiKey, model };
}

function mimeOf(path: string): string {
  const lower = path.toLowerCase();
  if (lower.endsWith(".png")) return "image/png";
  if (lower.endsWith(".webp")) return "image/webp";
  if (lower.endsWith(".jpg") || lower.endsWith(".jpeg")) return "image/jpeg";
  return "application/octet-stream";
}

function summarizeArtifacts(artifacts: ProducerArtifact[]): string {
  return artifacts.map((a) => {
    const probe = a.probe ? ` ${JSON.stringify(a.probe)}` : "";
    const bytes = typeof a.bytes === "number" ? ` ${(a.bytes / 1024).toFixed(0)}KB` : "";
    return `- [${a.kind}] ${a.path}${bytes}${probe}${a.note ? ` — ${a.note}` : ""}`;
  }).join("\n");
}

/**
 * 单张送审图预算（2026-09-24 三轮审计，真机事故复现）：
 * 视频抽帧是 1080×1920 的 PNG，单张 ≈10MB；4 张产物帧 + 2 张基准图一起 base64 后 **≈53MB**，
 * 评审模型的网关直接返回 `HTTP 413 Request Entity Too Large` → 监制判为"不可用"、镜头悬空（既没通过也没真打回）。
 * 这里加一道**按需压缩**：超过预算的图先缩到 720 宽 JPEG 再送审；压缩器不可用时保持原图并如实记日志
 * （宁可送大图赌一次，也不能悄悄丢掉评审证据）。
 */
const JUDGE_IMAGE_BUDGET_BYTES = 900_000;

/** 默认压缩器：ffmpeg 缩到 720 宽 JPEG（失败返回 null，由调用方如实降级） */
function shrinkImageWithFfmpeg(path: string): string | null {
  const bin = process.env.WL_FFMPEG ?? "ffmpeg";
  const out = join(tmpdir(), `producer-judge-${randomUUID()}.jpg`);
  const res = spawnSync(bin, [
    "-hide_banner", "-v", "error", "-y", "-i", path,
    "-frames:v", "1", "-vf", "scale=720:-2", "-q:v", "3", out
  ]);
  if (res.status !== 0 || !existsSync(out)) {
    try { rmSync(out, { force: true }); } catch { /* 压缩失败产物不存在也无所谓 */ }
    return null;
  }
  return statSync(out).size < statSync(path).size ? out : null;
}

/**
 * 解析评审模型输出的 JSON：
 *   ① 直接解析（剥掉可能的 ``` 包裹）；
 *   ② 取第一个 `{` 到最后一个 `}` 的片段再解析（裁掉解释性前后缀）；
 *   ③ 仍失败 → 让模型"只重发合法 JSON"自修复一次；
 *   ④ 还失败 → 抛错（调用方按"评审不可用"fail-closed 处理）。
 */
async function parseJudgeJson(
  raw: string,
  llm: LlmConfig,
  fetchImpl: typeof fetch,
  log: (line: string) => void,
  stage: ProducerStage
): Promise<Record<string, unknown>> {
  const stripped = raw.replace(/^```(?:json)?/m, "").replace(/```\s*$/m, "").trim();
  const tryParse = (text: string): Record<string, unknown> | null => {
    try {
      return JSON.parse(text) as Record<string, unknown>;
    } catch {
      return null;
    }
  };
  const direct = tryParse(stripped);
  if (direct) return direct;
  const start = stripped.indexOf("{");
  const end = stripped.lastIndexOf("}");
  if (start >= 0 && end > start) {
    const sliced = tryParse(stripped.slice(start, end + 1));
    if (sliced) return sliced;
  }
  log(`[producer][${stage}] 评审输出不是合法 JSON，要求模型自修复一次`);
  const repair = await fetchImpl(`${llm.baseUrl}/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${llm.apiKey}` },
    body: JSON.stringify({
      model: llm.model,
      messages: [
        { role: "user", content: "把下面这段内容整理成**严格合法**的 JSON（只输出 JSON，不要任何解释、不要 markdown）：\n\n" + raw.slice(0, 4000) }
      ],
      temperature: 0,
      response_format: { type: "json_object" }
    }),
    signal: AbortSignal.timeout(120_000)
  });
  const repairText = await repair.text();
  if (!repair.ok) throw new Error(`评审 JSON 修复失败：HTTP ${repair.status} ${repairText.slice(0, 160)}`);
  const repaired = (JSON.parse(repairText) as { choices?: Array<{ message?: { content?: string } }> }).choices?.[0]?.message?.content ?? "";
  const fixed = tryParse(repaired.replace(/^```(?:json)?/m, "").replace(/```\s*$/m, "").trim());
  if (!fixed) throw new Error(`评审 JSON 修复后仍非法：${repaired.slice(0, 160)}`);
  return fixed;
}

/**
 * 评审一个环节。返回裁决；调用方按 `approved` 决定放行或重跑。
 */
export async function reviewStage(options: ProducerGateOptions): Promise<ProducerVerdict> {
  const started = Date.now();
  const log = options.log ?? (() => undefined);
  const stage = options.stage;
  const rubric = options.rubric ?? PRODUCER_RUBRICS[stage];
  const hardFailures = options.deterministic.filter((c) => !c.pass && c.hard === true).map((c) => `${c.id}：${c.detail}`);
  const softFailures = options.deterministic.filter((c) => c.pass === false).map((c) => `${c.id}：${c.detail}`);

  /** ① 硬闸：任一失败直接打回 */
  if (hardFailures.length > 0) {
    log(`[producer][${stage}] 硬闸失败，打回重跑：${hardFailures.join("；")}`);
    return {
      stage,
      approved: false,
      score: 0,
      hardFailures,
      issues: softFailures,
      suggestions: [`按硬闸失败项修复后重跑本环节：${hardFailures[0]}`],
      rerun: true,
      via: "deterministic",
      ms: Date.now() - started,
      reason: `确定性硬闸未通过（${hardFailures.length} 项）`,
      degraded: false
    };
  }

  const llm = resolveProducerLlm(options.env ?? process.env);
  /** ② 无模型：显式降级（默认不放行，除非调用方允许降级） */
  if (!llm) {
    const approved = Boolean(options.allowFallbackApprove);
    log(`[producer][${stage}] 无可用评审模型 → ${approved ? "降级放行（已标记 degraded）" : "拒绝放行（fail-closed）"}`);
    return {
      stage,
      approved,
      score: approved ? 60 : 0,
      hardFailures: [],
      issues: softFailures,
      suggestions: approved ? ["接入 LLM_* 后重新开启实质评审"] : ["配置 LLM_BASE_URL / LLM_API_KEY / LLM_MODEL 后重跑"],
      rerun: !approved,
      via: "fallback",
      ms: Date.now() - started,
      reason: approved ? "无评审模型，按允许降级放行" : "无评审模型，且未允许降级",
      degraded: true
    };
  }

  /** ③ LLM 监制评审（可带图） */
  const imageArtifacts = options.artifacts.filter((a) => a.kind === "image");
  const content: Array<Record<string, unknown>> = [
    {
      type: "text",
      text: [
        `你是视频项目的 AI 监制（制片人），负责在【${stage}】环节放行或打回重跑。`,
        `项目：${options.projectId}`,
        "",
        "评审要点（逐条判断）：",
        ...rubric.map((r, i) => `${i + 1}. ${r}`),
        "",
        "本环节产物：",
        summarizeArtifacts(options.artifacts),
        "",
        "确定性检查结果（已通过，作为事实依据）：",
        options.deterministic.map((c) => `- ${c.pass ? "PASS" : "FAIL"} ${c.id}：${c.detail}`).join("\n") || "- 无",
        /**
         * 补充事实的注入上限（2026-09-25 从 2000 提到 6000）：题材/平台/剪辑风格这类**判据依据**
         * 一旦被截断，监制就会拿"记忆里的旧标准"打分（真机：给城市地标片挑电子律动曲，
         * 却被按上一部水乡片的口味打回）。判据比省 token 重要。
         */
        options.context ? `\n补充事实：\n${JSON.stringify(options.context, null, 1).slice(0, 6000)}` : "",
        "",
        "只输出 JSON（不要 markdown 代码块）：",
        '{"approved": true|false, "score": 0-100, "issues": ["..."], "suggestions": ["..."], "reason": "一句话结论"}',
        "判定纪律（以下任一命中即必须 approved=false，并给出可执行的重跑建议）：人物不像、画质塑料、肢体畸变、遮挡主体、与上面任一条纪律冲突。"
      ].join("\n")
    }
  ];
  /**
   * 图像配额（2026-09-24 真机修正）：**待评审产物优先**。
   * 早先把基准图排在前面，4 张基准图吃满配额后产物只剩 2 张，评审看不到 closeup 等关键机位。
   * 现在口径：产物最多 4 张，基准图最多 2 张（够做人脸参照即可）。
   */
  const imageQueue = [
    ...imageArtifacts.slice(0, 4).map((a) => ({ path: a.path, label: "待评审产物" })),
    ...(options.referenceImages ?? []).slice(0, 2).map((path) => ({ path, label: "基准图（角色定妆照/授权真人照片）" }))
  ];
  /** 压缩产物是临时文件，请求结束后回收（评审重试/修复调用共用同一批已编码内容） */
  const tempImages: string[] = [];
  for (const image of imageQueue) {
    try {
      let attachPath = image.path;
      let bytes = readFileSync(attachPath);
      if (bytes.byteLength > JUDGE_IMAGE_BUDGET_BYTES) {
        const shrink = options.shrinkImage ?? shrinkImageWithFfmpeg;
        const shrunk = shrink(image.path);
        if (shrunk) {
          attachPath = shrunk;
          tempImages.push(shrunk);
          bytes = readFileSync(shrunk);
          log(`[producer][${stage}] 送审图超预算（${(readFileSync(image.path).byteLength / 1024 / 1024).toFixed(1)}MB）→ 压缩到 ${(bytes.byteLength / 1024).toFixed(0)}KB：${image.path}`);
        } else {
          log(`[producer][${stage}] 送审图超预算且压缩不可用（按原图送审，可能触发 413）：${image.path}`);
        }
      }
      content.push({ type: "text", text: `以下是${image.label}：${attachPath}` });
      content.push({ type: "image_url", image_url: { url: `data:${mimeOf(attachPath)};base64,${bytes.toString("base64")}` } });
    } catch (err) {
      log(`[producer][${stage}] 读取图像失败（跳过）：${image.path} — ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  /**
   * **文本类产物正文**也要给监制（2026-09-24 真机）：
   * 早先只送 `- [text] /path (2296KB)` 这样的清单，监制看不到正文，
   * 于是对"字段是否模板默认值 / 有没有红线词 / 有没有 [object Object]"只能回一句
   * "无正文可核验"——要么误放行、要么以"无法核实"打回（真机 prompt 环节 58 分打回）。
   * 现在按预算把 json/text 产物正文片段送进去（单文件 1600 字、总量 12000 字），
   * 图像信息优先级不变（图像在前，文本在后）。
   */
  const TEXT_EVIDENCE_PER_FILE = 1600;
  const TEXT_EVIDENCE_TOTAL = 12_000;
  const textArtifacts = [
    ...options.artifacts.filter((a) => a.kind === "json"),
    ...options.artifacts.filter((a) => a.kind === "text")
  ];
  let textBudget = TEXT_EVIDENCE_TOTAL;
  for (const artifact of textArtifacts) {
    if (textBudget <= 0) break;
    try {
      const raw = readFileSync(artifact.path, "utf8");
      const limit = Math.min(TEXT_EVIDENCE_PER_FILE, textBudget);
      const clipped = raw.length > limit ? `${raw.slice(0, limit)}\n…（已截断；原文 ${raw.length} 字）` : raw;
      textBudget -= clipped.length;
      content.push({ type: "text", text: `以下是产物正文（${artifact.kind}）：${artifact.path}\n${clipped}` });
    } catch (err) {
      log(`[producer][${stage}] 读取文本产物失败（跳过）：${artifact.path} — ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  try {
    const res = await (options.fetchImpl ?? fetch)(`${llm.baseUrl}/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${llm.apiKey}` },
      body: JSON.stringify({
        model: llm.model,
        messages: [{ role: "user", content }],
        temperature: 0.2,
        response_format: { type: "json_object" }
      }),
      signal: AbortSignal.timeout(180_000)
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`HTTP ${res.status} ${text.slice(0, 200)}`);
    const parsed = JSON.parse(text) as { choices?: Array<{ message?: { content?: string } }> };
    const raw = parsed.choices?.[0]?.message?.content ?? "";
    /**
     * 评审模型返回的 JSON 偶发畸形（真机 2026-09-24：SC-06 评审返回在第 155 字符处少了一个逗号，
     * 直接 JSON.parse 抛错 → 整个环节被判"评审不可用"）。这里先做**括号截取修复**，
     * 仍失败再让模型自修复一次；两次都失败才按"评审不可用"处理（仍是 fail-closed，但不再因一个逗号卡住产线）。
     */
    const json = await parseJudgeJson(raw, llm, options.fetchImpl ?? fetch, log, stage) as {
      approved?: boolean; score?: number; issues?: string[]; suggestions?: string[]; reason?: string;
    };
    const approved = json.approved === true;
    log(`[producer][${stage}] 评审：${approved ? "放行" : "打回"}（score=${json.score ?? "?"}）— ${json.reason ?? ""}`);
    return {
      stage,
      approved,
      score: typeof json.score === "number" ? json.score : approved ? 80 : 40,
      hardFailures: [],
      issues: [...softFailures, ...(json.issues ?? [])],
      suggestions: json.suggestions ?? [],
      rerun: !approved,
      via: "llm",
      model: llm.model,
      ms: Date.now() - started,
      reason: json.reason ?? (approved ? "评审通过" : "评审未通过"),
      degraded: false
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const approved = Boolean(options.allowFallbackApprove);
    log(`[producer][${stage}] 评审调用失败：${message.slice(0, 200)} → ${approved ? "降级放行" : "拒绝放行"}`);
    return {
      stage,
      approved,
      score: approved ? 55 : 0,
      hardFailures: [],
      issues: [...softFailures, `评审模型不可用：${message.slice(0, 160)}`],
      suggestions: approved ? ["修复评审模型通路后重跑本环节以获得实质评审"] : ["修复评审模型通路后重跑本环节"],
      rerun: !approved,
      via: "fallback",
      model: llm.model,
      ms: Date.now() - started,
      reason: `评审模型不可用：${message.slice(0, 120)}`,
      degraded: true
    };
  } finally {
    /** 回收送审用的临时压缩图（评审失败路径也要回收，避免 /tmp 里越攒越多） */
    for (const temp of tempImages) {
      try { rmSync(temp, { force: true }); } catch { /* 临时文件删不掉不该影响评审结论 */ }
    }
  }
}
