import { describe, expect, it } from "vitest";
import {
  AUDIO_DISCIPLINE_CLAUSE,
  AUDIO_NEGATIVE_TERMS,
  detectSceneSubstitution,
  fieldSpec,
  NEUTRAL_FALLBACK_SCENES,
  normalizeConstraintSegment,
  OPENING_EXCLUSIVE_FIELDS_LEGACY,
  normalizeStructuredFields,
  prepareShotPrompt,
  readableValue,
  REALISM_FORBIDDEN_SCENE_WORDS,
  resolutionToPixels,
  shotSpecMarkdown
} from "./shot-spec.js";

/** 25 字段的完整内容镜卡片（字段值取自真机形态，长度足够过交付闸） */
function contentCard(shotId = "S2"): Record<string, unknown> {
  const long = (label: string) => `${label}：`.padEnd(1) + "细写".repeat(30);
  return {
    shotId,
    sceneType: "establishing",
    duration: 5,
    director_instruction: "好莱坞电影级质感，写实风格，8K超高清，自然光造型，克制运镜",
    constraint: "9:16画幅，1080x1920，24fps，MP4，无文字无水印无字幕",
    baseline: "8K分辨率，电影级质感，写实，细节丰富，锐利对焦",
    scene: `${long("苏州园林清晨薄雾与明轩临水")}，白墙灰瓦，池面倒影完整，石板路湿润反光`,
    lighting: `${long("主光为侧后方晨光穿过窗棂")}，补光来自水面反射，整体明亮清晰`,
    camera_movement: `${long("0-2s 缓慢横移，2-5s 轻微下压贴近水面")}，稳定器运动，无抖动`,
    composition: `${long("竖版构图，水面占下半幅，亭台与倒影上下对称")}，主体居中偏上`,
    color_palette: `${long("墨绿与冷灰为主，暖木色点缀")}，中等饱和度，柔和对比`,
    depth_of_field: `${long("焦点落在明轩檐角与水面倒影")}，中等景深，前景适度虚化`,
    character: "旁白: human, 画外音, 无实体形象；住客: human, 年轻中性, 轻装, 背影跟拍",
    costume: `${long("住客身着浅色亚麻衬衫与深色长裤")}，面料质感真实`,
    makeup: "素颜或淡妆，妆容自然真实，肤色健康",
    action: `${long("住客沿回廊缓步而行，指尖轻触木质栏杆")}，动作自然连贯`,
    props: `${long("檐下风铃、石阶青苔、池边落叶")}，材质真实，位置符合实景`,
    portraits: ["image://characters/char_002/portraits/char_002-front.png"],
    /** vendor 交付格式：dialogueBlocks → 【台词】[Ns-Ms] 角色 触发, 情绪副词 说:"…" */
    dialogueBlocks: [{ speaker: "旁白", line: "园林的清晨，先醒的是水。", emotion: "平静地", trigger: "看向水面" }],
    dialogue: [{ speaker: "旁白", text: "园林的清晨，先醒的是水。" }],
    timeline: `${long("0-2s 建立空间关系，2-4s 推进到水面倒影")}，5s 收束于亭台轮廓`,
    mood: `${long("安静、通透、有呼吸感")}，眼神与呼吸保持平稳，肩颈放松`,
    pacing: "整体：沉稳中等节奏；开头：平缓引入；中段：自然推进；结尾：平稳收尾",
    transition: "自然切换，无特效转场，前后镜光线衔接",
    audio: `${long("环境底噪：水声、鸟鸣、远处人声")}，无明显配乐干扰`,
    negative: "no text anywhere in frame, no watermark, no logo, no subtitle, no blur, no distortion",
    bright_constraint: "bright lighting, well-lit scene, clear visibility",
    character_constraint: "只出现指定角色，禁止其他人物入镜",
    consistency: "保持角色形象、服装与园林空间跨镜头一致",
    title: "",
    subtitle: ""
  };
}

/** 片头卡片：25 字段 + 主/副标题 + 5 专属字段（= 30 字段体系） */
/**
 * 片头卡片（2026-09-26 口径）：**不再要求**主标题等 5 个片头专属字段——
 * 标题与主视觉由后期封面工位产出（`cover` 阶段），生成侧只出 25 个标准字段。
 * 这里保留 `title/subtitle` 两个内容字段（文案仍可用于封面策划），但不再有 title_* 系列。
 */
function openingCard(): Record<string, unknown> {
  return {
    ...contentCard("S1"),
    sceneType: "opening",
    title: "苏州南园宾馆",
    subtitle: "唯一可以入住的苏州园林",
  };
}

describe("字段规范真源", () => {
  it("从 vendor 读取 25 字段与长度口径（片头专属 5 字段已下线，不在 TS 层复制字面值）", () => {
    const spec = fieldSpec();
    expect(spec.p0).toHaveLength(12);
    expect(spec.p1).toHaveLength(7);
    expect(spec.p2).toHaveLength(4);
    expect(spec.p3).toHaveLength(2);
    /** 片头不再是 30 字段：主标题/副标题/标题动画/标题字体/开场音频设计 由后期封面承担 */
    expect(spec.openingExclusive).toHaveLength(0);
    expect(OPENING_EXCLUSIVE_FIELDS_LEGACY).toHaveLength(5);
    expect(spec.lengths.refinedMin).toBeGreaterThan(0);
    expect(spec.lengths.hardMax).toBeGreaterThanOrEqual(3000);
  });

  it("【约束】画幅归一：纠正 vendor 在叙事画像下硬编码的 16:9", () => {
    const prompt = "01.【约束】16:9画幅，8K分辨率，24fps，MP4格式。\n02.【场景】园林";
    const fixed = normalizeConstraintSegment(prompt, "9:16", "1080x1920");
    expect(fixed.changed).toBe(true);
    expect(fixed.prompt).toContain("【约束】9:16画幅，1080x1920，24fps，MP4格式");
    // 已是目标画幅时不重复改写
    const again = normalizeConstraintSegment(fixed.prompt, "9:16", "1080x1920");
    expect(again.changed).toBe(false);
  });

  it("【约束】画幅已对也要纠正帧率与像素，保留 MP4 后附加约束", () => {
    const prompt = "01.【约束】9:16画幅，720x1280，24fps，MP4格式，无文字无水印\n02.【场景】会客厅";
    const fixed = normalizeConstraintSegment(prompt, "9:16", "1080x1920", 30);
    expect(fixed.changed).toBe(true);
    expect(fixed.prompt).toContain("【约束】9:16画幅，1080x1920，30fps，MP4格式，无文字无水印");
    expect(fixed.prompt).not.toContain("24fps");
    expect(normalizeConstraintSegment(fixed.prompt, "9:16", "1080x1920", 30).changed).toBe(false);
    expect(() => normalizeConstraintSegment(prompt, "9:16", "1080x1920", 0)).toThrow(/帧率/);
  });

  it("逐镜提示词使用实际提交的 30fps，而非 vendor 固定的 24fps", () => {
    const report = prepareShotPrompt(contentCard(), { ratio: "9:16", resolution: "1080p", fps: 30 });
    expect(report.prompt).toMatch(/【约束】[^\n]*30fps/);
    expect(report.prompt).not.toMatch(/【约束】[^\n]*24fps/);
    expect(report.delivery.pass).toBe(true);
  });

  it("分辨率口径：1080p + 画幅 → 具体像素", () => {
    expect(resolutionToPixels("1080p", "9:16")).toBe("1080x1920");
    expect(resolutionToPixels("1080p", "16:9")).toBe("1920x1080");
    expect(resolutionToPixels("720p", "9:16")).toBe("720x1280");
    expect(resolutionToPixels("1080x1920", "9:16")).toBe("1080x1920");
  });

  /** 真机 2026-09-22：对象/数组字段被 String() 成 `[object Object]` 进提示词，每镜 3–7 处 */
  it("结构化字段归一：lighting/camera_movement/timeline 不再以 [object Object] 进提示词", () => {
    const shot = {
      ...contentCard(),
      lighting: { key_light: "主光自然光5600K", fill_light: "反光板补光", time_of_day: "清晨", atmosphere: "薄雾" },
      camera_movement: { timeline: [{ timeRange: "0-2s", cameraMovement: "缓推" }], composition: "竖版居中" },
      timeline: [
        { object: { start: "T00:00", end: "T00:02" }, string: "T00:00-T00:02 / 建立空间" },
        { object: { start: "T00:02", end: "T00:05" }, string: "T00:02-T00:05 / 推进到水面" }
      ]
    };
    const normalized = normalizeStructuredFields(shot);
    expect(typeof normalized.lighting).toBe("string");
    expect(String(normalized.lighting)).toContain("主光");
    expect(String(normalized.timeline)).toContain("建立空间");
    expect(normalized._rawTimeline).toBeDefined();

    const report = prepareShotPrompt(shot, { ratio: "9:16", log: () => undefined });
    expect(report.prompt).not.toContain("[object Object]");
    expect(report.prompt).toContain("主光");
  });

  it("readableValue：数组/对象/嵌套都可读，不产生对象字符串", () => {
    expect(readableValue(["A", "B"])).toBe("A；B");
    expect(readableValue({ string: "原样" })).toBe("原样");
    expect(readableValue({ key_light: "主光", fill_light: "补光" })).toContain("主光");
    expect(readableValue(null)).toBe("");
    expect(readableValue({ deep: { deeper: { deepest: 1 } } }, 3)).toBe("");
  });

  it("dialogueBlocks 视为台词已提供（不算缺字段）", () => {
    const shot = contentCard();
    delete shot.dialogue;
    const report = prepareShotPrompt(shot, { ratio: "9:16", log: () => undefined });
    expect(report.missingSpecFields).not.toContain("dialogue");
    expect(report.prompt).toContain("【台词】");
  });

  /** 产品口径（2026-09-23）：镜头内只允许台词/旁白/音效，禁止 BGM；配乐统一在后期加 */
  it("音频纪律：每镜提示词都带禁 BGM 子句与英文负面词", () => {
    for (const card of [contentCard(), openingCard()]) {
      const report = prepareShotPrompt(card, { ratio: "9:16", log: () => undefined });
      expect(report.prompt).toContain("【音频纪律】");
      expect(report.prompt).toMatch(/no background music/i);
      expect(report.delivery.pass).toBe(true);
    }
  });

  it("音频纪律：audio 字段里的音乐指令被剔除，不进入提示词", () => {
    const shot = contentCard();
    shot.audio = "背景音乐：钢琴长音铺底；环境声：水声与鸟鸣；配乐在1.5s进点";
    const logs: string[] = [];
    const report = prepareShotPrompt(shot, { ratio: "9:16", log: (line) => logs.push(line) });
    expect(logs.join()).toContain("剔除");
    // 清洗后只保留环境声描述 + 音频纪律子句；不得出现「背景音乐/配乐」的正面指令
    const positive = report.prompt.split("【音频纪律】")[0] ?? "";
    expect(positive).not.toContain("背景音乐：钢琴");
    expect(positive).not.toContain("配乐在1.5s进点");
    expect(report.prompt).toContain("环境声：水声与鸟鸣");
  });

  /** 真机 2026-09-23 平江路 dry-run：vendor 音频设计写「人声清晰，无配乐」，误删会丢合规表述 */
  it("音频纪律：否定式表述（「无配乐」）与纪律同向，不被误删", () => {
    const shot = contentCard();
    shot.audio = "环境声：水声与船桨声；人声清晰，无配乐喧宾";
    const logs: string[] = [];
    const report = prepareShotPrompt(shot, { ratio: "9:16", log: (line) => logs.push(line) });
    expect(report.prompt).toContain("无配乐喧宾");
    expect(logs.join()).not.toContain("剔除");
  });

  /**
   * 产品所有者 2026-09-23 听检 30s 样片后确认：**画面内实况声源（评弹/三弦等）不算 BGM**，
   * 必须保留；禁的只是镜头外加配乐。这条口径同时约束子句文本与负面词表，避免"越收越紧"。
   */
  it("音频纪律：画内实况声源（评弹/三弦/琵琶）保留，子句与负面词不越界", () => {
    const shot = contentCard();
    shot.audio = "街巷人声；远处评弹声与三弦、琵琶声；室内混响自然，无其他配乐";
    const logs: string[] = [];
    const report = prepareShotPrompt(shot, { ratio: "9:16", log: (line) => logs.push(line) });
    expect(report.prompt).toContain("评弹声");
    expect(report.prompt).toContain("三弦");
    expect(report.prompt).toContain("琵琶");
    expect(logs.join()).not.toContain("剔除");
    // 子句显式承认画内实况声；负面词不再包含会压掉实况音乐的过宽词
    expect(AUDIO_DISCIPLINE_CLAUSE).toContain("实况声源");
    expect(AUDIO_DISCIPLINE_CLAUSE).toContain("镜头外");
    expect(AUDIO_NEGATIVE_TERMS).toMatch(/no non-diegetic music/i);
    expect(AUDIO_NEGATIVE_TERMS).not.toMatch(/singing voice|no song|no melody/i);
  });

  /**
   * 写实纪律 + 场景解耦 + 路人写实（2026-09-24 产品口径，默认强制）：
   * 人物纯写实；场景/光线/色调只按本镜头描述给，不被定妆照/参考图污染；路人同样真人质感。
   */
  it("写实纪律：默认每镜都带【写实纪律】【场景解耦】【路人写实】与英文写实负面词", () => {
    for (const card of [contentCard(), openingCard()]) {
      const report = prepareShotPrompt(card, { ratio: "9:16", log: () => undefined });
      expect(report.prompt).toContain("【写实纪律】");
      expect(report.prompt).toContain("【场景解耦】");
      expect(report.prompt).toContain("【路人写实】");
      expect(report.prompt).toMatch(/no cartoon/i);
      expect(report.delivery.pass).toBe(true);
    }
  });

  it("写实纪律：卡片显式声明风格（如 anime）时豁免，并记录理由", () => {
    const shot = contentCard();
    (shot as Record<string, unknown>).style = "anime";
    const logs: string[] = [];
    const report = prepareShotPrompt(shot, { ratio: "9:16", log: (line) => logs.push(line) });
    expect(report.prompt).not.toContain("【写实纪律】");
    expect(logs.join()).toContain("写实约束豁免");
  });
});

describe("镜头卡交付闸（vendor PromptDeliveryGuard 为准）", () => {
  it("内容镜头（25 字段齐备）组装出的提示词通过交付闸", () => {
    const report = prepareShotPrompt(contentCard());
    expect(report.isOpening).toBe(false);
    expect(report.missingSpecFields).toEqual([]);
    expect(report.charCount).toBeGreaterThanOrEqual(fieldSpec().lengths.refinedMin);
    expect(report.charCount).toBeLessThanOrEqual(fieldSpec().lengths.hardMax);
    expect(report.delivery.issues).toEqual([]);
    expect(report.delivery.pass).toBe(true);
  });

  it("片头镜头不再要求 5 个专属字段：25 字段齐备即过闸（标题由后期封面产出）", () => {
    const report = prepareShotPrompt(openingCard());
    expect(report.isOpening).toBe(true);
    expect(report.missingOpeningFields).toEqual([]);
    expect(report.missingSpecFields).toEqual([]);
    expect(report.delivery.pass).toBe(true);
  });

  it("片头提示词**不含**标题段落（生成侧不产标题，避免中文字形不可控 + 后期换标题要重渲）", () => {
    const report = prepareShotPrompt(openingCard());
    for (const label of ["【主标题内容】", "【副标题内容】", "【标题动画设计】", "【标题字体设计】", "【开场音频设计】"]) {
      expect(report.prompt).not.toContain(label);
    }
  });

  it("缺 P0 字段（如 scene）→ 交付闸 fail 并列出缺字段", () => {
    const broken = contentCard();
    delete broken.scene;
    const report = prepareShotPrompt(broken);
    expect(report.missingSpecFields).toContain("scene");
    expect(report.delivery.pass).toBe(false);
  });

  /**
   * 无台词镜（2026-09-25 南昌片真机）：快剪城市片里的人只做动作、不说话，
   * 卡片显式声明 `dialogueFree: true` 即视为满足台词字段；不声明又没台词仍然判缺。
   */
  it("显式声明无台词（dialogueFree:true）→ 不再被判缺台词字段", () => {
    const silent = contentCard("S9");
    delete (silent as Record<string, unknown>).dialogue;
    delete (silent as Record<string, unknown>).dialogueBlocks;
    (silent as Record<string, unknown>).dialogueFree = true;
    const report = prepareShotPrompt(silent);
    expect(report.missingSpecFields).not.toContain("dialogue");
    /** 且提示词里不得残留空【台词】段（交付守卫会判"疑似虚构台词"） */
    expect(report.prompt).not.toMatch(/【台词】\s*$/m);
    expect(report.delivery.issues.join("；")).not.toContain("疑似虚构");

    const undeclared = contentCard("S10");
    delete (undeclared as Record<string, unknown>).dialogue;
    delete (undeclared as Record<string, unknown>).dialogueBlocks;
    const undeclaredReport = prepareShotPrompt(undeclared);
    expect(undeclaredReport.missingSpecFields).toContain("dialogue");
  });

  it("已达标的管线定稿 prompt 直接复用（不重复组装）", () => {
    const assembled = prepareShotPrompt(contentCard());
    const withPrompt = { ...contentCard(), prompt: assembled.prompt };
    const report = prepareShotPrompt(withPrompt);
    expect(report.promptSource).toBe("pipeline");
    expect(report.prompt).toBe(assembled.prompt);
    expect(report.delivery.pass).toBe(true);
  });

  it("内容红线：科幻/微观意象命中即不合格，可显式放行", () => {
    const drifted = contentCard();
    drifted.scene = "显微镜下细胞质，推入1927年蒋公馆雕花红木桌椅";
    const hit = prepareShotPrompt(drifted);
    expect(hit.redlines.length).toBeGreaterThan(0);

    const allowed = prepareShotPrompt(drifted, { allowRedlines: hit.redlines });
    expect(allowed.redlines).toEqual([]);
  });

  it("规范报告渲染成 Markdown（片头与内容同为 25 字段口径）", () => {
    const reports = [prepareShotPrompt(contentCard("S2")), prepareShotPrompt(openingCard())];
    const md = shotSpecMarkdown(reports);
    /** 片头不再有 5 个专属字段：报告里片头也是 25 字段口径，并在表头写明口径变更 */
    expect(md).toContain("片头(25)");
    expect(md).toContain("内容(25)");
    expect(md).toContain("字段规范来源");
    expect(md).toContain("片头不再有 5 个专属字段");
  });
});

/**
 * 【场景】替换/漂移检测（T-2026-0926-0007 真机缺口）。
 *
 * 背景：真机 VID-GR01 的 GR-03 卡片写的是「打烊后的店铺前厅 + 门外虚化的街道霓虹」，
 * vendor 写实校验命中禁用词「霓虹」后把整段【场景】替换成中立模板「简约室内房间…」，
 * 且不写任何日志——只能靠监制看画面与卡片不符打回，白烧一轮出图。
 */
describe("【场景】写实校验替换检测", () => {
  it("纯函数：组装后就是 vendor 中立兜底模板 → 判替换，并给出命中的禁用词", () => {
    const result = detectSceneSubstitution(
      "打烊后的店铺前厅，柜台、玻璃门与门外虚化的街道霓虹",
      NEUTRAL_FALLBACK_SCENES[2]!
    );
    expect(result.substituted).toBe(true);
    expect(result.reason).toContain("中立兜底模板");
    expect(result.hits).toContain("霓虹");
  });

  it("纯函数：文本完全一致 → 判一致", () => {
    const scene = "现代写字楼高层的办公室，落地窗外是黄昏转入夜色的城市天际线";
    const result = detectSceneSubstitution(scene, scene);
    expect(result.substituted).toBe(false);
    expect(result.overlap).toBeCloseTo(1, 5);
  });

  it("纯函数：重合度过低（明显被换掉）→ 判漂移", () => {
    const result = detectSceneSubstitution(
      "深夜客服工位，三块屏幕与耳机",
      "白墙木地板客厅，沙发与茶几"
    );
    expect(result.substituted).toBe(true);
    expect(result.reason).toContain("不一致");
  });

  it("纯函数：场景缺失 → 不误报（无法比对时不得凭空判替换）", () => {
    expect(detectSceneSubstitution("", "任意场景").substituted).toBe(false);
    expect(detectSceneSubstitution("任意场景", "").substituted).toBe(false);
  });

  it("禁用词表与 vendor 写实校验口径一致（含霓虹/投影等关键条目）", () => {
    expect(REALISM_FORBIDDEN_SCENE_WORDS).toContain("霓虹");
    expect(REALISM_FORBIDDEN_SCENE_WORDS).toContain("投影");
    expect(REALISM_FORBIDDEN_SCENE_WORDS).toContain("元宇宙");
  });

  it("真机链路：卡片场景含「霓虹」→ 报告显式标记 sceneSubstituted，并保留前后文本", () => {
    const card = contentCard("S9");
    card.scene = "打烊后的店铺前厅，柜台、玻璃门与门外虚化的街道霓虹";
    const report = prepareShotPrompt(card);
    expect(report.sceneSubstituted).toBe(true);
    expect(report.sceneSubstitution?.from).toContain("霓虹");
    expect(report.sceneSubstitution?.to).not.toContain("霓虹");
  });

  it("真机链路：正常场景卡片 → 不标记替换", () => {
    const report = prepareShotPrompt(contentCard("S10"));
    expect(report.sceneSubstituted).toBe(false);
    expect(report.sceneSubstitution?.reason).toContain("一致");
  });
});
