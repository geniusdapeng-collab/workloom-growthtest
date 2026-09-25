/**
 * 第三轮注入审计回归（2026-09-24，24 个"意图陷阱"场景）
 *
 * 共同根因：① 兜底一律「打卡 f/5.6」；② OPTICS-001 §三 要点行解析过窄（星空/微距两行没进场景表）；
 * ③ 规则顺序（蓝调时刻被"电影感夜景"抢位）；④ "镜面倒影"触发词过宽（水下/冰面/产品白背景都命中）。
 */
import { describe, expect, it } from "vitest";
import { enrichShotCard, loadKb, recommendAperture } from "./core.mjs";

const kb = loadKb(new URL("../../library/cinematography-kb", import.meta.url).pathname);
const light = (card: Record<string, unknown>): string =>
  (enrichShotCard(kb, card).trace.applied.find((a) => a.field === "lighting")?.added ?? "");
const props = (card: Record<string, unknown>): string =>
  enrichShotCard(kb, card).trace.applied.filter((a) => a.field === "props").map((a) => a.added).join(" ");

describe("第三轮审计回归：光圈专项意图", () => {
  it("星空=最大光圈、车轨=小光圈长曝、微距=小光圈保景深", () => {
    expect(recommendAperture(kb, { scene: "无光污染的星空银河，前景是帐篷", mood: "史诗" })!.aperture).toBe("f/1.4–f/2.8");
    expect(recommendAperture(kb, { scene: "夜晚高架桥，车流拉出光轨", mood: "都市" })!.aperture).toBe("f/8–f/16");
    expect(recommendAperture(kb, { scene: "微距镜头下的露珠与昆虫", mood: "科普" })!.aperture).toBe("f/8–f/16");
  });
});

describe("第三轮审计回归：主体兜底不再一刀切", () => {
  it("产品/婚礼/儿童/航拍/棚拍各有对应档位", () => {
    expect(recommendAperture(kb, { scene: "白背景上的香水瓶，硬光反光", mood: "高级感" })!.aperture).toBe("f/2.0–f/2.8");
    expect(recommendAperture(kb, { scene: "户外婚礼草坪，白色花门", mood: "浪漫" })!.aperture).toBe("f/2.8–f/4");
    expect(recommendAperture(kb, { scene: "室内生日会，蛋糕与彩带", mood: "欢乐" })!.aperture).toBe("f/5.6–f/8");
    expect(recommendAperture(kb, { scene: "航拍清晨梯田云海", mood: "史诗" })!.aperture).toBe("f/8–f/11");
    expect(recommendAperture(kb, { scene: "影棚纯灰背景，硬光打亮模特", character: "陈卓", action: "正面站立", mood: "时尚" })!.aperture).toBe("f/1.4–f/2.0");
  });
});

describe("第三轮审计回归：光照规则互不抢位", () => {
  it("蓝调=蓝调时刻、正午=硬光、雪天=落雪（雪只注入一次）", () => {
    expect(light({ scene: "蓝调时刻的江边，城市灯光刚亮", character: "陈卓", action: "凭栏远眺" })).toContain("蓝调时刻");
    expect(light({ scene: "正午烈日下的广场，白墙反光强烈", character: "陈卓" })).toContain("正午顶光");
    /**
     * 期望值修正（2026-09-25 五轮审计）：
     * 本条原本断言「**雪后**的古镇清晨」也注入"雪花缓缓飘落"——那正是本轮判定为缺陷的行为
     * （该行原文写的是"雪花缓缓飘落"，用在雪已停的镜头上自相矛盾）。
     * 现在改为：**正在下雪**才注入「落雪安静」；雪后静景不注入（KB 无对应行，登记缺口 G18）。
     */
    expect(light({ scene: "大雪纷飞的古镇清晨，屋顶积雪", character: "陈卓" })).toContain("雪花");
    const snowEntries = enrichShotCard(kb, { scene: "大雪纷飞的古镇清晨，屋顶积雪", character: "陈卓", action: "踩雪缓行" })
      .trace.applied.filter((a) => a.added.includes("雪花"));
    expect(snowEntries.length).toBe(1);
    const afterSnow = enrichShotCard(kb, { scene: "雪后的古镇清晨，屋顶积雪，河面薄冰", character: "陈卓", action: "踩雪缓行" }).trace;
    expect(afterSnow.applied.some((a) => a.added.includes("雪花缓缓飘落")), "雪已停的镜头不得注入正在飘雪").toBe(false);
  });
});

describe("第三轮审计回归：命名角色 = 主体（不再掉进 f/5.6 打卡档）", () => {
  it("只写角色名、没有'人物/她/他'字面时，仍按人像场景选档", () => {
    expect(recommendAperture(kb, { scene: "正午烈日下的广场，白墙反光强烈", character: "陈卓", action: "站在广场中央" })!.aperture).toBe("f/2.8–f/4");
    expect(recommendAperture(kb, { scene: "雪后的古镇清晨，屋顶积雪，河面薄冰", character: "陈卓", mood: "安静" })!.aperture).toBe("f/2.8–f/4");
    expect(recommendAperture(kb, { scene: "蓝调时刻的江边，城市灯光刚亮", character: "陈卓" })!.aperture).toBe("f/2.8–f/4");
  });

  it("空镜/无人物仍然判空镜：纯空间走街拍档，不被角色兜底污染", () => {
    expect(recommendAperture(kb, { scene: "医院走廊，冷白光，长焦纵深", mood: "紧张" })!.aperture).toBe("f/8");
    expect(recommendAperture(kb, { scene: "空镜：雨夜空巷，青石板反光", character: "无（空镜）" })!.aperture).not.toBe("f/2.8–f/4");
  });

  it("体育/门店/棚拍走各自主体档，而不是一律打卡", () => {
    expect(recommendAperture(kb, { scene: "田径场跑道，运动员起跑", mood: "活力" })!.aperture).toBe("f/4–f/5.6");
    expect(recommendAperture(kb, { scene: "服装店内景，衣架与试衣镜", character: "陈卓", action: "挑选衣服", mood: "明亮" })!.aperture).toBe("f/2.8–f/4");
    expect(recommendAperture(kb, { scene: "影棚纯灰背景，硬光打亮模特", character: "陈卓", mood: "时尚" })!.aperture).toBe("f/1.4–f/2.0");
  });
});

describe("第三轮审计回归：否定语境剥离不吞主体", () => {
  it("'无光污染的星空银河'仍识别为星空专项（进光量优先，不写'奶油虚化'）", () => {
    const verdict = recommendAperture(kb, { scene: "无光污染的星空银河，前景是帐篷", mood: "史诗" })!;
    expect(verdict.aperture).toBe("f/1.4–f/2.8");
    expect(verdict.matchedBy).toBe("special-intent");
    expect(verdict.effectZh).toContain("进光量");
    expect(verdict.effectZh).not.toContain("奶油");
  });

  it("'其他'里的'他'不算人物信号", () => {
    const verdict = recommendAperture(kb, { scene: "其他摊位都已收摊，石板路积水反光", mood: "冷清" })!;
    expect(verdict.aperture).not.toBe("f/1.4–f/2.0");
  });
});

describe("第三轮审计回归：镜面倒影的语境闸", () => {
  it("水下/冰面/雪地不注入镜面倒影，平静水面才注入", () => {
    expect(props({ scene: "水下，光线折射，气泡上升", mood: "梦幻" })).not.toContain("镜面");
    expect(props({ scene: "雪后的古镇清晨，河面薄冰", character: "陈卓" })).not.toContain("镜面");
    expect(props({ scene: "无风的湖面倒影如镜，人物立于船头", character: "陈卓" })).toContain("镜面");
  });
});

/**
 * 第四轮校准（2026-09-24 晚，真机交付链暴露）：
 * ① "不横移/不环绕"里的"横移"被当成运镜要求 → 与固定机位冲突；
 * ② 上午镜头被注入"明亮的午后阳光" → 灯光时段自相矛盾；
 * ③ 知识行附带的英文括注与卡片【语言约束】（全中文）冲突 → 默认只下发中文。
 */
describe("第四轮校准：否定剥离 / 时段归属 / 语言口径", () => {
  const KNOWN_EN = /[A-Za-z]{3,}/;

  it("'不横移不环绕'不再注入摇摄（与固定机位不冲突）", () => {
    const { trace } = enrichShotCard(kb, {
      shotId: "SC-02",
      scene: "石拱桥桥头，河道与白墙黛瓦",
      lighting: "上午十点柔和散射日光，白平衡中性",
      camera_movement: "固定机位略低角度，镜头只做轻微呼吸晃动，不横移不环绕",
      action: "沿桥面正面走近镜头",
      character: "陈卓"
    });
    const movement = trace.applied.find((a) => a.field === "camera_movement")?.added ?? "";
    expect(movement).not.toContain("摇摄");
    expect(movement).not.toContain("横移");
  });

  it("上午镜头不再被注入'午后阳光'（时段口径归属明确）", () => {
    const morning = enrichShotCard(kb, {
      shotId: "SC-01", scene: "青石板主街", lighting: "上午十点柔和散射日光，白平衡中性", action: "缓步向前", character: "陈卓"
    });
    expect(morning.trace.applied.find((a) => a.field === "lighting")?.added ?? "").not.toContain("午后");
    const afternoon = enrichShotCard(kb, {
      shotId: "SC-02", scene: "石拱桥桥头", lighting: "午后斜光，方向明确", action: "沿桥面走近", character: "陈卓"
    });
    expect(afternoon.trace.applied.find((a) => a.field === "lighting")?.added ?? "").toContain("午后");
  });

  it("默认注入短语为中文（英文关键词只进 trace）；显式开启才附英文", () => {
    const card = {
      shotId: "SC-02", scene: "石拱桥桥头，河道与白墙黛瓦", lighting: "午后斜光",
      action: "沿桥面正面走近镜头", character: "陈卓", mood: "开阔"
    };
    const zhOnly = enrichShotCard(kb, card);
    for (const item of zhOnly.trace.applied) {
      expect(item.added, `${item.field} 不应夹带英文`).not.toMatch(KNOWN_EN);
    }
    const withGloss = enrichShotCard(kb, card, { englishGloss: true });
    expect(withGloss.trace.applied.some((a) => KNOWN_EN.test(a.added))).toBe(true);
  });
});
