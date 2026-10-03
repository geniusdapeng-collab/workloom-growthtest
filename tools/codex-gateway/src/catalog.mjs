/**
 * Capability Catalog v0：从代码事实生成能力目录。
 *
 * 事实源（只读）：
 *  - bundles/<bundle>/bundle.json          （声明与显示名）
 *  - bundles/<bundle>/presets/*.yml        （数字员工 + 工具 + 围栏绑定 + 风险）
 *  - bundles 下各技能目录的 SKILL.md        （技能）
 *  - bundles/<bundle>/fences/*.yml         （围栏规则）
 *  - bundles/<bundle>/pipelines/*.yml      （Quest 管线 + 闸门）
 *
 * 纪律：
 *  - 不手写第二份能力清单；目录只能由 generator 生成；
 *  - 解析失败必须进 warnings，不允许静默省略；
 *  - 输出只含仓内相对路径，避免把本机绝对路径写入交付物。
 */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { repoRelative, resolveRepoRoot } from "./paths.mjs";
import { parseFence, parsePipeline, parsePreset, parseSkillFrontmatter } from "./shallow-yaml.mjs";

function readJson(path, warnings, label) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    warnings.push(`${label} 读取失败：${error instanceof Error ? error.message : String(error)}`);
    return null;
  }
}

function listDirs(path) {
  try {
    return readdirSync(path, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))
      .map((entry) => entry.name)
      .sort();
  } catch {
    return [];
  }
}

function listFiles(path, suffix) {
  try {
    return readdirSync(path, { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.endsWith(suffix))
      .map((entry) => entry.name)
      .sort();
  } catch {
    return [];
  }
}

export function generateCatalog({ repoRoot = resolveRepoRoot(), generatedAt = new Date().toISOString() } = {}) {
  const warnings = [];
  const bundlesRoot = join(repoRoot, "bundles");
  const bundleNames = listDirs(bundlesRoot);
  const employees = new Map();
  const skills = new Map();
  const pipelines = new Map();
  const fences = new Map();
  const bundleSummaries = [];
  const unparsed = [];

  for (const bundleName of bundleNames) {
    const bundleDir = join(bundlesRoot, bundleName);
    const bundleJsonPath = join(bundleDir, "bundle.json");
    const bundle = readJson(bundleJsonPath, warnings, `bundles/${bundleName}/bundle.json`);
    if (!bundle) continue;

    const industry = bundle?.workloom?.industry ?? bundleName;
    const displayName = bundle?.workloom?.displayName ?? bundleName;
    const declaredPresets = new Set(bundle?.workloom?.provides?.presets ?? []);
    const declaredSkills = new Set(bundle?.workloom?.provides?.skills ?? []);
    const declaredFences = new Set(bundle?.workloom?.provides?.fences ?? []);
    const declaredPipelines = new Set(bundle?.workloom?.provides?.pipelines ?? []);
    const bundleFacts = { bundle: bundleName, industry, displayName, status: bundle?.workloom?.status ?? "unknown", example: Boolean(bundle?.workloom?.example), employees: 0, skills: 0, pipelines: 0, fences: 0 };

    for (const file of listFiles(join(bundleDir, "presets"), ".yml")) {
      const rel = `bundles/${bundleName}/presets/${file}`;
      const preset = parsePreset(readFileSync(join(bundleDir, "presets", file), "utf8"));
      const key = preset.presetKey || file.replace(/\.yml$/, "");
      if (!key) {
        unparsed.push(rel);
        continue;
      }
      if (preset.warnings.length) warnings.push(`${rel}: ${preset.warnings.join("；")}`);
      const hasWrite = preset.tools.some((tool) => tool.access === "write");
      const riskLevel = preset.highRisk ? "high" : preset.fenceBindings.length > 0 || hasWrite ? "review" : "auto";
      const existing = employees.get(key) ?? {
        id: `employee:${key}`,
        kind: "employee",
        presetKey: key,
        displayName: preset.name || key,
        summary: preset.description,
        roleKind: preset.kind,
        domains: [],
        bundles: [],
        sources: [],
        declared: true,
        nightShift: preset.nightShift,
        highRisk: preset.highRisk,
        readonly: preset.readonly,
        fenceBindings: [],
        skills: [],
        tools: [],
        risk: { level: riskLevel, source: preset.highRisk ? "high_risk" : preset.fenceBindings.length ? "fence_bindings" : hasWrite ? "write_tools" : "read_only" },
      };
      existing.domains = [...new Set([...existing.domains, industry])];
      existing.bundles = [...new Set([...existing.bundles, bundleName])];
      existing.sources = [...new Set([...existing.sources, rel])];
      // 同名岗位跨 bundle 合并时取更严口径：高风险/夜班取或，围栏取并集。
      existing.highRisk = existing.highRisk || preset.highRisk;
      existing.nightShift = existing.nightShift || preset.nightShift;
      existing.fenceBindings = [...new Set([...existing.fenceBindings, ...preset.fenceBindings])];
      existing.skills = [...new Set([...existing.skills, ...preset.skills])];
      const toolKeys = new Set(existing.tools.map((tool) => tool.name));
      for (const tool of preset.tools) if (!toolKeys.has(tool.name)) existing.tools.push(tool);
      if (!declaredPresets.has(`presets/${file}`)) existing.declared = false;
      if (riskOrder(riskLevel) > riskOrder(existing.risk.level)) existing.risk = { level: riskLevel, source: "merged" };
      employees.set(key, existing);
      bundleFacts.employees += 1;
    }

    for (const dir of listDirs(join(bundleDir, "skills"))) {
      const rel = `bundles/${bundleName}/skills/${dir}/SKILL.md`;
      const absolute = join(bundleDir, "skills", dir, "SKILL.md");
      if (!existsSync(absolute)) {
        unparsed.push(rel);
        continue;
      }
      const front = parseSkillFrontmatter(readFileSync(absolute, "utf8"));
      const key = front.name || dir;
      const existing = skills.get(key) ?? {
        id: `skill:${key}`,
        kind: "skill",
        skillKey: key,
        displayName: key,
        summary: front.description,
        domains: [],
        bundles: [],
        sources: [],
        declared: true,
        risk: { level: "review", source: "skill_invocation" },
      };
      existing.domains = [...new Set([...existing.domains, industry])];
      existing.bundles = [...new Set([...existing.bundles, bundleName])];
      existing.sources = [...new Set([...existing.sources, rel])];
      if (!declaredSkills.has(`skills/${dir}/SKILL.md`)) existing.declared = false;
      skills.set(key, existing);
      bundleFacts.skills += 1;
    }

    for (const file of listFiles(join(bundleDir, "pipelines"), ".yml")) {
      const rel = `bundles/${bundleName}/pipelines/${file}`;
      const pipeline = parsePipeline(readFileSync(join(bundleDir, "pipelines", file), "utf8"));
      const key = pipeline.quest || file.replace(/\.yml$/, "");
      const gates = [...new Set(pipeline.steps.map((step) => step.gate).filter(Boolean))];
      const existing = pipelines.get(key) ?? {
        id: `pipeline:${key}`,
        kind: "pipeline",
        pipelineKey: key,
        displayName: pipeline.name || key,
        summary: pipeline.description,
        schedule: pipeline.schedule,
        domains: [],
        bundles: [],
        sources: [],
        declared: true,
        steps: pipeline.steps,
        gates,
        risk: { level: gates.length ? "review" : "auto", source: gates.length ? "gates" : "no_gate" },
      };
      existing.domains = [...new Set([...existing.domains, industry])];
      existing.bundles = [...new Set([...existing.bundles, bundleName])];
      existing.sources = [...new Set([...existing.sources, rel])];
      existing.gates = [...new Set([...existing.gates, ...gates])];
      if (!declaredPipelines.has(`pipelines/${file}`)) existing.declared = false;
      pipelines.set(key, existing);
      bundleFacts.pipelines += 1;
    }

    for (const file of listFiles(join(bundleDir, "fences"), ".yml")) {
      const rel = `bundles/${bundleName}/fences/${file}`;
      const fence = parseFence(readFileSync(join(bundleDir, "fences", file), "utf8"));
      if (fence.warnings.length) warnings.push(`${rel}: ${fence.warnings.join("；")}`);
      for (const rule of fence.rules) {
        const key = rule.ruleId;
        const existing = fences.get(key) ?? {
          id: `fence:${key}`,
          kind: "fence",
          ruleId: key,
          displayName: rule.name || key,
          summary: rule.note,
          level: rule.level,
          baseline: rule.baseline,
          actions: rule.actions,
          domains: [],
          bundles: [],
          sources: [],
          declared: true,
          risk: { level: rule.level === "block" ? "high" : rule.level === "review" ? "review" : "auto", source: "fence_level" },
        };
        existing.domains = [...new Set([...existing.domains, industry])];
        existing.bundles = [...new Set([...existing.bundles, bundleName])];
        existing.sources = [...new Set([...existing.sources, rel])];
        if (!declaredFences.has(`fences/${file}`)) existing.declared = false;
        fences.set(key, existing);
        bundleFacts.fences += 1;
      }
    }

    bundleSummaries.push(bundleFacts);
  }

  const capabilities = [...employees.values(), ...skills.values(), ...pipelines.values(), ...fences.values()]
    .map((capability) => ({
      ...capability,
      sources: capability.sources.map((source) => (source.startsWith("/") ? repoRelative(repoRoot, source) : source)),
    }))
    .sort((a, b) => (a.kind === b.kind ? a.id.localeCompare(b.id) : a.kind.localeCompare(b.kind)));

  const product = readJson(join(repoRoot, "product.manifest.json"), warnings, "product.manifest.json");
  const summary = {
    bundles: bundleSummaries.length,
    employees: employees.size,
    skills: skills.size,
    pipelines: pipelines.size,
    fences: fences.size,
    gates: new Set(capabilities.filter((c) => c.kind === "pipeline").flatMap((c) => c.gates)).size,
    highRisk: capabilities.filter((c) => c.risk?.level === "high").length,
    nightShift: capabilities.filter((c) => c.kind === "employee" && c.nightShift).length,
    declared: capabilities.filter((c) => c.declared).length,
    undeclared: capabilities.filter((c) => !c.declared).length,
  };

  return {
    schemaVersion: "workloom.capability/v1",
    generatedAt,
    generator: "tools/codex-gateway/src/catalog.mjs",
    repo: {
      name: product?.packageName ?? product?.productId ?? "workloom",
      productId: product?.productId ?? "",
      displayName: product?.displayName ?? "",
      defaultBundle: product?.defaultBundle ?? "",
      isolatedCopy: true,
    },
    dataMode: "generated",
    note: "能力目录由仓内 bundle/preset/skill/fence/pipeline 文件生成；运行态数据不在本文件中。",
    summary,
    bundles: bundleSummaries,
    capabilities,
    warnings,
    unparsed,
  };
}

function riskOrder(level) {
  return { auto: 0, review: 1, high: 2, block: 3 }[level] ?? 0;
}

export function findCapability(catalog, idOrKey) {
  const needle = String(idOrKey ?? "").trim().toLowerCase();
  if (!needle) return null;
  const exact = catalog.capabilities.find((capability) => capability.id.toLowerCase() === needle);
  if (exact) return exact;
  const suffix = catalog.capabilities.find((capability) => {
    const key = capability.presetKey ?? capability.skillKey ?? capability.pipelineKey ?? capability.ruleId ?? "";
    return key.toLowerCase() === needle || capability.id.toLowerCase().endsWith(`:${needle}`);
  });
  if (suffix) return suffix;
  return catalog.capabilities.find((capability) => (capability.displayName ?? "").toLowerCase().includes(needle)) ?? null;
}

export function searchCapabilities(catalog, { query = "", domain = "", kind = "", limit = 20 } = {}) {
  const q = String(query).trim().toLowerCase();
  const d = String(domain).trim().toLowerCase();
  const k = String(kind).trim().toLowerCase();
  const max = Math.max(1, Math.min(Number(limit) || 20, 100));
  return catalog.capabilities
    .filter((capability) => {
      if (k && capability.kind !== k) return false;
      if (d && !(capability.domains ?? []).some((item) => item.toLowerCase().includes(d)) && !(capability.bundles ?? []).some((item) => item.toLowerCase().includes(d))) return false;
      if (!q) return true;
      const haystack = [
        capability.id,
        capability.displayName,
        capability.summary,
        ...(capability.domains ?? []),
        ...(capability.bundles ?? []),
        ...(capability.tools ?? []).map((tool) => `${tool.name} ${tool.desc}`),
        ...(capability.gates ?? []),
        ...(capability.fenceBindings ?? []),
      ]
        .join(" ")
        .toLowerCase();
      return haystack.includes(q);
    })
    .slice(0, max);
}
