/**
 * ai-video × 配乐工位 · 「渲染提示词 → 配乐简报」内核（brief.mjs）
 *
 * 定位：把生成视频时提交渲染的**原始提示词**（render_scripts.md / prompt_package / 一句话 brief）
 * 翻译成配乐可执行的参数：题材配方、情绪、BPM 区间、配器偏好与禁忌、能量弧线、高潮落点、分层策略。
 *
 * 为什么不让模型自由发挥：配乐要的是**可解释 + 可复现**。这里用确定性关键词表 + 规则推导，
 * 输出一份能写进回执的"配乐简报"，再由选曲/选段按简报打分。命中不了就如实报低置信度，
 * 不硬编一个题材。
 *
 * 与在线/本地曲库的关系：简报是**检索条件**——在线源优先按简报搜，失败回退本地精选库；
 * 两条通道都用同一套 `scoreTrackAgainstBrief` 打分，保证可比。
 */

import { MeasureError, round } from "./measure.mjs";

/* ============================ 关键词 → 题材配方 ============================ */

/**
 * 题材未命中处置（T-05，堵 FC-BGM-001「运动曲配江南口播」）：
 * - `penalize`（默认）：未命中记 **-30**，让"能量/BPM 像"的错误题材压不过正确题材；
 * - `veto`：未命中直接出局（`verdict=rejected`），只在客户明确要求"宁可不配也不配错"时启用。
 * 语义相邻（sameGenreFamily）记 +15——同类题材替换比跨类错配安全得多。
 */
export const GENRE_MISMATCH_PENALTY = -30;
export const GENRE_ADJACENT_BONUS = 15;
export const GENRE_MISMATCH_POLICIES = ["penalize", "veto"];

/**
 * 题材同族映射：词面不同但"换了也说得通"的题材（同族命中给相邻分，不给全分）。
 * 只登记确实安全的替换：口播/访谈/纪录/科普同为"说话类铺底"，运动/电竞/健身同为"燃向"，
 * 广告/美食/时尚/科技/房产同为"商业背书"。婚礼与情感、节庆与促销互为近邻。
 */
export const GENRE_FAMILIES = [
  ["documentary", "interview", "edu-explainer"],
  ["sports", "esports", "workout"],
  ["product-ad", "food", "fashion", "beauty", "tech", "realestate", "auto", "auto-ev", "home-decor"],
  ["drama-story", "emotional-story", "wedding", "family", "baby-family"],
  ["festival-promo", "festival-holiday"],
  ["night-city", "city-dusk", "vlog-daily", "pets", "travel"],
  ["premium-brand", "brand-manifesto"],
];

/** 两个配方是否同族（同族即"换了也说得通"，给相邻分而不是全分）。 */
export function sameGenreFamily(a, b) {
  if (!a || !b) return false;
  if (a === b) return true;
  return GENRE_FAMILIES.some((family) => family.includes(a) && family.includes(b));
}

/**
 * 关键词表：每条 = { id, recipe, patterns, note }。
 * 顺序即优先级（前面的先命中先记分）；命中多个时按得分最高者作为主题材。
 * `anti`（可选）：反例词——命中即**压制该条**（FC-BGM-001 的正反例纪律：
 * "江南古镇人文口播"里出现"运动"两字不算体育片；除非调用方显式 recipeHint）。
 */
export const GENRE_KEYWORDS = [
  { recipe: "food", tags: ["美食", "餐饮"], patterns: [/美食|餐饮|探店|吃播|菜品|出锅|烘焙|咖啡|奶茶|茶饮|火锅|烤肉|甜点|食谱/i, /food|cuisine|restaurant|coffee|bakery|dessert|recipe/i] },
  { recipe: "beauty", tags: ["美妆", "护肤"], patterns: [/美妆|护肤|化妆|彩妆|口红|面膜|精华|妆容|种草美妆/i, /beauty|makeup|skincare|cosmetic/i] },
  { recipe: "auto", tags: ["汽车", "出行"], patterns: [/汽车|试驾|新车|发动机|内饰|车评|车型|越野/i, /\bcar\b|vehicle|test drive|engine|automotive/i] },
  { recipe: "realestate", tags: ["房产", "空间"], patterns: [/房产|样板间|户型|家装|装修|看房|买房|空间设计/i, /real ?estate|apartment|interior|house tour|property/i] },
  { recipe: "family", tags: ["亲子", "家庭"], patterns: [/亲子|宝宝|孩子|家庭|育儿|萌娃|母婴/i, /family|kids|baby|parenting/i] },
  { recipe: "night-city", tags: ["夜景", "都市"], patterns: [/夜景|都市|霓虹|车流|赛博|天际线|深夜|城市夜/i, /night|city|neon|cyberpunk|skyline/i] },
  { recipe: "travel", tags: ["旅拍", "户外"], patterns: [/旅拍|旅行|户外|露营|徒步|山海|风景|自驾游|citywalk/i, /travel|outdoor|camp|hiking|landscape|vlog/i] },
  { recipe: "tech", tags: ["科技", "数码"], patterns: [/科技|数码|芯片|手机|电脑|软件|发布会|智能|算法|硬核/i, /tech|gadget|smartphone|software|saas|ai\b|device/i] },
  { recipe: "festival-promo", tags: ["促销", "节日"], patterns: [/促销|折扣|大促|福利|满减|限时|秒杀|节日|双十一|年中大促|红包/i, /sale|promo|discount|black friday|deal|festival/i] },
  { recipe: "premium-brand", tags: ["高端", "品牌"], patterns: [/高端|质感|品牌形象|奢侈|匠心|传承|形象片|精品/i, /luxury|premium|brand film|craftsmanship|heritage/i] },
  { recipe: "suspense", tags: ["悬疑", "紧张"], patterns: [/悬疑|惊悚|反转|推理|紧张|追凶|谜团|不安/i, /suspense|thriller|mystery|twist|tension/i] },
  { recipe: "comedy-light", tags: ["喜剧", "轻快"], patterns: [/喜剧|搞笑|沙雕|整活|幽默|段子|玩梗/i, /comedy|funny|humor|meme/i] },
  { recipe: "drama-story", tags: ["剧情", "故事"], patterns: [/剧情|短剧|故事|人物特写|情感|亲情|离别|救赎/i, /drama|story|emotional|narrative/i] },
  { recipe: "documentary", tags: ["纪录", "纪实"], patterns: [/纪录|纪实|历史|人文|科普|访谈录|口述/i, /documentary|historical|humanities|explainer/i] },
  { recipe: "interview", tags: ["口播", "访谈"], patterns: [/口播|访谈|讲解|知识分享|课堂|教学|主播|面对镜头|讲话/i, /talking head|interview|lecture|tutorial|explainer|voice ?over/i] },
  { recipe: "product-ad", tags: ["产品广告", "种草"], patterns: [/产品|广告|种草|带货|开箱|卖点|旗舰|新品/i, /product|ad\b|advert|unbox|haul|feature review/i] },
  /* ===== T-15 新增题材（置于既有条目之后：顺序即优先级，既有命中行为不变）=====
   * 选词原则：只收既有 16 条词表未覆盖的题材专属词，避免互抢（FC-BGM-001 教训：
   * 宁缺毋滥，不用「集锦/大片」这类跨题材泛词作主命中词）。 */
  { recipe: "wedding", tags: ["婚礼", "誓言"], patterns: [/婚礼|婚纱|誓言|誓词|证婚|first ?look/i, /wedding|bridal|vows/i] },
  // sports 的反例词（FC-BGM-001 正反例纪律）：人文/纪实/口播类文本里出现"运动会"等词不算体育片，
  // 否则"江南古镇人文口播"会被运动曲抢走题材位。
  { recipe: "sports", tags: ["体育", "赛事"], patterns: [/体育|赛事|联赛|杯赛|进球|球场|赛场|球迷|运动会|夺冠/i, /sports|football|basketball|soccer|world cup|tournament/i], anti: [/人文|纪实|纪录|口播|访谈|古镇|非遗|手作|慢生活/i, /documentary|humanities|talking head/i] },
  { recipe: "esports", tags: ["电竞", "游戏"], patterns: [/电竞|开黑|排位|团战|击杀|峡谷|吃鸡/i, /esports|gaming|ranked match/i] },
  { recipe: "fashion", tags: ["时尚", "穿搭"], patterns: [/时尚|走秀|穿搭|时装周|街拍|超模|lookbook/i, /fashion|runway|ootd|catwalk/i] },
  { recipe: "baby-family", tags: ["母婴", "育儿"], patterns: [/孕期|孕妈|婴儿|辅食|满月|周岁|尿布|哄睡/i, /newborn|toddler|infant/i] },
  { recipe: "home-decor", tags: ["家居", "软装"], patterns: [/家居|家具|软装|收纳|全屋定制|room ?tour/i, /home decor|interior styling/i] },
  { recipe: "auto-ev", tags: ["新能源", "智驾"], patterns: [/新能源|充电桩|续航|智驾|自动驾驶|电车|泊车辅助/i, /\bev\b|electric vehicle|self.?driving/i] },
  { recipe: "finance", tags: ["财经", "理财"], patterns: [/财经|理财|基金|股票|股市|投资|财报|金融/i, /finance|invest|stock market|earnings/i] },
  { recipe: "city-dusk", tags: ["黄昏", "蓝调"], patterns: [/黄昏|晚霞|蓝调时刻|华灯初上|傍晚/i, /dusk|golden hour|blue hour|sunset glow/i] },
  { recipe: "festival-holiday", tags: ["节庆", "年货"], patterns: [/年货|圣诞|跨年|情人节|中秋节|端午|庙会|灯会|倒数/i, /christmas|new year countdown|valentine/i] },
  { recipe: "edu-explainer", tags: ["科普", "冷知识"], patterns: [/冷知识|涨知识|原理|小实验|拆解一下/i, /fun fact|how it works/i] },
  { recipe: "vlog-daily", tags: ["日常", "生活记录"], patterns: [/日常|生活记录|独居|一人食|碎碎念|下班路上/i, /daily life|day in my life|weekend routine/i] },
  { recipe: "emotional-story", tags: ["情感", "重逢"], patterns: [/重逢|暗恋|告白|和解|异地恋|初恋|遗憾|心事/i, /confession|reunion|long.?distance/i] },
  { recipe: "brand-manifesto", tags: ["宣言", "使命"], patterns: [/宣言|使命|愿景|价值观|初心/i, /manifesto|our mission|brand statement/i] },
  { recipe: "pets", tags: ["宠物", "萌宠"], patterns: [/宠物|萌宠|猫咪|狗狗|喵星人|汪星人|铲屎官/i, /pets?\b|kitten|puppy|cat video|dog video/i] },
  { recipe: "workout", tags: ["健身", "训练"], patterns: [/健身|撸铁|增肌|减脂|力量训练|跟练|马甲线/i, /workout|gym\b|fitness|training day/i] },
];

/** 情绪/能量修饰词：调 BPM 区间、力度与配器。 */
export const ENERGY_KEYWORDS = {
  hyped: { tags: ["燃", "高能", "快剪"], patterns: [/燃|炸|热血|高能|快剪|卡点|肾上腺素|暴汗/i, /hype|energetic|fast.?cut|workout|action/i], bpmScale: 1.18, energy: "high", levelDelta: 3 },
  calm: { tags: ["治愈", "舒缓"], patterns: [/治愈|放松|舒缓|安静|温柔|慢节奏|冥想|助眠/i, /calm|relax|healing|soft|gentle|ambient|soothing/i], bpmScale: 0.86, energy: "low", levelDelta: -3 },
  premium: { tags: ["克制", "高级感"], patterns: [/克制|高级感|极简|留白|质感强/i, /subtle|minimal|premium|understated|elegant/i], bpmScale: 0.94, energy: "low", levelDelta: -2 },
  playful: { tags: ["轻快", "俏皮"], patterns: [/轻快|俏皮|欢快|活泼|元气|可爱/i, /playful|bouncy|cheerful|upbeat|cute/i], bpmScale: 1.08, energy: "medium", levelDelta: 0 },
  tense: { tags: ["紧张", "压迫"], patterns: [/紧张|压迫|窒息|心跳|危机|逼近/i, /tense|urgent|dark|brooding|stress/i], bpmScale: 1.0, energy: "medium", levelDelta: 0 },
};

/** 明确否定与分层指令。 */
export const POLICY_KEYWORDS = {
  noMusic: { patterns: [/不要(背景)?音乐|无\s?bgm|没有配乐|纯原声|no music|without music|no bgm/i], note: "提示词明确要求不加配乐" },
  keepAll: { patterns: [/保留(现场|环境|同期)声|现场声为主|纪实感|不盖原声|keep (the )?ambience|field recording/i], note: "提示词要求保留现场声 → 走 keep-all 分层" },
  noDrums: { patterns: [/不要鼓点|无打击乐|no drums|without percussion|no beat/i], note: "提示词要求不要打击乐" },
  quiet: { patterns: [/音乐(要)?轻|配乐(要)?淡|轻音乐|音乐别太满|subtle music/i], note: "提示词要求配乐克制 → 电平下调" },
  loud: { patterns: [/音乐(要)?(更)?响|配乐(要)?(更)?强|音乐(要)?突出|punchy music/i], note: "提示词要求配乐更突出 → 电平上调" },
};

/** 高潮落点线索（决定选段对齐到哪里）。 */
export const CLIMAX_KEYWORDS = [
  { position: "end", patterns: [/结尾(反转|揭晓|高能|升华)|最后(反转|揭晓)|片尾(高能|升华)|ending reveal|final reveal|climax at (the )?end/i], ratio: 0.85, note: "提示词提示高潮/反转在结尾" },
  { position: "start", patterns: [/开场(就)?(炸|高能|钩子)|开头(三秒|3秒)|黄金三秒|hook in the first|opening hook/i], ratio: 0.08, note: "提示词提示开场即钩子" },
  { position: "middle", patterns: [/中段(爆发|高潮)|高潮在(中|中间)|midpoint (twist|climax)/i], ratio: 0.5, note: "提示词提示高潮在中段" },
];

/* ============================ 调性相容（T-23） ============================ */

/**
 * 音名 → 音高类（0..11，C=0）。曲目标签与配方均写作 `C4`/`F#4` 形式（字母 + 可选升降号 + 八度），
 * 八度不参与相容判定（配乐相容看的是调性关系，不是音区）。
 */
const NOTE_TO_PC = {
  c: 0, "c#": 1, db: 1, d: 2, "d#": 3, eb: 3, e: 4, f: 5, "f#": 6, gb: 6,
  g: 7, "g#": 8, ab: 8, a: 9, "a#": 10, bb: 10, b: 11,
};

/**
 * 调式族：配方库 mode 有 major/minor/dorian/mixolydian/aeolian/lydian/phrygian（T-15 扩库后），
 * 曲目实测 mode 只有 major/minor（K-S 模板）。相容判定先归族再比——
 * 同族共享调式三度色彩（大调族=大三度明亮 / 小调族=小三度暗），跨族才谈得上冲突。
 */
const MAJOR_FAMILY = new Set(["major", "lydian", "mixolydian"]);
const MINOR_FAMILY = new Set(["minor", "aeolian", "dorian", "phrygian"]);

/**
 * 冲突音程（相对主音的半音距离）：1 = 小二度（bII，最尖锐的调性冲突）、6 = 三全音（增四/减五）。
 * 依据：传统对位与爵士和声里这两个音程与主和弦张力最大，混放两首这种关系的曲子会产生"跑调感"。
 */
const CONFLICT_INTERVALS = new Set([1, 6]);

/** 五度圈相邻 = 半音距离 7（纯五度上行）或 5（纯四度上行/五度下行）：相邻调共用一个调号差，听感最顺。 */
const FIFTH_INTERVALS = new Set([5, 7]);

/** 关系大小调：大调主音 +9 半音 = 其关系小调主音（C major ↔ A minor）；反向即小调 +3 = 关系大调。 */
const RELATIVE_MINOR_OFFSET = 9;
const RELATIVE_MAJOR_OFFSET = 3;

/**
 * 中性配器：纯打击（无固定音高）/ 氛围铺底（音高刻意模糊）类 instrumentation，
 * 与任何调性叠放都无冲突感——这类曲目调性维度记中性分，不按音程判冲突。
 */
const NEUTRAL_INSTRUMENTS = new Set([
  "kick", "hat", "snare", "clap", "shaker", "percussion", "drums", "tom", "cymbal",
  "pad", "drone", "ambience", "texture", "atmosphere", "noise",
]);

function parseKeyPc(key) {
  const match = /^([A-Ga-g])([#b♯♭]?)(\d+)?$/.exec(String(key ?? "").trim());
  if (!match) return null;
  const name = `${match[1].toLowerCase()}${match[2].replace("♯", "#").replace("♭", "b")}`;
  return NOTE_TO_PC[name] ?? null;
}

function modeFamily(mode) {
  const key = String(mode ?? "").trim().toLowerCase();
  if (MAJOR_FAMILY.has(key)) return "major";
  if (MINOR_FAMILY.has(key)) return "minor";
  return null;
}

function trackKeyMode(track) {
  const tags = Array.isArray(track?.tags) ? track.tags : [];
  const keyTag = tags.find((tag) => String(tag).startsWith("key:"));
  const modeTag = tags.find((tag) => String(tag).startsWith("mode:"));
  return {
    key: keyTag ? String(keyTag).slice(4) : null,
    mode: modeTag ? String(modeTag).slice(5) : null,
  };
}

/* ============================ 情绪弧线 → 能量弧线偏好（T-23） ============================ */

/**
 * 分镜情绪标签 → 能量值（0..1）。供 arcPreferenceFromEmotionArc 把调用方传入的
 * 情绪标签序列（或 color_report/分镜摘要文本）压成一条能量走势，再归纳成 T-22 的 6 种 arc 类型。
 */
const EMOTION_ENERGY_KEYWORDS = [
  { level: 1.0, patterns: [/燃|炸|热血|高能|高潮|爆发|燃点|climax|hype|peak|drop/i] },
  { level: 0.75, patterns: [/紧张|压迫|推进|上升|期待|悬念|tense|rising|build|anticipation/i] },
  { level: 0.5, patterns: [/叙述|叙事|平和|日常|稳定|neutral|steady|narrative/i] },
  { level: 0.25, patterns: [/治愈|舒缓|安静|温柔|低落|沉思|calm|soft|gentle|low/i] },
  { level: 0.1, patterns: [/收束|释然|回落|尾声|解决|留白|resolve|outro|fade/i] },
];

function emotionLabelToEnergy(label) {
  for (const entry of EMOTION_ENERGY_KEYWORDS) {
    if (entry.patterns.some((pattern) => pattern.test(label))) return entry.level;
  }
  return 0.5; // 未识别的情绪标签按中性能量处理，不放大也不抹平
}

/**
 * 情绪标签序列/摘要 → 能量弧线偏好（tag.mjs `classifyEnergyArc` 6 类的文本侧轻量版）。
 * 输入可以是标签数组（如 ["平静","推进","燃"]）或一段摘要字符串（按常见分隔符切开）。
 * 返回 null 表示输入不足以归纳弧线——打分侧不启用弧线维度。
 */
export function arcPreferenceFromEmotionArc(emotionArc) {
  const labels = Array.isArray(emotionArc)
    ? emotionArc.map((entry) => String(entry ?? "").trim()).filter(Boolean)
    : String(emotionArc ?? "").split(/[,，、;；>→\s|/]+/).map((entry) => entry.trim()).filter(Boolean);
  if (labels.length < 2) return null;

  const energies = labels.map(emotionLabelToEnergy);
  const max = Math.max(...energies);
  const min = Math.min(...energies);
  const range = max - min;
  const peakIndex = energies.indexOf(max);
  const peakPos = labels.length > 1 ? peakIndex / (labels.length - 1) : 0;
  const end = energies[energies.length - 1];

  // 局部峰计数：显著高于相邻的峰（端点只比一侧）≥2 个 → 多波叙事
  let peaks = 0;
  for (let index = 0; index < energies.length; index += 1) {
    if (energies[index] < 0.7) continue;
    const leftOk = index === 0 || energies[index] > energies[index - 1];
    const rightOk = index === energies.length - 1 || energies[index] >= energies[index + 1];
    if (leftOk && rightOk) peaks += 1;
  }

  let arc;
  if (range < 0.3) arc = "flat-ambient"; // 全程能量平坦
  else if (peaks >= 2) arc = "wave-narrative"; // 多峰起伏
  else if (peakPos <= 0.34 && end <= max - 0.3) arc = "front-loaded"; // 开场即重、后段回落
  else if (peakIndex === energies.length - 1) arc = "rising-steady"; // 一路推到结尾
  else if (peakPos >= 0.6 && end >= max - 0.3) arc = "build-drop"; // 后段冲到高点、尾短
  else if (end <= max - 0.3) arc = "outro-resolve"; // 高点过后明显回落收束
  else arc = "rising-steady";

  return {
    arc,
    source: "emotion-arc",
    labels: labels.slice(0, 12),
    note: `分镜情绪弧线（${labels.length} 拍）归纳为能量弧线偏好「${arc}」`,
  };
}

/**
 * 弧线相容分组（加分用）：同组弧线在选段/铺底上可互相替代，跨组则情绪走向相反。
 * 低张力铺底族：flat-ambient / rising-steady / outro-resolve；高动态起伏族：build-drop / wave-narrative / front-loaded。
 */
const ARC_AFFINITY_GROUPS = [
  new Set(["flat-ambient", "rising-steady", "outro-resolve"]),
  new Set(["build-drop", "wave-narrative", "front-loaded"]),
];

function trackArc(track) {
  const tags = Array.isArray(track?.tags) ? track.tags : [];
  const arcTag = tags.find((tag) => String(tag).startsWith("arc:"));
  return arcTag ? String(arcTag).slice(4) : null;
}

/* ============================ "允许不配"前置提示（T-23） ============================ */

/**
 * SKILL「允许的结论：不配」三判据里**在 brief 阶段（纯文本）可预判**的部分：
 * 判据①（素材已有连续配乐）与判据②的机器信号（人声铺满/底噪）要等素材分析，brief 阶段不猜；
 * 判据③（现场声/沉默/纯人声本身即内容）可由题材词与策略词预判 → 给出"建议评估不配乐"提示。
 * 注意：这里只提示、不判定（最终判定仍在 bgmwrite.best，行为不变），提示文案不写 SKIP 字样。
 */
const NO_SCORE_HINT_PATTERNS = [
  { criterion: "判据③（现场声即内容）", patterns: [/\basmr\b|咀嚼音|白噪(声|音)/i], basis: "ASMR/咀嚼音/白噪声：原声质感即内容本体，加音乐会稀释（SCORE-006 §3.4）" },
  { criterion: "判据③（现场声即内容）", patterns: [/烹饪原声|锅气|翻炒|手工(记录|原声)|制作过程原声/i], basis: "烹饪/手工原声：现场声即内容本体（SCORE-006 §3.4）" },
  { criterion: "判据③（现场声即内容）", patterns: [/现场收音|环境音(记录|采集)|雨声|海浪声|篝火声|城市之声/i], basis: "环境声记录类：空间感与现场感是内容，配乐易抢戏（SCORE-006 §1.1）" },
  { criterion: "判据③（沉默即立场）", patterns: [/讣告|悼念|追思|默哀|公告播报/i], basis: "严肃公告/悼念场景：沉默才是中立，任何情绪倾向都是立场（SCORE-006 §3.1）" },
  { criterion: "判据③（证言纯人声）", patterns: [/用户证言|客户证言|testimonials?/i], basis: "证言类：说服力来自'像真人说话'，倾向纯人声交付（SCORE-006 §3.2）" },
];

/* ============================ 简报推导 ============================ */

const ALL_RECIPES = [
  "product-ad", "interview", "food", "tech", "travel", "night-city", "beauty", "family", "auto", "realestate", "festival-promo", "documentary", "premium-brand", "drama-story", "suspense", "comedy-light",
  "wedding", "sports", "esports", "fashion", "baby-family", "home-decor", "auto-ev", "finance", "city-dusk", "festival-holiday", "edu-explainer", "vlog-daily", "emotional-story", "brand-manifesto", "pets", "workout",
];

function hit(pattern, text) {
  return pattern.test(text);
}

/**
 * 提示词 → 配乐简报。
 *
 * @param {{promptText:string, platform?:string|null, durationSec?:number|null, recipeHint?:string|null, emotionArc?:string[]|string|null}} input
 *   emotionArc（T-23，可选）：分镜情绪弧线——情绪标签序列（如 ["平静","推进","燃"]）或
 *   引用 color_report/分镜数据的摘要字符串；可归纳时映射为能量弧线偏好写入 brief.arcPreference。
 * @returns {{brief:object, matched:object}}
 */
export function analyzePromptBrief({
  promptText, platform = null, durationSec = null, recipeHint = null, emotionArc = null,
  genreMismatchPolicy = "penalize",
}) {
  const text = String(promptText ?? "").trim();
  if (!text) throw new MeasureError("prompt_text 为空：配乐简报需要原始渲染提示词", "bad_request");

  const genreHits = [];
  const suppressed = [];
  for (const entry of GENRE_KEYWORDS) {
    const matchedPatterns = entry.patterns.filter((pattern) => hit(pattern, text));
    if (!matchedPatterns.length) continue;
    // 反例词优先：命中即压制本条（正例词再多也不翻案），并把压制事实写进回执——
    // 不静默丢弃，否则"为什么没命中 sports"在复盘时查不出来（FC-BGM-001）。
    const antiHits = (entry.anti ?? []).filter((pattern) => hit(pattern, text));
    if (antiHits.length) {
      suppressed.push({
        recipe: entry.recipe,
        hits: matchedPatterns.map((p) => String(p.source).slice(0, 40)),
        anti: antiHits.map((p) => String(p.source).slice(0, 40)),
      });
      continue;
    }
    genreHits.push({ recipe: entry.recipe, tags: entry.tags, hits: matchedPatterns.map((p) => String(p.source).slice(0, 40)) });
  }
  const energyHits = [];
  for (const [key, entry] of Object.entries(ENERGY_KEYWORDS)) {
    if (entry.patterns.some((pattern) => hit(pattern, text))) {
      energyHits.push({ key, ...entry, patterns: undefined });
    }
  }
  const policyHits = [];
  for (const [key, entry] of Object.entries(POLICY_KEYWORDS)) {
    if (entry.patterns.some((pattern) => hit(pattern, text))) policyHits.push({ key, note: entry.note });
  }
  const climaxHit = CLIMAX_KEYWORDS.find((entry) => entry.patterns.some((pattern) => hit(pattern, text))) ?? null;

  const primary = recipeHint && ALL_RECIPES.includes(recipeHint)
    ? { recipe: recipeHint, tags: ["显式指定"], hits: ["recipe_hint"] }
    : genreHits[0] ?? null;

  // 情绪修饰：多个修饰词时取"最具体"的一个（hyped > tense > playful > calm > premium 的力度）——
  // 顺序按"对配乐影响最大"排，避免"紧张又治愈"这类冲突描述把力度抹平。
  const energyOrder = ["hyped", "tense", "playful", "calm", "premium"];
  const energy = energyOrder.map((key) => energyHits.find((entry) => entry.key === key)).find(Boolean) ?? null;

  const baseBpm = primary ? null : null; // BPM 区间由配方库补，简报只给倍率
  const bpmScale = energy?.bpmScale ?? 1;
  const energyLevel = energy?.energy ?? (policyHits.some((entry) => entry.key === "quiet") ? "low" : "medium");
  const levelDelta = (energy?.levelDelta ?? 0)
    + (policyHits.some((entry) => entry.key === "quiet") ? -3 : 0)
    + (policyHits.some((entry) => entry.key === "loud") ? 3 : 0);

  const avoid = [];
  if (policyHits.some((entry) => entry.key === "noDrums")) avoid.push("kick", "hat");
  if (energyLevel === "low") avoid.push("kick");

  const prefer = [];
  if (energyLevel === "high") prefer.push("kick", "hat", "bass");
  if (energyLevel === "low") prefer.push("pad", "bell");
  if (energyLevel === "medium") prefer.push("pad", "pluck", "bass");

  const noMusic = policyHits.some((entry) => entry.key === "noMusic");
  const climaxRatio = climaxHit?.ratio ?? null;
  const climaxAtSec = climaxRatio !== null && Number.isFinite(durationSec) && durationSec > 0
    ? round(durationSec * climaxRatio, 2)
    : null;
  const policy = noMusic
    ? "none"
    : policyHits.some((entry) => entry.key === "keepAll") ? "keep-all" : "keep-dialogue";

  const confidence = primary
    ? (genreHits.length === 1 && (energy || climaxHit) ? "high" : "medium")
    : "low";

  // T-23：分镜情绪弧线 → 能量弧线偏好（可选；无输入或不足以归纳时为 null，打分侧不启用弧线维度）
  const arcPreference = emotionArc == null ? null : arcPreferenceFromEmotionArc(emotionArc);

  // T-23：「允许不配」前置提示——只提示不判定（最终判定仍在 bgmwrite.best；不写 SKIP 字样）
  const noScoreHits = [];
  for (const entry of NO_SCORE_HINT_PATTERNS) {
    if (entry.patterns.some((pattern) => hit(pattern, text))) {
      noScoreHits.push({ criterion: entry.criterion, basis: entry.basis });
    }
  }
  if (policyHits.some((entry) => entry.key === "keepAll")) {
    noScoreHits.push({ criterion: "判据③（现场声即内容）", basis: "提示词要求保留现场声/现场声为主：叠加配乐可能稀释内容本体（SCORE-006 §1.1）" });
  }
  const noScoreHint = !noMusic && noScoreHits.length
    ? {
      suggested: true,
      criteria: [...new Set(noScoreHits.map((entry) => entry.criterion))],
      basis: noScoreHits.map((entry) => entry.basis).join("；"),
      note: "建议评估不配乐（brief 阶段预判提示；最终判定由 bgmwrite.best 按素材分析给出）",
    }
    : null;

  const notes = [];
  if (!primary) notes.push("提示词未命中题材关键词：不硬编题材，退回「按片子自身能量与结构选曲」");
  if (suppressed.length) {
    notes.push(`反例词压制题材：${suppressed.map((entry) => `${entry.recipe}（正例 ${entry.hits.join("/")} 被反例 ${entry.anti.join("/")} 压制）`).join("；")}`);
  }
  if (noMusic) notes.push("提示词明确要求不加配乐 → 结论应为无需配乐（do no harm）");
  if (noScoreHint) notes.push(`建议评估不配乐：${noScoreHint.basis}`);
  if (arcPreference) notes.push(arcPreference.note);
  if (climaxHit) notes.push(climaxHit.note);
  if (policyHits.some((entry) => entry.key === "quiet")) notes.push("提示词要求配乐克制：music_level_db 建议下调 3dB");
  if (policyHits.some((entry) => entry.key === "loud")) notes.push("提示词要求配乐突出：music_level_db 建议上调 3dB");
  if (policyHits.some((entry) => entry.key === "noDrums")) notes.push("提示词要求不要打击乐：候选曲目过滤掉有鼓组的部分/曲目");

  return {
    brief: {
      promptText: text.slice(0, 2000),
      platform: platform ?? null,
      durationSec: Number.isFinite(durationSec) ? durationSec : null,
      recipeId: primary?.recipe ?? null,
      genreTags: primary?.tags ?? [],
      alternatives: genreHits.slice(1, 4).map((entry) => entry.recipe),
      mood: energy?.tags ?? [],
      energyLevel,
      bpmScale,
      baseBpmHint: baseBpm,
      instrumentation: { prefer: [...new Set(prefer)], avoid: [...new Set(avoid)] },
      musicLevelDeltaDb: levelDelta,
      audioPolicy: policy,
      climax: climaxRatio === null
        ? { position: "unknown", ratio: null, atSec: null, note: "提示词未给高潮线索 → 交由片子能量/剪辑分析决定" }
        : { position: climaxHit.position, ratio: climaxRatio, atSec: climaxAtSec, note: climaxHit.note },
      noMusic,
      arcPreference,
      noScoreHint,
      genreMismatchPolicy: GENRE_MISMATCH_POLICIES.includes(genreMismatchPolicy) ? genreMismatchPolicy : "penalize",
      confidence,
      notes,
    },
    matched: {
      genres: genreHits.map((entry) => ({ recipe: entry.recipe, tags: entry.tags })),
      suppressedGenres: suppressed,
      energy: energyHits.map((entry) => entry.key),
      policies: policyHits.map((entry) => entry.key),
      climax: climaxHit?.position ?? null,
    },
  };
}

/**
 * 提示词能量弧线（信息性输出，供回执与可视化；选段仍以真实音频分析为准）。
 * 形状：flat / rise-to-climax / hook-first / peak-middle / build-through
 */
export function energyCurveFor({ brief, durationSec = null }) {
  const duration = Number.isFinite(durationSec) && durationSec > 0 ? durationSec : (brief.durationSec ?? 30);
  const shape = brief.noMusic
    ? "none"
    : brief.climax.position === "end" ? "rise-to-climax"
      : brief.climax.position === "start" ? "hook-first"
        : brief.climax.position === "middle" ? "peak-middle"
          : brief.energyLevel === "high" ? "build-through" : "flat";
  const points = [];
  const steps = 8;
  for (let index = 0; index <= steps; index += 1) {
    const ratio = index / steps;
    let level;
    switch (shape) {
      case "none": level = 0; break;
      case "hook-first": level = Math.max(0.25, 1 - ratio * 0.8); break;
      case "rise-to-climax": level = 0.3 + ratio * 0.7; break;
      case "peak-middle": level = 0.45 + 0.55 * Math.sin(Math.PI * ratio); break;
      case "build-through": level = 0.55 + ratio * 0.45; break;
      default: level = brief.energyLevel === "low" ? 0.35 : 0.5;
    }
    points.push({ atSec: round(duration * ratio, 2), level: round(Math.min(1, level), 2) });
  }
  return { shape, durationSec: round(duration, 2), points };
}

/**
 * 曲目打分：简报 ↔ 曲目元数据（在线候选与本地精选库共用同一把尺子）。
 *
 * 口径（T-23 再分配后，总分恒为 100）：
 * - 无弧线偏好输入：题材 38 + 能量 18 + BPM 18 + 时长 9 + 结构 7 + 调性相容 10；
 * - 有弧线偏好输入：题材 36 + 能量 17 + BPM 17 + 时长 8 + 结构 7 + 调性相容 10 + 弧线偏好 5
 *   （弧线的 5 分从调性以外的既有维度等比协调出来，不动调性权重）。
 * T-05 起题材维度是**双向量**：命中 +38/36、同族 +15、未命中 **-30**（`veto` 策略下直接出局）——
 * "没命中不给分"正是 FC-BGM-001（运动曲配江南口播）的根因：能量/BPM 维度会把错配曲目捞回来。
 * 禁忌一票否决不变。
 */
const SCORE_WEIGHTS = {
  plain: { genre: 38, energy: 18, bpm: 18, duration: 9, structure: 7, tonality: 10, arc: 0 },
  withArc: { genre: 36, energy: 17, bpm: 17, duration: 8, structure: 7, tonality: 10, arc: 5 },
};

export function scoreTrackAgainstBrief({ track, brief, recipeCatalog = null, genreMismatchPolicy = null }) {
  const reasons = [];
  let score = 0;
  const weights = brief.arcPreference?.arc ? SCORE_WEIGHTS.withArc : SCORE_WEIGHTS.plain;
  const mismatchPolicy = GENRE_MISMATCH_POLICIES.includes(genreMismatchPolicy)
    ? genreMismatchPolicy
    : (GENRE_MISMATCH_POLICIES.includes(brief.genreMismatchPolicy) ? brief.genreMismatchPolicy : "penalize");
  const trackGenre = String(track.genre ?? "");
  const trackMood = String(track.mood ?? "");
  const trackTags = Array.isArray(track.tags) ? track.tags.join(" ") : "";
  const haystack = `${trackGenre} ${trackMood} ${trackTags} ${track.title ?? ""}`.toLowerCase();

  const recipe = recipeCatalog?.find?.((item) => item.id === brief.recipeId) ?? null;
  let genreVetoed = false;
  if (brief.recipeId) {
    const recipeGenre = recipe?.genre ?? "";
    // 曲目题材标签（tag.mjs 的 classifyStyle 结果）参与同族判定：曲目常以风格族+题材双标签落库。
    const trackRecipeIds = (recipeCatalog ?? [])
      .filter((item) => item.genre && haystack.includes(String(item.genre).toLowerCase()))
      .map((item) => item.id);
    if (recipeGenre && haystack.includes(recipeGenre.toLowerCase())) {
      score += weights.genre;
      reasons.push(`题材命中：${recipeGenre}`);
    } else if (brief.genreTags.some((tag) => haystack.includes(String(tag).toLowerCase()))) {
      score += Math.round(weights.genre * 0.75);
      reasons.push(`题材标签命中：${brief.genreTags.join("/")}`);
    } else if (trackRecipeIds.some((id) => sameGenreFamily(id, brief.recipeId))) {
      score += GENRE_ADJACENT_BONUS;
      reasons.push(`题材同族（${trackRecipeIds.filter((id) => sameGenreFamily(id, brief.recipeId)).join("/")} ↔ ${brief.recipeId}）：+${GENRE_ADJACENT_BONUS}`);
    } else {
      // T-05：题材未命中不再"零分放行"——负分降权（或直接出局），堵 FC-BGM-001 的"运动曲配江南口播"。
      score += GENRE_MISMATCH_PENALTY;
      reasons.push(`题材未命中（曲目 genre=${trackGenre || "未标注"}）：${GENRE_MISMATCH_PENALTY}（策略 ${mismatchPolicy}）`);
      if (mismatchPolicy === "veto") {
        genreVetoed = true;
        reasons.push(`题材未命中且策略 veto：直接出局（宁可不配也不配错）`);
      }
    }
  } else {
    score += weights.genre / 2; // 无题材线索时不惩罚，交给能量/结构决定
    reasons.push("提示词无题材线索：按能量与结构评分");
  }

  const wantedEnergy = brief.energyLevel;
  const trackEnergy = Number.isFinite(track.energyScore) ? track.energyScore : null; // 0..1
  if (trackEnergy !== null) {
    const target = wantedEnergy === "high" ? 0.8 : wantedEnergy === "low" ? 0.3 : 0.55;
    const distance = Math.abs(trackEnergy - target);
    score += Math.max(0, weights.energy - distance * weights.energy * 2);
    reasons.push(`能量匹配：曲目 ${trackEnergy.toFixed(2)} vs 目标 ${target}（差 ${distance.toFixed(2)}）`);
  } else {
    score += weights.energy / 2;
    reasons.push("曲目未提供能量指标：给基准分");
  }

  const bpm = Number(track.bpm);
  if (Number.isFinite(bpm) && bpm > 0 && recipe?.bpm) {
    const target = recipe.bpm * brief.bpmScale;
    const distance = Math.abs(bpm - target) / target;
    score += Math.max(0, weights.bpm - distance * weights.bpm * 5);
    reasons.push(`BPM 贴合：${bpm} vs 目标 ${Math.round(target)}（差 ${(distance * 100).toFixed(0)}%）`);
  } else {
    score += weights.bpm / 2;
    reasons.push("BPM 缺省：给基准分");
  }

  const duration = Number(track.durationSec ?? 0);
  const need = Number.isFinite(brief.durationSec) && brief.durationSec > 0 ? brief.durationSec : 30;
  if (duration > 0) {
    score += duration >= need ? weights.duration : Math.max(0, weights.duration - ((need - duration) / need) * weights.duration);
    reasons.push(`时长：${duration}s vs 片子 ${need}s`);
  }

  const hasStructure = Boolean(track.structure) || Number.isFinite(track.dynamicsDb);
  if (hasStructure) {
    score += weights.structure;
    reasons.push("具备结构信息（可选段）");
  } else {
    score += Math.round(weights.structure * 0.4);
    reasons.push("无结构信息（选段能力受限）");
  }

  // T-23 调性相容：同调 +10 / 关系大小调·五度圈相邻 +6 / 中性（纯打击·氛围类或无冲突音程）+3 / 冲突（小二度·三全音）-5
  {
    const { key: trackKey, mode: trackMode } = trackKeyMode(track);
    const recipeKey = recipe?.key ?? null;
    const recipeMode = recipe?.mode ?? null;
    if (!trackKey || !trackMode) {
      reasons.push("调性：曲目无调性标签不参与调性评分（不惩罚）");
    } else if (!recipeKey || !recipeMode) {
      reasons.push("调性：配方未给调性目标，不参与调性评分（不惩罚）");
    } else {
      const instrumentation = Array.isArray(track.instrumentation) ? track.instrumentation : [];
      const neutralByInstr = instrumentation.length > 0
        && instrumentation.every((item) => NEUTRAL_INSTRUMENTS.has(String(item).toLowerCase()));
      const neutralByTag = /ambient|氛围|纯打击/.test(`${String(track.style ?? "")} ${trackTags}`.toLowerCase());
      const trackPc = parseKeyPc(trackKey);
      const recipePc = parseKeyPc(recipeKey);
      if (neutralByInstr || neutralByTag) {
        score += 3;
        reasons.push("调性：纯打击/氛围类配器，无音高冲突（中性 +3）");
      } else if (trackPc === null || recipePc === null) {
        reasons.push(`调性：标签无法解析（曲目 ${trackKey}/${trackMode} vs 配方 ${recipeKey}/${recipeMode}），不参与调性评分`);
      } else {
        const trackFamily = modeFamily(trackMode);
        const recipeFamily = modeFamily(recipeMode);
        const distance = (trackPc - recipePc + 12) % 12;
        // 音程级：上下行等价（G→F# 与 F#→G 同为小二度冲突）
        const interval = Math.min(distance, 12 - distance);
        if (distance === 0 && trackFamily !== null && trackFamily === recipeFamily) {
          score += 10;
          reasons.push(`调性：同调命中（${trackKey} ${trackMode} vs 配方 ${recipeKey} ${recipeMode}）+10`);
        } else if (CONFLICT_INTERVALS.has(interval)) {
          score -= 5;
          reasons.push(`调性：冲突调性（${trackKey} vs ${recipeKey}，音程 ${interval}=${interval === 1 ? "小二度" : "三全音"}）-5`);
        } else if (
          (recipeFamily === "major" && trackFamily === "minor" && distance === RELATIVE_MINOR_OFFSET)
          || (recipeFamily === "minor" && trackFamily === "major" && distance === RELATIVE_MAJOR_OFFSET)
        ) {
          score += 6;
          reasons.push(`调性：关系大小调（${trackKey} ${trackMode} ↔ ${recipeKey} ${recipeMode}）+6`);
        } else if (FIFTH_INTERVALS.has(distance) && trackFamily !== null && trackFamily === recipeFamily) {
          score += 6;
          reasons.push(`调性：五度圈相邻（${trackKey} ↔ ${recipeKey}，半音距离 ${distance}）+6`);
        } else {
          score += 3;
          reasons.push(`调性：中性（${trackKey} ${trackMode} vs ${recipeKey} ${recipeMode}，无冲突音程）+3`);
        }
      }
    }
  }

  // T-23 弧线偏好：仅当 brief 带 arcPreference 时启用（权重已计入总分口径）；曲目无 arc 标签记 0 不惩罚
  if (weights.arc > 0) {
    const wantedArc = brief.arcPreference.arc;
    const arc = trackArc(track);
    if (!arc) {
      reasons.push("弧线：曲目无 arc 标签不参与弧线评分（不惩罚）");
    } else if (arc === wantedArc) {
      score += weights.arc;
      reasons.push(`弧线：命中分镜情绪弧线偏好「${wantedArc}」+${weights.arc}`);
    } else if (ARC_AFFINITY_GROUPS.some((group) => group.has(arc) && group.has(wantedArc))) {
      score += 2;
      reasons.push(`弧线：${arc} 与偏好 ${wantedArc} 同族相容 +2`);
    } else {
      reasons.push(`弧线：${arc} 与偏好 ${wantedArc} 走向不符（+0）`);
    }
  }

  const avoid = brief.instrumentation?.avoid ?? [];
  const trackInstrumentation = Array.isArray(track.instrumentation) ? track.instrumentation : [];
  const violated = avoid.filter((instrument) => trackInstrumentation.includes(instrument));
  if (violated.length) {
    return { score: 0, verdict: "rejected", reasons: [...reasons, `违反提示词禁忌：${violated.join("/")}`] };
  }

  const rounded = Math.round(score * 100) / 100;
  if (genreVetoed) return { score: rounded, verdict: "rejected", vetoed: true, reasons };
  return { score: rounded, verdict: rounded >= 55 ? "ok" : "weak", reasons };
}
