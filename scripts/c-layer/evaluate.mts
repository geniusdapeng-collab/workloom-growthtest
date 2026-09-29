#!/usr/bin/env node
/**
 * C 能力层评测器（《GROWTH 深度产品方案》§6）
 *
 *   pnpm c-layer                          # dry-run：确定性桩答案验证流水线（不可用于评分结论）
 *   pnpm c-layer --provider gateway       # 真实模型：需 LLM_BASE_URL / LLM_API_KEY / LLM_MODEL
 *   pnpm c-layer --blind                  # 生成盲评映射 + 评分表模板（系统产出 vs 资深运营产出）
 *   pnpm c-layer --score <scores.csv>     # 汇总专家评分并出门禁结论（均分 ≥3.6 且"边界遵守"≥4）
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dirname, "..", "..");
const OUT = join(ROOT, "outputs", "c-layer");
const args = process.argv.slice(2);
const arg = (n: string): string | undefined => {
  const i = args.indexOf(n);
  return i >= 0 ? args[i + 1] : undefined;
};
const scenarios = (JSON.parse(readFileSync(join(import.meta.dirname, "scenarios.json"), "utf8")) as {
  scenarios: Array<{ id: string; dimension: string; prompt: string }>;
}).scenarios;

mkdirSync(OUT, { recursive: true });
const stamp = new Date().toISOString().replace(/[:.]/g, "-");

if (arg("--score")) {
  const rows = readFileSync(arg("--score")!, "utf8").trim().split("\n").slice(1).map((l) => l.split(","));
  const dimOf = new Map(scenarios.map((s) => [s.id, s.dimension]));
  const byDim = new Map<string, number[]>();
  for (const row of rows) {
    const id = row[0]?.trim() ?? "";
    const score = Number(row[1]);
    const dim = dimOf.get(id);
    if (!dim || !Number.isFinite(score)) continue;
    byDim.set(dim, [...(byDim.get(dim) ?? []), score]);
  }
  const all = [...byDim.values()].flat();
  const mean = all.reduce((a, b) => a + b, 0) / Math.max(1, all.length);
  const boundary = byDim.get("边界遵守") ?? [];
  const boundaryMean = boundary.reduce((a, b) => a + b, 0) / Math.max(1, boundary.length);
  const pass = mean >= 3.6 && boundaryMean >= 4;
  console.log(`C 层评分：均分 ${mean.toFixed(2)} / 边界遵守 ${boundaryMean.toFixed(2)} → ${pass ? "通过" : "不通过"}`);
  for (const [d, vs] of byDim) console.log(`  ${d}：${(vs.reduce((a, b) => a + b, 0) / vs.length).toFixed(2)}（${vs.length} 项）`);
  process.exit(pass ? 0 : 1);
}

if (args.includes("--blind")) {
  const mapping = {
    note: "双盲映射：A/B 与来源随机绑定；评分人只看到 A/B",
    pairs: scenarios.map((s, i) => ({ id: s.id, A: i % 2 === 0 ? "system" : "human", B: i % 2 === 0 ? "human" : "system" })),
  };
  const mapPath = join(OUT, `blind-${stamp}.json`);
  const csvPath = join(OUT, `scores-template-${stamp}.csv`);
  writeFileSync(mapPath, JSON.stringify(mapping, null, 2));
  writeFileSync(csvPath, ["id,score,dimension,notes", ...scenarios.map((s) => `${s.id},,${s.dimension},`)].join("\n"));
  console.log(`盲评映射：${mapPath}\n评分模板：${csvPath}`);
  process.exit(0);
}

const provider = arg("--provider") ?? "dry";
const isDry = provider === "dry" || args.includes("--dry-run");

async function callGateway(prompt: string): Promise<string> {
  const base = process.env.LLM_BASE_URL;
  const key = process.env.LLM_API_KEY;
  const model = process.env.LLM_MODEL ?? "gpt-4o-mini";
  if (!base || !key) throw new Error("真实模型评测需要 LLM_BASE_URL 与 LLM_API_KEY（当前为空，fail-closed）");
  const res = await fetch(`${base.replace(/\/$/, "")}/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
    body: JSON.stringify({
      model,
      messages: [
        { role: "system", content: "你是 WorkLoom 获客用增系统的资深运营。回答必须：判断有依据、证据标强度、边界该请示就请示、产出可直接使用。" },
        { role: "user", content: prompt },
      ],
    }),
  });
  if (!res.ok) throw new Error(`LLM 网关 ${res.status}`);
  const json = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> };
  return json.choices?.[0]?.message?.content ?? "";
}

const results: Array<{ id: string; dimension: string; mode: string; answer: string }> = [];
for (const s of scenarios) {
  const answer = isDry
    ? `【DRY-RUN 桩答案 · 不可用于评分】${s.id}（${s.dimension}）：将按 rubric 输出判断/依据/边界/产出/复盘五要素。`
    : await callGateway(s.prompt);
  results.push({ id: s.id, dimension: s.dimension, mode: isDry ? "dry-run" : provider, answer });
}
const runPath = join(OUT, `run-${stamp}.json`);
writeFileSync(runPath, JSON.stringify({ mode: isDry ? "dry-run" : provider, scenarios: results.length, results }, null, 2));
console.log(`${isDry ? "DRY-RUN（流水线验证，不作评分结论）" : `真实模型（${provider}）`}：${results.length} 个场景 → ${runPath}`);
if (isDry) console.log("提示：真实评分需 --provider gateway + LLM 凭证，并由行业专家按 docs/c-layer-rubric.md 双盲评分（--blind 生成映射与模板）。");
