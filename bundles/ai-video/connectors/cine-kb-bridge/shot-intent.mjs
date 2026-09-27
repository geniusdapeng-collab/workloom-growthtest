/** Shared, deterministic shot intent and enhancement provenance. No model or TS loader required. */
import { createHash } from "node:crypto";

export const SHOT_INTENT_VERSION = "workloom.shot-intent/v1";
export const ENHANCEMENT_META_KEY = "_workloomEnhancements";
const ENHANCEMENT_VERSION = "workloom.shot-enhancements/v1";
const OWNER_FIELDS = {
  micromotion: new Set(["action"]),
  "cine-kb": new Set(["lighting", "composition", "camera_movement", "color_palette", "props", "costume", "makeup", "baseline", "depth_of_field"]),
};

export class ShotIntentError extends Error {
  constructor(code, message) {
    super(`${code}: ${message}`);
    this.name = "ShotIntentError";
    this.code = code;
    this.status = "unverified";
  }
}

function object(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ShotIntentError("SHOT_INTENT_INPUT_INVALID", `${label} 必须为对象`);
  }
  return value;
}

/** Stable across key insertion order and machine locale. Reject non-JSON values and cycles. */
export function shotIntentHash(value) {
  const active = new WeakSet();
  const inspect = (item) => {
    if (typeof item === "number" && !Number.isFinite(item)) throw new ShotIntentError("SHOT_INTENT_INPUT_INVALID", "数值必须有限");
    if (["function", "symbol", "bigint"].includes(typeof item)) throw new ShotIntentError("SHOT_INTENT_INPUT_INVALID", "输入必须是 JSON 数据");
    if (!item || typeof item !== "object") return;
    if (active.has(item)) throw new ShotIntentError("SHOT_INTENT_INPUT_INVALID", "输入含循环引用");
    active.add(item);
    for (const child of Object.values(item)) inspect(child);
    active.delete(item);
  };
  inspect(value);
  const serialized = JSON.stringify(value, (_key, item) => item && typeof item === "object" && !Array.isArray(item)
    ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)) : item);
  if (serialized === undefined) throw new ShotIntentError("SHOT_INTENT_INPUT_INVALID", "输入不能序列化");
  return createHash("sha256").update(serialized).digest("hex");
}

export function shotText(value) {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map(shotText).filter(Boolean).join("；");
  if (value && typeof value === "object") {
    if (typeof value.string === "string") return value.string;
    return Object.entries(value).filter(([key]) => !key.startsWith("_")).map(([, child]) => shotText(child)).filter(Boolean).join("；");
  }
  return "";
}

/** Finite text rules, not a claim of unrestricted language understanding. */
export function splitShotAssertions(raw) {
  const negative = [];
  const positive = [];
  const withoutBlocks = String(raw ?? "").replace(
    /(?:\d{1,2}\.\s*)?【(?:负面(?:约束)?|禁止(?:项|词)?|negative(?: prompt)?)】[^【]*(?=【|$)/gi,
    (block) => { negative.push(block); return "；"; }
  );
  const clauses = withoutBlocks.split(/[。；;\n，,、]+/).flatMap((sentence) =>
    sentence.split(/但是|然而|而是|但|\bbut\b|\binstead\b|并(?:且)?(?=保持|继续|不|禁|避)|且(?=保持|继续|不)/i));
  const negation = /禁止|避免|不要|不得|不许|不能|无需|没有|未见|未出现|不含|不露|不做|不加|不说|不拍|不出|不看|不转|不回|不抬|不起|不站|不走|不动|不笑|不眨|不睁|不横|不环|不摇|不平|不推|不跟|不挥|不摆|不偏|不变|不移|不晃|无人(?!机)|无(?=(?:任何)?(?:角色|台词|对白|旁白|桥|栈道|光污染|风|雨|雪|硬阴影|噪点|光源|设备|手机|平板|笔记本电脑|台式机|电脑|显示器|显示屏|耳机|键盘|鼠标|智能手表|屏幕|磨损|划痕|使用痕迹|水渍|指纹|污渍|灰尘|薄灰|杯痕|磕痕|锈迹))|\b(?:do not|don't|no|not|never|without|avoid)\b/i;
  for (const rawClause of clauses) {
    const clause = rawClause.trim();
    if (!clause) continue;
    const match = negation.exec(clause);
    if (!match) { positive.push(clause); continue; }
    const before = clause.slice(0, match.index).trim();
    if (before) positive.push(before);
    const tail = clause.slice(match.index);
    // “无光污染的星空”否定光污染，仍保留中心词星空；谓词否定不作此还原。
    const qualifier = /^(?:无|不含|没有)[^的地]{1,16}[的地](.+)$/.exec(tail);
    if (qualifier) {
      negative.push(tail.slice(0, tail.length - qualifier[1].length));
      positive.push(qualifier[1]);
    } else {
      negative.push(tail);
    }
  }
  return { positive: positive.join("；"), negative };
}

/** Restore only recorded append-only contributions. A changed/unknown suffix is never globally deleted. */
export function restoreShotContributions(input, owner = null) {
  const card = { ...object(input, "镜头卡") };
  const metadata = card[ENHANCEMENT_META_KEY];
  if (metadata === undefined) return { card, restored: [] };
  object(metadata, "增强溯源");
  if (metadata.schemaVersion !== ENHANCEMENT_VERSION) throw new ShotIntentError("ENHANCEMENT_PROVENANCE_INVALID", "未知增强溯源版本");
  const owners = { ...object(metadata.owners, "增强来源") };
  const restored = [];
  for (const [name, record] of Object.entries(owners).reverse()) {
    if (owner && owner !== name) continue;
    if (!OWNER_FIELDS[name]) throw new ShotIntentError("ENHANCEMENT_PROVENANCE_INVALID", `未知增强来源 ${name}`);
    object(record, "增强记录");
    if (!Array.isArray(record.contributions) || !/^[a-f\d]{64}$/.test(record.sourceHash ?? "")) {
      throw new ShotIntentError("ENHANCEMENT_PROVENANCE_INVALID", "增强记录缺源哈希或字段贡献");
    }
    const seen = new Set();
    for (const contribution of [...record.contributions].reverse()) {
      object(contribution, "字段贡献");
      const { field, before, after, suffix, hadField, afterHash } = contribution;
      if (!OWNER_FIELDS[name].has(field) || seen.has(field) || typeof hadField !== "boolean"
        || typeof after !== "string" || typeof suffix !== "string" || !suffix
        || (before !== undefined && before !== null && typeof before !== "string")
        || after !== `${typeof before === "string" ? before : ""}${suffix}` || shotIntentHash(after) !== afterHash) {
        throw new ShotIntentError("ENHANCEMENT_PROVENANCE_INVALID", `无法核验 ${name} 的字段贡献`);
      }
      seen.add(field);
      const current = card[field];
      if (current === after) {
        if (hadField) card[field] = before;
        else delete card[field];
      } else if (typeof current === "string" && current.endsWith(suffix)) {
        card[field] = current.slice(0, -suffix.length); // 用户修改了原文，保留修改、只摘除已证明的末尾贡献。
      } else if (current === before || current === undefined || current === null || current === "") {
        // 用户显式移除了增强；保持当前输入。
      } else {
        throw new ShotIntentError("ENHANCEMENT_PROVENANCE_INVALID", `${field} 的既有增强已被修改，不能证明可安全摘除`);
      }
    }
    delete owners[name];
    restored.push(name);
  }
  if (Object.keys(owners).length) card[ENHANCEMENT_META_KEY] = { schemaVersion: ENHANCEMENT_VERSION, owners };
  else delete card[ENHANCEMENT_META_KEY];
  return { card, restored };
}

/** Append complete clauses and record exact before/after values; never trim or truncate author text. */
export function appendShotContributions(input, options, additions) {
  const { owner, policyVersion, sourceHash } = options;
  if (!OWNER_FIELDS[owner] || !/^[a-f\d]{64}$/.test(sourceHash ?? "")) throw new ShotIntentError("ENHANCEMENT_PROVENANCE_INVALID", "增强来源或源哈希无效");
  const { card } = restoreShotContributions(input, owner);
  const records = [];
  const applied = [];
  const seen = new Set();
  for (const addition of additions) {
    const { field, text, maxFieldChars = Infinity } = addition;
    if (!OWNER_FIELDS[owner].has(field) || seen.has(field) || typeof text !== "string" || !text.trim()) {
      throw new ShotIntentError("ENHANCEMENT_PROVENANCE_INVALID", "贡献字段重复、越界或文本为空");
    }
    seen.add(field);
    const before = card[field] === undefined ? card.fields?.[field] : card[field];
    if (before !== undefined && before !== null && typeof before !== "string") {
      throw new ShotIntentError("SHOT_INTENT_FIELD_INVALID", `${field} 必须为字符串，不能覆盖结构化原值`);
    }
    const original = typeof before === "string" ? before : "";
    const suffix = `${original ? "；" : ""}${text}`;
    const after = original + suffix;
    if (after.length > maxFieldChars) {
      applied.push({ field, from: original, added: text, written: "", writtenChars: 0, dropped: "field-over-budget", originalChars: original.length, fieldBudget: maxFieldChars });
      continue;
    }
    records.push({ field, hadField: Object.hasOwn(card, field), ...(before !== undefined ? { before } : {}), after, suffix, afterHash: shotIntentHash(after) });
    card[field] = after;
    applied.push({ field, from: original, added: text, written: text, writtenChars: text.length, fieldHash: shotIntentHash(after) });
  }
  if (records.length) {
    const prior = card[ENHANCEMENT_META_KEY]?.owners ?? {};
    card[ENHANCEMENT_META_KEY] = {
      schemaVersion: ENHANCEMENT_VERSION,
      owners: { ...prior, [owner]: { policyVersion, sourceHash, contributions: records } },
    };
  }
  return { card, applied };
}

const CONTEXT_FIELDS = ["description", "scene", "sceneDescription", "sceneDesc", "action", "composition", "lighting", "color_palette", "camera_movement", "cameraMovement", "mood", "emotion", "timeline", "director_instruction", "baseline", "pacing", "depth_of_field", "costume", "props", "makeup"];
const positiveText = (value) => splitShotAssertions(shotText(value)).positive;
const keysMatching = (text, entries) => entries.filter(([, pattern]) => pattern.test(text)).map(([key]) => key);
const TIME_MARKERS = [
  ["morning", /清晨|早上|上午|晨光|日出|\bmorning\b/i], ["noon", /正午|中午|晌午|\bnoon\b/i],
  ["afternoon", /下午|午后|\bafternoon\b/i], ["dusk", /黄昏|日落(?!后)|晚霞|傍晚|夕阳|落日|黄金时刻|\bsunset\b/i],
  ["night", /夜景|雨夜|夜晚|入夜|晚上|夜色|夜空|午夜|凌晨|跨年夜|\bnight\b/i],
  ["blueHour", /蓝调时刻|蓝调|暮色|日落后|blue hour/i], ["day", /白天|日间|日光|白昼|daylight|daytime/i],
];

export function normalizeShotIntent(input) {
  const restored = restoreShotContributions(input);
  const source = Object.fromEntries(Object.entries(restored.card).filter(([key]) => !key.startsWith("_")));
  const sourceHash = shotIntentHash(source);
  const fields = source.fields && typeof source.fields === "object" && !Array.isArray(source.fields) ? source.fields : {};
  const get = (key) => source[key] ?? fields[key];
  const declared = get("subject") && typeof get("subject") === "object" && !Array.isArray(get("subject")) ? get("subject") : {};
  if (declared.count !== undefined && (!Number.isInteger(declared.count) || declared.count < 0)) {
    throw new ShotIntentError("SHOT_INTENT_INPUT_INVALID", "主体人数必须为非负整数");
  }
  const action = splitShotAssertions(shotText(get("action")));
  const descriptions = [get("description"), get("scene"), get("sceneDescription"), get("sceneDesc"), get("action"), get("composition")].map(shotText).join("；");
  const descriptivePositive = splitShotAssertions(descriptions).positive;
  const characterRaw = [get("character"), get("characters"), get("cast"), get("presenter")].map(shotText).filter(Boolean).join("；");
  const namedPerson = !/商品|产品|手表|表盘|香水|瓶身|包装|猫|狗|犬|鸟|鹰|昆虫/.test(characterRaw) && Boolean(characterRaw.trim()) && !/^(?:无|没有|none|null)|空镜|不出镜|无人物/i.test(characterRaw.trim());
  const explicitKind = String(declared.kind ?? "").toLowerCase();
  const noPerson = declared.hasPerson === false || declared.count === 0
    || /^(none|object|product|environment|landscape|animal)$/.test(explicitKind)
    || /空镜|无人(?!机)|无人物|无角色|没有(?:任何)?(?:人物|人|角色)|不出现(?:任何)?(?:人物|人|角色)|\bno (?:people|person|human|character)s?\b/i.test(descriptions)
    || /^(?:无|无人物|无角色|none|null)$/i.test(characterRaw.trim());
  const personEvidence = /双人|两人|二人|多人|人群|众人|情侣|人物|女主|男主|主角|女人|男人|女孩|男孩|老人|儿童|孩子|婴儿|游客|工人|演员|模特|医生|护士|士兵|运动员|演唱者|她|(?<!其)他|\b(?:person|woman|man|girl|boy|actor|people)\b/i.test(descriptivePositive)
    || /抬眼|垂眼|眨眼|低头|抬头|坐着|坐下|起身|蹲着|蹲姿|躺着|睡着|面部|嘴角/.test(action.positive);
  const animalSubject = /动物|猫|狗|犬|鸟|鹰|鹿|熊|昆虫|企鹅|蝙蝠|\b(?:animal|cat|dog|bird)\b/i.test(descriptivePositive) && !/人物|女主|男主|女人|男人|女孩|男孩|老人|儿童|孩子|她|(?<!其)他|\b(?:person|woman|man|girl|boy|actor|people)\b/i.test(descriptivePositive);
  const hasPerson = !noPerson && (!animalSubject || namedPerson || declared.hasPerson === true) && (declared.hasPerson === true || ["person", "human"].includes(explicitKind) || namedPerson || personEvidence);
  const animal = !hasPerson && /动物|猫|狗|犬|鸟|鹰|马|鹿|熊|昆虫|企鹅|蝙蝠|\b(?:animal|cat|dog|bird)\b/i.test(descriptivePositive);
  const item = !hasPerson && /商品|产品|物件|静物|手表|表盘|香水|瓶身|包装|餐具|电脑|显示器|手机|食物|美食|糖粥|点心|汤|咖啡|雕塑|人偶|\b(?:product|object|watch|bottle)\b/i.test(descriptivePositive);
  const environment = noPerson || /风景|风光|空街|空巷|房间|会议室|办公室|走廊|建筑|街道|湖面|山|大海|海面|天空|星空|幕墙/.test(descriptivePositive);
  const kind = hasPerson ? "person" : explicitKind === "animal" || animal ? "animal" : ["object", "product"].includes(explicitKind) || item ? "object" : environment ? "environment" : "unknown";
  const framing = positiveText(get("composition") ?? get("shotScale"));
  const close = /大特写|特写|近景|close[ -]?up/i.test(framing) && !/中近景/.test(framing);
  const wide = /大远景|远景|大全景|航拍|\bwide\b|\baerial\b/i.test(framing);
  const explicitParts = Array.isArray(declared.visibleParts) ? declared.visibleParts.filter((part) => ["face", "eyes", "hands", "upperBody", "body"].includes(part)) : null;
  const handsOnly = /只有(?:双手|手部)|仅(?:拍|见|有)?(?:手部|双手)|(?:手部|双手)(?:大)?特写|\bhands only\b/i.test(descriptions);
  const faceHidden = declared.faceVisible === false || handsOnly || /不露(?:脸|面部)|看不(?:到|见)(?:脸|面部)|背影|背对镜头|\b(?:back view|face hidden)\b/i.test(descriptions);
  const faceVisible = hasPerson && !faceHidden && (explicitParts ? explicitParts.includes("face") : declared.faceVisible === true || !wide);
  const postureText = `${positiveText(get("scene"))}；${action.positive}`;
  const posture = /睡着|睡眠|熟睡|沉睡|\bsleep/i.test(postureText) ? "sleeping"
    : /躺|卧|\blying\b/i.test(postureText) ? "lying" : /蹲|\bcrouch/i.test(postureText) ? "crouching"
      : /坐|\bsitt?ing\b/i.test(postureText) ? "sitting" : /站立|站在|站着|站定|\bstanding\b/i.test(postureText) ? "standing" : "unknown";
  const eyesClosed = posture === "sleeping" || /闭着眼|双眼闭合|闭眼|\beyes closed\b/i.test(action.positive + positiveText(get("scene")));
  const visibleParts = hasPerson ? explicitParts ?? (handsOnly ? ["hands"] : [
    ...(faceVisible ? ["face", ...(eyesClosed ? [] : ["eyes"])] : []),
    ...(!close ? ["body", "hands"] : []),
  ]) : [];
  const allRaw = CONTEXT_FIELDS.map((key) => shotText(get(key))).filter(Boolean).join("；");
  const all = splitShotAssertions(allRaw);
  const cameraValue = get("camera");
  const cameraRaw = shotText(get("camera_movement") ?? get("cameraMovement") ?? cameraValue?.movement ?? get("cameraString") ?? cameraValue);
  const cameraAssertions = splitShotAssertions(cameraRaw);
  const cameraModes = keysMatching(cameraAssertions.positive, [
    ["static", /固定机位|固定镜头|锁定机位|完全静止|\bstatic\b|locked[ -]?off/i],
    ["tracking", /跟拍|跟随|跟镜|tracking|follow/i], ["push", /推近|推进|push in|dolly in/i],
    ["pull", /拉远|后拉|pull out|dolly out/i], ["pan", /摇镜|摇摄|水平摇|\bpan\b/i],
    ["truck", /横移|平移|\btruck\b/i], ["orbit", /环绕|绕拍|\borbit\b/i],
    ["handheld", /手持|\bhandheld\b/i], ["aerial", /无人机|航拍|俯瞰|aerial|drone/i],
  ]);
  const hardStatic = /完全静止|锁定机位|固定不动|镜头不动|不(?:要)?移动镜头|不得运镜|\blocked[ -]?off\b/i.test(cameraRaw);
  if (hardStatic && !cameraModes.includes("static")) cameraModes.push("static");
  const lightRaw = [get("lighting"), get("scene"), get("sceneDescription")].map(shotText).join("；");
  const lightPositive = splitShotAssertions(lightRaw).positive;
  const lightSources = keysMatching(lightPositive, [
    ["window", /窗光|窗边柔光|(?:光|光线).{0,8}(?:窗|窗户)|(?:窗|窗户).{0,8}(?:洒入|照入|斜射|透入|柔光)/],
    ["daylight", /日光|阳光|天光|自然光|晨光|夕阳|日落|sunlight|daylight/i],
    ["candle", /烛光|点燃.{0,4}蜡烛|火光|篝火|candlelight/i], ["tungsten", /钨丝|白炽灯|tungsten/i],
    ["neon", /霓虹|\bneon\b/i], ["stage", /追光|舞台光|舞台灯|spotlight/i],
    ["practical", /灯光|暖灯|吊灯|串灯|路灯|台灯|灯笼.{0,4}(?:亮|发光)/],
  ]);
  const lightDirections = keysMatching(lightPositive, [
    ["left", /(?:左侧|左边|画左).{0,8}(?:窗|光)|(?:光|照).{0,8}(?:左侧|左边|画左)/],
    ["right", /(?:右侧|右边|画右).{0,8}(?:窗|光)|(?:光|照).{0,8}(?:右侧|右边|画右)/],
    ["back", /逆光|背光|背后.{0,6}(?:照|光)|轮廓光|rim light/i], ["top", /顶光|上方.{0,6}(?:照|光)/],
  ]);
  const dialogueValue = get("dialogue");
  const lines = (Array.isArray(dialogueValue) ? dialogueValue : [dialogueValue]).map((line) => typeof line === "string" ? line : line?.text ?? line?.line ?? "")
    .filter((line) => typeof line === "string" && line.trim() && !/^(?:无|无台词|无对白|无旁白|none|silent|n\/a)[。.!！]?$/i.test(line.trim()));
  const negative = [...new Set([...all.negative, ...splitShotAssertions(shotText(get("negative") ?? get("negative_prompt"))).negative,
    ...((get("negative") || get("negative_prompt")) ? [shotText(get("negative") ?? get("negative_prompt"))] : [])])];
  const negativeText = negative.join("；");
  const depthRaw = shotText(get("depth_of_field"));
  const depthPositive = positiveText(depthRaw);
  const depthMode = /(?<!中)深景深|景深[：:]\s*深|全画面.{0,4}清晰|前景到.{0,8}(?:清晰|锐利)|deep focus/i.test(depthPositive) ? "deep"
    : /中景深|人景皆清|中浅景深|中深景深|景深[：:]\s*中|moderate/i.test(depthPositive) ? "moderate" : /浅景深|景深[：:]\s*浅|背景.{0,4}虚化|shallow/i.test(depthPositive) ? "shallow" : "unknown";
  return {
    schemaVersion: SHOT_INTENT_VERSION, sourceHash, source,
    shotId: String(get("shotId") ?? get("shot_id") ?? ""), evidence: "deterministic-text-rules",
    subject: { kind, count: declared.count ?? (hasPerson ? /双人|两人|二人|一对|情侣/.test(descriptivePositive + characterRaw) ? 2 : /多人|人群|众人|团队|合影/.test(descriptivePositive + characterRaw) ? null : 1 : 0), hasPerson, faceVisible, visibleParts, posture, eyesClosed, shotScale: close ? "close" : wide ? "wide" : hasPerson ? "medium" : "unknown" },
    camera: { modes: cameraModes, positiveText: cameraAssertions.positive, negativeConstraints: cameraAssertions.negative, hardStatic,
      pace: hardStatic ? "static" : /缓慢|慢速|匀速|slow/i.test(cameraAssertions.positive) ? "slow" : /快速|急速|fast/i.test(cameraAssertions.positive) ? "fast" : "unspecified" },
    performance: { action: action.positive, mood: positiveText(get("mood") ?? get("emotion")), pacing: positiveText(get("pacing")), dialogue: lines, hasDialogue: lines.length > 0,
      negativeConstraints: negative, forbidSmile: /笑|smil/i.test(negativeText), forbidRise: /起身|站起|站立|rise|stand up/i.test(negativeText), forbidBlink: /眨眼|睁眼|blink|open eyes/i.test(negativeText),
      walking: /行走|走动|步行|向前走|走过|漫步|缓步|缓行|走近|\bwalk/i.test(action.positive) },
    scene: { text: positiveText(get("scene") ?? get("sceneDescription") ?? get("description")), positiveText: all.positive,
      timeOfDay: keysMatching(all.positive, TIME_MARKERS), lightSources, lightDirections,
      temperatures: keysMatching(lightPositive + (/不偏色/.test(lightRaw) ? "；中性" : ""), [["warm", /暖|金色|橙色|warm/i], ["cool", /冷白|冷色|蓝色|cool/i], ["neutral", /中性|不偏色|neutral/i]]),
      depthMode, negativeConstraints: negative,
      era: shotText(get("era") ?? get("timePeriod")) || null },
  };
}

/** A supplied intent is useful only for this exact recovered source card. */
export function resolveShotIntent(card, supplied) {
  const computed = normalizeShotIntent(card);
  if (supplied !== undefined) {
    object(supplied, "显式镜头意图");
    if (supplied.schemaVersion !== SHOT_INTENT_VERSION || supplied.sourceHash !== computed.sourceHash
      || shotIntentHash(supplied) !== shotIntentHash(computed)) {
      throw new ShotIntentError("SHOT_INTENT_STALE", "显式意图与当前原始镜头不一致，必须重新归一");
    }
  }
  return computed;
}
