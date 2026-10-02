/**
 * questline.config · 「织伴 · 首席增长官」首日上岗内容包
 *
 * 引导人设 = 本产品既有的数字人 **织伴**（昵称小织；产品名是 WorkLoom 织元，两者不要混用，
 * 详见 docs/first-day-questline.md §3），岗位 = **首席增长官**。
 * 形象必须是系统内真实形象（`/live2d/mao/poster.png`），禁止手绘/自创替代品。
 *
 * 结构上刻意与行业包对齐：人设 / 员工卡 / 目标模板 / 首单任务卡 / 成就 / 价值口径 / 下一步。
 * 三套内容包（hotel / geo-growth / ai-video）的员工卡与首单卡引用的 presetKey 必须真实存在于
 * 对应 `bundles/<bundle>/presets/*.yml`，驳回原因必须命中该 Bundle 的反馈枚举表——
 * 两条都由 questline.test.ts 设门禁。
 *
 * 内容纪律：
 *  - 岗位、职责、航道（围栏）逐条对照行业包，不自造岗位、不编造围栏；
 *  - 文案讲的是本产品的真实闭环：获客五环（意图洞察 → 双域触达 → 四路承接 → 线索转化 → 归因复盘）
 *    与「您只做两件事：定方向、收钱」；
 *  - 任何"示例数字"必须带 `sample: true` 标注，界面按演示数据处理；
 *  - 台词每关至少 3 句（进场/等待/过关），单句控制在 42 字以内（"三句话汇报"节奏）。
 */
import type { VoiceProfile } from "../voice/VoiceEngine";
import { MATE_VOICE_PROFILE } from "../voice/mateVoice";
import type { QuestStageId } from "./questline";

export interface QuestScript {
  enter: string;
  hint: string;
  success: string;
}

export interface QuestStageDef {
  id: QuestStageId;
  badge: string;
  title: string;
  objective: string;
  primaryLabel: string;
  script: QuestScript;
}

export interface EmployeeCardDef {
  id: string;
  presetKey: string;
  title: string;
  duty: string;
  /** 航道许可（围栏）——直接引用行业包规则名 */
  fences: string[];
  tasks: string[];
  /** 示例产出（演示数据，界面必须标注） */
  sample: string;
  sampleIsDemo: boolean;
}

export interface GoalTemplateDef {
  id: string;
  title: string;
  metric: string;
  ownerPresetKey: string;
  ownerTitle: string;
  artifact: string;
  steps: number;
  approvals: number;
}

export interface TaskCardDef {
  id: string;
  title: string;
  ownerPresetKey: string;
  ownerTitle: string;
  steps: number;
  eta: string;
  artifact: string;
  approvals: number;
  credits: number;
  /** 派单时给数字员工的指令原文（走真实 threads.dispatch 通道） */
  dispatchTitle: string;
}

export interface AchievementDef {
  id: string;
  title: string;
  hint: string;
  icon: "rocket" | "team" | "tasks" | "approval" | "celebrate";
  /** 解锁来源关卡，便于 HUD 展示"在哪一关拿到" */
  stage: QuestStageId;
}

export interface ValueMetricDef {
  id: string;
  label: string;
  unit: string;
  /** 数据来源说明（禁止编数） */
  source: string;
}

export interface NextStepDef {
  id: "night_shift" | "real_data" | "customize";
  title: string;
  desc: string;
  to: string;
}

/**
 * 驳回原因（受控枚举）。必须来自当前 Bundle 装配的反馈枚举表
 * （`bundles/<industry>/feedback-enums.yml`，服务端会校验 code 是否登记）；
 * 未装配枚举表的行业包不校验 code，但标签仍须说人话。
 */
export interface RejectReasonDef {
  code: string;
  label: string;
}

export interface QuestlineConfig {
  journeyName: string;
  mateName: string;
  mateRole: string;
  ownerTitle: string;
  mateVoice: VoiceProfile;
  stages: QuestStageDef[];
  employees: EmployeeCardDef[];
  goals: GoalTemplateDef[];
  tasks: TaskCardDef[];
  achievements: AchievementDef[];
  values: ValueMetricDef[];
  nextSteps: NextStepDef[];
  rejectReasons: RejectReasonDef[];
}

/* ================= 跨行业共用件（机制与行业内容分离） ================= */

/**
 * 成就墙与关卡一一对应，语义与行业无关，因此三套内容包共用同一份定义。
 * 纪律：成就只由真实事实或客户操作解锁（见 questline.ts 的 unlockAchievements 调用点）。
 */
export const QUEST_ACHIEVEMENTS: AchievementDef[] = [
  { id: "aboard", title: "首航就绪", hint: "完成首次欢迎仪式", icon: "rocket", stage: "meet" },
  { id: "three-keepers", title: "三位当家人", hint: "认识获客班组的三位当家人", icon: "team", stage: "meet" },
  { id: "first-dispatch", title: "第一次派活", hint: "把第一件活交给数字员工", icon: "tasks", stage: "dispatch" },
  { id: "first-close", title: "首次闭环", hint: "首单产出被验收", icon: "celebrate", stage: "review" },
];

/** 价值计数口径：三项都标明数据来源，界面不得出现无出处的数字 */
export const QUEST_VALUES: ValueMetricDef[] = [
  { id: "auto-work", label: "已自主完成", unit: "项作业", source: "工作区事件账本（真实计数）" },
  { id: "on-duty", label: "团队在岗", unit: "人", source: "当前 Bundle 编制（真实计数）" },
];

/** 完成页的三个通用出口（页面路由与行业无关） */
export const QUEST_NEXT_STEPS: NextStepDef[] = [
  { id: "night_shift", title: "开启夜班", desc: "您睡觉的时候，他们接着干；明早 8:30 给您战报。", to: "/executive" },
  { id: "real_data", title: "接入真实数据与大模型", desc: "把演示数据换成您自己的经营数据与内容资产。", to: "/onboarding" },
  { id: "customize", title: "定制我的行业版", desc: "隔离编制 + 上岗考，换一批适合您业态的人。", to: "/onboarding?mode=customize" },
];

/**
 * 四关文案（产品级，不含行业私有词）。
 *
 * 讲的是本产品的真实闭环：获客五环（意图洞察 → 双域触达 → 四路承接 → 线索转化 → 归因复盘）
 * 与「您只做两件事：定方向、收钱」。三套行业内容包共用这段叙事，
 * 差异只落在员工卡 / 目标卡 / 任务卡 / 驳回枚举上。
 * 2026-09-21 产品所有者口径（本机单人运行）：基座通用审批环节已移除，原「拍板」关整关删除；
 * 业务链路自带的关卡（如视频管线 G1–G10、定妆照确认）由各自业务页面就地放行。
 */
export function genericStages(): QuestStageDef[] {
  return [
    {
      id: "meet",
      badge: "认人",
      title: "第 1 关 · 认识您的增长班组",
      objective: "知道谁在替您找人群、做内容、接询盘、算成交——以及他们什么时候必须来问您。",
      primaryLabel: "都认识了",
      script: {
        enter: "董事长，还是我织伴——在这个系统里我的岗位是首席增长官。三句话汇报：班组已上岗，获客五环今天就能转，但您得先认识几位当家人。",
        hint: "点一下卡片就算认识了。也可以换一批，或者先跳过。",
        success: "认全了。以后要人群、要内容、要询盘，直接找他们。",
      },
    },
    {
      id: "goal",
      badge: "定方向",
      title: "第 2 关 · 今天最想解决的一件事",
      objective: "给团队一个方向：要更多人看见、更多询盘，还是更快成交——谁负责、几步做完、什么时候来问您，我都写清楚。",
      primaryLabel: "就按这个来",
      script: {
        enter: "您只做两件事：定方向、收钱。先从定方向开始——选一个，或者直接跟我说一句。",
        hint: "三个选项都来自本行业包的真实管线，不是我编的；也可以直接说您自己的目标。",
        success: "收到。我把它拆成任务，派给该负责的岗位。",
      },
    },
    {
      id: "dispatch",
      badge: "派活",
      title: "第 3 关 · 把第一件活交出去",
      objective: "亲手派一单，看着它跑起来：拆解、执行、产出都走真实业务通道。",
      primaryLabel: "派给他",
      script: {
        enter: "光看不算数，得派一单试试。看中哪张卡，拖到人身上也行。",
        hint: "每张卡都写清了：谁做、几步、多久、产出什么；涉钱与外发动作由对应业务页面把关。",
        success: "活已经派出去了，进度我帮您盯着。",
      },
    },
    {
      id: "review",
      badge: "验收",
      title: "第 4 关 · 看看今天赚了什么",
      objective: "验收产出、看归因结果，再决定下一步往哪走。",
      primaryLabel: "我看到了",
      script: {
        enter: "活干完了。您花了几分钟，团队替您跑了这些事——归因链我念给您听。",
        hint: "没有回执的事我不会说「已完成」，这几项都是账本里查得到的。",
        success: "首日上岗完成。今晚夜班接着跑，明早 8:30 给您战报。",
      },
    },
  ];
}

/**
 * 织伴音色：与欢迎仪式共用 `voice/mateVoice.ts` 的同一档案。
 * 首日上岗里说话的就是织伴本人，不能出现"仪式一个女声、引导一个男声"的双角色错觉。
 */
export const MATE_GUIDE_VOICE: VoiceProfile = MATE_VOICE_PROFILE;

export const QUESTLINE: QuestlineConfig = {
  journeyName: "首日上岗",
  mateName: "织伴",
  mateRole: "首席增长官",
  ownerTitle: "董事长",
  mateVoice: MATE_GUIDE_VOICE,

  stages: genericStages(),

  /* 酒店获客（bundles/hotel）：员工卡取该包真实 preset 与真实围栏（R21/R24/R25/R3/R22/R26/R6/R23） */
  employees: [
    {
      id: "intake",
      presetKey: "ai-receptionist",
      title: "AI 接待员",
      duty: "四路承接（评论 / 私信 / 落地页 / AI 搜索锚点）7×24 首响，问清需求留下线索；报价承诺一定先问您。",
      fences: ["R21 · AI 接待报价承诺必审", "R24 · 客资隐私红线（明文不出系统）"],
      tasks: ["处理今日询盘", "核对首响时长", "整理待拍板方案"],
      sample: "今天 6 条询盘的处置记录 + 1 条待您拍板的报价方案",
      sampleIsDemo: true,
    },
    {
      id: "content",
      presetKey: "content-agent",
      title: "内容主笔官",
      duty: "把选题写成短视频脚本与 GEO 图文，一个选题两处变现；对外发布前先过口径校验。",
      fences: ["R25 · 获客内容口径校验", "R3 · 新渠道首次发布必审"],
      tasks: ["生成本周双域内容", "改写短视频脚本", "核对口径与引用源"],
      sample: "本周 5 条选题的双域版本 + 引用源清单",
      sampleIsDemo: true,
    },
    {
      id: "intel",
      presetKey: "channel-watcher",
      title: "渠道哨兵官",
      duty: "盯竞对评论区、OTA 差评与搜索词：先有人群意图，再有内容排期。",
      fences: ["只读巡检，不改任何渠道数据", "异常只推送与派单"],
      tasks: ["扫描今日意图信号", "查竞对价格与动作", "派单给内容/接待"],
      sample: "今晨 12 条意图信号 + 3 个值得跟的选题",
      sampleIsDemo: true,
    },
    {
      id: "coupon",
      presetKey: "coupon-operator",
      title: "团购运营官",
      duty: "把询盘变成券与订单：库存与定价红线自己守住，成交回写到每条内容的来源链上。",
      fences: ["R22 · 券库存熔断", "R26 · 券定价红线"],
      tasks: ["复核券转化数据", "生成归因复盘", "查异常订单"],
      sample: "上周归因成交额 + 三条高转化内容的来源链",
      sampleIsDemo: true,
    },
    {
      id: "retention",
      presetKey: "guest-success",
      title: "住客满意官",
      duty: "成交之后的复购与口碑：差评先起草回复，对外外发前请您过目。",
      fences: ["R6 · 差评必审", "R23 · 线索数据出域必审"],
      tasks: ["回复差评草稿", "维护老客复购", "复盘口碑走势"],
      sample: "今天 2 条差评的回复草稿 + 复购跟进清单",
      sampleIsDemo: true,
    },
  ],

  goals: [
    {
      id: "lead-24h",
      title: "询盘不过夜",
      metric: "私域询盘 30 秒首响率 100%",
      ownerPresetKey: "ai-receptionist",
      ownerTitle: "AI 接待员",
      artifact: "询盘处置记录（含待拍板方案）",
      steps: 3,
      approvals: 1,
    },
    {
      id: "dual-publish",
      title: "内容双域齐发",
      metric: "短视频与 GEO 图文同源发布，口径零违规",
      ownerPresetKey: "content-agent",
      ownerTitle: "内容主笔官",
      artifact: "双域内容排期 + 口径校验记录",
      steps: 4,
      approvals: 1,
    },
    {
      id: "attribution",
      title: "归因到钱",
      metric: "每条线索带来源链，成交可回写到内容",
      ownerPresetKey: "coupon-operator",
      ownerTitle: "团购运营官",
      artifact: "归因成交清单（含来源链）",
      steps: 3,
      approvals: 1,
    },
  ],

  tasks: [
    {
      id: "intake-clear",
      title: "处理今天的询盘与评论",
      ownerPresetKey: "ai-receptionist",
      ownerTitle: "AI 接待员",
      steps: 3,
      eta: "约 3 分钟",
      artifact: "询盘处置记录 + 需要您拍板的报价方案",
      approvals: 1,
      credits: 12,
      dispatchTitle: "处理今天各渠道的询盘与评论，输出处置记录与需要拍板的报价方案",
    },
    {
      id: "dual-content",
      title: "把本周选题做成双域内容",
      ownerPresetKey: "content-agent",
      ownerTitle: "内容主笔官",
      steps: 4,
      eta: "约 4 分钟",
      artifact: "短视频脚本 + GEO 图文 + 引用源清单",
      approvals: 1,
      credits: 24,
      dispatchTitle: "生成本周双域内容（短视频脚本与 GEO 图文），整理引用源与口径校验清单，发布前提请审批",
    },
    {
      id: "attribution-review",
      title: "复核本周归因复盘",
      ownerPresetKey: "coupon-operator",
      ownerTitle: "团购运营官",
      steps: 3,
      eta: "约 3 分钟",
      artifact: "归因成交清单 + 券转化数据",
      approvals: 1,
      credits: 18,
      dispatchTitle: "复核本周券转化与归因数据，输出归因成交清单与下一步建议，异常部分提请审批",
    },
  ],

  achievements: QUEST_ACHIEVEMENTS,

  values: QUEST_VALUES,

  nextSteps: QUEST_NEXT_STEPS,

  // 酒店包枚举表（bundles/hotel/feedback-enums.yml）：服务端会校验 code 已登记
  rejectReasons: [
    { code: "reply.tone", label: "回复语气不符" },
    { code: "reply.fact_wrong", label: "事实性错误（房态/政策/订单）" },
    { code: "amount.too_high", label: "金额过高" },
    { code: "data.stale", label: "数据陈旧/依据不足" },
    { code: "other", label: "其他（我补一句）" },
  ],
};

/* ================= GEO 获客内容包（geo-growth Bundle） ================= */

/**
 * GEO 双域获客内容包：员工卡只引用 `bundles/geo-growth/presets/*.yml` 里真实存在的岗位，
 * 围栏口径与 `geo-growth-baseline` 逐条对齐（G-GEO1/G-GEO2/G12/G9a/G10b…）。
 * 派单指令写的是「可交付的活」——必须能被意图路由判成 quest，否则首单没有产出可验收。
 */
export const QUESTLINE_GEO: QuestlineConfig = {
  journeyName: "首日上岗",
  mateName: "织伴",
  mateRole: "首席增长官",
  ownerTitle: "董事长",
  mateVoice: MATE_GUIDE_VOICE,

  stages: genericStages(),

  employees: [
    {
      id: "content",
      presetKey: "geo-content-planner",
      title: "GEO 内容策划",
      duty: "把选题写成 AI 搜索与短视频都能用的内容；对外发布一律先过审。",
      fences: ["G-GEO1 · 内容外发必审", "G-GEO2 · 事实红线一票否决"],
      tasks: ["生成本周双域内容", "整理引用源清单", "改写短视频脚本"],
      sample: "本周 5 条选题的双域版本 + 每条引用的来源链",
      sampleIsDemo: true,
    },
    {
      id: "ads",
      presetKey: "ads-optimizer",
      title: "投放优化师",
      duty: "盯投放成本与转化，给出加投/停投建议；加投必须您点头才执行。",
      fences: ["G12 · 投放加投必审", "G9b · 单账号日发布超限熔断"],
      tasks: ["复核今日加投建议", "核对投放成本", "排查停投异常"],
      sample: "两个渠道的加投建议 + ROI 与成本依据",
      sampleIsDemo: true,
    },
    {
      id: "attribution",
      presetKey: "review-analyst",
      title: "复盘分析师",
      duty: "把曝光、询盘、成交和内容对上账，回答哪条内容真的带来了生意。",
      fences: ["只读复盘，不改任何渠道数据"],
      tasks: ["生成本周归因复盘", "核对归因链", "查转化异常波动"],
      sample: "上周归因成交额 + 三条高转化内容的来源链",
      sampleIsDemo: true,
    },
    {
      id: "visibility",
      presetKey: "visibility-watcher",
      title: "AI 能见度监测官",
      duty: "盯品牌词在 AI 搜索里的引用与排名变化，掉榜先告警不猜测原因。",
      fences: ["只读监测，异常只推送与派单"],
      tasks: ["查看今日能见度", "核对引用源变化", "派单处理掉榜"],
      sample: "今晨品牌词引用数变化 + 新增/丢失的引用源",
      sampleIsDemo: true,
    },
    {
      id: "intake",
      presetKey: "private-domain-operator",
      title: "私域承接专员",
      duty: "接住评论、私信与落地页的询盘，30 秒首响；报价与承诺必过人审。",
      fences: ["G10b · 咨询/售后回复必审", "G-GEO1 · 对外内容外发必审"],
      tasks: ["处理今日询盘", "核对首响时长", "整理待拍板方案"],
      sample: "今日 6 条询盘的处置记录 + 1 条待拍板的报价方案",
      sampleIsDemo: true,
    },
  ],

  goals: [
    {
      id: "geo-visible",
      title: "AI 搜索里找得到",
      metric: "品牌词被 AI 回答引用的次数周环比上升",
      ownerPresetKey: "geo-content-planner",
      ownerTitle: "GEO 内容策划",
      artifact: "能见度周报（含引用源清单）",
      steps: 4,
      approvals: 1,
    },
    {
      id: "ads-safe",
      title: "投放不失控",
      metric: "加投全部经审，单账号日发布不超限",
      ownerPresetKey: "ads-optimizer",
      ownerTitle: "投放优化师",
      artifact: "加投审批清单（含 ROI 依据）",
      steps: 3,
      approvals: 1,
    },
    {
      id: "lead-fast",
      title: "询盘不过夜",
      metric: "私域询盘 30 秒首响率 100%",
      ownerPresetKey: "private-domain-operator",
      ownerTitle: "私域承接专员",
      artifact: "询盘处置记录",
      steps: 3,
      approvals: 1,
    },
  ],

  tasks: [
    {
      id: "geo-content",
      title: "把本周选题做成双域内容",
      ownerPresetKey: "geo-content-planner",
      ownerTitle: "GEO 内容策划",
      steps: 4,
      eta: "约 4 分钟",
      artifact: "短视频脚本 + GEO 图文 + 引用源清单",
      approvals: 1,
      credits: 24,
      dispatchTitle: "生成本周双域内容（短视频脚本与 GEO 图文），整理引用源清单，发布前提请审批",
    },
    {
      id: "ads-review",
      title: "复核今天的投放加投建议",
      ownerPresetKey: "ads-optimizer",
      ownerTitle: "投放优化师",
      steps: 3,
      eta: "约 3 分钟",
      artifact: "加投建议 + ROI 依据（加投部分提请审批）",
      approvals: 1,
      credits: 18,
      dispatchTitle: "复核今天的投放数据，整理加投建议与 ROI 依据，加投部分提请审批",
    },
    {
      id: "intake-clear",
      title: "处理今天的询盘与评论",
      ownerPresetKey: "private-domain-operator",
      ownerTitle: "私域承接专员",
      steps: 3,
      eta: "约 3 分钟",
      artifact: "询盘处置记录 + 需要拍板的话术方案",
      approvals: 1,
      credits: 12,
      dispatchTitle: "处理今天各渠道的询盘与评论，输出处置记录与需要拍板的话术方案",
    },
  ],

  achievements: QUEST_ACHIEVEMENTS,
  values: QUEST_VALUES,
  nextSteps: QUEST_NEXT_STEPS,

  // geo-growth 枚举表（bundles/geo-growth/feedback-enums.yml）里的 reject 适用码
  rejectReasons: [
    { code: "fact.risk", label: "事实红线风险" },
    { code: "geo.citation_missing", label: "引用源缺失或不可核验" },
    { code: "data.stale", label: "数据陈旧/依据不足" },
    { code: "other", label: "其他（我补一句）" },
  ],
};

/* ================= ai-video 内容包（ai-video Bundle） ================= */

export const QUESTLINE_VIDEO: QuestlineConfig = {
  journeyName: "首日上岗",
  mateName: "织伴",
  mateRole: "首席增长官",
  ownerTitle: "董事长",
  mateVoice: MATE_GUIDE_VOICE,

  stages: genericStages(),

  employees: [
    {
      id: "director",
      presetKey: "director",
      title: "总导演",
      duty: "把选题拆成剧本、分镜与镜头单，盯住整片节奏与验收。",
      fences: ["G8 · 渲染提交必审（烧算力）", "G11 · 预算超限自动暂停提交"],
      tasks: ["生成一集剧本与分镜", "验收成片镜头", "核对预算消耗"],
      sample: "一集 60 秒短剧的剧本 + 18 个镜头的分镜表",
      sampleIsDemo: true,
    },
    {
      id: "render",
      presetKey: "render-operator",
      title: "渲染师",
      duty: "按镜头单提交渲染；每一步都吃算力，所以提交前一定来问您。",
      fences: ["G8 · 渲染提交必审", "G11 · 单项目算力超预算暂停"],
      tasks: ["提交渲染批次", "检查渲染回执", "处理渲染失败重试"],
      sample: "昨晚 3 个批次的渲染回执 + 2 个失败镜头的重试方案",
      sampleIsDemo: true,
    },
    {
      id: "publish",
      presetKey: "publish-operator",
      title: "发布专员",
      duty: "把成片分发到各平台；公网发布与版权风险都由人审兜底。",
      fences: ["G9 · 公网发布必审", "G16 · 矩阵账号防关联"],
      tasks: ["排期多平台发布", "核对版权与授权", "回查发布结果"],
      sample: "本周 4 条的发布排期 + 版权核验结果",
      sampleIsDemo: true,
    },
    {
      id: "compliance",
      presetKey: "compliance-officer",
      title: "合规审核员",
      duty: "在成片出厂前检查事实、版权与平台规则，发现红线直接拦下。",
      fences: ["事实红线一票否决", "版权缺失不得发布"],
      tasks: ["审核待发布成片", "核对素材授权", "记录拦截原因"],
      sample: "本周拦截的 2 条风险片段 + 修改建议",
      sampleIsDemo: true,
    },
    {
      id: "metrics",
      presetKey: "metrics-watcher",
      title: "数据看板官",
      duty: "盯播放、完播与转化，把哪条内容真的赚钱讲清楚。",
      fences: ["只读统计，不改渠道数据"],
      tasks: ["查看今日看板", "生成周复盘数据", "查异常波动"],
      sample: "近 7 天完播与转化曲线 + 三条爆款归因",
      sampleIsDemo: true,
    },
  ],

  goals: [
    {
      id: "ship-episode",
      title: "本周交付一集成片",
      metric: "一集从剧本到成片走完，且每步有回执",
      ownerPresetKey: "director",
      ownerTitle: "总导演",
      artifact: "成片 + 镜头单 + 渲染回执",
      steps: 4,
      approvals: 2,
    },
    {
      id: "budget-safe",
      title: "算力不超预算",
      metric: "单项目算力消耗不越过预算上限",
      ownerPresetKey: "render-operator",
      ownerTitle: "渲染师",
      artifact: "算力消耗账单 + 超限暂停记录",
      steps: 3,
      approvals: 1,
    },
    {
      id: "publish-clean",
      title: "发布不出事",
      metric: "公网发布全部经审，版权与平台规则零违规",
      ownerPresetKey: "publish-operator",
      ownerTitle: "发布专员",
      artifact: "发布排期 + 版权核验记录",
      steps: 3,
      approvals: 1,
    },
  ],

  tasks: [
    {
      id: "script-episode",
      title: "把本周选题写成剧本与分镜",
      ownerPresetKey: "director",
      ownerTitle: "总导演",
      steps: 3,
      eta: "约 3 分钟",
      artifact: "剧本 + 分镜表（可直接开工）",
      approvals: 1,
      credits: 18,
      dispatchTitle: "生成本周选题的剧本与分镜表，整理镜头清单与预算预估，提交渲染前提请审批",
    },
    {
      id: "render-batch",
      title: "提交一批渲染并核对回执",
      ownerPresetKey: "render-operator",
      ownerTitle: "渲染师",
      steps: 3,
      eta: "约 4 分钟",
      artifact: "渲染回执 + 失败镜头重试方案",
      approvals: 1,
      credits: 24,
      dispatchTitle: "按镜头单提交渲染批次并核对回执，整理失败镜头的重试方案，超预算部分提请审批",
    },
    {
      id: "publish-plan",
      title: "排期发布并核验版权",
      ownerPresetKey: "publish-operator",
      ownerTitle: "发布专员",
      steps: 3,
      eta: "约 3 分钟",
      artifact: "发布排期 + 版权核验记录",
      approvals: 1,
      credits: 12,
      dispatchTitle: "整理本周多平台发布排期并核验版权与授权，公网发布前提交审批",
    },
  ],

  achievements: QUEST_ACHIEVEMENTS,
  values: QUEST_VALUES,
  nextSteps: QUEST_NEXT_STEPS,

  // ai-video 枚举表（bundles/ai-video/feedback-enums.yml）里的 reject 适用码
  rejectReasons: [
    { code: "fact.risk", label: "事实红线风险" },
    { code: "compliance.platform", label: "平台合规风险" },
    { code: "budget.over", label: "预算超支" },
    { code: "other", label: "其他（我补一句）" },
  ],
};

/**
 * Bundle → 内容包。找不到对应包时返回 null：宁可不显示引导，也不把别的行业的
 * 人设、岗位与围栏张冠李戴（GEO 工作区里出现酒店岗位就是这么来的）。
 */
export const QUESTLINE_PACKS: Readonly<Record<string, QuestlineConfig>> = Object.freeze({
  hotel: QUESTLINE,
  "geo-growth": QUESTLINE_GEO,
  "ai-video": QUESTLINE_VIDEO,
});

export function questlineForBundle(bundleId: string | null | undefined): QuestlineConfig | null {
  const id = (bundleId ?? "").trim();
  if (!id) return null;
  return QUESTLINE_PACKS[id] ?? null;
}

/** 关卡一与"三位当家人"成就只认内容包的前三张卡：组件里禁止再硬编码岗位 id */
export function coreCardIds(content: QuestlineConfig = QUESTLINE): string[] {
  return content.employees.slice(0, 3).map((card) => card.id);
}

export function stageDef(stage: QuestStageId, content: QuestlineConfig = QUESTLINE): QuestStageDef {
  const found = content.stages.find((item) => item.id === stage);
  if (found) return found;
  const first = content.stages[0];
  if (!first) throw new Error("questline 配置缺少关卡定义");
  return first;
}

export function employeeCardOf(presetKey: string, content: QuestlineConfig = QUESTLINE): EmployeeCardDef | null {
  return content.employees.find((item) => item.presetKey === presetKey) ?? null;
}
