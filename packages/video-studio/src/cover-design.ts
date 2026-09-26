/**
 * cover-design —— 封面设计师的**设计稿**（2026-09-25 产品所有者口径：封面不能只有一行标题）。
 *
 * 事故：滕王阁样片的默认封面 = "取一帧 + 烧一行字"——封面职能从未真正参与，
 * 产物在发布流里就是"只有标题"的一张图。产品所有者复核时指出：**封面设计师没有发挥作用**。
 *
 * 本模块把封面变成"先出设计稿、再按稿渲染、再按稿验收"的三段式：
 *   ① `buildCoverDesignPrompt` —— 把 brief/镜头表/角色档案交给封面设计师（LLM）出**结构化设计稿**
 *      （主标题/副标题/角标/人物位/主视觉取哪一镜哪一秒/字级/配色/安全区），并要求给出设计理由；
 *   ② `parseCoverPlan` —— 严格校验设计稿（越界/过长/缺人物位即判非法，退回确定性兜底稿）；
 *   ③ `coverDeterministicChecks` —— 渲染后的**机检**：标题真的画上去了、人物层真的合成进去了、
 *      底图来自未烧字的干净母版、文字没有落进平台 UI 遮挡区。
 * 只有 ②③ 都过、再经监制（LLM）看整图，封面才算合格——"只有标题"的封面会在第 ③ 步被拦下。
 */

export type CoverLayout = "person-left" | "person-right";

/**
 * 封面可用字库（全部 OFL-1.1 / 免费商用，随仓分发在 `bundles/ai-video/library/fonts/`）。
 * 封面只允许在这四个里选：设计师可以按题材挑气质，但**不能**自己指定文件路径
 * （路径由本表映射，避免"设计师写了个不存在的字体"这类事故）。
 */
export const COVER_FONTS = {
  "smiley-sans": { file: "cn/SmileySans-Oblique.ttf", label: "得意黑", note: "年轻、抓眼，适合城市/潮流题材" },
  "source-han-heavy": { file: "cn/SourceHanSansCN-Heavy.otf", label: "思源黑体重", note: "最稳的重标题，屏幕可读性最高" },
  "zcool-qingke": { file: "cn/ZCOOLQingKeHuangYou-Regular.ttf", label: "站酷庆科黄油体", note: "圆润活泼，适合生活/旅行" },
  "noto-serif": { file: "cn/NotoSerifSC-Variable.ttf", label: "思源宋体", note: "书卷气，适合人文/历史题材" }
} as const;

export type CoverFontId = keyof typeof COVER_FONTS;

export interface CoverPlan {
  /** 主标题（≤ 12 个视觉字符，最多两行，行内用 `\n` 断行） */
  headline: string;
  /** 副标题/内容点（≤ 24 字，可空） */
  subline?: string;
  /** 角标（地点/系列名，≤ 10 字） */
  badge?: string;
  layout: CoverLayout;
  background: {
    /** 主视觉取自哪一镜 */
    shotId: string;
    /** 取帧时刻（秒） */
    atSec: number;
    /**
     * 处理：`grade` = 轻调色 + 暗角；`scrim` = 在此基础上再叠一层**渐变压暗带**（给标题留呼吸区）。
     * 渐变压暗由管线用多层薄带实现（不用两层厚带——真机教训：两层厚带会留下贯穿全宽的硬接缝）。
     */
    treatment: "grade" | "scrim";
  };
  person: {
    enabled: boolean;
    /**
     * 人物卡来源镜头（**由管线注入**，设计师不写路径）：直接用片子自己的镜头帧，
     * 这样人物与片中造型/光线一致，也不需要抠像（真机验证：定妆照抠像会掉脸、留光晕）。
     */
    shotId?: string;
    /** 人物卡取帧时刻（秒） */
    atSec?: number;
    /** 人物卡宽度占画幅宽度的比例（0.28–0.50） */
    widthRatio: number;
  };
  typography: {
    /** 字库（白名单四选一） */
    fontId: CoverFontId;
    /** 主标题字高占画幅高度的比例（0.045–0.12） */
    headlineSizeRatio: number;
    /** 副标题字高比例（0.022–0.06） */
    sublineSizeRatio: number;
    /** 主标题颜色（#RRGGBB） */
    color: string;
    /** 强调色（角标/装饰线） */
    accentColor: string;
    align: "left" | "center";
  };
  /** 设计理由（进日志与交付清单，便于复核"设计师到底想干什么"） */
  rationale: string;
  /** 设计稿来源：llm=封面设计师出的稿；fallback=设计师不可用时的确定性兜底稿 */
  source: "llm" | "fallback";
}

export class CoverDesignError extends Error {
  readonly code: string;
  constructor(message: string, code = "cover_design_invalid") {
    super(message);
    this.name = "CoverDesignError";
    this.code = code;
  }
}

/** 封面安全区（平台 UI 会遮住上下边）：标题带与主体都必须落在这条线之内 */
export const COVER_SAFE_AREA = {
  /** 顶部留白下限（比例）：标题不得贴顶 */
  topMinRatio: 0.06,
  /** 标题带下限（比例）：主标题不得压到画面下半 */
  titleBottomMaxRatio: 0.42,
  /** 底部平台 UI 遮挡区（比例）：不放任何文字 */
  bottomReservedRatio: 0.12
};

export interface CoverDesignInput {
  title?: string;
  /** 成片真实时长（秒）：标题里写"XX 秒"时必须与它一致（容差 ±2s，真机 2026-09-25） */
  durationSeconds?: number;
  brief?: { platform?: string; audience?: string; goal?: string; tone?: string; coverHook?: string } | null;
  platform?: string;
  character?: { id?: string; name?: string } | null;
  shots: Array<{ shotId: string; scene?: string; dialogueText?: string; hasCharacter?: boolean; duration?: number }>;
  /** 自修复轮：上一版设计稿（原样回给设计师，让它针对错误改） */
  repairFrom?: string;
  /** 自修复轮：上一版被校验拦下的原因（逐条列出） */
  repairReason?: string;
}

/** 封面设计师的提示词（LLM 只出设计稿，不画图；渲染由管线按稿执行） */
export function buildCoverDesignPrompt(input: CoverDesignInput): string {
  const shotLines = input.shots.map((s) => `- ${s.shotId}：${String(s.scene ?? "").slice(0, 80)}`
    + `${s.hasCharacter ? "（人物镜，适合当人物封面底图）" : "（地标/空镜，适合当主视觉底图）"}`
    + `${s.dialogueText ? `｜台词：${s.dialogueText.slice(0, 40)}` : ""}`);
  return [
    "你是短视频封面设计师。请为下面这支片子出一份**可执行的封面设计稿**（只输出 JSON，不要解释、不要 markdown）。",
    "",
    `作品：${input.title ?? "未命名"}${Number.isFinite(input.durationSeconds) ? `（成片 ${Math.round(Number(input.durationSeconds))} 秒）` : ""}`,
    `平台：${input.platform ?? input.brief?.platform ?? "小红书"}（竖屏 9:16，平台 UI 会遮住画面底部约 12%，顶部约 6% 也不宜放字）`,
    input.character?.name ? `主角：${input.character.name}（有定妆照可做抠像人物层）` : "无人物",
    input.brief?.coverHook ? `封面钩子（brief 给的）：${input.brief.coverHook}` : "",
    input.brief?.goal ? `片子目标：${input.brief.goal}` : "",
    input.brief?.audience ? `受众：${input.brief.audience}` : "",
    input.brief?.tone ? `调性：${input.brief.tone}` : "",
    "",
    "可选镜头（主视觉必须从里面选，给出 shotId 与取帧秒数）：",
    ...shotLines,
    "",
    "设计要求（硬性）：",
    "1. 封面必须同时有【主视觉画面 + 人物（若片中有主角）+ 主标题（+ 可选副标题/角标）】，禁止只有一行标题；",
    "1.1 **底图必须是单张连续画面**（地标主体清晰可辨、占画面高度 ≥30%）：禁止把两个镜头横向拼接——"
      + "拼接会留下贯穿全宽的硬接缝，一眼能看出是合成残次品；",
    "1.2 人物用**肖像卡**（右下角、白细边、带投影，宽度占画幅 28%–50%）：人物来自片子自己的镜头帧，"
      + "不要试图把人抠出来贴在画面里（会掉脸、留光晕）；",
    "2. 主标题 ≤12 个字，说人话、有钩子，可以是地点+意象或一句邀请；必要时用 \\n 断成两行；"
      + `**若标题里要点出时长，必须写成"${Number.isFinite(input.durationSeconds) ? Math.round(Number(input.durationSeconds)) : "成片"} 秒"，不得用别的数字**；`,
    "3. 人物卡与主标题不得重叠；人物卡不要压住地标主体（塔身/飞檐/牌匾）；",
    "4. 文字全部落在上部 6%–42% 的标题带内，底部 12% 不放任何文字；",
    "5. 配色与片子的调性一致（说明主标题色与强调色，用 #RRGGBB）；底图保持片子原有的光线气质，不要加冷雾或滤镜把暖调画面改成另一种天气；",
    "6. rationale 用一句话说明这个封面为什么能让人点进来（≤60 字）。",
    `字库白名单（fontId 四选一，全部免费商用）：${Object.entries(COVER_FONTS).map(([id, f]) => `${id}=${f.label}（${f.note}）`).join("；")}`,
    "",
    "输出 JSON 结构：",
    "{\"headline\":\"...\",\"subline\":\"...\",\"badge\":\"...\",\"layout\":\"person-left|person-right\","
      + "\"background\":{\"shotId\":\"SC-0x\",\"atSec\":1.2,\"treatment\":\"grade|scrim\"},"
      + "\"person\":{\"enabled\":true,\"widthRatio\":0.42},"
      + "\"typography\":{\"fontId\":\"source-han-heavy\",\"headlineSizeRatio\":0.075,\"sublineSizeRatio\":0.036,\"color\":\"#FFFFFF\",\"accentColor\":\"#FFD166\",\"align\":\"left\"},"
      + "\"rationale\":\"...\"}",
    input.repairFrom
      ? `上一版设计稿被校验拦下，请**只改错的地方**重出一版（仍只输出 JSON）：\n错误：${input.repairReason ?? "未给出"}\n上一版：${input.repairFrom}`
      : ""
  ].filter((line) => line !== "").join("\n");
}

const HEX = /^#[0-9A-Fa-f]{6}$/;
const visualLength = (text: string): number => [...text.replace(/\n/g, "")].length;

/**
 * 设计稿校验：任何越界/超长/缺主角都判非法（抛错），由调用方决定"退回兜底稿"还是"打回重出"。
 * 口径从严：封面是唯一"必须一眼看懂"的产物，宁可用兜底稿也不要一张半成品。
 */
export function validateCoverPlan(plan: CoverPlan, input: CoverDesignInput = { shots: [] }): CoverPlan {
  const issues: string[] = [];
  if (!plan.headline?.trim()) issues.push("缺主标题");
  else if (visualLength(plan.headline) > 12) issues.push(`主标题 ${visualLength(plan.headline)} 字（上限 12）`);
  if (plan.headline.includes("\n") && plan.headline.split("\n").length > 2) issues.push("主标题超过两行");
  if (plan.subline && visualLength(plan.subline) > 24) issues.push(`副标题 ${visualLength(plan.subline)} 字（上限 24）`);
  if (plan.badge && visualLength(plan.badge) > 10) issues.push(`角标 ${visualLength(plan.badge)} 字（上限 10）`);
  if (!["person-left", "person-right"].includes(plan.layout)) issues.push(`版式 ${plan.layout} 不在可选范围`);
  if (!input.shots.some((s) => s.shotId === plan.background?.shotId)) issues.push(`主视觉镜头 ${plan.background?.shotId} 不在镜头表里`);
  if (!Number.isFinite(plan.background?.atSec) || plan.background.atSec < 0) issues.push("主视觉取帧时刻非法");
  if (plan.person?.enabled && input.character?.name && !plan.person.shotId) issues.push("人物卡开启但没有来源镜头（管线应注入 personShotId）");
  if (plan.person?.enabled && plan.person.shotId && !input.shots.some((s) => s.shotId === plan.person.shotId)) {
    issues.push(`人物卡来源镜头 ${plan.person.shotId} 不在镜头表里`);
  }
  if (!Number.isFinite(plan.person?.widthRatio) || plan.person.widthRatio < 0.28 || plan.person.widthRatio > 0.5) {
    issues.push(`人物卡宽度比例 ${plan.person?.widthRatio} 越界（0.28–0.50）`);
  }
  const head = Number(plan.typography?.headlineSizeRatio);
  if (!Number.isFinite(head) || head < 0.045 || head > 0.12) issues.push(`主标题字级 ${head} 越界（0.045–0.12）`);
  const sub = Number(plan.typography?.sublineSizeRatio);
  if (!Number.isFinite(sub) || sub < 0.022 || sub > 0.06) issues.push(`副标题字级 ${sub} 越界（0.022–0.06）`);
  if (!Object.prototype.hasOwnProperty.call(COVER_FONTS, String(plan.typography?.fontId ?? ""))) {
    issues.push(`字库 ${plan.typography?.fontId} 不在白名单（${Object.keys(COVER_FONTS).join(" / ")}）`);
  }
  if (!HEX.test(String(plan.typography?.color ?? ""))) issues.push(`主标题颜色 ${plan.typography?.color} 不是 #RRGGBB`);
  if (!HEX.test(String(plan.typography?.accentColor ?? ""))) issues.push(`强调色 ${plan.typography?.accentColor} 不是 #RRGGBB`);
  if (!plan.rationale?.trim()) issues.push("缺设计理由（rationale）");
  /**
   * 片长一致性（2026-09-25 真机）：标题/副标题里写了"48 秒"而成片其实是 51s，监制会判"与成片口径不符"。
   * `input.durationSeconds` 由管线给出真实片长；出现 秒 级数字时按 ±2s 容差校验。
   */
  const stated = `${plan.headline ?? ""} ${plan.subline ?? ""}`.match(/(\d{1,3})\s*秒/);
  if (stated && Number.isFinite(input.durationSeconds)) {
    const claimed = Number(stated[1]);
    if (Math.abs(claimed - Number(input.durationSeconds)) > 2) {
      issues.push(`标题里的时长 ${claimed} 秒与成片 ${Number(input.durationSeconds).toFixed(0)} 秒不符（容差 ±2s）`);
    }
  }
  if (issues.length > 0) {
    throw new CoverDesignError(`封面设计稿不合法：${issues.join("；")}`, "cover_design_invalid");
  }
  return plan;
}

/**
 * 解析设计师输出（容忍 ```json 包裹与前后解释），再走严格校验。
 *
 * `personShotId` 由**管线注入**而不是让设计师写路径：设计师只决定"要不要人物卡、放多宽"，
 * 素材从哪一镜取是工程事实（片子自己的镜头帧）。这样既避免模型编造路径，
 * 也保证"人物卡开启但没有来源"这类错误在管线侧被拦住。
 */
export function parseCoverPlan(raw: string, input: CoverDesignInput, options: { personShotId?: string; personAtSec?: number } = {}): CoverPlan {
  const stripped = raw.replace(/^```(?:json)?/m, "").replace(/```\s*$/m, "").trim();
  const tryParse = (text: string): CoverPlan | null => {
    try {
      return JSON.parse(text) as CoverPlan;
    } catch {
      return null;
    }
  };
  let parsed = tryParse(stripped);
  if (!parsed) {
    const start = stripped.indexOf("{");
    const end = stripped.lastIndexOf("}");
    if (start >= 0 && end > start) parsed = tryParse(stripped.slice(start, end + 1));
  }
  if (!parsed) throw new CoverDesignError(`封面设计稿不是合法 JSON：${raw.slice(0, 160)}`, "cover_design_not_json");
  const person = parsed.person ?? { enabled: false, widthRatio: 0.42 };
  const withPerson: CoverPlan = {
    ...parsed,
    person: {
      ...person,
      shotId: person.shotId ?? (person.enabled ? options.personShotId : undefined),
      atSec: person.atSec ?? (person.enabled ? options.personAtSec ?? 1.0 : undefined)
    },
    source: "llm"
  };
  return validateCoverPlan(withPerson, input);
}

/**
 * 确定性兜底稿：设计师不可用（无 LLM / JSON 反复非法）时**必须有稿**，
 * 但兜底稿也要满足"画面 + 人物 + 标题"三件套——这正是"只有标题"事故的反面。
 */
export function fallbackCoverPlan(
  input: CoverDesignInput,
  options: { headline: string; heroShotId: string; personShotId?: string; accentColor?: string }
): CoverPlan {
  const plan: CoverPlan = {
    headline: options.headline.slice(0, 12),
    subline: input.character?.name ? `${input.character.name}带你 30 秒看懂` : undefined,
    badge: undefined,
    layout: "person-right",
    background: { shotId: options.heroShotId, atSec: 1.2, treatment: "grade" },
    person: { enabled: Boolean(options.personShotId), shotId: options.personShotId, atSec: 1.0, widthRatio: 0.42 },
    typography: {
      fontId: "source-han-heavy",
      headlineSizeRatio: 0.075,
      sublineSizeRatio: 0.034,
      color: "#FFFFFF",
      accentColor: options.accentColor ?? "#FFD166",
      align: "left"
    },
    rationale: "兜底稿：主视觉地标 + 主角人物卡 + 大字标题，保证封面三件套齐全",
    source: "fallback"
  };
  return validateCoverPlan(plan, input);
}

/**
 * 封面渲染后的机检口径（确定性，脚本按此产出 `GateCheck[]`）。
 *
 * 关键三条：
 *   · `title-rendered`：带字版与无字版在标题带的 PSNR 必须显著下降（否则"标题其实没画上"）；
 *   · `person-layer`：带人物版与不带人物版在人物框的 PSNR 必须显著下降（否则人物层没合成进去）；
 *   · `clean-source`：底图帧必须取自**未烧字**的干净母版（否则封面自带字幕，与平台 UI 打架）。
 */
export interface CoverMeasurements {
  bytes: number;
  width: number;
  height: number;
  /** 标题带：带字版 vs 无字版 的 PSNR（dB）；越接近"未画字"越高 */
  titleBandPsnrDb: number | null;
  /** 人物框：有人物层 vs 无人物层 的 PSNR（dB） */
  personBoxPsnrDb: number | null;
  /** 底图是否与干净母版同帧一致（哈希/PSNR 双验） */
  backgroundMatchesCleanMaster: boolean;
  /** 标题文字的垂直范围（比例，0=画面顶） */
  titleTopRatio: number;
  titleBottomRatio: number;
  /** 底部平台 UI 遮挡区的"墨迹"比例（文字/高对比像素占比） */
  bottomBandInkRatio: number;
}

export interface CoverCheck {
  id: string;
  pass: boolean;
  detail: string;
  hard?: boolean;
}

/** 画面差异阈值：PSNR 低于该值说明两个版本"肉眼可见地不同" */
export const COVER_DIFF_PSNR_DB = 45;

export function coverDeterministicChecks(measure: CoverMeasurements): CoverCheck[] {
  const titleDrawn = measure.titleBandPsnrDb !== null && measure.titleBandPsnrDb < COVER_DIFF_PSNR_DB;
  const personDrawn = measure.personBoxPsnrDb !== null && measure.personBoxPsnrDb < COVER_DIFF_PSNR_DB;
  return [
    {
      id: "cover-produced",
      pass: measure.width === 1080 && measure.height === 1920 && measure.bytes > 120_000,
      detail: `${measure.width}x${measure.height} · ${(measure.bytes / 1024).toFixed(0)}KB（期望 1080x1920 且 >120KB）`,
      hard: true
    },
    {
      id: "title-rendered",
      pass: titleDrawn,
      detail: `标题带与"无字版"的差异 ${measure.titleBandPsnrDb === null ? "未测到" : `${measure.titleBandPsnrDb.toFixed(1)}dB`}`
        + `（< ${COVER_DIFF_PSNR_DB}dB 才算真的画了字）`,
      hard: true
    },
    {
      id: "person-layer",
      pass: personDrawn,
      detail: `人物框与"无人物版"的差异 ${measure.personBoxPsnrDb === null ? "未测到" : `${measure.personBoxPsnrDb.toFixed(1)}dB`}`
        + `（< ${COVER_DIFF_PSNR_DB}dB 才算人物层合成成功）`,
      hard: true
    },
    {
      id: "clean-source",
      pass: measure.backgroundMatchesCleanMaster,
      detail: measure.backgroundMatchesCleanMaster ? "底图取自未烧字幕的干净母版" : "底图来源不是干净母版（可能带字幕/旧版本）",
      hard: true
    },
    {
      id: "safe-area",
      /**
       * 容差 0.5%：标题带的实测值来自"墨迹包围盒 ÷ 画幅高"，而排版坐标是整数像素取整，
       * 6% 的边界很容易落成 0.0599（真机：115/1920）。用容差避免把"取整误差"判成"越界"。
       */
      pass: measure.titleTopRatio >= COVER_SAFE_AREA.topMinRatio - 0.005
        && measure.titleBottomRatio <= COVER_SAFE_AREA.titleBottomMaxRatio
        && measure.bottomBandInkRatio <= 0.02,
      detail: `标题带 ${(measure.titleTopRatio * 100).toFixed(1)}%–${(measure.titleBottomRatio * 100).toFixed(1)}%`
        + `（口径 ${(COVER_SAFE_AREA.topMinRatio * 100).toFixed(0)}%–${(COVER_SAFE_AREA.titleBottomMaxRatio * 100).toFixed(0)}%），`
        + `底部 ${(COVER_SAFE_AREA.bottomReservedRatio * 100).toFixed(0)}% 遮挡区墨迹 ${(measure.bottomBandInkRatio * 100).toFixed(2)}%（上限 2%）`,
      hard: true
    }
  ];
}

/** 封面监制口径（给 LLM 评审的 rubric）：只说可验证的事，避免"好看/高级"这类空话 */
export const COVER_REVIEW_RUBRIC = [
  "封面必须一眼看出这是什么地方/什么内容：主视觉里的地标或主体清晰可辨，不被文字与人物压住",
  "封面必须出现主角人物（若片中有主角）：人物与片中造型一致，不是路人脸、不是别的角色",
  "主标题完整可读：没有被裁切、没有压在人物脸上、没有与背景同色导致看不清；断行合理（不出现单字成行）",
  "封面不许出现平台 UI 残留、字幕条、进度条、水印或黑边",
  "整体观感与片子的调性一致：同一套配色与光线气质，不像另一支片子的封面"
];
