/**
 * 第四轮注入审计回归（2026-09-25 · T-2026-0925-KBAUDIT）
 *
 * 本文件把 playbook 第四节的 36 场景标答（第三轮 24 + 扩展 12）与
 * 12 条反例（A2 不该命中 / A3 措辞归属 / A5 否词）钉成回归。
 * 期望值来自 KB 原文（OPTICS-001 第二/三/八节、LIGHT-001/002/003、PHYS-002 等），
 * 不是"照抄当前输出"——改注入规则时若与本文件冲突，先回去读 KB 原文再决定改哪边。
 *
 * 第四轮修掉的四类根因（详见 docs/cinematography-kb-audit-round4.md）：
 *   ① 关键帧提示词不含 depth_of_field，且【规格】行硬编码"浅景深"（落地层，见 plate-prompt.ts）
 *   ② 夜景人像档位效果词落回 f/1.2–f/1.4，带出真机翻车词"主体悬浮感"
 *   ③ 室内兜底（钨丝灯/混合色温）抢掉卡片明写的窗光/阴天/正午
 *   ④ LIGHT-003/PHYS-002 里点名的行（车轨长曝/舞台追光/烟花夜空/玻璃反射）此前没有任何规则引用
 */
import { describe, expect, it } from "vitest";
import {
  enrichShotCard, injectionContext, loadKb, parseApertureKnowledge, recommendAperture, sanitizeApertureEffect
} from "./core.mjs";

const kb = loadKb(new URL("../../library/cinematography-kb", import.meta.url).pathname);
type Card = Record<string, unknown>;
const light = (card: Card): string =>
  enrichShotCard(kb, card).trace.applied.find((a: { field: string }) => a.field === "lighting")?.added ?? "";
const props = (card: Card): string =>
  enrichShotCard(kb, card).trace.applied.filter((a: { field: string }) => a.field === "props").map((a: { added: string }) => a.added).join(" ");
const apertureOf = (card: Card): string => recommendAperture(kb, card)?.aperture ?? "";
const appliedText = (card: Card): string =>
  enrichShotCard(kb, card).trace.applied.map((a: { added: string }) => a.added).join(" | ");

/** 36 场景标答：[编号, 卡片, 期望光圈档, 容忍原因/备注] */
const MATRIX: Array<[string, Card, string, string?]> = [
  ["① 正午硬光户外人像", { scene: "正午烈日下的广场，白墙反光强烈", character: "陈卓", action: "站在广场中央", mood: "炎热" }, "f/2.8–f/4"],
  ["② 逆光剪影（有意）", { scene: "日落逆光，人物呈剪影，天空金橙", character: "陈卓", action: "站在堤岸上", mood: "史诗" }, "f/1.4–f/2.0", "KB 缺剪影专档（G1）"],
  ["③ 蓝调时刻城市", { scene: "蓝调时刻的江边，城市灯光刚亮", character: "陈卓", action: "凭栏远眺", mood: "安静" }, "f/2.8–f/4"],
  ["④ 阴天户外街拍", { scene: "阴天的老街，白墙灰瓦，行人稀疏", character: "陈卓", action: "走过街口", mood: "纪实" }, "f/2.8–f/4"],
  ["⑤ 雨天夜景霓虹", { scene: "雨夜街头，霓虹倒影在积水里", character: "陈卓", action: "撑伞走过", mood: "赛博未来" }, "f/1.4–f/1.8"],
  ["⑥ 雪天清晨", { scene: "雪后的古镇清晨，屋顶积雪，河面薄冰", character: "陈卓", action: "踩雪缓行", mood: "安静" }, "f/2.8–f/4"],
  ["⑦ 雾天湖面", { scene: "浓雾中的湖面，远处岛影朦胧", character: "陈卓", action: "立于船头", mood: "神秘" }, "f/8–f/11"],
  ["⑧ 烛光晚餐", { scene: "室内烛光晚餐，桌面有烛台与餐具", character: "陈卓", action: "举杯", mood: "浪漫" }, "f/1.4–f/1.8"],
  ["⑨ 夜晚车轨", { scene: "夜晚高架桥，车流拉出光轨", mood: "都市" }, "f/8–f/16"],
  ["⑩ 星空银河", { scene: "无光污染的星空银河，前景是帐篷", mood: "史诗" }, "f/1.4–f/2.8"],
  ["⑪ 沙漠驼队", { scene: "黄昏的沙漠，驼队剪影", mood: "史诗" }, "f/8–f/11"],
  ["⑫ 水下镜头", { scene: "水下，光线折射，气泡上升", mood: "梦幻" }, "f/5.6", "KB 缺水下专档（G2）"],
  ["⑬ 微距昆虫", { scene: "微距镜头下的露珠与昆虫", mood: "科普" }, "f/8–f/16"],
  ["⑭ 美食蒸汽（无人物）", { scene: "砂锅里的汤翻滚，蒸汽升起", mood: "诱人" }, "f/2.8"],
  ["⑮ 产品广告（静物）", { scene: "白背景上的香水瓶，硬光反光", mood: "高级感" }, "f/2.0–f/2.8"],
  ["⑯ 零售门店实景", { scene: "服装店内景，衣架与试衣镜", character: "陈卓", action: "挑选衣服", mood: "明亮" }, "f/2.8–f/4"],
  ["⑰ 办公室 vlog", { scene: "办公室工位，显示器与绿植", character: "陈卓", action: "坐下打开电脑", mood: "日常" }, "f/2.8–f/4"],
  ["⑱ 医院走廊", { scene: "医院走廊，冷白光，长焦纵深", mood: "紧张" }, "f/8"],
  ["⑲ 婚礼仪式", { scene: "户外婚礼草坪，白色花门", character: "陈卓", action: "交换戒指", mood: "浪漫" }, "f/2.8–f/4"],
  ["⑳ 体育竞技", { scene: "田径场跑道，运动员起跑", mood: "活力" }, "f/4–f/5.6", "KB 缺体育专档（G3），取边走边拍行"],
  ["㉑ 儿童生日会", { scene: "室内生日会，蛋糕与彩带", mood: "欢乐" }, "f/5.6–f/8"],
  ["㉒ 老年人物肖像", { scene: "室内，窗边柔光，老人坐在藤椅上", mood: "怀旧" }, "f/2.8–f/4"],
  ["㉓ 航拍梯田", { scene: "航拍清晨梯田云海", mood: "史诗" }, "f/8–f/11"],
  ["㉔ 棚拍纯色背景", { scene: "影棚纯灰背景，硬光打亮模特", character: "陈卓", action: "正面站立", mood: "时尚" }, "f/1.4–f/2.0"],
  ["㉕ 逆光人像（非剪影）", { scene: "傍晚的河边，人物被夕阳从背后照亮但面部有补光", character: "陈卓", action: "侧身站立微笑", mood: "温暖" }, "f/1.4–f/2.0"],
  ["㉖ 阴天室内茶室", { scene: "阴天的茶室内，木格窗外是青瓦白墙", character: "陈卓", action: "端起茶杯轻抿", mood: "安静" }, "f/2.8–f/4"],
  ["㉗ 正午室内窗光", { scene: "正午的室内，强光从窗户斜射进来照在桌面", character: "陈卓", action: "伏案写字", mood: "日常" }, "f/2.8–f/4"],
  ["㉘ 秋日落叶人像", { scene: "秋日银杏大道，满地落叶，逆光下叶片透光", character: "陈卓", action: "抬手接住飘落的叶子", mood: "治愈" }, "f/2.8–f/4"],
  ["㉙ 雨后石板路反光", { scene: "雨后的古镇石板路，积水倒映着白墙黛瓦", mood: "清新" }, "f/5.6", "无主体街道，KB 无专档"],
  ["㉚ 舞台追光", { scene: "剧场舞台，追光打在演唱者身上，四周漆黑", mood: "史诗" }, "f/2.8–f/4", "演唱者是明确人物主体，使用人像兜底"],
  ["㉛ 节日烟花", { scene: "跨年夜的城市上空，烟花绽放", mood: "庆典" }, "f/5.6", "KB 缺烟花专档（G12）"],
  ["㉜ 玻璃幕墙反光", { scene: "写字楼玻璃幕墙映出街景与云层", mood: "都市" }, "f/8"],
  ["㉝ 大面积水面日落", { scene: "日落时分的大面积湖面，天光云影倒映水中", mood: "壮阔" }, "f/8–f/11"],
  ["㉞ 街拍抓拍（无摆拍）", { scene: "工作日午后的商业街，路人匆匆走过", character: "陈卓", action: "边走边看手机", mood: "纪实" }, "f/2.8–f/4"],
  ["㉟ 夜景车流延时", { scene: "夜景车流延时，车灯拖出长线", mood: "都市" }, "f/8–f/16"],
  ["㊱ 海雾晨光", { scene: "海边的清晨，海雾弥漫，晨光穿透雾气", mood: "静谧" }, "f/8–f/11"]
];

describe("第四轮审计 · 36 场景标答矩阵", () => {
  for (const [label, card, expected, note] of MATRIX) {
    it(`${label} → ${expected}${note ? `（${note}）` : ""}`, () => {
      expect(apertureOf(card), label).toBe(expected);
      const text = appliedText(card);
      /** A7：任何注入短语都不得含退化哨兵或未实例化占位符 */
      expect(text, `${label} 注入含退化哨兵`).not.toMatch(/NaN|undefined|\[object Object\]|\[[^\]\n]{1,12}\]/);
      /** A9：字段级一条、总量 ≤5 */
      const { trace } = enrichShotCard(kb, card);
      const injected = trace.applied.filter((a: { field: string }) => a.field !== "depth_of_field");
      expect(injected.length, `${label} 注入条数`).toBeLessThanOrEqual(5);
      expect(new Set(injected.map((a: { field: string }) => a.field)).size, `${label} 字段重复`).toBe(injected.length);
    });
  }

  it("落「打卡 f/5.6」的场景不超过 4 个（修复前是 6 个，且都是已登记 KB 缺口）", () => {
    const stuck = MATRIX.filter(([, card]) => apertureOf(card) === "f/5.6").map(([label]) => label);
    expect(stuck).toEqual(["⑫ 水下镜头", "㉙ 雨后石板路反光", "㉛ 节日烟花"]);
  });

  it("matchedBy 溯源标签能区分三种兜底（A10 可溯源）", () => {
    expect(recommendAperture(kb, { scene: "室内，窗边柔光，老人坐在藤椅上" })?.matchedBy).toBe("person-fallback");
    expect(recommendAperture(kb, { scene: "水下，光线折射，气泡上升" })?.matchedBy).toBe("fallback-default");
    expect(recommendAperture(kb, { scene: "白背景上的香水瓶，硬光反光", mood: "高级感" })?.matchedBy).toBe("subject-fallback");
  });
});

describe("第四轮修复 · 档位效果词不得带出真机翻车词", () => {
  it("夜景人像档（f/1.4–f/1.8 与第二档位表零重叠）不再拿到「主体悬浮感」", () => {
    for (const card of [
      { scene: "室内烛光晚餐，桌面有烛台与餐具", character: "陈卓", action: "举杯", mood: "浪漫" },
      { scene: "雨夜街头，霓虹倒影在积水里", character: "陈卓", action: "撑伞走过", mood: "赛博未来" }
    ]) {
      const verdict = recommendAperture(kb, card)!;
      expect(verdict.aperture).toBe("f/1.4–f/1.8");
      expect(verdict.effectZh, "夜景人像不得写主体悬浮感（真机监制打回过的翻车信号）").not.toContain("悬浮");
      expect(verdict.effectZh, "仍要保留虚化/光斑语义").toContain("虚化");
    }
  });

  it("sanitizeApertureEffect 只剔除禁用短句，其余措辞保持 KB 原文", () => {
    expect(sanitizeApertureEffect("奶油般虚化、梦幻光斑、主体悬浮感（极浅景深）")).toBe("奶油般虚化、梦幻光斑（极浅景深）");
    expect(sanitizeApertureEffect("柔和虚化、主体突出、电影感（很浅景深）")).toBe("柔和虚化、主体突出、电影感（很浅景深）");
    expect(sanitizeApertureEffect("主体悬浮感")).toBe("");
  });

  it("正常档位效果词不受影响（f/2.0–2.8 与 f/8 档原样）", () => {
    expect(recommendAperture(kb, { scene: "白背景上的香水瓶，硬光反光", mood: "高级感" })!.effectZh).toBe("柔和虚化、主体突出、电影感（很浅景深）");
    expect(recommendAperture(kb, { scene: "航拍清晨梯田云海", mood: "史诗" })!.effectZh).toBe("全画面锐利、细节丰富（较深景深）");
  });
});

describe("第四轮修复 · 显式光源优先于室内兜底（A3/A6）", () => {
  it("室内 + 窗光 → 柔美窗光，不得写钨丝灯", () => {
    const text = light({ scene: "室内，窗边柔光，老人坐在藤椅上", mood: "怀旧" });
    expect(text).toContain("窗");
    expect(text).not.toContain("钨丝灯");
  });

  it("阴天室内 → 阴天软光，不得写钨丝灯或午后阳光", () => {
    const card = { scene: "阴天的茶室内，木格窗外是青瓦白墙", character: "陈卓", action: "端起茶杯轻抿" };
    const text = light(card);
    expect(text).toContain("阴天");
    expect(text).not.toContain("钨丝灯");
    expect(text).not.toContain("午后阳光");
  });

  it("正午侧窗的强光保持窗光来源，不改为顶光或窗外蓝调天光", () => {
    const text = light({ scene: "正午的室内，强光从窗户斜射进来照在桌面", character: "陈卓", action: "伏案写字" });
    expect(text).toContain("窗户");
    expect(text).not.toMatch(/顶光|柔和|面部/);
    expect(text).not.toContain("蓝调");
  });

  it("烛光保持烛光；钨丝灯必须源卡明确存在", () => {
    const candle = light({ scene: "室内烛光晚餐，桌面有烛台与餐具", character: "陈卓", action: "举杯" });
    expect(candle).toContain("烛光");
    expect(candle).not.toContain("钨丝灯");
    expect(light({ scene: "室内，钨丝灯照亮房间" })).toContain("钨丝灯");
  });
});

describe("第四轮修复 · KB 点名但此前无规则引用的行（A1 召回）", () => {
  it("车轨/长曝 → LIGHT-003 车轨长曝", () => {
    expect(light({ scene: "夜晚高架桥，车流拉出光轨", mood: "都市" })).toContain("光轨");
    expect(light({ scene: "夜景车流延时，车灯拖出长线", mood: "都市" })).toContain("光轨");
  });

  it("舞台/追光 → LIGHT-003 舞台追光", () => {
    expect(light({ scene: "剧场舞台，追光打在演唱者身上，四周漆黑", mood: "史诗" })).toContain("追光");
  });

  it("烟花 → LIGHT-003 烟花夜空（需要夜间语境）", () => {
    expect(light({ scene: "跨年夜的城市上空，烟花绽放", mood: "庆典" })).toContain("烟花");
    expect(injectionContext({ scene: "跨年夜的城市上空，烟花绽放" }).night).toBe(true);
  });

  it("玻璃幕墙 → PHYS-002 玻璃反射 + 建筑档 f/8", () => {
    const card = { scene: "写字楼玻璃幕墙映出街景与云层", mood: "都市" };
    expect(props(card)).toContain("玻璃");
    expect(apertureOf(card)).toBe("f/8");
  });

  it("海雾/海岸等纯风光兜底不再落打卡档（有人物时仍走人像档）", () => {
    expect(apertureOf({ scene: "海边的清晨，海雾弥漫，晨光穿透雾气", mood: "静谧" })).toBe("f/8–f/11");
    expect(apertureOf({ scene: "湖边的陈卓，半身入画", character: "陈卓" })).toBe("f/2.8–f/4");
  });
});

describe("第四轮修复 · 解析层（A1/A10）", () => {
  const cine2 = kb.topics.find((t) => t.id === "CINE-002")!;

  it("参数配方表（CINE-002 6.3 组合公式）不再被当 prompt 条目吸收", () => {
    expect(cine2.entries.some((e: { section: string }) => /6\.3/.test(e.section))).toBe(false);
    expect(cine2.entries.some((e: { intent: string }) => e.intent === "想要的效果")).toBe(false);
    /** 6.3 的 6 行（1 表头 + 5 数据行）在结构识别下被整表跳过；unknownTables 只兜底"连分隔线都没有"的表 */
    expect(cine2.entries.length).toBe(17);
    expect(Array.isArray(cine2.unknownTables)).toBe(true);
  });

  it("全库条目不再夹带 markdown 加粗记号", () => {
    for (const t of kb.topics) {
      for (const e of t.entries) {
        expect(e.intent, `${t.id} intent 夹带加粗记号`).not.toMatch(/\*\*/);
        expect(e.zh, `${t.id} zh 夹带加粗记号`).not.toMatch(/\*\*/);
      }
    }
  });

  it("中文提示词写法里不出现 f 值/millimeter 等单位（参数配方污染池清空）", () => {
    const polluted = kb.topics.flatMap((t) =>
      t.entries.filter((e: { zh: string }) => /f\/\d/.test(e.zh)).map((e: { intent: string }) => `${t.id}#${e.intent}`)
    );
    expect(polluted).toEqual([]);
  });

  it("OPTICS-001 第八节决策树 6 个叶子全覆盖（5 档位型 + 1 方向型）", () => {
    const ak = parseApertureKnowledge(kb)!;
    expect(ak.rules.length).toBe(5);
    expect(ak.directionRules.length).toBe(1);
    expect(ak.rules.map((r: { aperture: string }) => r.aperture)).toContain("f/1.4–f/2.8");
    expect(ak.rules.map((r: { intent: string }) => r.intent)).toContain("夜晚/暗光手持");
    expect(ak.directionRules.map((r: { intent: string }) => r.intent)).toContain("运镜叙事/焦点转移");
  });

  it("第三节要点行全部进场景表（18 条，含星空/微距两个早年漏掉的）", () => {
    const ak = parseApertureKnowledge(kb)!;
    expect(ak.scenarios.length).toBe(18);
    expect(ak.scenarios.some((s: { label: string }) => s.label.includes("星空银河"))).toBe(true);
    expect(ak.scenarios.some((s: { label: string }) => s.label.includes("微距"))).toBe(true);
  });
});

describe("第四轮审计 · 12 条反例（A2/A3/A5 不得命中）", () => {
  const NEGATIVES: Array<[string, Card, string[]]> = [
    ["N1 水下不得注入镜面倒影", { scene: "水下，光线折射，气泡上升", mood: "梦幻" }, ["镜面"]],
    ["N2 雪地冰面不得注入镜面倒影", { scene: "雪后的古镇清晨，河面薄冰", character: "陈卓" }, ["镜面"]],
    ["N3 白天巷口灯笼不是夜景", { scene: "平江路支巷，巷口挂着一串红灯笼，天光从巷口落下", action: "停下脚步侧头倾听" }, ["夜景", "霓虹"]],
    ["N4 空镜不得走人像档", { scene: "医院走廊，冷白光，长焦纵深", mood: "紧张" }, []],
    ["N5 无光污染星空不得写奶油虚化", { scene: "无光污染的星空银河，前景是帐篷", mood: "史诗" }, ["奶油"]],
    ["N6 固定机位不得注入摇摄", { scene: "石拱桥桥头", camera_movement: "固定机位，不横移不环绕", action: "正面走近" }, ["摇摄", "横移"]],
    ["N7 其他里的他不算人物", { scene: "其他摊位都已收摊，石板路积水反光", mood: "冷清" }, []],
    ["N8 糖粥不得注入咖啡热气", { scene: "老字号茶食铺，桂花糖粥与海棠糕，蒸汽升起", mood: "诱人" }, ["咖啡"]],
    ["N9 白天灯笼不得注入烛火特写", { scene: "白天支巷挂着一排红灯笼，天光落在青石板上", mood: "安静" }, ["烛火", "烛光"]],
    ["N10 产品白背景不得注入镜面倒影", { scene: "白色背景上的香水瓶，硬光高反光", mood: "高级感" }, ["镜面"]],
    ["N11 体育不得注入车轨/长曝", { scene: "田径场跑道，运动员起跑", mood: "活力" }, ["车轨", "光轨", "星芒"]],
    ["N12 阴天室内不得写午后阳光", { scene: "阴天的茶室内，木格窗外是青瓦白墙", character: "陈卓", action: "端起茶杯轻抿" }, ["午后阳光"]]
  ];

  for (const [label, card, forbidden] of NEGATIVES) {
    it(label, () => {
      const text = appliedText(card);
      for (const token of forbidden) expect(text, `${label} 命中禁词 ${token}`).not.toContain(token);
    });
  }

  it("空镜与收摊场景不得落人像浅景深档", () => {
    expect(apertureOf({ scene: "医院走廊，冷白光，长焦纵深", mood: "紧张" })).toBe("f/8");
    expect(apertureOf({ scene: "其他摊位都已收摊，石板路积水反光", mood: "冷清" })).not.toBe("f/1.4–f/2.0");
  });
});
