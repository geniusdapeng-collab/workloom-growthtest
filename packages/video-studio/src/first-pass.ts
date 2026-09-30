/**
 * first-pass —— "一次过就绪度"评估（T-2026-0929-0009）
 *
 * 目标（产品所有者 2026-09-29）：**别再用盲重试烧额度**。把"渲完才发现"的返修，
 * 前移成"花钱前就能判"的就绪度结论：卡片里如果写了模型控不住的东西，就先改卡、别提交。
 *
 * 真机归因（2026-09-29 出镜人物 片，全部真实返修）：
 *   ① 让模型"不要渲染文字"（机器屏幕界面/LOGO、身份证字样号码）→ 天生低合格率；正确做法是把风险物移出画面
 *   ② 合同锁了 6 秒内的精确时点（2.5s 必须定住）却又要"缓推" → 模型做不到，监制必打回
 *   ③ 服装细节锁到面料与配饰（粗花呢/金扣/及膝裙）＋"全片不换装" → 一次成功率低
 *   ④ 广角全景 + 人物视觉主导 + 产品可辨 三个诉求塞进同一镜 → 互相打架
 *   ⑤ 盲重试（卡片没变就重渲）→ 同一注押两次
 *   ⑥ 渲染顺序按镜号 → 最险的镜头没先渲，前面的钱白花
 * 本模块只做**确定性文本判定**（零 token、可复算、可考试），产出高/中/低风险项与"改卡建议"。
 */
export const FIRST_PASS_POLICY_VERSION = "workloom.first-pass-readiness/v1" as const;

export type RiskLevel = "high" | "medium" | "low";
export interface FirstPassFinding {
  id: string;
  level: RiskLevel;
  detail: string;
  suggestion: string;
}
export interface FirstPassReadiness {
  policy: typeof FIRST_PASS_POLICY_VERSION;
  score: number;
  ready: boolean;
  findings: FirstPassFinding[];
  blockers: FirstPassFinding[];
  suggestions: string[];
}

export interface FirstPassShot {
  shotId?: string;
  scene?: unknown; sceneDescription?: unknown; composition?: unknown; action?: unknown; props?: unknown;
  costume?: unknown; character?: unknown; camera_movement?: unknown; timeline?: unknown; constraint?: unknown;
  negative?: unknown; policyTags?: unknown;
  [key: string]: unknown;
}

const str = (value: unknown): string => String(value ?? "");
const joined = (shot: FirstPassShot, keys: string[]): string => keys.map((key) => str(shot[key])).join("；");
/** 只保留肯定描述（剥掉"不出现/不可见/无…"的否定语境，与仓库其它审计同纪律） */
const positive = (value: string): string => value.split(/[；。，、]/).filter((c) => c.trim() && !/(不出现|不可见|不露|不得|禁止|避免|没有|无[^，。；]*)/.test(c)).join("；");

export function assessShotFirstPass(shot: FirstPassShot, options: { fps?: number } = {}): FirstPassReadiness {
  const visual = positive(joined(shot, ["scene", "sceneDescription", "composition", "action", "props"]));
  const full = joined(shot, ["scene", "sceneDescription", "composition", "action", "props", "timeline", "camera_movement", "costume", "character"]);
  const camera = str(shot.camera_movement);
  const timeline = str(shot.timeline);
  const costume = str(shot.costume);
  const negative = str(shot.negative);
  const findings: FirstPassFinding[] = [];
  const add = (id: string, level: RiskLevel, detail: string, suggestion: string): void => { findings.push({ id, level, detail, suggestion }); };

  // ① 画面里的文字风险物（屏幕/证件/单据/名牌/菜单/报纸/路牌）
  const textRisk = [
    { id: "screen", pattern: /屏幕|触控|显示|界面/, what: "机器屏幕/界面" },
    { id: "document", pattern: /证件|身份证|护照|单据|票据|合同|菜单|报纸|票据/, what: "证件/单据类道具" },
    { id: "signage", pattern: /招牌|门牌|铭牌|价目|指示牌/, what: "带文字的标识物" }
  ].filter((entry) => entry.pattern.test(visual));
  for (const entry of textRisk) {
    const mitigated = /虚化|不可辨|背对|不入画|背面朝上|不出现/.test(full);
    if (!mitigated) {
      add(`text-in-frame:${entry.id}`, "high",
        `画面里出现${entry.what}，但没有把它移出画面/虚化`,
        `把${entry.what}移出取景（换机位/背对镜头），而不是指望模型"别写字"——这是本片返修的头号原因`);
    } else {
      add(`text-in-frame-mitigated:${entry.id}`, "low", `已声明${entry.what}的处理方式（虚化/背对/不入画）`, "保持现状");
    }
  }
  // ② 秒级时点锁定 vs 运动冲突
  if (/定住|稳住|定格/.test(timeline) && /推|拉|移|摇|环绕|升降/.test(camera)) {
    add("timing-lock-vs-motion", "high",
      `时间轴锁了"定住"时点，运镜又是推/拉/移 → 模型几乎必然落幅漂移`,
      `二选一：改成"固定机位（全程不推不拉）"，或删掉秒级时点锁定`);
  }
  if (/定住|稳住/.test(timeline) && /固定机位/.test(camera) && !/呼吸|微动/.test(camera)) {
    add("static-motion-floor", "medium",
      `固定机位 + 无任何自然运动声明 → 运动能量可能掉到噪声级，被判"接近静态直出"`,
      `固定机位也要给自然运动（云/水/光变化、轻微手持呼吸）`);
  }
  // ③ 服装/配饰细节锁定
  const costumeLocks = /粗花呢|金扣|金色纽扣|珍珠|及膝|高定|礼服/.test(costume);
  if (costumeLocks) {
    add("costume-over-specified", "medium",
      `服装锁到面料/配饰级（粗花呢/金扣/珍珠/及膝裙）→ 一次成功率低（真机已出现西装长裤版）`,
      `只锁"主色 + 正式商务套装"这类可稳定复现的类别；面料与配饰细节留给角色档案`);
  }
  const noChange = /全片不换装|不换装|不换发型/.test(full);
  if (noChange && !/角色档案|定妆照/.test(full)) {
    add("wardrobe-lock-without-anchor", "low", `写了"全片不换装"，但没引用角色档案作为唯一锚`, `把造型锚点写成"以角色档案 w1 为准"`);
  }
  // ④ 同镜塞多个互相打架的诉求
  const wantsWide = /全景|广角|大场面/.test(visual);
  const wantsPersonDominant = /视觉主导|中近景占比|主角居/.test(visual);
  const wantsProductClear = /机身|产品|机器/.test(visual) && /清晰可辨|材质工艺|可辨/.test(visual);
  const conflicts = [wantsWide && wantsPersonDominant, wantsPersonDominant && wantsProductClear].filter(Boolean).length;
  if (conflicts >= 1) {
    add("competing-subjects", "medium",
      `${[wantsWide ? "广角全景" : "", wantsPersonDominant ? "人物视觉主导" : "", wantsProductClear ? "产品细节可辨" : ""].filter(Boolean).join(" + ")} 塞在同一镜 → 监制必然在"构图/主导/可辨"里挑一条打回`,
      `拆镜：人物镜（人为主体）与产品镜（机器为主体）分开；或明确"本镜只保 XX"`);
  }
  // ⑤ 帧率一致性
  const fpsInCard = str(shot.constraint).match(/(\d{2})\s*fps/i);
  if (options.fps && fpsInCard && Number(fpsInCard[1]) !== options.fps) {
    add("fps-mismatch", "high", `卡片写 ${fpsInCard[1]}fps，管线按 ${options.fps}fps 出片`, `把卡片改成与管线一致的 ${options.fps}fps`);
  }
  // ⑥ 手部动作/玻璃镜像（低频但常见）
  if (/手|放置|取出|捏住/.test(visual) && !/无多余手指|无六指/.test(negative)) {
    add("hands", "low", `有手部动作但未排除多余手指`, `负面清单加"无多余手指、无六指"`);
  }
  if (/落地窗|玻璃|镜面|倒影/.test(visual) && !/无镜像|无第二张脸|不出现第二张清晰人脸/.test(negative)) {
    add("mirror", "low", `含玻璃/镜面但未排除镜像第二张人脸`, `负面清单加"无镜像第二张脸"`);
  }

  const weight = { high: 3, medium: 2, low: 1 } as const;
  const score = findings.filter((f) => f.level !== "low").reduce((sum, f) => sum + weight[f.level], 0);
  const blockers = findings.filter((finding) => finding.level === "high");
  return {
    policy: FIRST_PASS_POLICY_VERSION,
    score,
    ready: blockers.length === 0 && score <= 3,
    findings,
    blockers,
    suggestions: [...new Set(findings.filter((f) => f.level !== "low").map((f) => f.suggestion))]
  };
}

/** 整片就绪度 + 建议的渲染顺序（高风险先渲 = canary，先错只花一镜的钱） */
export function assessFilmFirstPass(shots: readonly FirstPassShot[], options: { fps?: number } = {}): {
  policy: typeof FIRST_PASS_POLICY_VERSION;
  ready: boolean;
  blockers: Array<{ shotId: string; finding: FirstPassFinding }>;
  perShot: Array<{ shotId: string; readiness: FirstPassReadiness }>;
  renderOrder: string[];
} {
  const perShot = shots.map((shot) => ({ shotId: String(shot.shotId ?? "?"), readiness: assessShotFirstPass(shot, options) }));
  const blockers = perShot.flatMap((entry) => entry.readiness.blockers.map((finding) => ({ shotId: entry.shotId, finding })));
  const renderOrder = [...perShot]
    .sort((a, b) => b.readiness.score - a.readiness.score || (a.shotId < b.shotId ? -1 : 1))
    .map((entry) => entry.shotId);
  return { policy: FIRST_PASS_POLICY_VERSION, ready: blockers.length === 0, blockers, perShot, renderOrder };
}
