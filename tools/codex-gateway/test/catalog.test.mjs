import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { resolveRepoRoot } from "../src/paths.mjs";
import { findCapability, generateCatalog, searchCapabilities } from "../src/catalog.mjs";

const repoRoot = resolveRepoRoot();
const catalog = generateCatalog({ repoRoot, generatedAt: "2026-09-22T00:00:00.000Z" });

test("能力目录覆盖全部 bundle 且计数大于零", () => {
  assert.ok(catalog.summary.bundles >= 3, `bundles=${catalog.summary.bundles}`);
  assert.ok(catalog.summary.employees >= 27, `employees=${catalog.summary.employees}`);
  assert.ok(catalog.summary.skills > 0, `skills=${catalog.summary.skills}`);
  assert.ok(catalog.summary.pipelines >= 4, `pipelines=${catalog.summary.pipelines}`);
  assert.ok(catalog.summary.fences > 0, `fences=${catalog.summary.fences}`);
  assert.equal(catalog.dataMode, "generated");
});

test("数字员工解析出工具、围栏与风险等级", () => {
  const ads = findCapability(catalog, "employee:ads-optimizer");
  assert.ok(ads, "missing ads-optimizer");
  // 同名岗位跨 bundle 合并时取更严口径：ai-video 的 ads-optimizer 标注 high_risk=true（烧投流预算）。
  assert.equal(ads.highRisk, true);
  assert.deepEqual(ads.fenceBindings, ["G12"]);
  assert.ok(ads.tools.length >= 3, `tools=${ads.tools.length}`);
  assert.equal(ads.tools.find((tool) => tool.name === "ads.watch")?.access, "read");
  assert.equal(ads.risk.level, "high");
  assert.ok(ads.bundles.includes("ai-video") && ads.bundles.includes("geo-growth"));

  const ceo = findCapability(catalog, "employee:company-ceo");
  assert.ok(ceo, "missing company-ceo");
  assert.ok(ceo.fenceBindings.includes("G17"));
  assert.equal(ceo.nightShift, true);
});

test("管线解析出步骤与闸门", () => {
  const pipeline = findCapability(catalog, "pipeline:dual-content-factory");
  assert.ok(pipeline, "missing dual-content-factory");
  assert.ok(pipeline.steps.length >= 8, `steps=${pipeline.steps.length}`);
  assert.ok(pipeline.gates.includes("G9"));
  assert.ok(pipeline.gates.includes("G-GEO1"));
  assert.ok(pipeline.gates.includes("G-GEO2"));
  assert.equal(pipeline.risk.level, "review");
});

test("围栏规则解析出等级与基线标记", () => {
  const g9 = findCapability(catalog, "fence:G9");
  assert.ok(g9, "missing fence G9");
  assert.equal(g9.level, "review");
  assert.equal(g9.baseline, true);
  assert.ok(g9.actions.includes("publish.execute"));
});

test("目录不泄露本机绝对路径", () => {
  for (const capability of catalog.capabilities) {
    for (const source of capability.sources ?? []) {
      assert.ok(!source.startsWith("/"), `absolute source leaked: ${source}`);
    }
  }
});

test("搜索与模糊匹配可用", () => {
  const results = searchCapabilities(catalog, { query: "GEO" });
  assert.ok(results.length > 0, "search GEO returned nothing");
  const bySuffix = findCapability(catalog, "ads-optimizer");
  assert.equal(bySuffix?.id, "employee:ads-optimizer");
});

test("目录计数与仓内文件的独立正则扫描一致（防止解析漂移）", () => {
  const bundlesRoot = join(repoRoot, "bundles");
  const presetKeys = new Set();
  const fenceIds = new Set();
  for (const bundle of readdirSync(bundlesRoot, { withFileTypes: true }).filter((entry) => entry.isDirectory())) {
    const presetDir = join(bundlesRoot, bundle.name, "presets");
    for (const file of safeReaddir(presetDir)) {
      const text = readFileSync(join(presetDir, file), "utf8");
      const match = text.match(/^\s*preset_key\s*:\s*([A-Za-z0-9_.-]+)/m);
      presetKeys.add(match?.[1] ?? file.replace(/\.yml$/, ""));
    }
    const fenceDir = join(bundlesRoot, bundle.name, "fences");
    for (const file of safeReaddir(fenceDir)) {
      const text = readFileSync(join(fenceDir, file), "utf8");
      for (const line of text.split(/\r?\n/)) {
        const match = line.match(/^\s+-\s*(?:rule_id|id)\s*:\s*([A-Za-z0-9_.-]+)/);
        if (match) fenceIds.add(match[1]);
      }
    }
  }
  assert.equal(catalog.summary.employees, presetKeys.size, "employee count drift");
  assert.equal(catalog.summary.fences, fenceIds.size, "fence count drift");
});

function safeReaddir(path) {
  try {
    return readdirSync(path).filter((file) => file.endsWith(".yml"));
  } catch {
    return [];
  }
}
