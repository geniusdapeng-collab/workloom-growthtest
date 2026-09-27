/**
 * 第五轮注入审计回归（2026-09-25 · T-2026-0925-KBAUDIT-R5）
 *
 * 第四轮打的是"确定性注入表 + 解析层 + 落地层"。本轮专挖**前四轮没覆盖的盲区**，
 * 每条都先有运行时复现（work/kb-round5-probe*.mjs），再落成这里的不变量：
 *   ① 字段预算语义——长原文会把注入整段吃掉，却仍记在 trace 里（假回执）
 *   ② 条目打分用了**未剥否定**的原文——"避免赛博朋克"反而让赛博条目命中
 *   ③ NARR-001 情绪配方派发线索被丢弃——trace 里查不到派发了什么
 *   ④ 天气时序——"雨后/雪后"被当成"正在下"，注入与画面自相矛盾
 *   ⑤ lookBack 措辞断言了不存在的动作——静止回眸被写成"行走中回头"
 *   ⑥ 两套上下文取词字段不同——同一张卡在光圈侧与注入侧看到的世界不一样
 *   ⑦ 死规则/死配置——7 条 framing 规则永远不可能命中
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { detectContext, enrichShotCard, injectionContext, loadKb, recommendAperture, selectEntries } from "./core.mjs";

const kb = loadKb(new URL("../../library/cinematography-kb", import.meta.url).pathname);
const CORE_SRC = readFileSync(new URL("./core.mjs", import.meta.url), "utf8");
type Card = Record<string, unknown>;
const picked = (card: Card, field: string): string =>
  enrichShotCard(kb, card).trace.applied.filter((a: { field: string }) => a.field === field).map((a: { added: string }) => a.added).join(" ");
const allApplied = (card: Card): string =>
  enrichShotCard(kb, card).trace.applied.map((a: { added: string }) => a.added).join(" | ");

describe("第五轮修复 · 字段预算（不许静默吃注入，也不许改作者原文）", () => {
  const LONG = "手持机位略低角度，镜头保持轻微自然晃动".repeat(20); // 超过 320 字，显式手持才适用 handheld
  const SHORT = "手持镜头，轻微自然晃动";

  it("原文超预算：原文逐字保留，注入整条丢弃并在 trace 里如实记账", () => {
    const card = { shotId: "R5-1", scene: "江南水乡石拱桥", character: "陈卓", action: "沿桥面走近镜头", camera_movement: LONG };
    const { card: out, trace } = enrichShotCard(kb, card);
    expect(String(out.camera_movement), "卡片原文不得被截断").toBe(LONG);
    const rec = trace.applied.find((a: { field: string }) => a.field === "camera_movement");
    expect(rec.added, "注入短语仍在 trace 里留痕").toContain("晃动");
    expect(rec.dropped).toBe("field-over-budget");
    expect(rec.writtenChars).toBe(0);
    expect(rec.originalChars).toBeGreaterThan(320);
  });

  it("原文放得下：正常追加，writtenChars 与实际写入一致，无 dropped", () => {
    const card = { shotId: "R5-2", scene: "江南水乡石拱桥", character: "陈卓", action: "沿桥面走近镜头", camera_movement: SHORT };
    const { card: out, trace } = enrichShotCard(kb, card);
    const rec = trace.applied.find((a: { field: string }) => a.field === "camera_movement");
    expect(rec.dropped).toBeUndefined();
    expect(rec.writtenChars).toBeGreaterThan(0);
    expect(String(out.camera_movement)).toContain(SHORT);
    expect(String(out.camera_movement)).toContain(rec.added.slice(0, 8));
  });
});

describe("第五轮修复 · 否定语境不得参与条目打分", () => {
  it("「避免赛博朋克全息广告」不再让赛博条目命中（对照：肯定表述仍会命中）", () => {
    const base = { scene: "夜晚的江边，人物凭栏", mood: "安静" };
    const negative = { ...base, director_instruction: "避免赛博朋克全息广告的科幻感" };
    const positive = { ...base, director_instruction: "赛博朋克全息广告的未来感" };
    const cyberOf = (card: Card): string[] =>
      selectEntries(kb, card, { maxEntries: 12, minScore: 1 }).picks
        .filter((p: { intent: string; zh: string }) => /赛博|霓虹|全息|未来/.test(p.intent + p.zh))
        .map((p: { topicId: string; intent: string }) => `${p.topicId}#${p.intent}`);
    expect(cyberOf(negative)).toEqual([]);
    expect(cyberOf(positive).length, "肯定表述仍应命中（证明打分机制没被削弱）").toBeGreaterThan(0);
  });
});

describe("第五轮修复 · NARR-001 情绪配方派发线索必须落 trace", () => {
  it("mood 命中情绪 → trace.recipeDispatch 非空；未命中 → null", () => {
    const hit = enrichShotCard(kb, { shotId: "R5-3", mood: "孤独", scene: "蓝调时刻的空街" }).trace;
    expect(hit.recipeDispatch?.intent).toBe("孤独");
    expect(hit.recipeDispatch?.recipe).toContain("extreme wide shot");
    const miss = enrichShotCard(kb, { shotId: "R5-4", mood: "安静", scene: "空街" }).trace;
    expect(miss.recipeDispatch).toBeNull();
  });

  it("派发线索只做线索、不直注：NARR-001 不得出现在已注入字段的溯源里", () => {
    const trace = enrichShotCard(kb, { shotId: "R5-5", mood: "孤独", scene: "蓝调时刻的空街" }).trace;
    expect(trace.picks.some((p: { topicId: string }) => p.topicId === "NARR-001")).toBe(false);
  });
});

describe("第五轮修复 · 天气时序（正在下 vs 已经停）", () => {
  it("雨后不等于初晴；只有明确初晴才注入阳光，且不注入正在下的雨丝", () => {
    const card = { shotId: "R5-6", scene: "雨后的古镇石板路，积水倒映着白墙黛瓦", mood: "清新" };
    expect(picked(card, "lighting")).not.toContain("阳光");
    expect(picked({ ...card, scene: "雨后初晴，阳光刺破云层" }, "lighting")).toContain("雨停后");
    expect(allApplied(card)).not.toContain("雨丝如雾");
  });

  it("正在下雨仍注入雨丝；暴雨改走「暴雨倾盆」", () => {
    expect(picked({ scene: "细雨中的古镇石板路，雨丝落在积水里" }, "props")).toContain("雨丝");
    expect(picked({ scene: "暴雨中的街头，路面积水", mood: "紧张" }, "props")).toContain("暴雨");
  });

  it("雨后的夜景不套用「雨后初晴」（那行写的是阳光）", () => {
    const text = picked({ scene: "雨后的夜巷，霓虹倒映在积水里" }, "lighting");
    expect(text).not.toContain("雨停后阳光");
  });

  it("雪后不得注入正在飘雪；正在下雪仍注入「落雪安静」", () => {
    expect(allApplied({ scene: "雪后的古镇清晨，屋顶积雪，河面薄冰", character: "陈卓" })).not.toContain("雪花缓缓飘落");
    expect(picked({ scene: "大雪纷飞的古镇清晨，屋顶积雪", character: "陈卓" }, "lighting")).toContain("雪花");
  });
});

describe("第五轮修复 · 回头类动作必须真在走动", () => {
  it("静止回眸不再被写成「行走中回头」；走动回眸照旧", () => {
    const still = { scene: "室内窗前，人物静止站立", action: "回眸一笑，身体不动", camera_movement: "固定机位" };
    expect(allApplied(still)).not.toContain("行走中");
    const walking = { scene: "江南石板路", character: "陈卓", action: "沿街缓步向前走，回头看向镜头" };
    expect(picked(walking, "composition")).toContain("行走中回头");
  });
});

describe("第五轮修复 · 两套上下文共用同一张字段表", () => {
  it("时段只写在 timeline 里，光圈侧与注入侧都要看得见", () => {
    const card = { scene: "巷口", timeline: "夜晚 20:00" };
    expect(detectContext(card).timeOfDay).toContain("night");
    expect(injectionContext(card).night).toBe(true);
  });

  it("baseline / pacing 里的时段信息也要进 detectContext（统一前只有 injectionContext 看得到）", () => {
    expect(detectContext({ scene: "巷口", baseline: "夜晚的街道" }).timeOfDay).toContain("night");
    expect(detectContext({ scene: "巷口", pacing: "黄昏慢节奏" }).timeOfDay).toContain("dusk");
  });
});

describe("第五轮修复 · 规则卫生（防止再次静默失效）", () => {
  const ruleRe = /\{\s*field:\s*"([^"]+)",\s*id:\s*"([^"]+)",\s*when:[^,]+,\s*topic:\s*"([^"]+)",\s*row:\s*"([^"]+)"\s*\}/g;
  const rules = [...CORE_SRC.matchAll(ruleRe)].map((m) => ({ field: m[1], id: m[2], topic: m[3], row: m[4] }));
  const normLabel = (s: string): string => String(s).toLowerCase().replace(/[\s/／、，,]/g, "");
  const resolveRow = (topicId: string, rowLabel: string): { intent: string } | null => {
    const topic = kb.topics.find((t: { id: string }) => t.id === topicId);
    if (!topic) return null;
    const want = normLabel(rowLabel);
    return topic.entries.find((e: { intent: string }) => normLabel(e.intent) === want)
      ?? topic.entries.find((e: { intent: string }) => normLabel(e.intent).includes(want) || want.includes(normLabel(e.intent)))
      ?? null;
  };

  it("每条注入规则引用的 KB 行都真的存在（KB 改行名时必须先改规则，不许静默失效）", () => {
    expect(rules.length, "规则表解析为空=断言失效，需同步更新正则").toBeGreaterThan(40);
    const unresolved = rules.filter((r) => !resolveRow(r.topic, r.row)).map((r) => `${r.topic}#${r.row}`);
    expect(unresolved).toEqual([]);
  });

  it("不存在永远不可能命中的 framing 规则（五轮删除的死规则不得回潮）", () => {
    expect(CORE_SRC).not.toContain('id: "framing"');
    expect(rules.some((r) => r.id === "framing")).toBe(false);
  });

  it("光圈意图加词的 prefer 标签都能匹配到真实场景行（不许再出现「建筑/城市」这类死标签）", () => {
    const labels = kb.aperture.scenarios.map((s: { label: string }) => s.label);
    const prefers = [...CORE_SRC.matchAll(/prefer:\s*\[([^\]]+)\]/g)]
      .flatMap((m) => m[1].split(",").map((s) => s.trim().replace(/"/g, "")));
    const dead = [...new Set(prefers)].filter((p) => p && !labels.some((l: string) => l.includes(p)));
    expect(dead).toEqual([]);
  });

  it("KB 可达性下限：确定性规则引用到的唯一 KB 行不得少于 45 条（当前 48）", () => {
    const hit = new Set<string>();
    for (const r of rules) {
      const e = resolveRow(r.topic, r.row);
      if (e) hit.add(`${r.topic}#${e.intent}`);
    }
    expect(hit.size).toBeGreaterThanOrEqual(45);
  });
});
