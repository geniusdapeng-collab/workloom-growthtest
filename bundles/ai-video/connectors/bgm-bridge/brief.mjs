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
 * 关键词表：每条 = { id, recipe, patterns, note }。
 * 顺序即优先级（前面的先命中先记分）；命中多个时按得分最高者作为主题材。
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

/* ============================ 简报推导 ============================ */

const ALL_RECIPES = ["product-ad", "interview", "food", "tech", "travel", "night-city", "beauty", "family", "auto", "realestate", "festival-promo", "documentary", "premium-brand", "drama-story", "suspense", "comedy-light"];

function hit(pattern, text) {
  return pattern.test(text);
}

/**
 * 提示词 → 配乐简报。
 *
 * @param {{promptText:string, platform?:string|null, durationSec?:number|null, recipeHint?:string|null}} input
 * @returns {{brief:object, matched:object}}
 */
export function analyzePromptBrief({ promptText, platform = null, durationSec = null, recipeHint = null }) {
  const text = String(promptText ?? "").trim();
  if (!text) throw new MeasureError("prompt_text 为空：配乐简报需要原始渲染提示词", "bad_request");

  const genreHits = [];
  for (const entry of GENRE_KEYWORDS) {
    const matchedPatterns = entry.patterns.filter((pattern) => hit(pattern, text));
    if (matchedPatterns.length) {
      genreHits.push({ recipe: entry.recipe, tags: entry.tags, hits: matchedPatterns.map((p) => String(p.source).slice(0, 40)) });
    }
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

  const notes = [];
  if (!primary) notes.push("提示词未命中题材关键词：不硬编题材，退回「按片子自身能量与结构选曲」");
  if (noMusic) notes.push("提示词明确要求不加配乐 → 结论应为无需配乐（do no harm）");
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
      confidence,
      notes,
    },
    matched: {
      genres: genreHits.map((entry) => ({ recipe: entry.recipe, tags: entry.tags })),
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
 * 口径：题材匹配 40 分 + 情绪/能量 20 分 + BPM 贴合 20 分 + 时长够用 10 分 + 结构有高潮 10 分；禁忌一票否决。
 */
export function scoreTrackAgainstBrief({ track, brief, recipeCatalog = null }) {
  const reasons = [];
  let score = 0;
  const trackGenre = String(track.genre ?? "");
  const trackMood = String(track.mood ?? "");
  const trackTags = Array.isArray(track.tags) ? track.tags.join(" ") : "";
  const haystack = `${trackGenre} ${trackMood} ${trackTags} ${track.title ?? ""}`.toLowerCase();

  const recipe = recipeCatalog?.find?.((item) => item.id === brief.recipeId) ?? null;
  if (brief.recipeId) {
    const recipeGenre = recipe?.genre ?? "";
    if (recipeGenre && haystack.includes(recipeGenre.toLowerCase())) {
      score += 40;
      reasons.push(`题材命中：${recipeGenre}`);
    } else if (brief.genreTags.some((tag) => haystack.includes(String(tag).toLowerCase()))) {
      score += 30;
      reasons.push(`题材标签命中：${brief.genreTags.join("/")}`);
    } else {
      reasons.push(`题材未命中（曲目 genre=${trackGenre || "未标注"}）`);
    }
  } else {
    score += 20; // 无题材线索时不惩罚，交给能量/结构决定
    reasons.push("提示词无题材线索：按能量与结构评分");
  }

  const wantedEnergy = brief.energyLevel;
  const trackEnergy = Number.isFinite(track.energyScore) ? track.energyScore : null; // 0..1
  if (trackEnergy !== null) {
    const target = wantedEnergy === "high" ? 0.8 : wantedEnergy === "low" ? 0.3 : 0.55;
    const distance = Math.abs(trackEnergy - target);
    score += Math.max(0, 20 - distance * 40);
    reasons.push(`能量匹配：曲目 ${trackEnergy.toFixed(2)} vs 目标 ${target}（差 ${distance.toFixed(2)}）`);
  } else {
    score += 10;
    reasons.push("曲目未提供能量指标：给基准分");
  }

  const bpm = Number(track.bpm);
  if (Number.isFinite(bpm) && bpm > 0 && recipe?.bpm) {
    const target = recipe.bpm * brief.bpmScale;
    const distance = Math.abs(bpm - target) / target;
    score += Math.max(0, 20 - distance * 100);
    reasons.push(`BPM 贴合：${bpm} vs 目标 ${Math.round(target)}（差 ${(distance * 100).toFixed(0)}%）`);
  } else {
    score += 10;
    reasons.push("BPM 缺省：给基准分");
  }

  const duration = Number(track.durationSec ?? 0);
  const need = Number.isFinite(brief.durationSec) && brief.durationSec > 0 ? brief.durationSec : 30;
  if (duration > 0) {
    score += duration >= need ? 10 : Math.max(0, 10 - ((need - duration) / need) * 10);
    reasons.push(`时长：${duration}s vs 片子 ${need}s`);
  }

  const hasStructure = Boolean(track.structure) || Number.isFinite(track.dynamicsDb);
  if (hasStructure) {
    score += 10;
    reasons.push("具备结构信息（可选段）");
  } else {
    score += 4;
    reasons.push("无结构信息（选段能力受限）");
  }

  const avoid = brief.instrumentation?.avoid ?? [];
  const trackInstrumentation = Array.isArray(track.instrumentation) ? track.instrumentation : [];
  const violated = avoid.filter((instrument) => trackInstrumentation.includes(instrument));
  if (violated.length) {
    return { score: 0, verdict: "rejected", reasons: [...reasons, `违反提示词禁忌：${violated.join("/")}`] };
  }

  return { score: Math.round(score * 100) / 100, verdict: score >= 55 ? "ok" : "weak", reasons };
}
