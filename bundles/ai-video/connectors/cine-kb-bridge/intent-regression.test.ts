import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { applyMicromotion } from "../../../../packages/video-studio/src/micromotion.js";
import { detectContext, enrichShotCard, injectionContext, loadKb, recommendAperture, selectEntries } from "./core.mjs";
import { normalizeShotIntent, restoreShotContributions } from "./shot-intent.mjs";

const kb = loadKb(new URL("../../library/cinematography-kb", import.meta.url).pathname);
const added = (card: Record<string, unknown>, field?: string) => enrichShotCard(kb, card).trace.applied
  .filter((entry: { field: string; writtenChars: number }) => entry.writtenChars > 0 && (!field || entry.field === field))
  .map((entry: { written: string }) => entry.written).join("；");

describe("摄影知识遵守主体、动作与运镜", () => {
  it.each([
    { scene: "手表商品微距", camera_movement: "缓慢推近", composition: "特写", portraits: [] },
    { scene: "无人会议室空镜", character: "默认女主", composition: "特写" },
    { scene: "鹰的眼睛", composition: "特写" },
  ])("无人/商品/动物不能因景别变成人物：%j", (card) => {
    expect(normalizeShotIntent(card).subject.hasPerson).toBe(false);
    expect(injectionContext(card).person).toBe(false);
    expect(detectContext(card).subject).not.toContain("person");
    expect(added(card)).not.toMatch(/人物|人像|面部|肤感|全身|发丝|人景皆清/);
    expect(recommendAperture(kb, card)?.scenarioLabel).not.toMatch(/人像|单人|合影/);
  });

  it("商品推近保留镜头动作，不把目标改成人物面部", () => {
    const card = { scene: "手表商品", camera_movement: "缓慢推近" };
    expect(added(card, "camera_movement")).toContain("推近");
    expect(added(card)).not.toContain("人物面部");
    expect(enrichShotCard(kb, card).trace.applied.find((entry: { field: string }) => entry.field === "camera_movement").adaptation).toBeTruthy();
  });

  it("横移不是摇镜；摇镜不暗加左到右方向或全景", () => {
    expect(added({ scene: "手表商品", camera_movement: "缓慢横移" }, "camera_movement")).not.toContain("摇摄");
    expect(added({ scene: "室内", camera_movement: "从右向左缓慢摇镜", composition: "近景" }, "camera_movement")).toBe("镜头缓慢从右向左摇摄");
    expect(added({ scene: "室内", camera_movement: "缓慢摇镜" }, "camera_movement")).toBe("镜头缓慢摇摄");
  });

  it("固定机位与动作字段的走路不能制造镜头跟拍", () => {
    const card = { scene: "女人在屋内", action: "缓步向前走，不要回头", camera_movement: "锁定机位，不推近，不环绕" };
    const text = added(card, "camera_movement");
    expect(text).not.toMatch(/推近|跟随|摇摄|环绕/);
    expect(added(card, "composition")).not.toMatch(/回头|行走/);
  });

  it("不可见面部不添加肤质；衣物里的行走不触发人物行走", () => {
    const card = { scene: "女人背影", action: "坐着观察", composition: "近景", costume: "丝绸在行走中有自然光泽" };
    expect(added(card, "makeup")).toBe("");
    expect(injectionContext(card).walking).toBe(false);
  });

  it("固定机位不制造场内运动；航拍不制造向前飞；快速推近不被减速", () => {
    expect(added({ scene: "女人坐在房间里", camera_movement: "固定机位", action: "保持静止" }, "camera_movement")).not.toMatch(/自行运动|元素|光线变化/);
    expect(added({ scene: "群山空镜", camera_movement: "航拍悬停俯瞰" }, "camera_movement")).not.toContain("向前");
    const quick = added({ scene: "手表商品", camera_movement: "快速推近" }, "camera_movement");
    expect(quick).toContain("快速");
    expect(quick).not.toMatch(/缓慢|缓缓/);
  });
});

describe("摄影知识遵守时段、光源方向、色温和景深", () => {
  it("普通白天办公室不制造混合蓝调或钨丝光", () => {
    expect(added({ scene: "白天办公室空镜，房间明亮" }, "lighting")).not.toMatch(/蓝调|钨丝|暖黄/);
  });

  it.each([
    ["暖色自然光从右侧窗户照入", "右侧窗户"],
    ["柔和窗光照入", "窗户"],
  ])("窗光保原方向且不添加默认左窗：%s", (lighting, expected) => {
    const text = added({ scene: "商品在桌面上", lighting }, "lighting");
    expect(text).toContain(expected);
    expect(text).not.toMatch(/左侧|面部|全身/);
  });

  it("仅有窗外景物不是窗光；未点燃蜡烛不是烛光", () => {
    const card = { scene: "室内房间，窗外是青瓦", props: "未点燃的蜡烛" };
    expect(added(card, "lighting")).toBe("");
    expect(added(card, "props")).not.toContain("烛火");
  });

  it("烛光不换成钨丝灯；日间烛光也不把时间改成夜间", () => {
    const card = { scene: "白天室内的烛光晚餐", character: "陈卓" };
    expect(added(card, "lighting")).toContain("烛光");
    expect(added(card, "lighting")).not.toContain("钨丝");
    expect(detectContext(card).timeOfDay).not.toContain("night");
    expect(injectionContext(card).night).toBe(false);
    expect(added({ scene: "夜晚室内烛光晚餐", character: "陈卓" }, "lighting")).toContain("烛光");
    expect(added({ scene: "夜晚室内烛光晚餐", character: "陈卓" }, "lighting")).not.toContain("城市灯光");
  });

  it("显式窗光优先于泛下午规则；雾天与空舞台不制造新光源", () => {
    const window = added({ scene: "下午窗边女人坐着", lighting: "自然光从右侧窗户照入" }, "lighting");
    expect(window).toContain("右侧窗户");
    expect(window).not.toContain("午后阳光");
    expect(added({ scene: "浓雾中的湖面" }, "lighting")).not.toMatch(/背后|强光/);
    expect(added({ scene: "空剧场舞台，午间自然光" }, "lighting")).not.toMatch(/追光|尘埃/);
  });

  it("暖光/中性光不追加冷蓝青橙色调，轮廓光不推断夕阳", () => {
    const warm = { scene: "夜晚室内女人站立", lighting: "暖光，不要冷白光" };
    expect(added(warm)).not.toMatch(/青橙|冷白|蓝调/);
    const rim = { scene: "手表商品在影棚", lighting: "中性轮廓光，不偏色" };
    expect(added(rim, "lighting")).toContain("轮廓光");
    expect(added(rim)).not.toMatch(/夕阳|发丝|人物|金色/);
  });

  it("明确深景深/中浅景深保留原文，不追加矛盾方向", () => {
    for (const [depth, direction] of [["深景深，前景到地平线清晰", "deep"], ["中浅景深，主体清晰", "moderate"], ["景深：浅", "shallow"]]) {
      const card = { scene: "女人的面部特写", composition: "特写", depth_of_field: depth };
      const out = enrichShotCard(kb, card);
      expect(out.card.depth_of_field).toBe(depth);
      expect(out.trace.apertureAdvisor.direction).toBe(direction);
      expect(out.trace.applied.some((entry: { field: string }) => entry.field === "depth_of_field")).toBe(false);
    }
    const authorDepth = "前后合焦范围按镜头卡保持";
    expect(enrichShotCard(kb, { scene: "女人面部特写", depth_of_field: authorDepth }).card.depth_of_field).toBe(authorDepth);
  });
});

describe("跨增强器幂等、来源变化和真实写入凭据", () => {
  const source = { shotId: "C2-01", scene: "下午窗边女人坐在椅子上", lighting: "自然光从右侧窗户照入", action: "  看书；  ", composition: "中景", camera_movement: "固定机位" };
  it("相同输入两次与 JSON 保存后相同；检索上下文也只看恢复后的原卡", () => {
    const first = enrichShotCard(kb, source);
    const second = enrichShotCard(kb, JSON.parse(JSON.stringify(first.card)));
    expect(first.trace.status).toBe("passed");
    expect(second.trace.reused).toBe(true);
    expect(JSON.stringify(second.card)).toBe(JSON.stringify(first.card));
    expect(detectContext(first.card)).toEqual(detectContext(source));
    expect(injectionContext(first.card)).toEqual(injectionContext(source));
    expect(selectEntries(kb, first.card)).toEqual(selectEntries(kb, source));
    expect(restoreShotContributions(second.card).card).toEqual(source);
  });

  it("KB→微动作→KB，原始意图与源哈希不被自有文本污染", () => {
    const a = enrichShotCard(kb, source);
    const b = applyMicromotion(a.card);
    const c = enrichShotCard(kb, b.card);
    const d = applyMicromotion(c.card);
    expect(a.trace.sourceHash).toBe(b.trace.sourceHash);
    expect(c.trace.sourceHash).toBe(a.trace.sourceHash);
    expect(d.trace.sourceHash).toBe(a.trace.sourceHash);
    expect(normalizeShotIntent(d.card)).toEqual(normalizeShotIntent(source));
    expect(restoreShotContributions(d.card).card).toEqual(source);
    expect(String(d.card.action).startsWith(source.action)).toBe(true);
  });

  it("原光源方向变化后替换旧贡献，知识库正文变化后同样重算", () => {
    const first = enrichShotCard(kb, source);
    const revised = { ...first.card, lighting: String(first.card.lighting).replace(source.lighting, "自然光从左侧窗户照入") };
    const second = enrichShotCard(kb, revised);
    expect(second.trace.sourceHash).not.toBe(first.trace.sourceHash);
    expect(second.card.lighting).not.toContain("右侧");
    const alteredKb = structuredClone(kb);
    const row = alteredKb.topics.find((topic: { id: string }) => topic.id === "LIGHT-001").entries.find((entry: { intent: string }) => entry.intent === "柔美窗光");
    row.zh = row.zh.replace("细腻", "柔和");
    const third = enrichShotCard(alteredKb, first.card);
    expect(third.trace.kbHash).not.toBe(first.trace.kbHash);
    expect(String(third.card.lighting)).not.toContain("细腻");
    expect(restoreShotContributions(third.card).card).toEqual(source);
  });

  it("长原文完整保留，整句超预算不会截半句或记为已写入", () => {
    const card = { ...source, camera_movement: "手持镜头".repeat(100) };
    const out = enrichShotCard(kb, card);
    expect(out.card.camera_movement).toBe(card.camera_movement);
    const record = out.trace.applied.find((entry: { field: string }) => entry.field === "camera_movement");
    expect(record).toMatchObject({ written: "", writtenChars: 0, dropped: "field-over-budget" });
    expect(out.trace.status).toBe("unverified");
    expect(out.trace.actualWrittenFields).not.toContain("camera_movement");
    for (const entry of out.trace.applied.filter((item: { writtenChars: number }) => item.writtenChars > 0)) {
      expect(out.card[entry.field]).toContain(entry.written);
      expect(entry.written.length).toBe(entry.writtenChars);
      expect(entry.written).not.toContain("…");
    }
  });

  it("无源/篡改/旧显式意图/结构化目标字段均未验证且保留原卡", () => {
    const first = enrichShotCard(kb, source);
    const tampered = { ...first.card, lighting: String(first.card.lighting).replace("过渡细腻", "完全过曝") };
    for (const card of [tampered, { ...source, lighting: { text: "窗光" } }, { ...source, duration: NaN }]) {
      const out = enrichShotCard(kb, card);
      expect(out.trace.status).toBe("unverified");
      expect(out.card).toEqual(card);
      expect(out.trace.applied).toEqual([]);
    }
    expect(enrichShotCard(kb, {}, {}).trace.status).toBe("unverified");
    expect(enrichShotCard(kb, { ...source, action: "起身" }, { intent: normalizeShotIntent(source) }).trace.status).toBe("unverified");
  });

  it("同进程并发无共享污染", async () => {
    const inputs = Array.from({ length: 12 }, (_, index) => ({ ...source, shotId: `SC-${index}`, lighting: index % 2 ? "右侧窗光" : "左侧窗光" }));
    const outputs = await Promise.all(inputs.map((card) => Promise.resolve(enrichShotCard(kb, card))));
    outputs.forEach((out, index) => expect(restoreShotContributions(out.card).card).toEqual(inputs[index]));
  });
});

describe("独立 Node CLI 消费同一解析器", () => {
  it("enrich 产物和回执对账；未验证给非零退出码；路径不存在有明确失败", () => {
    const dir = mkdtempSync(join(tmpdir(), "cine-kb-intent-"));
    const cli = new URL("./cli.mjs", import.meta.url).pathname;
    try {
      const input = join(dir, "shots.json");
      const output = join(dir, "out.json");
      writeFileSync(input, JSON.stringify([{ shotId: "../watch", scene: "手表商品", camera_movement: "缓慢推近" }]));
      const summary = JSON.parse(execFileSync(process.execPath, [cli, "enrich", "--shots", input, "--out", output, "--json"], { encoding: "utf8" }).split("\n").slice(1).join("\n"));
      const delivered = JSON.parse(readFileSync(output, "utf8"));
      expect(delivered.cineKbApplied).toBe(true);
      expect(summary.summary[0].status).toBe("passed");
      expect(delivered.shots[0].camera_movement).not.toContain("人物面部");
      writeFileSync(input, JSON.stringify([{}]));
      expect(spawnSync(process.execPath, [cli, "enrich", "--shots", input, "--json"]).status).toBe(3);
      const missing = spawnSync(process.execPath, [cli, "enrich", "--shots", join(dir, "missing.json")], { encoding: "utf8" });
      expect(missing.status).toBe(2);
      expect(missing.stderr).toContain("摄影知识处理失败");
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});
