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
 *
 * 2026-09-27 平台化 + 知识库注入（方案：视频封面链路强化）：
 *   · 平台规格（画幅/安全区/标题带/文案政策）改由 `cover-platforms.ts` 的 `getCoverSpec()` 驱动，
 *     **douyin 默认口径与历史行为逐字/逐像素不变**（`COVER_SAFE_AREA` 仍是抖音基线值）；
 *   · 新增 `kbHints`（封面知识库 cover-kb 的注入载荷，≤3 条，带篇目 trace）与
 *     `accountProfile`（账号视觉锤：字体/色板/版式/角标）两个**可选**输入，
 *     不传时提示词与校验行为与历史完全一致。
 */

import {
  getCoverSpec,
  headlineUnits,
  headlineLimitLabel,
  isEnglishCoverPlatform,
  ratioPercent,
  type CoverPlatformSpec
} from "./cover-platforms.js";

export type CoverLayout = "person-left" | "person-right";

/**
 * 账号定位档案（视觉锤）——`bundles/ai-video/library/account-profiles/<账号>.yml` 的落库形状。
 * 由管线读档后传入；**不传=账号无档案，行为与历史一致**（向后兼容）。
 * 字段口径锚 KB `ACCT-001`：字体/色板/版式/角标四件套 + 钩子偏好 + 禁区。
 */
export interface CoverAccountProfile {
  account_id: string;
  display_name?: string;
  /** 一句话定位（进 prompt，仅作设计参考） */
  positioning?: string;
  /** 账号类型：人设IP号 / 品牌官号 / 种草号 / 知识号 / 本地生活号（也接受 ip / brand / seeding / knowledge / local） */
  account_type?: string;
  /** 主发平台（封面按 `--cover-platform` 取规格，这里仅作注入上下文） */
  platforms?: string[];
  visual_hammer?: {
    /** 必须是 COVER_FONTS 白名单之一，否则忽略并在 warnings 里记明 */
    fontId?: string;
    /** [主标题色, 强调色]，#RRGGBB */
    palette?: string[];
    /** 版式偏好：person-led / subject-led */
    archetype_bias?: string | null;
    /** 系列角标（≤10 字） */
    badge_series?: string;
  } | null;
  /** 钩子偏好（HOOK-001 公式 ID：question/conflict/data-shock/contrast/value-preview/curiosity-gap/pattern-interrupt） */
  hook_bias?: string[];
  /** 账号级禁区（进 prompt 负面约束；命中即记 warning，strict=true 判非法） */
  taboo?: string[];
  /** true = 偏离视觉锤判非法打回；false/缺省 = warn 并记入设计稿 warnings */
  strict?: boolean;
}

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
  /**
   * 校验期的**非致命**告警（如偏离账号视觉锤但未开 strict）。
   * 落盘进设计稿与 stages.jsonl：告警必须留痕，不允许静默丢弃（"无回执不算完成"）。
   */
  warnings?: string[];
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

/**
 * 口播/讲解类片子的**下带文字**安全区（`--cover-hero person-solo`，2026-09-27 真机新增）。
 *
 * 为什么需要第二套：口播封面的人物是**居中的大头**，任何"上带标题"都会压在脸上
 * （真机一次投产后被产品所有者直接指出"标题压脸、排版乱"）。把整块文字下移到面部下方的
 * 安全带（58%–88%）即可从版式上消除这类重叠；下边 12% 仍留给平台 UI。
 */
export const COVER_LOWER_BAND_SAFE_AREA = {
  /** 下带文字上限（比例）：文字不得越过这条线（上方是面部区） */
  topMinRatio: 0.52,
  /** 下带文字下限（比例）：为平台 UI 保留 12% */
  titleBottomMaxRatio: 0.88,
  /** 底部平台 UI 遮挡区（比例）：不放任何文字 */
  bottomReservedRatio: 0.12
};

export interface CoverDesignInput {
  title?: string;
  /** 成片真实时长（秒）：标题里写"XX 秒"时必须与它一致（容差 ±2s，真机 2026-09-25） */
  durationSeconds?: number;
  /**
   * 封面版式（2026-09-26 产品所有者口径：**只有两种主视觉**）：
   *   · `person-led` 人物为主：人物占画面主体，背景（景物/商品）只作环境点缀；
   *   · `subject-led` 物体为主：景物/商品/动物等**非人主体**满幅为主视觉，画面里不再放人物小卡。
   * 禁止第三种"人物小图贴在地标/商品上"——两种主视觉打架，真机被打回三次。
   */
  archetype?: "person-led" | "subject-led";
  brief?: { platform?: string; audience?: string; goal?: string; tone?: string; coverHook?: string } | null;
  /**
   * 平台（ID 或中文别名，如 `douyin` / `抖音` / `抖音/快手`）。
   * 语义已升格为一等参数：驱动的画幅、安全区、标题带、标题字数上限与文案政策；
   * 缺省/未知值落 douyin（回归基线），因此旧调用行为不变。
   */
  platform?: string;
  character?: { id?: string; name?: string } | null;
  shots: Array<{ shotId: string; scene?: string; dialogueText?: string; hasCharacter?: boolean; duration?: number }>;
  /**
   * 封面知识库（cover-kb）注入载荷：**≤3 条**，每条自带篇目 trace（由 cover-kb-bridge enrich 产出）。
   * 不传 = 不注入知识（提示词与历史逐字一致）。
   */
  kbHints?: string[];
  /** 账号定位档案（视觉锤）；不传 = 账号无档案，行为与历史一致 */
  accountProfile?: CoverAccountProfile | null;
  /** 自修复轮：上一版设计稿（原样回给设计师，让它针对错误改） */
  repairFrom?: string;
  /** 自修复轮：上一版被校验拦下的原因（逐条列出） */
  repairReason?: string;
}

/**
 * 账号视觉锤/账号禁区的提示词行（只有传了档案才出现——不传时提示词与历史逐字一致）。
 * KB ACCT-001 口径：字体/色板/版式/角标四件套锁定，偏离 warn；strict=true 判非法。
 */
export function accountProfilePromptLines(profile: CoverAccountProfile | null | undefined): string[] {
  if (!profile) return [];
  const lines: string[] = [];
  const hammer = profile.visual_hammer ?? null;
  const bits: string[] = [];
  const fontId = hammer?.fontId && Object.prototype.hasOwnProperty.call(COVER_FONTS, hammer.fontId)
    ? hammer.fontId as CoverFontId
    : null;
  if (fontId) bits.push(`字体必须用 ${fontId}=${COVER_FONTS[fontId].label}`);
  const palette = Array.isArray(hammer?.palette) ? hammer!.palette.filter((c) => HEX.test(String(c))) : [];
  if (palette.length >= 1) bits.push(`主标题色 ${palette[0]}`);
  if (palette.length >= 2) bits.push(`强调色 ${palette[1]}`);
  if (hammer?.archetype_bias) bits.push(`版式偏好 ${hammer.archetype_bias}`);
  if (hammer?.badge_series) bits.push(`系列角标「${String(hammer.badge_series).slice(0, 10)}」`);
  const who = profile.display_name ? `${profile.display_name}（${profile.account_id}）` : profile.account_id;
  if (bits.length > 0) lines.push(`【账号视觉锤】${who}：${bits.join("；")}。同一账号的封面必须"长一个样"，不得偏离。`);
  /**
   * 优先级（2026-09-27 真机发现）：KB 注入里同时有"题材建议配色"与"账号视觉锤"时，
   * 监制会判"两套配色/字体互相冲突"。这里把优先级写进提示词：账号视觉锤 > 题材建议 > 平台通用建议，
   * 只有**平台规格**（画幅/安全区/标题上限）不可违背。
   */
  if (bits.length > 0) lines.push("【优先级】账号视觉锤 > 题材建议 > 平台通用建议；只有平台规格（画幅/安全区/标题上限）不可违背。");
  if (profile.positioning) lines.push(`【账号定位】${profile.positioning}`);
  if (Array.isArray(profile.taboo) && profile.taboo.length > 0) {
    lines.push(`【账号禁区】${profile.taboo.join("、")}——出现即视为不合格。`);
  }
  return lines;
}

/**
 * 封面设计师的提示词（LLM 只出设计稿，不画图；渲染由管线按稿执行）。
 *
 * 平台化口径（2026-09-27）：画幅/安全区/标题带/标题字数上限全部来自 `getCoverSpec(platform)`；
 * **douyin + 无 KB + 无账号档案时，本函数输出与平台化之前逐字一致**（有快照测试锁死）。
 */
export function buildCoverDesignPrompt(input: CoverDesignInput): string {
  /** 平台标签用**调用方原文**（保留"抖音/快手"这类历史写法），规格按 ID 解析 */
  const platformLabel = input.platform ?? input.brief?.platform ?? "小红书";
  const spec = getCoverSpec(platformLabel);
  const kbHints = (input.kbHints ?? [])
    .map((hint) => String(hint ?? "").trim())
    .filter(Boolean)
    .slice(0, 3)
    .map((hint) => (hint.startsWith("【") ? hint : `【封面知识库】${hint}`));
  const accountLines = accountProfilePromptLines(input.accountProfile);
  const shotLines = input.shots.map((s) => `- ${s.shotId}：${String(s.scene ?? "").slice(0, 80)}`
    + `${s.hasCharacter ? "（人物镜，适合当人物封面底图）" : "（地标/空镜，适合当主视觉底图）"}`
    + `${s.dialogueText ? `｜台词：${s.dialogueText.slice(0, 40)}` : ""}`);
  return [
    "你是短视频封面设计师。请为下面这支片子出一份**可执行的封面设计稿**（只输出 JSON，不要解释、不要 markdown）。",
    "",
    `作品：${input.title ?? "未命名"}${Number.isFinite(input.durationSeconds) ? `（成片 ${Math.round(Number(input.durationSeconds))} 秒）` : ""}`,
    `平台：${platformLabel}（${spec.orientation === "horizontal" ? "横版" : "竖屏"} ${spec.ratio}，`
      + `平台 UI 会遮住画面底部约 ${ratioPercent(spec.safeArea.bottomReservedRatio)}，`
      + `顶部约 ${ratioPercent(spec.safeArea.topMinRatio)} 也不宜放字）`,
    ...accountLines,
    ...kbHints,
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
    /**
     * 版式先于一切（2026-09-26 产品所有者口径）：
     * 早先的提示词写死"必须有人物肖像卡"，于是所有封面都变成"人物小图贴在地标上"——
     * 两种主视觉互相打架，既不像人物封面也不像景物封面。现在只有两种合法版式。
     */
    `0. **版式（archetype）二选一，必须与本片指定一致**：本片指定 \`${input.archetype ?? "subject-led"}\`。`,
    "   0.1 `person-led`（人物为主）：人物是唯一主视觉，占画面高 ≥55%，背景只作环境点缀（可虚化、可只留地标轮廓）；标题压在留白处；画面里**不得**再放第二个人物小图。",
    "   0.2 `subject-led`（物体为主）：景物/商品/动物等非人主体满幅为主视觉（占画面高 ≥35%），"
      + "画面里**不得**出现人物小卡、人物竖带或任何人物拼贴；标题压在留白处；"
      + "**人物在成图中缺席不是缺陷，是本版式的设计选择**。",
    "   0.3 禁止第三种版式：把人物小图/竖带贴到景物或商品上（两种主视觉打架）。真机口径：这种封面被打回三次。",
    "1. 封面必须同时有【主视觉画面 + 主标题（+ 可选副标题/角标）】，禁止只有一行标题；人物只在 `person-led` 版式里出现；",
    "1.1 **底图必须是单张连续画面**（主体清晰可辨、占画面高度 ≥30%）：禁止把两个镜头横向拼接——"
      + "拼接会留下贯穿全宽的硬接缝，一眼能看出是合成残次品；",
    "1.2 `person-led` 版式的人物取自**片子自己的镜头帧**（不做抠像贴图，会掉脸留光晕）；"
      + "`subject-led` 版式的主体取自片子里的地标/商品/动物镜头帧；",
    `2. 主标题 ${headlineLimitLabel(spec)}，说人话、有钩子，可以是地点+意象或一句邀请；必要时用 \\n 断成两行；`
      + `**若标题里要点出时长，必须写成"${Number.isFinite(input.durationSeconds) ? Math.round(Number(input.durationSeconds)) : "成片"} 秒"，不得用别的数字**；`,
    "3. 人物卡与主标题不得重叠；人物卡不要压住地标主体（塔身/飞檐/牌匾）；",
    `4. 文字全部落在上部 ${ratioPercent(spec.titleBand.topRatio)}–${ratioPercent(spec.titleBand.bottomMaxRatio)} 的标题带内，`
      + `底部 ${ratioPercent(spec.safeArea.bottomReservedRatio)} 不放任何文字；`,
    "5. 配色与片子的调性一致（说明主标题色与强调色，用 #RRGGBB）；底图保持片子原有的光线气质，不要加冷雾或滤镜把暖调画面改成另一种天气；",
    "6. rationale 用一句话说明这个封面为什么能让人点进来（≤60 字）。",
    /**
     * 数值边界（2026-09-27 真机发现）：这些区间由 `validateCoverPlan` 硬校验，
     * 但早先提示词里没写——真实模型因此把 `person.widthRatio` 猜成 0.55，设计稿连打两次回、退兜底稿
     * （真机证据：DeepSeek 出稿 person.widthRatio=0.55 → `人物卡宽度比例 0.55 越界（0.28–0.50）`）。
     * 把边界写给设计师，是"降低无效往返"的确定性改进，不改变任何既有判据。
     */
    "7. 数值边界（越界即判非法、直接打回重出）：`person.widthRatio` 0.28–0.50；"
      + "`typography.headlineSizeRatio` 0.045–0.12；`typography.sublineSizeRatio` 0.022–0.06；"
      + "副标题 ≤24 字、角标 ≤10 字。",
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
  /**
   * 平台口径（2026-09-27）：标题长度上限随平台（抖音 12 / 小红书 14 / B站 16 / 英文平台按词 ≤5）。
   * `domain="cover_design_invalid"` 的既有错误语义不变；缺省平台落 douyin，旧调用行为不变。
   */
  const spec = getCoverSpec(input.platform);
  const warnings: string[] = [];
  /**
   * 版式一致性（2026-09-26 产品所有者口径）：
   *   `subject-led`（物体为主）不允许再挂人物层——人物小卡/竖带会与主视觉打架；
   *   `person-led`（人物为主）必须开启人物层并给出人物来源镜头。
   * 这条同时约束渲染侧与监制侧：监制按 archetype 判，不再对物体版式要求"主角必须在场"。
   */
  /** 只有**显式指定**版式时才做一致性校验：旧调用/旧用例没传 archetype，保持既有行为（人物卡照旧可选） */
  const archetype = input.archetype;
  if (archetype === "subject-led" && plan.person?.enabled) {
    issues.push("物体为主版式（subject-led）里不允许开启人物层（人物小卡/竖带会与主视觉打架）");
  }
  if (archetype === "person-led" && plan.person && plan.person.enabled === false) {
    issues.push("人物为主版式（person-led）必须开启人物层并提供人物来源镜头");
  }
  if (!plan.headline?.trim()) issues.push("缺主标题");
  else if (isEnglishCoverPlatform(spec)) {
    const words = headlineUnits(plan.headline, spec);
    if (words > spec.headlineMaxChars) {
      issues.push(`主标题 ${words} 个英文单词（${spec.id} 上限 ${spec.headlineMaxChars} 词）`);
    }
  } else if (visualLength(plan.headline) > spec.headlineMaxChars) {
    issues.push(`主标题 ${visualLength(plan.headline)} 字（${spec.id} 上限 ${spec.headlineMaxChars}）`);
  }
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
   *
   * 2026-09-27 真机修正：原实现把**任何**「X 秒」都当片长声明，于是设计师写的
   * `四支团队 · 78 个岗位 · 30 秒首响`（"30 秒首响"是产品指标，不是片子长度）被判
   * 「标题里的时长 30 秒与成片 89 秒不符」→ 设计稿连打两次回、退兜底稿、封面被拒、
   * 片头无封面。现在只认**指向片子本身的表述**：
   *   · `N 秒 + 看懂/看完/了解/速览/讲清/说清/读懂/带你/全片/内讲完`；
   *   · 或 `全片/本片/本视频 … N 秒`。
   */
  const stated = `${plan.headline ?? ""} ${plan.subline ?? ""}`.match(/(\d{1,3})\s*秒\s*(?:看懂|看完|了解|速览|讲清|说清|读懂|带你|全片|内讲完)/)
    ?? `${plan.headline ?? ""} ${plan.subline ?? ""}`.match(/(?:全片|本片|本视频)[^0-9]{0,6}(\d{1,3})\s*秒/);
  if (stated && Number.isFinite(input.durationSeconds)) {
    const claimed = Number(stated[1]);
    if (Math.abs(claimed - Number(input.durationSeconds)) > 2) {
      issues.push(`标题里的时长 ${claimed} 秒与成片 ${Number(input.durationSeconds).toFixed(0)} 秒不符（容差 ±2s）`);
    }
  }
  /**
   * 账号视觉锤一致性（KB ACCT-001 四件套）：
   * 默认只 warn（记进设计稿 warnings 与 stages.jsonl）；`accountProfile.strict=true` 判非法打回。
   * 无档案 = 不校验（向后兼容）。
   */
  const hammer = input.accountProfile?.visual_hammer ?? null;
  if (input.accountProfile) {
    const strict = input.accountProfile.strict === true;
    const push = (message: string): void => { if (strict) issues.push(message); else warnings.push(message); };
    if (hammer?.fontId) {
      if (!Object.prototype.hasOwnProperty.call(COVER_FONTS, hammer.fontId)) {
        warnings.push(`账号档案字体 ${hammer.fontId} 不在字库白名单（已忽略该约束）`);
      } else if (plan.typography?.fontId !== hammer.fontId) {
        push(`字体 ${plan.typography?.fontId} 偏离账号视觉锤（${hammer.fontId}）`);
      }
    }
    const palette = Array.isArray(hammer?.palette) ? hammer!.palette.filter((c) => HEX.test(String(c))) : [];
    if (palette.length > 0) {
      const used = [String(plan.typography?.color ?? "").toUpperCase(), String(plan.typography?.accentColor ?? "").toUpperCase()];
      const allowed = palette.map((c) => c.toUpperCase());
      if (!used.some((color) => allowed.includes(color))) {
        push(`主标题色/强调色 ${used.join(" / ")} 均不在账号色板（${allowed.join(" / ")}）内`);
      }
    }
    if (hammer?.archetype_bias && input.archetype && hammer.archetype_bias !== input.archetype) {
      /** 版式由片子的主视觉决定（`--cover-hero`），账号偏好只提示不拦截——避免把"这条片子是风景"硬掰成人设 */
      warnings.push(`版式 ${input.archetype} 与账号档案偏好 ${hammer.archetype_bias} 不同（版式以片子主视觉为准）`);
    }
    if (Array.isArray(input.accountProfile.taboo) && input.accountProfile.taboo.length > 0) {
      const text = [plan.headline, plan.subline, plan.badge].filter(Boolean).join(" ");
      const hits = input.accountProfile.taboo.filter((word) => word && text.includes(String(word)));
      if (hits.length > 0) push(`文案命中账号禁区：${hits.join("、")}`);
    }
  }
  if (issues.length > 0) {
    throw new CoverDesignError(`封面设计稿不合法：${issues.join("；")}`, "cover_design_invalid");
  }
  return warnings.length > 0 ? { ...plan, warnings: [...(plan.warnings ?? []), ...warnings] } : plan;
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
  const spec = getCoverSpec(input.platform);
  /**
   * 兜底稿的副标题**必须使用成片真实时长**（2026-09-27 真机）：
   * 早先这里写死 "30 秒"，而 `validateCoverPlan` 会核对"标题里的时长 vs 成片时长（±2s）"——
   * 一条 89 秒的片子走到兜底路径时直接抛 `封面设计稿不合法：标题里的时长 30 秒与成片 89 秒不符`，
   * 整个封面环节崩掉。现在按 durationSeconds 生成；时长未知时不提秒数。
   */
  const seconds = Number(input.durationSeconds ?? 0);
  const durationText = Number.isFinite(seconds) && seconds >= 1 ? `${Math.round(seconds)} 秒` : "";
  /**
   * 兜底标题清洗（2026-09-27 真机）：标题来自 `--cover-hook`（默认取片名），
   * 片名常带"· 副标题"结构，按 12 字硬截会留下尾随的「·」。这里先取 `·` 前的主标题再去尾标点。
   */
  const rawHeadline = String(options.headline ?? "").split(/[·|｜]/)[0] ?? "";
  /**
   * 平台化（2026-09-27）：中文平台按平台字数上限截断（抖音 12 / 小红书 14 / B站 16）；
   * 英文平台按**词数**截断并全大写（KB PLAT-006：英文封面全大写 + ≤5 词）。
   */
  const headline = isEnglishCoverPlatform(spec)
    ? (rawHeadline.trim().split(/\s+/).filter(Boolean).slice(0, spec.headlineMaxChars).join(" ").toUpperCase() || "COVER")
    : (rawHeadline.replace(/[\s·・,，。.、;；:：]+$/u, "").slice(0, spec.headlineMaxChars) || "封面");
  /** 账号档案（若有）锁定字体与色板：兜底稿也必须与账号视觉锤一致 */
  const hammer = input.accountProfile?.visual_hammer ?? null;
  const hammerFont = hammer?.fontId && Object.prototype.hasOwnProperty.call(COVER_FONTS, hammer.fontId)
    ? hammer.fontId as CoverFontId
    : null;
  const hammerPalette = Array.isArray(hammer?.palette) ? hammer!.palette.filter((c) => HEX.test(String(c))) : [];
  const sublineFallback = input.character?.name
    ? (isEnglishCoverPlatform(spec)
      ? (durationText ? `${input.character.name} · ${Math.round(seconds)}s` : input.character.name)
      : (durationText ? `${input.character.name}带你 ${durationText}看懂` : `${input.character.name}带你一次看懂`))
    : undefined;
  const plan: CoverPlan = {
    headline,
    subline: sublineFallback,
    badge: undefined,
    layout: "person-right",
    background: { shotId: options.heroShotId, atSec: 1.2, treatment: "grade" },
    person: { enabled: Boolean(options.personShotId), shotId: options.personShotId, atSec: 1.0, widthRatio: 0.42 },
    typography: {
      fontId: hammerFont ?? "source-han-heavy",
      headlineSizeRatio: 0.075,
      sublineSizeRatio: 0.034,
      color: hammerPalette[0] ?? "#FFFFFF",
      accentColor: hammerPalette[1] ?? options.accentColor ?? "#FFD166",
      align: "left"
    },
    rationale: isEnglishCoverPlatform(spec)
      ? `Fallback plan (${spec.id}): single continuous hero frame + headline, three-piece cover kept complete`
      : "兜底稿：主视觉地标 + 主角人物卡 + 大字标题，保证封面三件套齐全",
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

/**
 * 机检口径来源（三选一，向后兼容）：
 *   · 平台 ID / 规格对象 → 画幅与安全区都按平台（平台化路径）；
 *   · 安全区对象（旧签名）→ 画幅仍取抖音基线（旧调用零改动）；
 *   · 缺省 → 抖音基线。
 */
export type CoverCheckSafeArea = { topMinRatio: number; titleBottomMaxRatio: number; bottomReservedRatio: number };

export function resolveCoverCheckTarget(
  target?: string | CoverPlatformSpec | CoverCheckSafeArea | null
): { canvas: { width: number; height: number }; safeArea: CoverCheckSafeArea; platformId: string } {
  if (typeof target === "string") {
    const spec = getCoverSpec(target);
    return {
      canvas: spec.canvas,
      platformId: spec.id,
      safeArea: {
        topMinRatio: spec.safeArea.topMinRatio,
        titleBottomMaxRatio: spec.titleBand.bottomMaxRatio,
        bottomReservedRatio: spec.safeArea.bottomReservedRatio
      }
    };
  }
  if (target && typeof target === "object" && "safeArea" in target && "canvas" in target) {
    const spec = target as CoverPlatformSpec;
    return {
      canvas: spec.canvas,
      platformId: spec.id,
      safeArea: {
        topMinRatio: spec.safeArea.topMinRatio,
        titleBottomMaxRatio: spec.titleBand.bottomMaxRatio,
        bottomReservedRatio: spec.safeArea.bottomReservedRatio
      }
    };
  }
  const douyin = getCoverSpec("douyin");
  const legacy = (target as CoverCheckSafeArea | null | undefined) ?? null;
  return {
    canvas: douyin.canvas,
    platformId: douyin.id,
    safeArea: legacy ?? {
      topMinRatio: douyin.safeArea.topMinRatio,
      titleBottomMaxRatio: douyin.titleBand.bottomMaxRatio,
      bottomReservedRatio: douyin.safeArea.bottomReservedRatio
    }
  };
}

export function coverDeterministicChecks(
  measure: CoverMeasurements,
  target?: string | CoverPlatformSpec | CoverCheckSafeArea | null
): CoverCheck[] {
  const { canvas, safeArea, platformId } = resolveCoverCheckTarget(target);
  const titleDrawn = measure.titleBandPsnrDb !== null && measure.titleBandPsnrDb < COVER_DIFF_PSNR_DB;
  const personDrawn = measure.personBoxPsnrDb !== null && measure.personBoxPsnrDb < COVER_DIFF_PSNR_DB;
  return [
    {
      id: "cover-produced",
      pass: measure.width === canvas.width && measure.height === canvas.height && measure.bytes > 120_000,
      detail: `${measure.width}x${measure.height} · ${(measure.bytes / 1024).toFixed(0)}KB`
        + `（期望 ${canvas.width}x${canvas.height} 且 >120KB｜平台 ${platformId}）`,
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
       *
       * `safeArea` 允许调用方按版式传入（口播下带文字用 COVER_LOWER_BAND_SAFE_AREA）。
       */
      pass: measure.titleTopRatio >= safeArea.topMinRatio - 0.005
        && measure.titleBottomRatio <= safeArea.titleBottomMaxRatio
        && measure.bottomBandInkRatio <= 0.02,
      detail: `标题带 ${(measure.titleTopRatio * 100).toFixed(1)}%–${(measure.titleBottomRatio * 100).toFixed(1)}%`
        + `（口径 ${(safeArea.topMinRatio * 100).toFixed(0)}%–${(safeArea.titleBottomMaxRatio * 100).toFixed(0)}%），`
        + `底部 ${(safeArea.bottomReservedRatio * 100).toFixed(0)}% 遮挡区墨迹 ${(measure.bottomBandInkRatio * 100).toFixed(2)}%（上限 2%）`,
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

/**
 * 封面"夜景一致性"意图判定（T-2026-0926-0121 真机缺陷修复）。
 *
 * 背景：封面底图要与标题文案同调——文案写"江与夜"，底图却是阴天日景，监制会判"图文不符"打回；
 * 管线因此加了一条"标题含夜景字眼 → 底图必须是夜景镜"的一致性校正。
 *
 * 事故（VID-GR01）：校正用的是**过宽的字表** `/夜|灯|亮/`，而设计稿理由里写的是"五环**点亮**"，
 * 于是被误判成夜景意图，把设计稿本来选好的"灯环中庭"底图强行换成唯一符合夜景条件的
 * 人物近景（画面里双手交叠），封面因此被监制判"肢体畸变"打回。
 *
 * 口径：夜景意图只认**无歧义的夜色词**；"灯/亮"这类词在"点亮/亮起/亮点"等比喻语境里太常见，
 * 不再单独作为触发条件（镜头侧 `isNightShot` 已经是同一口径，这里把文案侧对齐）。
 */
export function coverPrefersNightBackground(planText: string): boolean {
  return /夜色|夜景|夜晚|夜间|深夜|夜幕|灯火|灯海|灯光秀|霓虹/.test(String(planText ?? ""));
}
