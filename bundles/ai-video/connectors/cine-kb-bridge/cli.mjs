#!/usr/bin/env node
/**
 * cine-kb-cli —— 摄影知识库工位命令行（摄影指导数字员工的"手"）
 *
 * 用法：
 *   cine-kb-cli health   [--dir <知识库目录>]
 *   cine-kb-cli index    [--dir ...] [--json]                 # 19 个主题 + 缺篇报告
 *   cine-kb-cli search   --text "雨夜 孤独 人像" [--top 5]      # 意图检索（返回可直接写进提示词的词组）
 *   cine-kb-cli aperture --shot shot.json | --text "..."       # 按场景推荐光圈档 + 画面语言
 *   cine-kb-cli recipe   --emotion 孤独                         # NARR-001 情绪配方（联合检索建议）
 *   cine-kb-cli enrich   --shots shotlist.json --out enriched.json [--trace-dir dir]
 *
 * 纪律（来自知识库自身）：**提示词只写画面语言，不写 F 值/ISO/快门数值**；
 * 技术参数建议只进 trace 供监制复核。
 */
import fs from "node:fs";
import path from "node:path";
import process from "node:process";

import {
  enrichShotCard, kbStatus, loadKb, recommendAperture, selectEntries
} from "./core.mjs";

const REPO_ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "../../../..");
const DEFAULT_KB = path.resolve(REPO_ROOT, "bundles/ai-video/library/cinematography-kb");

function parseArgs(argv) {
  const positional = [];
  const flags = {};
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token.startsWith("--")) {
      const key = token.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith("--")) flags[key] = true;
      else { flags[key] = next; i += 1; }
    } else positional.push(token);
  }
  return { positional, flags };
}

const line = (text = "") => process.stdout.write(`${text}\n`);

function main() {
  const [command, ...rest] = process.argv.slice(2);
  const { flags } = parseArgs(rest);
  const kbDir = typeof flags.dir === "string" ? path.resolve(flags.dir) : DEFAULT_KB;
  const json = flags.json === true;
  if (!fs.existsSync(kbDir)) {
    process.stderr.write(`知识库目录不存在：${kbDir}\n`);
    return 2;
  }
  const kb = loadKb(kbDir);

  switch (command) {
    case "health": {
      const status = kbStatus(kb);
      line(JSON.stringify({ ...status, apertureAdvisor: kb.aperture ? { stops: kb.aperture.stops.length, scenarios: kb.aperture.scenarios.length, rules: kb.aperture.rules.length } : null }, null, 2));
      return status.ok ? 0 : 3;
    }
    case "index": {
      if (json) { line(JSON.stringify({ status: kbStatus(kb), topics: kb.topics.map((t) => ({ id: t.id, title: t.title, domain: t.domain, entries: t.entries.length, quickRefRows: t.quickRefRows })) }, null, 2)); return 0; }
      const status = kbStatus(kb);
      line(`知识库：${status.dir}`);
      line(`主题 ${status.topics} 篇 · 映射条目 ${status.entries} 条 · ${(status.bytes / 1024).toFixed(0)}KB`);
      for (const topic of kb.topics) line(`  ${topic.id}  ${topic.title}  [${topic.domain}]  映射 ${topic.entries.length} 条`);
      /**
       * 索引页自带的"联合检索高频组合"（五轮审计）：KB 检索总则要求"完整创作先取 NARR-001 配方，
       * 再按配方回查各篇"，而索引里那三条组合建议（虚化/电影感/人像）此前**解析了却没人输出**——
       * Agent 只能自己猜该联合哪几篇。现在原样打出来。
       */
      for (const tip of kb.index.jointSuggestions ?? []) line(`  ↳ 联合检索建议：${tip}`);
      if (status.missingTopics.length > 0) {
        line(`⚠ 索引引用了但目录里没有：${status.missingTopics.map((t) => `${t.id} ${t.title}`).join("、")}`);
      }
      return 0;
    }
    case "search": {
      const card = typeof flags.text === "string" ? { director_instruction: flags.text, mood: flags.text } : JSON.parse(fs.readFileSync(String(flags.shot), "utf8"));
      const top = Number(flags.top ?? 5);
      const selection = selectEntries(kb, card, { maxEntries: top });
      if (json) { line(JSON.stringify(selection, null, 2)); return 0; }
      line(`上下文：时段 ${selection.context.timeOfDay.join("/") || "-"} · 天气 ${selection.context.weather.join("/") || "-"} · 主体 ${selection.context.subject.join("/") || "-"}`);
      for (const pick of selection.picks) line(`  [${pick.topicId} ${pick.topicTitle}] ${pick.intent}\n     中：${pick.zh}\n     英：${pick.en}`);
      return 0;
    }
    case "aperture": {
      const card = typeof flags.shot === "string" ? JSON.parse(fs.readFileSync(String(flags.shot), "utf8")) : { director_instruction: String(flags.text ?? ""), mood: String(flags.text ?? ""), scene: String(flags.text ?? "") };
      const pick = recommendAperture(kb, card);
      if (!pick) { process.stderr.write("光圈顾问不可用（缺 OPTICS-001）\n"); return 3; }
      if (json) { line(JSON.stringify(pick, null, 2)); return 0; }
      line(`推荐光圈：${pick.aperture}（${pick.direction}景深方向）`);
      line(`  命中场景：${pick.scenarioLabel ?? "-"}（${pick.matchedBy}）· 依据：${pick.reason}`);
      line(`  写进提示词的画面语言：${pick.effectZh}`);
      line(`  英文关键词：${pick.effectEn}`);
      line(`  依据来源：${pick.source}`);
      line("  纪律：提示词正文不写 f 值（模型只认视觉描述）");
      return 0;
    }
    case "recipe": {
      const emotion = String(flags.emotion ?? "").trim();
      const topic = kb.topics.find((t) => t.id === "NARR-001");
      const hit = topic?.entries.find((e) => emotion && (e.intent.includes(emotion) || e.zh.includes(emotion)));
      if (!hit) { process.stderr.write(`NARR-001 未收录该情绪：${emotion || "(空)"}\n`); return 3; }
      line(`情绪「${hit.intent}」→ ${hit.zh}`);
      line(`配方：${hit.en}`);
      const driven = selectEntries(kb, { mood: `${hit.intent} ${hit.en}`, director_instruction: hit.en }, { maxEntries: 6 });
      line("联合检索（按配方回查各篇）：");
      for (const pick of driven.picks) line(`  [${pick.topicId}] ${pick.zh}`);
      line("提示：索引建议——普通问题查单篇；完整创作先取 NARR-001 配方再回查细节。");
      return 0;
    }
    case "enrich": {
      const shotsFile = String(flags.shots ?? "");
      if (!shotsFile) { process.stderr.write("需要 --shots <shotlist.json>\n"); return 2; }
      const doc = JSON.parse(fs.readFileSync(path.resolve(shotsFile), "utf8"));
      const shots = Array.isArray(doc) ? doc : doc?.shots;
      if (!Array.isArray(shots) || !shots.length) throw new Error("镜头文件必须包含非空 shots 数组");
      const enrichedShots = [];
      const traces = [];
      for (const shot of shots) {
        const { card, trace } = enrichShotCard(kb, shot);
        enrichedShots.push(card);
        traces.push(trace);
      }
      const out = { ...(Array.isArray(doc) ? {} : doc), shots: enrichedShots, cineKbApplied: traces.some((trace) => trace.applied.some((entry) => entry.writtenChars > 0)), cineKbStatuses: traces.map((trace) => trace.status) };
      if (typeof flags.out === "string") {
        const target = path.resolve(flags.out);
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.writeFileSync(target, `${JSON.stringify(out, null, 2)}\n`, "utf8");
        line(`已写出增强后的镜头卡：${target}`);
      }
      if (typeof flags["trace-dir"] === "string") {
        const dir = path.resolve(flags["trace-dir"]);
        fs.mkdirSync(dir, { recursive: true });
        traces.forEach((trace, index) => {
          const id = `${index + 1}-${String(enrichedShots[index]?.shotId ?? "shot").replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 80)}`;
          fs.writeFileSync(path.join(dir, `${id}.cine-kb.json`), `${JSON.stringify(trace, null, 2)}\n`, "utf8");
        });
        line(`已写出 ${traces.length} 份知识库溯源：${dir}`);
      }
      const summary = traces.map((trace, index) => ({
        shotId: enrichedShots[index].shotId ?? index + 1,
        aperture: trace.apertureAdvisor?.aperture ?? null,
        scenario: trace.apertureAdvisor?.scenarioLabel ?? null,
        /** 情绪配方派发线索（只派发不直注）：五轮审计前该线索在 trace 里被丢弃，这里一并给出 */
        recipe: trace.recipeDispatch?.intent ?? null,
        topics: trace.picks.map((p) => p.topicId),
        status: trace.status,
        fields: trace.applied.filter((a) => a.writtenChars > 0).map((a) => a.field),
        droppedFields: trace.applied.filter((a) => a.dropped).map((a) => a.field)
      }));
      if (json) line(JSON.stringify({ summary, traces }, null, 2));
      else {
        for (const item of summary) {
          line(`${item.shotId}：状态 ${item.status} · 光圈 ${item.aperture ?? "-"}（${item.scenario ?? "-"}）· 注入字段 ${item.fields.join("/")} · 命中主题 ${item.topics.join("/")}${item.recipe ? ` · 情绪配方派发 ${item.recipe}` : ""}`);
        }
      }
      return traces.some((trace) => ["failed", "unverified"].includes(trace.status)) ? 3 : 0;
    }
    default:
      process.stderr.write("用法：cine-kb-cli <health|index|search|aperture|recipe|enrich> [--flags]\n");
      return 2;
  }
}

try { process.exitCode = main(); } catch (error) {
  process.stderr.write(`摄影知识处理失败：${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 2;
}
